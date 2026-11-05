import io
import json
import socket
import urllib.error
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.services import slack_client as client


@pytest.fixture
def memory(monkeypatch):
    data = {}
    monkeypatch.setattr(client.repo, 'get_setting', lambda key: data.get(key))
    monkeypatch.setattr(client.repo, 'set_setting', lambda key, value: data.__setitem__(key, value))
    monkeypatch.setattr(client.comfy_team_key, 'protect', lambda key: key[::-1])
    monkeypatch.setattr(client.comfy_team_key, 'unprotect', lambda key: key[::-1])
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: None)
    return data


def test_config_metadata_and_revision_survive_delete(memory):
    first = client.save_config('test-only-token', 'TUNIT', 'http://127.0.0.1:8010', True)
    assert first['revision'] == 1 and 'test-only-token' not in str(first)
    assert 'token' not in first and 'data' not in first
    client.clear_config()
    newer = client.save_config('test-only-new', 'TUNIT', 'http://127.0.0.1:8010', True)
    assert newer['revision'] > first['revision']
    client.set_paused(True, revision=first['revision'])
    assert client.read_config()['paused'] is False


def test_bad_address_is_not_saved(memory):
    with pytest.raises(ValueError):
        client.save_config('test-only-token', 'TUNIT', 'https://outside.invalid', True)
    assert memory == {}


def test_encryption_failure_does_not_save(memory, monkeypatch):
    def fail(_):
        raise client.comfy_team_key.ProtectError('test failure')
    monkeypatch.setattr(client.comfy_team_key, 'protect', fail)
    with pytest.raises(client.comfy_team_key.ProtectError):
        client.save_config('test-only-token', 'TUNIT', 'http://127.0.0.1:8010', True)
    assert memory == {}


def test_undecryptable_preserves_original(memory, monkeypatch):
    memory[client.SETTING_KEY] = json.dumps({'data': 'unreadable', 'revision': 8})
    original = dict(memory)
    def fail(_):
        raise client.comfy_team_key.ProtectError('test failure')
    monkeypatch.setattr(client.comfy_team_key, 'unprotect', fail)
    assert client.read_config()['state'] == 'undecryptable'
    assert memory == original


@pytest.mark.parametrize('status,expected', [(429, 'rate_limited'), (500, 'unknown'), (503, 'unknown')])
def test_http_failure_classification(monkeypatch, block_live_slack, status, expected):
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: True)
    class Opener:
        def open(self, *args, **kwargs):
            raise urllib.error.HTTPError('https://slack.com/api/auth.test', status, 'fake', {'Retry-After': '7'}, None)
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    with pytest.raises(client.SlackError) as error:
        block_live_slack('auth.test', 'fake', {})
    assert error.value.code == expected


def test_quota_reservation_atomic_and_checks_actual_recipient(monkeypatch, block_live_slack):
    monkeypatch.setenv('CONTENT_HUB_SLACK_TEST_SEND', '1')
    monkeypatch.setenv('CONTENT_HUB_SLACK_TEST_RECIPIENTS', 'UALLOWED')
    monkeypatch.setattr(client, '_reserved', 0)
    monkeypatch.setattr(client, '_channels', {})
    class Answer(io.BytesIO):
        pass
    class Opener:
        def open(self, *args, **kwargs):
            return Answer(b'{"ok":true,"channel":{"id":"DUNIT"}}')
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    def call(_):
        try:
            block_live_slack('conversations.open', 'fake', {'users': 'UALLOWED'}, recipient_id='UALLOWED', revision=1)
            return True
        except client.SlackError:
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(call, range(40))) == 20
    monkeypatch.setattr(client, '_reserved', 0)
    with pytest.raises(client.SlackError, match='recipient_mismatch'):
        block_live_slack('chat.postMessage', 'fake', {'channel': 'DOTHER'}, recipient_id='UALLOWED', revision=1)


def test_wakeup_failure_does_not_escape_to_comment_writer():
    from app.services.slack_notify import SlackNotifier
    class ClosingLoop:
        def is_closed(self):
            return False
        def call_soon_threadsafe(self, callback):
            raise RuntimeError('loop closed concurrently')
    worker = SlackNotifier()
    worker._loop = ClosingLoop()
    worker._event = type('Event', (), {'set': lambda self: None})()
    worker.kick()  # a successful comment response must survive this shutdown race


def test_auth_pause_requires_token_replacement_and_keeps_floor(memory, monkeypatch):
    client.save_config('test-only-token', 'TUNIT', 'http://127.0.0.1:8010', True)
    resets = []
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: resets.append(kw))
    client.set_paused(True, revision=1)
    assert client.public_config()['pause_reason'] == 'auth_error'
    client.set_paused(True)  # A manual pause cannot erase the authentication error.
    with pytest.raises(ValueError):
        client.set_paused(False)
    assert not resets
    assert client.read_config()['paused']
    client.save_config('test-only-new', 'TUNIT', 'http://127.0.0.1:8010', True)
    assert not resets
    assert client.public_config()['pause_reason'] is None
    assert client.read_config()['paused'] is False


def test_connection_timeout_is_unknown(monkeypatch, block_live_slack):
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: True)
    class Opener:
        def open(self, *args, **kwargs):
            raise urllib.error.URLError(socket.timeout())
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    with pytest.raises(client.SlackError) as error:
        block_live_slack('auth.test', 'fake', {})
    assert error.value.code == 'unknown'


def test_read_methods_send_form_body_and_post_message_sends_json(monkeypatch, block_live_slack):
    # Real Slack answered invalid_arguments to a JSON users.lookupByEmail (2026-11-05); fakes must pin the wire format.
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: True)
    monkeypatch.setattr(client, '_channels', {(1, 'UUNIT'): 'DUNIT'})
    sent = []
    class Opener:
        def open(self, request, *args, **kwargs):
            sent.append((request.get_header('Content-type'), request.data))
            return io.BytesIO(b'{"ok":true,"user":{"id":"UUNIT"}}')
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    block_live_slack('users.lookupByEmail', 'fake', {'email': 'a+b@unit.test'})
    block_live_slack('chat.postMessage', 'fake', {'channel': 'DUNIT', 'text': '안녕'}, recipient_id='UUNIT', revision=1)
    assert sent[0] == ('application/x-www-form-urlencoded', b'email=a%2Bb%40unit.test')
    assert sent[1][0].startswith('application/json') and json.loads(sent[1][1]) == {'channel': 'DUNIT', 'text': '안녕'}


def test_channel_verification_is_bound_to_revision(monkeypatch, block_live_slack):
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: True)
    monkeypatch.setattr(client, '_channels', {})
    class Opener:
        def open(self, *args, **kwargs):
            return io.BytesIO(b'{"ok":true,"channel":{"id":"DUNIT"}}')
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    block_live_slack('conversations.open', 'fake', {'users': 'UUNIT'}, recipient_id='UUNIT', revision=1)
    assert client._channels == {(1, 'UUNIT'): 'DUNIT'}
    with pytest.raises(client.SlackError, match='recipient_mismatch'):
        block_live_slack('chat.postMessage', 'fake-new', {'channel': 'DUNIT'}, recipient_id='UUNIT', revision=2)
