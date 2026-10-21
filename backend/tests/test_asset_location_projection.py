"""Verified read projections never rewrite source evidence or accepted generation payloads."""
from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest

from app import db, repo
from app.repo import asset_locations
from app.repo import asset_sync as ledger
from app.repo.generation_rows import _fetch_generation
from app.services import asset_sync as sync, shared_connection
from app.shared_server_config import DEFAULT_SHARED_URL


PNG = b'\x89PNG\r\n\x1a\nprojection test bytes'
SHA = hashlib.sha256(PNG).hexdigest()
CID = 'sha256:' + SHA
ORIGIN = 'http://asset-fixture.test'
LOCATION = 'a' * 32


@pytest.fixture
def storage(tmp_path, monkeypatch):
    path = db.init_db(tmp_path / 'content.db')
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    repo.ensure_default_worker()
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("INSERT INTO project(id,name,asset_root_path) VALUES('p','Project',?)", (str(tmp_path / 'assets'),))
    conn.execute("INSERT INTO project(id,name,asset_root_path) VALUES('q','Other',?)", (str(tmp_path / 'other'),))
    conn.execute("INSERT INTO app_setting(key,value) VALUES('shared_server_url',?)", (ORIGIN,))
    conn.execute("INSERT INTO generation(id,worker_id,prompt,model,status,creator_uid,project_id) VALUES('g','me','keep prompt','model','done','owner','p')")
    ledger.register_verified_blob(conn, SHA, len(PNG), 'image')
    conn.execute("INSERT INTO asset(id,generation_id,type,file_path,source_url,thumbnail_path,asset_content_id) "
                 "VALUES('a','g','image','/media/result.png','https://old.invalid/result.png','/media/thumb.jpg',?)", (CID,))
    conn.execute("INSERT INTO reference(id,type,file_path,source_url,share_url,content_sha,content_bytes,asset_content_id) "
                 "VALUES('r','image','asset:captures|source.png','https://old.invalid/source.png','https://old.invalid/share.png',?,?,?)",
                 (SHA, len(PNG), CID))
    conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role,position) VALUES('g','r','@Image2',1)")
    accepted = json.dumps({'prompt': 'keep prompt', 'references': [{'file_path': 'asset:captures|source.png', 'asset_content_id': CID}]}, sort_keys=True)
    conn.execute("INSERT INTO gen_request(id,account_email,creator_uid,gen_id,kind,payload,status) VALUES('request','fixture@example.invalid','owner','g','create',?,'pending')", (accepted,))
    yield conn, tmp_path, accepted
    conn.close()


def ready(conn, origin=ORIGIN, owner='owner', project='p', **patch):
    registered = ledger.register_local(conn, path='unused-local.png', file_path='asset:captures|source.png', digest=SHA,
        size=len(PNG), media_type='image', owner_uid=owner, project_id=project, server_origin=origin, account_key='fixture')
    receipt = {'state': 'ready', 'asset_content_id': CID, 'owner_uid': owner, 'project_id': project,
        'storage_id': 'server-storage', 'root_revision': 'b' * 64, 'server_origin': origin,
        'location_id': LOCATION, 'file_path': 'asset-sync:' + LOCATION, **patch}
    conn.execute("UPDATE asset_sync_outbox SET state='ready',receipt_json=?,storage_id=?,root_revision=? WHERE asset_content_id=? AND owner_uid=? AND project_id=? AND server_origin=?",
        (json.dumps(receipt), receipt['storage_id'], receipt['root_revision'], registered['asset_content_id'], owner, project, origin))
    return receipt


def test_ready_ack_projects_library_recipe_and_share_without_rewriting_evidence(storage):
    conn, _, accepted = storage
    receipt = ready(conn)
    row = _fetch_generation(conn, 'g')
    for item in [row['assets'][0], row['references'][0]]:
        assert item['file_path'] == receipt['file_path']
        assert item['source_url'] == '/api/asset-sync/files/' + LOCATION
        assert item['asset_content_id'] == CID
        assert item['target_project_id'] == 'p'
        assert item['server_location']['owner_uid'] == 'owner'
    assert row['assets'][0]['thumbnail_path'] is None
    assert row['references'][0]['role'] == '@Image2'
    recipe = repo.gen_recipe('g')
    assert recipe['references'][0]['file_path'] == receipt['file_path']
    assert recipe['references'][0]['role'] == '@Image2'
    bundle = repo.export_bundle(gen_ids=['g'])['generations'][0]
    assert bundle['asset']['file_path'] == receipt['file_path']
    assert bundle['references'][0]['file_path'] == receipt['file_path']  # Overrides older share_url, too.
    assert conn.execute("SELECT file_path FROM asset WHERE id='a'").fetchone()[0] == '/media/result.png'
    reference = conn.execute("SELECT file_path,source_url,content_sha FROM reference WHERE id='r'").fetchone()
    assert tuple(reference) == ('asset:captures|source.png', 'https://old.invalid/source.png', SHA)
    assert conn.execute("SELECT payload FROM gen_request WHERE id='request'").fetchone()[0] == accepted


@pytest.mark.parametrize('owner,project,origin', [('other','p',ORIGIN), ('owner','q',ORIGIN), ('owner','p','http://inactive.invalid')])
def test_different_generation_owner_project_or_inactive_origin_does_not_project(storage, owner, project, origin):
    conn, _, _ = storage
    ready(conn, owner=owner, project=project, origin=origin)
    row = _fetch_generation(conn, 'g')
    assert row['assets'][0]['file_path'] == '/media/result.png'
    assert row['references'][0]['file_path'] == 'asset:captures|source.png'
    assert 'server_location' not in row['references'][0]


@pytest.mark.parametrize('patch', [{'location_id':'../bad'}, {'asset_content_id':'sha256:'+'c'*64},
    {'owner_uid':'other'}, {'project_id':'q'}, {'server_origin':'http://old.invalid'}, {'state':'uploading'}, {'root_revision':''}])
def test_incomplete_or_inconsistent_receipts_are_not_used(storage, patch):
    conn, _, _ = storage
    ready(conn, **patch)
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'


def test_queued_old_receipt_and_records_without_verified_content_keep_current_behavior(storage):
    conn, _, _ = storage
    ready(conn)
    conn.execute("UPDATE asset_sync_outbox SET state='queued'")
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'
    conn.execute("UPDATE asset_sync_outbox SET state='ready'")
    conn.execute("UPDATE reference SET asset_content_id=NULL WHERE id='r'")
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'


def test_server_only_location_requires_current_root_and_storage_identity(storage):
    conn, base, _ = storage
    ticket = sync.prepare(owner_uid='owner', display_name='제이', project_id='p', digest=SHA,
        size=len(PNG), media_type='image', original_name='source.png')
    temporary = base / 'input.png'
    temporary.write_bytes(PNG)
    receipt = sync.accept_upload(ticket['token'], 'owner', temporary, SHA, len(PNG))
    assert conn.execute('SELECT count(*) FROM asset_sync_outbox').fetchone()[0] == 0
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == receipt['file_path']
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'", (str(base / 'changed-root'),))
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'
    conn.execute("UPDATE project SET asset_root_path=? WHERE id='p'", (str(base / 'assets'),))
    conn.execute("UPDATE asset_location SET storage_id='unrelated-storage' WHERE kind='server'")
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'


def test_shared_reference_row_is_projected_per_generation_and_never_updated_globally(storage):
    conn, _, _ = storage
    ready(conn)
    conn.execute("INSERT INTO generation(id,worker_id,prompt,status,creator_uid,project_id) VALUES('other','me','other','done','someone','p')")
    conn.execute("INSERT INTO gen_reference(generation_id,reference_id,role) VALUES('other','r','@Image1')")
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'].startswith('asset-sync:')
    assert _fetch_generation(conn, 'other')['references'][0]['file_path'] == 'asset:captures|source.png'
    assert conn.execute("SELECT file_path FROM reference WHERE id='r'").fetchone()[0] == 'asset:captures|source.png'


def test_default_origin_is_the_same_import_time_default_as_connection_service(storage):
    conn, _, _ = storage
    assert shared_connection.DEFAULT_SHARED_URL == DEFAULT_SHARED_URL
    conn.execute("DELETE FROM app_setting WHERE key='shared_server_url'")
    ready(conn, origin=DEFAULT_SHARED_URL)
    assert _fetch_generation(conn, 'g')['references'][0]['server_location']['server_origin'] == DEFAULT_SHARED_URL


def test_digest_evidence_mismatch_does_not_connect_a_different_version(storage):
    conn, _, _ = storage
    ready(conn)
    conn.execute("UPDATE reference SET content_sha=? WHERE id='r'", ('c' * 64,))
    assert _fetch_generation(conn, 'g')['references'][0]['file_path'] == 'asset:captures|source.png'
    conn.execute("UPDATE reference SET content_sha=? WHERE id='r'", (SHA,))
    conn.execute("UPDATE asset_blob SET sha256=? WHERE asset_content_id=?", ('c' * 64, CID))
    assert _fetch_generation(conn, 'g')['assets'][0]['file_path'] == '/media/result.png'


def test_projection_uses_the_passed_account_connection_and_batches_location_reads(storage, monkeypatch):
    conn, base, _ = storage
    ready(conn)
    monkeypatch.setenv('CONTENT_HUB_DB', str(db.init_db(base / 'other-account.db')))
    statements = []
    conn.set_trace_callback(statements.append)
    copies = [{'creator_uid':'owner','project_id':'p','references':[{'file_path':'local','asset_content_id':CID}]} for _ in range(200)]
    asset_locations.project_generation_locations(conn, copies)
    conn.set_trace_callback(None)
    assert all(row['references'][0]['file_path'] == 'asset-sync:' + LOCATION for row in copies)
    assert len([sql for sql in statements if sql.lstrip().upper().startswith('SELECT')]) == 4
    assert not any(sql.lstrip().upper().startswith(('UPDATE','INSERT','DELETE')) for sql in statements)
