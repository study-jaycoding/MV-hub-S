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
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [])
    legacy.sync_scene_backups('u', '', [], ['s'])
    with db.get_connection() as conn:
        saved = conn.execute('SELECT reason,data FROM scene_archive ORDER BY reason').fetchall()
        assert [(r['reason'], json.loads(r['data'])['name']) for r in saved] == [
            ('legacy_delete', 'Y'), ('legacy_overwrite', 'X')]
    db.init_db()
    assert store.notebook('u')['items'] == []


def test_old_hub_normalized_on_start_without_read_request(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [scene(name='Y')], [])
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
    legacy.sync_scene_backups('u', '', [scene(name='old-edit')], [])
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
        db_migrations._migrate_scene_notebook(conn)


def test_delete_dedupe_does_not_collide_across_restored_history(notebook_db):
    seed()
    legacy.sync_scene_backups('u', '', [], ['s'])
    with store.transaction() as conn:
        store.restore_history(conn)
    legacy.sync_scene_backups('u', '', [scene()], [])
    legacy.sync_scene_backups('u', '', [], ['s'])
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM scene_archive WHERE reason='legacy_delete'").fetchone()[0] == 2
