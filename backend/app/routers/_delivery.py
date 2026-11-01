"""프로젝트로 옮기면 파일이 따라가야 하는 결과의 허브 쪽 입구 — 서버 판정을 못 지나는 미공유 결과까지 쓰기 전에 본다."""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from .. import active_account, db, rbac
from ..repo.asset_sync import UNDELIVERABLE_MESSAGE, pending_delivery
from . import _proxy


def require_hub_delivery(generation_ids: list[str], project_id: Optional[str]) -> None:
    """올릴 사람은 이 계정이다 — 그 프로젝트 역할이 없으면 서버도 로컬도 바꾸기 전에 막는다. 서버 불통·옛 서버면 지금처럼 로컬 이동을 허용한다."""
    if not project_id or not _proxy.proxying():
        return
    with db.get_connection() as conn:
        if not pending_delivery(conn, generation_ids, project_id):
            return
    try:
        members = _proxy.proxy_json("GET", f"/api/projects/{project_id}/members")
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(status_code=403, detail=UNDELIVERABLE_MESSAGE) from None
        return
    except Exception:  # noqa: BLE001 — 로컬 우선: 서버를 못 보면 정리는 막지 않는다
        return
    uid = active_account.active_uid()
    mine = next((row for row in members or [] if isinstance(row, dict) and row.get("uid") == uid), None)
    if not (mine and rbac.has_any_project_role(mine.get("roles") or [], *rbac.PROJECT_ROLES)):
        raise HTTPException(status_code=403, detail=UNDELIVERABLE_MESSAGE)
