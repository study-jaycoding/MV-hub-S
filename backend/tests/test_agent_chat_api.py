"""Ask Agent 칸 HTTP — 격리 DB·가짜 CLI·가짜 제출. 실제 Claude·Codex·생성·공유 서버 없음."""
import os
import sys
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, db, deps, repo
from app.repo import agent_chat as chat_store
from app.repo import mcp_v2 as mcp_store
from app.routers import _proxy, agent_chat as router, auth as auth_router, gen_requests, mcp as mcp_router, mcp_v2 as api
from app.services import agent_chat as chat
from app.services import agent_chat_process as process

FAKE = Path(__file__).with_name("agent_chat_fake_cli.py")
EMAIL = "panel@example.test"
HEADERS = {"X-MVHub-Expect-Account": f"acct:{EMAIL}"}
windows = pytest.mark.skipif(os.name != "nt", reason="Windows Job Object")


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    db.flush_pool()
    db.init_db()
    for module in (config, deps, gen_requests):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    account = repo.register(EMAIL, "testpass")
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    monkeypatch.setattr(process, "engine_prefix", lambda engine: [sys.executable, str(FAKE)])
    monkeypatch.setattr(process, "cli_version", lambda prefix: "0.162.0-alpha.17.2")
    service = chat.AgentChat()
    monkeypatch.setattr(chat, "service", service)
    monkeypatch.setattr(router, "service", service)
    profiles = []

    class FakeSetup:  # 전역 LLM 설정·%LOCALAPPDATA% 를 건드리지 않는다 — 발급된 비밀값만 받아 둔다(어댑터 역할 시험용)
        def write_panel_profile(self, setup, credential):
            profiles.append(credential)
            return {"command": sys.executable, "args": ["adapter.py", "--panel"]}

    monkeypatch.setattr(api, "_setup_module", lambda: FakeSetup())

    async def setup(request, identity=None):
        return {"url": "http://127.0.0.1:8012", "python": sys.executable, "adapter": "adapter.py"}

    monkeypatch.setattr(mcp_router, "setup", setup)

    async def models():
        return [{"job_set_type": "test_model", "type": "image"}]

    async def params(model):
        return {"params": [{"name": "seed", "type": "integer"}]}

    monkeypatch.setattr(api.generation, "list_models", models)
    monkeypatch.setattr(api.generation, "model_params", params)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_slow")
    app = FastAPI()

    @app.middleware("http")
    async def session(request, call_next):
        request.state.account = repo.get_account(account["email"])
        return await call_next(request)

    app.include_router(api.router)
    app.include_router(router.router)
    app.include_router(auth_router.router)
    with TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50431)) as client:
        yield client, profiles, service
    service.shutdown()
    db.flush_pool()


def panel_headers(client):
    response = client.post("/api/agent-chat/session", headers=HEADERS)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["account_email"] == EMAIL and {e["id"] for e in body["engines"] if e["available"]} == {"claude", "codex"}
    return {**HEADERS, "X-MVHub-Panel": body["secret"]}


def start_turn(client, headers, **body):
    payload = {"idempotency_key": uuid4().hex, "engine": "claude", "model": "haiku", "effort": "low",
               "text": "고양이 한 장 계획해 줘", "context": {"tab": "my"}, **body}
    return client.post("/api/agent-chat/turns", headers=headers, json=payload)


def adapter_action(client, secret, method, args):
    return client.post("/api/mcp/v2/client/action", headers={"X-MVHub-MCP": "1", "X-MVHub-MCP-Secret": secret},
                       json={"method": method, "args": args})


def plan_args():
    return {"title": "고양이", "context_id": None, "workspace_scope": "personal",
            "items": [{"label": "one", "prompt": "고양이", "model": "test_model", "params": {"seed": 1}}]}


def wait_status(client, headers, turn_id, wanted, timeout=30):
    deadline, after = time.monotonic() + timeout, 0
    while time.monotonic() < deadline:
        body = client.get(f"/api/agent-chat/turns/{turn_id}/events?after={after}", headers=headers).json()
        after = body["last_seq"]
        if body["status"] in wanted:
            return body
    raise AssertionError("turn did not reach " + str(wanted))


def test_guards_header_origin_secret_and_account(hub):
    client, _, _ = hub
    assert client.post("/api/agent-chat/session").status_code == 400
    wrong = client.post("/api/agent-chat/session", headers={"X-MVHub-Expect-Account": "acct:other@example.test"})
    assert wrong.status_code == 409 and wrong.headers["X-MVHub-Panel-Error"] == "account"
    assert client.post("/api/agent-chat/session", headers={**HEADERS, "Origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/agent-chat/session", headers={**HEADERS, "Host": "evil.example"}).status_code == 403
    gone = client.get("/api/agent-chat/conversations", headers={**HEADERS, "X-MVHub-Panel": "x" * 43})
    assert gone.status_code == 401
    assert gone.headers["X-MVHub-Panel-Error"] == "session" and gone.headers["X-MVHub-Auth-State"] == "preserved"
    headers = panel_headers(client)
    assert client.get("/api/agent-chat/conversations", headers=headers).json() == {"conversations": []}
    assert client.get("/api/agent-chat/conversations", headers={**headers, "Origin": "http://evil.example"}).status_code == 403


@windows
def test_turn_plan_card_and_human_execute_once(hub, monkeypatch):
    client, profiles, _ = hub
    headers = panel_headers(client)
    turn = start_turn(client, headers)
    assert turn.status_code == 200, turn.text
    body = turn.json()
    secret = profiles[-1]["secret"]
    panel_client = mcp_store.client_by_id(profiles[-1]["client_id"])
    assert panel_client["name"] == "agent_panel" and panel_client["can_execute"] == 0
    # 진행 중에 다른 열쇠로 또 보내면 409 (같은 열쇠는 다른 시험)
    busy = start_turn(client, headers)
    assert busy.status_code == 409
    # 어댑터 역할: 칸 연결로 계획 → 칸에 카드
    plan = adapter_action(client, secret, "prepare_generation_plan", plan_args())
    assert plan.status_code == 200, plan.text
    plan_id = plan.json()["plan_id"]
    events = client.get(f"/api/agent-chat/turns/{body['turn_id']}/events?after=0", headers=headers).json()["events"]
    assert [event["plan"]["plan_id"] for event in events if event["kind"] == "plan"] == [plan_id]
    # 칸 연결은 실행·캔버스 도구를 못 쓴다
    denied = adapter_action(client, secret, "execute_generation_plan", {"plan_id": plan_id})
    assert denied.status_code == 403
    assert adapter_action(client, secret, "add_to_canvas", {"plan_id": plan_id, "scene_id": "s"}).status_code == 403
    # 사람의 [실행] — 한 번만 제출된다
    calls = []

    async def submit(request_body, request):
        calls.append(request_body)
        return {"id": "generation-1"}

    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    for _ in range(2):
        executed = client.post(f"/api/agent-chat/plans/{plan_id}/execute", headers=headers)
        assert executed.status_code == 200, executed.text
        assert executed.json()["status"] == "submitted"
    assert len(calls) == 1
    assert client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers).json()["status"] in ("cancelling", "cancelled")
    assert wait_status(client, headers, body["turn_id"], ("cancelled",))["status"] == "cancelled"
    # 계획을 만들 진행 중 차례가 없으면 칸에 올리지 않는다
    orphan = adapter_action(client, secret, "prepare_generation_plan", plan_args())
    assert orphan.status_code == 409


@windows
def test_idempotent_resend_and_foreign_plan_rejected(hub):
    client, profiles, _ = hub
    headers = panel_headers(client)
    key = uuid4().hex
    first = start_turn(client, headers, idempotency_key=key).json()
    second = start_turn(client, headers, idempotency_key=key)
    assert second.status_code == 200 and second.json()["turn_id"] == first["turn_id"]
    assert len(profiles) == 1  # 다시 보내도 연결을 또 발급하지 않는다
    assert client.post(f"/api/agent-chat/plans/{uuid4()}/execute", headers=headers).status_code == 404
    listing = client.get("/api/agent-chat/conversations", headers=headers).json()["conversations"]
    assert [row["id"] for row in listing] == [first["conversation_id"]]
    detail = client.get(f"/api/agent-chat/conversations/{first['conversation_id']}", headers=headers).json()
    assert detail["turns"][0]["text"] == "고양이 한 장 계획해 줘" and "mcp_entry" not in detail["conversation"]
    wrong_engine = start_turn(client, headers, conversation_id=first["conversation_id"], engine="codex", model="gpt-6-astra")
    assert wrong_engine.status_code == 409
    client.post(f"/api/agent-chat/turns/{first['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, first["turn_id"], ("cancelled",))


def test_enabled_only_on_local_hub_and_feature_flag(monkeypatch):
    monkeypatch.setattr(auth_router.repo, "count_accounts", lambda: 1)  # 기본 DB 를 열지 않게
    monkeypatch.setattr(config, "AGENT_CHAT_ENABLED", False)
    assert not chat.enabled()
    assert "agent_chat_v1" not in auth_router.auth_config()["features"]
    monkeypatch.setattr(config, "AGENT_CHAT_ENABLED", True)
    monkeypatch.setattr(chat, "is_shared_team_server", lambda: True)
    assert not chat.enabled()
    monkeypatch.setattr(chat, "is_shared_team_server", lambda: False)
    assert chat.enabled() and "agent_chat_v1" in auth_router.auth_config()["features"]


def test_panel_routes_never_forward_to_shared_server():
    assert _proxy.is_local_path("/api/agent-chat/session")
    assert _proxy.is_local_path("/api/agent-chat/plans/x/execute")


def test_panel_client_can_never_execute(hub):
    secret_hash = "h" * 64
    cid = mcp_store.create_client(secret_hash, "a" * 32, "me", EMAIL, None, {"scope": "account"}, "agent_panel", True)
    assert mcp_store.client_by_id(cid)["can_execute"] == 0
