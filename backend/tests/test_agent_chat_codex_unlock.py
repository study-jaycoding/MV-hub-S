"""Codex 활성화 계약 — 임시 폴더·가짜 CLI만. 실제 CLI·허브·MV 생성 없음."""
import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app import config
from app.services import agent_chat as chat
from app.services import agent_chat_codex as codex
from app.services import agent_chat_process as process

BACKEND = Path(__file__).resolve().parents[1]
FAKE = Path(__file__).with_name("agent_chat_fake_cli.py")
VERSION = "0.162.0-alpha.17.2"
MODEL = "gpt-6.1-sol"
REAL_WORK_PROBLEM = codex.work_problem  # 작업 폴더 검사 시험만 실제 함수를 쓴다(나머지는 임시 폴더의 실제 위 폴더를 읽지 않게)


def saved(**changes):
    return {"version": VERSION, "policy": codex.CODEX_POLICY, "at": "2026-11-14T00:00:00+00:00", **changes}


def test_codex_login_status_reads_stderr_and_rejects_failed_status(monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_AUTH", "subscription")
    prefix = [sys.executable, str(FAKE), "--fake-engine=codex"]
    command = [*prefix, "login", "status"]
    done = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=10,
                          cwd=BACKEND, env=process.child_env())
    assert done.returncode == 0 and done.stdout == ""
    assert done.stderr.strip() == "Logged in using ChatGPT"
    assert process.auth_problem(prefix) is None
    # 실패 출력에 같은 문구가 있어도 로그인 성공으로 받아들이지 않는다.
    monkeypatch.setattr(process.subprocess, "run", lambda *args, **kwargs: subprocess.CompletedProcess(
        command, 1, stdout="Logged in using ChatGPT", stderr="Logged in using ChatGPT"))
    assert process._status_output(prefix, ["login", "status"]) == ""
    assert process.auth_problem(prefix) is not None


class FakeJob:
    """프로세스 경계는 가짜 CLI로, Windows Job 조작은 별도 런타임 시험으로 확인한다."""
    instances = []

    def __init__(self):
        self.closed = False
        self.output = b""
        self.terminated = threading.Event()
        self.instances.append(self)

    def start(self, command, cwd, env):
        self.command, self.cwd, self.env = command, cwd, env

    def feed(self, data):
        if self.env.get("FAKE_AGENT_SCENARIO") == "codex_probe_timeout":
            self.output = b""
        else:
            done = subprocess.run(self.command, input=data, capture_output=True, cwd=self.cwd, env=self.env, timeout=10)
            assert done.returncode == 0, done.stderr.decode("utf-8", errors="replace")
            self.output = done.stdout

    def lines(self):
        if self.env.get("FAKE_AGENT_SCENARIO") == "codex_probe_timeout":
            assert self.terminated.wait(3)
        yield from self.output.splitlines()

    def terminate(self):
        self.terminated.set()

    def reap(self):
        self.terminate()
        self.closed = True
        return True


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    monkeypatch.setattr(process, "engine_prefix", lambda engine: [sys.executable, str(FAKE), f"--fake-engine={engine}"])
    monkeypatch.setattr(process, "cli_version", lambda prefix: VERSION)
    monkeypatch.setattr(process, "auth_problem", lambda prefix: None)
    monkeypatch.setattr(process, "JobProcess", FakeJob)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "codex_probe_ok")
    monkeypatch.setattr(codex, "REAP_RETRY_SECONDS", 0.005)
    monkeypatch.setattr(codex, "work_problem", lambda: None)
    FakeJob.instances = []
    return config.AGENT_CHAT_DIR


@pytest.mark.parametrize("raw", [None, "broken json", "[]", "{}", '{"version": 1}',
                                  json.dumps(saved(at="broken"))])
def test_disabled_never_checks_cli_even_for_engine_listing(isolated, monkeypatch, raw):
    if raw is not None:
        isolated.mkdir(parents=True)
        (isolated / "codex_enabled.json").write_text(raw, encoding="utf-8")
    monkeypatch.setattr(process, "cli_version", lambda prefix: pytest.fail("CLI version ran while disabled"))
    monkeypatch.setattr(process, "auth_problem", lambda prefix: pytest.fail("CLI login ran while disabled"))
    monkeypatch.setattr(chat.claude, "claude_state", lambda prefix: {"state": "ready", "version": "2.1.296", "subscription": "Max"})
    monkeypatch.setattr(process, "read_install_marker", lambda: None)
    assert chat.engine_problem("codex", ["fake"]) == codex.DISABLED
    row = next(row for row in chat.AgentChat().engines(refresh=True) if row["id"] == "codex")
    assert row["enabled"] is False and row["available"] is False and row["version"] == ""


@pytest.mark.parametrize("changes", [{"version": "old"}, {"policy": "old"}])
def test_changed_version_or_policy_stays_locked(isolated, monkeypatch, changes):
    codex._write("codex_enabled.json", saved(**changes))
    monkeypatch.setattr(process, "auth_problem", lambda prefix: pytest.fail("stale marker must not check login"))
    assert "다시 연결" in chat.engine_problem("codex", ["fake"])
    assert codex.state(["fake"])["enabled"] is False


@pytest.mark.parametrize("name,directory,parent", [
    ("AGENTS.md", False, False), ("AGENTS.override.md", False, False), (".codex", True, False),
    (".git", True, False), (".git", False, False), (".git", True, True), (".git", False, True),
])
def test_work_instructions_block_enable_and_turn(isolated, monkeypatch, name, directory, parent):
    monkeypatch.setattr(codex, "work_problem", REAL_WORK_PROBLEM)
    work = isolated / "work"
    work.mkdir(parents=True)
    target = (isolated if parent else work) / name
    target.mkdir() if directory else target.write_text("canary", encoding="utf-8")
    with pytest.raises(codex.CodexError, match="작업 폴더"):
        codex.enable(MODEL)
    assert codex.marker() is None and not (isolated / "codex_pending.json").exists()
    codex._write("codex_enabled.json", saved())
    assert "작업 폴더" in chat.engine_problem("codex", ["fake"])
    assert not FakeJob.instances


@pytest.mark.parametrize("check", ["install", "version", "login"])
def test_preflight_failure_does_not_write_marker(isolated, monkeypatch, check):
    if check == "install":
        monkeypatch.setattr(process, "engine_prefix", lambda engine: None)
    elif check == "version":
        monkeypatch.setattr(process, "cli_version", lambda prefix: "unverified")
    else:
        monkeypatch.setattr(process, "auth_problem", lambda prefix: "로그인 필요")
    with pytest.raises(codex.CodexError):
        codex.enable(MODEL)
    assert codex.marker() is None and not (isolated / "codex_pending.json").exists()
    assert not FakeJob.instances


def test_success_uses_panel_command_and_disable_removes_marker(isolated):
    codex._write("codex_pending.json", {"token": "dead-owner", "at": "old"})
    codex.enable(MODEL)
    assert codex.marker()["policy"] == codex.CODEX_POLICY
    assert codex.state(["fake"])["enabled"] is True
    assert chat.engine_problem("codex", ["fake"]) is None
    job = FakeJob.instances[0]
    assert job.closed and job.cwd == isolated / "work"
    assert job.command[job.command.index("--sandbox") + 1] == "read-only"
    assert "--ignore-user-config" in job.command and "--ignore-rules" in job.command
    assert set(process.CODEX_FEATURES_OFF) <= {job.command[i + 1] for i, arg in enumerate(job.command) if arg == "--disable"}
    assert any("agent_chat_probe_mcp.py" in arg for arg in job.command)
    assert not (isolated / "codex_pending.json").exists()
    codex.disable()
    assert codex.marker() is None


@pytest.mark.parametrize("scenario", ["failed", "no_result", "violation", "unknown", "zero", "two", "missing_nonce", "wrong_nonce", "timeout"])
def test_each_failed_probe_condition_stays_disabled(isolated, monkeypatch, scenario):
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "codex_probe_" + scenario)
    if scenario == "timeout":
        monkeypatch.setattr(codex, "PROBE_TIMEOUT", 0.03)
    with pytest.raises(codex.CodexError):
        codex.enable(MODEL)
    assert codex.marker() is None and not (isolated / "codex_pending.json").exists()
    assert all(job.closed for job in FakeJob.instances)
    with codex._lock("codex_probe.lock"):
        pass


def test_disable_during_probe_revokes_token_and_second_enable_is_busy(isolated, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def probe(*args):
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(codex, "_probe", probe)
    with ThreadPoolExecutor() as pool:
        running = pool.submit(codex.enable, MODEL)
        try:
            assert entered.wait(5)
            with pytest.raises(codex.Busy):
                codex.enable(MODEL)
            codex.disable()
            with pytest.raises(codex.Busy):
                codex.enable(MODEL)
        finally:
            release.set()
        with pytest.raises(codex.CodexError, match="꺼졌어요"):
            running.result(5)
    assert codex.marker() is None


def test_disable_cannot_interleave_token_check_and_replace(isolated, monkeypatch):
    writing, release, disable_started, disabled = (threading.Event() for _ in range(4))
    original = codex._write

    def write(name, value):
        if name == "codex_enabled.json":
            writing.set()
            assert release.wait(5)
        original(name, value)

    def disable():
        disable_started.set()
        codex.disable()
        disabled.set()

    monkeypatch.setattr(codex, "_write", write)
    with ThreadPoolExecutor() as pool:
        enabling = pool.submit(codex.enable, MODEL)
        try:
            assert writing.wait(5)
            disabling = pool.submit(disable)
            assert disable_started.wait(5)
            assert not disabled.wait(0.05)
        finally:
            release.set()
        enabling.result(5)
        disabling.result(5)
    assert disabled.is_set() and codex.marker() is None


def test_reap_failure_holds_execution_lock_even_after_disable(isolated, monkeypatch):
    reaping, release = threading.Event(), threading.Event()

    class ReapJob(FakeJob):
        def reap(self):
            if not release.is_set():
                reaping.set()
                return False
            return super().reap()

    monkeypatch.setattr(process, "JobProcess", ReapJob)
    with ThreadPoolExecutor() as pool:
        running = pool.submit(codex.enable, MODEL)
        try:
            assert reaping.wait(5)
            assert (isolated / "codex_pending.json").exists() and codex.marker() is None
            # 오래된 시각도 실행 잠금을 대신하지 않는다.
            pending = codex._read("codex_pending.json")
            codex._write("codex_pending.json", {**pending, "at": "2000-01-01T00:00:00+00:00"})
            with pytest.raises(codex.Busy):
                codex.enable(MODEL)
            codex.disable()
            with pytest.raises(codex.Busy):
                codex.enable(MODEL)
        finally:
            release.set()
        with pytest.raises(codex.CodexError, match="회수"):
            running.result(5)
    assert codex.marker() is None and FakeJob.instances[0].closed
    codex.enable(MODEL)
    assert codex.marker() is not None


def test_execution_lock_is_shared_with_other_process_and_released_on_exit(isolated):
    script = """
import os, sys
from pathlib import Path
from app import config
from app.services import agent_chat_codex as c
config.AGENT_CHAT_DIR = Path(sys.argv[1])
try:
    with c._lock('codex_probe.lock'):
        print('acquired', flush=True)
        os._exit(0)
except c.Busy:
    print('busy')
"""
    with codex._lock("codex_probe.lock"):
        done = subprocess.run([sys.executable, "-c", script, str(isolated)], capture_output=True, text=True,
                              timeout=10, cwd=BACKEND)
        assert done.returncode == 0 and done.stdout.strip() == "busy", done.stderr
    done = subprocess.run([sys.executable, "-c", script, str(isolated)], capture_output=True, text=True,
                          timeout=10, cwd=BACKEND)
    assert done.returncode == 0 and done.stdout.strip() == "acquired", done.stderr
    with codex._lock("codex_probe.lock"):
        pass


def test_probe_server_protocol_has_only_one_tool_and_no_resources():
    server = Path(codex.__file__).with_name("agent_chat_probe_mcp.py")
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        *({"jsonrpc": "2.0", "id": i, "method": method} for i, method in enumerate(
            ["tools/list", "resources/list", "resources/templates/list"], 2)),
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "check_connection"}},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "execute_generation_plan"}},
    ]
    done = subprocess.run([sys.executable, "-I", str(server), "test-nonce"],
                          input="".join(json.dumps(r) + "\n" for r in requests), capture_output=True, text=True,
                          timeout=10, cwd=BACKEND)
    assert done.returncode == 0, done.stderr
    replies = [json.loads(line) for line in done.stdout.splitlines()]
    assert [r["id"] for r in replies] == [1, 2, 3, 4, 5, 6]
    assert replies[0]["result"]["protocolVersion"] == "2025-03-26"
    assert [t["name"] for t in replies[1]["result"]["tools"]] == ["check_connection"]
    assert replies[2]["result"] == {"resources": []}
    assert replies[3]["result"] == {"resourceTemplates": []}
    assert replies[4]["result"]["content"] == [{"type": "text", "text": "test-nonce"}]
    assert "error" in replies[5]


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object")
def test_fake_cli_probe_with_real_job(isolated, monkeypatch):
    monkeypatch.setattr(process, "JobProcess", REAL_JOB)
    codex.enable(MODEL)
    assert codex.marker() is not None


REAL_JOB = process.JobProcess
