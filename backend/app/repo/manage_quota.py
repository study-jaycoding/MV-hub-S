"""Personal advisory quota, using the existing allocation and usage contracts."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

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
        plan, groups, members, topups, quotas = credit_plan._load(conn, workspace_id)
        derived_topup = credit_plan._monthly_budget(conn, workspace_id)
        anchor = credit_plan._plan_anchor(plan)
        group = next((g for g in groups if email in members.get(g["id"], set())), None)
        snapshot = credit_plan.usage_snapshot(conn, workspace_id, today, groups, anchor) if group else None

    def pool_total() -> float | None:
        # 내 몫이 없으면 계정 메뉴가 워크스페이스 잔액을 '이번 충전 달에 채운 총량'에 대어 고리로 그린다
        # (Jay 2026-09-29). 총량 = 정기 충전(손 입력, 없으면 프로젝트 매월 예산 합) + 이번 달 긴급 충전.
        # 몫이 있는 사람에게는 주지 않는다(충전 정보는 필요한 경우에만 멤버에게 보인다).
        if credit_plan._plan_auto(plan) and credit_plan._plan_period(plan) != "month":
            # 서브스페이스는 정기 크레딧을 매주·매일로도 준다 — '이번 달에 한 번'으로 셈하면 총량이 틀리므로 고리를 그리지 않는다
            # (잔액 숫자는 그대로 보인다, Codex 병합 검토 ③ 최소안).
            return None
        recurring = credit_plan._plan_recurring(plan)
        monthly = recurring if recurring is not None else derived_topup
        cycle_start = credit_plan.period_start(today, "month", anchor)
        cycle_end = credit_plan.period_end(today, "month", anchor)
        emergency = credit_plan._topup_summary(topups, cycle_start, cycle_end)["credits"]
        if monthly is None and not emergency:
            return None
        return credit_plan._shown(float(monthly or 0) + float(emergency))

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
        "pool_total": None,
        "usage_supported": True,
    }
    if group is None:
        # 그룹에 들지 않은 사람도 기본으로 워크스페이스 남은 크레딧을 본다(Jay 2026-09-29).
        result["pool_total"] = pool_total()
        return result

    quota, source = credit_plan._member_quota(email, group, members[group["id"]], quotas)
    period = credit_plan._group_period(group)
    start = datetime.fromisoformat(credit_plan.period_start(today, period, anchor)).replace(tzinfo=_KST)
    end = (
        datetime.fromisoformat(credit_plan.period_end(today, period, anchor)).replace(tzinfo=_KST)
        + timedelta(days=1)
    )

    usage = snapshot.total(workspace_id, email, int(start.timestamp()*1000), int(end.timestamp()*1000))
    result.update(credit_plan.usage_metadata(usage))
    for key in ('failed_count', 'failed_refunded_count', 'refunded', 'overdue_pending_count'):
        result[key] = usage[key]

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
    if quota is None:  # 그룹 한도가 없으면 내 몫이 없다 — 미배정과 같이 워크스페이스 잔액을 본다
        result["pool_total"] = pool_total()
    return result
