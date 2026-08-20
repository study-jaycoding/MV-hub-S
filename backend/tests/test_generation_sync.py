"""CLI 생성 결과 동기화 저장소의 트랜잭션·멱등·삭제 불변식."""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest.mock import patch

from app import db, repo
from app.repo import manage
from app.repo.generation_sync import NO_REVIVE_ERROR


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

    def test_url_adopt_requires_the_same_creator(self) -> None:
        owner_id = repo.create_local_generation(
            {"prompt": "owner prompt", "model": "image-model", "params": {}},
            "me",
            creator_uid="u_owner",
        )
        shared_url = "https://cdn.example/shared-result.png"
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET status='done', job_id='owner-job' WHERE id=?",
                (owner_id,),
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, source_url) "
                "VALUES('owner-asset', ?, 'image', ?, ?)",
                (owner_id, shared_url, shared_url),
            )

        incoming = self.parsed("other-job", creator_uid="u_other")
        incoming["asset"]["file_path"] = shared_url
        self.assertEqual(repo.upsert_synced_generation(incoming, "me"), "inserted")

        with db.get_connection() as conn:
            owner = conn.execute(
                "SELECT status, job_id, creator_uid FROM generation WHERE id=?", (owner_id,)
            ).fetchone()
            other = conn.execute(
                "SELECT id, creator_uid FROM generation WHERE job_id='other-job'"
            ).fetchone()
        self.assertEqual(
            dict(owner),
            {
                "status": "done",
                "job_id": "owner-job",
                "creator_uid": "u_owner",
            },
        )
        self.assertIsNotNone(other)
        self.assertNotEqual(other["id"], owner_id)
        self.assertEqual(other["creator_uid"], "u_other")

    def test_url_adopt_still_recovers_same_creator_local_row(self) -> None:
        local_id = repo.create_local_generation(
            {"prompt": "local prompt", "model": "image-model", "params": {}},
            "me",
            creator_uid="u_one",
        )
        result_url = "https://cdn.example/recovered-result.png"
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, source_url) "
                "VALUES('local-asset', ?, 'image', ?, ?)",
                (local_id, result_url, result_url),
            )

        parsed = self.parsed("recovered-job")
        parsed["asset"]["file_path"] = result_url
        self.assertEqual(repo.upsert_synced_generation(parsed, "me"), "updated")

        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT id, job_id, creator_uid FROM generation"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], local_id)
        self.assertEqual(rows[0]["job_id"], "recovered-job")
        self.assertEqual(rows[0]["creator_uid"], "u_one")

    def test_url_adopt_accepts_verified_account_transition_alias(self) -> None:
        local_id = repo.create_local_generation(
            {"prompt": "local prompt", "model": "image-model", "params": {}},
            "me",
            creator_uid="acct:artist@example.com",
        )
        result_url = "https://cdn.example/account-transition.png"
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, source_url) "
                "VALUES('transition-asset', ?, 'image', ?, ?)",
                (local_id, result_url, result_url),
            )

        parsed = self.parsed("transition-job", creator_uid="user_artist")
        parsed["asset"]["file_path"] = result_url
        counts = repo.apply_synced_jobs(
            [parsed], "me", adopt_owner_uid="acct:artist@example.com"
        )

        self.assertEqual(counts["updated"], 1)
        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT id, job_id, creator_uid FROM generation"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], local_id)
        self.assertEqual(rows[0]["job_id"], "transition-job")
        self.assertEqual(rows[0]["creator_uid"], "user_artist")

    def test_bad_item_rolls_back_only_its_savepoint(self) -> None:
        broken = self.parsed("job-bad")
        del broken["generation"]["prompt"]
        changed_job_ids: set[str] = set()
        result = repo.apply_synced_jobs(
            [self.parsed("job-good-1"), broken, self.parsed("job-good-2")],
            "me",
            changed_job_ids=changed_job_ids,
        )
        self.assertEqual(
            result,
            {"inserted": 2, "updated": 0, "unchanged": 0, "errors": 1},
        )
        self.assertEqual(
            set(repo.known_job_ids("u_one")), {"job-good-1", "job-good-2"}
        )
        self.assertEqual(changed_job_ids, {"job-good-1", "job-good-2"})

    def test_telemetry_tracking_is_atomic_and_backfills_only_once(self) -> None:
        first = repo.apply_synced_jobs(
            [self.parsed("job-atomic")], "me", track_telemetry=True
        )
        self.assertEqual(first["telemetry_dirty"], 1)
        self.assertEqual(first["telemetry_backfilled"], 0)
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 1)

        item = manage.list_dirty_telemetry()[0]
        manage.mark_telemetry_pushed([item])
        same = repo.apply_synced_jobs(
            [self.parsed("job-atomic")], "me", track_telemetry=True
        )
        self.assertEqual(same["telemetry_dirty"], 0)
        self.assertEqual(same["telemetry_backfilled"], 0)
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

        repo.apply_synced_jobs([self.parsed("job-historical")], "me")
        backfill = repo.apply_synced_jobs(
            [self.parsed("job-historical")], "me", track_telemetry=True
        )
        self.assertEqual(backfill["telemetry_dirty"], 0)
        self.assertEqual(backfill["telemetry_backfilled"], 1)

    def test_telemetry_failure_rolls_back_generation_and_change_report(self) -> None:
        changed_job_ids: set[str] = set()
        with patch(
            "app.repo.manage_telemetry.track_ingested_in_connection",
            side_effect=RuntimeError("outbox unavailable"),
        ):
            with self.assertRaisesRegex(RuntimeError, "outbox unavailable"):
                repo.apply_synced_jobs(
                    [self.parsed("job-rollback")],
                    "me",
                    changed_job_ids=changed_job_ids,
                    track_telemetry=True,
                )

        self.assertEqual(repo.known_job_ids("u_one"), [])
        self.assertEqual(changed_job_ids, set())
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

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

    def test_invalid_input_result_is_visible_as_separate_local_quarantine(self) -> None:
        original_id = repo.create_local_generation(
            {"prompt": "prompt", "model": "image-model", "params": {}},
            "me",
            creator_uid="u_one",
        )
        repo.create_gen_request(
            "artist@example.com",
            "u_one",
            original_id,
            "create",
            repo.gen_recipe(original_id),
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET status='failed', error=?, job_id='job-invalid' WHERE id=?",
                (NO_REVIVE_ERROR, original_id),
            )
            conn.execute(
                "UPDATE gen_request SET status='failed', error=? WHERE gen_id=?",
                (NO_REVIVE_ERROR, original_id),
            )

        # 실패 placeholder만 있을 때는 agent가 실제 유료 결과를 한 번 더 보내도록 refresh한다.
        self.assertEqual(
            repo.job_id_sync_diff(["job-invalid"], "u_one"),
            {"unknown": [], "refresh": ["job-invalid"]},
        )
        self.assertEqual(
            repo.upsert_synced_generation(self.parsed("job-invalid"), "me"),
            "inserted",
        )
        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT id, origin, status FROM generation WHERE job_id='job-invalid' "
                "ORDER BY origin"
            ).fetchall()
            self.assertEqual(len(rows), 2)
            synced_id = next(row["id"] for row in rows if row["origin"] == "synced")
            self.assertFalse(
                conn.execute(
                    "SELECT 1 FROM gen_request WHERE gen_id=?", (synced_id,)
                ).fetchone()
            )
            self.assertFalse(
                conn.execute(
                    "SELECT 1 FROM scene_card_generation WHERE generation_id=?", (synced_id,)
                ).fetchone()
            )

        synced = repo.get_generation(synced_id)
        self.assertTrue(synced["invalid_input_result"])
        self.assertEqual(synced["status"], "done")
        self.assertEqual(len(synced["assets"]), 1)
        self.assertEqual(repo.get_generation(original_id)["status"], "failed")
        self.assertEqual(
            repo.job_id_sync_diff(["job-invalid"], "u_one"),
            {"unknown": [], "refresh": []},
        )

        # 로컬 격리 표식은 선택 공유 번들의 generation 데이터에 포함되지 않는다.
        bundle_item = repo.export_bundle(gen_ids=[synced_id])["generations"][0]
        self.assertNotIn("invalid_input_result", bundle_item)


if __name__ == "__main__":
    unittest.main()
