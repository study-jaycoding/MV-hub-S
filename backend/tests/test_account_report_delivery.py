"""RL-13 계정 상태·크레딧 거래 보고의 내구성 큐·재시도 계약."""

import os
import tempfile
import unittest
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.repo import manage
from app.services.account_report_delivery import drain_remote_account_reports


class AccountReportDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
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

    @staticmethod
    def _status(credits=100):
        return {"email": "artist@example.com", "credits": credits, "plan": "team"}

    @staticmethod
    def _transaction():
        return {
            "created_at": "2026-08-16T01:00:00Z",
            "credits": -4,
            "action": "spend",
            "display_name": "Model A",
            "model": "model-a",
        }

    def _allow_retry_now(self):
        with db.get_connection() as conn:
            conn.execute("UPDATE account_report_outbox SET next_retry_at=NULL")

    def test_queue_is_durable_and_identical_reports_do_not_reset_backoff(self):
        first = manage.queue_account_reports(self._status(), [self._transaction()])
        self.assertEqual(first, {"status": 1, "transactions": 1})
        rows = manage.list_due_account_reports()
        self.assertEqual(len(rows), 2)

        manage.mark_account_reports_failed(rows, "offline")
        repeated = manage.queue_account_reports(self._status(), [self._transaction()])
        self.assertEqual(repeated, {"status": 0, "transactions": 0})
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 2)
        self.assertEqual(status["account_report_failed"], 2)
        self.assertEqual(status["account_report_last_error"], "offline")
        self.assertEqual(manage.list_due_account_reports(), [])

    def test_stale_ack_does_not_clear_newer_status_or_record_success(self):
        manage.queue_account_reports(self._status(credits=100), [])
        stale = manage.list_due_account_reports()
        manage.queue_account_reports(self._status(credits=90), [])

        self.assertEqual(manage.mark_account_reports_pushed(stale), 0)
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 1)
        self.assertIsNone(status["account_report_last_success_at"])

    def test_transaction_model_enrichment_updates_one_queue_revision(self):
        transaction = self._transaction()
        transaction.pop("model")
        manage.queue_account_reports(self._status(), [transaction])
        before = [
            row
            for row in manage.list_due_account_reports()
            if row["report_type"] == "transaction"
        ][0]

        enriched = {**transaction, "model": "model-a"}
        queued = manage.queue_account_reports(self._status(), [enriched])
        after = [
            row
            for row in manage.list_due_account_reports()
            if row["report_type"] == "transaction"
        ]

        self.assertEqual(queued["transactions"], 1)
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["report_key"], before["report_key"])
        self.assertEqual(after[0]["dirty_rev"], before["dirty_rev"] + 1)

    def test_network_failure_stays_queued_and_recovery_acknowledges_all(self):
        manage.queue_account_reports(self._status(), [self._transaction()])

        failed = drain_remote_account_reports(
            mock.Mock(side_effect=OSError("server offline")),
            creator_uid="user_artist",
        )
        self.assertEqual(failed["pushed"], 0)
        self.assertEqual(failed["failed"], 2)
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 2)
        self.assertEqual(status["account_report_failed"], 2)

        self._allow_retry_now()
        sent_payloads = []

        def push(payload):
            sent_payloads.append(payload)
            return {"accepted": True}

        recovered = drain_remote_account_reports(push, creator_uid="user_artist")
        self.assertEqual(recovered["pushed"], 2)
        self.assertEqual(manage.account_report_outbox_status()["account_report_pending"], 0)
        self.assertRegex(
            manage.account_report_outbox_status()["account_report_last_success_at"],
            r"^\d{4}-\d{2}-\d{2}T.*Z$",
        )
        self.assertEqual(sent_payloads[0]["creator_uid"], "user_artist")
        self.assertEqual(
            sum(len(payload["account_transactions"]) for payload in sent_payloads),
            1,
        )

    def test_invalid_local_row_is_dead_lettered_while_valid_rows_continue(self):
        good = self._transaction()
        bad = {**self._transaction(), "created_at": "2026-08-16T02:00:00Z"}
        manage.queue_account_reports(self._status(), [good, bad])
        rows = manage.list_due_account_reports()
        bad_row = [row for row in rows if row["report_type"] == "transaction"][0]
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE account_report_outbox SET payload_json='{' WHERE report_key=?",
                (bad_row["report_key"],),
            )
        sent = []

        result = drain_remote_account_reports(
            lambda payload: sent.append(payload) or {"accepted": True},
            creator_uid="user_artist",
        )

        self.assertEqual(result, {"target": "remote", "pushed": 2, "failed": 1})
        self.assertEqual(
            sum(len(payload["account_transactions"]) for payload in sent),
            1,
        )
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 0)
        self.assertEqual(status["account_report_failed"], 0)
        self.assertEqual(status["account_report_dead"], 1)
        self.assertEqual(manage.list_due_account_reports(), [])
        with db.get_connection() as conn:
            poison = conn.execute(
                "SELECT pushed_at,dead_lettered_at FROM account_report_outbox "
                "WHERE report_key=?",
                (bad_row["report_key"],),
            ).fetchone()
        self.assertIsNone(poison["pushed_at"])
        self.assertIsNotNone(poison["dead_lettered_at"])

    def test_one_server_rejection_does_not_hold_valid_rows_hostage(self):
        good = self._transaction()
        bad = {
            **self._transaction(),
            "created_at": "2026-08-16T02:00:00Z",
            "display_name": "Rejected Model",
        }
        manage.queue_account_reports(self._status(), [good, bad])

        def push(payload):
            transactions = payload["account_transactions"]
            if transactions and transactions[0]["display_name"] == "Rejected Model":
                raise RuntimeError("row rejected")
            return {"accepted": True}

        result = drain_remote_account_reports(push, creator_uid="user_artist")

        self.assertEqual(result["pushed"], 2)
        self.assertEqual(result["failed"], 1)
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 1)
        self.assertEqual(status["account_report_failed"], 1)
        self.assertEqual(status["account_report_dead"], 0)

    def test_http_409_remains_retryable_and_is_not_dead_lettered(self):
        manage.queue_account_reports(self._status(), [])

        result = drain_remote_account_reports(
            mock.Mock(
                side_effect=HTTPException(
                    status_code=409, detail="account identity mismatch"
                )
            ),
            creator_uid="user_artist",
        )

        self.assertEqual(result["pushed"], 0)
        self.assertEqual(result["failed"], 1)
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 1)
        self.assertEqual(status["account_report_failed"], 1)
        self.assertEqual(status["account_report_dead"], 0)

    def test_missing_status_email_never_sends_transactions_under_guessed_identity(self):
        manage.queue_account_reports(None, [self._transaction()])
        push = mock.Mock(return_value={"accepted": True})

        result = drain_remote_account_reports(push, creator_uid="user_artist")

        self.assertEqual(result["pushed"], 0)
        self.assertEqual(result["failed"], 1)
        push.assert_not_called()
        status = manage.account_report_outbox_status()
        self.assertEqual(status["account_report_pending"], 1)
        self.assertEqual(status["account_report_failed"], 1)

    def test_missing_explicit_ack_is_a_failure(self):
        manage.queue_account_reports(self._status(), [])
        result = drain_remote_account_reports(
            lambda _payload: {"transactions_inserted": 0},
            creator_uid="user_artist",
        )
        self.assertEqual(result["pushed"], 0)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(
            manage.account_report_outbox_status()["account_report_pending"], 1
        )


if __name__ == "__main__":
    unittest.main()
