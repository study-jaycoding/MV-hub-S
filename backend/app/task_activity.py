"""작업 보관용 배치 시각. 생성 원문 날짜와 수신/조회 시각은 변경하지 않는다."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from .workspace_context import workspace_columns


def _utc_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def task_activity_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def normalize_task_activity_at(value: Any) -> str | None:
    """naive 시각은 UTC로 읽고, 잘못된 값/5분 넘는 미래 시각은 버린다."""
    parsed = _utc_datetime(value)
    if parsed is None or parsed > datetime.now(timezone.utc) + timedelta(minutes=5):
        return None
    return parsed.isoformat(timespec="microseconds").replace("+00:00", "Z")


def latest_task_activity_at(created_at: Any, activity_at: Any, sort_ts: Any = None) -> str | None:
    """숫자 UTC 비교로 최신 활동을 고르되 기존 생성일이 최신이면 원문을 보존한다."""
    created = _utc_datetime(created_at)
    created_value = created_at if created is not None else None
    if created is None and sort_ts is not None and not isinstance(sort_ts, bool):
        try:
            stamp = float(sort_ts)
            if math.isfinite(stamp):
                created = datetime.fromtimestamp(stamp, timezone.utc)
                created_value = created.isoformat()
        except (ValueError, TypeError, OverflowError, OSError):
            pass
    normalized = normalize_task_activity_at(activity_at)
    activity = _utc_datetime(normalized)
    if activity is not None and (created is None or activity > created):
        return normalized
    return created_value


def task_location_key(value: Mapping[str, Any]) -> tuple:
    """이름이 아닌 실제 귀속만 비교한다. 경로 표기만 다른 재전송은 이동이 아니다."""
    scope, wid, _ = workspace_columns(value)
    folder = "/".join(
        part for raw in str(value.get("folder_path") or "").replace("\\", "/").split("/")
        if (part := raw.strip()) and part not in (".", "..")
    ) or None
    return scope, wid, str(value.get("project_id") or "").strip() or None, folder


def merge_task_activity_location(existing: Mapping[str, Any] | None, incoming: dict) -> dict:
    """명시 시각 없는 위치 변경에는 옛 위치 활동을 복사하지 않는다.

    시각이 확인된 지연 전송은 위치/시각을 함께 보존하고, 같은 위치의 구버전 전송은
    이미 알고 있는 활동 시각을 지우지 않는다. 최초 수신 시 현재 시각을 만들지 않는다.
    """
    result = dict(incoming)
    new_stamp = normalize_task_activity_at(result.get("task_activity_at"))
    old_stamp = normalize_task_activity_at(existing.get("task_activity_at")) if existing else None
    same_location = existing is not None and task_location_key(existing) == task_location_key(result)
    if old_stamp and new_stamp and new_stamp < old_stamp:
        if not same_location:
            for field in (
                "workspace_scope", "workspace_id", "workspace_name", "project_id",
                "project_name", "folder_path",
            ):
                result[field] = existing.get(field)
        result["task_activity_at"] = old_stamp
    elif same_location and new_stamp is None:
        result["task_activity_at"] = old_stamp
    else:
        result["task_activity_at"] = new_stamp
    return result
