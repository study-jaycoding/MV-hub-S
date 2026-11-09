"""Ask Agent 칸 기록·실행기·차례 — 가짜 CLI(agent_chat_fake_cli.py)로만. 진짜 Claude·Codex·과금 없음."""
import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import pytest

from app import config
from app.repo import agent_chat as store
from app.services import agent_chat as chat
from app.services import agent_chat_process as process
from app.services.agent_chat_parse import CLAUDE_ALLOWED

FAKE = Path(__file__).with_name("agent_chat_fake_cli.py")
windows = pytest.mark.skipif(os.name != "nt", reason="Windows Job Object")


def alive(pid):
    import ctypes
    k32 = ctypes.WinDLL("kernel32")
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    code = ctypes.c_ulong()
    k32.GetExitCodeProcess(handle, ctypes.byref(code))
    k32.CloseHandle(handle)
    return code.value == 259


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    monkeypatch.setattr(process, "engine_prefix", lambda engine: [sys.executable, str(FAKE)])
    monkeypatch.setenv("FAKE_AGENT_PIDFILE", str(tmp_path / "grandchild.pid"))
    service = chat.AgentChat()
    identity = chat.Identity("a" * 32, str(tmp_path / "hub.db"), "jay@example.test")
    yield service, identity, tmp_path
    service.shutdown()


def start(service, identity, monkeypatch, scenario, *, engine="claude", conv=None, still=lambda: None, text="고양이 그려 줘"):
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", scenario)
    path = identity.db_file()
    conv = conv or store.create_conversation(path, engine=engine, model="haiku", effort="low", client_id="client-1",
                                             mcp_entry={"command": sys.executable, "args": ["adapter.py", "--panel"]}, title="t")
    turn, created = store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text=text, context={"tab": "my"})
    assert created
    service.start_turn(identity, conversation=conv, turn=turn, model="haiku" if engine == "claude" else "gpt-6-astra",
                       effort="low", text=text, context={"tab": "my"}, still_current=still)
    return path, conv, turn


def finish(path, turn_id, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        turn = store.get_turn(path, turn_id)
        if turn["status"] in chat.TERMINAL:
            return turn
        time.sleep(0.1)
    raise AssertionError(f"turn did not finish: {store.get_turn(path, turn_id)}")


def wait_file(path, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists() and path.read_text(encoding="utf-8").strip():
            return int(path.read_text(encoding="utf-8"))
        time.sleep(0.1)
    raise AssertionError("grandchild pid not written")


# ── 기록 ──
def test_store_claim_is_idempotent_single_active_and_recovers(tmp_path):
    path = store.open_db(tmp_path / "x.db")
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="c", mcp_entry={}, title="t")
    first, created = store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-0001", text="a", context={})
    again, created_again = store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-0001", text="a", context={})
    assert created and not created_again and again["id"] == first["id"]
    with pytest.raises(store.Busy):
        store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-0002", text="b", context={})
    assert store.set_status(path, first["id"], "cancelling", only_from=("running",))
    assert not store.set_status(path, first["id"], "cancelling", only_from=("running",))
    store._opened.discard(str(path).casefold())  # 다음 프로세스가 처음 여는 것처럼
    store.open_db(path)
    assert store.get_turn(path, first["id"])["status"] == "interrupted"
    store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-0003", text="c", context={})


def test_store_events_order_and_binding_needs_matching_client(tmp_path):
    path = store.open_db(tmp_path / "y.db")
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="c1", mcp_entry={}, title="t")
    turn, _ = store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-1000", text="a", context={})
    assert [store.append_event(path, turn["id"], "text", {"text": str(i)}) for i in range(3)] == [1, 2, 3]
    assert [event["text"] for event in store.events_after(path, turn["id"], 1)] == ["1", "2"]
    store.bind_plan(path, plan_id="p-good", turn_id=turn["id"], client_id="c1")
    store.bind_plan(path, plan_id="p-forged", turn_id=turn["id"], client_id="other-client")
    assert store.binding_for(path, "p-good")["conversation_id"] == conv["id"]
    assert store.binding_for(path, "p-forged") is None
    assert store.binding_for(path, "p-missing") is None


# ── 명령·환경 ──
def test_child_env_strips_paid_and_nested_markers():
    env = process.child_env({"ANTHROPIC_API_KEY": "k", "anthropic_base_url": "u", "OPENAI_API_KEY": "k", "CLAUDE_CODE_USE_BEDROCK": "1",
                             "CLAUDECODE": "1", "ELECTRON_RUN_AS_NODE": "1", "PATH": "p"})
    assert env == {"PATH": "p"}


def test_claude_command_keeps_isolation_flags(tmp_path):
    mcp_file = tmp_path / "m.json"
    entry = {"command": "py.exe", "args": ["server.py", "--panel"]}
    command = process.build_command("claude", ["claude.exe"], model="haiku", effort="low", resume="S1", mcp_entry=entry,
                                    mcp_file=mcp_file, work=tmp_path)
    index = command.index("--tools")
    assert command[index + 1] == ""  # 빈 인자 — 기본 도구 0
    assert command[command.index("--setting-sources") + 1] == "local"
    assert "--strict-mcp-config" in command and command[command.index("--permission-mode") + 1] == "dontAsk"
    assert command[command.index("--allowedTools") + 1] == ",".join(sorted(CLAUDE_ALLOWED))
    assert command[-2:] == ["--resume", "S1"]
    assert json.loads(mcp_file.read_text(encoding="utf-8")) == {"mcpServers": {"mvhub_panel": entry}}


def test_codex_command_disables_features_and_rejects_bad_path(tmp_path):
    entry = {"command": r"C:\py\python.exe", "args": [r"C:\a b\server.py", "--panel"]}
    command = process.build_command("codex", ["node", "codex.js"], model="gpt-6-astra", effort="low", resume=None,
                                    mcp_entry=entry, mcp_file=tmp_path / "m.json", work=tmp_path)
    for feature in process.CODEX_FEATURES_OFF:
        assert ["--disable", feature] == command[command.index(feature) - 1: command.index(feature) + 1]
    assert "--ignore-user-config" in command and "--ignore-rules" in command
    assert 'mcp_servers.mvhub_panel.default_tools_approval_mode="approve"' in command
    assert command[-3:] == ["-C", str(tmp_path), "-"]
    resumed = process.build_command("codex", ["node", "codex.js"], model="gpt-6-astra", effort="low", resume="T1",
                                    mcp_entry=entry, mcp_file=tmp_path / "m.json", work=tmp_path)
    assert resumed[-3:] == ["resume", "T1", "-"] and "--disable" in resumed
    with pytest.raises(ValueError):
        process.build_command("codex", ["node"], model="m", effort="low", resume=None,
                              mcp_entry={"command": "C:\\it's\\py.exe", "args": []}, mcp_file=tmp_path / "m.json", work=tmp_path)


# ── 차례 ──
@windows
def test_claude_turn_streams_and_passes_korean_stdin(runtime, monkeypatch):
    service, identity, _ = runtime
    path, conv, turn = start(service, identity, monkeypatch, "claude_ok")
    assert finish(path, turn["id"])["status"] == "done"
    events = store.events_after(path, turn["id"])
    kinds = [event["kind"] for event in events]
    assert kinds[:2] == ["text_delta", "text_delta"] and "tool" in kinds and kinds[-1] == "state"
    assert any(event["kind"] == "text" and event["text"].endswith("고양이 그려 줘") for event in events)
    assert store.get_conversation(path, conv["id"])["cli_session_id"] == "S-claude-1"


@windows
def test_codex_turn(runtime, monkeypatch):
    service, identity, _ = runtime
    path, conv, turn = start(service, identity, monkeypatch, "codex_ok", engine="codex")
    assert finish(path, turn["id"])["status"] == "done"
    tools = [event for event in store.events_after(path, turn["id"]) if event["kind"] == "tool"]
    assert [(tool["name"], tool["status"]) for tool in tools] == [("read_context", "started"), ("read_context", "done")]
    assert store.get_conversation(path, conv["id"])["cli_session_id"] == "T-codex-1"


@windows
def test_extra_tool_stops_turn_before_any_text(runtime, monkeypatch):
    service, identity, _ = runtime
    started = time.monotonic()
    path, _, turn = start(service, identity, monkeypatch, "claude_violation")
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "tool_violation"
    assert time.monotonic() - started < 20  # 30초 잠든 가짜를 기다리지 않고 끈다
    assert "text" not in [event["kind"] for event in store.events_after(path, turn["id"])]


@windows
def test_cancel_reaps_whole_tree_and_blocks_until_reaped(runtime, monkeypatch):
    service, identity, tmp = runtime
    path, conv, turn = start(service, identity, monkeypatch, "claude_slow")
    grandchild = wait_file(tmp / "grandchild.pid")
    assert alive(grandchild)
    with pytest.raises(store.Busy):
        store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-busy-1", text="x", context={})
    assert service.cancel(identity, turn["id"]) in ("cancelling", "cancelled")
    assert finish(path, turn["id"])["status"] == "cancelled"
    assert not alive(grandchild)


@windows
def test_timeout_and_shutdown_reap(runtime, monkeypatch):
    service, identity, tmp = runtime
    monkeypatch.setattr(chat, "TURN_TIMEOUT", 3.0)
    path, _, turn = start(service, identity, monkeypatch, "claude_slow")
    grandchild = wait_file(tmp / "grandchild.pid")
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "timeout"
    assert not alive(grandchild)


@windows
def test_identity_change_interrupts_turn(runtime, monkeypatch):
    service, identity, _ = runtime
    def changed():
        raise RuntimeError("account switched")
    path, _, turn = start(service, identity, monkeypatch, "claude_ok", still=changed)
    done = finish(path, turn["id"])
    assert done["status"] == "interrupted" and done["reason"] == "account_changed"
    assert "text" not in [event["kind"] for event in store.events_after(path, turn["id"])]


@windows
def test_plan_binds_only_while_turn_runs(runtime, monkeypatch):
    service, identity, tmp = runtime
    path, conv, turn = start(service, identity, monkeypatch, "claude_slow")
    wait_file(tmp / "grandchild.pid")
    plan = {"plan_id": "plan-1", "title": "고양이", "status": "planned", "workspace": {"scope": "personal"},
            "items": [{"model": "nano", "prompt": "고양이 " * 200}]}
    assert service.bind_plan("client-1", plan)
    assert not service.bind_plan("someone-else", plan)
    assert store.binding_for(path, "plan-1")["turn_id"] == turn["id"]
    card = [event for event in store.events_after(path, turn["id"]) if event["kind"] == "plan"][0]["plan"]
    assert card["plan_id"] == "plan-1" and len(card["items"][0]["prompt"]) == 400
    service.cancel(identity, turn["id"])
    finish(path, turn["id"])
    assert not service.bind_plan("client-1", {**plan, "plan_id": "plan-2"})


@windows
def test_failed_resume_marks_conversation_not_resumable(runtime, monkeypatch):
    service, identity, _ = runtime
    path = identity.db_file()
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="client-1",
                                     mcp_entry={"command": sys.executable, "args": []}, title="t")
    store.update_conversation(path, conv["id"], cli_session_id="expired-session")
    conv = store.get_conversation(path, conv["id"])
    _, _, turn = start(service, identity, monkeypatch, "silent", conv=conv)
    assert finish(path, turn["id"])["status"] == "failed"
    assert store.get_conversation(path, conv["id"])["resumable"] is False


def test_long_poll_wakes_on_new_event_and_times_out(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    service = chat.AgentChat()
    identity = chat.Identity("b" * 32, str(tmp_path / "hub.db"), "jay@example.test")
    path = identity.db_file()
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="c", mcp_entry={}, title="t")
    turn, _ = store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-poll-1", text="a", context={})

    def later():
        time.sleep(0.5)
        store.append_event(path, turn["id"], "text", {"text": "도착"})
        service._notify(turn["id"])

    threading.Thread(target=later, daemon=True).start()
    started = time.monotonic()
    result = asyncio.run(service.wait_events(identity, turn["id"], 0, timeout=10))
    assert [event["text"] for event in result["events"]] == ["도착"] and time.monotonic() - started < 5
    empty = asyncio.run(service.wait_events(identity, turn["id"], result["last_seq"], timeout=0.3))
    assert empty["events"] == [] and empty["status"] == "running" and empty["last_seq"] == result["last_seq"]
    missing = asyncio.run(service.wait_events(identity, str(uuid4()), 0, timeout=0.1))
    assert missing["status"] == "missing"
