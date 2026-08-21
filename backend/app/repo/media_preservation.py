"""공유·최종 생성물 원본 보존 작업 상태 저장소.

URL이나 프롬프트는 기록하지 않는다. 생성물별 상태와 안전한 집계만 남겨 재시작 복구,
운영 확인, 수동 재시도를 가능하게 한다.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..db import get_connection


_REASONS = {"shared", "final", "manual", "admin"}


def _utc_text(after_seconds: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=max(0, after_seconds))).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


# 사유 선택까지 UPSERT 한 문장 안에서 처리해야 동시 공유/최종 요청이
# 서로의 최신 값을 덮어쓰지 않는다. Python에서 SELECT 후 UPDATE하면
# 각 연결이 읽은 과거 값으로 되돌리는 경쟁 상태가 생길 수 있다.
# 단건·일괄(cache-all) 등록이 같은 문장을 써야 규칙이 드리프트하지 않는다.
_REQUEST_UPSERT_SQL = (
    "INSERT INTO media_preservation(generation_id,reason,status) "
    "VALUES(?,?,'pending') "
    "ON CONFLICT(generation_id) DO UPDATE SET "
    "reason=CASE "
    "WHEN (CASE excluded.reason "
    "WHEN 'shared' THEN 1 WHEN 'admin' THEN 2 WHEN 'manual' THEN 3 WHEN 'final' THEN 4 "
    "ELSE 0 END) > "
    "(CASE media_preservation.reason "
    "WHEN 'shared' THEN 1 WHEN 'admin' THEN 2 WHEN 'manual' THEN 3 WHEN 'final' THEN 4 "
    "ELSE 0 END) "
    "THEN excluded.reason ELSE media_preservation.reason END, "
    "status=CASE WHEN ?=1 AND media_preservation.status!='running' "
    "THEN 'pending' ELSE media_preservation.status END, "
    "error_code=CASE WHEN ?=1 AND media_preservation.status!='running' "
    "THEN NULL ELSE media_preservation.error_code END, "
    "next_retry_at=CASE WHEN ?=1 AND media_preservation.status!='running' "
    "THEN NULL ELSE media_preservation.next_retry_at END, "
    "requested_at=CASE WHEN ?=1 AND media_preservation.status!='running' "
    "THEN datetime('now') ELSE media_preservation.requested_at END, "
    "updated_at=datetime('now')"
)


def request_media_preservation(gen_id: str, reason: str, *, force: bool = False) -> bool:
    """보존 작업을 멱등 등록한다. force는 완료/실패 작업도 다시 pending으로 돌린다."""
    if reason not in _REASONS:
        raise ValueError(f"unsupported media preservation reason: {reason}")
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            return False
        conn.execute(
            _REQUEST_UPSERT_SQL,
            (gen_id, reason, int(force), int(force), int(force), int(force)),
        )
        return True


def request_media_preservation_for_all_done(reason: str = "admin") -> int:
    """모든 완료(done) 생성물을 한 커넥션에서 보존 큐에 강제(force) 재등록한다.

    /cache-all 전용 배치 경로 — 종전에는 항목마다 완전 직렬화 조회(get_generation)와
    개별 커넥션 UPSERT 를 반복해 전체 DB 규모에 비례하는 N+1 이었다. 대상 선정
    (status='done', 휴지통 포함)과 UPSERT 규칙(사유 우선순위·running 보호·force 재장전)은
    종전 루프와 동일하다. 반환은 종전 queued 와 같은 '등록 시도한 done 생성물 수'.
    단일 트랜잭션이므로 도중 실패 시 부분 등록이 남지 않는다(종전엔 항목별 커밋 —
    성공 시 최종 상태는 동일)."""
    if reason not in _REASONS:
        raise ValueError(f"unsupported media preservation reason: {reason}")
    with get_connection() as conn:
        ids = [
            row[0]
            for row in conn.execute(
                "SELECT id FROM generation WHERE status='done' ORDER BY created_at DESC"
            ).fetchall()
        ]
        conn.executemany(
            _REQUEST_UPSERT_SQL,
            [(gen_id, reason, 1, 1, 1, 1) for gen_id in ids],
        )
        return len(ids)


def backfill_required_media_preservations() -> int:
    """업데이트 전에 이미 공유·최종이었던 완료 생성물을 보존 큐에 멱등 등록한다.

    실제 다운로드는 주기 워커가 소량씩 처리한다. 여기서는 URL이나 프롬프트를 읽지 않고
    생성물 ID와 보존 사유만 기록하므로 앱 시작을 오래 막지 않는다.
    """
    with get_connection() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO media_preservation(generation_id,reason,status) "
            "SELECT g.id, CASE WHEN g.is_final=1 THEN 'final' ELSE 'shared' END, 'pending' "
            "FROM generation g "
            "WHERE g.status='done' AND g.deleted_at IS NULL "
            "AND (g.is_final=1 OR EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id))"
        )
        inserted = max(cur.rowcount, 0)
        # 과거 공유 사유로 먼저 등록됐더라도 현재 최종이면 더 강한 사유로 승격한다.
        conn.execute(
            "UPDATE media_preservation SET reason='final', updated_at=datetime('now') "
            "WHERE reason!='final' AND generation_id IN "
            "(SELECT id FROM generation WHERE is_final=1 AND deleted_at IS NULL)"
        )
        return inserted


def recover_stale_media_preservations(stale_seconds: int = 0) -> int:
    """비정상 종료로 running에 멈춘 작업을 pending으로 되돌린다.

    앱 시작 때는 이전 프로세스의 running이 전부 고아이므로 기본값 0으로 즉시 복구한다.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max(0, stale_seconds))).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE media_preservation SET status='pending', error_code='interrupted', "
            "next_retry_at=NULL, updated_at=datetime('now') "
            "WHERE status='running' AND updated_at<=?",
            (cutoff,),
        )
        return max(cur.rowcount, 0)


def claim_media_preservation(gen_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    """처리할 작업 하나를 원자적으로 running으로 선점한다."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        where = (
            "(status='pending' OR (status IN ('partial','capacity') "
            "AND next_retry_at IS NOT NULL AND next_retry_at<=datetime('now')))"
        )
        args: list[Any] = []
        if gen_id:
            where += " AND generation_id=?"
            args.append(gen_id)
        row = conn.execute(
            f"SELECT * FROM media_preservation WHERE {where} "
            "ORDER BY requested_at, generation_id LIMIT 1",
            args,
        ).fetchone()
        if not row:
            conn.execute("COMMIT")
            return None
        cur = conn.execute(
            "UPDATE media_preservation SET status='running', attempts=attempts+1, "
            "next_retry_at=NULL, updated_at=datetime('now') "
            "WHERE generation_id=? AND status=?",
            (row["generation_id"], row["status"]),
        )
        if cur.rowcount != 1:
            conn.execute("ROLLBACK")
            return None
        claimed = dict(row)
        claimed["status"] = "running"
        claimed["attempts"] = int(row["attempts"] or 0) + 1
        conn.execute("COMMIT")
        return claimed


def finish_media_preservation(
    gen_id: str,
    *,
    status: str,
    cached_count: int,
    failed_count: int,
    skipped_count: int,
    bytes_cached: int,
    error_code: Optional[str] = None,
    retry_after_seconds: Optional[int] = None,
) -> None:
    if status not in {"complete", "partial", "failed", "capacity"}:
        raise ValueError(f"unsupported media preservation status: {status}")
    retry_at = _utc_text(retry_after_seconds) if retry_after_seconds is not None else None
    with get_connection() as conn:
        conn.execute(
            "UPDATE media_preservation SET status=?, cached_count=?, failed_count=?, "
            "skipped_count=?, bytes_cached=bytes_cached+?, error_code=?, next_retry_at=?, "
            "updated_at=datetime('now') WHERE generation_id=?",
            (
                status,
                max(0, cached_count),
                max(0, failed_count),
                max(0, skipped_count),
                max(0, bytes_cached),
                error_code,
                retry_at,
                gen_id,
            ),
        )


def get_media_preservation(gen_id: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM media_preservation WHERE generation_id=?", (gen_id,)
        ).fetchone()
        return dict(row) if row else None


def media_preservation_counts() -> dict[str, int]:
    """운영 상태용 상태별 작업 수. 생성물 내용은 노출하지 않는다."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS count FROM media_preservation GROUP BY status"
        ).fetchall()
    return {str(row["status"]): int(row["count"]) for row in rows}
