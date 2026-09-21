"""마지막 관리자 보호 — 승인된 admin 이 0명이 되는 쓰기를 거부한다.

0명이 되면 아무도 전역 역할을 주거나 가입을 승인할 수 없다(그 API 들이 admin 전용이다).
일반 API 로는 빠져나올 수 없으므로 서버가 쓰기 단계에서 막는다.

여기서 고정하는 규칙:
- 관리자 = `status='approved'` 이고 전역 역할에 `admin` 이 있는 계정(숨김도 센다 — 숨김은 표시만 가린다).
- 막는 경로 셋: 계정 역할 · 멤버(uid) 역할 · 가입 상태. 셋 다 409, DB 는 그대로.
- 관리자가 둘 이상이면 하나를 내릴 수 있다(정상 교체를 막지 않는다).
- 이미 0명이면 통과시킨다(그 상태를 고치려는 쓰기까지 막지 않는다).
"""
from __future__ import annotations

import os
import tempfile
import threading
import unittest

from app import db, rbac, repo
from app.repo import identity as repo_identity


def _admins() -> set[str]:
    with db.get_connection() as conn:
        return {
            r["email"]
            for r in conn.execute("SELECT email, global_role FROM account WHERE status='approved'")
            if rbac.ADMIN in rbac.parse_roles(r["global_role"])
        }


class LastAdminGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _account(self, email, roles, *, status="approved", uid=None, hidden=0):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO account(email, name, password_hash, status, global_role, creator_uid, hidden) "
                "VALUES(?,?,'x',?,?,?,?)",
                (email, email.split("@")[0], status, rbac.roles_to_str(roles), uid, hidden),
            )
        return email

    # ── 막아야 하는 것 ────────────────────────────────────────────────────
    def test_removing_the_only_admins_role_is_refused_on_every_path(self):
        """경로 셋 모두 거부하고 DB 를 바꾸지 않는다 — 계정 역할 · 멤버(uid) 역할 · 가입 상태."""
        only = self._account("only@x.com", ["admin", "product_manager"], uid="u_only")
        self._account("member@x.com", ["member"], uid="u_member")
        for label, call in (
            ("계정 역할", lambda: repo.set_account_global_roles(only, ["member"])),
            ("멤버 역할", lambda: repo_identity.set_member_global_roles("u_only", ["member"])),
            ("가입 상태", lambda: repo.set_account_status(only, "pending")),
            ("가입 거부", lambda: repo.set_account_status(only, "rejected")),
        ):
            with self.subTest(label), self.assertRaises(repo.LastAdminError):
                call()
            self.assertEqual(_admins(), {only}, label)  # 되돌아갔다
        with db.get_connection() as conn:
            row = conn.execute("SELECT status, global_role FROM account WHERE email=?", (only,)).fetchone()
        self.assertEqual((row["status"], row["global_role"]), ("approved", "admin,product_manager"))

    def test_an_empty_role_list_normalizes_to_member_and_is_still_refused(self):
        """빈 입력은 member 로 정규화된다 — 그 경로로도 마지막 관리자를 못 내린다."""
        only = self._account("only@x.com", ["admin"], uid="u_only")
        for call in (lambda: repo.set_account_global_roles(only, []),
                     lambda: repo_identity.set_member_global_roles("u_only", [])):
            with self.assertRaises(repo.LastAdminError):
                call()
        self.assertEqual(_admins(), {only})

    def test_a_hidden_admin_counts_so_hiding_does_not_create_a_last_admin(self):
        """숨김은 목록에서 가릴 뿐 로그인·권한은 그대로다 → 숨긴 관리자도 센다."""
        hidden_admin = self._account("hidden@x.com", ["admin"], hidden=1)
        visible = self._account("visible@x.com", ["admin"])
        self.assertEqual(_admins(), {hidden_admin, visible})
        repo.set_account_global_roles(visible, ["member"])  # 숨긴 관리자가 남아 있으니 통과
        self.assertEqual(_admins(), {hidden_admin})
        with self.assertRaises(repo.LastAdminError):  # 이제 숨긴 그가 마지막이다
            repo.set_account_global_roles(hidden_admin, ["member"])

    def test_one_uid_with_several_accounts_rolls_back_all_of_them(self):
        """한 uid 가 여러 account 를 한 번에 바꾼다 — 거부되면 전부 되돌아간다."""
        a = self._account("a@x.com", ["admin"], uid="u_same")
        b = self._account("b@x.com", ["admin"], uid="u_same")
        with self.assertRaises(repo.LastAdminError):
            repo_identity.set_member_global_roles("u_same", ["member"])
        self.assertEqual(_admins(), {a, b})

    # ── 막으면 안 되는 것 ─────────────────────────────────────────────────
    def test_a_normal_handover_is_allowed(self):
        """관리자가 둘이면 하나를 내릴 수 있다 — 새 관리자를 세운 뒤 교체하는 정상 절차."""
        old = self._account("old@x.com", ["admin"])
        new = self._account("new@x.com", ["admin"])
        repo.set_account_global_roles(old, ["member"])
        self.assertEqual(_admins(), {new})

    def test_changes_that_keep_admin_are_untouched(self):
        """admin 을 유지하는 역할 변경·재승인은 그대로 통과한다."""
        only = self._account("only@x.com", ["admin"], uid="u_only")
        self.assertIsNotNone(repo.set_account_global_roles(only, ["admin", "production_director"]))
        repo_identity.set_member_global_roles("u_only", ["admin", "product_manager"])
        self.assertIsNotNone(repo.set_account_status(only, "approved"))
        self.assertEqual(_admins(), {only})

    def test_a_db_without_any_admin_is_not_frozen(self):
        """이미 0명이면 통과시킨다 — 그 상태를 고치려는 쓰기까지 막으면 손댈 방법이 없어진다."""
        nobody = self._account("nobody@x.com", ["member"], uid="u_nobody")
        pending_admin = self._account("waiting@x.com", ["admin"], status="pending")
        self.assertEqual(_admins(), set())  # 승인 안 된 admin 은 권한이 없다 → 0명
        repo.set_account_global_roles(nobody, ["member"])  # 통과
        repo_identity.set_member_global_roles("u_nobody", ["member"])  # 통과
        repo.set_account_status(pending_admin, "approved")  # 통과 — 여기서 1명이 된다
        self.assertEqual(_admins(), {pending_admin})

    def test_a_refusal_leaves_no_open_transaction_on_the_pooled_connection(self):
        """거부는 되돌리기까지 끝내고 나온다 — 열린 트랜잭션이 남으면 그 스레드의 다음 쓰기가 막힌다."""
        only = self._account("only@x.com", ["admin"], uid="u_only")
        with self.assertRaises(repo.LastAdminError):
            repo.set_account_global_roles(only, ["member"])
        with db.get_connection() as conn:
            self.assertFalse(conn.in_transaction)
        self._account("next@x.com", ["member"])  # 다음 쓰기가 그대로 된다
        self.assertEqual(_admins(), {only})

    def test_missing_account_and_bad_status_keep_their_old_contracts(self):
        """없는 계정은 None, 잘못된 상태는 ValueError — 보호를 넣어도 기존 계약이 그대로다."""
        self._account("only@x.com", ["admin"])
        self.assertIsNone(repo.set_account_global_roles("nosuch@x.com", ["member"]))
        self.assertIsNone(repo.set_account_status("nosuch@x.com", "pending"))
        with self.assertRaises(ValueError) as ctx:
            repo.set_account_status("only@x.com", "무효")
        self.assertNotIsInstance(ctx.exception, repo.LastAdminError)  # 400 과 409 가 섞이지 않는다

    def test_two_admins_removing_each_other_at_once_leaves_exactly_one(self):
        """동시에 서로를 내리면 하나만 성공한다 — 검사~쓰기가 한 쓰기락이라 둘째는 0이 되는 걸 본다."""
        a = self._account("a@x.com", ["admin"])
        b = self._account("b@x.com", ["admin"])
        start, refused = threading.Barrier(2), []

        def drop(target):
            db.flush_pool()  # 스레드마다 제 커넥션
            start.wait(timeout=5)
            try:
                repo.set_account_global_roles(target, ["member"])
            except repo.LastAdminError:
                refused.append(target)

        threads = [threading.Thread(target=drop, args=(t,)) for t in (a, b)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        self.assertEqual(len(_admins()), 1)  # 둘 다 내려가지 않았다
        self.assertEqual(len(refused), 1)


class LastAdminRouteTests(unittest.TestCase):
    """제품 경로(HTTP) — 세 라우터가 409 로 돌려주고, 잘못된 입력의 400 과 섞이지 않는다.
    권한 게이트가 아니라 데이터 불변식이므로 AUTH 가 꺼져 있어도(시험 기본값) 걸린다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        repo.ensure_admin_account("admin@example.com", "admin-password")  # 유일한 관리자
        with db.get_connection() as conn:
            conn.execute("UPDATE account SET creator_uid='u_admin' WHERE email='admin@example.com'")
        from fastapi.testclient import TestClient

        from app.main import app

        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        self.client.close()
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_every_route_answers_409_and_leaves_the_admin_alone(self):
        cases = {
            "계정 역할": ("/api/auth/accounts/admin@example.com/global-roles", {"global_roles": ["member"]}),
            "멤버 역할": ("/api/members/u_admin/global-roles", {"global_roles": ["member"]}),
            "가입 상태": ("/api/auth/accounts/admin@example.com/status", {"status": "pending"}),
        }
        for label, (url, body) in cases.items():
            with self.subTest(label):
                response = self.client.patch(url, json=body)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertIn("마지막 관리자", response.json()["detail"])
        self.assertEqual(_admins(), {"admin@example.com"})

    def test_bad_status_is_still_400_not_409(self):
        response = self.client.patch("/api/auth/accounts/admin@example.com/status", json={"status": "무효"})
        self.assertEqual(response.status_code, 400, response.text)

    def test_a_second_admin_makes_the_change_go_through(self):
        repo.register("second@example.com", "password-123", "second")
        self.assertEqual(
            self.client.patch(
                "/api/auth/accounts/second@example.com/status", json={"status": "approved"}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.patch(
                "/api/auth/accounts/second@example.com/global-roles", json={"global_roles": ["admin"]}
            ).status_code,
            200,
        )
        response = self.client.patch(
            "/api/auth/accounts/admin@example.com/global-roles", json={"global_roles": ["member"]}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(_admins(), {"second@example.com"})


if __name__ == "__main__":
    unittest.main()
