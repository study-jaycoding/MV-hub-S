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
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import _proxy
from .. import active_account, db, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ._telemetry import touch_generation_telemetry
from ..deps import actor_id, require_edit_generation
from ..repo import identity
from ..services import agent_signals, net_guard, server_relocation
from ..services.request_guards import require_loopback_browser_request
from ..services.event_journal import journal_audit_event
from ..services.share_state_reconciler import kick_share_state_reconciler

router = APIRouter(prefix="/api", tags=["publish"])


# 단일 정의로 통합(_telemetry.touch_generation_telemetry) — share.py 와 복붙돼 있던 것.
_touch_telemetry = touch_generation_telemetry


def _switch_account_db(
    email: str,
    uid: Optional[str],
    *,
    before_publish: Optional[Callable[[], None]] = None,
) -> None:
    """로컬 프록시 로그인/전환 — 계정 전용 DB 를 준비한 뒤 활성 계정 포인터를 바꾼다.
    이후 모든 set_setting/get_setting·읽기쓰기가 그 계정 DB 로 향해 다른 계정과 데이터가 섞이지 않는다.
    before_publish 가 있으면 대상 DB override 아래에서 실행을 마친 뒤 포인터를 공개한다.
    공유 서버(AUTH on)에선 계정별 DB 전환 없이 before_publish 만 현재 DB 에 적용한다."""
    # 일반 요청은 transition_lock 을 잡지 않고 포인터를 읽으므로, 미완료 DB 를 먼저 공개하지 않는다.
    # 로그인/가입의 세션 설정도 이 lock 아래 대상 DB 에 모두 저장한 뒤 포인터를 마지막에 공개한다.
    with active_account.transition_lock:
        if AUTH_ENABLED:
            if before_publish is not None:
                before_publish()
            return
        db.ensure_account_db(email, uid)
        if before_publish is not None:
            override_token = active_account.set_override(email)
            try:
                before_publish()
            finally:
                active_account.reset_override(override_token)
        active_account.set_active(email, uid)  # RLock 재진입 — 마이그레이션 완료 뒤에만 공개
    identity._MY_UID_CACHE[0] = None  # 새 DB 기준으로 is_mine 재계산
    # 에이전트를 깨워 이 계정 DB 로 재동기화·계정상태 재보고 — 로그인 전(레거시 DB)에 보고된 워크스페이스
    # 상태가 새 계정 DB 엔 없어 '미연결'로 보이던 것을 곧 채운다(+ 로컬 생성물도 이 DB 로 다시 적재).
    # 로컬 에이전트는 AUTH-off 라 'local' 신원으로 대기한다(_agent_acc 폴백과 동일).
    try:
        agent_signals.agent_signals.signal("local", "sync")
    except Exception:  # noqa: BLE001 — 에이전트 미가동이어도 로그인은 진행
        pass

# 연결 정보(URL·토큰 키·기본 주소·조회 규칙)는 services/shared_connection 단일 출처.
# 이메일/이름/역할 등 로그인 표시용 키만 이 라우터 소유로 남긴다.
from ..services.shared_connection import (  # noqa: E402
    K_ELEV_TOKEN as _K_ELEV_TOKEN,
    K_RELOCATION_SEEN as _K_RELOCATION_SEEN,
    K_SERVER_NAME as _K_SERVER_NAME,
    K_TOKEN as _K_TOKEN,
    K_URL as _K_URL,
    K_URL_HISTORY as _K_URL_HISTORY,
    URL_HISTORY_MAX as _URL_HISTORY_MAX,
    base_url as _effective_url,
    normalize_server_name as _normalize_server_name,
    published_revision as _published_revision,
    relocation_seen as _relocation_seen,
    server_name as _server_name,
    set_published_revision as _set_published_revision,
    set_relocation_seen as _set_relocation_seen,
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


def _url_history_entries() -> list[dict[str, str]]:
    """예전에 쓰던 공유 서버 주소 + 그때의 서버 이름(최신순, 최대 _URL_HISTORY_MAX).

    저장 형식은 {"url","name"} 객체 배열이지만, **옛 형식(주소 문자열 배열)도 읽는다** —
    이미 이력을 쌓아 둔 PC 가 업데이트만으로 후보를 잃으면 안 되기 때문(이름은 빈 값).
    담기는 값은 주소와 이름뿐이다(토큰·이메일 금지)."""
    raw = repo.get_setting(_K_URL_HISTORY)
    try:
        values = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        return []
    if not isinstance(values, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in values:
        if isinstance(value, str):
            url, name = value, ""
        elif isinstance(value, dict) and isinstance(value.get("url"), str):
            url = value["url"]
            name = value.get("name") if isinstance(value.get("name"), str) else ""
        else:
            continue
        if not url.strip() or url in seen:
            continue
        seen.add(url)
        out.append({"url": url, "name": name})
    return out[:_URL_HISTORY_MAX]


def _url_history() -> list[str]:
    """로그인 화면 '최근 주소' 드롭다운이 쓰는 주소 목록(응답 형식은 주소 문자열 그대로)."""
    return [entry["url"] for entry in _url_history_entries()]


def _push_url_history(previous: Optional[str], new_url: str, previous_name: str = "") -> None:
    """새 주소로 갈아타기 직전의 주소(와 그때 이름)를 이력 맨 앞에 남긴다(중복 제거·상한 유지).
    되돌아갈 후보가 목적이므로 주소가 실제로 바뀔 때만 기록한다."""
    prev = (previous or "").strip().rstrip("/")
    if not prev or prev == new_url:
        return
    entries = [{"url": prev, "name": previous_name}] + [
        entry for entry in _url_history_entries() if entry["url"] != prev
    ]
    repo.set_setting(
        _K_URL_HISTORY, json.dumps(entries[:_URL_HISTORY_MAX], ensure_ascii=False)
    )


def _server_name_for(url: str) -> str:
    """그 주소에 딸린 서버 이름 — 지금 쓰는 주소면 현재 이름, 아니면 이력에서 되찾는다.

    로그인 화면에서 옛 주소로 되돌아가는 작업자가 그 서버 이름을 그대로 다시 보게 한다.
    찾지 못하면 빈 값 = 화면은 주소로 폴백한다(이름은 관리자가 다시 등록)."""
    if (repo.get_setting(_K_URL) or "").strip().rstrip("/") == url:
        return _server_name()
    for entry in _url_history_entries():
        if entry["url"] == url:
            return _normalize_server_name(entry["name"])
    return ""


def _save_shared_session(
    *,
    url: str,
    email: str,
    token: str,
    account: dict[str, Any],
    clear_elevation: bool,
) -> None:
    """공유 서버 세션을 현재 DB scope에 저장한다.

    로컬 로그인/가입에서는 ``_switch_account_db``가 B 계정 override를 건 상태로 호출한다.
    필수 설정 중 하나라도 실패하면 예외를 그대로 전파해 활성 포인터 공개를 막는다.
    """
    name = account.get("name") or email
    # 서버 표시 이름은 '그 주소에 딸린 값'이다 — 주소를 바꿔 로그인하면 그 주소의 이름으로
    # 갈아끼운다(이력에도 없으면 비운다 → 화면은 주소로 폴백). ★_K_URL 을 덮기 '전에' 읽는다.
    server_label = _server_name_for(url)
    # 주소 이력 — 갈아타기 '전' 주소를 남겨, 나중에 로그인 화면에서 되돌릴 수 있게 한다.
    # 필수 설정이 아니므로 실패해도 로그인을 막지 않는다(아래 필수 set_setting 들과 대조).
    try:
        _push_url_history(repo.get_setting(_K_URL), url, _server_name())
    except Exception:  # noqa: BLE001 — 편의 기능 실패가 로그인 자체를 깨지 않게
        pass
    repo.set_setting(_K_URL, url)
    repo.set_setting(_K_SERVER_NAME, server_label or None)
    repo.set_setting(_K_EMAIL, email)
    repo.set_setting(_K_TOKEN, token)
    repo.set_setting(_K_NAME, name)
    repo.set_setting(_K_ROLES, json.dumps(account.get("global_roles") or []))
    if clear_elevation:
        _clear_elevation()  # 계정 전환 → 이전 사람의 임시 관리자 권한 해제
    try:
        repo.set_provider_name(name)
    except Exception:  # noqa: BLE001 — 표시이름 미러 실패가 로그인 자체를 막지는 않음
        pass


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
    name: Optional[str] = None  # 서버 표시 이름(선택) — 비우면 이름 없이 주소만 쓴다


def _shared_status() -> dict[str, Any]:
    elev_email = repo.get_setting(_K_ELEV_EMAIL)
    return {
        "configured": True,
        "url": _effective_url(),
        # 관리자가 등록한 '서버' 표시 이름 — 작업자 화면은 주소 대신 이걸 보여준다(없으면 주소).
        # 아래 "name" 은 로그인한 '사람' 이름이다(다른 값, 다른 키).
        "server_name": _server_name(),
        # 로그인 화면의 '서버 주소 변경' 패널이 되돌릴 후보로 보여준다(주소만 — R7 0-A 로
        # 이 응답 자체가 loopback 전용이라 밖으로 나가지 않는다).
        "url_history": _url_history(),
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
    """공유 서버 '연결 설정'(상태·로그인·토큰·elevation·주소·probe)은 이 PC 브라우저 전용
    (R7 0-A, 코덱스 P1) — 원격 계정이 서버 공용 설정·토큰을 읽거나 바꾸는 간섭과
    login body.url SSRF 를 차단한다. 발행 '데이터' 경로(/share/publish-bundle·
    /publish-to-shared)는 대상이 아니다. ★호환성: LAN 직결·역프록시에선 이 연결설정 라우트 전부(현재 11개)가 403.
    Host 헤더까지 loopback 이어야 통과한다(DNS 리바인딩으로 loopback 판정을 얻는 우회 차단)."""
    require_loopback_browser_request(
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
    try:
        parts.port  # 형식·범위(1~65535) 불량이면 ValueError — 외부 요청 전 400(코덱스 P2)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="주소의 포트가 올바르지 않습니다") from exc
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
    # 공유 서버 API 호출은 lock 밖에서 끝낸 뒤, B 준비→B override 설정 저장→포인터 공개를
    # transition_lock 아래 한 임계구역으로 처리한다. 필수 설정 실패 시 포인터는 기존 A 에 남는다.
    _switch_account_db(
        body.email,
        acc.get("creator_uid"),
        before_publish=lambda: _save_shared_session(
            url=url,
            email=body.email,
            token=resp["token"],
            account=acc,
            clear_elevation=True,
        ),
    )
    kick_share_state_reconciler()  # auth_required 원장을 새 토큰으로 즉시 재개
    return {"ok": True, "account": acc, **_shared_status()}


class SharedRegisterIn(BaseModel):
    url: Optional[str] = None  # 로그인과 동일한 draft — 비우면 기본/저장 주소 사용
    email: str
    password: str
    name: Optional[str] = None


@router.post("/shared-server/register")
def shared_server_register(body: SharedRegisterIn, request: Request):
    """공유 서버에 새 팀 계정 가입 — 작업자가 로컬 허브 로그인창에서 직접. 서버 규칙: 첫 계정은
    자동 admin 승인(토큰 발급) → 즉시 사용, 그 외는 승인대기(pending) → 관리자 승인 후 로그인.
    토큰이 오면(=첫 계정) 이 PC 로컬에 저장해 바로 로그인 상태가 된다.

    주소는 로그인과 같은 draft 규칙이다 — body.url 을 정규화해 이번 요청에만 쓰고, 저장은
    세션이 실제로 생길 때(_save_shared_session)만 일어난다. 서버가 이사한 뒤 합류하는 작업자도
    로그인 화면에서 새 주소로 가입할 수 있어야 하기 때문이다(가입 실패·승인대기는 미저장)."""
    _require_local_shared_connection(request)
    url = (
        _normalize_shared_url(body.url)
        if (body.url or "").strip()
        else _validated_effective_url()
    )
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
        _switch_account_db(
            body.email,
            acc.get("creator_uid"),
            before_publish=lambda: _save_shared_session(
                url=url,
                email=body.email,
                token=token,
                account=acc,
                clear_elevation=False,
            ),
        )
        kick_share_state_reconciler()  # 첫 계정 자동 로그인도 대기 원장을 즉시 재개
    return {
        "ok": True,
        "account": acc,
        "pending": (acc.get("status") == "pending"),
        "auto_logged_in": bool(token),
        **_shared_status(),
    }


_SESSION_KEYS = (_K_TOKEN, _K_EMAIL, _K_NAME, _K_ROLES)


def _clear_session_settings() -> None:
    """토큰·신원·임시 관리자 권한을 현재 DB scope 에서 지운다(포인터는 그대로).
    호출자가 ``active_account.transition_lock`` 을 이미 잡고 있어야 한다."""
    for k in _SESSION_KEYS:
        repo.set_setting(k, None)
    _clear_elevation()  # 로그아웃 → 임시 관리자 권한도 해제


def _detach_active_account() -> None:
    """활성 계정 포인터 해제 → 이후 읽기쓰기는 레거시 단일 DB(미로그인 상태).
    되돌릴 수 없는 전환이므로 정리의 '마지막'에 온다. 호출자가 lock 을 잡고 있어야 한다."""
    if AUTH_ENABLED:
        return
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
    active_account.clear_active()  # RLock 재진입 — 같은 lock 보유 중
    identity._MY_UID_CACHE[0] = None


@router.post("/shared-server/logout")
def shared_server_logout(request: Request):
    """로그아웃 — 토큰·신원·임시권한을 지운다. 서버 주소(_K_URL)는 유지(다음 로그인창이 그대로 쓰게)."""
    _require_local_shared_connection(request)
    # 설정 삭제~포인터 해제 전체를 transition_lock 으로(코덱스 최종 P1) — 복원과 교차 금지.
    with active_account.transition_lock:
        _clear_session_settings()
        _detach_active_account()
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
    """공유 서버 주소·표시 이름 등록 — 관리자 창 '공유 서버' 탭. 이 PC 로컬 허브 설정값.

    이름은 작업자 화면(로그인 화면·이사 알림)에 주소 대신 보여줄 값이다. 관리자만 등록하고
    작업자는 읽기만 한다 — 이 라우트도 다른 연결 설정과 같은 loopback+Host 가드 아래 있다."""
    _require_local_shared_connection(request)
    url = _normalize_shared_url(body.url)
    name = _normalize_server_name(body.name)
    repo.set_setting(_K_URL, url)
    repo.set_setting(_K_SERVER_NAME, name or None)
    return _shared_status()


# 연결 테스트(probe) — 서버가 이사·IP 변경으로 주소가 틀리면 로그인이 실패하고 화면 전체가
# 로그인창에 갇힌다(주소를 바꿀 관리자 UI 는 로그인해야 열린다) → UI 로 복구 불가. 그 탈출구의
# 1단계로 '주소만' 확인한다. 절대 저장하지 않는다(저장은 로그인 성공 시 _save_shared_session).
_PROBE_TIMEOUT_SECONDS = 5
_PROBE_MAX_BYTES = 64 * 1024


class ProbeUrlIn(BaseModel):
    url: str


def _probe_result(
    ok: bool, reachable: bool, server_version: Optional[str], reason: Optional[str]
) -> dict[str, Any]:
    return {"ok": ok, "reachable": reachable, "server_version": server_version, "reason": reason}


def _probe_shared_health(url: str) -> dict[str, Any]:
    """{url}/api/health 를 **무토큰**으로 한 번 조회해 MV Hub 서버인지 판정한다.

    임의의 주소를 받는 경로라 방어를 좁게 건다: 토큰 미첨부(오타·남의 주소로 세션이 새지
    않음)·리다이렉트 금지(3xx 로 다른 곳에 재요청 금지)·JSON 전용·64KB 상한·5초 타임아웃
    (거대 응답이나 응답하지 않는 호스트가 허브 스레드를 붙잡지 못하게).
    반환: {ok, reachable, server_version, reason}.
    """
    req = urllib.request.Request(f"{url}/api/health", method="GET")
    req.add_header("Accept", "application/json")
    try:
        # 리다이렉트 차단 opener 는 net_guard 단일 출처를 재사용한다. 단 여기서는
        # assert_public_http_url 을 쓰지 않는다 — 팀 공유 서버는 사설 IP(LAN)가 정상이다.
        with net_guard.guarded_opener().open(req, timeout=_PROBE_TIMEOUT_SECONDS) as resp:
            status = resp.status
            content_type = (resp.headers.get_content_type() or "").lower()
            raw = resp.read(_PROBE_MAX_BYTES + 1)
    except net_guard.BlockedURLError:
        return _probe_result(False, True, None, "다른 주소로 리다이렉트됩니다(공유 서버 주소가 아닙니다)")
    except urllib.error.HTTPError as exc:
        return _probe_result(False, True, None, f"서버가 응답했지만 상태가 {exc.code} 입니다")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return _probe_result(False, False, None, f"연결할 수 없습니다({exc})")

    if status != 200:
        return _probe_result(False, True, None, f"서버가 응답했지만 상태가 {status} 입니다")
    if len(raw) > _PROBE_MAX_BYTES:
        return _probe_result(False, True, None, "응답이 너무 큽니다(공유 서버가 아닙니다)")
    if not content_type.endswith("json"):
        return _probe_result(
            False, True, None, f"응답이 JSON 이 아닙니다({content_type or '형식 불명'})"
        )
    try:
        payload = json.loads(raw.decode("utf-8", "replace") or "null")
    except ValueError:
        return _probe_result(False, True, None, "응답을 읽을 수 없습니다(JSON 형식 오류)")
    if not isinstance(payload, dict) or "cli_version" not in payload:
        return _probe_result(False, True, None, "MV Hub 공유 서버가 아닙니다(health 응답이 다릅니다)")
    version = payload.get("cli_version")
    return _probe_result(
        True, True, version.strip() if isinstance(version, str) and version.strip() else None, None
    )


@router.post("/shared-server/probe")
def probe_shared_server(body: ProbeUrlIn, request: Request):
    """입력한 주소가 MV Hub 공유 서버인지 확인만 한다(저장 없음) — 로그인 화면 '연결 테스트'."""
    _require_local_shared_connection(request)
    url = _normalize_shared_url(body.url)
    return {"url": url, **_probe_shared_health(url)}


# ── 서버 이사 공지(C안) — 관리자가 옮긴 새 주소를 작업 중인 사람에게 먼저 알린다 ──────
# B안(로그인 화면 주소 변경)은 '이미 갇힌 뒤'의 수동 복구다. 여기서는 릴리스 폴더의
# server-location.json 공지를 읽어, 로그인해 작업 중인 사람에게 알림 → 확인 → 전환까지
# 연결한다. 판정·읽기는 services/server_relocation, 설정 키는 shared_connection 이 소유한다.
_NO_RELOCATION = {
    "current_url": "",
    "proposed_url": None,
    "revision": 0,
    "server_name": None,
    "announced_at": None,
    "reachable": False,
}


class RelocateIn(BaseModel):
    url: str
    revision: int


def _safe_normalized_url(url: str) -> Optional[str]:
    """공지 파일에서 온 주소를 조회 경로에서 정규화한다(불량이면 None — 조회는 500 이 아니라
    '제안 없음'으로 끝나야 한다). 전환 경로는 _normalize_shared_url 을 직접 써 400 을 낸다."""
    try:
        return _normalize_shared_url(url)
    except HTTPException:
        logging.getLogger(__name__).error(
            "공지된 공유 서버 주소 형식이 올바르지 않습니다: %r", url
        )
        return None


@router.get("/shared-server/relocation")
def shared_server_relocation(request: Request):
    """이사 공지 조회 — 옮겨 갈 새 주소가 있는지(알림 센터가 60초마다 확인).

    공지 파일 자체는 백그라운드가 미리 읽어 둔 스냅샷에서 본다 — 죽은 NAS 가 이 요청을
    붙잡으면 안 되기 때문이다. ``reachable`` 은 새 주소가 실제로 응답하는 **MV Hub 서버**
    인지까지 확인한 결과다(B안 probe 재사용 — 무토큰·리다이렉트 금지·JSON·크기 상한).
    """
    _require_local_shared_connection(request)
    current = _effective_url()
    proposal = server_relocation.proposal(
        current, _relocation_seen(), server_relocation.snapshot()
    )
    url = _safe_normalized_url(proposal["url"]) if proposal else None
    if not proposal or not url:
        return {**_NO_RELOCATION, "current_url": current}
    return {
        "current_url": current,
        "proposed_url": url,
        "revision": proposal["revision"],
        # 같은 서버가 자리만 옮긴 것이므로, 공지에 이름이 없으면 지금 쓰는 이름을 그대로 쓴다.
        "server_name": _proposed_server_name(proposal) or None,
        "announced_at": proposal["announced_at"] or None,
        "reachable": _probe_shared_health(url)["ok"],
    }


def _proposed_server_name(proposal: dict[str, Any]) -> str:
    """이사 뒤에 보여줄 서버 이름 — 공지의 이름이 우선, 없으면 지금 기억하는 이름."""
    return _normalize_server_name(proposal.get("name")) or _server_name()


@router.post("/shared-server/relocation/publish")
def publish_relocation_announcement(request: Request):
    """지금 저장된 서버 이름·주소를 릴리스 폴더의 공지로 발행한다 — 관리자 창 '팀에 공지'.

    관리자가 server-location.json 을 손으로 쓰지 않아도 되게 하는 버튼이다. revision 은
    **기존 파일과 이 PC 가 마지막으로 발행한 번호 중 큰 쪽 +1** — 번호를 안 올린 재작성은
    리더가 거부하는 사고이고, 공지 파일을 지운 뒤의 '1 부터 다시'는 이미 옮긴 PC 들이
    새 공지를 무시하게 만드는 사고다. 둘 다 사람의 기억에 맡기지 않는다.
    읽기·쓰기 모두 자식 프로세스로 격리한다(죽은 NAS 대비).

    ★권한의 본질은 릴리스 폴더 ACL 이다(작업자는 읽기 전용). 그래서 여기서 admin 역할을
    다시 검사하지 않는다 — 쓰기 권한이 없는 PC 는 파일 시스템에서 막히고, 그때 안내 문구로
    끝난다. 이 라우트도 다른 연결 설정과 같은 loopback+Host 가드 아래 있다.
    """
    _require_local_shared_connection(request)
    url = _validated_effective_url()
    name = _server_name()
    source = server_relocation.announcement_source()
    if not source:
        raise HTTPException(
            status_code=400,
            detail=(
                "릴리스 설치본에서만 공지를 발행할 수 있습니다"
                "(INSTALL_SOURCE.txt 가 가리키는 릴리스 폴더가 필요합니다)"
            ),
        )
    try:
        announced = server_relocation.publish_announcement(
            source, url=url, name=name, last_published_revision=_published_revision()
        )
    except server_relocation.RelocationPermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (server_relocation.RelocationWriteError, server_relocation.RelocationReadError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 방금 쓴 번호를 로컬에 남긴다 — 누가 공지 파일을 지워도 다음 발행이 1 로 되감기지 않게.
    # 그리고 내가 낸 공지가 나에게 다시 '옮기시겠습니까'로 돌아오지 않게 수락 표식도 갱신한다.
    # (지금은 발행 주소 = 내 주소라 어차피 제안되지 않지만, 나중에 이 PC 가 다른 주소로
    #  로그인하면 내가 쓴 번호를 나에게 제안하게 된다. 더 높은 번호는 그대로 제안된다.)
    try:
        _set_published_revision(announced["revision"])
        _set_relocation_seen(announced["revision"], announced["url"])
    except Exception:  # noqa: BLE001 — 표식 기록 실패가 '이미 성공한 발행'을 실패로 만들지 않게
        logging.getLogger(__name__).error("발행한 공지의 수락 표식 기록 실패", exc_info=True)
    return {
        "ok": True,
        "url": announced["url"],
        "revision": announced["revision"],
        "server_name": announced["name"],
        "announced_at": announced["announced_at"],
        "source": source,
    }


@router.post("/shared-server/relocate")
def relocate_shared_server(body: RelocateIn, request: Request):
    """공지된 새 주소로 전환 — 주소를 바꾸고 이 PC 의 로그인 세션을 정리한다(재로그인 필요).

    ★브라우저가 보낸 url·revision 을 그대로 믿지 않는다. 공지 파일을 **다시 읽어** 같은
    revision·같은 주소일 때만 진행한다(loopback 가드가 있어도, 프런트의 낡은 스냅샷이나
    조작된 요청이 이 PC 의 서버 주소를 바꾸지 못하게). 여기서만 공지를 직접 읽으므로 자식
    프로세스+타임아웃(server_relocation)으로 격리된 읽기를 그대로 쓴다.
    """
    _require_local_shared_connection(request)
    url = _normalize_shared_url(body.url)
    source = server_relocation.announcement_source()
    announcement = server_relocation.read_announcement(source) if source else None
    if not announcement:
        raise HTTPException(
            status_code=409, detail="이사 공지를 다시 읽지 못했습니다. 잠시 후 다시 시도하세요"
        )
    server_relocation.remember(announcement)  # 방금 읽은 최신 공지를 스냅샷에도 반영
    proposal = server_relocation.proposal(_effective_url(), _relocation_seen(), announcement)
    if not proposal or proposal["revision"] != body.revision or proposal["url"] != url:
        raise HTTPException(
            status_code=409, detail="이사 공지가 바뀌었습니다. 새로고침한 뒤 다시 확인하세요"
        )
    health = _probe_shared_health(url)
    if not health["ok"]:
        raise HTTPException(
            status_code=400,
            detail=f"새 주소에 연결할 수 없습니다: {health['reason'] or '확인 실패'}",
        )
    _apply_relocation(url, proposal["revision"], _proposed_server_name(proposal))
    return {"ok": True, "url": url, "revision": proposal["revision"], **_shared_status()}


# 실패 시 되돌릴 설정 — 주소·수락표식·이력 + 세션 키 전부.
_RELOCATION_ROLLBACK_KEYS = (
    _K_URL,
    _K_SERVER_NAME,
    _K_RELOCATION_SEEN,
    _K_URL_HISTORY,
    _K_ELEV_EMAIL,
    _K_ELEV_NAME,
    _K_ELEV_TOKEN,
    *_SESSION_KEYS,
)


def _write_relocation(url: str, revision: int, name: str) -> None:
    """새 주소·표시 이름·수락한 revision 을 현재 DB scope 에 기록(옛 주소는 이력으로)."""
    try:
        _push_url_history(repo.get_setting(_K_URL), url, _server_name())
    except Exception:  # noqa: BLE001 — 되돌아갈 후보 목록 실패가 전환 자체를 막지 않게
        pass
    repo.set_setting(_K_URL, url)
    repo.set_setting(_K_SERVER_NAME, name or None)
    _set_relocation_seen(revision, url)


def _apply_relocation(url: str, revision: int, name: str) -> None:
    """주소 교체 + 세션 정리를 한 임계구역에서 처리한다.

    순서가 계약이다. 되돌릴 수 있는 설정 쓰기를 먼저 끝내고, 되돌릴 수 없는 포인터 해제를
    맨 뒤에 둔다 — 그래서 중간 실패는 '전환 전' 상태 그대로 복구된다.
      1) 새 주소·이름·수락표식 기록  2) 토큰·신원 삭제  (여기까지 실패하면 전부 원상복구)
      3) 활성 계정 포인터 해제  4) 로그아웃된 scope 에도 같은 값을 기록

    ★4)가 없으면 안 된다: 포인터를 풀면 로그인 화면은 레거시 단일 DB 의 주소를 읽으므로,
    계정 DB 에만 쓴 새 주소는 화면에 보이지 않고 같은 데드락이 재발한다.
    """
    with active_account.transition_lock:
        before = {key: repo.get_setting(key) for key in _RELOCATION_ROLLBACK_KEYS}
        try:
            _write_relocation(url, revision, name)
            _clear_session_settings()
        except Exception as exc:  # noqa: BLE001 — 반쯤 바뀐 연결 정보를 남기지 않는다
            for key, value in before.items():
                try:
                    repo.set_setting(key, value)
                except Exception:  # noqa: BLE001 — 나머지 키 복구를 계속한다
                    logging.getLogger(__name__).error("서버 이사 롤백 실패: %s", key)
            raise HTTPException(
                status_code=500, detail=f"주소 전환에 실패해 되돌렸습니다: {exc}"
            ) from exc
        _detach_active_account()
        _write_relocation(url, revision, name)


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
        gens: dict = {}
        for offset in range(0, len(unique_ids), 500):  # SQL 변수 상한 보호(코덱스 P2)
            gens.update(repo.get_generations_batch(unique_ids[offset:offset + 500]))
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
