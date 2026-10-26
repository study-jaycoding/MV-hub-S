"""클린 피드 전용 창(윈도우 전용) — 로컬 허브가 전용 프로필의 키오스크 크롬을 고른 모니터에 띄우고, 앱(또는 피드 창)이 맨 앞일 때만
TOPMOST 로 보이고 아니면 숨긴다(닫지 않는다 — 돌아올 때 지연·클릭 없음).

설계 docs/status/편집탭_클린피드_전용창_설계_2026-10-23.md(3차 + 0단계 실측 보정) · 계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md.
- 창 제어·폴링은 이 모듈의 **전용 스레드 하나**(per-monitor DPI v2)에서만 한다 — 이벤트 루프를 막지 않는다. Win32 호출은 `Win32` 한 곳(시험은 가짜로 바꾼다).
- 크롬 찾기는 런처(run_agent_session._find_app_browser)와 같은 규칙을 여기 따로 둔다 — 런처는 저장소 루트라 staged 업데이트로 바뀌지 않는다
  (합치면 안 되는 중복, docs/CODE_MAP.md §5).
- '프로필 사용 중' = 그 프로필의 `lockfile` 을 지울 수 없음(공유 위반 — 크롬이 FILE_SHARE_READ·DELETE_ON_CLOSE 로 쥔다). 있기만 한 낡은 파일(정전 등)은 지우고
  계속한다(크롬도 덮어쓴다). 쥔 것은 끄지 않고 거절. 계약 7판 ①.
- 닫기·강제 종료는 '끝났다'(WAIT_OBJECT_0)를 본 뒤에 놓는다. 시한 안에 안 끝나면 핸들을 쥔 채 정리 실패로 남기고 끝날 때까지 다음 open 을 거절(폴링이 풀어 준다) — 7판 ②.
- 켜기 단축(docs/status/편집탭_클린피드_허브켜기단축_2026-10-26.md): 창 하나의 세 상태 — **창 탐색 중**(띄웠지만 그 세션의 제목 창을 아직 못 찾음 — open 은
  여기까지만 기다린다, 허브가 등록한 뒤 arm 하면 폴링이 찾고 맞춘다) · **세션 창**(보임/숨김 규칙 대상) · **대기 창**(세션이 끝나 숨겨 둔 창 — 다음 open 이 release id 로
  다시 쓴다, 10분 안 쓰이면 끝냄). 명령·사건은 세션 id·release id 와 지금 상태를 함께 본다.
"""

from __future__ import annotations

import ctypes
import hashlib
import logging
import os
import queue
import subprocess
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .. import config

log = logging.getLogger(__name__)

TITLE_PREFIX = "MV hub Clean Feed "  # 피드 화면(CleanFeedApp)이 document.title 로 두는 제목 + 세션 id
SHOW_FRESH = 2.5  # 앱 active 가 이만큼 안 오면 false 로 본다(초)
HIDE_DELAY = 0.15  # active 가 false 가 되면 이만큼 뒤에 숨긴다 — 앱 → 피드로 초점을 옮기는 사이
TICK = 0.1  # 폴링 간격(초)
PENDING_TICK = 0.02  # 띄운 창을 아직 못 찾은 동안의 폴링 간격 — 찾는 대로 맞추고 초점을 되돌린다
FIND_WINDOW_TIMEOUT = 8.0
STANDBY_TTL = 600.0  # 대기 창(끈 뒤 숨겨 둔 창)을 이만큼 안 쓰면 끝낸다(초)
CLOSE_WAIT_MS = 2000  # WM_CLOSE 뒤 기다림
KILL_WAIT_MS = 2000  # 강제 종료 뒤 끝나기를 기다림(TerminateProcess 는 비동기)
ERROR_SHARING_VIOLATION = 32
MAX_REFITS = 20  # 보이는 동안 창이 모니터 영역에서 어긋나면 다시 맞추는 횟수 상한(크롬과 다투지 않게)

SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
SW_HIDE = 0
WM_CLOSE = 0x0010
CREATE_SUSPENDED = 0x00000004
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x00000102


@dataclass(frozen=True)
class Monitor:
    handle: int
    rect: tuple[int, int, int, int]  # 물리 좌표(left, top, right, bottom)
    primary: bool
    scale: float  # 그 모니터 배율(dpi/96)


@dataclass(frozen=True)
class Screen:
    """앱이 고른 화면(창 관리 API — DIP 자리·크기·그 화면의 devicePixelRatio·주 모니터 여부)."""

    left: float
    top: float
    width: float
    height: float
    dpr: float
    primary: bool


def pick_monitor(monitors: list[Monitor], screen: Screen) -> Optional[Monitor]:
    """고른 화면 = 물리 모니터 하나. 크기(DIP × 그 화면 배율, ±2px)와 주 모니터 여부가 맞는 것 — 둘 이상이면 자리(DIP × 배율 ±2px)로
    가른다(배율 100% 면 DIP 자리 = 물리 자리). 그래도 하나로 안 정해지면 고르지 않는다(None — 앱은 팝업 방식으로)."""
    want_w, want_h = screen.width * screen.dpr, screen.height * screen.dpr
    found = [
        m for m in monitors
        if abs((m.rect[2] - m.rect[0]) - want_w) <= 2 and abs((m.rect[3] - m.rect[1]) - want_h) <= 2 and m.primary == screen.primary
    ]
    if len(found) == 1:
        return found[0]
    placed = [m for m in found if abs(m.rect[0] - screen.left * screen.dpr) <= 2 and abs(m.rect[1] - screen.top * screen.dpr) <= 2]
    return placed[0] if len(placed) == 1 else None


def _install_id() -> str:
    root = str(config.BACKEND_DIR.parent.resolve()).casefold()
    return hashlib.sha1(root.encode("utf-8")).hexdigest()[:10]


def profile_dir(browser: str) -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    return base / "MVHub" / "clean-feed" / f"{browser}-{_install_id()}"


def find_browser() -> Optional[tuple[str, str]]:
    """(이름, exe) — 크롬 먼저(App Paths HKCU → HKLM → Program Files), 없으면 엣지. 윈도우가 아니면 None."""
    if os.name != "nt":
        return None
    import winreg

    def app_path(exe: str) -> Optional[str]:
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
                try:
                    with winreg.OpenKey(hive, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}", 0,
                                        winreg.KEY_READ | view) as key:
                        value, _kind = winreg.QueryValueEx(key, None)
                except OSError:
                    continue
                if value and Path(value).is_file():
                    return str(Path(value))
        return None

    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")

    def first(paths: list[str]) -> Optional[str]:
        return next((str(Path(p)) for p in paths if p and Path(p).is_file()), None)

    chrome = app_path("chrome.exe") or first([
        str(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        str(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe") if local else "",
    ])
    if chrome:
        return "chrome", chrome
    edge = app_path("msedge.exe") or first([
        str(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
        str(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
    ])
    return ("edge", edge) if edge else None


class Win32:
    """창·프로세스·모니터 Win32 호출(ctypes — argtypes/restype 명시). 이 객체의 메서드는 전용 스레드에서만 부른다."""

    def __init__(self) -> None:
        from ctypes import wintypes as W

        self.W = W
        u = self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        k = self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.shcore = ctypes.WinDLL("shcore")
        self.WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        self.MONITORENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HMONITOR, W.HDC, ctypes.POINTER(W.RECT), W.LPARAM)

        class MONITORINFOEXW(ctypes.Structure):
            _fields_ = [("cbSize", W.DWORD), ("rcMonitor", W.RECT), ("rcWork", W.RECT), ("dwFlags", W.DWORD), ("szDevice", W.WCHAR * 32)]

        class STARTUPINFOW(ctypes.Structure):
            _fields_ = [("cb", W.DWORD), ("lpReserved", W.LPWSTR), ("lpDesktop", W.LPWSTR), ("lpTitle", W.LPWSTR), ("dwX", W.DWORD),
                        ("dwY", W.DWORD), ("dwXSize", W.DWORD), ("dwYSize", W.DWORD), ("dwXCountChars", W.DWORD), ("dwYCountChars", W.DWORD),
                        ("dwFillAttribute", W.DWORD), ("dwFlags", W.DWORD), ("wShowWindow", W.WORD), ("cbReserved2", W.WORD),
                        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)), ("hStdInput", W.HANDLE), ("hStdOutput", W.HANDLE), ("hStdError", W.HANDLE)]

        class PROCESS_INFORMATION(ctypes.Structure):
            _fields_ = [("hProcess", W.HANDLE), ("hThread", W.HANDLE), ("dwProcessId", W.DWORD), ("dwThreadId", W.DWORD)]

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", W.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", W.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", W.DWORD), ("SchedulingClass", W.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        self.MONITORINFOEXW, self.STARTUPINFOW, self.PROCESS_INFORMATION, self.EXTENDED = MONITORINFOEXW, STARTUPINFOW, PROCESS_INFORMATION, EXTENDED
        u.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        u.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        u.EnumWindows.argtypes = [self.WNDENUMPROC, W.LPARAM]
        u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
        u.GetWindowThreadProcessId.restype = W.DWORD
        u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
        u.IsWindow.argtypes = [W.HWND]
        u.IsWindow.restype = W.BOOL
        u.SetWindowPos.argtypes = [W.HWND, W.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, W.UINT]
        u.SetWindowPos.restype = W.BOOL
        u.ShowWindow.argtypes = [W.HWND, ctypes.c_int]
        u.ShowWindow.restype = W.BOOL  # 반환은 '전 상태'(실패가 아니다)
        u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
        u.GetWindowRect.restype = W.BOOL
        u.GetForegroundWindow.restype = W.HWND
        u.SetForegroundWindow.argtypes = [W.HWND]
        u.SetForegroundWindow.restype = W.BOOL
        u.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
        u.PostMessageW.restype = W.BOOL
        u.MonitorFromWindow.argtypes = [W.HWND, W.DWORD]
        u.MonitorFromWindow.restype = W.HMONITOR
        u.EnumDisplayMonitors.argtypes = [W.HDC, ctypes.c_void_p, self.MONITORENUMPROC, W.LPARAM]
        u.GetMonitorInfoW.argtypes = [W.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
        self.shcore.GetDpiForMonitor.argtypes = [W.HMONITOR, ctypes.c_int, ctypes.POINTER(W.UINT), ctypes.POINTER(W.UINT)]
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, W.LPCWSTR]
        k.CreateJobObjectW.restype = W.HANDLE
        k.SetInformationJobObject.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
        k.SetInformationJobObject.restype = W.BOOL
        k.AssignProcessToJobObject.argtypes = [W.HANDLE, W.HANDLE]
        k.AssignProcessToJobObject.restype = W.BOOL
        k.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, W.BOOL, W.DWORD, ctypes.c_void_p, W.LPCWSTR,
                                     ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
        k.CreateProcessW.restype = W.BOOL
        k.ResumeThread.argtypes = [W.HANDLE]
        k.ResumeThread.restype = W.DWORD
        k.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
        k.WaitForSingleObject.restype = W.DWORD
        k.TerminateProcess.argtypes = [W.HANDLE, W.UINT]
        k.TerminateProcess.restype = W.BOOL
        k.CloseHandle.argtypes = [W.HANDLE]
        k.CloseHandle.restype = W.BOOL

    def enter_thread(self) -> None:
        self.user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2 — 물리 좌표로 본다

    def monitors(self) -> list[Monitor]:
        W, found = self.W, []

        def each(hmon, _hdc, _rect, _data):
            info = self.MONITORINFOEXW()
            info.cbSize = ctypes.sizeof(info)
            if self.user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
                dx, dy = W.UINT(96), W.UINT(96)
                self.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy))
                r = info.rcMonitor
                found.append(Monitor(int(hmon), (r.left, r.top, r.right, r.bottom), bool(info.dwFlags & 1), (dx.value or 96) / 96))
            return True

        self.user32.EnumDisplayMonitors(None, None, self.MONITORENUMPROC(each), 0)
        return found

    def create_job(self) -> int:
        job = self.kernel32.CreateJobObjectW(None, None)  # 보안 속성 없음 = 핸들 비상속
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW")
        info = self.EXTENDED()
        info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE  # BREAKAWAY 는 허락하지 않는다
        if not self.kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
            error = ctypes.get_last_error()
            self.kernel32.CloseHandle(job)
            raise OSError(error, "SetInformationJobObject")
        return int(job)

    def spawn_in_job(self, argv: list[str], job: int) -> tuple[int, int]:
        """멈춘 채 생성 → Job 배정 → 재개. (pid, 프로세스 핸들). 배정·재개에 실패하면 그 프로세스를 끝내고 OSError —
        끝난 것을 못 보면(배정 실패면 Job 도 못 끝낸다) 핸들을 쥔 채 SpawnLeftover 로 넘긴다(부른 쪽이 정리 실패로 둔다)."""
        startup = self.STARTUPINFOW(cb=ctypes.sizeof(self.STARTUPINFOW))
        info = self.PROCESS_INFORMATION()
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        if not self.kernel32.CreateProcessW(argv[0], command, None, None, False, CREATE_SUSPENDED, None, None,
                                            ctypes.byref(startup), ctypes.byref(info)):
            raise OSError(ctypes.get_last_error(), "CreateProcessW")
        try:
            if not self.kernel32.AssignProcessToJobObject(job, info.hProcess):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject")
            if self.kernel32.ResumeThread(info.hThread) == 0xFFFFFFFF:
                raise OSError(ctypes.get_last_error(), "ResumeThread")
        except OSError as exc:
            self.kernel32.TerminateProcess(info.hProcess, 1)
            if self.kernel32.WaitForSingleObject(info.hProcess, KILL_WAIT_MS) != WAIT_OBJECT_0:
                raise SpawnLeftover(int(info.dwProcessId), int(info.hProcess), str(exc)) from exc
            self.kernel32.CloseHandle(info.hProcess)
            raise
        finally:
            self.kernel32.CloseHandle(info.hThread)
        return int(info.dwProcessId), int(info.hProcess)

    def windows_of(self, pid: int) -> list[tuple[int, str, str]]:
        W, hits = self.W, []

        def each(hwnd, _):
            owner = W.DWORD()
            self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid:
                cls = ctypes.create_unicode_buffer(128)
                title = ctypes.create_unicode_buffer(256)
                self.user32.GetClassNameW(hwnd, cls, 128)
                self.user32.GetWindowTextW(hwnd, title, 256)
                hits.append((int(hwnd), cls.value, title.value))
            return True

        self.user32.EnumWindows(self.WNDENUMPROC(each), 0)
        return hits

    def owner_pid(self, hwnd: int) -> Optional[int]:
        if not self.user32.IsWindow(hwnd):
            return None
        owner = self.W.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        return int(owner.value)

    def show_topmost(self, hwnd: int, rect: tuple[int, int, int, int]) -> bool:
        left, top, right, bottom = rect
        return bool(self.user32.SetWindowPos(hwnd, self.W.HWND(HWND_TOPMOST), left, top, right - left, bottom - top,
                                             SWP_NOACTIVATE | SWP_SHOWWINDOW))

    def hide(self, hwnd: int) -> None:
        self.user32.ShowWindow(hwnd, SW_HIDE)

    def window_rect(self, hwnd: int) -> tuple[int, int, int, int]:
        rect = self.W.RECT()
        self.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect.left, rect.top, rect.right, rect.bottom

    def monitor_of(self, hwnd: int) -> int:
        return int(self.user32.MonitorFromWindow(hwnd, 2) or 0)

    def foreground(self) -> int:
        return int(self.user32.GetForegroundWindow() or 0)

    def set_foreground(self, hwnd: int) -> bool:
        return bool(self.user32.SetForegroundWindow(hwnd))

    def post_close(self, hwnd: int) -> None:
        self.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)

    def alive(self, process: int) -> bool:
        return self.kernel32.WaitForSingleObject(process, 0) == WAIT_TIMEOUT

    def wait_exit(self, process: int, ms: int) -> bool:
        return self.kernel32.WaitForSingleObject(process, ms) == WAIT_OBJECT_0  # WAIT_FAILED 는 끝남이 아니다

    def terminate(self, process: int) -> None:
        self.kernel32.TerminateProcess(process, 1)

    def close_handle(self, handle: int) -> None:
        self.kernel32.CloseHandle(handle)


class SpawnLeftover(OSError):
    """만들었지만 배정·재개에 실패했고, 끝내라고 해도 끝난 것을 못 봤다 — 그 핸들을 쥔 채 넘긴다."""

    def __init__(self, pid: int, process: int, detail: str) -> None:
        super().__init__(detail)
        self.pid, self.process = pid, process


class OpenError(Exception):
    """띄우지 못함 — code 는 앱에 그대로 간다(profile-in-use·profile-check-failed·cleanup-failed·no-monitor·window-not-found·wrong-monitor·spawn-failed)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


@dataclass
class _Feed:
    session: Optional[str]  # None = 대기 창(세션이 끝나 숨겨 둠 — 다음 open 이 다시 쓴다)
    pid: int
    process: int
    hwnd: int  # 0 = 띄웠지만 아직 그 세션의 제목 창을 못 찾음(2단계 — 폴링이 찾는다)
    monitor: Monitor
    visible: bool = True
    hide_at: Optional[float] = None
    refits: int = 0
    browser: tuple[str, str] = ("", "")  # 띄운 브라우저 — 같아야 다시 쓴다
    previous: int = 0  # 띄우기 전 맨 앞 창 — 찾은 뒤 초점을 돌려준다
    deadline: float = 0.0  # 이때까지 못 찾으면 window-not-found
    armed: bool = True  # False = 허브가 아직 세션을 등록 안 함 — 폴링이 이 창을 보지 않는다(사건 없음)
    showable: bool = True  # False = 다시 쓴 창 — 새 피드 ready 전엔 숨긴 채
    release_id: Optional[str] = None  # 대기 창의 release id
    standby_since: Optional[float] = None


@dataclass
class _Active:
    session: Optional[str] = None
    value: bool = False
    at: float = field(default=-1e9)


class FeedWindows:
    """피드 창 하나(허브당)의 수명과 보임/숨김. 모든 Win32 호출은 이 객체의 전용 스레드에서 — 밖에서는 `submit` 으로 일을 맡기고
    Future 를 기다린다. 사건(visible·hidden·closed)은 `listener(kind, session)` 로 그 스레드에서 알린다(받는 쪽이 이벤트 루프로 넘긴다)."""

    def __init__(self, api: Any = None, *, clock: Callable[[], float] = time.monotonic, tick: float = TICK) -> None:
        self._api = api
        self._clock = clock
        self._tick = tick
        self._tasks: "queue.Queue[tuple[Callable[[], Any], Future]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._feed: Optional[_Feed] = None
        self._dying: list[_Feed] = []  # 끝내라고 했지만 아직 안 끝난 것 — 핸들을 쥔 채(정리 실패). 비어야 다음 open
        self._job: Optional[int] = None
        self._active = _Active()
        self._active_lock = threading.Lock()
        self.listener: Callable[[str, str], None] = lambda _kind, _session: None

    # ── 밖에서 부르는 것(스레드 안전) ─────────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="clean-feed-window", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if not self._thread:
            return
        self.submit(self._shutdown).result(timeout=(CLOSE_WAIT_MS + KILL_WAIT_MS * (1 + len(self._dying))) / 1000 + 2)
        self._stop.set()
        self._thread.join(timeout=2)
        self._thread = None

    def submit(self, fn: Callable[[], Any]) -> Future:
        self.start()
        future: Future = Future()
        self._tasks.put((fn, future))
        return future

    def set_active(self, session: str, value: bool) -> None:
        """앱의 active(document.hasFocus() && 보임) — 받은 때를 적고 바로 판정한다(보임은 기다리지 않는다)."""
        with self._active_lock:
            self._active = _Active(session, bool(value), self._clock())
        self.submit(lambda: None)

    def open(self, *, session: str, url: str, screen: Screen, browser: tuple[str, str], reuse: Optional[str] = None) -> Future:
        """1단계 — 띄우거나(reused False) reuse(release id)의 대기 창에 그 세션을 숨긴 채 붙인다(reused True). 창 찾기는 arm 뒤 폴링."""
        return self.submit(lambda: self._open(session, url, screen, browser, reuse))

    def arm(self, session: str) -> Future:
        """허브가 세션을 등록했다 — 그 세션의 창 탐색(2단계)·사건을 시작한다(등록 전에 결과가 와서 버려지지 않게)."""
        return self.submit(lambda: self._arm(session))

    def ready(self, session: str) -> Future:
        """다시 쓴 창의 새 피드가 준비됐다 — 그 세션 창을 보여도 된다(그 전엔 앱 active 여도 숨긴 채)."""
        return self.submit(lambda: self._ready(session))

    def release(self, session: str, release_id: str) -> Future:
        """세션이 끝났다 — 그 세션 창(살아 있고 우리 것이고 보여도 되는)을 숨겨 대기 창으로. 결과 True/False(False 면 창을 끝냈다)."""
        return self.submit(lambda: self._release(session, release_id))

    def close_standby(self, release_id: str) -> Future:
        return self.submit(lambda: self._close_standby(release_id))

    def close(self, session: Optional[str] = None) -> Future:
        return self.submit(lambda: self._close_now(session))

    def cleanup_pending(self) -> bool:
        """정리 실패가 남았나 — status 가 '안 됨'으로 알려 앱이 처음부터 팝업 방식으로 가게(실패·팝업이 번갈아 나오지 않게)."""
        return bool(self._dying)

    # ── 전용 스레드 ─────────────────────────────────────────────────────────────────────────────
    def _run(self) -> None:
        if self._api is None:
            self._api = Win32()
        try:
            self._api.enter_thread()
        except Exception:  # noqa: BLE001 — DPI 설정 실패는 좌표가 배율로 바뀔 뿐 — 영역 대조가 막는다
            log.warning("클린 피드: DPI 설정 실패", exc_info=True)
        while not self._stop.is_set():
            seeking = self._feed is not None and self._feed.armed and not self._feed.hwnd
            try:
                fn, future = self._tasks.get(timeout=PENDING_TICK if seeking else self._tick)
            except queue.Empty:
                fn, future = None, None
            if fn is not None and future is not None:
                if future.set_running_or_notify_cancel():
                    try:
                        future.set_result(fn())
                    except BaseException as exc:  # noqa: BLE001 — 부른 쪽이 받는다
                        future.set_exception(exc)
            try:
                self._poll()
            except Exception:  # noqa: BLE001 — 한 번의 실패로 감시를 멈추지 않는다
                log.warning("클린 피드: 창 점검 실패", exc_info=True)

    def _job_handle(self) -> int:
        if self._job is None:
            self._job = self._api.create_job()
        return self._job

    def _mine(self, feed: _Feed) -> bool:
        return self._api.alive(feed.process) and self._api.owner_pid(feed.hwnd) == feed.pid

    def _open(self, session: str, url: str, screen: Screen, browser: tuple[str, str], reuse: Optional[str] = None) -> dict:
        api = self._api
        feed = self._feed
        # 다시 쓰기 — 그 release id 의 대기 창이 살아 있고 우리 것이면(프로필 잠금 확인보다 먼저 — 그 잠금은 이 크롬이 쥐고 있다) 숨긴 채 새 세션을 붙인다
        if (reuse is not None and feed is not None and feed.session is None and feed.release_id == reuse and feed.browser == browser
                and self._mine(feed)):
            monitor = pick_monitor(api.monitors(), screen)
            if monitor is None:
                raise OpenError("no-monitor", "고른 화면에 맞는 모니터를 하나로 정하지 못했습니다")
            feed.session, feed.monitor, feed.release_id, feed.standby_since = session, monitor, None, None
            feed.armed, feed.showable, feed.visible, feed.hide_at, feed.refits = False, False, False, None, 0
            return {"reused": True}
        self._close_now()  # 한 허브에 하나 — 앞 창(대기 창 포함)은 닫고(세션 쪽은 이미 taken) 새로 띄운다
        self._reap(KILL_WAIT_MS)
        if self._dying:
            raise OpenError("cleanup-failed", "앞 클린 피드 창이 아직 끝나지 않았습니다")
        monitor = pick_monitor(api.monitors(), screen)
        if monitor is None:
            raise OpenError("no-monitor", "고른 화면에 맞는 모니터를 하나로 정하지 못했습니다")
        name, exe = browser
        profile = profile_dir(name)
        profile.mkdir(parents=True, exist_ok=True)
        try:
            (profile / "lockfile").unlink(missing_ok=True)  # 쥔 크롬이 없는 낡은 잠금은 지워진다 — 쥐고 있으면 공유 위반
        except OSError as exc:
            if getattr(exc, "winerror", None) == ERROR_SHARING_VIOLATION:
                raise OpenError("profile-in-use", "클린 피드 전용 프로필을 다른 크롬이 쓰고 있습니다") from exc
            raise OpenError("profile-check-failed", f"클린 피드 프로필을 확인하지 못했습니다: {exc}") from exc
        left, top, right, bottom = monitor.rect
        argv = [exe, f"--user-data-dir={profile}", "--kiosk", f"--app={url}", f"--window-position={(left + right) // 2},{(top + bottom) // 2}",
                "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required"]
        previous = api.foreground()  # 누른 앱 창 — 띄운 뒤 초점을 돌려준다
        try:
            pid, process = api.spawn_in_job(argv, self._job_handle())
        except SpawnLeftover as exc:
            self._dying.append(_Feed(session, exc.pid, exc.process, 0, monitor))  # 끝날 때까지 다음 open 거절(폴링이 푼다)
            raise OpenError("spawn-failed", str(exc)) from exc
        except OSError as exc:
            raise OpenError("spawn-failed", str(exc)) from exc
        # 창 찾기·맞춤·초점은 2단계(허브가 등록한 뒤 arm → 폴링 _seek) — 여기서 기다리지 않는다
        self._feed = _Feed(session, pid, process, 0, monitor, browser=browser, previous=previous,
                           deadline=self._clock() + FIND_WINDOW_TIMEOUT, armed=False)
        return {"reused": False}

    def _arm(self, session: str) -> bool:
        feed = self._feed
        if feed is None or feed.session != session or feed.armed:
            return False
        feed.armed = True
        if feed.hwnd:  # 다시 쓴 창 — 탐색은 없고 보임 판단만 시작(새 피드 ready 전엔 숨긴 채)
            return True
        feed.deadline = self._clock() + FIND_WINDOW_TIMEOUT  # 등록을 기다린 시간은 세지 않는다
        return True

    def _seek(self, feed: _Feed) -> None:
        """2단계 — 그 세션의 제목 창을 찾아 TOPMOST·영역 → 모니터 확인 → 초점 되돌림 → adopted. 실패는 창을 놓고 사유를 알린다."""
        api = self._api
        if not api.alive(feed.process) or self._clock() >= feed.deadline:
            self._feed = None
            self.listener("window-not-found", feed.session)  # 통지가 먼저 — 세션 종료는 정리(최대 2~4초)를 기다리지 않는다
            self._kill(feed)
            return
        title = TITLE_PREFIX + feed.session
        hwnd = next((h for h, cls, text in api.windows_of(feed.pid) if cls.startswith("Chrome_WidgetWin") and text.startswith(title)), 0)
        if not hwnd:
            return
        feed.hwnd = hwnd
        api.show_topmost(hwnd, feed.monitor.rect)  # 찾자마자 모니터 영역으로(0단계: 음수 좌표 모니터에서 1px 모자랐다)
        if api.monitor_of(hwnd) != feed.monitor.handle:  # 고른 화면 = 나온 화면
            self._feed = None
            self.listener("wrong-monitor", feed.session)
            self._kill(feed)
            return
        feed.visible = True
        if feed.previous and feed.previous != hwnd and api.foreground() == hwnd and not api.set_foreground(feed.previous):
            self.listener("focus-lost", feed.session)
        self.listener("adopted", feed.session)

    def _ready(self, session: str) -> bool:
        feed = self._feed
        if feed is None or feed.session != session or not feed.hwnd:
            return False
        feed.showable = True
        return True

    def _release(self, session: str, release_id: str) -> bool:
        feed = self._feed
        if feed is None or feed.session != session:
            return False
        if not feed.hwnd or not feed.showable or not self._mine(feed):  # 아직 못 찾았거나·준비 안 된 다시 쓴 창·죽은 창 — 남기지 않는다
            self._feed = None
            self._kill(feed)
            return False
        self._api.hide(feed.hwnd)
        feed.session, feed.release_id, feed.standby_since = None, release_id, self._clock()
        feed.visible, feed.hide_at = False, None
        return True

    def _close_standby(self, release_id: str) -> bool:
        feed = self._feed
        if feed is None or feed.session is not None or feed.release_id != release_id:
            return False
        self._feed = None
        self._kill(feed)
        return True

    def _kill(self, feed: _Feed) -> None:
        """닫기 — 창이 있으면 WM_CLOSE → 2초, 없으면(창 탐색 중) 기다리지 않고 → 쥔 핸들로 강제 종료 → 2초. 끝난 것을 본 뒤에만 핸들을 놓는다
        (안 끝나면 정리 실패로 남긴다)."""
        exited = False
        if feed.hwnd and self._api.owner_pid(feed.hwnd) == feed.pid:
            self._api.post_close(feed.hwnd)
            exited = self._api.wait_exit(feed.process, CLOSE_WAIT_MS)
        if not exited:
            self._api.terminate(feed.process)
            if not self._api.wait_exit(feed.process, KILL_WAIT_MS):
                log.warning("클린 피드: 크롬이 강제 종료 뒤에도 끝나지 않았습니다(pid %s) — 끝날 때까지 다음 창을 띄우지 않습니다", feed.pid)
                self._dying.append(feed)
                return
        self._api.close_handle(feed.process)

    def _reap(self, wait_ms: int) -> None:
        """정리 실패로 남은 것 — 이제 끝났으면 핸들을 놓는다(open 전에는 시한만큼 기다리고, 폴링은 기다리지 않는다)."""
        still = []
        for feed in self._dying:
            if self._api.wait_exit(feed.process, wait_ms):
                self._api.close_handle(feed.process)
            else:
                still.append(feed)
        self._dying = still

    def _close_now(self, session: Optional[str] = None) -> bool:
        feed = self._feed
        if feed is None or (session is not None and feed.session != session):
            return False
        self._feed = None
        self._kill(feed)
        return True

    def _shutdown(self) -> None:
        self._close_now()
        still = []
        for feed in self._dying:  # 정리 실패로 남은 것 — Job 밖일 수 있다(배정 실패) · 한 번 더 끝내고 끝난 것을 본 것만 놓는다
            self._api.terminate(feed.process)
            if self._api.wait_exit(feed.process, KILL_WAIT_MS):
                self._api.close_handle(feed.process)
            else:
                log.error("클린 피드: 허브를 끝내는데 크롬(pid %s)이 끝나지 않았습니다 — 직접 끝내야 할 수 있습니다", feed.pid)
                still.append(feed)
        self._dying = still

    def _poll(self) -> None:
        if self._dying:
            self._reap(0)
        feed = self._feed
        if feed is None or not feed.armed:  # arm 전(허브가 아직 등록 안 함)엔 사건을 내지 않는다
            return
        api = self._api
        if not feed.hwnd:  # 창 탐색 중 — 살아 있음·제목·기한만 본다(보임 규칙·_mine 판정 대상 아님)
            return self._seek(feed)
        if not self._mine(feed):  # 사람이 닫음(Alt+F4)·크롬이 끝남
            self._feed = None
            if api.wait_exit(feed.process, 0):  # 끝난 것을 봤다(WAIT_OBJECT_0 만 — WAIT_FAILED 는 끝남이 아니다)
                api.close_handle(feed.process)
            else:  # 창만 사라지고 크롬이 남았다 — 쥔 핸들로 끝내고, 끝났는지는 다음 open·폴링이 본다
                api.terminate(feed.process)
                self._dying.append(feed)
            if feed.session is None:
                self.listener("standby-ended", feed.release_id or "")
            else:
                self.listener("closed", feed.session)
            return
        now = self._clock()
        if feed.session is None:  # 대기 창 — 보이지 않는다 · 오래 안 쓰이면 끝낸다
            if now - (feed.standby_since or now) > STANDBY_TTL:
                self._feed = None
                self.listener("standby-ended", feed.release_id or "")
                self._kill(feed)
            return
        if not feed.showable:  # 다시 쓴 창 — 새 피드 ready 전엔 숨긴 채(앞 세션 그림이 비치지 않게)
            return
        with self._active_lock:
            active = self._active
        fresh = active.session == feed.session and active.value and now - active.at <= SHOW_FRESH
        want = fresh or api.foreground() == feed.hwnd
        if want:
            feed.hide_at = None
            if not feed.visible:
                api.show_topmost(feed.hwnd, feed.monitor.rect)
                feed.visible = True
                self.listener("visible", feed.session)
            elif feed.refits < MAX_REFITS and tuple(api.window_rect(feed.hwnd)) != feed.monitor.rect:
                # 크롬이 띄운 뒤 제 셈으로 다시 줄인다(격리 실측: 음수 좌표 세로 모니터에서 아래 1px) — 보이는 동안 다시 맞춘다
                api.show_topmost(feed.hwnd, feed.monitor.rect)
                feed.refits += 1
            return
        if not feed.visible:
            return
        if feed.hide_at is None:
            feed.hide_at = now + HIDE_DELAY
        elif now >= feed.hide_at:
            api.hide(feed.hwnd)
            feed.visible = False
            feed.hide_at = None
            self.listener("hidden", feed.session)
