from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = ROOT / "tools" / "seed_manage_multi_user_test_data.py"
SPEC = importlib.util.spec_from_file_location("seed_manage_multi_user_test_data", FIXTURE_PATH)
assert SPEC and SPEC.loader
fixture_tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture_tool)


SCHEMA = """
CREATE TABLE team_generation_fact (
    id TEXT PRIMARY KEY, account_email TEXT NOT NULL, creator_uid TEXT, creator_name TEXT,
    local_gen_id TEXT NOT NULL, workspace_scope TEXT, workspace_id TEXT, workspace_name TEXT,
    project_id TEXT, project_name TEXT, folder_path TEXT, model TEXT, output_type TEXT,
    status TEXT, real_credits REAL, elapsed_seconds REAL, created_at TEXT, sort_ts REAL,
    is_final INTEGER, is_shared INTEGER, is_deleted INTEGER, last_seen_at TEXT, updated_at TEXT
);
"""


def make_test_data(tmp_path: Path) -> Path:
    data_dir = tmp_path / "data_test"
    db_path = data_dir / "db" / "manage_hub.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)
        conn.execute(
            "INSERT INTO team_generation_fact("
            "id,account_email,local_gen_id,workspace_scope,workspace_id,workspace_name,"
            "project_id,project_name,is_deleted) VALUES(?,?,?,?,?,?,?,?,0)",
            ("base", "owner@example.com", "base", "team", "ws-1", "MILLIONVOLT", "p-1", "Project",),
        )
    return data_dir


def test_fixture_refuses_non_test_data_directory(tmp_path: Path):
    unsafe = tmp_path / "data"
    (unsafe / "db").mkdir(parents=True)
    (unsafe / "db" / "manage_hub.db").touch()
    with pytest.raises(ValueError, match="data_test"):
        fixture_tool.run(unsafe, "apply")


def test_fixture_adds_two_members_and_cleans_only_its_rows(tmp_path: Path):
    data_dir = make_test_data(tmp_path)
    result = fixture_tool.run(data_dir, "apply")
    assert result["rows"] == 4
    assert result["credits"] == 24
    assert result["members"] == ["리버", "오지짱"]

    db_path = data_dir / "db" / "manage_hub.db"
    with sqlite3.connect(db_path) as conn:
        fixture_rows = conn.execute(
            "SELECT creator_name, COUNT(*), SUM(real_credits), SUM(is_final) "
            "FROM team_generation_fact WHERE account_email LIKE 'mvhub-browser-test+%' "
            "GROUP BY creator_name ORDER BY creator_name"
        ).fetchall()
    assert fixture_rows == [("리버", 2, 16.0, 1), ("오지짱", 2, 8.0, 0)]

    cleaned = fixture_tool.run(data_dir, "clean")
    assert cleaned["removed"] == 4
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM team_generation_fact").fetchone()[0] == 1
