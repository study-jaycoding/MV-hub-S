"""WebSocket 진행률 푸시 (Phase 3).

생성 잡의 상태 전이(pending→running→done/failed)를 연결된 UI 에 broadcast 한다.
higgsfield 는 퍼센트가 아니라 상태 전이를 주므로, 가짜 진행바 대신 coarse 한
상태를 그대로 푸시한다(advisor 지침).

★계정 스코프: AUTH on(다계정 서버)에선 진행률·변경 알림을 '그 계정'의 소켓에만 보낸다.
예전엔 전체 소켓에 보내 ① 남의 진행상황·result_url 이 새고 ② 누가 뭘 해도 전원이 reload 하는
폭주가 있었다. account_uid=None(AUTH off/단독)이면 전체로 보낸다(소켓이 곧 그 한 사람).

★전송 모델(배치 6): 연결마다 sender 태스크 1개 + FIFO 큐. broadcast 는 큐에 넣고 즉시
반환하고, 전송 timeout 은 순수 send_json 에만 적용된다 — 예전엔 broadcast 마다 소켓별
태스크가 '락 대기까지 포함한' 2초 예산으로 보내서, 겹친 broadcast 에서 정상 클라이언트가
앞 전송의 락 대기 때문에 억울하게 수거됐다. 락 안으로 timeout 을 옮기는 수선은 금지
(막힌 소켓 하나에 대기 코루틴이 무한 적체) — 단일 sender 는 연결당 코루틴이 항상 1개다.
큐가 상한을 넘으면 그 연결만 닫는다(프론트 progressSocket 이 자동 재연결 + 따라잡기 reload).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any, Optional

from fastapi import WebSocket

from .mutation_notify import DOMAIN_LIBRARY, MutationOrigin
from .services.operational_logging import log_event

# 변경 알림 디바운스(초) — 일괄 트리아지(컬러 연타 등)에서 한 번만 broadcast 하도록 합친다.
_NOTIFY_DEBOUNCE = 0.4

# notify_mutation 에서 "계정 불명 → 전체에 알림"을 표시하는 센티넬(None 은 dict 값으로도 쓰여 구분).
_ALL = "*"
_MAX_NOTIFY_ORIGINS = 32  # 비정상 연타로 WS payload·메모리가 커지면 출처 생략(전원 reload가 안전)
_RECENT_ORIGIN_TTL = 30.0
_MAX_RECENT_ORIGINS = 4096
_WS_SEND_TIMEOUT_SECONDS = 2.0
_WS_CLOSE_TIMEOUT_SECONDS = 0.5
# 연결별 대기 메시지 상한. 64건 적체 = 클라이언트가 분 단위로 못 받는 상태라 끊는 게 맞다
# (reload 신호는 병합되므로 여기까지 차는 건 progress 폭주 + 수신 불능 조합뿐).
_WS_QUEUE_MAX = 64
# 큐 안에서 병합해도 되는 멱등 reload 신호. 데이터가 실리는 progress·gap_warning 은 병합 금지.
_MERGEABLE_RELOAD_TYPES = frozenset({"synced", "assets_changed", "manage_changed"})

_log = logging.getLogger("mvhub.websocket")


def _merge_reload_messages(first: dict[str, Any], second: dict[str, Any]) -> dict[str, Any]:
    """같은 타입의 미전송 reload 신호 둘을 하나로 합친다(원본 dict 는 변형하지 않는다).

    필드 규칙은 '확신 없으면 뺀다' — 프론트는 origins 없음=자기 알림 생략 불가(전부 reload),
    projects 없음=전체 프로젝트 갱신으로 읽으므로, 빠진 필드는 항상 안전한 상위집합이 된다.
    """
    merged: dict[str, Any] = {"type": first["type"]}
    # ★빈 배열은 합집합의 항등원이 아니라 '전체'다(프론트 계약: origins 없음/빈배열=자기 알림
    # 생략 불가, projects 없음/빈배열=전체 프로젝트 갱신) — 한쪽이 비었거나 없으면 필드를
    # 생략해 '전체'로 승격한다. 그러지 않으면 전체 갱신 신호가 부분 갱신으로 축소돼 누락된다.
    if first.get("origins") and second.get("origins"):
        seen = {(o["client_id"], o["mutation_id"]) for o in first["origins"]}
        origins = list(first["origins"]) + [
            o for o in second["origins"] if (o["client_id"], o["mutation_id"]) not in seen
        ]
        # 병합 누적으로 payload 가 커지면 출처를 생략한다(_MAX_NOTIFY_ORIGINS 와 같은 정책).
        if len(origins) <= _MAX_NOTIFY_ORIGINS:
            merged["origins"] = origins
    if first.get("projects") and second.get("projects"):
        merged["projects"] = list(dict.fromkeys([*first["projects"], *second["projects"]]))
    return merged


class _Client:
    """연결 하나의 전송 상태 — 소켓·스코프·대기 큐·단일 sender 태스크."""

    __slots__ = ("ws", "account_uid", "queue", "wakeup", "sender", "in_flight")

    def __init__(self, ws: WebSocket, account_uid: Optional[str]) -> None:
        self.ws = ws
        self.account_uid = account_uid
        self.queue: deque[dict[str, Any]] = deque()
        self.wakeup = asyncio.Event()
        self.sender: Optional[asyncio.Task] = None
        self.in_flight = False


class ConnectionManager:
    def __init__(self) -> None:
        # 소켓 → 연결 상태(스코프·큐·sender). AUTH off 면 account_uid=None.
        self._clients: dict[WebSocket, _Client] = {}
        self._send_timeouts = 0
        self._send_failures = 0
        self._send_overflows = 0
        self._lock = asyncio.Lock()
        self._pending_notify: Optional[asyncio.Task] = None
        # 스코프 → {브라우저 client id: 요청 mutation id 집합}. None이면 출처 불명 변경이 섞여
        # 어느 탭도 안전하게 자기 알림을 생략할 수 없다는 뜻이다.
        self._pending_accounts: dict[str, Optional[set[MutationOrigin]]] = {}
        # Assets·PM처럼 라이브러리와 분리된 데이터 없는 갱신 신호. 이벤트 종류별로 출처를 병합한다.
        self._pending_domains: dict[str, Optional[set[MutationOrigin]]] = {}
        # 로컬 프록시가 즉시 보낸 알림은 잠시 뒤 원격 WS 브리지로 그대로 되돌아올 수 있다.
        # (영역, 스코프, 요청 출처) 조합을 짧게 기억해 한 HTTP 쓰기가 두 번 reload를 만들지 않게 한다.
        # 출처가 없는 변경은 서로 다른 실제 변경일 수 있으므로 절대 억지로 합치지 않는다.
        self._recent_origins: dict[tuple[str, str, MutationOrigin], tuple[float, str]] = {}

    def _stats_unlocked(self) -> dict[str, int]:
        scoped = sum(1 for c in self._clients.values() if c.account_uid is not None)
        authenticated_accounts = len(
            {c.account_uid for c in self._clients.values() if c.account_uid is not None}
        )
        return {
            "connections": len(self._clients),
            "authenticated_connections": scoped,
            "authenticated_accounts": authenticated_accounts,
            "local_connections": len(self._clients) - scoped,
            "pending_notify_accounts": len(self._pending_accounts),
            "pending_notify_domains": len(self._pending_domains),
            "queued_messages": sum(
                len(c.queue) + (1 if c.in_flight else 0) for c in self._clients.values()
            ),
            "send_timeouts": self._send_timeouts,
            "send_failures": self._send_failures,
            "send_overflows": self._send_overflows,
        }

    async def connect(
        self, ws: WebSocket, account_uid: Optional[str] = None
    ) -> dict[str, int]:
        await ws.accept()
        client = _Client(ws, account_uid)
        async with self._lock:
            self._clients[ws] = client
            client.sender = asyncio.create_task(self._sender_loop(client))
            return self._stats_unlocked()

    async def disconnect(self, ws: WebSocket) -> dict[str, int] | None:
        async with self._lock:
            client = self._clients.pop(ws, None)
            if client is None:
                return None
            stats = self._stats_unlocked()
        await self._stop_sender(client)
        return stats

    def is_tracked(self, ws: WebSocket) -> bool:
        """endpoint receive loop 용 — 수거된 연결의 close 가 유실돼 브라우저가 안 끊겨도
        receive loop 가 유령으로 남지 않게, 추적 여부를 확인해 스스로 닫고 나가게 한다."""
        return ws in self._clients

    async def stats(self) -> dict[str, int]:
        """운영 관측용 연결 수. 계정 식별자는 반환하지 않는다."""
        async with self._lock:
            return self._stats_unlocked()

    async def broadcast(
        self, message: dict[str, Any], account_uid: Optional[str] = None
    ) -> None:
        """정확히 같은 스코프의 소켓에만 보낸다(a == account_uid).
        ★account_uid=None 은 '전체'가 아니라 '스코프 없음(AUTH off 소켓)'만 뜻한다 — 예전엔
        None 을 전체로 취급해, 계정 스코프 호출의 uid 가 우연히 None(레거시/미이행 creator_uid)
        이면 남의 소켓에 result_url 포함 progress 가 새는 누출이 있었다. AUTH off 는 모든 소켓이
        a=None 이라 여전히 전원 수신(정당), AUTH on 은 uid 로 정확히 격리된다."""
        await self._deliver(message, scope_all=False, account_uid=account_uid)

    async def broadcast_all(self, message: dict[str, Any]) -> None:
        """스코프 무관 전 소켓에 보낸다(진짜 '전체'). 데이터가 아니라 reload 신호(synced·gap_warning)
        전용 — 주기 동기화(syncer)가 AUTH on 다계정 서버에서도 모두에게 '새로고침해' 알릴 때 쓴다.
        (account_uid 스코프 broadcast 는 진행률·result_url 같은 개인 데이터라 절대 여기로 보내지 않는다.)"""
        await self._deliver(message, scope_all=True)

    async def _deliver(
        self,
        message: dict[str, Any],
        *,
        scope_all: bool,
        account_uid: Optional[str] = None,
    ) -> None:
        """대상 연결의 큐에 넣는다(전송은 각 연결의 sender 가 담당). 큐가 가득 찬 연결만 수거.
        ★message 는 enqueue 후에도 참조된다 — 호출측은 반환 뒤 dict/중첩 배열을 수정하면 안
        된다(현 호출처는 모두 호출마다 새 literal 을 만든다)."""
        overflowed: list[_Client] = []
        async with self._lock:
            for client in self._clients.values():
                if not scope_all and client.account_uid != account_uid:
                    continue
                if not self._enqueue(client, message):
                    overflowed.append(client)
        for client in overflowed:
            # 수거는 백그라운드로 — broadcast 는 'enqueue 후 즉시 반환' 계약을 지킨다
            # (여러 연결이 동시에 넘치면 sender 대기+close 가 N×1초까지 호출처를 붙잡을 수 있다).
            # 다음 broadcast 가 같은 연결을 또 넘겨도 _collect 의 identity 체크가 한 번만 집계한다.
            asyncio.create_task(self._collect(client, "overflow"))
        # 연속 broadcast burst 는 그 사이 어떤 await 도 양보하지 않을 수 있어 sender 태스크가
        # 굶는다 — 그러면 즉시 받을 수 있는 클라이언트까지 enqueue 속도만으로 큐가 차 수거된다.
        # broadcast 마다 한 번 양보해 각 연결의 sender 가 따라올 기회를 준다.
        await asyncio.sleep(0)

    @staticmethod
    def _enqueue(client: _Client, message: dict[str, Any]) -> bool:
        """큐에 추가. reload 신호는 이미 대기 중인 같은 타입과 병합(자리 유지) — 폭주 흡수.
        상한 초과면 False(호출측이 그 연결을 수거한다)."""
        message_type = message.get("type")
        if message_type in _MERGEABLE_RELOAD_TYPES:
            for index, queued in enumerate(client.queue):
                if queued.get("type") == message_type:
                    client.queue[index] = _merge_reload_messages(queued, message)
                    client.wakeup.set()
                    return True
        if len(client.queue) >= _WS_QUEUE_MAX:
            return False
        client.queue.append(message)
        client.wakeup.set()
        return True

    async def _sender_loop(self, client: _Client) -> None:
        """연결당 단일 sender — 같은 소켓에 send_json 이 동시에 겹칠 수 없고(FIFO 순서 보장),
        timeout 은 자기 전송에만 적용된다(다른 broadcast 의 대기가 예산을 갉아먹지 않음)."""
        while True:
            if not client.queue:
                client.wakeup.clear()
                await client.wakeup.wait()
                continue
            message = client.queue.popleft()
            client.in_flight = True
            failure: str | None = None
            try:
                await asyncio.wait_for(
                    client.ws.send_json(message), timeout=_WS_SEND_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                failure = "timeout"
            except asyncio.CancelledError:
                client.in_flight = False
                raise
            except Exception:
                failure = "failure"
            client.in_flight = False
            if failure is not None:
                await self._collect(client, failure)
                return

    async def _collect(self, client: _Client, reason: str) -> None:
        """죽은/막힌 연결 수거 — manager 에서 빼고, 집계·로그 후 소켓을 짧게 닫는다.
        (manager 에서만 빼면 endpoint 의 receive loop 가 계속 살아 유령 연결이 된다.)"""
        async with self._lock:
            if self._clients.get(client.ws) is not client:
                return  # 이미 수거됐거나 같은 소켓으로 재등록된 새 연결이다
            self._clients.pop(client.ws, None)
            if reason == "timeout":
                self._send_timeouts += 1
            elif reason == "overflow":
                self._send_overflows += 1
            else:
                self._send_failures += 1
        log_event(
            _log,
            "websocket_clients_dropped",
            level=logging.WARNING,
            dropped=1,
            reason=reason,
        )
        await self._stop_sender(client)
        close_reason = {
            "timeout": "realtime send timeout",
            "overflow": "realtime queue overflow",
        }.get(reason, "realtime send failed")
        await self._close_quietly(client.ws, close_reason)

    @staticmethod
    async def _stop_sender(client: _Client) -> None:
        """sender 를 멈추고 '실제 종료'까지 기다린다 — 전송 중(cancel 처리 전)인 sender 와 같은
        소켓에 close 를 겹쳐 부르면 ASGI 가 거부해 close 가 유실될 수 있다. 그러면 브라우저는
        열린 연결로 믿고 재연결(따라잡기 reload)을 안 해 이후 신호를 영구 누락한다(코덱스 P0).
        sender 가 자기 자신을 수거하는 경로에선 아무것도 안 한다(직후 return 으로 끝난다)."""
        sender = client.sender
        if sender is None or sender is asyncio.current_task():
            return
        sender.cancel()
        try:
            # gather(return_exceptions=True) 는 sender 의 CancelledError 를 결과로 삼켜,
            # '우리가 취소된 것'과 구분한다. wait_for 는 취소를 안 받는 sender 대비 상한.
            await asyncio.wait_for(
                asyncio.gather(sender, return_exceptions=True),
                timeout=_WS_CLOSE_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            pass

    @staticmethod
    async def _close_quietly(ws: WebSocket, reason: str) -> None:
        try:
            await asyncio.wait_for(
                ws.close(code=1011, reason=reason),
                timeout=_WS_CLOSE_TIMEOUT_SECONDS,
            )
        except Exception:
            pass

    def notify_mutation(
        self,
        account_uid: Optional[str] = None,
        origin: Optional[MutationOrigin] = None,
        source: str = "local",
    ) -> None:
        """로컬 데이터 변경(태그·소스·컬러·코멘트·프로젝트 등)을 같은 계정의 다른 탭/기기에 알린다.
        account_uid=None(계정 불명/AUTH off)이면 전체에 알린다.
        연타(일괄 트리아지)에 대비해 짧은 윈도우로 coalesce — reload 폭주를 막는다.
        프론트는 'synced' 를 받으면 전체 reload 하므로 그 타입을 재사용."""
        scope = account_uid if account_uid is not None else _ALL
        if self._is_duplicate_origin(DOMAIN_LIBRARY, scope, origin, source):
            return
        self._merge_origin(self._pending_accounts, scope, origin)
        self._schedule_notify()

    def notify_domain(
        self,
        event_type: str,
        origin: Optional[MutationOrigin] = None,
        source: str = "local",
    ) -> None:
        """Assets·PM 전용 갱신을 모든 연결에 알린다. payload는 변경 사실·출처뿐이라 데이터 누출이 없다."""
        if self._is_duplicate_origin(event_type, _ALL, origin, source):
            return
        self._merge_origin(self._pending_domains, event_type, origin)
        self._schedule_notify()

    def _is_duplicate_origin(
        self,
        channel: str,
        scope: str,
        origin: Optional[MutationOrigin],
        source: str,
    ) -> bool:
        """같은 요청의 로컬 즉시 알림과 원격 WS echo만 제거한다.

        mutation id는 탭이 요청마다 새로 만드는 값이라, 같은 영역·스코프에서 TTL 안에 다시 온
        동일 조합은 같은 쓰기의 전달 경로 중복이다. 영역을 키에 포함하므로 library+manage를 함께
        바꾸는 한 요청은 두 영역 모두 정상 전달된다.
        """
        if origin is None:
            return False
        now = time.monotonic()
        key = (channel, scope, origin)
        seen = self._recent_origins.get(key)
        # 같은 경로에서 요청 id를 재사용한 실제 쓰기까지 숨기지 않는다. 오직 로컬 즉시 알림과
        # remote bridge처럼 서로 다른 전달 경로가 같은 요청을 가져왔을 때만 echo로 판정한다.
        if seen is not None and seen[1] != source and now - seen[0] < _RECENT_ORIGIN_TTL:
            return True
        self._recent_origins[key] = (now, source)
        if len(self._recent_origins) > _MAX_RECENT_ORIGINS:
            cutoff = now - _RECENT_ORIGIN_TTL
            self._recent_origins = {
                k: seen_value
                for k, seen_value in self._recent_origins.items()
                if seen_value[0] >= cutoff
            }
            # 비정상적으로 많은 서로 다른 출처가 TTL 안에 몰려도 메모리 상한을 지킨다.
            if len(self._recent_origins) > _MAX_RECENT_ORIGINS:
                oldest = sorted(
                    self._recent_origins,
                    key=lambda recent_key: self._recent_origins[recent_key][0],
                )
                for old_key in oldest[: len(self._recent_origins) - _MAX_RECENT_ORIGINS]:
                    self._recent_origins.pop(old_key, None)
        return False

    @staticmethod
    def _merge_origin(
        pending: dict[str, Optional[set[MutationOrigin]]],
        key: str,
        origin: Optional[MutationOrigin],
    ) -> None:
        if key not in pending:
            pending[key] = {origin} if origin else None
        else:
            origins = pending[key]
            if origins is not None:
                if origin is None:
                    pending[key] = None
                else:
                    origins.add(origin)
                    if len(origins) > _MAX_NOTIFY_ORIGINS:
                        pending[key] = None

    def _schedule_notify(self) -> None:
        if self._pending_notify and not self._pending_notify.done():
            return  # 이미 예약됨 → 변경 대상·도메인·출처는 pending dict에 합쳐졌다
        try:
            self._pending_notify = asyncio.create_task(self._debounced_notify())
        except RuntimeError:
            pass  # 이벤트 루프 없음(테스트 등) — 알림 생략

    async def _debounced_notify(self) -> None:
        await asyncio.sleep(_NOTIFY_DEBOUNCE)
        accounts = self._pending_accounts
        self._pending_accounts = {}
        for a, origins in accounts.items():
            message: dict[str, Any] = {"type": "synced"}
            if origins:
                message["origins"] = [
                    {"client_id": client_id, "mutation_id": mutation_id}
                    for client_id, mutation_id in sorted(origins)
                ]
            if a == _ALL:
                await self.broadcast_all(message)  # 계정 불명 mutation → 전체 reload 신호
            else:
                await self.broadcast(message, account_uid=a)
        domains = self._pending_domains
        self._pending_domains = {}
        for event_type, origins in domains.items():
            message = {"type": event_type}
            if origins:
                message["origins"] = [
                    {"client_id": client_id, "mutation_id": mutation_id}
                    for client_id, mutation_id in sorted(origins)
                ]
            await self.broadcast_all(message)
        # broadcast 가 await 하는 동안 새로 쌓인 알림은 notify_mutation 이 (이 태스크가 아직 done 이
        # 아니라) 새 태스크를 안 만든다 → 여기서 직접 재예약해 누락(다른 탭이 reload 못 받음) 방지.
        if self._pending_accounts or self._pending_domains:
            try:
                self._pending_notify = asyncio.create_task(self._debounced_notify())
            except RuntimeError:
                pass


# 앱 전역 단일 인스턴스
manager = ConnectionManager()
