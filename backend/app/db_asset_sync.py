"""Additive immutable-content and local transfer ledger schema."""
from __future__ import annotations

import sqlite3


DDL = """
CREATE TABLE IF NOT EXISTS asset_blob (
 asset_content_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE,
 bytes INTEGER NOT NULL CHECK(bytes>0), media_type TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS asset_location (
 location_id TEXT PRIMARY KEY, asset_content_id TEXT NOT NULL REFERENCES asset_blob(asset_content_id),
 owner_uid TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', storage_id TEXT NOT NULL,
 root_revision TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('local','server')),
 path TEXT NOT NULL, original_file_path TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'ready', registry_asset_id TEXT,
 UNIQUE(storage_id,root_revision,project_id,owner_uid,asset_content_id,kind));
CREATE TABLE IF NOT EXISTS asset_sync_outbox (
 sync_id TEXT PRIMARY KEY, asset_content_id TEXT NOT NULL REFERENCES asset_blob(asset_content_id),
 local_location_id TEXT NOT NULL REFERENCES asset_location(location_id), owner_uid TEXT NOT NULL,
 project_id TEXT NOT NULL DEFAULT '', account_key TEXT NOT NULL, server_origin TEXT NOT NULL DEFAULT '',
 storage_id TEXT NOT NULL DEFAULT '', root_revision TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 next_retry_at REAL NOT NULL DEFAULT 0, lease_token TEXT, lease_until REAL,
 last_error_code TEXT, receipt_json TEXT, updated_at REAL NOT NULL,
 UNIQUE(asset_content_id,owner_uid,project_id,server_origin));
CREATE INDEX IF NOT EXISTS idx_asset_sync_due ON asset_sync_outbox(state,next_retry_at);
CREATE TABLE IF NOT EXISTS asset_owner_folder (
 project_id TEXT NOT NULL, root_revision TEXT NOT NULL, owner_uid TEXT NOT NULL,
 folder_label TEXT NOT NULL, folder_cf TEXT NOT NULL,
 PRIMARY KEY(project_id,root_revision,owner_uid), UNIQUE(project_id,root_revision,folder_cf));
CREATE TABLE IF NOT EXISTS asset_location_alias (
 alias_id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES asset_location(location_id));
CREATE TABLE IF NOT EXISTS asset_upload_token (
 token TEXT PRIMARY KEY, asset_content_id TEXT NOT NULL, owner_uid TEXT NOT NULL,
 project_id TEXT NOT NULL, storage_id TEXT NOT NULL, root_revision TEXT NOT NULL,
 relative_path TEXT NOT NULL, original_name TEXT NOT NULL, bytes INTEGER NOT NULL,
 media_type TEXT NOT NULL, expires_at REAL NOT NULL);
"""


def migrate(conn: sqlite3.Connection) -> None:
    # Execute statements separately: executescript would commit the caller's transaction.
    for statement in DDL.split(';'):
        if statement.strip():
            conn.execute(statement)
    for table, column, kind in (
        ('project', 'asset_root_path', 'TEXT'),
        ('reference', 'asset_content_id', 'TEXT'),
        ('asset', 'asset_content_id', 'TEXT'),
        ('gen_reference', 'position', 'INTEGER'),
    ):
        if column not in {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {kind}')
