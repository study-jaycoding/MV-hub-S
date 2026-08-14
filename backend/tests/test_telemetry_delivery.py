"""생성 상태 텔레메트리의 즉시·비차단 전송 회귀 테스트."""

import asyncio
import threading
from unittest.mock import patch

from app.routers import _telemetry


def _reset_scheduler() -> None:
    task = _telemetry._drain_task
    if task is not None and not task.done():
        task.cancel()
    _telemetry._drain_task = None
    _telemetry._drain_version = 0


def test_rapid_status_changes_are_coalesced_into_one_background_drain():
    async def scenario():
        _reset_scheduler()
        with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
            _telemetry, "_DEBOUNCE_SECONDS", 0.01
        ), patch.object(_telemetry, "drain_telemetry") as drain:
            # 사용자 100명이 거의 동시에 상태를 바꿔도 전송 작업은 하나로 합쳐진다.
            assert all(_telemetry.schedule_telemetry_drain() for _ in range(100))
            await asyncio.sleep(0.08)
            assert drain.call_count == 1
        _reset_scheduler()

    asyncio.run(scenario())


def test_change_while_sending_causes_one_followup_drain():
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def slow_drain():
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            release.wait(timeout=1)

    async def scenario():
        _reset_scheduler()
        with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
            _telemetry, "_DEBOUNCE_SECONDS", 0.01
        ), patch.object(_telemetry, "drain_telemetry", side_effect=slow_drain):
            _telemetry.schedule_telemetry_drain()
            await asyncio.to_thread(started.wait, 1)
            _telemetry.schedule_telemetry_drain()
            release.set()
            await asyncio.sleep(0.08)
            assert calls == 2
        _reset_scheduler()

    asyncio.run(scenario())


def test_management_disabled_never_schedules_or_drains():
    async def scenario():
        _reset_scheduler()
        with patch.object(_telemetry, "MANAGE_ENABLED", False), patch.object(
            _telemetry, "drain_telemetry"
        ) as drain:
            assert _telemetry.schedule_telemetry_drain() is False
            await asyncio.sleep(0)
            drain.assert_not_called()
        _reset_scheduler()

    asyncio.run(scenario())


def test_shutdown_waits_for_scheduled_drain_to_finish():
    release = threading.Event()

    async def scenario():
        _reset_scheduler()

        def slow_drain():
            release.wait(timeout=1)

        with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
            _telemetry, "_DEBOUNCE_SECONDS", 0
        ), patch.object(_telemetry, "drain_telemetry", side_effect=slow_drain):
            assert _telemetry.schedule_telemetry_drain()
            waiter = asyncio.create_task(_telemetry.wait_for_telemetry_drain(timeout=1))
            await asyncio.sleep(0.02)
            assert not waiter.done()
            release.set()
            assert await waiter is True
        _reset_scheduler()

    asyncio.run(scenario())
