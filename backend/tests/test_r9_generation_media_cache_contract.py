"""R9 GMC-1/GMC-2 — 프로세스 다운로드 상한과 예외 회수 계약."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from app import repo
from app.services import media_cache
from app.usecases import generation_media_cache


def _generation(prefix: str, count: int) -> dict:
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


def test_concurrent_generations_share_process_download_limit():
    async def scenario() -> None:
        active = 0
        started = 0
        peak = 0
        first_wave_started = asyncio.Event()
        release = asyncio.Event()

        async def controlled_download(url: str):
            nonlocal active, started, peak
            active += 1
            started += 1
            peak = max(peak, active)
            if active == generation_media_cache._DOWNLOAD_CONCURRENCY:
                first_wave_started.set()
            try:
                await release.wait()
                name = url.rsplit("/", 1)[-1]
                return media_cache.MediaCacheResult(
                    f"/media/{name}", "cached", 1
                )
            finally:
                active -= 1

        with (
            patch.object(media_cache, "cache_url_result", new=controlled_download),
            patch.object(repo, "apply_generation_media_cache_updates") as apply_updates,
        ):
            task = asyncio.gather(
                generation_media_cache.cache_generation_media(
                    _generation("first", 8)
                ),
                generation_media_cache.cache_generation_media(
                    _generation("second", 8)
                ),
            )
            await asyncio.wait_for(first_wave_started.wait(), timeout=1)
            await asyncio.sleep(0)
            assert started == generation_media_cache._DOWNLOAD_CONCURRENCY
            assert peak == generation_media_cache._DOWNLOAD_CONCURRENCY
            release.set()
            results = await task

        assert [result["cached"] for result in results] == [8, 8]
        assert apply_updates.call_count == 2

    asyncio.run(scenario())


def test_unexpected_error_waits_for_queued_siblings_and_applies_successes():
    async def scenario() -> None:
        started = 0
        queued_sibling_started = asyncio.Event()
        release_successes = asyncio.Event()

        async def controlled_download(url: str):
            nonlocal started
            started += 1
            if started == 7:
                queued_sibling_started.set()
            if url.endswith("broken-0.png"):
                raise RuntimeError("unexpected download failure")
            await release_successes.wait()
            name = url.rsplit("/", 1)[-1]
            return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

        with (
            patch.object(media_cache, "cache_url_result", new=controlled_download),
            patch.object(repo, "apply_generation_media_cache_updates") as apply_updates,
        ):
            task = asyncio.create_task(
                generation_media_cache.cache_generation_media(
                    _generation("broken", 7)
                )
            )
            await asyncio.wait_for(queued_sibling_started.wait(), timeout=1)
            await asyncio.sleep(0)
            assert not task.done()

            release_successes.set()
            with pytest.raises(RuntimeError, match="unexpected download failure"):
                await task

        updates = apply_updates.call_args.args[0]
        assert len(updates) == 6
        assert {update[1] for update in updates} == {
            f"broken-{index}" for index in range(1, 7)
        }

    asyncio.run(scenario())


def test_caller_cancellation_drains_downloads_then_propagates():
    async def scenario() -> None:
        started = 0
        all_started = asyncio.Event()
        release = asyncio.Event()

        async def controlled_download(url: str):
            nonlocal started
            started += 1
            if started == 2:
                all_started.set()
            await release.wait()
            name = url.rsplit("/", 1)[-1]
            return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

        with (
            patch.object(media_cache, "cache_url_result", new=controlled_download),
            patch.object(repo, "apply_generation_media_cache_updates") as apply_updates,
        ):
            task = asyncio.create_task(
                generation_media_cache.cache_generation_media(
                    _generation("cancelled", 2)
                )
            )
            await asyncio.wait_for(all_started.wait(), timeout=1)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()

            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task

        assert len(apply_updates.call_args.args[0]) == 2

    asyncio.run(scenario())


def test_child_cancelled_error_is_not_swallowed():
    async def scenario() -> None:
        async def controlled_download(url: str):
            if url.endswith("child-cancelled-0.png"):
                raise asyncio.CancelledError()
            name = url.rsplit("/", 1)[-1]
            return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

        with (
            patch.object(media_cache, "cache_url_result", new=controlled_download),
            patch.object(repo, "apply_generation_media_cache_updates") as apply_updates,
        ):
            with pytest.raises(asyncio.CancelledError):
                await generation_media_cache.cache_generation_media(
                    _generation("child-cancelled", 2)
                )

        updates = apply_updates.call_args.args[0]
        assert [update[1] for update in updates] == ["child-cancelled-1"]

    asyncio.run(scenario())


def test_download_limiter_isolated_across_event_loops():
    async def yielding_download(url: str):
        # 7번째 acquire가 실제로 대기해 세마포어를 현재 loop에 귀속시킨다.
        await asyncio.sleep(0)
        name = url.rsplit("/", 1)[-1]
        return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)

    async def run_once(prefix: str) -> None:
        result = await generation_media_cache.cache_generation_media(
            _generation(prefix, 7)
        )
        assert result["cached"] == 7

    with (
        patch.object(media_cache, "cache_url_result", new=yielding_download),
        patch.object(repo, "apply_generation_media_cache_updates"),
    ):
        asyncio.run(run_once("first-loop"))
        asyncio.run(run_once("second-loop"))
