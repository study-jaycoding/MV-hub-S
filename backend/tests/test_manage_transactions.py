"""크레딧 거래 매칭 모듈의 멱등성과 오염 방지 계약."""

import os
import tempfile
import unittest
from datetime import datetime, timezone

from app import db, repo
from app.repo import manage


class ManageTransactionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.created_at = "2026-08-01T10:00:00Z"
        sort_ts = datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc).timestamp()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO creator(uid, name) VALUES('u_me','Artist') "
                "ON CONFLICT(uid) DO NOTHING"
            )
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, "
                "creator_uid, model) VALUES"
                "('g1','me','prompt','done',?,?, 'u_me','model-a')",
                (self.created_at, sort_ts),
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _transaction(self, **overrides):
        transaction = {
            "created_at": self.created_at,
            "credits": -7.2,
            "action": "spend",
            "display_name": "Model A",
            "model": "model-a",
        }
        transaction.update(overrides)
        return transaction

    def test_matching_records_real_credit_and_is_idempotent(self):
        first = manage.record_transactions("u_me", "me@example.com", [self._transaction()])
        self.assertEqual(first, {"inserted": 1, "matched": 1, "matched_ids": ["g1"]})
        with db.get_connection() as conn:
            metrics = conn.execute(
                "SELECT real_credits, credit_source, matched "
                "FROM generation_metrics WHERE gen_id='g1'"
            ).fetchone()
            linked = conn.execute(
                "SELECT matched_gen_id FROM credit_txn"
            ).fetchone()["matched_gen_id"]
        self.assertEqual(dict(metrics), {"real_credits": 7, "credit_source": "transaction", "matched": 1})
        self.assertEqual(linked, "g1")

        second = manage.record_transactions("u_me", "me@example.com", [self._transaction()])
        self.assertEqual(second, {"inserted": 0, "matched": 0, "matched_ids": []})

    def test_known_model_mismatch_stays_unmatched(self):
        result = manage.record_transactions(
            "u_me",
            "me@example.com",
            [self._transaction(display_name="Model B", model="model-b")],
        )
        self.assertEqual(result["matched"], 0)
        with db.get_connection() as conn:
            row = conn.execute("SELECT matched_gen_id FROM credit_txn").fetchone()
        self.assertIsNone(row["matched_gen_id"])

    def test_repeated_transaction_can_fill_missing_model_without_duplicate(self):
        transaction = self._transaction()
        transaction.pop("model")
        first = manage.record_transactions("u_me", "me@example.com", [transaction])
        second = manage.record_transactions(
            "u_me", "me@example.com", [{**transaction, "model": "model-a"}]
        )

        with db.get_connection() as conn:
            rows = conn.execute("SELECT model FROM credit_txn").fetchall()
        self.assertEqual(first["inserted"], 1)
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["model"], "model-a")


if __name__ == "__main__":
    unittest.main()
