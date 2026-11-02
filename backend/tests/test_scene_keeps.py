"""Scene-keep contracts against temporary SQLite databases and in-process routes.

No listening server, provider call or real account database is used here.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import active_account, config, db, db_migrations
from app.repo import scene_keeps as keeps
from app.routers import scene_keeps as routes

OWNER = "keeper@example.test"
OTHER = "other@example.test"
AUTHOR = "acct:" + OWNER


def scene(*ids):
    return json.dumps({"format": "mv-scene", "version": 1, "savedAt": 0,
                       "scene": {"name": "Scene", "cards": [{"id": "card", "genIds": list(ids)}],
                                 "edges": [], "groups": [], "camera": {"x": 0, "y": 0, "zoom": 1}}})


def generation(gid="g1", **changes):
    result = {"id": gid, "scene_ids": [gid], "job_id": "job-" + gid,
              "source": "local", "prompt": "prompt", "display_prompt": None,
              "model": None, "params": None, "status": "done",
              "created_at": "2026-10-01T00:00:00Z", "sort_ts": None,
              "generator": None, "creator_uid": AUTHOR,
              "assets": [{"type": "image", "file_path": "https://example.test/result.png",
                          "thumbnail_path": None}]}
    result.update(changes)
    return result


def envelope(*items):
    return {"v": 1, "scene_text": scene(*(alias for g in items for alias in g.get("scene_ids", [g["id"]]))),
            "generations": list(items)}


def body(data=None, **changes):
    result = {"name": "Scene", "project_id": "private-project", "project_name": "Private",
              "workspace": {"id": "w1", "name": "W"}, "preview": [["gen", 0, 0, 100, 100]],
              "data": envelope(generation()) if data is None else data, "expect_account": OWNER}
    result.update(changes)
    return result


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    token = active_account.set_override("")
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO worker(id,name) VALUES(?, 'Test worker')", (config.DEFAULT_WORKER_ID,))
    try:
        yield tmp_path
    finally:
        db.flush_pool()
        active_account.reset_override(token)


def insert_existing(gid, *, job=None, status="done", asset=True):
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,status,job_id) VALUES(?,?,?,?,?)",
                     (gid, config.DEFAULT_WORKER_ID, "existing", status, job))
        if asset:
            conn.execute("INSERT INTO asset(id,generation_id,type,file_path) VALUES(?,?,'image',?)",
                         ("asset-" + gid, gid, "https://example.test/existing.png"))


def test_schema_added_idempotently_without_a_new_baseline(tmp_path):
    conn = sqlite3.connect(tmp_path / "legacy.db")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(db.SCHEMA_PATH.read_text(encoding="utf-8"))
        original_columns = [r[1] for r in conn.execute("PRAGMA table_info(scene_keep)")]
        assert original_columns[-1] == "data"
        conn.execute("INSERT INTO folder_cover(project_id,folder_path,generation_id) VALUES('p','f','g')")
        conn.execute("DROP TABLE scene_keep")
        db_migrations._migrate(conn)
        db_migrations._migrate(conn)
        assert [r[1] for r in conn.execute("PRAGMA table_info(scene_keep)")] == original_columns
        assert conn.execute("SELECT COUNT(*) FROM folder_cover").fetchone()[0] == 1
        columns = {r[1] for r in conn.execute("PRAGMA table_info(scene_keep)")}
        assert {"owner", "data_bytes", "revision", "preview", "missing_count"} <= columns
        assert not conn.execute("SELECT name FROM sqlite_master WHERE name='schema_migrations'").fetchall()
    finally:
        conn.close()


def test_private_ownership_project_key_and_no_email_outside_envelope(isolated_db):
    first = keeps.save_keep(OWNER.upper(), body())
    assert keeps.list_keeps(OTHER) == []
    for call in (lambda: keeps.get_keep(OTHER, first["id"]),
                 lambda: keeps.get_keep(OTHER, first["id"], 1),
                 lambda: keeps.delete_keep(OTHER, first["id"], 1)):
        with pytest.raises(LookupError):
            call()
    second = keeps.save_keep(OWNER, body(project_id="another-project"))
    assert second["id"] != first["id"]
    public = [keeps.list_keeps(OWNER), keeps.get_keep(OWNER, first["id"]), first]
    assert OWNER not in json.dumps(public)
    assert keeps.get_keep(OWNER, first["id"], 1)["generations"][0]["creator_uid"] == AUTHOR


def test_no_workspace_is_null_in_both_list_and_detail(isolated_db):
    saved = keeps.save_keep(OWNER, body(workspace=None))
    assert keeps.list_keeps(OWNER)[0]["workspace"] is None
    assert keeps.get_keep(OWNER, saved["id"])["workspace"] is None


def test_first_restore_uses_pinned_uid_in_empty_account_database(tmp_path, route_client, monkeypatch):
    from app import deps

    uid = "user_fresh_account"
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(db, "DEFAULT_DB_PATH", config.DATA_DIR / "db" / "content_hub.db")
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    monkeypatch.setattr(active_account, "_read_pointer", lambda: {"email": OWNER, "uid": uid})
    monkeypatch.setattr(routes._proxy, "proxying", lambda: True)
    monkeypatch.setattr(routes._proxy, "base_url", lambda: "https://example.invalid")
    monkeypatch.setattr(routes._proxy, "token", lambda: "test-token")
    with active_account.pinned_account_scope((OWNER, uid)):
        path = db.ensure_account_db(OWNER, uid)
        assert path == config.DATA_DIR / "db" / "acct" / active_account.slug(OWNER) / "content_hub.db"
        assert db.get_db_path() == path
        assert routes.repo.get_my_uid() is None
        with db.get_connection() as conn:
            assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0
            assert conn.execute("SELECT value FROM app_setting WHERE key='my_creator_uid'").fetchone() is None

    data = envelope(*(generation(f"own-{i}", source="server", creator_uid=uid) for i in range(8)),
                    generation("local", creator_uid=uid),
                    generation("foreign", source="server", creator_uid="user_someone_else"))

    def remote(*args, **kwargs):
        assert active_account.active_uid() == uid
        assert db.get_db_path() == path
        return data

    monkeypatch.setattr(routes._proxy, "proxy_json", remote)
    for expected in (9, 0):
        response = route_client.post("/api/scene-keeps/restore", headers={
            "Host": "127.0.0.1", "X-MVHub-Expect-Account": "acct:" + OWNER,
        }, json={"id": "a" * 32, "revision": 1})
        assert response.status_code == 200, response.text
        assert response.json()["restored"] == expected
        assert "foreign" not in response.json()["id_map"]
    with db.get_connection(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 9
        assert conn.execute("SELECT 1 FROM generation WHERE id='foreign'").fetchone() is None


def test_overwrite_requires_both_identity_and_revision_and_handles_aba(isolated_db):
    first = keeps.save_keep(OWNER, body(name="  Scene  "))
    assert keeps.save_keep(OWNER, body())["status"] == "exists"
    unchanged = keeps.save_keep(OWNER, body(overwrite_id=first["id"], overwrite_revision=1))
    assert unchanged["revision"] == 1
    changed = body(envelope(generation(prompt="new")), overwrite_id=first["id"], overwrite_revision=1)
    assert keeps.save_keep(OWNER, changed)["revision"] == 2
    assert keeps.save_keep(OWNER, changed) == {"status": "conflict"}
    with pytest.raises(keeps.KeepConflict):
        keeps.get_keep(OWNER, first["id"], 1)
    with pytest.raises(keeps.KeepConflict):
        keeps.delete_keep(OWNER, first["id"], 1)
    keeps.delete_keep(OWNER, first["id"], 2)
    recreated = keeps.save_keep(OWNER, body())
    assert recreated["id"] != first["id"]
    assert keeps.save_keep(OWNER, changed) == {"status": "conflict"}


def test_row_and_byte_quotas_exclude_overwritten_row_and_rollback(isolated_db, monkeypatch):
    monkeypatch.setattr(keeps, "ROW_MAX", 1)
    first = keeps.save_keep(OWNER, body())
    with pytest.raises(ValueError, match="용량"):
        keeps.save_keep(OWNER, body(name="Second"))
    assert len(keeps.list_keeps(OWNER)) == 1
    monkeypatch.setattr(keeps, "ACCOUNT_MAX", len(keeps.encoded(body()["data"])))
    assert keeps.save_keep(OWNER, body(overwrite_id=first["id"], overwrite_revision=1))["status"] == "saved"
    with pytest.raises(ValueError, match="용량"):
        keeps.save_keep(OWNER, body(envelope(generation(prompt="x" * 500)),
                                    overwrite_id=first["id"], overwrite_revision=1))
    assert keeps.get_keep(OWNER, first["id"], 1)["generations"][0]["prompt"] == "prompt"


def test_two_writers_cannot_silently_create_or_overwrite_the_same_name(isolated_db):
    barrier = threading.Barrier(2)

    def create():
        barrier.wait(timeout=5)
        return keeps.save_keep(OWNER, body())

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create) for _ in range(2)]
        results = [future.result(timeout=10) for future in futures]
    assert sorted(item["status"] for item in results) == ["exists", "saved"]
    saved = next(item for item in results if item["status"] == "saved")
    barrier = threading.Barrier(2)

    def overwrite(prompt):
        barrier.wait(timeout=5)
        return keeps.save_keep(OWNER, body(envelope(generation(prompt=prompt)),
                                           overwrite_id=saved["id"], overwrite_revision=1))

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(overwrite, prompt) for prompt in ("first", "second")]
        results = [future.result(timeout=10) for future in futures]
    assert sorted(item["status"] for item in results) == ["conflict", "saved"]
    assert keeps.get_keep(OWNER, saved["id"])["revision"] == 2


@pytest.mark.parametrize("mutate", [
    lambda d: d.update(v=True), lambda d: d.update(v=2),
    lambda d: d["generations"][0].update(status="running"),
    lambda d: d["generations"][0].update(id="x" * 201),
    lambda d: d["generations"][0].update(prompt="x" * 20001),
    lambda d: d["generations"][0].update(sort_ts=float("nan")),
    lambda d: d["generations"][0].update(params={"large": "x" * 65536}),
    lambda d: d["generations"][0].update(assets=[]),
    lambda d: d["generations"][0].update(assets=[generation()["assets"][0]] * 33),
    lambda d: d["generations"][0]["assets"][0].update(file_path="http://example.test/a"),
    lambda d: d["generations"][0]["assets"][0].update(thumbnail_path="C:/thumb.png"),
    lambda d: d["generations"][0]["assets"][0].update(file_path="https://" + "a" * 4090),
    lambda d: d["generations"][0]["assets"][0].update(type="script"),
    lambda d: d["generations"][0].update(scene_ids=["not-in-scene"]),
])
def test_invalid_envelopes_refused_before_any_restore_write(isolated_db, mutate):
    data = envelope(generation())
    mutate(data)
    with pytest.raises(ValueError):
        keeps.restore_keep(data, {AUTHOR})
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0


@pytest.mark.parametrize("preview", [
    [["gen", -1, 0, 1, 1]], [["gen", 0, float("inf"), 1, 1]],
    [["gen", 0, 0, 1001, 1]], [["gen", 0, 0, 1]], [["gen", 0, 0, 1, 1]] * 201,
    [["x" * 40, 1000, 1000, 1000, 1000]] * 200,
])
def test_preview_has_coordinate_count_and_byte_boundaries(isolated_db, preview):
    with pytest.raises(ValueError):
        keeps.save_keep(OWNER, body(preview=preview))
    assert keeps.list_keeps(OWNER) == []


def test_restore_comfy_nullable_fields_preserves_author_and_is_repeatable(isolated_db):
    data = envelope(generation(job_id=None, generator="comfy", creator_uid="original-author",
                               project_id="original-project", folder_path="seq/shot"))
    assert keeps.restore_keep(data, {AUTHOR}) == {"id_map": {"g1": "g1"}, "rejected": [], "restored": 1}
    assert keeps.restore_keep(data, {AUTHOR})["restored"] == 0
    with db.get_connection() as conn:
        row = conn.execute("SELECT * FROM generation WHERE id='g1'").fetchone()
        assert row["creator_uid"] == "original-author"
        assert row["generator"] == "comfy" and row["job_id"] is None
        assert row["display_prompt"] is None and row["params"] is None
        assert row["project_id"] == "original-project" and row["folder_path"] == "seq/shot"
        assert row["origin"] == "synced" and row["sort_ts"] == 1790812800
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 1


def test_job_match_uses_only_unique_done_result_and_preserves_scene_aliases(isolated_db):
    insert_existing("failed", job="job-g1", status="failed")
    insert_existing("no-result", job="job-g1", asset=False)
    insert_existing("canonical", job="job-g1")
    data = envelope(generation(scene_ids=["g1", "job-g1"]))
    result = keeps.restore_keep(data, {AUTHOR})
    assert result == {"id_map": {"g1": "canonical", "job-g1": "canonical"}, "rejected": [], "restored": 0}
    insert_existing("ambiguous", job="job-g1")
    assert keeps.restore_keep(data, {AUTHOR}) == {"id_map": {}, "rejected": ["g1", "job-g1"], "restored": 0}


@pytest.mark.parametrize("job,status,asset", [("other-job", "done", True), (None, "failed", True),
                                              (None, "pending", True), (None, "done", False)])
def test_same_id_conflict_is_rejected_without_changing_existing_row(isolated_db, job, status, asset):
    insert_existing("g1", job=job, status=status, asset=asset)
    result = keeps.restore_keep(envelope(generation(job_id=None)), {AUTHOR})
    assert result == {"id_map": {}, "rejected": ["g1"], "restored": 0}
    with db.get_connection() as conn:
        assert conn.execute("SELECT prompt FROM generation WHERE id='g1'").fetchone()[0] == "existing"


@pytest.mark.parametrize("by_job", [False, True])
def test_trash_tombstone_wins_over_matching_live_result(isolated_db, by_job):
    insert_existing("live", job="job-g1")
    with db.get_connection() as conn:
        keeps.attach_trash(conn)
        conn.execute("INSERT INTO trash.trashed(id,trashed_at,job_id,payload) VALUES(?,?,?,'{}')",
                     ("old" if by_job else "g1", "2026-10-01", "job-g1" if by_job else None))
        conn.commit()
        keeps.detach_trash(conn)
    data = envelope(generation(job_id="job-g1" if by_job else None))
    assert keeps.restore_keep(data, {AUTHOR})["rejected"] == ["g1"]


def test_delete_transfer_marker_prevents_no_job_result_resurrection(isolated_db, monkeypatch):
    with db.get_connection() as conn:
        conn.execute("CREATE TABLE generation_transfer(generation_id TEXT,job_id TEXT,direction TEXT)")
        conn.execute("INSERT INTO generation_transfer VALUES('g1',NULL,'delete')")
    monkeypatch.setattr(keeps, "trash_transfer", SimpleNamespace(enabled=lambda conn: True))
    assert keeps.restore_keep(envelope(generation(job_id=None)), {AUTHOR})["rejected"] == ["g1"]


def test_foreign_server_results_stay_remote_but_own_server_comfy_is_restored(isolated_db):
    data = envelope(generation("foreign", source="server", creator_uid="someone-else"),
                    generation("mine", source="server", generator="comfy", job_id=None))
    result = keeps.restore_keep(data, {AUTHOR})
    assert result == {"id_map": {"mine": "mine"}, "rejected": [], "restored": 1}


def test_restore_rolls_back_all_insertions_and_detaches_on_failure(isolated_db, monkeypatch):
    calls = []
    original_attach, original_detach = keeps.attach_trash, keeps.detach_trash

    def attach(conn):
        assert not conn.in_transaction
        calls.append("attach")
        original_attach(conn)

    def detach(conn):
        assert not conn.in_transaction
        calls.append("detach")
        original_detach(conn)

    monkeypatch.setattr(keeps, "attach_trash", attach)
    monkeypatch.setattr(keeps, "detach_trash", detach)
    with db.get_connection() as conn:
        conn.execute("CREATE TRIGGER fail_asset BEFORE INSERT ON asset WHEN NEW.generation_id='bad' "
                     "BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END")
    with pytest.raises(sqlite3.IntegrityError, match="forced insert failure"):
        keeps.restore_keep(envelope(generation("first"), generation("bad")), {AUTHOR})
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == 0
    assert calls == ["attach", "detach"]


def test_invalid_fallback_timestamp_is_rejected_at_save_and_restore(isolated_db):
    invalid = envelope(generation(created_at="not-a-date", sort_ts=None))
    for action in (lambda: keeps.save_keep(OWNER, body(invalid)),
                   lambda: keeps.restore_keep(invalid, {AUTHOR})):
        with pytest.raises(ValueError, match="시각"):
            action()
    assert keeps.list_keeps(OWNER) == []
    # An explicit finite sort timestamp does not require parsing created_at.
    valid = envelope(generation(created_at="legacy-date", sort_ts=1.5))
    keeps.save_keep(OWNER, body(valid))
    assert keeps.restore_keep(valid, {AUTHOR})["restored"] == 1


def test_overwrite_never_reads_the_existing_data_column(isolated_db, monkeypatch):
    saved = keeps.save_keep(OWNER, body())

    @contextmanager
    def no_data_read():
        with db.get_connection() as conn:
            conn.set_authorizer(lambda action, table, column, *_:
                                sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == 'scene_keep' and column == 'data'
                                else sqlite3.SQLITE_OK)
            try:
                yield conn
            finally:
                conn.set_authorizer(None)

    monkeypatch.setattr(keeps, 'get_connection', no_data_read)
    assert keeps.save_keep(OWNER, body())["status"] == "exists"
    assert keeps.save_keep(OWNER, body(overwrite_id=saved["id"], overwrite_revision=1))["status"] == "saved"


@pytest.fixture
def builder(monkeypatch):
    monkeypatch.setattr(routes, "require_agent_account", lambda request: {"email": OWNER, "creator_uid": AUTHOR})
    monkeypatch.setattr(routes, "batch_view_member_projects", lambda *args: set())
    monkeypatch.setattr(routes, "can_view_generation_with_member_projects", lambda req, g, projects: not g.get("hidden"))
    monkeypatch.setattr(routes.repo, "get_generations_with_materials", lambda *args, **kwargs: ({}, {}))
    return SimpleNamespace()


def test_builder_extracts_all_reference_paths_and_preserves_first_seen_order():
    text = json.dumps({"format": "mv-scene", "version": 1, "scene": {"cards": [
        {"genId": "a", "genIds": ["b", "a"], "refs": [{"source_gen_id": "c"}],
         "comfyCfg": {"outputs": [{"saved_generation_id": "d"}]}}, {"genId": "b"}]}})
    assert keeps.scene_generation_ids(text) == ["a", "b", "c", "d"]


def test_builder_counts_unparseable_fallback_timestamp_as_missing(builder, monkeypatch):
    monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: {"items": {
        "bad": generation("bad", created_at="bad-date", sort_ts=None), "good": generation("good")}})
    data, missing = routes.build_envelope(scene("bad", "good"), builder)
    assert missing == 1
    assert [g["id"] for g in data["generations"]] == ["good"]


def test_save_and_delete_cross_real_relay_with_pinned_identity(isolated_db, route_client, monkeypatch):
    from app import deps
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_read_pointer", lambda: {"email": OWNER, "uid": AUTHOR})
    monkeypatch.setattr(routes._proxy, "proxying", lambda: True)
    monkeypatch.setattr(routes._proxy, "base_url", lambda: "https://example.invalid")
    monkeypatch.setattr(routes._proxy, "token", lambda: "pinned-test-token")
    calls = []

    def remote(method, url, **kwargs):
        assert active_account.active_uid() == AUTHOR
        assert active_account.account_key() == OWNER
        assert kwargs["token"] == "pinned-test-token"
        calls.append((method, url, kwargs.get("body")))
        return 200, ({"status": "saved", "id": "a" * 32, "revision": 1, "missing_count": 0}
                     if method == "POST" else {"ok": True})

    monkeypatch.setattr(routes._proxy, "raw_request", remote)
    # TestClient propagates contextvars; replace the fixture's empty-account override.
    headers = {"Host": "127.0.0.1", "X-MVHub-Expect-Account": "acct:" + OWNER}
    submitted = {"name": "Scene", "project_id": "", "scene_text": scene(), "preview": []}
    with active_account.pinned_account_scope((OWNER, AUTHOR)):
        result = route_client.post("/api/scene-keeps", headers=headers, json=submitted)
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "saved"
    assert calls[0][2]["expect_account"] == OWNER
    assert calls[0][2]["data"]["scene_text"] == submitted["scene_text"]
    with active_account.pinned_account_scope((OWNER, AUTHOR)):
        deleted = route_client.delete("/api/scene-keeps/" + "a" * 32 + "?revision=1", headers=headers)
    assert deleted.status_code == 200 and deleted.json() == {"ok": True}
    assert calls[1][:2] == ("DELETE", "https://example.invalid/api/scene-keeps/" + "a" * 32 + "?revision=1")
    assert keeps.list_keeps(OWNER) == []


def test_builder_chunks_500_counts_hidden_unavailable_and_excess(builder, monkeypatch):
    seen = []

    def remote(method, path, *, body, timeout):
        seen.append(body["gen_ids"])
        assert 0 < timeout <= 60
        return {"items": {}, "missing": body["gen_ids"][:1], "unavailable": body["gen_ids"][1:]}

    monkeypatch.setattr(routes._proxy, "proxy_json", remote)
    data, missing = routes.build_envelope(scene(*(f"g{i}" for i in range(2003))), builder)
    assert list(map(len, seen)) == [500, 500, 500, 500]
    assert missing == 2003 and data["generations"] == []


def test_builder_alias_mapping_nullable_comfy_and_bad_item_does_not_drop_later_item(builder, monkeypatch):
    canonical = generation("canonical", generator="comfy", job_id=None)
    canonical["assets"][0].update(file_path="/media/local.png", source_url="https://example.test/original.png",
                                  thumbnail_path="C:/thumb.png")
    answer = {"alias": canonical, "canonical": canonical,
              "oversize": generation("oversize", prompt="x" * 20001), "good": generation("good")}
    monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: {"items": answer})
    data, missing = routes.build_envelope(scene("alias", "canonical", "oversize", "good"), builder)
    assert missing == 1
    assert [g["id"] for g in data["generations"]] == ["canonical", "good"]
    item = data["generations"][0]
    assert item["scene_ids"] == ["alias", "canonical"]
    assert item["source"] == "server" and item["generator"] == "comfy" and item["params"] is None
    assert item["assets"][0] == {"type": "image", "file_path": "https://example.test/original.png", "thumbnail_path": None}


def test_partial_size_cap_is_deterministic_under_reordered_batch(builder, monkeypatch):
    ids = ["third", "first", "second"]
    answers = {gid: generation(gid) for gid in ids}
    base = {"v": 1, "scene_text": scene(*ids), "generations": [keeps.pack_generation(answers[ids[0]], "server", ids[0])]}
    monkeypatch.setattr(keeps, "DATA_MAX", len(keeps.encoded(base)))
    outcomes = []
    for order in (ids, list(reversed(ids))):
        monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: {"items": {key: answers[key] for key in order}})
        data, missing = routes.build_envelope(scene(*ids), builder)
        outcomes.append((keeps.encoded(data), missing))
        assert [g["id"] for g in data["generations"]] == ["third"] and missing == 2
    assert outcomes[0] == outcomes[1]


def test_total_remote_deadline_does_not_restart_each_chunk(builder, monkeypatch):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(routes.time, "monotonic", lambda: clock[0])

    def remote(*args, **kwargs):
        calls.append(kwargs["timeout"])
        clock[0] = 61.0
        raise HTTPException(503, "unavailable")

    monkeypatch.setattr(routes._proxy, "proxy_json", remote)
    assert routes.build_envelope(scene(*(f"g{i}" for i in range(1001))), builder)[1] == 1001
    assert calls == [60.0]


@pytest.fixture
def route_client(monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(routes, "_viewer", lambda request: (request.headers.get("X-Test-Owner", OWNER), "", AUTHOR, False))
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client


def test_server_routes_owner_revision_account_and_restore_boundaries(isolated_db, route_client):
    client = route_client
    for expected in ("", OTHER):
        assert client.post("/api/scene-keeps", json=body(expect_account=expected)).status_code == 409
    first = client.post("/api/scene-keeps", json=body()).json()
    path = "/api/scene-keeps/" + first["id"]
    assert client.get(path, headers={"X-Test-Owner": OTHER}).status_code == 404
    assert client.get(path + "/envelope?revision=1", headers={"X-Test-Owner": OTHER}).status_code == 404
    assert client.delete(path + "?revision=1", headers={"X-Test-Owner": OTHER}).status_code == 404
    assert client.get(path + "/envelope?revision=2").status_code == 409
    assert client.get(path + "/envelope?revision=1").json()["generations"]
    assert OWNER not in client.get(path).text
    assert client.post("/api/scene-keeps/restore", json={"id": first["id"], "revision": 1}).status_code == 409


def test_hub_envelope_is_not_exposed_and_restore_never_accepts_client_data(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    assert route_client.get("/api/scene-keeps/" + "a" * 32 + "/envelope?revision=1").status_code == 404
    assert route_client.post("/api/scene-keeps/restore", json={"id": "a" * 32, "revision": 1,
                                                             "data": envelope(generation())}).status_code == 422


def test_local_restore_downloads_valid_envelope_and_returns_only_public_result(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)

    @contextmanager
    def relay(request, *, write):
        yield OWNER

    monkeypatch.setattr(routes, "_relay", relay)
    monkeypatch.setattr(routes, "require_agent_account", lambda request: {"email": OWNER})
    monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: envelope(generation()))
    result = route_client.post("/api/scene-keeps/restore", json={"id": "a" * 32, "revision": 1})
    assert result.status_code == 200
    assert result.json() == {"id_map": {"g1": "g1"}, "rejected": [], "restored": 1}
    assert OWNER not in result.text


def test_malformed_download_is_refused_before_transaction(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)

    @contextmanager
    def relay(request, *, write):
        yield OWNER

    data = envelope(generation())
    data["generations"][0]["assets"][0]["thumbnail_path"] = "http://example.test/no-tls.png"
    monkeypatch.setattr(routes, "_relay", relay)
    monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: data)
    entered = []
    monkeypatch.setattr(keeps, "attach_trash", lambda conn: entered.append(True))
    result = route_client.post("/api/scene-keeps/restore", json={"id": "a" * 32, "revision": 1})
    assert result.status_code == 400 and entered == []
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0


def test_restore_fetches_exact_revision_and_does_not_write_after_remote_conflict(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    calls = []

    @contextmanager
    def relay(request, *, write):
        assert write
        yield OWNER

    def proxy(method, path, **kwargs):
        calls.append((method, path, kwargs))
        raise HTTPException(409, "보관본이 바뀌었습니다")

    monkeypatch.setattr(routes, "_relay", relay)
    monkeypatch.setattr(routes._proxy, "proxy_json", proxy)
    response = route_client.post("/api/scene-keeps/restore", json={"id": "a" * 32, "revision": 7})
    assert response.status_code == 409
    assert calls == [("GET", "/api/scene-keeps/" + "a" * 32 + "/envelope", {"params": {"revision": 7}})]
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0


def test_existing_schema_stays_compatible_without_new_migration_name(isolated_db):
    from app import schema_compat
    with db.get_connection() as conn:
        before = list(conn.execute("SELECT migration_id FROM schema_migrations ORDER BY migration_id"))
        conn.execute("DROP TABLE scene_keep")
        db_migrations._migrate(conn)
        after = list(conn.execute("SELECT migration_id FROM schema_migrations ORDER BY migration_id"))
        assert [tuple(r) for r in before] == [tuple(r) for r in after]
        assert schema_compat.inspect_schema(conn, "content").status == "compatible"


def test_real_batch_query_keeps_comfy_generator_and_requested_aliases(isolated_db):
    from app.models import GenerationOut
    keeps.restore_keep(envelope(generation("canonical", generator="comfy", job_id="anchor")), {AUTHOR})
    items, _ = routes.repo.get_generations_with_materials(["canonical", "anchor"])
    assert items["anchor"]["id"] == "canonical"
    assert items["canonical"]["generator"] == "comfy"
    assert GenerationOut(**items["anchor"]).model_dump()["generator"] == "comfy"


def test_builder_omits_forbidden_rows_and_does_not_hold_database_connection_for_network(isolated_db, builder, monkeypatch):
    from app.repo import generations_query
    active_connections = []
    original_connection = generations_query.get_connection

    @contextmanager
    def observed_connection():
        active_connections.append(True)
        try:
            with original_connection() as conn:
                yield conn
        finally:
            active_connections.pop()

    monkeypatch.setattr(generations_query, "get_connection", observed_connection)
    monkeypatch.setattr(routes.repo, "get_generations_with_materials", generations_query.get_generations_with_materials)
    keeps.restore_keep(envelope(generation("visible"), generation("hidden")), {AUTHOR})
    monkeypatch.setattr(routes, "can_view_generation_with_member_projects", lambda req, g, projects: g["id"] != "hidden")

    def remote(*args, **kwargs):
        assert active_connections == []
        assert kwargs["body"]["gen_ids"] == ["hidden", "absent"]
        return {"items": {}, "missing": ["hidden"], "unavailable": ["absent"]}

    monkeypatch.setattr(routes._proxy, "proxy_json", remote)
    data, missing = routes.build_envelope(scene("visible", "hidden", "absent"), builder)
    assert missing == 2 and [g["id"] for g in data["generations"]] == ["visible"]


def test_account_epoch_changes_prevent_save_and_restore_writes(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    epoch = [1]
    monkeypatch.setattr(active_account, "account_epoch", lambda: epoch[0])

    @contextmanager
    def relay(request, *, write):
        yield OWNER

    def build(*args):
        epoch[0] += 1
        return envelope(generation()), 0

    monkeypatch.setattr(routes, "_relay", relay)
    monkeypatch.setattr(routes, "build_envelope", build)
    calls = []
    monkeypatch.setattr(routes._proxy, "proxy_json", lambda *a, **kw: calls.append((a, kw)))
    assert route_client.post("/api/scene-keeps", json=body(scene_text=scene("g1"))).status_code == 409
    assert calls == []

    def fetch(*args, **kwargs):
        epoch[0] += 1
        return envelope(generation())

    monkeypatch.setattr(routes._proxy, "proxy_json", fetch)
    response = route_client.post("/api/scene-keeps/restore", json={"id": "a" * 32, "revision": 1})
    assert response.status_code == 409
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == 0


def test_hub_save_rebuilds_untrusted_envelope_and_never_saves_a_local_copy(isolated_db, route_client, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", False)

    @contextmanager
    def relay(request, *, write):
        yield OWNER

    trusted = envelope(generation("trusted"))
    monkeypatch.setattr(routes, "_relay", relay)
    monkeypatch.setattr(routes, "build_envelope", lambda text, request: (trusted, 3))
    calls = []

    def proxy(method, path, **kwargs):
        calls.append(kwargs["body"])
        return {"status": "saved", "id": "a" * 32, "revision": 1, "missing_count": 3}

    monkeypatch.setattr(routes._proxy, "proxy_json", proxy)
    submitted = body(envelope(generation("forged")), scene_text=scene("trusted"),
                     expect_account=OTHER, missing_count=200, node_count=999)
    assert route_client.post("/api/scene-keeps", json=submitted).status_code == 200
    assert calls[0]["data"] == trusted and calls[0]["missing_count"] == 3
    assert calls[0]["expect_account"] == OWNER and "node_count" not in calls[0]
    assert keeps.list_keeps(OWNER) == []


def test_local_relay_refuses_wrong_or_missing_account_and_disconnected_hub(route_client, monkeypatch):
    from app.routers import edit_shares
    monkeypatch.setattr(config, "AUTH_ENABLED", False)

    @contextmanager
    def pin():
        yield OWNER

    monkeypatch.setattr(active_account, "pinned_account_scope", pin)
    monkeypatch.setattr(edit_shares, "expected_account_differs", lambda request, owner: request.headers.get("X-MVHub-Expect-Account") != owner)
    monkeypatch.setattr(routes._proxy, "proxying", lambda: False)
    for headers in ({}, {"X-MVHub-Expect-Account": OTHER}, {"X-MVHub-Expect-Account": OWNER}):
        assert route_client.get("/api/scene-keeps", headers=headers).status_code == 409


def test_feature_flag_is_only_on_local_hub_and_existing_flags_are_preserved(monkeypatch):
    from app.routers import auth
    monkeypatch.setattr(auth.repo, "count_accounts", lambda: 0)
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    server_flags = auth.auth_config()["features"]
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    local_flags = auth.auth_config()["features"]
    assert "scene_keep_v1" not in server_flags
    assert local_flags == server_flags + ["scene_keep_v1"]


def test_only_successful_restore_notifies_library():
    from app.mutation_notify import notification_domains
    assert notification_domains("POST", "/api/scene-keeps/restore", 200) == ("library",)
    assert notification_domains("POST", "/api/scene-keeps/restore", 409) == ()
    for method, path in (("POST", "/api/scene-keeps"), ("DELETE", "/api/scene-keeps/abc"),
                         ("GET", "/api/scene-keeps"), ("GET", "/api/scene-keeps/abc/envelope")):
        assert notification_domains(method, path, 200) == ()


@pytest.mark.parametrize("prompt_chars", [20000, 32], ids=["eight-mib-cap", "two-thousand-results"])
def test_scale_real_limits_build_and_repeat_restore(isolated_db, builder, monkeypatch, prompt_chars):
    """Measure real caps without asserting machine-dependent time or memory limits.

    The remote batch is in-process. The measured peak covers building, serialization,
    first restore and repeat restore, but excludes database fixture initialization.
    """
    assert keeps.GEN_MAX == 2000 and keeps.DATA_MAX == 8 * 1024 * 1024
    requested_batches = []

    def make_item(gid):
        return generation(gid, prompt=(gid + ":").ljust(prompt_chars, "x"))

    def remote(method, path, *, body, timeout):
        assert method == "POST" and path == "/api/generations/batch"
        assert len(body["gen_ids"]) <= 500
        requested_batches.append(len(body["gen_ids"]))
        # Each row owns its full prompt; a shared string would undercount memory.
        return {"items": {gid: make_item(gid) for gid in reversed(body["gen_ids"])}}

    monkeypatch.setattr(routes._proxy, "proxy_json", remote)
    tracemalloc.start()
    try:
        started = time.perf_counter()
        ids = [f"scale-{index:04d}" for index in range(2000)]
        data, missing = routes.build_envelope(scene(*ids), builder)
        built = time.perf_counter()
        raw = keeps.encoded(data)
        serialized_bytes = len(raw.encode("ascii"))
        admitted = len(data["generations"])
        assert serialized_bytes <= keeps.DATA_MAX
        assert missing == len(ids) - admitted
        assert [item["id"] for item in data["generations"]] == ids[:admitted]
        if prompt_chars == 20000:
            assert 0 < admitted < 500 and requested_batches == [500]
            next_item = keeps.pack_generation(make_item(ids[admitted]), "server", ids[admitted])
            assert len(keeps.encoded({**data, "generations": [*data["generations"], next_item]})) > keeps.DATA_MAX
        else:
            assert admitted == 2000 and missing == 0 and requested_batches == [500] * 4
        checked = time.perf_counter()
        first = keeps.restore_keep(data, {AUTHOR})
        restored_once = time.perf_counter()
        repeat = keeps.restore_keep(data, {AUTHOR})
        finished = time.perf_counter()
        assert first["restored"] == admitted and first["rejected"] == []
        assert first["id_map"] == {gid: gid for gid in ids[:admitted]}
        assert repeat == {**first, "restored": 0}
        with db.get_connection() as conn:
            assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == admitted
            assert conn.execute("SELECT COUNT(*) FROM asset").fetchone()[0] == admitted
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    print(json.dumps({"scale_prompt_chars": prompt_chars, "admitted": admitted, "missing": missing,
                      "serialized_bytes": serialized_bytes, "batch_sizes": requested_batches,
                      "build_seconds": round(built - started, 4),
                      "serialize_check_seconds": round(checked - built, 4),
                      "restore_seconds": round(restored_once - checked, 4),
                      "repeat_restore_seconds": round(finished - restored_once, 4),
                      "total_seconds": round(finished - started, 4), "tracemalloc_peak_bytes": peak}))
