"""운영 진단용 집계.

계정·이메일·프롬프트·결과 URL은 다루지 않고, 서버 운영에 필요한 개수와 지연만 반환한다.
"""
from __future__ import annotations

import contextlib
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import AUTH_ENABLED, MANAGE_ENABLED
from ..db import get_connection, get_db_path
from ..manage_db import MANAGE_DB_PATH
from ..repo.manage_telemetry import telemetry_outbox_status
from .backup import list_backups_info

_ACTIVE_PHASES = ("pending", "submitting", "running", "tracking", "verifying", "blocked")
_TRUE_VALUES = {"1", "true", "yes", "on"}


def _shared_server_runtime() -> bool:
    no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY", "").strip().lower()
    return AUTH_ENABLED and no_proxy not in _TRUE_VALUES


def generation_queue_snapshot() -> dict[str, Any]:
    """생성 큐가 어느 단계에 있고 어디서 오래 머무는지 개인식별 없이 집계한다."""
    if _shared_server_runtime():
        return {
            "phase_counts": {},
            "active_total": 0,
            "oldest_active_age_seconds": 0,
            "overdue_checks": 0,
            "check_failures_total": 0,
            "unanchored_over_10m": 0,
            "applicable": False,
        }
    placeholders = ",".join("?" for _ in _ACTIVE_PHASES)
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) count, "
            "MAX(0, CAST((julianday('now')-julianday(MIN(created_at)))*86400 AS INTEGER)) "
            "oldest_age_seconds FROM gen_request GROUP BY status ORDER BY status"
        ).fetchall()
        active_total = conn.execute(
            f"SELECT COUNT(*) FROM gen_request WHERE status IN ({placeholders})",
            _ACTIVE_PHASES,
        ).fetchone()[0]
        overdue_checks = conn.execute(
            f"SELECT COUNT(*) FROM gen_request WHERE status IN ({placeholders}) "
            "AND next_check_at IS NOT NULL AND next_check_at < datetime('now')",
            _ACTIVE_PHASES,
        ).fetchone()[0]
        check_failures = conn.execute(
            f"SELECT COALESCE(SUM(check_failures),0) FROM gen_request "
            f"WHERE status IN ({placeholders})",
            _ACTIVE_PHASES,
        ).fetchone()[0]
        unanchored_stale = conn.execute(
            "SELECT COUNT(*) FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.status IN ('submitting','running') "
            "AND (g.job_id IS NULL OR g.job_id='') "
            "AND r.updated_at < datetime('now','-10 minutes')"
        ).fetchone()[0]

    phase_counts = {row["status"]: int(row["count"]) for row in rows}
    active_rows = [row for row in rows if row["status"] in _ACTIVE_PHASES]
    oldest = max(
        (int(row["oldest_age_seconds"] or 0) for row in active_rows), default=0
    )
    return {
        "phase_counts": phase_counts,
        "active_total": int(active_total),
        "oldest_active_age_seconds": oldest,
        "overdue_checks": int(overdue_checks),
        "check_failures_total": int(check_failures),
        "unanchored_over_10m": int(unanchored_stale),
        "applicable": True,
    }


def backup_snapshot() -> dict[str, Any]:
    backups = list_backups_info()
    if not backups:
        return {"set_count": 0, "latest_age_seconds": None, "latest_file_count": 0}
    latest = backups[0]
    try:
        # list_backups_info의 mtime 대신 실제 대표 파일 mtime을 쓰면 문자열 파싱 차이를 피한다.
        from . import backup

        path = backup._backup_dir() / latest["file"]
        age = max(0, int(time.time() - path.stat().st_mtime))
    except OSError:
        age = None
    return {
        "set_count": len(backups),
        "latest_age_seconds": age,
        "latest_file_count": len(latest.get("files") or [latest["file"]]),
    }


def _check_sqlite(path: Path, table: str) -> None:
    with contextlib.closing(sqlite3.connect(str(path), timeout=2)) as conn:
        conn.execute("PRAGMA query_only=ON")
        if conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is None:
            # 빈 테이블도 정상이다. SELECT가 성공한 사실만 필요하다.
            return


def database_readiness() -> dict[str, Any]:
    """핵심 DB 파일과 핵심 테이블이 실제로 읽히는지 확인한다(전체 DB 스캔 없음)."""
    checks: dict[str, str] = {}
    try:
        with get_connection() as conn:
            conn.execute("SELECT 1 FROM generation LIMIT 1").fetchone()
            conn.execute("SELECT 1 FROM gen_request LIMIT 1").fetchone()
            conn.execute("SELECT 1 FROM generation_event LIMIT 1").fetchone()
            conn.execute("SELECT 1 FROM audit_event LIMIT 1").fetchone()
        checks["content"] = "ok"
    except Exception as exc:  # noqa: BLE001 — 공개 응답에는 예외 내용 대신 종류만
        checks["content"] = type(exc).__name__

    trash_path = get_db_path().parent / "content_hub_trash.db"
    if trash_path.is_file():
        try:
            _check_sqlite(trash_path, "trashed")
            checks["trash"] = "ok"
        except Exception as exc:  # noqa: BLE001
            checks["trash"] = type(exc).__name__
    else:
        checks["trash"] = "not_created"

    if MANAGE_ENABLED:
        try:
            _check_sqlite(MANAGE_DB_PATH, "team_generation_fact")
            checks["manage"] = "ok"
        except Exception as exc:  # noqa: BLE001
            checks["manage"] = type(exc).__name__
    else:
        checks["manage"] = "disabled"

    failed = [name for name, result in checks.items() if result not in {"ok", "not_created", "disabled"}]
    return {"ready": not failed, "checks": checks, "failed_checks": failed}


def telemetry_snapshot() -> dict[str, Any]:
    """관리 대시보드 전송 대기량·지연만 반환한다. 오류 원문은 운영 스냅샷에 싣지 않는다."""
    # 인증 공유 서버는 텔레메트리의 수신지라 로컬 outbox를 전송하지 않는다. 과거 단일형 DB에
    # 남은 행을 대기 장애로 표시하면 작업자 전송 문제로 오해하므로 서버 상태에서는 제외한다.
    if _shared_server_runtime():
        return {
            "pending": 0,
            "failed": 0,
            "oldest_age_seconds": None,
            "applicable": False,
        }
    status = telemetry_outbox_status()
    oldest_age: int | None = None
    raw_oldest = status.get("oldest_dirty")
    if raw_oldest:
        try:
            stamp = str(raw_oldest).strip().replace("Z", "+00:00")
            parsed = datetime.fromisoformat(stamp)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            oldest_age = max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
        except (TypeError, ValueError):
            oldest_age = None
    return {
        "pending": int(status.get("pending") or 0),
        "failed": int(status.get("failed") or 0),
        "oldest_age_seconds": oldest_age,
        "applicable": True,
    }


class OperationalAlertTracker:
    """같은 경고를 매 분 반복하지 않고, 상태 변경 또는 장기 지속 때만 다시 알린다."""

    def __init__(self, repeat_seconds: float = 1800.0) -> None:
        self.repeat_seconds = max(1.0, float(repeat_seconds))
        self._seen: dict[str, tuple[tuple[Any, ...], float]] = {}

    def events(self, snapshot: dict[str, Any], *, now: float | None = None) -> list[dict[str, Any]]:
        clock = time.monotonic() if now is None else float(now)
        operations = snapshot.get("operations") or snapshot
        queue = operations.get("generation_queue") or {}
        telemetry = operations.get("telemetry") or {}
        databases = operations.get("databases") or {}
        candidates: dict[str, dict[str, Any]] = {}

        queue_values = (
            int(queue.get("overdue_checks") or 0),
            int(queue.get("check_failures_total") or 0),
            int(queue.get("unanchored_over_10m") or 0),
        )
        if any(queue_values):
            candidates["generation_queue_attention"] = {
                "overdue_checks": queue_values[0],
                "check_failures": queue_values[1],
                "unanchored_over_10m": queue_values[2],
            }

        pending = int(telemetry.get("pending") or 0)
        failed = int(telemetry.get("failed") or 0)
        oldest = telemetry.get("oldest_age_seconds")
        if failed or (pending and oldest is not None and int(oldest) >= 600):
            candidates["telemetry_backlog"] = {
                "pending": pending,
                "failed": failed,
                "oldest_age_seconds": int(oldest or 0),
            }

        if databases and not databases.get("ready", True):
            candidates["database_unready"] = {
                "failed_checks": list(databases.get("failed_checks") or []),
            }

        emitted: list[dict[str, Any]] = []
        for event, fields in candidates.items():
            # oldest_age_seconds는 시간이 흐르면 매초 달라진다. 이를 상태 변화로 보면 같은
            # telemetry 경고를 지표 주기마다 반복한다. 경고 시작 시각은 첫 방출에 포함하되,
            # 재방출 판단은 실제 건수(pending/failed)가 바뀌었는지만 본다.
            fingerprint_fields = fields
            if event == "telemetry_backlog":
                fingerprint_fields = {
                    "pending": fields.get("pending"),
                    "failed": fields.get("failed"),
                }
            fingerprint = tuple(
                (key, repr(value)) for key, value in sorted(fingerprint_fields.items())
            )
            previous = self._seen.get(event)
            if previous is None or previous[0] != fingerprint or clock - previous[1] >= self.repeat_seconds:
                emitted.append({"event": event, **fields})
                self._seen[event] = (fingerprint, clock)
        for event in set(self._seen) - set(candidates):
            self._seen.pop(event, None)
        return emitted


def operations_snapshot() -> dict[str, Any]:
    return {
        "generation_queue": generation_queue_snapshot(),
        "telemetry": telemetry_snapshot(),
        "backups": backup_snapshot(),
        "databases": database_readiness(),
    }
