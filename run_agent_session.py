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
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path


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
    parser.add_argument("script", type=Path)
    args = parser.parse_args(argv)
    try:
        script = args.script.resolve()
        _close_stale_launcher_shells(script)
        return run_guarded(script)
    except (OSError, ValueError) as exc:
        print(f"[ERROR] Agent session guard failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
