"""작업 활동 조회의 신원·캐시·옵트인 HTTP 계약. 실제 서버 접근 없음."""

import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request
from starlette.responses import Response

from app.routers import manage


def request(headers=()):
    return Request({"type": "http", "client": ("127.0.0.1", 10), "headers": list(headers)})


class TaskActivityHttpTests(unittest.TestCase):
    def access(self, uid="u1", email="fixture@example.invalid", read_all=False):
        with (
            patch.object(manage._proxy, "is_shared_team_server", return_value=True),
            patch.object(manage, "AUTH_ENABLED", True),
            patch.object(manage, "current_account", return_value={"email": email}),
            patch.object(manage, "account_scope_uid", return_value=uid),
            patch.object(manage, "account_global_roles", return_value=[]),
            patch.object(manage.rbac, "has_global_cap", return_value=read_all),
        ):
            return manage._task_activity_access(request())

    def test_admin_keeps_explicit_identity_pair_and_only_own_preview(self):
        result = self.access(read_all=True)
        self.assertTrue(result["activity_read_all"])
        self.assertTrue(result["include_activity"])
        self.assertEqual(result["activity_viewer"], ("u1", "fixture@example.invalid"))
        self.assertEqual(result["preview_owner"], result["activity_viewer"])

    def test_member_is_not_all_and_unlinked_identity_is_not_all(self):
        self.assertFalse(self.access()["activity_read_all"])
        for uid, email in ((None, "fixture@example.invalid"), ("\x00", "fixture@example.invalid"), ("u1", "")):
            result = self.access(uid, email, read_all=True)
            self.assertIsNone(result["activity_viewer"])
            self.assertIsNone(result["preview_owner"])

    def test_tasks_and_batch_and_project_discovery_always_use_same_policy(self):
        access = self.access()
        with (
            patch.object(manage, "_require_workspace_read"),
            patch.object(manage, "_require_project_read"),
            patch.object(manage, "_refresh_isolated_telemetry"),
            patch.object(manage, "_task_activity_access", return_value=access),
            patch.object(manage, "_visible_tasks", side_effect=lambda req, rows: rows),
            patch.object(manage.repo_manage_tasks, "_task_cache_stamp", return_value=None),
            patch.object(manage.repo_manage, "list_tasks", return_value=[]) as single,
            patch.object(manage.repo_manage, "list_tasks_batch", return_value={"p": []}) as batch,
            patch.object(manage.repo_manage, "task_projects_for_workspace", return_value=[]) as projects,
        ):
            manage.list_tasks("p", request(), "w")
            result = manage.list_tasks_batch(request(), ["p"], "w")
            manage.list_task_projects(request(), "w")
        single.assert_called_once_with("p", include_archived=False, workspace_id="w", **access)
        batch.assert_called_once_with(["p"], include_archived=False, workspace_id="w", **access)
        projects.assert_called_once_with("w", include_historical=False, **access)
        self.assertEqual(json.loads(result.body), {"p": []})

    def test_local_mode_preserves_content_without_guessing_identity(self):
        with (
            patch.object(manage._proxy, "is_shared_team_server", return_value=False),
            patch.object(manage, "current_account") as account,
        ):
            result = manage._task_activity_access(request([(b"host", b"localhost:8012")]))
        self.assertEqual(result, {"include_activity": False, "activity_viewer": None,
                                  "activity_read_all": False, "preview_owner": None})
        account.assert_not_called()

    def test_local_mode_rejects_external_browser_instead_of_falling_back(self):
        with patch.object(manage._proxy, "is_shared_team_server", return_value=False):
            for headers, client in (
                ([(b"host", b"example.invalid")], "127.0.0.1"),
                ([(b"host", b"localhost"), (b"origin", b"https://example.invalid")], "127.0.0.1"),
                ([(b"host", b"localhost")], "192.0.2.5"),
                ([(b"host", b"localhost"), (b"sec-fetch-site", b"cross-site")], "127.0.0.1"),
            ):
                req = Request({"type": "http", "client": (client, 10), "headers": headers})
                with self.subTest(headers=headers, client=client), self.assertRaises(HTTPException) as raised:
                    manage._task_activity_access(req)
                self.assertEqual(raised.exception.status_code, 403)

    def test_local_and_team_denied_view_have_different_etags(self):
        denied = {"include_activity": True, "activity_viewer": None,
                  "activity_read_all": False, "preview_owner": None}
        local = {**denied, "include_activity": False}
        with (
            patch.object(manage, "_require_project_read"),
            patch.object(manage, "_refresh_isolated_telemetry"),
            patch.object(manage, "_visible_tasks", side_effect=lambda req, rows: rows),
            patch.object(manage.repo_manage_tasks, "_task_cache_stamp", return_value=("mode-stable",)),
            patch.object(manage.repo_manage, "list_tasks_batch", return_value={"p": []}),
            patch.object(manage, "_task_activity_access", side_effect=[local, denied]),
        ):
            first = manage.list_tasks_batch(request(), ["p"])
            second = manage.list_tasks_batch(request([(b"if-none-match", first.headers["etag"].encode())]), ["p"])
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.headers["etag"], second.headers["etag"])

    def test_same_snapshot_other_viewer_cannot_receive_304(self):
        first = self.access("u1", "first@example.invalid")
        second = self.access("u2", "second@example.invalid")
        with (
            patch.object(manage, "_require_workspace_read"),
            patch.object(manage, "_require_project_read"),
            patch.object(manage, "_refresh_isolated_telemetry"),
            patch.object(manage, "_visible_tasks", side_effect=lambda req, rows: rows),
            patch.object(manage.repo_manage_tasks, "_task_cache_stamp", return_value=("stable",)),
            patch.object(manage.repo_manage, "list_tasks_batch", return_value={"p": []}) as batch,
            patch.object(manage, "_task_activity_access", side_effect=[first, first, second]),
        ):
            initial = manage.list_tasks_batch(request(), ["p"], "w")
            cached_req = request([(b"if-none-match", initial.headers["etag"].encode())])
            unchanged = manage.list_tasks_batch(cached_req, ["p"], "w")
            changed = manage.list_tasks_batch(cached_req, ["p"], "w")
        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], initial.headers["etag"])
        self.assertNotIn("example.invalid", str(initial.headers))
        self.assertEqual(batch.call_count, 2)


class TaskActivityProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_team_failure_never_falls_back_to_local_private_content(self):
        for path in ("/api/manage/tasks", "/api/manage/tasks-batch", "/api/manage/task-projects"):
            req = Request({"type": "http", "method": "GET", "scheme": "http", "path": path,
                           "query_string": b"", "client": ("127.0.0.1", 10), "headers": []})
            local = AsyncMock(return_value=Response("local private data"))
            with (
                self.subTest(path=path),
                patch.object(manage._proxy, "proxying", return_value=True),
                patch.object(manage._proxy, "_forward", new=AsyncMock(return_value=Response("unavailable", 503))) as forward,
            ):
                response = await manage._proxy.data_proxy_middleware(req, local)
            self.assertEqual(response.status_code, 503)
            forward.assert_awaited_once()
            local.assert_not_awaited()
