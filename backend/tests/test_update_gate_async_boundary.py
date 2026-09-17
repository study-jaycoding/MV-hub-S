"""A read-only update gate must not block the event loop or strand a staged claim."""

from __future__ import annotations

import asyncio
import os
import threading
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.routers import gen_requests as routes


def test_begin_abort_handler_is_limited_to_the_new_read_gate():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(routes))
    handlers = [node for node in ast.walk(tree) if isinstance(node, ast.ExceptHandler)
                and isinstance(node.type, ast.Name) and node.type.id == "BaseException"]
    assert len(handlers) == 1
    owner = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name == "begin_gen_request_submission")
    guarded = next(node for node in ast.walk(owner) if isinstance(node, ast.Try)
                   and handlers[0] in node.handlers)
    assert len(guarded.body) == 1
    assert ast.unparse(guarded.body[0]) == "blocked = await asyncio.to_thread(update_in_progress)"
    assert ast.unparse(handlers[0].body[0]) == "await _release_claim_on_abort(acc, rid, agent_id)"
    assert isinstance(handlers[0].body[-1], ast.Raise) and handlers[0].body[-1].exc is None


@pytest.fixture
def begin_case(monkeypatch):
    monkeypatch.setattr(routes, "_require_account", lambda request: {"email": "synthetic@example.invalid"})
    monkeypatch.setattr(routes, "realtime_scope", lambda acc: "synthetic-uid")
    monkeypatch.setattr(routes.agent_signals, "touch", Mock())
    monkeypatch.setattr(routes, "begin_submission", AsyncMock(return_value=True))
    release = AsyncMock(return_value=True)
    monkeypatch.setattr(routes, "release_claim", release)
    return release


def test_begin_read_gate_runs_off_loop_and_normal_ack_is_unchanged(begin_case, monkeypatch):
    loop_thread = threading.get_ident()
    gate_threads = []
    monkeypatch.setattr(routes, "update_in_progress", lambda: gate_threads.append(threading.get_ident()) or False)
    result = asyncio.run(routes.begin_gen_request_submission("rid-test", object(), "agent-test"))
    assert result == {"ok": True, "applied": True}
    assert len(gate_threads) == 1 and gate_threads[0] != loop_thread
    begin_case.assert_not_awaited()


def test_begin_blocked_gate_keeps_existing_single_release(begin_case, monkeypatch):
    monkeypatch.setattr(routes, "update_in_progress", lambda: True)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(routes.begin_gen_request_submission("rid-test", object(), "agent-test"))
    assert caught.value.status_code == 409
    begin_case.assert_awaited_once()


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_gate_exception_releases_claim_without_masking_original(begin_case, monkeypatch, caplog, cleanup_fails):
    original = OSError("synthetic gate error")
    monkeypatch.setattr(routes, "update_in_progress", Mock(side_effect=original))
    if cleanup_fails:
        begin_case.side_effect = RuntimeError("synthetic cleanup private data")
    with pytest.raises(OSError) as caught:
        asyncio.run(routes.begin_gen_request_submission("rid-test", object(), "agent-test"))
    assert caught.value is original
    begin_case.assert_awaited_once_with("synthetic@example.invalid", "synthetic-uid", "rid-test", "agent-test")
    assert "synthetic cleanup private data" not in caplog.text
    if cleanup_fails:
        assert "claim" in caplog.text


@pytest.mark.parametrize("repeat_cancel", [False, True])
@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_gate_cancellation_waits_for_claim_cleanup(begin_case, monkeypatch, repeat_cancel, cleanup_fails):
    async def scenario():
        loop = asyncio.get_running_loop()
        gate_started = asyncio.Event()
        gate_release = threading.Event()
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()
        cleanup_finished = False

        def gate():
            # A bounded wait also makes the pre-fix synchronous failure finish.
            loop.call_soon_threadsafe(gate_started.set)
            gate_release.wait(timeout=0.4)
            return False

        async def cleanup(*args):
            nonlocal cleanup_finished
            cleanup_started.set()
            await cleanup_release.wait()
            cleanup_finished = True
            if cleanup_fails:
                raise RuntimeError("synthetic cleanup failure")
            return True

        monkeypatch.setattr(routes, "update_in_progress", gate)
        begin_case.side_effect = cleanup
        request_task = asyncio.create_task(routes.begin_gen_request_submission("rid-test", object(), "agent-test"))
        try:
            await asyncio.wait_for(gate_started.wait(), timeout=1)
            assert not request_task.done(), "read gate blocked the event loop until ACK"
            request_task.cancel("original-cancel")
            await asyncio.wait_for(cleanup_started.wait(), timeout=1)
            if repeat_cancel:
                request_task.cancel("later-cancel")
                await asyncio.sleep(0)
                assert not request_task.done()
            cleanup_release.set()
            with pytest.raises(asyncio.CancelledError) as caught:
                await request_task
            assert caught.value.args == ("original-cancel",)
            assert cleanup_finished
            begin_case.assert_awaited_once()
        finally:
            gate_release.set()
            cleanup_release.set()
            if not request_task.done():
                request_task.cancel()
            try:
                await request_task
            except (asyncio.CancelledError, Exception):
                pass

    asyncio.run(scenario())


@pytest.fixture
def real_claim(tmp_path, monkeypatch):
    from app import active_account, db, repo
    from app.usecases import gen_requests as usecase

    email = "synthetic-u2@example.invalid"
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(active_account, "_cache", [True, {"email": email, "uid": "synthetic-uid"}])
    monkeypatch.setattr(routes, "_require_account", lambda request: {"email": email})
    monkeypatch.setattr(routes, "realtime_scope", lambda acc: "synthetic-uid")
    monkeypatch.setattr(routes.agent_signals, "touch", Mock())
    monkeypatch.setattr(usecase.agent_signals, "signal", Mock())
    monkeypatch.setattr(usecase, "MANAGE_ENABLED", False)
    monkeypatch.setattr(usecase, "journal_generation_event", Mock(return_value=True))
    broadcast = AsyncMock()
    monkeypatch.setattr(usecase.manager, "broadcast", broadcast)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation(id,worker_id,prompt,model,status,creator_uid,origin,created_at,sort_ts) "
            "VALUES('u2-generation','me','Synthetic','synthetic','pending','synthetic-uid','local',"
            "'2026-09-17 00:00:00',1)"
        )
    rid = repo.create_gen_request(email, "synthetic-uid", "u2-generation", "create", {"model": "synthetic"})
    claimed = repo.claim_pending_requests(email, limit=1, sweep_expired=False,
                                          submission_stage_capable=True, lease_owner="u2-agent")
    assert [item["id"] for item in claimed] == [rid]

    def snapshot():
        with db.get_connection() as conn:
            return dict(conn.execute("SELECT * FROM gen_request WHERE id=?", (rid,)).fetchone())

    assert snapshot()["status"] == "claimed"
    yield rid, snapshot, broadcast
    db.flush_pool()


@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("ws_fails", [False, True])
def test_real_db_claim_returns_even_when_cleanup_notification_fails(real_claim, monkeypatch, cancel, ws_fails):
    rid, snapshot, broadcast = real_claim
    # begin sends progress first; release sends synced after its actual SQLite commit.
    broadcast.side_effect = [None, RuntimeError("synthetic private notification") if ws_fails else None]

    async def scenario():
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        release = threading.Event()
        original = OSError("synthetic gate failure")

        def gate():
            assert snapshot()["status"] == "submitting"
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(timeout=2)
            if not cancel:
                raise original
            return False

        monkeypatch.setattr(routes, "update_in_progress", gate)
        task = asyncio.create_task(routes.begin_gen_request_submission(rid, object(), "u2-agent"))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            if cancel:
                task.cancel("original-cancel")
                with pytest.raises(asyncio.CancelledError) as caught:
                    await asyncio.wait_for(task, 2)
                assert caught.value.args == ("original-cancel",)
            else:
                release.set()
                with pytest.raises(OSError) as caught:
                    await task
                assert caught.value is original
            row = snapshot()
            assert row["status"] == "pending"
            assert row["lease_owner"] is None and row["lease_expires_at"] is None
            assert broadcast.await_count == 2
        finally:
            release.set()
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    asyncio.run(scenario())


def test_actual_cleanup_db_failure_keeps_submitting_and_original_error(real_claim, monkeypatch, caplog):
    from app import repo

    rid, snapshot, broadcast = real_claim
    original = OSError("synthetic gate failure")
    failed_release = Mock(side_effect=OSError("synthetic private database path"))
    monkeypatch.setattr(repo, "release_claimed_request", failed_release)
    monkeypatch.setattr(routes, "update_in_progress", Mock(side_effect=original))
    with pytest.raises(OSError) as caught:
        asyncio.run(routes.begin_gen_request_submission(rid, object(), "u2-agent"))
    assert caught.value is original
    row = snapshot()
    assert row["status"] == "submitting" and row["lease_owner"] == "u2-agent"
    failed_release.assert_called_once()
    assert broadcast.await_count == 1  # initial begin notification only
    assert "synthetic private database path" not in caplog.text
    assert "generation_claim_abort_cleanup_failed" in caplog.text


@pytest.mark.skipif(os.name != "nt", reason="actual Windows lease")
@pytest.mark.parametrize("retry", [False, True])
@pytest.mark.parametrize("outcome", ["blocked", "error", "cancel"])
def test_resolve_gate_await_preserves_counter_and_releases_windows_lease(tmp_path, monkeypatch, retry, outcome):
    import ctypes
    from ctypes import wintypes
    from app.routers import resolve_integration as resolve
    from app.services import resolve_transfer
    from app.services import resolve_transfer_gate as lease_gate

    root = tmp_path / "synthetic-install"
    root.mkdir()
    (root / "INSTALL_SOURCE.txt").touch()
    (root / "update_release.bat").touch()
    monkeypatch.setattr(lease_gate, "APP_ROOT", root)
    monkeypatch.setattr(resolve, "_require_local_resolve", lambda request: None)
    prepare = AsyncMock(side_effect=AssertionError("No media preparation"))
    monkeypatch.setattr(resolve, "_create_resolve_transfer_pinned", prepare)
    monkeypatch.setattr(resolve, "load_manifest", prepare)
    monkeypatch.setattr(resolve, "run_resolve_import_isolated", Mock(side_effect=AssertionError("No Resolve")))
    dll = ctypes.WinDLL("kernel32", use_last_error=True)
    dll.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    dll.CreateFileW.restype = wintypes.HANDLE
    dll.CloseHandle.argtypes = (wintypes.HANDLE,)

    def exclusive_is_blocked():
        handle = dll.CreateFileW(str(root / lease_gate.LOCK_NAME), 0xC0000000, 0, None, 4, 128, None)
        if handle == ctypes.c_void_p(-1).value:
            assert ctypes.get_last_error() == 32
            return True
        assert dll.CloseHandle(handle)
        return False

    async def scenario():
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        entered = asyncio.Event()
        release = threading.Event()
        original = OSError("synthetic gate failure")

        def gate():
            assert threading.get_ident() != loop_thread
            assert resolve_transfer.active_transfer_count() == 1
            assert exclusive_is_blocked()
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(timeout=2)
            if outcome == "error":
                raise original
            return outcome == "blocked"

        monkeypatch.setattr(resolve, "update_in_progress", gate)
        if retry:
            coroutine = resolve.retry_resolve_transfer(resolve.ResolveRetryIn(project_id="p", transfer_id="t"), object())
        else:
            coroutine = resolve.create_resolve_transfer(resolve.ResolveTransferIn(gen_ids=["g"]), object())
        task = asyncio.create_task(coroutine)
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert not task.done()
            if outcome == "cancel":
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                release.set()
                with pytest.raises(HTTPException if outcome == "blocked" else OSError) as caught:
                    await task
                if outcome == "blocked":
                    assert caught.value.status_code == 409
                else:
                    assert caught.value is original
            assert resolve_transfer.active_transfer_count() == 0
            assert not exclusive_is_blocked()
            prepare.assert_not_awaited()
        finally:
            release.set()
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    asyncio.run(scenario())
