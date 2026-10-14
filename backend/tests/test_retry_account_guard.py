"""답을 잃고 다시 보낼 때의 계정 확인(Jay 결정 2A, 10-15) — 그사이 다른 탭이 다른 계정으로 로그인했으면 실행 전에 거절한다.
화면은 허브가 기능 표식(request_retry_v1)을 알릴 때만 다시 보낸다."""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request

from app import deps
from app.routers import auth, gen_requests


def request_with(header: str | None) -> Request:
    headers = [(b"x-mvhub-expect-account", header.encode())] if header is not None else []
    return Request({"type": "http", "headers": headers, "client": ("127.0.0.1", 1)})


@pytest.mark.parametrize("header,owner,differs", [
    (None, "a@example.test", False),                 # 옛 화면 — 보지 않는다
    ("acct:a@example.test", "a@example.test", False),
    ("acct:A@Example.TEST", "a@example.test", False),  # 대소문자 무관
    ("acct:b@example.test", "a@example.test", True),
    ("local", "local", False),
    ("local", "a@example.test", True),
    ("acct:a@example.test", "local", True),
])
def test_expected_account_differs(header, owner, differs):
    assert deps.expected_account_differs(request_with(header), owner) is differs


def test_gen_request_refuses_before_any_work_when_account_changed(monkeypatch):
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "_require_account", lambda request: {"email": "a@example.test"})

    async def deployment_must_not_run():
        raise AssertionError("계정이 바뀐 요청은 그 뒤 단계로 가면 안 된다")

    monkeypatch.setattr(gen_requests, "_require_generation_deployment_open", deployment_must_not_run)
    body = SimpleNamespace()
    with pytest.raises(HTTPException) as error:
        asyncio.run(gen_requests.create_gen_request(body, request_with("acct:b@example.test")))
    assert error.value.status_code == 409 and "계정" in error.value.detail


def test_auth_config_advertises_retry_feature(monkeypatch):
    monkeypatch.setattr(auth.repo, "count_accounts", lambda: 1)
    assert "request_retry_v1" in auth.auth_config()["features"]
