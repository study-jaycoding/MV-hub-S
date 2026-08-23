"""공유 서버 주소 변경 탈출구(B안) — probe·주소 이력·Host 가드.

서버가 이사하거나 IP 가 바뀌면 로그인이 실패하고 화면 전체가 로그인창에 갇힌다(주소를
바꿀 관리자 UI 는 로그인해야 열린다). 그 데드락의 탈출구를 이루는 세 계약을 고정한다:

1. ``POST /api/shared-server/probe`` — 주소만 확인하고 **저장하지 않는다**. 무토큰·
   리다이렉트 금지·JSON 전용·응답 크기 상한.
2. 주소 이력(``shared_server_url_history``) — 로그인 성공 시점에 '이전 주소'만 쌓인다
   (토큰·이메일 금지, 중복 제거, 상한 5).
3. 연결 설정 8개 라우트는 loopback 전용이며 Host 헤더까지 검사한다(DNS 리바인딩 방어).
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
import urllib.error
from email.message import Message
from unittest import mock

from fastapi import HTTPException, Request

from app import db, repo
from app.routers import publish
from app.services import net_guard


def _request(client_host: str = "127.0.0.1", host_header: str | None = None) -> Request:
    headers = [(b"host", host_header.encode())] if host_header is not None else []
    return Request({"type": "http", "client": (client_host, 40000), "headers": headers})


def _connection_routes(request: Request):
    """연결 설정 라우트 전체(기존 7 + 신규 probe) — 가드 대상 표."""
    return [
        lambda: publish.shared_server_status(request),
        lambda: publish.shared_server_login(
            publish.SharedLoginIn(email="a@b.c", password="pw", url="http://10.0.0.9"),
            request,
        ),
        lambda: publish.shared_server_register(
            publish.SharedRegisterIn(email="a@b.c", password="pw", name="n"), request
        ),
        lambda: publish.shared_server_logout(request),
        lambda: publish.shared_server_elevate(
            publish.ElevateIn(email="admin", password="pw"), request
        ),
        lambda: publish.shared_server_de_elevate(request),
        lambda: publish.set_shared_url(publish.SetUrlIn(url="http://x"), request),
        lambda: publish.probe_shared_server(publish.ProbeUrlIn(url="http://x"), request),
    ]


def _health_response(
    *, status: int = 200, content_type: str = "application/json", body: bytes = b'{"cli_version": "1.1.23"}'
):
    headers = Message()
    headers["Content-Type"] = content_type

    class _Resp:
        def __init__(self):
            self.status = status
            self.headers = headers

        def read(self, size: int = -1) -> bytes:
            return body[:size] if size and size > 0 else body

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    return _Resp()


def _run_before_publish(email, uid, *, before_publish=None):
    """_switch_account_db 대역 — 계정 DB 전환 없이 세션 저장 콜백만 실행한다."""
    if before_publish is not None:
        before_publish()


def _opener(result):
    """net_guard.guarded_opener() 대역 — open() 이 result 를 주거나(예외면) 던진다."""
    if isinstance(result, Exception):
        return mock.Mock(open=mock.Mock(side_effect=result))
    return mock.Mock(open=mock.Mock(return_value=result))


class SharedServerUrlEscapeTests(unittest.TestCase):
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

    # ── 1. loopback + Host 가드 ────────────────────────────────────────────
    def test_remote_requests_are_rejected_on_all_eight_routes(self):
        for operation in _connection_routes(_request(client_host="192.168.1.50")):
            with self.assertRaises(HTTPException) as caught:
                operation()
            self.assertEqual(caught.exception.status_code, 403)

    def test_rebinding_host_header_is_rejected_even_from_loopback(self):
        # DNS 리바인딩: 공격자 도메인이 127.0.0.1 로 재해석되면 접속은 loopback 이지만
        # Host 에는 그 도메인이 남는다 — 클라이언트 IP 만 보던 가드의 구멍.
        for operation in _connection_routes(_request(host_header="evil.example.com:8010")):
            with self.assertRaises(HTTPException) as caught:
                operation()
            self.assertEqual(caught.exception.status_code, 403)

    def test_local_host_headers_pass_the_guard(self):
        for host in ("127.0.0.1:8010", "localhost:8010", "[::1]:8010", "localhost"):
            status = publish.shared_server_status(_request(host_header=host))
            self.assertTrue(status["configured"], host)
        # Host 헤더가 없는 요청(브라우저 아님)은 종전대로 통과한다.
        self.assertTrue(publish.shared_server_status(_request())["configured"])

    def test_malformed_host_header_is_rejected(self):
        for host in ("127.0.0.1:port", "evil.example.com@127.0.0.1", "", "  "):
            request = _request(host_header=host)
            if not host.strip():
                self.assertTrue(publish.shared_server_status(request)["configured"])
                continue
            with self.assertRaises(HTTPException) as caught:
                publish.shared_server_status(request)
            self.assertEqual(caught.exception.status_code, 403)

    # ── 2. probe ─────────────────────────────────────────────────────────
    def test_probe_rejects_bad_urls_before_any_network_call(self):
        with mock.patch.object(publish.net_guard, "guarded_opener") as opener:
            for bad in ("ftp://x", "http://", "http://u:p@h", "http://h?q=1", "not-a-url"):
                with self.assertRaises(HTTPException) as caught:
                    publish.probe_shared_server(publish.ProbeUrlIn(url=bad), _request())
                self.assertEqual(caught.exception.status_code, 400)
            opener.assert_not_called()

    def test_probe_accepts_mv_hub_health_and_reports_version(self):
        with mock.patch.object(
            publish.net_guard, "guarded_opener", return_value=_opener(_health_response())
        ) as opener:
            out = publish.probe_shared_server(
                publish.ProbeUrlIn(url="http://192.168.1.199:8010/"), _request()
            )
        self.assertEqual(
            out,
            {
                "url": "http://192.168.1.199:8010",  # 정규화(후행 슬래시 제거)
                "ok": True,
                "reachable": True,
                "server_version": "1.1.23",
                "reason": None,
            },
        )
        # 무토큰 — Authorization 헤더를 붙이지 않는다(오타 주소로 세션이 새지 않게).
        sent = opener.return_value.open.call_args.args[0]
        self.assertFalse(sent.has_header("Authorization"))

    def test_probe_never_saves_the_address(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        with mock.patch.object(
            publish.net_guard, "guarded_opener", return_value=_opener(_health_response())
        ):
            publish.probe_shared_server(
                publish.ProbeUrlIn(url="http://192.168.1.50:8010"), _request()
            )
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")

    def test_probe_rejects_non_mv_hub_responses(self):
        cases = [
            _health_response(body=b'{"status": "ok"}'),  # cli_version 없음
            _health_response(content_type="text/html", body=b"<html>portal</html>"),
            _health_response(status=204, body=b""),
            _health_response(body=b"x" * (publish._PROBE_MAX_BYTES + 1)),
            _health_response(body=b"not json"),
        ]
        for response in cases:
            with mock.patch.object(
                publish.net_guard, "guarded_opener", return_value=_opener(response)
            ):
                out = publish.probe_shared_server(
                    publish.ProbeUrlIn(url="http://192.168.1.50:8010"), _request()
                )
            self.assertFalse(out["ok"])
            self.assertTrue(out["reachable"])  # 응답은 왔다 — '주소 오타'와 구분되게
            self.assertTrue(out["reason"])

    def test_probe_reports_unreachable_and_redirect_separately(self):
        failures = {
            urllib.error.URLError("timed out"): False,  # 연결 자체 실패
            urllib.error.HTTPError("u", 500, "err", None, None): True,
            net_guard.BlockedURLError("redirect"): True,  # 3xx 추적 금지
        }
        for error, reachable in failures.items():
            with mock.patch.object(
                publish.net_guard, "guarded_opener", return_value=_opener(error)
            ):
                out = publish.probe_shared_server(
                    publish.ProbeUrlIn(url="http://192.168.1.50:8010"), _request()
                )
            self.assertFalse(out["ok"])
            self.assertEqual(out["reachable"], reachable)
            self.assertIsNone(out["server_version"])

    # ── 3. 주소 이력 ──────────────────────────────────────────────────────
    def test_status_exposes_url_history(self):
        self.assertEqual(publish.shared_server_status(_request())["url_history"], [])
        repo.set_setting(publish._K_URL_HISTORY, json.dumps(["http://a", "http://b"]))
        self.assertEqual(
            publish.shared_server_status(_request())["url_history"], ["http://a", "http://b"]
        )

    def test_url_history_survives_malformed_setting(self):
        for broken in ("{not json", json.dumps({"url": "http://a"}), json.dumps([1, None, "http://a", "http://a"])):
            repo.set_setting(publish._K_URL_HISTORY, broken)
            history = publish.shared_server_status(_request())["url_history"]
            self.assertTrue(all(isinstance(u, str) for u in history))

    def test_login_records_previous_address_only(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        self._login("http://192.168.1.50:8010")
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.50:8010")
        self.assertEqual(publish._url_history(), ["http://192.168.1.199:8010"])
        # 같은 주소로 다시 로그인해도 이력이 불어나지 않는다.
        self._login("http://192.168.1.50:8010")
        self.assertEqual(publish._url_history(), ["http://192.168.1.199:8010"])

    def test_url_history_dedupes_and_caps_at_five(self):
        for index in range(8):
            self._login(f"http://10.0.0.{index}:8010")
        history = publish._url_history()
        self.assertEqual(len(history), publish._URL_HISTORY_MAX)
        self.assertEqual(history[0], "http://10.0.0.6:8010")  # 최신순
        self.assertEqual(len(set(history)), len(history))

    def test_url_history_never_contains_token_or_email(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        self._login("http://192.168.1.50:8010")
        raw = repo.get_setting(publish._K_URL_HISTORY) or ""
        self.assertNotIn("secret-token", raw)
        self.assertNotIn("artist@example.com", raw)

    def test_failed_login_persists_nothing(self):
        """주소는 draft — 로그인 성공 전에는 저장되지 않는다(명세 3)."""
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        with mock.patch.object(publish, "_http_json", return_value=(401, {"detail": "no"})):
            with self.assertRaises(HTTPException):
                publish.shared_server_login(
                    publish.SharedLoginIn(
                        url="http://192.168.1.50:8010", email="a@b.c", password="pw"
                    ),
                    _request(),
                )
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")
        self.assertEqual(publish._url_history(), [])

    # ── 4. 가입도 같은 draft 규칙 ────────────────────────────────────────
    def test_register_uses_draft_url_for_the_request(self):
        """서버가 이사한 뒤 합류하는 작업자도 새 주소로 가입할 수 있어야 한다."""
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        out = self._register("http://192.168.1.50:8010", token=None, status_value="pending")
        called = out["http_json"].call_args.args[1]
        self.assertEqual(called, "http://192.168.1.50:8010/api/auth/register")

    def test_register_rejects_bad_url_before_any_network_call(self):
        with mock.patch.object(publish, "_http_json") as http_json:
            for bad in ("ftp://x", "http://", "http://u:p@h", "http://h?q=1", "not-a-url"):
                with self.assertRaises(HTTPException) as caught:
                    publish.shared_server_register(
                        publish.SharedRegisterIn(url=bad, email="a@b.c", password="pw"),
                        _request(),
                    )
                self.assertEqual(caught.exception.status_code, 400)
            http_json.assert_not_called()

    def test_register_without_url_keeps_using_the_saved_address(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        out = self._register(None, token=None, status_value="pending")
        self.assertEqual(
            out["http_json"].call_args.args[1], "http://192.168.1.199:8010/api/auth/register"
        )
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")

    def test_register_saves_address_only_when_a_session_is_created(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        # 승인대기(토큰 없음) — 세션이 없으므로 주소도 이력도 그대로.
        self._register("http://192.168.1.50:8010", token=None, status_value="pending")
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")
        self.assertEqual(publish._url_history(), [])
        # 첫 계정(자동 admin 승인, 토큰 발급) — 그때만 저장 + 이전 주소가 이력에.
        self._register("http://192.168.1.50:8010", token="secret-token", status_value="approved")
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.50:8010")
        self.assertEqual(publish._url_history(), ["http://192.168.1.199:8010"])

    def test_failed_register_persists_nothing(self):
        repo.set_setting(publish._K_URL, "http://192.168.1.199:8010")
        with mock.patch.object(publish, "_http_json", return_value=(400, {"detail": "중복"})):
            with self.assertRaises(HTTPException):
                publish.shared_server_register(
                    publish.SharedRegisterIn(
                        url="http://192.168.1.50:8010", email="a@b.c", password="pw"
                    ),
                    _request(),
                )
        self.assertEqual(repo.get_setting(publish._K_URL), "http://192.168.1.199:8010")
        self.assertEqual(publish._url_history(), [])

    def _register(self, url, *, token, status_value: str) -> dict:
        account = {
            "email": "artist@example.com",
            "name": "Artist",
            "global_roles": [],
            "status": status_value,
        }
        response: dict = {"account": account}
        if token:
            response["token"] = token
        with (
            mock.patch.object(publish, "_http_json", return_value=(200, response)) as http_json,
            mock.patch.object(publish, "_switch_account_db", side_effect=_run_before_publish),
            mock.patch.object(publish, "kick_share_state_reconciler"),
        ):
            publish.shared_server_register(
                publish.SharedRegisterIn(
                    url=url, email="artist@example.com", password="pw", name="Artist"
                ),
                _request(),
            )
        return {"http_json": http_json}

    def _login(self, url: str) -> None:
        with (
            mock.patch.object(
                publish,
                "_http_json",
                return_value=(
                    200,
                    {
                        "token": "secret-token",
                        "account": {"email": "artist@example.com", "name": "Artist", "global_roles": []},
                    },
                ),
            ),
            mock.patch.object(publish, "_switch_account_db", side_effect=_run_before_publish),
            mock.patch.object(publish, "kick_share_state_reconciler"),
        ):
            publish.shared_server_login(
                publish.SharedLoginIn(url=url, email="artist@example.com", password="pw"),
                _request(),
            )


if __name__ == "__main__":
    unittest.main()
