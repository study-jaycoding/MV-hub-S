"""Manual backups retain admission ownership; all identities and stores are synthetic."""

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import threading
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, Request

from app import active_account, config
from app.routers import db_transfer
from app.services import worker_backup


A = "backup-a@example.invalid"
B = "backup-b@example.invalid"


def digest(email):
    return hashlib.sha256(active_account.slug(email).encode("utf-8")).hexdigest()


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(worker_backup, "STATE_DB", tmp_path / "state.db")
    monkeypatch.setattr(worker_backup, "OUTBOX_DIR", tmp_path / "outbox")
    monkeypatch.setattr(worker_backup, "DEVICE_IDENTITY_PATH", tmp_path / "device.json")
    monkeypatch.setattr(worker_backup, "_STATE_SCHEMA_READY", set())
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    active_account.set_active(A, "uid-a")
    source = tmp_path / "content_hub_20260917_120000_000001.db"
    assert source.resolve().is_relative_to(tmp_path.resolve())
    with closing(sqlite3.connect(source)) as conn:
        conn.executescript("CREATE TABLE generation(id TEXT PRIMARY KEY); INSERT INTO generation VALUES('synthetic-a'); CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT);")
        conn.commit()
    monkeypatch.setattr(db_transfer, "require_admin", lambda request: None)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer._proxy, "proxying", lambda: True)
    url = Mock(side_effect=lambda: "http://a.invalid" if active_account.account_key() == A else "http://b.invalid")
    token = Mock(side_effect=lambda: "synthetic-a" if active_account.account_key() == A else "synthetic-b")
    monkeypatch.setattr(db_transfer._proxy, "base_url", url)
    monkeypatch.setattr(db_transfer._proxy, "token", token)
    upload = Mock(side_effect=AssertionError("network must stay mocked"))
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", upload)
    monkeypatch.setattr(db_transfer, "_multipart_upload", upload)
    monkeypatch.setattr(worker_backup.shared_connection, "token", lambda: "synthetic-a")
    monkeypatch.setattr(worker_backup.shared_connection, "base_url", lambda: "http://a.invalid")
    request = Request({"type": "http", "method": "POST", "path": "/api/db/server-backup", "headers": [], "client": ("127.0.0.1", 12345), "server": ("127.0.0.1", 8012), "scheme": "http", "query_string": b""})
    try:
        yield SimpleNamespace(root=tmp_path, source=source, request=request, url=url, token=token, upload=upload)
    finally:
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(key_token)


def rows():
    with closing(worker_backup._connect()) as conn:
        return {name: [tuple(row) for row in conn.execute(f"SELECT * FROM {name} ORDER BY 1")] for name in ("worker_backup_outbox", "worker_backup_delivery_state")}


@pytest.mark.parametrize("switch_at", ("backup", "queue", "retry", "run"))
@pytest.mark.parametrize("legacy", (False, True))
def test_manual_route_uses_one_pinned_owner_and_connection_pair(store, monkeypatch, switch_at, legacy):
    observed = []

    def stage(name):
        observed.append((name, active_account.account_key(), active_account.active_uid()))
        if switch_at == name:
            active_account.set_active(B, "uid-b")

    def backup():
        stage("backup")
        return store.source

    def queue(path, *, account_email=None):
        stage("queue")
        assert path == store.source and account_email == A
        return "a" * 64

    def retry(*, account_email=None):
        stage("retry")
        assert account_email == A
        return 1

    async def run(**kwargs):
        stage("run")
        assert kwargs == {"expected_account_key": digest(A), "expected_backup_set_id": "a" * 64}
        return {"state": "server_update_required" if legacy else "success"}

    legacy_call = Mock(return_value=(200, {"count": 4}))
    monkeypatch.setattr(db_transfer, "backup_now", backup)
    monkeypatch.setattr(db_transfer, "queue_backup_set", queue)
    monkeypatch.setattr(db_transfer, "retry_pending", retry)
    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
    monkeypatch.setattr(db_transfer, "_legacy_server_backup", legacy_call)
    result = asyncio.run(db_transfer.server_backup(store.request))
    assert all(email == A and uid == "uid-a" for _, email, uid in observed)
    assert store.url.call_count == store.token.call_count == 1
    assert active_account.account_key() == B and active_account.active_uid() == "uid-b"
    if legacy:
        legacy_call.assert_called_once_with(store.source, server_url="http://a.invalid", token="synthetic-a")
        assert result["legacy_content_saved"] is True and result["ok"] is False
    else:
        legacy_call.assert_not_called()
        assert result["ok"] is True


def test_actual_queue_after_switch_never_stages_a_under_b(store, monkeypatch):
    def backup():
        active_account.set_active(B, "uid-b")
        return store.source

    monkeypatch.setattr(db_transfer, "backup_now", backup)
    run = AsyncMock(return_value={"state": "account_changed", "error_code": "account_changed"})
    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
    result = asyncio.run(db_transfer.server_backup(store.request))
    state = rows()
    assert len(state["worker_backup_outbox"]) == 1
    with closing(worker_backup._connect()) as conn:
        row = conn.execute("SELECT * FROM worker_backup_outbox").fetchone()
    assert row["account_slug"] == active_account.slug(A) and row["status"] == "pending"
    stage = worker_backup.OUTBOX_DIR / active_account.slug(A) / row["backup_set_id"]
    with closing(sqlite3.connect(stage / "content.db")) as conn:
        assert conn.execute("SELECT id FROM generation").fetchone()[0] == "synthetic-a"
    assert not (worker_backup.OUTBOX_DIR / active_account.slug(B)).exists()
    assert run.call_args.kwargs == {"expected_account_key": digest(A), "expected_backup_set_id": row["backup_set_id"]}
    assert result["state"] == "account_changed" and result["ok"] is False
    store.upload.assert_not_called()


@pytest.mark.parametrize("case", ("different_account", "blank", "wrong_set_owner", "missing_set"))
def test_expected_drain_rejects_before_claim_and_preserves_every_record(store, monkeypatch, case):
    set_id = worker_backup.queue_backup_set(store.source, account_email=A)
    assert set_id
    if case == "different_account":
        active_account.set_active(B, "uid-b")
    elif case == "blank":
        active_account.clear_active()
    elif case == "wrong_set_owner":
        with worker_backup._connect() as conn:
            conn.execute("UPDATE worker_backup_outbox SET account_slug=?", (active_account.slug(B),))
    before = rows()
    staged = {p.relative_to(worker_backup.OUTBOX_DIR): p.read_bytes() for p in worker_backup.OUTBOX_DIR.rglob("*") if p.is_file()}
    claim = Mock(side_effect=AssertionError("claim must not start"))
    monkeypatch.setattr(worker_backup, "_claim_due", claim)
    result = worker_backup.drain_one_expected(digest(A), "f" * 64 if case == "missing_set" else set_id)
    assert result == {"state": "account_changed", "error_code": "account_changed"}
    assert rows() == before
    assert {p.relative_to(worker_backup.OUTBOX_DIR): p.read_bytes() for p in worker_backup.OUTBOX_DIR.rglob("*") if p.is_file()} == staged
    claim.assert_not_called()
    store.upload.assert_not_called()


def test_expected_drain_pins_claim_and_connection_after_machine_switch(store, monkeypatch):
    set_id = worker_backup.queue_backup_set(store.source)
    original_claim = worker_backup._claim_due
    observed = []

    def claim():
        active_account.set_active(B, "uid-b")
        observed.append((active_account.account_key(), active_account.active_uid()))
        return original_claim()

    def upload(url, token, manifest, paths, **kwargs):
        observed.append((active_account.account_key(), active_account.active_uid()))
        return 200, {"accepted": True, "backup_set_id": manifest["backup_set_id"], "files": manifest["roles"], "count": 1}

    monkeypatch.setattr(worker_backup, "_claim_due", claim)
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", upload)
    result = worker_backup.drain_one_expected(digest(A), set_id)
    assert result["state"] == "success"
    assert observed == [(A, "uid-a"), (A, "uid-a")]
    assert active_account.account_key() == B


def test_expected_set_is_owner_check_not_backlog_claim_filter(store, monkeypatch):
    set_id = worker_backup.queue_backup_set(store.source)
    original_claim = worker_backup._claim_due
    with worker_backup._connect() as conn:
        conn.execute("UPDATE worker_backup_outbox SET created_at='2000-01-01'")
        conn.execute("INSERT INTO worker_backup_outbox(backup_set_id,account_slug,created_at,local_stamp,roles_json,status) VALUES(?,?,?,'synthetic','{}','pending')", ("b" * 64, active_account.slug(A), "2099-01-01"))
    claimed = []

    def drain():
        row = original_claim()
        claimed.append(row["backup_set_id"])
        return {"state": "synthetic"}

    monkeypatch.setattr(worker_backup, "drain_one", drain)
    assert worker_backup.drain_one_expected(digest(A), "b" * 64)["state"] == "synthetic"
    assert claimed == [set_id]


def test_retry_explicit_owner_does_not_touch_new_active_account(store):
    worker_backup.queue_backup_set(store.source, account_email=A)
    worker_backup.queue_backup_set(store.source, account_email=B)
    with worker_backup._connect() as conn:
        conn.execute("UPDATE worker_backup_outbox SET next_retry_ts=9999999999")
    active_account.set_active(B, "uid-b")
    assert worker_backup.retry_pending(account_email=A) == 1
    with closing(worker_backup._connect()) as conn:
        found = {r[0]: r[1] for r in conn.execute("SELECT account_slug,next_retry_ts FROM worker_backup_outbox")}
    assert found == {active_account.slug(A): None, active_account.slug(B): 9999999999}


@pytest.mark.parametrize("blank", (False, True))
def test_retry_route_pins_owner_and_blank_never_launches_new_account(store, monkeypatch, blank):
    worker_backup.queue_backup_set(store.source, account_email=B)
    before = rows()
    if blank:
        active_account.clear_active()
    capture = active_account.capture_account_pin

    def switching_capture():
        pin = capture()
        active_account.set_active(B, "uid-b")
        return pin

    monkeypatch.setattr(active_account, "capture_account_pin", switching_capture)
    if blank:
        spawn = AsyncMock(side_effect=AssertionError("blank admission must not spawn"))
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        result = asyncio.run(db_transfer.retry_server_backup(store.request))
        assert result == {"ok": True, "state": "idle"}
        spawn.assert_not_called()
    else:
        run = AsyncMock(return_value={"state": "account_changed"})
        retry = Mock(return_value=0)
        monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
        monkeypatch.setattr(db_transfer, "retry_pending", retry)
        result = asyncio.run(db_transfer.retry_server_backup(store.request))
        retry.assert_called_once_with(account_email=A)
        run.assert_awaited_once_with(expected_account_key=digest(A))
        assert result["ok"] is False
    assert rows() == before


def test_listing_connection_pair_cannot_split_during_transition(store, monkeypatch):
    started, finished = threading.Event(), threading.Event()
    workers = []

    def switch():
        started.set()
        active_account.set_active(B, "uid-b")
        finished.set()

    def url():
        worker = threading.Thread(target=switch)
        workers.append(worker)
        worker.start()
        assert started.wait(1)
        assert not finished.wait(0.03), "connection pair must share transition lock"
        return "http://a.invalid"

    monkeypatch.setattr(db_transfer._proxy, "base_url", url)
    request = Mock(return_value=(200, {"backups": []}))
    monkeypatch.setattr(db_transfer._proxy, "raw_request", request)
    try:
        assert db_transfer.server_backups(store.request) == {"backups": []}
        request.assert_called_once_with("GET", "http://a.invalid/api/db-backup", token="synthetic-a")
    finally:
        for worker in workers:
            worker.join(2)
            assert not worker.is_alive()


@pytest.mark.parametrize("kwargs", ({}, {"expected_account_key": "a" * 64}, {"expected_account_key": "a" * 64, "expected_backup_set_id": "b" * 64}))
def test_parent_child_flags_use_only_digest_and_keep_default_call_unchanged(store, monkeypatch, kwargs):
    monkeypatch.setattr(worker_backup, "has_due_backup", lambda: True)
    child = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'{"state":"account_changed","error_code":"account_changed"}', b"")))
    spawn = AsyncMock(return_value=child)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    result = asyncio.run(worker_backup.PeriodicWorkerBackupUpload().run_now(**kwargs))
    assert result["state"] == "account_changed"
    expected = [sys.executable, "-m", "app.services.worker_backup", "--drain-one"]
    if kwargs:
        expected += ["--expect-account-key", kwargs["expected_account_key"]]
    if "expected_backup_set_id" in kwargs:
        expected += ["--expect-backup-set", kwargs["expected_backup_set_id"]]
    assert spawn.call_args.args == tuple(expected)
    assert not any(value in " ".join(expected) for value in (A, B, active_account.slug(A), "synthetic-a"))


@pytest.mark.parametrize("args", (
    [], ["--expect-account-key", "a" * 64],
    ["--drain-one", "--expect-account-key", "a" * 63],
    ["--drain-one", "--expect-account-key", "A" * 64],
    ["--drain-one", "--expect-account-key", "a" * 64 + "\n"],
    ["--drain-one", "--expect-backup-set", "b" * 64],
    ["--drain-one", "--expect-account-key", "a" * 64, "--expect-backup-set", "../invalid"],
))
def test_invalid_child_flags_return_two_without_opening_state(store, monkeypatch, args):
    connect = Mock(side_effect=AssertionError("invalid argv must not open state"))
    monkeypatch.setattr(worker_backup, "_connect", connect)
    assert worker_backup._main(args) == 2
    connect.assert_not_called()


def test_old_child_unknown_digest_flag_is_fail_closed():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--drain-one", action="store_true")
    with pytest.raises(SystemExit) as error:
        parser.parse_args(["--drain-one", "--expect-account-key", "a" * 64])
    assert error.value.code == 2


def test_child_result_never_prints_expected_key(store, capsys):
    active_account.set_active(B, "uid-b")
    assert worker_backup._main(["--drain-one", "--expect-account-key", digest(A)]) == 0
    result = capsys.readouterr()
    assert json.loads(result.out) == {"state": "account_changed", "error_code": "account_changed"}
    assert all(value not in result.out + result.err for value in (A, B, digest(A), active_account.slug(A), "synthetic-a"))


def test_actual_child_mismatch_preserves_outbox_with_network_blocked(store):
    worker_backup.queue_backup_set(store.source)
    before = rows()
    active_account.set_active(B, "uid-b")
    env = dict(os.environ)
    env.update({"CONTENT_HUB_DATA": str(store.root), "CONTENT_HUB_DB": str(store.root / "unused.db"), "CONTENT_HUB_WORKER_BACKUP_STATE_DB": str(worker_backup.STATE_DB), "CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR": str(worker_backup.OUTBOX_DIR), "CONTENT_HUB_AUTH": "0", "CONTENT_HUB_NO_PROXY": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    # Actual new interpreter and module main. The wrapper blocks networking before
    # importing product code; no actual provider or backup upload may run.
    code = "import sys,runpy; sys.addaudithook(lambda event,args: (_ for _ in ()).throw(RuntimeError('network blocked')) if event in ('socket.connect','socket.bind','socket.getaddrinfo') else None); sys.argv=['worker_backup','--drain-one','--expect-account-key',sys.argv[1]]; runpy.run_module('app.services.worker_backup',run_name='__main__') # r1-synthetic-child"
    process = subprocess.run([sys.executable, "-B", "-c", code, digest(A)], cwd=str(worker_backup.BACKEND_DIR), env=env, capture_output=True, text=True, timeout=30)
    assert process.returncode == 0, "isolated child must return account_changed without uploading"
    assert json.loads(process.stdout.splitlines()[-1]) == {"state": "account_changed", "error_code": "account_changed"}
    assert rows() == before
    assert all(value not in process.stdout + process.stderr for value in (A, B, digest(A), "synthetic-a"))


def test_admission_capture_runs_off_loop_and_locks_identity_with_connection_pair(store, monkeypatch):
    loop_thread = threading.get_ident()
    observed = []
    started, finished = threading.Event(), threading.Event()
    workers = []

    def switch():
        started.set()
        active_account.set_active(B, "uid-b")
        finished.set()

    def url():
        observed.append(threading.get_ident())
        worker = threading.Thread(target=switch)
        workers.append(worker)
        worker.start()
        assert started.wait(1)
        assert not finished.wait(0.03)
        return "http://a.invalid"

    monkeypatch.setattr(db_transfer._proxy, "base_url", url)
    monkeypatch.setattr(db_transfer, "backup_now", lambda: store.source)
    queue = Mock(return_value="a" * 64)
    monkeypatch.setattr(db_transfer, "queue_backup_set", queue)
    monkeypatch.setattr(db_transfer, "retry_pending", lambda **kwargs: 1)
    run = AsyncMock(return_value={"state": "success"})
    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
    try:
        assert asyncio.run(db_transfer.server_backup(store.request))["ok"]
        assert len(observed) == 1 and observed[0] != loop_thread
        queue.assert_called_once_with(store.source, account_email=A)
        assert store.token.call_count == 1
    finally:
        for worker in workers:
            worker.join(2)
            assert not worker.is_alive()


@pytest.mark.parametrize("failure", ("none", "verify", "upload"))
def test_actual_legacy_backup_uses_captured_pair_scrubs_and_cleans_temp(store, monkeypatch, failure):
    with closing(sqlite3.connect(store.source)) as conn:
        conn.execute("INSERT INTO app_setting VALUES('shared_server_token','synthetic-secret')")
        conn.commit()
    active_account.set_active(B, "uid-b")
    paths = []

    def upload(url, token, path):
        assert url == "http://a.invalid/api/db-backup" and token == "synthetic-a"
        paths.append(path)
        with closing(sqlite3.connect(path)) as conn:
            assert conn.execute("SELECT value FROM app_setting WHERE key='shared_server_token'").fetchone() is None
        if failure == "upload":
            raise OSError("synthetic upload failure")
        return 200, {"count": 1}

    monkeypatch.setattr(db_transfer, "_multipart_upload", upload)
    if failure == "verify":
        def verify(path):
            paths.append(path)
            raise ValueError("synthetic verification failure")
        monkeypatch.setattr(db_transfer, "_verify_secrets_removed", verify)
    if failure == "none":
        assert db_transfer._legacy_server_backup(store.source, server_url="http://a.invalid", token="synthetic-a") == (200, {"count": 1})
    else:
        with pytest.raises((ValueError, OSError)):
            db_transfer._legacy_server_backup(store.source, server_url="http://a.invalid", token="synthetic-a")
    assert paths and all(not path.exists() for path in paths)
    assert store.source.is_file()
    store.url.assert_not_called()
    store.token.assert_not_called()


def test_canceled_manual_backup_restores_task_scope_but_thread_keeps_captured_owner(store, monkeypatch):
    started, release, finished = threading.Event(), threading.Event(), threading.Event()
    observed = []

    def backup():
        started.set()
        release.wait(2)
        observed.append((active_account.account_key(), active_account.active_uid()))
        finished.set()
        return store.source

    queue = Mock(side_effect=AssertionError("canceled route must not queue"))
    monkeypatch.setattr(db_transfer, "backup_now", backup)
    monkeypatch.setattr(db_transfer, "queue_backup_set", queue)

    async def check():
        async def request_task():
            try:
                await db_transfer.server_backup(store.request)
            finally:
                # The canceled coroutine's own finally must have reset overrides.
                assert active_account._override.get() is None
                assert active_account._uid_override.get() is None

        task = asyncio.create_task(request_task())
        try:
            assert await asyncio.to_thread(started.wait, 1)
            active_account.set_active(B, "uid-b")
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            release.set()
            assert await asyncio.to_thread(finished.wait, 1)

    asyncio.run(check())
    assert observed == [(A, "uid-a")]
    assert active_account.account_key() == B
    queue.assert_not_called()


def test_manual_blank_admission_does_not_queue_newly_logged_in_account(store, monkeypatch):
    active_account.clear_active()

    def backup():
        active_account.set_active(B, "uid-b")
        return store.source

    monkeypatch.setattr(db_transfer, "backup_now", backup)
    run = AsyncMock(side_effect=AssertionError("empty admission cannot launch child"))
    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
    with pytest.raises(HTTPException) as error:
        asyncio.run(db_transfer.server_backup(store.request))
    assert error.value.status_code == 409
    assert not worker_backup.OUTBOX_DIR.exists()
    assert not worker_backup.STATE_DB.exists()
    run.assert_not_called()


@pytest.mark.parametrize("backlog", (False, True))
@pytest.mark.parametrize("via_main", (False, True))
def test_done_expected_set_allows_existing_oldest_backlog_or_idle(store, monkeypatch, capsys, backlog, via_main):
    def acknowledge(url, token, manifest, paths, **kwargs):
        assert url == "http://a.invalid/api/db-backup/sets" and token == "synthetic-a"
        return 200, {"accepted": True, "backup_set_id": manifest["backup_set_id"], "files": manifest["roles"], "count": 7}

    upload = Mock(side_effect=acknowledge)
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", upload)
    expected_id = worker_backup.queue_backup_set(store.source)
    assert worker_backup.drain_one_expected(digest(A), expected_id)["state"] == "success"
    upload.reset_mock()
    with closing(worker_backup._connect()) as conn:
        expected_before = tuple(conn.execute("SELECT * FROM worker_backup_outbox WHERE backup_set_id=?", (expected_id,)).fetchone())
        assert conn.execute("SELECT status FROM worker_backup_outbox WHERE backup_set_id=?", (expected_id,)).fetchone()[0] == "done"

    pending_ids = []
    if backlog:
        for index in (1, 2):
            source = store.root / f"content_hub_20260917_12000{index}_000001.db"
            source.write_bytes(store.source.read_bytes())
            with closing(sqlite3.connect(source)) as conn:
                conn.execute("INSERT INTO generation VALUES(?)", (f"synthetic-backlog-{index}",))
                conn.commit()
            pending_ids.append(worker_backup.queue_backup_set(source))
        assert len(set([expected_id, *pending_ids])) == 3
        with worker_backup._connect() as conn:
            for index, set_id in enumerate(pending_ids, 1):
                conn.execute("UPDATE worker_backup_outbox SET created_at=? WHERE backup_set_id=?", (f"200{index}-01-01", set_id))

    # Re-selecting unchanged content really returns the already-done set. That
    # expected ID proves owner only; it is not a filter over the existing queue.
    assert worker_backup.queue_backup_set(store.source) == expected_id
    if via_main:
        assert worker_backup._main(["--drain-one", "--expect-account-key", digest(A), "--expect-backup-set", expected_id]) == 0
        output = capsys.readouterr()
        result = json.loads(output.out)
        assert all(value not in output.out + output.err for value in (A, digest(A), active_account.slug(A), "synthetic-a"))
    else:
        result = worker_backup.drain_one_expected(digest(A), expected_id)

    with closing(worker_backup._connect()) as conn:
        assert tuple(conn.execute("SELECT * FROM worker_backup_outbox WHERE backup_set_id=?", (expected_id,)).fetchone()) == expected_before
        status = {row[0]: (row[1], row[2]) for row in conn.execute("SELECT backup_set_id,status,attempts FROM worker_backup_outbox")}
    if backlog:
        assert result["state"] == "success" and result["backup_set_id"] == pending_ids[0]
        assert result["server_count"] == 7
        assert status[pending_ids[0]] == ("done", 1)
        assert status[pending_ids[1]] == ("pending", 0)
        upload.assert_called_once()
        assert upload.call_args.args[2]["backup_set_id"] == pending_ids[0]
    else:
        assert result == {"state": "idle"}
        upload.assert_not_called()
    assert not (worker_backup.OUTBOX_DIR / active_account.slug(A) / expected_id).exists()
    store.upload.assert_not_called()


def test_main_matching_pending_owner_and_set_returns_zero_after_actual_drain(store, monkeypatch, capsys):
    set_id = worker_backup.queue_backup_set(store.source)

    def acknowledge(url, token, manifest, paths, **kwargs):
        assert manifest["backup_set_id"] == set_id
        return 200, {"accepted": True, "backup_set_id": set_id, "files": manifest["roles"]}

    upload = Mock(side_effect=acknowledge)
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", upload)
    assert worker_backup._main(["--drain-one", "--expect-account-key", digest(A), "--expect-backup-set", set_id]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["state"] == "success" and result["backup_set_id"] == set_id
    upload.assert_called_once()
    with closing(worker_backup._connect()) as conn:
        assert tuple(conn.execute("SELECT status,attempts FROM worker_backup_outbox WHERE backup_set_id=?", (set_id,)).fetchone()) == ("done", 1)
    store.upload.assert_not_called()


def test_manual_route_captures_none_token_once_and_forwards_it_to_actual_legacy(store, monkeypatch):
    store.token.side_effect = None
    store.token.return_value = None
    with closing(sqlite3.connect(store.source)) as conn:
        conn.execute("INSERT INTO app_setting VALUES('shared_server_token','synthetic-secret')")
        conn.commit()
    before = store.source.read_bytes()

    def backup():
        active_account.set_active(B, "uid-b")
        return store.source

    paths = []

    def upload(url, token, path):
        assert url == "http://a.invalid/api/db-backup" and token is None
        assert active_account.account_key() == A and active_account.active_uid() == "uid-a"
        paths.append(path)
        with closing(sqlite3.connect(path)) as conn:
            assert conn.execute("SELECT value FROM app_setting WHERE key='shared_server_token'").fetchone() is None
        return 200, {"count": 3}

    monkeypatch.setattr(db_transfer, "backup_now", backup)
    run = AsyncMock(return_value={"state": "server_update_required"})
    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", run)
    legacy_upload = Mock(side_effect=upload)
    monkeypatch.setattr(db_transfer, "_multipart_upload", legacy_upload)
    result = asyncio.run(db_transfer.server_backup(store.request))
    assert result == {"ok": False, "state": "server_update_required", "count": 3, "legacy_content_saved": True}
    assert store.url.call_count == store.token.call_count == 1
    assert active_account.account_key() == B and active_account.active_uid() == "uid-b"
    with closing(worker_backup._connect()) as conn:
        row = conn.execute("SELECT account_slug,backup_set_id,status FROM worker_backup_outbox").fetchone()
    assert row[0] == active_account.slug(A) and row[2] == "pending"
    run.assert_awaited_once_with(expected_account_key=digest(A), expected_backup_set_id=row[1])
    legacy_upload.assert_called_once()
    assert paths and all(not path.exists() for path in paths)
    assert store.source.read_bytes() == before
    store.upload.assert_not_called()
