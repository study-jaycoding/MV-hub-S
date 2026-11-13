from test_scene_notebook import restore_generation
import json
import sqlite3
import pytest
from app import db, db_migrations
from app.repo import scene_notebook as store, scenes_backup as legacy
from test_scene_notebook import notebook_db, seed, scene


def test_additive_migration_is_idempotent_and_preserves_old_keys():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''CREATE TABLE scene_backup(owner_uid TEXT,project_id TEXT,scene_id TEXT,name TEXT,
        data TEXT,data_hash TEXT,updated_at TEXT,PRIMARY KEY(owner_uid,project_id,scene_id));
        CREATE TABLE mcp_canvas_task(id TEXT PRIMARY KEY);
        CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT);''')
    db_migrations._migrate_scene_notebook(conn)
    before = [tuple(r) for r in conn.execute('PRAGMA table_info(scene_backup)')]
    db_migrations._migrate_scene_notebook(conn)
    assert before == [tuple(r) for r in conn.execute('PRAGMA table_info(scene_backup)')]
    assert [r[1] for r in before if r[5]] == ['owner_uid','project_id','scene_id']
    assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 2
    conn.close()


def test_public_sql_x_y_delete_preserves_both_preimages(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [], restore_generation=restore_generation())
    legacy.sync_scene_backups('u', '', [], ['s'], restore_generation=restore_generation())
    with db.get_connection() as conn:
        saved = conn.execute('SELECT reason,data FROM scene_archive ORDER BY reason').fetchall()
        assert [(r['reason'], json.loads(r['data'])['name']) for r in saved] == [
            ('legacy_delete', 'Y'), ('legacy_overwrite', 'X')]
    db.init_db()
    assert store.notebook('u')['items'] == []


def test_old_hub_normalized_on_start_without_read_request(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [], restore_generation=restore_generation())
    db.init_db()
    with db.get_connection() as conn:
        row = store.row_for(conn, 'u', '', 's')
        assert row['rev'] == 2 and row['rev_hash'] == row['data_hash']
        assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == 2
    db.init_db()
    assert len(store.notebook('u')['items']) == 2


def test_legacy_edit_of_tombstone_is_revived(notebook_db):
    seed()
    with db.get_connection() as conn:
        conn.execute("UPDATE scene_backup SET deleted_at='deleted',rev=rev+1 WHERE scene_id='s'")
    legacy.sync_scene_backups('u', '', [scene(name='old-edit')], [], restore_generation=restore_generation())
    db.init_db()
    with db.get_connection() as conn:
        assert store.row_for(conn, 'u', '', 's')['deleted_at'] is None
        assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == 1
        assert conn.execute('SELECT consumed FROM scene_archive').fetchone()[0] == 1


def test_schema_marker_error_names_configured_schema(notebook_db, monkeypatch):
    path = notebook_db / 'missing-marker.sql'
    path.write_text('SELECT 1;', encoding='utf-8')
    monkeypatch.setattr(db, 'SCHEMA_PATH', path)
    with db.get_connection() as conn, pytest.raises(RuntimeError, match='schema marker missing.*missing-marker.sql'):
        db_migrations._migrate_scene_notebook(conn, schema_path=db.SCHEMA_PATH)


def test_delete_dedupe_does_not_collide_across_restored_history(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [], ['s'], restore_generation=restore_generation())
    with store.transaction() as conn:
        store.restore_history(conn)
    legacy.sync_scene_backups('u', '', [scene()], [], restore_generation=restore_generation())
    legacy.sync_scene_backups('u', '', [], ['s'], restore_generation=restore_generation())
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM scene_archive WHERE reason='legacy_delete'").fetchone()[0] == 2


def test_app_registers_notebook_before_first_lifespan_init(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    script = '''
import asyncio
from pathlib import Path
from app import db
assert not db._init_hooks
from app import main
from app.repo import scene_notebook
class ReachedInit(Exception): pass
def first_init():
    assert db._init_hooks.count(scene_notebook._after_db_init) == 1
    raise ReachedInit()
main.init_db = first_init
main.configure_operational_logging = lambda: Path('isolated.log')
main.log_event = lambda *args, **kwargs: None
async def run():
    try:
        async with main._application_lifespan(main.app):
            raise AssertionError('startup skipped init_db')
    except ReachedInit:
        return
    raise AssertionError('first init not reached')
asyncio.run(run())
'''
    env = {**os.environ, 'CONTENT_HUB_DATA': str(tmp_path / 'data'),
           'CONTENT_HUB_DB': str(tmp_path / 'startup.db'), 'CONTENT_HUB_NO_PROXY': '1'}
    result = subprocess.run([sys.executable, '-B', '-c', script], env=env,
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


def test_init_hook_is_once_per_init_and_shares_rollback(notebook_db, monkeypatch):
    calls = []
    original = store.normalize_legacy
    def normalize(conn):
        assert conn.in_transaction
        calls.append(conn)
        original(conn)
    monkeypatch.setattr(store, 'normalize_legacy', normalize)
    monkeypatch.setattr(db, '_init_hooks', [store._after_db_init])
    db.register_init_hook(store._after_db_init)
    db.init_db()
    assert len(calls) == 1
    def fail(conn, scene_restore):
        assert not scene_restore
        conn.execute("INSERT INTO app_setting(key,value) VALUES('hook_rollback','yes')")
        raise RuntimeError('hook failed')
    db.register_init_hook(fail)
    with pytest.raises(RuntimeError, match='hook failed'):
        db.init_db()
    with db.get_connection() as conn:
        assert conn.execute("SELECT 1 FROM app_setting WHERE key='hook_rollback'").fetchone() is None


def test_flag_off_without_notebook_and_auth_on_skip_init_work(notebook_db, monkeypatch):
    from app import config
    def unexpected(*args):
        pytest.fail('disabled notebook must not normalize or restore')
    monkeypatch.setattr(store, 'normalize_legacy', unexpected)
    monkeypatch.setattr(store, 'restore_history', unexpected)
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '0')
    db.init_db()
    db.init_db(scene_restore=True)
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '1')
    monkeypatch.setattr(config, 'AUTH_ENABLED', True)
    db.init_db(scene_restore=True)


def test_account_switch_normalizes_target_before_publishing_pointer(notebook_db, monkeypatch):
    from app import active_account
    from app.routers import publish
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [], restore_generation=restore_generation())
    target = notebook_db / 'notebook.db'
    other = notebook_db / 'other.db'
    db.init_db(other)
    monkeypatch.setattr(active_account, 'account_db_path', lambda email: target)
    monkeypatch.setattr(publish, 'AUTH_ENABLED', False)
    monkeypatch.setenv('CONTENT_HUB_DB', str(other))  # Current account differs from init_db's target.
    published = []
    def publish_pointer(email, uid):
        with db.get_connection(target) as conn:
            row = store.row_for(conn, 'u', '', 's')
            assert row['rev'] == 2 and row['rev_hash'] == row['data_hash']
            assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == 2
        with db.get_connection(other) as conn:
            assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == 0
        published.append(email)
    monkeypatch.setattr(active_account, 'set_active', publish_pointer)
    monkeypatch.setattr(publish.agent_signals.agent_signals, 'signal', lambda *args: None)
    publish._switch_account_db('switch@example.test', None)
    assert published == ['switch@example.test']
