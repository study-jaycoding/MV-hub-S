import importlib
import hashlib
import os
from contextlib import closing
from pathlib import Path
import sqlite3

import pytest

from app import db, db_startup, schema_compat
from app.services import schema_backup


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
    db_startup.init_existing_databases(root, {})
    assert set(probe.database_paths(root, {})) == set(paths)
    result = probe.snapshot(root, tmp_path / 'checkpoint', {}, schema_compat.inspect_database)
    assert len(result) == len(paths)
    assert all(row['status'] == 'compatible' for row in result)
    identities = [schema_compat.inspect_database(path, kind).database_id for kind, path in paths]
    db_startup.init_existing_databases(root, {}, active_path=paths[0][1])
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
        db_startup.init_existing_databases(root, {})
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
        assert snapshots[0].parent == source.parent.parent / 'backups/pre-dev2-baseline'
        assert not snapshots[0].exists()  # Only the verified, renamed file is published.
        assert len(list(snapshots[0].parent.glob('*.db'))) == 1
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
    db_startup.init_existing_databases(root, {})
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


def test_baseline_failed_attempts_keep_first_and_latest_two(tmp_path, monkeypatch):
    source = tmp_path / 'data/db/content_hub.db'
    source.parent.mkdir(parents=True)
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT PRIMARY KEY)')
        conn.execute("INSERT INTO worker VALUES('0')")
        conn.commit()
    def fail(_conn):
        raise RuntimeError('injected migration failure')
    monkeypatch.setattr(db.db_migrations, '_pre_migrate', fail)
    folder = source.parent.parent / 'backups/pre-dev2-baseline'
    folder.mkdir(parents=True)
    unrelated = [folder / 'other.db', folder / '.pending.tmp',
                 folder / 'content_hub.db.pre-dev2-baseline-unrecognized.db']
    for item in unrelated:
        item.write_bytes(b'keep')
    for attempt in range(4):
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('UPDATE worker SET id=?', (str(attempt),))
            conn.commit()
        with pytest.raises(RuntimeError, match='injected'):
            db.init_db(source)
    copies = sorted(p for p in folder.glob('*.db') if p not in unrelated)
    assert len(copies) == 3
    values = []
    for copy in copies:
        with closing(sqlite3.connect(copy)) as conn:
            values.append(conn.execute('SELECT id FROM worker').fetchone()[0])
    assert values == ['0', '2', '3']
    assert all(p.read_bytes() == b'keep' for p in unrelated)


def test_baseline_same_name_databases_keep_separate_first_copies(tmp_path, monkeypatch):
    from app import config

    data = tmp_path / 'backend/data'
    monkeypatch.setattr(config, 'DATA_DIR', data)
    sources = [tmp_path / 'backend/content_hub.db', data / 'db/content_hub.db']
    first = {}
    copies = {source: [] for source in sources}
    for source in sources:
        source.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(source)) as conn:
            conn.execute('CREATE TABLE worker(id TEXT)')
    folder = data / 'backups/pre-dev2-baseline'
    folder.mkdir(parents=True)
    legacy = folder / ('content_hub.db.pre-dev2-baseline-20260101_000000_000000-'
                       + 'a' * 32 + '.db')
    legacy.write_bytes(b'unknown original database')
    for _ in range(4):
        for source in sources:
            copy = schema_backup.backup_before_baseline(source, 'content')
            copies[source].append(copy)
            first.setdefault(source, copy)
    assert len(list(folder.glob('*.db'))) == 7
    assert legacy.read_bytes() == b'unknown original database'
    for source in sources:
        assert first[source].is_file()
        assert first[source].name.endswith('-first.db')
        assert all(schema_compat.database_key(source)[:8] in p.name for p in copies[source])
        assert [p.is_file() for p in copies[source]] == [True, False, True, True]


def test_baseline_cleans_only_old_temporary_files_for_same_database(tmp_path):
    source = tmp_path / 'content_hub.db'
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT)')
    folder = tmp_path / 'backups/pre-dev2-baseline'
    folder.mkdir(parents=True)
    prefix = f'.{source.name}.pre-dev2-baseline-{schema_compat.database_key(source)[:8]}-'
    stamp = schema_backup.datetime.now(schema_backup.timezone.utc).timestamp()
    stale, keep = [], []
    for age, token, group in [(172800, 'a', stale), (0, 'b', keep)]:
        for first in ['', '-first']:
            for suffix in ['', '-journal', '-wal', '-shm']:
                path = folder / (prefix + '20260101_000000_000000-' + token * 32
                                 + first + '.db.tmp' + suffix)
                path.write_bytes(b'private copy')
                os.utime(path, (stamp - age, stamp - age))
                group.append(path)
    for name in [prefix.replace(schema_compat.database_key(source)[:8], 'ffffffff')
                 + '20260101_000000_000000-' + 'a' * 32 + '.db.tmp',
                 prefix + 'unrecognized.db.tmp', '.pending.tmp']:
        path = folder / name
        path.write_bytes(b'keep')
        os.utime(path, (stamp - 172800, stamp - 172800))
        keep.append(path)
    schema_backup.backup_before_baseline(source, 'content')
    assert all(not p.exists() for p in stale)
    assert all(p.is_file() for p in keep)


def test_baseline_first_copy_survives_clock_rollback(tmp_path, monkeypatch):
    source = tmp_path / 'content_hub.db'
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT)')
    times = iter([schema_backup.datetime(2026, 10, day, tzinfo=schema_backup.timezone.utc)
                  for day in [21, 19, 22, 23]])
    class Clock:
        @staticmethod
        def now(_timezone):
            return next(times)
    monkeypatch.setattr(schema_backup, 'datetime', Clock)
    copies = [schema_backup.backup_before_baseline(source, 'content') for _ in range(4)]
    assert [p.is_file() for p in copies] == [True, False, True, True]
    assert copies[0].name.endswith('-first.db')


@pytest.mark.parametrize('failure', ['empty', 'corrupt', 'exception', 'rename'])
def test_baseline_never_publishes_incomplete_copy(tmp_path, monkeypatch, failure):
    from app.services import backup_verify
    source = tmp_path / 'content_hub.db'
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT)')
    before = source.read_bytes()
    folder = tmp_path / 'backups/pre-dev2-baseline'
    original = backup_verify.create_sqlite_snapshot
    def snapshot(path, target, **kwargs):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()
        assert not list(folder.glob('*.db'))
        if failure == 'corrupt':
            target.write_bytes(b'corrupt')
        elif failure == 'exception':
            raise OSError('injected copy failure')
        elif failure == 'rename':
            target.unlink()
            original(path, target, **kwargs)
        return target
    monkeypatch.setattr(backup_verify, 'create_sqlite_snapshot', snapshot)
    if failure == 'rename':
        def fail_rename(self, target):
            raise OSError('injected publish failure')
        monkeypatch.setattr(Path, 'rename', fail_rename)
    with pytest.raises(schema_compat.SchemaCompatibilityError, match='baseline_backup_failed'):
        schema_backup.backup_before_baseline(source, 'content')
    assert source.read_bytes() == before
    assert not list(folder.iterdir())


@pytest.mark.parametrize('layout', ['db', 'db/acct/account'])
def test_baseline_trash_excluded_from_normal_backup_consumers(tmp_path, monkeypatch, layout):
    from app.services import backup, operational_health, worker_backup
    from app.routers import db_backup
    source = tmp_path / layout / 'content_hub_trash.db'
    source.parent.mkdir(parents=True)
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE trashed(id TEXT)')
    copy = schema_backup.backup_before_baseline(source, 'trash')
    folder = tmp_path / 'backups'
    if layout != 'db':
        folder /= 'account'
    monkeypatch.setattr(backup, '_backup_dir', lambda: folder)
    monkeypatch.setattr(backup, 'BACKUP_KEEP', 1)
    monkeypatch.setattr(db_backup, '_acct', lambda _: {'email': 'test'})
    monkeypatch.setattr(db_backup, '_dir', lambda _: folder)
    assert backup.latest_backup_path() is None
    assert backup.list_backups_info() == []
    assert worker_backup.queue_latest_local_backup() is None
    assert operational_health.backup_snapshot() == {
        'set_count': 0, 'latest_age_seconds': None, 'latest_file_count': 0}
    assert db_backup.list_backups(None) == {'backups': []}
    normal = folder / 'content_hub_20261021_010101.db'
    normal.write_bytes(b'normal backup')
    assert backup.latest_backup_path() == normal
    assert [item['file'] for item in backup.list_backups_info()] == [normal.name]
    backup._rotate(folder)
    assert copy.is_file() and normal.is_file()


@pytest.mark.parametrize('override', [False, True])
def test_legacy_location_baseline_uses_data_backups(tmp_path, monkeypatch, override):
    from app import config
    source = tmp_path / 'backend/content_hub.db'
    source.parent.mkdir(parents=True)
    data = tmp_path / 'custom-data' if override else source.parent / 'data'
    monkeypatch.setattr(config, 'DATA_DIR', data)
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT)')
    copy = schema_backup.backup_before_baseline(source, 'content')
    assert copy.parent == data / 'backups/pre-dev2-baseline'
    assert not (source.parent / 'backups').exists()
    destination = data / 'db/content_hub.db'
    monkeypatch.setattr(db, '_LEGACY_DB_PATH', source)
    monkeypatch.setattr(db, 'DEFAULT_DB_PATH', destination)
    db._migrate_db_location(destination)
    assert destination.is_file() and not source.exists()
    assert len(list(copy.parent.glob('*.db'))) == 2


def test_concurrent_baseline_copies_are_private_until_complete(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Event
    from app.services import backup_verify
    source = tmp_path / 'content_hub.db'
    with closing(sqlite3.connect(source)) as conn:
        conn.execute('CREATE TABLE worker(id TEXT)')
    folder = tmp_path / 'backups/pre-dev2-baseline'
    ready, release = Barrier(3), Event()
    original = backup_verify.create_sqlite_snapshot
    def snapshot(path, target, **kwargs):
        result = original(path, target, **kwargs)
        ready.wait(timeout=10)
        assert release.wait(timeout=10)
        return result
    monkeypatch.setattr(backup_verify, 'create_sqlite_snapshot', snapshot)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(schema_backup.backup_before_baseline, source, 'content') for _ in range(2)]
        try:
            ready.wait(timeout=10)
            assert not list(folder.glob('*.db'))
            assert len(list(folder.glob('*.tmp'))) == 2
        finally:
            release.set()
        copies = [future.result(timeout=10) for future in futures]
    assert len(set(copies)) == 2
    assert set(folder.iterdir()) == set(copies)
    for copy in copies:
        assert copy.stat().st_size > 0
        with closing(sqlite3.connect(copy)) as conn:
            assert conn.execute('PRAGMA quick_check').fetchall() == [('ok',)]
