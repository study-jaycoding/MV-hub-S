"""읽기 전용 SQLite URI 는 경로의 URI 문법 문자(`#`·`%`)를 인코딩해야 한다.

`f"file:{path.as_posix()}?mode=ro"` 로 손수 조립하면 `#` 뒤가 fragment 로 잘려 `?mode=ro` 까지
사라지고 `%41` 은 `A` 로 디코딩된다 — 엉뚱한 경로를 읽기·쓰기로 연다. 그 형태가 백업·스냅샷
9곳에 복붙돼 있던 것을 `sqlite_db.read_only_uri` 하나로 모았다(2026-09-18).
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.services.sqlite_db import read_only_uri

AWKWARD_DIR = "a#b %41 한글"


def _make_db(folder: Path) -> Path:
    folder.mkdir(parents=True)
    db = folder / "x.db"
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("CREATE TABLE t(x)")
        conn.execute("INSERT INTO t VALUES (7)")
        conn.commit()
    return db


def test_opens_a_path_with_uri_syntax_characters_and_stays_read_only(tmp_path):
    db = _make_db(tmp_path / AWKWARD_DIR)
    with closing(sqlite3.connect(read_only_uri(db), uri=True)) as conn:
        assert conn.execute("SELECT x FROM t").fetchone() == (7,)
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("INSERT INTO t VALUES (8)")


def test_the_hand_built_form_it_replaced_misses_that_database(tmp_path):
    db = _make_db(tmp_path / AWKWARD_DIR)
    with pytest.raises(sqlite3.OperationalError):
        with closing(sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)) as conn:
            conn.execute("SELECT x FROM t").fetchone()
