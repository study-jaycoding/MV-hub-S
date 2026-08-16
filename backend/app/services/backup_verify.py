"""SQLite 백업 복원 훈련.

운영 DB를 교체하지 않고 별도 파일에 실제 복원한 뒤 무결성·FK·스키마·행 수를 확인한다.
콘텐츠·휴지통·관리 DB 세트는 백업 파일명의 동일 타임스탬프를 하나의 복구 단위로 삼는다.
"""

from __future__ import annotations

import hashlib
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .sqlite_db import SQLITE_MAGIC

_REQUIRED_TABLES = {"generation", "worker", "account", "project", "share"}

BACKUP_SET_MEMBERS: dict[str, dict[str, Any]] = {
    "content": {
        "prefix": "content_hub_",
        "restored_name": "content_hub.db",
        "required_tables": _REQUIRED_TABLES,
        "reconcile_tables": ("generation", "project", "share"),
    },
    "trash": {
        "prefix": "content_trash_",
        "restored_name": "content_hub_trash.db",
        "required_tables": {"trashed"},
        "reconcile_tables": ("trashed",),
    },
    "manage": {
        "prefix": "manage_hub_",
        "restored_name": "manage_hub.db",
        "required_tables": {"team_generation_fact"},
        "reconcile_tables": ("team_generation_fact",),
    },
}


def _sqlite_read_uri(path: Path, *, immutable: bool) -> str:
    """공백·한글·#·UNC를 안전하게 인코딩한 SQLite 읽기 전용 URI."""
    suffix = "?mode=ro&immutable=1" if immutable else "?mode=ro"
    return path.resolve().as_uri() + suffix


def create_sqlite_snapshot(
    source: Path,
    destination: Path,
    *,
    immutable_source: bool = False,
) -> Path:
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
    source_target = str(source)
    source_uri = False
    if immutable_source:
        # 자동 백업은 독립된 단일 SQLite 파일이다. immutable 읽기로 열면 검증 과정이 백업 폴더에
        # -wal/-shm 파일을 만들거나 원본 백업의 메타데이터를 바꿀 수 없다.
        source_target = _sqlite_read_uri(source, immutable=True)
        source_uri = True
    try:
        with closing(sqlite3.connect(source_target, uri=source_uri)) as src:
            with closing(sqlite3.connect(str(destination))) as dst:
                src.backup(dst)
    except BaseException:
        # 디스크 부족·손상 등으로 중간 파일이 생겨도 다음 드릴에서 정상 복원본으로 오인하지 않는다.
        try:
            destination.unlink()
        except OSError:
            pass
        raise
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


def inspect_sqlite_database(
    path: Path,
    *,
    required_tables: set[str] | frozenset[str] = frozenset(_REQUIRED_TABLES),
) -> dict[str, Any]:
    path = path.resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    wal_path = Path(str(path) + "-wal")
    try:
        wal_bytes = wal_path.stat().st_size
    except FileNotFoundError:
        wal_bytes = 0
    if wal_bytes > 0:
        raise ValueError(f"독립 백업 파일에 미반영 WAL이 남아 있습니다: {wal_path.name}")
    with path.open("rb") as handle:
        if handle.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
            raise ValueError("SQLite DB 파일이 아닙니다")
    uri = _sqlite_read_uri(path, immutable=True)
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        conn.execute("PRAGMA query_only=ON")
        tables = _tables(conn)
        missing = sorted(set(required_tables) - set(tables))
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
    source_info = inspect_sqlite_database(backup_path)
    create_sqlite_snapshot(backup_path, restored_path, immutable_source=True)
    restored_info = inspect_sqlite_database(restored_path)
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


def discover_backup_set(content_backup: Path) -> tuple[str, dict[str, Path]]:
    """대표 content 백업과 정확히 같은 타임스탬프의 3개 DB 경로를 반환한다."""
    content_backup = content_backup.resolve()
    content_prefix = str(BACKUP_SET_MEMBERS["content"]["prefix"])
    name = content_backup.name
    if not name.startswith(content_prefix) or not name.endswith(".db"):
        raise ValueError("세트 대표 파일은 content_hub_<시각>.db 형식이어야 합니다")
    stamp = name[len(content_prefix) : -3]
    if not stamp:
        raise ValueError("백업 파일에 세트 시각이 없습니다")

    members = {
        label: content_backup.parent / f"{spec['prefix']}{stamp}.db"
        for label, spec in BACKUP_SET_MEMBERS.items()
    }
    missing = [label for label, path in members.items() if not path.is_file()]
    if missing:
        missing_names = ", ".join(
            f"{BACKUP_SET_MEMBERS[label]['prefix']}{stamp}.db" for label in missing
        )
        raise FileNotFoundError(
            f"같은 시각의 DB 백업 세트가 불완전합니다: {missing_names}"
        )
    return stamp, members


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_table_counts(path: Path, tables: tuple[str, ...]) -> dict[str, int]:
    # 격리 서버가 WAL에 남긴 정상 커밋까지 포함해야 하므로 runtime 대조는 immutable을 쓰지 않는다.
    # 이 함수가 여는 것은 복원한 임시 파일뿐이며 원본 백업에는 사용하지 않는다.
    uri = _sqlite_read_uri(path, immutable=False)
    with closing(sqlite3.connect(uri, uri=True)) as conn:
        return _table_counts(conn, list(tables))


def verify_restore_set(content_backup: Path, restored_data_dir: Path) -> dict[str, Any]:
    """같은 시각의 content·trash·manage 백업을 격리 데이터 폴더에 함께 복원한다.

    세 대상 파일을 모두 사전 검사해 하나라도 이미 존재하면 아무것도 쓰지 않는다. 복원 중
    오류가 나면 이 호출이 만든 파일만 회수해 부분 세트를 정상 복원으로 오인하지 않게 한다.
    """
    stamp, backup_paths = discover_backup_set(content_backup)
    restored_db_dir = restored_data_dir.resolve() / "db"
    restored_paths = {
        label: restored_db_dir / str(spec["restored_name"])
        for label, spec in BACKUP_SET_MEMBERS.items()
    }
    collisions = [path for path in restored_paths.values() if path.exists()]
    if collisions:
        raise FileExistsError(
            "복원 대상이 이미 존재합니다: " + ", ".join(str(path) for path in collisions)
        )

    source_info: dict[str, dict[str, Any]] = {}
    source_hashes: dict[str, str] = {}
    for label, source in backup_paths.items():
        required = set(BACKUP_SET_MEMBERS[label]["required_tables"])
        source_info[label] = inspect_sqlite_database(source, required_tables=required)
        source_hashes[label] = _file_sha256(source)

    created: list[Path] = []
    try:
        for label in ("content", "trash", "manage"):
            create_sqlite_snapshot(
                backup_paths[label],
                restored_paths[label],
                immutable_source=True,
            )
            created.append(restored_paths[label])

        files: dict[str, Any] = {}
        for label, restored in restored_paths.items():
            required = set(BACKUP_SET_MEMBERS[label]["required_tables"])
            restored_info = inspect_sqlite_database(restored, required_tables=required)
            if source_info[label]["schema_sha256"] != restored_info["schema_sha256"]:
                raise ValueError(f"{label} DB 복원 전후 스키마가 다릅니다")
            if source_info[label]["table_counts"] != restored_info["table_counts"]:
                raise ValueError(f"{label} DB 복원 전후 테이블 행 수가 다릅니다")
            reconcile_tables = tuple(BACKUP_SET_MEMBERS[label]["reconcile_tables"])
            files[label] = {
                "backup": str(backup_paths[label]),
                "restored": str(restored),
                "backup_bytes": backup_paths[label].stat().st_size,
                "restored_bytes": restored.stat().st_size,
                "table_count": len(source_info[label]["tables"]),
                "schema_sha256": source_info[label]["schema_sha256"],
                "reconcile_counts": {
                    table: source_info[label]["table_counts"][table]
                    for table in reconcile_tables
                },
                "source_unchanged": True,
            }
        # 앞선 content 검사가 끝난 뒤 trash/manage를 처리하는 동안 바뀐 경우까지 잡도록 세 파일을
        # 모두 복원·검증한 마지막 시점에 원본 해시를 다시 대조한다.
        for label, source in backup_paths.items():
            if source_hashes[label] != _file_sha256(source):
                raise RuntimeError(f"{label} 원본 백업 파일이 복원 중 변경되었습니다")
    except BaseException:
        for path in reversed(created):
            try:
                path.unlink()
            except OSError:
                pass
        raise

    return {
        "ok": True,
        "mode": "database_set",
        "stamp": stamp,
        "restored_data_dir": str(restored_data_dir.resolve()),
        "files": files,
    }
