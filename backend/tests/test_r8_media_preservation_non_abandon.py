"""R8 Wave 2 MP-1 — media preservation claim~finish 비포기·계정 범위 계약."""

from __future__ import annotations

import asyncio
import threading

import pytest

from app import active_account, config, db, repo
from app.services import media_preservation


A_EMAIL = "preserve-a@example.com"
B_EMAIL = "preserve-b@example.com"
_SUCCESS_RESULT = {
    "cached": 0,
    "already": 1,
    "failed": 0,
    "skipped": 0,
    "bytes_cached": 0,
    "failure_codes": {},
    "retryable": 0,
}


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "preserve"},
        "me",
        generation_id="preserve-r8",
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    repo.request_media_preservation(gen_id, "shared")
    try:
        yield gen_id
    finally:
        db.flush_pool()


@pytest.fixture
def account_pointer(monkeypatch, tmp_path):
    token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    active_account.set_active(A_EMAIL, "uid-a")
    try:
        yield
    finally:
        active_account.reset_override(token)


def test_repeated_cancel_waits_for_finish_after_claim(monkeypatch):
    download_started = asyncio.Event()
    release_download = asyncio.Event()
    finished = threading.Event()

    monkeypatch.setattr(
        media_preservation.repo,
        "claim_media_preservation",
        lambda gen_id: {"generation_id": gen_id, "attempts": 1},
    )
    monkeypatch.setattr(
        media_preservation.repo,
        "get_generation",
        lambda gen_id: {"id": gen_id},
    )

    async def cache_generation(_generation):
        download_started.set()
        await release_download.wait()
        return dict(_SUCCESS_RESULT)

    def finish(*_args, **_kwargs):
        finished.set()

    monkeypatch.setattr(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        cache_generation,
    )
    monkeypatch.setattr(media_preservation.repo, "finish_media_preservation", finish)

    async def scenario() -> None:
        task = asyncio.create_task(
            media_preservation.preserve_generation_now("cancel-after-claim")
        )
        await asyncio.wait_for(download_started.wait(), timeout=1)
        try:
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0.02)
            assert not task.done()
            assert not finished.is_set()
        finally:
            release_download.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert finished.is_set()


def test_processing_failure_finishes_claim_and_force_retry_can_run(
    isolated_content_db, monkeypatch
):
    gen_id = isolated_content_db
    calls = 0

    async def cache_generation(_generation):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("synthetic preservation failure")
        return dict(_SUCCESS_RESULT)

    monkeypatch.setattr(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        cache_generation,
    )

    first = asyncio.run(media_preservation.preserve_generation_now(gen_id))
    failed_state = repo.get_media_preservation(gen_id)
    assert first == {"status": "failed", "error_code": "internal_error"}
    assert failed_state["status"] == "failed"
    assert failed_state["cached_count"] == 0

    # 기존 재시도 정책대로 명시적 force 재등록 후 다음 claim이 가능해야 한다.
    assert repo.request_media_preservation(gen_id, "shared", force=True) is True
    second = asyncio.run(media_preservation.preserve_generation_now(gen_id))
    retried_state = repo.get_media_preservation(gen_id)
    assert second["status"] == "complete"
    assert retried_state["status"] == "complete"
    assert retried_state["attempts"] == 2


def test_account_switch_during_download_finishes_in_claimed_account(
    account_pointer, monkeypatch
):
    download_started = asyncio.Event()
    release_download = asyncio.Event()
    seen_scopes: list[tuple[str, str | None]] = []

    def observe(stage: str) -> None:
        seen_scopes.append((stage, active_account.account_key()))

    def claim(gen_id):
        observe("claim")
        return {"generation_id": gen_id, "attempts": 1}

    def get_generation(gen_id):
        observe("get")
        return {"id": gen_id}

    async def cache_generation(_generation):
        observe("download-start")
        download_started.set()
        await release_download.wait()
        observe("download-end")
        return dict(_SUCCESS_RESULT)

    def finish(*_args, **_kwargs):
        observe("finish")

    monkeypatch.setattr(media_preservation.repo, "claim_media_preservation", claim)
    monkeypatch.setattr(media_preservation.repo, "get_generation", get_generation)
    monkeypatch.setattr(media_preservation.repo, "finish_media_preservation", finish)
    monkeypatch.setattr(
        media_preservation.generation_media_cache,
        "cache_generation_media",
        cache_generation,
    )

    async def scenario() -> dict:
        task = asyncio.create_task(
            media_preservation.preserve_generation_now("account-scoped")
        )
        await asyncio.wait_for(download_started.wait(), timeout=1)
        switched = threading.Event()

        def switch_account() -> None:
            active_account.set_active(B_EMAIL, "uid-b")
            switched.set()

        switcher = threading.Thread(target=switch_account)
        switcher.start()
        try:
            assert await asyncio.to_thread(switched.wait, 0.5), (
                "다운로드 중 transition_lock을 보유했습니다"
            )
        finally:
            release_download.set()
        result = await task
        switcher.join(timeout=1)
        assert not switcher.is_alive()
        return result

    result = asyncio.run(scenario())

    assert result["status"] == "complete"
    assert seen_scopes and {scope for _stage, scope in seen_scopes} == {A_EMAIL}
    assert active_account.account_key() == B_EMAIL
