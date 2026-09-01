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
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")


def test_browser_processes_three_states(launcher, monkeypatch: pytest.MonkeyPatch):
    row = {"ProcessId": 42, "ExecutablePath": "C:\\x\\chrome.exe", "CommandLine": "chrome --user-data-dir=C:\\p"}

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, json.dumps(row)))
    assert launcher._browser_processes("chrome.exe") == [
        {"pid": 42, "exe": "C:\\x\\chrome.exe", "cmdline": "chrome --user-data-dir=C:\\p"}
    ]

    monkeypatch.setattr(launcher.subprocess, "run", lambda *a, **k: _ps_result(0, ""))
    assert launcher._browser_processes("chrome.exe") == []  # 성공 + 없음

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
