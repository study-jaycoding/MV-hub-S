"""앱 시작 단계 줄이기(속도 점검 2-11, 2026-11-07).

포트에 아무 줄도 없으면 포트 정리 PowerShell(약 1초)을 띄우지 않는다 — netstat 확인은 약 0.07초.
"""
from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "MV_agent.bat"


def _cleanup_block() -> str:
    lines = LAUNCHER.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith('if exist "%ROOT%tools\\stop_local_hub_on_port.ps1" ('))
    end = next(i for i in range(start, len(lines)) if "stop_local_hub_on_port.ps1 missing" in lines[i])
    return "\r\n".join(lines[start:end + 2])  # 경고 줄 + 닫는 괄호


def test_launcher_stays_ascii():
    LAUNCHER.read_bytes().decode("ascii")


def test_port_check_comes_before_the_powershell_cleanup():
    block = _cleanup_block()
    assert block.index("netstat -ano 2>nul || echo MVHUB_NETSTAT_FAILED") < block.index("stop_local_hub_on_port.ps1\" -Port")
    assert "if errorlevel 1 if not errorlevel 2 set \"_PORT_BUSY=\"" in block
    assert "if defined _PORT_BUSY (" in block
    assert "%TEMP%" not in block  # 임시 파일이 없다 — 다른 설치본의 같은 포트 실행과 파일을 나눠 쓰지 않는다


@pytest.mark.skipif(os.name != "nt", reason="Windows 배치 파일")
@pytest.mark.parametrize("listening,broken,expected", [
    (False, None, False),  # 포트에 아무 줄도 없다 — PowerShell 을 띄우지 않는다
    (True, None, True),  # 듣는 프로세스가 있다 — 지금처럼 소유자 확인·정리
    (False, "netstat", True),  # netstat 이 실패했다 — 모르니 지금처럼 정리(빈 포트로 보지 않는다)
    (False, "findstr", True),  # 목록을 못 읽었다(findstr 오류) — '일치 없음'으로 보지 않는다
])
def test_cleanup_runs_unless_netstat_shows_an_empty_port(tmp_path, listening, broken, expected):
    (tmp_path / "tools").mkdir()
    marker = tmp_path / "ran.txt"
    (tmp_path / "tools" / "stop_local_hub_on_port.ps1").write_text(
        f"param([int]$Port)\nSet-Content -LiteralPath '{marker}' -Value $Port\nexit 0\n", encoding="ascii")
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    if listening:
        server.listen(1)
    else:
        server.close()
    batch = tmp_path / "check.bat"
    batch.write_text("@echo off\r\n" + _cleanup_block() + "\r\necho done\r\nexit /b 0\r\n:err\r\necho failed\r\nexit /b 1\r\n",
                     encoding="ascii")
    env = {**os.environ, "ROOT": str(tmp_path) + "\\", "PORT": str(port), "TEMP": str(tmp_path)}
    if broken:
        # PATH 앞에 '실패하는' 도구 — where.exe 는 처음 보는 인자(-ano·/c:)에 곧바로 2 로 끝난다.
        fake = tmp_path / "fakebin"
        fake.mkdir()
        system32 = Path(os.environ["SystemRoot"]) / "System32"
        (fake / f"{broken}.exe").write_bytes((system32 / "where.exe").read_bytes())
        env["PATH"] = str(fake) + os.pathsep + env["PATH"]
    try:
        result = subprocess.run(["cmd.exe", "/d", "/c", str(batch)], capture_output=True, text=True, timeout=60, env=env)
    finally:
        server.close()
    assert result.returncode == 0, result.stdout + result.stderr
    assert marker.exists() is expected
