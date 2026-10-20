"""Synthetic artifact/receipt fixture shared by Python and PowerShell contract tests."""
import zipfile
from pathlib import Path

from app.services import release_contract as c


def qualified_package(folder: Path, version: str, *, rollout="bridge", payload=None) -> tuple[dict, bytes]:
    files = payload or {"VERSION.txt": version.encode(), "hf_cli_version.txt": b"1.1.26",
                        "runtime/higgsfield/node_modules/@higgsfield/cli/package.json": b'{"version":"1.1.26"}'}
    compat = {"protocol_version": 1, "rollout": rollout, "backward_compatible": rollout == "bridge",
              "required_installer_capabilities": [] if rollout == "bridge" else ["artifact-receipt-v1"],
              "db_schema": {"read_min": 0, "read_max": 0, "write_min": 0, "write_max": 0}}
    descriptor = {"format_version": 1, "build_id": "fixture-" + version, "version": version, "role": "worker",
                  "source": {"commit": "f" * 40, "tree": "e" * 40, "dirty": False, "sha256": "a" * 64},
                  "lock_sha256": {"fixture.lock": "b" * 64}, "runtime": {"higgsfield_cli": "1.1.26"},
                  "compatibility": compat,
                  "payload": [{"path": name, "size": len(raw), "sha256": c.sha256(raw)} for name, raw in sorted(files.items())]}
    descriptor_raw = c.json_bytes(descriptor)
    package = folder / f"MVHub-{version}.zip"
    with zipfile.ZipFile(package, "w") as archive:
        for name, raw in files.items():
            if raw is not None:
                archive.writestr(name, raw)
        archive.writestr(c.DESCRIPTOR, descriptor_raw)
    candidate = {"version": version, "file": package.name, "sha256": c.file_sha256(package), "size": package.stat().st_size,
                 "higgsfield_cli_version": "1.1.26", "created_at": "2026-10-18T00:00:00+00:00",
                 "contract": {"format_version": 1, "build_id": descriptor["build_id"], "descriptor_sha256": c.sha256(descriptor_raw),
                              "compatibility": compat, "validation_receipt": None}}
    receipt = {"format_version": 1, "run_id": "fixture-only-never-production", "scope": "artifact", "profile": c.PROFILE,
               "status": "passed", "release_eligible": True, "artifact": {"sha256": candidate["sha256"], "size": candidate["size"]},
               "descriptor_sha256": c.sha256(descriptor_raw), "checks": {key: "passed" for key in sorted(c.REQUIRED_CHECKS)},
               "skips": [], "cleanup": {"status": "passed"}, "tool_sha256": {"fixture": "c" * 64},
               "started_at": "2026-10-18T00:00:00+00:00", "finished_at": "2026-10-18T00:01:00+00:00"}
    receipt_raw = c.json_bytes(receipt)
    receipt_path = package.with_suffix(".validation.json")
    receipt_path.write_bytes(receipt_raw)
    candidate["contract"]["validation_receipt"] = {"file": receipt_path.name, "sha256": c.sha256(receipt_raw)}
    raw = c.json_bytes(candidate)
    package.with_suffix(".candidate.json").write_bytes(raw)
    return candidate, raw
