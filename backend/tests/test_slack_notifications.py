"""Slack contract tests: disposable databases and fake HTTP only."""
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import db, manage_db, repo, schema_compat
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
    store.reset_floor(time.time() - 60)
    yield accounts, config, tmp_path
    db.flush_pool()


def comment(world, text='hello', parent=None, private=False):
    return repo.add_generation_comment('g', world[0]['author']['creator_uid'], text, parent, is_private=private)


def rows():
    with db.get_connection() as conn:
        return [dict(r) for r in conn.execute('SELECT * FROM slack_dm_outbox ORDER BY id')]


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
    assert store.recipient_emails(cid) == ['owner@unit.test']
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
    for _ in range(7):
        worker.run_cycle()
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
    text, blocks = worker.message(target, 'http://127.0.0.1:8010')
    assert '<!channel>' not in text and '&lt;!channel&gt;' in text
    assert '&lt;name&gt;' in text and '&amp;' in text
    assert not any(block['type'] == 'image' for block in blocks)


def test_native_generation_url_uses_comment_generation_id(world):
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id='different-job' WHERE id='g'")
    target = store.delivery_target(comment(world), 'owner@unit.test')
    _, blocks = worker.message(target, 'http://127.0.0.1:8010')
    assert f"<http://127.0.0.1:8010/api/open/generation/g?c={target['id']}|MV hub에서 보기 →>" in blocks[0]['text']['text']
    assert 'job_id' not in target


def test_message_uses_text_link_not_button_and_skips_empty_project(world):
    target = store.delivery_target(comment(world, 'hello'), 'owner@unit.test')
    target['project_name'], target['author_name'] = '', 'author'
    text, blocks = worker.message(target, 'http://127.0.0.1:8010')
    assert [block['type'] for block in blocks] == ['section']  # actions 단추는 Slack 에 ⚠ 를 붙인다
    assert text.split('\n')[1] == 'author'
    target['project_name'] = 'proj'
    assert worker.message(target, 'http://127.0.0.1:8010')[0].split('\n')[1] == 'proj · author'


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
