"""Draft transitions use temporary storage and mocked submission only."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import db, repo
from app.generation_result import normalize_job_result
from app.models import GenRequestIn, RegenerateIn
from app.routers import gen_requests as routes
from app.services.seedance_draft import DraftFinishConflict, finish_params, fresh_params
from app.usecases.gen_requests import GenRequestCommand, submit_gen_request


def draft(**updates):
    return {
        "model": "seedance_2_5", "status": "done", "job_id": "remote-123",
        "params": {"resolution": "480p", "draft": True, "seed": 34, "duration": 5, "aspect_ratio": "16:9"},
        "creator_uid": "artist", "workspace_scope": "personal", "workspace_id": None,
        "worker_id": "me", **updates,
    }


def test_fresh_and_finish_have_distinct_remote_identity():
    source = draft()
    completed = finish_params(source)
    assert completed == {**source["params"], "resolution": "1080p", "draft": False, "draft_job_id": "remote-123"}
    assert "draft_job_id" not in source["params"]
    assert fresh_params("seedance_2_5", completed) == {
        "resolution": "1080p", "seed": 34, "duration": 5, "aspect_ratio": "16:9"}
    assert fresh_params("seedance_2_5", {"resolution": "480p", "draft_job_id": "injected"}) == {"resolution": "480p", "draft": True}


@pytest.mark.parametrize("updates", [
    {"status": "running"}, {"model": "seedance_2_0"}, {"job_id": None},
    {"params": {"resolution": "480p"}}, {"params": {"draft": True, "draft_job_id": "other"}},
    {"deleted": True},
])
def test_resolution_alone_and_non_drafts_cannot_finish(updates):
    with pytest.raises(ValueError):
        finish_params(draft(**updates))


@pytest.fixture
def content(tmp_path, monkeypatch):
    db.flush_pool()
    path = tmp_path / "content.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    db.init_db(path)
    repo.ensure_default_worker()
    yield
    db.flush_pool()


def test_import_preserves_recipe_and_uses_remote_job_id(content):
    source = draft()
    parent = repo.create_local_generation({
        "model": source["model"], "prompt": "fixed prompt", "params": source["params"],
        "references": [{"file_path": "https://example.invalid/ref.png", "type": "image", "role": "@Image1"}],
    }, "me", creator_uid="artist")
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', job_id='remote-123' WHERE id=?", (parent,))
    child = repo.import_generation(parent, "me", creator_uid="artist", finish_draft=True)
    recipe = repo.gen_recipe(child)
    assert recipe["params"] == finish_params(source)
    assert recipe["prompt"] == "fixed prompt"
    assert recipe["references"][0]["file_path"] == "https://example.invalid/ref.png"
    assert repo.get_generation(child)["parent_gen_id"] == parent
    assert repo.get_generation(child)["status"] == "pending"
    assert not repo.get_generation(child).get("is_final")
    repeated = repo.import_generation(child, "me", creator_uid="artist")
    assert repo.gen_recipe(repeated)["params"].get("draft_job_id") is None


def test_finish_retry_reuses_one_request(content):
    workspace = {"scope": "personal", "id": None, "name": None}
    parent = repo.create_local_generation({
        "model": "seedance_2_5", "prompt": "fixed", "params": draft()["params"],
    }, "me", creator_uid="artist", workspace=workspace)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', job_id='remote-123' WHERE id=?", (parent,))
    command = GenRequestCommand(kind="regenerate", email="artist@example.invalid",
        creator_uid="artist", worker_id="me", source_gen_id=parent, workspace=workspace,
        regenerate=RegenerateIn(finish_draft=True), idempotency_key="d41250cd-9046-4435-a2c6-65141a94d93d")
    with patch("app.usecases.gen_requests.MANAGE_ENABLED", False), \
         patch("app.usecases.gen_requests.agent_signals.signal"), \
         patch("app.usecases.gen_requests.journal_generation_event"):
        first = asyncio.run(submit_gen_request(command))
        second = asyncio.run(submit_gen_request(command))
    assert first["id"] == second["id"]
    assert first["params"]["draft_job_id"] == "remote-123"
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM gen_request WHERE gen_id=?", (first["id"],)).fetchone()[0] == 1


def _finish_command():
    workspace = {"scope": "personal", "id": None, "name": None}
    parent = repo.create_local_generation({
        "model": "seedance_2_5", "prompt": "fixed", "params": draft()["params"],
    }, "me", creator_uid="artist", workspace=workspace)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', job_id='remote-123' WHERE id=?", (parent,))
    return GenRequestCommand(kind="regenerate", email="artist@example.invalid",
        creator_uid="artist", worker_id="me", source_gen_id=parent, workspace=workspace,
        regenerate=RegenerateIn(finish_draft=True), idempotency_key="first-intent")


def _submit_without_external(command):
    with patch("app.usecases.gen_requests.MANAGE_ENABLED", False), \
         patch("app.usecases.gen_requests.agent_signals.signal"), \
         patch("app.usecases.gen_requests.journal_generation_event"), \
         patch("app.usecases.gen_requests._schedule_request_estimate"):
        return asyncio.run(submit_gen_request(command))


@pytest.mark.parametrize("canvas", [False, True])
def test_fresh_intent_cannot_finish_same_draft_twice(content, canvas):
    command = _finish_command()
    first = _submit_without_external(command)
    retry = replace(command, idempotency_key="fresh-intent")
    if canvas:
        retry = replace(retry, idempotency_key=None, canvas_link={
            "attempt_id": "new-attempt", "scene_id": "scene", "card_id": "card",
            "generation_id": "new-canvas-generation"})
    db.flush_pool()  # 연결 풀을 비워도 메모리가 아닌 영속 행으로 판정한다.
    with pytest.raises(DraftFinishConflict) as error:
        _submit_without_external(retry)
    assert error.value.generation_id == first["id"]
    with db.get_connection() as conn:
        assert conn.execute("SELECT count(*) FROM generation").fetchone()[0] == 2
        assert conn.execute("SELECT count(*) FROM gen_request WHERE status='pending'").fetchone()[0] == 1
    claimed = repo.claim_pending_requests(command.email, workspace_capable=True,
        lease_owner="test-agent", submission_stage_capable=True)
    assert [row["gen_id"] for row in claimed] == [first["id"]]
    assert repo.claim_pending_requests(command.email, workspace_capable=True,
        lease_owner="test-agent", submission_stage_capable=True) == []


@pytest.mark.parametrize("state", ["pending", "submitting", "recovery_required", "done"])
@pytest.mark.parametrize("missing_child", [False, True])
def test_finish_guard_survives_deleted_child_and_uncertain_request(content, state, missing_child):
    command = _finish_command()
    first = _submit_without_external(command)
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status=? WHERE gen_id=?", (state, first["id"]))
        if missing_child:
            from app.repo.generation_delete import delete_generation_rows
            delete_generation_rows(conn, first["id"])
        else:
            conn.execute("UPDATE generation SET deleted_at=datetime('now') WHERE id=?", (first["id"],))
    with pytest.raises(DraftFinishConflict):
        _submit_without_external(replace(command, idempotency_key="new-intent"))


@pytest.mark.parametrize("state", ["failed", "nsfw"])
def test_confirmed_failure_allows_explicit_new_finish_intent(content, state):
    command = _finish_command()
    first = _submit_without_external(command)
    retry = replace(command, idempotency_key="explicit-retry")
    with pytest.raises(DraftFinishConflict):
        _submit_without_external(retry)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status=? WHERE id=?", (state, first["id"]))
        conn.execute("UPDATE gen_request SET status='failed', terminal_at=datetime('now') WHERE gen_id=?",
                     (first["id"],))
    second = _submit_without_external(retry)
    assert second["id"] != first["id"]


def test_failed_request_without_terminal_confirmation_does_not_unlock(content):
    command = _finish_command()
    first = _submit_without_external(command)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='failed' WHERE id=?", (first["id"],))
        conn.execute("UPDATE gen_request SET status='failed', terminal_at=NULL WHERE gen_id=?", (first["id"],))
    with pytest.raises(DraftFinishConflict):
        _submit_without_external(replace(command, idempotency_key="fresh-key"))


def test_failed_child_without_confirmed_request_cannot_unlock_finish(content):
    command = _finish_command()
    first = repo.import_generation(command.source_gen_id, "me", creator_uid="artist",
                                   workspace=command.workspace, finish_draft=True)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='failed' WHERE id=?", (first,))
    with pytest.raises(DraftFinishConflict):
        _submit_without_external(command)


def test_two_preparing_intents_are_atomic_and_winner_marker_survives_deletion(content):
    command = _finish_command()
    reservations = [repo.reserve_idempotent_gen_request(
        command.email, command.creator_uid, "regenerate", key, {})
        for key in ("tab-one", "tab-two")]
    barrier = Barrier(2)

    def finish(reservation):
        barrier.wait(timeout=5)
        try:
            return repo.import_generation(command.source_gen_id, "me", creator_uid="artist",
                workspace=command.workspace, finish_draft=True, generation_id=reservation["gen_id"])
        except DraftFinishConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(finish, reservations))
    winners = [outcome for outcome in outcomes if outcome]
    assert len(winners) == 1
    with db.get_connection() as conn:
        from app.repo.generation_delete import delete_generation_rows
        delete_generation_rows(conn, winners[0])
    with pytest.raises(DraftFinishConflict):
        _submit_without_external(replace(command, idempotency_key="third-tab"))


def test_duplicate_finish_route_reports_not_started(content):
    # 라우트가 재생성 검사에서 레시피를 DB 로 읽는다 — 앞선 시험이 기본 DB 를 만들어 두었는지에 기대지 않는다.
    body = GenRequestIn(kind="regenerate", source_gen_id="local-123",
                        regenerate=RegenerateIn(finish_draft=True), workspace={"scope": "personal"})
    with patch.object(routes, "update_in_progress", return_value=False), \
         patch.object(routes, "_require_account", return_value={"email": "artist@example.invalid", "creator_uid": "artist"}), \
         patch.object(routes, "expected_account_differs", return_value=False), \
         patch.object(routes, "AUTH_ENABLED", False), \
         patch.object(routes, "_require_generation_deployment_open", AsyncMock()), \
         patch.object(routes, "require_view_generation"), \
         patch.object(routes.repo, "get_generation", return_value=draft()), \
         patch.object(routes.repo, "get_recovery_request_id_for_generation", return_value=None), \
         patch.object(routes, "submit_gen_request", AsyncMock(side_effect=DraftFinishConflict("existing-child"))):
        with pytest.raises(HTTPException) as error:
            asyncio.run(routes.create_gen_request(body, SimpleNamespace()))
    assert error.value.status_code == 409
    assert error.value.headers["X-MVHub-Submission"] == "not-started"
    assert "existing-child" in error.value.detail


def test_recovery_pending_regenerate_reports_not_started():
    # 복구 확인이 남은 원본의 재생성은 새 요청을 만들기 전에 막는다 — 표식이 없으면 화면이 '접수 불명'으로 남긴다
    body = GenRequestIn(kind="regenerate", source_gen_id="local-123",
                        regenerate=RegenerateIn(), workspace={"scope": "personal"})
    with patch.object(routes, "update_in_progress", return_value=False), \
         patch.object(routes, "_require_account", return_value={"email": "artist@example.invalid", "creator_uid": "artist"}), \
         patch.object(routes, "expected_account_differs", return_value=False), \
         patch.object(routes, "AUTH_ENABLED", False), \
         patch.object(routes, "_require_generation_deployment_open", AsyncMock()), \
         patch.object(routes, "require_view_generation"), \
         patch.object(routes.repo, "get_generation", return_value=draft()), \
         patch.object(routes.repo, "get_recovery_request_id_for_generation", return_value="r1"), \
         patch.object(routes, "submit_gen_request", AsyncMock()) as submit:
        with pytest.raises(HTTPException) as error:
            asyncio.run(routes.create_gen_request(body, SimpleNamespace()))
    assert error.value.status_code == 409
    assert (error.value.headers or {}).get("X-MVHub-Submission") == "not-started"
    submit.assert_not_called()


@pytest.mark.parametrize("params", [
    {"draft": True, "resolution": "480p"},
    {"draft": False, "draft_job_id": "remote-123", "resolution": "1080p"},
])
def test_draft_flags_must_survive_agent_filter_before_paid_submission(content, params):
    parent = repo.create_local_generation({"prompt": "p", "model": "seedance_2_5", "params": params}, "me")
    rid = repo.create_gen_request("artist@example.invalid", "artist", parent, "create",
                                 {"model": "seedance_2_5", "params": params})
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='claimed', lease_owner='agent', "
                     "lease_expires_at=datetime('now','+5 minutes') WHERE id=?", (rid,))
    assert repo.begin_request_submission(rid, "artist@example.invalid", "agent", {"params": {}}) is None
    with db.get_connection() as conn:
        assert conn.execute("SELECT status FROM gen_request WHERE id=?", (rid,)).fetchone()[0] == "claimed"
    assert repo.begin_request_submission(rid, "artist@example.invalid", "agent", {"params": params})["transitioned"]


@pytest.mark.parametrize("parent, reg, code", [
    (draft(creator_uid="other"), RegenerateIn(finish_draft=True), 403),
    (draft(workspace_scope="team", workspace_id="other"), RegenerateIn(finish_draft=True), 409),
    (draft(), RegenerateIn(finish_draft=True, prompt="changed"), 400),
    (draft(job_id=None), RegenerateIn(finish_draft=True), 409),
])
def test_finish_route_rejects_before_submission(content, parent, reg, code):
    body = GenRequestIn(kind="regenerate", source_gen_id="local-123", regenerate=reg, workspace={"scope": "personal"})
    request = SimpleNamespace()
    with patch.object(routes, "update_in_progress", return_value=False), \
         patch.object(routes, "_require_account", return_value={"email": "artist@example.invalid", "creator_uid": "artist"}), \
         patch.object(routes, "expected_account_differs", return_value=False), \
         patch.object(routes, "AUTH_ENABLED", False), \
         patch.object(routes, "_require_generation_deployment_open", AsyncMock()), \
         patch.object(routes, "require_view_generation"), \
         patch.object(routes.repo, "get_generation", return_value=parent), \
         patch.object(routes.repo, "get_recovery_request_id_for_generation", return_value=None), \
         patch.object(routes, "submit_gen_request", AsyncMock()) as submit:
        with pytest.raises(HTTPException) as error:
            asyncio.run(routes.create_gen_request(body, request))
        assert error.value.status_code == code
        submit.assert_not_called()


@pytest.mark.parametrize("completion", ["reconcile", "fulfill"])
def test_completed_result_saves_reported_seed_and_draft(content, completion):
    parent = repo.create_local_generation({"prompt": "p", "model": "seedance_2_5", "params": {"duration": 5}}, "me")
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id='remote-123', status='running' WHERE id=?", (parent,))
    result = normalize_job_result({"generation": {"id": "remote-123", "status": "done", "params": {"draft": True, "seed": 99}}})
    fields = dict(asset_type="video", asset_path="https://example.invalid/out.mp4",
                  asset_thumb=None, created_at=None, sort_ts=None, status="done", error=None, params=result.params)
    if completion == "reconcile":
        assert repo.apply_reconcile(parent, result.job_id, **fields)
    else:
        rid = repo.create_gen_request("artist@example.invalid", "artist", parent, "create", {})
        assert repo.apply_local_fulfillment(parent, rid, job_id=result.job_id, request_status="done", **fields)
    assert repo.get_generation(parent)["params"] == {"duration": 5, "draft": True, "seed": 99}


@pytest.mark.parametrize("not_started", [True, False])
def test_asgi_submission_marker_matches_actual_route_outcome(not_started):
    app = FastAPI()
    app.include_router(routes.router)
    body = GenRequestIn(kind="create", create={"prompt": "synthetic", "model": "seedance_2_5", "params": {}},
                        workspace={"scope": "personal"})
    with patch.object(routes, "update_in_progress", return_value=not_started), \
         patch.object(routes, "_require_account", return_value={"email": "artist@example.invalid", "creator_uid": "artist"}), \
         patch.object(routes, "expected_account_differs", return_value=False), \
         patch.object(routes, "AUTH_ENABLED", False), \
         patch.object(routes, "_validated_generation_workspace", return_value=body.workspace), \
         patch.object(routes, "_require_generation_deployment_open", AsyncMock()), \
         patch.object(routes, "submit_gen_request", AsyncMock(side_effect=routes.CanvasGenerationConflict("synthetic-collision"))) as submit:
        with TestClient(app) as client:
            response = client.post("/api/gen-requests", json=body.model_dump(mode="json"))
    assert response.status_code == 409
    assert response.headers.get("X-MVHub-Submission") == ("not-started" if not_started else None)
    assert submit.call_count == (0 if not_started else 1)
