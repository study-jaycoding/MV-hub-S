# -*- coding: utf-8 -*-
"""Run MV_agent.bat inside a Windows kill-on-close Job Object.

The batch launcher starts the local hub and (in dev mode) Vite in the
background. Console close events are not a reliable process-tree boundary on
Windows, so those children could survive after the visible CMD window closed.
Keeping the only Job handle in this foreground process gives Windows an exact
ownership boundary: normal return, Ctrl+C, or abrupt console termination closes
the handle and terminates every process created by the guarded launcher.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlsplit


CREATE_SUSPENDED = 0x00000004
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
INFINITE = 0xFFFFFFFF


_STALE_LAUNCHER_CLEANUP = r"""
$ErrorActionPreference = "SilentlyContinue"
$launcher = $env:MVHUB_CLEANUP_LAUNCHER
$root = $env:MVHUB_CLEANUP_ROOT
$current = [int]$env:MVHUB_CLEANUP_CURRENT
$guardScript = Join-Path $root "run_agent_session.py"
$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)

function Test-MvHubSessionProcess($process) {
    if (-not $process) { return $false }
    $executable = [string]$process.ExecutablePath
    $commandLine = [string]$process.CommandLine
    return (
        ($executable -and $executable.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or
        ($commandLine.IndexOf($guardScript, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    )
}

foreach ($candidate in $all) {
    $commandLine = [string]$candidate.CommandLine
    if (
        $candidate.ProcessId -eq $current -or
        $candidate.Name -ine "cmd.exe" -or
        $commandLine.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -lt 0
    ) {
        continue
    }

    $parent = $all | Where-Object { $_.ProcessId -eq $candidate.ParentProcessId } | Select-Object -First 1
    $hasSessionRelative = Test-MvHubSessionProcess $parent
    if (-not $hasSessionRelative) {
        foreach ($child in $all) {
            if ($child.ParentProcessId -eq $candidate.ProcessId -and (Test-MvHubSessionProcess $child)) {
                $hasSessionRelative = $true
                break
            }
        }
    }
    if (-not $hasSessionRelative) {
        Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
"""


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


def _configure_api():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.CreateProcessW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.BOOL,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.POINTER(STARTUPINFOW),
        ctypes.POINTER(PROCESS_INFORMATION),
    ]
    kernel32.CreateProcessW.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel32.ResumeThread.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32


def _create_suspended_process(kernel32, script: Path) -> PROCESS_INFORMATION:
    comspec = os.environ.get("ComSpec", str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"))
    command = subprocess.list2cmdline([comspec, "/d", "/c", "call", str(script)])
    startup = STARTUPINFOW(cb=ctypes.sizeof(STARTUPINFOW))

    # Prefer leaving a possible parent job first. Some hosts disallow breakaway;
    # Windows 8+ nested jobs are then the safe fallback.
    errors: list[int] = []
    for flags in (
        CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB,
        CREATE_SUSPENDED,
    ):
        info = PROCESS_INFORMATION()
        command_buffer = ctypes.create_unicode_buffer(command)
        if kernel32.CreateProcessW(
            comspec,
            command_buffer,
            None,
            None,
            False,
            flags,
            None,
            str(script.parent),
            ctypes.byref(startup),
            ctypes.byref(info),
        ):
            return info
        errors.append(ctypes.get_last_error())
    raise OSError(errors[-1], f"guarded launcher creation failed ({errors})")


def _close_stale_launcher_shells(script: Path) -> None:
    """Close only orphaned visible launchers left by a pre-fix release update."""
    if os.name != "nt":
        return

    root = str(script.parent.resolve()).rstrip("\\/") + "\\"
    env = os.environ.copy()
    env.update(
        {
            "MVHUB_CLEANUP_LAUNCHER": str(script.resolve()),
            "MVHUB_CLEANUP_ROOT": root,
            "MVHUB_CLEANUP_CURRENT": str(os.getppid()),
        }
    )
    powershell = str(
        Path(os.environ["SystemRoot"])
        / "System32"
        / "WindowsPowerShell"
        / "v1.0"
        / "powershell.exe"
    )
    try:
        subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", _STALE_LAUNCHER_CLEANUP],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        # Cleanup is compatibility polish, not a reason to block a valid launch.
        pass


# ── 앱 창 모드 ──────────────────────────────────────────────────────────────
# 수명 앵커를 "콘솔 창"에서 "브라우저 앱 창(전용 프로필)"으로 바꾼다.
#   · --app-probe  : 앱 창 모드 가능 여부(Edge/Chrome 존재)만 판정 — 성공 0 / 불가 3.
#   · --app-window : 앱 창을 띄우거나(있으면 입양) 실제 '보이는 창(HWND)'을 감시.
#                    창이 전부 닫히면 0 반환 → bat 종료 → Job 정리로 허브·에이전트 정지.
# 창(HWND)이 앵커다 — 브라우저 루트 프로세스는 창이 다 닫혀도 남을 수 있어(백그라운드 모드)
# PID 대기만으로는 종료를 놓친다(코덱스 검토 반영).

APP_EXIT_NO_BROWSER = 3  # Edge/Chrome 없음 — bat 이 기존(콘솔 표시) 방식으로 폴백
APP_EXIT_NO_WINDOW = 4  # 창이 제시간에 안 나타남/감시 실패 — 콘솔 복구 후 반환

_APP_WINDOW_CLASS_PREFIX = "Chrome_WidgetWin"
_APP_CLOSE_DEBOUNCE_SCANS = 3  # 연속 N 회(초) 창 0 이어야 '닫힘' 확정 — 순간 깜빡임 오인 방지
_APP_FIRST_WINDOW_TIMEOUT = 40.0

ERROR_ALREADY_EXISTS = 183
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_HIDE = 0
SW_SHOW = 5

_launcher_mutex_handle = None  # 프로세스 수명 동안 유지 — GC 로 닫히면 mutex 가 풀린다


def _user32():
    return ctypes.WinDLL("user32", use_last_error=True)


def _install_id() -> str:
    """설치 루트별 고유 id — 여러 설치(릴리스/저장소)가 프로필·mutex 를 공유하지 않게."""
    root = str(Path(__file__).resolve().parent).casefold()
    return hashlib.sha1(root.encode("utf-8")).hexdigest()[:10]


def _find_app_browser() -> tuple[str, str] | None:
    """앱 모드 지원 브라우저 탐색 — (이름, exe 절대경로). 기본 Chrome 우선, 다음 Edge(Jay 결정).
    env MVHUB_APP_BROWSER=chrome|edge 로 우선순위를 뒤집을 수 있다(선호 없으면 나머지로 폴백)."""
    if os.name != "nt":
        return None
    import winreg

    def from_app_paths(exe: str) -> str | None:
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                try:
                    with winreg.OpenKey(
                        hive,
                        rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}",
                        0,
                        winreg.KEY_READ | view,
                    ) as key:
                        value, _kind = winreg.QueryValueEx(key, None)
                        if value and Path(value).is_file():
                            return str(Path(value))
                except OSError:
                    continue
        return None

    def first_existing(paths: list[str]) -> str | None:
        for p in paths:
            if p and Path(p).is_file():
                return str(Path(p))
        return None

    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")

    def find_edge() -> tuple[str, str] | None:
        exe = from_app_paths("msedge.exe") or first_existing(
            [
                str(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
                str(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
                str(Path(local) / "Microsoft" / "Edge" / "Application" / "msedge.exe") if local else "",
            ]
        )
        return ("edge", exe) if exe else None

    def find_chrome() -> tuple[str, str] | None:
        exe = from_app_paths("chrome.exe") or first_existing(
            [
                str(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe"),
                str(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe"),
                str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe") if local else "",
            ]
        )
        return ("chrome", exe) if exe else None

    preferred = os.environ.get("MVHUB_APP_BROWSER", "").strip().lower()
    order = (find_edge, find_chrome) if preferred == "edge" else (find_chrome, find_edge)
    for finder in order:
        found = finder()
        if found:
            return found
    return None


def _app_profile_dir(browser_name: str) -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    return base / "MVHub" / "app-window" / f"{browser_name}-{_install_id()}"


def _parse_command_line(command_line: str) -> list[str]:
    """Windows 규칙으로 커맨드라인 → 인자 리스트 (CommandLineToArgvW)."""
    if not command_line:
        return []
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    shell32.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    argc = ctypes.c_int(0)
    argv = shell32.CommandLineToArgvW(command_line, ctypes.byref(argc))
    if not argv:
        return []
    try:
        return [argv[i] for i in range(argc.value)]
    finally:
        ctypes.windll.kernel32.LocalFree(argv)


def _browser_processes(exe_basename: str) -> list[dict] | None:
    """해당 브라우저 프로세스의 {pid, exe, cmdline} 목록 — PowerShell CIM 1회 조회.

    반환 3상태(코덱스 합의): 목록=성공, []=성공했고 프로세스 없음, None=조회 실패.
    실패를 '없음'으로 합치면 앱 창이 떠 있는데 감시가 종료로 오판한다. cmdlet 오류가
    non-terminating 으로 exit 0 이 되지 않게 ErrorAction Stop 을 강제하고, 구조가
    예상과 다르거나 CommandLine 을 못 읽는 행(권한·종료 중)이 있으면 '우리 프로필이
    아님'을 증명할 수 없으므로 보수적으로 None."""
    powershell = str(
        Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    )
    script = (
        "$ErrorActionPreference='Stop'; "
        f"Get-CimInstance Win32_Process -Filter \"Name='{exe_basename}'\" -ErrorAction Stop | "
        "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        proc = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    raw = (proc.stdout or "").strip()
    if not raw:
        return []  # 조회 성공 + 해당 프로세스 없음
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    rows = data if isinstance(data, list) else [data]
    out: list[dict] = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("ProcessId") or not row.get("CommandLine"):
            return None
        try:
            pid = int(row["ProcessId"])
        except (TypeError, ValueError):
            return None
        out.append(
            {
                "pid": pid,
                "exe": str(row.get("ExecutablePath") or ""),
                "cmdline": str(row["CommandLine"]),
            }
        )
    return out


def _profile_pids(
    browser_exe: str, profile: Path, *, verify_exe: bool = True
) -> tuple[set[int], set[int]] | None:
    """전용 프로필을 물고 있는 (루트 pid 집합, 전체 pid 집합) — 조회 실패면 None.
    루트 = --type= 인자가 없는 브라우저 프로세스(렌더러/GPU/crashpad 제외).
    verify_exe=False 면 실행파일 경로 대조 생략(basename 만 아는 호출측용)."""
    rows = _browser_processes(Path(browser_exe).name)
    if rows is None:
        return None
    want_profile = str(profile).casefold().rstrip("\\/")
    want_exe = str(Path(browser_exe)).casefold() if verify_exe else ""
    roots: set[int] = set()
    all_pids: set[int] = set()
    for row in rows:
        argv = _parse_command_line(row["cmdline"])
        profile_arg = None
        has_type = False
        for i, arg in enumerate(argv):
            if arg.startswith("--user-data-dir="):
                profile_arg = arg.split("=", 1)[1]
            elif arg == "--user-data-dir" and i + 1 < len(argv):
                profile_arg = argv[i + 1]
            elif arg.startswith("--type="):
                has_type = True
        if not profile_arg:
            continue
        if str(Path(profile_arg)).casefold().rstrip("\\/") != want_profile:
            continue
        exe = str(Path(row["exe"])).casefold() if row["exe"] else ""
        if want_exe and exe and exe != want_exe:
            continue
        all_pids.add(row["pid"])
        if not has_type:
            roots.add(row["pid"])
    return roots, all_pids


def _visible_app_hwnds(pids: set[int]) -> list[int]:
    """해당 프로세스들이 소유한 '보이는' 브라우저 최상위 창 목록."""
    if not pids:
        return []
    user32 = _user32()
    found: list[int] = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        owner_pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
        if owner_pid.value not in pids:
            return True
        buffer = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buffer, 64)
        if buffer.value.startswith(_APP_WINDOW_CLASS_PREFIX):
            found.append(int(hwnd) if hwnd else 0)
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return [h for h in found if h]


# 앱 창 판정: 제목이 이 접두로 시작하면 MV Hub 창(메인·Assets·Manage 모두 해당).
# DevTools("DevTools - …")·오류 페이지·Ctrl+N 새 탭은 접두가 달라 제외된다.
_APP_TITLE_PREFIX = "Millionvolt Hub"


def _approved_prop_name() -> str:
    """승인 표식 Window Property 이름 — 설치별로 달라 다른 설치의 창과 혼동 없음.
    property 는 창과 함께 소멸하고 프로세스 경계 너머에서 읽히므로, watcher·close
    helper·업데이트 후 새 watcher 가 같은 승인 정보를 공유한다(코덱스 합의)."""
    return f"MVHubAppWindow_{_install_id()}"


def _window_title(hwnd: int) -> str:
    user32 = _user32()
    buffer = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buffer, 512)
    return buffer.value


def _is_app_title(title: str) -> bool:
    return title.startswith(_APP_TITLE_PREFIX)


def _mark_approved(hwnd: int) -> None:
    user32 = _user32()
    user32.SetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.HANDLE]
    user32.SetPropW(hwnd, _approved_prop_name(), wintypes.HANDLE(1))


def _is_marked_approved(hwnd: int) -> bool:
    user32 = _user32()
    user32.GetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    user32.GetPropW.restype = wintypes.HANDLE
    return bool(user32.GetPropW(hwnd, _approved_prop_name()))


def _classify_app_hwnds(pids: set[int]) -> tuple[list[int], list[int]]:
    """보이는 프로필 창을 (MV Hub 창, 그 외)로 분류.

    MV Hub 창 = 승인 property 보유 또는 제목 접두 일치. 제목이 일치하는 창에는
    property 를 심어 두므로, 이후 제목이 바뀌어도(업데이트 중 오류 페이지 등)
    창이 사라질 때까지 MV Hub 창으로 인식된다(스티키 승인)."""
    app: list[int] = []
    other: list[int] = []
    for hwnd in _visible_app_hwnds(pids):
        if _is_marked_approved(hwnd):
            app.append(hwnd)
        elif _is_app_title(_window_title(hwnd)):
            _mark_approved(hwnd)
            app.append(hwnd)
        else:
            other.append(hwnd)
    return app, other


def _spawn_app_window(browser_exe: str, profile: Path, url: str) -> subprocess.Popen:
    """앱 창 실행 — Job 밖(BREAKAWAY)이라 업데이트 재시작 중에도 창이 살아남는다.
    루트가 이미 있으면 이 호출은 기존 루트에 '창 하나 열어라' 명령만 전달하고 끝난다.
    반환 Popen 은 CIM 조회 실패 시 창 탐색의 보조 pid 로 쓴다(살아있을 때만 유효)."""
    profile.mkdir(parents=True, exist_ok=True)
    # appwin=1 — 프론트가 '앱 창'임을 알고 Host 콘솔에 '앱 종료' 버튼을 노출한다.
    # (X 닫기는 확인 없이 조용히 닫힘 — 일반 브라우저 탭·test_dev 에는 표식이 없다)
    url = url + ("&" if "?" in url else "?") + "appwin=1"
    subprocess.Popen(
        [
            browser_exe,
            f"--app={url}",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
    )


def _console_window() -> int:
    return int(ctypes.windll.kernel32.GetConsoleWindow() or 0)


def _launched_as_one_shot(cmdcmdline: str) -> bool:
    """최초 cmd 의 기동 명령줄(MVHUB_CMDCMDLINE)에 /c 가 있으면 일회용 실행(더블클릭 등).
    /c 없음 = 사용자가 띄워 둔 대화형 cmd(또는 /k) — 그 창을 숨기면 안 된다.
    값이 없거나 파싱 실패면 False(안전하게 '숨기지 않음')."""
    if not cmdcmdline:
        return False
    try:
        argv = _parse_command_line(cmdcmdline)
    except Exception:
        return False
    return any(arg.casefold() == "/c" for arg in argv)


def _console_is_ours() -> bool:
    """이 콘솔에 사용자 셸(PowerShell 등)이 붙어 있으면 숨기지 않는다 —
    더블클릭 실행(콘솔=우리 전용)일 때만 숨김(코덱스 검토 반영).
    cmd.exe 는 bat 해석기라 프로세스 목록만으로는 대화형/일회용을 못 가른다 →
    bat 이 넘겨준 최초 기동 명령줄(MVHUB_CMDCMDLINE)의 /c 유무로 판별한다."""
    if not _launched_as_one_shot(os.environ.get("MVHUB_CMDCMDLINE", "")):
        return False
    kernel32 = ctypes.windll.kernel32
    count = 64
    pids = (wintypes.DWORD * count)()
    got = kernel32.GetConsoleProcessList(pids, count)
    if not got:
        return False
    foreign = {"powershell.exe", "pwsh.exe", "wt.exe", "windowsterminal.exe", "conemu64.exe"}
    for i in range(min(int(got), count)):
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pids[i])
        if not handle:
            continue
        try:
            size = wintypes.DWORD(1024)
            buffer = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                if Path(buffer.value).name.casefold() in foreign:
                    return False
        finally:
            kernel32.CloseHandle(handle)
    return True


def _set_console_visible(visible: bool) -> None:
    hwnd = _console_window()
    if hwnd:
        _user32().ShowWindow(hwnd, SW_SHOW if visible else SW_HIDE)


def _any_profile_app_hwnds() -> tuple[list[int], list[int]]:
    """두 브라우저의 전용 프로필에서 (MV Hub 창, 그 외 프로필 창)을 모은다.
    조회 실패한 브라우저는 건너뛴다 — 그쪽은 판단 불가이므로 오폭하지 않는다."""
    app: list[int] = []
    other: list[int] = []
    for name, exe_basename in (("edge", "msedge.exe"), ("chrome", "chrome.exe")):
        got = _profile_pids(exe_basename, _app_profile_dir(name), verify_exe=False)
        if got is None:
            continue
        _roots, all_pids = got
        found_app, found_other = _classify_app_hwnds(all_pids)
        app.extend(found_app)
        other.extend(found_other)
    return app, other


def _focus_app_window() -> bool:
    """이미 떠 있는 MV Hub 앱 창을 앞으로 — 중복 실행 시 두 번째 런처가 호출."""
    app, other = _any_profile_app_hwnds()
    for hwnd in app + other:
        _user32().SetForegroundWindow(hwnd)
        return True
    return False


def close_app_windows() -> int:
    """MV Hub 로 승인된 창 전부에 WM_CLOSE 전송 — 앱 안의 '종료' 확인 후 백엔드가 호출.
    창이 닫히면 감시자가 평소의 정상 종료 절차(Job 정리 → 허브·에이전트 정지)를 밟는다.
    비승인 프로필 창(DevTools 등)은 건드리지 않고, 승인 창이 하나도 없으면 모호하므로
    닫지 않고 실패를 반환한다(오폭 방지, 코덱스 합의)."""
    WM_CLOSE = 0x0010
    user32 = _user32()
    app, other = _any_profile_app_hwnds()
    if not app:
        print(f"[close-app] no approved MV Hub window ({len(other)} other profile window(s) untouched)")
        return 1
    sent = [hwnd for hwnd in app if user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)]
    print(f"[close-app] WM_CLOSE sent to {len(sent)}/{len(app)} window(s)")
    # PostMessageW 성공은 '큐에 넣음'일 뿐 닫힘 보장이 아니다(브라우저가 확인창 등으로
    # 무시 가능) → 실제 소멸을 IsWindow 로 최대 8초 확인. 안 닫히면 실패(exit 1)로
    # 돌려 백엔드가 409 → UI 의 "종료 중…" 고정을 막는다. (재열거 없이 HWND 만 확인 —
    # CIM 재조회는 최악 수십 초라 백엔드 45초 예산을 위협한다)
    deadline = time.monotonic() + 8.0
    remaining = list(app)  # 전송 실패 창도 포함해 승인 창 전체의 소멸을 확인해야 성공이다
    while remaining and time.monotonic() < deadline:
        time.sleep(0.4)
        remaining = [h for h in remaining if user32.IsWindow(h) and user32.IsWindowVisible(h)]
    if remaining:
        print(f"[close-app] {len(remaining)} window(s) did not close")
    return 0 if sent and not remaining else 1


def acquire_launcher_mutex(port: str) -> bool:
    """포트+설치별 단일 실행 mutex — 두 번째 실행이 허브 포트를 뺏는 사고 방지.
    True=획득(계속 진행), False=이미 실행 중.
    ★use_last_error=True 필수 — ctypes.windll 은 GetLastError 를 보존하지 않아
    ERROR_ALREADY_EXISTS 감지가 조용히 무력화된다(실측으로 잡은 버그)."""
    global _launcher_mutex_handle
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    name = f"Local\\MVHub_Launcher_{port}_{_install_id()}"
    handle = kernel32.CreateMutexW(None, True, name)
    if not handle:
        return True  # mutex 를 못 만들 정도면 차단보다 진행이 낫다(종전 동작)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return False
    _launcher_mutex_handle = handle  # 프로세스 종료 시 자동 해제
    return True


class _WatchState:
    """앱 창 감시 상태 머신(순수 로직) — Win32 호출 없이 단위 테스트 가능하게 분리.

    승인은 스티키: 한 번 MV Hub 로 승인된 HWND 는 제목이 바뀌어도(업데이트 중 오류
    페이지 등) 창이 사라질 때까지 앵커다. 비승인(provisional) 창은 앵커도, 정상 종료
    판정 대상도 아니다. CIM 조회 실패는 종료 카운터에 반영하지 않는다(코덱스 합의)."""

    CIM_FAIL_SHOW_CONSOLE_AFTER = 30.0  # 초 — 이만큼 조회가 계속 실패하면 콘솔을 되살린다

    def __init__(self, now: float):
        self.approved: set[int] = set()
        self.approved_ever = False
        self.empty_scans = 0
        self.fail_since: float | None = None
        self.start = now

    def observe(self, newly_app: set[int], query_ok: bool, now: float, is_alive) -> str:
        """한 틱 관찰 → 행동: anchored(승인 창 존재) / waiting(첫 승인 대기) /
        fallback(첫 창 시한 초과) / hold(조회 실패 — 판정 유보) / hold_show_console
        (조회 장기 실패 — 사용자 제어권 회복) / empty(빈 스캔) / closed(종료 확정)."""
        self.approved = {h for h in self.approved if is_alive(h)} | set(newly_app)
        if self.approved:
            self.approved_ever = True
            self.empty_scans = 0
            self.fail_since = None
            return "anchored"
        if not self.approved_ever:
            return "fallback" if now - self.start > _APP_FIRST_WINDOW_TIMEOUT else "waiting"
        if not query_ok:
            if self.fail_since is None:
                self.fail_since = now
            if now - self.fail_since > self.CIM_FAIL_SHOW_CONSOLE_AFTER:
                return "hold_show_console"
            return "hold"
        self.fail_since = None
        self.empty_scans += 1
        return "closed" if self.empty_scans >= _APP_CLOSE_DEBOUNCE_SCANS else "empty"


def _hwnd_alive(hwnd: int) -> bool:
    user32 = _user32()
    return bool(user32.IsWindow(hwnd)) and bool(user32.IsWindowVisible(hwnd))


def watch_app_window(url: str) -> int:
    """앱 창을 띄우고(있으면 입양) 승인된 MV Hub 창이 전부 닫힐 때까지 대기.
    승인 창 확인 후 (전용 콘솔일 때만) 콘솔을 숨기고, 비정상 종료 전엔 반드시 되살린다."""
    browser = _find_app_browser()
    if not browser:
        return APP_EXIT_NO_BROWSER
    name, exe = browser
    profile = _app_profile_dir(name)

    got = _profile_pids(exe, profile)
    if got is None:
        # 조회 실패 — 창을 띄우기 '전'에 앱창 모드를 포기해야 고아 창이 안 생긴다.
        return APP_EXIT_NO_WINDOW
    _roots, all_pids = got
    known_pids: set[int] = set(all_pids)  # CIM 실패 시 보조 탐색용 '마지막으로 안 pid'
    app, _other = _classify_app_hwnds(all_pids)
    spawn_proc: subprocess.Popen | None = None
    if not app:
        # MV Hub 창 없음 — 루트·비승인 창(DevTools 등)이 남아 있어도 --app 으로 새 창을 연다.
        spawn_proc = _spawn_app_window(exe, profile, url)

    state = _WatchState(time.monotonic())
    hid_console = False
    try:
        while True:
            time.sleep(0.7 if not state.approved_ever else 1.0)
            aux = set(known_pids)
            if spawn_proc is not None and spawn_proc.poll() is None:
                aux.add(spawn_proc.pid)
            app, _other = _classify_app_hwnds(aux)  # EnumWindows — 싼 경로(CIM 없음)
            query_ok = True
            if not app and not any(_hwnd_alive(h) for h in state.approved):
                # 창이 안 보임 — pid 집합이 낡았을 수 있으니(창이 새 루트로 열림) CIM 재조회.
                got = _profile_pids(exe, profile)
                if got is None:
                    query_ok = False  # 조회 실패 ≠ 창 없음 — 종료 판정을 유보한다
                else:
                    _roots, pids_now = got
                    if pids_now:
                        known_pids = set(pids_now)
                    app, _other = _classify_app_hwnds(set(pids_now) | (
                        {spawn_proc.pid} if spawn_proc is not None and spawn_proc.poll() is None else set()
                    ))
            action = state.observe(set(app), query_ok, time.monotonic(), _hwnd_alive)
            if action == "anchored":
                if not hid_console and _console_is_ours():
                    # 조회 회복 + 승인 창 존재가 함께 확인된 때만 (재)숨김
                    _set_console_visible(False)
                    hid_console = True
            elif action == "hold_show_console":
                if hid_console:
                    _set_console_visible(True)  # 장기 조회 실패 — 사용자 제어권 회복
                    hid_console = False
            elif action == "closed":
                return 0  # 승인 창 전부 닫힘 확정 → bat 종료 → Job 정리
            elif action == "fallback":
                return APP_EXIT_NO_WINDOW
            # waiting / hold / empty → 다음 틱
    except BaseException:
        if hid_console:
            _set_console_visible(True)
        raise


def open_browser_detached(url: str) -> None:
    """Open an HTTP(S) URL outside the agent cleanup Job Object.

    The guarded launcher intentionally owns the local hub, Vite and generation
    agent so closing its CMD window stops those services.  A browser is user UI,
    not a local service: launching its protocol handler with BREAKAWAY keeps the
    browser window/tab alive when that cleanup job closes.
    """
    parsed = urlsplit(str(url or "").strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("browser URL must be an absolute HTTP(S) URL")
    if os.name != "nt":
        raise OSError("detached browser launch is Windows-only")

    rundll32 = str(Path(os.environ["SystemRoot"]) / "System32" / "rundll32.exe")
    subprocess.Popen(  # noqa: S603 - fixed Windows protocol handler + validated URL
        [rundll32, "url.dll,FileProtocolHandler", parsed.geturl()],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
    )


def run_guarded(script: Path) -> int:
    if os.name != "nt":
        raise OSError("MV Hub agent session guard is Windows-only")
    script = script.resolve()
    if not script.is_file():
        raise FileNotFoundError(script)

    kernel32 = _configure_api()
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = PROCESS_INFORMATION()
    old_guard = os.environ.get("MVHUB_SESSION_GUARDED")
    os.environ["MVHUB_SESSION_GUARDED"] = "1"
    try:
        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        # 평소 하위 프로세스는 전부 Job에 남겨 창을 닫을 때 정리한다. 단, 명시적으로
        # CREATE_BREAKAWAY_FROM_JOB을 요청한 검증된 업데이트 부트스트랩만 빠져나가 기존
        # 런처를 종료한 뒤 새 버전을 설치·재실행할 수 있게 한다.
        limits.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        )
        if not kernel32.SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            raise ctypes.WinError(ctypes.get_last_error())

        info = _create_suspended_process(kernel32, script)
        if not kernel32.AssignProcessToJobObject(job, info.hProcess):
            error = ctypes.get_last_error()
            kernel32.TerminateProcess(info.hProcess, 1)
            raise OSError(error, "could not assign the agent process tree to its cleanup job")
        if kernel32.ResumeThread(info.hThread) == 0xFFFFFFFF:
            error = ctypes.get_last_error()
            kernel32.TerminateProcess(info.hProcess, 1)
            raise OSError(error, "could not start the guarded agent process")

        kernel32.WaitForSingleObject(info.hProcess, INFINITE)
        exit_code = wintypes.DWORD(1)
        if not kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(exit_code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(exit_code.value) if exit_code.value <= 255 else 1
    finally:
        if old_guard is None:
            os.environ.pop("MVHUB_SESSION_GUARDED", None)
        else:
            os.environ["MVHUB_SESSION_GUARDED"] = old_guard
        # This is the cleanup action: closing the last job handle terminates any
        # hub, Vite, CLI, or agent descendant still alive.
        if job:
            kernel32.CloseHandle(job)
        if info.hThread:
            kernel32.CloseHandle(info.hThread)
        if info.hProcess:
            kernel32.CloseHandle(info.hProcess)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MV Hub agent process-tree guard")
    parser.add_argument("script", nargs="?", type=Path)
    parser.add_argument("--open-url", default="")
    parser.add_argument("--app-probe", action="store_true")
    parser.add_argument("--app-window", default="")
    parser.add_argument("--close-app-window", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.close_app_window:
            return close_app_windows()
        if args.app_probe:
            # 앱 창 모드 가능? — Edge/Chrome 존재 판정만(빠름). 0=가능 / 3=불가.
            return 0 if _find_app_browser() else APP_EXIT_NO_BROWSER
        if args.app_window:
            parsed = urlsplit(args.app_window.strip())
            if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
                raise ValueError("app window URL must be an absolute HTTP(S) URL")
            return watch_app_window(parsed.geturl())
        if args.open_url:
            if args.script is not None:
                parser.error("script and --open-url cannot be used together")
            open_browser_detached(args.open_url)
            return 0
        if args.script is None:
            parser.error("script is required unless --open-url is used")
        script = args.script.resolve()
        # 단일 실행 — 같은 포트·설치의 런처가 이미 살아 있으면 허브 포트를 뺏지 않고
        # 기존 앱 창만 앞으로 올린 뒤 조용히 끝낸다(코덱스 검토: split-ownership 방지).
        port = os.environ.get("CONTENT_HUB_PORT", "8010")
        if not acquire_launcher_mutex(port):
            if _focus_app_window():
                # 창이 실제로 있음 = 진짜 중복 실행 — 그 창만 앞으로 올리고 끝.
                print("[info] MV Hub is already running - switched to the existing window.")
                return 0
            # 창은 없는데 mutex 만 잡혀 있음 = 직전 세션이 종료 정리 중(창 닫힘 debounce +
            # Job 정리, 수 초). 바로 에러 내지 말고 정리가 끝나길 기다렸다 이어서 실행한다.
            print("[info] Waiting for the previous MV Hub session to finish closing...")
            deadline = time.time() + 20.0
            while time.time() < deadline:
                time.sleep(1.0)
                if acquire_launcher_mutex(port):
                    break
            else:
                print(
                    "[ERROR] Another MV Hub session is still running but no window was "
                    "found. Close it (Task Manager: python/cmd under MV Hub) and retry."
                )
                return 1
        _close_stale_launcher_shells(script)
        return run_guarded(script)
    except (OSError, ValueError) as exc:
        print(f"[ERROR] Agent session guard failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
