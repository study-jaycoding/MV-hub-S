from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from app.repo import hf_org_usage as repo
from app.routers import hf_org_usage as routes
from app.usecases import hf_org_usage as usecase
from app.services import hf_org_usage_collector as worker
from app.services import hf_org_usage_client as remote
from hf_org_usage_fake import FAKE_KEY, ORG, api_error, configured, fake_server, report_page, world

BASE = "/api/admin/hf-org-usage"


@pytest.fixture
def web(world, monkeypatch):
    actor = dict(email="admin@example.test", status="approved", global_role="admin")
    state = dict(actor=actor, host="127.0.0.1")
    monkeypatch.setattr(routes.config, "AUTH_ENABLED", True)
    monkeypatch.setattr(routes.config, "MANAGE_ENABLED", True)
    monkeypatch.setattr(routes.deps, "require_admin", lambda _: None)
    monkeypatch.setattr(routes.deps, "current_account", lambda _: actor)
    monkeypatch.setattr(routes.deps, "assert_account_current", lambda _: None)
    monkeypatch.setattr(routes.repo, "get_account", lambda _: state["actor"])
    app = FastAPI()
    @app.middleware("http")
    async def direct_client(request, call_next):
        request.scope["client"] = (state["host"], 1234)
        return await call_next(request)
    app.include_router(routes.router)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, state


def test_hub_external_pc_and_current_admin_checks(web, monkeypatch):
    client, state = web
    monkeypatch.setattr(routes.config, "AUTH_ENABLED", False)
    assert client.get(BASE+"/status").status_code == 404
    monkeypatch.setattr(routes.config, "AUTH_ENABLED", True)
    state["host"] = "203.0.113.1"
    assert client.get(BASE+"/status").status_code == 403
    state["host"] = "127.0.0.1"
    assert client.get(BASE+"/status", headers={"X-Forwarded-For": "203.0.113.1"}).status_code == 403
    state["actor"] = dict(state["actor"], global_role="member")
    assert client.get(BASE+"/status").status_code == 403


@pytest.mark.parametrize("body,code", [(b"{bad",400), (b"x"*4097,413), (b'[]',400)])
def test_body_rejected_without_echo(web, body, code):
    client, _ = web
    answer = client.put(BASE+"/key", content=body)
    assert answer.status_code == code
    assert body.decode() not in answer.text


def test_register_check_enable_delete_and_no_secret_response(web, monkeypatch):
    client, _ = web
    monkeypatch.setattr(usecase, "_confirm", lambda *args: dict(org_id=ORG))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    response = client.put(BASE+"/key", json=dict(api_key=FAKE_KEY, expected_revision=0))
    assert response.status_code == 200
    meta = response.json()
    assert not meta["enabled"] and meta["revision"] == 1 and FAKE_KEY not in response.text
    assert client.post(BASE+"/key/check", json=dict(expected_revision=1)).status_code == 200
    assert not repo.read_config()["enabled"]
    assert client.patch(BASE+"/collector", json=dict(expected_revision=1, enabled=True)).status_code == 200
    assert repo.read_config()["enabled"] and repo.read_config()["revision"] == 2
    assert client.request("DELETE", BASE+"/key", json=dict(expected_revision=1)).status_code == 409
    response = client.request("DELETE", BASE+"/key", json=dict(expected_revision=2))
    assert response.status_code == 200 and response.json()["state"] == "none"
    assert repo.read_config()["org_id"] == ORG


def test_role_revoked_during_external_check_cannot_save(web, monkeypatch):
    client, state = web
    def confirm(*args):
        state["actor"] = dict(state["actor"], global_role="member")
        return dict(org_id=ORG)
    monkeypatch.setattr(usecase, "_confirm", confirm)
    response = client.put(BASE+"/key", json=dict(api_key=FAKE_KEY, expected_revision=0))
    assert response.status_code == 403
    assert repo.read_config()["encrypted_key"] is None


def test_get_comparison_never_reserves_or_calls_remote(web, monkeypatch):
    client, _ = web
    def forbidden(*args, **kwargs):
        raise AssertionError("GET must be local")
    monkeypatch.setattr(worker, "request_page", forbidden)
    monkeypatch.setattr(repo, "reserve_windows", forbidden)
    answer = client.get(BASE+"/comparison?start=2026-11-01&end=2026-11-02")
    assert answer.status_code == 200 and answer.json()["api_net_c"] is None


def test_restored_key_check_is_required_before_enable(world, monkeypatch):
    from app import manage_db
    from app.services.db_scrub import pause_hf_org_usage_for_restore
    configured()
    pause_hf_org_usage_for_restore(manage_db.MANAGE_DB_PATH)
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    revision = repo.read_config()["revision"]
    with pytest.raises(Exception, match="key_check_required"):
        usecase.set_collection(True, revision)
    monkeypatch.setattr(usecase, "_confirm", lambda *args: dict(org_id=ORG))
    usecase.check_key(None, revision, lambda: None)
    assert not repo.read_config()["enabled"] and repo.read_config()["restore_paused"]
    assert usecase.set_collection(True, revision)["enabled"]


def test_key_registration_and_check_use_official_loopback_protocol(web, monkeypatch):
    client, _ = web
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    def empty_page(query):
        return (200, {}, report_page(query["starting_at"][0], query["ending_at"][0]))
    with fake_server([(500, {}, api_error("report_limit_exceeded")), empty_page, empty_page], organization=True) as (url, calls):
        monkeypatch.setattr(remote, "ENDPOINT", url)
        response = client.put(BASE+"/key", json=dict(api_key=FAKE_KEY, expected_revision=0))
        assert response.status_code == 200
        assert response.json()["registered"] and not response.json()["enabled"]
        response = client.post(BASE+"/key/check", json=dict(expected_revision=1))
        assert response.status_code == 200 and response.json()["check_code"] == "ok"
        assert len(calls) == 3 and "limit=500" in calls[1]
    assert repo.read_config()["encrypted_key"] == "encrypted-fixture"


def test_saved_key_auth_failure_stops_collection_but_candidate_failure_does_not(web, monkeypatch):
    client, _ = web
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    context = configured()
    replies = [(401, {}, api_error("invalid_api_key")), (403, {}, api_error("missing_scope"))]
    with fake_server(replies, organization=True) as (url, _):
        monkeypatch.setattr(remote, "ENDPOINT", url)
        assert client.post(BASE+"/key/check", json=dict(api_key=FAKE_KEY, expected_revision=context["revision"])).status_code == 409
        assert repo.read_collector()["pause_code"] is None
        assert client.post(BASE+"/key/check", json=dict(expected_revision=context["revision"])).status_code == 409
    assert repo.read_collector()["pause_code"] == "http_403"
    assert repo.read_config()["key_verified_revision"] is None
