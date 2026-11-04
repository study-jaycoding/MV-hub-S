"""팀 comfy.org API 키 — 관리자 등록(서버 PC 관리 창)과 팀원 허브의 받아 가기.

계약: docs/status/Comfy팀키_서버배포_2026-11-04.md. 둘 다 _proxy._LOCAL_PREFIXES 에 있어 로컬 허브는 서버로
중계하지 않고 자기 404 로 끝낸다(AUTH off). 허브 백엔드만 services/comfy_team_key 로 서버에 직접 묻는다.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from ..config import AUTH_ENABLED
from ..deps import assert_account_current, current_account, require_admin
from ..services import comfy_team_key as store
from ..services.request_guards import require_local_machine_request

router = APIRouter(tags=["comfy-team-key"])

ADMIN_PATH = "/api/admin/comfy-team-key"
TEAM_PATH = store.TEAM_KEY_PATH
KEY_MAX = 512


def _require_console(request: Request) -> str:
    """account_cleanup 과 같은 게이트 — AUTH off 404, 서버 PC 로컬 요청, 관리자."""
    if not AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
    require_local_machine_request(request, "서버 PC 에서만 쓸 수 있습니다")
    require_admin(request)
    return (current_account(request) or {}).get("email") or ""


@router.get(ADMIN_PATH)
def admin_get(request: Request):
    _require_console(request)
    return store.public_meta(store.read_store())


@router.put(ADMIN_PATH)
async def admin_put(request: Request):
    actor = _require_console(request)
    # 본문은 손으로 읽는다 — pydantic 의 422 기본 응답은 실패한 입력값(키)을 그대로 되돌려 준다
    try:
        body = await request.json()
    except ValueError:
        body = None
    key = body.get("api_key") if isinstance(body, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise HTTPException(status_code=400, detail="빈 키는 등록할 수 없습니다(api_key 문자열)")
    if len(key.strip()) > KEY_MAX:
        raise HTTPException(status_code=400, detail=f"키가 너무 깁니다({KEY_MAX}자 넘음)")
    try:
        return store.save_store(key, actor)
    except store.ProtectError as error:
        raise HTTPException(status_code=409, detail=f"이 PC 에서 키를 암호화할 수 없어 저장하지 않았습니다: {error}") from error


@router.delete(ADMIN_PATH)
def admin_delete(request: Request):
    actor = _require_console(request)
    return store.clear_store(actor)


@router.get(TEAM_PATH)
def team_get(request: Request, response: Response):
    """승인 계정의 Bearer 로만. 응답은 캐시 금지, 로그에는 계정·시각만."""
    if not AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
    account = current_account(request)
    if not account:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    assert_account_current(account)  # 대기·차단·지워진 계정은 401
    item = store.read_store()
    response.headers["Cache-Control"] = "no-store"
    if item["state"] == "undecryptable":
        raise HTTPException(status_code=409, detail="서버의 팀 키를 풀 수 없습니다 — 관리자가 다시 등록해야 합니다")
    if item["state"] != "ok":
        raise HTTPException(status_code=404, detail="등록된 팀 키가 없습니다")
    store.log.info("팀 Comfy 키 조회 by=%s revision=%s", account.get("email"), item["revision"])
    return {"api_key": item["api_key"], "revision": item["revision"], "updated_at": item["updated_at"]}
