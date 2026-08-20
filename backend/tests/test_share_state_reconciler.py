"""공유/골드 reconciler의 관측→수렴 계약(설계 §8: 3·4·7·8)."""

from __future__ import annotations

import asyncio
import json
from unittest import mock

import pytest

from app import db, repo
from app.routers import _proxy, publish
from app.routers._telemetry import touch_generation_telemetry
from app.services import share_state_reconciler as reconciler

# 계층 경계로 reconciler 는 라우터 의존을 주입받는다(운영은 main.py lifespan 이 담당).
reconciler.configure_share_state_router_deps(
    proxy=_proxy, touch_telemetry=touch_generation_telemetry
)


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting("shared_server_url", "http://share.example.test/")
    repo.set_setting("shared_server_token", "token")
    monkeypatch.setattr(reconciler._proxy, "proxying", lambda: True)
    try:
        yield
    finally:
        db.flush_pool()


def _seed_generation(
    generation_id: str,
    job_id: str,
    *,
    shared: bool = False,
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


def _release(ref: dict) -> None:
    assert repo.release_share_state_intent_claim(
        ref["intent_id"], ref["intent_seq"], ref["claim_token"]
    )


def _patch_observer(monkeypatch, observer) -> None:
    monkeypatch.setattr(reconciler, "_observe_remote_state", observer)

    def observe_batch(origin, token, intents):
        return {
            str(intent["intent_id"]): observer(origin, token, intent)
            for intent in intents
        }

    monkeypatch.setattr(reconciler, "_observe_remote_states", observe_batch)


def _pending_composite(
    local_id: str,
    job_id: str,
    *,
    base_shared: bool,
) -> dict:
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor=job_id,
        local_id=local_id,
        operation_kind="composite_finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=base_shared,
        base_final=False,
    )
    assert repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        "pending",
        observed_state={
            "shared": True,
            "is_final": False,
            "publish_confirmed": True,
        },
    )
    _release(ref)
    return ref


def test_cycle_observation_uses_one_server_batch_request():
    intents = [
        {"intent_id": "intent-1", "job_anchor": "job-1"},
        {"intent_id": "intent-2", "server_generation_id": "server-2"},
    ]
    payload = {
        "items": {
            "job-1": {"id": "job-1", "shared": True, "is_final": False},
            "server-2": {"id": "server-2", "shared": True, "is_final": True},
        },
        "missing": [],
    }
    with mock.patch.object(
        reconciler._proxy, "raw_request", return_value=(200, payload)
    ) as request:
        observed = reconciler._observe_remote_states(
            "http://share.example.test", "stored-token", intents
        )

    assert observed["intent-1"]["shared"] is True
    assert observed["intent-2"]["is_final"] is True
    request.assert_called_once_with(
        "POST",
        "http://share.example.test/api/generations/batch",
        token="stored-token",
        body={"gen_ids": ["job-1", "server-2"]},
        timeout=15,
    )


def test_restart_cycle_converges_prepared_and_waiting_local_rows(
    isolated_content_db, monkeypatch
):
    prepared_id = _seed_generation("local-prepared", "job-prepared")
    waiting_id = _seed_generation("local-waiting", "job-waiting")
    prepared = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-prepared",
        local_id=prepared_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    _release(prepared)  # 크래시 뒤 재시작에서 만료 lease가 회수된 상태
    waiting = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-waiting",
        local_id=waiting_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    assert repo.mark_share_state_intent_waiting_local(
        waiting["intent_id"], waiting["intent_seq"], waiting["claim_token"]
    )

    _patch_observer(
        monkeypatch,
        lambda _origin, _token, intent: {
            "id": intent["job_anchor"],
            "job_id": intent["job_anchor"],
            "shared": True,
            "is_final": False,
        },
    )

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("restart-worker")
    )

    assert counts["claimed"] == 2
    assert counts["converged"] == 2
    assert repo.get_generation(prepared_id)["shared"] is True
    assert repo.get_generation(waiting_id)["shared"] is True
    assert repo.get_share_state_intent(prepared["intent_id"])["status"] == "converged"
    assert repo.get_share_state_intent(waiting["intent_id"])["status"] == "converged"


def test_remote_observation_supersedes_stale_finalize_without_blind_replay(
    isolated_content_db, monkeypatch
):
    gen_id = _seed_generation("local-final", "job-final", shared=True, final=True)
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-final",
        local_id=gen_id,
        operation_kind="finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=True,
        base_final=False,
    )
    assert repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        "pending",
        observed_state={"shared": True, "is_final": True},
    )
    _release(ref)
    _patch_observer(
        monkeypatch,
        lambda *_args: {
            "id": "job-final",
            "job_id": "job-final",
            "shared": True,
            "is_final": False,
        },
    )
    remote_mutation = mock.Mock()
    monkeypatch.setattr(reconciler, "_unpublish_remote", remote_mutation)

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("blind-worker")
    )

    assert counts["superseded"] == 1
    assert repo.get_generation(gen_id)["shared"] is True
    assert repo.get_generation(gen_id)["is_final"] is False
    assert repo.get_share_state_intent(ref["intent_id"])["status"] == "superseded"
    remote_mutation.assert_not_called()


def test_composite_partial_unpublishes_only_when_base_was_unshared(
    isolated_content_db, monkeypatch
):
    new_share_id = _seed_generation("local-new-share", "job-new-share", shared=True)
    existing_share_id = _seed_generation(
        "local-existing-share", "job-existing-share", shared=True
    )
    new_share = _pending_composite(
        new_share_id, "job-new-share", base_shared=False
    )
    existing_share = _pending_composite(
        existing_share_id, "job-existing-share", base_shared=True
    )

    _patch_observer(
        monkeypatch,
        lambda _origin, _token, intent: {
            "id": intent["job_anchor"],
            "job_id": intent["job_anchor"],
            "shared": True,
            "is_final": False,
        },
    )
    cleanup_calls: list[str] = []

    def cleanup(_origin, _token, intent):
        cleanup_calls.append(intent["job_anchor"])
        return {
            "id": intent["job_anchor"],
            "shared": False,
            "is_final": False,
            "cleanup": "unpublished",
        }

    monkeypatch.setattr(reconciler, "_unpublish_remote", cleanup)

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("composite-worker")
    )

    assert counts["rejected"] == 2
    assert cleanup_calls == ["job-new-share"]
    assert repo.get_generation(new_share_id)["shared"] is False
    assert repo.get_generation(existing_share_id)["shared"] is True
    assert repo.get_share_state_intent(new_share["intent_id"])["status"] == "rejected"
    assert repo.get_share_state_intent(existing_share["intent_id"])["status"] == "rejected"


def test_auth_required_row_resumes_after_relogin_kick(
    isolated_content_db, monkeypatch
):
    gen_id = _seed_generation("local-auth", "job-auth")
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-auth",
        local_id=gen_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    _release(ref)

    def auth_required(*_args):
        raise reconciler._RemoteAuthRequired()

    _patch_observer(monkeypatch, auth_required)
    first = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("auth-worker-1")
    )
    assert first["auth_required"] == 1
    assert repo.get_share_state_intent(ref["intent_id"])["status"] == "auth_required"

    with (
        mock.patch.object(
            publish,
            "_http_json",
            return_value=(
                200,
                {
                    "token": "renewed-token",
                    "account": {
                        "email": "artist@example.com",
                        "name": "Artist",
                        "global_roles": [],
                    },
                },
            ),
        ),
        mock.patch.object(publish, "_switch_account_db"),
        mock.patch.object(publish, "kick_share_state_reconciler") as kick,
    ):
        publish.shared_server_login(
            publish.SharedLoginIn(
                url="http://share.example.test",
                email="artist@example.com",
                password="password",
            )
        )
    kick.assert_called_once_with()
    _patch_observer(
        monkeypatch,
        lambda *_args: {
            "id": "job-auth",
            "job_id": "job-auth",
            "shared": True,
            "is_final": False,
        },
    )

    second = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("auth-worker-2")
    )

    assert second["converged"] == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert row["status"] == "converged"
    assert json.loads(row["observed_state_json"])["shared"] is True
    assert repo.get_generation(gen_id)["shared"] is True
