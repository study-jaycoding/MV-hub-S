"""Assets 다중 메타 저장의 원자성과 계정 범위 테스트."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from app import db, repo
from app.repo import assets as asset_repo


class AssetMetadataBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_batch_writes_tags_and_color_for_one_owner(self) -> None:
        self.assertEqual(
            repo.set_asset_tags_batch(
                [("project-a", "a.png", ["hero"]), ("project-b", "b.png", ["bg"])],
                "user-a",
            ),
            2,
        )
        self.assertEqual(
            repo.set_asset_colors_batch(
                [("project-a", "a.png"), ("project-b", "b.png")],
                "green",
                "user-a",
            ),
            2,
        )

        self.assertEqual(repo.get_asset_meta("project-a", "user-a")["a.png"]["tags"], ["hero"])
        self.assertEqual(repo.get_asset_meta("project-a", "user-a")["a.png"]["color"], "green")
        self.assertEqual(repo.get_asset_meta("project-b", "user-a")["b.png"]["tags"], ["bg"])
        self.assertEqual(repo.get_asset_meta("project-a", "other"), {})

    def test_batch_writes_sources_and_preserves_owner_scope(self) -> None:
        self.assertEqual(
            repo.set_asset_sources_batch(
                [
                    ("project-a", "a.png", "hero", True, "sha-a"),
                    ("project-a", "b.png", "background", True, None),
                ],
                "user-a",
            ),
            2,
        )

        meta = repo.get_asset_meta("project-a", "user-a")
        self.assertTrue(meta["a.png"]["is_source"])
        self.assertEqual(meta["a.png"]["source_name"], "hero")
        self.assertTrue(meta["b.png"]["is_source"])
        self.assertEqual(repo.get_asset_meta("project-a", "other"), {})

    def test_batch_rolls_back_all_items_when_one_write_fails(self) -> None:
        original = asset_repo._ensure_asset_meta
        calls = 0

        def fail_second(conn, project, path, owner_uid):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated write failure")
            return original(conn, project, path, owner_uid)

        with patch.object(asset_repo, "_ensure_asset_meta", side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError, "simulated write failure"):
                repo.set_asset_tags_batch(
                    [("project-a", "first.png", ["A"]), ("project-a", "second.png", ["B"])],
                    "user-a",
                )

        self.assertEqual(repo.get_asset_meta("project-a", "user-a"), {})


if __name__ == "__main__":
    unittest.main()
