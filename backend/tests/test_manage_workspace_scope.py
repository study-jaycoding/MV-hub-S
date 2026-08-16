"""RL-02: 관리 화면의 워크스페이스 범위와 자동 작업 수명주기 계약."""

from __future__ import annotations

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage


class ManageWorkspaceScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute("INSERT INTO creator(uid, name) VALUES('u-a', '제이')")
            conn.execute("INSERT INTO creator(uid, name) VALUES('u-b', '리버')")
            # 신규 쓰기는 이름 충돌을 막지만, 과거 DB에 중복이 남은 경우도 읽기 범위는 안전해야 한다.
            conn.execute("DROP INDEX IF EXISTS idx_project_active_name")
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p-a', '같은 프로젝트', 'team', 'team', 'ws-a', 'A')"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p-b', '같은 프로젝트', 'team', 'team', 'ws-b', 'B')"
            )
            self._generation(
                conn, "g-a", "p-a", "ws-a", "u-a", "model-a", "ep001/c0010", 7,
            )
            self._generation(
                conn, "g-b", "p-b", "ws-b", "u-b", "model-b", "ep002/c0020", 11,
            )
            # 과거 오염을 재현: p-a를 가리키지만 생성물 자체 workspace는 ws-b다.
            self._generation(
                conn, "g-cross", "p-a", "ws-b", "u-b", "wrong-model", "ep001/c0010", 99,
            )

    @staticmethod
    def _generation(
        conn,
        gid: str,
        project_id: str,
        workspace_id: str,
        creator_uid: str,
        model: str,
        folder_path: str,
        credits: int,
        created_sql: str = "datetime('now')",
    ) -> None:
        conn.execute(
            "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, "
            "folder_path, created_at, sort_ts, project_id, workspace_scope, workspace_id) "
            f"VALUES(?, 'me', ?, 'prompt', 'done', ?, ?, {created_sql}, "
            f"strftime('%s', {created_sql}), ?, 'team', ?)",
            (gid, creator_uid, model, folder_path, project_id, workspace_id),
        )
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, real_credits, elapsed_seconds) VALUES(?,?,1)",
            (gid, credits),
        )

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_dashboard_and_project_summary_share_exact_workspace_scope(self) -> None:
        summary = manage.dashboard_summary(workspace_id="ws-a")

        self.assertEqual([row["pid"] for row in summary["projects"]], ["p-a"])
        self.assertEqual(summary["totals"]["gen_count"], 1)
        self.assertEqual(summary["totals"]["credits"], 7)
        self.assertEqual([row["uid"] for row in summary["workers"]], ["u-a"])
        project = summary["projects"][0]
        self.assertEqual(project["gen_count"], 1)
        self.assertEqual(project["credits"], 7)
        self.assertEqual([row["model"] for row in project["models"]], ["model-a"])
        self.assertEqual([row["folder_path"] for row in project["folders"]], ["ep001/c0010"])

        restricted = manage.project_dashboard_summary(["p-a", "p-b"], "ws-a")
        self.assertEqual([row["pid"] for row in restricted["projects"]], ["p-a"])
        self.assertEqual(restricted["projects"][0]["credits"], 7)
        self.assertEqual(restricted["projects"][0]["folders"], project["folders"])

    def test_derived_task_moves_to_history_without_deletion_and_resurrects(self) -> None:
        with db.get_connection() as conn:
            conn.execute("DELETE FROM generation WHERE id='g-a'")
            conn.execute("DELETE FROM generation_metrics WHERE gen_id='g-a'")
            self._generation(
                conn, "g-old", "p-a", "ws-a", "u-a", "model-a", "ep009/c0090", 3,
                "datetime('now', '-40 days')",
            )
            conn.execute(
                "INSERT INTO project_planning(project_id, archive_after_days) VALUES('p-a', 30)"
            )

        active = manage.list_tasks("p-a")
        history = manage.list_tasks("p-a", include_archived=True)
        old = next(task for task in history if task["folder_path"] == "ep009/c0090")
        self.assertEqual(active, [])
        self.assertEqual(old["source_kind"], "generation")
        self.assertEqual(old["archived"], 1)

        with db.get_connection() as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS c FROM project_task WHERE id=?", (old["id"],)
            ).fetchone()["c"]
            self.assertEqual(count, 1, "과거 작업 행은 삭제하면 안 된다")
            self._generation(
                conn, "g-new", "p-a", "ws-a", "u-a", "model-a", "ep009/c0090", 5,
            )

        restored = manage.list_tasks("p-a")
        restored_old = next(task for task in restored if task["id"] == old["id"])
        self.assertEqual(restored_old["archived"], 0)
        self.assertEqual({cut["id"] for cut in restored_old["cuts"]}, {"g-old", "g-new"})

    def test_future_project_due_date_keeps_old_task_active(self) -> None:
        with db.get_connection() as conn:
            self._generation(
                conn, "g-due", "p-a", "ws-a", "u-a", "model-a", "ep010/c0010", 2,
                "datetime('now', '-40 days')",
            )
            conn.execute(
                "INSERT INTO project_planning(project_id, due_date, archive_after_days) "
                "VALUES('p-a', date('now', '+5 days'), 30)"
            )

        tasks = manage.list_tasks("p-a")
        due_task = next(task for task in tasks if task["folder_path"] == "ep010/c0010")
        self.assertEqual(due_task["archived"], 0)

    def test_legacy_derived_task_without_last_seen_uses_created_time(self) -> None:
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, folder_path, status, source_kind, "
                "source_last_seen_at, created_at) VALUES(" 
                "'legacy-task', 'p-a', 'ep099', 'ep099/c0010', 'not_started', "
                "'generation', NULL, datetime('now', '-40 days'))"
            )

        active = manage.list_tasks("p-a")
        history = manage.list_tasks("p-a", include_archived=True)

        self.assertNotIn("legacy-task", {task["id"] for task in active})
        legacy = next(task for task in history if task["id"] == "legacy-task")
        self.assertEqual(legacy["archived"], 1)
        self.assertIsNotNone(legacy["source_last_seen_at"])


if __name__ == "__main__":
    unittest.main()
