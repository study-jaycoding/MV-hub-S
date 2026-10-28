"""Reference ingestion uses temporary assets/DBs; no external generation or synchronization."""
import io
import asyncio
import contextlib
import contextvars
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from starlette.requests import Request

from app import active_account, config, deps, repo
from app.repo import mcp_v2 as store
from app.routers import mcp_v2 as api, _proxy
from app.services import asset_sync, thumbs, upload_limits
from test_mcp_persistent import local, configure, headers, action, prepare, team_access

URL = "/api/mcp/v2/client/references/import"


@pytest.mark.parametrize("dependency", [api._client_context, api._upload_client_context], ids=["json", "upload"])
@pytest.mark.parametrize("aborted", [False, True])
def test_client_dependency_closes_scopes_in_request_context(monkeypatch, dependency, aborted):
    account, connection = contextvars.ContextVar("test-account"), contextvars.ContextVar("test-connection")
    events = []
    ctx = SimpleNamespace(pin=("account", "uid"), upstream=("isolated", "token"), client={"id": "client"})
    @contextlib.contextmanager
    def pinned(variable, value):
        token = variable.set(value)
        try:
            yield
        finally:
            variable.reset(token)
            events.append("closed")
    monkeypatch.setattr(api, "_capture", lambda *_args: ctx)
    monkeypatch.setattr(api.active_account, "pinned_account_scope", lambda value: pinned(account, value))
    monkeypatch.setattr(api._proxy, "pinned_connection", lambda value: pinned(connection, value))
    def current(value):
        assert value is ctx and account.get() == ctx.pin and connection.get() == ctx.upstream
        events.append("checked")
    monkeypatch.setattr(api, "_still_current", current)
    monkeypatch.setattr(store, "touch_client", lambda value: events.append(value))
    async def exercise():
        generator = dependency(None, "secret")
        assert await anext(generator) is ctx
        assert account.get() == ctx.pin and connection.get() == ctx.upstream
        if aborted:
            with pytest.raises(RuntimeError, match="request failed"):
                await generator.athrow(RuntimeError("request failed"))
        else:
            await generator.aclose()
        assert account.get(None) is None and connection.get(None) is None
        assert events == ["checked", "client", "closed", "closed"]
    asyncio.run(exercise())


def picture(color="navy"):
    output = io.BytesIO()
    Image.new("RGB", (96, 54), color).save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def reference_store(local, tmp_path, monkeypatch):
    configure(local)
    root = tmp_path / "assets"
    root.mkdir()
    monkeypatch.setattr(api.assets, "ASSETS_ROOT", root)
    monkeypatch.setattr(api.assets, "_owner_mounts", lambda owner: [])
    monkeypatch.setattr(api.assets, "_auto_project_mounts", lambda *args: [])
    monkeypatch.setattr(api.assets.asset_watcher, "watch_combined", lambda *args: None)
    monkeypatch.setattr(thumbs, "THUMB_DIR", tmp_path / "thumbs")
    return root


def upload(local, data=None, **query):
    return local[0].post(URL, params={"filename": "attached.png", "workspace_scope": "personal", **query},
                         content=picture() if data is None else data, headers=headers(local))


def test_empty_import_reuses_content_and_real_handle(local, reference_store):
    first = upload(local)
    assert first.status_code == 200, first.text
    first = first.json()
    assert first["stored"] == "copy" and first["reused"] is False
    reference = first["reference"]
    assert reference["project"] == "imp/cap" and reference["path"] == "imports/attached.png"
    saved = store.get_reference(store.client_for_secret(api.mcp.digest(headers(local)["X-MVHub-MCP-Secret"])), reference["id"])
    assert saved["source"] == {"kind": "asset", "project": "imp/cap", "path": "imports/attached.png",
                               "workspace": {"scope": "personal", "id": None}}
    assert saved["version"] and saved["reference"]["file_path"] == "asset:imp/cap|imports/attached.png"
    assert prepare(local, reference_ids=[reference["id"]])["status"] == "planned"
    second = upload(local, label="renamed").json()
    assert second["reused"] is True and second["reference"]["id"] == reference["id"]
    assert len(list((reference_store / "imports").iterdir())) == 1


@pytest.mark.parametrize("changed", ["replace", "delete"])
def test_import_handle_rejects_changed_file(local, reference_store, changed):
    reference = upload(local).json()["reference"]
    target = reference_store / reference["path"]
    if changed == "replace":
        target.write_bytes(picture("orange"))
    else:
        target.unlink()
    response = action(local, "prepare_generation_plan", {"title": "check", "items": [
        {"label": "one", "prompt": "hello", "model": "test_model", "reference_ids": [reference["id"]]}]})
    assert response.status_code == 409


def test_upload_keeps_client_and_workspace_boundaries(local, reference_store, team_access):
    configure(local, ["codex", "claude"], scope="account")
    reference = upload(local).json()["reference"]
    item = {"label": "one", "prompt": "hi", "model": "test_model", "reference_ids": [reference["id"]]}
    for client, scope in (("claude", {"workspace_scope": "personal"}),
                          ("codex", {"workspace_scope": "team", "workspace_id": "team-a"})):
        response = action(local, "prepare_generation_plan", {"title": "cross", "items": [item], **scope}, client)
        assert response.status_code == 404


@pytest.mark.parametrize("extra", [{"Origin": "http://localhost"}, {"Referer": "http://localhost"},
                                  {"Sec-Fetch-Site": "none"}, {"X-MVHub-MCP": "0"},
                                  {"X-MVHub-MCP-Secret": "invalid"}, {"X-MVHub-MCP-Secret": "z" * 43}])
def test_bad_auth_cannot_commit(local, reference_store, extra):
    response = local[0].post(URL, params={"filename": "a.png"}, content=picture(),
                             headers={**headers(local), **extra})
    assert response.status_code == 403
    assert list(reference_store.iterdir()) == []


def test_remote_client_cannot_upload(local, reference_store):
    client = TestClient(local[0].app, base_url="http://127.0.0.1:18123", client=("203.0.113.9", 12345))
    try:
        response = client.post(URL, params={"filename": "a.png"}, headers=headers(local), content=picture())
        assert response.status_code == 403
        assert list(reference_store.iterdir()) == []
    finally:
        client.close()


@pytest.mark.parametrize("name,data", [("fake.png", b"not png"), ("fake.jpg", picture()),
                                      ("a.gif", b"GIF89a"), ("a.webp", b"RIFF0000xxxx")])
def test_image_format_is_checked_again_at_hub(local, reference_store, name, data):
    assert upload(local, data, filename=name).status_code == 422
    assert not list(reference_store.rglob("*.part"))
    assert not list(reference_store.rglob("*.png"))


@pytest.mark.parametrize("length", [None, "1", "999"])
def test_raw_length_must_match(local, reference_store, length):
    extra = {} if length is None else {"Content-Length": length}
    response = local[0].post(URL, params={"filename": "a.png"}, content=iter([picture()]),
                             headers={**headers(local), **extra})
    assert response.status_code == 400
    assert not list(reference_store.rglob("*.part"))


@pytest.mark.parametrize("excess", [0, 1])
def test_64mib_boundary_without_request_body(local, reference_store, monkeypatch, excess):
    maximum = upload_limits.REFERENCE_UPLOAD_MAX_BYTES
    original = Request.body
    async def forbidden(self):
        if self.url.path == URL:
            raise AssertionError("raw upload must not read the whole request")
        return await original(self)
    monkeypatch.setattr(Request, "body", forbidden)
    def chunks():
        yield b"\x89PNG\r\n\x1a\n"
        left = maximum + excess - 8
        block = b"x" * (1024 * 1024)
        while left:
            chunk = block[:min(left, len(block))]
            left -= len(chunk)
            yield chunk
    response = local[0].post(URL, params={"filename": "large.png"}, content=chunks(),
                             headers={**headers(local), "Content-Length": str(maximum + excess)})
    assert response.status_code == (413 if excess else 200), response.text
    assert not list(reference_store.rglob("*.part"))


def test_internal_request_pins_account_and_reports_sync_failure(local, reference_store, monkeypatch):
    seen = []
    capture = asset_sync.capture_local_operation
    def inspect(request):
        seen.append((request.state.account["email"], list(request.headers), active_account.capture_account_pin()))
        return capture(request)
    monkeypatch.setattr(asset_sync, "capture_local_operation", inspect)
    def fail(*args, **kwargs):
        raise RuntimeError("isolated sync failure")
    monkeypatch.setattr(asset_sync, "register_local", fail)
    response = upload(local)
    assert response.status_code == 200 and response.json()["sync_state"] == "registration_failed"
    assert seen and seen[0][0] == local[2]["email"] and seen[0][1] == []
    assert list((reference_store / "imports").glob("*.png"))


def test_auth_off_import_uses_internal_local_account_and_pinned_connection(local, reference_store, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_cache", [True, {"email": local[2]["email"], "uid": "local-creator"}])
    repo.set_setting("my_creator_uid", "local-creator")
    monkeypatch.setattr(_proxy, "is_worker_hub", lambda: True)
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: "http://isolated.test")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "test-token")
    monkeypatch.setattr(_proxy, "raw_request", lambda *a, **kw:
        (200, {**local[2], "creator_uid": "different-upstream-creator"}))
    context = api._capture(Request({"type": "http", "method": "POST", "path": URL, "headers": [], "state": {}}))
    secret = "s" * 43
    store.create_client(api.mcp.digest(secret), context.hub, context.owner, local[2]["email"], None,
                        {"scope": "personal", "id": None, "name": None}, "codex", True)
    local[1]["codex"] = {"secret": secret}
    seen = []
    original = asset_sync.capture_local_operation
    def capture(request):
        seen.append((request.state.account["creator_uid"], _proxy.base_url(), _proxy.token()))
        return original(request)
    def register(path, file_path, digest, size, kind, owner, project):
        seen.append((owner, _proxy.base_url(), _proxy.token()))
        return {"sync_state": "local_only"}
    monkeypatch.setattr(asset_sync, "capture_local_operation", capture)
    monkeypatch.setattr(asset_sync, "register_local", register)
    response = upload(local)
    assert response.status_code == 200, response.text
    assert seen == [("local-creator", "http://isolated.test", "test-token")] * 2


def test_project_checked_before_commit_and_revocation_after_match(local, reference_store, monkeypatch):
    assert upload(local, project_id="not-visible").status_code == 404
    assert list(reference_store.iterdir()) == []
    monkeypatch.setattr(api, "_authorize_asset_project", lambda *args: None)
    async def revoke(*args):
        credential = store.client_for_secret(api.mcp.digest(headers(local)["X-MVHub-MCP-Secret"]))
        store.revoke(credential["id"], credential["owner_uid"], credential["account_email"])
        return {"attempted": True, "complete": False, "linked": False, "candidates": []}
    monkeypatch.setattr(api.reference_match, "match_reference", revoke)
    assert upload(local, asset_project="isolated").status_code == 403
    assert not list(reference_store.rglob("*.png")) and not list(reference_store.rglob("*.part"))


def test_exact_original_has_no_import_copy(local, reference_store, monkeypatch):
    root = reference_store / "source"
    root.mkdir()
    (root / "original.png").write_bytes(picture())
    monkeypatch.setattr(api.assets, "_owner_mounts", lambda owner: [{"name": "source"}])
    monkeypatch.setattr(api.assets, "_mount_dir", lambda name, owner: root if name == "source" else None)
    response = upload(local, asset_project="source")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["stored"] == "original" and result["match"]["complete"] and result["match"]["linked"]
    assert result["reference"]["path"] == "original.png" and result["reference"]["project"] == "source"
    assert not list((reference_store / "imports").iterdir())
    assert prepare(local, reference_ids=[result["reference"]["id"]])["status"] == "planned"


def test_workspace_access_is_rechecked_after_match(local, reference_store, monkeypatch, team_access):
    configure(local, scope="account")
    monkeypatch.setattr(api, "_authorize_asset_project", lambda *args: None)
    async def lose_membership(*args):
        team_access.remove("team-a")
        return {"attempted": True, "complete": False, "linked": False, "candidates": []}
    monkeypatch.setattr(api.reference_match, "match_reference", lose_membership)
    response = upload(local, workspace_scope="team", workspace_id="team-a", asset_project="source")
    assert response.status_code == 403
    assert not list(reference_store.rglob("*.png"))
    assert not list(reference_store.rglob("*.part"))


def test_revocation_during_final_tree_read_prevents_handle_issue(local, reference_store, monkeypatch):
    original = api._asset_tree
    def revoke(ctx, ws, project):
        tree = original(ctx, ws, project)
        store.revoke(ctx.client["id"], ctx.owner, ctx.account["email"])
        return tree
    monkeypatch.setattr(api, "_asset_tree", revoke)
    def must_not_issue(*args, **kwargs):
        raise AssertionError("revoked client received a reference")
    monkeypatch.setattr(store, "save_reference", must_not_issue)
    assert upload(local).status_code == 403
    assert not list(reference_store.rglob("*.part"))


def test_upload_uses_real_auth_middleware_exception(local, reference_store, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "AUTH_ENABLED", True)
    client = TestClient(main.app, base_url="http://127.0.0.1:18123", client=("127.0.0.1", 50512))
    try:
        response = client.post(URL, params={"filename": "a.png"}, headers=headers(local), content=picture())
        assert response.status_code == 200, response.text
    finally:
        client.close()
