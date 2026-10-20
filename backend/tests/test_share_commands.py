import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import db, repo, schema_compat
from app.repo import share_commands as receipts
from app.routers.share import ShareCommandIn
from app.usecases import share
from app.routers._share_authority import authority, http_call


@pytest.fixture
def generation(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.init_db()
    repo.ensure_default_worker()
    gid = repo.create_local_generation({"model": "test", "prompt": "receipt fixture"}, "me")
    repo.set_status(gid, "done")
    return gid


def request():
    return SimpleNamespace(state=SimpleNamespace(account=None))


def command(gid, kind="publish", op="operation-1", **parameters):
    state = http_call(share.inspect_state, authority(request()), gid)
    return ShareCommandIn(operation_id=op, target_id=gid, command_kind=kind,
                          workspace_scope=state["workspace_scope"] or "unknown", workspace_id=state["workspace_id"],
                          expected_revision=state["share_revision"], parameters=parameters).as_command()


def test_database_generation_survives_init_and_initializes_existing_v2(generation):
    before = http_call(share.inspect_state, authority(request()), generation)["db_generation"]
    assert len(before) == 32
    db.init_db()
    assert http_call(share.inspect_state, authority(request()), generation)["db_generation"] == before
    with db.get_connection() as conn:
        identity = conn.execute("SELECT database_id FROM schema_meta").fetchone()[0]
        conn.execute("DELETE FROM app_setting WHERE key='share_db_generation'")
    db.init_db()
    after = http_call(share.inspect_state, authority(request()), generation)["db_generation"]
    assert len(after) == 32 and after != before
    with db.get_connection() as conn:
        assert conn.execute("SELECT database_id FROM schema_meta").fetchone()[0] == identity
        assert schema_compat.inspect_schema(conn, "content").schema_version == 2


def test_frozen_command_cannot_cross_restore_with_same_uuid_and_revision(generation, tmp_path):
    from app.routers import db_transfer
    state = http_call(share.inspect_state, authority(request()), generation)
    cmd = {**command(generation), "db_generation": state["db_generation"]}
    snapshot = tmp_path / "before-command.db"
    db._copy_sqlite(db.get_db_path(), snapshot)
    with db.get_connection() as conn:
        identity = conn.execute("SELECT database_id FROM schema_meta").fetchone()[0]
    http_call(share.execute, authority(request()), cmd)
    assert db_transfer._install_db(snapshot, expected=db_transfer._capture_restore_target())["ok"]
    restored = http_call(share.inspect_state, authority(request()), generation)
    assert restored["share_revision"] == cmd["expected_revision"]
    assert restored["db_generation"] != cmd["db_generation"]
    with pytest.raises(HTTPException, match="share_database_generation_changed") as error:
        http_call(share.execute, authority(request()), cmd)
    assert error.value.status_code == 409
    assert http_call(share.inspect_state, authority(request()), generation) == restored
    with db.get_connection() as conn:
        assert conn.execute("SELECT database_id FROM schema_meta").fetchone()[0] == identity
        assert conn.execute("SELECT COUNT(*) FROM share_command_receipt").fetchone()[0] == 0


def test_matching_generation_applies_and_existing_receipt_survives_rotation(generation):
    from app.routers import db_transfer
    state = http_call(share.inspect_state, authority(request()), generation)
    cmd = {**command(generation), "db_generation": state["db_generation"]}
    first = http_call(share.execute, authority(request()), cmd)
    assert first["current"]["shared"] and not first["replayed"]
    db_transfer._post_install_security_init(db.get_db_path())
    replay = http_call(share.execute, authority(request()), cmd)
    assert replay["replayed"] and replay["receipt"] == first["receipt"]
    assert replay["current"]["share_revision"] == first["current"]["share_revision"]


def test_legacy_serialization_keeps_none_workspace_and_original_receipt_hash(generation):
    legacy = command(generation)
    assert "db_generation" not in legacy and legacy["workspace_id"] is None
    parsed = ShareCommandIn.model_validate({**legacy, "db_generation": None}).as_command()
    assert parsed == legacy and receipts.request_hash(parsed) == receipts.request_hash(legacy)
    applied = http_call(share.execute, authority(request()), parsed)
    assert applied["receipt"]["request_hash"] == receipts.request_hash(legacy)


@pytest.mark.parametrize("invalid", ["", "a" * 31, "A" * 32, "a" * 33])
def test_database_generation_rejects_noncanonical_values(generation, invalid):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ShareCommandIn.model_validate({**command(generation), "db_generation": invalid})


def test_capability_and_state_read_the_same_database_generation(generation, monkeypatch):
    from app.routers import share as routes
    monkeypatch.setattr(routes._proxy, "proxying", lambda: False)
    state = http_call(share.inspect_state, authority(request()), generation)
    capability = routes.share_capabilities()
    assert capability["db_generation"] == state["db_generation"]


@pytest.mark.parametrize("existing,modern", [(False, True), (True, True), (False, False), (True, False)])
def test_bundle_freezes_capability_for_new_target_or_current_state_for_existing(monkeypatch, existing, modern):
    from app.services import share_commands as service
    capability = {"share_command": 1, "receipt_replay": True}
    state = {"share_revision": 4}
    if modern:
        capability["db_generation"], state["db_generation"] = "b" * 32, "c" * 32
    frozen = []
    monkeypatch.setattr(service, "store_share_command", lambda ref, cmd: frozen.append(cmd) or True)
    def respond(method, url, **kwargs):
        return (200, capability) if url.endswith("capabilities") else ((200, state) if existing else (404, {}))
    commands = service.prepare_bundle(respond, "http://synthetic.test", None,
        {"provider": {}, "generations": [{"generation": {"id": "new-job"}}]},
        {"new-job": {"intent_id": "synthetic", "intent_seq": 1}})
    assert frozen == commands
    if modern:
        assert commands[0]["db_generation"] == ("c" * 32 if existing else "b" * 32)
    else:
        assert "db_generation" not in commands[0]


def test_lost_response_returns_saved_receipt_after_later_legacy_change(generation):
    cmd = command(generation)
    first = http_call(share.execute, authority(request()), cmd)
    repo.unpublish(generation)
    retry = http_call(share.execute, authority(request()), cmd)
    assert retry["replayed"]
    assert retry["receipt"] == first["receipt"]
    assert retry["receipt"]["shared"] is True
    assert retry["current"]["shared"] is False
    assert retry["current"]["share_revision"] > first["receipt"]["share_revision"]


def test_same_operation_different_hash_and_new_stale_command_rejected(generation):
    cmd = command(generation)
    http_call(share.execute, authority(request()), cmd)
    with pytest.raises(HTTPException, match="operation_id_request_mismatch"):
        http_call(share.execute, authority(request()), {**cmd, "command_kind": "unpublish"})
    with pytest.raises(HTTPException, match="share_revision_conflict"):
        http_call(share.execute, authority(request()), {**cmd, "operation_id": "new-operation"})


def test_receipt_failure_rolls_back_mutation(generation, monkeypatch):
    cmd = command(generation)
    monkeypatch.setattr(receipts, "complete", lambda *a: (_ for _ in ()).throw(RuntimeError("receipt failure")))
    with pytest.raises(RuntimeError, match="receipt failure"):
        http_call(share.execute, authority(request()), cmd)
    assert not repo.get_generation(generation)["shared"]
    assert http_call(share.inspect_state, authority(request()), generation)["share_revision"] == cmd["expected_revision"]


@pytest.mark.parametrize("kind,parameters", [("finalize", {}), ("unfinalize", {"restore_held": True}),
                                              ("hold", {}), ("unhold", {}), ("final_review", {"state": "held"})])
def test_existing_atomic_cores_used_by_receipt(generation, kind, parameters):
    repo.publish(generation, "me")
    if kind in {"unfinalize", "final_review"}:
        repo.finalize_generation_with_share(generation, "me")
    result = http_call(share.execute, authority(request()), command(generation, kind, **parameters))
    assert result["receipt"]["state"] == "completed"
    assert result["receipt"]["share_revision"] == result["current"]["share_revision"]


def test_content_v2_keeps_other_versions_and_existing_checksums(generation, tmp_path):
    with db.get_connection() as conn:
        baseline = conn.execute("SELECT checksum FROM schema_migrations WHERE migration_id='content_core.baseline.v1'").fetchone()[0]
        assert baseline == schema_compat.BASELINES["content_core"].checksum
        assert schema_compat.inspect_schema(conn, "content").schema_version == 2
    db.init_db()
    with db.get_connection() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='content_share_commands.v2'").fetchone()[0] == 1
    from app.repo import trash
    with db.get_connection() as conn:
        conn.execute("ATTACH DATABASE ? AS trash", (str(tmp_path / "trash.db"),))
        trash._ensure_trash_schema(conn)
        assert schema_compat.inspect_schema(conn, "trash", schema="trash").schema_version == 1


def test_raw_legacy_writer_changes_same_revision(generation):
    before = http_call(share.inspect_state, authority(request()), generation)["share_revision"]
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET is_held=1 WHERE id=?", (generation,))
    assert http_call(share.inspect_state, authority(request()), generation)["share_revision"] > before


def test_unsupported_capability_falls_back_without_writing(generation):
    from app.services.share_commands import send
    proxy = SimpleNamespace(proxy_json=lambda *a, **kw: {})
    assert send(proxy, {}, generation, "finalize") is None


def test_proxy_persists_exact_command_before_send(generation):
    from app.services.share_commands import send
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    state_reads, sent = [], []
    def fake(method, path, **kwargs):
        if path.endswith("capabilities"):
            return {"share_command": 1, "receipt_replay": True}
        if "command-state" in path:
            state_reads.append(path)
            return http_call(share.inspect_state, authority(request()), generation)
        if path.endswith("commands"):
            sent.append(dict(kwargs["body"]))
            saved = repo.get_share_state_intent(ref["intent_id"])
            assert json.loads(saved["remote_command_json"]) == kwargs["body"]
            return http_call(share.execute, authority(request()), kwargs["body"])
        return repo.get_generation(generation)
    out = send(SimpleNamespace(proxy_json=fake), ref, generation, "publish")
    assert out["shared"]
    assert json.loads(repo.get_share_state_intent(ref["intent_id"])["remote_result_json"])["state"] == "completed"
    frozen = json.loads(ref["remote_command_json"])
    assert frozen["db_generation"] == http_call(share.inspect_state, authority(request()), generation)["db_generation"]
    from app.routers import db_transfer
    db_transfer._post_install_security_init(db.get_db_path())
    assert send(SimpleNamespace(proxy_json=fake), ref, generation, "publish")["shared"]
    assert len(state_reads) == 1 and sent == [frozen, frozen]


def test_bundle_receipt_replays_item_without_reimport(generation):
    from app.routers.publish import receive_published_bundle, PublishBundleIn
    item = {"generation": {"id": "new-job", "creator_uid": "user_owner", "prompt": "fixture", "status": "done", "workspace_scope": "unknown"}}
    bundle = {"provider": {"uid": "user_owner", "name": "Fixture"}, "generations": [item]}
    cmd = ShareCommandIn(operation_id="bundle-1", target_id="new-job", command_kind="publish_bundle",
                         workspace_scope="unknown", expected_revision=0, parameters={"item": item, "provider": bundle["provider"]}).as_command()
    first = receive_published_bundle(PublishBundleIn(bundle=bundle, commands=[cmd]), request())
    gid = first["command_results"]["new-job"]["current"]["id"]
    repo.unpublish(gid)
    second = receive_published_bundle(PublishBundleIn(bundle=bundle, commands=[cmd]), request())
    assert first["command_results"]["new-job"]["receipt"] == second["command_results"]["new-job"]["receipt"]
    assert second["command_results"]["new-job"]["current"]["shared"] is False


def test_receipt_rechecks_read_authority_but_not_revoked_write_role(generation, monkeypatch):
    from app import deps
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    with db.get_connection() as conn:
        conn.execute("INSERT INTO worker(id,name,account_type) VALUES('user_owner','Fixture','team')")
        conn.execute("INSERT INTO account(email,password_hash,creator_uid,status,global_role) VALUES('fixture@test','unused','user_owner','approved','admin')")
        conn.execute("UPDATE generation SET creator_uid='user_owner' WHERE id=?", (generation,))
    req = SimpleNamespace(state=SimpleNamespace(account={"email": "fixture@test", "creator_uid": "user_owner", "global_role": "admin"}))
    state = http_call(share.inspect_state, authority(req), generation)
    cmd = ShareCommandIn(operation_id="auth-1", target_id=generation, command_kind="publish",
                          workspace_scope=state["workspace_scope"] or "unknown", workspace_id=state["workspace_id"], expected_revision=state["share_revision"]).as_command()
    first = http_call(share.execute, authority(req), cmd)
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET global_role='production_director' WHERE email='fixture@test'")
        conn.execute("UPDATE generation SET creator_uid='other' WHERE id=?", (generation,))
    assert http_call(share.execute, authority(req), cmd)["receipt"] == first["receipt"]
    with pytest.raises(HTTPException):
        http_call(share.execute, authority(req), {**cmd, "operation_id": "auth-new"})
    with db.get_connection() as conn:
        conn.execute("UPDATE account SET global_role='' WHERE email='fixture@test'")
    with pytest.raises(HTTPException) as denied:
        http_call(share.execute, authority(req), cmd)
    assert denied.value.status_code == 404


def test_supplied_ui_revision_is_not_replaced_and_retry_keeps_exact_input(generation):
    from app.services.share_commands import send
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    displayed = http_call(share.inspect_state, authority(request()), generation)["share_revision"]
    repo.publish(generation, "me")
    seen = []
    def fake(method, path, **kwargs):
        if path.endswith("capabilities"):
            return {"share_command": 1, "receipt_replay": True}
        if "command-state" in path:
            return http_call(share.inspect_state, authority(request()), generation)
        seen.append(kwargs["body"])
        return http_call(share.execute, authority(request()), kwargs["body"])
    for _ in range(2):
        with pytest.raises(HTTPException, match="share_revision_conflict"):
            send(SimpleNamespace(proxy_json=fake), ref, generation, "publish", expected_revision=displayed)
    assert seen[0] == seen[1]
    assert seen[0]["expected_revision"] == displayed


def test_two_new_commands_with_same_revision_only_one_commits(generation):
    from concurrent.futures import ThreadPoolExecutor
    base = command(generation)
    def run(operation):
        try:
            http_call(share.execute, authority(request()), {**base, "operation_id": operation})
            return 200
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(run, ["race-1", "race-2"])) == [200, 409]


def test_reconciler_recovers_receipt_after_response_loss_without_overwriting_new_state(generation, monkeypatch):
    import asyncio
    from app.services import share_state_reconciler as reconciler
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    cmd = command(generation, op="lost-1")
    assert repo.store_share_command(ref, cmd)
    first = http_call(share.execute, authority(request()), cmd)
    repo.unpublish(generation)
    def raw(*args, **kwargs):
        return 200, http_call(share.execute, authority(request()), kwargs["body"])
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", lambda *a: None)
    observed = repo.get_generation(generation)
    outcome = asyncio.run(reconciler._process_claimed_intent(ref, ref["claim_token"], "http://fake.test", "fixture", observed))
    saved = repo.get_share_state_intent(ref["intent_id"])
    assert outcome == "superseded"
    assert json.loads(saved["remote_result_json"]) == first["receipt"]
    assert not repo.get_generation(generation)["shared"]


def test_missing_legacy_revision_is_not_synthesized_as_zero():
    from app.models import GenerationOut
    assert GenerationOut.model_fields["share_revision"].default is None
    assert GenerationOut.model_fields["remote_share_revision"].default is None


def test_reused_operation_with_different_missing_target_still_conflicts(generation):
    cmd = command(generation)
    http_call(share.execute, authority(request()), cmd)
    with pytest.raises(HTTPException, match="operation_id_request_mismatch"):
        http_call(share.execute, authority(request()), {**cmd, "target_id": "missing-target"})


def test_modern_response_revision_and_grade_come_from_same_current_card(generation):
    from app.services.share_commands import send
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    def fake(method, path, **kwargs):
        if path.endswith("capabilities"):
            return {"share_command": 1, "receipt_replay": True}
        if "command-state" in path:
            return http_call(share.inspect_state, authority(request()), generation)
        if path.endswith("commands"):
            result = http_call(share.execute, authority(request()), kwargs["body"])
            repo.unpublish(generation)
            return result
        return repo.get_generation(generation)
    current = send(SimpleNamespace(proxy_json=fake), ref, generation, "publish")
    receipt = json.loads(ref["remote_result_json"])
    assert receipt["shared"] is True
    assert current["shared"] is False
    assert current["remote_share_revision"] == current["share_revision"] > receipt["share_revision"]


@pytest.mark.parametrize("later_change", [False, True])
def test_composite_cleanup_uses_publish_revision_not_latest(generation, monkeypatch, later_change):
    import asyncio
    from app.services import share_state_reconciler as reconciler
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="composite_finalize", desired_shared=True, desired_final=True,
                                         base_shared=False, base_final=False)
    cmd = command(generation, op="composite-publish")
    assert repo.store_share_command(ref, cmd)
    published = http_call(share.execute, authority(request()), cmd)
    assert repo.store_share_command(ref, cmd, published["receipt"])
    if later_change:
        repo.unpublish(generation)
        repo.publish(generation, "me")
    sent = []
    def raw(*args, **kwargs):
        sent.append(kwargs["body"])
        try:
            return 200, http_call(share.execute, authority(request()), kwargs["body"])
        except HTTPException as exc:
            return exc.status_code, {"detail": exc.detail}
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    monkeypatch.setattr(reconciler, "_observe_remote_state", lambda *a: repo.get_generation(generation))
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", lambda *a: None)
    outcome = asyncio.run(reconciler._process_modern_composite_partial(
        ref, ref["claim_token"], "http://fake.test", "fixture", repo.get_generation(generation),
        published["receipt"]["share_revision"], (generation,)))
    assert sent[0]["expected_revision"] == published["receipt"]["share_revision"]
    assert bool(repo.get_generation(generation)["shared"]) == later_change
    assert outcome == ("superseded" if later_change else "rejected")


def test_changed_revision_guard_rejected_without_repair(generation):
    with db.get_connection() as conn:
        trigger = next(iter(schema_compat.SHARE_REVISION_TRIGGERS))
        conn.execute(f'DROP TRIGGER "{trigger}"')
    with pytest.raises(schema_compat.SchemaCompatibilityError, match="share_revision_guard_mismatch"):
        db.init_db()


def test_bundle_url_adoption_cannot_bypass_target_revision(generation):
    from app.routers.publish import receive_published_bundle, PublishBundleIn
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET creator_uid='user_owner' WHERE id=?", (generation,))
        conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES('asset-fixture',?,'image','https://example.test/fixture.png')", (generation,))
    before = repo.get_generation(generation)
    item = {"generation": {"id": "different-anchor", "creator_uid": "user_owner", "prompt": "must not overwrite", "status": "done", "workspace_scope": "unknown"},
            "asset": {"type": "image", "file_path": "https://example.test/fixture.png"}}
    cmd = ShareCommandIn(operation_id="alias-cas", target_id="different-anchor", command_kind="publish_bundle",
                         workspace_scope="unknown", expected_revision=0, parameters={"item": item, "provider": {"uid": "user_owner"}}).as_command()
    result = receive_published_bundle(PublishBundleIn(bundle={"provider": {"uid": "user_owner"}, "generations": [item]}, commands=[cmd]), request())
    assert result["command_results"]["different-anchor"]["error"]["status_code"] == 409
    after = repo.get_generation(generation)
    assert (after["job_id"], after["share_revision"], after["shared"], after["prompt"]) == (before["job_id"], before["share_revision"], before["shared"], before["prompt"])


@pytest.mark.parametrize("restored", [False, True])
def test_failed_finalize_reconcile_cleans_only_own_publish_revision(generation, monkeypatch, tmp_path, restored):
    import asyncio
    from app.services import share_state_reconciler as reconciler
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="composite_finalize", desired_shared=True, desired_final=True,
                                         base_shared=False, base_final=False)
    repo.publish(generation, "me")
    cmd = command(generation, kind="finalize", op="composite-finalize")
    cmd["db_generation"] = http_call(share.inspect_state, authority(request()), generation)["db_generation"]
    assert repo.store_share_command(ref, cmd)
    if restored:
        from app.routers import db_transfer
        snapshot = tmp_path / "before-cleanup.db"
        db._copy_sqlite(db.get_db_path(), snapshot)
        assert db_transfer._install_db(snapshot, expected=db_transfer._capture_restore_target())["ok"]
    sent = []
    def raw(*args, **kwargs):
        body = kwargs["body"]
        sent.append(body)
        if body["command_kind"] == "finalize" and not restored:
            return 403, {"detail": "role revoked"}
        try:
            return 200, http_call(share.execute, authority(request()), body)
        except HTTPException as error:
            return error.status_code, {"detail": error.detail}
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    monkeypatch.setattr(reconciler, "_observe_remote_state", lambda *a: repo.get_generation(generation))
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", lambda *a: None)
    outcome = asyncio.run(reconciler._process_claimed_intent(ref, ref["claim_token"], "http://fake.test", "fixture", repo.get_generation(generation)))
    assert [body["command_kind"] for body in sent] == ["finalize", "unpublish"]
    assert sent[-1]["expected_revision"] == cmd["expected_revision"]
    assert sent[-1]["db_generation"] == cmd["db_generation"]
    assert outcome == ("superseded" if restored else "rejected")
    assert bool(repo.get_generation(generation)["shared"]) == restored


def test_reconciler_rejects_changed_generation_without_rewriting_frozen_command(generation, monkeypatch):
    import asyncio
    from app.routers import db_transfer
    from app.services import share_state_reconciler as reconciler
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
        operation_kind="publish", desired_shared=True, desired_final=False, base_shared=False, base_final=False)
    cmd = {**command(generation), "db_generation": http_call(share.inspect_state, authority(request()), generation)["db_generation"]}
    assert repo.store_share_command(ref, cmd)
    db_transfer._post_install_security_init(db.get_db_path())
    sent = []
    def raw(*args, **kwargs):
        sent.append(kwargs["body"])
        try:
            return 200, http_call(share.execute, authority(request()), kwargs["body"])
        except HTTPException as error:
            return error.status_code, {"detail": error.detail}
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    outcome = asyncio.run(reconciler._process_claimed_intent(ref, ref["claim_token"], "http://fake.test", "fixture", repo.get_generation(generation)))
    saved = repo.get_share_state_intent(ref["intent_id"])
    assert outcome == "rejected" and saved["status"] == "rejected"
    assert saved["last_error_code"] == "remote_command_409"
    assert sent == [cmd] and json.loads(saved["remote_command_json"]) == cmd
    assert not repo.get_generation(generation)["shared"]


def test_grade_revision_present_in_single_batch_and_list(generation):
    repo.publish(generation, "me")
    state = http_call(share.inspect_state, authority(request()), generation)
    for card in (repo.get_generation(generation), repo.get_generations_batch([generation])[generation],
                 next(row for row in repo.list_generations() if row["id"] == generation)):
        assert (card["share_revision"], card["shared"], card["is_final"], card["is_held"]) == (state["share_revision"], state["shared"], state["is_final"], state["is_held"])


def test_intent_cannot_rewrite_saved_input_or_receipt(generation):
    ref = repo.prepare_share_state_intent("http://fake.test", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    cmd = command(generation)
    receipt = http_call(share.execute, authority(request()), cmd)["receipt"]
    assert repo.store_share_command(ref, cmd, receipt)
    with pytest.raises(ValueError, match="share_command_input_changed"):
        repo.store_share_command(ref, {**cmd, "expected_revision": 99})
    with pytest.raises(ValueError, match="share_receipt_changed"):
        repo.store_share_command(ref, cmd, {**receipt, "shared": False})
    assert repo.store_share_command(ref, cmd)
    assert json.loads(ref["remote_result_json"]) == receipt


def test_legacy_route_with_revision_applies_cas_and_returns_current_grade(generation, monkeypatch):
    from app.routers import share as routes
    from app.models import PublishIn
    monkeypatch.setattr(routes._proxy, "proxying", lambda: False)
    monkeypatch.setattr(routes, "_touch_telemetry", lambda *a: None)
    revision = repo.get_generation(generation)["share_revision"]
    out = routes.publish(generation, PublishIn(), request(), expected_revision=revision)
    assert out["shared"]
    assert out["remote_share_revision"] == out["share_revision"] > revision
    with pytest.raises(HTTPException, match="share_revision_conflict"):
        routes.unpublish(generation, request(), expected_revision=revision)


@pytest.mark.parametrize("capability", [404, 405, "unsupported"])
@pytest.mark.parametrize("expected", [0, 7])
@pytest.mark.parametrize("action", ["hold", "unhold", "finalize", "unfinalize", "final_review", "unpublish", "composite_finalize"])
def test_legacy_revision_condition_rejects_before_remote_mutation(generation, monkeypatch, capability, expected, action):
    from app.models import FinalReviewIn
    from app.routers import share as routes, publish
    from fastapi import BackgroundTasks
    if action != "composite_finalize":
        repo.publish(generation, "me")
    if action in {"unfinalize", "final_review"}:
        repo.finalize_generation_with_share(generation, "me")
    if action == "unhold":
        repo.set_generation_hold(generation, True)
    before = repo.get_generation(generation)
    mutations = []
    def capability_response():
        if isinstance(capability, int):
            raise HTTPException(capability, "Not Found")
        return {}
    def proxy(method, path, **kwargs):
        if path.endswith("capabilities"):
            return capability_response()
        if method == "POST":
            mutations.append((path, kwargs.get("body")))
        return {**before, "shared": action != "unpublish", "is_final": action in {"finalize", "composite_finalize"},
                "is_held": action in {"hold", "final_review"}}
    def bundle_http(method, url, **kwargs):
        if url.endswith("capabilities"):
            try: return 200, capability_response()
            except HTTPException as exc: return exc.status_code, {"detail": exc.detail}
        mutations.append((url, kwargs.get("body")))
        return 200, {"inserted": 1, "updated": 0, "unchanged": 0, "skipped": 0, "blocked": 0}
    monkeypatch.setattr(routes._proxy, "proxying", lambda: True)
    monkeypatch.setattr(routes._proxy, "base_url", lambda: "http://revision.fixture")
    monkeypatch.setattr(routes._proxy, "proxy_json", proxy)
    monkeypatch.setattr(publish, "_http_json", bundle_http)
    for module in (routes, publish):
        monkeypatch.setattr(module, "_touch_telemetry", lambda *a: None)
        monkeypatch.setattr(module, "kick_share_state_reconciler", lambda: None)
    repo.set_setting("shared_server_url", "http://revision.fixture")
    repo.set_setting("shared_server_token", "synthetic-test-token")
    with pytest.raises(HTTPException) as error:
        if action in {"finalize", "composite_finalize"}:
            routes.finalize(generation, request(), BackgroundTasks(), expected_revision=expected)
        elif action == "final_review":
            routes.final_review(generation, FinalReviewIn(state="held"), request(), expected_revision=expected)
        else:
            function = getattr(routes, action + "_generation" if action in {"hold", "unhold"} else action)
            function(generation, request(), expected_revision=expected)
    assert error.value.status_code == 409
    assert error.value.detail == "share_revision_precondition_unsupported"
    assert mutations == []
    after = repo.get_generation(generation)
    assert tuple(after[key] for key in ("shared", "is_final", "is_held", "share_revision")) == tuple(before[key] for key in ("shared", "is_final", "is_held", "share_revision"))
    with db.get_connection() as conn:
        row = conn.execute("SELECT * FROM share_state_intent").fetchone()
    if row is not None:
        assert row["status"] == "rejected" and row["last_error_code"] == "remote_409"
        assert repo.share_intent_outcome(row["intent_id"], row["intent_seq"]) == {"state": "failed"}
    assert repo.claim_due_share_state_intents("no-retry", server_origin="http://revision.fixture") == []


@pytest.mark.parametrize("capability", [404, 405, "unsupported"])
def test_legacy_revision_omitted_keeps_send_fallback(capability):
    from app.services.share_commands import send
    calls = []
    def proxy(method, path, **kwargs):
        calls.append((method, path))
        if isinstance(capability, int): raise HTTPException(capability, "Not Found")
        return {}
    assert send(SimpleNamespace(proxy_json=proxy), {}, "generation", "hold") is None
    assert calls == [("GET", "/api/share/capabilities")]


def test_legacy_revision_saved_command_replays_exact_input_without_capability(generation):
    from app.services.share_commands import send
    ref = repo.prepare_share_state_intent("http://revision.fixture", job_anchor=generation, local_id=generation,
                                         operation_kind="publish", desired_shared=True, desired_final=False,
                                         base_shared=False, base_final=False)
    saved = command(generation)
    assert repo.store_share_command(ref, saved)
    calls = []
    def proxy(method, path, **kwargs):
        calls.append((method, path))
        if path.endswith("commands"):
            assert kwargs["body"] == saved
            return http_call(share.execute, authority(request()), kwargs["body"])
        assert method == "GET" and path == f"/api/generations/{generation}"
        return repo.get_generation(generation)
    assert send(SimpleNamespace(proxy_json=proxy), ref, generation, "publish", expected_revision=99999)["shared"]
    assert calls == [("POST", "/api/share/commands"), ("GET", f"/api/generations/{generation}")]


@pytest.fixture
def modern_composite(generation, monkeypatch, tmp_path):
    from app.routers import share as routes, publish
    from app.routers.publish import PublishBundleIn
    from fastapi import BackgroundTasks
    server_db = tmp_path / "server.db"
    anchor, server_id = "composite-job-anchor", "composite-server-row"
    def on_server(function, *args):
        with monkeypatch.context() as context:
            context.setenv("CONTENT_HUB_DB", str(server_db))
            return function(*args)
    def seed():
        db.init_db(); repo.ensure_default_worker()
        repo.create_local_generation({"model": "test", "prompt": "server original"}, "me", generation_id=server_id)
        repo.set_status(server_id, "done")
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET job_id=? WHERE id=?", (anchor, server_id))
        repo.publish(server_id, "me"); repo.unpublish(server_id)
    on_server(seed)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET job_id=? WHERE id=?", (anchor, generation))
    repo.set_setting("shared_server_url", "http://revision.fixture")
    repo.set_setting("shared_server_token", "synthetic-test-token")
    mutations = []
    publish_receipts = []
    def remote(method, url, **kwargs):
        path = url.removeprefix("http://revision.fixture")
        if path.endswith("capabilities"): return 200, {"share_command": 1, "receipt_replay": True}
        if "/command-state/" in path:
            assert path.endswith("/" + anchor)
            return 200, on_server(http_call, share.inspect_state, authority(request()), anchor)
        if path.endswith("publish-bundle"):
            mutations.append(kwargs["body"])
            result = on_server(publish.receive_published_bundle, PublishBundleIn(**kwargs["body"]), request())
            for value in result.get("command_results", {}).values():
                if "receipt" in value: publish_receipts.append(value["receipt"])
            return 200, result
        if path.endswith("commands"):
            mutations.append(kwargs["body"])
            try: return 200, on_server(http_call, share.execute, authority(request()), kwargs["body"])
            except HTTPException as exc: return exc.status_code, {"detail": exc.detail}
        assert method == "GET" and path.startswith("/api/generations/")
        current = on_server(repo.get_generation, path.removeprefix("/api/generations/"))
        return (200, current) if current else (404, {"detail": "generation 없음"})
    def proxy(method, path, **kwargs):
        status, body = remote(method, "http://revision.fixture" + path, **kwargs)
        if status >= 400: raise HTTPException(status, body["detail"])
        return body
    monkeypatch.setattr(routes._proxy, "proxying", lambda: True)
    monkeypatch.setattr(routes._proxy, "base_url", lambda: "http://revision.fixture")
    monkeypatch.setattr(routes._proxy, "proxy_json", proxy)
    monkeypatch.setattr(publish, "_http_json", remote)
    for module in (routes, publish):
        monkeypatch.setattr(module, "_touch_telemetry", lambda *a: None)
        monkeypatch.setattr(module, "kick_share_state_reconciler", lambda: None)
    return SimpleNamespace(gid=generation, anchor=anchor, on_server=on_server, server_generation=lambda: on_server(repo.get_generation, server_id),
                           mutations=mutations, publish_receipts=publish_receipts,
                           finalize=lambda expected: routes.finalize(generation, request(), BackgroundTasks(), expected_revision=expected))


@pytest.mark.parametrize("expected", [0, 1])
def test_composite_revision_explicit_stale_rejects_first_publish(modern_composite, expected):
    fixture = modern_composite
    before = fixture.server_generation()
    assert before["share_revision"] > expected
    with pytest.raises(HTTPException) as error:
        fixture.finalize(expected)
    assert error.value.status_code == 409
    assert fixture.mutations[0]["commands"][0]["target_id"] == fixture.anchor
    assert fixture.mutations[0]["commands"][0]["expected_revision"] == expected
    after = fixture.server_generation()
    assert tuple(after[key] for key in ("shared", "is_final", "share_revision")) == tuple(before[key] for key in ("shared", "is_final", "share_revision"))
    assert not repo.get_generation(fixture.gid)["shared"]


@pytest.mark.parametrize("explicit", [False, True])
def test_composite_revision_matching_or_omitted_keeps_receipt_chain(modern_composite, explicit):
    fixture = modern_composite
    before = fixture.server_generation()
    out = fixture.finalize(before["share_revision"] if explicit else None)
    assert out["is_final"] and out["shared"]
    assert fixture.mutations[0]["commands"][0]["expected_revision"] == before["share_revision"]
    assert fixture.mutations[0]["commands"][0]["target_id"] == fixture.anchor
    assert fixture.mutations[1]["command_kind"] == "finalize"
    assert fixture.mutations[1]["expected_revision"] == fixture.publish_receipts[0]["share_revision"]


def test_composite_keeps_original_generation_with_fresh_credentials_between_steps(modern_composite, monkeypatch):
    import asyncio
    from app.routers import db_transfer, publish
    from app.services import share_state_reconciler as reconciler
    fixture = modern_composite
    original_http = publish._http_json

    def rotate_after_publish(method, url, **kwargs):
        reply = original_http(method, url, **kwargs)
        if url.endswith("/publish-bundle") and reply[0] == 200:
            # The fake transport accepts credentials after the server's restore invalidation.
            fixture.on_server(lambda: db_transfer._post_install_security_init(db.get_db_path()))
        return reply

    monkeypatch.setattr(publish, "_http_json", rotate_after_publish)
    with pytest.raises(HTTPException) as error:
        fixture.finalize(None)
    assert error.value.status_code == 409 and error.value.detail == "share_database_generation_changed"
    original_generation = fixture.mutations[0]["commands"][0]["db_generation"]
    assert fixture.mutations[1]["db_generation"] == original_generation
    def server_current():
        return fixture.on_server(repo.get_generation, fixture.publish_receipts[0]["id"])
    current = server_current()
    assert not current["shared"] and not current["is_final"]

    sent = []
    def raw(method, url, **kwargs):
        sent.append(kwargs["body"])
        try:
            return 200, fixture.on_server(http_call, share.execute, authority(request()), kwargs["body"])
        except HTTPException as exc:
            return exc.status_code, {"detail": exc.detail}
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    monkeypatch.setattr(reconciler, "_observe_remote_state", lambda *_: server_current())
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", lambda *_: None)
    claimed = repo.claim_due_share_state_intents("stage-recovery", server_origin="http://revision.fixture")
    assert len(claimed) == 1
    intent = claimed[0]
    outcome = asyncio.run(reconciler._process_claimed_intent(intent, intent["claim_token"], "http://revision.fixture", "fixture", current))
    assert outcome == "rejected"
    assert [body["command_kind"] for body in sent] == ["finalize"]
    assert all(body["db_generation"] == original_generation for body in sent)
    after = server_current()
    assert tuple(after[key] for key in ("shared", "is_final", "share_revision")) == tuple(current[key] for key in ("shared", "is_final", "share_revision"))


def test_composite_revision_applies_only_to_selected_anchor(generation):
    from app.services.share_commands import prepare_bundle
    other = repo.create_local_generation({"model": "test", "prompt": "other bundle item"}, "me")
    refs = {anchor: repo.prepare_share_state_intent("http://revision.fixture", job_anchor=anchor, local_id=local_id,
                                                  operation_kind="publish", desired_shared=True, desired_final=False,
                                                  base_shared=False, base_final=False)
            for anchor, local_id in (("selected-anchor", generation), ("other-anchor", other))}
    bundle = {"generations": [{"generation": {"id": anchor}} for anchor in refs]}
    def remote(method, url, **kwargs):
        assert method == "GET"
        if url.endswith("capabilities"): return 200, {"share_command": 1, "receipt_replay": True}
        return 200, {"share_revision": 4 if url.endswith("selected-anchor") else 9}
    commands = prepare_bundle(remote, "http://revision.fixture", "synthetic", bundle, refs, expected_revisions={"selected-anchor": 0})
    assert {value["target_id"]: value["expected_revision"] for value in commands} == {"selected-anchor": 0, "other-anchor": 9}


def test_composite_revision_requires_one_selected_input(generation, monkeypatch):
    from app.routers import publish
    from unittest.mock import Mock
    repo.set_setting("shared_server_token", "synthetic-test-token")
    remote = Mock()
    monkeypatch.setattr(publish, "_http_json", remote)
    with pytest.raises(HTTPException, match="share_revision_requires_single_target"):
        publish.publish_bundle_to_server([generation, "other-selected"], expected_revision=0)
    remote.assert_not_called()


def test_modern_send_fetches_remote_primary_key_after_job_anchor_command(modern_composite):
    from app.routers import share as routes
    from app.services.share_commands import send
    fixture = modern_composite
    remote_id = fixture.server_generation()["id"]
    assert remote_id != fixture.anchor
    assert fixture.on_server(repo.get_generation, fixture.anchor) is None
    assert fixture.on_server(http_call, share.inspect_state, authority(request()), fixture.anchor)["id"] == remote_id
    fixture.on_server(repo.publish, remote_id, "me")
    ref = repo.prepare_share_state_intent("http://revision.fixture", job_anchor=fixture.anchor, local_id=fixture.gid,
                                         operation_kind="hold", desired_shared=True, desired_final=False,
                                         desired_held=True, base_shared=True, base_final=False, base_held=False)

    current = send(routes._proxy, ref, fixture.anchor, "hold")

    assert current["id"] == remote_id and current["job_id"] == fixture.anchor and current["is_held"]
    assert json.loads(ref["remote_command_json"])["target_id"] == fixture.anchor
    assert json.loads(ref["remote_result_json"])["id"] == remote_id
    assert current["remote_share_revision"] == current["share_revision"]


def test_modern_send_anchor_replay_fetches_newer_current_card(modern_composite):
    from app.routers import share as routes
    from app.services.share_commands import send
    fixture = modern_composite
    remote_id = fixture.server_generation()["id"]
    assert remote_id != fixture.anchor
    fixture.on_server(repo.publish, remote_id, "me")
    ref = repo.prepare_share_state_intent("http://revision.fixture", job_anchor=fixture.anchor, local_id=fixture.gid,
                                         operation_kind="hold", desired_shared=True, desired_final=False,
                                         desired_held=True, base_shared=True, base_final=False, base_held=False)
    saved = fixture.on_server(command, fixture.anchor, "hold", "anchor-replay")
    assert repo.store_share_command(ref, saved)
    first = fixture.on_server(http_call, share.execute, authority(request()), saved)
    fixture.on_server(repo.set_generation_hold, remote_id, False)
    calls, replies = [], []
    def proxy(method, path, **kwargs):
        calls.append((method, path))
        result = routes._proxy.proxy_json(method, path, **kwargs)
        if method == "POST":
            assert kwargs["body"] == saved
            assert result["replayed"] and result["receipt"] == first["receipt"]
            replies.append(result)
            fixture.on_server(repo.set_generation_hold, remote_id, True)
        return result

    current = send(SimpleNamespace(proxy_json=proxy), ref, fixture.anchor, "hold")

    assert calls == [("POST", "/api/share/commands"), ("GET", f"/api/generations/{remote_id}")]
    assert json.loads(ref["remote_command_json"]) == saved
    assert json.loads(ref["remote_result_json"]) == first["receipt"]
    assert replies[0]["current"]["is_held"] is False and current["is_held"] is True
    assert current["remote_share_revision"] == current["share_revision"] > replies[0]["current"]["share_revision"] > first["receipt"]["share_revision"]


@pytest.mark.parametrize("mismatch_at,detail", [("command", "share_receipt_unconfirmed"),
                                                ("fetch", "share_current_revision_unconfirmed")])
def test_modern_send_keeps_remote_identity_guards(modern_composite, mismatch_at, detail):
    from app.routers import share as routes
    from app.services.share_commands import send
    fixture = modern_composite
    remote_id = fixture.server_generation()["id"]
    fixture.on_server(repo.publish, remote_id, "me")
    ref = repo.prepare_share_state_intent("http://revision.fixture", job_anchor=fixture.anchor, local_id=fixture.gid,
                                         operation_kind="hold", desired_shared=True, desired_final=False,
                                         desired_held=True, base_shared=True, base_final=False, base_held=False)
    calls = []
    def proxy(method, path, **kwargs):
        calls.append((method, path))
        result = routes._proxy.proxy_json(method, path, **kwargs)
        if mismatch_at == "command" and method == "POST":
            return {**result, "current": {**result["current"], "id": "wrong-remote-id"}}
        if mismatch_at == "fetch" and path.startswith("/api/generations/"):
            return {**result, "id": "wrong-remote-id"}
        return result

    with pytest.raises(HTTPException) as error:
        send(SimpleNamespace(proxy_json=proxy), ref, fixture.anchor, "hold")

    assert error.value.status_code == 503 and error.value.detail == detail
    if mismatch_at == "command":
        assert not any(path.startswith("/api/generations/") for _, path in calls)
        assert ref.get("remote_result_json") is None
    else:
        assert calls[-1] == ("GET", f"/api/generations/{remote_id}")
        assert json.loads(ref["remote_result_json"])["id"] == remote_id


@pytest.mark.parametrize("status", [401, 404, 503])
def test_followup_get_failure_keeps_success_receipt_recoverable(modern_composite, monkeypatch, status):
    import asyncio
    from app.routers import share as routes
    from app.services import share_state_reconciler as reconciler
    fixture = modern_composite
    origin = "http://revision.fixture"
    remote_id = fixture.server_generation()["id"]
    fixture.on_server(repo.publish, remote_id, "me")
    repo.publish(fixture.gid, "me")
    base_proxy = routes._proxy.proxy_json
    kicks = []
    def proxy(method, path, **kwargs):
        if method == "GET" and path == f"/api/generations/{remote_id}":
            raise HTTPException(status, "follow-up card unavailable")
        return base_proxy(method, path, **kwargs)
    monkeypatch.setattr(routes._proxy, "proxy_json", proxy)
    monkeypatch.setattr(routes, "kick_share_state_reconciler", lambda: kicks.append(True))

    with pytest.raises(HTTPException) as error:
        routes.hold_generation(fixture.gid, request())

    assert error.value.status_code == 503 and error.value.detail == "share_current_revision_unconfirmed"
    assert isinstance(error.value.__cause__, HTTPException) and error.value.__cause__.status_code == status
    with db.get_connection() as conn:
        pending = dict(conn.execute("SELECT * FROM share_state_intent").fetchone())
    assert pending["status"] == "prepared" and pending["last_error_code"] is None
    assert pending["claim_token"] is None and pending["lease_until"] is None and kicks == [True]
    saved_command = json.loads(pending["remote_command_json"])
    saved_receipt = json.loads(pending["remote_result_json"])
    assert saved_command == fixture.mutations[0] and saved_command["target_id"] == fixture.anchor
    assert saved_receipt["id"] == remote_id and saved_receipt["is_held"] is True
    assert fixture.server_generation()["is_held"] is True
    assert repo.get_generation(fixture.gid)["is_held"] is False

    # A later server change must survive retry of the already accepted hold.
    fixture.on_server(repo.unpublish, remote_id)
    latest = fixture.server_generation()
    replies = []
    def raw(method, url, **kwargs):
        assert method == "POST" and url == origin + "/api/share/commands"
        assert kwargs["body"] == saved_command
        reply = base_proxy(method, "/api/share/commands", body=kwargs["body"])
        assert reply["replayed"] and reply["receipt"] == saved_receipt
        replies.append(reply)
        return 200, reply
    monkeypatch.setattr(reconciler, "_proxy", SimpleNamespace(raw_request=raw))
    monkeypatch.setattr(reconciler, "touch_generation_telemetry", lambda *_: None)
    claimed = repo.claim_due_share_state_intents("followup-recovery", server_origin=origin)
    assert len(claimed) == 1 and claimed[0]["intent_id"] == pending["intent_id"]

    outcome = asyncio.run(reconciler._process_claimed_intent(
        claimed[0], claimed[0]["claim_token"], origin, "fixture", latest))

    assert outcome == "superseded" and len(replies) == 1
    assert fixture.mutations == [saved_command, saved_command]
    settled = repo.get_share_state_intent(pending["intent_id"])
    assert settled["status"] == "superseded" and settled["claim_token"] is None and settled["lease_until"] is None
    assert json.loads(settled["remote_command_json"]) == saved_command
    assert json.loads(settled["remote_result_json"]) == saved_receipt
    current = repo.get_generation(fixture.gid)
    assert current["shared"] is False
    assert tuple(current[key] for key in ("shared", "is_final", "is_held")) == tuple(latest[key] for key in ("shared", "is_final", "is_held"))
    assert fixture.server_generation()["share_revision"] == latest["share_revision"] > saved_receipt["share_revision"]
