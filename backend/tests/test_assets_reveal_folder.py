"""어셋 '원본 위치 열기' — 폴더는 그 안을 열고(왼쪽 폴더 트리 우클릭, 2026-11-20), 파일은 상위 폴더에서 골라 둔 채 연다(그대로)."""
from unittest.mock import Mock

import pytest

from app.routers import assets
from app.services.path_safety import path_comparison_key


@pytest.fixture
def project(tmp_path, monkeypatch):
    proj = tmp_path / "Rn D"
    (proj / "assets" / "CH 01").mkdir(parents=True)
    (proj / "assets" / "CH 01" / "a b.png").write_bytes(b"x")
    monkeypatch.setattr(assets, "_safe_project_dir", lambda project, request: proj)
    opener = Mock()
    monkeypatch.setattr(assets.subprocess, "Popen", opener)
    return proj, opener


@pytest.mark.parametrize("platform,command", [("win32", "explorer"), ("darwin", "open"), ("linux", "xdg-open")])
def test_folder_opens_inside_without_select(project, monkeypatch, platform, command):
    proj, opener = project
    monkeypatch.setattr(assets.sys, "platform", platform)
    assert assets.reveal_file(assets.RevealIn(project="RnD", path="assets/CH 01"), None) == {"ok": True}
    target = assets._safe_project_resolve("RnD", proj, "assets/CH 01")
    opener.assert_called_once_with([command, str(path_comparison_key(target))])  # 공백 경로도 인자 하나 그대로


def test_file_still_selects_in_parent_on_windows(project, monkeypatch):
    proj, opener = project
    monkeypatch.setattr(assets.sys, "platform", "win32")
    assets.reveal_file(assets.RevealIn(project="RnD", path="assets/CH 01/a b.png"), None)
    target = assets._safe_project_resolve("RnD", proj, "assets/CH 01/a b.png")
    opener.assert_called_once_with(f'explorer /select,"{path_comparison_key(target)}"')
