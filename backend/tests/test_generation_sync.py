"""CLI 생성 결과 동기화 저장소의 트랜잭션·멱등·삭제 불변식."""

from __future__ import annotations

import os
import tempfile
import unittest

from app import db, repo


class GenerationSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    @staticmethod
    def parsed(job_id: str, *, status: str = "done", creator_uid: str = "u_one") -> dict:
        return {
            "generation": {
                "id": job_id,
                "prompt": "prompt",
                "model": "image-model",
                "params": {"prompt": "prompt"},
                "status": status,
                "created_at": "2026-08-05T00:00:00Z",
                "sort_ts": 1_754_352_000.0,
                "creator_uid": creator_uid,
            },
            "asset": None
            if status != "done"
            else {"type": "image", "file_path": f"https://cdn.example/{job_id}.png"},
            "references": [],
        }

    def test_batch_insert_update_and_known_job_scope(self) -> None:
        running = self.parsed("job-1", status="running")
        self.assertEqual(
            repo.apply_synced_jobs([running], "me"),
            {"inserted": 1, "updated": 0, "unchanged": 0, "errors": 0},
        )
        self.assertEqual(repo.known_job_ids("u_one"), ["job-1"])
        self.assertEqual(
            repo.job_id_sync_diff(["job-1", "job-2"], "u_one"),
            {"unknown": ["job-2"], "refresh": ["job-1"]},
        )
        self.assertEqual(repo.unknown_job_ids(["job-1", "job-2"], "u_one"), ["job-2"])
        self.assertEqual(repo.unknown_job_ids(["job-1"], "u_other"), ["job-1"])

        done = self.parsed("job-1")
        self.assertEqual(repo.upsert_synced_generation(done, "me"), "updated")
        self.assertEqual(repo.upsert_synced_generation(done, "me"), "unchanged")
        self.assertEqual(
            repo.job_id_sync_diff(["job-1"], "u_one"),
            {"unknown": [], "refresh": []},
        )
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT id, status FROM generation WHERE job_id='job-1'"
            ).fetchone()
            self.assertEqual(row["status"], "done")
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM asset WHERE generation_id=?", (row["id"],)
                ).fetchone()["c"],
                1,
            )

    def test_legacy_waiting_synced_job_is_selected_for_repair(self) -> None:
        waiting = self.parsed("job-waiting", status="waiting")
        self.assertEqual(repo.upsert_synced_generation(waiting, "me"), "inserted")
        self.assertEqual(
            repo.job_id_sync_diff(["job-waiting"], "u_one"),
            {"unknown": [], "refresh": ["job-waiting"]},
        )

        self.assertEqual(
            repo.upsert_synced_generation(
                self.parsed("job-waiting", status="done"), "me"
            ),
            "updated",
        )
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT id, status FROM generation WHERE job_id='job-waiting'"
            ).fetchone()
            self.assertEqual(row["status"], "done")
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM asset WHERE generation_id=?", (row["id"],)
                ).fetchone()["c"],
                1,
            )

    def test_bad_item_rolls_back_only_its_savepoint(self) -> None:
        broken = self.parsed("job-bad")
        del broken["generation"]["prompt"]
        result = repo.apply_synced_jobs(
            [self.parsed("job-good-1"), broken, self.parsed("job-good-2")], "me"
        )
        self.assertEqual(
            result,
            {"inserted": 2, "updated": 0, "unchanged": 0, "errors": 1},
        )
        self.assertEqual(
            set(repo.known_job_ids("u_one")), {"job-good-1", "job-good-2"}
        )

    def test_trashed_job_is_not_revived_by_sync(self) -> None:
        parsed = self.parsed("job-trashed")
        self.assertEqual(repo.upsert_synced_generation(parsed, "me"), "inserted")
        with db.get_connection() as conn:
            gen_id = conn.execute(
                "SELECT id FROM generation WHERE job_id='job-trashed'"
            ).fetchone()["id"]
        self.assertTrue(repo.delete_generation(gen_id))

        self.assertEqual(repo.upsert_synced_generation(parsed, "me"), "unchanged")
        with db.get_connection() as conn:
            self.assertIsNone(
                conn.execute(
                    "SELECT id FROM generation WHERE job_id='job-trashed'"
                ).fetchone()
            )


if __name__ == "__main__":
    unittest.main()
