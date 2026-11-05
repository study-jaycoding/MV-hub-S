import threading

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import open_generation as opening


def test_local_account_without_server_token(monkeypatch):
    monkeypatch.setattr(opening.config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(opening.shared_connection, 'token', lambda: None)
    monkeypatch.setattr(opening.shared_connection, 'base_url', lambda: '')
    monkeypatch.setattr(opening.active_account, 'account_key', lambda: 'local')
    key, scope = opening._account(None)
    assert key[:2] == ('local', '') and len(key[2]) == 64 and scope is None


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(opening.router)
    monkeypatch.setattr(opening.config, 'PORT', 8010)
    monkeypatch.setattr(opening.config, 'AUTH_ENABLED', False)
    monkeypatch.setattr(opening, '_account', lambda req: (('local',), None))
    opening._pending.clear()
    opening._last_open = 0
    with TestClient(app, base_url='http://127.0.0.1:8010', client=('127.0.0.1', 43210)) as test:
        yield test


def test_missing_activation_shows_button_without_broadcast(client, monkeypatch):
    async def fail(*a, **k):
        raise AssertionError('must not broadcast')
    monkeypatch.setattr(opening.manager, 'broadcast', fail)
    response = client.get('/api/open/generation/g?c=c')
    assert response.status_code == 200
    assert 'form' in response.text
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('headers', [{'host': 'evil.test'}, {'purpose': 'prefetch'}, {'sec-purpose': 'prefetch'}])
def test_security_failure_never_shows_button(client, headers):
    answer = client.get('/api/open/generation/g?c=c', headers=headers)
    assert answer.status_code == 403
    assert '<form' not in answer.text


def test_post_requires_same_origin(client):
    assert client.post('/api/open/generation/g', data={'comment_id': 'c'}).status_code == 403
    assert client.post('/api/open/claim', json={'open_id': 'x', 'window_id': 'w'}).status_code == 403
    assert client.post('/api/open/ack', json={'open_id': 'x', 'window_id': 'w', 'ok': True}).status_code == 403


def test_localhost_window_can_claim_but_origin_must_match_host(client):
    body = {'open_id': 'gone', 'window_id': 'w'}
    same = {'host': 'localhost:8010', 'origin': 'http://localhost:8010', 'sec-fetch-site': 'same-origin'}
    # Past the guard: the unknown open_id is the only refusal left.
    assert client.post('/api/open/claim', json=body, headers=same).status_code == 409
    crossed = {'host': '127.0.0.1:8010', 'origin': 'http://localhost:8010', 'sec-fetch-site': 'same-origin'}
    assert client.post('/api/open/claim', json=body, headers=crossed).status_code == 403
    assert client.get('/api/open/generation/g?c=c', headers={'host': 'localhost:9999'}).status_code == 403


def test_successful_ack_raises_the_marked_window_only(client, monkeypatch):
    raised = []
    monkeypatch.setattr(opening.app_windows, 'raise_marked', lambda marker: raised.append(marker) or 1)
    monkeypatch.setattr(opening.shared_connection, 'is_shared_team_server', lambda: False)
    monkeypatch.setattr(opening.os, 'name', 'nt')
    headers = {'origin': 'http://127.0.0.1:8010', 'sec-fetch-site': 'same-origin'}
    marker = 'MVHubOpen-123e4567-e89b-12d3-a456-426614174000'
    for ok, mark, expect in ((True, marker, [marker]), (True, 'MVHubOpen-<script>', []), (False, marker, [])):
        broadcast = threading.Event()
        captured = {}
        async def send(message, **kwargs):
            captured.update(message)
            broadcast.set()
        monkeypatch.setattr(opening.manager, 'broadcast', send)
        opening._last_open = 0
        thread = threading.Thread(target=lambda: client.get('/api/open/generation/g?c=c', headers={
            'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1'}))
        thread.start()
        assert broadcast.wait(2)
        body = {'open_id': captured['open_id'], 'window_id': 'w'}
        assert client.post('/api/open/claim', json=body, headers=headers).status_code == 200
        raised.clear()
        answer = client.post('/api/open/ack', json={**body, 'ok': ok, 'marker': mark}, headers=headers)
        thread.join(3)
        assert answer.status_code == 200 and raised == expect


def test_claim_is_single_and_ack_checks_window_and_account(client, monkeypatch):
    broadcast = threading.Event()
    captured = {}
    async def send(message, **kwargs):
        captured.update(message)
        broadcast.set()
    monkeypatch.setattr(opening.manager, 'broadcast', send)
    result = []
    thread = threading.Thread(target=lambda: result.append(client.get('/api/open/generation/g?c=c', headers={
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1'})))
    thread.start()
    assert broadcast.wait(2)
    body = {'open_id': captured['open_id'], 'window_id': 'window'}
    headers = {'origin': 'http://127.0.0.1:8010', 'sec-fetch-site': 'same-origin'}
    assert client.post('/api/open/claim', json=body, headers=headers).status_code == 200
    assert client.post('/api/open/claim', json=body, headers=headers).status_code == 409
    assert client.post('/api/open/ack', json={**body, 'window_id': 'wrong', 'ok': True}, headers=headers).status_code == 409
    monkeypatch.setattr(opening, '_account', lambda req: (('other',), None))
    assert client.post('/api/open/ack', json={**body, 'ok': True}, headers=headers).status_code == 409
    monkeypatch.setattr(opening, '_account', lambda req: (('local',), None))
    assert client.post('/api/open/ack', json={**body, 'ok': True}, headers=headers).status_code == 200
    thread.join(3)
    assert not thread.is_alive()
    assert '열었어요' in result[0].text
