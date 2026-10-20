"""Build/qualify already-built releases; qualification never rebuilds or runs a ZIP.

Run with a trusted build-machine Python, never with the candidate's runtime.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import release_contract as contract


def write_new(path: Path, raw: bytes) -> None:
    try:
        with path.open("xb") as stream:
            stream.write(raw)
    except FileExistsError:
        contract.require(path.read_bytes() == raw, "immutable release sidecar already differs")


def write_candidate(path: Path, raw: bytes) -> None:
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        temporary.write_bytes(raw)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout


def source_identity(root: Path) -> dict:
    contract.require(not git(root, "status", "--porcelain", "--untracked-files=normal").strip(), "release source must be clean")
    commit = git(root, "rev-parse", "HEAD").decode().strip()
    contract.require(commit == git(root, "rev-parse", "origin/main").decode().strip(), "release source must equal origin/main")
    entries = []
    for name in sorted(git(root, "ls-files", "-z").decode("utf-8").split("\0")):
        if name:
            path = root / name
            contract.require(path.is_file() and not path.is_symlink(), "invalid tracked release source")
            entries.append({"path": name, "sha256": contract.file_sha256(path)})
    return {"commit": commit, "tree": git(root, "rev-parse", "HEAD^{tree}").decode().strip(), "dirty": False,
            "sha256": contract.sha256(contract.json_bytes({"tracked": entries})), "scope": "git-tracked"}


def build_descriptor(root: Path, stage: Path, version: str, declaration: dict) -> dict:
    compatibility = contract.compatibility(declaration)
    payload = []
    for path in sorted(stage.rglob("*")):
        linked = path.is_symlink() or bool(getattr(path.stat(), "st_file_attributes", 0) & 1024)
        contract.require(not linked, "staged reparse points forbidden")
        if path.is_file() and path != stage / contract.DESCRIPTOR:
            payload.append({"path": path.relative_to(stage).as_posix(), "size": path.stat().st_size,
                            "sha256": contract.file_sha256(path)})
    locks = ("frontend/package-lock.json", "backend/requirements.lock.txt", "tools/mcp_adapter/requirements.lock.txt")
    # Lock contents, local paths and environment values are not copied into provenance.
    runtime = {"builder_python": sys.version.split()[0], "higgsfield_cli": (stage / "hf_cli_version.txt").read_text().strip()}
    for name in ("runtime/python/python.exe", "runtime/node/node.exe"):
        if (stage / name).is_file():
            runtime[name + ":sha256"] = contract.file_sha256(stage / name)
    return {"format_version": 1, "build_id": uuid.uuid4().hex, "version": version, "role": "worker",
            "source": source_identity(root), "lock_sha256": {name: contract.file_sha256(root / name) for name in locks},
            "runtime": runtime,
            "compatibility": compatibility, "payload": payload}


def create_candidate(package: Path) -> dict:
    descriptor, raw = contract.read_descriptor(package)
    return {"version": descriptor["version"], "file": package.name, "size": package.stat().st_size,
            "sha256": contract.file_sha256(package), "higgsfield_cli_version": descriptor["runtime"]["higgsfield_cli"],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "contract": {"format_version": 1, "build_id": descriptor["build_id"], "descriptor_sha256": contract.sha256(raw),
                         "compatibility": descriptor["compatibility"], "validation_receipt": None}}


def qualify(candidate_path: Path, receipt_path: Path) -> Path:
    candidate = contract.document(candidate_path.read_bytes())
    package = candidate_path.parent / candidate["file"]
    contract.verify_artifact(package, candidate, qualified=False)
    raw = receipt_path.read_bytes()
    contract.validate_receipt(raw, candidate)
    name = package.stem + ".validation.json"
    candidate["contract"]["validation_receipt"] = {"file": name, "sha256": contract.sha256(raw)}
    contract.verify_artifact(package, candidate, raw)
    # Final sidecars are immutable; candidate.json is only the mutable selection pointer/content.
    write_new(package.with_suffix(".validation.json"), raw)
    final = package.with_suffix(".candidate.json")
    candidate_raw = contract.json_bytes(candidate)
    write_new(final, candidate_raw)
    write_candidate(candidate_path, candidate_raw)
    return final


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("descriptor")
    for name in ("root", "stage", "version", "compatibility"):
        build.add_argument("--" + name, required=True)
    build.add_argument("--expected-source", required=True)
    source = sub.add_parser("source")
    source.add_argument("--root", required=True, type=Path)
    source.add_argument("--compatibility", required=True, type=Path)
    candidate = sub.add_parser("candidate")
    candidate.add_argument("--package", required=True, type=Path)
    qualify_parser = sub.add_parser("qualify")
    qualify_parser.add_argument("--candidate", required=True, type=Path)
    qualify_parser.add_argument("--receipt", required=True, type=Path)
    verify = sub.add_parser("verify")
    verify.add_argument("--candidate", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "source":
            contract.compatibility(contract.document(args.compatibility.read_bytes()))
            print(contract.json_bytes(source_identity(args.root)).decode("utf-8"))
        elif args.command == "descriptor":
            stage = Path(args.stage)
            declaration = contract.document(Path(args.compatibility).read_bytes())
            descriptor = build_descriptor(Path(args.root), stage, args.version, declaration)
            contract.require(contract.sha256(contract.json_bytes(descriptor["source"])) == args.expected_source,
                             "source changed during build")
            write_new(stage / contract.DESCRIPTOR, contract.json_bytes(descriptor))
        elif args.command == "candidate":
            value = create_candidate(args.package)
            write_candidate(args.package.parent / "candidate.json", contract.json_bytes(value))
        elif args.command == "qualify":
            qualify(args.candidate, args.receipt)
        else:
            value = contract.document(args.candidate.read_bytes())
            contract.candidate_contract(value)
            reference = value.get("contract", {}).get("validation_receipt")
            contract.require(reference is not None, "validation receipt required")
            raw = (args.candidate.parent / reference["file"]).read_bytes()
            contract.verify_artifact(args.candidate.parent / value["file"], value, raw)
    except (contract.ContractError, OSError, subprocess.CalledProcessError, KeyError, TypeError, AttributeError) as exc:
        # No local/NAS paths, subprocess output or environment in qualification logs.
        print(str(exc) if isinstance(exc, contract.ContractError) else type(exc).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
