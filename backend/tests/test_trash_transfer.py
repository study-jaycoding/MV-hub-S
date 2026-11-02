"""B1 is activated only on synthetic temporary databases in these tests."""
from contextlib import closing, contextmanager
import json
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
    # python -c 는 현재 폴더만 모듈 경로에 넣는다 — pytest 의 pythonpath 는 자식에게 안 간다.
    result = subprocess.run([sys.executable, "-c", script, str(enabled_db), phase, action], cwd=config.BACKEND_DIR, env=dict(os.environ), timeout=20)
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
    result = subprocess.run([sys.executable, '-c', "import sys; from app.services.backup_verify import create_database_set_snapshot; assert 'app.config' not in sys.modules"], cwd=config.BACKEND_DIR, timeout=20)
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


@pytest.fixture
def scene_keep_restore_client(enabled_db, monkeypatch):
    """Real B1 moves and route; only the remote envelope and account are synthetic."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import scene_keeps

    owner = 'scene-keep@example.invalid'
    with db.get_connection() as conn:
        # The standard fixture uses a deliberately nonexistent local media file.
        # This flow needs a usable result according to the real trash predicate.
        conn.execute("UPDATE asset SET file_path='https://example.invalid/original-g1.png' WHERE id='a1'")
        conn.execute("INSERT INTO generation(id,worker_id,prompt,status,created_at,job_id) "
                     "VALUES('g2','me','second original','done','2026-10-18','job2')")
        conn.execute("INSERT INTO asset(id,generation_id,type,file_path) "
                     "VALUES('a2','g2','image','https://example.invalid/original-g2.png')")
    assert trash.move_to_trash('g1')
    assert trash.move_to_trash('g2')

    items = [
        {'id': gid, 'scene_ids': [gid], 'job_id': f'job{index}', 'source': 'local',
         'status': 'done', 'prompt': f'snapshot-{gid}', 'created_at': '2026-10-18T00:00:00Z',
         'creator_uid': None, 'assets': [{'type': 'image', 'file_path': f'https://example.invalid/snapshot-{gid}.png'}]}
        for index, gid in enumerate(('g1', 'g2', 'g3'), 1)
    ]
    envelope = {'v': 1, 'scene_text': json.dumps({
        'format': 'mv-scene', 'version': 1, 'savedAt': 0,
        'scene': {'name': 'B1 scene', 'cards': [{'id': 'card', 'genIds': ['g1', 'g2', 'g3']}],
                  'edges': [], 'groups': [], 'camera': {'x': 0, 'y': 0, 'zoom': 1}},
    }), 'generations': items}

    @contextmanager
    def relay(request, *, write):
        assert write
        yield owner

    fetches = []

    def fetch(method, path, *, params):
        assert method == 'GET'
        assert path == '/api/scene-keeps/' + 'a' * 32 + '/envelope'
        assert params == {'revision': 1}
        fetches.append(path)
        return envelope

    monkeypatch.setattr(config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(scene_keeps, '_relay', relay)
    monkeypatch.setattr(scene_keeps, 'require_agent_account', lambda request: {'email': owner})
    monkeypatch.setattr(scene_keeps._proxy, 'proxy_json', fetch)
    app = FastAPI()
    app.include_router(scene_keeps.router)
    with TestClient(app) as client:
        yield client, fetches


def _scene_keep_b1_state():
    with db.get_connection() as conn:
        main = dict(conn.execute("SELECT id,prompt FROM generation WHERE id IN ('g1','g2','g3')"))
        assets = dict(conn.execute("SELECT generation_id,id FROM asset WHERE generation_id IN ('g1','g2','g3')"))
        pending = conn.execute('SELECT COUNT(*) FROM generation_transfer').fetchone()[0]
    with closing(sqlite3.connect(db.get_db_path().parent / 'content_hub_trash.db')) as conn:
        trashed = {row[0] for row in conn.execute("SELECT id FROM trashed WHERE id IN ('g1','g2','g3')")}
        prepared = conn.execute("SELECT COUNT(*) FROM move_operation WHERE phase='prepared'").fetchone()[0]
        g2_restore_operations = conn.execute("SELECT COUNT(*) FROM move_operation "
                                             "WHERE generation_id='g2' AND direction='restore'").fetchone()[0]
    return main, assets, trashed, pending, prepared, g2_restore_operations


@pytest.mark.parametrize('phase', ['R0', 'R1', 'R2'])
def test_scene_keep_b1_interruption_reconciles_before_next_item_and_retry(scene_keep_restore_client, monkeypatch, phase):
    client, fetches = scene_keep_restore_client
    interrupted = []

    def interrupt_once(where):
        if where == phase and not interrupted:
            interrupted.append(where)
            raise sqlite3.OperationalError('synthetic scene-keep interruption')

    monkeypatch.setattr(transfer, 'checkpoint', interrupt_once)
    response = client.post('/api/scene-keeps/restore', json={'id': 'a' * 32, 'revision': 1})
    assert response.status_code == 200, response.text
    assert interrupted == [phase]
    result = response.json()
    assert result['restored'] == 1  # Only g3 is inserted from the envelope.
    assert result['id_map']['g2'] == 'g2' and result['id_map']['g3'] == 'g3'
    main, assets, trashed, pending, prepared, g2_operations = _scene_keep_b1_state()
    assert main['g2'] == 'second original' and assets['g2'] == 'a2'
    assert pending == prepared == 0 and g2_operations == 1
    if phase == 'R0':
        # No main commit: reconciliation cancels the prepared restore and keeps g1.
        assert result['rejected'] == ['g1'] and 'g1' not in result['id_map']
        assert 'g1' not in main and trashed == {'g1'}
    else:
        assert result['rejected'] == [] and result['id_map']['g1'] == 'g1'
        assert main['g1'] == 'kept' and assets['g1'] == 'a1' and trashed == set()

    # The same failure hook remains installed; it fires only once. A new load must
    # resume g1 after R0 and be idempotent after the committed R1/R2 failures.
    again = client.post('/api/scene-keeps/restore', json={'id': 'a' * 32, 'revision': 1})
    assert again.status_code == 200, again.text
    assert again.json() == {'id_map': {'g1': 'g1', 'g2': 'g2', 'g3': 'g3'}, 'rejected': [], 'restored': 0}
    main, assets, trashed, pending, prepared, g2_operations = _scene_keep_b1_state()
    assert main == {'g1': 'kept', 'g2': 'second original', 'g3': 'snapshot-g3'}
    assert assets['g1'] == 'a1' and assets['g2'] == 'a2'
    assert len(assets) == 3 and trashed == set() and pending == prepared == 0
    assert g2_operations == 1 and len(fetches) == 2


def test_scene_keep_b1_reconcile_failure_stops_writes_with_409_then_resumes(scene_keep_restore_client, monkeypatch):
    client, fetches = scene_keep_restore_client
    interrupted = []

    def interrupt_restore_then_reconcile(where):
        if where == 'R1' and not interrupted:
            interrupted.append('restore')
            raise sqlite3.OperationalError('synthetic restore interruption')
        if where == 'R2' and interrupted == ['restore']:
            interrupted.append('reconcile')
            raise sqlite3.OperationalError('synthetic reconcile interruption')

    monkeypatch.setattr(transfer, 'checkpoint', interrupt_restore_then_reconcile)
    response = client.post('/api/scene-keeps/restore', json={'id': 'a' * 32, 'revision': 1})
    assert response.status_code == 409, response.text
    assert response.json()['detail'] == '잠시 뒤 다시 열어 주세요'
    assert interrupted == ['restore', 'reconcile']
    main, assets, trashed, pending, prepared, g2_operations = _scene_keep_b1_state()
    assert main == {'g1': 'kept'} and assets == {'g1': 'a1'}
    assert trashed == {'g2'} and pending == 1 and prepared == 0
    # Nothing after the unclean g1 operation may start, including envelope g3.
    assert g2_operations == 0

    again = client.post('/api/scene-keeps/restore', json={'id': 'a' * 32, 'revision': 1})
    assert again.status_code == 200, again.text
    assert again.json() == {'id_map': {'g1': 'g1', 'g2': 'g2', 'g3': 'g3'}, 'rejected': [], 'restored': 1}
    main, assets, trashed, pending, prepared, g2_operations = _scene_keep_b1_state()
    assert main == {'g1': 'kept', 'g2': 'second original', 'g3': 'snapshot-g3'}
    assert assets['g1'] == 'a1' and assets['g2'] == 'a2' and len(assets) == 3
    assert trashed == set() and pending == prepared == 0
    assert g2_operations == 1 and len(fetches) == 2


def test_scene_keep_b1_pending_delete_is_not_admitted_after_reconciliation(scene_keep_restore_client, monkeypatch):
    client, _ = scene_keep_restore_client
    assert trash.restore_from_trash('g1')

    def interrupt_delete(phase):
        if phase == 'D2':
            raise sqlite3.OperationalError('unfinished delete')

    monkeypatch.setattr(transfer, 'checkpoint', interrupt_delete)
    with pytest.raises(sqlite3.OperationalError, match='unfinished delete'):
        trash.move_to_trash('g1')
    monkeypatch.setattr(transfer, 'checkpoint', lambda phase: None)
    response = client.post('/api/scene-keeps/restore', json={'id': 'a' * 32, 'revision': 1})
    assert response.status_code == 200, response.text
    assert response.json() == {'id_map': {'g2': 'g2', 'g3': 'g3'}, 'rejected': ['g1'], 'restored': 1}
    main, _, trashed, pending, prepared, _ = _scene_keep_b1_state()
    assert 'g1' not in main and trashed == {'g1'} and pending == prepared == 0
