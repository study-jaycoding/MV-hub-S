"""Additive Slack tables. No schema_migrations entry: older readers must admit this DB."""

SLACK_SCHEMA = """
CREATE TABLE IF NOT EXISTS slack_link (
    account_email TEXT PRIMARY KEY,
    slack_user_id TEXT NOT NULL,
    slack_team_id TEXT NOT NULL,
    slack_email TEXT NOT NULL DEFAULT '',
    slack_name TEXT NOT NULL DEFAULT '',
    linked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_dm_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at REAL NOT NULL,
    db_generation TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at REAL NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until REAL,
    send_started_at REAL,
    sent_at REAL,
    closed_at REAL,
    close_reason TEXT,
    token_revision INTEGER,
    slack_team_id TEXT NOT NULL,
    UNIQUE(comment_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS idx_slack_dm_due ON slack_dm_outbox(state, next_retry_at);
"""


def migrate(conn):
    # execute rather than executescript: never commit a caller's transaction.
    for statement in SLACK_SCHEMA.split(';'):
        if statement.strip():
            conn.execute(statement)
