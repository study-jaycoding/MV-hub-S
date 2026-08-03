"""주기 백업 원자성 테스트 — 잘린/미검증 파일이 정상 백업 이름으로 남지 않는 불변식."""

import os
import tempfile
import time
import unittest
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


if __name__ == "__main__":
    unittest.main()
