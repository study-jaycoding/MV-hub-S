"""R8 Wave 2 Batch C — 계정 전환 중 usecase·백업·텔레메트리 범위 고정 계약."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import active_account, config, db, manage_db, repo
from app.repo import manage as repo_manage
from app.services import backup, telemetry_drain
from app.usecases import gen_requests


A_EMAIL = "scope-a@example.com"
B_EMAIL = "scope-b@example.com"
A_UID = "scope-a-uid"
B_UID = "scope-b-uid"


@pytest.fixture
def account_scope(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정 전환 환경."""
    token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    db.flush_pool()
    active_account.set_active(A_EMAIL, A_UID)
    try:
        yield tmp_path
    finally:
        db.flush_pool()
        active_account.reset_override(token)


def _wait_thread_event(event: threading.Event, timeout: float = 2.0) -> None:
    assert event.wait(timeout), "테스트 동기화 지점에 도달하지 못했습니다"


def _switch_without_waiting_for_work(email: str, uid: str) -> None:
    """느린 작업이 transition_lock을 쥐었다면 결정적으로 실패하되 테스트는 해제 가능하게 한다."""
    switched = threading.Event()

    def switch() -> None:
        active_account.set_active(email, uid)
        switched.set()

    thread = threading.Thread(target=switch)
    thread.start()
    assert switched.wait(0.5), "느린 작업이 계정 전환 락을 보유했습니다"
    thread.join(timeout=1)
    assert not thread.is_alive()


def test_gen_submit_keeps_every_db_step_on_request_account_after_switch(
    account_scope, monkeypatch
):
    """예약 직후 A→B로 바뀌어도 placeholder·활성화·조회는 모두 A DB를 본다."""
    command = gen_requests.GenRequestCommand(
        kind="create",
        email=A_EMAIL,
        creator_uid=A_UID,
        worker_id="worker-a",
        source_gen_id=None,
        data={"prompt": "scope", "model": "model", "params": {}},
        idempotency_key="11111111-1111-4111-8111-111111111111",
    )
    contract = gen_requests._idempotency_command_contract(command)
    reservation = {
        "kind": "create",
        "idempotency_key": command.idempotency_key,
        "payload": json.dumps({"_idempotency_contract": contract}),
        "gen_id": "gen-a",
        "status": "preparing",
    }
    seen_scopes: list[str | None] = []

    def observed(value=None, *, switch=False):
        def action(*_args, **_kwargs):
            seen_scopes.append(active_account.account_key())
            if switch:
                active_account.set_active(B_EMAIL, B_UID)
            return value

        return action

    mocked_repo = MagicMock()
    mocked_repo.reserve_idempotent_gen_request.side_effect = observed(
        reservation, switch=True
    )
    generation_results = iter((None, {"id": "gen-a"}))
    mocked_repo.get_generation.side_effect = lambda *_args, **_kwargs: (
        seen_scopes.append(active_account.account_key()) or next(generation_results)
    )
    mocked_repo.create_local_generation.side_effect = observed("gen-a")
    mocked_repo.gen_recipe.side_effect = observed(
        {"prompt": "scope", "model": "model", "params": {}}
    )
    mocked_repo.activate_idempotent_gen_request.side_effect = observed(
        {"id": "request-a", "activated": True}
    )
    journal = MagicMock(side_effect=observed(True))

    monkeypatch.setattr(gen_requests, "repo", mocked_repo)
    monkeypatch.setattr(gen_requests, "journal_generation_event", journal)
    monkeypatch.setattr(gen_requests, "MANAGE_ENABLED", False)
    monkeypatch.setattr(gen_requests, "agent_signals", MagicMock())

    result = asyncio.run(gen_requests.submit_gen_request(command))

    assert result == {"id": "gen-a"}
    assert seen_scopes and set(seen_scopes) == {A_EMAIL}
    assert active_account.account_key() == B_EMAIL


def test_gen_estimate_records_on_original_account_after_switch(
    account_scope, monkeypatch
):
    """견적 네트워크 대기 중 전환돼도 PM 갱신은 요청 계정 A에 기록한다."""

    async def scenario() -> list[str | None]:
        started = asyncio.Event()
        release = asyncio.Event()
        recorded: list[str | None] = []

        async def estimate(*_args):
            started.set()
            await release.wait()
            return {"credits": 7}

        def record(*_args, **_kwargs):
            recorded.append(active_account.account_key())

        monkeypatch.setattr(gen_requests.cli_bridge, "cli_available", lambda: True)
        monkeypatch.setattr(gen_requests.cli_bridge, "estimate_cost", AsyncMock(side_effect=estimate))
        monkeypatch.setattr(gen_requests, "pm_best_effort", record)

        task = asyncio.create_task(
            gen_requests._record_request_estimate(
                "gen-a",
                A_EMAIL,
                {"prompt": "p", "model": "m", "params": {}},
            )
        )
        await started.wait()
        active_account.set_active(B_EMAIL, B_UID)
        release.set()
        await task
        return recorded

    assert asyncio.run(scenario()) == [A_EMAIL]


def test_gen_sync_io_repeated_cancel_waits_for_db_worker(account_scope):
    """DB 스레드가 막힌 동안 반복 취소돼도 스레드 완료 전 usecase task가 끝나지 않는다."""

    async def scenario() -> None:
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()

        def db_work() -> None:
            started.set()
            assert release.wait(2)
            completed.set()

        task = asyncio.create_task(gen_requests._sync_io(db_work))
        while not started.is_set():
            await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0.02)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert completed.is_set()

    asyncio.run(scenario())


def test_backup_scope_rotation_and_callback_stay_on_a_during_switch(
    account_scope, monkeypatch
):
    """A 캡처 뒤 B로 전환해도 결과·회전·콜백은 A에만 적용되고 전환은 즉시 끝난다."""
    root = Path(account_scope)
    src_a = root / "source-a.db"
    src_b = root / "source-b.db"
    src_a.write_bytes(b"source-a")
    src_b.write_bytes(b"source-b")
    monkeypatch.setattr(backup, "BACKUP_DIR", root / "backups")
    monkeypatch.setattr(
        backup,
        "get_db_path",
        lambda: src_a if active_account.account_key() == A_EMAIL else src_b,
    )
    monkeypatch.setattr(backup, "BACKUP_KEEP", 1)
    monkeypatch.setattr(backup, "MANAGE_DB_PATH", root / "missing-manage.db")
    monkeypatch.setattr(backup, "validate_hub_db", lambda *_args, **_kwargs: None)

    a_dir = backup.BACKUP_DIR / active_account.slug(A_EMAIL)
    b_dir = backup.BACKUP_DIR / active_account.slug(B_EMAIL)
    a_dir.mkdir(parents=True)
    b_dir.mkdir(parents=True)
    old_a = a_dir / "content_hub_20000101_000000_000001.db"
    old_b = b_dir / "content_hub_20000101_000000_000001.db"
    old_a.write_bytes(b"old-a")
    old_b.write_bytes(b"old-b")
    started = threading.Event()
    release = threading.Event()

    def snapshot(_sources, snapshots) -> None:
        started.set()
        assert release.wait(2)
        for _label, _dest, tmp, _expected_table in snapshots:
            tmp.write_bytes(b"new-a")

    monkeypatch.setattr(backup, "_snapshot_database_set", snapshot)
    callback_paths: list[Path] = []
    callback_scopes: list[str | None] = []
    worker = backup.PeriodicBackup()

    def completed(path: Path) -> None:
        callback_paths.append(path)
        callback_scopes.append(active_account.account_key())

    worker.set_completed_callback(completed)

    async def scenario() -> None:
        task = asyncio.create_task(worker._backup_once())
        while not started.is_set():
            await asyncio.sleep(0)
        _switch_without_waiting_for_work(B_EMAIL, B_UID)
        release.set()
        await task

    asyncio.run(scenario())

    assert src_a.read_bytes() == b"source-a"
    assert src_b.read_bytes() == b"source-b"
    assert callback_scopes == [A_EMAIL]
    assert len(callback_paths) == 1 and callback_paths[0].parent == a_dir
    assert not old_a.exists()
    assert old_b.exists()
    assert len(list(a_dir.glob("content_hub_*.db"))) == 1
    assert len(list(b_dir.glob("content_hub_*.db"))) == 1


@pytest.mark.parametrize("blocked_stage", ["backup", "callback"])
def test_backup_repeated_cancel_waits_for_backup_and_callback(
    account_scope, monkeypatch, blocked_stage
):
    """백업 또는 성공 콜백이 멈춘 경우 반복 취소도 한 동기 사이클을 유기하지 않는다."""
    root = Path(account_scope)
    src = root / "source.db"
    path = root / "backups" / "content_hub_20260822_120000_000001.db"
    src.write_bytes(b"source")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"backup")
    started = threading.Event()
    release = threading.Event()
    completed = threading.Event()

    monkeypatch.setattr(
        backup,
        "_capture_backup_scope",
        lambda: (src, path.parent, A_EMAIL),
    )
    monkeypatch.setattr(backup, "log_event", lambda *_args, **_kwargs: None)

    def backup_now(*_args, **_kwargs) -> Path:
        if blocked_stage == "backup":
            started.set()
            assert release.wait(2)
            completed.set()
        return path

    def callback(_path: Path) -> None:
        assert active_account.account_key() == A_EMAIL
        if blocked_stage == "callback":
            started.set()
            assert release.wait(2)
            completed.set()

    monkeypatch.setattr(backup, "_backup_now_for_scope", backup_now)
    worker = backup.PeriodicBackup()
    worker.set_completed_callback(callback)

    async def scenario() -> None:
        task = asyncio.create_task(worker._backup_once())
        while not started.is_set():
            await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0.02)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert completed.is_set()
    assert src.exists() and path.exists()


def test_backup_callback_failure_is_separate_and_keeps_files(
    account_scope, monkeypatch
):
    """콜백 오류는 성공 백업을 실패로 바꾸거나 원본·백업을 삭제하지 않는다."""
    root = Path(account_scope)
    src = root / "source.db"
    path = root / "backups" / "content_hub_20260822_120000_000001.db"
    src.write_bytes(b"source")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"backup")
    events: list[str] = []
    monkeypatch.setattr(backup, "_backup_now_for_scope", lambda *_args: path)
    monkeypatch.setattr(
        backup,
        "log_event",
        lambda _logger, event, **_kwargs: events.append(event),
    )

    def broken_callback(_path: Path) -> None:
        raise RuntimeError("callback failed")

    result = backup._run_backup_cycle(src, path.parent, broken_callback)

    assert result == path
    assert events == ["backup_callback_failed", "backup_completed"]
    assert src.exists() and path.exists()


def _seed_telemetry_account(email: str, uid: str) -> None:
    active_account.set_active(email, uid)
    db.flush_pool()
    db.init_db()
    repo.set_setting("my_creator_uid", uid)
    repo.set_setting("provider_email", email)
    repo_manage.mark_telemetry_tombstone(
        "same-id",
        {"job_id": f"job-{uid}", "creator_uid": uid, "status": "done"},
    )


def _pending_for(email: str) -> int:
    token = active_account.set_override(email)
    try:
        return int(repo_manage.telemetry_outbox_status()["pending"])
    finally:
        active_account.reset_override(token)


@pytest.mark.parametrize("redirty_during_push", [False, True])
def test_remote_telemetry_settles_only_a_and_preserves_redirty(
    account_scope, monkeypatch, redirty_during_push
):
    """A/B 동일 ID에서도 A 스냅샷만 정산하며 전송 중 A 재dirty revision은 보존한다."""
    _seed_telemetry_account(A_EMAIL, A_UID)
    _seed_telemetry_account(B_EMAIL, B_UID)
    active_account.set_active(A_EMAIL, A_UID)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    started = threading.Event()
    release = threading.Event()
    captured: list[dict] = []
    result: dict = {}

    def push(items):
        captured.extend(items)
        started.set()
        assert release.wait(2)
        return {"upserted": len(items), "skipped": []}

    worker = threading.Thread(
        target=lambda: result.update(
            telemetry_drain.drain_remote_telemetry(push, my_uid=A_UID)
        )
    )
    worker.start()
    _wait_thread_event(started)
    _switch_without_waiting_for_work(B_EMAIL, B_UID)
    if redirty_during_push:
        token = active_account.set_override(A_EMAIL)
        try:
            repo_manage.mark_telemetry_tombstone(
                "same-id",
                {"job_id": "job-a-new", "creator_uid": A_UID, "status": "done"},
            )
        finally:
            active_account.reset_override(token)
    release.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert result == {"target": "remote", "upserted": 1, "failed": 0}
    assert [item["creator_uid"] for item in captured] == [A_UID]
    assert _pending_for(A_EMAIL) == int(redirty_during_push)
    assert _pending_for(B_EMAIL) == 1


def test_isolated_telemetry_keeps_captured_account_during_switch(
    account_scope, monkeypatch
):
    """격리 drain도 로컬 upsert가 느린 사이 전환돼도 A만 정산한다."""
    root = Path(account_scope)
    _seed_telemetry_account(A_EMAIL, A_UID)
    _seed_telemetry_account(B_EMAIL, B_UID)
    active_account.set_active(A_EMAIL, A_UID)
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    monkeypatch.setattr(telemetry_drain, "MANAGE_ENABLED", True)
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", root / "manage_hub.db")
    started = threading.Event()
    release = threading.Event()
    upserted_uids: list[str] = []
    result: dict = {}

    def slow_upsert(_email: str, uid: str, _items):
        upserted_uids.append(uid)
        started.set()
        assert release.wait(2)
        return 1, []

    monkeypatch.setattr(telemetry_drain, "upsert_facts", slow_upsert)
    worker = threading.Thread(
        target=lambda: result.update(telemetry_drain.drain_isolated_telemetry())
    )
    worker.start()
    _wait_thread_event(started)
    _switch_without_waiting_for_work(B_EMAIL, B_UID)
    release.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert result == {"target": "local", "upserted": 1, "failed": 0}
    assert upserted_uids == [A_UID]
    assert _pending_for(A_EMAIL) == 0
    assert _pending_for(B_EMAIL) == 1
