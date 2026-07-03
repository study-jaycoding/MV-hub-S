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
from typing import Any, Optional

from fastapi import WebSocket

# 변경 알림 디바운스(초) — 일괄 트리아지(컬러 연타 등)에서 한 번만 broadcast 하도록 합친다.
_NOTIFY_DEBOUNCE = 0.4

# notify_mutation 에서 "계정 불명 → 전체에 알림"을 표시하는 센티넬(None 은 dict 값으로도 쓰여 구분).
_ALL = "*"


class ConnectionManager:
    def __init__(self) -> None:
        # 소켓 → 그 연결의 account_uid(creator_uid). AUTH off 면 None.
        self._active: dict[WebSocket, Optional[str]] = {}
        self._lock = asyncio.Lock()
        self._pending_notify: Optional[asyncio.Task] = None
        self._pending_accounts: set[str] = set()  # 디바운스 윈도우에 모인 알림 대상

    async def connect(self, ws: WebSocket, account_uid: Optional[str] = None) -> None:
        await ws.accept()
        async with self._lock:
            self._active[ws] = account_uid

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._active.pop(ws, None)

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

    def notify_mutation(self, account_uid: Optional[str] = None) -> None:
        """로컬 데이터 변경(태그·소스·컬러·코멘트·프로젝트 등)을 같은 계정의 다른 탭/기기에 알린다.
        account_uid=None(계정 불명/AUTH off)이면 전체에 알린다.
        연타(일괄 트리아지)에 대비해 짧은 윈도우로 coalesce — reload 폭주를 막는다.
        프론트는 'synced' 를 받으면 전체 reload 하므로 그 타입을 재사용."""
        self._pending_accounts.add(account_uid if account_uid is not None else _ALL)
        if self._pending_notify and not self._pending_notify.done():
            return  # 이미 예약됨 → 이 변경 대상은 위 set 에 합쳐졌다
        try:
            self._pending_notify = asyncio.create_task(self._debounced_notify())
        except RuntimeError:
            pass  # 이벤트 루프 없음(테스트 등) — 알림 생략

    async def _debounced_notify(self) -> None:
        await asyncio.sleep(_NOTIFY_DEBOUNCE)
        accounts = self._pending_accounts
        self._pending_accounts = set()
        for a in accounts:
            if a == _ALL:
                await self.broadcast_all({"type": "synced"})  # 계정 불명 mutation → 전체 reload 신호
            else:
                await self.broadcast({"type": "synced"}, account_uid=a)
        # broadcast 가 await 하는 동안 새로 쌓인 알림은 notify_mutation 이 (이 태스크가 아직 done 이
        # 아니라) 새 태스크를 안 만든다 → 여기서 직접 재예약해 누락(다른 탭이 reload 못 받음) 방지.
        if self._pending_accounts:
            try:
                self._pending_notify = asyncio.create_task(self._debounced_notify())
            except RuntimeError:
                pass


# 앱 전역 단일 인스턴스
manager = ConnectionManager()
