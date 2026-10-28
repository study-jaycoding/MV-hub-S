"""MCP update app boundaries. No live source, profile, or installation is used."""
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import config, db, deps, repo
from app.routers import mcp, mcp_adapter, mcp_v2
from app.services import mcp_update as service


DIGEST = "a" * 64
HEADERS = {"X-MVHub-Tab": "t" * 40}


def test_legacy_install_requires_initial_core_update(tmp_path):
    with pytest.raises(service.McpUpdateError, match="본체를 먼저"):
        service.installed(tmp_path)


def test_corrupt_installed_updater_is_reported_without_importing_adapter(tmp_path):
    bundle = tmp_path / "tools" / "mcp_adapter"
    bundle.mkdir(parents=True)
    (bundle / "update.py").write_text("syntax error!", encoding="utf-8")
    (bundle / "server.py").write_text("raise RuntimeError('must not import SDK')", encoding="utf-8")
    with pytest.raises(service.McpUpdateError, match="도구를 읽지 못했습니다"):
        service.installed(tmp_path)


@pytest.fixture
def core(tmp_path, monkeypatch):
    class Error(ValueError):
        pass
    class NotPublished(Error):
        pass
    selected = {"version": "2026.10.27.1", "bundle_version": "2026.10.27.1", "source": "bundle", "reason": "",
                "manifest_sha256": None, "rollback_available": False}
    module = SimpleNamespace(Error=Error, NotPublished=NotPublished, selection=Mock(return_value=selected), compatibility=Mock(return_value=""),
        source_overview=Mock(return_value={"manifest": {"version": "2026.10.27.1", "commit": "b" * 40}, "manifest_sha256": DIGEST}),
        install=Mock(return_value={**selected, "source": "downloaded", "manifest_sha256": DIGEST,
                                  "settings_preserved": True, "reload_required": True}),
        rollback_install=Mock(return_value={**selected, "settings_preserved": True, "reload_required": True}))
    monkeypatch.setattr(service, "_core", lambda root: module)
    monkeypatch.setattr(service.release_update, "install_source", lambda root: str(tmp_path / "source"))
    monkeypatch.setattr(service.release_update, "update_in_progress", lambda root: False)
    monkeypatch.setattr(service, "_operation", threading.Lock())
    return module


def test_status_uses_digest_not_version_label_and_hides_local_paths(core, tmp_path):
    result = service.status(tmp_path)
    assert result["available"] and result["compatible"] and result["checked"]
    assert result["published"]["manifest_sha256"] == DIGEST
    assert "path" not in result and str(tmp_path) not in str(result)
    core.selection.return_value["manifest_sha256"] = DIGEST
    assert not service.status(tmp_path)["available"]
    core.compatibility.return_value = "본체 업데이트 필요"
    result = service.status(tmp_path)
    assert not result["available"] and not result["compatible"]
    assert result["note"] == "본체 업데이트 필요"


def test_unreadable_source_is_not_reported_as_latest(core, tmp_path):
    core.source_overview.side_effect = OSError("private source credentials")
    result = service.status(tmp_path)
    assert not result["checked"] and not result["available"]
    assert result["published"] is None
    assert "private" not in result["note"]


def test_missing_publication_is_distinct_from_unreadable_source(core, tmp_path):
    core.source_overview.side_effect = core.NotPublished()
    result = service.status(tmp_path)
    assert result["checked"] and not result["available"] and result["published"] is None
    assert result["note"] == "아직 배포된 MCP 버전이 없습니다."


def test_apply_passes_frozen_identity_and_releases_lock_after_failure(core, tmp_path):
    core.install.side_effect = core.Error("게시 버전이 변경되었습니다.")
    with pytest.raises(service.McpUpdateError, match="게시 버전"):
        service.apply(tmp_path, DIGEST)
    assert not service._operation.locked()
    core.install.assert_called_once_with(tmp_path, str(tmp_path / "source"), DIGEST)
    core.install.side_effect = None
    result = service.apply(tmp_path, DIGEST)
    assert result["reload_required"] and result["settings_preserved"]
    service.apply(tmp_path, DIGEST, rollback=True)
    core.rollback_install.assert_called_once_with(tmp_path, DIGEST)


def test_busy_blocks_mutation_and_core_calls(core, tmp_path, monkeypatch):
    with service._operation:
        with pytest.raises(service.McpUpdateError, match="다른 MCP"):
            service.apply(tmp_path, DIGEST)
    monkeypatch.setattr(service.release_update, "update_in_progress", lambda root: True)
    with pytest.raises(service.McpUpdateError, match="본체"):
        service.apply(tmp_path, DIGEST)
    core.install.assert_not_called()
    core.source_overview.assert_not_called()


@pytest.fixture
def client(tmp_path, monkeypatch, core):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "hub.db"))
    db.flush_pool()
    db.init_db()
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    account = repo.register("mcp-update@example.test", "testpass")
    monkeypatch.setattr(mcp, "_ROOT", tmp_path)
    app = FastAPI()
    @app.middleware("http")
    async def session(request, call_next):
        request.state.account = repo.get_account(account["email"]) if request.headers.get("X-Test-Login") == "yes" else None
        return await call_next(request)
    app.include_router(mcp.router)
    app.include_router(mcp_adapter.router)
    with TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50201)) as connection:
        yield connection
    db.flush_pool()


def test_routes_require_tab_and_approved_account(client, core):
    assert client.get("/api/mcp/app/adapter", headers=HEADERS).status_code == 403
    assert client.get("/api/mcp/app/adapter", headers={"X-Test-Login": "yes"}).status_code == 403
    core.source_overview.assert_not_called()
    response = client.get("/api/mcp/app/adapter", headers={**HEADERS, "X-Test-Login": "yes"})
    assert response.status_code == 200, response.text
    assert response.json()["available"]


def test_routes_reject_external_browser_and_bad_manifest(client, core):
    headers = {**HEADERS, "X-Test-Login": "yes"}
    assert client.get("/api/mcp/app/adapter", headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    response = client.post("/api/mcp/app/adapter/update", headers=headers, json={"expected_manifest_sha256": "../other"})
    assert response.status_code == 422
    assert client.post("/api/mcp/app/adapter/rollback", headers=headers, json={}).status_code == 422
    core.install.assert_not_called()
    core.rollback_install.assert_not_called()


def test_routes_freeze_apply_and_rollback_ids(client, core):
    headers = {**HEADERS, "X-Test-Login": "yes"}
    for action in ("update", "rollback"):
        response = client.post("/api/mcp/app/adapter/" + action, headers=headers, json={"expected_manifest_sha256": DIGEST})
        assert response.status_code == 200, response.text
        assert response.json()["reload_required"]
    assert core.install.call_args.args[-1] == DIGEST
    assert core.rollback_install.call_args.args[-1] == DIGEST


def test_changed_account_stops_update_before_mutation(client, core, monkeypatch):
    monkeypatch.setattr(mcp_v2, "_still_current", Mock(side_effect=HTTPException(403, "계정 변경")))
    response = client.post("/api/mcp/app/adapter/update", headers={**HEADERS, "X-Test-Login": "yes"},
                           json={"expected_manifest_sha256": DIGEST})
    assert response.status_code == 403
    core.install.assert_not_called()


def test_real_core_publishes_installs_rolls_back_and_preserves_profiles(tmp_path, monkeypatch):
    root, source = tmp_path / "install", tmp_path / "release"
    bundle = root / "tools" / "mcp_adapter"
    bundle.mkdir(parents=True)
    local = tmp_path / "local"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setattr(service.release_update, "UPDATE_STATE_BASE", tmp_path / "update-state")
    original = Path(__file__).resolve().parents[2] / "tools" / "mcp_adapter" / "update.py"
    (bundle / "update.py").write_bytes(original.read_bytes())
    (bundle / "local_setup.py").write_bytes(b"# unchanged profile implementation\n")
    (bundle / "requirements.lock.txt").write_bytes(b"# unchanged dependencies\n")
    def payload(version):
        return f'MCP_UPDATE_API = 1\n_MCP_BUNDLE = None\nADAPTER_VERSION = "{version}"\nHUB_FEATURES = {{"generation_result"}}\n'.encode()
    (bundle / "server.py").write_bytes(payload("2026.10.27.1"))
    (root / "VERSION.txt").write_text("test-install", encoding="utf-8")
    (root / "INSTALL_SOURCE.txt").write_text(str(source), encoding="utf-8")
    profile = local / "MVHub-MCP" / "profiles" / "existing.bin"
    profile.parent.mkdir(parents=True)
    profile.write_bytes(b"opaque encrypted profile")
    real = service._core(root)
    baseline = {name: (bundle / name).read_bytes() for name in real.BASELINE}
    assert service.status(root)["note"] == "아직 배포된 MCP 버전이 없습니다."
    def publish(commit, version):
        raw = payload(version)
        manifest = real.build_manifest(commit * 40, raw, baseline)
        base = source / "mcp"
        real.publish(base, manifest, {"server.py": raw}, real.pointer_token(base))
        return real.manifest_digest(manifest)
    first = publish("a", "2026.10.27.2")
    overview = service.status(root)
    assert overview["available"] and overview["published"]["manifest_sha256"] == first
    installed = service.apply(root, first)
    assert installed["selected_version"] == "2026.10.27.2" and installed["reload_required"]
    assert not service.status(root)["available"]
    assert installed["rollback_available"]
    bundled = service.apply(root, first, rollback=True)
    assert bundled["source"] == "bundle" and bundled["selected_version"] == "2026.10.27.1"
    service.apply(root, first)
    second = publish("b", "2026.10.27.3")
    with pytest.raises(service.McpUpdateError, match="변경"):
        service.apply(root, first)
    assert service.installed(root)["selected_version"] == "2026.10.27.2"
    service.apply(root, second)
    assert service.installed(root)["rollback_available"]
    rolled_back = service.apply(root, second, rollback=True)
    assert rolled_back["selected_version"] == "2026.10.27.2"
    assert rolled_back["settings_preserved"] and profile.read_bytes() == b"opaque encrypted profile"
    assert (bundle / "server.py").read_bytes() == payload("2026.10.27.1")
    with real.exclusive_lock(root / ".update.lock"):
        assert service.release_update._updater_lock_held(root)
        with pytest.raises(service.McpUpdateError, match="업데이트"):
            service.apply(root, second)
