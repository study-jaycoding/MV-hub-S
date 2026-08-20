"""생성 상태 텔레메트리의 즉시·비차단 전송 회귀 테스트."""

import asyncio
import threading
import time
from unittest.mock import patch

import pytest

from app import db
from app.routers import _telemetry


@pytest.fixture
def isolated_content_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    try:
        yield
    finally:
        db.flush_pool()


def _reset_scheduler() -> None:
    task = _telemetry._drain_task
    if task is not None and not task.done():
        task.cancel()
    _telemetry._drain_task = None
    _telemetry._drain_version = 0
    _telemetry.unbind_telemetry_loop()
    with _telemetry._drain_state:
        _telemetry._drain_in_flight = False
        _telemetry._drain_requested = False
        _telemetry._drain_state.notify_all()


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


def test_management_disabled_never_schedules_or_drains(isolated_content_db):
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


def test_100_sync_workers_coalesce_on_bound_runtime_loop_without_waiting():
    async def scenario():
        _reset_scheduler()
        with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
            _telemetry, "_DEBOUNCE_SECONDS", 0.05
        ), patch.object(_telemetry, "drain_telemetry") as drain:
            _telemetry.bind_telemetry_loop(asyncio.get_running_loop())
            scheduled = await asyncio.gather(
                *(asyncio.to_thread(_telemetry.schedule_telemetry_drain) for _ in range(100))
            )
            assert all(scheduled)
            assert await _telemetry.wait_for_telemetry_drain(timeout=1)
            drain.assert_called_once_with()
        _reset_scheduler()

    asyncio.run(scenario())


def test_concurrent_drain_returns_immediately_and_owner_runs_followup(
    isolated_content_db,
):
    _reset_scheduler()
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def slow_remote(_push, *, my_uid):
        nonlocal calls
        assert my_uid == "u_me"
        calls += 1
        if calls == 1:
            started.set()
            assert release.wait(timeout=2)
        return {"target": "remote", "upserted": 0, "failed": 0}

    with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
        _telemetry._proxy, "proxying", return_value=True
    ), patch.object(_telemetry.repo, "get_my_uid", return_value="u_me"), patch.object(
        _telemetry, "drain_remote_telemetry", side_effect=slow_remote
    ):
        owner = threading.Thread(target=_telemetry.drain_telemetry)
        owner.start()
        assert started.wait(timeout=1)
        before = time.monotonic()
        assert _telemetry.drain_telemetry() is False
        assert time.monotonic() - before < 0.2
        release.set()
        owner.join(timeout=2)

    assert not owner.is_alive()
    assert calls == 2
    assert _telemetry._wait_for_drain_idle(0.1)
    _reset_scheduler()


def test_failed_owner_releases_state_for_next_retry():
    _reset_scheduler()
    with patch.object(_telemetry, "MANAGE_ENABLED", True), patch.object(
        _telemetry, "_drain_once", side_effect=[RuntimeError("boom"), None]
    ) as drain_once:
        with pytest.raises(RuntimeError, match="boom"):
            _telemetry.drain_telemetry()
        assert _telemetry._wait_for_drain_idle(0.1)
        assert _telemetry.drain_telemetry() is True

    assert drain_once.call_count == 2
    _reset_scheduler()


def test_manage_off_proxy_drain_does_not_touch_account_report_sidecar():
    """MANAGE off 설치본 계약 — 프록시 모드라도 드레인이 사이드카(계정 보고 outbox)
    스키마 생성·조회를 하지 않는다. off 는 ingest 인라인 레거시 경로만 쓴다."""
    _reset_scheduler()
    with patch.object(_telemetry, "MANAGE_ENABLED", False), patch.object(
        _telemetry._proxy, "proxying", return_value=True
    ), patch.object(
        _telemetry.repo, "get_my_uid", return_value="u_me"
    ), patch.object(
        _telemetry, "drain_remote_telemetry"
    ) as telemetry_drain, patch.object(
        _telemetry, "drain_remote_account_reports"
    ) as report_drain:
        assert _telemetry.drain_telemetry() is True

    telemetry_drain.assert_not_called()
    report_drain.assert_not_called()
    _reset_scheduler()
