"""Single periodic worker; coalesced kicks never perform DB or network work."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from urllib.parse import quote

from .. import db, repo
from . import slack_client as client, shared_connection
from .async_tools import to_thread_non_abandon

log = logging.getLogger(__name__)


def message(target, base):
    def escape(value):
        return str(value or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    heading = '내 코멘트에 답글' if target['kind'] == 'reply' else '내 생성물에 새 코멘트'
    text = f"{heading}\n{escape(target['project_name'])} · {escape(target['author_name'])}\n{escape(target['text'][:300])}"
    url = base + '/api/open/generation/' + quote(target['gen_id'], safe='') + '?c=' + quote(target['id'], safe='')
    blocks = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}},
              {'type': 'actions', 'elements': [{'type': 'button', 'text': {'type': 'plain_text', 'text': 'MV hub에서 보기'}, 'url': url}]}]
    return text, blocks


def run_cycle():
    config = client.read_config()
    if not client.available(config):
        return
    store = repo.slack_notifications
    now = time.time()
    with db.pinned_share_operation():
        generation, lower = store.scan_context(now)
        after = None
        while True:
            rows = store.recent_comments(lower, now + 120, after)
            for row in rows:
                for email in store.recipient_emails(row['id'], only_unqueued=True):
                    target = store.delivery_target(row['id'], email)
                    if target and target['slack_team_id'] == config.get('team_id'):
                        store.enqueue(row['id'], target, generation, now)
            if len(rows) < 500:
                break
            after = rows[-1]['jd'], rows[-1]['id']
        # Bound one run so shutdown and coalesced wakeups are not starved.
        delivery_deadline = time.monotonic() + 5
        for _ in range(100):
            if time.monotonic() >= delivery_deadline:
                break
            config = client.read_config()
            if not client.available(config):
                break
            item = store.claim(time.time(), config['team_id'], config['revision'])
            if not item:
                break
            target = store.delivery_target(item['comment_id'], item['recipient_email'])
            if not target or target['slack_team_id'] != config['team_id'] or item['db_generation'] != generation:
                store.settle(item, 'closed', 'ineligible')
                continue
            if not store.begin_send(item, time.time(), config['revision']):
                continue
            try:
                text, blocks = message(target, config['open_base_url'])
                client.send_dm(config, target['slack_user_id'], text, blocks=blocks)
            except client.SlackError as exc:
                if exc.code in client.AUTH_ERRORS:
                    store.settle(item, 'auth_wait', exc.code, revision=config['revision'])
                    client.set_paused(True, revision=config['revision'])
                    break
                if exc.code in ('not_connected', 'rate_limited'):
                    delay = exc.retry_after if exc.code == 'rate_limited' else min(3600, 60 * (item['attempts'] + 1) ** 2)
                    store.settle(item, 'pending', exc.code, time.time() + delay)
                else:
                    store.settle(item, 'closed', exc.code)
            except Exception:
                # A response parsing/transport surprise may follow a successful send.
                store.settle(item, 'closed', 'unknown')
            else:
                store.settle(item, 'sent')


class SlackNotifier:
    def __init__(self):
        self._task = None
        self._loop = None
        self._event = None

    def start(self):
        if not (shared_connection.is_shared_team_server() or os.environ.get('CONTENT_HUB_SLACK_TEST_SEND') == '1'):
            return
        if self._task is None or self._task.done():
            self._loop = asyncio.get_running_loop()
            self._event = asyncio.Event()
            self._task = asyncio.create_task(self._run(), name='slack-notifier')

    def kick(self):
        try:
            if self._loop and not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._event.set)
        except Exception:
            log.warning('Slack wakeup unavailable')

    async def _run(self):
        while True:
            try:
                await to_thread_non_abandon(run_cycle)
            except Exception:
                log.warning('Slack notification cycle unavailable')
            try:
                await asyncio.wait_for(self._event.wait(), timeout=5)
            except TimeoutError:
                pass
            self._event.clear()

    async def stop(self):
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self._task = self._loop = None


notifier = SlackNotifier()
