from contextlib import contextmanager

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.routers import slack


@pytest.fixture
def web(monkeypatch):
    monkeypatch.setattr(slack.config, 'AUTH_ENABLED', False)
    app = FastAPI()
    app.include_router(slack.router)
    with TestClient(app, base_url='http://127.0.0.1:8010') as client:
        yield client


def test_hub_never_proxies_admin_token(web):
    answer = web.put('/api/admin/slack', json={'bot_token': 'test-value'})
    assert answer.status_code == 404
    assert 'test-value' not in answer.text


@pytest.mark.parametrize('path,body', [('/start', {'slack_email': 'unit@slack.test'}), ('/verify', {'code': '123456'})])
def test_cross_site_link_writes_blocked_before_proxy(web, path, body, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('must not proxy')
    monkeypatch.setattr(slack._proxy, 'proxy_json', forbidden)
    answer = web.post('/api/slack/link' + path, json=body,
                      headers={'origin': 'https://evil.invalid', 'sec-fetch-site': 'cross-site'})
    assert answer.status_code == 403


def test_code_validation_never_echoes_value(web):
    answer = web.post('/api/slack/link/verify', json={'code': 'test-sensitive-input'})
    assert answer.status_code == 400 and 'test-sensitive-input' not in answer.text


def test_hub_pins_and_checks_expected_account(web, monkeypatch):
    @contextmanager
    def pinned():
        yield 'unit@mv.test'
    monkeypatch.setattr(slack.active_account, 'pinned_account_scope', pinned)
    monkeypatch.setattr(slack._proxy, 'proxying', lambda: True)
    monkeypatch.setattr(slack._proxy, 'base_url', lambda: 'http://server.invalid')
    monkeypatch.setattr(slack._proxy, 'token', lambda: 'test-token')
    called = []
    monkeypatch.setattr(slack._proxy, 'proxy_json', lambda *a, **kw: called.append(a) or {'ready': False})
    answer = web.get('/api/slack/link', headers={'X-MVHub-Expect-Account': 'acct:other@mv.test'})
    assert answer.status_code == 409 and not called
    answer = web.get('/api/slack/link', headers={'X-MVHub-Expect-Account': 'acct:unit@mv.test'})
    assert answer.status_code == 200 and called == [('GET', '/api/slack/link')]


def test_auth_pause_resume_returns_actionable_conflict(web, monkeypatch):
    monkeypatch.setattr(slack, '_admin', lambda request: None)
    def reject(*args):
        raise ValueError('토큰 오류로 멈췄습니다. 토큰을 다시 등록해 주세요')
    monkeypatch.setattr(slack.client, 'set_paused', reject)
    answer = web.post('/api/admin/slack/resume')
    assert answer.status_code == 409
    assert '다시 등록' in answer.json()['detail']
