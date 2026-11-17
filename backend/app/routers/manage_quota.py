"""Authenticated personal allowance, always from the shared authority when proxied."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from .. import repo
from ..config import AUTH_ENABLED
from ..deps import current_account
from ..emailnorm import norm_email
from . import _proxy

router = APIRouter()


@router.get('/credit-plan/my-usage')
def my_credit_usage(request: Request, workspace_id: str = Query(min_length=1, max_length=128),
                    range: Literal['today','week','period','previous'] = 'period',
                    space: Literal['this','all'] = 'this'):
    if _proxy.proxying():
        return _proxy.proxy_json('GET', '/api/manage/credit-plan/my-usage',
                                 params={'workspace_id': workspace_id, 'range': range, 'space': space}, timeout=5)
    if not AUTH_ENABLED:
        return dict(workspace_id=workspace_id, basis_workspace_id=workspace_id, workspace_ids=[], range=range, space=space,
                    basis='unavailable', basis_reason='authentication_unavailable',
                    as_of_ms=None, coverage_end_ms=None, collected_at_ms=None, period_start_ms=None, period_end_ms=None,
                    used=None, used_real=None, used_estimated=None, refunded=None, generation_count=None,
                    failed_count=None, fully_refunded_count=None, failed_refunded_count=None,
                    estimated_count=None, unknown_count=None, overdue_pending_count=None, pending_count=None,
                    rows=[], sources=[],
                    total_count=0, returned_count=0, truncated=False)
    account = current_account(request) or {}
    email = norm_email(account.get('email'))
    if not email:
        raise HTTPException(status_code=403, detail='인증 계정을 확인할 수 없습니다')
    from ..usecases.hf_org_usage import my_usage
    try:
        return my_usage(workspace_id, email, range, space)
    except PermissionError:
        raise HTTPException(status_code=403, detail='이 워크스페이스의 멤버가 아닙니다') from None


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
            "revision": 0, "enforcement": "advisory", "pool_total": None,
        }
    account = current_account(request) or {}
    email = norm_email(account.get("email"))
    if not email or not any(item["id"] == workspace_id for item in repo.list_workspace_options(member_email=email)):
        raise HTTPException(status_code=403, detail="이 워크스페이스의 멤버가 아닙니다")
    from ..repo.manage_quota import my_quota

    return my_quota(workspace_id, email)
