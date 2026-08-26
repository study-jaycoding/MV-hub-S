"""직접 Resolve 전송의 진행 카운터 — 업데이트 차단이 읽는 값(정상·예외·취소·동시·진입 순서)."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.routers import release_update as release_update_router
from app.routers import resolve_integration
from app.services import resolve_queue, resolve_transfer


def test_counter_rises_inside_and_returns_to_zero_after_normal_and_error_exit():
    async def run():
        assert resolve_transfer.active_transfer_count() == 0
        async with resolve_transfer.track_active():
            assert resolve_transfer.active_transfer_count() == 1
        assert resolve_transfer.active_transfer_count() == 0
        with pytest.raises(RuntimeError):
            async with resolve_transfer.track_active():
                raise RuntimeError("boom")
        assert resolve_transfer.active_transfer_count() == 0

    asyncio.run(run())


def test_two_concurrent_transfers_count_two():
    async def run():
        gate = asyncio.Event()

        async def one():
            async with resolve_transfer.track_active():
                await gate.wait()

        tasks = [asyncio.create_task(one()) for _ in range(2)]
        await asyncio.sleep(0)
        assert resolve_transfer.active_transfer_count() == 2
        gate.set()
        await asyncio.gather(*tasks)
        assert resolve_transfer.active_transfer_count() == 0

    asyncio.run(run())


def test_cancelled_request_keeps_counting_until_non_abandon_work_finishes():
    """run_non_abandon 안의 작업은 취소 뒤에도 끝까지 돌고, 그동안 카운트는 유지된다."""

    async def run():
        started = asyncio.Event()
        release = asyncio.Event()
        finished = asyncio.Event()

        async def work():
            started.set()
            await release.wait()
            finished.set()
            return "done"

        async def handler():
            async with resolve_transfer.track_active():
                return await resolve_queue.run_non_abandon(work())

        task = asyncio.create_task(handler())
        await started.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert resolve_transfer.active_transfer_count() == 1  # 취소됐지만 내부 작업이 아직 돈다
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
        assert resolve_transfer.active_transfer_count() == 0

    asyncio.run(run())


def test_update_gate_is_checked_after_the_counter_is_raised_and_rejects_with_409(monkeypatch):
    """순서 계약: 카운터 증가 → update_in_progress 게이트. 게이트가 볼 때 이미 1이어야 한다."""
    seen: list[int] = []

    def fake_update_in_progress():
        seen.append(resolve_transfer.active_transfer_count())
        return True

    monkeypatch.setattr(resolve_integration, "_require_local_resolve", lambda request: None)
    monkeypatch.setattr(resolve_integration, "update_in_progress", fake_update_in_progress)

    async def run():
        with pytest.raises(HTTPException) as caught:
            await resolve_integration.create_resolve_transfer(
                resolve_integration.ResolveTransferIn(gen_ids=["gen-1"]), object()
            )
        assert caught.value.status_code == 409
        with pytest.raises(HTTPException) as caught:
            await resolve_integration.retry_resolve_transfer(
                resolve_integration.ResolveRetryIn(project_id="p1", transfer_id="t1"), object()
            )
        assert caught.value.status_code == 409

    asyncio.run(run())
    assert seen == [1, 1]
    assert resolve_transfer.active_transfer_count() == 0


def test_transfer_in_flight_blocks_the_update_activity_check(monkeypatch):
    """반대 순서: 전송이 먼저 올라가 있으면 업데이트의 활동 확인(워커 스레드)이 busy 를 본다."""
    monkeypatch.setattr(
        release_update_router, "generation_queue_snapshot", lambda: {"active_total": 0}
    )
    monkeypatch.setattr(release_update_router.comfy, "active_run_job_count", lambda: 0)

    async def run():
        async with resolve_transfer.track_active():
            activity = await asyncio.to_thread(release_update_router._activity)
            guarded = await asyncio.to_thread(
                release_update_router._with_activity, {"can_update": True}
            )
        return activity, guarded

    activity, guarded = asyncio.run(run())
    assert activity["resolve_active"] == 1
    assert activity["active_total"] == 1
    assert guarded["can_update"] is False
    assert release_update_router._activity()["resolve_active"] == 0


def test_gate_reads_the_real_update_state_file(monkeypatch, tmp_path):
    """업데이트가 checking 을 기록한 뒤 들어온 전송은 409, 기록이 비활성이면 게이트를 통과한다."""
    import contextlib

    from app.services import release_update as svc

    class Passed(Exception):
        pass

    @contextlib.asynccontextmanager
    async def _no_pin():
        yield ""

    async def _boom(body, request):
        raise Passed()

    monkeypatch.setattr(resolve_integration, "_require_local_resolve", lambda request: None)
    monkeypatch.setattr(
        resolve_integration, "update_in_progress", lambda: svc.update_in_progress(root=tmp_path)
    )
    monkeypatch.setattr(resolve_integration, "_pinned_account_scope", _no_pin)
    monkeypatch.setattr(resolve_integration, "_create_resolve_transfer_pinned", _boom)
    body = resolve_integration.ResolveTransferIn(gen_ids=["gen-1"])

    async def run():
        svc.write_state("checking", "확인 중", root=tmp_path, current_version="x")
        with pytest.raises(HTTPException) as caught:
            await resolve_integration.create_resolve_transfer(body, object())
        assert caught.value.status_code == 409
        assert resolve_transfer.active_transfer_count() == 0
        svc.write_state("up_to_date", "최신", root=tmp_path, current_version="x")
        with pytest.raises(Passed):
            await resolve_integration.create_resolve_transfer(body, object())
        assert resolve_transfer.active_transfer_count() == 0

    asyncio.run(run())


def test_queue_routes_are_gone_but_direct_transfer_routes_remain():
    paths = {getattr(route, "path", "") for route in resolve_integration.router.routes}
    assert not any(path.startswith("/api/resolve/queue") for path in paths), paths
    for keep in ("/api/resolve/transfers", "/api/resolve/transfers/retry",
                 "/api/resolve/transfers/pending", "/api/resolve/locks", "/api/resolve/status"):
        assert keep in paths, keep
