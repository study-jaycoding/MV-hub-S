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
            mock.patch.object(ingest.repo, "upsert_synced_generation", return_value="inserted") as upsert,
        ):
            out = ingest._ingest_core(acc, jobs, None, {"email": "artist@example.com"})

        self.assertEqual(out.inserted, 1)
        self.assertEqual(out.skipped, 1)
        self.assertEqual(upsert.call_count, 1)


if __name__ == "__main__":
    unittest.main()
