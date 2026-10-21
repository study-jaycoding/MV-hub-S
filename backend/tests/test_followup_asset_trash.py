import hashlib

import pytest

from app import db
from app.repo import asset_sync as ledger, projects, trash
from test_asset_sync import PNG
from test_trash_telemetry_atomic import trash_db, _seed_generation
from test_trash_transfer import enabled_db


def seed_output(conn):
    cid = ledger.register_verified_blob(conn, hashlib.sha256(PNG).hexdigest(), len(PNG), "image")
    conn.execute("UPDATE generation SET creator_uid='owner' WHERE id='g1'")
    conn.execute("INSERT OR IGNORE INTO asset(id,generation_id,type,file_path) VALUES('a1','g1','image','local.png')")
    conn.execute("UPDATE asset SET asset_content_id=? WHERE id='a1'", (cid,))
    conn.execute("INSERT INTO asset_location(location_id,asset_content_id,owner_uid,storage_id,kind,path) VALUES('local',?,'owner','storage','local','local.png')", (cid,))
    conn.execute("INSERT INTO asset_sync_outbox(sync_id,asset_content_id,local_location_id,owner_uid,account_key,project_id,server_origin,state,receipt_json,storage_id,root_revision,updated_at) VALUES('sync',?,'local','owner','','','https://example.invalid','ready','{}','storage','root',0)", (cid,))
    return cid


@pytest.mark.parametrize("fixture_name", ["trash_db", "enabled_db"])
def test_explicit_trash_cancels_only_local_recovery_and_restore_rechecks(request, fixture_name):
    request.getfixturevalue(fixture_name)
    if fixture_name == "trash_db":
        _seed_generation()
    with db.get_connection() as conn:
        seed_output(conn)
    assert trash.move_to_trash("g1")
    with db.get_connection() as conn:
        row = conn.execute("SELECT state,last_error_code FROM asset_sync_outbox").fetchone()
        assert tuple(row) == ("deleted", "asset_deleted_in_app")
    assert trash.restore_from_trash("g1")
    with db.get_connection() as conn:
        row = conn.execute("SELECT state,last_error_code,next_retry_at FROM asset_sync_outbox").fetchone()
        assert tuple(row) == ("ready", None, 0)


def test_another_live_reference_preserves_recovery_and_server_deletion_stays_deleted(trash_db):
    _seed_generation()
    _seed_generation("g2", job_id="job2")
    with db.get_connection() as conn:
        cid = seed_output(conn)
        conn.execute("UPDATE generation SET creator_uid='owner' WHERE id='g2'")
        conn.execute("INSERT INTO reference(id,type,file_path,asset_content_id) VALUES('ref','image','ref.png',?)", (cid,))
        conn.execute("INSERT INTO gen_reference(generation_id,reference_id) VALUES('g2','ref')")
        ledger.generation_output_intent(conn, "g1", deleted=True)
        assert conn.execute("SELECT state FROM asset_sync_outbox").fetchone()[0] == "ready"
        conn.execute("UPDATE asset_sync_outbox SET state='deleted',last_error_code='asset_deleted'")
        ledger.generation_output_intent(conn, "g1", deleted=False)
        assert conn.execute("SELECT state FROM asset_sync_outbox").fetchone()[0] == "deleted"


def test_asset_root_change_preserves_trashed_transfer_and_delete_reason(trash_db, tmp_path):
    _seed_generation()
    project = projects.create_project('Root change', created_by='owner', asset_root_path=str(tmp_path / 'old'))
    with db.get_connection() as conn:
        seed_output(conn)
        conn.execute("UPDATE generation SET project_id=? WHERE id='g1'", (project['id'],))
        conn.execute("UPDATE asset_sync_outbox SET project_id=?,storage_id='old',root_revision='old-root'", (project['id'],))
    assert trash.move_to_trash('g1')
    with db.get_connection() as conn:
        before = dict(conn.execute('SELECT * FROM asset_sync_outbox').fetchone())
        assert before['state'] == 'deleted' and before['last_error_code'] == 'asset_deleted_in_app'
    projects.set_asset_root(project['id'], str(tmp_path / 'new'))
    with db.get_connection() as conn:
        after = dict(conn.execute('SELECT * FROM asset_sync_outbox').fetchone())
        assert {key: after[key] for key in ('state', 'last_error_code', 'receipt_json')} == {
            key: before[key] for key in ('state', 'last_error_code', 'receipt_json')}
        assert (after['storage_id'], after['root_revision'], after['next_retry_at'],
                after['lease_token'], after['lease_until']) == ('', '', 0, None, None)
    assert trash.restore_from_trash('g1')
    with db.get_connection() as conn:
        assert conn.execute('SELECT state FROM asset_sync_outbox').fetchone()[0] == 'queued'
