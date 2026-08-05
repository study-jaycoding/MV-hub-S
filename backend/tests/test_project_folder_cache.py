"""프로젝트 Render 트리 캐시 회귀 테스트."""

import tempfile
import unittest
import os
import stat
from pathlib import Path
from unittest.mock import patch

from app.services import project_folders


class ProjectFolderCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        (self.root / "Render" / "shot01").mkdir(parents=True)
        (self.root / "Render" / "shot01" / "a.png").write_bytes(b"x")
        project_folders.invalidate_project_folder("p1")

    def tearDown(self):
        project_folders.invalidate_project_folder("p1")
        self.tmp.cleanup()

    def _state(self, *, fresh: bool = False):
        with (
            patch.object(project_folders, "effective_root_path", return_value=str(self.root)),
            patch.object(
                project_folders.repo_manage,
                "get_project_folder",
                return_value={"selected_path": "shot01"},
            ),
        ):
            return project_folders.project_folder_state("p1", fresh=fresh)

    def test_repeated_read_reuses_tree_scan(self):
        with patch.object(
            project_folders,
            "_scan_project_folder",
            wraps=project_folders._scan_project_folder,
        ) as scan:
            first = self._state()
            second = self._state()

        self.assertEqual(scan.call_count, 1)
        self.assertIs(first["tree"], second["tree"])

    def test_fresh_read_and_invalidation_rescan(self):
        self._state()
        (self.root / "Render" / "shot02").mkdir()

        cached = self._state()
        self.assertNotIn("shot02", [node["name"] for node in cached["tree"]["children"]])

        fresh = self._state(fresh=True)
        self.assertIn("shot02", [node["name"] for node in fresh["tree"]["children"]])

        project_folders.invalidate_project_folder("p1")
        (self.root / "Render" / "shot03").mkdir()
        invalidated = self._state()
        self.assertIn("shot03", [node["name"] for node in invalidated["tree"]["children"]])

    def test_tree_scan_uses_scandir_and_keeps_directory_order_and_counts(self):
        render = self.root / "Render"
        (render / "shot02").mkdir()
        (render / "shot02" / "b.png").write_bytes(b"x")

        # Path.iterdir 기반 구현으로 돌아가면 UNC에서 파일마다 메타데이터 조회가 반복된다.
        with patch.object(Path, "iterdir", side_effect=AssertionError("iterdir must not be used")):
            tree, count = project_folders.folder_tree_node(
                render, render, {"nodes": 0, "truncated": 0}
            )

        self.assertEqual(count, 2)
        self.assertEqual([node["name"] for node in tree["children"]], ["shot01", "shot02"])
        self.assertEqual([node["count"] for node in tree["children"]], [1, 1])

    def test_tree_scan_stops_before_exceeding_node_budget(self):
        render = self.root / "Render"
        (render / "shot02").mkdir()
        (render / "shot03").mkdir()
        stats = {"nodes": 0, "truncated": 0}

        tree, _ = project_folders.folder_tree_node(render, render, stats, max_nodes=2)

        self.assertEqual(stats["nodes"], 2)
        self.assertEqual(stats["truncated"], 1)
        self.assertEqual(len(tree["children"]), 1)

    def test_tree_scan_skips_windows_reparse_directory(self):
        class _FakeStat:
            st_file_attributes = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

        class _FakeEntry:
            name = "loop"
            path = "ignored-loop"

            @staticmethod
            def is_dir(*, follow_symlinks=True):
                return True

            @staticmethod
            def is_file(*, follow_symlinks=True):
                return False

            @staticmethod
            def is_symlink():
                return False

            @staticmethod
            def stat(*, follow_symlinks=True):
                return _FakeStat()

        class _FakeScandir:
            def __enter__(self):
                return iter([_FakeEntry()])

            def __exit__(self, *_args):
                return False

        render = self.root / "Render"
        stats = {"nodes": 0, "truncated": 0}
        with patch.object(project_folders.os, "scandir", return_value=_FakeScandir()) as scan:
            tree, count = project_folders.folder_tree_node(
                render, render, stats
            )

        self.assertEqual(scan.call_count, 1)
        self.assertEqual(tree["children"], [])
        self.assertEqual(count, 0)
        self.assertEqual(stats["truncated"], 1)


class ProjectFolderSelectionRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content_hub.db")
        self.root = Path(self.tmp.name) / "project-root"
        (self.root / "Render" / "shot01").mkdir(parents=True)

        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.project = repo.create_project("folder-selection-test")
        repo.set_render_root(self.project["id"], str(self.root))
        from fastapi.testclient import TestClient
        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        from app import db

        self.client.close()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_selection_update_returns_link_without_rescanning_tree(self):
        with patch.object(project_folders, "_scan_project_folder") as scan:
            response = self.client.patch(
                f"/api/manage/project-folders/{self.project['id']}/selection",
                json={"selected_path": "shot01"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["selected_path"], "shot01")
        self.assertNotIn("tree", response.json())
        scan.assert_not_called()


if __name__ == "__main__":
    unittest.main()
