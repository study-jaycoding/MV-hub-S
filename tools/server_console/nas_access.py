"""릴리스 도우미에서만 같은 Windows 사용자의 기존 NAS 연결을 재사용한다."""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
from ctypes import wintypes as wt
import os


class NasAccessError(RuntimeError):
    pass


def _probe(source: str) -> None:
    with os.scandir(source) as entries:
        next(entries, None)


def is_unc(source: str) -> bool:
    return os.name == "nt" and source.startswith("\\\\") and not source.startswith(("\\\\?\\", "\\\\.\\"))


class _Tokens:
    """암호를 읽거나 새 로그인을 만들지 않고 같은 사용자의 탐색기 토큰을 연다."""

    def __init__(self):
        self.adv = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel.GetCurrentProcess.restype = wt.HANDLE
        self.kernel.GetCurrentThread.restype = wt.HANDLE
        self.kernel.CloseHandle.argtypes = [wt.HANDLE]
        self.kernel.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        self.kernel.OpenProcess.restype = wt.HANDLE
        self.user.GetShellWindow.restype = wt.HWND
        self.user.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
        self.adv.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
        self.adv.OpenThreadToken.argtypes = [wt.HANDLE, wt.DWORD, wt.BOOL, ctypes.POINTER(wt.HANDLE)]
        self.adv.GetTokenInformation.argtypes = [wt.HANDLE, ctypes.c_int, wt.LPVOID, wt.DWORD,
                                                ctypes.POINTER(wt.DWORD)]
        self.adv.EqualSid.argtypes = [wt.LPVOID, wt.LPVOID]
        self.adv.ImpersonateLoggedOnUser.argtypes = [wt.HANDLE]
        self.adv.RevertToSelf.argtypes = []

    def current(self):
        token = wt.HANDLE()
        if self.adv.OpenThreadToken(self.kernel.GetCurrentThread(), 0x0008, True, ctypes.byref(token)):
            self.close(token)
            raise NasAccessError("이미 다른 실행 신원을 사용 중이어서 NAS 연결을 전환하지 않았습니다")
        if ctypes.get_last_error() != 1008:  # ERROR_NO_TOKEN
            raise ctypes.WinError(ctypes.get_last_error())
        if not self.adv.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        return token

    def info(self, token, kind: int):
        size = wt.DWORD()
        self.adv.GetTokenInformation(token, kind, None, 0, ctypes.byref(size))
        if not size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        data = ctypes.create_string_buffer(size.value)
        if not self.adv.GetTokenInformation(token, kind, data, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        return data

    def number(self, token, kind: int) -> int:
        return wt.DWORD.from_buffer(self.info(token, kind)).value

    def desktop(self):
        window = self.user.GetShellWindow()
        pid = wt.DWORD()
        if not window or not self.user.GetWindowThreadProcessId(window, ctypes.byref(pid)):
            raise NasAccessError("로그인한 사용자의 Windows 탐색기를 찾지 못했습니다")
        process = self.kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not process:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            token = wt.HANDLE()
            if not self.adv.OpenProcessToken(process, 0x000A, ctypes.byref(token)):  # QUERY | DUPLICATE
                raise ctypes.WinError(ctypes.get_last_error())
            return token
        finally:
            self.kernel.CloseHandle(process)

    def same_user(self, left, right) -> bool:
        # TOKEN_USER 맨 앞 SID 포인터로 같은 Windows 사용자인지 비교한다.
        a, b = self.info(left, 1), self.info(right, 1)
        return bool(self.adv.EqualSid(wt.LPVOID.from_buffer(a), wt.LPVOID.from_buffer(b)))

    def enter(self, token) -> None:
        if not self.adv.ImpersonateLoggedOnUser(token):
            raise ctypes.WinError(ctypes.get_last_error())

    def leave(self) -> None:
        if not self.adv.RevertToSelf():
            # 자식 도우미만 종료한다. 신원이 불명확한 채 다음 작업을 하지 않는다.
            os._exit(72)

    def close(self, token) -> None:
        self.kernel.CloseHandle(token)


def allow_source_read(root) -> None:
    """생성자가 방금 만든 임시폴더·설정만 처리한다. 기존 jobs 폴더에는 손대지 않는다."""
    api = _Tokens()
    api.kernel.LocalFree.argtypes = [wt.LPVOID]
    api.kernel.LocalFree.restype = wt.LPVOID
    api.adv.ConvertSidToStringSidW.argtypes = [wt.LPVOID, ctypes.POINTER(wt.LPWSTR)]
    api.adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wt.LPCWSTR, wt.DWORD, ctypes.POINTER(wt.LPVOID), wt.LPVOID]
    api.adv.SetFileSecurityW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.LPVOID]
    current = api.current()
    sid_text = wt.LPWSTR()
    try:
        user = api.info(current, 1)
        if not api.adv.ConvertSidToStringSidW(wt.LPVOID.from_buffer(user), ctypes.byref(sid_text)):
            raise ctypes.WinError(ctypes.get_last_error())
        for path, access in ((root, "GRGX"), (root / "INSTALL_SOURCE.txt", "GR")):
            descriptor = wt.LPVOID()
            # 관리자 소유로 고정해 일반 토큰이 소유자의 권한으로 DACL을 바꾸지 못하게 한다.
            sddl = f"O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;{access};;;{sid_text.value})"
            if not api.adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                if not api.adv.SetFileSecurityW(str(path), 0x80000005, descriptor):  # owner + protected DACL
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                api.kernel.LocalFree(descriptor)
    finally:
        if sid_text:
            api.kernel.LocalFree(ctypes.cast(sid_text, wt.LPVOID))
        api.close(current)


@contextmanager
def _existing_user(tokens=None):
    api = tokens or _Tokens()
    current = desktop = None
    try:
        current = api.current()
        if api.number(current, 18) != 2:  # TokenElevationTypeFull
            raise NasAccessError("이 실행 계정에는 재사용할 일반 사용자 연결이 없습니다")
        desktop = api.desktop()
        if (api.number(desktop, 8) != 1 or api.number(desktop, 18) != 3 or not api.same_user(current, desktop)
                or api.number(current, 12) != api.number(desktop, 12)):
            raise NasAccessError("같은 Windows 사용자의 연결임을 확인하지 못했습니다")
        api.enter(desktop)
        try:
            yield
        finally:
            api.leave()
    finally:
        if desktop is not None:
            api.close(desktop)
        if current is not None:
            api.close(current)


@contextmanager
def connected(source: str):
    """쓰기 전 읽기 확인에서만 신원을 고르고, 작업 도중에는 전환·재시도하지 않는다."""
    if not is_unc(source):
        yield "current"
        return
    try:
        _probe(source)
    except OSError as exc:
        if getattr(exc, "winerror", None) not in (5, 86, 1326, 1219):
            raise NasAccessError(f"NAS 폴더를 읽지 못했습니다(Windows 오류 {getattr(exc, 'winerror', None)})") from exc
    else:
        yield "current"
        return
    try:
        with _existing_user():
            try:
                _probe(source)
            except OSError as exc:
                raise NasAccessError("기존 Windows 연결로도 NAS 폴더를 읽지 못했습니다"
                                     f"(Windows 오류 {getattr(exc, 'winerror', None)})") from exc
            yield "existing_windows_connection"
    except OSError as exc:
        raise NasAccessError("현재 Windows 사용자의 연결로 NAS 작업을 마치지 못했습니다"
                             f"(Windows 오류 {getattr(exc, 'winerror', None)})") from exc
