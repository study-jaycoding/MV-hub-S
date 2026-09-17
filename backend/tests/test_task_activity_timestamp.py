"""작업 배치 활동: 임시 DB만 사용하며 수신/조회로 활동 시각을 만들지 않는다."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app import db, db_migrations, manage_db, repo
from app.models import AssignProjectIn
from app.repo import manage_schema, manage_telemetry, projects, share, workspace_assignments
from app.task_activity import latest_task_activity_at, normalize_task_activity_at


OLD = "2020-01-01 00:00:00"
FIRST = "2021-01-01T00:00:00.000000Z"
SECOND = "2021-02-01T00:00:00.000000Z"


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage.db")
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    manage_db.init_manage_db()
    with db.get_connection() as conn:
        manage_schema.ensure_manage_schema(conn)
        for uid in ("owner", "other"):
            conn.execute("INSERT INTO worker(id,name,account_type) VALUES(?,?,'team')", (uid, uid))
        for pid, wid in (("p1", "ws1"), ("p2", "ws2")):
            conn.execute(
                "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                "VALUES(?,?,'team','team',?,?)", (pid, pid, wid, wid),
            )
    yield tmp_path
    db.flush_pool()


def _content(gid="local", *, uid="owner", **fields):
    data = dict(project_id="p1", folder_path="ep/shot", workspace_scope="team", workspace_id="ws1",
                workspace_name="ws1", task_activity_at=None)
    data.update(fields)
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id,job_id,worker_id,creator_uid,prompt,status,created_at,"
            "project_id,folder_path,workspace_scope,workspace_id,workspace_name,task_activity_at) "
            "VALUES(?,?,'me',?,'private prompt','done',?,?,?,?,?,?,?)",
            (gid, "job-" + gid, uid, OLD, data["project_id"], data["folder_path"],
             data["workspace_scope"], data["workspace_id"], data["workspace_name"], data["task_activity_at"]),
        )
    return gid


def _read(gid="local"):
    with db.get_connection() as conn:
        return dict(conn.execute("SELECT * FROM generation WHERE id=?", (gid,)).fetchone())


def _fact(**fields):
    data = dict(local_gen_id="local", job_id="job-local", creator_uid="owner", project_id="p1",
                folder_path="ep/shot", workspace_scope="team", workspace_id="ws1", workspace_name="ws1",
                created_at=OLD, status="done")
    data.update(fields)
    assert manage_db.upsert_facts("owner@example.test", "owner", [data]) == (1, [])
    with manage_db.get_connection() as conn:
        return dict(conn.execute("SELECT * FROM team_generation_fact WHERE account_email=?",
                                 ("owner@example.test",)).fetchone())


def _bundle(**fields):
    data = dict(id="job-local", creator_uid="owner", prompt="private prompt", status="done",
                created_at=OLD, project_id="p1", folder_path="ep/shot",
                workspace_scope="team", workspace_id="ws1", workspace_name="ws1")
    data.update(fields)
    return {"generation": data, "references": []}


def test_normalize_utc_naive_offset_invalid_and_future():
    assert normalize_task_activity_at("2021-01-01 09:00:00+09:00") == FIRST
    assert normalize_task_activity_at("2021-01-01 00:00:00") == FIRST
    for value in (None, "", "invalid", 123, {}, "9999-12-31T00:00:00Z"):
        assert normalize_task_activity_at(value) is None
    assert normalize_task_activity_at((datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat())
    assert normalize_task_activity_at((datetime.now(timezone.utc) + timedelta(minutes=6)).isoformat()) is None


def test_latest_uses_numeric_comparison_and_keeps_original_date():
    original = "2021-01-01 10:00:00+09:00"
    assert latest_task_activity_at(original, FIRST) == original
    assert latest_task_activity_at(OLD, FIRST) == FIRST
    assert latest_task_activity_at("invalid", FIRST) == FIRST
    assert latest_task_activity_at("invalid", "invalid", 0) == "1970-01-01T00:00:00+00:00"
    assert latest_task_activity_at(None, None, float("nan")) is None


def test_migration_keeps_existing_generation_and_fact_activity_null(isolated):
    _content()
    _fact()
    with db.get_connection() as conn:
        conn.execute("ALTER TABLE generation DROP COLUMN task_activity_at")
        db_migrations._migrate(conn)
        row = conn.execute("SELECT created_at,task_activity_at FROM generation").fetchone()
        assert tuple(row) == (OLD, None)
    with manage_db.get_connection() as conn:
        conn.execute("ALTER TABLE team_generation_fact DROP COLUMN task_activity_at")
        manage_db._migrate_schema(conn)
        row = conn.execute("SELECT created_at,task_activity_at FROM team_generation_fact").fetchone()
        assert tuple(row) == (OLD, None)


def test_assignment_job_anchor_stamps_and_marks_real_local_id_atomically(isolated):
    _content()
    with patch.object(projects, "task_activity_now", return_value=FIRST):
        assert projects.assign_to_project(["job-local"], "p1", folder_path="ep/new", account_uid="owner") == 1
    row = _read()
    assert (row["created_at"], row["folder_path"], row["task_activity_at"]) == (OLD, "ep/new", FIRST)
    dirty = manage_telemetry.list_dirty_telemetry()
    assert [item["local_gen_id"] for item in dirty] == ["local"]
    payload = manage_telemetry.build_telemetry_facts(["local"], "owner")[0]
    assert (payload["created_at"], payload["task_activity_at"]) == (OLD, FIRST)


def test_same_location_and_normalized_path_do_not_refresh_or_dirty(isolated):
    _content(task_activity_at=FIRST)
    assert projects.assign_to_project(["local"], "p1", folder_path=r"ep\shot/", account_uid="owner") == 1
    assert _read()["task_activity_at"] == FIRST
    assert manage_telemetry.list_dirty_telemetry() == []


def test_resume_same_location_is_explicit_and_keeps_owner_scope(isolated):
    _content(task_activity_at=FIRST)
    _content("foreign", uid="other", task_activity_at=FIRST)
    assert AssignProjectIn(generation_ids=["local"]).resume_work is False
    with patch.object(projects, "task_activity_now", return_value=SECOND):
        assert projects.assign_to_project(["local", "foreign"], "p1", account_uid="owner", resume_work=True) == 1
    assert _read()["task_activity_at"] == SECOND
    assert _read("foreign")["task_activity_at"] == FIRST
    assert _read()["created_at"] == OLD


def test_shared_only_resume_does_not_touch_private(isolated):
    _content(task_activity_at=FIRST)
    assert projects.assign_to_project(["local"], "p1", shared_only=True, resume_work=True) == 0
    assert _read()["task_activity_at"] == FIRST


def test_assignment_dirty_failure_rolls_back_location_and_activity(isolated):
    _content()
    with patch.object(manage_telemetry, "mark_telemetry_dirty_in_connection", side_effect=sqlite3.OperationalError("test")):
        with pytest.raises(sqlite3.OperationalError):
            projects.assign_to_project(["local"], "p1", folder_path="ep/new")
    assert (_read()["folder_path"], _read()["task_activity_at"]) == ("ep/shot", None)


def test_http_resume_keeps_owner_guard_and_passes_true(isolated):
    from app.routers import projects as routes

    _content(task_activity_at=FIRST)
    _content("foreign", uid="other", task_activity_at=FIRST)
    request = SimpleNamespace(state=SimpleNamespace(account={"creator_uid": "owner"}))
    with patch.object(routes._proxy, "proxying", return_value=False), \
         patch.object(routes, "_require_assign_target"), \
         patch.object(routes, "account_scope_uid", return_value="owner"), \
         patch.object(routes, "drain_isolated_telemetry"), \
         patch.object(projects, "task_activity_now", return_value=SECOND):
        result = routes.assign_project(
            AssignProjectIn(generation_ids=["local", "foreign"], project_id="p1", resume_work=True),
            request,
        )
    assert result["updated"] == 1
    assert _read()["task_activity_at"] == SECOND
    assert _read("foreign")["task_activity_at"] == FIRST


def test_proxy_team_assignment_forwards_resume_without_local_write(isolated):
    from app.routers import projects as routes

    _content(task_activity_at=FIRST)
    request = SimpleNamespace(state=SimpleNamespace(account=None))
    with patch.object(routes._proxy, "proxying", return_value=True), \
         patch.object(routes._proxy, "proxy_json", return_value={"ok": True}) as forwarded:
        routes.assign_project(AssignProjectIn(generation_ids=["job-local"], project_id="p1", resume_work=True),
                              request, tab="team")
    assert forwarded.call_args.kwargs["body"]["resume_work"] is True
    assert _read()["task_activity_at"] == FIRST


def test_workspace_name_only_preserves_activity_but_move_stamps(isolated):
    _content(task_activity_at=FIRST)
    with patch.object(workspace_assignments, "task_activity_now", return_value=SECOND):
        workspace_assignments.set_generation_workspace_batch(["local"], "assign", {"id": "ws1", "name": "Renamed"}, "owner")
        assert _read()["task_activity_at"] == FIRST
        workspace_assignments.set_generation_workspace_batch(["local"], "assign", {"id": "ws2", "name": "ws2"}, "owner")
    row = _read()
    assert (row["workspace_id"], row["project_id"], row["folder_path"], row["task_activity_at"]) == ("ws2", "p2", None, SECOND)


def test_workspace_move_dirty_failure_rolls_back(isolated):
    _content(task_activity_at=FIRST)
    with patch.object(manage_telemetry, "mark_telemetry_dirty_in_connection", side_effect=sqlite3.OperationalError("test")):
        with pytest.raises(sqlite3.OperationalError):
            workspace_assignments.set_generation_workspace_batch(["local"], "assign", {"id": "ws2", "name": "ws2"}, "owner")
    assert (_read()["workspace_id"], _read()["task_activity_at"]) == ("ws1", FIRST)


def test_project_deletion_stamps_unassignment_and_keeps_generation(isolated):
    _content(task_activity_at=FIRST)
    with patch.object(projects, "task_activity_now", return_value=SECOND):
        assert projects.delete_project("p1")
    assert (_read()["project_id"], _read()["created_at"], _read()["task_activity_at"]) == (None, OLD, SECOND)
    assert [item["local_gen_id"] for item in manage_telemetry.list_dirty_telemetry()] == ["local"]


def test_project_delete_dirty_failure_rolls_back(isolated):
    _content(task_activity_at=FIRST)
    with patch.object(manage_telemetry, "mark_telemetry_dirty_in_connection", side_effect=sqlite3.OperationalError("test")):
        with pytest.raises(sqlite3.OperationalError):
            projects.delete_project("p1")
    assert (_read()["project_id"], _read()["task_activity_at"]) == ("p1", FIRST)
    with db.get_connection() as conn:
        assert conn.execute("SELECT id FROM project WHERE id='p1'").fetchone()


def test_project_workspace_backfill_is_not_new_activity(isolated):
    _content(workspace_scope="unknown", workspace_id=None, workspace_name=None)
    assert repo.set_project_workspace("p1", {"scope": "team", "id": "ws1", "name": "ws1"})
    assert _read()["workspace_id"] == "ws1"
    assert _read()["task_activity_at"] is None


@pytest.mark.parametrize("existing_activity", [None, FIRST])
def test_same_assignment_unknown_workspace_backfill_keeps_activity(isolated, existing_activity):
    _content(workspace_scope="unknown", workspace_id=None, workspace_name=None,
             task_activity_at=existing_activity)
    with patch.object(projects, "task_activity_now", return_value=SECOND):
        assert projects.assign_to_project(["local"], "p1", folder_path="ep/shot", account_uid="owner") == 1
    assert (_read()["workspace_id"], _read()["task_activity_at"]) == ("ws1", existing_activity)
    assert [row["local_gen_id"] for row in manage_telemetry.list_dirty_telemetry()] == ["local"]


@pytest.mark.parametrize("resume,folder", [(True, "ep/shot"), (False, "ep/new")])
def test_unknown_workspace_with_real_placement_or_resume_still_records_activity(isolated, resume, folder):
    _content(workspace_scope="unknown", workspace_id=None, workspace_name=None, task_activity_at=FIRST)
    with patch.object(projects, "task_activity_now", return_value=SECOND):
        projects.assign_to_project(["local"], "p1", folder_path=folder, account_uid="owner", resume_work=resume)
    assert (_read()["workspace_id"], _read()["folder_path"], _read()["task_activity_at"]) == ("ws1", folder, SECOND)


@pytest.mark.parametrize("missing", [None, "invalid", "9999-01-01T00:00:00Z"])
def test_fact_same_location_missing_invalid_keeps_known_activity(isolated, missing):
    _fact(task_activity_at=FIRST)
    row = _fact(task_activity_at=missing, is_shared=True)
    assert (row["created_at"], row["task_activity_at"], row["is_shared"]) == (OLD, FIRST, 1)


def test_fact_changed_location_missing_activity_does_not_copy_old_stamp(isolated):
    _fact(task_activity_at=FIRST)
    row = _fact(folder_path="ep/new")
    assert (row["folder_path"], row["task_activity_at"]) == ("ep/new", None)


def test_fact_old_report_does_not_roll_back_location_or_stamp(isolated):
    _fact(task_activity_at=SECOND)
    row = _fact(task_activity_at=FIRST, workspace_scope="personal", workspace_id=None,
                workspace_name="Personal", project_id=None, project_name="Old", folder_path="old")
    assert (row["workspace_scope"], row["workspace_id"], row["project_id"], row["folder_path"], row["task_activity_at"]) == (
        "team", "ws1", "p1", "ep/shot", SECOND)


def test_fact_same_location_older_activity_and_identity_rekey_preserve_stamp(isolated):
    _fact(task_activity_at=SECOND)
    assert _fact(task_activity_at=FIRST)["task_activity_at"] == SECOND
    row = _fact(local_gen_id="migrated-local")
    assert (row["local_gen_id"], row["task_activity_at"]) == ("migrated-local", SECOND)
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM team_generation_fact").fetchone()[0] == 1


def test_fact_initial_legacy_or_heartbeat_never_invents_activity(isolated):
    assert _fact()["task_activity_at"] is None
    assert _fact(status="running")["task_activity_at"] is None


def test_fact_tombstone_preserves_activity_and_does_not_revive(isolated):
    _fact(task_activity_at=FIRST)
    row = _fact(is_deleted=True, task_activity_at=SECOND)
    assert (row["is_deleted"], row["task_activity_at"]) == (1, FIRST)


def test_bundle_exports_original_activity(isolated):
    _content(task_activity_at=FIRST)
    exported = share.export_bundle(gen_ids=["local"])["generations"][0]["generation"]
    assert (exported["created_at"], exported["task_activity_at"]) == (OLD, FIRST)


def test_bundle_first_legacy_import_does_not_create_activity(isolated):
    assert share.import_bundle_item(_bundle(), "me", "owner") == "inserted"
    with db.get_connection() as conn:
        row = conn.execute("SELECT created_at,task_activity_at FROM generation WHERE job_id='job-local'").fetchone()
        assert tuple(row) == (OLD, None)


def test_bundle_owner_timestamp_propagates_without_receive_time(isolated):
    share.import_bundle_item(_bundle(task_activity_at=FIRST), "me", "owner")
    with db.get_connection() as conn:
        row = conn.execute("SELECT task_activity_at FROM generation WHERE job_id='job-local'").fetchone()
        assert row[0] == FIRST


def test_bundle_same_location_missing_preserves_but_changed_location_clears(isolated):
    _content(task_activity_at=FIRST)
    share.import_bundle_item(_bundle(), "me", "owner")
    assert _read()["task_activity_at"] == FIRST
    share.import_bundle_item(_bundle(folder_path="ep/new"), "me", "owner")
    assert (_read()["folder_path"], _read()["task_activity_at"]) == ("ep/new", None)


def test_bundle_stale_owner_report_keeps_current_location_and_activity(isolated):
    _content(task_activity_at=SECOND)
    share.import_bundle_item(_bundle(task_activity_at=FIRST, project_id="p2", folder_path="old"), "me", "owner")
    assert (_read()["project_id"], _read()["folder_path"], _read()["task_activity_at"]) == ("p1", "ep/shot", SECOND)


def test_bundle_non_owner_cannot_set_activity_or_location(isolated):
    _content(task_activity_at=FIRST)
    assert share.import_bundle_item(_bundle(task_activity_at=SECOND, folder_path="other"), "me", "other") == "blocked"
    assert (_read()["folder_path"], _read()["task_activity_at"]) == ("ep/shot", FIRST)


def test_bundle_unknown_incoming_workspace_preserves_known_workspace_and_activity(isolated):
    _content(task_activity_at=FIRST)
    share.import_bundle_item(_bundle(workspace_scope="unknown", workspace_id=None, workspace_name=None), "me", "owner")
    row = _read()
    assert (row["workspace_scope"], row["workspace_id"], row["workspace_name"], row["task_activity_at"]) == (
        "team", "ws1", "ws1", FIRST)


def test_bundle_legacy_unknown_creator_uses_authenticated_publisher_fallback(isolated):
    _content(uid=None, task_activity_at=FIRST)
    share.import_bundle_item(_bundle(creator_uid=None, task_activity_at=SECOND), "me", "owner")
    row = _read()
    assert (row["creator_uid"], row["task_activity_at"]) == ("owner", SECOND)


@pytest.mark.parametrize("publisher", [None, "me"])
def test_legacy_non_owner_same_location_keeps_activity_but_does_not_accept_timestamp(isolated, publisher):
    _content(task_activity_at=FIRST)
    share.import_bundle_item(_bundle(task_activity_at=SECOND), "me", publisher)
    assert _read()["task_activity_at"] == FIRST


@pytest.mark.parametrize("publisher", [None, "me"])
def test_legacy_non_owner_location_fill_does_not_reuse_other_location_activity(isolated, publisher):
    _content(folder_path=None, task_activity_at=FIRST)
    share.import_bundle_item(_bundle(task_activity_at=SECOND), "me", publisher)
    # 레거시 빈 위치 보강은 유지한다. 그 위치에서의 활동 근거는 없으므로 옛 시각을 이식하지 않는다.
    assert (_read()["folder_path"], _read()["task_activity_at"]) == ("ep/shot", None)


def test_higgsfield_upsert_does_not_invent_or_overwrite_activity(isolated):
    _content(task_activity_at=FIRST)
    parsed = {"generation": {"id": "job-local", "prompt": "p", "model": "m", "params": {},
                              "status": "done", "created_at": OLD, "creator_uid": "owner"},
              "asset": None, "references": []}
    repo.upsert_synced_generation(parsed, "me")
    assert _read()["task_activity_at"] == FIRST
