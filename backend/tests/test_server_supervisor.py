from __future__ import annotations

import importlib.util
from pathlib import Path


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

    def fake_popen(*args, **kwargs):
        launches.append((args, kwargs))
        return _ExitedProcess()

    monkeypatch.setattr(supervisor.subprocess, "Popen", fake_popen)

    assert supervisor.main() == 1
    assert len(launches) == 2
    assert sleeps == [3]
    assert "restart storm blocked" in alert.read_text(encoding="utf-8")
