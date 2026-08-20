"""구버전 생성 요청 테이블이 최신 캔버스 연결 스키마로 안전하게 올라가는지 검증."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db


class LegacyGenRequestMigrationTests(unittest.TestCase):
    def test_init_db_adds_canvas_columns_before_creating_index(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = Path(tmp) / "content_hub.db"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    """
                    CREATE TABLE gen_request (
                        id TEXT PRIMARY KEY,
                        account_email TEXT NOT NULL,
                        creator_uid TEXT,
                        gen_id TEXT NOT NULL,
                        kind TEXT NOT NULL DEFAULT 'create',
                        payload TEXT,
                        status TEXT NOT NULL DEFAULT 'pending',
                        error TEXT,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )

            db.init_db(db_path)
            db.init_db(db_path)  # 컬럼·부분 유니크 인덱스 마이그레이션 자체도 멱등

            with sqlite3.connect(db_path) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(gen_request)")}
                indexes = {row[1] for row in conn.execute("PRAGMA index_list(gen_request)")}

            self.assertTrue(
                {
                    "canvas_attempt_id",
                    "canvas_scene_id",
                    "canvas_card_id",
                    "idempotency_key",
                }
                <= columns
            )
            self.assertTrue(
                {
                    "submission_fingerprint",
                    "submission_started_at",
                    "recovery_probe_status",
                    "recovery_probe_at",
                    "recovery_probe_matches",
                    "recovery_probe_job_id",
                }
                <= columns
            )
            self.assertIn("idx_genrequest_canvas_attempt", indexes)
            self.assertIn("idx_genrequest_idempotency", indexes)

    def test_init_db_adds_synced_claim_anchor_before_scene_index(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = Path(tmp) / "content_hub.db"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "CREATE TABLE scene_card_generation ("
                    "owner_uid TEXT NOT NULL, scene_id TEXT NOT NULL, card_id TEXT NOT NULL, "
                    "generation_id TEXT NOT NULL, removed_at TEXT, "
                    "created_at TEXT NOT NULL DEFAULT (datetime('now')), "
                    "PRIMARY KEY(owner_uid,scene_id,card_id,generation_id))"
                )

            db.init_db(db_path)

            with sqlite3.connect(db_path) as conn:
                columns = {
                    row[1]
                    for row in conn.execute(
                        "PRAGMA table_info(scene_card_generation)"
                    )
                }
                indexes = {
                    row[1]
                    for row in conn.execute(
                        "PRAGMA index_list(scene_card_generation)"
                    )
                }

            self.assertIn("canvas_attempt_id", columns)
            self.assertIn("idx_scene_card_gen_attempt", indexes)


if __name__ == "__main__":
    unittest.main()
