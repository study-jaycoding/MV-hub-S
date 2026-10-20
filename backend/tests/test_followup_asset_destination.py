import hashlib
from pathlib import Path

import pytest

from app import db, schema_compat
from app.services import asset_destination as destination
from test_asset_sync import PNG, storage


def register(conn, base, monkeypatch, *, folder="selected", owner="user_a"):
    root = base / "assets"
    (root / folder).mkdir(parents=True, exist_ok=True)
    source = base / "local.png"
    source.write_bytes(PNG)
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: "user_a")
    monkeypatch.setattr(destination.active_account, "account_key", lambda: "")
    monkeypatch.setattr(destination.shared_connection, "base_url", lambda: "http://sync.invalid")
    return destination.register(conn, path=source, file_path="asset:imports|local.png",
        digest=hashlib.sha256(PNG).hexdigest(), size=len(PNG), media_type="image", owner=owner,
        destination={"kind": "project", "root_path": str(root), "project_name": "Project",
                     "project_id": "p", "relative_dir": folder}, name="original.png")


def test_folder_destination_is_distinct_from_imp_cap_and_idempotent(storage, monkeypatch):
    conn, base = storage
    queued = register(conn, base, monkeypatch)
    assert conn.execute("SELECT count(*) FROM asset_sync_outbox").fetchone()[0] == 0
    assert destination.process_one()
    assert (base / "assets/selected/original.png").read_bytes() == PNG
    assert not (base / "assets/imp_cap").exists()
    register(conn, base, monkeypatch)
    assert destination.process_one()
    assert len(list((base / "assets/selected").iterdir())) == 1
    assert destination.status(conn, "user_a")[0]["sync_id"] == queued["sync_id"]
    assert not destination.process_one()


def test_folder_conflict_never_overwrites_and_different_folder_has_own_intent(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch)
    existing = base / "assets/selected/original.png"
    existing.write_bytes(b"user original")
    assert destination.process_one()
    assert existing.read_bytes() == b"user original"
    assert (existing.parent / "original_2.png").read_bytes() == PNG
    register(conn, base, monkeypatch, folder="other")
    assert destination.process_one()
    assert (base / "assets/other/original.png").read_bytes() == PNG


def test_changed_root_and_account_are_not_written(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch)
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: "other")
    assert not destination.process_one()
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: "user_a")
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'", (str(base / "different"),))
    assert destination.process_one()
    assert not (base / "assets/selected/original.png").exists()
    assert destination.status(conn, "user_a")[0]["last_error_code"] == "asset_destination_changed"


def test_destination_migration_replays_without_changing_existing_component(storage):
    conn, base = storage
    before = conn.execute("SELECT checksum FROM schema_migrations WHERE migration_id='content_asset_sync.v1'").fetchone()[0]
    db.init_db(base / "content.db")
    assert conn.execute("SELECT checksum FROM schema_migrations WHERE migration_id='content_asset_sync.v1'").fetchone()[0] == before
    assert "content_asset_destination" in schema_compat.inspect_schema(conn, "content").components


def test_folder_upload_returns_local_receipt_before_touching_destination(storage, monkeypatch):
    import asyncio
    import io
    from starlette.requests import Request
    from fastapi import UploadFile
    from app.routers import assets
    conn, base = storage
    monkeypatch.setattr(assets, "ASSETS_ROOT", base / "local-assets")
    monkeypatch.setattr(assets, "_owner_mounts", lambda owner: [{"name": "Offline", "path": str(base / "unavailable"), "owner": owner}])
    monkeypatch.setattr(assets, "_safe_project_dir", lambda *args: (_ for _ in ()).throw(AssertionError("destination IO during admission")))
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: "user_a")
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 5000)})
    result = asyncio.run(assets.upload_assets(request, project="Offline", dir="selected",
        files=[UploadFile(io.BytesIO(PNG), filename="input.png")]))
    assert result["saved"] == []
    assert result["queued"][0]["sync_state"] == "queued"
    assert result["queued"][0]["asset_content_id"] == "sha256:" + hashlib.sha256(PNG).hexdigest()
    assert (base / "local-assets/imports/input.png").read_bytes() == PNG
    assert not (base / "unavailable").exists()


@pytest.mark.parametrize("value", ["../outside", "a/../../x", "/absolute", r"C:\outside", "NUL.png", "a/trailing."])
def test_destination_rejects_windows_unsafe_paths(value):
    with pytest.raises(ValueError, match="unsafe_asset_destination"):
        destination.validate_relative(value)


def test_permission_revoked_before_copy_leaves_source(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch)
    monkeypatch.setattr(destination.config, "AUTH_ENABLED", True)
    assert destination.process_one()
    assert destination.status(conn, "user_a")[0]["last_error_code"] == "asset_destination_changed"
    assert (base / "local.png").read_bytes() == PNG
    assert not (base / "assets/selected/original.png").exists()


def test_status_does_not_mix_different_server_or_reveal_absolute_paths(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch)
    status = destination.status(conn, "user_a")
    assert "root_path" not in status[0] and "path" not in status[0]
    monkeypatch.setattr(destination.shared_connection, "base_url", lambda: "http://other.invalid")
    assert destination.status(conn, "user_a") == []


def test_standalone_without_active_account_uses_same_default_owner(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch, owner=destination.config.DEFAULT_WORKER_ID)
    monkeypatch.setattr(destination.config, "AUTH_ENABLED", False)
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: None)
    assert destination.process_one()
    assert destination.status(conn, destination.config.DEFAULT_WORKER_ID)[0]["state"] == "ready"
    assert (base / "assets/selected/original.png").read_bytes() == PNG


@pytest.mark.parametrize("authorized", [True, False])
def test_authenticated_server_uses_queued_owner_and_rechecks_permission(storage, monkeypatch, authorized):
    conn, base = storage
    register(conn, base, monkeypatch)
    monkeypatch.setattr(destination.config, "AUTH_ENABLED", True)
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: None)
    if authorized:
        conn.execute("INSERT INTO project_member VALUES('p','user_a','creator')")
    assert destination.process_one()
    assert destination.status(conn, "user_a")[0]["state"] == ("ready" if authorized else "retrying")
    assert (base / "assets/selected/original.png").exists() is authorized


def test_authenticated_server_does_not_claim_another_account_queue(storage, monkeypatch):
    conn, base = storage
    register(conn, base, monkeypatch)
    monkeypatch.setattr(destination.config, "AUTH_ENABLED", True)
    monkeypatch.setattr(destination.active_account, "active_uid", lambda: None)
    monkeypatch.setattr(destination.active_account, "account_key", lambda: "other")
    assert not destination.process_one()
    assert not (base / "assets/selected/original.png").exists()
