"""Slack recipients and durable delivery state; no network calls."""
from __future__ import annotations

import hashlib
import math
import time
import uuid

from .. import rbac
from ..db import get_connection
from ..emailnorm import norm_email
from ._common import ALERT_COMMENT_TARGET_PREDICATE
from ._visibility import alert_comment_visibility_clause
from .identity import resolve_display_names

FLOOR_KEY = 'slack_notify_floor'
GENERATION_KEY = 'slack_notify_generation'


def _setting(conn, key, value):
    conn.execute('INSERT INTO app_setting(key,value) VALUES(?,?) '
                 'ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))


def generation(conn):
    row = conn.execute("SELECT value FROM app_setting WHERE key='share_db_generation'").fetchone()
    return row[0] if row else ''


def reset_floor(now=None, reason='resumed'):
    now = time.time() if now is None else now
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _setting(conn, FLOOR_KEY, now)
        _setting(conn, GENERATION_KEY, generation(conn))
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason=? "
                     "WHERE state IN ('pending','auth_wait')", (now, reason))


def scan_context(now):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        settings = dict(conn.execute('SELECT key,value FROM app_setting WHERE key IN (?,?)',
                                     (FLOOR_KEY, GENERATION_KEY)))
        current = generation(conn)
        if settings.get(GENERATION_KEY) != current or FLOOR_KEY not in settings:
            _setting(conn, FLOOR_KEY, now)
            _setting(conn, GENERATION_KEY, current)
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason='db_changed' "
                     "WHERE db_generation<>? AND state IN ('pending','auth_wait','sending')", (now, current))
        floor = float(settings[FLOOR_KEY]) if settings.get(GENERATION_KEY) == current and FLOOR_KEY in settings else now
        return current, max(floor, now - 1800)


def _judged_uid(email, creator_uid):
    """The uid the bell judges an account by; window_candidates and delivery_target must agree."""
    return creator_uid or 'acct:' + email


# The caller freezes bounds for the whole cycle. Comment times are whole seconds, so the lower bound is
# floored, and SQLite converts both bounds the same way it converts created_at (a Python Julian-day
# formula can differ in the last digit and drop that second's comments).
_WINDOW = ("c.is_private=0 AND julianday(c.created_at) "
           "BETWEEN julianday(?,'unixepoch') AND julianday(?,'unixepoch')")


def window_candidates(lower, upper, team_id):
    """Unqueued (comment_id, email) pairs in the window that delivery_target may still accept.

    Four queries in one snapshot for the whole window, closed before the caller judges each pair
    (per-comment recipient lookups cost 4-5 queries per comment every cycle: 1.6s at 2,000 comments).
    Recipients resolve exactly as before: the approved account a uid maps to unambiguously, linked to
    Slack, not already queued (sent and closed included). Only facts that never change for a pair
    (author, owner, parent, link team) are pre-checked; delivery_target stays the authority.
    shortcut: a pair rejected on trash/visibility/membership is re-judged every cycle; fine while rare.
    """
    bounds = (math.floor(lower), upper)
    with get_connection() as conn:
        conn.execute('BEGIN')
        comments = conn.execute(
            'SELECT c.id,c.author,g.creator_uid,p.author FROM generation_comment c JOIN generation g ON g.id=c.gen_id '
            f'LEFT JOIN generation_comment p ON p.id=c.parent_id WHERE {_WINDOW} '
            'ORDER BY julianday(c.created_at),c.id', bounds).fetchall()
        accounts = {r[0]: r[1] for r in conn.execute("SELECT email,creator_uid FROM account WHERE status='approved'")}
        teams = {r[0]: r[1] for r in conn.execute('SELECT account_email,slack_team_id FROM slack_link')}
        queued = {(r[0], r[1]) for r in conn.execute(
            'SELECT o.comment_id,o.recipient_email FROM slack_dm_outbox o '
            f'JOIN generation_comment c ON c.id=o.comment_id WHERE {_WINDOW}', bounds)}
    owners = {}
    for email, uid in accounts.items():
        owners.setdefault(uid, []).append(email)

    def resolve(uid):
        if not uid or uid == 'me':
            return None
        found = [e for e in (norm_email(uid[5:]),) if e in accounts] if uid.startswith('acct:') else owners.get(uid, [])
        return found[0] if len(found) == 1 else None

    pairs = []
    for comment_id, author, owner_uid, parent_uid in comments:
        for email in sorted({e for e in map(resolve, {owner_uid, parent_uid}) if e}):
            judged = _judged_uid(email, accounts[email])
            if (teams.get(norm_email(email)) == team_id and (comment_id, email) not in queued
                    and author is not None and author != judged and judged in (owner_uid, parent_uid)):
                pairs.append((comment_id, email))
    return pairs


def delivery_target(comment_id, email):
    """Re-evaluate the bell predicate, membership and current link in one read snapshot."""
    with get_connection() as conn:
        conn.execute('BEGIN')
        account = conn.execute("SELECT * FROM account WHERE email=? AND status='approved'", (norm_email(email),)).fetchone()
        link = conn.execute('SELECT * FROM slack_link WHERE account_email=?', (norm_email(email),)).fetchone()
        if not account or not link:
            return None
        uid = _judged_uid(account['email'], account['creator_uid'])
        read_all = rbac.has_global_cap(rbac.parse_roles(account['global_role']), 'read_all')
        projects = [r[0] for r in conn.execute('SELECT project_id FROM project_member WHERE creator_uid=?', (uid,))]
        clause, args = alert_comment_visibility_clause(uid, read_all, projects)
        row = conn.execute(
            'SELECT c.*,g.project_id,p.author AS parent_author '
            'FROM generation_comment c JOIN generation g ON g.id=c.gen_id '
            'LEFT JOIN generation_comment p ON p.id=c.parent_id '
            f'WHERE c.id=? AND {ALERT_COMMENT_TARGET_PREDICATE} {clause}',
            (comment_id, uid, uid, uid, *args)).fetchone()
        if not row:
            return None
        item = dict(row)
        item.update(dict(link))
        item['author_name'] = resolve_display_names(conn, [item['author']]).get(item['author']) or '팀원'
        project = conn.execute('SELECT name FROM project WHERE id=?', (item['project_id'],)).fetchone()
        item['project_name'] = project[0] if project else ''
        item['kind'] = 'reply' if item['parent_author'] == uid else 'comment'
        return item


def enqueue(comment_id, target, db_generation, now):
    with get_connection() as conn:
        if generation(conn) != db_generation:
            return
        conn.execute('INSERT OR IGNORE INTO slack_dm_outbox '
                     '(comment_id,recipient_email,kind,created_at,db_generation,slack_team_id) VALUES(?,?,?,?,?,?)',
                     (comment_id, target['account_email'], target['kind'], now, db_generation, target['slack_team_id']))


def claim(now, team_id, revision):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason='unknown' "
                     "WHERE state='sending' AND lease_until<=?", (now, now))
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason='stale' "
                     "WHERE state IN ('pending','auth_wait') AND created_at<=?", (now, now - 900))
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason='team_changed' "
                     "WHERE state IN ('pending','auth_wait') AND slack_team_id<>?", (now, team_id))
        conn.execute("UPDATE slack_dm_outbox SET state='pending' WHERE state='auth_wait' "
                     "AND token_revision<>? AND slack_team_id=?", (revision, team_id))
        row = conn.execute("SELECT * FROM slack_dm_outbox WHERE state='pending' AND next_retry_at<=? "
                           "AND (lease_until IS NULL OR lease_until<=?) ORDER BY id LIMIT 1", (now, now)).fetchone()
        if not row:
            return None
        item = dict(row)
        item['lease_token'] = uuid.uuid4().hex
        conn.execute('UPDATE slack_dm_outbox SET lease_token=?,lease_until=? WHERE id=?',
                     (item['lease_token'], now + 60, item['id']))
        return item


def begin_send(item, now, revision):
    with get_connection() as conn:
        return generation(conn) == item['db_generation'] and conn.execute(
            "UPDATE slack_dm_outbox SET state='sending',send_started_at=?,token_revision=?,attempts=attempts+1 "
            "WHERE id=? AND lease_token=? AND lease_until>? AND state='pending'",
            (now, revision, item['id'], item['lease_token'], now)).rowcount == 1


def settle(item, state, reason='', retry_at=0, now=None, revision=None):
    now = time.time() if now is None else now
    with get_connection() as conn:
        if generation(conn) != item['db_generation']:
            return
        conn.execute('UPDATE slack_dm_outbox SET state=?,close_reason=?,next_retry_at=?, '
                     'send_started_at=CASE WHEN ? IN (\'pending\',\'auth_wait\') THEN NULL ELSE send_started_at END,'
                     'closed_at=?,sent_at=?,lease_token=NULL,lease_until=NULL,'
                     'token_revision=COALESCE(?,token_revision) WHERE id=? AND lease_token=?',
                     (state, reason, retry_at, state, now if state == 'closed' else None,
                      now if state == 'sent' else None, revision, item['id'], item['lease_token']))


def link_status(email):
    with get_connection() as conn:
        row = conn.execute('SELECT slack_name,slack_email,slack_team_id FROM slack_link WHERE account_email=?', (norm_email(email),)).fetchone()
        return dict(row) if row else None


def save_link(email, user_id, team_id, name, slack_email, expected_stamp=None):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if expected_stamp is not None:
            account = conn.execute("SELECT created_at,password_hash FROM account WHERE email=? AND status='approved'", (norm_email(email),)).fetchone()
            if not account or hashlib.sha256((account[0] + account[1]).encode()).digest() != expected_stamp:
                raise ValueError('계정이 바뀌었습니다. 코드를 다시 받아 주세요')
        conn.execute('INSERT INTO slack_link VALUES(?,?,?,?,?,datetime(\'now\')) '
                     'ON CONFLICT(account_email) DO UPDATE SET slack_user_id=excluded.slack_user_id,'
                     'slack_team_id=excluded.slack_team_id,slack_email=excluded.slack_email,'
                     'slack_name=excluded.slack_name,linked_at=excluded.linked_at',
                     (norm_email(email), user_id, team_id, slack_email, name))


def delete_link(email):
    with get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('DELETE FROM slack_link WHERE account_email=?', (norm_email(email),))
        conn.execute("UPDATE slack_dm_outbox SET state='closed',closed_at=?,close_reason='unlinked' "
                     "WHERE recipient_email=? AND state IN ('pending','auth_wait')", (time.time(), norm_email(email)))
