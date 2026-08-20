"""백업 복원 훈련 테스트."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from app import db, manage_db, repo
from app.services.backup_verify import (
    create_sqlite_snapshot,
    discover_backup_set,
    verify_restore_drill,
    verify_restore_set,
)
from app.services.restore_runtime_verify import verify_restored_set_runtime


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

    def test_restore_handles_windows_safe_special_character_paths(self):
        special = self.root / "한글 # backup"
        backup = create_sqlite_snapshot(self.source, special / "content.db")
        report = verify_restore_drill(backup, special / "복원 #1.db")
        self.assertTrue(report["ok"])
        self.assertEqual(report["generation_count"], 1)

    def _create_backup_set(self, stamp: str = "20260816_120000_000001") -> Path:
        sidecar_root = self.root / "sidecar-source"
        sidecar_root.mkdir()
        trash_source = sidecar_root / "content_hub_trash.db"
        with closing(sqlite3.connect(str(trash_source))) as conn:
            conn.execute(
                "CREATE TABLE trashed("
                "id TEXT PRIMARY KEY, trashed_at TEXT NOT NULL, project_id TEXT, "
                "creator_uid TEXT, status TEXT, prompt TEXT, source_name TEXT, "
                "job_id TEXT, payload TEXT NOT NULL)"
            )
            conn.execute(
                "INSERT INTO trashed(id, trashed_at, payload) VALUES('t1','2026-08-16','{}')"
            )
            conn.commit()

        manage_source = sidecar_root / "manage_hub.db"
        with mock.patch.object(manage_db, "MANAGE_DB_PATH", manage_source):
            manage_db.init_manage_db()
            with manage_db.get_connection() as conn:
                conn.execute(
                    "INSERT INTO team_generation_fact("
                    "id, account_email, local_gen_id, workspace_scope"
                    ") VALUES('f1','member@example.invalid','g1','personal')"
                )

        backup_dir = self.root / "backups"
        content_backup = backup_dir / f"content_hub_{stamp}.db"
        create_sqlite_snapshot(self.source, content_backup)
        create_sqlite_snapshot(
            trash_source,
            backup_dir / f"content_trash_{stamp}.db",
        )
        create_sqlite_snapshot(
            manage_source,
            backup_dir / f"manage_hub_{stamp}.db",
        )
        return content_backup

    def test_database_set_restore_requires_exact_timestamp_and_preserves_sources(self):
        content_backup = self._create_backup_set()
        stamp, members = discover_backup_set(content_backup)
        self.assertEqual(stamp, "20260816_120000_000001")
        self.assertEqual(set(members), {"content", "trash", "manage"})
        backup_names_before = sorted(path.name for path in content_backup.parent.iterdir())

        restored_data = self.root / "restored-data"
        report = verify_restore_set(content_backup, restored_data)

        self.assertTrue(report["ok"])
        self.assertEqual(report["files"]["content"]["reconcile_counts"]["generation"], 1)
        self.assertEqual(report["files"]["trash"]["reconcile_counts"]["trashed"], 1)
        self.assertEqual(
            report["files"]["manage"]["reconcile_counts"]["team_generation_fact"],
            1,
        )
        self.assertTrue(
            (restored_data / "db" / "content_hub.db").is_file()
        )
        self.assertTrue(
            (restored_data / "db" / "content_hub_trash.db").is_file()
        )
        self.assertTrue((restored_data / "db" / "manage_hub.db").is_file())
        self.assertEqual(
            sorted(path.name for path in content_backup.parent.iterdir()),
            backup_names_before,
        )

    def test_database_set_restore_rejects_missing_member_before_writing(self):
        backup_dir = self.root / "incomplete"
        content_backup = backup_dir / "content_hub_20260816_130000_000001.db"
        create_sqlite_snapshot(self.source, content_backup)
        restored_data = self.root / "must-stay-empty"

        with self.assertRaisesRegex(FileNotFoundError, "세트가 불완전"):
            verify_restore_set(content_backup, restored_data)
        self.assertFalse((restored_data / "db").exists())

    def test_database_set_restore_preflights_all_destination_collisions(self):
        content_backup = self._create_backup_set("20260816_140000_000001")
        restored_db = self.root / "collision" / "db"
        restored_db.mkdir(parents=True)
        existing = restored_db / "content_hub.db"
        existing.write_text("keep", encoding="utf-8")

        with self.assertRaisesRegex(FileExistsError, "복원 대상이 이미 존재"):
            verify_restore_set(content_backup, self.root / "collision")
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")
        self.assertFalse((restored_db / "content_hub_trash.db").exists())
        self.assertFalse((restored_db / "manage_hub.db").exists())

    @unittest.skipUnless(os.name == "nt", "Windows 격리 서버 복원 드릴")
    def test_restored_set_boots_ready_logs_in_and_preserves_core_counts(self):
        content_backup = self._create_backup_set("20260816_150000_000001")
        restored_data = self.root / "runtime-restore"
        verify_restore_set(content_backup, restored_data)

        report = verify_restored_set_runtime(restored_data, timeout_seconds=45)

        self.assertTrue(report["ok"])
        self.assertTrue(report["ready"])
        self.assertEqual(report["ready_checks"], {
            "content": "ok",
            "trash": "ok",
            "manage": "ok",
        })
        self.assertEqual(report["login"], "ok")
        self.assertEqual(
            report["temporary_bootstrap_deltas"],
            {"account": 1, "creator": 1},
        )
        self.assertEqual(report["reconcile_counts"]["content"]["generation"], 1)
        self.assertEqual(report["reconcile_counts"]["trash"]["trashed"], 1)
        self.assertEqual(
            report["reconcile_counts"]["manage"]["team_generation_fact"],
            1,
        )
        self.assertTrue(report["loopback_only"])
        self.assertTrue(report["process_stopped"])

    def test_database_set_rejects_nonempty_uncheckpointed_wal(self):
        content_backup = self._create_backup_set("20260816_155000_000001")
        wal_path = Path(str(content_backup) + "-wal")
        wal_path.write_bytes(b"not-a-checkpointed-backup")

        with self.assertRaisesRegex(ValueError, "미반영 WAL"):
            verify_restore_set(content_backup, self.root / "wal-restore")
        self.assertFalse((self.root / "wal-restore" / "db").exists())


if __name__ == "__main__":
    unittest.main()
