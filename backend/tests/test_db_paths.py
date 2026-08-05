"""DB 경로 모듈 분리의 하위 호환과 우선순위 테스트."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db, db_paths


class DbPathTests(unittest.TestCase):
    def test_environment_path_has_priority_and_db_facade_matches(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            configured = Path(tmp_dir) / "custom.db"
            with patch.dict(
                os.environ,
                {"CONTENT_HUB_DB": str(configured)},
                clear=False,
            ):
                self.assertEqual(db_paths.get_db_path(), configured.resolve())
                self.assertEqual(db.get_db_path(), configured.resolve())

    def test_default_path_is_used_without_account_or_environment(self) -> None:
        with (
            patch.dict(os.environ, {"CONTENT_HUB_DB": ""}, clear=False),
            patch("app.active_account.account_key", return_value=None),
        ):
            self.assertEqual(db_paths.get_db_path(), db_paths.DEFAULT_DB_PATH)

    def test_active_account_path_is_used_without_environment_override(self) -> None:
        account_path = Path("C:/data/account/content_hub.db")
        with (
            patch.dict(os.environ, {"CONTENT_HUB_DB": ""}, clear=False),
            patch("app.active_account.account_key", return_value="user@example.com"),
            patch("app.active_account.account_db_path", return_value=account_path),
        ):
            self.assertEqual(db_paths.get_db_path(), account_path)


if __name__ == "__main__":
    unittest.main()
