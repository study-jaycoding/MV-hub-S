"""Bearer 로그인 복원 시 WebSocket용 HttpOnly 쿠키도 함께 복구한다."""

from __future__ import annotations

import asyncio
from http.cookies import SimpleCookie
import pytest
from fastapi import Request, Response

from app.routers import auth as auth_router


def _request(token: str, cookie: str = "", scheme: str = "http") -> Request:
    headers = [(b"authorization", f"Bearer {token}".encode("ascii"))]
    if cookie:
        headers.append((b"cookie", f"ch_session={cookie}".encode("ascii")))
    request = Request({"type": "http", "scheme": scheme, "path": "/api/auth/me",
                       "headers": headers, "client": ("127.0.0.1", 1234),
                       "server": ("127.0.0.1", 18091)})
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


@pytest.mark.parametrize("scheme", ["http", "https"])
@pytest.mark.parametrize("route", ["register", "login", "access-existing", "access-new", "me"])
def test_session_cookie_security_on_every_issue_site(monkeypatch, scheme, route):
    account = {"email": "member@example.com", "status": "approved"}
    monkeypatch.setattr(auth_router, "_activate_local_agent", lambda *args: None)
    monkeypatch.setattr(auth_router.active_account, "bump_account_epoch", lambda: None)
    monkeypatch.setattr(auth_router.repo, "register", lambda *args: account)
    monkeypatch.setattr(auth_router.repo, "authenticate", lambda *args: account)
    monkeypatch.setattr(auth_router.auth, "make_token", lambda *args, **kwargs: "valid-token")
    lookups = iter([None, account] if route == "access-new" else [account, account])
    monkeypatch.setattr(auth_router.repo, "get_account", lambda *args: next(lookups))
    for name in ("_rl_reserve", "_rl_release", "_rl_ok"):
        monkeypatch.setattr(auth_router, name, lambda *args: None)
    request = _request("valid-token", "valid-token" if scheme == "https" else "", scheme)
    response = Response()
    if route == "me":
        auth_router.me(request, response)
    else:
        method = route.split("-")[0]
        body_type = auth_router.LoginIn if method == "login" else auth_router.RegisterIn
        asyncio.run(getattr(auth_router, method)(
            body_type(email=account["email"], password="synthetic"), response, request))
    cookie = SimpleCookie(response.headers["set-cookie"])["ch_session"]
    assert cookie.value == "valid-token"
    assert bool(cookie["secure"]) is (scheme == "https")
    assert cookie["httponly"] and cookie["samesite"] == "lax" and cookie["path"] == "/"
    assert int(cookie["max-age"]) > 0


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_logout_cookie_matches_issue_attributes(monkeypatch, scheme):
    from app.repo import mcp_v2

    monkeypatch.setattr(mcp_v2, "revoke_account", lambda *args: None)
    monkeypatch.setattr(auth_router.local_agent_pair, "clear", lambda *args: None)
    monkeypatch.setattr(auth_router.active_account, "bump_account_epoch", lambda: None)
    request = _request("valid-token", scheme=scheme)
    issued, deleted = Response(), Response()
    auth_router._set_session_cookie(issued, "valid-token", request)
    auth_router.logout(deleted, request)
    before = SimpleCookie(issued.headers["set-cookie"])["ch_session"]
    after = SimpleCookie(deleted.headers["set-cookie"])["ch_session"]
    for attribute in ("path", "domain", "httponly", "samesite", "secure"):
        assert before[attribute] == after[attribute]
    assert bool(after["secure"]) is (scheme == "https")
    assert after["max-age"] == "0" and after["expires"]
