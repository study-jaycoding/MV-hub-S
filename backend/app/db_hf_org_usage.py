"""Additive manage DB tables; deliberately no schema_migrations entry."""
import sqlite3

TABLES = (
    "hf_org_usage_row", "hf_org_usage_check", "hf_org_identity_link",
    "hf_org_usage_window", "hf_org_usage_collector", "hf_org_usage_config",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS hf_org_usage_config (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL DEFAULT 0,
    org_id TEXT, encrypted_key TEXT, key_verified_revision INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0, restore_paused INTEGER NOT NULL DEFAULT 0,
    registered_at_ms INTEGER, registered_by TEXT, expires_on TEXT,
    last_check_at_ms INTEGER, last_check_code TEXT
);
CREATE TABLE IF NOT EXISTS hf_org_usage_collector (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), lease_owner TEXT,
    lease_fence INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER NOT NULL DEFAULT 0,
    io_owner TEXT, io_until_ms INTEGER NOT NULL DEFAULT 0,
    rate_state_json TEXT NOT NULL DEFAULT '[]', retry_after_ms INTEGER NOT NULL DEFAULT 0,
    backfill_cursor INTEGER, rotation_cursor INTEGER, last_progress_at_ms INTEGER,
    pause_code TEXT
);
CREATE TABLE IF NOT EXISTS hf_org_usage_window (
    id INTEGER PRIMARY KEY, org_id TEXT NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('day','exact')),
    contract_version INTEGER NOT NULL DEFAULT 1, snapshot_version INTEGER NOT NULL DEFAULT 0,
    success_complete INTEGER NOT NULL DEFAULT 0, actual_start_ms INTEGER, actual_end_ms INTEGER,
    request_started_at_ms INTEGER, succeeded_at_ms INTEGER, row_count INTEGER, page_count INTEGER,
    last_attempt_at_ms INTEGER, last_attempt_code TEXT, next_due_ms INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
    recheck_snapshot_version INTEGER NOT NULL DEFAULT 0, UNIQUE(org_id,start_ms,end_ms,kind)
);
CREATE TABLE IF NOT EXISTS hf_org_usage_row (
    window_id INTEGER NOT NULL, row_id TEXT NOT NULL, type TEXT NOT NULL,
    created_at INTEGER NOT NULL, workspace_id TEXT, workspace_name TEXT,
    actor_user_id TEXT, actor_email TEXT, model TEXT, model_name TEXT,
    credits_c INTEGER NOT NULL, charged_c INTEGER NOT NULL, refunded_c INTEGER NOT NULL,
    status TEXT, state TEXT, error_code TEXT, generation_id TEXT,
    original_generation_id TEXT, output_type TEXT, surface TEXT,
    PRIMARY KEY(window_id,row_id)
);
CREATE TABLE IF NOT EXISTS hf_org_identity_link (
    org_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, account_email TEXT, creator_uid TEXT,
    state TEXT NOT NULL CHECK(state IN ('verified','stale','conflict')),
    evidence_fingerprint TEXT, verified_at_ms INTEGER,
    PRIMARY KEY(org_id,actor_user_id)
);
CREATE TABLE IF NOT EXISTS hf_org_usage_check (
    org_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
    state TEXT NOT NULL, exact_window_id INTEGER, exact_snapshot_version INTEGER,
    daily_versions_json TEXT NOT NULL, checked_at_ms INTEGER NOT NULL, reason_code TEXT,
    PRIMARY KEY(org_id,start_ms,end_ms)
);
CREATE INDEX IF NOT EXISTS idx_hf_org_generation ON hf_org_usage_row(generation_id);
CREATE INDEX IF NOT EXISTS idx_hf_org_workspace_actor ON hf_org_usage_row(window_id,workspace_id,actor_user_id);
CREATE INDEX IF NOT EXISTS idx_hf_org_identity_email ON hf_org_identity_link(account_email);
INSERT OR IGNORE INTO hf_org_usage_config(singleton) VALUES(1);
INSERT OR IGNORE INTO hf_org_usage_collector(singleton) VALUES(1);
"""


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(hf_org_usage_window)")}
    for name in ("fail_count", "recheck_snapshot_version"):
        if name not in columns:
            conn.execute(f"ALTER TABLE hf_org_usage_window ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0")
