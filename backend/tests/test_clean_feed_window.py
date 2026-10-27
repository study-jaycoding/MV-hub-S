"""클린 피드 전용 창 — 창·프로세스 제어(services/clean_feed_window). 계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md 'window-control'.

Win32 호출은 가짜 층(FakeApi)으로 바꾸고 전용 스레드 대신 그 스레드가 부르는 메서드(_open·_poll·_close_now)를 직접 부른다(시계도 가짜).
Win32 클래스 자체의 플래그·순서는 kernel32/user32 만 가짜로 바꿔 본다(윈도우에서만 — 실제 프로세스·창은 만들지 않는다).
"""

from __future__ import annotations

import ctypes
import os
import threading
import time
import urllib.parse

import pytest

from app.services import clean_feed_window as cfw
from app.services.clean_feed_window import FeedWindows, Monitor, OpenError, Screen

APP_HWND = 900  # 누른 앱 창
LEFT = Monitor(1, (-1080, -500, 0, 1420), False, 1.0)  # 세로 모니터 — 음수 좌표
RIGHT = Monitor(2, (1920, -500, 3000, 1420), False, 1.0)
MAIN = Monitor(3, (0, 0, 1920, 1080), True, 1.0)


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeApi:
    """윈도우 대신 — 띄운 크롬은 --app 의 세션 제목으로 창 하나를 낸다(바꿀 수 있다)."""

    def __init__(self, monitors=(LEFT, RIGHT, MAIN)) -> None:
        self.mons = list(monitors)
        self.calls: list[tuple] = []
        self.alive_set: set[int] = set()
        self.owners: dict[int, int] = {}
        self.wins: dict[int, list[tuple[int, str, str]]] = {}
        self.fg = APP_HWND
        self.set_fg_ok = True
        self.obeys_close = True
        self.spawn_error: OSError | None = None
        self.window_on: dict[int, int] = {}  # hwnd → 모니터 handle(없으면 띄운 영역의 모니터)
        self.steal_focus = True  # 띄운 창이 초점을 가져간다(키오스크 크롬이 그랬다)
        self.title_override: str | None = None
        self.class_override: str | None = None
        self.wrong_monitor = False
        self.on_find = None
        self.slow_exit = False  # 강제 종료가 늦어진다(TerminateProcess 는 비동기) — 시험이 끝낼 때까지 살아 있다
        self.rects: dict[int, tuple] = {}
        self.wait_failed: set[int] = set()  # WaitForSingleObject 가 WAIT_FAILED — 살았는지도 끝났는지도 모른다
        self.gate: threading.Event | None = None
        self.n = 0

    def enter_thread(self):
        self.calls.append(("enter",))

    def monitors(self):
        return self.mons

    def create_job(self):
        self.calls.append(("job",))
        return 500

    def spawn_in_job(self, argv, job):
        self.calls.append(("spawn", argv, job))
        if self.gate is not None:  # 띄우기가 오래 걸린다 — 시험이 풀 때까지
            assert self.gate.wait(5)
        if self.spawn_error:
            raise self.spawn_error
        self.n += 1
        pid, process, hwnd = 1000 + self.n, 2000 + self.n, 3000 + self.n
        self.alive_set.add(process)
        app = next(a for a in argv if a.startswith("--app="))
        session = urllib.parse.parse_qs(urllib.parse.urlsplit(app[6:]).query)["cleanfeed"][0]
        title = self.title_override if self.title_override is not None else cfw.TITLE_PREFIX + session
        cls = self.class_override or "Chrome_WidgetWin_1"
        self.wins[pid] = [(hwnd + 50, "Chrome_WidgetWin_0", ""), (hwnd, cls, title)]  # 숨은 보조 창이 먼저 — 제목으로 가른다
        self.owners[hwnd] = pid
        self.owners[hwnd + 50] = pid
        if self.steal_focus:
            self.fg = hwnd
        return pid, process

    def windows_of(self, pid):
        if self.on_find:
            self.on_find()
        return self.wins.get(pid, [])

    def owner_pid(self, hwnd):
        return self.owners.get(hwnd)

    def show_topmost(self, hwnd, rect):
        self.calls.append(("show", hwnd, rect))
        monitor = next(m for m in self.mons if m.rect == rect)
        self.window_on[hwnd] = MAIN.handle if self.wrong_monitor and monitor is not MAIN else monitor.handle
        self.rects[hwnd] = rect
        return True

    def window_rect(self, hwnd):
        return self.rects.get(hwnd, (0, 0, 0, 0))

    def hide(self, hwnd):
        self.calls.append(("hide", hwnd))

    def monitor_of(self, hwnd):
        return self.window_on.get(hwnd, 0)

    def foreground(self):
        return self.fg

    def set_foreground(self, hwnd):
        self.calls.append(("focus", hwnd))
        if self.set_fg_ok:
            self.fg = hwnd
        return self.set_fg_ok

    def post_close(self, hwnd):
        self.calls.append(("post_close", hwnd))
        if self.obeys_close:
            pid = self.owners.pop(hwnd, None)
            self.alive_set.discard(2000 + (pid - 1000) if pid else -1)

    def alive(self, process):
        return process in self.alive_set and process not in self.wait_failed

    def wait_exit(self, process, ms):
        self.calls.append(("wait", process, ms))
        return process not in self.alive_set and process not in self.wait_failed

    def terminate(self, process):
        self.calls.append(("terminate", process))
        if not self.slow_exit:
            self.alive_set.discard(process)

    def close_handle(self, handle):
        self.calls.append(("close_handle", handle))

    def names(self):
        return [c[0] for c in self.calls]


@pytest.fixture
def local_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    return tmp_path


def _windows(api=None):
    clock = Clock()
    events: list[tuple[str, str]] = []
    windows = FeedWindows(api or FakeApi(), clock=clock)
    windows.listener = lambda kind, session: events.append((kind, session))
    return windows, clock, events  # 스레드를 띄우지 않고 그 스레드가 부르는 메서드를 직접 부른다


def _screen(monitor: Monitor, dpr: float = 1.0) -> Screen:
    left, top, right, bottom = monitor.rect
    return Screen(left / dpr, top / dpr, (right - left) / dpr, (bottom - top) / dpr, dpr, monitor.primary)


BROWSER = ("chrome", r"C:\Chrome\chrome.exe")
URL = "http://127.0.0.1:8010/?cleanfeed={s}&key=k"


def _open(windows, session="s1", monitor=RIGHT):
    return windows._open(session, URL.format(s=session), _screen(monitor), BROWSER)


def _adopt(windows, session="s1"):
    """2단계 — 허브가 등록한 뒤 arm, 폴링이 제목 창을 찾아 맞춘다."""
    assert windows._arm(session) is True
    windows._poll()


def _opened(windows, session="s1", monitor=RIGHT):
    result = _open(windows, session, monitor)
    _adopt(windows, session)
    return result


# ── 모니터 고르기 ─────────────────────────────────────────────────────────────────────────────────
def test_pick_monitor_matches_size_primary_then_position():
    monitors = [LEFT, RIGHT, MAIN]
    assert cfw.pick_monitor(monitors, _screen(LEFT)) is LEFT  # 같은 크기 두 대 — 자리로(음수 좌표 포함)
    assert cfw.pick_monitor(monitors, _screen(RIGHT)) is RIGHT
    assert cfw.pick_monitor(monitors, _screen(MAIN)) is MAIN  # 크기·주 모니터로 하나
    stacked = [Monitor(1, (0, 0, 1920, 1080), True, 1.0), Monitor(2, (0, -1080, 1920, 0), False, 1.0)]
    assert cfw.pick_monitor(stacked, _screen(stacked[1])) is stacked[1]  # 위아래 배치
    assert cfw.pick_monitor(stacked[:1], _screen(stacked[1])) is None  # 크기는 같아도 주 모니터 여부가 다르면 아니다
    # ±2px 안은 같은 화면
    assert cfw.pick_monitor(monitors, Screen(1921, -499, 1081, 1919, 1.0, False)) is RIGHT
    # 배율 — DIP × 그 화면 배율 = 물리
    hi = [Monitor(5, (0, 0, 3840, 2160), True, 1.5)]
    assert cfw.pick_monitor(hi, Screen(0, 0, 2560, 1440, 1.5, True)) is hi[0]


def test_pick_monitor_refuses_ambiguous_or_missing():
    twins = [Monitor(1, (0, 0, 1080, 1920), False, 1.0), Monitor(2, (0, 0, 1080, 1920), False, 1.0)]  # 같은 자리·같은 크기(복제 화면)
    assert cfw.pick_monitor(twins, _screen(twins[0])) is None
    assert cfw.pick_monitor([LEFT, RIGHT, MAIN], Screen(5000, 0, 1080, 1920, 1.0, False)) is None  # 자리가 안 맞음
    assert cfw.pick_monitor([LEFT, RIGHT, MAIN], Screen(0, 0, 800, 600, 1.0, False)) is None  # 크기가 안 맞음


def test_profile_dir_is_per_browser_and_install(local_appdata):
    path = cfw.profile_dir("chrome")
    assert path.parent == local_appdata / "MVHub" / "clean-feed"
    assert path.name.startswith("chrome-") and len(path.name) == len("chrome-") + 10
    assert cfw.profile_dir("edge").name.startswith("edge-")


# ── 띄우기 ────────────────────────────────────────────────────────────────────────────────────────
def test_open_spawns_kiosk_in_job_and_answers_before_the_window(local_appdata):
    api = FakeApi()
    windows, _clock, events = _windows(api)
    result = _open(windows)
    spawn = next(c for c in api.calls if c[0] == "spawn")
    argv, job = spawn[1], spawn[2]
    assert job == 500 and argv[0] == BROWSER[1]
    assert f"--user-data-dir={cfw.profile_dir('chrome')}" in argv and "--kiosk" in argv
    assert f"--app={URL.format(s='s1')}" in argv
    # 1단계는 띄우기까지 — 제목 창을 기다리지 않고 답한다
    assert result == {"reused": False} and "show" not in api.names() and windows._feed.hwnd == 0
    windows._poll()  # arm 전에는(허브가 아직 등록 안 함) 찾지도 알리지도 않는다
    assert events == [] and windows._feed.hwnd == 0 and "show" not in api.names()
    assert windows._arm("other") is False and windows._arm("s1") is True and windows._arm("s1") is False
    windows._poll()
    hwnd = 3001
    assert ("show", hwnd, RIGHT.rect) in api.calls  # 찾자마자 모니터 영역으로 · 숨은 보조 창(3051)이 아니라 제목 맞는 창
    assert ("focus", APP_HWND) in api.calls and api.fg == APP_HWND  # 띄우기 전 맨 앞 창으로 되돌림
    assert events == [("adopted", "s1")]
    assert windows._feed.hwnd == hwnd and windows._feed.visible


def test_open_reports_focus_restore_failure(local_appdata):
    api = FakeApi()
    api.set_fg_ok = False
    windows, _clock, events = _windows(api)
    _opened(windows)
    assert events == [("focus-lost", "s1"), ("adopted", "s1")]
    api2 = FakeApi()
    api2.steal_focus = False  # 초점을 안 가져갔으면 건드리지 않는다
    windows2, _clock2, events2 = _windows(api2)
    _opened(windows2)
    assert events2 == [("adopted", "s1")] and ("focus", APP_HWND) not in api2.calls


@pytest.mark.parametrize("title,cls", [("MV hub Clean Feed other", None), (None, "Chrome_RenderWidgetHostHWND")])
def test_open_rejects_window_with_other_title_or_class(local_appdata, title, cls):
    api = FakeApi()
    api.title_override, api.class_override = title, cls
    windows, clock, events = _windows(api)

    def advance():
        clock.t += 1.0

    api.on_find = advance  # 찾는 사이 시계가 흘러 시한을 넘긴다
    _open(windows)
    clock.t += 100  # 등록을 기다린 시간은 세지 않는다 — 시한은 arm 부터
    assert windows._arm("s1")
    for _ in range(20):
        windows._poll()
        if windows._feed is None:
            break
    assert events == [("window-not-found", "s1")]
    # 창이 없으니 WM_CLOSE·그 2초 기다림 없이 쥔 핸들로 바로 끝내고, 끝난 것을 본 뒤 놓는다
    assert api.calls[-3:] == [("terminate", 2001), ("wait", 2001, cfw.KILL_WAIT_MS), ("close_handle", 2001)]
    assert api.names().count("wait") == 1 and "post_close" not in api.names() and windows._feed is None
    assert not any(c[0] == "show" for c in api.calls)


def test_window_not_found_when_chrome_ends_before_its_window(local_appdata):
    api = FakeApi()
    windows, _clock, events = _windows(api)
    _open(windows)
    api.alive_set.discard(2001)  # 크롬이 창을 내기 전에 끝났다
    windows.listener = lambda kind, session: (events.append((kind, session)), api.calls.append(("event", kind)))
    _adopt(windows)
    assert events == [("window-not-found", "s1")] and windows._feed is None and ("close_handle", 2001) in api.calls
    assert api.names().index("event") < api.names().index("terminate")  # 통지가 먼저 — 정리(최대 2초)를 기다리지 않는다


def test_open_fails_when_window_lands_on_other_monitor(local_appdata):
    api = FakeApi()
    api.wrong_monitor = True
    windows, _clock, events = _windows(api)
    windows.listener = lambda kind, session: (events.append((kind, session)), api.calls.append(("event", kind)))
    _opened(windows)
    assert events == [("wrong-monitor", "s1")]
    assert ("post_close", 3001) in api.calls and ("close_handle", 2001) in api.calls and windows._feed is None
    assert api.names().index("event") < api.names().index("post_close")  # 통지가 먼저 — 정리(WM_CLOSE 2초 + 강제 종료 2초)를 기다리지 않는다


def test_closing_a_window_still_being_sought_kills_it_without_waiting(local_appdata):
    api = FakeApi()
    windows, _clock, events = _windows(api)
    _open(windows)
    assert windows._close_now("s1") is True
    assert api.calls[-3:] == [("terminate", 2001), ("wait", 2001, cfw.KILL_WAIT_MS), ("close_handle", 2001)]
    assert "post_close" not in api.names() and events == [] and windows._feed is None


def test_open_removes_stale_lockfile_and_goes_on(local_appdata):
    api = FakeApi()
    windows, *_ = _windows(api)
    profile = cfw.profile_dir("chrome")
    profile.mkdir(parents=True)
    (profile / "lockfile").write_bytes(b"")  # 쥔 크롬이 없는 낡은 잠금(정전 등) — 크롬도 덮어쓴다
    assert _open(windows) == {"reused": False}
    assert not (profile / "lockfile").exists() and "spawn" in api.names()


def test_open_refuses_held_lockfile_without_killing(local_appdata):
    if os.name != "nt":
        pytest.skip("윈도우의 공유 위반")
    api = FakeApi()
    windows, *_ = _windows(api)
    profile = cfw.profile_dir("chrome")
    profile.mkdir(parents=True)
    with open(profile / "lockfile", "w") as held:  # 파이썬도 FILE_SHARE_DELETE 없이 연다 — 크롬이 쥔 것과 같이 지우기가 공유 위반
        with pytest.raises(OpenError) as exc:
            _open(windows)
        assert exc.value.code == "profile-in-use"
        assert not held.closed and (profile / "lockfile").exists()
    assert not any(c[0] in ("spawn", "terminate", "post_close") for c in api.calls)


def test_open_refuses_other_lockfile_errors(local_appdata, monkeypatch):
    api = FakeApi()
    windows, *_ = _windows(api)
    if os.name != "nt":
        pytest.skip("윈도우 오류 번호")
    denied = PermissionError(13, "Access is denied", "lockfile", 5)  # ERROR_ACCESS_DENIED — 사용 가능으로 보지 않는다
    monkeypatch.setattr(cfw.Path, "unlink", lambda self, missing_ok=False: (_ for _ in ()).throw(denied))
    with pytest.raises(OpenError) as exc:
        _open(windows)
    assert exc.value.code == "profile-check-failed" and "spawn" not in api.names()


def test_open_refuses_unmatched_monitor_and_spawn_failure(local_appdata):
    api = FakeApi()
    windows, *_ = _windows(api)
    with pytest.raises(OpenError) as exc:
        windows._open("s1", URL.format(s="s1"), Screen(0, 0, 640, 480, 1.0, False), BROWSER)
    assert exc.value.code == "no-monitor" and "spawn" not in api.names()
    api.spawn_error = OSError(5, "AssignProcessToJobObject")
    with pytest.raises(OpenError) as exc:
        _open(windows)
    assert exc.value.code == "spawn-failed" and windows._feed is None


def test_second_open_closes_previous_window_first(local_appdata):
    api = FakeApi()
    windows, *_ = _windows(api)
    _opened(windows, "s1", RIGHT)
    _open(windows, "s2", LEFT)
    names = api.names()
    first_close = names.index("post_close")
    second_spawn = [i for i, n in enumerate(names) if n == "spawn"][1]
    assert first_close < second_spawn  # 한 허브에 하나 — 앞 창을 닫고 새로
    assert ("post_close", 3001) in api.calls and windows._feed.session == "s2"
    assert api.calls.count(("job",)) == 1  # Job 하나를 계속 쓴다


# ── 보임·숨김 ─────────────────────────────────────────────────────────────────────────────────────
def _shown(windows, api, events=None):
    _opened(windows)
    api.calls.clear()
    api.fg = APP_HWND
    if events is not None:
        events.clear()  # 찾아 맞춘 adopted 사건은 지운다 — 아래 시험은 그 뒤의 사건만 본다


def test_active_false_hides_after_delay_and_true_shows_at_once(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.fg = 77  # 다른 프로그램이 맨 앞
    with windows._active_lock:
        windows._active = cfw._Active("s1", False, clock.t)
    windows._poll()
    assert "hide" not in api.names()  # 바로 숨기지 않는다(앱 → 피드로 초점 옮기는 사이)
    clock.t += cfw.HIDE_DELAY - 0.01
    windows._poll()
    assert "hide" not in api.names()
    clock.t += 0.02
    windows._poll()
    assert ("hide", 3001) in api.calls and events[-1] == ("hidden", "s1")
    api.calls.clear()
    with windows._active_lock:
        windows._active = cfw._Active("s1", True, clock.t)
    windows._poll()  # true 는 기다리지 않는다
    assert api.calls == [("show", 3001, RIGHT.rect)] and events[-1] == ("visible", "s1")


def test_hide_is_withdrawn_when_active_returns_in_time(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.fg = 77
    with windows._active_lock:
        windows._active = cfw._Active("s1", False, clock.t)
    windows._poll()
    clock.t += 0.1
    with windows._active_lock:
        windows._active = cfw._Active("s1", True, clock.t)
    windows._poll()
    clock.t += 0.2
    windows._poll()
    assert "hide" not in api.names() and events == []


def test_active_goes_stale_after_fresh_window(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.fg = 77
    with windows._active_lock:
        windows._active = cfw._Active("s1", True, clock.t)
    clock.t += cfw.SHOW_FRESH - 0.05
    windows._poll()
    assert "hide" not in api.names()
    clock.t += 0.1  # 2.5초 넘게 안 왔다 → false 로 본다
    windows._poll()
    clock.t += cfw.HIDE_DELAY + 0.01
    windows._poll()
    assert ("hide", 3001) in api.calls


def test_feed_in_front_keeps_it_visible_and_other_session_active_is_ignored(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.fg = 3001  # 피드 창이 맨 앞(사람이 피드를 눌렀다)
    with windows._active_lock:
        windows._active = cfw._Active("s1", False, clock.t)
    for _ in range(5):
        clock.t += 0.1
        windows._poll()
    assert "hide" not in api.names()
    api.fg = 77
    with windows._active_lock:
        windows._active = cfw._Active("old-session", True, clock.t)  # 다른(옛) 세션의 active 는 세지 않는다
    windows._poll()
    clock.t += cfw.HIDE_DELAY + 0.01
    windows._poll()
    assert ("hide", 3001) in api.calls


def test_visible_window_is_refitted_when_chrome_shrinks_it_with_a_cap(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _opened(windows, monitor=LEFT)
    api.calls.clear()
    with windows._active_lock:
        windows._active = cfw._Active("s1", True, clock.t)
    left, top, right, bottom = LEFT.rect
    api.rects[3001] = (left, top, right, bottom - 1)  # 크롬이 띄운 뒤 제 셈으로 1px 줄였다(격리 실측)
    windows._poll()
    assert api.calls == [("show", 3001, LEFT.rect)]
    windows._poll()  # 맞았으면 다시 안 건드린다
    assert len(api.calls) == 1
    for _ in range(cfw.MAX_REFITS + 5):  # 크롬이 계속 되돌리면 — 상한까지만
        api.rects[3001] = (left, top, right, bottom - 1)
        windows._poll()
    assert sum(1 for c in api.calls if c[0] == "show") == cfw.MAX_REFITS


def test_show_topmost_and_hide_use_topmost_noactivate_flags():
    if os.name != "nt":
        pytest.skip("윈도우 전용")
    api = cfw.Win32()
    seen = []

    class User32:
        def SetWindowPos(self, *args):
            seen.append(("pos", args))
            return 1

        def ShowWindow(self, *args):
            seen.append(("show", args))
            return 1

    api.user32 = User32()
    assert api.show_topmost(42, (-1080, -500, 0, 1420)) is True
    api.hide(42)
    hwnd, after, x, y, w, h, flags = seen[0][1]
    assert hwnd == 42 and after.value == ctypes.c_void_p(-1).value  # HWND_TOPMOST
    assert (x, y, w, h) == (-1080, -500, 1080, 1920)
    assert flags == cfw.SWP_NOACTIVATE | cfw.SWP_SHOWWINDOW
    assert seen[1] == ("show", (42, cfw.SW_HIDE))


# ── 대기 창(끈 창 다시 쓰기 — 켜기 단축 2026-10-26) ─────────────────────────────────────────────────
def _standby(windows, api, events, release="r1"):
    _shown(windows, api, events)
    assert windows._release("s1", release) is True
    api.calls.clear()


def test_release_hides_the_session_window_as_standby_that_is_never_shown(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    assert windows._release("other", "r1") is False and windows._feed.session == "s1"  # 다른 세션의 것은 무시
    assert windows._release("s1", "r1") is True
    assert ("hide", 3001) in api.calls and windows._feed.session is None and windows._feed.release_id == "r1"
    api.calls.clear()
    api.fg = 3001  # 맨 앞이어도 · 옛 세션의 active 가 남아 있어도 대기 창은 보이지 않는다
    with windows._active_lock:
        windows._active = cfw._Active("s1", True, clock.t)
    for _ in range(5):
        clock.t += 0.1
        windows._poll()
    assert "show" not in api.names() and events == []


def test_release_of_a_window_not_found_yet_or_not_ready_kills_it(local_appdata):
    api = FakeApi()
    windows, *_ = _windows(api)
    _open(windows)  # 아직 창을 못 찾았다
    assert windows._release("s1", "r1") is False
    assert ("terminate", 2001) in api.calls and windows._feed is None
    api2 = FakeApi()
    windows2, clock2, events2 = _windows(api2)
    _standby(windows2, api2, events2)
    assert windows2._open("s2", URL.format(s="s2"), _screen(LEFT), BROWSER, "r1") == {"reused": True}
    assert windows2._release("s2", "r2") is False  # 다시 쓴 창인데 새 피드 ready 전 — 남기지 않는다
    assert ("post_close", 3001) in api2.calls and windows2._feed is None


def test_open_without_reuse_ends_the_standby_and_launches(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _standby(windows, api, events)
    assert _open(windows, "s2", LEFT) == {"reused": False}
    assert ("post_close", 3001) in api.calls and api.names().count("spawn") == 1 and windows._feed.session == "s2"


def test_reuse_attaches_the_new_session_hidden_and_shows_it_only_after_ready_without_focus(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _standby(windows, api, events)
    profile = cfw.profile_dir("chrome")
    if os.name == "nt":
        profile.mkdir(parents=True, exist_ok=True)
        held = open(profile / "lockfile", "w")  # 대기 크롬이 쥔 잠금 — 다시 쓰기는 잠금 확인보다 먼저라 막히지 않는다
    else:
        held = None
    try:
        assert windows._open("s2", URL.format(s="s2"), _screen(LEFT), BROWSER, "r1") == {"reused": True}
    finally:
        if held:
            held.close()
    assert not {"spawn", "post_close", "terminate", "show", "focus"} & set(api.names())  # 띄우지도 닫지도 보이지도 않는다
    feed = windows._feed
    assert (feed.session, feed.hwnd, feed.monitor, feed.showable, feed.visible, feed.release_id) == ("s2", 3001, LEFT, False, False, None)
    api.fg = APP_HWND
    with windows._active_lock:
        windows._active = cfw._Active("s2", True, clock.t)
    windows._poll()  # arm 전 — 아무것도 안 한다
    assert windows._arm("s2") is True
    windows._poll()  # 새 피드 ready 전 — 앱 active 여도 숨긴 채(앞 세션 그림이 비치지 않게)
    assert "show" not in api.names() and events == []
    assert windows._ready("other") is False and windows._ready("s2") is True
    windows._poll()
    assert api.calls == [("show", 3001, LEFT.rect)] and events == [("visible", "s2")]  # 고른 모니터로 · 초점은 안 건드린다


def test_reuse_needs_the_same_release_id_browser_and_a_live_window(local_appdata):
    for case in ("release", "browser", "dead"):
        api = FakeApi()
        windows, clock, events = _windows(api)
        _standby(windows, api, events)
        release, browser = ("r9", BROWSER) if case == "release" else ("r1", ("edge", r"C:\Edge\msedge.exe") if case == "browser" else BROWSER)
        if case == "dead":
            api.alive_set.discard(2001)
        result = windows._open("s2", URL.format(s="s2"), _screen(LEFT), browser, release)
        assert result == {"reused": False} and windows._feed.session == "s2" and windows._feed.hwnd == 0, case  # 새로 띄웠다
        assert api.names().count("spawn") == 1, case


def test_standby_ends_after_ttl_or_when_it_dies_and_reports_its_release(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _standby(windows, api, events)
    clock.t += cfw.STANDBY_TTL - 1
    windows._poll()
    assert windows._feed is not None and events == []
    clock.t += 2
    windows._poll()
    assert events == [("standby-ended", "r1")] and windows._feed is None and ("post_close", 3001) in api.calls
    api2 = FakeApi()
    windows2, clock2, events2 = _windows(api2)
    _standby(windows2, api2, events2)
    api2.alive_set.clear()  # 숨은 크롬이 죽었다
    windows2._poll()
    assert events2 == [("standby-ended", "r1")] and windows2._feed is None  # 세션 종료(closed)가 아니다


def test_close_standby_only_closes_that_release(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _standby(windows, api, events)
    assert windows._close_standby("r9") is False and windows._feed is not None
    assert windows._open("s2", URL.format(s="s2"), _screen(LEFT), BROWSER, "r1") == {"reused": True}
    assert windows._close_standby("r1") is False and windows._feed.session == "s2"  # 이미 새 세션 창 — 옛 release 의 늦은 닫기가 못 닫는다
    api2 = FakeApi()
    windows2, clock2, events2 = _windows(api2)
    _standby(windows2, api2, events2)
    assert windows2._close_standby("r1") is True and windows2._feed is None and ("post_close", 3001) in api2.calls


# ── 사람이 닫음 · 닫기 ────────────────────────────────────────────────────────────────────────────
def test_user_closed_window_reports_closed_once(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.alive_set.clear()  # Alt+F4 — 크롬이 끝났다
    windows._poll()
    windows._poll()
    assert events == [("closed", "s1")] and windows._feed is None
    assert ("close_handle", 2001) in api.calls and not {"hide", "show", "terminate"} & set(api.names())


def test_reused_hwnd_of_other_process_is_not_touched(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.owners[3001] = 4242  # 창 번호가 다른 프로세스 것이 됐다
    windows._poll()
    assert events == [("closed", "s1")]
    assert not any(c[0] in ("hide", "show", "post_close") for c in api.calls)  # 그 창에는 아무것도 안 한다
    assert ("terminate", 2001) in api.calls  # 남은 크롬은 쥔 핸들로 끝낸다(프로필 잠금)
    assert ("close_handle", 2001) not in api.calls and windows.cleanup_pending()  # 끝난 것을 보기 전에는 놓지 않는다
    windows._poll()  # 다음 폴링이 끝난 것을 보고 놓는다
    assert ("close_handle", 2001) in api.calls and not windows.cleanup_pending()
    windows._close_now()  # 이미 놓았다 — 남의 창에 WM_CLOSE 를 보내지 않는다
    assert "post_close" not in api.names()


def test_close_posts_wm_close_then_terminates_after_timeout(local_appdata):
    api = FakeApi()
    api.obeys_close = False  # WM_CLOSE 를 안 듣는다
    windows, *_ = _windows(api)
    _opened(windows)
    api.calls.clear()
    assert windows._close_now("other") is False and api.calls == []  # 다른 세션의 닫기는 무시
    assert windows._close_now("s1") is True
    assert api.calls == [("post_close", 3001), ("wait", 2001, cfw.CLOSE_WAIT_MS), ("terminate", 2001), ("wait", 2001, cfw.KILL_WAIT_MS),
                         ("close_handle", 2001)]  # 강제 종료 뒤 끝난 것을 보고 놓는다


def test_wait_failed_is_not_taken_as_exited(local_appdata):
    api = FakeApi()
    windows, clock, events = _windows(api)
    _shown(windows, api, events)
    api.wait_failed.add(2001)
    windows._poll()
    assert events == [("closed", "s1")]  # 쥔 창을 더는 내 것으로 못 본다 — 세션은 끝
    assert ("terminate", 2001) in api.calls and ("close_handle", 2001) not in api.calls and windows.cleanup_pending()


def test_spawn_leftover_is_kept_as_cleanup_failure(local_appdata):
    api = FakeApi()
    api.alive_set.add(2009)
    api.spawn_error = cfw.SpawnLeftover(1009, 2009, "AssignProcessToJobObject")  # 배정 실패 뒤 끝내라고 했는데 끝난 것을 못 봤다
    windows, *_ = _windows(api)
    with pytest.raises(OpenError) as exc:
        _open(windows)
    assert exc.value.code == "spawn-failed" and windows.cleanup_pending() and ("close_handle", 2009) not in api.calls
    api.spawn_error = None
    with pytest.raises(OpenError) as exc:
        _open(windows, "s2")
    assert exc.value.code == "cleanup-failed"
    api.alive_set.discard(2009)
    windows._poll()
    assert ("close_handle", 2009) in api.calls and _open(windows, "s3") == {"reused": False}


@pytest.mark.parametrize("exits", [True, False])
def test_shutdown_terminates_leftovers_again_and_keeps_what_does_not_exit(local_appdata, exits):
    api = FakeApi()
    api.alive_set.add(2009)
    api.spawn_error = cfw.SpawnLeftover(1009, 2009, "AssignProcessToJobObject")  # Job 밖 — 허브의 Job 이 끝내 주지 않는다
    windows, *_ = _windows(api)
    with pytest.raises(OpenError):
        _open(windows)
    api.calls.clear()
    api.slow_exit = not exits
    windows._shutdown()
    assert api.calls[0] == ("terminate", 2009) and ("wait", 2009, cfw.KILL_WAIT_MS) in api.calls  # 한 번 더 끝내고 끝났는지 본다
    assert (("close_handle", 2009) in api.calls) is exits and windows.cleanup_pending() is (not exits)  # 못 본 것은 버리지 않는다


@pytest.mark.parametrize("where", ["close", "window-not-found"])
def test_slow_kill_is_kept_as_cleanup_failure_until_it_exits(local_appdata, where):
    api = FakeApi()
    api.obeys_close = False
    api.slow_exit = True
    windows, clock, events = _windows(api)
    if where == "close":
        _opened(windows)
        windows._close_now("s1")
    else:  # 2단계 실패(창 못 찾음)도 같은 정리 규칙 — 세션 종료 알림은 정리 완료를 기다리지 않는다
        api.title_override = "other"

        def advance():
            clock.t += 1.0

        api.on_find = advance
        _open(windows)
        assert windows._arm("s1")
        for _ in range(20):
            windows._poll()
            if windows._feed is None:
                break
        assert events == [("window-not-found", "s1")]
        api.on_find, api.title_override = None, None
    assert ("close_handle", 2001) not in api.calls and windows.cleanup_pending()
    with pytest.raises(OpenError) as exc:  # 끝날 때까지 다음 창을 띄우지 않는다
        _open(windows, "s2")
    assert exc.value.code == "cleanup-failed" and api.names().count("spawn") == 1
    api.alive_set.discard(2001)  # 이제 끝났다
    windows._poll()  # 폴링이 보고 놓는다(기다리지 않는다)
    assert ("close_handle", 2001) in api.calls and not windows.cleanup_pending()
    api.slow_exit = False
    assert _open(windows, "s3") == {"reused": False}


# ── 전용 스레드 ───────────────────────────────────────────────────────────────────────────────────
def test_thread_runs_work_polls_and_stops(local_appdata):
    api = FakeApi()
    windows = FeedWindows(api, tick=0.01)
    events = []
    got = threading.Event()

    def listen(kind, session):
        events.append((kind, session, threading.current_thread().name))
        got.set()

    windows.listener = listen
    try:
        result = windows.open(session="s1", url=URL.format(s="s1"), screen=_screen(RIGHT), browser=BROWSER).result(timeout=5)
        assert result == {"reused": False} and ("enter",) in api.calls  # 그 스레드가 DPI 설정부터
        time.sleep(0.05)
        assert events == []  # arm 전에는 폴링이 이 창의 사건을 내지 않는다(등록 전 결과 유실 없음)
        assert windows.arm("s1").result(timeout=5) is True
        assert got.wait(3)
        assert events[0][:2] == ("adopted", "s1") and events[0][2] == "clean-feed-window"
        got.clear()
        api.fg = 77
        windows.set_active("s1", False)
        assert got.wait(3)
        assert events[-1][:2] == ("hidden", "s1")
    finally:
        windows.stop()
    assert ("post_close", 3001) in api.calls and windows._thread is None


def test_cancelled_hub_open_closes_the_window_created_afterwards(local_appdata):
    """창 띄우기가 시작된 뒤 open 요청이 끊긴다 → 창 스레드는 띄우기를 마친다 → 줄 세운 닫기가 그 창을 닫는다(등록 안 된 창이 남지 않는다)."""
    import asyncio

    from app.services.clean_feed_session import Hub, Identity

    api = FakeApi()
    api.gate = threading.Event()
    windows = FeedWindows(api, tick=0.01)
    hub = Hub(windows)

    async def go():
        task = asyncio.create_task(hub.open(screen=_screen(RIGHT), takeover=True, client="tab-aaaaaaaa", seq=1, origin="http://127.0.0.1:8010",
                                            identity=Identity(0, ("", None)), proxying=False, browser=BROWSER))
        for _ in range(100):  # 창 스레드가 띄우는 중(spawn 에서 멈춤)
            if "spawn" in api.names():
                break
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        api.gate.set()  # 띄우기가 취소 뒤에 끝난다
        for _ in range(200):
            if ("close_handle", 2001) in api.calls:
                break
            await asyncio.sleep(0.01)

    try:
        asyncio.run(go())
    finally:
        windows.stop()
    # 그 창을 닫았다 — 아직 창을 못 찾은(arm 안 된) 크롬이라 WM_CLOSE 없이 바로 끝낸다
    assert ("terminate", 2001) in api.calls and ("close_handle", 2001) in api.calls and windows._feed is None
    assert hub.session is None and list(hub.ended.values()) == ["open-failed"]


# ── Win32 층 자체(kernel32 만 가짜) ───────────────────────────────────────────────────────────────
class _Kernel32:
    def __init__(self, assign_ok=True, resume_ok=True, exits=True):
        self.calls = []
        self.assign_ok, self.resume_ok, self.exits = assign_ok, resume_ok, exits
        self.job_info = None

    def WaitForSingleObject(self, handle, ms):
        self.calls.append(("wait", handle, ms))
        return cfw.WAIT_OBJECT_0 if self.exits else cfw.WAIT_TIMEOUT

    def CreateProcessW(self, app, cmd, pa, ta, inherit, flags, env, cwd, startup, info):
        self.calls.append(("create", app, cmd.value, inherit, flags))
        info._obj.hProcess, info._obj.hThread, info._obj.dwProcessId = 11, 12, 4321
        return 1

    def AssignProcessToJobObject(self, job, process):
        self.calls.append(("assign", job, process))
        return 1 if self.assign_ok else 0

    def ResumeThread(self, thread):
        self.calls.append(("resume", thread))
        return 1 if self.resume_ok else 0xFFFFFFFF

    def TerminateProcess(self, process, code):
        self.calls.append(("terminate", process))
        return 1

    def CloseHandle(self, handle):
        self.calls.append(("close", handle))
        return 1

    def CreateJobObjectW(self, attrs, name):
        self.calls.append(("job", attrs, name))
        return 99

    def SetInformationJobObject(self, job, kind, info, size):
        self.job_info = (job, kind, info._obj.Basic.LimitFlags, size)
        return 1


def _win32(kernel):
    if os.name != "nt":
        pytest.skip("윈도우 전용")
    api = cfw.Win32()
    api.kernel32 = kernel
    return api


def test_spawn_is_suspended_assigned_then_resumed():
    kernel = _Kernel32()
    pid, process = _win32(kernel).spawn_in_job([r"C:\Program Files\Chrome\chrome.exe", "--kiosk", "--app=http://x/?a=1&b=2"], 99)
    assert (pid, process) == (4321, 11)
    create = kernel.calls[0]
    assert create[0] == "create" and create[4] == cfw.CREATE_SUSPENDED and create[3] is False  # 핸들 상속 없음
    assert create[2] == '"C:\\Program Files\\Chrome\\chrome.exe" --kiosk --app=http://x/?a=1&b=2'
    assert [c[0] for c in kernel.calls] == ["create", "assign", "resume", "close"]
    assert kernel.calls[1] == ("assign", 99, 11) and kernel.calls[3] == ("close", 12)  # 스레드 핸들만 닫고 프로세스 핸들은 쥔다


@pytest.mark.parametrize("assign_ok,resume_ok", [(False, True), (True, False)])
def test_spawn_failure_after_create_kills_that_process_and_sees_it_exit(assign_ok, resume_ok):
    kernel = _Kernel32(assign_ok, resume_ok)
    with pytest.raises(OSError) as exc:
        _win32(kernel).spawn_in_job(["chrome.exe"], 99)
    assert not isinstance(exc.value, cfw.SpawnLeftover)
    names = [c[0] for c in kernel.calls]
    assert ("terminate", 11) in kernel.calls and ("wait", 11, cfw.KILL_WAIT_MS) in kernel.calls  # 끝난 것을 보고
    assert ("close", 11) in kernel.calls and ("close", 12) in kernel.calls
    assert names.index("terminate") < names.index("wait") < names.index("close")


def test_spawn_failure_that_does_not_exit_keeps_the_handle():
    kernel = _Kernel32(assign_ok=False, exits=False)
    with pytest.raises(cfw.SpawnLeftover) as exc:
        _win32(kernel).spawn_in_job(["chrome.exe"], 99)
    assert (exc.value.pid, exc.value.process) == (4321, 11)
    assert ("close", 11) not in kernel.calls and ("close", 12) in kernel.calls  # 프로세스 핸들은 쥔 채(정리 실패) — 스레드 핸들만 닫는다


def test_wait_exit_counts_only_signaled_handle_as_exited():
    class Kernel:
        result = 0

        def WaitForSingleObject(self, handle, ms):
            return self.result

    kernel = Kernel()
    api = _win32(kernel)
    for result, exited, alive in ((cfw.WAIT_OBJECT_0, True, False), (cfw.WAIT_TIMEOUT, False, True), (0xFFFFFFFF, False, False)):
        kernel.result = result  # 0xFFFFFFFF = WAIT_FAILED — 끝남으로 보지 않는다
        assert (api.wait_exit(11, 0), api.alive(11)) == (exited, alive), result


def test_job_kills_on_close_without_breakaway():
    kernel = _Kernel32()
    assert _win32(kernel).create_job() == 99
    assert kernel.calls[0] == ("job", None, None)  # 보안 속성 없음 = 핸들 비상속
    job, kind, flags, size = kernel.job_info
    assert job == 99 and kind == cfw.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION
    assert flags == cfw.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE  # BREAKAWAY_OK(0x800)·SILENT_BREAKAWAY_OK(0x1000) 없음
