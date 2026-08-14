from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "run_agent_session.py"


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


def test_agent_launcher_enters_guard_before_starting_children():
    script = (ROOT / "MV_agent.bat").read_text(encoding="utf-8")

    assert "run_agent_session.py" in script
    assert 'if "%MVHUB_SESSION_GUARDED%"=="1" goto :session_guarded' in script
    assert script.index("run_agent_session.py") < script.index("[1/5] Preparing frontend")
    assert 'if not "%MVHUB_NO_BROWSER%"=="1" start' in script


def test_release_contains_session_guard():
    script = (ROOT / "release" / "make_release.ps1").read_text(encoding="utf-8")

    assert script.count('"run_agent_session.py"') == 3
