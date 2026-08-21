"""신원 전환(acct:email → user_) 정합 불변식 — remap·휴지통·텔레메트리.

이번 세션에서 잡은 remap 누락(휴지통·텔레메트리)과 core remap 을 불변식으로 고정한다.
전환 후에도 옛 신원으로 만든/지운 데이터가 새 신원과 정합해야 한다.
"""
import json
import os
import tempfile
import unittest

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
