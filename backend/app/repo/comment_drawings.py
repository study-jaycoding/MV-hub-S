"""코멘트 그림·comments-v2 작성 장부·삭제 기록 — 설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C1·C2.

★새 표 셋은 이름표(baseline)·BASELINES 항목이 없다(옛 검사기·공개판 목록 시험이 막는다). 대신 쓰기 전에
``require`` 가 구조(필수 열·PK·고유·FK)를 보고, 어긋난 표에 기대는 동작만 **바꾸기 전에** 거절한다:
그림 표 = 그림 작성·그림 달린 발행 보내기/받기·그림 달린 복원, 작성 장부 = comments-v2,
삭제 기록 = 코멘트 삭제·발행 받기 합치기·휴지통 복원·comments-v2. 글 전용 작성(서버가 id 를 만드는 옛 길)은 그대로.
"""
from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from typing import Any, Iterable, Optional

from ..db import get_connection
from ..services import comment_strokes
from ..services.comment_strokes import (  # noqa: F401 — 표 구조 검사는 db 초기화도 쓰므로 순환 없는 services 에 둔다
    DRAWING, REQUEST, TOMBSTONE, StructureError, check_structure, require, table_ok as _table_ok,
)


class CommentDeleted(Exception):
    """삭제 기록에 있는 코멘트 id — 다시 만들지 않는다(410)."""


class CommentConflict(ValueError):
    """같은 id 인데 처음 요청과 다름·지운 원글에 답글 등(409)."""


class CommentMergeError(ValueError):
    """발행 받기에서 그림을 붙일 수 없음(소속·작성자·공개·해시 불일치) — 그 항목만 막는다."""


# ── 삭제 기록(C2) ──────────────────────────────────────────────────────────
def tombstoned(conn: sqlite3.Connection, ids: Iterable[str]) -> set[str]:
    wanted = [i for i in dict.fromkeys(ids) if i]
    found: set[str] = set()
    for offset in range(0, len(wanted), 500):
        batch = wanted[offset:offset + 500]
        ph = ",".join("?" * len(batch))
        found.update(r[0] for r in conn.execute(f"SELECT id FROM {TOMBSTONE} WHERE id IN ({ph})", batch))
    return found


def record_tombstones(conn: sqlite3.Connection, ids: Iterable[str], gen_key: str) -> None:
    conn.executemany(f"INSERT OR IGNORE INTO {TOMBSTONE}(id, gen_key) VALUES(?, ?)",
                     [(i, gen_key) for i in dict.fromkeys(ids) if i])


# ── 그림 ──────────────────────────────────────────────────────────────────
def insert_drawings(conn: sqlite3.Connection, comment_id: str, drawings: list[dict[str, Any]]) -> None:
    conn.executemany(
        f"INSERT INTO {DRAWING}(id, comment_id, idx, kind, width, height, time_sec, strokes_json, thumb_jpg, content_hash) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        [(d["id"], comment_id, d["idx"], d["kind"], d["width"], d["height"], d["time_sec"],
          d["strokes_json"], d["thumb"], d["content_hash"]) for d in drawings],
    )


def _drawing_rows(conn: sqlite3.Connection, comment_ids: list[str], columns: str) -> list[sqlite3.Row]:
    rows: list[sqlite3.Row] = []
    for offset in range(0, len(comment_ids), 500):
        batch = comment_ids[offset:offset + 500]
        ph = ",".join("?" * len(batch))
        rows.extend(conn.execute(
            f"SELECT {columns} FROM {DRAWING} WHERE comment_id IN ({ph}) ORDER BY comment_id, idx", batch))
    return rows


def _meta(row: sqlite3.Row) -> dict[str, Any]:
    return {"id": row["id"], "idx": row["idx"], "kind": row["kind"], "width": row["width"],
            "height": row["height"], "time_sec": row["time_sec"], "has_thumb": bool(row["has_thumb"]),
            "content_hash": row["content_hash"], "v": 1}


def drawing_meta(conn: sqlite3.Connection, comment_ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    """목록 응답용 — 메타만(획·thumb 본문은 그림마다 따로 받는다, C5)."""
    ids = [i for i in dict.fromkeys(comment_ids) if i]
    out: dict[str, list[dict[str, Any]]] = {}
    if not ids or not _table_ok(conn, DRAWING):
        return out
    for row in _drawing_rows(conn, ids, "id, comment_id, idx, kind, width, height, time_sec, "
                                       "thumb_jpg IS NOT NULL AS has_thumb, content_hash"):
        out.setdefault(row["comment_id"], []).append(_meta(row))
    return out


def attach_meta(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """코멘트 목록(로컬 DB 행)에 그림 메타를 붙인다. 그림 없는 코멘트는 칸을 만들지 않는다(옛 화면과 같은 모양)."""
    if not comments:
        return comments
    with get_connection() as conn:
        meta = drawing_meta(conn, [str(c.get("id") or "") for c in comments])
    for comment in comments:
        found = meta.get(str(comment.get("id") or ""))
        if found:
            comment["drawings"] = found
    return comments


def load_drawing(comment_id: str, drawing_id: str) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]]]:
    """(코멘트 행, 그림 행) — 권한은 라우터가 코멘트 행으로 판정한다(이미 권한 검사된 코멘트에서만 그림을 꺼낸다)."""
    with get_connection() as conn:
        comment = conn.execute("SELECT id, gen_id, author, is_private FROM generation_comment WHERE id=?",
                               (comment_id,)).fetchone()
        if comment is None:
            return None, None
        row = get_drawing(conn, comment_id, drawing_id)
        return dict(comment), (dict(row) if row is not None else None)


def get_drawing(conn: sqlite3.Connection, comment_id: str, drawing_id: str) -> Optional[sqlite3.Row]:
    if not _table_ok(conn, DRAWING):
        return None
    return conn.execute(
        f"SELECT id, comment_id, idx, kind, width, height, time_sec, strokes_json, thumb_jpg, content_hash "
        f"FROM {DRAWING} WHERE id=? AND comment_id=?", (drawing_id, comment_id),
    ).fetchone()


def export_drawings(conn: sqlite3.Connection, comment_ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    """발행 묶음·휴지통 기록용 — 그림 본문까지(thumb 는 base64). 받는 쪽은 ``comment_strokes.normalize_drawing`` 으로 다시 검사한다."""
    ids = [i for i in dict.fromkeys(comment_ids) if i]
    out: dict[str, list[dict[str, Any]]] = {}
    if not ids:
        return out
    require(conn, DRAWING)
    for row in _drawing_rows(conn, ids, "id, comment_id, idx, kind, width, height, time_sec, strokes_json, thumb_jpg, content_hash"):
        out.setdefault(row["comment_id"], []).append({
            "id": row["id"], "idx": row["idx"], "kind": row["kind"], "width": row["width"], "height": row["height"],
            "time_sec": row["time_sec"], "strokes": json.loads(row["strokes_json"]),
            "thumb_b64": base64.b64encode(row["thumb_jpg"]).decode("ascii") if row["thumb_jpg"] else None,
            "content_hash": row["content_hash"],
        })
    return out


def has_public_drawings(conn: sqlite3.Connection, gen_ids: Iterable[str]) -> set[str]:
    """그림이 달린 공개 코멘트가 있는 생성물 — 발행 묶음을 그림 유무로 나눌 때(C3)."""
    ids = [i for i in dict.fromkeys(gen_ids) if i]
    found: set[str] = set()
    if not ids or not _table_ok(conn, DRAWING):
        return found
    for offset in range(0, len(ids), 500):
        batch = ids[offset:offset + 500]
        ph = ",".join("?" * len(batch))
        found.update(r[0] for r in conn.execute(
            f"SELECT DISTINCT c.gen_id FROM generation_comment c JOIN {DRAWING} d ON d.comment_id=c.id "
            f"WHERE c.is_private=0 AND c.gen_id IN ({ph})", batch))
    return found


def _existing_pairs(conn: sqlite3.Connection, comment_id: str) -> list[tuple[str, str]]:
    return [(r["id"], r["content_hash"]) for r in conn.execute(
        f"SELECT id, content_hash FROM {DRAWING} WHERE comment_id=? ORDER BY idx", (comment_id,))]


# ── comments-v2 작성(C1) ───────────────────────────────────────────────────
def fingerprint(*, author: str, gen_key: str, is_private: bool, parent_id: Optional[str], text: str,
                drawings: list[dict[str, Any]]) -> str:
    """처음 요청의 지문 — 인증 신원·생성물 키·공개 여부·부모·글·순서 있는 {그림 id, 해시}."""
    payload = {"author": author, "gen_key": gen_key, "private": bool(is_private), "parent_id": parent_id or None,
               "text": text, "drawings": [[d["id"], d["content_hash"]] for d in drawings]}
    return hashlib.sha256(comment_strokes.canonical(payload).encode("utf-8")).hexdigest()


def _result(comment_id: str, drawings: list[tuple[str, str]], result: str) -> dict[str, Any]:
    return {"id": comment_id, "result": result, "drawings": [{"id": i, "content_hash": h} for i, h in drawings]}


def has_request(comment_id: str) -> bool:
    """허브가 처리 장소를 정하기 전에 로컬 장부를 먼저 본다(C1 — 그 사이 발행됐어도 처음 장소의 결과)."""
    with get_connection() as conn:
        if not _table_ok(conn, REQUEST):
            return False
        return conn.execute(f"SELECT 1 FROM {REQUEST} WHERE id=?", (comment_id,)).fetchone() is not None


def create_comment_v2(*, gen_id: str, gen_key: str, author: str, comment_id: str, text: str,
                      parent_id: Optional[str], is_private: bool, drawings: list[dict[str, Any]],
                      allow_external_parent: bool = False) -> dict[str, Any]:
    """C1 순서를 한 트랜잭션으로: 삭제 기록 → 장부(같은 지문 = 처음 결과, 다르면 409) → 장부 없는 기존 행(글까지 같으면 present)
    → 부모 검사 → 코멘트·그림·장부를 함께 쓴다. ★transaction-root 전용."""
    text = (text or "").strip()
    if not text:
        raise CommentConflict("빈 코멘트")
    fp = fingerprint(author=author, gen_key=gen_key, is_private=is_private, parent_id=parent_id,
                     text=text, drawings=drawings)
    pairs = [(d["id"], d["content_hash"]) for d in drawings]
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            require(conn, REQUEST, TOMBSTONE, *((DRAWING,) if drawings else ()))
            if tombstoned(conn, [comment_id]):
                raise CommentDeleted(comment_id)
            ledger = conn.execute(f"SELECT fingerprint FROM {REQUEST} WHERE id=?", (comment_id,)).fetchone()
            if ledger is not None:
                if ledger["fingerprint"] != fp:
                    raise CommentConflict("comment_id_request_mismatch")
                conn.execute("COMMIT")
                return _result(comment_id, pairs, "replayed")  # 그 뒤 글을 고쳤어도 정상 재시도
            existing = conn.execute(
                "SELECT gen_id, author, is_private, parent_id, text FROM generation_comment WHERE id=?",
                (comment_id,)).fetchone()
            if existing is not None:
                stored = _existing_pairs(conn, comment_id) if drawings or _table_ok(conn, DRAWING) else []
                same = (existing["gen_id"] == gen_id and existing["author"] == author
                        and bool(existing["is_private"]) == bool(is_private)
                        and (existing["parent_id"] or None) == (parent_id or None)
                        and (existing["text"] or "").strip() == text and stored == pairs)
                if not same:
                    raise CommentConflict("comment_id_conflict")
                conn.execute("COMMIT")
                return _result(comment_id, pairs, "present")  # 만들지도 덮지도 않는다
            if parent_id:
                if tombstoned(conn, [parent_id]):
                    raise CommentConflict("parent_deleted")
                parent = conn.execute("SELECT gen_id FROM generation_comment WHERE id=?", (parent_id,)).fetchone()
                if (parent is None and not allow_external_parent) or (parent is not None and parent["gen_id"] != gen_id):
                    raise CommentConflict("답글 대상 코멘트가 없습니다")
            conn.execute(
                "INSERT INTO generation_comment(id, gen_id, author, text, parent_id, muted, is_private) VALUES(?,?,?,?,?,0,?)",
                (comment_id, gen_id, author, text, parent_id, 1 if is_private else 0))
            if drawings:
                insert_drawings(conn, comment_id, drawings)
            conn.execute(f"INSERT INTO {REQUEST}(id, fingerprint, gen_key) VALUES(?,?,?)", (comment_id, fp, gen_key))
            if parent_id:  # 답글을 달면 부모를 확인한 것(옛 작성 길과 같다)
                conn.execute("INSERT OR IGNORE INTO generation_comment_seen(worker_id, comment_id) VALUES(?, ?)",
                             (author, parent_id))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return _result(comment_id, pairs, "created")


# ── 발행 받기 합치기(C2·C3) ────────────────────────────────────────────────
def merge_drawings(conn: sqlite3.Connection, *, comment_id: str, gen_id: str, author: str,
                   raw_drawings: Any) -> None:
    """받은 묶음의 그림을 코멘트에 붙인다 — 같은 생성물·같은 작성자·공개 코멘트에만, 같은 id 는 해시가 같아야 한다."""
    drawings = comment_strokes.normalize_drawings(raw_drawings)
    if not drawings:
        return
    require(conn, DRAWING)
    row = conn.execute("SELECT gen_id, author, is_private FROM generation_comment WHERE id=?", (comment_id,)).fetchone()
    if row is None or row["gen_id"] != gen_id or row["author"] != author or row["is_private"]:
        raise CommentMergeError("comment_drawing_owner_mismatch")
    stored = dict(_existing_pairs(conn, comment_id))
    fresh = []
    for drawing in drawings:
        if drawing["id"] in stored:
            if stored[drawing["id"]] != drawing["content_hash"]:
                raise CommentMergeError("comment_drawing_hash_mismatch")
            continue
        fresh.append(drawing)
    if fresh:
        try:
            insert_drawings(conn, comment_id, fresh)
        except sqlite3.IntegrityError as exc:  # 같은 순서 칸에 다른 그림 · 다른 코멘트의 같은 id
            raise CommentMergeError("comment_drawing_conflict") from exc
