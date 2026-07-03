import unittest
from unittest import mock

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


if __name__ == "__main__":
    unittest.main()
