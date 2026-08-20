"""계정별 과거 이력 gap·자동 보충 감사 상태."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import get_connection
from ..emailnorm import norm_email


def _utc_now(value: datetime | None = None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return _utc_now(value).isoformat()


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _utc_now(parsed)


def get_history_import_audit(account_email: str) -> dict[str, Any]:
    email = norm_email(account_email)
    with get_connection() as conn:
        row = conn.execute(
            "SELECT gap_detected_at,gap_resolved_at,last_auto_started_at,last_success_at "
            "FROM history_import_audit WHERE account_email=?",
            (email,),
        ).fetchone()
    if not row:
        return {
            "account_email": email,
            "gap_detected_at": None,
            "gap_resolved_at": None,
            "last_auto_started_at": None,
            "last_success_at": None,
        }
    return {"account_email": email, **dict(row)}


def mark_history_gap(
    account_email: str,
    *,
    detected_at: datetime | None = None,
) -> dict[str, Any]:
    """새 gap은 열되, 아직 안 풀린 gap의 최초 감지 시각은 반복 폴로 덮지 않는다."""
    email = norm_email(account_email)
    if not email:
        return get_history_import_audit(email)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO history_import_audit(account_email,gap_detected_at) VALUES(?,?) "
            "ON CONFLICT(account_email) DO UPDATE SET "
            "gap_detected_at=CASE "
            "WHEN history_import_audit.gap_detected_at IS NOT NULL "
            "AND history_import_audit.gap_resolved_at IS NULL "
            "THEN history_import_audit.gap_detected_at ELSE excluded.gap_detected_at END, "
            "gap_resolved_at=NULL",
            (email, _iso(detected_at)),
        )
    return get_history_import_audit(email)


def claim_history_auto_start(
    account_email: str,
    cooldown_seconds: float,
    *,
    started_at: datetime | None = None,
) -> bool:
    """쿨다운 판정과 자동 시작 시각 기록을 한 쓰기 트랜잭션으로 묶는다."""
    email = norm_email(account_email)
    if not email:
        return False
    now = _utc_now(started_at)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT last_auto_started_at FROM history_import_audit WHERE account_email=?",
            (email,),
        ).fetchone()
        previous = _parse(row["last_auto_started_at"]) if row else None
        if previous and now < previous + timedelta(seconds=max(0.0, cooldown_seconds)):
            conn.execute("ROLLBACK")
            return False
        conn.execute(
            "INSERT INTO history_import_audit(account_email,last_auto_started_at) VALUES(?,?) "
            "ON CONFLICT(account_email) DO UPDATE SET last_auto_started_at=excluded.last_auto_started_at",
            (email, _iso(now)),
        )
    return True


def complete_history_import(
    account_email: str,
    *,
    completed_at: datetime | None = None,
) -> None:
    """cursor 끝까지 성공한 경우에만 현재 gap을 해소하고 최근 성공 시각을 전진시킨다."""
    email = norm_email(account_email)
    if not email:
        return
    completed = _iso(completed_at)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO history_import_audit(account_email,gap_resolved_at,last_success_at) "
            "VALUES(?,?,?) ON CONFLICT(account_email) DO UPDATE SET "
            "gap_resolved_at=CASE WHEN history_import_audit.gap_detected_at IS NOT NULL "
            "THEN excluded.gap_resolved_at ELSE history_import_audit.gap_resolved_at END, "
            "last_success_at=excluded.last_success_at",
            (email, completed, completed),
        )


def history_success_is_recent(
    account_email: str,
    max_age_seconds: float,
    *,
    now: datetime | None = None,
) -> bool:
    last = _parse(get_history_import_audit(account_email).get("last_success_at"))
    return bool(last and _utc_now(now) < last + timedelta(seconds=max(0.0, max_age_seconds)))
