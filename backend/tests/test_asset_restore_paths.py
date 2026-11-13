"""Restored names require a current-generation, explicit canonical-path check."""
from __future__ import annotations

import asyncio
import io
import json
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import active_account, config, db
from app.routers import assets
from app.services import asset_destination, asset_io, asset_mounts
from test_asset_sync import PNG, storage
from test_followup_asset_destination import register


@pytest.fixture
def restored(storage, monkeypatch):
    conn, base = storage
    monkeypatch.setattr(active_account, "account_key", lambda: "")
    monkeypatch.setattr(config, "DATA_DIR", base)
    monkeypatch.setattr(assets, "ASSETS_ROOT", base / "local-assets")
    monkeypatch.setattr(assets, "actor_id", lambda request: "user_a")
    monkeypatch.setattr(assets, "_auto_project_mounts", lambda *args, **kwargs: [])
    monkeypatch.setattr(assets, "_MOUNT_PATH_CACHE", {})
    for folder in ("imports", "captures", "Project"):
        (assets.ASSETS_ROOT / folder).mkdir(parents=True)
        (assets.ASSETS_ROOT / folder / "x.png").write_bytes(PNG)
    set_state(conn)
    return conn, base, asset_mounts.mounts_file()


def set_state(conn, restore_id="restore-one", confirmed=()):
    conn.execute("INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (asset_mounts.restore_key(), json.dumps({"id": restore_id, "confirmed": list(confirmed)})))


def request():
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("127.0.0.1", 5000)})


def confirm(name, path, restore_id="restore-one"):
    return assets.confirm_mount(assets.MountConfirmIn(name=name, path=str(path), restore_id=restore_id), request())


def test_missing_json_and_absent_same_name_pm_do_not_enable_fallback(restored, monkeypatch):
    conn, base, path = restored
    assert not path.exists()
    assert assets._safe_project_dir("Project", request()) is None
    monkeypatch.setattr(assets, "_auto_project_mounts", lambda *a, **k: [
        {"name": "Project", "path": str(base / "assets"), "project_id": "p", "owner": "project"}])
    (base / "assets").mkdir()
    assert assets._safe_project_dir("Project", request()) is None
    for internal in ("imports", "captures"):
        assert assets._safe_project_dir(internal, request()) == assets.ASSETS_ROOT / internal
    assert assets._safe_project_dir(assets._COMBINED_INTERNAL, request()) == assets.ASSETS_ROOT
    assert asset_destination._current_root(conn, {"destination_kind": "project", "project_name": "Project",
        "project_id": "p", "root_path": str(base / "assets"), "owner_uid": "user_a"}) is None


def test_original_owner_and_bytes_survive_listing_then_explicit_confirmation_takes_ownership(restored):
    conn, base, path = restored
    external = base / "external"
    external.mkdir()
    raw = ("{\r\n  \"mounts\": [" + json.dumps({"name": "Project", "path": str(external), "owner": "old-machine"}) + "]\r\n}\r\n").encode()
    path.write_bytes(raw)
    response = assets.list_mounts(request())
    assert response["restore_id"] == "restore-one"
    assert response["mounts"][0]["restore_state"] == "pending"
    assert path.read_bytes() == raw
    assert assets._safe_project_dir("Project", request()) is None
    assert confirm("Project", external)["mounts"][0]["restore_state"] == "confirmed"
    assert asset_mounts.load(path)[0]["owner"] == "user_a"
    assets._MOUNT_PATH_CACHE.clear()
    assert asset_mounts.normalized_path(assets._safe_project_dir("Project", request())) == asset_mounts.normalized_path(external)
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Project", "path": str(external)}]


def test_confirmed_name_never_authorizes_another_path_or_fallback(restored, monkeypatch):
    conn, base, path = restored
    original = base / "original"
    original.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(original), "owner": "old"}])
    confirm("Project", original)
    asset_mounts.save(path, [{"name": "Project", "path": str(base / "missing"), "owner": "user_a"}])
    monkeypatch.setattr(assets, "_auto_project_mounts", lambda *a, **k: [
        {"name": "Project", "path": str(assets.ASSETS_ROOT / "Project"), "project_id": "p"}])
    assert assets._safe_project_dir("Project", request()) is None
    assert asset_destination._current_root(conn, {"destination_kind": "internal", "project_name": "Project",
        "root_path": str(assets.ASSETS_ROOT / "Project"), "owner_uid": "user_a"}) is None


def test_pm_and_legacy_assets_root_can_be_explicitly_confirmed(restored, monkeypatch):
    conn, base, path = restored
    external = base / "assets"
    external.mkdir()
    monkeypatch.setattr(assets, "_auto_project_mounts", lambda *a, **k: [
        {"name": "PM", "path": str(external), "project_id": "p"}])
    assert confirm("PM", external)["mounts"][0]["restore_state"] == "confirmed"
    assert asset_mounts.normalized_path(assets._safe_project_dir("PM", request())) == asset_mounts.normalized_path(external)
    assert not path.exists()
    confirm("Project", assets.ASSETS_ROOT / "Project")
    assert assets._safe_project_dir("Project", request()) == assets.ASSETS_ROOT / "Project"


@pytest.mark.parametrize("restore_id", [None, "older-restore"])
def test_new_registration_and_confirmation_require_current_generation(restored, restore_id):
    conn, base, path = restored
    external = base / "external"
    external.mkdir()
    with pytest.raises(HTTPException) as error:
        assets.add_mount(assets.MountIn(name="Project", path=str(external), restore_id=restore_id), request())
    assert error.value.status_code == 409
    assert not path.exists()
    assert asset_mounts.restore_state(conn)["confirmed"] == []
    result = assets.add_mount(assets.MountIn(name="Project", path=str(external), restore_id="restore-one"), request())
    assert result["mounts"][0]["restore_state"] == "confirmed"
    set_state(conn, "restore-two")
    with pytest.raises(HTTPException) as error:
        confirm("Project", external)
    assert error.value.status_code == 409
    assert assets._safe_project_dir("Project", request()) is None


@pytest.mark.parametrize("raw", ["not json", "[]", '{"id":"x","confirmed":null}',
    '{"id":"","confirmed":[]}', '{"id":"x","confirmed":[{"name":"Project","path":"relative"}]}'])
def test_malformed_restore_setting_fails_closed(restored, raw):
    conn, base, path = restored
    conn.execute("UPDATE app_setting SET value=? WHERE key=?", (raw, asset_mounts.restore_key()))
    assert assets.list_mounts(request())["restore_invalid"] is True
    assert assets._safe_project_dir("Project", request()) is None
    with pytest.raises(HTTPException) as error:
        assets.add_mount(assets.MountIn(name="Project", path=str(assets.ASSETS_ROOT / "Project"), restore_id="x"), request())
    assert error.value.status_code == 400
    assert not path.exists()


def test_database_failure_restores_original_json_and_keeps_name_unconfirmed(restored):
    conn, base, path = restored
    external = base / "external"
    external.mkdir()
    raw = json.dumps({"mounts": [{"name": "Project", "path": str(external), "owner": "old"}]}, indent=3).encode()
    path.write_bytes(raw)
    conn.execute("CREATE TRIGGER reject_mount_confirmation BEFORE UPDATE ON app_setting BEGIN SELECT RAISE(ABORT,'test failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        confirm("Project", external)
    assert path.read_bytes() == raw
    assert asset_mounts.restore_state(conn)["confirmed"] == []
    assert assets._safe_project_dir("Project", request()) is None


def test_delete_revokes_confirmation_without_enabling_fallback(restored):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    assets.add_mount(assets.MountIn(name="Project", path=str(local), restore_id="restore-one"), request())
    assets.del_mount("Project", request(), path=str(local), restore_id="restore-one")
    assert asset_mounts.restore_state(conn)["id"] == "restore-one"
    assert asset_mounts.restore_state(conn)["confirmed"] == []
    assert assets._safe_project_dir("Project", request()) is None


def test_normal_mode_registration_stays_compatible_and_cannot_adopt_other_owner(restored):
    conn, base, path = restored
    conn.execute("DELETE FROM app_setting WHERE key=?", (asset_mounts.restore_key(),))
    external = base / "external"
    external.mkdir()
    asset_mounts.save(path, [{"name": "Other", "path": str(external), "owner": "someone-else"}])
    with pytest.raises(HTTPException) as error:
        confirm("Other", external, "")
    assert error.value.status_code == 409
    assets.add_mount(assets.MountIn(name="Project", path=str(external)), request())
    assert asset_mounts.restore_state(conn) is None
    assert asset_mounts.normalized_path(assets._safe_project_dir("Project", request())) == asset_mounts.normalized_path(external)
    assert any(m["owner"] == "someone-else" for m in asset_mounts.load(path))


def test_unconfirmed_locate_and_upload_cannot_use_same_name_pm_or_disk(restored, monkeypatch):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    asset_mounts.save(path, [{"name": "Project", "path": str(local), "owner": "old"}])
    monkeypatch.setattr(assets, "lookup_registry", lambda *a: (_ for _ in ()).throw(AssertionError("blocked token reached registry")))
    result = assets.locate_legacy_assets(assets.LocateIn(tokens=["asset:Project|x.png"]), request())
    assert result["fixed"] == [] and result["open"] == []
    assert result["incomplete"] == ["asset:Project|x.png"]
    with pytest.raises(HTTPException) as error:
        asyncio.run(assets.upload_assets(request(), project="Project", dir="", files=[UploadFile(io.BytesIO(PNG), filename="new.png")]))
    assert error.value.status_code == 404
    assert not (local / "new.png").exists()


def test_http_confirmation_exposes_current_state_and_rejects_stale_id(restored):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    asset_mounts.save(path, [{"name": "Project", "path": str(local), "owner": "old"}])
    app = FastAPI()
    app.include_router(assets.router)
    app.dependency_overrides[assets._require_mount_manager] = lambda: None
    app.dependency_overrides[assets._require_local_assets] = lambda: None
    with TestClient(app) as client:
        assert client.get("/api/assets/mounts").json()["mounts"][0]["restore_state"] == "pending"
        body = {"name": "Project", "path": str(local), "restore_id": "old"}
        assert client.post("/api/assets/mounts/confirm", json=body).status_code == 409
        body["restore_id"] = "restore-one"
        response = client.post("/api/assets/mounts/confirm", json=body)
        assert response.status_code == 200, response.text
        assert response.json()["mounts"][0]["restore_state"] == "confirmed"
        assert client.delete("/api/assets/mounts/Project").status_code == 409
        removed = client.delete("/api/assets/mounts/Project", params={"path": str(local), "restore_id": "restore-one"})
        assert removed.status_code == 200, removed.text
        assert removed.json()["mounts"] == []


def test_concurrent_owner_adoption_does_not_lose_other_registrations(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "First", "path": str(first), "owner": "old"}])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(confirm, "First", first),
                   pool.submit(assets.add_mount, assets.MountIn(name="Second", path=str(second), restore_id="restore-one"), request())]
        for result in results:
            result.result(timeout=5)
    assert {m["name"] for m in asset_mounts.load(path)} == {"First", "Second"}
    assert {m["name"] for m in asset_mounts.restore_state(conn)["confirmed"]} == {"First", "Second"}


def test_restore_before_final_file_commit_rejects_without_creating_final_file(restored):
    conn, base, path = restored
    part = base / ".incoming.part"
    part.write_bytes(PNG)
    operation = db.capture_share_operation()
    with pytest.raises(db.DatabaseEpochChanged), db.pinned_share_operation(operation):
        with db.maintenance_gate():
            db.flush_pool()
        assets._commit_unique_tmp(part, base, "new.png")
    assert not (base / "new.png").exists()
    assert not part.exists()


def test_final_file_commit_first_makes_restore_wait_and_does_not_open_db(restored, monkeypatch):
    conn, base, path = restored
    part = base / ".incoming.part"
    part.write_bytes(PNG)
    linked, release, maintained = threading.Event(), threading.Event(), threading.Event()
    original = asset_io.os.link
    def link(source, target):
        linked.set()
        assert release.wait(3)
        return original(source, target)
    monkeypatch.setattr(asset_io.os, "link", link)
    def commit():
        with db.pinned_share_operation():
            return assets._commit_unique_tmp(part, base, "new.png")
    def maintain():
        with db.maintenance_gate(timeout=3):
            maintained.set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        writing = pool.submit(commit)
        assert linked.wait(3)
        maintenance = pool.submit(maintain)
        assert not maintained.wait(0.1)
        release.set()
        assert writing.result(timeout=3).read_bytes() == PNG
        maintenance.result(timeout=3)
    assert maintained.is_set()


def test_owner_migration_obtains_connection_before_waiting_for_file_lock(restored):
    conn, base, path = restored
    conn.execute("DELETE FROM app_setting WHERE key=?", (asset_mounts.restore_key(),))
    asset_mounts.save(path, [{"name": "Project", "path": str(base), "owner": ""}])
    with ThreadPoolExecutor(max_workers=2) as pool:
        with asset_mounts._file_lock(path):
            future = pool.submit(assets._owner_mounts, "user_a")
            with db._pool_condition:
                assert db._pool_condition.wait_for(lambda: db._active_connection_contexts > 0, timeout=2)
            with pytest.raises(db.DatabaseMaintenanceTimeout):
                with db.maintenance_gate(timeout=0.1):
                    pass
        assert future.result(timeout=3)[0]["owner"] == "user_a"


def test_destination_restore_during_part_copy_rejects_late_link_and_cleans_part(restored, monkeypatch):
    conn, base, path = restored
    register(conn, base, monkeypatch)
    set_state(conn, confirmed=[{"name": "Project", "path": str(base / "assets")}])
    original = asset_destination.os.fsync
    def restore_after_copy(fd):
        original(fd)
        with db.maintenance_gate():
            db.flush_pool()
    monkeypatch.setattr(asset_destination.os, "fsync", restore_after_copy)
    with pytest.raises(db.DatabaseEpochChanged):
        asset_destination.process_one()
    assert not (base / "assets/selected/original.png").exists()
    assert list((base / "assets/selected").glob("*.part")) == []
    assert (base / "local.png").read_bytes() == PNG


def test_explicit_empty_account_arguments_never_use_active_account(restored, monkeypatch):
    conn, base, path = restored
    monkeypatch.setattr(active_account, "account_key", lambda: "person@example.invalid")
    assert asset_mounts.mounts_file("") == base / "asset_mounts.json"
    assert asset_mounts.restore_key("") != asset_mounts.restore_key()
    assert asset_mounts.mounts_file("person@example.invalid") == active_account.account_dir("person@example.invalid") / "asset_mounts.json"


def test_failed_commit_after_json_write_restores_bytes_and_leaves_confirmation_empty(restored):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    asset_mounts.save(path, [{"name": "Project", "path": str(local), "owner": "old"}])
    original = path.read_bytes()
    class FailedCommit:
        execute = conn.execute
        rollback = conn.rollback
        def commit(self):
            assert asset_mounts.load(path)[0]["owner"] == "user_a"
            raise sqlite3.OperationalError("synthetic commit failure")
    conn.execute("BEGIN IMMEDIATE")
    with pytest.raises(sqlite3.OperationalError):
        asset_mounts.confirm(FailedCommit(), path, name="Project", location=str(local), owner="user_a", restore_id="restore-one")
    assert path.read_bytes() == original
    assert asset_mounts.restore_state(conn)["confirmed"] == []


def test_restore_during_slow_path_check_rejects_late_registration(restored, monkeypatch):
    conn, base, path = restored
    original = assets._checked_mount_path
    def checked(body):
        result = original(body)
        with db.maintenance_gate():
            db.flush_pool()
        return result
    monkeypatch.setattr(assets, "_checked_mount_path", checked)
    with pytest.raises(db.DatabaseEpochChanged):
        assets.add_mount(assets.MountIn(name="Project", path=str(assets.ASSETS_ROOT / "Project"), restore_id="restore-one"), request())
    assert not path.exists()
    assert asset_mounts.restore_state(conn)["confirmed"] == []


def test_restore_after_discard_hash_prevents_late_unlink(restored, monkeypatch):
    conn, base, path = restored
    target = assets.ASSETS_ROOT / "captures/x.png"
    digest = assets._sha256_file(target)
    token = assets._issue_capture_discard_token("captures", "x.png", target, digest)
    original = assets._sha256_file
    def hash_then_restore(value):
        result = original(value)
        with db.maintenance_gate():
            db.flush_pool()
        return result
    monkeypatch.setattr(assets, "_sha256_file", hash_then_restore)
    with pytest.raises(db.DatabaseEpochChanged):
        assets.discard_capture(assets.CaptureDiscardIn(token=token), request())
    assert target.read_bytes() == PNG


def test_capture_hash_is_outside_gate_and_late_finalize_is_blocked(restored, monkeypatch):
    conn, base, path = restored
    part = base / ".capture.part"
    part.write_bytes(PNG)
    def hash_then_restore(*args):
        with db.maintenance_gate():
            db.flush_pool()
        return None
    monkeypatch.setattr(asset_io, "find_same_media", hash_then_restore)
    with pytest.raises(db.DatabaseEpochChanged), db.pinned_share_operation():
        assets._commit_capture_with_discard_token(part, base, "capture.png", "test-digest", len(PNG), "captures", base)
    assert not (base / "capture.png").exists()
    assert not part.exists()


def test_destination_restore_after_final_root_check_still_blocks_link(restored, monkeypatch):
    from contextlib import contextmanager
    conn, base, path = restored
    register(conn, base, monkeypatch)
    set_state(conn, confirmed=[{"name": "Project", "path": str(base / "assets")}])
    original = db.share_operation_write
    @contextmanager
    def changed_before_admission():
        with db.maintenance_gate():
            db.flush_pool()
        with original():
            yield
    monkeypatch.setattr(db, "share_operation_write", changed_before_admission)
    with pytest.raises(db.DatabaseEpochChanged):
        asset_destination.process_one()
    assert not (base / "assets/selected/original.png").exists()
    assert list((base / "assets/selected").glob("*.part")) == []


@pytest.mark.parametrize("prune", [True, False])
def test_unconfirmed_sources_are_held_without_pruning_or_relinking(restored, monkeypatch, prune):
    conn, base, path = restored
    monkeypatch.setattr(assets.repo, "list_source_metas", lambda owner: [("Project", "gone.png", "digest")])
    def unexpected(*args):
        raise AssertionError("an unconfirmed mount reached destructive source maintenance")
    monkeypatch.setattr(assets.repo, "set_asset_source", unexpected)
    monkeypatch.setattr(assets.repo, "relink_asset_path", unexpected)
    monkeypatch.setattr(assets, "_index_by_sha", unexpected)
    assert assets._resolve_broken_sources(request(), prune=prune) == (0, [])


def test_confirming_one_same_owner_same_name_candidate_preserves_other_paths(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "user_a"},
                             {"name": "Project", "path": str(second), "owner": "user_a"}])
    reply = confirm("Project", first)
    assert {(m["path"], m["restore_state"]) for m in reply["mounts"]} == {(str(first), "confirmed"), (str(second), "pending")}
    assert {m["path"] for m in asset_mounts.load(path)} == {str(first), str(second)}
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Project", "path": str(first)}]


def test_confirmed_mount_checks_reuse_existing_path_resolution_cache(restored, monkeypatch):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    assets.add_mount(assets.MountIn(name="Project", path=str(local), restore_id="restore-one"), request())
    # Payload resolution has filled the existing TTL cache; no canonical resolver should run per read.
    monkeypatch.setattr(asset_mounts, "canonical_path", lambda *a: (_ for _ in ()).throw(AssertionError("uncached path IO")))
    for _ in range(3):
        resolved = assets._safe_project_dir("Project", request())
        assert asset_mounts.normalized_path(resolved) == asset_mounts.normalized_path(local)


def test_mount_database_read_errors_are_not_treated_as_normal_mode(restored, monkeypatch):
    from contextlib import contextmanager
    @contextmanager
    def broken_connection():
        raise sqlite3.OperationalError("synthetic database read failure")
        yield
    monkeypatch.setattr(assets, "get_connection", broken_connection)
    with pytest.raises(sqlite3.OperationalError):
        assets._safe_project_dir("Project", request())


def test_restore_delete_requires_current_generation_and_exact_confirmed_pair(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "user_a"},
                             {"name": "Project", "path": str(second), "owner": "user_a"},
                             {"name": "Other", "path": str(second), "owner": "user_a"}])
    confirm("Project", first)
    confirm("Other", second)
    original = path.read_bytes()
    for query in ({}, {"path": str(first)}, {"restore_id": "restore-one"},
                  {"path": str(second), "restore_id": "restore-one"}, {"path": str(first), "restore_id": "old"}):
        with pytest.raises(HTTPException) as error:
            assets.del_mount("Project", request(), **query)
        assert error.value.status_code == 409
        assert path.read_bytes() == original
    assets.del_mount("Project", request(), path=(str(first).upper() if os.name == "nt" else str(first)) + "/", restore_id="restore-one")
    assert {(m["name"], m["path"]) for m in asset_mounts.load(path)} == {("Project", str(second)), ("Other", str(second))}
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Other", "path": str(second)}]


def test_delete_failure_rolls_back_json_and_confirmations_and_old_restore_query_is_rejected(restored):
    conn, base, path = restored
    local = assets.ASSETS_ROOT / "Project"
    assets.add_mount(assets.MountIn(name="Project", path=str(local), restore_id="restore-one"), request())
    original = path.read_bytes()
    conn.execute("CREATE TRIGGER reject_mount_delete BEFORE UPDATE ON app_setting BEGIN SELECT RAISE(ABORT,'test failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        assets.del_mount("Project", request(), path=str(local), restore_id="restore-one")
    assert path.read_bytes() == original
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Project", "path": str(local)}]
    conn.execute("DROP TRIGGER reject_mount_delete")
    conn.execute("DELETE FROM app_setting WHERE key=?", (asset_mounts.restore_key(),))
    with pytest.raises(HTTPException) as error:
        assets.del_mount("Project", request(), path=str(local), restore_id="restore-one")
    assert error.value.status_code == 409
    assert path.read_bytes() == original
    assets.del_mount("Project", request())
    assert asset_mounts.load(path) == []


@pytest.mark.skipif(os.name != "nt", reason="Windows path aliases")
def test_delete_path_normalization_covers_unc_and_extended_paths():
    assert asset_mounts.normalized_path(r"\\?\UNC\server\Share\folder" + "\\") == asset_mounts.normalized_path(r"\\SERVER\share\folder")
    assert asset_mounts.normalized_path(r"\\?\C:\Long\Folder") == asset_mounts.normalized_path("c:/long/folder/")


def test_same_name_concurrent_confirmations_leave_exactly_one_pair_and_preserve_candidates(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "old"},
                             {"name": "Project", "path": str(second), "owner": "old"}])
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(confirm, "Project", chosen) for chosen in (first, second)]
        for future in futures:
            future.result(timeout=5)
    confirmed = asset_mounts.restore_state(conn)["confirmed"]
    assert len(confirmed) == 1 and confirmed[0]["name"] == "Project"
    assert confirmed[0]["path"] in (str(first), str(second))
    assert {m["path"] for m in asset_mounts.load(path)} == {str(first), str(second)}


def test_reconfirmation_rejects_late_delete_of_old_pair_without_changing_candidates(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "old"},
                             {"name": "Project", "path": str(second), "owner": "old"}])
    confirm("Project", first)
    confirm("Project", second)
    original = path.read_bytes()
    with pytest.raises(HTTPException) as error:
        assets.del_mount("Project", request(), path=str(first), restore_id="restore-one")
    assert error.value.status_code == 409
    assert path.read_bytes() == original
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Project", "path": str(second)}]


def test_failed_second_confirmation_preserves_previous_pair_and_original_candidates(restored):
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "old"},
                             {"name": "Project", "path": str(second), "owner": "old"}])
    confirm("Project", first)
    original = path.read_bytes()
    conn.execute("CREATE TRIGGER reject_second_confirmation BEFORE UPDATE ON app_setting BEGIN SELECT RAISE(ABORT,'test failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        confirm("Project", second)
    assert path.read_bytes() == original
    assert asset_mounts.restore_state(conn)["confirmed"] == [{"name": "Project", "path": str(first)}]


def test_normal_mount_payload_omits_restore_row_status_for_existing_and_missing_paths(restored):
    conn, base, path = restored
    conn.execute("DELETE FROM app_setting WHERE key=?", (asset_mounts.restore_key(),))
    asset_mounts.save(path, [{"name": "Here", "path": str(base), "owner": "user_a"},
                             {"name": "Gone", "path": str(base / "gone"), "owner": "user_a"}])
    payload = assets.list_mounts(request())
    assert payload["restore_id"] is None
    assert [m["exists"] for m in payload["mounts"]] == [True, False]
    assert all("restore_state" not in m for m in payload["mounts"])


def test_confirmed_mount_missing_on_disk_remains_failed_and_can_be_removed(restored):
    conn, base, path = restored
    local = base / "confirmed"
    local.mkdir()
    assets.add_mount(assets.MountIn(name="Gone", path=str(local), restore_id="restore-one"), request())
    local.rmdir()
    assets._MOUNT_PATH_CACHE.clear()
    payload = assets.list_mounts(request())
    assert payload["mounts"][0]["exists"] is False
    assert payload["mounts"][0]["restore_state"] == "failed"
    removed = assets.del_mount("Gone", request(), path=str(local), restore_id=payload["restore_id"])
    assert removed["mounts"] == []
    assert asset_mounts.restore_state(conn)["confirmed"] == []


@pytest.fixture
def registered_capture(restored):
    import hashlib
    from app.services import asset_sync
    conn, base, path = restored
    target = assets.ASSETS_ROOT / "captures/x.png"
    digest = hashlib.sha256(PNG).hexdigest()
    asset_sync.register_local(target, "asset:captures|x.png", digest, len(PNG), "image", "user_a")
    token = assets._issue_capture_discard_token("captures", "x.png", target, digest)
    return conn, base, target, digest, token


def test_discard_losing_to_capture_reuse_preserves_ready_location(registered_capture, monkeypatch):
    from contextlib import contextmanager
    conn, base, target, digest, token = registered_capture
    checked, proceed = threading.Event(), threading.Event()
    original_gate = db.share_operation_write
    @contextmanager
    def paused_discard():
        if threading.current_thread().name.startswith("discard-race"):
            checked.set()
            assert proceed.wait(3)
        with original_gate():
            yield
    monkeypatch.setattr(db, "share_operation_write", paused_discard)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="discard-race") as pool:
        pending = pool.submit(assets.discard_capture, assets.CaptureDiscardIn(token=token), request())
        assert checked.wait(3)
        try:
            part = base / ".reuse.part"
            part.write_bytes(PNG)
            with db.pinned_share_operation():
                _, reused, new_token = assets._commit_capture_with_discard_token(
                    part, target.parent, "x.png", digest, len(PNG), "captures", target.parent)
            assert reused and new_token is None
        finally:
            proceed.set()
        with pytest.raises(HTTPException) as error:
            pending.result(timeout=3)
    assert error.value.status_code == 404
    assert target.read_bytes() == PNG
    assert conn.execute("SELECT state FROM asset_location WHERE original_file_path='asset:captures|x.png'").fetchone()[0] == "ready"


def test_failed_capture_unlink_preserves_ready_location(registered_capture, monkeypatch):
    from pathlib import Path
    conn, base, target, digest, token = registered_capture
    original = Path.unlink
    def denied(path, *args, **kwargs):
        if asset_mounts.normalized_path(path) == asset_mounts.normalized_path(target):
            raise PermissionError("synthetic locked capture")
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", denied)
    with pytest.raises(HTTPException) as error:
        assets.discard_capture(assets.CaptureDiscardIn(token=token), request())
    assert error.value.status_code == 409
    assert target.read_bytes() == PNG
    assert conn.execute("SELECT state FROM asset_location WHERE original_file_path='asset:captures|x.png'").fetchone()[0] == "ready"


def test_new_capture_between_unlink_and_database_marking_is_kept_ready(registered_capture, monkeypatch):
    from contextlib import contextmanager
    conn, base, target, digest, token = registered_capture
    original = assets.get_connection
    calls = 0
    @contextmanager
    def recreate_before_marking():
        nonlocal calls
        calls += 1
        if calls == 2:
            part = base / ".new-capture.part"
            part.write_bytes(PNG)
            _, reused, new_token = assets._commit_capture_with_discard_token(
                part, target.parent, target.name, digest, len(PNG), "captures", target.parent)
            assert not reused and new_token
        with original() as current:
            yield current
    monkeypatch.setattr(assets, "get_connection", recreate_before_marking)
    assert assets.discard_capture(assets.CaptureDiscardIn(token=token), request()) == {"ok": True}
    assert calls == 2
    assert target.read_bytes() == PNG
    assert conn.execute("SELECT state FROM asset_location WHERE original_file_path='asset:captures|x.png'").fetchone()[0] == "ready"


def test_restore_after_successful_unlink_blocks_database_marking_in_new_epoch(registered_capture, monkeypatch):
    from contextlib import contextmanager
    conn, base, target, digest, token = registered_capture
    original = db.share_operation_write
    @contextmanager
    def restore_after_unlink():
        with original():
            yield
        with db.maintenance_gate():
            db.flush_pool()
        # The restored file's rows must not receive the old operation's final marking.
        conn.execute("UPDATE asset_location SET state='ready'")
    monkeypatch.setattr(db, "share_operation_write", restore_after_unlink)
    with pytest.raises(db.DatabaseEpochChanged):
        assets.discard_capture(assets.CaptureDiscardIn(token=token), request())
    assert not target.exists()
    assert conn.execute("SELECT state FROM asset_location WHERE original_file_path='asset:captures|x.png'").fetchone()[0] == "ready"


def test_confirming_a_new_path_releases_old_manual_watch_before_any_tree_request(restored, monkeypatch):
    from app.services import asset_watcher
    from test_asset_watcher import _FakeObserver
    conn, base, path = restored
    first, second = base / "first", base / "second"
    first.mkdir()
    second.mkdir()
    asset_mounts.save(path, [{"name": "Project", "path": str(first), "owner": "user_a"},
                             {"name": "Project", "path": str(second), "owner": "user_a"}])
    confirm("Project", first)
    watcher = asset_watcher._Watcher()
    observer = _FakeObserver()
    watcher._observer = observer
    registration = asset_watcher.manual_registration_id("user_a", "Project")
    monkeypatch.setattr(asset_watcher, "unwatch", watcher.unwatch)
    try:
        watcher.watch(first, "Project", registration_id=registration)
        assert watcher._registration_dirs[registration] == str(first)
        confirm("Project", second)
        assert registration not in watcher._registration_dirs
        assert len(observer.unscheduled) == 1
    finally:
        watcher.stop()
