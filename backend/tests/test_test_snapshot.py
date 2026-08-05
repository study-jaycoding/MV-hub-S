"""test_push-db → test_pull-db 다중 DB 스냅샷 번들 검증."""

from __future__ import annotations

import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.routers import db_transfer
from app.routers.db_transfer import export_test_snapshot
from app.services.test_snapshot import (
    MANIFEST_NAME,
    SNAPSHOT_FORMAT,
    SNAPSHOT_VERSION,
    TestSnapshotError,
    create_test_snapshot_archive,
    extract_test_snapshot_archive,
)


def _db(path: Path, schema: str, insert: str | None = None) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(schema)
    if insert:
        conn.execute(insert)
    conn.commit()
    return conn


def test_snapshot_round_trip_keeps_all_db_files_and_committed_wal_rows(tmp_path: Path):
    data = tmp_path / "data"
    connections = [
        _db(
            data / "db" / "content_hub.db",
            "CREATE TABLE generation(id TEXT PRIMARY KEY, prompt TEXT)",
            "INSERT INTO generation VALUES('g1','from wal')",
        ),
        _db(
            data / "db" / "content_hub_trash.db",
            "CREATE TABLE trashed_generation(id TEXT PRIMARY KEY)",
            "INSERT INTO trashed_generation VALUES('trash-1')",
        ),
        _db(
            data / "db" / "manage_hub.db",
            "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY)",
            "INSERT INTO team_generation_fact VALUES('fact-1')",
        ),
        _db(
            data / "db" / "acct" / "worker" / "content_hub.db",
            "CREATE TABLE generation(id TEXT PRIMARY KEY, prompt TEXT)",
            "INSERT INTO generation VALUES('acct-1','private')",
        ),
    ]
    archive = create_test_snapshot_archive(data)
    try:
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            assert MANIFEST_NAME in names
            assert "db/content_hub.db" in names
            assert "db/content_hub_trash.db" in names
            assert "db/manage_hub.db" in names
            assert "db/acct/worker/content_hub.db" in names
            assert not any(name.endswith(("-wal", "-shm")) for name in names)

        installed = extract_test_snapshot_archive(archive, tmp_path / "installed")
        assert len(installed) == 4
        with sqlite3.connect(tmp_path / "installed" / "db" / "content_hub.db") as conn:
            assert conn.execute("SELECT prompt FROM generation WHERE id='g1'").fetchone()[0] == "from wal"
        with sqlite3.connect(tmp_path / "installed" / "db" / "manage_hub.db") as conn:
            assert conn.execute("SELECT COUNT(*) FROM team_generation_fact").fetchone()[0] == 1
    finally:
        archive.unlink(missing_ok=True)
        for conn in connections:
            conn.close()


@pytest.mark.parametrize("unsafe_name", ["../evil.db", "db/../../evil.db", "db/..\\evil.db"])
def test_snapshot_extract_rejects_path_traversal(tmp_path: Path, unsafe_name: str):
    archive = tmp_path / "unsafe.zip"
    manifest = {
        "format": SNAPSHOT_FORMAT,
        "version": SNAPSHOT_VERSION,
        "files": [{"path": unsafe_name, "size": 3}],
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(unsafe_name, b"bad")
        bundle.writestr(MANIFEST_NAME, json.dumps(manifest))

    destination = tmp_path / "installed"
    with pytest.raises(TestSnapshotError):
        extract_test_snapshot_archive(archive, destination)

    assert not destination.exists()
    assert not (tmp_path / "evil.db").exists()


def test_snapshot_export_endpoint_is_hidden_without_explicit_flag(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", raising=False)

    with pytest.raises(HTTPException) as exc:
        export_test_snapshot(None)  # type: ignore[arg-type] -- gate runs before request auth

    assert exc.value.status_code == 404


def test_enabled_snapshot_endpoint_returns_multi_db_zip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    data = tmp_path / "server-data"
    primary = _db(
        data / "db" / "content_hub.db",
        "CREATE TABLE generation(id TEXT PRIMARY KEY)",
        "INSERT INTO generation VALUES('g1')",
    )
    manage = _db(
        data / "db" / "manage_hub.db",
        "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY)",
        "INSERT INTO team_generation_fact VALUES('fact1')",
    )
    monkeypatch.setenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", "1")
    monkeypatch.setattr(db_transfer, "DATA_DIR", data)
    monkeypatch.setattr(db_transfer, "require_admin", lambda request: None)
    monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda request: None)

    response = export_test_snapshot(None)  # type: ignore[arg-type]
    archive = Path(response.path)
    try:
        with zipfile.ZipFile(archive) as bundle:
            assert {"db/content_hub.db", "db/manage_hub.db"}.issubset(bundle.namelist())
        assert response.media_type == "application/zip"
    finally:
        archive.unlink(missing_ok=True)
        primary.close()
        manage.close()
