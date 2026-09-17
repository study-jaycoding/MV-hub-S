"""B9: actual route/getters/account SQLite; only outbound raw_request is synthetic.

NO_PROXY=1 remains enabled. proxying() is a disclosed branch-selection substitute,
not proof of operational routing. No HTTP, server authentication or remote DB write
occurs. A mock 200 does not prove that the real server would authorize a request.

Existing server-auth evidence (not rerun here): test_super_admin.py::
SuperAdminSessionTests.test_session_is_bound_to_current_account_and_permanent_admin_role,
and
test_generation_routes.py::GenerationReadRouteTests.
test_super_admin_can_move_foreign_generation_without_changing_creator.
No new signature/session tests are added. Each injected schedule runs once.

Assertions express the desired A-pinned contract in BOTH before and after runs.
Before FAIL + observations is candidate evidence, never an after PASS claim.
"""
from concurrent.futures import ThreadPoolExecutor
from contextvars import Context
import json
import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from fastapi import HTTPException, Request

from app import active_account, config, db, db_paths, deps
from app.repo import identity
from app.routers import generation, publish, _proxy
from app.services import shared_connection


A = "b9-a@example.invalid"
B = "b9-b@example.invalid"
UIDS = {A: "b9-a-uid", B: "b9-b-uid"}
NORMAL = {A: "synthetic-b9-normal-a", B: "synthetic-b9-normal-b"}
ELEVATION = {A: "synthetic-b9-elevation-a", B: "synthetic-b9-elevation-b"}
URLS = {A: "https://b9-a.invalid", B: "https://b9-b.invalid"}
WORKSPACE = {"id": "b9-workspace", "name": "B9 Synthetic"}


def _label(value, mapping):
    if value is None or value == "":
        return "none"
    return next(("A" if key == A else "B" for key, item in mapping.items() if value == item), "unexpected")


def _pair_labels():
    return [_label(active_account.account_key(), {A: A, B: B}), _label(active_account.active_uid(), UIDS)]


def _request():
    request = Request({"type": "http", "method": "PUT", "scheme": "http",
                       "path": "/api/generations/workspace/team-batch", "query_string": b"",
                       "headers": [], "client": ("127.0.0.1", 51001), "server": ("127.0.0.1", 0)})
    request.state.account = None
    return request


def _body():
    return generation.GenerationWorkspaceBatchIn(
        generation_ids=["g1"], operation="assign",
        workspace_id=WORKSPACE["id"], workspace_name=WORKSPACE["name"],
    )


@pytest.fixture
def hub(tmp_path, monkeypatch, request):
    """Real selector + A/B DBs; no proxy_json/getter/resolve/repository substitution."""
    assert os.environ.get("CONTENT_HUB_NO_PROXY") == "1"
    db.flush_pool()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    for module in (config, deps, generation, publish):
        monkeypatch.setattr(module, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_paths, "DEFAULT_DB_PATH", tmp_path / "unused-default.db")
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", tmp_path / "unused-default.db")
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", tmp_path / "absent-legacy.db")
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(identity, "_MY_UID_CACHE", [None])
    monkeypatch.setattr(_proxy, "_AUTH_PROBE_CACHE", {})
    monkeypatch.setattr(_proxy, "_AUTH_PROBE_IN_FLIGHT", set())
    # Only wake-up and optional telemetry drain are suppressed. Neither is a token getter.
    monkeypatch.setattr(publish.agent_signals.agent_signals, "signal", lambda *args: None)
    monkeypatch.setattr(generation, "drain_isolated_telemetry", lambda: None)
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    observations = []
    initialized = False
    paths = {email: active_account.account_db_path(email) for email in (A, B)}

    def settings(email):
        with db.get_connection(paths[email]) as conn:
            values = dict(conn.execute("SELECT key,value FROM app_setting"))
        return {
            "normal": _label(values.get(shared_connection.K_TOKEN), NORMAL),
            "elevation": _label(values.get(shared_connection.K_ELEV_TOKEN), ELEVATION),
            "url": _label(values.get(shared_connection.K_URL), URLS),
        }

    def snapshot(email):
        with db.get_connection(paths[email]) as conn:
            return {
                "generation": [dict(row) for row in conn.execute(
                    "SELECT id,creator_uid,workspace_scope,workspace_id,project_id,folder_path "
                    "FROM generation ORDER BY id")],
                "share": [dict(row) for row in conn.execute(
                    "SELECT generation_id,shared_by FROM share ORDER BY generation_id")],
            }

    def assert_outer(email):
        wanted = "A" if email == A else "B"
        assert _pair_labels() == [wanted, wanted]
        assert active_account._override.get() is None
        assert active_account._uid_override.get() is None
        assert db.get_db_path() == paths[email]  # original db_paths.get_db_path
        pointer = json.loads(active_account._POINTER.read_text(encoding="utf-8"))
        assert [_label(pointer.get("email"), {A: A, B: B}), _label(pointer.get("uid"), UIDS)] == [wanted, wanted]

    def in_fresh_thread(action=None):
        def run():
            assert active_account._override.get() is None
            assert active_account._uid_override.get() is None
            acquired = active_account.transition_lock.acquire(timeout=0.5)
            observations.append({"stage": "other-thread-lock", "free": acquired})
            assert acquired, "Network boundary holds transition_lock"
            active_account.transition_lock.release()
            if action:
                action()
            assert active_account._override.get() is None
            assert active_account._uid_override.get() is None
        # Explicit empty Context prevents accidental inheritance of the request pin.
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="b9-transition") as pool:
            pool.submit(Context().run, run).result(timeout=15)

    def switch(mode="pointer"):
        def action():
            if mode == "pointer":
                active_account.set_active(B, UIDS[B])
            elif mode == "login":
                def before_publish():
                    assert _label(active_account.account_key(), {A: A, B: B}) == "B"
                    assert _label(active_account._read_pointer().get("email"), {A: A, B: B}) == "A"
                    publish._save_shared_session(
                        url=URLS[B], email=B, token=NORMAL[B],
                        account={"creator_uid": UIDS[B], "name": "B9 B", "global_roles": ["member"]},
                        clear_elevation=True,
                    )
                    observations.append({"stage": "login-before-pointer-publish", **settings(B)})
                    assert settings(B)["elevation"] == "none"
                    assert _label(active_account._read_pointer().get("email"), {A: A, B: B}) == "A"
                # These are the actual login persistence helpers. No login HTTP occurs.
                # ensure_account_db is also original and sees an existing isolated B DB.
                publish._switch_account_db(B, UIDS[B], before_publish=before_publish)
            else:
                raise AssertionError("Unknown synthetic transition")
            observations.append({"stage": "after-transition", "pair": _pair_labels(), **settings(B)})
        in_fresh_thread(action)

    try:
        assert db.get_db_path is db_paths.get_db_path
        assert _proxy.token is shared_connection.token
        assert _proxy.base_url is shared_connection.base_url
        assert _proxy.elevation_token is shared_connection.elevation_token
        for email, path in paths.items():
            path.parent.mkdir(parents=True)
            db.init_db(path)
            with db.get_connection(path) as conn:
                conn.execute("INSERT OR IGNORE INTO worker(id,name,account_type) VALUES('me','Synthetic','personal')")
                conn.execute("INSERT INTO workspace_registry(id,name) VALUES(?,?)", (WORKSPACE["id"], WORKSPACE["name"]))
                conn.execute(
                    "INSERT INTO generation(id,worker_id,creator_uid,prompt,status,workspace_scope,job_id) "
                    "VALUES('g1','me',?,'B9 synthetic','done','personal','b9-job')", (UIDS[email],))
                conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES('s1','g1','me','team')")
                for key, value in ((shared_connection.K_URL, URLS[email]), (shared_connection.K_TOKEN, NORMAL[email]),
                                   (shared_connection.K_ELEV_TOKEN, ELEVATION[email]),
                                   (shared_connection.K_ELEV_EXPIRES, "2099-01-01T00:00:00Z"),
                                   ("my_creator_uid", UIDS[email])):
                    conn.execute("INSERT INTO app_setting(key,value) VALUES(?,?) "
                                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
        active_account.set_active(A, UIDS[A])
        before = {email: snapshot(email) for email in (A, B)}
        initialized = True
        yield SimpleNamespace(paths=paths, observations=observations, settings=settings, snapshot=snapshot,
                              before=before, switch=switch, check_lock=in_fresh_thread, assert_outer=assert_outer)
    finally:
        try:
            final = {"stage": "fixture-final", "initialized": initialized,
                     "key_override_clear": active_account._override.get() is None,
                     "uid_override_clear": active_account._uid_override.get() is None}
            if initialized:
                final.update(pair=_pair_labels(), a_settings=settings(A), b_settings=settings(B),
                             a_rows=snapshot(A), b_rows=snapshot(B))
            observations.append(final)
            report_dir = os.environ.get("B9_REPORT_DIR")
            if report_dir:
                destination = Path(report_dir)
                destination.mkdir(parents=True, exist_ok=True)
                (destination / (request.node.name + ".json")).write_text(
                    json.dumps(observations, ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            db.flush_pool()
            active_account.reset_uid_override(uid_token)
            active_account.reset_override(key_token)


def _remote(hub, monkeypatch, *, switch=None, error=None):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)

    def raw_request(method, url, *, token=None, body=None, timeout=60, super_token=None, **kwargs):
        parts = urlsplit(url)
        stage = "resolve" if parts.path == "/api/workspaces/resolve" else "put" if parts.path == "/api/generations/workspace/batch" else "auth-probe" if parts.path == "/api/auth/me" else "unexpected"
        assert stage != "unexpected", "Unplanned synthetic outbound endpoint"
        observation = {"stage": stage, "method": method, "normal": _label(token, NORMAL),
                       "elevation": _label(super_token, ELEVATION),
                       "url": _label(f"{parts.scheme}://{parts.netloc}", URLS), "pair": _pair_labels()}
        hub.observations.append(observation)
        hub.check_lock()
        if stage == "resolve":
            assert method == "GET" and timeout == 15
            if switch:
                hub.switch(switch)
            return 200, ({"id": "different-workspace", "name": "Synthetic mismatch"} if error == "resolve-mismatch" else dict(WORKSPACE))
        if stage == "auth-probe":
            assert method == "GET"
            return 200, {"email": "synthetic-probe@example.invalid"}
        assert method == "PUT" and timeout == 30
        assert body == {"generation_ids": ["g1"], "operation": "assign",
                        "workspace_id": WORKSPACE["id"], "workspace_name": WORKSPACE["name"]}
        if error in (401, 502):
            return error, {"detail": "Synthetic remote rejection"}
        return 200, {"workspace": ({"id": "different-workspace", "name": "Synthetic mismatch"} if error == "put-mismatch" else dict(WORKSPACE)),
                     "operation": "assign", "changed": ["g1"], "unchanged": [], "project": None, "updates": []}

    monkeypatch.setattr(_proxy, "raw_request", raw_request)


def _outbound(hub):
    return [row for row in hub.observations if row["stage"] in {"resolve", "put", "auth-probe"}]


def _assert_a_outbound(hub):
    calls = _outbound(hub)
    assert calls
    assert all(row["normal"] == row["url"] == "A" and row["pair"] == ["A", "A"] for row in calls), calls
    assert all(row["elevation"] == ("A" if row["stage"] == "put" else "none") for row in calls), calls


def _assert_no_local_mutation(hub):
    assert {email: hub.snapshot(email) for email in (A, B)} == hub.before


def test_normal_proxy_uses_a_without_local_mutation(hub, monkeypatch):
    _remote(hub, monkeypatch)
    result = generation.set_team_generation_workspace_batch(_body(), _request())
    assert result["changed"] == ["g1"]
    hub.assert_outer(A)
    _assert_no_local_mutation(hub)
    _assert_a_outbound(hub)


def test_pointer_switch_after_resolve_does_not_use_b_credentials(hub, monkeypatch):
    """B's preexisting elevation is intentional, not a normal-login simulation."""
    _remote(hub, monkeypatch, switch="pointer")
    result = generation.set_team_generation_workspace_batch(_body(), _request())
    assert result["workspace"] == WORKSPACE
    hub.assert_outer(B)
    assert hub.settings(B)["elevation"] == "B"
    _assert_no_local_mutation(hub)
    _assert_a_outbound(hub)


def test_actual_login_clears_b_elevation_before_pointer_publish(hub, monkeypatch):
    _remote(hub, monkeypatch, switch="login")
    generation.set_team_generation_workspace_batch(_body(), _request())
    hub.assert_outer(B)
    assert hub.settings(B) == {"normal": "B", "elevation": "none", "url": "B"}
    assert hub.settings(A)["elevation"] == "A"
    _assert_no_local_mutation(hub)
    _assert_a_outbound(hub)


def test_missing_token_401_restores_scope_and_keeps_new_pointer(hub, monkeypatch):
    for path in hub.paths.values():
        with db.get_connection(path) as conn:
            conn.execute("UPDATE app_setting SET value=NULL WHERE key=?", (shared_connection.K_TOKEN,))
    switched = False
    def proxying():
        nonlocal switched
        if not switched:
            switched = True
            hub.switch()
        return True
    monkeypatch.setattr(_proxy, "proxying", proxying)
    def forbidden_raw(*args, **kwargs):
        raise AssertionError("Missing tokens must fail before outbound raw_request")
    monkeypatch.setattr(_proxy, "raw_request", forbidden_raw)
    with pytest.raises(HTTPException) as caught:
        generation.set_team_generation_workspace_batch(_body(), _request())
    assert caught.value.status_code == 401
    hub.assert_outer(B)
    _assert_no_local_mutation(hub)


@pytest.mark.parametrize("error,status", [(401, 401), (502, 502), ("put-mismatch", 409), ("resolve-mismatch", 409)])
def test_remote_failure_restores_scope_and_keeps_b_pointer(hub, monkeypatch, error, status):
    _remote(hub, monkeypatch, switch="pointer", error=error)
    with pytest.raises(HTTPException) as caught:
        generation.set_team_generation_workspace_batch(_body(), _request())
    assert caught.value.status_code == status
    if status == 401:
        # Real proxy auth-failure handling probes the same synthetic token and preserves it.
        assert caught.value.headers[_proxy.AUTH_STATE_HEADER] == _proxy.AUTH_STATE_PRESERVED
        assert len([row for row in _outbound(hub) if row["stage"] == "auth-probe"]) == 1
    hub.assert_outer(B)
    _assert_no_local_mutation(hub)
    _assert_a_outbound(hub)


@pytest.mark.parametrize("transition", [False, True])
def test_nonproxy_delegation_keeps_entry_account_database(hub, monkeypatch, transition):
    checks = 0
    def proxying():
        nonlocal checks
        checks += 1
        if checks == 1 and transition:
            hub.switch()
        return False
    monkeypatch.setattr(_proxy, "proxying", proxying)
    def forbidden_raw(*args, **kwargs):
        raise AssertionError("Nonproxy delegation must never reach raw_request")
    monkeypatch.setattr(_proxy, "raw_request", forbidden_raw)
    result = generation.set_team_generation_workspace_batch(_body(), _request())
    hub.assert_outer(B if transition else A)
    hub.observations.append({"stage": "local-result", "changed": result["changed"],
                             "a_rows": hub.snapshot(A), "b_rows": hub.snapshot(B)})
    assert result["changed"] == ["g1"]
    assert hub.snapshot(B) == hub.before[B]
    assert hub.snapshot(A)["generation"][0]["workspace_id"] == WORKSPACE["id"]
    assert hub.snapshot(A)["generation"][0]["creator_uid"] == UIDS[A]
    assert result["updates"][0]["generation"]["id"] == "g1"
