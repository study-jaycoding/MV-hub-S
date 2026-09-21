"""PM 대시보드 '관리 표' 읽기(repo/manage_member_table + 라우터). 설계: docs/MEMBER_TABLE_DESIGN.md.

여기서 고정하는 규칙:
- 줄 = 계정(이메일). uid 가 없거나 합성(`acct:`)이면 uid=None · project_editable=False — 프로젝트 칸을 열지 않는다.
- 권한은 `/api/members` 가 계정 상세를 주는 조건과 같다(grant_global 또는 grant_project_role). read_all 만으로는 403.
- 그룹 설정 원문(credit)은 create_project 가 있을 때만. 숨긴 계정은 뺀다.
"""
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app import db, manage_db
from app.repo import manage_credit_plan as plan_repo
from app.repo import manage_member_table as table_repo
from app.routers import manage as manage_router
from test_credit_plan import _acc, _fact, auth_on  # 같은 가짜 요청·팩트 도우미


class MemberTableTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"  # 사용자 DB 격리
        db.flush_pool()
        db.init_db()
        manage_db.init_manage_db()
        with db.get_connection() as conn:
            conn.executemany("INSERT INTO creator(uid, name) VALUES(?,?)", [("u_a", "하늘"), ("u_b", "바다")])
            conn.executemany(
                "INSERT INTO account(email, name, password_hash, status, global_role, creator_uid) VALUES(?,?,?,?,?,?)",
                [
                    ("a@x", "A", "h", "approved", "admin,product_manager", "u_a"),
                    ("a2@x", "A2", "h", "approved", "member", "u_a"),  # 같은 uid 에 묶인 두 번째 계정
                    ("b@x", "B", "h", "approved", "member", "u_b"),
                    ("c@x", "구름", "h", "pending", "member", "acct:c@x"),  # 에이전트 미연결 — 합성 uid
                    ("h@x", "H", "h", "approved", "member", None),
                ],
            )
            conn.execute("UPDATE account SET hidden=1 WHERE email='h@x'")
            conn.execute("INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES('ws1','WS1','enterprise',100)")
            conn.executemany(
                "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, user_role, is_selected, is_available) "
                "VALUES('ws1',?,?,?,1,1)",
                [("a@x", "u_a", "owner"), ("b@x", "u_b", "member"), ("c@x", None, "member"), ("h@x", None, "member")],
            )
            conn.executemany(
                "INSERT INTO project(id, name, kind, archived, workspace_scope, workspace_id) VALUES(?,?,?,?,?,?)",
                [("p1", "본편", "team", 0, "team", "ws1"), ("p2", "보관", "team", 1, "team", "ws1"),
                 ("p3", "다른 공간", "team", 0, "team", "ws2")],
            )
            conn.executemany(
                "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES(?,?,?)",
                [("p1", "u_a", "project_manager"), ("p1", "u_b", "creator,supervisor"), ("p3", "u_b", "creator")],
            )
        saved = plan_repo.save_settings(
            "ws1", revision=0, note=None,
            groups=[{"id": "a" * 32, "name": "3rd floor", "monthly_limit": 5000}],
            members=[{"email": "b@x", "group_id": "a" * 32}],
        )
        self.revision = saved["plan"]["revision"]
        manage_db.upsert_facts("b@x", "u_b", [_fact("f1", creator_uid="u_b", real_credits=30), _fact("f2", creator_uid="u_b", est_credits=12.5)])

    def tearDown(self) -> None:
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        self.tmp.cleanup()

    def test_rows_join_group_projects_usage_and_flag_unlinked_accounts(self) -> None:
        out = table_repo.member_table("ws1", with_credit=True)
        rows = {r["email"]: r for r in out["rows"]}
        self.assertEqual(set(rows), {"a@x", "b@x", "c@x"})  # 숨긴 계정은 빠진다
        self.assertEqual([p["id"] for p in out["projects"]], ["p1"])  # 보관·다른 공간 프로젝트는 열에 없다
        b = rows["b@x"]
        self.assertEqual((b["uid"], b["project_editable"], b["group_id"]), ("u_b", True, "a" * 32))
        self.assertEqual(b["projects"], {"p1": ["creator", "supervisor"]})
        self.assertEqual((b["usage"]["credits"], b["usage"]["count"]), (42.5, 2))
        self.assertEqual(rows["a@x"]["linked_accounts"], 2)  # 등급·프로젝트 변경은 묶인 계정 둘 다에 적용된다
        self.assertEqual(rows["a@x"]["global_roles"], ["admin", "product_manager"])
        c = rows["c@x"]
        self.assertEqual((c["uid"], c["project_editable"], c["project_lock"], c["status"], c["projects"]), (None, False, "unlinked", "pending", {}))
        self.assertEqual(out["credit"]["plan"]["revision"], self.revision)
        self.assertEqual(out["groups"][0]["name"], "3rd floor")
        self.assertIsNone(table_repo.member_table("ws1", with_credit=False)["credit"])
        # 계정의 uid 와 워크스페이스 보고의 uid 가 서로 다르면 누구에게 역할을 줄지 알 수 없다 → 프로젝트 칸을 잠근다
        with db.get_connection() as conn:
            conn.execute("UPDATE workspace_member SET creator_uid='u_other' WHERE account_email='b@x'")
        b = {r["email"]: r for r in table_repo.member_table("ws1", with_credit=True)["rows"]}["b@x"]
        self.assertEqual((b["uid"], b["project_editable"], b["project_lock"]), ("u_b", False, "uid_conflict"))

    def test_without_workspace_lists_all_visible_accounts(self) -> None:
        out = table_repo.member_table(None, with_credit=True)
        self.assertEqual({r["email"] for r in out["rows"]}, {"a@x", "a2@x", "b@x", "c@x"})
        self.assertEqual({p["id"] for p in out["projects"]}, {"p1", "p3"})
        self.assertIsNone(out["credit"])
        self.assertIsNone(out["rows"][0]["usage"])

    def test_route_permission_matches_account_detail_rule(self) -> None:
        with auth_on():
            for role in ("member", "production_director"):  # 감독은 read_all 이 있지만 계정 상세 자격이 아니다
                with self.assertRaises(HTTPException) as ctx:
                    manage_router.member_table(_acc("x@x", "u_x", role), workspace_id="ws1")
                self.assertEqual(ctx.exception.status_code, 403)
            pm = manage_router.member_table(_acc("b@x", "u_b", "product_manager"), workspace_id="ws1")
            self.assertEqual(pm["caps"], {"account": False, "credit": True, "project_roles": True})
            self.assertIsNotNone(pm["credit"])
            admin = manage_router.member_table(_acc("a@x", "u_a", "admin"), workspace_id="ws1")
            self.assertEqual(admin["caps"], {"account": True, "credit": False, "project_roles": False})
            self.assertIsNone(admin["credit"])  # 저장에 쓰는 원문은 저장 권한이 있을 때만
            self.assertEqual(admin["groups"][0]["id"], "a" * 32)  # 그룹 이름·남은 양은 보기용으로 준다
        self.assertEqual(manage_router.member_table(_acc("x@x", None), workspace_id=None)["caps"]["account"], True)  # AUTH off


if __name__ == "__main__":
    unittest.main()
