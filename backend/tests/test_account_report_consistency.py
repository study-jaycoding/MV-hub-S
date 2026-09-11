"""실제 ingest·장부·큐로 ACK를 검증한다. 결함 주입은 임시 SQLite 경계에서만 한다."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import sqlite3
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import active_account, db, repo
from app.models import AccountReportIn, IngestIn
from app.repo import manage, manage_account_reports
from app.routers import ingest, _telemetry
from app.services.account_report_delivery import drain_remote_account_reports


EMAIL = "artist@example.test"
UID = "user_artist"
STATUS = {"email": EMAIL, "credits": 100}
TRANSACTION = {
    "created_at": "2026-09-01T00:00:00Z", "credits": -1.5,
    "action": "spend", "display_name": "Model A",
    "workspace_id": None, "model": None,
}


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DATA", str(tmp_path))
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "0")
    monkeypatch.setattr(ingest, "AUTH_ENABLED", False)
    monkeypatch.setattr(ingest._proxy, "AUTH_ENABLED", False)
    monkeypatch.setattr(ingest, "MANAGE_ENABLED", True)
    token = active_account.set_override("")
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    # 실제 proxying()이 임시 DB의 합성 토큰을 읽게 한다. 전송 루프는 실행하지 않는다.
    repo.set_setting(ingest._proxy._K_TOKEN, "synthetic-test-token")
    repo.set_setting("shared_server_url", "http://127.0.0.1:1")
    assert _telemetry._scheduler_loop is None or not _telemetry._scheduler_loop.is_running()
    assert ingest._proxy.proxying()
    manage.record_transactions(UID, EMAIL, [])
    yield
    db.flush_pool()
    active_account.reset_override(token)


pytestmark = pytest.mark.usefixtures("isolated_db")


def request(email=EMAIL, uid=UID):
    return SimpleNamespace(state=SimpleNamespace(account={"email": email, "creator_uid": uid}))


def ingest_transactions(transactions, status=STATUS, email=EMAIL):
    return ingest.ingest(
        IngestIn(jobs=[], account_status=status, account_transactions=transactions),
        request(email),
    )


def queued_transactions():
    with db.get_connection() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT * FROM account_report_outbox WHERE report_type='transaction'"
        )]


def queue_payload():
    rows = queued_transactions()
    assert len(rows) == 1
    return json.loads(rows[0]["payload_json"])


def suppress_ledger_insert():
    with db.get_connection() as conn:
        conn.execute("CREATE TRIGGER suppress_txn BEFORE INSERT ON credit_txn "
                     "BEGIN SELECT RAISE(IGNORE); END")


@pytest.mark.parametrize("before,incoming,expected", [
    (None, "A", "A"), ("A", None, "A"), ("A", "B", "A"),
])
def test_ingest_queue_uses_preserved_enrichment(before, incoming, expected):
    old = {**TRANSACTION, "workspace_id": before, "model": before}
    manage.record_transactions("old-owner", " ARTIST@EXAMPLE.TEST ", [old])
    assert ingest_transactions([old]).transactions_recorded is True
    value = {**TRANSACTION, "workspace_id": incoming, "model": incoming}
    assert ingest_transactions([value]).transactions_recorded is True
    payload = queue_payload()
    assert payload["workspace_id"] == expected, "queue must use ledger workspace"
    assert payload["model"] == expected, "queue must use ledger model"
    assert value["workspace_id"] == incoming, "input must not be mutated"
    with db.get_connection() as conn:
        rows = conn.execute("SELECT workspace_id, model FROM credit_txn").fetchall()
    assert [tuple(row) for row in rows] == [(expected, expected)]


def test_queue_copies_null_even_when_payload_has_enrichment():
    manage.record_transactions(UID, EMAIL, [TRANSACTION])
    value = {**TRANSACTION, "workspace_id": "B", "model": "model-b"}
    result = manage.queue_account_reports(None, [value], EMAIL)
    assert result["transactions_queued"] is True
    payload = queue_payload()
    assert payload["workspace_id"] is None, "DB NULL must replace payload workspace"
    assert payload["model"] is None, "DB NULL must replace payload model"
    assert value["workspace_id"] == "B"


@pytest.mark.parametrize("field", ["created_at", "credits", "action", "display_name"])
def test_queue_identity_uses_null_safe_comparison(field):
    # action 은 금액 검증을 받지 않는 값으로 둔다 — 2026-09-12 부터 **refund 도** 금액을 읽을 수
    # 있어야 적재된다(환불이 원장 합계에 직접 들어가므로). 여기서 보는 것은 신원 조회의 NULL 안전
    # 비교이지 금액 검증이 아니다.
    value = {**TRANSACTION, "action": "grant", field: None}
    manage.record_transactions(UID, EMAIL, [value])
    result = manage.queue_account_reports(None, [value], " ARTIST@EXAMPLE.TEST ")
    assert result["transactions_queued"] is True
    assert queue_payload()[field] is None


@pytest.mark.parametrize("field,value", [
    ("created_at", "2026-09-02T00:00:00Z"), ("credits", -2),
    ("action", "refund"), ("display_name", "other"),
])
def test_each_identity_field_prevents_false_db_match(field, value):
    manage.record_transactions(UID, EMAIL, [TRANSACTION])
    result = manage.queue_account_reports(None, [{**TRANSACTION, field: value}], EMAIL)
    assert result["transactions_queued"] is False
    assert queued_transactions() == []


def test_queue_missing_valid_transaction_is_not_acknowledged_or_queued():
    result = manage.queue_account_reports(STATUS, [TRANSACTION], EMAIL)
    assert result["transactions_queued"] is False, "missing valid row must fail ACK"
    assert queued_transactions() == [], "missing valid row must never be queued"
    assert result["missing_transactions"] == 1
    assert result["status"] == 1


def test_queue_never_falls_back_to_status_email_or_another_owner():
    manage.record_transactions(UID, "other@example.test", [TRANSACTION])
    result = manage.queue_account_reports(
        {"email": "other@example.test"}, [TRANSACTION], EMAIL,
    )
    assert result["transactions_queued"] is False
    assert queued_transactions() == []


def test_ingest_missing_valid_transaction_fails_ack():
    suppress_ledger_insert()
    result = ingest_transactions([TRANSACTION])
    assert result.transactions_recorded is False, "unexplained ledger omission must fail ACK"
    assert queued_transactions() == []


def test_ingest_ledger_success_but_queue_lookup_missing_fails_ack(monkeypatch):
    # 적재 함수는 실제로 성공한 뒤 큐 연결에서만 행을 못 읽는 DB 경계를 주입한다.
    original = db.get_connection

    class MissingCursor:
        def fetchone(self):
            return None

    class Connection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if sql.startswith("SELECT id, workspace_id, model FROM credit_txn"):
                assert self.conn.in_transaction
                return MissingCursor()
            return self.conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.conn, name)

    @contextmanager
    def missing_connection():
        with original() as conn:
            yield Connection(conn)

    monkeypatch.setattr(manage_account_reports, "get_connection", missing_connection)
    result = ingest_transactions([TRANSACTION])
    assert result.transactions_recorded is False, "queue lookup omission must fail ingest ACK"
    assert queued_transactions() == []


@pytest.mark.parametrize("amount", [None, True, "-1.5", float("nan"), float("inf"), {}, []])
def test_invalid_spend_is_explicitly_rejected_and_acknowledged(amount):
    invalid = {**TRANSACTION, "credits": amount, "prompt": "private-marker"}
    recorded = manage.record_transactions(UID, EMAIL, [invalid])
    assert recorded["rejected"] == 1
    assert recorded["stored"] == 0
    assert recorded["rejection_reasons"] == {"invalid_amount": 1}
    assert "private-marker" not in repr(recorded)
    result = ingest_transactions([invalid])
    assert result.transactions_recorded is True, "explicit rejection must complete ACK"
    assert queued_transactions() == []


def test_mixed_valid_rejected_and_repeated_transactions_complete():
    values = [TRANSACTION, {**TRANSACTION, "credits": False}, TRANSACTION, None]
    recorded = manage.record_transactions(UID, EMAIL, values)
    assert (recorded["inserted"], recorded["stored"], recorded["rejected"]) == (1, 2, 2)
    assert ingest_transactions(values).transactions_recorded is True
    assert len(queued_transactions()) == 1


def test_idempotent_zero_changes_are_success_without_resetting_failure():
    assert ingest_transactions([TRANSACTION]).transactions_recorded is True
    rows = manage.list_due_account_reports()
    manage.mark_account_reports_failed(rows, "offline")
    before = queued_transactions()
    repeated = manage.queue_account_reports(STATUS, [TRANSACTION], EMAIL)
    assert repeated["transactions"] == 0
    assert repeated["transactions_queued"] is True, "idempotent zero changes must succeed"
    assert ingest_transactions([TRANSACTION]).transactions_recorded is True, "zero changes must ACK"
    assert queued_transactions() == before


def test_status_only_then_transaction_only_reports():
    assert ingest_transactions([]).transactions_recorded is True
    assert queued_transactions() == []
    assert ingest_transactions([TRANSACTION], status=None).transactions_recorded is True
    assert len(queued_transactions()) == 1
    manage.mark_account_reports_pushed([
        row for row in manage.list_due_account_reports() if row["report_type"] == "status"
    ])
    sent = []
    result = drain_remote_account_reports(
        lambda payload: sent.append(payload) or {"accepted": True}, creator_uid=UID,
    )
    assert result["pushed"] == 1
    assert sent[0]["account_status"] == STATUS


@pytest.mark.parametrize("failure", ["lookup", "write", "commit"])
def test_queue_db_failures_fail_ingest_ack_and_roll_back(monkeypatch, failure):
    original = db.get_connection

    class Connection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if ((failure == "lookup" and sql.startswith("SELECT id, workspace_id, model FROM credit_txn"))
                    or (failure == "write" and sql.startswith("INSERT INTO account_report_outbox")
                        and args[0][1] == "transaction")
                    or (failure == "commit" and sql == "COMMIT")):
                raise sqlite3.OperationalError("injected database failure")
            return self.conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.conn, name)

    @contextmanager
    def failing_connection():
        with original() as conn:
            yield Connection(conn)

    monkeypatch.setattr(manage_account_reports, "get_connection", failing_connection)
    assert ingest_transactions([TRANSACTION]).transactions_recorded is False
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM credit_txn").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM account_report_outbox").fetchone()[0] == 0


def test_concurrent_enrichment_is_read_after_writer_commits(monkeypatch):
    manage.record_transactions(UID, EMAIL, [TRANSACTION])
    original = db.get_connection
    before_begin = Event()

    class Connection:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if sql == "BEGIN IMMEDIATE":
                before_begin.set()
            if sql.startswith("SELECT id, workspace_id, model FROM credit_txn"):
                assert self.conn.in_transaction, "queue must lock before lookup"
            return self.conn.execute(sql, *args)

        def __getattr__(self, name):
            return getattr(self.conn, name)

    @contextmanager
    def observed_connection():
        with original() as conn:
            yield Connection(conn)

    monkeypatch.setattr(manage_account_reports, "get_connection", observed_connection)

    def queue_in_thread():
        token = active_account.set_override("")
        try:
            return manage.queue_account_reports(None, [{**TRANSACTION, "workspace_id": "B"}], EMAIL)
        finally:
            db.flush_pool()
            active_account.reset_override(token)

    with ThreadPoolExecutor(max_workers=1) as executor:
        with db.get_connection() as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE credit_txn SET workspace_id='A', model='model-a'")
            future = executor.submit(queue_in_thread)
            try:
                assert before_begin.wait(5), "queue writer did not reach lock"
                assert not future.done(), "queue must wait for concurrent enrichment"
            finally:
                writer.execute("COMMIT")
        assert future.result(timeout=5)["transactions_queued"] is True
    assert queue_payload()["workspace_id"] == "A"
    assert queue_payload()["model"] == "model-a"


def test_stale_transaction_ack_cannot_clear_enriched_revision():
    assert ingest_transactions([TRANSACTION]).transactions_recorded is True
    stale = [row for row in manage.list_due_account_reports() if row["report_type"] == "transaction"]
    enriched = {**TRANSACTION, "workspace_id": "A", "model": "model-a"}
    assert ingest_transactions([enriched]).transactions_recorded is True
    assert manage.mark_account_reports_pushed(stale) == 0
    current = queued_transactions()[0]
    assert current["dirty_rev"] == stale[0]["dirty_rev"] + 1
    assert current["pushed_at"] is None
    assert manage.mark_account_reports_pushed([current]) == 1


@pytest.mark.parametrize("values", [[], [TRANSACTION], [TRANSACTION, TRANSACTION],
                                       [{**TRANSACTION, "credits": False}]])
def test_server_ack_accepts_stored_duplicates_and_rejections(values):
    body = AccountReportIn(account_status=STATUS, account_transactions=values, creator_uid=UID)
    assert ingest.ingest_account_report(body, request()).accepted is True
    assert ingest.ingest_account_report(body, request()).accepted is True


def test_server_missing_valid_row_fails_ack():
    suppress_ledger_insert()
    body = AccountReportIn(account_status=STATUS, account_transactions=[TRANSACTION], creator_uid=UID)
    with pytest.raises(HTTPException) as error:
        ingest.ingest_account_report(body, request())
    assert error.value.status_code == 503


def test_delivery_does_not_clear_queue_when_real_receiver_cannot_store(tmp_path, monkeypatch):
    assert ingest_transactions([TRANSACTION]).transactions_recorded is True
    local_path = db.get_db_path()
    server_path = tmp_path / "server.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(server_path))
    db.init_db()
    repo.ensure_default_worker()
    manage.record_transactions(UID, EMAIL, [])
    suppress_ledger_insert()
    monkeypatch.setenv("CONTENT_HUB_DB", str(local_path))

    def push(payload):
        monkeypatch.setenv("CONTENT_HUB_DB", str(server_path))
        try:
            return ingest.ingest_account_report(AccountReportIn(**payload), request()).model_dump()
        finally:
            monkeypatch.setenv("CONTENT_HUB_DB", str(local_path))

    result = drain_remote_account_reports(push, creator_uid=UID)
    assert result["pushed"] == 1  # 상태만 성공, 거래는 대기 유지
    assert result["failed"] == 1
    row = queued_transactions()[0]
    assert row["pushed_at"] is None
    assert row["fail_streak"] == 1


def test_ledger_write_failure_fails_both_receivers():
    with db.get_connection() as conn:
        conn.execute("CREATE TRIGGER fail_txn BEFORE INSERT ON credit_txn "
                     "BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    assert ingest_transactions([TRANSACTION]).transactions_recorded is False
    with pytest.raises(sqlite3.IntegrityError):
        ingest.ingest_account_report(
            AccountReportIn(account_status=STATUS, account_transactions=[TRANSACTION]), request(),
        )
