from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "server_watchdog.py"
    spec = importlib.util.spec_from_file_location("server_watchdog", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class _StrictCp949:
    encoding = "cp949"

    def __init__(self) -> None:
        self.parts: list[str] = []

    def write(self, text: str) -> int:
        text.encode(self.encoding)
        self.parts.append(text)
        return len(text)

    def flush(self) -> None:
        return None


def test_watchdog_log_never_stops_on_unencodable_console_character(tmp_path, monkeypatch):
    watchdog = _module()
    console = _StrictCp949()
    monkeypatch.setattr(watchdog.sys, "stdout", console)
    log_path = tmp_path / "watchdog.log"

    watchdog.log(SimpleNamespace(log=str(log_path)), "워치독 시작 — 정상")

    assert "\\u2014" in "".join(console.parts)
    assert "워치독 시작 — 정상" in log_path.read_text(encoding="utf-8")


def test_recovered_watchdog_clears_only_its_alert(tmp_path):
    watchdog = _module()
    log_path = tmp_path / "watchdog.log"
    watchdog_alert = tmp_path / "watchdog_ALERT.txt"
    server_alert = tmp_path / "server_ALERT.txt"
    watchdog_alert.write_text("old", encoding="utf-8")
    server_alert.write_text("keep", encoding="utf-8")

    assert watchdog.clear_recovered_alert(SimpleNamespace(log=str(log_path)))
    assert not watchdog_alert.exists()
    assert server_alert.exists()
    assert "ALERT 해제" in log_path.read_text(encoding="utf-8")
