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


# ── R-2 backend/app/routers/backup_replica.py `_task_info` ────────────────────────────────────


def _backup_task_fakes(arguments: str) -> str:
    return (
        "function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'MVHub BackupCopy'; State = 'Ready'; "
        "Principal = [pscustomobject]@{ UserId = 'SYSTEM' }; "
        "Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = '" + arguments + "' }); "
        "Settings = [pscustomobject]@{ MultipleInstances = 'IgnoreNew' } } }; "
        "function Get-ScheduledTaskInfo { [pscustomobject]@{ LastRunTime = [datetime]'2026-10-16'; "
        "LastTaskResult = 0; NextRunTime = [datetime]'2026-10-17' } }; "
    )


def test_task_info_matches_korean_install_path(monkeypatch, tmp_path):
    from app.routers import backup_replica as route

    root = tmp_path / "한글 설치 폴더"
    monkeypatch.setattr(route, "ROOT", root)
    _pipe(monkeypatch, fakes=_backup_task_fakes('/c call "' + str(root / "task_launch.bat") + '" backup'))

    task = route._task_info()

    assert task is not None
    assert (task["exists"], task["system"], task["ignore_new"]) == (True, True, True)
    assert task["matches_install"] is True


# 실제 Get-ScheduledTask 처럼 -TaskName 이 맞지 않으면 '없음'(ObjectNotFound) 비종료 오류를 낸다.
_OTHER_TASK_ONLY = (
    "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) "
    "$all = @([pscustomobject]@{ TaskName = 'Other Task' }); "
    "if (-not $TaskName) { return $all }; "
    "$hit = @($all | Where-Object { $_.TaskName -eq $TaskName }); if ($hit.Count) { return $hit }; "
    "$PSCmdlet.WriteError((New-Object System.Management.Automation.ErrorRecord "
    "((New-Object System.Exception 'No MSFT_ScheduledTask objects found'), 'NotFound', 'ObjectNotFound', $TaskName))) }; "
)
# 권한·CIM 오류 — 결과 없이 비종료 오류만 낸다.
_ACCESS_DENIED = (
    "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) "
    "$PSCmdlet.WriteError((New-Object System.Management.Automation.ErrorRecord "
    "((New-Object System.UnauthorizedAccessException 'Access is denied'), 'AccessDenied', 'PermissionDenied', $null))) }; "
)


def test_task_query_error_is_unknown_not_missing(monkeypatch):
    """정상 조회에서 확인된 부재만 '없음' — 권한·CIM 오류를 SilentlyContinue 뒤에서 '없음'(실행 409·저장 진행)으로
    바꾸면 안 된다(Codex 리뷰 P2)."""
    from app.routers import backup_replica as route

    _pipe(monkeypatch, fakes=_OTHER_TASK_ONLY)
    absent = route._task_info()
    assert absent is not None and absent["exists"] is False

    _pipe(monkeypatch, fakes=_ACCESS_DENIED)
    assert route._task_info() is None


def test_task_query_failure_returns_503_without_running_task(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import deps
    from app.routers import backup_replica as route

    mod = route._replicator()
    monkeypatch.setattr(mod, "TARGET_FILE", tmp_path / "backup_replica_target.txt")
    monkeypatch.setattr(mod, "STATUS_FILE", tmp_path / "backup_replica_status.json")
    (tmp_path / "backup_replica_target.txt").write_text("\\\\NAS\\backup\\mvhub\n", encoding="utf-8")
    for name in ("CONTENT_HUB_BACKUP_REPLICA_DIR", "CONTENT_HUB_DATA", "CONTENT_HUB_NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(route, "AUTH_ENABLED", True)
    root = tmp_path / "한글 설치 폴더"
    monkeypatch.setattr(route, "ROOT", root)
    task = {
        "exists": True, "state": "Ready", "user": "SYSTEM", "action_count": 1, "execute": "cmd.exe",
        "arguments": '/c call "' + str(root / "task_launch.bat") + '" backup', "multi": "IgnoreNew",
        "last_run": "2026-10-16T00:00:00.0000000Z", "last_result": 0, "next_run": "",
    }
    # 출력 인코딩 고정이 듣지 않은 옛 출력(CP949) — 깨진 경로를 '설치 불일치'로 읽지 말고 '모름'으로 다뤄야 한다.
    others = _pipe(monkeypatch, emit=lambda _script: json.dumps(task, ensure_ascii=False).encode("cp949"))

    app = FastAPI()

    @app.middleware("http")
    async def admin(request, call_next):
        request.state.account = {"status": "approved", "global_role": "admin", "global_roles": ["admin"]}
        return await call_next(request)

    app.include_router(route.router)
    response = TestClient(app).post("/api/admin/backup-replica/run", json={})

    assert response.status_code == 503, response.text
    assert [args for args in others if args and args[0] == "schtasks"] == []


# ── R-3 run_agent_session.py `_browser_processes` · `_console_cmd_cmdlines` ───────────────────

KOREAN_PROFILE = "D:\\한글 사용자\\MVHub\\app-profile"
CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
BROWSER_ROW = {
    "ProcessId": 4321,
    "ExecutablePath": CHROME_EXE,
    "CommandLine": '"' + CHROME_EXE + '" --user-data-dir="' + KOREAN_PROFILE + '" --app=http://127.0.0.1/',
}
CONSOLE_LINE = 'cmd /c ""D:\\한글 설치\\MV-hub\\MV_agent.bat" "'


def _launcher():
    return _load("mvhub_launcher_utf8_target", REPO / "run_agent_session.py")


def _cim_fake(rows: list[dict]) -> str:
    objects = []
    for row in rows:
        fields = "; ".join(
            f"{key} = {value}" if isinstance(value, int) else f"{key} = '{value}'" for key, value in row.items()
        )
        objects.append("[pscustomobject]@{ " + fields + " }")
    return "function Get-CimInstance { " + ", ".join(objects) + " }; "


def test_browser_and_console_queries_keep_korean_paths(monkeypatch):
    launcher = _launcher()
    _pipe(monkeypatch, fakes=_cim_fake([BROWSER_ROW]))
    assert launcher._browser_processes("chrome.exe") == [
        {"pid": 4321, "exe": CHROME_EXE, "cmdline": BROWSER_ROW["CommandLine"]}
    ]
    assert launcher._profile_pids(CHROME_EXE, Path(KOREAN_PROFILE)) == ({4321}, {4321})

    _pipe(monkeypatch, fakes=_cim_fake([{"ProcessId": 77, "CommandLine": CONSOLE_LINE}]))
    assert launcher._console_cmd_cmdlines([77, 78]) == [CONSOLE_LINE, None]


def test_browser_decode_failure_does_not_count_as_empty_scan(monkeypatch):
    """CP949 옛 출력을 못 읽은 것을 '조회 성공·프로세스 없음'([])으로 바꾸면 앱 창이 떠 있는데 감시가 종료로 센다."""
    launcher = _launcher()
    _pipe(monkeypatch, emit=lambda _script: json.dumps([BROWSER_ROW], ensure_ascii=False).encode("cp949"))

    assert launcher._browser_processes("chrome.exe") is None
    assert launcher._profile_pids(CHROME_EXE, Path(KOREAN_PROFILE)) is None


def test_console_decode_failure_keeps_console_visible(monkeypatch):
    """못 읽은 조회는 '읽었지만 명령줄 없음'([None]) 이 아니라 조회 실패(None) — 호출측은 둘 다 숨기지 않는다."""
    launcher = _launcher()
    row = {"ProcessId": 77, "CommandLine": CONSOLE_LINE}
    _pipe(monkeypatch, emit=lambda _script: json.dumps([row], ensure_ascii=False).encode("cp949"))

    lines = launcher._console_cmd_cmdlines([77])

    assert lines is None
