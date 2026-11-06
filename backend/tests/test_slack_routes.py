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


def test_link_and_token_writes_run_to_completion_and_admin_put_accepts_old_and_new_bodies(web, monkeypatch):
    used = []
    real = slack.to_thread_non_abandon
    async def spy(func, *args, **kwargs):
        used.append(getattr(func, '__name__', ''))
        return await real(func, *args, **kwargs)
    monkeypatch.setattr(slack, 'to_thread_non_abandon', spy)
    monkeypatch.setattr(slack, '_link_request', lambda *a: {'ok': True})
    assert web.post('/api/slack/link/start', json={'slack_email': 'unit@slack.test'}).status_code == 200
    assert web.post('/api/slack/link/verify', json={'code': '123456'}).status_code == 200
    monkeypatch.setattr(slack.config, 'AUTH_ENABLED', True)
    monkeypatch.setattr(slack, '_admin', lambda request: None)
    monkeypatch.setattr(slack.deps, 'current_account', lambda request: {'email': 'admin@unit.test'})
    monkeypatch.setattr(slack.client, '_slack_api', lambda *a, **k: {'ok': True, 'team_id': 'TUNIT'})
    monkeypatch.setattr(slack.notifier, 'kick', lambda: None)
    saved = []
    monkeypatch.setattr(slack.client, 'save_config', lambda *a: saved.append(a) or {'state': 'ok'})
    # New console sends no address; an old console still sends its address field.
    assert web.put('/api/admin/slack', json={'bot_token': 'test-value'}).status_code == 200
    assert web.put('/api/admin/slack', json={'bot_token': 'test-value', 'open_base_url': 'http://127.0.0.1:8010'}).status_code == 200
    assert used == ['<lambda>', '<lambda>', 'save', 'save']
    assert [args[2] for args in saved] == ['http://127.0.0.1:8010'] * 2


def test_cancelled_link_request_still_finishes_exactly_once(monkeypatch):
    import asyncio
    import threading
    started, release, runs, finished = threading.Event(), threading.Event(), [], []
    def work(*args):
        runs.append(args)
        started.set()
        release.wait(5)
        finished.append(True)
        return {'ok': True}
    monkeypatch.setattr(slack, '_link_request', work)
    class Request:
        async def json(self):
            return {'code': '123456'}
    async def scenario():
        task = asyncio.ensure_future(slack.verify_link(Request()))
        while not started.is_set():
            await asyncio.sleep(0.01)
        task.cancel()  # the browser went away mid-request
        await asyncio.sleep(0.05)
        assert not task.done()  # still waiting for the write to finish
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())
    assert len(runs) == 1 and finished == [True]


def test_auth_pause_resume_returns_actionable_conflict(web, monkeypatch):
    monkeypatch.setattr(slack, '_admin', lambda request: None)
    def reject(*args):
        raise ValueError('토큰 오류로 멈췄습니다. 토큰을 다시 등록해 주세요')
    monkeypatch.setattr(slack.client, 'set_paused', reject)
    answer = web.post('/api/admin/slack/resume')
    assert answer.status_code == 409
    assert '다시 등록' in answer.json()['detail']
