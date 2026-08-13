from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from app import db, repo
from app.services import event_journal


def _use_temp_db(tmp: str):
    old = os.environ.get("CONTENT_HUB_DB")
    os.environ["CONTENT_HUB_DB"] = str(Path(tmp) / "content_hub.db")
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    return old


def _restore_db(old: str | None) -> None:
    db.flush_pool()
    if old is None:
        os.environ.pop("CONTENT_HUB_DB", None)
    else:
        os.environ["CONTENT_HUB_DB"] = old
    db.flush_pool()


def test_status_triggers_keep_complete_generation_and_request_history():
    with tempfile.TemporaryDirectory() as tmp:
        old = _use_temp_db(tmp)
        try:
            gen_id = repo.create_local_generation(
                {"model": "test-model", "prompt": "must never enter the journal"}, "me"
            )
            request_id = repo.create_gen_request(
                "private@example.com",
                "acct:private@example.com",
                gen_id,
                "create",
                {"prompt": "another secret"},
            )
            with db.get_connection() as conn:
                conn.execute("UPDATE gen_request SET status='submitting' WHERE id=?", (request_id,))
                conn.execute("UPDATE generation SET status='running' WHERE id=?", (gen_id,))
                conn.execute("UPDATE gen_request SET status='done' WHERE id=?", (request_id,))
                conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))

            rows = repo.list_generation_events(generation_id=gen_id, limit=100)
            transitions = {(r["event"], r["from_phase"], r["to_phase"]) for r in rows}
            assert ("request_status_changed", "pending", "submitting") in transitions
            assert ("request_status_changed", "submitting", "done") in transitions
            assert ("generation_status_changed", "pending", "running") in transitions
            assert ("generation_status_changed", "running", "done") in transitions
            serialized = json.dumps(rows, ensure_ascii=False)
            assert "private@example.com" not in serialized
            assert "must never enter" not in serialized
            assert "another secret" not in serialized

            # 원본 요청/생성 행이 없어져도 운영 이력은 FK와 분리되어 남는다.
            with db.get_connection() as conn:
                conn.execute("DELETE FROM gen_request WHERE id=?", (request_id,))
                conn.execute("PRAGMA foreign_keys=OFF")
                conn.execute("DELETE FROM generation WHERE id=?", (gen_id,))
            assert repo.list_generation_events(generation_id=gen_id, limit=100)
        finally:
            _restore_db(old)


def test_audit_journal_redacts_sensitive_values_and_hashes_email_identity():
    with tempfile.TemporaryDirectory() as tmp:
        old = _use_temp_db(tmp)
        try:
            assert event_journal.journal_audit_event(
                "account.password_reset",
                actor_uid="acct:admin@example.com",
                target_type="account",
                target_id=repo.account_target("person@example.com"),
                fields=["password", "status"],
                details={
                    "password": "visible-secret",
                    "prompt": "private prompt",
                    "result_url": "https://cdn.example/item",
                    "status": "approved",
                    "nested_values": [
                        "safe",
                        "owner@example.com",
                        "result at https://private.example/item",
                    ],
                    "nested_mapping": {
                        "callback": "https://secret.example/item",
                        "password": "deep-secret",
                    },
                },
            )
            row = repo.list_audit_events(limit=1)[0]
            assert row["action"] == "account.password_reset"
            assert row["details"]["status"] == "approved"
            serialized = json.dumps(row, ensure_ascii=False)
            assert "admin@example.com" not in serialized
            assert "person@example.com" not in serialized
            assert "visible-secret" not in serialized
            assert "private prompt" not in serialized
            assert "cdn.example" not in serialized
            assert "owner@example.com" not in serialized
            assert "private.example" not in serialized
            assert "secret.example" not in serialized
            assert "deep-secret" not in serialized
        finally:
            _restore_db(old)


def test_journal_failure_is_reported_without_raising(monkeypatch, caplog):
    def broken(*args, **kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(event_journal.journal_repo, "record_generation_event", broken)
    with caplog.at_level("ERROR"):
        result = event_journal.journal_generation_event(
            "generation_requested", "gen-1", to_phase="pending"
        )
    assert result is False
    assert "generation_journal_write_failed" in caplog.text
