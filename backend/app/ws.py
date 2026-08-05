"""WebSocket 진행률 푸시 (Phase 3).

생성 잡의 상태 전이(pending→running→done/failed)를 연결된 UI 에 broadcast 한다.
higgsfield 는 퍼센트가 아니라 상태 전이를 주므로, 가짜 진행바 대신 coarse 한
상태를 그대로 푸시한다(advisor 지침).

★계정 스코프: AUTH on(다계정 서버)에선 진행률·변경 알림을 '그 계정'의 소켓에만 보낸다.
예전엔 전체 소켓에 보내 ① 남의 진행상황·result_url 이 새고 ② 누가 뭘 해도 전원이 reload 하는
폭주가 있었다. account_uid=None(AUTH off/단독)이면 전체로 보낸다(소켓이 곧 그 한 사람).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

from fastapi import WebSocket

from .mutation_notify import DOMAIN_LIBRARY, MutationOrigin

# 변경 알림 디바운스(초) — 일괄 트리아지(컬러 연타 등)에서 한 번만 broadcast 하도록 합친다.
_NOTIFY_DEBOUNCE = 0.4

# notify_mutation 에서 "계정 불명 → 전체에 알림"을 표시하는 센티넬(None 은 dict 값으로도 쓰여 구분).
_ALL = "*"
_MAX_NOTIFY_ORIGINS = 32  # 비정상 연타로 WS payload·메모리가 커지면 출처 생략(전원 reload가 안전)
_RECENT_ORIGIN_TTL = 30.0
_MAX_RECENT_ORIGINS = 4096


class ConnectionManager:
    def __init__(self) -> None:
        # 소켓 → 그 연결의 account_uid(creator_uid). AUTH off 면 None.
        self._active: dict[WebSocket, Optional[str]] = {}
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

    async def connect(self, ws: WebSocket, account_uid: Optional[str] = None) -> None:
        await ws.accept()
        async with self._lock:
            self._active[ws] = account_uid

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._active.pop(ws, None)

    async def stats(self) -> dict[str, int]:
        """운영 관측용 연결 수. 계정 식별자는 반환하지 않는다."""
        async with self._lock:
            scoped = sum(1 for account in self._active.values() if account is not None)
            return {
                "connections": len(self._active),
                "authenticated_connections": scoped,
                "local_connections": len(self._active) - scoped,
                "pending_notify_accounts": len(self._pending_accounts),
                "pending_notify_domains": len(self._pending_domains),
            }

    async def broadcast(
        self, message: dict[str, Any], account_uid: Optional[str] = None
    ) -> None:
        """정확히 같은 스코프의 소켓에만 보낸다(a == account_uid).
        ★account_uid=None 은 '전체'가 아니라 '스코프 없음(AUTH off 소켓)'만 뜻한다 — 예전엔
        None 을 전체로 취급해, 계정 스코프 호출의 uid 가 우연히 None(레거시/미이행 creator_uid)
        이면 남의 소켓에 result_url 포함 progress 가 새는 누출이 있었다. AUTH off 는 모든 소켓이
        a=None 이라 여전히 전원 수신(정당), AUTH on 은 uid 로 정확히 격리된다."""
        async with self._lock:
            targets = [ws for ws, a in self._active.items() if a == account_uid]
        await self._send_to(targets, message)

    async def broadcast_all(self, message: dict[str, Any]) -> None:
        """스코프 무관 전 소켓에 보낸다(진짜 '전체'). 데이터가 아니라 reload 신호(synced·gap_warning)
        전용 — 주기 동기화(syncer)가 AUTH on 다계정 서버에서도 모두에게 '새로고침해' 알릴 때 쓴다.
        (account_uid 스코프 broadcast 는 진행률·result_url 같은 개인 데이터라 절대 여기로 보내지 않는다.)"""
        async with self._lock:
            targets = list(self._active.keys())
        await self._send_to(targets, message)

    async def _send_to(self, targets: list[WebSocket], message: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._active.pop(ws, None)

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
