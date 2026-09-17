"""작업용 개인 미리보기의 로컬·신원·위치·식별자 경계. 임시 DB만 사용한다."""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi import HTTPException, Request
from pydantic import ValidationError

from app import active_account, db, repo
from app.mutation_notify import notification_domains
from app.routers import manage
from app.routers._proxy import is_local_path


def item(**kwargs):
    return dict(id="fact:f1", local_gen_id="local1", job_id="job1",
                project_id="p1", folder_path="ep/seq", workspace_id="w1", **kwargs)


def request(*, host="127.0.0.1", client="127.0.0.1", extra=()):
    return Request({"type": "http", "client": (client, 123),
                    "headers": [(b"host", host.encode()), *extra]})


class LocalTaskPreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.stack = ExitStack()
        self.stack.enter_context(patch.dict(os.environ, {
            "CONTENT_HUB_DB": os.path.join(self.tmp.name, "content_hub.db"),
            "CONTENT_HUB_NO_PROXY": "1", "CONTENT_HUB_DB_POOL": "0",
        }))
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO project(id,name,kind,workspace_scope,workspace_id) "
                         "VALUES('p1','Project','team','team','w1')")
            for uid in ("owner", "other"):
                conn.execute("INSERT INTO creator(uid,name) VALUES(?,?)", (uid, uid))
        self.add_gen("local1", "job1", "owner")
        self.add_gen("other1", "job2", "other")

    def tearDown(self):
        db.flush_pool()
        self.stack.close()
        self.tmp.cleanup()

    def add_gen(self, gid, job, uid):
        with db.get_connection() as conn:
            conn.execute("INSERT INTO generation(id,job_id,worker_id,creator_uid,status,project_id,"
                         "folder_path,workspace_scope,workspace_id,origin,prompt,model) "
                         "VALUES(?,?,'me',?,'done','p1','ep/seq','team','w1','local','private prompt','test')", (gid, job, uid))
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path,source_url) VALUES(?,?,'image',?,?)",
                         (f"a-{gid}", gid, f"/media/{gid}.png", f"https://example.invalid/{gid}.png"))

    def body(self, entries=None, uid="owner"):
        return manage.LocalTaskPreviewsIn(viewer_uid=uid, items=entries if entries is not None else [item()])

    def test_local_task_route_keeps_team_and_personal_media_without_facts(self):
        for scope, wid in (("team", "w1"), ("personal", None)):
            with db.get_connection() as conn:
                conn.execute("UPDATE generation SET workspace_scope=?, workspace_id=?", (scope, wid))
                conn.execute("UPDATE project SET workspace_scope=?, workspace_id=? WHERE id='p1'", (scope, wid))
            with (
                patch.object(manage._proxy, "is_shared_team_server", return_value=False),
                patch.object(manage, "_require_project_read"),
                patch.object(manage, "_refresh_isolated_telemetry"),
                patch.object(manage, "_visible_tasks", side_effect=lambda req, rows: rows),
            ):
                rows = manage.list_tasks("p1", request(), wid)
            with self.subTest(scope=scope):
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["gen_count"], 2)
                self.assertTrue(all(cut["file_path"] for cut in rows[0]["cuts"]))
                self.assertTrue(all(not cut.get("metadata_only") for cut in rows[0]["cuts"]))

    def call(self, body=None, req=None, uid="owner"):
        with (
            patch.object(manage, "AUTH_ENABLED", True),
            patch.object(manage, "account_scope_uid", return_value=uid),
            patch.object(manage._proxy, "is_shared_team_server", return_value=False),
            patch.object(manage._proxy, "proxy_json", side_effect=AssertionError("remote call")),
        ):
            return manage.local_task_previews(body or self.body(), req or request())

    def test_self_preview_reads_only_location_without_prompt_or_facts(self):
        result = self.call()
        self.assertEqual(result["viewer_uid"], "owner")
        media = result["items"]["fact:f1"]
        self.assertEqual(media, {"local_gen_id": "local1", "thumb": "https://example.invalid/local1.png",
                                 "file_path": "https://example.invalid/local1.png", "media_type": "image"})

    def test_other_owner_and_wrong_locations_are_missing(self):
        for fields in (
            {"local_gen_id": "other1", "job_id": "job2"},
            {"project_id": "other"}, {"workspace_id": "other"}, {"folder_path": "ep/else"},
        ):
            with self.subTest(fields=fields):
                row = {**item(), **fields}
                self.assertEqual(self.call(self.body([row]))["items"], {})

    def test_deleted_and_personal_rows_are_not_previewed(self):
        for field, value in (("deleted_at", "2026-09-17"), ("workspace_scope", "personal")):
            with db.get_connection() as conn:
                conn.execute(f"UPDATE generation SET deleted_at=NULL, workspace_scope='team', {field}=? WHERE id='local1'", (value,))
            self.assertEqual(self.call()["items"], {})

    def test_unique_job_fallback_and_null_job_direct_id(self):
        self.assertEqual(self.call(self.body([{**item(), "local_gen_id": "gone"}]))["items"]["fact:f1"]["local_gen_id"], "local1")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET job_id=NULL WHERE id='local1'")
        self.assertIn("fact:f1", self.call(self.body([{**item(), "job_id": None}]))["items"])

    def test_conflicting_direct_id_is_not_replaced_by_job(self):
        self.assertEqual(self.call(self.body([{**item(), "job_id": "job2"}]))["items"], {})

    def test_ambiguous_job_does_not_pick_arbitrary_generation(self):
        # schema intentionally indexes job_id non-uniquely for legacy compatibility.
        self.add_gen("duplicate", "job1", "owner")
        self.assertEqual(self.call(self.body([{**item(), "local_gen_id": None}]))["items"], {})

    def test_missing_identifier_and_duplicate_keys_are_rejected(self):
        for rows in ([{**item(), "job_id": None, "local_gen_id": None}], [item(), item()]):
            with self.assertRaises(HTTPException) as exc:
                self.call(self.body(rows))
            self.assertEqual(exc.exception.status_code, 422)

    def test_caps_are_bounded(self):
        with self.assertRaises(ValidationError):
            self.body([item() for _ in range(501)])

    def test_account_change_and_unlinked_owner_are_rejected(self):
        for uid in (None, "\x00", "other"):
            with self.assertRaises(HTTPException) as exc:
                self.call(uid=uid)
            self.assertEqual(exc.exception.status_code, 409)

    def test_external_request_host_and_cross_site_are_rejected(self):
        for req in (request(client="192.0.2.2"), request(host="attacker.invalid"),
                    request(extra=[(b"origin", b"https://attacker.invalid")]),
                    request(extra=[(b"sec-fetch-site", b"cross-site")])):
            with self.assertRaises(HTTPException) as exc:
                self.call(req=req)
            self.assertEqual(exc.exception.status_code, 403)

    def test_shared_server_cannot_serve_even_on_loopback(self):
        with patch.object(manage._proxy, "is_shared_team_server", return_value=True):
            with self.assertRaises(HTTPException) as exc:
                manage.local_task_previews(self.body(), request())
            self.assertEqual(exc.exception.status_code, 403)

    def test_key_and_uid_remain_pinned_and_reset_after_failure(self):
        before_key, before_uid = active_account._override.get(), active_account._uid_override.get()
        def fail(*args):
            self.assertEqual(active_account._override.get(), "pin-owner")
            self.assertEqual(active_account.active_uid(), "owner")
            raise RuntimeError("probe")
        with patch.object(active_account, "account_key", return_value="pin-owner"), patch.object(repo, "local_task_previews", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "probe"):
                self.call()
        self.assertEqual(active_account._override.get(), before_key)
        self.assertEqual(active_account._uid_override.get(), before_uid)

    def test_query_is_local_and_emits_no_mutation(self):
        path = "/api/manage/local-task-previews"
        self.assertTrue(is_local_path(path))
        self.assertEqual(notification_domains("POST", path, 200), ())


if __name__ == "__main__":
    unittest.main()
