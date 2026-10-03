"""공유 서버에 닿지 않을 때의 경로(2026-10-03 실사용 로그·격리 재현 → Codex 합의 F1·F3′·F5).

- F1: 업데이터가 설치 뒤 묻는 /api/ready 는 이 허브의 준비 상태다 — 서버로 중계되면 서버가 꺼졌거나 느릴 때
  새 판이 떠도 '업데이트 실패'가 됐다. 위임 판정(DB 토큰 조회)조차 하지 않고 로컬이 답한다.
- F3′: 응답 없는 서버 주소는 Windows 에서 연결을 21초 붙잡았다. TCP 연결만 3초로 끊고, 연결 뒤 응답은 호출의 제한 그대로.
- F5: 응답 없이 예외·취소로 끝난 요청은 예외 종류 이름을 기록에 남긴다(중계된 진짜 500 과 구분).
"""

from __future__ import annotations

import asyncio
import http.server
import json
import socket
import threading
import time
import unittest
from unittest.mock import patch

from starlette.requests import Request

from app.routers import _proxy


def _request(path: str, method: str = "GET") -> Request:
    return Request({
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"host", b"127.0.0.1:8767")],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8767),
        "scheme": "http",
    })


class ReadinessIsAnsweredLocally(unittest.TestCase):
    def test_ready_and_health_skip_proxy_decision_and_forwarding(self):
        async def call_next(_req):
            return "local"

        async def no_forward(_req):
            raise AssertionError("서버로 중계하면 안 된다")

        for path in ("/api/ready", "/api/health"):
            with self.subTest(path=path), \
                    patch.object(_proxy, "proxying", side_effect=AssertionError("위임 판정(DB 토큰 조회)을 하면 안 된다")), \
                    patch.object(_proxy, "_forward", no_forward):
                self.assertEqual(asyncio.run(_proxy.data_proxy_middleware(_request(path), call_next)), "local")

    def test_ready_is_a_local_path(self):
        self.assertTrue(_proxy.is_local_path("/api/ready"))

    def test_other_api_paths_are_still_forwarded(self):
        forwarded: list[str] = []

        async def call_next(_req):
            return "local"

        async def fake_forward(req):
            forwarded.append(req.url.path)
            return "forwarded"

        with patch.object(_proxy, "proxying", return_value=True), patch.object(_proxy, "_forward", fake_forward):
            result = asyncio.run(_proxy.data_proxy_middleware(_request("/api/update-notices"), call_next))
        self.assertEqual((result, forwarded), ("forwarded", ["/api/update-notices"]))


class _FakeSock:
    def __init__(self):
        self.timeouts: list = []

    def settimeout(self, value):
        self.timeouts.append(value)


class ConnectStepOnlyIsShort(unittest.TestCase):
    def _connect(self, *args):
        calls = []
        sock = _FakeSock()

        def fake_create(address, timeout, source_address=None, **kwargs):
            calls.append((address, timeout, source_address))
            return sock

        with patch.object(_proxy.socket, "create_connection", side_effect=fake_create):
            assert _proxy._fast_connect(*args) is sock
        return calls, sock.timeouts

    def test_connect_is_capped_and_call_timeout_is_restored_after(self):
        self.assertEqual(self._connect(("h", 80), 60, None), ([(("h", 80), 3.0, None)], [60]))
        self.assertEqual(self._connect(("h", 80), 2, None), ([(("h", 80), 2, None)], [2]))

    def test_default_timeout_sentinel_follows_process_default(self):
        with patch.object(_proxy.socket, "getdefaulttimeout", return_value=None):
            calls, after = self._connect(("h", 80))
        self.assertEqual((calls[0][1], after), (3.0, [None]))  # 연결 3초, 연결 뒤는 기본값(무제한) 그대로
        with patch.object(_proxy.socket, "getdefaulttimeout", return_value=1.5):
            calls, after = self._connect(("h", 80))
        self.assertEqual((calls[0][1], after), (1.5, [1.5]))

    def test_http_and_https_connections_use_it_and_opener_keeps_proxy_handler(self):
        self.assertIs(_proxy._FastConnectHTTPConnection("example.invalid", 80, timeout=5)._create_connection,
                      _proxy._fast_connect)
        self.assertIs(_proxy._FastConnectHTTPSConnection("example.invalid", 443, timeout=5)._create_connection,
                      _proxy._fast_connect)
        # 기본 urlopen 의 핸들러 구성과 같고 HTTP/HTTPS 만 바뀐다(ProxyHandler 는 프록시 설정이 있을 때만 붙는 것도 같다).
        import urllib.request

        ours = {type(h).__name__ for h in _proxy._SERVER_OPENER.handlers}
        default = {type(h).__name__ for h in urllib.request.build_opener().handlers}
        self.assertEqual(ours - {"_FastConnectHTTPHandler", "_FastConnectHTTPSHandler"},
                         default - {"HTTPHandler", "HTTPSHandler"})
        self.assertTrue({"_FastConnectHTTPHandler", "_FastConnectHTTPSHandler"} <= ours)

    def test_slow_response_after_connect_still_waits_for_the_call_timeout(self):
        """연결은 됐는데 응답이 연결 제한보다 늦어도 끊지 않는다 — 무거운 요청을 깨지 않는다(Codex 조건)."""

        class Slow(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                time.sleep(0.6)
                body = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Slow)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/x"
            with patch.object(_proxy, "_CONNECT_TIMEOUT_S", 0.2), \
                    patch.dict("os.environ", {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}):
                status, data = _proxy.raw_request("GET", url, timeout=5)
            self.assertEqual((status, data), (200, {"ok": True}))
        finally:
            server.shutdown()
            server.server_close()

    def test_refused_connection_still_becomes_502(self):
        from fastapi import HTTPException

        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()  # 아무도 듣지 않는 포트
        with patch.dict("os.environ", {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}):
            with self.assertRaises(HTTPException) as ctx:
                _proxy.raw_request("GET", f"http://127.0.0.1:{port}/x", timeout=5)
        self.assertEqual(ctx.exception.status_code, 502)


class ErrorStatusSurvivesAnUnreadableBody(unittest.TestCase):
    """Codex 코드 리뷰 P2 — 서버가 503·401 머리만 보내고 본문이 멈추면 날 TimeoutError 가 새어 500 이 됐다.
    받은 상태 코드는 지킨다(부분 응답·보강 중단은 503 을, 인증 처리는 401 을 그대로 본다)."""

    def _http_error(self, code: int):
        import email.message
        import urllib.error

        class StalledBody:
            def read(self, *_args):
                raise TimeoutError("timed out")

            def close(self):
                pass

        return urllib.error.HTTPError("http://server/x", code, "x", email.message.Message(), StalledBody())

    def test_status_is_kept_when_the_error_body_times_out(self):
        for code in (503, 401):
            with self.subTest(code=code), patch.object(_proxy, "_open", side_effect=self._http_error(code)):
                self.assertEqual(_proxy.raw_request("GET", "http://server/x", timeout=5), (code, ""))

    def test_partial_batch_still_works_when_the_503_body_stalls(self):
        from fastapi import HTTPException

        with patch.object(_proxy, "_open", side_effect=self._http_error(503)), \
                patch.object(_proxy, "base_url", return_value="http://server"), \
                patch.object(_proxy, "token", return_value="t"):
            with self.assertRaises(HTTPException) as ctx:
                _proxy.proxy_json("POST", "/api/generations/batch", body={"gen_ids": ["x"]}, timeout=15)
        self.assertEqual(ctx.exception.status_code, 503)  # 라우트가 부분 응답으로 바꾸는 코드 그대로


class FailedRequestRecordsErrorKind(unittest.TestCase):
    def _observe(self, exc: BaseException) -> list[dict]:
        from app import main

        logged: list[dict] = []

        def fake_log_event(_logger, event, **fields):
            logged.append({"event": event, **fields})

        async def call_next(_req):
            raise exc

        with patch.object(main, "log_event", fake_log_event):
            with self.assertRaises(type(exc)):
                asyncio.run(main.runtime_observation(_request("/api/whatever"), call_next))
        return logged

    def test_exception_and_cancel_are_named_and_reraised(self):
        for exc in (RuntimeError("boom"), asyncio.CancelledError()):
            with self.subTest(kind=type(exc).__name__):
                logged = self._observe(exc)
                self.assertEqual(len(logged), 1)
                self.assertEqual(logged[0]["status"], 500)
                self.assertEqual(logged[0]["error_kind"], type(exc).__name__)
                self.assertNotIn("boom", json.dumps(logged[0], ensure_ascii=False))  # 메시지는 남기지 않는다


if __name__ == "__main__":
    unittest.main()
