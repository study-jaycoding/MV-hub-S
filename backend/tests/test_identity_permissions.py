import asyncio
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app import db, manage_db, repo
from app import deps as deps_mod
from app.config import DEFAULT_WORKER_ID
from app.repo import manage as repo_manage
from app.routers import generation as generation_router
from app.routers import gen_requests as gen_requests_router
from app.routers import ingest as ingest_router
from app.routers import manage as manage_router
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
    stack.enter_context(mock.patch.object(manage_router, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(ingest_router, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(gen_requests_router, "AUTH_ENABLED", True))
    return stack


class IdentityPermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        # 요약 사용량은 manage_hub 팩트 — 사용자 관리 DB 를 읽지 않게 임시 경로로 격리(코덱스 P2)
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        manage_db.init_manage_db()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) "
                "VALUES('p_river','River Project','team',0)"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) "
                "VALUES('p_other','Other Project','team',0)"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, archived) "
                "VALUES('p_roleless','Roleless Project','team',0)"
            )
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('user_river','River')"
            )
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('user_other','Other')"
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) "
                "VALUES('p_river','user_river','creator')"
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) "
                "VALUES('p_other','user_other','creator')"
            )
            conn.execute(
                "INSERT INTO project_member(project_id, creator_uid, project_role) "
                "VALUES('p_roleless','user_river','')"
            )
        # 팩트 — 멤버 요약이 남의 프로젝트(p_other)와 팀원의 미공유분을 세지 않는지 검증용
        for gid, email, uid, pid, credits, shared in (
            ("g_river", "river@example.com", "user_river", "p_river", 5, False),
            ("g_other", "other@example.com", "user_other", "p_other", 9, False),
            ("g_mate_private", "other@example.com", "user_other", "p_river", 11, False),
            ("g_mate_shared", "other@example.com", "user_other", "p_river", 2, True),
        ):
            n, skipped = manage_db.upsert_facts(
                email, uid,
                [{
                    "local_gen_id": gid, "job_id": f"job_{gid}", "workspace_scope": "personal",
                    "project_id": pid, "folder_path": "ep001/c0010", "model": "nano", "status": "done",
                    "real_credits": credits, "created_at": "2026-09-01T00:00:00Z",
                    "is_final": False, "is_shared": shared, "is_deleted": False,
                }],
            )
            assert (n, skipped) == (1, [])
        # 팀원 공유분의 발행본이 서버 공유 원장(share 표)에 있어도 멤버에겐 안 보이는지 검증용.
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, folder_path, "
                "created_at, sort_ts, project_id, job_id) "
                "VALUES('srv_mate_shared', 'me', 'user_other', 'p', 'done', 'nano', 'ep001/c0010', "
                "datetime('now'), strftime('%s','now'), 'p_river', 'job_g_mate_shared')"
            )
            conn.execute("INSERT INTO share(generation_id, shared_by) VALUES('srv_mate_shared', 'me')")

    def tearDown(self):
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
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

    def test_visible_project_members_are_limited_to_my_projects(self):
        river = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        with auth_on():
            rows = projects_router.list_visible_members(river)
        self.assertEqual(set(rows), {"p_river"})
        self.assertEqual([row["uid"] for row in rows["p_river"]], ["user_river"])

    def test_project_dashboard_summary_excludes_foreign_projects(self):
        river = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        with auth_on():
            result = manage_router.project_summary(river)
        self.assertEqual([row["pid"] for row in result["projects"]], ["p_river"])
        self.assertNotIn("workers", result)
        self.assertNotIn("workspaces", result)
        # 사용량은 팩트 원천 — 일반 멤버는 내 것(5cr)만. 팀원 공유분(2cr)·미공유(11cr)·남의 프로젝트(p_other 9cr)는
        # SQL 범위 밖(Jay 결정 2026-09-10: 멤버=내 사용량, 매니저=팀 전체).
        self.assertEqual(result["usage_source"], "facts")
        self.assertEqual(result["usage_scope"], "mine")
        self.assertEqual(result["projects"][0]["gen_count"], 1)
        self.assertEqual(result["projects"][0]["credits"], 5)
        self.assertEqual([f["folder_path"] for f in result["projects"][0]["folders"]], ["ep001/c0010"])
        # 매니저(read_all)는 같은 프로젝트의 팀원 미공유분까지 본다(5 + 11 + 2).
        admin = DummyRequest(
            {
                "email": "admin@example.com",
                "status": "approved",
                "global_role": "admin",
                "creator_uid": "user_admin",
            }
        )
        with auth_on():
            full = manage_router.project_summary(admin)
        self.assertEqual(full["usage_scope"], "all")
        river_row = next(row for row in full["projects"] if row["pid"] == "p_river")
        self.assertEqual((river_row["gen_count"], river_row["credits"]), (3, 18))

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

    def test_gen_request_create_rejects_foreign_project(self):
        # p_river 는 river 만 멤버. 비멤버(other)가 그 project_id 로 생성요청 → 403(팀영역 주입 차단).
        from app.models import GenerationCreate, GenRequestIn, WorkspaceContext

        req = DummyRequest(
            {
                "email": "other@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_other",
            }
        )
        body = GenRequestIn(
            kind="create",
            workspace=WorkspaceContext(scope="personal"),
            create=GenerationCreate(prompt="x", model="seedance_2_0", project_id="p_river"),
        )
        with auth_on(), self.assertRaises(HTTPException) as ctx:
            asyncio.run(gen_requests_router.create_gen_request(body, req))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_gen_request_rejects_unknown_workspace_before_creating_placeholder(self):
        from app.models import GenerationCreate, GenRequestIn

        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        body = GenRequestIn(
            kind="create",
            create=GenerationCreate(prompt="x", model="seedance_2_0"),
        )
        with auth_on(), mock.patch.object(
            gen_requests_router,
            "submit_gen_request",
            new=mock.AsyncMock(return_value={"id": "must-not-exist"}),
        ) as submit, self.assertRaises(HTTPException) as ctx:
            asyncio.run(gen_requests_router.create_gen_request(body, req))

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("워크스페이스 정보", str(ctx.exception.detail))
        self.assertIn("다시 선택", str(ctx.exception.detail))
        submit.assert_not_awaited()

    def test_regenerate_requires_recovery_confirmation_before_new_paid_request(self):
        from app.models import GenRequestIn, WorkspaceContext

        gen_id = repo.create_local_generation(
            {"prompt": "ambiguous", "model": "seedance_2_0", "params": {}},
            DEFAULT_WORKER_ID,
            creator_uid="user_river",
            workspace={"scope": "personal", "id": None, "name": None},
        )
        rid = repo.create_gen_request(
            "river@example.com",
            "user_river",
            gen_id,
            "create",
            repo.gen_recipe(gen_id),
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET status='recovery_required' WHERE id=?", (rid,)
            )
            conn.execute("UPDATE generation SET status='running' WHERE id=?", (gen_id,))

        request = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        body = GenRequestIn(
            kind="regenerate",
            workspace=WorkspaceContext(scope="personal"),
            source_gen_id=gen_id,
        )
        with auth_on(), mock.patch.object(
            gen_requests_router,
            "submit_gen_request",
            new=mock.AsyncMock(return_value={"id": "must-not-exist"}),
        ) as submit, self.assertRaises(HTTPException) as ctx:
            asyncio.run(gen_requests_router.create_gen_request(body, request))

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("외부 제출 여부", str(ctx.exception.detail))
        submit.assert_not_awaited()

    def test_generation_recovery_confirmation_requeues_owned_request(self):
        from app.models import RecoveryDecisionIn

        gen_id = repo.create_local_generation(
            {"prompt": "ambiguous", "model": "seedance_2_0", "params": {}},
            DEFAULT_WORKER_ID,
            creator_uid="user_river",
        )
        rid = repo.create_gen_request(
            "river@example.com",
            "user_river",
            gen_id,
            "create",
            repo.gen_recipe(gen_id),
        )
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE gen_request SET status='recovery_required' WHERE id=?", (rid,)
            )
            conn.execute("UPDATE generation SET status='running' WHERE id=?", (gen_id,))
        request = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )

        with auth_on():
            result = asyncio.run(
                gen_requests_router.confirm_generation_not_submitted(
                    gen_id,
                    RecoveryDecisionIn(confirmed_not_submitted=True),
                    request,
                )
            )

        self.assertTrue(result["applied"])
        self.assertEqual(repo.get_gen_request(rid)["status"], "pending")
        self.assertEqual(repo.get_generation(gen_id)["status"], "pending")

    def test_gen_request_workspace_uses_accessible_registry_name(self):
        from app.models import GenerationCreate, GenRequestIn, WorkspaceContext

        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        body = GenRequestIn(
            kind="create",
            workspace=WorkspaceContext(
                scope="team", id="ws-millionvolt", name="old name"
            ),
            create=GenerationCreate(prompt="x", model="seedance_2_0"),
        )
        with auth_on(), mock.patch.object(
            gen_requests_router.repo,
            "list_workspace_registry",
            return_value=[{"id": "ws-millionvolt", "name": "MILLIONVOLT"}],
        ), mock.patch.object(
            gen_requests_router,
            "submit_gen_request",
            new=mock.AsyncMock(return_value={"id": "placeholder"}),
        ) as submit:
            asyncio.run(gen_requests_router.create_gen_request(body, req))
        command = submit.await_args.args[0]
        self.assertEqual(
            command.workspace,
            {"scope": "team", "id": "ws-millionvolt", "name": "MILLIONVOLT"},
        )

    def test_gen_request_workspace_rejects_unavailable_registry_id(self):
        from app.models import WorkspaceContext

        supplied = WorkspaceContext(scope="team", id="ws-foreign", name="FORGED")
        with auth_on(), mock.patch.object(
            gen_requests_router.repo, "list_workspace_registry", return_value=[]
        ), self.assertRaises(HTTPException) as ctx:
            gen_requests_router._validated_generation_workspace(
                supplied, "river@example.com"
            )
        self.assertEqual(ctx.exception.status_code, 409)

    def test_workspace_picker_only_lists_current_account_workspaces(self):
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO workspace_registry(id,name) VALUES(?,?)",
                [("ws-river", "RIVER TEAM"), ("ws-other", "OTHER TEAM")],
            )
            conn.executemany(
                "INSERT INTO workspace_member(workspace_id,account_email,is_available) "
                "VALUES(?,?,1)",
                [
                    ("ws-river", "river@example.com"),
                    ("ws-other", "other@example.com"),
                ],
            )
        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )

        with mock.patch.object(generation_router._proxy, "proxying", return_value=False):
            result = generation_router.available_workspaces(req)

        self.assertEqual(
            result,
            {"workspaces": [{"id": "ws-river", "name": "RIVER TEAM"}]},
        )

    def test_task_history_requires_selected_workspace_membership_and_project_role(self):
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO workspace_registry(id,name) VALUES(?,?)",
                [("ws-river", "RIVER TEAM"), ("ws-other", "OTHER TEAM")],
            )
            conn.execute(
                "INSERT INTO workspace_member(workspace_id,account_email,is_available) "
                "VALUES('ws-river','river@example.com',1)"
            )
            conn.execute(
                "UPDATE project SET workspace_scope='team',workspace_id='ws-river',"
                "workspace_name='RIVER TEAM' WHERE id='p_river'"
            )
        repo_manage.create_task("p_river", "과거 작업")
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE project SET workspace_id='ws-other',workspace_name='OTHER TEAM' "
                "WHERE id='p_river'"
            )
        request = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )

        with auth_on():
            # 현재 위치와 다른 과거 프로젝트지만, 선택 공간 멤버+프로젝트 역할이면 조회 가능.
            manage_router._require_project_read(
                request, "p_river", "ws-river", allow_historical=True
            )
            with self.assertRaises(HTTPException) as current_only:
                manage_router._require_project_read(request, "p_river", "ws-river")
            self.assertEqual(current_only.exception.status_code, 404)
            with self.assertRaises(HTTPException) as unavailable:
                manage_router._require_workspace_read(request, "ws-other")
            self.assertEqual(unavailable.exception.status_code, 404)

    def test_unresolved_task_is_hidden_from_regular_project_members(self):
        rows = [
            {"id": "known", "workspace_unresolved": False},
            {"id": "unknown", "workspace_unresolved": True},
        ]
        member = DummyRequest(
            {
                "email": "river@example.com",
                "global_role": "member",
                "creator_uid": "user_river",
            }
        )
        admin = DummyRequest(
            {
                "email": "admin@example.com",
                "global_role": "admin",
                "creator_uid": "admin",
            }
        )
        with auth_on():
            self.assertEqual(
                [row["id"] for row in manage_router._visible_tasks(member, rows)],
                ["known"],
            )
            self.assertEqual(
                [row["id"] for row in manage_router._visible_tasks(admin, rows)],
                ["known", "unknown"],
            )

    def test_local_gen_request_keeps_agent_name_without_registry(self):
        from app.models import WorkspaceContext

        supplied = WorkspaceContext(scope="team", id="ws-local", name="LOCAL TEAM")
        with mock.patch.object(gen_requests_router, "AUTH_ENABLED", False), mock.patch.object(
            gen_requests_router.repo, "get_registry_workspace", return_value=None
        ):
            validated = gen_requests_router._validated_generation_workspace(
                supplied, "local@example.com"
            )
        self.assertEqual(validated.name, "LOCAL TEAM")

    def test_known_jobs_diff_scopes_by_account_not_global(self):
        # 미링크 계정(creator_uid=None)도 acct:email 로 스코프 — None 전역 job 존재 oracle 방지.
        req = DummyRequest(
            {
                "email": "river@example.com",
                "status": "approved",
                "global_role": "member",
                "creator_uid": None,
            }
        )
        body = ingest_router.KnownJobsIn(job_ids=["j1", "j2"])
        with auth_on(), mock.patch.object(
            ingest_router.repo,
            "job_id_sync_diff",
            return_value={"unknown": [], "refresh": []},
        ) as m:
            ingest_router.known_jobs_diff(body, req)
        self.assertEqual(m.call_args.kwargs.get("creator_uid"), "acct:river@example.com")


if __name__ == "__main__":
    unittest.main()
