"""HF 원본 누락 검토 저장소의 신원 조회·상태 저장 배치 계약."""

from __future__ import annotations

import os
import tempfile
import unittest

from app import db, repo


class HfMissingRepoBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO generation(id, job_id, worker_id, creator_uid, prompt, model, status, "
                "created_at, sort_ts, hf_missing) VALUES(?,?,'me',?,'p','m','done','2026-01-01',?,1)",
                [
                    ("g1", "j1", "me", 2),
                    ("g2", "j2", "other", 1),
                ],
            )

    def tearDown(self) -> None:
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_identity_batch_chunks_large_input_and_omits_missing(self) -> None:
        ids = ["g1", "g2", *[f"missing-{index}" for index in range(899)]]

        identities = repo.get_generation_identities_batch(ids)

        self.assertEqual(identities, {"g1": ("me", "j1"), "g2": ("other", "j2")})

    def test_missing_flag_batch_uses_last_value_for_duplicate_id(self) -> None:
        repo.set_hf_missing_batch([("g1", False), ("g2", False), ("g1", True)])

        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT id, hf_missing FROM generation WHERE id IN ('g1','g2') ORDER BY id"
            ).fetchall()
        self.assertEqual([(row["id"], row["hf_missing"]) for row in rows], [("g1", 1), ("g2", 0)])


if __name__ == "__main__":
    unittest.main()
