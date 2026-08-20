"""주기 백업 원자성 테스트 — 잘린/미검증 파일이 정상 백업 이름으로 남지 않는 불변식."""

import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

from app import db, repo
from app.services import backup
from app.services.sqlite_db import HubDbValidationError


class BackupAtomicityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(self.root / "source.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.backup_dir = self.root / "backups"
        # 활성 계정 유무와 무관하게 백업 폴더를 고정(개발 PC 로그인 상태에 안 휘둘리게)
        self._patch = mock.patch.object(backup, "_backup_dir", lambda: self.backup_dir)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _backups(self):
        return sorted(self.backup_dir.glob("content_hub_*.db")) if self.backup_dir.is_dir() else []

    def test_success_leaves_validated_backup_and_no_tmp(self):
        path = backup.backup_now()
        self.assertIsNotNone(path)
        self.assertEqual(self._backups(), [path])
        # tmp 잔재 없음(성공 시 os.replace 로 소진)
        self.assertEqual(list(self.backup_dir.glob(".content_hub_*")), [])

    def test_validation_failure_leaves_no_backup_and_keeps_existing(self):
        good = backup.backup_now()  # 기존 정상 백업 1개
        with mock.patch.object(
            backup, "validate_hub_db", side_effect=HubDbValidationError("integrity")
        ):
            with self.assertRaises(HubDbValidationError):
                backup.backup_now()
        # 실패한 시도는 정상 백업 이름으로 남지 않고, 기존 백업은 그대로다.
        self.assertEqual(self._backups(), [good])
        self.assertEqual(list(self.backup_dir.glob(".content_hub_*")), [])

    def test_stale_tmp_is_cleaned_but_fresh_tmp_is_kept(self):
        self.backup_dir.mkdir(parents=True)
        stale = self.backup_dir / ".content_hub_x.db.tmp-dead0000"
        fresh = self.backup_dir / ".content_hub_y.db.tmp-beef0000"
        stale.write_bytes(b"junk")
        fresh.write_bytes(b"junk")
        old = time.time() - 2 * 86400
        os.utime(stale, (old, old))
        backup.backup_now()
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_consecutive_backups_do_not_collide(self):
        # 마이크로초 스탬프 — 같은 초의 연속 백업이 서로를 덮지 않는다.
        p1 = backup.backup_now()
        p2 = backup.backup_now()
        self.assertNotEqual(p1, p2)
        self.assertEqual(len(self._backups()), 2)

    def test_changed_metadata_waits_for_quiet_and_minimum_interval(self):
        with (
            mock.patch.object(backup, "BACKUP_CHANGE_DEBOUNCE", 300.0),
            mock.patch.object(backup, "BACKUP_MIN_INTERVAL", 900.0),
        ):
            self.assertFalse(backup._change_backup_due(100.0, 1_000.0, now=399.9))
            self.assertFalse(backup._change_backup_due(100.0, 899.9, now=400.0))
            self.assertTrue(backup._change_backup_due(100.0, 900.0, now=400.0))
            self.assertTrue(backup._change_backup_due(100.0, None, now=400.0))
            self.assertFalse(backup._change_backup_due(None, 1_000.0, now=400.0))

    def test_content_trash_and_manage_are_published_as_one_backup_set(self):
        trash = self.root / "content_hub_trash.db"
        manage = self.root / "manage_hub.db"
        with closing(sqlite3.connect(trash)) as conn:
            conn.execute("CREATE TABLE trashed(id TEXT PRIMARY KEY, data TEXT)")
            conn.execute("INSERT INTO trashed VALUES('trash-1', 'kept')")
            conn.commit()
        with closing(sqlite3.connect(manage)) as conn:
            conn.execute(
                "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY, status TEXT)"
            )
            conn.execute("INSERT INTO team_generation_fact VALUES('fact-1', 'done')")
            conn.commit()

        primary = backup.backup_now(stamp="20260813_120000_000001")
        trash_copy = self.backup_dir / "content_trash_20260813_120000_000001.db"
        manage_copy = self.backup_dir / "manage_hub_20260813_120000_000001.db"

        self.assertTrue(primary.is_file())
        self.assertTrue(trash_copy.is_file())
        self.assertTrue(manage_copy.is_file())
        with closing(sqlite3.connect(trash_copy)) as conn:
            self.assertEqual(conn.execute("SELECT data FROM trashed").fetchone()[0], "kept")
        with closing(sqlite3.connect(manage_copy)) as conn:
            self.assertEqual(
                conn.execute("SELECT status FROM team_generation_fact").fetchone()[0],
                "done",
            )
        info = backup.list_backups_info()[0]
        self.assertEqual(
            set(info["files"]), {primary.name, trash_copy.name, manage_copy.name}
        )

    def test_manage_db_outside_content_folder_is_still_backed_up(self):
        # 계정 로그인 시 콘텐츠 DB는 acct/<slug>/ 아래로 가지만 manage_hub.db 는 고정
        # 경로에 남는다 — src.parent 만 보면 관리 DB가 백업 세트에서 조용히 빠진다(회귀).
        fixed_manage = self.root / "fixed" / "manage_hub.db"
        fixed_manage.parent.mkdir(parents=True)
        with closing(sqlite3.connect(fixed_manage)) as conn:
            conn.execute(
                "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY, status TEXT)"
            )
            conn.execute("INSERT INTO team_generation_fact VALUES('fact-2', 'done')")
            conn.commit()

        with mock.patch.object(backup, "MANAGE_DB_PATH", fixed_manage):
            backup.backup_now(stamp="20260815_120000_000001")

        manage_copy = self.backup_dir / "manage_hub_20260815_120000_000001.db"
        self.assertTrue(manage_copy.is_file())
        with closing(sqlite3.connect(manage_copy)) as conn:
            self.assertEqual(
                conn.execute("SELECT status FROM team_generation_fact").fetchone()[0],
                "done",
            )

    def test_sidecar_validation_failure_does_not_publish_primary(self):
        trash = self.root / "content_hub_trash.db"
        with closing(sqlite3.connect(trash)) as conn:
            conn.execute("CREATE TABLE trashed(id TEXT PRIMARY KEY)")
            conn.commit()

        with mock.patch.object(
            backup, "_validate_sidecar", side_effect=sqlite3.DatabaseError("bad sidecar")
        ):
            with self.assertRaises(sqlite3.DatabaseError):
                backup.backup_now(stamp="20260813_120000_000002")

        self.assertFalse(
            (self.backup_dir / "content_hub_20260813_120000_000002.db").exists()
        )
        self.assertEqual(list(self.backup_dir.glob(".*.tmp-*")), [])


if __name__ == "__main__":
    unittest.main()
