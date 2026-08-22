"""에이전트 이벤트 신호 — 계정별 asyncio 이벤트(롱폴 기반 즉시 반응).

push 에이전트는 표준 라이브러리만 써서 WebSocket 을 못 쓴다. 대신 `GET /api/agent/wait` 로
**롱폴**한다: 그 계정에 이벤트(생성요청 생성 / 동기화 버튼)가 생길 때까지 서버가 연결을 잡고
있다가 즉시 반환 → 30초 고정 폴링 없이 액션 순간 반응. 여기 레지스트리가 그 신호를 중계한다.
"""

from __future__ import annotations

import asyncio
import threading
import time

from ..emailnorm import norm_email
from typing import Optional

# 마지막 에이전트 호출 후 이 시간(초)까지는 '연결됨'으로 본다. 에이전트는 생성 실행 중
# /api/gen-requests/pending 를 ~1초마다, 유휴 시 롱폴을 ~25초마다 친다 → 40초면 둘 다 커버.
# (생성 중엔 롱폴을 못 해 _waiters=0 이 되어도, 이 윈도우 덕에 '꺼짐'으로 깜빡이지 않는다.)
_CONNECTED_WINDOW = 40.0


class AgentSignals:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self._events: dict[str, asyncio.Event] = {}
        # 계정별 누적 이벤트 사유(set) — 연속 신호(gen-request 후 sync 등)가 덮어써져 유실되던
        # 문제 방지. wait 가 콤마로 합쳐 반환 → 에이전트가 둘 다 처리(생성요청이 sync 에 묻혀
        # '생성중'에 멈추던 버그 수정).
        self._reasons: dict[str, set[str]] = {}
        self._waiters: dict[str, int] = {}
        self._last_seen: dict[str, float] = {}  # 계정별 마지막 에이전트 접촉 시각(monotonic)

    def _norm(self, email: str) -> str:
        return norm_email(email)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """lifespan의 메인 루프를 저장해 동기 라우트 신호를 그 루프로 전달한다."""
        with self._lock:
            if self._loop is loop:
                return
            previous = self._loop
            self._loop = loop
            # TestClient 재시작 등으로 루프가 바뀌면 옛 루프에 묶인 Event를 재사용하지 않는다.
            if previous is not None:
                self._events.clear()
                self._reasons.clear()
                self._waiters.clear()
                self._last_seen.clear()

    def unbind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            if self._loop is loop:
                self._loop = None
                self._events.clear()
                self._reasons.clear()
                self._waiters.clear()
                self._last_seen.clear()

    def _dispatch(self, callback, *args) -> bool:
        with self._lock:
            loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is None and running is not None:
            self.bind_loop(running)
            loop = running
        if loop is None or loop.is_closed():
            return False
        if running is loop:
            callback(*args)
            return True
        try:
            loop.call_soon_threadsafe(callback, *args)
            return True
        except RuntimeError:
            return False  # 종료 중 닫힌 루프에는 새 신호를 게시하지 않는다.

    def _ev(self, email: str) -> asyncio.Event:
        with self._lock:
            ev = self._events.get(email)
            if ev is None:
                ev = asyncio.Event()
                self._events[email] = ev
        return ev

    def _signal_on_loop(self, email: str, reason: str) -> None:
        with self._lock:
            self._reasons.setdefault(email, set()).add(reason)
        self._ev(email).set()

    def signal(self, email: str, reason: str) -> None:
        """그 계정의 대기 중인(또는 곧 대기할) 에이전트를 깨운다. 대기자 없어도 set 유지 →
        에이전트가 작업 중이어서 잠깐 못 받아도 다음 wait 가 즉시 반환(이벤트 유실 방지)."""
        email = self._norm(email)
        if not email:
            return
        if not self._dispatch(self._signal_on_loop, email, reason):
            # lifespan 없는 임베드 환경은 Event를 건드릴 루프가 없다. 사유만 잠금 아래 보존하면
            # 첫 wait가 자기 루프에서 Event를 만들고 즉시 소비할 수 있다.
            with self._lock:
                self._reasons.setdefault(email, set()).add(reason)

    def _touch_on_loop(self, email: str) -> None:
        with self._lock:
            self._last_seen[email] = time.monotonic()

    def touch(self, email: str) -> None:
        """에이전트가 살아 활동 중임을 기록(연결 표시용). 에이전트가 치는 엔드포인트에서 호출."""
        email = self._norm(email)
        if email:
            if not self._dispatch(self._touch_on_loop, email):
                # TestClient를 context manager 없이 쓰는 등 메인 루프가 없는 경우의 호환 경로.
                self._touch_on_loop(email)

    async def wait(self, email: str, timeout: float = 25.0) -> Optional[str]:
        """이벤트가 올 때까지(최대 timeout) 대기. 반환=reason(깨움) 또는 None(타임아웃)."""
        email = self._norm(email)
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            self.bind_loop(loop)
        self._touch_on_loop(email)
        ev = self._ev(email)
        with self._lock:
            has_pending_reason = bool(self._reasons.get(email))
        if has_pending_reason:
            ev.set()
        # 이미 set 돼 있으면(작업 중에 들어온 신호) 즉시 처리. 아니면 clear 후 대기.
        if not ev.is_set():
            ev.clear()
        with self._lock:
            self._waiters[email] = self._waiters.get(email, 0) + 1
        try:
            await asyncio.wait_for(ev.wait(), timeout)
            ev.clear()
            with self._lock:
                reasons = self._reasons.pop(email, None)
            # 같은 계정 waiter 가 둘이면 사유는 먼저 깬 쪽이 가져간다. 남은 쪽에 "event" 같은
            # 가짜 사유를 주면 에이전트가 할 일 없이 깨어나 그 사이클의 idle 폴백까지 건너뛴다.
            return ",".join(sorted(reasons)) if reasons else None
        except asyncio.TimeoutError:
            return None
        finally:
            with self._lock:
                self._waiters[email] = max(0, self._waiters.get(email, 1) - 1)

    def connected(self, email: str) -> bool:
        """그 계정의 에이전트가 연결돼 있나 — UI 표시용. 롱폴 대기 중이거나(유휴),
        최근 _CONNECTED_WINDOW 안에 활동했으면(생성 실행 중) True. 후자가 없으면 생성하는
        동안 롱폴을 못 해 '꺼짐'으로 깜빡이던 문제가 생긴다."""
        email = self._norm(email)
        with self._lock:
            waiters = self._waiters.get(email, 0)
            ts = self._last_seen.get(email)
        if waiters > 0:
            return True
        return ts is not None and (time.monotonic() - ts) < _CONNECTED_WINDOW

    def stats(self) -> dict[str, int]:
        """운영 관측용 집계. 이메일 등 개인 식별자는 노출하지 않는다."""
        now = time.monotonic()
        with self._lock:
            event_count = len(self._events)
            last_seen = list(self._last_seen.values())
            waiter_counts = list(self._waiters.values())
            pending_count = len(self._reasons)
        return {
            "registered_accounts": event_count,
            "connected_accounts": sum(
                1 for ts in last_seen if (now - ts) < _CONNECTED_WINDOW
            ),
            "long_poll_waiters": sum(waiter_counts),
            "pending_signal_accounts": pending_count,
        }


# 앱 전역 단일 인스턴스
agent_signals = AgentSignals()
