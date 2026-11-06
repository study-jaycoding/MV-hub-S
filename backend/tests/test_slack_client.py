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


CONFIG = {'token': 'fake-token', 'revision': 1}


@pytest.fixture
def fake_slack(monkeypatch):
    """Records Slack calls; `fail[method]` makes that method raise once with the given code."""
    monkeypatch.setattr(client, '_channels', {})
    calls, fail = [], {}
    def api(method, token, payload, *, recipient_id=None, revision=None, timeout=10):
        calls.append(method)
        code = fail.pop(method, None)
        if code:
            raise client.SlackError(code)
        if method == 'conversations.open':
            client._channels[(revision, recipient_id)] = 'D' + recipient_id
            return {'ok': True, 'channel': {'id': 'D' + recipient_id}}
        return {'ok': True}
    monkeypatch.setattr(client, '_slack_api', api)
    return calls, fail


def test_dm_channel_is_reused_per_token_revision(fake_slack):
    calls, _ = fake_slack
    client.send_dm(CONFIG, 'U1', 'a')
    client.send_dm(CONFIG, 'U1', 'b')
    assert calls == ['conversations.open', 'chat.postMessage', 'chat.postMessage']
    client.send_dm({**CONFIG, 'revision': 2}, 'U1', 'c')
    assert calls[-2:] == ['conversations.open', 'chat.postMessage']


def test_stale_remembered_channel_is_forgotten_and_retried(fake_slack):
    calls, fail = fake_slack
    client.send_dm(CONFIG, 'U1', 'a')
    fail['chat.postMessage'] = 'channel_not_found'
    with pytest.raises(client.SlackError, match='not_connected'):  # Slack refused it: nothing was sent
        client.send_dm(CONFIG, 'U1', 'b')
    assert (1, 'U1') not in client._channels
    client.send_dm(CONFIG, 'U1', 'b')  # the retry opens again and sends
    assert calls[-2:] == ['conversations.open', 'chat.postMessage']


def test_fresh_channel_not_found_still_closes(fake_slack):
    _, fail = fake_slack
    fail['chat.postMessage'] = 'channel_not_found'
    with pytest.raises(client.SlackError, match='channel_not_found'):
        client.send_dm(CONFIG, 'U1', 'a')


def test_stale_entry_is_kept_when_the_cache_already_changed(fake_slack, monkeypatch):
    client.send_dm(CONFIG, 'U1', 'a')
    def api(method, *a, **k):
        client._channels[(1, 'U1')] = 'DNEWER'  # another send re-opened meanwhile
        raise client.SlackError('channel_not_found')
    monkeypatch.setattr(client, '_slack_api', api)
    with pytest.raises(client.SlackError, match='not_connected'):
        client.send_dm(CONFIG, 'U1', 'b')
    assert client._channels[(1, 'U1')] == 'DNEWER'


@pytest.mark.parametrize('code,expected', [('unknown', 'not_connected'), ('invalid_auth', 'invalid_auth'),
                                           ('rate_limited', 'rate_limited'), ('not_connected', 'not_connected')])
def test_open_stage_failures_never_post(fake_slack, code, expected):
    calls, fail = fake_slack
    fail['conversations.open'] = code
    with pytest.raises(client.SlackError, match=expected):
        client.send_dm(CONFIG, 'U1', 'a')
    assert 'chat.postMessage' not in calls


def test_no_time_left_after_open_is_retryable_without_posting(fake_slack, monkeypatch):
    calls, _ = fake_slack
    ticks = iter([0.0, 11.0])
    monkeypatch.setattr(client.time, 'monotonic', lambda: next(ticks, 11.0))
    with pytest.raises(client.SlackError, match='not_connected'):
        client.send_dm(CONFIG, 'U1', 'a')
    assert calls == ['conversations.open']


def test_post_stage_unknown_is_never_resent(fake_slack):
    calls, fail = fake_slack
    fail['chat.postMessage'] = 'unknown'  # may already have been delivered
    with pytest.raises(client.SlackError, match='^unknown$'):
        client.send_dm(CONFIG, 'U1', 'a')
    assert calls.count('chat.postMessage') == 1


@pytest.mark.parametrize('error', ['users_not_found', 'user_not_found', 'invalid_email'])
def test_lookup_not_found_keeps_its_code(monkeypatch, block_live_slack, error):
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: True)
    class Opener:
        def open(self, *args, **kwargs):
            return io.BytesIO(json.dumps({'ok': False, 'error': error}).encode())
    monkeypatch.setattr(client.urllib.request, 'build_opener', lambda *a: Opener())
    with pytest.raises(client.SlackError) as raised:
        block_live_slack('users.lookupByEmail', 'fake', {'email': 'typo@slack.test'})
    assert raised.value.code == error


# A backup's config as server_move install leaves it (memory fixture reverses 'test-only-token').
BACKUP = {'revision': 4, 'team_id': 'TUNIT', 'data': 'nekot-ylno-tset', 'enabled': True,
          'open_base_url': 'http://127.0.0.1:8010'}


def _restored(tmp_path, config):
    import sqlite3
    from contextlib import closing
    from app.services import db_scrub
    path = tmp_path / 'restored.db'
    with closing(sqlite3.connect(path)) as conn:
        conn.execute('CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)')
        conn.execute('INSERT INTO app_setting VALUES(?,?)', (client.SETTING_KEY, json.dumps(config)))
        conn.commit()
    assert db_scrub.pause_slack_for_restore(path)
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute('SELECT value FROM app_setting WHERE key=?', (client.SETTING_KEY,)).fetchone()[0]


def test_restored_resume_resets_floor_and_clears_marker(memory, tmp_path, monkeypatch):
    memory[client.SETTING_KEY] = _restored(tmp_path, {**BACKUP, 'paused': False})
    assert client.public_config()['pause_reason'] == 'restored' and client.read_config()['paused']
    resets = []
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: resets.append(kw))
    client.set_paused(False)
    stored = json.loads(memory[client.SETTING_KEY])
    assert resets == [{}] and stored['paused'] is False and stored['pause_reason'] == '' and 'restored' not in stored


def test_manual_pause_keeps_restore_marker(memory, tmp_path, monkeypatch):
    memory[client.SETTING_KEY] = _restored(tmp_path, {**BACKUP, 'paused': False})
    resets = []
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: resets.append(kw))
    client.set_paused(True)
    assert json.loads(memory[client.SETTING_KEY])['restored'] is True and not resets


@pytest.mark.parametrize('before', [{'paused': False}, {'paused': True, 'pause_reason': 'manual'},
                                    {'paused': True, 'pause_reason': 'auth_error'}])
def test_restored_same_team_reregistration_resets_floor_once(memory, tmp_path, monkeypatch, before):
    memory[client.SETTING_KEY] = _restored(tmp_path, {**BACKUP, **before})
    resets = []
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: resets.append(kw))
    client.save_config('test-only-new', 'TUNIT', 'http://127.0.0.1:8010', True)
    stored = json.loads(memory[client.SETTING_KEY])
    assert resets == [{'reason': 'restored'}] and 'restored' not in stored and stored['paused'] is False
    client.save_config('test-only-newer', 'TUNIT', 'http://127.0.0.1:8010', True)  # marker gone: J7 again
    assert resets == [{'reason': 'restored'}]


def test_restored_auth_error_still_needs_a_new_token(memory, tmp_path):
    memory[client.SETTING_KEY] = _restored(tmp_path, {**BACKUP, 'paused': True, 'pause_reason': 'auth_error'})
    assert client.public_config()['pause_reason'] == 'auth_error'
    with pytest.raises(ValueError):
        client.set_paused(False)
    assert json.loads(memory[client.SETTING_KEY])['restored'] is True


def test_unmarked_manual_pause_reregistration_keeps_floor(memory, monkeypatch):
    client.save_config('test-only-token', 'TUNIT', 'http://127.0.0.1:8010', True)
    client.set_paused(True)
    resets = []
    monkeypatch.setattr(client.repo.slack_notifications, 'reset_floor', lambda **kw: resets.append(kw))
    client.save_config('test-only-new', 'TUNIT', 'http://127.0.0.1:8010', True)
    assert not resets


def test_restored_auth_wait_row_is_not_resent_after_reregistration(tmp_path, monkeypatch):
    """Codex 2nd-round case: an auth_error backup's auth_wait row must not revive under the new token revision."""
    import time
    from app import config, db, repo
    from app.services import db_scrub
    monkeypatch.setenv('CONTENT_HUB_DB', str(tmp_path / 'content_hub.db'))
    monkeypatch.setattr(config, 'MANAGE_ENABLED', False)
    monkeypatch.setattr(client.comfy_team_key, 'protect', lambda key: key[::-1])
    monkeypatch.setattr(client.comfy_team_key, 'unprotect', lambda key: key[::-1])
    db.flush_pool()
    db.init_db()
    try:
        with db.get_connection() as conn:
            conn.execute('INSERT INTO app_setting(key,value) VALUES(?,?)', (client.SETTING_KEY, json.dumps(
                {**BACKUP, 'paused': True, 'pause_reason': 'auth_error'})))
            conn.execute("INSERT INTO slack_dm_outbox(comment_id,recipient_email,kind,created_at,db_generation,state,"
                         "token_revision,slack_team_id) VALUES('c1','a@unit.test','mention',?,'g','auth_wait',4,'TUNIT')",
                         (time.time() - 60,))
        db.flush_pool()
        assert db_scrub.pause_slack_for_restore(db.get_db_path())
        client.save_config('test-only-new', 'TUNIT', 'http://127.0.0.1:8010', True)
        assert repo.slack_notifications.claim(time.time(), 'TUNIT', client.read_config()['revision']) is None
        with db.get_connection() as conn:
            assert tuple(conn.execute('SELECT state, close_reason FROM slack_dm_outbox').fetchone()) == ('closed', 'restored')
    finally:
        db.flush_pool()
