"""실제 SQLite에서 계정별 최신본 CAS·복구 사본·HTTP 경계를 검증한다."""

import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import active_account, config, db, repo
from app.repo import edit_docs as store
from app.routers import edit_docs, _proxy
from app.services import backup as backup_service, worker_backup

HEADER = "X-MVHub-Expect-Account"
KEY = "old:project/non-uuid:sequence"
OWNER = "a@example.com"


def raw(label):
    return json.dumps({"v": 1, "clips": [], "label": label}, ensure_ascii=False)


def digest(data):
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / "content.db"
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    token = active_account.set_override("")
    db.flush_pool()
    db.init_db()
    try:
        yield path
    finally:
        db.flush_pool()
        active_account.reset_override(token)


def test_head_cas_and_conflict_copies(database):
    first = repo.save_edit_backup(OWNER, KEY, raw("one"), None)
    assert first["status"] == "saved" and first["head"]["revision"] == 1
    assert repo.save_edit_backup(OWNER, KEY, raw("one"), None)["status"] == "same"
    assert repo.save_edit_backup(OWNER, KEY, raw("two"), 1)["head"]["revision"] == 2
    for index in range(8):
        result = repo.save_edit_backup(OWNER, KEY, raw(index), 1)
        assert result["status"] == "conflict"
        assert result["head"]["revision"] == 2
    repo.save_edit_backup(OWNER, KEY, raw(0), None)
    listing = repo.get_edit_backup(OWNER, KEY, include_data=True)
    assert listing["head"]["data"] == raw("two")
    assert listing["total_copies"] == 8
    assert all("data" not in item for item in listing["copies"])
    selected = repo.get_edit_backup(OWNER, KEY, copy_hash=digest(raw(0)), include_data=True)
    assert selected["copy"]["data"] == raw(0)
    assert "data" not in selected["head"]
    pages = [repo.get_edit_backup(OWNER, KEY, offset=n, limit=3)["copies"] for n in (0, 3, 6)]
    assert sum(pages, []) == listing["copies"]
    assert repo.get_edit_backup("b@example.com", KEY)["head"] is None
    assert repo.get_edit_backup(OWNER, KEY + ":other")["head"] is None
    with pytest.raises(LookupError):
        repo.get_edit_backup("b@example.com", KEY, copy_hash=digest(raw(0)), include_data=True)


def test_concurrent_same_base_has_one_winner_and_one_preserved_copy(database):
    repo.save_edit_backup(OWNER, KEY, raw("base"), None)
    barrier = Barrier(2)

    def save(label):
        barrier.wait(timeout=5)
        return label, repo.save_edit_backup(OWNER, KEY, raw(label), 1)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ("left", "right")))
    assert sorted(result["status"] for _, result in results) == ["conflict", "saved"]
    winner = next(label for label, result in results if result["status"] == "saved")
    loser = next(label for label, result in results if result["status"] == "conflict")
    state = repo.get_edit_backup(OWNER, KEY, include_data=True)
    assert state["head"]["revision"] == 2
    assert state["head"]["data"] == raw(winner)
    assert state["copies"][0]["data_hash"] == digest(raw(loser))


# ── 충돌 사본 상한(2026-10-26 Jay "계속 쌓이는 건 나중에 문제") — 문서마다 conflict 최대 20 · 명시적 보존은 세지도 지우지도 않는다 ──
EXPLICIT = ["local_preserve", "pre_restore", "pre_adopt"]


def kinds(path, owner=OWNER, key=KEY):
    with closing(sqlite3.connect(path)) as conn:
        return dict(conn.execute("SELECT data_hash, kind FROM edit_doc_copy WHERE owner=? AND doc_key=?", (owner, key)).fetchall())


def conflicts(path, owner=OWNER, key=KEY):
    return sum(1 for kind in kinds(path, owner, key).values() if kind == "conflict")


def insert_copy(path, data, kind, created_at, owner=OWNER, key=KEY):
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("INSERT INTO edit_doc_copy(owner,doc_key,data_hash,data,kind,created_at) VALUES(?,?,?,?,?,?)",
                     (owner, key, digest(data), data, kind, created_at))
        conn.commit()


def test_conflict_copies_capped_at_20_per_document_and_current_always_kept(database):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    for owner, key in (("b@example.com", KEY), (OWNER, KEY + ":other")):  # 다른 계정·다른 문서는 그대로
        repo.save_edit_backup(owner, key, raw("head"), None)
        for index in range(3):
            repo.save_edit_backup(owner, key, raw(f"o{index}"), None)
    for index in range(25):
        result = repo.save_edit_backup(OWNER, KEY, raw(f"c{index}"), None)
        assert result["status"] == "conflict" and result["copy_hash"] in kinds(database)  # 응답이 보존했다는 사본은 늘 있다
    assert conflicts(database) == 20 and set(kinds(database).values()) == {"conflict"}
    assert conflicts(database, "b@example.com") == 3 and conflicts(database, key=KEY + ":other") == 3
    assert repo.get_edit_backup(OWNER, KEY)["total_copies"] == 20


@pytest.mark.parametrize("kind", EXPLICIT)
def test_explicit_preserve_upgrades_existing_conflict_copy_and_survives_cap(database, kind):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    x = raw("x")
    assert repo.save_edit_backup(OWNER, KEY, x, None)["status"] == "conflict"
    if kind == "local_preserve":
        repo.restore_edit_backup(OWNER, KEY, 1, data=raw("restored"), local_raw=x)
    else:  # head 를 X 로 만든 뒤 복원·채택 직전 head 보존
        assert repo.save_edit_backup(OWNER, KEY, x, 1)["status"] == "saved"
        repo.restore_edit_backup(OWNER, KEY, 2, data=raw("restored"), kind=kind)
    assert kinds(database)[digest(x)] == kind
    for index in range(25):
        repo.save_edit_backup(OWNER, KEY, raw(f"c{index}"), None)
    assert kinds(database)[digest(x)] == kind and conflicts(database) == 20
    assert repo.save_edit_backup(OWNER, KEY, x, None)["status"] == "conflict"  # 충돌로 다시 와도 내리지 않는다
    assert kinds(database)[digest(x)] == kind


@pytest.mark.parametrize("kind", EXPLICIT)
def test_conflict_put_of_explicit_copy_keeps_all_20_conflicts(database, kind):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    explicit = raw("explicit")
    insert_copy(database, explicit, kind, "2026-01-01T00:00:00.000Z")
    for index in range(20):
        insert_copy(database, raw(f"c{index:02d}"), "conflict", f"2026-02-01T00:00:{index:02d}.000Z")
    result = repo.save_edit_backup(OWNER, KEY, explicit, None)
    assert result["status"] == "conflict" and result["copy_hash"] == digest(explicit)
    state = kinds(database)
    assert state[digest(explicit)] == kind and conflicts(database) == 20


def test_legacy_conflicts_resend_oldest_keeps_it_plus_latest_19_and_trimmed_hash_returns_as_new(database):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    for index in range(25):  # 상한 전 운영으로 쌓인 25개(시각이 다르다)
        insert_copy(database, raw(f"old{index:02d}"), "conflict", f"2026-01-01T00:00:{index:02d}.000Z")
    result = repo.save_edit_backup(OWNER, KEY, raw("old00"), None)
    assert result["status"] == "conflict" and result["copy_hash"] == digest(raw("old00"))
    assert set(kinds(database)) == {digest(raw("old00"))} | {digest(raw(f"old{index:02d}")) for index in range(6, 25)}
    assert repo.save_edit_backup(OWNER, KEY, raw("old01"), None)["status"] == "conflict"  # 지워진 원문이 다시 오면 새 사본
    state = kinds(database)
    assert digest(raw("old01")) in state and len(state) == 20 and digest(raw("old00")) not in state


def test_same_time_conflicts_are_trimmed_in_list_order(database):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    hashes = []
    for index in range(25):
        data = raw(f"same{index}")
        insert_copy(database, data, "conflict", "2026-01-01T00:00:00.000Z")
        hashes.append(digest(data))
    repo.save_edit_backup(OWNER, KEY, raw("new"), None)
    expected = [digest(raw("new"))] + sorted(hashes, reverse=True)[:19]
    assert [row["data_hash"] for row in repo.get_edit_backup(OWNER, KEY, limit=100)["copies"]] == expected


def test_trim_failure_rolls_back_deletion_copy_and_head(database, monkeypatch):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    for index in range(20):
        insert_copy(database, raw(f"c{index:02d}"), "conflict", f"2026-01-01T00:00:{index:02d}.000Z")
    before = repo.get_edit_backup(OWNER, KEY, include_data=True, limit=100)
    original = store._trim_conflicts

    def fail_after_trim(*args):
        original(*args)  # 가장 오래된 c00 을 실제로 지운 뒤
        raise sqlite3.OperationalError("injected trim failure")

    monkeypatch.setattr(store, "_trim_conflicts", fail_after_trim)
    with pytest.raises(sqlite3.OperationalError):
        repo.save_edit_backup(OWNER, KEY, raw("x"), None)
    assert repo.get_edit_backup(OWNER, KEY, include_data=True, limit=100) == before


def test_restore_of_trimmed_copy_writes_nothing(database):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    insert_copy(database, raw("oldest"), "conflict", "2026-01-01T00:00:00.000Z")
    for index in range(20):
        repo.save_edit_backup(OWNER, KEY, raw(f"c{index}"), None)
    assert digest(raw("oldest")) not in kinds(database)
    before = repo.get_edit_backup(OWNER, KEY, include_data=True)
    with pytest.raises(LookupError):
        repo.restore_edit_backup(OWNER, KEY, 1, copy_hash=digest(raw("oldest")), local_raw=raw("local"))
    assert repo.get_edit_backup(OWNER, KEY, include_data=True) == before


def test_restore_preserves_both_versions_and_retry_local_raw(database):
    repo.save_edit_backup(OWNER, KEY, raw("old"), None)
    repo.save_edit_backup(OWNER, KEY, raw("saved copy"), None)
    result = repo.restore_edit_backup(OWNER, KEY, 1, copy_hash=digest(raw("saved copy")), local_raw="broken local JSON")
    assert result["status"] == "saved" and result["head"]["revision"] == 2
    # 응답 유실 재시도는 버전을 올리지 않되 또 다른 로컬 원문도 남긴다.
    retry = repo.restore_edit_backup(OWNER, KEY, 1, data=raw("saved copy"), local_raw=raw("another local"))
    assert retry["status"] == "same" and retry["head"]["revision"] == 2
    repo.save_edit_backup(OWNER, KEY, raw("later edit"), 2)
    state = repo.get_edit_backup(OWNER, KEY, include_data=True)
    assert state["head"]["data"] == raw("later edit")
    assert {row["data_hash"] for row in state["copies"]} == {digest(data) for data in (raw("old"), raw("saved copy"), "broken local JSON", raw("another local"))}
    before = state
    assert repo.restore_edit_backup(OWNER, KEY, 1, data=raw("stale restore"), local_raw=raw("local"))["status"] == "conflict"
    assert repo.get_edit_backup(OWNER, KEY, include_data=True) == before
    with pytest.raises(ValueError):
        repo.restore_edit_backup(OWNER, KEY, 3, copy_hash=digest("broken local JSON"))
    assert repo.get_edit_backup(OWNER, KEY, include_data=True) == before


def test_restore_failure_rolls_back_preservation_and_head(database, monkeypatch):
    repo.save_edit_backup(OWNER, KEY, raw("old"), None)
    before = repo.get_edit_backup(OWNER, KEY, include_data=True)
    original = store._copy

    def fail_after_insert(*args):
        original(*args)
        raise sqlite3.OperationalError("injected write failure")

    monkeypatch.setattr(store, "_copy", fail_after_insert)
    with pytest.raises(sqlite3.OperationalError):
        repo.restore_edit_backup(OWNER, KEY, 1, data=raw("restore"), local_raw=raw("local"))
    assert repo.get_edit_backup(OWNER, KEY, include_data=True) == before


@pytest.mark.parametrize("data", ['{}', '[]', '{"v":true,"clips":[]}', '{"v":4,"clips":[]}', '{"v":2.0,"clips":[]}', '{"v":1,"clips":{}}', '{"v":1,"v":1,"clips":[]}', '{"v":1,"clips":[],"x":NaN}', '{"v":1,"clips":[{"x":1,"x":2}]}', '{"v":1,"clips":[],' ])
def test_invalid_document_rejected_without_writes(database, data):
    with pytest.raises(ValueError):
        repo.save_edit_backup(OWNER, KEY, data, None)
    assert repo.get_edit_backup(OWNER, KEY)["head"] is None


def test_speed_document_v2_is_kept_verbatim(database):
    # 속도를 쓴 편집 문서(v 2, 2026-10-23)도 백업한다 — 원문 그대로
    data = '{"v":2,"clips":[{"cut":"s/c1","gen":"g","track":1,"speed":1.5}],"tracksOff":[],"tracksLocked":[]}'
    assert repo.save_edit_backup(OWNER, KEY, data, None)["status"] == "saved"
    assert repo.get_edit_backup(OWNER, KEY, include_data=True)["head"]["data"] == data


def test_repeat_slot_document_v3_is_kept_verbatim(database):
    # 같은 컷을 컷 사이에 한 번 더 놓은 편집 문서(v 3·slot·자리 열쇠 '폴더//ID', 2026-10-23)도 백업한다 — 원문 그대로
    data = ('{"v":3,"clips":[{"cut":"s/c1","gen":"g","track":1},{"cut":"s/c1","slot":"abc123","gen":"g","track":1,"speed":2}],'
            '"tracksOff":[],"tracksLocked":[],"cutOrder":["s/c1","s/c2","s/c1//abc123"]}')
    assert repo.save_edit_backup(OWNER, KEY, data, None)["status"] == "saved"
    assert repo.get_edit_backup(OWNER, KEY, include_data=True)["head"]["data"] == data


def test_byte_boundary_is_utf8_not_characters(database):
    base = raw("")
    exact = raw("x" * (store.MAX_EDIT_BYTES - len(base.encode("utf-8"))))
    assert repo.save_edit_backup(OWNER, KEY, exact, None)["status"] == "saved"
    with pytest.raises(ValueError):
        repo.save_edit_backup(OWNER, KEY, exact + " ", 1)
    with pytest.raises(ValueError):
        repo.save_edit_backup(OWNER, KEY, raw("한" * 400000), 1)
    assert repo.get_edit_backup(OWNER, KEY)["head"]["bytes"] == store.MAX_EDIT_BYTES


def test_database_snapshot_includes_both_tables_and_reinit_preserves_data(database, tmp_path, monkeypatch):
    repo.save_edit_backup(OWNER, KEY, raw("head"), None)
    repo.save_edit_backup(OWNER, KEY, raw("conflict"), None)
    monkeypatch.setattr(backup_service, "MANAGE_DB_PATH", tmp_path / "unused-manage.db")
    backup = backup_service._backup_now_for_scope(database, tmp_path / "backups")
    assert backup is not None
    with closing(sqlite3.connect(backup)) as restored:
        assert restored.execute("SELECT data FROM edit_doc_head").fetchone()[0] == raw("head")
        assert restored.execute("SELECT data FROM edit_doc_copy").fetchone()[0] == raw("conflict")
        assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    summary = worker_backup.metadata_summary(backup)
    assert summary["timelines"] == 2 and summary["meaningful_records"] >= 2
    db.init_db()
    assert repo.get_edit_backup(OWNER, KEY)["total_copies"] == 1


def test_old_database_upgrade_keeps_existing_rows(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with closing(sqlite3.connect(path)) as conn:
        # Recognizable pre-ledger content DB; an arbitrary foreign table alone is rejected.
        conn.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO app_setting VALUES('theme','legacy-kept')")
        conn.execute("CREATE TABLE legacy_evidence(value TEXT)")
        conn.execute("INSERT INTO legacy_evidence VALUES('kept')")
        conn.commit()
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    db.init_db()
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute("SELECT value FROM legacy_evidence").fetchone()[0] == "kept"
        assert conn.execute("SELECT value FROM app_setting WHERE key='theme'").fetchone()[0] == "legacy-kept"
        assert conn.execute("SELECT COUNT(*) FROM edit_doc_head").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM edit_doc_copy").fetchone()[0] == 0


@pytest.fixture
def client(database, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "capture_account_pin", lambda: ("", None))
    app = FastAPI()
    app.include_router(edit_docs.router)
    with TestClient(app) as client:
        yield client


def test_http_header_validation_and_restore_contract(client):
    body = {"doc_key": KEY, "data": raw("one"), "base_revision": None}
    assert client.put("/api/edit-docs/backup", json=body).status_code == 409
    assert client.put("/api/edit-docs/backup", json=body, headers={HEADER: "acct:other@example.com"}).status_code == 409
    headers = {HEADER: "local"}
    assert client.put("/api/edit-docs/backup", json=body, headers=headers).json()["status"] == "saved"
    assert client.get("/api/edit-docs/backup", params={"doc_key": KEY}).status_code == 409
    assert client.put("/api/edit-docs/backup", json={**body, "base_revision": True}, headers=headers).status_code == 422
    assert client.put("/api/edit-docs/backup", json={**body, "data": "bad"}, headers=headers).status_code == 400
    restore = {"doc_key": KEY, "base_revision": 1, "source": {"copy_hash": "0" * 64}}
    assert client.post("/api/edit-docs/backup/restore", json=restore, headers=headers).status_code == 404
    restore["source"] = {"data": raw("two")}
    assert client.post("/api/edit-docs/backup/restore", json=restore, headers=headers).json()["head"]["revision"] == 2
    restore["source"] = {"data": raw("two"), "copy_hash": "0" * 64}
    assert client.post("/api/edit-docs/backup/restore", json=restore, headers=headers).status_code == 400
    assert _proxy.is_local_path("/api/edit-docs/backup")


def test_auth_owner_stays_email_when_creator_identity_changes(database, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    request = SimpleNamespace(state=SimpleNamespace(account={"email": OWNER.upper(), "creator_uid": None}), headers={HEADER: f"acct:{OWNER}"})
    body = edit_docs.BackupIn(doc_key=KEY, data=raw("one"), base_revision=None)
    assert edit_docs.put_backup(body, request)["status"] == "saved"
    request.state.account["creator_uid"] = "linked-creator"
    body.data, body.base_revision = raw("two"), 1
    assert edit_docs.put_backup(body, request)["head"]["revision"] == 2
    assert repo.get_edit_backup(OWNER, KEY, include_data=True)["head"]["data"] == raw("two")


def test_account_switch_after_header_check_stays_in_pinned_database(tmp_path, monkeypatch):
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    token = active_account.set_override(None)
    try:
        for owner in (OWNER, "b@example.com"):
            active_account.set_active(owner, None)
            db.init_db()
        active_account.set_active(OWNER, None)
        original = repo.save_edit_backup

        def switch(*args):
            active_account.set_active("b@example.com", None)
            return original(*args)

        monkeypatch.setattr(repo, "save_edit_backup", switch)
        request = SimpleNamespace(state=SimpleNamespace(account=None), headers={HEADER: f"acct:{OWNER}"})
        assert edit_docs.put_backup(edit_docs.BackupIn(doc_key=KEY, data=raw("a"), base_revision=None), request)["status"] == "saved"
        assert active_account.account_key() == "b@example.com"
        assert repo.get_edit_backup(OWNER, KEY)["head"] is None
        with active_account.pinned_account_scope((OWNER, None)):
            assert repo.get_edit_backup(OWNER, KEY, include_data=True)["head"]["data"] == raw("a")
    finally:
        db.flush_pool()
        active_account.reset_override(token)
