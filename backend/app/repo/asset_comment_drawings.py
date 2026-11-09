"""어셋(파일) 코멘트 그림·comments-v2 작성 장부 — 설계 docs/status/어셋코멘트그림_설계_2026-11-05.md §3.

생성물 그림 코멘트(repo/comment_drawings.py)의 C1·C4 규칙을 어셋에 옮긴 **어셋 전용** 모듈이다(설계 §3.1 — 생성물
create_comment_v2 를 대상 매개로 일반화하지 않는다: 그쪽은 삭제 기록·발행 합치기·휴지통 분기가 섞여 있다). 획 검증·정규화·해시는
services/comment_strokes 를 그대로 쓴다. 생성물 지문(직렬화 키 gen_key)·저장은 건드리지 않는다.

★삭제 기록 표가 없다 — 어셋 코멘트는 발행 꾸러미에 실리지 않아 되살아나는 길이 재시도뿐이다(설계 E2). 대신 코멘트를 지워도
장부 행을 남겨 '장부엔 있는데 코멘트가 없음' = 지워진 코멘트(410)로 본다.
★두 표는 이름표(baseline)·BASELINES 항목이 없다 — 쓰기·읽기 전에 ``require`` 가 구조를 보고 어긋난 표에 기대는 동작만
바꾸기 전에 거절한다(그림 표 = 그림 작성·조회, 장부 = comments-v2). 기존 어셋 글 코멘트는 그대로.
"""
from __future__ import annotations

import hashlib
import sqlite3
from typing import Any, Iterable, Optional

from ..db import get_connection
from ..services import comment_strokes
from ..services.comment_strokes import ASSET_DRAWING, ASSET_REQUEST, StructureError, require, table_ok  # noqa: F401


class AssetCommentDeleted(Exception):
    """장부엔 있는데 코멘트가 없는 id — 지워진 코멘트다. 다시 만들지 않는다(410)."""


class AssetCommentConflict(ValueError):
    """같은 id 인데 처음 요청과 다름 · 그림 id 충돌(409)."""


def asset_key(project: str, path: str) -> str:
    """장부·지문의 어셋 키 — 라우터가 real_meta_key 로 정규화한 (project, path)."""
    return f"{project}\0{path}"


def fingerprint(*, author: str, asset_key: str, is_private: bool, parent_id: Optional[str], text: str,
                drawings: list[dict[str, Any]]) -> str:
    """처음 요청의 지문 — 인증 신원·어셋 키·공개 여부·부모·글·순서 있는 {그림 id, 해시}(생성물 fingerprint 와 같은 꼴, 키 자리만 다름)."""
    payload = {"author": author, "asset_key": asset_key, "private": bool(is_private), "parent_id": parent_id or None,
               "text": text, "drawings": [[d["id"], d["content_hash"]] for d in drawings]}
    return hashlib.sha256(comment_strokes.canonical(payload).encode("utf-8")).hexdigest()


def _result(comment_id: str, drawings: list[tuple[str, str]], result: str) -> dict[str, Any]:
    return {"id": comment_id, "result": result, "drawings": [{"id": i, "content_hash": h} for i, h in drawings]}


def _stored_pairs(conn: sqlite3.Connection, comment_id: str) -> list[tuple[str, str]]:
    if not table_ok(conn, ASSET_DRAWING):
        return []
    return [(r["id"], r["content_hash"]) for r in conn.execute(
        f"SELECT id, content_hash FROM {ASSET_DRAWING} WHERE comment_id=? ORDER BY idx", (comment_id,))]


def insert_drawings(conn: sqlite3.Connection, comment_id: str, drawings: list[dict[str, Any]]) -> None:
    conn.executemany(
        f"INSERT INTO {ASSET_DRAWING}(id, comment_id, idx, kind, width, height, time_sec, strokes_json, thumb_jpg, content_hash) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        [(d["id"], comment_id, d["idx"], d["kind"], d["width"], d["height"], d["time_sec"],
          d["strokes_json"], d["thumb"], d["content_hash"]) for d in drawings],
    )


# ── 목록 메타(설계 §3.2 — 획·thumb 본문은 그림마다 따로) ────────────────────────
def drawing_meta(conn: sqlite3.Connection, comment_ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    ids = [i for i in dict.fromkeys(comment_ids) if i]
    out: dict[str, list[dict[str, Any]]] = {}
    if not ids or not table_ok(conn, ASSET_DRAWING):
        return out
    for offset in range(0, len(ids), 500):
        batch = ids[offset:offset + 500]
        ph = ",".join("?" * len(batch))
        for row in conn.execute(
            f"SELECT id, comment_id, idx, kind, width, height, time_sec, thumb_jpg IS NOT NULL AS has_thumb, content_hash "
            f"FROM {ASSET_DRAWING} WHERE comment_id IN ({ph}) ORDER BY comment_id, idx", batch,
        ):
            out.setdefault(row["comment_id"], []).append({
                "id": row["id"], "idx": row["idx"], "kind": row["kind"], "width": row["width"], "height": row["height"],
                "time_sec": row["time_sec"], "has_thumb": bool(row["has_thumb"]), "content_hash": row["content_hash"], "v": 1,
            })
    return out


def attach_meta(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """코멘트 목록(이 DB 의 행)에 그림 메타를 붙인다. 그림 없는 코멘트는 칸을 만들지 않는다(옛 화면과 같은 모양)."""
    if not comments:
        return comments
    with get_connection() as conn:
        meta = drawing_meta(conn, [str(c.get("id") or "") for c in comments])
    for comment in comments:
        found = meta.get(str(comment.get("id") or ""))
        if found:
            comment["drawings"] = found
    return comments


# ── 그림 조회 ──────────────────────────────────────────────────────────────
def load_drawing(comment_id: str, drawing_id: str) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]]]:
    """(코멘트 행, 그림 행) — 권한은 라우터가 코멘트 행으로 판정한다. 그림 표가 어긋났으면 StructureError(바꾸기 전 거절)."""
    with get_connection() as conn:
        comment = conn.execute("SELECT id, project, path, author, is_private FROM asset_comment WHERE id=?",
                               (comment_id,)).fetchone()
        if comment is None:
            return None, None
        require(conn, ASSET_DRAWING)
        row = conn.execute(
            f"SELECT id, comment_id, idx, kind, width, height, time_sec, strokes_json, thumb_jpg, content_hash "
            f"FROM {ASSET_DRAWING} WHERE id=? AND comment_id=?", (drawing_id, comment_id),
        ).fetchone()
        return dict(comment), (dict(row) if row is not None else None)


def comment_privacy(comment_id: str) -> Optional[bool]:
    """이 DB 에 있는 코멘트의 비공개 여부(없으면 None) — 허브가 그림 조회를 로컬/서버로 나눌 때."""
    with get_connection() as conn:
        row = conn.execute("SELECT is_private FROM asset_comment WHERE id=?", (comment_id,)).fetchone()
    return None if row is None else bool(row["is_private"])


# ── comments-v2 작성(설계 §3.2) ───────────────────────────────────────────────
def local_request_state(comment_id: str) -> Optional[dict[str, Any]]:
    """허브가 처리 장소를 정하기 전에 로컬 장부를 먼저 본다 — None = 장부에 없음.
    {"exists": 코멘트 행이 있나, "private": 그 행이 비공개인가}. 장부 표가 어긋났으면 None(그 경우 쓰기는 create 에서 거절된다)."""
    with get_connection() as conn:
        if not table_ok(conn, ASSET_REQUEST):
            return None
        if conn.execute(f"SELECT 1 FROM {ASSET_REQUEST} WHERE id=?", (comment_id,)).fetchone() is None:
            return None
        row = conn.execute("SELECT is_private FROM asset_comment WHERE id=?", (comment_id,)).fetchone()
    return {"exists": row is not None, "private": bool(row["is_private"]) if row is not None else False}


def create_comment_v2(*, project: str, path: str, author: str, comment_id: str, text: str,
                      is_private: bool, drawings: list[dict[str, Any]]) -> dict[str, Any]:
    """한 트랜잭션: 장부(지워짐 410 · 같은 지문 = 처음 결과 · 다르면 409) → 장부 없는 같은 id 의 기존 행(409)
    → 코멘트·그림·장부를 함께 쓴다. 검증은 라우터가 먼저 끝낸다(normalize_drawings·파일 종류). ★transaction-root 전용.
    답글(parent_id)은 받지 않는다(1단계 — 그림은 새 코멘트에만)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("빈 코멘트")  # 라우터가 먼저 400 으로 거른다 — 여기는 방어
    key = asset_key(project, path)
    fp = fingerprint(author=author, asset_key=key, is_private=is_private, parent_id=None, text=text, drawings=drawings)
    pairs = [(d["id"], d["content_hash"]) for d in drawings]
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            require(conn, ASSET_REQUEST, *((ASSET_DRAWING,) if drawings else ()))
            ledger = conn.execute(f"SELECT fingerprint FROM {ASSET_REQUEST} WHERE id=?", (comment_id,)).fetchone()
            if ledger is not None:
                exists = conn.execute("SELECT 1 FROM asset_comment WHERE id=?", (comment_id,)).fetchone() is not None
                if not exists:
                    raise AssetCommentDeleted(comment_id)
                if ledger["fingerprint"] != fp:
                    raise AssetCommentConflict("comment_id_request_mismatch")
                conn.execute("COMMIT")
                return _result(comment_id, pairs, "replayed")  # 그 뒤 글을 고쳤어도 정상 재시도
            if conn.execute("SELECT 1 FROM asset_comment WHERE id=?", (comment_id,)).fetchone() is not None:
                raise AssetCommentConflict("comment_id_conflict")  # 장부 없는 같은 id(어셋엔 생길 길이 없다 — 방어)
            conn.execute(
                "INSERT INTO asset_comment(id, project, path, author, text, parent_id, muted, is_private) VALUES(?,?,?,?,?,NULL,0,?)",
                (comment_id, project, path, author, text, 1 if is_private else 0))
            if drawings:
                try:
                    insert_drawings(conn, comment_id, drawings)
                except sqlite3.IntegrityError as exc:  # 다른 코멘트가 이미 가진 그림 id(저장된 요청의 그림을 고쳐 다시 보냄)
                    raise AssetCommentConflict("drawing_id_conflict") from exc
            conn.execute(f"INSERT INTO {ASSET_REQUEST}(id, fingerprint, asset_key) VALUES(?,?,?)", (comment_id, fp, key))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return _result(comment_id, pairs, "created")


def stored_pairs(comment_id: str) -> list[tuple[str, str]]:
    """시험·진단용 — 그 코멘트에 저장된 (그림 id, 해시)."""
    with get_connection() as conn:
        return _stored_pairs(conn, comment_id)
