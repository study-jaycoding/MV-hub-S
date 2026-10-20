"""Opt-in B1 transfer protocol: durable trash payload, small main receipt.

No user database is enabled automatically. Activation requires recorded storage
and supported-writer qualification; triggers are not a defence against arbitrary
DDL or file replacement. Each commit below changes exactly one database.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from .. import schema_compat

PROTOCOL = 2


class TransferRecoveryRequired(RuntimeError):
    pass


def register_connection(conn, operation_id="", *, protocol=PROTOCOL):
    conn.create_function("mvhub_write_protocol", 0, lambda: protocol)
    conn.create_function("mvhub_transfer_operation", 0, lambda: operation_id)


def _state(conn):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_protocol'").fetchone():
        return None
    rows = conn.execute("SELECT singleton,state,partner_database_id FROM transfer_protocol").fetchall()
    if len(rows) != 1 or rows[0][0] != 1:
        raise TransferRecoveryRequired("transfer_activation_incomplete")
    return rows[0][1], rows[0][2]


def enabled(conn):
    state = _state(conn)
    if state and state[0] != "enabled":
        raise TransferRecoveryRequired("transfer_activation_incomplete")
    return state is not None


def _guard_sql(table, action, kind):
    quoted = schema_compat._identifier(table)
    pending = ("SELECT 1 FROM generation_transfer WHERE operation_id<>mvhub_transfer_operation()"
               if kind == "content" else
               "SELECT 1 FROM move_operation WHERE phase='prepared' AND operation_id<>mvhub_transfer_operation()")
    name = schema_compat._identifier("transfer_guard_" + table + "_" + action.lower())
    return (f"CREATE TRIGGER {name} BEFORE {action} ON {quoted} "
            f"WHEN mvhub_write_protocol()<{PROTOCOL} OR EXISTS({pending}) "
            "BEGIN SELECT RAISE(ABORT,'transfer_writer_or_pending_guard'); END")


def guard_tables(conn, kind):
    # FTS virtual/shadow tables are derived caches; SQLite forbids virtual-table
    # triggers. Their source rows are guarded, including generation/comment DML.
    tables = [r[1] for r in conn.execute("PRAGMA table_list") if r[0] == "main" and r[2] == "table" and not r[1].startswith("sqlite_")]
    for table in tables:
        for action in ("INSERT", "UPDATE", "DELETE"):
            sql = _guard_sql(table, action, kind)
            conn.execute(sql.replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ", 1))


def verify_guards(conn, kind):
    actual = {r[0]: r[1] for r in conn.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'")}
    for table in (r[1] for r in conn.execute("PRAGMA table_list") if r[0] == "main" and r[2] == "table" and not r[1].startswith("sqlite_")):
        for action in ("INSERT", "UPDATE", "DELETE"):
            name = "transfer_guard_" + table + "_" + action.lower()
            if actual.get(name) != _guard_sql(table, action, kind):
                raise TransferRecoveryRequired("transfer_guard_missing_or_changed")


def configure_connection(conn, kind="content"):
    register_connection(conn, protocol=1)
    if enabled(conn):
        schema_compat.inspect_schema(conn, kind, validate_structure=False)
        conn.execute("PRAGMA synchronous=FULL")
        verify_guards(conn, kind)
        register_connection(conn)


def assert_no_pending(conn):
    if enabled(conn) and conn.execute("SELECT 1 FROM generation_transfer LIMIT 1").fetchone():
        raise TransferRecoveryRequired("transfer_recovery_pending")


def _assert_pair_quiescent(main, other):
    assert_no_pending(main)
    if other.execute("SELECT 1 FROM move_operation WHERE phase='prepared' LIMIT 1").fetchone():
        raise TransferRecoveryRequired("transfer_recovery_pending")


_PROTOCOL_DDL = """CREATE TABLE IF NOT EXISTS transfer_protocol(
singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL,
partner_database_id TEXT NOT NULL, storage_evidence TEXT NOT NULL, writer_evidence TEXT NOT NULL)"""
_MAIN_DDL = """CREATE TABLE IF NOT EXISTS generation_transfer(
operation_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
source_database_id TEXT NOT NULL, target_database_id TEXT NOT NULL,
payload_sha256 TEXT NOT NULL, job_id TEXT)"""
_TRASH_DDL = """CREATE TABLE IF NOT EXISTS move_operation(
operation_id TEXT PRIMARY KEY, direction TEXT NOT NULL, generation_id TEXT NOT NULL,
account_scope_digest TEXT NOT NULL, source_database_id TEXT NOT NULL, target_database_id TEXT NOT NULL,
payload_version INTEGER NOT NULL, payload_json TEXT, payload_sha256 TEXT NOT NULL,
expected_source_fingerprint TEXT NOT NULL, phase TEXT NOT NULL,
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
last_error_code TEXT)"""


def activate(main_path: Path, *, storage_evidence: str, writer_evidence: str, maintenance_gate, flush_pool, ensure_trash_schema):
    """Administrative qualification step, deliberately not a startup default.

    Evidence identifies actual flush/storage and old-binary qualification records;
    nonempty strings alone are not proof. The caller is responsible for those
    checks and excluding external writers. Tests use isolated temporary files.
    """
    if not storage_evidence.strip() or not writer_evidence.strip():
        raise ValueError("transfer_qualification_required")
    main_path = Path(main_path)
    trash_path = main_path.parent / "content_hub_trash.db"
    with maintenance_gate():
        flush_pool()
        schema_compat.inspect_database(main_path, "content")
        if trash_path.exists():
            schema_compat.inspect_database(trash_path, "trash")
        with closing(sqlite3.connect(main_path, isolation_level=None)) as main:
            register_connection(main)
            main.execute("PRAGMA synchronous=FULL")
            main.execute("ATTACH DATABASE ? AS trash", (str(trash_path),))
            ensure_trash_schema(main)
            main.execute("DETACH DATABASE trash")
            with closing(sqlite3.connect(trash_path, isolation_level=None)) as other:
                register_connection(other)
                other.execute("PRAGMA synchronous=FULL")
                main_id = schema_compat.inspect_schema(main, "content").database_id
                trash_id = schema_compat.inspect_schema(other, "trash").database_id
                for conn, kind, partner, ddl in ((main, "content", trash_id, _MAIN_DDL), (other, "trash", main_id, _TRASH_DDL)):
                    conn.execute("BEGIN IMMEDIATE")
                    try:
                        conn.execute(_PROTOCOL_DDL)
                        conn.execute(ddl)
                        if kind == "trash":
                            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS move_operation_active ON move_operation(generation_id) WHERE phase='prepared'")
                        conn.execute("INSERT INTO transfer_protocol VALUES(1,'preparing',?,?,?) ON CONFLICT(singleton) DO UPDATE SET state='preparing',partner_database_id=excluded.partner_database_id,storage_evidence=excluded.storage_evidence,writer_evidence=excluded.writer_evidence", (partner, storage_evidence, writer_evidence))
                        schema_compat.record_baseline_in_transaction(conn, kind + "_transfer")
                        conn.execute("UPDATE schema_meta SET minimum_writer_protocol=2")
                        guard_tables(conn, kind)
                        conn.execute("COMMIT")
                    except BaseException:
                        conn.execute("ROLLBACK")
                        raise
                    checkpoint("activation_" + kind + "_prepared")
                verify_guards(main, "content")
                verify_guards(other, "trash")
                # Main is published LAST. A partial activation never serves B1.
                other.execute("UPDATE transfer_protocol SET state='enabled' WHERE singleton=1")
                main.execute("UPDATE transfer_protocol SET state='enabled' WHERE singleton=1")


def _json(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def validate_pair(main_path, trash_path):
    """Read-only restore admission; B1 content and trash must travel together."""
    from .sqlite_db import read_only_uri
    def read(path):
        path = Path(path)
        journal = Path(str(path) + "-journal")
        if journal.is_file() and journal.stat().st_size:
            raise TransferRecoveryRequired("transfer_backup_recovery_required")
        return closing(sqlite3.connect(read_only_uri(path, immutable=not Path(str(path) + "-wal").exists()), uri=True))
    with read(main_path) as main:
        if not enabled(main):
            if trash_path is not None and Path(trash_path).is_file():
                with read(trash_path) as other:
                    if _state(other) is not None:
                        raise TransferRecoveryRequired("transfer_database_pair_mismatch")
            return
        verify_guards(main, "content")
        if trash_path is None or not Path(trash_path).is_file():
            raise TransferRecoveryRequired("transfer_backup_pair_required")
        with read(trash_path) as other:
            if not enabled(other):
                raise TransferRecoveryRequired("transfer_pair_incomplete")
            verify_guards(other, "trash")
            mid = schema_compat.inspect_schema(main, "content").database_id
            tid = schema_compat.inspect_schema(other, "trash").database_id
            if _state(main)[1] != tid or _state(other)[1] != mid:
                raise TransferRecoveryRequired("transfer_database_pair_mismatch")


def _hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def checkpoint(phase):
    """No-op seam for deterministic process-interruption tests."""


@contextmanager
def connections(main_context, path):
    """Caller owns account pin and main connection; this leaf owns the paired DB."""
    with main_context as main, closing(sqlite3.connect(Path(path).parent / "content_hub_trash.db", isolation_level=None)) as other:
        main.row_factory = other.row_factory = sqlite3.Row
        configure_connection(other, "trash")
        if not enabled(main) or not enabled(other):
            raise TransferRecoveryRequired("transfer_pair_incomplete")
        mid = schema_compat.inspect_schema(main, "content").database_id
        tid = schema_compat.inspect_schema(other, "trash").database_id
        if _state(main)[1] != tid or _state(other)[1] != mid:
            raise TransferRecoveryRequired("transfer_database_pair_mismatch")
        try:
            yield main, other, mid, tid
        finally:
            if main.in_transaction:
                main.execute("ROLLBACK")
            if other.in_transaction:
                other.execute("ROLLBACK")
            register_connection(main)


def _prepare(main, other, mid, tid, direction, gen_id, payload):
    operation_id = str(uuid4())
    register_connection(main, operation_id)
    register_connection(other, operation_id)
    text = _json(payload)
    sha = _hash(text)
    source, target = (mid, tid) if direction == "delete" else (tid, mid)
    account = _hash(str(payload["generation"].get("creator_uid") or ""))
    other.execute("BEGIN IMMEDIATE")
    other.execute("INSERT INTO move_operation(operation_id,direction,generation_id,account_scope_digest,source_database_id,target_database_id,payload_version,payload_json,payload_sha256,expected_source_fingerprint,phase) VALUES(?,?,?,?,?,?,1,?,?,?,'prepared')", (operation_id, direction, gen_id, account, source, target, text, sha, sha))
    other.execute("COMMIT")
    checkpoint("D1" if direction == "delete" else "R0")
    main.execute("INSERT INTO generation_transfer VALUES(?,?,?,?,?,?,?)", (operation_id, gen_id, direction, source, target, sha, payload["generation"].get("job_id")))
    return operation_id


def _finish(main, other, operation_id):
    """Main writer lock serializes finalize/cleanup and backup snapshot barriers."""
    if not main.in_transaction:
        main.execute("BEGIN IMMEDIATE")
    row = other.execute("SELECT * FROM move_operation WHERE operation_id=?", (operation_id,)).fetchone()
    marker = main.execute("SELECT * FROM generation_transfer WHERE operation_id=?", (operation_id,)).fetchone()
    if not row or not marker or any(row[key] != marker[key] for key in ("generation_id", "direction", "source_database_id", "target_database_id", "payload_sha256")):
        raise TransferRecoveryRequired("transfer_receipt_mismatch")
    if row["phase"] == "prepared":
        if row["payload_version"] != 1 or _hash(row["payload_json"] or "") != row["payload_sha256"]:
            raise TransferRecoveryRequired("transfer_payload_invalid")
        p = json.loads(row["payload_json"])
        gen = p["generation"]
        other.execute("BEGIN IMMEDIATE")
        if row["direction"] == "delete":
            if main.execute("SELECT 1 FROM generation WHERE id=?", (row["generation_id"],)).fetchone():
                raise TransferRecoveryRequired("transfer_delete_target_conflict")
            existing = other.execute("SELECT payload FROM trashed WHERE id=?", (gen["id"],)).fetchone()
            if existing and _hash(_json(json.loads(existing[0]))) != row["payload_sha256"]:
                raise TransferRecoveryRequired("transfer_trash_target_conflict")
            other.execute("INSERT OR IGNORE INTO trashed(id,trashed_at,project_id,creator_uid,status,prompt,source_name,job_id,payload) VALUES(?,datetime('now'),?,?,?,?,?,?,?)", (gen["id"],gen.get("project_id"),gen.get("creator_uid"),gen.get("status"),gen.get("prompt"),gen.get("source_name"),gen.get("job_id"),row["payload_json"]))
        else:
            if not main.execute("SELECT 1 FROM generation WHERE id=?", (row["generation_id"],)).fetchone():
                raise TransferRecoveryRequired("transfer_restore_target_missing")
            other.execute("DELETE FROM trashed WHERE id=?", (gen["id"],))
        other.execute("UPDATE move_operation SET phase='completed',updated_at=CURRENT_TIMESTAMP WHERE operation_id=?", (operation_id,))
        other.execute("COMMIT")
        checkpoint("D3" if row["direction"] == "delete" else "R2")
    # Receipt remains; only temporary payload is discarded. Main marker goes last.
    other.execute("UPDATE move_operation SET payload_json=NULL WHERE operation_id=?", (operation_id,))
    main.execute("DELETE FROM generation_transfer WHERE operation_id=?", (operation_id,))
    main.execute("COMMIT")
    checkpoint("D4" if row["direction"] == "delete" else "R3")


def move(gen_id, selector, *, open_connections, payload_port):
    with open_connections() as (main, other, mid, tid):
        telemetry = payload_port.prepare_telemetry(main)
        main.execute("BEGIN IMMEDIATE")
        _assert_pair_quiescent(main, other)
        gen = selector(main)
        if gen is None:
            return False
        payload = payload_port.gather(main, gen_id, gen)
        tomb = payload_port.telemetry_snapshot(main, gen_id, gen) if telemetry else None
        operation_id = _prepare(main, other, mid, tid, "delete", gen_id, payload)
        payload_port.remove_main(main, gen_id, tomb)
        main.execute("COMMIT")
        checkpoint("D2")
        _finish(main, other, operation_id)
        return True


def restore(gen_id, account_uid, *, open_connections, payload_port):
    with open_connections() as (main, other, mid, tid):
        telemetry = payload_port.prepare_telemetry(main)
        main.execute("BEGIN IMMEDIATE")
        _assert_pair_quiescent(main, other)
        row = other.execute("SELECT payload,creator_uid FROM trashed WHERE id=?", (gen_id,)).fetchone()
        if row is None:
            return False
        if account_uid is not None and row["creator_uid"] not in payload_port.account_aliases(main, account_uid):
            raise PermissionError("본인 휴지통 항목만 복구할 수 있습니다")
        if main.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            raise TransferRecoveryRequired("transfer_restore_target_conflict")
        payload = json.loads(row["payload"])
        operation_id = _prepare(main, other, mid, tid, "restore", gen_id, payload)
        payload_port.restore_payload(main, gen_id, payload, telemetry)
        main.execute("COMMIT")
        checkpoint("R1")
        _finish(main, other, operation_id)
        return True


def reconcile(open_connections):
    """Do not infer success from row existence alone: require matching receipts."""
    repaired = 0
    with open_connections() as (main, other, mid, tid):
        rows = other.execute("SELECT * FROM move_operation WHERE phase='prepared' OR operation_id IN (SELECT operation_id FROM move_operation WHERE payload_json IS NOT NULL)").fetchall()
        # Completed receipt with a pending main marker can have cleared payload.
        ids = {r["operation_id"] for r in rows}
        for marker in main.execute("SELECT operation_id FROM generation_transfer").fetchall():
            if marker[0] not in ids:
                row = other.execute("SELECT * FROM move_operation WHERE operation_id=?", (marker[0],)).fetchone()
                if row is None:
                    raise TransferRecoveryRequired("transfer_journal_missing")
                rows.append(row)
        for row in rows:
            operation_id = row["operation_id"]
            register_connection(main, operation_id)
            register_connection(other, operation_id)
            expected = (mid, tid) if row["direction"] == "delete" else (tid, mid)
            if (row["source_database_id"], row["target_database_id"]) != expected:
                raise TransferRecoveryRequired("transfer_database_pair_mismatch")
            main.execute("BEGIN IMMEDIATE")
            # Another finisher may have completed after the initial scan.
            row = other.execute("SELECT * FROM move_operation WHERE operation_id=?", (operation_id,)).fetchone()
            marker = main.execute("SELECT 1 FROM generation_transfer WHERE operation_id=?", (operation_id,)).fetchone()
            if not marker and row["phase"] in ("completed", "canceled") and row["payload_json"] is None:
                main.execute("COMMIT")
                continue
            if marker:
                _finish(main, other, operation_id)
            else:
                # D1/R0 alone never authorized source removal. Cancel, preserve it.
                source = main if row["direction"] == "delete" else other
                table = "generation" if row["direction"] == "delete" else "trashed"
                if not source.execute(f"SELECT 1 FROM {table} WHERE id=?", (row["generation_id"],)).fetchone():
                    raise TransferRecoveryRequired("transfer_uncommitted_source_missing")
                other.execute("UPDATE move_operation SET phase='canceled',payload_json=NULL,updated_at=CURRENT_TIMESTAMP WHERE operation_id=?", (operation_id,))
                main.execute("COMMIT")
            repaired += 1
    return repaired
