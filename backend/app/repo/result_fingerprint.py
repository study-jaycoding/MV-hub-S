"""결과 파일 부분 지문(docs/RESULT_FINGERPRINT.md) — 로컬 asset 칸 읽기·쓰기.

지문 = (원본 전체 크기, 앞 64KiB sha256) 한 쌍. 수집기(services/result_probe.py)가 네트워크·파일 읽기를
트랜잭션 밖에서 하고, 기록은 여기서 **조건을 다시 확인한 뒤** 한 트랜잭션으로 한다.
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from .manage_schema import _ensure_schema
from .manage_telemetry import mark_telemetry_dirty_in_connection

MAX_PROBE_FAILS = 3  # 이만큼 연속 실패하면 다시 시도하지 않는다(asset 이 새 행이 되면 다시 기회)

# 대상: 내 것·완료·살아 있음·결과 정확히 1개. 수집 대상과 재확인이 같은 조건을 쓴다.
_ELIGIBLE = (
    "g.status='done' AND g.deleted_at IS NULL AND g.creator_uid=? "
    "AND (SELECT COUNT(*) FROM asset b WHERE b.generation_id=a.generation_id)=1"
)


def original_key(file_path: Optional[str], source_url: Optional[str]) -> str:
    """결과물의 원본 키 — 캐시된 asset 은 file_path=/media/…, 원본 URL 은 source_url 에 남는다.
    generation_sync 의 '같은 결과물' 판정과 같은 규칙(source_url 우선)."""
    return (source_url or file_path or "").strip()


def probe_targets(uid: str, limit: int) -> list[dict[str, Any]]:
    """지문이 아직 없는 내 결과물(최신부터)."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT a.id AS asset_id, a.generation_id, a.file_path, a.source_url "
            "FROM asset a JOIN generation g ON g.id=a.generation_id "
            f"WHERE a.result_bytes IS NULL AND a.result_probe_fail < ? AND {_ELIGIBLE} "
            "ORDER BY g.sort_ts DESC, g.created_at DESC LIMIT ?",
            (MAX_PROBE_FAILS, uid, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def _still_eligible(conn, target: dict[str, Any], uid: str) -> bool:
    """네트워크를 다녀온 사이 생성물이 지워지거나·남의 것이 되거나·결과가 바뀌었으면 기록하지 않는다."""
    row = conn.execute(
        "SELECT a.file_path, a.source_url FROM asset a JOIN generation g ON g.id=a.generation_id "
        f"WHERE a.id=? AND a.generation_id=? AND a.result_bytes IS NULL AND {_ELIGIBLE}",
        (target["asset_id"], target["generation_id"], uid),
    ).fetchone()
    return row is not None and original_key(row["file_path"], row["source_url"]) == original_key(
        target.get("file_path"), target.get("source_url")
    )


def record_probe_success(target: dict[str, Any], uid: str, size: int, head_sha: str) -> bool:
    """조건이 그대로일 때만 쌍을 적고 텔레메트리 dirty 를 찍는다. 어긋나면 둘 다 하지 않는다."""
    with get_connection() as conn:
        _ensure_schema(conn)  # dirty 표(telemetry_outbox)는 BEGIN 전에 보장해야 한다
        conn.execute("BEGIN IMMEDIATE")
        if not _still_eligible(conn, target, uid):
            return False
        conn.execute(
            "UPDATE asset SET result_bytes=?, result_head_sha=?, result_fp_sent_to=NULL WHERE id=?",
            (size, head_sha, target["asset_id"]),
        )
        mark_telemetry_dirty_in_connection(conn, [target["generation_id"]])
        return True


def record_probe_failure(target: dict[str, Any], uid: str) -> bool:
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not _still_eligible(conn, target, uid):
            return False
        conn.execute(
            "UPDATE asset SET result_probe_fail=result_probe_fail+1 WHERE id=?", (target["asset_id"],)
        )
        return True


def mark_resend(uid: str, origin: str, limit: int) -> int:
    """쌍은 있는데 **지금 서버**가 받았다고 확인해 주지 않은 내 결과물을 다시 보내도록 dirty 표시.
    (옛 서버·서버 이사·롤백 뒤에도 값이 사라지지 않게 — 하루 한 번 수집기가 부른다.)"""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        ids = [
            row[0]
            for row in conn.execute(
                "SELECT a.generation_id FROM asset a JOIN generation g ON g.id=a.generation_id "
                "WHERE a.result_bytes IS NOT NULL AND a.result_head_sha IS NOT NULL "
                f"AND (a.result_fp_sent_to IS NULL OR a.result_fp_sent_to<>?) AND {_ELIGIBLE} "
                "ORDER BY g.sort_ts DESC LIMIT ?",
                (origin, uid, limit),
            ).fetchall()
        ]
        mark_telemetry_dirty_in_connection(conn, ids)
    return len(ids)


def mark_fp_delivery(rows: list[tuple[str, int, str]], origin: Optional[str]) -> None:
    """push 응답 정산 — (asset_id, 크기, 지문) 이 **보낼 때 값과 지금 값이 같을 때만** 확인 서버를 적는다.
    origin=None 은 '이 응답으로는 확인 안 됨'(옛 서버 — 지문 칸을 버렸을 수 있다)."""
    if not rows:
        return
    with get_connection() as conn:
        for asset_id, size, head_sha in rows:
            conn.execute(
                "UPDATE asset SET result_fp_sent_to=? "
                "WHERE id=? AND result_bytes=? AND result_head_sha=?",
                (origin, asset_id, size, head_sha),
            )
