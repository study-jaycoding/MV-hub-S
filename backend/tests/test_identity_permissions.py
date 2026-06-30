import os
import tempfile
import unittest
from contextlib import ExitStack
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app import deps as deps_mod
from app.routers import ingest as ingest_router
from app.routers import projects as projects_router


class DummyState:
    pass


class DummyRequest:
    def __init__(self, account: dict | None):
        self.state = DummyState()
        self.state.account = account


def auth_on():
    stack = ExitStack()
    stack.enter_context(mock.patch.object(deps_mod, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(projects_router, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(ingest_router, "AUTH_ENABLED", True))
    return stack


class IdentityPermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) "
                "VALUES('p_river','River Project','team',0)"
            )
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('user_river','River')"
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) "
                "VALUES('p_river','user_river','creator')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_unlinked_account_uses_stable_email_uid_not_default_worker(self):
        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": None,
            }
        )
        with auth_on():
            self.assertEqual(deps_mod.actor_id(req), "acct:river@example.com")
            self.assertEqual(deps_mod.account_scope_uid(req), "acct:river@example.com")

    def test_all_project_members_requires_read_all(self):
        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        with auth_on(), self.assertRaises(HTTPException) as ctx:
            projects_router.list_all_members(req)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_project_members_require_project_membership_or_read_all(self):
        other = DummyRequest(
            {
                "email": "other@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_other",
            }
        )
        river = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        with auth_on(), self.assertRaises(HTTPException) as ctx:
            projects_router.list_members("p_river", other)
        self.assertEqual(ctx.exception.status_code, 403)

        with auth_on():
            rows = projects_router.list_members("p_river", river)
        self.assertEqual([r["uid"] for r in rows], ["user_river"])

    def test_ingest_requires_reported_cli_email_when_auth_is_on(self):
        acc = {"email": "river@example.com", "creator_uid": "user_river"}
        jobs = [
            {
                "id": "job_1",
                "status": "completed",
                "result_url": "https://cdn.example.com/user_river/result.png",
                "params": {"prompt": "a"},
            }
        ]
        with auth_on(), self.assertRaises(HTTPException) as ctx:
            ingest_router._ingest_core(acc, jobs, None, None)
        self.assertEqual(ctx.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
