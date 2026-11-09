"""Ask Agent 칸 기록·실행기·차례 — 가짜 CLI(agent_chat_fake_cli.py)로만. 진짜 Claude·Codex·과금 없음."""
import asyncio
import json
import os
import subprocess
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
    monkeypatch.setattr(process, "engine_prefix", lambda engine: [sys.executable, str(FAKE), f"--fake-engine={engine}"])
    monkeypatch.setattr(process, "CODEX_LOCK", None)  # Codex 경로도 시험한다(실사용 기본은 잠금 — 따로 시험)
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
    assert kinds[0] == "text_delta" and events[0]["text"] == "받은 말: "  # 글 조각은 모아서 한 사건으로
    assert "tool" in kinds and kinds[-1] == "state" and "reason" not in events[-1]
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
            "items": [{"model": "nano", "prompt": "고양이 " * 600}]}
    assert service.bind_plan("client-1", plan)
    assert not service.bind_plan("someone-else", plan)
    assert store.binding_for(path, "plan-1")["turn_id"] == turn["id"]
    card = [event for event in store.events_after(path, turn["id"]) if event["kind"] == "plan"][0]["plan"]
    assert card["plan_id"] == "plan-1" and len(card["items"][0]["prompt"]) == 2000
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


@windows
def test_unverified_codex_version_is_refused_even_when_resuming(runtime, monkeypatch):
    service, identity, _ = runtime
    monkeypatch.setenv("FAKE_AGENT_VERSION", "0.170.0")
    assert "점검 필요" in service.engine_problem("codex")
    path = identity.db_file()
    conv = store.create_conversation(path, engine="codex", model="gpt-6-astra", effort="low", client_id="client-1",
                                     mcp_entry={"command": sys.executable, "args": []}, title="t")
    store.update_conversation(path, conv["id"], cli_session_id="T-old")
    _, _, turn = start(service, identity, monkeypatch, "codex_ok", engine="codex", conv=store.get_conversation(path, conv["id"]))
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "engine_locked"
    assert "text" not in [event["kind"] for event in store.events_after(path, turn["id"])]


@windows
def test_cancel_while_starting_never_leaves_cli_running(runtime, monkeypatch):
    service, identity, tmp = runtime
    real = process.JobProcess
    started = threading.Event()

    class SlowStart(real):
        def __init__(self, *args, **kwargs):
            started.set()
            time.sleep(1.0)  # 이 사이에 취소가 온다
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(process, "JobProcess", SlowStart)
    path, _, turn = start(service, identity, monkeypatch, "claude_slow")
    assert started.wait(10)
    service.cancel(identity, turn["id"])
    assert finish(path, turn["id"])["status"] == "cancelled"
    pidfile = tmp / "grandchild.pid"
    assert not pidfile.exists() or not alive(int(pidfile.read_text(encoding="utf-8") or 0))


@windows
def test_unreaped_tree_keeps_turn_open_until_reaped(runtime, monkeypatch):
    service, identity, tmp = runtime
    real_reap = process.JobProcess.reap
    attempts = []

    def flaky(self, timeout=15.0):
        attempts.append(1)
        if len(attempts) == 1:
            self.terminate()
            return False  # 첫 회수는 실패한 것처럼
        return real_reap(self, timeout)

    monkeypatch.setattr(process.JobProcess, "reap", flaky)
    monkeypatch.setattr(chat, "_REAP_RETRY_SECONDS", 1.0)
    path, conv, turn = start(service, identity, monkeypatch, "claude_slow")
    wait_file(tmp / "grandchild.pid")
    service.cancel(identity, turn["id"])
    time.sleep(0.4)
    assert store.get_turn(path, turn["id"])["status"] == "cancelling"
    assert service.cancel(identity, turn["id"]) == "cancelling"  # 두 번째 취소도 실행 정보가 있어 '끝남'으로 바꾸지 않는다
    with pytest.raises(store.Busy):
        store.claim_turn(path, conversation_id=conv["id"], idempotency_key="key-busy-2", text="x", context={})
    assert finish(path, turn["id"])["status"] == "cancelled" and len(attempts) >= 2


@windows
def test_account_change_without_output_interrupts(runtime, monkeypatch):
    service, identity, tmp = runtime
    flag = {"lost": False}

    def still():
        if flag["lost"]:
            raise RuntimeError("account switched")

    path, _, turn = start(service, identity, monkeypatch, "claude_slow", still=still)
    grandchild = wait_file(tmp / "grandchild.pid")
    flag["lost"] = True
    done = finish(path, turn["id"], timeout=20)
    assert done["status"] == "interrupted" and done["reason"] == "account_changed"
    assert not alive(grandchild)


@windows
def test_parent_exit_with_orphan_holding_stdout_is_reaped(runtime, monkeypatch):
    service, identity, tmp = runtime
    started = time.monotonic()
    path, _, turn = start(service, identity, monkeypatch, "orphan_stdout")
    done = finish(path, turn["id"], timeout=30)
    assert done["status"] == "done" and time.monotonic() - started < 20
    assert not alive(int((tmp / "grandchild.pid").read_text(encoding="utf-8")))


@windows
def test_event_flood_and_huge_line_are_bounded(runtime, monkeypatch):
    service, identity, _ = runtime
    path, _, turn = start(service, identity, monkeypatch, "flood")
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "too_many_events"
    assert len(store.events_after(path, turn["id"], 0, limit=10_000)) <= chat.MAX_EVENTS + 5
    path, _, turn = start(service, identity, monkeypatch, "long_line")
    assert finish(path, turn["id"])["status"] == "done"
    assert [event["text"] for event in store.events_after(path, turn["id"]) if event["kind"] == "text"] == ["긴 줄 뒤"]


@windows
def test_short_delta_shows_up_while_cli_is_quiet(runtime, monkeypatch):
    service, identity, _ = runtime
    path, _, turn = start(service, identity, monkeypatch, "pause_after_delta")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        deltas = [event["text"] for event in store.events_after(path, turn["id"]) if event["kind"] == "text_delta"]
        if deltas:
            break
        time.sleep(0.1)
    assert deltas == ["짧은 답"]
    assert store.get_turn(path, turn["id"])["status"] == "running"  # 아직 CLI 가 조용한 동안 보였다
    assert finish(path, turn["id"])["status"] == "done"


@windows
def test_watcher_failure_stops_turn_instead_of_leaving_cli(runtime, monkeypatch):
    service, identity, _ = runtime
    real_append = store.append_event

    def broken(path, turn_id, kind, payload):
        if kind == "text_delta" and threading.current_thread().name != threading.main_thread().name \
                and not threading.current_thread().name.startswith("agent-chat-"):
            raise __import__("sqlite3").OperationalError("disk I/O error")  # 감시 스레드의 조각 저장만 실패
        return real_append(path, turn_id, kind, payload)

    monkeypatch.setattr(store, "append_event", broken)
    started = time.monotonic()
    path, _, turn = start(service, identity, monkeypatch, "pause_after_delta")
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "watch_error"
    assert time.monotonic() - started < 3.0  # 3초 조용한 가짜를 기다리지 않고 끈다


@windows
def test_state_is_last_even_when_watcher_flush_is_slow(runtime, monkeypatch):
    service, identity, _ = runtime

    def slow_still():
        time.sleep(0.8)  # 감시 스레드가 조각을 내보내는 중 신원 확인이 느리다

    path, _, turn = start(service, identity, monkeypatch, "pause_after_delta", still=slow_still)
    time.sleep(0.5)
    service.cancel(identity, turn["id"])
    finish(path, turn["id"])
    time.sleep(1.5)  # 늦게 끝나는 감시 스레드가 끝남 뒤에 무엇을 붙이는지 본다
    kinds = [event["kind"] for event in store.events_after(path, turn["id"])]
    assert kinds[-1] == "state"


def test_long_poll_never_reports_done_with_events_missing(tmp_path, monkeypatch):
    """마지막 사건 저장·'끝남'이 두 읽기 사이에 끼어도 빠뜨리지 않는다 — 상태와 사건을 한 시점에서 읽는다."""
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    service = chat.AgentChat()
    identity = chat.Identity("c" * 32, str(tmp_path / "hub.db"), "jay@example.test")
    path = identity.db_file()
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="c", mcp_entry={}, title="t")
    for round_index in range(20):
        turn, _ = store.claim_turn(path, conversation_id=conv["id"], idempotency_key=f"key-race-{round_index:03d}", text="a", context={})

        def finish_now():
            store.append_event(path, turn["id"], "plan", {"plan": {"plan_id": f"p{round_index}"}})
            store.set_status(path, turn["id"], "done")
            service._notify(turn["id"])

        writer = threading.Thread(target=finish_now)
        writer.start()
        seen, after = [], 0
        while True:
            page = asyncio.run(service.wait_events(identity, turn["id"], after, timeout=2))
            seen += page["events"]
            after = page["last_seq"]
            if page["status"] == "done" and not page["more"]:
                break
        writer.join()
        assert [event["kind"] for event in seen] == ["plan"]


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
    assert result["more"] is False
    empty = asyncio.run(service.wait_events(identity, turn["id"], result["last_seq"], timeout=0.3))
    assert empty["events"] == [] and empty["status"] == "running" and empty["last_seq"] == result["last_seq"]
    monkeypatch.setattr(chat, "EVENT_PAGE", 2)  # 끝난 차례라도 더 남았으면 more
    for index in range(3):
        store.append_event(path, turn["id"], "text", {"text": str(index)})
    store.set_status(path, turn["id"], "done")
    page = asyncio.run(service.wait_events(identity, turn["id"], result["last_seq"], timeout=0.3))
    assert page["status"] == "done" and page["more"] is True and len(page["events"]) == 2
    missing = asyncio.run(service.wait_events(identity, str(uuid4()), 0, timeout=0.1))
    assert missing["status"] == "missing"


# ── 리뷰 2차 ──
@windows
def test_reap_keeps_job_when_process_count_unknown(monkeypatch):
    """Job 조회 실패를 '0개'로 보고 차례를 풀던 것 — 조회 실패면 핸들을 쥔 채 False."""
    job = process.JobProcess()
    job.start([sys.executable, "-c", "pass"], Path.cwd(), process.child_env())
    job.proc.wait(20)
    real = process.JobProcess.pids
    monkeypatch.setattr(process.JobProcess, "pids", lambda self: None)
    assert not job.reap(0.3) and not job.closed
    monkeypatch.setattr(process.JobProcess, "pids", real)
    assert job.reap(5.0) and job.closed


@windows
def test_api_key_source_in_init_stops_turn(runtime, monkeypatch):
    """실행 전 확인을 지나도 CLI 첫 사건이 구독 아닌 인증을 말하면 바로 멈춘다."""
    service, identity, _ = runtime
    monkeypatch.setenv("FAKE_AGENT_INIT_AUTH", "ANTHROPIC_API_KEY")
    path, _, turn = start(service, identity, monkeypatch, "claude_slow")
    done = finish(path, turn["id"])
    assert done["status"] == "failed" and done["reason"] == "auth_not_subscription"
    assert store.get_conversation(path, store.get_turn(path, turn["id"])["conversation_id"])["cli_session_id"] in (None, "")


def test_codex_locked_until_isolation_checked(monkeypatch):
    """Jay 11-09 'Claude 먼저' — 실사용 기본값은 Codex 잠금(판·로그인 확인 전에 바로 거절, 프로세스도 안 띄운다)."""
    monkeypatch.setattr(process, "cli_version", lambda prefix: pytest.fail("잠긴 Codex 는 판 확인도 하지 않는다"))
    assert process.CODEX_LOCK and process.engine_problem("codex", [sys.executable, str(FAKE)]) == process.CODEX_LOCK


def test_engine_problem_checks_login_kind(monkeypatch, tmp_path):
    monkeypatch.setattr(process, "CODEX_LOCK", None)
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    for auth, expected in (("subscription", None), ("api_key", "구독 로그인이 아"), ("none", "로그인되어 있지 않")):
        monkeypatch.setenv("FAKE_AGENT_AUTH", auth)
        for engine in ("claude", "codex"):
            problem = process.engine_problem(engine, [sys.executable, str(FAKE), f"--fake-engine={engine}"])
            assert (problem is None) if expected is None else (expected in problem), (engine, auth, problem)


@windows
def test_start_failure_after_spawn_keeps_job_and_reaps(runtime, monkeypatch):
    """띄운 뒤 시작 단계에서 예외가 나도(재개 실패·스레드 실패 등) 실행기가 Job 을 쥐고 0개까지 회수한다(리뷰 2차 P1)."""
    service, identity, _ = runtime
    real_start, seen = process.JobProcess.start, []

    def start_then_fail(self, command, cwd, env):
        real_start(self, command, cwd, env)
        seen.append(self)
        raise OSError("시작 단계 실패 흉내")

    monkeypatch.setattr(process.JobProcess, "start", start_then_fail)
    path, _, turn = start(service, identity, monkeypatch, "claude_slow")
    done = finish(path, turn["id"])
    assert done["status"] == "failed"
    job = seen[0]
    assert job.closed and job.proc.poll() is not None  # 전에는 Job 을 잃어 CLI 가 남았다


@windows
def test_assign_failure_keeps_outside_process_until_it_is_gone(monkeypatch):
    """Job 배정이 실패하고 직접 끄기도 실패하면, Job 밖 CLI 가 꺼질 때까지 회수 성공으로 보지 않는다(리뷰 3차 P1)."""
    real_api, real_kill = process._api, subprocess.Popen.kill

    def api():
        k32, ntdll = real_api()

        class NoAssign:
            def __getattr__(self, name):
                return getattr(k32, name)

            def AssignProcessToJobObject(self, job, handle):
                return 0

        return NoAssign(), ntdll

    monkeypatch.setattr(process, "_api", api)
    job = process.JobProcess()
    monkeypatch.setattr(subprocess.Popen, "kill", lambda self: None)  # 직접 끄기도 실패
    with pytest.raises(OSError):
        job.start([sys.executable, "-c", "import time; time.sleep(60)"], Path.cwd(), process.child_env())
    assert not job.reap(0.5) and job.proc.poll() is None and not job.closed
    monkeypatch.setattr(subprocess.Popen, "kill", real_kill)
    assert job.reap(5.0) and job.proc.poll() is not None and job.closed
