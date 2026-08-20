"""Assets 자동 마운트의 워크스페이스 스코프 — fail-close·필터·전환 경쟁 회귀.

배경: 팀 워크스페이스 선택 중에도 다른 워크스페이스 프로젝트 폴더가 Assets 에
노출되던 버그. 규칙 = 팀 선택 중엔 그 워크스페이스 프로젝트만(라이브러리와 동일),
개인 컨텍스트는 전체, '미확인'은 자동 마운트 숨김(fail-close — 노출·업로드 차단).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.routers import assets as assets_router
from app.services import cli_bridge


REQ = SimpleNamespace(state=SimpleNamespace(account=None))


@pytest.fixture(autouse=True)
def _reset_workspace_state(monkeypatch):
    monkeypatch.setattr(cli_bridge, "_ws_gen", 0)
    monkeypatch.setattr(cli_bridge, "_ws_state", (0, False, None, 0.0))
    monkeypatch.setattr(assets_router, "MANAGE_ENABLED", True)


def _fake_projects(seen: dict):
    def fake_list_projects(include_archived=False, member_uid=None, workspace_id=None, **_kw):
        seen["workspace_id"] = workspace_id
        return {
            "projects": [
                {"id": "p1", "name": "P1", "render_root_path": r"C:\tmp\p1"},
            ]
        }

    return fake_list_projects


def test_unknown_workspace_fails_closed(monkeypatch):
    """미확인(CLI 조회 실패) → 자동 마운트 없음 — 타 워크스페이스 노출 차단."""

    async def broken_list_workspaces(timeout=30.0):
        return []  # CLI 실패와 동일한 계약(list_workspaces 는 실패 시 [])

    monkeypatch.setattr(cli_bridge, "list_workspaces", broken_list_workspaces)
    monkeypatch.setattr(assets_router.repo, "list_projects", _fake_projects({}))
    assert assets_router._auto_project_mounts(REQ) == []


def test_team_workspace_filters_projects(monkeypatch):
    """확정 팀 컨텍스트 → repo.list_projects 에 그 workspace_id 로 필터."""
    cli_bridge._ws_set_known("ws-1")
    seen: dict = {}
    monkeypatch.setattr(assets_router.repo, "list_projects", _fake_projects(seen))
    mounts = assets_router._auto_project_mounts(REQ)
    assert seen["workspace_id"] == "ws-1"
    assert [m["name"] for m in mounts] == ["P1"]


def test_personal_context_shows_all(monkeypatch):
    """확정 개인 컨텍스트(None) → 필터 없이 전체(기존 동작)."""
    cli_bridge._ws_set_known(None)
    seen: dict = {}
    monkeypatch.setattr(assets_router.repo, "list_projects", _fake_projects(seen))
    mounts = assets_router._auto_project_mounts(REQ)
    assert seen["workspace_id"] is None
    assert [m["name"] for m in mounts] == ["P1"]


def test_late_lookup_does_not_override_switch(monkeypatch):
    """조회 중 전환이 일어나면 늦게 온 옛 결과를 버린다(세대 가드 — 코덱스 P1)."""

    async def slow_list_workspaces(timeout=30.0):
        # 조회가 도는 사이 사용자가 ws-new 로 전환한 상황 재현
        cli_bridge._ws_set_known("ws-new")
        return [{"id": "ws-old", "is_selected": True}]

    monkeypatch.setattr(cli_bridge, "list_workspaces", slow_list_workspaces)
    asyncio.run(cli_bridge._resolve_selected_workspace())
    known, wid = cli_bridge.selected_workspace_state()
    assert (known, wid) == (True, "ws-new")


def test_resolve_records_state_and_single_flight_reuses_it(monkeypatch):
    """미확인 → blocking 조회 1회로 확정, 이후 호출은 CLI 없이 재사용."""
    calls = {"n": 0}

    async def fake_list_workspaces(timeout=30.0):
        calls["n"] += 1
        return [{"id": "ws-9", "is_selected": True}]

    monkeypatch.setattr(cli_bridge, "list_workspaces", fake_list_workspaces)
    assert cli_bridge.resolve_selected_workspace_blocking() == (True, "ws-9")
    assert cli_bridge.resolve_selected_workspace_blocking() == (True, "ws-9")
    assert calls["n"] == 1
