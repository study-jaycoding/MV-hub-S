"""Restore fences: synthetic database only, no live server or filesystem restore."""
import json
import sqlite3
import threading
from contextlib import closing

import pytest

from app import db
from app import config
from app.routers import scenes as scene_router, edit_docs as edit_router, db_transfer
from app.services.scene_writer import SceneWriter
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.repo import edit_docs, scene_cards, scene_notebook, scenes_backup
from app.repo.share_commands import RestoreGenerationConflict
from test_scene_notebook import notebook_db, scene


def generation():
    with db.get_connection() as conn:
        return conn.execute("SELECT value FROM app_setting WHERE key='share_db_generation'").fetchone()[0]


def snapshot():
    with db.get_connection() as conn:
        return list(conn.iterdump())


@pytest.mark.parametrize('kind', ['start', 'sync', 'close', 'mirror', 'cards', 'edit', 'edit_restore'])
@pytest.mark.parametrize('supplied', [None, 'old-generation'])
def test_gate_rejects_before_any_write(notebook_db, kind, supplied):
    current = generation()
    scene_notebook.start('u', 'lease', {'attempt_id': 'seed', 'expected_count': 1,
        'upserts': [scene()], 'order': ['s'], 'commit': True, 'restore_generation': current})
    body = {'request_id': 'write', 'upserts': [scene(name='stale')], 'restore_generation': supplied}
    edit = json.dumps({'v': 1, 'clips': []})
    before = snapshot()
    with pytest.raises(RestoreGenerationConflict) as error:
        if kind == 'start':
            scene_notebook.start('u', 'lease', {'attempt_id': 'other', 'expected_count': 1,
                'upserts': [scene()], 'order': ['s'], 'commit': True, 'restore_generation': supplied})
        elif kind == 'sync':
            scene_notebook.sync('u', '', body)
        elif kind == 'close':
            scene_notebook.close_sync('u', '', {**body, 'restore_generation': current}, [body])
        elif kind == 'mirror':
            scenes_backup.sync_scene_backups('u', '', [scene()], [], restore_generation=supplied)
        elif kind == 'cards':
            scene_cards.sync_scene_card_links('u', [{'scene_id': 's', 'card_id': 'c', 'generation_id': 'g'}], [], restore_generation=supplied)
        elif kind == 'edit':
            edit_docs.save_edit_backup('u', 'p:s', edit, None, restore_generation=supplied)
        else:
            edit_docs.restore_edit_backup('u', 'p:s', None, data=edit, restore_generation=supplied)
    assert error.value.code == ('restore_generation_required' if supplied is None else 'restore_generation_changed')
    assert snapshot() == before


@pytest.fixture
def client(notebook_db, monkeypatch):
    monkeypatch.setattr(scene_router, 'actor_id', lambda request: 'u')
    monkeypatch.setattr(scene_router, 'writer', SceneWriter())
    app = FastAPI()
    app.include_router(scene_router.router)
    app.include_router(edit_router.router)
    with TestClient(app, headers={'X-MVHub-Expect-Account': 'local'}) as client:
        yield client


@pytest.mark.parametrize('kind', ['start', 'sync', 'close', 'mirror', 'cards', 'edit', 'edit_restore'])
@pytest.mark.parametrize('supplied,code', [(None, 409), ('old', 409), ('', 422), ('x' * 201, 422), (1, 422)])
def test_gate_http(client, monkeypatch, kind, supplied, code):
    if kind in ('start', 'sync', 'close'):
        token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()['token']
    else:
        monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '0')
        token = None
    common = {'restore_generation': supplied}
    if kind == 'start':
        method, path, body = 'POST', '/api/scenes/notebook/start', {'token': token, 'attempt_id': 'a', 'expected_count': 1, 'order': ['s'], 'upserts': [scene()], 'commit': True}
    elif kind in ('sync', 'close', 'mirror'):
        method = 'POST' if kind == 'close' else 'PUT'
        path = '/api/scenes/notebook/close' if kind == 'close' else '/api/scenes/backup'
        body = {'token': token, 'request_id': 'a', 'upserts': [scene()]}
    elif kind == 'cards':
        method, path, body = 'PUT', '/api/scenes/cards', {'removed': [{'scene_id': 's', 'card_id': 'c', 'generation_id': 'g'}]}
    else:
        method = 'POST' if kind == 'edit_restore' else 'PUT'
        path = '/api/edit-docs/backup' + ('/restore' if kind == 'edit_restore' else '')
        raw = json.dumps({'v': 1, 'clips': []})
        body = {'doc_key': 'doc', 'base_revision': None, **({'source': {'data': raw}} if kind == 'edit_restore' else {'data': raw})}
    before = snapshot()
    response = client.request(method, path, json={**body, **common})
    assert response.status_code == code, response.text
    if code == 409:
        assert response.json()['detail'] == ('restore_generation_required' if supplied is None else 'restore_generation_changed')
    assert snapshot() == before


@pytest.mark.parametrize('kind', ['mirror', 'cards', 'edit'])
def test_snapshot_generation_and_body_share_connection(client, monkeypatch, kind):
    original_generation = generation()
    edit_docs.save_edit_backup('local', 'doc', json.dumps({'v': 1, 'clips': []}), None, restore_generation=original_generation)
    module = edit_docs if kind == 'edit' else scene_router
    original = module.database_generation
    path = str(db.get_db_path())
    def rotate_after_body_read(conn):
        assert conn.in_transaction
        with closing(sqlite3.connect(path)) as other:
            other.execute("UPDATE app_setting SET value='new-generation' WHERE key='share_db_generation'")
            other.commit()
        return original(conn)
    monkeypatch.setattr(module, 'database_generation', rotate_after_body_read)
    route = {'mirror': '/api/scenes/backup?include_data=1', 'cards': '/api/scenes/cards', 'edit': '/api/edit-docs/backup?doc_key=doc&include_data=1'}[kind]
    response = client.get(route)
    assert response.status_code == 200, response.text
    assert response.json()['restore_generation'] == original_generation
    assert generation() == 'new-generation'


def test_snapshot_notebook_returns_generation_in_its_transaction(notebook_db, monkeypatch):
    original = scene_notebook.database_generation
    def checked(conn):
        assert conn.in_transaction
        return original(conn)
    monkeypatch.setattr(scene_notebook, 'database_generation', checked)
    assert scene_notebook.notebook('u')['restore_generation'] == generation()


@pytest.mark.parametrize('enabled', [False, True])
@pytest.mark.parametrize('failure', [False, True])
def test_install_rotation_and_security_rollback(notebook_db, monkeypatch, enabled, failure):
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '1' if enabled else '0')
    monkeypatch.setattr(db_transfer, 'AUTH_ENABLED', True)  # no real active-account pointer access
    monkeypatch.setattr(db_transfer, 'DATA_DIR', notebook_db)
    monkeypatch.setattr(config, 'DATA_DIR', notebook_db)
    original_generation = generation()
    with db.get_connection() as conn:
        original_history = scene_notebook.history(conn)
        conn.execute("INSERT INTO app_setting(key,value) VALUES('restore_test_marker','original')")
    db.init_db()
    assert generation() == original_generation
    incoming = notebook_db / 'incoming.db'
    db.init_db(incoming)
    with closing(sqlite3.connect(incoming)) as conn:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('restore_test_marker','incoming')")
        conn.commit()
        input_history = scene_notebook.history(conn)
        input_generation = conn.execute("SELECT value FROM app_setting WHERE key='share_db_generation'").fetchone()[0]
    if failure:
        original_security = db_transfer._post_install_security_init
        def fail(path):
            original_security(path)
            raise RuntimeError('synthetic security failure')
        monkeypatch.setattr(db_transfer, '_post_install_security_init', fail)
        with pytest.raises(RuntimeError, match='synthetic security failure'):
            db_transfer._install_db(incoming)
    else:
        assert db_transfer._install_db(incoming)['ok']
    with db.get_connection() as conn:
        marker = conn.execute("SELECT value FROM app_setting WHERE key='restore_test_marker'").fetchone()[0]
        restored_history = scene_notebook.history(conn)
    assert marker == ('original' if failure else 'incoming')
    if failure:
        assert generation() == original_generation and restored_history == original_history
    else:
        assert generation() not in (original_generation, input_generation)
        assert (restored_history != input_history) == enabled


def test_concurrency_write_waiting_for_rotation_cannot_use_old_generation(notebook_db):
    old_generation, errors = generation(), []
    started = threading.Event()
    def waiting_writer():
        started.set()
        try:
            edit_docs.save_edit_backup('u', 'doc', json.dumps({'v': 1, 'clips': []}), None, restore_generation=old_generation)
        except RestoreGenerationConflict as error:
            errors.append(error.code)
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        worker = threading.Thread(target=waiting_writer)
        worker.start()
        assert started.wait(2)
        conn.execute("UPDATE app_setting SET value='rotated' WHERE key='share_db_generation'")
        conn.commit()
    worker.join(5)
    assert not worker.is_alive() and errors == ['restore_generation_changed']
    assert edit_docs.get_edit_backup('u', 'doc')['head'] is None


def test_gate_checks_generation_before_replaying_receipt_and_every_close_item(notebook_db):
    current = generation()
    start = {'attempt_id': 'seed', 'expected_count': 1, 'upserts': [scene()], 'order': ['s'], 'commit': True, 'restore_generation': current}
    scene_notebook.start('u', 'lease', start)
    first = {'request_id': 'first', 'upserts': [scene(name='first')], 'restore_generation': current}
    scene_notebook.sync('u', '', first)
    with db.get_connection() as conn:
        conn.execute("UPDATE app_setting SET value='rotated' WHERE key='share_db_generation'")
    before = snapshot()
    for operation in [lambda: scene_notebook.start('u', 'lease', start), lambda: scene_notebook.sync('u', '', first)]:
        with pytest.raises(RestoreGenerationConflict):
            operation()
        assert snapshot() == before
    pending = [{'request_id': 'valid', 'upserts': [scene(name='must-not-write')], 'restore_generation': 'rotated'}, first]
    with pytest.raises(RestoreGenerationConflict):
        scene_notebook.close_sync('u', '', {'request_id': 'close', 'restore_generation': 'rotated'}, pending)
    assert snapshot() == before


@pytest.mark.parametrize('invalid', [None, '', 'x' * 201])
def test_gate_missing_or_invalid_server_generation_is_not_created(notebook_db, invalid):
    with db.get_connection() as conn:
        if invalid is None:
            conn.execute("DELETE FROM app_setting WHERE key='share_db_generation'")
        else:
            conn.execute("UPDATE app_setting SET value=? WHERE key='share_db_generation'", (invalid,))
    before = snapshot()
    with pytest.raises(RuntimeError, match='generation is unavailable'):
        edit_docs.save_edit_backup('u', 'doc', json.dumps({'v': 1, 'clips': []}), None, restore_generation=invalid)
    assert snapshot() == before
