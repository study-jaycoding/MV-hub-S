"""공유 서버의 데이터 변경 신호를 로컬 허브 WebSocket으로 중계한다.

브라우저는 보안상 항상 자기 PC의 로컬 허브(`/ws`) 하나만 구독한다. 데이터 위임 모드에서
다른 PC가 공유 서버를 수정하면 로컬 HTTP 프록시를 거치지 않으므로 그 변경을 알 방법이 없었다.
이 서비스가 프로세스당 원격 연결 하나만 유지해 데이터 없는 reload 신호만 로컬 manager로 넘긴다.

개인 생성 진행률·결과 URL은 의도적으로 중계하지 않는다. 허용하는 메시지는
``synced``/``assets_changed``/``manage_changed`` 세 종류뿐이다.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Optional, Protocol
from urllib.parse import urlsplit, urlunsplit

import websockets

from ..deps import SESSION_COOKIE
from ..mutation_notify import (
    DOMAIN_ASSETS,
    DOMAIN_LIBRARY,
    DOMAIN_MANAGE,
    MutationOrigin,
    parse_mutation_origin,
)

RemoteConfig = tuple[str, str]
ConfigProvider = Callable[[], Optional[RemoteConfig]]
EventHandler = Callable[["RemoteRealtimeEvent"], None]

_EVENT_TO_CHANNEL = {
    "synced": DOMAIN_LIBRARY,
    "assets_changed": DOMAIN_ASSETS,
    "manage_changed": DOMAIN_MANAGE,
}
_MAX_MESSAGE_BYTES = 64 * 1024
# 앱 레벨 텍스트 하트비트 주기 — 브라우저 progressSocket 의 25초 "ping" 과 동일 계약.
_HEARTBEAT_SECONDS = 25.0
_MAX_ORIGINS = 32


def _is_auth_rejection(exc: BaseException) -> bool:
    """신·구 websockets 예외 형태에서 인증/정책 거부를 구분한다."""
    code = getattr(exc, "code", None)
    if code is None:
        received = getattr(exc, "rcvd", None)
        code = getattr(received, "code", None)
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) or getattr(exc, "status_code", None)
    return code == 1008 or status in (401, 403)


class RealtimeNotifier(Protocol):
    def notify_mutation(
        self,
        account_uid: Optional[str] = None,
        origin: Optional[MutationOrigin] = None,
        source: str = "local",
    ) -> None: ...

    def notify_domain(
        self,
        event_type: str,
        origin: Optional[MutationOrigin] = None,
        source: str = "local",
    ) -> None: ...


@dataclass(frozen=True)
class RemoteRealtimeEvent:
    event_type: str
    # None은 출처 불명이다. 이 경우 안전하게 전체 reload 신호를 한 번 보낸다.
    origins: Optional[tuple[MutationOrigin, ...]]


def websocket_uri(base_url: str) -> str:
    """공유 서버 HTTP 주소를 `/ws` 주소로 바꾼다. 토큰은 절대 URL에 넣지 않는다."""
    parsed = urlsplit((base_url or "").strip())
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme.lower())
    if (
        scheme is None
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("공유 서버 주소는 사용자정보·쿼리 없는 http(s) URL이어야 합니다")
    path = parsed.path.rstrip("/") + "/ws"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def decode_event(raw: Any) -> Optional[RemoteRealtimeEvent]:
    """신뢰할 수 없는 원격 WS payload에서 허용된 데이터 없는 신호만 추린다."""
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > _MAX_MESSAGE_BYTES:
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    event_type = payload.get("type")
    if event_type not in _EVENT_TO_CHANNEL:
        return None

    raw_origins = payload.get("origins")
    if not isinstance(raw_origins, list) or not raw_origins or len(raw_origins) > _MAX_ORIGINS:
        return RemoteRealtimeEvent(event_type=event_type, origins=None)

    origins: set[MutationOrigin] = set()
    for item in raw_origins:
        if not isinstance(item, dict):
            return RemoteRealtimeEvent(event_type=event_type, origins=None)
        origin = parse_mutation_origin(item.get("client_id"), item.get("mutation_id"))
        if origin is None:
            # 일부 출처만 버리면 그 탭이 자기 변경으로 오인해 필요한 reload를 생략할 수 있다.
            return RemoteRealtimeEvent(event_type=event_type, origins=None)
        origins.add(origin)
    return RemoteRealtimeEvent(event_type=event_type, origins=tuple(sorted(origins)))


def relay_event(event: RemoteRealtimeEvent, notifier: RealtimeNotifier) -> None:
    """검증된 원격 이벤트를 로컬 ConnectionManager 계약으로 변환한다."""
    origins: tuple[Optional[MutationOrigin], ...] = event.origins or (None,)
    if event.event_type == "synced":
        for origin in origins:
            notifier.notify_mutation(origin=origin, source="remote")
        return
    if event.event_type in ("assets_changed", "manage_changed"):
        for origin in origins:
            notifier.notify_domain(event.event_type, origin, source="remote")


class RemoteRealtimeBridge:
    """동적으로 바뀌는 공유 서버 로그인 설정을 따라가는 단일 WS 연결."""

    def __init__(
        self,
        config_provider: ConfigProvider,
        event_handler: EventHandler,
        *,
        connect_factory: Callable[..., Any] = websockets.connect,
        config_poll_seconds: float = 1.0,
        connected_config_poll_seconds: float = 5.0,
        min_backoff_seconds: float = 1.0,
        max_backoff_seconds: float = 15.0,
    ) -> None:
        self._config_provider = config_provider
        self._event_handler = event_handler
        self._connect_factory = connect_factory
        self._config_poll_seconds = max(0.01, config_poll_seconds)
        self._connected_config_poll_seconds = max(
            self._config_poll_seconds, connected_config_poll_seconds
        )
        self._min_backoff_seconds = max(0.0, min_backoff_seconds)
        self._max_backoff_seconds = max(
            self._min_backoff_seconds, max_backoff_seconds
        )
        self._task: Optional[asyncio.Task] = None
        self._state = "stopped"
        self._connected = False
        self._reconnect_attempts = 0
        self._relayed_events = 0
        self._ignored_messages = 0
        self._last_error: Optional[str] = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._state = "idle"
            self._task = asyncio.create_task(self._run(), name="remote-realtime-bridge")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._connected = False
        self._state = "stopped"

    def stats(self) -> dict[str, Any]:
        """운영 진단용. 서버 주소·계정·토큰은 어떤 형태로도 포함하지 않는다."""
        return {
            "state": self._state,
            "connected": self._connected,
            "reconnect_attempts": self._reconnect_attempts,
            "relayed_events": self._relayed_events,
            "ignored_messages": self._ignored_messages,
            "last_error": self._last_error,
        }

    def _read_config(self) -> Optional[RemoteConfig]:
        try:
            config = self._config_provider()
        except Exception as exc:  # 설정 DB 전환 순간의 일시 오류도 백그라운드 전체를 죽이지 않는다.
            self._last_error = type(exc).__name__
            self._state = "config_error"
            return None
        if not config:
            return None
        base_url, token = config
        if (
            not isinstance(base_url, str)
            or not isinstance(token, str)
            or not token.strip()
            or "\r" in token
            or "\n" in token
        ):
            return None
        return base_url.strip().rstrip("/"), token.strip()

    async def _run(self) -> None:
        backoff = self._min_backoff_seconds
        try:
            while True:
                config = self._read_config()
                if config is None:
                    self._connected = False
                    if self._state != "config_error":
                        self._state = "idle"
                        self._last_error = None
                    backoff = self._min_backoff_seconds
                    await asyncio.sleep(self._config_poll_seconds)
                    continue

                self._state = "connecting"
                try:
                    await self._consume(config)
                    # 정상 반환은 로그인/주소가 바뀌어 기존 연결을 교체하는 경우다.
                    backoff = self._min_backoff_seconds
                    self._last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # 네트워크·인증·프로토콜 오류 → 제한된 backoff로 재연결
                    self._connected = False
                    if _is_auth_rejection(exc):
                        # 같은 만료/거부 토큰으로 계속 연결하면 서버에는 403/1008이 쌓이고 로컬도
                        # 불필요한 재시도를 한다. 로그인/계정 전환으로 설정이 실제 바뀔 때까지 쉰다.
                        self._state = "auth_required"
                        self._last_error = "authentication_rejected"
                        self._reconnect_attempts += 1
                        await self._wait_until_config_change(config)
                        backoff = self._min_backoff_seconds
                        continue
                    self._state = "backoff"
                    self._last_error = type(exc).__name__
                    self._reconnect_attempts += 1
                    await self._wait_or_config_change(backoff, config)
                    backoff = min(
                        self._max_backoff_seconds,
                        max(self._min_backoff_seconds, backoff * 2 or 0.01),
                    )
        finally:
            self._connected = False

    async def _wait_until_config_change(self, expected_config: RemoteConfig) -> None:
        while self._read_config() == expected_config:
            await asyncio.sleep(self._config_poll_seconds)

    async def _wait_or_config_change(
        self, delay: float, expected_config: RemoteConfig
    ) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + delay
        while loop.time() < deadline:
            if self._read_config() != expected_config:
                return
            await asyncio.sleep(min(self._config_poll_seconds, deadline - loop.time()))

    async def _consume(self, config: RemoteConfig) -> None:
        base_url, token = config
        uri = websocket_uri(base_url)
        # URL 쿼리는 접근 로그에 남을 수 있으므로 금지. Bearer는 새 서버 계약, Cookie는 구버전
        # 서버와의 롤링 배포 호환용이다. 둘 다 헤더라 URL·운영 지표에는 노출되지 않는다.
        headers = {
            "Authorization": f"Bearer {token}",
            "Cookie": f"{SESSION_COOKIE}={token}",
        }
        async with self._connect_factory(
            uri,
            additional_headers=headers,
            compression=None,
            open_timeout=8,
            close_timeout=3,
            ping_interval=20,
            ping_timeout=20,
            max_size=_MAX_MESSAGE_BYTES,
            max_queue=16,
            proxy=None,
            user_agent_header="MVHub-Remote-Realtime/1",
        ) as websocket:
            self._connected = True
            self._state = "connected"
            self._last_error = None
            recv_task: Optional[asyncio.Task] = None
            loop = asyncio.get_running_loop()
            next_config_check = loop.time() + self._connected_config_poll_seconds
            next_heartbeat = loop.time() + _HEARTBEAT_SECONDS
            try:
                while True:
                    now = loop.time()
                    if now >= next_config_check:
                        # 로그인/로그아웃/계정전환/서버주소 변경은 프로세스 재시작 없이 반영한다.
                        if self._read_config() != config:
                            return
                        next_config_check = now + self._connected_config_poll_seconds
                    if now >= next_heartbeat:
                        # 앱 레벨 텍스트 하트비트 — 서버 유령 연결 수거(90초 무수신 close)는
                        # 텍스트 수신만 살아있음으로 치므로, 프로토콜 ping(20초)만으로는 이
                        # 브리지가 유령으로 오인돼 주기적으로 끊긴다. 브라우저의 25초 "ping"
                        # 과 같은 계약을 따른다(서버는 내용 무시).
                        await websocket.send("ping")
                        next_heartbeat = now + _HEARTBEAT_SECONDS
                    if recv_task is None:
                        recv_task = asyncio.create_task(websocket.recv())
                    done, _ = await asyncio.wait(
                        (recv_task,),
                        timeout=max(
                            0.01,
                            min(next_config_check, next_heartbeat) - loop.time(),
                        ),
                    )
                    if not done:
                        continue
                    raw = recv_task.result()
                    recv_task = None
                    event = decode_event(raw)
                    if event is None:
                        self._ignored_messages += 1
                        continue
                    self._event_handler(event)
                    self._relayed_events += 1
            finally:
                if recv_task is not None:
                    recv_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await recv_task
                self._connected = False
