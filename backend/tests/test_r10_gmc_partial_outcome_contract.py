"""R10 P2-3 — GMC 원예외 계약과 보존 claim 부분 결과 정산."""

from __future__ import annotations

import asyncio

import pytest

from app import db, repo
from app.services import media_cache, media_preservation
from app.usecases import generation_media_cache


def _generation(prefix: str, count: int = 7) -> dict:
    return {
        "assets": [
            {
                "id": f"{prefix}-{index}",
                "file_path": f"https://cdn.example.com/{prefix}-{index}.png",
                "type": "image",
            }
            for index in range(count)
        ],
        "references": [],
    }


@pytest.fixture
def preservation_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    generation = _generation("partial-claim")
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "partial outcome"},
        "me",
        generation_id="partial-outcome-generation",
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
        conn.executemany(
            "INSERT INTO asset(id, generation_id, type, file_path) "
            "VALUES(?, ?, 'image', ?)",
            [
                (asset["id"], gen_id, asset["file_path"])
                for asset in generation["assets"]
            ],
        )
    assert repo.request_media_preservation(gen_id, "shared") is True
    try:
        yield gen_id
    finally:
        db.flush_pool()


def test_preservation_finishes_with_six_successes_and_one_internal_error(
    preservation_db, monkeypatch
):
    gen_id = preservation_db

    async def controlled_download(url: str):
        if url.endswith("partial-claim-0.png"):
            raise RuntimeError("unexpected sibling failure")
        name = url.rsplit("/", 1)[-1]
        return media_cache.MediaCacheResult(f"/media/{name}", "cached", 10)

    monkeypatch.setattr(media_cache, "cache_url_result", controlled_download)

    result = asyncio.run(media_preservation.preserve_generation_now(gen_id))

    assert result["cached"] == 6
    assert result["failed"] == 1
    assert result["bytes_cached"] == 60
    assert result["status"] == "partial"
    assert result["error_code"] == "internal_error"

    state = repo.get_media_preservation(gen_id)
    assert state["cached_count"] == 6
    assert state["failed_count"] == 1
    assert state["bytes_cached"] == 60
    assert state["status"] == "partial"
    assert state["error_code"] == "internal_error"
    assert state["next_retry_at"] is not None

    with db.get_connection() as conn:
        paths = {
            row["id"]: row["file_path"]
            for row in conn.execute(
                "SELECT id, file_path FROM asset WHERE generation_id=? ORDER BY id",
                (gen_id,),
            ).fetchall()
        }
    assert paths["partial-claim-0"] == (
        "https://cdn.example.com/partial-claim-0.png"
    )
    assert sum(path.startswith("/media/") for path in paths.values()) == 6

    # partial은 예약 시각이 도래하면 기존 claim 경로에서 다시 선점된다.
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE media_preservation SET next_retry_at=datetime('now') "
            "WHERE generation_id=?",
            (gen_id,),
        )
    retry_claim = repo.claim_media_preservation(gen_id)
    assert retry_claim is not None
    assert retry_claim["attempts"] == 2


def test_direct_cache_call_rethrows_the_original_exception(monkeypatch):
    original_error = RuntimeError("original unexpected failure")
    applied_updates: list[tuple] = []

    async def controlled_download(url: str):
        if url.endswith("direct-0.png"):
            raise original_error
        name = url.rsplit("/", 1)[-1]
        return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

    def apply_updates(updates, **_kwargs):
        applied_updates.extend(updates)

    monkeypatch.setattr(media_cache, "cache_url_result", controlled_download)
    monkeypatch.setattr(
        repo, "apply_generation_media_cache_updates", apply_updates
    )

    async def scenario() -> None:
        with pytest.raises(RuntimeError) as raised:
            await generation_media_cache.cache_generation_media(
                _generation("direct")
            )
        assert raised.value is original_error

    asyncio.run(scenario())
    assert len(applied_updates) == 6


def test_caller_cancellation_applies_successes_before_propagating(monkeypatch):
    all_started = asyncio.Event()
    release = asyncio.Event()
    started = 0
    applied_updates: list[tuple] = []

    async def controlled_download(url: str):
        nonlocal started
        started += 1
        if started == 2:
            all_started.set()
        await release.wait()
        name = url.rsplit("/", 1)[-1]
        return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

    def apply_updates(updates, **_kwargs):
        applied_updates.extend(updates)

    monkeypatch.setattr(media_cache, "cache_url_result", controlled_download)
    monkeypatch.setattr(
        repo, "apply_generation_media_cache_updates", apply_updates
    )

    async def scenario() -> None:
        task = asyncio.create_task(
            generation_media_cache.cache_generation_media(
                _generation("caller-cancelled", count=2)
            )
        )
        await asyncio.wait_for(all_started.wait(), timeout=1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()

        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert len(applied_updates) == 2
