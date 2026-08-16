"""공유·최종 원본 보존 큐의 영속 상태와 재시도 규칙."""

from __future__ import annotations

import asyncio
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
