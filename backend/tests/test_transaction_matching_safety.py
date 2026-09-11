"""실제 거래 적재 진입점에서 최대 매칭의 금액 불변성과 원자성을 검증한다."""

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from app import db, repo
from app.repo import manage


class TransactionMatchingSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "matching.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.base = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute("INSERT INTO creator(uid,name) VALUES('u_me','Artist')")
            conn.execute("INSERT INTO creator(uid,name) VALUES('u_other','Other')")

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def generation(self, gid, seconds=0, *, model="model-a", owner="u_me",
                   estimate=9.5, project=None, option=None, generator=None):
        created = self.base + timedelta(seconds=seconds)
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,created_at,sort_ts,"
                "creator_uid,model,params,generator) VALUES(?,'me','prompt','done',?,?,?,?,?,?)",
                (gid, created.isoformat(), created.timestamp(), owner, model,
                 json.dumps({"option": option}), generator),
            )
            conn.execute(
                "INSERT INTO generation_metrics(gen_id,est_credits,credit_source) VALUES(?,?,?)",
                (gid, estimate, "estimate" if estimate is not None else "unknown"),
            )
            if project:
                conn.execute("INSERT OR IGNORE INTO project(id,name) VALUES(?,?)", (project, project))
                conn.execute(
                    "INSERT OR IGNORE INTO project_task(id,project_id,name) VALUES(?,?,?)",
                    ("task-" + project, project, project),
                )
                conn.execute("INSERT INTO task_generation(task_id,gen_id) VALUES(?,?)",
                             ("task-" + project, gid))

    def transaction(self, seconds=0, amount=32.5, *, model="model-a", label="Model A"):
        return {
            "created_at": (self.base + timedelta(seconds=seconds)).isoformat(),
            "credits": -amount, "action": "spend", "display_name": label, "model": model,
        }

    def record(self, transactions, owner="u_me"):
        return manage.record_transactions(owner, "matching@example.test", transactions)

    def metrics(self):
        with db.get_connection() as conn:
            return {row["gen_id"]: dict(row) for row in conn.execute(
                "SELECT gen_id,real_credits,est_credits,credit_source,matched FROM generation_metrics"
            )}

    def revisions(self):
        with db.get_connection() as conn:
            return dict(conn.execute("SELECT local_gen_id,dirty_rev FROM telemetry_outbox"))

    def assert_pending(self, gids, reason):
        rows = self.metrics()
        for gid in gids:
            with self.subTest(gid=gid):
                self.assertIsNone(rows[gid]["real_credits"])
                self.assertEqual(rows[gid]["matched"], 0)
                self.assertEqual(rows[gid]["credit_source"], "transaction_pending_" + reason)
        with db.get_connection() as conn:
            for gid in gids:
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM credit_txn WHERE matched_gen_id=?", (gid,)
                ).fetchone()[0], 0)

    def assert_confirmed(self, amounts):
        rows = self.metrics()
        for gid, amount in amounts.items():
            with self.subTest(gid=gid):
                self.assertEqual(rows[gid]["real_credits"], amount)
                self.assertEqual(rows[gid]["matched"], 1)
                self.assertEqual(rows[gid]["credit_source"], "transaction")
        with db.get_connection() as conn:
            for gid in amounts:
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM credit_txn WHERE matched_gen_id=?", (gid,)
                ).fetchone()[0], 1)

    def test_fractional_one_to_one_is_idempotent(self):
        self.generation("g1")
        transaction = self.transaction(amount=32.5)
        result = self.record([transaction])
        self.assertEqual(result, {"inserted": 1, "matched": 1, "matched_ids": ["g1"]})
        self.assert_confirmed({"g1": 32.5})
        revision = self.revisions()
        self.assertEqual(self.record([transaction]), {"inserted": 0, "matched": 0, "matched_ids": []})
        self.assertEqual(self.revisions(), revision)

    def test_crossed_times_across_projects_are_ambiguous(self):
        self.generation("g1", 0, project="A", estimate=52)
        self.generation("g2", 1, project="B", estimate=32.5)
        result = self.record([self.transaction(.9, 52), self.transaction(1.9, 32.5)])
        self.assertEqual(result["matched"], 0)
        self.assertEqual(result["matched_ids"], [])
        self.assert_pending(["g1", "g2"], "ambiguous")
        self.assertEqual([self.metrics()[gid]["est_credits"] for gid in ["g1", "g2"]], [52, 32.5])

    def test_project_option_counts_do_not_prove_amounts(self):
        for index in range(5):
            self.generation(f"g{index}", index, project="A" if index < 2 else "B",
                            option="X" if index < 2 else "Y", estimate=32.5 if index < 2 else 52)
        result = self.record([self.transaction(index + .1, 32.5 if index < 2 else 52)
                              for index in range(5)])
        self.assertEqual(result["matched"], 0)
        self.assert_pending([f"g{index}" for index in range(5)], "ambiguous")

    def test_identical_amount_with_too_few_transactions_is_incomplete(self):
        self.generation("g1")
        self.generation("g2", 1)
        self.assertEqual(self.record([self.transaction()])["matched"], 0)
        self.assert_pending(["g1", "g2"], "incomplete")

    def test_identical_amount_with_exact_transaction_count_confirms(self):
        self.generation("g1")
        self.generation("g2", 1)
        self.assertEqual(self.record([self.transaction(), self.transaction(1)])["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 32.5})

    def test_identical_amount_with_surplus_transactions_confirms(self):
        self.generation("g1")
        self.generation("g2", 1)
        self.assertEqual(self.record([self.transaction(i) for i in range(3)])["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 32.5})
        with db.get_connection() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM credit_txn WHERE matched_gen_id IS NULL").fetchone()[0], 1)

    def test_augmenting_path_recovers_greedy_omission(self):
        self.generation("g1", 0)
        self.generation("g2", 61)
        self.assertEqual(self.record([self.transaction(1), self.transaction(-2)])["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 32.5})

    def test_mixed_amounts_with_unique_full_assignment_confirm(self):
        self.generation("g1", 0)
        self.generation("g2", 61)
        result = self.record([self.transaction(1, 52), self.transaction(-2, 32.5)])
        self.assertEqual(result["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 52})

    def test_mixed_component_with_multiple_matchings_but_fixed_amounts_confirms(self):
        self.generation("g1", 0)
        self.generation("g2", 0)
        self.generation("g3", 61)
        result = self.record([self.transaction(-2, 32.5), self.transaction(-1, 32.5),
                              self.transaction(1, 52)])
        self.assertEqual(result["matched"], 3)
        self.assert_confirmed({"g1": 32.5, "g2": 32.5, "g3": 52})

    def test_alternative_amount_reachable_through_long_augmenting_path_is_ambiguous(self):
        for index, seconds in enumerate([0, 61, 122]):
            self.generation(f"g{index}", seconds)
        result = self.record([self.transaction(-2, 2), self.transaction(1, 5),
                              self.transaction(62, 2), self.transaction(123, 5)])
        self.assertEqual(result["matched"], 0)
        self.assert_pending(["g0", "g1", "g2"], "ambiguous")

    def test_components_isolate_ambiguous_from_confirmed(self):
        self.generation("good", 300)
        self.generation("g1", 0)
        self.generation("g2", 1)
        result = self.record([self.transaction(.9, 52), self.transaction(1.9, 32.5),
                              self.transaction(300, 7.2)])
        self.assertEqual(result["matched_ids"], ["good"])
        self.assert_confirmed({"good": 7.2})
        self.assert_pending(["g1", "g2"], "ambiguous")

    def test_empty_cycle_matches_stored_transaction_after_generation_arrives(self):
        self.assertEqual(self.record([self.transaction()])["matched"], 0)
        self.generation("g1")
        result = self.record([])
        self.assertEqual(result, {"inserted": 0, "matched": 1, "matched_ids": ["g1"]})
        self.assert_confirmed({"g1": 32.5})

    def test_duplicate_only_cycle_also_reevaluates(self):
        transaction = self.transaction()
        self.record([transaction])
        self.generation("g1")
        self.assertEqual(self.record([transaction]), {"inserted": 0, "matched": 1, "matched_ids": ["g1"]})

    def test_unknown_owner_empty_cycle_never_expands_to_other_users(self):
        self.record([self.transaction()])
        self.generation("mine")
        self.generation("other", owner="u_other")
        result = self.record([], owner=None)
        self.assertEqual(result["matched"], 0)
        self.assertTrue(all(row["real_credits"] is None for row in self.metrics().values()))
        self.assertEqual(self.revisions(), {})

    def test_candidate_addition_resolves_incomplete_and_marks_dirty_once(self):
        self.generation("g1", 0)
        self.generation("g2", 61)
        self.record([self.transaction(1, 52)])
        self.assert_pending(["g1", "g2"], "incomplete")
        self.assertEqual(self.revisions(), {"g1": 1, "g2": 1})
        self.record([])
        self.assertEqual(self.revisions(), {"g1": 1, "g2": 1})
        result = self.record([self.transaction(-2, 32.5)])
        self.assertEqual(result["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 52})
        self.assertEqual(self.revisions(), {"g1": 2, "g2": 2})

    def test_model_enrichment_resolves_unknown_model_bridge(self):
        self.generation("g1", model="model-a")
        self.generation("g2", model="model-b")
        first = self.transaction(0, 32.5, model=None)
        second = self.transaction(1, 52, model=None)
        self.record([first, second])
        self.assert_pending(["g1", "g2"], "ambiguous")
        result = self.record([{**first, "model": "model-a"}, {**second, "model": "model-b"}])
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(result["matched"], 2)
        self.assert_confirmed({"g1": 32.5, "g2": 52})
        self.assertEqual(self.revisions(), {"g1": 2, "g2": 2})

    def test_pending_without_candidates_clears_to_explicit_fallback(self):
        self.generation("estimated", estimate=9.5)
        self.generation("unknown", estimate=None)
        self.record([self.transaction()])
        self.assert_pending(["estimated", "unknown"], "incomplete")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET model='model-b'")
        self.assertEqual(self.record([])["matched"], 0)
        rows = self.metrics()
        self.assertEqual(rows["estimated"]["credit_source"], "estimate")
        self.assertEqual(rows["estimated"]["est_credits"], 9.5)
        self.assertEqual(rows["unknown"]["credit_source"], "unknown")
        self.assertEqual(self.revisions(), {"estimated": 2, "unknown": 2})
        self.record([])
        self.assertEqual(self.revisions(), {"estimated": 2, "unknown": 2})

    def test_repeated_ambiguous_status_does_not_increment_dirty_revision(self):
        self.generation("g1")
        self.generation("g2")
        transactions = [self.transaction(0, 32.5), self.transaction(1, 52)]
        self.record(transactions)
        self.assertEqual(self.revisions(), {"g1": 1, "g2": 1})
        self.record(transactions)
        self.record([])
        self.assert_pending(["g1", "g2"], "ambiguous")
        self.assertEqual(self.revisions(), {"g1": 1, "g2": 1})

    def test_deleted_pending_generation_preserves_telemetry_tombstone(self):
        self.generation("g1")
        self.generation("g2", 1)
        self.record([self.transaction()])
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET deleted_at='2026-08-02' WHERE id='g2'")
            conn.execute("UPDATE telemetry_outbox SET is_tombstone=1 WHERE local_gen_id='g2'")
        self.assertEqual(self.record([])["matched_ids"], ["g1"])
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT is_tombstone,dirty_rev FROM telemetry_outbox WHERE local_gen_id='g2'"
            ).fetchone()
        self.assertEqual(tuple(row), (1, 1), "삭제 전송 상태를 일반 dirty로 덮지 않는다")

    def test_conditional_write_failure_rolls_back_entire_component(self):
        self.generation("g1")
        self.generation("g2", 1)
        with db.get_connection() as conn:
            conn.execute("CREATE TRIGGER reject_second_credit BEFORE UPDATE ON generation_metrics "
                         "WHEN NEW.gen_id='g2' AND NEW.real_credits IS NOT NULL "
                         "BEGIN SELECT RAISE(IGNORE); END")
        caught = None
        try:
            self.record([self.transaction(), self.transaction(1)])
        except RuntimeError as error:
            caught = error
        self.assertTrue(all(row["real_credits"] is None for row in self.metrics().values()),
                        "조건부 저장 실패 시 같은 요소의 앞선 확정도 롤백해야 한다")
        with db.get_connection() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM credit_txn WHERE matched_gen_id IS NOT NULL").fetchone()[0], 0)
        self.assertEqual(self.revisions(), {})
        self.assertIsNotNone(caught, "조건부 UPDATE 누락을 저장 성공으로 처리하면 안 된다")

    def test_dirty_failure_rolls_back_credit_confirmation(self):
        self.generation("g1")
        with db.get_connection() as conn:
            conn.execute("CREATE TRIGGER reject_dirty BEFORE INSERT ON telemetry_outbox "
                         "BEGIN SELECT RAISE(ABORT,'test dirty failure'); END")
        caught = None
        try:
            self.record([self.transaction()])
        except sqlite3.DatabaseError as error:
            caught = error
        self.assertIsNone(self.metrics()["g1"]["real_credits"],
                          "dirty 저장과 실제 금액 저장은 함께 롤백되어야 한다")
        with db.get_connection() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM credit_txn WHERE matched_gen_id IS NOT NULL").fetchone()[0], 0)
        self.assertIsNotNone(caught)

    def test_explicit_comfy_generation_does_not_consume_higgsfield_transaction(self):
        self.generation("comfy", generator="comfy")
        self.generation("hf", .5)
        result = self.record([self.transaction()])
        self.assertEqual(result["matched_ids"], ["hf"])
        self.assert_confirmed({"hf": 32.5})
        self.assertEqual(self.metrics()["comfy"]["credit_source"], "estimate")

    def test_known_owner_and_model_guards_preserve_unrelated_generations(self):
        self.generation("other-owner", owner="u_other")
        self.generation("other-model", model="model-b")
        self.assertEqual(self.record([self.transaction()])["matched"], 0)
        self.assertTrue(all(row["credit_source"] == "estimate" for row in self.metrics().values()))

    def test_nearby_unequal_decimal_amounts_remain_ambiguous(self):
        self.generation("g1")
        self.assertEqual(self.record([self.transaction(0, 1.5), self.transaction(1, 1.5000000001)])["matched"], 0)
        self.assert_pending(["g1"], "ambiguous")

    def test_zero_is_an_amount_but_unmatched_is_not_zero(self):
        self.generation("g1")
        self.generation("g2", 1)
        self.assertEqual(self.record([self.transaction(0, 0)])["matched"], 0)
        self.assert_pending(["g1", "g2"], "incomplete")
        self.assertEqual(self.record([self.transaction(1, 0)])["matched"], 2)
        self.assert_confirmed({"g1": 0, "g2": 0})

    def test_invalid_spend_types_never_become_valid_through_sqlite_coercion(self):
        invalid_amounts = [True, False, "32.5", "not-a-number", float("nan"),
                           float("inf"), float("-inf"), None]
        for index, amount in enumerate(invalid_amounts):
            with self.subTest(credits=repr(amount)):
                gid = f"g{index}"
                self.generation(gid, index * 300)
                transaction = self.transaction(index * 300)
                transaction["credits"] = amount
                result = self.record([transaction])
                self.assertEqual(result["inserted"], 0,
                                 "SQLite REAL 컬럼이 bool/숫자문자열을 정상 금액으로 바꾸기 전에 거부해야 한다")
                self.assertEqual(result["matched"], 0)
                self.assertEqual(result["matched_ids"], [])
                self.assertIsNone(self.metrics()[gid]["real_credits"])
        self.assertEqual(self.record([]), {"inserted": 0, "matched": 0, "matched_ids": []})
        self.assertTrue(all(row["real_credits"] is None for row in self.metrics().values()))
        self.assertTrue(all(row["credit_source"] == "estimate" for row in self.metrics().values()))
        self.assertEqual(self.revisions(), {})
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM credit_txn").fetchone()[0], 0)

    def test_dense_graph_at_vertex_and_edge_boundaries_confirms_all(self):
        # 256 + 256 = 512 vertices; 256 * 256 = 65536 edges.
        for index in range(256):
            self.generation(f"g{index}")
        result = self.record([self.transaction(index / 1000, 2) for index in range(256)])
        self.assertEqual(result["matched"], 256)
        self.assert_confirmed({f"g{index}": 2 for index in range(256)})

    def test_dense_graph_over_limits_holds_whole_component(self):
        for index in range(256):
            self.generation(f"g{index}")
        result = self.record([self.transaction(index / 1000, 2) for index in range(257)])
        self.assertEqual(result["matched"], 0)
        self.assert_pending([f"g{index}" for index in range(256)], "limit")

    def test_sparse_graph_at_512_vertices_confirms(self):
        self.generation("g1")
        result = self.record([self.transaction(index / 1000, 2) for index in range(511)])
        self.assertEqual(result["matched"], 1)
        self.assert_confirmed({"g1": 2})

    def test_sparse_graph_at_513_vertices_holds_without_truncation(self):
        self.generation("g1")
        self.assertEqual(self.record([self.transaction(index / 1000, 2) for index in range(512)])["matched"], 0)
        self.assert_pending(["g1"], "limit")
        self.assertEqual(self.revisions(), {"g1": 1})
        self.record([])
        self.assertEqual(self.revisions(), {"g1": 1})

    def test_measured_nano_banana_pro_distribution_confirms_140(self):
        for index in range(70):
            self.generation(f"g{index}", index / 10, model="nano-banana-pro")
        result = self.record([self.transaction(index / 10, 2, model="nano-banana-pro",
                                              label="Nano Banana Pro") for index in range(70)])
        self.assertEqual(result["matched"], 70)
        self.assert_confirmed({f"g{index}": 2 for index in range(70)})
        self.assertEqual(sum(row["real_credits"] for row in self.metrics().values()), 140)

    def test_measured_seedance_mixed_distribution_is_ambiguous(self):
        amounts = [52] * 11 + [78] + [32.5] * 5
        for index in range(len(amounts)):
            self.generation(f"g{index}", index / 10, model="seedance-2.5")
        result = self.record([self.transaction(index / 10, amount, model="seedance-2.5",
                                              label="Seedance 2.5") for index, amount in enumerate(amounts)])
        self.assertEqual(result["matched"], 0)
        self.assert_pending([f"g{index}" for index in range(17)], "ambiguous")

    def test_input_order_does_not_change_credit_results(self):
        # 같은 DB 스냅샷을 별도 임시 DB에 복제한다. 내부 매칭 함수는 대체하지 않는다.
        self.generation("good1", 300)
        self.generation("good2", 361)
        self.generation("bad1", 0)
        self.generation("bad2", 1)
        transactions = [self.transaction(301, 52), self.transaction(298, 32.5),
                        self.transaction(.9, 52), self.transaction(1.9, 32.5)]
        snapshot = os.path.join(self.tmp.name, "snapshot.db")
        with db.get_connection() as conn, sqlite3.connect(snapshot) as target:
            conn.backup(target)
        first = self.record(transactions)
        first_metrics = self.metrics()
        first_revisions = self.revisions()
        db.flush_pool()
        os.environ["CONTENT_HUB_DB"] = snapshot
        second = self.record(list(reversed(transactions)))
        self.assertEqual(set(first["matched_ids"]), set(second["matched_ids"]))
        self.assertEqual(first_metrics, self.metrics())
        self.assertEqual(first_revisions, self.revisions())


if __name__ == "__main__":
    unittest.main()
