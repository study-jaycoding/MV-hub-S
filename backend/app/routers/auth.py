"""인증 라우터 — 로그인/가입/세션 + 관리자 계정 승인 (로드맵 §4-1/§4-2).

가입은 자동 등록(pending), 첫 계정만 부트스트랩 관리자(approved/C0). 로그인은 승인된
계정만 토큰 발급. 관리자(C0/C1)는 가입 대기 계정을 승인/거부·등급 변경.
⚠️ enforcement(미들웨어)는 CONTENT_HUB_AUTH=1 일 때만. off 면 이 엔드포인트는 동작하되
   토큰 없이도 누구나 접근(개발). config 엔드포인트로 프론트가 모드를 안다.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from .. import repo
from ..config import AUTH_ENABLED
from ..deps import SESSION_COOKIE, require_admin, require_global_cap
from ..services import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = 14 * 24 * 3600  # 토큰 TTL 과 동일(2주)


def _set_session_cookie(response: Response, token: str) -> None:
    """세션 쿠키 발급 — /media·/ws(헤더 못 붙임)용. httpOnly(스크립트 접근 차단)·SameSite=Lax."""
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


class RegisterIn(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


class LoginIn(BaseModel):
    email: str
    password: str


class StatusIn(BaseModel):
    status: str  # approved | rejected | pending


class AccountGlobalRolesIn(BaseModel):
    global_roles: list[str]  # admin/product_director/production_director/member (복수)


class PasswordChangeIn(BaseModel):
    current: str  # 현재 비밀번호(본인 확인)
    password: str  # 새 비밀번호(6자 이상)


class HiddenIn(BaseModel):
    hidden: bool


@router.get("/config")
def auth_config():
    """프론트가 로그인 화면 표시 여부·부트스트랩 안내를 결정하는 데 쓴다."""
    return {"auth_enabled": AUTH_ENABLED, "has_accounts": repo.count_accounts() > 0}


@router.post("/register")
def register(body: RegisterIn, response: Response):
    try:
        acc = repo.register(body.email, body.password, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # 가입 즉시 생성자 연결 — 멤버 목록·프로젝트 배정 후보에 바로 뜨게(생성물 0이어도).
    repo.link_accounts_to_creators()
    acc = repo.get_account(acc["email"]) or acc
    # 첫 계정(부트스트랩 관리자)은 즉시 승인 → 바로 토큰 발급(자동 로그인) + 쿠키.
    token = auth.make_token(acc["email"]) if acc["status"] == "approved" else None
    if token:
        _set_session_cookie(response, token)
    return {"account": acc, "token": token}


@router.post("/login")
def login(body: LoginIn, response: Response):
    acc = repo.authenticate(body.email, body.password)
    if not acc:
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다")
    if acc["status"] == "pending":
        raise HTTPException(status_code=403, detail="관리자 승인 대기 중입니다")
    if acc["status"] != "approved":
        raise HTTPException(status_code=403, detail="접근이 거부된 계정입니다")
    token = auth.make_token(acc["email"])
    _set_session_cookie(response, token)  # /media·/ws 용 쿠키 동반 발급
    return {"account": acc, "token": token}


@router.post("/access")
def access(body: RegisterIn, response: Response):
    """로그인=가입 통합 — 힉스필드 이메일+비밀번호 하나로. 처음 보는 이메일이면 자동 등록(승인 대기),
    이미 있으면 로그인. 별도 '가입' 단계를 없앤다(계정 식별자 = 힉스필드 이메일). push_agent 는 여전히
    /login 사용. 반환: {account, token(승인 전이면 null), pending}."""
    email = (body.email or "").strip().lower()
    existing = repo.get_account(email)
    if existing:
        acc = repo.authenticate(email, body.password)
        if not acc:
            raise HTTPException(status_code=401, detail="비밀번호가 틀렸습니다")
        if acc["status"] != "approved":  # 승인 전(거부 포함) — 토큰 없이 상태만
            return {"account": acc, "token": None, "pending": acc["status"] == "pending"}
        token = auth.make_token(acc["email"])
        _set_session_cookie(response, token)
        return {"account": acc, "token": token, "pending": False}
    # 처음 보는 이메일 → 자동 등록(첫 계정=관리자+승인, 그 외=member/pending)
    try:
        acc = repo.register(email, body.password, body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    repo.link_accounts_to_creators()  # 멤버 목록·프로젝트 후보에 바로 뜨게
    acc = repo.get_account(acc["email"]) or acc
    token = auth.make_token(acc["email"]) if acc["status"] == "approved" else None
    if token:
        _set_session_cookie(response, token)
    return {"account": acc, "token": token, "pending": acc["status"] == "pending"}


@router.get("/me")
def me(request: Request):
    """현재 세션의 계정. 미들웨어가 채운 request.state.account 사용."""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return acc


@router.post("/logout")
def logout(response: Response):
    """토큰은 무상태라 서버 저장이 없다 — 클라이언트가 토큰을 버리고 세션 쿠키를 지운다."""
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ── 관리자: 계정 승인·등급 ───────────────────────────────────────────────────
@router.get("/accounts")
def list_accounts(request: Request, status: Optional[str] = None, include_hidden: bool = False):
    require_admin(request)
    return repo.list_accounts(status, include_hidden=include_hidden)


@router.patch("/accounts/{email}/status")
def set_status(email: str, body: StatusIn, request: Request):
    require_admin(request)
    try:
        acc = repo.set_account_status(email, body.status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return acc


@router.patch("/accounts/{email}/global-roles")
def set_global_roles(email: str, body: AccountGlobalRolesIn, request: Request):
    """v02 전역 역할(복수) 부여 — grant_global 역량(admin)만. enforcement 가 읽는 축."""
    require_global_cap(request, "grant_global")
    acc = repo.set_account_global_roles(email, body.global_roles)
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return acc


@router.post("/me/password")
def change_my_password(body: PasswordChangeIn, request: Request):
    """본인 비밀번호 변경 — 현재 비밀번호로 본인 확인 후 변경. (에이전트 로그인에도 같은 비번.)"""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    if not repo.authenticate(acc["email"], body.current):
        raise HTTPException(status_code=401, detail="현재 비밀번호가 올바르지 않습니다")
    try:
        if not repo.set_password(acc["email"], body.password):
            raise HTTPException(status_code=404, detail="없는 계정")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


class NameIn(BaseModel):
    name: str


@router.post("/me/name")
def change_my_name(body: NameIn, request: Request):
    """본인 표시이름 변경(계정별 — 전역 provider 와 무관). creator.name 에도 미러 →
    멤버·작성자 표기를 표시이름으로 일관(UI 는 절대 uid 를 보이지 않음)."""
    acc = getattr(request.state, "account", None)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    updated = repo.set_account_name(acc["email"], body.name)
    if not updated:
        raise HTTPException(status_code=404, detail="없는 계정")
    return updated


@router.post("/accounts/{email}/reset-password")
def reset_password(email: str, request: Request):
    """관리자: 그 계정 비밀번호를 기본값 111111 로 초기화."""
    require_admin(request)
    try:
        acc = repo.set_password(email, "111111")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return {"ok": True, "account": acc}


@router.patch("/accounts/{email}/hidden")
def set_hidden(email: str, body: HiddenIn, request: Request):
    """관리자: 계정 숨김/표시 토글. 자기 계정은 숨길 수 없다(잠금 방지)."""
    require_admin(request)
    me = getattr(request.state, "account", None)
    if body.hidden and me and (me.get("email") or "").lower() == email.strip().lower():
        raise HTTPException(status_code=400, detail="자기 계정은 숨길 수 없습니다")
    acc = repo.set_account_hidden(email, body.hidden)
    if not acc:
        raise HTTPException(status_code=404, detail="없는 계정")
    return acc
