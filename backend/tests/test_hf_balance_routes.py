from types import SimpleNamespace
import pytest
from fastapi import BackgroundTasks, HTTPException
from app import config, deps
from app.routers import hf_balance as route
from hf_balance_fixtures import balance_db, observation, EMAIL


def request(account=None, token=None, key=None):
    from starlette.requests import Request
    headers=[]
    if token: headers.append((b'authorization',('Bearer '+token).encode()))
    if key: headers.append((b'x-mvhub-agent-key',key.encode()))
    value=Request(dict(type='http',method='POST',path='/api/ingest/balance-observations',headers=headers,
                       client=('127.0.0.1',123),server=('localhost',8010),scheme='http'))
    value.state.account=account
    return value


def test_observation_ingest_rejects_unauthenticated_mismatch_and_bad_agent_key(balance_db,monkeypatch):
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(deps,'AUTH_ENABLED',True)
    body=route.BalanceObservationsIn(version=1,account_email=EMAIL,observations=[observation()])
    with pytest.raises(HTTPException) as exc:
        route.receive_observations(body,request(),BackgroundTasks())
    assert exc.value.status_code==401
    monkeypatch.setattr(route,'_agent_write_acc',lambda req:{'email':EMAIL})
    with pytest.raises(HTTPException) as exc:
        route.receive_observations(body.model_copy(update={'account_email':'other@example.test'}),request(),BackgroundTasks())
    assert exc.value.status_code==409
    monkeypatch.setattr(config,'LOCAL_AGENT_PAIR_SECRET','fixture-key')
    with pytest.raises(HTTPException) as exc:
        route.receive_observations(body,request(token='local',key='wrong'),BackgroundTasks())
    assert exc.value.status_code==403
    from app import db
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==0
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_outbox').fetchone()[0]==0


@pytest.mark.parametrize('mode',['signed_in','signed_out','mismatch','standalone'])
def test_agent_bearer_local_hub_http_boundary_preserves_rejected_reports(balance_db,monkeypatch,tmp_path,mode):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import active_account, db, repo
    from app.routers import ingest
    from test_agent_contracts import _load_agent
    from hf_balance_fixtures import NOW
    agent=_load_agent()
    monkeypatch.setattr(agent,'_agent_state_path',lambda:str(tmp_path/'agent-http.db'))
    monkeypatch.setattr(agent,'_cli_json',lambda *a,**kw:pytest.fail('retry collected again'))
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    monkeypatch.setattr(deps,'AUTH_ENABLED',False)
    monkeypatch.setattr(route._proxy,'AUTH_ENABLED',False)
    monkeypatch.setattr(config,'LOCAL_AGENT_PAIR_SECRET','')
    monkeypatch.setenv('CONTENT_HUB_NO_PROXY','1' if mode=='standalone' else '0')
    monkeypatch.delenv('CONTENT_HUB_SHARED_URL',raising=False)
    monkeypatch.setattr(route,'schedule_telemetry_drain',lambda:None)
    active=active_account.set_override(EMAIL if mode in ('signed_in','mismatch') else '')
    try:
        if mode!='standalone':
            repo.set_setting('shared_server_url','https://server.example.invalid')
        if mode in ('signed_in','mismatch'):
            repo.set_setting('shared_server_token','server-session-fixture')
        assert route._proxy.token()!='local'
        app=FastAPI()
        @app.middleware('http')
        async def loopback(request,call_next):
            request.scope['client']=('127.0.0.1',12345)
            return await call_next(request)
        app.include_router(route.router)
        email='other@example.test' if mode=='mismatch' else EMAIL
        original=agent._persist_balance_collection('http://localhost',email,[dict(id='ws',credits=123)],NOW-1,NOW,None)
        responses=[]
        with TestClient(app) as client:
            def send(method,url,*,token,body,**kwargs):
                assert token=='local'
                response=client.request(method,'/api/ingest/balance-observations',headers={'Authorization':'Bearer '+token},json=body)
                responses.append(response)
                return response.status_code,response.json()
            monkeypatch.setattr(agent,'_http',send)
            agent._drain_balance_observations('http://localhost','local',email)
        accepted=mode in ('signed_in','standalone')
        with db.get_connection() as conn:
            assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==int(accepted)
            assert conn.execute('SELECT COUNT(*) FROM hf_balance_outbox').fetchone()[0]==int(mode=='signed_in')
            assert conn.execute("SELECT credits FROM workspace_registry WHERE id='ws'").fetchone()[0]==(123 if accepted else 100)
            assert conn.execute('SELECT COUNT(*) FROM workspace_member').fetchone()[0]==0
            assert bool(conn.execute("SELECT 1 FROM app_setting WHERE key='balance_database_id'").fetchone())==accepted
        with agent._state_db() as conn:
            row=conn.execute('SELECT * FROM balance_observation_outbox').fetchone()
            import json
            assert json.loads(row['payload_json'])==original['observations'][0]
            assert row['state']==('acked' if accepted else 'pending')
            if not accepted:
                assert row['next_retry_at_ms']>row['last_attempt_at_ms']
        response=responses[0]
        if accepted:
            assert response.status_code==200 and response.json()['receiver_kind']=='hub'
        else:
            assert response.status_code==409 and response.json()['detail']['retryable']
            assert response.json()['detail']['code']==('hub_not_signed_in' if mode=='signed_out' else 'account_mismatch')
    finally:
        active_account.reset_override(active)


def test_logout_switches_to_legacy_db_without_ack_and_login_delivers_original(tmp_path,monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import active_account, db, db_paths, repo
    from app.routers import publish
    from app.services import hf_balance_delivery
    from app.usecases.hf_balance import receive
    from test_agent_contracts import _load_agent
    from hf_balance_fixtures import NOW

    monkeypatch.delenv('CONTENT_HUB_DB',raising=False)
    monkeypatch.setattr(config,'DATA_DIR',tmp_path)
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    monkeypatch.setattr(deps,'AUTH_ENABLED',False)
    monkeypatch.setattr(publish,'AUTH_ENABLED',False)
    monkeypatch.setattr(route._proxy,'AUTH_ENABLED',False)
    monkeypatch.setattr(config,'LOCAL_AGENT_PAIR_SECRET','')
    monkeypatch.setattr(active_account,'_POINTER',tmp_path/'active.json')
    monkeypatch.setattr(active_account,'_cache',[False,None])
    monkeypatch.setattr(active_account,'_epoch',[0])
    legacy=tmp_path/'legacy.db'
    monkeypatch.setattr(db_paths,'DEFAULT_DB_PATH',legacy)
    monkeypatch.setattr(db,'DEFAULT_DB_PATH',legacy)
    monkeypatch.setenv('CONTENT_HUB_NO_PROXY','0')
    monkeypatch.setattr(route,'schedule_telemetry_drain',lambda:None)
    agent=_load_agent()
    monkeypatch.setattr(agent,'_agent_state_path',lambda:str(tmp_path/'agent-logout.db'))
    monkeypatch.setattr(agent,'_cli_json',lambda *a,**kw:pytest.fail('retry collected again'))
    marker=active_account.set_override(None)
    try:
        active_account.clear_active()
        db.init_db()
        active_account.set_active(EMAIL)
        db.init_db()
        account_path=db.get_db_path()
        target='https://server.example.invalid'
        def login():
            active_account.set_active(EMAIL)
            publish._save_shared_session(url=target,email=EMAIL,token='server-session-fixture',
                                         account=dict(name='Fixture'),clear_elevation=True)
        login()
        app=FastAPI()
        @app.middleware('http')
        async def loopback(request,call_next):
            request.scope['client']=('127.0.0.1',12345)
            return await call_next(request)
        app.include_router(route.router)
        app.include_router(publish.router)
        original=agent._persist_balance_collection('http://localhost',EMAIL,[dict(id='ws',credits=123)],NOW-1,NOW,None)
        with TestClient(app,base_url='http://localhost') as client:
            assert client.post('/api/shared-server/logout').status_code==200
            assert not active_account._POINTER.exists()
            assert active_account.account_key() is None and db.get_db_path()==legacy
            assert repo.get_setting('shared_server_url') is None and route._proxy.token() is None
            responses=[]
            def send(method,url,*,token,body,**kwargs):
                assert token=='local'
                response=client.request(method,'/api/ingest/balance-observations',
                                        headers={'Authorization':'Bearer local'},json=body)
                responses.append(response)
                return response.status_code,response.json()
            monkeypatch.setattr(agent,'_http',send)
            agent._drain_balance_observations('http://localhost','local',EMAIL)
            assert responses[-1].status_code==409
            assert responses[-1].json()['detail']==dict(code='hub_not_signed_in',retryable=True)
            for path in (legacy,account_path):
                with db.get_connection(db_path=path) as conn:
                    assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==0
                    assert conn.execute('SELECT COUNT(*) FROM hf_balance_outbox').fetchone()[0]==0
                    assert not conn.execute("SELECT 1 FROM app_setting WHERE key='balance_database_id'").fetchone()
            with agent._state_db() as conn:
                row=conn.execute('SELECT * FROM balance_observation_outbox').fetchone()
                assert row['state']=='pending' and row['last_error_code']=='hub_not_signed_in'
                assert json.loads(row['payload_json'])==original['observations'][0]
                assert row['next_retry_at_ms']>row['last_attempt_at_ms']
                conn.execute('UPDATE balance_observation_outbox SET next_retry_at_ms=0')
            login()
            agent._drain_balance_observations('http://localhost','local',EMAIL)
            assert responses[-1].status_code==200
            assert responses[-1].json()['stored'][0]['observation_id']==original['observations'][0]['observation_id']
        server_path=tmp_path/'server.db'
        db.init_db(server_path)
        monkeypatch.setattr(config,'EXTERNAL_RECOVERY_ENABLED',True)
        monkeypatch.setattr(config,'READ_ONLY',False)
        def deliver(body):
            with monkeypatch.context() as remote:
                remote.setenv('CONTENT_HUB_DB',str(server_path))
                return receive(dict(email=EMAIL),EMAIL,body['version'],body['observations'],receiver='server')[0]
        hf_balance_delivery.drain(deliver,account_key=EMAIL,target=target,current=lambda:(EMAIL,target))
        with db.get_connection(db_path=server_path) as conn:
            assert conn.execute('SELECT observation_id FROM hf_balance_obs').fetchone()[0]==original['observations'][0]['observation_id']
        with db.get_connection() as conn:
            assert conn.execute('SELECT state FROM hf_balance_outbox').fetchone()[0]=='acked'
    finally:
        active_account.reset_override(marker)
        db.flush_pool()


def test_legacy_ingest_ignores_observations_without_ack(balance_db,monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import active_account, db
    from app.routers import ingest
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    monkeypatch.setattr(deps,'AUTH_ENABLED',False)
    monkeypatch.setattr(ingest,'AUTH_ENABLED',False)
    monkeypatch.setenv('CONTENT_HUB_NO_PROXY','1')
    marker=active_account.set_override('')
    try:
        app=FastAPI()
        app.include_router(ingest.router)
        with TestClient(app) as client:
            response=client.post('/api/ingest',headers={'Authorization':'Bearer local'},json=dict(
                jobs=[],account_status=dict(email=EMAIL,workspaces=[],balance_report=dict(version=1,observations=[observation()]))))
        assert response.status_code==200 and 'balance_receipt' not in response.json()
        with db.get_connection() as conn:
            assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==0
            raw=conn.execute("SELECT value FROM app_setting WHERE key='hf_status:local'").fetchone()[0]
            assert 'balance_report' not in json.loads(raw)
    finally:
        active_account.reset_override(marker)


def test_history_ingest_does_not_reapply_membership(balance_db,monkeypatch):
    from app import db
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(route,'_agent_write_acc',lambda req:{'email':EMAIL})
    monkeypatch.setattr(route._proxy,'proxying',lambda:False)
    monkeypatch.setattr(route,'schedule_telemetry_drain',lambda:None)
    body=route.BalanceObservationsIn(version=1,account_email=EMAIL,observations=[observation()])
    result=route.receive_observations(body,request(),BackgroundTasks())
    assert result['stored']
    with db.get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM workspace_member').fetchone()[0]==0
    duplicate_tasks=BackgroundTasks()
    route.receive_observations(body,request(),duplicate_tasks)
    assert not duplicate_tasks.tasks


def test_balance_and_ledger_permissions_and_private_fields(balance_db,monkeypatch):
    from app import db
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(route._proxy,'proxying',lambda:False)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_registry(id,name,credits) VALUES('other','Other',42)")
        conn.execute("INSERT INTO workspace_member(workspace_id,account_email,is_available) VALUES('ws',?,1)", (EMAIL,))
    req=request(dict(email=EMAIL,status='approved',global_role='admin'))
    assert [b['workspace_id'] for b in route.get_balances(req)['balances']]==['ws']
    assert route.get_balances(req,'other')['balances'][0]['credits']==42
    req.state.account['global_role']='member'
    with pytest.raises(HTTPException) as exc: route.get_balances(req,'other')
    assert exc.value.status_code==403
    with pytest.raises(HTTPException) as exc: route.get_balance_ledger(req,'ws',limit=100)
    assert exc.value.status_code==403
    req.state.account['global_role']='product_manager'
    assert route.get_balances(req,'other')['balances'][0]['credits']==42
    with pytest.raises(HTTPException) as exc: route.get_balance_ledger(req,'ws',limit=100)
    assert exc.value.status_code==403
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    assert route.get_balances(req)['basis']=='unavailable'
    with pytest.raises(HTTPException) as exc: route.get_balance_ledger(req,'ws',limit=100)
    assert exc.value.status_code==404
    monkeypatch.setattr(route._proxy,'proxying',lambda:True)
    monkeypatch.setattr(route._proxy,'proxy_get',lambda path,request:dict(path=path))
    assert route.get_balances(req)['path']=='/api/manage/balances'
    assert route.get_balance_ledger(req,'ws',limit=100)['path']=='/api/manage/console/balance-ledger'


def test_balance_get_is_read_only_and_never_collects(balance_db,monkeypatch):
    import sqlite3
    from contextlib import contextmanager
    from app import db
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_member(workspace_id,account_email,is_available) VALUES('ws',?,1)", (EMAIL,))
    original=db.get_connection
    @contextmanager
    def read_only():
        with original() as conn:
            conn.set_authorizer(lambda action,*args: sqlite3.SQLITE_DENY if action in
                                (sqlite3.SQLITE_INSERT,sqlite3.SQLITE_UPDATE,sqlite3.SQLITE_DELETE,sqlite3.SQLITE_CREATE_TABLE) else sqlite3.SQLITE_OK)
            try: yield conn
            finally: conn.set_authorizer(None)
    monkeypatch.setattr(db,'get_connection',read_only)
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(route._proxy,'proxying',lambda:False)
    monkeypatch.setattr(route,'schedule_telemetry_drain',lambda:pytest.fail('GET scheduled delivery'))
    answer=route.get_balances(request(dict(email=EMAIL,status='approved',global_role='member')))
    assert answer['balances'][0]['basis']=='legacy_snapshot'


def test_mismatched_balance_schema_keeps_legacy_status_and_exposes_write_error(balance_db,monkeypatch):
    from app import db, repo
    from app.usecases.hf_balance import delivery_status
    with db.get_connection() as conn:
        conn.execute('DROP TABLE hf_balance_outbox')
        conn.execute('DROP TABLE hf_balance_obs')
        conn.execute('CREATE TABLE hf_balance_obs(observation_id TEXT PRIMARY KEY)')
    db.flush_pool()
    db.init_db()
    repo.record_account_status(EMAIL,dict(email=EMAIL,workspaces=[dict(id='ws',name='Still usable',credits=42)]))
    assert delivery_status()['balance_error_code']=='balance_schema_mismatch'
    assert not delivery_status()['balance_write_enabled']
    monkeypatch.setattr(config,'AUTH_ENABLED',True)
    monkeypatch.setattr(route,'_agent_write_acc',lambda req:dict(email=EMAIL))
    body=route.BalanceObservationsIn(version=1,account_email=EMAIL,observations=[observation()])
    with pytest.raises(HTTPException) as exc:
        route.receive_observations(body,request(),BackgroundTasks())
    assert exc.value.status_code==503 and exc.value.detail['retryable']
    with db.get_connection() as conn:
        assert conn.execute("SELECT credits FROM workspace_registry WHERE id='ws'").fetchone()[0]==42
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==0
