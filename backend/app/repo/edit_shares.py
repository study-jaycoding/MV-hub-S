"""편집 공유 — 사람 × 시퀀스마다 '보이는 것 한 줄'(스냅샷) 한 벌. 공유 서버 DB 가 권위다(로컬 허브는 중계만 — routers/edit_shares).

설계·검사 규칙의 정본: docs/status/편집탭_편집공유_설계_2026-10-23.md(§1~3). 화면의 같은 검사는 frontend/src/lib/editShare.ts.
owner = 정규화 email(응답에 내보내지 않는다 — creator_uid 리맵에도 같다, edit_doc_head 와 같은 까닭). 응답의 열쇠는 처음 저장 때 만든 무작위 owner_key.
"""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ..emailnorm import norm_email

__all__ = ["SHARE_SNAPSHOT_MAX", "SHARE_FIELD_MAX", "ascii_json_len", "check_share_fields", "validate_share_snapshot",
           "save_edit_share", "list_edit_shares", "get_edit_share"]

# 크기 = 'ASCII 로 감싼 길이'(len(json.dumps(x))) — 허브가 서버로 넘길 때 raw_request 가 ensure_ascii 로 다시 써서 한글 1자가 6바이트가 된다.
SHARE_SNAPSHOT_MAX = 256 * 1024
SHARE_FIELD_MAX = {"project_id": 512, "seq": 4096, "expect_account": 1024}
_TOTAL_MAX = 6 * 3600  # 초
_SPEED = (0.25, 4.0)


def ascii_json_len(value: str) -> int:
    return len(json.dumps(value))


def check_share_fields(**fields: str) -> None:
    """덧붙는 칸도 같은 'ASCII 로 감싼 길이'로 자른다(글자 수가 아니라 — 보조 평면 글자가 많아도 요청 상한 안에 든다)."""
    for name, value in fields.items():
        if ascii_json_len(value) > SHARE_FIELD_MAX[name]:
            raise ValueError(f"{name} 가 너무 깁니다")


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)  # 아주 큰 정수(10**400)는 float 로 못 바꾼다 — 화면(JS)에서는 Infinity 라 거절된다
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def _text(value: Any, limit: int, *, optional: bool = False) -> bool:
    if value is None:
        return optional
    return isinstance(value, str) and 0 < len(value) <= limit  # 코드 포인트 수 — 화면도 같은 단위로 센다


def _no_constant(name: str) -> Any:
    raise ValueError(name)  # NaN·Infinity 글자는 JSON 이 아니다(화면의 JSON.parse 가 거절한다)


def validate_share_snapshot(data: str) -> None:
    """스냅샷 v1 검사 — 틀리면 ValueError(라우터가 400). 화면(parseShareSnapshot)과 같은 규칙."""
    if ascii_json_len(data) > SHARE_SNAPSHOT_MAX:
        raise ValueError("편집 공유가 너무 큽니다(256 KiB)")
    try:
        doc = json.loads(data, parse_constant=_no_constant)
    except ValueError as exc:
        raise ValueError("편집 공유를 읽지 못했습니다") from exc
    bad = ValueError("편집 공유의 형식이 맞지 않습니다")
    if not isinstance(doc, dict) or _number(doc.get("v")) != 1:  # true 는 1 이 아니다(화면과 같게)
        raise bad
    total = _number(doc.get("total"))
    cuts = doc.get("cuts")
    if total is None or not 0 < total <= _TOTAL_MAX or not isinstance(cuts, list) or not 0 < len(cuts) <= 2000:
        raise bad
    cut_sum = 0.0
    for cut in cuts:
        if not isinstance(cut, dict) or not _text(cut.get("name"), 200) or not _text(cut.get("folder"), 1000):
            raise bad
        length = _number(cut.get("len"))
        parts = cut.get("parts")
        if length is None or length <= 0 or not isinstance(parts, list) or not 0 < len(parts) <= 64:
            raise bad
        part_sum = 0.0
        for part in parts:
            span = _number(part.get("len")) if isinstance(part, dict) else None
            if span is None or span <= 0:
                raise bad
            if part.get("gap") is not True:
                head = _number(part.get("head"))
                speed = _number(part.get("speed", 1))
                if (not _text(part.get("gen"), 200) or not _text(part.get("job"), 200, optional=True)
                        or part.get("kind") not in ("video", "image") or head is None or head < 0
                        or speed is None or not _SPEED[0] - 1e-9 <= speed <= _SPEED[1] + 1e-9):
                    raise bad
            part_sum += span
        if abs(part_sum - length) > 1e-6:
            raise bad
        cut_sum += length
    if abs(cut_sum - total) > 1e-6:
        raise bad


def _allowed(conn: sqlite3.Connection, project_id: str, viewer_uid: Optional[str], read_all: bool) -> bool:
    """그 프로젝트가 있고, 보는 계정이 멤버이거나 전역 read_all 인가 — 팀 목록·폴더 대표와 같은 범위."""
    return conn.execute(
        "SELECT 1 FROM project p WHERE p.id = ? AND (? OR EXISTS ("
        "SELECT 1 FROM project_member m WHERE m.project_id = p.id AND m.creator_uid = ?))",
        (project_id, 1 if read_all else 0, viewer_uid or "\x00"),
    ).fetchone() is not None


def _head(row: sqlite3.Row) -> dict[str, Any]:
    return {"revision": row["revision"], "data_hash": row["data_hash"], "updated_at": row["updated_at"]}


def save_edit_share(
    project_id: str, seq: str, owner: str, owner_name: Optional[str], data: str, *,
    viewer_uid: Optional[str], read_all: bool,
) -> dict[str, Any]:
    """내 것을 덮어쓴다(한 트랜잭션) — 같은 내용이면 revision 그대로, 다르면 +1. 권한이 없으면 LookupError."""
    owner = norm_email(owner)
    if not owner:
        raise ValueError("계정을 확인할 수 없습니다")
    validate_share_snapshot(data)
    digest = hashlib.sha256(data.encode("utf-8")).hexdigest()
    where = "project_id = ? AND seq = ? AND owner = ?"
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")  # 확인과 저장을 한 쓰기 구간으로(두 창이 같이 저장해도 revision 이 한 번씩만 오른다)
        if not _allowed(conn, project_id, viewer_uid, read_all):
            raise LookupError("project")
        row = conn.execute(f"SELECT revision, data_hash FROM edit_share WHERE {where}", (project_id, seq, owner)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO edit_share(project_id, seq, owner, owner_key, owner_name, revision, data, data_hash) "
                "VALUES(?, ?, ?, ?, ?, 1, ?, ?)",
                (project_id, seq, owner, secrets.token_hex(16), owner_name, data, digest),
            )
        elif row["data_hash"] != digest:
            conn.execute(
                f"UPDATE edit_share SET data = ?, data_hash = ?, revision = revision + 1, owner_name = ?, "
                f"updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE {where}",
                (data, digest, owner_name, project_id, seq, owner),
            )
        saved = conn.execute(f"SELECT revision, data_hash, updated_at FROM edit_share WHERE {where}", (project_id, seq, owner)).fetchone()
    return _head(saved)


def list_edit_shares(
    project_id: str, seq: str, viewer_email: Optional[str], *, viewer_uid: Optional[str], read_all: bool,
) -> list[dict[str, Any]]:
    """그 시퀀스에 저장한 사람들(본문 없음) — mine = 요청한 계정의 것. email 은 내보내지 않는다."""
    mine = norm_email(viewer_email)
    with get_connection() as conn:
        if not _allowed(conn, project_id, viewer_uid, read_all):
            raise LookupError("project")
        rows = conn.execute(
            "SELECT owner, owner_key, owner_name, revision, data_hash, updated_at FROM edit_share "
            "WHERE project_id = ? AND seq = ? ORDER BY updated_at DESC, owner_key",
            (project_id, seq),
        ).fetchall()
    return [
        {"key": row["owner_key"], "name": row["owner_name"] or "", **_head(row), "mine": bool(mine) and row["owner"] == mine}
        for row in rows
    ]


def get_edit_share(project_id: str, seq: str, key: str, *, viewer_uid: Optional[str], read_all: bool) -> dict[str, Any]:
    """한 사람의 것 — 없으면 {"data": None}(404 는 '경로 없음'만 뜻하게)."""
    with get_connection() as conn:
        if not _allowed(conn, project_id, viewer_uid, read_all):
            raise LookupError("project")
        row = conn.execute(
            "SELECT data, revision, data_hash, updated_at FROM edit_share WHERE project_id = ? AND seq = ? AND owner_key = ?",
            (project_id, seq, key),
        ).fetchone()
    return {"data": row["data"], **_head(row)} if row else {"data": None}
