from __future__ import annotations

import shutil
import sqlite3
import sys
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import getpass
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.db_scrub import scrub_test_snapshot_db
from app.services.test_snapshot import (
    SNAPSHOT_EXPORT_PATH,
    SNAPSHOT_STAGING_ENV,
    SNAPSHOT_TOKEN_HEADER,
    TestSnapshotError,
    extract_test_snapshot_archive,
)
from account_paths import account_slug


SKIP_TOP_LEVEL = {
    "assets",
    "backups",
    "media",
    "reset-backups",
}
SKIP_SUFFIXES = {
    ".db-shm",
    ".db-wal",
}


def masked_password_input(prompt: str, *, _read_key=None, _stream=None) -> str:
    """Windows CMD에서도 실제 비밀번호 대신 `*`만 표시한다."""
    if os.name != "nt" and _read_key is None:
        return getpass.getpass(prompt)

    restore_console_mode = None
    if _read_key is None:
        import ctypes
        import msvcrt

        _read_key = msvcrt.getwch
        kernel32 = ctypes.windll.kernel32
        stdin_handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_ulong()
        if stdin_handle not in (0, -1) and kernel32.GetConsoleMode(stdin_handle, ctypes.byref(mode)):
            restore_console_mode = (kernel32, stdin_handle, mode.value)
            kernel32.SetConsoleMode(stdin_handle, mode.value & ~0x0004)  # ENABLE_ECHO_INPUT
    stream = _stream or sys.stdout
    chars: list[str] = []
    stream.write(prompt)
    stream.flush()
    try:
        while True:
            char = _read_key()
            if char in ("\r", "\n"):
                stream.write("\n")
                stream.flush()
                return "".join(chars)
            if char == "\x03":
                stream.write("\n")
                stream.flush()
                raise KeyboardInterrupt
            if char == "\b":
                if chars:
                    chars.pop()
                    stream.write("\b \b")
                    stream.flush()
                continue
            if char in ("\x00", "\xe0"):
                _read_key()
                continue
            if not char or ord(char) < 32:
                continue
            chars.append(char)
            stream.write("*")
            stream.flush()
    finally:
        if restore_console_mode:
            kernel32, stdin_handle, original_mode = restore_console_mode
            kernel32.SetConsoleMode(stdin_handle, original_mode)


def fail(message: str) -> None:
    print(f"[ERROR] {message}")
    raise SystemExit(1)


def should_skip(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    if rel.parts and rel.parts[0] in SKIP_TOP_LEVEL:
        return True
    return any(path.name.endswith(suffix) for suffix in SKIP_SUFFIXES)


def backup_sqlite(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # SQLite backup API gives a consistent snapshot even when WAL mode is active.
    with closing(sqlite3.connect(f"file:{src}?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(dst)) as target:
            source.backup(target)


def copy_snapshot(src: Path, dst: Path) -> None:
    copied_files = 0
    copied_dbs = 0
    staging_only = os.environ.get(SNAPSHOT_STAGING_ENV, "").strip() == "1"
    for path in src.rglob("*"):
        if should_skip(path, src):
            continue
        rel = path.relative_to(src)
        target = dst / rel
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if path.suffix.lower() == ".db":
            backup_sqlite(path, target)
            # 서버가 LAN에 잠시 공개하는 중간 사본에는 로그인 계정을 하나도 만들지 않는다.
            # 최종 다운로드 ZIP을 만들 때만 기본 DB에 로컬 테스트 관리자를 추가한다.
            create_test_admin = not staging_only and rel == Path("db") / "content_hub.db"
            scrub_test_snapshot_db(target, create_test_admin=create_test_admin)
            copied_dbs += 1
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            copied_files += 1
    print(f"[copy] sqlite db files: {copied_dbs}")
    print(f"[copy] support files: {copied_files}")


def is_url(value: str) -> bool:
    low = value.strip().lower()
    return low.startswith("http://") or low.startswith("https://")


_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+$")


def validate_snapshot_server_url(raw: str) -> str:
    """test_pull-db 가 넘기는 스냅샷 서버 주소 — ``http://host:port`` 만 허용한다.

    환경변수(MVHUB_SNAPSHOT_SERVER)로 들어오는 값이라 경로·쿼리·userinfo·따옴표·공백(앞뒤 포함)·
    cmd 메타문자·https·포트 생략은 전부 거부하고, 통과한 값은 http://host:port 로 재구성해
    돌려준다(끝 슬래시 제거). 스냅샷 서버(test_push-db)는 LAN 의 평문 http 고정 포트다.
    """
    text = str(raw or "")
    if not text or text != text.strip():
        raise ValueError(f"snapshot server must be http://host:port (got {text!r})")
    parsed = urllib.parse.urlsplit(text)
    try:
        port = parsed.port
    except ValueError:
        port = None
    host = parsed.hostname or ""
    ok = (
        parsed.scheme == "http"
        and bool(host)
        and _HOST_RE.fullmatch(host) is not None
        and port is not None
        and not parsed.username
        and not parsed.password
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )
    if not ok:
        raise ValueError(f"snapshot server must be http://host:port (got {text!r})")
    return f"http://{host}:{port}"


def detail_text(payload: Any) -> str:
    if isinstance(payload, dict) and "detail" in payload:
        payload = payload["detail"]
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=False)


def download_server_db(base_url: str, dst: Path) -> None:
    snapshot_token = (os.environ.get("PM_TEST_SNAPSHOT_TOKEN") or "").strip()
    if not snapshot_token:
        snapshot_token = masked_password_input("One-time snapshot code: ").strip()
    if not snapshot_token:
        fail("one-time snapshot code is empty")

    base = base_url.rstrip("/")
    print(f"[download] server: {base}")

    tmp = dst.parent / f"{dst.name}-download-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.zip"
    req = urllib.request.Request(f"{base}{SNAPSHOT_EXPORT_PATH}", method="GET")
    req.add_header(SNAPSHOT_TOKEN_HEADER, snapshot_token)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            with open(tmp, "wb") as handle:
                shutil.copyfileobj(resp, handle)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw or "null")
        except ValueError:
            payload = raw
        tmp.unlink(missing_ok=True)
        fail(
            f"test snapshot export failed ({exc.code}): {detail_text(payload)}; "
            "run test_push-db.bat again to get a new one-time code"
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        tmp.unlink(missing_ok=True)
        fail(f"db export request failed: {exc}")

    try:
        installed = extract_test_snapshot_archive(tmp, dst)
    except TestSnapshotError as exc:
        fail(f"downloaded test snapshot is invalid: {exc}")
    finally:
        tmp.unlink(missing_ok=True)
    print(f"[download] verified db files: {len(installed)}")
    for path in installed:
        print(f"[download] db saved: {path}")


def table_count(conn: sqlite3.Connection, table: str) -> str:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if not exists:
        return "missing"
    return str(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def sqlite_ro_uri(path: Path) -> str:
    return "file:" + path.as_posix() + "?mode=ro&immutable=1"


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def top_pairs(conn: sqlite3.Connection, sql: str, limit: int = 6) -> str:
    try:
        rows = conn.execute(sql, {"limit": limit}).fetchall()
    except sqlite3.Error:
        return "n/a"
    if not rows:
        return "none"
    return ", ".join(f"{row[0] or '(blank)'}={row[1]}" for row in rows)


def print_db_summary(label: str, db: Path) -> None:
    print(f"[{label}] db:    {db}")
    if not db.exists():
        print(f"[{label}] db does not exist")
        return

    try:
        with closing(sqlite3.connect(sqlite_ro_uri(db), uri=True)) as conn:
            print(
                f"[{label}] counts: "
                f"generation={table_count(conn, 'generation')} "
                f"asset={table_count(conn, 'asset')} "
                f"project={table_count(conn, 'project')} "
                f"share={table_count(conn, 'share')} "
                f"account={table_count(conn, 'account')} "
                f"project_task={table_count(conn, 'project_task')}"
            )
            if table_exists(conn, "share"):
                print(
                    f"[{label}] shared_by: "
                    + top_pairs(
                        conn,
                        "SELECT COALESCE(shared_by, '') AS k, COUNT(*) AS c "
                        "FROM share GROUP BY shared_by ORDER BY c DESC, k LIMIT :limit",
                    )
                )
            if table_exists(conn, "generation"):
                print(
                    f"[{label}] creators:  "
                    + top_pairs(
                        conn,
                        "SELECT COALESCE(creator_uid, '') AS k, COUNT(*) AS c "
                        "FROM generation GROUP BY creator_uid ORDER BY c DESC, k LIMIT :limit",
                    )
                )
    except sqlite3.Error as exc:
        print(f"[{label}] summary failed: {exc}")


def active_db(dst: Path) -> tuple[str | None, Path]:
    active_file = dst / "active.json"
    active_email = None
    try:
        active = json.loads(active_file.read_text("utf-8"))
        active_email = (active or {}).get("email")
    except (OSError, ValueError, TypeError):
        active_email = None

    db = dst / "db" / "content_hub.db"
    if active_email:
        account_db = dst / "db" / "acct" / account_slug(active_email) / "content_hub.db"
        if account_db.exists():
            db = account_db

    return active_email, db


def print_snapshot_summary(dst: Path) -> None:
    default_db = dst / "db" / "content_hub.db"
    print_db_summary("server", default_db)

    active_email, db = active_db(dst)
    print(f"[active] email: {active_email or '(none / legacy db)'}")
    if db != default_db:
        print_db_summary("active", db)

    acct_dir = dst / "db" / "acct"
    if acct_dir.exists():
        acct_dbs = sorted(acct_dir.glob("*/content_hub.db"))
        if acct_dbs:
            print(f"[accounts] account db files: {len(acct_dbs)}")
            for path in acct_dbs[:8]:
                print_db_summary(f"acct:{path.parent.name}", path)
            if len(acct_dbs) > 8:
                print(f"[accounts] ... {len(acct_dbs) - 8} more")


def main() -> int:
    if len(sys.argv) != 3:
        fail("usage: refresh_pm_test_data.py <source-data-dir> <target-test-data-dir>")

    raw_src = sys.argv[1].strip()
    dst = Path(sys.argv[2]).resolve()
    url_mode = is_url(raw_src)

    if url_mode:
        try:
            raw_src = validate_snapshot_server_url(raw_src)
        except ValueError as exc:
            # 주소 형식 오류는 코드 2 — 복사·다운로드 실패(1)와 구분한다.
            print(f"[ERROR] {exc}")
            raise SystemExit(2) from exc
        src_label = raw_src
    else:
        src = Path(raw_src).resolve()
        if not src.exists():
            fail(f"source data dir does not exist: {src}")
        if not (src / "db").exists():
            fail(f"source db dir does not exist: {src / 'db'}")
        if src == dst or src in dst.parents or dst in src.parents:
            fail(f"unsafe source/target pair: {src} -> {dst}")
        src_label = str(src)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    work = dst.parent / f".{dst.name}-incoming-{stamp}"
    if work.exists():
        shutil.rmtree(work)

    print(f"[copy] from: {src_label}")
    print(f"[copy] to:   {work}")
    try:
        if url_mode:
            download_server_db(raw_src, work)
        else:
            copy_snapshot(src, work)
    except BaseException:
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        raise

    if dst.exists():
        backup_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = dst.parent / "_pm_test_data_snapshots"
        backup_dir.mkdir(parents=True, exist_ok=True)
        archived = backup_dir / f"{dst.name}-{backup_stamp}"
        print(f"[backup] moving previous test data to: {archived}")
        shutil.move(str(dst), str(archived))

    shutil.move(str(work), str(dst))
    print(f"[copy] installed: {dst}")
    print_snapshot_summary(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
