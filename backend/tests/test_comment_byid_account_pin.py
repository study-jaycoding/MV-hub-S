"""Comment account-boundary contracts: real routes/repositories, synthetic SQLite.

Design: claude-comment-followup-a12-plan-response.json part 1 (D1-D10), followed
by claude-comment-design-clarification-response.json and root's early-400 choice.
Expected collection: 18 cases, each schedule once. Before the proposed route
scopes: 7 FAIL / 11 PASS using the SAME desired A-owned assertions as after.
Expected failures: read[missing/present], seen missing, edit overlap, delete
overlap with an own private reply, remote[before-send/after-send-401].
Remote after-send-200 is a counterexample to an overbroad claim, NOT a bug case.

NO_PROXY=1 stays enabled. proxying() is an explicit branch-selection substitute;
the token/URL getters and proxy_json/auth probe are original. Only raw_request is
an outbound stand-in (200/401). No HTTP, remote authorization, or remote DB writes
are tested. Local AUTH-off view checking is permissive: its original-call wrapper
is a scheduling seam, NOT evidence that a permission guard rejects unauthorized
readers. actor_id remains the request actor ('me' here), never the B DB identity.

Prospective product scope: existing _personal_meta_account_scope, not a new
helper/decorator. edit text normalization/empty-400 remains OUTSIDE that scope;
the other three handlers use whole-body scope. Request actor needs no uid pin.
No test in this file applies or simulates that prospective product patch.
"""

from contextvars import Context
import json
import threading
from types import SimpleNamespace
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
import pytest

from app import active_account, config, db, db_paths, deps
from app.routers import _proxy, generation, publish
from app.services import shared_connection


A, B = "comment-a@example.invalid", "comment-b@example.invalid"
UIDS = {A: "synthetic-comment-a", B: "synthetic-comment-b"}
TOKENS = {A: "synthetic-comment-token-a", B: "synthetic-comment-token-b"}
URLS = {A: "https://comment-a.invalid", B: "https://comment-b.invalid"}
ACTOR, GID, CID = "me", "synthetic-generation", "synthetic-comment"


def _request(*, authenticated=False):
    request = Request({
        "type": "http", "method": "POST", "scheme": "http",
        "path": "/api/synthetic-comment-audit", "query_string": b"",
        "headers": [], "client": ("127.0.0.1", 52001),
        "server": ("127.0.0.1", 0),
    })
    request.state.account = (
        {"email": A, "creator_uid": ACTOR, "global_role": "member"}
        if authenticated else None
    )
    return request


def _label(value, mapping):
    return next(("A" if key == A else "B" for key, known in mapping.items()
                 if value == known), "unexpected")


@pytest.fixture
def hub(tmp_path, monkeypatch, request):
    """Real selector and disk pointer; every path is synthetic and inside tmp_path."""
    db.flush_pool()
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    for module in (config, deps, generation, publish, _proxy):
        monkeypatch.setattr(module, "AUTH_ENABLED", False)
    single_path = tmp_path / "single.db"
    monkeypatch.setattr(db_paths, "DEFAULT_DB_PATH", single_path)
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", single_path)
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", tmp_path / "absent-legacy.db")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(_proxy, "_AUTH_PROBE_CACHE", {})
    monkeypatch.setattr(_proxy, "_AUTH_PROBE_IN_FLIGHT", set())
    mode = {"proxy": True}
    monkeypatch.setattr(_proxy, "proxying", lambda: mode["proxy"])

    def forbidden_network(*args, **kwargs):
        raise AssertionError("Unplanned outbound boundary in synthetic comment test")

    monkeypatch.setattr(_proxy, "raw_request", forbidden_network)
    monkeypatch.setattr(publish, "_http_json", forbidden_network)
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    paths = {email: active_account.account_db_path(email) for email in (A, B)}
    observations = []
    workers = []
    initialized = False

    def initialize(path, email):
        assert path.resolve().is_relative_to(tmp_path.resolve())
        path.parent.mkdir(parents=True, exist_ok=True)
        db.init_db(path)
        with db.get_connection(path) as conn:
            conn.execute("INSERT OR IGNORE INTO worker(id,name) VALUES(?,?)",
                         (ACTOR, "Synthetic comment actor"))
            for key, value in ((shared_connection.K_URL, URLS[email]),
                               (shared_connection.K_TOKEN, TOKENS[email])):
                conn.execute("INSERT INTO app_setting(key,value) VALUES(?,?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def seed(email, *, cid=CID, author=ACTOR, private=True, parent=None, shared=False):
        with db.get_connection(paths[email]) as conn:
            conn.execute("INSERT OR IGNORE INTO generation"
                         "(id,worker_id,creator_uid,prompt,status,workspace_scope) "
                         "VALUES(?,?,?,'Synthetic comment fixture','done','personal')",
                         (GID, ACTOR, ACTOR))
            conn.execute("INSERT INTO generation_comment"
                         "(id,gen_id,author,text,is_private,parent_id) VALUES(?,?,?,?,?,?)",
                         (cid, GID, author, f"original-{cid}", int(private), parent))
            if shared:
                conn.execute("INSERT OR IGNORE INTO share(id,generation_id,shared_by,visibility) "
                             "VALUES('synthetic-share',?,?,'team')", (GID, ACTOR))

    def snapshot(email):
        with db.get_connection(paths[email]) as conn:
            return {
                "generations": [row[0] for row in conn.execute("SELECT id FROM generation ORDER BY id")],
                "comments": [dict(row) for row in conn.execute(
                    "SELECT id,gen_id,author,text,parent_id,is_private FROM generation_comment ORDER BY id")],
                "read": [list(row) for row in conn.execute(
                    "SELECT worker_id,gen_id FROM generation_comment_read ORDER BY worker_id,gen_id")],
                "seen": [list(row) for row in conn.execute(
                    "SELECT worker_id,comment_id FROM generation_comment_seen ORDER BY worker_id,comment_id")],
                "token": _label(conn.execute("SELECT value FROM app_setting WHERE key=?",
                                             (shared_connection.K_TOKEN,)).fetchone()[0], TOKENS),
            }

    def snapshot_all():
        return {email: snapshot(email) for email in paths}

    def switch(*, shared_server=False):
        errors = []

        def run():
            acquired = False
            try:
                assert active_account._override.get() is None
                assert active_account._uid_override.get() is None
                acquired = active_account.transition_lock.acquire(timeout=0.2)
                observations.append({"stage": "transition-lock", "acquired": acquired})
                assert acquired, "Comment route retained transition_lock across work"
                if shared_server:
                    # The actual AUTH-on helper returns without publishing a pointer.
                    publish._switch_account_db(B, UIDS[B])
                else:
                    active_account.set_active(B, UIDS[B])
            except BaseException as exc:
                errors.append(exc)
            finally:
                if acquired:
                    active_account.transition_lock.release()

        worker = threading.Thread(target=lambda: Context().run(run), name="comment-pin-transition")
        workers.append(worker)
        worker.start()
        worker.join(timeout=2)
        assert not worker.is_alive(), "Synthetic transition thread did not finish"
        if errors:
            raise errors[0]

    def assert_outer(pointer=A, *, effective_key=None):
        assert active_account._override.get() is None
        assert active_account._uid_override.get() is None
        assert active_account.account_key() == (pointer if effective_key is None else effective_key or None)
        actual_pointer = json.loads(active_account._POINTER.read_text(encoding="utf-8"))
        assert actual_pointer == {"email": pointer, "uid": UIDS[pointer]}

    try:
        assert db.get_db_path is db_paths.get_db_path
        assert _proxy.token is shared_connection.token
        assert _proxy.base_url is shared_connection.base_url
        for email, path in paths.items():
            initialize(path, email)
        active_account.set_active(A, UIDS[A])
        assert db.get_db_path() == paths[A]
        initialized = True
        yield SimpleNamespace(paths=paths, mode=mode, seed=seed, snapshot=snapshot,
                              snapshot_all=snapshot_all, initialize=initialize,
                              single_path=single_path, switch=switch, assert_outer=assert_outer,
                              observations=observations)
    finally:
        try:
            for worker in workers:
                worker.join(timeout=2)
            observations.append({
                "stage": "fixture-final", "initialized": initialized,
                "key_override_clear": active_account._override.get() is None,
                "uid_override_clear": active_account._uid_override.get() is None,
                "transition_threads_stopped": all(not worker.is_alive() for worker in workers),
                "rows": snapshot_all() if initialized else None,
            })
            # JUnit carries observations even when a desired-A assertion fails in BEFORE.
            request.node.user_properties.append(("comment_account_observations",
                                                 json.dumps(observations, ensure_ascii=False)))
        finally:
            db.flush_pool()
            active_account.reset_uid_override(uid_token)
            active_account.reset_override(key_token)


def _switch_after_original(hub, monkeypatch, name, *, shared_server=False):
    original = getattr(generation, name)

    def wrapped(*args, **kwargs):
        result = original(*args, **kwargs)
        hub.observations.append({"stage": "original-return", "function": name})
        hub.switch(shared_server=shared_server)
        return result

    monkeypatch.setattr(generation, name, wrapped)


def _call(operation, *, authenticated=False):
    request = _request(authenticated=authenticated)
    if operation == "read":
        return generation.read_gen_comments(GID, generation.GenCommentReadIn(), request)
    if operation == "seen":
        return generation.seen_gen_comment(CID, request)
    if operation == "edit":
        return generation.edit_gen_comment(CID, generation.GenCommentEditIn(text="edited"), request)
    assert operation == "delete"
    return generation.delete_gen_comment(CID, request)


def _assert_only_a_read(hub):
    states = hub.snapshot_all()
    assert states[A]["read"] == [[ACTOR, GID]], states
    assert states[A]["seen"] == [[ACTOR, CID]], states
    assert states[B]["read"] == states[B]["seen"] == [], states


@pytest.mark.parametrize("b_target", [False, True], ids=["b-missing", "b-present"])
def test_read_keeps_request_account_with_or_without_b_target(hub, monkeypatch, b_target):
    """BEFORE fail #1/#2: B read=1, B seen=0/1. Actor stays 'me', not B uid.

    AUTH-off view check is permissive; wrap its real return only as a switch seam.
    The absent target in #1 is B's generation AND comments; A's target exists.
    """
    hub.seed(A)
    if b_target:
        hub.seed(B, cid="synthetic-b-comment")
    _switch_after_original(hub, monkeypatch, "require_view_generation")
    assert _call("read") == {"ok": True}
    hub.assert_outer(B)
    _assert_only_a_read(hub)


def test_seen_keeps_request_account_when_b_has_no_target(hub, monkeypatch):
    """BEFORE fail #3: a seen row can be inserted into B without a B comment."""
    hub.seed(A)
    _switch_after_original(hub, monkeypatch, "_comment_local")
    assert _call("seen") == {"ok": True}
    hub.assert_outer(B)
    states = hub.snapshot_all()
    assert states[A]["seen"] == [[ACTOR, CID]], states
    assert states[B]["seen"] == states[B]["generations"] == states[B]["comments"] == [], states


def test_edit_keeps_request_account_for_overlapping_owned_comment(hub, monkeypatch):
    """BEFORE fail #4 requires a same-ID B row owned by the unchanged request actor."""
    hub.seed(A)
    hub.seed(B)
    before_b = hub.snapshot(B)
    _switch_after_original(hub, monkeypatch, "_comment_local")
    assert _call("edit") == {"ok": True}
    hub.assert_outer(B)
    states = hub.snapshot_all()
    assert states[A]["comments"][0]["text"] == "edited", states
    assert states[B] == before_b, states


def test_delete_keeps_b_parent_and_own_private_reply(hub, monkeypatch):
    """BEFORE fail #5: B's private reply must have SAME author, avoiding reply lock.

    A has no reply. Original A private-child guard runs; a B guard is not injected.
    """
    hub.seed(A)
    hub.seed(B)
    hub.seed(B, cid="synthetic-b-private-reply", parent=CID)
    before_b = hub.snapshot(B)
    _switch_after_original(hub, monkeypatch, "_comment_local")
    assert _call("delete") == {"ok": True}
    hub.assert_outer(B)
    states = hub.snapshot_all()
    assert states[A]["comments"] == [], states
    assert states[B] == before_b, states


@pytest.mark.parametrize("condition,status", [("other-author", 403), ("missing", 404)])
def test_edit_guard_is_preserved_without_account_transition(hub, condition, status):
    """Clarified #6/#7: A itself rejects; B-only rejection is not a pin invariant."""
    if condition == "other-author":
        hub.seed(A, author="synthetic-other-author")
    else:
        # A missing local comment: standalone branch, not server-only dispatch.
        hub.mode["proxy"] = False
    before = hub.snapshot_all()
    with pytest.raises(HTTPException) as caught:
        _call("edit")
    assert caught.value.status_code == status
    hub.assert_outer(A)
    assert hub.snapshot_all() == before


def test_private_reply_guard_rejects_before_dispatch_or_transition(hub, monkeypatch):
    hub.seed(A)
    hub.seed(A, cid="synthetic-a-private-reply", parent=CID)
    before = hub.snapshot_all()
    _switch_after_original(hub, monkeypatch, "_comment_local")
    with pytest.raises(HTTPException) as caught:
        _call("delete")
    assert caught.value.status_code == 409
    hub.assert_outer(A)
    assert hub.observations == []
    assert hub.snapshot_all() == before


def test_empty_edit_rejects_before_scope_or_database_access(hub, monkeypatch):
    """Root selected Claude's approved outside-scope early-400 variant (#9)."""
    before = hub.snapshot_all()
    calls = []

    def unexpected(*args, **kwargs):
        calls.append(True)
        raise AssertionError("Empty comment reached account scope or database access")

    with monkeypatch.context() as early:
        early.setattr(generation, "_personal_meta_account_scope", unexpected)
        early.setattr(db, "_get_connection_sqlite", unexpected)
        with pytest.raises(HTTPException) as caught:
            generation.edit_gen_comment(CID, generation.GenCommentEditIn(text=" \t "), _request())
    assert caught.value.status_code == 400
    assert calls == []
    hub.assert_outer(A)
    assert hub.snapshot_all() == before


@pytest.mark.parametrize("schedule", ["before-send", "after-send-200", "after-send-401"])
def test_remote_getters_and_late_probe_stay_with_request_account(hub, monkeypatch, schedule):
    """#10 fails before pin; #11 is always-PASS control; #12 is separate probe failure.

    'before-send' means before proxy_json's outbound credential getters, AFTER the
    original classification (which may itself have read settings). Probe returns
    200, so both original stored tokens must remain unchanged in all schedules.
    Pin can govern later getters within this handler, not a previously sent probe
    or the global probe cache policy. No remote authorization claim is made.
    """
    hub.seed(A, private=False, shared=True)
    before = hub.snapshot_all()
    outbound = []
    if schedule == "before-send":
        _switch_after_original(hub, monkeypatch, "_comment_local")

    def remote(method, url, *, token=None, body=None, super_token=None, **kwargs):
        parsed = urlsplit(url)
        host = f"{parsed.scheme}://{parsed.netloc}"
        row = {"method": method, "path": parsed.path,
               "url": _label(host, URLS), "token": _label(token, TOKENS)}
        outbound.append(row)
        hub.observations.append({"stage": "outbound", **row})
        assert super_token is None
        if parsed.path == "/api/auth/me":
            assert method == "GET" and len(outbound) == 2
            return 200, {"email": A}
        assert parsed.path == f"/api/generation-comments/{CID}" and method == "PUT"
        assert body == {"text": "edited", "worker_id": None}
        assert len(outbound) == 1
        if schedule != "before-send":
            hub.switch()
        return (401, {"detail": "Synthetic request denial"}) if schedule == "after-send-401" else (200, {"ok": True})

    monkeypatch.setattr(_proxy, "raw_request", remote)
    if schedule == "after-send-401":
        with pytest.raises(HTTPException) as caught:
            _call("edit")
        assert caught.value.status_code == 401
        assert caught.value.headers == {_proxy.AUTH_STATE_HEADER: _proxy.AUTH_STATE_PRESERVED}
    else:
        assert _call("edit") == {"ok": True}
    hub.assert_outer(B)
    assert hub.snapshot_all() == before
    assert len(outbound) == (2 if schedule == "after-send-401" else 1)
    assert all(row["url"] == row["token"] == "A" for row in outbound), outbound


@pytest.mark.parametrize("operation", ["read", "seen", "edit", "delete"])
def test_normal_local_operation_without_account_transition(hub, operation):
    hub.seed(A)
    before_b = hub.snapshot(B)
    assert _call(operation) == {"ok": True}
    hub.assert_outer(A)
    states = hub.snapshot_all()
    assert states[B] == before_b
    if operation == "read":
        _assert_only_a_read(hub)
    elif operation == "seen":
        assert states[A]["seen"] == [[ACTOR, CID]]
    elif operation == "edit":
        assert states[A]["comments"][0]["text"] == "edited"
    else:
        assert states[A]["comments"] == []


def test_auth_on_read_uses_single_database_and_does_not_publish_new_pointer(hub, monkeypatch):
    """AUTH-on control uses actual switch helper and owner-view check, no HTTP auth."""
    hub.initialize(hub.single_path, A)
    hub.paths["single"] = hub.single_path
    hub.seed("single")
    before_a, before_b = hub.snapshot(A), hub.snapshot(B)
    for module in (config, deps, generation, publish, _proxy):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    hub.mode["proxy"] = False
    assert active_account.account_key() is None
    assert db.get_db_path() == hub.single_path
    _switch_after_original(hub, monkeypatch, "require_view_generation", shared_server=True)
    assert _call("read", authenticated=True) == {"ok": True}
    hub.assert_outer(A, effective_key="")
    state = hub.snapshot("single")
    assert state["read"] == [[ACTOR, GID]] and state["seen"] == [[ACTOR, CID]]
    assert hub.snapshot(A) == before_a and hub.snapshot(B) == before_b


def test_explicit_database_path_keeps_read_on_same_file_despite_pointer_switch(hub, monkeypatch):
    hub.seed(A)
    monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths[A]))
    _switch_after_original(hub, monkeypatch, "require_view_generation")
    assert _call("read") == {"ok": True}
    hub.assert_outer(B)
    assert db.get_db_path() == hub.paths[A]
    _assert_only_a_read(hub)
