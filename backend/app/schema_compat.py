"""Shared SQLite compatibility inspection and baseline recording.

Inspection executes reads only. An unversioned, recognizable partial database is
eligible for the existing legacy migrator, NOT certified as a current baseline.
Recording validates the boundary signature below after that migrator succeeds;
it does not run migrations or make their earlier commits atomic. These signatures
are intentionally versioned minimum contracts, not whole-schema fingerprints.
The optional PM component lives in content, never in manage_hub.db.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import tempfile
from types import MappingProxyType
from uuid import UUID, uuid4


READER_PROTOCOL = 1
WRITER_PROTOCOL = 2
SCHEMA_VERSION = 2
SCHEMA_VERSIONS = {"content": 2, "manage": 1, "trash": 1}


def _local_database_path(path: Path) -> None:
    if not path.is_absolute() or str(path).startswith('\\\\'):
        raise ValueError('database_path_must_be_local_absolute')
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or (ancestor.exists() and getattr(ancestor.stat(), 'st_file_attributes', 0) & 1024):
            raise ValueError('database_link_forbidden')


def database_key(path: Path) -> str:
    """Stable path fingerprint shared by startup diagnostics and install checkpoints."""
    return hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()


def database_paths(root: Path, env: dict[str, str]) -> list[tuple[str, Path]]:
    """기동 준비와 설치 검사가 공유하는 기존 DB 세트. 없는 DB는 만들지 않는다."""
    data = Path(env.get("CONTENT_HUB_DATA") or root / "backend/data").expanduser()
    primary = Path(env.get("CONTENT_HUB_DB") or data / "db/content_hub.db").expanduser()
    _local_database_path(data)
    _local_database_path(primary)
    content = {primary, data / "db/content_hub.db", root / "backend/content_hub.db", *(data / "db/acct").glob("*/content_hub.db")}
    rows = [("content", path) for path in content]
    rows += [("trash", path.with_name("content_hub_trash.db")) for path in content]
    rows.append(("manage", data / "db/manage_hub.db"))
    for _, path in rows:
        _local_database_path(path)
    return sorted(((kind, path.resolve()) for kind, path in rows if path.is_file()), key=lambda row: str(row[1]))


_SHARE_REVISION_COLUMNS = ("is_final", "is_held", "final_by", "final_at", "held_before_final",
                           "project_id", "workspace_scope", "workspace_id", "creator_uid", "deleted_at", "status")
SHARE_REVISION_TRIGGERS = {
    **{f"share_revision_{event.lower()}": f"CREATE TRIGGER share_revision_{event.lower()} AFTER {event} ON share BEGIN UPDATE generation SET share_revision=share_revision+1 WHERE id={ref}.generation_id; END"
       for event, ref in (("INSERT", "NEW"), ("DELETE", "OLD"))},
    "share_revision_share_update": "CREATE TRIGGER share_revision_share_update AFTER UPDATE ON share WHEN OLD.generation_id IS NOT NEW.generation_id OR OLD.visibility IS NOT NEW.visibility OR OLD.shared_by IS NOT NEW.shared_by BEGIN UPDATE generation SET share_revision=share_revision+1 WHERE id IN (OLD.generation_id,NEW.generation_id); END",
    "share_revision_generation_insert": "CREATE TRIGGER share_revision_generation_insert AFTER INSERT ON generation BEGIN UPDATE generation SET share_revision=NEW.share_revision+1 WHERE id=NEW.id; END",
    "share_revision_generation": "CREATE TRIGGER share_revision_generation AFTER UPDATE OF " + ",".join(_SHARE_REVISION_COLUMNS) + " ON generation WHEN " + " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in _SHARE_REVISION_COLUMNS) + " BEGIN UPDATE generation SET share_revision=OLD.share_revision+1 WHERE id=NEW.id; END",
}


class SchemaCompatibilityError(ValueError):
    """Stable reason code; never include user data or a database path."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class Baseline:
    kind: str
    migration_id: str
    tables: tuple[tuple[str, tuple[str, ...]], ...]
    # name, table, ordered key columns, unique, partial predicate
    indexes: tuple[tuple[str, str, tuple[str, ...], bool, str], ...] = ()
    primary_keys: tuple[tuple[str, tuple[str, ...]], ...] = ()
    unique_keys: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @property
    def checksum(self) -> str:
        payload = (self.kind, self.migration_id, self.tables, self.indexes, self.primary_keys, self.unique_keys)
        return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


BASELINES = MappingProxyType({
    "content_asset_destination": Baseline("content", "content_asset_destination.v1", (
        ("asset_destination_outbox", ("sync_id", "asset_content_id", "local_location_id",
         "owner_uid", "account_key", "server_origin", "project_name", "project_id",
         "destination_kind", "root_path", "relative_dir", "original_name", "target_name",
         "state", "attempts", "next_retry_at", "lease_token", "lease_until", "last_error_code", "updated_at")),
    ), primary_keys=(("asset_destination_outbox", ("sync_id",)),), unique_keys=(
        ("asset_destination_outbox", ("account_key", "owner_uid", "server_origin", "project_name", "project_id", "destination_kind", "root_path", "relative_dir", "asset_content_id", "original_name")),
    )),
    "content_asset_sync": Baseline("content", "content_asset_sync.v1", (
        ("asset_blob", ("asset_content_id", "sha256", "bytes", "media_type")),
        ("asset_location", ("location_id", "asset_content_id", "owner_uid", "project_id", "storage_id", "root_revision", "kind", "path", "state")),
        ("asset_sync_outbox", ("sync_id", "asset_content_id", "local_location_id", "owner_uid", "project_id", "account_key", "server_origin", "storage_id", "root_revision", "state", "lease_token", "lease_until", "receipt_json")),
        ("asset_owner_folder", ("project_id", "root_revision", "owner_uid", "folder_label", "folder_cf")),
        ("asset_location_alias", ("alias_id", "location_id")),
        ("asset_upload_token", ("token", "asset_content_id", "owner_uid", "project_id", "storage_id", "root_revision", "bytes", "media_type", "expires_at")),
        ("reference", ("id", "asset_content_id")),
        ("asset", ("id", "asset_content_id")),
        ("gen_reference", ("generation_id", "reference_id", "position")),
        ("project", ("id", "asset_root_path")),
    ), primary_keys=(
        ("asset_blob", ("asset_content_id",)), ("asset_location", ("location_id",)),
        ("asset_sync_outbox", ("sync_id",)), ("asset_owner_folder", ("project_id", "root_revision", "owner_uid")),
        ("asset_location_alias", ("alias_id",)), ("asset_upload_token", ("token",)),
    ), unique_keys=(
        ("asset_blob", ("sha256",)),
        ("asset_location", ("storage_id", "root_revision", "project_id", "owner_uid", "asset_content_id", "kind")),
        ("asset_sync_outbox", ("asset_content_id", "owner_uid", "project_id", "server_origin")),
        ("asset_owner_folder", ("project_id", "root_revision", "folder_cf")),
    )),
    "content_share_commands": Baseline("content", "content_share_commands.v2", (
        ("generation", ("id", "share_revision")),
        ("share_command_receipt", ("actor_id", "workspace_scope", "operation_id", "request_hash", "target_id", "command_kind", "result_json")),
        ("share_state_intent", ("remote_command_json", "remote_result_json")),
    ), primary_keys=(("share_command_receipt", ("actor_id", "operation_id")),)),
    "content_transfer": Baseline("content", "content_transfer.b1.v1", (
        ("generation_transfer", ("operation_id", "generation_id", "direction", "source_database_id", "target_database_id", "payload_sha256", "job_id")),
        ("transfer_protocol", ("singleton", "state", "partner_database_id", "storage_evidence", "writer_evidence")),
    ), primary_keys=(("generation_transfer", ("operation_id",)),)),
    "trash_transfer": Baseline("trash", "trash_transfer.b1.v1", (
        ("move_operation", ("operation_id", "direction", "generation_id", "payload_json", "payload_sha256", "phase", "source_database_id", "target_database_id")),
        ("transfer_protocol", ("singleton", "state", "partner_database_id", "storage_evidence", "writer_evidence")),
    ), primary_keys=(("move_operation", ("operation_id",)),)),
    "content_core": Baseline("content", "content_core.baseline.v1", (
        ("generation", ("id", "worker_id", "status", "job_id", "creator_uid", "workspace_scope", "is_final", "is_held")),
        ("asset", ("id", "generation_id", "type", "file_path")),
        ("gen_request", ("id", "account_email", "gen_id", "status", "idempotency_key", "canvas_attempt_id", "submission_fingerprint")),
        ("share_state_intent", ("intent_id", "intent_seq", "claim_token", "status", "server_origin", "desired_held")),
        ("account", ("email", "creator_uid")),
        ("project", ("id", "name", "workspace_scope")),
    ), (
        ("idx_genrequest_idempotency", "gen_request", ("account_email", "idempotency_key"), True, "idempotency_key IS NOT NULL"),
        ("idx_genrequest_canvas_attempt", "gen_request", ("account_email", "canvas_attempt_id"), True, "canvas_attempt_id IS NOT NULL"),
    ), (("generation", ("id",)), ("asset", ("id",)), ("gen_request", ("id",)), ("share_state_intent", ("intent_id",)), ("account", ("email",)), ("project", ("id",)))),
    "content_pm": Baseline("content", "content_pm.baseline.v1", (
        ("generation_metrics", ("gen_id", "requested_at", "completed_at")),
        ("project_task", ("id", "workspace_scope", "workspace_id")),
        ("telemetry_outbox", ("local_gen_id", "dirty_rev", "is_tombstone")),
        ("account_report_outbox", ("report_key", "dead_lettered_at")),
    ), primary_keys=(("generation_metrics", ("gen_id",)), ("telemetry_outbox", ("local_gen_id",)), ("account_report_outbox", ("report_key",)))),
    "trash": Baseline("trash", "trash.baseline.v1", (
        ("trashed", ("id", "trashed_at", "creator_uid", "job_id", "payload")),
    ), (("idx_trashed_job", "trashed", ("job_id",), False, ""),), (("trashed", ("id",)),)),
    "manage": Baseline("manage", "manage.baseline.v1", (
        ("team_generation_fact", ("id", "account_email", "local_gen_id", "workspace_scope", "workspace_id", "result_bytes", "result_head_sha")),
    ), primary_keys=(("team_generation_fact", ("id",)),), unique_keys=(("team_generation_fact", ("account_email", "local_gen_id")),)),
})

_ROOT_COMPONENT = {"content": "content_core", "trash": "trash", "manage": "manage"}
_META_COLUMNS = {"singleton", "database_kind", "database_id", "schema_version", "minimum_reader_protocol", "minimum_writer_protocol"}
_LEDGER_COLUMNS = {"migration_id", "checksum", "applied_at"}
_LEGACY_CONTENT_TABLES = {
    "generation", "asset", "worker", "gen_request", "scene_card_generation",
    "asset_comment", "generation_comment", "lineage", "history", "app_setting",
    "account", "project", "share", "share_state_intent", "generation_metrics", "project_task",
}


@dataclass(frozen=True)
class SchemaInspection:
    status: str
    database_kind: str
    database_id: str | None = None
    schema_version: int = 0
    components: tuple[str, ...] = ()
    minimum_reader_protocol: int = 0
    minimum_writer_protocol: int = 0


def _identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", value):
        raise ValueError("invalid_schema_identifier")
    return '"' + value + '"'


def _tables(conn: sqlite3.Connection, schema: str) -> set[str]:
    return {r[0] for r in conn.execute(f"SELECT name FROM {_identifier(schema)}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def _columns(conn: sqlite3.Connection, schema: str, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA {_identifier(schema)}.table_info({_identifier(table)})")}


def _version(value: object) -> int:
    if not isinstance(value, int) or value < 1:
        raise SchemaCompatibilityError("invalid_metadata")
    return value


def inspect_schema(conn: sqlite3.Connection, expected_kind: str, *, schema: str = "main", validate_structure: bool = True) -> SchemaInspection:
    """Read only; accepts known partial legacy fixtures without certifying them.

    Unknown-only databases and a recognizable different database kind are rejected.
    Extra legacy tables/columns are not rejected: existing migrators own that path.
    """
    if expected_kind not in _ROOT_COMPONENT:
        raise ValueError("invalid_database_kind")
    prefix = _identifier(schema)
    metadata_tables = {r[0] for r in conn.execute(f"SELECT name FROM {prefix}.sqlite_master WHERE type='table' AND name IN ('schema_meta','schema_migrations')")}
    has_meta, has_ledger = "schema_meta" in metadata_tables, "schema_migrations" in metadata_tables
    if has_meta != has_ledger:
        raise SchemaCompatibilityError("partial_ledger")
    user_version = conn.execute(f"PRAGMA {prefix}.user_version").fetchone()[0]
    if not has_meta:
        tables = _tables(conn, schema)
        if user_version != 0:
            raise SchemaCompatibilityError("unknown_legacy_version")
        kinds = set()
        if tables & _LEGACY_CONTENT_TABLES:
            kinds.add("content")
        if "trashed" in tables:
            kinds.add("trash")
        if "team_generation_fact" in tables:
            kinds.add("manage")
        if kinds and kinds != {expected_kind}:
            raise SchemaCompatibilityError("database_kind_mismatch")
        if tables and not kinds:
            raise SchemaCompatibilityError("unrecognized_legacy_schema")
        return SchemaInspection("unversioned", expected_kind)
    if not _META_COLUMNS <= _columns(conn, schema, "schema_meta") or not _LEDGER_COLUMNS <= _columns(conn, schema, "schema_migrations"):
        raise SchemaCompatibilityError("partial_ledger")
    rows = conn.execute(f"SELECT singleton,database_kind,database_id,schema_version,minimum_reader_protocol,minimum_writer_protocol FROM {prefix}.schema_meta").fetchall()
    if len(rows) != 1 or rows[0][0] != 1:
        raise SchemaCompatibilityError("invalid_metadata")
    _, kind, database_id, version, reader, writer = rows[0]
    if kind != expected_kind:
        raise SchemaCompatibilityError("database_kind_mismatch")
    try:
        UUID(database_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise SchemaCompatibilityError("invalid_metadata") from exc
    if _version(reader) > READER_PROTOCOL or _version(writer) > WRITER_PROTOCOL or _version(version) > SCHEMA_VERSIONS[expected_kind]:
        raise SchemaCompatibilityError("future_schema")
    if user_version != version:
        raise SchemaCompatibilityError("version_mismatch")
    known = {b.migration_id: (name, b) for name, b in BASELINES.items() if b.kind == kind}
    components = []
    for migration_id, checksum, applied_at in conn.execute(f"SELECT migration_id,checksum,applied_at FROM {prefix}.schema_migrations"):
        if migration_id not in known:
            raise SchemaCompatibilityError("unknown_migration")
        name, baseline = known[migration_id]
        if checksum != baseline.checksum:
            raise SchemaCompatibilityError("checksum_mismatch")
        if not isinstance(applied_at, str) or not applied_at.strip() or name in components:
            raise SchemaCompatibilityError("partial_ledger")
        components.append(name)
    if _ROOT_COMPONENT[kind] not in components:
        raise SchemaCompatibilityError("partial_ledger")
    if kind == "content" and ((version == 2) != ("content_share_commands" in components)):
        raise SchemaCompatibilityError("partial_ledger")
    if validate_structure:
        for name in components:
            validate_baseline(conn, name, schema=schema)
        if "content_share_commands" in components:
            triggers = dict(conn.execute(f"SELECT name,sql FROM {prefix}.sqlite_master WHERE type='trigger'"))
            for name, expected in SHARE_REVISION_TRIGGERS.items():
                normalize = lambda sql: " ".join((sql or "").split()).lower()
                if normalize(triggers.get(name)) != normalize(expected):
                    raise SchemaCompatibilityError("share_revision_guard_mismatch")
    return SchemaInspection("compatible", kind, database_id, version, tuple(sorted(components)), reader, writer)


def inspect_database(path: Path, expected_kind: str) -> SchemaInspection:
    """Never create a missing file or run recovery/migrations on an input file.

    WAL-backed inputs are read with WAL visibility; only standalone files use
    immutable mode. No guarantee is made about SQLite's shared-memory bookkeeping.
    """
    path = Path(path)
    # Never let inspection recover the source. SQLite recovers an independently
    # copied hot rollback journal first; only its recovered schema is admitted.
    journal = Path(str(path) + "-journal")
    if journal.exists() and journal.stat().st_size:
        return _inspect_recovered_copy(path, expected_kind)
    uri = path.absolute().as_uri()
    if not uri.startswith("file:///"):
        uri = "file:////" + uri[len("file://"):]
    uri += "?mode=ro"
    if not Path(str(path) + "-wal").exists():
        uri += "&immutable=1"
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        conn.execute("BEGIN")  # one consistent read snapshot across metadata queries
        return inspect_schema(conn, expected_kind)


def _recovery_signature(path: Path) -> tuple:
    result = []
    for suffix in ("", "-journal", "-wal"):
        item = Path(str(path) + suffix)
        if item.exists():
            with item.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            stat = item.stat()
            result.append((suffix, stat.st_size, stat.st_mtime_ns, digest))
    return tuple(result)


def _inspect_recovered_copy(path: Path, expected_kind: str) -> SchemaInspection:
    """Recover only a stable single-DB rollback snapshot, never the original.

    Startup/restore callers still own their normal maintenance exclusion. A
    concurrent source change fails admission, rather than retrying a moving DB.
    Super-journals require a complete multi-file recovery and are not guessed.
    """
    with tempfile.TemporaryDirectory(prefix="mvhub-schema-recovery-") as folder:
        return _recover_database_copy(path, expected_kind, Path(folder) / "recovery.db")


def _recover_database_copy(path: Path, expected_kind: str, copy: Path) -> SchemaInspection:
    """Recover a private copy under the same admission rules as inspection."""
    journal = Path(str(path) + "-journal")
    magic = b"\xd9\xd5\x05\xf9\x20\xa1\x63\xd7"
    with journal.open("rb") as handle:
        header = handle.read(8)
        handle.seek(-8, 2) if journal.stat().st_size >= 8 else None
        footer = handle.read(8)
    if header not in (magic, bytes(8)) or (footer == magic and journal.stat().st_size > 512):
        raise SchemaCompatibilityError("rollback_journal_requires_recovery")
    if Path(str(path) + "-wal").exists():
        raise SchemaCompatibilityError("mixed_recovery_journals")
    before = _recovery_signature(path)
    with copy.open('xb'):
        pass
    shutil.copyfile(path, copy)
    shutil.copyfile(journal, Path(str(copy) + "-journal"))
    if _recovery_signature(path) != before:
        raise SchemaCompatibilityError("recovery_source_changed")
    with closing(sqlite3.connect(copy)) as conn:
        # The first read invokes SQLite's own rollback recovery on the copy.
        result = inspect_schema(conn, expected_kind)
        if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise SchemaCompatibilityError("recovery_integrity_failed")
    if _recovery_signature(path) != before:
        raise SchemaCompatibilityError("recovery_source_changed")
    return result


def recover_compatible_database(path: Path, expected_kind: str) -> None:
    """Caller MUST hold maintenance exclusion; recover only an admitted snapshot.

    This is SQLite crash recovery, not a file replacement. External unsupported
    writers are outside the in-process gate and must be stopped by the operator.
    """
    before = _recovery_signature(path)
    inspect_database(path, expected_kind)
    if _recovery_signature(path) != before:
        raise SchemaCompatibilityError("recovery_source_changed")
    with closing(sqlite3.connect(path)) as conn:
        inspect_schema(conn, expected_kind)
        if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise SchemaCompatibilityError("recovery_integrity_failed")


def validate_baseline(conn: sqlite3.Connection, component: str, *, schema: str = "main") -> None:
    """Validate fixed required columns and critical index semantics, without DDL."""
    baseline = BASELINES[component]
    prefix = _identifier(schema)
    for table, columns in baseline.tables:
        if not set(columns) <= _columns(conn, schema, table):
            raise SchemaCompatibilityError("baseline_structure_mismatch")
    for table, expected in baseline.primary_keys:
        rows = conn.execute(f"PRAGMA {prefix}.table_info({_identifier(table)})").fetchall()
        actual = tuple(r[1] for r in sorted(rows, key=lambda r: r[5]) if r[5])
        if actual != expected:
            raise SchemaCompatibilityError("baseline_structure_mismatch")
    for table, expected in baseline.unique_keys:
        candidates = []
        for item in conn.execute(f"PRAGMA {prefix}.index_list({_identifier(table)})"):
            if item[2] and not item[4]:
                candidates.append(tuple(r[2] for r in conn.execute(f"PRAGMA {prefix}.index_info({_identifier(item[1])})")))
        if expected not in candidates:
            raise SchemaCompatibilityError("baseline_structure_mismatch")
    for name, table, columns, unique, predicate in baseline.indexes:
        listed = {r[1]: r for r in conn.execute(f"PRAGMA {prefix}.index_list({_identifier(table)})")}
        item = listed.get(name)
        if item is None or bool(item[2]) != unique or bool(item[4]) != bool(predicate):
            raise SchemaCompatibilityError("baseline_structure_mismatch")
        actual = tuple(r[2] for r in conn.execute(f"PRAGMA {prefix}.index_info({_identifier(name)})"))
        row = conn.execute(f"SELECT sql FROM {prefix}.sqlite_master WHERE type='index' AND name=?", (name,)).fetchone()
        sql = row[0] or ""
        actual_predicate = re.split(r"\bWHERE\b", sql, flags=re.IGNORECASE)[-1] if predicate else ""
        normalize = lambda s: " ".join(s.strip().rstrip(";").lower().split())
        if actual != columns or normalize(actual_predicate) != normalize(predicate):
            raise SchemaCompatibilityError("baseline_structure_mismatch")


def record_baseline(conn: sqlite3.Connection, component: str, *, schema: str = "main") -> SchemaInspection:
    """Own one metadata transaction. Call only AFTER legacy migrations succeed.

    Does not enable trash B1, add writer guards, change synchronous mode or claim
    cross-database atomicity. Rejects caller transactions rather than committing
    them. Attached-schema recording writes only the requested schema.
    """
    if conn.in_transaction:
        raise SchemaCompatibilityError("active_transaction")
    conn.execute("BEGIN IMMEDIATE")
    try:
        result = _record_baseline_on_connection(conn, component, schema=schema)
        conn.execute("COMMIT")
        return result
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def record_baseline_in_transaction(conn: sqlite3.Connection, component: str, *, schema: str = "main") -> SchemaInspection:
    """Explicitly join a caller's migration transaction, without committing it.

    Used by lazy PM/trash migrators that already support caller-owned transactions.
    The returned metadata is pending until the caller commits. Failure rolls back
    only this savepoint; the existing caller rollback policy remains in charge.
    """
    if not conn.in_transaction:
        raise SchemaCompatibilityError("transaction_required")
    conn.execute("SAVEPOINT schema_baseline_record")
    try:
        result = _record_baseline_on_connection(conn, component, schema=schema)
        conn.execute("RELEASE schema_baseline_record")
        return result
    except BaseException:
        conn.execute("ROLLBACK TO schema_baseline_record")
        conn.execute("RELEASE schema_baseline_record")
        raise


def _record_baseline_on_connection(conn: sqlite3.Connection, component: str, *, schema: str) -> SchemaInspection:
    baseline = BASELINES[component]
    prefix = _identifier(schema)
    existing = inspect_schema(conn, baseline.kind, schema=schema)
    validate_baseline(conn, component, schema=schema)
    if component == "content_pm" and "content_core" not in existing.components:
        raise SchemaCompatibilityError("core_baseline_required")
    if component in existing.components:
        return existing
    if existing.status == "unversioned":
        conn.execute(f"CREATE TABLE {prefix}.schema_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_kind TEXT NOT NULL, database_id TEXT NOT NULL, schema_version INTEGER NOT NULL, minimum_reader_protocol INTEGER NOT NULL, minimum_writer_protocol INTEGER NOT NULL)")
        conn.execute(f"CREATE TABLE {prefix}.schema_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)")
        conn.execute(f"INSERT INTO {prefix}.schema_meta VALUES(1,?,?,?,?,?)", (baseline.kind, str(uuid4()), 1, READER_PROTOCOL, 1))
    conn.execute(f"INSERT INTO {prefix}.schema_migrations VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", (baseline.migration_id, baseline.checksum))
    version = 2 if component == "content_share_commands" else (existing.schema_version or 1)
    conn.execute(f"UPDATE {prefix}.schema_meta SET schema_version=?", (version,))
    conn.execute(f"PRAGMA {prefix}.user_version={version}")
    return inspect_schema(conn, baseline.kind, schema=schema)
