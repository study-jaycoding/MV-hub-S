"""최초 복사·재실행 보존·원본 및 사용자 설정 경계."""
import hashlib
import sqlite3
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
from workroom_data import llm_config_hashes, prepare_runtime, runtime_env


def source(tmp_path):
    db = tmp_path / "source/content_hub.db"
    db.parent.mkdir()
    with sqlite3.connect(db) as conn:
        conn.executescript("""
            CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO app_setting VALUES('auth_secret','source-secret'),('comfy_api_key','source-key'),
                ('comfy_input_dir','outside'),('theme','dark');
            CREATE TABLE account(email TEXT, password_hash TEXT);
            INSERT INTO account VALUES('fixture@localhost.invalid','fixture-hash');
            CREATE TABLE project(render_root_path TEXT);
            INSERT INTO project VALUES('outside');
            CREATE TABLE mcp_client(revoked_at TEXT);
            INSERT INTO mcp_client VALUES(NULL);
        """)
    return db


def test_snapshot_preserves_source_accounts_and_repeated_edits(tmp_path):
    db = source(tmp_path)
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    runtime = tmp_path / "room"
    prepare_runtime(runtime, db, REPO)
    copied = runtime / "data/db/content_hub.db"
    with sqlite3.connect(copied) as conn:
        settings = dict(conn.execute("SELECT key,value FROM app_setting"))
        assert not {"auth_secret", "comfy_api_key", "comfy_input_dir"} & settings.keys()
        assert settings["theme"] == "dark"
        assert conn.execute("SELECT password_hash FROM account").fetchone()[0] == "fixture-hash"
        assert conn.execute("SELECT render_root_path FROM project").fetchone()[0] is None
        assert conn.execute("SELECT revoked_at FROM mcp_client").fetchone()[0]
        conn.execute("UPDATE app_setting SET value='light' WHERE key='theme'")
    secret = (runtime / "auth.secret").read_bytes()
    prepare_runtime(runtime, None, REPO)
    with sqlite3.connect(copied) as conn:
        assert conn.execute("SELECT value FROM app_setting WHERE key='theme'").fetchone()[0] == "light"
    assert secret == (runtime / "auth.secret").read_bytes()
    assert hashlib.sha256(db.read_bytes()).hexdigest() == before


def test_refuses_existing_or_overlapping_runtime(tmp_path):
    db = source(tmp_path)
    with pytest.raises(ValueError):
        prepare_runtime(db.parent, db, REPO)
    with pytest.raises(ValueError):
        prepare_runtime(REPO / "test-data", db, REPO)
    folder = tmp_path / "foreign"
    folder.mkdir()
    (folder / "keep.txt").write_text("keep")
    with pytest.raises(ValueError):
        prepare_runtime(folder, db, REPO)
    assert (folder / "keep.txt").read_text() == "keep"


def test_snapshot_reads_committed_wal_without_changing_source_db(tmp_path):
    db = source(tmp_path)
    writer = sqlite3.connect(db)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("INSERT INTO app_setting VALUES('wal_fixture','committed')")
        writer.commit()
        wal = Path(str(db) + "-wal")
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (db, wal)]
        runtime = tmp_path / "room"
        prepare_runtime(runtime, db, REPO)
        with sqlite3.connect(runtime / "data/db/content_hub.db") as conn:
            assert conn.execute("SELECT value FROM app_setting WHERE key='wal_fixture'").fetchone()[0] == "committed"
        assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in (db, wal)] == before
    finally:
        writer.close()


def test_env_and_hashes_do_not_use_or_change_real_home(tmp_path):
    db = source(tmp_path)
    runtime = tmp_path / "room"
    prepare_runtime(runtime, db, REPO)
    home = tmp_path / "real-home"
    (home / ".codex").mkdir(parents=True)
    config = home / ".codex/config.toml"
    config.write_text("fixture")
    parent = {"USERPROFILE": str(home), "APPDATA": str(home / "roaming"), "PATH": "",
              "CONTENT_HUB_DB": "outside", "HTTPS_PROXY": "outside"}
    before = llm_config_hashes(parent)
    env = runtime_env(runtime, REPO, 8991, parent)
    for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CONTENT_HUB_DB"):
        assert Path(env[key]).is_relative_to(runtime)
    assert "HTTPS_PROXY" not in env
    assert env["CONTENT_HUB_AUTH"] == "1"
    assert env["MVHUB_NAMES_READONLY"] == "1"
    assert env["CONTENT_HUB_AUTH_SECRET"] != "source-secret"
    assert llm_config_hashes(parent) == before
