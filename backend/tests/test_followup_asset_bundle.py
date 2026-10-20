import hashlib
import json
import zipfile

import pytest

from app.services import asset_bundle
from test_asset_sync import storage


@pytest.fixture(autouse=True)
def isolated_bundle_temp(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_bundle.tempfile, "tempdir", str(tmp_path))


def record(path, **extra):
    return {"id": "same/name", "type": "image",
            "asset_content_id": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(), **extra}


def test_bundle_copies_exact_inputs_and_safe_manifest(tmp_path):
    output = tmp_path / "out.png"
    source = tmp_path / "input.png"
    output.write_bytes(b"result")
    source.write_bytes(b"submitted")
    generation = {
        "id": "g", "prompt": "the prompt", "model": "model",
        "params": {"seed": 12, "apiKey": "do-not-export", "nested": {"source": "https://host.invalid/a?secret=x", "file": r"C:\private\file"}},
        "assets": [record(output)],
        "references": [record(source, role="first", position=2), record(source, role="last", position=3)],
    }
    path = asset_bundle.build_bundle(generation, lambda row, cid: output if row in generation["assets"] else source)
    try:
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            assert manifest["complete"] is True
            assert [r["position"] for r in manifest["references"]] == [2, 3]
            assert len(set(archive.namelist())) == 4
            assert archive.read(manifest["references"][0]["path"]) == b"submitted"
            assert all(".." not in name and not name.startswith("/") for name in archive.namelist())
            text = json.dumps(manifest)
            assert "do-not-export" not in text and "secret=x" not in text and "private" not in text
    finally:
        path.unlink()


def test_missing_and_changed_input_fail_unless_explicitly_incomplete(tmp_path):
    source = tmp_path / "old.png"
    source.write_bytes(b"old version")
    original = record(source, role="reference", position=0)
    source.write_bytes(b"latest version")
    generation = {"assets": [], "references": [original]}
    with pytest.raises(asset_bundle.IncompleteBundle) as caught:
        asset_bundle.build_bundle(generation, lambda row, cid: source)
    assert caught.value.missing[0]["reason"] == "asset_content_changed"
    path = asset_bundle.build_bundle(generation, lambda row, cid: source, allow_incomplete=True)
    try:
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            assert not manifest["complete"]
            assert archive.namelist() == ["manifest.json"]
    finally:
        path.unlink()


def test_unverified_input_never_uses_current_file(tmp_path):
    calls = []
    with pytest.raises(asset_bundle.IncompleteBundle):
        asset_bundle.build_bundle({"references": [{"file_path": "current.png"}]},
                                  lambda *args: calls.append(args))
    assert calls == []


@pytest.mark.parametrize("changed", [False, True])
def test_snapshot_closes_and_leaves_no_named_residue(tmp_path, monkeypatch, changed):
    source = tmp_path / "source.png"
    source.write_bytes(b"submitted")
    generation = {"assets": [record(source)]}
    if changed:
        source.write_bytes(b"changed")
    snapshots = []
    create = asset_bundle.tempfile.TemporaryFile
    def track_snapshot(*args, **kwargs):
        handle = create(*args, **kwargs)
        snapshots.append(handle)
        return handle
    monkeypatch.setattr(asset_bundle.tempfile, "TemporaryFile", track_snapshot)
    if changed:
        with pytest.raises(asset_bundle.IncompleteBundle):
            asset_bundle.build_bundle(generation, lambda row, cid: source)
    else:
        archive = asset_bundle.build_bundle(generation, lambda row, cid: source)
        archive.unlink()
    assert snapshots and all(handle.closed for handle in snapshots)
    assert list(tmp_path.iterdir()) == [source]


def test_bundle_endpoint_uses_generation_permission_and_cleans_archive(storage, monkeypatch):
    import io
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import deps
    from app.repo import asset_sync as ledger
    from app.routers import asset_sync as api
    conn, base = storage
    path = base / "result.png"
    path.write_bytes(b"generation result")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    ledger.register_local(conn, path=path, file_path="asset:imports|result.png",
                          digest=digest, size=path.stat().st_size, media_type="image", owner_uid="owner")
    conn.execute("INSERT INTO worker(id,name) VALUES('worker','Worker')")
    conn.execute("INSERT INTO generation(id,worker_id,prompt,status,creator_uid) VALUES('g','worker','prompt','done','owner')")
    conn.execute("INSERT INTO asset(id,generation_id,type,file_path,asset_content_id) VALUES('a','g','image','asset:imports|result.png',?)",
                 ("sha256:" + digest,))
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(api._proxy, "proxying", lambda: False)
    archives = []
    build = asset_bundle.build_bundle
    def track_archive(*args, **kwargs):
        path = build(*args, **kwargs)
        archives.append(path)
        return path
    monkeypatch.setattr(asset_bundle, "build_bundle", track_archive)
    app = FastAPI()
    actor = ["other"]
    @app.middleware("http")
    async def account(request, call_next):
        request.state.account = {"creator_uid": actor[0], "global_role": "member"}
        return await call_next(request)
    app.include_router(api.local_router)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000)) as client:
        assert client.get("/api/local-asset-sync/generations/g/bundle").status_code == 404
        actor[0] = "owner"
        result = client.get("/api/local-asset-sync/generations/g/bundle")
        assert result.status_code == 200, result.text
        with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            assert archive.read(manifest["outputs"][0]["path"]) == path.read_bytes()
        assert archives and all(not item.exists() for item in archives)
