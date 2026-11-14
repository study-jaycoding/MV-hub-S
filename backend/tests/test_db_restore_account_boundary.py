"""Restore admission must not follow a later machine-account switch.

Only synthetic SQLite files are installed. Network, backup adoption and archive
extraction are mocked; existing backup-set tests cover archive validation itself.
"""

import asyncio
import io
import json
import re
import shutil
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request, UploadFile

from app import active_account, config, db, db_paths
from app.routers import db_transfer
from app.services import backup_manifest, asset_mounts, auth, agent_chat
from app.repo import agent_chat as agent_store

_EXTRACT_BACKUP_SET = db_transfer._extract_backup_set


ROUTES = ("import", "version", "latest_set", "legacy")
ACCOUNT_A = "restore-a@example.invalid"
ACCOUNT_B = "restore-b@example.invalid"


# db_transfer 와 그것이 부르는 서비스가 임시 폴더에 만드는 이름은 전부 소문자 `mvhub-` 로 시작한다
# (예: mvhub-export-·import-·srvbak-·srvrestore-·restore-set-, test_snapshot 의 mvhub-test-snapshot-·test-db-).
_PRODUCT_TEMP_PREFIX = "mvhub-"


def assert_no_restore_temp(hub):
    """거부·완료된 복원이 **자기** 임시 산출물을 남기지 않았는지 본다.

    폴더가 통째로 비었는지를 보던 단언은 전체 회귀 4회 중 2회 흔들렸다(2026-09-18): 남은 파일은
    `MVHUB-SRVRESTORE-<HEX>.ZIP.tmp` — 제품도 이 시험도 만들지 않는 이름이다(대문자·`.tmp`). 설비가
    프로세스 전역 `tempfile.tempdir` 를 이 폴더로 돌려 두므로 밖에서 온 파일이 섞일 수 있다(만든 쪽은
    미확정 — 재현하지 못했다). 그래서 제품이 만드는 이름만 본다. 대소문자를 구분한다.
    """
    assert not [p.name for p in hub.temp.iterdir() if p.name.startswith(_PRODUCT_TEMP_PREFIX)]


def leftover_restore_stages(root):
    """제품이 만든 복원 임시본(`.<DB 이름>.restore-<소문자 hex 16>.tmp`, `db_transfer._install_db`)만 찾는다.

    `rglob("*.restore-*.tmp")` 는 Windows 에서 대소문자를 가리지 않아, 위 `assert_no_restore_temp` 와 같은 외부 파일
    (`.CONTENT_HUB.DB.RESTORE-<HEX>.TMP.tmp` — 제품 이름을 대문자로 바꾸고 `.tmp` 를 덧붙인 꼴)에 걸렸다(2026-09-19,
    배포 게이트 리허설의 전체 실행에서 1회. 같은 날 전체 실행 2회는 통과). 제품 누수는 그대로 잡는다.
    """
    return [p for p in root.rglob("*") if re.fullmatch(r"\..+\.restore-[0-9a-f]{16}\.tmp", p.name)]


def test_leftover_restore_stages_sees_product_names_only(tmp_path):
    (tmp_path / "db").mkdir()
    (tmp_path / "db" / ".CONTENT_HUB.DB.RESTORE-85A47FB34FF64566.TMP.tmp").write_bytes(b"")  # 외부 프로세스가 남긴 꼴
    assert leftover_restore_stages(tmp_path) == []
    (tmp_path / "db" / ".content_hub.db.restore-85a47fb34ff64566.tmp").write_bytes(b"")
    (tmp_path / "db" / ".content_hub_trash.db.restore-0123456789abcdef.tmp").write_bytes(b"")
    assert len(leftover_restore_stages(tmp_path)) == 2  # 제품 누수(본 DB·휴지통)는 그대로 잡는다


def marker(path):
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute(
            "SELECT value FROM app_setting WHERE key='restore_boundary_marker'"
        ).fetchone()[0]


@pytest.fixture(scope="module")
def seed_db(tmp_path_factory):
    path = tmp_path_factory.mktemp("restore-boundary-seed") / "source.db"
    db.init_db(path)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute(
            "INSERT INTO app_setting(key,value) VALUES('restore_boundary_marker','restored')"
        )
        conn.commit()
    db.flush_pool()
    return path


@pytest.fixture
def hub(tmp_path, monkeypatch, seed_db):
    db.flush_pool()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer, "DATA_DIR", tmp_path)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(db_paths, "DEFAULT_DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(db_transfer.tempfile, "tempdir", str(temp))
    monkeypatch.setattr(db_transfer, "require_admin", lambda request: None)
    monkeypatch.setattr(db_transfer._proxy, "proxying", lambda: True)
    base_url = Mock(side_effect=lambda: "http://" + (
        "a.invalid" if active_account.account_key() == ACCOUNT_A else "b.invalid"
    ))
    token = Mock(side_effect=lambda: "synthetic-a" if active_account.account_key() == ACCOUNT_A else "synthetic-b")
    monkeypatch.setattr(db_transfer._proxy, "base_url", base_url)
    monkeypatch.setattr(db_transfer._proxy, "token", token)
    activate = Mock(return_value=(200, {}))
    adopt = Mock()
    monkeypatch.setattr(db_transfer._proxy, "raw_request", activate)
    monkeypatch.setattr(db_transfer, "adopt_restored_backup", adopt)

    paths = {
        "a": active_account.account_db_path(ACCOUNT_A),
        "b": active_account.account_db_path(ACCOUNT_B),
        "fixed": tmp_path / "fixed.db",
        "legacy": db_paths.DEFAULT_DB_PATH,
    }
    for name, path in paths.items():
        assert path.resolve().is_relative_to(tmp_path.resolve())
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(seed_db, path)
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("UPDATE app_setting SET value=? WHERE key='restore_boundary_marker'", (name,))
            conn.commit()
    active_account.set_active(ACCOUNT_A, "uid-a")

    def extract(archive, destination):
        assert archive.resolve().is_relative_to(temp.resolve())
        content = destination / "content_hub.db"
        shutil.copy2(seed_db, content)
        return content, None

    monkeypatch.setattr(db_transfer, "_extract_backup_set", extract)
    request = Request({
        "type": "http", "method": "POST", "path": "/api/db/import", "headers": [],
        "client": ("127.0.0.1", 12345), "server": ("127.0.0.1", 8012),
        "scheme": "http", "query_string": b"",
    })
    state = SimpleNamespace(
        root=tmp_path, temp=temp, paths=paths, seed=seed_db, request=request,
        base_url=base_url, token=token, activate=activate, adopt=adopt,
    )
    try:
        yield state
    finally:
        db.flush_pool()
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(key_token)


def invoke(hub, monkeypatch, route, change=lambda: None):
    if route == "import":
        class SwitchingUpload(UploadFile):
            async def seek(self, offset):
                change()  # First await: admission must already be captured.
                await super().seek(offset)

        upload = SwitchingUpload(file=io.BytesIO(hub.seed.read_bytes()), filename="restore.db")
        try:
            return asyncio.run(db_transfer.import_db(hub.request, upload))
        finally:
            upload.file.close()

    calls = []

    def download(url, token, destination):
        assert destination.resolve().is_relative_to(hub.temp.resolve())
        calls.append((url, token))
        if len(calls) == 1:
            change()
        shutil.copy2(hub.seed, destination)
        return 404 if route == "legacy" and len(calls) == 1 else 200

    hub.downloads = calls
    monkeypatch.setattr(db_transfer, "_download_to", download)
    if route == "version":
        return db_transfer.server_restore_version("a" * 64, hub.request)
    return db_transfer.server_restore(hub.request)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("fixed", (False, True))
@pytest.mark.parametrize("change", ("email", "uid", "logout"))
def test_switch_rejects_before_flush_or_target_writes(hub, monkeypatch, route, fixed, change):
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths["fixed"]))
    flush = Mock(wraps=db.flush_pool)
    monkeypatch.setattr(db, "flush_pool", flush)

    def switch():
        if change == "logout":
            active_account.clear_active()
        elif change == "uid":
            active_account.set_active(ACCOUNT_A, "uid-new")
        else:
            active_account.set_active(ACCOUNT_B, "uid-b")

    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, route, switch)
    assert error.value.status_code == 409
    assert flush.call_count == 0
    assert {key: marker(path) for key, path in hub.paths.items()} == {
        key: key for key in hub.paths
    }
    expected_email = None if change == "logout" else ACCOUNT_A if change == "uid" else ACCOUNT_B
    assert active_account.account_key() == expected_email
    assert active_account.active_uid() == (None if change == "logout" else "uid-new" if change == "uid" else "uid-b")
    assert not list(hub.root.rglob("*.bak-*.db"))
    assert not leftover_restore_stages(hub.root)
    assert_no_restore_temp(hub)
    hub.adopt.assert_not_called()
    hub.activate.assert_not_called()


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("auth", (False, True))
@pytest.mark.parametrize("fixed", (False, True))
@pytest.mark.parametrize("switch_accounts", (False, True))
def test_unchanged_target_restores_but_account_epoch_change_rejects(
    hub, monkeypatch, route, auth, fixed, switch_accounts
):
    monkeypatch.setattr(config, "AUTH_ENABLED", auth)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", auth)
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths["fixed"]))
    target = db.get_db_path()

    def switch():
        if not switch_accounts:
            return
        active_account.set_active(ACCOUNT_B, "uid-b")
        if not auth:
            active_account.set_active("  RESTORE-A@example.invalid  ", "uid-a")

    if switch_accounts:
        before = target.read_bytes()
        with pytest.raises(HTTPException) as caught:
            invoke(hub, monkeypatch, route, switch)
        assert caught.value.status_code == 409
        assert target.read_bytes() == before
        assert not list(hub.root.rglob("*.bak-*"))
        assert_no_restore_temp(hub)
        return
    result = invoke(hub, monkeypatch, route, switch)
    assert result["ok"] and result["relogin_required"]
    assert marker(target) == "restored"
    expected_pointer = (
        {"email": ACCOUNT_B, "uid": "uid-b"} if switch_accounts
        else {"email": ACCOUNT_A, "uid": "uid-a"}
    )
    assert active_account._read_pointer() == (expected_pointer if auth else None)
    backups = list(target.parent.glob(f"{target.stem}.bak-*.db"))
    assert len(backups) == 1
    assert marker(backups[0]) == ("fixed" if fixed else "legacy" if auth else "a")
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("change", ("path", "same_path_env", "router_mode", "path_mode"))
def test_mode_or_env_change_rejects_even_without_account_switch(hub, monkeypatch, route, change):
    target = db.get_db_path()

    def alter():
        if change == "path":
            monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths["b"]))
        elif change == "same_path_env":
            monkeypatch.setenv("CONTENT_HUB_DB", str(target))
        elif change == "router_mode":
            monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
        else:
            monkeypatch.setattr(config, "AUTH_ENABLED", True)

    flush = Mock(wraps=db.flush_pool)
    monkeypatch.setattr(db, "flush_pool", flush)
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, route, alter)
    assert error.value.status_code == 409
    assert flush.call_count == 0
    assert marker(target) == "a"
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("fixed", (False, True))
@pytest.mark.parametrize("override", ("key", "uid"))
def test_stale_request_context_is_rejected_at_admission(hub, monkeypatch, route, fixed, override):
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths["fixed"]))
    pin = (ACCOUNT_B, "uid-a") if override == "key" else (ACCOUNT_A, "uid-b")
    with active_account.pinned_account_scope(pin), pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, route)
    assert error.value.status_code == 409
    hub.base_url.assert_not_called()
    assert_no_restore_temp(hub)


def test_legacy_source_pair_is_not_reread_after_switch(hub, monkeypatch):
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, "legacy", lambda: active_account.set_active(ACCOUNT_B, "uid-b"))
    assert error.value.status_code == 409
    assert hub.downloads == [
        ("http://a.invalid/api/db-backup/latest-set", "synthetic-a"),
        ("http://a.invalid/api/db-backup/latest", "synthetic-a"),
    ]
    assert hub.base_url.call_count == hub.token.call_count == 1
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("route", ("version", "latest_set", "legacy"))
def test_source_credentials_are_captured_under_one_transition_lock(hub, monkeypatch, route):
    started = threading.Event()
    finished = threading.Event()
    workers = []

    def switch():
        started.set()
        active_account.set_active(ACCOUNT_B, "uid-b")
        finished.set()

    def base_url():
        thread = threading.Thread(target=switch)
        workers.append(thread)
        thread.start()
        assert started.wait(1)
        assert not finished.wait(0.03), "Source snapshot did not hold transition lock"
        return "http://a.invalid"

    monkeypatch.setattr(db_transfer._proxy, "base_url", base_url)
    try:
        with pytest.raises(HTTPException) as error:
            invoke(hub, monkeypatch, route, lambda: finished.wait(2))
        assert error.value.status_code == 409
        assert all(token == "synthetic-a" for _, token in hub.downloads)
    finally:
        for thread in workers:
            thread.join(2)
            assert not thread.is_alive()


def test_gate_rechecks_after_wait_before_mkdir_or_flush(hub, monkeypatch):
    expected = db_transfer._capture_restore_target()
    source = hub.root / "input.db"
    shutil.copy2(hub.seed, source)
    new_path = hub.root / "must-not-create" / "content.db"

    @contextmanager
    def changed_gate():
        monkeypatch.setenv("CONTENT_HUB_DB", str(new_path))
        yield

    monkeypatch.setattr(db, "maintenance_gate", changed_gate)
    flush = Mock(wraps=db.flush_pool)
    monkeypatch.setattr(db, "flush_pool", flush)
    with pytest.raises(HTTPException) as error:
        db_transfer._install_db(source, expected=expected)
    assert error.value.status_code == 409
    assert not new_path.parent.exists()
    assert source.exists()
    flush.assert_not_called()


def test_rejection_does_not_enter_maintenance_gate(hub, monkeypatch):
    expected = db_transfer._capture_restore_target()
    active_account.set_active(ACCOUNT_B, "uid-b")
    gate = Mock(side_effect=AssertionError("Must reject before maintenance"))
    monkeypatch.setattr(db, "maintenance_gate", gate)
    with pytest.raises(HTTPException) as error:
        db_transfer._install_db(hub.seed, expected=expected)
    assert error.value.status_code == 409
    gate.assert_not_called()


def test_expected_restore_preserves_security_failure_rollback(hub, monkeypatch):
    expected = db_transfer._capture_restore_target()
    original_pointer = active_account._POINTER.read_bytes()
    source = hub.root / "input.db"
    shutil.copy2(hub.seed, source)
    monkeypatch.setattr(db_transfer, "_post_install_security_init", Mock(side_effect=RuntimeError("synthetic failure")))
    with pytest.raises(RuntimeError, match="synthetic failure"):
        db_transfer._install_db(source, expected=expected)
    assert marker(hub.paths["a"]) == "a"
    assert marker(hub.paths["b"]) == "b"
    assert active_account._POINTER.read_bytes() == original_pointer
    assert active_account.account_key() == ACCOUNT_A
    assert source.exists()
    assert not leftover_restore_stages(hub.root)


def test_expected_install_holds_transition_lock_through_pointer_clear(hub, monkeypatch):
    expected = db_transfer._capture_restore_target()
    source = hub.root / "input.db"
    shutil.copy2(hub.seed, source)
    started = threading.Event()
    finished = threading.Event()
    workers = []
    security_init = db_transfer._post_install_security_init

    def switch():
        started.set()
        active_account.set_active(ACCOUNT_B, "uid-b")
        finished.set()

    def before_clear(path):
        security_init(path)
        worker = threading.Thread(target=switch)
        workers.append(worker)
        worker.start()
        assert started.wait(1)
        assert not finished.wait(0.03)

    monkeypatch.setattr(db_transfer, "_post_install_security_init", before_clear)
    try:
        result = db_transfer._install_db(source, expected=expected)
    finally:
        for worker in workers:
            worker.join(2)
            assert not worker.is_alive()
    assert result["ok"]
    assert marker(hub.paths["a"]) == "restored"
    assert marker(hub.paths["b"]) == "b"
    assert active_account.account_key() == ACCOUNT_B
    assert active_account.active_uid() == "uid-b"


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("uid", (None, "uid-a"))
def test_local_unchanged_optional_uid_is_supported(hub, monkeypatch, route, uid):
    active_account.set_active(ACCOUNT_A, uid)
    assert invoke(hub, monkeypatch, route)["ok"]
    assert marker(hub.paths["a"]) == "restored"


@pytest.mark.parametrize("route", ROUTES)
def test_auth_on_ignores_stale_request_and_machine_identity(hub, monkeypatch, route):
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
    with active_account.pinned_account_scope((ACCOUNT_B, "different-uid")):
        assert invoke(hub, monkeypatch, route)["ok"]
    assert marker(hub.paths["legacy"]) == "restored"
    assert active_account._read_pointer() == {"email": ACCOUNT_A, "uid": "uid-a"}


@pytest.mark.parametrize("failure", ("download", "validation", "install"))
def test_legacy_temp_is_cleaned_on_exception(hub, monkeypatch, failure):
    calls = []

    def download(url, token, path):
        calls.append(url)
        shutil.copy2(hub.seed, path)
        if len(calls) == 1:
            return 404
        if failure == "download":
            raise RuntimeError("synthetic failure")
        return 200

    monkeypatch.setattr(db_transfer, "_download_to", download)
    if failure == "validation":
        monkeypatch.setattr(db_transfer, "validate_hub_db", Mock(side_effect=RuntimeError("synthetic failure")))
    if failure == "install":
        monkeypatch.setattr(db_transfer, "_install_db", Mock(side_effect=HTTPException(409, "synthetic conflict")))
    with pytest.raises((RuntimeError, HTTPException)):
        db_transfer.server_restore(hub.request)
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("raw", (
    b"", b"{", b"null", b"[]", b"123", b'"text"', b"\xff",
    b'{"email":123}', b'{"email":true}', b'{"email":[]}',
    b'{"uid":123}', b'{"uid":{}}',
))
def test_invalid_pointer_is_rejected_without_repair(hub, monkeypatch, raw):
    active_account._POINTER.write_bytes(raw)
    cached = [True, None]
    monkeypatch.setattr(active_account, "_cache", cached)
    flush = Mock()
    monkeypatch.setattr(db, "flush_pool", flush)
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, "import")
    assert error.value.status_code == 409
    assert active_account._POINTER.read_bytes() == raw
    assert active_account._cache == [True, None]
    flush.assert_not_called()
    assert_no_restore_temp(hub)
    assert not list(hub.root.rglob("*.bak"))
    assert not leftover_restore_stages(hub.root)


@pytest.mark.parametrize("failure", (PermissionError, IsADirectoryError, NotADirectoryError, OSError))
def test_unreadable_pointer_is_503_before_any_install(hub, monkeypatch, failure):
    pointer = active_account._POINTER
    raw = pointer.read_bytes()
    cached = list(active_account._cache)
    original = type(pointer).read_text

    def read_text(path, *args, **kwargs):
        if path == pointer:
            raise failure("synthetic unreadable pointer")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(pointer), "read_text", read_text)
    flush = Mock()
    monkeypatch.setattr(db, "flush_pool", flush)
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, "import")
    assert error.value.status_code == 503
    assert pointer.read_bytes() == raw
    assert active_account._cache == cached
    flush.assert_not_called()
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("cached", (
    None, {"email": 123}, {"email": True}, {"email": ["invalid"]},
    {"email": ACCOUNT_A, "uid": 123}, {"email": ACCOUNT_A, "uid": {}},
))
def test_invalid_cache_with_valid_pointer_is_409_not_500(hub, monkeypatch, cached):
    raw = active_account._POINTER.read_bytes()
    monkeypatch.setattr(active_account, "_cache", [True, cached])
    get_path = Mock(side_effect=AssertionError("must reject before resolving DB"))
    monkeypatch.setattr(db, "get_db_path", get_path)
    with pytest.raises(HTTPException) as error:
        db_transfer._capture_restore_target()
    assert error.value.status_code == 409
    assert active_account._cache == [True, cached]
    assert active_account._POINTER.read_bytes() == raw
    get_path.assert_not_called()


@pytest.mark.parametrize("pointer", (None, {}, {"email": None}, {"email": ""}, {"email": "  "}, {"extra": 1}))
def test_missing_or_blank_pointer_stays_valid_without_cache_repair(hub, monkeypatch, pointer):
    if pointer is None:
        active_account._POINTER.unlink()
    else:
        active_account._POINTER.write_text(json.dumps(pointer), encoding="utf-8")
    monkeypatch.setattr(active_account, "_cache", [True, pointer])
    expected = db_transfer._capture_restore_target()
    assert expected.email == "" and expected.uid is None
    assert active_account._cache == [True, pointer]
    # Whitespace keys retain the existing db.get_db_path semantics; strict read
    # classifies/compares only and does not silently redirect the selected DB.


def test_import_lock_contention_rejects_before_first_await(hub, monkeypatch):
    held, release = threading.Event(), threading.Event()

    def hold():
        with active_account.transition_lock:
            held.set()
            release.wait(1)

    worker = threading.Thread(target=hold)
    worker.start()
    assert held.wait(1)
    seek = Mock()

    class ObservedUpload(UploadFile):
        async def seek(self, offset):
            seek()
            await super().seek(offset)

    upload = ObservedUpload(file=io.BytesIO(hub.seed.read_bytes()), filename="restore.db")

    async def check():
        ticks = []
        asyncio.get_running_loop().call_soon(lambda: ticks.append(True))
        start = time.monotonic()
        with pytest.raises(HTTPException) as error:
            await db_transfer.import_db(hub.request, upload)
        elapsed = time.monotonic() - start
        assert error.value.status_code == 503
        assert error.value.detail == "다른 DB 요청이 진행 중이라 복원을 잠시 뒤에 다시 시도하세요"
        assert elapsed < 0.5
        await asyncio.sleep(0)
        assert ticks == [True]

    try:
        asyncio.run(check())
        seek.assert_not_called()
        assert_no_restore_temp(hub)
    finally:
        release.set()
        worker.join(2)
        upload.file.close()
        assert not worker.is_alive()


def test_import_capture_releases_lock_even_when_pointer_is_invalid(hub, monkeypatch):
    active_account._POINTER.write_bytes(b"null")
    with pytest.raises(HTTPException) as error:
        db_transfer._capture_restore_target_nowait()
    assert error.value.status_code == 409
    acquired = []

    def probe():
        ok = active_account.transition_lock.acquire(blocking=False)
        acquired.append(ok)
        if ok:
            active_account.transition_lock.release()

    worker = threading.Thread(target=probe)
    worker.start()
    worker.join(1)
    assert not worker.is_alive() and acquired == [True]


@pytest.mark.parametrize("route", ("version", "latest_set", "legacy"))
def test_synchronous_restore_waits_for_transition_lock(hub, monkeypatch, route):
    held, release = threading.Event(), threading.Event()

    def hold():
        with active_account.transition_lock:
            held.set()
            release.wait(0.08)

    worker = threading.Thread(target=hold)
    worker.start()
    assert held.wait(1)
    try:
        start = time.monotonic()
        assert invoke(hub, monkeypatch, route)["ok"]
        assert time.monotonic() - start >= 0.04
    finally:
        release.set()
        worker.join(1)
        assert not worker.is_alive()


@pytest.mark.parametrize("cached", (0, False, [], ["invalid"], "invalid", {"email": 0}, {"email": False}, {"email": []}, {"email": {}}, {"uid": False}))
def test_raw_falsey_or_nondict_cache_is_not_silently_blank(hub, monkeypatch, cached):
    active_account._POINTER.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(active_account, "_cache", [True, cached])
    with pytest.raises(HTTPException) as error:
        db_transfer._capture_restore_target()
    assert error.value.status_code == 409
    assert active_account._cache == [True, cached]
    assert active_account._POINTER.read_text("utf-8") == "{}"


@pytest.mark.parametrize("cached", (None, {}, {"email": None}, {"email": ""}))
def test_valid_raw_blank_cache_still_allows_blank_pointer(hub, monkeypatch, cached):
    active_account._POINTER.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(active_account, "_cache", [True, cached])
    assert db_transfer._capture_restore_target().email == ""
    assert active_account._cache == [True, cached]


def test_real_directory_pointer_is_unreadable_not_missing(hub, monkeypatch):
    pointer = hub.root / "pointer-directory"
    pointer.mkdir()
    monkeypatch.setattr(active_account, "_POINTER", pointer)
    with pytest.raises(HTTPException) as error:
        db_transfer._capture_restore_target()
    assert error.value.status_code == 503
    assert pointer.is_dir()


@pytest.mark.parametrize("route", ROUTES)
def test_pointer_corruption_after_admission_is_rejected_before_flush(hub, monkeypatch, route):
    flush = Mock()
    monkeypatch.setattr(db, "flush_pool", flush)
    cached = list(active_account._cache)
    before = {key: path.read_bytes() for key, path in hub.paths.items()}
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, route, lambda: active_account._POINTER.write_bytes(b"null"))
    assert error.value.status_code == 409
    flush.assert_not_called()
    assert {key: path.read_bytes() for key, path in hub.paths.items()} == before
    assert active_account._POINTER.read_bytes() == b"null"
    assert active_account._cache == cached
    assert_no_restore_temp(hub)


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("failure_at", ("before_gate", "inside_gate"))
def test_pointer_unreadable_on_recheck_rejects_before_flush_and_restore(hub, monkeypatch, route, failure_at):
    pointer = active_account._POINTER
    pointer_before = pointer.read_bytes()
    cached = list(active_account._cache)
    before = {key: path.read_bytes() for key, path in hub.paths.items()}
    state = {"admitted": False, "unreadable": False, "failed_reads": 0, "gate_entries": 0}
    original_read = type(pointer).read_text
    original_gate = db.maintenance_gate

    def read(path, *args, **kwargs):
        if path == pointer and state["unreadable"]:
            state["failed_reads"] += 1
            raise OSError("synthetic pointer read failure after admission")
        return original_read(path, *args, **kwargs)

    def prepared():
        state["admitted"] = True
        if failure_at == "before_gate":
            state["unreadable"] = True

    @contextmanager
    def gate():
        assert state["admitted"]
        with original_gate():
            state["gate_entries"] += 1
            state["unreadable"] = True
            yield

    monkeypatch.setattr(type(pointer), "read_text", read)
    monkeypatch.setattr(db, "maintenance_gate", gate)
    flush = Mock()
    monkeypatch.setattr(db, "flush_pool", flush)
    with pytest.raises(HTTPException) as error:
        invoke(hub, monkeypatch, route, prepared)
    assert error.value.status_code == 503
    assert state["admitted"] and state["failed_reads"] == 1
    assert state["gate_entries"] == (1 if failure_at == "inside_gate" else 0)
    flush.assert_not_called()
    assert {key: path.read_bytes() for key, path in hub.paths.items()} == before
    assert pointer.read_bytes() == pointer_before and active_account._cache == cached
    assert not list(hub.root.rglob("*.bak-*.db"))
    assert not leftover_restore_stages(hub.root)
    assert_no_restore_temp(hub)
    hub.adopt.assert_not_called()
    hub.activate.assert_not_called()


@pytest.mark.parametrize("raw", (b"null", b"[]", b'{"email":123}'))
def test_auth_on_does_not_adopt_new_local_pointer_validation(hub, monkeypatch, raw):
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    active_account._POINTER.write_bytes(raw)
    monkeypatch.setattr(active_account, "_cache", [True, 123])
    target = db_transfer._capture_restore_target()
    assert target.email == "" and target.uid is None
    assert target.path == hub.paths["legacy"].resolve()
    assert active_account._POINTER.read_bytes() == raw


@pytest.mark.parametrize("fixed", (False, True))
def test_valid_cold_cache_load_is_not_automatic_repair(hub, monkeypatch, fixed):
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_DB", str(hub.paths["fixed"]))
    raw = active_account._POINTER.read_bytes()
    monkeypatch.setattr(active_account, "_cache", [False, None])
    target = db_transfer._capture_restore_target()
    assert target.email == ACCOUNT_A and target.uid == "uid-a"
    assert target.path == hub.paths["fixed" if fixed else "a"].resolve()
    assert active_account._cache == [True, {"email": ACCOUNT_A, "uid": "uid-a"}]
    assert active_account._POINTER.read_bytes() == raw


@pytest.mark.parametrize("cached", (0, [], {"email": False}, {"email": []}))
def test_valid_override_does_not_hide_invalid_machine_cache(hub, monkeypatch, cached):
    monkeypatch.setattr(active_account, "_cache", [True, cached])
    with active_account.pinned_account_scope((ACCOUNT_A, "uid-a")):
        with pytest.raises(HTTPException) as error:
            db_transfer._capture_restore_target()
    assert error.value.status_code == 409
    assert active_account._cache == [True, cached]


def test_cold_cache_with_paired_override_still_validates_machine_pointer(hub, monkeypatch):
    monkeypatch.setattr(active_account, "_cache", [False, None])
    pointer = active_account._POINTER
    original = type(pointer).read_text
    reads = []

    def read(path, *args, **kwargs):
        if path == pointer:
            reads.append(True)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(pointer), "read_text", read)
    with active_account.pinned_account_scope((ACCOUNT_A, "uid-a")):
        target = db_transfer._capture_restore_target()
    assert target.email == ACCOUNT_A and target.uid == "uid-a"
    assert len(reads) == 2  # strict disk read + cold machine cache fill, even with both overrides.


@pytest.fixture
def full_restore(hub, monkeypatch):
    from test_backup_manifest_contract import _v3_set
    import zipfile

    monkeypatch.setattr(config, "AGENT_CHAT_DIR", hub.root / "agent")
    monkeypatch.delenv("CONTENT_HUB_AUTH_SECRET", raising=False)
    monkeypatch.setattr(db_transfer, "_extract_backup_set", _EXTRACT_BACKUP_SET)
    with closing(sqlite3.connect(hub.paths["a"])) as conn:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('auth_secret','old-synthetic-key')")
        conn.commit()
    manifest, paths = _v3_set(hub.root / "source-set")
    shutil.copy2(hub.seed, paths["content"])
    with closing(sqlite3.connect(paths["content"])) as conn:
        conn.execute("INSERT INTO mcp_client(id,secret_hash,hub_id,owner_uid,account_email,password_stamp,workspace,name) "
                     "VALUES('old-client','fake-hash','old-hub','uid-a',?,'','personal','restored')", (ACCOUNT_A,))
        conn.commit()
    manifest["roles"]["content"].update(backup_manifest.role_info(paths["content"], "content"))
    manifest["account_scope_digest"] = backup_manifest.account_digest(active_account.slug(ACCOUNT_A))
    with closing(sqlite3.connect(paths["agent_chat"])) as conn:
        conn.execute("INSERT INTO agent_chat_conversation VALUES('record','claude','fake','high','old-cli','old-client',"
                     "'old-entry','Past work',1,'yesterday','yesterday')")
        conn.commit()
    manifest["roles"]["agent_chat"].update(size=paths["agent_chat"].stat().st_size,
                                           sha256=backup_manifest.file_digest(paths["agent_chat"]))
    old = db_transfer._capture_restore_target(full=True)
    agent_store.create_conversation(old.old_identity.db_file(), engine="claude", model="fake", effort="high",
                                   client_id="local", mcp_entry="{}", title="Original")
    old.mounts_path.write_bytes(b'{"mounts":[{"name":"local","path":"original"}]}')
    trash = old.path.parent / "content_hub_trash.db"
    shutil.copy2(paths["trash"], trash)
    manage = hub.root / "manage_hub.db"
    manage.write_bytes(b"PC management stays unchanged")
    state = SimpleNamespace(hub=hub, manifest=manifest, paths=paths, old=old, trash=trash, manage=manage)

    def archive_at(destination):
        value = backup_manifest.seal(state.manifest)
        with zipfile.ZipFile(destination, "w") as bundle:
            bundle.writestr("manifest.json", backup_manifest.canonical(value))
            for role, item in value["roles"].items():
                if item["state"] == "present":
                    bundle.write(paths[role], backup_manifest.WORKER_FILENAMES[role])
        return value

    def download(url, token, destination):
        archive_at(destination)
        return 200

    state.archive_at = archive_at
    monkeypatch.setattr(db_transfer, "_download_to", download)
    yield state


@pytest.mark.parametrize("versioned", [False, True])
@pytest.mark.parametrize("fixed_secret", [False, True])
def test_full_server_restore_installs_all_roles_and_revokes_credentials(full_restore, monkeypatch, versioned, fixed_secret):
    state = full_restore
    if fixed_secret:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    old_bytes = state.old.agent_path.read_bytes()
    raw_json = state.paths["asset_mounts"].read_bytes()
    request = state.hub.request
    selected_id = backup_manifest.seal(state.manifest)["backup_set_id"]
    result = (db_transfer.server_restore_version(selected_id, request) if versioned
              else db_transfer.server_restore(request))
    assert result["ok"] and result["agent_history_restored"] and result["mounts_confirmation_required"]
    assert result["restored_roles"] == dict.fromkeys(state.paths, "present")
    assert state.old.mounts_path.read_bytes() == raw_json
    assert state.manage.read_bytes() == b"PC management stays unchanged"
    assert not active_account._POINTER.exists()
    active_account.set_active(ACCOUNT_A, "uid-a")
    current = db_transfer._capture_restore_target(full=True)
    assert current.agent_path.is_file()
    assert (current.agent_path == state.old.agent_path) is fixed_secret
    if not fixed_secret:
        assert state.old.agent_path.read_bytes() == old_bytes
    with closing(sqlite3.connect(current.agent_path)) as conn:
        row = conn.execute("SELECT resumable,cli_session_id,client_id,mcp_entry,restored_from FROM agent_chat_conversation").fetchone()
        assert row[:4] == (0, None, "", "{}")
        assert row[4]
    with closing(sqlite3.connect(current.path)) as conn:
        assert conn.execute("SELECT revoked_at FROM mcp_client WHERE id='old-client'").fetchone()[0]
        value = json.loads(conn.execute("SELECT value FROM app_setting WHERE key=?",
                                       (asset_mounts.restore_key(ACCOUNT_A),)).fetchone()[0])
        assert value == {"id": row[4], "confirmed": []}


@pytest.mark.parametrize("stage", ["content", "trash", "agent_chat", "asset_mounts", "schema", "security", "adopt", "logout"])
@pytest.mark.parametrize("fixed_secret", [False, True])
def test_full_restore_failure_rolls_back_every_member(full_restore, monkeypatch, stage, fixed_secret):
    state = full_restore
    if fixed_secret:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    originals = {path: path.read_bytes() for path in (state.old.path, state.trash, state.old.agent_path,
                                                     state.old.mounts_path, active_account._POINTER, state.manage)}
    original_replace = db_transfer.os.replace
    count = 0

    def failing_replace(source, target):
        nonlocal count
        if ".restore-" in str(source):
            count += 1
            if stage == ("content", "trash", "agent_chat", "asset_mounts")[count - 1]:
                raise OSError("synthetic replacement failure")
        return original_replace(source, target)

    monkeypatch.setattr(db_transfer.os, "replace", failing_replace)
    failing = Mock(side_effect=RuntimeError("synthetic post-install failure"))
    if stage == "schema": monkeypatch.setattr(db, "init_db", failing)
    elif stage == "security": monkeypatch.setattr(db_transfer, "_post_install_security_init", failing)
    elif stage == "adopt": monkeypatch.setattr(agent_store, "adopt_restored", failing)
    elif stage == "logout":
        clear = db_transfer._strict_clear_active
        def fail_after_clear():
            clear()
            raise RuntimeError("synthetic logout failure")
        monkeypatch.setattr(db_transfer, "_strict_clear_active", fail_after_clear)
    with pytest.raises((OSError, RuntimeError)):
        db_transfer.server_restore(state.hub.request)
    assert {path: path.read_bytes() for path in originals} == originals
    assert active_account.account_key() == ACCOUNT_A
    assert set(config.AGENT_CHAT_DIR.glob("*.db")) - set(config.AGENT_CHAT_DIR.glob("*.bak-*.db")) == {state.old.agent_path}
    assert leftover_restore_stages(state.hub.root) == []


@pytest.mark.parametrize("fixed_secret", [False, True])
def test_full_restore_explicit_absent_preserves_backups(full_restore, monkeypatch, fixed_secret):
    state = full_restore
    if fixed_secret:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    originals = {path: path.read_bytes() for path in (state.trash, state.old.agent_path, state.old.mounts_path)}
    for role in ("trash", "agent_chat", "asset_mounts"):
        state.manifest["roles"][role] = {"state": "absent", "captured_at": state.manifest["captured_at"]}
    state.manifest["consistency_roles"] = ["content"]
    result = db_transfer.server_restore(state.hub.request)
    assert not result["agent_history_restored"]
    assert not state.trash.exists() and not state.old.mounts_path.exists()
    active_account.set_active(ACCOUNT_A, "uid-a")
    assert not db_transfer._capture_restore_target(full=True).agent_path.exists()
    for path, raw in originals.items():
        assert any(backup.read_bytes() == raw for backup in path.parent.glob(f"{path.stem}.bak-*{path.suffix}"))


@pytest.mark.parametrize("change", ["account_digest", "env_secret", "agent_dir", "mount_dir"])
def test_full_restore_rejects_changed_scope_before_replacing(full_restore, monkeypatch, change):
    state = full_restore
    before = state.old.path.read_bytes()
    original = db_transfer._extract_backup_set
    if change == "account_digest":
        state.manifest["account_scope_digest"] = "0" * 64
    else:
        def extract(*args):
            result = original(*args)
            if change == "env_secret": monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "changed-synthetic-key")
            elif change == "agent_dir": monkeypatch.setattr(config, "AGENT_CHAT_DIR", state.hub.root / "other-agent")
            else: monkeypatch.setattr(asset_mounts, "mounts_file", lambda email=None: state.hub.root / "other-mounts.json")
            return result
        monkeypatch.setattr(db_transfer, "_extract_backup_set", extract)
    with pytest.raises(HTTPException) as error:
        db_transfer.server_restore(state.hub.request)
    assert error.value.status_code == (400 if change == "account_digest" else 409)
    assert state.old.path.read_bytes() == before
    assert active_account.account_key() == ACCOUNT_A


def test_full_restore_new_account_without_secret_is_supported(full_restore):
    state = full_restore
    with closing(sqlite3.connect(state.old.path)) as conn:
        conn.execute("DELETE FROM app_setting WHERE key='auth_secret'")
        conn.commit()
    assert db_transfer._capture_restore_target(full=True).old_identity is None
    assert db_transfer.server_restore(state.hub.request)["ok"]


@pytest.mark.parametrize("busy", ["issuance", "runtime"])
def test_full_restore_agent_busy_is_noop(full_restore, busy):
    state = full_restore
    key = agent_store.path_key(state.old.agent_path)
    before = (dict(agent_store._epochs), set(agent_store._gates), set(agent_store._opened),
              state.old.path.read_bytes(), state.old.agent_path.read_bytes(), active_account._POINTER.read_bytes())
    if busy == "issuance":
        agent_chat.service._issuing[key] = 1
    else:
        agent_chat.service._runtimes["synthetic-busy"] = SimpleNamespace(path=state.old.agent_path)
    try:
        with pytest.raises(HTTPException) as error:
            db_transfer.server_restore(state.hub.request)
        assert error.value.status_code == 409
        assert before == (dict(agent_store._epochs), set(agent_store._gates), set(agent_store._opened),
                          state.old.path.read_bytes(), state.old.agent_path.read_bytes(), active_account._POINTER.read_bytes())
        assert not list(state.hub.root.rglob("*.bak-*"))
    finally:
        agent_chat.service._issuing.pop(key, None)
        agent_chat.service._runtimes.pop("synthetic-busy", None)


@pytest.mark.parametrize("role", ["content", "trash", "agent_chat", "asset_mounts"])
def test_full_restore_rechecks_actual_staged_bytes(full_restore, monkeypatch, role):
    state = full_restore
    before = {path: path.read_bytes() for path in (state.old.path, state.trash, state.old.agent_path, state.old.mounts_path)}
    original = shutil.copy2
    role_name = {"content": state.old.path.name, "trash": state.trash.name,
                 "asset_mounts": "asset_mounts.json"}.get(role)

    def tamper(source, target, *args, **kwargs):
        result = original(source, target, *args, **kwargs)
        if ".restore-" in str(target) and ((role_name and role_name in target.name) or
                                         (role == "agent_chat" and target.parent == config.AGENT_CHAT_DIR)):
            with target.open("ab") as stream:
                stream.write(b"changed-after-validation")
        return result

    monkeypatch.setattr(shutil, "copy2", tamper)
    with pytest.raises(HTTPException) as error:
        db_transfer.server_restore(state.hub.request)
    assert error.value.status_code == 400
    assert before == {path: path.read_bytes() for path in before}
    assert active_account.account_key() == ACCOUNT_A


@pytest.mark.parametrize("version", [1, 2])
def test_legacy_set_preserves_existing_agent_and_mount_bytes(full_restore, monkeypatch, version):
    import zipfile
    state = full_restore
    before = (state.old.agent_path.read_bytes(), state.old.mounts_path.read_bytes())
    manifest = dict(state.manifest, format_version=version)
    manifest["roles"] = {role: {key: value for key, value in item.items() if key not in {"state", "captured_at"}}
                         for role, item in manifest["roles"].items() if role in {"content", "trash"}}
    if version == 1:
        manifest = {key: manifest[key] for key in ("format", "format_version", "roles")}
        for item in manifest["roles"].values(): item.pop("schema")
    else:
        manifest["consistency_roles"] = ["content", "trash"]
        manifest = backup_manifest.seal(manifest)

    def download(url, token, destination):
        with zipfile.ZipFile(destination, "w") as bundle:
            bundle.writestr("manifest.json", backup_manifest.canonical(manifest))
            for role in manifest["roles"]: bundle.write(state.paths[role], f"{role}.db")
        return 200

    monkeypatch.setattr(db_transfer, "_download_to", download)
    assert db_transfer.server_restore(state.hub.request)["ok"]
    assert before == (state.old.agent_path.read_bytes(), state.old.mounts_path.read_bytes())


def test_full_restore_reports_failed_rollback_and_keeps_original_backups(full_restore, monkeypatch):
    state = full_restore
    original = db_transfer.os.replace
    raw = state.old.path.read_bytes()
    pointer = active_account._POINTER.read_bytes()
    original_mounts = state.old.mounts_path.read_bytes()
    def replace(source, target):
        if ".rollback-" in str(source) and target == state.old.path:
            raise OSError("synthetic rollback failure")
        return original(source, target)
    monkeypatch.setattr(db_transfer.os, "replace", replace)
    clear = db_transfer._strict_clear_active
    def fail_after_clear():
        clear()
        raise RuntimeError("synthetic logout failure")
    monkeypatch.setattr(db_transfer, "_strict_clear_active", fail_after_clear)
    with pytest.raises(HTTPException) as error:
        db_transfer.server_restore(state.hub.request)
    assert error.value.status_code == 500 and "되돌리지 못" in error.value.detail
    assert any(path.read_bytes() == raw for path in state.old.path.parent.glob("content_hub.bak-*.db"))
    assert active_account._POINTER.read_bytes() == pointer
    assert state.old.mounts_path.read_bytes() == original_mounts


def test_full_restore_rejects_auth_server_or_logged_out_target(full_restore, monkeypatch):
    state = full_restore
    archive = state.hub.root / "full.zip"
    state.archive_at(archive)
    bundle = _EXTRACT_BACKUP_SET(archive, state.hub.root / "extracted")
    before = state.old.path.read_bytes()
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as error:
        db_transfer._install_backup_set(bundle, db_transfer._capture_restore_target(full=True))
    assert error.value.status_code == 400
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", False)
    active_account.clear_active()
    with pytest.raises(HTTPException) as error:
        db_transfer._install_backup_set(bundle, db_transfer._capture_restore_target(full=True))
    assert error.value.status_code == 400
    assert state.old.path.read_bytes() == before


def test_full_restore_rejects_different_selected_version(full_restore):
    state = full_restore
    before = state.old.path.read_bytes()
    with pytest.raises(HTTPException) as error:
        db_transfer.server_restore_version("0" * 64, state.hub.request)
    assert error.value.status_code == 400
    assert state.old.path.read_bytes() == before
    state.hub.adopt.assert_not_called()
    state.hub.activate.assert_not_called()


@pytest.fixture
def legacy_restore(full_restore, monkeypatch):
    """Use real v1/v2 archives and single-file inputs, never an upstream server."""
    import zipfile
    state = full_restore
    state.hub.seed = state.paths["content"]

    def restore(route="latest_set", version=2, change=lambda: None):
        if route in {"import", "legacy"}:
            return invoke(state.hub, monkeypatch, route, change)
        manifest = dict(state.manifest, format_version=version)
        manifest["roles"] = {
            role: {k: v for k, v in backup_manifest.role_info(state.paths[role], role).items()}
            for role in ("content", "trash")
        }
        if version == 1:
            manifest = {k: manifest[k] for k in ("format", "format_version", "roles")}
            for item in manifest["roles"].values():
                item.pop("schema")
        else:
            manifest["consistency_roles"] = ["content", "trash"]
            manifest = backup_manifest.seal(manifest)

        def download(url, token, destination):
            change()
            with zipfile.ZipFile(destination, "w") as bundle:
                bundle.writestr("manifest.json", backup_manifest.canonical(manifest))
                for role in manifest["roles"]:
                    bundle.write(state.paths[role], f"{role}.db")
            return 200

        monkeypatch.setattr(db_transfer, "_download_to", download)
        if route == "version":
            return db_transfer.server_restore_version(manifest.get("backup_set_id", "a" * 64), state.hub.request)
        return db_transfer.server_restore(state.hub.request)

    state.restore = restore
    return state


@pytest.mark.parametrize("route,version", [(r, v) for r in ("version", "latest_set") for v in (1, 2)]
                         + [("legacy", 2), ("import", 2)])
@pytest.mark.parametrize("fixed", [False, True])
def test_legacy_followup_mcp_revokes_every_entry(legacy_restore, monkeypatch, route, version, fixed):
    state = legacy_restore
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    with closing(sqlite3.connect(state.paths["content"])) as conn:
        for client_id, stamp in (("other-client", None), ("already-revoked", "2000-01-01")):
            conn.execute("INSERT INTO mcp_client(id,secret_hash,hub_id,owner_uid,account_email,password_stamp,workspace,name,revoked_at) "
                         "VALUES(?,?,'other-hub','other-owner',?,'','personal','other',?)",
                         (client_id, client_id + "-hash", ACCOUNT_B, stamp))
        conn.commit()
    assert state.restore(route, version)["ok"]
    with closing(sqlite3.connect(state.old.path)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM mcp_client WHERE revoked_at IS NULL").fetchone() == (0,)
        assert conn.execute("SELECT COUNT(*) FROM mcp_client").fetchone() == (3,)
        assert conn.execute("SELECT revoked_at FROM mcp_client WHERE id='already-revoked'").fetchone() == ("2000-01-01",)


@pytest.mark.parametrize("prior", [None, {"id": "v3", "confirmed": []},
                                  {"id": "past", "confirmed": [{"name": "local", "path": "C:\\old"}]}, "broken"])
def test_legacy_followup_mounts_resets_without_writing_json(legacy_restore, prior):
    state = legacy_restore
    if prior is not None:
        with closing(sqlite3.connect(state.paths["content"])) as conn:
            conn.execute("INSERT INTO app_setting VALUES(?,?)", (asset_mounts.restore_key(ACCOUNT_A), json.dumps(prior)))
            conn.commit()
    before = state.old.mounts_path.read_bytes()
    state.restore()
    with closing(sqlite3.connect(state.old.path)) as conn:
        value = asset_mounts.restore_state(conn, ACCOUNT_A)
    assert value and value["id"] and value["id"] not in {"past", "v3"} and value["confirmed"] == []
    assert not asset_mounts.allowed(value, "local", "C:\\old")
    assert state.old.mounts_path.read_bytes() == before


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("change", ["env", "agent_dir", "mounts", "db_epoch", "account_epoch", "server_mode"])
def test_legacy_followup_admission_rejects_changed_snapshot(legacy_restore, monkeypatch, route, change):
    state = legacy_restore
    before = state.old.path.read_bytes()

    def alter():
        if change == "env":
            monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "different-synthetic-key")
        elif change == "agent_dir":
            monkeypatch.setattr(config, "AGENT_CHAT_DIR", state.hub.root / "another-agent")
        elif change == "mounts":
            monkeypatch.setattr(asset_mounts, "mounts_file", lambda email=None: state.hub.root / "other.json")
        elif change == "db_epoch":
            db.flush_pool()
        elif change == "server_mode":
            monkeypatch.setattr(db_transfer._proxy, "is_shared_team_server", lambda: True)
        else:
            active_account.bump_account_epoch()

    with pytest.raises(HTTPException) as caught:
        state.restore(route, change=alter)
    assert caught.value.status_code == 409
    assert state.old.path.read_bytes() == before
    assert not list(state.hub.root.rglob("*.bak-*"))


@pytest.mark.parametrize("fixed", [False, True])
@pytest.mark.parametrize("route", ROUTES)
def test_legacy_followup_agent_adopts_original(legacy_restore, monkeypatch, fixed, route):
    state = legacy_restore
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    before = state.old.agent_path.read_bytes()
    state.restore(route)
    active_account.set_active(ACCOUNT_A, "uid-a")
    current = db_transfer._capture_restore_target(full=True)
    assert current.agent_path.is_file()
    with closing(sqlite3.connect(current.agent_path)) as conn:
        rows = conn.execute("SELECT title,resumable,cli_session_id,client_id,mcp_entry,restored_from FROM agent_chat_conversation").fetchall()
    assert len(rows) == 1 and rows[0][:5] == ("Original", 0, None, "", "{}")
    assert rows[0][5]
    if not fixed:
        assert state.old.agent_path.read_bytes() == before
    assert any(p.read_bytes() == before for p in state.old.agent_path.parent.glob(f"{state.old.agent_path.stem}.bak-*.db"))


@pytest.mark.parametrize("shared", [False, True])
def test_legacy_followup_agent_auth_on_uses_requester_only(legacy_restore, monkeypatch, shared):
    state = legacy_restore
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
    monkeypatch.setenv("CONTENT_HUB_DB", str(state.old.path))
    monkeypatch.setattr(db_transfer._proxy, "is_shared_team_server", lambda: shared)
    state.hub.request.state.account = {"email": ACCOUNT_A, "status": "approved", "global_role": "admin"}
    other = agent_chat.Identity(state.old.old_identity.hub, str(state.old.path), ACCOUNT_B).db_file()
    original, foreign = state.old.agent_path.read_bytes(), other.read_bytes()
    state.restore("import")
    with closing(sqlite3.connect(state.old.path)) as conn:
        assert asset_mounts.restore_state(conn, "")["confirmed"] == []
        secret = conn.execute("SELECT value FROM app_setting WHERE key='auth_secret'").fetchone()[0]
    final = agent_chat.Identity(auth.hub_id_for(secret, state.old.path), str(state.old.path), ACCOUNT_A).file_path()
    assert other.read_bytes() == foreign and state.old.agent_path.read_bytes() == original
    if shared:
        assert not final.exists()
        assert not list(state.old.agent_path.parent.glob("*.bak-*"))
    else:
        assert final.is_file()
        with closing(sqlite3.connect(final)) as conn:
            assert conn.execute("SELECT restored_from FROM agent_chat_conversation").fetchone()[0]


@pytest.mark.parametrize("fixed", [False, True])
@pytest.mark.parametrize("stage", ["content", "trash", "agent", "schema", "security", "adopt", "logout"])
def test_legacy_followup_rollback_every_stage(legacy_restore, monkeypatch, fixed, stage):
    state = legacy_restore
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    before = {p: p.read_bytes() for p in (state.old.path, state.trash, state.old.agent_path,
                                         state.old.mounts_path, state.manage, active_account._POINTER)}
    original_replace = db_transfer.os.replace

    def replace(source, target):
        role = "content" if target == state.old.path else "trash" if target == state.trash else "agent"
        if ".restore-" in str(source) and stage == role:
            raise OSError("synthetic install failure")
        return original_replace(source, target)

    monkeypatch.setattr(db_transfer.os, "replace", replace)
    failure = Mock(side_effect=RuntimeError("synthetic init failure"))
    if stage == "schema": monkeypatch.setattr(db, "init_db", failure)
    elif stage == "security": monkeypatch.setattr(db_transfer, "_post_install_security_init", failure)
    elif stage == "adopt": monkeypatch.setattr(agent_store, "adopt_restored", failure)
    elif stage == "logout":
        clear = db_transfer._strict_clear_active
        def logout():
            clear()
            failure()
        monkeypatch.setattr(db_transfer, "_strict_clear_active", logout)
    with pytest.raises((OSError, RuntimeError)):
        state.restore()
    assert before == {p: p.read_bytes() for p in before}
    assert not leftover_restore_stages(state.hub.root)
    assert {p for p in config.AGENT_CHAT_DIR.glob("*.db") if ".bak-" not in p.name} == {state.old.agent_path}


@pytest.mark.parametrize("mode", ["auth", "logout"])
@pytest.mark.parametrize("fixed", [False, True])
def test_legacy_followup_mcp_import_modes_reject_old_secret(legacy_restore, monkeypatch, mode, fixed):
    from app.routers import mcp, mcp_v2, agent_chat as chat_router
    state = legacy_restore
    monkeypatch.setenv("CONTENT_HUB_DB", str(state.old.path))
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    if mode == "auth":
        monkeypatch.setattr(config, "AUTH_ENABLED", True)
        monkeypatch.setattr(db_transfer, "AUTH_ENABLED", True)
        state.hub.request.state.account = {"email": ACCOUNT_A}
    else:
        active_account.clear_active()
    with closing(sqlite3.connect(state.paths["content"])) as conn:
        conn.execute("UPDATE mcp_client SET secret_hash=?,hub_id=?,name=?",
                     (mcp.digest("synthetic-restored-secret"), state.old.old_identity.hub, mcp_v2.PANEL_CLIENT))
        conn.commit()
    state.restore("import")
    with closing(sqlite3.connect(state.old.path)) as conn:
        assert asset_mounts.restore_state(conn, "")["confirmed"] == []
        assert conn.execute("SELECT revoked_at FROM mcp_client").fetchone()[0]
    active_account.set_active(ACCOUNT_A, "uid-a")
    upstream = Mock(side_effect=AssertionError("No upstream call for revoked credentials"))
    monkeypatch.setattr(mcp_v2, "_upstream_me", upstream)
    with pytest.raises(HTTPException) as caught:
        mcp_v2._capture(state.hub.request, "synthetic-restored-secret")
    assert caught.value.status_code == 403
    assert chat_router._panel_client(SimpleNamespace(hub=state.old.old_identity.hub),
                                      state.old.old_identity, "old-client") is None
    upstream.assert_not_called()


def test_legacy_followup_mounts_requires_current_confirmation(legacy_restore, monkeypatch):
    from app.routers import assets
    state = legacy_restore
    location = state.hub.root / "folder"
    location.mkdir()
    raw = json.dumps({"mounts": [{"name": "local", "path": str(location), "owner": "old"}]}).encode()
    state.old.mounts_path.write_bytes(raw)
    state.restore()
    active_account.set_active(ACCOUNT_A, "uid-a")
    monkeypatch.setattr(assets, "actor_id", lambda request: "me")
    monkeypatch.setattr(assets, "_auto_project_mounts", lambda *a, **k: [{"name": "local", "path": str(location)}])
    assert assets._safe_project_dir("local", state.hub.request) is None
    assert state.old.mounts_path.read_bytes() == raw
    with closing(sqlite3.connect(state.old.path)) as conn:
        restore_id = asset_mounts.restore_state(conn, ACCOUNT_A)["id"]
        with pytest.raises(ValueError, match="asset_restore_changed"):
            asset_mounts.confirm(conn, state.old.mounts_path, name="local", location=str(location),
                                 owner="me", restore_id="old")
        asset_mounts.confirm(conn, state.old.mounts_path, name="local", location=str(location),
                             owner="me", restore_id=restore_id)
    assets._MOUNT_PATH_CACHE.clear()
    assert asset_mounts.normalized_path(assets._safe_project_dir("local", state.hub.request)) == asset_mounts.normalized_path(location)


@pytest.mark.parametrize("missing", ["file", "secret", "logged_out"])
def test_legacy_followup_agent_absence_never_creates_or_deletes_history(legacy_restore, missing):
    state = legacy_restore
    if missing == "file":
        state.old.agent_path.unlink()
    elif missing == "secret":
        with closing(sqlite3.connect(state.old.path)) as conn:
            conn.execute("DELETE FROM app_setting WHERE key='auth_secret'")
            conn.commit()
    else:
        active_account.clear_active()
    before = {p: p.read_bytes() for p in config.AGENT_CHAT_DIR.glob("*.db")}
    state.restore("import")
    assert before == {p: p.read_bytes() for p in config.AGENT_CHAT_DIR.glob("*.db")}


@pytest.mark.parametrize("problem", ["directory", "denied", "corrupt", "future_version"])
def test_legacy_followup_agent_invalid_source_rejects(legacy_restore, monkeypatch, problem):
    state = legacy_restore
    if problem == "directory":
        state.old.agent_path.unlink()
        state.old.agent_path.mkdir()
    elif problem == "corrupt":
        state.old.agent_path.write_bytes(b"not SQLite")
    elif problem == "future_version":
        with closing(sqlite3.connect(state.old.agent_path)) as conn:
            conn.execute("PRAGMA user_version=99")
    else:
        original_stat = type(state.old.agent_path).stat
        def denied(path, *args, **kwargs):
            if path == state.old.agent_path:
                raise PermissionError("synthetic denied")
            return original_stat(path, *args, **kwargs)
        monkeypatch.setattr(type(state.old.agent_path), "stat", denied)
    before = state.old.path.read_bytes()
    with pytest.raises(HTTPException) as caught:
        state.restore()
    assert caught.value.status_code in {400, 409, 500, 503}
    assert state.old.path.read_bytes() == before
    assert not leftover_restore_stages(state.hub.root)


@pytest.mark.parametrize("busy", ["runtime", "issuance"])
@pytest.mark.parametrize("which", ["old", "final"])
def test_legacy_followup_rollback_busy_has_no_side_effect(legacy_restore, monkeypatch, busy, which):
    state = legacy_restore
    original_hex = db_transfer.secrets.token_hex
    monkeypatch.setattr(db_transfer.secrets, "token_hex", lambda n: "future-key" if n == 32 else original_hex(n))
    final = agent_chat.Identity(auth.hub_id_for("future-key", state.old.path), str(state.old.path), ACCOUNT_A)
    path = state.old.agent_path if which == "old" else final.file_path()
    key = agent_store.path_key(path)
    before = (dict(agent_store._epochs), set(agent_store._gates), set(agent_store._opened), state.old.path.read_bytes())
    if busy == "runtime":
        agent_chat.service._runtimes["legacy-busy"] = SimpleNamespace(path=path)
    else:
        agent_chat.service._issuing[key] = 1
    try:
        with pytest.raises(HTTPException) as caught:
            state.restore()
        assert caught.value.status_code == 409
        assert before == (dict(agent_store._epochs), set(agent_store._gates), set(agent_store._opened), state.old.path.read_bytes())
        assert not list(state.hub.root.rglob("*.bak-*"))
    finally:
        agent_chat.service._runtimes.pop("legacy-busy", None)
        agent_chat.service._issuing.pop(key, None)


def test_legacy_followup_rollback_drain_failure_is_no_install(legacy_restore, monkeypatch):
    state = legacy_restore
    before = state.old.path.read_bytes()
    monkeypatch.setattr(agent_store, "drain_connections", Mock(side_effect=agent_store.StaleRequest()))
    with pytest.raises(HTTPException) as caught:
        state.restore()
    assert caught.value.status_code == 503
    assert state.old.path.read_bytes() == before
    assert not list(state.hub.root.rglob("*.bak-*"))
    assert agent_store.path_key(state.old.agent_path) not in agent_store._gates


@pytest.mark.parametrize("problem", ["backup", "tamper"])
def test_legacy_followup_rollback_preparation_failure_is_no_install(legacy_restore, monkeypatch, problem):
    state = legacy_restore
    before = {p: p.read_bytes() for p in (state.old.path, state.old.agent_path)}
    copy = shutil.copy2
    def fail(source, target, *args, **kwargs):
        if problem == "backup" and source == state.old.agent_path and ".bak-" in target.name:
            raise OSError("synthetic backup failure")
        result = copy(source, target, *args, **kwargs)
        if problem == "tamper" and target.parent == config.AGENT_CHAT_DIR and ".restore-" in target.name:
            with target.open("ab") as stream:
                stream.write(b"tampered")
        return result
    monkeypatch.setattr(shutil, "copy2", fail)
    with pytest.raises(HTTPException) as caught:
        state.restore()
    assert caught.value.status_code == (500 if problem == "backup" else 400)
    assert before == {p: p.read_bytes() for p in before}
    assert not leftover_restore_stages(state.hub.root)


@pytest.mark.parametrize('fixed', [False, True])
@pytest.mark.parametrize('route', ROUTES)
def test_a_prep_n2_disappeared_agent_rejects_before_install(legacy_restore, monkeypatch, fixed, route):
    state = legacy_restore
    if fixed:
        monkeypatch.setenv('CONTENT_HUB_AUTH_SECRET', 'old-synthetic-key')
    pointer = active_account._POINTER.read_bytes()
    mounts = state.old.mounts_path.read_bytes()
    with closing(sqlite3.connect(state.old.path)) as conn:
        before = list(conn.iterdump())
    trash = state.trash.read_bytes()
    flush = db.flush_pool
    removed = []
    def disappear():
        flush()
        assert state.old.agent_path.is_file()
        state.old.agent_path.unlink()
        removed.append(state.old.agent_path)
    monkeypatch.setattr(db, 'flush_pool', disappear)
    replace = Mock(side_effect=AssertionError('must not replace'))
    security = Mock(side_effect=AssertionError('must not reset security'))
    adopt = Mock(side_effect=AssertionError('must not adopt Agent'))
    clear = Mock(side_effect=AssertionError('must not clear account'))
    monkeypatch.setattr(db_transfer.os, 'replace', replace)
    monkeypatch.setattr(db_transfer, '_post_install_security_init', security)
    monkeypatch.setattr(agent_store, 'adopt_restored', adopt)
    monkeypatch.setattr(db_transfer, '_strict_clear_active', clear)
    with pytest.raises(HTTPException) as caught:
        try:
            state.restore(route)
        finally:
            monkeypatch.setattr(db, 'flush_pool', flush)
    assert caught.value.status_code == 409
    assert caught.value.detail == '복원 준비 중 Agent 기록 파일이 변경되었습니다. 다시 시도하세요'
    assert removed == [state.old.agent_path]
    for operation in (replace, security, adopt, clear):
        operation.assert_not_called()
    assert active_account._POINTER.read_bytes() == pointer
    assert state.old.mounts_path.read_bytes() == mounts
    with closing(sqlite3.connect(state.old.path)) as conn:
        assert list(conn.iterdump()) == before
    assert state.trash.read_bytes() == trash
    assert not state.old.agent_path.exists()
    assert not list(config.AGENT_CHAT_DIR.glob('*.db'))
    assert not leftover_restore_stages(state.hub.root)


def test_legacy_followup_rollback_failed_compensation_keeps_backups(legacy_restore, monkeypatch):
    state = legacy_restore
    before = state.old.path.read_bytes()
    replace = db_transfer.os.replace
    def fail(source, target):
        if ".rollback-" in str(source) and target == state.old.path:
            raise OSError("synthetic rollback failure")
        return replace(source, target)
    monkeypatch.setattr(db_transfer.os, "replace", fail)
    monkeypatch.setattr(agent_store, "adopt_restored", Mock(side_effect=RuntimeError("synthetic adopt failure")))
    with pytest.raises(HTTPException) as caught:
        state.restore()
    assert caught.value.status_code == 500 and "되돌리지 못" in caught.value.detail
    assert any(p.read_bytes() == before for p in state.old.path.parent.glob(f"{state.old.path.stem}.bak-*.db"))


@pytest.mark.parametrize("fixed", [False, True])
@pytest.mark.parametrize("fail_adopt", [False, True])
def test_legacy_followup_agent_wal_snapshot_and_consumer_guards(legacy_restore, monkeypatch, fixed, fail_adopt):
    from app.routers import agent_chat as chat_router
    state = legacy_restore
    if fixed:
        monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "old-synthetic-key")
    with closing(sqlite3.connect(state.old.agent_path)) as conn:
        conversation_id = conn.execute("SELECT id FROM agent_chat_conversation").fetchone()[0]
    ready, release = threading.Event(), threading.Event()
    errors = []

    def writer():
        try:
            with agent_store.connect(state.old.agent_path) as conn:
                conn.execute("PRAGMA wal_autocheckpoint=0")
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("INSERT INTO agent_chat_turn(id,conversation_id,idempotency_key,status,text,context) "
                             "VALUES('wal-turn',?,'wal-key','done','WAL question','{}')", (conversation_id,))
                conn.execute("INSERT INTO agent_chat_event VALUES('wal-turn',1,'text',?,datetime('now'))",
                             (json.dumps({"text": "WAL answer"}),))
                conn.execute("INSERT INTO agent_chat_plan_binding(plan_id,turn_id,client_id) VALUES('wal-plan','wal-turn','local')")
                conn.execute("COMMIT")
                ready.set()
                assert release.wait(5)
        except BaseException as exc:
            errors.append(exc)
            ready.set()

    worker = threading.Thread(target=writer)
    worker.start()
    assert ready.wait(3) and not errors
    assert state.old.agent_path.with_name(state.old.agent_path.name + "-wal").stat().st_size > 0
    drain = agent_store.drain_connections
    def drain_and_release(keys, timeout):
        release.set()
        drain(keys, timeout)
    monkeypatch.setattr(agent_store, "drain_connections", drain_and_release)
    if fail_adopt:
        monkeypatch.setattr(agent_store, "adopt_restored", Mock(side_effect=RuntimeError("synthetic adopt failure")))
    try:
        with agent_store.request_scope():
            if fail_adopt:
                with pytest.raises(RuntimeError, match="synthetic adopt"):
                    state.restore()
            else:
                state.restore()
            with pytest.raises(agent_store.StaleRequest):
                agent_store.get_conversation(state.old.agent_path, conversation_id)
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and not errors
    active_account.set_active(ACCOUNT_A, "uid-a")
    current = db_transfer._capture_restore_target(full=True)
    path = state.old.agent_path if fail_adopt else current.agent_path
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute("SELECT text FROM agent_chat_turn WHERE id='wal-turn'").fetchone() == ("WAL question",)
        assert conn.execute("SELECT client_id FROM agent_chat_plan_binding WHERE plan_id='wal-plan'").fetchone() == ("local",)
        assert json.loads(conn.execute("SELECT payload FROM agent_chat_event WHERE turn_id='wal-turn'").fetchone()[0])["text"] == "WAL answer"
    if fail_adopt:
        assert agent_store.get_conversation(path, conversation_id)["resumable"]
        return
    conv = agent_store.get_conversation(path, conversation_id)
    assert conv["restored_from"] and not conv["resumable"]
    with pytest.raises(agent_store.ForkRefused, match="restored"):
        agent_store.fork_precheck(path, conversation_id)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(chat_router._bound_plan(SimpleNamespace(), current.old_identity, "wal-plan", conversation_id))
    assert caught.value.status_code == 409
    prefix = Mock(side_effect=AssertionError("Must not launch old CLI"))
    monkeypatch.setattr(agent_chat.process, "engine_prefix", prefix)
    with pytest.raises(agent_store.StaleRequest):
        agent_chat.service.start_turn(current.old_identity, conversation=conv, turn={}, model="fake", effort="high",
                                      text="blocked", context={}, still_current=lambda: None)
    prefix.assert_not_called()
    assert agent_chat.restored_reference(path, conversation_id)["turns"] == [{"you": "WAL question", "answer": "WAL answer"}]


@pytest.mark.parametrize("state", [None, (0, True)])
def test_legacy_followup_admission_nowait_never_opens_sqlite(legacy_restore, monkeypatch, state):
    monkeypatch.setattr(db, "pool_state_nowait", lambda: state)
    connect = Mock(side_effect=AssertionError("SQLite on event loop"))
    monkeypatch.setattr(db_transfer.sqlite3, "connect", connect)
    with pytest.raises(HTTPException) as caught:
        db_transfer._capture_restore_target_nowait()
    assert caught.value.status_code == 503
    connect.assert_not_called()


def test_legacy_followup_admission_import_reads_identity_in_worker(legacy_restore, monkeypatch):
    state = legacy_restore
    event_thread = threading.get_ident()
    capture = db_transfer._capture_restore_target
    threads = []
    def checked_capture(**kwargs):
        if kwargs.get("full"):
            threads.append(threading.get_ident())
            assert threads[-1] != event_thread
        return capture(**kwargs)
    monkeypatch.setattr(db_transfer, "_capture_restore_target", checked_capture)
    state.restore("import")
    assert threads


def test_legacy_followup_rollback_security_transaction_is_atomic(legacy_restore):
    state = legacy_restore
    path = state.paths["content"]
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("CREATE TRIGGER deny_restore BEFORE INSERT ON app_setting "
                     "WHEN NEW.key LIKE 'asset_mount_restore:%' BEGIN SELECT RAISE(ABORT,'synthetic denied'); END")
        conn.commit()
        before = conn.execute("SELECT key,value FROM app_setting ORDER BY key").fetchall()
    with pytest.raises(sqlite3.IntegrityError, match="synthetic denied"):
        db_transfer._post_install_security_init(path)
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute("SELECT key,value FROM app_setting ORDER BY key").fetchall() == before
        assert conn.execute("SELECT revoked_at FROM mcp_client").fetchone() == (None,)


@pytest.mark.parametrize("target", ["existing", "content", "trash", "mounts"])
def test_legacy_followup_agent_target_collision_is_noop(legacy_restore, monkeypatch, target):
    state = legacy_restore
    destinations = {"content": state.old.path, "trash": state.trash, "mounts": state.old.mounts_path,
                    "existing": state.hub.root / "agent" / "foreign.db"}
    if target == "existing":
        destinations[target].write_bytes(b"foreign history")
    file_path = agent_chat.Identity.file_path
    monkeypatch.setattr(agent_chat.Identity, "file_path", lambda ident:
                        file_path(ident) if ident.hub == state.old.old_identity.hub else destinations[target])
    before = {p: p.read_bytes() for p in (state.old.path, state.old.agent_path, destinations[target])}
    with pytest.raises(HTTPException) as caught:
        state.restore()
    assert caught.value.status_code == 409
    assert before == {p: p.read_bytes() for p in before}
    assert not list(state.hub.root.rglob("*.bak-*"))


@pytest.mark.parametrize("versioned", [False, True])
def test_full_restore_http_entry_returns_relogin_and_restored_members(full_restore, versioned):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(db_transfer.router)
    state = full_restore
    selected_id = backup_manifest.seal(state.manifest)["backup_set_id"]
    route = "/api/db/server-restore" + (f"/{selected_id}" if versioned else "")
    with TestClient(app, client=("127.0.0.1", 50321)) as client:
        response = client.post(route)
    assert response.status_code == 200, response.text
    assert response.json()["relogin_required"]
    assert response.json()["restored_roles"]["agent_chat"] == "present"
    assert not active_account._POINTER.exists()
    active_account.set_active(ACCOUNT_A, "uid-a")
    final = db_transfer._capture_restore_target(full=True)
    assert agent_store.get_conversation(final.agent_path, "record")["restored_from"]


def test_full_restore_drain_timeout_never_replaces_open_agent_file(full_restore, monkeypatch):
    state = full_restore
    original = agent_chat.service.restore_guard
    monkeypatch.setattr(agent_chat.service, "restore_guard", lambda identities, **kwargs: original(identities, timeout=0.01))
    before = (state.old.path.read_bytes(), state.old.agent_path.read_bytes(), state.old.mounts_path.read_bytes())
    with agent_store.connect(state.old.agent_path):
        with pytest.raises(HTTPException) as error:
            db_transfer.server_restore(state.hub.request)
        assert error.value.status_code == 503
        assert before == (state.old.path.read_bytes(), state.old.agent_path.read_bytes(), state.old.mounts_path.read_bytes())
        assert not list(state.hub.root.rglob("*.bak-*"))
    assert agent_store.path_key(state.old.agent_path) not in agent_store._gates


def test_full_restore_rollback_reinstates_original_absence(full_restore, monkeypatch):
    state = full_restore
    state.trash.unlink()
    state.old.agent_path.unlink()
    state.old.mounts_path.unlink()
    before = state.old.path.read_bytes()
    clear = db_transfer._strict_clear_active
    def fail_after_clear():
        clear()
        raise RuntimeError("synthetic logout failure")
    monkeypatch.setattr(db_transfer, "_strict_clear_active", fail_after_clear)
    with pytest.raises(RuntimeError):
        db_transfer.server_restore(state.hub.request)
    assert state.old.path.read_bytes() == before
    assert not state.trash.exists() and not state.old.agent_path.exists() and not state.old.mounts_path.exists()
    assert not list(config.AGENT_CHAT_DIR.glob("*.db"))
    assert active_account.account_key() == ACCOUNT_A
