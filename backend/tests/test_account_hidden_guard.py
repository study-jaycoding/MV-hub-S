"""계정 숨김의 '자기 계정 잠금 방지' 가드 회귀 테스트.

예전엔 비교 좌변이 strip 없이 lower 만 해서, 세션 이메일에 앞뒤 공백이 든 legacy
데이터면 자기 계정 판정이 빗나가 스스로를 숨길 수 있었다(가드 우회). 양변 norm_email 고정.
"""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.routers import auth as auth_router
from app.routers.auth import HiddenIn


class AccountHiddenGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _request(self, session_email: str) -> SimpleNamespace:
        return SimpleNamespace(state=SimpleNamespace(account={"email": session_email}))

    def test_self_hide_is_blocked_even_with_legacy_whitespace_email(self):
        with mock.patch.object(auth_router, "require_admin"):
            with self.assertRaises(HTTPException) as ctx:
                auth_router.set_hidden(
                    "admin@example.com",
                    HiddenIn(hidden=True),
                    self._request(" Admin@Example.com "),  # legacy 공백+대소문자
                )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_hiding_another_account_still_works(self):
        repo.register("other@example.com", "pw123456", name="Other")
        with mock.patch.object(auth_router, "require_admin"):
            acc = auth_router.set_hidden(
                "other@example.com", HiddenIn(hidden=True), self._request("admin@example.com")
            )
        self.assertTrue(acc["hidden"])


if __name__ == "__main__":
    unittest.main()
