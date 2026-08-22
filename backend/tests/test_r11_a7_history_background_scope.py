"""R11 소형 후속 — history 백그라운드 경로의 전환 락 캡처(A7 잔여 2곳).

배치3은 history 라우트 2곳만 워커 스레드로 뺐고, 같은 파일의 백그라운드 경로
(auto_start_history_import · startup_history_audit)는 그대로 이벤트 루프에서
transition_lock 을 기다리고 있었다. 이 락은 로그인 마이그레이션·DB 복원 동안 통째로
잡혀 있어, 루프에서 기다리면 그동안 서버 전체(HTTP·WS)가 멈춘다.

계약: 두 함수가 도는 동안 transition_lock 은 이벤트 루프 스레드에서 획득되지 않는다.

★캡처한 키는 _start_history_task 로 넘겨야 한다. 안 넘기면 그 함수가 같은 값을 루프
스레드에서 다시 락 아래 캡처해(_start_history_task 는 create_task 때문에 루프에서 돈다)
방금 뺀 대기가 그대로 되살아난다 — 아래 첫 테스트가 그 인자 전달을 함께 못박는다.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from app import active_account, config
from app.services import history_autofill as autofill


A_EMAIL = "r11a7-a@example.com"


class _RecordingLock:
    """transition_lock 을 어느 스레드에서 잡았는지 기록하는 얇은 래퍼."""

    def __init__(self, inner, threads: list[int]) -> None:
        self._inner = inner
        self._threads = threads

    def __enter__(self):
        self._threads.append(threading.get_ident())
        return self._inner.__enter__()

    def __exit__(self, *exc_info):
        return self._inner.__exit__(*exc_info)


@pytest.fixture
def auto_ready(monkeypatch):
    """자동 보충 게이트를 열고 등록부를 격리한다(DB·파일 접근 없음).

    account_key() 가 포인터 파일을 읽지 않도록 바깥 오버라이드로 활성 계정을 고정한다.
    """
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(autofill, "AUTH_ENABLED", False)
    monkeypatch.setattr(autofill, "LOCAL_AGENT_PAIR_SECRET", "")
    monkeypatch.setattr(autofill, "EXTERNAL_RECOVERY_ENABLED", True)
    monkeypatch.setattr(autofill, "_HISTORY_TASKS", {})
    monkeypatch.setattr(autofill, "_HISTORY_STARTERS", set())
    monkeypatch.setattr(autofill, "_HISTORY_STOPPING", False)

    token = active_account.set_override(A_EMAIL)
    try:
        yield
    finally:
        active_account.reset_override(token)


@pytest.fixture
def lock_threads(monkeypatch) -> list[int]:
    threads: list[int] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, threads),
    )
    return threads


def test_a7_auto_start_keeps_the_transition_lock_off_the_loop(
    auto_ready, lock_threads, monkeypatch
) -> None:
    """gap 자동 시작의 계정 범위 캡처는 워커 스레드에서 락을 잡는다."""
    captured: list[str | None] = []

    def claim(email, cooldown, *, started_at=None):
        return True

    def start_task(key, acc, *, automatic, account_scope=None):
        captured.append(account_scope)
        return True

    monkeypatch.setattr(autofill.repo, "claim_history_auto_start", claim)
    monkeypatch.setattr(autofill, "_history_account", lambda email: {"email": email})
    monkeypatch.setattr(autofill, "_start_history_task", start_task)

    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await autofill.auto_start_history_import(A_EMAIL, reason="gap")

    started = asyncio.run(scenario())

    assert started is True
    assert captured == [A_EMAIL], (
        "캡처한 키를 넘겨야 _start_history_task 가 루프에서 다시 락을 잡지 않는다"
    )
    assert lock_threads, "전환 락 캡처 자체는 그대로 일어나야 한다"
    assert loop_threads[0] not in lock_threads


def test_a7_startup_audit_keeps_the_transition_lock_off_the_loop(
    auto_ready, lock_threads, monkeypatch
) -> None:
    """부팅 audit 의 계정 범위 캡처도 루프 스레드에서 락을 기다리지 않는다."""

    async def get_account_status(timeout=None):
        return {"connected": True, "email": A_EMAIL}

    async def auto_start(email, *, reason):
        assert reason == "startup"
        return True

    monkeypatch.setattr(autofill.cli_bridge, "get_account_status", get_account_status)
    monkeypatch.setattr(autofill.repo, "get_history_import_audit", lambda email: {})
    monkeypatch.setattr(
        autofill.repo, "history_success_is_recent", lambda email, seconds: False
    )
    monkeypatch.setattr(autofill, "auto_start_history_import", auto_start)

    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await autofill.startup_history_audit()

    assert asyncio.run(scenario()) is True
    assert lock_threads, "전환 락 캡처 자체는 그대로 일어나야 한다"
    assert loop_threads[0] not in lock_threads


def test_a7_background_capture_does_not_freeze_the_event_loop(
    auto_ready, monkeypatch
) -> None:
    """전환 락이 잡혀 있는 동안에도 루프는 계속 돈다(부팅 audit 이 서버를 세우지 않는다)."""
    monkeypatch.setattr(autofill.repo, "claim_history_auto_start", lambda *a, **k: True)
    monkeypatch.setattr(autofill, "_history_account", lambda email: {"email": email})
    monkeypatch.setattr(autofill, "_start_history_task", lambda *a, **k: True)

    async def scenario():
        release = threading.Event()
        holding = threading.Event()

        def hold_lock():
            with active_account.transition_lock:
                holding.set()
                release.wait(5.0)

        holder = threading.Thread(target=hold_lock)
        holder.start()
        assert holding.wait(2.0)

        task = asyncio.create_task(
            autofill.auto_start_history_import(A_EMAIL, reason="gap")
        )
        ticks = 0
        for _ in range(20):
            await asyncio.sleep(0.01)
            ticks += 1
        assert ticks == 20, "루프가 락 대기에 묶이면 여기까지 못 온다"
        assert not task.done(), "자동 시작은 락이 풀릴 때까지 워커 스레드에서 기다린다"

        release.set()
        holder.join(timeout=2)
        assert not holder.is_alive()
        assert await asyncio.wait_for(task, 2.0) is True

    asyncio.run(scenario())
