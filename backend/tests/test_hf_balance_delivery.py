import pytest
from app import config, db
from app.hf_balance_contract import payload_hash
from app.repo import hf_balance as balances
from app.services import hf_balance_delivery as delivery
from hf_balance_fixtures import balance_db, observation, EMAIL, NOW

TARGET='https://server.invalid:8010'


@pytest.fixture
def forward(balance_db, monkeypatch):
    monkeypatch.setattr(config,'AUTH_ENABLED',False)
    monkeypatch.setattr(config,'READ_ONLY',False)
    monkeypatch.setattr(config,'MANAGE_ENABLED',True)
    monkeypatch.setattr(config,'EXTERNAL_RECOVERY_ENABLED',True)
    monkeypatch.setenv('CONTENT_HUB_NO_PROXY','0')
    return lambda push,current=lambda:(EMAIL,TARGET),now=NOW+10000: delivery.drain(push,account_key=EMAIL,target=TARGET,current=current,clock=lambda:now)


def queue(items, target=TARGET):
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return balances.store(conn,EMAIL,None,1,items,target=target,receiver='hub',received_at_ms=NOW+1000)


def ack(body):
    return dict(version=1,receiver_kind='server',receiver_database_id='remote-db',
                stored=[dict(observation_id=i['observation_id'],payload_sha256=payload_hash(i),received_at_ms=NOW+2000) for i in body['observations']],conflicts=[],rejected=[])


def test_two_hop_restart_and_lost_ack(forward):
    item=observation()
    hub=queue([item])
    assert hub['receiver_kind']=='hub'
    seen=[]
    def lost(body):
        seen.extend(body['observations'])
        raise TimeoutError()
    assert forward(lost)['pushed']==0
    db.flush_pool()
    assert forward(ack,now=NOW+100000)['pushed']==1
    with db.get_connection() as conn:
        row=conn.execute('SELECT * FROM hf_balance_outbox').fetchone()
        assert row['state']=='acked'
        assert row['attempts']==2
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_obs').fetchone()[0]==1
    assert seen[0]['observation_id']==item['observation_id']


def test_backlog_does_not_starve_latest_or_oldest(forward):
    items=[observation(when=NOW+i,seq=i+1) for i in range(150)]
    queue(items[:100]);queue(items[100:])
    captured=[]
    def push(body):
        captured.extend(body['observations'])
        return ack(body)
    forward(push)
    ids={r['observation_id'] for r in captured}
    assert items[0]['observation_id'] in ids and items[-1]['observation_id'] in ids
    assert len(ids)==100


@pytest.mark.parametrize('gate',['AUTH_ENABLED','READ_ONLY','EXTERNAL_RECOVERY_ENABLED','CONTENT_HUB_NO_PROXY'])
def test_no_remote_delivery_in_server_readonly_isolated_or_test_dev(forward,monkeypatch,gate):
    queue([observation()])
    if gate=='CONTENT_HUB_NO_PROXY':
        monkeypatch.setenv(gate,'1')
    else:
        monkeypatch.setattr(config,gate,gate!='EXTERNAL_RECOVERY_ENABLED')
    assert forward(lambda body:pytest.fail('network forbidden'))['pushed']==0


def test_delivery_pins_account_target_and_lease_without_downgrade(forward):
    queue([observation()])
    state=[(EMAIL,TARGET)]
    def changed(body):
        state[0]=(EMAIL,'http://different.invalid')
        return ack(body)
    forward(changed,current=lambda:state[0])
    with db.get_connection() as conn:
        assert conn.execute('SELECT state FROM hf_balance_outbox').fetchone()[0]=='pending'
    assert forward(lambda body:pytest.fail('wrong account'),current=lambda:('other',TARGET))['pushed']==0


def test_new_input_does_not_reset_unsupported_target_gate(forward):
    queue([observation()])
    forward(lambda body:{'accepted':True})
    queue([observation(seq=2,when=NOW+1)])
    assert forward(lambda body:pytest.fail('unsupported target gate'))['pushed']==0


def test_stale_lease_cannot_settle_reclaimed_rows(forward):
    queue([observation()])
    with db.get_connection() as conn:
        conn.execute('BEGIN IMMEDIATE')
        old=balances.claim(conn,EMAIL,TARGET,NOW+2000)
        new=balances.claim(conn,EMAIL,TARGET,NOW+200000)
        receipt=ack({'observations':old})
        balances.settle(conn,old,receipt,NOW+200001)
        assert conn.execute('SELECT lease_token,state FROM hf_balance_outbox').fetchone()[:] == (new[0]['lease_token'],'sending')


def test_retry_without_new_ingest_and_shutdown(monkeypatch):
    import asyncio
    from app.routers import _telemetry
    wakes=[]
    async def sleep(_):
        if wakes:
            raise asyncio.CancelledError()
    monkeypatch.setattr(delivery,'enabled',lambda:True)
    monkeypatch.setattr(_telemetry.asyncio,'sleep',sleep)
    monkeypatch.setattr(_telemetry,'schedule_telemetry_drain',lambda:wakes.append(True))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_telemetry.balance_retry_loop())
    assert wakes==[True]


@pytest.mark.parametrize('fault',['foreign_id','wrong_hash','duplicate','wrong_receiver'])
def test_invalid_ack_cannot_settle_the_queue(forward,fault):
    queue([observation()])
    def wrong(body):
        response=ack(body)
        if fault=='foreign_id':response['stored'][0]['observation_id']='foreign'
        if fault=='wrong_hash':response['stored'][0]['payload_sha256']='0'*64
        if fault=='duplicate':response['stored']*=2
        if fault=='wrong_receiver':response['receiver_kind']='hub'
        return response
    assert forward(wrong)['pushed']==0
    with db.get_connection() as conn:
        assert conn.execute('SELECT state FROM hf_balance_outbox').fetchone()[0]!='acked'


def test_forwarding_packs_within_raw_request_limit(forward):
    import json
    items=[observation(seq=n+1,workspace='가'*256,cli_version='가'*128) for n in range(100)]
    queue(items)
    lengths=[]
    def push(body):
        lengths.append(len(json.dumps(body).encode()))
        return ack(body)
    forward(push)
    assert lengths and max(lengths)<=262144
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM hf_balance_outbox WHERE state='acked'").fetchone()[0]<100
