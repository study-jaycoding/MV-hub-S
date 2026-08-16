"""PM 대시보드 사이드카 테이블과 멱등 마이그레이션 경계."""

from __future__ import annotations

from ..db import get_db_path, pool_epoch

# FK/ON DELETE CASCADE는 일부러 두지 않는다. 코어 project 삭제 경로와 사이드카 수명을 분리한다.
_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS generation_metrics (
        gen_id          TEXT PRIMARY KEY,
        job_id          TEXT,
        est_credits     INTEGER,
        real_credits    INTEGER,
        credit_source   TEXT,
        requested_at    TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        elapsed_seconds REAL,
        matched         INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS credit_txn (
        id             TEXT PRIMARY KEY,
        owner_uid      TEXT,
        account_email  TEXT,
        display_name   TEXT,
        credits        REAL,
        action         TEXT,
        created_at     TEXT,
        matched_gen_id TEXT,
        model          TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS project_planning (
        project_id     TEXT PRIMARY KEY,
        status         TEXT,
        start_date     TEXT,
        due_date       TEXT,
        budget_credits INTEGER,
        budget_period  TEXT NOT NULL DEFAULT 'month',
        archive_after_days INTEGER NOT NULL DEFAULT 30,
        note           TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS project_folder_link (
        project_id    TEXT PRIMARY KEY,
        root_path     TEXT NOT NULL,
        selected_path TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    """CREATE TABLE IF NOT EXISTS project_task (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        name         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'not_started',
        assignee_uid TEXT,
        start_date   TEXT,
        due_date     TEXT,
        sort_order   INTEGER,
        note         TEXT,
        sequence     TEXT,
        description  TEXT,
        source_kind  TEXT NOT NULL DEFAULT 'manual',
        source_last_seen_at TEXT,
        archived     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    """CREATE TABLE IF NOT EXISTS task_generation (
        task_id TEXT NOT NULL,
        gen_id  TEXT NOT NULL,
        PRIMARY KEY (task_id, gen_id)
    )""",
    """CREATE TABLE IF NOT EXISTS task_planned_creator (
        task_id     TEXT NOT NULL,
        creator_uid TEXT NOT NULL,
        added_by    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, creator_uid)
    )""",
    """CREATE TABLE IF NOT EXISTS task_assignment (
        task_id      TEXT NOT NULL,
        assignee_uid TEXT NOT NULL,
        added_by     TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, assignee_uid)
    )""",
    """CREATE TABLE IF NOT EXISTS final_export (
        gen_id      TEXT PRIMARY KEY,
        dest_path   TEXT NOT NULL,
        exported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    """CREATE TABLE IF NOT EXISTS telemetry_outbox (
        local_gen_id     TEXT PRIMARY KEY,
        dirty_at         TEXT NOT NULL DEFAULT (datetime('now')),
        dirty_rev        INTEGER NOT NULL DEFAULT 1,
        pushed_at        TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        is_tombstone     INTEGER NOT NULL DEFAULT 0,
        tomb_job_id      TEXT,
        tomb_creator_uid TEXT,
        tomb_snapshot    TEXT,
        fail_streak      INTEGER NOT NULL DEFAULT 0,  -- 연속 실패 수(성공·재dirty 시 0)
        next_retry_at    TEXT                          -- 이 시각 전에는 드레인이 건너뜀(백오프)
    )""",
    """CREATE TABLE IF NOT EXISTS telemetry_delivery_state (
        id              INTEGER PRIMARY KEY CHECK(id = 1),
        last_success_at TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS account_report_outbox (
        report_key      TEXT PRIMARY KEY,
        report_type     TEXT NOT NULL CHECK(report_type IN ('status', 'transaction')),
        payload_json    TEXT NOT NULL,
        payload_hash    TEXT NOT NULL,
        dirty_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        dirty_rev       INTEGER NOT NULL DEFAULT 1,
        pushed_at       TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        fail_streak     INTEGER NOT NULL DEFAULT 0,
        next_retry_at   TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS account_report_delivery_state (
        id              INTEGER PRIMARY KEY CHECK(id = 1),
        last_success_at TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_outbox_pushed ON telemetry_outbox(pushed_at)",
    "CREATE INDEX IF NOT EXISTS idx_account_report_outbox_pushed "
    "ON account_report_outbox(pushed_at, next_retry_at, dirty_at)",
    "CREATE INDEX IF NOT EXISTS idx_credit_txn_owner ON credit_txn(owner_uid, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_credit_txn_unmatched ON credit_txn(owner_uid) "
    "WHERE action='spend' AND matched_gen_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_project_task_proj ON project_task(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_gen_gen ON task_generation(gen_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_planned_uid ON task_planned_creator(creator_uid, task_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_assignment_uid ON task_assignment(assignee_uid, task_id)",
)

# 계정 DB 전환과 DB 파일 교체를 구분하도록 (경로, 풀 에폭)별로 보장 여부를 기억한다.
_SCHEMA_ENSURED: set[tuple[str, int]] = set()


def ensure_manage_schema(conn) -> None:
    """현재 계정 DB에 사이드카 테이블·인덱스·호환 컬럼을 멱등으로 보장한다."""
    key = (str(get_db_path()), pool_epoch())
    if key in _SCHEMA_ENSURED:
        return
    for statement in _SCHEMA:
        conn.execute(statement)

    task_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_task)")}
    for column in ("sequence", "description", "folder_path", "source_last_seen_at"):
        if column not in task_columns:
            conn.execute(f"ALTER TABLE project_task ADD COLUMN {column} TEXT")
    if "source_kind" not in task_columns:
        conn.execute(
            "ALTER TABLE project_task ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'"
        )
    if "archived" not in task_columns:
        conn.execute(
            "ALTER TABLE project_task ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"
        )
    # 기존 폴더 자동 작업은 수동 작업과 구분한다. 상태·일정·설명은 건드리지 않는다.
    conn.execute(
        "UPDATE project_task SET source_kind='generation' "
        "WHERE folder_path IS NOT NULL AND TRIM(folder_path)<>'' "
        "AND COALESCE(source_kind, 'manual')='manual'"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_folder "
        "ON project_task(project_id, folder_path) WHERE folder_path IS NOT NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_task_active "
        "ON project_task(project_id, archived, source_kind)"
    )

    transaction_columns = {row[1] for row in conn.execute("PRAGMA table_info(credit_txn)")}
    if "model" not in transaction_columns:
        conn.execute("ALTER TABLE credit_txn ADD COLUMN model TEXT")

    planning_columns = {row[1] for row in conn.execute("PRAGMA table_info(project_planning)")}
    if "budget_period" not in planning_columns:
        conn.execute(
            "ALTER TABLE project_planning ADD COLUMN budget_period TEXT NOT NULL DEFAULT 'month'"
        )
    if "archive_after_days" not in planning_columns:
        conn.execute(
            "ALTER TABLE project_planning ADD COLUMN archive_after_days "
            "INTEGER NOT NULL DEFAULT 30"
        )

    outbox_columns = {row[1] for row in conn.execute("PRAGMA table_info(telemetry_outbox)")}
    if "is_tombstone" not in outbox_columns:
        conn.execute(
            "ALTER TABLE telemetry_outbox ADD COLUMN is_tombstone INTEGER NOT NULL DEFAULT 0"
        )
    for column in ("tomb_job_id", "tomb_creator_uid", "tomb_snapshot"):
        if column not in outbox_columns:
            conn.execute(f"ALTER TABLE telemetry_outbox ADD COLUMN {column} TEXT")
    if "fail_streak" not in outbox_columns:
        conn.execute(
            "ALTER TABLE telemetry_outbox ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0"
        )
    if "next_retry_at" not in outbox_columns:
        conn.execute("ALTER TABLE telemetry_outbox ADD COLUMN next_retry_at TEXT")
    if "dirty_rev" not in outbox_columns:
        # dirty_at은 SQLite 밀리초 정밀도라 같은 tick의 재변경을 CAS로 구분할 수 없다.
        # 기존 행은 첫 revision으로 간주하고 이후 dirty마다 1씩 증가시킨다.
        conn.execute(
            "ALTER TABLE telemetry_outbox ADD COLUMN dirty_rev INTEGER NOT NULL DEFAULT 1"
        )

    # 과거 설치본은 outbox의 pushed_at만 가지고 있다. 최초 마이그레이션 때 그중 가장 최근
    # 성공 시각을 단일 상태 행으로 옮겨, 같은 항목이 다시 dirty 되어도 성공 이력이 사라지지
    # 않게 한다. 이미 상태 행이 있으면 절대 덮어쓰지 않는다.
    conn.execute(
        "INSERT OR IGNORE INTO telemetry_delivery_state(id, last_success_at) "
        "SELECT 1, strftime('%Y-%m-%dT%H:%M:%fZ', MAX(pushed_at)) "
        "FROM telemetry_outbox"
    )

    export_columns = {row[1] for row in conn.execute("PRAGMA table_info(final_export)")}
    if "project_id" not in export_columns:
        conn.execute("ALTER TABLE final_export ADD COLUMN project_id TEXT")

    for old, new in (
        ("todo", "not_started"),
        ("review", "publish"),
        ("retake", "in_progress"),
    ):
        conn.execute("UPDATE project_task SET status=? WHERE status=?", (new, old))
    conn.execute(
        "INSERT INTO task_assignment(task_id, assignee_uid, added_by) "
        "SELECT id, assignee_uid, 'migrate' FROM project_task "
        "WHERE assignee_uid IS NOT NULL AND assignee_uid<>'' "
        "ON CONFLICT(task_id, assignee_uid) DO NOTHING"
    )
    conn.execute(
        "UPDATE project_task SET assignee_uid=NULL "
        "WHERE assignee_uid IS NOT NULL AND assignee_uid<>''"
    )
    # 호출자가 연 트랜잭션에서 롤백할 수 있으면 다음 호출이 다시 보장해야 한다.
    if not conn.in_transaction:
        _SCHEMA_ENSURED.add(key)


# 기존 테스트·내부 호출이 사용하던 private 이름을 호환 파사드에서 재노출한다.
_ensure_schema = ensure_manage_schema
