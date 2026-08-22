"""R8 GMC-1 — 생성물 미디어 다운로드 상한과 일괄 transaction-root 계약."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app import db, repo
from app.services import media_cache
from app.usecases import generation_media_cache


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    """운영 기본인 풀 ON에서 트랜잭션 잔류와 중첩 연결을 드러낸다."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_assets(*rows: tuple[str, str]) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, worker_id, prompt, status) "
            "VALUES('g-media', 'me', 'prompt', 'done')"
        )
        for asset_id, remote_url in rows:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES(?, 'g-media', 'image', ?)",
                (asset_id, remote_url),
            )


def _assert_pool_connection_clean() -> None:
    with db.get_connection() as conn:
        assert not conn.in_transaction


def test_one_generation_download_concurrency_never_exceeds_six():
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
            if started == 6:
                first_wave_started.set()
            try:
                await release.wait()
                name = url.rsplit("/", 1)[-1]
                return media_cache.MediaCacheResult(f"/media/{name}", "cached", 1)
            finally:
                active -= 1

        generation = {
            "assets": [
                {
                    "id": f"asset-{index}",
                    "file_path": f"https://cdn.example.com/{index}.png",
                    "type": "image",
                }
                for index in range(14)
            ],
            "references": [],
        }
        with (
            patch.object(media_cache, "cache_url_result", new=controlled_download),
            patch.object(media_cache, "local_media_exists", return_value=False),
            patch.object(repo, "apply_generation_media_cache_updates") as apply_updates,
        ):
            task = asyncio.create_task(
                generation_media_cache.cache_generation_media(generation)
            )
            await asyncio.wait_for(first_wave_started.wait(), timeout=1)
            await asyncio.sleep(0)
            assert started == 6
            assert peak == 6
            release.set()
            result = await task

        assert peak == 6
        assert result["cached"] == 14
        assert len(apply_updates.call_args.args[0]) == 14

    asyncio.run(scenario())


def test_partial_download_failure_updates_only_successes_and_can_retry(pooled_db):
    success_url = "https://cdn.example.com/success.png"
    failed_url = "https://cdn.example.com/retry.png"
    _seed_assets(("asset-success", success_url), ("asset-retry", failed_url))
    generation = {
        "assets": [
            {"id": "asset-success", "file_path": success_url, "type": "image"},
            {"id": "asset-retry", "file_path": failed_url, "type": "image"},
        ],
        "references": [],
    }

    async def first_attempt(url: str):
        if url == failed_url:
            return media_cache.MediaCacheResult(
                None, "transient", error_code="network_error"
            )
        return media_cache.MediaCacheResult("/media/success.png", "cached", 11)

    with (
        patch.object(media_cache, "cache_url_result", new=first_attempt),
        patch.object(media_cache, "local_media_exists", return_value=False),
    ):
        result = asyncio.run(
            generation_media_cache.cache_generation_media(generation)
        )

    assert result["cached"] == 1
    assert result["failed"] == 1
    assert result["retryable"] == 1
    assert result["failure_codes"] == {"network_error": 1}
    with db.get_connection() as conn:
        rows = {
            row["id"]: (row["file_path"], row["source_url"])
            for row in conn.execute(
                "SELECT id, file_path, source_url FROM asset ORDER BY id"
            ).fetchall()
        }
    assert rows["asset-success"] == ("/media/success.png", success_url)
    assert rows["asset-retry"] == (failed_url, None)

    attempted: list[str] = []

    async def retry(url: str):
        attempted.append(url)
        return media_cache.MediaCacheResult("/media/retry.png", "cached", 7)

    retry_generation = {
        "assets": [
            {"id": "asset-retry", "file_path": failed_url, "type": "image"}
        ],
        "references": [],
    }
    with (
        patch.object(media_cache, "cache_url_result", new=retry),
        patch.object(media_cache, "local_media_exists", return_value=False),
    ):
        retry_result = asyncio.run(
            generation_media_cache.cache_generation_media(retry_generation)
        )

    assert attempted == [failed_url]
    assert retry_result["cached"] == 1
    with db.get_connection() as conn:
        retry_row = conn.execute(
            "SELECT file_path, source_url FROM asset WHERE id='asset-retry'"
        ).fetchone()
    assert tuple(retry_row) == ("/media/retry.png", failed_url)


def test_batch_cache_update_is_single_transaction_root_and_rolls_back(
    pooled_db, monkeypatch
):
    from app.repo import generations as generations_repo

    first_url = "https://cdn.example.com/first.png"
    second_url = "https://cdn.example.com/second.png"
    _seed_assets(("asset-first", first_url), ("asset-second", second_url))
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO reference(id, type, file_path) "
            "VALUES('ref-first', 'image', ?)",
            (first_url,),
        )

    original_get_connection = generations_repo.get_connection
    connection_contexts = 0

    @contextmanager
    def counted_get_connection():
        nonlocal connection_contexts
        connection_contexts += 1
        with original_get_connection() as conn:
            yield conn

    monkeypatch.setattr(generations_repo, "get_connection", counted_get_connection)
    repo.apply_generation_media_cache_updates(
        [
            ("asset", "asset-first", "/media/first.png", "/media/first.png", first_url),
            ("asset", "asset-second", "/media/second.png", "/media/second.png", second_url),
            ("ref", "ref-first", "/media/ref-first.png", "/media/ref-first.png", first_url),
        ]
    )
    assert connection_contexts == 1
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        ref_row = conn.execute(
            "SELECT file_path, source_url FROM reference WHERE id='ref-first'"
        ).fetchone()
    assert tuple(ref_row) == ("/media/ref-first.png", first_url)

    connection_contexts = 0
    with pytest.raises(ValueError, match="지원하지 않는 미디어 캐시 종류"):
        repo.apply_generation_media_cache_updates(
            [
                ("asset", "asset-first", "/media/rolled-back.png", None, first_url),
                ("invalid", "asset-second", "/media/invalid.png", None, second_url),
            ]
        )
    assert connection_contexts == 1
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        rows = {
            row["id"]: row["file_path"]
            for row in conn.execute(
                "SELECT id, file_path FROM asset ORDER BY id"
            ).fetchall()
        }
    assert rows == {
        "asset-first": "/media/first.png",
        "asset-second": "/media/second.png",
    }
