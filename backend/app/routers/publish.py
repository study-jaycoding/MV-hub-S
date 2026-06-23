"""선택 발행(publish) 라우터 — 로컬 허브 → 원격 공유 서버 (로컬 우선 모델).

각 작업자는 자기 PC 에서 허브를 띄워(Assets·생성이 로컬에서 동작) 작업하고, 고른 생성물만
'공유'를 누르면 이 라우터가 기존 번들 직렬화(repo.export_bundle)를 그대로 만들어 **공유 서버**로
HTTP POST → 거기서 repo.import_bundle_payload 로 멱등 병합. 공유 서버는 쓰기 후 WS 'synced' 를
broadcast → 그 서버를 띄운 팀원에게 실시간 반영. 미디어는 힉스필드 공개 URL 그대로(바이트 전송 없음).

엔드포인트 두 부류가 한 코드베이스에 공존(역할은 실행 모드로 갈림):
  · /api/share/publish-bundle  = **공유 서버**가 받는 입구(AUTH on 미들웨어가 보호).
  · /api/shared-server/*, /api/publish-to-shared = **로컬 허브**가 공유 서버로 보내는 클라이언트.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import repo
from ..config import DEFAULT_WORKER_ID

router = APIRouter(prefix="/api", tags=["publish"])

# app_setting 키 — 로컬 허브가 기억하는 공유 서버 연결 정보(이 PC 로컬 DB 에만 저장).
_K_URL = "shared_server_url"
_K_TOKEN = "shared_server_token"
_K_EMAIL = "shared_server_email"
_K_NAME = "shared_server_name"      # 로그인한 계정 표시이름(상태 표시용)
_K_ROLES = "shared_server_roles"    # 로그인한 계정 전역역할(JSON) — admin UI 게이트용

# 임시 관리자 권한(elevation) — 본인 계정은 유지한 채 admin 비번을 입력해 '승인 절차' 권한만
# 일시 획득. 이 토큰은 _proxy 가 계정관리(/api/auth/accounts*) 호출에만 쓴다. 로그아웃·계정전환 시 해제.
_K_ELEV_TOKEN = "shared_server_elev_token"
_K_ELEV_EMAIL = "shared_server_elev_email"
_K_ELEV_NAME = "shared_server_elev_name"


def _clear_elevation() -> None:
    for k in (_K_ELEV_TOKEN, _K_ELEV_EMAIL, _K_ELEV_NAME):
        repo.set_setting(k, None)

# 공유 서버 기본 주소 — 팀이 한 번 정해 배포(env 로 덮어쓰기). 로그인창은 이 값을 쓰고 주소칸을
# 숨긴다(작업자가 매번 안 적게). admin 은 관리자 창 '공유 서버' 탭에서 이 값을 바꿀 수 있다.
_DEFAULT_URL = (os.environ.get("CONTENT_HUB_SHARED_URL") or "http://192.168.1.199:8010").rstrip("/")


def _effective_url() -> str:
    return (repo.get_setting(_K_URL) or _DEFAULT_URL).rstrip("/")


def _roles() -> list[str]:
    raw = repo.get_setting(_K_ROLES)
    try:
        v = json.loads(raw) if raw else []
        return v if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


def _is_admin() -> bool:
    return "admin" in _roles()


def _http_json(
    method: str, url: str, token: Optional[str] = None, body: Optional[dict] = None,
    timeout: int = 60,
) -> tuple[int, Any]:
    """공유 서버로 보내는 stdlib HTTP(새 의존성 0). (status, parsed|text) 반환."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)
        except (ValueError, TypeError):
            pass
        return e.code, detail
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


# ── 공유 서버(수신 측) ──────────────────────────────────────────────────────
class PublishBundleIn(BaseModel):
    bundle: dict[str, Any]


@router.post("/share/publish-bundle")
def receive_published_bundle(body: PublishBundleIn, request: Request):
    """공유 서버 입구 — 로컬 허브가 보낸 번들을 받아 병합(받은 공유로 표식). 멱등(uuid 앵커).
    '누가 공유했나' = 발행한(인증된) 계정으로 확정 — provider 를 그 계정으로 덮어 share.shared_by
    가 발행자 본인이 되게 한다(역할도 그 계정 기준)."""
    bundle = body.bundle or {}
    if not isinstance(bundle.get("generations"), list):
        raise HTTPException(status_code=400, detail="번들 형식이 올바르지 않습니다")
    acc = getattr(request.state, "account", None)
    if acc:
        bundle = {
            **bundle,
            "provider": {
                "uid": acc.get("creator_uid") or acc.get("email"),
                "name": acc.get("name") or acc.get("email"),
                "email": acc.get("email"),
            },
        }
    counts = repo.import_bundle_payload(bundle, DEFAULT_WORKER_ID)
    return {"ok": True, **counts}


# ── 로컬 허브(발신 측) — 공유 서버 연결/설정 ────────────────────────────────
class SharedLoginIn(BaseModel):
    url: Optional[str] = None  # 비우면 기본/저장 주소 사용(로그인창은 주소를 숨김)
    email: str
    password: str


class SetUrlIn(BaseModel):
    url: str


def _shared_status() -> dict[str, Any]:
    elev_email = repo.get_setting(_K_ELEV_EMAIL)
    return {
        "configured": True,
        "url": _effective_url(),
        "email": repo.get_setting(_K_EMAIL),
        "name": repo.get_setting(_K_NAME),
        "roles": _roles(),
        "is_admin": _is_admin(),
        "has_token": bool(repo.get_setting(_K_TOKEN)),
        # 임시 관리자 권한 상태 — 본인이 admin 이 아니어도 승인 권한을 일시 보유 중인가.
        "elevated": bool(repo.get_setting(_K_ELEV_TOKEN)),
        "elevated_as": elev_email,
    }


@router.get("/shared-server/status")
def shared_server_status():
    return _shared_status()


@router.post("/shared-server/login")
def shared_server_login(body: SharedLoginIn):
    """공유 서버(팀 계정)에 로그인 → 세션 토큰을 이 PC 로컬 DB 에 저장(발행에 사용).
    로컬 신원을 이 계정으로 맞춰 작업·표기가 내 이름으로 뜨고 단일 신원이 된다."""
    url = (body.url or "").strip().rstrip("/") or _effective_url()
    status, resp = _http_json(
        "POST", f"{url}/api/auth/login", body={"email": body.email, "password": body.password}
    )
    if status != 200 or not isinstance(resp, dict) or not resp.get("token"):
        detail = resp.get("detail") if isinstance(resp, dict) else resp
        # detail 이 dict/list(서버 422 배열 등)면 문자열로 평탄화 — 그대로 두면 프론트에서
        # "[object Object]" 로 보인다.
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        raise HTTPException(status_code=400, detail=f"공유 서버 로그인 실패: {detail}")
    acc = resp.get("account") or {}
    repo.set_setting(_K_URL, url)
    repo.set_setting(_K_EMAIL, body.email)
    repo.set_setting(_K_TOKEN, resp["token"])
    repo.set_setting(_K_NAME, acc.get("name") or body.email)
    repo.set_setting(_K_ROLES, json.dumps(acc.get("global_roles") or []))
    _clear_elevation()  # 계정 전환 → 이전 사람의 임시 관리자 권한 해제(권한은 새로 로그인한 사람에게)
    try:
        repo.set_provider_name(acc.get("name") or body.email)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "account": acc, **_shared_status()}


class SharedRegisterIn(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


@router.post("/shared-server/register")
def shared_server_register(body: SharedRegisterIn):
    """공유 서버에 새 팀 계정 가입 — 작업자가 로컬 허브 로그인창에서 직접. 서버 규칙: 첫 계정은
    자동 admin 승인(토큰 발급) → 즉시 사용, 그 외는 승인대기(pending) → 관리자 승인 후 로그인.
    토큰이 오면(=첫 계정) 이 PC 로컬에 저장해 바로 로그인 상태가 된다."""
    url = _effective_url()
    status, resp = _http_json(
        "POST", f"{url}/api/auth/register",
        body={"email": body.email, "password": body.password, "name": body.name},
    )
    if status != 200 or not isinstance(resp, dict):
        detail = resp.get("detail") if isinstance(resp, dict) else resp
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        raise HTTPException(
            status_code=status if status >= 400 else 502, detail=f"공유 서버 가입 실패: {detail}"
        )
    acc = resp.get("account") or {}
    token = resp.get("token")
    if token:  # 첫 계정=admin 자동승인 → 바로 로그인 상태로 저장
        repo.set_setting(_K_URL, url)
        repo.set_setting(_K_EMAIL, body.email)
        repo.set_setting(_K_TOKEN, token)
        repo.set_setting(_K_NAME, acc.get("name") or body.email)
        repo.set_setting(_K_ROLES, json.dumps(acc.get("global_roles") or []))
        try:
            repo.set_provider_name(acc.get("name") or body.email)
        except Exception:  # noqa: BLE001
            pass
    return {
        "ok": True,
        "account": acc,
        "pending": (acc.get("status") == "pending"),
        "auto_logged_in": bool(token),
        **_shared_status(),
    }


@router.post("/shared-server/logout")
def shared_server_logout():
    """로그아웃 — 토큰·신원·임시권한을 지운다. 서버 주소(_K_URL)는 유지(다음 로그인창이 그대로 쓰게)."""
    for k in (_K_TOKEN, _K_EMAIL, _K_NAME, _K_ROLES):
        repo.set_setting(k, None)
    _clear_elevation()  # 로그아웃 → 임시 관리자 권한도 해제
    return {"ok": True, **_shared_status()}


class ElevateIn(BaseModel):
    email: str
    password: str


@router.post("/shared-server/elevate")
def shared_server_elevate(body: ElevateIn):
    """임시 관리자 권한 — 본인 로그인은 유지한 채 admin 계정 비번을 검증해 '승인 절차' 권한만
    일시 획득한다. 검증된 admin 토큰을 elev 슬롯에 저장하고, _proxy 가 계정관리(/api/auth/accounts*)
    호출에만 그 토큰을 쓴다. 로그아웃·계정전환 시 해제(다른 사람이 로그인하면 권한도 넘어감)."""
    url = _effective_url()
    status, resp = _http_json(
        "POST", f"{url}/api/auth/login", body={"email": body.email, "password": body.password}
    )
    if status != 200 or not isinstance(resp, dict) or not resp.get("token"):
        detail = resp.get("detail") if isinstance(resp, dict) else resp
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        raise HTTPException(status_code=400, detail=f"권한 부여 실패: {detail}")
    acc = resp.get("account") or {}
    roles = acc.get("global_roles") or []
    if "admin" not in roles:
        raise HTTPException(status_code=403, detail="관리자(admin) 계정이 아닙니다")
    repo.set_setting(_K_ELEV_TOKEN, resp["token"])
    repo.set_setting(_K_ELEV_EMAIL, body.email)
    repo.set_setting(_K_ELEV_NAME, acc.get("name") or body.email)
    return {"ok": True, "elevated_as": body.email, **_shared_status()}


@router.post("/shared-server/de-elevate")
def shared_server_de_elevate():
    """임시 관리자 권한 해제(수동)."""
    _clear_elevation()
    return {"ok": True, **_shared_status()}


@router.post("/shared-server/url")
def set_shared_url(body: SetUrlIn):
    """공유 서버 주소 변경 — 관리자 창 '공유 서버' 탭(admin 전용 UI). 이 PC 로컬 허브 설정값."""
    url = body.url.strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="주소를 입력하세요")
    repo.set_setting(_K_URL, url)
    return _shared_status()


# ── 로컬 허브(발신 측) — 선택 발행 ──────────────────────────────────────────
class PublishToSharedIn(BaseModel):
    gen_ids: list[str]


@router.post("/publish-to-shared")
def publish_to_shared(body: PublishToSharedIn):
    """고른 생성물만 공유 서버로 발행. 기존 번들 직렬화(export_bundle)를 그대로 HTTP 전송.
    성공 시 로컬에도 share 표식을 남겨(공유됨 뱃지) 어떤 걸 올렸는지 보이게 한다."""
    url = repo.get_setting(_K_URL) or _effective_url()
    token = repo.get_setting(_K_TOKEN)
    if not token:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 필요합니다")
    gen_ids = [g for g in (body.gen_ids or []) if g]
    if not gen_ids:
        raise HTTPException(status_code=400, detail="발행할 항목을 선택하세요")
    bundle = repo.export_bundle(gen_ids=gen_ids)
    if not (bundle.get("generations") or []):
        raise HTTPException(status_code=400, detail="발행할 유효한 생성물이 없습니다")
    status, resp = _http_json(
        "POST", f"{url}/api/share/publish-bundle", token=token, body={"bundle": bundle}
    )
    if status == 401:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 만료됐습니다(다시 로그인).")
    if status != 200 or not isinstance(resp, dict):
        raise HTTPException(status_code=502, detail=f"발행 실패(status={status}): {resp}")
    published = 0
    for gid in gen_ids:
        gen = repo.get_generation(gid)
        if gen and gen.get("status") == "done":
            repo.publish(gid, gen.get("worker_id") or DEFAULT_WORKER_ID, "team")
            published += 1
    if published:
        try:
            repo.write_my_share_file()
        except Exception:  # noqa: BLE001
            pass
    return {
        "ok": True,
        "published": published,
        "remote": {k: resp.get(k) for k in ("inserted", "updated", "unchanged", "skipped")},
    }
