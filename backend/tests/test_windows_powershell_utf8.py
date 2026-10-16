"""Windows PowerShell 조회의 출력 계약 — 한국어 Windows 출력이 실제 파이프를 거칠 때(81회차 R-1~R-3).

현장 허브·서버는 PYTHONUTF8=1 이라 text=True 의 기본 해석이 UTF-8 이고, 한국어 Windows 의 PowerShell 은 출력
인코딩을 정하지 않으면 콘솔 코드 페이지(CP949)로 낸다. 이미 해석된 글자를 돌려주는 가짜로는 이 경계를 못 보므로
두 가지를 실제 파이프로 만든다(조회 cmdlet 만 가짜, 출력 인코딩·파이프·해석은 진짜).
- 949 콘솔의 진짜 PowerShell: 출력 코드 페이지를 949 로 바꾼 숨은 콘솔에서 띄운다 — 스크립트가 UTF-8 로 고정하는지 본다.
- CP949 옛 출력: CP949 바이트를 그대로 내는 자식 — 깨진 글자를 '조회 성공'으로 받지 않는지 본다.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows PowerShell 전용")

REPO = Path(__file__).resolve().parents[2]
TOOLS = REPO / "tools"
KOREAN_SERVE = "D:\\한글 시험\\MVHub\\backend\\serve.py"

_REAL_RUN = subprocess.run
_CREATE_NO_WINDOW = 0x08000000
_SHIM_949 = (
    "import ctypes, subprocess, sys; "
    "ctypes.windll.kernel32.SetConsoleOutputCP(949); "
    "sys.exit(subprocess.call(sys.argv[1:]))"
)
_EMIT = "import sys; sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))"


def _pipe(monkeypatch, *, fakes: str = "", emit=None) -> list:
    """subprocess.run 을 실제 파이프로 돌린다. emit(script)->bytes 가 있으면 그 바이트를 내는 자식,
    없으면 949 콘솔의 진짜 PowerShell(fakes 를 스크립트 앞에 붙여 조회 cmdlet 만 대신). PowerShell 이 아닌
    명령(schtasks 등)은 실행하지 않고 기록만 한다."""
    others: list = []

    def run(args, **kwargs):
        if "powershell" not in Path(str(args[0])).name.lower():
            others.append(list(args))
            return subprocess.CompletedProcess(args, 0, b"", b"")
        kw = dict(kwargs)
        if kw.get("text") and not kw.get("encoding"):
            kw["encoding"] = "utf-8"  # PYTHONUTF8=1 에서 text=True 의 기본 해석 — 이 PC 의 locale 과 무관하게 현장 조건으로
        if emit is not None:
            return _REAL_RUN([sys.executable, "-c", _EMIT, emit(args[-1]).hex()], **kw)
        kw["creationflags"] = kw.get("creationflags", 0) | _CREATE_NO_WINDOW  # 949 는 이 시험의 숨은 콘솔에만
        return _REAL_RUN([sys.executable, "-c", _SHIM_949, *args[:-1], fakes + args[-1]], **kw)

    monkeypatch.setattr(subprocess, "run", run)
    return others


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# ── R-1 tools/server_watchdog.py `_powershell_json` (server_move 도 재사용) ─────────────────────


def test_powershell_json_preserves_korean_paths(monkeypatch):
    watchdog = _load("server_watchdog", TOOLS / "server_watchdog.py")
    command = '"C:\\Python\\python.exe" "' + KOREAN_SERVE + '"'
    fakes = (
        "function Get-CimInstance { [pscustomobject]@{ ProcessId = 4321; "
        "CommandLine = '" + command + "'; CreationDate = '20261016000000.000000+540' } }; "
    )
    _pipe(monkeypatch, fakes=fakes)

    identity = watchdog._process_identity(4321, owns_port=True)

    assert identity is not None
    assert identity.command_line == command
    assert watchdog.command_line_matches_server(identity.command_line, Path(KOREAN_SERVE))


def test_powershell_missing_stdout_is_query_failure(monkeypatch, tmp_path):
    watchdog = _load("server_watchdog", TOOLS / "server_watchdog.py")
    # 진짜 PowerShell 의 0행은 '[]' 로 와서 '조회 성공·없음'이다.
    _pipe(monkeypatch)
    assert watchdog._powershell_json(
        "Get-ChildItem -LiteralPath '" + str(tmp_path) + "' -Filter 'mvhub-none-*'"
    ) == ([], True)
    # 출력이 아예 없으면(읽기 실패·출력 누락) '없음'이 아니라 조회 실패다.
    _pipe(monkeypatch, emit=lambda _script: b"")
    assert watchdog._powershell_json("Get-Anything") == ([], False)


def test_cp949_process_list_never_counts_as_server_stopped(monkeypatch, tmp_path):
    """예약 작업 Disabled · 포트 점유 없음 · 프로세스 목록만 CP949 로 깨진 조합 — 살아 있는 서버를 못 본 채
    DB 교체 전 정지 검사가 통과하면 안 된다(Codex 1721 리뷰 P1 재현 조건)."""
    sm = _load("server_move", TOOLS / "server_move.py")
    install = tmp_path / "한글 설치"
    monkeypatch.setattr(sm, "ROOT", install)
    monkeypatch.setattr(sm, "BACKEND", install / "backend")
    serve = str((install / "backend" / "serve.py").resolve())
    process = [{"ProcessId": 4321, "CommandLine": '"C:\\Python\\python.exe" "' + serve + '"'}]

    def emit(script: str) -> bytes:
        if "Get-ScheduledTask" in script:
            return b'[{"TaskName":"MVHub Server","State":"Disabled"}]'
        if "Win32_Process" in script:
            return json.dumps(process, ensure_ascii=False).encode("cp949")
        return b"[]"

    _pipe(monkeypatch, emit=emit)

    with pytest.raises(sm.ServerActive, match="프로세스 목록을 조회하지 못"):
        sm.ensure_server_stopped(8010)
