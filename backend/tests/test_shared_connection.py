"""공유 서버 연결 정보 단일 출처(services.shared_connection) 계약."""

from __future__ import annotations

import os
import tempfile
import unittest

import pytest

from app import db, repo
from app.services import shared_connection


@pytest.mark.parametrize("left,right,expected", [
    ("http://HOST:8010/", "https://host:8010", True),
    ("http://host", "https://host", False),
    ("http://host", "https://host:80", True),
    ("http://host:443", "https://host", True),
    ("http://host:8010/Base/", "https://host:8010/Base", True),
    ("http://host:8010/Base", "https://host:8010/base", False),
    ("http://host:8010/a", "https://host:8010/b", False),
    ("http://host:8010", "https://other:8010", False),
    ("http://host:8010", "https://host:8011", False),
    ("http://[::1]:8010", "https://[::1]:8010/", True),
])
def test_same_shared_server(left, right, expected):
    assert shared_connection.same_shared_server(left, right) is expected
    assert shared_connection.same_shared_server(right, left) is expected


@pytest.mark.parametrize("url", [
    "", "host:8010", "http://", "ftp://host:8010", "http://host:0",
    "http://host:-1", "http://host:65536", "http://host:bad", "http://[bad",
    "http://user@host:8010", "http://@host:8010", "http://host:8010?q=1",
    "http://host:8010#fragment", "http://ho\nst:8010",
])
def test_invalid_urls_only_match_identical_values(url):
    assert shared_connection.same_shared_server(url, url)
    assert not shared_connection.same_shared_server(url, "https://host:8010")


def test_identical_legacy_url_short_circuits_validation(monkeypatch):
    def unexpected_validation(url):
        raise AssertionError("identical URL must not need a parsed key")

    monkeypatch.setattr(shared_connection, "_shared_server_key", unexpected_validation)
    assert shared_connection.same_shared_server(" http://legacy:0/ ", "http://legacy:0")


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
        self.assertEqual(shared_connection.DEFAULT_SHARED_URL, "http://192.168.1.171:8010")  # 2026-10-02 서버 이사

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

        # MCP v2(2026-10-15)가 _proxy.base_url·token 을 '고정 연결' 래퍼로 감쌌다 — 고정이 없으면 공유 연결로 되돌아간다.
        #  원천이 공유 연결 함수 그 자체이고 고정이 없을 때 같은 값을 주는지 본다(test_comment_byid_account_pin 의 f637b8e3 과 같은 맞춤).
        self.assertIsNone(_proxy._PINNED_CONNECTION.get())
        self.assertIs(_proxy._stored_base_url, shared_connection.base_url)
        self.assertIs(_proxy._stored_token, shared_connection.token)
        self.assertEqual((_proxy.base_url(), _proxy.token()), (shared_connection.base_url(), shared_connection.token()))
        self.assertIs(_proxy.elevation_token, shared_connection.elevation_token)
        self.assertIs(publish._effective_url, shared_connection.base_url)
        self.assertEqual(_proxy._K_TOKEN, shared_connection.K_TOKEN)
        self.assertEqual(publish._K_URL, shared_connection.K_URL)


if __name__ == "__main__":
    unittest.main()
