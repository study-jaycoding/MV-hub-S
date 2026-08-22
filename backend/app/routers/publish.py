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
import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import _proxy
from .. import active_account, db, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ._telemetry import touch_generation_telemetry
from ..deps import actor_id, require_edit_generation
from ..repo import identity
from ..services import agent_signals
from ..services.request_guards import require_loopback_request
from ..services.event_journal import journal_audit_event
from ..services.share_state_reconciler import kick_share_state_reconciler

router = APIRouter(prefix="/api", tags=["publish"])


# 단일 정의로 통합(_telemetry.touch_generation_telemetry) — share.py 와 복붙돼 있던 것.
_touch_telemetry = touch_generation_telemetry


def _switch_account_db(email: str, uid: Optional[str]) -> None:
    """로컬 프록시 로그인/전환 — 활성 계정 포인터를 이 계정으로 바꾸고 그 계정 전용 DB 를 준비한다.
    이후 모든 set_setting/get_setting·읽기쓰기가 그 계정 DB 로 향해 다른 계정과 데이터가 섞이지 않는다.
    공유 서버(AUTH on)에선 계정별 DB 를 쓰지 않으므로 아무것도 하지 않는다(이 메커니즘은 로컬 전용)."""
    if AUTH_ENABLED:
        return
    active_account.set_active(email, uid)
    db.ensure_account_db(email, uid)
    identity._MY_UID_CACHE[0] = None  # 새 DB 기준으로 is_mine 재계산
    # 에이전트를 깨워 이 계정 DB 로 재동기화·계정상태 재보고 — 로그인 전(레거시 DB)에 보고된 워크스페이스
    # 상태가 새 계정 DB 엔 없어 '미연결'로 보이던 것을 곧 채운다(+ 로컬 생성물도 이 DB 로 다시 적재).
    # 로컬 에이전트는 AUTH-off 라 'local' 신원으로 대기한다(_agent_acc 폴백과 동일).
    try:
        agent_signals.signal("local", "sync")
    except Exception:  # noqa: BLE001 — 에이전트 미가동이어도 로그인은 진행
        pass

# 연결 정보(URL·토큰 키·기본 주소·조회 규칙)는 services/shared_connection 단일 출처.
# 이메일/이름/역할 등 로그인 표시용 키만 이 라우터 소유로 남긴다.
from ..services.shared_connection import (  # noqa: E402
    K_ELEV_TOKEN as _K_ELEV_TOKEN,
    K_TOKEN as _K_TOKEN,
    K_URL as _K_URL,
    base_url as _effective_url,
)

_K_EMAIL = "shared_server_email"
_K_NAME = "shared_server_name"      # 로그인한 계정 표시이름(상태 표시용)
_K_ROLES = "shared_server_roles"    # 로그인한 계정 전역역할(JSON) — admin UI 게이트용

# 임시 관리자 권한(elevation) — 본인 계정은 유지한 채 admin 비번을 입력해 '승인 절차' 권한만
# 일시 획득. 이 토큰은 _proxy 가 계정관리(/api/auth/accounts*) 호출에만 쓴다. 로그아웃·계정전환 시 해제.
_K_ELEV_EMAIL = "shared_server_elev_email"
_K_ELEV_NAME = "shared_server_elev_name"


def _clear_elevation() -> None:
    for k in (_K_ELEV_TOKEN, _K_ELEV_EMAIL, _K_ELEV_NAME):
        repo.set_setting(k, None)

# 임시 관리자 권한(elevation) 기본 관리자 계정 — 모달이 짧은 id "admin" 을 받으면 이 이메일로 매핑.
_ADMIN_EMAIL = (os.environ.get("CONTENT_HUB_ADMIN_EMAIL") or "admin@millionvolt.com").strip()


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
    """공유 서버로 보내는 stdlib HTTP(새 의존성 0). (status, parsed|text) 반환.
    저수준 구현은 _proxy.raw_request 와 공유(중복 제거) — 로그인/가입/elevate 가 status 를 직접 본다."""
    return _proxy.raw_request(method, url, token=token, body=body, timeout=timeout)


def _flatten_detail(resp: Any) -> str:
    """서버 응답에서 사람이 읽을 detail 문자열을 뽑는다. dict/list(422 배열 등)면 JSON 으로 평탄화 —
    그대로 두면 프론트에서 '[object Object]' 로 보인다."""
    detail = resp.get("detail") if isinstance(resp, dict) else resp
    return detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)


# ── 공유 서버(수신 측) ──────────────────────────────────────────────────────
class PublishBundleIn(BaseModel):
    bundle: dict[str, Any]


def _single_bundle_creator_uid(bundle: dict[str, Any]) -> Optional[str]:
    """발행 번들 안의 실제 Higgsfield 작성자 uid가 단일하면 반환.
    계정이 아직 acct:<email> 상태일 때 이 uid로 연결해 '내 공유물' 판별을 맞춘다."""
    uids: set[str] = set()
    for item in bundle.get("generations") or []:
        if not isinstance(item, dict):
            continue
        gen = item.get("generation") or {}
        uid = (gen.get("creator_uid") or "").strip()
        if uid:
            uids.add(uid)
        if len(uids) > 1:
            return None
    return next(iter(uids), None)


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
        bundle_uid = _single_bundle_creator_uid(bundle)
        acc_uid = acc.get("creator_uid")
        # 신원 바인딩 가드(번들은 클라이언트 값이라 신뢰 최소화):
        #  ① 힉스필드 실제 uid 형식(user_*)만 — 합성 acct:·임의 문자열로 계정을 묶지 않는다.
        #  ② 이미 다른 계정에 연결된 uid 면 스킵(남의 신원 도용 방지). 둘 다 실패해도 발행은 계속.
        # ※근본 한계: 서버엔 CLI 가 없어 uid 실소유를 힉스필드로 검증할 수 없다(설계상 push 신뢰).
        if bundle_uid and (not acc_uid or str(acc_uid).startswith("acct:")):
            owner = repo.uid_owner_email(bundle_uid)
            if not bundle_uid.startswith("user_"):
                logging.getLogger(__name__).warning(
                    "번들 uid 바인딩 거부: %s 는 힉스필드 uid 형식(user_*)이 아님", bundle_uid,
                )
            elif owner and owner != acc["email"]:
                logging.getLogger(__name__).warning(
                    "번들 uid 바인딩 거부: %s 는 이미 %s 계정 소유(요청 계정=%s)",
                    bundle_uid, owner, acc["email"],
                )
            else:
                repo.set_account_hf_creator(acc["email"], bundle_uid)
                acc = repo.get_account(acc["email"]) or {**acc, "creator_uid": bundle_uid}
        bundle = {
            **bundle,
            "provider": {
                "uid": acc.get("creator_uid") or acc.get("email"),
                "name": acc.get("name") or acc.get("email"),
                "email": acc.get("email"),
            },
        }
    counts = repo.import_bundle_payload(bundle, DEFAULT_WORKER_ID)
    # 공유 서버의 정식 발행 입구는 개별 publish 라우트가 아니라 이 번들 수신이다.
    # 따라서 운영자가 나중에 "누가 어떤 생성물을 공유했나"를 복원할 수 있도록 여기서
    # 요청 단위 감사 이력을 남긴다. 500개 전체를 빠뜨리지 않되 DB 쓰기는 50개 묶음으로 제한한다.
    anchors: list[str] = []
    seen_anchors: set[str] = set()
    for item in bundle.get("generations") or []:
        generation = item.get("generation") if isinstance(item, dict) else None
        if not isinstance(generation, dict):
            continue
        anchor = str(generation.get("id") or "").strip()
        if anchor and anchor not in seen_anchors:
            seen_anchors.add(anchor)
            anchors.append(anchor)
    for offset in range(0, len(anchors), 50):
        chunk = anchors[offset : offset + 50]
        journal_audit_event(
            "generation.publish_bundle_received",
            actor_uid=actor_id(request),
            target_type="generation_batch",
            target_id=chunk[0] if len(anchors) == 1 else None,
            fields=["shared"],
            details={
                "shared": True,
                "generation_ids": chunk,
                "item_count": len(anchors),
                "chunk_index": offset // 50,
                "inserted": int(counts.get("inserted") or 0),
                "updated": int(counts.get("updated") or 0),
            },
        )
    # 공유 서버도 받은 원본을 보존한다. 번들에는 원격 URL만 오므로 서버 측 byte-cache가
    # 없으면 CDN 만료 뒤 팀 공유본 전체가 깨진다. ID/job_id 양쪽을 해석해 멱등 등록한다.
    # 항목별 resolve+get(3N DB 진입)을 앞서 만든 anchors 의 배치 해석 1회로(R7 2-F) —
    # 보존 큐 등록(쓰기)만 항목별 유지.
    resolved_meta = repo.resolve_generation_meta_batch(anchors)
    for anchor in anchors:
        meta = resolved_meta.get(anchor)
        if meta and meta.get("id"):
            repo.request_media_preservation(meta["id"], "shared")
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


def _require_local_shared_connection(request: Request) -> None:
    """공유 서버 '연결 설정'(상태·로그인·토큰·elevation·주소)은 이 PC 브라우저 전용
    (R7 0-A, 코덱스 P1) — 원격 계정이 서버 공용 설정·토큰을 읽거나 바꾸는 간섭과
    login body.url SSRF 를 차단한다. 발행 '데이터' 경로(/share/publish-bundle·
    /publish-to-shared)는 대상이 아니다. ★호환성: LAN 직결·역프록시에선 이 7개가 403."""
    require_loopback_request(
        request, "공유 서버 연결 설정은 해당 PC 브라우저에서만 사용할 수 있습니다"
    )


def _normalize_shared_url(raw: str) -> str:
    """공유 서버 주소 정규화(R7 0-A) — http/https+호스트 필수, 사설 IP·localhost 허용
    (팀 서버는 LAN 이 정상). userinfo·query·fragment 는 거부(토큰이 이상 주소로 새는 것
    방지). 실패는 외부 요청 '전에' 400."""
    from urllib.parse import urlsplit

    url = (raw or "").strip().rstrip("/")
    if not url:
        raise HTTPException(status_code=400, detail="주소를 입력하세요")
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="주소 형식이 올바르지 않습니다") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(
            status_code=400, detail="http(s)://호스트 형식의 주소가 필요합니다"
        )
    if parts.username or parts.password or parts.query or parts.fragment:
        raise HTTPException(
            status_code=400, detail="주소에 계정 정보·쿼리를 포함할 수 없습니다"
        )
    return url


def _validated_effective_url() -> str:
    """저장된 공유 서버 주소도 같은 정규화를 통과시켜 사용(register/elevate 재사용 경로)."""
    return _normalize_shared_url(_effective_url())


@router.get("/shared-server/status")
def shared_server_status(request: Request):
    _require_local_shared_connection(request)
    return _shared_status()


@router.post("/shared-server/login")
def shared_server_login(body: SharedLoginIn, request: Request):
    """공유 서버(팀 계정)에 로그인 → 세션 토큰을 이 PC 로컬 DB 에 저장(발행에 사용).
    로컬 신원을 이 계정으로 맞춰 작업·표기가 내 이름으로 뜨고 단일 신원이 된다."""
    _require_local_shared_connection(request)
    url = (
        _normalize_shared_url(body.url)
        if (body.url or "").strip()
        else _validated_effective_url()
    )
    status, resp = _http_json(
        "POST", f"{url}/api/auth/login", body={"email": body.email, "password": body.password}
    )
    if status != 200 or not isinstance(resp, dict) or not resp.get("token"):
        raise HTTPException(status_code=400, detail=f"공유 서버 로그인 실패: {_flatten_detail(resp)}")
    acc = resp.get("account") or {}
    # ★계정별 DB 로 전환 — 이후 set_setting 들이 이 계정 DB 에 기록된다(다른 계정과 격리).
    _switch_account_db(body.email, acc.get("creator_uid"))
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
    kick_share_state_reconciler()  # auth_required 원장을 새 토큰으로 즉시 재개
    return {"ok": True, "account": acc, **_shared_status()}


class SharedRegisterIn(BaseModel):
    email: str
    password: str
    name: Optional[str] = None


@router.post("/shared-server/register")
def shared_server_register(body: SharedRegisterIn, request: Request):
    """공유 서버에 새 팀 계정 가입 — 작업자가 로컬 허브 로그인창에서 직접. 서버 규칙: 첫 계정은
    자동 admin 승인(토큰 발급) → 즉시 사용, 그 외는 승인대기(pending) → 관리자 승인 후 로그인.
    토큰이 오면(=첫 계정) 이 PC 로컬에 저장해 바로 로그인 상태가 된다."""
    _require_local_shared_connection(request)
    url = _validated_effective_url()
    status, resp = _http_json(
        "POST", f"{url}/api/auth/register",
        body={"email": body.email, "password": body.password, "name": body.name},
    )
    if status != 200 or not isinstance(resp, dict):
        raise HTTPException(
            status_code=status if status >= 400 else 502,
            detail=f"공유 서버 가입 실패: {_flatten_detail(resp)}",
        )
    acc = resp.get("account") or {}
    token = resp.get("token")
    if token:  # 첫 계정=admin 자동승인 → 바로 로그인 상태로 저장
        _switch_account_db(body.email, acc.get("creator_uid"))  # 계정별 DB 로 전환
        repo.set_setting(_K_URL, url)
        repo.set_setting(_K_EMAIL, body.email)
        repo.set_setting(_K_TOKEN, token)
        repo.set_setting(_K_NAME, acc.get("name") or body.email)
        repo.set_setting(_K_ROLES, json.dumps(acc.get("global_roles") or []))
        try:
            repo.set_provider_name(acc.get("name") or body.email)
        except Exception:  # noqa: BLE001
            pass
        kick_share_state_reconciler()  # 첫 계정 자동 로그인도 대기 원장을 즉시 재개
    return {
        "ok": True,
        "account": acc,
        "pending": (acc.get("status") == "pending"),
        "auto_logged_in": bool(token),
        **_shared_status(),
    }


@router.post("/shared-server/logout")
def shared_server_logout(request: Request):
    """로그아웃 — 토큰·신원·임시권한을 지운다. 서버 주소(_K_URL)는 유지(다음 로그인창이 그대로 쓰게)."""
    _require_local_shared_connection(request)
    for k in (_K_TOKEN, _K_EMAIL, _K_NAME, _K_ROLES):
        repo.set_setting(k, None)
    _clear_elevation()  # 로그아웃 → 임시 관리자 권한도 해제
    # ★활성 계정 포인터 해제 → 이후 읽기쓰기는 레거시 단일 DB(미로그인 상태). 다음 로그인이 다시 전환.
    if not AUTH_ENABLED:
        # 레거시 DB(리팩터 이전 단독 DB)에 옛 토큰이 남아 있으면 로그아웃 후에도 로그인된 것으로 보일 수
        # 있다 → 레거시 토큰을 비운다. ★단, active 를 레거시로 전환(clear_active)한 '뒤'에 지우면 그 사이
        # 창에서 다른 요청이 잔존 토큰으로 위임 모드를 오판한다 → 전환 '전에' 레거시 DB 를 직접 열어 비운다.
        if db.DEFAULT_DB_PATH.exists():
            try:
                with db.get_connection(db_path=db.DEFAULT_DB_PATH) as conn:
                    conn.execute(
                        "INSERT INTO app_setting(key, value) VALUES(?, NULL) "
                        "ON CONFLICT(key) DO UPDATE SET value=NULL",
                        (_K_TOKEN,),
                    )
            except Exception:  # noqa: BLE001 — 레거시에 스키마/테이블 없으면 비울 토큰도 없음
                pass
        active_account.clear_active()
        identity._MY_UID_CACHE[0] = None
    return {"ok": True, **_shared_status()}


class ElevateIn(BaseModel):
    email: str
    password: str


@router.post("/shared-server/elevate")
def shared_server_elevate(body: ElevateIn, request: Request):
    """임시 관리자 권한 — 본인 로그인은 유지한 채 admin 계정 비번을 검증해 '승인 절차' 권한만
    일시 획득한다. 검증된 admin 토큰을 elev 슬롯에 저장하고, _proxy 가 계정관리(/api/auth/accounts*)
    호출에만 그 토큰을 쓴다. 로그아웃·계정전환 시 해제(다른 사람이 로그인하면 권한도 넘어감)."""
    # 짧은 관리자 id("admin")는 설정된 관리자 이메일로 매핑(기본 admin@millionvolt.com,
    # env CONTENT_HUB_ADMIN_EMAIL 로 변경). 작업자가 매번 전체 이메일을 안 적어도 되게.
    _require_local_shared_connection(request)
    email = (body.email or "").strip()
    if "@" not in email:
        email = _ADMIN_EMAIL
    url = _validated_effective_url()
    status, resp = _http_json(
        "POST", f"{url}/api/auth/login", body={"email": email, "password": body.password}
    )
    if status != 200 or not isinstance(resp, dict) or not resp.get("token"):
        raise HTTPException(status_code=400, detail=f"권한 부여 실패: {_flatten_detail(resp)}")
    acc = resp.get("account") or {}
    roles = acc.get("global_roles") or []
    if "admin" not in roles:
        raise HTTPException(status_code=403, detail="관리자(admin) 계정이 아닙니다")
    repo.set_setting(_K_ELEV_TOKEN, resp["token"])
    repo.set_setting(_K_ELEV_EMAIL, email)
    repo.set_setting(_K_ELEV_NAME, acc.get("name") or email)
    return {"ok": True, "elevated_as": email, **_shared_status()}


@router.post("/shared-server/de-elevate")
def shared_server_de_elevate(request: Request):
    """임시 관리자 권한 해제(수동)."""
    _require_local_shared_connection(request)
    _clear_elevation()
    return {"ok": True, **_shared_status()}


@router.post("/shared-server/url")
def set_shared_url(body: SetUrlIn, request: Request):
    """공유 서버 주소 변경 — 관리자 창 '공유 서버' 탭(admin 전용 UI). 이 PC 로컬 허브 설정값."""
    _require_local_shared_connection(request)
    url = _normalize_shared_url(body.url)
    repo.set_setting(_K_URL, url)
    return _shared_status()


# ── 로컬 허브(발신 측) — 선택 발행 ──────────────────────────────────────────
class PublishToSharedIn(BaseModel):
    gen_ids: list[str]


class PublishBundleResult(dict):
    """API 응답 dict와 라우트 내부 원장 참조를 함께 운반한다.

    ``intent_refs``는 dict 키가 아니므로 ``{**result}``로 프론트 응답에 새지 않는다.
    """

    def __init__(
        self,
        payload: dict[str, Any],
        intent_refs: dict[str, dict[str, Any]],
        remote_accepted: int,
    ):
        super().__init__(payload)
        self.intent_refs = intent_refs
        self.remote_accepted = remote_accepted


def _transition_publish_ref(
    ref: dict[str, Any], status: str, **fields: Any
) -> bool:
    return repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        status,
        **fields,
    )


def publish_bundle_to_server(
    gen_ids: list[str],
    *,
    operation_kind: str = "publish",
    desired_final: Optional[bool] = None,
    expected_final_by: Optional[str] = None,
    settle_intents: bool = True,
) -> PublishBundleResult:
    """고른 로컬 생성물을 번들(export_bundle)로 공유 서버에 발행 + 로컬 share 표식.
    publish-to-shared 엔드포인트와 finalize(골드 동반 발행)가 공유한다.
    서버 호출 전에 번들 대상 전체를 한 트랜잭션으로 prepared 한다. 합성 finalize는 발행
    부분 상태를 같은 원장에 남긴 뒤 호출자가 서버 finalize 성공 후 종결한다.
    반환: {published, remote}. 토큰 없음=401, 서버 오류=502."""
    url = repo.get_setting(_K_URL) or _effective_url()
    token = repo.get_setting(_K_TOKEN)
    if not token:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 필요합니다")
    gen_ids = [g for g in (gen_ids or []) if g]
    if not gen_ids:
        raise HTTPException(status_code=400, detail="발행할 항목을 선택하세요")
    # 완료본만 발행 — 아래 로컬 share 표식과 같은 기준(done). 진행중/실패본이 번들에 실려
    # 서버에 미완성 fact 로 남지 않게 export 단계에서 거른다.
    # 잠금 전 스냅샷 1회 배치 조회 — 종전엔 필터와 anchor 수집이 항목마다 단건 직렬화를
    # 두 번씩 반복했다(N+1). 직렬화 경로는 단건과 동일(_fetch_gens).
    pre_lock = repo.get_generations_batch(gen_ids)
    gen_ids = [
        g for g in gen_ids if (pre_lock.get(g) or {}).get("status") == "done"
    ]
    if not gen_ids:
        raise HTTPException(status_code=400, detail="발행할 완료본이 없습니다(진행중/실패 제외)")

    initial: list[tuple[str, str]] = []
    for gid in gen_ids:
        gen = pre_lock.get(gid)
        if gen and gen.get("status") == "done":
            initial.append((gid, str(gen.get("job_id") or gid)))
    lock_keys = [
        repo.share_state_identity_key(url, job_anchor=anchor) for _, anchor in initial
    ]
    held_lock_keys = set(lock_keys)
    with repo.share_state_action_locks(lock_keys):
        # 잠금을 기다리는 동안 상태가 바뀔 수 있으므로 번들과 base 상태를 잠금 안에서 다시 만든다.
        # ★잠금 안 재조회는 경합 방어라 반드시 유지 — 단건 반복 대신 스냅샷 1회 배치로만 바꾼다.
        in_lock = repo.get_generations_batch([gid for gid, _ in initial])
        targets: list[dict[str, Any]] = []
        seen_anchors: set[str] = set()
        for gid, _ in initial:
            gen = in_lock.get(gid)
            if not (gen and gen.get("status") == "done"):
                continue
            anchor = str(gen.get("job_id") or gid)
            if anchor in seen_anchors:
                continue
            seen_anchors.add(anchor)
            targets.append({"local_id": gid, "anchor": anchor, "generation": gen})
        if not targets:
            raise HTTPException(status_code=400, detail="발행할 완료본이 없습니다(진행중/실패 제외)")
        # 기다리는 사이 job_id가 생기거나 바뀌면 잠금 전 앵커와 실제 발행 앵커가 달라질 수 있다.
        # 실제 키를 잡지 않았다면 원장 prepare·원격 호출 전에 안전 실패시켜 재시도 때 새 키를 잡는다.
        actual_lock_keys = {
            repo.share_state_identity_key(url, job_anchor=target["anchor"])
            for target in targets
        }
        if not actual_lock_keys.issubset(held_lock_keys):
            raise HTTPException(
                status_code=409,
                detail="발행 대상 식별자가 갱신되었습니다. 요청을 다시 시도하세요",
            )
        bundle = repo.export_bundle(gen_ids=[target["local_id"] for target in targets])
        bundle_anchors = {
            str((item.get("generation") or {}).get("id"))
            for item in (bundle.get("generations") or [])
            if isinstance(item, dict) and (item.get("generation") or {}).get("id")
        }
        targets = [target for target in targets if target["anchor"] in bundle_anchors]
        if not targets:
            raise HTTPException(status_code=400, detail="발행할 유효한 생성물이 없습니다")

        try:
            refs = repo.prepare_share_state_intents(
                url,
                [
                    {
                        "job_anchor": target["anchor"],
                        "local_id": target["local_id"],
                        "operation_kind": operation_kind,
                        "desired_shared": True,
                        "desired_final": (
                            bool(desired_final)
                            if desired_final is not None
                            else bool(target["generation"].get("is_final"))
                        ),
                        "base_shared": bool(target["generation"].get("shared")),
                        "base_final": bool(target["generation"].get("is_final")),
                        "expected_final_by": expected_final_by,
                    }
                    for target in targets
                ],
            )
        except Exception as exc:
            # write-ahead가 없으면 원격을 절대 건드리지 않는다.
            raise HTTPException(
                status_code=503,
                detail="공유 상태 원장을 기록하지 못해 서버 호출을 중단했습니다",
            ) from exc
        refs_by_anchor = {
            target["anchor"]: ref for target, ref in zip(targets, refs, strict=True)
        }

        # 타임아웃·연결 실패·프로세스 중단은 아래 전이까지 오지 않으므로 prepared가 남고,
        # 3b가 서버 현재 상태를 관측한다.
        try:
            status, resp = _http_json(
                "POST",
                f"{url}/api/share/publish-bundle",
                token=token,
                body={"bundle": bundle},
            )
        except Exception:
            # 응답을 못 받은 prepared는 명령을 재생하지 않고 워커가 서버를 관측해야 한다.
            for ref in refs:
                try:
                    repo.release_share_state_intent_claim(
                        ref["intent_id"], ref["intent_seq"], ref["claim_token"]
                    )
                except Exception:  # noqa: BLE001 — 원래 서버 오류를 가리지 않는다.
                    pass
            kick_share_state_reconciler()
            raise
        if status == 401:
            for ref in refs:
                try:
                    _transition_publish_ref(
                        ref, "auth_required", last_error_code="remote_auth_required"
                    )
                except Exception:  # noqa: BLE001 — 원래 401을 가리지 않고 prepared도 안전하다
                    pass
            raise HTTPException(status_code=401, detail="공유 서버 로그인이 만료됐습니다(다시 로그인).")
        if status != 200 or not isinstance(resp, dict):
            if 400 <= status < 500:
                for ref in refs:
                    try:
                        _transition_publish_ref(
                            ref, "rejected", last_error_code=f"remote_{status}"
                        )
                    except Exception:  # noqa: BLE001
                        pass
            else:
                for ref in refs:
                    try:
                        repo.release_share_state_intent_claim(
                            ref["intent_id"], ref["intent_seq"], ref["claim_token"]
                        )
                    except Exception:  # noqa: BLE001 — 원래 서버 오류를 가리지 않는다.
                        pass
                kick_share_state_reconciler()
            # 5xx는 결과 불명일 수 있어 prepared 유지.
            raise HTTPException(status_code=502, detail=f"발행 실패(status={status}): {resp}")

        # 서버가 명시한 blocked_ids만 CAS 취소한다. 응답 전체 성공을 이유로 다른 target까지
        # 취소하지 않으며, 새 seq가 생겼다면 옛 claim CAS는 조용히 실패한다.
        blocked_anchors = {str(a) for a in (resp.get("blocked_ids") or []) if a}
        published = 0
        blocked = 0
        mirror_pending = False
        remote_accepted = 0
        for target in targets:
            gid = target["local_id"]
            anchor = target["anchor"]
            gen = target["generation"]
            ref = refs_by_anchor[anchor]
            if anchor in blocked_anchors:
                blocked += 1
                try:
                    _transition_publish_ref(
                        ref, "rejected", last_error_code="remote_blocked"
                    )
                except Exception:  # noqa: BLE001
                    pass
                continue
            remote_accepted += 1
            final_value = (
                bool(desired_final)
                if desired_final is not None
                else bool(gen.get("is_final"))
            )
            observed = {
                "shared": True,
                "is_final": bool(gen.get("is_final")) if not settle_intents else final_value,
            }
            if not settle_intents:
                observed["publish_confirmed"] = True
            try:
                transitioned = _transition_publish_ref(
                    ref,
                    "pending" if settle_intents else "prepared",
                    observed_state=observed,
                )
                applied = (
                    transitioned
                    and repo.apply_share_state_intent_local(
                        ref["intent_id"],
                        ref["intent_seq"],
                        ref["claim_token"],
                        local_id=gid,
                        shared=True,
                        is_final=(final_value if settle_intents else bool(gen.get("is_final"))),
                        final_by=(expected_final_by if settle_intents else gen.get("final_by")),
                        shared_by=gen.get("worker_id") or DEFAULT_WORKER_ID,
                        preservation_reason=("final" if final_value and settle_intents else "shared"),
                        status=("converged" if settle_intents else "prepared"),
                        observed_state=observed,
                    )
                    == repo.SHARE_STATE_APPLY_APPLIED
                )
            except Exception:  # 로컬 SQLite 실패 — 서버 성공 응답은 유지하고 원장만 재시도 상태로 둔다.
                applied = False
            if not applied:
                mirror_pending = True
                try:
                    if settle_intents:
                        repo.mark_share_state_intent_waiting_local(
                            ref["intent_id"], ref["intent_seq"], ref["claim_token"]
                        )
                    else:
                        _transition_publish_ref(
                            ref,
                            "prepared",
                            last_error_code="local_publish_mirror_failed",
                            increment_fail_streak=True,
                        )
                except Exception:  # noqa: BLE001 — prepared/pending 잔존 자체가 안전망
                    pass
                kick_share_state_reconciler()
                continue
            _touch_telemetry(gid)
            published += 1

        out: dict[str, Any] = {
            "published": published,
            "remote": {
                key: resp.get(key)
                for key in ("inserted", "updated", "unchanged", "skipped", "blocked")
            },
        }
        if mirror_pending:
            out["mirror_pending"] = True
        if blocked:
            out["blocked"] = blocked
            out["message"] = (
                f"{blocked}건은 서버가 반영하지 않았습니다(작성자가 다른 항목의 재공유 등) — "
                "공유 표시를 남기지 않았습니다."
            )
        return PublishBundleResult(out, refs_by_anchor, remote_accepted)


@router.post("/publish-to-shared")
def publish_to_shared(body: PublishToSharedIn, request: Request):
    """고른 생성물만 공유 서버로 발행.

    - 로컬 허브(프록시 모드): 기존 번들 직렬화(export_bundle)를 공유 서버로 HTTP 전송.
    - 서버 본체/단독/테스트(프록시 아님): 이미 이 DB에 있는 항목이므로 밖으로 밀지 않고
      이 DB에 바로 공유 표식만 남긴다(외부 서버 로그인 불필요 → 로그인창으로 튀지 않음).
      finalize 가 비프록시에서 로컬 repo.publish 로 처리하는 것과 동형.
    성공 시 로컬에도 share 표식을 남겨(공유됨 뱃지) 어떤 걸 올렸는지 보이게 한다."""
    if not _proxy.proxying():
        published = 0
        # 상한 없는 gen_ids 의 단건 get_generation N회 → snapshot 배치 1회(R7 2-F).
        # 권한 검사·항목별 repo.publish 순서·published 집계는 종전 그대로(중복 id 는
        # dedupe 로 1회만 집계 — 종전에도 두 번째는 shared=True 로 걸러졌다).
        unique_ids = list(dict.fromkeys(gid for gid in (body.gen_ids or []) if gid))
        gens = repo.get_generations_batch(unique_ids)
        for gid in unique_ids:
            gen = gens.get(gid)
            if not (gen and gen.get("status") == "done" and not gen.get("shared")):
                continue
            try:
                require_edit_generation(request, gen)  # 본인(또는 admin)만 — 남의 작업 공유 차단
            except HTTPException:
                continue  # 권한 없는 항목은 건너뜀(벌크 전체를 막지 않음)
            repo.publish(gid, actor_id(request), "team")
            _touch_telemetry(gid)
            published += 1
        return {"ok": True, "published": published, "remote": {}}
    r = publish_bundle_to_server(body.gen_ids)
    return {"ok": True, **r}
