import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import config, db
from app.repo import scene_notebook as store, scenes_backup as legacy, mcp_v2
from app.routers import scenes
from app.services.scene_writer import SceneWriter, WriterConflict
from test_scene_notebook import notebook_db, seed, scene, base, push


@pytest.fixture
def client(notebook_db, monkeypatch):
    monkeypatch.setattr(scenes, 'actor_id', lambda request: 'u')
    monkeypatch.setattr(scenes, 'writer', SceneWriter())
    app = FastAPI()
    app.include_router(scenes.router)
    with TestClient(app) as client:
        yield client


def test_http_token_gate_start_retry_and_legacy_get(client, monkeypatch):
    assert client.put('/api/scenes/backup', json={'upserts': [scene()]}).status_code == 409
    lease = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()
    body = {'token': lease['token'], 'attempt_id': 'a', 'expected_count': 1, 'order': ['s'], 'upserts': [scene()], 'commit': True}
    first = client.post('/api/scenes/notebook/start', json=body)
    assert first.status_code == 200, first.text
    assert client.post('/api/scenes/notebook/start', json=body).json() == first.json()
    state = client.get('/api/scenes/notebook').json()
    result = client.put('/api/scenes/backup', json={'token': lease['token'], 'request_id': 'd',
        'deletes': [{'id': 's', 'intent_id': 'd1', 'base': state['items'][0]['base']}]})
    assert result.status_code == 200, result.text
    assert client.get('/api/scenes/backup?include_data=true').json()['items'] == []
    monkeypatch.delenv('CONTENT_HUB_SCENE_WRITER_TEST')
    assert client.put('/api/scenes/backup', json={'upserts': [scene()]}).status_code == 409
    assert client.post('/api/scenes/writer', json={'action': 'release', 'token': lease['token']}).status_code == 200
    assert client.put('/api/scenes/backup', json={'token': lease['token'], 'request_id': 'late', 'upserts': [scene()]}).status_code == 409


def test_flag_off_and_auth_on_keep_legacy_contract(client, monkeypatch):
    monkeypatch.delenv('CONTENT_HUB_SCENE_WRITER_TEST')
    assert client.post('/api/scenes/writer', json={'action': 'status'}).status_code == 404
    assert client.put('/api/scenes/backup', json={'upserts': [scene()]}).status_code == 200
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER_TEST', '1')
    monkeypatch.setattr(config, 'AUTH_ENABLED', True)
    assert client.post('/api/scenes/writer', json={'action': 'status'}).status_code == 404
    assert client.put('/api/scenes/backup', json={'upserts': [scene(name='auth')]}).status_code == 200


def test_start_oversize_releases_lease_and_keeps_old_rows(client):
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()['token']
    result = client.post('/api/scenes/notebook/start', json={'token': token, 'attempt_id': 'huge', 'expected_count': 1,
        'order': ['s'], 'upserts': [scene(padding='x' * store.MAX_SCENE_BYTES)], 'commit': True})
    assert result.status_code == 413
    assert result.json()['detail']['local_edit_only']
    assert client.post('/api/scenes/writer', json={'action': 'status'}).json()['writer'] is None
    assert not store.is_started('u')


def task(task_id='task', sid='s'):
    with db.get_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO mcp_client(id,secret_hash,hub_id,owner_uid,account_email,workspace,name) VALUES('client','hash','hub','u','u@example.test','{}','test')")
        conn.execute("INSERT OR IGNORE INTO mcp_generation_plan(id,client_id,owner_uid,account_email,workspace,title,items) VALUES('plan','client','u','u@example.test','{}','plan','[]')")
        conn.execute("INSERT INTO mcp_canvas_task(id,plan_id,owner_uid,account_email,workspace,scene_id,generation_ids) VALUES(?,'plan','u','u@example.test','{}',?,'[\"g\"]')", (task_id, sid))


def test_mcp_done_requires_original_scene_receipt_and_is_atomic(notebook_db):
    seed()
    task()
    with pytest.raises(WriterConflict):
        mcp_v2.complete_canvas_task('task', 'u', 'u@example.test', {'scope':'personal'})
    result = push('no-proof', upserts=[{**scene(name='Y'), 'base': base()}], mcp_complete=['task'])
    assert result['mcp_done'] == []
    receipt_scene = scene(name='Y', mcpAttachmentReceipts=['task'])
    assert push('proof', upserts=[{**receipt_scene, 'base': base()}], mcp_complete=['task'])['mcp_done'] == ['task']
    assert push('same', upserts=[{**receipt_scene, 'base': base()}], mcp_complete=['task'])['mcp_done'] == ['task']


def test_start_cancels_only_hidden_mcp_tasks(notebook_db):
    legacy.sync_scene_backups('u', '', [scene(), scene('hidden')], [])
    task('keep', 's')
    task('hide', 'hidden')
    seed()
    with db.get_connection() as conn:
        rows = {r['id']: (r['status'], r['cancel_reason']) for r in conn.execute('SELECT * FROM mcp_canvas_task')}
    assert rows == {'keep': ('pending', None), 'hide': ('cancelled', 'scene_hidden')}


def test_copied_scene_cannot_finish_original_mcp_and_delete_cancels(notebook_db):
    seed()
    task()
    old = base()
    push('edit', upserts=[{**scene(name='new'), 'base': old}])
    result = push('fork', upserts=[{**scene(name='stale', mcpAttachmentReceipts=['task']), 'base': old}], mcp_complete=['task'])
    assert result['results'][0]['status'] == 'copied'
    assert result['mcp_done'] == []
    push('delete', deletes=[{'id': 's', 'intent_id': 'd', 'base': base()}])
    with db.get_connection() as conn:
        row = conn.execute("SELECT status,cancel_reason FROM mcp_canvas_task WHERE id='task'").fetchone()
        assert tuple(row) == ('cancelled', 'scene_deleted')


def test_legacy_complete_route_returns_409(notebook_db):
    import asyncio
    from types import SimpleNamespace
    from uuid import uuid4
    from fastapi import HTTPException
    from app.routers import mcp_v2 as api
    seed()
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.complete_task(uuid4(), api.CompleteIn(workspace={'scope':'personal'}),
                                    SimpleNamespace(owner='u', account={'email':'u@example.test'})))
    assert error.value.status_code == 409


def test_mcp_add_refuses_tombstone(notebook_db):
    seed()
    task()
    push('delete', deletes=[{'id': 's', 'intent_id': 'd', 'base': base()}])
    with db.get_connection() as conn:
        client = dict(conn.execute("SELECT * FROM mcp_client WHERE id='client'").fetchone())
    client['workspace'] = json.dumps({'scope':'personal'})
    with pytest.raises(LookupError, match='scene is gone'):
        mcp_v2.add_canvas_task(client, 'plan', 's', ['g'], {'scope':'personal'})


def test_mcp_update_failure_rolls_back_scene_and_receipt(notebook_db):
    import sqlite3
    seed()
    task()
    original = base()
    with db.get_connection() as conn:
        conn.execute("CREATE TRIGGER fail_mcp_done BEFORE UPDATE ON mcp_canvas_task WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected'); END")
    with pytest.raises(sqlite3.IntegrityError, match='injected'):
        push('atomic', upserts=[{**scene(name='Y', mcpAttachmentReceipts=['task']), 'base': original}], mcp_complete=['task'])
    assert base() == original
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM scene_request_receipt').fetchone()[0] == 0
        assert conn.execute("SELECT status FROM mcp_canvas_task WHERE id='task'").fetchone()[0] == 'pending'


def test_late_start_commit_with_replaced_lease_is_rejected(client):
    lease = client.post('/api/scenes/writer', json={'action':'claim', 'browser_id':'one', 'tab_id':'t'}).json()
    body = {'token':lease['token'], 'attempt_id':'a', 'expected_count':1, 'order':['s'], 'upserts':[scene()]}
    assert client.post('/api/scenes/notebook/start', json=body).status_code == 200
    assert client.post('/api/scenes/writer', json={'action':'release','token':lease['token']}).status_code == 200
    client.post('/api/scenes/writer', json={'action':'claim','browser_id':'two','tab_id':'t'})
    assert client.post('/api/scenes/notebook/start', json={**body, 'commit':True}).status_code == 409
    assert not store.is_started('u')


def test_account_epoch_aba_invalidates_http_upload(client):
    from app import active_account
    lease = client.post('/api/scenes/writer', json={'action':'claim','browser_id':'one','tab_id':'t'}).json()
    body = {'token':lease['token'], 'attempt_id':'a', 'expected_count':1, 'order':['s'], 'upserts':[scene()], 'commit':True}
    assert client.post('/api/scenes/notebook/start', json=body).status_code == 200
    original = base()
    active_account.bump_account_epoch()
    active_account.bump_account_epoch()
    response = client.put('/api/scenes/backup', json={'token':lease['token'], 'request_id':'stale',
        'upserts':[{**scene(name='lost-owner'), 'base':original}]})
    assert response.status_code == 409
    assert base() == original
