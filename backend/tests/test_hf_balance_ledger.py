import json
from copy import deepcopy

import pytest

from app import db, manage_db
from app.repo import hf_balance as balance, hf_balance_ledger as ledger
from hf_balance_fixtures import observation, EMAIL
from hf_org_usage_fake import world, configured, row, ORG
from test_hf_org_usage_quota import store_day, START, AT, api_row


def data():
    return dict(config=dict(org_id=ORG, enabled=1, restore_paused=0), workspace_id='ws', workspace_proven=True,
                windows=[dict(id=1, start_ms=START, end_ms=START+ledger.DAY_MS, kind='day', snapshot_version=1,
                              success_complete=1, actual_start_ms=START, actual_end_ms=START+ledger.DAY_MS, succeeded_at_ms=AT)],
                checks=[], rows=[])


def points():
    return [dict(observation_id=str(n), observed_at_ms=START+n*1000, credits_c=c, precision_error_c=0)
            for n,c in ((1,10000),(2,9900))]


def test_kst_boundaries_empty_missing_partial_duplicate_and_mismatch():
    assert ledger.period('2026-11-16','2026-11-17') == (START, START+ledger.DAY_MS)
    sample = data()
    a,b = points()
    assert ledger.interval(sample,a,b,'ws')['residual_c'] == -100
    for patch, reason in ((dict(windows=[]),'missing_day'),
                          (dict(workspace_proven=False),'workspace_unproven'),
                          (dict(checks=[dict(state='mismatch', start_ms=START,end_ms=START+ledger.DAY_MS)]),'daily_mismatch')):
        item = ledger.interval(dict(sample, **patch),a,b,'ws')
        assert item['residual_c'] is None and reason in item['reason_codes']
    sample['windows'][0]['actual_end_ms'] = b['observed_at_ms']-1
    assert ledger.interval(sample,a,b,'ws')['state'] == 'api_pending'
    sample = data()
    sample['windows'].append(dict(sample['windows'][0],id=2,start_ms=START+ledger.DAY_MS,end_ms=START+2*ledger.DAY_MS,
                                  actual_start_ms=START+ledger.DAY_MS,actual_end_ms=START+2*ledger.DAY_MS))
    sample['rows'] = [dict(row('same',workspace_id='ws'),window_id=i) for i in (1,2)]
    assert ledger.coverage(sample,START,START+2*ledger.DAY_MS)[1] == 'duplicate_row'
    sample['windows'].append(dict(sample['windows'][0],kind='exact',id=3))
    assert len(ledger.coverage(sample,START,START+1000)[0]) == 1


def test_interval_refilters_created_at_but_daily_api_does_not(world):
    configured()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws','Space')")
        values = [observation(c,when=START+n*1000,seq=n) for n,c in ((1,10000),(2,9900),(3,9900))]
        for offset in range(0,len(values),100):
            balance.store(conn, EMAIL, None, 1, values[offset:offset+100], received_at_ms=AT)
    store_day(rows=[api_row('inside',created_at=START+1500,credits_c=100,charged_c=100,refunded_c=0),
                    api_row('outside',created_at=START+3000,credits_c=250,charged_c=250,refunded_c=0)])
    answer = ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)
    assert answer['intervals'][0]['residual_c'] == 0
    assert answer['intervals'][0]['state'] == 'numeric_match'
    assert answer['daily_api'][0]['net_c'] == 350
    assert EMAIL not in json.dumps(answer) and 'actor_' not in json.dumps(answer)


def test_late_refund_is_residual_not_topup():
    sample = data()
    a,b = points()
    b['credits_c'] = 10100
    sample['rows'] = [dict(row(created_at=START,workspace_id='ws',refunded_c=100),window_id=1)]
    item = ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[],3)
    assert item['residual_c'] == 100 and item['candidate_classification'] == 'refund_candidate'
    assert item['candidate_evidence'][0]['code'] == 'refund_time_unknown'


def test_ambiguous_allocation_stays_candidate():
    sample=data()
    a,b=points()
    item=ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[],1,[dict(workspace_id='one'),dict(workspace_id='two')])
    assert item['candidate_classification']=='unclassified' and len(item['candidate_evidence'])==2


def test_manual_topup_match_is_not_execution_proof():
    sample=data()
    a,b=points()
    b['credits_c']=10100
    item=ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[dict(id='topup',day='2026-11-16',credits=1)],7)
    assert item['candidate_classification']=='topup_candidate'
    assert item['candidate_evidence'][0]['code']=='current_plan_match'
    assert item['candidate_evidence'][0]['plan_revision']==7


def test_topup_and_usage_simultaneously_keep_residual_separate():
    sample=data()
    a,b=points()
    sample['rows']=[dict(row(created_at=START+1500,workspace_id='ws',credits_c=400,refunded_c=0),window_id=1)]
    item=ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[dict(id='one',day='2026-11-16',credits=1),dict(id='two',day='2026-11-16',credits=2)],3)
    assert item['delta_c']==-100 and item['residual_c']==300
    assert item['candidate_classification']=='topup_candidate'
    assert item['candidate_evidence'][0]['topup_count']==2


def test_http_ledger_limits_and_changed_cursor(world,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import config
    from app.routers import hf_balance as route
    seed(world)
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(route._proxy,'proxying',lambda:False)
    app=FastAPI()
    @app.middleware('http')
    async def authenticated(request,call_next):
        request.state.account=dict(email=EMAIL,status='approved',global_role='admin')
        return await call_next(request)
    app.include_router(route.router)
    with TestClient(app) as client:
        path='/api/manage/console/balance-ledger'
        params=dict(workspace_id='ws',start='2026-11-16',end='2026-11-17',limit=2)
        first=client.get(path,params=params)
        assert first.status_code==200 and first.json()['next_cursor']
        assert client.get(path,params=dict(params,limit=501)).status_code==422
        assert client.get(path,params=dict(params,start='2026-09-01')).status_code==422
        assert client.get(path,params=dict(params,cursor='bad-cursor')).status_code==422
        with manage_db.get_connection() as conn:
            conn.execute('UPDATE hf_org_usage_window SET snapshot_version=2')
        changed=client.get(path,params=dict(params,cursor=first.json()['next_cursor']))
        assert changed.status_code==409 and changed.json()['detail']=='analysis_changed'


def test_null_error_endpoint_marks_interval_uncertain():
    a,b=points()
    a['precision_error_c']=None
    item=ledger.interval(data(),a,b,'ws')
    assert item['tolerance_c'] is None and item['state']=='observation_uncertain'


def seed(world, count=4):
    configured()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_registry(id,name) VALUES('ws','Space')")
        values=[observation(10000-n,when=START+n*1000,seq=n) for n in range(1,count+1)]
        for offset in range(0,len(values),100):
            balance.store(conn, EMAIL, None, 1, values[offset:offset+100], received_at_ms=AT)
    store_day(rows=[api_row(created_at=START+1500)])


def test_cursor_rejects_changed_analysis(world):
    seed(world)
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT)
    assert first['has_more']
    second=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT)
    assert not second['has_more']
    with manage_db.get_connection() as conn:
        conn.execute('UPDATE hf_org_usage_window SET snapshot_version=snapshot_version+1')
    with pytest.raises(ledger.AnalysisChanged):
        ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT)


def test_cursor_ignores_check_timestamp_without_input_change(world):
    seed(world)
    with manage_db.get_connection() as conn:
        conn.execute("INSERT INTO hf_org_usage_check(org_id,start_ms,end_ms,state,daily_versions_json,checked_at_ms) VALUES(?,?,?,'matched','{}',?)",
                     (ORG,START,START+ledger.DAY_MS,AT))
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT)
    with manage_db.get_connection() as conn:
        conn.execute('UPDATE hf_org_usage_check SET checked_at_ms=checked_at_ms+1000')
    later=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1000)
    assert later['basis_signature']==first['basis_signature']


@pytest.mark.parametrize('update', [
    'UPDATE hf_org_usage_window SET row_count=COALESCE(row_count,0)+1',
    'UPDATE hf_org_usage_config SET enabled=0',
    'UPDATE hf_org_usage_config SET revision=revision+1',
])
def test_cursor_rejects_api_row_count_or_config_changes(world,update):
    seed(world)
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT)
    with manage_db.get_connection() as conn:
        conn.execute(update)
    with pytest.raises(ledger.AnalysisChanged):
        ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1)


@pytest.mark.parametrize('payload', [[], {}, {'scope': []}, {'scope': ['ws', START, START+ledger.DAY_MS], 'after': True}])
def test_malformed_cursor_is_rejected_before_query(world,payload):
    import base64
    token=base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    with pytest.raises(ValueError,match='invalid_cursor'):
        ledger.ledger('ws','2026-11-16','2026-11-17',cursor=token,at=AT)


def test_reanalysis_changes_with_api_and_plan_versions(world):
    seed(world)
    first=ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)
    with manage_db.get_connection() as conn:
        conn.execute('UPDATE hf_org_usage_row SET credits_c=credits_c-10')
        conn.execute('UPDATE hf_org_usage_window SET snapshot_version=2')
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_credit_plan(workspace_id,revision) VALUES('ws',7)")
    second=ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)
    assert second['plan_revision']==7 and second['api_window_versions'][0]['snapshot_version']==2
    assert first['basis_signature']!=second['basis_signature']
    assert first['intervals'][0]['residual_c']!=second['intervals'][0]['residual_c']


def test_bounded_rows_chart_and_response_size(world):
    seed(world,1100)
    answer=ledger.ledger('ws','2026-11-16','2026-11-17',limit=500,at=AT)
    assert answer['returned_count']<=500 and len(answer['chart_points'])<=1000 and answer['has_more']
    assert len(json.dumps(answer).encode())<1048576
    with pytest.raises(ValueError): ledger.ledger('ws','2026-10-01','2026-11-17',at=AT)
    with pytest.raises(ValueError): ledger.ledger('ws',limit=501,at=AT)


def test_phase2_usage_contract_is_unchanged():
    sample = data()
    current = START + 12*3600000
    sample['windows'][0]['actual_end_ms'] = current-60000
    sample['rows'] = [dict(row(created_at=START+3000,workspace_id='ws',credits_c=123),window_id=1)]
    answer = ledger.daily_usage(sample, START, current)
    assert answer['net_c'] == 123 and not answer['complete'] and answer['reason_codes'] == ['partial_day']
    a,b = points()
    b['observed_at_ms']=current
    assert ledger.interval(sample,a,b,'ws')['residual_c'] is None
    sample['checks']=[dict(state='mismatch',start_ms=START,end_ms=START+ledger.DAY_MS)]
    assert ledger.daily_usage(sample,START,current)['net_c'] is None


def test_empty_success_needs_workspace_evidence_and_long_gap_is_unavailable():
    a,b=points()
    sample=data()
    assert ledger.interval(sample,a,b,'ws')['api_created_net_c']==0
    sample['workspace_proven']=False
    assert ledger.interval(sample,a,b,'ws')['state']=='comparison_unavailable'
    sample['workspace_proven']=True
    b['observed_at_ms']=a['observed_at_ms']+32*ledger.DAY_MS
    assert 'interval_limit' in ledger.interval(sample,a,b,'ws')['reason_codes']


def test_real_allocation_pairs_require_mutual_unique_match(world):
    import uuid
    configured()
    ids=('main','sub','other')
    collections=[str(uuid.uuid4()),str(uuid.uuid4())]
    with db.get_connection() as conn:
        for wid in ids:
            conn.execute('INSERT INTO workspace_registry(id,name) VALUES(?,?)',(wid,wid))
            conn.execute('INSERT INTO workspace_console(workspace_id,tier) VALUES(?,?)',(wid,'main' if wid=='main' else 'sub'))
        for n,cid in enumerate(collections,1):
            for wid in ids:
                cents=10000 if n==1 else 9900 if wid=='main' else 10100
                balance.store(conn,EMAIL,None,1,[observation(cents,when=START+n*1000,seq=n,workspace=wid,collection_id=cid)],received_at_ms=AT)
    store_day(rows=[api_row(wid,workspace_id=wid,created_at=START,credits_c=0,charged_c=0,refunded_c=0) for wid in ids])
    answer=ledger.ledger('sub','2026-11-16','2026-11-17',at=AT)
    assert answer['intervals'][0]['candidate_classification']=='unclassified'
    assert answer['intervals'][0]['candidate_evidence'][0]['ambiguous_pair']
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_console SET archived=1 WHERE workspace_id='other'")
    answer=ledger.ledger('sub','2026-11-16','2026-11-17',at=AT)
    assert answer['intervals'][0]['candidate_classification']=='allocation_candidate'
    with db.get_connection() as conn:
        conn.execute("UPDATE hf_balance_obs SET received_at_ms=? WHERE workspace_id='main'", (AT+1,))
    pinned=ledger.ledger('sub','2026-11-16','2026-11-17',at=AT)
    assert pinned['intervals'][0]['candidate_classification']=='unclassified'
    refreshed=ledger.ledger('sub','2026-11-16','2026-11-17',at=AT+1)
    assert refreshed['intervals'][0]['candidate_classification']=='allocation_candidate'


def test_cursor_pins_time_and_rejects_observation_or_plan_changes(world):
    seed(world)
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT)
    second=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1000)
    assert second['as_of_ms']==AT and second['basis_signature']==first['basis_signature']
    with db.get_connection() as conn:
        balance.store(conn,EMAIL,None,1,[observation(9999,when=START+5000,seq=5)],received_at_ms=AT+1000)
        conn.execute("INSERT INTO workspace_registry(id,name) VALUES('other','Other')")
        conn.execute("INSERT INTO workspace_console(workspace_id,tier) VALUES('other','sub')")
        balance.store(conn,EMAIL,None,1,[observation(50,when=START+1500,workspace='other')],received_at_ms=AT+1000)
    later=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1000)
    assert later['as_of_ms']==AT and later['basis_signature']==first['basis_signature']
    assert later['chart_points']==first['chart_points']
    assert all(i['end_ms']<=START+4000 for i in later['intervals'])
    with db.get_connection() as conn:
        balance.store(conn,EMAIL,None,1,[observation(9999,when=START+1500,
                      collector_id='22222222-2222-4222-8222-222222222222')],received_at_ms=AT+1000)
    with pytest.raises(ledger.AnalysisChanged):
        ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1000)
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT+1000)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_credit_plan(workspace_id,revision) VALUES('ws',2)")
    with pytest.raises(ledger.AnalysisChanged):
        ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1000)


@pytest.mark.parametrize('prepared', [False, True])
def test_refund_candidates_match_individual_rows_and_multiple_matches_are_unclassified(prepared):
    sample = data()
    sample['windows'][0]['contract_version'] = 1
    a,b = points()
    b['credits_c'] = 10100
    sample['rows'] = [dict(row(str(n),created_at=START,workspace_id='ws',refunded_c=cents),window_id=1)
                      for n,cents in enumerate((100,250))]
    if prepared:
        ledger._prepare(sample)
    item = ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[],0)
    assert item['candidate_classification']=='refund_candidate' and item['candidate_count']==1
    sample['rows'].append(dict(row('another',created_at=START,workspace_id='ws',refunded_c=100),window_id=1))
    if prepared:
        ledger._prepare(sample)
    item = ledger.interval(sample,a,b,'ws')
    ledger.classify(item,sample,[],0)
    assert item['candidate_classification']=='unclassified' and item['candidate_count']==2
    assert 'multiple_candidates' in item['reason_codes']


def test_api_rows_are_sql_scoped_and_daily_totals_are_prepared_once(world,monkeypatch):
    seed(world)
    with manage_db.get_connection() as conn:
        conn.execute('DELETE FROM hf_org_usage_row')
        conn.execute('DELETE FROM hf_org_usage_window')
    store_day(rows=[api_row('target',workspace_id='ws'),api_row('unrelated',workspace_id='unrelated')])
    prepare = ledger._prepare
    captured = []
    class NoRescan(list):
        def __iter__(self):
            raise AssertionError('prepared rows scanned again')
    def checked(data):
        captured.extend(data['rows'])
        prepare(data)
        data['rows'] = NoRescan(data['rows'])
    monkeypatch.setattr(ledger,'_prepare',checked)
    answer=ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)
    assert captured and {r['workspace_id'] for r in captured}=={'ws'}
    assert answer['daily_api'][0]['net_c']==captured[0]['credits_c']


def test_cursor_rejects_new_preceding_anchor_but_pins_unseen_equal_epoch_conflicts(world):
    seed(world)
    collector='22222222-2222-4222-8222-222222222222'
    first=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,at=AT)
    with db.get_connection() as conn:
        balance.store(conn,EMAIL,None,1,[observation(500,when=START+3000,collector_id=collector)],received_at_ms=AT+1)
    second=ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1)
    assert second['intervals'][0]['state']!='observation_uncertain'
    assert second['chart_points']==first['chart_points']
    with db.get_connection() as conn:
        balance.store(conn,EMAIL,None,1,[observation(10000,when=START-1000,
                      collector_id='33333333-3333-4333-8333-333333333333')],received_at_ms=AT+1)
    with pytest.raises(ledger.AnalysisChanged):
        ledger.ledger('ws','2026-11-16','2026-11-17',limit=2,cursor=first['next_cursor'],at=AT+1)


def test_conflicting_epochs_and_future_points_are_not_normal_endpoints(world):
    seed(world)
    with db.get_connection() as conn:
        balance.store(conn,EMAIL,None,1,[observation(123,when=START+1000,seq=1,collector_id='22222222-2222-4222-8222-222222222222')],received_at_ms=AT)
        balance.store(conn,EMAIL,None,1,[observation(456,when=START+400000,seq=6)],received_at_ms=START)
    answer=ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)
    assert answer['intervals'][0]['state']=='observation_uncertain'
    assert answer['intervals'][0]['opening_c'] is None and answer['intervals'][0]['residual_c'] is None
    assert any(p['quality']=='conflict' for p in answer['chart_points'])
    assert any(p['quality']=='future' for p in answer['chart_points'])
    assert all(i['end_ms']!=START+400000 for i in answer['intervals'])


def test_ledger_get_does_not_write_or_call_external_services(world,monkeypatch):
    import sqlite3
    from contextlib import contextmanager
    seed(world)
    def guard(factory):
        @contextmanager
        def connect():
            with factory() as conn:
                conn.set_authorizer(lambda action,*args: sqlite3.SQLITE_DENY if action in
                    (sqlite3.SQLITE_INSERT,sqlite3.SQLITE_UPDATE,sqlite3.SQLITE_DELETE,sqlite3.SQLITE_CREATE_TABLE) else sqlite3.SQLITE_OK)
                try: yield conn
                finally: conn.set_authorizer(None)
        return connect
    monkeypatch.setattr(db,'get_connection',guard(db.get_connection))
    monkeypatch.setattr(manage_db,'get_connection',guard(manage_db.get_connection))
    from app.services import hf_org_usage_collector, cli_bridge
    monkeypatch.setattr(hf_org_usage_collector,'request_page',lambda *a,**kw:pytest.fail('external API called'))
    monkeypatch.setattr(cli_bridge,'_run',lambda *a,**kw:pytest.fail('CLI called'))
    assert ledger.ledger('ws','2026-11-16','2026-11-17',at=AT)['intervals']
