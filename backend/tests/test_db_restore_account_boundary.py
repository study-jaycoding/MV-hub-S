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
def test_unchanged_or_aba_target_preserves_restore_contract(
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
