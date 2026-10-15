from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import types
from contextlib import nullcontext
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("workroom_launcher", ROOT / "tools/workroom.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def test_configuration_paths_and_explicit_port_override(tmp_path):
    (tmp_path / ".mvhub-workroom.json").write_text(json.dumps({
        "runtime": "../작업실 데이터", "backend_port": 8050, "frontend_port": 5250,
        "python": sys.executable,
    }), encoding="utf-8")
    args = launcher.options(["--frontend-port", "5251", "--no-browser"], tmp_path)
    assert args.runtime == str((tmp_path / "../작업실 데이터").resolve())
    assert (args.backend_port, args.frontend_port) == (8050, 5251)
    assert args.source_db is None and args.no_browser


@pytest.mark.parametrize("backend,frontend", [(8050, 8050), (0, 5250), (8050, 65536)])
def test_invalid_ports_fail_before_runtime_creation(tmp_path, backend, frontend):
    with pytest.raises(SystemExit):
        launcher.options(["--runtime", str(tmp_path / "new"), "--backend-port", str(backend),
                          "--frontend-port", str(frontend)], tmp_path)
    assert not (tmp_path / "new").exists()


def test_unknown_config_is_not_silently_ignored(tmp_path):
    (tmp_path / ".mvhub-workroom.json").write_text('{"run_agent":true}', encoding="utf-8")
    with pytest.raises(ValueError, match="지원하지 않는"):
        launcher.options([], tmp_path)


def test_null_python_is_rejected_with_configuration_error(tmp_path):
    (tmp_path / ".mvhub-workroom.json").write_text(json.dumps({
        "runtime": "../runtime", "backend_port": 8050, "frontend_port": 5250, "python": None,
    }), encoding="utf-8")
    with pytest.raises(SystemExit):
        launcher.options([], tmp_path)


def test_port_conflict_leaves_existing_listener_alive():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        with pytest.raises(RuntimeError, match="기존 프로그램은 종료하지"):
            launcher.assert_ports_free([port])
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            connection, _ = listener.accept()
            connection.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows named mutex")
def test_same_runtime_cannot_start_twice_and_releases_after_exit(tmp_path):
    with launcher.runtime_lock(tmp_path):
        with pytest.raises(RuntimeError, match="이미 실행"):
            with launcher.runtime_lock(tmp_path):
                pass
        with launcher.runtime_lock(tmp_path / "different"):
            pass
    with launcher.runtime_lock(tmp_path):
        pass


def test_exited_child_does_not_accept_foreign_health_response(monkeypatch):
    process = types.SimpleNamespace(poll=lambda: 1)
    with pytest.raises(RuntimeError, match="시작 중 종료"):
        launcher.wait_ready("http://127.0.0.1:54321/api/ready", process, timeout=.1)


def test_readiness_requires_ready_json_not_just_http_200(monkeypatch):
    class Response:
        status = 200

        def __init__(self, payload):
            self.payload = payload

        def read(self, _limit):
            return self.payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    reads = []

    def open_url(_url, timeout):
        reads.append(timeout)
        return Response(b'{"status":"warming"}' if len(reads) == 1 else b'{"status":"ready"}')

    monkeypatch.setattr(launcher.urllib.request, "build_opener", lambda *_args: types.SimpleNamespace(open=open_url))
    monkeypatch.setattr(launcher.time, "sleep", lambda _seconds: None)
    launcher.wait_ready("http://127.0.0.1:54321/api/ready", types.SimpleNamespace(poll=lambda: None))
    assert len(reads) == 2


class FakeProcess:
    def __init__(self, pid, exited=False):
        self.pid, self.exited, self.terminated = pid, exited, False

    def poll(self):
        return 0 if self.exited else None

    def terminate(self):
        self.terminated = self.exited = True

    def wait(self, timeout):
        return 0


def runtime_fixture(tmp_path, monkeypatch, *, browser):
    repo = tmp_path / "source"
    vite = repo / "frontend/node_modules/vite/bin/vite.js"
    vite.parent.mkdir(parents=True)
    vite.write_text("fixture", encoding="utf-8")
    runtime = tmp_path / "runtime"
    args = launcher.options(["--runtime", str(runtime), "--backend-port", "8050",
                             "--frontend-port", "5250", "--python", sys.executable], repo)
    args.no_browser = not browser
    monkeypatch.setattr(launcher.shutil, "which", lambda _name: "node.exe")
    monkeypatch.setattr(launcher, "runtime_lock", lambda _runtime: nullcontext())
    monkeypatch.setattr(launcher, "assert_ports_free", lambda _ports: None)
    monkeypatch.setattr(launcher, "wait_ready", lambda *_args: None)
    fake_browser = tmp_path / "browser.exe"
    fake_browser.write_bytes(b"fixture")
    monkeypatch.setitem(sys.modules, "run_agent_session", types.SimpleNamespace(
        _find_app_browser=lambda: ("edge", str(fake_browser))))
    hashes = {"user-config": "unchanged-hash"}
    monkeypatch.setitem(sys.modules, "workroom_data", types.SimpleNamespace(
        llm_config_hashes=lambda: hashes.copy(),
        prepare_runtime=lambda runtime, _source, _repo: runtime.mkdir(),
        runtime_env=lambda _runtime, _repo, _port, _parent: {"HOME": "isolated-home"},
    ))
    return repo, runtime, args


def test_browser_exit_stops_only_owned_children_and_records_hashes(tmp_path, monkeypatch):
    repo, runtime, args = runtime_fixture(tmp_path, monkeypatch, browser=True)
    children = [FakeProcess(101), FakeProcess(102), FakeProcess(103, exited=True)]
    launched = []

    def spawn(command, **kwargs):
        launched.append((command, kwargs))
        return children[len(launched) - 1]

    monkeypatch.setattr(launcher.subprocess, "Popen", spawn)
    assert launcher.run(args, repo) == 0
    assert children[0].terminated and children[1].terminated
    assert not children[2].terminated
    assert "--reload" not in launched[0][0]
    assert "workroom_backend.py" in launched[0][0][2]
    assert launched[1][0][-5:] == ["--host", "127.0.0.1", "--port", "5250", "--strictPort"]
    assert launched[1][0][2:4] == ["--config", str(runtime / "generated-vite.config.mjs")]
    config = (runtime / "generated-vite.config.mjs").read_text(encoding="utf-8")
    assert "[시험실 5250] MV Hub" in config and "실제 생성 꺼짐" in config
    assert "pointer-events:none" in config and "apply: 'serve'" in config
    assert f"--user-data-dir={runtime / 'browser'}" in launched[2][0]
    assert "--disable-background-mode" in launched[2][0]
    assert all(item[1]["env"]["HOME"] == "isolated-home" for item in launched)
    state = json.loads((runtime / "launcher-state.json").read_text(encoding="utf-8"))
    assert state["status"] == "stopped" and state["llm_config_unchanged"] is True
    assert state["pids"] == [101, 102, 103]


def test_frontend_spawn_failure_cleans_started_backend(tmp_path, monkeypatch):
    repo, runtime, args = runtime_fixture(tmp_path, monkeypatch, browser=False)
    backend = FakeProcess(101)
    calls = []

    def spawn(command, **_kwargs):
        calls.append(command)
        if len(calls) == 2:
            raise OSError("fixture spawn failure")
        return backend

    monkeypatch.setattr(launcher.subprocess, "Popen", spawn)
    with pytest.raises(OSError, match="fixture spawn failure"):
        launcher.run(args, repo)
    assert backend.terminated
    state = json.loads((runtime / "launcher-state.json").read_text(encoding="utf-8"))
    assert state["status"] == "stopped" and state["pids"] == [101]


def test_wrapper_uses_job_primitive_not_old_session_replacement(tmp_path, monkeypatch):
    captured = []

    def guarded(script):
        captured.append((script, json.loads(os.environ[launcher.CHILD_OPTIONS])))
        return 0

    monkeypatch.delenv(launcher.CHILD_OPTIONS, raising=False)
    monkeypatch.setitem(sys.modules, "run_agent_session", types.SimpleNamespace(run_guarded=guarded))
    assert launcher.main(["--runtime", str(tmp_path), "--backend-port", "8050",
                          "--frontend-port", "5250", "--no-browser"]) == 0
    assert captured[0][0] == ROOT / "test_workroom.bat"
    assert "--no-browser" in captured[0][1]
    assert launcher.CHILD_OPTIONS not in os.environ
