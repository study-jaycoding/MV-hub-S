"""Independent local folder-save queue; immutable content storage keeps its own contract."""

DDL = """
CREATE TABLE IF NOT EXISTS asset_destination_outbox (
 sync_id TEXT PRIMARY KEY,
 asset_content_id TEXT NOT NULL REFERENCES asset_blob(asset_content_id),
 local_location_id TEXT NOT NULL REFERENCES asset_location(location_id),
 owner_uid TEXT NOT NULL, account_key TEXT NOT NULL, server_origin TEXT NOT NULL,
 project_name TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
 destination_kind TEXT NOT NULL, root_path TEXT NOT NULL, relative_dir TEXT NOT NULL,
 original_name TEXT NOT NULL, target_name TEXT,
 state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 next_retry_at REAL NOT NULL DEFAULT 0, lease_token TEXT, lease_until REAL,
 last_error_code TEXT, updated_at REAL NOT NULL,
 UNIQUE(account_key,owner_uid,server_origin,project_name,project_id,destination_kind,root_path,relative_dir,asset_content_id,original_name));
CREATE INDEX IF NOT EXISTS idx_asset_destination_due
 ON asset_destination_outbox(state,next_retry_at);
"""


def migrate(conn):
    for statement in DDL.split(";"):
        if statement.strip():
            conn.execute(statement)
