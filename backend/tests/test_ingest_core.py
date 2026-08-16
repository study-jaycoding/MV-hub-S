import unittest
from types import SimpleNamespace
from unittest import mock

from app.models import AccountReportIn, IngestIn, IngestMcpIn, IngestOut
from app.routers import ingest


class IngestCoreTests(unittest.TestCase):
    def test_duplicate_job_ids_in_one_payload_are_skipped(self):
        acc = {"email": "artist@example.com", "creator_uid": "user_artist"}
        jobs = [
            {
                "id": "job_1",
                "status": "completed",
                "result_url": "https://cdn.example.com/user_artist/result.mp4",
                "created_at": 1,
                "params": {"prompt": "a"},
            },
            {
                "id": "job_1",
                "status": "completed",
                "result_url": "https://cdn.example.com/user_artist/result.mp4",
                "created_at": 1,
                "params": {"prompt": "a"},
            },
        ]

        with (
            mock.patch.object(ingest, "AUTH_ENABLED", True),
            # 배치 업서트(apply_synced_jobs) 경로 — 받은 잡 수만큼 inserted 로 응답하는 가짜.
            # dedup 이 제대로면 스테이징 1건만 넘어와 inserted=1 이어야 한다.
            mock.patch.object(
                ingest.repo,
                "apply_synced_jobs",
                side_effect=lambda staged, wid: {
                    "inserted": len(staged), "updated": 0, "unchanged": 0, "errors": 0,
                },
            ) as upsert,
            mock.patch.object(ingest.repo, "record_account_status") as record_status,
        ):
            out = ingest._ingest_core(acc, jobs, None, {"email": "artist@example.com"})

        self.assertEqual(out.inserted, 1)
        self.assertEqual(out.skipped, 1)
        self.assertEqual(upsert.call_count, 1)
        self.assertEqual(len(upsert.call_args[0][0]), 1)  # 중복 제거 후 1건만 배치로 전달
        record_status.assert_called_once()

    def test_ingest_schedules_telemetry_without_synchronous_network_drain(self):
        expected = IngestOut(
            inserted=0, updated=0, unchanged=0, skipped=0, errors=0, linked_uid="u_me"
        )
        with (
            mock.patch.object(ingest, "MANAGE_ENABLED", True),
            mock.patch.object(ingest, "_agent_acc", return_value={"email": "me@example.com"}),
            mock.patch.object(ingest, "_ingest_core", return_value=expected),
            mock.patch.object(ingest, "schedule_telemetry_drain", return_value=True) as schedule,
        ):
            result = ingest.ingest(IngestIn(), SimpleNamespace())

        self.assertIs(result, expected)
        schedule.assert_called_once_with()

    def test_ingest_queues_account_reports_without_synchronous_proxy(self):
        from app.repo import manage

        expected = IngestOut(linked_uid="u_me")
        body = IngestIn(
            account_status={"email": "me@example.com", "credits": 10},
            account_transactions=[
                {
                    "created_at": "2026-08-16T01:00:00Z",
                    "credits": -2,
                    "action": "spend",
                    "display_name": "Model A",
                }
            ],
        )
        with (
            mock.patch.object(ingest, "MANAGE_ENABLED", True),
            mock.patch.object(ingest, "_agent_acc", return_value={"email": "me@example.com"}),
            mock.patch.object(ingest, "_ingest_core", return_value=expected),
            mock.patch.object(ingest._proxy, "proxying", return_value=True),
            mock.patch.object(ingest._proxy, "proxy_json") as proxy_json,
            mock.patch.object(manage, "record_transactions"),
            mock.patch.object(
                manage,
                "queue_account_reports",
                return_value={"status": 1, "transactions": 1},
            ) as queue,
            mock.patch.object(ingest, "schedule_telemetry_drain", return_value=True) as schedule,
        ):
            result = ingest.ingest(body, SimpleNamespace())

        self.assertIs(result, expected)
        queue.assert_called_once_with(body.account_status, body.account_transactions)
        proxy_json.assert_not_called()
        schedule.assert_called_once_with()

    def test_account_report_endpoint_acknowledges_only_after_both_writes(self):
        from app.repo import manage

        body = AccountReportIn(
            account_status={"email": "me@example.com", "credits": 10},
            account_transactions=[
                {
                    "created_at": "2026-08-16T01:00:00Z",
                    "credits": -2,
                    "action": "spend",
                    "display_name": "Model A",
                }
            ],
            creator_uid="u_me",
        )
        with (
            mock.patch.object(ingest, "MANAGE_ENABLED", True),
            mock.patch.object(ingest, "_agent_acc", return_value={"email": "me@example.com"}),
            mock.patch.object(ingest, "_ingest_core", return_value=IngestOut(linked_uid="u_me")) as core,
            mock.patch.object(
                manage,
                "record_transactions",
                return_value={"inserted": 1, "matched": 1},
            ) as record,
        ):
            result = ingest.ingest_account_report(body, SimpleNamespace())

        self.assertTrue(result.accepted)
        self.assertEqual(result.transactions_inserted, 1)
        self.assertEqual(result.transactions_matched, 1)
        core.assert_called_once_with(
            {"email": "me@example.com"}, [], "u_me", body.account_status
        )
        record.assert_called_once_with("u_me", "me@example.com", body.account_transactions)

    def test_mcp_backfill_schedules_telemetry_without_synchronous_network_drain(self):
        expected = IngestOut(
            inserted=0, updated=0, unchanged=0, skipped=0, errors=0, linked_uid="u_me"
        )
        with (
            mock.patch.object(ingest, "MANAGE_ENABLED", True),
            mock.patch.object(ingest, "_agent_acc", return_value={"email": "me@example.com"}),
            mock.patch.object(ingest, "_ingest_core", return_value=expected),
            mock.patch.object(ingest, "schedule_telemetry_drain", return_value=True) as schedule,
        ):
            result = ingest.ingest_mcp(IngestMcpIn(), SimpleNamespace())

        self.assertIs(result, expected)
        schedule.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
