"""No installer/server invocation: temporary ZIPs and the publication contract only."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import zipfile

import pytest

from app.services import release_contract as c, release_update as update
from release_contract_fixture import qualified_package


def load_cli():
    module_path = Path(__file__).resolve().parents[2] / "tools" / "release_contract.py"
    spec = importlib.util.spec_from_file_location("release_contract_cli", module_path)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    return cli


def fixture(tmp_path, rollout="bridge"):
    root, folder = tmp_path / "installed", tmp_path / "packages"
    root.mkdir()
    folder.mkdir()
    (root / "INSTALL_SOURCE.txt").write_text(str(folder), encoding="utf-8")
    value, raw = qualified_package(folder, "2026.10.18-1200", rollout=rollout)
    (folder / "candidate.json").write_bytes(raw)
    return root, folder, value, raw


def receipt(folder, value):
    return folder / value["contract"]["validation_receipt"]["file"]


def test_descriptor_is_non_circular_and_payload_is_verified(tmp_path):
    _, folder, value, _ = fixture(tmp_path)
    descriptor = c.verify_artifact(folder / value["file"], value, receipt(folder, value).read_bytes())
    assert "sha256" not in descriptor and "artifact_sha256" not in descriptor
    assert c.DESCRIPTOR not in {row["path"] for row in descriptor["payload"]}
    with zipfile.ZipFile(folder / value["file"], "a") as archive:
        archive.writestr("extra.txt", "tamper")
    with pytest.raises(c.ContractError, match="artifact digest"):
        c.verify_artifact(folder / value["file"], value, receipt(folder, value).read_bytes())


def test_pending_install_journal_prevents_same_version_health_shortcut(tmp_path, monkeypatch):
    (tmp_path / 'update-journal.json').write_text('{"format_version":1,"phase":"starting"}')
    monkeypatch.setattr(update.subprocess, 'run', lambda *a, **k: pytest.fail('runtime must not run before journal check'))
    assert update._unfinished_install(tmp_path)
    assert update._installation_health(tmp_path)[0] is False
    (tmp_path / 'update-journal.json').write_text('{"format_version":1,"phase":"committed"}')
    assert not update._unfinished_install(tmp_path)


def test_backend_rejects_legacy_downgrade_before_launching_installed_updater(tmp_path):
    (tmp_path / 'build-manifest.json').write_text('{}')
    with pytest.raises(update.ReleaseUpdateError, match='descriptor downgrade'):
        update._check_update_contract({'version': 'old'}, tmp_path, candidate_mode=True)


@pytest.mark.parametrize("damage", ["self", "unlisted", "duplicate", "wrong-version", "payload-hash"])
def test_descriptor_rejects_malformed_payload_even_if_outer_hash_is_recomputed(tmp_path, damage):
    _, folder, value, _ = fixture(tmp_path)
    package = folder / value["file"]
    with zipfile.ZipFile(package) as archive:
        entries = {info.filename: archive.read(info) for info in archive.infolist()}
    descriptor = c.document(entries[c.DESCRIPTOR])
    if damage == "self":
        descriptor["payload"].append({"path": c.DESCRIPTOR, "size": 1, "sha256": "a" * 64})
    elif damage == "unlisted":
        entries["secret.env"] = b"fixture only"
    elif damage == "duplicate":
        entries["version.TXT"] = entries["VERSION.txt"]
    elif damage == "wrong-version":
        descriptor["version"] = "different"
    else:
        descriptor["payload"][0]["sha256"] = "a" * 64
    entries[c.DESCRIPTOR] = c.json_bytes(descriptor)
    with zipfile.ZipFile(package, "w") as archive:
        for name, raw in entries.items():
            archive.writestr(name, raw)
    with pytest.raises(c.ContractError):
        c.read_descriptor(package)


@pytest.mark.parametrize("key,bad", [("scope", "source-only"), ("release_eligible", False), ("status", "running"),
                                   ("skips", ["cleanup"]), ("cleanup", {"status": "unknown"}),
                                   ("tool_sha256", {}), ("finished_at", "2026-10-17T00:00:00+00:00")])
def test_incomplete_receipt_never_qualifies(tmp_path, key, bad):
    _, folder, value, _ = fixture(tmp_path)
    data = c.document(receipt(folder, value).read_bytes())
    data[key] = bad
    with pytest.raises(c.ContractError):
        c.validate_receipt(c.json_bytes(data), value)


def test_receipt_cannot_move_to_other_artifact(tmp_path):
    _, folder, value, _ = fixture(tmp_path)
    data = receipt(folder, value).read_bytes()
    value["sha256"] = "f" * 64
    with pytest.raises(c.ContractError, match="artifact mismatch"):
        c.validate_receipt(data, value)


def test_duplicate_json_and_unsafe_receipt_names_rejected(tmp_path):
    with pytest.raises(c.ContractError):
        c.document(b'{"status":"passed","status":"failed"}')
    _, _, value, _ = fixture(tmp_path)
    value["contract"]["validation_receipt"]["file"] = "../private.json"
    with pytest.raises(c.ContractError):
        c.candidate_contract(value)


def test_promote_and_reselect_keep_exact_qualified_bytes(tmp_path):
    root, folder, value, raw = fixture(tmp_path)
    assert update.promote_candidate(value, root)["promoted"]
    assert (folder / "latest.json").read_bytes() == raw
    old, old_raw = qualified_package(folder, "2026.10.17-1200")
    selected = update.deploy_package(old, value["sha256"], value["sha256"], root)
    assert selected["rolled_back"]
    assert (folder / "latest.json").read_bytes() == (folder / "candidate.json").read_bytes() == old_raw


@pytest.mark.parametrize("damage", ["receipt", "candidate", "missing", "stripped"])
def test_publication_rejects_changed_or_missing_evidence_without_writes(tmp_path, damage):
    root, folder, value, raw = fixture(tmp_path)
    if damage == "receipt":
        receipt(folder, value).write_bytes(b"{}")
    elif damage == "candidate":
        (folder / value["file"]).with_suffix(".candidate.json").write_bytes(raw + b" ")
    elif damage == "missing":
        receipt(folder, value).unlink()
    else:
        value.pop("contract")
        (folder / "candidate.json").write_bytes(c.json_bytes(value))
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    with pytest.raises(update.ReleasePromoteError):
        update.promote_candidate(value, root)
    assert {p.name: p.read_bytes() for p in folder.iterdir()} == before


def test_receipt_cas_is_inside_existing_publication_lock(tmp_path, monkeypatch):
    root, folder, value, _ = fixture(tmp_path)
    @contextlib.contextmanager
    def racing_lock(_folder):
        receipt(folder, value).write_bytes(b"{}")
        yield
    monkeypatch.setattr(update, "_release_lock", racing_lock)
    with pytest.raises(update.ReleasePromoteError, match="그새"):
        update.promote_candidate(value, root)
    assert not (folder / "latest.json").exists()


def test_bridge_preinstall_needs_no_final_receipt_but_enforced_needs_installed_capability(tmp_path):
    root, folder, value, _ = fixture(tmp_path)
    value["contract"]["validation_receipt"] = None
    update._check_update_contract(value, root, candidate_mode=True)
    with pytest.raises(update.ReleaseUpdateError, match="qualification"):
        update._check_update_contract(value, root, candidate_mode=False)
    value["contract"]["compatibility"].update(rollout="enforced", required_installer_capabilities=["artifact-receipt-v1"])
    with pytest.raises(update.ReleaseUpdateError, match="bridge"):
        update._check_update_contract(value, root, candidate_mode=True)
    (root / "installer-capabilities.json").write_text('{"format_version":1,"capabilities":["artifact-receipt-v1"]}')
    update._check_update_contract(value, root, candidate_mode=True)


def test_legacy_read_and_admin_preinstall_remain_unverified(tmp_path):
    root, _, value, _ = fixture(tmp_path)
    value.pop("contract")
    assert update._parse_manifest(c.json_bytes(value))["contract_status"] == "legacy-unverified"
    update._check_update_contract(value, root, candidate_mode=True)


def test_qualify_cli_binds_existing_zip_without_rebuild(tmp_path):
    _, folder, value, raw = fixture(tmp_path)
    cli = load_cli()
    package = folder / value["file"]
    before = package.read_bytes()
    package.with_suffix(".candidate.json").unlink()
    value["contract"]["validation_receipt"] = None
    candidate = folder / "candidate.json"
    candidate.write_bytes(c.json_bytes(value))
    final = cli.qualify(candidate, package.with_suffix(".validation.json"))
    assert final.read_bytes() == raw == candidate.read_bytes()
    assert package.read_bytes() == before


def test_source_snapshot_rejects_dirty_or_unpinned_source_and_hashes_bytes(tmp_path, monkeypatch):
    cli = load_cli()
    (tmp_path / "app.py").write_bytes(b"first")
    replies = {("status", "--porcelain", "--untracked-files=normal"): b"", ("rev-parse", "HEAD"): b"a" * 40,
               ("rev-parse", "origin/main"): b"a" * 40, ("rev-parse", "HEAD^{tree}"): b"b" * 40,
               ("ls-files", "-z"): b"app.py\0"}
    monkeypatch.setattr(cli, "git", lambda root, *args: replies[args])
    first = cli.source_identity(tmp_path)
    (tmp_path / "app.py").write_bytes(b"second")
    assert cli.source_identity(tmp_path)["sha256"] != first["sha256"]
    assert str(tmp_path) not in json.dumps(first)
    replies[("rev-parse", "origin/main")] = b"c" * 40
    with pytest.raises(c.ContractError, match="origin/main"):
        cli.source_identity(tmp_path)
    replies[("status", "--porcelain", "--untracked-files=normal")] = b"?? untracked.py"
    with pytest.raises(c.ContractError, match="clean"):
        cli.source_identity(tmp_path)


def test_qualify_failure_preserves_candidate_zip_and_sidecars(tmp_path):
    _, folder, value, _ = fixture(tmp_path)
    receipt_path = receipt(folder, value)
    data = c.document(receipt_path.read_bytes())
    data["scope"] = "source-only"
    receipt_path.write_bytes(c.json_bytes(data))
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    with pytest.raises(c.ContractError):
        load_cli().qualify(folder / "candidate.json", receipt_path)
    assert {p.name: p.read_bytes() for p in folder.iterdir()} == before


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell adapter")
def test_powershell_adapter_accepts_same_fixture_and_rejects_failed_receipt(tmp_path):
    _, folder, value, _ = fixture(tmp_path)
    helper = Path(__file__).resolve().parents[2] / "release" / "release_manifest_io.ps1"
    script = f"$ErrorActionPreference='Stop'; . '{helper}'; $e=Get-QualifiedRelease -PackagePath '{folder / value['file']}'; Assert-ReleaseEvidenceUnchanged $e"
    def run():
        return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True)
    result = run()
    assert result.returncode == 0, result.stderr
    path = receipt(folder, value)
    data = c.document(path.read_bytes())
    data["cleanup"] = {"status": "unknown"}
    path.write_bytes(c.json_bytes(data))
    value["contract"]["validation_receipt"]["sha256"] = c.file_sha256(path)
    (folder / value["file"]).with_suffix(".candidate.json").write_bytes(c.json_bytes(value))
    assert run().returncode != 0


@pytest.mark.parametrize("raw,valid", [(b'{"x":1,"x":2}', False), (b'{"x":1,"X":2}', False),
                                     (b'{"x":1,"\\u0078":2}', False), (b'{"a":{"x":1},"b":{"x":2}}', True)])
def test_powershell_json_property_scopes(tmp_path, raw, valid):
    path = tmp_path / "fixture.json"
    path.write_bytes(raw)
    helper = Path(__file__).resolve().parents[2] / "release/release_manifest_io.ps1"
    script = f"$ErrorActionPreference='Stop'; . '{helper}'; ConvertFrom-ReleaseJson ([System.IO.File]::ReadAllBytes('{path}')) | Out-Null"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True)
    assert (result.returncode == 0) == valid


def test_build_and_selector_scripts_parse_without_execution():
    root = Path(__file__).resolve().parents[2]
    for name in ("make_release.ps1", "select_release.ps1", "release_manifest_io.ps1"):
        script = f"$e=$null; $t=$null; [System.Management.Automation.Language.Parser]::ParseFile('{root / 'release' / name}',[ref]$t,[ref]$e) | Out-Null; if($e.Count){{$e;exit 1}}"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr


def test_build_and_publish_are_separate_and_selector_keeps_original_bytes():
    root = Path(__file__).resolve().parents[2]
    build = (root / "release/make_release.ps1").read_text(encoding="utf-8-sig")
    branch = build.split("if ($PublishCandidatePath) {", 1)[1].split("\n}", 1)[0]
    assert "Publish-QualifiedRelease" in branch and "return" in branch
    assert build.index("if ($PublishCandidatePath)") < build.index('Write-Host "[1/8]')
    assert build.count("Publish-QualifiedRelease") == 1
    assert build.index("ContractTool descriptor") < build.index("Compress-Archive -Path")
    selector = (root / "release/select_release.ps1").read_text(encoding="utf-8-sig")
    assert "$ManifestBytes = $Evidence.Bytes" in selector
    assert selector.index("Get-QualifiedRelease") < selector.index("Write-ManifestAtomic")


@pytest.mark.parametrize("name", [
    directory + database + suffix
    for directory in ("backend/", "BACKEND/")
    for database in ("content_hub.db", "content_hub_trash.db")
    for suffix in ("", "-wal", "-shm", "-journal")
])
def test_package_cannot_replace_legacy_database_family(tmp_path, name):
    payload = {"VERSION.txt": b"fixture", "hf_cli_version.txt": b"1.1.26", name: b"synthetic old-user-database"}
    candidate, _ = qualified_package(tmp_path, "fixture", payload=payload)
    with pytest.raises(c.ContractError, match="installation-owned"):
        c.read_descriptor(tmp_path / candidate["file"])


def test_backend_program_file_is_still_allowed(tmp_path):
    payload = {"VERSION.txt": b"fixture", "hf_cli_version.txt": b"1.1.26", "backend/app/db.py": b"# synthetic code"}
    candidate, _ = qualified_package(tmp_path, "fixture", payload=payload)
    assert c.read_descriptor(tmp_path / candidate["file"])[0]["version"] == "fixture"


@pytest.mark.parametrize("name", [
    "backend/content_hub.db.", "backend/content_hub_trash.db ",
    "backend./content_hub.db", "backend /content_hub.db",
    "data./fixture.txt", "data /fixture.txt",
])
def test_package_rejects_windows_normalized_path_aliases(tmp_path, name):
    payload = {"VERSION.txt": b"fixture", "hf_cli_version.txt": b"1.1.26", name: b"synthetic alias"}
    candidate, _ = qualified_package(tmp_path, "fixture", payload=payload)
    with pytest.raises(c.ContractError, match="unsafe ZIP path"):
        c.read_descriptor(tmp_path / candidate["file"])
