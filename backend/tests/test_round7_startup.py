"""격리 실측 서버의 기동 (조작 점검 7회차 R44).

① 도구(tools/browser_measure/servers.py) — 원본 시험 DB 를 `--source` 로 줄 수 있다. 원본이 없거나, 복사할 수 없거나, 그 DB 로 서버가
   기동 중에 죽으면 90초를 다 기다린 뒤 "로그를 본다"로 끝나지 않고, 원인과 다른 원본을 주는 법을 말하고 끝난다.
② 백엔드 — 기동의 첫 관리 조회(`main._application_lifespan`: init_db → init_manage_db → backfill_workspace_names(list_workspace_options()))는
   관리 스키마 보장(`ensure_manage_schema`)보다 **먼저** 돈다. 기동의 동기 구간은 그 보장을 한 번도 부르지 않는다(2026-10-11 실측).
   그래서 이 조회는 **이미 설치된 DB 에 있는 열만** 읽어야 한다 — 맨 아래 두 시험이 그 약속을 지킨다.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# 기동 중에 죽는 서버 — 진짜 백엔드가 옛 스키마 DB 로 죽을 때 남기는 로그의 뼈대(2026-10-11 재현에서 옮김)
_DEAD_SERVER = """\
print("INFO:     Waiting for application startup.")
print("ERROR:    Traceback (most recent call last):")
print('  File "main.py", line 316, in _application_lifespan')
print("    backfill_workspace_names(repo.list_workspace_options())")
print("sqlite3.OperationalError: no such column: status")
print("")
print("ERROR:    Application startup failed. Exiting.")
print("[serve] 듀얼 스택 기동")
raise SystemExit(3)
"""


def _load_servers():
    spec = importlib.util.spec_from_file_location("bm_servers_round7", ROOT / "tools" / "browser_measure" / "servers.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _source(folder: Path, marker: str) -> Path:
    """어느 원본을 복사했는지 알아볼 표식이 든 시험 DB 폴더."""
    folder.mkdir(parents=True)
    with closing(sqlite3.connect(folder / "content_hub.db")) as conn, conn:
        conn.execute("CREATE TABLE marker(value TEXT)")
        conn.execute("INSERT INTO marker VALUES (?)", (marker,))
    return folder


def _run(servers, monkeypatch, *argv) -> int:
    monkeypatch.setattr(sys, "argv", ["servers.py", *map(str, argv)])
    return servers.main()


class _NoServer:
    """servers 모듈이 보는 subprocess 만 바꿔 낀다 — 전역 `subprocess.Popen` 을 바꾸면 같은 프로세스의 다른 스레드까지 맞는다."""

    @staticmethod
    def Popen(*_args, **_kwargs):
        raise AssertionError("쓸 수 없는 원본으로 서버를 띄우면 안 된다")

    def __getattr__(self, name):
        return getattr(subprocess, name)


class _StillPolling(BaseException):
    """죽은 서버를 계속 기다린다는 표시 — wait_ready 의 `except Exception` 을 지나 올라오도록 BaseException 이다."""


@pytest.mark.parametrize("explicit", [True, False])
def test_measure_start_refuses_a_missing_source_before_starting_anything(tmp_path, monkeypatch, capsys, explicit):
    """원본이 없으면 전에는 말없이 빈 DB 로 떴다(잰 것이 빈 앱인 줄 모른다). 준 원본이 없다고 기본 원본으로 넘어가지도 않는다."""
    servers = _load_servers()
    monkeypatch.setattr(servers, "subprocess", _NoServer())
    missing = tmp_path / "missing"
    if explicit:
        monkeypatch.setattr(servers, "SOURCE_DB_DIR", _source(tmp_path / "default", "default"))
        argv = ["--source", missing]
    else:
        monkeypatch.setattr(servers, "SOURCE_DB_DIR", missing)
        argv = []
    work = tmp_path / "work"

    code = _run(servers, monkeypatch, "start", "--work", work, *argv)

    out = capsys.readouterr().out
    assert code == 1
    assert str(missing / "content_hub.db") in out and "--source" in out  # 무엇이 없고, 어떻게 주는지
    assert not (work / "H").exists()  # 아무것도 만들지 않고 끝난다


def test_measure_start_says_so_when_the_source_cannot_be_copied(tmp_path, monkeypatch, capsys):
    servers = _load_servers()
    monkeypatch.setattr(servers, "subprocess", _NoServer())
    monkeypatch.setattr(servers, "SOURCE_DB_DIR", tmp_path / "default")  # 시험이 저장소의 진짜 기본 원본을 열 길을 없앤다
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "content_hub.db").write_bytes(b"not a database " * 300)
    work = tmp_path / "work"

    code = _run(servers, monkeypatch, "start", "--work", work, "--source", broken)

    out = capsys.readouterr().out
    assert code == 1
    assert str(broken) in out and "--source" in out
    assert not (work / "H").exists() and not (work / "pids.json").exists()  # 복사하다 만 것을 남기지 않는다


@pytest.mark.skipif(os.name != "nt", reason="도구가 Windows 전용이다(창 없는 자식 프로세스·taskkill)")
def test_measure_start_copies_the_given_source_and_says_why_the_server_died(tmp_path, monkeypatch, capsys):
    servers = _load_servers()
    repo = tmp_path / "repo"
    (repo / "backend").mkdir(parents=True)
    (repo / "backend" / "serve.py").write_text(_DEAD_SERVER, encoding="utf-8")
    monkeypatch.setattr(servers, "REPO", repo)  # 진짜 백엔드 대신 '기동 중에 죽는 서버' — 프로세스·로그·종료 코드는 진짜다
    monkeypatch.setattr(servers, "SOURCE_DB_DIR", _source(tmp_path / "default", "default"))
    given = _source(tmp_path / "given", "given")
    polls: list[str] = []

    def not_ready(_port, path, _timeout=3):
        polls.append(path)
        if len(polls) > 20:  # 죽은 서버는 한두 번 물어보면 안다 — 전에는 90초를 다 물었다
            raise _StillPolling
        raise OSError("connection refused")

    monkeypatch.setattr(servers, "get_json", not_ready)
    work = tmp_path / "work"

    code = _run(servers, monkeypatch, "start", "--work", work, "--source", given)

    out = capsys.readouterr().out
    assert code == 1
    with closing(sqlite3.connect(work / "H" / "db" / "content_hub.db")) as conn:
        assert conn.execute("SELECT value FROM marker").fetchone()[0] == "given"  # 기본 원본이 아니라 준 원본을 복사했다
    assert "sqlite3.OperationalError: no such column: status" in out  # 죽은 원인 한 줄
    assert str(given) in out and "--source" in out  # 어느 원본이었고, 다른 원본은 어떻게 주는지
    assert not (work / "pids.json").exists()


# ── 도구가 지우는 것은 자기가 만든 것뿐 (Codex 리뷰 P1: `--source` 가 작업 폴더 안이면 원본이 지워졌다) ─────────────────────────────

def _tree(folder: Path) -> dict[str, str]:
    """폴더 안 모든 파일의 sha256 — 하나라도 지워지거나 생기거나 바뀌면 달라진다."""
    return {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob("*")) if p.is_file()}


_WINDOWS_ONLY = pytest.mark.skipif(os.name != "nt", reason="대소문자 무시·junction 은 Windows 의 것이다")


@pytest.mark.parametrize("layout, via", [
    ("source-in-work", "arg"),  # 지난 실행이 남긴 사본을 원본으로 준 경우 — 리뷰의 재현
    ("source-in-work", "module"),  # 래퍼(isolib)처럼 모듈 값 SOURCE_DB_DIR 를 바꿔 낀 경우
    ("work-in-source", "arg"),
    ("same-folder", "arg"),
    pytest.param("other-case", "arg", marks=_WINDOWS_ONLY),  # 같은 폴더를 다른 대소문자로
    pytest.param("junction", "arg", marks=_WINDOWS_ONLY),  # 작업 폴더 안을 가리키는 junction 으로
])
def test_measure_start_refuses_a_source_that_overlaps_the_work_folder(tmp_path, monkeypatch, capsys, layout, via):
    servers = _load_servers()
    monkeypatch.setattr(servers, "subprocess", _NoServer())
    monkeypatch.setattr(servers, "SOURCE_DB_DIR", tmp_path / "default")
    work = tmp_path / "work"
    if layout == "work-in-source":
        source = _source(tmp_path / "src", "kept")
        work = source / "measure"
    elif layout == "same-folder":
        source = work = _source(tmp_path / "src", "kept")
    else:
        source = _source(work / "H" / "db", "kept")
        (work / "H" / "server.log").write_text("지난 실행의 로그", encoding="utf-8")  # 도구가 만든 폴더다 — 그래도 원본이 든 채로는 못 지운다
    given = source
    if layout == "other-case":
        given = Path(str(source).swapcase())
    elif layout == "junction":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(tmp_path / "link"), str(work / "H")], check=True, capture_output=True)
        given = tmp_path / "link" / "db"
    if via == "module":
        monkeypatch.setattr(servers, "SOURCE_DB_DIR", given)
    before = _tree(tmp_path)

    code = _run(servers, monkeypatch, "start", "--work", work, *(["--source", given] if via == "arg" else []))

    out = capsys.readouterr().out
    assert code == 1 and "겹친다" in out
    assert _tree(tmp_path) == before  # 원본은 그대로이고, 원본 폴더 안에 새로 생긴 것도 없다


@pytest.mark.parametrize("command", ["start", "stop"])
def test_measure_tool_deletes_nothing_in_a_folder_it_did_not_make(tmp_path, monkeypatch, capsys, command):
    """`--work` 가 남의 폴더를 가리킨 경우 — 도구가 지우는 이름(H·S·shots·chrome_profile·results_*.json)과 같은 것이 우연히 들어 있다."""
    servers = _load_servers()
    monkeypatch.setattr(servers, "subprocess", _NoServer())
    monkeypatch.setattr(servers, "SOURCE_DB_DIR", _source(tmp_path / "default", "default"))
    work = tmp_path / "mine"
    for name in ("H/notes.txt", "S/keep.db", "shots/photo.png", "chrome_profile/Bookmarks", "results_2025.json"):
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_text("mine", encoding="utf-8")
    before = _tree(tmp_path)

    code = _run(servers, monkeypatch, command, "--work", work)

    out = capsys.readouterr().out
    assert code == 1 and str(work) in out
    assert _tree(tmp_path) == before


def test_measure_stop_cleans_what_later_runs_left_in_a_folder_the_tool_made(tmp_path, monkeypatch):
    """start 가 받아들인 폴더는 표식으로 기억한다 — 서버 사본을 치운 뒤에 생긴 것(크롬 프로필·결과)도 stop 이 치운다."""
    servers = _load_servers()
    monkeypatch.setattr(servers, "subprocess", _NoServer())
    monkeypatch.setattr(servers, "SOURCE_DB_DIR", tmp_path / "default")
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "content_hub.db").write_bytes(b"not a database " * 300)
    work = tmp_path / "work"
    assert _run(servers, monkeypatch, "start", "--work", work, "--source", broken) == 1  # 폴더는 받아들였고, 복사는 실패해 사본은 치워졌다
    (work / "chrome_profile").mkdir()
    (work / "chrome_profile" / "Cookies").write_text("x", encoding="utf-8")
    (work / "results_smoke.json").write_text("{}", encoding="utf-8")

    assert _run(servers, monkeypatch, "stop", "--work", work) == 0

    assert not (work / "chrome_profile").exists() and not (work / "results_smoke.json").exists()


def test_measure_stop_still_cleans_a_folder_left_by_the_version_before_the_marker(tmp_path, monkeypatch):
    """표식을 남기지 않던 판이 띄운 작업 폴더(지금 돌고 있는 실측들) — 그 판의 흔적(서버 로그)으로 알아보고 전처럼 치운다."""
    servers = _load_servers()
    work = tmp_path / "work"
    for name in ("H/server.log", "H/db/content_hub.db", "S/creds.json", "chrome_profile/Cookies"):
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_text("x", encoding="utf-8")

    assert _run(servers, monkeypatch, "stop", "--work", work) == 0
    assert [p.name for p in work.iterdir() if p.is_dir()] == []
    (work / "shots").mkdir()  # 로그는 이미 지웠다 — 다시 stop 해도 내 폴더로 알아봐야 한다('일부 남음 — 다시 stop')
    assert _run(servers, monkeypatch, "stop", "--work", work) == 0
    assert not (work / "shots").exists()


def test_snapshot_refuses_to_copy_a_file_onto_itself(tmp_path):
    """복사본 자리를 먼저 지우고 복사한다 — 같은 파일이면 원본이 지워진다."""
    servers = _load_servers()
    db = _source(tmp_path / "src", "kept") / "content_hub.db"
    before = _tree(tmp_path)

    with pytest.raises(ValueError):
        servers.snapshot(db, db)

    assert _tree(tmp_path) == before


# ── 백엔드: 기동의 첫 관리 조회 ─────────────────────────────────────────────────────────────────────────────────────

# 09-30 첫 공개(8279c891) 때의 콘솔 표 — **설치된 DB 가 실제로 가진 열**이다. 표에 열을 더해도 여기는 고치지 않는다:
# 기동 조회가 새 열을 읽기 시작하면 아래 시험이 'no such column' 으로 죽는다. 그때는 기동 순서(보장을 먼저)나 조회(없는 열 견디기)를 고친다.
_INSTALLED_CONSOLE = """CREATE TABLE workspace_console (
    workspace_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL CHECK (tier IN ('main','sub')),
    archived INTEGER NOT NULL DEFAULT 0,
    alloc_base REAL,
    alloc_base_day TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)"""


@pytest.fixture
def startup_db(monkeypatch, tmp_path):
    """기동 직후의 DB — 콘텐츠 스키마(init_db)와 관리 DB 까지만. 관리 스키마 보장은 아직 돌지 않았다(기동의 동기 구간과 같다)."""
    from app import db, manage_db

    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "usage.db")
    db.flush_pool()
    db.init_db()
    manage_db.init_manage_db()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES('mv', 'MILLIONVOLT', 'enterprise', 0)")
    yield db
    db.flush_pool()


def _first_manage_query() -> dict:
    """main._application_lifespan 이 init_db·init_manage_db 바로 뒤에 하는 일 그대로."""
    from app import manage_db, repo

    rows = repo.list_workspace_options()
    manage_db.backfill_workspace_names(rows)
    return {row["id"]: (row["console_tier"], row["console_order"]) for row in rows}


def test_startup_query_survives_a_db_from_before_the_console_table(startup_db):
    """서브스페이스(09-30) 전의 설치본을 새 코드로 여는 실제 업그레이드 — 콘솔 표가 아직 없다(나중에 첫 관리 호출이 만든다)."""
    with startup_db.get_connection() as conn:
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='workspace_console'").fetchone()

    assert _first_manage_query() == {"mv": (None, None)}


def test_startup_query_reads_only_columns_an_installed_console_table_has(startup_db):
    with startup_db.get_connection() as conn:
        conn.execute(_INSTALLED_CONSOLE)
        conn.execute("INSERT INTO workspace_console(workspace_id, tier) VALUES('mv', 'main')")

    assert _first_manage_query() == {"mv": ("main", 0)}
