"""휴지통 — 지운 generation 을 **별도 DB**(content_hub_trash.db)로 옮겨 보관.

설계(사용자 합의, 2026-06-16):
  · 물리 삭제하지 않는다. 삭제 = 메인 DB 에서 빼고 휴지통 DB 로 즉시 이동(원자적).
  · 휴지통 DB 는 메인과 분리된 파일 → 메인의 인덱스·쿼리·규모에 전혀 영향 없음.
  · 자기완결 저장: generation 행 + 모든 자식(asset·reference·태그·자동태그·히스토리·코멘트·공유)을
    **JSON 페이로드 1건 + 검색용 컬럼**으로 보관. 메인 스키마가 바뀌어도 휴지통이 안 깨진다.
  · 검색·복원·영구삭제는 휴지통 창에서. 복원 = 페이로드를 메인 DB 에 그대로 재생성.

원자성: ATTACH 로 메인+휴지통을 한 커넥션에 묶고 한 트랜잭션에서 이동/복원 → 중간 크래시에도
  '양쪽에 다 있음/양쪽에 다 없음'이 생기지 않는다.

미디어 파일(/media/<sha>)은 건드리지 않는다 — 내용주소·중복공유라 지우면 위험하고,
  그대로 두면 복원 즉시 다시 보인다(Phase 1 ③ 미디어 샤딩이 미디어 용량을 따로 관리).
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from ..db import DB_BACKEND, get_connection, get_db_path
from . import tags
from .generations import _delete_generation

# 휴지통은 SQLite 에선 별도 DB 파일을 ATTACH, PostgreSQL 에선 trash 스키마.
# 어느 쪽이든 SQL 의 `trash.trashed` 참조는 동일하게 동작(부착DB명 ≈ 스키마명).
_IS_PG = DB_BACKEND == "postgres"

_TRASHED_DDL = (
    "CREATE TABLE IF NOT EXISTS trash.trashed("
    "id TEXT PRIMARY KEY, trashed_at TEXT NOT NULL, project_id TEXT, "
    "creator_uid TEXT, status TEXT, prompt TEXT, source_name TEXT, payload TEXT NOT NULL)"
)


def _trash_path() -> Path:
    """휴지통 DB 파일(SQLite) — 메인 DB 와 같은 폴더의 content_hub_trash.db."""
    return get_db_path().parent / "content_hub_trash.db"


def _ensure_trash_schema(conn) -> None:
    """trash.trashed 보장(IF NOT EXISTS, 멱등). 검색용 컬럼 + JSON 페이로드."""
    if _IS_PG:
        conn.execute("CREATE SCHEMA IF NOT EXISTS trash")
        conn.execute(_TRASHED_DDL)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_trashed_at ON trash.trashed(trashed_at DESC, id DESC)"
        )
    else:
        conn.execute(_TRASHED_DDL)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS trash.idx_trashed_at ON trashed(trashed_at DESC, id DESC)"
        )


@contextmanager
def _with_trash() -> Iterator[Any]:
    """trash.trashed 를 쓸 수 있는 커넥션 컨텍스트(스키마 보장).

    본문에서 BEGIN/COMMIT 으로 원자 이동/복원을 제어한다. 예외 시 ROLLBACK.
    SQLite: 별도 DB 파일을 ATTACH(끝에 DETACH). PostgreSQL: 같은 DB 의 trash 스키마.
    """
    with get_connection() as conn:
        if not _IS_PG:
            conn.execute("ATTACH DATABASE ? AS trash", (str(_trash_path()),))
        _ensure_trash_schema(conn)
        try:
            yield conn
        finally:
            if conn.in_transaction:  # 본문이 COMMIT 안 했으면(예외) 되돌림
                conn.execute("ROLLBACK")
            if not _IS_PG:
                conn.execute("DETACH DATABASE trash")


def _row(r: sqlite3.Row) -> dict[str, Any]:
    return {k: r[k] for k in r.keys()}


# ── 이동(삭제) ───────────────────────────────────────────────────────────
def _gather(conn: sqlite3.Connection, gen_id: str, gen: sqlite3.Row) -> dict[str, Any]:
    """generation + 모든 자식 행을 복원 가능한 페이로드로 수집(태그·자동태그는 이름으로)."""
    gen_refs = [_row(r) for r in conn.execute(
        "SELECT * FROM gen_reference WHERE generation_id=?", (gen_id,)
    ).fetchall()]
    ref_ids = [gr["reference_id"] for gr in gen_refs]
    refs: list[dict[str, Any]] = []
    if ref_ids:
        ph = ",".join("?" * len(ref_ids))
        refs = [_row(r) for r in conn.execute(
            f"SELECT * FROM reference WHERE id IN ({ph})", ref_ids
        ).fetchall()]
    return {
        "generation": _row(gen),
        "assets": [_row(r) for r in conn.execute(
            "SELECT * FROM asset WHERE generation_id=?", (gen_id,)).fetchall()],
        "gen_references": gen_refs,
        "references": refs,
        "tags": [r["name"] for r in conn.execute(
            "SELECT t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=?", (gen_id,)).fetchall()],
        "auto_tags": [r["name"] for r in conn.execute(
            "SELECT a.name FROM gen_auto_tag gat JOIN auto_tag a ON a.id=gat.auto_tag_id "
            "WHERE gat.generation_id=?", (gen_id,)).fetchall()],
        "history": [_row(r) for r in conn.execute(
            "SELECT * FROM history WHERE parent_gen_id=? OR child_gen_id=?",
            (gen_id, gen_id)).fetchall()],
        "comments": [_row(r) for r in conn.execute(
            "SELECT * FROM generation_comment WHERE gen_id=?", (gen_id,)).fetchall()],
        "comment_reads": [_row(r) for r in conn.execute(
            "SELECT * FROM generation_comment_read WHERE gen_id=?", (gen_id,)).fetchall()],
        "shares": [_row(r) for r in conn.execute(
            "SELECT * FROM share WHERE generation_id=?", (gen_id,)).fetchall()],
    }


def move_to_trash(gen_id: str) -> bool:
    """generation 1건을 휴지통 DB 로 원자 이동(메인에서 제거). 없으면 False."""
    with _with_trash() as conn:
        gen = conn.execute("SELECT * FROM generation WHERE id=?", (gen_id,)).fetchone()
        if not gen:
            return False
        payload = _gather(conn, gen_id, gen)
        conn.execute("BEGIN")
        conn.execute(
            "INSERT OR REPLACE INTO trash.trashed"
            "(id, trashed_at, project_id, creator_uid, status, prompt, source_name, payload) "
            "VALUES(?, datetime('now'), ?, ?, ?, ?, ?, ?)",
            (
                gen_id,
                gen["project_id"],
                gen["creator_uid"],
                gen["status"],
                gen["prompt"],
                gen["source_name"],
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        _delete_generation(conn, gen_id)  # 메인에서 본체+자식 제거
        conn.execute("COMMIT")
        return True


# ── 복원 ─────────────────────────────────────────────────────────────────
def _insert_row(
    conn: sqlite3.Connection, table: str, d: dict[str, Any], *, or_ignore: bool = False
) -> None:
    cols = list(d.keys())
    ph = ",".join("?" * len(cols))
    verb = "INSERT OR IGNORE" if or_ignore else "INSERT OR REPLACE"
    conn.execute(
        f"{verb} INTO {table}({','.join(cols)}) VALUES({ph})", [d[c] for c in cols]
    )


def restore_from_trash(gen_id: str, account_uid: Optional[str] = None) -> bool:
    """휴지통 항목을 메인 DB 에 그대로 재생성 + 휴지통에서 제거(원자). 없으면 False.
    account_uid 가 주어지면(AUTH on) 본인 것만 복구 — 남의 삭제물 복구·재노출 차단."""
    with _with_trash() as conn:
        row = conn.execute(
            "SELECT payload, creator_uid FROM trash.trashed WHERE id=?", (gen_id,)
        ).fetchone()
        if not row:
            return False
        # 일반 계정(account_uid 지정)은 '정확히 본인 것'만. 소유자 NULL 인 레거시(단독 시절) 항목은
        # 일반 계정이 복구 못 하게 막는다 — admin 은 호출부에서 account_uid=None 으로 들어와 전부 통과,
        # 단독 모드(AUTH off)도 account_uid=None 이라 통과하므로 레거시가 잠기지 않는다.
        if account_uid is not None and row["creator_uid"] != account_uid:
            raise PermissionError("본인 휴지통 항목만 복구할 수 있습니다")
        p = json.loads(row["payload"])
        conn.execute("BEGIN")
        _insert_row(conn, "generation", p["generation"])
        for a in p.get("assets", []):
            _insert_row(conn, "asset", a)
        for r in p.get("references", []):  # 공유 가능 → 이미 있으면 무시
            _insert_row(conn, "reference", r, or_ignore=True)
        for gr in p.get("gen_references", []):
            _insert_row(conn, "gen_reference", gr, or_ignore=True)
        # 태그·자동태그는 이름으로 재연결(전역 tag/auto_tag 가 그새 바뀌어도 안전)
        tags._set_tags(conn, gen_id, p.get("tags", []))
        tags._set_auto_tags(conn, gen_id, p.get("auto_tags", []))
        # 옛 휴지통 payload 는 "lineage" 키였다 → 둘 다 읽어 하위호환(테이블은 history 로 통일).
        for l in p.get("history") or p.get("lineage") or []:
            _insert_row(conn, "history", l, or_ignore=True)
        for c in p.get("comments", []):
            _insert_row(conn, "generation_comment", c, or_ignore=True)
        for rd in p.get("comment_reads", []):
            _insert_row(conn, "generation_comment_read", rd, or_ignore=True)
        for s in p.get("shares", []):
            _insert_row(conn, "share", s, or_ignore=True)
        conn.execute("DELETE FROM trash.trashed WHERE id=?", (gen_id,))
        conn.execute("COMMIT")
        return True


# ── 목록 / 검색 / 영구삭제 ────────────────────────────────────────────────
def _parent_of(payload: dict[str, Any], gen_id: str) -> Optional[str]:
    # 옛 payload 는 "lineage" 키 → 둘 다 읽어 하위호환.
    for l in payload.get("history") or payload.get("lineage") or []:
        if l.get("child_gen_id") == gen_id:
            return l.get("parent_gen_id")
    return None


def _to_generation_out(payload: dict[str, Any]) -> dict[str, Any]:
    """페이로드를 그리드가 그대로 그릴 수 있는 Generation 모양으로 복원(deleted=True)."""
    g = payload["generation"]
    refs_by_id = {r["id"]: r for r in payload.get("references", [])}

    def _cached(fp: Optional[str]) -> bool:
        return bool(fp and str(fp).startswith("/media/"))

    def asset_out(a: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": a["id"], "generation_id": a["generation_id"], "type": a["type"],
            "file_path": a.get("file_path", ""), "thumbnail_path": a.get("thumbnail_path"),
            "source_url": a.get("source_url"), "cached": _cached(a.get("file_path")),
        }

    def ref_out(gr: dict[str, Any]) -> dict[str, Any]:
        r = refs_by_id.get(gr.get("reference_id"), {})
        return {
            "id": gr.get("reference_id"), "type": r.get("type"),
            "file_path": r.get("file_path", ""), "thumbnail_path": r.get("thumbnail_path"),
            "source": r.get("source"), "role": gr.get("role"),
            "source_url": r.get("source_url"), "cached": _cached(r.get("file_path")),
        }

    return {
        "id": g["id"], "worker_id": g.get("worker_id", "me"), "worker_name": None,
        "prompt": g.get("prompt", ""), "display_prompt": g.get("display_prompt"),
        "model": g.get("model"),
        "params": json.loads(g["params"]) if g.get("params") else None,
        "color": g.get("color"), "status": g.get("status", "done"),
        "created_at": g.get("created_at", ""), "sort_ts": g.get("sort_ts"),
        "assets": [asset_out(a) for a in payload.get("assets", [])],
        "references": [ref_out(gr) for gr in payload.get("gen_references", [])],
        "tags": payload.get("tags", []), "auto_tags": payload.get("auto_tags", []),
        "shared": bool(payload.get("shares")), "parent_gen_id": _parent_of(payload, g["id"]),
        "is_source": bool(g.get("is_source")), "source_name": g.get("source_name"),
        "comment": g.get("comment"), "error": g.get("error"),
        "comment_count": len(payload.get("comments", [])), "has_unread": False,
        "local_only": bool((not g.get("job_id")) or g.get("hf_missing")),
        "creator_uid": g.get("creator_uid"), "creator_name": None, "is_mine": True,
        "project_id": g.get("project_id"), "deleted": True,
    }


def list_trash(
    search: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
    account_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """휴지통 항목 목록(prompt·source_name 부분일치 검색). 최근 삭제순.
    account_uid 가 있으면 그 계정 것만(내 휴지통) — 다른 사람의 삭제물 열람 방지."""
    with _with_trash() as conn:
        where, args = [], []
        if account_uid:
            where.append("creator_uid = ?")
            args.append(account_uid)
        if search:
            where.append("(prompt LIKE ? OR source_name LIKE ?)")
            args += [f"%{search}%", f"%{search}%"]
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            f"SELECT payload FROM trash.trashed{clause} "
            f"ORDER BY trashed_at DESC, id DESC LIMIT ? OFFSET ?",
            args + [limit, offset],
        ).fetchall()
        return [_to_generation_out(json.loads(r["payload"])) for r in rows]


def purge_trashed_item(gen_id: str, account_uid: Optional[str] = None) -> bool:
    """휴지통에서 영구 삭제(복원 불가). account_uid 가 있으면 본인 것만 — 남의 삭제물 영구삭제 방지.
    미디어 파일은 공유·내용주소라 건드리지 않음."""
    with _with_trash() as conn:
        if account_uid:
            return (
                conn.execute(
                    "DELETE FROM trash.trashed WHERE id=? AND creator_uid=?",
                    (gen_id, account_uid),
                ).rowcount
                > 0
            )
        return conn.execute(
            "DELETE FROM trash.trashed WHERE id=?", (gen_id,)
        ).rowcount > 0
