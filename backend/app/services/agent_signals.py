"""에이전트 이벤트 신호 — 계정별 asyncio 이벤트(롱폴 기반 즉시 반응).

push 에이전트는 표준 라이브러리만 써서 WebSocket 을 못 쓴다. 대신 `GET /api/agent/wait` 로
**롱폴**한다: 그 계정에 이벤트(생성요청 생성 / 동기화 버튼)가 생길 때까지 서버가 연결을 잡고
있다가 즉시 반환 → 30초 고정 폴링 없이 액션 순간 반응. 여기 레지스트리가 그 신호를 중계한다.
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

# 마지막 에이전트 호출 후 이 시간(초)까지는 '연결됨'으로 본다. 에이전트는 생성 실행 중
# /api/gen-requests/pending 를 ~1초마다, 유휴 시 롱폴을 ~25초마다 친다 → 40초면 둘 다 커버.
# (생성 중엔 롱폴을 못 해 _waiters=0 이 되어도, 이 윈도우 덕에 '꺼짐'으로 깜빡이지 않는다.)
_CONNECTED_WINDOW = 40.0


class AgentSignals:
    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}
        self._reason: dict[str, str] = {}
        self._waiters: dict[str, int] = {}
        self._last_seen: dict[str, float] = {}  # 계정별 마지막 에이전트 접촉 시각(monotonic)

    def _norm(self, email: str) -> str:
        return (email or "").strip().lower()

    def _ev(self, email: str) -> asyncio.Event:
        ev = self._events.get(email)
        if ev is None:
            ev = asyncio.Event()
            self._events[email] = ev
        return ev

    def signal(self, email: str, reason: str) -> None:
        """그 계정의 대기 중인(또는 곧 대기할) 에이전트를 깨운다. 대기자 없어도 set 유지 →
        에이전트가 작업 중이어서 잠깐 못 받아도 다음 wait 가 즉시 반환(이벤트 유실 방지)."""
        email = self._norm(email)
        if not email:
            return
        self._reason[email] = reason
        self._ev(email).set()

    def touch(self, email: str) -> None:
        """에이전트가 살아 활동 중임을 기록(연결 표시용). 에이전트가 치는 엔드포인트에서 호출."""
        email = self._norm(email)
        if email:
            self._last_seen[email] = time.monotonic()

    async def wait(self, email: str, timeout: float = 25.0) -> Optional[str]:
        """이벤트가 올 때까지(최대 timeout) 대기. 반환=reason(깨움) 또는 None(타임아웃)."""
        email = self._norm(email)
        self.touch(email)
        ev = self._ev(email)
        # 이미 set 돼 있으면(작업 중에 들어온 신호) 즉시 처리. 아니면 clear 후 대기.
        if not ev.is_set():
            ev.clear()
        self._waiters[email] = self._waiters.get(email, 0) + 1
        try:
            await asyncio.wait_for(ev.wait(), timeout)
            ev.clear()
            return self._reason.pop(email, "event")
        except asyncio.TimeoutError:
            return None
        finally:
            self._waiters[email] = max(0, self._waiters.get(email, 1) - 1)

    def connected(self, email: str) -> bool:
        """그 계정의 에이전트가 연결돼 있나 — UI 표시용. 롱폴 대기 중이거나(유휴),
        최근 _CONNECTED_WINDOW 안에 활동했으면(생성 실행 중) True. 후자가 없으면 생성하는
        동안 롱폴을 못 해 '꺼짐'으로 깜빡이던 문제가 생긴다."""
        email = self._norm(email)
        if self._waiters.get(email, 0) > 0:
            return True
        ts = self._last_seen.get(email)
        return ts is not None and (time.monotonic() - ts) < _CONNECTED_WINDOW


# 앱 전역 단일 인스턴스
agent_signals = AgentSignals()
