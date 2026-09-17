"""Post-submit local I/O failures must preserve paid jobs without another create.

All CLI/HTTP boundaries are synthetic. SQLite lives only under pytest tmp_path.
The new retry limit is per due job in _poll_active_jobs; existing outbox replay
has its own budget and is intentionally not counted as the same attempt.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sqlite3
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlsplit

import pytest


SERVER = "http://synthetic.invalid:9"
ACCOUNT = "synthetic@example.invalid"
TOKEN = "synthetic-token-sentinel"
JOB_IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]


class InlineExecutor:
    """Exercise the real harvest loop deterministically without worker threads."""

    def __init__(self, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def submit(self, function, *args):
        future = Future()
        try:
            future.set_result(function(*args))
        except Exception as exc:
            future.set_exception(exc)
        return future


@pytest.fixture
def harness(tmp_path, monkeypatch):
    path = Path(__file__).resolve().parents[2] / "agent_push.py"
    spec = importlib.util.spec_from_file_location("agent_post_submit_target", path)
    agent = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(agent)
    state_path = tmp_path / "agent-state.db"
    assert state_path.resolve().is_relative_to(tmp_path.resolve())
    monkeypatch.setattr(agent, "_agent_state_path", lambda: str(state_path))
    clock = SimpleNamespace(now=100.0)
    agent.time = SimpleNamespace(monotonic=lambda: clock.now, time=lambda: 1000.0 + clock.now)
    agent.ThreadPoolExecutor = InlineExecutor
    agent._cycle_account_email = lambda cli: ACCOUNT
    agent._load_upload_cache = lambda account: {}
    agent._allowed_params = lambda cli, model: set()
    agent._ensure_request_workspace = lambda cli, workspace: ("synthetic-workspace", None)
    agent._retry_pause = Mock()
    agent._print_cli_issue = Mock()
    agent._resolve_refs_for = lambda server, token, requests, cache: (cache, [])
    agent._poll_active_jobs_original = agent._poll_active_jobs
    agent._poll_active_jobs = Mock(return_value=0)
    agent._cli_json = Mock(side_effect=AssertionError("Unmocked CLI boundary"))
    requests = [{"id": f"rid-{i}", "model": "nano-banana", "references": [],
                 "prompt": "synthetic prompt", "claim_phase": "claimed"} for i in range(2)]
    creates = []

    def cli_run(cli, *args, **kwargs):
        assert args[:2] == ("generate", "create")
        creates.append(args)
        return [JOB_IDS[len(creates) - 1]], None

    agent._run_cli_json = Mock(side_effect=cli_run)
    calls = []
    replies = {"anchor": (200, {"applied": True})}

    def open_response(request, **kwargs):
        assert urlsplit(request.full_url).hostname == "synthetic.invalid"
        action = urlsplit(request.full_url).path.rsplit("/", 1)[-1]
        calls.append(action)
        status, body = replies.get(action, (200, {"applied": True, "outcome": "applied", "asset_saved": True}))
        response = io.BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode())
        response.status = status
        return response

    monkeypatch.setattr(agent.urllib.request, "urlopen", open_response)

    def execute(count=1):
        agent._claim_pending = Mock(side_effect=[(200, requests[:count]), (200, [])])
        return agent.execute_pending(SERVER, TOKEN, "synthetic-cli")

    def active():
        return agent._runtime_active(SERVER, ACCOUNT)

    def poll(*, budget_end=None):
        return agent._poll_active_jobs_original(SERVER, TOKEN, "synthetic-cli", active(), ACCOUNT, budget_end)

    return SimpleNamespace(agent=agent, clock=clock, calls=calls, replies=replies,
                           creates=creates, execute=execute, active=active, poll=poll, path=state_path)


@pytest.mark.parametrize("fault", ["normal", "outbox_add_sqlite", "outbox_add_os", "outbox_remove_sqlite",
                                  "outbox_remove_os", "anchor_json", "anchor_utf8", "disk_and_ack"])
def test_known_job_survives_post_submit_fault_and_reanchors_same_id(harness, monkeypatch, fault):
    h, agent = harness, harness.agent
    original_add, original_remove = agent._outbox_add, agent._outbox_remove
    if fault.startswith("outbox_add") or fault == "disk_and_ack":
        error = OSError if fault.endswith("os") else sqlite3.OperationalError
        monkeypatch.setattr(agent, "_outbox_add", Mock(side_effect=error("synthetic local failure")))
    if fault.startswith("outbox_remove"):
        error = OSError if fault.endswith("os") else sqlite3.OperationalError
        monkeypatch.setattr(agent, "_outbox_remove", Mock(side_effect=error("synthetic local failure")))
    if fault in {"anchor_json", "anchor_utf8", "disk_and_ack"}:
        h.replies["anchor"] = (200, b"{" if fault == "anchor_json" else b"\xff") if fault != "disk_and_ack" else (503, {})

    assert h.execute() == 1
    assert list(h.active()) == [JOB_IDS[0]]
    assert len(h.creates) == 1
    assert "fail" not in h.calls and "recovery-required" not in h.calls
    pending = fault in {"outbox_remove_sqlite", "outbox_remove_os", "anchor_json", "anchor_utf8", "disk_and_ack"}
    assert bool(h.active()[JOB_IDS[0]].get("anchor_pending")) is pending
    assert len(agent._tracked_load(SERVER, ACCOUNT)) == 1

    monkeypatch.setattr(agent, "_outbox_add", original_add)
    monkeypatch.setattr(agent, "_outbox_remove", original_remove)
    h.replies["anchor"] = (200, {"applied": True})
    before = h.calls.count("anchor")
    agent._run_cli_json = Mock(return_value=({"id": JOB_IDS[0], "status": "processing"}, None))
    assert h.poll() == 0
    assert h.calls.count("anchor") - before == int(pending)
    assert not h.active()[JOB_IDS[0]].get("anchor_pending")
    assert agent._outbox_load(SERVER, ACCOUNT) == []
    assert len(h.creates) == 1
    assert agent._run_cli_json.call_args.args[1:3] == ("generate", "get")


@pytest.mark.parametrize("error", [sqlite3.OperationalError, OSError])
def test_harvest_registers_all_jobs_before_failed_save_and_retries(harness, monkeypatch, error):
    h, agent = harness, harness.agent
    original_save = agent._tracked_save

    def fail_save(server, account, tracked):
        assert h.active()[tracked["job_id"]] is tracked
        raise error("synthetic write failure")

    save = Mock(side_effect=fail_save)
    monkeypatch.setattr(agent, "_tracked_save", save)
    assert h.execute(2) == 2
    assert list(h.active()) == JOB_IDS
    assert all(item.get("persist_pending") for item in h.active().values())
    assert save.call_count == 2
    assert agent._tracked_load(SERVER, ACCOUNT) == {}
    assert "fail" not in h.calls and "recovery-required" not in h.calls
    monkeypatch.setattr(agent, "_tracked_save", original_save)
    agent._run_cli_json = Mock(side_effect=lambda cli, _generate, _get, jid, **kw: ({"id": jid, "status": "processing"}, None))
    assert h.poll() == 0
    assert set(agent._tracked_load(SERVER, ACCOUNT)) == set(JOB_IDS)
    assert all(not item.get("persist_pending") for item in h.active().values())
    assert len(h.creates) == 2


@pytest.mark.parametrize("branch", ["lookup_failure", "id_mismatch", "processing", "terminal_not_ready"])
@pytest.mark.parametrize("error", [sqlite3.OperationalError, OSError])
@pytest.mark.parametrize("already_pending", [False, True])
def test_each_poll_checkpoint_survives_save_failure_once_per_due_job(harness, monkeypatch, branch, error, already_pending):
    h, agent = harness, harness.agent
    assert h.execute(2) == 2
    for tracked in h.active().values():
        tracked["persist_pending"] = already_pending
    save = Mock(side_effect=error("synthetic write failure"))
    monkeypatch.setattr(agent, "_tracked_save", save)

    def lookup(cli, _generate, _get, jid, **kwargs):
        if branch == "lookup_failure":
            return None, "synthetic lookup failure"
        if branch == "id_mismatch":
            return {"id": "another-job", "status": "processing"}, None
        status = "completed" if branch == "terminal_not_ready" else "processing"
        return {"id": jid, "status": status}, None

    agent._run_cli_json = Mock(side_effect=lookup)
    h.replies["reconcile"] = (200, {"outcome": "not_ready", "asset_saved": False})
    assert h.poll() == 0
    assert agent._run_cli_json.call_count == 2
    assert save.call_count == 2  # A failed pending retry must not be repeated at the checkpoint.
    assert all(item.get("persist_pending") for item in h.active().values())
    assert list(h.active()) == JOB_IDS
    assert "fail" not in h.calls


@pytest.mark.parametrize("error", [sqlite3.OperationalError, OSError])
def test_terminal_remove_failure_does_not_stop_other_jobs_and_replay_is_idempotent(harness, monkeypatch, error):
    h, agent = harness, harness.agent
    assert h.execute(2) == 2
    original_remove = agent._tracked_remove
    remove = Mock(side_effect=error("synthetic delete failure"))
    monkeypatch.setattr(agent, "_tracked_remove", remove)
    agent._run_cli_json = Mock(side_effect=lambda cli, _generate, _get, jid, **kw: (
        {"id": jid, "status": "completed", "result_url": "https://synthetic.invalid/result"}, None))
    assert h.poll() == 2
    assert h.active() == {}
    assert remove.call_count == 2
    assert set(agent._tracked_load(SERVER, ACCOUNT)) == set(JOB_IDS)
    h.active().update(agent._tracked_load(SERVER, ACCOUNT))
    monkeypatch.setattr(agent, "_tracked_remove", original_remove)
    h.replies["reconcile"] = (200, {"outcome": "already_final_same_job", "asset_saved": True})
    assert h.poll() == 2
    assert h.active() == {} and agent._tracked_load(SERVER, ACCOUNT) == {}
    assert len(h.creates) == 2 and "fail" not in h.calls


def test_pending_retries_obey_due_time_budget_and_do_not_persist_flags(harness, monkeypatch):
    h, agent = harness, harness.agent
    assert h.execute() == 1
    tracked = h.active()[JOB_IDS[0]]
    tracked.update(anchor_pending=True, persist_pending=True)
    with agent._state_db() as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tracked_job)")}
    assert not {"anchor_pending", "persist_pending"} & columns
    assert not {"anchor_pending", "persist_pending"} & agent._tracked_load(SERVER, ACCOUNT)[JOB_IDS[0]].keys()
    save = Mock(side_effect=sqlite3.OperationalError("synthetic write failure"))
    monkeypatch.setattr(agent, "_tracked_save", save)
    h.replies["anchor"] = (503, {})
    agent._run_cli_json = Mock(return_value=({"id": JOB_IDS[0], "status": "processing"}, None))
    before = h.calls.count("anchor")
    assert h.poll(budget_end=h.clock.now) == 0
    assert h.calls.count("anchor") == before and save.call_count == 0
    assert agent._run_cli_json.call_count == 0
    assert h.poll() == 0
    assert h.calls.count("anchor") - before == 1 and save.call_count == 1
    assert tracked["anchor_pending"] and tracked["persist_pending"]
    assert h.poll() == 0  # Not due: no tight retry loop.
    assert h.calls.count("anchor") - before == 1 and save.call_count == 1
    h.clock.now += 31
    assert h.poll() == 0
    assert h.calls.count("anchor") - before == 2 and save.call_count == 2
    assert len(h.creates) == 1


def test_anchor_retry_consuming_budget_does_not_start_new_lookup(harness, monkeypatch):
    h, agent = harness, harness.agent
    assert h.execute() == 1
    h.active()[JOB_IDS[0]]["anchor_pending"] = True

    def slow_anchor(*args, **kwargs):
        assert kwargs["attempts"] == 1
        h.clock.now += 20
        return False

    monkeypatch.setattr(agent, "_anchor_with_retry", slow_anchor)
    agent._run_cli_json = Mock(side_effect=AssertionError("No budget for a new lookup"))
    assert h.poll(budget_end=h.clock.now + 2) == 0
    agent._run_cli_json.assert_not_called()
    assert h.active()[JOB_IDS[0]]["next_direct_check"] == 0.0


@pytest.mark.parametrize("body", [b"{", b"\xff"])
@pytest.mark.parametrize("caller", ["fail", "recovery-required", "reconcile"])
def test_http_decode_failures_are_unconfirmed_for_all_reporters(harness, body, caller):
    h, agent = harness, harness.agent
    h.replies[caller] = (200, body)
    if caller == "fail":
        agent._fail(SERVER, TOKEN, "rid-0", "synthetic pre-submit failure")
        assert h.calls == [caller]
    elif caller == "recovery-required":
        assert agent._require_submission_recovery(SERVER, TOKEN, "rid-0", "synthetic ambiguity") is False
        assert h.calls == [caller] * 3
    else:
        status, _ = agent._report_reconcile(SERVER, TOKEN, "rid-0", {"id": JOB_IDS[0]})
        assert status == 0 and h.calls == [caller]


@pytest.mark.parametrize("stage", ["known_pre_submit", "future_before_create", "future_during_create", "missing_job_id"])
def test_unknown_future_failure_is_recovery_but_known_validation_stays_fail(harness, monkeypatch, stage):
    h, agent = harness, harness.agent
    if stage == "known_pre_submit":
        monkeypatch.setattr(agent, "_ensure_request_workspace", lambda *args: (None, "synthetic invalid workspace"))
        h.replies["fail"] = (200, b"{")
    elif stage == "future_before_create":
        monkeypatch.setattr(agent, "_allowed_params", Mock(side_effect=RuntimeError("synthetic unexpected bug")))
    elif stage == "future_during_create":
        agent._run_cli_json = Mock(side_effect=RuntimeError("synthetic interrupted response"))
    else:
        agent._run_cli_json = Mock(return_value=(None, "synthetic ambiguous response"))
    assert h.execute() == 1
    assert h.active() == {}
    if stage == "known_pre_submit":
        assert h.calls.count("fail") == 1 and "recovery-required" not in h.calls
        assert agent._run_cli_json.call_count == 0
    else:
        assert h.calls.count("recovery-required") == 1 and "fail" not in h.calls
        assert agent._run_cli_json.call_count == int(stage != "future_before_create")


def test_disk_and_server_failure_keep_memory_only_then_recover_without_create(harness, monkeypatch):
    h, agent = harness, harness.agent
    original_add, original_save = agent._outbox_add, agent._tracked_save
    monkeypatch.setattr(agent, "_outbox_add", Mock(side_effect=OSError("synthetic disk failure")))
    monkeypatch.setattr(agent, "_tracked_save", Mock(side_effect=OSError("synthetic disk failure")))
    h.replies["anchor"] = (503, {})
    assert h.execute() == 1
    tracked = h.active()[JOB_IDS[0]]
    assert tracked["anchor_pending"] and tracked["persist_pending"]
    assert agent._tracked_load(SERVER, ACCOUNT) == {} and agent._outbox_load(SERVER, ACCOUNT) == []
    assert "fail" not in h.calls and len(h.creates) == 1
    # No on-disk recovery source exists here: do not claim crash durability.
    monkeypatch.setattr(agent, "_outbox_add", original_add)
    monkeypatch.setattr(agent, "_tracked_save", original_save)
    h.replies["anchor"] = (200, {"applied": True})
    agent._run_cli_json = Mock(return_value=({"id": JOB_IDS[0], "status": "processing"}, None))
    before = h.calls.count("anchor")
    assert h.poll() == 0
    assert h.calls.count("anchor") - before == 1
    assert not tracked.get("anchor_pending") and not tracked.get("persist_pending")
    assert list(agent._tracked_load(SERVER, ACCOUNT)) == [JOB_IDS[0]]
    assert len(h.creates) == 1


def test_tracking_pass_shares_memory_and_existing_replay_has_its_own_budget(harness):
    h, agent = harness, harness.agent
    h.replies["anchor"] = (503, {})
    assert h.execute() == 1
    tracked = h.active()[JOB_IDS[0]]
    assert tracked["anchor_pending"]
    agent._poll_active_jobs = agent._poll_active_jobs_original
    agent._run_cli_json = Mock(return_value=({"id": JOB_IDS[0], "status": "processing"}, None))
    agent.recovery_probe_pass = Mock()
    agent._list_reconcile_candidates = Mock(return_value=(200, {"candidates": []}))
    before = h.calls.count("anchor")
    pauses = agent._retry_pause.call_count
    assert agent.tracking_pass(SERVER, TOKEN, "synthetic-cli") == 0
    assert h.active()[JOB_IDS[0]] is tracked
    # One new due retry plus one pre-existing outbox replay, not one per whole pass.
    assert h.calls.count("anchor") - before == 2
    assert agent._retry_pause.call_count == pauses
    assert tracked["anchor_pending"] and len(agent._outbox_load(SERVER, ACCOUNT)) == 1
    assert len(h.creates) == 1 and agent._run_cli_json.call_count == 1


def test_malformed_recovery_ack_does_not_stop_harvesting_other_submission(harness):
    h, agent = harness, harness.agent
    agent._allowed_params = Mock(side_effect=[RuntimeError("synthetic preparation bug"), set()])
    h.replies["recovery-required"] = (200, b"{")
    assert h.execute(2) == 2
    assert h.calls.count("recovery-required") == 3
    assert "fail" not in h.calls
    assert list(h.active()) == [JOB_IDS[0]]
    assert h.active()[JOB_IDS[0]]["rid"] == "rid-1"
    assert len(h.creates) == 1
