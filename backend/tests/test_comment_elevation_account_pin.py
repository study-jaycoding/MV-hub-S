"""댓글·로컬 재인증 요청의 A→B 전환 격리: 합성 DB/토큰, 네트워크 stub 전용."""

from contextlib import contextmanager, nullcontext
import threading
import time

from fastapi import HTTPException, Request
import pytest

from app import active_account, config, db, repo
from app.routers import generation, publish


A, B = "synthetic-a@example.invalid", "synthetic-b@example.invalid"
UID = {A: "synthetic-uid-a", B: "synthetic-uid-b"}
NORMAL = {A: "sentinel-normal-a", B: "sentinel-normal-b"}
ELEVATED = {A: "sentinel-elevated-a", B: "sentinel-elevated-b"}
ISSUED = "sentinel-new-elevation-a"
SERVER_ID, JOB = "synthetic-server-card", "synthetic-server-job"


@contextmanager
def account(email):
    key = active_account.set_override(email)
    uid = active_account.set_uid_override(UID[email])
    try:
        yield
    finally:
        active_account.reset_uid_override(uid)
        active_account.reset_override(key)


def local_request():
    return Request({
        "type": "http", "method": "POST", "scheme": "http", "path": "/api/synthetic-audit",
        "query_string": b"", "client": ("127.0.0.1", 50001), "server": ("127.0.0.1", 8012),
        "headers": [(b"host", b"127.0.0.1:8012")],
    })


def switch_from_other_thread(email):
    """네트워크 stub에서 호출: 요청 스레드가 전환 락을 보유하면 실패한다."""
    changed = []

    def switch():
        acquired = active_account.transition_lock.acquire(timeout=0.2)
        if not acquired:
            return
        try:
            active_account._cache[:] = [True, {"email": email, "uid": UID[email]}]
            changed.append(True)
        finally:
            active_account.transition_lock.release()

    worker = threading.Thread(target=switch)
    worker.start()
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert changed == [True], "A request held transition_lock during network work"


@pytest.fixture
def account_databases(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(generation, "AUTH_ENABLED", False)
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path))
    # 실제 계정 DB 경로 해석을 사용하되, 키와 목적지는 모두 이 fixture 안이다.
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    monkeypatch.setattr(active_account, "_cache", [True, {"email": A, "uid": UID[A]}])
    key = active_account._override.set(None)
    uid = active_account._uid_override.set(None)
    db.flush_pool()
    expiry = int(time.time()) + 600
    try:
        for email in (A, B):
            with account(email):
                assert db.get_db_path().resolve().is_relative_to(tmp_path)
                db.init_db()
                repo.ensure_default_worker()
                for setting, value in {
                    publish._K_URL: "http://synthetic-server.invalid:9",
                    publish._K_TOKEN: NORMAL[email], publish._K_EMAIL: email,
                    publish._K_NAME: "Synthetic admin", publish._K_ROLES: '["admin"]',
                    publish._K_ELEV_TOKEN: ELEVATED[email], publish._K_ELEV_EXPIRES: str(expiry),
                    publish._K_ELEV_EMAIL: email, publish._K_ELEV_NAME: "Synthetic admin",
                    "my_creator_uid": UID[email],
                }.items():
                    repo.set_setting(setting, value)
        monkeypatch.setattr(generation._proxy, "proxying", lambda: True)
        monkeypatch.setattr(generation._proxy, "is_shared_team_server", lambda: False)

        def unexpected_network(*args, **kwargs):
            raise AssertionError("An unstubbed network boundary was reached")

        monkeypatch.setattr(publish, "_http_json", unexpected_network)
        monkeypatch.setattr(generation._proxy, "proxy_get", unexpected_network)
        monkeypatch.setattr(generation._proxy, "proxy_json", unexpected_network)
        yield expiry
    finally:
        db.flush_pool()
        active_account._uid_override.reset(uid)
        active_account._override.reset(key)


def counts(email):
    with account(email), db.get_connection() as conn:
        return {
            "comments": conn.execute("SELECT COUNT(*) FROM generation_comment").fetchone()[0],
            "generations": conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0],
            "colors": conn.execute("SELECT COUNT(*) FROM gen_color_overlay").fetchone()[0],
        }


@pytest.mark.parametrize("iteration", range(5))
@pytest.mark.parametrize("scenario", ["race", "normal", "existing_color_scope_control"])
def test_private_comment_and_existing_color_control_stay_in_a(account_databases, monkeypatch, scenario, iteration):
    def remote(path, request):
        assert path == f"/api/generations/{SERVER_ID}"
        assert active_account.account_key() == A
        # 작성자는 active_uid가 아닌 actor_id(request)로 정한다(이 단독 모드 요청은 'me').
        # uid override 없음 자체는 계약으로 고정하지 않고, 저장된 작성자와 스코프 해제를 검증한다.
        if scenario != "normal":
            switch_from_other_thread(B)
        return {"id": SERVER_ID, "job_id": JOB, "creator_uid": "synthetic-other"}

    monkeypatch.setattr(generation._proxy, "proxy_get", remote)
    if scenario == "existing_color_scope_control":
        generation.set_color(SERVER_ID, generation.ColorIn(color="#c9384a"), local_request())
        assert counts(A)["colors"] == 1
        assert counts(B)["colors"] == 0
    else:
        result = generation.add_gen_comment(
            SERVER_ID,
            generation.GenCommentAddIn(text="Private A note", private=True, parent_id="synthetic-public-parent"),
            local_request(),
        )
        assert result["id"]
        assert counts(A)["comments"] == 1
        assert counts(B)["comments"] == 0
        with account(A), db.get_connection() as conn:
            author = conn.execute("SELECT author FROM generation_comment WHERE id=?", (result["id"],)).fetchone()[0]
        assert author == "me"
    assert counts(A)["generations"] == counts(B)["generations"] == 0
    assert active_account.account_key() == (A if scenario == "normal" else B)
    assert active_account._override.get() is None
    assert active_account._uid_override.get() is None


@pytest.mark.parametrize("iteration", range(5))
@pytest.mark.parametrize("variant", ["race", "normal", "outer_scope_control"])
@pytest.mark.parametrize("action", ["elevate", "revoke"])
def test_elevation_changes_only_a_and_response_describes_a(account_databases, monkeypatch, action, variant, iteration):
    def remote(method, url, token=None, **kwargs):
        assert method == "POST" and token == NORMAL[A]
        assert active_account.account_key() == A
        if action == "revoke":
            assert kwargs["super_token"] == ELEVATED[A]
        if variant != "normal":
            switch_from_other_thread(B)
        return 200, {"ok": True, "token": ISSUED, "expires_at": account_databases}

    monkeypatch.setattr(publish, "_http_json", remote)
    with publish._pinned_account_scope() if variant == "outer_scope_control" else nullcontext():
        result = (
            publish.shared_server_elevate(publish.ElevateIn(password="sentinel-password"), local_request())
            if action == "elevate" else publish.shared_server_de_elevate(local_request())
        )
    assert result["email"] == A
    assert result["super_admin_active"] is (action == "elevate")
    for email in (A, B):
        with account(email):
            expected = ELEVATED[B] if email == B else ISSUED if action == "elevate" else None
            assert repo.get_setting(publish._K_ELEV_TOKEN) == expected
            assert repo.get_setting(publish._K_TOKEN) == NORMAL[email]
            assert repo.get_setting(publish._K_EMAIL) == email
    assert active_account.account_key() == (A if variant == "normal" else B)
    assert active_account.active_uid() == UID[A if variant == "normal" else B]
    assert active_account._override.get() is None
    assert active_account._uid_override.get() is None


def test_comment_list_reads_a_after_remote_response_switches_to_b(account_databases, monkeypatch):
    for email in (A, B):
        with account(email):
            repo.add_generation_comment(JOB, "me", "A note" if email == A else "B note", is_private=True)

    def remote(path, request):
        if path.endswith("/comments"):
            switch_from_other_thread(B)
            return [{"id": "shared", "text": "Shared note", "created_at": "2000-01-01"}]
        assert active_account.account_key() == A
        return {"id": SERVER_ID, "job_id": JOB}

    monkeypatch.setattr(generation._proxy, "proxy_get", remote)
    result = generation.list_gen_comments(SERVER_ID, local_request())
    assert [row["text"] for row in result] == ["Shared note", "A note"]
    assert active_account.account_key() == B


def test_public_comment_early_return_is_also_inside_scope(account_databases, monkeypatch):
    original = repo.get_generation

    def initial_read(gen_id):
        result = original(gen_id)
        switch_from_other_thread(B)
        return result

    def remote(*args, **kwargs):
        assert active_account.account_key() == A
        return {"id": "synthetic-shared-comment"}

    monkeypatch.setattr(repo, "get_generation", initial_read)
    monkeypatch.setattr(generation._proxy, "proxy_json", remote)
    result = generation.add_gen_comment(SERVER_ID, generation.GenCommentAddIn(text="Public note"), local_request())
    assert result == {"id": "synthetic-shared-comment"}
    assert counts(A)["comments"] == counts(B)["comments"] == 0
    assert active_account.account_key() == B


@pytest.mark.parametrize("operation", ["list", "add", "elevate", "revoke"])
@pytest.mark.parametrize("outer_scope", [False, True])
def test_remote_errors_restore_scope_and_revoke_clears_only_a(account_databases, monkeypatch, operation, outer_scope):
    def fail(*args, **kwargs):
        switch_from_other_thread(B)
        raise HTTPException(status_code=502, detail="Synthetic upstream failure")

    monkeypatch.setattr(generation._proxy, "proxy_get", fail)
    monkeypatch.setattr(publish, "_http_json", fail)
    with account(A) if outer_scope else nullcontext():
        if operation == "revoke":
            result = publish.shared_server_de_elevate(local_request())
            assert result["email"] == A
        else:
            with pytest.raises(HTTPException) as caught:
                if operation == "list":
                    generation.list_gen_comments(SERVER_ID, local_request())
                elif operation == "add":
                    generation.add_gen_comment(SERVER_ID, generation.GenCommentAddIn(text="Note", private=True), local_request())
                else:
                    publish.shared_server_elevate(publish.ElevateIn(password="sentinel-password"), local_request())
            assert caught.value.status_code == 502
        assert active_account.account_key() == (A if outer_scope else B)
        if outer_scope:
            assert active_account.active_uid() == UID[A]
    assert active_account.account_key() == B
    assert active_account.active_uid() == UID[B]
    assert active_account._override.get() is None
    assert active_account._uid_override.get() is None
    for email in (A, B):
        with account(email):
            expected = None if operation == "revoke" and email == A else ELEVATED[email]
            assert repo.get_setting(publish._K_ELEV_TOKEN) == expected


@pytest.mark.parametrize("operation", ["list", "add", "elevate", "revoke"])
def test_first_read_and_guard_exit_are_inside_scope(account_databases, monkeypatch, operation):
    def guarded_read(*args, **kwargs):
        assert active_account._override.get() == A
        return None

    if operation in {"list", "add"}:
        monkeypatch.setattr(repo, "get_generation", guarded_read)
        monkeypatch.setattr(generation._proxy, "proxying", lambda: False)
    elif operation == "elevate":
        monkeypatch.setattr(publish, "_is_admin", guarded_read)
    else:
        monkeypatch.setattr(repo, "get_setting", guarded_read)
        monkeypatch.setattr(publish, "_shared_status", lambda: {"scope": active_account.account_key()})
    if operation == "revoke":
        assert publish.shared_server_de_elevate(local_request())["scope"] == A
    else:
        with pytest.raises(HTTPException) as caught:
            if operation == "list":
                generation.list_gen_comments(SERVER_ID, local_request())
            elif operation == "add":
                generation.add_gen_comment(SERVER_ID, generation.GenCommentAddIn(text="Note"), local_request())
            else:
                publish.shared_server_elevate(publish.ElevateIn(password="sentinel-password"), local_request())
        assert caught.value.status_code == (403 if operation == "elevate" else 404)
    assert active_account._override.get() is None
    assert active_account._uid_override.get() is None
