"""Short-lived proof of access to a Slack account. Codes are never returned or logged."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

from .. import db, repo
from ..emailnorm import norm_email
from . import slack_client as client

_lock = threading.RLock()
_pending = {}
_generations = {}
_requests = {}


class LinkError(Exception):
    pass


def _identity(email, config):
    with db.get_connection() as conn:
        account = conn.execute("SELECT created_at,password_hash FROM account WHERE email=? AND status='approved'", (email,)).fetchone()
        if not account:
            raise LinkError('로그인이 필요합니다')
        # Random password salts distinguish recreated accounts even within one second.
        stamp = hashlib.sha256((account['created_at'] + account['password_hash']).encode()).digest()
        generation = repo.slack_notifications.generation(conn)
    return stamp, generation, config.get('revision'), config.get('team_id')


def status(email):
    config = client.read_config()
    link = repo.slack_notifications.link_status(email)
    linked = link if link and link['slack_team_id'] == config.get('team_id') else None
    return {'ready': client.available(config), 'linked': bool(linked),
            'slack_name': linked['slack_name'] if linked else '',
            'slack_email': linked['slack_email'] if linked else ''}


def start(email, slack_email):
    email, slack_email = norm_email(email), norm_email(slack_email)
    if not slack_email or '@' not in slack_email or len(slack_email) > 320:
        raise LinkError('Slack 이메일을 확인해 주세요')
    config = client.read_config()
    if not client.available(config):
        raise LinkError('관리자가 아직 Slack 알림을 켜지 않았어요')
    identity = _identity(email, config)
    now = time.monotonic()
    with _lock:
        recent = [t for t in _requests.get(email, []) if t > now - 3600]
        if recent and (recent[-1] > now - 60 or len(recent) >= 10):
            raise LinkError('잠시 기다린 뒤 다시 받아 주세요')
        _requests[email] = [*recent, now]
        ticket = _generations[email] = _generations.get(email, 0) + 1
        _pending.pop(email, None)
    answer = client._slack_api('users.lookupByEmail', config['token'], {'email': slack_email})
    user = answer.get('user') or {}
    if not user.get('id') or user.get('is_bot') or user.get('deleted'):
        raise LinkError('그 이메일을 쓰는 Slack 사람을 못 찾았어요')
    code = f'{secrets.randbelow(1_000_000):06d}'
    client.send_dm(config, user['id'], 'MV Hub 연결 확인 코드: ' + code + '\n10분 안에 MV Hub 설정에 입력하세요.')
    with _lock:
        if _generations.get(email) != ticket or _identity(email, client.read_config()) != identity:
            raise LinkError('연결 상태가 바뀌었어요. 코드를 다시 받아 주세요')
        _pending[email] = {'digest': hashlib.sha256(code.encode()).digest(), 'expires': now + 600,
                           'attempts': 0, 'identity': identity, 'ticket': ticket, 'user_id': user['id'],
                           'name': (user.get('profile') or {}).get('display_name') or user.get('name') or 'Slack 사용자',
                           'email': slack_email}
    return {'ok': True}


def verify(email, code):
    email = norm_email(email)
    with _lock, client._lock:
        item = _pending.get(email)
        config = client.read_config()
        if (not item or item['expires'] <= time.monotonic() or not client.available(config)
                or item['identity'] != _identity(email, config)
                or item['ticket'] != _generations.get(email)):
            _pending.pop(email, None)
            raise LinkError('코드를 다시 받아 주세요')
        item['attempts'] += 1
        if not hmac.compare_digest(item['digest'], hashlib.sha256(code.encode()).digest()):
            if item['attempts'] >= 5:
                _pending.pop(email, None)
            raise LinkError('확인 코드가 맞지 않습니다')
        with db.pinned_share_operation():
            if item['identity'] != _identity(email, client.read_config()):
                raise LinkError('코드를 다시 받아 주세요')
            try:
                repo.slack_notifications.save_link(email, item['user_id'], config['team_id'], item['name'], item['email'], item['identity'][0])
            except ValueError:
                raise LinkError('계정이 바뀌었습니다. 코드를 다시 받아 주세요') from None
        _pending.pop(email, None)
    # Confirmation is best effort; a failed DM must not undo successful linking.
    try:
        client.send_dm(config, item['user_id'], 'MV Hub와 연결됐어요. 이제 코멘트 알림을 보내 드립니다.')
    except client.SlackError:
        pass
    return status(email)


def unlink(email):
    email = norm_email(email)
    with _lock:
        _generations[email] = _generations.get(email, 0) + 1
        _pending.pop(email, None)
        repo.slack_notifications.delete_link(email)
    return status(email)
