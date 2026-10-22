from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


class _ExitedProcess:
    def __init__(self, return_code: int = 2):
        self.return_code = return_code

    def wait(self, timeout=None):
        return self.return_code

    def poll(self):
        return self.return_code


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "server_supervisor.py"
    spec = importlib.util.spec_from_file_location("server_supervisor", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_restart_delay_uses_bounded_exponential_backoff():
    supervisor = _module()
    assert supervisor.restart_delay(1) == 3
    assert supervisor.restart_delay(2) == 6
    assert supervisor.restart_delay(5) == 48
    assert supervisor.restart_delay(99) == 60


def test_restart_storm_stops_and_writes_isolated_alert(tmp_path, monkeypatch):
    supervisor = _module()
    alert = tmp_path / "server-alert.txt"
    launches = []
    sleeps = []

    monkeypatch.setenv("CONTENT_HUB_RESTART_LIMIT", "2")
    monkeypatch.setenv("CONTENT_HUB_SERVER_ALERT_PATH", str(alert))
    monkeypatch.setattr(supervisor.time, "monotonic", lambda: 1.0)
    monkeypatch.setattr(supervisor.time, "sleep", sleeps.append)
    monkeypatch.setattr(supervisor, 'ROOT', tmp_path)
    monkeypatch.setattr(supervisor, 'BACKEND', tmp_path / 'backend')
    monkeypatch.setattr(supervisor, 'SERVER_ENTRYPOINT', tmp_path / 'backend/serve.py')
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tools'))

    def fake_popen(*args, **kwargs):
        launches.append((args, kwargs))
        return _ExitedProcess()

    monkeypatch.setattr(supervisor.subprocess, "Popen", fake_popen)

    assert supervisor.main() == 1
    assert len(launches) == 2
    assert launches[0][0][0] == [sys._base_executable, str(supervisor.SERVER_ENTRYPOINT)]
    assert launches[0][1]['env']['__PYVENV_LAUNCHER__'] == sys.executable
    assert launches[0][1]["cwd"] == supervisor.BACKEND
    assert sleeps == [3]
    assert "restart storm blocked" in alert.read_text(encoding="utf-8")


@pytest.mark.parametrize("error,shown", [(ValueError("journal_changed"), "ValueError (journal_changed)"),
                                         (OSError(r"C:\private\path"), "OSError")])
def test_update_failure_line_names_the_reason_code_only(tmp_path, monkeypatch, capsys, error, shown):
    supervisor = _module()
    monkeypatch.setenv("CONTENT_HUB_SERVER_ALERT_PATH", str(tmp_path / "alert.txt"))
    request = tmp_path / "server-update-request.json"
    request.write_text("{}", encoding="utf-8")

    class Running:
        def poll(self):
            return None

    class Activation:
        current = {}

        def __init__(self):
            self.request = request
            self.process = Running()

        def apply_request(self):
            self.process = None
            raise error

    assert supervisor._supervise(Activation()) == 1
    lines = [line for line in capsys.readouterr().out.splitlines() if "update failed" in line]
    assert lines == [f"[supervisor] update failed: {shown}"]
