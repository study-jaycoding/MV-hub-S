"""공유·최종 원본 보존 큐의 영속 상태와 재시도 규칙."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import pytest

from app import db, repo
from app.services import media_preservation


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "preserve"},
        "me",
        generation_id="preserve-1",
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    try:
        yield gen_id
    finally:
        db.flush_pool()


def test_request_claim_finish_and_force_retry_are_persistent(isolated_content_db):
    gen_id = isolated_content_db
    assert repo.request_media_preservation(gen_id, "shared") is True
    claimed = repo.claim_media_preservation(gen_id)
    assert claimed["generation_id"] == gen_id
    assert claimed["attempts"] == 1

    repo.finish_media_preservation(
        gen_id,
        status="complete",
        cached_count=2,
        failed_count=0,
        skipped_count=0,
        bytes_cached=123,
    )
    state = repo.get_media_preservation(gen_id)
    assert state["status"] == "complete"
    assert state["bytes_cached"] == 123
    assert repo.claim_media_preservation(gen_id) is None

    assert repo.request_media_preservation(gen_id, "final", force=True) is True
    state = repo.get_media_preservation(gen_id)
    assert state["reason"] == "final"
    assert state["status"] == "pending"


def test_concurrent_requests_collapse_to_one_row_and_keep_strongest_reason(isolated_content_db):
    gen_id = isolated_content_db
    reasons = ["shared", "final", "manual", "shared", "final", "admin"]
    with ThreadPoolExecutor(max_workers=len(reasons)) as pool:
        results = list(pool.map(lambda reason: repo.request_media_preservation(gen_id, reason), reasons))

    assert all(results)
    assert repo.get_media_preservation(gen_id)["reason"] == "final"
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM media_preservation WHERE generation_id=?", (gen_id,)
        ).fetchone()[0] == 1


def test_generation_response_exposes_preservation_state(isolated_content_db):
    gen_id = isolated_content_db
    repo.request_media_preservation(gen_id, "shared")
    generation = repo.get_generation(gen_id)
    assert generation["media_preservation_reason"] == "shared"
    assert generation["media_preservation_status"] == "pending"
    assert generation["media_preservation_attempts"] == 0


def test_startup_recovery_requeues_every_running_job(isolated_content_db):
    gen_id = isolated_content_db
    repo.request_media_preservation(gen_id, "shared")
    assert repo.claim_media_preservation(gen_id)["status"] == "running"
    assert repo.recover_stale_media_preservations() == 1
    assert repo.get_media_preservation(gen_id)["status"] == "pending"


def test_startup_backfill_queues_existing_shared_and_final_generations(isolated_content_db):
    first_id = isolated_content_db
    second_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "already final"},
        "me",
        generation_id="preserve-2",
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (second_id,))
    repo.publish(first_id, "me")
    repo.set_final(second_id, True, "me")

    assert repo.backfill_required_media_preservations() == 2
    assert repo.get_media_preservation(first_id)["reason"] == "shared"
    assert repo.get_media_preservation(second_id)["reason"] == "final"
    assert repo.backfill_required_media_preservations() == 0

    with db.get_connection() as conn:
        conn.execute(
            "UPDATE media_preservation SET reason='shared' WHERE generation_id=?",
            (second_id,),
        )
    assert repo.backfill_required_media_preservations() == 0
    assert repo.get_media_preservation(second_id)["reason"] == "final"


def test_transient_failure_schedules_retry_without_raw_error(isolated_content_db):
    gen_id = isolated_content_db
    repo.request_media_preservation(gen_id, "shared")
    result = {
        "cached": 1,
        "already": 0,
        "failed": 1,
        "skipped": 0,
        "bytes_cached": 10,
        "failure_codes": {"network_error": 1},
        "retryable": 1,
    }
    with mock.patch.object(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        new=mock.AsyncMock(return_value=result),
    ):
        out = asyncio.run(media_preservation.preserve_generation_now(gen_id))

    assert out["status"] == "partial"
    state = repo.get_media_preservation(gen_id)
    assert state["status"] == "partial"
    assert state["next_retry_at"] is not None
    assert state["error_code"] == "network_error"
    assert "http" not in str(state).lower()


def test_capacity_failure_is_visible_and_existing_cache_is_not_deleted(isolated_content_db):
    gen_id = isolated_content_db
    repo.request_media_preservation(gen_id, "final")
    result = {
        "cached": 0,
        "already": 1,
        "failed": 1,
        "skipped": 0,
        "bytes_cached": 0,
        "failure_codes": {"capacity": 1},
        "retryable": 1,
    }
    with mock.patch.object(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        new=mock.AsyncMock(return_value=result),
    ):
        out = asyncio.run(media_preservation.preserve_generation_now(gen_id))

    assert out["status"] == "capacity"
    state = repo.get_media_preservation(gen_id)
    assert state["cached_count"] == 1
    assert state["next_retry_at"] is not None


def test_async_preservation_repo_calls_do_not_block_event_loop(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    call_threads: list[int] = []

    def claim(gen_id):
        call_threads.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        return {"generation_id": gen_id, "attempts": 1}

    def get_generation(gen_id):
        call_threads.append(threading.get_ident())
        return {"id": gen_id}

    def finish(*_args, **_kwargs):
        call_threads.append(threading.get_ident())

    monkeypatch.setattr(media_preservation.repo, "claim_media_preservation", claim)
    monkeypatch.setattr(media_preservation.repo, "get_generation", get_generation)
    monkeypatch.setattr(media_preservation.repo, "finish_media_preservation", finish)
    monkeypatch.setattr(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        mock.AsyncMock(
            return_value={
                "cached": 0,
                "already": 1,
                "failed": 0,
                "skipped": 0,
                "bytes_cached": 0,
            }
        ),
    )

    async def exercise():
        loop_thread = threading.get_ident()
        task = asyncio.create_task(media_preservation.preserve_generation_now("preserve-thread"))
        for _ in range(200):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        # 동기 claim이 대기 중이어도 이 지점까지 이벤트 루프가 진행돼야 한다.
        await asyncio.sleep(0)
        release.set()
        result = await asyncio.wait_for(task, timeout=2)
        return loop_thread, result

    loop_thread, result = asyncio.run(exercise())

    assert result["status"] == "complete"
    assert len(call_threads) == 3
    assert all(thread_id != loop_thread for thread_id in call_threads)


def test_periodic_startup_repo_calls_run_off_event_loop(monkeypatch):
    calls: list[tuple[str, int]] = []
    monkeypatch.setattr(media_preservation, "_STARTUP_DELAY_SECONDS", 60)
    monkeypatch.setattr(
        media_preservation.repo,
        "recover_stale_media_preservations",
        lambda: calls.append(("recover", threading.get_ident())),
    )
    monkeypatch.setattr(
        media_preservation.repo,
        "backfill_required_media_preservations",
        lambda: calls.append(("backfill", threading.get_ident())),
    )

    async def exercise():
        loop_thread = threading.get_ident()
        worker = media_preservation.PeriodicMediaPreservation()
        worker.start()
        for _ in range(200):
            if len(calls) == 2:
                break
            await asyncio.sleep(0.005)
        await worker.stop()
        return loop_thread

    loop_thread = asyncio.run(exercise())

    assert [name for name, _thread in calls] == ["recover", "backfill"]
    assert all(thread_id != loop_thread for _name, thread_id in calls)


def test_periodic_startup_retries_after_transient_failure(monkeypatch):
    attempts = 0
    backfilled = threading.Event()
    monkeypatch.setattr(media_preservation, "_STARTUP_DELAY_SECONDS", 60)

    def recover():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary database lock")

    monkeypatch.setattr(
        media_preservation.repo, "recover_stale_media_preservations", recover
    )
    monkeypatch.setattr(
        media_preservation.repo,
        "backfill_required_media_preservations",
        backfilled.set,
    )

    async def exercise():
        worker = media_preservation.PeriodicMediaPreservation(interval=0.01)
        worker.start()
        for _ in range(300):
            if backfilled.is_set():
                break
            await asyncio.sleep(0.005)
        assert worker._task is not None and not worker._task.done()
        await worker.stop()

    asyncio.run(exercise())

    assert attempts == 2
    assert backfilled.is_set()


def test_periodic_stop_waits_for_startup_recovery_thread(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(media_preservation, "_STARTUP_DELAY_SECONDS", 60)

    def blocking_recover():
        entered.set()
        assert release.wait(timeout=2)

    monkeypatch.setattr(
        media_preservation.repo,
        "recover_stale_media_preservations",
        blocking_recover,
    )

    async def exercise():
        worker = media_preservation.PeriodicMediaPreservation(interval=0.01)
        worker.start()
        for _ in range(200):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        stopping = asyncio.create_task(worker.stop())
        await asyncio.sleep(0.02)
        assert not stopping.done(), "복구 스레드가 끝나기 전에 stop이 반환하면 안 된다"
        release.set()
        await asyncio.wait_for(stopping, timeout=2)

    asyncio.run(exercise())
