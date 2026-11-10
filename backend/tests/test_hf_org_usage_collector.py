from datetime import date
import json
import threading
import urllib.parse

import pytest

from app import config, manage_db
from app.repo import hf_org_usage as repo
from app.services import hf_org_usage_client as client, hf_org_usage_collector as worker
from app.services.hf_org_usage_key import UsageError
from hf_org_usage_fake import FAKE_KEY, api_error, configured, fake_server, publish, report_page, row, window, wire_row, world


@pytest.mark.parametrize("flag", ["no_proxy", "auth", "manage", "read_only", "external"])
def test_environment_gates(monkeypatch, flag):
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "0")
    monkeypatch.setattr(worker.shared_connection, "AUTH_ENABLED", True)
    monkeypatch.setattr(config, "MANAGE_ENABLED", True)
    monkeypatch.setattr(config, "READ_ONLY", False)
    monkeypatch.setattr(config, "EXTERNAL_RECOVERY_ENABLED", True)
    assert worker.env_ok()
    if flag == "no_proxy":
        monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    elif flag == "auth":
        monkeypatch.setattr(worker.shared_connection, "AUTH_ENABLED", False)
    else:
        monkeypatch.setattr(config, {"manage":"MANAGE_ENABLED", "read_only":"READ_ONLY", "external":"EXTERNAL_RECOVERY_ENABLED"}[flag], flag == "read_only")
    assert not worker.env_ok()


def test_one_persisted_lane_and_30_request_budget_includes_key_checks(world):
    context = configured(False)
    at = repo.now_ms()
    repo.reserve_request("first", context, collecting=False, at=at)
    with pytest.raises(UsageError, match="request_wait"):
        repo.reserve_request("second", context, collecting=False, at=at)
    repo.finish_request("first")
    for index in range(29):
        repo.reserve_request(str(index), context, collecting=False, at=at)
        repo.finish_request(str(index))
    with pytest.raises(UsageError, match="rate_wait"):
        repo.reserve_request("31", context, collecting=False, at=at)
    repo.reserve_request("later", context, collecting=False, at=at+60_001)


def test_schedule_deduplicates_and_progresses_old_days(world):
    context = configured()
    at = worker.day_ms(date(2026, 11, 10))
    worker.schedule_due_windows(context["org_id"], at)
    before = repo.read_collector()["backfill_cursor"]
    worker.schedule_due_windows(context["org_id"], at)
    assert repo.read_collector()["backfill_cursor"] == before+repo.DAY_MS
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM hf_org_usage_window WHERE start_ms=?", (at,)).fetchone()[0] == 1


def test_cursor_cycle_and_partial_failure_preserve_success(world, monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    publish(context, item, [row(credits_c=111)])
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    count = []
    def page(*args, **kwargs):
        count.append(1)
        return dict(org_id=context["org_id"], rows=[row(str(len(count)))], next_cursor="repeat")
    monkeypatch.setattr(client, "fetch_page", page, raising=False)
    with pytest.raises(UsageError, match="repeated_cursor"):
        worker.collect_window(item, context)
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT credits_c FROM hf_org_usage_row").fetchone()[0] == 111


@pytest.mark.parametrize("expires_during", ["request", "staging"])
def test_final_page_past_deadline_preserves_previous_snapshot(world, monkeypatch, expires_during):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    publish(context, item, [row(credits_c=111)])
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    clock = [0]
    stage_rows = repo.stage_rows

    def page(*args, **kwargs):
        if expires_during == "request":
            clock[0] = 241
        return dict(org_id=context["org_id"], rows=[row(credits_c=222)], next_cursor=None)

    def stage(conn, rows):
        stage_rows(conn, rows)
        if expires_during == "staging":
            clock[0] = 241

    monkeypatch.setattr(client, "fetch_page", page)
    monkeypatch.setattr(repo, "stage_rows", stage)
    with monkeypatch.context() as timing:
        timing.setattr(worker.time, "monotonic", lambda: clock[0])
        with pytest.raises(UsageError, match="window_deadline"):
            worker.collect_window(item, context)
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT credits_c FROM hf_org_usage_row").fetchone()[0] == 111
        assert conn.execute("SELECT snapshot_version FROM hf_org_usage_window").fetchone()[0] == 1


def test_410_restarts_once_and_auth_pauses(world, monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    calls = []
    def expired(*args, **kwargs):
        calls.append(1)
        raise UsageError("http_410")
    monkeypatch.setattr(client, "fetch_page", expired, raising=False)
    with pytest.raises(UsageError, match="http_410"):
        worker.collect_window(item, context)
    assert len(calls) == 2
    def unauthorized(*args, **kwargs):
        raise UsageError("http_401")
    monkeypatch.setattr(client, "fetch_page", unauthorized)
    with pytest.raises(UsageError):
        worker.collect_window(item, context)
    assert repo.read_collector()["pause_code"] == "auth"
    assert not repo.read_config()["enabled"]
    assert repo.read_config()["key_verified_revision"] is None


def test_empty_collection_publishes_complete_window(world, monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(client, "fetch_page", lambda *a, **k: dict(org_id=context["org_id"], rows=[], next_cursor=None), raising=False)
    worker.collect_window(item, context)
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
        assert saved["success_complete"] == 1 and saved["row_count"] == 0


def test_429_persists_cooldown_for_key_check_too(world, monkeypatch):
    context = configured(False)
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    calls = []
    def limited(*args, **kwargs):
        calls.append(1)
        raise UsageError("http_429", retry_after=90_000)
    monkeypatch.setattr(client, "fetch_page", limited)
    with pytest.raises(UsageError, match="http_429"):
        worker.request_page("fake", context, 0, 1, collecting=False)
    with pytest.raises(UsageError, match="request_wait"):
        worker.request_page("fake", context, 0, 1, collecting=False)
    assert len(calls) == 1


def test_5xx_retries_are_bounded_without_real_wait(world, monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(worker.time, "sleep", lambda _: None)
    calls = []
    def unavailable(*args, **kwargs):
        calls.append(1)
        raise UsageError("http_5xx")
    monkeypatch.setattr(client, "fetch_page", unavailable)
    with pytest.raises(UsageError, match="http_5xx"):
        worker.collect_window(item, context)
    assert len(calls) == 4


def test_lease_takeover_and_expiry(world):
    context = configured()
    at = repo.now_ms()
    assert repo.acquire_lease("other", at) is None
    later = at + repo.LEASE_MS + 1
    assert repo.acquire_lease("other", later) > context["fence"]
    with pytest.raises(UsageError, match="stale_work"):
        repo.reserve_request("stale", context, collecting=True, at=later)


def wire_setup(monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(date(2026, 11, 1)))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    return context, item


def test_real_http_pages_publish_then_compare(world, monkeypatch):
    from app.usecases.hf_org_usage import compare_usage
    context, item = wire_setup(monkeypatch)
    replies = [(200, {}, report_page(item["start_ms"], item["end_ms"], [wire_row()], next_page="next + & token")),
               (200, {}, report_page(item["start_ms"], item["end_ms"], [wire_row("chg_next", type="charge", generation_id=None)]))]
    with fake_server(replies, organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        worker.collect_window(item, context)
        assert len(calls) == 2
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT row_count,page_count,snapshot_version FROM hf_org_usage_window").fetchone()[:] == (2,2,1)
        assert conn.execute("SELECT state FROM hf_org_usage_row LIMIT 1").fetchone()[0] == "future_state"
    result = compare_usage("2026-11-01", "2026-11-02")
    assert result["api_net_c"] == 30 and result["spaces"][0]["non_generation"] == 1
    assert result["spaces"][0]["actors"][0]["label"].startswith("미연결 #")


def test_report_limit_retries_same_page_once_with_smaller_limit(world, monkeypatch):
    context, item = wire_setup(monkeypatch)
    start, end = item["start_ms"], item["end_ms"]
    replies = [(200, {}, report_page(start, end, [wire_row()], next_page="cursor")),
               (500, {}, api_error("report_limit_exceeded", message=FAKE_KEY)),
               (200, {}, report_page(start, end, [wire_row("chg_next", type="charge")]))]
    with fake_server(replies, organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        worker.collect_window(item, context)
        queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(call).query) for call in calls]
        assert [query["limit"] for query in queries] == [["1000"], ["1000"], ["500"]]
        assert queries[1]["page"] == queries[2]["page"] == ["cursor"]
        assert all(query["starting_at"] == queries[0]["starting_at"] and query["ending_at"] == queries[0]["ending_at"] for query in queries)
    with manage_db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM hf_org_usage_row").fetchone()[0] == 2
    assert len(json.loads(repo.read_collector()["rate_state_json"])) == 3


def test_repeated_limit_error_and_invalid_row_preserve_previous_snapshot(world, monkeypatch):
    context, item = wire_setup(monkeypatch)
    publish(context, item, [row(credits_c=111)])
    for replies, code in (([(500, {}, api_error("report_limit_exceeded"))]*2, "report_limit_exceeded"),
                           ([(200, {}, report_page(item["start_ms"], item["end_ms"], [wire_row()], next_page="next")),
                             (200, {}, report_page(item["start_ms"], item["end_ms"], [wire_row(credits="0.001")]))], "invalid_amount")):
        with fake_server(replies, organization=True) as (url, calls):
            monkeypatch.setattr(client, "ENDPOINT", url)
            with pytest.raises(UsageError, match=code):
                worker.collect_window(item, context)
            assert len(calls) == 2
        with manage_db.get_connection() as conn:
            assert conn.execute("SELECT credits_c FROM hf_org_usage_row").fetchone()[0] == 111
            assert conn.execute("SELECT snapshot_version FROM hf_org_usage_window").fetchone()[0] == 1


def test_wire_410_discards_stage_and_restarts_at_first_page(world, monkeypatch):
    context, item = wire_setup(monkeypatch)
    start, end = item["start_ms"], item["end_ms"]
    replies = [(200, {}, report_page(start, end, [wire_row("old")], next_page="expired")),
               (410, {}, api_error("page_expired")),
               (200, {}, report_page(start, end, [wire_row("replacement")]))]
    with fake_server(replies, organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        worker.collect_window(item, context)
        queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(call).query) for call in calls]
        assert [q.get("page") for q in queries] == [None, ["expired"], None]
    with manage_db.get_connection() as conn:
        assert [r[0] for r in conn.execute("SELECT row_id FROM hf_org_usage_row")] == ["replacement"]


def test_first_kst_day_clips_to_data_start_and_remains_incomplete(world, monkeypatch):
    context = configured()
    item = window(context, worker.day_ms(worker.FIRST_DAY))
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    payload = report_page(client.DATA_START_MS, item["end_ms"], [wire_row(created_at="2026-02-01T00:00:00.000Z")])
    with fake_server([(200, {}, payload)], organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        worker.collect_window(item, context)
        assert urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0]).query)["starting_at"] == ["2026-02-01T00:00:00.000Z"]
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
        assert saved["actual_start_ms"] == client.DATA_START_MS
        assert saved["actual_start_ms"] > saved["start_ms"] and saved["success_complete"] == 0


def test_concurrent_key_check_cannot_bypass_inflight_request(world, monkeypatch):
    context, item = wire_setup(monkeypatch)
    entered, release = threading.Event(), threading.Event()
    results = []
    def delayed(query):
        entered.set()
        release.wait(5)
        return (200, {}, report_page(item["start_ms"], item["end_ms"]))
    with fake_server([delayed], organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        def first():
            try:
                results.append(worker.request_page(FAKE_KEY, context, item["start_ms"], item["end_ms"], collecting=False)["org_id"])
            except UsageError as exc:
                results.append(exc.code)
        thread = threading.Thread(target=first)
        thread.start()
        try:
            assert entered.wait(3)
            with pytest.raises(UsageError, match="request_wait"):
                worker.request_page(FAKE_KEY, context, item["start_ms"], item["end_ms"], collecting=False)
        finally:
            release.set()
            thread.join(5)
        assert len(calls) == 1 and results == [context["org_id"]]


def test_request_lane_is_reserved_for_90_seconds(world):
    context = configured(False)
    at = repo.now_ms()
    repo.reserve_request("active", context, collecting=False, at=at)
    assert repo.read_collector()["io_until_ms"] == at + 90_000
    with pytest.raises(UsageError, match="request_wait"):
        repo.reserve_request("too_early", context, collecting=False, at=at + 89_999)
    repo.reserve_request("expired", context, collecting=False, at=at + 90_000)


def test_schedule_priority_and_failure_wait_survive_rescheduling(world, monkeypatch):
    at = repo.now_ms()
    monkeypatch.setattr(repo, "now_ms", lambda: at)
    context = configured()
    with repo.transaction() as conn:
        conn.execute("UPDATE hf_org_usage_collector SET rotation_cursor=123")
    worker.schedule_due_windows(context["org_id"], at)
    with manage_db.get_connection() as conn:
        rows = {r["start_ms"]: dict(r) for r in conn.execute("SELECT * FROM hf_org_usage_window")}
    today = repo.today_start(at)
    assert rows[today]["priority"] == 20
    assert rows[today - repo.DAY_MS]["priority"] == 15
    first = rows[worker.day_ms(worker.FIRST_DAY)]
    assert first["priority"] == 1
    repo.attempt_failed(first["id"], "invalid_response")
    worker.schedule_due_windows(context["org_id"], at + 1000)
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window WHERE id=?", (first["id"],)).fetchone())
    assert saved["priority"] == 0 and saved["next_due_ms"] == at + repo.DAY_MS
    assert repo.due_window(context["org_id"], at)["start_ms"] == today
    assert repo.read_collector()["rotation_cursor"] == 123  # Legacy column stays untouched.


def test_existing_ongoing_exact_is_neither_selected_nor_requested(world, monkeypatch):
    context = configured()
    item = window(context, repo.today_start(repo.now_ms()), kind="exact")
    monkeypatch.setattr(worker, "request_page", lambda *a, **k: pytest.fail("ongoing exact must not call HTTP"))
    assert repo.due_window(context["org_id"], repo.now_ms()) is None
    with pytest.raises(UsageError, match="invalid_period"):
        worker.collect_window(item, context)


@pytest.mark.parametrize("failure", ["environment", "config", "schedule", "collection", "recording"])
def test_worker_survives_entire_iteration_including_failure_recording(world, monkeypatch, caplog, failure):
    context = configured()
    instance = worker.Collector()
    instance.owner = context["owner"]
    item = window(context, repo.today_start(repo.now_ms()) - repo.DAY_MS)
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(worker, "schedule_due_windows", lambda *a: None)
    monkeypatch.setattr(repo, "due_window", lambda *a: item)
    monkeypatch.setattr(worker, "collect_window", lambda *a, **k: None)
    target, attribute = {"environment": (worker, "env_ok"), "config": (repo, "read_config"),
                         "schedule": (worker, "schedule_due_windows"), "collection": (worker, "collect_window"),
                         "recording": (repo, "attempt_failed")}[failure]
    original = getattr(target, attribute)
    calls = []

    def fails_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("private exception text")
        return original(*args, **kwargs)

    monkeypatch.setattr(target, attribute, fails_once)
    if failure == "recording":
        def failed_collection(*args, **kwargs):
            raise UsageError("http_5xx")
        monkeypatch.setattr(worker, "collect_window", failed_collection)
    waits = iter((False, False, True))
    monkeypatch.setattr(instance._stop, "wait", lambda _: next(waits))
    instance.run()
    assert len(calls) >= 2
    assert "private exception text" not in caplog.text
    if failure != "collection":
        assert "collection_failed" in caplog.text


def test_stage_integrity_failure_is_recorded_as_deterministic(world, monkeypatch):
    context = configured()
    instance = worker.Collector()
    instance.owner = context["owner"]
    item = window(context, repo.today_start(repo.now_ms()) - repo.DAY_MS)
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(worker, "schedule_due_windows", lambda *a: None)
    monkeypatch.setattr(repo, "due_window", lambda *a: item)
    monkeypatch.setattr(client, "fetch_page", lambda *a, **k: dict(rows=[row()], next_cursor="next"))
    before = repo.now_ms()
    instance.run_once()
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
    assert saved["last_attempt_code"] == "integrity_error"
    assert saved["fail_count"] == 1 and saved["next_due_ms"] >= before + repo.DAY_MS


@pytest.mark.parametrize("error", [RuntimeError("private exception text"), UsageError("invalid_response")])
def test_comparison_failure_after_commit_keeps_success_and_updates_identity(world, monkeypatch, caplog, error):
    context = configured()
    instance = worker.Collector()
    instance.owner = context["owner"]
    item = window(context, repo.today_start(repo.now_ms()) - 10 * repo.DAY_MS)
    repo.attempt_failed(item["id"], "http_unavailable")
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(worker, "schedule_due_windows", lambda *a: None)
    monkeypatch.setattr(repo, "due_window", lambda *a: item)
    monkeypatch.setattr(client, "fetch_page", lambda *a, **k: dict(rows=[row()], next_cursor=None))

    def broken_check(conn, *_):
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE hf_org_usage_window SET next_due_ms=0")
        raise error

    monkeypatch.setattr(repo, "update_checks", broken_check)
    before = repo.now_ms()
    instance.run_once()
    with manage_db.get_connection() as conn:
        saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
        assert saved["last_attempt_code"] == "ok" and saved["fail_count"] == 0
        assert saved["snapshot_version"] == saved["row_count"] == 1
        assert saved["next_due_ms"] >= before + repo.DAY_MS
        assert conn.execute("SELECT COUNT(*) FROM hf_org_identity_link").fetchone()[0] == 1
    assert "comparison_failed" in caplog.text
    assert "private exception text" not in caplog.text and "invalid_response" not in caplog.text


def test_truncated_response_uses_transient_window_backoff_and_preserves_snapshot(world, monkeypatch):
    context = configured()
    instance = worker.Collector()
    instance.owner = context["owner"]
    item = window(context, repo.today_start(repo.now_ms()) - 10 * repo.DAY_MS)
    publish(context, item, [row(credits_c=111)])
    monkeypatch.setattr(worker, "env_ok", lambda: True)
    monkeypatch.setattr(worker, "schedule_due_windows", lambda *a: None)
    monkeypatch.setattr(repo, "due_window", lambda *a: item)
    with fake_server([(200, {}, b'{"data":[')] * 2, organization=True) as (url, calls):
        monkeypatch.setattr(client, "ENDPOINT", url)
        for count, delay in ((1, 60_000), (2, 120_000)):
            instance.run_once()
            with manage_db.get_connection() as conn:
                saved = dict(conn.execute("SELECT * FROM hf_org_usage_window").fetchone())
                assert saved["last_attempt_code"] == "http_unavailable" and saved["fail_count"] == count
                assert saved["next_due_ms"] - saved["last_attempt_at_ms"] == delay
                assert saved["snapshot_version"] == 1
                assert conn.execute("SELECT credits_c FROM hf_org_usage_row").fetchone()[0] == 111
        assert len(calls) == 2
