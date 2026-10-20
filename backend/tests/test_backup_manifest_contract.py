"""Backup metadata is bound to the copied bytes, not a delivery claim."""
import json
import io
import sqlite3
import zipfile
import asyncio
from contextlib import closing
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile

from app import active_account
from app.services import worker_backup, backup_manifest, backup, backup_verify, trash_transfer
from app.routers import db_backup, db_transfer
from test_worker_offdisk_backup import worker_store, _queued
from test_trash_transfer import enabled_db


def test_new_worker_set_has_bound_contract(worker_store: Path):
    set_id, stage, manifest = _queued(worker_store)
    assert manifest['format_version'] == 2
    assert manifest['set_id'] == set_id
    assert manifest['payload_version'] == 1
    assert manifest['account_scope_digest'] == worker_backup.account_key_digest(active_account.slug('artist@example.com'))
    assert manifest['consistency_kind'] == 'consistency_unknown'
    assert manifest['captured_at'] is None  # No invented capture time for a legacy local file.
    for role, info in manifest['roles'].items():
        assert info['schema']['database_kind'] == role
        assert info['schema']['status'] == 'unversioned'
        assert info['schema']['database_id'] is None
        assert info['sha256'] == worker_backup._sha256(stage / f'{role}.db')


def test_v2_requires_metadata_ack(worker_store: Path):
    set_id, stage, manifest = _queued(worker_store)
    old_ack = {'accepted': True, 'backup_set_id': set_id, 'files': manifest['roles']}
    assert not worker_backup._verify_ack(old_ack, manifest)


def test_staged_v2_cannot_be_downgraded_before_delivery(worker_store, monkeypatch):
    set_id, stage, manifest = _queued(worker_store)
    legacy = {key: item for key, item in manifest.items() if key not in {
        'set_id', 'account_scope_digest', 'payload_version', 'captured_at', 'consistency_kind', 'consistency_roles'}}
    legacy['format_version'] = 1
    legacy['roles'] = {role: {key: info[key] for key in ('size', 'sha256')} for role, info in manifest['roles'].items()}
    (stage / 'manifest.json').write_text(json.dumps(legacy), encoding='utf-8')
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **kw: pytest.fail('must reject before upload'))
    assert worker_backup.drain_one() == {'state': 'failed', 'error_code': 'staging_invalid'}
    assert stage.exists()


def test_legacy_pending_set_keeps_legacy_ack_compatibility(worker_store, monkeypatch):
    set_id, stage, manifest = _queued(worker_store)
    legacy = {key: item for key, item in manifest.items() if key not in {
        'set_id', 'account_scope_digest', 'payload_version', 'captured_at', 'consistency_kind', 'consistency_roles'}}
    legacy['format_version'] = 1
    legacy['roles'] = {role: {key: info[key] for key in ('size', 'sha256')} for role, info in manifest['roles'].items()}
    assert not worker_backup._verify_ack({'accepted': True, 'backup_set_id': set_id,
        'files': legacy['roles'], 'format_version': 2}, legacy)
    (stage / 'manifest.json').write_text(json.dumps(legacy), encoding='utf-8')
    with worker_backup._connect() as conn:
        conn.execute('UPDATE worker_backup_outbox SET roles_json=?', (json.dumps(legacy['roles']),))
    monkeypatch.setattr(worker_backup.shared_connection, 'token', lambda: 'fixture')
    monkeypatch.setattr(worker_backup.shared_connection, 'base_url', lambda: 'http://fixture.invalid')
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **kw: (200,
        {'accepted': True, 'backup_set_id': set_id, 'files': legacy['roles']}))
    assert worker_backup.drain_one()['state'] == 'success'
    assert not stage.exists()


def test_v2_round_trip_metadata_and_ack(worker_store: Path, monkeypatch):
    set_id, stage, manifest = _queued(worker_store)
    parsed = db_backup._normalise_set_manifest(json.dumps(manifest))
    assert parsed == manifest
    ack = db_backup._store_backup_set(worker_store / 'server', parsed,
        {role: io.BytesIO((stage / f'{role}.db').read_bytes()) for role in parsed['roles']})
    assert worker_backup._verify_ack(ack, manifest)
    stored = worker_store / 'server' / 'sets' / set_id
    assert db_backup._read_stored_manifest(stored) == manifest
    monkeypatch.setattr(db_backup, 'DATA_DIR', worker_store)
    response = db_backup._download_set_response(worker_store / 'server', set_id)
    archive = Path(response.path)
    with zipfile.ZipFile(archive) as bundle:
        assert json.loads(bundle.read('manifest.json')) == manifest
    content, trash = db_transfer._extract_backup_set(archive, worker_store / 'restore')
    backup_manifest.verify_files(manifest, {'content': content, 'trash': trash})
    asyncio.run(response.background())
    assert not archive.exists()


def test_v2_account_scope_rejected_at_authenticated_receiver(worker_store, monkeypatch):
    _, stage, manifest = _queued(worker_store)
    monkeypatch.setattr(db_backup, '_acct', lambda _: {'email': 'other@example.invalid'})
    content = UploadFile(io.BytesIO((stage / 'content.db').read_bytes()), filename='content.db')
    with pytest.raises(HTTPException) as error:
        asyncio.run(db_backup.upload_backup_set(None, json.dumps(manifest), content, None))
    assert error.value.status_code == 400
    assert error.value.detail == 'backup account scope mismatch'


def test_uncheckpointed_sidecar_is_not_part_of_manifest_bytes(worker_store, monkeypatch):
    from test_worker_offdisk_backup import _content_db
    source = worker_store / 'content_hub.db'
    _content_db(source)
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', worker_store / 'no-manage.db')
    content = backup._backup_now_for_scope(source, worker_store / 'local', '20261018_010101_000001')
    Path(str(content) + '-wal').write_bytes(b'unbound')
    with pytest.raises(ValueError, match='standalone'):
        backup_manifest.read_local(content)


@pytest.mark.parametrize('change', ['extra', 'version', 'bool', 'downgrade', 'schema'])
def test_v2_unsupported_metadata_rejected(worker_store: Path, change):
    _, stage, manifest = _queued(worker_store)
    if change == 'extra':
        manifest['unverified_guarantee'] = True
    elif change == 'version':
        manifest['payload_version'] = 999
    elif change == 'bool':
        manifest['payload_version'] = True
    elif change == 'downgrade':
        manifest['format_version'] = 1
    else:
        manifest['roles']['content']['schema']['schema_version'] = 999
    manifest = backup_manifest.seal(manifest)
    with pytest.raises(ValueError):
        db_backup._normalise_set_manifest(json.dumps(manifest))


def test_v2_forged_schema_identity_rejected_before_publish(worker_store: Path):
    _, stage, manifest = _queued(worker_store)
    schema = manifest['roles']['content']['schema']
    schema.update(status='compatible', database_id='00000000-0000-4000-8000-000000000001', schema_version=1)
    manifest = backup_manifest.seal(manifest)
    root = worker_store / 'server'
    with pytest.raises(db_backup.BackupSetValidationError, match='metadata'):
        db_backup._store_backup_set(root, manifest,
            {role: io.BytesIO((stage / f'{role}.db').read_bytes()) for role in manifest['roles']})
    assert not (root / 'sets' / manifest['set_id']).exists()


def test_old_cache_keys_do_not_reuse_metadata_free_set(worker_store: Path):
    first_id, stage, manifest = _queued(worker_store)
    source = worker_store / 'local' / 'content_hub_20260817_120000_000001.db'
    source_signature = json.loads(worker_backup._source_signature(source, source.with_name('content_trash_20260817_120000_000001.db')))
    source_signature['format_version'] = 1
    source_signature.pop('local_manifest_sha256')
    legacy_roles = {role: {key: info[key] for key in ('size', 'sha256')} for role, info in manifest['roles'].items()}
    with worker_backup._connect() as conn:
        conn.execute('UPDATE worker_backup_outbox SET roles_json=?,status=\'done\' WHERE backup_set_id=?',
                     (backup_manifest.canonical(legacy_roles), first_id))
        conn.execute('UPDATE worker_backup_source_state SET source_signature_json=?',
                     (backup_manifest.canonical(source_signature),))
    second_id = worker_backup.queue_backup_set(source)
    assert second_id != first_id
    second = json.loads((stage.parent / second_id / 'manifest.json').read_text('utf-8'))
    assert second['format_version'] == 2


def test_local_independent_manifest_and_rotation(worker_store: Path, monkeypatch):
    from test_worker_offdisk_backup import _content_db
    source = worker_store / 'content_hub.db'
    _content_db(source)
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', worker_store / 'missing-manage.db')
    monkeypatch.setattr(backup, 'BACKUP_KEEP', 1)
    old = backup._backup_now_for_scope(source, worker_store / 'local', '20261018_010101_000001')
    current = backup._backup_now_for_scope(source, worker_store / 'local', '20261018_010102_000001')
    assert not old.exists() and not backup_manifest.local_path(old).exists()
    manifest = backup_manifest.read_local(current)
    assert manifest['consistency_kind'] == backup_manifest.INDEPENDENT
    assert manifest['captured_at'] is not None
    assert manifest['consistency_roles'] == ['content']
    set_id = worker_backup.queue_backup_set(current)
    stage = worker_backup.OUTBOX_DIR / active_account.slug('artist@example.com') / set_id
    delivered = json.loads((stage / 'manifest.json').read_text('utf-8'))
    assert delivered['captured_at'] == manifest['captured_at']
    assert delivered['roles']['content']['sha256'] != manifest['roles']['content']['sha256']  # secret scrub


def test_local_manifest_tampering_rejected_before_restore_write(worker_store: Path, monkeypatch):
    from test_worker_offdisk_backup import _content_db
    source = worker_store / 'content_hub.db'
    _content_db(source)
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', worker_store / 'missing-manage.db')
    current = backup._backup_now_for_scope(source, worker_store / 'local', '20261018_010101_000001')
    with sqlite3.connect(current) as conn:
        conn.execute("UPDATE generation SET id='tampered'")
    destination = worker_store / 'restored'
    with pytest.raises(ValueError, match='bytes or schema'):
        backup_verify.verify_restore_set(current, destination)
    assert not destination.exists()
    with pytest.raises(ValueError, match='bytes or schema'):
        worker_backup.queue_backup_set(current)


def test_b1_pinned_metadata_retains_pending_pair_and_reconciles(enabled_db, tmp_path, monkeypatch):
    from app import db
    from app.repo import trash
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', tmp_path / 'absent-manage.db')
    def crash(phase):
        if phase == 'D2':
            raise RuntimeError('fixture phase interruption')
    monkeypatch.setattr(trash_transfer, 'checkpoint', crash)
    with pytest.raises(RuntimeError, match='fixture'):
        trash.move_to_trash('g1')
    content = backup._backup_now_for_scope(enabled_db, tmp_path / 'backup', '20261018_010101_000001')
    manifest = backup_manifest.read_local(content)
    assert manifest['consistency_kind'] == backup_manifest.PINNED
    assert manifest['consistency_roles'] == ['content', 'trash']
    assert manifest['roles']['content']['schema']['database_id']
    with closing(sqlite3.connect(content)) as conn:
        assert conn.execute('SELECT COUNT(*) FROM generation_transfer').fetchone()[0] == 1
    restored = tmp_path / 'restored'
    restored.mkdir()
    for role, name in [('content', 'content_hub.db'), ('trash', 'content_hub_trash.db')]:
        original = content if role == 'content' else content.with_name('content_trash_20261018_010101_000001.db')
        backup_verify.create_sqlite_snapshot(original, restored / name)
    monkeypatch.setattr(trash_transfer, 'checkpoint', lambda _: None)
    monkeypatch.setenv('CONTENT_HUB_DB', str(restored / 'content_hub.db'))
    db.init_db()
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM generation_transfer').fetchone()[0] == 0
    assert trash.restore_from_trash('g1')


def test_capture_barrier_blocks_writer_until_reads_are_pinned(enabled_db, tmp_path, monkeypatch):
    real_connect = sqlite3.connect
    observed = []
    class ProbeConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if sql == 'ATTACH DATABASE ? AS side_trash':
                sql = "ATTACH DATABASE '" + str(parameters[0]).replace("'", "''") + "' AS side_trash"
                parameters = ()
            if sql == 'SELECT name FROM side_trash.sqlite_master LIMIT 1':
                with closing(real_connect(enabled_db, isolation_level=None, timeout=0)) as writer:
                    with pytest.raises(sqlite3.OperationalError, match='locked'):
                        writer.execute('BEGIN IMMEDIATE')
                observed.append('barrier_held')
            return super().execute(sql, parameters)

        def backup(self, target, **kwargs):
            if kwargs.get('name') == 'main':
                with closing(real_connect(enabled_db, isolation_level=None, timeout=0)) as writer:
                    trash_transfer.register_connection(writer)
                    writer.execute("INSERT INTO app_setting(key,value) VALUES('after_pin','new')")
                observed.append('barrier_released')
            return super().backup(target, **kwargs)

    def connect(*args, **kwargs):
        kwargs['factory'] = ProbeConnection
        return real_connect(*args, **kwargs)
    monkeypatch.setattr(sqlite3, 'connect', connect)
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', tmp_path / 'no-manage.db')
    content = backup._backup_now_for_scope(enabled_db, tmp_path / 'backup', '20261018_010101_000001')
    assert observed == ['barrier_held', 'barrier_released']
    assert backup_manifest.read_local(content)['consistency_kind'] == backup_manifest.PINNED
    with closing(real_connect(content)) as result:
        assert result.execute("SELECT value FROM app_setting WHERE key='after_pin'").fetchone() is None
