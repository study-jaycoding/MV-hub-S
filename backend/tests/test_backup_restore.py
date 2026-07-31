"""백업 복원 훈련 테스트."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app import db, repo
from app.services.backup_verify import create_sqlite_snapshot, verify_restore_drill


class BackupRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.source = self.root / "source.db"
        os.environ["CONTENT_HUB_DB"] = str(self.source)
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at) "
                "VALUES('g1','me','restore me','done','2026-07-31')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_online_snapshot_restores_with_same_rows_and_integrity(self):
        backup = create_sqlite_snapshot(self.source, self.root / "backup.db")
        report = verify_restore_drill(backup, self.root / "restored.db")
        self.assertTrue(report["ok"])
        self.assertEqual(report["generation_count"], 1)
        self.assertEqual(report["integrity"], "ok")
        self.assertEqual(report["foreign_key_errors"], 0)
        with closing(sqlite3.connect(str(self.root / "restored.db"))) as conn:
            self.assertEqual(
                conn.execute("SELECT prompt FROM generation WHERE id='g1'").fetchone()[0],
                "restore me",
            )

    def test_existing_destination_is_never_overwritten(self):
        destination = self.root / "existing.db"
        destination.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            create_sqlite_snapshot(self.source, destination)
        self.assertEqual(destination.read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
