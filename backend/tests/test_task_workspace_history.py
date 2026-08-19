"""RL-02 작업 스냅샷의 이동·과거 조회·쓰기 차단 회귀 계약."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from app import db, repo
from app.repo import manage, manage_tasks
from app.routers import manage as manage_router


class TaskWorkspaceHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES('p1','이동 프로젝트','team','team','ws-a','A')"
            )
            self._generation(conn, "g-a", "ws-a", "A")

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def _generation(conn, gid: str, workspace_id: str, workspace_name: str) -> None:
        conn.execute(
            "INSERT INTO generation(id,worker_id,prompt,status,project_id,folder_path,"
            "workspace_scope,workspace_id,workspace_name,created_at,sort_ts) "
            "VALUES(?, 'me','p','done','p1','ep001/c0010','team',?,?,datetime('now'),"
            "strftime('%s','now'))",
            (gid, workspace_id, workspace_name),
        )

    def _task(self, workspace_id: str) -> dict:
        tasks = manage.list_tasks(
            "p1", include_archived=True, workspace_id=workspace_id
        )
        self.assertEqual(len(tasks), 1)
        return tasks[0]

    def test_move_a_to_b_to_a_keeps_separate_task_snapshots(self) -> None:
        task_a = self._task("ws-a")
        self.assertEqual([cut["id"] for cut in task_a["cuts"]], ["g-a"])

        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p1'"
            )
            self._generation(conn, "g-b", "ws-b", "B")

        task_b = self._task("ws-b")
        history_a = self._task("ws-a")
        self.assertNotEqual(task_a["id"], task_b["id"])
        self.assertEqual([cut["id"] for cut in task_b["cuts"]], ["g-b"])
        self.assertEqual([cut["id"] for cut in history_a["cuts"]], ["g-a"])
        self.assertTrue(history_a["workspace_historical"])
        self.assertFalse(task_b["workspace_historical"])

        projects_a = manage.task_projects_for_workspace("ws-a", include_historical=True)
        self.assertEqual([project["id"] for project in projects_a], ["p1"])
        self.assertTrue(projects_a[0]["workspace_moved"])
        self.assertEqual(
            manage.task_projects_for_workspace("ws-a", include_historical=False), []
        )

        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-a', workspace_name='A' WHERE id='p1'"
            )

        current = manage.list_tasks("p1")
        self.assertEqual([task["id"] for task in current], [task_a["id"]])
        self.assertEqual([cut["id"] for cut in current[0]["cuts"]], ["g-a"])
        history_b = self._task("ws-b")
        self.assertEqual(history_b["id"], task_b["id"])
        self.assertTrue(history_b["workspace_historical"])

        with db.get_connection() as conn:
            conn.execute("UPDATE project SET archived=1 WHERE id='p1'")
        self.assertEqual(
            manage.task_projects_for_workspace("ws-a", include_historical=False), []
        )
        self.assertEqual(
            [project["id"] for project in manage.task_projects_for_workspace(
                "ws-a", include_historical=True
            )],
            ["p1"],
        )

    def test_project_history_lookup_is_read_only_before_task_derivation(self) -> None:
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES('p2','미동기화 과거 프로젝트','team','team','ws-b','B')"
            )
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,project_id,folder_path,"
                "workspace_scope,workspace_id,workspace_name,created_at,sort_ts) "
                "VALUES('g-p2-a','me','p','done','p2','ep002/c0020','team','ws-a','A',"
                "datetime('now'),strftime('%s','now'))"
            )
            before = conn.execute("SELECT COUNT(*) AS c FROM project_task").fetchone()["c"]

        projects = manage.task_projects_for_workspace("ws-a", include_historical=True)

        rows = {project["id"]: project for project in projects}
        self.assertIn("p2", rows)
        self.assertTrue(rows["p2"]["workspace_moved"])
        with db.get_connection() as conn:
            after = conn.execute("SELECT COUNT(*) AS c FROM project_task").fetchone()["c"]
        self.assertEqual(after, before, "프로젝트 목록 GET은 작업 행을 만들면 안 된다")

    def test_project_history_lookup_normalizes_intermediate_task_workspace_values(self) -> None:
        """중간 배포 DB의 대문자·공백 범위도 과거 프로젝트 근거로 읽는다."""
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,source_kind,workspace_scope,"
                "workspace_id,workspace_origin) VALUES("
                "'legacy-team-task','p1','구 작업','manual',' TEAM ',' ws-a ','snapshot')"
            )
            conn.execute(
                "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p1'"
            )
            conn.execute("DELETE FROM generation WHERE project_id='p1'")

        projects = manage.task_projects_for_workspace("ws-a", include_historical=True)

        self.assertEqual([project["id"] for project in projects], ["p1"])
        self.assertTrue(projects[0]["workspace_moved"])

    def test_historical_and_unresolved_tasks_are_read_only(self) -> None:
        task_a = self._task("ws-a")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p1'"
            )

        with self.assertRaises(HTTPException) as historical:
            manage_router._require_task_current(task_a["id"])
        self.assertEqual(historical.exception.status_code, 409)
        self.assertIn("읽기 전용", historical.exception.detail)

        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project_task(id,project_id,name,workspace_scope,workspace_origin) "
                "VALUES('unknown-task','p1','확인 필요','unknown','unknown')"
            )
        with self.assertRaises(HTTPException) as unresolved:
            manage_router._require_task_current("unknown-task")
        self.assertEqual(unresolved.exception.status_code, 409)
        self.assertIn("귀속", unresolved.exception.detail)

    def test_single_write_checks_permission_before_workspace_state(self) -> None:
        """비멤버에게 과거/미확정 여부를 409로 먼저 노출하면 안 된다."""
        denied = HTTPException(status_code=403, detail="프로젝트 관리 권한이 없습니다")
        with (
            patch.object(manage_router, "_task_project_or_404", return_value="p1"),
            patch.object(manage_router, "_require_project_manage", side_effect=denied),
            patch.object(manage_router, "_require_task_current") as require_current,
        ):
            with self.assertRaises(HTTPException) as raised:
                manage_router.remove_task("historical-task", Mock())

        self.assertEqual(raised.exception.status_code, 403)
        require_current.assert_not_called()

    def test_batch_write_checks_permission_before_workspace_state(self) -> None:
        """배치 쓰기도 권한을 통과한 사용자에게만 409 상태를 알려야 한다."""
        denied = HTTPException(status_code=403, detail="프로젝트 관리 권한이 없습니다")
        for context in (
            {"project_id": "p1", "workspace_unresolved": True, "is_current": False},
            {"project_id": "p1", "workspace_unresolved": False, "is_current": False},
        ):
            with self.subTest(context=context):
                with (
                    patch.object(
                        manage_router.repo_manage,
                        "task_contexts",
                        return_value={"protected-task": context},
                    ),
                    patch.object(
                        manage_router, "_require_project_manage", side_effect=denied
                    ),
                ):
                    with self.assertRaises(HTTPException) as raised:
                        manage_router._require_tasks_manage(["protected-task"], Mock())
                self.assertEqual(raised.exception.status_code, 403)

    def test_repository_writes_recheck_workspace_after_router_check(self) -> None:
        """라우터 검사 직후 프로젝트가 이동해도 저장 계층이 과거 작업을 못 바꿔야 한다."""
        task_a = self._task("ws-a")
        tid = task_a["id"]
        self.assertEqual(manage_router._require_task_current(tid)["project_id"], "p1")
        self.assertTrue(manage.add_assignment(tid, "member-a", "pm"))
        self.assertEqual(manage.link_generations(tid, ["g-a"]), 1)

        # 위의 라우터 검사를 통과한 직후 다른 요청이 프로젝트를 옮긴 상황을 재현한다.
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p1'"
            )

        guarded_writes = (
            lambda: manage.update_task(tid, {"note": "바뀌면 안 됨"}),
            lambda: manage.add_assignment(tid, "member-b", "pm"),
            lambda: manage.remove_assignment(tid, "member-a"),
            lambda: manage.bulk_set_assignments(
                [{"task_id": tid, "assignee_uids": ["member-b"]}], "replace", "pm"
            ),
            lambda: manage.bulk_update_task_orders([(tid, 999)]),
            lambda: manage.unlink_generation(tid, "g-a"),
            lambda: manage.link_generations(tid, ["g-a"]),
            lambda: manage.delete_task(tid),
            lambda: manage.bulk_delete_tasks([tid]),
        )
        for write in guarded_writes:
            with self.assertRaisesRegex(
                manage.TaskWorkspaceConflictError, "읽기 전용"
            ):
                write()

        with db.get_connection() as conn:
            task = conn.execute(
                "SELECT note, sort_order FROM project_task WHERE id=?", (tid,)
            ).fetchone()
            self.assertIsNotNone(task)
            self.assertIsNone(task["note"])
            self.assertNotEqual(task["sort_order"], 999)
            assignees = conn.execute(
                "SELECT assignee_uid FROM task_assignment WHERE task_id=? ORDER BY assignee_uid",
                (tid,),
            ).fetchall()
            self.assertEqual([row["assignee_uid"] for row in assignees], ["member-a"])
            links = conn.execute(
                "SELECT gen_id FROM task_generation WHERE task_id=?", (tid,)
            ).fetchall()
            self.assertEqual([row["gen_id"] for row in links], ["g-a"])

    def test_router_reports_late_workspace_move_as_conflict(self) -> None:
        body = manage_router.TaskPatch(name="새 이름")
        with (
            patch.object(manage_router, "_task_project_or_404", return_value="p1"),
            patch.object(
                manage_router,
                "_require_task_current",
                return_value={"project_id": "p1"},
            ),
            patch.object(manage_router, "_require_project_manage"),
            patch.object(
                manage_router.repo_manage,
                "update_task",
                side_effect=manage.TaskWorkspaceConflictError(
                    "과거 워크스페이스 작업은 읽기 전용입니다"
                ),
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                manage_router.patch_task("task-a", body, Mock())
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("읽기 전용", raised.exception.detail)

    def test_repository_writes_reject_task_deleted_after_router_check(self) -> None:
        """라우터 검사 뒤 작업이 삭제돼도 단건·배치 쓰기가 거짓 성공하면 안 된다."""
        tid = self._task("ws-a")["id"]
        with db.get_connection() as conn:
            conn.execute("DELETE FROM project_task WHERE id=?", (tid,))

        guarded_writes = (
            lambda: manage.update_task(tid, {"note": "없음"}),
            lambda: manage.add_assignment(tid, "member-a", "pm"),
            lambda: manage.remove_assignment(tid, "member-a"),
            lambda: manage.bulk_set_assignments(
                [{"task_id": tid, "assignee_uids": ["member-a"]}], "replace", "pm"
            ),
            lambda: manage.bulk_update_task_orders([(tid, 999)]),
            lambda: manage.unlink_generation(tid, "g-a"),
            lambda: manage.link_generations(tid, ["g-a"]),
            lambda: manage.delete_task(tid),
            lambda: manage.bulk_delete_tasks([tid]),
        )
        for write in guarded_writes:
            with self.assertRaisesRegex(manage.TaskMissingError, "없는 작업"):
                write()

    def test_batch_write_is_atomic_when_one_task_disappears(self) -> None:
        valid_id = self._task("ws-a")["id"]
        with self.assertRaisesRegex(manage.TaskMissingError, "missing-task"):
            manage.bulk_update_task_orders([(valid_id, 999), ("missing-task", 1000)])
        with self.assertRaisesRegex(manage.TaskMissingError, "missing-task"):
            manage.bulk_set_assignments(
                [
                    {"task_id": valid_id, "assignee_uids": ["member-a"]},
                    {"task_id": "missing-task", "assignee_uids": ["member-b"]},
                ],
                "replace",
                "pm",
            )
        with db.get_connection() as conn:
            task = conn.execute(
                "SELECT sort_order FROM project_task WHERE id=?", (valid_id,)
            ).fetchone()
            self.assertNotEqual(task["sort_order"], 999)
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM task_assignment WHERE task_id=?", (valid_id,)
                ).fetchone()["c"],
                0,
            )

    def test_router_reports_task_deleted_after_check_as_not_found(self) -> None:
        body = manage_router.TaskPatch(name="새 이름")
        with (
            patch.object(manage_router, "_task_project_or_404", return_value="p1"),
            patch.object(
                manage_router,
                "_require_task_current",
                return_value={"project_id": "p1"},
            ),
            patch.object(manage_router, "_require_project_manage"),
            patch.object(
                manage_router.repo_manage,
                "update_task",
                side_effect=manage.TaskMissingError("없는 작업: task-a"),
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                manage_router.patch_task("task-a", body, Mock())
        self.assertEqual(raised.exception.status_code, 404)
        self.assertIn("없는 작업", raised.exception.detail)

    def test_task_write_holds_project_move_until_mutation_finishes(self) -> None:
        """현재성 재검사와 변경 사이에는 다른 프로젝트 이동 쓰기가 끼어들 수 없다."""
        tid = self._task("ws-a")["id"]
        guard_reached = threading.Event()
        release_guard = threading.Event()
        failures: list[BaseException] = []
        original_guard = manage_tasks._assert_tasks_current_for_write

        def paused_guard(conn, task_ids):
            current = original_guard(conn, task_ids)
            guard_reached.set()
            if not release_guard.wait(2):
                raise TimeoutError("테스트 쓰기 잠금 해제 대기 초과")
            return current

        def mutate() -> None:
            try:
                manage.update_task(tid, {"note": "직렬화됨"})
            except BaseException as exc:  # 테스트 스레드 예외를 본 스레드로 전달
                failures.append(exc)

        with patch.object(
            manage_tasks, "_assert_tasks_current_for_write", side_effect=paused_guard
        ):
            worker = threading.Thread(target=mutate, daemon=True)
            worker.start()
            self.assertTrue(guard_reached.wait(2), "작업 쓰기가 현재성 검사에 도달하지 못함")

            probe = sqlite3.connect(os.environ["CONTENT_HUB_DB"], timeout=0, isolation_level=None)
            try:
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    probe.execute(
                        "UPDATE project SET workspace_id='ws-b', workspace_name='B' WHERE id='p1'"
                    )
            finally:
                probe.close()
                release_guard.set()
                worker.join(3)

        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute("SELECT note FROM project_task WHERE id=?", (tid,)).fetchone()["note"],
                "직렬화됨",
            )

    def test_create_task_does_not_leave_orphan_after_project_disappears(self) -> None:
        with db.get_connection() as conn:
            conn.execute("DELETE FROM project WHERE id='p1'")
        with self.assertRaisesRegex(manage.TaskProjectMissingError, "없는 프로젝트"):
            manage.create_task("p1", "고아가 되면 안 됨")
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS c FROM project_task").fetchone()["c"], 0
            )

    def test_link_is_atomic_and_rejects_cross_workspace_or_project(self) -> None:
        task_a = self._task("ws-a")
        with db.get_connection() as conn:
            self._generation(conn, "g-b", "ws-b", "B")
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES('p2','다른 프로젝트','team','team','ws-a','A')"
            )
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,project_id,workspace_scope,"
                "workspace_id,workspace_name) VALUES('g-other','me','p','done','p2','team','ws-a','A')"
            )

        with self.assertRaisesRegex(ValueError, "다른 워크스페이스"):
            manage.link_generations(task_a["id"], ["g-a", "g-b"])
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM task_generation WHERE task_id=?",
                    (task_a["id"],),
                ).fetchone()["c"],
                0,
            )

        with self.assertRaisesRegex(ValueError, "다른 프로젝트"):
            manage.link_generations(task_a["id"], ["g-other"])
        self.assertEqual(manage.link_generations(task_a["id"], ["g-a", "g-a"]), 1)
        self.assertEqual(manage.link_generations(task_a["id"], ["g-a"]), 0)


if __name__ == "__main__":
    unittest.main()
