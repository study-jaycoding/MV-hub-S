"""Compatibility inspection uses temporary SQLite files, never user databases."""
from contextlib import closing
import sqlite3
import subprocess
import sys

import pytest

from app import db, manage_db
from app import schema_compat as compat
from app.repo import manage_schema, trash


@pytest.fixture
def content(tmp_path):
    path = tmp_path / "content.db"
    db.init_db(path)
    # Inspector unit fixtures deliberately represent a pre-ledger current DB.
    # Runtime initialization itself is exercised separately below.
    with connect(path) as conn:
        conn.execute("DROP TABLE schema_migrations")
        conn.execute("DROP TABLE schema_meta")
        conn.execute("PRAGMA user_version=0")
    return path


def connect(path):
    return closing(sqlite3.connect(path, isolation_level=None))


def assert_reason(reason, action):
    with pytest.raises(compat.SchemaCompatibilityError) as exc:
        action()
    assert exc.value.reason == reason


def test_current_content_record_is_idempotent_and_pm_is_optional(content):
    with connect(content) as conn:
        assert compat.inspect_schema(conn, "content").status == "unversioned"
        first = compat.record_baseline(conn, "content_core")
        first_rows = conn.execute("SELECT * FROM schema_migrations").fetchall()
        assert first.components == ("content_core",)
        assert compat.record_baseline(conn, "content_core") == first
        assert conn.execute("SELECT * FROM schema_migrations").fetchall() == first_rows
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='project_task'").fetchone() is None
        assert not conn.in_transaction


def test_content_pm_has_own_component_in_same_database(content, monkeypatch):
    monkeypatch.setattr(manage_schema, "get_db_path", lambda: content)
    with connect(content) as conn:
        manage_schema.ensure_manage_schema(conn)
        assert_reason("core_baseline_required", lambda: compat.record_baseline(conn, "content_pm"))
        first = compat.record_baseline(conn, "content_core")
        result = compat.record_baseline(conn, "content_pm")
        assert result.database_id == first.database_id
        assert result.components == ("content_core", "content_pm")
        assert compat.record_baseline(conn, "content_pm") == result


def test_real_manage_schema_uses_manage_kind(tmp_path, monkeypatch):
    path = tmp_path / "manage.db"
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
    manage_db.init_manage_db()
    with connect(path) as conn:
        result = compat.record_baseline(conn, "manage")
        assert result.database_kind == "manage"
        assert_reason("database_kind_mismatch", lambda: compat.inspect_schema(conn, "content"))


def test_attached_trash_record_only_changes_trash(content, tmp_path):
    trash_path = tmp_path / "trash.db"
    with connect(content) as conn:
        conn.execute("ATTACH DATABASE ? AS trash", (str(trash_path),))
        trash._ensure_trash_schema(conn)
        result = compat.record_baseline(conn, "trash", schema="trash")
        assert result.components == ("trash",)
        assert compat.inspect_schema(conn, "content").status == "unversioned"
        assert conn.execute("PRAGMA main.user_version").fetchone()[0] == 0
        assert conn.execute("PRAGMA trash.user_version").fetchone()[0] == 1
    assert compat.inspect_database(trash_path, "trash") == result


@pytest.mark.parametrize("ddl", [
    "", "CREATE TABLE gen_request(id TEXT PRIMARY KEY)",
    "CREATE TABLE scene_card_generation(generation_id TEXT)",
    "CREATE TABLE asset_comment(id TEXT)", "CREATE TABLE lineage(id TEXT)",
])
def test_partial_legacy_is_allowed_only_for_migration(tmp_path, ddl):
    with connect(tmp_path / "old.db") as conn:
        if ddl:
            conn.execute(ddl)
        assert compat.inspect_schema(conn, "content").status == "unversioned"
        assert_reason("baseline_structure_mismatch", lambda: compat.record_baseline(conn, "content_core"))
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='schema_meta'").fetchone() is None


@pytest.mark.parametrize("ddl,kind,reason", [
    ("CREATE TABLE unrelated(id TEXT)", "content", "unrecognized_legacy_schema"),
    ("CREATE TABLE trashed(id TEXT)", "content", "database_kind_mismatch"),
    ("CREATE TABLE team_generation_fact(id TEXT)", "trash", "database_kind_mismatch"),
])
def test_unknown_or_other_kind_is_not_legacy(tmp_path, ddl, kind, reason):
    with connect(tmp_path / "unknown.db") as conn:
        conn.execute(ddl)
        assert_reason(reason, lambda: compat.inspect_schema(conn, kind))


@pytest.mark.parametrize("mutation,reason", [
    ("UPDATE schema_meta SET minimum_reader_protocol=2", "future_schema"),
    ("UPDATE schema_meta SET minimum_writer_protocol=99", "future_schema"),
    ("UPDATE schema_meta SET schema_version=99", "future_schema"),
    ("UPDATE schema_meta SET minimum_writer_protocol=0", "invalid_metadata"),
    ("UPDATE schema_meta SET database_id='bad'", "invalid_metadata"),
    ("UPDATE schema_meta SET database_kind='trash'", "database_kind_mismatch"),
    ("UPDATE schema_migrations SET checksum='bad'", "checksum_mismatch"),
    ("UPDATE schema_migrations SET migration_id='future.v2'", "unknown_migration"),
    ("DELETE FROM schema_migrations", "partial_ledger"),
    ("DROP TABLE schema_meta", "partial_ledger"),
    ("DROP TABLE schema_migrations", "partial_ledger"),
    ("PRAGMA user_version=0", "version_mismatch"),
    ("DROP INDEX idx_genrequest_idempotency", "baseline_structure_mismatch"),
])
def test_corrupt_or_future_ledger_is_rejected_without_repair(content, mutation, reason):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute(mutation)
    before = content.read_bytes()
    assert_reason(reason, lambda: compat.inspect_database(content, "content"))
    assert content.read_bytes() == before


def test_existing_caller_transaction_is_not_committed(content):
    with connect(content) as conn:
        conn.execute("BEGIN")
        conn.execute("INSERT INTO app_setting(key,value) VALUES('caller','pending')")
        assert_reason("active_transaction", lambda: compat.record_baseline(conn, "content_core"))
        assert conn.in_transaction
        conn.execute("ROLLBACK")
        assert conn.execute("SELECT value FROM app_setting WHERE key='caller'").fetchone() is None


def test_metadata_failure_rolls_back_ddl_ledger_and_user_version(content):
    with connect(content) as conn:
        def deny_ledger_insert(action, table, _column, _database, _trigger):
            return sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_INSERT and table == "schema_migrations" else sqlite3.SQLITE_OK
        conn.set_authorizer(deny_ledger_insert)
        with pytest.raises(sqlite3.DatabaseError):
            compat.record_baseline(conn, "content_core")
        conn.set_authorizer(None)
        assert not conn.in_transaction
        assert conn.execute("SELECT name FROM sqlite_master WHERE name LIKE 'schema_%'").fetchall() == []
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert compat.record_baseline(conn, "content_core").status == "compatible"


def test_read_inspection_preserves_bytes_and_does_not_create_missing_file(content, tmp_path):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir() if p.is_file()}
    assert compat.inspect_database(content, "content").status == "compatible"
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir() if p.is_file()} == before
    missing = tmp_path / "missing.db"
    with pytest.raises(sqlite3.OperationalError):
        compat.inspect_database(missing, "content")
    assert not missing.exists()


def test_read_inspection_sees_uncheckpointed_wal(content):
    with connect(content) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA wal_autocheckpoint=0")
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
        before = content.read_bytes()
        assert_reason("future_schema", lambda: compat.inspect_database(content, "content"))
        assert content.read_bytes() == before


def test_same_named_wrong_unique_index_is_not_a_baseline(content):
    with connect(content) as conn:
        conn.execute("DROP INDEX idx_genrequest_idempotency")
        conn.execute("CREATE INDEX idx_genrequest_idempotency ON gen_request(account_email,idempotency_key) WHERE idempotency_key IS NOT NULL")
        assert_reason("baseline_structure_mismatch", lambda: compat.record_baseline(conn, "content_core"))


def test_unsafe_schema_identifier_is_rejected(content):
    with connect(content) as conn:
        with pytest.raises(ValueError, match="invalid_schema_identifier"):
            compat.inspect_schema(conn, "content", schema='main; DROP TABLE generation')


def test_legacy_numbered_schema_is_not_silently_baselined(content):
    with connect(content) as conn:
        conn.execute("PRAGMA user_version=99")
        assert_reason("unknown_legacy_version", lambda: compat.record_baseline(conn, "content_core"))
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 99


def test_empty_or_malformed_metadata_pair_is_rejected(content):
    with connect(content) as conn:
        conn.execute("CREATE TABLE schema_meta(singleton INTEGER)")
        conn.execute("CREATE TABLE schema_migrations(migration_id TEXT)")
        assert_reason("partial_ledger", lambda: compat.inspect_schema(conn, "content"))


def test_wrong_partial_predicate_is_not_a_baseline(content):
    with connect(content) as conn:
        conn.execute("DROP INDEX idx_genrequest_idempotency")
        conn.execute("CREATE UNIQUE INDEX idx_genrequest_idempotency ON gen_request(account_email,idempotency_key) WHERE idempotency_key IS NOT NULL AND status='pending'")
        assert_reason("baseline_structure_mismatch", lambda: compat.record_baseline(conn, "content_core"))


def test_missing_primary_key_is_not_a_baseline(tmp_path):
    with connect(tmp_path / "trash.db") as conn:
        conn.execute("CREATE TABLE trashed(id TEXT, trashed_at TEXT, creator_uid TEXT, job_id TEXT, payload TEXT)")
        conn.execute("CREATE INDEX idx_trashed_job ON trashed(job_id)")
        assert_reason("baseline_structure_mismatch", lambda: compat.record_baseline(conn, "trash"))


def test_rollback_journal_is_preserved_and_not_ignored(content):
    journal = content.with_name(content.name + "-journal")
    journal.write_bytes(b"synthetic pending recovery")
    before = content.read_bytes()
    assert_reason("rollback_journal_requires_recovery", lambda: compat.inspect_database(content, "content"))
    assert content.read_bytes() == before
    assert journal.read_bytes() == b"synthetic pending recovery"


def _leave_hot_journal(path):
    script = """
import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute('PRAGMA journal_mode=DELETE')
c.execute('PRAGMA synchronous=FULL')
c.execute('CREATE TABLE recovery_probe(id INTEGER PRIMARY KEY, data BLOB)')
c.execute('BEGIN')
c.executemany('INSERT INTO recovery_probe VALUES(?,zeroblob(8000))', [(i,) for i in range(100)])
c.execute('COMMIT')
c.execute('PRAGMA cache_size=5')
c.execute('BEGIN IMMEDIATE')
c.execute("UPDATE recovery_probe SET data=randomblob(8000)")
os._exit(0)
"""
    subprocess.run([sys.executable, "-c", script, str(path)], check=True, timeout=20)
    assert path.with_name(path.name + "-journal").read_bytes()[:8] == b"\xd9\xd5\x05\xf9\x20\xa1\x63\xd7"


def test_hot_journal_copy_inspection_then_known_runtime_recovery(content):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
    _leave_hot_journal(content)
    before = compat._recovery_signature(content)
    assert compat.inspect_database(content, "content").status == "compatible"
    assert compat._recovery_signature(content) == before
    db.init_db(content)
    with connect(content) as conn:
        assert conn.execute("SELECT COUNT(*) FROM recovery_probe WHERE data=zeroblob(8000)").fetchone()[0] == 100
        assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"


def test_hot_journal_future_runtime_does_not_recover_original(content):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    _leave_hot_journal(content)
    before = compat._recovery_signature(content)
    assert_reason("future_schema", lambda: db.init_db(content))
    assert_reason("future_schema", lambda: db._connect(content))
    assert compat._recovery_signature(content) == before


def test_runtime_hot_recovery_admission_runs_inside_maintenance_gate(content, monkeypatch):
    with connect(content) as conn:
        compat.record_baseline(conn, 'content_core')
    _leave_hot_journal(content)
    original = compat._inspect_recovered_copy
    def inspect(path, kind):
        assert db._maintenance_active
        return original(path, kind)
    monkeypatch.setattr(compat, '_inspect_recovered_copy', inspect)
    db.init_db(content)


def test_recovery_rechecks_original_after_copy_admission(content, monkeypatch):
    with connect(content) as conn:
        compat.record_baseline(conn, 'content_core')
    _leave_hot_journal(content)
    original = compat.inspect_database
    journal = content.with_name(content.name + '-journal')
    def changed(path, kind):
        result = original(path, kind)
        with journal.open('ab') as handle:
            handle.write(b'changed')
        return result
    monkeypatch.setattr(compat, 'inspect_database', changed)
    assert_reason('recovery_source_changed', lambda: db._recover_hot_database(content, 'content'))
    assert journal.exists()


def test_unversioned_hot_journal_backup_preserves_original_then_migrates(content):
    _leave_hot_journal(content)
    before = compat._recovery_signature(content)
    copy = compat.backup_before_baseline(content, 'content')
    assert compat._recovery_signature(content) == before
    with connect(copy) as conn:
        assert conn.execute('PRAGMA quick_check').fetchall() == [('ok',)]
        assert conn.execute('SELECT COUNT(*) FROM recovery_probe WHERE data=zeroblob(8000)').fetchone()[0] == 100
    db.init_db(content)
    assert compat.inspect_database(content, 'content').status == 'compatible'
    with connect(content) as conn:
        assert conn.execute('SELECT COUNT(*) FROM recovery_probe WHERE data=zeroblob(8000)').fetchone()[0] == 100


def test_hot_journal_backup_copy_failure_cleans_private_files(content, monkeypatch):
    _leave_hot_journal(content)
    before = compat._recovery_signature(content)
    folder = content.parent / 'backups/pre-dev2-baseline'
    original = compat.shutil.copyfile
    def fail(source, target):
        result = original(source, target)
        if target.parent == folder and str(target).endswith('-journal'):
            raise OSError('injected journal copy failure')
        return result
    monkeypatch.setattr(compat.shutil, 'copyfile', fail)
    assert_reason('baseline_backup_failed', lambda: db.init_db(content))
    assert compat._recovery_signature(content) == before
    assert not list(folder.iterdir())


def test_runtime_init_registers_core_without_enabling_pm(tmp_path):
    path = tmp_path / "runtime.db"
    db.init_db(path)
    first = compat.inspect_database(path, "content")
    assert first.components == ("content_asset_destination", "content_asset_sync", "content_core", "content_share_commands")
    db.init_db(path)
    assert compat.inspect_database(path, "content") == first
    with connect(path) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='project_task'").fetchone() is None


def test_destination_migration_rolls_back_ddl_and_ledger_together(tmp_path, monkeypatch):
    from app import db_asset_destination
    path = tmp_path / "destination.db"
    migrate = db_asset_destination.migrate

    def interrupted(conn):
        migrate(conn)
        raise RuntimeError("destination migration interrupted")

    monkeypatch.setattr(db_asset_destination, "migrate", interrupted)
    with pytest.raises(RuntimeError, match="destination migration interrupted"):
        db.init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='asset_destination_outbox'").fetchone() is None
        assert conn.execute("SELECT 1 FROM schema_migrations WHERE migration_id='content_asset_destination.v1'").fetchone() is None
    monkeypatch.setattr(db_asset_destination, "migrate", migrate)
    db.init_db(path)
    assert "content_asset_destination" in compat.inspect_database(path, "content").components


def test_runtime_init_rejects_future_before_legacy_migration(content, monkeypatch):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = content.read_bytes()
    monkeypatch.setattr(db.db_migrations, "_pre_migrate", lambda conn: pytest.fail("future DB reached migrator"))
    assert_reason("future_schema", lambda: db.init_db(content))
    assert content.read_bytes() == before


def test_direct_content_connection_rejects_future(content):
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_reader_protocol=2")
    with pytest.raises(compat.SchemaCompatibilityError, match="future_schema"):
        with db.get_connection(content):
            pytest.fail("future DB yielded a writable connection")


def test_failed_legacy_migration_never_records_baseline_and_can_resume(content, monkeypatch):
    migrate = db.db_migrations._migrate
    def interrupted(conn):
        migrate(conn)
        raise RuntimeError("synthetic interruption after legacy commits")
    monkeypatch.setattr(db.db_migrations, "_migrate", interrupted)
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        db.init_db(content)
    assert compat.inspect_database(content, "content").status == "unversioned"
    monkeypatch.setattr(db.db_migrations, "_migrate", migrate)
    db.init_db(content)
    assert compat.inspect_database(content, "content").components == ("content_asset_destination", "content_asset_sync", "content_core", "content_share_commands")


def test_runtime_pm_component_joins_and_rolls_back_with_caller(content, monkeypatch):
    monkeypatch.setattr(manage_schema, "get_db_path", lambda: content)
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("BEGIN")
        manage_schema.ensure_manage_schema(conn)
        assert conn.in_transaction
        assert "content_pm" in compat.inspect_schema(conn, "content").components
        conn.execute("ROLLBACK")
        assert compat.inspect_schema(conn, "content").components == ("content_core",)
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='project_task'").fetchone() is None
        manage_schema.ensure_manage_schema(conn)
        assert "content_pm" in compat.inspect_schema(conn, "content").components


def test_partial_legacy_pm_upgrade_does_not_claim_missing_core(content, monkeypatch):
    path = content
    monkeypatch.setattr(manage_schema, "get_db_path", lambda: path)
    with connect(path) as conn:
        # PM migration does not require gen_request. Its success must not certify
        # an incomplete content core, even when all PM tables are now current.
        conn.row_factory = sqlite3.Row
        conn.execute("DROP TABLE gen_request")
        manage_schema.ensure_manage_schema(conn)
        assert compat.inspect_schema(conn, "content").status == "unversioned"


def test_pm_future_guard_precedes_lazy_ddl(content, monkeypatch):
    monkeypatch.setattr(manage_schema, "get_db_path", lambda: content)
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
        assert_reason("future_schema", lambda: manage_schema.ensure_manage_schema(conn))
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='project_task'").fetchone() is None


def test_manage_future_guard_precedes_wal_change(tmp_path, monkeypatch):
    path = tmp_path / "manage.db"
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
    manage_db.init_manage_db()
    with connect(path) as conn:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = path.read_bytes()
    assert_reason("future_schema", manage_db.init_manage_db)
    assert path.read_bytes() == before
    with pytest.raises(compat.SchemaCompatibilityError, match="future_schema"):
        with manage_db.get_connection():
            pytest.fail("future manage DB yielded a writable connection")


def test_trash_future_guard_precedes_wal_and_ddl(content, tmp_path):
    path = tmp_path / "trash.db"
    with connect(content) as conn:
        conn.execute("ATTACH DATABASE ? AS trash", (str(path),))
        trash._ensure_trash_schema(conn)
        conn.execute("PRAGMA trash.journal_mode=DELETE")
        conn.execute("UPDATE trash.schema_meta SET minimum_writer_protocol=99")
        before = path.read_bytes()
        assert_reason("future_schema", lambda: trash._ensure_trash_schema(conn))
        assert path.read_bytes() == before


def test_restore_future_input_is_rejected_before_gate_or_file_replace(content, monkeypatch):
    from fastapi import HTTPException
    from app.routers import db_transfer
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = content.read_bytes()
    monkeypatch.setattr(db_transfer, "_check_restore_target", lambda *args, **kwargs: None)
    monkeypatch.setattr(db, "maintenance_gate", lambda: pytest.fail("entered maintenance gate"))
    monkeypatch.setattr(db_transfer.os, "replace", lambda *args: pytest.fail("replaced file"))
    with pytest.raises(HTTPException) as exc:
        db_transfer._install_db(content)
    assert exc.value.status_code == 400
    assert content.read_bytes() == before


def test_upload_validation_rejects_future_with_safe_error(content):
    from app.services.sqlite_db import HubDbValidationError, validate_hub_db, hub_db_validation_detail
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = content.read_bytes()
    with pytest.raises(HubDbValidationError) as exc:
        validate_hub_db(content)
    assert exc.value.reason == "schema_future_schema"
    assert str(content) not in hub_db_validation_detail(exc.value)
    assert content.read_bytes() == before


def test_legacy_location_future_is_not_moved(tmp_path, monkeypatch):
    legacy = tmp_path / "old.db"
    destination = tmp_path / "new" / "content.db"
    db.init_db(legacy)
    with connect(legacy) as conn:
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", destination)
    monkeypatch.setattr(db, "_LEGACY_DB_PATH", legacy)
    before = legacy.read_bytes()
    assert_reason("future_schema", lambda: db.init_db(destination))
    assert legacy.read_bytes() == before
    assert not destination.exists()


def test_reused_pool_connection_rechecks_writer_floor(content, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(content))
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.flush_pool()
    try:
        with connect(content) as conn:
            compat.record_baseline(conn, "content_core")
        with db.get_connection():
            pass
        with connect(content) as other_writer:
            other_writer.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
        with pytest.raises(compat.SchemaCompatibilityError, match="future_schema"):
            with db.get_connection():
                pytest.fail("old pooled connection bypassed writer floor")
    finally:
        db.flush_pool()


def test_backup_drill_future_rejected_before_copy_or_server(content, tmp_path, monkeypatch):
    from app.services import backup_verify
    with connect(content) as conn:
        compat.record_baseline(conn, "content_core")
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = content.read_bytes()
    monkeypatch.setattr(backup_verify, "create_sqlite_snapshot", lambda *args, **kwargs: pytest.fail("copied incompatible backup"))
    destination = tmp_path / "restored.db"
    assert_reason("future_schema", lambda: backup_verify.verify_restore_drill(content, destination))
    assert not destination.exists()
    assert content.read_bytes() == before


@pytest.mark.parametrize("kind", ["trash", "manage"])
def test_backup_inspector_enforces_sidecar_compatibility(content, tmp_path, monkeypatch, kind):
    from app.services import backup_verify
    path = tmp_path / (kind + ".db")
    if kind == "trash":
        with connect(content) as conn:
            conn.execute("ATTACH DATABASE ? AS trash", (str(path),))
            trash._ensure_trash_schema(conn)
    else:
        monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", path)
        manage_db.init_manage_db()
    with connect(path) as conn:
        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=99")
    before = path.read_bytes()
    required = set(backup_verify.BACKUP_SET_MEMBERS[kind]["required_tables"])
    assert_reason("future_schema", lambda: backup_verify.inspect_sqlite_database(path, required_tables=required))
    assert path.read_bytes() == before
