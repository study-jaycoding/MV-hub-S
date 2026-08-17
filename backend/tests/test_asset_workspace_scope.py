"""에셋 폴더 목록의 워크스페이스 범위 계약.

생성 탭과 같은 규칙이다 — 팀을 고른 동안에는 그 팀 프로젝트에서 파생된 폴더만 보이고,
사용자가 직접 등록한 수동 폴더는 팀 소속이 아니므로 언제나 보인다. 예전에는 워크스페이스가
아예 전달되지 않아 다른 팀(그리고 read_all 보유자에겐 전 조직)의 폴더가 섞여 나왔다.
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.routers import assets


class AssetWorkspaceScopeTests(unittest.TestCase):
    def setUp(self):
        self.request = SimpleNamespace(state=SimpleNamespace(account=None))
        self.captured: dict = {}

        def fake_list_projects(**kwargs):
            self.captured = kwargs
            rows = [
                {"id": "p-a", "name": "팀A폴더", "render_root_path": r"Z:\A",
                 "workspace_scope": "team", "workspace_id": "ws-a"},
                {"id": "p-b", "name": "팀B폴더", "render_root_path": r"Z:\B",
                 "workspace_scope": "team", "workspace_id": "ws-b"},
            ]
            wid = kwargs.get("workspace_id")
            if wid:  # repo.list_projects 의 실제 필터와 같은 의미
                rows = [r for r in rows if r["workspace_id"] == wid]
            return {"projects": rows}

        self.patches = [
            patch.object(assets.repo, "list_projects", side_effect=fake_list_projects),
            patch.object(assets, "MANAGE_ENABLED", True),
            patch.object(assets, "AUTH_ENABLED", False),  # read_all 경로(가장 넓은 가시성)
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_team_selection_keeps_only_that_workspace(self):
        names = [m["name"] for m in assets._auto_project_mounts(self.request, "ws-a")]

        self.assertEqual(names, ["팀A폴더"])
        self.assertEqual(self.captured.get("workspace_id"), "ws-a")

    def test_personal_or_no_selection_shows_all(self):
        # 개인·미선택은 좁히지 않는다(생성 탭과 동일) — workspace_id 를 넘기지 않는다.
        names = [m["name"] for m in assets._auto_project_mounts(self.request, None)]

        self.assertEqual(sorted(names), ["팀A폴더", "팀B폴더"])
        self.assertIsNone(self.captured.get("workspace_id"))

    def test_manual_mounts_are_never_filtered_by_workspace(self):
        """수동 등록 폴더는 프로젝트 조회 경로를 타지 않아 팀 선택과 무관하게 남는다."""
        manual = [{"name": "내폴더", "path": r"D:\내자료", "owner": "me"}]
        with patch.object(assets, "_owner_mounts", return_value=manual), \
             patch.object(assets, "_resolve_mount_path", return_value=None), \
             patch.object(assets, "actor_id", return_value="me"):
            payload = assets._mounts_payload(self.request, "ws-a")

        names = [m["name"] for m in payload["mounts"]]
        self.assertIn("내폴더", names)      # 수동 — 항상
        self.assertIn("팀A폴더", names)     # 선택 팀 — 보임
        self.assertNotIn("팀B폴더", names)  # 다른 팀 — 숨김


if __name__ == "__main__":
    unittest.main()
