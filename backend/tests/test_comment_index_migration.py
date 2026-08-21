"""코멘트 답글 인덱스 마이그레이션 — 구형 DB(parent_id 없음) 부팅 순서·멱등·부분 인덱스 검증."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db


class CommentParentIndexMigrationTests(unittest.TestCase):
    def test_legacy_asset_comment_without_parent_id_boots_and_gets_partial_index(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = Path(tmp) / "content_hub.db"
            with sqlite3.connect(db_path) as conn:
                # 구형 asset_comment — parent_id/muted/is_private ALTER 이전 형태.
                conn.execute(
                    """
                    CREATE TABLE asset_comment (
                        id         TEXT PRIMARY KEY,
                        project    TEXT NOT NULL,
                        path       TEXT NOT NULL,
                        author     TEXT NOT NULL,
                        text       TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )

            db.init_db(db_path)
            db.init_db(db_path)  # 인덱스 생성까지 멱등이어야 한다

            with sqlite3.connect(db_path) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(asset_comment)")}
                self.assertIn("parent_id", columns)  # ALTER 가 인덱스보다 먼저 수행됨
                index_sql = {
                    row[0]: row[1] or ""
                    for row in conn.execute(
                        "SELECT name, sql FROM sqlite_master WHERE type='index' "
                        "AND name IN ('idx_asset_comment_parent','idx_generation_comment_parent')"
                    )
                }
                self.assertEqual(
                    set(index_sql), {"idx_asset_comment_parent", "idx_generation_comment_parent"}
                )
                for sql in index_sql.values():
                    self.assertIn("parent_id IS NOT NULL", sql)  # partial 인덱스 계약
                plan = " | ".join(
                    row[3]
                    for row in conn.execute(
                        "EXPLAIN QUERY PLAN SELECT id FROM asset_comment WHERE parent_id=?",
                        ("c1",),
                    )
                )
                self.assertIn("idx_asset_comment_parent", plan)
                plan = " | ".join(
                    row[3]
                    for row in conn.execute(
                        "EXPLAIN QUERY PLAN "
                        "SELECT id FROM generation_comment WHERE parent_id=?",
                        ("c1",),
                    )
                )
                self.assertIn("idx_generation_comment_parent", plan)

    def test_thread_composite_indexes_serve_filter_and_sort_together(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            db_path = Path(tmp) / "content_hub.db"
            db.init_db(db_path)
            db.init_db(db_path)  # 멱등
            with sqlite3.connect(db_path) as conn:
                plan = " | ".join(
                    row[3]
                    for row in conn.execute(
                        "EXPLAIN QUERY PLAN SELECT id FROM asset_comment "
                        "WHERE project=? AND path=? ORDER BY created_at, id",
                        ("p", "a/b"),
                    )
                )
                self.assertIn("idx_asset_comment_thread", plan)
                self.assertNotIn("USE TEMP B-TREE", plan)  # 정렬까지 인덱스가 흡수
                plan = " | ".join(
                    row[3]
                    for row in conn.execute(
                        "EXPLAIN QUERY PLAN SELECT id FROM generation_comment "
                        "WHERE gen_id=? ORDER BY created_at, id",
                        ("g",),
                    )
                )
                self.assertIn("idx_generation_comment_thread", plan)
                self.assertNotIn("USE TEMP B-TREE", plan)


if __name__ == "__main__":
    unittest.main()
