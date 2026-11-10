import sqlite3

import pytest

from app import manage_db
from app.db_hf_org_usage import migrate
from app.repo import hf_org_usage as repo
from app.services.hf_org_usage_key import UsageError
from hf_org_usage_fake import configured, publish, row, window, world


def test_additive_idempotent_schema_and_empty_success(world):
    with manage_db.get_connection() as conn:
        before = conn.execute("SELECT * FROM schema_migrations").fetchall()
        migrate(conn)
        migrate(conn)
        assert conn.execute("SELECT * FROM schema_migrations").fetchall() == before
    context = configured()
    item = window(context, 100)
    publish(context, item, [])
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
        assert saved["success_complete"] == 1
        assert saved["row_count"] == 0
        assert saved["snapshot_version"] == 1


@pytest.mark.parametrize("change", ["revision", "disabled", "deleted", "lease", "restore"])
def test_fence_discards_stale_results_and_keeps_success(world, change):
    context = configured()
    item = window(context, 100)
    publish(context, item, [row(credits_c=125)])
    with manage_db.get_connection() as staged:
        repo.create_stage(staged)
        repo.stage_rows(staged, [row(credits_c=999)])
        if change == "lease":
            with repo.transaction() as conn:
                conn.execute("UPDATE hf_org_usage_collector SET lease_fence=lease_fence+1")
        else:
            changes = {"revision": {}, "disabled": {"enabled": 0}, "deleted": {"encrypted_key": None},
                       "restore": {"restore_paused": 1}}[change]
            repo.update_config(context["revision"], changes)
        with pytest.raises(UsageError, match="stale_work"):
            repo.publish_window(staged, item, context, actual_end=item["end_ms"], started=0, pages=1, next_due=0)
        staged.rollback()
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT credits_c FROM hf_org_usage_row").fetchone()[0] == 125
        assert conn.execute("SELECT snapshot_version FROM hf_org_usage_window").fetchone()[0] == 1


def test_duplicate_page_row_is_failure_not_silent_overwrite(world):
    with manage_db.get_connection() as conn:
        repo.create_stage(conn)
        repo.stage_rows(conn, [row()])
        with pytest.raises(sqlite3.IntegrityError):
            repo.stage_rows(conn, [row()])


def test_revision_and_org_conflicts(world):
    context = configured()
    with pytest.raises(UsageError, match="organization_conflict"):
        repo.update_config(context["revision"], {"org_id": "different"})
    with pytest.raises(UsageError, match="revision_conflict"):
        repo.update_config(0, {"enabled": 0})


def test_exact_check_compares_actor_and_tracks_changed_versions(world):
    from datetime import date
    from app.services.hf_org_usage_collector import day_ms
    context = configured()
    start = day_ms(date(2026, 11, 1))
    day = window(context, start)
    exact = window(context, start, kind="exact")
    publish(context, day, [row()])
    publish(context, exact, [row(actor_user_id="different_actor")])
    with manage_db.get_connection() as conn:
        check = dict(conn.execute("SELECT * FROM hf_org_usage_check").fetchone())
        assert check["state"] == "mismatch"
    publish(context, exact, [row()])
    with manage_db.get_connection() as conn:
        check = dict(conn.execute("SELECT * FROM hf_org_usage_check").fetchone())
        assert check["state"] == "matched" and check["exact_snapshot_version"] == 2
    publish(context, day, [row(workspace_id="different_space")])
    with manage_db.get_connection() as conn:
        check = dict(conn.execute("SELECT * FROM hf_org_usage_check").fetchone())
        assert check["state"] == "mismatch" and check["daily_versions_json"] == '{"1": 2}'
