"""10분 슈퍼 관리자 세션의 보안 경계 특성화.

일반 로그인과 권한 토큰이 서로 대체되지 않는지, 현재 admin 계정에만 묶이는지,
서버 만료·재발급·수동 해제가 즉시 강제되는지를 검증한다.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request


def _request(account: dict, super_token: str | None = None) -> Request:
    headers = []
    if super_token:
        headers.append((b"x-mvhub-super-session", super_token.encode("ascii")))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/super-admin/elevate",
            "headers": headers,
            "client": ("127.0.0.1", 51000),
        }
    )
    request.state.account = account
    return request


class SuperAdminSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")

        from app import db, repo
        from app.routers import auth as auth_router

        db.flush_pool()
        db.init_db()
        self.account = repo.register("admin@example.com", "correct-password", "관리자")
        auth_router._rl_fails.clear()
        auth_router._rl_inflight.clear()

    def tearDown(self):
        from app import db
        from app.routers import auth as auth_router

        auth_router._rl_fails.clear()
        auth_router._rl_inflight.clear()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _elevate(self):
        from app import deps
        from app.routers import auth as auth_router

        with patch.object(deps, "AUTH_ENABLED", True):
            return asyncio.run(
                auth_router.elevate_super_admin(
                    auth_router.SuperAdminIn(password="correct-password"),
                    _request(self.account),
                )
            )

    def test_elevate_reauthenticates_current_admin_and_records_audit(self):
        from app import deps, repo
        from app.routers import auth as auth_router

        with patch.object(deps, "AUTH_ENABLED", True):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(
                    auth_router.elevate_super_admin(
                        auth_router.SuperAdminIn(password="wrong-password"),
                        _request(self.account),
                    )
                )
        self.assertEqual(caught.exception.status_code, 401)

        issued = self._elevate()
        self.assertTrue(issued["active"])
        self.assertEqual(issued["ttl_seconds"], 600)
        self.assertLessEqual(issued["expires_at"] - int(time.time()), 600)
        event = repo.list_audit_events(limit=1)[0]
        self.assertEqual(event["action"], "super_admin.issued")
        self.assertTrue(event["actor_uid"].startswith("account:"))
        self.assertNotIn("admin@example.com", event["actor_uid"])

    def test_super_token_cannot_be_used_as_normal_login(self):
        from app.services import auth

        issued = self._elevate()
        self.assertIsNone(auth.verify_token(issued["token"]))
        self.assertIsNone(auth.token_password_stamp(issued["token"]))

    def test_session_is_bound_to_current_account_and_permanent_admin_role(self):
        from app import deps

        issued = self._elevate()
        with patch.object(deps, "AUTH_ENABLED", True):
            claims = deps.super_admin_workspace_claims(_request(self.account, issued["token"]))
            self.assertIsNotNone(claims)

            other = {**self.account, "email": "other@example.com"}
            self.assertIsNone(deps.super_admin_workspace_claims(_request(other, issued["token"])))

            member = {**self.account, "global_role": "member", "global_roles": ["member"]}
            self.assertIsNone(deps.super_admin_workspace_claims(_request(member, issued["token"])))

    def test_reissue_revokes_previous_session_and_expiry_is_server_enforced(self):
        from app import deps, repo
        from app.repo import super_admin_sessions

        first = self._elevate()
        second = self._elevate()
        with patch.object(deps, "AUTH_ENABLED", True):
            self.assertIsNone(
                deps.super_admin_workspace_claims(_request(self.account, first["token"]))
            )
            self.assertIsNotNone(
                deps.super_admin_workspace_claims(_request(self.account, second["token"]))
            )

            with patch.object(super_admin_sessions.time, "time", return_value=second["expires_at"]):
                self.assertIsNone(
                    deps.super_admin_workspace_claims(_request(self.account, second["token"]))
                )

        claims = auth_claims(second["token"])
        self.assertTrue(repo.revoke_super_admin_session(str(claims["j"])))
        with patch.object(deps, "AUTH_ENABLED", True):
            self.assertIsNone(
                deps.super_admin_workspace_claims(_request(self.account, second["token"]))
            )


def auth_claims(token: str) -> dict:
    from app.services import auth

    claims = auth.verify_super_admin_token(token)
    assert isinstance(claims, dict)
    return claims


if __name__ == "__main__":
    unittest.main()
