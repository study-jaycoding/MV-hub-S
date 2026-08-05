"""생성 통계와 정리 작업의 계정 범위 일치 회귀 테스트."""

from __future__ import annotations

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import db, repo
from app.routers import library


class GenerationStatsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(
            self.tmp.name,
            "content_hub.db",
        )
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self._seed()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _seed(self) -> None:
        rows = [
            ("mine-failed", "failed", "user-me", None),
            ("other-failed", "failed", "user-other", None),
            ("mine-done", "done", "user-me", None),
            ("mine-running", "running", "user-me", None),
            ("mine-deleted", "failed", "user-me", "2026-08-05"),
        ]
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO generation("
                "id, worker_id, prompt, status, creator_uid, deleted_at"
                ") VALUES(?, 'me', 'prompt', ?, ?, ?)",
                rows,
            )

    def test_failed_count_is_scoped_to_current_account(self) -> None:
        mine = repo.generation_stats(
            viewer_id="user-me",
            account_uid="user-me",
        )
        other = repo.generation_stats(
            viewer_id="user-other",
            account_uid="user-other",
        )
        standalone = repo.generation_stats()

        self.assertEqual(mine["failed_count"], 1)
        self.assertEqual(other["failed_count"], 1)
        self.assertEqual(standalone["failed_count"], 2)

    def test_stats_route_passes_same_identity_for_count_and_unread(self) -> None:
        request = SimpleNamespace()
        with (
            patch.object(library, "_account_uid", return_value="user-me"),
            patch.object(
                library.repo,
                "generation_stats",
                return_value={"failed_count": 1, "has_unread": False},
            ) as stats,
        ):
            result = library.generation_stats(request)

        self.assertEqual(result["failed_count"], 1)
        stats.assert_called_once_with(
            viewer_id="user-me",
            account_uid="user-me",
        )


if __name__ == "__main__":
    unittest.main()
