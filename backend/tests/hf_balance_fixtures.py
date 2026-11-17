"""Fixed wire examples shared by server and the standalone agent tests."""
import uuid
import pytest
from app import db

EMAIL = 'balance@example.test'
NOW = 1794873600000
COLLECTOR = '11111111-1111-4111-8111-111111111111'


def observation(cents=10000, when=NOW, seq=1, workspace='ws', **changes):
    item = dict(observation_id=str(uuid.uuid4()), collection_id=str(uuid.uuid4()),
                collector_id=COLLECTOR, collection_seq=seq, workspace_id=workspace,
                source='workspace_list', reported_credits=str(cents/100), credits_c=cents,
                started_at_ms=when-1, observed_at_ms=when, cli_version=None)
    item.update(changes)
    return item


def seed_balance(conn):
    from app import db_hf_balance
    from app.hf_balance_contract import FIELDS, payload_hash
    db_hf_balance.migrate(conn)
    item=observation()
    columns=[*FIELDS,'protocol_version','reporter_key','reporter_uid','received_at_ms',
             'time_quality','precision_kind','precision_error_c','payload_sha256']
    values=[item[key] for key in FIELDS]+[1,EMAIL,None,NOW,'reported','workspace_list_binary32',0,payload_hash(item)]
    conn.execute(f"INSERT INTO hf_balance_obs({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",values)
    conn.execute('INSERT INTO hf_balance_outbox(account_key,target_key,observation_id,queued_at_ms) VALUES(?,?,?,?)',
                 (EMAIL,'https://fixture.invalid',item['observation_id'],NOW))
    return item


@pytest.fixture
def balance_db(tmp_path, monkeypatch):
    monkeypatch.setenv('CONTENT_HUB_DB', str(tmp_path/'content.db'))
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_registry(id,name,credits) VALUES('ws','Space',100)")
    yield tmp_path
    db.flush_pool()
