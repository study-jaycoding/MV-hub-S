"""Slack contract tests: disposable databases and fake HTTP only."""
import contextlib
import json
import math
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import db, manage_db, repo, schema_compat
from app.emailnorm import norm_email
from app.repo import slack_notifications as store
from app.services import slack_client as client, slack_notify as worker
from app.services.db_scrub import scrub_slack
from test_trash_transfer import enabled_db  # noqa: F401


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv('CONTENT_HUB_DB', str(tmp_path / 'content_hub.db'))
    monkeypatch.setattr(manage_db, 'MANAGE_DB_PATH', tmp_path / 'manage_hub.db')
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.register('admin@unit.test', 'fake-test-password', 'admin')
    for email in ('owner@unit.test', 'author@unit.test', 'parent@unit.test'):
        repo.register(email, 'fake-test-password', email.split('@')[0])
        repo.set_account_status(email, 'approved')
    accounts = {name: repo.get_account(name + '@unit.test') for name in ('owner', 'author', 'parent')}
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,job_id,worker_id,prompt,status,creator_uid) VALUES('g','g','me','example','done',?)",
                     (accounts['owner']['creator_uid'],))
    store.save_link('owner@unit.test', 'UOWNER', 'TUNIT', 'owner', 'owner@slack.test')
    config = {'state': 'ok', 'token': 'fake-token', 'revision': 1, 'team_id': 'TUNIT',
              'enabled': True, 'paused': False, 'open_base_url': 'http://127.0.0.1:8010'}
    monkeypatch.setattr(client, 'read_config', lambda: dict(config))
    monkeypatch.setattr(worker, '_send_pause_until', 0.0)  # a 429 in one test must not silence the next
    store.reset_floor(time.time() - 60)
    yield accounts, config, tmp_path
    db.flush_pool()


def comment(world, text='hello', parent=None, private=False):
    return repo.add_generation_comment('g', world[0]['author']['creator_uid'], text, parent, is_private=private)


def rows():
    with db.get_connection() as conn:
        return [dict(r) for r in conn.execute('SELECT * FROM slack_dm_outbox ORDER BY id')]


def candidates(team='TUNIT'):
    now = time.time()
    return store.window_candidates(now - 1700, now + 120, team)


def emails_for(cid):
    return sorted(e for c, e in candidates() if c == cid)


def cycle(monkeypatch):
    monkeypatch.setattr(client, 'send_dm', lambda *a, **kw: None)
    worker.run_cycle()
    return {(r['comment_id'], r['recipient_email']) for r in rows()}


def test_named_baselines_unchanged_and_migration_idempotent(world):
    with db.get_connection() as conn:
        before = schema_compat.inspect_schema(conn, 'content').components
        from app.db_slack import migrate
        migrate(conn)
        after = schema_compat.inspect_schema(conn, 'content').components
        assert before == after
        assert not any('slack' in value for value in before)


def test_recipient_private_self_deleted_and_blocked(world):
    cid = comment(world)
    assert emails_for(cid) == ['owner@unit.test']
    assert store.delivery_target(cid, 'owner@unit.test')
    assert store.delivery_target(comment(world, private=True), 'owner@unit.test') is None
    mine = repo.add_generation_comment('g', world[0]['owner']['creator_uid'], 'mine')
    assert store.delivery_target(mine, 'owner@unit.test') is None
    repo.set_account_status('owner@unit.test', 'rejected')
    assert store.delivery_target(cid, 'owner@unit.test') is None
    repo.set_account_status('owner@unit.test', 'approved')
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET deleted_at=datetime('now') WHERE id='g'")
    assert store.delivery_target(cid, 'owner@unit.test') is None


def test_parent_requires_current_visibility(world):
    parent_uid = world[0]['parent']['creator_uid']
    parent = repo.add_generation_comment('g', parent_uid, 'question')
    store.save_link('parent@unit.test', 'UPARENT', 'TUNIT', 'parent', 'parent@slack.test')
    cid = comment(world, parent=parent)
    assert store.delivery_target(cid, 'parent@unit.test') is None
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name,kind) VALUES('p','Project','team')")
        conn.execute("UPDATE generation SET project_id='p' WHERE id='g'")
        conn.execute("INSERT INTO share(generation_id,shared_by) VALUES('g','me')")
        conn.execute("INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('p',?,'creator')", (parent_uid,))
    assert store.delivery_target(cid, 'parent@unit.test')
    with db.get_connection() as conn:
        conn.execute('DELETE FROM project_member WHERE creator_uid=?', (parent_uid,))
    assert store.delivery_target(cid, 'parent@unit.test') is None


def test_600_comments_mixed_dates_no_duplicate_sends(world, monkeypatch):
    uid = world[0]['author']['creator_uid']
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO generation_comment(id,gen_id,author,text,created_at) VALUES(?,'g',?,'hello',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                         [(f'c{i:04}', uid) for i in range(600)])
        conn.execute("INSERT INTO generation_comment(id,gen_id,author,text,created_at) VALUES('old','g',?,'old','2020-01-01T01:00:00Z')", (uid,))
    sent = []
    monkeypatch.setattr(client, 'send_dm', lambda config, user, text, **kw: sent.append(user))
    # Each cycle delivers at most 100 rows or 5 seconds; a busy PC needs more cycles (11-06 gate: 591/600 after 7).
    for _ in range(60):
        worker.run_cycle()
        if rows() and all(r['state'] == 'sent' for r in rows()):
            break
    assert len(rows()) == 600
    assert len(sent) == 600
    assert all(r['state'] == 'sent' for r in rows())


@pytest.mark.parametrize('error,state', [('unknown', 'closed'), ('not_connected', 'pending'), ('rate_limited', 'pending'), ('invalid_auth', 'auth_wait'), ('channel_not_found', 'closed')])
def test_delivery_outcomes(world, monkeypatch, error, state):
    comment(world)
    def fail(*args, **kwargs):
        raise client.SlackError(error, 17)
    monkeypatch.setattr(client, 'send_dm', fail)
    monkeypatch.setattr(client, 'set_paused', lambda *a, **kw: None)
    worker.run_cycle()
    row = rows()[0]
    assert row['state'] == state
    assert bool(row['send_started_at']) == (state == 'closed')
    if error == 'rate_limited':
        assert row['next_retry_at'] > time.time() + 15


def test_started_lease_never_reclaimed_and_recovers_unknown(world):
    cid = comment(world)
    with db.get_connection() as conn:
        gen = store.generation(conn)
    store.enqueue(cid, store.delivery_target(cid, 'owner@unit.test'), gen, time.time())
    first = store.claim(time.time(), 'TUNIT', 1)
    assert store.begin_send(first, time.time(), 1)
    assert store.claim(time.time() + 61, 'TUNIT', 1) is None
    assert rows()[0]['close_reason'] == 'unknown'
    assert not store.begin_send(first, time.time() + 62, 1)


def test_lease_claim_has_only_one_winner(world):
    cid = comment(world)
    with db.get_connection() as conn:
        gen = store.generation(conn)
    store.enqueue(cid, store.delivery_target(cid, 'owner@unit.test'), gen, time.time())
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: store.claim(time.time(), 'TUNIT', 1), range(2)))
    assert sum(c is not None for c in claims) == 1


def test_auth_wait_resumes_new_revision_but_expires(world):
    cid = comment(world)
    with db.get_connection() as conn:
        gen = store.generation(conn)
    store.enqueue(cid, store.delivery_target(cid, 'owner@unit.test'), gen, time.time())
    first = store.claim(time.time(), 'TUNIT', 1)
    store.begin_send(first, time.time(), 1)
    store.settle(first, 'auth_wait', 'invalid_auth', revision=1)
    assert store.claim(time.time(), 'TUNIT', 1) is None
    assert store.claim(time.time(), 'TUNIT', 2)
    assert store.claim(time.time() + 901, 'TUNIT', 2) is None
    assert rows()[0]['close_reason'] == 'stale'


def test_db_generation_change_closes_old_rows(world):
    cid = comment(world)
    with db.get_connection() as conn:
        gen = store.generation(conn)
    store.enqueue(cid, store.delivery_target(cid, 'owner@unit.test'), gen, time.time())
    with db.get_connection() as conn:
        conn.execute("UPDATE app_setting SET value='new-generation' WHERE key='share_db_generation'")
    store.scan_context(time.time())
    assert rows()[0]['close_reason'] == 'db_changed'


def test_unlink_closes_pending(world):
    cid = comment(world)
    with db.get_connection() as conn:
        gen = store.generation(conn)
    store.enqueue(cid, store.delivery_target(cid, 'owner@unit.test'), gen, time.time())
    store.delete_link('owner@unit.test')
    assert rows()[0]['close_reason'] == 'unlinked'


def test_text_escapes_names_and_content(world):
    target = store.delivery_target(comment(world, '<!channel> & text'), 'owner@unit.test')
    target['author_name'] = '<name>'
    text, blocks = worker.message(target)
    assert '<!channel>' not in text and '&lt;!channel&gt;' in text
    assert '&lt;name&gt;' in text and '&amp;' in text
    assert not any(block['type'] == 'image' for block in blocks)


def test_native_generation_url_uses_comment_generation_id(world):
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id='different-job' WHERE id='g'")
    target = store.delivery_target(comment(world), 'owner@unit.test')
    _, blocks = worker.message(target)
    assert f"<mvhub://open/g?c={target['id']}|MV hub에서 보기 →>" in blocks[0]['text']['text']
    assert 'job_id' not in target


def test_message_uses_text_link_not_button_and_skips_empty_project(world):
    target = store.delivery_target(comment(world, 'hello'), 'owner@unit.test')
    target['project_name'], target['author_name'] = '', 'author'
    text, blocks = worker.message(target)
    assert [block['type'] for block in blocks] == ['section']  # actions 단추는 Slack 에 ⚠ 를 붙인다
    assert text.split('\n')[1] == 'author'
    target['project_name'] = 'proj'
    assert worker.message(target)[0].split('\n')[1] == 'proj · author'


def test_queued_comment_skips_target_and_name_resolution(world, monkeypatch):
    comment(world)
    monkeypatch.setattr(client, 'send_dm', lambda *a, **kw: None)
    worker.run_cycle()
    assert rows()[0]['state'] == 'sent'
    def unexpected(*args):
        pytest.fail('already queued comment must not resolve delivery target again')
    monkeypatch.setattr(store, 'delivery_target', unexpected)
    worker.run_cycle()
    assert len(rows()) == 1


def _comment_at(world, cid, epoch):
    with db.get_connection() as conn:  # the app's own format: whole seconds, 'YYYY-MM-DD HH:MM:SS'
        conn.execute("INSERT INTO generation_comment(id,gen_id,author,text,created_at) VALUES(?,'g',?,'x',datetime(?,'unixepoch'))",
                     (cid, world[0]['author']['creator_uid'], epoch))


def test_floor_inside_a_second_keeps_that_seconds_comment_for_1000_seconds(world):
    base = int(time.time()) - 2000
    for k in range(1000):
        _comment_at(world, f's{k:04}', base + k)
    for k in range(1000):
        # resume at .800 of the second the comment was stored in; the next second's comment is past the upper bound
        assert [c for c, _ in store.window_candidates(base + k + 0.8, base + k + 0.9, 'TUNIT')] == [f's{k:04}'], k


def test_resume_then_same_second_comment_is_delivered_once_and_older_second_is_not(world, monkeypatch):
    now = int(time.time()) - 5
    store.reset_floor(now + 0.8)
    _comment_at(world, 'same', now)
    _comment_at(world, 'older', now - 2)
    monkeypatch.setattr(client, 'send_dm', lambda *a, **kw: None)
    worker.run_cycle()
    worker.run_cycle()
    assert [r['comment_id'] for r in rows()] == ['same']


def test_rate_limit_pauses_the_whole_deliverer_until_retry_after(world, monkeypatch):
    for i in range(3):
        comment(world, f'c{i}')
    calls = []
    def send(config, user, text, **kw):
        calls.append(text)
        if len(calls) == 1:
            raise client.SlackError('rate_limited', 30)
    monkeypatch.setattr(client, 'send_dm', send)
    worker.run_cycle()
    assert len(calls) == 1 and worker._send_pause_until > time.monotonic() + 25
    worker.run_cycle()  # next cycle / a kick inside Retry-After
    comment(world, 'during')  # queueing goes on while paused
    worker.run_cycle()
    assert len(calls) == 1 and len(rows()) == 4
    assert rows()[0]['state'] == 'pending' and rows()[0]['next_retry_at'] > time.time() + 25
    monkeypatch.setattr(worker, '_send_pause_until', time.monotonic() - 1)  # Retry-After over
    worker.run_cycle()
    assert len(calls) == 4  # the other three go; the 429 row keeps its own retry time
    assert [r['state'] for r in rows()] == ['pending', 'sent', 'sent', 'sent']
    with db.get_connection() as conn:  # that row's own retry time passes too
        conn.execute("UPDATE slack_dm_outbox SET next_retry_at=? WHERE state='pending'", (time.time() - 1,))
    worker.run_cycle()
    worker.run_cycle()
    assert len(calls) == 5 and calls.count(calls[0]) == 2  # the 429 row is delivered exactly once more
    assert [r['state'] for r in rows()] == ['sent'] * 4


def test_generation_cleanup_closes_only_unfinished_rows(world):
    with db.get_connection() as conn:
        for i, state in enumerate(('pending', 'auth_wait', 'sending', 'sent', 'closed')):
            conn.execute("INSERT INTO slack_dm_outbox(comment_id,recipient_email,kind,created_at,db_generation,state,close_reason,slack_team_id) "
                         "VALUES(?, 'owner@unit.test', 'comment', 1, 'old-generation', ?, ?, 'TUNIT')",
                         (f'x{i}', state, 'kept' if state == 'closed' else None))
    store.scan_context(time.time())
    assert [(r['state'], r['close_reason']) for r in rows()] == [
        ('closed', 'db_changed'), ('closed', 'db_changed'), ('closed', 'db_changed'), ('sent', None), ('closed', 'kept')]


def test_recipients_are_linked_unambiguous_accounts_only(world):
    parent_uid = world[0]['parent']['creator_uid']
    parent = repo.add_generation_comment('g', parent_uid, 'question')
    reply = comment(world, parent=parent)
    assert emails_for(reply) == ['owner@unit.test']  # parent is not linked: not a candidate
    store.save_link('PARENT@unit.test ', 'UPARENT', 'TUNIT', 'parent', 'parent@slack.test')
    assert emails_for(reply) == ['owner@unit.test', 'parent@unit.test']
    with db.get_connection() as conn:  # a plain (non acct:) owner uid resolves through the account table
        conn.execute("UPDATE account SET creator_uid='u-shared' WHERE email='owner@unit.test'")
        conn.execute("UPDATE generation SET creator_uid='u-shared' WHERE id='g'")
    assert emails_for(reply) == ['owner@unit.test', 'parent@unit.test']
    with db.get_connection() as conn:  # a second approved account on that uid: ambiguous, so out even though linked
        conn.execute("UPDATE account SET creator_uid='u-shared' WHERE email='author@unit.test'")
    assert emails_for(reply) == ['parent@unit.test']


def _reference_pairs(team):
    """The pre-11-07 collection path (a recipient lookup per comment), kept as the oracle for window_candidates."""
    now = time.time()
    with db.get_connection() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM generation_comment WHERE is_private=0 AND julianday(created_at) "
            "BETWEEN julianday(?,'unixepoch') AND julianday(?,'unixepoch') ORDER BY julianday(created_at),id",
            (math.floor(now - 1700), now + 120))]
    pairs = []
    for cid in ids:
        with db.get_connection() as conn:
            row = conn.execute('SELECT g.creator_uid,p.author FROM generation_comment c JOIN generation g ON g.id=c.gen_id '
                               'LEFT JOIN generation_comment p ON p.id=c.parent_id WHERE c.id=?', (cid,)).fetchone()
            emails = set()
            for uid in set(row or ()):
                if not uid or uid == 'me':
                    continue
                if uid.startswith('acct:'):
                    found = conn.execute("SELECT email FROM account WHERE email=? AND status='approved'",
                                         (norm_email(uid[5:]),)).fetchall()
                else:
                    found = conn.execute("SELECT email FROM account WHERE creator_uid=? AND status='approved'", (uid,)).fetchall()
                if len(found) == 1:
                    emails.add(found[0][0])
            emails = {e for e in emails if conn.execute('SELECT 1 FROM slack_link WHERE account_email=?', (norm_email(e),)).fetchone()}
            emails -= {r[0] for r in conn.execute('SELECT recipient_email FROM slack_dm_outbox WHERE comment_id=?', (cid,))}
        for email in sorted(emails):
            target = store.delivery_target(cid, email)
            if target and target['slack_team_id'] == team:
                pairs.append((cid, email))
    return pairs


def test_window_candidates_queue_exactly_what_the_old_per_comment_path_queued(world):
    def account(name, uid):
        email = name + '@unit.test'
        repo.register(email, 'fake-test-password', name)
        repo.set_account_status(email, 'approved')
        with db.get_connection() as conn:
            conn.execute('UPDATE account SET creator_uid=? WHERE email=?', (uid, email))
        return email
    blank = account('blank', '')  # empty creator_uid: judged as acct:<email>
    keyed = account('keyed', 'uid-keyed')  # reached through acct:, judged by its own creator_uid
    dup = account('dup1', 'u-dup')
    account('dup2', 'u-dup')  # second approved account on that uid: ambiguous
    other = account('other', 'uid-other')
    for email, team in ((blank, 'TUNIT'), (keyed, 'TUNIT'), (dup, 'TUNIT'), (other, 'TOTHER')):
        store.save_link(email, 'U' + email.split('@')[0], team, email, email)
    store.save_link('parent@unit.test', 'UPARENT', 'TUNIT', 'parent', 'parent@slack.test')
    owner_uid, author_uid, parent_uid = (world[0][n]['creator_uid'] for n in ('owner', 'author', 'parent'))
    gens = {'gb': 'acct:' + blank, 'gk': 'acct:' + keyed, 'gd': 'u-dup', 'go': 'uid-other', 'gm': 'me', 'gt': owner_uid}
    with db.get_connection() as conn:
        for gid, creator in gens.items():
            conn.execute("INSERT INTO generation(id,job_id,worker_id,prompt,status,creator_uid) VALUES(?,?,'me','x','done',?)",
                         (gid, gid, creator))
        conn.execute("UPDATE generation SET deleted_at=datetime('now') WHERE id='gt'")  # trashed: dynamic rejection
        conn.execute("UPDATE account SET global_role='admin' WHERE email='owner@unit.test'")  # reads all, still not self
    question = repo.add_generation_comment('g', parent_uid, 'question')
    for gid in [*gens, 'g']:
        repo.add_generation_comment(gid, author_uid, 'hello')
        repo.add_generation_comment(gid, author_uid, 'secret', is_private=True)
    comment(world, 'reply', parent=question)
    repo.add_generation_comment('g', owner_uid, 'mine')
    with db.get_connection() as conn:  # its generation has not arrived yet
        conn.execute("INSERT INTO generation_comment(id,gen_id,author,text) VALUES('early','g-late',?,'x')", (author_uid,))
    sent = comment(world, 'already sent')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO slack_dm_outbox(comment_id,recipient_email,kind,created_at,db_generation,state,slack_team_id) "
                     "VALUES(?,'owner@unit.test','comment',?,?,'sent','TUNIT')", (sent, time.time(), store.generation(conn)))
    for team in ('TUNIT', 'TOTHER'):
        new = [(c, e) for c, e in candidates(team) if (t := store.delivery_target(c, e)) and t['slack_team_id'] == team]
        assert new == _reference_pairs(team), team
    assert {e for _, e in _reference_pairs('TUNIT')} >= {blank, 'owner@unit.test'}  # not a vacuous comparison
    assert _reference_pairs('TOTHER') and (sent, 'owner@unit.test') not in candidates()


def test_window_reads_one_snapshot_regardless_of_comment_count(world, monkeypatch):
    opened = []
    real = store.get_connection
    monkeypatch.setattr(store, 'get_connection', lambda *a: opened.append(1) or real(*a))
    for count in (10, 300):
        with db.get_connection() as conn:
            conn.executemany("INSERT INTO generation_comment(id,gen_id,author,text) VALUES(?,'g',?,'x')",
                             [(f'n{count}-{i}', world[0]['author']['creator_uid']) for i in range(count)])
        opened.clear()
        assert len(candidates()) >= count
        assert len(opened) == 1  # not one recipient lookup per comment


def test_window_snapshot_is_four_selects_closed_before_anything_is_judged(world, monkeypatch):
    # Production pools one connection per thread (tests turn it off): an unclosed snapshot would leak into
    # the next caller on this thread, so check with the pool on.
    db.flush_pool()
    monkeypatch.setattr(db, '_POOL_ENABLED', True)
    comment(world)
    statements = []
    real = store.get_connection

    @contextlib.contextmanager
    def traced(*a):
        with real(*a) as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)
    monkeypatch.setattr(store, 'get_connection', traced)
    assert candidates()
    monkeypatch.setattr(store, 'get_connection', real)
    assert statements[0].strip().upper() == 'BEGIN'
    assert [s.lstrip().upper().startswith('SELECT') for s in statements[1:]] == [True] * 4
    with db.get_connection() as conn:  # the snapshot ended with the function (the pool reuses this connection)
        assert not conn.in_transaction
    judged = []

    def judge(*args):
        with db.get_connection() as conn:
            judged.append(conn.in_transaction)
        return None
    monkeypatch.setattr(store, 'delivery_target', judge)
    worker.run_cycle()
    assert judged == [False]
    db.flush_pool()


def test_queued_and_self_comments_are_never_judged_while_collecting(world, monkeypatch):
    owner_uid, author_uid = world[0]['owner']['creator_uid'], world[0]['author']['creator_uid']
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO generation_comment(id,gen_id,author,text) VALUES(?,'g',?,'x')",
                         [(f'q{i}', author_uid) for i in range(200)] + [(f'm{i}', owner_uid) for i in range(200)])
        gen = store.generation(conn)
        conn.executemany("INSERT INTO slack_dm_outbox(comment_id,recipient_email,kind,created_at,db_generation,state,slack_team_id) "
                         "VALUES(?,'owner@unit.test','comment',?,?,?,'TUNIT')",
                         [(f'q{i}', time.time(), gen, ('sent', 'closed', 'pending')[i % 3]) for i in range(200)])
    monkeypatch.setattr(store, 'delivery_target', lambda *a: pytest.fail('nothing should be judged while collecting'))
    monkeypatch.setattr(store, 'claim', lambda *a: None)  # the delivery stage re-judges queued rows; not this test
    assert candidates() == []
    worker.run_cycle()


def test_link_team_mismatch_is_not_a_candidate(world):
    cid = comment(world)
    assert emails_for(cid) == ['owner@unit.test']
    assert candidates('TOTHER') == []


def test_late_generation_late_import_new_link_and_regained_visibility_land_next_cycle(world, monkeypatch):
    author_uid, parent_uid = world[0]['author']['creator_uid'], world[0]['parent']['creator_uid']
    with db.get_connection() as conn:  # a comment whose generation has not arrived yet
        conn.execute("INSERT INTO generation_comment(id,gen_id,author,text) VALUES('early','g3',?,'x')", (author_uid,))
    assert ('early', 'owner@unit.test') not in cycle(monkeypatch)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,job_id,worker_id,prompt,status,creator_uid) VALUES('g3','g3','me','x','done',?)",
                     (world[0]['owner']['creator_uid'],))
    assert ('early', 'owner@unit.test') in cycle(monkeypatch)
    # imported after the cycles above but stamped before them (still after the 60-second floor of `world`)
    _comment_at(world, 'late-import', int(time.time()) - 30)
    assert ('late-import', 'owner@unit.test') in cycle(monkeypatch)
    question = repo.add_generation_comment('g', parent_uid, 'question')
    reply = comment(world, parent=question)
    assert (reply, 'parent@unit.test') not in cycle(monkeypatch)  # parent not linked yet
    store.save_link('parent@unit.test', 'UPARENT', 'TUNIT', 'parent', 'parent@slack.test')
    assert (reply, 'parent@unit.test') not in cycle(monkeypatch)  # linked, but cannot see the generation
    with db.get_connection() as conn:
        conn.execute("INSERT INTO project(id,name,kind) VALUES('p','Project','team')")
        conn.execute("UPDATE generation SET project_id='p' WHERE id='g'")
        conn.execute("INSERT INTO share(generation_id,shared_by) VALUES('g','me')")
        conn.execute("INSERT INTO project_member(project_id,creator_uid,project_role) VALUES('p',?,'creator')", (parent_uid,))
    assert (reply, 'parent@unit.test') in cycle(monkeypatch)


def test_snapshot_scrub_is_strict_and_verified(world):
    path = world[2] / 'content_hub.db'
    repo.set_setting(client.SETTING_KEY, json.dumps({'data': 'fake-encrypted'}))
    scrub_slack(path)
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM slack_link').fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM app_setting WHERE key LIKE 'slack_%'").fetchone()[0] == 0
        conn.execute("INSERT INTO slack_link VALUES('x','u','t','','','now')")
        conn.execute("CREATE TRIGGER prevent_slack_scrub BEFORE DELETE ON slack_link BEGIN SELECT RAISE(ABORT,'stop'); END")
    with pytest.raises(sqlite3.DatabaseError):
        scrub_slack(path)


def test_snapshot_scrub_accepts_old_database(tmp_path):
    path = tmp_path / 'old.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE old_table(x)')
    scrub_slack(path)


@pytest.mark.parametrize('profile', ['transfer', 'snapshot', 'install'])
@pytest.mark.parametrize('reject_delete', [False, True])
def test_slack_scrub_uses_guarded_connection_and_propagates_failure(enabled_db, profile, reject_delete):
    from app.services.db_scrub import strip_transfer_secrets, scrub_test_snapshot_db
    from app.routers.db_transfer import _post_install_security_init
    with db.get_connection() as conn:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('slack_bot_config','synthetic')")
        conn.execute("INSERT INTO slack_link VALUES('unit@example.test','UUNIT','TUNIT','','','now')")
        conn.execute("INSERT INTO slack_dm_outbox(comment_id,recipient_email,kind,created_at,db_generation,slack_team_id) "
                     "VALUES('c','unit@example.test','comment',1,'test','TUNIT')")
        if reject_delete:
            conn.execute("CREATE TRIGGER reject_slack_delete BEFORE DELETE ON slack_dm_outbox BEGIN SELECT RAISE(ABORT,'stop'); END")
    with sqlite3.connect(enabled_db) as raw:
        with pytest.raises(sqlite3.OperationalError, match='mvhub_write_protocol'):
            raw.execute('DELETE FROM slack_link')
    scrub = {'transfer': strip_transfer_secrets, 'snapshot': lambda path: scrub_test_snapshot_db(path, create_test_admin=False),
             'install': _post_install_security_init}[profile]
    if reject_delete:
        with pytest.raises(sqlite3.DatabaseError):
            scrub(enabled_db)
    else:
        scrub(enabled_db)
    with db.get_connection() as conn:
        for table in ('slack_link', 'slack_dm_outbox'):
            assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == int(reject_delete)
        assert conn.execute("SELECT COUNT(*) FROM app_setting WHERE key LIKE 'slack_%'").fetchone()[0] == int(reject_delete)


def test_test_gate_rejects_wrong_recipient_without_http(monkeypatch, block_live_slack):
    monkeypatch.setenv('CONTENT_HUB_SLACK_TEST_SEND', '1')
    monkeypatch.setenv('CONTENT_HUB_SLACK_TEST_RECIPIENTS', 'UALLOWED')
    with pytest.raises(client.SlackError, match='test_send_blocked'):
        block_live_slack('conversations.open', 'fake', {'users': 'UOTHER'}, recipient_id='UOTHER')


def test_live_gate_disabled_in_local_mode(monkeypatch, block_live_slack):
    monkeypatch.setattr(client.shared_connection, 'is_shared_team_server', lambda: False)
    with pytest.raises(client.SlackError, match='send_disabled'):
        block_live_slack('auth.test', 'fake', {})
