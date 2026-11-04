"""팀 comfy.org API 키 — 서버 보관(DPAPI)과 로컬 허브의 받아 쓰기(메모리 캐시).

설계·계약: docs/status/Comfy팀키_서버배포_2026-11-04.md.

서버(AUTH on): 관리자가 등록한 키를 app_setting 'team_comfy_api_key' 한 값(JSON 봉투)에 Windows DPAPI
machine scope 로 암호화해 둔다 — 다른 PC 로 복사된 DB(NAS 백업 사본)에서는 풀리지 않는다. 복호 실패는
'없음'과 다른 상태(undecryptable)이고 원본을 지우지 않는다. 암호화할 수 없으면 저장을 거절한다(평문 금지).

허브(AUTH off): 서버 위임과 같은 조건(토큰 있음·CONTENT_HUB_NO_PROXY 꺼짐)에서만 서버 GET /api/team/comfy-key 로
받아 메모리 한 칸에만 둔다 — (서버 주소, 토큰) 짝에 묶여 짝이 바뀌면 버리고, 갱신 응답은 넣기 직전에 짝을 다시 본다.
성공 60초·실패 15초 안에는 다시 묻지 않고, 통신 장애면 마지막 성공부터 10분까지 그 키를 쓴다(stale).
401·403 → 버리고 off, 404 → none, 409 → undecryptable, 402 는 키 무효의 근거가 아니라 유지.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import AUTH_ENABLED
from . import shared_connection

log = logging.getLogger("comfy.team_key")

SETTING_KEY = "team_comfy_api_key"
TEAM_KEY_PATH = "/api/team/comfy-key"
_ENC = "dpapi-machine"
_DESCRIPTION = "mvhub-team-comfy-key"
_HTTP_TIMEOUT = 5.0


def _env_seconds(name: str, default: float, minimum: float) -> float:
    try:
        return max(minimum, float(os.environ.get(name, "") or default))
    except ValueError:
        return default


# 시험용으로만 줄인다(계약). 실패 재질의 금지는 성공 TTL 보다 길지 않게, 유예는 성공 TTL 보다 짧지 않게.
TTL_OK_SEC = _env_seconds("CONTENT_HUB_COMFY_TEAM_KEY_TTL_SEC", 60.0, 0.5)
TTL_FAIL_SEC = min(15.0, TTL_OK_SEC)
GRACE_SEC = max(600.0, TTL_OK_SEC)

STATES = ("available", "stale", "none", "unreachable", "undecryptable", "off")


class ProtectError(RuntimeError):
    """암호화·복호화를 할 수 없다(Windows 가 아니거나 DPAPI 가 거절)."""


# ── Windows DPAPI(ctypes, 의존성 없음) ─────────────────────────────────────────
_CRYPTPROTECT_UI_FORBIDDEN = 0x1
_CRYPTPROTECT_LOCAL_MACHINE = 0x4


def _dpapi(data: bytes, *, protect: bool) -> bytes:
    if os.name != "nt":
        raise ProtectError("Windows DPAPI 가 없는 환경입니다")
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer = (ctypes.c_byte * max(1, len(data))).from_buffer_copy(data or b"\0")
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    out = Blob()
    flags = _CRYPTPROTECT_UI_FORBIDDEN | _CRYPTPROTECT_LOCAL_MACHINE
    if protect:
        fn = crypt32.CryptProtectData
        fn.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.POINTER(Blob), ctypes.c_void_p,
                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        fn.restype = wintypes.BOOL
        ok = fn(ctypes.byref(source), _DESCRIPTION, None, None, None, flags, ctypes.byref(out))
    else:
        fn = crypt32.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(Blob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(Blob), ctypes.c_void_p,
                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        fn.restype = wintypes.BOOL
        ok = fn(ctypes.byref(source), None, None, None, None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    if not ok:
        raise ProtectError(f"DPAPI {'암호화' if protect else '복호화'} 실패(오류 {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def protect(secret: str) -> str:
    """키 → base64 암호문. 실패하면 ProtectError(호출부가 저장을 거절한다)."""
    return base64.b64encode(_dpapi(secret.encode("utf-8"), protect=True)).decode("ascii")


def unprotect(blob: str) -> str:
    try:
        return _dpapi(base64.b64decode(blob.encode("ascii"), validate=True), protect=False).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise ProtectError(f"암호문 형식이 아닙니다: {error}") from error


# ── 서버 보관 ───────────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_store() -> dict[str, Any]:
    """{state: ok|none|undecryptable, api_key, revision, updated_at, updated_by}. 원본은 건드리지 않는다."""
    from .. import repo  # 지역 import(순환 회피)

    raw = repo.get_setting(SETTING_KEY)
    if not raw:
        return {"state": "none", "api_key": None, "revision": 0, "updated_at": None, "updated_by": None}
    meta: dict[str, Any] = {"state": "undecryptable", "api_key": None, "revision": 0, "updated_at": None, "updated_by": None}
    try:
        envelope = json.loads(raw)
    except (TypeError, ValueError):
        return meta
    if not isinstance(envelope, dict):
        return meta
    meta["revision"] = int(envelope.get("revision") or 0) if str(envelope.get("revision") or "0").isdigit() else 0
    meta["updated_at"] = envelope.get("updated_at") if isinstance(envelope.get("updated_at"), str) else None
    meta["updated_by"] = envelope.get("updated_by") if isinstance(envelope.get("updated_by"), str) else None
    if envelope.get("enc") != _ENC or not isinstance(envelope.get("data"), str):
        return meta
    try:
        key = unprotect(envelope["data"])
    except ProtectError as error:
        log.warning("팀 Comfy 키를 풀지 못했습니다(서버 PC 가 바뀌었을 수 있음): %s", error)
        return meta
    if not key:
        return meta
    meta.update(state="ok", api_key=key)
    return meta


_store_lock = threading.Lock()  # 등록·삭제의 읽기→쓰기를 한 프로세스 안에서 직렬화 — 동시 교체가 같은 판을 쓰지 않게


def save_store(api_key: str, updated_by: str) -> dict[str, Any]:
    """암호화해 저장하고 메타를 돌려준다. 암호화 실패면 ProtectError — 값은 안 바뀐다."""
    from .. import repo

    key = (api_key or "").strip()
    if not key:
        raise ValueError("빈 키는 저장하지 않습니다")
    data = protect(key)  # 먼저 — 실패하면 아래 쓰기가 없다
    with _store_lock:
        current = read_store()
        envelope = {"v": 1, "enc": _ENC, "data": data, "revision": int(current.get("revision") or 0) + 1,
                    "updated_at": _now_iso(), "updated_by": (updated_by or "")[:200]}
        repo.set_setting(SETTING_KEY, json.dumps(envelope, ensure_ascii=False))
        log.info("팀 Comfy 키 등록 revision=%s by=%s", envelope["revision"], envelope["updated_by"])  # 키는 절대 안 찍음
        return public_meta(read_store())


def clear_store(updated_by: str) -> dict[str, Any]:
    from .. import repo

    with _store_lock:
        repo.set_setting(SETTING_KEY, None)
        log.info("팀 Comfy 키 삭제 by=%s", (updated_by or "")[:200])
        return public_meta(read_store())


def public_meta(store: dict[str, Any]) -> dict[str, Any]:
    """관리자 GET 응답 — 키의 어느 조각도 없다."""
    return {"has_key": store["state"] == "ok", "state": store["state"], "revision": store["revision"],
            "updated_at": store["updated_at"], "updated_by": store["updated_by"]}


# ── 허브 받아 쓰기(메모리 한 칸) ─────────────────────────────────────────────────
_lock = threading.Lock()
_fetch_lock = threading.Lock()
_slot: Optional[dict[str, Any]] = None


def _no_proxy() -> bool:
    return os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in ("1", "true", "yes", "on")


def _http_get(url: str, token: str, timeout: float = _HTTP_TIMEOUT) -> tuple[Optional[int], bytes]:
    """(상태 코드 또는 응답 없음 None, 본문). 시험이 바꿔 끼운다."""
    request = urllib.request.Request(url, method="GET")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read(65536)
        except OSError:
            return error.code, b""
    except (urllib.error.URLError, TimeoutError, OSError):
        return None, b""


def _empty(state: str) -> dict[str, Any]:
    return {"state": state, "api_key": None, "revision": None, "updated_at": None}


def _direct() -> dict[str, Any]:
    """서버 PC 자신의 허브(AUTH on) — 같은 DB 의 저장값을 직접."""
    store = read_store()
    state = "available" if store["state"] == "ok" else store["state"]
    return {"state": state, "api_key": store["api_key"], "revision": store["revision"], "updated_at": store["updated_at"]}


def _view(slot: dict[str, Any]) -> dict[str, Any]:
    # 유예는 마지막 성공 수신부터 센다 — 실패 재질의 금지 구간에 갇혀 있어도 10분이 지나면 그 키를 더 쓰지 않는다
    if slot["state"] == "stale" and (slot["ok_at"] is None or time.monotonic() - slot["ok_at"] > GRACE_SEC):
        slot.update(key=None, revision=None, updated_at=None, state="unreachable")
    return {"state": slot["state"], "api_key": slot["key"], "revision": slot["revision"], "updated_at": slot["updated_at"]}


def _new_slot(pair: tuple[str, str]) -> dict[str, Any]:
    return {"pair": pair, "key": None, "revision": None, "updated_at": None, "state": "unreachable",
            "ok_at": None, "tried_at": None, "last": None}


def _apply(slot: dict[str, Any], status: Optional[int], body: bytes, now: float) -> None:
    slot["tried_at"] = now
    if status == 200:
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            payload = None
        key = payload.get("api_key") if isinstance(payload, dict) else None
        if isinstance(key, str) and key.strip():
            slot.update(key=key.strip(), revision=payload.get("revision"), updated_at=payload.get("updated_at"),
                        state="available", ok_at=now, last="ok")
            return
        status = 502  # 모양이 다른 200 은 통신 장애처럼 — 받은 키를 버릴 근거는 아니다
    if status in (401, 403):
        slot.update(key=None, revision=None, updated_at=None, state="off", last="denied")
        return
    if status == 404:
        slot.update(key=None, revision=None, updated_at=None, state="none", last="none")
        return
    if status == 409:
        slot.update(key=None, revision=None, updated_at=None, state="undecryptable", last="undecryptable")
        return
    # 응답 없음·5xx·402·그 밖 — 통신 장애: 마지막 성공부터 유예 안이면 그 키로(stale)
    slot["last"] = "fail"
    if slot["key"] and slot["ok_at"] is not None and now - slot["ok_at"] <= GRACE_SEC:
        slot["state"] = "stale"
    else:
        slot.update(key=None, revision=None, updated_at=None, state="unreachable")


def _due(slot: dict[str, Any], now: float) -> bool:
    if slot["tried_at"] is None:
        return True
    ttl = TTL_OK_SEC if slot["last"] == "ok" else TTL_FAIL_SEC
    return now - slot["tried_at"] >= ttl


def resolve(*, fetch: bool = True) -> dict[str, Any]:
    """{state, api_key, revision, updated_at}. fetch=False 면 캐시 값만(부팅 복구·파싱)."""
    global _slot
    if AUTH_ENABLED:
        return _direct()
    base, token = shared_connection.base_url(), shared_connection.token() or ""
    if _no_proxy() or not token or not base:
        forget()  # 로그아웃·묻지 않는 조건 — 받아 둔 키를 남기지 않는다(같은 토큰으로 다시 로그인해도 새로 받는다)
        return _empty("off")
    pair = (base, token)
    with _lock:
        if _slot is None or _slot["pair"] != pair:
            _slot = _new_slot(pair)  # 짝이 바뀌었다(계정 전환·로그아웃·서버 변경) — 옛 값은 버린다
        slot = _slot
        if not fetch or not _due(slot, time.monotonic()):
            return _view(slot) if slot["tried_at"] is not None else _empty("unreachable" if fetch else "off")
    with _fetch_lock:  # 동시 갱신은 하나로
        with _lock:
            slot = _slot
            if slot is None or slot["pair"] != pair:
                return _empty("off")
            if not _due(slot, time.monotonic()):
                return _view(slot)
        status, body = _http_get(f"{base}{TEAM_KEY_PATH}", token)
        now = time.monotonic()
        with _lock:
            slot = _slot
            if slot is None or slot["pair"] != pair or (shared_connection.base_url(), shared_connection.token() or "") != pair:
                return _empty("off")  # 기다리는 사이 짝이 바뀌었다 — 늦게 온 옛 응답은 넣지 않는다
            _apply(slot, status, body, now)
            return _view(slot)


def forget() -> None:
    """시험·로그아웃 — 캐시를 비운다."""
    global _slot
    with _lock:
        _slot = None
