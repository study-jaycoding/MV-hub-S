"""Release artifact contract. Pure stdlib; never imports app config or runs a payload."""
from __future__ import annotations

import hashlib
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

DESCRIPTOR = "build-manifest.json"
PROFILE = "release-qualification-v1"
REQUIRED_CHECKS = frozenset({"artifact_integrity", "isolated_install", "runtime_health", "compatibility", "cleanup"})
MAX_JSON = 4 * 1024 * 1024
_SHA = re.compile(r"[0-9a-f]{64}")


class ContractError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def document(raw: bytes) -> dict:
    require(len(raw) <= MAX_JSON, "release contract is too large")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique)
    except (UnicodeError, ValueError) as exc:
        raise ContractError("invalid release contract JSON") from exc
    require(isinstance(value, dict), "release contract must be an object")
    return value


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return stream_sha256(stream)


def stream_sha256(stream) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def digest(value: Any) -> bool:
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def safe_name(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and not any(c in value for c in '/\\:') and value not in {".", ".."}


def payload_name(name: str) -> bool:
    return (bool(name) and "\\" not in name and ":" not in name and
            not name.startswith("/") and
            all(p not in {"", ".", ".."} and p == p.rstrip(". ") for p in name.split("/")))


def compatibility(value: Any) -> dict:
    require(isinstance(value, dict), "compatibility declaration required")
    for name in ('reader_protocol', 'writer_protocol'):
        if name in value:
            require(type(value[name]) is int and value[name] >= 1, 'invalid database protocol declaration')
    if 'supported_components' in value:
        components = value['supported_components']
        require(isinstance(components, list) and all(isinstance(c, str) and c for c in components)
                and len(set(components)) == len(components), 'invalid database component declaration')
    require(value.get("rollout") in {"bridge", "enforced"}, "unknown rollout")
    caps = value.get("required_installer_capabilities")
    require(isinstance(caps, list) and all(isinstance(c, str) and c for c in caps) and len(set(caps)) == len(caps),
            "invalid installer capabilities")
    require(type(value.get("protocol_version")) is int and value["protocol_version"] == 1, "unsupported release protocol")
    schema = value.get("db_schema")
    require(isinstance(schema, dict), "explicit database compatibility required")
    for key in ("read_min", "read_max", "write_min", "write_max"):
        require(type(schema.get(key)) is int and schema[key] >= 0, "invalid database compatibility range")
    require(schema["read_min"] <= schema["write_min"] <= schema["write_max"] <= schema["read_max"],
            "database write range must be readable")
    if value["rollout"] == "bridge":
        require(not caps and value.get("backward_compatible") is True, "bridge must declare backward compatibility")
    else:
        require("artifact-receipt-v1" in caps, "enforced release requires artifact-receipt-v1")
    return value


def candidate_contract(value: dict) -> str:
    """Legacy is readable, but cannot be promoted as a qualified artifact."""
    contract = value.get("contract")
    if contract is None:
        return "legacy-unverified"
    require(isinstance(contract, dict) and type(contract.get("format_version")) is int and contract["format_version"] == 1,
            "unsupported release contract")
    require(isinstance(contract.get("build_id"), str) and bool(contract["build_id"]), "build_id required")
    require(digest(contract.get("descriptor_sha256")), "descriptor digest required")
    compatibility(contract.get("compatibility"))
    receipt = contract.get("validation_receipt")
    if receipt is not None:
        require(isinstance(receipt, dict) and safe_name(receipt.get("file")) and digest(receipt.get("sha256")),
                "invalid validation receipt reference")
    return "qualification-referenced" if receipt else "unqualified"


def validate_receipt(raw: bytes, candidate: dict) -> dict:
    receipt = document(raw)
    require(type(receipt.get("format_version")) is int and receipt["format_version"] == 1, "unsupported receipt format")
    require(receipt.get("scope") == "artifact" and receipt.get("profile") == PROFILE, "artifact qualification required")
    require(receipt.get("status") == "passed" and receipt.get("release_eligible") is True, "qualification did not pass")
    require(isinstance(receipt.get("run_id"), str) and bool(receipt["run_id"]), "receipt run_id required")
    require(receipt.get("artifact") == {"sha256": candidate["sha256"], "size": candidate["size"]}, "receipt artifact mismatch")
    require(receipt.get("descriptor_sha256") == candidate["contract"]["descriptor_sha256"], "receipt descriptor mismatch")
    checks = receipt.get("checks")
    require(isinstance(checks, dict) and REQUIRED_CHECKS <= checks.keys() and all(v == "passed" for v in checks.values()),
            "required qualification checks did not pass")
    require(receipt.get("skips") == [] and receipt.get("cleanup") == {"status": "passed"}, "incomplete qualification cleanup or skips")
    hashes = receipt.get("tool_sha256")
    require(isinstance(hashes, dict) and bool(hashes) and all(digest(v) for v in hashes.values()), "qualification tool digests required")
    try:
        start = datetime.fromisoformat(receipt["started_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(receipt["finished_at"].replace("Z", "+00:00"))
        require(start.tzinfo is not None and end.tzinfo is not None and end >= start, "invalid qualification times")
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise ContractError("invalid qualification times") from exc
    return receipt


def read_descriptor(package: Path, *, verify_payload: bool = True) -> tuple[dict, bytes]:
    try:
        with zipfile.ZipFile(package) as archive:
            files = {}
            for info in archive.infolist():
                name = info.filename.rstrip("/")
                require(payload_name(name), "unsafe ZIP path")
                require(not any(re.fullmatch(r'[^/.]{1,6}~[0-9]+(?:\.[^/]{1,3})?', part)
                                for part in name.split('/')), "unsafe ZIP path")
                require(not re.match(r'^(backend/data|data|logs|\.install-checkpoints|\.install-journals)(/|$)', name, re.I)
                        and not re.fullmatch(r'backend/content_hub(?:_trash)?\.db(?:-(?:wal|shm|journal))?', name, re.I)
                        and name.casefold() not in {'install_source.txt', 'update-journal.json', '.install-activation.json',
                                                   '.update.lock', '.resolve-transfer.lock'}, 'package targets installation-owned data')
                if info.is_dir():
                    continue
                require(name.casefold() not in files, "duplicate ZIP path")
                require((info.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlink forbidden")
                files[name.casefold()] = info
            info = files.get(DESCRIPTOR.casefold())
            require(info is not None and info.filename == DESCRIPTOR and info.file_size <= MAX_JSON, "build descriptor missing")
            raw = archive.read(info)
            descriptor = document(raw)
            require(type(descriptor.get("format_version")) is int and descriptor["format_version"] == 1, "unsupported build descriptor")
            require("sha256" not in descriptor and "artifact_sha256" not in descriptor, "descriptor cannot contain ZIP/self hash")
            require(descriptor.get("role") == "worker", "unsupported artifact role")
            compatibility(descriptor.get("compatibility"))
            source = descriptor.get("source", {})
            require(source.get("dirty") is False and digest(source.get("sha256")), "clean source fingerprint required")
            require(all(isinstance(source.get(k), str) and bool(source[k]) for k in ("commit", "tree")), "source revision required")
            require(isinstance(descriptor.get("lock_sha256"), dict) and bool(descriptor["lock_sha256"]) and
                    all(digest(v) for v in descriptor["lock_sha256"].values()), "dependency lock digests required")
            require(isinstance(descriptor.get("runtime"), dict) and bool(descriptor["runtime"]), "runtime provenance required")
            payload = descriptor.get("payload")
            require(isinstance(payload, list) and bool(payload), "payload inventory required")
            seen = {DESCRIPTOR.casefold()}
            for row in payload:
                require(isinstance(row, dict), "invalid payload inventory")
                name = row.get("path", "")
                require(isinstance(name, str) and payload_name(name) and name.casefold() not in seen, "duplicate or unsafe payload path")
                seen.add(name.casefold())
                entry = files.get(name.casefold())
                require(entry is not None and entry.filename == name and type(row.get("size")) is int and
                        entry.file_size == row["size"] and digest(row.get("sha256")), "payload inventory mismatch")
                if verify_payload:
                    with archive.open(entry) as stream:
                        require(stream_sha256(stream) == row["sha256"], "payload digest mismatch")
            require(seen == files.keys(), "unlisted ZIP payload")
            for name, expected in (("VERSION.txt", descriptor.get("version")),
                                   ("hf_cli_version.txt", descriptor["runtime"].get("higgsfield_cli"))):
                entry = files.get(name.casefold())
                require(entry is not None and entry.file_size <= 4096, "release version metadata missing")
                require(archive.read(entry).decode("utf-8-sig").strip() == expected, "release version metadata mismatch")
            return descriptor, raw
    except (zipfile.BadZipFile, KeyError, RuntimeError, UnicodeError) as exc:
        raise ContractError("invalid release ZIP") from exc


def verify_artifact(package: Path, candidate: dict, receipt_raw: bytes | None = None, *, qualified: bool = True) -> dict:
    require(candidate_contract(candidate) != "legacy-unverified", "legacy-unverified artifact cannot be published")
    require(type(candidate.get("size")) is int and candidate["size"] > 0 and digest(candidate.get("sha256")), "invalid artifact identity")
    before = package.stat()
    require(package.name == candidate.get("file") and before.st_size == candidate.get("size") and
            file_sha256(package) == candidate.get("sha256"), "artifact digest or size mismatch")
    descriptor, raw = read_descriptor(package)
    contract = candidate["contract"]
    require(sha256(raw) == contract["descriptor_sha256"] and descriptor.get("build_id") == contract["build_id"] and
            descriptor.get("version") == candidate.get("version") and descriptor["compatibility"] == contract["compatibility"],
            "candidate descriptor mismatch")
    if qualified:
        ref = contract.get("validation_receipt")
        require(ref is not None and receipt_raw is not None, "validation receipt required before publication")
        require(sha256(receipt_raw) == ref["sha256"], "validation receipt digest mismatch")
        validate_receipt(receipt_raw, candidate)
    after = package.stat()
    require((before.st_size, before.st_mtime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ino), "artifact changed during validation")
    return descriptor


def check_installer(candidate: dict, installed_capabilities: list[str]) -> None:
    if candidate_contract(candidate) == "legacy-unverified":
        return
    required = candidate["contract"]["compatibility"]["required_installer_capabilities"]
    require(set(required) <= set(installed_capabilities), "installer bridge required before this release")
