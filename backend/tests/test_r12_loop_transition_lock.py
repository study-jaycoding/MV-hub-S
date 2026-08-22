"""R12-2 — 루프 위 transition_lock 잔여 제거(주기 보존 캡처 · 무의미 락 획득).

transition_lock 은 로그인 전환·DB 복원이 초 단위로 통째 쥔다. 이벤트 루프 스레드에서 이 락을
기다리면 그동안 서버 전체(HTTP·WS)가 멈춘다(R11 A1 이 막으려던 것).

  · media_preservation._claim_and_process_non_abandon 은 30초 주기 무조건 경로다 —
    계정 캡처를 워커 스레드에서 해야 한다(syncer.sync_now 와 같은 규율).
  · gen_requests._account_scoped 는 인자로 계정이 정해진 호출에서도 락을 잡고 있었다.
    락 안에서 읽는 공유 상태가 없으므로(값이 있으면 포인터를 보지 않음) 의미 변화 없이 제거된다.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from app import active_account, config
from app.services import media_preservation
from app.usecases import gen_requests


class _RecordingLock:
    """transition_lock 을 어느 스레드에서 잡았는지 기록하는 얇은 래퍼(test_r11_* 와 동일 방식)."""

    def __init__(self, inner, threads: list[int]) -> None:
        self._inner = inner
        self._threads = threads

    def __enter__(self):
        self._threads.append(threading.get_ident())
        return self._inner.__enter__()

    def __exit__(self, *exc_info):
        return self._inner.__exit__(*exc_info)


@pytest.fixture
def isolated_pointer(monkeypatch, tmp_path):
    """실제 active.json 을 건드리지 않는 계정 포인터(로컬 허브 = AUTH off 전제)."""
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    token = active_account.set_override(None)
    try:
        yield
    finally:
        active_account.reset_override(token)


# ── media_preservation ───────────────────────────────────────────────────────
def test_periodic_claim_captures_the_account_off_the_event_loop(
    isolated_pointer, monkeypatch
):
    """주기 보존의 계정 캡처는 워커 스레드에서 전환 락을 잡는다(루프 정지 금지)."""
    lock_threads: list[int] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, lock_threads),
    )
    monkeypatch.setattr(
        media_preservation.repo, "claim_media_preservation", lambda *a, **k: None
    )
    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await media_preservation._claim_and_process_non_abandon()

    result = asyncio.run(scenario())

    assert result is None
    assert lock_threads, "캡처는 여전히 전환 락 아래에서 일어난다"
    assert loop_threads[0] not in lock_threads


def test_periodic_claim_does_not_freeze_the_loop_while_the_lock_is_held(
    isolated_pointer, monkeypatch
):
    """전환 락이 잡혀 있어도 루프는 계속 돈다 — 30초 주기가 서버를 세우지 않는다."""
    monkeypatch.setattr(
        media_preservation.repo, "claim_media_preservation", lambda *a, **k: None
    )

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

        worker = asyncio.create_task(
            media_preservation._claim_and_process_non_abandon()
        )
        ticks = 0
        for _ in range(20):
            await asyncio.sleep(0.01)
            ticks += 1
        assert ticks == 20, "루프가 락 대기에 묶이면 여기까지 못 온다"
        assert not worker.done(), "캡처는 워커 스레드에서 락을 기다린다"

        release.set()
        holder.join(timeout=2)
        assert not holder.is_alive()
        assert await asyncio.wait_for(worker, 2.0) is None

    asyncio.run(scenario())


def test_preserve_generation_now_shares_the_same_capture_path(monkeypatch):
    """share._preserve_final_media 가 부르는 즉시 실행 경로도 같은 수정으로 해소된다."""
    calls: list[str] = []

    async def fake_claim(gen_id=None):
        calls.append(gen_id or "")
        return None

    monkeypatch.setattr(
        media_preservation, "_claim_and_process_non_abandon", fake_claim
    )

    assert asyncio.run(media_preservation.preserve_generation_now("gen-1")) is None
    assert calls == ["gen-1"], "즉시 실행도 주기 경로와 같은 함수를 탄다"


# ── gen_requests._account_scoped ─────────────────────────────────────────────
def _scoped_probe():
    """데코레이터가 어떤 계정 키로 고정했는지 돌려주는 최소 usecase 대역."""

    @gen_requests._account_scoped("email")
    def probe(email):
        return active_account.account_key() or ""

    return probe


def test_account_scope_skips_the_lock_when_the_email_is_given(
    isolated_pointer, monkeypatch
):
    """인자로 계정이 정해진 호출은 전환 락을 아예 잡지 않는다(읽는 공유 상태가 없음)."""
    lock_threads: list[int] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, lock_threads),
    )

    assert _scoped_probe()("caller@example.com") == "caller@example.com"
    assert lock_threads == [], "값이 있으면 락 전에 반환해야 한다"


def test_account_scope_still_locks_for_the_pointer_fallback(
    isolated_pointer, monkeypatch
):
    """값이 없을 때의 포인터 폴백 캡처는 그대로 락 아래에서 일어난다(의미 변화 0)."""
    active_account.set_active("pointer@example.com", "uid-x")  # set_active 도 같은 락을 쓴다 → 패치 전에
    lock_threads: list[int] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, lock_threads),
    )

    assert _scoped_probe()(None) == "pointer@example.com"
    assert lock_threads, "폴백 캡처는 여전히 전환 락 아래에서"
