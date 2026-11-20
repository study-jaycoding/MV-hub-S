"""요청 파일·실행기·Codex 찾기를 임시 사용자와 가짜 설치기로 확인한다. 인터넷/실제 CLI 없음."""
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app import config
from app.services import agent_chat as chat
from app.services import agent_chat_claude as claude
from app.services import agent_chat_codex as codex
from app.services import agent_chat_install as install
from app.services import agent_chat_process as process

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("install_launcher_test", ROOT / "run_agent_session.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)
VERSION = next(iter(process.CODEX_VERIFIED))


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setenv("CONTENT_HUB_AGENT_INSTALL_ID", "a" * 10)
    monkeypatch.setenv("CONTENT_HUB_AGENT_INSTALL_PORT", "59321")
    monkeypatch.setenv("CONTENT_HUB_AGENT_INSTALL_GENERATION", "b" * 32)
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent")
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(claude, "_login_token_problem", lambda: None)
    monkeypatch.setattr(install, "process_start", lambda pid: 123 if pid == 42 else None)
    install.write(install.directory() / "launcher.json", {"pid": 42, "start": 123, "generation": "b" * 32,
                  "release": True, "ready": True})
    monkeypatch.setattr(launcher, "_install_id", lambda: "a" * 10)
    monkeypatch.setattr(launcher, "_claude_install_eligible", lambda **kw: True)
    monkeypatch.setattr(launcher, "_claude_token_problem", lambda: None)
    monkeypatch.setattr(launcher, "_run_claude_installer", lambda *a, **kw: pytest.fail("real installer"))
    return tmp_path


def test_duplicate_clicks_and_restart_keep_id_and_atomic_files(isolated):
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: install.request("codex"), range(6)))
    assert len({row["id"] for row in results}) == 1
    assert all(row["state"] == "running" for row in results)
    request = install.read(install.directory() / "codex.request.json")
    assert set(request) == {"id", "engine", "install_id", "generation", "at"}
    assert not list(install.directory().glob("*.tmp"))
    assert install.request("codex")["id"] == results[0]["id"]


@pytest.mark.parametrize("change,reason", [("dead", "launcher_missing"), ("pid_reuse", "launcher_missing"),
    ("dev", "release_only"), ("boot", "boot_pending"), ("server", "shared_server"),
    ("elevated", "elevated"), ("service", "service_account"), ("other_user", "other_user"), ("unknown", "token_unknown")])
def test_request_eligibility_has_no_request_side_effect(isolated, monkeypatch, change, reason):
    path = install.directory() / "launcher.json"
    live = install.read(path)
    if change == "dead": live["pid"] = 99
    elif change == "pid_reuse": live["start"] = 124
    elif change == "dev": live["release"] = False
    elif change == "boot": live["ready"] = False
    elif change == "server": monkeypatch.setattr(config, "AUTH_ENABLED", True)
    else: monkeypatch.setattr(claude, "_login_token_problem", lambda: change)
    install.write(path, live)
    assert install.request("codex")["reason"] == reason
    assert not (path.parent / "codex.request.json").exists()


def test_generation_change_interrupts_running_and_old_ok_is_not_new_success(isolated, monkeypatch):
    first = install.request("codex")
    monkeypatch.setenv("CONTENT_HUB_AGENT_INSTALL_GENERATION", "c" * 32)
    assert install.status("codex")["reason"] == "interrupted"
    monkeypatch.setenv("CONTENT_HUB_AGENT_INSTALL_GENERATION", "b" * 32)
    path = install.directory() / "codex.json"
    install.write(path, {**install.read(path), "state": "ok", "id": "f" * 32})
    assert install.status("codex") is None
    assert first["id"] != "f" * 32


def test_forged_ok_needs_exact_exe_version_and_no_update_marker(isolated, monkeypatch):
    install.request("codex")
    path = install.directory() / "codex.json"
    install.write(path, {**install.read(path), "state": "ok"})
    assert install.verified_status("codex")["reason"] == "version_check"
    exe = install.official_codex()
    exe.parent.mkdir(parents=True)
    exe.touch()
    seen = []
    monkeypatch.setattr(process, "cli_version", lambda prefix: seen.append(prefix) or VERSION)
    assert install.verified_status("codex")["state"] == "ok"
    assert seen == [[str(exe)]]
    update = install.codex_home() / "packages" / "standalone" / "auto-update-version"
    update.parent.mkdir(parents=True)
    update.touch()
    assert install.verified_status("codex")["reason"] == "version_check"


def test_installer_env_is_product_code_with_pinned_release_and_shared_home(isolated, monkeypatch):
    env = install.installer_env({"CODEX_INSTALL_DIR": "ignored", "CODEX_RELEASE": "latest", "CODEX_HOME": "same-home", "PATH": "unchanged"})
    assert env == {"CODEX_RELEASE": VERSION, "CODEX_NON_INTERACTIVE": "1", "CODEX_HOME": "same-home", "PATH": "unchanged"}
    assert "https://chatgpt.com/codex/install.ps1" in launcher._codex_install_command()[1]


@pytest.mark.parametrize("engine", ["claude", "codex"])
def test_requested_install_bypasses_wait_and_revalidates_result(isolated, monkeypatch, engine):
    install.request(engine)
    request = install.read(install.directory() / f"{engine}.request.json")
    installed, calls = [False], []
    monkeypatch.setattr(launcher, "_claude_version", lambda *a, **kw: (VERSION if engine == "codex" else "2.1.400") if installed[0] else None)
    monkeypatch.setattr(launcher, "_read_claude_marker", lambda: {"status": "failed", "at": time.time()})
    monkeypatch.setattr(launcher, "_set_claude_status", lambda *a, **kw: True)
    def run(*a, **kw):
        calls.append(kw)
        installed[0] = True
        return 0, None
    monkeypatch.setattr(launcher, "_run_claude_installer", run)
    launcher._run_requested_install(install, request)
    assert install.status(engine)["state"] == "ok" and len(calls) == 1
    if engine == "codex": assert calls[0]["env"]["CODEX_RELEASE"] == VERSION


@pytest.mark.skipif(os.name != "nt", reason="Windows 파일 잠금")
def test_manual_request_waits_for_existing_automatic_claude_lock(isolated, monkeypatch):
    install.request("claude")
    request = install.read(install.directory() / "claude.request.json")
    monkeypatch.setattr(launcher, "_claude_version", lambda *args, **kw: "2.1.400")
    worker = threading.Thread(target=launcher._run_requested_install, args=(install, request))
    with launcher._claude_install_lock() as held:
        assert held
        worker.start()
        time.sleep(0.2)
        assert worker.is_alive() and install.status("claude")["state"] == "running"
    worker.join(3)
    assert not worker.is_alive() and install.status("claude")["state"] == "ok"


def test_claude_marker_failure_does_not_start_installer(isolated, monkeypatch):
    install.request("claude")
    request = install.read(install.directory() / "claude.request.json")
    monkeypatch.setattr(launcher, "_claude_version", lambda *args, **kw: None)
    monkeypatch.setattr(launcher, "_set_claude_status", lambda *args, **kw: False)
    launcher._run_requested_install(install, request)
    assert install.status("claude")["reason"] == "marker_failed"


@pytest.mark.parametrize("change", ["generation", "install_id", "command", "url", "path", "at"])
def test_launcher_rejects_wrong_boundary_and_arbitrary_commands(isolated, change):
    install.request("codex")
    request = install.read(install.directory() / "codex.request.json")
    request[change] = 0 if change == "at" else "unsafe"
    assert not launcher._request_valid(install, request, "codex", "b" * 32)


def test_find_codex_keeps_enabled_npm_and_excludes_only_installing_official(isolated, monkeypatch):
    npm = isolated / "npm"
    script = npm / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    script.parent.mkdir(parents=True)
    script.touch()
    (npm / "codex.cmd").touch()
    exe = install.official_codex()
    exe.parent.mkdir(parents=True)
    exe.touch()
    monkeypatch.setenv("PATH", os.pathsep.join([str(exe.parent), str(npm)]))
    monkeypatch.setattr(process.shutil, "which", lambda name: "node.exe" if name == "node" else str(exe))
    versions = {str(script): VERSION, str(exe): VERSION}
    seen = []
    monkeypatch.setattr(process, "cli_version", lambda prefix: seen.append(prefix) or versions[prefix[-1]])
    npm_prefix = ["node.exe", str(script)]
    codex._write("codex_enabled.json", {"version": VERSION, "policy": codex.CODEX_POLICY, "at": "2026-11-20"})
    assert process.find_codex() == npm_prefix
    install.request("codex")
    seen.clear()
    assert process.find_codex() == npm_prefix and all(str(exe) not in prefix for prefix in seen)
    (install.directory() / "codex.request.json").unlink()
    codex.disable()
    versions[str(script)] = "old"
    assert process.find_codex() == [str(exe)]
    monkeypatch.setattr(process.shutil, "which", lambda _: None)
    assert process.find_codex() == [str(exe)]  # node 없음


def test_old_marker_is_only_for_verified_npm(isolated):
    saved = {"version": VERSION, "policy": codex.CODEX_POLICY}
    assert codex.target_matches(saved, ["node", "codex.js"])
    assert not codex.target_matches(saved, [str(install.official_codex())])
    assert not codex.target_matches({**saved, "policy": "old"}, ["node", "codex.js"])
    saved["target"] = process.codex_target([str(install.official_codex())])
    assert codex.target_matches(saved, [str(install.official_codex())])
    assert not codex.target_matches(saved, ["node", "codex.js"])


def test_disable_before_pending_blocks_late_enable(isolated):
    chain = "c" * 32
    codex.start_chain(chain)
    codex.disable()
    with pytest.raises(codex.CodexError, match="취소"):
        codex.enable("gpt-6.1-sol", chain_id=chain)
    assert codex._read("codex_pending.json") is None


def test_codex_has_no_boot_install_call():
    import ast
    tree = ast.parse((ROOT / "run_agent_session.py").read_text(encoding="utf-8"))
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
             and node.func.id == "_codex_install_command"]
    assert len(calls) == 1  # 요청 처리 안에만 있다.


def test_launcher_publish_generation_boot_gate_poll_and_cleanup(isolated, monkeypatch):
    monkeypatch.setattr(launcher, "_install_contract", lambda: install)
    monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", "control")
    monkeypatch.setenv("MVHUB_EXECUTION_NONCE", "nonce")
    committed = [False]
    monkeypatch.setattr(launcher, "_update_boot_outcome", lambda nonce: True if committed[0] else None)
    ran = threading.Event()
    monkeypatch.setattr(launcher, "_run_requested_install", lambda *args: ran.set())
    close = launcher._start_install_requests("59321")
    try:
        live = install.read(install.directory() / "launcher.json")
        assert live["generation"] != "b" * 32 and live["ready"] is False
        # 실제 조회 간격은 2초. committed 전 요청은 실행하지 않는다.
        req = {"id": "a" * 32, "engine": "codex", "install_id": "a" * 10,
               "generation": live["generation"], "at": int(time.time())}
        install.write(install.directory() / "codex.request.json", req)
        install.write(install.directory() / "codex.json", {**req, "state": "running"})
        assert not ran.wait(0.1)
        committed[0] = True
        assert ran.wait(4)
        assert install.read(install.directory() / "launcher.json")["ready"] is True
        # 새 세대 표식은 옛 실행기가 지우지 않는다.
        install.write(install.directory() / "launcher.json", {"generation": "new"})
    finally:
        close()
    assert install.read(install.directory() / "launcher.json")["generation"] == "new"


@pytest.mark.skipif(os.name != "nt", reason="Windows Job")
def test_real_installer_driver_closes_input_and_passes_environment(isolated, monkeypatch):
    # 실행은 가짜 Python 만, 15분 기본 시한과 기존 Job 회수 장치는 별도 기존 시험이 덮는다.
    output = isolated / "fake-install.json"
    code = ("import os,sys,json,pathlib; "
            f"pathlib.Path({str(output)!r}).write_text(json.dumps([os.environ.get('CODEX_RELEASE'), "
            "sys.stdin is None or sys.stdin.read() == '']))")
    executable = sys._base_executable  # venv 리다이렉터 대신 설치기와 같은 직접 실행 파일
    command = (executable, subprocess.list2cmdline([executable, "-c", code]))
    # 고정물의 실제 설치 방지 대역을 거치지 않고, 보존한 함수에 가짜 명령만 준다.
    result = REAL_DRIVER(command, timeout=5, env=install.installer_env())
    assert result == (0, None), (result, output.read_text() if output.exists() else "no output")
    assert json.loads(output.read_text()) == [VERSION, True]


REAL_DRIVER = launcher._run_claude_installer
