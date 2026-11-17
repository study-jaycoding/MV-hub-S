from test_scene_notebook import restore_generation
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
    with TestClient(app, headers={'X-MVHub-Canvas-Protocol': 'confirm-v1'}) as client:
        yield client


def test_http_token_gate_start_retry_and_legacy_get(client, monkeypatch):
    assert client.put('/api/scenes/backup', json={**{'upserts': [scene()]}, 'restore_generation': restore_generation()}).status_code == 409
    lease = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()
    body = {'token': lease['token'], 'attempt_id': 'a', 'expected_count': 1, 'order': ['s'], 'upserts': [scene()], 'commit': True}
    first = client.post('/api/scenes/notebook/start', json={**body, 'restore_generation': restore_generation()})
    assert first.status_code == 200, first.text
    assert client.post('/api/scenes/notebook/start', json={**body, 'restore_generation': restore_generation()}).json() == first.json()
    state = client.get('/api/scenes/notebook').json()
    result = client.put('/api/scenes/backup', json={**{'token': lease['token'], 'request_id': 'd',
        'deletes': [{'id': 's', 'intent_id': 'd1', 'base': state['items'][0]['base']}]}, 'restore_generation': restore_generation()})
    assert result.status_code == 200, result.text
    assert client.get('/api/scenes/backup?include_data=true').json()['items'] == []
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '0')
    assert client.put('/api/scenes/backup', json={**{'upserts': [scene()]}, 'restore_generation': restore_generation()}).status_code == 409
    assert client.post('/api/scenes/writer', json={'action': 'release', 'token': lease['token']}).status_code == 200
    assert client.put('/api/scenes/backup', json={**{'token': lease['token'], 'request_id': 'late', 'upserts': [scene()]}, 'restore_generation': restore_generation()}).status_code == 409


def test_open_1011_tab_cannot_read_adopt_claim_start_or_close_without_confirmation_protocol(client):
    seed()
    lease = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'new', 'tab_id': 'new'}).json()
    before = store.notebook('u')
    client.headers.pop('X-MVHub-Canvas-Protocol')
    calls = [
        client.get('/api/scenes/notebook'),
        client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'old', 'tab_id': 'old'}),
        client.post('/api/scenes/notebook/start', json={'token': lease['token'], 'attempt_id': 'old', 'expected_count': 0, 'commit': True}),
        client.post('/api/scenes/notebook/close', json={'token': lease['token'], 'request_id': 'old', 'upserts': [scene(name='old')]}),
        client.put('/api/scenes/backup', json={'token': lease['token'], 'request_id': 'old', 'upserts': [scene(name='old')]}),
    ]
    assert [(reply.status_code, reply.json()['detail']) for reply in calls] == [(409, 'canvas_client_update_required')] * len(calls)
    assert store.notebook('u') == before
    assert client.get('/api/scenes/backup?include_data=true').status_code == 200
    # An old unload beacon may release its own token, but cannot read or replace canvas content.
    assert client.post('/api/scenes/writer', json={'action': 'release', 'token': lease['token']}).status_code == 200


def test_flag_off_and_auth_on_keep_legacy_contract(client, monkeypatch):
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '0')
    assert client.post('/api/scenes/writer', json={'action': 'status'}).status_code == 404
    assert client.put('/api/scenes/backup', json={**{'upserts': [scene()]}, 'restore_generation': restore_generation()}).status_code == 200
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '1')
    monkeypatch.setattr(config, 'AUTH_ENABLED', True)
    assert client.post('/api/scenes/writer', json={'action': 'status'}).status_code == 404
    assert client.put('/api/scenes/backup', json={**{'upserts': [scene(name='auth')]}, 'restore_generation': restore_generation()}).status_code == 200


def test_close_persists_final_edit_delete_order_then_releases(client):
    seed(items=[scene('s'), scene('gone'), scene('last')])
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    before = client.get('/api/scenes/notebook').json()
    order = before['order']
    result = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'close',
        'upserts': [{**scene(name='last edit'), 'base': base()}],
        'deletes': [{'id': 'gone', 'intent_id': 'delete-on-close', 'base': base('gone')}],
        'order': {**order, 'ids': ['last', 's']},
    }, 'restore_generation': restore_generation()})
    assert result.status_code == 200, result.text
    assert result.json()['released']
    assert result.headers['X-MVHub-Scene-Writer-Changed'] == '1'
    # A second browser can claim only after the delta is durable.
    assert client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 'b'}).status_code == 200
    after = client.get('/api/scenes/notebook').json()
    live = {item['id']: json.loads(item['data']) for item in after['items'] if not item['deleted_at']}
    assert live['s']['name'] == 'last edit'
    assert 'gone' not in live
    assert after['order']['ids'] == ['last', 's']
    # Late release/write, even an exact close retry, cannot affect the new owner.
    assert client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'late', 'upserts': [scene(name='late')],
    }, 'restore_generation': restore_generation()}).status_code == 409


def test_failed_close_rolls_back_and_keeps_lease(client):
    seed()
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    order = client.get('/api/scenes/notebook').json()['order']
    result = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'bad-close', 'upserts': [{**scene(name='bad'), 'base': base()}],
        'order': {**order, 'ids': ['s', 's']},
    }, 'restore_generation': restore_generation()})
    assert result.status_code == 400
    assert json.loads(store.notebook('u')['items'][0]['data'])['name'] == 'X'
    assert client.post('/api/scenes/writer', json={'action': 'renew', 'token': token}).status_code == 200
    with db.get_connection() as conn:
        assert not conn.execute("SELECT 1 FROM scene_request_receipt WHERE request_id='bad-close'").fetchone()


def test_close_reuses_saved_request_receipt_before_releasing(client):
    seed()
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    payload = {'token': token, 'request_id': 'lost-response', 'upserts': [{**scene(name='saved'), 'base': base()}]}
    first = client.put('/api/scenes/backup', json={**payload, 'restore_generation': restore_generation()})
    assert first.status_code == 200
    closed = client.post('/api/scenes/notebook/close', json={**payload, 'restore_generation': restore_generation()})
    assert closed.status_code == 200, closed.text
    assert closed.json() == {**first.json(), 'released': True}
    assert client.post('/api/scenes/writer', json={'action': 'status'}).json()['writer'] is None


@pytest.mark.parametrize('already_saved', [False, True])
def test_close_replays_inflight_edit_and_rebases_final_edit_delete_order(client, already_saved):
    seed(items=[scene('s'), scene('gone'), scene('last')])
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    original, gone = base(), base('gone')
    order = client.get('/api/scenes/notebook').json()['order']
    pending = {'restore_generation': restore_generation(), 'token': token, 'request_id': 'in-flight',
        'upserts': [{**scene(name='middle'), 'base': original}, {**scene('gone', name='middle'), 'base': gone}],
        'order': {**order, 'ids': ['last', 'gone', 's']}}
    if already_saved:
        assert client.put('/api/scenes/backup', json={**pending, 'restore_generation': restore_generation()}).status_code == 200
    closed = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'close-after-inflight', 'pending_requests': [pending],
        'upserts': [{**scene(name='final'), 'base': original}],
        'deletes': [{'id': 'gone', 'intent_id': 'final-delete', 'base': gone}],
        'order': {**order, 'ids': ['s', 'last']},
    }, 'restore_generation': restore_generation()})
    assert closed.status_code == 200, closed.text
    assert closed.json()['results'][0]['status'] == 'saved'
    assert closed.json()['deletes'][0]['status'] == 'deleted'
    state = store.notebook('u')
    assert len(state['items']) == 3  # original rows only, no conflict copies
    assert json.loads(next(item for item in state['items'] if item['id'] == 's')['data'])['name'] == 'final'
    assert state['order']['ids'] == ['s', 'last']


def test_close_pending_and_final_failure_are_one_transaction(client):
    seed()
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    original = base()
    pending = {'restore_generation': restore_generation(), 'request_id': 'pending-rollback', 'upserts': [{**scene(name='middle'), 'base': original}]}
    order = client.get('/api/scenes/notebook').json()['order']
    closed = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'final-rollback', 'pending_requests': [pending],
        'upserts': [{**scene(name='final'), 'base': original}], 'order': {**order, 'ids': ['s', 's']},
    }, 'restore_generation': restore_generation()})
    assert closed.status_code == 400
    assert base() == original
    assert client.post('/api/scenes/writer', json={'action': 'renew', 'token': token}).status_code == 200
    with db.get_connection() as conn:
        assert not conn.execute("SELECT 1 FROM scene_request_receipt WHERE request_id IN ('pending-rollback','final-rollback')").fetchone()


@pytest.mark.parametrize('order_proof', ['exact', 'absent', 'mismatch'])
def test_close_preserves_last_reorder_after_inflight_add_advanced_order(client, order_proof):
    seed(items=[scene('s'), scene('last')])
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    original_order = client.get('/api/scenes/notebook').json()['order']
    pending_add = {'restore_generation': restore_generation(), 'request_id': 'add-before-close', 'upserts': [scene('new')]}
    add_receipt = client.put('/api/scenes/backup', json={**{**pending_add, 'token': token}, 'restore_generation': restore_generation()}).json()
    # Normal sync has already persisted its revised outgoing order request,
    # but local metadata still has the pre-upload frozen order base.
    pending_order = {'restore_generation': restore_generation(), 'request_id': 'order-before-close', 'order': {
        **add_receipt['order'], 'ids': ['s', 'new', 'last'],
    }}
    assert client.put('/api/scenes/backup', json={**{**pending_order, 'token': token}, 'restore_generation': restore_generation()}).status_code == 200
    payload = {'token': token, 'request_id': 'close-last-order',
        'pending_requests': [pending_add, pending_order],
        'order': {**original_order, 'ids': ['last', 'new', 's']}}
    if order_proof != 'absent':
        payload['pending_order_base'] = {
            'history_id': original_order['history_id'],
            'rev': original_order['rev'] + (1 if order_proof == 'mismatch' else 0),
        }
    result = client.post('/api/scenes/notebook/close', json={**payload, 'restore_generation': restore_generation()})
    assert result.status_code == 200, result.text
    expected = ['last', 'new', 's'] if order_proof == 'exact' else ['s', 'new', 'last']
    assert result.json()['order']['ids'] == expected
    if order_proof == 'exact':
        # The same close body can be retried under a new valid lease: rebasing
        # changes no receipt hash and does not increment the order twice.
        new_token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
        retried = client.post('/api/scenes/notebook/close', json={**{**payload, 'token': new_token}, 'restore_generation': restore_generation()})
        assert retried.status_code == 200, retried.text
        assert retried.json() == result.json()


def test_start_oversize_releases_lease_and_keeps_old_rows(client):
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()['token']
    result = client.post('/api/scenes/notebook/start', json={**{'token': token, 'attempt_id': 'huge', 'expected_count': 1,
        'order': ['s'], 'upserts': [scene(padding='x' * store.MAX_SCENE_BYTES)], 'commit': True}, 'restore_generation': restore_generation()})
    assert result.status_code == 413
    assert result.headers['X-MVHub-Scene-Writer-Changed'] == '1'
    assert result.json()['detail']['local_edit_only']
    assert client.post('/api/scenes/writer', json={'action': 'status'}).json()['writer'] is None
    assert not store.is_started('u')


@pytest.mark.parametrize('with_live_scene_and_card_link', [False, True])
def test_real_schema_worker_set_passes_public_manifest_normalization(
    notebook_db, monkeypatch, with_live_scene_and_card_link,
):
    from app import active_account
    from app.services import worker_backup
    from app.routers.db_backup import _normalise_set_manifest
    seed()
    push('delete', deletes=[{'id': 's', 'intent_id': 'd', 'base': base()}])
    if with_live_scene_and_card_link:
        push('live', upserts=[scene('live')])
        with db.get_connection() as conn:
            conn.execute("INSERT INTO scene_card_generation(owner_uid,scene_id,card_id,generation_id) VALUES('u','live','c','g')")
    monkeypatch.setattr(worker_backup, 'STATE_DB', notebook_db / 'worker-state.db')
    monkeypatch.setattr(worker_backup, 'OUTBOX_DIR', notebook_db / 'outbox')
    monkeypatch.setattr(worker_backup, 'DEVICE_IDENTITY_PATH', notebook_db / 'device.json')
    # Copy real schema bytes, not the simplified legacy fixture that hid this regression.
    import sqlite3
    from contextlib import closing
    path = notebook_db / 'content_hub_20261109_010101_000001.db'
    with db.get_connection() as conn, closing(sqlite3.connect(path)) as dest:
        conn.backup(dest)
    set_id = worker_backup.queue_backup_set(path, account_email='u@example.test')
    assert set_id  # tombstone-only metadata still merits a backup
    stage = worker_backup.OUTBOX_DIR / active_account.slug('u@example.test') / set_id
    manifest = json.loads((stage / 'manifest.json').read_text('utf-8'))
    # A tombstone is excluded; each live scene and card link keeps its old count.
    assert manifest['summary']['canvases'] == (2 if with_live_scene_and_card_link else 0)
    assert 'canvas_retained' not in manifest['summary']
    assert _normalise_set_manifest(json.dumps(manifest)) == manifest


def test_install_db_replaces_history_without_restarting_notebook(notebook_db, monkeypatch):
    import sqlite3
    from contextlib import closing
    from app.routers import db_transfer
    seed()
    before = store.notebook('u')
    restored = notebook_db / 'restore.db'
    with db.get_connection() as conn, closing(sqlite3.connect(restored)) as dest:
        conn.backup(dest)
    monkeypatch.setattr(db_transfer, '_post_install_security_init', lambda path: None)
    monkeypatch.setattr(db_transfer, '_strict_clear_active', lambda: None)
    db_transfer._install_db(restored)
    after = store.notebook('u')
    assert after['notebook_id'] == before['notebook_id']
    assert after['history_id'] != before['history_id']
    assert len(after['items']) == 1


def test_request_emits_want_and_size_release_emits_changed(client, monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    from starlette.requests import Request
    from starlette.responses import Response
    from app import main
    response = client.post('/api/scenes/writer', json={'action': 'request', 'browser_id': 'b', 'tab_id': 't'})
    assert response.headers['X-MVHub-Scene-Writer-Want'] == '1'
    broadcast = AsyncMock()
    monkeypatch.setattr(main, 'AUTH_ENABLED', False)
    monkeypatch.setattr(main.manager, 'broadcast', broadcast)
    async def returned(_):
        return Response(headers=dict(response.headers))
    asyncio.run(main.mutation_notify(Request({'type': 'http', 'method': 'POST', 'path': '/api/scenes/writer',
        'scheme': 'http', 'server': ('testserver', 80), 'headers': [], 'query_string': b''}), returned))
    assert {'type': 'scene_writer_want'} in [call.args[0] for call in broadcast.call_args_list]


def test_legacy_mode_releases_transition_lock_before_repository_work(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from app import active_account
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '0')
    def probe(*args, **kwargs):
        def acquire_elsewhere():
            acquired = active_account.transition_lock.acquire(blocking=False)
            if acquired:
                active_account.transition_lock.release()
            return acquired
        with ThreadPoolExecutor(1) as pool:
            return [pool.submit(acquire_elsewhere).result()]
    monkeypatch.setattr(scenes.repo, 'list_scene_backups', probe)
    assert client.get('/api/scenes/backup').json()['items'] == [True]
    seed()
    assert client.get('/api/scenes/backup').json()['items'] == [False]


def test_legacy_upload_racing_start_is_rejected_with_flag(client):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'b', 'tab_id': 't'}).json()['token']
    barrier = threading.Barrier(2)
    def start():
        barrier.wait()
        return client.post('/api/scenes/notebook/start', json={**{'token': token, 'attempt_id': 'race',
            'expected_count': 1, 'order': ['s'], 'upserts': [scene()], 'commit': True}, 'restore_generation': restore_generation()})
    def old_put():
        barrier.wait()
        return client.put('/api/scenes/backup', json={**{'upserts': [scene(name='old')]}, 'restore_generation': restore_generation()})
    with ThreadPoolExecutor(2) as pool:
        a, b = pool.submit(start), pool.submit(old_put)
        assert a.result().status_code == 200
        assert b.result().status_code == 409
    assert json.loads(store.notebook('u')['items'][0]['data'])['name'] == 'X'


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


def test_close_finishes_original_mcp_with_scene_before_release(client):
    seed()
    task()
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    result = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'close-mcp',
        'upserts': [{**scene(mcpAttachmentReceipts=['task']), 'base': base()}], 'mcp_complete': ['task'],
    }, 'restore_generation': restore_generation()})
    assert result.status_code == 200, result.text
    assert result.json()['mcp_done'] == ['task']
    with db.get_connection() as conn:
        assert conn.execute("SELECT status FROM mcp_canvas_task WHERE id='task'").fetchone()[0] == 'done'
    assert client.post('/api/scenes/writer', json={'action': 'status'}).json()['writer'] is None


def test_close_replays_pending_delete_and_final_undo(client):
    seed()
    original = base()
    token = client.post('/api/scenes/writer', json={'action': 'claim', 'browser_id': 'a', 'tab_id': 'a'}).json()['token']
    result = client.post('/api/scenes/notebook/close', json={**{
        'token': token, 'request_id': 'close-undo',
        'pending_requests': [{'restore_generation': restore_generation(), 'request_id': 'pending-delete',
            'deletes': [{'id': 's', 'intent_id': 'd', 'base': original}]}],
        'upserts': [{**scene(name='undo'), 'base': original, 'revive': True, 'intent_id': 'r'}],
    }, 'restore_generation': restore_generation()})
    assert result.status_code == 200, result.text
    assert result.json()['results'][0]['status'] == 'saved'
    state = store.notebook('u')['items']
    assert len(state) == 1
    assert state[0]['deleted_at'] is None
    assert json.loads(state[0]['data'])['name'] == 'undo'


def test_start_cancels_only_hidden_mcp_tasks(notebook_db):
    legacy.sync_scene_backups('u', '', [scene(), scene('hidden')], [], restore_generation=restore_generation())
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
    assert client.post('/api/scenes/notebook/start', json={**body, 'restore_generation': restore_generation()}).status_code == 200
    assert client.post('/api/scenes/writer', json={'action':'release','token':lease['token']}).status_code == 200
    client.post('/api/scenes/writer', json={'action':'claim','browser_id':'two','tab_id':'t'})
    assert client.post('/api/scenes/notebook/start', json={**{**body, 'commit':True}, 'restore_generation': restore_generation()}).status_code == 409
    assert not store.is_started('u')


def test_account_epoch_aba_invalidates_http_upload(client):
    from app import active_account
    lease = client.post('/api/scenes/writer', json={'action':'claim','browser_id':'one','tab_id':'t'}).json()
    body = {'token':lease['token'], 'attempt_id':'a', 'expected_count':1, 'order':['s'], 'upserts':[scene()], 'commit':True}
    assert client.post('/api/scenes/notebook/start', json={**body, 'restore_generation': restore_generation()}).status_code == 200
    original = base()
    active_account.bump_account_epoch()
    active_account.bump_account_epoch()
    response = client.put('/api/scenes/backup', json={**{'token':lease['token'], 'request_id':'stale',
        'upserts':[{**scene(name='lost-owner'), 'base':original}]}, 'restore_generation': restore_generation()})
    assert response.status_code == 409
    assert base() == original


def test_auth_feature_is_default_on_for_local_hub(notebook_db, monkeypatch):
    # 364b0dd4 계약: 정확히 '0'만 끔. 빈 값·오타도 켬.
    from app.routers import auth
    from app.services import scene_writer
    monkeypatch.setattr(auth, 'AUTH_ENABLED', False)
    assert 'scene_writer_confirm_v1' in auth.auth_config()['features']  # notebook_db 가 '1' 로 켠 상태
    for value in (None, '1', '0', '', 'yes', 'true', ' 1'):
        if value is None:
            monkeypatch.delenv('CONTENT_HUB_SCENE_WRITER')
        else:
            monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', value)
        assert scene_writer.enabled() is (value != '0'), value
        assert ('scene_writer_confirm_v1' in auth.auth_config()['features']) is (value != '0'), value
        with monkeypatch.context() as auth_on:
            auth_on.setattr(config, 'AUTH_ENABLED', True)
            assert not scene_writer.enabled(), value
    monkeypatch.setenv('CONTENT_HUB_SCENE_WRITER', '1')
    assert scene_writer.enabled()
    assert 'scene_writer_confirm_v1' in auth.auth_config()['features']
    assert 'scene_writer_v1' not in auth.auth_config()['features']  # 열린 1011 탭의 코멘트 창 재조회도 옛 전환을 켜지 않는다.
    monkeypatch.setattr(auth, 'AUTH_ENABLED', True)
    assert 'scene_writer_confirm_v1' not in auth.auth_config()['features']
