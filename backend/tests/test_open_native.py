import asyncio
import json
import time
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routers import open_generation as opening
from app.services import open_link as service
from test_open_generation import client
from test_open_link import handler


def signed(session, nonce='n'*32, stamp=None, body=None):
    body = body or {'generation_id': 'g', 'comment_id': 'c'}
    stamp = str(stamp if stamp is not None else time.time_ns() // 1_000_000)
    return {'x-mvhub-open-time': stamp, 'x-mvhub-open-nonce': nonce,
            'x-mvhub-open-sig': handler.request_signature(session.key, stamp, nonce, session.port,
                                                        body['generation_id'], body['comment_id'])}


def test_fixed_hmac_vectors():
    # Fixed expected bytes, not another copy of the implementation under test.
    session = service.LinkSession('k'*43, 8472, 0)
    body = {'generation_id': 'g', 'comment_id': 'c'}
    headers = signed(session, stamp=1700000000000)
    assert headers['x-mvhub-open-sig'] == '59f0a12d4602541eb1b214a4ca2620576db1c181abd69412d3a9a1c7441d3064'
    assert session.authenticate(headers, body, now=1700000000000) == ('n'*32, True)
    assert session.response('n'*32, 'opened', 42)['proof'] == '894e70712503bc656c863a2728fae7d07213483937a1f40b41f0663a878a9b46'


@pytest.mark.parametrize('delta,valid', [(-10001, False), (-10000, True), (0, True), (10000, True), (10001, False)])
def test_time_window(delta, valid):
    session = service.LinkSession('k'*43, 8472, 1)
    headers = signed(session, stamp=100000 + delta)
    if valid:
        assert session.authenticate(headers, {'generation_id': 'g', 'comment_id': 'c'}, now=100000)[1]
    else:
        with pytest.raises(ValueError): session.authenticate(headers, {'generation_id': 'g', 'comment_id': 'c'}, now=100000)


def test_birth_replay_clock_rollback_and_capacity():
    session = service.LinkSession('k'*43, 8472, 100000)
    body = {'generation_id': 'g', 'comment_id': 'c'}
    with pytest.raises(ValueError): session.authenticate(signed(session, stamp=99999), body, now=100000)
    headers = signed(session, stamp=100001)
    assert session.authenticate(headers, body, now=100001)[1]
    with pytest.raises(ValueError): session.authenticate(headers, body, now=900000)
    with pytest.raises(ValueError): session.authenticate(headers, body, now=100000)
    session.nonces.update(f'{i:032d}' for i in range(service.LIMIT-1))
    assert len(session.nonces) == service.LIMIT
    assert session.authenticate(signed(session, 'z'*32, 100001), body, now=100001) == ('z'*32, False)
    assert len(session.nonces) == service.LIMIT
    with pytest.raises(ValueError): session.authenticate(headers, body, now=100001)


@pytest.mark.parametrize('change', ['stamp', 'nonce', 'sig', 'body', 'type', 'extra'])
def test_signature_format_and_mutation(change):
    session = service.LinkSession('k'*43, 8472, 0)
    body = {'generation_id': 'g', 'comment_id': 'c'}
    headers = signed(session, stamp=100000)
    if change == 'stamp': headers['x-mvhub-open-time'] = '1'*14
    if change == 'nonce': headers['x-mvhub-open-nonce'] = 'x'*31
    if change == 'sig': headers['x-mvhub-open-sig'] = '0'*64
    if change == 'body': body['comment_id'] = 'other'
    if change == 'type': body['generation_id'] = True
    if change == 'extra': body['x'] = 'x'
    with pytest.raises(ValueError): session.authenticate(headers, body, now=100000)
    assert not session.nonces


@pytest.fixture
def native(client, monkeypatch):
    monkeypatch.setenv('MVHUB_OPEN_LINK', '1')
    session = service.LinkSession('k'*43, 8010, 0)
    monkeypatch.setattr(service, 'session', session)
    return client, session


def test_native_proof_busy_and_no_secret(native, monkeypatch):
    client, session = native
    calls = []
    async def core(*a, **k):
        calls.append(1)
        return {'result': 'opened', 'hwnd': 42}
    monkeypatch.setattr(opening, '_open_core', core)
    body = {'generation_id': 'g', 'comment_id': 'c'}
    headers = signed(session)
    response = client.post('/api/open/native', json=body, headers=headers)
    assert response.status_code == 200
    assert handler.verified_response(response.content, session.key, 'n'*32) == ('opened', 42)
    assert session.key not in response.text
    assert client.post('/api/open/native', json=body, headers=headers).status_code == 401
    session.nonces.update(f'{i:032d}' for i in range(service.LIMIT))
    response = client.post('/api/open/native', json=body, headers=signed(session, 'z'*32))
    assert response.status_code == 503
    assert handler.verified_response(response.content, session.key, 'z'*32) == ('busy', 0)
    assert len(calls) == 1


def test_simultaneous_replay_runs_once(native, monkeypatch):
    client, session = native
    entered, release = threading.Event(), threading.Event()
    calls = []
    async def core(*a, **k):
        calls.append(1); entered.set()
        await asyncio.to_thread(release.wait, 2)
        return {'result': 'denied', 'hwnd': 0}
    monkeypatch.setattr(opening, '_open_core', core)
    headers = signed(session)
    body = {'generation_id': 'g', 'comment_id': 'c'}
    replies = []
    first = threading.Thread(target=lambda: replies.append(client.post('/api/open/native', json=body, headers=headers)))
    first.start()
    try:
        assert entered.wait(2)
        assert client.post('/api/open/native', json=body, headers=headers).status_code == 401
    finally:
        release.set(); first.join(3)
    assert len(calls) == 1 and replies[0].status_code == 200


def test_native_disabled_auth_host_header_and_body(native, monkeypatch):
    client, session = native
    body = {'generation_id': 'g', 'comment_id': 'c'}
    headers = signed(session)
    assert client.post('/api/open/native', json=body).status_code == 401
    assert client.post('/api/open/native', json=body, headers=headers | {'host': 'evil.test'}).status_code == 403
    assert client.post('/api/open/native', content=b'x'*4097, headers=headers).status_code == 401
    assert client.post('/api/open/native', json=body, headers=list(headers.items()) + [('x-mvhub-open-nonce', 'z'*32)]).status_code == 401
    monkeypatch.setattr(opening.config, 'AUTH_ENABLED', True)
    assert client.post('/api/open/native', json=body, headers=headers).status_code == 404
    monkeypatch.setattr(opening.config, 'AUTH_ENABLED', False)
    monkeypatch.delenv('MVHUB_OPEN_LINK')
    assert client.post('/api/open/native', json=body, headers=headers).status_code == 404
    monkeypatch.setenv('MVHUB_OPEN_LINK', '1')
    monkeypatch.setattr(service, 'session', None)  # direct uvicorn has never published
    assert client.post('/api/open/native', json=body, headers=headers).status_code == 404


def test_different_hub_key_never_opens_or_proves_a_reply():
    first, other = service.LinkSession('a'*43, 8010, 0), service.LinkSession('b'*43, 8010, 0)
    with pytest.raises(ValueError):
        other.authenticate(signed(first), {'generation_id': 'g', 'comment_id': 'c'})
    assert not other.nonces
    with pytest.raises(ValueError):
        handler.verified_response(json.dumps(other.response('n'*32, 'opened', 42)), first.key, 'n'*32)


@pytest.mark.parametrize('result', ['opened', 'denied', 'no_window', 'busy', 'unsupported'])
def test_http_and_native_result_mapping(client, monkeypatch, result):
    async def core(*a, **k): return {'result': result, 'hwnd': 0}
    monkeypatch.setattr(opening, '_open_core', core)
    answer = asyncio.run(opening._open('g', 'c', None)) if result != 'busy' else None
    if result == 'busy':
        with pytest.raises(HTTPException) as error: asyncio.run(opening._open('g', 'c', None))
        assert error.value.status_code == 429
    else:
        assert answer.status_code == 200 and b'<html' in answer.body
    session = service.LinkSession('k'*43, 8010, 0)
    assert handler.verified_response(json.dumps(session.response('n'*32, result)), session.key, 'n'*32) == (result, 0)


@pytest.mark.parametrize('mode', ['success', 'exception', 'slow', 'multiple'])
def test_ack_two_phases_and_no_late_lift(client, monkeypatch, mode):
    lifted = []
    monkeypatch.setattr(opening.os, 'name', 'nt')
    monkeypatch.setattr(opening.shared_connection, 'is_shared_team_server', lambda: False)
    monkeypatch.setattr(opening, 'FIND_TIMEOUT', 0.03)
    monkeypatch.setattr(opening, 'FOUND_TIMEOUT', 0.08)
    def find(marker):
        if mode == 'exception': raise OSError()
        if mode == 'slow': time.sleep(0.09)
        return [(42, False), (43, False)] if mode == 'multiple' else [(42, False)]
    monkeypatch.setattr(opening.app_windows, 'find_marked', find)
    monkeypatch.setattr(opening.app_windows, 'lift_marked', lambda hits, **kwargs: lifted.extend(hits))
    async def scenario():
        entry = {'accepted': False, 'ok': False, 'active': True, 'native': True, 'hwnd': 0,
                 'window': 'w', 'event': asyncio.Event(), 'found': asyncio.Event()}
        async def get_entry(_): return entry, {'ok': True, 'marker': 'MVHubOpen-123e4567-e89b-12d3-a456-426614174000'}, 'w'
        monkeypatch.setattr(opening, '_entry', get_entry)
        task = asyncio.create_task(opening.ack(None))
        await entry['event'].wait()
        assert entry['accepted'] and entry['ok']
        with pytest.raises(HTTPException): await opening.ack(None)
        await task
        assert entry['found'].is_set()
        if mode == 'success': assert entry['hwnd'] == 42
        else: assert entry['hwnd'] == 0
        entry['active'] = False
    asyncio.run(scenario())
    assert lifted == ([(42, False)] if mode == 'success' else [])


def test_native_end_to_end_claim_ack_proof(native, monkeypatch):
    client, session = native
    ready, captured = threading.Event(), {}
    async def send(message, **kwargs):
        captured.update(message); ready.set()
    monkeypatch.setattr(opening.manager, 'broadcast', send)
    monkeypatch.setattr(opening.os, 'name', 'nt')
    monkeypatch.setattr(opening.shared_connection, 'is_shared_team_server', lambda: False)
    monkeypatch.setattr(opening.app_windows, 'find_marked', lambda marker: [(42, False)])
    monkeypatch.setattr(opening.app_windows, 'lift_marked', lambda hits, **kwargs: None)
    replies = []
    thread = threading.Thread(target=lambda: replies.append(client.post('/api/open/native',
        json={'generation_id': 'g', 'comment_id': 'c'}, headers=signed(session))))
    thread.start()
    assert ready.wait(2)
    body = {'open_id': captured['open_id'], 'window_id': 'w'}
    headers = {'origin': 'http://127.0.0.1:8010', 'sec-fetch-site': 'same-origin'}
    assert client.post('/api/open/claim', json=body, headers=headers).status_code == 200
    ack = client.post('/api/open/ack', json=body | {'ok': True,
        'marker': 'MVHubOpen-123e4567-e89b-12d3-a456-426614174000'}, headers=headers)
    thread.join(3)
    assert ack.status_code == 200 and not thread.is_alive()
    assert handler.verified_response(replies[0].content, session.key, 'n'*32) == ('opened', 42)
    assert not opening._pending


def test_core_no_ack_and_server_mode_cleanup(client, monkeypatch):
    monkeypatch.setattr(opening, 'ACK_TIMEOUT', 0.01)
    async def send(*a, **k): pass
    monkeypatch.setattr(opening.manager, 'broadcast', send)
    assert asyncio.run(opening._open_core('g', 'c', None)) == {'result': 'no_window', 'hwnd': 0}
    assert not opening._pending
    monkeypatch.setattr(opening.config, 'AUTH_ENABLED', True)
    assert asyncio.run(opening._open_core('g', 'c', None)) == {'result': 'unsupported', 'hwnd': 0}


def test_core_found_timeout_preserves_open_and_closes_lifetime(client, monkeypatch):
    captured = []
    monkeypatch.setattr(opening, 'FOUND_TIMEOUT', 0.01)
    async def send(message, **kwargs):
        entry = opening._pending[message['open_id']]
        captured.append(entry)
        entry['accepted'], entry['ok'] = True, True
        entry['event'].set()
    monkeypatch.setattr(opening.manager, 'broadcast', send)
    assert asyncio.run(opening._open_core('g', 'c', None)) == {'result': 'opened', 'hwnd': 0}
    assert not captured[0]['active'] and not opening._pending


def test_core_slow_prepare_does_not_broadcast(client, monkeypatch):
    monkeypatch.setattr(opening, 'PREPARE_TIMEOUT', 0.01)
    monkeypatch.setattr(opening, '_account', lambda request: time.sleep(0.03))
    async def send(*a, **k): pytest.fail('timed-out account lookup opened a panel')
    monkeypatch.setattr(opening.manager, 'broadcast', send)
    assert asyncio.run(opening._open_core('g', 'c', None)) == {'result': 'no_window', 'hwnd': 0}
    assert not opening._pending


def test_ack_expiry_starts_after_delayed_broadcast(client, monkeypatch):
    monkeypatch.setattr(opening, 'ACK_TIMEOUT', 0.08)
    async def scenario():
        sent = asyncio.Event()
        captured = {}
        async def broadcast(message, **kwargs):
            captured.update(message)
            await asyncio.sleep(0.04)
            captured['broadcast_finished'] = time.monotonic()
            sent.set()
        monkeypatch.setattr(opening.manager, 'broadcast', broadcast)
        task = asyncio.create_task(opening._open_core('g', 'c', None))
        try:
            await sent.wait()
            await asyncio.sleep(0)  # let wait_for resume the open core
            await asyncio.sleep(0)
            entry = opening._pending[captured['open_id']]
            assert entry['expires'] >= captured['broadcast_finished'] + 0.075
            assert entry['expires'] <= captured['broadcast_finished'] + 0.10
            entry['ok'] = True
            entry['event'].set()
            entry['found'].set()
            assert (await task)['result'] == 'opened'
        finally:
            if not task.done():
                task.cancel()
                try: await task
                except asyncio.CancelledError: pass
    asyncio.run(scenario())
