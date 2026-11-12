"""Ask Agent 칸 HTTP — 격리 DB·가짜 CLI·가짜 제출. 실제 Claude·Codex·생성·공유 서버 없음."""
import asyncio
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
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
    monkeypatch.setattr(config, "AGENT_CHAT_CLAUDE_DIR", tmp_path / "claude")
    monkeypatch.setattr(process, "engine_prefix", lambda engine: [sys.executable, str(FAKE), f"--fake-engine={engine}"])
    monkeypatch.setattr(process, "cli_version", lambda prefix: "2.1.296" if "--fake-engine=claude" in prefix else "0.162.0-alpha.17.2")
    monkeypatch.setattr(process, "CODEX_LOCK", None)  # Codex 경로도 시험한다(실사용 기본은 잠금 — 따로 시험)
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
    assert len(body["identity_key"]) == 32  # 화면이 표를 다시 받을 때 계정·허브·DB 를 함께 비교하는 표식
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
    assert client.get("/api/agent-chat/conversations", headers=headers).json() == {"conversations": [], "truncated": False}
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
    # 칸 연결은 그림을 CLI 로 보내는 조회 도구를 못 쓴다(실행·기다림·캔버스는 요리 2-A 에서 열림 — 아래 다른 시험)
    for method, args in (("get_result", {"plan_id": plan_id, "item_index": 0}),
                         ("show_results", {"plan_id": plan_id, "item_indexes": [0]}),
                         ("get_generation", {"generation_id": "g", "workspace_scope": "personal"})):
        assert adapter_action(client, secret, method, args).status_code == 403, method
    # 사람의 [실행] — 한 번만 제출된다
    calls = []

    async def submit(request_body, request):
        calls.append(request_body)
        return {"id": "generation-1"}

    async def estimate_cost(model, params, prompt, timeout):
        return {"credits": 3}

    async def no_submit(request_body, request):
        raise AssertionError("견적이 제출 경로를 불렀다")

    monkeypatch.setattr(api.cli_bridge, "estimate_cost", estimate_cost)
    monkeypatch.setattr(gen_requests, "create_gen_request", no_submit)  # 견적 동안 제출 경로를 지킨다
    estimated = client.post(f"/api/agent-chat/plans/{plan_id}/estimate", headers=headers)
    assert estimated.status_code == 200 and estimated.json()["total_credits"] == 3  # 카드의 견적(무료 조회)
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["can_execute"] == 0
    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    for _ in range(2):
        executed = client.post(f"/api/agent-chat/plans/{plan_id}/execute", headers=headers)
        assert executed.status_code == 200, executed.text
        assert executed.json()["status"] == "submitted"
        # 사람 [실행] 응답에도 진행 사건과 같은 규칙의 스냅샷(가짜 생성 id 라 생성 상태는 결과 없음)
        snap = executed.json()["snapshot"]
        assert snap["plan_id"] == plan_id and snap["observed_at"].isdigit()
        assert snap["items"] == [{"index": 0, "state": "submitted", "generation_id": "generation-1", "generation_status": "missing"}]
    assert len(calls) == 1
    assert client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers).json()["status"] in ("cancelling", "cancelled")
    assert wait_status(client, headers, body["turn_id"], ("cancelled",))["status"] == "cancelled"
    # 계획을 만들 진행 중 차례가 없으면 칸에 올리지 않는다
    orphan = adapter_action(client, secret, "prepare_generation_plan", plan_args())
    assert orphan.status_code == 409
    # 대화 복원 = 사건 + 계획의 지금 저장 상태(차례가 끝난 뒤 사람 [실행] 결과도 보인다)
    detail = client.get(f"/api/agent-chat/conversations/{body['conversation_id']}", headers=headers)
    assert detail.status_code == 200, detail.text
    assert [(p["plan_id"], p["items"][0]["state"]) for p in detail.json()["plans"]] == [(plan_id, "submitted")]


def _submits(monkeypatch):
    calls = []

    async def submit(request_body, request):
        calls.append(request_body)
        return {"id": f"generation-{len(calls)}"}

    monkeypatch.setattr(gen_requests, "create_gen_request", submit)
    return calls


def _progress(client, headers, turn_id):
    events = client.get(f"/api/agent-chat/turns/{turn_id}/events?after=0", headers=headers).json()["events"]
    return [event for event in events if event["kind"] == "plan_progress"]


@windows
def test_agent_executes_this_conversations_plan_while_turn_runs(hub, monkeypatch):
    """요리 2-A: 사용자가 생성하라고 한 차례 안에서 AI 가 이 대화의 계획을 실행 — 제출 1회·진행 스냅샷·사람과 겹쳐도 1회."""
    client, profiles, service = hub
    headers = panel_headers(client)
    body = start_turn(client, headers, text="고양이 한 장 생성해").json()
    secret = profiles[-1]["secret"]
    calls = _submits(monkeypatch)
    plan_id = adapter_action(client, secret, "prepare_generation_plan", plan_args()).json()["plan_id"]
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["can_execute"] == 0  # 일반 실행권은 그대로 꺼짐
    ran = adapter_action(client, secret, "execute_generation_plan", {"plan_id": plan_id})
    assert ran.status_code == 200, ran.text
    assert ran.json()["status"] == "submitted" and len(calls) == 1
    first = _progress(client, headers, body["turn_id"])
    assert len(first) == 1 and first[0]["plan_id"] == plan_id and first[0]["plan_status"] == "submitted"
    assert first[0]["items"][0]["state"] == "submitted" and first[0]["items"][0]["generation_id"] == "generation-1"
    assert "title" not in first[0] and "prompt" not in first[0]["items"][0]  # 카드(plan 사건)와 따로 — 상태만
    # 이미 보낸 계획에 사람 [실행]·AI 재실행이 와도 제출은 한 번(동시에 선점하러 만나는 경우는 아래 race 시험)
    assert client.post(f"/api/agent-chat/plans/{plan_id}/execute", headers=headers).status_code == 200
    assert adapter_action(client, secret, "execute_generation_plan", {"plan_id": plan_id}).status_code == 200
    assert len(calls) == 1
    # 기다림도 스냅샷을 남기고 순서 번호는 늘어난다 · 캔버스 도구는 칸에서 허용(없는 씬이라 404)
    waited = adapter_action(client, secret, "wait_results", {"plan_id": plan_id, "item_indexes": [0], "wait_seconds": 0})
    assert waited.status_code == 200, waited.text
    stamps = [int(event["observed_at"]) for event in _progress(client, headers, body["turn_id"])]
    assert len(stamps) == 3 and stamps == sorted(stamps) and len(set(stamps)) == 3
    assert adapter_action(client, secret, "add_to_canvas", {"plan_id": plan_id, "scene_id": "s"}).status_code == 404
    # 이 대화의 칸 연결로 만든 계획이 아니면 404 — 바인딩 없음 / 다른 연결의 바인딩
    other = adapter_action(client, secret, "prepare_generation_plan", plan_args()).json()["plan_id"]
    runtime = service._runtimes[body["turn_id"]]
    with chat_store.connect(runtime.path) as conn:
        conn.execute("UPDATE agent_chat_plan_binding SET client_id='someone-else' WHERE plan_id=?", (other,))
    assert adapter_action(client, secret, "execute_generation_plan", {"plan_id": other}).status_code == 404
    with chat_store.connect(runtime.path) as conn:
        conn.execute("DELETE FROM agent_chat_plan_binding WHERE plan_id=?", (other,))
    assert adapter_action(client, secret, "execute_generation_plan", {"plan_id": other}).status_code == 404
    # [그만] 뒤(차례 없음 — 허브 재시작 뒤 남은 바인딩과 같은 길) 실행 전 계획은 409·제출 0
    late = adapter_action(client, secret, "prepare_generation_plan", plan_args()).json()["plan_id"]
    client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, body["turn_id"], ("cancelled",))
    assert adapter_action(client, secret, "execute_generation_plan", {"plan_id": late}).status_code == 409
    assert len(calls) == 1
    assert len(_progress(client, headers, body["turn_id"])) == 3  # 끝난 차례엔 사건을 더하지 않는다


@windows
def test_human_and_agent_execute_race_on_claim_submits_once(hub, monkeypatch):
    """사람 [실행]과 AI 실행이 같은 planned 계획을 동시에 — 둘 다 선점 직전 장벽에서 만난 뒤 원자 선점, 제출은 한 번(독립 리뷰 P1)."""
    client, profiles, _ = hub
    headers = panel_headers(client)
    body = start_turn(client, headers, text="고양이 한 장 생성해").json()
    secret = profiles[-1]["secret"]
    calls = _submits(monkeypatch)
    plan_id = adapter_action(client, secret, "prepare_generation_plan", plan_args()).json()["plan_id"]
    real_claim, meet, won = mcp_store.claim_plan, threading.Barrier(2, timeout=10), []

    def claim(*args, **kwargs):
        meet.wait()  # 두 요청 모두 planned 를 읽고 선점 직전까지 왔다(한쪽이 안 오면 장벽이 깨져 시험 실패)
        result = real_claim(*args, **kwargs)
        won.append(result)
        return result

    monkeypatch.setattr(api.store, "claim_plan", claim)
    results = {}
    threads = [
        threading.Thread(target=lambda: results.setdefault(
            "human", client.post(f"/api/agent-chat/plans/{plan_id}/execute", headers=headers))),
        threading.Thread(target=lambda: results.setdefault(
            "agent", adapter_action(client, secret, "execute_generation_plan", {"plan_id": plan_id}))),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert sorted(won) == [False, True]  # 둘 다 선점했고 하나만 이겼다
    assert results["human"].status_code == 200, results["human"].text
    assert results["agent"].status_code == 200, results["agent"].text
    assert len(calls) == 1
    client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, body["turn_id"], ("cancelled",))


@windows
def test_panel_connection_reports_its_execute_rule_not_the_general_flag(hub):
    """칸 연결은 connect·read_context(workspace)에 can_execute true + 칸 실행 규칙 — DB 일반 실행권은 0 그대로(화면 읽기 설계 3-3).
    false 를 그대로 보이면 AI 가 '실행 권한이 없다'고 말했다(11-10 실사용)."""
    client, profiles, _ = hub
    headers = panel_headers(client)
    body = start_turn(client, headers).json()
    secret = profiles[-1]["secret"]
    connected = client.post("/api/mcp/v2/client/connect", headers={"X-MVHub-MCP": "1", "X-MVHub-MCP-Secret": secret}, json={})
    seen = adapter_action(client, secret, "read_context", {"kind": "workspace", "workspace_scope": "personal"})
    for response in (connected, seen):
        assert response.status_code == 200, response.text
        assert response.json()["can_execute"] is True and "이 대화에서 생성하라고" in response.json()["execute_rule"]
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["can_execute"] == 0
    client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, body["turn_id"], ("cancelled",))


def test_restore_budget_covers_binding_and_client_lookups(monkeypatch):
    """대화 복원 예산은 바인딩·연결 조회까지 한 마감 — 늦은 조회에도 예산 안에 끝나고 그때까지 읽은 것만(독립 리뷰 P2)."""
    monkeypatch.setattr(router, "_RESTORE_SECONDS", 0.2)
    identity, ctx = SimpleNamespace(db_file=lambda: "x.db"), SimpleNamespace(client=None)

    async def timed():
        started = time.monotonic()
        result = await router._plan_snapshots(ctx, identity, "c1")
        return result, time.monotonic() - started

    monkeypatch.setattr(router.chat_store, "bindings_for_conversation", lambda path, cid: time.sleep(1) or [])
    result, took = asyncio.run(timed())
    assert result == [] and took < 0.8  # 바인딩 조회가 늦어도 예산에서 끊는다

    async def snap(ctx, plan_id, turn):
        return {"plan_id": plan_id}

    monkeypatch.setattr(router.chat_store, "bindings_for_conversation",
                        lambda path, cid: [{"plan_id": "p1", "client_id": "a"}, {"plan_id": "p2", "client_id": "b"}])
    monkeypatch.setattr(router, "_panel_client", lambda ctx, identity, cid: time.sleep(1) if cid == "b" else {"id": cid})
    monkeypatch.setattr(router.mcp_v2, "panel_snapshot", snap)
    monkeypatch.setattr(router.service, "turn_for_client", lambda cid: None)
    result, took = asyncio.run(timed())
    assert result == [{"plan_id": "p1"}] and took < 0.8  # 둘째 연결 조회가 늦으면 첫 계획만


@windows
def test_agent_execute_survives_snapshot_failure(hub, monkeypatch):
    """제출 뒤 표시용 스냅샷이 실패해도 실행 응답은 제출 결과 그대로 · 사건 없음."""
    client, profiles, _ = hub
    headers = panel_headers(client)
    body = start_turn(client, headers, text="생성해").json()
    secret = profiles[-1]["secret"]
    calls = _submits(monkeypatch)
    plan_id = adapter_action(client, secret, "prepare_generation_plan", plan_args()).json()["plan_id"]

    async def broken(ctx, plan_id):
        raise RuntimeError("team space lookup failed")

    monkeypatch.setattr(api, "plan_snapshot", broken)
    ran = adapter_action(client, secret, "execute_generation_plan", {"plan_id": plan_id})
    assert ran.status_code == 200 and ran.json()["status"] == "submitted" and len(calls) == 1
    assert _progress(client, headers, body["turn_id"]) == []
    human = client.post(f"/api/agent-chat/plans/{plan_id}/execute", headers=headers)
    assert human.status_code == 200 and "snapshot" not in human.json()
    client.post(f"/api/agent-chat/turns/{body['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, body["turn_id"], ("cancelled",))


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


@windows
def test_cancel_during_start_waits_for_runtime(hub, monkeypatch):
    """선점과 실행 등록 사이에 온 취소 — 실행 정보 없이 '끝남'으로 바꾸고 CLI 가 뒤늦게 뜨던 것(리뷰 2차 P1)."""
    client, _, _ = hub
    headers = panel_headers(client)
    real_claim, claimed = chat_store.claim_turn, {}
    ready = threading.Event()

    def slow_claim(path, **kwargs):
        turn, created = real_claim(path, **kwargs)
        claimed["id"] = turn["id"]
        ready.set()
        time.sleep(0.8)  # 워커 스레드에서 — 이 사이에 취소가 들어온다
        return turn, created

    monkeypatch.setattr(chat_store, "claim_turn", slow_claim)
    result = {}
    starter = threading.Thread(target=lambda: result.setdefault("start", start_turn(client, headers)))
    starter.start()
    assert ready.wait(10)
    cancelled = client.post(f"/api/agent-chat/turns/{claimed['id']}/cancel", headers=headers).json()
    starter.join(20)
    assert result["start"].status_code == 200
    assert cancelled["status"] == "cancelling"  # 실행 정보를 찾아 끈다(전에는 'cancelled' — 실행 없이 끝남 처리)
    assert wait_status(client, headers, claimed["id"], ("cancelled",))["status"] == "cancelled"


@windows
def test_same_key_at_once_returns_one_turn_and_one_conversation(hub, monkeypatch):
    client, profiles, _ = hub
    headers = panel_headers(client)
    real_setup = mcp_router.setup

    async def slow_setup(request, identity=None):
        await asyncio.sleep(0.5)  # 두 요청이 같이 앞 확인을 지나가게
        return await real_setup(request, identity)

    monkeypatch.setattr(mcp_router, "setup", slow_setup)
    key, results = uuid4().hex, []
    threads = [threading.Thread(target=lambda: results.append(start_turn(client, headers, idempotency_key=key))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(20)
    bodies = [r.json() for r in results]
    assert [r.status_code for r in results] == [200, 200]
    assert bodies[0]["turn_id"] == bodies[1]["turn_id"] and bodies[0]["conversation_id"] == bodies[1]["conversation_id"]
    assert len(profiles) == 1
    assert len(client.get("/api/agent-chat/conversations", headers=headers).json()["conversations"]) == 1
    client.post(f"/api/agent-chat/turns/{bodies[0]['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, bodies[0]["turn_id"], ("cancelled",))


def test_api_key_login_locks_engine(hub, monkeypatch):
    """구독 로그인이 아니면(API 키) 엔진을 잠근다 — 실행 전 상태 확인(비밀값 없이)."""
    client, _, _ = hub
    monkeypatch.setenv("FAKE_AGENT_AUTH", "api_key")
    body = client.post("/api/agent-chat/session", headers=HEADERS).json()
    assert {e["id"]: e["available"] for e in body["engines"]} == {"claude": False, "codex": False}
    assert all("구독 로그인이 아" in e["reason"] for e in body["engines"])
    turn = start_turn(client, {**HEADERS, "X-MVHub-Panel": body["secret"]})
    assert turn.status_code == 409 and "구독 로그인이 아" in turn.json()["detail"]


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


@windows
def test_claude_status_login_switch_and_turn_refusal(hub, monkeypatch):
    """GET /claude(새 상태·스위치·누출 없음) · 스위치 꺼짐 = 터미널 안내 · 켜면 로그인 창 하나 · 창이 열려 있으면 차례 409."""
    from app.services import agent_chat_claude as claude
    client, _, _ = hub
    headers = panel_headers(client)
    monkeypatch.setenv("FAKE_AGENT_AUTH", "leak")
    status = client.get("/api/agent-chat/claude", headers=headers)
    assert status.status_code == 200, status.text
    body = status.json()
    assert (body["state"], body["subscription"], body["login_window"], body["login_window_enabled"]) == ("ready", "Max", False, False)
    assert "secret@example.test" not in status.text and "org-SECRET" not in status.text and "SECRET" not in status.text
    monkeypatch.setenv("FAKE_AGENT_AUTH", "none")
    off = client.post("/api/agent-chat/claude/login", headers=headers)
    assert off.status_code == 409 and off.headers["X-MVHub-Claude-Error"] == "login_window_disabled"
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", True)
    windows_opened = []

    def spawn(command):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        windows_opened.append(proc)
        return proc

    monkeypatch.setattr(claude, "_spawn_window", spawn)
    monkeypatch.setattr(claude, "_resume", lambda proc: None)
    try:
        opened = client.post("/api/agent-chat/claude/login", headers=headers)
        assert opened.status_code == 200 and opened.json() == {"opened": True}
        again = client.post("/api/agent-chat/claude/login", headers=headers)
        assert again.status_code == 409 and again.headers["X-MVHub-Claude-Error"] == "login_window_open"
        assert client.get("/api/agent-chat/claude", headers=headers).json()["state"] == "login_window"
        turn = start_turn(client, headers)
        assert turn.status_code == 409 and "로그인 창" in turn.json()["detail"]
    finally:
        for proc in windows_opened:
            proc.kill()
            proc.wait(10)
        claude._held_windows.clear()
    assert len(windows_opened) == 1


def test_turn_validates_fast_mode_and_effort(hub):
    client, _, _ = hub
    headers = panel_headers(client)
    assert start_turn(client, headers, fast=True).status_code == 422  # haiku 는 빠른 모드 없음
    assert start_turn(client, headers, engine="codex", model="gpt-6-astra", effort="xhigh").status_code == 422
    assert start_turn(client, headers, effort="ultra").status_code == 422
