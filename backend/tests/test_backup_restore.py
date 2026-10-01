"""백업 복원 훈련 테스트."""

import hashlib
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from app import db, manage_db, repo
from app.repo.manage_schema import ensure_manage_schema
from app.services.backup_verify import (
    create_sqlite_snapshot,
    discover_backup_set,
    inspect_sqlite_database,
    verify_restore_drill,
    verify_restore_set,
)
from app.services.restore_runtime_verify import verify_restored_set_runtime


def _drift_index(path: Path, index: str, sql: str) -> None:
    """다른 SQLite 엔진이 만든 색인을 흉내 낸다 — 저장된 키는 두고 정의만 바꿔 이 엔진의 재계산과 어긋나게 한다.
    실제(2026-10-01): 3.45 가 만든 julianday 색인을 3.49 가 검사하면 같은 'row N missing from index' 가 난다."""
    with closing(sqlite3.connect(str(path))) as conn:
        conn.execute("PRAGMA writable_schema=ON")
        conn.execute("UPDATE sqlite_master SET sql=? WHERE type='index' AND name=?", (sql, index))
        conn.commit()


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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

    def _add_credit_rows(self):
        with db.get_connection() as conn:
            ensure_manage_schema(conn)
            conn.executemany(
                "INSERT INTO credit_txn(id, owner_uid, account_email, credits, action, created_at) "
                "VALUES(?,?,?,?,?,?)",
                [
                    ("t1", "u1", "a@example.invalid", 1.5, "spend", "2026-09-20T05:12:33.999612Z"),
                    ("t2", "u2", "b@example.invalid", 2.0, "spend", "2026-09-20T05:12:34.500000Z"),
                ],
            )

    def test_engine_drifted_expression_index_is_rebuilt_on_the_restored_copy_only(self):
        """옛 엔진이 만든 계산식 색인은 새 엔진에서 어긋나 보인다 — 복원 사본에서만 다시 만들고, 원본 백업은 손대지 않는다."""
        self._add_credit_rows()
        backup = create_sqlite_snapshot(self.source, self.root / "drift.db")
        _drift_index(
            backup,
            "idx_credit_txn_julian",
            "CREATE INDEX idx_credit_txn_julian ON credit_txn(julianday(created_at,'+1 day'))",
        )
        before = _sha(backup)

        with self.assertRaisesRegex(ValueError, "missing from index idx_credit_txn_julian"):
            inspect_sqlite_database(backup)
        report = verify_restore_drill(backup, self.root / "restored.db")

        self.assertEqual(report["index_rebuilt"], ["idx_credit_txn_julian"])
        self.assertEqual(inspect_sqlite_database(self.root / "restored.db")["index_drift"], [])
        self.assertEqual(_sha(backup), before)

    def test_plain_column_index_mismatch_is_never_treated_as_engine_drift(self):
        """일반 열 색인의 누락이 하나라도 섞이면 진짜 손상일 수 있다 — 계산식 어긋남과 같이 있어도 거부한다."""
        self._add_credit_rows()
        backup = create_sqlite_snapshot(self.source, self.root / "mixed.db")
        _drift_index(
            backup,
            "idx_credit_txn_julian",
            "CREATE INDEX idx_credit_txn_julian ON credit_txn(julianday(created_at,'+1 day'))",
        )
        _drift_index(
            backup,
            "idx_credit_txn_owner",
            "CREATE INDEX idx_credit_txn_owner ON credit_txn(account_email, created_at)",
        )

        with self.assertRaisesRegex(ValueError, "integrity_check 실패"):
            inspect_sqlite_database(backup, allow_index_drift=True)
        with self.assertRaisesRegex(ValueError, "integrity_check 실패"):
            verify_restore_drill(backup, self.root / "restored.db")

    def test_backup_set_rebuilds_drifted_manage_and_unique_expression_indexes(self):
        stamp = "20260816_160000_000001"
        content_backup = self._create_backup_set(stamp)
        manage_backup = content_backup.parent / f"manage_hub_{stamp}.db"
        with closing(sqlite3.connect(str(manage_backup))) as conn:
            conn.execute(
                "INSERT INTO team_generation_fact(id, account_email, local_gen_id, workspace_scope, created_at) "
                "VALUES('f2','member@example.invalid','g2','personal','2026-09-20T05:12:33.999612Z')"
            )
            conn.commit()
        _drift_index(
            manage_backup,
            "idx_tgf_julian",
            "CREATE INDEX idx_tgf_julian ON team_generation_fact(julianday(created_at,'+1 day'))",
        )
        with closing(sqlite3.connect(str(content_backup))) as conn:
            conn.execute("INSERT INTO project(id, name) VALUES('p1','Alpha')")
            conn.commit()
        _drift_index(
            content_backup,
            "idx_project_active_name",
            "CREATE UNIQUE INDEX idx_project_active_name ON project(UPPER(TRIM(name))) WHERE archived=0",
        )

        report = verify_restore_set(content_backup, self.root / "drift-set")

        self.assertEqual(report["files"]["manage"]["index_rebuilt"], ["idx_tgf_julian"])
        self.assertEqual(report["files"]["content"]["index_rebuilt"], ["idx_project_active_name"])
        self.assertEqual(report["files"]["trash"]["index_rebuilt"], [])

    def test_unique_collision_while_rebuilding_fails_and_leaves_no_restored_files(self):
        """새 엔진에서 UNIQUE 계산식 키가 겹치면 다시 만들 수 없다 — 멈추고 복원 사본을 남기지 않는다."""
        stamp = "20260816_170000_000001"
        content_backup = self._create_backup_set(stamp)
        with closing(sqlite3.connect(str(content_backup))) as conn:
            conn.executemany("INSERT INTO project(id, name) VALUES(?,?)", [("p1", "Alpha"), ("p2", "Bravo")])
            conn.commit()
        _drift_index(
            content_backup,
            "idx_project_active_name",
            "CREATE UNIQUE INDEX idx_project_active_name ON project(LENGTH(name)) WHERE archived=0",
        )

        with self.assertRaises(sqlite3.IntegrityError):
            verify_restore_set(content_backup, self.root / "collide")
        self.assertEqual(list((self.root / "collide" / "db").glob("*")), [])

    def test_single_drill_cleans_up_its_copy_when_the_rebuild_collides(self):
        with db.get_connection() as conn:
            conn.executemany("INSERT INTO project(id, name) VALUES(?,?)", [("p1", "Alpha"), ("p2", "Bravo")])
        backup = create_sqlite_snapshot(self.source, self.root / "single.db")
        _drift_index(
            backup,
            "idx_project_active_name",
            "CREATE UNIQUE INDEX idx_project_active_name ON project(LENGTH(name)) WHERE archived=0",
        )
        restored = self.root / "single-restored.db"

        with self.assertRaises(sqlite3.IntegrityError):
            verify_restore_drill(backup, restored)
        self.assertEqual(list(self.root.glob("single-restored.db*")), [])

    def test_integrity_error_message_stays_one_short_line(self):
        """외부 DB 의 색인 이름에 줄바꿈·긴 글자가 있어도 오류는 한 줄로 짧게(로그·콘솔 오염 방지)."""
        path = self.root / "weird.db"
        name = "bad\nname" + "x" * 500
        with closing(sqlite3.connect(str(path))) as conn:
            conn.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)")
            conn.execute(f'CREATE INDEX "{name}" ON t(a)')
            conn.executemany("INSERT INTO t(a, b) VALUES(?,?)", [("1", "x"), ("2", "y")])
            conn.commit()
        _drift_index(path, name, f'CREATE INDEX "{name}" ON t(b)')

        with self.assertRaises(ValueError) as caught:
            inspect_sqlite_database(path, required_tables=set())
        message = str(caught.exception)
        self.assertNotIn("\n", message)
        self.assertLess(len(message), 800)
        self.assertIn("integrity_check 실패", message)


if __name__ == "__main__":
    unittest.main()
