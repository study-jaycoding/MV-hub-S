"""New and legacy SQLite schemas keep canvas receipts across repeated startup."""
import hashlib
import json
import sqlite3

import pytest

from app import db, schema_compat
from app.db_migrations import _migrate_comfy_canvas_runs

CANVAS = "content_comfy_canvas_runs"
# 공개판(2026.10.29-1302) 검사기가 아는 이름. 서버는 루트의 옛 검사기로 후보가 만든 DB 를 검사하고, 되돌릴 때는 옛 판이 DB 를 연다 —
# 모르는 이름이나 다른 체크섬이 DB 에 남으면 서버 업데이트와 되돌리기가 막힌다. 아래 값을 고치기 전에 서버 루트 검사 도구부터 갱신할 것(docs/CODE_MAP.md §5).
PUBLIC_RELEASE_MIGRATIONS = {
    "content_core": "content_core.baseline.v1", "content_pm": "content_pm.baseline.v1",
    "content_share_commands": "content_share_commands.v2", "content_asset_sync": "content_asset_sync.v1",
    "content_asset_destination": "content_asset_destination.v1", "content_transfer": "content_transfer.b1.v1",
    "trash_transfer": "trash_transfer.b1.v1", "trash": "trash.baseline.v1", "manage": "manage.baseline.v1",
}
PUBLIC_RELEASE_CHECKSUMS = "7da6e404456368643e8179a8c36f48c9cd004744b125868699405a19deba111a"  # 공개판 소스에서 계산한 (id, checksum) 목록의 지문
NEW_DATABASE_MIGRATIONS = {"content_core.baseline.v1", "content_share_commands.v2", "content_asset_sync.v1", "content_asset_destination.v1"}


def test_new_database_checks_canvas_tables_without_recording_baseline(tmp_path):
    path = tmp_path / "new.db"
    db.init_db(path)
    assert CANVAS not in schema_compat.inspect_database(path, "content").components
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'comfy_canvas_%' AND type='table'").fetchone()[0] == 2


def test_baseline_names_stay_within_public_release(tmp_path):
    baselines = schema_compat.BASELINES
    assert {name: item.migration_id for name, item in baselines.items()} == {**PUBLIC_RELEASE_MIGRATIONS, CANVAS: "content_comfy_canvas_runs.v1"}
    pairs = sorted((item.migration_id, item.checksum) for name, item in baselines.items() if name != CANVAS)
    assert hashlib.sha256(json.dumps(pairs).encode()).hexdigest() == PUBLIC_RELEASE_CHECKSUMS
    path = tmp_path / "new.db"
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        assert {row[0] for row in conn.execute("SELECT migration_id FROM schema_migrations")} == NEW_DATABASE_MIGRATIONS


def test_wrong_canvas_table_stops_startup(tmp_path):
    path = tmp_path / "wrong.db"
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE comfy_canvas_run DROP COLUMN context_json")
    with pytest.raises(schema_compat.SchemaCompatibilityError, match="baseline_structure_mismatch"):
        db.init_db(path)


def test_database_with_the_recorded_row_still_opens_and_keeps_it(tmp_path):
    """dev 로 켠 DB 에는 이 줄이 이미 있다 — 그대로 읽고 지우지 않는다."""
    path = tmp_path / "dev.db"
    db.init_db(path)
    baseline = schema_compat.BASELINES[CANVAS]
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO schema_migrations VALUES(?,?,'2026-10-30T00:00:00.000Z')", (baseline.migration_id, baseline.checksum))
    db.init_db(path)
    assert CANVAS in schema_compat.inspect_database(path, "content").components


def test_legacy_migration_is_repeatable_and_preserves_data(tmp_path):
    path = tmp_path / "legacy.db"
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TABLE comfy_canvas_output")
        conn.execute("DROP TABLE comfy_canvas_run")
        conn.execute("INSERT INTO app_setting(key,value) VALUES('test-preserved','unchanged')")
    db.init_db(path)
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        _migrate_comfy_canvas_runs(conn)
        _migrate_comfy_canvas_runs(conn)
        assert conn.execute("SELECT value FROM app_setting WHERE key='test-preserved'").fetchone()[0] == "unchanged"
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='content_comfy_canvas_runs.v1'").fetchone()[0] == 0
        assert not any(row[2] == "generation" for row in conn.execute("PRAGMA foreign_key_list(comfy_canvas_output)"))
