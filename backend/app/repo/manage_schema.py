"""PM 대시보드 사이드카 테이블과 멱등 마이그레이션 경계."""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any

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
        workspace_scope TEXT NOT NULL DEFAULT 'unknown',
        workspace_id TEXT,
        workspace_name TEXT,
        workspace_origin TEXT NOT NULL DEFAULT 'snapshot',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    """CREATE TABLE IF NOT EXISTS manage_schema_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        next_retry_at   TEXT,
        dead_lettered_at TEXT
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
_TASK_WORKSPACE_MIGRATION_KEY = "task_workspace_snapshot_v1"
_CREDIT_TXN_IDENTITY_INDEX = "idx_credit_txn_stable_identity"


def unresolved_workspace_sql(alias: str = "") -> str:
    """DB의 불완전한 워크스페이스 값을 ``unknown``과 같은 의미로 판별한다.

    일부 중간 배포 DB에는 ``workspace_scope='team'``이지만 ID가 비어 있는 행이 남아
    있다. Python 정규화기만 unknown으로 보고 SQL은 team으로 보면 목록·권한·이관의
    의미가 갈라지므로 모든 조회가 공유하는 판정식을 제공한다.
    """
    prefix = f"{alias}." if alias else ""
    scope = f"LOWER(TRIM(COALESCE({prefix}workspace_scope, '')))"
    workspace_id = f"NULLIF(TRIM(COALESCE({prefix}workspace_id, '')), '')"
    return (
        f"({scope} NOT IN ('team', 'personal') OR "
        f"({scope}='team' AND {workspace_id} IS NULL))"
    )


def _workspace_snapshot(row: Any) -> tuple[str, str | None, str | None]:
    """불완전한 구 데이터도 세 가지 작업 범위로 정규화한다."""
    scope = str(row["workspace_scope"] or "").strip().lower()
    workspace_id = str(row["workspace_id"] or "").strip() or None
    workspace_name = str(row["workspace_name"] or "").strip() or None
    if scope == "team" and workspace_id:
        return "team", workspace_id, workspace_name
    if scope == "personal":
        return "personal", None, None
    return "unknown", None, None


def task_workspace_migration_preflight(conn) -> dict[str, int]:
    """RL-02 마이그레이션 전 데이터 모양을 읽기 전용으로 센다.

    운영 DB 복사본에서 먼저 호출해 모호한 프로젝트·폴더·수동 작업의 규모를 확인할 수 있다.
    이 함수는 테이블이나 행을 절대 변경하지 않는다.
    """
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    generation_columns = (
        {row[1] for row in conn.execute("PRAGMA table_info(generation)")}
        if "generation" in tables
        else set()
    )
    task_columns = (
        {row[1] for row in conn.execute("PRAGMA table_info(project_task)")}
        if "project_task" in tables
        else set()
    )

    # 이 점검은 스키마 변경보다 먼저 실행된다. 아주 오래된 DB에는 folder/workspace 컬럼이
    # 없을 수 있으므로 없는 사실을 추측해서 채우지 않고 unknown/NULL 읽기 표현으로 다룬다.
    # ALTER TABLE을 먼저 하면 원본 읽기 전용이라는 도구 계약이 깨진다.
    generation_rows = []
    if generation_columns and "project_id" in generation_columns:
        generation_rows = conn.execute(
            "SELECT project_id, "
            + ("folder_path" if "folder_path" in generation_columns else "NULL")
            + " AS folder_path, "
            + ("workspace_scope" if "workspace_scope" in generation_columns else "'unknown'")
            + " AS workspace_scope, "
            + ("workspace_id" if "workspace_id" in generation_columns else "NULL")
            + " AS workspace_id, "
            + ("workspace_name" if "workspace_name" in generation_columns else "NULL")
            + " AS workspace_name FROM generation WHERE project_id IS NOT NULL"
        ).fetchall()
    project_scopes: dict[str, set[tuple[str, str | None]]] = defaultdict(set)
    folder_scopes: dict[tuple[str, str], set[tuple[str, str | None]]] = defaultdict(set)
    for row in generation_rows:
        scope, workspace_id, _workspace_name = _workspace_snapshot(row)
        key = (scope, workspace_id)
        project_id = row["project_id"]
        project_scopes[project_id].add(key)
        folder_path = str(row["folder_path"] or "").strip()
        if folder_path:
            folder_scopes[(project_id, folder_path)].add(key)

    manual_where = []
    if "source_kind" in task_columns:
        manual_where.append("COALESCE(t.source_kind, 'manual')='manual'")
    if "folder_path" in task_columns:
        manual_where.append("(t.folder_path IS NULL OR TRIM(t.folder_path)='')")
    manual_where_sql = " AND ".join(manual_where) or "1=1"
    manual_rows = []
    if "project_task" in tables and "task_generation" in tables and generation_columns:
        manual_rows = conn.execute(
            "SELECT t.id, "
            + (
                "g.workspace_scope"
                if "workspace_scope" in generation_columns
                else "CASE WHEN g.id IS NULL THEN NULL ELSE 'unknown' END"
            )
            + " AS workspace_scope, "
            + ("g.workspace_id" if "workspace_id" in generation_columns else "NULL")
            + " AS workspace_id, "
            + ("g.workspace_name" if "workspace_name" in generation_columns else "NULL")
            + " AS workspace_name FROM project_task t "
            "LEFT JOIN task_generation tg ON tg.task_id=t.id "
            "LEFT JOIN generation g ON g.id=tg.gen_id WHERE "
            + manual_where_sql
        ).fetchall()
    manual_scopes: dict[str, set[tuple[str, str | None]]] = defaultdict(set)
    manual_with_generation: set[str] = set()
    manual_ids = (
        {
            row["id"]
            for row in conn.execute(
                "SELECT t.id FROM project_task t WHERE " + manual_where_sql
            )
        }
        if "project_task" in tables
        else set()
    )
    for row in manual_rows:
        if row["workspace_scope"] is None:
            continue
        manual_with_generation.add(row["id"])
        scope, workspace_id, _workspace_name = _workspace_snapshot(row)
        manual_scopes[row["id"]].add((scope, workspace_id))

    return {
        "multi_workspace_projects": sum(len(scopes) > 1 for scopes in project_scopes.values()),
        "multi_workspace_folders": sum(len(scopes) > 1 for scopes in folder_scopes.values()),
        "multi_workspace_manual_tasks": sum(len(scopes) > 1 for scopes in manual_scopes.values()),
        "manual_tasks_without_generations": len(manual_ids - manual_with_generation),
    }


def _migrate_task_workspace_snapshots(conn) -> None:
    """기존 작업의 워크스페이스를 근거 생성물로만 확정한다(재실행 안전)."""
    # 자동 폴더 작업의 근거를 한 번에 모은다. 삭제된 생성물도 과거 귀속의 증거이므로 포함한다.
    folder_groups: dict[
        tuple[str, str], dict[tuple[str, str | None], dict[str, Any]]
    ] = defaultdict(dict)
    for row in conn.execute(
        "SELECT project_id, folder_path, workspace_scope, workspace_id, workspace_name, "
        "MAX(COALESCE(NULLIF(created_at, ''), datetime(sort_ts, 'unixepoch'))) AS last_seen "
        "FROM generation WHERE project_id IS NOT NULL "
        "AND folder_path IS NOT NULL AND TRIM(folder_path)<>'' "
        "GROUP BY project_id, folder_path, workspace_scope, workspace_id, workspace_name"
    ):
        scope, workspace_id, workspace_name = _workspace_snapshot(row)
        key = (scope, workspace_id)
        current = folder_groups[(row["project_id"], row["folder_path"])].get(key)
        candidate = {
            "scope": scope,
            "id": workspace_id,
            "name": workspace_name,
            "last_seen": row["last_seen"],
        }
        if current is None or str(candidate["last_seen"] or "") > str(current["last_seen"] or ""):
            folder_groups[(row["project_id"], row["folder_path"])][key] = candidate

    # 수동 작업은 사용자가 명시 연결한 생성물만 근거로 삼는다.
    manual_groups: dict[str, dict[tuple[str, str | None], dict[str, Any]]] = defaultdict(dict)
    for row in conn.execute(
        "SELECT t.id AS task_id, g.workspace_scope, g.workspace_id, g.workspace_name "
        "FROM project_task t JOIN task_generation tg ON tg.task_id=t.id "
        "JOIN generation g ON g.id=tg.gen_id "
        "WHERE COALESCE(t.source_kind, 'manual')='manual'"
    ):
        scope, workspace_id, workspace_name = _workspace_snapshot(row)
        manual_groups[row["task_id"]][(scope, workspace_id)] = {
            "scope": scope,
            "id": workspace_id,
            "name": workspace_name,
        }

    unresolved_sql = unresolved_workspace_sql()
    tasks = conn.execute(
        "SELECT * FROM project_task WHERE " + unresolved_sql + " AND ("
        "COALESCE(workspace_origin, 'unknown')='unknown' OR "
        "LOWER(TRIM(COALESCE(workspace_scope, ''))) <> 'unknown')"
    ).fetchall()
    for task in tasks:
        folder_path = str(task["folder_path"] or "").strip()
        if folder_path and task["source_kind"] == "generation":
            groups = folder_groups.get((task["project_id"], folder_path), {})
        else:
            groups = manual_groups.get(task["id"], {})

        provable = [group for group in groups.values() if group["scope"] != "unknown"]
        if len(groups) == 1 and len(provable) == 1:
            group = provable[0]
            conn.execute(
                "UPDATE project_task SET workspace_scope=?, workspace_id=?, workspace_name=?, "
                "workspace_origin='generation', "
                "source_last_seen_at=COALESCE(?, source_last_seen_at) WHERE id=?",
                (
                    group["scope"], group["id"], group["name"], group.get("last_seen"), task["id"],
                ),
            )
            continue

        # 여러 공간의 자동 작업은 원본 PM 메타를 unknown으로 보존하고, 공간별 파생 행만 만든다.
        if folder_path and task["source_kind"] == "generation" and len(provable) > 0:
            parts = [part for part in folder_path.replace("\\", "/").split("/") if part]
            name = parts[0] if parts else task["name"]
            sequence = parts[1] if len(parts) > 1 else None
            for group in provable:
                conn.execute(
                    "INSERT OR IGNORE INTO project_task("
                    "id, project_id, name, status, sequence, folder_path, source_kind, "
                    "source_last_seen_at, archived, workspace_scope, workspace_id, workspace_name, "
                    "workspace_origin, created_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?)",
                    (
                        uuid.uuid4().hex,
                        task["project_id"],
                        name,
                        "not_started",
                        sequence,
                        folder_path,
                        "generation",
                        group.get("last_seen"),
                        group["scope"],
                        group["id"],
                        group["name"],
                        "generation",
                        task["created_at"],
                    ),
                )


def _ensure_task_workspace_schema_in_transaction(conn, task_columns: set[str]) -> None:
    """project_task 워크스페이스 컬럼·데이터·부분 고유 인덱스를 순서대로 보장한다."""
    added_workspace_columns = "workspace_scope" not in task_columns
    if "workspace_scope" not in task_columns:
        conn.execute(
            "ALTER TABLE project_task ADD COLUMN workspace_scope TEXT NOT NULL DEFAULT 'unknown'"
        )
    for column in ("workspace_id", "workspace_name"):
        if column not in task_columns:
            conn.execute(f"ALTER TABLE project_task ADD COLUMN {column} TEXT")
    added_workspace_origin = "workspace_origin" not in task_columns
    if added_workspace_origin:
        conn.execute(
            "ALTER TABLE project_task ADD COLUMN workspace_origin TEXT NOT NULL DEFAULT 'snapshot'"
        )
    # ALTER로 처음 추가된 구 DB 행은 신규 기본값(snapshot)이 아니라 미확정 이관 대상이다.
    # workspace 컬럼만 먼저 들어간 중간 설치본도 origin 추가 시 빠짐없이 복구한다.
    if added_workspace_columns or added_workspace_origin:
        conn.execute(
            "UPDATE project_task SET workspace_origin='unknown' WHERE workspace_scope='unknown'"
        )

    # 예전 인덱스는 프로젝트 이동 전제라 같은 폴더의 공간별 작업 생성을 막는다.
    conn.execute("DROP INDEX IF EXISTS idx_project_task_folder")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_folder_team "
        "ON project_task(project_id, workspace_id, folder_path) "
        "WHERE folder_path IS NOT NULL AND TRIM(folder_path)<>'' "
        "AND workspace_scope='team' AND workspace_id IS NOT NULL"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_folder_personal "
        "ON project_task(project_id, folder_path) "
        "WHERE folder_path IS NOT NULL AND TRIM(folder_path)<>'' AND workspace_scope='personal'"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_folder_unknown "
        "ON project_task(project_id, folder_path) "
        "WHERE folder_path IS NOT NULL AND TRIM(folder_path)<>'' AND workspace_scope='unknown'"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_task_workspace "
        "ON project_task(workspace_scope, workspace_id, project_id, archived)"
    )
    migrated = conn.execute(
        "SELECT 1 FROM manage_schema_state WHERE key=?",
        (_TASK_WORKSPACE_MIGRATION_KEY,),
    ).fetchone()
    if not migrated:
        # 과거 실행이 컬럼 추가 직후 비정상 종료된 DB는 네 컬럼이 모두 있어 added_*가
        # False여도 기본값 snapshot/unknown이 남을 수 있다. 완료 표식이 없는 경우에만
        # 이런 불완전 행을 다시 이관 대상으로 돌려 다음 실행이 증거 기반으로 복구한다.
        conn.execute(
            "UPDATE project_task SET workspace_origin='unknown' "
            "WHERE workspace_origin='snapshot' AND " + unresolved_workspace_sql()
        )
        # 생성물이 많은 운영 DB에서 이 스캔을 재시작마다 반복하지 않는다. 바깥 래퍼가
        # 컬럼 추가부터 데이터 이관·완료 표식까지 같은 트랜잭션으로 묶는다.
        _migrate_task_workspace_snapshots(conn)
        conn.execute(
            "INSERT OR IGNORE INTO manage_schema_state(key,value) VALUES(?,?)",
            (_TASK_WORKSPACE_MIGRATION_KEY, "complete"),
        )


def _ensure_task_workspace_schema(conn, task_columns: set[str]) -> None:
    """워크스페이스 DDL·데이터 이관·완료 표식을 하나의 원자 작업으로 보장한다."""
    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        _ensure_task_workspace_schema_in_transaction(conn, task_columns)
        if owns_transaction:
            conn.execute("COMMIT")
    except Exception:
        if owns_transaction and conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def _ensure_credit_transaction_identity(conn) -> None:
    """옛 owner 기반 ID 행을 보존하며 안정 계정 키 중복을 원자적으로 병합·차단한다."""
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",
        (_CREDIT_TXN_IDENTITY_INDEX,),
    ).fetchone():
        return

    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute("SAVEPOINT credit_txn_identity_migration")
    try:
        rows = conn.execute(
            "SELECT rowid AS _rowid, id, owner_uid, account_email, created_at, credits, "
            "action, display_name, matched_gen_id, model FROM credit_txn "
            "WHERE account_email IS NOT NULL AND TRIM(account_email)<>'' ORDER BY rowid"
        ).fetchall()
        groups: dict[tuple[Any, ...], list[Any]] = defaultdict(list)
        for row in rows:
            groups[
                (
                    str(row["account_email"]).strip().lower(),
                    row["created_at"],
                    row["credits"],
                    row["action"],
                    row["display_name"],
                )
            ].append(row)

        for duplicates in groups.values():
            if len(duplicates) < 2:
                continue

            def survivor_rank(row: Any) -> tuple[int, int, int, int]:
                owner = str(row["owner_uid"] or "")
                return (
                    int(bool(row["matched_gen_id"])),
                    int(bool(owner) and not owner.startswith("acct:")),
                    int(bool(str(row["model"] or "").strip())),
                    -int(row["_rowid"]),
                )

            survivor = max(duplicates, key=survivor_rank)
            preferred_owner = next(
                (
                    row["owner_uid"]
                    for row in duplicates
                    if row["owner_uid"]
                    and not str(row["owner_uid"]).startswith("acct:")
                ),
                survivor["owner_uid"],
            )
            preferred_model = next(
                (
                    row["model"]
                    for row in duplicates
                    if str(row["model"] or "").strip()
                ),
                survivor["model"],
            )
            conn.execute(
                "UPDATE credit_txn SET owner_uid=?, model=? WHERE id=?",
                (preferred_owner, preferred_model, survivor["id"]),
            )
            for duplicate in duplicates:
                if duplicate["id"] == survivor["id"]:
                    continue
                duplicate_match = duplicate["matched_gen_id"]
                if duplicate_match and duplicate_match != survivor["matched_gen_id"]:
                    # 같은 거래의 중복 행이 다른 생성물까지 과금한 경우, 거래 유래 실제값만 되돌린다.
                    conn.execute(
                        "UPDATE generation_metrics SET real_credits=NULL, credit_source=NULL, matched=0 "
                        "WHERE gen_id=? AND credit_source='transaction'",
                        (duplicate_match,),
                    )
                conn.execute("DELETE FROM credit_txn WHERE id=?", (duplicate["id"],))

        # 이메일은 서버 로그인 계정의 불변 키다. 나머지는 기존 거래 ID의 네 필드와 같으며,
        # BLOB sentinel로 NULL도 서로 같은 값으로 취급해 UNIQUE의 NULL 예외를 막는다.
        conn.execute(
            f"CREATE UNIQUE INDEX {_CREDIT_TXN_IDENTITY_INDEX} ON credit_txn("
            "LOWER(TRIM(account_email)), IFNULL(created_at, X'00'), "
            "IFNULL(credits, X'00'), IFNULL(action, X'00'), IFNULL(display_name, X'00')) "
            "WHERE account_email IS NOT NULL AND TRIM(account_email)<>''"
        )
        if owns_transaction:
            conn.execute("COMMIT")
        else:
            conn.execute("RELEASE credit_txn_identity_migration")
    except Exception:
        if owns_transaction and conn.in_transaction:
            conn.execute("ROLLBACK")
        elif conn.in_transaction:
            conn.execute("ROLLBACK TO credit_txn_identity_migration")
            conn.execute("RELEASE credit_txn_identity_migration")
        raise


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
    # 구 DB에 source_kind 컬럼이 없었거나 기본값(manual)만 채워졌어도 folder_path 자체가
    # 자동 생성 작업의 확정 근거다. 워크스페이스 이관보다 먼저 분류해야 폴더 생성물 근거를
    # 수동 링크로 오인하지 않는다.
    conn.execute(
        "UPDATE project_task SET source_kind='generation' "
        "WHERE folder_path IS NOT NULL AND TRIM(folder_path)<>'' "
        "AND COALESCE(source_kind, 'manual')='manual'"
    )
    _ensure_task_workspace_schema(conn, task_columns)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_task_active "
        "ON project_task(project_id, archived, source_kind)"
    )

    transaction_columns = {row[1] for row in conn.execute("PRAGMA table_info(credit_txn)")}
    if "model" not in transaction_columns:
        conn.execute("ALTER TABLE credit_txn ADD COLUMN model TEXT")
    _ensure_credit_transaction_identity(conn)

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

    account_report_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(account_report_outbox)")
    }
    if "dead_lettered_at" not in account_report_columns:
        conn.execute(
            "ALTER TABLE account_report_outbox ADD COLUMN dead_lettered_at TEXT"
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
