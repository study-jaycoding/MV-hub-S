"""Read-only, batch projection of verified immutable server locations."""
from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable
from typing import Any

from ..config import ASSET_REGISTRY_DRIVES
from ..services.path_safety import asset_storage_context
from ..shared_server_config import DEFAULT_SHARED_URL, K_URL


_CONTENT_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_LOCATION_ID = re.compile(r"[0-9a-f]{32}\Z")
_ROOT_REVISION = re.compile(r"[0-9a-f]{64}\Z")
_LOCATION_FIELDS = ("location_id", "project_id", "owner_uid", "storage_id", "root_revision", "server_origin")


def _origin(conn: sqlite3.Connection) -> str:
    row = conn.execute("SELECT value FROM app_setting WHERE key=?", (K_URL,)).fetchone()
    return str((row[0] if row else None) or DEFAULT_SHARED_URL).rstrip("/")


def _receipt(row: dict[str, Any], origin: str) -> dict[str, Any] | None:
    try:
        receipt = json.loads(row["receipt_json"])
    except (ValueError, TypeError):
        return None
    if not isinstance(receipt, dict) or receipt.get("state") != "ready":
        return None
    if any(receipt.get(key) != row[key] for key in ("asset_content_id", "owner_uid", "project_id", "storage_id", "root_revision")):
        return None
    location_id = receipt.get("location_id")
    if (not isinstance(location_id, str) or not _LOCATION_ID.fullmatch(location_id)
            or receipt.get("file_path") != "asset-sync:" + location_id
            or receipt.get("server_origin") != origin
            or not row["storage_id"] or not _ROOT_REVISION.fullmatch(row["root_revision"] or "")):
        return None
    return {key: receipt[key] for key in _LOCATION_FIELDS}


def verified_locations(conn: sqlite3.Connection, keys: Iterable[tuple[str, str, str]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Only exact (generation owner, project, verified content) tuples may be projected."""
    wanted = {key for key in keys if key[0] and key[1] and _CONTENT_ID.fullmatch(key[2] or "")}
    if not wanted:
        return {}
    content_ids = sorted({key[2] for key in wanted})
    origin = _origin(conn)
    storage = conn.execute("SELECT database_id FROM schema_meta WHERE singleton=1").fetchone()
    storage_id = storage[0] if storage else None
    locations: dict[tuple[str, str, str], dict[str, Any]] = {}
    roots: dict[str, str | None] = {}
    for at in range(0, len(content_ids), 500):
        batch = content_ids[at:at + 500]
        placeholders = ",".join("?" for _ in batch)
        rows = conn.execute(
            f"SELECT o.*, b.bytes, b.sha256 verified_sha FROM asset_sync_outbox o JOIN asset_blob b USING(asset_content_id) "
            f"WHERE o.state='ready' AND o.server_origin=? AND o.asset_content_id IN ({placeholders})",
            [origin, *batch],
        ).fetchall()
        for raw in rows:
            row = dict(raw)
            key = (row["owner_uid"], row["project_id"], row["asset_content_id"])
            if key in wanted and key[2] == "sha256:" + row["verified_sha"] and (receipt := _receipt(row, origin)):
                locations[key] = {"location": receipt, "bytes": row["bytes"]}
        rows = conn.execute(
            f"SELECT l.*, b.bytes, b.sha256 verified_sha, p.asset_root_path FROM asset_location l "
            f"JOIN asset_blob b USING(asset_content_id) JOIN project p ON p.id=l.project_id "
            f"WHERE l.kind='server' AND l.state='ready' AND l.storage_id=? "
            f"AND l.asset_content_id IN ({placeholders})", [storage_id, *batch],
        ).fetchall()
        for raw in rows:
            row = dict(raw)
            key = (row["owner_uid"], row["project_id"], row["asset_content_id"])
            if (key not in wanted or key in locations or key[2] != "sha256:" + row["verified_sha"]
                    or not _LOCATION_ID.fullmatch(row["location_id"])):
                continue
            if row["project_id"] not in roots:
                try:
                    context = asset_storage_context(row["asset_root_path"], ASSET_REGISTRY_DRIVES)
                    roots[row["project_id"]] = context[1] if context else None
                except (OSError, ValueError):
                    roots[row["project_id"]] = None
            if row["root_revision"] != roots[row["project_id"]]:
                continue
            location = {key: row[key] for key in _LOCATION_FIELDS if key != "server_origin"}
            location["server_origin"] = origin
            locations[key] = {"location": location, "bytes": row["bytes"]}
    return locations


def project_generation_locations(conn: sqlite3.Connection, generations: list[dict[str, Any]], *,
                                 references_key: str = "references", assets_key: str = "assets") -> None:
    """Change response copies only; accepted requests and stored source evidence remain immutable."""
    records: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for generation in generations:
        assets = generation.get(assets_key) or []
        if isinstance(assets, dict):
            assets = [assets]
        records.extend((generation, record) for record in [*assets, *(generation.get(references_key) or [])])
    locations = verified_locations(conn, ((generation.get("creator_uid"), generation.get("project_id"), record.get("asset_content_id"))
                                          for generation, record in records))
    for generation, record in records:
        key = (generation.get("creator_uid"), generation.get("project_id"), record.get("asset_content_id"))
        found = locations.get(key)
        if not found:
            continue
        if record.get("content_sha") and key[2] != "sha256:" + record["content_sha"]:
            continue
        if record.get("content_bytes") and record["content_bytes"] != found["bytes"]:
            continue
        location = found["location"]
        record["file_path"] = "asset-sync:" + location["location_id"]
        record["target_project_id"] = key[1]
        record["server_location"] = dict(location)
        if "source_url" in record:
            record["source_url"] = "/api/asset-sync/files/" + location["location_id"]
        if record.get("thumbnail_path") and not str(record["thumbnail_path"]).startswith("http"):
            record["thumbnail_path"] = None
