"""'local'↔실제 이메일 거래 별칭과 옛 shots 오태깅 — 장부 병합·적재 승계·매칭 격리(2026-10-02, 설계 r4 Codex 승인)."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from app import db, repo
from app.repo import manage, manage_schema

REAL = "artist@example.test"


class CreditTxnAliasTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "alias.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.base = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute("INSERT INTO creator(uid,name) VALUES('user_me','Artist')")

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    # ── 도우미 ──
    def at(self, seconds):
        return (self.base + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

    def txn(self, seconds=0, amount=2.0, *, model=None, label="Nano Banana Pro"):
        return {"created_at": self.at(seconds), "credits": -amount, "action": "spend",
                "display_name": label, "model": model}

    def generation(self, gid, seconds=0, *, model="nano_banana_2", owner="user_me"):
        created = self.base + timedelta(seconds=seconds)
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,creator_uid,model,params) "
                "VALUES(?,'me','p','done',?,?,?,?,?)",
                (gid, created.isoformat(), created.timestamp(), owner, model, json.dumps({})),
            )
            conn.execute(
                "INSERT INTO generation_metrics(gen_id,est_credits,credit_source) VALUES(?,2,'estimate')", (gid,)
            )

    def raw_row(self, rid, email, *, seconds=0, amount=2.0, matched=None, model=None, workspace=None,
                owner="user_me", label="Nano Banana Pro"):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO credit_txn(id,owner_uid,account_email,display_name,credits,action,created_at,"
                "matched_gen_id,model,workspace_id) VALUES(?,?,?,?,?,'spend',?,?,?,?)",
                (rid, owner, email, label, -amount, self.at(seconds), matched, model, workspace),
            )

    def rows(self):
        with db.get_connection() as conn:
            return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM credit_txn")}

    def metrics(self):
        with db.get_connection() as conn:
            return {r["gen_id"]: (r["real_credits"], r["credit_source"]) for r in conn.execute(
                "SELECT gen_id, real_credits, credit_source FROM generation_metrics")}

    def run_merge(self):
        with db.get_connection() as conn:
            conn.execute("DELETE FROM manage_schema_state WHERE key=?", (manage_schema._CREDIT_TXN_ALIAS_MERGE_KEY,))
            manage_schema._merge_local_alias_transactions(conn)

    # ── 1-A 병합 ──
    def test_merge_keeps_real_row_and_fills_blanks_without_touching_metrics(self):
        self.generation("g1")
        self.raw_row("L", "local", matched="g1", model="nano_banana_2_shots")
        self.raw_row("R", REAL, workspace="ws1")
        before = self.metrics()
        self.run_merge()
        rows = self.rows()
        self.assertEqual(list(rows), ["R"])
        self.assertEqual((rows["R"]["matched_gen_id"], rows["R"]["model"], rows["R"]["workspace_id"]),
                         ("g1", "nano_banana_2_shots", "ws1"))
        self.assertEqual(self.metrics(), before)
        with db.get_connection() as conn:
            saved = conn.execute("SELECT * FROM credit_txn_alias_merged").fetchone()
        self.assertEqual((saved["l_id"], saved["r_id"], saved["r_before_workspace_id"], saved["r_after_matched_gen_id"]),
                         ("L", "R", "ws1", "g1"))

    def test_conflicting_or_ambiguous_pairs_are_left_alone(self):
        self.raw_row("L1", "local", seconds=0, matched="g1")
        self.raw_row("R1", REAL, seconds=0, matched="g2")  # 연결 충돌
        self.raw_row("L2", "local", seconds=10, model="a")
        self.raw_row("R2", REAL, seconds=10, model="b")  # 모델 충돌
        self.raw_row("L3", "local", seconds=20)
        self.raw_row("R3", REAL, seconds=20)
        self.raw_row("R3b", "second@example.test", seconds=20)  # 실제 짝 둘
        self.raw_row("L4", "local", seconds=30, owner="acct:artist@example.test")
        self.raw_row("R4", REAL, seconds=30, owner="acct:artist@example.test")  # 합성 owner
        self.run_merge()
        self.assertEqual(set(self.rows()), {"L1", "R1", "L2", "R2", "L3", "R3", "R3b", "L4", "R4"})

    def test_merge_runs_once(self):
        self.run_merge()
        self.raw_row("L", "local")
        self.raw_row("R", REAL)
        with db.get_connection() as conn:
            manage_schema._merge_local_alias_transactions(conn)  # 표식이 있으면 아무것도 안 함
        self.assertEqual(set(self.rows()), {"L", "R"})

    def test_restore_only_when_real_row_is_unchanged_since_merge(self):
        self.raw_row("La", "local", seconds=0, matched="g1")
        self.raw_row("Ra", REAL, seconds=0)
        self.raw_row("Lb", "local", seconds=10, model="m")
        self.raw_row("Rb", REAL, seconds=10)
        original = self.rows()
        self.run_merge()
        with db.get_connection() as conn:
            conn.execute("UPDATE credit_txn SET workspace_id='later' WHERE id='Rb'")  # 병합 뒤 보강
            conn.execute("BEGIN IMMEDIATE")
            result = manage_schema.restore_credit_txn_alias_merge(conn)
            conn.execute("COMMIT")
        self.assertEqual(result, {"restored": 1, "conflicts": 1})
        rows = self.rows()
        self.assertEqual(rows["La"], original["La"])
        self.assertEqual(rows["Ra"], original["Ra"])
        self.assertNotIn("Lb", rows)
        self.assertEqual(rows["Rb"]["workspace_id"], "later")

    def test_restore_skips_when_same_local_transaction_came_back_under_new_id(self):
        self.raw_row("L", "local", matched="g1")
        self.raw_row("R", REAL)
        self.run_merge()
        self.raw_row("L_again", "local")  # 병합 뒤 같은 local 거래가 다른 id 로 재적재
        with db.get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            result = manage_schema.restore_credit_txn_alias_merge(conn)
            conn.execute("COMMIT")
        self.assertEqual(result, {"restored": 0, "conflicts": 1})
        self.assertEqual(self.rows()["R"]["matched_gen_id"], "g1")  # 부분 변경 없음

    # ── 1-A 적재 승계 ──
    def test_ingest_succession_in_every_order_keeps_one_row_and_acks(self):
        t = self.txn(0)
        for order in (["local", REAL, "local"], [REAL, "local"]):
            with self.subTest(order=order):
                with db.get_connection() as conn:
                    conn.execute("DELETE FROM credit_txn")
                for email in order:
                    result = manage.record_transactions("user_me", email, [t])
                    self.assertEqual((result["stored"], result["rejected"]), (1, 0))
                rows = self.rows()
                self.assertEqual(len(rows), 1)
                self.assertEqual(next(iter(rows.values()))["account_email"], REAL)

    def test_queue_uses_the_same_identity_resolution(self):
        t = self.txn(0)
        manage.record_transactions("user_me", "local", [t])
        manage.record_transactions("user_me", REAL, [t])
        self.assertTrue(manage.queue_account_reports(None, [t], "local", "user_me")["transactions_queued"])
        self.assertTrue(manage.queue_account_reports(None, [t], REAL, "user_me")["transactions_queued"])
        # owner 를 모르면 별칭으로 찾지 않는다 — 남의 거래와 섞일 수 있어서(ACK 실패 → 다음 주기 재시도)
        self.assertFalse(manage.queue_account_reports(None, [t], "local", None)["transactions_queued"])

    def test_alias_never_resolves_to_another_owner(self):
        t = self.txn(0)
        manage.record_transactions("user_me", "local", [t])
        manage.record_transactions("user_me", REAL, [t])
        # 남의 owner 가 같은 필드(마이크로초까지 같은 — 이론상)로 local 입력을 보내도 내 행을 '같은 거래' 로 잡지 않는다.
        # 거래 id 가 이메일만으로 만들어지는 옛 산식이라 새 행도 못 넣는다 — 성공으로 속이지 않고 stored=0(ACK 실패).
        result = manage.record_transactions("user_other", "local", [dict(t, workspace_id="ws_b")])
        self.assertEqual(result["stored"], 0)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        mine = next(iter(rows.values()))
        self.assertEqual((mine["owner_uid"], mine["account_email"], mine["workspace_id"]), ("user_me", REAL, None))

    # ── 묶음 격리 ──
    def test_unmerged_alias_group_is_kept_out_of_matching(self):
        self.generation("g1", 0)
        self.generation("g2", 1)
        self.raw_row("L", "local", matched="g1", model="nano_banana_2_shots")
        self.raw_row("R", REAL, model="nano_banana_pro")  # 모델 충돌로 병합 안 됨
        self.run_merge()
        manage.record_transactions("user_me", REAL, [])  # 빈 사이클도 미연결을 재평가한다
        self.assertIsNone(self.rows()["R"]["matched_gen_id"])
        self.assertIsNone(self.metrics()["g2"][0])

    # ── 1-B shots 오태깅 ──
    def test_legacy_shots_tag_matches_nano_banana_pro_family_only(self):
        self.generation("pro2", 0, model="nano_banana_2")
        self.generation("flash", 100, model="nano_banana_flash")
        manage.record_transactions("user_me", REAL, [
            self.txn(0.1, model="nano_banana_2_shots"),
            self.txn(100.1, model="nano_banana_2_shots"),
        ])
        metrics = self.metrics()
        self.assertEqual(metrics["pro2"], (2.0, "transaction"))
        self.assertIsNone(metrics["flash"][0])

    def test_untagged_pro_transaction_keeps_previous_pending_behavior(self):
        # Codex 반례: 태그 없는 Pro 거래 + 모델 미상 생성물 + relight 생성물 → 전처럼 보류(확정 안 함)
        self.generation("unknown", 0, model=None)
        self.generation("relight", 1, model="nano_banana_2_relight")
        manage.record_transactions("user_me", REAL, [self.txn(0.5)])
        metrics = self.metrics()
        self.assertIsNone(metrics["unknown"][0])
        self.assertIsNone(metrics["relight"][0])
        self.assertTrue(metrics["unknown"][1].startswith("transaction_pending"))


if __name__ == "__main__":
    unittest.main()
