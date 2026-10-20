"""B1 is activated only on synthetic temporary databases in these tests."""
from contextlib import closing
import sqlite3
import subprocess
import sys
import os

import pytest

from app import config, db, repo
from app.repo import trash
from app.services import trash_transfer as transfer


@pytest.fixture
def enabled_db(tmp_path, monkeypatch):
    path = tmp_path / "content_hub.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    monkeypatch.setattr(config, "MANAGE_ENABLED", False)
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,status,created_at,job_id) VALUES('g1','me','kept','done','2026-10-18','job1')")
        conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('a1','g1','image','/media/keep.png')")
    trash.activate_transfer(path, storage_evidence="fixture-only-full-commit", writer_evidence="fixture-only-trigger-matrix")
    yield path
    db.flush_pool()


def counts():
    with db.get_connection() as conn:
        main = conn.execute("SELECT COUNT(*) FROM generation WHERE id='g1'").fetchone()[0]
    with closing(sqlite3.connect(db.get_db_path().parent / "content_hub_trash.db")) as conn:
        other = conn.execute("SELECT COUNT(*) FROM trashed WHERE id='g1'").fetchone()[0]
    return main, other


def test_actual_delete_restore_and_full(enabled_db):
    with db.get_connection() as conn:
        assert conn.execute("PRAGMA synchronous").fetchone()[0] == 2
    assert trash.move_to_trash("g1")
    assert counts() == (0, 1)
    assert trash.restore_from_trash("g1")
    assert counts() == (1, 0)
    with db.get_connection() as conn:
        assert conn.execute("SELECT file_path FROM asset WHERE id='a1'").fetchone()[0] == '/media/keep.png'
        assert conn.execute("SELECT COUNT(*) FROM generation_transfer").fetchone()[0] == 0


@pytest.mark.parametrize("phase,expected", [("D1", (1,0)), ("D2", (0,1)), ("D3", (0,1)), ("D4", (0,1))])
def test_delete_interruption_reconciles(enabled_db, monkeypatch, phase, expected):
    def interrupt(where):
        if where == phase:
            raise RuntimeError("interrupted")
    monkeypatch.setattr(transfer, "checkpoint", interrupt)
    with pytest.raises(RuntimeError, match="interrupted"):
        trash.move_to_trash("g1")
    monkeypatch.setattr(transfer, "checkpoint", lambda _: None)
    db.init_db()
    assert counts() == expected
    assert transfer.reconcile(db.open_transfer_connections) == 0


@pytest.mark.parametrize("phase,expected", [("R0", (0,1)), ("R1", (1,0)), ("R2", (1,0)), ("R3", (1,0))])
def test_restore_interruption_reconciles(enabled_db, monkeypatch, phase, expected):
    trash.move_to_trash("g1")
    def interrupt(where):
        if where == phase:
            raise RuntimeError("interrupted")
    monkeypatch.setattr(transfer, "checkpoint", interrupt)
    with pytest.raises(RuntimeError, match="interrupted"):
        trash.restore_from_trash("g1")
    monkeypatch.setattr(transfer, "checkpoint", lambda _: None)
    db.init_db()
    assert counts() == expected
    assert transfer.reconcile(db.open_transfer_connections) == 0


def test_old_connection_missing_function_and_low_protocol_rejected(enabled_db):
    with closing(sqlite3.connect(enabled_db)) as old:
        with pytest.raises(sqlite3.OperationalError, match="no such function"):
            old.execute("UPDATE generation SET prompt='lost'")
        old.create_function("mvhub_write_protocol", 0, lambda: 1)
        old.create_function("mvhub_transfer_operation", 0, lambda: "")
        with pytest.raises(sqlite3.IntegrityError, match="transfer_writer"):
            old.execute("UPDATE generation SET prompt='lost'")


def test_pending_blocks_purge_and_other_generation_writes(enabled_db, monkeypatch):
    monkeypatch.setattr(transfer, "checkpoint", lambda phase: (_ for _ in ()).throw(RuntimeError("stop")) if phase == "D2" else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash("g1")
    with db.get_connection() as conn:
        with pytest.raises(sqlite3.IntegrityError, match="transfer_writer"):
            conn.execute("INSERT INTO generation(id,worker_id,prompt,status,created_at) VALUES('g1','me','wrong','done','now')")
    with pytest.raises(transfer.TransferRecoveryRequired, match="pending"):
        trash.purge_trashed_item("g1")


@pytest.mark.parametrize("phase,action,expected", [
    ("D1","move_to_trash",(1,0)), ("D2","move_to_trash",(0,1)),
    ("D3","move_to_trash",(0,1)), ("D4","move_to_trash",(0,1)),
    ("R0","restore_from_trash",(0,1)), ("R1","restore_from_trash",(1,0)),
    ("R2","restore_from_trash",(1,0)), ("R3","restore_from_trash",(1,0)),
])
def test_process_exit_recovery(enabled_db, phase, action, expected):
    if action == "restore_from_trash":
        trash.move_to_trash("g1")
    script = """
import os, sys
os.environ['CONTENT_HUB_DB'] = sys.argv[1]
os.environ['CONTENT_HUB_MANAGE'] = '0'
from app.repo import trash
from app.services import trash_transfer as t
t.checkpoint = lambda phase: os._exit(73) if phase == sys.argv[2] else None
getattr(trash, sys.argv[3])('g1')
"""
    result = subprocess.run([sys.executable, "-c", script, str(enabled_db), phase, action], env=dict(os.environ), timeout=20)
    assert result.returncode == 73
    db.init_db()
    assert counts() == expected


def test_existing_legacy_connection_cannot_mutate_any_guarded_table(tmp_path, monkeypatch):
    path = tmp_path / "content_hub.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    db.init_db()
    with closing(sqlite3.connect(path, isolation_level=None)) as old:
        old.execute("SELECT COUNT(*) FROM generation").fetchone()
        trash.activate_transfer(path, storage_evidence="isolated-test", writer_evidence="isolated-test")
        tables = [r[1] for r in old.execute("PRAGMA table_list") if r[0] == 'main' and r[2] == 'table' and not r[1].startswith('sqlite_')]
        for table in tables:
            with pytest.raises(sqlite3.OperationalError, match="no such function"):
                old.execute(f'DELETE FROM "{table}" WHERE 0')


def test_missing_guard_blocks_connection(enabled_db):
    with closing(sqlite3.connect(enabled_db)) as external:
        external.execute('DROP TRIGGER transfer_guard_generation_update')
    with pytest.raises(transfer.TransferRecoveryRequired, match="guard"):
        db._connect(enabled_db)


def test_pending_backup_pair_restores_and_reconciles(enabled_db, tmp_path, monkeypatch):
    from app.services import backup
    monkeypatch.setattr(transfer, "checkpoint", lambda phase: (_ for _ in ()).throw(RuntimeError("stop")) if phase == "D2" else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash("g1")
    directory = tmp_path / 'backups'
    content_backup = backup._backup_now_for_scope(enabled_db, directory, 'test')
    trash_backup = directory / 'content_trash_test.db'
    transfer.validate_pair(content_backup, trash_backup)
    restored = tmp_path / 'restored'
    restored.mkdir()
    from app.services.backup_verify import create_sqlite_snapshot
    create_sqlite_snapshot(content_backup, restored / 'content_hub.db')
    create_sqlite_snapshot(trash_backup, restored / 'content_hub_trash.db')
    monkeypatch.setattr(transfer, 'checkpoint', lambda _: None)
    monkeypatch.setenv('CONTENT_HUB_DB', str(restored / 'content_hub.db'))
    db.init_db()
    assert counts() == (0,1)
    assert trash.restore_from_trash('g1')
    assert counts() == (1,0)


def test_manage_outbox_and_only_unsubmitted_requests_are_canceled(enabled_db, monkeypatch):
    monkeypatch.setattr(config, 'MANAGE_ENABLED', True)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO gen_request(id,account_email,gen_id,status) VALUES('pre','owner@example.invalid','g1','pending')")
        conn.execute("INSERT INTO gen_request(id,account_email,gen_id,status) VALUES('sent','owner@example.invalid','g1','running')")
    assert trash.move_to_trash('g1')
    with db.get_connection() as conn:
        assert dict(conn.execute('SELECT id,status FROM gen_request')) == {'pre':'canceled','sent':'running'}
        assert conn.execute("SELECT is_tombstone FROM telemetry_outbox WHERE local_gen_id='g1'").fetchone()[0] == 1
    assert trash.restore_from_trash('g1')
    with db.get_connection() as conn:
        assert dict(conn.execute('SELECT id,status FROM gen_request')) == {'pre':'canceled','sent':'running'}
        assert conn.execute("SELECT is_tombstone FROM telemetry_outbox WHERE local_gen_id='g1'").fetchone()[0] == 0


def test_activation_partial_state_blocks_startup_then_explicit_resume(tmp_path, monkeypatch):
    path = tmp_path / 'content_hub.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db()
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: (_ for _ in ()).throw(RuntimeError('stop')) if phase == 'activation_content_prepared' else None)
    with pytest.raises(RuntimeError, match='stop'):
        trash.activate_transfer(path, storage_evidence='fixture', writer_evidence='fixture')
    with pytest.raises(transfer.TransferRecoveryRequired, match='activation_incomplete'):
        db.init_db()
    monkeypatch.setattr(transfer, 'checkpoint', lambda _: None)
    trash.activate_transfer(path, storage_evidence='fixture', writer_evidence='fixture')
    db.init_db()


def test_single_or_mismatched_backup_pair_is_rejected(enabled_db, tmp_path):
    with pytest.raises(transfer.TransferRecoveryRequired, match='pair_required'):
        transfer.validate_pair(enabled_db, None)
    other = tmp_path / 'wrong.db'
    with closing(sqlite3.connect(other)) as conn:
        conn.execute('CREATE TABLE unrelated(id)')
    with pytest.raises(transfer.TransferRecoveryRequired, match='pair_incomplete'):
        transfer.validate_pair(enabled_db, other)


def test_scrub_clears_secrets_with_guards_and_never_swallows_pending(enabled_db, monkeypatch):
    from app.services.db_scrub import strip_transfer_secrets
    with db.get_connection() as conn:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('shared_server_token','synthetic-test-value')")
    strip_transfer_secrets(enabled_db)
    with db.get_connection() as conn:
        assert not conn.execute("SELECT 1 FROM app_setting WHERE key='shared_server_token'").fetchone()
        conn.execute("INSERT INTO app_setting(key,value) VALUES('shared_server_token','synthetic-test-value')")
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: (_ for _ in ()).throw(RuntimeError('stop')) if phase == 'D2' else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash('g1')
    with pytest.raises(sqlite3.IntegrityError, match='transfer_writer'):
        strip_transfer_secrets(enabled_db)


def test_checkpoint_api_keeps_pair_identity(enabled_db, tmp_path):
    from app.services.backup_verify import create_database_set_snapshot
    from app.schema_compat import inspect_database
    sources = {'content':enabled_db, 'trash':enabled_db.parent / 'content_hub_trash.db'}
    targets = {kind:tmp_path / 'checkpoint' / path.name for kind,path in sources.items()}
    create_database_set_snapshot(sources, targets)
    for kind in sources:
        assert inspect_database(sources[kind], kind).database_id == inspect_database(targets[kind], kind).database_id
    transfer.validate_pair(targets['content'], targets['trash'])


def test_current_connection_opened_before_activation_must_refresh_full(tmp_path, monkeypatch):
    path = tmp_path / 'content_hub.db'
    monkeypatch.setenv('CONTENT_HUB_DB', str(path))
    db.init_db()
    repo.ensure_default_worker()
    with closing(db._connect(path)) as old:
        assert old.execute('PRAGMA synchronous').fetchone()[0] == 1
        trash.activate_transfer(path, storage_evidence='fixture', writer_evidence='fixture')
        with pytest.raises(sqlite3.IntegrityError, match='transfer_writer'):
            old.execute("UPDATE worker SET name='changed' WHERE id='me'")
        transfer.configure_connection(old)
        assert old.execute('PRAGMA synchronous').fetchone()[0] == 2
        old.execute("UPDATE worker SET name='changed' WHERE id='me'")


def test_delete_receipt_is_tombstone_before_trash_finalization(enabled_db, monkeypatch):
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: (_ for _ in ()).throw(RuntimeError('stop')) if phase == 'D2' else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash('g1')
    with trash._with_trash() as conn:
        conn.execute('BEGIN IMMEDIATE')
        assert trash.tombstoned_among(conn, ['job1','unrelated']) == {'job1'}
    with pytest.raises(transfer.TransferRecoveryRequired, match='pending'):
        trash.resolve_missing_target('g1','r1','job1','owner@example.invalid',provider_kind='success')


def test_restore_never_overwrites_new_main_row(enabled_db):
    trash.move_to_trash('g1')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,status,created_at) VALUES('g1','me','newer','done','now')")
    with pytest.raises(transfer.TransferRecoveryRequired, match='target_conflict'):
        trash.restore_from_trash('g1')
    assert counts() == (1,1)
    with db.get_connection() as conn:
        assert conn.execute("SELECT prompt FROM generation WHERE id='g1'").fetchone()[0] == 'newer'


def test_legacy_content_cannot_be_paired_with_enabled_trash(enabled_db, tmp_path):
    legacy = tmp_path / 'legacy' / 'content.db'
    db.init_db(legacy)
    with pytest.raises(transfer.TransferRecoveryRequired, match='pair_mismatch'):
        transfer.validate_pair(legacy, enabled_db.parent / 'content_hub_trash.db')


def test_checkpoint_import_does_not_load_runtime_config():
    result = subprocess.run([sys.executable, '-c', "import sys; from app.services.backup_verify import create_database_set_snapshot; assert 'app.config' not in sys.modules"], timeout=20)
    assert result.returncode == 0


def test_actual_install_pair_reconciles_before_security_initialization(enabled_db, tmp_path, monkeypatch):
    from app.routers import db_transfer
    from app.services.backup_verify import create_database_set_snapshot
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: (_ for _ in ()).throw(RuntimeError('stop')) if phase == 'D2' else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash('g1')
    sources = {'content':enabled_db, 'trash':enabled_db.parent / 'content_hub_trash.db'}
    targets = {kind:tmp_path / 'incoming' / path.name for kind,path in sources.items()}
    create_database_set_snapshot(sources, targets)
    monkeypatch.setattr(transfer, 'checkpoint', lambda _: None)
    monkeypatch.setattr(db_transfer, 'AUTH_ENABLED', True)
    result = db_transfer._install_db(targets['content'], trash_tmp=targets['trash'], restore_trash_set=True)
    assert result['ok'] and result['relogin_required']
    assert counts() == (0,1)
    with db.get_connection() as conn:
        assert conn.execute("SELECT 1 FROM app_setting WHERE key='auth_secret'").fetchone()


def test_missing_enabled_marker_never_downgrades_to_legacy(enabled_db):
    with db.get_connection() as conn:
        conn.execute('DELETE FROM transfer_protocol')
    with pytest.raises(transfer.TransferRecoveryRequired, match='activation_incomplete'):
        db._connect(enabled_db)


def test_completed_trash_pending_main_never_starts_second_operation(enabled_db, monkeypatch):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,status,created_at) VALUES('g2','me','keep','done','now')")
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: (_ for _ in ()).throw(RuntimeError('stop')) if phase == 'D3' else None)
    with pytest.raises(RuntimeError):
        trash.move_to_trash('g1')
    with pytest.raises(transfer.TransferRecoveryRequired, match='pending'):
        trash.move_to_trash('g2')
    with closing(sqlite3.connect(enabled_db.parent / 'content_hub_trash.db')) as conn:
        assert conn.execute('SELECT COUNT(*) FROM move_operation').fetchone()[0] == 1
    monkeypatch.setattr(transfer, 'checkpoint', lambda _: None)
    trash.reconcile_with_main()
    assert trash.move_to_trash('g2')


def test_reconcile_preserves_existing_orphan_request_cleanup(enabled_db):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO gen_request(id,account_email,gen_id,status) VALUES('orphan','owner@example.invalid','gone','running')")
    trash.reconcile_with_main()
    with db.get_connection() as conn:
        assert conn.execute("SELECT status FROM gen_request WHERE id='orphan'").fetchone()[0] == 'canceled'
