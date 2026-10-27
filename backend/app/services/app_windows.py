"""앱 창이 연 별도 창(Assets·관리 — window.open)을 앱 창 위로 올린다 — 초점은 앱 창에 그대로(윈도우 전용).

기록 docs/status/별도창_앞으로_2026-10-26.md. 웹은 초점 없이 다른 창을 올리지 못해(opener 의 창.focus() 도 누름이 없으면 아무 일 없음 — 0단계 실측)
로컬 허브가 한다. 찾기 = 맨 앞 창(방금 focus 받은 앱 창 — 제목이 앱 창 제목)과 같은 프로세스의, 제목이 별도 창 제목인 보이는 최상위 창.
올리기 = TOPMOST 로 올렸다가 바로 NOTOPMOST — 다른 프로세스의 HWND_TOP 은 맨 앞 창 바로 밑에 놓여 앱 창에 가려진다(실측).
"""

from __future__ import annotations

import ctypes
from typing import Any, Optional

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
# NOSIZE · NOMOVE · NOACTIVATE · ASYNCWINDOWPOS(크롬 창 스레드가 바빠도 허브가 기다리지 않는다)
SWP_LIFT = 0x0001 | 0x0002 | 0x0010 | 0x4000

Window = tuple[int, int, str]  # (hwnd, pid, 제목)


def title_matches(text: str, title: str) -> bool:
    return text == title or text.startswith(title + " - ")  # 일반 크롬 창은 제목 뒤에 " - Chrome" 을 붙인다(앱 창·그 팝업은 안 붙임)


def pick(windows: list[Window], foreground: int, main: str, titles: list[str]) -> list[int]:
    """windows = 보이고 최소화 안 된 최상위 창(위 → 아래). 올릴 창(위 → 아래) — 맨 앞 창이 앱 창이 아니면 없다(그새 다른 데로 갔다)."""
    top = next((w for w in windows if w[0] == foreground), None)
    if top is None or not title_matches(top[2], main):
        return []
    return [hwnd for hwnd, pid, text in windows if hwnd != foreground and pid == top[1] and any(title_matches(text, t) for t in titles)]


class Win32:
    def __init__(self) -> None:
        from ctypes import wintypes as W

        self.W = W
        u = self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        u.EnumWindows.argtypes = [self.WNDENUMPROC, W.LPARAM]
        u.IsWindowVisible.argtypes = [W.HWND]
        u.IsIconic.argtypes = [W.HWND]
        u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
        u.GetWindowThreadProcessId.restype = W.DWORD
        u.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
        u.GetForegroundWindow.restype = W.HWND
        u.SetWindowPos.argtypes = [W.HWND, W.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, W.UINT]
        u.SetWindowPos.restype = W.BOOL

    def windows(self) -> list[Window]:
        found: list[Window] = []

        def each(hwnd, _):
            if self.user32.IsWindowVisible(hwnd) and not self.user32.IsIconic(hwnd):
                owner = self.W.DWORD()
                self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                title = ctypes.create_unicode_buffer(256)
                self.user32.GetWindowTextW(hwnd, title, 256)
                found.append((int(hwnd), int(owner.value), title.value))
            return True

        self.user32.EnumWindows(self.WNDENUMPROC(each), 0)
        return found

    def foreground(self) -> int:
        return int(self.user32.GetForegroundWindow() or 0)

    def lift(self, hwnd: int) -> None:
        for after in (HWND_TOPMOST, HWND_NOTOPMOST):
            self.user32.SetWindowPos(hwnd, self.W.HWND(after), 0, 0, 0, 0, SWP_LIFT)


_api: Optional[Win32] = None


def raise_over_foreground(main: str, titles: list[str], api: Any = None) -> int:
    """올린 창 수. 아래 것부터 올려 별도 창끼리의 앞뒤는 그대로 둔다."""
    global _api
    if api is None:
        _api = _api or Win32()
        api = _api
    hits = pick(api.windows(), api.foreground(), main, titles)
    for hwnd in reversed(hits):
        api.lift(hwnd)
    return len(hits)
