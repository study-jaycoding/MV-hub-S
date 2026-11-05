"""Slack HTTP boundary and machine-local encrypted configuration. Never log payloads."""
from __future__ import annotations

import errno
import json
import os
import socket
import threading
import time
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request

from .. import repo
from . import comfy_team_key, shared_connection

SETTING_KEY = 'slack_bot_config'
AUTH_ERRORS = frozenset({'invalid_auth', 'token_revoked', 'not_authed'})
_lock = threading.RLock()
_reserved = 0
_channels: dict[tuple[int, str], str] = {}


class SlackError(Exception):
    def __init__(self, code, retry_after=0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(code)


def read_config():
    raw = repo.get_setting(SETTING_KEY)
    try:
        config = json.loads(raw) if raw else {}
        if not isinstance(config, dict):
            raise ValueError()
    except (ValueError, TypeError):
        return {'state': 'undecryptable', 'revision': 0, 'enabled': False}
    config.setdefault('revision', 0)
    config.setdefault('enabled', False)
    if not config.get('data'):
        config['state'] = 'none'
        return config
    try:
        config['token'] = comfy_team_key.unprotect(config['data'])
        config['state'] = 'ok'
    except comfy_team_key.ProtectError:
        config['state'] = 'undecryptable'
    return config


def public_config(config=None):
    config = read_config() if config is None else config
    return {k: config.get(k) for k in ('state', 'revision', 'team_id', 'enabled', 'paused', 'pause_reason', 'open_base_url', 'updated_at', 'updated_by')}


def available(config):
    return config.get('state') == 'ok' and config.get('enabled') and not config.get('paused')


def save_config(token, team_id, open_base_url, enabled, updated_by=''):
    url = urllib.parse.urlsplit(open_base_url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('열기 주소는 http://127.0.0.1:포트 형식이어야 합니다')
    try:
        port = url.port or 80
    except ValueError:
        raise ValueError('열기 주소의 포트가 올바르지 않습니다') from None
    if not 1 <= port <= 65535:
        raise ValueError('열기 주소의 포트가 올바르지 않습니다')
    data = comfy_team_key.protect(token)
    with _lock:
        old = read_config()
        config = {'revision': int(old.get('revision') or 0) + 1, 'team_id': team_id,
                  'data': data, 'enabled': bool(enabled), 'paused': False,
                  'open_base_url': open_base_url.rstrip('/'), 'updated_by': updated_by,
                  'updated_at': datetime.now(timezone.utc).isoformat()}
        # Also reset first activation. Same-team credential repair keeps the floor.
        if not old.get('team_id') or old.get('team_id') != team_id:
            repo.slack_notifications.reset_floor(reason='team_changed')
        repo.set_setting(SETTING_KEY, json.dumps(config))
        return public_config()


def set_paused(paused, *, revision=None):
    with _lock:
        config = read_config()
        if revision is not None and config.get('revision') != revision:
            return
        if not paused and config.get('pause_reason') == 'auth_error':
            raise ValueError('토큰 오류로 멈췄습니다. 토큰을 다시 등록해 주세요')
        config.pop('token', None)
        config.pop('state', None)
        config['paused'] = paused
        if revision is not None:
            config['pause_reason'] = 'auth_error'
        elif config.get('pause_reason') != 'auth_error':
            config['pause_reason'] = 'manual' if paused else ''
        if revision is None and not paused:
            repo.slack_notifications.reset_floor()
        repo.set_setting(SETTING_KEY, json.dumps(config))


def clear_config():
    with _lock:
        # Never reuse a revision: a late error from the deleted token cannot pause a new one.
        repo.set_setting(SETTING_KEY, json.dumps({'revision': int(read_config().get('revision') or 0) + 1, 'enabled': False}))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Credentials never follow redirects away from Slack.


def _slack_api(method, token, payload, *, recipient_id=None, revision=None, timeout=10):
    """Single egress; tests replace this function, never a lower-level live socket."""
    global _reserved
    testing = os.environ.get('CONTENT_HUB_SLACK_TEST_SEND') == '1'
    if testing:
        allowed = {v.strip() for v in os.environ.get('CONTENT_HUB_SLACK_TEST_RECIPIENTS', '').split(',') if v.strip()}
        if method in ('conversations.open', 'chat.postMessage'):
            with _lock:
                if not recipient_id or recipient_id not in allowed or _reserved >= 20:
                    raise SlackError('test_send_blocked')
                _reserved += 1
    elif not shared_connection.is_shared_team_server():
        raise SlackError('send_disabled')
    if method == 'conversations.open' and payload.get('users') != recipient_id:
        raise SlackError('recipient_mismatch')
    if method in ('conversations.open', 'chat.postMessage') and not isinstance(revision, int):
        raise SlackError('recipient_mismatch')
    if method == 'chat.postMessage':
        with _lock:
            if not recipient_id or _channels.get((revision, recipient_id)) != payload.get('channel'):
                raise SlackError('recipient_mismatch')
    # Slack rejects JSON bodies on read methods (users.lookupByEmail → invalid_arguments, measured 2026-11-05); only chat.postMessage needs JSON (blocks).
    if method == 'chat.postMessage':
        data, content_type = json.dumps(payload).encode('utf-8'), 'application/json; charset=utf-8'
    else:
        data, content_type = urllib.parse.urlencode(payload).encode('utf-8'), 'application/x-www-form-urlencoded'
    request = urllib.request.Request('https://slack.com/api/' + method, data=data,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type}, method='POST')
    deadline = time.monotonic() + timeout
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=max(0.1, timeout)) as response:
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                sock = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
                if sock:
                    sock.settimeout(remaining)
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > 1_000_000:
                    raise ValueError()
            result = json.loads(b''.join(chunks))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            try:
                delay = max(1, int(exc.headers.get('Retry-After', '60')))
            except (TypeError, ValueError):
                delay = 60
            exc.close()
            raise SlackError('rate_limited', delay) from None
        exc.close()
        raise SlackError('unknown') from None
    except urllib.error.URLError as exc:
        reason = exc.reason
        # urllib cannot distinguish connect/send timeouts: close as unknown to avoid duplicate DMs.
        before = isinstance(reason, (socket.gaierror, ConnectionRefusedError)) or getattr(reason, 'errno', None) == errno.ECONNREFUSED
        raise SlackError('not_connected' if before else 'unknown') from None
    except (OSError, ValueError):
        raise SlackError('unknown') from None
    if not isinstance(result, dict):
        raise SlackError('unknown')
    if result.get('ok') is not True:
        code = result.get('error')
        safe = AUTH_ERRORS | {'user_not_found', 'channel_not_found', 'account_inactive', 'is_bot', 'missing_scope', 'not_allowed_token_type', 'invalid_email'}
        raise SlackError(code if code in safe else 'unknown')
    if method == 'conversations.open':
        channel = (result.get('channel') or {}).get('id')
        if not isinstance(channel, str) or not channel.startswith('D'):
            raise SlackError('unknown')
        with _lock:
            _channels[(revision, recipient_id)] = channel
    return result


def send_dm(config, user_id, text, *, blocks=None):
    deadline = time.monotonic() + 10
    answer = _slack_api('conversations.open', config['token'], {'users': user_id}, recipient_id=user_id, revision=config['revision'])
    channel = answer['channel']['id']
    payload = {'channel': channel, 'text': text, 'unfurl_links': False, 'unfurl_media': False}
    if blocks:
        payload['blocks'] = blocks
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SlackError('unknown')
    return _slack_api('chat.postMessage', config['token'], payload, recipient_id=user_id, revision=config['revision'], timeout=remaining)
