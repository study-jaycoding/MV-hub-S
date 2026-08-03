"""SQLite 백업 복원 훈련.

운영 DB를 교체하지 않고 별도 파일에 실제 복원한 뒤 무결성·FK·스키마·행 수를 확인한다.
"""

from __future__ import annotations

import hashlib
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .sqlite_db import validate_hub_db

_REQUIRED_TABLES = {"generation", "worker", "account", "project", "share"}


def create_sqlite_snapshot(source: Path, destination: Path) -> Path:
    """WAL을 포함한 일관 SQLite 스냅샷을 새 파일로 만든다. 기존 파일은 덮어쓰지 않는다."""
    source = source.resolve()
    destination = destination.resolve()
    if source == destination:
        raise ValueError("원본과 백업 경로가 같습니다")
    if not source.is_file():
        raise FileNotFoundError(source)
    if destination.exists():
        raise FileExistsError(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(str(source))) as src:
        with closing(sqlite3.connect(str(destination))) as dst:
            src.backup(dst)
    return destination


def _tables(conn: sqlite3.Connection) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]


def _table_counts(conn: sqlite3.Connection, tables: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0])
    return counts


def _schema_digest(conn: sqlite3.Connection) -> str:
    rows = conn.execute(
        "SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall()
    payload = "\n".join("|".join(str(v) for v in row) for row in rows)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _inspect(path: Path) -> dict[str, Any]:
    validate_hub_db(path, require_integrity=True)
    with closing(sqlite3.connect(str(path))) as conn:
        tables = _tables(conn)
        missing = sorted(_REQUIRED_TABLES - set(tables))
        if missing:
            raise ValueError(f"필수 테이블 누락: {', '.join(missing)}")
        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk_errors:
            raise ValueError(f"외래키 무결성 오류: {len(fk_errors)}건")
        integrity = conn.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError("SQLite integrity_check 실패")
        return {
            "tables": tables,
            "table_counts": _table_counts(conn, tables),
            "schema_sha256": _schema_digest(conn),
            "user_version": int(conn.execute("PRAGMA user_version").fetchone()[0]),
        }


def verify_restore_drill(backup_path: Path, restored_path: Path) -> dict[str, Any]:
    """backup_path를 restored_path에 실제 복원하고 원본 백업과 동일한지 검증한다."""
    backup_path = backup_path.resolve()
    restored_path = restored_path.resolve()
    source_info = _inspect(backup_path)
    create_sqlite_snapshot(backup_path, restored_path)
    restored_info = _inspect(restored_path)
    if source_info["schema_sha256"] != restored_info["schema_sha256"]:
        raise ValueError("복원 전후 스키마가 다릅니다")
    if source_info["table_counts"] != restored_info["table_counts"]:
        raise ValueError("복원 전후 테이블 행 수가 다릅니다")
    return {
        "ok": True,
        "backup": str(backup_path),
        "restored": str(restored_path),
        "backup_bytes": backup_path.stat().st_size,
        "restored_bytes": restored_path.stat().st_size,
        "table_count": len(source_info["tables"]),
        "generation_count": source_info["table_counts"].get("generation", 0),
        "schema_sha256": source_info["schema_sha256"],
        "user_version": source_info["user_version"],
        "foreign_key_errors": 0,
        "integrity": "ok",
    }
