"""Backup metadata is bound to the copied bytes, not a delivery claim."""
import json
import io
import sqlite3
import zipfile
import asyncio
import copy
import shutil
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


# Intentionally independent of the evolving repo schema and the validator's baseline.
_OLD_AGENT_SQL = """
CREATE TABLE agent_chat_conversation (
 id TEXT, engine TEXT, model TEXT, effort TEXT, cli_session_id TEXT, client_id TEXT,
 mcp_entry TEXT, title TEXT, resumable INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE agent_chat_turn (
 id TEXT, conversation_id TEXT, idempotency_key TEXT, status TEXT, text TEXT,
 context TEXT, reason TEXT, created_at TEXT, ended_at TEXT);
CREATE TABLE agent_chat_event (turn_id TEXT, seq INTEGER, kind TEXT, payload TEXT, created_at TEXT);
CREATE TABLE agent_chat_plan_binding (plan_id TEXT, turn_id TEXT, client_id TEXT, created_at TEXT);
"""
_CAPTURE = '2026-11-13T00:00:00+00:00'


def _v3_set(tmp_path, *, local=False):
    from test_worker_offdisk_backup import _content_db, _trash_db
    tmp_path.mkdir(parents=True, exist_ok=True)
    paths = {role: tmp_path / f'{role}.db' for role in ('content', 'trash', 'agent_chat')}
    _content_db(paths['content'], secret=False)
    _trash_db(paths['trash'])
    with closing(sqlite3.connect(paths['agent_chat'])) as conn:
        conn.executescript(_OLD_AGENT_SQL)
    paths['asset_mounts'] = tmp_path / 'asset_mounts.json'
    paths['asset_mounts'].write_bytes(b'{ "mounts": [{"name":"old","path":"missing/folder"}] }\n')
    roles = {}
    for role, path in paths.items():
        info = backup_manifest.role_info(path, role) if role in ('content', 'trash') else {
            'size': path.stat().st_size, 'sha256': backup_manifest.file_digest(path)}
        roles[role] = {'state': 'present', 'captured_at': _CAPTURE, **info}
    if local:
        roles['manage'] = {'state': 'absent', 'captured_at': _CAPTURE}
    manifest = {
        'format': backup_manifest.LOCAL_FORMAT if local else backup_manifest.WORKER_FORMAT,
        'format_version': 3, 'payload_version': 1,
        'account_scope_digest': backup_manifest.account_digest('fixture-account'),
        'captured_at': _CAPTURE, 'consistency_kind': backup_manifest.INDEPENDENT,
        'consistency_roles': sorted(paths), 'roles': roles,
    }
    if not local:
        manifest.update(created_at=_CAPTURE, local_stamp='20261113_000000', schema_version=0,
                        app_version='fixture', device={}, parent_backup_set_id=None,
                        summary={key: 0 for key in db_backup._SUMMARY_KEYS})
    return backup_manifest.seal(manifest), paths


def _refresh_v3_member(manifest, paths, role):
    path = paths[role]
    manifest['roles'][role].update(size=path.stat().st_size, sha256=backup_manifest.file_digest(path))
    return backup_manifest.seal(manifest)


@pytest.mark.parametrize('local', [False, True])
def test_v3_valid_original_bytes_and_independent_times_are_readonly(tmp_path, local):
    manifest, paths = _v3_set(tmp_path, local=local)
    manifest['roles']['agent_chat']['captured_at'] = '2026-11-12T23:59:59+00:00'
    manifest = backup_manifest.seal(manifest)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    backup_manifest.verify_files_v3(manifest, paths, local=local,
                                   expected_account_digest=manifest['account_scope_digest'])
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before
    assert paths['asset_mounts'].read_bytes().startswith(b'{ "mounts"')


def test_v3_absent_is_explicit_and_paths_match_present_roles(tmp_path):
    manifest, paths = _v3_set(tmp_path)
    for role in ('trash', 'agent_chat', 'asset_mounts'):
        manifest['roles'][role] = {'state': 'absent', 'captured_at': _CAPTURE}
    manifest['consistency_roles'] = ['content']
    manifest = backup_manifest.seal(manifest)
    backup_manifest.verify_files_v3(manifest, {'content': paths['content']})
    with pytest.raises(ValueError, match='files differ'):
        backup_manifest.verify_files_v3(manifest, paths)


def test_v3_local_manage_snapshot_is_independent(tmp_path):
    value, paths = _v3_set(tmp_path, local=True)
    paths['manage'] = tmp_path / 'manage.db'
    with closing(sqlite3.connect(paths['manage'])) as conn:
        conn.execute('CREATE TABLE team_generation_fact(id TEXT)')
    value['roles']['manage'] = {
        'state': 'present', 'captured_at': '2026-11-12T23:59:58+00:00',
        **backup_manifest.role_info(paths['manage'], 'manage'),
    }
    value['consistency_roles'] = sorted(paths)
    backup_manifest.verify_files_v3(backup_manifest.seal(value), paths, local=True)
    with pytest.raises(ValueError):
        backup_manifest.validate_v3(backup_manifest.seal(value))


@pytest.mark.parametrize('change', [
    'extra', 'missing_role', 'unknown_role', 'version', 'bool_version', 'bool_payload',
    'payload', 'bool_size', 'zero_size', 'hash', 'state', 'absent_field', 'content_absent',
    'null_time', 'naive_time', 'bad_time', 'long_time', 'root_time', 'coverage',
    'unknown_consistency', 'pinned_absent', 'pinned_time', 'schema_extra', 'agent_schema',
])
def test_v3_rejects_invalid_metadata(tmp_path, change):
    value, _ = _v3_set(tmp_path)
    role = value['roles']['agent_chat']
    if change == 'extra': value['extra'] = True
    elif change == 'missing_role': value['roles'].pop('agent_chat')
    elif change == 'unknown_role': value['roles']['unknown'] = copy.deepcopy(role)
    elif change == 'version': value['format_version'] = 4
    elif change == 'bool_version': value['format_version'] = True
    elif change == 'bool_payload': value['payload_version'] = True
    elif change == 'payload': value['payload_version'] = 2
    elif change == 'bool_size': role['size'] = True
    elif change == 'zero_size': role['size'] = 0
    elif change == 'hash': role['sha256'] = 'bad'
    elif change == 'state': role['state'] = 'missing'
    elif change == 'absent_field': role.update(state='absent')
    elif change == 'content_absent': value['roles']['content'] = {'state': 'absent', 'captured_at': _CAPTURE}
    elif change == 'null_time': role['captured_at'] = None
    elif change == 'naive_time': role['captured_at'] = '2026-11-13T00:00:00'
    elif change == 'bad_time': role['captured_at'] = 'not-a-time'
    elif change == 'long_time': role['captured_at'] = '0' * 65
    elif change == 'root_time': value['captured_at'] = '2026-11-14T00:00:00+00:00'
    elif change == 'coverage': value['consistency_roles'] = ['content']
    elif change == 'unknown_consistency': value['consistency_kind'] = backup_manifest.UNKNOWN
    elif change == 'pinned_absent':
        value.update(consistency_kind=backup_manifest.PINNED, consistency_roles=['content', 'trash'])
        value['roles']['trash'] = {'state': 'absent', 'captured_at': _CAPTURE}
    elif change == 'pinned_time':
        value.update(consistency_kind=backup_manifest.PINNED, consistency_roles=['content', 'trash'])
        value['roles']['trash']['captured_at'] = '2026-11-14T00:00:00+00:00'
    elif change == 'schema_extra': value['roles']['content']['schema']['extra'] = 1
    else: role['schema'] = {}
    with pytest.raises(ValueError):
        backup_manifest.validate_v3(backup_manifest.seal(value))


@pytest.mark.parametrize('change', ['seal', 'account', 'bytes', 'missing', 'extra_path', 'schema'])
def test_v3_verifies_bound_files(tmp_path, change):
    value, paths = _v3_set(tmp_path)
    kwargs = {}
    if change == 'seal': value['roles']['agent_chat']['size'] += 1
    elif change == 'account': kwargs['expected_account_digest'] = '0' * 64
    elif change == 'bytes': paths['asset_mounts'].write_bytes(b'{"mounts":[]}')
    elif change == 'missing': paths.pop('agent_chat')
    elif change == 'extra_path': paths['unexpected'] = paths['content']
    else:
        value['roles']['content']['schema'].update(status='compatible', database_id='fixture', schema_version=1)
        value = backup_manifest.seal(value)
    with pytest.raises(ValueError):
        backup_manifest.verify_files_v3(value, paths, **kwargs)


@pytest.mark.parametrize('raw', [
    b'\xef\xbb\xbf{"mounts":[]}', b'\xff', b'{', b'{"mounts":[],"mounts":[]}',
    b'{"mounts":[{"name":"a","name":"b","path":"x"}]}',
    b'{"mounts":NaN}', b'{"mounts":Infinity}', b'{"mounts":-Infinity}', b'{"mounts":1e400}',
    b'[]', b'{"mounts":[],"extra":1}', b'{"mounts":{}}', b'{"mounts":[null]}',
    b'{"mounts":[{"name":" ","path":"x"}]}', b'{"mounts":[{"name":"a","path":" "}]}',
    b'{"mounts":[{"name":"a","path":"x","owner":1}]}',
    b'{"mounts":[{"name":"a","path":"x","extra":"x"}]}',
])
def test_v3_rejects_invalid_original_json(tmp_path, raw):
    value, paths = _v3_set(tmp_path)
    paths['asset_mounts'].write_bytes(raw)
    value = _refresh_v3_member(value, paths, 'asset_mounts')
    with pytest.raises(ValueError):
        backup_manifest.verify_files_v3(value, paths)


def test_v3_legacy_mount_owners_and_duplicate_names_are_allowed(tmp_path):
    value, paths = _v3_set(tmp_path)
    paths['asset_mounts'].write_bytes(b'{"mounts":[{"name":"a","path":"x"},{"name":"a","path":"y","owner":""}]}')
    backup_manifest.verify_files_v3(_refresh_v3_member(value, paths, 'asset_mounts'), paths)


@pytest.mark.parametrize('stage', ['decode', 'canonical'])
def test_v3_strict_json_reports_recursion_failure_as_invalid(monkeypatch, stage):
    def too_deep(*args, **kwargs):
        raise RecursionError('JSON nesting')
    if stage == 'decode':
        monkeypatch.setattr(backup_manifest.json, 'loads', too_deep)
    else:
        monkeypatch.setattr(backup_manifest, 'canonical', too_deep)
    with pytest.raises(ValueError, match='nesting'):
        backup_manifest.read_json_v3(b'{}')


def test_v3_json_read_is_bounded_even_if_stat_is_stale(tmp_path, monkeypatch):
    value, paths = _v3_set(tmp_path)
    original_open = Path.open
    reads = []
    class GrowingFile(io.BytesIO):
        def read(self, size=-1):
            reads.append(size)
            assert size == 1024 * 1024 + 1
            return super().read(size)
    def open_path(path, *args, **kwargs):
        if path == paths['asset_mounts']:
            return GrowingFile(b' ' * (1024 * 1024 + 10))
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', open_path)
    with pytest.raises(ValueError, match='too large'):
        backup_manifest.verify_files_v3(value, paths)
    assert reads == [1024 * 1024 + 1]


@pytest.mark.parametrize('change', ['table', 'column', 'view', 'version', 'other', 'wal', 'journal', 'corrupt'])
def test_v3_agent_fixed_baseline_and_standalone_required(tmp_path, change):
    value, paths = _v3_set(tmp_path)
    path = paths['agent_chat']
    if change in ('wal', 'journal'):
        Path(str(path) + ('-wal' if change == 'wal' else '-journal')).write_bytes(b'not-standalone')
    elif change == 'corrupt': path.write_bytes(b'not sqlite')
    else:
        with closing(sqlite3.connect(path)) as conn:
            if change == 'table': conn.execute('DROP TABLE agent_chat_event')
            elif change == 'column': conn.execute('ALTER TABLE agent_chat_event DROP COLUMN payload')
            elif change == 'view':
                conn.execute('ALTER TABLE agent_chat_event RENAME TO real_event')
                conn.execute('CREATE VIEW agent_chat_event AS SELECT * FROM real_event')
            elif change == 'version': conn.execute('PRAGMA user_version=1')
            else:
                for table in ('agent_chat_conversation', 'agent_chat_turn', 'agent_chat_event', 'agent_chat_plan_binding'):
                    conn.execute(f'DROP TABLE {table}')
                conn.execute('CREATE TABLE unrelated(id TEXT)')
            conn.commit()
    value = _refresh_v3_member(value, paths, 'agent_chat')
    with pytest.raises((ValueError, sqlite3.Error)):
        backup_manifest.verify_files_v3(value, paths)


def test_v3_agent_old_and_current_schema_supported_without_source_changes(tmp_path):
    from app.repo import agent_chat
    value, paths = _v3_set(tmp_path)
    with closing(sqlite3.connect(':memory:')) as current:
        current.executescript(agent_chat._SCHEMA)
        for table, columns in backup_manifest._AGENT_BASELINE.items():
            assert columns <= {row[1] for row in current.execute(f'PRAGMA table_info({table})')}
    old = paths['agent_chat'].read_bytes()
    backup_manifest.verify_files_v3(value, paths)
    assert paths['agent_chat'].read_bytes() == old
    paths['agent_chat'] = agent_chat.open_db(tmp_path / 'current-agent.db')
    with closing(sqlite3.connect(paths['agent_chat'])) as conn:
        conn.execute('CREATE TABLE future_extra(id TEXT)')
        conn.execute('ALTER TABLE agent_chat_event ADD COLUMN extra TEXT')
        conn.commit()
    value = _refresh_v3_member(value, paths, 'agent_chat')
    before = paths['agent_chat'].read_bytes()
    backup_manifest.verify_files_v3(value, paths)
    assert paths['agent_chat'].read_bytes() == before


def test_v3_pinned_requires_actual_b1_guards(tmp_path):
    value, paths = _v3_set(tmp_path)
    value.update(consistency_kind=backup_manifest.PINNED, consistency_roles=['content', 'trash'])
    with pytest.raises(ValueError, match='not a B1 pair'):
        backup_manifest.verify_files_v3(backup_manifest.seal(value), paths)


def test_v3_pinned_pair_remains_verified(enabled_db, tmp_path, monkeypatch):
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', tmp_path / 'no-manage.db')
    content = backup._backup_now_for_scope(enabled_db, tmp_path / 'pinned', '20261113_000000_000001')
    old = backup_manifest.read_local(content)
    value, paths = _v3_set(tmp_path / 'fixture')
    unrelated_trash = paths['trash']
    for role, path in [('content', content), ('trash', content.with_name('content_trash_20261113_000000_000001.db'))]:
        paths[role] = path
        value['roles'][role] = {'state': 'present', 'captured_at': old['captured_at'], **old['roles'][role]}
    value.update(captured_at=old['captured_at'], consistency_kind=backup_manifest.PINNED,
                 consistency_roles=['content', 'trash'])
    backup_manifest.verify_files_v3(backup_manifest.seal(value), paths)
    paths['trash'] = unrelated_trash
    value['roles']['trash'].update(backup_manifest.role_info(unrelated_trash, 'trash'))
    with pytest.raises(ValueError, match='pair invalid'):
        backup_manifest.verify_files_v3(backup_manifest.seal(value), paths)
    paths.pop('trash')
    with pytest.raises(ValueError, match='files differ'):
        backup_manifest.verify_files_v3(backup_manifest.seal(value), paths)


def test_v3_remains_rejected_by_unmigrated_consumers(worker_store, monkeypatch):
    assert backup_manifest.VERSION == worker_backup._FORMAT_VERSION == 2
    value, paths = _v3_set(worker_store / 'v3')
    backup_manifest.verify_files_v3(value, paths)
    with pytest.raises(ValueError, match='version'):
        backup_manifest.check_version(value)
    assert db_backup._normalise_set_manifest(json.dumps(value)) == value
    local, _ = _v3_set(worker_store / 'local-v3', local=True)
    local_content = worker_store / 'local-v3' / 'content.db'
    backup_manifest.local_path(local_content).write_text(backup_manifest.canonical(local), encoding='utf-8')
    with pytest.raises(ValueError, match='version'):
        backup_manifest.read_local(local_content)
    for members in ({'content', 'trash'}, set(paths)):
        label = 'partial' if len(members) == 2 else 'complete'
        archive = worker_store / f'v3-{label}.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('manifest.json', backup_manifest.canonical(value))
            for role in members:
                bundle.write(paths[role], f'{role}.json' if role == 'asset_mounts' else f'{role}.db')
        destination = worker_store / f'restore-v3-{label}'
        with pytest.raises(HTTPException) as error:
            db_transfer._extract_backup_set(archive, destination)
        assert error.value.status_code == 400
        assert not list(destination.iterdir())
    account_slug = active_account.slug('artist@example.com')
    value['account_scope_digest'] = worker_backup.account_key_digest(account_slug)
    value = backup_manifest.seal(value)
    backup_manifest.verify_files_v3(value, paths, expected_account_digest=value['account_scope_digest'])
    stage = worker_backup._stage_dir(account_slug, value['backup_set_id'])
    stage.mkdir(parents=True)
    for role, path in paths.items():
        shutil.copyfile(path, stage / (f'{role}.json' if role == 'asset_mounts' else f'{role}.db'))
    (stage / 'manifest.json').write_text(backup_manifest.canonical(value), encoding='utf-8')
    queued_roles = {key: value[key] for key in ('format_version', 'roles', 'consistency_kind', 'consistency_roles')}
    with closing(worker_backup._connect()) as conn, conn:
        conn.execute('INSERT INTO worker_backup_outbox(backup_set_id,account_slug,created_at,local_stamp,roles_json) '
                     'VALUES(?,?,?,?,?)', (value['backup_set_id'], account_slug, value['created_at'],
                                           value['local_stamp'], backup_manifest.canonical(queued_roles)))
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **kw: pytest.fail('v3 must not upload'))
    assert worker_backup.drain_one() == {'state': 'failed', 'error_code': 'staging_invalid'}
    assert stage.exists()
