"""SY-1 — stuck synced 원격 확인 뒤 조건부 휴지통 이동 계약."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.services import syncer


def test_reconcile_stuck_synced_moves_only_definitive_missing_job():
    candidates = [
        ("gen-missing", "job-missing"),
        ("gen-existing", "job-existing"),
        ("gen-unknown", "job-unknown"),
    ]
    with (
        patch.object(syncer, "STUCK_SYNCED_AGE", 300.0),
        patch.object(syncer.time, "time", return_value=1_000.0),
        patch.object(
            syncer.repo,
            "list_stuck_synced_active",
            return_value=candidates,
        ) as select,
        patch.object(
            syncer.cli_bridge,
            "job_exists",
            new=AsyncMock(side_effect=[False, True, None]),
        ),
        patch.object(
            syncer.repo,
            "move_to_trash_if_stuck_synced",
            return_value=True,
        ) as guarded_move,
        patch.object(syncer.repo, "delete_generation") as unguarded_move,
    ):
        result = asyncio.run(syncer.reconcile_stuck_synced())

    assert result == 1
    select.assert_called_once_with(300.0)
    guarded_move.assert_called_once_with("gen-missing", "job-missing", 700.0)
    unguarded_move.assert_not_called()
