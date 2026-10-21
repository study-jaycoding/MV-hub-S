"""신원 전환(acct:email → user_) 정합 불변식 — remap·휴지통·텔레메트리.

이번 세션에서 잡은 remap 누락(휴지통·텔레메트리)과 core remap 을 불변식으로 고정한다.
전환 후에도 옛 신원으로 만든/지운 데이터가 새 신원과 정합해야 한다.
"""
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.repo import identity, manage, trash


def _seed_account(conn, email, creator_uid):
    conn.execute(
        "INSERT INTO account(email, name, password_hash, status, creator_uid) "
        "VALUES(?,?,?,?,?)",
        (email, "User", "h", "approved", creator_uid),
    )


class IdentityRemapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_hf_link_rejects_another_accounts_uid_without_remapping(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", "acct:b@x.com")
        with mock.patch.object(identity, "remap_creator_uid") as remap:
            self.assertEqual(identity.set_account_hf_creator("b@x.com", "user_A"), "conflict")
        remap.assert_not_called()
        self.assertEqual(repo.get_account("b@x.com")["creator_uid"], "acct:b@x.com")

    def test_hf_link_rejects_reserved_account_alias(self):
        with db.get_connection() as conn:
            _seed_account(conn, "b@x.com", "acct:b@x.com")
        for uid in ("acct:a@x.com", " acct:unregistered@x.com ", "acct:b@x.com"):
            with self.subTest(uid=uid):
                self.assertEqual(identity.set_account_hf_creator("b@x.com", uid), "reserved")
                self.assertEqual(repo.get_account("b@x.com")["creator_uid"], "acct:b@x.com")

    def test_hf_link_same_uid_is_idempotent(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "acct:a@x.com")
        self.assertIs(identity.set_account_hf_creator("a@x.com", "user_A"), True)
        self.assertIs(identity.set_account_hf_creator("a@x.com", "user_A"), True)
        self.assertEqual(repo.get_account("a@x.com")["creator_uid"], "user_A")

    def test_hf_link_race_has_only_one_owner(self):
        emails = ("a@x.com", "b@x.com")
        with db.get_connection() as conn:
            for email in emails:
                _seed_account(conn, email, "acct:" + email)
        barrier = Barrier(2)

        def link(email):
            barrier.wait(timeout=5)
            return identity.set_account_hf_creator(email, "user_race")

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(link, emails))
        self.assertCountEqual(results, [True, "conflict"])
        for email, result in zip(emails, results):
            self.assertEqual(
                repo.get_account(email)["creator_uid"],
                "user_race" if result is True else "acct:" + email,
            )

    def test_inferred_link_cannot_take_another_accounts_uid(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", "acct:b@x.com")
            identity.ensure_worker(conn, "acct:b@x.com", "B", "team")
            conn.execute(
                "INSERT INTO generation(id,worker_id,creator_uid,prompt,status) "
                "VALUES('hf','me','user_A','p','done')"
            )
            conn.execute("INSERT INTO share(id,generation_id,shared_by) VALUES('s','hf','acct:b@x.com')")
        identity.link_accounts_to_creators()
        self.assertEqual(repo.get_account("b@x.com")["creator_uid"], "acct:b@x.com")
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT shared_by FROM share").fetchone()[0], "acct:b@x.com")

    def test_provider_inference_cannot_take_owned_or_reserved_uid(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", None)
        identity.set_setting("provider_email", "b@x.com")
        for uid in ("user_A", "acct:unregistered@x.com"):
            with self.subTest(uid=uid):
                with db.get_connection() as conn:
                    conn.execute("UPDATE account SET creator_uid=NULL WHERE email='b@x.com'")
                identity.set_setting("my_creator_uid", uid)
                identity.link_accounts_to_creators()
                self.assertEqual(repo.get_account("b@x.com")["creator_uid"], "acct:b@x.com")

    def test_duplicate_links_are_counted_without_repair_or_private_log_fields(self):
        with db.get_connection() as conn:
            for email in ("a@x.com", "b@x.com"):
                _seed_account(conn, email, "user_A")
        with self.assertLogs(identity.__name__, level="WARNING") as logs:
            identity.link_accounts_to_creators()
        self.assertEqual(logs.records[0].getMessage(), "Duplicate account creator_uid links: rows=2")
        for email in ("a@x.com", "b@x.com"):
            self.assertEqual(repo.get_account(email)["creator_uid"], "user_A")
            self.assertNotIn(email, " ".join(logs.output))
        self.assertNotIn("user_A", " ".join(logs.output))

    def test_ingest_rejection_preserves_identity_and_cannot_gain_project_role(self):
        from app import deps
        from app.routers import ingest

        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", "acct:b@x.com")
            conn.execute("INSERT INTO project(id,name) VALUES('p','A project')")
            conn.execute("INSERT INTO creator(uid,name) VALUES('user_A','A')")
            conn.execute("INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('p','user_A','editor')")
        for auth in (True, False):
            for reported, parsed_uid, reason in (
                ("user_A", None, "conflict"),
                (None, "user_A", "conflict"),
                ("acct:unregistered@x.com", None, "reserved"),
            ):
                with self.subTest(auth=auth, reported=reported, parsed_uid=parsed_uid):
                    parsed = {"generation": {"id": "incoming", "creator_uid": parsed_uid}}
                    with (
                        mock.patch.object(ingest, "AUTH_ENABLED", auth),
                        mock.patch("app.active_account.account_key", return_value="b@x.com"),
                        mock.patch.object(ingest.cli_bridge, "parse_job", return_value=parsed),
                        mock.patch.object(repo, "apply_synced_jobs") as sync,
                        mock.patch.object(repo, "learn_my_creator_uid") as learn,
                        self.assertLogs(ingest._logger, level="WARNING") as logs,
                        self.assertRaises(HTTPException) as caught,
                    ):
                        ingest._ingest_core(repo.get_account("b@x.com"), [{}], reported, {"email": "b@x.com"})
                    self.assertEqual(caught.exception.status_code, 409)
                    self.assertEqual(caught.exception.detail, "creator_uid_link_" + reason)
                    self.assertNotIn("@", " ".join(logs.output))
                    self.assertNotIn("user_A", " ".join(logs.output))
                    sync.assert_not_called()
                    learn.assert_not_called()
                    account = repo.get_account("b@x.com")
                    self.assertEqual(account["creator_uid"], "acct:b@x.com")
                    request = SimpleNamespace(state=SimpleNamespace(account=account))
                    with mock.patch.object(deps, "AUTH_ENABLED", True):
                        self.assertEqual(deps.project_roles_of(request, "p"), "")
                        with self.assertRaises(HTTPException) as denied:
                            deps.require_project_role(request, "p", "editor")
                        self.assertEqual(denied.exception.status_code, 403)

    def test_migrate_batch_does_not_rerun_full_plan_scan(self):
        """기동 배치는 account_map 만 새로 만들고 전 테이블 dry-run 스캔을 반복하지 않는다.
        결과는 종전(plan 의 account_map 사용)과 동일해야 한다: 매핑 있음=정합, 고아 acct:=불변."""
        from unittest import mock

        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")          # 매핑 소스
            _seed_account(conn, "b@x.com", "acct:b@x.com")    # acct: 계정 — 매핑 소스 아님
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, created_at, sort_ts) "
                "VALUES('g-map','me','acct:a@x.com','p','done','2026-01-01',1)"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, created_at, sort_ts) "
                "VALUES('g-orphan','me','acct:ghost@x.com','p','done','2026-01-01',2)"
            )
        with mock.patch.object(
            identity, "creator_uid_remap_plan", side_effect=AssertionError("전 테이블 재스캔 금지")
        ):
            changed = identity.migrate_all_acct_to_creator_uid()
        self.assertGreaterEqual(changed, 1)
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute("SELECT creator_uid FROM generation WHERE id='g-map'").fetchone()[0],
                "user_A",
            )
            # account 에 대응 없는 고아 acct: 는 손대지 않는다(종전 계약 유지).
            self.assertEqual(
                conn.execute("SELECT creator_uid FROM generation WHERE id='g-orphan'").fetchone()[0],
                "acct:ghost@x.com",
            )
        # dry-run(plan)은 여전히 독립 동작하며 같은 account_map 을 보고한다(단일 소스 공유).
        plan = identity.creator_uid_remap_plan()
        self.assertEqual(plan["account_map"], {"acct:a@x.com": "user_A"})
        self.assertIn("acct:ghost@x.com", plan["unmapped"])  # 고아는 여전히 unmapped 로 보고

    def test_batch_remaps_legacy_email_only_for_linked_accounts(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", "acct:b@x.com")
            for gid, uid in [("linked", "a@x.com"), ("unlinked", "b@x.com"), ("orphan", "ghost@x.com")]:
                conn.execute(
                    "INSERT INTO generation(id,worker_id,creator_uid,prompt,status) VALUES(?,'me',?,'p','done')",
                    (gid, uid),
                )
        self.assertGreaterEqual(identity.migrate_all_acct_to_creator_uid(), 1)
        self.assertEqual(identity.migrate_all_acct_to_creator_uid(), 0)
        with db.get_connection() as conn:
            actual = dict(conn.execute("SELECT id,creator_uid FROM generation").fetchall())
        self.assertEqual(actual, {"linked": "user_A", "unlinked": "b@x.com", "orphan": "ghost@x.com"})

    def test_legacy_reserved_email_cannot_remap_another_accounts_uid(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "acct:a@x.com")
            _seed_account(conn, "acct:a@x.com", "acct:acct:a@x.com")
            conn.execute(
                "INSERT INTO generation(id,worker_id,creator_uid,prompt,status) "
                "VALUES('victim','me','acct:a@x.com','p','done')"
            )
        identity.set_account_hf_creator("acct:a@x.com", "user_other")
        identity.migrate_all_acct_to_creator_uid()
        self.assertEqual(repo.get_generation("victim")["creator_uid"], "acct:a@x.com")

    def test_inferred_link_remaps_own_legacy_email(self):
        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "acct:a@x.com")
            identity.ensure_worker(conn, "acct:a@x.com", "A", "team")
            for gid, uid in [("hf", "user_A"), ("email", "a@x.com")]:
                conn.execute(
                    "INSERT INTO generation(id,worker_id,creator_uid,prompt,status) VALUES(?,'me',?,'p','done')",
                    (gid, uid),
                )
            conn.execute("INSERT INTO share(id,generation_id,shared_by) VALUES('share','hf','acct:a@x.com')")
        identity.link_accounts_to_creators()
        self.assertEqual(repo.get_account("a@x.com")["creator_uid"], "user_A")
        self.assertEqual(repo.get_generation("email")["creator_uid"], "user_A")

    def test_email_remap_failure_rolls_back_link_and_batch(self):
        from unittest import mock

        with db.get_connection() as conn:
            _seed_account(conn, "a@x.com", "acct:a@x.com")
            for gid, uid in [("alias", "acct:a@x.com"), ("email", "a@x.com")]:
                conn.execute(
                    "INSERT INTO generation(id,worker_id,creator_uid,prompt,status) VALUES(?,'me',?,'p','done')",
                    (gid, uid),
                )
        original = identity.remap_creator_uid

        def fail_after_email(conn, old, new):
            result = original(conn, old, new)
            if old == "a@x.com":
                raise RuntimeError("email remap failure")
            return result

        for batch in (False, True):
            if batch:
                with db.get_connection() as conn:
                    conn.execute("UPDATE account SET creator_uid='user_A'")
            with mock.patch.object(identity, "remap_creator_uid", side_effect=fail_after_email):
                with self.assertRaisesRegex(RuntimeError, "email remap failure"):
                    if batch:
                        identity.migrate_all_acct_to_creator_uid()
                    else:
                        identity.set_account_hf_creator("a@x.com", "user_A")
            with db.get_connection() as conn:
                actual = dict(conn.execute("SELECT id,creator_uid FROM generation").fetchall())
                account = conn.execute("SELECT creator_uid FROM account").fetchone()[0]
            self.assertEqual(actual, {"alias": "acct:a@x.com", "email": "a@x.com"})
            self.assertEqual(account, "user_A" if batch else "acct:a@x.com")

    def test_remap_updates_core_identity_columns(self):
        # acct:a → user_A 전환 시 핵심 신원 컬럼이 모두 정합돼야(remap 누락=신원 단절).
        with db.get_connection() as conn:
            identity.ensure_worker(conn, "user_A", "A", "team")
            identity.ensure_worker(conn, "acct:a", "A-old", "team")  # share.shared_by FK→worker
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, final_by, prompt, model, status, created_at) "
                "VALUES('g1','me','acct:a','acct:a','p','m','done','2026-01-01')"
            )
            conn.execute(
                "INSERT INTO generation_comment(id, gen_id, author, text, created_at) "
                "VALUES('c1','g1','acct:a','hi','2026-01-01')"
            )
            conn.execute(
                "INSERT INTO share(id, generation_id, shared_by, visibility) VALUES('s1','g1','acct:a','team')"
            )
            # read/seen 의 worker_id 컬럼은 실제로 actor(creator_uid) 축 — remap 대상(ignore_del 전략).
            conn.execute(
                "INSERT INTO generation_comment_read(gen_id, worker_id, read_at) "
                "VALUES('g1','acct:a','2026-01-01')"
            )
            conn.execute(
                "INSERT INTO generation_comment_seen(worker_id, comment_id, seen_at) "
                "VALUES('acct:a','c1','2026-01-01')"
            )
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, is_tombstone, tomb_creator_uid) "
                "VALUES('g1',1,'acct:a')"
            )
            n = identity.remap_creator_uid(conn, "acct:a", "user_A")
            self.assertGreater(n, 0)
            g = conn.execute("SELECT creator_uid, final_by FROM generation WHERE id='g1'").fetchone()
            self.assertEqual((g["creator_uid"], g["final_by"]), ("user_A", "user_A"))
            self.assertEqual(
                conn.execute("SELECT author FROM generation_comment WHERE id='c1'").fetchone()["author"],
                "user_A",
            )
            self.assertEqual(
                conn.execute("SELECT shared_by FROM share WHERE id='s1'").fetchone()["shared_by"],
                "user_A",
            )
            self.assertEqual(
                conn.execute(
                    "SELECT tomb_creator_uid FROM telemetry_outbox WHERE local_gen_id='g1'"
                ).fetchone()["tomb_creator_uid"],
                "user_A",
            )
            # read/seen 의 worker_id(=actor) 컬럼도 치환됐는지(ignore_del 전략 정합).
            self.assertEqual(
                conn.execute(
                    "SELECT worker_id FROM generation_comment_read WHERE gen_id='g1'"
                ).fetchone()["worker_id"],
                "user_A",
            )
            self.assertEqual(
                conn.execute(
                    "SELECT worker_id FROM generation_comment_seen WHERE comment_id='c1'"
                ).fetchone()["worker_id"],
                "user_A",
            )
        # generation.worker_id 는 워크스테이션 축이라 remap 대상이 아님(불변식).
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute("SELECT worker_id FROM generation WHERE id='g1'").fetchone()["worker_id"],
                "me",
            )

    def test_trash_alias_recognition_and_payload_rewrite(self):
        # acct:a@x.com 시절 삭제 → user_A 전환 후 목록에 보이고, 복원 시 payload 신원이 user_A 로 치환.
        with db.get_connection() as conn:
            identity.ensure_worker(conn, "user_A", "A", "team")
            _seed_account(conn, "a@x.com", "user_A")
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, model, status, created_at) "
                "VALUES('g1','me','acct:a@x.com','p','m','done','2026-01-01')"
            )
            conn.execute(
                "INSERT INTO generation_comment(id, gen_id, author, text, created_at) "
                "VALUES('c1','g1','acct:a@x.com','hi','2026-01-01')"
            )
        self.assertTrue(trash.move_to_trash("g1"))
        # 전환 후 신원(user_A)으로 옛 acct: 항목이 목록에 보여야(별칭 인식)
        listed = trash.list_trash(account_uid="user_A")
        self.assertEqual(len(listed), 1)
        # 복원 시 payload 안 acct: → user_A 치환(재유입 차단)
        self.assertTrue(trash.restore_from_trash("g1", account_uid="user_A"))
        with db.get_connection() as conn:
            self.assertEqual(
                conn.execute("SELECT creator_uid FROM generation WHERE id='g1'").fetchone()["creator_uid"],
                "user_A",
            )
            self.assertEqual(
                conn.execute("SELECT author FROM generation_comment WHERE id='c1'").fetchone()["author"],
                "user_A",
            )

    def test_trash_restore_rejects_other_account(self):
        # 남의 휴지통 항목은 복원 불가(별칭 확장이 소유 경계를 넓히지 않는다).
        with db.get_connection() as conn:
            identity.ensure_worker(conn, "user_A", "A", "team")
            identity.ensure_worker(conn, "user_B", "B", "team")
            _seed_account(conn, "a@x.com", "user_A")
            _seed_account(conn, "b@x.com", "user_B")
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, model, status, created_at) "
                "VALUES('g1','me','user_A','p','m','done','2026-01-01')"
            )
        self.assertTrue(trash.move_to_trash("g1"))
        with self.assertRaises(PermissionError):
            trash.restore_from_trash("g1", account_uid="user_B")


if __name__ == "__main__":
    unittest.main()
