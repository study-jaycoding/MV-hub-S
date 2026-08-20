"""주기·수동 CLI 동기화가 관리 텔레메트리 계약을 빠뜨리지 않는지 검증한다."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.repo import manage
from app.routers import sync as sync_router
from app.services import syncer


class SyncerTelemetryTests(unittest.TestCase):
    def test_sync_now_marks_changes_and_backfills_pre_rl03_rows(self):
        jobs = [
            {"generation": {"id": "job-changed"}},
            {"generation": {"id": "job-old"}},
        ]

        def apply_jobs(items, worker_id, *, changed_job_ids, track_telemetry):
            self.assertEqual(items, jobs)
            self.assertTrue(worker_id)
            self.assertTrue(track_telemetry)
            changed_job_ids.add("job-changed")
            return {
                "inserted": 0,
                "updated": 1,
                "unchanged": 1,
                "errors": 0,
                "telemetry_dirty": 1,
                "telemetry_backfilled": 1,
            }

        with patch.object(syncer, "MANAGE_ENABLED", True), patch.object(
            syncer.cli_bridge, "list_jobs", AsyncMock(return_value=jobs)
        ), patch.object(syncer.repo, "apply_synced_jobs", side_effect=apply_jobs), patch.object(
            manage, "telemetry_outbox_status", return_value={"pending": 2}
        ) as outbox_status:
            result = asyncio.run(syncer.sync_now())

        outbox_status.assert_called_once_with()
        self.assertEqual(result["telemetry_dirty"], 1)
        self.assertEqual(result["telemetry_backfilled"], 1)
        self.assertEqual(result["telemetry_pending"], 2)
        self.assertEqual(result["fetched"], 2)

    def test_manual_sync_schedules_drain_when_outbox_changed(self):
        counts = {
            "fetched": 2,
            "inserted": 1,
            "updated": 0,
            "telemetry_pending": 1,
        }
        with patch.object(
            sync_router.syncer, "sync_now", AsyncMock(return_value=counts)
        ), patch.object(sync_router, "schedule_telemetry_drain") as schedule:
            result = asyncio.run(sync_router.sync_from_cli())

        schedule.assert_called_once_with()
        self.assertEqual(result.fetched, 2)
        self.assertEqual(result.inserted, 1)

    def test_periodic_sync_drains_isolated_dashboard_after_dirty_mark(self):
        worker = syncer.PeriodicSync(interval=0.01)
        with patch.object(
            syncer.asyncio,
            "sleep",
            AsyncMock(side_effect=[None, asyncio.CancelledError()]),
        ), patch.object(
            syncer, "sync_now", AsyncMock(return_value={
                "inserted": 0,
                "updated": 0,
                "telemetry_pending": 1,
                "gap_warning": 0,
            })
        ), patch(
            "app.services.telemetry_drain.drain_isolated_telemetry"
        ) as drain:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(worker._run())

        drain.assert_called_once_with()

    def test_periodic_sync_cli_failure_emits_structured_warning(self):
        worker = syncer.PeriodicSync(interval=0.01)
        with patch.object(
            syncer.asyncio,
            "sleep",
            AsyncMock(side_effect=[None, asyncio.CancelledError()]),
        ), patch.object(
            syncer,
            "sync_now",
            AsyncMock(side_effect=syncer.cli_bridge.CLIError("login token hidden")),
        ), patch.object(syncer, "log_event") as log_event:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(worker._run())

        log_event.assert_called_once_with(
            syncer._log,
            "periodic_sync_cli_failed",
            level=syncer.logging.WARNING,
            error_type="CLIError",
        )


if __name__ == "__main__":
    unittest.main()
