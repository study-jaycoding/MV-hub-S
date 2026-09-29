"""PM optimistic locking, atomic journals, scoped history and legacy compatibility."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, deps, manage_db, rbac
from app.repo import event_journal, manage, manage_credit_plan as credit, manage_member_table, manage_schema
from app.routers import manage as routes


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "usage.db")
    db.flush_pool()
    db.init_db()
    manage_db.init_manage_db()
    with db.get_connection() as conn:
        manage_schema._ensure_schema(conn)
        conn.executemany("INSERT INTO creator(uid, name) VALUES(?,?)", [("u_a", "Alice"), ("u_b", "Bob"), ("u_m", "Member")])
        conn.executemany(
            "INSERT INTO account(email, name, creator_uid, password_hash, status, global_role) VALUES(?,?,?,'h','approved',?)",
            [("a@example.test", "Alice", "u_a", "product_manager"),
             ("b@example.test", "Bob", "u_b", "product_manager"),
             ("member@example.test", "Member", "u_m", "member")],
        )
        for wid, pid in (("ws1", "p1"), ("ws2", "p2")):
            conn.execute("INSERT INTO workspace_registry(id, name) VALUES(?,?)", (wid, wid))
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id) VALUES(?,?,'team','team',?)",
                (pid, pid, wid),
            )
            conn.execute(
                "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, is_available) VALUES(?,?,?,1)",
                (wid, "member@example.test", "u_m"),
            )
        conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('p1','u_m',?)",
            (rbac.PROJECT_MANAGER,),
        )
    yield
    db.flush_pool()


@pytest.fixture
def client(isolated, monkeypatch):
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(routes, "AUTH_ENABLED", True)
    app = FastAPI()

    @app.middleware("http")
    async def test_account(request, call_next):
        who = request.headers.get("x-actor", "a")
        request.state.account = {
            "email": f"{who}@example.test",
            "creator_uid": "u_m" if who == "member" else f"u_{who}",
            "status": "approved",
            "global_role": "member" if who == "member" else "product_manager",
        }
        return await call_next(request)

    app.include_router(routes.router)
    with TestClient(app) as http:
        yield http


def _credit_save(revision=0, **kwargs):
    return credit.save_settings("ws1", revision=revision, note=kwargs.pop("note", None), groups=kwargs.pop("groups", None), **kwargs)


def _journal():
    return event_journal.list_audit_events(limit=1000)


def test_initial_and_member_table_revisions(client):
    assert client.get("/api/manage/planning/p1").json() == {"revision": 0}
    assert credit.get_settings("ws1")["plan"]["updated_by"] is None
    table = manage_member_table.member_table("ws1", with_credit=True)
    assert table["projects"][0]["planning"] is None
    saved = client.put("/api/manage/planning/p1", json={"revision": 0, "note": "initial"}).json()
    assert saved["revision"] == 1
    assert saved["updated_by"] == "u_a"
    assert saved["updated_at"]
    table = manage_member_table.member_table("ws1", with_credit=True)
    assert table["projects"][0]["planning"] == saved


@pytest.mark.parametrize("kind", ["planning", "credit"])
@pytest.mark.parametrize("revision", [0, 1])
def test_simultaneous_same_revision_only_one_succeeds(isolated, kind, revision):
    save = (lambda rev, uid: manage.set_planning("p1", revision=rev, actor_uid=uid, note=uid)) if kind == "planning" else (
        lambda rev, uid: _credit_save(rev, actor_uid=uid, note=uid)
    )
    conflict = manage.PlanningConflict if kind == "planning" else credit.CreditPlanConflict
    if revision:
        save(0, "u_a")
    barrier = threading.Barrier(2)

    def writer(uid):
        barrier.wait(timeout=10)
        try:
            return save(revision, uid)
        except conflict as exc:
            assert exc.expected_revision == revision
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(writer, ["u_a", "u_b"]))
    assert sum(result is not None for result in results) == 1
    latest = manage.get_planning("p1") if kind == "planning" else credit.get_settings("ws1")["plan"]
    assert latest["revision"] == revision + 1
    assert latest["note"] == latest["updated_by"]
    assert len(_journal()) == revision + 1


def test_planning_http_conflict_reports_each_intervening_editor(client):
    first = client.put("/api/manage/planning/p1", json={"revision": 0, "note": "private note", "budget_credits": 100}).json()
    second = client.put("/api/manage/planning/p1", headers={"x-actor": "b"}, json={**first, "budget_credits": 200}).json()
    third = client.put("/api/manage/planning/p1", json={**second, "due_date": "2026-10-20"}).json()
    manage.set_planning("p2", revision=0, note="other project", actor_uid="u_b")
    response = client.put("/api/manage/planning/p1", json={**first, "note": "stale"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert set(detail) == {"kind", "latest", "latest_revision", "changes", "history_complete"}
    assert detail["kind"] == "manage_edit_conflict"
    assert detail["latest"] == third
    assert detail["latest_revision"] == detail["latest"]["revision"] == 3
    assert detail["history_complete"] is True
    assert [(c["revision"], c["actor_uid"], c["actor_name"], c["fields"]) for c in detail["changes"]] == [
        (2, "u_b", "Bob", ["budget_credits"]), (3, "u_a", "Alice", ["due_date"]),
    ]
    assert all(c["created_at"] for c in detail["changes"])
    assert "private note" not in json.dumps(_journal())
    assert "stale" not in json.dumps(_journal())


def test_credit_http_conflict_paths_are_private_and_resource_scoped(client):
    gid, tid = "a" * 32, "b" * 32
    group = {"id": gid, "name": "private group", "monthly_limit": 100}
    first = client.put("/api/manage/credit-plan/ws1", json={"revision": 0, "groups": [group]}).json()
    assert first["plan"]["updated_by"] == "u_a"
    assert client.put("/api/manage/credit-plan/ws1", headers={"x-actor": "b"}, json={
        "revision": 1, "groups": [{**group, "color": "#ff0000"}],
        "members": [{"email": "member@example.test", "group_id": gid, "quota": 20}],
    }).status_code == 200
    latest = client.put("/api/manage/credit-plan/ws1", json={
        "revision": 2, "topups": [{"id": tid, "day": "2026-09-28", "credits": 5, "note": "private memo"}],
    }).json()
    credit.save_settings("ws2", revision=0, groups=None, note="other workspace", actor_uid="u_b")
    response = client.put("/api/manage/credit-plan/ws1", json={"revision": 1, "note": "stale"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["latest"] == latest
    assert detail["latest_revision"] == latest["plan"]["revision"] == 3
    assert detail["history_complete"] is True
    changes = detail["changes"]
    assert [(c["revision"], c["actor_uid"], c["actor_name"]) for c in changes] == [(2, "u_b", "Bob"), (3, "u_a", "Alice")]
    target = event_journal.account_target("member@example.test")
    assert set(changes[0]["fields"]) == {f"groups.{gid}.color", f"members.{target}.group_id", f"members.{target}.quota"}
    assert set(changes[1]["fields"]) == {f"topups.{tid}.day", f"topups.{tid}.credits", f"topups.{tid}.note"}
    journal_text = json.dumps(_journal())
    assert not any(value in journal_text for value in ["@", "private group", "private memo", "#ff0000", "stale"])


@pytest.mark.parametrize("pooled", [False, True])
@pytest.mark.parametrize("kind", ["planning", "credit_partial", "credit_full"])
@pytest.mark.parametrize("existing", [False, True])
def test_audit_failure_rolls_back_state_revision_and_journal(isolated, monkeypatch, pooled, kind, existing):
    monkeypatch.setattr(db, "_POOL_ENABLED", pooled)
    if kind == "planning":
        save = lambda revision: manage.set_planning("p1", revision=revision, actor_uid="u_a", note=f"v{revision}")
        read = lambda: manage.get_planning("p1")
        owner = manage
    else:
        save = lambda revision: _credit_save(
            revision, note=f"v{revision}", actor_uid="u_b",
            groups=[{"name": f"G{revision}", "monthly_limit": 20}] if kind == "credit_full" else None,
            topups=[{"day": "2026-09-28", "credits": 10}],
        )
        read = lambda: credit.get_settings("ws1")
        owner = credit
    if existing:
        save(0)
    before, journal = read(), _journal()
    original = owner._record_audit_event

    def fail_after_insert(conn, *args, **kwargs):
        assert conn.in_transaction
        original(conn, *args, **kwargs)
        raise RuntimeError("injected journal failure")

    monkeypatch.setattr(owner, "_record_audit_event", fail_after_insert)
    with pytest.raises(RuntimeError, match="injected journal failure"):
        save(int(existing))
    assert read() == before
    assert _journal() == journal


@pytest.mark.parametrize("extra", [{}, {"revision": None}])
def test_legacy_planning_semantics_and_audit_expected_revision(client, extra):
    first = client.put("/api/manage/planning/p1", json={
        "revision": 0, "status": "active", "start_date": "2026-09-01", "due_date": "2026-10-01",
        "budget_credits": 500, "budget_period": "week", "archive_after_days": 45, "note": "before",
    }).json()
    legacy = client.put("/api/manage/planning/p1", json={**extra, "note": "legacy"}).json()
    assert legacy["revision"] == first["revision"] + 1
    assert legacy["budget_period"] == "week"
    assert legacy["archive_after_days"] == 45
    assert all(legacy[key] is None for key in ("status", "start_date", "due_date", "budget_credits"))
    cleared = client.put("/api/manage/planning/p1", json={"revision": 2, "note": None, "budget_period": None, "archive_after_days": None}).json()
    assert cleared["note"] is None
    assert (cleared["budget_period"], cleared["archive_after_days"]) == ("week", 45)
    events = {event["details"]["revision"]: event for event in _journal()}
    assert events[2]["details"]["expected_revision"] is None
    assert events[3]["details"]["expected_revision"] == 2
    assert set(events[2]["fields"]) == {"status", "start_date", "due_date", "budget_credits", "note"}


def test_credit_absent_null_and_empty_semantics_stay_distinct(client):
    gid = "a" * 32
    group = {"id": gid, "name": "G", "monthly_limit": 100}
    member = {"email": "member@example.test", "group_id": gid, "quota": 20}
    assert client.put("/api/manage/credit-plan/ws1", json={
        "revision": 0, "note": "before", "recurring_topup": 400, "topup_day": 20,
        "groups": [{**group, "allowed_models": ["model_a"], "color": "#ff0000"}], "members": [member],
        "topups": [{"day": "2026-09-28", "credits": 5}],
    }).status_code == 200
    kept = client.put("/api/manage/credit-plan/ws1", json={
        "revision": 1, "groups": [group], "members": [{"email": member["email"]}], "topups": None,
    }).json()
    assert kept["plan"]["recurring_topup"] == 400
    assert kept["plan"]["topup_day"] == 20
    assert kept["plan"]["note"] is None
    assert kept["members"][0]["quota"] == 20
    assert kept["groups"][0]["color"] == "#ff0000"
    assert kept["groups"][0]["allowed_models"] == ["model_a"]
    assert len(kept["topups"]) == 1
    cleared = client.put("/api/manage/credit-plan/ws1", json={
        "revision": 2, "recurring_topup": None, "groups": [{**group, "allowed_models": [], "color": ""}],
        "members": [{"email": member["email"], "quota": None}], "topups": [],
    }).json()
    assert cleared["plan"]["recurring_topup"] is None
    assert cleared["members"][0]["quota"] is None
    assert cleared["members"][0]["group_id"] == gid
    assert cleared["groups"][0]["color"] is None
    assert cleared["groups"][0]["allowed_models"] == []
    assert cleared["topups"] == []
    ignored = client.put("/api/manage/credit-plan/ws1", json={
        "revision": 3, "groups": None, "members": [{"email": member["email"], "group_id": None}],
    }).json()
    assert ignored["members"][0]["group_id"] == gid
    removed = client.put("/api/manage/credit-plan/ws1", json={"revision": 4, "groups": []}).json()
    assert removed["groups"] == []
    assert removed["members"][0]["group_id"] is None


def test_conflict_metadata_is_not_read_without_resource_permission(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("unauthorized conflict snapshot was read")

    monkeypatch.setattr(manage, "planning_conflict_detail", forbidden)
    monkeypatch.setattr(credit, "settings_conflict_detail", forbidden)
    assert client.put("/api/manage/planning/p2", headers={"x-actor": "member"}, json={"revision": 0}).status_code == 403
    assert client.put("/api/manage/credit-plan/ws1", headers={"x-actor": "member"}, json={"revision": 0}).status_code == 403
    # A project PM can edit its planning but still cannot edit the shared workspace plan.
    assert client.put("/api/manage/planning/p1", headers={"x-actor": "member"}, json={"revision": 0}).status_code == 200


def test_history_gaps_and_large_edits_do_not_claim_completeness(isolated):
    manage.set_planning("p1", revision=0, note="first")
    manage.set_planning("p1", revision=1, note="second", actor_uid="u_b")
    with db.get_connection() as conn:
        conn.execute("DELETE FROM audit_event WHERE target_id='p1' AND json_extract(details, '$.revision')=1")
    detail = manage.planning_conflict_detail("p1", 0)
    assert detail["history_complete"] is False
    assert [c["revision"] for c in detail["changes"]] == [2]
    assert manage.planning_conflict_detail("p1", 1)["history_complete"] is True
    assert manage.planning_conflict_detail("p1", 9)["history_complete"] is False
    _credit_save(groups=[{"name": f"G{i}"} for i in range(20)])
    detail = credit.settings_conflict_detail("ws1", 0)
    assert len(detail["changes"][0]["fields"]) == 100
    assert detail["history_complete"] is False


@pytest.mark.parametrize("conflict", [False, True])
def test_credit_snapshot_does_not_mix_revisions_during_concurrent_write(isolated, monkeypatch, conflict):
    gid = "a" * 32
    before = _credit_save(groups=[{"id": gid, "name": "Before", "monthly_limit": 100}])
    original = credit._load
    reader_thread = threading.get_ident()
    writes = []
    with ThreadPoolExecutor(max_workers=1) as pool:
        def interleaved_load(conn, workspace_id):
            if threading.get_ident() != reader_thread or writes:
                return original(conn, workspace_id)

            def trace(sql):
                # The plan row was read, but groups/members/topups have not been read yet.
                if sql.startswith("SELECT * FROM workspace_credit_group WHERE") and not writes:
                    writes.append(pool.submit(
                        _credit_save, 1, actor_uid="u_b", note="After",
                        groups=[{"id": gid, "name": "After", "monthly_limit": 200}],
                        members=[{"email": "member@example.test", "group_id": gid, "quota": 30}],
                        topups=[{"day": "2026-09-28", "credits": 9}],
                    ))
                    writes[0].result(timeout=10)

            conn.set_trace_callback(trace)
            try:
                return original(conn, workspace_id)
            finally:
                conn.set_trace_callback(None)

        monkeypatch.setattr(credit, "_load", interleaved_load)
        if conflict:
            detail = credit.settings_conflict_detail("ws1", 0)
            assert detail["latest_revision"] == 1
            assert [change["revision"] for change in detail["changes"]] == [1]
            assert detail["history_complete"] is True
            actual = detail["latest"]
        else:
            actual = credit.get_settings("ws1")
        assert len(writes) == 1
        assert writes[0].result(timeout=10)["plan"]["revision"] == 2
    assert actual == before
    assert credit.get_settings("ws1")["plan"]["revision"] == 2


def test_retained_history_limit_is_explicit(isolated):
    with db.get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO project_planning(project_id, revision) VALUES('p1', 201)")
        for revision in range(1, 202):
            event_journal._record_audit_event(
                conn, "project.planning_changed", actor_uid=None, target_type="project_planning",
                target_id="p1", project_id="p1", fields=[],
                details={"revision": revision, "expected_revision": revision - 1, "fields_complete": True},
            )
    detail = manage.planning_conflict_detail("p1", 0)
    assert detail["history_complete"] is False
    assert [change["revision"] for change in detail["changes"]] == list(range(2, 202))
    assert manage.planning_conflict_detail("p1", 1)["history_complete"] is True


def test_planning_and_credit_remain_independent_partial_saves(client):
    assert client.put("/api/manage/credit-plan/ws1", json={"revision": 0, "note": "credit"}).status_code == 200
    assert client.put("/api/manage/planning/p1", json={"revision": 0, "note": "planning"}).status_code == 200
    assert client.put("/api/manage/credit-plan/ws1", json={"revision": 0, "note": "stale"}).status_code == 409
    assert manage.get_planning("p1")["note"] == "planning"
    assert credit.get_settings("ws1")["plan"]["note"] == "credit"


def test_internal_noop_and_synthetic_actor_do_not_invent_edits(isolated):
    manage.set_planning("p1", revision=0, actor_uid="acct:private@example.test")
    manage.set_planning("p1")
    detail = manage.planning_conflict_detail("p1", 0)
    assert detail["history_complete"] is True
    assert [c["fields"] for c in detail["changes"]] == [[], []]
    assert [c["actor_name"] for c in detail["changes"]] == ["\ud300\uc6d0", "\ud300\uc6d0"]
    assert detail["changes"][0]["actor_uid"].startswith("account:")
    assert detail["changes"][1]["actor_uid"] is None
    assert "@" not in json.dumps(detail)
    assert manage.get_planning("p1")["updated_by"] is None


def test_legacy_identifiers_are_not_copied_to_journal_paths(isolated):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO workspace_credit_group(id, workspace_id, name, base_start) VALUES('private-legacy-id','ws1','G','2026-09-01')"
        )
    _credit_save(
        groups=[{"id": "private-legacy-id", "name": "G", "color": "#ff0000"}],
        members=[{"email": "account:private-value", "group_id": "private-legacy-id", "quota": 20}],
    )
    event = _journal()[0]
    assert "groups.color" in event["fields"]
    assert "members.group_id" in event["fields"]
    assert "members.quota" in event["fields"]
    assert "private" not in json.dumps(event)


def test_additive_legacy_schema_migration_is_idempotent(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "legacy.db"))
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        conn.execute("CREATE TABLE project_planning(project_id TEXT PRIMARY KEY, status TEXT, start_date TEXT, due_date TEXT, budget_credits INTEGER, note TEXT)")
        conn.execute("INSERT INTO project_planning(project_id, budget_credits, note) VALUES('p1', 123, 'old note')")
        conn.execute("CREATE TABLE workspace_credit_plan(workspace_id TEXT PRIMARY KEY, note TEXT, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT)")
        conn.execute("INSERT INTO workspace_credit_plan VALUES('ws1', 'old credit', 7, '2026-01-01')")
        for _ in range(2):
            manage_schema._SCHEMA_ENSURED.clear()
            manage_schema._ensure_schema(conn)
            planning = dict(conn.execute("SELECT * FROM project_planning").fetchone())
            assert (planning["revision"], planning["updated_by"], planning["updated_at"]) == (0, None, None)
            assert (planning["budget_credits"], planning["note"]) == (123, "old note")
            plan = dict(conn.execute("SELECT * FROM workspace_credit_plan").fetchone())
            assert (plan["revision"], plan["updated_by"], plan["updated_at"], plan["note"]) == (7, None, "2026-01-01", "old credit")
    saved = manage.set_planning("p1", revision=0, budget_credits=123, note="old note", actor_uid="u_a")
    assert saved["revision"] == 1
    assert saved["updated_by"] == "u_a"
    db.flush_pool()
