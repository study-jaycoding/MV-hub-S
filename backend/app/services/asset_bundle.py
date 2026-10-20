"""Disk-backed exports of the exact recorded generation bytes."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from .asset_io import UPLOAD_MAX_BYTES
from .media_types import ASSET_CONTENT_TYPES


class IncompleteBundle(ValueError):
    def __init__(self, missing):
        self.missing = missing
        super().__init__("asset_bundle_incomplete")


def _public_params(value, key=""):
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    if normalized == "key" or any(word in normalized for word in ("token", "secret", "password", "credential", "authorization", "cookie", "apikey")):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(k): _public_params(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_public_params(v) for v in value]
    if isinstance(value, str) and (
        re.search(r"(?:https?://|[a-zA-Z]:[\\/]|\\\\)", value)
        or value.startswith(("/", "asset:", "asset-sync:"))
        or normalized in ("key", "path", "filepath", "filename", "directory")
    ):
        return "<location omitted>"
    return value


def build_bundle(generation, resolve_source, *, allow_incomplete=False):
    """resolve_source(record, cid) must enforce location access before returning a path."""
    records = [("outputs", row) for row in generation.get("assets") or []]
    records += [("references", row) for row in generation.get("references") or []]
    if len(records) > 1000:
        raise ValueError("asset_bundle_too_many_files")
    manifest = {
        "format": "mvhub-generation-bundle", "version": 1,
        "generation": {key: generation.get(key) for key in
                       ("id", "job_id", "model", "prompt", "display_prompt")},
        "params": _public_params(generation.get("params")),
        "outputs": [], "references": [], "missing": [],
    }
    with tempfile.NamedTemporaryFile(prefix="mvhub-bundle-", suffix=".zip", delete=False) as handle:
        archive_path = Path(handle.name)
    try:
        with zipfile.ZipFile(
            archive_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True
        ) as archive:
            for number, (kind, row) in enumerate(records):
                cid = row.get("asset_content_id")
                if not cid and kind == "references" and row.get("version_verified") and row.get("content_sha"):
                    cid = "sha256:" + row["content_sha"]
                entry = {"id": row.get("id"), "asset_content_id": cid, "type": row.get("type")}
                if kind == "references":
                    entry.update(role=row.get("role"), position=row.get("position"))
                try:
                    if not isinstance(cid, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", cid):
                        raise ValueError("asset_identity_unverified")
                    if row.get("content_sha") and cid != "sha256:" + row["content_sha"]:
                        raise ValueError("asset_identity_conflict")
                    source = Path(resolve_source(row, cid))
                    digest = hashlib.sha256()
                    size = 0
                    with tempfile.TemporaryFile(mode="w+b", prefix="mvhub-bundle-bytes-") as snapshot:
                        with source.open("rb") as incoming:
                            for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                                size += len(chunk)
                                if size > UPLOAD_MAX_BYTES:
                                    raise ValueError("asset_too_large")
                                digest.update(chunk)
                                snapshot.write(chunk)
                        if not size or "sha256:" + digest.hexdigest() != cid:
                            raise ValueError("asset_content_changed")
                        if row.get("content_bytes") and row["content_bytes"] != size:
                            raise ValueError("asset_content_changed")
                        extension = source.suffix.lower()
                        if extension not in ASSET_CONTENT_TYPES:
                            extension = ".bin"
                        relative = f"{kind}/{number:04d}-{cid[7:]}{extension}"
                        snapshot.seek(0)
                        with archive.open(relative, "w", force_zip64=True) as output:
                            shutil.copyfileobj(snapshot, output, length=1024 * 1024)
                    entry.update(path=relative, bytes=size)
                    manifest[kind].append(entry)
                except (OSError, ValueError) as exc:
                    code = str(exc) if isinstance(exc, ValueError) else "asset_bytes_unavailable"
                    if code not in {"asset_identity_unverified", "asset_identity_conflict",
                                    "asset_too_large", "asset_content_changed", "asset_bytes_unavailable"}:
                        code = "asset_bytes_unavailable"
                    manifest["missing"].append({**entry, "reason": code})
            if not any(kind == "outputs" for kind, _ in records):
                manifest["missing"].append({"id": None, "reason": "generation_output_unavailable"})
            if manifest["missing"] and not allow_incomplete:
                raise IncompleteBundle(manifest["missing"])
            manifest["complete"] = not manifest["missing"]
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        return archive_path
    except BaseException:
        archive_path.unlink(missing_ok=True)
        raise
