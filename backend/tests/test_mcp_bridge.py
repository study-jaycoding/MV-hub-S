"""No paid execution: local mailbox, authorization and persistent intent contracts."""
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import db, repo
from app.mcp_models import McpPlanIn
from app.routers import mcp
from app.services.mcp_broker import BrokerError, McpBroker

SECRET = "s" * 43
TAB = "t" * 36
CLIENT_HEADERS = {"X-MVHub-MCP": "1", "X-MVHub-MCP-Secret": SECRET}
APP_HEADERS = {"X-MVHub-Tab": TAB}


def plan_input():
    return {
        "title": "테스트 컷", "context_id": str(uuid4()), "scene_id": "scene1", "scene_hash": "hash",
        "workspace": {"scope": "personal", "id": None, "name": None},
        "items": [{"label": "컷 010", "estimated_credits": 2, "reference_snapshot": [],
                   "request": {"kind": "create", "workspace": {"scope": "personal"},
                               "create": {"prompt": "테스트", "model": "test_model"},
                               "canvas_link": {"scene_id": "scene1", "card_id": str(uuid4()),
                                               "attempt_id": str(uuid4()), "generation_id": str(uuid4())}}}],
    }


@pytest.fixture
def local(tmp_path, monkeypatch):
    path = tmp_path / "hub.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    db.flush_pool()
    db.init_db()
    monkeypatch.setattr(mcp, "broker", McpBroker())
    app = FastAPI()
    app.include_router(mcp.router)
    with TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50123)) as client:
        yield client, path
    db.flush_pool()


def pair(client, *, allow_execution=None):
    response = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={})
    assert response.status_code == 200, response.text
    code = response.json()["pair_code"]
    body = {"pair_code": code}
    if allow_execution is not None:
        body["allow_execution"] = allow_execution
    response = client.post("/api/mcp/app/pair", headers=APP_HEADERS, json=body)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("allow_execution", [None, False])
def test_direct_execution_requires_explicit_pair_permission(local, allow_execution):
    client, _ = local
    assert pair(client, allow_execution=allow_execution)["can_execute"] is False
    connected = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()
    assert connected["paired"] and connected["can_execute"] is False
    p = client.post("/api/mcp/plans", headers=APP_HEADERS, json=plan_input()).json()
    response = client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                           json={"method": "execute_generation_plan", "args": {"plan_id": p["id"]}})
    assert response.status_code == 409
    assert "execution_not_granted" in response.text
    url = "/api/mcp/plans/" + p["id"]
    response = client.post(url + "/approve", headers=APP_HEADERS, json={"revision": 0, "source": "mcp"})
    assert response.status_code == 409
    assert "execution_not_granted" in response.text
    saved = client.get(url, headers=APP_HEADERS).json()
    assert saved["status"] == "proposed" and saved["revision"] == 0
    assert saved["items"][0]["events"] == []
    # The legacy request only opens the app's approval UI; it needs no execution grant.
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "request_execution", "args": {"plan_id": p["id"]}}).status_code == 200


@pytest.mark.parametrize("value", ["true", "false", 1, 0, None])
def test_pair_execution_permission_is_strict_boolean(local, value):
    client, _ = local
    connected = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()
    response = client.post("/api/mcp/app/pair", headers=APP_HEADERS,
                           json={"pair_code": connected["pair_code"], "allow_execution": value})
    assert response.status_code == 422
    assert not client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()["paired"]


def test_repair_cannot_upgrade_existing_connection(local):
    client, _ = local
    pair(client)
    code = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()["pair_code"]
    response = client.post("/api/mcp/app/pair", headers=APP_HEADERS,
                           json={"pair_code": code, "allow_execution": True})
    assert response.status_code == 200, response.text
    assert response.json()["can_execute"] is False
    assert client.post("/api/mcp/app/close", headers=APP_HEADERS, json={}).status_code == 200
    assert pair(client, allow_execution=True)["can_execute"] is True


def test_direct_dispatch_and_approval_preserve_source_and_single_intent(local):
    client, _ = local
    assert pair(client, allow_execution=True)["can_execute"] is True
    assert client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()["can_execute"] is True
    p = client.post("/api/mcp/plans", headers=APP_HEADERS, json=plan_input()).json()
    url = "/api/mcp/plans/" + p["id"]
    action = client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                         json={"method": "execute_generation_plan", "args": {"plan_id": p["id"]}})
    assert action.status_code == 200, action.text
    dispatched = client.get("/api/mcp/app/next", headers=APP_HEADERS).json()["request"]
    assert dispatched == {"id": action.json()["id"], "method": "execute_generation_plan", "args": {"plan_id": p["id"]}}
    assert client.get(url, headers=APP_HEADERS).json()["status"] == "proposed"
    approved = client.post(url + "/approve", headers=APP_HEADERS,
                           json={"revision": 0, "source": "mcp"}).json()
    event = approved["items"][0]["events"][0]
    assert event == {"state": "approved", "source": "mcp", "at": approved["approved_at"]}
    assert client.post(url + "/approve", headers=APP_HEADERS,
                       json={"revision": 0, "source": "mcp"}).status_code == 409
    repeated = client.post(url + "/approve", headers=APP_HEADERS,
                           json={"revision": 1, "source": "app"}).json()
    assert repeated["revision"] == 1 and repeated["items"] == approved["items"]
    submitting = client.post(url + "/item", headers=APP_HEADERS,
                             json={"revision": 1, "index": 0, "state": "submitting"}).json()
    assert submitting["items"][0]["events"][0] == event
    assert submitting["plan"] == p["plan"]


def test_approval_source_rejects_unknown_values(local):
    client, _ = local
    pair(client, allow_execution=True)
    p = client.post("/api/mcp/plans", headers=APP_HEADERS, json=plan_input()).json()
    url = "/api/mcp/plans/" + p["id"]
    assert client.post(url + "/approve", headers=APP_HEADERS,
                       json={"revision": 0, "source": "system"}).status_code == 422
    assert client.get(url, headers=APP_HEADERS).json()["revision"] == 0


def test_local_roundtrip_requires_pairing_and_hides_credentials(local):
    client, _ = local
    connected = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()
    assert SECRET not in str(connected)
    assert not connected["paired"]
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "read_context", "args": {}}).status_code == 409
    pair(client)
    submitted = client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                            json={"method": "read_context", "args": {"kind": "scene"}}).json()
    dispatched = client.get("/api/mcp/app/next", headers=APP_HEADERS).json()["request"]
    assert submitted["id"] == dispatched["id"]
    assert dispatched["args"] == {"kind": "scene"}
    assert client.post("/api/mcp/app/reply", headers=APP_HEADERS,
                       json={"id": submitted["id"], "result": {"scene": "씬"}}).status_code == 200
    response = client.get("/api/mcp/client/result", params={"id": submitted["id"]}, headers=CLIENT_HEADERS)
    assert response.json() == {"status": "done", "result": {"scene": "씬"}, "error": None}


@pytest.mark.parametrize("extra", [{"Origin": "http://127.0.0.1"}, {"Origin": "https://evil.example"},
                                   {"Referer": "http://127.0.0.1"}, {"Sec-Fetch-Site": "none"},
                                   {"Host": "evil.example"}, {"X-MVHub-MCP": "0"},
                                   {"X-Forwarded-For": "192.168.1.50"}])
def test_client_browser_and_remote_context_denied(local, extra):
    client, _ = local
    assert client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS | extra, json={}).status_code == 403


def test_secrets_tab_and_method_limits(local):
    client, _ = local
    assert client.post("/api/mcp/client/connect", json={}).status_code == 403
    pair(client)
    assert client.get("/api/mcp/app/check", headers={"X-MVHub-Tab": "x" * 36}).status_code == 403
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "approve", "args": {}}).status_code == 422
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "read_context", "args": {"blob": "x" * 65536}}).status_code == 413
    assert client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS | {"X-MVHub-MCP-Secret": "x" * 43}, json={}).status_code == 409
    assert client.post("/api/mcp/app/close", headers=APP_HEADERS, json={}).status_code == 200
    assert client.get("/api/mcp/app/check", headers=APP_HEADERS).status_code == 409


def test_binding_rotation_and_ttl():
    broker = McpBroker()
    code = broker.connect(SECRET, "test")["pair_code"]
    broker.pair(code, "account-db-session", TAB)
    with pytest.raises(BrokerError, match="계정"):
        broker.app_guard("changed-session", TAB)
    assert broker.client is None
    code = broker.connect(SECRET, "test")["pair_code"]
    broker.pair(code, "identity", TAB)
    broker.client["seen"] -= 46
    with pytest.raises(BrokerError, match="app_not_connected"):
        broker.client_guard(SECRET)


def test_queue_bound_single_dispatch_and_expiry():
    async def run():
        broker = McpBroker()
        code = broker.connect(SECRET, "test")["pair_code"]
        broker.pair(code, "identity", TAB)
        for _ in range(8):
            broker.enqueue("read_context", {})
        with pytest.raises(BrokerError) as error:
            broker.enqueue("read_context", {})
        assert error.value.status == 429
        first = (await broker.next("identity", TAB, 0))["request"]
        assert first
        assert (await broker.next("identity", TAB, 0))["request"] is None
        broker.requests[first["id"]]["created"] -= 121
        with pytest.raises(BrokerError):
            broker.reply(first["id"], {}, None)
        assert (await broker.next("identity", TAB, 0))["request"]["id"] != first["id"]
    asyncio.run(run())


def test_completed_requests_do_not_block_next_tools():
    async def run():
        broker = McpBroker()
        code = broker.connect(SECRET, "test")["pair_code"]
        broker.pair(code, "identity", TAB)
        for _ in range(40):
            rid = broker.enqueue("read_context", {})["id"]
            assert (await broker.next("identity", TAB, 0))["request"]["id"] == rid
            broker.reply(rid, {"ok": True}, None)
            assert (await broker.result(SECRET, rid, 0))["status"] == "done"
        assert len(broker.requests) == 32
    asyncio.run(run())


def test_plan_validation_and_immutable_intent(local):
    client, path = local
    pair(client)
    raw = plan_input()
    response = client.post("/api/mcp/plans", headers=APP_HEADERS, json=raw)
    assert response.status_code == 201, response.text
    p = response.json()
    original = copy.deepcopy(p["plan"])
    assert p["status"] == "proposed" and p["revision"] == 0
    assert p["source"] == "mcp"
    assert repo.get_mcp_plan("someone-else", p["id"], path) is None
    url = "/api/mcp/plans/" + p["id"]
    assert client.post(url + "/item", headers=APP_HEADERS,
                       json={"revision": 0, "index": 0, "state": "submitting"}).status_code == 409
    approved = client.post(url + "/approve", headers=APP_HEADERS, json={"revision": 0}).json()
    assert approved["approved_at"]
    assert approved["items"][0]["events"] == [{"state": "approved", "source": "app", "at": approved["approved_at"]}]
    assert client.post(url + "/approve", headers=APP_HEADERS, json={"revision": 0}).status_code == 409
    assert client.post(url + "/approve", headers=APP_HEADERS, json={"revision": 1}).json()["revision"] == 1
    submitting = client.post(url + "/item", headers=APP_HEADERS,
                             json={"revision": 1, "index": 0, "state": "submitting"}).json()
    assert submitting["revision"] == 2
    # Reopening DB connections preserves intent; this is not a process-restart test.
    db.flush_pool()
    saved = client.get(url, headers=APP_HEADERS).json()
    assert saved["plan"] == original and saved["items"][0]["state"] == "submitting"
    assert client.post(url + "/item", headers=APP_HEADERS,
                       json={"revision": 2, "index": 0, "state": "submitting"}).status_code == 409
    uncertain = client.post(url + "/item", headers=APP_HEADERS,
                            json={"revision": 2, "index": 0, "state": "uncertain", "error": "확인 필요"}).json()
    assert uncertain["plan"] == original
    assert len(uncertain["items"][0]["events"]) == 3
    assert uncertain["items"][0]["events"][0] == approved["items"][0]["events"][0]
    assert client.put(url, headers=APP_HEADERS, json=raw).status_code == 405


@pytest.mark.parametrize("interruption", ["broker_restart", "lease_expiry", "account_change"])
@pytest.mark.parametrize("state", ["submitting", "uncertain"])
def test_reconnect_preserves_intent_without_restoring_execution_permission(local, monkeypatch, interruption, state):
    client, _ = local
    pair(client, allow_execution=True)
    record = client.post("/api/mcp/plans", headers=APP_HEADERS, json=plan_input()).json()
    url = "/api/mcp/plans/" + record["id"]
    assert client.post(url + "/approve", headers=APP_HEADERS,
                       json={"revision": 0, "source": "mcp"}).status_code == 200
    saved = client.post(url + "/item", headers=APP_HEADERS,
                        json={"revision": 1, "index": 0, "state": "submitting"}).json()
    if state == "uncertain":
        saved = client.post(url + "/item", headers=APP_HEADERS,
                            json={"revision": 2, "index": 0, "state": "uncertain", "error": "응답 확인 불가"}).json()
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "get_plan", "args": {"plan_id": record["id"]}}).status_code == 200
    if interruption == "broker_restart":
        # Rebuild volatile broker state, not an actual uvicorn process restart.
        monkeypatch.setattr(mcp, "broker", McpBroker())
        assert client.get(url, headers=APP_HEADERS).status_code == 409
    elif interruption == "lease_expiry":
        mcp.broker.client["seen"] -= mcp.broker.APP_TTL + 1
        assert client.get(url, headers=APP_HEADERS).status_code == 409
    else:
        with monkeypatch.context() as changed:
            changed.setattr(mcp, "actor_id", lambda request: "different-account")
            assert client.get(url, headers=APP_HEADERS).status_code == 403
        assert mcp.broker.client is None
    db.flush_pool()
    assert pair(client)["can_execute"] is False
    assert mcp.broker.requests == {}
    restored = client.get(url, headers=APP_HEADERS).json()
    assert restored == saved
    assert restored["items"][0]["events"][0]["source"] == "mcp"
    assert client.post(url + "/item", headers=APP_HEADERS,
                       json={"revision": restored["revision"], "index": 0, "state": "submitting"}).status_code == 409
    repeated = client.post(url + "/approve", headers=APP_HEADERS,
                           json={"revision": restored["revision"]}).json()
    assert repeated == restored
    assert client.post("/api/mcp/client/action", headers=CLIENT_HEADERS,
                       json={"method": "execute_generation_plan", "args": {"plan_id": record["id"]}}).status_code == 409


def test_concurrent_sqlite_claim_grants_one_submission_intent(local):
    _, path = local
    record = repo.create_mcp_plan("race-owner", plan_input(), path)
    approved = repo.update_mcp_plan("race-owner", record["id"], 0, path, approval_source="mcp")
    ready = Barrier(2)

    def claim():
        ready.wait(timeout=5)
        try:
            repo.update_mcp_plan("race-owner", record["id"], approved["revision"], path,
                                 index=0, state="submitting")
        except ValueError:
            return False
        return True

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: claim(), range(2)))
    assert sorted(results) == [False, True]
    saved = repo.get_mcp_plan("race-owner", record["id"], path)
    assert saved["revision"] == 2 and saved["plan"] == record["plan"]
    assert [event["state"] for event in saved["items"][0]["events"]] == ["approved", "submitting"]


@pytest.mark.parametrize("mutation", ["depends", "too_many", "duplicate", "workspace", "scene", "nan"])
def test_invalid_plans_rejected(mutation):
    raw = plan_input()
    if mutation == "depends":
        raw["items"][0]["depends_on"] = 0
    elif mutation == "too_many":
        raw["items"] *= 21
    elif mutation == "duplicate":
        raw["items"] *= 2
    elif mutation == "workspace":
        raw["workspace"] = {"scope": "unknown"}
    elif mutation == "scene":
        raw["scene_id"] = "different"
    else:
        raw["items"][0]["estimated_credits"] = float("nan")
    with pytest.raises(ValidationError):
        McpPlanIn.model_validate(raw)


def test_real_middleware_keeps_app_routes_private(local, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "AUTH_ENABLED", True)
    client = TestClient(main.app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50123))
    try:
        assert client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).status_code == 200
        assert client.get("/api/mcp/app/check", headers=APP_HEADERS).status_code == 401
        assert client.get("/api/mcp/app/setup", headers=APP_HEADERS).status_code == 401
        assert client.get("/api/mcp/plans/" + str(uuid4()), headers=APP_HEADERS).status_code == 401
    finally:
        client.close()


def test_setup_before_pair_only_returns_paths_and_existing_files(local, monkeypatch, tmp_path):
    client, _ = local
    root = tmp_path / "app"
    monkeypatch.setattr(mcp, "_ROOT", root)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    expected_python = tmp_path / "MVHub-MCP" / "venv" / "Scripts" / "python.exe"
    expected_adapter = root / "tools" / "mcp_adapter" / "server.py"
    expected_adapter.parent.mkdir(parents=True)
    expected_adapter.write_bytes(b"# inert test adapter")
    response = client.get("/api/mcp/app/setup", headers=APP_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "url": "http://127.0.0.1:8012", "adapter": str(expected_adapter), "adapter_exists": True,
        "python": str(expected_python), "python_exists": False, "python_args": [],
    }
    assert mcp.broker.client is None and mcp.broker.requests == {}
    # An inert file is enough: setup must inspect existence, never execute Python.
    expected_python.parent.mkdir(parents=True)
    expected_python.write_bytes(b"not an executable")
    connected = client.post("/api/mcp/client/connect", headers=CLIENT_HEADERS, json={}).json()
    before = copy.deepcopy(mcp.broker.client)
    response = client.get("/api/mcp/app/setup", headers=APP_HEADERS)
    assert response.status_code == 200 and response.json()["python_exists"] is True
    assert set(response.json()) == {"url", "adapter", "adapter_exists", "python", "python_exists", "python_args"}
    assert response.json()["python"] == str(expected_python) and response.json()["python_args"] == []
    assert SECRET not in response.text and TAB not in response.text
    assert connected["pair_code"] not in response.text
    assert mcp.broker.client == before and mcp.broker.requests == {}


def test_setup_without_localappdata_has_no_python_path(local, monkeypatch):
    client, _ = local
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    response = client.get("/api/mcp/app/setup", headers=APP_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json()["python"] is None and response.json()["python_exists"] is False
    assert response.json()["python_args"] == []


def test_setup_complete_bundle_works_without_localappdata(local, monkeypatch, tmp_path):
    client, _ = local
    root = tmp_path / "bundled-app"
    python = root / "runtime" / "python" / "python.exe"
    adapter = root / "tools" / "mcp_adapter" / "server.py"
    sdk = root / "tools" / "mcp_adapter" / "site-packages" / "mcp" / "__init__.py"
    for path in (python, adapter, sdk):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"inert test file")
    monkeypatch.setattr(mcp, "_ROOT", root)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    response = client.get("/api/mcp/app/setup", headers=APP_HEADERS)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "url": "http://127.0.0.1:8012", "adapter": str(adapter), "adapter_exists": True,
        "python": str(python), "python_exists": True, "python_args": ["-I", "-S"],
    }
    assert mcp.broker.client is None


@pytest.mark.parametrize("missing", ["python", "adapter", "sdk", "runtime"])
def test_setup_incomplete_bundle_never_falls_back_to_dev_venv(local, monkeypatch, tmp_path, missing):
    client, _ = local
    root = tmp_path / "bundled-app"
    paths = {
        "python": root / "runtime" / "python" / "python.exe",
        "adapter": root / "tools" / "mcp_adapter" / "server.py",
        "sdk": root / "tools" / "mcp_adapter" / "site-packages" / "mcp" / "__init__.py",
    }
    root.mkdir()
    if missing == "runtime":
        # VERSION alone marks an installation even if its entire runtime is absent.
        (root / "VERSION.txt").write_text("test-version", encoding="utf-8")
    else:
        (root / "runtime" / "python").mkdir(parents=True)
    for name, path in paths.items():
        if name == missing or (missing == "runtime" and name == "python"):
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"inert test file")
    dev_root = tmp_path / "local-app-data"
    dev_python = dev_root / "MVHub-MCP" / "venv" / "Scripts" / "python.exe"
    dev_python.parent.mkdir(parents=True)
    dev_python.write_bytes(b"inert fallback executable")
    monkeypatch.setattr(mcp, "_ROOT", root)
    monkeypatch.setenv("LOCALAPPDATA", str(dev_root))
    response = client.get("/api/mcp/app/setup", headers=APP_HEADERS)
    assert response.status_code == 503, response.text
    assert "MCP 번들이 불완전합니다. 앱을 다시 설치하세요." in response.json()["detail"]
    assert str(dev_python) not in response.text


@pytest.mark.parametrize("headers", [
    {}, APP_HEADERS | {"Origin": "https://evil.example"}, APP_HEADERS | {"Host": "evil.example"},
    APP_HEADERS | {"X-Forwarded-For": "127.0.0.1, 192.0.2.10"},
])
def test_setup_rejects_missing_tab_and_external_browser_context(local, headers):
    client, _ = local
    assert client.get("/api/mcp/app/setup", headers=headers).status_code == 403
    assert mcp.broker.client is None


def test_setup_rejects_remote_client_even_with_loopback_headers(local):
    client, _ = local
    with TestClient(client.app, base_url="http://127.0.0.1:8012", client=("192.0.2.10", 50123)) as remote:
        response = remote.get("/api/mcp/app/setup", headers=APP_HEADERS | {"X-Forwarded-For": "127.0.0.1"})
    assert response.status_code == 403


def setup_with_server(client, server):
    async def app(scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "server": server}
            if server is None:
                scope.pop("server")
        await client.app(scope, receive, send)

    with TestClient(app, base_url="http://127.0.0.1:5173", client=("127.0.0.1", 50123)) as routed:
        return routed.get("/api/mcp/app/setup", headers=APP_HEADERS | {
            "Host": "127.0.0.1:9999", "X-Forwarded-Port": "6666", "X-Forwarded-Host": "evil.example:7777",
        })


@pytest.mark.parametrize("host, expected", [
    ("127.0.0.1", "127.0.0.1"), ("0.0.0.0", "127.0.0.1"), ("::", "[::1]"), ("::1", "[::1]"),
])
def test_setup_uses_asgi_server_and_ignores_spoofed_ports(local, host, expected):
    client, _ = local
    response = setup_with_server(client, (host, 8016))
    assert response.status_code == 200, response.text
    assert response.json()["url"] == f"http://{expected}:8016"


@pytest.mark.parametrize("server", [None, ("127.0.0.1", 0), ("127.0.0.1", 65536), ("127.0.0.1", "8016"), ("127.0.0.1", True)])
def test_setup_cannot_fall_back_to_header_port(local, server):
    client, _ = local
    assert setup_with_server(client, server).status_code == 503


def test_setup_real_middleware_never_proxies(local, monkeypatch):
    from app import main
    from app.routers import _proxy

    def unexpected_proxy(*args, **kwargs):
        raise AssertionError("MCP setup must not forward requests to the shared server")

    monkeypatch.setattr(main, "AUTH_ENABLED", False)
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(_proxy, "_forward", unexpected_proxy)
    monkeypatch.setattr(_proxy, "_forward_stream", unexpected_proxy)
    client = TestClient(main.app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50123))
    try:
        assert client.get("/api/mcp/app/setup", headers=APP_HEADERS).status_code == 200
        assert _proxy.is_local_path("/api/mcp/app/setup")
    finally:
        client.close()


def test_health_survives_sqlite_error_and_mcp_paths_close_with_503(local, monkeypatch):
    # 비밀값을 DB 에서 다시 읽다 sqlite 오류가 나도 health 는 200·hub_id 만 빠진다. MCP 업무 경로는 503(Codex 리뷰 ①)
    import sqlite3
    from fastapi import HTTPException
    from app import main
    from app.routers import mcp_v2

    def broken():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(mcp_v2, "hub_id", broken)
    client = TestClient(main.app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50123))
    try:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert "hub_id" not in response.json()["mcp_bridge"]
    finally:
        client.close()
    with pytest.raises(HTTPException) as caught:
        mcp_v2._required_hub_id()
    assert caught.value.status_code == 503


def test_capability_probe_is_public_and_never_proxied(local, monkeypatch):
    from app import main
    from app.routers import _proxy

    def unexpected_proxy(*args, **kwargs):
        raise AssertionError("health must not inspect or contact the shared server")

    monkeypatch.setattr(main, "AUTH_ENABLED", True)
    monkeypatch.setattr(_proxy, "proxying", unexpected_proxy)
    client = TestClient(main.app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50123))
    try:
        response = client.get("/api/health")
        assert response.status_code == 200
        bridge = response.json()["mcp_bridge"]
        assert bridge["protocol"] == 1 and bridge["transport"] == "stdio-local"
        assert bridge["persistent_protocol"] == 2
        assert set(bridge["features"]) == {"generation_result", "batch_results", "history_cursor", "plan_estimate"}
        assert len(bridge["hub_id"]) == 64
        assert _proxy.is_local_path("/api/mcp/client/connect")
    finally:
        client.close()
