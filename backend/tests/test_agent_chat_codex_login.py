"""Codex 로그인 창 — Win32 경계만 대역, 실제 로그인·브라우저·대화 실행 없음."""
import subprocess
from types import SimpleNamespace

import pytest

from app import config
from app.services import agent_chat_claude as claude
from app.services import agent_chat_codex as codex
from app.services import agent_chat_codex_login as login
from app.services import agent_chat_install as install
from app.services import agent_chat_process as process


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent")
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", True)
    monkeypatch.setattr(claude, "_login_token_problem", lambda: None)
    monkeypatch.setattr(claude, "_window_trapped", lambda proc: False)
    monkeypatch.setattr(claude, "_handle_start", lambda *args: 123)
    monkeypatch.setattr(claude, "_k32", lambda: None)
    monkeypatch.setattr(claude, "_resume", lambda proc: None)
    monkeypatch.setattr(claude, "process_start", lambda pid: 123)
    monkeypatch.setattr(process, "engine_prefix", lambda _: [str(tmp_path / "codex.exe")])
    monkeypatch.setattr(process, "cli_version", lambda _: next(iter(process.CODEX_VERIFIED)))
    monkeypatch.setattr(process, "auth_problem", lambda _: "not logged in")
    monkeypatch.setattr(login, "ports_busy", lambda: False)
    proc = SimpleNamespace(pid=42, _handle=42, poll=lambda: None, kill=lambda: None, wait=lambda **kw: 0)
    calls = []
    monkeypatch.setattr(login, "_spawn", lambda prefix: calls.append(prefix) or proc)
    return proc, calls


@pytest.mark.parametrize("kind", ["official", "npm"])
def test_visible_console_breakaway_no_output_read_and_same_home(isolated, tmp_path, monkeypatch, kind):
    prefix = [str(tmp_path / "codex.exe")] if kind == "official" else ["node", str(tmp_path / "codex.js")]
    seen = []
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: seen.append((args, kwargs)) or "proc")
    REAL_SPAWN(prefix)
    args, kwargs = seen[0]
    assert args[0] == [*prefix, "login"]
    assert kwargs["env"]["CODEX_HOME"] == str(tmp_path / "home")
    assert kwargs["creationflags"] == claude.CREATE_NEW_CONSOLE | claude.CREATE_BREAKAWAY_FROM_JOB | process.CREATE_SUSPENDED
    assert not {"stdin", "stdout", "stderr"} & kwargs.keys()


REAL_SPAWN = login._spawn


def test_only_one_window_and_record_before_resume(isolated, monkeypatch):
    proc, calls = isolated
    monkeypatch.setattr(claude, "_resume", lambda proc: pytest.fail("record missing") if not login._record().get("start") else None)
    first = login.open_login_window()
    second = login.open_login_window()
    assert first == second and first["state"] == "running" and len(calls) == 1


@pytest.mark.parametrize("problem", ["elevated", "service", "other_user", "unknown"])
def test_refuses_bad_token_without_spawn(isolated, monkeypatch, problem):
    monkeypatch.setattr(claude, "_login_token_problem", lambda: problem)
    with pytest.raises(codex.CodexError): login.open_login_window()
    assert isolated[1] == [] and not login._record()


def test_job_trapped_never_resumes_and_kills_suspended_process(isolated, monkeypatch):
    killed = []
    isolated[0].kill = lambda: killed.append(True)
    monkeypatch.setattr(claude, "_window_trapped", lambda _: True)
    monkeypatch.setattr(claude, "_resume", lambda _: pytest.fail("trapped window resumed"))
    assert login.open_login_window()["reason"] == "job"
    assert killed == [True]


def test_finished_login_checks_status_before_declaring_unfinished(isolated, monkeypatch):
    opened = login.open_login_window()
    monkeypatch.setattr(claude, "process_start", lambda _: None)  # 성공 직후 코드 0 으로 종료
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    assert login.status(opened["id"])["state"] == "ok"


def test_unrelated_failure_with_busy_ports_reports_fact_only(isolated, monkeypatch):
    opened = login.open_login_window()
    monkeypatch.setattr(claude, "process_start", lambda _: None)
    monkeypatch.setattr(login, "ports_busy", lambda: True)
    status = login.status(opened["id"])
    assert status["state"] == "failed" and status["reason"] == "login_unfinished" and status["ports_busy"] is True


def test_forged_ok_wrong_target_and_wrong_id_do_not_succeed(isolated, monkeypatch):
    opened = login.open_login_window()
    install.write(login._folder() / "window.json", {**login._record(), "state": "ok"})
    monkeypatch.setattr(claude, "process_start", lambda _: None)
    assert login.status(opened["id"])["state"] == "failed"
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    monkeypatch.setattr(process, "engine_prefix", lambda _: ["other.exe"])
    assert login.status(opened["id"])["state"] == "failed"
    assert login.status("wrong")["state"] == "failed"


def test_disable_during_login_blocks_late_enable(isolated, monkeypatch):
    opened = login.open_login_window()
    codex.disable()
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    assert login.status(opened["id"])["state"] == "ok"
    with pytest.raises(codex.CodexError, match="취소"):
        codex.enable("gpt-6.1-sol", chain_id=opened["id"])
    assert codex._read("codex_pending.json") is None and codex.marker() is None


def test_broken_window_record_does_not_allow_a_second_window(isolated):
    path = login._folder() / "window.json"
    path.parent.mkdir(parents=True)
    path.write_text("broken", encoding="utf-8")
    with pytest.raises(codex.CodexError): login.open_login_window()
    assert isolated[1] == []


def test_port_permission_error_is_not_reported_as_occupied(isolated, monkeypatch):
    import errno
    class Probe:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def setsockopt(self, *args): pass
        def bind(self, address): raise OSError(errno.EACCES, "permission")
    monkeypatch.setattr(login.socket, "socket", Probe)
    assert REAL_PORTS_BUSY() is False


REAL_PORTS_BUSY = login.ports_busy


@pytest.mark.parametrize("problem", ["elevated", "unknown"])
@pytest.mark.parametrize("window_enabled", [False, True])
def test_authenticated_can_enable_without_window_permission(isolated, monkeypatch, problem, window_enabled):
    checked = []
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", window_enabled)
    monkeypatch.setattr(claude, "_login_token_problem", lambda: checked.append(problem) or problem)
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    monkeypatch.setattr(codex, "_probe", lambda *args: None)
    monkeypatch.setattr(codex, "work_problem", lambda: None)
    connected = login.open_login_window()
    assert connected["state"] == "ok" and isolated[1] == [] and checked == []
    codex.enable("gpt-6.1-sol", chain_id=connected["id"])
    assert codex.marker() is not None


def test_reconnect_reuses_open_window_with_fresh_chain_after_disable(isolated):
    old = login.open_login_window()
    codex.disable()
    new = login.open_login_window()
    assert new["state"] == "running" and new["id"] != old["id"]
    assert login._record()["id"] == new["id"] and len(isolated[1]) == 1
    codex.check_chain(new["id"])
    with pytest.raises(codex.CodexError): codex.check_chain(old["id"])


def test_window_switch_off_uses_manual_login_and_rechecks_exact_target(isolated, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_LOGIN_WINDOW", False)
    monkeypatch.setattr(claude, "_login_token_problem", lambda: pytest.fail("no window permission needed"))
    manual = login.open_login_window()
    assert manual["state"] == "manual" and isolated[1] == []
    assert login.status(manual["id"])["state"] == "manual"
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    assert login.status(manual["id"])["state"] == "ok"


def test_api_key_requires_explicit_reconnect_before_opening_window(isolated, monkeypatch):
    monkeypatch.setattr(process, "auth_problem", lambda _: process.CODEX_NOT_SUBSCRIPTION)
    warning = login.open_login_window()
    assert warning["state"] == "not_subscription" and isolated[1] == []
    confirmed = login.open_login_window(reconnect=True)
    assert confirmed["state"] == "running" and len(isolated[1]) == 1


def test_unverified_version_keeps_existing_check_needed_message(isolated, monkeypatch):
    monkeypatch.setattr(process, "cli_version", lambda _: "0.1.0")
    with pytest.raises(codex.CodexError, match=r"점검 필요 — 확인하지 않은 판입니다\(0.1.0\)"):
        login.open_login_window()
    assert isolated[1] == []


def test_login_rechecks_selected_allowed_candidate_when_disabled(isolated, monkeypatch):
    npm, official = ["node", "codex.js"], ["codex.exe"]
    monkeypatch.setattr(process, "engine_prefix", lambda _: npm)
    monkeypatch.setattr(process, "_codex_candidates", lambda: [npm, official])
    monkeypatch.setattr(process, "cli_version", lambda prefix: next(iter(process.CODEX_VERIFIED)) if prefix == official else "old")
    opened = login.open_login_window()
    assert isolated[1] == [official]
    monkeypatch.setattr(process, "auth_problem", lambda _: None)
    assert login.status(opened["id"])["state"] == "ok"
