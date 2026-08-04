"""PM 텔레메트리 repo 분리 후에도 유지해야 하는 outbox 계약."""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import manage


class ManageTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO worker(id, name, account_type) VALUES('u_me','Me','team') "
                "ON CONFLICT(id) DO NOTHING"
            )
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('u_me','Me') "
                "ON CONFLICT(uid) DO NOTHING"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) VALUES('p1','Project','team',0)"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, job_id, is_final) "
                "VALUES('g1','me','prompt','done','2026-08-01',1,'u_me','p1','job-1',1)"
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path) "
                "VALUES('a1','g1','image','/media/a.png')"
            )
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO generation_metrics"
                "(gen_id, job_id, est_credits, elapsed_seconds) VALUES('g1','job-1',12,3.5)"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_ingested_job_maps_to_local_id_and_builds_safe_fact(self):
        self.assertEqual(manage.mark_ingested_dirty(["job-1"], "u_me"), 1)
        pending = manage.list_dirty_telemetry()
        self.assertEqual([item["local_gen_id"] for item in pending], ["g1"])

        facts = manage.build_telemetry_facts(["g1"], "u_me")
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["local_gen_id"], "g1")
        self.assertEqual(facts[0]["project_name"], "Project")
        self.assertEqual(facts[0]["output_type"], "image")
        self.assertEqual(facts[0]["est_credits"], 12)
        self.assertTrue(facts[0]["is_final"])
        self.assertNotIn("prompt", facts[0])

    def test_stale_push_ack_does_not_clear_a_newer_dirty_update(self):
        manage.mark_telemetry_dirty(["g1"])
        stale_item = manage.list_dirty_telemetry()[0]
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE telemetry_outbox SET dirty_at='9999-12-31T23:59:59Z' "
                "WHERE local_gen_id='g1'"
            )

        manage.mark_telemetry_pushed([stale_item])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 1)

        current_item = manage.list_dirty_telemetry()[0]
        manage.mark_telemetry_pushed([current_item])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)


if __name__ == "__main__":
    unittest.main()
