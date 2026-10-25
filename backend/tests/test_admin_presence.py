"""관리자 '지금 접속 중'(서버 관리 창 설계 C) — 메모리에서만, 응답은 가린 이름뿐, 관리자·AUTH 켜진 서버만."""
from __future__ import annotations

import os
import sqlite3
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app import db, main, repo
from app.repo.identity import presence_names, presence_safe_name
from app.services.agent_signals import agent_signals


def test_safe_name_masks_emails_and_ids_inside_the_name_itself():
    assert presence_safe_name("ops@corp.example") == "ops"
    assert presence_safe_name("팀장 boss@corp") == "팀장 boss"
    assert presence_safe_name("user_ABCDEF123 가") == "(식별자) 가"
    assert presence_safe_name("acct:x@y.com") == "(식별자)"
    assert presence_safe_name("account:0123abcd 님") == "(식별자) 님"
    assert presence_safe_name("a\x1b[31mb\x07") == "a[31mb"
    assert len(presence_safe_name("가" * 100)) == 40
    assert presence_safe_name("") is None and presence_safe_name(None) is None


def test_presence_names_follow_creator_then_account_then_localpart_per_account():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE account(email TEXT, creator_uid TEXT, name TEXT)")
    conn.execute("CREATE TABLE creator(uid TEXT, name TEXT)")
    conn.executemany("INSERT INTO account VALUES(?,?,?)", [
        ("a@x.com", "user_a1", "계정이름"), ("b@x.com", None, "보라"), ("c@x.com", None, None),
        ("d@x.com", "user_d1", "같은이름"), ("e@x.com", "user_e1", "같은이름"), ("f@x.com", None, "f@x.com")])
    conn.execute("INSERT INTO creator VALUES('user_a1', '생성자이름')")
    names = presence_names(conn, ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com",
                                  "user_zz9@nowhere.com"])
    assert names["a@x.com"] == "생성자이름" and names["b@x.com"] == "보라" and names["c@x.com"] == "c"
    assert names["d@x.com"] == names["e@x.com"] == "같은이름"  # 계정마다 한 줄(합치는 것은 호출자도 안 함)
    assert names["f@x.com"] == "f" and names["user_zz9@nowhere.com"] == "(식별자)"
    assert not any("@" in value for value in names.values())


def _login(client, email, password):
    assert client.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200


def test_presence_endpoint_admin_only_names_only_and_counts(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        old = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
        db.flush_pool()
        saved_accounts = dict(main.manager._by_account)
        saved_seen = dict(agent_signals._last_seen)
        try:
            monkeypatch.setattr(db, "_POOL_ENABLED", False)
            monkeypatch.setattr(main, "AUTH_ENABLED", True)
            from app import deps
            monkeypatch.setattr(deps, "AUTH_ENABLED", True)  # 관리자 확인(require_admin)도 켠 서버처럼
            db.init_db()
            repo.ensure_default_worker()
            repo.ensure_admin_account("admin@example.com", "admin-password")
            repo.register("member@example.com", "password-123", "member")
            with db.get_connection() as conn:  # 이름 칸 자체에 이메일을 적은 계정(생성자 이름이 먼저 쓰인다)
                conn.execute("UPDATE account SET status='approved', name='ops@corp.example' "
                             "WHERE email='member@example.com'")
                conn.execute("UPDATE creator SET name='ops@corp.example' WHERE uid="
                             "(SELECT creator_uid FROM account WHERE email='member@example.com')")
            main.manager._by_account["acct:member@example.com"] = {object(), object()}
            main.manager._by_account[None] = {object()}
            agent_signals._last_seen["agent-only@example.com"] = time.monotonic()
            admin = TestClient(main.app, client=("127.0.0.1", 50000))
            _login(admin, "admin@example.com", "admin-password")
            response = admin.get("/api/admin/presence")
            assert response.status_code == 200
            body = response.json()
            assert body["other_connections"] == 1
            rows = {row["name"]: row for row in body["people"]}
            assert rows["ops"] == {"name": "ops", "app": 2, "agent": False}
            assert rows["agent-only"] == {"name": "agent-only", "app": 0, "agent": True}
            assert "@" not in response.text and "user_" not in response.text
            member = TestClient(main.app, client=("127.0.0.1", 50001))
            _login(member, "member@example.com", "password-123")
            assert member.get("/api/admin/presence").status_code == 403
            monkeypatch.setattr(main, "AUTH_ENABLED", False)
            assert admin.get("/api/admin/presence").status_code == 404
        finally:
            main.manager._by_account.clear()
            main.manager._by_account.update(saved_accounts)
            agent_signals._last_seen.clear()
            agent_signals._last_seen.update(saved_seen)
            if old is None:
                os.environ.pop("CONTENT_HUB_DB", None)
            else:
                os.environ["CONTENT_HUB_DB"] = old
            db.flush_pool()
