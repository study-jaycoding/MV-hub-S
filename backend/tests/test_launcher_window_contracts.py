"""런처 앱 창 감시 계약 — CIM 3상태·창 승인(제목/property)·감시 상태 머신.

핵심 계약(코덱스 합의, 묶음 C):
· 조회 실패(None)와 '프로세스 없음'([])을 절대 합치지 않는다 — 실패 중 종료 판정 금지.
· MV Hub 창 판정 = 제목 접두 일치(승인 시 property 로 스티키) — DevTools·Ctrl+N 제외.
· 최초 조회가 실패하면 창을 띄우기 전에 앱창 모드를 포기한다(고아 창 방지).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

LAUNCHER_PATH = Path(__file__).resolve().parents[2] / "run_agent_session.py"


@pytest.fixture(scope="module")
def launcher():
    spec = importlib.util.spec_from_file_location("mvhub_launcher_contract_target", LAUNCHER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _ps_result(returncode: int, stdout: str):
    # 조회는 바이트로 받아 UTF-8 엄격 해석한다(81회차 R-3) — 실제 파이프 경계는 test_windows_powershell_utf8 이 본다.
    return SimpleNamespace(returncode=returncode, stdout=stdout.encode("utf-8"), stderr=b"")


def test_browser_processes_three_states(launcher, monkeypatch: pytest.MonkeyPatch):
    row = {"ProcessId": 42, "ExecutablePath": "C:\\x\\chrome.exe", "CommandLine": "chrome --user-data-dir=C:\\p"}

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, json.dumps(row)))
    assert launcher._browser_processes("chrome.exe") == [
        {"pid": 42, "exe": "C:\\x\\chrome.exe", "cmdline": "chrome --user-data-dir=C:\\p"}
    ]

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, "[]"))
    assert launcher._browser_processes("chrome.exe") == []  # 성공 + 없음(0행은 PowerShell 이 '[]' 를 낸다)

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, ""))
    assert launcher._browser_processes("chrome.exe") is None  # 출력 누락 = 조회 실패

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(1, ""))
    assert launcher._browser_processes("chrome.exe") is None  # cmdlet 실패

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, "not-json{"))
    assert launcher._browser_processes("chrome.exe") is None

    def raise_timeout(*_a, **_k):
        raise subprocess.TimeoutExpired(cmd="powershell", timeout=15)

    monkeypatch.setattr(launcher.subprocess, "run", raise_timeout)
    assert launcher._browser_processes("chrome.exe") is None


def test_browser_processes_unreadable_commandline_means_indeterminate(
    launcher, monkeypatch: pytest.MonkeyPatch
):
    """CommandLine 을 못 읽는 행이 있으면 '우리 프로필 아님'을 증명할 수 없다 → None."""
    rows = [
        {"ProcessId": 42, "ExecutablePath": "", "CommandLine": None},
        {"ProcessId": 43, "ExecutablePath": "", "CommandLine": "chrome --user-data-dir=C:\\p"},
    ]
    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, json.dumps(rows)))
    assert launcher._browser_processes("chrome.exe") is None


def test_profile_pids_propagates_query_failure(launcher, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(launcher, "_browser_processes", lambda _exe: None)
    assert launcher._profile_pids("chrome.exe", Path("C:/p"), verify_exe=False) is None


def test_app_title_prefix_accepts_all_our_windows_and_rejects_strays(launcher):
    for title in (
        "Millionvolt Hub",
        "Millionvolt Hub — Assets (구성)",
        "Millionvolt Hub — 프로젝트 관리",
        "Millionvolt Hub - Chrome",  # 브라우저 장식 접미
    ):
        assert launcher._is_app_title(title), title
    for title in ("DevTools - http://127.0.0.1:8010", "새 탭", "사이트에 연결할 수 없음", ""):
        assert not launcher._is_app_title(title), title


def test_watch_gives_up_before_spawn_when_first_query_fails(
    launcher, monkeypatch: pytest.MonkeyPatch
):
    """최초 CIM 실패 → spawn 없이 폴백 코드 반환(고아 앱 창 원천 차단)."""
    monkeypatch.setattr(launcher, "_find_app_browser", lambda: ("chrome", "C:\\x\\chrome.exe"))
    monkeypatch.setattr(launcher, "_profile_pids", lambda *a, **k: None)

    def must_not_spawn(*_a, **_k):
        raise AssertionError("조회 실패 상태에서 spawn 하면 안 된다")

    monkeypatch.setattr(launcher, "_spawn_app_window", must_not_spawn)
    assert launcher.watch_app_window("http://127.0.0.1:8010") == launcher.APP_EXIT_NO_WINDOW


def test_close_app_refuses_when_no_approved_window(launcher, monkeypatch: pytest.MonkeyPatch):
    """승인 창 0 이면 비승인 프로필 창(DevTools 등)을 건드리지 않고 실패를 반환한다."""
    user32 = mock.MagicMock()
    monkeypatch.setattr(launcher, "_user32", lambda: user32)
    monkeypatch.setattr(launcher, "_any_profile_app_hwnds", lambda: ([], [111, 222], True))
    assert launcher.close_app_windows() == 1
    user32.PostMessageW.assert_not_called()


def test_close_app_does_not_claim_success_when_a_browser_query_failed(
    launcher, monkeypatch: pytest.MonkeyPatch
):
    """한 브라우저 조회가 실패하면 그쪽 승인 창을 놓쳤을 수 있다 — 닫되 성공 주장은 안 함."""
    user32 = mock.MagicMock()
    user32.PostMessageW.return_value = 1
    monkeypatch.setattr(launcher, "_user32", lambda: user32)
    monkeypatch.setattr(launcher, "_any_profile_app_hwnds", lambda: ([100], [], False))
    monkeypatch.setattr(launcher, "_approved_alive", lambda _h: False)  # 창은 닫혔다
    assert launcher.close_app_windows() == 1  # all_ok=False → 성공 주장 금지
    user32.PostMessageW.assert_called_once()  # 찾은 승인 창에는 닫기를 보냈다


def test_focus_targets_only_approved_windows(launcher, monkeypatch: pytest.MonkeyPatch):
    """정리 구간에 DevTools 만 남았으면 focus 실패 — '이미 실행 중' 오판 방지."""
    user32 = mock.MagicMock()
    monkeypatch.setattr(launcher, "_user32", lambda: user32)
    monkeypatch.setattr(launcher, "_any_profile_app_hwnds", lambda: ([], [111], True))
    assert launcher._focus_app_window() is False
    user32.SetForegroundWindow.assert_not_called()


# 32비트 int 를 넘는 HWND. 이런 창은 실제로 없지만 Win32 는 0(없음)을 돌려줄 뿐 오류가 아니다.
_BIG_HWND = 0x7FFF_0000_1234
# 32비트 파이썬은 HWND 가 32비트라 큰 값이 잘린다 — 64비트에서만 뜻이 있다(Codex 리뷰 P2).
_win32_only = pytest.mark.skipif(
    sys.platform != "win32" or sys.maxsize <= 2**32, reason="64비트 Win32 user32 전용"
)


@_win32_only
def test_big_hwnd_checks_answer_instead_of_raising(launcher):
    """argtypes 없이 부르면 큰 핸들에서 ctypes.ArgumentError(OverflowError)가 난다(2026-11-05 실측)."""
    user32 = launcher._user32()
    for name in (
        "IsWindow", "IsWindowVisible", "GetWindowThreadProcessId", "GetClassNameW", "GetWindowTextW",
        "ShowWindow", "SetForegroundWindow", "PostMessageW", "SetPropW", "GetPropW",
    ):
        assert getattr(user32, name).argtypes[0] is launcher.wintypes.HWND, name
    assert launcher._approved_alive(_BIG_HWND) is False
    assert launcher._is_marked_approved(_BIG_HWND) is False
    assert launcher._window_title(_BIG_HWND) == ""


@_win32_only
def test_enum_callback_keeps_app_window_with_big_hwnd(launcher, monkeypatch: pytest.MonkeyPatch):
    """EnumWindows 콜백의 예외는 ctypes 가 삼키고 그 창만 조용히 빠진다 — 큰 핸들의 앱 창도 잡혀야 한다.
    진짜 user32 함수로 인자 변환을 거친 뒤(옛 코드는 여기서 실패) 창이 있는 것처럼 답을 꾸민다."""
    real_user32 = launcher._user32
    pid = 4321

    def through_real(real_fn, answer):
        def call(*args):
            real_fn(*args)  # 없는 핸들이라 진짜 답은 늘 0 — 변환만 확인한다
            return answer(*args)
        return call

    def owner(_hwnd, pid_ref):
        pid_ref._obj.value = pid

    def class_name(_hwnd, buffer, _size):
        buffer.value = launcher._APP_WINDOW_CLASS_PREFIX + "1"

    def fake_user32():
        user32 = real_user32()
        user32.IsWindowVisible = through_real(user32.IsWindowVisible, lambda _h: True)
        user32.GetWindowThreadProcessId = through_real(user32.GetWindowThreadProcessId, owner)
        user32.GetClassNameW = through_real(user32.GetClassNameW, class_name)
        user32.EnumWindows = lambda proc, _lparam: proc(_BIG_HWND, 0)  # 진짜 WNDENUMPROC 를 거쳐 넘긴다
        return user32

    swallowed: list = []
    monkeypatch.setattr(sys, "unraisablehook", swallowed.append)
    monkeypatch.setattr(launcher, "_user32", fake_user32)
    assert launcher._visible_app_hwnds({pid}) == [_BIG_HWND]
    assert swallowed == []


def test_spawn_app_window_returns_the_process(launcher, monkeypatch: pytest.MonkeyPatch):
    """spawn 은 Popen 을 반환해야 CIM 실패 시 보조 pid 탐색이 동작한다(코덱스 BLOCK)."""
    sentinel = object()
    captured: dict = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        return sentinel

    monkeypatch.setattr(launcher.subprocess, "Popen", fake_popen)
    got = launcher._spawn_app_window("C:\\x\\chrome.exe", Path("C:/profile"), "http://127.0.0.1:8010")
    assert got is sentinel
    assert any(str(a).startswith("--app=") and "appwin=1" in str(a) for a in captured["args"])


class TestPinnedBrowser:
    """앱 창 브라우저 고정 — 프로필(=캔버스 localStorage)이 브라우저별로 갈리므로, 한 번 쓰기
    시작한 브라우저를 계속 써야 한다. 나중에 Chrome 을 깔거나 지운 것만으로 프로필이 바뀌면
    사용자에겐 작업물이 사라진 것으로 보인다(2026-09-02 현장 사례)."""

    @pytest.fixture
    def home(self, launcher, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
        monkeypatch.delenv("MVHUB_APP_BROWSER", raising=False)
        return tmp_path

    def _installed(self, launcher, monkeypatch: pytest.MonkeyPatch, want: str) -> bool:
        monkeypatch.setenv("MVHUB_APP_BROWSER", want)
        got = launcher._find_app_browser()
        return bool(got and got[0] == want)

    def test_roundtrip_and_junk_is_treated_as_unpinned(self, launcher, home):
        assert launcher._read_pinned_browser() is None
        launcher._pin_browser("edge")
        assert launcher._read_pinned_browser() == "edge"
        launcher._pin_browser("firefox")  # 우리가 쓰는 둘이 아니면 무시
        assert launcher._read_pinned_browser() == "edge"
        launcher._pinned_browser_path().write_text("  CHROME \n", encoding="utf-8")
        assert launcher._read_pinned_browser() == "chrome"  # 공백·대소문자는 허용
        launcher._pinned_browser_path().write_text("[깨짐]", encoding="utf-8")
        assert launcher._read_pinned_browser() is None  # 이상한 값 = 고정 없음(기본 순서로)

    def test_a_failed_write_keeps_the_old_pin_and_leaves_no_temp_file(
        self, launcher, home, monkeypatch: pytest.MonkeyPatch
    ):
        launcher._pin_browser("chrome")

        def boom(*_a, **_k):
            raise OSError("disk full")

        monkeypatch.setattr(launcher.os, "replace", boom)
        launcher._pin_browser("edge")  # 실패해도 예외를 올리지 않는다(실행을 막으면 안 된다)
        assert launcher._read_pinned_browser() == "chrome"
        assert list(launcher._app_window_base().glob("*.tmp")) == []

    def test_pin_wins_over_default_order_but_env_does_not_overwrite_it(
        self, launcher, home, monkeypatch: pytest.MonkeyPatch
    ):
        if not (
            self._installed(launcher, monkeypatch, "chrome")
            and self._installed(launcher, monkeypatch, "edge")
        ):
            pytest.skip("Chrome·Edge 가 모두 설치된 PC 에서만 순서를 검증할 수 있다")
        monkeypatch.delenv("MVHUB_APP_BROWSER", raising=False)
        launcher._pin_browser("edge")
        assert launcher._find_app_browser()[0] == "edge"  # 기본은 Chrome 우선인데 고정이 이긴다
        monkeypatch.setenv("MVHUB_APP_BROWSER", "chrome")
        assert launcher._find_app_browser()[0] == "chrome"  # env 는 이번 실행만 이긴다
        assert launcher._read_pinned_browser() == "edge"  # ★임시 우회가 영구 전환이 되면 안 된다

    def test_env_override_never_rewrites_the_pin(self, launcher, home, monkeypatch: pytest.MonkeyPatch):
        """MVHUB_APP_BROWSER 는 이번 실행만 바꾼다 — 임시 우회가 영구 프로필 전환이 되면 안 된다."""
        launcher._pin_browser("edge")
        monkeypatch.setenv("MVHUB_APP_BROWSER", "chrome")
        launcher._pin_browser("chrome")  # env 우회 중 승인 창을 봐도 고정은 그대로
        assert launcher._read_pinned_browser() == "edge"
        monkeypatch.delenv("MVHUB_APP_BROWSER")
        launcher._pin_browser("chrome")  # 우회가 없으면 정상 갱신
        assert launcher._read_pinned_browser() == "chrome"

    def test_broken_bytes_do_not_crash_the_launcher(self, launcher, home):
        """고정 파일이 깨진 바이트여도 앱 실행을 막지 않는다(고정 없음으로 취급)."""
        path = launcher._pinned_browser_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\xff\xfe\x00chrome")
        assert launcher._read_pinned_browser() is None

    def test_profile_dir_is_per_browser_and_per_install(self, launcher, home):
        chrome = launcher._app_profile_dir("chrome")
        edge = launcher._app_profile_dir("edge")
        assert chrome != edge  # 프로필은 브라우저별로 갈린다 — 그래서 고정이 필요하다
        assert chrome.parent == launcher._app_window_base()
        assert launcher._install_id() in chrome.name


class TestWatchState:
    """감시 상태 머신 전이 — 코덱스가 요구한 회귀 지점들."""

    def _state(self, launcher, now=0.0):
        return launcher._WatchState(now)

    def test_first_window_wait_then_fallback(self, launcher):
        st = self._state(launcher)
        assert st.observe(set(), True, 1.0, lambda h: True) == "waiting"
        late = launcher._APP_FIRST_WINDOW_TIMEOUT + 1.0
        assert st.observe(set(), True, late, lambda h: True) == "fallback"

    def test_query_failure_before_first_approval_holds_instead_of_fallback(self, launcher):
        """spawn 직후 CIM 이 죽으면 40초 시계로 fallback 하면 안 된다 — 고아 창 방지."""
        st = self._state(launcher)
        late = launcher._APP_FIRST_WINDOW_TIMEOUT + 5.0
        assert st.observe(set(), False, late, lambda h: True) == "hold"
        # 조회가 회복됐고 창이 나타났으면 시한이 지났어도 정상 앵커
        assert st.observe({100}, True, late + 1.0, lambda h: True) == "anchored"

    def test_query_recovery_without_window_still_falls_back(self, launcher):
        st = self._state(launcher)
        late = launcher._APP_FIRST_WINDOW_TIMEOUT + 5.0
        st.observe(set(), False, late, lambda h: True)
        assert st.observe(set(), True, late + 1.0, lambda h: True) == "fallback"

    def test_approval_is_sticky_across_title_changes(self, launcher):
        st = self._state(launcher)
        assert st.observe({100}, True, 1.0, lambda h: True) == "anchored"
        # 이후 틱에 제목 불일치로 newly_app 이 비어도(오류 페이지) 창이 살아 있으면 앵커 유지
        assert st.observe(set(), True, 2.0, lambda h: True) == "anchored"
        assert st.approved == {100}

    def test_query_failure_never_advances_shutdown(self, launcher):
        st = self._state(launcher)
        st.observe({100}, True, 1.0, lambda h: True)
        # 창이 사라졌지만 조회도 실패 — 종료 카운터가 늘면 안 된다
        for now in (2.0, 3.0, 4.0):
            assert st.observe(set(), False, now, lambda h: False) == "hold"
        assert st.empty_scans == 0

    def test_long_query_failure_asks_console_back(self, launcher):
        st = self._state(launcher)
        st.observe({100}, True, 1.0, lambda h: True)
        st.observe(set(), False, 2.0, lambda h: False)
        assert (
            st.observe(set(), False, 2.0 + st.CIM_FAIL_SHOW_CONSOLE_AFTER + 1, lambda h: False)
            == "hold_show_console"
        )
        # 조회 회복 + 창 재발견 → 다시 앵커(호출측이 이때만 재숨김)
        assert st.observe({100}, True, 40.0, lambda h: True) == "anchored"

    def test_three_empty_scans_confirm_close(self, launcher):
        st = self._state(launcher)
        st.observe({100}, True, 1.0, lambda h: True)
        assert st.observe(set(), True, 2.0, lambda h: False) == "empty"
        assert st.observe(set(), True, 3.0, lambda h: False) == "empty"
        assert st.observe(set(), True, 4.0, lambda h: False) == "closed"

    def test_window_reappearing_resets_debounce(self, launcher):
        st = self._state(launcher)
        st.observe({100}, True, 1.0, lambda h: True)
        st.observe(set(), True, 2.0, lambda h: False)
        st.observe(set(), True, 3.0, lambda h: False)
        assert st.observe({101}, True, 4.0, lambda h: True) == "anchored"
        assert st.empty_scans == 0


def test_cmds_all_one_shot_gate(launcher):
    """콘솔의 cmd.exe 전부가 /c(일회용)여야 ours — 대화형·/k·명령줄 미독은 숨기지 않는
    방향(False). 대화형 cmd 에서 `cmd /c run.bat` 실행 시 사용자 콘솔 숨김 방지."""
    f = launcher._cmds_all_one_shot
    assert f([]) is True  # cmd 없음(파이썬만) — 호출측이 빈 목록이면 검사 자체를 스킵
    assert f(['cmd /c ""C:\\x\\MV_agent.bat" "', 'cmd /c "python serve.py"']) is True
    assert f(['"C:\\Windows\\system32\\cmd.exe"']) is False  # 대화형(바깥 사용자 셸)
    assert f(['cmd /k "title x"']) is False  # 유지형 — 사용자가 띄워 둔 창
    assert f(["cmd /c ok.bat", None]) is False  # CommandLine 미독 PID — fail-open
    assert f(["cmd /c ok.bat", ""]) is False
    assert f(['cmd /k b.bat /c']) is False  # /k 는 /c 가 함께 있어도 유지형(코덱스 WARN)


def test_console_cmd_cmdlines_query_states(launcher, monkeypatch):
    """cmd 명령줄 CIM 조회 — 성공은 PID 순서 매핑(누락 PID=None 자리), 실패는 None."""
    rows = [
        {"ProcessId": 11, "CommandLine": "cmd /c a.bat"},
        {"ProcessId": 22, "CommandLine": None},
    ]
    monkeypatch.setattr(
        launcher.subprocess, "run", lambda *a, **k: _ps_result(0, json.dumps(rows))
    )
    assert launcher._console_cmd_cmdlines([11, 22, 33]) == ["cmd /c a.bat", None, None]

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(1, ""))
    assert launcher._console_cmd_cmdlines([11]) is None  # cmdlet 실패 — 숨기지 않는 방향

    assert launcher._console_cmd_cmdlines([]) == []  # cmd 없음 — 조회 없이 빈 목록


@pytest.fixture
def watch_scenario(launcher, monkeypatch):
    """감시 틱과 Win32/CIM 경계를 가짜로 진행하며 실제 사용자 창은 건드리지 않는다."""
    def run(frames, *, adopted=(_BIG_HWND,), marker="a" * 32, nonce="a" * 32,
            failed_close=(), spawn_error=None):
        events = []
        current = {"app": list(adopted), "now": 0.0, "tick": -1}
        remaining = iter(frames)

        def sleep(_seconds):
            frame = next(remaining, None)
            assert frame is not None, "감시자가 예정된 마지막 틱에서 끝나지 않았다"
            tick = current["tick"] + 1
            now = current["now"] + 1.0
            current.clear()
            current.update(app=[], now=now)
            current.update(frame)
            current["tick"] = tick

        def profile_pids(*_a, **_k):
            current["queries"] = current.get("queries", 0) + 1
            events.append(("query", current["tick"]))
            if "settle_until" in current:
                current["now"] = current["settle_until"]
            if current.get("recheck"):
                current["app"] = current["recheck"]
            if not current.get("query_ok", True):
                return None
            pids = {11} if (current["app"] or current.get("hidden")) and not current.get("process_gone") else set()
            return pids, pids

        def post(hwnd, message, wparam, lparam):
            events.append(("close", current["tick"], hwnd, message, wparam, lparam))
            return hwnd not in failed_close

        def spawn(*_a):
            console_events = [e for e in events if e[0] == "console"]
            assert not console_events or console_events[-1] == ("console", True)
            events.append(("spawn", current["tick"]))
            if spawn_error:
                raise spawn_error
            return SimpleNamespace(pid=22, poll=lambda: None)

        def outcome(_nonce):
            events.append(("outcome", current["tick"], _nonce))
            return current.get("outcome", True)

        if marker is None:
            monkeypatch.delenv("MVHUB_UPDATE_WINDOW_NONCE", raising=False)
        else:
            monkeypatch.setenv("MVHUB_UPDATE_WINDOW_NONCE", marker)
        monkeypatch.setenv("MVHUB_EXECUTION_NONCE", nonce)
        monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", "1")
        monkeypatch.setattr(launcher, "_find_app_browser", lambda: ("chrome", "chrome.exe"))
        monkeypatch.setattr(launcher, "_app_profile_dir", lambda _name: Path("C:/fake-profile"))
        monkeypatch.setattr(launcher, "_profile_pids", profile_pids)
        monkeypatch.setattr(launcher, "_classify_app_hwnds", lambda _pids: (list(current["app"]), []))
        monkeypatch.setattr(launcher, "_visible_app_hwnds", lambda _pids: list(current["app"]))
        monkeypatch.setattr(launcher, "_approved_alive", lambda hwnd: hwnd in current["app"])
        monkeypatch.setattr(launcher, "_is_marked_approved", lambda hwnd: hwnd not in current.get("unmarked", []))
        monkeypatch.setattr(launcher, "_update_boot_outcome", outcome)
        monkeypatch.setattr(launcher, "_user32", lambda: SimpleNamespace(
            PostMessageW=post, IsWindow=lambda hwnd: hwnd in current["app"] + current.get("hidden", [])))
        monkeypatch.setattr(launcher, "_spawn_app_window", spawn)
        monkeypatch.setattr(launcher, "_pin_browser", lambda name: events.append(("pin", name)))
        monkeypatch.setattr(launcher, "_console_is_ours", lambda: True)
        monkeypatch.setattr(launcher, "_set_console_visible", lambda visible: events.append(("console", visible)))
        monkeypatch.setattr(launcher.time, "sleep", sleep)
        monkeypatch.setattr(launcher.time, "monotonic", lambda: current["now"])
        return SimpleNamespace(run=lambda: launcher.watch_app_window("http://127.0.0.1:8010"), events=events)

    return run


def test_update_replaces_committed_snapshot_once_then_watches_new_window(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND], "outcome": None},
        {"app": [_BIG_HWND, 102]},
        {},  # 옛 HWND 가 없어진 바로 그 틱에 교체
        {"app": [200]},
        {}, {}, {},
    ])
    assert scenario.run() == 0
    assert sorted(e for e in scenario.events if e[0] == "close") == [
        ("close", 1, 102, 0x0010, 0, 0), ("close", 1, _BIG_HWND, 0x0010, 0, 0),
    ]
    assert [e for e in scenario.events if e[0] == "spawn"] == [("spawn", 2)]
    assert [e for e in scenario.events if e == ("query", 2)] == [("query", 2)]
    assert [e for e in scenario.events if e[0] == "pin"] == [("pin", "chrome")]
    assert [e for e in scenario.events if e[0] == "console"] == [
        ("console", False), ("console", True), ("console", False),
    ]


def test_committed_without_live_approved_windows_discards_replacement(launcher, watch_scenario):
    swap = launcher._UpdateWindowSwap("a" * 32, "a" * 32, True)
    assert swap.commit(True, set(), 1.0) == ()
    assert swap.nonce == "" and swap.deadline is None
    scenario = watch_scenario([
        {"app": [_BIG_HWND], "outcome": None}, {}, {}, {},
    ])
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] in ("close", "spawn")]


@pytest.mark.parametrize("outcome", [None, False])
def test_uncommitted_or_rolled_back_update_never_closes_or_spawns(watch_scenario, outcome):
    scenario = watch_scenario([
        {"app": [_BIG_HWND], "outcome": outcome, "now": 170},
        {"app": [_BIG_HWND], "outcome": outcome},
        {"outcome": outcome}, {"outcome": outcome}, {"outcome": outcome},
    ])
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] in ("close", "spawn")]
    if outcome is False:
        assert len([e for e in scenario.events if e[0] == "outcome"]) == 1


@pytest.mark.parametrize("marker,nonce,adopted", [
    (None, "a" * 32, (_BIG_HWND,)),  # 일반 부팅: 예전 committed control 재사용
    ("b" * 32, "a" * 32, (_BIG_HWND,)),
    ("A" * 32, "A" * 32, (_BIG_HWND,)),
    ("a" * 31, "a" * 31, (_BIG_HWND,)),
    ("a" * 32 + "\n", "a" * 32 + "\n", (_BIG_HWND,)),
    ("a" * 32, "a" * 32, ()),
])
def test_non_candidate_boot_does_not_replace(watch_scenario, marker, nonce, adopted):
    scenario = watch_scenario([{"app": [200]}, {}, {}, {}],
                              marker=marker, nonce=nonce, adopted=adopted)
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] in ("close", "outcome")]
    assert len([e for e in scenario.events if e[0] == "spawn"]) == (0 if adopted else 1)


def test_reappearance_resets_debounce_and_late_windows_are_not_closed(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]}, {}, {}, {"app": [200]}, {}, {}, {"app": [200]},
        {}, {}, {},
    ], marker=None)
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] == "close"]
    assert not [e for e in scenario.events if e[0] == "spawn"]


def test_query_failure_holds_replacement_and_recovers_console(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]},
        {"query_ok": False}, {"query_ok": False}, {},
        {"app": [200]}, {}, {}, {},
    ])
    assert scenario.run() == 0
    assert [e for e in scenario.events if e[0] == "spawn"] == [("spawn", 3)]
    first_query = scenario.events.index(("query", 1))
    assert scenario.events[first_query - 1] == ("console", True)
    assert [e for e in scenario.events[:first_query - 1] if e[0] == "console"] == [("console", False)]
    assert [e for e in scenario.events if e in (("query", 1), ("query", 2), ("query", 3))] == [
        ("query", 1), ("query", 2), ("query", 3),
    ]


@pytest.mark.parametrize("unmarked", [False, True])
def test_hidden_old_window_blocks_until_destroyed_or_property_removed(watch_scenario, unmarked):
    frames = [{"app": [_BIG_HWND]}, {"hidden": [_BIG_HWND]}, {"hidden": [_BIG_HWND]}, {"hidden": [_BIG_HWND]},
              {"hidden": [_BIG_HWND]}]
    frames += [{"hidden": [_BIG_HWND], "unmarked": [_BIG_HWND], "process_gone": True} if unmarked else {}]
    frames += [{"app": [200]}, {}, {}, {}]
    scenario = watch_scenario(frames)
    assert scenario.run() == 0
    assert [e for e in scenario.events if e[0] == "spawn"] == [("spawn", 5)]


def test_failed_close_waits_for_surviving_window_without_resending(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND, 102]}, {"app": [102]}, {"app": [102]},
        {}, {"app": [200]}, {}, {}, {},
    ], adopted=(_BIG_HWND, 102), failed_close=(102,))
    assert scenario.run() == 0
    assert len([e for e in scenario.events if e[0] == "close"]) == 2
    assert [e for e in scenario.events if e[0] == "spawn"] == [("spawn", 3)]


def test_window_reappearing_before_spawn_is_adopted_without_another_replacement(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]}, {"recheck": [200]}, {}, {}, {},
    ])
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] == "spawn"]
    assert len([e for e in scenario.events if e[0] == "close"]) == 1
    assert [e for e in scenario.events if e == ("query", 1)] == [("query", 1)]


def test_failed_pre_spawn_recheck_holds_until_query_recovers(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]}, {"query_ok": False}, {},
        {"app": [200]}, {}, {}, {},
    ])
    assert scenario.run() == 0
    assert [e for e in scenario.events if e[0] == "spawn"] == [("spawn", 2)]


def test_cleanup_exception_leaves_console_visible(launcher, monkeypatch, watch_scenario):
    scenario = watch_scenario([{"app": [_BIG_HWND]}, {}, {}, {}])

    def fail(*_args):
        raise OSError("cleanup failed")

    monkeypatch.setattr(launcher, "_wait_app_browser_settle", fail)
    with pytest.raises(OSError, match="cleanup failed"):
        scenario.run()
    assert scenario.events[-1] == ("console", True)


@pytest.mark.parametrize("gone_at,replaced", [(120.9, True), (121.0, False), (121.1, False)])
def test_replacement_reservation_expires_120_seconds_after_close(watch_scenario, gone_at, replaced):
    frames = [{"app": [_BIG_HWND]}, {"now": gone_at}]
    if replaced:
        frames += [{"app": [200], "now": 122}, {"now": 123}, {"now": 124}, {"now": 125}]
    else:
        frames += [{}, {}]
    scenario = watch_scenario(frames)
    assert scenario.run() == 0
    assert bool([e for e in scenario.events if e[0] == "spawn"]) is replaced
    if replaced:
        assert ("spawn", 1) in scenario.events


def test_reservation_expiring_during_settle_never_spawns(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]}, {"now": 120, "settle_until": 122}, {}, {}, {},
    ])
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] == "spawn"]
    assert [e for e in scenario.events if e == ("query", 1)] == [("query", 1)]


def test_hidden_old_window_outlasting_reservation_exits_without_spawn(watch_scenario):
    scenario = watch_scenario([
        {"app": [_BIG_HWND]}, {"hidden": [_BIG_HWND]}, {"hidden": [_BIG_HWND]}, {"hidden": [_BIG_HWND]},
        {"hidden": [_BIG_HWND], "now": 121.1},
    ])
    assert scenario.run() == 0
    assert not [e for e in scenario.events if e[0] == "spawn"]


def test_spawn_exception_leaves_console_visible(watch_scenario):
    scenario = watch_scenario([{"app": [_BIG_HWND]}, {}, {}, {}], spawn_error=OSError("spawn failed"))
    with pytest.raises(OSError, match="spawn failed"):
        scenario.run()
    assert scenario.events[-3:] == [("console", True), ("query", 1), ("spawn", 1)]


def test_replacement_without_new_window_falls_back_with_visible_console(launcher, watch_scenario):
    scenario = watch_scenario([{"app": [_BIG_HWND]}, {}, {}, {}, {"now": 45}])
    assert scenario.run() == launcher.APP_EXIT_NO_WINDOW
    assert [e for e in scenario.events if e[0] == "console"] == [("console", False), ("console", True)]
    assert len([e for e in scenario.events if e[0] == "spawn"]) == 1


@pytest.mark.parametrize("control,nonce,expected", [
    ("1", "a" * 32, "a" * 32), (None, "a" * 32, None), ("", "a" * 32, None),
    ("1", "A" * 32, None), ("1", "a" * 31, None), ("1", "a" * 32 + "\n", None),
])
def test_update_marker_in_child_environment_is_explicit(launcher, monkeypatch, control, nonce, expected):
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    monkeypatch.setenv("MVHUB_UPDATE_WINDOW_NONCE", "inherited-poison")
    monkeypatch.setenv("MVHUB_EXECUTION_NONCE", nonce)
    if control is None:
        monkeypatch.delenv("MVHUB_ACTIVATION_CONTROL", raising=False)
    else:
        monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", control)
    monkeypatch.setattr(launcher, "_native_link_eligible", lambda: False)
    captured = {}

    def create(*args):
        values = dict(item.split("=", 1) for item in "".join(args[6]).split("\0")
                      if item and not item.startswith("="))
        captured["marker"] = values.get("MVHUB_UPDATE_WINDOW_NONCE")
        return True

    launcher._create_suspended_process(SimpleNamespace(CreateProcessW=create), LAUNCHER_PATH)
    assert captured["marker"] == expected
    assert launcher.os.environ["MVHUB_UPDATE_WINDOW_NONCE"] == "inherited-poison"


@pytest.mark.parametrize("got,windows", [(None, []), ((set(), set()), []), (({11}, {11}), [100])])
def test_cleanup_wait_stops_on_failed_query_no_process_or_visible_window(launcher, monkeypatch, got, windows):
    monkeypatch.setattr(launcher, "_profile_pids", lambda *_a: got)
    monkeypatch.setattr(launcher, "_visible_app_hwnds", lambda _pids: windows)
    monkeypatch.setattr(launcher.time, "monotonic", lambda: 0.0)
    monkeypatch.setattr(launcher.time, "sleep", lambda _s: pytest.fail("불필요한 기다림"))
    assert launcher._wait_app_browser_settle("chrome.exe", Path("C:/profile")) is got


def test_cleanup_wait_has_best_effort_deadline_between_queries(launcher, monkeypatch):
    clock = [0.0]
    queries = []

    def query(*_a):
        queries.append(clock[0])
        clock[0] += 2.0  # CIM 조회 시간도 기다림 예산에 포함한다
        return {11}, {11}

    monkeypatch.setattr(launcher, "_profile_pids", query)
    monkeypatch.setattr(launcher, "_visible_app_hwnds", lambda _pids: [])
    monkeypatch.setattr(launcher.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(launcher.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    assert launcher._wait_app_browser_settle("chrome.exe", Path("C:/profile")) == ({11}, {11})
    assert len(queries) > 1
    assert queries[-1] < launcher._APP_BROWSER_CLEANUP_TIMEOUT <= clock[0]
    assert clock[0] < launcher._APP_BROWSER_CLEANUP_TIMEOUT + 2.4
