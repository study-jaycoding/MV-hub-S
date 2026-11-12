"""test_dev 브라우저 로그인 ↔ 로컬 생성 에이전트 자동 연결 보안 계약."""

from __future__ import annotations

import os
import tempfile
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from app import active_account, db, repo
from app import main as main_module
from app.deps import SESSION_COOKIE
from app.main import app
from app.routers import auth as auth_router, ingest
from app.services import local_agent_pair


def _request(host: str = "127.0.0.1") -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/agent/local-pair-token",
            "headers": [],
            "client": (host, 50000),
            "server": ("127.0.0.1", 8012),
            "scheme": "http",
            "query_string": b"",
        }
    )


def test_pair_is_disabled_without_launcher_secret():
    request = _request()
    with patch.object(ingest, "LOCAL_AGENT_PAIR_SECRET", ""):
        with pytest.raises(HTTPException) as exc:
            ingest.local_agent_pair_token(ingest.LocalAgentPairIn(secret="anything"), request)
    assert exc.value.status_code == 404


def test_pair_requires_loopback_and_matching_one_time_secret():
    local = _request()
    remote = _request("192.168.1.50")
    with patch.object(ingest, "LOCAL_AGENT_PAIR_SECRET", "pair-key"), patch.object(
        local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key"
    ):
        local_agent_pair.clear(local)
        local_agent_pair.activate(local, "worker@example.com")

        for request, secret in ((remote, "pair-key"), (local, "wrong-key")):
            with pytest.raises(HTTPException) as exc:
                ingest.local_agent_pair_token(
                    ingest.LocalAgentPairIn(secret=secret), request
                )
            assert exc.value.status_code == 403

        local_agent_pair.clear(local)


def test_pair_issues_session_for_browser_account_and_clears_on_logout():
    request = _request()
    account = {
        "email": "worker@example.com",
        "status": "approved",
        "password_changed_at": "stamp-1",
    }
    with patch.object(ingest, "LOCAL_AGENT_PAIR_SECRET", "pair-key"), patch.object(
        local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key"
    ), patch.object(ingest.repo, "get_account", return_value=account), patch.object(
        ingest.auth_service, "make_token", return_value="session-token"
    ) as make_token, patch.object(ingest.agent_signals, "touch") as touch:
        local_agent_pair.clear(request)
        with pytest.raises(HTTPException) as waiting:
            ingest.local_agent_pair_token(
                ingest.LocalAgentPairIn(secret="pair-key"), request
            )
        assert waiting.value.status_code == 409

        local_agent_pair.activate(request, "WORKER@example.com")
        result = ingest.local_agent_pair_token(
            ingest.LocalAgentPairIn(secret="pair-key"), request
        )
        assert result == {"email": "worker@example.com", "token": "session-token"}
        make_token.assert_called_once_with("worker@example.com", pwd_stamp="stamp-1")
        touch.assert_called_once_with("worker@example.com")

        assert local_agent_pair.clear(request, "worker@example.com") == "worker@example.com"
        with pytest.raises(HTTPException) as waiting_again:
            ingest.local_agent_pair_token(
                ingest.LocalAgentPairIn(secret="pair-key"), request
            )
        assert waiting_again.value.status_code == 409


def test_http_login_pairs_agent_and_logout_unpairs_it():
    """공개 예외 미들웨어까지 포함한 실제 HTTP 계약을 임시 DB에서 검증한다."""
    old_db = os.environ.get("CONTENT_HUB_DB")
    old_no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY")
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            os.environ["CONTENT_HUB_DB"] = os.path.join(temp_dir, "content_hub.db")
            os.environ["CONTENT_HUB_NO_PROXY"] = "1"
            db.flush_pool()
            db.init_db()
            local_request = _request()
            with patch.object(main_module, "AUTH_ENABLED", True), patch.object(
                ingest, "LOCAL_AGENT_PAIR_SECRET", "pair-key"
            ), patch.object(local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key"):
                local_agent_pair.clear(local_request)
                client = TestClient(app, client=("127.0.0.1", 50000))
                try:
                    credentials = {
                        "email": "browser@example.com",
                        "password": "smoke-test-only",
                        "name": "Browser",
                    }
                    assert client.post("/api/auth/register", json=credentials).status_code == 200
                    login = client.post("/api/auth/login", json=credentials)
                    assert login.status_code == 200

                    paired = client.post(
                        "/api/agent/local-pair-token", json={"secret": "pair-key"}
                    )
                    assert paired.status_code == 200
                    assert paired.json()["email"] == "browser@example.com"
                    agent_headers = {"Authorization": f"Bearer {paired.json()['token']}"}
                    assert client.get("/api/agent/status", headers=agent_headers).json() == {
                        "connected": True
                    }

                    browser_headers = {"Authorization": f"Bearer {login.json()['token']}"}
                    assert client.post("/api/auth/logout", headers=browser_headers).status_code == 200
                    assert client.post(
                        "/api/agent/local-pair-token", json={"secret": "pair-key"}
                    ).status_code == 409
                finally:
                    client.close()
            db.flush_pool()
    finally:
        if old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = old_db
        if old_no_proxy is None:
            os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        else:
            os.environ["CONTENT_HUB_NO_PROXY"] = old_no_proxy
        db.flush_pool()


@pytest.fixture
def auth_clients(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "auth.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.setattr(main_module, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(ingest, "LOCAL_AGENT_PAIR_SECRET", "pair-key")
    monkeypatch.setattr(local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key")
    signal = Mock()
    monkeypatch.setattr(auth_router.agent_signals, "signal", signal)
    monkeypatch.setattr(ingest.agent_signals, "touch", Mock())
    db.flush_pool()
    db.init_db()
    local_agent_pair.clear(_request())
    direct = TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50000))
    relayed = TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50001))
    try:
        yield direct, relayed, signal
    finally:
        direct.close()
        relayed.close()
        local_agent_pair.clear(_request())
        db.flush_pool()


@pytest.fixture
def paired_auth(auth_clients):
    direct, relayed, signal = auth_clients
    account_a = {"email": "a@example.test", "password": "test-password"}
    account_b = {"email": "b@example.test", "password": "test-password"}
    response = direct.post("/api/auth/access", json=account_a)
    assert response.status_code == 200 and response.json()["token"]
    assert local_agent_pair.active_email() == account_a["email"]
    assert repo.get_setting("mcp_active_account") == account_a["email"]
    repo.register(**account_b)
    repo.set_account_status(account_b["email"], "approved")
    signal.reset_mock()
    return direct, relayed, signal, account_a, account_b


@pytest.mark.parametrize("endpoint", ["login", "access", "me"])
def test_relayed_auth_preserves_direct_pair_and_mcp_account(paired_auth, endpoint):
    direct, relayed, signal, account_a, account_b = paired_auth
    before = active_account.account_epoch()
    headers = {"X-MVHub-Relayed": "1"}
    if endpoint == "me":
        account = repo.get_account(account_b["email"])
        token = auth_router.auth.make_token(account_b["email"], pwd_stamp=account["password_changed_at"])
        headers["Authorization"] = f"Bearer {token}"
        response = relayed.get("/api/auth/me", headers=headers)
        assert response.status_code == 200
        cookie_matches = relayed.cookies.get(SESSION_COOKIE) == token
        assert cookie_matches
        account = response.json()
    else:
        response = relayed.post(f"/api/auth/{endpoint}", json=account_b, headers=headers)
        account = response.json()["account"]
        assert response.json()["token"]
        cookie_matches = relayed.cookies.get(SESSION_COOKIE) == response.json()["token"]
        assert cookie_matches
    assert response.status_code == 200
    assert account["email"] == account_b["email"]
    assert local_agent_pair.active_email() == account_a["email"]
    assert repo.get_setting("mcp_active_account") == account_a["email"]
    signal.assert_not_called()
    assert active_account.account_epoch() == before + (endpoint != "me")
    paired = direct.post("/api/agent/local-pair-token", json={"secret": "pair-key"})
    assert paired.status_code == 200 and paired.json()["email"] == account_a["email"]
    assert direct.post("/api/agent/local-pair-token", json={"secret": "wrong"}, headers=headers).status_code == 403


@pytest.mark.parametrize("marker", [None, "0", "true", "11"])
def test_direct_and_nonexact_relay_markers_still_switch_accounts(paired_auth, marker):
    direct, _, signal, account_a, _ = paired_auth
    account_c = repo.register("c@example.test", "test-password")
    repo.set_account_status(account_c["email"], "approved")
    token = auth_router.auth.make_token(account_c["email"], pwd_stamp=account_c["password_changed_at"])
    headers = {"Authorization": f"Bearer {token}"}
    if marker is not None:
        headers["X-MVHub-Relayed"] = marker
    before = active_account.account_epoch()
    response = direct.get("/api/auth/me", headers=headers)
    assert response.status_code == 200 and response.json()["email"] == account_c["email"]
    assert local_agent_pair.active_email() == account_c["email"]
    assert repo.get_setting("mcp_active_account") == account_c["email"]
    signal.assert_called_once_with(account_a["email"], "pair-change")
    assert active_account.account_epoch() == before + 1


@pytest.mark.parametrize("scenario", ["wrong-login", "wrong-access", "pending-login", "pending-access", "missing-me"])
def test_relay_marker_does_not_bypass_authentication_or_approval(paired_auth, scenario):
    _, relayed, signal, account_a, account_b = paired_auth
    before = active_account.account_epoch()
    headers = {"X-MVHub-Relayed": "1"}
    if scenario == "missing-me":
        response = relayed.get("/api/auth/me", headers=headers)
        assert response.status_code == 401
    else:
        state, endpoint = scenario.split("-")
        credentials = dict(account_b)
        if state == "wrong":
            credentials["password"] = "incorrect"
        else:
            repo.set_account_status(account_b["email"], "pending")
        response = relayed.post(f"/api/auth/{endpoint}", json=credentials, headers=headers)
        expected = 401 if state == "wrong" else (403 if endpoint == "login" else 200)
        assert response.status_code == expected
        if scenario == "pending-access":
            assert response.json()["pending"] is True and response.json()["token"] is None
    assert not relayed.cookies.get(SESSION_COOKIE)
    assert local_agent_pair.active_email() == account_a["email"]
    assert repo.get_setting("mcp_active_account") == account_a["email"]
    signal.assert_not_called()
    assert active_account.account_epoch() == before


@pytest.mark.parametrize("marker", [None, "1"])
def test_first_access_keeps_auto_approval_and_only_direct_pairing(auth_clients, marker):
    direct, relayed, signal = auth_clients
    client = direct if marker is None else relayed
    headers = {} if marker is None else {"X-MVHub-Relayed": marker}
    before = active_account.account_epoch()
    response = client.post("/api/auth/access", json={"email": "first@example.test", "password": "test-password"}, headers=headers)
    assert response.status_code == 200
    result = response.json()
    assert result["account"]["status"] == "approved" and result["pending"] is False
    assert result["token"]
    cookie_matches = client.cookies.get(SESSION_COOKIE) == result["token"]
    assert cookie_matches
    expected = "first@example.test" if marker is None else None
    assert local_agent_pair.active_email() == expected
    assert repo.get_setting("mcp_active_account") == expected
    signal.assert_not_called()
    assert active_account.account_epoch() == before + 1


def test_direct_logout_keeps_pair_clear_even_with_relay_marker(paired_auth):
    direct, _, signal, account_a, _ = paired_auth
    before = active_account.account_epoch()
    response = direct.post("/api/auth/logout", headers={"X-MVHub-Relayed": "1"})
    assert response.status_code == 200
    assert local_agent_pair.active_email() is None
    assert not direct.cookies.get(SESSION_COOKIE)
    signal.assert_called_once_with(account_a["email"], "pair-change")
    assert active_account.account_epoch() == before + 1
