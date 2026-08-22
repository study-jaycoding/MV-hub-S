"""R7 0-A(코덱스 P1) — 공유 서버 '연결 설정' 라우트의 loopback 가드·URL 정규화.

원격(비 loopback) 계정이 서버 공용 설정·토큰·elevation 을 읽거나 바꾸고, login
body.url 로 내부망 SSRF 를 만드는 경로를 막는다. 발행 데이터 경로는 가드 대상이 아니다.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from fastapi import HTTPException, Request

from app import db
from app.routers import publish


def _local() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 40000), "headers": []})


def _remote() -> Request:
    return Request({"type": "http", "client": ("192.168.1.50", 40000), "headers": []})


class SharedServerLocalGuardTests(unittest.TestCase):
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

    def test_remote_requests_are_rejected_on_all_seven_routes(self):
        remote = _remote()
        operations = [
            lambda: publish.shared_server_status(remote),
            lambda: publish.shared_server_login(
                publish.SharedLoginIn(email="a@b.c", password="pw", url="http://10.0.0.9"),
                remote,
            ),
            lambda: publish.shared_server_register(
                publish.SharedRegisterIn(email="a@b.c", password="pw", name="n"), remote
            ),
            lambda: publish.shared_server_logout(remote),
            lambda: publish.shared_server_elevate(
                publish.ElevateIn(email="admin", password="pw"), remote
            ),
            lambda: publish.shared_server_de_elevate(remote),
            lambda: publish.set_shared_url(publish.SetUrlIn(url="http://x"), remote),
        ]
        for operation in operations:
            with self.assertRaises(HTTPException) as caught:
                operation()
            self.assertEqual(caught.exception.status_code, 403)

    def test_local_request_passes_guard_and_url_is_normalized_before_network(self):
        # 잘못된 URL 은 외부 요청 '전에' 400 — _http_json 이 불리면 실패로 간주
        with mock.patch.object(publish, "_http_json") as http_json:
            for bad in ("ftp://x", "http://", "http://u:p@h", "http://h?q=1", "not-a-url"):
                with self.assertRaises(HTTPException) as caught:
                    publish.shared_server_login(
                        publish.SharedLoginIn(email="a@b.c", password="pw", url=bad),
                        _local(),
                    )
                self.assertEqual(caught.exception.status_code, 400)
            http_json.assert_not_called()
        # 사설 IP·localhost 는 허용(팀 서버는 LAN) — 네트워크까지 도달(모의 실패 응답)
        with mock.patch.object(
            publish, "_http_json", return_value=(500, {"detail": "down"})
        ) as http_json:
            with self.assertRaises(HTTPException) as caught:
                publish.shared_server_login(
                    publish.SharedLoginIn(
                        email="a@b.c", password="pw", url="http://192.168.1.199:8010"
                    ),
                    _local(),
                )
            self.assertEqual(caught.exception.status_code, 400)  # 로그인 실패(가드 아님)
            http_json.assert_called_once()

    def test_publish_data_routes_are_not_guarded(self):
        # 데이터 경로는 가드 비대상 — 원격 Request 로도 403 없이 기존 로직이 그대로 돈다.
        result = publish.publish_to_shared(
            publish.PublishToSharedIn(gen_ids=[]), _remote()
        )
        self.assertIsInstance(result, dict)


if __name__ == "__main__":
    unittest.main()
