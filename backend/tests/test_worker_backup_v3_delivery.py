"""P2 delivery uses synthetic local snapshots and an isolated real receiver."""
from __future__ import annotations

import json
import asyncio
import io
import http.client
import socket
import sqlite3
import threading
import time
import urllib.error
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
import uvicorn
from fastapi import FastAPI, Request

from app import active_account
from app.routers import db_backup
from app.services import backup, backup_manifest, worker_backup
from test_backup_v3_local import local, extras, capture
from test_trash_transfer import enabled_db
from test_shared_transport import certificates, required_tls, transport_server


def test_tls_capability_302_refuses_credentials(required_tls):
    with transport_server() as (target, leaked):
        with transport_server(required_tls, status=302, location=target + '/target') as (base, seen):
            assert worker_backup._capability_error(base, 'synthetic') == 'capability_unknown'
            assert len(seen) == 1 and seen[0][1]['Authorization'] == 'Bearer synthetic'
            assert not leaked


@pytest.mark.parametrize('broken', [False, True])
def test_real_drain_one_child_uses_shared_tls(delivery_store, required_tls, tmp_path, broken):
    import os
    import subprocess
    import sys
    from app.services import shared_transport
    _, stage, manifest = queued(delivery_store)
    ack = {
        'backup_set_format': 3, 'accepted': True,
        'backup_set_id': manifest['backup_set_id'], 'format_version': 3,
        'manifest_sha256': backup_manifest.manifest_digest(manifest),
        'files': {role: {'sha256': info['sha256'], 'size': info['size']}
                  for role, info in manifest['roles'].items() if info['state'] == 'present'},
    }
    bundle = required_tls[1]
    if broken:
        bundle = tmp_path / 'missing.pem'
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('CONTENT_HUB_')}
    env.update({
        'CONTENT_HUB_DATA': str(tmp_path / 'child-data'),
        'CONTENT_HUB_DB': str(delivery_store[0]),
        'CONTENT_HUB_NO_PROXY': '1', 'CONTENT_HUB_AUTH': '0',
        'CONTENT_HUB_EXTERNAL_RECOVERY': '0', 'PYTHONDONTWRITEBYTECODE': '1',
        'CONTENT_HUB_WORKER_BACKUP_STATE_DB': str(worker_backup.STATE_DB),
        'CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR': str(worker_backup.OUTBOX_DIR),
    })
    script = '''
import json, runpy, sys
from pathlib import Path
from unittest.mock import patch
from app import active_account
from app.services import shared_transport as t, shared_connection as c
bundle, base = sys.argv[1:]
print(json.dumps({'module': str(Path(t.__file__).resolve()), 'default_bundle': str(t.BUNDLE_PATH)}), flush=True)
sys.argv = ['app.services.worker_backup', '--drain-one']
with patch.object(t, 'TLS_REQUIRED', True), patch.object(t, 'BUNDLE_PATH', Path(bundle)), \
     patch.object(c, 'token', return_value='synthetic-child'), patch.object(c, 'base_url', return_value=base), \
     active_account.pinned_account_scope(('artist@example.invalid', 'artist')):
    runpy.run_module('app.services.worker_backup', run_name='__main__')
'''
    with transport_server(required_tls, body=json.dumps(ack).encode()) as (base, seen):
        result = subprocess.run([sys.executable, '-B', '-c', script, str(bundle), base],
                                cwd=str(Path(__file__).resolve().parents[1]), env=env,
                                capture_output=True, text=True, timeout=30)
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    assert lines[0]['module'] == str(Path(shared_transport.__file__).resolve())
    assert lines[0]['default_bundle'] == str(Path(shared_transport.__file__).resolve().parents[1] /
                                               'resources' / 'tls' / 'shared_server.pem')
    if broken:
        assert result.returncode == 1, result.stderr
        assert lines[-1]['error_code'] == 'network_unavailable'
        assert not seen and stage.exists()
    else:
        assert result.returncode == 0, result.stderr
        assert lines[-1]['state'] == 'success'
        assert [r[0] for r in seen] == ['/api/share/capabilities', '/api/db-backup/sets']
        assert all(r[1]['Authorization'] == 'Bearer synthetic-child' for r in seen)
        assert not stage.exists()

REAL_UPLOAD = worker_backup._multipart_set_upload


@pytest.fixture
def delivery_store(local, monkeypatch):
    root = local[2]
    monkeypatch.setattr(worker_backup, "STATE_DB", root / "delivery.db")
    monkeypatch.setattr(worker_backup, "OUTBOX_DIR", root / "outbox")
    monkeypatch.setattr(worker_backup, "DEVICE_IDENTITY_PATH", root / "device.json")
    monkeypatch.setattr(worker_backup, "_STATE_SCHEMA_READY", set())
    monkeypatch.setattr(worker_backup.shared_connection, "token", lambda: "synthetic-token")
    monkeypatch.setattr(worker_backup.shared_connection, "base_url", lambda: "http://unused.invalid")
    monkeypatch.setattr(worker_backup, "_multipart_set_upload", lambda *a, **k: pytest.fail("unexpected upload"))
    return local


def queued(local):
    content = capture(local)
    set_id = worker_backup.queue_backup_set(content)
    assert set_id
    stage = worker_backup._stage_dir(active_account.slug(active_account.account_key()), set_id)
    manifest = json.loads((stage / "manifest.json").read_text("utf-8"))
    return content, stage, manifest


@pytest.mark.parametrize("role", ["agent_chat", "asset_mounts"])
@pytest.mark.parametrize("fault", ["corrupt", "missing"])
def test_queue_v3_rechecks_extra_files_before_duplicate_return(delivery_store, role, fault):
    extras(delivery_store)
    content, stage, _ = queued(delivery_store)
    manifest = backup_manifest.read_local(content, allow_v3=True)
    path = backup_manifest.local_paths(content, manifest)[role]
    if fault == "missing":
        path.unlink()
    else:
        path.write_bytes(b"broken")
    with pytest.raises((ValueError, OSError)):
        worker_backup.queue_backup_set(content)
    assert stage.is_dir()


@pytest.mark.parametrize("role", ["agent_chat", "asset_mounts"])
def test_delivery_staged_extra_change_blocks_upload(delivery_store, role):
    extras(delivery_store)
    _, stage, _ = queued(delivery_store)
    (stage / backup_manifest.WORKER_FILENAMES[role]).write_bytes(b"changed after staging")
    assert worker_backup.drain_one() == {"state": "failed", "error_code": "staging_invalid"}
    with closing(worker_backup._connect()) as conn:
        assert conn.execute("SELECT status,last_error_code FROM worker_backup_outbox").fetchone()[:] == (
            "pending", "staging_invalid")
    assert stage.is_dir()


@pytest.mark.parametrize('status,body,error,delay', [
    (200, b'{}', 'server_update_required', 3600),
    (200, b'{"backup_set_format":2}', 'server_update_required', 3600),
    (200, b'{"backup_set_format":-1}', 'server_update_required', 3600),
    (404, b'', 'server_update_required', 3600),
    (405, b'', 'server_update_required', 3600),
    (401, b'', 'login_required', 300),
    (403, b'', 'capability_unknown', 60),
    (500, b'', 'capability_unknown', 60),
    (200, b'[3]', 'capability_unknown', 60),
    (200, b'{', 'capability_unknown', 60),
    (200, b'{"backup_set_format":"3"}', 'capability_unknown', 60),
    (200, b'{"backup_set_format":3.0}', 'capability_unknown', 60),
    (200, b'{"backup_set_format":true}', 'capability_unknown', 60),
    (200, b'{"backup_set_format":null}', 'capability_unknown', 60),
    (200, b'{"backup_set_format":[]}', 'capability_unknown', 60),
    (200, b' ' * 65537, 'capability_unknown', 60),
    (0, b'', 'network_unavailable', 60),
    (-1, b'', 'network_unavailable', 60),
], ids=['missing', 'v2', 'negative', '404', '405', '401', '403', '500', 'array', 'broken',
        'string', 'float', 'bool', 'null', 'list', 'oversized', 'offline', 'timeout'])
def test_negotiation_failure_preserves_whole_set(delivery_store, monkeypatch, status, body, error, delay):
    extras(delivery_store)
    _, stage, _ = queued(delivery_store)
    before = {p.name: p.read_bytes() for p in stage.iterdir()}
    requests = []
    def open_request(request, *, timeout):
        requests.append(request)
        assert request.get_method() == 'GET'
        assert request.full_url == 'http://unused.invalid/api/share/capabilities'
        assert request.get_header('Authorization') == 'Bearer synthetic-token'
        assert timeout == 10
        if status == 0:
            raise urllib.error.URLError('offline')
        if status == -1:
            raise TimeoutError()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, 'synthetic', {}, io.BytesIO(body))
        response = io.BytesIO(body)
        response.status = status
        return response
    monkeypatch.setattr(worker_backup._opener, 'open', open_request)
    start = time.time()
    result = worker_backup.drain_one()
    assert result['error_code'] == error
    assert result['state'] == (error if error in {'server_update_required', 'login_required'} else 'failed')
    assert result['format_version'] == 3
    assert len(requests) == 1
    with closing(worker_backup._connect()) as conn:
        row = conn.execute('SELECT * FROM worker_backup_outbox').fetchone()
        assert row['status'] == 'pending' and row['last_error_code'] == error
        assert start + delay <= row['next_retry_ts'] <= time.time() + delay
    assert {p.name: p.read_bytes() for p in stage.iterdir()} == before


@pytest.mark.parametrize('version', [3, 4])
def test_negotiation_accepts_explicit_integer_support(monkeypatch, version):
    def response(*args, **kwargs):
        stream = io.BytesIO(json.dumps({'backup_set_format': version}).encode())
        stream.status = 200
        return stream
    monkeypatch.setattr(worker_backup._opener, 'open', response)
    assert worker_backup._capability_error('http://unused.invalid', 'synthetic') is None


def test_negotiation_no_token_does_not_probe(delivery_store, monkeypatch):
    _, stage, _ = queued(delivery_store)
    monkeypatch.setattr(worker_backup.shared_connection, 'token', lambda: None)
    monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: pytest.fail('probe without token'))
    assert worker_backup.drain_one()['state'] == 'login_required'
    assert stage.is_dir()


@pytest.fixture
def receiver(delivery_store, monkeypatch):
    app = FastAPI()
    app.include_router(db_backup.router)
    state = SimpleNamespace(capability=3, requests=[], raw=[], account=active_account.account_key())
    monkeypatch.setattr(db_backup, 'DATA_DIR', delivery_store[2] / 'server')
    monkeypatch.setattr(db_backup, '_store_slots', asyncio.Semaphore(4))
    @app.middleware('http')
    async def identity(request: Request, call_next):
        assert request.headers.get('authorization') == 'Bearer synthetic-token'
        state.requests.append((request.method, request.url.path))
        request.state.account = {'email': state.account}
        if request.method == 'POST':
            state.raw.append(await request.body())
        return await call_next(request)
    @app.get('/api/share/capabilities')
    def capabilities():
        return {} if state.capability is None else {'backup_set_format': state.capability}
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', access_log=False, lifespan='off'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.01)
        assert server.started
        monkeypatch.setattr(worker_backup.shared_connection, 'base_url', lambda: f'http://127.0.0.1:{port}')
        monkeypatch.setattr(worker_backup, '_multipart_set_upload', REAL_UPLOAD)
        yield state
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        sock.close()
        assert not thread.is_alive(), 'loopback receiver was not reclaimed'


@pytest.mark.parametrize('mode', ['absent', 'extras', 'pinned'])
def test_delivery_real_multipart_router_roundtrip(delivery_store, receiver, mode, request, monkeypatch):
    if mode == 'pinned':
        from app import manage_db
        delivery_store = (request.getfixturevalue('enabled_db'), delivery_store[1], delivery_store[2])
        manage = delivery_store[2] / 'manage_hub.db'
        monkeypatch.setattr(backup, 'MANAGE_DB_PATH', manage)
        manage_db.init_manage_db(manage)
    if mode == 'extras':
        extras(delivery_store)
    content = capture(delivery_store)
    local_manifest = backup_manifest.read_local(content, allow_v3=True)
    if mode == 'pinned':
        assert local_manifest['consistency_kind'] == backup_manifest.PINNED
        assert local_manifest['consistency_roles'] == ['content', 'trash']
        assert local_manifest['roles']['manage']['state'] == 'present'
    local_paths = backup_manifest.local_paths(content, local_manifest)
    set_id = worker_backup.queue_backup_set(content)
    stage = worker_backup._stage_dir(active_account.slug(active_account.account_key()), set_id)
    manifest = json.loads((stage / 'manifest.json').read_text('utf-8'))
    assert manifest['consistency_kind'] == local_manifest['consistency_kind']
    assert manifest['consistency_roles'] == local_manifest['consistency_roles']
    for role, info in manifest['roles'].items():
        assert info['state'] == local_manifest['roles'][role]['state']
        assert info['captured_at'] == local_manifest['roles'][role]['captured_at']
    paths = backup_manifest.worker_paths(manifest, stage, check_present=True)
    sent_bytes = {role: path.read_bytes() for role, path in paths.items()}
    assert set(manifest['roles']) == {'content', 'trash', 'agent_chat', 'asset_mounts'}
    for role in ('agent_chat', 'asset_mounts'):
        if role in paths:
            assert sent_bytes[role] == local_paths[role].read_bytes()
    with closing(sqlite3.connect(stage / 'content.db')) as conn:
        assert conn.execute("SELECT 1 FROM app_setting WHERE key='auth_secret'").fetchone() is None
    # The real receiver stores once before the worker's retry, exercising duplicate ACK too.
    url = worker_backup.shared_connection.base_url() + '/api/db-backup/sets'
    status, first = REAL_UPLOAD(url, 'synthetic-token', manifest, paths, timeout=5)
    assert status == 200 and first['accepted'] and not first['duplicate']
    result = worker_backup.drain_one()
    assert result['state'] == 'success' and result['is_current'] and not result['conflict']
    assert not stage.exists()
    folder = db_backup._dir(receiver.account) / 'sets' / set_id
    assert {role: (folder / backup_manifest.WORKER_FILENAMES[role]).read_bytes() for role in paths} == sent_bytes
    assert len(db_backup._valid_set_dirs(folder.parent)) == 1
    for role in paths:
        assert f'name="{role}"; filename="{backup_manifest.WORKER_FILENAMES[role]}"'.encode() in receiver.raw[-1]
    assert b'name="manage"' not in receiver.raw[-1]
    assert worker_backup.status_snapshot()['unsent_roles'] == []


def test_negotiation_updated_server_rechecked_and_delivered(delivery_store, receiver):
    receiver.capability = None
    _, stage, _ = queued(delivery_store)
    assert worker_backup.drain_one()['state'] == 'server_update_required'
    assert receiver.requests == [('GET', '/api/share/capabilities')]
    receiver.capability = 3
    worker_backup.retry_pending()
    assert worker_backup.drain_one()['state'] == 'success'
    assert receiver.requests == [('GET', '/api/share/capabilities'), ('GET', '/api/share/capabilities'),
                                 ('POST', '/api/db-backup/sets')]
    assert not stage.exists()


def ack_for(manifest):
    return {'accepted': True, 'backup_set_id': manifest['backup_set_id'], 'format_version': 3,
            'manifest_sha256': backup_manifest.manifest_digest(manifest),
            'files': {role: {key: info[key] for key in ('size', 'sha256')}
                      for role, info in manifest['roles'].items() if info['state'] == 'present'}}


@pytest.mark.parametrize('fault', ['accepted', 'id', 'version', 'bool_version', 'digest', 'missing', 'absent', 'hash', 'size', 'size_type'])
def test_delivery_bad_ack_preserves_staging(delivery_store, monkeypatch, fault):
    extras(delivery_store)
    _, stage, manifest = queued(delivery_store)
    ack = ack_for(manifest)
    if fault == 'accepted': ack['accepted'] = 1
    elif fault == 'id': ack['backup_set_id'] = '0' * 64
    elif fault == 'version': ack['format_version'] = 2
    elif fault == 'bool_version': ack['format_version'] = True
    elif fault == 'digest': ack['manifest_sha256'] = '0' * 64
    elif fault == 'missing': del ack['files']['agent_chat']
    elif fault == 'absent': ack['files']['trash'] = ack['files']['content']
    elif fault == 'hash': ack['files']['content']['sha256'] = '0' * 64
    elif fault == 'size': ack['files']['content']['size'] += 1
    elif fault == 'size_type': ack['files']['content']['size'] = str(ack['files']['content']['size'])
    monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: None)
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **k: (200, ack))
    assert worker_backup.drain_one()['error_code'] == 'ack_mismatch'
    assert stage.exists() and worker_backup.status_snapshot()['pending'] == 1


@pytest.mark.parametrize('status,expected', [(400, 'server_rejected'), (413, 'server_rejected'), (500, 'server_rejected'),
                                           (404, 'server_update_required'), (405, 'server_update_required'), (401, 'login_required')])
def test_delivery_upload_failure_keeps_whole_set(delivery_store, monkeypatch, status, expected):
    _, stage, _ = queued(delivery_store)
    monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: None)
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **k: (status, {}))
    result = worker_backup.drain_one()
    assert result['error_code'] == expected and stage.exists()
    if status in {404, 405}:
        assert result['format_version'] == 3


def test_queue_capture_times_do_not_make_duplicate_transfers(delivery_store):
    extras(delivery_store)
    _, stage, first = queued(delivery_store)
    content = capture(delivery_store, '20261113_010101_000003')
    metadata = backup_manifest.read_local(content, allow_v3=True)
    metadata['captured_at'] = '2026-11-13T23:00:00+00:00'
    for info in metadata['roles'].values():
        info['captured_at'] = metadata['captured_at']
    backup_manifest.local_path(content).write_text(backup_manifest.canonical(backup_manifest.seal(metadata)), encoding='utf-8')
    assert worker_backup.queue_backup_set(content) == first['backup_set_id']
    with closing(worker_backup._connect()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM worker_backup_outbox').fetchone()[0] == 1
    assert json.loads((stage / 'manifest.json').read_text('utf-8')) == first


def test_queue_v2_key_and_fast_path_unchanged_v3_separate(delivery_store, monkeypatch):
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 2)
    _, _, v2 = queued(delivery_store)
    expected = {key: v2[key] for key in ('format_version', 'roles', 'consistency_kind', 'consistency_roles')}
    with closing(worker_backup._connect()) as conn:
        assert conn.execute('SELECT roles_json FROM worker_backup_outbox').fetchone()[0] == backup_manifest.canonical(expected)
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 3)
    content = capture(delivery_store, '20261113_010101_000003')
    v3_id = worker_backup.queue_backup_set(content)
    assert v3_id != v2['backup_set_id']
    with closing(worker_backup._connect()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM worker_backup_outbox').fetchone()[0] == 2
    monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: pytest.fail('v2 must not probe'))
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **k: (404, {}))
    assert worker_backup.drain_one()['format_version'] == 2


@pytest.mark.parametrize('meaningful', ['none', 'agent', 'mounts'])
def test_queue_extra_only_accounts_and_wire_summary(delivery_store, meaningful):
    agent, mounts = extras(delivery_store)
    with closing(sqlite3.connect(delivery_store[0])) as conn, conn:
        conn.execute('DELETE FROM generation')
    if meaningful != 'mounts':
        mounts.write_bytes(b'{"mounts":[]}')
    if meaningful == 'agent':
        with closing(sqlite3.connect(agent)) as conn, conn:
            conn.execute("INSERT INTO agent_chat_conversation(id) VALUES('conversation')")
    content = capture(delivery_store)
    set_id = worker_backup.queue_backup_set(content)
    if meaningful == 'none':
        assert set_id is None
        assert worker_backup.status_snapshot()['state'] == 'waiting_for_data'
        assert not list(worker_backup.OUTBOX_DIR.rglob('manifest.json'))
    else:
        stage = worker_backup._stage_dir(active_account.slug(active_account.account_key()), set_id)
        manifest = json.loads((stage / 'manifest.json').read_text('utf-8'))
        assert manifest['summary']['meaningful_records'] == 0
        assert set(manifest['summary']) == db_backup._SUMMARY_KEYS
        assert db_backup._normalise_set_manifest(json.dumps(manifest)) == manifest


@pytest.mark.parametrize('fault', ['scope', 'absent_file', 'copy_change'])
def test_queue_invalid_source_never_publishes(delivery_store, monkeypatch, fault):
    extras(delivery_store)
    content = capture(delivery_store)
    metadata = backup_manifest.read_local(content, allow_v3=True)
    if fault == 'scope':
        metadata['account_scope_digest'] = '0' * 64
        backup_manifest.local_path(content).write_text(backup_manifest.canonical(backup_manifest.seal(metadata)), encoding='utf-8')
    elif fault == 'absent_file':
        backup_manifest.local_paths(content)['trash'].write_bytes(b'unexpected')
    else:
        copyfile = worker_backup.shutil.copyfile
        def changing_copy(src, dst):
            result = copyfile(src, dst)
            if dst.name == 'asset_mounts.json':
                dst.write_bytes(b'{"mounts":[]}')
            return result
        monkeypatch.setattr(worker_backup.shutil, 'copyfile', changing_copy)
    with pytest.raises(ValueError):
        worker_backup.queue_backup_set(content)
    assert not list(worker_backup.OUTBOX_DIR.rglob('manifest.json'))
    assert content.is_file()


def test_queue_pending_limit_and_restore_keep_whole_sets(delivery_store, monkeypatch):
    monkeypatch.setattr(worker_backup, '_MAX_PENDING_PER_ACCOUNT', 1)
    _, first_stage, _ = queued(delivery_store)
    # An older v3 is not specially protected from a newer v2 under the existing cap.
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 2)
    with closing(sqlite3.connect(delivery_store[0])) as conn, conn:
        conn.execute("INSERT INTO generation VALUES('second')")
    content = capture(delivery_store, '20261113_010101_000003')
    second = worker_backup.queue_backup_set(content)
    second_stage = worker_backup._stage_dir(active_account.slug(active_account.account_key()), second)
    assert not first_stage.exists() and second_stage.is_dir()
    with closing(worker_backup._connect()) as conn:
        assert [r[0] for r in conn.execute('SELECT status FROM worker_backup_outbox ORDER BY created_at')] == ['superseded', 'pending']
    worker_backup.adopt_restored_backup('f' * 64, account_email=active_account.account_key())
    assert not second_stage.exists()
    assert worker_backup.status_snapshot()['unsent_roles'] == []
    assert worker_backup._lineage_parent(active_account.slug(active_account.account_key())) == 'f' * 64


@pytest.mark.parametrize('version,status,other,expected', [
    (1, 'pending', False, ['trash']), (2, 'running', False, ['trash']),
    (3, 'pending', False, []), (2, 'done', False, []),
    (2, 'superseded', False, []), (2, 'pending', True, []),
])
def test_status_excluded_rows_cannot_add_roles(delivery_store, version, status, other, expected):
    account = 'other' if other else active_account.slug(active_account.account_key())
    roles = {'trash': {'state': 'absent'}, 'unknown': {'state': 'present'}}
    metadata = roles if version == 1 else {'format_version': version, 'roles': roles}
    with closing(worker_backup._connect()) as conn, conn:
        conn.execute('INSERT INTO worker_backup_outbox(backup_set_id,account_slug,created_at,local_stamp,roles_json,status) VALUES(?,?,?,?,?,?)',
                     ('1' * 64, account, '2026-11-13', 'synthetic', json.dumps(metadata), status))
    assert worker_backup.status_snapshot()['unsent_roles'] == expected


def test_queue_delivery_missing_parent_is_stored_as_conflict(delivery_store, receiver):
    _, _, first = queued(delivery_store)
    assert worker_backup.drain_one()['state'] == 'success'
    # The next parent's upload fails, while its child becomes due first.
    with closing(sqlite3.connect(delivery_store[0])) as conn, conn:
        conn.execute("INSERT INTO generation VALUES('second')")
    second = worker_backup.queue_backup_set(capture(delivery_store, '20261113_010101_000003'))
    with closing(worker_backup._connect()) as conn, conn:
        conn.execute('UPDATE worker_backup_outbox SET next_retry_ts=? WHERE backup_set_id=?', (time.time() + 3600, second))
    with closing(sqlite3.connect(delivery_store[0])) as conn, conn:
        conn.execute("INSERT INTO generation VALUES('third')")
    third = worker_backup.queue_backup_set(capture(delivery_store, '20261113_010101_000004'))
    result = worker_backup.drain_one()
    assert result['state'] == 'success' and result['backup_set_id'] == third
    assert result['conflict'] and not result['is_current']
    assert db_backup._read_head(db_backup._dir(receiver.account) / 'sets') == first['backup_set_id']


def test_status_only_pending_present_roles_of_current_account(delivery_store):
    extras(delivery_store)
    _, _, manifest = queued(delivery_store)
    account = active_account.slug(active_account.account_key())
    with closing(worker_backup._connect()) as conn, conn:
        def add(index, owner, status, metadata):
            conn.execute('INSERT INTO worker_backup_outbox(backup_set_id,account_slug,created_at,local_stamp,roles_json,status) VALUES(?,?,?,?,?,?)',
                         (f'{index:064x}', owner, '2026-11-13', 'synthetic', json.dumps(metadata), status))
        add(1, account, 'running', {'content': {}, 'trash': {}})  # legacy v1
        add(2, 'other-account', 'pending', {'format_version': 3, 'roles': {'trash': {'state': 'present'}}})
        add(3, account, 'done', {'format_version': 2, 'roles': {'unknown': {}}})
        add(4, account, 'superseded', {'format_version': 2, 'roles': {'unknown': {}}})
        add(5, account, 'pending', None)
        add(6, account, 'pending', {'format_version': 2, 'roles': {'unknown': {}}})
    state = worker_backup.status_snapshot()
    assert state['state'] == 'uploading'
    assert state['unsent_roles'] == ['content', 'trash', 'agent_chat', 'asset_mounts']
    assert manifest['backup_set_id'] not in json.dumps(state) and account not in json.dumps(state)
    with closing(worker_backup._connect()) as conn, conn:
        conn.execute("UPDATE worker_backup_outbox SET status='done' WHERE account_slug=?", (account,))
    assert worker_backup.status_snapshot()['unsent_roles'] == []
    with active_account.pinned_account_scope(('', None)):
        assert worker_backup.status_snapshot()['unsent_roles'] == []


@pytest.mark.parametrize('failure', ['timeout', 'cancel'])
def test_delivery_parent_budget_and_interrupted_claim_recovery(delivery_store, monkeypatch, failure):
    queued(delivery_store)
    child = SimpleNamespace(returncode=None)
    async def communicate():
        worker_backup._claim_due()
        return b'', b''
    child.communicate = communicate
    async def create(*a, **k):
        return child
    async def wait(awaitable, *, timeout):
        assert timeout == worker_backup.UPLOAD_TIMEOUT + 25
        await awaitable
        raise TimeoutError() if failure == 'timeout' else asyncio.CancelledError()
    terminated = []
    async def terminate(process):
        terminated.append(process)
        process.returncode = -1
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', create)
    monkeypatch.setattr(asyncio, 'wait_for', wait)
    monkeypatch.setattr(worker_backup, '_terminate_process', terminate)
    runner = worker_backup.PeriodicWorkerBackupUpload()
    if failure == 'cancel':
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(runner.run_now())
    else:
        assert asyncio.run(runner.run_now()) == {'state': 'failed', 'error_code': 'timeout'}
    assert terminated == [child] and runner._process is None
    with closing(worker_backup._connect()) as conn:
        assert conn.execute('SELECT status,last_error_code FROM worker_backup_outbox').fetchone()[:] == ('pending', 'interrupted')


@pytest.fixture
def redirect_receiver(monkeypatch):
    state = SimpleNamespace(status=302, method='GET', target='', requests=[])

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state.requests.append((self.server.server_port, self.command, self.path))
            if self.path == '/target':
                body = b'{"backup_set_format":3}'
                self.send_response(200)
            elif self.command == state.method:
                body = b''
                self.send_response(state.status)
                self.send_header('Location', state.target)
            else:
                body = b'{"backup_set_format":3}'
                self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.do_GET()

        def log_message(self, *args):
            pass

    servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(2)]
    threads = [threading.Thread(target=s.serve_forever, kwargs={'poll_interval': .01}) for s in servers]
    monkeypatch.setenv('no_proxy', 'localhost,127.0.0.1')
    for thread in threads:
        thread.start()
    state.origin = f'http://127.0.0.1:{servers[0].server_port}'
    state.other = f'http://localhost:{servers[1].server_port}'
    try:
        yield state
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=10)
            assert not thread.is_alive()


@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('destination', ['same', 'other'])
def test_a_prep_l1_redirect_never_sends_followup(delivery_store, redirect_receiver, monkeypatch,
                                               status, method, destination):
    _, stage, _ = queued(delivery_store)
    before = {p.name: p.read_bytes() for p in stage.iterdir()}
    state = redirect_receiver
    state.status, state.method = status, method
    state.target = (state.origin if destination == 'same' else state.other) + '/target'
    monkeypatch.setattr(worker_backup.shared_connection, 'base_url', lambda: state.origin)
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', REAL_UPLOAD)
    result = worker_backup.drain_one()
    assert not [r for r in state.requests if r[2] == '/target']
    assert [(method, path) for _, method, path in state.requests] == (
        [('GET', '/api/share/capabilities')] if method == 'GET' else
        [('GET', '/api/share/capabilities'), ('POST', '/api/db-backup/sets')])
    error = 'capability_unknown' if method == 'GET' else 'server_rejected'
    assert result['error_code'] == error
    with closing(worker_backup._connect()) as conn:
        row = conn.execute('SELECT status,last_error_code,next_retry_ts FROM worker_backup_outbox').fetchone()
        assert tuple(row[:2]) == ('pending', error) and row[2] > time.time()
    assert {p.name: p.read_bytes() for p in stage.iterdir()} == before


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('status', [302, 401, 404, 405, 500])
def test_a_prep_l1_http_error_keeps_code_without_reading_body(delivery_store, monkeypatch, method, status):
    queued(delivery_store)
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **k: pytest.fail('unexpected DNS lookup'))

    class Unreadable(io.BytesIO):
        def read(self, *args):
            pytest.fail('HTTP error body must not be read')

    body = Unreadable()
    def open_request(request, *args, **kwargs):
        raise urllib.error.HTTPError(request.full_url, status, 'synthetic', {}, body)
    monkeypatch.setattr(worker_backup._opener, 'open', open_request)
    if method == 'POST':
        monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: None)
        monkeypatch.setattr(worker_backup, '_multipart_set_upload', REAL_UPLOAD)
    result = worker_backup.drain_one()
    expected = {401: 'login_required', 404: 'server_update_required', 405: 'server_update_required'}.get(
        status, 'capability_unknown' if method == 'GET' else 'server_rejected')
    assert result['error_code'] == expected and body.closed


@pytest.mark.parametrize('method', ['GET', 'POST'])
@pytest.mark.parametrize('fault', ['request', 'bad_status', 'open_value', 'read'])
def test_a_prep_l2_network_boundary_keeps_backoff(delivery_store, monkeypatch, method, fault):
    extras(delivery_store)
    _, stage, _ = queued(delivery_store)
    before = {p.name: p.read_bytes() for p in stage.iterdir()}
    now = [time.time()]
    monkeypatch.setattr(worker_backup.time, 'time', lambda: now[0])
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **k: pytest.fail('unexpected DNS lookup'))
    streams = []
    calls = []

    class Incomplete(io.BytesIO):
        status = 200
        def read(self, *args):
            calls.append('read')
            raise http.client.IncompleteRead(b'synthetic', 10)

    def open_request(request, *args, **kwargs):
        calls.append('open')
        if fault == 'bad_status':
            raise http.client.BadStatusLine('synthetic')
        if fault == 'open_value':
            raise ValueError('synthetic URL')
        stream = Incomplete()
        streams.append(stream)
        return stream

    monkeypatch.setattr(worker_backup._opener, 'open', open_request)
    if fault == 'request':
        def invalid_request(*args, **kwargs):
            calls.append('request')
            raise ValueError('synthetic URL')
        monkeypatch.setattr(worker_backup.urllib.request, 'Request', invalid_request)
    if method == 'POST':
        monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: None)
        monkeypatch.setattr(worker_backup, '_multipart_set_upload', REAL_UPLOAD)
    for attempt, delay in [(1, 60), (2, 240), (8, 3600)]:
        with closing(worker_backup._connect()) as conn, conn:
            conn.execute('UPDATE worker_backup_outbox SET attempts=?', (attempt - 1,))
        result = worker_backup.drain_one()
        assert result['state'] == 'failed' and result['error_code'] == 'network_unavailable'
        with closing(worker_backup._connect()) as conn:
            row = conn.execute('SELECT attempts,status,last_error_code,next_retry_ts FROM worker_backup_outbox').fetchone()
        assert tuple(row) == (attempt, 'pending', 'network_unavailable', now[0] + delay)
        assert not worker_backup.has_due_backup()
        assert worker_backup.drain_one() == {'state': 'idle'}
        now[0] += delay
    expected_calls = ['request'] if fault == 'request' else ['open', 'read'] if fault == 'read' else ['open']
    assert calls == expected_calls * 3
    assert all(stream.closed for stream in streams)
    assert {p.name: p.read_bytes() for p in stage.iterdir()} == before


@pytest.mark.parametrize('method', ['GET', 'POST'])
def test_a_prep_l2_parent_preserves_handled_child_failure(delivery_store, monkeypatch, capsys, method):
    _, stage, _ = queued(delivery_store)
    now = time.time()
    monkeypatch.setattr(worker_backup.time, 'time', lambda: now)
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **k: pytest.fail('unexpected DNS lookup'))
    calls = []
    def open_request(request, *args, **kwargs):
        calls.append(request.get_method())
        raise http.client.BadStatusLine('synthetic')
    monkeypatch.setattr(worker_backup._opener, 'open', open_request)
    if method == 'POST':
        monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: None)
        monkeypatch.setattr(worker_backup, '_multipart_set_upload', REAL_UPLOAD)
    capsys.readouterr()
    child = SimpleNamespace(returncode=None)
    async def communicate():
        child.returncode = worker_backup._main(['--drain-one'])
        return capsys.readouterr().out.encode(), b''
    child.communicate = communicate
    async def create(*args, **kwargs):
        return child
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', create)
    result = asyncio.run(worker_backup.PeriodicWorkerBackupUpload().run_now())
    assert calls == [method]
    assert child.returncode == 1 and result['error_code'] == 'network_unavailable'
    with closing(worker_backup._connect()) as conn:
        assert tuple(conn.execute('SELECT status,last_error_code,next_retry_ts FROM worker_backup_outbox').fetchone()) == (
            'pending', 'network_unavailable', now + 60)
    assert stage.is_dir()


def test_a_prep_l2_local_multipart_value_error_is_not_network(delivery_store, monkeypatch):
    _, stage, manifest = queued(delivery_store)
    monkeypatch.setitem(backup_manifest.WORKER_FILENAMES, 'content', '\u2603.db')
    with pytest.raises(UnicodeEncodeError):
        REAL_UPLOAD('http://unused.invalid', 'synthetic', manifest,
                    {'content': stage / 'content.db'}, timeout=1)


@pytest.mark.parametrize('role', ['agent_chat', 'asset_mounts', 'both'])
@pytest.mark.parametrize('fault', ['file', 'directory', 'denied'])
def test_a_prep_l8_orphaned_members_never_queue(delivery_store, monkeypatch, role, fault):
    extras(delivery_store)
    content = capture(delivery_store)
    backup_manifest.local_path(content).unlink()
    paths = backup_manifest.local_paths(content)
    selected = {'agent_chat', 'asset_mounts'} if role == 'both' else {role}
    for key in ('agent_chat', 'asset_mounts'):
        if key not in selected or fault != 'file':
            paths[key].unlink()
        if key in selected and fault == 'directory':
            paths[key].mkdir()
    if fault == 'denied':
        original_stat = Path.stat
        def denied(path, *args, **kwargs):
            if path in [paths[key] for key in selected]:
                raise PermissionError('synthetic')
            return original_stat(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'stat', denied)
    for _ in range(2):
        with pytest.raises((ValueError, OSError)):
            worker_backup.queue_backup_set(content)
        assert worker_backup.status_snapshot()['last_error_code'] == 'staging_failed'
        assert worker_backup.drain_one() == {'state': 'idle'}
    with closing(worker_backup._connect()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM worker_backup_outbox').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM worker_backup_source_state').fetchone()[0] == 0
    assert not list(worker_backup.OUTBOX_DIR.rglob('manifest.json'))
    assert not list(worker_backup.OUTBOX_DIR.rglob('.stage-*'))
    assert content.is_file()


@pytest.mark.parametrize('role', ['agent_chat', 'asset_mounts'])
def test_a_prep_l8_orphan_bypasses_cached_legacy_duplicate(delivery_store, monkeypatch, role):
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 2)
    content = capture(delivery_store)
    backup_manifest.local_path(content).unlink()
    set_id = worker_backup.queue_backup_set(content)
    paths = backup_manifest.local_paths(content)
    paths[role].write_bytes(b'synthetic orphan')
    with pytest.raises(ValueError):
        worker_backup.queue_backup_set(content)
    assert worker_backup.status_snapshot()['last_error_code'] == 'staging_failed'
    with closing(worker_backup._connect()) as conn:
        assert [row[0] for row in conn.execute('SELECT backup_set_id FROM worker_backup_outbox')] == [set_id]


def test_a_prep_l8_manifest_disappearing_at_read_is_rejected(delivery_store, monkeypatch):
    extras(delivery_store)
    content = capture(delivery_store)
    read_local = backup_manifest.read_local
    def vanished(path, **kwargs):
        backup_manifest.local_path(path).unlink()
        return read_local(path, **kwargs)
    monkeypatch.setattr(backup_manifest, 'read_local', vanished)
    with pytest.raises(ValueError):
        worker_backup.queue_backup_set(content)
    assert worker_backup.status_snapshot()['last_error_code'] == 'staging_failed'
    assert worker_backup.drain_one() == {'state': 'idle'}


def test_a_prep_l8_true_legacy_keeps_fast_path_and_upload(delivery_store, monkeypatch):
    monkeypatch.setattr(backup, 'CAPTURE_VERSION', 2)
    content = capture(delivery_store)
    backup_manifest.local_path(content).unlink()
    other = content.with_name('content_hub_20261113_010101_999999.db')
    backup_manifest.local_paths(other)['agent_chat'].write_bytes(b'other capture')
    set_id = worker_backup.queue_backup_set(content)
    stage = worker_backup._stage_dir(active_account.slug(active_account.account_key()), set_id)
    manifest = json.loads((stage / 'manifest.json').read_text('utf-8'))
    assert manifest['format_version'] == 2
    with monkeypatch.context() as fast:
        fast.setattr(worker_backup.shutil, 'copyfile', lambda *a: pytest.fail('duplicate copied'))
        fast.setattr(backup_manifest, 'file_digest', lambda *a: pytest.fail('duplicate hashed'))
        assert worker_backup.queue_backup_set(content) == set_id
    monkeypatch.setattr(worker_backup, '_capability_error', lambda *a: pytest.fail('legacy probe'))
    ack = {'accepted': True, 'backup_set_id': set_id, 'format_version': 2,
           'manifest_sha256': backup_manifest.manifest_digest(manifest), 'files': manifest['roles']}
    monkeypatch.setattr(worker_backup, '_multipart_set_upload', lambda *a, **k: (200, ack))
    assert worker_backup.drain_one()['state'] == 'success'


def test_a_prep_l8_stage_collision_keeps_existing_directory(delivery_store, monkeypatch):
    content = capture(delivery_store)
    stage = worker_backup.OUTBOX_DIR / active_account.slug(active_account.account_key()) / '.stage-existing'
    stage.mkdir(parents=True)
    sentinel = stage / 'owned-by-another-attempt'
    sentinel.write_bytes(b'keep')
    monkeypatch.setattr(worker_backup.secrets, 'token_hex', lambda size: 'existing')
    with pytest.raises(FileExistsError):
        worker_backup.queue_backup_set(content)
    assert sentinel.read_bytes() == b'keep'


def test_a_prep_l8_unreadable_manifest_is_not_legacy(delivery_store, monkeypatch):
    content = capture(delivery_store)
    metadata = backup_manifest.local_path(content)
    original_stat = Path.stat
    def denied(path, *args, **kwargs):
        if path == metadata:
            raise PermissionError('synthetic')
        return original_stat(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', denied)
    with pytest.raises(PermissionError):
        worker_backup.queue_backup_set(content)
    assert worker_backup.status_snapshot()['last_error_code'] == 'staging_failed'
    assert worker_backup.drain_one() == {'state': 'idle'}
