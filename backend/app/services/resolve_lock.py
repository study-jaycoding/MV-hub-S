"""Resolve 연동의 기기 잠금 경로·PC 식별자·프로세스 생성시각 헬퍼.

큐 v3 의 byte-range 락(``FileLock``)·생존 판정·강제 종료는 허브 쪽 호출자가 없어 2026-08-27 정리에서 제거했다
(Resolve 메뉴 Importer ``MVHub_Importer.py`` 는 자체 구현으로 같은 락 파일을 잡는다). 남은 것은
``machine_lock_path``(``GET /api/resolve/locks`` 가 Importer 에 알려 주는 기기 락 파일 경로), ``host_id``,
``process_started_at_filetime``(자식 워커의 attempt journal 기록용)이다.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from ..config import DATA_DIR
from .atomic_io import atomic_write_text


if os.name == "nt":  # pragma: no cover - 플랫폼 분기(운영 경로는 Windows)
    import ctypes
    from ctypes import wintypes


    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # 64비트에서 HANDLE 을 int 로 잘라 쓰면 잘못된 핸들이 되므로 반드시 선언한다.
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.GetProcessTimes.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    )
    _kernel32.GetProcessTimes.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.CloseHandle.restype = wintypes.BOOL


    def process_started_at_filetime(pid: int | None = None) -> str:
        """현재(또는 지정) 프로세스의 생성 시각 FILETIME 문자열."""
        target = os.getpid() if pid is None else pid
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, target)
        if not handle:
            return ""
        try:
            creation = wintypes.FILETIME()
            exit_time = wintypes.FILETIME()
            kernel_time = wintypes.FILETIME()
            user_time = wintypes.FILETIME()
            if not _kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exit_time),
                ctypes.byref(kernel_time),
                ctypes.byref(user_time),
            ):
                return ""
            return str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
        finally:
            _kernel32.CloseHandle(handle)

else:  # pragma: no cover - 개발용 POSIX 분기(운영 워커는 Windows 전용)


    def process_started_at_filetime(pid: int | None = None) -> str:
        return ""


def _resolve_root() -> Path:
    return DATA_DIR / "resolve"


def machine_lock_path() -> Path:
    return _resolve_root() / "locks" / "machine-import.lock"


_host_id_cache: dict[str, str] = {}


def host_id() -> str:
    """PC 식별자. 다른 PC 소유 claim 을 훔치지 않기 위한 판단 근거(명세 §2.7).

    프로세스 수명 동안 바뀌지 않으므로 한 번만 읽는다(claim 마다 파일 I/O 하지 않는다).
    """
    path = _resolve_root() / "host-id"
    cached = _host_id_cache.get(str(path))
    if cached:
        return cached
    try:
        current = path.read_text(encoding="utf-8").strip()
    except OSError:
        current = ""
    if not current:
        current = uuid.uuid4().hex
        try:
            atomic_write_text(path, current + "\n")
            current = path.read_text(encoding="utf-8").strip() or current
        except OSError:
            return current
    _host_id_cache[str(path)] = current
    return current
