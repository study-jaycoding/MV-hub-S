"""클린 피드 전용 창 API — 로컬 허브(이 PC)에서만. 계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md(api-guards·구현에서 정한 것 3·8).

켜는 곳 = 윈도우 · 공유 팀 서버가 아님 · 허브가 loopback 에 열림 · 크롬(또는 엣지)이 있음. 모든 HTTP 는 이 PC 요청만(require_local_machine_request).
open 은 Origin 이 믿는 앱 출처(이 요청을 받은 소켓 포트의 loopback 세 이름 + dev 의 MVHUB_DEV_FRONTEND_PORT)일 때만 — 그 출처를 세션에 고정한다.
WS 는 accept 전에 접속자 loopback(Vite 프록시면 마지막 X-Forwarded-For)·Origin·key·role 을 본다.
미디어 경로는 인증 미들웨어의 공개 예외(main.py — 정확히 이 꼴의 GET/HEAD 만)이고 여기서 key·로컬·세션 계정을 검사한다.
"""

from __future__ import annotations

import asyncio
import json
import os
from functools import lru_cache
from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query, Request, WebSocket
from pydantic import BaseModel, Field, ValidationError

from . import _proxy, library
from .. import active_account, config
from ..deps import SESSION_COOKIE, current_account, session_token
from ..emailnorm import norm_email
from ..services.clean_feed_session import STANDBY_PROTOCOL, Identity, MediaTools, hub, set_media_tools, token_sha
from ..services.clean_feed_window import Screen, find_browser
from ..services.request_guards import client_host, is_loopback_host, require_local_machine_request

router = APIRouter(tags=["clean-feed"])

# 세션(services)이 쓰는 미디어 도구 — 부를 때마다 그 모듈에서 찾는다(시험의 바꿔 끼우기·연결 고정이 그대로 먹게). services 는 routers 를 가져오지 않는다.
set_media_tools(MediaTools(
    local_target=lambda path: _proxy._local_media_target(path),
    thumb=lambda **query: library.media_thumb(**query),
    base_url=lambda: _proxy.base_url(),
    token=lambda: _proxy.token(),
    open=lambda request, timeout: _proxy._open(request, timeout=timeout),
))

_LOCAL_ONLY = "이 PC 에서만 쓸 수 있습니다"
_ORIGIN_NAMES = ("127.0.0.1", "localhost", "[::1]")


@lru_cache(maxsize=1)
def _browser() -> Optional[tuple[str, str]]:
    return find_browser()


def support() -> tuple[bool, Optional[str]]:
    if os.name != "nt":
        return False, "windows-only"
    if _proxy.is_shared_team_server():
        return False, "team-server"
    if not (is_loopback_host(config.HOST) or config.HOST.casefold() == "localhost"):
        return False, "not-loopback"
    if _browser() is None:
        return False, "no-browser"
    return True, None


def trusted_origins(scope: dict) -> set[str]:
    """허브 자신(이 요청을 받은 소켓의 포트 — Host 헤더가 아님) + dev 화면(test_dev.bat 이 고른 Vite 포트)."""
    ports: list[int] = []
    server = scope.get("server")
    if server and isinstance(server[1], int):
        ports.append(server[1])
    dev = os.environ.get("MVHUB_DEV_FRONTEND_PORT", "").strip()
    if dev.isdigit() and 1 <= int(dev) <= 65535:
        ports.append(int(dev))
    return {f"http://{name}:{port}" for port in ports for name in _ORIGIN_NAMES}


async def _local(request: Request) -> None:
    await asyncio.to_thread(require_local_machine_request, request, _LOCAL_ONLY)  # 이 PC 이름 확인이 DNS 를 탈 수 있다


@router.get("/api/clean-feed/status")
async def status(request: Request, session: Optional[str] = Query(None, max_length=64)):
    await _local(request)
    ok, reason = support()
    if ok and hub().windows.cleanup_pending():  # 앞 창이 아직 안 끝났다 — 메뉴가 처음부터 팝업 방식으로(실패 알림과 팝업이 번갈아 나오지 않게)
        ok, reason = False, "cleanup-failed"
    return {"supported": ok, "reason": reason, "instance": hub().instance, **hub().describe(session)}


class ScreenIn(BaseModel):
    left: float = Field(ge=-100000, le=100000)
    top: float = Field(ge=-100000, le=100000)
    width: float = Field(gt=0, le=100000)
    height: float = Field(gt=0, le=100000)
    dpr: float = Field(gt=0.25, le=8)
    primary: bool


class OpenIn(BaseModel):
    screen: ScreenIn
    takeover: bool = True
    client: str = Field(pattern=r"^[0-9A-Za-z_-]{8,64}$")
    seq: int = Field(ge=0, le=2**53)


def _identity(request: Request) -> tuple[Identity, bool]:
    """open 때의 계정 — 세대값을 먼저 잡는다(그 사이의 전환은 다음 비교에서 끝난다)."""
    epoch = active_account.account_epoch()
    if config.AUTH_ENABLED:
        acc = current_account(request)
        token = session_token(request)
        if not acc or not token:
            raise HTTPException(401, "로그인이 필요합니다")
        return Identity(epoch, ("", None), email=norm_email(acc.get("email")), token_sha=token_sha(token), token=token), False
    pin = active_account.capture_account_pin()
    with active_account.pinned_account_scope(pin):
        proxying = _proxy.proxying()
    return Identity(epoch, pin), proxying


@router.post("/api/clean-feed/open")
async def open_feed(body: OpenIn, request: Request):
    await _local(request)
    ok, reason = support()
    if not ok:
        raise HTTPException(404, reason)
    origin = (request.headers.get("origin") or "").strip()
    if origin not in trusted_origins(request.scope):
        raise HTTPException(403, "origin")
    identity, proxying = await asyncio.to_thread(_identity, request)
    s = body.screen
    return await hub().open(screen=Screen(s.left, s.top, s.width, s.height, s.dpr, s.primary), takeover=body.takeover, client=body.client,
                            seq=body.seq, origin=origin, identity=identity, proxying=proxying, browser=_browser())


class CloseIn(BaseModel):
    session: str = Field(max_length=64)
    key: str = Field(max_length=128)


@router.post("/api/clean-feed/close")
async def close_feed(request: Request):
    await _local(request)
    raw = await request.body()  # 창이 닫힐 때의 sendBeacon 은 text/plain 일 수 있다 — 본문을 직접 읽는다
    if len(raw) > 1024:
        raise HTTPException(413, "too large")
    try:
        body = CloseIn.model_validate(json.loads(raw or b"{}"))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(400, "bad close") from exc
    return {"closed": await hub().close(body.session, body.key)}


@router.api_route("/api/clean-feed/media/{session}/{number}", methods=["GET", "HEAD"])
async def media(request: Request, session: str = Path(pattern=r"^[0-9a-f]{32}$"), number: int = Path(ge=1, le=10**9),
                key: str = Query(max_length=128)):
    await _local(request)
    if not support()[0]:
        raise HTTPException(404, "unsupported", headers={"Cache-Control": "no-store"})
    return await hub().media(request, session, number, key)


@router.websocket("/ws/clean-feed")
async def feed_ws(ws: WebSocket, session: str = Query(max_length=64), key: str = Query("", max_length=128), role: str = Query(max_length=8)):
    """accept 전에 다 본다 — 거절은 핸드셰이크 거절(앱은 다시 붙고, 안 되면 status 로 세션 상태를 묻는다).
    role=standby(대기 창의 피드)는 키 쿼리 없이 하위 프로토콜 `mvhub-standby.<토큰>` 하나로 — 토큰을 주소에 두지 않는다(uvicorn 이 INFO 로 경로+쿼리를 남긴다)."""
    if not support()[0] or role not in ("main", "feed", "standby"):
        await ws.close(code=4404)
        return
    if not is_loopback_host(client_host(ws)):  # type: ignore[arg-type] — Request 와 같은 접속 정보(Vite 프록시면 마지막 전달 주소)
        await ws.close(code=4403)
        return
    current = hub()
    if role == "standby":
        offered = [name for name in (ws.scope.get("subprotocols") or []) if name.startswith(STANDBY_PROTOCOL)]
        token = offered[0][len(STANDBY_PROTOCOL):] if len(offered) == 1 else ""  # 없거나 여럿이면 거절
        standby = current.standby_for(token, (ws.headers.get("origin") or "").strip())
        if standby is None:
            await ws.close(code=4404)
            return
        await current.serve_standby(ws, standby, offered[0])
        return
    sess = current.live(session, key)
    if sess is None:
        await ws.close(code=4404)
        return
    if (ws.headers.get("origin") or "").strip() != sess.origin:
        await ws.close(code=4403)
        return
    if not current.epoch_ok(sess):
        current.end(sess, "account")
        await ws.close(code=4409)
        return
    if config.AUTH_ENABLED and role == "main" and token_sha(ws.cookies.get(SESSION_COOKIE)) != sess.identity.token_sha:
        current.end(sess, "account")  # 같은 계정이라도 토큰이 바뀌었다(다시 로그인)
        await ws.close(code=4409)
        return
    await current.serve_ws(ws, sess, role)
