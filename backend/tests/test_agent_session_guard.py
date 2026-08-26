from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "run_agent_session.py"
_GUARD_SPEC = importlib.util.spec_from_file_location("run_agent_session", GUARD)
assert _GUARD_SPEC is not None and _GUARD_SPEC.loader is not None
session_guard = importlib.util.module_from_spec(_GUARD_SPEC)
_GUARD_SPEC.loader.exec_module(session_guard)


def _pid_alive(pid: int) -> bool:
    process = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}",
        ],
        check=False,
    )
    return process.returncode == 0


def _wait_for_pid(path: Path, timeout: float = 10) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return int(path.read_text(encoding="utf-8"))
        time.sleep(0.1)
    raise AssertionError("child PID marker was not created")


def _wait_stopped(pid: int, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.1)
    raise AssertionError(f"child process {pid} survived the session guard")


def _fixture(tmp_path: Path, *, background: bool) -> tuple[Path, Path]:
    fixture_dir = tmp_path / "folder with spaces"
    fixture_dir.mkdir()
    marker = fixture_dir / "child.pid"
    child = fixture_dir / "child.py"
    child.write_text(
        "import os, pathlib, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8')\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    batch = fixture_dir / "session.bat"
    command = subprocess.list2cmdline([sys.executable, str(child), str(marker)])
    if background:
        batch.write_text(
            f'@echo off\nstart "" /b {command}\n'
            '>nul ping 127.0.0.1 -n 2\nexit /b 0\n',
            encoding="utf-8",
        )
    else:
        batch.write_text(f"@echo off\n{command}\n", encoding="utf-8")
    return batch, marker


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object test")
def test_guard_closes_background_children_after_normal_batch_exit(tmp_path):
    batch, marker = _fixture(tmp_path, background=True)

    result = subprocess.run([sys.executable, str(GUARD), str(batch)], timeout=15)
    child_pid = _wait_for_pid(marker)

    assert result.returncode == 0
    _wait_stopped(child_pid)


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object test")
def test_guard_closes_foreground_child_when_guard_is_forced_closed(tmp_path):
    batch, marker = _fixture(tmp_path, background=False)
    guard = subprocess.Popen([sys.executable, str(GUARD), str(batch)])
    child_pid = _wait_for_pid(marker)

    try:
        guard.kill()
        guard.wait(timeout=10)
        _wait_stopped(child_pid)
    finally:
        if _pid_alive(child_pid):
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                check=False,
                capture_output=True,
            )


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object breakaway test")
def test_explicit_breakaway_child_survives_guard_cleanup(tmp_path):
    fixture_dir = tmp_path / "browser breakaway"
    fixture_dir.mkdir()
    marker = fixture_dir / "child.pid"
    child = fixture_dir / "child.py"
    child.write_text(
        "import os, pathlib, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8')\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    starter = fixture_dir / "starter.py"
    starter.write_text(
        "import subprocess, sys\n"
        f"subprocess.Popen([sys.executable, {str(child)!r}, {str(marker)!r}], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, "
        "stderr=subprocess.DEVNULL, close_fds=True, "
        "creationflags=0x01000000 | 0x08000000)\n",
        encoding="utf-8",
    )
    batch = fixture_dir / "session.bat"
    command = subprocess.list2cmdline([sys.executable, str(starter)])
    batch.write_text(f"@echo off\n{command}\n", encoding="utf-8")

    child_pid = 0
    try:
        result = subprocess.run([sys.executable, str(GUARD), str(batch)], timeout=15)
        child_pid = _wait_for_pid(marker)

        assert result.returncode == 0
        assert _pid_alive(child_pid)
    finally:
        if child_pid and _pid_alive(child_pid):
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                check=False,
                capture_output=True,
            )


@pytest.mark.skipif(os.name != "nt", reason="Windows stale-launcher cleanup test")
def test_new_guard_closes_a_stale_pre_update_launcher_window(tmp_path):
    install_root = tmp_path / "old release folder"
    install_root.mkdir()
    launcher = install_root / "MV_agent.bat"
    launcher.write_text("@echo off\r\n:wait\r\ngoto wait\r\n", encoding="ascii")
    stale = subprocess.Popen(  # noqa: S603 - isolated test-owned batch process
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(launcher)],
        cwd=install_root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "from pathlib import Path; "
                    "from run_agent_session import _close_stale_launcher_shells; "
                    f"_close_stale_launcher_shells(Path({str(launcher)!r}))"
                ),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
        assert stale.wait(timeout=3) != 0
    finally:
        if stale.poll() is None:
            stale.kill()
            stale.wait(timeout=3)


def test_agent_launcher_enters_guard_before_starting_children():
    script = (ROOT / "MV_agent.bat").read_text(encoding="utf-8")

    assert "run_agent_session.py" in script
    assert 'if "%MVHUB_SESSION_GUARDED%"=="1" goto :session_guarded' in script
    assert script.index("run_agent_session.py") < script.index("[1/5] Preparing frontend")
    assert 'run_agent_session.py" --open-url "%MVHUB_OPEN_URL%"' in script


def test_release_contains_session_guard():
    script = (ROOT / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert script.count('"run_agent_session.py"') == 3


def test_detached_browser_launcher_uses_breakaway_job_flag(monkeypatch):
    calls: list[tuple[list[str], dict]] = []

    class DummyProcess:
        pass

    def fake_popen(command, **kwargs):
        calls.append((command, kwargs))
        return DummyProcess()

    monkeypatch.setattr(session_guard.subprocess, "Popen", fake_popen)

    session_guard.open_browser_detached("http://127.0.0.1:5173/path?q=1")

    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command[1] == "url.dll,FileProtocolHandler"
    assert command[2] == "http://127.0.0.1:5173/path?q=1"
    assert kwargs["creationflags"] & session_guard.CREATE_BREAKAWAY_FROM_JOB
    assert kwargs["creationflags"] & session_guard.CREATE_NO_WINDOW


@pytest.mark.parametrize(
    "url",
    ["", "relative/path", "file:///C:/secret.txt", "javascript:alert(1)"],
)
def test_detached_browser_launcher_rejects_non_http_urls(url):
    with pytest.raises(ValueError):
        session_guard.open_browser_detached(url)
