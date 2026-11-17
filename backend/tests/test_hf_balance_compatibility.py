import sqlite3
import pytest
from app import db, schema_compat
from app.hf_balance_contract import matching_ack
from hf_balance_fixtures import balance_db, observation


@pytest.mark.parametrize('agent,hub,server',[(a,h,s) for a in (False,True) for h in (False,True) for s in (False,True)])
def test_agent_hub_server_version_matrix(balance_db,monkeypatch,agent,hub,server):
    from hf_balance_fixtures import EMAIL,NOW
    from test_agent_contracts import _load_agent
    from app import config,repo
    from app.usecases.hf_balance import receive
    from app.services import hf_balance_delivery
    # Old receivers emulate their accepted=true interface; installed old apps remain a release check.
    module=_load_agent()
    monkeypatch.setattr(module,'_agent_state_path',lambda:str(balance_db/'agent.db'))
    hub_path=balance_db/'content.db'
    server_path=balance_db/'server.db'
    db.init_db(server_path)
    status={'email':EMAIL,'workspaces':[{'id':'ws','name':'Space','credits':100}]}
    report=module._persist_balance_collection('http://localhost',EMAIL,status['workspaces'],NOW-1,NOW,None) if agent else None
    if report:
        status['balance_report']=report
    account={'email':EMAIL,'creator_uid':None}
    target='https://server.invalid:8010'
    receipt={'accepted':True}
    if hub and agent:
        receipt,_=receive(account,EMAIL,1,report['observations'],target=target,receiver='hub')
    else:
        repo.record_account_status(EMAIL,{key:value for key,value in status.items() if key!='balance_report'})
    if agent:
        assert module._ack_balance_observations('http://localhost',EMAIL,receipt)==hub
        with module._state_db() as conn:
            assert conn.execute('SELECT state FROM balance_observation_outbox').fetchone()[0]==('acked' if hub else 'pending')
    if hub and agent:
        monkeypatch.setattr(config,'AUTH_ENABLED',False)
        monkeypatch.setattr(config,'READ_ONLY',False)
        monkeypatch.setattr(config,'EXTERNAL_RECOVERY_ENABLED',True)
        monkeypatch.setenv('CONTENT_HUB_NO_PROXY','0')
        def push(body):
            if not server:
                return {'accepted':True}
            with monkeypatch.context() as remote:
                remote.setenv('CONTENT_HUB_DB',str(server_path))
                return receive(account,EMAIL,body['version'],body['observations'],receiver='server')[0]
        hf_balance_delivery.drain(push,account_key=EMAIL,target=target,current=lambda:(EMAIL,target))
        with db.get_connection() as conn:
            assert conn.execute('SELECT state FROM hf_balance_outbox').fetchone()[0]==('acked' if server else 'unsupported')
    elif server:
        with monkeypatch.context() as remote:
            remote.setenv('CONTENT_HUB_DB',str(server_path))
            repo.record_account_status(EMAIL,status)
    with sqlite3.connect(server_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==int(agent and server)


def test_existing_inspector_and_legacy_sql_preserve_additive_tables(balance_db):
    # The inspector source is unchanged by this feature. Actual installed binaries remain a release check.
    path=balance_db/'content.db'
    with db.get_connection() as conn:
        from hf_balance_fixtures import seed_balance
        seed_balance(conn)
        before=list(map(tuple,conn.execute('SELECT * FROM schema_migrations')))
        names={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {'hf_balance_obs','hf_balance_outbox'}<=names
    inspection = schema_compat.inspect_database(path,'content')
    assert 'content_core' in inspection.components
    with sqlite3.connect(path) as legacy:
        legacy.execute("UPDATE workspace_registry SET credits=12 WHERE id='ws'")
        assert list(legacy.execute('SELECT * FROM schema_migrations'))==before
        assert legacy.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==1
