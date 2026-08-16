"""PM 텔레메트리 repo 분리 후에도 유지해야 하는 outbox 계약."""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app import db, manage_db, repo
from app.models import AssignProjectIn
from app.repo import manage
from app.services.telemetry_drain import drain_isolated_telemetry, drain_remote_telemetry


class ManageTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
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
                "INSERT INTO project(id, name, kind, archived, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p1','Project','team',0,'team','ws1','Workspace 1')"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, project_id, job_id, is_final, workspace_scope, workspace_id, workspace_name) "
                "VALUES('g1','me','prompt','done','2026-08-01',1,'u_me','p1','job-1',1,"
                "'team','ws1','Workspace 1')"
            )
            conn.execute(
                "INSERT INTO account(email,name,password_hash,status,creator_uid) "
                "VALUES('me@example.com','Me','test-hash','approved','u_me')"
            )
            conn.execute(
                "INSERT INTO workspace_registry(id,name) VALUES('ws1','Workspace 1')"
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
        if self.old_no_proxy is None:
            os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        else:
            os.environ["CONTENT_HUB_NO_PROXY"] = self.old_no_proxy
        manage_db.MANAGE_DB_PATH = self.old_manage_path
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

    def test_periodic_backfill_tracks_missing_job_once_without_redirtying(self):
        self.assertEqual(manage.ensure_ingested_tracked(["job-1"], None), 1)
        first = manage.list_dirty_telemetry()[0]
        manage.mark_telemetry_pushed([first])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

        # 다음 20초 주기에도 같은 완료 잡이 보이지만 기존 outbox를 다시 dirty로 만들지 않는다.
        self.assertEqual(manage.ensure_ingested_tracked(["job-1"], None), 0)
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

        # 실제 상태 변경으로 보고된 잡은 기존 pushed 행을 다시 전송 대상으로 되돌린다.
        self.assertEqual(manage.mark_ingested_dirty(["job-1"], None), 1)
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 1)

    def test_failed_item_backs_off_and_does_not_block_fresh_items(self):
        # 실패한 항목은 next_retry_at 전까지 드레인 선택에서 빠지고(폭주 방지),
        # 오래된 실패가 LIMIT 창을 선점해 새 항목을 가리지도 않는다(head-of-line 방지).
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid) VALUES('g2','me','p2','done','2026-08-02',2,'u_me')"
            )
        manage.mark_telemetry_dirty(["g1"])  # g1 이 먼저 dirty(더 오래됨)
        manage.mark_telemetry_failed(["g1"], "server skipped")
        manage.mark_telemetry_dirty(["g2"])

        pending_ids = [item["local_gen_id"] for item in manage.list_dirty_telemetry(limit=1)]
        self.assertEqual(pending_ids, ["g2"])  # 실패한 g1 은 백오프로 제외, 신규 g2 선택

        # 같은 항목이 다시 dirty 되면 백오프가 풀려 즉시 재선택된다.
        manage.mark_telemetry_dirty(["g1"])
        pending_ids = [item["local_gen_id"] for item in manage.list_dirty_telemetry()]
        self.assertIn("g1", pending_ids)

    def test_stale_failure_does_not_backoff_a_newer_dirty_update(self):
        # 전송 중 그 항목이 다시 dirty 되면(dirty_at 변경), 옛 전송의 실패 CAS 가 빗나가
        # 새 변경엔 백오프가 걸리지 않는다 — 새 변경은 즉시 재시도돼야 한다.
        manage.mark_telemetry_dirty(["g1"])
        stale_item = manage.list_dirty_telemetry()[0]
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE telemetry_outbox SET dirty_at='9999-12-31T23:59:59Z' "
                "WHERE local_gen_id='g1'"
            )
        manage.mark_telemetry_failed([stale_item], "late failure")
        pending = [item["local_gen_id"] for item in manage.list_dirty_telemetry()]
        self.assertIn("g1", pending)

    def test_backoff_delay_grows_with_consecutive_failures(self):
        manage.mark_telemetry_dirty(["g1"])
        manage.mark_telemetry_failed(["g1"], "e1")
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT fail_streak, next_retry_at FROM telemetry_outbox WHERE local_gen_id='g1'"
            ).fetchone()
            self.assertEqual(row["fail_streak"], 1)
            first_retry = row["next_retry_at"]
            self.assertIsNotNone(first_retry)
        manage.mark_telemetry_failed(["g1"], "e2")
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT fail_streak, next_retry_at FROM telemetry_outbox WHERE local_gen_id='g1'"
            ).fetchone()
            self.assertEqual(row["fail_streak"], 2)
            self.assertGreater(row["next_retry_at"], first_retry)

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

    def test_isolated_drain_upserts_and_refreshes_local_dashboard_fact(self):
        manage.mark_telemetry_dirty(["g1"])
        first = drain_isolated_telemetry()
        self.assertEqual(first, {"target": "local", "upserted": 1, "failed": 0})
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

        with manage_db.get_connection() as conn:
            row = conn.execute(
                "SELECT account_email,project_id,folder_path,is_final,workspace_id,est_credits "
                "FROM team_generation_fact WHERE local_gen_id='g1'"
            ).fetchone()
        self.assertEqual(
            tuple(row),
            ("me@example.com", "p1", None, 1, "ws1", 12),
        )

        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET folder_path='ep001/c0010', is_final=0 WHERE id='g1'"
            )
        manage.mark_telemetry_dirty(["g1"])
        second = drain_isolated_telemetry()
        self.assertEqual(second["upserted"], 1)
        with manage_db.get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n, MAX(folder_path) AS folder_path, MAX(is_final) AS is_final "
                "FROM team_generation_fact WHERE local_gen_id='g1'"
            ).fetchone()
        self.assertEqual(tuple(row), (1, "ep001/c0010", 0))

    def test_isolated_drain_partitions_creators_and_keeps_unmapped_pending(self):
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid,name) VALUES('u_other','Other')")
            conn.execute(
                "INSERT INTO account(email,name,password_hash,status,creator_uid) "
                "VALUES('other@example.com','Other','test-hash','approved','u_other')"
            )
            for gid, uid in (("g2", "u_other"), ("g3", "u_unmapped")):
                conn.execute(
                    "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,creator_uid,"
                    "workspace_scope,workspace_id,workspace_name) "
                    "VALUES(?, 'me','p','done','2026-08-02',2,?,'team','ws1','Workspace 1')",
                    (gid, uid),
                )
        manage.mark_telemetry_dirty(["g1", "g2", "g3"])
        result = drain_isolated_telemetry()
        self.assertEqual(result["upserted"], 2)
        self.assertEqual(result["failed"], 1)
        with manage_db.get_connection() as conn:
            rows = conn.execute(
                "SELECT local_gen_id,account_email FROM team_generation_fact ORDER BY local_gen_id"
            ).fetchall()
        self.assertEqual(
            [tuple(row) for row in rows],
            [("g1", "me@example.com"), ("g2", "other@example.com")],
        )
        # 미매핑 g3 는 대기열에 보존되지만(pending), 실패 백오프 동안은 즉시 재선택 목록에서
        # 빠진다(매 드레인 주기 재전송 폭주 방지). 백오프가 풀리면 다시 선택된다.
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 1)
        self.assertEqual(manage.list_dirty_telemetry(), [])
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE telemetry_outbox SET next_retry_at=NULL WHERE local_gen_id='g3'"
            )
        pending = manage.list_dirty_telemetry()
        self.assertEqual([row["local_gen_id"] for row in pending], ["g3"])

    def test_project_assignment_route_drains_isolated_telemetry_immediately(self):
        from app.routers.projects import assign_project

        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET project_id=NULL WHERE id='g1'")
        request = SimpleNamespace(state=SimpleNamespace(account=None))
        result = assign_project(
            AssignProjectIn(generation_ids=["g1"], project_id="p1"),
            request,
            tab="my",
        )
        self.assertEqual(result["updated"], 1)
        with manage_db.get_connection() as conn:
            row = conn.execute(
                "SELECT project_id,workspace_id FROM team_generation_fact WHERE local_gen_id='g1'"
            ).fetchone()
        self.assertEqual(tuple(row), ("p1", "ws1"))

    def test_workspace_assignment_route_drains_isolated_telemetry_immediately(self):
        from app.routers.generation import (
            GenerationWorkspaceBatchIn,
            set_generation_workspace_batch,
        )

        with db.get_connection() as conn:
            conn.execute(
                "UPDATE generation SET workspace_scope='personal', workspace_id=NULL, "
                "workspace_name=NULL WHERE id='g1'"
            )
        request = SimpleNamespace(state=SimpleNamespace(account=None))
        result = set_generation_workspace_batch(
            GenerationWorkspaceBatchIn(
                generation_ids=["g1"],
                operation="assign",
                workspace_name="Workspace 1",
            ),
            request,
        )
        self.assertEqual(result["changed"], ["g1"])
        with manage_db.get_connection() as conn:
            row = conn.execute(
                "SELECT workspace_scope,workspace_id FROM team_generation_fact "
                "WHERE local_gen_id='g1'"
            ).fetchone()
        self.assertEqual(tuple(row), ("team", "ws1"))

    def test_dashboard_read_repairs_an_existing_isolated_outbox(self):
        from app.routers.manage import team_overview

        manage.mark_telemetry_dirty(["g1"])
        request = SimpleNamespace(state=SimpleNamespace(account=None))
        result = team_overview(
            request,
            date_from="2026-08-01",
            date_to="2026-08-31",
            workspace_id="ws1",
        )
        self.assertEqual(result["totals"]["count"], 1)
        self.assertEqual(result["by_project"][0]["project_id"], "p1")
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)

    def test_non_isolated_mode_never_writes_local_manage_db(self):
        os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        manage.mark_telemetry_dirty(["g1"])
        result = drain_isolated_telemetry()
        self.assertEqual(result["target"], "disabled")
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 1)
        self.assertFalse(manage_db.MANAGE_DB_PATH.exists())

    def test_remote_drain_keeps_existing_push_contract(self):
        os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        manage.mark_telemetry_dirty(["g1"])
        captured = []

        def push(items):
            captured.extend(items)
            return {"upserted": len(items), "skipped": []}

        result = drain_remote_telemetry(push, my_uid="u_me")
        self.assertEqual(result, {"target": "remote", "upserted": 1, "failed": 0})
        self.assertEqual([item["local_gen_id"] for item in captured], ["g1"])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)
        self.assertFalse(manage_db.MANAGE_DB_PATH.exists())

    def test_remote_drain_leaves_server_skips_for_retry(self):
        os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        manage.mark_telemetry_dirty(["g1"])
        result = drain_remote_telemetry(
            lambda items: {"upserted": 0, "skipped": [items[0]["local_gen_id"]]},
            my_uid="u_me",
        )
        self.assertEqual(result["failed"], 1)
        status = manage.telemetry_outbox_status()
        self.assertEqual(status["pending"], 1)
        self.assertEqual(status["failed"], 1)

    def test_remote_drain_settles_foreign_tombstone_without_sending_it(self):
        os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        manage.mark_telemetry_tombstone(
            "foreign-gone",
            {"job_id": "foreign-job", "creator_uid": "u_other", "status": "done"},
        )
        captured = []

        result = drain_remote_telemetry(
            lambda items: captured.extend(items) or {"upserted": len(items), "skipped": []},
            my_uid="u_me",
        )

        self.assertEqual(result, {"target": "remote", "upserted": 0, "failed": 0})
        self.assertEqual(captured, [])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT is_tombstone,pushed_at,last_error FROM telemetry_outbox "
                "WHERE local_gen_id='foreign-gone'"
            ).fetchone()
        self.assertEqual(row["is_tombstone"], 1)
        self.assertIsNotNone(row["pushed_at"])
        self.assertIsNone(row["last_error"])

    def test_remote_drain_still_sends_own_tombstone(self):
        os.environ.pop("CONTENT_HUB_NO_PROXY", None)
        manage.mark_telemetry_tombstone(
            "own-gone",
            {"job_id": "own-job", "creator_uid": "u_me", "status": "done"},
        )
        captured = []

        result = drain_remote_telemetry(
            lambda items: captured.extend(items) or {"upserted": len(items), "skipped": []},
            my_uid="u_me",
        )

        self.assertEqual(result, {"target": "remote", "upserted": 1, "failed": 0})
        self.assertEqual([item["local_gen_id"] for item in captured], ["own-gone"])
        self.assertTrue(captured[0]["is_deleted"])
        self.assertEqual(manage.telemetry_outbox_status()["pending"], 0)


if __name__ == "__main__":
    unittest.main()
