"""프로젝트 예산 주기 저장과 현재 기간 사용량 집계."""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage


class ProjectBudgetPeriodTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id, name, kind) VALUES('p1','Project','team')")
            manage._ensure_schema(conn)
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_jay', '제이')")
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_river', '리버')")
            for gen_id, created_at, credits, model, is_final, folder_path, elapsed, creator_uid in (
                ("today", "+0 days", 5, "nano", 1, "ep001/c0010", 30, "u_jay"),
                ("old", "-40 days", 11, "seedance", 0, "ep001\\c0020", 60, "u_river"),
            ):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, is_final, folder_path, created_at, sort_ts, project_id) "
                    "VALUES(?, 'me', ?, 'prompt', 'done', ?, ?, ?, datetime('now', ?), datetime('now', ?), 'p1')",
                    (gen_id, creator_uid, model, is_final, folder_path, created_at, created_at),
                )
                conn.execute(
                    "INSERT INTO generation_metrics(gen_id, real_credits, elapsed_seconds) VALUES(?, ?, ?)",
                    (gen_id, credits, elapsed),
                )
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, folder_path) "
                "VALUES('empty-folder', 'p1', 'Empty sequence', 'ep002/c0001')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_day_budget_uses_only_the_current_day(self):
        saved = manage.set_planning("p1", budget_credits=100, budget_period="day")
        self.assertEqual(saved["budget_period"], "day")

        legacy_update = manage.set_planning("p1", budget_credits=120, note="legacy client")
        self.assertEqual(legacy_update["budget_period"], "day")

        project = manage.dashboard_summary()["projects"][0]
        self.assertEqual(project["credits"], 16)
        self.assertEqual(project["budget_used_credits"], 5)
        self.assertEqual(project["final_count"], 1)
        self.assertEqual(
            project["models"],
            [
                {"model": "seedance", "count": 1, "credits": 11, "final_count": 0},
                {"model": "nano", "count": 1, "credits": 5, "final_count": 1},
            ],
        )
        self.assertEqual(
            project["budget_models"],
            [{"model": "nano", "count": 1, "credits": 5, "final_count": 1}],
        )
        self.assertEqual(
            [row["folder_path"] for row in project["folders"]],
            ["ep001/c0010", "ep001/c0020", "ep002/c0001"],
        )
        today_folder = project["folders"][0]
        self.assertEqual(
            {key: today_folder[key] for key in ("count", "final_count", "credits", "elapsed_seconds")},
            {"count": 1, "final_count": 1, "credits": 5, "elapsed_seconds": 30},
        )
        self.assertEqual(
            today_folder["models"],
            [{"model": "nano", "count": 1, "credits": 5, "final_count": 1, "elapsed_seconds": 30}],
        )
        self.assertEqual(
            today_folder["members"],
            [{"uid": "u_jay", "name": "제이", "count": 1, "credits": 5, "final_count": 1}],
        )
        self.assertTrue(today_folder["created_start"])
        self.assertTrue(today_folder["created_end"])
        self.assertEqual(project["folders"][2]["count"], 0)
        self.assertEqual(project["folders"][2]["models"], [])
        self.assertEqual(project["folders"][2]["members"], [])

        restricted_project = manage.project_dashboard_summary(["p1"])["projects"][0]
        self.assertEqual(restricted_project["models"], project["models"])
        self.assertEqual(restricted_project["budget_models"], project["budget_models"])
        self.assertEqual(restricted_project["folders"], project["folders"])

    def test_existing_planning_schema_migrates_to_month(self):
        with db.get_connection() as conn:
            conn.execute("DROP TABLE project_planning")
            conn.execute(
                "CREATE TABLE project_planning ("
                "project_id TEXT PRIMARY KEY, status TEXT, start_date TEXT, due_date TEXT, "
                "budget_credits INTEGER, note TEXT)"
            )
            conn.execute("INSERT INTO project_planning(project_id, budget_credits) VALUES('p1', 50)")
        # DB 파일 교체 없이 테이블을 재작성한 테스트이므로 보장 캐시를 비운다.
        manage._SCHEMA_ENSURED.clear()
        planning = manage.get_planning("p1")
        self.assertEqual(planning["budget_period"], "month")


if __name__ == "__main__":
    unittest.main()
