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
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    monkeypatch.setattr(config,'LOCAL_AGENT_PAIR_SECRET','fixture-key')
    monkeypatch.setattr(route._proxy,'token',lambda:'fixture-token')
    with pytest.raises(HTTPException) as exc:
        route.receive_observations(body,request(token='fixture-token',key='wrong'),BackgroundTasks())
    assert exc.value.status_code==403


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
