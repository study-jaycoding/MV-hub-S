"""프로젝트로 옮기면 파일이 따라가야 하는 결과의 허브 쪽 입구 — 서버 판정을 못 지나는 미공유 결과까지 쓰기 전에 본다."""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from .. import active_account, db, rbac
from ..repo.asset_sync import UNDELIVERABLE_MESSAGE, pending_delivery
from ..services import asset_backfill
from . import _proxy


def require_hub_delivery(generation_ids: list[str], project_id: Optional[str]) -> bool:
    """올릴 사람은 이 계정이다 — 그 프로젝트 역할이 없으면 서버도 로컬도 바꾸기 전에 막는다.
    서버 불통·옛 서버면 로컬 이동을 허용하고 거짓을 돌려준다(화면이 전달을 확인하지 못했다고 알린다)."""
    if not project_id or not _proxy.proxying():
        return True
    with db.get_connection() as conn:
        if not pending_delivery(conn, generation_ids, project_id):
            return True
    try:
        members = _proxy.proxy_json("GET", f"/api/projects/{project_id}/members")
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(status_code=403, detail=UNDELIVERABLE_MESSAGE) from None
        return False
    except Exception:  # noqa: BLE001 — 로컬 우선: 서버를 못 보면 정리는 막지 않는다
        return False
    uid = active_account.active_uid()
    mine = next((row for row in members or [] if isinstance(row, dict) and row.get("uid") == uid), None)
    if not (mine and rbac.has_any_project_role(mine.get("roles") or [], *rbac.PROJECT_ROLES)):
        raise HTTPException(status_code=403, detail=UNDELIVERABLE_MESSAGE)
    return True


def delivery_notice(generation_ids: list[str], project_id: Optional[str], verified: bool) -> dict:
    """이동 응답에 더할 칸 — 막지 않고 화면이 알리게 한다. 문제가 없으면 빈 사전이다."""
    if not project_id or not _proxy.proxying():
        return {}
    notice: dict = {} if verified else {"delivery_unverified": True}
    missing = asset_backfill.missing_files(generation_ids, project_id)
    if missing:
        notice["missing_files"] = missing
    return notice
