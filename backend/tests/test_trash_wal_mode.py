"""휴지통 DB 저널 모드 회귀 테스트.

휴지통(content_hub_trash.db)은 ATTACH 로 처음 생성되는데, 과거에는 기본 rollback
journal 로 만들어져 쓰기마다 DB 전체 EXCLUSIVE 락을 잡았다(대량 삭제 중 /api/ready
의 휴지통 검사 2초 타임아웃 → 워치독 오탐 재시작 연쇄). WAL 로 생성·유지되는지 고정.
"""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db, repo
from app.repo import trash


class TrashWalModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_trash_db_is_created_in_wal_mode(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                "VALUES('g1','me','p','done','2026-08-15',1)"
            )
        repo.delete_generation("g1")

        trash_path = Path(self.tmp.name) / "content_hub_trash.db"
        self.assertTrue(trash_path.is_file())
        # SQLite 파일 헤더 18·19바이트: 1=rollback journal, 2=WAL.
        header = trash_path.read_bytes()[:20]
        self.assertEqual((header[18], header[19]), (2, 2))
        with sqlite3.connect(trash_path) as conn:
            self.assertEqual(
                conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal"
            )

    def test_existing_rollback_trash_db_is_upgraded(self):
        # 기존 배포본의 rollback journal 휴지통도 다음 접근 때 WAL 로 승격돼야 한다.
        trash_path = Path(self.tmp.name) / "content_hub_trash.db"
        with sqlite3.connect(trash_path) as conn:
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.execute(
                "CREATE TABLE trashed(id TEXT PRIMARY KEY, trashed_at TEXT NOT NULL, "
                "project_id TEXT, creator_uid TEXT, status TEXT, prompt TEXT, "
                "source_name TEXT, job_id TEXT, payload TEXT NOT NULL)"
            )
        header = trash_path.read_bytes()[:20]
        self.assertEqual((header[18], header[19]), (1, 1))

        repo.list_trash()  # 아무 휴지통 접근이나 스키마 보장을 지나며 WAL 로 승격

        header = trash_path.read_bytes()[:20]
        self.assertEqual((header[18], header[19]), (2, 2))


if __name__ == "__main__":
    unittest.main()
