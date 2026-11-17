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
    assert [item['source'] for item in status['balance_report']['observations']]==['workspace_list']
    assert calls==[('account','status'),('workspace','list')]
    assert status['balance_report']['observations'][0]['credits_c']==20572277


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
