"""계정 정리의 인증 쪽 — 재가입 토큰, 쓰기 직전 재확인, 서버 PC 전용 경로."""
from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import db, deps, main, manage_db, repo
from app.repo import account_cleanup as cleanup
from app.routers import _proxy, account_cleanup as cleanup_router, gen_requests, ingest, manage
from app.services import auth

ADMIN, GHOST = "boss@x.test", "ghost@x.test"
PASSWORD = "secret123"


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage_hub.db")
    db.flush_pool()
    for module in (main, deps, cleanup_router):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    repo.register(ADMIN, PASSWORD, "관리자")
    yield
    db.flush_pool()


def client(ip="127.0.0.1"):
    return TestClient(main.app, base_url="http://127.0.0.1:8010", client=(ip, 50000))


def token_for(email):
    return auth.make_token(email, pwd_stamp=repo.get_account(email)["password_changed_at"])


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def signup_approved(email=GHOST):
    repo.register(email, PASSWORD, "유령")
    repo.set_account_status(email, "approved")


def wipe(email=GHOST):
    repo.set_account_status(email, "rejected")
    account = repo.get_account(email)
    cleanup.delete_cleanup_account(email, status="rejected", hidden=False, created_at=account["created_at"],
                                   actor_email=ADMIN, actor_uid="acct:" + ADMIN)


def status_of(token, path="/api/auth/me"):
    return client().get(path, headers=bearer(token)).status_code


def test_old_tokens_do_not_come_back_after_delete_and_signup_again_http(server):
    signup_approved()
    stamped, unstamped = token_for(GHOST), auth.make_token(GHOST)
    assert status_of(stamped) == 200
    wipe()
    assert status_of(stamped) == 401  # 지운 계정의 토큰
    signup_approved()
    assert status_of(stamped) == 401
    assert status_of(unstamped) == 401
    assert status_of(token_for(GHOST)) == 200  # 새 로그인은 된다


def test_old_tokens_do_not_come_back_on_websocket(server):
    signup_approved()
    old = token_for(GHOST)
    wipe()
    signup_approved()
    with pytest.raises(WebSocketDisconnect):
        with client().websocket_connect("/ws", headers=bearer(old)) as socket:
            socket.receive_text()


def test_password_reset_right_after_signup_invalidates_the_token(server):
    signup_approved()
    token = token_for(GHOST)
    repo.set_password(GHOST, "111111")  # 같은 초여도 글자 모양이 달라 표식이 바뀐다
    assert status_of(token) == 401
    assert status_of(token_for(GHOST)) == 200


def test_bootstrap_admin_gets_a_stamp_so_a_recreated_one_rejects_old_tokens(server):
    assert repo.ensure_admin_account("root@x.test", PASSWORD) is True
    assert repo.get_account("root@x.test")["password_changed_at"]


def test_existing_accounts_without_a_stamp_keep_their_sessions(server):
    signup_approved()
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET password_changed_at=NULL WHERE email=?", (GHOST,))
    assert status_of(auth.make_token(GHOST)) == 200


@pytest.mark.parametrize("change", ["block", "delete"])
def test_agent_writes_recheck_the_account_after_the_body_arrived(server, change):
    signup_approved()
    stale = repo.get_account(GHOST)  # 미들웨어가 본문을 받기 전에 읽어 둔 값
    request = SimpleNamespace(state=SimpleNamespace(account=stale))
    assert manage._push_acc(request)["email"] == GHOST
    assert ingest._agent_write_acc(request)["email"] == GHOST
    (repo.set_account_status(GHOST, "rejected") if change == "block" else wipe())
    for write in (manage._push_acc, ingest._agent_write_acc):
        with pytest.raises(HTTPException) as caught:
            write(request)
        assert caught.value.status_code == 401


def test_delayed_request_cannot_pass_as_the_reregistered_account(server):
    signup_approved()
    stale = repo.get_account(GHOST)
    request = SimpleNamespace(state=SimpleNamespace(account=stale))
    wipe()
    signup_approved()  # 같은 이메일이 승인 상태로 돌아왔다 — 새 계정이지 옛 요청의 계정이 아니다
    for write in (manage._push_acc, ingest._agent_write_acc):
        with pytest.raises(HTTPException) as caught:
            write(request)
        assert caught.value.status_code == 401
    fresh = SimpleNamespace(state=SimpleNamespace(account=repo.get_account(GHOST)))
    assert manage._push_acc(fresh)["email"] == GHOST


def test_recheck_does_nothing_on_a_local_hub(monkeypatch):
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    deps.assert_account_current({"email": "nobody@x.test"})  # DB 를 읽지 않는다


def test_gen_request_recheck_stays_off_the_event_loop(monkeypatch):
    seen = {}

    def check(account):
        seen["thread"] = threading.current_thread()
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")

    monkeypatch.setattr(gen_requests, "assert_account_current", check)
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: False)
    monkeypatch.setattr(gen_requests, "_require_account", lambda request: {"email": GHOST})
    with pytest.raises(HTTPException):
        asyncio.run(gen_requests.create_gen_request(None, SimpleNamespace()))
    assert seen["thread"] is not threading.main_thread()


def test_hub_never_relays_the_cleanup_paths():
    assert _proxy.is_local_path("/api/admin/account-cleanup")
    assert _proxy.is_local_path("/api/admin/account-cleanup/delete")


def login(ip="127.0.0.1"):
    web = client(ip)
    assert web.post("/api/auth/login", json={"email": ADMIN, "password": PASSWORD}).status_code == 200
    return web


def test_api_lists_and_deletes_for_the_admin_on_the_server_pc(server, monkeypatch):
    monkeypatch.setattr(cleanup_router, "DELETE_ENABLED", True)  # 켰을 때의 흐름 — 다음 릴리스에서 켤 때 다시 검증할 양을 줄인다
    repo.register(GHOST, PASSWORD, "유령")
    repo.set_account_status(GHOST, "rejected")
    web = login()
    page = web.get("/api/admin/account-cleanup").json()
    row = page["accounts"][0]
    assert page["delete_enabled"] is True
    assert (row["email"], row["verdict"]) == (GHOST, "deletable")
    body = {"email": GHOST, "status": row["status"], "hidden": row["hidden"], "created_at": row["created_at"]}
    assert web.post("/api/admin/account-cleanup/delete", json=body).status_code == 200
    assert repo.get_account(GHOST) is None
    assert web.post("/api/admin/account-cleanup/delete", json=body).status_code == 409


def test_delete_is_off_in_this_release(server):
    repo.register(GHOST, PASSWORD, "유령")
    repo.set_account_status(GHOST, "rejected")
    web = login()
    page = web.get("/api/admin/account-cleanup").json()
    row = page["accounts"][0]
    assert page["delete_enabled"] is False and row["verdict"] == "deletable"  # 판정은 그대로 — 창이 글자만 바꾼다
    body = {"email": GHOST, "status": row["status"], "hidden": row["hidden"], "created_at": row["created_at"]}
    answer = web.post("/api/admin/account-cleanup/delete", json=body)
    assert answer.status_code == 409 and "이번 릴리스" in answer.json()["detail"]
    assert repo.get_account(GHOST) is not None


def test_api_answers_409_with_the_reason(server, monkeypatch):
    monkeypatch.setattr(cleanup_router, "DELETE_ENABLED", True)
    signup_approved()
    repo.set_account_hidden(GHOST, True)
    web = login()
    row = web.get("/api/admin/account-cleanup").json()["accounts"][0]
    assert row["verdict"] == "block_first"
    body = {"email": GHOST, "status": row["status"], "hidden": row["hidden"], "created_at": row["created_at"]}
    answer = web.post("/api/admin/account-cleanup/delete", json=body)
    assert answer.status_code == 409 and "지울 수 없는 계정" in answer.json()["detail"]


def test_api_is_closed_to_other_pcs_browsers_and_non_admins(server):
    signup_approved()
    other_pc = login("192.168.1.50")
    assert other_pc.get("/api/admin/account-cleanup").status_code == 403
    assert login().get("/api/admin/account-cleanup", headers={"Origin": "http://evil.test"}).status_code == 403
    member = client()
    assert member.post("/api/auth/login", json={"email": GHOST, "password": PASSWORD}).status_code == 200
    assert member.get("/api/admin/account-cleanup").status_code == 403
    assert client().get("/api/admin/account-cleanup").status_code == 401


def test_api_does_not_exist_on_a_local_hub(server, monkeypatch):
    monkeypatch.setattr(cleanup_router, "AUTH_ENABLED", False)
    web = login()
    assert web.get("/api/admin/account-cleanup").status_code == 404
