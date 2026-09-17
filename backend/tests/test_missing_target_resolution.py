"""E3: actual anchor/delete/purge/reconcile functions, synthetic SQLite only.

Historical anchor existence can release that job's tracker, never mutate the
current request. No actual CLI, provider, HTTP, account file or user DB is used.
"""
from __future__ import annotations

import importlib.util
import json
from contextlib import contextmanager
from pathlib import Path
import socket
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, Request

from app import active_account, db, repo
from app.models import FulfillIn
from app.repo import event_journal, trash
from app.routers import generation, gen_requests as routes, library
from app.services import media_cache
from app.usecases import gen_requests as usecase

ACCOUNT = "synthetic-e3@example.invalid"
UID = "synthetic-e3-uid"
GEN = "synthetic-generation"
JOB1, JOB2 = "synthetic-job-1", "synthetic-job-2"


def request(email=ACCOUNT):
    req = Request({"type": "http", "method": "POST", "scheme": "http", "path": "/synthetic",
                   "headers": [(b"host", b"127.0.0.1")], "query_string": b"",
                   "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 8012)})
    req.state.account = {"email": email, "creator_uid": UID}
    return req


async def synchronous_io(function, *args, **kwargs):
    return function(*args, **kwargs)


def immediate(coroutine):
    """All IO awaits are mocked synchronous; no event-loop control sockets needed."""
    try:
        try:
            yielded = coroutine.send(None)
        except StopIteration as done:
            return done.value
        raise AssertionError("Unexpected async boundary: " + type(yielded).__name__)
    finally:
        coroutine.close()


def snapshot(rid):
    with trash._with_trash() as conn:
        r = conn.execute("SELECT * FROM gen_request WHERE id=?", (rid,)).fetchone()
        g = conn.execute("SELECT * FROM generation WHERE id=?", (GEN,)).fetchone()
        t = conn.execute("SELECT * FROM trash.trashed WHERE id=?", (GEN,)).fetchone()
        return {"request": dict(r) if r else None, "generation": dict(g) if g else None,
                "trash": dict(t) if t else None}


def anchor(rid, job):
    assert immediate(routes.anchor_gen_request(rid, request(), job, verifying=False)) == {"ok": True, "applied": True}


def reconcile(rid, job_id=JOB1, status="failed", *, job_extra=None, **kwargs):
    job = {"id": job_id, "status": status, **(job_extra or {})}
    return immediate(routes.reconcile_gen_request(rid, FulfillIn(job=job), request(), **kwargs))


def seed():
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,model,status,creator_uid,origin,created_at,sort_ts) "
                     "VALUES(?,'me','Synthetic prompt','synthetic','pending',?,'local','2026-09-17 00:00:00',1)", (GEN, UID))
    rid = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic", "prompt": "Synthetic prompt"})
    assert [item["id"] for item in repo.claim_pending_requests(ACCOUNT, limit=1, sweep_expired=False)] == [rid]
    return rid


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    target = (tmp_path / "content_hub.db").resolve()
    assert target.is_relative_to(tmp_path.resolve())
    monkeypatch.setenv("CONTENT_HUB_DB", str(target))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "agent"))
    monkeypatch.setattr(active_account, "_cache", [True, {"email": ACCOUNT, "uid": UID}])
    monkeypatch.setattr(routes.asyncio, "to_thread", synchronous_io)
    monkeypatch.setattr(usecase, "_sync_io", synchronous_io)
    monkeypatch.setattr(usecase.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(routes.agent_signals, "touch", Mock())
    monkeypatch.setattr(routes, "schedule_telemetry_drain", Mock())
    monkeypatch.setattr(generation._proxy, "proxying", lambda: False)
    monkeypatch.setattr(generation, "AUTH_ENABLED", False)
    monkeypatch.setattr(media_cache, "local_media_exists", Mock(side_effect=lambda path: path == "/media/synthetic.png"))
    monkeypatch.setattr(socket.socket, "connect", Mock(side_effect=AssertionError("Real network forbidden")))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    yield SimpleNamespace(path=tmp_path, rid=seed())
    db.flush_pool()


def remove_main(*, purge, cleanup_failure=False, monkeypatch=None):
    assert generation.delete_generation(GEN, request()) == {"deleted": True}
    if purge:
        if cleanup_failure:
            assert monkeypatch is not None
            with monkeypatch.context() as scoped:
                scoped.setattr(trash, "_cancel_orphan_requests", Mock(side_effect=sqlite3.OperationalError("Synthetic cleanup failure")))
                assert library.purge_trashed_item(GEN, request()) == {"purged": True}
        else:
            assert library.purge_trashed_item(GEN, request()) == {"purged": True}


def jobs_in_journal():
    with db.get_connection() as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM generation_event WHERE generation_id=?", (GEN,))]


# The first 18 cases replace all six policies in the original design experiment
# with the one actual product route. Rejected broad/unique policies are not installed.
@pytest.mark.parametrize("iteration", range(3))
@pytest.mark.parametrize("case", ["same-trash", "old-trash-broad-control", "old-trash-table-control",
                                  "old-purged", "old-purged-unique-control", "lost-new-purged"])
def test_original_e3_route_scenarios(isolated, monkeypatch, case, iteration):
    rid = isolated.rid
    anchor(rid, JOB1)
    changed = case != "same-trash"
    if changed:
        if case == "lost-new-purged":
            with monkeypatch.context() as scoped:
                scoped.setattr(event_journal, "record_generation_event", Mock(side_effect=OSError("Synthetic journal failure")))
                anchor(rid, JOB2)
        else:
            anchor(rid, JOB2)
    purge = "purged" in case
    remove_main(purge=purge)
    before = snapshot(rid)
    outcome = reconcile(rid)
    after = snapshot(rid)
    assert outcome["asset_saved"] is False and outcome["applied"] is False
    if not changed:
        assert outcome["outcome"] == "target_retired"
        assert outcome["released_job_id"] == JOB1
        assert after["request"]["status"] == "canceled"
        terminal = json.loads(after["trash"]["payload"])["provider_terminal"]
        assert terminal["job_id"] == JOB1 and terminal["kind"] == "failure"
    elif not purge:
        assert outcome["outcome"] == "rejected"
        assert after == before  # history cannot bypass a conflicting trash anchor
    else:
        assert outcome["outcome"] == "stale_tracker_released"
        assert outcome["released_job_id"] == JOB1
        assert outcome["request_changed"] is False
        assert outcome["request_status"] == before["request"]["status"] == "canceled"
        assert after == before
    assert routes.schedule_telemetry_drain.call_count == 0


@pytest.mark.parametrize("iteration", range(3))
@pytest.mark.parametrize("case,changed,lost_event", [("history", True, False), ("unique-control", True, False),
                                                   ("lost-event", True, True), ("same-job", False, False)])
def test_purge_cleanup_failure_never_changes_request(isolated, monkeypatch, iteration, case, changed, lost_event):
    rid = isolated.rid
    anchor(rid, JOB1)
    if changed:
        if lost_event:
            with monkeypatch.context() as scoped:
                scoped.setattr(event_journal, "record_generation_event", Mock(side_effect=OSError("Synthetic journal failure")))
                anchor(rid, JOB2)
        else:
            anchor(rid, JOB2)
    remove_main(purge=True, cleanup_failure=True, monkeypatch=monkeypatch)
    before = snapshot(rid)
    assert before["request"]["status"] == "tracking"
    assert reconcile(rid)["outcome"] == "stale_tracker_released"
    assert snapshot(rid) == before
    if changed:
        outcome = reconcile(rid, JOB2)
        assert outcome["outcome"] == ("rejected" if lost_event else "stale_tracker_released")
        assert snapshot(rid) == before


def test_current_trash_anchor_survives_semantic_journal_loss(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    with monkeypatch.context() as scoped:
        scoped.setattr(event_journal, "record_generation_event", Mock(side_effect=OSError("Synthetic journal failure")))
        anchor(rid, JOB2)
    assert JOB2 not in {event["job_id"] for event in jobs_in_journal()}
    remove_main(purge=False)
    outcome = reconcile(rid, JOB2)
    assert outcome["outcome"] == "target_retired" and outcome["released_job_id"] == JOB2


def test_equal_event_time_and_reverse_uuid_do_not_establish_current_job(isolated, monkeypatch):
    rid = isolated.rid
    ids = iter(["f" * 32, "0" * 32])
    with monkeypatch.context() as scoped:
        scoped.setattr(event_journal, "new_id", lambda: next(ids))
        anchor(rid, JOB1)
        anchor(rid, JOB2)
    # The earlier experiment forced SQLite time itself. This test fixes the two
    # already-written event timestamps while leaving all matching to product SQL.
    with db.get_connection() as conn:
        conn.execute("UPDATE generation_event SET created_at='2026-09-17T00:00:00.123Z' WHERE generation_id=?", (GEN,))
    remove_main(purge=True, cleanup_failure=True, monkeypatch=monkeypatch)
    before = snapshot(rid)
    assert reconcile(rid, JOB1)["outcome"] == "stale_tracker_released"
    assert snapshot(rid) == before


@pytest.mark.parametrize("corruption", ["request-null", "request-other", "generation-other", "job-other", "event-other", "no-event"])
def test_history_must_connect_exact_request_generation_job_and_event(isolated, corruption):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=True)
    with db.get_connection() as conn:
        where = "WHERE generation_id=? AND event='generation_job_anchored'"
        if corruption == "no-event":
            conn.execute("DELETE FROM generation_event " + where, (GEN,))
        else:
            column, value = {
                "request-null": ("request_id", None), "request-other": ("request_id", "other-rid"),
                "generation-other": ("generation_id", "other-gen"), "job-other": ("job_id", JOB2),
                "event-other": ("event", "generation_status_changed"),
            }[corruption]
            conn.execute(f"UPDATE generation_event SET {column}=? " + where, (value, GEN))
    before = snapshot(rid)
    assert reconcile(rid)["outcome"] == "rejected"
    assert snapshot(rid) == before


def test_wrong_account_route_is_403_and_unchanged(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    before = snapshot(rid)
    with pytest.raises(HTTPException) as error:
        immediate(routes.reconcile_gen_request(rid, FulfillIn(job={"id": JOB1, "status": "failed"}), request("other@example.invalid")))
    assert error.value.status_code == 403
    assert snapshot(rid) == before


def test_release_does_not_call_journal_or_change_domain_rows(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=True, cleanup_failure=True, monkeypatch=monkeypatch)
    before = snapshot(rid)
    journal_before = jobs_in_journal()
    record = Mock(side_effect=AssertionError("Historical release must not add an event"))
    monkeypatch.setattr(event_journal, "record_generation_event", record)
    for _ in range(2):
        assert reconcile(rid)["outcome"] == "stale_tracker_released"
        assert snapshot(rid) == before
        assert jobs_in_journal() == journal_before
    record.assert_not_called()


@pytest.fixture
def agent(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "agent"))
    monkeypatch.setattr(socket.socket, "connect", Mock(side_effect=AssertionError("Real network forbidden")))
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("synthetic_e3_agent", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_run_cli_json", Mock(side_effect=AssertionError("Real CLI forbidden")))
    monkeypatch.setattr(module, "_report_reconcile", Mock(side_effect=AssertionError("Real report forbidden")))
    assert Path(module._agent_state_path()).resolve().is_relative_to(tmp_path.resolve())
    return module


@pytest.mark.parametrize("outcome", ["target_retired", "stale_tracker_released"])
@pytest.mark.parametrize("released", [JOB1, JOB2, None])
def test_agent_accepts_only_exact_released_job(agent, monkeypatch, outcome, released):
    body = {"outcome": outcome, "released_job_id": released, "asset_saved": False}
    monkeypatch.setattr(agent, "_report_reconcile", Mock(return_value=(200, body)))
    result = agent._finalize_tracked_job("http://synthetic.invalid", "sentinel", "mock-cli", {"rid": "rid", "job_id": JOB1},
                                         {"id": JOB1, "status": "failed"}, detailed=True)
    assert result is (released == JOB1)


def test_agent_rejects_detail_for_different_job_before_report(agent, monkeypatch):
    report = Mock(return_value=(200, {"outcome": "applied", "asset_saved": True}))
    monkeypatch.setattr(agent, "_report_reconcile", report)
    assert agent._finalize_tracked_job("http://synthetic.invalid", "sentinel", "mock-cli", {"rid": "rid", "job_id": JOB1},
                                        {"id": JOB2, "status": "failed"}, detailed=True) is False
    report.assert_not_called()


def test_agent_release_removes_one_job_from_memory_and_sqlite_only(agent, monkeypatch):
    server = "http://synthetic.invalid"
    active = {job: {"rid": "same-rid", "job_id": job, "expected_image_inputs": 0,
                    "next_direct_check": 0 if job == JOB1 else agent.time.monotonic() + 3600,
                    "deadline": agent.time.monotonic() + 3600} for job in [JOB1, JOB2]}
    for tracked in active.values():
        agent._tracked_save(server, ACCOUNT, tracked)
    monkeypatch.setattr(agent, "_run_cli_json", Mock(return_value=({"id": JOB1, "status": "failed"}, None)))
    monkeypatch.setattr(agent, "_report_reconcile", Mock(return_value=(200, {"outcome": "stale_tracker_released", "released_job_id": JOB1, "asset_saved": False})))
    assert agent._poll_active_jobs(server, "sentinel", "mock-cli", active, ACCOUNT) == 1
    assert set(active) == {JOB2}
    assert set(agent._tracked_load(server, ACCOUNT)) == {JOB2}


@pytest.mark.parametrize("provider_status,with_asset,wanted_gen,wanted_request", [
    ("failed", False, "failed", "failed"),
    ("completed", True, "done", "done"),
    ("completed", False, "running", "verifying"),
])
def test_retired_restore_pairs_and_actual_reconcile_candidate(isolated, provider_status, with_asset, wanted_gen, wanted_request):
    rid = isolated.rid
    anchor(rid, JOB1)
    if with_asset:
        with db.get_connection() as conn:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('synthetic-asset',?,'image','/media/synthetic.png')", (GEN,))
    remove_main(purge=False)
    outcome = reconcile(rid, status=provider_status)
    assert outcome["outcome"] == "target_retired"
    assert outcome["request_status"] == "canceled"
    terminal = json.loads(snapshot(rid)["trash"]["payload"])["provider_terminal"]
    assert terminal["request_id"] == rid and terminal["job_id"] == JOB1
    assert terminal["asset_saved"] is with_asset
    assert trash.restore_from_trash(GEN, UID) is True
    after = snapshot(rid)
    assert after["generation"]["status"] == wanted_gen
    assert after["request"]["status"] == wanted_request
    candidates = repo.list_reconcile_candidates(ACCOUNT)
    if wanted_request == "verifying":
        assert candidates == [{"rid": rid, "gen_id": GEN, "job_id": JOB1}]
        assert after["generation"]["error"] == repo.VERIFYING_NOTE
        assert after["request"]["terminal_at"] is None
    else:
        assert candidates == []


@pytest.mark.parametrize("status", ["done", "failed", "canceled"])
def test_retire_and_restore_preserve_preexisting_terminal_requests(isolated, status):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status=?,error='original terminal reason',terminal_at='2026-09-17 01:02:03' WHERE id=?", (status, rid))
    before = snapshot(rid)
    result = reconcile(rid)
    assert result["outcome"] == "target_retired"
    assert result["request_status"] == status
    assert result["request_changed"] is False and result["marker_recorded"] is False
    assert snapshot(rid) == before
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == before["request"]
    assert snapshot(rid)["generation"]["status"] == "running"


def test_other_active_request_prevents_retired_restore_revival(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    assert reconcile(rid, status="completed")["outcome"] == "target_retired"
    other_rid = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic"})
    retired_before = snapshot(rid)["request"]
    other_before = snapshot(other_rid)["request"]
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == retired_before
    assert snapshot(other_rid)["request"] == other_before
    assert snapshot(rid)["generation"]["error"] is None
    assert repo.list_reconcile_candidates(ACCOUNT) == []


@pytest.mark.parametrize("field", ["request_id", "job_id"])
def test_restore_requires_exact_retired_marker(isolated, field):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    assert reconcile(rid)["outcome"] == "target_retired"
    with trash._with_trash() as conn:
        payload = json.loads(conn.execute("SELECT payload FROM trash.trashed WHERE id=?", (GEN,)).fetchone()[0])
        payload["provider_terminal"][field] = "wrong-marker"
        conn.execute("UPDATE trash.trashed SET payload=? WHERE id=?", (json.dumps(payload), GEN))
    before = snapshot(rid)["request"]
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == before
    assert snapshot(rid)["generation"]["status"] == "running"


@pytest.mark.parametrize("failure_at", ["request", "payload"])
def test_retired_payload_and_request_roll_back_together(isolated, failure_at):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    with trash._with_trash() as conn:
        if failure_at == "request":
            conn.execute("CREATE TRIGGER abort_e3_retire BEFORE UPDATE ON gen_request WHEN NEW.status='canceled' "
                         "BEGIN SELECT RAISE(ABORT, 'synthetic retire rollback'); END")
        else:
            conn.execute("CREATE TRIGGER trash.abort_e3_retire BEFORE UPDATE OF payload ON trashed "
                         "BEGIN SELECT RAISE(ABORT, 'synthetic retire rollback'); END")
    before = snapshot(rid)
    with pytest.raises(sqlite3.IntegrityError, match="synthetic retire rollback"):
        reconcile(rid)
    assert snapshot(rid) == before


@pytest.mark.parametrize("status", ["running", "unknown-synthetic", "action_required"])
def test_nonterminal_keeps_existing_not_ready_path(isolated, monkeypatch, status):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    resolution = Mock(side_effect=AssertionError("Nonterminal must not use retired resolution"))
    monkeypatch.setattr(repo, "resolve_missing_target", resolution, raising=False)
    assert reconcile(rid, status=status)["outcome"] == "not_ready"
    resolution.assert_not_called()


def test_force_fail_keeps_existing_rejected_path(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    resolution = Mock(side_effect=AssertionError("Force fail must not use retired resolution"))
    monkeypatch.setattr(repo, "resolve_missing_target", resolution, raising=False)
    before = snapshot(rid)
    assert reconcile(rid, force_fail_reason="Synthetic force failure")["outcome"] == "rejected"
    assert snapshot(rid) == before
    resolution.assert_not_called()


def test_unverified_success_without_result_url_is_rejected_without_request_write(isolated):
    """Intentional change: the old missing-target path recorded verifying/not_ready."""
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    before = snapshot(rid)
    broadcasts_before = usecase.manager.broadcast.await_count
    assert reconcile(rid, JOB2, status="completed")["outcome"] == "rejected"
    assert snapshot(rid) == before
    assert usecase.manager.broadcast.await_count == broadcasts_before


def test_presubmit_deleted_request_restore_remains_unchanged(isolated):
    rid = isolated.rid
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='pending' WHERE id=?", (rid,))
    remove_main(purge=False)
    before = snapshot(rid)["request"]
    assert before["status"] == "canceled" and before["error"] == trash._DELETED_REQUEST_NOTE
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == before
    assert snapshot(rid)["generation"]["status"] == "failed"


@pytest.mark.parametrize("purged", [False, True])
def test_actual_server_response_remains_unaccepted_by_old_agent(isolated, agent, monkeypatch, purged):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=purged)
    body = reconcile(rid, status="failed")  # Actual server route/repo response, not a fabricated outcome.
    assert body["outcome"] == ("stale_tracker_released" if purged else "target_retired")
    status, kind = 200, "failure"
    legacy_finalized = bool(
        status == 200 and body.get("outcome") in {"applied", "already_final_same_job"}
        and (kind == "failure" or bool(body.get("asset_saved")))
    )
    assert legacy_finalized is False
    monkeypatch.setattr(agent, "_report_reconcile", Mock(return_value=(status, body)))
    assert agent._finalize_tracked_job("http://synthetic.invalid", "sentinel", "mock-cli", {"rid": rid, "job_id": JOB1},
                                      {"id": JOB1, "status": "failed"}, detailed=True) is True


def resolve_target(rid, *, gen_id=GEN, owner=ACCOUNT, job_id=JOB1):
    return repo.resolve_missing_target(gen_id, rid, job_id, owner, provider_kind="failure")


@pytest.mark.parametrize("pool_enabled", [False, True])
def test_conn_helper_does_not_commit_callers_transaction(isolated, monkeypatch, pool_enabled):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", pool_enabled)
    before = snapshot(rid)
    with pytest.raises(RuntimeError, match="synthetic after helper"):
        with trash._with_trash() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("UPDATE gen_request SET error='synthetic transaction marker' WHERE id=?", (rid,))
            conn.execute("UPDATE trash.trashed SET payload='{}' WHERE id=?", (GEN,))
            assert event_journal.has_anchored_job_event(conn, generation_id=GEN, request_id=rid, job_id=JOB1)
            assert conn.in_transaction
            raise RuntimeError("synthetic after helper")
    assert snapshot(rid) == before
    db.flush_pool()


def test_resolution_uses_one_connection_and_locks_before_authority_reads(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=True)
    real_connection = trash.get_connection
    calls, statements = [], []
    @contextmanager
    def counted_connection():
        calls.append(True)
        with real_connection() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)
    monkeypatch.setattr(trash, "get_connection", counted_connection)
    monkeypatch.setattr(event_journal, "get_connection", Mock(side_effect=AssertionError("Nested connection forbidden")))
    assert resolve_target(rid)["decision"] == "tracker_released"
    assert len(calls) == 1
    begin = next(index for index, statement in enumerate(statements) if statement.upper().startswith("BEGIN IMMEDIATE"))
    request_read = next(index for index, statement in enumerate(statements) if "SELECT" in statement.upper() and "FROM gen_request" in statement)
    assert begin < request_read
    assert "ROLLBACK" in statements


@pytest.mark.parametrize("mismatch", ["owner", "gen", "request"])
def test_repo_rechecks_owner_request_and_generation_in_same_transaction(isolated, mismatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    before = snapshot(rid)
    result = resolve_target("absent" if mismatch == "request" else rid,
                            gen_id="other-gen" if mismatch == "gen" else GEN,
                            owner="other@example.invalid" if mismatch == "owner" else ACCOUNT)
    assert result["decision"] == "unverified"
    assert snapshot(rid) == before


@pytest.mark.parametrize("changed", [False, True])
def test_main_restored_between_read_and_resolution_rechecks_conflict(isolated, monkeypatch, changed):
    rid = isolated.rid
    anchor(rid, JOB1)
    if changed:
        anchor(rid, JOB2)
    remove_main(purge=False)
    actual_resolution = repo.resolve_missing_target
    restored_snapshot = []
    def restore_then_resolve(*args, **kwargs):
        assert trash.restore_from_trash(GEN, UID)
        restored_snapshot.append(snapshot(rid))
        return actual_resolution(*args, **kwargs)
    monkeypatch.setattr(repo, "resolve_missing_target", restore_then_resolve)
    result = reconcile(rid, status="completed")
    assert result["outcome"] == ("conflict" if changed else "not_ready")
    if changed:
        assert snapshot(rid) == restored_snapshot[0]
        assert result["job_id"] == JOB2
    else:
        assert snapshot(rid)["request"]["status"] == "verifying"


def test_first_marker_is_preserved_across_duplicate_and_other_request_reports(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    other = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic"})
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='tracking' WHERE id=?", (other,))
    remove_main(purge=False)
    first = reconcile(rid)
    assert first["marker_recorded"] is True and first["request_changed"] is True
    before = snapshot(rid)
    repeated = reconcile(rid)
    assert repeated["marker_recorded"] is True and repeated["request_changed"] is False
    assert snapshot(rid) == before
    second = reconcile(other)
    assert second["marker_recorded"] is False and second["request_changed"] is True
    assert snapshot(rid)["trash"]["payload"] == before["trash"]["payload"]
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"]["status"] == "failed"
    assert snapshot(other)["request"]["status"] == "canceled"


def test_marker_restore_precedes_legacy_deleted_note_without_changing_other_request(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    deleted_rid = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic"})
    remove_main(purge=False)
    other_before = snapshot(deleted_rid)["request"]
    assert other_before["error"] == trash._DELETED_REQUEST_NOTE
    assert reconcile(rid, status="completed")["outcome"] == "target_retired"
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["generation"]["status"] == "running"
    assert snapshot(rid)["request"]["status"] == "verifying"
    assert snapshot(deleted_rid)["request"] == other_before


@pytest.mark.parametrize("bad_marker", ["bad", [], {}, {"kind": "success"}, {"request_id": "rid", "kind": "unknown"}])
def test_malformed_marker_keeps_legacy_restore_behavior(isolated, bad_marker):
    rid = isolated.rid
    anchor(rid, JOB1)
    original = snapshot(rid)
    remove_main(purge=False)
    with trash._with_trash() as conn:
        payload = json.loads(conn.execute("SELECT payload FROM trash.trashed WHERE id=?", (GEN,)).fetchone()[0])
        payload["provider_terminal"] = bad_marker
        conn.execute("UPDATE trash.trashed SET payload=? WHERE id=?", (json.dumps(payload), GEN))
    before_request = snapshot(rid)["request"]
    assert trash.restore_from_trash(GEN, UID)
    after = snapshot(rid)
    assert after["generation"] == original["generation"]
    assert after["request"] == before_request


@pytest.mark.parametrize("change", ["done", "error-cleared"])
def test_marker_no_longer_owns_request_cannot_change_restored_generation(isolated, change):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    assert reconcile(rid, status="completed")["outcome"] == "target_retired"
    with db.get_connection() as conn:
        if change == "done":
            conn.execute("UPDATE gen_request SET status='done' WHERE id=?", (rid,))
        else:
            conn.execute("UPDATE gen_request SET error=NULL WHERE id=?", (rid,))
    before = snapshot(rid)["request"]
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == before
    assert snapshot(rid)["generation"]["error"] is None


def test_live_main_without_result_url_preserves_existing_waiting_behavior(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    resolution = Mock(side_effect=AssertionError("Live target must bypass retired resolution"))
    monkeypatch.setattr(repo, "resolve_missing_target", resolution, raising=False)
    assert reconcile(rid, status="completed")["outcome"] == "not_ready"
    assert snapshot(rid)["request"]["status"] == "verifying"
    assert snapshot(rid)["request"]["error"] == repo.VERIFYING_NOTE
    # Existing set_status clears errors on running; the WS payload carries the note.
    assert snapshot(rid)["generation"]["error"] is None
    assert usecase.manager.broadcast.await_args.args[0]["error"] == repo.VERIFYING_NOTE
    assert usecase.manager.broadcast.await_count >= 1
    resolution.assert_not_called()


@pytest.mark.parametrize("job_id", [None, "", " "])
def test_empty_job_id_missing_terminal_is_rejected_without_transaction(isolated, monkeypatch, job_id):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    before = snapshot(rid)
    resolution = Mock(side_effect=AssertionError("Empty job has no authority transaction"))
    monkeypatch.setattr(repo, "resolve_missing_target", resolution, raising=False)
    assert reconcile(rid, job_id, status="completed")["outcome"] == "rejected"
    assert snapshot(rid) == before
    resolution.assert_not_called()


def test_provider_result_url_cannot_bypass_trash_job_conflict(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    before = snapshot(rid)
    assert reconcile(rid, JOB2, status="completed", job_extra={"result_url": "https://synthetic.invalid/result.png"})["outcome"] == "rejected"
    assert snapshot(rid) == before


@pytest.mark.parametrize("provider_status,with_asset", [("failed", False), ("completed", False), ("completed", True)])
def test_marker_restore_never_updates_prior_terminal_request(isolated, provider_status, with_asset):
    rid = isolated.rid
    anchor(rid, JOB1)
    prior = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic"})
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='done',error='prior synthetic reason',terminal_at='2026-09-16 12:34:56' WHERE id=?", (prior,))
        if with_asset:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('synthetic-prior-asset',?,'image','/media/synthetic.png')", (GEN,))
    prior_before = snapshot(prior)["request"]
    remove_main(purge=False)
    assert reconcile(rid, status=provider_status)["outcome"] == "target_retired"
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(prior)["request"] == prior_before
    assert snapshot(rid)["request"]["status"] == ("failed" if provider_status == "failed" else "done" if with_asset else "verifying")


def test_changed_terminal_kind_cannot_replace_first_marker(isolated):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    assert reconcile(rid, status="failed")["marker_recorded"] is True
    before = snapshot(rid)
    second = reconcile(rid, status="completed")
    assert second["outcome"] == "target_retired"
    assert second["request_changed"] is False and second["marker_recorded"] is False
    assert snapshot(rid) == before
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["generation"]["status"] == "failed"


@pytest.mark.parametrize("unsafe_job", ["synthetic/job", "https://synthetic.invalid/job"])
def test_filtered_history_job_is_conservative_false_negative(isolated, unsafe_job):
    rid = isolated.rid
    anchor(rid, unsafe_job)
    anchored = [event for event in jobs_in_journal() if event["event"] == "generation_job_anchored"]
    assert len(anchored) == 1 and anchored[0]["job_id"] is None
    remove_main(purge=True)
    before = snapshot(rid)
    journal_before = jobs_in_journal()
    assert reconcile(rid, unsafe_job)["outcome"] == "rejected"
    assert snapshot(rid) == before
    assert jobs_in_journal() == journal_before


@pytest.mark.parametrize("payload_path,has_asset", [
    ("https://synthetic.invalid/stored.png", True),
    ("/media/synthetic.png", True),
    ("/media/missing-synthetic.png", False),
    ("", False),
    (None, False),
])
def test_retire_assets_use_only_payload_and_local_completeness(isolated, payload_path, has_asset):
    rid = isolated.rid
    anchor(rid, JOB1)
    if payload_path is not None:
        with db.get_connection() as conn:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('synthetic-owned-asset',?,'image',?)", (GEN, payload_path))
    remove_main(purge=False)
    before_assets = json.loads(snapshot(rid)["trash"]["payload"])["assets"]
    media_cache.local_media_exists.reset_mock()
    result = reconcile(rid, status="completed", job_extra={"result_url": "https://synthetic.invalid/new-provider.png"})
    assert result["outcome"] == "target_retired" and result["asset_saved"] is False
    payload = json.loads(snapshot(rid)["trash"]["payload"])
    assert payload["assets"] == before_assets  # Provider URL is never appended/downloaded.
    assert payload["provider_terminal"]["asset_saved"] is has_asset
    assert trash.restore_from_trash(GEN, UID)
    after = snapshot(rid)
    assert after["generation"]["status"] == ("done" if has_asset else "running")
    assert after["request"]["status"] == ("done" if has_asset else "verifying")
    with db.get_connection() as conn:
        assets = [dict(row) for row in conn.execute("SELECT * FROM asset WHERE generation_id=?", (GEN,))]
    assert assets == before_assets
    if payload_path and payload_path.startswith("/media/"):
        assert all(call.args == (payload_path,) for call in media_cache.local_media_exists.call_args_list)
        assert media_cache.local_media_exists.call_count >= 1
    else:
        media_cache.local_media_exists.assert_not_called()


def test_retired_journal_is_after_commit_and_best_effort(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    observations = []
    def inspect_committed_then_fail(*args, **kwargs):
        with db.get_connection() as conn:
            assert not conn.in_transaction
        observations.append(snapshot(rid))
        raise OSError("Synthetic post-commit journal failure")
    monkeypatch.setattr(event_journal, "record_generation_event", inspect_committed_then_fail)
    result = reconcile(rid)
    assert result["outcome"] == "target_retired"
    assert len(observations) == 1
    assert observations[0]["request"]["status"] == "canceled"
    assert json.loads(observations[0]["trash"]["payload"])["provider_terminal"]["request_id"] == rid


@pytest.mark.parametrize("trash_job", [None, ""])
def test_trash_empty_current_job_never_uses_historical_anchor(isolated, trash_job):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    with trash._with_trash() as conn:
        payload = json.loads(conn.execute("SELECT payload FROM trash.trashed WHERE id=?", (GEN,)).fetchone()[0])
        payload["generation"]["job_id"] = trash_job
        conn.execute("UPDATE trash.trashed SET job_id=?,payload=? WHERE id=?", (trash_job, json.dumps(payload), GEN))
    before = snapshot(rid)
    journal_before = jobs_in_journal()
    assert reconcile(rid)["outcome"] == "rejected"
    assert snapshot(rid) == before and jobs_in_journal() == journal_before


@pytest.mark.parametrize("purged", [False, True])
def test_observation_failure_does_not_change_missing_target_ack(isolated, monkeypatch, purged):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=purged)
    monkeypatch.setattr(usecase, "log_event", Mock(side_effect=OSError("Synthetic observation failure")))
    assert reconcile(rid)["outcome"] == ("stale_tracker_released" if purged else "target_retired")


def test_verifying_note_keeps_public_facade_alias():
    from app.repo import _common, generations
    assert repo.VERIFYING_NOTE == generations.VERIFYING_NOTE == trash.VERIFYING_NOTE == _common.VERIFYING_NOTE


@pytest.mark.parametrize("outcome", ["target_retired", "stale_tracker_released"])
@pytest.mark.parametrize("status", [400, 401, 409, 500, 503])
def test_agent_rejects_terminal_release_when_http_is_not_200(agent, monkeypatch, outcome, status):
    report = Mock(return_value=(status, {"outcome": outcome, "released_job_id": JOB1, "asset_saved": False}))
    monkeypatch.setattr(agent, "_report_reconcile", report)
    assert agent._finalize_tracked_job("http://synthetic.invalid", "sentinel", "mock-cli", {"rid": "rid", "job_id": JOB1},
                                      {"id": JOB1, "status": "failed"}, detailed=True) is False
    report.assert_called_once()


@pytest.mark.parametrize("body", [None, [], "target_retired", 0, True])
@pytest.mark.parametrize("status", [200, 500])
def test_agent_rejects_nondict_body_without_reading_release_fields(agent, monkeypatch, status, body):
    monkeypatch.setattr(agent, "_report_reconcile", Mock(return_value=(status, body)))
    assert agent._finalize_tracked_job("http://synthetic.invalid", "sentinel", "mock-cli", {"rid": "rid", "job_id": JOB1},
                                      {"id": JOB1, "status": "failed"}, detailed=True) is False


@pytest.mark.parametrize("with_asset", [False, True])
def test_target_present_conflict_uses_actual_rechecked_asset_flag(isolated, monkeypatch, with_asset):
    rid = isolated.rid
    anchor(rid, JOB1)
    anchor(rid, JOB2)
    if with_asset:
        with db.get_connection() as conn:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('synthetic-conflict-asset',?,'image','/media/synthetic.png')", (GEN,))
    remove_main(purge=False)
    actual_resolution = repo.resolve_missing_target
    observed = []

    def restore_then_resolve(*args, **kwargs):
        assert trash.restore_from_trash(GEN, UID)
        before = snapshot(rid)
        result = actual_resolution(*args, **kwargs)
        assert result["decision"] == "target_present"
        assert set(result["current"]) == {"job_id", "status", "assets"}
        assert bool(result["current"]["assets"]) is with_asset
        observed.append(before)
        return result

    monkeypatch.setattr(repo, "resolve_missing_target", restore_then_resolve)
    response = reconcile(rid, status="completed")
    assert response["outcome"] == "conflict" and response["job_id"] == JOB2
    assert response["asset_saved"] is with_asset
    assert response["status"] == observed[0]["generation"]["status"]
    assert snapshot(rid) == observed[0]


@pytest.mark.parametrize("event,label", [
    ("generation_target_retired", "종료된 대상 작업 종결"),
    ("generation_tracker_released", "과거 추적 해제"),
    ("generation_target_unverified", "대상 확인 불가"),
])
def test_missing_target_info_events_are_visible_in_operator_viewer(tmp_path, monkeypatch, event, label):
    monkeypatch.setenv("CONTENT_HUB_LOG_DIR", str(tmp_path / "logs"))
    path = Path(__file__).resolve().parents[2] / "tools" / "log_viewer.py"
    spec = importlib.util.spec_from_file_location("synthetic_e3_log_viewer", path)
    viewer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(viewer)
    rendered = viewer.format_event({"event": event, "level": "INFO", "ts": "2026-09-17T00:00:00Z",
                                    "generation_id": GEN, "request_id": "synthetic-rid", "job_id": JOB1})
    assert rendered is not None
    assert label in rendered and GEN in rendered and JOB1 in rendered


@pytest.mark.parametrize("bad_marker", ["bad", [], {}, False, {"kind": "success"}])
def test_retire_does_not_overwrite_a_present_malformed_marker(isolated, bad_marker):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=False)
    with trash._with_trash() as conn:
        row = conn.execute("SELECT payload FROM trash.trashed WHERE id=?", (GEN,)).fetchone()
        payload = json.loads(row[0])
        payload["provider_terminal"] = bad_marker
        conn.execute("UPDATE trash.trashed SET payload=? WHERE id=?", (json.dumps(payload), GEN))
        conn.commit()
    before_payload = snapshot(rid)["trash"]["payload"]
    result = reconcile(rid, status="failed")
    assert result["outcome"] == "target_retired"
    assert result["request_changed"] is True and result["marker_recorded"] is False
    retired = snapshot(rid)
    assert retired["request"]["status"] == "canceled"
    assert retired["request"]["error"] == trash._RETIRED_REQUEST_NOTE
    assert retired["trash"]["payload"] == before_payload
    assert trash.restore_from_trash(GEN, UID)
    assert snapshot(rid)["request"] == retired["request"]


def test_legacy_trash_job_backfill_converges_without_repeated_update(isolated):
    anchor(isolated.rid, JOB1)
    remove_main(purge=False)
    with trash._with_trash() as conn:
        conn.execute("UPDATE trash.trashed SET job_id=NULL WHERE id=?", (GEN,))
        conn.execute("INSERT INTO trash.trashed(id,trashed_at,payload) VALUES('synthetic-local-only','2026-09-17',?)",
                     (json.dumps({"generation": {"job_id": None}}),))
        conn.commit()
        start = conn.total_changes
        trash._ensure_trash_job_id_col(conn)
        assert conn.total_changes - start == 1
        conn.commit()
        assert conn.execute("SELECT job_id FROM trash.trashed WHERE id=?", (GEN,)).fetchone()[0] == JOB1
        statements = []
        conn.set_trace_callback(statements.append)
        try:
            start = conn.total_changes
            trash._ensure_trash_job_id_col(conn)
            assert conn.total_changes == start
            assert not any(sql.lstrip().upper().startswith("UPDATE") for sql in statements)
        finally:
            conn.set_trace_callback(None)


def test_historical_tracker_release_leaves_cleanup_to_startup_reconcile(isolated, monkeypatch):
    rid = isolated.rid
    anchor(rid, JOB1)
    remove_main(purge=True, cleanup_failure=True, monkeypatch=monkeypatch)
    before = snapshot(rid)
    assert before["request"]["status"] == "tracking"
    result = reconcile(rid, status="failed")
    assert result["outcome"] == "stale_tracker_released" and result["request_changed"] is False
    assert snapshot(rid) == before
    assert trash.reconcile_with_main() == 0
    after = snapshot(rid)
    assert after["request"]["status"] == "canceled"
    assert after["request"]["error"] == trash._DELETED_REQUEST_NOTE
    assert after["request"]["lease_owner"] is None and after["request"]["lease_expires_at"] is None
    assert after["generation"] is None and after["trash"] is None
    assert trash.reconcile_with_main() == 0
    assert snapshot(rid) == after
