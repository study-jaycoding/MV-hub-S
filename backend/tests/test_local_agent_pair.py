"""test_dev 브라우저 로그인 ↔ 로컬 생성 에이전트 자동 연결 보안 계약."""

from __future__ import annotations

import os
import tempfile
from unittest.mock import patch

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from app import db
from app import main as main_module
from app.main import app
from app.routers import ingest
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
