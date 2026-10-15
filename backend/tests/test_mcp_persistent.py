"""Isolated v2 contracts; generation submission is mocked, never paid CLI calls."""
import asyncio
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import active_account, config, db, deps, repo
from app.repo import mcp_v2 as store
from app.routers import auth as auth_router, gen_requests, mcp_v2 as api, _proxy

APP_HEADERS = {"X-MVHub-Tab": "t" * 40}


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    db.flush_pool()
    db.init_db()
    for module in (config, deps, gen_requests):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    account = repo.register("mcp@example.test", "testpass")
    credentials = {}
    def configure(name, setup, credential):
        credentials[name] = credential
        return {"client": name, "status": "configured", "message": "ok"}
    monkeypatch.setattr(api, "_configure_local", configure)
    async def models():
        return [{"job_set_type": "test_model", "type": "image"}]
    async def params(model):
        return {"params": [{"name": "seed", "type": "integer"}, {"name": "quality", "type": "string", "enum": ["low", "high"]}]}
    monkeypatch.setattr(api.generation, "list_models", models)
    monkeypatch.setattr(api.generation, "model_params", params)
    app = FastAPI()
    @app.middleware("http")
    async def session(request, call_next):
        request.state.account = repo.get_account(account["email"])
        return await call_next(request)
    app.include_router(api.router)
    app.include_router(auth_router.router)
    with TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50421)) as client:
        yield client, credentials, account
    db.flush_pool()


def configure(local, names=None, execute=True, scope="workspace"):
    client, credentials, _ = local
    response = client.post("/api/mcp/v2/app/configure", headers=APP_HEADERS,
        json={"clients": names or ["codex"], "scope": scope,
              **({"workspace": {"scope": "personal"}} if scope == "workspace" else {}), "allow_execution": execute})
    assert response.status_code == 200, response.text
    assert all(item["status"] == "configured" for item in response.json()["clients"]), response.text
    assert "secret" not in response.text
    return response.json()


def headers(local, name="codex"):
    return {"X-MVHub-MCP": "1", "X-MVHub-MCP-Secret": local[1][name]["secret"]}


def action(local, method, args=None, name="codex"):
    return local[0].post("/api/mcp/v2/client/action", headers=headers(local, name), json={"method": method, "args": args or {}})


def prepare(local, **item):
    response = action(local, "prepare_generation_plan", {"title": "normal", "context_id": None,
        "items": [{"label": "one", "prompt": "hello", "model": "test_model", "params": {"seed": 3}, **item}]})
    assert response.status_code == 200, response.text
    return response.json()


def test_multiclient_restart_and_independent_revocation(local):
    configure(local, ["codex", "claude"])
    db.flush_pool()
    for name in ("codex", "claude"):
        response = local[0].post("/api/mcp/v2/client/connect", headers=headers(local, name), json={})
        assert response.status_code == 200, response.text
        assert response.json()["client_id"] == local[1][name]["client_id"]
    cid = local[1]["codex"]["client_id"]
    assert local[0].post(f"/api/mcp/v2/app/clients/{cid}/revoke", headers=APP_HEADERS).status_code == 200
    assert action(local, "read_context").status_code == 403
    assert action(local, "read_context", name="claude").status_code == 200


@pytest.mark.parametrize("name", ["codex", "claude"])
def test_automatic_reregistration_revokes_only_replaced_client(local, name):
    configure(local, ["codex", "claude"])
    previous = headers(local, name)
    configure(local, [name])
    response = local[0].post("/api/mcp/v2/client/connect", headers=previous, json={})
    assert response.status_code == 403
    assert action(local, "read_context", name=name).status_code == 200
    assert action(local, "read_context", name="claude" if name == "codex" else "codex").status_code == 200


@pytest.mark.parametrize("name,status", [("codex", "manual"), ("claude", "manual"), ("other", "configured")])
def test_manual_or_other_registration_preserves_existing_grant(local, monkeypatch, name, status):
    configure(local, [name])
    previous = headers(local, name)
    def manual(client, setup, credential):
        local[1][client] = credential
        return {"client": client, "status": status, "message": "manual"}
    monkeypatch.setattr(api, "_configure_local", manual)
    response = local[0].post("/api/mcp/v2/app/configure", headers=APP_HEADERS,
        json={"clients": [name], "workspace": {"scope": "personal"}, "allow_execution": True})
    assert response.status_code == 200 and response.json()["clients"][0]["status"] == status
    assert local[0].post("/api/mcp/v2/client/connect", headers=previous, json={}).status_code == 200
    assert action(local, "read_context", name=name).status_code == 200


@pytest.mark.parametrize("change", ["password", "blocked", "secret", "logout"])
def test_grant_rechecks_security_state(local, change):
    configure(local)
    if change == "logout":
        assert local[0].post("/api/auth/logout").status_code == 200
    else:
        with db.get_connection() as conn:
            if change == "password":
                conn.execute("UPDATE account SET password_changed_at='new-stamp'")
            elif change == "blocked":
                conn.execute("UPDATE account SET status='blocked'")
            else:
                conn.execute("UPDATE app_setting SET value='rotated' WHERE key='auth_secret'")
        if change == "secret":
            db.flush_pool()
    assert action(local, "read_context").status_code == 403


def test_prepare_has_no_canvas_or_submission_and_plan_is_client_owned(local, monkeypatch):
    configure(local, ["codex", "claude"])
    async def forbidden(*args, **kwargs):
        raise AssertionError("prepare must not submit")
    monkeypatch.setattr(gen_requests, "create_gen_request", forbidden)
    plan = prepare(local)
    assert plan["status"] == "planned"
    assert action(local, "get_plan", {"plan_id": plan["id"]}, "claude").status_code == 404
    assert action(local, "request_execution", {"plan_id": plan["id"]}).json()["status"] == "planned"
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM mcp_canvas_task").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM gen_request").fetchone()[0] == 0


def test_execute_once_uses_normal_authorized_route(local, monkeypatch):
    configure(local)
    calls = []
    async def submit(body, request):
        calls.append((body, request))
        return {"id": "test-generation"}
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    plan = prepare(local)
    for _ in range(2):
        result = action(local, "execute_generation_plan", {"plan_id": plan["id"]})
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "submitted"
    assert len(calls) == 1
    body, request = calls[0]
    assert body.canvas_link is None and body.idempotency_key
    assert request.url.path == "/api/gen-requests"
    assert request.state.account["email"] == local[2]["email"]


def test_uncertain_never_automatically_resubmits(local, monkeypatch):
    configure(local)
    calls = []
    async def submit(*args):
        calls.append(1)
        raise TimeoutError()
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    plan = prepare(local)
    result = action(local, "execute_generation_plan", {"plan_id": plan["id"]}).json()
    assert result["items"][0]["state"] == "uncertain"
    action(local, "execute_generation_plan", {"plan_id": plan["id"]})
    assert len(calls) == 1


def test_model_reference_and_path_inputs_fail_closed(local):
    configure(local)
    for item in ({"model": "unknown"}, {"params": {"file_path": "C:\\secret"}},
                 {"params": {"seed": True}}, {"params": {"quality": "bad"}},
                 {"reference_ids": ["https://external.test/image"]}, {"folder_path": "../other"}):
        response = action(local, "prepare_generation_plan", {"title": "bad", "items": [
            {"label": "one", "prompt": "hello", "model": "test_model", **item}]})
        assert response.status_code in (404, 422), response.text


def test_explicit_canvas_attachment_scoped_and_idempotent(local, monkeypatch):
    configure(local)
    async def submit(*args):
        return {"id": "existing-generation"}
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    plan = prepare(local)
    action(local, "execute_generation_plan", {"plan_id": plan["id"]})
    owner = local[2]["creator_uid"] or "acct:" + local[2]["email"]
    repo.sync_scene_backups(owner, "", [{"id": "personal-scene", "name": "mine", "data": '{"id":"personal-scene"}'},
        {"id": "team-scene", "name": "team", "data": '{"id":"team-scene","workspace":{"id":"other-team"}}'}], [])
    assert action(local, "add_to_canvas", {"plan_id": plan["id"], "scene_id": "team-scene"}).status_code == 404
    first = action(local, "add_to_canvas", {"plan_id": plan["id"], "scene_id": "personal-scene"}).json()
    second = action(local, "add_to_canvas", {"plan_id": plan["id"], "scene_id": "personal-scene"}).json()
    assert first["id"] == second["id"]
    assert first["generation_ids"] == ["existing-generation"]
    listed = local[0].get("/api/mcp/v2/app/canvas-tasks?workspace_scope=personal", headers=APP_HEADERS).json()
    assert listed["tasks"] == [first]
    url = f"/api/mcp/v2/app/canvas-tasks/{first['id']}/complete"
    assert local[0].post(url, headers=APP_HEADERS, json={"workspace": {"scope": "team", "id": "wrong"}}).status_code == 404
    for _ in range(2):
        assert local[0].post(url, headers=APP_HEADERS, json={"workspace": {"scope": "personal"}}).status_code == 200


def test_browser_cannot_use_client_credentials(local):
    configure(local)
    response = local[0].post("/api/mcp/v2/client/connect", headers={**headers(local), "Origin": "http://127.0.0.1:8012"}, json={})
    assert response.status_code == 403


def test_execution_permission_is_not_implied_by_registration(local):
    configure(local, execute=False)
    plan = prepare(local)
    assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 403


def test_pinned_upstream_does_not_change_or_leak(monkeypatch):
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: "http://new.test")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "new-token")
    with _proxy.pinned_connection(("http://original.test", "original-token")):
        assert _proxy.base_url() == "http://original.test"
        assert _proxy.token() == "original-token"
    assert _proxy.base_url() == "http://new.test"


def test_account_switch_blocks_prior_grants(local):
    configure(local)
    repo.set_setting("mcp_active_account", "another@example.test")
    assert action(local, "read_context").status_code == 403


def test_normal_route_deployment_pause_is_enforced(local, monkeypatch):
    configure(local)
    plan = prepare(local)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    repo.set_setting("generation_deployment_paused", "1")
    async def forbidden(*args):
        raise AssertionError("normal route must block before usecase")
    monkeypatch.setattr(gen_requests, "submit_gen_request", forbidden)
    response = action(local, "execute_generation_plan", {"plan_id": plan["id"]})
    assert response.status_code == 200
    assert response.json()["status"] == "attention"


def test_normal_route_receives_validated_command(local, monkeypatch):
    configure(local)
    plan = prepare(local)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "schedule_telemetry_drain", lambda: None)
    commands = []
    async def submit(command):
        commands.append(command)
        return {"id": "queued"}
    monkeypatch.setattr(gen_requests, "submit_gen_request", submit)
    response = action(local, "execute_generation_plan", {"plan_id": plan["id"]})
    assert response.json()["status"] == "submitted", response.text
    assert len(commands) == 1 and commands[0].canvas_link is None
    assert commands[0].email == local[2]["email"]


def test_concurrent_execute_claims_plan_once(local, monkeypatch):
    configure(local)
    plan = prepare(local)
    credential = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as executor:
        claimed = list(executor.map(lambda _: store.claim_plan(credential, plan["id"]), range(4)))
    assert claimed.count(True) == 1


def test_get_plan_observes_committed_queue_after_crash(local):
    configure(local)
    plan = prepare(local)
    credential = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    internal = store.get_plan(credential, plan["id"])
    store.claim_plan(credential, plan["id"])
    with db.get_connection() as conn:
        conn.execute("INSERT INTO gen_request(id,account_email,gen_id,kind,payload,status,idempotency_key) VALUES(?,?,?,'create','{}','pending',?)",
            (str(uuid4()), local[2]["email"], "crash-generation", internal["items"][0]["idempotency_key"]))
    result = action(local, "get_plan", {"plan_id": plan["id"]}).json()
    assert result["items"][0]["generation_id"] == "crash-generation"
    assert result["items"][0]["state"] == "submitted"


def test_reference_handles_are_client_scoped_and_revalidated(local, monkeypatch):
    configure(local, ["codex", "claude"])
    credential = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    row = {"id": "gen", "workspace_scope": "personal", "workspace_id": None,
           "assets": [{"id": "asset", "type": "image", "file_path": "/media/test.png"}]}
    rid = store.save_reference(credential, {"kind": "generation", "id": "gen", "asset_id": "asset"},
        api.mcp.digest(store.encode(row["assets"])), {"file_path": "/media/test.png", "type": "image", "source_gen_id": "gen"})
    monkeypatch.setattr(api.library, "get_generation", lambda *args: row)
    plan = prepare(local, reference_ids=[rid])
    assert "file_path" not in str(plan)
    row["assets"][0]["file_path"] = "/media/replaced.png"
    assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 409
    response = action(local, "prepare_generation_plan", {"title": "cross", "items": [
        {"label": "one", "prompt": "hi", "model": "test_model", "reference_ids": [rid]}]}, "claude")
    assert response.status_code == 404


def test_real_normal_queue_no_canvas_and_status_observation(local, monkeypatch):
    from app.usecases import gen_requests as usecase
    configure(local)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "schedule_telemetry_drain", lambda: None)
    monkeypatch.setattr(usecase, "_schedule_request_estimate", lambda *args: None)
    repo.ensure_default_worker()
    plan = prepare(local)
    result = action(local, "execute_generation_plan", {"plan_id": plan["id"]})
    assert result.status_code == 200 and result.json()["status"] == "submitted", result.text
    gen_id = result.json()["items"][0]["generation_id"]
    with db.get_connection() as conn:
        row = conn.execute("SELECT * FROM gen_request WHERE gen_id=?", (gen_id,)).fetchone()
        assert row["account_email"] == local[2]["email"] and row["status"] == "pending"
        assert row["canvas_scene_id"] is None
        conn.execute("UPDATE generation SET status='failed' WHERE id=?", (gen_id,))
    observed = action(local, "get_plan", {"plan_id": plan["id"]}).json()
    assert observed["items"][0]["generation_status"] == "failed"


def test_real_asset_tree_issues_handle_and_detects_replacement(local, tmp_path, monkeypatch):
    configure(local)
    folder = tmp_path / "authorized-assets"
    folder.mkdir()
    image = folder / "image.png"
    image.write_bytes(b"fixture")
    monkeypatch.setattr(api.assets, "_owner_mounts", lambda owner: [{"name": "my-assets"}])
    monkeypatch.setattr(api.assets, "_mount_dir", lambda name, owner: folder if name == "my-assets" else None)
    monkeypatch.setattr(api.assets, "_auto_project_mounts", lambda *args: [])
    monkeypatch.setattr(api.assets.asset_watcher, "watch", lambda *args, **kwargs: None)
    response = action(local, "read_context", {"kind": "references", "asset_project": "my-assets"})
    assert response.status_code == 200, response.text
    references = response.json()["references"]
    assert len(references) == 1 and "file_path" not in references[0]
    plan = prepare(local, reference_ids=[references[0]["id"]])
    image.write_bytes(b"changed-version")
    assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 409
    assert action(local, "read_context", {"kind": "references", "asset_project": str(folder)}).status_code == 404


def test_auth_off_upstream_account_required_and_pinned(local, monkeypatch):
    from starlette.requests import Request
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": local[2]["email"], "uid": "local-uid"}])
    monkeypatch.setattr(_proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: "http://isolated.test")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "stored-test-token")
    request = Request({"type": "http", "method": "POST", "path": "/api/mcp/v2/client/action", "headers": [], "state": {}})
    calls = []
    def probe(method, url, **kwargs):
        calls.append((url, kwargs["token"], active_account.capture_account_pin()))
        return 200, local[2]
    monkeypatch.setattr(_proxy, "raw_request", probe)
    ctx = api._capture(request)
    assert ctx.owner == config.DEFAULT_WORKER_ID
    assert calls == [("http://isolated.test/api/auth/me", "stored-test-token", (local[2]["email"], "local-uid"))]
    cid = store.create_client(api.mcp.digest("s" * 43), ctx.hub, ctx.owner, local[2]["email"], None,
                              {"scope": "personal", "id": None, "name": None}, "codex", True)
    assert api._capture(request, "s" * 43).client["id"] == cid
    monkeypatch.setattr(active_account, "_cache", [True, {"email": "other@example.test", "uid": "other-uid"}])
    with pytest.raises(HTTPException):
        api._capture(request, "s" * 43)
    monkeypatch.setattr(_proxy, "_stored_token", lambda: None)
    with pytest.raises(HTTPException):
        api._capture(request, "s" * 43)


def test_empty_canvas_poll_skips_upstream_auth_but_pending_poll_authenticates(local, monkeypatch):
    configure(local)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": local[2]["email"], "uid": local[2]["creator_uid"]}])
    monkeypatch.setattr(_proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: "http://isolated.test")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "test-token")
    probes = []
    def probe(*args, **kwargs):
        probes.append(1)
        return 200, local[2]
    monkeypatch.setattr(_proxy, "raw_request", probe)
    url = "/api/mcp/v2/app/canvas-tasks?workspace_scope=personal"
    response = local[0].get(url, headers=APP_HEADERS)
    assert response.status_code == 200 and response.json() == {"tasks": []}
    assert probes == []
    client = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    plan = store.create_plan(client, "queued", [{"label": "item"}])
    store.add_canvas_task(client, plan["id"], "scene", ["generation"])
    response = local[0].get(url, headers=APP_HEADERS)
    assert response.status_code == 200 and len(response.json()["tasks"]) == 1, response.text
    assert probes == [1]
    monkeypatch.setattr(_proxy, "raw_request", lambda *args, **kwargs: (401, {}))
    assert local[0].get(url, headers=APP_HEADERS).status_code == 403


def test_empty_canvas_poll_still_requires_local_app_headers(local):
    url = "/api/mcp/v2/app/canvas-tasks?workspace_scope=personal"
    assert local[0].get(url).status_code == 403
    assert local[0].get(url, headers={**APP_HEADERS, "Origin": "https://external.test"}).status_code == 403


def test_auth_off_submit_matches_browser_local_creator_when_upstream_uid_differs(local, monkeypatch):
    from starlette.requests import Request
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(gen_requests, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": local[2]["email"], "uid": "pointer-uid"}])
    repo.set_setting("my_creator_uid", "local-creator")
    monkeypatch.setattr(_proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: "http://isolated.test")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "test-token")
    monkeypatch.setattr(_proxy, "raw_request", lambda *args, **kwargs: (200, {**local[2], "creator_uid": "different-upstream-creator"}))
    request = Request({"type": "http", "method": "POST", "path": "/api/gen-requests", "headers": [], "state": {}})
    ctx = api._capture(request)
    commands = []
    async def submit(command):
        commands.append(command)
        return {"id": str(uuid4())}
    monkeypatch.setattr(gen_requests, "submit_gen_request", submit)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "schedule_telemetry_drain", lambda: None)
    body = api.GenRequestIn.model_validate({"workspace": {"scope": "personal"}, "create": {"prompt": "same", "model": "test_model"}})
    async def run():
        with active_account.pinned_account_scope(ctx.pin):
            await gen_requests.create_gen_request(body, request)
            await gen_requests.create_gen_request(body, api._internal(ctx, "/api/gen-requests", submit=True))
    asyncio.run(run())
    assert len(commands) == 2
    assert [command.email for command in commands] == [local[2]["email"]] * 2
    assert [command.creator_uid for command in commands] == ["local-creator"] * 2


def test_auth_secret_unavailable_returns_retryable_service_error(local, monkeypatch):
    configure(local)
    def unavailable():
        raise api.auth.AuthSecretUnavailable()
    monkeypatch.setattr(api.auth, "get_secret", unavailable)
    response = action(local, "read_context")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"


@pytest.fixture
def team_access(local, monkeypatch):
    allowed = {"team-a", "team-b"}
    def available(request):
        assert request.url.path == "/api/workspaces/available"
        return {"workspaces": [{"id": key, "name": key.upper()} for key in ("team-a", "team-b", "not-member")]}
    def policy(request, workspace_id):
        assert request.url.path == "/api/manage/credit-plan/my-models"
        if workspace_id not in allowed:
            raise HTTPException(403, "not a member")
        return {"workspace_id": workspace_id, "allowed_models": []}
    monkeypatch.setattr(api.generation, "available_workspaces", available)
    monkeypatch.setattr(api.manage, "credit_plan_my_models", policy)
    monkeypatch.setattr(repo, "list_workspace_registry", lambda *args, **kwargs: [
        {"id": key, "name": key.upper()} for key in allowed])
    return allowed


def scoped_plan(local, scope="personal", workspace_id=None, name="codex", **item):
    return action(local, "prepare_generation_plan", {"title": "scoped", "workspace_scope": scope,
        "workspace_id": workspace_id, "items": [{"label": "one", "prompt": "hello", "model": "test_model", **item}]}, name)


def test_account_grant_requires_explicit_scope_and_preserves_legacy(local, team_access):
    configure(local, ["claude"])
    configure(local, scope="account")
    for args in ({}, {"kind": "models"}, {"workspace_scope": "team"},
                 {"workspace_scope": "personal", "workspace_id": "team-a"}):
        assert action(local, "read_context", args).status_code == 422
    assert action(local, "read_context", {"workspace_scope": "personal"}).status_code == 200
    assert action(local, "read_context", name="claude").status_code == 200
    assert action(local, "read_context", {"workspace_scope": "team", "workspace_id": "team-a"}, "claude").status_code == 409
    response = local[0].post("/api/mcp/v2/app/configure", headers=APP_HEADERS,
        json={"clients": ["other"], "scope": "account", "workspace": {"scope": "personal"}})
    assert response.status_code == 422
    assert action(local, "prepare_generation_plan", {"title": "bad", "items": [
        {"label": "one", "prompt": "hello", "model": "test_model"}]}).status_code == 422
    discovered = action(local, "read_context", {"kind": "workspaces"}).json()["workspaces"]
    assert {ws["id"] for ws in discovered} == {None, "team-a", "team-b"}
    assert action(local, "read_context", {"kind": "workspaces"}, "claude").json()["workspaces"] == [
        {"scope": "personal", "id": None, "name": None}]


def test_account_plans_remain_independent_across_workspaces(local, team_access, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    configure(local, ["codex", "claude"], scope="account")
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda wid: scoped_plan(local, "team", wid), ["team-a", "team-b"]))
    assert all(response.status_code == 200 for response in responses)
    plans = [response.json() for response in responses]
    calls = []
    async def submit(body, request):
        calls.append(body.workspace.id)
        return {"id": "generation-" + body.workspace.id}
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    for plan in plans:
        assert action(local, "get_plan", {"plan_id": plan["id"]}, "claude").status_code == 404
        for _ in range(2):
            assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 200
    assert calls == ["team-a", "team-b"]
    owner = local[2]["creator_uid"] or "acct:" + local[2]["email"]
    repo.sync_scene_backups(owner, "", [{"id": "scene-a", "name": "a", "data":
        '{"id":"scene-a","workspace":{"scope":"team","id":"team-a"}}'}], [])
    attached = action(local, "add_to_canvas", {"plan_id": plans[0]["id"], "scene_id": "scene-a"})
    assert attached.status_code == 200 and attached.json()["workspace"]["id"] == "team-a"
    assert action(local, "add_to_canvas", {"plan_id": plans[1]["id"], "scene_id": "scene-a"}).status_code == 404
    team_access.remove("team-a")
    for method in ("get_plan", "execute_generation_plan", "get_result", "add_to_canvas"):
        args = {"plan_id": plans[0]["id"], **({"scene_id": "scene-a"} if method == "add_to_canvas" else {})}
        assert action(local, method, args).status_code == 403
    assert action(local, "get_plan", {"plan_id": plans[1]["id"]}).status_code == 200


def test_reference_handle_cannot_cross_account_grant_workspaces(local, team_access, monkeypatch):
    configure(local, scope="account")
    row = {"id": "gen-a", "workspace_scope": "team", "workspace_id": "team-a",
        "assets": [{"id": "asset-a", "type": "image", "file_path": "/media/a.jpg"}]}
    monkeypatch.setattr(api, "_generations", lambda *args: [row])
    monkeypatch.setattr(api.library, "get_generation", lambda *args: row)
    response = action(local, "read_context", {"kind": "references", "workspace_scope": "team", "workspace_id": "team-a"})
    rid = response.json()["references"][0]["id"]
    assert scoped_plan(local, "team", "team-a", reference_ids=[rid]).status_code == 200
    assert scoped_plan(local, "team", "team-b", reference_ids=[rid]).status_code == 404
    credential = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    assert store.get_reference(credential, rid)["source"]["workspace"] == {"scope": "team", "id": "team-a"}


@pytest.fixture
def result_plan(local, monkeypatch):
    configure(local, ["codex", "claude"])
    plan = prepare(local)
    async def submit(*args):
        return {"id": "result-generation"}
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    assert action(local, "execute_generation_plan", {"plan_id": plan["id"]}).status_code == 200
    row = {"id": "result-generation", "status": "done", "creator_uid": local[2]["creator_uid"],
        "workspace_scope": "personal", "workspace_id": None,
        "assets": [{"type": "image", "file_path": "/media/original.png", "thumbnail_path": "/media/poster.jpg"}]}
    monkeypatch.setattr(api.library, "get_generation", lambda *args: row)
    return plan, row


def test_result_returns_bounded_jpeg_without_source_and_does_not_mutate_plan(local, result_plan, tmp_path, monkeypatch):
    from PIL import Image
    import base64
    root = tmp_path / ".thumbs"
    root.mkdir()
    path = root / "thumb.jpg"
    Image.new("RGB", (32, 32), "red").save(path)
    monkeypatch.setattr(api.thumbs, "THUMB_DIR", root)
    calls = []
    async def thumbnail(src, w):
        calls.append((src, w))
        return api.FileResponse(path, media_type="image/jpeg")
    monkeypatch.setattr(api.library, "media_thumb", thumbnail)
    plan, _ = result_plan
    before = action(local, "get_plan", {"plan_id": plan["id"]}).json()
    response = action(local, "get_result", {"plan_id": plan["id"]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["generation_status"] == "done" and result["asset_type"] == "image"
    assert base64.b64decode(result["media"]["data_base64"]) == path.read_bytes()
    assert calls == [("/media/poster.jpg", 512)]
    assert "file_path" not in response.text and "original.png" not in response.text and str(root) not in response.text
    assert action(local, "get_plan", {"plan_id": plan["id"]}).json() == before
    assert action(local, "get_result", {"plan_id": plan["id"]}, "claude").status_code == 404
    assert action(local, "get_result", {"plan_id": plan["id"], "src": "http://unsafe"}).status_code == 422


@pytest.mark.parametrize("status", ["pending", "running", "failed"])
def test_result_never_previews_unfinished_generation(local, result_plan, monkeypatch, status):
    plan, row = result_plan
    row["status"] = status
    async def forbidden(*args, **kwargs):
        raise AssertionError("unfinished generation must not read media")
    monkeypatch.setattr(api.library, "media_thumb", forbidden)
    result = action(local, "get_result", {"plan_id": plan["id"]}).json()
    assert result["generation_status"] == status and result["media"] is None


@pytest.mark.parametrize("thumbnail", [None, "/media/original.mp4", "/media/original.mp4?different=1", "/media/other.mp4"])
def test_result_video_never_downloads_original(local, result_plan, monkeypatch, thumbnail):
    plan, row = result_plan
    row["assets"] = [{"type": "video", "file_path": "/media/original.mp4", "thumbnail_path": thumbnail}]
    async def forbidden(*args, **kwargs):
        raise AssertionError("video original must not be downloaded")
    monkeypatch.setattr(api.library, "media_thumb", forbidden)
    assert action(local, "get_result", {"plan_id": plan["id"]}).json()["media"] is None


@pytest.mark.parametrize("failure", ["outside", "invalid", "large", "ssrf"])
def test_result_preview_failures_return_metadata_only(local, result_plan, tmp_path, monkeypatch, failure):
    plan, row = result_plan
    root = tmp_path / ".thumbs"
    root.mkdir()
    monkeypatch.setattr(api.thumbs, "THUMB_DIR", root)
    path = (tmp_path if failure == "outside" else root) / "thumb.jpg"
    path.write_bytes(b"x" * (512 * 1024 + 1) if failure == "large" else b"not-a-jpeg")
    widths = []
    async def thumbnail(src, w):
        widths.append(w)
        if failure == "ssrf":
            raise HTTPException(400, "private address including sensitive path")
        return api.FileResponse(path, media_type="image/jpeg")
    monkeypatch.setattr(api.library, "media_thumb", thumbnail)
    response = action(local, "get_result", {"plan_id": plan["id"]})
    assert response.status_code == 200 and response.json()["media"] is None
    assert widths == ([512, 256] if failure == "large" else [512])
    assert "sensitive" not in response.text


@pytest.mark.parametrize("small_height", [455, 600])
def test_result_portrait_jpeg_retries_smaller_thumbnail(local, result_plan, tmp_path, monkeypatch, small_height):
    from PIL import Image
    import base64
    plan, row = result_plan
    row["assets"][0]["type"] = "video"
    root = tmp_path / ".thumbs"
    root.mkdir()
    monkeypatch.setattr(api.thumbs, "THUMB_DIR", root)
    for width, height in ((512, 910), (256, small_height)):
        Image.new("RGB", (width, height), "red").save(root / f"poster-{width}.jpg")
    widths = []
    async def thumbnail(src, w):
        widths.append(w)
        return api.FileResponse(root / f"poster-{w}.jpg", media_type="image/jpeg")
    monkeypatch.setattr(api.library, "media_thumb", thumbnail)
    response = action(local, "get_result", {"plan_id": plan["id"]})
    assert response.status_code == 200, response.text
    assert widths == [512, 256]
    media = response.json()["media"]
    if small_height <= 512:
        assert base64.b64decode(media["data_base64"]) == (root / "poster-256.jpg").read_bytes()
    else:
        assert media is None


def test_result_rechecks_grant_after_thumbnail_read(local, result_plan, tmp_path, monkeypatch):
    plan, _ = result_plan
    async def thumbnail(src, w):
        cid = local[1]["codex"]["client_id"]
        credential = store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
        store.revoke(cid, credential["owner_uid"], credential["account_email"])
        raise HTTPException(404, "missing")
    monkeypatch.setattr(api.library, "media_thumb", thumbnail)
    assert action(local, "get_result", {"plan_id": plan["id"]}).status_code == 403


def test_result_rejects_mismatched_generation_owner_or_workspace(local, result_plan):
    plan, row = result_plan
    row["workspace_scope"], row["workspace_id"] = "team", "other"
    assert action(local, "get_result", {"plan_id": plan["id"]}).status_code == 404
    row["workspace_scope"], row["workspace_id"] = "personal", None
    row["creator_uid"] = "another-owner"
    assert action(local, "get_result", {"plan_id": plan["id"]}).status_code == 404


def test_result_real_queue_supports_unlinked_account_creator(local, monkeypatch):
    from app.usecases import gen_requests as usecase
    configure(local)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "schedule_telemetry_drain", lambda: None)
    monkeypatch.setattr(usecase, "_schedule_request_estimate", lambda *args: None)
    repo.ensure_default_worker()
    plan = prepare(local)
    queued = action(local, "execute_generation_plan", {"plan_id": plan["id"]}).json()
    gen_id = queued["items"][0]["generation_id"]
    with db.get_connection() as conn:
        row = conn.execute("SELECT creator_uid FROM generation WHERE id=?", (gen_id,)).fetchone()
        assert row["creator_uid"] == "acct:" + local[2]["email"]
    pending = action(local, "get_result", {"plan_id": plan["id"]})
    assert pending.status_code == 200 and pending.json()["media"] is None, pending.text
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    done = action(local, "get_result", {"plan_id": plan["id"]})
    assert done.status_code == 200 and done.json()["generation_status"] == "done", done.text
    assert "완료되었지만" in done.json()["note"]


def test_account_connect_and_workspace_search(local, team_access):
    configure(local, scope="account")
    response = local[0].post("/api/mcp/v2/client/connect", headers=headers(local), json={})
    assert response.json()["scope"] == "account" and response.json()["workspace"] is None
    rows = action(local, "read_context", {"kind": "workspaces", "search": "TEAM-B", "limit": 1}).json()["workspaces"]
    assert [row["id"] for row in rows] == ["team-b"]


def test_result_real_thumbnail_route_blocks_private_remote_source(local, result_plan, monkeypatch):
    plan, row = result_plan
    row["assets"][0]["thumbnail_path"] = "http://127.0.0.1:9/private.jpg"
    response = action(local, "get_result", {"plan_id": plan["id"]})
    assert response.status_code == 200 and response.json()["media"] is None, response.text
    assert "127.0.0.1" not in response.text
