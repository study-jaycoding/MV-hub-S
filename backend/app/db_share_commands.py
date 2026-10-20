"""Content v2: share revision and durable command responses; legacy checksums stay fixed."""
from . import schema_compat


def migrate(conn):
    existing = schema_compat.inspect_schema(conn, "content")
    if "content_share_commands" in existing.components:
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        if "share_revision" not in {r[1] for r in conn.execute("PRAGMA table_info(generation)")}:
            conn.execute("ALTER TABLE generation ADD COLUMN share_revision INTEGER NOT NULL DEFAULT 0")
        for name in ("remote_command_json", "remote_result_json"):
            if name not in {r[1] for r in conn.execute("PRAGMA table_info(share_state_intent)")}:
                conn.execute(f"ALTER TABLE share_state_intent ADD COLUMN {name} TEXT")
        conn.execute("""CREATE TABLE IF NOT EXISTS share_command_receipt (
            actor_id TEXT NOT NULL, operation_id TEXT NOT NULL,
            workspace_scope TEXT NOT NULL, target_id TEXT NOT NULL,
            command_kind TEXT NOT NULL, request_hash TEXT NOT NULL,
            expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL,
            state TEXT NOT NULL, result_code TEXT NOT NULL, result_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY(actor_id, operation_id))""")
        for name, sql in schema_compat.SHARE_REVISION_TRIGGERS.items():
            found = conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,)).fetchone()
            if found is None:
                conn.execute(sql)
        schema_compat.record_baseline_in_transaction(conn, "content_share_commands")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
