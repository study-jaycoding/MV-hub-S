"""PM 작업 순서·삭제 배치의 트랜잭션 계약."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import ANY, Mock, call, patch

from fastapi import HTTPException

from app import db, repo
from app.repo import manage
from app.routers import manage as manage_router


class TaskBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_bulk_order_updates_all_tasks(self) -> None:
        first = manage.create_task("p1", "first", sort_order=10)
        second = manage.create_task("p1", "second", sort_order=20)

        count = manage.bulk_update_task_orders([(first["id"], 20), (second["id"], 10)])

        self.assertEqual(count, 2)
        tasks = manage.list_tasks("p1")
        self.assertEqual([task["id"] for task in tasks], [second["id"], first["id"]])
        self.assertEqual(
            manage.task_projects([first["id"], second["id"]]),
            {first["id"]: "p1", second["id"]: "p1"},
        )

    def test_bulk_delete_clears_tasks_and_assignments(self) -> None:
        first = manage.create_task("p1", "first")
        second = manage.create_task("p1", "second")
        manage.add_assignment(first["id"], "user-a", "pm")
        manage.add_assignment(second["id"], "user-b", "pm")

        self.assertEqual(manage.bulk_delete_tasks([first["id"], second["id"]]), 2)
        self.assertEqual(manage.list_tasks("p1"), [])
        with db.get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) AS c FROM task_assignment").fetchone()["c"]
        self.assertEqual(count, 0)

    def test_list_tasks_batch_delegates_all_allowed_projects_once(self) -> None:
        expected = {"p1": [{"id": "t1"}], "p2": [{"id": "t2"}]}
        with (
            patch.object(manage_router, "_require_project_read") as require_read,
            patch.object(manage_router.repo_manage, "list_tasks_batch", return_value=expected) as batch,
            patch.object(manage_router.repo_manage, "list_tasks") as single,
        ):
            result = manage_router.list_tasks_batch(
                request=Mock(),
                project_id=["p1", "p2", "p1"],
            )

        self.assertEqual(result, expected)
        self.assertEqual(require_read.call_count, 2)
        batch.assert_called_once_with(["p1", "p2"], include_archived=False)
        single.assert_not_called()

    def test_bulk_assignment_resolves_all_task_projects_once(self) -> None:
        body = manage_router.BulkAssignIn(
            items=[
                manage_router.BulkAssignItem(task_id="t1", assignee_uids=["u1"]),
                manage_router.BulkAssignItem(task_id="t2", assignee_uids=["u2"]),
                manage_router.BulkAssignItem(task_id="t1", assignee_uids=["u3"]),
            ]
        )
        with (
            patch.object(manage_router, "actor_id", return_value="pm"),
            patch.object(
                manage_router.repo_manage,
                "task_projects",
                return_value={"t1": "p1", "t2": "p2"},
            ) as projects,
            patch.object(manage_router, "_require_project_manage") as require_manage,
            patch.object(manage_router, "_task_project_or_404") as single_lookup,
            patch.object(
                manage_router.repo_manage,
                "bulk_set_assignments",
                return_value=3,
            ) as setter,
        ):
            result = manage_router.bulk_set_assignments(body, Mock())

        self.assertEqual(result, {"ok": True, "count": 3})
        projects.assert_called_once_with(["t1", "t2"])
        self.assertEqual(
            require_manage.call_args_list,
            [call(ANY, "p1"), call(ANY, "p2")],
        )
        single_lookup.assert_not_called()
        setter.assert_called_once()

    def test_bulk_assignment_rejects_missing_task_before_write(self) -> None:
        body = manage_router.BulkAssignIn(
            items=[manage_router.BulkAssignItem(task_id="missing", assignee_uids=["u1"])]
        )
        with (
            patch.object(manage_router, "actor_id", return_value="pm"),
            patch.object(manage_router.repo_manage, "task_projects", return_value={}),
            patch.object(manage_router.repo_manage, "bulk_set_assignments") as setter,
        ):
            with self.assertRaises(HTTPException) as raised:
                manage_router.bulk_set_assignments(body, Mock())

        self.assertEqual(raised.exception.status_code, 404)
        self.assertIn("없는 작업", raised.exception.detail)
        setter.assert_not_called()

    def test_order_snapshot_assigns_positions_and_wins_over_items(self) -> None:
        # 신형 계약: ordered_task_ids 위치가 곧 순서(i*10). 함께 온 items(구서버 호환용)는 무시.
        body = manage_router.TaskOrderBatchIn(
            ordered_task_ids=["t2", "t1"],
            items=[manage_router.TaskOrderItem(task_id="t9", sort_order=999)],
        )
        with (
            patch.object(
                manage_router.repo_manage,
                "task_projects",
                return_value={"t1": "p1", "t2": "p1"},
            ),
            patch.object(manage_router, "_require_project_manage"),
            patch.object(
                manage_router.repo_manage, "bulk_update_task_orders", return_value=2
            ) as bulk,
        ):
            result = manage_router.update_task_order_batch(body, Mock())

        self.assertEqual(result, {"ok": True, "count": 2})
        bulk.assert_called_once_with([("t2", 0), ("t1", 10)])

    def test_order_snapshot_rejects_over_limit(self) -> None:
        body = manage_router.TaskOrderBatchIn(
            ordered_task_ids=[f"t{i}" for i in range(2001)]
        )
        with patch.object(manage_router.repo_manage, "bulk_update_task_orders") as bulk:
            with self.assertRaises(HTTPException) as raised:
                manage_router.update_task_order_batch(body, Mock())

        self.assertEqual(raised.exception.status_code, 400)
        bulk.assert_not_called()

    def test_bulk_assignment_rejects_over_limit_instead_of_silent_truncation(self) -> None:
        # 예전 [:500] 무음 절단은 잘린 뒤쪽 작업의 배정을 조용히 유실시켰다 — 명시 400.
        body = manage_router.BulkAssignIn(
            items=[
                manage_router.BulkAssignItem(task_id=f"t{i}", assignee_uids=["u1"])
                for i in range(501)
            ]
        )
        with patch.object(manage_router.repo_manage, "bulk_set_assignments") as setter:
            with self.assertRaises(HTTPException) as raised:
                manage_router.bulk_set_assignments(body, Mock())

        self.assertEqual(raised.exception.status_code, 400)
        setter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
