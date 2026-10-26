"""별도 창을 앱 창 위로(services/app_windows · routers/app_windows) — 기록 docs/status/별도창_앞으로_2026-10-26.md."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import mutation_notify
from app.routers import _proxy
from app.routers import app_windows as router_mod
from app.services import app_windows, request_guards

MAIN = "Millionvolt Hub"
ASSETS = "Millionvolt Hub — Assets (구성)"
MANAGE = "Millionvolt Hub — 프로젝트 관리"
CHROME, OTHER = 100, 200


def test_pick_same_process_titles_only_when_app_window_is_in_front():
    windows = [
        (1, CHROME, MAIN + " - Chrome"),  # 맨 앞 = 앱 창(일반 크롬 창 — 꼬리가 붙는다)
        (2, OTHER, "제목 없음 - Windows 메모장"),
        (3, CHROME, MANAGE + " - Chrome"),
        (4, OTHER, ASSETS),  # 다른 프로세스의 같은 제목 — 안 올린다
        (5, CHROME, "다른 페이지 - Chrome"),
        (6, CHROME, ASSETS),
        (7, CHROME, ASSETS + "X"),  # 제목 앞부분만 같다 — 안 올린다
    ]
    assert app_windows.pick(windows, 1, MAIN, [ASSETS, MANAGE]) == [3, 6]
    assert app_windows.pick(windows, 2, MAIN, [ASSETS, MANAGE]) == []  # 그새 다른 프로그램이 맨 앞
    assert app_windows.pick(windows, 5, MAIN, [ASSETS]) == []  # 같은 크롬의 다른 창이 맨 앞
    assert app_windows.pick(windows, 99, MAIN, [ASSETS]) == []  # 맨 앞 창이 목록에 없다(최소화 등)
    assert app_windows.pick([(1, CHROME, ASSETS), (2, CHROME, MAIN)], 1, ASSETS, [ASSETS]) == []  # 맨 앞 창 자신은 안 건드린다


class FakeApi:
    def __init__(self, windows, foreground):
        self._windows, self._foreground, self.lifted = windows, foreground, []

    def windows(self):
        return self._windows

    def foreground(self):
        return self._foreground

    def lift(self, hwnd):
        self.lifted.append(hwnd)


def test_raise_lifts_bottom_first_so_popups_keep_their_order():
    api = FakeApi([(1, CHROME, MAIN), (3, CHROME, MANAGE), (6, CHROME, ASSETS)], 1)
    assert app_windows.raise_over_foreground(MAIN, [ASSETS, MANAGE], api) == 2
    assert api.lifted == [6, 3]  # 아래(Assets) 먼저 → 위(관리)가 마지막에 맨 위 — 둘의 앞뒤 그대로


def test_lift_is_topmost_then_notopmost_without_activation():
    calls = []
    api = app_windows.Win32.__new__(app_windows.Win32)
    api.W = ctypes.wintypes
    signed = lambda handle: ctypes.c_ssize_t(handle.value).value  # HWND(-1).value 는 부호 없는 값으로 읽힌다
    api.user32 = types.SimpleNamespace(SetWindowPos=lambda hwnd, after, x, y, w, h, flags: calls.append((hwnd, signed(after), flags)))
    api.lift(42)
    noactivate, nomove, nosize, asyncpos = 0x0010, 0x0002, 0x0001, 0x4000
    assert [(h, after) for h, after, _ in calls] == [(42, app_windows.HWND_TOPMOST), (42, app_windows.HWND_NOTOPMOST)]
    assert all(flags & noactivate and flags & nomove and flags & nosize and flags & asyncpos for _, _, flags in calls)


@pytest.fixture
def api(monkeypatch):
    calls = []
    monkeypatch.setattr(router_mod.app_windows, "raise_over_foreground", lambda main, titles: calls.append((main, titles)) or len(titles))
    monkeypatch.setattr(router_mod, "os", types.SimpleNamespace(name="nt"))
    monkeypatch.setattr(_proxy, "is_shared_team_server", lambda: False)
    monkeypatch.setattr(request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1", "::1", "localhost"}))
    app = FastAPI()
    app.include_router(router_mod.router)
    client = TestClient(app, base_url="http://127.0.0.1:8010", client=("127.0.0.1", 50000))
    return types.SimpleNamespace(app=app, client=client, calls=calls)


BODY = {"main": MAIN, "titles": [ASSETS, MANAGE]}


def test_raise_route_calls_service_for_this_pc(api):
    response = api.client.post("/api/app-windows/raise", json=BODY)
    assert response.status_code == 200 and response.json() == {"raised": 2}
    assert api.calls == [(MAIN, [ASSETS, MANAGE])]


def test_raise_route_refuses_other_pc(api):
    remote = TestClient(api.app, base_url="http://127.0.0.1:8010", client=("192.168.1.50", 50000))
    assert remote.post("/api/app-windows/raise", json=BODY).status_code == 403
    assert api.calls == []


@pytest.mark.parametrize("change", ["posix", "team"])
def test_raise_route_does_nothing_off_windows_or_on_team_server(api, monkeypatch, change):
    if change == "posix":
        monkeypatch.setattr(router_mod, "os", types.SimpleNamespace(name="posix"))
    else:
        monkeypatch.setattr(_proxy, "is_shared_team_server", lambda: True)
    assert api.client.post("/api/app-windows/raise", json=BODY).json() == {"raised": 0}
    assert api.calls == []


@pytest.mark.parametrize("body", [{"main": MAIN, "titles": []}, {"main": "", "titles": [ASSETS]}, {"main": MAIN, "titles": ["x"] * 9},
                                  {"main": MAIN, "titles": ["x" * 201]}])
def test_raise_route_validates_body(api, body):
    assert api.client.post("/api/app-windows/raise", json=body).status_code == 422
    assert api.calls == []


def test_raise_path_is_local_and_not_a_library_change():
    assert _proxy.is_local_path("/api/app-windows/raise")
    assert mutation_notify.notification_domains("POST", "/api/app-windows/raise", 200) == ()
