from __future__ import annotations

import importlib.util
import os
import sqlite3
from contextlib import closing
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "tools" / "backup_replicate.py"
    spec = importlib.util.spec_from_file_location("backup_replicate", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _sqlite(path: Path, value: str) -> None:
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("CREATE TABLE sample(value TEXT)")
        conn.execute("INSERT INTO sample VALUES(?)", (value,))
        conn.commit()


def test_copy_validates_replica_before_publish(tmp_path):
    replicate = _module()
    src = tmp_path / "source.db"
    dest = tmp_path / "replica" / "source.db"
    _sqlite(src, "ok")

    assert replicate.copy_one(src, dest) == "copied"
    assert replicate._sqlite_valid(dest)
    assert not dest.with_suffix(".db.part").exists()


def test_corrupt_source_is_not_published(tmp_path, monkeypatch):
    replicate = _module()
    monkeypatch.setattr(replicate, "log", lambda _message: None)
    src = tmp_path / "broken.db"
    dest = tmp_path / "replica" / "broken.db"
    src.write_bytes(b"not sqlite")

    assert replicate.copy_one(src, dest) == "fail"
    assert not dest.exists()
    assert not dest.with_suffix(".db.part").exists()


def test_same_metadata_but_corrupt_replica_is_replaced(tmp_path):
    replicate = _module()
    src = tmp_path / "source.db"
    dest = tmp_path / "replica" / "source.db"
    _sqlite(src, "fresh")
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"x" * src.stat().st_size)
    os.utime(dest, (src.stat().st_atime, src.stat().st_mtime))

    assert replicate.copy_one(src, dest) == "copied"
    with closing(sqlite3.connect(dest)) as conn:
        assert conn.execute("SELECT value FROM sample").fetchone()[0] == "fresh"
