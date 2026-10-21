import importlib
import hashlib
import os
from contextlib import closing
from pathlib import Path
import sqlite3

import pytest

from app import db, schema_compat


@pytest.fixture
def probe(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'tools'))
    return importlib.import_module('install_db_probe')


def test_checkpoint_uses_private_copies_and_preserves_original_set(probe, tmp_path):
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    before = probe.file_set([('content', path)])
    result = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert probe.file_set([('content', path)]) == before
    assert result[0]['status'] == 'compatible'
    assert result[0]['key'] == hashlib.sha256(os.path.normcase(str(path.resolve())).encode('utf-8')).hexdigest()
    assert result[0]['database_id'] == schema_compat.inspect_database(path, 'content').database_id
    assert 'install' not in str(result) and str(path) not in str(result)
    checkpoint = tmp_path / 'checkpoint' / result[0]['checkpoint']
    assert probe.file_digest(checkpoint) == result[0]['sha256']


def test_actual_content_v2_checkpoint_blocks_v1_program_rollback(probe, tmp_path):
    from app.services.install_journal import rollback_decision
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    rows = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert rows[0]['schema_version'] == 2
    assert 'content_share_commands' in rows[0]['components']
    record = {'db_mutation_possible': True, 'checkpoints': rows}
    previous = {'db_schema': {'read_min': 1, 'read_max': 1, 'write_min': 1, 'write_max': 1},
                'reader_protocol': 1, 'writer_protocol': 2,
                'supported_components': list(rows[0]['components'])}
    assert rollback_decision(record, rows, previous) == 'recovery_required'
    previous['db_schema'].update(read_max=2, write_max=2)
    previous['supported_components'].remove('content_share_commands')
    assert rollback_decision(record, rows, previous) == 'recovery_required'
    previous['supported_components'].append('content_share_commands')
    assert rollback_decision(record, rows, previous) == 'program_only'


def test_parent_explicit_db_and_all_account_databases_are_included(probe, tmp_path):
    data = tmp_path / 'data'
    names = ['db/content_hub.db', 'db/acct/a/content_hub.db', 'db/acct/a/content_hub_trash.db', 'db/manage_hub.db']
    for name in names:
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture discovery only')
    explicit = tmp_path / 'explicit.db'
    explicit.write_bytes(b'fixture')
    rows = probe.database_paths(tmp_path, {'CONTENT_HUB_DATA': str(data), 'CONTENT_HUB_DB': str(explicit)})
    assert {path for _, path in rows} == {data / n for n in names} | {explicit}


def test_changing_source_after_copy_aborts_checkpoint(probe, tmp_path):
    root = tmp_path / 'install'
    path = root / 'backend/data/db/content_hub.db'
    path.parent.mkdir(parents=True)
    db.init_db(path)
    from app.services.backup_verify import create_database_set_snapshot
    def mutate(sources, targets):
        create_database_set_snapshot(sources, targets)
        with path.open('ab') as stream:
            stream.write(b'fixture mutation')
    with pytest.raises(ValueError, match='changed_while'):
        probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database, snapshotter=mutate)


def test_relative_or_network_db_override_is_refused_before_copy(probe, tmp_path):
    for override in ['relative.db', r'\\fixture-server\share\content.db']:
        with pytest.raises(ValueError, match='local_absolute'):
            probe.database_paths(tmp_path, {'CONTENT_HUB_DB': override})


def legacy_install(root, monkeypatch):
    from app import manage_db
    from app.repo import trash

    data = root / 'backend/data'
    content = [data / 'db/content_hub.db', data / 'db/acct/unopened/content_hub.db',
               root / 'backend/content_hub.db']
    paths = []
    for path in content:
        db.init_db(path)
        paths.append(('content', path))
        trash_path = path.with_name('content_hub_trash.db')
        with closing(sqlite3.connect(':memory:', isolation_level=None)) as conn:
            conn.execute('ATTACH DATABASE ? AS trash', (str(trash_path),))
            trash._ensure_trash_schema(conn)
        paths.append(('trash', trash_path))
    manage = data / 'db/manage_hub.db'
    monkeypatch.setattr(manage_db, 'MANAGE_DB_PATH', manage)
    manage_db.init_manage_db()
    paths.append(('manage', manage))
    for _, path in paths:
        with closing(sqlite3.connect(path, isolation_level=None)) as conn:
            conn.execute('DROP TABLE schema_migrations')
            conn.execute('DROP TABLE schema_meta')
            conn.execute('PRAGMA user_version=0')
    return paths


def test_startup_prepares_entire_probe_set(probe, tmp_path, monkeypatch):
    root = tmp_path / 'install'
    paths = legacy_install(root, monkeypatch)
    assert all(schema_compat.inspect_database(path, kind).status == 'unversioned' for kind, path in paths)
    db.init_existing_databases(root, {})
    assert set(probe.database_paths(root, {})) == set(paths)
    result = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert len(result) == len(paths)
    assert all(row['status'] == 'compatible' for row in result)
    identities = [schema_compat.inspect_database(path, kind).database_id for kind, path in paths]
    db.init_existing_databases(root, {}, active_path=paths[0][1])
    assert [schema_compat.inspect_database(path, kind).database_id for kind, path in paths] == identities


@pytest.mark.parametrize('failure', ['locked', 'corrupt'])
@pytest.mark.parametrize('kind', ['content', 'trash', 'manage'])
def test_startup_skips_failed_database_and_prepares_rest(tmp_path, monkeypatch, caplog, failure, kind):
    root = tmp_path / 'install'
    paths = legacy_install(root, monkeypatch)
    failed = next(path for role, path in paths if role == kind)
    with closing(sqlite3.connect(failed, isolation_level=None)) as lock:
        if failure == 'locked':
            lock.execute('BEGIN IMMEDIATE')
        else:
            lock.close()
            failed.write_bytes(b'not a sqlite database')
        db.init_existing_databases(root, {})
    assert all(schema_compat.inspect_database(path, kind).status == 'compatible'
               for kind, path in paths if path != failed)
    expected_key = hashlib.sha256(os.path.normcase(str(failed.resolve())).encode('utf-8')).hexdigest()
    warnings = [record.message for record in caplog.records if 'database_prepare_failed' in record.message]
    assert len(warnings) == 1
    assert f'kind={kind} key={expected_key} error=' in warnings[0]
    assert str(failed) not in caplog.text and 'unopened' not in caplog.text
    if failure == 'locked':
        assert schema_compat.inspect_database(failed, kind).status == 'unversioned'


@pytest.mark.parametrize('kind', ['content', 'trash', 'manage'])
@pytest.mark.parametrize('fail_copy', [False, 'copy', 'verify'])
def test_baseline_snapshot_precedes_first_write(tmp_path, monkeypatch, kind, fail_copy):
    from app import manage_db
    from app.repo import trash
    from app.services import backup_verify

    initialize = {'content': db.init_db, 'trash': trash.init_trash_db,
                  'manage': manage_db.init_manage_db}[kind]
    source = tmp_path / 'data/db' / (kind + '.db')
    source.parent.mkdir(parents=True)
    if kind == 'trash':
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('CREATE TABLE trashed(id TEXT PRIMARY KEY, trashed_at TEXT NOT NULL, '
                         'project_id TEXT, creator_uid TEXT, status TEXT, prompt TEXT, '
                         'source_name TEXT, payload TEXT NOT NULL)')
    else:
        initialize(source)
        with closing(sqlite3.connect(source, isolation_level=None)) as conn:
            conn.execute('DROP TABLE schema_migrations')
            conn.execute('DROP TABLE schema_meta')
            conn.execute('PRAGMA user_version=0')
    if kind == 'content':
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('DROP TABLE gen_request')
    before = source.read_bytes()
    snapshots = []
    original = backup_verify.create_sqlite_snapshot

    def snapshot(path, target, **kwargs):
        assert path == source
        assert source.read_bytes() == before
        if fail_copy == 'copy':
            raise OSError('injected disk failure: private source path')
        result = original(path, target, **kwargs)
        assert source.read_bytes() == before
        if fail_copy == 'verify':
            target.write_bytes(b'corrupted backup fixture')
            return result
        assert schema_compat.inspect_database(target, kind).status == 'unversioned'
        with closing(sqlite3.connect(target)) as conn:
            assert conn.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        snapshots.append(target)
        return result

    monkeypatch.setattr(backup_verify, 'create_sqlite_snapshot', snapshot)
    if fail_copy:
        with pytest.raises(schema_compat.SchemaCompatibilityError, match='baseline_backup_failed'):
            initialize(source)
        assert source.read_bytes() == before
        assert schema_compat.inspect_database(source, kind).status == 'unversioned'
    else:
        initialize(source)
        assert len(snapshots) == 1
        assert snapshots[0].parent == source.parent.parent / 'backups'
        assert source.name in snapshots[0].name and 'pre-dev2-baseline' in snapshots[0].name
        assert schema_compat.inspect_database(source, kind).status == 'compatible'
        initialize(source)
        assert len(snapshots) == 1


def test_baseline_snapshot_failure_skips_only_other_account(tmp_path, monkeypatch, caplog):
    from app.services import backup_verify

    root = tmp_path / 'install'
    paths = legacy_install(root, monkeypatch)
    failed = next(path for kind, path in paths if kind == 'content' and path.parent.name == 'unopened')
    before = failed.read_bytes()
    original = backup_verify.create_sqlite_snapshot

    def snapshot(source, target, **kwargs):
        if source == failed:
            raise OSError('private account path must not be logged')
        return original(source, target, **kwargs)

    monkeypatch.setattr(backup_verify, 'create_sqlite_snapshot', snapshot)
    db.init_existing_databases(root, {})
    assert failed.read_bytes() == before
    assert schema_compat.inspect_database(failed, 'content').status == 'unversioned'
    assert all(schema_compat.inspect_database(path, kind).status == 'compatible'
               for kind, path in paths if path != failed)
    assert 'baseline_backup_failed' in caplog.text and 'database_prepare_failed' in caplog.text
    assert str(failed) not in caplog.text and 'private account' not in caplog.text


def test_baseline_snapshot_lock_failure_preserves_source(tmp_path):
    source = tmp_path / 'locked.db'
    with closing(sqlite3.connect(source, isolation_level=None)) as lock:
        lock.execute('CREATE TABLE worker(id TEXT PRIMARY KEY)')
        before = source.read_bytes()
        lock.execute('BEGIN EXCLUSIVE')
        with pytest.raises(schema_compat.SchemaCompatibilityError, match='baseline_backup_failed'):
            db.init_db(source)
        assert source.read_bytes() == before
        lock.rollback()
    assert schema_compat.inspect_database(source, 'content').status == 'unversioned'
