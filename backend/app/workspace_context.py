"""워크스페이스 컨텍스트의 저장·전송 규격.

Higgsfield 생성 결과에는 workspace id가 포함되지 않으므로, 생성 요청/동기화가 알고 있는
컨텍스트를 별도 메타데이터로 보존한다. 레거시 데이터는 추측하지 않고 unknown으로 둔다.
"""

from __future__ import annotations

from typing import Any, Mapping


WORKSPACE_SCOPES = frozenset({"team", "personal", "unknown"})
UNKNOWN_WORKSPACE = {"scope": "unknown", "id": None, "name": None}


def normalize_workspace_context(value: Any = None) -> dict[str, str | None]:
    """dict/Pydantic/DB 형태를 정규화한 ``{scope,id,name}``으로 반환한다.

    team은 비어 있지 않은 id가 반드시 필요하다. 불완전하거나 알 수 없는 입력은 기존 결과를
    잘못된 워크스페이스로 분류하지 않도록 unknown으로 축소한다.
    """
    if value is None:
        return dict(UNKNOWN_WORKSPACE)
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    if not isinstance(value, Mapping):
        return dict(UNKNOWN_WORKSPACE)

    scope = str(value.get("scope") or value.get("workspace_scope") or "unknown").strip().lower()
    workspace_id = value.get("id") if "id" in value else value.get("workspace_id")
    workspace_name = value.get("name") if "name" in value else value.get("workspace_name")
    workspace_id = str(workspace_id).strip() if workspace_id is not None else None
    workspace_name = str(workspace_name).strip() if workspace_name is not None else None
    workspace_id = workspace_id or None
    workspace_name = workspace_name or None

    if scope not in WORKSPACE_SCOPES:
        return dict(UNKNOWN_WORKSPACE)
    if scope == "team":
        if not workspace_id:
            return dict(UNKNOWN_WORKSPACE)
        return {"scope": "team", "id": workspace_id, "name": workspace_name}
    if scope == "personal":
        return {"scope": "personal", "id": None, "name": workspace_name}
    return dict(UNKNOWN_WORKSPACE)


def workspace_columns(value: Any = None) -> tuple[str, str | None, str | None]:
    """DB의 ``workspace_scope, workspace_id, workspace_name`` 순서로 반환한다."""
    context = normalize_workspace_context(value)
    return context["scope"], context["id"], context["name"]
