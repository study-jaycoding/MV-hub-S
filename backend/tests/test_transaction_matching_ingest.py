"""빈 계정 사이클도 실제 ingest → record_transactions → DB 매칭을 실행한다.

요청 신원은 미들웨어가 제공하는 모양으로 넣고 DB만 임시로 격리한다.
매칭/적재/스케줄러를 가짜로 바꾸지 않으며 HF CLI나 네트워크를 실행하지 않는다.
"""

import os
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from app import active_account, db, repo
from app.models import IngestIn
from app.repo import manage
from app.routers import ingest


class TransactionMatchingIngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.previous_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content.db")
        self.account_token = active_account.set_override("")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        self.uid = "user_matching"
        self.email = "matching@example.com"
        self.when = datetime(2026, 8, 1, 10, tzinfo=timezone.utc)
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid,name) VALUES(?, 'Matching')", (self.uid,))
        self.request = SimpleNamespace(state=SimpleNamespace(account={
            "email": self.email, "creator_uid": self.uid,
        }))
        self.transaction = {
            "created_at": self.when.isoformat(), "credits": -32.5,
            "action": "spend", "display_name": "Model A", "model": "model-a",
        }

    def tearDown(self):
        db.flush_pool()
        active_account.reset_override(self.account_token)
        if self.previous_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.previous_db
        self.tmp.cleanup()

    def _body(self, **overrides):
        fields = {
            "jobs": [{
                "id": "ingest-new", "created_at": self.when.timestamp(),
                "status": "completed", "job_type": "model-a",
                "params": {"prompt": "matching regression"},
            }],
            "account_status": {"email": self.email},
            "account_transactions": [],
        }
        fields.update(overrides)
        return IngestIn(**fields)

    def _assert_matched(self):
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT m.real_credits, m.credit_source, m.matched FROM generation_metrics m "
                "JOIN generation g ON g.id=m.gen_id WHERE g.job_id='ingest-new'"
            ).fetchone()
        self.assertIsNotNone(row, "empty ingest must evaluate stored transactions")
        self.assertEqual(tuple(row), (32.5, "transaction", 1))

    def test_the_response_says_whether_the_ledger_actually_took_the_transactions(self):
        """★에이전트는 이 값이 True 일 때만 수집 기준을 옮긴다(코덱스 P1).

        200 만 보고 옮기면, 서버가 삼킨 적재 실패 구간이 영영 다시 안 읽힌다 —
        기준 시각은 앞서 있고 그 구간의 거래는 아무도 다시 보내지 않는다."""
        result = ingest.ingest(self._body(account_transactions=[self.transaction]), self.request)
        self.assertIs(result.transactions_recorded, True)

    def test_a_proxy_that_cannot_queue_the_report_does_not_claim_success(self):
        """★로컬 허브에서는 **대기열에 들어가야** 공유 서버까지 간다(코덱스 P1).

        로컬 장부에 넣은 것만으로 성공이라 답하면 에이전트가 수집 기준을 옮기고,
        전송기는 대기열만 읽으므로 그 구간을 아무도 다시 보내지 않는다."""
        with patch.object(ingest._proxy, "proxying", return_value=True), patch.object(
            manage, "queue_account_reports", side_effect=RuntimeError("queue down")
        ):
            result = ingest.ingest(
                self._body(account_transactions=[self.transaction]), self.request
            )
        self.assertIs(result.transactions_recorded, False)

    def test_a_proxy_that_queues_the_report_reports_success(self):
        with patch.object(ingest._proxy, "proxying", return_value=True):
            result = ingest.ingest(
                self._body(account_transactions=[self.transaction]), self.request
            )
        self.assertIs(result.transactions_recorded, True)

    def test_a_cycle_without_an_identified_owner_reports_no_ledger_write(self):
        """소유자를 못 정하면 거래를 적재하지 않는다 — 성공으로 보고해서는 안 된다."""
        anonymous = SimpleNamespace(state=SimpleNamespace(account={"email": "nobody@example.com"}))
        result = ingest.ingest(self._body(account_status={"email": "nobody@example.com"}), anonymous)
        self.assertIs(result.transactions_recorded, False)

    def test_empty_transactions_match_after_generation_ingest(self):
        self.assertEqual(manage.record_transactions(
            self.uid, self.email, [self.transaction],
        )["matched"], 0)
        result = ingest.ingest(self._body(), self.request)
        self.assertEqual(result.inserted, 1)
        self._assert_matched()

    def test_omitted_transactions_also_reevaluate(self):
        manage.record_transactions(self.uid, self.email, [self.transaction])
        ingest.ingest(self._body(account_transactions=None), self.request)
        self._assert_matched()

    def test_model_only_ingest_rechecks_stored_transactions(self):
        body = self._body()
        body.jobs[0]["job_type"] = None
        body.jobs.append({**body.jobs[0], "id": "ingest-other", "job_type": "model-b"})
        ingest.ingest(body, self.request)
        self.assertEqual(manage.record_transactions(
            self.uid, self.email, [
                {**self.transaction, "model": None},
                {**self.transaction, "credits": -52, "model": "model-b", "display_name": "Model B"},
            ],
        )["matched"], 0)
        result = ingest.ingest(self._body(), self.request)
        self.assertEqual(result.inserted, 0)
        self.assertEqual(result.updated, 1)
        self._assert_matched()

    def test_unknown_owner_empty_cycle_does_not_match_other_users(self):
        manage.record_transactions(self.uid, self.email, [self.transaction])
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id,worker_id,prompt,status,creator_uid,sort_ts,model) "
                "VALUES('ingest-new','me','p','done',?,?,'model-a')",
                (self.uid, self.when.timestamp()),
            )
        request = SimpleNamespace(state=SimpleNamespace(account={"email": self.email}))
        ingest.ingest(self._body(jobs=[]), request)
        with db.get_connection() as conn:
            self.assertIsNone(conn.execute("SELECT matched_gen_id FROM credit_txn").fetchone()[0])
        self.assertEqual(manage.record_transactions(self.uid, self.email, [])["matched"], 1)
