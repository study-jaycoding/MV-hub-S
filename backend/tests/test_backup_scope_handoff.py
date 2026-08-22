"""BK-1 — poll에서 확정한 계정 scope를 백업 실행과 상태 정산까지 유지하는 계약."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest import mock

from app.services import backup


_CLEAN_SIGNATURE = (("content", 1, 1),)
_DIRTY_SIGNATURE = (("content", 2, 1),)


def _run_polls(worker: backup.PeriodicBackup, *, poll_count: int) -> None:
    sleep = mock.AsyncMock(
        side_effect=[*[None] * poll_count, asyncio.CancelledError()]
    )
    with mock.patch.object(backup.asyncio, "sleep", sleep):
        try:
            asyncio.run(worker._run())
        except asyncio.CancelledError:
            pass


def test_due_scope_is_used_even_if_account_switches_before_execution(
    tmp_path: Path,
    monkeypatch,
) -> None:
    scope_a = (tmp_path / "a.db", tmp_path / "backups-a", "a@example.com")
    scope_b = (tmp_path / "b.db", tmp_path / "backups-b", "b@example.com")
    current_scope = [scope_a]
    capture_scope = mock.Mock(side_effect=lambda: current_scope[0])
    monkeypatch.setattr(backup, "_capture_backup_scope", capture_scope)
    monkeypatch.setattr(
        backup.asyncio,
        "to_thread",
        mock.AsyncMock(
            side_effect=[
                (10.0, _CLEAN_SIGNATURE, False),
                (10.0, _DIRTY_SIGNATURE, True),
            ]
        ),
    )
    monkeypatch.setattr(backup, "_STARTUP_SKIP_IF_YOUNGER", 3_600.0)
    monkeypatch.setattr(backup, "_change_backup_due", lambda *_args, **_kwargs: True)

    executed: list[tuple[Path, Path]] = []
    overrides: list[str] = []

    def run_cycle(src: Path, backup_dir: Path, _callback) -> Path:
        executed.append((src, backup_dir))
        return backup_dir / "content_hub_test.db"

    async def run_inline(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(backup, "_run_backup_cycle", run_cycle)
    monkeypatch.setattr(backup, "to_thread_non_abandon", run_inline)
    monkeypatch.setattr(
        backup.active_account,
        "set_override",
        lambda account_key: overrides.append(account_key) or object(),
    )
    monkeypatch.setattr(backup.active_account, "reset_override", lambda _token: None)

    worker = backup.PeriodicBackup(interval=3_600.0)
    backup_once = worker._backup_once

    async def switch_then_execute(scope=None):
        # due 판정은 A에서 끝났지만 실제 _backup_once 진입 직전에 활성 계정은 B가 된다.
        current_scope[0] = scope_b
        return await backup_once(scope)

    worker._backup_once = switch_then_execute  # type: ignore[method-assign]
    _run_polls(worker, poll_count=1)

    assert executed == [(scope_a[0], scope_a[1])]
    assert overrides == [scope_a[2]]
    assert capture_scope.call_count == 2  # startup + poll; 실행 중 재캡처하지 않는다.


def test_account_switch_resets_dirty_baseline_to_new_scope(
    tmp_path: Path,
    monkeypatch,
) -> None:
    scope_a = (tmp_path / "a.db", tmp_path / "backups-a", "a@example.com")
    scope_b = (tmp_path / "b.db", tmp_path / "backups-b", "b@example.com")
    monkeypatch.setattr(
        backup,
        "_capture_backup_scope",
        mock.Mock(side_effect=[scope_a, scope_a, scope_b]),
    )
    monkeypatch.setattr(
        backup.asyncio,
        "to_thread",
        mock.AsyncMock(
            side_effect=[
                (10.0, _CLEAN_SIGNATURE, False),
                (10.0, _DIRTY_SIGNATURE, True),
                # A dirty와 서명이 같아도 B 자체는 최신 백업과 일치한다.
                (10.0, _DIRTY_SIGNATURE, False),
            ]
        ),
    )
    monkeypatch.setattr(backup, "_STARTUP_SKIP_IF_YOUNGER", 3_600.0)
    monkeypatch.setattr(backup.time, "monotonic", mock.Mock(return_value=100.0))
    changed_at_seen: list[float | None] = []

    def due_only_if_old_dirty(changed_at, _age, *, now) -> bool:
        changed_at_seen.append(changed_at)
        return len(changed_at_seen) == 2 and changed_at is not None

    monkeypatch.setattr(backup, "_change_backup_due", due_only_if_old_dirty)
    worker = backup.PeriodicBackup(interval=3_600.0)
    worker._backup_once = mock.AsyncMock(return_value=True)  # type: ignore[method-assign]

    _run_polls(worker, poll_count=2)

    assert changed_at_seen == [100.0, None]
    worker._backup_once.assert_not_awaited()  # type: ignore[union-attr]


def test_failed_backup_with_captured_scope_remains_due(
    tmp_path: Path,
    monkeypatch,
) -> None:
    scope_a = (tmp_path / "a.db", tmp_path / "backups-a", "a@example.com")
    monkeypatch.setattr(backup, "_capture_backup_scope", lambda: scope_a)
    monkeypatch.setattr(
        backup.asyncio,
        "to_thread",
        mock.AsyncMock(
            side_effect=[
                (10.0, _CLEAN_SIGNATURE, False),
                (10.0, _DIRTY_SIGNATURE, True),
                (10.0, _DIRTY_SIGNATURE, True),
            ]
        ),
    )
    monkeypatch.setattr(backup, "_STARTUP_SKIP_IF_YOUNGER", 3_600.0)
    monkeypatch.setattr(backup, "BACKUP_CHANGE_DEBOUNCE", 0.0)
    monkeypatch.setattr(backup, "BACKUP_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(backup.time, "monotonic", mock.Mock(return_value=100.0))
    worker = backup.PeriodicBackup(interval=3_600.0)
    worker._backup_once = mock.AsyncMock(return_value=False)  # type: ignore[method-assign]

    _run_polls(worker, poll_count=2)

    assert worker._backup_once.await_args_list == [  # type: ignore[union-attr]
        mock.call(scope_a),
        mock.call(scope_a),
    ]
