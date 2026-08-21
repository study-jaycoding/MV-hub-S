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

from ..config import AUTH_ENABLED, BACKEND_DIR, DATA_DIR, MANAGE_ENABLED
from ..db import get_connection, get_db_path
from ..manage_db import MANAGE_DB_PATH
from ..repo.manage_telemetry import telemetry_outbox_status
from ..repo.media_preservation import media_preservation_counts
from .backup import BACKUP_INTERVAL, list_backups_info


def backup_interval_seconds() -> float:
    """백업 주기(초) — 경보 임계 계산용(테스트에서 패치 가능하도록 함수로)."""
    return BACKUP_INTERVAL

_ACTIVE_PHASES = (
    "preparing",
    "pending",
    "claimed",
    "submitting",
    "running",
    "tracking",
    "verifying",
    "blocked",
    "recovery_required",
)
_TRUE_VALUES = {"1", "true", "yes", "on"}
_REPLICA_STATUS_FILE = DATA_DIR / "backup_replica_status.json"


def _shared_server_runtime() -> bool:
    no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY", "").strip().lower()
    return AUTH_ENABLED and no_proxy not in _TRUE_VALUES


def _iso_age_seconds(value: object) -> int | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))
    except (TypeError, ValueError):
        return None


def worker_backup_snapshot() -> dict[str, Any]:
    """작업자 개인 DB 오프디스크 outbox 상태. 서버·격리 테스트에는 적용하지 않는다."""
    no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY", "").strip().lower()
    if AUTH_ENABLED or no_proxy in _TRUE_VALUES:
        return {"applicable": False, "state": "not_applicable", "pending": 0, "failed": 0}
    try:
        from .worker_backup import status_snapshot

        value = status_snapshot()
    except Exception:  # noqa: BLE001 — 운영 스냅샷 자체가 앱을 중단하면 안 된다.
        return {"applicable": True, "state": "state_unavailable", "pending": 0, "failed": 1}
    return {
        "applicable": True,
        "state": str(value.get("state") or "unknown")[:64],
        "pending": int(value.get("pending") or 0),
        "failed": int(value.get("failed") or 0),
        "oldest_pending_age_seconds": _iso_age_seconds(value.get("oldest_pending_at")),
        "last_success_age_seconds": _iso_age_seconds(value.get("last_success_at")),
        "last_error_code": str(value.get("last_error_code") or "")[:64] or None,
    }


def _replica_configured() -> bool:
    if os.environ.get("CONTENT_HUB_BACKUP_REPLICA_DIR", "").strip():
        return True
    target_file = BACKEND_DIR.parent / "tools" / "backup_replica_target.txt"
    try:
        return any(
            line.strip() and not line.lstrip().startswith("#")
            for line in target_file.read_text("utf-8", errors="replace").splitlines()
        )
    except OSError:
        return False


def backup_replica_snapshot() -> dict[str, Any]:
    """공유 서버→다른 물리 장치 복제 상태. 저장 경로와 예외 원문은 반환하지 않는다."""
    if not _shared_server_runtime():
        return {"applicable": False, "state": "not_applicable", "configured": False}
    try:
        import json

        value = json.loads(_REPLICA_STATUS_FILE.read_text("utf-8"))
        if not isinstance(value, dict) or value.get("format") != "mvhub-backup-replica-status":
            raise ValueError("invalid status")
    except FileNotFoundError:
        return {
            "applicable": True,
            "state": "never_run",
            "configured": _replica_configured(),
            "last_success_age_seconds": None,
        }
    except (OSError, ValueError, TypeError):
        return {
            "applicable": True,
            "state": "state_unavailable",
            "configured": _replica_configured(),
            "last_success_age_seconds": None,
        }
    return {
        "applicable": True,
        "state": str(value.get("state") or "unknown")[:64],
        "configured": bool(value.get("configured")),
        "last_attempt_age_seconds": _iso_age_seconds(value.get("last_attempt_at")),
        "last_success_age_seconds": _iso_age_seconds(value.get("last_success_at")),
        "error_code": str(value.get("error_code") or "")[:64] or None,
        "copied": int(value.get("copied") or 0),
        "skipped": int(value.get("skipped") or 0),
        "failed": int(value.get("failed") or 0),
    }


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
            "recovery_required_total": 0,
            "applicable": False,
        }
    with get_connection() as conn:
        # 상태별 GROUP BY 한 번에 count·최고령·overdue·check_failures 를 조건 집계한다
        # (R5 ops-2). 종전엔 active_total/overdue/failures/recovery 를 각각 다시 조회해
        # status 단독 인덱스가 없는 gen_request 를 6번 전수 스캔했다. active 필터는
        # 파이썬에서 건다(같은 결과, 스캔 2회).
        rows = conn.execute(
            "SELECT status, COUNT(*) count, "
            "MAX(0, CAST((julianday('now')-julianday(MIN(created_at)))*86400 AS INTEGER)) "
            "oldest_age_seconds, "
            "SUM(CASE WHEN next_check_at IS NOT NULL AND next_check_at < datetime('now') "
            "THEN 1 ELSE 0 END) overdue_count, "
            "COALESCE(SUM(check_failures),0) check_failure_sum "
            "FROM gen_request GROUP BY status ORDER BY status"
        ).fetchall()
        unanchored_stale = conn.execute(
            "SELECT COUNT(*) FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.status IN ('preparing','claimed','submitting','running','recovery_required') "
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
        "active_total": sum(int(row["count"]) for row in active_rows),
        "oldest_active_age_seconds": oldest,
        "overdue_checks": sum(int(row["overdue_count"] or 0) for row in active_rows),
        "check_failures_total": sum(
            int(row["check_failure_sum"] or 0) for row in active_rows
        ),
        "unanchored_over_10m": int(unanchored_stale),
        "recovery_required_total": phase_counts.get("recovery_required", 0),
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


def media_preservation_snapshot() -> dict[str, Any]:
    """원본 보존 큐 상태 집계. 생성물 식별자·URL·오류 원문은 포함하지 않는다."""
    counts = media_preservation_counts()
    return {
        "status_counts": counts,
        "active": int(counts.get("pending", 0)) + int(counts.get("running", 0)),
        "attention": (
            int(counts.get("partial", 0))
            + int(counts.get("failed", 0))
            + int(counts.get("capacity", 0))
        ),
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
        preservation = operations.get("media_preservation") or {}
        databases = operations.get("databases") or {}
        worker_backup = operations.get("worker_backup") or {}
        backup_replica = operations.get("backup_replica") or {}
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

        preservation_counts = preservation.get("status_counts") or {}
        preservation_attention = int(preservation.get("attention") or 0)
        if preservation_attention:
            candidates["media_preservation_attention"] = {
                "partial": int(preservation_counts.get("partial") or 0),
                "failed": int(preservation_counts.get("failed") or 0),
                "capacity": int(preservation_counts.get("capacity") or 0),
            }

        if worker_backup.get("applicable") and int(worker_backup.get("pending") or 0):
            worker_state = str(worker_backup.get("state") or "")
            if worker_state in {
                "failed",
                "login_required",
                "server_update_required",
                "state_unavailable",
            }:
                candidates["worker_backup_attention"] = {
                    "state": worker_state,
                    "pending": int(worker_backup.get("pending") or 0),
                    "failed": int(worker_backup.get("failed") or 0),
                }

        if backup_replica.get("applicable"):
            replica_state = str(backup_replica.get("state") or "")
            if replica_state in {"never_run", "disabled", "failed", "state_unavailable"}:
                candidates["backup_replica_attention"] = {
                    "state": replica_state,
                    "configured": bool(backup_replica.get("configured")),
                    "failed": int(backup_replica.get("failed") or 0),
                }

        # 백업 노후 — 수집만 하고 경보가 없어서 "백업이 며칠째 없다"를 아무도 몰랐다.
        # 주기의 2배(기본 48h)를 넘으면 경보. 백업 비활성(interval<=0)이나 무백업 신규
        # 설치(latest None + set_count 0)는 대상 아님 — set 이 하나라도 있었는데 늙는
        # 경우와, set 은 없는데 서버가 오래 돈 경우 둘 다 잡으려면 age None 도 후보에 넣되
        # set_count 로 구분한다.
        backups = operations.get("backups") or {}
        backup_age = backups.get("latest_age_seconds")
        if backup_interval_seconds() > 0 and backup_age is not None:
            stale_after = backup_interval_seconds() * 2
            if backup_age >= stale_after:
                candidates["backup_stale"] = {
                    "latest_age_seconds": int(backup_age),
                    "stale_after_seconds": int(stale_after),
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
            elif event == "backup_stale":
                # 나이는 매 스냅샷 커진다 — 시간 단위 버킷으로 지문을 굳혀 60초마다 재방출되지 않게.
                fingerprint_fields = {
                    "age_hours": int(fields.get("latest_age_seconds") or 0) // 3600,
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
        "media_preservation": media_preservation_snapshot(),
        "backups": backup_snapshot(),
        "worker_backup": worker_backup_snapshot(),
        "backup_replica": backup_replica_snapshot(),
        "databases": database_readiness(),
    }
