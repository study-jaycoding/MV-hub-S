import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.repo import asset_sync as ledger
from app.routers import asset_sync as api
from app.services import asset_sync as sync
from test_asset_sync import PNG, storage, prep, upload


def test_missing_unavailable_and_changed_are_distinct(storage, monkeypatch):
    conn, base = storage
    receipt = upload(conn, base, prep(conn))
    row = conn.execute("SELECT * FROM asset_location WHERE location_id=?", (receipt["location_id"],)).fetchone()
    path = base / "assets" / row["path"]
    path.unlink()
    with pytest.raises(sync.SyncError, match="asset_server_copy_missing"):
        sync.checked_server_location(row)
    monkeypatch.setattr(sync.os, "scandir", lambda _: (_ for _ in ()).throw(PermissionError()))
    with pytest.raises(sync.SyncError, match="asset_storage_unavailable"):
        sync.checked_server_location(row)
    path.write_bytes(PNG + b"changed")
    with pytest.raises(sync.SyncError, match="asset_server_copy_changed"):
        sync.checked_server_location(row)


def test_reverification_is_bounded_and_confirmed_loss_requeues(storage, monkeypatch):
    conn, base = storage
    source = base / "local.png"
    source.write_bytes(PNG)
    monkeypatch.setattr(sync.active_account, "active_uid", lambda: "user_a")
    monkeypatch.setattr(sync.active_account, "account_key", lambda: "")
    monkeypatch.setattr(sync.shared_connection, "base_url", lambda: "http://sync.invalid")
    monkeypatch.setattr(sync.shared_connection, "token", lambda: "fake")
    sync.register_local(source, "asset:imports|local.png", hashlib.sha256(PNG).hexdigest(), len(PNG), "image", "user_a", "p")
    receipt = upload(conn, base, prep(conn))
    receipt["server_origin"] = "http://sync.invalid"
    conn.execute("UPDATE asset_sync_outbox SET state='ready',receipt_json=?,storage_id=?,root_revision=?",
                 (json.dumps(receipt), receipt["storage_id"], receipt["root_revision"]))
    monkeypatch.setattr(sync, "_json_call", lambda origin, token, route, body: {**body, "owner_uid": "user_a", "state": "missing"})
    assert sync.verify_one()
    assert ledger.status_rows(conn, "user_a")[0]["state"] == "queued"
    assert conn.execute("SELECT next_retry_at FROM asset_sync_outbox").fetchone()[0] <= time.time()
    assert not sync.verify_one()


def test_verify_rejects_foreign_receipt_and_preserves_deleted_intent(storage, monkeypatch):
    conn, base = storage
    receipt = upload(conn, base, prep(conn))
    monkeypatch.setattr(api, "actor_id", lambda request: "user_a")
    monkeypatch.setattr(api, "require_project_role", lambda *args, **kwargs: None)
    body = api.VerifyIn(**{k: receipt[k] for k in ("location_id", "asset_content_id", "project_id", "storage_id", "root_revision")})
    conn.execute("UPDATE asset_location SET state='deleted' WHERE location_id=?", (receipt["location_id"],))
    assert api.verify(body, SimpleNamespace())["state"] == "deleted"
    monkeypatch.setattr(api, "actor_id", lambda request: "user_b")
    assert api.verify(body, SimpleNamespace())["state"] == "unknown"


def test_expired_intent_cannot_be_bypassed_by_old_upload_ticket(storage):
    conn, base = storage
    receipt = upload(conn, base, prep(conn))
    row = conn.execute("SELECT * FROM asset_location WHERE location_id=?", (receipt["location_id"],)).fetchone()
    path = base / "assets" / row["path"]
    path.unlink()
    ticket = prep(conn)
    conn.execute("UPDATE asset_location SET state='deleted' WHERE location_id=?", (receipt["location_id"],))
    with pytest.raises(sync.SyncError, match="asset_deleted"):
        upload(conn, base, ticket)
    assert not path.exists()


@pytest.mark.parametrize("server_state,local_valid,expected", [
    ("unavailable", True, "ready"), ("missing", False, "recovery_required"),
    ("deleted", True, "deleted"), ("changed", True, "verification_failed"),
])
def test_only_confirmed_missing_readable_copy_is_recoverable(storage, monkeypatch, server_state, local_valid, expected):
    conn, base = storage
    source = base / "local.png"
    source.write_bytes(PNG)
    monkeypatch.setattr(sync.active_account, "active_uid", lambda: "user_a")
    monkeypatch.setattr(sync.active_account, "account_key", lambda: "")
    monkeypatch.setattr(sync.shared_connection, "base_url", lambda: "http://sync.invalid")
    monkeypatch.setattr(sync.shared_connection, "token", lambda: "fake")
    sync.register_local(source, "asset:imports|local.png", hashlib.sha256(PNG).hexdigest(), len(PNG), "image", "user_a", "p")
    receipt = upload(conn, base, prep(conn))
    conn.execute("UPDATE asset_sync_outbox SET state='ready',receipt_json=?,storage_id=?,root_revision=?",
                 (json.dumps(receipt), receipt["storage_id"], receipt["root_revision"]))
    if not local_valid:
        source.unlink()
    monkeypatch.setattr(sync, "_json_call", lambda origin, token, route, body: {**body, "owner_uid": "user_a", "state": server_state})
    assert sync.verify_one()
    assert ledger.status_rows(conn, "user_a")[0]["state"] == expected
