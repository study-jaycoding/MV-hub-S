"""작업자 개인 DB 백업 세트의 공유 서버 자동 전달.

개인 content DB 안에 outbox를 넣지 않는다. 그 DB는 다른 PC로 복원되므로 이전 PC의 staging
경로·전송 상태가 따라가면 안 된다. 상태와 전송 사본은 DATA_DIR 아래 머신 전용 저장소에 두고,
릴리스 업데이트가 앱 파일을 교체해도 그대로 보존한다.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import os
import platform
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .. import active_account, repo
from ..config import BACKEND_DIR, DATA_DIR
from . import shared_connection
from .atomic_io import atomic_write_text
from .db_scrub import SESSION_KEYS, strip_transfer_secrets
from .operational_logging import log_event
from .sqlite_db import validate_hub_db

STATE_DB = Path(
    os.environ.get(
        "CONTENT_HUB_WORKER_BACKUP_STATE_DB",
        str(DATA_DIR / "worker_backup_state.db"),
    )
).resolve()
OUTBOX_DIR = Path(
    os.environ.get(
        "CONTENT_HUB_WORKER_BACKUP_OUTBOX_DIR",
        str(DATA_DIR / "worker-backup-outbox"),
    )
).resolve()
DEVICE_IDENTITY_PATH = Path(
    os.environ.get(
        "CONTENT_HUB_DEVICE_IDENTITY_FILE",
        str(DATA_DIR / "device_identity.json"),
    )
).resolve()

UPLOAD_INTERVAL = max(
    15.0,
    float(os.environ.get("CONTENT_HUB_WORKER_BACKUP_UPLOAD_INTERVAL", "60")),
)
UPLOAD_TIMEOUT = max(
    10.0,
    float(os.environ.get("CONTENT_HUB_WORKER_BACKUP_UPLOAD_TIMEOUT", "120")),
)
_MAX_PENDING_PER_ACCOUNT = max(
    1,
    int(os.environ.get("CONTENT_HUB_WORKER_BACKUP_PENDING_KEEP", "10")),
)
_HISTORY_KEEP_PER_ACCOUNT = 100
_FORMAT = "mvhub-worker-backup-set"
_FORMAT_VERSION = 1
_SET_ID_RE = re.compile(r"[0-9a-f]{64}")
_PREFIX = "content_hub_"
_TRASH_PREFIX = "content_trash_"
_log = logging.getLogger("mvhub.worker_backup")

_SUMMARY_TABLES = {
    "generations": ("generation",),
    "tags": ("tag", "auto_tag", "gen_tag_overlay"),
    "canvases": ("scene_backup", "scene_card_generation"),
    "assets": ("asset_meta",),
    "projects": ("project",),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# 상태 DB 스키마/WAL 보장은 (프로세스, 경로)당 1회 — 종전엔 매 연결(유휴 60초 due 조회 포함)
# 마다 전체 DDL 스크립트를 실행했다(R4 A-1). WAL 은 파일 영속 설정이라 1회로 충분하고,
# synchronous=FULL 은 커넥션별 설정이라 매 연결 유지한다. 존재 프로브(stat 1회)로 테스트의
# 경로 교체·같은 경로 삭제-재생성도 재보장한다. 동시 최초 진입은 DDL 이 IF NOT EXISTS 라 무해.
_STATE_SCHEMA_READY: set[str] = set()
_STATE_SCHEMA_READY_LOCK = threading.Lock()


def _connect() -> sqlite3.Connection:
    key = str(STATE_DB)
    with _STATE_SCHEMA_READY_LOCK:
        needs_ensure = key not in _STATE_SCHEMA_READY or not STATE_DB.exists()
    STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(STATE_DB), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=FULL")
    if needs_ensure:
        conn.execute("PRAGMA journal_mode=WAL")
        _ensure_schema(conn)  # 실패 시 ready 미기록 — 다음 연결이 재시도
        with _STATE_SCHEMA_READY_LOCK:
            _STATE_SCHEMA_READY.add(key)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS worker_backup_outbox (
            backup_set_id   TEXT PRIMARY KEY,
            account_slug    TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            local_stamp     TEXT NOT NULL,
            roles_json      TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'pending',
            attempts        INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TEXT,
            last_success_at TEXT,
            last_error_code TEXT,
            next_retry_ts   REAL
        );
        CREATE INDEX IF NOT EXISTS idx_worker_backup_due
        ON worker_backup_outbox(account_slug, status, next_retry_ts, created_at);
        CREATE TABLE IF NOT EXISTS worker_backup_delivery_state (
            account_slug      TEXT PRIMARY KEY,
            last_attempt_at   TEXT,
            last_success_at   TEXT,
            last_backup_set_id TEXT,
            last_error_code   TEXT
        );
        CREATE TABLE IF NOT EXISTS worker_backup_source_state (
            account_slug         TEXT PRIMARY KEY,
            local_stamp          TEXT NOT NULL,
            source_signature_json TEXT NOT NULL,
            backup_set_id        TEXT NOT NULL
        );
        """
    )
    conn.commit()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _sqlite_user_version(path: Path) -> int:
    with contextlib.closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as conn:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _validate_trash(path: Path) -> None:
    with contextlib.closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as conn:
        conn.execute("PRAGMA query_only=ON")
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise sqlite3.DatabaseError("trash quick_check failed")
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trashed'"
        ).fetchone():
            raise sqlite3.DatabaseError("trash table missing")


def _verify_transfer_secrets_removed(path: Path) -> None:
    """정제가 실제 적용됐는지 확인한다.

    기존 정제 함수는 구형 DB 호환 때문에 SQLite 오류를 삼킨다. 자동 외부 전송은 보안상
    실패를 성공으로 간주할 수 없으므로 별도 확인을 통과하지 못하면 staging을 중단한다.
    """
    with contextlib.closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as conn:
        conn.execute("PRAGMA query_only=ON")
        placeholders = ",".join("?" for _ in SESSION_KEYS)
        found = conn.execute(
            f"SELECT 1 FROM app_setting WHERE key IN ({placeholders}) LIMIT 1",
            SESSION_KEYS,
        ).fetchone()
        if found is not None:
            raise sqlite3.DatabaseError("transfer secrets remain")


def _app_version() -> str:
    try:
        return (BACKEND_DIR.parent / "VERSION.txt").read_text("utf-8-sig").strip()
    except OSError:
        return ""


def _source_signature(content: Path, trash: Path) -> str | None:
    """불변 로컬 백업 세트를 복사 없이 재식별하는 보수적 저비용 지문."""
    paths = {"content": content}
    try:
        trash_stat = trash.stat()
    except FileNotFoundError:
        trash_stat = None
    except OSError:
        return None
    if trash_stat is not None:
        if not stat.S_ISREG(trash_stat.st_mode):
            return None
        paths["trash"] = trash

    files: dict[str, dict[str, Any]] = {}
    try:
        for role, path in sorted(paths.items()):
            value = path.stat()
            if not stat.S_ISREG(value.st_mode):
                return None
            with path.open("rb") as stream:
                header = stream.read(100)
            if len(header) != 100 or not header.startswith(b"SQLite format 3\x00"):
                return None
            files[role] = {
                "path": str(path),
                "device": int(value.st_dev),
                "inode": int(value.st_ino),
                "size": int(value.st_size),
                "mtime_ns": int(value.st_mtime_ns),
                "ctime_ns": int(value.st_ctime_ns),
                # 24~27바이트 변경 카운터를 포함해 크기·mtime을 보존한 SQLite 쓰기도 잡는다.
                "sqlite_header": header.hex(),
            }
    except OSError:
        return None
    return json.dumps(
        {
            "app_version": _app_version(),
            "format_version": _FORMAT_VERSION,
            "strip_keys": sorted(SESSION_KEYS),
            "files": files,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _prechecked_duplicate(
    account_slug: str,
    stamp: str,
    source_signature: str | None,
) -> str | None:
    """직전 전체 판정과 같은 불변 원본일 때만 활성 세트를 재사용한다."""
    if source_signature is None:
        return None
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT source.backup_set_id FROM worker_backup_source_state source "
                "JOIN worker_backup_outbox outbox ON outbox.backup_set_id=source.backup_set_id "
                "WHERE source.account_slug=? AND source.local_stamp=? "
                "AND source.source_signature_json=? "
                "AND outbox.status IN ('pending','running','done')",
                (account_slug, stamp, source_signature),
            ).fetchone()
    except (OSError, sqlite3.Error):
        return None
    return str(row[0]) if row is not None else None


def _remember_source_state(
    account_slug: str,
    stamp: str,
    source_signature: str | None,
    backup_set_id: str,
) -> None:
    """전체 내용 판정을 통과한 원본만 다음 부팅의 값싼 선판정에 기록한다."""
    if source_signature is None:
        return
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO worker_backup_source_state"
                "(account_slug,local_stamp,source_signature_json,backup_set_id) VALUES(?,?,?,?) "
                "ON CONFLICT(account_slug) DO UPDATE SET "
                "local_stamp=excluded.local_stamp,"
                "source_signature_json=excluded.source_signature_json,"
                "backup_set_id=excluded.backup_set_id",
                (account_slug, stamp, source_signature, backup_set_id),
            )
    except (OSError, sqlite3.Error):
        # 성능용 보조 상태다. 기록 실패는 다음 호출의 기존 전체 판정으로 안전하게 폴백한다.
        return


def _stamp_from_content(path: Path) -> str:
    name = path.name
    if not name.startswith(_PREFIX) or not name.endswith(".db"):
        raise ValueError("unexpected backup filename")
    stamp = name[len(_PREFIX) : -3]
    if not stamp or any(ch not in "0123456789_" for ch in stamp):
        raise ValueError("invalid backup stamp")
    return stamp


def _stage_dir(account_slug: str, backup_set_id: str) -> Path:
    if not _SET_ID_RE.fullmatch(backup_set_id):
        raise ValueError("invalid backup set id")
    return OUTBOX_DIR / account_slug / backup_set_id


def _role_info(path: Path) -> dict[str, Any]:
    return {"size": path.stat().st_size, "sha256": _sha256(path)}


def _device_identity() -> dict[str, str]:
    """DB 밖에 유지되는 이 PC의 공개 식별정보를 반환한다.

    복원한 DB 안에 기기 ID를 넣으면 다른 PC의 ID까지 복제된다. 릴리스 업데이트에도 보존되는
    DATA_DIR 별도 파일에 두어 서버 백업 목록에서 어느 PC가 만든 버전인지 구분한다.
    """
    try:
        value = json.loads(DEVICE_IDENTITY_PATH.read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        value = None
    device_id = str(value.get("device_id") or "") if isinstance(value, dict) else ""
    device_name = str(value.get("device_name") or "") if isinstance(value, dict) else ""
    if not re.fullmatch(r"[0-9a-f]{32}", device_id):
        device_id = secrets.token_hex(16)
    if not device_name:
        device_name = platform.node().strip() or os.environ.get("COMPUTERNAME", "").strip() or "내 PC"
    device_name = device_name[:80]
    normal = {"device_id": device_id, "device_name": device_name}
    if value != normal:
        DEVICE_IDENTITY_PATH.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(
            DEVICE_IDENTITY_PATH,
            json.dumps(normal, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        )
    return normal


def _table_count(
    conn: sqlite3.Connection, table: str, existing_tables: "set[str] | None" = None
) -> int:
    """행 수 집계 — existing_tables 를 주면(요약 경로) 테이블별 sqlite_master 재조회를 생략한다.
    (같은 read-only 연결 안에서 테이블 목록은 불변 — R4 A-3.)"""
    if existing_tables is not None:
        if table not in existing_tables:
            return 0
    elif conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is None:
        return 0
    return max(0, int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] or 0))


def _existing_table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def metadata_summary(content: Path, trash: Path | None = None) -> dict[str, int]:
    """민감한 본문 없이 동기화 비교에 필요한 개수만 계산한다."""
    summary: dict[str, int] = {}
    with contextlib.closing(
        sqlite3.connect(f"file:{Path(content).as_posix()}?mode=ro", uri=True)
    ) as conn:
        conn.execute("PRAGMA query_only=ON")
        existing = _existing_table_names(conn)
        for label, tables in _SUMMARY_TABLES.items():
            summary[label] = sum(
                _table_count(conn, table, existing_tables=existing) for table in tables
            )
    summary["trash"] = 0
    if trash is not None and Path(trash).is_file():
        with contextlib.closing(
            sqlite3.connect(f"file:{Path(trash).as_posix()}?mode=ro", uri=True)
        ) as conn:
            conn.execute("PRAGMA query_only=ON")
            summary["trash"] = _table_count(conn, "trashed")
    summary["meaningful_records"] = sum(summary.values())
    return summary


def _lineage_parent(account_slug: str) -> str | None:
    """이 PC가 마지막으로 알고 있는 계정 백업을 새 스냅샷의 부모로 사용한다."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT backup_set_id FROM worker_backup_outbox "
            "WHERE account_slug=? AND status IN ('pending','running','done') "
            "ORDER BY created_at DESC LIMIT 1",
            (account_slug,),
        ).fetchone()
        if row is not None:
            return str(row[0])
        state = conn.execute(
            "SELECT last_backup_set_id FROM worker_backup_delivery_state WHERE account_slug=?",
            (account_slug,),
        ).fetchone()
        return str(state[0]) if state and state[0] else None


def adopt_restored_backup(backup_set_id: str, *, account_email: str) -> None:
    """선택 복원 뒤 옛 PC 전송 대기열을 폐기하고 새 작업의 부모 버전을 고정한다."""
    if not _SET_ID_RE.fullmatch(backup_set_id):
        raise ValueError("invalid backup set id")
    account_slug = active_account.slug(account_email)
    superseded: list[str] = []
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            rows = conn.execute(
                "SELECT backup_set_id FROM worker_backup_outbox "
                "WHERE account_slug=? AND status IN ('pending','running')",
                (account_slug,),
            ).fetchall()
            superseded = [str(row[0]) for row in rows]
            conn.execute(
                "UPDATE worker_backup_outbox SET status='superseded',last_error_code='restored_new_base' "
                "WHERE account_slug=? AND status IN ('pending','running','done')",
                (account_slug,),
            )
            conn.execute(
                "INSERT INTO worker_backup_delivery_state(account_slug,last_backup_set_id,last_error_code) "
                "VALUES(?,?,NULL) ON CONFLICT(account_slug) DO UPDATE SET "
                "last_backup_set_id=excluded.last_backup_set_id,last_error_code=NULL",
                (account_slug, backup_set_id),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    for old_id in superseded:
        with contextlib.suppress(OSError):
            shutil.rmtree(_stage_dir(account_slug, old_id))


def record_queue_failure(error_code: str, *, account_email: str | None = None) -> None:
    """staging 자체가 실패한 경우에도 마지막 오류를 머신 상태 DB에 남긴다."""
    email = account_email or active_account.account_key()
    if not email:
        return
    account_slug = active_account.slug(email)
    now = _utc_now()
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO worker_backup_delivery_state"
                "(account_slug,last_attempt_at,last_error_code) VALUES(?,?,?) "
                "ON CONFLICT(account_slug) DO UPDATE SET "
                "last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code",
                (account_slug, now, str(error_code)[:64]),
            )
    except sqlite3.Error:
        pass


def queue_backup_set(
    content_backup: Path,
    *,
    account_email: str | None = None,
) -> str | None:
    """검증된 로컬 백업에서 전송 전용 content·trash 사본을 원자적으로 staging한다."""
    email = account_email or active_account.account_key()
    if not email:
        return None
    content_backup = Path(content_backup).resolve()
    if not content_backup.is_file():
        raise FileNotFoundError(content_backup)
    stamp = _stamp_from_content(content_backup)
    account_slug = active_account.slug(email)
    trash_source = content_backup.parent / f"{_TRASH_PREFIX}{stamp}.db"
    source_signature = _source_signature(content_backup, trash_source)
    duplicate = _prechecked_duplicate(account_slug, stamp, source_signature)
    if duplicate is not None:
        return duplicate

    account_root = OUTBOX_DIR / account_slug
    account_root.mkdir(parents=True, exist_ok=True)
    temp = account_root / f".stage-{secrets.token_hex(8)}"
    temp.mkdir(exist_ok=False)
    try:
        content = temp / "content.db"
        shutil.copyfile(content_backup, content)
        strip_transfer_secrets(content)
        _verify_transfer_secrets_removed(content)
        validate_hub_db(content, require_integrity=True)

        role_paths: dict[str, Path] = {"content": content}
        if trash_source.is_file():
            trash = temp / "trash.db"
            shutil.copyfile(trash_source, trash)
            _validate_trash(trash)
            role_paths["trash"] = trash

        roles = {role: _role_info(path) for role, path in sorted(role_paths.items())}
        summary = metadata_summary(content, role_paths.get("trash"))
        # 새 PC 로그인 직후 만들어지는 스키마/기본 작업자뿐인 DB가 서버 최신본처럼 올라가면
        # 기존 작업을 찾기 어려워진다. 의미 있는 개인 기록이 생기기 전에는 자동 전송하지 않는다.
        if summary["meaningful_records"] <= 0:
            shutil.rmtree(temp)
            now = _utc_now()
            with _connect() as conn:
                conn.execute(
                    "INSERT INTO worker_backup_delivery_state"
                    "(account_slug,last_attempt_at,last_error_code) VALUES(?,?,?) "
                    "ON CONFLICT(account_slug) DO UPDATE SET "
                    "last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code",
                    (account_slug, now, "empty_metadata"),
                )
            log_event(_log, "worker_backup_empty_skipped")
            return None

        stable_source_signature = (
            source_signature
            if source_signature == _source_signature(content_backup, trash_source)
            else None
        )
        device = _device_identity()
        parent_backup_set_id = _lineage_parent(account_slug)
        roles_json = json.dumps(roles, sort_keys=True, separators=(",", ":"))
        # 같은 PC에서 DB 파일의 수정 시각만 달라진 경우에는 새 세트를 만들지 않는다.
        # 단, 사용자가 과거 버전을 복원해 기존 행이 superseded 된 경우에는 아래 ID 계산으로
        # 복원본을 부모로 둔 새 불변 세트를 만들어 계보를 이어간다.
        with _connect() as conn:
            unchanged = conn.execute(
                "SELECT backup_set_id FROM worker_backup_outbox "
                "WHERE account_slug=? AND roles_json=? "
                "AND status IN ('pending','running','done') "
                "ORDER BY created_at DESC LIMIT 1",
                (account_slug, roles_json),
            ).fetchone()
        if unchanged is not None:
            shutil.rmtree(temp)
            backup_set_id = str(unchanged[0])
            _remember_source_state(
                account_slug,
                stamp,
                stable_source_signature,
                backup_set_id,
            )
            return backup_set_id
        identity = json.dumps(
            {
                "account_slug": account_slug,
                "device_id": device["device_id"],
                "parent_backup_set_id": parent_backup_set_id,
                "roles": roles,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        backup_set_id = hashlib.sha256(identity).hexdigest()
        manifest = {
            "format": _FORMAT,
            "format_version": _FORMAT_VERSION,
            "backup_set_id": backup_set_id,
            "created_at": _utc_now(),
            "local_stamp": stamp,
            "schema_version": _sqlite_user_version(content),
            "app_version": _app_version(),
            "device": device,
            "parent_backup_set_id": parent_backup_set_id,
            "summary": summary,
            "roles": roles,
        }
        atomic_write_text(
            temp / "manifest.json",
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        )
        final = _stage_dir(account_slug, backup_set_id)
        with _connect() as conn:
            existing = conn.execute(
                "SELECT status FROM worker_backup_outbox WHERE backup_set_id=?",
                (backup_set_id,),
            ).fetchone()
        if existing is not None and str(existing[0]) in {"pending", "running", "done"}:
            shutil.rmtree(temp)
            _remember_source_state(
                account_slug,
                stamp,
                stable_source_signature,
                backup_set_id,
            )
            return backup_set_id
        if final.exists():
            shutil.rmtree(final)
        os.replace(temp, final)

        superseded: list[str] = []
        with _connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "INSERT INTO worker_backup_outbox"
                    "(backup_set_id,account_slug,created_at,local_stamp,roles_json,status) "
                    "VALUES(?,?,?,?,?,'pending') ON CONFLICT(backup_set_id) DO NOTHING",
                    (
                        backup_set_id,
                        account_slug,
                        manifest["created_at"],
                        stamp,
                        roles_json,
                    ),
                )
                rows = conn.execute(
                    "SELECT backup_set_id FROM worker_backup_outbox "
                    "WHERE account_slug=? AND status='pending' "
                    "ORDER BY created_at DESC",
                    (account_slug,),
                ).fetchall()
                superseded = [row[0] for row in rows[_MAX_PENDING_PER_ACCOUNT:]]
                if superseded:
                    placeholders = ",".join("?" for _ in superseded)
                    conn.execute(
                        f"UPDATE worker_backup_outbox SET status='superseded' "
                        f"WHERE backup_set_id IN ({placeholders})",
                        superseded,
                    )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        for old_id in superseded:
            with contextlib.suppress(OSError):
                shutil.rmtree(_stage_dir(account_slug, old_id))
        _remember_source_state(
            account_slug,
            stamp,
            stable_source_signature,
            backup_set_id,
        )
        log_event(
            _log,
            "worker_backup_queued",
            backup_roles=len(roles),
            superseded=len(superseded),
        )
        return backup_set_id
    except BaseException:
        with contextlib.suppress(OSError):
            shutil.rmtree(temp)
        record_queue_failure("staging_failed", account_email=email)
        log_event(_log, "worker_backup_queue_failed", level=logging.ERROR, exc_info=True)
        raise


def queue_latest_local_backup() -> str | None:
    """기능 업데이트 전에 이미 만들어진 최신 로컬 세트도 outbox에 보강한다."""
    from .backup import latest_backup_path

    latest = latest_backup_path()
    return queue_backup_set(latest) if latest is not None else None


def recover_in_progress() -> int:
    """비정상 종료가 남긴 running을 재시도 가능 상태로 되돌린다."""
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE worker_backup_outbox SET status='pending',last_error_code='interrupted',"
            "next_retry_ts=NULL WHERE status='running'"
        )
        return max(0, int(cursor.rowcount or 0))


def cleanup_stale_state() -> dict[str, int]:
    """재시작 뒤 불완전 임시폴더·전송이 끝난 사본·오래된 상태 이력을 제한한다.

    pending/running 행의 최종 staging은 절대 지우지 않는다. 서버 전송이 끝난 사본만 지우며,
    로컬 ``backups`` 원본과 공유 서버/NAS의 백업은 이 함수 범위 밖이다.
    """
    active_ids: set[str] = set()
    removed_rows = 0
    with _connect() as conn:
        active_ids = {
            str(row[0])
            for row in conn.execute(
                "SELECT backup_set_id FROM worker_backup_outbox "
                "WHERE status IN ('pending','running')"
            ).fetchall()
        }
        accounts = [
            str(row[0])
            for row in conn.execute(
                "SELECT DISTINCT account_slug FROM worker_backup_outbox"
            ).fetchall()
        ]
        for account_slug in accounts:
            rows = conn.execute(
                "SELECT backup_set_id FROM worker_backup_outbox "
                "WHERE account_slug=? AND status IN ('done','superseded') "
                "ORDER BY COALESCE(last_success_at,created_at) DESC",
                (account_slug,),
            ).fetchall()
            old_ids = [str(row[0]) for row in rows[_HISTORY_KEEP_PER_ACCOUNT:]]
            if not old_ids:
                continue
            placeholders = ",".join("?" for _ in old_ids)
            cursor = conn.execute(
                f"DELETE FROM worker_backup_outbox WHERE backup_set_id IN ({placeholders})",
                old_ids,
            )
            removed_rows += max(0, int(cursor.rowcount or 0))

    removed_dirs = 0
    if OUTBOX_DIR.is_dir():
        try:
            account_dirs = list(OUTBOX_DIR.iterdir())
        except OSError:
            account_dirs = []
        for account_dir in account_dirs:
            if not account_dir.is_dir():
                continue
            try:
                children = list(account_dir.iterdir())
            except OSError:
                continue
            for child in children:
                if not child.is_dir():
                    continue
                removable = child.name.startswith(".stage-") or (
                    _SET_ID_RE.fullmatch(child.name) is not None and child.name not in active_ids
                )
                if not removable:
                    continue
                try:
                    shutil.rmtree(child)
                    removed_dirs += 1
                except OSError:
                    continue
    return {"rows": removed_rows, "directories": removed_dirs}


def retry_pending() -> int:
    """활성 계정의 대기 작업을 즉시 재시도 가능하게 만든다."""
    account_slug = _active_slug()
    if not account_slug:
        return 0
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE worker_backup_outbox SET next_retry_ts=NULL "
            "WHERE account_slug=? AND status='pending'",
            (account_slug,),
        )
        return max(0, int(cursor.rowcount or 0))


def _active_slug() -> str | None:
    email = active_account.account_key()
    return active_account.slug(email) if email else None


def has_due_backup() -> bool:
    account_slug = _active_slug()
    if not account_slug:
        return False
    with _connect() as conn:
        return conn.execute(
            "SELECT 1 FROM worker_backup_outbox WHERE account_slug=? AND status='pending' "
            "AND (next_retry_ts IS NULL OR next_retry_ts<=?) LIMIT 1",
            (account_slug, time.time()),
        ).fetchone() is not None


def _claim_due() -> dict[str, Any] | None:
    account_slug = _active_slug()
    if not account_slug:
        return None
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM worker_backup_outbox WHERE account_slug=? AND status='pending' "
                "AND (next_retry_ts IS NULL OR next_retry_ts<=?) "
                "ORDER BY created_at ASC LIMIT 1",
                (account_slug, time.time()),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            now = _utc_now()
            cursor = conn.execute(
                "UPDATE worker_backup_outbox SET status='running',attempts=attempts+1,"
                "last_attempt_at=?,last_error_code=NULL WHERE backup_set_id=? AND status='pending'",
                (now, row["backup_set_id"]),
            )
            if cursor.rowcount != 1:
                conn.execute("ROLLBACK")
                return None
            conn.execute(
                "INSERT INTO worker_backup_delivery_state(account_slug,last_attempt_at,last_error_code) "
                "VALUES(?,?,NULL) ON CONFLICT(account_slug) DO UPDATE SET "
                "last_attempt_at=excluded.last_attempt_at,last_error_code=NULL",
                (account_slug, now),
            )
            conn.execute("COMMIT")
            result = dict(row)
            result["attempts"] = int(row["attempts"] or 0) + 1
            result["last_attempt_at"] = now
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _safe_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8") or "null")
    except (UnicodeDecodeError, ValueError):
        return None


def _multipart_set_upload(
    url: str,
    token: str,
    manifest: dict[str, Any],
    role_paths: dict[str, Path],
    *,
    timeout: float,
) -> tuple[int, Any]:
    boundary = "----mvhubset" + secrets.token_hex(8)
    boundary_bytes = boundary.encode("ascii")
    manifest_bytes = json.dumps(
        manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    parts: list[tuple[bytes, Path | None]] = []
    parts.append(
        (
            b"--" + boundary_bytes + b"\r\n"
            + b'Content-Disposition: form-data; name="manifest"\r\n'
            + b"Content-Type: application/json; charset=utf-8\r\n\r\n"
            + manifest_bytes
            + b"\r\n",
            None,
        )
    )
    for role in sorted(role_paths):
        header = (
            b"--" + boundary_bytes + b"\r\n"
            + f'Content-Disposition: form-data; name="{role}"; filename="{role}.db"\r\n'.encode("ascii")
            + b"Content-Type: application/octet-stream\r\n\r\n"
        )
        parts.append((header, role_paths[role]))
    suffix = b"--" + boundary_bytes + b"--\r\n"
    content_length = len(suffix)
    for header, path in parts:
        content_length += len(header)
        if path is not None:
            content_length += path.stat().st_size + 2  # trailing CRLF

    def chunks():
        for header, path in parts:
            yield header
            if path is not None:
                with path.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        yield chunk
                yield b"\r\n"
        yield suffix

    request = urllib.request.Request(url, data=chunks(), method="POST")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    request.add_header("Content-Length", str(content_length))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _safe_json(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, _safe_json(exc.read())


def _verify_ack(
    response: Any,
    manifest: dict[str, Any],
) -> bool:
    if not isinstance(response, dict) or response.get("accepted") is not True:
        return False
    if response.get("backup_set_id") != manifest["backup_set_id"]:
        return False
    files = response.get("files")
    if not isinstance(files, dict) or set(files) != set(manifest["roles"]):
        return False
    for role, expected in manifest["roles"].items():
        actual = files.get(role)
        if not isinstance(actual, dict):
            return False
        if actual.get("sha256") != expected["sha256"]:
            return False
        if int(actual.get("size") or -1) != int(expected["size"]):
            return False
    return True


def _mark_failure(row: dict[str, Any], error_code: str) -> None:
    attempts = max(1, int(row.get("attempts") or 1))
    if error_code == "login_required":
        delay = 300
    elif error_code == "server_update_required":
        delay = 3600
    else:
        delay = min(3600, 60 * attempts * attempts)
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "UPDATE worker_backup_outbox SET status='pending',last_error_code=?,"
                "next_retry_ts=? WHERE backup_set_id=? AND status='running'",
                (error_code, time.time() + delay, row["backup_set_id"]),
            )
            conn.execute(
                "INSERT INTO worker_backup_delivery_state"
                "(account_slug,last_attempt_at,last_error_code) VALUES(?,?,?) "
                "ON CONFLICT(account_slug) DO UPDATE SET "
                "last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code",
                (row["account_slug"], row["last_attempt_at"], error_code),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    log_event(_log, "worker_backup_delivery_failed", level=logging.WARNING, error_code=error_code)


def _mark_success(row: dict[str, Any]) -> None:
    now = _utc_now()
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cursor = conn.execute(
                "UPDATE worker_backup_outbox SET status='done',last_success_at=?,"
                "last_error_code=NULL,next_retry_ts=NULL WHERE backup_set_id=? AND status='running'",
                (now, row["backup_set_id"]),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("backup outbox revision changed")
            conn.execute(
                "INSERT INTO worker_backup_delivery_state"
                "(account_slug,last_attempt_at,last_success_at,last_backup_set_id,last_error_code) "
                "VALUES(?,?,?,?,NULL) ON CONFLICT(account_slug) DO UPDATE SET "
                "last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,"
                "last_backup_set_id=excluded.last_backup_set_id,last_error_code=NULL",
                (row["account_slug"], row["last_attempt_at"], now, row["backup_set_id"]),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    with contextlib.suppress(OSError):
        shutil.rmtree(_stage_dir(row["account_slug"], row["backup_set_id"]))
    log_event(_log, "worker_backup_delivery_succeeded")


def drain_one() -> dict[str, Any]:
    """활성 계정의 전송 가능 세트 한 건을 보낸다. 예외 원문은 상태·출력에 저장하지 않는다."""
    row = _claim_due()
    if row is None:
        return {"state": "idle"}
    stage = _stage_dir(row["account_slug"], row["backup_set_id"])
    try:
        manifest = json.loads((stage / "manifest.json").read_text("utf-8"))
        if (
            not isinstance(manifest, dict)
            or manifest.get("backup_set_id") != row["backup_set_id"]
            or manifest.get("format") != _FORMAT
            or manifest.get("format_version") != _FORMAT_VERSION
        ):
            raise ValueError("invalid manifest")
        roles = manifest.get("roles")
        if not isinstance(roles, dict) or "content" not in roles or not set(roles) <= {"content", "trash"}:
            raise ValueError("invalid roles")
        role_paths = {role: stage / f"{role}.db" for role in roles}
        for role, path in role_paths.items():
            expected = roles[role]
            if (
                not path.is_file()
                or path.stat().st_size != int(expected.get("size") or -1)
                or _sha256(path) != expected.get("sha256")
            ):
                raise ValueError("staged file mismatch")
        if role_paths.get("content"):
            validate_hub_db(role_paths["content"], require_integrity=True)
        if role_paths.get("trash"):
            _validate_trash(role_paths["trash"])
    except (OSError, ValueError, TypeError, sqlite3.Error):
        _mark_failure(row, "staging_invalid")
        return {"state": "failed", "error_code": "staging_invalid"}

    # 연결 정보는 shared_connection 단일 출처(키·기본 주소·후행 슬래시 규칙 공유).
    token = shared_connection.token()
    if not token:
        _mark_failure(row, "login_required")
        return {"state": "login_required", "error_code": "login_required"}
    server = shared_connection.base_url()
    try:
        status, response = _multipart_set_upload(
            f"{server}/api/db-backup/sets",
            token,
            manifest,
            role_paths,
            timeout=UPLOAD_TIMEOUT,
        )
    except (urllib.error.URLError, TimeoutError, OSError):
        _mark_failure(row, "network_unavailable")
        return {"state": "failed", "error_code": "network_unavailable"}
    if status == 401:
        _mark_failure(row, "login_required")
        return {"state": "login_required", "error_code": "login_required"}
    if status in {404, 405}:
        _mark_failure(row, "server_update_required")
        return {"state": "server_update_required", "error_code": "server_update_required"}
    if not (200 <= status < 300):
        _mark_failure(row, "server_rejected")
        return {"state": "failed", "error_code": "server_rejected"}
    if not _verify_ack(response, manifest):
        _mark_failure(row, "ack_mismatch")
        return {"state": "failed", "error_code": "ack_mismatch"}
    _mark_success(row)
    return {
        "state": "success",
        "backup_set_id": row["backup_set_id"],
        "server_count": max(0, int(response.get("count") or 0)),
        "conflict": bool(response.get("conflict")),
        "is_current": bool(response.get("is_current", True)),
    }


def status_snapshot() -> dict[str, Any]:
    """활성 작업자 계정의 로컬·원격 백업 상태. 이메일·경로·세트 ID는 노출하지 않는다."""
    account_slug = _active_slug()
    if not account_slug:
        return {
            "automatic": True,
            "state": "login_required",
            "pending": 0,
            "failed": 0,
            "last_attempt_at": None,
            "last_success_at": None,
            "last_error_code": "login_required",
        }
    with _connect() as conn:
        counts = conn.execute(
            "SELECT "
            "SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,"
            "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,"
            "SUM(CASE WHEN status='pending' AND last_error_code IS NOT NULL THEN 1 ELSE 0 END) failed,"
            "MIN(CASE WHEN status IN ('pending','running') THEN created_at END) oldest "
            "FROM worker_backup_outbox WHERE account_slug=?",
            (account_slug,),
        ).fetchone()
        state = conn.execute(
            "SELECT * FROM worker_backup_delivery_state WHERE account_slug=?",
            (account_slug,),
        ).fetchone()
    pending = int((counts["pending"] if counts else 0) or 0)
    running = int((counts["running"] if counts else 0) or 0)
    failed = int((counts["failed"] if counts else 0) or 0)
    last_error = state["last_error_code"] if state else None
    last_success = state["last_success_at"] if state else None
    if running:
        display_state = "uploading"
    elif pending and last_error in {"login_required", "server_update_required"}:
        display_state = last_error
    elif pending and failed:
        display_state = "failed"
    elif pending:
        display_state = "pending"
    elif last_success:
        display_state = "success"
    elif last_error == "empty_metadata":
        display_state = "waiting_for_data"
    else:
        display_state = "waiting_for_backup"
    return {
        "automatic": True,
        "state": display_state,
        "pending": pending + running,
        "failed": failed,
        "oldest_pending_at": counts["oldest"] if counts else None,
        "last_attempt_at": state["last_attempt_at"] if state else None,
        "last_success_at": last_success,
        "last_error_code": last_error,
    }


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None and os.name == "nt" and process.pid:
        killer: asyncio.subprocess.Process | None = None
        try:
            killer = await asyncio.create_subprocess_exec(
                shutil.which("taskkill.exe") or r"C:\Windows\System32\taskkill.exe",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            await asyncio.wait_for(killer.wait(), timeout=5)
        except (OSError, asyncio.TimeoutError):
            if killer and killer.returncode is None:
                with contextlib.suppress(OSError):
                    killer.kill()
    if process.returncode is None:
        with contextlib.suppress(OSError):
            process.kill()
    with contextlib.suppress(OSError, asyncio.TimeoutError):
        await asyncio.wait_for(process.wait(), timeout=5)


class PeriodicWorkerBackupUpload:
    """전송을 별도 Python 프로세스에서 실행해 NAS·네트워크 hang이 앱 종료를 붙잡지 않게 한다."""

    def __init__(self, interval: float = UPLOAD_INTERVAL) -> None:
        self._interval = max(15.0, float(interval))
        self._task: Optional[asyncio.Task] = None
        self._run_lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-worker-backup")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        if self._process and self._process.returncode is None:
            await _terminate_process(self._process)
            await asyncio.to_thread(recover_in_progress)
        self._process = None

    async def _run(self) -> None:
        await asyncio.to_thread(recover_in_progress)
        await asyncio.to_thread(cleanup_stale_state)
        await asyncio.sleep(3)
        while True:
            # due 판정은 run_now() 안(락 아래)에서 한 번만 — 종전엔 여기서 확인하고 run_now 가
            # 즉시 재확인해 상태 DB 조회(스키마 보장 포함)가 두 배로 돌았다(R4 A-2).
            await self.run_now()
            await asyncio.sleep(self._interval)

    async def run_now(self) -> dict[str, Any]:
        async with self._run_lock:
            if not await asyncio.to_thread(has_due_backup):
                return {"state": "idle"}
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "app.services.worker_backup",
                "--drain-one",
                cwd=str(BACKEND_DIR),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=flags,
            )
            self._process = process
            try:
                stdout, _ = await asyncio.wait_for(
                    process.communicate(), timeout=UPLOAD_TIMEOUT + 15
                )
            except asyncio.CancelledError:
                await _terminate_process(process)
                await asyncio.to_thread(recover_in_progress)
                raise
            except asyncio.TimeoutError:
                await _terminate_process(process)
                await asyncio.to_thread(recover_in_progress)
                return {"state": "failed", "error_code": "timeout"}
            finally:
                if self._process is process:
                    self._process = None
            # ACK 뒤 로컬 done 기록에서 자식이 죽은 경우를 포함한다. 서버의 backup_set_id
            # 저장은 멱등이므로 다음 전송이 가능하도록 남은 running claim을 즉시 되돌린다.
            if process.returncode != 0:
                await asyncio.to_thread(recover_in_progress)
            try:
                # 운영 로깅 설정이 stdout 한 줄을 먼저 남기더라도 마지막 JSON 결과는 읽는다.
                output = (stdout or b"{}").decode("utf-8").splitlines()
                parsed = json.loads(output[-1] if output else "{}")
                if not isinstance(parsed, dict):
                    await asyncio.to_thread(recover_in_progress)
                    return {"state": "failed", "error_code": "worker_failed"}
                if process.returncode != 0 and parsed.get("state") != "failed":
                    return {"state": "failed", "error_code": "worker_failed"}
                return parsed
            except (UnicodeDecodeError, ValueError):
                await asyncio.to_thread(recover_in_progress)
                return {"state": "failed", "error_code": "worker_failed"}


periodic_worker_backup = PeriodicWorkerBackupUpload()


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--drain-one", action="store_true")
    args = parser.parse_args(argv)
    if not args.drain_one:
        return 2
    result = drain_one()
    print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0 if result.get("state") in {"idle", "success", "login_required", "server_update_required"} else 1


if __name__ == "__main__":
    raise SystemExit(_main())
