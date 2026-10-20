"""A DB restore invalidates an in-flight share operation, including identical WAL refs."""
import io
import json
import threading
import urllib.error
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app import active_account, config, db, repo
from app.routers import _proxy, db_transfer, publish, share
from app.services import auth, share_state_reconciler as reconciler


@pytest.fixture
def account_db(tmp_path, monkeypatch):
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    db.flush_pool()
    active_account.set_active("epoch-test@example.invalid", "epoch-owner")
    db.init_db()
    repo.ensure_default_worker()
    path = db.get_db_path()
    gid = repo.create_local_generation({"model": "test", "prompt": "epoch"}, "me", generation_id="epoch-local")
    repo.set_status(gid, "done")
    repo.publish(gid, "me", "team")
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id=? WHERE id=?", ("epoch-remote", gid))
    repo.set_setting("shared_server_url", "http://epoch.test")
    repo.set_setting("shared_server_token", "synthetic-epoch-session")
    auth.get_secret()
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    monkeypatch.setattr(share, "_touch_telemetry", Mock())
    monkeypatch.setattr(share, "kick_share_state_reconciler", Mock())
    try:
        yield path, gid
    finally:
        db.flush_pool()


def _snapshot(path, gid):
    with db.get_connection(path) as conn:
        generation = dict(conn.execute("SELECT id,job_id,is_final,is_held,share_revision FROM generation WHERE id=?", (gid,)).fetchone())
        intents = [dict(row) for row in conn.execute("SELECT * FROM share_state_intent")]
    return generation, intents


class _Reply:
    def __init__(self, payload):
        self.status = 200
        self.headers = {}
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return self.payload


@pytest.mark.parametrize("pooled", [False, True])
@pytest.mark.parametrize("new_sequence", [False, True])
@pytest.mark.parametrize("response_status", [200, 401, 503])
def test_late_hold_restore_is_unknown_without_new_db_writes(account_db, monkeypatch, tmp_path, pooled, new_sequence, response_status):
    path, gid = account_db
    monkeypatch.setattr(db, "_POOL_ENABLED", pooled)
    entered, release = threading.Event(), threading.Event()
    calls, outcome = [], {}

    def open_response(request, timeout):
        calls.append((request.method, request.full_url))
        if request.full_url.endswith("/capabilities"):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b'{"detail":"Not Found"}'))
        assert request.full_url.endswith("/epoch-remote/hold")
        entered.set()
        assert release.wait(10)
        if response_status != 200:
            raise urllib.error.HTTPError(request.full_url, response_status, "late response", {}, io.BytesIO(b'{"detail":"late response"}'))
        return _Reply({"id": "epoch-remote", "job_id": "epoch-remote", "shared": True, "is_final": False, "is_held": True})

    monkeypatch.setattr(_proxy, "_open", open_response)

    def invoke():
        try:
            outcome["result"] = share.hold_generation(gid, SimpleNamespace(state=SimpleNamespace(account=None)), expected_revision=None)
        except BaseException as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=invoke)
    worker.start()
    try:
        assert entered.wait(5)
        if new_sequence:
            repo.prepare_share_state_intent("http://epoch.test", job_anchor="epoch-remote", local_id=gid,
                                           operation_kind="unhold", desired_shared=True, desired_final=False,
                                           desired_held=False, base_shared=True, base_final=False, base_held=False)
        backup = tmp_path / "restore-input.db"
        db._copy_sqlite(path, backup)
        with db.get_connection(backup) as conn:
            # Same anchor, newer restored state: identity validation alone cannot fix this.
            conn.execute("UPDATE generation SET is_final=1,is_held=0,final_by='me' WHERE id=?", (gid,))
        epoch = db.pool_epoch()
        assert db_transfer._install_db(backup, expected=db_transfer._capture_restore_target()) == {"ok": True, "relogin_required": True}
        assert db.pool_epoch() > epoch and active_account.account_key() is None
        with db.get_connection(path) as conn:
            assert conn.execute("SELECT 1 FROM app_setting WHERE key='shared_server_token'").fetchone() is None
        restored = _snapshot(path, gid)
    finally:
        release.set()
        worker.join(10)
    assert not worker.is_alive()
    assert isinstance(outcome.get("error"), HTTPException), "Stale work must return an explicit unknown-context response"
    assert outcome["error"].status_code == 409
    assert outcome["error"].detail["code"] == "share_database_changed"
    assert outcome["error"].detail["state"] == "unknown" and outcome["error"].detail["recheck_required"] is True
    assert _snapshot(path, gid) == restored
    assert len(calls) == 2
    share._touch_telemetry.assert_not_called()
    share.kick_share_state_reconciler.assert_not_called()


@pytest.mark.parametrize("entry", ["publisher", "reconciler"])
def test_publish_and_real_async_reconciler_stop_after_restore(account_db, monkeypatch, tmp_path, entry):
    import asyncio
    path, gid = account_db
    entered, release = threading.Event(), threading.Event()
    calls, outcome = [], {}
    monkeypatch.setattr(publish, "_touch_telemetry", Mock())
    monkeypatch.setattr(publish, "kick_share_state_reconciler", Mock())
    monkeypatch.setattr(reconciler, "_proxy", _proxy)
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", Mock())
    if entry == "reconciler":
        ref = repo.prepare_share_state_intent("http://epoch.test", job_anchor="epoch-remote", local_id=gid,
                                             operation_kind="hold", desired_shared=True, desired_final=False, desired_held=True,
                                             base_shared=True, base_final=False, base_held=False)
        repo.release_share_state_intent_claim(ref["intent_id"], ref["intent_seq"], ref["claim_token"])

    def open_response(request, timeout):
        calls.append(request.full_url)
        if request.full_url.endswith("/capabilities"):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b'{}'))
        entered.set()
        assert release.wait(10)
        if entry == "reconciler":
            return _Reply({"items": {"epoch-remote": {"id": "epoch-remote", "shared": True, "is_final": False, "is_held": True}}, "missing": []})
        return _Reply({"ok": True, "published": 1})

    monkeypatch.setattr(_proxy, "_open", open_response)

    def invoke():
        try:
            outcome["result"] = (asyncio.run(reconciler.run_share_state_reconciliation_cycle("epoch-worker"))
                                 if entry == "reconciler" else publish.publish_bundle_to_server([gid]))
        except BaseException as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=invoke)
    worker.start()
    try:
        assert entered.wait(5)
        backup = tmp_path / "restore-input.db"
        db._copy_sqlite(path, backup)
        with db.get_connection(backup) as conn:
            conn.execute("UPDATE generation SET is_final=1,is_held=0,final_by='me' WHERE id=?", (gid,))
        db_transfer._install_db(backup, expected=db_transfer._capture_restore_target())
        restored = _snapshot(path, gid)
    finally:
        release.set()
        worker.join(10)
    assert not worker.is_alive()
    if entry == "reconciler":
        assert outcome == {"result": {"claimed": 1, "database_changed": 1}}
        assert len(calls) == 1
        reconciler.touch_generation_telemetry.assert_not_called()
    else:
        assert isinstance(outcome.get("error"), HTTPException)
        assert outcome["error"].status_code == 409 and outcome["error"].detail["state"] == "unknown"
        assert len(calls) == 2
        publish._touch_telemetry.assert_not_called()
        publish.kick_share_state_reconciler.assert_not_called()
    assert _snapshot(path, gid) == restored


@pytest.mark.parametrize("pooled", [False, True])
@pytest.mark.parametrize("barrier", ["gate-wait", "after-precheck"])
def test_sql_entry_epoch_check_is_atomic_with_maintenance(account_db, monkeypatch, tmp_path, pooled, barrier):
    from contextlib import contextmanager
    path, _gid = account_db
    monkeypatch.setattr(db, "_POOL_ENABLED", pooled)
    backup = tmp_path / "restore-input.db"
    db._copy_sqlite(path, backup)
    ready, start_sql, waiting = threading.Event(), threading.Event(), threading.Event()
    release_entry = threading.Event()
    outcome = {}
    original_enter, original_wait, original_gate = db._enter_connection_context, db._pool_condition.wait, db.maintenance_gate

    def invoke():
        try:
            with db.pinned_share_operation():
                ready.set()
                assert start_sql.wait(5)
                with db.get_connection() as conn:
                    conn.execute("INSERT INTO app_setting(key,value) VALUES('stale-write-marker','bad')")
        except BaseException as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=invoke)

    def enter():
        if threading.current_thread() is worker and barrier == "after-precheck":
            waiting.set()
            assert release_entry.wait(10)
        original_enter()

    def wait(*args, **kwargs):
        if threading.current_thread() is worker:
            waiting.set()
        return original_wait(*args, **kwargs)

    @contextmanager
    def maintenance(*args, **kwargs):
        with original_gate(*args, **kwargs):
            if barrier == "gate-wait":
                start_sql.set()
                assert waiting.wait(5)
            yield

    monkeypatch.setattr(db, "_enter_connection_context", enter)
    monkeypatch.setattr(db._pool_condition, "wait", wait)
    monkeypatch.setattr(db, "maintenance_gate", maintenance)
    worker.start()
    try:
        assert ready.wait(5)
        if barrier == "after-precheck":
            start_sql.set()
            assert waiting.wait(5)
        db_transfer._install_db(backup, expected=db_transfer._capture_restore_target())
    finally:
        release_entry.set()
        start_sql.set()
        worker.join(10)
    assert not worker.is_alive() and isinstance(outcome.get("error"), db.DatabaseEpochChanged)
    assert db._active_connection_contexts == 0
    with db.get_connection(path) as conn:
        assert conn.execute("SELECT 1 FROM app_setting WHERE key='stale-write-marker'").fetchone() is None


def test_pin_and_epoch_capture_share_one_transition_boundary(account_db, monkeypatch):
    entered, allow_capture, switch_started, switched = (threading.Event() for _ in range(4))
    original_capture = active_account.capture_account_pin
    original_pin, epoch = original_capture(), db.pool_epoch()
    captured = {}

    def capture():
        pin = original_capture()
        entered.set()
        assert allow_capture.wait(5)
        return pin

    def switch():
        switch_started.set()
        with active_account.transition_lock:
            active_account.set_active("epoch-next@example.invalid", "next-owner")
            db.flush_pool()
        switched.set()

    monkeypatch.setattr(active_account, "capture_account_pin", capture)
    reader = threading.Thread(target=lambda: captured.update(operation=db.capture_share_operation()))
    writer = threading.Thread(target=switch)
    reader.start()
    try:
        assert entered.wait(5)
        writer.start()
        assert switch_started.wait(5) and not switched.is_set()
    finally:
        allow_capture.set()
        reader.join(5)
        writer.join(5)
    assert not reader.is_alive() and not writer.is_alive()
    assert captured["operation"] == (original_pin, epoch)
    assert db.pool_epoch() == epoch + 1


def test_nested_operation_inherits_original_pair_and_epoch(account_db):
    with db.pinned_share_operation():
        original = db.capture_share_operation()
        active_account.set_active("epoch-next@example.invalid", "next-owner")
        with db.pinned_share_operation():
            assert db.capture_share_operation() == original
            assert active_account.capture_account_pin() == original[0]
    with pytest.raises(db.DatabaseEpochChanged):
        with db.pinned_share_operation():
            db.flush_pool()
            with db.pinned_share_operation():
                pytest.fail("A nested call must not recapture the new epoch")


def test_stale_epoch_does_not_replace_cancellation(account_db):
    import asyncio
    with pytest.raises(asyncio.CancelledError):
        with db.pinned_share_operation():
            db.flush_pool()
            raise asyncio.CancelledError()


def test_stale_scope_blocks_intent_failure_release_and_local_apply(account_db):
    path, gid = account_db
    with pytest.raises(db.DatabaseEpochChanged):
        with db.pinned_share_operation():
            ref = repo.prepare_share_state_intent("http://epoch.test", job_anchor="epoch-remote", local_id=gid,
                                                 operation_kind="hold", desired_shared=True, desired_final=False,
                                                 desired_held=True, base_shared=True, base_final=False)
            before = _snapshot(path, gid)
            db.flush_pool()
            operations = (
                lambda: repo.transition_share_state_intent(ref["intent_id"], ref["intent_seq"], ref["claim_token"], "rejected"),
                lambda: repo.release_share_state_intent_claim(ref["intent_id"], ref["intent_seq"], ref["claim_token"]),
                lambda: repo.mark_share_state_intent_waiting_local(ref["intent_id"], ref["intent_seq"], ref["claim_token"]),
                lambda: repo.apply_share_state_intent_local(ref["intent_id"], ref["intent_seq"], ref["claim_token"], local_id=gid,
                                                           shared=True, is_final=False, is_held=True),
                lambda: _snapshot(path, gid),  # explicit/nonpooled DB path is guarded too
            )
            for operation in operations:
                with pytest.raises(db.DatabaseEpochChanged):
                    operation()
    assert _snapshot(path, gid) == before


def test_captured_media_task_stops_before_read_or_write_after_restore(account_db, monkeypatch, tmp_path):
    import asyncio
    from unittest.mock import AsyncMock
    path, gid = account_db
    monkeypatch.setattr(share, "MEDIA_PRESERVATION_ENABLED", True)
    with db.pinned_share_operation():
        operation = db.capture_share_operation()
    backup = tmp_path / "restore-input.db"
    db._copy_sqlite(path, backup)
    db_transfer._install_db(backup, expected=db_transfer._capture_restore_target())
    before = _snapshot(path, gid)
    read_generation, request_media, preserve = Mock(), Mock(), AsyncMock()
    monkeypatch.setattr(repo, "get_generation", read_generation)
    monkeypatch.setattr(repo, "request_media_preservation", request_media)
    monkeypatch.setattr(share, "preserve_generation_now", preserve)
    asyncio.run(share._preserve_final_media(gid, operation[0][0], operation))
    read_generation.assert_not_called()
    request_media.assert_not_called()
    preserve.assert_not_called()
    assert _snapshot(path, gid) == before


def test_media_download_stale_body_never_publishes_or_retries(account_db, monkeypatch, tmp_path):
    from app.services import media_cache
    target = tmp_path / "cached.png"
    requests = []

    class Response(_Reply):
        def __init__(self):
            self.headers = {"Content-Type": "image/png"}

        def read(self, size):
            db.flush_pool()  # the in-memory response crosses the replacement boundary
            return b"\x89PNG\r\nsynthetic"

    def open_response(*args, **kwargs):
        requests.append(True)
        return Response()

    monkeypatch.setattr(media_cache, "assert_public_http_url", Mock())
    monkeypatch.setattr(media_cache, "guarded_opener", lambda: SimpleNamespace(open=open_response))
    monkeypatch.setattr(media_cache, "_ensure_disk_space", Mock())
    with pytest.raises(db.DatabaseEpochChanged):
        with db.pinned_share_operation():
            media_cache._download("https://example.invalid/synthetic.png", target)
    assert len(requests) == 1 and not target.exists()
    assert list(tmp_path.glob("*.part")) == []


def test_media_stale_scope_does_not_start_dns_or_mark_failure(account_db, monkeypatch, tmp_path):
    import asyncio
    from app.services import media_cache, media_preservation
    url_check = Mock()
    monkeypatch.setattr(media_cache, "assert_public_http_url", url_check)
    finish = Mock()
    monkeypatch.setattr(repo, "finish_media_preservation", finish)

    async def stale(_claim):
        db.require_share_operation_epoch()

    monkeypatch.setattr(media_preservation, "_process_claim", stale)
    with pytest.raises(db.DatabaseEpochChanged):
        with db.pinned_share_operation():
            db.flush_pool()
            with pytest.raises(db.DatabaseEpochChanged):
                media_cache._download("https://example.invalid/never.png", tmp_path / "never.png")
            with pytest.raises(db.DatabaseEpochChanged):
                asyncio.run(media_preservation._process_claim_safely({"generation_id": "unused"}))
    url_check.assert_not_called()
    finish.assert_not_called()


@pytest.mark.parametrize("boundary", ["open", "body", "401-body", "503-body"])
@pytest.mark.parametrize("kind", ["cancelled", "exit", "interrupt"])
def test_proxy_epoch_change_preserves_io_cancellation(account_db, monkeypatch, boundary, kind):
    import asyncio
    error = {"cancelled": asyncio.CancelledError, "exit": SystemExit, "interrupt": KeyboardInterrupt}[kind]("synthetic-stop")
    calls = []

    def interrupted_read(*args):
        db.flush_pool()
        raise error

    def open_response(request, timeout):
        calls.append(request.full_url)
        if boundary == "open":
            interrupted_read()
        if boundary.endswith("-body"):
            stream = io.BytesIO()
            stream.read = interrupted_read
            raise urllib.error.HTTPError(request.full_url, int(boundary[:3]), "synthetic", {}, stream)
        response = _Reply({"ok": True})
        response.read = interrupted_read
        return response

    monkeypatch.setattr(_proxy, "_open", open_response)
    with pytest.raises(type(error)) as caught:
        with db.pinned_share_operation():
            _proxy.raw_request("POST", "https://example.invalid/synthetic")
    assert caught.value is error
    assert len(calls) == 1


@pytest.mark.parametrize("boundary", ["open", "body"])
@pytest.mark.parametrize("kind", ["cancelled", "exit", "interrupt"])
def test_media_epoch_change_preserves_io_cancellation(account_db, monkeypatch, tmp_path, boundary, kind):
    import asyncio
    from app.services import media_cache
    error = {"cancelled": asyncio.CancelledError, "exit": SystemExit, "interrupt": KeyboardInterrupt}[kind]("synthetic-stop")
    requests = []
    target = tmp_path / "cancelled.png"

    class Response(_Reply):
        def __init__(self):
            self.headers = {"Content-Type": "image/png"}

        def read(self, size):
            db.flush_pool()
            raise error

    def open_response(*args, **kwargs):
        requests.append(True)
        if boundary == "open":
            db.flush_pool()
            raise error
        return Response()

    monkeypatch.setattr(media_cache, "assert_public_http_url", Mock())
    monkeypatch.setattr(media_cache, "guarded_opener", lambda: SimpleNamespace(open=open_response))
    monkeypatch.setattr(media_cache, "_ensure_disk_space", Mock())
    with pytest.raises(type(error)) as caught:
        with db.pinned_share_operation():
            media_cache._download("https://example.invalid/synthetic.png", target)
    assert caught.value is error
    assert len(requests) == 1 and not target.exists()


@pytest.mark.parametrize("status", [200, 401, 503])
@pytest.mark.parametrize("changed", [False, True])
def test_proxy_ordinary_response_keeps_epoch_unknown(account_db, monkeypatch, status, changed):
    def open_response(request, timeout):
        if changed:
            db.flush_pool()
        if status != 200:
            raise urllib.error.HTTPError(request.full_url, status, "synthetic", {}, io.BytesIO(b'{"ok":true}'))
        return _Reply({"ok": True})

    monkeypatch.setattr(_proxy, "_open", open_response)
    if changed:
        with pytest.raises(db.DatabaseEpochChanged):
            with db.pinned_share_operation():
                _proxy.raw_request("POST", "https://example.invalid/synthetic")
    else:
        with db.pinned_share_operation():
            assert _proxy.raw_request("POST", "https://example.invalid/synthetic") == (status, {"ok": True})
