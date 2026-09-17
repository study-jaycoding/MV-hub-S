"""작업 기록 보강: 임시 콘텐츠/관리 DB만 사용하고 원본·공유 상태는 수정하지 않는다."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app import db, manage_db, repo
from app.repo import manage, manage_tasks


class TaskActivityFactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = str(Path(self.tmp.name) / "content.db")
        db.flush_pool()
        self.path_patch = patch.object(manage_db, "MANAGE_DB_PATH", Path(self.tmp.name) / "manage.db")
        self.path_patch.start()
        self.ttl_patch = patch.object(manage_tasks, "_TASK_READ_CACHE_TTL", 0)
        self.ttl_patch.start()
        db.init_db()
        repo.ensure_default_worker()
        manage_db.init_manage_db()
        manage_tasks.clear_task_read_cache()
        self.now = datetime.now(timezone.utc).isoformat()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            for pid, wid in (("p1", "ws-a"), ("p2", "ws-b")):
                conn.execute(
                    "INSERT INTO project(id,name,kind,workspace_scope,workspace_id,workspace_name) "
                    "VALUES(?,?,'team','team',?,?)", (pid, pid, wid, wid),
                )
            for uid in ("u1", "u2", "manager"):
                conn.execute("INSERT INTO creator(uid,name) VALUES(?,?)", (uid, uid))

    def tearDown(self):
        manage_tasks.clear_task_read_cache()
        self.ttl_patch.stop()
        self.path_patch.stop()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def fact(self, gid="local-1", uid="u1", email=None, **fields):
        item = dict(
            local_gen_id=gid, job_id="job-" + gid, creator_uid=uid,
            project_id="p1", folder_path="ep001/c0010", workspace_scope="team",
            workspace_id="ws-a", workspace_name="A", status="done", model="model",
            created_at=self.now, sort_ts=10, real_credits=3, elapsed_seconds=6,
        )
        item.update(fields)
        manage_db.upsert_facts(email or uid + "@example.test", uid, [item])

    def content(self, gid="server-1", uid="u1", job="job-local-1", shared=False, final=False, **fields):
        data = dict(project_id="p1", folder_path="ep001/c0010", workspace_scope="team", workspace_id="ws-a")
        data.update(fields)
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,creator_uid,job_id,project_id,"
                "folder_path,workspace_scope,workspace_id,is_final,created_at,sort_ts) "
                "VALUES(?,'me','private prompt','done',?,?,?,?,?,?,?,?,20)",
                (gid, uid, job, data["project_id"], data["folder_path"], data["workspace_scope"],
                 data["workspace_id"], int(final), self.now),
            )
            conn.execute(
                "INSERT INTO asset(id,generation_id,type,file_path,thumbnail_path) VALUES(?,?,'image',?,?)",
                ("asset-" + gid, gid, "https://example.invalid/private.png", "https://example.invalid/thumb.png"),
            )
            if shared:
                conn.execute("INSERT INTO share(id,generation_id,shared_by) VALUES(?,?,'me')", ("share-" + gid, gid))

    def read(self, uid="u1", *, read_all=False, preview=True, pid="p1", wid="ws-a", viewer=True, archived=False):
        actor = (uid, uid + "@example.test") if viewer else None
        return manage.list_tasks(
            pid, workspace_id=wid, include_archived=archived, include_activity=True, activity_viewer=actor,
            activity_read_all=read_all, preview_owner=actor if preview else None,
        )

    def test_fact_only_creates_generation_task_without_content_write(self):
        self.fact()
        task = self.read()[0]
        self.assertEqual((task["status"], task["gen_count"], task["credits"], task["elapsed"]), ("in_progress", 1, 3, 6))
        cut = task["cuts"][0]
        self.assertTrue(cut["id"].startswith("fact:"))
        self.assertTrue(cut["metadata_only"])
        self.assertEqual(cut["local_gen_id"], "local-1")
        self.assertEqual(cut["job_id"], "job-local-1")
        self.assertIsNone(cut["thumb"])
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0], 0)
        self.assertNotIn("account_email", json.dumps(task))

    def test_viewer_pair_is_required_even_with_read_all(self):
        self.fact()
        self.assertEqual(self.read(viewer=False, read_all=True), [])
        wrong_email = manage.list_tasks("p1", workspace_id="ws-a", include_activity=True,
                                       activity_viewer=("u1", "wrong@example.test"))
        self.assertEqual(wrong_email, [])

    def test_member_own_facts_and_manager_metadata_only(self):
        self.fact()
        self.fact("local-2", uid="u2", real_credits=5)
        own = self.read()[0]
        self.assertEqual((own["gen_count"], own["credits"]), (1, 3))
        manager = self.read("manager", read_all=True)[0]
        self.assertEqual((manager["gen_count"], manager["credits"]), (2, 8))
        for cut in manager["cuts"]:
            self.assertNotIn("local_gen_id", cut)
            self.assertNotIn("job_id", cut)
            self.assertIsNone(cut["file_path"])

    def test_shared_content_wins_and_metrics_fall_back_without_duplicate(self):
        self.fact(is_final=True)
        self.content(shared=True)
        task = self.read("u2")[0]
        self.assertEqual((task["status"], task["gen_count"], task["credits"]), ("publish", 1, 3))
        self.assertEqual(task["cuts"][0]["id"], "server-1")
        self.assertFalse(task["cuts"][0]["metadata_only"])
        self.assertIsNotNone(task["cuts"][0]["thumb"])
        self.assertNotIn("job_id", task["cuts"][0])

    def test_unshare_hides_media_and_preserves_content_id(self):
        self.fact(is_shared=True, is_final=True)
        self.content(shared=True)
        with db.get_connection() as conn:
            conn.execute("DELETE FROM share")
        own = self.read()[0]
        self.assertEqual(own["status"], "in_progress")
        self.assertEqual(own["cuts"][0]["id"], "server-1")
        self.assertIsNone(own["cuts"][0]["file_path"])
        self.assertEqual(own["cuts"][0]["local_gen_id"], "local-1")
        self.assertEqual(self.read("u2"), [])

    def test_final_comes_from_active_shared_content_not_fact(self):
        self.fact(is_final=False)
        self.content(shared=True, final=True)
        self.assertEqual(self.read()[0]["status"], "done")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET is_final=0")
        self.assertEqual(self.read()[0]["status"], "publish")

    def test_hold_priority_and_pm_fields_are_preserved_in_both_read_paths(self):
        self.fact()
        self.content(shared=True)
        task = self.read()[0]
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET is_held=1 WHERE id='server-1'")
            conn.execute(
                "UPDATE project_task SET status='pending',note='PM note',description='PM description',"
                "start_date='2026-01-01',due_date='2099-01-01',sort_order=7 WHERE id=?", (task["id"],),
            )
            original = dict(conn.execute("SELECT * FROM project_task WHERE id=?", (task["id"],)).fetchone())
        for activity in (False, True):
            with self.subTest(activity=activity):
                held = self.read()[0] if activity else manage.list_tasks("p1", workspace_id="ws-a")[0]
                self.assertEqual(held["status"], "hold")
                self.assertTrue(held["cuts"][0]["is_held"])
                for field in ("id", "created_at", "archived", "note", "description", "start_date", "due_date", "sort_order"):
                    self.assertEqual(held[field], original[field])
        # 다른 최종 컷이 있으면 기존의 any-final 완료 판정이 보류보다 우선한다.
        self.content("server-2", uid="u2", job="job-2", shared=True, final=True)
        self.assertEqual(self.read()[0]["status"], "done")
        with db.get_connection() as conn:
            stored = dict(conn.execute("SELECT * FROM project_task WHERE id=?", (task["id"],)).fetchone())
        self.assertEqual(stored["status"], "pending")
        self.assertEqual(stored["created_at"], original["created_at"])

    def test_unshared_and_final_content_do_not_expose_held_state(self):
        self.fact(is_shared=True, is_final=True)
        self.content(shared=True)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET is_held=1,is_final=1 WHERE id='server-1'")
        self.assertFalse(self.read()[0]["cuts"][0]["is_held"])
        with db.get_connection() as conn:
            conn.execute("DELETE FROM share")
        own = self.read()[0]
        self.assertEqual(own["status"], "in_progress")
        self.assertFalse(own["cuts"][0]["is_held"])
        self.assertEqual(self.read("u2"), [])
        self.fact("fact-only")
        self.assertTrue(all(not cut["is_held"] for cut in self.read()[0]["cuts"]))

    def test_dragged_hold_status_does_not_mutate_cuts_or_override_automatic_status(self):
        self.content(shared=True)
        task = self.read()[0]
        manage.update_task(task["id"], {"status": "hold"})
        self.assertEqual(self.read()[0]["status"], "publish")
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT is_held FROM generation WHERE id='server-1'").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT status FROM project_task WHERE id=?", (task["id"],)).fetchone()[0], "hold")

    def test_review_hold_does_not_reactivate_archived_work_or_change_original_dates(self):
        self.content(shared=True)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET created_at='2025-01-01T00:00:00Z' WHERE id='server-1'")
        archived = self.read(archived=True)[0]
        self.assertTrue(archived["archived"])
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET is_held=1 WHERE id='server-1'")
        self.assertEqual(self.read(), [])
        held = self.read(archived=True)[0]
        self.assertEqual((held["id"], held["status"], held["archived"]), (archived["id"], "hold", 1))
        self.assertEqual(held["created_at"], archived["created_at"])
        self.assertEqual(held["cuts"][0]["created_at"], "2025-01-01T00:00:00Z")

    def test_server_deleted_content_does_not_delete_private_fact(self):
        self.fact(is_shared=True, is_final=True)
        self.content(shared=True, final=True)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET deleted_at=?", (self.now,))
        task = self.read()[0]
        self.assertEqual((task["gen_count"], task["status"]), (1, "in_progress"))
        self.assertTrue(task["cuts"][0]["id"].startswith("fact:"))
        self.assertIsNone(task["cuts"][0]["thumb"])

    def test_owner_tombstone_suppresses_retained_unshared_content(self):
        self.fact()
        self.content()
        self.assertEqual(len(self.read()), 1)
        self.fact(is_deleted=True)
        self.assertEqual(self.read(), [])
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_task").fetchone()[0], 1)

    def test_fact_movement_outside_requested_project_suppresses_old_row(self):
        self.fact()
        self.content()
        self.read()
        self.fact(project_id="p2", workspace_id="ws-b", folder_path="ep002/c0020")
        self.assertEqual(self.read(), [])
        new = self.read(pid="p2", wid="ws-b")[0]
        self.assertEqual(new["folder_path"], "ep002/c0020")
        self.assertEqual(new["gen_count"], 1)

    def test_shared_server_location_wins_over_stale_fact_location(self):
        self.fact()
        self.content(shared=True, project_id="p2", workspace_id="ws-b", folder_path="ep002/c0020")
        self.assertEqual(self.read(), [])
        self.assertEqual(self.read(pid="p2", wid="ws-b")[0]["status"], "publish")

    def test_moving_to_personal_does_not_leave_old_team_metadata(self):
        self.fact()
        self.content()
        self.read()
        self.fact(workspace_scope="personal", workspace_id=None)
        self.assertEqual(self.read(), [])

    def test_null_job_ids_do_not_coalesce_different_creators_or_local_ids(self):
        self.fact("local-1", job_id=None)
        self.fact("local-2", job_id=None)
        self.fact("local-1", uid="u2", job_id=None)
        task = self.read("manager", read_all=True)[0]
        self.assertEqual(task["gen_count"], 3)

    def test_comfy_matching_id_and_creator_deduplicates(self):
        self.fact("local-1", job_id=None)
        self.content(gid="local-1", job=None, shared=True)
        self.assertEqual(self.read()[0]["gen_count"], 1)

    def test_same_job_different_creators_remain_distinct(self):
        self.fact(job_id="collision")
        self.fact("local-2", uid="u2", job_id="collision")
        self.content(job="collision", shared=True)
        task = self.read("manager", read_all=True)[0]
        self.assertEqual(task["gen_count"], 2)

    def test_ambiguous_accounts_do_not_grant_preview_hints(self):
        self.fact(job_id="collision")
        self.fact("other-id", email="other@example.test", job_id="collision")
        self.content(job="collision")
        task = self.read("manager", read_all=True)[0]
        self.assertEqual(task["gen_count"], 1)
        self.assertNotIn("local_gen_id", task["cuts"][0])
        self.assertEqual(self.read(), [])

    def test_preview_owner_cannot_be_other_than_viewer(self):
        self.fact()
        task = manage.list_tasks("p1", workspace_id="ws-a", include_activity=True,
            activity_viewer=("manager", "manager@example.test"), activity_read_all=True,
            preview_owner=("u1", "u1@example.test"))[0]
        self.assertNotIn("local_gen_id", task["cuts"][0])

    def test_pm_fields_and_existing_task_id_survive_source_change(self):
        self.fact()
        task = self.read()[0]
        manage.update_task(task["id"], {"note": "keep", "status": "omit", "description": "planned"})
        manage.add_assignment(task["id"], "u2", "manager")
        self.content(shared=True)
        after = self.read()[0]
        self.assertEqual((after["id"], after["note"], after["status"]), (task["id"], "keep", "omit"))
        self.assertEqual(after["assigned_creators"][0]["uid"], "u2")

    def test_manual_link_is_retained_but_facts_do_not_guess_sequence_lane(self):
        self.fact()
        self.content()
        task = manage.create_task("p1", "manual", sequence="c0010")
        manage.link_generations(task["id"], ["server-1"])
        rows = {row["id"]: row for row in self.read()}
        self.assertEqual(rows[task["id"]]["cuts"][0]["linked"], 1)
        self.assertTrue(rows[task["id"]]["cuts"][0]["metadata_only"])
        unlinked = manage.create_task("p1", "no guess", sequence="c0010")
        rows = {row["id"]: row for row in self.read()}
        self.assertEqual(rows[unlinked["id"]]["gen_count"], 0)

    def test_historical_fact_project_discovery_is_read_only_and_scoped(self):
        self.fact(project_id="p2")
        with db.get_connection() as conn:
            before = conn.execute("SELECT COUNT(*) FROM project_task").fetchone()[0]
        own = manage.task_projects_for_workspace("ws-a", include_historical=True,
            include_activity=True, activity_viewer=("u1", "u1@example.test"))
        other = manage.task_projects_for_workspace("ws-a", include_historical=True,
            include_activity=True, activity_viewer=("u2", "u2@example.test"))
        self.assertIn("p2", {row["id"] for row in own})
        self.assertNotIn("p2", {row["id"] for row in other})
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM project_task").fetchone()[0], before)

    def test_existing_private_manual_link_needs_no_folder(self):
        self.fact(folder_path=None)
        self.content(folder_path=None)
        task = manage.create_task("p1", "manual private")
        manage.link_generations(task["id"], ["server-1"])
        rows = self.read()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], task["id"])
        self.assertEqual(rows[0]["gen_count"], 1)
        self.assertTrue(rows[0]["cuts"][0]["metadata_only"])

    def test_existing_explicit_cross_project_link_keeps_same_workspace_membership(self):
        self.fact(project_id="p2")
        self.content(project_id="p2", shared=True)
        task = manage.create_task("p1", "existing manual")
        with db.get_connection() as conn:
            # 과거 명시 연결의 호환성: 새 연결 API의 허용 정책을 확장하지 않는다.
            conn.execute("INSERT INTO task_generation(task_id,gen_id) VALUES(?,'server-1')", (task["id"],))
        rows = {row["id"]: row for row in self.read()}
        self.assertEqual(rows[task["id"]]["cuts"][0]["id"], "server-1")
        self.assertEqual(rows[task["id"]]["cuts"][0]["linked"], 1)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET workspace_id='ws-b'")
        rows = {row["id"]: row for row in self.read()}
        self.assertEqual(rows[task["id"]]["cuts"], [])

    def test_other_viewer_cannot_discover_fact_history_after_manager_materialized_task(self):
        self.fact(project_id="p2")
        self.read("manager", read_all=True, pid="p2")
        other = manage.task_projects_for_workspace("ws-a", include_historical=True,
            include_activity=True, activity_viewer=("u2", "u2@example.test"))
        self.assertNotIn("p2", {row["id"] for row in other})
        own = manage.task_projects_for_workspace("ws-a", include_historical=True,
            include_activity=True, activity_viewer=("u1", "u1@example.test"))
        self.assertIn("p2", {row["id"] for row in own})

    def test_archived_other_fact_folder_hidden_from_member_but_own_history_remains(self):
        self.fact(uid="u2", created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        manager = self.read("manager", read_all=True, archived=True)[0]
        self.assertTrue(manager["archived"])
        self.assertEqual(self.read("u1", archived=True), [])
        self.assertEqual(self.read(viewer=False, read_all=True, archived=True), [])
        own = self.read("u2", archived=True)[0]
        self.assertEqual(own["id"], manager["id"])
        self.assertEqual(own["gen_count"], 1)

    def test_archived_empty_automatic_history_remains_for_confirmed_manager(self):
        self.fact(uid="u2", created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        tid = self.read("manager", read_all=True, archived=True)[0]["id"]
        self.fact(uid="u2", is_deleted=True)
        task = self.read("manager", read_all=True, archived=True)[0]
        self.assertEqual((task["id"], task["gen_count"], task["archived"]), (tid, 0, 1))
        self.assertEqual(self.read("u1", archived=True), [])

    def test_archived_pm_edited_task_is_team_metadata_and_remains_visible(self):
        self.fact(uid="u2", created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        tid = self.read("manager", read_all=True, archived=True)[0]["id"]
        manage.update_task(tid, {"note": "팀 일정 기록"})
        task = self.read("u1", archived=True)[0]
        self.assertEqual(task["id"], tid)
        self.assertEqual(task["note"], "팀 일정 기록")
        self.assertEqual(task["cuts"], [])

    def test_unchanged_archived_activity_get_does_not_reactivate_then_archive(self):
        self.fact(created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        task = self.read(archived=True)[0]
        self.assertTrue(task["archived"])
        from app.repo.manage_task_activity import folder_sources, load_activity_snapshot
        with db.get_connection() as conn:
            before = conn.total_changes
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"],
                activity_sources=folder_sources(load_activity_snapshot(conn, ["p1"])))
            self.assertEqual(conn.total_changes, before)
            self.assertEqual(conn.execute("SELECT archived FROM project_task WHERE id=?", (task["id"],)).fetchone()[0], 1)

    def test_new_generation_reactivates_archived_folder_and_preserves_task_id(self):
        self.fact(created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        task = self.read(archived=True)[0]
        self.fact("new-current")
        revived = self.read()[0]
        self.assertEqual((revived["id"], revived["archived"], revived["gen_count"]), (task["id"], 0, 2))

    def _old_local_task(self, *, activity):
        self.content(gid="local-1")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET created_at='2025-01-01 00:00:00' WHERE id='local-1'")
        self.fact(created_at="2025-01-01 00:00:00")
        rows = self.read(archived=True) if activity else manage.list_tasks(
            "p1", workspace_id="ws-a", include_archived=True,
        )
        self.assertTrue(rows[0]["archived"])
        return rows[0]

    def _push_local_activity(self):
        facts = manage.build_telemetry_facts(["local-1"], my_uid="u1")
        manage_db.upsert_facts("u1@example.test", "u1", facts)

    def test_old_content_explicit_resume_preserves_task_and_original_date(self):
        task = self._old_local_task(activity=False)
        manage.update_task(task["id"], {"note": "일정 메모 보존", "description": "설명 보존"})
        repo.assign_to_project(["local-1"], "p1", account_uid="u1",
                               folder_path="ep001/c0010", resume_work=True)
        revived = manage.list_tasks("p1", workspace_id="ws-a")[0]
        self.assertEqual((revived["id"], revived["status"], revived["archived"], revived["gen_count"]),
                         (task["id"], "in_progress", 0, 1))
        self.assertEqual(revived["note"], "일정 메모 보존")
        self.assertEqual(revived["description"], "설명 보존")
        self.assertEqual(revived["cuts"][0]["created_at"], "2025-01-01 00:00:00")
        with db.get_connection() as conn:
            before = conn.total_changes
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"])
            self.assertEqual(conn.total_changes, before)

    def test_old_fact_explicit_resume_does_not_revive_other_archived_folder(self):
        task = self._old_local_task(activity=True)
        self.fact("other-old", created_at="2025-01-01T00:00:00Z", folder_path="ep001/c0020")
        other = next(row for row in self.read(archived=True) if row["folder_path"] == "ep001/c0020")
        self.assertTrue(other["archived"])
        repo.assign_to_project(["local-1"], "p1", account_uid="u1",
                               folder_path="ep001/c0010", resume_work=True)
        self._push_local_activity()
        revived = self.read()
        self.assertEqual([(row["id"], row["status"]) for row in revived], [(task["id"], "in_progress")])
        self.assertEqual(revived[0]["cuts"][0]["created_at"], "2025-01-01 00:00:00")
        self.assertTrue(next(row for row in self.read(archived=True) if row["id"] == other["id"])["archived"])

    def test_old_content_move_and_return_reactivates_existing_task(self):
        task = self._old_local_task(activity=False)
        repo.assign_to_project(["local-1"], "p1", account_uid="u1", folder_path="ep001/c0030")
        self.assertEqual(manage.list_tasks("p1", workspace_id="ws-a")[0]["folder_path"], "ep001/c0030")
        repo.assign_to_project(["local-1"], "p1", account_uid="u1", folder_path="ep001/c0010")
        self.assertEqual(manage.list_tasks("p1", workspace_id="ws-a")[0]["id"], task["id"])

    def test_old_content_noop_and_repeated_get_stay_archived_without_writes(self):
        self._old_local_task(activity=False)
        repo.assign_to_project(["local-1"], "p1", account_uid="u1", folder_path="ep001/c0010")
        self.assertEqual(manage.list_tasks("p1", workspace_id="ws-a"), [])
        with db.get_connection() as conn:
            before = conn.total_changes
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"])
            self.assertEqual(conn.total_changes, before)

    def test_targeted_finalization_sync_preserves_archive_until_full_list(self):
        task = self._old_local_task(activity=False)
        with db.get_connection() as conn:
            before = conn.total_changes
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"], ["ep001/c0010"])
            self.assertEqual(conn.total_changes, before)
            self.assertEqual(conn.execute("SELECT archived FROM project_task WHERE id=?", (task["id"],)).fetchone()[0], 1)
        repo.assign_to_project(["local-1"], "p1", account_uid="u1",
                               folder_path="ep001/c0010", resume_work=True)
        with db.get_connection() as conn:
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"], ["ep001/c0010"])
            self.assertEqual(conn.execute("SELECT archived FROM project_task WHERE id=?", (task["id"],)).fetchone()[0], 1)
        resumed = manage.list_tasks("p1", workspace_id="ws-a")
        self.assertEqual([row["id"] for row in resumed], [task["id"]])
        self.assertEqual(resumed[0]["archived"], 0)

    def test_fact_heartbeat_does_not_reactivate_old_task(self):
        task = self._old_local_task(activity=True)
        self._push_local_activity()
        self._push_local_activity()
        self.assertEqual(self.read(), [])
        self.assertTrue(self.read(archived=True)[0]["archived"])
        self.assertEqual(self.read(archived=True)[0]["id"], task["id"])

    def test_fact_activity_date_comparison_uses_utc_not_text_order(self):
        stamp = datetime.now(timezone.utc) - timedelta(minutes=1)
        self.fact(created_at=stamp.isoformat(), task_activity_at=(stamp - timedelta(hours=1)).isoformat())
        self.fact("second", created_at=(stamp - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"),
                  task_activity_at=(stamp + timedelta(seconds=10)).isoformat())
        from app.task_activity import normalize_task_activity_at
        self.assertEqual(self.read()[0]["source_last_seen_at"],
                         normalize_task_activity_at((stamp + timedelta(seconds=10)).isoformat()))

    def test_task_future_deadline_reactivates_archived_activity(self):
        self.fact(created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        task = self.read(archived=True)[0]
        future = (datetime.now(timezone.utc) + timedelta(days=60)).date().isoformat()
        manage.update_task(task["id"], {"due_date": future})
        revived = self.read()[0]
        self.assertEqual((revived["id"], revived["archived"]), (task["id"], 0))

    def test_project_future_deadline_reactivates_archived_activity(self):
        self.fact(created_at="2025-01-01T00:00:00Z", sort_ts=1735689600)
        task = self.read(archived=True)[0]
        future = (datetime.now(timezone.utc) + timedelta(days=60)).date().isoformat()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project_planning(project_id,due_date) VALUES('p1',?)", (future,))
        revived = self.read()[0]
        self.assertEqual((revived["id"], revived["archived"]), (task["id"], 0))

    def test_longer_retention_reactivates_archived_activity_then_shorter_archives(self):
        old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        self.fact(created_at=old)
        task = self.read(archived=True)[0]
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project_planning(project_id,archive_after_days) VALUES('p1',3650)")
        self.assertEqual(self.read()[0]["archived"], 0)
        with db.get_connection() as conn:
            conn.execute("UPDATE project_planning SET archive_after_days=30 WHERE project_id='p1'")
        archived = self.read(archived=True)[0]
        self.assertEqual((archived["id"], archived["archived"]), (task["id"], 1))

    def test_fact_lookup_chunks_more_than_sqlite_variable_limit(self):
        items = [dict(local_gen_id="bulk-" + str(i), job_id="bulk-job-" + str(i),
                      creator_uid="u1", project_id="p1", folder_path="ep001/c0010",
                      workspace_scope="team", workspace_id="ws-a", created_at=self.now)
                 for i in range(1001)]
        manage_db.upsert_facts("u1@example.test", "u1", items)
        self.assertEqual(self.read()[0]["gen_count"], 1001)

    def test_repeated_get_does_not_write_or_change_source_timestamp(self):
        self.fact()
        task = self.read()[0]
        with db.get_connection() as conn:
            before = conn.total_changes
            from app.repo.manage_task_activity import folder_sources, load_activity_snapshot
            snapshot = load_activity_snapshot(conn, ["p1"])
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"], activity_sources=folder_sources(snapshot))
            self.assertEqual(conn.total_changes, before)
        self.assertEqual(self.read()[0]["source_last_seen_at"], task["source_last_seen_at"])

    def test_no_manage_file_keeps_shared_content_without_creating_file(self):
        self.content(shared=True)
        missing = Path(self.tmp.name) / "missing" / "manage.db"
        with patch.object(manage_db, "MANAGE_DB_PATH", missing):
            self.assertEqual(self.read()[0]["gen_count"], 1)
            self.assertFalse(missing.exists())

    def test_existing_manage_database_open_failure_is_not_empty_success(self):
        with patch.object(manage_db.sqlite3, "connect",
                          side_effect=sqlite3.OperationalError("unable to open database file")):
            with self.assertRaises(sqlite3.OperationalError):
                manage_db.task_activity_facts(["p1"])

    def test_manage_database_stat_permission_error_is_not_treated_as_missing(self):
        with (
            patch.object(manage_db.sqlite3, "connect",
                         side_effect=sqlite3.OperationalError("unable to open database file")),
            patch.object(Path, "stat", side_effect=PermissionError("denied")),
        ):
            with self.assertRaises(PermissionError):
                manage_db.task_activity_facts(["p1"])

    def test_manage_database_lock_failure_propagates_but_old_missing_table_is_compatible(self):
        with patch.object(manage_db.sqlite3, "connect",
                          side_effect=sqlite3.OperationalError("database is locked")):
            with self.assertRaises(sqlite3.OperationalError):
                manage_db.task_activity_facts(["p1"])
        with patch.object(manage_db.sqlite3, "connect",
                          side_effect=sqlite3.OperationalError("no such table: team_generation_fact")):
            self.assertEqual(manage_db.task_activity_facts(["p1"]), [])

    def test_missing_fact_dates_do_not_trigger_repeated_backfill_writes(self):
        self.fact(created_at=None, sort_ts=None)
        task = self.read()[0]
        self.assertIsNotNone(task["source_last_seen_at"])
        with db.get_connection() as conn:
            before = conn.total_changes
            from app.repo.manage_task_activity import folder_sources, load_activity_snapshot
            manage_tasks.sync_folder_tasks_batch(conn, ["p1"],
                activity_sources=folder_sources(load_activity_snapshot(conn, ["p1"])))
            self.assertEqual(conn.total_changes, before)

    def test_cache_is_viewer_scoped_and_telemetry_changes_invalidate(self):
        self.fact()
        with patch.object(manage_tasks, "_TASK_READ_CACHE_TTL", 60):
            self.assertEqual(self.read()[0]["gen_count"], 1)
            self.assertEqual(self.read("u2"), [])
            self.fact("local-2", uid="u2")
            self.assertEqual(self.read("u2")[0]["gen_count"], 1)
            self.assertEqual(self.read("manager", read_all=True)[0]["gen_count"], 2)

    def test_cache_key_normalizes_and_never_contains_identity(self):
        key = manage_tasks.task_activity_cache_key(activity_viewer=("u1", " U1@EXAMPLE.TEST "),
            activity_read_all=False, preview_owner=None)
        normalized = manage_tasks.task_activity_cache_key(activity_viewer=("u1", "u1@example.test"),
            activity_read_all=False, preview_owner=None)
        self.assertEqual(key, normalized)
        self.assertEqual(len(key), 64)
        self.assertNotIn("u1", key)

    def test_existing_internal_default_remains_content_only(self):
        self.fact()
        self.assertEqual(manage.list_tasks("p1", workspace_id="ws-a"), [])


if __name__ == "__main__":
    unittest.main()
