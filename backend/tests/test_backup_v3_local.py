"""Explicit synthetic v3 capture; production capture and delivery remain version 2."""
from __future__ import annotations

import json
import importlib.util
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import sqlite3
from pathlib import Path
from contextlib import closing, contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import active_account, config, db
from app.services import agent_chat, asset_mounts, auth, backup, backup_manifest, backup_verify
from test_backup_manifest_contract import _OLD_AGENT_SQL
from test_trash_transfer import enabled_db


@pytest.fixture
def local(tmp_path, monkeypatch):
    source = tmp_path / "content.db"
    with closing(sqlite3.connect(source)) as conn, conn:
        conn.executescript("CREATE TABLE generation(id TEXT PRIMARY KEY); INSERT INTO generation VALUES('g1');"
                           "CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT);")
    monkeypatch.setenv("CONTENT_HUB_DB", str(source))
    monkeypatch.setattr(backup, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent-history")
    monkeypatch.setattr(backup, "MANAGE_DB_PATH", tmp_path / "no-manage.db")
    monkeypatch.setattr(backup, "CAPTURE_VERSION", 3, raising=False)
    monkeypatch.setattr(backup, "_AGENT_PATH_CACHE", {}, raising=False)
    monkeypatch.delenv("CONTENT_HUB_AUTH_SECRET", raising=False)
    with active_account.pinned_account_scope(("artist@example.invalid", "artist")):
        yield source, tmp_path / "backups", tmp_path


def test_explicit_v3_capture_records_absent_extra_roles(local):
    source, directory, base = local
    content = backup._backup_now_for_scope(source, directory, "20261113_010101_000001")
    manifest = json.loads(backup_manifest.local_path(content).read_text("utf-8"))
    assert manifest["format_version"] == 3
    assert set(manifest["roles"]) == {"content", "trash", "manage", "agent_chat", "asset_mounts"}
    assert manifest["roles"]["agent_chat"]["state"] == "absent"
    assert manifest["roles"]["asset_mounts"]["state"] == "absent"
    assert backup_manifest.VERSION == 2


def test_capture_missing_source_is_noop(local):
    missing = local[2] / 'not-created.db'
    errors = dict(backup._LAST_ERROR)
    assert backup._backup_now_for_scope(missing, local[1]) is None
    assert not missing.exists()
    assert not local[1].exists()
    assert backup._LAST_ERROR == errors


@pytest.mark.parametrize('env_secret', [None, ' synthetic-env '])
def test_capture_agent_path_matches_product_identity(local, monkeypatch, env_secret):
    from app.routers import agent_chat as chat_router
    source = local[0]
    with closing(sqlite3.connect(source)) as conn, conn:
        conn.execute("INSERT INTO app_setting VALUES('auth_secret','synthetic-db')")
    if env_secret is not None:
        monkeypatch.setenv('CONTENT_HUB_AUTH_SECRET', env_secret)
    monkeypatch.setattr(auth, '_secret_cache', None)

    @contextmanager
    def connection():
        with closing(sqlite3.connect(source)) as conn:
            conn.row_factory = sqlite3.Row
            yield conn

    monkeypatch.setattr(auth, 'get_connection', connection)
    ctx = SimpleNamespace(hub=auth.hub_id(), path=db.get_db_path().resolve(),
                          account={'email': ' Artist@Example.Invalid '})
    expected = chat_router._identity(ctx).file_path()
    assert backup._agent_path(source, source, active_account.account_key(),
                              immutable=False, secret=env_secret) == expected
    assert not expected.exists()


def extras(local):
    source, _, _ = local
    with closing(sqlite3.connect(source)) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO app_setting VALUES('auth_secret','synthetic-only')")
    identity = agent_chat.Identity(auth.hub_id_for("synthetic-only", source), str(source), active_account.account_key())
    agent = identity.file_path()
    agent.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(agent)) as conn:
        conn.executescript(_OLD_AGENT_SQL)
    mounts = asset_mounts.mounts_file()
    mounts.parent.mkdir(parents=True, exist_ok=True)
    mounts.write_bytes(b'{ "mounts": [{"name":"old","path":"missing/folder"}] }\n')
    return agent, mounts


def capture(local, stamp="20261113_010101_000002"):
    return backup._backup_now_for_scope(local[0], local[1], stamp)


def test_capture_present_original_bytes_and_independent_times(local, monkeypatch):
    agent, mounts = extras(local)
    monkeypatch.setattr(auth, "get_secret", lambda: pytest.fail("must not create secret"))
    monkeypatch.setattr(agent_chat.Identity, "db_file", lambda self: pytest.fail("must not migrate Agent"))
    before = {p: p.read_bytes() for p in (local[0], agent, mounts)}
    content = capture(local)
    manifest = backup_manifest.read_local(content, allow_v3=True)
    paths = backup_manifest.local_paths(content, manifest, check_present=True)
    assert set(paths) == {"content", "agent_chat", "asset_mounts"}
    assert paths["asset_mounts"].read_bytes() == before[mounts]
    assert manifest["consistency_roles"] == sorted(paths)
    assert all(info["captured_at"] for info in manifest["roles"].values())
    assert {p: p.read_bytes() for p in before} == before


@pytest.mark.parametrize("fault", ["json", "agent_directory", "agent_corrupt", "agent_permission", "json_permission"])
def test_capture_failure_preserves_good_set_and_never_rotates(local, monkeypatch, fault):
    agent, mounts = extras(local)
    good = capture(local)
    before = {p.name: p.read_bytes() for p in good.parent.iterdir()}
    if fault == "json":
        mounts.write_bytes(b'{"mounts":[],"mounts":[]}')
    elif fault == "agent_directory":
        agent.unlink()
        agent.mkdir()
    elif fault == "agent_corrupt":
        agent.write_bytes(b"not sqlite")
    else:
        original = Path.stat
        def denied(path, *a, **kw):
            if path == (agent if fault == "agent_permission" else mounts):
                raise PermissionError("synthetic")
            return original(path, *a, **kw)
        monkeypatch.setattr(Path, "stat", denied)
    rotate = Mock()
    monkeypatch.setattr(backup, "_rotate", rotate)
    with pytest.raises(Exception):
        capture(local, "20261113_010102_000002")
    rotate.assert_not_called()
    assert {p.name: p.read_bytes() for p in good.parent.iterdir()} == before
    assert backup._LAST_ERROR[str(local[1])]["code"] in {"agent_chat_unreadable", "asset_mounts_invalid"}


def test_scope_environment_change_refuses_publication(local, monkeypatch):
    extras(local)
    verify = backup_manifest.verify_files_v3
    def changed(*args, **kwargs):
        verify(*args, **kwargs)
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "new-synthetic")
    monkeypatch.setattr(backup_manifest, "verify_files_v3", changed)
    with pytest.raises(Exception):
        capture(local)
    assert not list(local[1].glob("content_hub_*.db"))


def test_scope_poll_discovers_new_agent_and_retries_failed_initial_read(local, monkeypatch):
    first = backup._db_change_signature(local[0])
    agent, mounts = extras(local)
    capture(local)
    changed = backup._db_change_signature(local[0])
    assert changed != first
    assert {x[0] for x in changed} >= {"agent_chat", "asset_mounts"}
    backup._AGENT_PATH_CACHE.clear()
    original = sqlite3.connect
    with monkeypatch.context() as patch:
        patch.setattr(sqlite3, "connect", Mock(side_effect=sqlite3.OperationalError("locked")))
        backup._db_change_signature(local[0])
        assert not backup._AGENT_PATH_CACHE
    assert sqlite3.connect is original
    backup._db_change_signature(local[0])
    assert backup._AGENT_PATH_CACHE


def test_consumers_list_size_delete_resume_and_absent_residue(local, monkeypatch):
    extras(local)
    content = capture(local)
    manifest = backup_manifest.read_local(content, allow_v3=True)
    paths = backup_manifest.local_paths(content, manifest)
    monkeypatch.setattr(backup, '_backup_dir', lambda: local[1])
    assert backup.latest_backup_path() == content
    info = backup.list_backups_info(local[1])[0]
    assert set(info["files"]) == {p.name for p in paths.values()} | {backup_manifest.local_path(content).name}
    assert info["size"] == sum(p.stat().st_size for p in paths.values()) + backup_manifest.local_path(content).stat().st_size
    stray = local[1] / ("manage_hub_" + backup._stamp_of(content) + ".db")
    stray.write_bytes(b"unexpected")
    assert backup.list_backups_info(local[1]) == []
    stray.unlink()
    keep, _ = backup._read_keep(content)
    backup._write_keep(content, {**keep, "deleting": True})
    content.unlink()
    assert backup._resume_deletions(local[1]) == 0
    assert not any(p.exists() for p in paths.values())
    assert not backup._keep_path(content).exists()


def test_compatibility_v2_does_not_inspect_extra_sources(local, monkeypatch):
    monkeypatch.setattr(backup, "CAPTURE_VERSION", 2)
    monkeypatch.setattr(asset_mounts, "mounts_file", lambda *a: pytest.fail("v2 extra source"))
    content = capture(local)
    assert backup_manifest.read_local(content)["format_version"] == 2
    assert {x[0] for x in backup._db_change_signature(local[0])} == {"content"}
    assert not backup._AGENT_PATH_CACHE


def test_compatibility_default_capture_stays_v2():
    assert backup.CAPTURE_VERSION == 2


def test_compatibility_v3_local_is_rejected_by_existing_worker(local, monkeypatch):
    from app.services import worker_backup
    extras(local)
    content = capture(local)
    monkeypatch.setattr(worker_backup, "OUTBOX_DIR", local[2] / "outbox")
    monkeypatch.setattr(worker_backup, "STATE_DB", local[2] / "delivery.db")
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", lambda *a, **k: pytest.fail("must not send"))
    with pytest.raises(ValueError, match="version"):
        worker_backup.queue_backup_set(content)
    assert not list((local[2] / "outbox").rglob("manifest.json"))


def replica_module(local, monkeypatch):
    spec = importlib.util.spec_from_file_location('p1_replica', Path(__file__).parents[2] / 'tools/backup_replicate.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'log', lambda *a: None)
    monkeypatch.setattr(module, '_write_status', lambda *a, **kw: True)
    monkeypatch.setattr(module, 'replica_root', lambda: local[2] / 'replica')
    monkeypatch.setattr(module, '_sources', lambda: [('backups', local[1])])
    return module


def test_consumers_replica_main_and_pruning_keep_whole_sets(local, monkeypatch):
    extras(local)
    content = capture(local)
    module = replica_module(local, monkeypatch)
    assert module.main() == 0
    dest = local[2] / 'replica' / 'backups' / content.name
    original = backup_manifest.read_local(content, allow_v3=True)
    assert backup_manifest.read_local(dest, allow_v3=True) == original
    assert not backup._keep_path(dest).exists()
    monkeypatch.setattr(module, 'KEEP_PER_DIR', 0)
    assert module.prune_dir(dest.parent, {content.name}) == 0
    assert module.prune_dir(dest.parent, set()) == 3
    assert not any(p.exists() for p in backup_manifest.local_paths(dest).values())


def test_consumers_restore_original_bytes_and_reject_absent_residue(local):
    local[0].unlink()
    db.init_db()
    extras(local)
    content = capture(local)
    report = backup_verify.verify_restore_set(content, local[2] / 'restored', allow_v3=True)
    assert set(report['files']) == {'content', 'agent_chat', 'asset_mounts'}
    assert report['manifest']['format_version'] == 3
    for info in report['files'].values():
        assert Path(info['backup']).read_bytes() == Path(info['restored']).read_bytes()
    residue = local[2] / 'collision' / 'db' / 'manage_hub.db'
    residue.parent.mkdir(parents=True)
    residue.write_bytes(b'preserve')
    with pytest.raises((ValueError, FileExistsError)):
        backup_verify.verify_restore_set(content, local[2] / 'collision', allow_v3=True)
    assert residue.read_bytes() == b'preserve'


def test_scope_waiting_backup_refuses_epoch_change(local, monkeypatch):
    entered = threading.Event()
    original = db.pinned_share_operation
    from contextlib import contextmanager
    @contextmanager
    def pin(*args, **kw):
        with original(*args, **kw):
            entered.set()
            yield
    monkeypatch.setattr(db, 'pinned_share_operation', pin)
    snapshot = Mock(side_effect=AssertionError('must not snapshot'))
    monkeypatch.setattr(backup, '_snapshot_database_set', snapshot)
    with ThreadPoolExecutor(1) as pool:
        backup._BACKUP_LOCK.acquire()
        future = pool.submit(copy_context().run, capture, local)
        try:
            assert entered.wait(3)
            db.flush_pool()
        finally:
            backup._BACKUP_LOCK.release()
        with pytest.raises(db.DatabaseEpochChanged):
            future.result(timeout=5)
    snapshot.assert_not_called()


def test_scope_snapshot_holds_restore_drain_until_connections_close(local, monkeypatch):
    entered, release, restored = threading.Event(), threading.Event(), threading.Event()
    original = backup._snapshot_database_set
    def snapshot(*args, **kw):
        result = original(*args, **kw)
        entered.set()
        assert release.wait(4)
        return result
    monkeypatch.setattr(backup, '_snapshot_database_set', snapshot)
    def restore():
        with db.maintenance_gate(timeout=4):
            restored.set()
            db.flush_pool()
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(copy_context().run, capture, local)
        assert entered.wait(3)
        other = pool.submit(restore)
        try:
            deadline = time.monotonic() + 2
            while not db.maintenance_active() and time.monotonic() < deadline:
                time.sleep(.01)
            assert db.maintenance_active()
            assert not restored.is_set()
        finally:
            release.set()
        other.result(timeout=5)
        with pytest.raises(db.DatabaseEpochChanged):
            future.result(timeout=5)
    assert not list(local[1].glob('content_hub_*.db'))


def test_scope_publication_then_restore_preserves_set_without_rotation(local, monkeypatch):
    original = db.share_operation_write
    from contextlib import contextmanager
    calls = 0
    @contextmanager
    def writing():
        nonlocal calls
        calls += 1
        with original():
            yield
        if calls == 2:
            db.flush_pool()
    monkeypatch.setattr(db, 'share_operation_write', writing)
    rotate = Mock()
    monkeypatch.setattr(backup, '_rotate', rotate)
    with pytest.raises(db.DatabaseEpochChanged):
        capture(local)
    rotate.assert_not_called()
    content, = local[1].glob('content_hub_*.db')
    assert backup_manifest.read_local(content, allow_v3=True)['format_version'] == 3


def test_scope_captured_account_survives_switch(local, monkeypatch):
    extras(local)
    original = backup._snapshot_database_set
    def snapshot(*args, **kw):
        with active_account.pinned_account_scope(('other@example.invalid', 'other')):
            result = original(*args, **kw)
        return result
    monkeypatch.setattr(backup, '_snapshot_database_set', snapshot)
    content = capture(local)
    manifest = backup_manifest.read_local(content, allow_v3=True)
    assert manifest['account_scope_digest'] == backup_manifest.account_digest(active_account.slug('artist@example.invalid'))
    assert manifest['roles']['agent_chat']['state'] == 'present'


def test_capture_b1_pair_and_manage_independent_time(enabled_db, tmp_path, monkeypatch):
    from app import manage_db
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 3)
    monkeypatch.setattr(backup, 'AUTH_ENABLED', False)
    monkeypatch.setattr(config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path / 'isolated')
    monkeypatch.setattr(config, 'AGENT_CHAT_DIR', tmp_path / 'agent')
    manage = tmp_path / 'manage_hub.db'
    monkeypatch.setattr(manage_db, 'MANAGE_DB_PATH', manage)
    monkeypatch.setattr(backup, 'MANAGE_DB_PATH', manage)
    manage_db.init_manage_db()
    with active_account.pinned_account_scope(('artist@example.invalid', 'artist')):
        content = backup._backup_now_for_scope(enabled_db, tmp_path / 'backups')
    manifest = backup_manifest.read_local(content, allow_v3=True)
    assert manifest['consistency_kind'] == backup_manifest.PINNED
    assert manifest['consistency_roles'] == ['content', 'trash']
    assert manifest['roles']['content']['captured_at'] == manifest['roles']['trash']['captured_at']
    assert manifest['roles']['manage']['state'] == 'present'
    assert manifest['roles']['manage']['captured_at'] >= manifest['roles']['content']['captured_at']


def test_capture_live_agent_wal_is_in_snapshot(local):
    from app.repo import agent_chat as store
    agent, _ = extras(local)
    with store.connect(agent) as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute("INSERT INTO agent_chat_event VALUES('turn',1,'message','synthetic', 'now')")
        content = capture(local)
        manifest = backup_manifest.read_local(content, allow_v3=True)
        target = backup_manifest.local_paths(content, manifest)['agent_chat']
        with closing(sqlite3.connect(backup.read_only_uri(target, immutable=True), uri=True)) as copy:
            assert copy.execute('SELECT payload FROM agent_chat_event').fetchone()[0] == 'synthetic'
    assert not store._connections.get(store.path_key(agent), 0)


def test_capture_wrong_account_agent_and_profiles_excluded(local):
    agent, _ = extras(local)
    (agent.parent / 'foreign.db').write_bytes(b'not sqlite')
    (agent.parent / 'profiles').mkdir()
    (agent.parent / 'profiles' / 'credential').write_bytes(b'never-copy')
    content = capture(local)
    assert len(list(content.parent.glob('agent_chat_*.db'))) == 1
    assert not list(content.parent.rglob('credential'))


def test_scope_poll_secretless_then_new_secret_then_new_agent(local):
    before = backup._db_change_signature(local[0])
    assert list(backup._AGENT_PATH_CACHE.values()) == [(active_account.account_key(), None)]
    agent, _ = extras(local)
    # Refresh from the content snapshot even when a later JSON phase fails.
    asset_mounts.mounts_file().write_bytes(b'broken')
    with pytest.raises(backup.BackupCaptureError):
        capture(local)
    assert (active_account.account_key(), agent) in backup._AGENT_PATH_CACHE.values()
    agent.unlink()
    missing = backup._db_change_signature(local[0])
    agent.write_bytes(b'new-file-detected-by-stat')
    assert backup._db_change_signature(local[0]) != missing != before


def test_scope_poll_hot_journal_and_maintenance_never_initializes_cache(local):
    journal = Path(str(local[0]) + '-journal')
    journal.write_bytes(b'hot')
    backup._db_change_signature(local[0])
    assert not backup._AGENT_PATH_CACHE
    journal.unlink()
    with db.maintenance_gate():
        backup._db_change_signature(local[0])
        assert not backup._AGENT_PATH_CACHE
    backup._db_change_signature(local[0])
    assert backup._AGENT_PATH_CACHE


def test_scope_poll_uses_captured_account_after_switch(local, monkeypatch):
    import asyncio
    email = active_account.account_key()
    observed = []
    def poll(*args):
        observed.append(active_account.account_key())
        return 0, (), False
    monkeypatch.setattr(backup, '_read_poll_state', poll)
    with active_account.pinned_account_scope(('other@example.invalid', 'other')):
        asyncio.run(backup.PeriodicBackup()._poll((local[0], local[1], email)))
    assert observed == [email]


def test_scope_poll_shared_explicit_db_keeps_account_identity(local):
    original, _ = extras(local)
    assert backup._poll_agent_path(local[0]) == original
    with active_account.pinned_account_scope(('other@example.invalid', 'other')):
        expected = agent_chat.Identity(auth.hub_id_for('synthetic-only', local[0]),
                                       str(local[0]), active_account.account_key()).file_path()
        assert backup._poll_agent_path(local[0]) == expected != original
    assert backup._poll_agent_path(local[0]) == original


@pytest.mark.parametrize('auth_on,account', [(True, 'artist@example.invalid'), (False, '')])
def test_compatibility_capture_v3_is_local_account_only(local, monkeypatch, auth_on, account):
    monkeypatch.setattr(backup, 'AUTH_ENABLED', auth_on)
    with active_account.pinned_account_scope((account, None)):
        content = capture(local)
    assert backup_manifest.read_local(content)['format_version'] == 2


def test_consumers_replica_incomplete_source_protects_existing_copy(local, monkeypatch):
    extras(local)
    content = capture(local)
    module = replica_module(local, monkeypatch)
    assert module.main() == 0
    dest = local[2] / 'replica' / 'backups' / content.name
    before = {p.name: p.read_bytes() for p in dest.parent.iterdir()}
    content.unlink()
    monkeypatch.setattr(module, 'KEEP_PER_DIR', 0)
    assert module.main() == 0
    assert {p.name: p.read_bytes() for p in dest.parent.iterdir()} == before


def test_consumers_latest_sizes_and_rotation_include_json(local, monkeypatch):
    extras(local)
    first = capture(local)
    second = capture(local, '20261113_010102_000002')
    monkeypatch.setattr(backup, '_backup_dir', lambda: local[1])
    assert backup.latest_backup_path() == second
    count, size = backup._completed_backup_info(second)
    manifest = backup_manifest.read_local(second, allow_v3=True)
    assert count == 3
    assert size == sum(x['size'] for x in manifest['roles'].values() if x['state'] == 'present')
    policy = {**backup.default_policy(), 'recent': 1, 'daily_days': 0, 'weekly_weeks': 0}
    assert backup._rotate(local[1], policy=policy)['deleted'] == 1
    assert not any(path.exists() for path in backup_manifest.local_paths(first).values())
    assert backup.latest_backup_path() == second


def test_consumers_replica_probe_recognizes_local_agent(local, monkeypatch):
    extras(local)
    content = capture(local)
    module = replica_module(local, monkeypatch)
    assert module.main() == 0
    root = local[2] / 'replica'
    assert module._accepts_existing(root, list(root.iterdir()))
    (root / 'backups' / 'agent_chat_foreign.db').write_bytes(b'foreign')
    assert not module._accepts_existing(root, list(root.iterdir()))


@pytest.mark.parametrize('version', [2, 3])
def test_consumers_replica_resumes_own_interrupted_deletion(local, monkeypatch, version):
    extras(local)
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', version)
    if version == 2:
        with closing(sqlite3.connect(local[0].parent / 'content_hub_trash.db')) as conn:
            conn.execute('CREATE TABLE trashed(id TEXT PRIMARY KEY)')
    content = capture(local)
    module = replica_module(local, monkeypatch)
    assert module.main() == 0
    root = local[2] / 'replica'
    dest = root / 'backups' / content.name
    members = backup_manifest.local_paths(dest, backup_manifest.read_local(dest, allow_v3=True))
    blocked = next(path for role, path in members.items() if role != 'content')
    original_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == blocked:
            raise PermissionError('synthetic busy member')
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(module, 'KEEP_PER_DIR', 0)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'unlink', unlink)
        assert module.prune_dir(dest.parent, set()) == 1
    assert not dest.exists() and blocked.exists()
    assert module._accepts_existing(root, list(root.iterdir()))
    # A source that comes back protects even an already-started deletion.
    assert module.prune_dir(dest.parent, {blocked.name}) == 0
    assert blocked.exists()
    assert module.prune_dir(dest.parent, set()) == len(members) - 1
    assert not list(dest.parent.iterdir())


def test_consumers_replica_preserves_unmarked_incomplete_destination(local, monkeypatch):
    extras(local)
    content = capture(local)
    module = replica_module(local, monkeypatch)
    assert module.main() == 0
    dest = local[2] / 'replica' / 'backups' / content.name
    dest.unlink()
    before = {p.name: p.read_bytes() for p in dest.parent.iterdir()}
    monkeypatch.setattr(module, 'KEEP_PER_DIR', 0)
    assert module.prune_dir(dest.parent, set()) == 0
    assert {p.name: p.read_bytes() for p in dest.parent.iterdir()} == before


def test_consumers_absent_database_sidecar_is_not_complete(local):
    content = capture(local)
    agent = backup_manifest.local_paths(content)['agent_chat']
    Path(str(agent) + '-wal').write_bytes(b'residue')
    assert not backup._set_complete(content)


def test_capture_agent_disk_full_is_reported_as_disk_full(local, monkeypatch):
    extras(local)
    original = backup._check_disk_space
    def check(directory, sources):
        if any(role == 'agent_chat' for role, *_ in sources):
            raise backup.BackupDiskFull('synthetic')
        return original(directory, sources)
    monkeypatch.setattr(backup, '_check_disk_space', check)
    with pytest.raises(backup.BackupDiskFull):
        capture(local)
    assert backup._LAST_ERROR[str(local[1])]['code'] == 'disk_full'


def test_scope_agent_admission_closed_fails_without_creating_file(local):
    from app.repo import agent_chat as store
    agent, _ = extras(local)
    keys = store.close_admission([agent])
    try:
        with pytest.raises(backup.BackupCaptureError, match='agent_chat_busy'):
            capture(local)
    finally:
        store.reopen_admission(keys)
    assert not list(local[1].glob('content_hub_*.db'))


def test_scope_json_wait_does_not_hold_content_drain(local, monkeypatch):
    _, mounts = extras(local)
    entered = threading.Event()
    original = asset_mounts.capture_bytes
    def read(path):
        entered.set()
        return original(path)
    monkeypatch.setattr(asset_mounts, 'capture_bytes', read)
    with ThreadPoolExecutor(1) as pool:
        lock = asset_mounts._file_lock(mounts)
        lock.acquire()
        future = pool.submit(copy_context().run, capture, local)
        try:
            assert entered.wait(3)
            with db.maintenance_gate(timeout=1):
                db.flush_pool()
        finally:
            lock.release()
        with pytest.raises(db.DatabaseEpochChanged):
            future.result(timeout=5)
    assert not list(local[1].glob('content_hub_*.db'))


def test_capture_environment_key_selects_only_matching_agent(local, monkeypatch):
    old, _ = extras(local)
    monkeypatch.setenv('CONTENT_HUB_AUTH_SECRET', 'environment-synthetic')
    identity = agent_chat.Identity(auth.hub_id_for('environment-synthetic', local[0]), str(local[0]), active_account.account_key())
    new = identity.file_path()
    with closing(sqlite3.connect(new)) as conn:
        conn.executescript(_OLD_AGENT_SQL)
        conn.execute("INSERT INTO agent_chat_event VALUES('turn',1,'event','env-selected','now')")
        conn.commit()
    old.write_bytes(b'wrong-identity-must-not-be-opened')
    content = capture(local)
    manifest = backup_manifest.read_local(content, allow_v3=True)
    snapshot = backup_manifest.local_paths(content, manifest)['agent_chat']
    with closing(sqlite3.connect(backup.read_only_uri(snapshot, immutable=True), uri=True)) as conn:
        assert conn.execute('SELECT payload FROM agent_chat_event').fetchone()[0] == 'env-selected'


def test_scope_agent_connection_is_counted_until_close(local, monkeypatch):
    from app.repo import agent_chat as store
    from contextlib import contextmanager
    agent, _ = extras(local)
    opened, release, drained = threading.Event(), threading.Event(), threading.Event()
    original = store.connect
    @contextmanager
    def connection(*args, **kwargs):
        with original(*args, **kwargs) as conn:
            opened.set()
            assert release.wait(4)
            yield conn
    monkeypatch.setattr(store, 'connect', connection)
    def restore():
        keys = store.close_admission([agent])
        try:
            store.drain_connections(keys, 4)
            drained.set()
        finally:
            store.reopen_admission(keys)
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(copy_context().run, capture, local)
        assert opened.wait(3)
        other = pool.submit(restore)
        try:
            deadline = time.monotonic() + 2
            while store.path_key(agent) not in store._gates and time.monotonic() < deadline:
                time.sleep(.01)
            assert store.path_key(agent) in store._gates
            assert not drained.is_set()
        finally:
            release.set()
        other.result(timeout=5)
        assert future.result(timeout=5)
    assert drained.is_set()
    assert store._connections[store.path_key(agent)] == 0


@pytest.mark.parametrize('version', [2, 3])
def test_consumers_replica_missing_manifest_never_copies_partial_set(local, monkeypatch, version):
    extras(local)
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', version)
    content = capture(local)
    backup_manifest.local_path(content).unlink()
    module = replica_module(local, monkeypatch)
    assert module.main() == 1
    assert not list((local[2] / 'replica').rglob('*.db'))
