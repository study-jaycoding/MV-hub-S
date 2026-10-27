"""원격 작업은 남기고 로컬 쓰기는 보호하는 업데이트 경계(유료/실제 설치 없음)."""
import asyncio
import json
import pytest

from app import db, repo
from app.routers import release_update as router
from app.services import operational_health, release_update, update_activity as activity


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    monkeypatch.setattr(activity, "current_scope", lambda: {"hub_id": "hub-a", "server_key": "server-a"})
    monkeypatch.setattr(release_update, "update_in_progress", lambda: False)
    yield
    db.flush_pool()


def request(*, email="a@example.test", phase="tracking", job="remote-a", workspace=None):
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    rid = repo.create_gen_request(email, None, gen_id, "create", {
        "model": "m", "workspace": workspace if workspace is not None else {"scope": "personal"},
    })
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status=?,lease_expires_at=datetime('now','+10 minutes') WHERE id=?", (phase, rid))
        conn.execute("UPDATE generation SET status='running',job_id=? WHERE id=?", (job, gen_id))
    return rid, gen_id


def test_accepted_remote_is_recoverable_but_submitting_still_blocks(isolated):
    request()
    request(phase="submitting", job=None)
    assert operational_health.generation_queue_snapshot()["update_blocking_total"] == 2
    value = operational_health.generation_queue_snapshot(allow_remote_recovery=True)
    assert value["update_blocking_total"] == 1
    assert value["remote_recoverable_total"] == 1


def test_unknown_legacy_workspace_preserved_not_replaced(isolated):
    rid, _ = request(workspace={"scope": "unknown"})
    request(job="bad-team", workspace={"scope": "team"})
    request(job="blank-team", workspace={"scope": "team", "id": "   "})
    assert activity.prepare_remote_checkpoint() == 1
    items = activity.list_checkpoint("a@example.test")
    assert [v["rid"] for v in items] == [rid]
    assert items[0]["workspace"] == {"scope": "unknown", "id": None, "name": None}


def test_checkpoint_merge_survives_restart_failure_and_account_switch(isolated, monkeypatch):
    rid, _ = request()
    assert activity.prepare_remote_checkpoint() == 1
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='blocked' WHERE id=?", (rid,))
    other, _ = request(email="b@example.test", job="remote-b")
    assert activity.prepare_remote_checkpoint() == 1
    assert [v["rid"] for v in activity.list_checkpoint("a@example.test")] == [rid]
    assert [v["rid"] for v in activity.list_checkpoint("b@example.test")] == [other]
    monkeypatch.setattr(activity, "current_scope", lambda: {"hub_id": "hub-b", "server_key": "server-a"})
    assert activity.list_checkpoint("a@example.test") == []
    monkeypatch.setattr(activity, "current_scope", lambda: {"hub_id": "hub-a", "server_key": "server-b"})
    assert activity.list_checkpoint("a@example.test") == []


def test_checkpoint_preserves_verified_expected_image_count(isolated):
    rid, _ = request()
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET submission_fingerprint=? WHERE id=?", (
            json.dumps({"submitted_refs": [{"type": "video"}, {"type": "image"}]}), rid,
        ))
    activity.prepare_remote_checkpoint()
    assert activity.list_checkpoint("a@example.test")[0]["expected_image_inputs"] == 1
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET submission_fingerprint='{}' WHERE id=?", (rid,))
    assert "expected_image_inputs" not in activity.list_checkpoint("a@example.test")[0]
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET payload=?,submission_fingerprint=? WHERE id=?", (
            json.dumps({"model": "draw_to_video", "workspace": {"scope": "personal"}}),
            json.dumps({"submitted_refs": [{"type": "image"}, {"type": "video"}]}), rid,
        ))
    assert activity.list_checkpoint("a@example.test")[0]["expected_image_inputs"] == 0


def test_recovery_endpoint_keeps_account_isolation(isolated, monkeypatch):
    from app.routers import gen_requests as routes
    first, _ = request()
    second, _ = request(email="b@example.test", job="remote-b")
    activity.prepare_remote_checkpoint()
    monkeypatch.setattr(routes, "_require_account", lambda _request: {"email": "b@example.test"})
    result = routes.update_recovery_candidates(None)
    assert [item["rid"] for item in result["candidates"]] == [second]
    assert first not in str(result)


def test_reconcile_write_cannot_enter_during_update(isolated, monkeypatch):
    from app.usecases import gen_requests as usecase
    entered = []
    async def write(*args):
        entered.append(True)
        return {}
    monkeypatch.setattr(usecase, "_reconcile_request", write)
    monkeypatch.setattr(release_update, "update_in_progress", lambda: True)
    with pytest.raises(activity.UpdateActivityBusy):
        asyncio.run(usecase.reconcile_request({"id": "r", "account_email": "a@example.test"}, {}, None, None))
    assert entered == []
    assert activity.active_write_count() == 0


def test_checkpoint_corruption_is_preserved_and_blocks_replacement(isolated):
    request()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO app_setting(key,value) VALUES('update_remote_checkpoint','broken')")
    with pytest.raises(ValueError):
        activity.prepare_remote_checkpoint()
    with db.get_connection() as conn:
        assert conn.execute("SELECT value FROM app_setting WHERE key='update_remote_checkpoint'").fetchone()[0] == "broken"


def test_ack_requires_same_job_terminal_and_saved_result(isolated):
    rid, gid = request()
    activity.prepare_remote_checkpoint()
    assert not activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='done' WHERE id=?", (rid,))
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gid,))
    assert not activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")
    with db.get_connection() as conn:
        conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('asset',?,'image','https://test.invalid/result.png')", (gid,))
    assert not activity.acknowledge_checkpoint(rid, "wrong-job", "a@example.test")
    assert not activity.acknowledge_checkpoint(rid, "remote-a", "b@example.test")
    assert activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")
    assert not activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")
    assert activity.list_checkpoint("a@example.test") == []


def test_transient_failure_cannot_clear_remote_checkpoint(isolated):
    rid, gid = request()
    activity.prepare_remote_checkpoint()
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET status='failed',provider_status='processing' WHERE id=?", (rid,))
        conn.execute("UPDATE generation SET status='failed' WHERE id=?", (gid,))
    assert not activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")
    with db.get_connection() as conn:
        conn.execute("UPDATE gen_request SET provider_status='rejected' WHERE id=?", (rid,))
    assert activity.acknowledge_checkpoint(rid, "remote-a", "a@example.test")


def test_local_write_gate_counts_work_and_denies_new_work_during_update(isolated, monkeypatch):
    assert activity.active_write_count() == 0
    with activity.local_write():
        assert activity.active_write_count() == 1
    monkeypatch.setattr(release_update, "update_in_progress", lambda: True)
    with pytest.raises(activity.UpdateActivityBusy):
        with activity.local_write():
            pytest.fail("updater and writer overlapped")
    assert activity.active_write_count() == 0


def test_cache_gate_precedes_download(isolated, monkeypatch):
    from app.usecases import generation_media_cache

    monkeypatch.setattr(release_update, "update_in_progress", lambda: True)
    called = []
    async def download(_generation):
        called.append(True)
    monkeypatch.setattr(generation_media_cache, "_cache_generation_media_outcome", download)
    with pytest.raises(activity.UpdateActivityBusy):
        asyncio.run(generation_media_cache.cache_generation_media({"id": "g"}))
    assert called == []
    assert activity.active_write_count() == 0


def test_start_persists_before_bootstrap_and_rejects_failed_persistence(isolated, tmp_path, monkeypatch):
    request()
    monkeypatch.setattr(release_update, "UPDATE_STATE_BASE", tmp_path / "state")
    monkeypatch.setattr(release_update, "install_mode", lambda _root: "release")
    monkeypatch.setattr(release_update, "_read_version", lambda _root: "1.0.0")
    monkeypatch.setattr(release_update, "fetch_latest", lambda _root: {
        "version": "1.1.0", "higgsfield_cli_version": "1.2.3", "file": "MVHub-1.1.0.zip", "sha256": "a" * 64,
    })
    monkeypatch.setattr(release_update, "_installed_candidate", lambda *_: None)
    monkeypatch.setattr(release_update, "_check_update_contract", lambda *_args, **_kwargs: None)
    launched = []
    def launch(*_args):
        assert activity.list_checkpoint("a@example.test")
        launched.append(True)
    monkeypatch.setattr(release_update, "_launch_bootstrap", launch)
    with activity.local_write(), pytest.raises(release_update.ReleaseUpdateBusyError, match="저장"):
        release_update.start_update(activity_check=lambda: 0, root=tmp_path,
                                    checkpoint_write=activity.prepare_remote_checkpoint)
    assert launched == []
    with pytest.raises(release_update.ReleaseUpdateError, match="복구 기록"):
        release_update.start_update(activity_check=lambda: 0, root=tmp_path)
    assert launched == []
    def failing():
        raise OSError("private path must not appear in user error")
    with pytest.raises(release_update.ReleaseUpdateError, match="복구 기록을 저장하지 못했습니다"):
        release_update.start_update(activity_check=lambda: 0, root=tmp_path, checkpoint_write=failing)
    assert launched == []
    status = release_update.start_update(activity_check=lambda: 0, root=tmp_path, checkpoint_write=activity.prepare_remote_checkpoint)
    assert status["accepted"] and launched == [True]


def test_update_activity_preserves_comfy_resolve_and_local_writers(isolated, monkeypatch):
    request()
    monkeypatch.setattr(router.comfy, "active_run_job_count", lambda: 2)
    monkeypatch.setattr(router, "active_transfer_count", lambda: 3)
    with activity.local_write():
        value = router._activity()
    assert value == {"generation_active": 0, "comfy_active": 2, "resolve_active": 3,
                     "result_write_active": 1, "active_total": 6}
    assert not router._with_activity({"can_update": True})["can_update"]
