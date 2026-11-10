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


def test_existing_window_schema_is_upgraded_without_losing_rows():
    from app.db_hf_org_usage import _SCHEMA
    old = _SCHEMA.replace("fail_count INTEGER NOT NULL DEFAULT 0,", "").replace(
        "recheck_snapshot_version INTEGER NOT NULL DEFAULT 0,", "")
    with sqlite3.connect(":memory:") as conn:
        conn.executescript(old)
        conn.execute("INSERT INTO hf_org_usage_window(org_id,start_ms,end_ms,kind) VALUES('fixture',1,2,'day')")
        migrate(conn)
        migrate(conn)
        assert conn.execute("SELECT org_id,fail_count,recheck_snapshot_version FROM hf_org_usage_window").fetchone() == ("fixture", 0, 0)


def test_failure_backoff_caps_and_success_resets(world, monkeypatch):
    at = repo.today_start(repo.now_ms()) + 1000
    monkeypatch.setattr(repo, "now_ms", lambda: at)
    context = configured()
    item = window(context, repo.today_start(at))
    for attempt in range(1, 14):
        repo.attempt_failed(item["id"], "http_5xx")
        with manage_db.get_connection() as conn:
            saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
        assert saved["fail_count"] == attempt
        assert saved["next_due_ms"] - at == min(repo.DAY_MS, 60000 * 2**(attempt - 1))
    publish(context, item, [])
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT fail_count,last_attempt_code,priority FROM hf_org_usage_window").fetchone()[:] == (0, "ok", 20)


@pytest.mark.parametrize("code", ["report_limit_exceeded", "invalid_amount", "invalid_response", "invalid_future_code",
                                  "row_outside_window", "response_range_mismatch", "page_limit",
                                  "repeated_cursor", "duplicate_row", "integrity_error"])
def test_deterministic_failure_waits_a_day_and_loses_manual_priority(world, monkeypatch, code):
    at = repo.now_ms()
    monkeypatch.setattr(repo, "now_ms", lambda: at)
    context = configured()
    item = window(context, repo.today_start(at) - 10 * repo.DAY_MS)
    repo.reserve_windows(context["org_id"], [(item["start_ms"], item["end_ms"], "day", 30)], at=at)
    repo.attempt_failed(item["id"], code)
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
    assert (saved["next_due_ms"], saved["priority"], saved["last_attempt_code"]) == (at + repo.DAY_MS, 0, code)


@pytest.mark.parametrize("age,priority", [(0, 20), (1, 15), (7, 15), (8, 0)])
def test_success_and_failure_restore_age_priority(world, monkeypatch, age, priority):
    at = repo.now_ms()
    monkeypatch.setattr(repo, "now_ms", lambda: at)
    context = configured()
    item = window(context, repo.today_start(at) - age * repo.DAY_MS)
    for success in (False, True):
        repo.reserve_windows(context["org_id"], [(item["start_ms"], item["end_ms"], "day", 30)])
        if success:
            publish(context, item, [])
        else:
            repo.attempt_failed(item["id"], "http_5xx")
        with manage_db.get_connection() as conn:
            assert conn.execute("SELECT priority FROM hf_org_usage_window").fetchone()[0] == priority


def test_duplicate_check_does_not_reschedule_days(world):
    context = configured()
    start = repo.today_start(repo.now_ms()) - 3 * repo.DAY_MS
    days = [window(context, start + n * repo.DAY_MS) for n in range(2)]
    exact = window(context, start, end=start + 2 * repo.DAY_MS, kind="exact")
    for day in days:
        publish(context, day, [row()])
    with repo.transaction() as conn:
        conn.execute("UPDATE hf_org_usage_window SET next_due_ms=? WHERE kind='day'", (repo.NO_AUTO_DUE,))
    publish(context, exact, [row()])
    with manage_db.get_connection() as conn:
        check = dict(conn.execute("SELECT * FROM hf_org_usage_check").fetchone())
        assert (check["state"], check["reason_code"]) == ("duplicate", "duplicate_row")
        assert all(r[0] == repo.NO_AUTO_DUE for r in conn.execute("SELECT next_due_ms FROM hf_org_usage_window"))


def test_mismatch_recheck_once_per_exact_version_and_matched_stops(world):
    context = configured()
    start = repo.today_start(repo.now_ms()) - 3 * repo.DAY_MS
    day, exact = window(context, start), window(context, start, kind="exact")
    publish(context, day, [row()])
    publish(context, exact, [row(credits_c=999)])
    with repo.transaction() as conn:
        assert conn.execute("SELECT recheck_snapshot_version FROM hf_org_usage_window WHERE kind='exact'").fetchone()[0] == 1
        conn.execute("UPDATE hf_org_usage_window SET next_due_ms=?", (repo.NO_AUTO_DUE,))
    publish(context, day, [row()])
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT next_due_ms FROM hf_org_usage_window WHERE kind='exact'").fetchone()[0] == repo.NO_AUTO_DUE
    publish(context, exact, [row(credits_c=998)])
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window WHERE kind='exact'").fetchone())
        assert saved["recheck_snapshot_version"] == 2 and saved["next_due_ms"] < repo.NO_AUTO_DUE
    publish(context, exact, [row()])
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT state FROM hf_org_usage_check").fetchone()[0] == "matched"
        assert conn.execute("SELECT next_due_ms FROM hf_org_usage_window WHERE kind='exact'").fetchone()[0] == repo.NO_AUTO_DUE


def test_only_overlapping_exact_is_compared_and_signatures_do_not_hold_writer_lock(world, monkeypatch):
    context = configured()
    start = repo.today_start(repo.now_ms()) - 4 * repo.DAY_MS
    pairs = [(window(context, start + n * repo.DAY_MS), window(context, start + n * repo.DAY_MS, kind="exact")) for n in (0, 2)]
    for index, (day, exact) in enumerate(pairs):
        publish(context, day, [row(str(index))])
        publish(context, exact, [row(str(index))])
    signature, seen = repo.row_signature, []

    def check_lock(rows):
        with manage_db.get_connection() as other:
            other.execute("BEGIN IMMEDIATE")
            other.rollback()
        seen.extend(r["row_id"] for r in rows)
        return signature(rows)

    monkeypatch.setattr(repo, "row_signature", check_lock)
    publish(context, pairs[0][0], [row("0")])
    assert seen == ["0", "0"]


def test_check_write_discards_versions_changed_after_read(world, monkeypatch):
    context = configured()
    start = repo.today_start(repo.now_ms()) - 3 * repo.DAY_MS
    day, exact = window(context, start), window(context, start, kind="exact")
    publish(context, day, [row()])
    signature, calls = repo.row_signature, []

    def change_version(rows):
        if not calls:
            with repo.transaction() as other:
                other.execute("UPDATE hf_org_usage_window SET snapshot_version=snapshot_version+1 WHERE id=?", (day["id"],))
        calls.append(1)
        return signature(rows)

    monkeypatch.setattr(repo, "row_signature", change_version)
    publish(context, exact, [row()])
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM hf_org_usage_check").fetchone()[0] == 0


def test_matching_days_do_not_cancel_an_explicit_exact_refresh(world):
    context = configured()
    start = repo.today_start(repo.now_ms()) - 3 * repo.DAY_MS
    day, exact = window(context, start), window(context, start, kind="exact")
    publish(context, day, [row()])
    publish(context, exact, [row()])
    repo.reserve_windows(context["org_id"], [(start, start + repo.DAY_MS, "exact", 25)])
    publish(context, day, [row()])
    assert repo.due_window(context["org_id"], repo.now_ms())["id"] == exact["id"]
    publish(context, exact, [row()])
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT next_due_ms FROM hf_org_usage_window WHERE kind='exact'").fetchone()[0] == repo.NO_AUTO_DUE
