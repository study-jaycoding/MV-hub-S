"""공유/골드 desired-state 원장과 프록시 write-ahead 계약."""

from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse

from app import db, repo
from app.routers import publish, share


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting("shared_server_url", "http://share.example.test/")
    repo.set_setting("shared_server_token", "token")
    try:
        yield
    finally:
        db.flush_pool()


def _request():
    return SimpleNamespace(state=SimpleNamespace(account=None))


def _seed_generation(
    *, generation_id: str = "local-1", job_id: str = "server-1", shared: bool = False,
    final: bool = False,
) -> str:
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "share reconciliation"},
        "me",
        generation_id=generation_id,
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status='done', job_id=? WHERE id=?",
            (job_id, gen_id),
        )
    if shared:
        repo.publish(gen_id, "me", "team")
    if final:
        repo.set_final(gen_id, True, "me")
    return gen_id


def _ledger_rows() -> list[dict]:
    with db.get_connection() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM share_state_intent ORDER BY created_at, intent_id"
            ).fetchall()
        ]


def test_migration_is_idempotent_and_has_contract_indexes(isolated_content_db):
    db.init_db()
    db.init_db()

    with db.get_connection() as conn:
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(share_state_intent)")
        }
        indexes = {
            row["name"]
            for row in conn.execute("PRAGMA index_list(share_state_intent)")
        }

    assert {
        "intent_id",
        "server_origin",
        "server_generation_id",
        "job_anchor",
        "local_id",
        "operation_kind",
        "desired_shared",
        "desired_final",
        "base_shared",
        "base_final",
        "expected_final_by",
        "intent_seq",
        "status",
        "claim_token",
        "lease_until",
        "fail_streak",
        "next_retry_at",
        "last_error_code",
        "observed_state_json",
        "observed_at",
        "created_at",
        "updated_at",
        "last_attempt_at",
    } == columns
    assert {"idx_ssi_origin_uuid", "idx_ssi_origin_anchor", "idx_ssi_due"} <= indexes


def test_identity_upsert_enriches_uuid_and_increments_seq_atomically(isolated_content_db):
    first = repo.prepare_share_state_intent(
        "HTTP://SHARE.EXAMPLE.TEST:80/",
        job_anchor="job-1",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    second = repo.prepare_share_state_intent(
        "http://share.example.test",
        server_generation_id="uuid-1",
        job_anchor="job-1",
        operation_kind="finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=True,
        base_final=False,
    )

    assert second["intent_id"] == first["intent_id"]
    assert second["intent_seq"] == first["intent_seq"] + 1
    assert second["server_generation_id"] == "uuid-1"
    assert len(_ledger_rows()) == 1
    assert repo.transition_share_state_intent(
        first["intent_id"], first["intent_seq"], first["claim_token"], "pending"
    ) is False


def test_batch_prepare_rolls_back_every_target_on_one_invalid_item(isolated_content_db):
    with pytest.raises(ValueError, match="지원하지 않는 원장 작업"):
        repo.prepare_share_state_intents(
            "http://share.example.test",
            [
                {
                    "job_anchor": "job-valid",
                    "operation_kind": "publish",
                    "desired_shared": True,
                    "desired_final": False,
                    "base_shared": False,
                    "base_final": False,
                },
                {
                    "job_anchor": "job-invalid",
                    "operation_kind": "not-supported",
                    "desired_shared": True,
                    "desired_final": False,
                    "base_shared": False,
                    "base_final": False,
                },
            ],
        )

    assert _ledger_rows() == []


def test_uuid_only_and_anchor_only_rows_merge_when_identity_is_enriched(isolated_content_db):
    uuid_only = repo.prepare_share_state_intent(
        "http://share.example.test",
        server_generation_id="uuid-merge",
        operation_kind="unfinalize",
        desired_shared=True,
        desired_final=False,
        base_shared=True,
        base_final=True,
    )
    anchor_only = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-merge",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    assert uuid_only["intent_id"] != anchor_only["intent_id"]

    merged = repo.prepare_share_state_intent(
        "http://share.example.test",
        server_generation_id="uuid-merge",
        job_anchor="job-merge",
        operation_kind="finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=True,
        base_final=False,
    )

    assert len(_ledger_rows()) == 1
    assert merged["intent_seq"] == max(uuid_only["intent_seq"], anchor_only["intent_seq"]) + 1
    assert merged["server_generation_id"] == "uuid-merge"
    assert merged["job_anchor"] == "job-merge"


def test_stale_seq_cannot_apply_local_state_or_close_new_intent(isolated_content_db):
    gen_id = _seed_generation()
    old = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="server-1",
        local_id=gen_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    current = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="server-1",
        local_id=gen_id,
        operation_kind="unpublish",
        desired_shared=False,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )

    assert repo.apply_share_state_intent_local(
        old["intent_id"],
        old["intent_seq"],
        old["claim_token"],
        local_id=gen_id,
        shared=True,
        is_final=False,
    ) is False
    assert repo.get_generation(gen_id)["shared"] is False
    assert repo.apply_share_state_intent_local(
        current["intent_id"],
        current["intent_seq"],
        current["claim_token"],
        local_id=gen_id,
        shared=False,
        is_final=False,
    ) is True
    assert repo.get_share_state_intent(current["intent_id"])["status"] == "converged"


def test_generation_action_lock_serializes_cross_mutations():
    first_entered = threading.Event()
    allow_first_exit = threading.Event()
    second_entered = threading.Event()

    def first_action():
        with repo.share_state_action_lock(
            "http://share.example.test", job_anchor="server-1"
        ):
            first_entered.set()
            assert allow_first_exit.wait(2)

    def second_action():
        assert first_entered.wait(2)
        with repo.share_state_action_lock(
            "HTTP://SHARE.EXAMPLE.TEST:80/", job_anchor="server-1"
        ):
            second_entered.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(first_action)
        second_future = executor.submit(second_action)
        assert first_entered.wait(2)
        assert not second_entered.wait(0.1)
        allow_first_exit.set()
        first_future.result(timeout=2)
        second_future.result(timeout=2)
    assert second_entered.is_set()


def test_async_worker_lock_and_sync_route_lock_share_the_same_gate():
    sync_entered = threading.Event()

    def sync_action():
        with repo.share_state_action_lock(
            "http://share.example.test", job_anchor="server-async"
        ):
            sync_entered.set()

    async def scenario():
        async with repo.async_share_state_action_lock(
            "http://share.example.test", job_anchor="server-async"
        ):
            pending = asyncio.create_task(asyncio.to_thread(sync_action))
            await asyncio.sleep(0.05)
            assert not sync_entered.is_set()
        await pending

    asyncio.run(scenario())
    assert sync_entered.is_set()


def test_claim_lease_and_transition_require_current_token(isolated_content_db):
    prepared = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-claim",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
        lease_seconds=1,
    )
    assert repo.release_share_state_intent_claim(
        prepared["intent_id"], prepared["intent_seq"], prepared["claim_token"]
    )
    claimed = repo.claim_due_share_state_intents(
        "worker-claim", limit=10, lease_seconds=30
    )
    assert [row["intent_id"] for row in claimed] == [prepared["intent_id"]]
    assert not repo.transition_share_state_intent(
        prepared["intent_id"], prepared["intent_seq"], "wrong-token", "pending"
    )
    assert repo.transition_share_state_intent(
        prepared["intent_id"], prepared["intent_seq"], "worker-claim", "pending"
    )


def test_local_publish_route_is_blocked_in_proxy_mode():
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share.repo, "get_generation") as get_generation,
        pytest.raises(HTTPException) as raised,
    ):
        share.publish("local-1", SimpleNamespace(visibility="team"), _request())

    assert raised.value.status_code == 400
    get_generation.assert_not_called()


def test_publish_ledger_failure_returns_503_without_server_call(isolated_content_db):
    gen_id = _seed_generation()
    with (
        mock.patch.object(
            publish.repo,
            "prepare_share_state_intents",
            side_effect=RuntimeError("ledger unavailable"),
        ),
        mock.patch.object(publish, "_http_json") as remote,
        pytest.raises(HTTPException) as raised,
    ):
        publish.publish_bundle_to_server([gen_id])

    assert raised.value.status_code == 503
    remote.assert_not_called()
    assert repo.get_generation(gen_id)["shared"] is False


def test_publish_identity_drift_fails_before_ledger_or_server(isolated_content_db):
    gen_id = _seed_generation(job_id="old-anchor")
    original = repo.get_generation(gen_id)
    materialized = dict(original, job_id="new-anchor")
    reads = 0

    def drifting_generation(_gen_id):
        nonlocal reads
        reads += 1
        return original if reads <= 2 else materialized

    with (
        mock.patch.object(publish.repo, "get_generation", side_effect=drifting_generation),
        mock.patch.object(publish.repo, "prepare_share_state_intents") as prepare,
        mock.patch.object(publish.repo, "export_bundle") as export,
        mock.patch.object(publish, "_http_json") as remote,
        pytest.raises(HTTPException) as raised,
    ):
        publish.publish_bundle_to_server([gen_id])

    assert raised.value.status_code == 409
    prepare.assert_not_called()
    export.assert_not_called()
    remote.assert_not_called()
    assert _ledger_rows() == []


def test_crash_after_write_ahead_keeps_prepared_and_local_unchanged(isolated_content_db):
    gen_id = _seed_generation()
    with mock.patch.object(
        publish, "_http_json", side_effect=RuntimeError("crash before remote response")
    ):
        with pytest.raises(RuntimeError, match="crash"):
            publish.publish_bundle_to_server([gen_id])

    rows = _ledger_rows()
    assert len(rows) == 1
    assert rows[0]["status"] == "prepared"
    assert rows[0]["operation_kind"] == "publish"
    assert repo.get_generation(gen_id)["shared"] is False


def test_publish_local_failure_returns_mirror_pending_and_waiting_ledger(isolated_content_db):
    gen_id = _seed_generation()
    remote_response = {
        "inserted": 1,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "blocked": 0,
        "blocked_ids": [],
    }
    with (
        mock.patch.object(publish, "_http_json", return_value=(200, remote_response)),
        mock.patch.object(
            publish.repo,
            "apply_share_state_intent_local",
            side_effect=RuntimeError("local mirror unavailable"),
        ),
    ):
        result = publish.publish_bundle_to_server([gen_id])

    assert result["mirror_pending"] is True
    assert result["published"] == 0
    row = _ledger_rows()[0]
    assert row["status"] == "waiting_local"
    assert row["fail_streak"] == 1
    assert repo.get_generation(gen_id)["shared"] is False


def test_blocked_bundle_id_only_cancels_matching_intent(isolated_content_db):
    first = _seed_generation(generation_id="local-1", job_id="job-1")
    second = _seed_generation(generation_id="local-2", job_id="job-2")
    remote_response = {
        "inserted": 1,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "blocked": 1,
        "blocked_ids": ["job-1"],
    }
    with mock.patch.object(publish, "_http_json", return_value=(200, remote_response)):
        result = publish.publish_bundle_to_server([first, second])

    rows = {row["job_anchor"]: row for row in _ledger_rows()}
    assert rows["job-1"]["status"] == "rejected"
    assert rows["job-2"]["status"] == "converged"
    assert repo.get_generation(first)["shared"] is False
    assert repo.get_generation(second)["shared"] is True
    assert result["blocked"] == 1
    assert result["published"] == 1


@pytest.mark.parametrize(
    "action",
    [
        lambda gen_id: share.unpublish(gen_id, _request()),
        lambda gen_id: share.finalize(gen_id, _request(), BackgroundTasks()),
        lambda gen_id: share.unfinalize(gen_id, _request()),
    ],
    ids=["unpublish", "finalize", "unfinalize"],
)
def test_proxy_identity_drift_fails_before_ledger_or_server(isolated_content_db, action):
    gen_id = _seed_generation(shared=True, final=False)
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share.repo,
            "finalize_id_map",
            side_effect=[
                (gen_id, "old-anchor"),
                (gen_id, "new-anchor"),
            ],
        ),
        mock.patch.object(share.repo, "prepare_share_state_intent") as prepare,
        mock.patch.object(share._proxy, "proxy_json") as remote,
        pytest.raises(HTTPException) as raised,
    ):
        action(gen_id)

    assert raised.value.status_code == 409
    prepare.assert_not_called()
    remote.assert_not_called()
    assert _ledger_rows() == []


def test_unfinalize_local_failure_is_200_mirror_pending_without_backout(isolated_content_db):
    gen_id = _seed_generation(shared=True, final=True)
    remote_calls: list[str] = []

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        return {"id": "server-1", "job_id": "server-1", "shared": True, "is_final": False}

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        mock.patch.object(
            share.repo,
            "apply_share_state_intent_local",
            side_effect=RuntimeError("local mirror unavailable"),
        ),
    ):
        response = share.unfinalize(gen_id, _request())

    assert isinstance(response, JSONResponse)
    assert response.status_code == 200
    assert json.loads(response.body)["mirror_pending"] is True
    assert remote_calls == ["/api/generations/server-1/unfinalize"]
    assert repo.get_generation(gen_id)["is_final"] is True
    assert _ledger_rows()[0]["status"] == "waiting_local"


def test_unfinalize_success_closes_ledger_and_updates_local_atomically(isolated_content_db):
    gen_id = _seed_generation(shared=True, final=True)
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            return_value={
                "id": "server-1",
                "job_id": "server-1",
                "shared": True,
                "is_final": False,
            },
        ),
    ):
        result = share.unfinalize(gen_id, _request())

    assert result["is_final"] is False
    saved = repo.get_generation(gen_id)
    assert saved["shared"] is True
    assert saved["is_final"] is False
    assert _ledger_rows()[0]["status"] == "converged"


def test_unpublish_success_is_write_ahead_and_converges(isolated_content_db):
    gen_id = _seed_generation(shared=True, final=False)
    remote_calls: list[str] = []

    def proxy_json(_method, path, **_kwargs):
        assert _ledger_rows()[0]["status"] == "prepared"
        remote_calls.append(path)
        return {"id": "server-1", "job_id": "server-1", "shared": False, "is_final": False}

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
    ):
        result = share.unpublish(gen_id, _request())

    assert result["shared"] is False
    assert remote_calls == ["/api/generations/server-1/unpublish"]
    assert repo.get_generation(gen_id)["shared"] is False
    assert _ledger_rows()[0]["status"] == "converged"


def test_composite_finalize_records_bases_and_keeps_partial_state_for_3b(isolated_content_db):
    gen_id = _seed_generation(shared=False, final=False)
    publish_response = {
        "inserted": 1,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "blocked": 0,
        "blocked_ids": [],
    }
    remote_calls: list[str] = []

    def proxy_json(_method, path, **_kwargs):
        remote_calls.append(path)
        raise HTTPException(status_code=422, detail="finalize rejected")

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(publish, "_http_json", return_value=(200, publish_response)),
        mock.patch.object(share._proxy, "proxy_json", side_effect=proxy_json),
        pytest.raises(HTTPException) as raised,
    ):
        share.finalize(gen_id, _request(), BackgroundTasks())

    assert raised.value.status_code == 422
    assert remote_calls == ["/api/generations/server-1/finalize"]
    row = _ledger_rows()[0]
    assert row["operation_kind"] == "composite_finalize"
    assert row["base_shared"] == 0
    assert row["base_final"] == 0
    assert row["desired_shared"] == 1
    assert row["desired_final"] == 1
    assert row["status"] == "pending"
    assert json.loads(row["observed_state_json"])["publish_confirmed"] is True
    # 1회성 unpublish 보상은 없다. 3b가 base_shared=0 조건부 정리를 영속 재시도한다.
    saved = repo.get_generation(gen_id)
    assert saved["shared"] is True
    assert saved["is_final"] is False


def test_composite_finalize_success_converges_immediately(isolated_content_db):
    gen_id = _seed_generation(shared=False, final=False)
    publish_response = {
        "inserted": 1,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "blocked": 0,
        "blocked_ids": [],
    }
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(publish, "_http_json", return_value=(200, publish_response)),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            return_value={
                "id": "server-1",
                "job_id": "server-1",
                "shared": True,
                "is_final": True,
                "final_by": "me",
            },
        ),
    ):
        result = share.finalize(gen_id, _request(), BackgroundTasks())

    assert result["is_final"] is True
    saved = repo.get_generation(gen_id)
    assert saved["shared"] is True
    assert saved["is_final"] is True
    row = _ledger_rows()[0]
    assert row["operation_kind"] == "composite_finalize"
    assert row["status"] == "converged"
