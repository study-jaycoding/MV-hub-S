"""Save explicitly dropped files to the selected folder after local admission."""
from __future__ import annotations

import hashlib
import os
import re
import time
import uuid
from pathlib import Path

from .. import active_account, config, db, rbac
from ..repo import asset_sync as ledger
from . import asset_io, asset_mounts, asset_tree, shared_connection
from .path_safety import safe_join


def validate_relative(value):
    parts = value.replace("\\", "/").split("/")
    if any(p in (".", "..") or re.search(r'[<>:"|?*\x00-\x1f]', p) for p in parts):
        raise ValueError("unsafe_asset_destination")
    if any(p.endswith((".", " ")) or re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", p) for p in parts):
        raise ValueError("unsafe_asset_destination")
    if value.startswith(("/", "\\")):
        raise ValueError("unsafe_asset_destination")
    return "/".join(p for p in parts if p)


def register(conn, *, path, file_path, digest, size, media_type, owner, destination, name):
    validate_relative(name)
    cid = ledger.register_verified_blob(conn, digest, size, media_type)
    sid = ledger.storage_id(conn)
    conn.execute(
        "INSERT OR IGNORE INTO asset_location(location_id,asset_content_id,owner_uid,storage_id,kind,path,original_file_path,original_name) "
        "VALUES(?,?,?,?,'local',?,?,?)",
        (uuid.uuid4().hex, cid, owner, sid, str(path), file_path, name))
    location = conn.execute(
        "SELECT location_id FROM asset_location WHERE storage_id=? AND owner_uid=? AND asset_content_id=? AND kind='local'",
        (sid, owner, cid)).fetchone()[0]
    conn.execute("UPDATE asset_location SET path=?,original_file_path=?,state='ready' WHERE location_id=?",
                 (str(path), file_path, location))
    key = (active_account.account_key() or "", owner, shared_connection.base_url(),
           destination["project_name"], destination.get("project_id", ""), destination["kind"],
           destination["root_path"], destination["relative_dir"], cid, name)
    conn.execute(
        "INSERT OR IGNORE INTO asset_destination_outbox(sync_id,asset_content_id,local_location_id,owner_uid,account_key,server_origin,"
        "project_name,project_id,destination_kind,root_path,relative_dir,original_name,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, cid, location, owner, key[0], key[2], key[3],
         key[4], key[5], key[6], key[7], name, time.time()))
    row = conn.execute(
        "SELECT sync_id,state FROM asset_destination_outbox WHERE account_key=? AND owner_uid=? AND server_origin=? "
        "AND project_name=? AND project_id=? AND destination_kind=? AND root_path=? AND relative_dir=? AND asset_content_id=? AND original_name=?",
        key).fetchone()
    if row["state"] == "ready":
        conn.execute("UPDATE asset_destination_outbox SET state='queued',next_retry_at=0 WHERE sync_id=?", (row["sync_id"],))
    return {"sync_id": row["sync_id"], "sync_state": "queued" if row["state"] == "ready" else row["state"], "asset_content_id": cid,
            "file_path": file_path, "name": name, "destination_project": destination["project_name"],
            "destination_dir": destination["relative_dir"]}


def _current_root(conn, row):
    if row["destination_kind"] == "manual":
        key = active_account.account_key()
        mounts_file = active_account.account_dir(key) / "asset_mounts.json" if key else config.DATA_DIR / "asset_mounts.json"
        for mount in asset_mounts.load(mounts_file):
            if (mount["name"] == row["project_name"]
                    and mount.get("owner", "") in (row["owner_uid"], config.DEFAULT_WORKER_ID, "")):
                return os.path.normpath(str(Path(mount["path"]).expanduser()))
    elif row["destination_kind"] == "project":
        if config.AUTH_ENABLED:
            member = conn.execute("SELECT project_role FROM project_member WHERE project_id=? AND creator_uid=?",
                                  (row["project_id"], row["owner_uid"])).fetchone()
            if not member or not rbac.has_any_project_role(member[0], *rbac.PROJECT_ROLES):
                return None
        project = conn.execute("SELECT * FROM project WHERE id=? AND archived=0", (row["project_id"],)).fetchone()
        if project:
            root = project["asset_root_path"] or project["render_root_path"]
            if root:
                return os.path.normpath(str(Path(root).expanduser()))
            link = conn.execute("SELECT root_path FROM project_folder_link WHERE project_id=?", (row["project_id"],)).fetchone()
            return os.path.normpath(link[0]) if link else None
    elif row["destination_kind"] == "internal":
        return os.path.normpath(str(config.ASSETS_ROOT / row["project_name"]))
    return None


def process_one():
    with db.pinned_share_operation():
        owner = active_account.active_uid() or config.DEFAULT_WORKER_ID
        account = active_account.account_key() or ""
        origin = shared_connection.base_url()
        now = time.time()
        token = uuid.uuid4().hex
        with db.get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT o.*,l.path,b.sha256,b.bytes FROM asset_destination_outbox o "
                "JOIN asset_location l ON l.location_id=o.local_location_id JOIN asset_blob b ON b.asset_content_id=o.asset_content_id "
                "WHERE (? OR o.owner_uid=?) AND o.account_key=? AND o.server_origin=? AND o.state IN ('queued','copying','retrying') "
                "AND o.next_retry_at<=? AND (o.lease_until IS NULL OR o.lease_until<?) ORDER BY o.updated_at LIMIT 1",
                (config.AUTH_ENABLED, owner, account, origin, now, now)).fetchone()
            if row is None:
                return False
            row = dict(row)
            conn.execute("UPDATE asset_destination_outbox SET state='copying',lease_token=?,lease_until=?,attempts=attempts+1 WHERE sync_id=?",
                         (token, now + 600, row["sync_id"]))
        error = None
        try:
            with db.get_connection() as conn:
                if _current_root(conn, row) != row["root_path"]:
                    raise ValueError("asset_destination_changed")
            root = Path(row["root_path"])
            destination = safe_join(root, row["relative_dir"])
            if destination is None or not destination.is_dir():
                raise ValueError("asset_destination_unavailable")
            source = Path(row["path"])
            stage = destination / (".asset-destination-" + uuid.uuid4().hex + ".part")
            try:
                digest, size = hashlib.sha256(), 0
                with source.open("rb") as incoming, stage.open("xb") as outgoing:
                    for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
                        size += len(chunk)
                        if size > row["bytes"]:
                            raise ValueError("asset_content_changed")
                        digest.update(chunk)
                        outgoing.write(chunk)
                    outgoing.flush()
                    os.fsync(outgoing.fileno())
                if size != row["bytes"] or digest.hexdigest() != row["sha256"]:
                    raise ValueError("asset_content_changed")
                index = 1
                while True:
                    name = row["target_name"] or (row["original_name"] if index == 1 else
                        f"{Path(row['original_name']).stem}_{index}{Path(row['original_name']).suffix}")
                    target = safe_join(root, row["relative_dir"] + "/" + name if row["relative_dir"] else name)
                    if target is None:
                        raise ValueError("unsafe_asset_destination")
                    with db.get_connection() as conn:
                        if _current_root(conn, row) != row["root_path"]:
                            raise ValueError("asset_destination_changed")
                        changed = conn.execute("UPDATE asset_destination_outbox SET target_name=? WHERE sync_id=? AND lease_token=?",
                                               (name, row["sync_id"], token)).rowcount
                    if not changed or shared_connection.base_url() != origin:
                        raise ValueError("asset_destination_changed")
                    try:
                        try:
                            os.link(stage, target)
                        except FileExistsError:
                            raise
                        except OSError:
                            if os.name != "nt":
                                raise
                            os.rename(stage, target)
                        break
                    except FileExistsError:
                        if target.stat().st_size == size and asset_io.sha256_file(target) == row["sha256"]:
                            break
                        row["target_name"] = None
                        index += 1
            finally:
                stage.unlink(missing_ok=True)
            asset_tree.invalidate_project_tree(root)
        except Exception as exc:
            error = str(exc) if isinstance(exc, ValueError) else "asset_destination_unavailable"
        with db.get_connection() as conn:
            conn.execute("UPDATE asset_destination_outbox SET state=?,last_error_code=?,lease_token=NULL,lease_until=NULL,"
                         "next_retry_at=?,updated_at=? WHERE sync_id=? AND lease_token=?",
                         ("retrying" if error else "ready", error, time.time() + min(300, 2 ** min(row["attempts"] + 1, 8)),
                          time.time(), row["sync_id"], token))
        return True


def status(conn, owner):
    rows = conn.execute("SELECT sync_id,asset_content_id,project_name,relative_dir,original_name,target_name,state,last_error_code "
                        "FROM asset_destination_outbox WHERE owner_uid=? AND account_key=? AND server_origin=? "
                        "ORDER BY updated_at DESC LIMIT 500",
                        (owner, active_account.account_key() or "", shared_connection.base_url())).fetchall()
    return [dict(row) for row in rows]
