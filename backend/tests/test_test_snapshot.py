"""test_push-db → test_pull-db 다중 DB 스냅샷 번들 검증."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException


def test_balance_scrub_removes_rows_nested_payloads_and_deleted_pages(tmp_path):
    from app import db_hf_balance
    from app.services.db_scrub import scrub_hf_balance
    path=tmp_path/'copied.db'
    secret='balance-private-marker-1827'
    with sqlite3.connect(path) as conn:
        db_hf_balance.migrate(conn)
        conn.execute('CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT)')
        conn.execute('CREATE TABLE account_report_outbox(payload_json TEXT)')
        conn.execute('INSERT INTO app_setting VALUES(?,?)',('hf_status:x',json.dumps({'email':'x','balance_report':{'observations':[secret]}})))
        conn.execute('INSERT INTO account_report_outbox VALUES(?)',(json.dumps({'account_status':{'balance_report':[secret]}}),))
        conn.execute('CREATE TABLE old_deleted(value TEXT)')
        conn.execute('INSERT INTO old_deleted VALUES(?)',(secret*1000,))
        conn.commit()
        conn.execute('DELETE FROM old_deleted')
    scrub_hf_balance(path)
    assert secret.encode() not in path.read_bytes()
    with sqlite3.connect(path) as conn:
        assert json.loads(conn.execute('SELECT value FROM app_setting').fetchone()[0])=={'email':'x'}
        assert conn.execute('SELECT COUNT(*) FROM hf_balance_outbox').fetchone()[0]==0
from starlette.requests import Request
from starlette.responses import Response

from app.routers import db_transfer
from app.routers.db_transfer import export_test_snapshot
from app.services.test_snapshot import (
    MANIFEST_NAME,
    SNAPSHOT_EXPORT_ENV,
    SNAPSHOT_EXPORT_PATH,
    SNAPSHOT_FORMAT,
    SNAPSHOT_TOKEN_ENV,
    SNAPSHOT_TOKEN_HEADER,
    SNAPSHOT_VERSION,
    TestSnapshotError,
    create_test_snapshot_archive,
    extract_test_snapshot_archive,
)


def _request(path: str = SNAPSHOT_EXPORT_PATH, snapshot_token: str | None = None) -> Request:
    headers = []
    if snapshot_token is not None:
        headers.append((SNAPSHOT_TOKEN_HEADER.lower().encode(), snapshot_token.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "client": ("192.168.1.20", 50000),
            "server": ("192.168.1.199", 8011),
        }
    )


def _db(path: Path, schema: str, insert: str | None = None) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(schema)
    if insert:
        conn.execute(insert)
    conn.commit()
    return conn


def test_snapshot_round_trip_keeps_all_db_files_and_committed_wal_rows(tmp_path: Path):
    data = tmp_path / "data"
    connections = [
        _db(
            data / "db" / "content_hub.db",
            "CREATE TABLE generation(id TEXT PRIMARY KEY, prompt TEXT)",
            "INSERT INTO generation VALUES('g1','from wal')",
        ),
        _db(
            data / "db" / "content_hub_trash.db",
            "CREATE TABLE trashed_generation(id TEXT PRIMARY KEY)",
            "INSERT INTO trashed_generation VALUES('trash-1')",
        ),
        _db(
            data / "db" / "manage_hub.db",
            "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY)",
            "INSERT INTO team_generation_fact VALUES('fact-1')",
        ),
        _db(
            data / "db" / "acct" / "worker" / "content_hub.db",
            "CREATE TABLE generation(id TEXT PRIMARY KEY, prompt TEXT)",
            "INSERT INTO generation VALUES('acct-1','private')",
        ),
    ]
    archive = create_test_snapshot_archive(data)
    try:
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            assert MANIFEST_NAME in names
            assert "db/content_hub.db" in names
            assert "db/content_hub_trash.db" in names
            assert "db/manage_hub.db" in names
            assert "db/acct/worker/content_hub.db" in names
            assert not any(name.endswith(("-wal", "-shm")) for name in names)

        installed = extract_test_snapshot_archive(archive, tmp_path / "installed")
        assert len(installed) == 4
        with sqlite3.connect(tmp_path / "installed" / "db" / "content_hub.db") as conn:
            assert conn.execute("SELECT prompt FROM generation WHERE id='g1'").fetchone()[0] == "from wal"
        with sqlite3.connect(tmp_path / "installed" / "db" / "manage_hub.db") as conn:
            assert conn.execute("SELECT COUNT(*) FROM team_generation_fact").fetchone()[0] == 1
    finally:
        archive.unlink(missing_ok=True)
        for conn in connections:
            conn.close()


@pytest.mark.parametrize("unsafe_name", ["../evil.db", "db/../../evil.db", "db/..\\evil.db"])
def test_snapshot_extract_rejects_path_traversal(tmp_path: Path, unsafe_name: str):
    archive = tmp_path / "unsafe.zip"
    manifest = {
        "format": SNAPSHOT_FORMAT,
        "version": SNAPSHOT_VERSION,
        "files": [{"path": unsafe_name, "size": 3}],
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(unsafe_name, b"bad")
        bundle.writestr(MANIFEST_NAME, json.dumps(manifest))

    destination = tmp_path / "installed"
    with pytest.raises(TestSnapshotError):
        extract_test_snapshot_archive(archive, destination)

    assert not destination.exists()
    assert not (tmp_path / "evil.db").exists()


def test_snapshot_export_endpoint_is_hidden_without_explicit_flag(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", raising=False)

    with pytest.raises(HTTPException) as exc:
        export_test_snapshot(None)  # type: ignore[arg-type] -- gate runs before request auth

    assert exc.value.status_code == 404


def test_enabled_snapshot_endpoint_returns_multi_db_zip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    data = tmp_path / "server-data"
    primary = _db(
        data / "db" / "content_hub.db",
        "CREATE TABLE generation(id TEXT PRIMARY KEY)",
        "INSERT INTO generation VALUES('g1')",
    )
    manage = _db(
        data / "db" / "manage_hub.db",
        "CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY)",
        "INSERT INTO team_generation_fact VALUES('fact1')",
    )
    monkeypatch.setenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", "1")
    monkeypatch.setenv(SNAPSHOT_TOKEN_ENV, "single-use-export-token")
    monkeypatch.setattr(db_transfer, "DATA_DIR", data)

    response = export_test_snapshot(_request(snapshot_token="single-use-export-token"))
    archive = Path(response.path)
    try:
        with zipfile.ZipFile(archive) as bundle:
            assert {"db/content_hub.db", "db/manage_hub.db"}.issubset(bundle.namelist())
        assert response.media_type == "application/zip"
        # MV_server 자동 재시작으로 메모리가 초기화돼도 데이터 폴더 표식이 재사용을 막는다.
        monkeypatch.setattr(db_transfer, "_snapshot_token_consumed", None)
        monkeypatch.setattr(db_transfer, "_snapshot_token_in_progress", None)
        with pytest.raises(HTTPException) as reused:
            export_test_snapshot(_request(snapshot_token="single-use-export-token"))
        assert reused.value.status_code == 410
    finally:
        archive.unlink(missing_ok=True)
        primary.close()
        manage.close()


def test_snapshot_endpoint_rejects_wrong_code_before_building_archive(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", "1")
    monkeypatch.setenv(SNAPSHOT_TOKEN_ENV, "expected-export-token")
    called = False

    def unexpected_build(_data_dir: Path):
        nonlocal called
        called = True
        raise AssertionError("wrong code must not build a snapshot")

    monkeypatch.setattr(db_transfer, "create_test_snapshot_archive", unexpected_build)
    with pytest.raises(HTTPException) as exc:
        export_test_snapshot(_request(snapshot_token="wrong-token"))

    assert exc.value.status_code == 401
    assert called is False


def test_snapshot_build_failure_releases_code_for_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    data = tmp_path / "retry-data"
    token = "retry-after-build-failure-token"
    monkeypatch.setenv("CONTENT_HUB_TEST_SNAPSHOT_EXPORT", "1")
    monkeypatch.setenv(SNAPSHOT_TOKEN_ENV, token)
    monkeypatch.setattr(db_transfer, "DATA_DIR", data)

    with pytest.raises(HTTPException) as failed:
        export_test_snapshot(_request(snapshot_token=token))
    assert failed.value.status_code == 500

    conn = _db(data / "db" / "content_hub.db", "CREATE TABLE generation(id TEXT PRIMARY KEY)")
    response = export_test_snapshot(_request(snapshot_token=token))
    try:
        assert response.media_type == "application/zip"
    finally:
        Path(response.path).unlink(missing_ok=True)
        conn.close()


def test_auth_middleware_exempts_only_exact_snapshot_download_path(
    monkeypatch: pytest.MonkeyPatch,
):
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "AUTH_ENABLED", True)

    async def pass_through(_request: Request) -> Response:
        return Response(status_code=204)

    allowed = asyncio.run(main_mod.auth_enforcement(_request(), pass_through))
    denied = asyncio.run(
        main_mod.auth_enforcement(_request(path=f"{SNAPSHOT_EXPORT_PATH}/extra"), pass_through)
    )

    assert allowed.status_code == 204
    assert denied.status_code == 401


def test_snapshot_server_mode_blocks_registration_and_regular_api(
    monkeypatch: pytest.MonkeyPatch,
):
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "AUTH_ENABLED", True)
    monkeypatch.setenv(SNAPSHOT_EXPORT_ENV, "1")

    async def pass_through(_request: Request) -> Response:
        return Response(status_code=204)

    snapshot = asyncio.run(main_mod.auth_enforcement(_request(), pass_through))
    health = asyncio.run(main_mod.auth_enforcement(_request(path="/api/health"), pass_through))
    register = asyncio.run(
        main_mod.auth_enforcement(_request(path="/api/auth/register"), pass_through)
    )
    regular_export = asyncio.run(
        main_mod.auth_enforcement(_request(path="/api/db/export"), pass_through)
    )

    assert snapshot.status_code == 204
    assert health.status_code == 204
    assert register.status_code == 404
    assert regular_export.status_code == 404


def test_snapshot_server_does_not_bootstrap_a_login_account(monkeypatch: pytest.MonkeyPatch):
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "AUTH_ENABLED", True)
    monkeypatch.setenv(SNAPSHOT_EXPORT_ENV, "1")
    assert main_mod._should_bootstrap_admin() is False

    monkeypatch.delenv(SNAPSHOT_EXPORT_ENV)
    assert main_mod._should_bootstrap_admin() is True


ACCOUNT_SCHEMA = (
    "CREATE TABLE account("
    "email TEXT PRIMARY KEY, name TEXT, password_hash TEXT NOT NULL, "
    "status TEXT NOT NULL DEFAULT 'pending', global_role TEXT, creator_uid TEXT, "
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), approved_at TEXT, "
    "password_changed_at TEXT)"
)


def _secrets_db(path: Path) -> None:
    """운영 비밀값(서명키·세션·실계정 해시)이 든 허브 DB 를 흉내 낸다."""
    from app.services import auth

    conn = _db(path, "CREATE TABLE generation(id TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
    conn.execute(
        "INSERT INTO app_setting VALUES('auth_secret','prod-secret'),"
        "('shared_server_token','prod-token'),('comfy_api_key','prod-comfy-key'),"
        "('shared_server_url','http://srv:8010')"
    )
    conn.execute(ACCOUNT_SCHEMA)
    conn.execute(
        "INSERT INTO account(email, password_hash, status, global_role) VALUES(?,?,?,?)",
        ("boss@team.com", auth.hash_password("prod-pw"), "approved", "admin"),
    )
    conn.commit()
    conn.close()


def test_snapshot_scrubs_secrets_and_creates_single_test_admin(tmp_path: Path):
    # ★보안 계약: 번들 어디에도 운영 auth_secret·세션 토큰·운영 비밀번호 해시가 남지 않고,
    #  로그인 가능한 계정은 기본 DB의 테스트 관리자 1명뿐이다(계정별 DB엔 생성 안 함).
    from app.services import auth
    from app.services.db_scrub import (
        DISABLED_PASSWORD_HASH,
        TEST_ADMIN_EMAIL,
        TEST_ADMIN_PASSWORD,
    )

    data = tmp_path / "data"
    _secrets_db(data / "db" / "content_hub.db")
    _secrets_db(data / "db" / "acct" / "worker" / "content_hub.db")

    archive = create_test_snapshot_archive(data)
    dest = tmp_path / "installed"
    try:
        extract_test_snapshot_archive(archive, dest)
    finally:
        archive.unlink(missing_ok=True)

    for rel, is_primary in (
        (Path("db") / "content_hub.db", True),
        (Path("db") / "acct" / "worker" / "content_hub.db", False),
    ):
        conn = sqlite3.connect(dest / rel)
        conn.row_factory = sqlite3.Row
        try:
            keys = {r["key"] for r in conn.execute("SELECT key FROM app_setting")}
            assert "auth_secret" not in keys and "shared_server_token" not in keys
            assert "comfy_api_key" not in keys  # Cloud API 키 — 자격증명은 PC 밖으로 안 나간다
            assert "shared_server_url" in keys  # 무해한 서버 주소는 보존
            rows = {
                r["email"]: r
                for r in conn.execute("SELECT email, password_hash, status FROM account")
            }
            prod = rows["boss@team.com"]
            assert prod["password_hash"] == DISABLED_PASSWORD_HASH
            assert not auth.verify_password("prod-pw", prod["password_hash"])
            if is_primary:
                admin = rows[TEST_ADMIN_EMAIL]
                assert admin["status"] == "approved"
                assert auth.verify_password(TEST_ADMIN_PASSWORD, admin["password_hash"])
            else:
                assert TEST_ADMIN_EMAIL not in rows
        finally:
            conn.close()


def test_transfer_strip_keeps_account_hashes(tmp_path: Path):
    # 전송 프로파일은 세션·서명키만 지운다 — 계정 해시를 건드리면 server-backup 복원 후
    # 본인 로그인이 불가능해진다(테스트 스냅샷 프로파일과 강도가 달라야 하는 이유).
    from app.services import auth
    from app.services.db_scrub import strip_transfer_secrets

    path = tmp_path / "mine.db"
    _secrets_db(path)
    strip_transfer_secrets(path)

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        keys = {r["key"] for r in conn.execute("SELECT key FROM app_setting")}
        assert "auth_secret" not in keys and "shared_server_token" not in keys
        assert "comfy_api_key" not in keys  # 서버 백업 사본에도 API 키를 올리지 않는다
        row = conn.execute("SELECT password_hash FROM account").fetchone()
        assert auth.verify_password("prod-pw", row["password_hash"])
    finally:
        conn.close()


def test_org_usage_scrub_removes_deleted_page_bytes_and_fails_closed(tmp_path):
    from app.db_hf_org_usage import TABLES, migrate
    from app.services.db_scrub import scrub_test_snapshot_db
    path = tmp_path / "organization.db"
    marker = "fake-secret-large-marker-" * 400
    with sqlite3.connect(path) as conn:
        migrate(conn)
        conn.execute("PRAGMA secure_delete=OFF")
        conn.execute("UPDATE hf_org_usage_config SET encrypted_key=?", ("old-fake-marker-" * 800,))
        conn.commit()
        conn.execute("UPDATE hf_org_usage_config SET encrypted_key=?", (marker,))
        conn.execute("INSERT INTO hf_org_identity_link(org_id,actor_user_id,state) VALUES('org','actor','stale')")
    has_marker = b"fake-secret-large-marker-" in path.read_bytes()
    assert has_marker
    scrub_test_snapshot_db(path, create_test_admin=False)
    has_marker = b"fake-secret-large-marker-" in path.read_bytes()
    assert not has_marker
    has_old_marker = b"old-fake-marker-" in path.read_bytes()
    assert not has_old_marker
    with sqlite3.connect(path) as conn:
        assert all(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0 for table in TABLES)
        conn.execute("INSERT INTO hf_org_usage_config(singleton,encrypted_key) VALUES(1,'fake')")
        conn.execute("CREATE TRIGGER refuse_scrub BEFORE DELETE ON hf_org_usage_config BEGIN SELECT RAISE(ABORT,'blocked'); END")
    with pytest.raises(sqlite3.DatabaseError):
        scrub_test_snapshot_db(path, create_test_admin=False)


def test_balance_scrub_skips_compaction_when_only_unrelated_settings_exist(tmp_path, monkeypatch):
    from app import db_hf_balance
    from app.services import db_scrub
    path = tmp_path / 'no-balance.db'
    with sqlite3.connect(path) as conn:
        db_hf_balance.migrate(conn)
        conn.execute('CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT)')
        conn.execute('INSERT INTO app_setting VALUES(?,?)', ('hf_status:local', json.dumps({'email':'local'})))
    traces = []
    original = db_scrub.sqlite3.connect
    def connect(*args, **kwargs):
        conn = original(*args, **kwargs)
        conn.set_trace_callback(traces.append)
        return conn
    monkeypatch.setattr(db_scrub.sqlite3, 'connect', connect)
    db_scrub.scrub_hf_balance(path)
    assert not any('VACUUM' in statement for statement in traces)
    assert not any('wal_checkpoint' in statement for statement in traces)
