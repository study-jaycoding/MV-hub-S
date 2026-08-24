"""공유 서버 401이 실제 세션 만료일 때만 저장 토큰을 지우는 계약."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from unittest import mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from app import main as main_app
from app.routers import _proxy


class _AuthProbeHandler(BaseHTTPRequestHandler):
    me_status = 200

    def do_GET(self):  # noqa: N802 — stdlib handler contract
        status = self.me_status if self.path == "/api/auth/me" else 401
        payload = b'{"email":"member@example.com"}' if status == 200 else b'{"detail":"denied"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format, *_args):
        return


def _request(path: str = "/api/manage/summary") -> Request:
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1234),
            "server": ("127.0.0.1", 8012),
        },
        receive,
    )


@pytest.fixture(autouse=True)
def _clear_probe_cache():
    _proxy._AUTH_PROBE_CACHE.clear()
    _proxy._AUTH_PROBE_IN_FLIGHT.clear()
    yield
    _proxy._AUTH_PROBE_CACHE.clear()
    _proxy._AUTH_PROBE_IN_FLIGHT.clear()


@pytest.fixture
def auth_probe_server():
    _AuthProbeHandler.me_status = 200
    server = ThreadingHTTPServer(("127.0.0.1", 0), _AuthProbeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", _AuthProbeHandler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_proxy_json_preserves_token_when_me_confirms_session():
    stored = {"shared_server_token": "token-a"}

    def setting(key, value=mock.sentinel.read):
        if value is mock.sentinel.read:
            return stored.get(key)
        stored[key] = value

    raw = mock.Mock(side_effect=[(401, {"detail": "request denied"}), (200, {"email": "a"})])
    with (
        mock.patch.object(_proxy, "token", return_value="token-a"),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", raw),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: setting(key)),
        mock.patch.object(_proxy.repo, "set_setting", side_effect=setting),
        pytest.raises(HTTPException) as raised,
    ):
        _proxy.proxy_json("GET", "/api/manage/summary")

    assert raised.value.status_code == 401
    assert raised.value.detail == "request denied"
    assert raised.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_PRESERVED}
    assert stored["shared_server_token"] == "token-a"


def test_proxy_json_keeps_normal_identity_and_adds_scoped_super_token_separately():
    raw = mock.Mock(return_value=(200, {"ok": True}))
    with (
        mock.patch.object(_proxy, "token", return_value="normal-token"),
        mock.patch.object(_proxy, "elevation_token", return_value="scoped-token"),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", raw),
    ):
        _proxy.proxy_json(
            "PUT",
            "/api/generations/workspace/batch",
            body={"generation_ids": ["g1"]},
            use_super_admin=True,
        )

    call = raw.call_args
    assert call.kwargs["token"] == "normal-token"
    assert call.kwargs["super_token"] == "scoped-token"


def test_proxy_json_clears_only_current_token_when_me_confirms_expiry():
    stored = {"shared_server_token": "token-a"}
    raw = mock.Mock(side_effect=[(401, {"detail": "denied"}), (401, {"detail": "login required"})])

    with (
        mock.patch.object(_proxy, "token", return_value="token-a"),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", raw),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ),
        pytest.raises(HTTPException) as raised,
    ):
        _proxy.proxy_json("GET", "/api/manage/summary")

    assert raised.value.detail == "공유 서버 로그인이 만료됐습니다(다시 로그인)"
    assert raised.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_INVALID}
    assert stored["shared_server_token"] is None


def test_auth_probe_failure_preserves_login_instead_of_guessing_expiry():
    stored = {"shared_server_token": "token-a"}
    raw = mock.Mock(
        side_effect=[
            (401, {"detail": "denied"}),
            HTTPException(status_code=502, detail="offline"),
        ]
    )
    with (
        mock.patch.object(_proxy, "token", return_value="token-a"),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", raw),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ),
        pytest.raises(HTTPException) as raised,
    ):
        _proxy.proxy_json("GET", "/api/manage/summary")

    assert raised.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_PRESERVED}
    assert stored["shared_server_token"] == "token-a"


def test_late_invalid_response_does_not_clear_new_login():
    stored = {"shared_server_token": "token-b"}
    with (
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", return_value=(401, {"detail": "expired"})),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ) as set_setting,
    ):
        state = _proxy._handle_auth_failure(
            "shared_server_token", "token-a", "/api/manage/summary"
        )

    assert state == _proxy.AUTH_STATE_PRESERVED
    assert stored["shared_server_token"] == "token-b"
    set_setting.assert_not_called()


def test_many_401s_share_one_me_probe():
    with (
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", return_value=(200, {"email": "a"})) as raw,
        mock.patch.object(_proxy.repo, "get_setting", return_value="token-a"),
    ):
        with ThreadPoolExecutor(max_workers=32) as pool:
            states = list(
                pool.map(
                    lambda _index: _proxy._handle_auth_failure(
                        "shared_server_token", "token-a", "/api/manage/summary"
                    ),
                    range(100),
                )
            )

    assert states == [_proxy.AUTH_STATE_PRESERVED] * 100
    raw.assert_called_once()


def test_parallel_401_does_not_wait_for_slow_auth_probe():
    started = threading.Event()
    release = threading.Event()

    def slow_probe(*_args, **_kwargs):
        started.set()
        assert release.wait(timeout=2)
        return 200, {"email": "a"}

    with (
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "raw_request", side_effect=slow_probe) as raw,
        ThreadPoolExecutor(max_workers=1) as pool,
    ):
        first = pool.submit(_proxy._probe_token_state, "token-a")
        assert started.wait(timeout=1)
        # 첫 확인이 네트워크를 기다리는 동안 두 번째 요청은 즉시 판정 불가로 보존된다.
        assert _proxy._probe_token_state("token-a") == "unknown"
        release.set()
        assert first.result(timeout=1) == "valid"

    raw.assert_called_once()


def test_forward_marks_request_401_without_clearing_valid_session():
    request = _request()

    async def to_thread(func, *args):
        if func is _proxy._handle_auth_failure:
            return _proxy.AUTH_STATE_PRESERVED
        return 401, b'{"detail":"request denied"}', "application/json"

    with (
        mock.patch.object(_proxy.asyncio, "to_thread", side_effect=to_thread),
        mock.patch.object(_proxy, "base_url", return_value="http://server.test"),
        mock.patch.object(_proxy, "token", return_value="token-a"),
    ):
        response = asyncio.run(_proxy._forward(request))

    assert response.status_code == 401
    assert response.headers[_proxy.AUTH_STATE_HEADER] == _proxy.AUTH_STATE_PRESERVED


def test_me_401_is_authoritative_without_recursive_probe():
    stored = {"shared_server_token": "token-a"}
    with (
        mock.patch.object(_proxy, "_probe_token_state") as probe,
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ),
    ):
        state = _proxy._handle_auth_failure("shared_server_token", "token-a", "/api/auth/me")

    assert state == _proxy.AUTH_STATE_INVALID
    assert stored["shared_server_token"] is None
    probe.assert_not_called()


def test_auth_middleware_marks_missing_session_as_invalid():
    called = False

    async def call_next(_request):
        nonlocal called
        called = True
        return Response(status_code=200)

    with (
        mock.patch.object(main_app, "AUTH_ENABLED", True),
        mock.patch.object(main_app, "session_token", return_value=None),
    ):
        response = asyncio.run(main_app.auth_enforcement(_request(), call_next))

    assert response.status_code == 401
    assert response.headers[_proxy.AUTH_STATE_HEADER] == _proxy.AUTH_STATE_INVALID
    assert called is False


def test_auth_middleware_marks_route_401_as_preserved_for_valid_session():
    async def call_next(_request):
        return Response(status_code=401)

    account = {
        "email": "member@example.com",
        "status": "approved",
        "password_changed_at": None,
    }
    with (
        mock.patch.object(main_app, "AUTH_ENABLED", True),
        mock.patch.object(main_app, "session_token", return_value="valid-token"),
        mock.patch.object(main_app.auth_svc, "verify_token", return_value="member@example.com"),
        mock.patch.object(main_app.repo, "get_account", return_value=account),
    ):
        response = asyncio.run(main_app.auth_enforcement(_request(), call_next))

    assert response.status_code == 401
    assert response.headers[_proxy.AUTH_STATE_HEADER] == _proxy.AUTH_STATE_PRESERVED


def test_real_http_401_keeps_valid_token_after_me_confirmation(auth_probe_server):
    server_url, _handler = auth_probe_server
    stored = {"shared_server_token": "token-a"}
    with (
        mock.patch.object(_proxy, "base_url", return_value=server_url),
        mock.patch.object(_proxy, "token", return_value="token-a"),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ),
        pytest.raises(HTTPException) as raised,
    ):
        _proxy.proxy_json("GET", "/api/denied")

    assert raised.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_PRESERVED}
    assert stored["shared_server_token"] == "token-a"


def test_real_http_401_clears_token_only_after_me_401(auth_probe_server):
    server_url, handler = auth_probe_server
    handler.me_status = 401
    stored = {"shared_server_token": "token-a"}
    with (
        mock.patch.object(_proxy, "base_url", return_value=server_url),
        mock.patch.object(_proxy, "token", return_value="token-a"),
        mock.patch.object(_proxy.repo, "get_setting", side_effect=lambda key: stored.get(key)),
        mock.patch.object(
            _proxy.repo, "set_setting", side_effect=lambda key, value: stored.__setitem__(key, value)
        ),
        pytest.raises(HTTPException) as raised,
    ):
        _proxy.proxy_json("GET", "/api/denied")

    assert raised.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_INVALID}
    assert stored["shared_server_token"] is None
