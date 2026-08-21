"""정적 요청의 세션 계정 조회 스킵(R2 2-B) — 동적 경계(/api·/media)만 계정을 소비한다."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock


class StaticAuthSkipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        from app import db

        db.flush_pool()
        db.init_db()
        from fastapi.testclient import TestClient
        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))
        self.client.cookies.set("ch_session", "tok")

    def tearDown(self):
        from app import db

        self.client.close()
        db.flush_pool()
        for key, value in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        db.flush_pool()
        self.tmp.cleanup()

    def test_static_paths_skip_account_lookup_but_api_still_loads(self):
        import app.main as main_module

        with (
            mock.patch.object(main_module.auth_svc, "verify_token", return_value="u@x.com"),
            mock.patch.object(main_module.repo, "get_account", return_value=None) as get_account,
        ):
            # 정적 경계(SPA·자산): 쿠키가 있어도 토큰 검증·계정 조회를 하지 않는다.
            for path in ("/", "/assets/app-abc123.js", "/favicon.ico"):
                self.client.get(path)
            self.assertEqual(get_account.call_count, 0)
            # 동적 경계(/api/*): 공개 경로여도 종전대로 계정을 실어둔다(선택적 계정 API 계약).
            response = self.client.get("/api/health")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(get_account.call_count, 1)

    def test_snapshot_export_guard_still_closes_static_ui(self):
        # 스냅샷 전용 서버 가드는 정적 UI 까지 닫는 계약 — 스킵이 그 앞을 가로채면 안 된다.
        from app.main import SNAPSHOT_EXPORT_ENV

        with mock.patch.dict(os.environ, {SNAPSHOT_EXPORT_ENV: "1"}):
            response = self.client.get("/")
            self.assertEqual(response.status_code, 404)
            self.assertIn("스냅샷", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
