from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import sqlite3
import threading
import urllib.error
import zipfile
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import active_account
from app.routers import db_backup, db_transfer
from app.services import worker_backup


def _content_db(path: Path, *, secret: bool = True) -> bytes:
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO generation(id) VALUES('generation-1')")
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT)")
        if secret:
            conn.execute(
                "INSERT INTO app_setting VALUES('shared_server_token','private-token')"
            )
        conn.commit()
    return path.read_bytes()


def _trash_db(path: Path) -> bytes:
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE trashed(id TEXT PRIMARY KEY)")
        conn.commit()
    return path.read_bytes()


def test_state_schema_ensured_once_per_path_and_reensured_on_replacement(
    worker_store, monkeypatch: pytest.MonkeyPatch
):
    """R4 A-1: 스키마 보장은 (프로세스, 경로)당 1회 — 경로 교체·파일 재생성 때만 다시 돈다."""
    worker_backup._STATE_SCHEMA_READY.clear()
    calls: list[int] = []
    original = worker_backup._ensure_schema

    def counting_ensure(conn):
        calls.append(1)
        return original(conn)

    monkeypatch.setattr(worker_backup, "_ensure_schema", counting_ensure)
    worker_backup._connect().close()
    worker_backup._connect().close()
    assert len(calls) == 1  # 두 번째 연결은 DDL 생략
    worker_backup.STATE_DB.unlink()  # 같은 경로 삭제-재생성 → 재보장
    worker_backup._connect().close()
    assert len(calls) == 2
    monkeypatch.setattr(worker_backup, "STATE_DB", worker_store / "other-state.db")
    worker_backup._connect().close()  # 경로 교체 → 재보장
    assert len(calls) == 3
    worker_backup._STATE_SCHEMA_READY.clear()


def test_state_schema_concurrent_first_entry_ensures_once(
    worker_store, monkeypatch: pytest.MonkeyPatch
):
    """R4 A-1(코덱스 P1): 최초 '동시' 진입에도 스키마 보장은 정확히 1회 — check 와 ready
    등록이 별도 lock 구간이면 스레드마다 WAL+DDL 이 돌아 계약 위반·잠금 오류가 가능했다."""
    worker_backup._STATE_SCHEMA_READY.clear()
    calls: list[int] = []
    original = worker_backup._ensure_schema

    def counting_ensure(conn):
        calls.append(1)
        return original(conn)

    monkeypatch.setattr(worker_backup, "_ensure_schema", counting_ensure)
    barrier = threading.Barrier(4)

    def first_entry():
        barrier.wait()  # 4스레드가 동시에 최초 진입하도록 정렬
        worker_backup._connect().close()

    with ThreadPoolExecutor(max_workers=4) as pool:
        for future in [pool.submit(first_entry) for _ in range(4)]:
            future.result()
    assert len(calls) == 1
    worker_backup._STATE_SCHEMA_READY.clear()


@pytest.fixture
def worker_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(worker_backup, "STATE_DB", tmp_path / "worker-state.db")
    monkeypatch.setattr(worker_backup, "OUTBOX_DIR", tmp_path / "outbox")
    monkeypatch.setattr(worker_backup, "DEVICE_IDENTITY_PATH", tmp_path / "device.json")
    token = active_account.set_override("artist@example.com")
    try:
        yield tmp_path
    finally:
        active_account.reset_override(token)


def _queued(worker_store: Path) -> tuple[str, Path, dict]:
    backup_dir = worker_store / "local"
    backup_dir.mkdir()
    content = backup_dir / "content_hub_20260817_120000_000001.db"
    trash = backup_dir / "content_trash_20260817_120000_000001.db"
    _content_db(content)
    _trash_db(trash)
    backup_set_id = worker_backup.queue_backup_set(content)
    assert backup_set_id
    stage = worker_backup.OUTBOX_DIR / active_account.slug("artist@example.com") / backup_set_id
    manifest = json.loads((stage / "manifest.json").read_text("utf-8"))
    return backup_set_id, stage, manifest


def test_queue_is_atomic_deduplicated_and_strips_secrets(worker_store: Path):
    backup_set_id, stage, manifest = _queued(worker_store)

    assert set(manifest["roles"]) == {"content", "trash"}
    assert manifest["backup_set_id"] == backup_set_id
    with sqlite3.connect(stage / "content.db") as conn:
        assert conn.execute(
            "SELECT value FROM app_setting WHERE key='shared_server_token'"
        ).fetchone() is None

    source = worker_store / "local" / "content_hub_20260817_120000_000001.db"
    assert worker_backup.queue_backup_set(source) == backup_set_id
    with worker_backup._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM worker_backup_outbox").fetchone()[0] == 1
    assert not list(stage.parent.glob(".stage-*"))


def test_prechecked_duplicate_skips_copy_and_hash(
    worker_store: Path, monkeypatch: pytest.MonkeyPatch
):
    backup_set_id, stage, _manifest = _queued(worker_store)
    source = worker_store / "local" / "content_hub_20260817_120000_000001.db"

    monkeypatch.setattr(
        worker_backup.shutil,
        "copyfile",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("copy called")),
    )
    monkeypatch.setattr(
        worker_backup,
        "_sha256",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("hash called")),
    )

    assert worker_backup.queue_backup_set(source) == backup_set_id
    assert stage.is_dir()
    assert not list(stage.parent.glob(".stage-*"))


def test_same_stamp_with_changed_content_falls_back_to_full_check(
    worker_store: Path, monkeypatch: pytest.MonkeyPatch
):
    first_id, _stage, _manifest = _queued(worker_store)
    source = worker_store / "local" / "content_hub_20260817_120000_000001.db"
    source_stat = source.stat()
    with sqlite3.connect(source) as conn:
        conn.execute("UPDATE generation SET id='generation-2' WHERE id='generation-1'")
    os.utime(
        source,
        ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
    )
    assert source.stat().st_size == source_stat.st_size

    copy_calls = 0
    hash_calls = 0
    real_copyfile = worker_backup.shutil.copyfile
    real_sha256 = worker_backup._sha256

    def tracked_copyfile(*args, **kwargs):
        nonlocal copy_calls
        copy_calls += 1
        return real_copyfile(*args, **kwargs)

    def tracked_sha256(*args, **kwargs):
        nonlocal hash_calls
        hash_calls += 1
        return real_sha256(*args, **kwargs)

    monkeypatch.setattr(worker_backup.shutil, "copyfile", tracked_copyfile)
    monkeypatch.setattr(worker_backup, "_sha256", tracked_sha256)

    second_id = worker_backup.queue_backup_set(source)

    assert second_id and second_id != first_id
    assert copy_calls == 2
    assert hash_calls == 2
    with worker_backup._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM worker_backup_outbox").fetchone()[0] == 2


def test_explicit_ack_is_required_before_staging_is_removed(
    worker_store: Path, monkeypatch: pytest.MonkeyPatch
):
    backup_set_id, stage, manifest = _queued(worker_store)
    monkeypatch.setattr(
        worker_backup.repo,
        "get_setting",
        lambda key: "token" if key == "shared_server_token" else "http://server",
    )
    monkeypatch.setattr(
        worker_backup,
        "_multipart_set_upload",
        lambda *_args, **_kwargs: (
            200,
            {"accepted": True, "backup_set_id": "0" * 64, "files": manifest["roles"]},
        ),
    )

    result = worker_backup.drain_one()
    assert result == {"state": "failed", "error_code": "ack_mismatch"}
    assert stage.is_dir()
    with worker_backup._connect() as conn:
        row = conn.execute(
            "SELECT status,last_error_code FROM worker_backup_outbox WHERE backup_set_id=?",
            (backup_set_id,),
        ).fetchone()
    assert tuple(row) == ("pending", "ack_mismatch")


def test_successful_ack_completes_exact_set(worker_store: Path, monkeypatch: pytest.MonkeyPatch):
    backup_set_id, stage, manifest = _queued(worker_store)
    monkeypatch.setattr(
        worker_backup.repo,
        "get_setting",
        lambda key: "token" if key == "shared_server_token" else "http://server",
    )
    monkeypatch.setattr(
        worker_backup,
        "_multipart_set_upload",
        lambda *_args, **_kwargs: (
            200,
            {
                "accepted": True,
                "backup_set_id": backup_set_id,
                "files": manifest["roles"],
                "count": 1,
            },
        ),
    )

    result = worker_backup.drain_one()
    assert result["state"] == "success"
    assert result["server_count"] == 1
    assert not stage.exists()
    assert worker_backup.status_snapshot()["state"] == "success"


def test_network_outage_keeps_set_and_recovers_after_manual_retry(
    worker_store: Path, monkeypatch: pytest.MonkeyPatch
):
    backup_set_id, stage, manifest = _queued(worker_store)
    monkeypatch.setattr(
        worker_backup.repo,
        "get_setting",
        lambda key: "token" if key == "shared_server_token" else "http://server",
    )
    monkeypatch.setattr(
        worker_backup,
        "_multipart_set_upload",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )

    failed = worker_backup.drain_one()
    assert failed == {"state": "failed", "error_code": "network_unavailable"}
    assert stage.is_dir()
    assert worker_backup.status_snapshot()["pending"] == 1

    worker_backup.retry_pending()
    monkeypatch.setattr(
        worker_backup,
        "_multipart_set_upload",
        lambda *_args, **_kwargs: (
            200,
            {
                "accepted": True,
                "backup_set_id": backup_set_id,
                "files": manifest["roles"],
                "count": 1,
            },
        ),
    )
    recovered = worker_backup.drain_one()
    assert recovered["state"] == "success"
    assert worker_backup.status_snapshot()["pending"] == 0
    assert worker_backup.status_snapshot()["last_success_at"]


def test_login_expiry_never_discards_pending_set(
    worker_store: Path, monkeypatch: pytest.MonkeyPatch
):
    backup_set_id, stage, manifest = _queued(worker_store)
    settings: dict[str, str | None] = {
        "shared_server_token": None,
        "shared_server_url": "http://server",
    }
    monkeypatch.setattr(worker_backup.repo, "get_setting", settings.get)

    waiting = worker_backup.drain_one()
    assert waiting["state"] == "login_required"
    assert stage.is_dir()
    assert worker_backup.status_snapshot()["state"] == "login_required"

    settings["shared_server_token"] = "new-token"
    worker_backup.retry_pending()
    monkeypatch.setattr(
        worker_backup,
        "_multipart_set_upload",
        lambda *_args, **_kwargs: (
            200,
            {
                "accepted": True,
                "backup_set_id": backup_set_id,
                "files": manifest["roles"],
                "count": 1,
            },
        ),
    )
    assert worker_backup.drain_one()["state"] == "success"
    assert not stage.exists()


def test_interrupted_running_row_is_recovered(worker_store: Path):
    backup_set_id, _stage, _manifest = _queued(worker_store)
    with worker_backup._connect() as conn:
        conn.execute(
            "UPDATE worker_backup_outbox SET status='running' WHERE backup_set_id=?",
            (backup_set_id,),
        )
    assert worker_backup.recover_in_progress() == 1
    with worker_backup._connect() as conn:
        row = conn.execute(
            "SELECT status,last_error_code FROM worker_backup_outbox WHERE backup_set_id=?",
            (backup_set_id,),
        ).fetchone()
    assert tuple(row) == ("pending", "interrupted")


@pytest.mark.parametrize(
    ("returncode", "stdout"),
    [
        (1, b""),
        (0, b"not-json"),
        (1, b"not-json"),          # R4 A-5: non-zero+깨진 JSON — 종전엔 복구가 2회 돌던 조합
        (1, b"\xff\xfebroken"),    # non-zero+디코드 불가
        (0, b"[]"),                # zero+비-dict JSON
        (0, b""),                  # 코덱스 P1: zero+빈 출력 — 종전 b"{}" 폴백에서 복구 0회
        (0, b"{}"),                # 코덱스 P1: zero+state 누락 dict — 같은 문제
    ],
)
def test_child_failure_or_invalid_result_recovers_running_claim(
    worker_store: Path,
    monkeypatch: pytest.MonkeyPatch,
    returncode: int,
    stdout: bytes,
):
    backup_set_id, _stage, _manifest = _queued(worker_store)

    class FailedChild:
        def __init__(self):
            self.returncode = returncode

        async def communicate(self):
            # 실제 자식의 _claim_due 직후, ACK 처리나 결과 출력 중 죽은 상태를 재현한다.
            with worker_backup._connect() as conn:
                conn.execute(
                    "UPDATE worker_backup_outbox SET status='running' WHERE backup_set_id=?",
                    (backup_set_id,),
                )
            return stdout, b""

    child = FailedChild()

    async def create_child(*_args, **_kwargs):
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_child)
    loop_thread = threading.get_ident()
    recovery_threads: list[int] = []
    real_recover = worker_backup.recover_in_progress

    def tracked_recover():
        recovery_threads.append(threading.get_ident())
        return real_recover()

    monkeypatch.setattr(worker_backup, "recover_in_progress", tracked_recover)

    result = asyncio.run(worker_backup.PeriodicWorkerBackupUpload().run_now())

    assert result == {"state": "failed", "error_code": "worker_failed"}
    assert len(recovery_threads) == 1  # R4 A-5: 어떤 실패 조합에서도 복구는 정확히 1회
    assert all(thread_id != loop_thread for thread_id in recovery_threads)
    with worker_backup._connect() as conn:
        row = conn.execute(
            "SELECT status,last_error_code FROM worker_backup_outbox WHERE backup_set_id=?",
            (backup_set_id,),
        ).fetchone()
    assert tuple(row) == ("pending", "interrupted")


def test_periodic_due_check_does_not_block_event_loop(monkeypatch: pytest.MonkeyPatch):
    entered = threading.Event()
    release = threading.Event()
    call_threads: list[int] = []

    def blocking_due():
        call_threads.append(threading.get_ident())
        entered.set()
        assert release.wait(timeout=2)
        return False

    monkeypatch.setattr(worker_backup, "has_due_backup", blocking_due)

    async def exercise():
        loop_thread = threading.get_ident()
        task = asyncio.create_task(worker_backup.PeriodicWorkerBackupUpload().run_now())
        for _ in range(200):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        # 동기 due 조회가 대기 중이어도 이벤트 루프 coroutine은 계속 실행된다.
        await asyncio.sleep(0)
        release.set()
        result = await asyncio.wait_for(task, timeout=2)
        return loop_thread, result

    loop_thread, result = asyncio.run(exercise())

    assert result == {"state": "idle"}
    assert call_threads and all(thread_id != loop_thread for thread_id in call_threads)


def test_periodic_startup_state_calls_run_off_event_loop(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[str, int]] = []
    monkeypatch.setattr(
        worker_backup,
        "recover_in_progress",
        lambda: calls.append(("recover", threading.get_ident())),
    )
    monkeypatch.setattr(
        worker_backup,
        "cleanup_stale_state",
        lambda: calls.append(("cleanup", threading.get_ident())),
    )

    async def exercise():
        loop_thread = threading.get_ident()
        worker = worker_backup.PeriodicWorkerBackupUpload()
        worker.start()
        for _ in range(200):
            if len(calls) == 2:
                break
            await asyncio.sleep(0.005)
        await worker.stop()
        return loop_thread

    loop_thread = asyncio.run(exercise())

    assert [name for name, _thread in calls] == ["recover", "cleanup"]
    assert all(thread_id != loop_thread for _name, thread_id in calls)


def test_restart_cleanup_keeps_pending_set_and_removes_only_stale_staging(
    worker_store: Path,
):
    backup_set_id, stage, _manifest = _queued(worker_store)
    abandoned = stage.parent / ".stage-abandoned"
    abandoned.mkdir()
    completed = stage.parent / ("f" * 64)
    completed.mkdir()
    with worker_backup._connect() as conn:
        conn.execute(
            "INSERT INTO worker_backup_outbox"
            "(backup_set_id,account_slug,created_at,local_stamp,roles_json,status) "
            "VALUES(?,?,?,?,?,'done')",
            (
                completed.name,
                active_account.slug("artist@example.com"),
                "2026-08-17T12:00:00+00:00",
                "20260817_120000_000002",
                "{}",
            ),
        )

    result = worker_backup.cleanup_stale_state()

    assert result["directories"] == 2
    assert stage.is_dir()
    assert not abandoned.exists()
    assert not completed.exists()
    with worker_backup._connect() as conn:
        assert conn.execute(
            "SELECT status FROM worker_backup_outbox WHERE backup_set_id=?",
            (backup_set_id,),
        ).fetchone()[0] == "pending"


def _server_manifest(content: bytes, trash: bytes) -> dict:
    roles = {
        "content": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()},
        "trash": {"size": len(trash), "sha256": hashlib.sha256(trash).hexdigest()},
    }
    identity = json.dumps(roles, sort_keys=True, separators=(",", ":")).encode()
    return {
        "format": db_backup._SET_FORMAT,
        "format_version": db_backup._SET_FORMAT_VERSION,
        "backup_set_id": hashlib.sha256(identity).hexdigest(),
        "created_at": "2026-08-17T12:00:00+00:00",
        "local_stamp": "20260817_120000_000001",
        "schema_version": 0,
        "app_version": "test",
        "roles": roles,
    }


def _server_manifest_with_parent(
    content: bytes,
    trash: bytes,
    *,
    parent: str | None,
    device_id: str,
) -> dict:
    manifest = _server_manifest(content, trash)
    identity = json.dumps(
        {"roles": manifest["roles"], "device_id": device_id},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    manifest.update(
        {
            "backup_set_id": hashlib.sha256(identity).hexdigest(),
            "parent_backup_set_id": parent,
            "device": {"device_id": device_id, "device_name": f"PC-{device_id[:4]}"},
            "summary": {
                "generations": 1,
                "tags": 0,
                "canvases": 0,
                "assets": 0,
                "projects": 0,
                "trash": 0,
                "meaningful_records": 1,
            },
        }
    )
    return manifest


def test_empty_personal_database_is_not_queued(worker_store: Path):
    backup_dir = worker_store / "empty-local"
    backup_dir.mkdir()
    content = backup_dir / "content_hub_20260817_120000_000001.db"
    with sqlite3.connect(content) as conn:
        conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY)")
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT)")
    assert worker_backup.queue_backup_set(content) is None
    assert worker_backup.status_snapshot()["state"] == "waiting_for_data"
    with worker_backup._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM worker_backup_outbox").fetchone()[0] == 0


def test_manifest_has_safe_device_summary_and_unchanged_data_is_not_requeued(
    worker_store: Path,
):
    backup_set_id, _stage, manifest = _queued(worker_store)
    assert manifest["summary"]["generations"] == 1
    assert manifest["summary"]["meaningful_records"] >= 1
    assert len(manifest["device"]["device_id"]) == 32
    assert manifest["device"]["device_name"]

    second = worker_store / "local" / "content_hub_20260817_130000_000001.db"
    second_trash = worker_store / "local" / "content_trash_20260817_130000_000001.db"
    second.write_bytes((worker_store / "local" / "content_hub_20260817_120000_000001.db").read_bytes())
    second_trash.write_bytes((worker_store / "local" / "content_trash_20260817_120000_000001.db").read_bytes())
    assert worker_backup.queue_backup_set(second) == backup_set_id
    with worker_backup._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM worker_backup_outbox").fetchone()[0] == 1


def test_restore_same_device_content_creates_new_immutable_child(worker_store: Path):
    first_id, _stage, first_manifest = _queued(worker_store)
    worker_backup.adopt_restored_backup(first_id, account_email="artist@example.com")

    source = worker_store / "local" / "content_hub_20260817_120000_000001.db"
    child_id = worker_backup.queue_backup_set(source)

    assert child_id and child_id != first_id
    child_stage = worker_backup.OUTBOX_DIR / active_account.slug("artist@example.com") / child_id
    child_manifest = json.loads((child_stage / "manifest.json").read_text("utf-8"))
    assert child_manifest["parent_backup_set_id"] == first_id
    assert child_manifest["roles"] == first_manifest["roles"]


def test_server_rejects_same_id_with_different_manifest(tmp_path: Path):
    content_path = tmp_path / "content-source.db"
    trash_path = tmp_path / "trash-source.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest_with_parent(
        content, trash, parent=None, device_id="4" * 32
    )
    root = tmp_path / "account"
    db_backup._store_backup_set(
        root,
        manifest,
        {"content": io.BytesIO(content), "trash": io.BytesIO(trash)},
    )
    collision = dict(manifest)
    collision["parent_backup_set_id"] = "f" * 64

    with pytest.raises(db_backup.BackupSetValidationError, match="id collision"):
        db_backup._store_backup_set(
            root,
            collision,
            {"content": io.BytesIO(content), "trash": io.BytesIO(trash)},
        )

    stored = json.loads(
        (root / "sets" / manifest["backup_set_id"] / "manifest.json").read_text("utf-8")
    )
    assert stored == manifest


def test_server_keeps_stale_device_as_conflict_until_user_activates_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    trash_path = tmp_path / "trash.db"
    trash = _trash_db(trash_path)
    root = tmp_path / "account"

    first_path = tmp_path / "first.db"
    first = _content_db(first_path, secret=False)
    first_manifest = _server_manifest_with_parent(
        first, trash, parent=None, device_id="1" * 32
    )
    first_ack = db_backup._store_backup_set(
        root, first_manifest, {"content": io.BytesIO(first), "trash": io.BytesIO(trash)}
    )
    assert first_ack["is_current"] is True

    second_path = tmp_path / "second.db"
    second = _content_db(second_path, secret=False)
    with sqlite3.connect(second_path) as conn:
        conn.execute("INSERT INTO generation(id) VALUES('generation-2')")
    second = second_path.read_bytes()
    second_manifest = _server_manifest_with_parent(
        second, trash, parent=first_manifest["backup_set_id"], device_id="1" * 32
    )
    second_ack = db_backup._store_backup_set(
        root, second_manifest, {"content": io.BytesIO(second), "trash": io.BytesIO(trash)}
    )
    assert second_ack["is_current"] is True

    stale_path = tmp_path / "stale.db"
    stale = _content_db(stale_path, secret=False)
    with sqlite3.connect(stale_path) as conn:
        conn.execute("INSERT INTO generation(id) VALUES('stale-generation')")
    stale = stale_path.read_bytes()
    stale_manifest = _server_manifest_with_parent(
        stale, trash, parent=first_manifest["backup_set_id"], device_id="2" * 32
    )
    stale_ack = db_backup._store_backup_set(
        root, stale_manifest, {"content": io.BytesIO(stale), "trash": io.BytesIO(trash)}
    )
    assert stale_ack["conflict"] is True
    assert stale_ack["is_current"] is False
    assert db_backup._read_head(root / "sets") == second_manifest["backup_set_id"]
    monkeypatch.setattr(db_backup, "_acct", lambda _request: {"email": "artist@example.com"})
    monkeypatch.setattr(db_backup, "_dir", lambda _email: root)
    versions = db_backup.list_backups(object())["backups"]
    by_id = {item.get("backup_set_id"): item for item in versions if item.get("kind") == "set"}
    assert by_id[second_manifest["backup_set_id"]]["branch_status"] == "current"
    assert by_id[first_manifest["backup_set_id"]]["branch_status"] == "history"
    assert by_id[stale_manifest["backup_set_id"]]["branch_status"] == "conflict"
    assert by_id[stale_manifest["backup_set_id"]]["device"]["device_name"] == "PC-2222"

    selected, _manifest, count = db_backup._select_valid_set(
        root, stale_manifest["backup_set_id"]
    )
    assert selected.name == stale_manifest["backup_set_id"]
    assert count == 3
    db_backup._write_head(root / "sets", stale_manifest["backup_set_id"])
    assert db_backup._read_head(root / "sets") == stale_manifest["backup_set_id"]


def test_selected_restore_uses_exact_version_and_adopts_it(
    worker_store: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    content_path = tmp_path / "selected-content.db"
    trash_path = tmp_path / "selected-trash.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest_with_parent(
        content, trash, parent=None, device_id="3" * 32
    )
    archive = tmp_path / "selected.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("content.db", content)
        bundle.writestr("trash.db", trash)

    monkeypatch.setattr(db_transfer, "require_admin", lambda _request: None)
    monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda _request: None)
    monkeypatch.setattr(db_transfer._proxy, "proxying", lambda: True)
    monkeypatch.setattr(db_transfer._proxy, "base_url", lambda: "http://server")
    monkeypatch.setattr(db_transfer._proxy, "token", lambda: "token")
    monkeypatch.setattr(
        db_transfer,
        "_download_to",
        lambda url, _token, destination: (
            destination.write_bytes(archive.read_bytes()) and 200
        ),
    )
    monkeypatch.setattr(
        db_transfer,
        "_install_db",
        lambda _content, **_kwargs: {"ok": True, "relogin_required": True},
    )
    adopted: list[tuple[str, str]] = []
    monkeypatch.setattr(
        db_transfer,
        "adopt_restored_backup",
        lambda backup_set_id, *, account_email: adopted.append((backup_set_id, account_email)),
    )
    activated: list[str] = []
    monkeypatch.setattr(
        db_transfer._proxy,
        "raw_request",
        lambda _method, url, **_kwargs: (activated.append(url) or 200, {"ok": True}),
    )

    result = db_transfer.server_restore_version(manifest["backup_set_id"], object())

    assert result["ok"] is True
    assert result["continuity_updated"] is True
    assert result["activation_synced"] is True
    assert adopted == [(manifest["backup_set_id"], "artist@example.com")]
    assert activated == [
        f"http://server/api/db-backup/sets/{manifest['backup_set_id']}/activate"
    ]


def test_server_backup_list_does_not_disguise_server_failure_as_empty(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda _request: None)
    monkeypatch.setattr(db_transfer._proxy, "proxying", lambda: True)
    monkeypatch.setattr(db_transfer._proxy, "base_url", lambda: "http://server")
    monkeypatch.setattr(db_transfer._proxy, "token", lambda: "token")
    monkeypatch.setattr(
        db_transfer._proxy,
        "raw_request",
        lambda *_args, **_kwargs: (503, {"detail": "unavailable"}),
    )

    with pytest.raises(HTTPException) as raised:
        db_transfer.server_backups(object())

    assert raised.value.status_code == 502


def test_same_set_twenty_concurrent_stores_publish_one_directory(tmp_path: Path):
    content_path = tmp_path / "content-source.db"
    trash_path = tmp_path / "trash-source.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest(content, trash)
    root = tmp_path / "account"

    def store(_index: int):
        return db_backup._store_backup_set(
            root,
            manifest,
            {"content": io.BytesIO(content), "trash": io.BytesIO(trash)},
        )

    with ThreadPoolExecutor(max_workers=20) as pool:
        acknowledgements = list(pool.map(store, range(20)))

    folders = list((root / "sets").glob("[0-9a-f]*"))
    assert [folder.name for folder in folders] == [manifest["backup_set_id"]]
    assert all(ack["accepted"] is True for ack in acknowledgements)
    assert all(ack["backup_set_id"] == manifest["backup_set_id"] for ack in acknowledgements)
    assert sum(ack["duplicate"] is False for ack in acknowledgements) == 1
    assert db_backup._ack_for_stored_set(
        folders[0], manifest, duplicate=True, count=1
    ) is not None


def test_server_publish_failure_restores_previous_set(tmp_path: Path, monkeypatch):
    content_path = tmp_path / "content-source.db"
    trash_path = tmp_path / "trash-source.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest(content, trash)
    root = tmp_path / "account"
    original_ack = db_backup._store_backup_set(
        root,
        manifest,
        {"content": io.BytesIO(content), "trash": io.BytesIO(trash)},
    )
    assert original_ack["accepted"] is True
    final = root / "sets" / manifest["backup_set_id"]
    original_manifest = (final / "manifest.json").read_bytes()
    (final / "content.db").write_bytes(b"old-incomplete-copy")

    real_replace = db_backup.os.replace

    def fail_publish(source, destination):
        source_path = Path(source)
        if source_path.parent == final.parent and source_path.name.startswith(".upload-"):
            raise OSError("disk full")
        return real_replace(source, destination)

    monkeypatch.setattr(db_backup.os, "replace", fail_publish)
    with pytest.raises(OSError):
        db_backup._store_backup_set(
            root,
            manifest,
            {"content": io.BytesIO(content), "trash": io.BytesIO(trash)},
        )

    assert final.is_dir()
    assert (final / "content.db").read_bytes() == b"old-incomplete-copy"
    assert (final / "manifest.json").read_bytes() == original_manifest
    assert not list(final.parent.glob(".upload-*"))
    assert not list(final.parent.glob(".replace-*"))


def test_worker_upload_streams_a_complete_multipart_set(tmp_path: Path):
    content_path = tmp_path / "content.db"
    trash_path = tmp_path / "trash.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest(content, trash)
    received: dict[str, object] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers["Content-Length"])
            received["authorization"] = self.headers["Authorization"]
            received["body"] = self.rfile.read(length)
            response = json.dumps(
                {
                    "accepted": True,
                    "backup_set_id": manifest["backup_set_id"],
                    "files": manifest["roles"],
                    "count": 1,
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, _format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, response = worker_backup._multipart_set_upload(
            f"http://127.0.0.1:{server.server_port}/api/db-backup/sets",
            "private-token",
            manifest,
            {"content": content_path, "trash": trash_path},
            timeout=5,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

    assert status == 200
    assert worker_backup._verify_ack(response, manifest)
    assert received["authorization"] == "Bearer private-token"
    body = received["body"]
    assert isinstance(body, bytes)
    assert content in body and trash in body
    assert body.endswith(b"--\r\n")


def test_restore_archive_checks_manifest_hashes_and_extracts_both_roles(tmp_path: Path):
    content_path = tmp_path / "content-source.db"
    trash_path = tmp_path / "trash-source.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest(content, trash)
    archive = tmp_path / "set.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("content.db", content)
        bundle.writestr("trash.db", trash)

    extracted_content, extracted_trash = db_transfer._extract_backup_set(
        archive, tmp_path / "extracted"
    )
    assert extracted_content.read_bytes() == content
    assert extracted_trash is not None and extracted_trash.read_bytes() == trash


def test_restore_archive_rejects_a_file_that_does_not_match_manifest(tmp_path: Path):
    content_path = tmp_path / "content-source.db"
    trash_path = tmp_path / "trash-source.db"
    content = _content_db(content_path, secret=False)
    trash = _trash_db(trash_path)
    manifest = _server_manifest(content, trash)
    archive = tmp_path / "bad-set.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("content.db", content)
        bundle.writestr("trash.db", b"corrupt")

    with pytest.raises(Exception) as caught:
        db_transfer._extract_backup_set(archive, tmp_path / "bad-extracted")
    assert getattr(caught.value, "status_code", None) == 400


def test_new_worker_with_old_server_keeps_set_pending_and_uses_legacy_compatibility(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    source = tmp_path / "content_hub_20260817_120000_000001.db"
    _content_db(source, secret=False)
    monkeypatch.setattr(db_transfer, "require_admin", lambda _request: None)
    monkeypatch.setattr(db_transfer, "_require_local_when_open", lambda _request: None)
    monkeypatch.setattr(db_transfer._proxy, "proxying", lambda: True)
    monkeypatch.setattr(db_transfer, "backup_now", lambda: source)
    monkeypatch.setattr(db_transfer, "queue_backup_set", lambda _path: "a" * 64)
    monkeypatch.setattr(db_transfer, "retry_pending", lambda: 1)

    async def old_server_result():
        return {"state": "server_update_required", "error_code": "server_update_required"}

    monkeypatch.setattr(db_transfer.periodic_worker_backup, "run_now", old_server_result)
    monkeypatch.setattr(
        db_transfer,
        "_legacy_server_backup",
        lambda _path: (200, {"ok": True, "count": 4}),
    )

    result = asyncio.run(db_transfer.server_backup(object()))
    assert result == {
        "ok": False,
        "state": "server_update_required",
        "count": 4,
        "legacy_content_saved": True,
    }
