"""Personal advisory quota, using the existing allocation and usage contracts."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .. import manage_db
from ..db import get_connection
from ..emailnorm import norm_email
from . import manage_credit_plan as credit_plan
from .manage_schema import _ensure_schema


_KST = timezone(timedelta(hours=9))


def my_quota(workspace_id: str, email: str) -> dict[str, Any]:
    """Read one member's quota; unavailable data raises for the HTTP policy to handle."""
    email = norm_email(email or "")
    today = credit_plan.today_local()
    with get_connection() as conn:
        _ensure_schema(conn)
        if not conn.in_transaction:
            conn.execute("BEGIN")
        plan, groups, members, _, quotas = credit_plan._load(conn, workspace_id)

    group = next((g for g in groups if email in members.get(g["id"], set())), None)
    result: dict[str, Any] = {
        "workspace_id": workspace_id,
        "source": "unassigned",
        "group_id": None,
        "group_name": None,
        "quota": None,
        "used_real": 0.0,
        "used_estimated": 0.0,
        "estimated_count": 0,
        "unknown_count": 0,
        "used": 0.0,
        "remaining": None,
        "exhausted": False,
        "limit_period": None,
        "period_start": None,
        "period_end": None,
        "revision": int(plan["revision"]) if plan else 0,
        "enforcement": "advisory",
    }
    if group is None:
        return result

    quota, source = credit_plan._member_quota(email, group, members[group["id"]], quotas)
    period = credit_plan._group_period(group)
    anchor = credit_plan._plan_anchor(plan)
    start = datetime.fromisoformat(credit_plan.period_start(today, period, anchor)).replace(tzinfo=_KST)
    end = (
        datetime.fromisoformat(credit_plan.period_end(today, period, anchor)).replace(tzinfo=_KST)
        + timedelta(days=1)
    )

    # upsert_facts owns job deduplication. Like workspace_email_usage, include
    # tombstones and failed/pending estimates, but never add an estimate to real usage.
    with manage_db.get_connection() as conn:
        usage = conn.execute(
            "SELECT COALESCE(SUM(real_credits), 0) AS used_real, "
            "COALESCE(SUM(CASE WHEN real_credits IS NULL THEN est_credits ELSE 0 END), 0) "
            "AS used_estimated, "
            "COUNT(CASE WHEN real_credits IS NULL AND est_credits IS NOT NULL THEN 1 END) "
            "AS estimated_count, "
            "COUNT(CASE WHEN real_credits IS NULL AND est_credits IS NULL THEN 1 END) "
            "AS unknown_count "
            "FROM team_generation_fact "
            "WHERE workspace_scope='team' AND workspace_id=? AND account_email=? "
            "AND julianday(created_at) >= julianday(?) "
            "AND julianday(created_at) < julianday(?)",
            (workspace_id, email, start.isoformat(), end.isoformat()),
        ).fetchone()

    used_real = float(usage["used_real"])
    used_estimated = float(usage["used_estimated"])
    used = used_real + used_estimated
    result.update(
        source={"manual": "override", "auto": "auto", "none": "unlimited"}[source],
        group_id=group["id"],
        group_name=group["name"],
        quota=None if quota is None else credit_plan._shown(quota),
        used_real=credit_plan._shown(used_real),
        used_estimated=credit_plan._shown(used_estimated),
        estimated_count=int(usage["estimated_count"]),
        unknown_count=int(usage["unknown_count"]),
        used=credit_plan._shown(used),
        remaining=None if quota is None else credit_plan._shown(quota - used),
        exhausted=quota is not None and quota <= used,
        limit_period=period,
        period_start=start.isoformat(),
        period_end=end.isoformat(),
    )
    return result
