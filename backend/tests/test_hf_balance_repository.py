import pytest
from app import db, db_hf_balance, repo
from app.repo import hf_balance as balances
from hf_balance_fixtures import balance_db, observation, EMAIL, NOW


def store(items, **kwargs):
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return balances.store(conn, EMAIL, 'acct:'+EMAIL, 1, items, received_at_ms=NOW+10000, **kwargs)


def test_delayed_duplicate_and_conflicting_observations(balance_db):
    recent, old = observation(9000, seq=2), observation(10000, NOW-1000)
    store([recent, old])
    first = store([recent])
    assert first['stored'][0]['received_at_ms'] == NOW+10000
    assert store([{**recent, 'credits_c':8000,'reported_credits':'80'}])['conflicts']
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0] == 2
        assert balances.latest(conn, 'ws')['credits_c'] == 9000
        assert conn.execute("SELECT credits,first_credits FROM workspace_balance_daily WHERE workspace_id='ws'").fetchone()[:] == (90,100)


def test_invalid_balance_preserves_last_valid_value(balance_db):
    repo.record_account_status(EMAIL, {'email':EMAIL,'workspaces':[{'id':'ws','name':'Space','credits':50}]})
    for value in (None, True, 'NaN', 'bad'):
        repo.record_account_status(EMAIL, {'email':EMAIL,'workspaces':[{'id':'ws','name':'Space','credits':value}]})
        with db.get_connection() as conn:
            assert conn.execute("SELECT credits FROM workspace_registry WHERE id='ws'").fetchone()[0] == 50


def test_future_reversed_tied_and_legacy_times(balance_db):
    store([observation(8000), observation(100, NOW+900000, seq=2),
           observation(200, NOW-100, seq=3, started_at_ms=NOW)])
    with db.get_connection() as conn:
        assert balances.latest(conn,'ws')['credits_c'] == 8000
        assert {r[0] for r in conn.execute('SELECT time_quality FROM hf_balance_obs')} == {'reported','future','reversed'}
    store([observation(7000, seq=4)])
    with db.get_connection() as conn:
        assert balances.latest(conn,'ws')['basis'] == 'conflict'


def test_replay_does_not_refresh_observation_or_receipt(balance_db):
    item = observation()
    store([item])
    with db.get_connection() as conn:
        before = tuple(conn.execute('SELECT * FROM hf_balance_obs').fetchone())
        conn.execute('BEGIN IMMEDIATE')
        balances.store(conn,EMAIL,None,1,[item],received_at_ms=NOW+999999)
        assert tuple(conn.execute('SELECT * FROM hf_balance_obs').fetchone()) == before


def test_metadata_report_preserves_membership_and_does_not_signal_change(balance_db):
    status={'email':EMAIL, 'workspaces':[{'id':'ws','name':'Space','credits':100}],
            'balance_report':{'version':1,'observations':[observation()]}}
    receipt={}
    assert repo.record_account_status(EMAIL,status,balance_receipt=receipt)
    assert receipt['stored']
    status['balance_report']['observations']=[observation(seq=2,when=NOW+1)]
    assert not repo.record_account_status(EMAIL,status,balance_receipt={})
    store([observation(9000,NOW-5000,seq=3)])
    with db.get_connection() as conn:
        assert conn.execute("SELECT is_available FROM workspace_member WHERE workspace_id='ws' AND account_email=?",(EMAIL,)).fetchone()[0] == 1


def test_latest_lookup_uses_index(balance_db):
    with db.get_connection() as conn:
        plan=conn.execute("EXPLAIN QUERY PLAN SELECT * FROM hf_balance_obs WHERE workspace_id=? AND time_quality='reported' ORDER BY observed_at_ms DESC,observation_id DESC LIMIT 1",('ws',)).fetchall()
        assert 'idx_hf_balance_obs_latest' in str([tuple(r) for r in plan])


def test_additive_schema_is_atomic_and_validated(balance_db):
    with db.get_connection() as conn:
        before=list(map(tuple,conn.execute('SELECT * FROM schema_migrations')))
        conn.execute('BEGIN IMMEDIATE')
        db_hf_balance.migrate(conn)
        assert list(map(tuple,conn.execute('SELECT * FROM schema_migrations'))) == before
        conn.execute('DROP INDEX idx_hf_balance_obs_latest')
        with pytest.raises(RuntimeError,match='schema'):
            db_hf_balance.validate(conn)
        conn.rollback()


def test_clock_reversal_across_collections_does_not_become_latest(balance_db):
    store([observation(seq=10)])
    store([observation(9000,NOW-1000,seq=11)])
    with db.get_connection() as conn:
        assert conn.execute('SELECT time_quality FROM hf_balance_obs WHERE collection_seq=11').fetchone()[0]=='reversed'
        assert balances.latest(conn,'ws')['credits_c']==10000


def test_queue_failure_rolls_back_observation_and_mirror(balance_db):
    with db.get_connection() as conn:
        conn.execute("CREATE TRIGGER fail_balance_queue BEFORE INSERT ON hf_balance_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END")
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        store([observation(5000)],target='https://fixture.invalid')
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==0
        assert conn.execute("SELECT credits FROM workspace_registry WHERE id='ws'").fetchone()[0]==100


def test_valid_rows_are_acked_next_to_rejected_rows(balance_db):
    from app.hf_balance_contract import matching_ack
    good,bad=observation(),observation(seq=2,reported_credits='bad')
    receipt=store([good,bad])
    assert [row['observation_id'] for row in receipt['stored']]==[good['observation_id']]
    assert matching_ack(receipt,[good,bad],'server')==receipt
