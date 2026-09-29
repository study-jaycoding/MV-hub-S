"""개인 몫은 '보이기만' 한다(Jay 2026-09-30) — 조회 경로 권한과, 생성이 몫을 확인하지 않는다는 것.

09-28 에 넣었던 '남은 몫 0 이하면 새 생성 거절'은 09-30 Jay 결정으로 되돌렸다. 한도 초과는 힉스필드 CLI 가
'크레딧 부족'으로 거절한다. 생성 직전 공유 서버 조회는 무응답이면 팀 생성마다 5~6초를 먹고(C2), 401/403 이면
정상 팀원도 막을 수 있었다(C1) — 그래서 생성 경로는 my-quota 를 아예 부르지 않는다.
"""

import asyncio
import unittest
from unittest import mock

from fastapi import HTTPException

from app.models import GenerationCreate, GenRequestIn, WorkspaceContext
from app.routers import gen_requests, manage_quota
import test_gen_request_idempotency as idempotency_tests

_Request = idempotency_tests._Request


class QuotaReadRouteTests(unittest.TestCase):
    def test_local_without_authority_is_unavailable(self):
        with mock.patch.object(manage_quota, "AUTH_ENABLED", False), mock.patch.object(manage_quota._proxy, "proxying", return_value=False):
            result = manage_quota.my_credit_quota(_Request(), "ws")
        self.assertEqual(result["source"], "unavailable")
        self.assertIsNone(result["quota"])

    def test_member_scope_is_checked_even_for_manager(self):
        with mock.patch.object(manage_quota, "AUTH_ENABLED", True), mock.patch.object(manage_quota._proxy, "proxying", return_value=False), \
             mock.patch.object(manage_quota.repo, "list_workspace_options", return_value=[]):
            with self.assertRaises(HTTPException) as caught:
                manage_quota.my_credit_quota(_Request(), "other")
        self.assertEqual(caught.exception.status_code, 403)


class GenerationDoesNotCheckQuotaTests(unittest.TestCase):
    def test_team_create_never_reads_my_quota(self):
        """공유 서버가 403·무응답이어도 팀 생성은 그대로 접수된다 — 몫 조회 자체를 하지 않는다."""
        body = GenRequestIn(kind="create", workspace=WorkspaceContext(scope="team", id="ws", name="WS"),
                            create=GenerationCreate(prompt="test", model="model"))
        with mock.patch.object(gen_requests, "update_in_progress", return_value=False), \
             mock.patch.object(gen_requests, "_require_generation_deployment_open", new=mock.AsyncMock()), \
             mock.patch.object(gen_requests, "_validated_generation_workspace", return_value=body.workspace), \
             mock.patch("app.routers._proxy.proxying", return_value=True), \
             mock.patch("app.routers._proxy.proxy_json", side_effect=HTTPException(403, "not a member")) as proxy, \
             mock.patch.object(gen_requests, "submit_gen_request", new=mock.AsyncMock(return_value={"id": "new"})) as submit, \
             mock.patch.object(gen_requests, "schedule_telemetry_drain"):
            result = asyncio.run(gen_requests.create_gen_request(body, _Request()))
        self.assertEqual(result["id"], "new")
        self.assertNotIn("quota_warning", result)
        self.assertEqual(submit.await_count, 1)
        self.assertFalse(any("my-quota" in str(call) for call in proxy.call_args_list))
