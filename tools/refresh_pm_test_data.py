from __future__ import annotations

import shutil
import sqlite3
import sys
import json
import os
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.sqlite_db import HubDbValidationError, validate_hub_db
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


def request_json(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    token: str | None = None,
    timeout: int = 60,
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw or "null")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload: Any = json.loads(raw or "null")
        except ValueError:
            payload = raw
        return exc.code, payload
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        fail(f"shared server request failed: {exc}")


def detail_text(payload: Any) -> str:
    if isinstance(payload, dict) and "detail" in payload:
        payload = payload["detail"]
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, ensure_ascii=False)


def validate_sqlite(path: Path) -> None:
    if not path.exists():
        fail(f"downloaded db does not exist: {path}")
    try:
        validate_hub_db(path, require_integrity=True)
    except HubDbValidationError as exc:
        if exc.reason == "not_sqlite":
            fail("downloaded file is not a SQLite database")
        if exc.reason == "missing_generation":
            fail("downloaded db is not an MV Hub database (missing generation table)")
        if exc.reason == "integrity":
            fail("downloaded db failed integrity check")
        fail(f"downloaded db is not readable: {exc.reason}")


def download_server_db(base_url: str, dst: Path) -> None:
    email = (os.environ.get("PM_TEST_ADMIN_EMAIL") or "").strip()
    password = os.environ.get("PM_TEST_ADMIN_PASSWORD") or ""
    if not email or not password:
        fail("PM_TEST_ADMIN_EMAIL and PM_TEST_ADMIN_PASSWORD are required for URL mode")

    base = base_url.rstrip("/")
    print(f"[download] server: {base}")
    print(f"[download] admin:  {email}")
    status, payload = request_json(
        "POST",
        f"{base}/api/auth/login",
        body={"email": email, "password": password},
        timeout=30,
    )
    if status != 200 or not isinstance(payload, dict) or not payload.get("token"):
        fail(f"admin login failed ({status}): {detail_text(payload)}")
    token = str(payload["token"])

    db_dir = dst / "db"
    db_dir.mkdir(parents=True, exist_ok=True)
    tmp = dst.parent / f"{dst.name}-download-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    req = urllib.request.Request(f"{base}/api/db/export", method="GET")
    req.add_header("Authorization", f"Bearer {token}")
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
        fail(f"db export failed ({exc.code}): {detail_text(payload)}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        tmp.unlink(missing_ok=True)
        fail(f"db export request failed: {exc}")

    validate_sqlite(tmp)
    target = db_dir / "content_hub.db"
    shutil.move(str(tmp), str(target))
    print(f"[download] db saved: {target}")


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
        src_label = raw_src.rstrip("/")
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
