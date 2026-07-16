"""가계 조회(get_history / get_history_graph) 특성화 테스트 — 조회 결과 형태 고정.

generations.py → history.py 분리 전 안전망. read 함수라 mutation 은 add_history_edge 로만 세팅.
"""

import os
import tempfile
import unittest

from app import db, repo


class HistoryQueryTests(unittest.TestCase):
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
        # root → mid → child (파생 체인), src → child (레퍼런스 재료).
        with db.get_connection() as conn:
            for i, gid in enumerate(("root", "mid", "child", "src")):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                    "VALUES(?, 'me', 'p', 'done', '2026-06-30', ?)",
                    (gid, i + 1),
                )
        repo.add_history_edge("root", "mid", "derived")
        repo.add_history_edge("mid", "child", "derived")
        repo.add_history_edge("src", "child", "reference")

    def test_get_history_relations(self):
        h = repo.get_history("child")
        self.assertIsNotNone(h)
        # 조상 = derived 부모를 위로(부모 → 루트 순)
        self.assertEqual([g["id"] for g in h["ancestors"]], ["mid", "root"])
        # 재료 = reference 부모
        self.assertEqual([g["id"] for g in h["materials"]], ["src"])
        self.assertEqual(h["target"]["id"], "child")
        self.assertEqual(h["children"], [])
        self.assertEqual(h["used_by"], [])

    def test_get_history_parent_side(self):
        # root 입장에선 직계 파생 자식 mid 가 children, 조상은 없음(root 가 최상위).
        h = repo.get_history("root")
        self.assertEqual([g["id"] for g in h["children"]], ["mid"])
        self.assertEqual(h["ancestors"], [])

    def test_get_history_used_by(self):
        # src 입장에선 자신을 @소스로 쓴 child 가 used_by(reference 방향), 재료는 없음.
        h = repo.get_history("src")
        self.assertEqual([g["id"] for g in h["used_by"]], ["child"])
        self.assertEqual(h["materials"], [])

    def test_get_history_missing_returns_none(self):
        self.assertIsNone(repo.get_history("nope"))

    def test_get_history_graph_connected_component(self):
        g = repo.get_history_graph("child")
        self.assertIsNotNone(g)
        self.assertEqual(g["focus_id"], "child")
        # 연결 컴포넌트 전체(root/mid/child/src) 노드.
        self.assertEqual({n["id"] for n in g["nodes"]}, {"root", "mid", "child", "src"})
        # 엣지 3개(root→mid, mid→child, src→child).
        edge_set = {(e["parent_gen_id"], e["child_gen_id"], e["relation"]) for e in g["edges"]}
        self.assertEqual(
            edge_set,
            {("root", "mid", "derived"), ("mid", "child", "derived"), ("src", "child", "reference")},
        )
        # 루트 = 부모 엣지가 없는 원본(root, src).
        self.assertEqual(set(g["root_ids"]), {"root", "src"})
        self.assertFalse(g["truncated"])

    def test_get_history_graph_missing_returns_none(self):
        self.assertIsNone(repo.get_history_graph("nope"))


if __name__ == "__main__":
    unittest.main()
