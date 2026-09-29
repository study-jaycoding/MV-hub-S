"""Authenticated personal allowance, always from the shared authority when proxied."""

from fastapi import APIRouter, HTTPException, Query, Request

from .. import repo
from ..config import AUTH_ENABLED
from ..deps import current_account
from ..emailnorm import norm_email
from . import _proxy

router = APIRouter()


@router.get("/credit-plan/my-quota")
def my_credit_quota(request: Request, workspace_id: str = Query(min_length=1, max_length=128)):
    if _proxy.proxying():
        return _proxy.proxy_json("GET", "/api/manage/credit-plan/my-quota",
                                 params={"workspace_id": workspace_id}, timeout=5)
    if not AUTH_ENABLED:
        return {
            "workspace_id": workspace_id, "source": "unavailable", "group_id": None,
            "group_name": None, "quota": None, "used_real": 0, "used_estimated": 0,
            "estimated_count": 0, "unknown_count": 0, "used": 0, "remaining": None, "exhausted": False,
            "limit_period": None, "period_start": None, "period_end": None,
            "revision": 0, "enforcement": "advisory",
        }
    account = current_account(request) or {}
    email = norm_email(account.get("email"))
    if not email or not any(item["id"] == workspace_id for item in repo.list_workspace_options(member_email=email)):
        raise HTTPException(status_code=403, detail="이 워크스페이스의 멤버가 아닙니다")
    from ..repo.manage_quota import my_quota

    return my_quota(workspace_id, email)
