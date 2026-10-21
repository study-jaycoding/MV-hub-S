"""New folder-save jobs survive an existing identity merge."""
import hashlib
import sqlite3
import asyncio
import pytest

from app import db_asset_destination, db_asset_sync
from app.repo import asset_sync as ledger, identity


def test_destination_merge_retargets_local_location_and_keeps_completed_copy():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    for table in ("project", "reference", "asset", "gen_reference"):
        conn.execute(f'CREATE TABLE "{table}" (id TEXT)')
    db_asset_sync.migrate(conn)
    db_asset_destination.migrate(conn)
    cid = "sha256:" + hashlib.sha256(b"image").hexdigest()
    conn.execute("INSERT INTO asset_blob VALUES(?,?,5,'image',datetime('now'))", (cid, cid[7:]))
    for owner, loc in (("old", "oldloc"), ("new", "newloc")):
        conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,storage_id,kind,path) VALUES(?,?,?,'s','local','image.png')", (loc, cid, owner))
    conn.execute("INSERT INTO asset_destination_outbox(sync_id,asset_content_id,local_location_id,owner_uid,account_key,server_origin,project_name,destination_kind,root_path,relative_dir,original_name,state,target_name,updated_at) VALUES('job',?,'oldloc','old','account','origin','project','manual','root','dir','image.png','ready','image.png',0)", (cid,))
    identity._remap_asset_sync(conn, "asset_location", "old", "new")
    identity._remap_asset_sync(conn, "asset_destination_outbox", "old", "new")
    row = conn.execute("SELECT * FROM asset_destination_outbox").fetchone()
    assert (row["owner_uid"], row["local_location_id"], row["state"], row["target_name"]) == ("new", "newloc", "ready", "image.png")
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


@pytest.mark.parametrize('state', ['deleted', 'ready', 'uploading'])
def test_identity_merge_resets_pins_and_preserves_receipt_and_deleted_intent(state):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    for table in ("project", "reference", "asset", "gen_reference"):
        conn.execute(f'CREATE TABLE "{table}" (id TEXT)')
    conn.execute("ALTER TABLE asset ADD COLUMN generation_id TEXT")
    conn.execute("CREATE TABLE generation(id TEXT,creator_uid TEXT,project_id TEXT)")
    db_asset_sync.migrate(conn)
    digest = hashlib.sha256(b"image").hexdigest()
    cid = "sha256:" + digest
    conn.execute("INSERT INTO asset_blob VALUES(?,?,5,'image',datetime('now'))", (cid, digest))
    conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,storage_id,kind,path) VALUES('loc',?,'old','s','local','image.png')", (cid,))
    receipt = '{"location_id":"old-location","storage_id":"s","root_revision":"old-root"}'
    error = 'asset_deleted_in_app' if state == 'deleted' else None
    conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,account_key,project_id,state,receipt_json,storage_id,root_revision,last_error_code,lease_token,lease_until,next_retry_at,updated_at) VALUES('sync',?,'loc','old','account','p',?,?,'s','old-root',?,'lease',999,999,0)", (cid,state,receipt,error))
    identity._remap_asset_sync(conn, "asset_sync_outbox", "old", "new")
    row = conn.execute("SELECT * FROM asset_sync_outbox").fetchone()
    assert (row['owner_uid'], row['state'], row['receipt_json'], row['last_error_code']) == (
        'new', 'deleted' if state == 'deleted' else 'queued', receipt, error)
    assert (row['storage_id'], row['root_revision'], row['lease_token'], row['lease_until'], row['next_retry_at']) == ('', '', None, None, 0)
    if state == 'deleted':
        conn.execute("INSERT INTO generation VALUES('g','new','p')")
        conn.execute("INSERT INTO asset(id,generation_id,asset_content_id) VALUES('a','g',?)", (cid,))
        ledger.generation_output_intent(conn, 'g', deleted=False)
        assert conn.execute("SELECT state FROM asset_sync_outbox").fetchone()[0] == 'queued'
    conn.close()


def test_cached_pre_draft_schema_does_not_drop_draft_flags(monkeypatch):
    from app.services import cli_bridge
    async def old_schema(_model):
        return {"resolution", "duration"}
    monkeypatch.setattr(cli_bridge, "_allowed_param_names", old_schema)
    args = asyncio.run(cli_bridge._param_args("seedance_2_5", {"resolution": "480p", "draft": True}))
    assert args == ["--resolution", "480p", "--draft", "true"]
    assert "--draft" not in asyncio.run(cli_bridge._param_args("another_model", {"draft": True}))


@pytest.mark.parametrize("live", [False, True])
def test_colliding_deleted_queue_preserves_intent_unless_still_used(live):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE project(id TEXT);
        CREATE TABLE reference(id TEXT);
        CREATE TABLE asset(id TEXT, generation_id TEXT);
        CREATE TABLE gen_reference(generation_id TEXT, reference_id TEXT);
        CREATE TABLE generation(id TEXT, creator_uid TEXT, project_id TEXT, deleted_at TEXT);
    """)
    db_asset_sync.migrate(conn)
    digest = hashlib.sha256(b"image").hexdigest()
    cid = "sha256:" + digest
    conn.execute("INSERT INTO asset_blob VALUES(?,?,5,'image',datetime('now'))", (cid, digest))
    conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,storage_id,kind,path) VALUES('loc',?,'new','s','local','image.png')", (cid,))
    for owner, state in (("old", "deleted"), ("new", "ready")):
        conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,account_key,project_id,state,updated_at) VALUES(?,?,'loc',?,'account','p',?,0)", (owner, cid, owner, state))
    if live:
        conn.execute("INSERT INTO generation VALUES('g','new','p',NULL)")
        conn.execute("INSERT INTO asset(id,generation_id,asset_content_id) VALUES('a','g',?)", (cid,))
    identity._remap_asset_sync(conn, "asset_sync_outbox", "old", "new")
    assert conn.execute("SELECT owner_uid,state FROM asset_sync_outbox").fetchall()[0][:] == ("new", "queued" if live else "deleted")
    assert conn.execute("SELECT COUNT(*) FROM asset_sync_outbox").fetchone()[0] == 1
    conn.close()
