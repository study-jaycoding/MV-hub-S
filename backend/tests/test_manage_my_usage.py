"""관리 대시보드 열람 범위 — 일반 멤버=내 사용량만(서버가 (uid, email) 로 강제), 매니저(read_all)=팀 전체.
Jay 결정 2026-09-10. team-overview·team-timeseries·usage-export·workspaces 라우터를 직접 호출한다."""
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

from app import db, manage_db
from app import deps as deps_mod
from app.routers import manage as manage_router


class DummyState:
    pass


class DummyRequest:
    def __init__(self, account: dict | None):
        self.state = DummyState()
        self.state.account = account


def auth_on():
    stack = ExitStack()
    stack.enter_context(mock.patch.object(deps_mod, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(manage_router, "AUTH_ENABLED", True))
    return stack


def _fact(gid: str, **kw) -> dict:
    base = {
        "local_gen_id": gid,
        "job_id": f"job-{gid}",
        "workspace_scope": "team",
        "workspace_id": "ws1",
        "workspace_name": "WS1",
        "project_id": "p1",
        "project_name": "Project",
        "folder_path": "e001/c0010",
        "model": "seedance",
        "output_type": "video",
        "status": "done",
        "real_credits": None,
        "created_at": "2026-09-01T00:00:00Z",
        "is_final": False,
        "is_shared": False,
        "is_deleted": False,
    }
    base.update(kw)
    return base


def _account(email: str, uid: str | None, role: str = "member") -> DummyRequest:
    return DummyRequest(
        {"email": email, "status": "approved", "global_role": role, "creator_uid": uid}
    )


class MyUsageScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"  # 사용자 DB 격리
        db.flush_pool()
        db.init_db()
        manage_db.init_manage_db()
        # 팩트: a(u_a) 2건, b(u_b) 1건
        n, skipped = manage_db.upsert_facts(
            "a@x", "u_a", [_fact("f1", real_credits=10), _fact("f2", real_credits=5, folder_path="e001/c0020")]
        )
        self.assertEqual((n, skipped), (2, []))
        n, skipped = manage_db.upsert_facts(
            "b@x", "u_b", [_fact("f3", creator_uid="u_b", real_credits=7)]
        )
        self.assertEqual((n, skipped), (1, []))
        # 워크스페이스 등록부: a 는 ws1 만 접근 가능(ws2 는 접근 불가 이력), b 는 ws2
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES(?,?,?,?)",
                [("ws1", "WS1", "team", 100), ("ws2", "WS2", "team", 50)],
            )
            conn.executemany(
                "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, user_role, "
                "is_selected, is_available) VALUES(?,?,?,?,?,?)",
                [
                    ("ws1", "a@x", "u_a", "member", 1, 1),
                    ("ws2", "a@x", "u_a", "member", 0, 0),
                    ("ws2", "b@x", "u_b", "member", 1, 1),
                ],
            )

    def tearDown(self) -> None:
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_member_overview_is_forced_to_own_records_even_with_foreign_filter(self) -> None:
        with auth_on():
            out = manage_router.team_overview(_account("a@x", "u_a"), creator_uid="u_b")
        self.assertEqual(out["usage_scope"], "mine")
        self.assertEqual(out["totals"]["count"], 2)
        self.assertEqual(out["totals"]["credits"], 15)
        # 세부 배열 전부 같은 WHERE — 남의 기록이 어디에도 섞이지 않는다.
        self.assertEqual([r["creator_uid"] for r in out["by_worker"]], ["u_a"])
        self.assertEqual({r["creator_uid"] for r in out["matrix"]}, {"u_a"})
        self.assertEqual({r["creator_uid"] for r in out["worker_models"]}, {"u_a"})
        self.assertEqual(sum(r["count"] for r in out["folder_efficiency"]), 2)
        self.assertEqual(sum(r["count"] for r in out["project_models"]), 2)

    def test_manager_keeps_team_scope_and_worker_filter(self) -> None:
        admin = _account("admin@x", "u_admin", role="admin")
        with auth_on():
            filtered = manage_router.team_overview(admin, creator_uid="u_b")
            full = manage_router.team_overview(admin)
        self.assertEqual(filtered["usage_scope"], "all")
        self.assertEqual(filtered["totals"]["count"], 1)
        self.assertEqual([r["creator_uid"] for r in filtered["by_worker"]], ["u_b"])
        self.assertEqual(full["totals"]["count"], 3)

    def test_auth_off_is_unscoped(self) -> None:
        out = manage_router.team_overview(DummyRequest(None))
        self.assertEqual(out["usage_scope"], "all")
        self.assertEqual(out["totals"]["count"], 3)

    def test_uid_alone_is_not_enough_email_must_match_too(self) -> None:
        # 남의 uid 로 연결된 계정(코덱스 P1): uid 는 u_a 지만 세션 이메일이 다르면 0건.
        with auth_on():
            out = manage_router.team_overview(_account("z@x", "u_a"))
        self.assertEqual(out["totals"]["count"], 0)
        self.assertEqual(out["by_worker"], [])

    def test_special_filter_values_are_not_interpreted_for_members(self) -> None:
        # 작성자 미상(NULL) 팩트가 있어도 세션 uid '__none__' 이 'IS NULL' 필터로 해석되지 않는다(코덱스 P1).
        with manage_db.get_connection() as conn:
            conn.execute("UPDATE team_generation_fact SET creator_uid=NULL WHERE local_gen_id='f3'")
        with auth_on():
            out = manage_router.team_overview(_account("b@x", "__none__"))
        self.assertEqual(out["totals"]["count"], 0)

    def test_unlinked_member_sees_nothing(self) -> None:
        # 힉스필드 uid 미링크(acct:이메일 스코프) — 팩트는 링크된 계정만 올라오므로 빈 결과.
        with auth_on():
            out = manage_router.team_overview(_account("a@x", None))
        self.assertEqual(out["totals"]["count"], 0)

    def test_timeseries_and_export_are_scoped_for_members(self) -> None:
        with auth_on():
            ts = manage_router.team_timeseries(_account("a@x", "u_a"), creator_uid="u_b", bucket="month")
            rows = manage_router.usage_export(_account("a@x", "u_a"), creator_uid="u_b")["rows"]
        self.assertEqual(sum(b["count"] for b in ts["buckets"]), 2)
        self.assertEqual({r["user_id"] for r in rows}, {"u_a"})
        self.assertEqual(sum(r["jobs"] for r in rows), 2)

    def test_workspaces_list_is_limited_to_my_memberships(self) -> None:
        with auth_on():
            mine = manage_router.manage_workspaces(_account("a@x", "u_a"))["workspaces"]
            theirs = manage_router.manage_workspaces(_account("b@x", "u_b"))["workspaces"]
            everything = manage_router.manage_workspaces(_account("admin@x", "u_admin", "admin"))["workspaces"]
            nobody = manage_router.manage_workspaces(_account("nobody@x", "u_n"))["workspaces"]
            no_email = manage_router.manage_workspaces(_account("", "u_a"))["workspaces"]
        self.assertEqual([w["id"] for w in mine], ["ws1"])  # ws2 는 접근 불가(is_available=0) → 제외
        self.assertEqual([w["id"] for w in theirs], ["ws2"])
        self.assertEqual([w["id"] for w in everything], ["ws1", "ws2"])
        self.assertEqual(nobody, [])
        self.assertEqual(no_email, [])  # 이메일 없으면 전체로 폴백하지 않는다(코덱스)


if __name__ == "__main__":
    unittest.main()
