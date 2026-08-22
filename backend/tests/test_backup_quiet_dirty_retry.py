"""BK-2 — quiet-dirty 백업 시도의 성공 여부에 따른 상태 정산 계약."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest import mock

from app.services import backup


_CLEAN_SIGNATURE = (("content", 1, 1),)
_DIRTY_SIGNATURE = (("content", 2, 1),)


def _run_worker_polls(
    worker: backup.PeriodicBackup,
    states: list[tuple[float | None, tuple[tuple[str, int, int], ...], bool]],
    *,
    poll_count: int,
) -> None:
    """초기 상태 뒤 지정한 poll 수만 실행하고 워커를 취소한다."""
    sleep = mock.AsyncMock(
        side_effect=[*[None] * poll_count, asyncio.CancelledError()]
    )
    with (
        mock.patch.object(backup.asyncio, "sleep", sleep),
        mock.patch.object(backup.asyncio, "to_thread", mock.AsyncMock(side_effect=states)),
        mock.patch.object(backup, "_STARTUP_SKIP_IF_YOUNGER", 3_600.0),
        mock.patch.object(backup, "BACKUP_CHANGE_DEBOUNCE", 0.0),
        mock.patch.object(backup, "BACKUP_MIN_INTERVAL", 0.0),
    ):
        try:
            asyncio.run(worker._run())
        except asyncio.CancelledError:
            pass


def test_failed_quiet_dirty_backup_remains_due_on_next_poll() -> None:
    worker = backup.PeriodicBackup(interval=3_600.0)
    worker._backup_once = mock.AsyncMock(return_value=False)  # type: ignore[method-assign]

    _run_worker_polls(
        worker,
        [
            (10.0, _CLEAN_SIGNATURE, False),
            (10.0, _DIRTY_SIGNATURE, True),
            (10.0, _DIRTY_SIGNATURE, True),
        ],
        poll_count=2,
    )

    assert worker._backup_once.await_count == 2  # type: ignore[union-attr]


def test_dirty_state_is_cleared_only_after_backup_success() -> None:
    worker = backup.PeriodicBackup(interval=3_600.0)
    worker._backup_once = mock.AsyncMock(  # type: ignore[method-assign]
        side_effect=[False, True]
    )

    _run_worker_polls(
        worker,
        [
            (10.0, _CLEAN_SIGNATURE, False),
            (10.0, _DIRTY_SIGNATURE, True),
            (10.0, _DIRTY_SIGNATURE, True),
            (10.0, _DIRTY_SIGNATURE, True),
        ],
        poll_count=3,
    )

    assert worker._backup_once.await_count == 2  # type: ignore[union-attr]


def test_callback_failure_still_settles_local_backup_success(
    tmp_path: Path,
    monkeypatch,
) -> None:
    src = tmp_path / "source.db"
    backup_dir = tmp_path / "backups"
    path = backup_dir / "content_hub_20260822_120000_000001.db"
    src.write_bytes(b"source")
    backup_dir.mkdir()
    path.write_bytes(b"backup")
    events: list[str] = []

    monkeypatch.setattr(
        backup,
        "_capture_backup_scope",
        lambda: (src, backup_dir, ""),
    )
    backup_now = mock.Mock(return_value=path)
    monkeypatch.setattr(backup, "_backup_now_for_scope", backup_now)
    monkeypatch.setattr(
        backup,
        "log_event",
        lambda _logger, event, **_kwargs: events.append(event),
    )

    async def run_inline(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(backup, "to_thread_non_abandon", run_inline)
    worker = backup.PeriodicBackup(interval=3_600.0)

    def broken_callback(_path: Path) -> None:
        raise RuntimeError("callback failed")

    worker.set_completed_callback(broken_callback)
    _run_worker_polls(
        worker,
        [
            (10.0, _CLEAN_SIGNATURE, False),
            (10.0, _DIRTY_SIGNATURE, True),
            (10.0, _DIRTY_SIGNATURE, True),
        ],
        poll_count=2,
    )

    assert backup_now.call_count == 1
    assert events == ["backup_callback_failed", "backup_completed"]


def test_missing_source_clears_obsolete_dirty_state(
    tmp_path: Path,
    monkeypatch,
) -> None:
    src = tmp_path / "missing.db"
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(
        backup,
        "_capture_backup_scope",
        lambda: (src, backup_dir, ""),
    )

    async def run_inline(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(backup, "to_thread_non_abandon", run_inline)
    worker = backup.PeriodicBackup(interval=3_600.0)

    assert asyncio.run(worker._backup_once()) is False
    backup_once = mock.AsyncMock(wraps=worker._backup_once)
    worker._backup_once = backup_once  # type: ignore[method-assign]

    _run_worker_polls(
        worker,
        [
            (10.0, _CLEAN_SIGNATURE, False),
            (10.0, (), False),
            (10.0, (), False),
        ],
        poll_count=2,
    )

    # 첫 poll의 대상 없음 시도 뒤에는 빈 서명이 dirty 재시도를 만들지 않는다.
    assert backup_once.await_count == 1
    assert not backup_dir.exists()
