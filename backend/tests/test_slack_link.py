import hashlib

import pytest

from app import repo
from app.services import slack_client as client, slack_link as links
from test_slack_notifications import world  # noqa: F401


@pytest.fixture
def linked_world(world, monkeypatch):
    links._pending.clear(); links._generations.clear(); links._requests.clear(); links._last_start.clear()
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


def _lookup(monkeypatch, failures):
    """users.lookupByEmail raises the queued codes first, then finds the person."""
    lookups = []
    def api(method, *a, **k):
        lookups.append(method)
        if failures:
            raise client.SlackError(failures.pop(0))
        return {'ok': True, 'user': {'id': 'UUNIT', 'name': 'unit'}}
    monkeypatch.setattr(client, '_slack_api', api)
    return lookups


@pytest.mark.parametrize('code', ['users_not_found', 'user_not_found', 'invalid_email'])
def test_wrong_slack_email_says_so_and_can_be_fixed_at_once(linked_world, monkeypatch, code):
    _lookup(monkeypatch, [code])
    with pytest.raises(links.LinkError, match='못 찾았어요'):
        links.start('owner@unit.test', 'typo@slack.test')
    assert links.start('owner@unit.test', 'right@slack.test') == {'ok': True}  # no 1-minute wait


def test_wrong_emails_still_count_toward_the_hourly_cap(linked_world, monkeypatch):
    lookups = _lookup(monkeypatch, ['users_not_found'] * 20)
    for _ in range(10):
        with pytest.raises(links.LinkError, match='못 찾았어요'):
            links.start('owner@unit.test', 'typo@slack.test')
    with pytest.raises(links.LinkError, match='잠시 기다린'):
        links.start('owner@unit.test', 'typo@slack.test')
    assert len(lookups) == 10  # the 11th was refused before calling Slack
    links._requests['owner@unit.test'] = [t - 3601 for t in links._requests['owner@unit.test']]  # an hour later
    with pytest.raises(links.LinkError, match='못 찾았어요'):
        links.start('owner@unit.test', 'typo@slack.test')
    assert len(lookups) == 11


@pytest.mark.parametrize('code', ['rate_limited', 'not_connected', 'unknown'])
def test_other_lookup_failures_keep_the_one_minute_gap(linked_world, monkeypatch, code):
    lookups = _lookup(monkeypatch, [code])
    with pytest.raises(client.SlackError):
        links.start('owner@unit.test', 'right@slack.test')
    with pytest.raises(links.LinkError, match='잠시 기다린'):
        links.start('owner@unit.test', 'right@slack.test')
    assert len(lookups) == 1


def test_email_error_frees_only_its_own_gap(linked_world, monkeypatch):
    nested = []
    def api(method, *a, **k):
        try:
            links.start('owner@unit.test', 'again@slack.test')  # overlapping request while the first is in flight
        except links.LinkError as exc:
            nested.append(str(exc))
        raise client.SlackError('users_not_found')
    monkeypatch.setattr(client, '_slack_api', api)
    with pytest.raises(links.LinkError, match='못 찾았어요'):
        links.start('owner@unit.test', 'typo@slack.test')
    assert nested == ['잠시 기다린 뒤 다시 받아 주세요']  # the overlap was refused by the first request's gap
    assert 'owner@unit.test' not in links._last_start  # and the typo freed only that gap
    assert len(links._requests['owner@unit.test']) == 1


def test_a_late_email_error_keeps_the_gap_a_newer_request_holds(linked_world, monkeypatch):
    calls = []
    def api(method, *a, **k):
        calls.append(method)
        if len(calls) == 1:  # request A is still in flight when, a minute later, request B starts
            email = 'owner@unit.test'
            links._last_start[email] -= 61
            links._requests[email] = [t - 61 for t in links._requests[email]]
            assert links.start(email, 'right@slack.test') == {'ok': True}
            raise client.SlackError('users_not_found')  # then A ends with an email error
        return {'ok': True, 'user': {'id': 'UUNIT', 'name': 'unit'}}
    monkeypatch.setattr(client, '_slack_api', api)
    with pytest.raises(links.LinkError, match='못 찾았어요'):
        links.start('owner@unit.test', 'typo@slack.test')
    assert 'owner@unit.test' in links._last_start  # B's gap was not freed by A
    with pytest.raises(links.LinkError, match='잠시 기다린'):
        links.start('owner@unit.test', 'right@slack.test')
    assert links.verify('owner@unit.test', '123456')['linked']  # B's code still works


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
