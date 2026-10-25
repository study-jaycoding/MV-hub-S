"""자기 자신을 넣는 Windows Job Object — 실행기·이사 감싸개가 죽으면 그 자식·손자도 함께 끝나게(설계 3~5판).

넣은 뒤에 띄운 자식은 만들어질 때부터 같은 Job 이라 편입 사이 틈이 없다. BREAKAWAY 는 허용하지 않는다.
핸들은 비상속이고 일부러 닫지 않는다 — 프로세스가 끝날 때 OS 가 닫으며 남은 것을 끝낸다. 시간 초과 정리는
핸들을 닫지 않고 kill_others() 로(닫으면 자신도 끝나 결과를 못 남긴다).
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import threading
import time
from ctypes import wintypes
from typing import Callable

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateJobObjectW.restype = wintypes.HANDLE
_k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
_k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
_k32.QueryInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                           ctypes.c_void_p)
_k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
_k32.IsProcessInJob.argtypes = (wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL))
_k32.GetCurrentProcess.restype = wintypes.HANDLE
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_k32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
_k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
_k32.CloseHandle.argtypes = (wintypes.HANDLE,)

_KILL_ON_JOB_CLOSE = 0x2000
_EXTENDED_LIMIT = 9
_PROCESS_ID_LIST = 3
_TERMINATE = 0x0001
_SYNCHRONIZE = 0x00100000
_QUERY_LIMITED = 0x1000
_ERROR_MORE_DATA = 234
REAP_SECONDS = 30.0


class JobError(RuntimeError):
    pass


class _Basic(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class _Extended(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _Basic), ("IoInfo", ctypes.c_ulonglong * 6),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class SelfJob:
    """이 프로세스를 KILL_ON_JOB_CLOSE Job 에 넣는다. 실패하면 JobError — 부르는 쪽은 그 작업을 시작하지 않는다."""

    def __init__(self) -> None:
        handle = _k32.CreateJobObjectW(None, None)
        if not handle:
            raise JobError(f"작업 묶음(Job)을 만들지 못했습니다(오류 {ctypes.get_last_error()})")
        info = _Extended()
        info.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
        if not _k32.SetInformationJobObject(handle, _EXTENDED_LIMIT, ctypes.byref(info), ctypes.sizeof(info)):
            raise JobError(f"작업 묶음을 설정하지 못했습니다(오류 {ctypes.get_last_error()})")
        if not _k32.AssignProcessToJobObject(handle, _k32.GetCurrentProcess()):
            raise JobError(f"이 프로세스를 작업 묶음에 넣지 못했습니다(오류 {ctypes.get_last_error()})")
        self.handle = handle

    def members(self) -> list[int] | None:
        """Job 안 PID 전부. 목록이 잘리면 버퍼를 늘려 다시 — 끝내 다 못 받으면 None."""
        size = 64
        for _ in range(8):
            # JOBOBJECT_BASIC_PROCESS_ID_LIST: DWORD 둘(= size_t 한 칸) 다음에 ULONG_PTR 목록
            buffer = (ctypes.c_size_t * (size + 1))()
            if not _k32.QueryInformationJobObject(self.handle, _PROCESS_ID_LIST, buffer, ctypes.sizeof(buffer), None) \
                    and ctypes.get_last_error() != _ERROR_MORE_DATA:
                return None
            header = ctypes.cast(buffer, ctypes.POINTER(wintypes.DWORD))
            assigned, listed = int(header[0]), int(header[1])
            if assigned <= listed:
                return [int(buffer[1 + i]) for i in range(listed)]
            size = assigned * 2
        return None

    def kill_others(self, timeout: float = REAP_SECONDS) -> bool:
        """자기를 뺀 Job 안 프로세스를 끝내고 자기만 남았는지 확인한다. PID 재사용에 대비해 연 핸들이 이 Job 소속일 때만
        같은 핸들로 끝내고 기다린다. 상한 안에 확인 못 하면 False('자손 회수 미확인')."""
        me = os.getpid()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pids = self.members()
            if pids is None:
                return False
            others = [pid for pid in pids if pid != me]
            if not others:
                return True
            for pid in others:
                handle = _k32.OpenProcess(_TERMINATE | _SYNCHRONIZE | _QUERY_LIMITED, False, pid)
                if not handle:
                    continue  # 이미 끝났으면 다음 조회에서 빠진다 — 아니면 상한까지 남아 False
                try:
                    inside = wintypes.BOOL()
                    if _k32.IsProcessInJob(handle, self.handle, ctypes.byref(inside)) and inside.value:
                        _k32.TerminateProcess(handle, 1)
                        _k32.WaitForSingleObject(handle, 2000)
                finally:
                    _k32.CloseHandle(handle)
            time.sleep(0.1)
        return False


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")  # cmd·bat 은 콘솔 코드 페이지로 쓴다


def run_streamed(job: SelfJob, argv: list[str], cwd: str, env: dict[str, str], say: Callable[[str], None],
                 timeout: float) -> tuple[int | None, bool]:
    """job 안에서 자식을 돌리며 출력을 한 줄씩 say 로 흘린다. (종료 코드 또는 시간 초과 None, 자손 회수 확인).
    시간 초과면 Job 을 닫지 않고 자기를 뺀 전부를 끝낸다. 정상 종료여도 남은 손자(격리 서버 등)를 회수해 확인한다."""
    child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, creationflags=0x08000000)  # CREATE_NO_WINDOW

    def pump() -> None:
        for raw in child.stdout:
            say(_decode(raw.rstrip(b"\r\n")))
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        code: int | None = child.wait(timeout)
    except subprocess.TimeoutExpired:
        code = None
        say(f"제한 시간({int(timeout // 60)}분)을 넘겨 멈춥니다")
    reaped = job.kill_others()
    reader.join(5)
    return code, reaped
