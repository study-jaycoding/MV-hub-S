"""Update-state failure and status/start races, isolated from real installations."""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import json
import os
import threading
import time
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.services import release_update as service


BAD_CONTENTS = [b'{"private-sentinel":', b"", b"[]", b"null", b'"installing"', b"7", b"\xff"]
WRITE_BRANCHES = ["stale", "stored_health", "latest_health", "up_to_date", "available"]


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    root = tmp_path / "synthetic-installed"
    root.mkdir()
    (root / "VERSION.txt").write_text("1.0.0", encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(tmp_path / "unused-source"), encoding="utf-8")
    (root / "update_release.bat").write_text("not executable test data", encoding="utf-8")
    monkeypatch.setattr(service, "AUTH_ENABLED", False)
    monkeypatch.setattr(service, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(service, "_START_LOCK", threading.Lock())
    latest = {"version": "2.0.0", "higgsfield_cli_version": "synthetic-cli"}
    fetch = Mock(side_effect=lambda root: dict(latest))
    health = Mock(return_value=(True, ""))
    launch = Mock(return_value=12345)
    monkeypatch.setattr(service, "fetch_latest", fetch)
    monkeypatch.setattr(service, "_installation_health", health)
    monkeypatch.setattr(service, "_launch_bootstrap", launch)
    monkeypatch.setattr(service.urllib.request, "urlopen", Mock(side_effect=AssertionError("No network")))
    monkeypatch.setattr(service.subprocess, "Popen", Mock(side_effect=AssertionError("No child process")))
    path = service.state_path(root)
    assert path.resolve().is_relative_to(tmp_path.resolve())
    path.parent.mkdir(parents=True)

    def put(payload):
        path.write_bytes(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

    return SimpleNamespace(root=root, path=path, put=put, fetch=fetch, health=health,
                           launch=launch, latest=latest)


def _active(state="installing", **overrides):
    return {"state": state, "updated_at": datetime.now(timezone.utc).isoformat(), **overrides}


def _prepare_branch(h, branch, monkeypatch, before_io=lambda: None):
    """Choose each existing status write without executing health/version programs."""
    refresh = branch not in {"stale", "stored_health"}
    if branch == "stale":
        h.put(_active("checking", updated_at=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()))
        age = service._state_age_seconds
        called = False

        def old_age(stored):
            nonlocal called
            result = age(stored)
            if not called:
                called = True
                before_io()
            return result

        monkeypatch.setattr(service, "_state_age_seconds", old_age)
    elif branch == "stored_health":
        h.put(_active("up_to_date", latest_version="1.0.0"))
        h.health.side_effect = lambda *args: (before_io(), (False, "synthetic damage"))[1]
    elif branch in {"latest_health", "up_to_date"}:
        h.latest["version"] = "1.0.0"
        h.health.side_effect = lambda *args: (before_io(), (branch == "up_to_date", "synthetic damage"))[1]
    else:
        h.fetch.side_effect = lambda *args: (before_io(), dict(h.latest))[1]
    return refresh


@pytest.mark.parametrize("content", BAD_CONTENTS)
@pytest.mark.parametrize("refresh", [False, True])
def test_invalid_state_blocks_work_and_status_without_io_or_overwrite(isolated, monkeypatch, caplog, content, refresh):
    h = isolated
    h.put(content)
    write = Mock(wraps=service.write_state)
    monkeypatch.setattr(service, "write_state", write)
    assert service.update_in_progress(h.root) is True
    status = service.get_status(root=h.root, refresh=refresh)
    assert status["state"] == "check_failed" and status["can_update"] is False
    assert status["install_mode"] == "release" and status["current_version"] == "1.0.0"
    assert status["latest_version"] == "" and status["updated_at"]
    assert h.path.read_bytes() == content
    assert "private-sentinel" not in json.dumps(status) + caplog.text
    assert str(h.path) not in json.dumps(status) + caplog.text
    h.fetch.assert_not_called()
    h.health.assert_not_called()
    write.assert_not_called()


@pytest.mark.parametrize("state", sorted(service._ACTIVE_STATES))
@pytest.mark.parametrize("bad_time", [None, "", "not-a-date"])
def test_active_state_with_unknown_age_is_preserved_and_blocks_start(isolated, state, bad_time):
    h = isolated
    h.put(_active(state, updated_at=bad_time))
    before = h.path.read_bytes()
    assert service.update_in_progress(h.root) is True
    status = service.get_status(root=h.root, refresh=True)
    assert status["state"] == state and status["can_update"] is False
    with pytest.raises(service.ReleaseUpdateError):
        service.start_update(root=h.root, activity_check=lambda: 0)
    assert h.path.read_bytes() == before
    h.fetch.assert_not_called()
    h.launch.assert_not_called()


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("content", BAD_CONTENTS)
def test_start_route_cannot_force_past_invalid_state(isolated, monkeypatch, force, content):
    from app.routers import release_update as router

    h = isolated
    h.put(content)
    monkeypatch.setattr(router, "_require_local", lambda request: None)
    monkeypatch.setattr(router, "_activity", lambda: {"active_total": 0})
    monkeypatch.setattr(router, "start_update", lambda **kwargs: service.start_update(root=h.root, **kwargs))
    with pytest.raises(HTTPException) as error:
        asyncio.run(router.release_update_start(router.UpdateStartIn(confirm=True, force=force), None, "1"))
    assert error.value.status_code == 400
    assert "상태" in error.value.detail
    assert h.path.read_bytes() == content
    h.fetch.assert_not_called()
    h.launch.assert_not_called()


def test_missing_first_use_and_normal_states_remain_usable(isolated):
    h = isolated
    assert service.update_in_progress(h.root) is False
    status = service.get_status(root=h.root, refresh=True)
    assert status["state"] == "available" and status["can_update"] is True
    for state in ("idle", "up_to_date", "available", "failed"):
        h.put(_active(state))
        assert service.update_in_progress(h.root) is False
    h.put(_active("checking", updated_at="2000-01-01T00:00:00+00:00"))
    assert service.update_in_progress(h.root) is False
    assert service.get_status(root=h.root)["state"] == "failed"


@pytest.mark.parametrize("failures", [1, 2, 3])
def test_unreadable_retries_are_bounded_and_transient_error_recovers(isolated, monkeypatch, failures):
    h = isolated
    h.put(_active("idle"))
    read_text = Path.read_text
    attempts = []
    pauses = Mock()
    monkeypatch.setattr(service, "time", SimpleNamespace(sleep=pauses), raising=False)

    def read(path, *args, **kwargs):
        if path == h.path:
            attempts.append(path)
            if len(attempts) <= failures:
                raise PermissionError("private-sentinel / synthetic-secret-path")
        return read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read)
    assert service.update_in_progress(h.root) is (failures == 3)
    assert len(attempts) == min(failures + 1, 3)
    assert pauses.call_count == min(failures, 2)
    assert all(call.args == (0.05,) for call in pauses.call_args_list)
    monkeypatch.setattr(Path, "read_text", read_text)
    assert service.update_in_progress(h.root) is False


@contextlib.contextmanager
def _exclusive_handle(path):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        assert kernel.CloseHandle(handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows file sharing contract")
@pytest.mark.parametrize("trial", range(10))
def test_windows_exclusive_lock_never_opens_gate_or_loses_state(isolated, trial):
    h = isolated
    h.put(_active())
    before = h.path.read_bytes()
    with _exclusive_handle(h.path):
        assert service._read_state(h.root) == {}  # Compatibility wrapper only; not the gate.
        assert service.update_in_progress(h.root) is True
        assert service.get_status(root=h.root, refresh=True)["state"] == "check_failed"
        with pytest.raises(service.ReleaseUpdateError):
            service.start_update(root=h.root, activity_check=lambda: 0)
    assert h.path.read_bytes() == before
    assert service.update_in_progress(h.root) is True
    h.put(_active("idle"))
    assert service.update_in_progress(h.root) is False
    h.fetch.assert_not_called()
    h.launch.assert_not_called()


@pytest.mark.parametrize("branch", WRITE_BRANCHES)
@pytest.mark.parametrize("new_state", ["active", "recovery", "invalid", "unreadable", "missing"])
def test_all_status_writes_reclassify_after_slow_preparation(isolated, monkeypatch, branch, new_state):
    h = isolated

    def replace():
        with service._START_LOCK:
            if new_state == "missing":
                h.path.unlink(missing_ok=True)  # Synthetic fixture only.
            elif new_state == "invalid":
                h.put(b"{")
            elif new_state == "unreadable":
                h.put(_active("idle", message="preserve inaccessible state"))
                read_text = Path.read_text

                def blocked(path, *args, **kwargs):
                    if path == h.path:
                        raise PermissionError("synthetic final-read denial")
                    return read_text(path, *args, **kwargs)

                monkeypatch.setattr(Path, "read_text", blocked)
            elif new_state == "recovery":
                h.put(_active("failed", recovery="recovery_required", message="preserve recovery"))
            else:
                h.put(_active("starting", message="preserve newer start"))

    refresh = _prepare_branch(h, branch, monkeypatch, replace)
    status = service.get_status(root=h.root, refresh=refresh)
    if new_state == "active":
        assert status["state"] == "starting" and status["can_update"] is False
        assert service._read_state(h.root)["message"] == "preserve newer start"
    elif new_state == "recovery":
        assert status["recovery"] == "recovery_required" and status["can_update"] is False
        assert service._read_state(h.root)["recovery"] == "recovery_required"
    elif new_state == "invalid":
        assert status["state"] == "check_failed" and status["can_update"] is False
        assert h.path.read_bytes() == b"{"
    elif new_state == "unreadable":
        assert status["state"] == "check_failed" and status["can_update"] is False
        assert json.loads(h.path.read_bytes())["message"] == "preserve inaccessible state"
    else:
        expected_state = "failed" if branch == "stale" else "up_to_date" if branch == "up_to_date" else "available"
        expected_version = "" if branch == "stale" else "2.0.0" if branch == "available" else "1.0.0"
        assert status["state"] == expected_state
        assert status["can_update"] is (branch != "up_to_date")
        assert status["current_version"] == "1.0.0" and status["latest_version"] == expected_version
        assert bool(status.get("repair_required")) is (branch in {"stored_health", "latest_health"})
        stored = json.loads(h.path.read_bytes())
        assert stored["message"] and stored["updated_at"]
        assert all(status[key] == value for key, value in stored.items())


def test_stale_refresh_at_current_version_serializes_both_writes(isolated, monkeypatch):
    h = isolated
    h.put(_active("checking", updated_at=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()))
    h.latest["version"] = "1.0.0"
    write = service.write_state
    writes = []

    def protected_write(*args, **kwargs):
        assert service._START_LOCK.locked()
        payload = write(*args, **kwargs)
        writes.append(payload)
        assert json.loads(h.path.read_bytes()) == payload
        return payload

    monkeypatch.setattr(service, "write_state", protected_write)
    status = service.get_status(root=h.root, refresh=True)
    assert [payload["state"] for payload in writes] == ["failed", "up_to_date"]
    assert status["state"] == "up_to_date" and status["can_update"] is False
    assert status["current_version"] == status["latest_version"] == "1.0.0"
    assert json.loads(h.path.read_bytes()) == writes[-1]
    assert all(status[key] == value for key, value in writes[-1].items())
    assert not service._START_LOCK.locked()


@pytest.mark.parametrize("branch", WRITE_BRANCHES)
def test_all_status_writes_hold_the_same_start_lock_but_slow_reads_do_not(isolated, monkeypatch, branch):
    h = isolated
    refresh = _prepare_branch(h, branch, monkeypatch)
    write, read_version = service.write_state, service._read_version
    writes = []

    def protected_write(*args, **kwargs):
        assert service._START_LOCK.locked()
        writes.append(args[0])
        return write(*args, **kwargs)

    def unlocked_version(root):
        assert not service._START_LOCK.locked()
        return read_version(root)

    fetch, health = h.fetch.side_effect, h.health.side_effect

    def unlocked_fetch(*args):
        assert not service._START_LOCK.locked()
        return fetch(*args)

    def unlocked_health(*args):
        assert not service._START_LOCK.locked()
        return health(*args) if health else h.health.return_value

    h.fetch.side_effect = unlocked_fetch
    h.health.side_effect = unlocked_health
    monkeypatch.setattr(service, "write_state", protected_write)
    monkeypatch.setattr(service, "_read_version", unlocked_version)
    service.get_status(root=h.root, refresh=refresh)
    assert len(writes) == 1


def test_status_lock_timeout_is_five_seconds_and_never_writes(isolated):
    h = isolated
    h.put(_active("available", latest_version="2.0.0"))
    before = h.path.read_bytes()
    with service._START_LOCK:
        started = time.monotonic()
        status = service.get_status(root=h.root, refresh=True)
        elapsed = time.monotonic() - started
    assert 4.8 <= elapsed < 7.0
    assert status["state"] == "available" and status["can_update"] is True
    assert h.path.read_bytes() == before


@pytest.mark.parametrize("last_state", ["missing", "active", "recovery", "invalid"])
def test_lock_timeout_reclassifies_last_state_without_writing_or_releasing(isolated, monkeypatch, last_state):
    h = isolated
    h.put(_active("available"))
    lock = SimpleNamespace(acquire=Mock(return_value=False), release=Mock())
    monkeypatch.setattr(service, "_START_LOCK", lock)

    def fetch(root):
        if last_state == "missing":
            h.path.unlink()
        elif last_state == "active":
            h.put(_active("checking"))
        elif last_state == "recovery":
            h.put(_active("failed", recovery="recovery_required"))
        else:
            h.put(b"{")
        return dict(h.latest)

    h.fetch.side_effect = fetch
    write = Mock(wraps=service.write_state)
    monkeypatch.setattr(service, "write_state", write)
    status = service.get_status(root=h.root, refresh=True)
    expected = {"missing": "check_failed", "active": "checking", "recovery": "failed", "invalid": "check_failed"}
    assert status["state"] == expected[last_state] and status["can_update"] is False
    assert status["current_version"] == "1.0.0" and "latest_version" in status
    lock.acquire.assert_called_once_with(timeout=5.0)
    lock.release.assert_not_called()
    write.assert_not_called()


def test_start_returns_its_starting_payload_when_post_launch_read_fails(isolated, monkeypatch):
    h = isolated
    read_text = Path.read_text

    def launch(*args):
        def blocked(path, *a, **kw):
            if path == h.path:
                raise PermissionError("synthetic post-launch sharing violation")
            return read_text(path, *a, **kw)
        monkeypatch.setattr(Path, "read_text", blocked)
        return 12345

    h.launch.side_effect = launch
    status = service.start_update(root=h.root, activity_check=lambda: 0)
    assert status["state"] == "starting" and status["accepted"] is True
    assert status["current_version"] == "1.0.0" and status["latest_version"] == "2.0.0"
    assert status["can_update"] is False


def test_atomic_writer_with_one_hundred_concurrent_reads_has_no_false_block(isolated):
    h = isolated
    service.write_state("idle", "synthetic initial", root=h.root)
    ready = threading.Event()
    writer_errors = []
    writer_successes = []

    def writer():
        ready.set()
        for _ in range(100):
            try:
                service.write_state("idle", "synthetic replacement", root=h.root)
                writer_successes.append(True)
            except OSError:
                # Windows may deny a writer while a reader is open; the old file remains valid.
                writer_errors.append(True)

    thread = threading.Thread(target=writer)
    # write_state itself must remain lock-free: start_update already owns this lock.
    with service._START_LOCK:
        thread.start()
        assert ready.wait(1)
        try:
            blocked = [service.update_in_progress(h.root) for _ in range(100)]
        finally:
            thread.join(20)
    assert not thread.is_alive()
    assert len(writer_successes) + len(writer_errors) == 100
    assert writer_successes, "At least one atomic replacement must succeed; failed writes alone prove nothing"
    assert blocked == [False] * 100
    assert service._read_state(h.root)["state"] == "idle"
    assert service._read_state(h.root)["message"] == "synthetic replacement"
    assert not list(h.path.parent.glob(".*.tmp"))


@pytest.mark.parametrize("branch", WRITE_BRANCHES)
def test_start_writer_cannot_enter_between_final_check_and_status_write(isolated, monkeypatch, branch):
    h = isolated
    refresh = _prepare_branch(h, branch, monkeypatch)
    write = service.write_state
    entered, attempted = threading.Event(), threading.Event()
    acquired_early = []
    errors = []

    def start_writer():
        try:
            assert entered.wait(2)
            acquired = service._START_LOCK.acquire(timeout=0.1)
            acquired_early.append(acquired)
            if acquired:
                service._START_LOCK.release()
            attempted.set()
            with service._START_LOCK:
                write("starting", "synthetic serialized start", root=h.root)
        except BaseException as exc:
            errors.append(exc)
            attempted.set()

    def paused_write(*args, **kwargs):
        entered.set()
        assert attempted.wait(2)
        assert acquired_early == [False]
        return write(*args, **kwargs)

    monkeypatch.setattr(service, "write_state", paused_write)
    thread = threading.Thread(target=start_writer)
    thread.start()
    try:
        service.get_status(root=h.root, refresh=refresh)
    finally:
        entered.set()
        thread.join(5)
    assert not thread.is_alive() and not errors
    assert service._read_state(h.root)["state"] == "starting"


@pytest.mark.parametrize("point", ["create", "begin", "comfy_before", "comfy_after", "resolve"])
def test_unreadable_state_blocks_each_admission_gate_with_clear_message(isolated, monkeypatch, point):
    from app.routers import comfy, gen_requests, resolve_integration
    from contextlib import nullcontext
    from fastapi import Request

    h = isolated
    h.put(_active("idle") if point in {"begin", "comfy_after"} else b"{")
    gate = lambda: service.update_in_progress(h.root)
    monkeypatch.setattr(gen_requests, "update_in_progress", gate)
    monkeypatch.setattr(comfy, "update_in_progress", gate)
    monkeypatch.setattr(resolve_integration, "update_in_progress", gate)
    released = AsyncMock()
    monkeypatch.setattr(gen_requests, "release_claim", released)
    monkeypatch.setattr(gen_requests, "_require_account", lambda request: {"email": "synthetic@example.invalid"})
    monkeypatch.setattr(gen_requests, "realtime_scope", lambda account: "synthetic")
    monkeypatch.setattr(gen_requests.agent_signals, "touch", Mock())
    monkeypatch.setattr(gen_requests, "_require_generation_deployment_open", AsyncMock(
        side_effect=AssertionError("Update gate allowed downstream deployment/DB access"),
    ))

    async def begin(*args):
        h.put(b"{")
        return True

    monkeypatch.setattr(gen_requests, "begin_submission", begin)
    monkeypatch.setattr(comfy, "_RUN_JOBS", {})
    monkeypatch.setattr(comfy, "_raw_settings", lambda: {"comfy_concurrency": 1})
    if point.startswith("comfy"):
        identity = comfy._ComfyIdentity(("", None), "local", None, "1" * 32, "2" * 16,
                                       {"comfy_concurrency": 1}, False)
        monkeypatch.setattr(comfy, "_comfy_request_scope", lambda request: nullcontext(identity))
        monkeypatch.setattr(comfy.run_journal, "read", lambda *_: [])
    worker_start = Mock()
    monkeypatch.setattr(comfy, "threading", SimpleNamespace(
        Thread=lambda **kwargs: SimpleNamespace(start=worker_start),
    ))
    stage = Mock(side_effect=lambda files: (h.put(b"{"), [])[1])
    monkeypatch.setattr(comfy, "_stage_media_uploads", stage)
    with pytest.raises(HTTPException) as error:
        if point == "create":
            asyncio.run(gen_requests.create_gen_request(None, None))
        elif point == "begin":
            asyncio.run(gen_requests.begin_gen_request_submission("synthetic-rid", None, "synthetic-agent"))
        elif point.startswith("comfy"):
            comfy.run(request=Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)}),
                      content='{"1":{"class_type":"SaveImage","inputs":{}}}',
                      param_values="{}", media_meta="[]", media=[])
        else:
            resolve_integration._reject_if_update_in_progress()
    assert error.value.status_code == 409
    assert "상태를 확인할 수 없어" in error.value.detail and "관리자" in error.value.detail
    assert released.await_count == int(point == "begin")
    assert stage.call_count == int(point == "comfy_after")
    worker_start.assert_not_called()
    assert not comfy._RUN_JOBS


def test_unreadable_state_keeps_agent_polling_idle_without_claims(isolated, monkeypatch):
    from app.routers import gen_requests

    h = isolated
    h.put(b"{")
    monkeypatch.setattr(gen_requests, "update_in_progress", lambda: service.update_in_progress(h.root))
    monkeypatch.setattr(gen_requests, "_require_account", lambda request: {"email": "synthetic@example.invalid"})
    monkeypatch.setattr(gen_requests.agent_signals, "touch", Mock())
    monkeypatch.setattr(gen_requests, "_require_generation_deployment_open", AsyncMock(
        side_effect=AssertionError("Update gate allowed downstream deployment/DB access"),
    ))
    claim = AsyncMock(side_effect=AssertionError("No claim while update state is unknown"))
    monkeypatch.setattr(gen_requests, "claim_gen_requests", claim)
    assert asyncio.run(gen_requests.pending_gen_requests_exist(None)) == {"pending": False}
    assert asyncio.run(gen_requests.pending_gen_requests(None)) == []
    claim.assert_not_awaited()
