"""Advisory quota decisions and authenticated authority routing, with no provider calls."""

import asyncio
from http.client import IncompleteRead
import unittest
from unittest import mock

from fastapi import HTTPException

from app import active_account, db, repo
from app.models import GenerationCreate, GenerationOut, GenRequestIn, WorkspaceContext
from app.routers import gen_requests, manage_quota
from app.services.credit_quota import UNAVAILABLE_WARNING, quota_decision
from app.usecases.gen_requests import PersonalQuotaExceeded
import test_gen_request_idempotency as idempotency_tests

_Request = idempotency_tests._Request


class AdvisoryDecisionTests(unittest.TestCase):
    def test_decision_table(self):
        base = {"workspace_id": "ws", "source": "override", "quota": 4000, "remaining": 0}
        self.assertIsNotNone(quota_decision(base, "ws")[0])
        self.assertIsNotNone(quota_decision({**base, "remaining": -0.12}, "ws")[0])
        self.assertEqual(quota_decision({**base, "remaining": 0.12}, "ws"), (None, None))
        self.assertEqual(quota_decision({**base, "remaining": 0, "exhausted": False}, "ws"), (None, None))
        for value in (None, {}, {**base, "workspace_id": "other"}, {**base, "source": "unavailable"},
                      {**base, "remaining": float("nan")}, {**base, "quota": True}):
            with self.subTest(value=value):
                self.assertEqual(quota_decision(value, "ws"), (None, UNAVAILABLE_WARNING))
        for source in ("unassigned", "unlimited"):
            self.assertIsNone(quota_decision({**base, "source": source}, "ws")[0])

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


class AdvisorySubmissionTests(unittest.TestCase):
    setUp = idempotency_tests.GenRequestIdempotencyTests.setUp
    tearDown = idempotency_tests.GenRequestIdempotencyTests.tearDown
    _command = staticmethod(idempotency_tests.GenRequestIdempotencyTests._command)
    _submit = staticmethod(idempotency_tests.GenRequestIdempotencyTests._submit)

    def test_accepted_retry_survives_later_quota_exhaustion(self):
        command = self._command("same", "33333333-3333-4333-8333-333333333333")
        first = self._submit(command)
        response = GenerationOut.model_validate({**first, "quota_warning": UNAVAILABLE_WARNING})
        self.assertEqual(response.model_dump()["quota_warning"], UNAVAILABLE_WARNING)
        command.quota_block_reason = "exhausted"
        self.assertEqual(self._submit(command)["id"], first["id"])

    def test_new_request_is_not_queued_if_exhausted(self):
        command = self._command("new", "44444444-4444-4444-8444-444444444444")
        command.quota_block_reason = "exhausted"
        with self.assertRaises(PersonalQuotaExceeded):
            self._submit(command)
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM generation").fetchone()[0], 0)
            # The reusable idempotency reservation is not executable by an agent.
            statuses = [row[0] for row in conn.execute("SELECT status FROM gen_request")]
            self.assertEqual(statuses, ["preparing"])
        self.assertFalse(repo.has_pending_requests(command.email, workspace_capable=True))
        self.assertEqual(repo.claim_pending_requests(command.email, workspace_capable=True,
                                                    submission_stage_capable=True, lease_owner="test-agent"), [])
        command.quota_block_reason = None
        self.assertIsNotNone(self._submit(command))

    def test_unavailable_proxy_warns_but_authorization_denial_does_not_pass(self):
        body = GenRequestIn(kind="create", workspace=WorkspaceContext(scope="team", id="ws", name="WS"),
                            create=GenerationCreate(prompt="test", model="model"))
        with mock.patch.object(gen_requests, "update_in_progress", return_value=False), \
             mock.patch.object(gen_requests, "MANAGE_ENABLED", True), \
             mock.patch.object(gen_requests, "_require_generation_deployment_open", new=mock.AsyncMock()), \
             mock.patch.object(gen_requests, "_validated_generation_workspace", return_value=body.workspace), \
             mock.patch.object(gen_requests._proxy, "proxying", return_value=True), \
             mock.patch.object(gen_requests._proxy, "proxy_json", side_effect=HTTPException(502, "offline")) as proxy, \
             mock.patch.object(gen_requests, "submit_gen_request", new=mock.AsyncMock(return_value={"id": "new"})) as submit, \
             mock.patch.object(gen_requests, "schedule_telemetry_drain"):
            result = asyncio.run(gen_requests.create_gen_request(body, _Request()))
            self.assertEqual(result["quota_warning"], UNAVAILABLE_WARNING)
            self.assertEqual(submit.await_count, 1)
            for error in (HTTPException(404, "old server"), IncompleteRead(b"", 10),
                          asyncio.TimeoutError(), ValueError("invalid response")):
                proxy.side_effect = error
                result = asyncio.run(gen_requests.create_gen_request(body, _Request()))
                self.assertEqual(result["quota_warning"], UNAVAILABLE_WARNING)
            self.assertEqual(submit.await_count, 5)
            proxy.side_effect = HTTPException(403, "not a member")
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(gen_requests.create_gen_request(body, _Request()))
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(submit.await_count, 5)

    def test_proxy_quota_uses_request_account_and_restores_context(self):
        expected = {"workspace_id": "ws", "quota": 4000}

        def read_proxy(*args, **kwargs):
            self.assertEqual(active_account.account_key(), "artist@example.com")
            self.assertEqual(active_account.active_uid(), "artist")
            return expected

        with active_account.pinned_account_scope(("another@example.com", "another")), \
             mock.patch.object(active_account.config, "AUTH_ENABLED", False), \
             mock.patch.object(gen_requests._proxy, "proxying", return_value=True), \
             mock.patch.object(gen_requests._proxy, "proxy_json", side_effect=read_proxy):
            self.assertEqual(gen_requests._read_generation_quota(_Request.state.account, "ws"), expected)
            self.assertEqual(active_account.account_key(), "another@example.com")
            self.assertEqual(active_account.active_uid(), "another")

    def test_real_proxy_authorization_errors_stop_submission(self):
        body = GenRequestIn(kind="create", workspace=WorkspaceContext(scope="team", id="ws", name="WS"),
                            create=GenerationCreate(prompt="test", model="model"))
        proxy = gen_requests._proxy
        with mock.patch.object(gen_requests, "update_in_progress", return_value=False), \
             mock.patch.object(gen_requests, "MANAGE_ENABLED", True), \
             mock.patch.object(gen_requests, "_require_generation_deployment_open", new=mock.AsyncMock()), \
             mock.patch.object(gen_requests, "_validated_generation_workspace", return_value=body.workspace), \
             mock.patch.object(proxy, "proxying", return_value=True), \
             mock.patch.object(proxy, "token", return_value="test-only"), \
             mock.patch.object(proxy, "elevation_token", return_value=None), \
             mock.patch.object(proxy, "base_url", return_value="http://isolated.invalid"), \
             mock.patch.object(proxy, "_handle_auth_failure", return_value=proxy.AUTH_STATE_PRESERVED), \
             mock.patch.object(proxy, "raw_request") as raw, \
             mock.patch.object(gen_requests, "submit_gen_request", new=mock.AsyncMock()) as submit:
            for status in (401, 403):
                with self.subTest(status=status):
                    raw.return_value = (status, {"detail": "denied"})
                    with self.assertRaises(HTTPException) as caught:
                        asyncio.run(gen_requests.create_gen_request(body, _Request()))
                    self.assertEqual(caught.exception.status_code, status)
            submit.assert_not_awaited()
