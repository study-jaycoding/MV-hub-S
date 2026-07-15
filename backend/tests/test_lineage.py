"""lineage(히스토리 계보) 특성화 테스트 — mutation·전이축소·순환거부 동작 고정.

generations.py → lineage.py 분리 전 안전망.
"""

import os
import tempfile
import unittest

from app import db, repo


class LineageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self._seed()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _seed(self):
        with db.get_connection() as conn:
            for gid in ("a", "b", "root", "mid", "child"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                    "VALUES(?, 'me', 'p', 'done', '2026-06-30', 1)",
                    (gid,),
                )

    def test_add_history_edge_records_derived(self):
        self.assertTrue(repo.add_history_edge("a", "b", "derived"))
        with db.get_connection() as c:
            row = c.execute(
                "SELECT relation FROM history WHERE parent_gen_id='a' AND child_gen_id='b'"
            ).fetchone()
        self.assertEqual(row["relation"], "derived")

    def test_add_history_edge_rejects_self(self):
        with self.assertRaises(ValueError):
            repo.add_history_edge("a", "a")

    def test_add_history_edge_rejects_cycle(self):
        repo.add_history_edge("a", "b")  # a -> b
        with self.assertRaises(ValueError):
            repo.add_history_edge("b", "a")  # b 를 부모로 a 에 = a 가 b 의 자손이라 순환

    def test_add_history_edge_rejects_missing_parent(self):
        with self.assertRaises(ValueError):
            repo.add_history_edge("nope", "a")

    def test_record_derived_parents_transitive_reduction(self):
        # root -> mid 가 있을 때 [root, mid] -> child 입력이면 mid 만 기록(root 는 mid 의 조상 → 잉여).
        repo.add_history_edge("root", "mid")
        kept = repo.record_derived_parents("child", ["root", "mid"])
        self.assertEqual(set(kept), {"mid"})

    def test_remove_history_edge(self):
        repo.add_history_edge("a", "b")
        self.assertTrue(repo.remove_history_edge("a", "b"))
        with db.get_connection() as c:
            gone = c.execute(
                "SELECT 1 FROM history WHERE parent_gen_id='a' AND child_gen_id='b'"
            ).fetchone()
        self.assertIsNone(gone)


if __name__ == "__main__":
    unittest.main()
