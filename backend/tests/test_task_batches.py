"""PM 작업 순서·삭제 배치의 트랜잭션 계약."""

from __future__ import annotations

import gc
import gzip
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import ANY, Mock, call, patch

from fastapi import HTTPException

from app import db, repo
from app.repo import manage, manage_tasks
from app.routers import manage as manage_router


class TaskBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        # 배치 쓰기 계약은 귀속이 확정된 현재 작업을 대상으로 한다. 기본 시드 프로젝트의
        # 레거시 unknown 값을 그대로 쓰면 운영 라우터에서도 수정 불가이므로 정상 개인 범위로 맞춘다.
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES('p1','배치 테스트','personal','personal',NULL,NULL)"
            )

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

        self.assertEqual(json.loads(result.body), expected)
        self.assertEqual(require_read.call_count, 2)
        batch.assert_called_once_with(
            ["p1", "p2"], include_archived=False, workspace_id=None
        )
        single.assert_not_called()

    def test_list_tasks_batch_does_not_hide_internal_database_failure(self) -> None:
        with (
            patch.object(manage_router, "_require_workspace_read"),
            patch.object(manage_router, "_require_project_read"),
            patch.object(
                manage_router.repo_manage,
                "list_tasks_batch",
                side_effect=RuntimeError("database unavailable"),
            ),
            patch.object(manage_router.repo_manage, "list_tasks") as single,
        ):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                manage_router.list_tasks_batch(request=Mock(), project_id=["p1", "p2"])
        single.assert_not_called()

    def test_list_tasks_batch_does_not_hide_authentication_failure(self) -> None:
        auth_error = HTTPException(status_code=401, detail="로그인이 필요합니다")
        with (
            patch.object(manage_router, "_require_workspace_read"),
            patch.object(manage_router, "_require_project_read", side_effect=auth_error),
            patch.object(manage_router.repo_manage, "list_tasks_batch") as batch,
        ):
            with self.assertRaises(HTTPException) as raised:
                manage_router.list_tasks_batch(request=Mock(), project_id=["p1"])
        self.assertEqual(raised.exception.status_code, 401)
        batch.assert_not_called()

    def test_task_projects_skips_only_inaccessible_projects(self) -> None:
        projects = [{"id": "hidden"}, {"id": "missing"}, {"id": "visible"}]

        def require_project(_request, project_id, _workspace_id, **kwargs):
            self.assertTrue(kwargs.get("workspace_checked"))
            if project_id == "hidden":
                raise HTTPException(status_code=403, detail="권한 없음")
            if project_id == "missing":
                raise HTTPException(status_code=404, detail="없는 프로젝트")

        with (
            patch.object(manage_router, "_require_workspace_read") as require_workspace,
            patch.object(
                manage_router.repo_manage,
                "task_projects_for_workspace",
                return_value=projects,
            ),
            patch.object(manage_router, "_require_project_read", side_effect=require_project),
        ):
            result = manage_router.list_task_projects(Mock(), "workspace-a")

        self.assertEqual(result, {"projects": [{"id": "visible"}]})
        require_workspace.assert_called_once()

    def test_task_projects_does_not_hide_authentication_or_server_failure(self) -> None:
        for status_code in (401, 500):
            with self.subTest(status_code=status_code):
                error = HTTPException(status_code=status_code, detail="조회 실패")
                with (
                    patch.object(manage_router, "_require_workspace_read"),
                    patch.object(
                        manage_router.repo_manage,
                        "task_projects_for_workspace",
                        return_value=[{"id": "p1"}],
                    ),
                    patch.object(manage_router, "_require_project_read", side_effect=error),
                ):
                    with self.assertRaises(HTTPException) as raised:
                        manage_router.list_task_projects(Mock(), "workspace-a")
                self.assertEqual(raised.exception.status_code, status_code)

    def test_list_tasks_batch_rejects_oversized_request_instead_of_truncating(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            manage_router.list_tasks_batch(
                request=Mock(), project_id=[f"p{i}" for i in range(501)]
            )
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("최대 500개", raised.exception.detail)

    def test_folder_sync_chunks_sqlite_parameters(self) -> None:
        class GuardedConnection:
            def __init__(self, inner):
                self.inner = inner
                self.max_params = 0

            def execute(self, sql, params=()):
                self.max_params = max(self.max_params, len(params))
                if len(params) > manage_tasks._SQLITE_IN_BATCH:
                    raise AssertionError("SQLite 변수 상한을 넘는 쿼리")
                return self.inner.execute(sql, params)

        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            guarded = GuardedConnection(conn)
            manage_tasks.sync_folder_tasks_batch(
                guarded, [f"project-{index}" for index in range(901)]
            )
        self.assertEqual(guarded.max_params, manage_tasks._SQLITE_IN_BATCH)

    def test_task_read_cache_coalesces_identical_concurrent_queries(self) -> None:
        expected = {"p1": [{"id": "t1"}]}

        def slow_read(*_args, **_kwargs):
            manage_tasks.time.sleep(0.05)
            return expected

        manage_tasks.clear_task_read_cache()
        with (
            patch.object(manage_tasks, "_TASK_READ_CACHE_TTL", 1.0),
            patch.object(manage_tasks, "get_db_path", return_value=Path("load.db")),
            patch.object(manage_tasks, "_task_cache_stamp", return_value=("stable",)),
            patch.object(
                manage_tasks,
                "_list_tasks_batch_uncached",
                side_effect=slow_read,
            ) as uncached,
            ThreadPoolExecutor(max_workers=20) as executor,
        ):
            results = list(
                executor.map(
                    lambda _index: manage_tasks.list_tasks_batch(
                        ["p1"], workspace_id="workspace-a"
                    ),
                    range(20),
                )
            )

        self.assertEqual(results, [expected] * 20)
        uncached.assert_called_once_with(
            ["p1"], include_archived=False, workspace_id="workspace-a"
        )
        manage_tasks.clear_task_read_cache()

    def test_task_cache_stamp_changes_when_same_path_database_is_replaced(self) -> None:
        """flush_pool 에폭은 파일 메타가 같은 복원본도 이전 캐시와 구분해야 한다."""
        same_file_stamp = (1_700_000_000_000_000_000, 4096)
        with (
            patch.object(manage_tasks, "get_db_path", return_value=Path("same.db")),
            patch.object(manage_tasks, "_file_stamp", return_value=same_file_stamp),
            patch.object(manage_tasks, "pool_epoch", side_effect=[41, 42]),
        ):
            before = manage_tasks._task_cache_stamp()
            after = manage_tasks._task_cache_stamp()

        self.assertNotEqual(before, after)
        self.assertEqual(before[0], after[0])
        self.assertEqual(before[2:], after[2:])
        self.assertEqual((before[1], after[1]), (41, 42))

    def test_singleflight_locks_share_while_live_and_release_after_use(self) -> None:
        """장기 서버에서 키 잠금은 경합 동안만 공유되고 영구 누적되지 않는다."""
        manage_tasks.clear_task_read_cache()
        manage_router._TASK_RESPONSE_FLIGHTS.clear()

        read_lock = manage_tasks._task_flight_lock(("read",))
        response_lock = manage_router._task_response_lock(("response",))
        self.assertIs(read_lock, manage_tasks._task_flight_lock(("read",)))
        self.assertIs(response_lock, manage_router._task_response_lock(("response",)))

        del read_lock, response_lock
        gc.collect()
        self.assertNotIn(("read",), manage_tasks._TASK_READ_FLIGHTS)
        self.assertNotIn(("response",), manage_router._TASK_RESPONSE_FLIGHTS)

    def test_response_cache_does_not_store_old_payload_under_new_db_stamp(self) -> None:
        key = ("race",)
        manage_router._TASK_RESPONSE_CACHE.clear()
        with (
            patch.object(manage_router, "_TASK_RESPONSE_TTL", 1.0),
            patch.object(
                manage_router.repo_manage_tasks,
                "_task_cache_stamp",
                side_effect=[("new",), ("new",)],
            ),
        ):
            response = manage_router._task_json_response(
                key,
                {"p1": [{"id": "old"}]},
                expected_stamp=("old",),
            )

        self.assertEqual(json.loads(response.body), {"p1": [{"id": "old"}]})
        self.assertNotIn(key, manage_router._TASK_RESPONSE_CACHE)

    def test_task_response_can_cache_browser_compatible_gzip(self) -> None:
        key = ("gzip",)
        payload = {"p1": [{"id": str(index), "name": "작업" * 20} for index in range(20)]}
        manage_router._TASK_RESPONSE_CACHE.clear()
        with (
            patch.object(manage_router, "_TASK_RESPONSE_TTL", 1.0),
            patch.object(
                manage_router.repo_manage_tasks,
                "_task_cache_stamp",
                return_value=("stable",),
            ),
        ):
            first = manage_router._task_json_response(
                key,
                payload,
                expected_stamp=("stable",),
                gzip_encoded=True,
            )
            second = manage_router._task_json_response(
                key,
                {"must": "not be encoded again"},
                expected_stamp=("stable",),
                gzip_encoded=True,
            )

        self.assertEqual(first.headers["content-encoding"], "gzip")
        self.assertEqual(first.headers["vary"], "Accept-Encoding")
        self.assertEqual(first.headers["cache-control"], "private, no-cache")
        self.assertEqual(json.loads(gzip.decompress(first.body)), payload)
        self.assertEqual(second.body, first.body)

    def test_accepts_gzip_honors_explicit_rejection(self) -> None:
        self.assertTrue(manage_router._accepts_gzip("br, gzip"))
        self.assertTrue(manage_router._accepts_gzip("*;q=0.5"))
        self.assertFalse(manage_router._accepts_gzip("gzip;q=0, *;q=1"))
        self.assertFalse(manage_router._accepts_gzip("br"))

    def test_task_etag_changes_with_data_scope_and_representation(self) -> None:
        base = manage_router._task_response_etag(("p1", False), ("db", 1))
        self.assertTrue(manage_router._etag_matches(base, base))
        self.assertNotEqual(
            base,
            manage_router._task_response_etag(("p1", False), ("db", 2)),
        )
        self.assertNotEqual(
            base,
            manage_router._task_response_etag(("p1", True), ("db", 1)),
        )
        self.assertNotEqual(
            base,
            manage_router._task_response_etag(("p2", False), ("db", 1)),
        )

    def test_tasks_batch_etag_skips_unchanged_large_payload(self) -> None:
        request = Mock(headers={"accept-encoding": "gzip"})
        expected = {"p1": [{"id": "t1"}]}
        with (
            patch.object(manage_router, "_require_workspace_read"),
            patch.object(manage_router, "_require_project_read"),
            patch.object(
                manage_router.repo_manage,
                "list_tasks_batch",
                return_value=expected,
            ) as batch,
        ):
            first = manage_router.list_tasks_batch(request=request, project_id=["p1"])
        etag = first.headers["etag"]
        self.assertTrue(etag)
        self.assertEqual(json.loads(gzip.decompress(first.body)), expected)
        batch.assert_called_once()

        unchanged_request = Mock(
            headers={
                "accept-encoding": "gzip",
                "if-none-match": f"W/{etag}",
            }
        )
        with (
            patch.object(manage_router, "_require_workspace_read"),
            patch.object(manage_router, "_require_project_read"),
            patch.object(manage_router.repo_manage, "list_tasks_batch") as unchanged_batch,
        ):
            unchanged = manage_router.list_tasks_batch(
                request=unchanged_request,
                project_id=["p1"],
            )

        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(unchanged.body, b"")
        self.assertEqual(unchanged.headers["etag"], etag)
        self.assertNotIn("content-encoding", unchanged.headers)
        unchanged_batch.assert_not_called()

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
                "task_contexts",
                return_value={
                    "t1": {"project_id": "p1", "workspace_unresolved": False, "is_current": True},
                    "t2": {"project_id": "p2", "workspace_unresolved": False, "is_current": True},
                },
            ) as contexts,
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
        contexts.assert_called_once_with(["t1", "t2"])
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
            patch.object(manage_router.repo_manage, "task_contexts", return_value={}),
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
                "task_contexts",
                return_value={
                    "t1": {"project_id": "p1", "workspace_unresolved": False, "is_current": True},
                    "t2": {"project_id": "p1", "workspace_unresolved": False, "is_current": True},
                },
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
