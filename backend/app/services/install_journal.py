"""Durable install intent and conservative recovery decisions; no app/DB imports."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
import uuid
from datetime import datetime, timezone

PHASES = ("prepare", "verified", "draining", "quiesced", "checkpointed", "activation_pending", "starting", "ready", "committed")
TERMINAL = {"committed", "rolled_back"}


def atomic_json(path: Path, value: dict) -> None:
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with temporary.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows refuses to replace a file another process is reading; the server reads control/journal per request.
        for attempt in range(40):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.05)
    finally:
        temporary.unlink(missing_ok=True)


def _as_stored(value: dict) -> dict:
    # The next advance() compares with disk; tuples (e.g. checkpoint components) must already be lists.
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def read_journal(path: Path) -> dict:
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("journal_too_large")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if (not isinstance(value, dict) or value.get("format_version") != 1 or not value.get("run_id") or
            value.get("phase") not in {*PHASES, "recovery_required", "rolled_back", "failed"}):
        raise ValueError("journal_invalid")
    return value


def new_journal(path: Path, *, role: str, previous: dict, target: dict) -> dict:
    if path.exists() and read_journal(path)["phase"] not in TERMINAL:
        raise ValueError("unfinished_install_requires_recovery")
    value = _as_stored({"format_version": 1, "run_id": uuid.uuid4().hex, "role": role, "phase": "prepare",
                        "previous": previous, "target": target, "execution_nonce": uuid.uuid4().hex,
                        "db_mutation_possible": False, "business_writes_possible": False,
                        "components": [], "checkpoints": [], "updated_at": datetime.now(timezone.utc).isoformat()})
    atomic_json(path, value)
    return value


def advance(path: Path, value: dict, phase: str, **changes) -> dict:
    current = read_journal(path)
    if current != value:
        raise ValueError("journal_changed")
    old = value["phase"]
    if old in TERMINAL:
        raise ValueError("journal_terminal")
    if phase not in {"failed", "recovery_required", "rolled_back"}:
        if old not in PHASES or phase not in PHASES or PHASES.index(phase) != PHASES.index(old) + 1:
            raise ValueError("journal_transition_invalid")
    updated = _as_stored({**value, **changes, "phase": phase, "updated_at": datetime.now(timezone.utc).isoformat()})
    for flag in ("db_mutation_possible", "business_writes_possible"):
        if type(updated[flag]) is not bool or value[flag] and not updated[flag]:
            raise ValueError("journal_mutation_flags_are_monotonic")
    if phase in {"starting", "ready", "committed"} and not updated["db_mutation_possible"]:
        raise ValueError("startup_can_mutate_database")
    if phase == "committed" and not updated["business_writes_possible"]:
        raise ValueError("business_admission_not_recorded")
    atomic_json(path, updated)
    return updated


def rollback_decision(journal: dict, inspections: list[dict], previous_compatibility: dict | None) -> str:
    """Program-only rollback never restores DB bytes after potential new writes."""
    if not journal.get("db_mutation_possible"):
        return "program_only"
    if not previous_compatibility or not inspections:
        return "recovery_required"
    schema = previous_compatibility.get("db_schema", {})
    expected = {(row.get('key'), row.get("database_id")) for row in journal.get("checkpoints", [])}
    actual = {(row.get('key'), row.get("database_id")) for row in inspections}
    if (not expected or any(not key or not identity for key, identity in expected) or expected != actual or
            len(expected) != len(journal.get('checkpoints', [])) or len(actual) != len(inspections)):
        return "recovery_required"
    try:
        for row in inspections:
            if (row.get("status") != "compatible" or
                    not schema["read_min"] <= row["schema_version"] <= schema["read_max"] or
                    not schema["write_min"] <= row["schema_version"] <= schema["write_max"] or
                    row["minimum_reader_protocol"] > previous_compatibility["reader_protocol"] or
                    row["minimum_writer_protocol"] > previous_compatibility["writer_protocol"] or
                    not set(row.get("components", ())).issubset(previous_compatibility.get("supported_components", ()))):
                return "recovery_required"
    except (KeyError, TypeError):
        return "recovery_required"
    return "program_only"


def resume_action(journal: dict) -> str:
    phase = journal["phase"]
    if phase in TERMINAL:
        return "done"
    if phase in {"prepare", "verified", "draining"} and not journal.get("db_mutation_possible"):
        return "abort_preparation"
    if phase in {"quiesced", "checkpointed", "activation_pending"} and not journal.get("db_mutation_possible"):
        return "restore_previous_program"
    return "inspect_before_recovery"
