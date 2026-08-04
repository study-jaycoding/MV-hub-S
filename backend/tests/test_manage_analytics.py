"""관리 분석 repo 분리 전후의 응답 형태와 집계 우선순위."""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage


class ManageAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO worker(id, name, account_type) VALUES('u_me','Artist','team') "
                "ON CONFLICT(id) DO NOTHING"
            )
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('u_me','Artist') "
                "ON CONFLICT(uid) DO UPDATE SET name=excluded.name"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) VALUES('p1','Project','team',0)"
            )
            for values in (
                ("g1", "2026-08-01T10:00:00Z", 1.0, "ep001/c0010", 1),
                ("g2", "2026-08-02T10:00:00Z", 2.0, "ep001/c0020", 0),
            ):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                    "creator_uid, project_id, folder_path, is_final) "
                    "VALUES(?, 'me', 'prompt', 'done', ?, ?, 'u_me', 'p1', ?, ?)",
                    values,
                )
            conn.execute("INSERT INTO share(generation_id, shared_by) VALUES('g1','u_me')")
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO generation_metrics"
                "(gen_id, est_credits, real_credits) VALUES('g1',12,8)"
            )
            conn.execute(
                "INSERT INTO generation_metrics(gen_id, est_credits) VALUES('g2',4)"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_timeseries_prefers_real_credits_and_filters(self):
        rows = manage.timeseries(project_id="p1", creator_uid="u_me")
        self.assertEqual(
            rows,
            [
                {"bucket": "2026-08-01", "count": 1, "credits": 8},
                {"bucket": "2026-08-02", "count": 1, "credits": 4},
            ],
        )

    def test_matrix_and_breakdown_keep_dashboard_shape(self):
        matrix = manage.matrix()
        self.assertEqual(matrix["workers"], [{"uid": "u_me", "name": "Artist"}])
        self.assertEqual(matrix["projects"], [{"pid": "p1", "name": "Project"}])
        self.assertEqual(
            matrix["cells"]["u_me"]["p1"],
            {"count": 2, "credits": 12, "shared_count": 1, "final_count": 1},
        )

        rows = sorted(manage.breakdown("p1")["rows"], key=lambda row: row["folder_path"])
        self.assertEqual([row["sequence"] for row in rows], ["c0010", "c0020"])
        self.assertEqual([row["name"] for row in rows], ["Artist", "Artist"])
        self.assertEqual([row["credits"] for row in rows], [8, 4])


if __name__ == "__main__":
    unittest.main()
