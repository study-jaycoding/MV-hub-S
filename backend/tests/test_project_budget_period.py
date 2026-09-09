"""프로젝트 예산 주기 저장과 현재 기간 사용량 집계.

사용량 원천은 manage_hub 팩트(team_generation_fact, 2026-09-09 "출근부 장부") — content 생성물은
레지스트리·빈 시퀀스·이름에만 쓰이므로 같은 생성물을 팩트로도 시드한다.
"""

import os
import tempfile
import unittest
from pathlib import Path

from app import db, manage_db, repo
from app.repo import manage


class ProjectBudgetPeriodTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"  # 사용자 DB 격리
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        manage_db.init_manage_db()
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
        # 같은 생성물을 팩트로 — 사용량은 여기서 센다.
        self._upsert_fact("today")
        self._upsert_fact("old")

    _METRICS = {"today": (5, 30), "old": (11, 60)}  # gen_id -> (real_credits, elapsed)

    def _upsert_fact(self, gen_id: str, *, is_deleted: bool = False) -> None:
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT creator_uid, model, is_final, folder_path, created_at FROM generation WHERE id=?",
                (gen_id,),
            ).fetchone()
        credits, elapsed = self._METRICS[gen_id]
        n, skipped = manage_db.upsert_facts(
            f"{row['creator_uid']}@t",
            row["creator_uid"],
            [
                {
                    "local_gen_id": gen_id,
                    "job_id": f"job-{gen_id}",
                    "workspace_scope": "personal",
                    "project_id": "p1",
                    "project_name": "Project",
                    "folder_path": row["folder_path"],
                    "model": row["model"],
                    "status": "done",
                    "real_credits": credits,
                    "elapsed_seconds": elapsed,
                    "created_at": row["created_at"],
                    "is_final": bool(row["is_final"]),
                    "is_shared": False,
                    "is_deleted": is_deleted,
                    "deleted_at": row["created_at"] if is_deleted else None,
                }
            ],
        )
        assert (n, skipped) == (1, [])

    def tearDown(self):
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
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
                {"model": "seedance", "count": 1, "credits": 11, "final_count": 0, "elapsed_seconds": 60},
                {"model": "nano", "count": 1, "credits": 5, "final_count": 1, "elapsed_seconds": 30},
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

    def test_deleted_generation_credits_still_count_toward_budget(self):
        # 크레딧은 생성 시점에 이미 소진 — 카드를 지워도(팩트 tombstone) 예산 사용량에서 빠지면 안 된다
        # (쓰고 지우면 예산이 초기화되는 구멍 방지). 복원·반복 삭제에도 1회만 합산.
        manage.set_planning("p1", budget_credits=100, budget_period="day")
        self._upsert_fact("today", is_deleted=True)  # 삭제 통보(tombstone)
        project = manage.dashboard_summary()["projects"][0]
        self.assertEqual(project["budget_used_credits"], 5)
        self.assertEqual(project["credits"], 16)

        self._upsert_fact("today")  # 복원
        self._upsert_fact("today", is_deleted=True)  # 재삭제 — 이중 합산 없음
        project = manage.dashboard_summary()["projects"][0]
        self.assertEqual(project["budget_used_credits"], 5)
        self.assertEqual(project["credits"], 16)

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
