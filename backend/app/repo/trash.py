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
import logging
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
    "creator_uid TEXT, status TEXT, prompt TEXT, source_name TEXT, job_id TEXT, payload TEXT NOT NULL)"
)


def _trash_path() -> Path:
    """휴지통 DB 파일(SQLite) — 메인 DB 와 같은 폴더의 content_hub_trash.db."""
    return get_db_path().parent / "content_hub_trash.db"


def _ensure_trash_schema(conn) -> None:
    """trash.trashed 보장(IF NOT EXISTS, 멱등). 검색용 컬럼 + JSON 페이로드."""
    if _IS_PG:
        conn.execute("CREATE SCHEMA IF NOT EXISTS trash")
        conn.execute(_TRASHED_DDL)
        _ensure_trash_job_id_col(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_trashed_at ON trash.trashed(trashed_at DESC, id DESC)"
        )
        # job_id 인덱스 — tombstoned_among 의 IN 조회와 백필 가드의 IS NULL 스캔을 전체스캔 없이(휴지통 커도 빠르게).
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trashed_job ON trash.trashed(job_id)")
    else:
        conn.execute(_TRASHED_DDL)
        _ensure_trash_job_id_col(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS trash.idx_trashed_at ON trashed(trashed_at DESC, id DESC)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS trash.idx_trashed_job ON trashed(job_id)")


def _ensure_trash_job_id_col(conn) -> None:
    """구버전 휴지통 DB 에 job_id 컬럼 보강 + payload 에서 1회 백필(멱등).
    job_id 는 동기화(apply_synced_jobs)가 '삭제된 잡'을 되살리지 않도록 거르는 키다 — 없으면
    지운 생성물이 CLI 100-window 에 남아 있는 한 다음 동기화에 그대로 재등장한다."""
    if _IS_PG:  # 신규 PG 는 DDL 로 이미 보유. 레거시 PG 만 add(중복이면 무시).
        try:
            conn.execute("ALTER TABLE trash.trashed ADD COLUMN job_id TEXT")
        except Exception:  # noqa: BLE001 — 이미 존재(정상)
            pass
        return
    cols = {r[1] for r in conn.execute("PRAGMA trash.table_info(trashed)")}
    if "job_id" not in cols:
        conn.execute("ALTER TABLE trash.trashed ADD COLUMN job_id TEXT")
    # 백필: 'payload 에서 job_id 를 뽑을 수 있는데 컬럼은 NULL' 인 행이 있을 때만 UPDATE(값싼 read 선확인).
    # ★조건에 json_extract IS NOT NULL 을 넣는 이유 — local-only 삭제물은 job_id 가 원래 NULL(payload 도
    #   NULL)이라, 단순 'job_id IS NULL' 가드면 매 호출 UPDATE 가 반복돼(수렴 안 함) 쓰기락 경합을 만든다.
    #   추출 가능한 legacy 행만 대상으로 하면 그 행을 다 채운 뒤엔 대상 0건이 되어 수렴한다. 재시도 안전.
    _NULL_BACKFILL = (
        "job_id IS NULL AND json_extract(payload, '$.generation.job_id') IS NOT NULL"
    )
    if conn.execute(f"SELECT 1 FROM trash.trashed WHERE {_NULL_BACKFILL} LIMIT 1").fetchone():
        conn.execute(
            f"UPDATE trash.trashed SET job_id = json_extract(payload, '$.generation.job_id') "
            f"WHERE {_NULL_BACKFILL}"
        )


def attach_trash(conn) -> None:
    """주어진 커넥션에 휴지통 DB 를 ATTACH + 스키마 보장. 반드시 트랜잭션 '밖'에서 호출(sqlite ATTACH 제약).
    호출측이 BEGIN IMMEDIATE 를 열고 그 안에서 tombstoned_among 으로 최신 삭제상태를 조회한 뒤,
    끝나면 detach_trash 로 뗀다. (동기화가 삭제-경합에서도 방금 삭제된 잡을 보게 하는 경로)."""
    if not _IS_PG:
        conn.execute("ATTACH DATABASE ? AS trash", (str(_trash_path()),))
    _ensure_trash_schema(conn)


def detach_trash(conn) -> None:
    """attach_trash 로 붙인 휴지통 DB 를 뗀다(트랜잭션 종료 후, best-effort).
    안 붙었거나 이미 닫힌 커넥션이면 무해하므로 예외를 삼킨다(상위에서 풀 커넥션을 폐기)."""
    if _IS_PG:
        return
    try:
        conn.execute("DETACH DATABASE trash")
    except Exception:  # noqa: BLE001 — 미부착/닫힘 등
        pass


def tombstoned_among(conn, job_ids) -> set[str]:
    """job_ids 중 휴지통에 있는(=삭제된) job_id 만. conn 은 attach_trash 로 휴지통이 붙어 있어야 한다.
    ★쓰기 트랜잭션(BEGIN IMMEDIATE) '안'에서 호출하면 쓰기락 획득 이후의 최신 커밋된 삭제까지 본다
    → 삭제↔동기화 경합에서 방금 삭제된 잡을 놓치지 않는다(재등장 차단). 들어온 잡만 IN 조회라
    휴지통이 커져도 스캔 비용이 늘지 않는다."""
    ids = [j for j in (job_ids or []) if j]
    if not ids:
        return set()
    ph = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT job_id FROM trash.trashed WHERE job_id IN ({ph})", ids
    ).fetchall()
    return {r["job_id"] for r in rows}


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
        # 코멘트단위 seen(comment_id 기준) — 빠뜨리면 복원 시 모든 코멘트가 다시 NEW 로 떠 재알림 폭주.
        "comment_seen": _gather_comment_seen(conn, gen_id),
        "shares": [_row(r) for r in conn.execute(
            "SELECT * FROM share WHERE generation_id=?", (gen_id,)).fetchall()],
    }


def _gather_comment_seen(conn: sqlite3.Connection, gen_id: str) -> list[dict[str, Any]]:
    """이 gen 의 코멘트들에 대한 seen 행. 구버전 DB 에 테이블이 없을 수 있어 가드."""
    try:
        return [_row(r) for r in conn.execute(
            "SELECT s.* FROM generation_comment_seen s "
            "JOIN generation_comment c ON c.id = s.comment_id WHERE c.gen_id=?",
            (gen_id,),
        ).fetchall()]
    except Exception:  # noqa: BLE001 — 테이블 미존재(레거시)
        return []


def move_to_trash(gen_id: str) -> bool:
    """generation 1건을 휴지통 DB 로 원자 이동(메인에서 제거). 없으면 False."""
    from ..config import MANAGE_ENABLED

    tomb: Optional[dict[str, Any]] = None
    with _with_trash() as conn:
        # ★스냅샷(_gather)과 삭제를 같은 트랜잭션으로 — BEGIN 을 스냅샷 뒤에 열면
        # 그 사이 끼어든 변경(태그·코멘트 등)이 스냅샷에 빠진 채 삭제돼 복구 시 유실된다.
        conn.execute("BEGIN IMMEDIATE")
        gen = conn.execute("SELECT * FROM generation WHERE id=?", (gen_id,)).fetchone()
        if not gen:
            return False
        payload = _gather(conn, gen_id, gen)
        if MANAGE_ENABLED:  # 삭제 전 매니징 스냅샷 캡처(비용·프로젝트 등) — 자식 삭제 전이라야 조회 가능
            tomb = _telemetry_snapshot(conn, gen_id, gen)
        conn.execute(
            "INSERT OR REPLACE INTO trash.trashed"
            "(id, trashed_at, project_id, creator_uid, status, prompt, source_name, job_id, payload) "
            "VALUES(?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)",
            (
                gen_id,
                gen["project_id"],
                gen["creator_uid"],
                gen["status"],
                gen["prompt"],
                gen["source_name"],
                gen["job_id"],  # 동기화가 이 잡을 되살리지 않도록 거르는 키(삭제 표식)
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        _delete_generation(conn, gen_id)  # 메인에서 본체+자식 제거
        conn.execute("COMMIT")
    # T5: 팀 매니징 텔레메트리에 삭제 tombstone 을 남긴다 — 서버 집계에서 이 생성물을 is_deleted 로
    # 넘겨(완료/공유 상태·건수가 어긋나지 않게). with 밖에서 별 커넥션으로, best-effort.
    if tomb is not None:
        try:
            from . import manage as _m

            _m.mark_telemetry_tombstone(gen_id, tomb)
        except Exception:  # noqa: BLE001 — 삭제 자체는 성공, 텔레메트리는 사이드카(별 DB)
            # 단, 여기 실패는 스냅샷이 사라져(본체 이미 삭제) 서버 팩트가 is_deleted 로 영영 안 넘어가는
            # 영구 왜곡이 될 수 있어 silent 로 두지 않고 남긴다(진단용). 삭제 흐름은 계속 진행.
            logging.getLogger(__name__).warning(
                "텔레메트리 tombstone 기록 실패(gen_id=%s) — 팀 집계에서 삭제 반영 누락 가능",
                gen_id,
                exc_info=True,
            )
    return True


def _telemetry_snapshot(conn, gen_id: str, gen) -> dict[str, Any]:
    """삭제 직전 매니징 팩트 스냅샷(비용·프로젝트·모델 등). 자식 삭제 전에 호출해야 asset·metrics 조회 가능.
    서버에 아직 팩트가 없던(미전송) 생성물의 tombstone 도 이 값으로 비용이 집계되게 한다."""
    snap: dict[str, Any] = {
        "job_id": gen["job_id"],
        "creator_uid": gen["creator_uid"],
        "project_id": gen["project_id"],
        "folder_path": gen["folder_path"],
        "model": gen["model"],
        "status": gen["status"],
        "created_at": gen["created_at"],
        "sort_ts": gen["sort_ts"],
        "is_final": gen["is_final"],
    }
    try:
        if gen["project_id"]:
            pr = conn.execute("SELECT name FROM project WHERE id=?", (gen["project_id"],)).fetchone()
            snap["project_name"] = pr["name"] if pr else None
        if gen["creator_uid"]:
            cr = conn.execute("SELECT name FROM creator WHERE uid=?", (gen["creator_uid"],)).fetchone()
            snap["creator_name"] = cr["name"] if cr else None
        at = conn.execute("SELECT type FROM asset WHERE generation_id=? LIMIT 1", (gen_id,)).fetchone()
        snap["output_type"] = at["type"] if at else None
        m = conn.execute(
            "SELECT real_credits, est_credits, credit_source, elapsed_seconds, started_at, completed_at "
            "FROM generation_metrics WHERE gen_id=?", (gen_id,)
        ).fetchone()
        if m:
            snap.update(
                real_credits=m["real_credits"], est_credits=m["est_credits"],
                credit_source=m["credit_source"], elapsed_seconds=m["elapsed_seconds"],
                started_at=m["started_at"], completed_at=m["completed_at"],
            )
    except Exception:  # noqa: BLE001 — 사이드카 테이블 미존재 등은 무시(최소 스냅샷이라도 남긴다)
        pass
    return snap


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


def _account_alias_uids(conn, account_uid: str) -> set[str]:
    """account_uid 로 소유 판정할 때 함께 인정할 신원 표현 — 자신 + (user_ 계정이면) 그 계정의
    acct:<email> 옛 별칭. acct:→user_ 전환 후에도 옛 신원으로 삭제한 항목을 목록/복원/영구삭제에서
    놓치지 않게 한다(휴지통 DB의 creator_uid 는 remap 대상 밖이라 stale acct: 로 남을 수 있음)."""
    aliases = {account_uid}
    for r in conn.execute(
        "SELECT email FROM account WHERE creator_uid=?", (account_uid,)
    ).fetchall():
        email = (r["email"] or "").strip().lower()
        if email:
            aliases.add("acct:" + email)
    return aliases


def _acct_remap(conn) -> dict[str, str]:
    """payload 안 stale acct:<email> → 실제 user_ 매핑(user_ 확보된 계정만). 복원 시 payload 신원을
    치환해 메인 DB 로 옛 acct: 가 재유입되는 것을 막는다(admin·단독 복원 포함 항상 적용)."""
    m: dict[str, str] = {}
    for r in conn.execute(
        "SELECT email, creator_uid FROM account WHERE creator_uid IS NOT NULL"
    ).fetchall():
        cuid = r["creator_uid"]
        email = (r["email"] or "").strip().lower()
        if email and cuid and str(cuid).startswith("user_"):
            m["acct:" + email] = cuid
    return m


def _rewrite_payload_identities(p: dict[str, Any], remap: dict[str, str]) -> None:
    """payload 안 작성자 축 신원(acct:→user_)을 치환. generation.worker_id 는 워크스테이션 축이라 제외."""
    if not remap:
        return
    def sub(v):
        return remap.get(v, v)
    g = p.get("generation") or {}
    if g.get("creator_uid"):
        g["creator_uid"] = sub(g["creator_uid"])
    if g.get("final_by"):
        g["final_by"] = sub(g["final_by"])
    for c in p.get("comments") or []:
        if c.get("author"):
            c["author"] = sub(c["author"])
    for rd in p.get("comment_reads") or []:
        if rd.get("worker_id"):  # 컬럼명은 worker_id 지만 값은 actor(creator_uid) — 치환 대상
            rd["worker_id"] = sub(rd["worker_id"])
    for sn in p.get("comment_seen") or []:
        if sn.get("worker_id"):
            sn["worker_id"] = sub(sn["worker_id"])
    for s in p.get("shares") or []:
        if s.get("shared_by"):
            s["shared_by"] = sub(s["shared_by"])


def restore_from_trash(gen_id: str, account_uid: Optional[str] = None) -> bool:
    """휴지통 항목을 메인 DB 에 그대로 재생성 + 휴지통에서 제거(원자). 없으면 False.
    account_uid 가 주어지면(AUTH on) 본인 것만 복구 — 남의 삭제물 복구·재노출 차단."""
    with _with_trash() as conn:
        row = conn.execute(
            "SELECT payload, creator_uid FROM trash.trashed WHERE id=?", (gen_id,)
        ).fetchone()
        if not row:
            return False
        # 일반 계정(account_uid 지정)은 '본인 것(옛 acct: 별칭 포함)'만. 소유자 NULL 인 레거시(단독 시절)
        # 항목은 일반 계정이 복구 못 하게 막는다 — admin 은 호출부에서 account_uid=None 으로 들어와 전부
        # 통과, 단독 모드(AUTH off)도 account_uid=None 이라 통과하므로 레거시가 잠기지 않는다.
        if account_uid is not None and row["creator_uid"] not in _account_alias_uids(
            conn, account_uid
        ):
            raise PermissionError("본인 휴지통 항목만 복구할 수 있습니다")
        p = json.loads(row["payload"])
        # payload 안 stale acct: 신원을 user_ 로 치환(재유입 차단) — admin·단독 복원 포함 항상.
        _rewrite_payload_identities(p, _acct_remap(conn))
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
        # ⚠️ history.parent/child_gen_id 는 NOT NULL FK(generation). 상대 끝이 아직 휴지통/영구삭제면
        # INSERT OR IGNORE 도 FK 위반은 못 무시해 복원 트랜잭션 전체가 롤백된다(복원 자체가 실패).
        # → 양 끝이 메인에 실재하는 엣지만 복원(나머지는 드롭하되 본체 복원은 진행). 상대를 나중에
        # 복원하면 그쪽 payload 에서 엣지가 재생성된다.
        for l in p.get("history") or p.get("lineage") or []:
            pid, cid = l.get("parent_gen_id"), l.get("child_gen_id")
            if not pid or not cid:
                continue
            if (
                conn.execute("SELECT 1 FROM generation WHERE id=?", (pid,)).fetchone()
                and conn.execute("SELECT 1 FROM generation WHERE id=?", (cid,)).fetchone()
            ):
                _insert_row(conn, "history", l, or_ignore=True)
        for c in p.get("comments", []):
            _insert_row(conn, "generation_comment", c, or_ignore=True)
        for rd in p.get("comment_reads", []):
            _insert_row(conn, "generation_comment_read", rd, or_ignore=True)
        for sn in p.get("comment_seen", []):  # 코멘트 seen 복원(없으면 전부 NEW 로 재등장)
            _insert_row(conn, "generation_comment_seen", sn, or_ignore=True)
        for s in p.get("shares", []):
            _insert_row(conn, "share", s, or_ignore=True)
        conn.execute("DELETE FROM trash.trashed WHERE id=?", (gen_id,))
        conn.execute("COMMIT")
    # T5: 복원되면 삭제가 취소된 것 — 텔레메트리를 일반 dirty 로 다시 찍어 tombstone 을 해제(is_tombstone=0)
    # 하고 살아있는 팩트로 재전송되게 한다. with 밖에서 별 커넥션으로, best-effort·플래그 게이트.
    try:
        from ..config import MANAGE_ENABLED

        if MANAGE_ENABLED:
            from . import manage as _m

            _m.mark_telemetry_dirty([gen_id])
    except Exception:  # noqa: BLE001
        pass
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
            # 옛 acct: 별칭까지 포함 — 전환 후에도 내가 지운 항목을 휴지통 목록에서 보게 한다.
            aliases = _account_alias_uids(conn, account_uid)
            where.append(f"creator_uid IN ({','.join('?' * len(aliases))})")
            args += list(aliases)
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


def reconcile_with_main() -> int:
    """크래시(전원/OS 손실)로 휴지통 이동/복원이 한쪽 DB 에만 반영돼 같은 id 가 메인과 휴지통에 '둘 다'
    남은 경우를 정리한다. 정상 운영에선 둘은 상호배타(이동=메인삭제, 복원=휴지통삭제)라, 겹치면 중단된
    작업의 흔적이다(WAL+ATTACH 는 두 파일을 원자적으로 커밋하지 못함 — 평소엔 단일 트랜잭션이라 무해하나
    전원 손실 + synchronous=NORMAL 의 드문 경우에 발생 가능).

    안전 규칙: 살아있는 메인 본을 정답으로 보고 휴지통 복사본만 제거한다 → 데이터 손실 없음(중단된
    이동이면 삭제가 되돌려져 사용자가 재삭제, 중단된 복원이면 복원이 완결된다). 부팅 시 1회 호출."""
    with _with_trash() as conn:
        cur = conn.execute(
            "DELETE FROM trash.trashed WHERE id IN (SELECT id FROM generation)"
        )
        return cur.rowcount


def purge_trashed_item(gen_id: str, account_uid: Optional[str] = None) -> bool:
    """휴지통에서 영구 삭제(복원 불가). account_uid 가 있으면 본인 것만 — 남의 삭제물 영구삭제 방지.
    미디어 파일은 공유·내용주소라 건드리지 않음."""
    with _with_trash() as conn:
        if account_uid:
            aliases = _account_alias_uids(conn, account_uid)  # 옛 acct: 별칭 포함 — 전환 후에도 영구삭제 가능
            return (
                conn.execute(
                    f"DELETE FROM trash.trashed WHERE id=? AND creator_uid IN "
                    f"({','.join('?' * len(aliases))})",
                    [gen_id, *aliases],
                ).rowcount
                > 0
            )
        return conn.execute(
            "DELETE FROM trash.trashed WHERE id=?", (gen_id,)
        ).rowcount > 0
