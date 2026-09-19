"""격리 브라우저 실측 도구의 안전 장치 — 복사본에서 공유 서버 토큰·주소가 사라지고, PATH 에서 Higgsfield CLI 가 빠진다.

이 두 가지가 깨지면 실측 중의 클릭이 운영 공유 서버나 실제 CLI(과금)로 나갈 수 있다(tools/browser_measure/servers.py).
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load():
    spec = importlib.util.spec_from_file_location("bm_servers", ROOT / "tools" / "browser_measure" / "servers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_snapshot_removes_shared_server_session_and_points_to_a_dead_address(tmp_path):
    servers = _load()
    src = tmp_path / "src.db"
    with sqlite3.connect(src) as conn:
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
        conn.executemany("INSERT INTO app_setting VALUES (?, ?)", [
            ("shared_server_token", "secret-token"), ("shared_server_elev_token", "elev"),
            ("shared_server_url", "http://192.168.1.199:8010"), ("shared_server_url_history", "[]"), ("unrelated", "kept"),
        ])
    before = src.read_bytes()

    servers.snapshot(src, tmp_path / "copy" / "dst.db")

    with sqlite3.connect(tmp_path / "copy" / "dst.db") as conn:
        rows = dict(conn.execute("SELECT key, value FROM app_setting"))
    assert rows == {"shared_server_url": servers.DEAD_URL, "unrelated": "kept"}
    assert servers.DEAD_URL.startswith("http://127.0.0.1:")
    assert src.read_bytes() == before  # 원본은 읽기 전용으로만 연다


def test_clean_path_drops_every_folder_that_holds_the_cli(tmp_path):
    servers = _load()
    with_cli, also_cli, plain = tmp_path / "npm", tmp_path / "other", tmp_path / "plain"
    for folder in (with_cli, also_cli, plain):
        folder.mkdir()
    (with_cli / "higgsfield.cmd").write_text("", encoding="ascii")
    (also_cli / "hf.exe").write_text("", encoding="ascii")

    cleaned = servers.clean_path(os.pathsep.join([str(with_cli), str(plain), str(also_cli), ""]))

    assert cleaned.split(os.pathsep) == [str(plain)]
