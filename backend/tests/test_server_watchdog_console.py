from __future__ import annotations

import io
import json
import importlib.util
import socket
import subprocess
import sys
import threading
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "server_watchdog.py"
    spec = importlib.util.spec_from_file_location("server_watchdog", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _isolated_port() -> int:
    """운영/개발 포트를 피한 워치독 실측 전용 포트."""
    for port in range(18091, 18191):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
            try:
                candidate.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise AssertionError("no isolated watchdog test port is available")


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


def _observe(watchdog, tracker, status, *, now=100.0, deadline=0.0, fail=2, busy=2, maintenance=2):
    return tracker.observe(
        status,
        now=now,
        startup_deadline=deadline,
        fail_threshold=fail,
        busy_threshold=busy,
        maintenance_threshold=maintenance,
    )


def test_probe_state_machine_never_intervenes_for_busy_or_maintenance():
    watchdog = _module()
    tracker = watchdog.ProbeTracker()

    first = _observe(watchdog, tracker, "ok")
    assert first.event == "ready_initial"

    assert _observe(watchdog, tracker, "busy").should_intervene is False
    busy_alert = _observe(watchdog, tracker, "busy")
    assert busy_alert.event == "busy_alert"
    assert busy_alert.should_alert is True
    assert busy_alert.should_intervene is False
    assert _observe(watchdog, tracker, "busy").should_alert is False

    maintenance_first = _observe(watchdog, tracker, "maintenance")
    assert maintenance_first.event == "maintenance_entered"
    assert tracker.fails == 0
    maintenance_alert = _observe(watchdog, tracker, "maintenance")
    assert maintenance_alert.event == "maintenance_alert"
    assert maintenance_alert.should_alert is True
    assert maintenance_alert.should_intervene is False

    recovered = _observe(watchdog, tracker, "ok")
    assert recovered.event == "ready_recovered"
    assert recovered.previous_maintenance == 2
    assert tracker.fails == tracker.busy_streak == tracker.maintenance_streak == 0

    hijacked = _observe(watchdog, tracker, "port_hijacked")
    assert hijacked.event == "port_hijacked"
    assert hijacked.should_alert is True
    assert hijacked.should_intervene is False


def test_probe_state_machine_intervenes_only_after_consecutive_dead_probes():
    watchdog = _module()
    tracker = watchdog.ProbeTracker()

    grace = _observe(watchdog, tracker, "dead", now=5.0, deadline=10.0)
    assert grace.event == "startup_grace"
    assert tracker.fails == 0

    _observe(watchdog, tracker, "ok", now=11.0, deadline=10.0)
    first_dead = _observe(watchdog, tracker, "dead")
    assert first_dead.event == "dead"
    assert first_dead.should_intervene is False
    assert tracker.fails == 1

    # HTTP 응답이 다시 오면 과거 무응답은 개입 카운트에서 빠진다.
    _observe(watchdog, tracker, "maintenance")
    assert tracker.fails == 0
    assert _observe(watchdog, tracker, "dead").should_intervene is False
    second_dead = _observe(watchdog, tracker, "dead")
    assert second_dead.event == "intervene"
    assert second_dead.should_intervene is True


def test_busy_during_startup_grace_does_not_raise_early_alert():
    watchdog = _module()
    tracker = watchdog.ProbeTracker()

    assert not _observe(watchdog, tracker, "busy", now=1.0, deadline=10.0, busy=1).should_alert
    assert not _observe(watchdog, tracker, "maintenance", now=2.0, deadline=10.0, maintenance=1).should_alert
    hijacked = _observe(watchdog, tracker, "port_hijacked", now=3.0, deadline=10.0)
    assert hijacked.should_alert is True
    assert hijacked.should_intervene is False
    assert _observe(watchdog, tracker, "busy", now=10.0, deadline=10.0, busy=1).should_alert


def test_http_503_maintenance_has_a_distinct_safe_status():
    watchdog = _module()
    maintenance = urllib.error.HTTPError(
        "http://127.0.0.1/ready",
        503,
        "Service Unavailable",
        {},
        io.BytesIO(b'{"status":"maintenance","private":"ignored"}'),
    )
    busy = urllib.error.HTTPError(
        "http://127.0.0.1/ready",
        503,
        "Service Unavailable",
        {},
        io.BytesIO(b'{"status":"not_ready","detail":"private"}'),
    )

    assert watchdog._http_error_status(maintenance) == ("maintenance", "HTTP 503 maintenance")
    assert watchdog._http_error_status(busy) == ("busy", "HTTP 503")


class _ReadyResponse(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def test_http_200_requires_mvhub_ready_body_and_db_checks(monkeypatch):
    watchdog = _module()
    bodies = iter(
        [
            b'{"status":"ready","checks":{"content":"ok","trash":"not_created","manage":"disabled"}}',
            b'{"status":"ready"}',
            b'{"status":"ok","checks":{"content":"ok","trash":"ok","manage":"ok"}}',
            b"not-json",
        ]
    )
    monkeypatch.setattr(
        watchdog.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _ReadyResponse(next(bodies)),
    )

    assert watchdog.check_ready("http://127.0.0.1:18091/api/ready", 0.1) == ("ok", "ok")
    assert watchdog.check_ready("http://127.0.0.1:18091/api/ready", 0.1)[0] == "port_hijacked"
    assert watchdog.check_ready("http://127.0.0.1:18091/api/ready", 0.1)[0] == "port_hijacked"
    assert watchdog.check_ready("http://127.0.0.1:18091/api/ready", 0.1)[0] == "port_hijacked"


def test_command_line_requires_exact_deployment_serve_path(tmp_path):
    watchdog = _module()
    expected = watchdog.EXPECTED_SERVE_PATH
    foreign = tmp_path / "serve.py"

    assert watchdog.command_line_matches_server(
        f'"C:\\Python\\python.exe" "{expected}"', expected
    )
    assert not watchdog.command_line_matches_server(
        f'"C:\\Python\\python.exe" "{foreign}"', expected
    )
    assert not watchdog.command_line_matches_server(
        f'"C:\\Python\\python.exe" --config="{expected}"', expected
    )
    assert not watchdog.command_line_matches_server(
        f'"C:\\Python\\python.exe" "{expected}.backup"', expected
    )


def test_foreign_serve_port_owner_is_classified_as_hijacked(tmp_path, monkeypatch):
    watchdog = _module()
    foreign_command = f'python "{tmp_path / "serve.py"}"'
    monkeypatch.setattr(watchdog, "_listen_owner_pids", lambda _port: ([43209], True))
    monkeypatch.setattr(
        watchdog,
        "_process_identity",
        lambda *_args, **_kwargs: watchdog.ProcessIdentity(
            43209, foreign_command, "creation-foreign", True
        ),
    )

    targets, status = watchdog._port_owner_targets(18091)

    assert targets == []
    assert status == "port_hijacked"


def test_kill_aborts_when_identity_changes_just_before_taskkill(tmp_path, monkeypatch):
    watchdog = _module()
    command = f'python "{watchdog.EXPECTED_SERVE_PATH}"'
    target = watchdog.ProcessIdentity(43210, command, "creation-old", True)
    monkeypatch.setattr(
        watchdog,
        "_process_identity",
        lambda *_args, **_kwargs: watchdog.ProcessIdentity(
            43210, command, "creation-reused", True
        ),
    )
    monkeypatch.setattr(
        watchdog.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("taskkill must not run")),
    )
    log_path = tmp_path / "watchdog.log"

    killed, status = watchdog.kill_pids(
        SimpleNamespace(dry_run=False, log=str(log_path)), [target], 18091
    )

    assert killed is False
    assert status == "identity_mismatch"
    assert "identity_mismatch" in log_path.read_text(encoding="utf-8")


def test_dry_run_keeps_exact_same_target_intervention_path(tmp_path, monkeypatch):
    watchdog = _module()
    command = f'python "{watchdog.EXPECTED_SERVE_PATH}"'
    target = watchdog.ProcessIdentity(43211, command, "creation-same", True)
    monkeypatch.setattr(watchdog, "_process_identity", lambda *_args, **_kwargs: target)
    monkeypatch.setattr(watchdog, "_listen_owner_pids", lambda _port: ([43211], True))
    log_path = tmp_path / "watchdog.log"

    killed, status = watchdog.kill_pids(
        SimpleNamespace(dry_run=True, log=str(log_path)), [target], 18091
    )

    assert killed is True
    assert status == "killed"
    assert "[DRY-RUN] taskkill /PID 43211 /T /F" in log_path.read_text(encoding="utf-8")


def test_watchdog_process_treats_foreign_busy_as_hijacked_without_intervention(tmp_path):
    responses = [
        (200, "ready"),
        (503, "not_ready"),
        (503, "not_ready"),
        (503, "maintenance"),
        (503, "maintenance"),
        (200, "ready"),
    ]

    class Handler(BaseHTTPRequestHandler):
        count = 0

        def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler 계약
            index = min(type(self).count, len(responses) - 1)
            type(self).count += 1
            code, status = responses[index]
            payload = {"status": status, "secret": "must-not-log"}
            if status == "ready":
                payload["checks"] = {"content": "ok", "trash": "not_created", "manage": "disabled"}
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format, *_args):
            return None

    server = ThreadingHTTPServer(("127.0.0.1", _isolated_port()), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log_path = tmp_path / "watchdog.log"
    script = Path(__file__).resolve().parents[2] / "tools" / "server_watchdog.py"
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--url",
                f"http://127.0.0.1:{server.server_port}/api/ready",
                "--port",
                str(server.server_port),
                "--interval",
                "0.01",
                "--timeout",
                "0.5",
                "--startup-grace",
                "0",
                "--fail-threshold",
                "2",
                "--busy-threshold",
                "2",
                "--maintenance-threshold",
                "2",
                "--max-probes",
                str(len(responses)),
                "--dry-run",
                "--log",
                str(log_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.returncode == 0, result.stderr
    log_text = log_path.read_text(encoding="utf-8")
    assert "port_hijacked" in log_text
    assert "HTTP 503 maintenance" in log_text
    assert "ALERT 해제" in log_text
    assert "개입 — 대상" not in log_text
    assert "taskkill" not in log_text
    assert "must-not-log" not in log_text
    assert "검증 종료 — 6회 확인" in log_text
    assert not log_path.with_name("watchdog_ALERT.txt").exists()


def test_watchdog_dry_run_never_targets_foreign_serve_path(tmp_path):
    if sys.platform != "win32":
        return

    serve_script = tmp_path / "serve.py"
    port_path = tmp_path / "port.txt"
    serve_script.write_text(
        """
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

class Handler(BaseHTTPRequestHandler):
    count = 0
    def do_GET(self):
        type(self).count += 1
        if type(self).count > 1:
            time.sleep(1.0)
        body = json.dumps({
            "status": "ready",
            "checks": {"content": "ok", "trash": "not_created", "manage": "disabled"},
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass
    def log_message(self, _format, *_args):
        return None

server = HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
Path(sys.argv[2]).write_text(str(server.server_port), encoding="ascii")
server.serve_forever()
""".lstrip(),
        encoding="utf-8",
    )
    port = _isolated_port()
    server_process = subprocess.Popen(
        [sys.executable, str(serve_script), str(port), str(port_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 5
        port_text = ""
        while time.monotonic() < deadline:
            if port_path.is_file():
                # Windows에서는 파일 생성과 내용 기록 사이의 아주 짧은 구간이 보일 수 있다.
                # 존재 여부만 보고 즉시 읽으면 빈 문자열을 정수로 바꾸다 간헐 실패한다.
                port_text = port_path.read_text(encoding="ascii").strip()
                if port_text.isdigit():
                    break
            time.sleep(0.02)
        assert port_text.isdigit(), "isolated serve.py did not publish its port"
        assert int(port_text) == port
        log_path = tmp_path / "hung-watchdog.log"
        watchdog_script = Path(__file__).resolve().parents[2] / "tools" / "server_watchdog.py"
        result = subprocess.run(
            [
                sys.executable,
                str(watchdog_script),
                "--port",
                str(port),
                "--url",
                f"http://127.0.0.1:{port}/api/ready",
                "--interval",
                "0.01",
                "--timeout",
                "0.1",
                "--startup-grace",
                "0",
                "--fail-threshold",
                "2",
                "--post-kill-grace",
                "0.01",
                "--max-probes",
                "3",
                "--dry-run",
                "--log",
                str(log_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, result.stderr
        log_text = log_path.read_text(encoding="utf-8")
        assert "응답 이상 2/2" in log_text
        assert "port_hijacked" in log_text or "port-owner-query-failed" in log_text
        assert "개입 — 대상 PID" not in log_text
        assert "[DRY-RUN] taskkill" not in log_text
        assert "검증 종료 — 3회 확인" in log_text
        assert server_process.poll() is None
    finally:
        if server_process.poll() is None:
            server_process.terminate()
            try:
                server_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server_process.kill()
                server_process.wait(timeout=3)
