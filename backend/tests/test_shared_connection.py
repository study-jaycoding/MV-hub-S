"""공유 서버 연결 정보 단일 출처(services.shared_connection) 계약."""

from __future__ import annotations

import os
import tempfile
import unittest

from app import db, repo
from app.services import shared_connection


class SharedConnectionContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_default_url_is_fixed_at_import_time(self):
        if os.environ.get("CONTENT_HUB_SHARED_URL"):
            self.skipTest("env 가 설정된 환경에서는 기본값 리터럴 검증을 건너뛴다")
        self.assertEqual(shared_connection.DEFAULT_SHARED_URL, "http://192.168.1.199:8010")

    def test_setting_wins_and_trailing_slash_is_stripped(self):
        repo.set_setting(shared_connection.K_URL, "http://share.example.test/")
        self.assertEqual(shared_connection.base_url(), "http://share.example.test")

    def test_empty_setting_falls_back_to_default(self):
        repo.set_setting(shared_connection.K_URL, "")
        self.assertEqual(shared_connection.base_url(), shared_connection.DEFAULT_SHARED_URL)

    def test_whitespace_setting_is_used_verbatim(self):
        # 특성화: 공백뿐인 문자열은 truthy 라 종전대로 그대로 쓰인다(빈 문자열과 다름).
        repo.set_setting(shared_connection.K_URL, "  ")
        self.assertEqual(shared_connection.base_url(), "  ")

    def test_base_url_rereads_setting_on_every_call(self):
        repo.set_setting(shared_connection.K_URL, "http://first.test")
        self.assertEqual(shared_connection.base_url(), "http://first.test")
        repo.set_setting(shared_connection.K_URL, "http://second.test")
        self.assertEqual(shared_connection.base_url(), "http://second.test")

    def test_tokens_read_settings_or_none(self):
        self.assertIsNone(shared_connection.token())
        self.assertIsNone(shared_connection.elevation_token())
        repo.set_setting(shared_connection.K_TOKEN, "tok")
        repo.set_setting(shared_connection.K_ELEV_TOKEN, "elev")
        self.assertEqual(shared_connection.token(), "tok")
        self.assertEqual(shared_connection.elevation_token(), "elev")

    def test_proxy_and_publish_delegate_to_single_source(self):
        from app.routers import _proxy, publish

        self.assertIs(_proxy.base_url, shared_connection.base_url)
        self.assertIs(_proxy.token, shared_connection.token)
        self.assertIs(_proxy.elevation_token, shared_connection.elevation_token)
        self.assertIs(publish._effective_url, shared_connection.base_url)
        self.assertEqual(_proxy._K_TOKEN, shared_connection.K_TOKEN)
        self.assertEqual(publish._K_URL, shared_connection.K_URL)


if __name__ == "__main__":
    unittest.main()
