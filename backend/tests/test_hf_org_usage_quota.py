"""Phase 2 contracts: temporary DBs and fixed stored snapshots only."""
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import db, manage_db
from app.repo import hf_org_usage as repo
from app.repo import manage_credit_plan as plan
from app.repo.manage_quota import my_quota
from app.repo.manage_member_table import member_table
from app.usecases.hf_org_usage import my_usage
from hf_org_usage_fake import world, configured, row, ORG

START = 1794754800000  # 2026-11-16 KST
AT = START + repo.DAY_MS + 12*3_600_000


@pytest.fixture
def usage_world(world, monkeypatch):
    monkeypatch.setattr(repo, 'now_ms', lambda: AT)
    monkeypatch.setattr(plan, 'today_local', lambda: '2026-11-17')
    configured()
    with db.get_connection() as conn:
        for n in ('a','b'):
            conn.execute('INSERT INTO creator(uid,name) VALUES(?,?)', ('uid-'+n,n))
            conn.execute("INSERT INTO account(email,password_hash,status,creator_uid,name) VALUES(?,'h','approved',?,?)", (n+'@x','uid-'+n,n))
        for w in ('ws','other'):
            conn.execute('INSERT INTO workspace_registry(id,name) VALUES(?,?)',(w,w))
            conn.execute('INSERT INTO workspace_credit_plan(workspace_id,topup_day) VALUES(?,1)',(w,))
            conn.executemany("INSERT INTO workspace_member(workspace_id,account_email,creator_uid,is_available) VALUES(?,?,?,1)",[(w,n+'@x','uid-'+n) for n in ('a','b')])
        conn.execute("INSERT INTO workspace_credit_group(id,workspace_id,name,monthly_limit,limit_period,base_start) VALUES('g','ws','Group',100,'week','2026-11-01')")
        conn.executemany("INSERT INTO workspace_credit_group_member(workspace_id,account_email,group_id) VALUES('ws',?,'g')", [('a@x',),('b@x',)])
    return world


def store_day(start=START, rows=(), *, end=None, version=1, complete=1, actual_start=None, kind='day'):
    with manage_db.get_connection() as conn:
        wid = conn.execute('INSERT INTO hf_org_usage_window(org_id,start_ms,end_ms,kind,snapshot_version,success_complete,actual_start_ms,actual_end_ms,succeeded_at_ms) VALUES(?,?,?,?,?,?,?,?,?)',
                           (ORG,start,start+repo.DAY_MS,kind,version,complete,start if actual_start is None else actual_start,end or min(start+repo.DAY_MS,AT),AT)).lastrowid
        fields = ','.join(repo.ROW_FIELDS)
        conn.executemany(f"INSERT INTO hf_org_usage_row(window_id,{fields}) VALUES(?{',?'*len(repo.ROW_FIELDS)})",[(wid,*(r.get(k) for k in repo.ROW_FIELDS)) for r in rows])
    return wid


def api_row(name='r', **patch):
    return row(name, **dict(dict(start=AT-1000, actor_user_id='uid-a', workspace_id='ws'), **patch))


def fact(name='f', *, job='job-f', email='a@x', age=10, **patch):
    value = dict(local_gen_id=name,job_id=job,workspace_id='ws',workspace_scope='team',model='model',status='done',est_credits=2,
                 created_at=datetime.fromtimestamp((AT-age*60000)/1000,timezone.utc).isoformat())
    value.update(patch)
    manage_db.upsert_facts(email,'uid-'+email[0],[value])


def read(email='a@x', start=START, end=START+7*repo.DAY_MS, workspace='ws'):
    with db.get_connection() as conn:
        conn.execute('BEGIN')
        snapshot = repo.CreditUsageSnapshot(conn,[workspace],start,end)
    return snapshot.total(workspace,email,start,end)


def good_days(rows=()):
    store_day(rows=rows)
    store_day(START+repo.DAY_MS)


def ms(value):
    return round(datetime.fromisoformat(value).timestamp() * 1000)


def test_facts_parity_before_replacing_my_quota_sql(world):
    start, end = ms('2026-11-01T00:00:00+09:00'), ms('2026-12-01T00:00:00+09:00')
    facts = [
        ('real-zero', 0, 99, 'done', '2026-11-01T00:00:00+09:00', 0),
        ('estimate-zero', None, 0, 'pending', '2026-11-02T00:00:00Z', 0),
        ('failed', None, 0.123, 'failed', '2026-11-02 12:00:00', 0),
        ('deleted', 1.234, 80, 'done', '2026-11-04T13:00:00.123Z', 1),
        ('unknown', None, None, 'pending', '2026-11-02T03:00:00+09:00', 0),
        ('undated', 900, None, 'done', None, 1),
        ('before', 900, None, 'done', '2026-10-31T14:59:59Z', 0),
        ('end', 900, None, 'done', '2026-11-30T15:00:00Z', 0),
    ]
    with manage_db.get_connection() as conn:
        conn.executemany("INSERT INTO team_generation_fact(id,local_gen_id,account_email,workspace_scope,workspace_id,"
                         "real_credits,est_credits,status,created_at,is_deleted) VALUES(?,?,'a@x','team','ws',?,?,?,?,?)",
                         [(name,name,real,est,status,at,deleted) for name,real,est,status,at,deleted in facts])
        # Frozen verbatim arithmetic and predicates from the old my_quota implementation.
        old = conn.execute(
            "SELECT COALESCE(SUM(real_credits),0) AS used_real, "
            "COALESCE(SUM(CASE WHEN real_credits IS NULL THEN est_credits ELSE 0 END),0) AS used_estimated, "
            "COUNT(CASE WHEN real_credits IS NULL AND est_credits IS NOT NULL THEN 1 END) AS estimated_count, "
            "COUNT(CASE WHEN real_credits IS NULL AND est_credits IS NULL THEN 1 END) AS unknown_count "
            "FROM team_generation_fact WHERE workspace_scope='team' AND workspace_id=? AND account_email=? "
            "AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)",
            ('ws','a@x','2026-11-01T00:00:00+09:00','2026-12-01T00:00:00+09:00')).fetchone()
        new = manage_db.facts_totals(conn, ['ws'], [(start,end)])[0]
    for key in old.keys():
        assert new[key] == old[key]
    assert new['used_real'] + new['used_estimated'] == pytest.approx(1.357)


def test_api_net_refund_classification_and_no_fact_writes(usage_world):
    rows = [api_row('paid',generation_id='mv',charged_c=800,refunded_c=785,credits_c=15,error_code='moderated'),
            api_row('free',generation_id='free',charged_c=0,refunded_c=0,credits_c=0),
            api_row('refund',generation_id='refund',charged_c=150,refunded_c=150,credits_c=0,error_code='error'),
            api_row('charge',type='charge',generation_id=None,credits_c=125),
            api_row('negative',type='new_type',credits_c=-10),
            api_row('cc',surface='claude_code',credits_c=20),
            api_row('mcp',surface='mcp',credits_c=30),
            api_row('unknown',surface='future_surface',credits_c=40)]
    good_days(rows)
    fact('mv',job='mv',age=5,real_credits=99)
    before = read()
    assert before['basis'] == 'api'
    assert (before['used_real'],before['refunded']) == (2.20,10.60)
    assert (before['generation_count'],before['failed_count'],before['fully_refunded_count'],before['failed_refunded_count']) == (6,2,1,1)
    assert {s['source']:s['net'] for s in before['sources']} == dict(mv=.15,web=0,charge=1.25,other=.30,claude_code=.2,mcp=.3)
    with manage_db.get_connection() as conn:
        assert conn.execute('SELECT real_credits FROM team_generation_fact').fetchone()[0] == 99


@pytest.mark.parametrize('variant,reason',[
    ('none','missing_day'),('incomplete','incomplete_day'),('wrong_start','incomplete_day'),
    ('stale','collection_stale'),('old_missing','missing_day'),('hole','tail_gap'),
    ('disabled','collection_disabled'),('restore','restore_paused'),('org','missing_day'),
    ('duplicate','duplicate_row'),('mismatch','daily_mismatch'),('duplicate_check','daily_mismatch'),
])
def test_basis_fallbacks(usage_world,variant,reason):
    start=START
    if variant == 'old_missing':
        start -= 4*repo.DAY_MS
    if variant != 'none':
        store_day(rows=[api_row()] if variant=='duplicate' else [],
                  end=START+repo.DAY_MS-1 if variant=='hole' else None,complete=int(variant!='incomplete'),actual_start=START+1 if variant=='wrong_start' else None)
        store_day(START+repo.DAY_MS,rows=[api_row()] if variant=='duplicate' else [],end=AT-3_600_001 if variant=='stale' else AT)
    if variant in ('disabled','restore','org'):
        with manage_db.get_connection() as conn:
            conn.execute("UPDATE hf_org_usage_config SET enabled=?,restore_paused=?,org_id=?",(int(variant!='disabled'),int(variant=='restore'),'other' if variant=='org' else ORG))
    if variant in ('mismatch','duplicate_check'):
        with manage_db.get_connection() as conn:
            repo.save_check(conn,ORG,START,START+repo.DAY_MS,'mismatch' if variant=='mismatch' else 'duplicate',None,{},'test')
    result=read(start=start)
    assert (result['basis'],result['basis_reason']) == ('facts',reason)
    assert result['rows'] == result['sources'] == [] and result['refunded'] is None


def test_tail_midnight_and_first_day(usage_world,monkeypatch):
    midnight=START+repo.DAY_MS+5*60000
    monkeypatch.setattr(repo,'now_ms',lambda:midnight)
    store_day(end=START+repo.DAY_MS-5*60000)
    assert read()['basis']=='api'
    assert read(start=START+repo.DAY_MS)['basis_reason']=='missing_day'
    assert read(start=ms('2026-02-01T00:00:00+09:00'))['basis_reason']=='before_api_start'


def test_pending_arrival_cross_space_period_exact_and_overdue(usage_world):
    good_days([api_row(generation_id='arrived')])
    fact('arrived',job='arrived')
    fact('new',job='new')
    fact('old',job='old',age=61)
    fact('nojob',job=None)
    fact('failed',job='failed',status='failed')
    store_day(START-2*repo.DAY_MS, [api_row('elsewhere',generation_id='elsewhere',workspace_id='other')])
    fact('elsewhere',job='elsewhere')
    store_day(START, [api_row('exact',generation_id='exact')],kind='exact')
    fact('exact',job='exact')
    result=read()
    assert (result['used_real'],result['used_estimated'],result['estimated_count']) == (1.25,4,2)
    assert (result['overdue_pending_count'],result['unknown_count']) == (1,2)
    store_day(START-3*repo.DAY_MS,[api_row('late',generation_id='new')])
    assert read()['used_estimated']==2


def test_pending_conflicting_actor_and_duplicate_jobs(usage_world):
    good_days([api_row('conflict',generation_id='conflict',actor_user_id='uid-b'),api_row('a1',generation_id='twice'),api_row('a2',generation_id='twice')])
    fact('conflict',job='conflict')
    fact('duplicate-one',job='same')
    fact('duplicate-two',job='same',email='b@x')
    result=read()
    assert result['used_real']==2.5 and result['unknown_count']==2
    assert result['used_estimated']==0


@pytest.mark.parametrize('variant', ['unlinked','synthetic','duplicate','rejected','conflict'])
def test_identity_never_discloses_other_actor(usage_world,variant):
    good_days([api_row(),api_row('b',actor_user_id='uid-b')])
    with db.get_connection() as conn:
        if variant=='duplicate':
            conn.execute("UPDATE account SET creator_uid='uid-a' WHERE email='b@x'")
        elif variant=='rejected':
            conn.execute("UPDATE account SET status='rejected' WHERE email='a@x'")
        elif variant in ('unlinked','synthetic'):
            conn.execute("UPDATE account SET creator_uid=? WHERE email='a@x'",(None if variant=='unlinked' else 'acct:a@x',))
    if variant=='conflict':
        with manage_db.get_connection() as conn:
            conn.execute("INSERT INTO hf_org_identity_link(org_id,actor_user_id,state,account_email) VALUES(?,'uid-a','conflict','b@x')",(ORG,))
    for space in ('this','all'):
        result=my_usage('ws','a@x','week',space)
        assert result['basis']=='facts' and result['rows']==result['sources']==[]
    with pytest.raises(PermissionError):
        my_usage('not-member','a@x','period','all')


def test_consumers_same_scope_and_group_move(usage_world):
    good_days([api_row('a',credits_c=123),api_row('b',actor_user_id='uid-b',credits_c=234)])
    quota=my_quota('ws','a@x')
    settings=plan.get_settings('ws')
    view=plan.plan_view('ws',('uid-a','a@x'))['my_group']
    table=member_table('ws',with_credit=True)
    mine=next(m for m in settings['members'] if m['email']=='a@x')
    assert quota['used']==mine['used_period']==view['my_used_period']==my_usage('ws','a@x')['used']==1.23
    assert next(r for r in table['rows'] if r['email']=='a@x')['usage']['credits']==1.23
    assert view['used_period']==3.57 and view['period_usage']['basis']=='api'
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_credit_group(id,workspace_id,name,monthly_limit,limit_period,base_start) VALUES('new','ws','New',100,'day','2026-11-01')")
        conn.execute("UPDATE workspace_credit_group_member SET group_id='new' WHERE account_email='a@x'")
    assert my_quota('ws','a@x')['used']==0
    groups={g['id']:g for g in plan.get_settings('ws')['groups']}
    assert groups['g']['used_period']==2.34
    with manage_db.get_connection() as conn:
        conn.execute('UPDATE hf_org_usage_config SET enabled=0')
    fact('today',real_credits=.123)
    assert my_quota('ws','a@x')['used']==.12
    assert next(m for m in plan.get_settings('ws')['members'] if m['email']=='a@x')['used_period']==.12


def test_mixed_pool_and_unassigned_month(usage_world):
    good_days([api_row()])
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET creator_uid=NULL WHERE email='b@x'")
    fact('b',email='b@x',real_credits=9)
    group=plan.get_settings('ws')['groups'][0]
    assert group['period_usage']['basis']=='mixed' and group['used_period']==10.25
    assert plan.plan_view('ws')['pool']['month_usage']['basis']=='facts'  # month lacks earlier days


def test_list_limit_full_totals_and_created_at_not_refiltered(usage_world):
    good_days([api_row(str(i),credits_c=1,created_at=1,generation_id='j'+str(i)) for i in range(1005)])
    result=my_usage('ws','a@x','week')
    assert result['total_count']==1005 and result['returned_count']==1000 and result['truncated']
    assert result['used_real']==10.05 and result['sources']==[dict(source='web',net=10.05)]
    assert [r['row_id'] for r in result['rows']]==sorted(str(i) for i in range(1005))[:1000]
    assert all('actor' not in k and k not in ('parameters','prompt') for r in result['rows'] for k in r)


def test_closed_period_pending_boundary_and_previous_calendar(usage_world):
    store_day(START-7*repo.DAY_MS)
    for i in range(1,7):
        store_day(START+(i-7)*repo.DAY_MS)
    fact('boundary',age=36*60+1)
    result=my_usage('ws','a@x','previous')
    assert result['basis']=='api' and result['overdue_pending_count']==1
    assert result['period_start_ms']==START-7*repo.DAY_MS and result['period_end_ms']==START


def test_performance_6000_rows_eight_spaces_query_count(usage_world,monkeypatch,record_property):
    from contextlib import contextmanager
    spaces=['ws','other',*[f'w{i}' for i in range(6)]]
    with db.get_connection() as conn:
        for w in spaces[2:]:
            conn.execute('INSERT INTO workspace_registry(id,name) VALUES(?,?)',(w,w))
            conn.execute("INSERT INTO workspace_member(workspace_id,account_email,is_available) VALUES(?,'a@x',1)",(w,))
    for i in range(16):
        start=START-(15-i)*repo.DAY_MS
        store_day(start,[api_row(f'{i}-{j}',workspace_id=spaces[j%8],actor_user_id='uid-a' if j%2 else 'uid-b',generation_id=f'job-{i}-{j}',credits_c=1) for j in range(375)])
    store_day(START+repo.DAY_MS)
    store_day(START-40*repo.DAY_MS,[api_row('historic',credits_c=999999)])
    original=manage_db.get_connection
    statements=[]
    content_statements=[]
    connect=sqlite3.connect
    def traced_connect(*args,**kwargs):
        conn=connect(*args,**kwargs)
        if Path(args[0]).resolve()==(usage_world/'content.db').resolve():
            conn.set_trace_callback(content_statements.append)
        return conn
    monkeypatch.setattr(sqlite3,'connect',traced_connect)
    @contextmanager
    def traced():
        with original() as conn:
            conn.set_trace_callback(statements.append)
            yield conn
    monkeypatch.setattr(manage_db,'get_connection',traced)
    start=time.perf_counter()
    table=member_table('ws',with_credit=True)
    table_seconds=time.perf_counter()-start
    baseline=len(statements)
    baseline_content=len(content_statements)
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO workspace_credit_group_member(workspace_id,account_email,group_id) VALUES('ws',?,'g')",[(f'new{i}@x',) for i in range(40)])
    statements.clear()
    content_statements.clear()
    expanded_start=time.perf_counter()
    larger=member_table('ws',with_credit=True)
    expanded_seconds=time.perf_counter()-expanded_start
    assert len(statements)==baseline
    assert len(content_statements)==baseline_content
    elapsed=time.perf_counter()-start
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import manage
    monkeypatch.setattr(manage,'AUTH_ENABLED',False)
    app=FastAPI()
    app.include_router(manage.router)
    statements.clear()
    content_statements.clear()
    main_start=time.perf_counter()
    with TestClient(app) as client:
        responses=[client.get('/api/manage/member-table',params=dict(workspace_id=space)) for space in spaces]
    assert all(r.status_code==200 for r in responses)
    main_seconds=time.perf_counter()-main_start
    main_sql=len(statements)
    main_content_sql=len(content_statements)
    assert main_sql <= baseline*8
    with original() as conn:
        plans={label:[tuple(r) for r in conn.execute('EXPLAIN QUERY PLAN '+sql,args)] for label,sql,args in (
            ('actor','SELECT * FROM hf_org_usage_row WHERE window_id=? AND workspace_id=? AND actor_user_id=?',(1,'ws','uid-a')),
            ('job','SELECT * FROM hf_org_usage_row WHERE generation_id=?',('job',)),
            ('facts',"SELECT * FROM team_generation_fact WHERE workspace_scope='team' AND workspace_id=? AND julianday(created_at)>=julianday(?)",('ws','2026-11-01')))}
        actual_facts_query=next(q for q in statements if q.startswith('WITH ranges'))
        plans['facts_totals']=[tuple(r) for r in conn.execute('EXPLAIN QUERY PLAN '+actual_facts_query)]
        for label,prefix in (('snapshot_rows','SELECT r.* FROM hf_org_usage_window'),
                             ('pending_jobs','SELECT r.generation_id,r.actor_user_id FROM')):
            actual_query=next(q for q in statements if q.startswith(prefix))
            plans[label]=[tuple(r) for r in conn.execute('EXPLAIN QUERY PLAN '+actual_query)]
    evidence=dict(sql_count=baseline+baseline_content,manage_sql_count=baseline,content_sql_count=baseline_content,
                  table_seconds=round(table_seconds,4),expanded_table_seconds=round(expanded_seconds,4),
                  response_bytes=len(responses[0].content),
                  main_requests=8,main_sql_count=main_sql+main_content_sql,main_manage_sql_count=main_sql,
                  main_content_sql_count=main_content_sql,main_seconds=round(main_seconds,4),
                  main_response_bytes=sum(len(r.content) for r in responses),plans=plans)
    print('PERFORMANCE',json.dumps(evidence))
    record_property('performance',json.dumps(evidence))
    assert elapsed<10


def test_personal_route_validation_and_injected_identity(usage_world,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import manage_quota
    good_days([api_row('a',credits_c=100),api_row('b',actor_user_id='uid-b',credits_c=999)])
    monkeypatch.setattr(manage_quota,'AUTH_ENABLED',True)
    monkeypatch.setattr(manage_quota,'current_account',lambda _:dict(email='a@x',global_role='admin'))
    app=FastAPI()
    app.include_router(manage_quota.router,prefix='/api/manage')
    with TestClient(app) as client:
        for space in ('this','all'):
            response=client.get('/api/manage/credit-plan/my-usage',params=dict(workspace_id='ws',range='week',space=space,email='b@x',creator_uid='uid-b',account_id='b'))
            assert response.status_code==200 and response.json()['used_real']==1
        for params in (dict(workspace_id=''),dict(workspace_id='w'*129),dict(workspace_id='ws',range='invalid'),dict(workspace_id='ws',space='invalid')):
            assert client.get('/api/manage/credit-plan/my-usage',params=params).status_code==422
        assert client.get('/api/manage/credit-plan/my-usage?workspace_id=not-member&space=all').status_code==403


@pytest.mark.parametrize('status',[200,403,404,502])
def test_proxy_actual_token_and_auth_off_order(usage_world,monkeypatch,status):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import manage_quota, _proxy
    from hf_org_usage_fake import fake_server
    monkeypatch.setattr(manage_quota,'AUTH_ENABLED',False)
    monkeypatch.setattr(_proxy,'proxying',lambda:True)
    monkeypatch.setattr(_proxy,'token',lambda:'fixture-relay-token')
    original=_proxy._open
    seen=[]
    def checked(req,timeout):
        seen.append(req.get_header('Authorization')=='Bearer fixture-relay-token')
        return original(req,timeout)
    monkeypatch.setattr(_proxy,'_open',checked)
    app=FastAPI()
    app.include_router(manage_quota.router,prefix='/api/manage')
    with fake_server([(status,{},dict(workspace_id='ws',basis='api') if status==200 else dict(detail='fixture error'))]) as (url,calls):
        monkeypatch.setattr(_proxy,'base_url',lambda:url.removesuffix('/report'))
        with TestClient(app) as client:
            response=client.get('/api/manage/credit-plan/my-usage?workspace_id=ws&range=week&space=all')
    assert response.status_code==status and seen==[True]
    assert calls==['/api/manage/credit-plan/my-usage?workspace_id=ws&range=week&space=all']
    monkeypatch.setattr(_proxy,'proxying',lambda:False)
    with TestClient(app) as client:
        result=client.get('/api/manage/credit-plan/my-usage?workspace_id=ws').json()
        assert result['basis']=='unavailable' and result['used'] is None
        assert result['range']=='period' and result['space']=='this'
        assert result['generation_count'] is None and result['unknown_count'] is None


@pytest.mark.parametrize('basis',['api','facts'])
@pytest.mark.parametrize('period,expected',[('month',23),('week',18),('day',11)])
def test_group_move_same_cycle_and_month_to_week_day(usage_world,basis,period,expected):
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_credit_group SET limit_period='month' WHERE id='g'")
        conn.execute("INSERT INTO workspace_credit_group(id,workspace_id,name,monthly_limit,limit_period,base_start) VALUES('new','ws','New',100,?,'2026-11-01')",(period,))
    amounts={-14:5,0:7,1:11}
    for offset in range(-15,2):
        rows=[api_row('a'+str(offset),credits_c=amounts[offset]*100,generation_id='a'+str(offset))] if offset in amounts else []
        if offset==1:
            rows.append(api_row('b',actor_user_id='uid-b',credits_c=300,generation_id='b'))
        store_day(START+offset*repo.DAY_MS,rows)
    for offset,amount in amounts.items():
        fact('a'+str(offset),job='a'+str(offset),real_credits=amount,created_at=datetime.fromtimestamp((START+offset*repo.DAY_MS+1000)/1000,timezone.utc).isoformat())
    fact('b',job='b',email='b@x',real_credits=3)
    if basis=='facts':
        with manage_db.get_connection() as conn:
            conn.execute('UPDATE hf_org_usage_config SET enabled=0')
    assert my_quota('ws','a@x')['used']==23
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_credit_group_member SET group_id='new' WHERE account_email='a@x'")
    assert my_quota('ws','a@x')['used']==expected
    groups={g['id']:g for g in plan.get_settings('ws')['groups']}
    assert groups['g']['used_period']==3 and groups['new']['used_period']==expected


def test_facts_group_sums_before_display_rounding(usage_world):
    fact('a',real_credits=.123)
    fact('b',email='b@x',real_credits=.234)
    assert my_quota('ws','a@x')['used']==.12
    assert my_quota('ws','b@x')['used']==.23
    assert plan.get_settings('ws')['groups'][0]['used_period']==.36


def test_valid_pool_does_not_add_unlinked_member_facts(usage_world):
    for offset in range(-15,2):
        store_day(START+offset*repo.DAY_MS,[api_row('unlinked',actor_user_id='orphan')] if offset==1 else [])
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET creator_uid=NULL WHERE email='b@x'")
    fact('b',email='b@x',real_credits=9)
    result=plan.plan_view('ws')
    assert result['pool']['month_usage']['basis']=='api' and result['pool']['used_month']==1.25
    assert result['pool']['month_usage']['unlinked_api']==1.25
    assert result['groups'][0]['period_usage']['basis']=='mixed' and result['groups'][0]['used_period']==9


def test_old_hub_middleware_relays_new_unknown_route(usage_world,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import _proxy
    from hf_org_usage_fake import fake_server
    monkeypatch.setattr(_proxy,'proxying',lambda:True)
    monkeypatch.setattr(_proxy,'token',lambda:'fixture-relay-token')
    app=FastAPI()  # Deliberately no my-usage router, as in an old local hub.
    app.middleware('http')(_proxy.data_proxy_middleware)
    with fake_server([(200,{},dict(workspace_id='ws',basis='api',used=1.25))]) as (url,calls):
        monkeypatch.setattr(_proxy,'base_url',lambda:url.removesuffix('/report'))
        with TestClient(app) as client:
            response=client.get('/api/manage/credit-plan/my-usage?workspace_id=ws')
    assert response.status_code==200 and response.json()['used']==1.25
    assert calls==['/api/manage/credit-plan/my-usage?workspace_id=ws']


def test_api_empty_success_is_zero_but_no_success_is_not(usage_world):
    assert read()['basis']=='facts'
    good_days()
    result=read()
    assert result['basis']=='api' and result['used_real']==0 and result['generation_count']==0


def test_duplicate_inside_narrower_group_period(usage_world):
    for offset in (-1,0,1):
        store_day(START+offset*repo.DAY_MS,[api_row('same')])
    with db.get_connection() as conn:
        snapshot=repo.CreditUsageSnapshot(conn,['ws'],START-repo.DAY_MS,START+7*repo.DAY_MS,ranges=[(START,START+7*repo.DAY_MS)])
    assert snapshot.total('ws','a@x',START,START+7*repo.DAY_MS)['basis_reason']=='duplicate_row'


def test_facts_personal_endpoints_share_legacy_rounding(usage_world):
    fact('tie',real_credits=.125)
    quota=my_quota('ws','a@x')
    assert quota['used']==.12
    assert my_usage('ws','a@x')['used']==quota['used']
    assert plan.plan_view('ws',('uid-a','a@x'))['my_group']['my_used_period']==quota['used']


@pytest.mark.parametrize('basis',['api','facts'])
def test_unassigned_member_table_uses_topup_month(usage_world,basis):
    first=START-repo.DAY_MS  # November 15, outside the current group week.
    with db.get_connection() as conn:
        conn.execute("DELETE FROM workspace_credit_group_member WHERE account_email='a@x'")
        conn.execute("UPDATE workspace_credit_plan SET topup_day=15 WHERE workspace_id='ws'")
    store_day(first,[api_row('older',generation_id='older',credits_c=700)])
    good_days()
    fact('older',job='older',real_credits=7,created_at=datetime.fromtimestamp((first+1000)/1000,timezone.utc).isoformat())
    if basis=='facts':
        with manage_db.get_connection() as conn:
            conn.execute('UPDATE hf_org_usage_config SET enabled=0')
    table=member_table('ws',with_credit=True)
    usage=next(r for r in table['rows'] if r['email']=='a@x')['usage']
    assert usage['credits']==7 and usage['basis']==basis and usage['period_start_ms']==first
    assert my_usage('ws','a@x')['used']==7
    quota=my_quota('ws','a@x')
    assert quota['source']=='unassigned' and quota['used']==0 and quota['usage_supported']


def test_api_only_former_member_is_in_unassigned_total(usage_world):
    for offset in range(-15,2):
        store_day(START+offset*repo.DAY_MS,[api_row('former',actor_user_id='uid-b')] if offset==1 else [])
    with db.get_connection() as conn:
        conn.execute("DELETE FROM workspace_credit_group_member WHERE account_email='b@x'")
        conn.execute("DELETE FROM workspace_member WHERE workspace_id='ws' AND account_email='b@x'")
    result=plan.plan_view('ws')
    assert result['pool']['used_month']==result['unassigned']['used_month']==1.25
    assert result['unassigned']['month_usage']['basis']=='api'


def test_pending_valid_day_evidence_and_same_owner_deduplication(usage_world):
    good_days()
    for job in ('duplicate','foreign','incomplete','exact','future'):
        fact(job,job=job)
    foreign=store_day(START-2*repo.DAY_MS,[api_row('foreign',generation_id='foreign')])
    store_day(START-3*repo.DAY_MS,[api_row('incomplete',generation_id='incomplete')],complete=0)
    store_day(START,[api_row('exact',generation_id='exact')],kind='exact')
    store_day(START+2*repo.DAY_MS,[api_row('future',generation_id='future')])
    with manage_db.get_connection() as conn:
        conn.execute("UPDATE hf_org_usage_window SET org_id='other-org' WHERE id=?",(foreign,))
        conn.execute("INSERT INTO team_generation_fact(id,local_gen_id,account_email,creator_uid,job_id,workspace_scope,workspace_id,est_credits,created_at,status) "
                     "SELECT 'clone','clone',account_email,creator_uid,job_id,workspace_scope,workspace_id,est_credits,created_at,status "
                     "FROM team_generation_fact WHERE job_id='duplicate'")
    before=read()
    assert before['used']==10 and before['estimated_count']==5 and before['unknown_count']==0
    with manage_db.get_connection() as conn:
        wid=conn.execute('SELECT id FROM hf_org_usage_window WHERE org_id=? AND start_ms=? AND kind=\'day\'',(ORG,START+repo.DAY_MS)).fetchone()[0]
        arrived=api_row('arrived',generation_id='duplicate',charged_c=200,refunded_c=0,credits_c=200)
        conn.execute(f"INSERT INTO hf_org_usage_row(window_id,{','.join(repo.ROW_FIELDS)}) VALUES(?{',?'*len(repo.ROW_FIELDS)})",(wid,*(arrived[k] for k in repo.ROW_FIELDS)))
    after=read()
    assert after['used']==before['used'] and after['used_real']==2 and after['used_estimated']==8
