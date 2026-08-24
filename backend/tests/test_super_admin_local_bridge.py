"""작업자 로컬 허브가 일반 로그인과 슈퍼 관리자 토큰을 분리해 보관·전달하는 계약."""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from unittest import mock

from fastapi import HTTPException, Request

from app import db, repo
from app.routers import publish
from app.services import shared_connection


def _local_request() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 52000), "headers": []})


class SuperAdminLocalBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.set_setting(publish._K_TOKEN, "normal-token")
        repo.set_setting(publish._K_EMAIL, "admin@example.com")
        repo.set_setting(publish._K_NAME, "관리자")
        repo.set_setting(publish._K_ROLES, json.dumps(["admin"]))

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_elevate_uses_current_login_and_stores_scoped_token_with_expiry(self):
        expires_at = int(time.time()) + 600
        with mock.patch.object(
            publish,
            "_http_json",
            return_value=(
                200,
                {
                    "ok": True,
                    "token": "scoped-token",
                    "expires_at": expires_at,
                },
            ),
        ) as remote:
            result = publish.shared_server_elevate(
                publish.ElevateIn(password="current-password"), _local_request()
            )

        remote.assert_called_once_with(
            "POST",
            mock.ANY,
            token="normal-token",
            body={"password": "current-password"},
        )
        self.assertEqual(repo.get_setting(shared_connection.K_ELEV_TOKEN), "scoped-token")
        self.assertEqual(
            repo.get_setting(shared_connection.K_ELEV_EXPIRES), str(expires_at)
        )
        self.assertTrue(result["super_admin_active"])
        self.assertEqual(result["elevated_as"], "admin@example.com")

    def test_non_admin_cannot_request_super_admin(self):
        repo.set_setting(publish._K_ROLES, json.dumps(["member"]))
        with mock.patch.object(publish, "_http_json") as remote:
            with self.assertRaises(HTTPException) as caught:
                publish.shared_server_elevate(
                    publish.ElevateIn(password="current-password"), _local_request()
                )
        self.assertEqual(caught.exception.status_code, 403)
        remote.assert_not_called()

    def test_manual_revoke_sends_both_tokens_and_clears_local_state(self):
        expires_at = int(time.time()) + 600
        repo.set_setting(shared_connection.K_ELEV_TOKEN, "scoped-token")
        repo.set_setting(shared_connection.K_ELEV_EXPIRES, str(expires_at))
        with mock.patch.object(publish, "_http_json", return_value=(200, {"ok": True})) as remote:
            result = publish.shared_server_de_elevate(_local_request())

        remote.assert_called_once_with(
            "POST",
            mock.ANY,
            token="normal-token",
            body={},
            timeout=10,
            super_token="scoped-token",
        )
        self.assertIsNone(repo.get_setting(shared_connection.K_ELEV_TOKEN))
        self.assertIsNone(repo.get_setting(shared_connection.K_ELEV_EXPIRES))
        self.assertFalse(result["super_admin_active"])


if __name__ == "__main__":
    unittest.main()
