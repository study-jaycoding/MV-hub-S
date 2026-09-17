"""Update-state writer failures use synthetic paths and never launch an updater."""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services import release_update as service


@pytest.fixture
def writer_case(tmp_path, monkeypatch):
    root = tmp_path / "synthetic-install"
    root.mkdir()
    (root / "VERSION.txt").write_text("1.0.0", encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(tmp_path / "unused"), encoding="utf-8")
    (root / "update_release.bat").write_text("not executable test data", encoding="utf-8")
    monkeypatch.setattr(service, "AUTH_ENABLED", False)
    monkeypatch.setattr(service, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(service, "_START_LOCK", threading.Lock())
    fetch = Mock(return_value={"version": "2.0.0", "higgsfield_cli_version": "test"})
    launch = Mock(return_value=12345)
    monkeypatch.setattr(service, "fetch_latest", fetch)
    monkeypatch.setattr(service, "_launch_bootstrap", launch)
    monkeypatch.setattr(service, "_installation_health", Mock(return_value=(True, "")))
    monkeypatch.setattr(service.subprocess, "Popen", Mock(side_effect=AssertionError("No process")))
    monkeypatch.setattr(service.urllib.request, "urlopen", Mock(side_effect=AssertionError("No network")))
    clock = SimpleNamespace(now=0.0, sleeps=[])

    def sleep(delay):
        clock.sleeps.append(delay)
        clock.now += delay

    # Replace this module's clock, not the stdlib clock used by pytest/asyncio.
    monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: clock.now, sleep=sleep))
    return SimpleNamespace(root=root, path=service.state_path(root), clock=clock, fetch=fetch, launch=launch)


def win_error(code):
    error = OSError("private-path-sentinel")
    error.winerror = code
    return error


@pytest.mark.parametrize("code", [5, 32, 33])
def test_transient_writer_retries_the_same_payload(writer_case, monkeypatch, code):
    h = writer_case
    real_write = service.atomic_write_text
    attempts = []

    def flaky(path, value):
        attempts.append((path, value))
        if len(attempts) < 3:
            raise win_error(code)
        return real_write(path, value)

    monkeypatch.setattr(service, "atomic_write_text", flaky)
    result = service.write_state("checking", "synthetic", root=h.root)
    assert len(attempts) == 3
    assert attempts[0] == attempts[1] == attempts[2]
    assert json.loads(h.path.read_text("utf-8")) == result
    assert h.clock.sleeps == [0.25, 0.25]
    assert not list(h.path.parent.glob("*.tmp"))


@pytest.mark.parametrize("code", [2, 3, 112, 123, 183, None])
def test_non_lock_errors_fail_immediately(writer_case, monkeypatch, code):
    h = writer_case
    fault = win_error(code)
    writer = Mock(side_effect=fault)
    monkeypatch.setattr(service, "atomic_write_text", writer)
    with pytest.raises(OSError) as caught:
        service.write_state("checking", "synthetic", root=h.root)
    assert caught.value is fault
    assert writer.call_count == 1
    assert h.clock.sleeps == []


@pytest.mark.parametrize("code", [5, 32, 33])
def test_permanent_lock_exhausts_budget_and_preserves_state(writer_case, monkeypatch, code):
    h = writer_case
    h.path.parent.mkdir(parents=True)
    h.path.write_text('{"state":"available"}', encoding="utf-8")
    original = h.path.read_bytes()
    writer = Mock(side_effect=win_error(code))
    monkeypatch.setattr(service, "atomic_write_text", writer)
    with pytest.raises(OSError):
        service.write_state("checking", "synthetic", root=h.root)
    assert 5.0 <= h.clock.now <= 5.25
    assert 20 <= writer.call_count <= 22
    assert h.path.read_bytes() == original
    # Temporary-file cleanup is covered by the real Windows writer drill;
    # this injected writer never creates a temporary file.


def test_writer_recreates_state_removed_during_retry(writer_case, monkeypatch):
    h = writer_case
    service.write_state("available", "previous", root=h.root)
    actual_write = service.atomic_write_text
    attempts = []

    def removed_once(path, payload):
        attempts.append(payload)
        if len(attempts) == 1:
            path.unlink()  # Only this fixture's synthetic state file.
            raise win_error(32)
        return actual_write(path, payload)

    monkeypatch.setattr(service, "atomic_write_text", removed_once)
    result = service.write_state("checking", "synthetic", root=h.root)
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert json.loads(h.path.read_text("utf-8")) == result
    assert h.clock.sleeps == [0.25]
    assert not list(h.path.parent.glob("*.tmp"))


def test_status_write_warning_does_not_include_exception_or_traceback(writer_case, monkeypatch, caplog):
    monkeypatch.setattr(service, "write_state", Mock(side_effect=win_error(112)))
    with caplog.at_level("WARNING", logger=service._log.name):
        result = service.get_status(root=writer_case.root, refresh=True)
    assert result["state"] == "check_failed" and result["can_update"] is False
    records = [record for record in caplog.records if record.name == service._log.name]
    assert records and records[-1].getMessage() == "Update state: write failed"
    assert all(record.exc_info is None for record in records)
    assert "private-path-sentinel" not in caplog.text


def test_initial_checking_write_failure_is_safe_and_not_rewritten(writer_case, monkeypatch):
    h = writer_case
    writer = Mock(side_effect=win_error(112))
    monkeypatch.setattr(service, "write_state", writer)
    with pytest.raises(service.ReleaseUpdateError) as caught:
        service.start_update(activity_check=lambda: 0, root=h.root)
    assert "private-path-sentinel" not in str(caught.value)
    assert [call.args[0] for call in writer.call_args_list] == ["checking"]
    h.fetch.assert_not_called()
    h.launch.assert_not_called()
    assert service._START_LOCK.acquire(blocking=False)
    service._START_LOCK.release()


@pytest.mark.parametrize("branch", ["stale", "stored_health", "latest_health", "up_to_date", "available"])
def test_status_write_failure_is_safe_and_releases_its_lock(writer_case, monkeypatch, branch):
    h = writer_case
    from datetime import datetime, timedelta, timezone

    refresh = branch not in {"stale", "stored_health"}
    stored = {}
    if branch == "stale":
        stored = {"state": "checking", "updated_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()}
    elif branch == "stored_health":
        stored = {"state": "up_to_date", "latest_version": "1.0.0"}
    if branch in {"latest_health", "up_to_date"}:
        h.fetch.return_value["version"] = "1.0.0"
    if branch in {"stored_health", "latest_health"}:
        service._installation_health.return_value = (False, "synthetic damage")
    if stored:
        h.path.parent.mkdir(parents=True)
        h.path.write_text(json.dumps(stored), encoding="utf-8")
    before = h.path.read_bytes() if h.path.exists() else None
    monkeypatch.setattr(service, "write_state", Mock(side_effect=win_error(112)))
    result = service.get_status(root=h.root, refresh=refresh)
    assert result["state"] == "check_failed"
    assert result["can_update"] is False
    assert "private-path-sentinel" not in json.dumps(result)
    assert (h.path.read_bytes() if h.path.exists() else None) == before
    h.launch.assert_not_called()
    assert service._START_LOCK.acquire(blocking=False)
    service._START_LOCK.release()


def test_busy_error_survives_failed_status_write(writer_case, monkeypatch):
    h = writer_case
    actual_write = service.write_state

    def write(state, *args, **kwargs):
        if state == "available":
            raise win_error(112)
        return actual_write(state, *args, **kwargs)

    monkeypatch.setattr(service, "write_state", write)
    activity = Mock(side_effect=[0, 1])
    with pytest.raises(service.ReleaseUpdateBusyError):
        service.start_update(activity_check=activity, root=h.root)
    h.launch.assert_not_called()


@pytest.mark.parametrize("original", [service.ReleaseUpdateError("safe original"), OSError("private-path-sentinel")])
def test_failed_status_write_preserves_safe_original_error(writer_case, monkeypatch, original):
    h = writer_case
    actual_write = service.write_state

    def write(state, *args, **kwargs):
        if state == "failed":
            raise OSError("second-private-sentinel")
        return actual_write(state, *args, **kwargs)

    monkeypatch.setattr(service, "write_state", write)
    h.fetch.side_effect = original
    with pytest.raises(service.ReleaseUpdateError) as caught:
        service.start_update(activity_check=lambda: 0, root=h.root)
    assert "private-sentinel" not in str(caught.value)
    assert "private-path-sentinel" not in str(caught.value)
    if isinstance(original, service.ReleaseUpdateError):
        assert caught.value is original
    h.launch.assert_not_called()


@pytest.mark.parametrize("target_state", ["starting", "up_to_date"])
def test_start_phase_write_failure_never_launches_worker(writer_case, monkeypatch, target_state):
    h = writer_case
    if target_state == "up_to_date":
        h.fetch.return_value["version"] = "1.0.0"
    actual_write = service.write_state
    states = []

    def write(state, *args, **kwargs):
        states.append(state)
        if state in {target_state, "failed"}:
            raise win_error(112)
        return actual_write(state, *args, **kwargs)

    monkeypatch.setattr(service, "write_state", write)
    with pytest.raises(service.ReleaseUpdateError) as caught:
        service.start_update(activity_check=lambda: 0, root=h.root)
    assert str(caught.value) == service._STATE_WRITE_FAILED_MESSAGE
    assert states == ["checking", target_state, "failed"]
    h.launch.assert_not_called()
    assert service._START_LOCK.acquire(blocking=False)
    service._START_LOCK.release()


@pytest.mark.parametrize("force", [False, True])
def test_actual_start_service_write_failure_maps_to_safe_http_400(writer_case, monkeypatch, force):
    import asyncio
    from fastapi import HTTPException
    from app.routers import release_update as route

    h = writer_case
    monkeypatch.setattr(service, "write_state", Mock(side_effect=win_error(112)))
    monkeypatch.setattr(route, "_require_local", lambda request: None)
    monkeypatch.setattr(route, "_activity", lambda: {"active_total": 0})
    monkeypatch.setattr(route, "start_update", lambda **kwargs: service.start_update(root=h.root, **kwargs))
    with pytest.raises(HTTPException) as caught:
        asyncio.run(route.release_update_start(route.UpdateStartIn(confirm=True, force=force), object(), "1"))
    assert caught.value.status_code == 400
    assert caught.value.detail == service._STATE_WRITE_FAILED_MESSAGE
    h.fetch.assert_not_called()
    h.launch.assert_not_called()
