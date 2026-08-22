"""R10 P2-5 — 공유 서버 세션 저장 완료 뒤 계정 포인터 최종 공개 계약."""

from __future__ import annotations

import json
import threading

import pytest
from fastapi import Request

from app import active_account, config, db, repo
from app.repo import identity
from app.routers import publish


A_EMAIL = "pointer-a@example.com"
B_EMAIL = "pointer-b@example.com"
A_TOKEN = "token-a"
B_TOKEN = "token-b"
B_UID = "user_pointer_b"
B_NAME = "Pointer B"
B_ROLES = ["admin", "artist"]
B_URL = "http://share.example.test"


def _local_request() -> Request:
    return Request(
        {"type": "http", "client": ("127.0.0.1", 40000), "headers": []}
    )


@pytest.fixture
def isolated_account_session(tmp_path, monkeypatch):
    """실제 계정 포인터·DB와 분리하고 A 로그인 상태에서 시작한다."""
    data_dir = tmp_path / "data"
    old_uid_cache = identity._MY_UID_CACHE[0]
    old_uid_path = identity._MY_UID_PATH[0]
    override_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", data_dir / "db" / "content_hub.db")
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", tmp_path / "missing-legacy.db")
    monkeypatch.setattr(active_account, "_POINTER", data_dir / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(publish, "AUTH_ENABLED", False)
    db.flush_pool()

    db.ensure_account_db(A_EMAIL, "user_pointer_a")
    active_account.set_active(A_EMAIL, "user_pointer_a")
    repo.set_setting(publish._K_URL, B_URL)
    repo.set_setting(publish._K_EMAIL, A_EMAIL)
    repo.set_setting(publish._K_TOKEN, A_TOKEN)
    repo.set_setting(publish._K_NAME, "Pointer A")
    repo.set_setting(publish._K_ROLES, "[]")

    try:
        yield
    finally:
        db.flush_pool()
        identity._MY_UID_CACHE[0] = old_uid_cache
        identity._MY_UID_PATH[0] = old_uid_path
        active_account.reset_override(override_token)


def _invoke_successful_flow(flow: str):
    if flow == "login":
        return publish.shared_server_login(
            publish.SharedLoginIn(
                url=B_URL,
                email=B_EMAIL,
                password="password",
            ),
            _local_request(),
        )
    return publish.shared_server_register(
        publish.SharedRegisterIn(
            email=B_EMAIL,
            password="password",
            name=B_NAME,
        ),
        _local_request(),
    )


@pytest.mark.parametrize("flow", ["login", "register"])
def test_session_settings_finish_before_pointer_is_published(
    flow, isolated_account_session, monkeypatch
):
    """token 저장 직전의 일반 reader는 A를 보고, 완료 뒤에만 B를 본다."""
    monkeypatch.setattr(
        publish,
        "_http_json",
        lambda *_args, **_kwargs: (
            200,
            {
                "token": B_TOKEN,
                "account": {
                    "creator_uid": B_UID,
                    "name": B_NAME,
                    "global_roles": B_ROLES,
                    "status": "active",
                },
            },
        ),
    )
    monkeypatch.setattr(publish, "kick_share_state_reconciler", lambda: None)

    token_reached = threading.Event()
    release_token = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []
    published: list[tuple[str, str | None]] = []
    signal_scopes: list[str | None] = []
    real_set_setting = publish.repo.set_setting
    real_set_active = active_account.set_active

    def blocking_set_setting(key, value):
        if key == publish._K_TOKEN:
            assert active_account.account_key() == B_EMAIL
            token_reached.set()
            if not release_token.wait(2.0):
                raise TimeoutError("token 저장 해제 신호를 기다리다 시간 초과")
        return real_set_setting(key, value)

    def record_set_active(email, uid=None):
        published.append((email, active_account.account_key()))
        return real_set_active(email, uid)

    monkeypatch.setattr(publish.repo, "set_setting", blocking_set_setting)
    monkeypatch.setattr(active_account, "set_active", record_set_active)
    monkeypatch.setattr(
        publish.agent_signals.agent_signals,
        "signal",
        lambda *_args: signal_scopes.append(active_account.account_key()),
    )
    cache_sentinel = object()
    identity._MY_UID_CACHE[0] = cache_sentinel

    def run_flow() -> None:
        try:
            _invoke_successful_flow(flow)
        except BaseException as exc:  # 스레드 예외를 본 테스트로 전달
            errors.append(exc)
        finally:
            finished.set()

    worker = threading.Thread(target=run_flow)
    worker.start()
    try:
        assert token_reached.wait(2.0)
        assert active_account.account_key() == A_EMAIL
        assert db.get_db_path() == active_account.account_db_path(A_EMAIL)
        assert repo.get_setting(publish._K_TOKEN) == A_TOKEN
        assert published == []
        assert identity._MY_UID_CACHE[0] is cache_sentinel
        assert not finished.is_set()
    finally:
        release_token.set()
        worker.join(timeout=3.0)

    assert not worker.is_alive()
    assert errors == []
    assert published == [(B_EMAIL, A_EMAIL)]
    assert active_account.account_key() == B_EMAIL
    assert repo.get_setting(publish._K_URL) == B_URL
    assert repo.get_setting(publish._K_EMAIL) == B_EMAIL
    assert repo.get_setting(publish._K_TOKEN) == B_TOKEN
    assert repo.get_setting(publish._K_NAME) == B_NAME
    assert json.loads(repo.get_setting(publish._K_ROLES) or "[]") == B_ROLES
    assert identity._MY_UID_CACHE[0] is None
    assert signal_scopes == [B_EMAIL]


@pytest.mark.parametrize("flow", ["login", "register"])
def test_required_setting_failure_keeps_old_pointer_and_surfaces_exception(
    flow, isolated_account_session, monkeypatch
):
    """B 설정 저장 실패는 전환 실패이며, A 포인터와 A 세션을 그대로 보존한다."""
    monkeypatch.setattr(
        publish,
        "_http_json",
        lambda *_args, **_kwargs: (
            200,
            {
                "token": B_TOKEN,
                "account": {
                    "creator_uid": B_UID,
                    "name": B_NAME,
                    "global_roles": B_ROLES,
                    "status": "active",
                },
            },
        ),
    )
    kicks: list[bool] = []
    signals: list[bool] = []
    published: list[str] = []
    real_set_setting = publish.repo.set_setting
    real_set_active = active_account.set_active

    def failing_set_setting(key, value):
        if key == publish._K_TOKEN:
            assert active_account.account_key() == B_EMAIL
            raise RuntimeError("injected token setting failure")
        return real_set_setting(key, value)

    def record_set_active(email, uid=None):
        published.append(email)
        return real_set_active(email, uid)

    monkeypatch.setattr(publish.repo, "set_setting", failing_set_setting)
    monkeypatch.setattr(active_account, "set_active", record_set_active)
    monkeypatch.setattr(
        publish.agent_signals.agent_signals,
        "signal",
        lambda *_args: signals.append(True),
    )
    monkeypatch.setattr(
        publish, "kick_share_state_reconciler", lambda: kicks.append(True)
    )
    cache_sentinel = object()
    identity._MY_UID_CACHE[0] = cache_sentinel

    with pytest.raises(RuntimeError, match="injected token setting failure"):
        _invoke_successful_flow(flow)

    assert active_account.account_key() == A_EMAIL
    assert repo.get_setting(publish._K_TOKEN) == A_TOKEN
    assert published == []
    assert signals == []
    assert kicks == []
    assert identity._MY_UID_CACHE[0] is cache_sentinel
    assert active_account.account_db_path(B_EMAIL).is_file()
