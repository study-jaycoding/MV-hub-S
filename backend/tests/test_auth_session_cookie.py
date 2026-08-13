"""Bearer 로그인 복원 시 WebSocket용 HttpOnly 쿠키도 함께 복구한다."""

from __future__ import annotations

from fastapi import Request, Response

from app.routers import auth as auth_router


def _request(token: str, cookie: str = "") -> Request:
    headers = [(b"authorization", f"Bearer {token}".encode("ascii"))]
    if cookie:
        headers.append((b"cookie", f"ch_session={cookie}".encode("ascii")))
    request = Request({"type": "http", "headers": headers, "client": ("127.0.0.1", 1234)})
    request.state.account = {"email": "member@example.com"}
    return request


def test_me_reissues_missing_websocket_cookie(monkeypatch):
    monkeypatch.setattr(auth_router, "_activate_local_agent", lambda *_: None)
    response = Response()

    auth_router.me(_request("valid-token"), response)

    cookie = response.headers.get("set-cookie", "")
    assert "ch_session=valid-token" in cookie
    assert "HttpOnly" in cookie


def test_me_does_not_rewrite_matching_cookie(monkeypatch):
    monkeypatch.setattr(auth_router, "_activate_local_agent", lambda *_: None)
    response = Response()

    auth_router.me(_request("valid-token", cookie="valid-token"), response)

    assert "set-cookie" not in response.headers
