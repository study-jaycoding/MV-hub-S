import json
import time

from app import db, repo
from app.repo import hf_balance as balance
from app.repo import manage_credit_plan as plan, workspace_console as console
from app.repo.manage_member_table import member_table
from hf_org_usage_fake import world
from hf_balance_fixtures import observation, EMAIL


def seed():
    at = int(time.time() * 1000)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO account(email,password_hash,status,creator_uid) VALUES(?,'h','approved','uid-a')", (EMAIL,))
        conn.execute("INSERT INTO workspace_registry(id,name,credits) VALUES('ws','MILLIONVOLT',1)")
        conn.execute("INSERT INTO workspace_member(workspace_id,account_email,creator_uid,is_available,last_seen_at) VALUES('ws',?,'uid-a',1,'2020-01-01 00:00:00')", (EMAIL,))
        value = observation(12345, when=at)
        balance.store(conn, EMAIL, 'uid-a', 1, [value], received_at_ms=at)
        conn.execute('INSERT INTO app_setting(key,value) VALUES(?,?)', ('hf_status:'+EMAIL, json.dumps(dict(credits=7, workspaces=[dict(id='ws', name='Space', credits=1)]))))
    return value


def test_all_consumers_share_observation_id_amount_and_time(world, monkeypatch):
    value = seed()
    pool = plan.plan_view('ws')['pool']
    overview = console.overview()
    table = member_table('ws', with_credit=True)
    options = repo.list_workspace_options()
    summary = repo.credit_summary()
    from app.routers import ingest
    from types import SimpleNamespace
    monkeypatch.setattr(ingest, '_agent_acc', lambda _: dict(email=EMAIL))
    monkeypatch.setattr(ingest._proxy, 'proxying', lambda: False)
    account = ingest.my_hf_status(SimpleNamespace())
    metas = [pool['balance_meta'], overview['main']['balance_meta'], table['main_balance']['balance_meta'],
             options[0]['balance_meta'], account['workspaces'][0]['balance_meta']]
    assert {m['observation_id'] for m in metas} == {value['observation_id']}
    assert {m['credits_c'] for m in metas} == {12345}
    assert {m['observed_at_ms'] for m in metas} == {value['observed_at_ms']}
    assert table['rows'][0]['last_seen_at'] == '2020-01-01 00:00:00'
    assert account['credits'] == 7
    assert summary['total'] == 123.45 and summary['known_subtotal_c'] == 12345
    assert 'workspace_balances' not in summary


def test_unknown_subtotals_invalidate_dependent_totals(world):
    seed()
    console.overview()
    with db.get_connection() as conn:
        conn.executemany('INSERT INTO workspace_registry(id,name,credits) VALUES(?,?,?)', [('unknown','Unknown',None),('zero','Zero',0)])
        conn.executemany("INSERT INTO workspace_console(workspace_id,tier) VALUES(?,'sub')", [('unknown',),('zero',)])
    result = console.overview()
    assert result['totals']['known_subtotal_c'] == 0
    assert result['totals']['unknown_workspace_count'] == 1
    assert result['totals']['legacy_workspace_count'] == 1
    assert not result['totals']['complete'] and not result['totals']['fresh']
    assert result['allocation']['allocated'] is None and result['allocation']['spent'] is None


def test_snapshot_legacy_conflict_stale_and_no_writes(world):
    value = seed()
    with db.get_connection() as conn:
        other = observation(999, when=value['observed_at_ms'], seq=2)
        balance.store(conn, EMAIL, None, 1, [other])
        conn.execute("INSERT INTO workspace_registry(id,name,credits) VALUES('legacy','Legacy',0)")
        before = conn.total_changes
        views = balance.balance_snapshot(conn, ['ws','legacy','missing'], value['observed_at_ms']+1800000)
        assert conn.total_changes == before
        assert views['ws']['basis'] == 'conflict' and views['ws']['credits'] is None
        assert views['legacy']['credits'] == 0 and views['legacy']['observed_at_ms'] is None
        assert views['missing']['basis'] == 'unavailable'
        assert not any(k in json.dumps(views) for k in ('reporter', 'collector', EMAIL))


def test_membership_refresh_is_independent_of_balance_order(world):
    value=seed()
    repo.record_account_status(EMAIL,dict(workspaces=[dict(id='ws',name='Renamed',plan_type='enterprise',credits=1,is_selected=True)]))
    with db.get_connection() as conn:
        row=conn.execute("SELECT w.name,w.plan_type,m.is_available,m.is_selected,m.last_seen_at FROM workspace_registry w JOIN workspace_member m ON w.id=m.workspace_id WHERE w.id='ws'").fetchone()
        assert tuple(row)[:4]==('Renamed','enterprise',1,1)
        assert row['last_seen_at']!='2020-01-01 00:00:00'
        view=balance.balance_snapshot(conn,['ws'],value['observed_at_ms']+900001)['ws']
        assert view['observation_id']==value['observation_id'] and view['credits_c']==12345 and view['stale']


def test_account_menu_uses_current_membership_and_keeps_personal_raw(world):
    seed()
    from app.usecases.hf_balance import account_workspaces
    personal=dict(id='personal',name='',credits=7)
    reported=[personal,dict(id='revoked',name='Revoked',credits=99),dict(id='ws',name='Space',credits=1)]
    current=account_workspaces(EMAIL,reported)
    assert [w['id'] for w in current]==['personal','ws'] and current[0]==personal
    assert current[1]['credits']==123.45
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_member SET is_available=0 WHERE workspace_id='ws'")
    assert account_workspaces(EMAIL,[personal,dict(id='ws',name='Space',credits=999)])==[personal]


def test_credit_summary_counts_pools_once_and_marks_unknown_solo(world):
    seed()
    with db.get_connection() as conn:
        conn.executemany('INSERT INTO app_setting(key,value) VALUES(?,?)',[
            ('hf_status:other@example.test',json.dumps(dict(credits=999,workspaces=[dict(id='ws',credits=999),dict(id='missing',credits=999)]))),
            ('hf_status:solo@example.test',json.dumps(dict(credits=None)))])
    result=repo.credit_summary()
    assert result['total']==123.45 and result['unknown_workspace_count']==1
    assert result['solo_unknown_count']==1 and not result['total_complete']
