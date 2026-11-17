import json
import pytest
from test_agent_contracts import _load_agent
from app.hf_balance_contract import amount, payload_hash
from hf_balance_fixtures import EMAIL, NOW


@pytest.fixture
def agent(tmp_path, monkeypatch):
    module = _load_agent()
    monkeypatch.setattr(module,'_agent_state_path',lambda:str(tmp_path/'agent.db'))
    return module


def test_persist_before_send_and_keep_until_matching_ack(agent):
    report=agent._persist_balance_collection('http://localhost',EMAIL,[{'id':'ws','credits':100}],NOW-1,NOW,None)
    item=report['observations'][0]
    assert agent._balance_hash(item) == payload_hash(item)
    assert not agent._ack_balance_observations('http://localhost',EMAIL,{'accepted':True})
    with agent._state_db() as conn:
        assert conn.execute('SELECT state FROM balance_observation_outbox').fetchone()[0]=='pending'
    receipt=dict(version=1,receiver_kind='hub',receiver_database_id='db',stored=[dict(observation_id=item['observation_id'],payload_sha256=payload_hash(item),received_at_ms=NOW)],conflicts=[],rejected=[])
    assert agent._ack_balance_observations('http://localhost',EMAIL,receipt)
    with agent._state_db() as conn:
        assert conn.execute('SELECT state,payload_json FROM balance_observation_outbox').fetchone()[0]=='acked'
        assert json.loads(conn.execute('SELECT payload_json FROM balance_observation_outbox').fetchone()[0])==item


def test_no_account_status_probe_and_workspace_list_only(agent,monkeypatch):
    calls=[]
    def cli(_cli,*args,**kwargs):
        calls.append(args)
        return {'email':EMAIL,'credits':999} if args[:2]==('account','status') else [{'id':'ws','credits':205722.765625}]
    monkeypatch.setattr(agent,'_cli_json',cli)
    monkeypatch.setattr(agent,'_cached_cli_version',lambda _: 'fixture')
    monkeypatch.setattr(agent,'_ffmpeg_h264',lambda:False)
    with agent._balance_collection('http://localhost'):
        status,_=agent._collect_account_status('fake')
    assert 'balance_report' not in status
    with agent._state_db() as conn:
        items = [json.loads(row[0]) for row in conn.execute('SELECT payload_json FROM balance_observation_outbox')]
    assert [item['source'] for item in items]==['workspace_list']
    assert calls==[('account','status'),('workspace','list')]
    assert items[0]['credits_c']==20572277


@pytest.mark.parametrize('value',[0,1.005,-1.005,65536.0078125,131072.015625,205722.765625])
def test_agent_server_amount_contract(agent,value):
    assert agent._balance_cents(value)==amount(value)[0]


def test_old_success_response_is_not_observation_ack(agent,monkeypatch):
    agent._persist_balance_collection('http://localhost',EMAIL,[{'id':'ws','credits':100}],NOW-1,NOW,None)
    monkeypatch.setattr(agent,'_http',lambda *a,**k:(200,{'accepted':True}))
    agent._drain_balance_observations('http://localhost','token',EMAIL)
    with agent._state_db() as conn:
        assert conn.execute('SELECT state FROM balance_observation_outbox').fetchone()[0]=='unsupported'


def test_balance_storage_failure_does_not_abort_generation_ingest(agent,monkeypatch):
    from contextlib import contextmanager
    monkeypatch.setattr(agent.os.path,'isfile',lambda _:True)
    @contextmanager
    def broken():
        raise OSError('synthetic disk failure')
        yield
    monkeypatch.setattr(agent,'_state_db',broken)
    assert agent._drain_balance_observations('http://localhost','token',EMAIL) is False
    assert agent._ack_balance_observations('http://localhost',EMAIL,dict(version=1,receiver_kind='hub',receiver_database_id='x')) is False


@pytest.mark.parametrize('retryable', [False, None, True])
def test_rejected_observation_stops_only_permanent_retry_and_keeps_payload(agent,monkeypatch,retryable):
    server='http://localhost'
    item=agent._persist_balance_collection(server,EMAIL,[{'id':'ws','credits':100}],NOW-1,NOW,None)['observations'][0]
    entry=dict(observation_id=item['observation_id'],payload_sha256=payload_hash(item),code='fixture_rejection')
    if retryable is not None:
        entry['retryable']=retryable
    receipt=dict(version=1,receiver_kind='hub',receiver_database_id='db',stored=[],conflicts=[],rejected=[entry])
    sent=[]
    monkeypatch.setattr(agent,'_cli_json',lambda *a,**k:pytest.fail('retry must not collect again'))
    monkeypatch.setattr(agent,'_http',lambda *a,**k:(sent.append(k['body']) or (200,receipt)))
    monkeypatch.setattr(agent.time,'time',lambda:NOW/1000)
    agent._drain_balance_observations(server,'local',EMAIL)
    with agent._state_db() as conn:
        row=dict(conn.execute('SELECT * FROM balance_observation_outbox').fetchone())
        assert row['state']==('pending' if retryable else 'rejected')
        assert json.loads(row['payload_json'])==item
        assert row['attempts']==1
        if retryable:
            assert row['next_retry_at_ms']>NOW
        else:
            assert row['last_error_code']=='fixture_rejection'
    agent._drain_balance_observations(server,'local',EMAIL)
    assert len(sent)==1
    monkeypatch.setattr(agent.time,'time',lambda:(NOW+60000)/1000)
    agent._drain_balance_observations(server,'local',EMAIL)
    assert len(sent)==(2 if retryable else 1)


@pytest.mark.parametrize('code',['hub_not_signed_in','account_mismatch'])
def test_retryable_http_rejection_backs_off_without_collecting_or_losing_payload(agent,monkeypatch,code):
    item=agent._persist_balance_collection('http://localhost',EMAIL,[{'id':'ws','credits':100}],NOW-1,NOW,None)['observations'][0]
    calls=[]
    monkeypatch.setattr(agent,'_cli_json',lambda *a,**k:pytest.fail('retry must not collect again'))
    monkeypatch.setattr(agent,'_http',lambda *a,**k:(calls.append(k['body']) or (409,{'detail':{'code':code,'retryable':True}})))
    monkeypatch.setattr(agent.time,'time',lambda:NOW/1000)
    agent._drain_balance_observations('http://localhost','local',EMAIL)
    agent._drain_balance_observations('http://localhost','local',EMAIL)
    with agent._state_db() as conn:
        row=dict(conn.execute('SELECT * FROM balance_observation_outbox').fetchone())
        assert row['state']=='pending' and row['next_retry_at_ms']>NOW
        assert json.loads(row['payload_json'])==item
    assert len(calls)==1


def test_old_balance_queue_schema_upgrade_preserves_all_rows_and_is_idempotent(agent):
    item=agent._persist_balance_collection('http://localhost',EMAIL,[{'id':'ws','credits':100}],NOW-1,NOW,None)['observations'][0]
    with agent._state_db() as conn:
        conn.execute("UPDATE balance_observation_outbox SET state='unsupported',attempts=7,next_retry_at_ms=99,last_error_code='unsupported'")
        original=dict(conn.execute('SELECT * FROM balance_observation_outbox').fetchone())
        ddl=conn.execute("SELECT sql FROM sqlite_master WHERE name='balance_observation_outbox'").fetchone()[0]
        ddl=ddl.replace(",'rejected'",'').replace('balance_observation_outbox','old_balance_queue',1)
        conn.execute(ddl)
        conn.execute('INSERT INTO old_balance_queue SELECT * FROM balance_observation_outbox')
        conn.execute('DROP TABLE balance_observation_outbox')
        conn.execute('ALTER TABLE old_balance_queue RENAME TO balance_observation_outbox')
    for _ in range(2):
        with agent._state_db() as conn:
            assert dict(conn.execute('SELECT * FROM balance_observation_outbox').fetchone())==original
            assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='idx_agent_balance_outbox_due'").fetchone()
    with agent._state_db() as conn:
        conn.execute("UPDATE balance_observation_outbox SET state='rejected'")
        assert json.loads(conn.execute('SELECT payload_json FROM balance_observation_outbox').fetchone()[0])==item


@pytest.mark.parametrize('mode',['push','periodic'])
def test_collection_uses_only_dedicated_delivery_not_normal_ingest(agent,monkeypatch,mode):
    sent=[]
    def cli(_cli,*args,**kwargs):
        if args[:2]==('account','status'):
            return {'email':EMAIL,'credits':999}
        if args[:2]==('workspace','list'):
            return [{'id':'ws','name':'Space','credits':100}]
        return []
    def http(method,url,**kwargs):
        sent.append((url,kwargs['body']))
        assert kwargs['token']=='local'
        if url.endswith('/balance-observations'):
            with agent._state_db() as conn:
                assert conn.execute('SELECT count(*) FROM balance_observation_outbox').fetchone()[0]==1
            item=kwargs['body']['observations'][0]
            return 200,dict(version=1,receiver_kind='hub',receiver_database_id='db',stored=[dict(observation_id=item['observation_id'],payload_sha256=payload_hash(item),received_at_ms=NOW)],conflicts=[],rejected=[])
        assert url.endswith('/api/ingest')
        assert 'balance_report' not in kwargs['body']['account_status']
        assert kwargs['body']['account_status']['workspaces'][0]['credits']==100
        return 200,{'transactions_recorded':True}
    monkeypatch.setattr(agent,'_cli_json',cli)
    monkeypatch.setattr(agent,'_cached_cli_version',lambda _:'fixture')
    monkeypatch.setattr(agent,'_ffmpeg_h264',lambda:False)
    monkeypatch.setattr(agent,'_http',http)
    monkeypatch.setattr(agent,'_job_ids_to_sync',lambda *a:set())
    monkeypatch.setattr(agent,'_cached_models',lambda *a:[])
    monkeypatch.setattr(agent,'_collect_workspace_transactions',lambda *a,**k:([],{}))
    monkeypatch.setattr(agent,'_load_suppressed',lambda:set())
    if mode=='push':
        agent.push_once('http://localhost','local','fake',100)
    else:
        assert agent._report_account_status('http://localhost','local','fake')
    assert len([url for url,_ in sent if url.endswith('/balance-observations')])==1
    assert len([url for url,_ in sent if url.endswith('/api/ingest')])==1
    with agent._state_db() as conn:
        assert conn.execute('SELECT state FROM balance_observation_outbox').fetchone()[0]=='acked'
