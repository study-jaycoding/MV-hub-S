"""New and legacy SQLite schemas keep canvas receipts across repeated startup."""
import sqlite3

from app import db, schema_compat
from app.db_migrations import _migrate_comfy_canvas_runs


def test_new_database_registers_canvas_baseline(tmp_path):
    path = tmp_path / "new.db"
    db.init_db(path)
    result = schema_compat.inspect_database(path, "content")
    assert "content_comfy_canvas_runs" in result.components


def test_legacy_migration_is_repeatable_and_preserves_data(tmp_path):
    path = tmp_path / "legacy.db"
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM schema_migrations WHERE migration_id='content_comfy_canvas_runs.v1'")
        conn.execute("DROP TABLE comfy_canvas_output")
        conn.execute("DROP TABLE comfy_canvas_run")
        conn.execute("INSERT INTO app_setting(key,value) VALUES('test-preserved','unchanged')")
    db.init_db(path)
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        _migrate_comfy_canvas_runs(conn)
        _migrate_comfy_canvas_runs(conn)
        assert conn.execute("SELECT value FROM app_setting WHERE key='test-preserved'").fetchone()[0] == "unchanged"
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='content_comfy_canvas_runs.v1'").fetchone()[0] == 1
        assert not any(row[2] == "generation" for row in conn.execute("PRAGMA foreign_key_list(comfy_canvas_output)"))
