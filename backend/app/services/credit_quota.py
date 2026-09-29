"""Personal quota advisory decision. Unknown authority never invents a balance."""

from __future__ import annotations

import math

UNAVAILABLE_WARNING = "개인 크레딧 한도를 확인하지 못했습니다. 생성을 허용하지만 한도를 초과할 수 있습니다."


def quota_decision(value: object, workspace_id: str) -> tuple[str | None, str | None]:
    """Return (block reason, warning); this is not a reservation or an exact spending cap."""
    if not isinstance(value, dict) or value.get("workspace_id") != workspace_id:
        return None, UNAVAILABLE_WARNING
    source = value.get("source")
    if source == "unlimited":
        return None, None
    if source == "unassigned":
        return None, "개인 크레딧 몫이 배정되지 않았습니다. 이번 생성에는 개인 한도 제한이 적용되지 않습니다."
    if source not in {"auto", "override"}:
        return None, UNAVAILABLE_WARNING
    quota, remaining = value.get("quota"), value.get("remaining")
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item)
           for item in (quota, remaining)) or quota < 0:
        return None, UNAVAILABLE_WARNING
    # Display rounding must not block a positive remainder smaller than 0.01 cr.
    exhausted = value.get("exhausted")
    is_exhausted = exhausted if isinstance(exhausted, bool) else remaining <= 0
    if is_exhausted:
        return "개인 크레딧 몫을 모두 사용했습니다. 매니저에게 한도 조정을 요청해 주세요.", None
    if value.get("unknown_count") or value.get("estimated_count"):
        return None, "개인 사용량에 견적 또는 미확인 기록이 있습니다. 실제 차감 반영 후 남은 크레딧이 달라질 수 있습니다."
    return None, None
