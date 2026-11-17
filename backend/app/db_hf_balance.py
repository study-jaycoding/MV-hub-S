"""Additive balance tables: deliberately no baseline or migration registration."""
from __future__ import annotations

import sqlite3

DDL = """
CREATE TABLE IF NOT EXISTS hf_balance_obs (
 observation_id TEXT PRIMARY KEY, protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
 collection_id TEXT NOT NULL, collector_id TEXT NOT NULL,
 collection_seq INTEGER NOT NULL CHECK(collection_seq>=1),
 reporter_key TEXT NOT NULL, reporter_uid TEXT,
 workspace_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('workspace_list')),
 reported_credits TEXT NOT NULL, credits_c INTEGER NOT NULL
 CHECK(typeof(credits_c)='integer' AND credits_c BETWEEN -9007199254740991 AND 9007199254740991),
 started_at_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
 local_received_at_ms INTEGER, received_at_ms INTEGER NOT NULL,
 time_quality TEXT NOT NULL CHECK(time_quality IN ('reported','future','reversed')),
 precision_kind TEXT NOT NULL CHECK(precision_kind IN ('workspace_list_binary32','workspace_list_unknown')),
 precision_error_c INTEGER CHECK(precision_error_c IS NULL OR precision_error_c>=0),
 cli_version TEXT, payload_sha256 TEXT NOT NULL,
 UNIQUE(reporter_key,collector_id,collection_seq,workspace_id,source));
CREATE INDEX IF NOT EXISTS idx_hf_balance_obs_latest
 ON hf_balance_obs(workspace_id,observed_at_ms DESC,observation_id DESC) WHERE time_quality='reported';
CREATE INDEX IF NOT EXISTS idx_hf_balance_obs_history
 ON hf_balance_obs(workspace_id,observed_at_ms,observation_id);
CREATE TABLE IF NOT EXISTS hf_balance_outbox (
 account_key TEXT NOT NULL, target_key TEXT NOT NULL,
 observation_id TEXT NOT NULL REFERENCES hf_balance_obs(observation_id) ON DELETE RESTRICT,
 queued_at_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','sending','acked','unsupported','conflict')),
 attempts INTEGER NOT NULL DEFAULT 0, fail_streak INTEGER NOT NULL DEFAULT 0,
 last_attempt_at_ms INTEGER, next_retry_at_ms INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until_ms INTEGER, acked_at_ms INTEGER,
 receiver_database_id TEXT, last_error_code TEXT,
 PRIMARY KEY(account_key,target_key,observation_id));
CREATE INDEX IF NOT EXISTS idx_hf_balance_outbox_due
 ON hf_balance_outbox(account_key,target_key,state,next_retry_at_ms,queued_at_ms);
CREATE INDEX IF NOT EXISTS idx_hf_balance_outbox_active
 ON hf_balance_outbox(account_key,target_key,next_retry_at_ms,queued_at_ms) WHERE state<>'acked';
CREATE INDEX IF NOT EXISTS idx_hf_balance_outbox_ack_time
 ON hf_balance_outbox(acked_at_ms DESC) WHERE state='acked';
"""


def _structure(conn):
    return conn.execute("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'hf_balance_%' "
                        "OR name LIKE 'idx_hf_balance_%' ORDER BY name").fetchall()


def validate(conn):
    with sqlite3.connect(':memory:') as expected:
        expected.executescript(DDL)
        wanted = [tuple(row) for row in _structure(expected)]
    actual = [tuple(row) for row in _structure(conn)]
    actual = {row[1]: row for row in actual}
    if any(actual.get(row[1]) != row for row in wanted):
        raise RuntimeError('balance_schema_mismatch')


def schema_error(conn):
    try:
        validate(conn)
    except (RuntimeError, sqlite3.DatabaseError):
        return 'balance_schema_mismatch'
    return None


def migrate(conn):
    for statement in DDL.split(';'):
        if statement.strip():
            conn.execute(statement)
    validate(conn)
