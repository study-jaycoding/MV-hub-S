import hashlib

import pytest

from app import repo
from app.services import slack_client as client, slack_link as links
from test_slack_notifications import world  # noqa: F401


@pytest.fixture
def linked_world(world, monkeypatch):
    links._pending.clear(); links._generations.clear(); links._requests.clear()
    monkeypatch.setattr(links.secrets, 'randbelow', lambda _: 123456)
    monkeypatch.setattr(client, '_slack_api', lambda *a, **k: {'ok': True, 'user': {'id': 'UUNIT', 'name': 'unit'}})
    monkeypatch.setattr(client, 'send_dm', lambda *a, **k: {'ok': True})
    repo.slack_notifications.delete_link('owner@unit.test')
    return world


def test_code_links_different_email_and_is_consumed(linked_world):
    links.start('owner@unit.test', 'different@slack.test')
    assert links.verify('owner@unit.test', '123456')['linked']
    assert links.status('owner@unit.test')['slack_email'] == 'different@slack.test'
    with pytest.raises(links.LinkError):
        links.verify('owner@unit.test', '123456')


def test_five_wrong_codes_end_challenge(linked_world):
    links.start('owner@unit.test', 'different@slack.test')
    for _ in range(5):
        with pytest.raises(links.LinkError):
            links.verify('owner@unit.test', '000000')
    assert 'owner@unit.test' not in links._pending


@pytest.mark.parametrize('change', ['revision', 'team_id', 'account', 'unlink'])
def test_pending_invalidated_by_context_change(linked_world, change):
    links.start('owner@unit.test', 'different@slack.test')
    if change in ('revision', 'team_id'):
        linked_world[1][change] = 2 if change == 'revision' else 'OTHER'
    elif change == 'account':
        repo.set_account_status('owner@unit.test', 'rejected')
    else:
        links.unlink('owner@unit.test')
    with pytest.raises(links.LinkError):
        links.verify('owner@unit.test', '123456')
    assert not repo.slack_notifications.link_status('owner@unit.test')


def test_resend_rate_limit_and_no_code_in_response(linked_world):
    answer = links.start('owner@unit.test', 'different@slack.test')
    assert answer == {'ok': True}
    assert links._pending['owner@unit.test']['digest'] == hashlib.sha256(b'123456').digest()
    with pytest.raises(links.LinkError):
        links.start('owner@unit.test', 'different@slack.test')


def test_account_deletion_cleans_link_and_queue(linked_world):
    from app import db
    from app.repo import account_cleanup
    store = repo.slack_notifications
    email = 'parent@unit.test'  # No generation/comment history: eligible for cleanup.
    store.save_link(email, 'UPARENT', 'TUNIT', 'parent', 'parent@slack.test')
    with db.get_connection() as conn:
        generation = store.generation(conn)
    store.enqueue('cleanup-only', {'account_email': email, 'kind': 'comment', 'slack_team_id': 'TUNIT'}, generation, 1)
    repo.set_account_status(email, 'rejected')
    account = repo.get_account(email)
    account_cleanup.delete_cleanup_account(email, status=account['status'], hidden=bool(account['hidden']),
        created_at=account['created_at'], actor_email='admin@unit.test', actor_uid='acct:admin@unit.test')
    assert repo.get_account(email) is None
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM slack_link WHERE account_email=?', (email,)).fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM slack_dm_outbox WHERE recipient_email=?', (email,)).fetchone()[0] == 0
