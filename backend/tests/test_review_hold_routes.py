"""공유 검토 보류의 권한·원장·세 축 수렴 계약. 임시 DB만 사용한다."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app import db, repo, rbac
from app.models import FinalReviewIn
from app.routers import share
from app.services import share_state_reconciler as reconciler


@pytest.fixture
def item(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting("shared_server_url", "http://review.example.test/")
    repo.set_setting("shared_server_token", "fixture-token")
    gid = repo.create_local_generation({"model": "test", "prompt": "fixture"}, "me", generation_id="local-review")
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', job_id='remote-review' WHERE id=?", (gid,))
    repo.publish(gid, "me", "team")
    monkeypatch.setattr(share._proxy, "proxying", lambda: False)
    monkeypatch.setattr(share, "require_edit_generation", Mock())
    monkeypatch.setattr(share, "_touch_telemetry", Mock())
    monkeypatch.setattr(share, "journal_audit_event", Mock())
    monkeypatch.setattr(share, "kick_share_state_reconciler", Mock())
    yield gid
    db.flush_pool()


def req():
    return SimpleNamespace(state=SimpleNamespace(account=None))


def intent(gid, *, operation="hold", desired=True, base=False, final=False):
    return repo.prepare_share_state_intent(
        "http://review.example.test/", job_anchor="remote-review", local_id=gid,
        operation_kind=operation, desired_shared=True, desired_final=final,
        base_shared=True, base_final=False, desired_held=desired, base_held=base,
    )


def apply(ref, gid, *, held=None, final=False, shared=True):
    return repo.apply_share_state_intent_local(
        ref["intent_id"], ref["intent_seq"], ref["claim_token"], local_id=gid,
        shared=shared, is_final=final, is_held=held,
    )


def test_hold_and_return_keep_shared_without_final(item):
    held = share.hold_generation(item, req())
    assert held["shared"] and held["is_held"] and not held["is_final"]
    restored = share.unhold_generation(item, req())
    assert restored["shared"] and not restored["is_held"] and not restored["is_final"]
    assert share.journal_audit_event.call_count == 2


@pytest.mark.parametrize("field,value,code", [
    ("status", "running", 409), ("deleted_at", "2026-01-01", 409), ("is_final", 1, 409),
])
def test_hold_rechecks_invalid_state(item, field, value, code):
    with db.get_connection() as conn:
        conn.execute(f"UPDATE generation SET {field}=? WHERE id=?", (value, item))
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == code
    assert not repo.get_generation(item)["is_held"]


def test_hold_does_not_publish_private_item(item):
    repo.unpublish(item)
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == 409
    assert not repo.get_generation(item)["shared"]


def test_hold_project_requires_supervisor_not_owner_shortcut(item, monkeypatch):
    original = repo.get_generation
    monkeypatch.setattr(repo, "get_generation", lambda gid: {**original(gid), "project_id": "project-review"})
    monkeypatch.setattr(share, "account_global_roles", lambda request: set())
    permission = Mock(side_effect=HTTPException(403, "denied"))
    monkeypatch.setattr(share, "require_project_role", permission)
    request = req()
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, request)
    assert error.value.status_code == 403
    permission.assert_called_once_with(request, "project-review", rbac.SUPERVISOR)
    assert not original(item)["is_held"]


def test_proxy_hold_mirrors_server_held_axis(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = {**repo.get_generation(item), "id": "remote-review", "is_held": True}
    call = Mock(return_value=remote)
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    out = share.hold_generation(item, req())
    assert out == remote
    call.assert_called_once_with("POST", "/api/generations/remote-review/hold")
    assert repo.get_generation(item)["is_held"]
    with db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
    assert saved["desired_held"] == 1 and saved["status"] == "converged"


def test_proxy_mirror_failure_keeps_server_success_and_pending_intent(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = {**repo.get_generation(item), "is_held": True}
    call = Mock(return_value=remote)
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    monkeypatch.setattr(repo, "apply_share_state_intent_local", Mock(side_effect=OSError("fixture")))
    out = share.hold_generation(item, req())
    assert isinstance(out, JSONResponse) and out.status_code == 200
    assert b'"mirror_pending":true' in out.body
    assert call.call_count == 1  # 서버 판정을 되돌리는 요청 없음


def test_prepare_failure_prevents_remote_write(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    monkeypatch.setattr(repo, "prepare_share_state_intent", Mock(side_effect=OSError("fixture")))
    call = Mock()
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == 503
    call.assert_not_called()


def test_old_server_response_is_not_false_success(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = dict(repo.get_generation(item))
    remote.pop("is_held")
    monkeypatch.setattr(share._proxy, "proxy_json", Mock(return_value=remote))
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == 503
    assert not repo.get_generation(item)["is_held"]


def test_old_server_missing_route_requires_update(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    monkeypatch.setattr(share._proxy, "proxy_json", Mock(side_effect=HTTPException(404, "Not Found")))
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == 409 and "업데이트" in error.value.detail


def test_new_final_intent_supersedes_old_hold_without_leaving_hold(item):
    old = intent(item)
    new = intent(item, operation="finalize", desired=False, final=True)
    assert apply(old, item, held=True) == repo.SHARE_STATE_APPLY_CAS_LOST
    assert apply(new, item, held=True, final=True) == repo.SHARE_STATE_APPLY_APPLIED
    result = repo.get_generation(item)
    assert result["shared"] and result["is_final"] and not result["is_held"]


def test_unknown_axis_preserves_existing_but_known_false_clears(item):
    repo.set_generation_hold(item, True)
    ref = intent(item, operation="publish", desired=None, base=None)
    assert apply(ref, item) == repo.SHARE_STATE_APPLY_APPLIED
    assert repo.get_generation(item)["is_held"]
    ref = intent(item, operation="unhold", desired=False, base=True)
    apply(ref, item, held=False)
    assert not repo.get_generation(item)["is_held"]


def test_unshared_observation_always_clears_hold(item):
    repo.set_generation_hold(item, True)
    ref = intent(item, operation="publish", desired=None, base=None)
    apply(ref, item, held=True, shared=False)
    result = repo.get_generation(item)
    assert not result["shared"] and not result["is_held"]


def test_reconciler_never_invents_missing_held_axis():
    observed = reconciler._normalize_observed({"shared": True, "is_final": False}, "x")
    assert "is_held" not in observed
    with pytest.raises(reconciler._RemoteObservationError, match="remote_review_state_unsupported"):
        reconciler._terminal_status({"desired_shared": 1, "desired_final": 0, "desired_held": 1}, observed)
    assert reconciler._terminal_status({"desired_shared": 1, "desired_final": 0}, observed) == "converged"


def test_hold_rejected_without_replay_when_server_still_at_base():
    status = reconciler._terminal_status(
        {"status": "prepared", "desired_shared": 1, "desired_final": 0, "desired_held": 1,
         "base_shared": 1, "base_final": 0, "base_held": 0},
        {"shared": True, "is_final": False, "is_held": False},
    )
    assert status == "rejected"


def test_missing_remote_generation_confirms_no_held_axis(monkeypatch):
    monkeypatch.setattr(reconciler._proxy, "raw_request", Mock(return_value=(200, {"items": {}, "missing": ["x"]})))
    saved = {"intent_id": "i", "server_generation_id": "x", "desired_shared": 0,
             "desired_final": 0, "desired_held": 0}
    observed = reconciler._observe_remote_states("http://review.example.test", "fixture", [saved])["i"]
    assert observed["is_held"] is False
    assert reconciler._terminal_status(saved, observed) == "converged"


@pytest.mark.parametrize("response", [(200, {}), (404, {"detail": "generation 없음"})])
def test_composite_cleanup_clears_held_axis_even_without_response_field(monkeypatch, response):
    monkeypatch.setattr(reconciler._proxy, "raw_request", Mock(return_value=response))
    observed = reconciler._unpublish_remote("http://review.example.test", "fixture", {"server_generation_id": "x"})
    assert not observed["shared"] and not observed["is_final"] and observed["is_held"] is False


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_final_review_atomic_result_and_audit(item, target):
    repo.set_final(item, True, "reviewer")
    result = share.final_review(item, FinalReviewIn(state=target), req())
    assert result["shared"] == (target != "unshared")
    assert not result["is_final"] and result["is_held"] == (target == "held")
    assert result["final_by"] is None
    events = [call.args[0] for call in share.journal_audit_event.call_args_list]
    expected = ["generation.unfinalized"]
    if target == "unshared":
        expected.append("generation.unpublished")
    if target == "held":
        expected.append("generation.held")
    assert events == expected


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_final_review_project_requires_supervisor_for_every_target(item, monkeypatch, target):
    repo.set_final(item, True)
    original = repo.get_generation
    monkeypatch.setattr(repo, "get_generation", lambda gid: {**original(gid), "project_id": "project-review"})
    monkeypatch.setattr(share, "account_global_roles", lambda request: set())
    permission = Mock(side_effect=HTTPException(403, "denied"))
    monkeypatch.setattr(share, "require_project_role", permission)
    with pytest.raises(HTTPException) as error:
        share.final_review(item, FinalReviewIn(state=target), req())
    assert error.value.status_code == 403 and original(item)["is_final"]
    share.require_edit_generation.assert_not_called()
    share.journal_audit_event.assert_not_called()


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_final_review_rejects_stale_menu_without_changes(item, target):
    before = repo.get_generation(item)
    with pytest.raises(HTTPException) as error:
        share.final_review(item, FinalReviewIn(state=target), req())
    assert error.value.status_code == 409 and "새로고침" in error.value.detail
    assert repo.get_generation(item) == before
    share.journal_audit_event.assert_not_called()


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_proxy_final_review_single_write_and_three_axis_intent(item, monkeypatch, target):
    # 로컬은 아직 일반 공유여도 실제 최종 판정은 서버 권위다. 선차단하지 않는다.
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = {**repo.get_generation(item), "id": "remote-review", "shared": target != "unshared",
              "is_final": False, "is_held": target == "held"}
    call = Mock(return_value=remote)
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    assert share.final_review(item, FinalReviewIn(state=target), req()) == remote
    call.assert_called_once_with("POST", "/api/generations/remote-review/final-review", body={"state": target})
    local = repo.get_generation(item)
    assert local["shared"] == remote["shared"] and local["is_held"] == remote["is_held"]
    with db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
    assert saved["operation_kind"] == "final_review" and saved["status"] == "converged"
    assert saved["desired_shared"] == int(target != "unshared")
    assert saved["desired_held"] == int(target == "held")


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_proxy_final_review_missing_route_never_falls_back_to_two_writes(item, monkeypatch, target):
    repo.set_final(item, True)
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    call = Mock(side_effect=HTTPException(404, "Not Found"))
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    with pytest.raises(HTTPException) as error:
        share.final_review(item, FinalReviewIn(state=target), req())
    assert error.value.status_code == 409 and "업데이트" in error.value.detail
    assert call.call_count == 1 and repo.get_generation(item)["is_final"]


@pytest.mark.parametrize("target", ["unshared", "shared", "held"])
def test_proxy_final_review_remote_missing_is_distinct_from_missing_route(item, monkeypatch, target):
    repo.set_final(item, True)
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    monkeypatch.setattr(share._proxy, "proxy_json", Mock(side_effect=HTTPException(404, "generation 없음")))
    if target == "unshared":
        result = share.final_review(item, FinalReviewIn(state=target), req())
        assert not any(result[k] for k in ("shared", "is_final", "is_held"))
        assert not repo.get_generation(item)["is_final"]
    else:
        with pytest.raises(HTTPException) as error:
            share.final_review(item, FinalReviewIn(state=target), req())
        assert error.value.status_code == 404 and "업데이트" not in error.value.detail
        assert repo.get_generation(item)["is_final"]


def test_final_review_mirror_failure_does_not_undo_server(item, monkeypatch):
    repo.set_final(item, True)
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = {**repo.get_generation(item), "is_final": False, "is_held": True}
    call = Mock(return_value=remote)
    monkeypatch.setattr(share._proxy, "proxy_json", call)
    monkeypatch.setattr(repo, "apply_share_state_intent_local", Mock(side_effect=OSError("fixture")))
    result = share.final_review(item, FinalReviewIn(state="held"), req())
    assert isinstance(result, JSONResponse) and b'"mirror_pending":true' in result.body
    assert call.call_count == 1


def test_final_review_http_request_and_response_contract(item):
    app = FastAPI()
    app.include_router(share.router)
    repo.set_final(item, True)
    with TestClient(app) as client:
        response = client.post(f"/api/generations/{item}/final-review", json={"state": "bad"})
        assert response.status_code == 422 and repo.get_generation(item)["is_final"]
        response = client.post(f"/api/generations/{item}/final-review", json={"state": "held"})
        assert response.status_code == 200, response.text
        assert response.json()["is_held"] is True and response.json()["is_final"] is False


def test_legacy_unfinalize_missing_held_does_not_converge(item, monkeypatch):
    repo.set_final(item, True)
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    remote = {**repo.get_generation(item), "is_final": False}
    remote.pop("is_held")
    monkeypatch.setattr(share._proxy, "proxy_json", Mock(return_value=remote))
    with pytest.raises(HTTPException) as error:
        share.unfinalize(item, req())
    assert error.value.status_code == 503 and "업데이트" in error.value.detail
    with db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
    assert saved["status"] == "prepared" and saved["claim_token"] is None
    assert repo.get_generation(item)["is_final"]


def test_different_review_response_mirrors_truth_but_does_not_claim_success(item, monkeypatch):
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    # 다른 사용자가 그 사이 복귀시켰다면 응답의 현재 서버값을 유지한다.
    monkeypatch.setattr(share._proxy, "proxy_json", Mock(return_value=repo.get_generation(item)))
    with pytest.raises(HTTPException) as error:
        share.hold_generation(item, req())
    assert error.value.status_code == 409 and not repo.get_generation(item)["is_held"]
    with db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
    assert saved["status"] == "superseded"
