"""서버 관리 창 '계정 정리' — 서버 PC 의 관리자만 쓴다(설계: docs/status/계정정리_서버관리창_2026-11-02.md).

로컬 허브는 이 경로를 중계하지 않는다(_proxy._LOCAL_PREFIXES) — 끈 서버는 404 로 끝난다.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..config import AUTH_ENABLED
from ..deps import actor_id, current_account, require_admin
from ..repo import account_cleanup
from ..repo.last_admin import LastAdminError
from ..services.request_guards import require_local_machine_request

router = APIRouter(prefix="/api/admin/account-cleanup", tags=["admin"])

# 이번 릴리스에서는 영구 삭제를 끈다 — 삭제와 이미 권한 검사를 지난 진행 중 쓰기의 경합이 주인 없는 행을 남길 수 있다
# (docs/status/배포전_수용항목_재검토수정_2026-11-03.md). 켜려면 쓰기 경로의 계정 재확인부터. 목록·판정·차단은 그대로다.
DELETE_ENABLED = False
DELETE_OFF_DETAIL = "이번 릴리스에서는 계정 삭제를 쓰지 않습니다 — 차단·숨김만 됩니다"


class AccountCleanupDeleteIn(BaseModel):
    email: str  # 경로에 넣지 않는다 — 가입 검사가 `/`·`?` 를 다 막지 않는다
    status: str
    hidden: bool
    created_at: str


def _require_console(request: Request) -> str:
    if not AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
    require_local_machine_request(request, "서버 PC 에서만 쓸 수 있습니다")
    require_admin(request)
    return (current_account(request) or {}).get("email") or ""


@router.get("")
def list_accounts(request: Request):
    return {"accounts": account_cleanup.list_cleanup_accounts(_require_console(request)), "delete_enabled": DELETE_ENABLED}


@router.post("/delete")
def delete_account(body: AccountCleanupDeleteIn, request: Request):
    actor_email = _require_console(request)  # 먼저 — 꺼져 있어도 허브는 404, 관리자가 아니면 401·403 그대로
    if not DELETE_ENABLED:
        raise HTTPException(status_code=409, detail=DELETE_OFF_DETAIL)
    try:
        return account_cleanup.delete_cleanup_account(
            body.email, status=body.status, hidden=body.hidden, created_at=body.created_at,
            actor_email=actor_email, actor_uid=actor_id(request),
        )
    except (account_cleanup.CleanupRefused, LastAdminError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
