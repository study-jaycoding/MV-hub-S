"""공유 검토 보류의 추가 스키마·원자 전이·서버 필터 계약."""

from __future__ import annotations

import email.message
import io
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import db, db_migrations, repo
from app.models import FinalReviewIn
from app.routers import _proxy, library


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path))
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    monkeypatch.setattr(library, "AUTH_ENABLED", False)
    monkeypatch.setattr(library, "_account_uid", lambda _request: None)
    monkeypatch.setattr(library, "_schedule_remote_thumb_prewarm", lambda *_args: None)
    yield
    db.flush_pool()


def seed(gen_id, *, shared=True, held=False, final=False, status="done", deleted=False,
         sort_ts=1, workspace="ws-a"):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id, worker_id, prompt, status, is_held, is_final, "
            "deleted_at, sort_ts, workspace_scope, workspace_id, workspace_name) "
            "VALUES(?, 'me', 'hold test', ?, ?, ?, ?, ?, 'team', ?, ?)",
            (gen_id, status, int(held), int(final), "2026-01-01" if deleted else None,
             sort_ts, workspace, workspace),
        )
    if shared:
        repo.publish(gen_id, "me")
    return gen_id


def client():
    app = FastAPI()
    app.include_router(library.router)
    return TestClient(app)


def test_legacy_schema_adds_columns_without_rewriting_existing_state(tmp_path):
    schema = (Path(__file__).parents[1] / "schema.sql").read_text(encoding="utf-8")
    old_schema = "\n".join(
        line for line in schema.splitlines()
        if not any(name in line for name in ("is_held", "desired_held", "base_held"))
    )
    conn = sqlite3.connect(tmp_path / "legacy.db")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(old_schema)
        # 이전 릴리스의 기존 마이그레이션까지 완료된 DB를 재현한다.
        db_migrations._migrate(conn)
        conn.execute("ALTER TABLE generation DROP COLUMN is_held")
        conn.execute("ALTER TABLE share_state_intent DROP COLUMN desired_held")
        conn.execute("ALTER TABLE share_state_intent DROP COLUMN base_held")
        conn.execute("INSERT INTO worker(id,name) VALUES('me','Me')")
        conn.execute(
            "INSERT INTO generation(id,worker_id,prompt,status,is_final,origin,sort_ts) "
            "VALUES('existing','me','preserved','done',1,'local',1)"
        )
        conn.execute(
            "INSERT INTO share_state_intent(intent_id,server_origin,job_anchor,operation_kind,"
            "desired_shared,desired_final,base_shared,base_final,intent_seq,status,created_at,updated_at) "
            "VALUES('old','http://example.test','job','publish',1,0,0,0,1,'prepared','then','then')"
        )
        before = dict(conn.execute("SELECT * FROM generation").fetchone())
        db_migrations._migrate(conn)
        db_migrations._migrate(conn)
        after = dict(conn.execute("SELECT * FROM generation").fetchone())
        assert after.pop("is_held") == 0
        assert after == before
        intent = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
        assert intent["desired_held"] is None and intent["base_held"] is None
        assert intent["status"] == "prepared" and intent["updated_at"] == "then"
        conn.execute("UPDATE generation SET is_held=1")
        db_migrations._migrate(conn)
        assert conn.execute("SELECT is_held FROM generation").fetchone()[0] == 1
    finally:
        conn.close()


@pytest.mark.parametrize("kwargs,reason", [
    ({"shared": False}, "not_shared"),
    ({"status": "running"}, "not_done"),
    ({"deleted": True}, "deleted"),
    ({"final": True}, "final"),
])
@pytest.mark.parametrize("held", [False, True])
def test_hold_rejects_ineligible_states(catalog, kwargs, reason, held):
    gen_id = seed("invalid", **kwargs)
    with pytest.raises(repo.GenerationHoldStateError) as caught:
        repo.set_generation_hold(gen_id, held)
    assert caught.value.reason == reason
    assert not repo.get_generation(gen_id)["is_held"]


def test_hold_missing_and_idempotent_roundtrip(catalog):
    with pytest.raises(repo.GenerationHoldStateError) as caught:
        repo.set_generation_hold("missing", True)
    assert caught.value.reason == "not_found"
    gen_id = seed("valid")
    for held in (True, True, False, False):
        repo.set_generation_hold(gen_id, held)
        row = repo.get_generation(gen_id)
        assert row["is_held"] is held
        assert row["shared"] and not row["is_final"] and row["status"] == "done"
        assert repo.get_generations_batch([gen_id])[gen_id]["is_held"] is held
        assert repo.get_generations_with_materials([gen_id])[0][gen_id]["is_held"] is held


@pytest.mark.parametrize("operation", ["finalize", "set_final", "unfinalize", "unpublish"])
def test_exit_transitions_clear_hold(catalog, operation):
    gen_id = seed("held", held=True)
    if operation == "finalize":
        repo.finalize_generation_with_share(gen_id, "me", "reviewer")
    elif operation == "set_final":
        repo.set_final(gen_id, True, "reviewer")
    elif operation == "unfinalize":
        repo.set_final(gen_id, False)
    else:
        repo.unpublish(gen_id)
    assert repo.get_generation(gen_id)["is_held"] is False


def test_concurrent_finalize_and_hold_cannot_leave_final_held(catalog):
    gen_id = seed("race")

    def hold():
        try:
            repo.set_generation_hold(gen_id, True)
        except repo.GenerationHoldStateError as exc:
            assert exc.reason == "final"

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(hold), pool.submit(repo.finalize_generation_with_share, gen_id, "me")]
        for future in futures:
            future.result(timeout=5)
    state = repo.get_generation(gen_id)
    assert state["is_final"] and state["shared"] and not state["is_held"]


def test_held_unpublish_is_allowed_and_clears_hold_atomically(catalog):
    gen_id = seed("held", held=True)
    assert repo.unpublish_generation_if_not_final(gen_id) is True
    state = repo.get_generation(gen_id)
    assert not state["shared"] and not state["is_held"] and not state["is_final"]
    assert repo.unpublish_generation_if_not_final(gen_id) is False


def test_final_unpublish_still_requires_explicit_final_transition(catalog):
    gen_id = seed("gold", final=True)
    with pytest.raises(repo.FinalGenerationUnpublishError):
        repo.unpublish_generation_if_not_final(gen_id)
    state = repo.get_generation(gen_id)
    assert state["shared"] and state["is_final"]


@pytest.mark.parametrize("operation", [repo.unpublish, repo.unpublish_generation_if_not_final])
def test_unpublish_rolls_back_share_removal_when_hold_update_fails(catalog, operation):
    gen_id = seed("rollback", held=True)
    with db.get_connection() as conn:
        conn.execute(
            "CREATE TRIGGER reject_hold_update BEFORE UPDATE OF is_held ON generation "
            "BEGIN SELECT RAISE(ABORT, 'test hold failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="test hold failure"):
        operation(gen_id)
    state = repo.get_generation(gen_id)
    assert state["shared"] and state["is_held"]


def test_bundle_republish_cannot_override_server_hold(catalog):
    seed("held", held=True)
    repo.import_bundle_item({"generation": {
        "id": "held", "prompt": "updated", "status": "done", "is_held": False,
    }}, "me")
    assert repo.get_generation("held")["is_held"] is True


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
@pytest.mark.parametrize("was_shared", [False, True])
def test_final_review_transitions_and_repairs_missing_share(catalog, target, was_shared):
    gen_id = seed("gold", final=True, shared=was_shared)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET final_by='reviewer', final_at='then' WHERE id=?", (gen_id,))
        old_share = conn.execute("SELECT * FROM share WHERE generation_id=?", (gen_id,)).fetchone()
        old_share = dict(old_share) if old_share else None
    previous = repo.transition_final_review(gen_id, target, "me")
    assert previous == {"shared": was_shared, "is_final": True, "is_held": False}
    state = repo.get_generation(gen_id)
    assert state["shared"] is (target != "unshared")
    assert state["is_held"] is (target == "held")
    assert not state["is_final"] and state["final_by"] is None
    with db.get_connection() as conn:
        assert conn.execute("SELECT final_at FROM generation WHERE id=?", (gen_id,)).fetchone()[0] is None
        if old_share and target != "unshared":
            assert dict(conn.execute("SELECT * FROM share WHERE generation_id=?", (gen_id,)).fetchone()) == old_share


@pytest.mark.parametrize("kwargs,reason", [
    ({"final": False}, "not_final"),
    ({"final": True, "status": "running"}, "not_done"),
    ({"final": True, "deleted": True}, "deleted"),
])
def test_final_review_rechecks_current_state(catalog, kwargs, reason):
    gen_id = seed("invalid", **kwargs)
    before = repo.get_generation(gen_id)
    with pytest.raises(repo.GenerationHoldStateError) as caught:
        repo.transition_final_review(gen_id, "held", "me")
    assert caught.value.reason == reason
    assert repo.get_generation(gen_id) == before


def test_final_review_missing_and_invalid_target(catalog):
    with pytest.raises(repo.GenerationHoldStateError) as caught:
        repo.transition_final_review("missing", "shared", "me")
    assert caught.value.reason == "not_found"
    gen_id = seed("gold", final=True)
    with pytest.raises(ValueError, match="target must"):
        repo.transition_final_review(gen_id, "wrong", "me")
    with pytest.raises(ValidationError):
        FinalReviewIn(state="wrong")
    assert repo.get_generation(gen_id)["is_final"] is True


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
@pytest.mark.parametrize("was_shared", [False, True])
def test_final_review_rolls_back_share_and_final_together(catalog, target, was_shared):
    gen_id = seed("rollback", final=True, shared=was_shared)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET final_by='reviewer', final_at='then' WHERE id=?", (gen_id,))
        conn.execute(
            "CREATE TRIGGER reject_review_update BEFORE UPDATE OF is_final ON generation "
            "BEGIN SELECT RAISE(ABORT, 'review failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="review failure"):
        repo.transition_final_review(gen_id, target, "me")
    state = repo.get_generation(gen_id)
    assert state["shared"] is was_shared
    assert state["is_final"] is True and state["is_held"] is False
    assert state["final_by"] == "reviewer"
    with db.get_connection() as conn:
        assert conn.execute("SELECT final_at FROM generation WHERE id=?", (gen_id,)).fetchone()[0] == "then"


def test_competing_final_review_allows_only_one_transition(catalog):
    gen_id = seed("race", final=True)
    gate = threading.Barrier(2)

    def transition(target):
        gate.wait(timeout=5)
        try:
            repo.transition_final_review(gen_id, target, "me")
            return target
        except repo.GenerationHoldStateError as exc:
            assert exc.reason == "not_final"
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(transition, "held"), pool.submit(transition, "unshared")]
        results = [future.result(timeout=5) for future in futures]
    winners = [result for result in results if result is not None]
    assert len(winners) == 1
    state = repo.get_generation(gen_id)
    assert not state["is_final"]
    assert state["shared"] is (winners[0] != "unshared")
    assert state["is_held"] is (winners[0] == "held")


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_repeated_final_review_is_a_state_conflict(catalog, target):
    gen_id = seed("once", final=True)
    repo.transition_final_review(gen_id, target, "me")
    before = repo.get_generation(gen_id)
    with pytest.raises(repo.GenerationHoldStateError) as caught:
        repo.transition_final_review(gen_id, target, "me")
    assert caught.value.reason == "not_final"
    assert repo.get_generation(gen_id) == before


def test_review_filter_is_before_pagination_and_combines_workspace(catalog):
    seed("private", shared=False, sort_ts=10)
    seed("gold", final=True, sort_ts=9)
    seed("held-a", held=True, sort_ts=8)
    seed("held-b", held=True, sort_ts=7, workspace="ws-b")
    seed("shared-a", sort_ts=6)
    seed("shared-a-older", sort_ts=5)
    assert [g["id"] for g in repo.list_generations(review_filter="shared", limit=1)] == ["shared-a"]
    rows = repo.list_generations(review_filter="shared", limit=1, cursor_ts=6, cursor_id="shared-a")
    assert [g["id"] for g in rows] == ["shared-a-older"]
    rows = repo.list_generations(review_filter="held", workspace_ids=["ws-a"], shared_only=True)
    assert [g["id"] for g in rows] == ["held-a"]
    assert len(repo.list_generations(shared_only=True)) == 5
    assert repo.list_generations(review_filter="held", final_only=True) == []


@pytest.mark.parametrize("review_filter", ["shared", "held"])
def test_list_endpoint_acknowledges_empty_filter(catalog, review_filter):
    with client() as api:
        response = api.get("/api/generations", params={"review_filter": review_filter})
        assert response.status_code == 200, response.text
        assert response.json() == []
        assert response.headers[_proxy.REVIEW_FILTER_HEADER] == review_filter
        assert api.get("/api/generations?review_filter=anything").status_code == 422


def test_all_generation_http_shapes_expose_hold(catalog, monkeypatch):
    seed("held", held=True)
    monkeypatch.setattr(library, "require_view_generation", lambda *_a: None)
    monkeypatch.setattr(library, "batch_view_member_projects", lambda *_a: None)
    monkeypatch.setattr(library, "can_view_generation_with_member_projects", lambda *_a: True)
    with client() as api:
        response = api.get("/api/generations?review_filter=held")
        assert response.status_code == 200, response.text
        assert response.json()[0]["is_held"] is True
        assert api.get("/api/generations/held").json()["is_held"] is True
        assert api.post("/api/generations/batch", json={"gen_ids": ["held"]}).json()["items"]["held"]["is_held"] is True


class RemoteResponse(io.BytesIO):
    def __init__(self, body, review_filter=None):
        super().__init__(json.dumps(body).encode())
        self.status = 200
        self.headers = email.message.Message()
        if review_filter is not None:
            self.headers[_proxy.REVIEW_FILTER_HEADER] = review_filter


@pytest.mark.parametrize("upstream_filter", [None, "shared"])
def test_proxy_rejects_missing_or_wrong_filter_even_empty(monkeypatch, upstream_filter):
    monkeypatch.setattr(_proxy, "token", lambda: "test-only")
    monkeypatch.setattr(_proxy, "base_url", lambda: "http://example.test")
    monkeypatch.setattr(_proxy.urllib.request, "urlopen", lambda *_a, **_k: RemoteResponse([], upstream_filter))
    with pytest.raises(HTTPException) as caught:
        _proxy.proxy_json("GET", "/api/generations", required_review_filter="held")
    assert caught.value.status_code == 409


def test_proxy_rejects_missing_hold_field(monkeypatch):
    monkeypatch.setattr(_proxy, "token", lambda: "test-only")
    monkeypatch.setattr(_proxy, "base_url", lambda: "http://example.test")
    monkeypatch.setattr(_proxy.urllib.request, "urlopen", lambda *_a, **_k: RemoteResponse([{"id": "old"}], "held"))
    with pytest.raises(HTTPException) as caught:
        _proxy.proxy_json("GET", "/api/generations", required_review_filter="held")
    assert caught.value.status_code == 409


def test_proxy_review_filter_verified_for_every_overlay_page(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "token", lambda: "test-only")
    monkeypatch.setattr(_proxy, "base_url", lambda: "http://example.test")
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, _request: data)
    pages = iter([
        RemoteResponse([{"id": str(i), "sort_ts": i, "is_held": True} for i in range(200)], "held"),
        RemoteResponse([], None),
    ])
    monkeypatch.setattr(_proxy.urllib.request, "urlopen", lambda *_a, **_k: next(pages))
    with client() as api:
        response = api.get("/api/generations?tab=team&review_filter=held&colors=red")
    assert response.status_code == 409


def test_proxy_passes_verified_empty_filter_header(catalog, monkeypatch):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "token", lambda: "test-only")
    monkeypatch.setattr(_proxy, "base_url", lambda: "http://example.test")
    monkeypatch.setattr(library, "_overlay_personal_meta", lambda data, _request: data)
    monkeypatch.setattr(_proxy.urllib.request, "urlopen", lambda *_a, **_k: RemoteResponse([], "held"))
    with client() as api:
        response = api.get("/api/generations?tab=team&review_filter=held")
    assert response.status_code == 200
    assert response.json() == []
    assert response.headers[_proxy.REVIEW_FILTER_HEADER] == "held"
