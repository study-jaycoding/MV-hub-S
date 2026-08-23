"""lineage-1 — 재귀 CTE의 폭·상한·손상 계보 회귀 테스트.

기존 특성화 테스트는 수정하지 않고, Python frontier BFS에서 실제로 깨진 경계를 별도로 고정한다.
"""

import os
import sqlite3
import tempfile
import unittest

from app import db, repo
from app.repo.lineage import _connected_lineage, _descendants, _directed_lineage_window


def _memory_history() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE history (
            id TEXT PRIMARY KEY,
            parent_gen_id TEXT NOT NULL,
            child_gen_id TEXT NOT NULL,
            relation TEXT NOT NULL DEFAULT 'derived'
        );
        CREATE INDEX idx_history_parent ON history(parent_gen_id);
        CREATE INDEX idx_history_child ON history(child_gen_id);
        """
    )
    return conn


def _insert_edges(conn: sqlite3.Connection, edges: list[tuple[str, str]]) -> None:
    conn.executemany(
        "INSERT INTO history(id, parent_gen_id, child_gen_id) VALUES(?,?,?)",
        ((f"e{i}", parent, child) for i, (parent, child) in enumerate(edges)),
    )


class LineageRecursiveCteTests(unittest.TestCase):
    def test_wide_tree_does_not_expand_sql_variable_count(self):
        conn = _memory_history()
        try:
            # 10 + 100 + 1,000 + 10,000 + 100,000 = 실측과 같은 111,110 edges.
            parents = ["root"]
            edges: list[tuple[str, str]] = []
            next_id = 0
            for _ in range(5):
                children = []
                for parent in parents:
                    for _ in range(10):
                        child = f"n{next_id}"
                        next_id += 1
                        edges.append((parent, child))
                        children.append(child)
                parents = children
            _insert_edges(conn, edges)

            # 구 배포 Python의 SQLite 한도에서도 변수 1개인 CTE가 동작해야 한다.
            conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
            self.assertEqual(len(_descendants(conn, "root")), 111_110)
            nodes, truncated = _connected_lineage(conn, "root", limit=300)
            self.assertEqual(len(nodes), 300)
            self.assertTrue(truncated)
        finally:
            conn.close()

    def test_cycle_and_self_reference_terminate_with_unique_nodes(self):
        conn = _memory_history()
        try:
            _insert_edges(conn, [("a", "b"), ("b", "c"), ("c", "a"), ("self", "self")])
            nodes, truncated = _connected_lineage(conn, "a", limit=10)
            self.assertEqual(nodes, {"a", "b", "c"})
            self.assertFalse(truncated)
            self.assertEqual(_descendants(conn, "self"), {"self"})
            self.assertEqual(_connected_lineage(conn, "self", limit=10), ({"self"}, False))
        finally:
            conn.close()

    def test_directed_line_preserves_ancestor_priority_and_excludes_side_branches(self):
        conn = _memory_history()
        try:
            _insert_edges(
                conn,
                [
                    ("grandparent", "parent"),
                    ("parent", "focus"),
                    ("focus", "child"),
                    ("child", "grandchild"),
                    ("parent", "sibling"),
                    ("other-parent", "child"),
                ],
            )
            nodes, truncated = _directed_lineage_window(conn, "focus", limit=4)
            self.assertEqual(nodes, {"grandparent", "parent", "focus", "child"})
            self.assertTrue(truncated)
        finally:
            conn.close()

    def test_deep_chain_matches_expected_set(self):
        conn = _memory_history()
        try:
            depth = 20_000
            edges = [("root" if i == 0 else f"n{i - 1}", f"n{i}") for i in range(depth)]
            _insert_edges(conn, edges)
            self.assertEqual(_descendants(conn, "root"), {f"n{i}" for i in range(depth)})
        finally:
            conn.close()


class HistoryGraphLimitContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
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

    def test_limit_is_exact_and_prefers_nearest_hop(self):
        first_hop = [f"child-{i:02d}" for i in range(10)]
        second_hop = [f"grandchild-{i:02d}" for i in range(100)]
        ids = ["root", *first_hop, *second_hop]
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                "VALUES(?, 'me', 'p', 'done', '2026-08-23', ?)",
                ((gid, i) for i, gid in enumerate(ids)),
            )
            edges = [("root", child) for child in first_hop]
            edges.extend(
                (first_hop[i // 10], grandchild)
                for i, grandchild in enumerate(second_hop)
            )
            conn.executemany(
                "INSERT INTO history(id, parent_gen_id, child_gen_id, relation) VALUES(?,?,?,'derived')",
                ((f"edge-{i}", parent, child) for i, (parent, child) in enumerate(edges)),
            )

        graph = repo.get_history_graph("root", limit=7)
        self.assertIsNotNone(graph)
        node_ids = {node["id"] for node in graph["nodes"]}
        self.assertEqual(len(node_ids), 7)
        self.assertIn("root", node_ids)
        self.assertLessEqual(node_ids - {"root"}, set(first_hop))
        self.assertTrue(graph["truncated"])

    def test_exact_component_size_is_not_marked_truncated(self):
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts) "
                "VALUES(?, 'me', 'p', 'done', '2026-08-23', ?)",
                ((gid, i) for i, gid in enumerate(("root", "child", "grandchild"))),
            )
            conn.executemany(
                "INSERT INTO history(id, parent_gen_id, child_gen_id, relation) VALUES(?,?,?,'derived')",
                (("edge-1", "root", "child"), ("edge-2", "child", "grandchild")),
            )

        graph = repo.get_history_graph("root", limit=3)
        self.assertEqual({node["id"] for node in graph["nodes"]}, {"root", "child", "grandchild"})
        self.assertFalse(graph["truncated"])


if __name__ == "__main__":
    unittest.main()
