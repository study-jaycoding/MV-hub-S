"""Persistent local MCP grants, immutable plans and explicit canvas attachments."""
from __future__ import annotations

import json
from uuid import uuid4

from ..db import get_connection


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def create_client(secret_hash, hub_id, owner, account, password_stamp, workspace, name, can_execute):
    client_id = str(uuid4())
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO mcp_client(id,secret_hash,hub_id,owner_uid,account_email,password_stamp,workspace,name,can_execute) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (client_id, secret_hash, hub_id, owner, account, password_stamp, encode(workspace), name, int(can_execute)),
        )
    return client_id


def client_for_secret(secret_hash):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM mcp_client WHERE secret_hash=?", (secret_hash,)).fetchone()
    return dict(row) if row else None


def touch_client(client_id):
    with get_connection() as conn:
        conn.execute("UPDATE mcp_client SET last_seen_at=datetime('now') WHERE id=?", (client_id,))


def list_clients(owner, email):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id,name,workspace,can_execute,last_seen_at,revoked_at FROM mcp_client "
            "WHERE owner_uid=? AND account_email=? ORDER BY created_at DESC", (owner, email),
        ).fetchall()
    return [{**dict(row), "workspace": json.loads(row["workspace"]), "can_execute": bool(row["can_execute"])} for row in rows]


def revoke(client_id, owner, email):
    with get_connection() as conn:
        return bool(conn.execute(
            "UPDATE mcp_client SET revoked_at=COALESCE(revoked_at,datetime('now')) "
            "WHERE id=? AND owner_uid=? AND account_email=?", (client_id, owner, email),
        ).rowcount)


def revoke_account(email):
    with get_connection() as conn:
        conn.execute("UPDATE mcp_client SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE account_email=?", (email,))


def revoke_replaced_clients(client_id, owner, email, name):
    with get_connection() as conn:
        conn.execute(
            "UPDATE mcp_client SET revoked_at=datetime('now') "
            "WHERE id<>? AND owner_uid=? AND account_email=? AND name=? AND revoked_at IS NULL",
            (client_id, owner, email, name),
        )


def save_reference(client, source, version, reference):
    reference_id = str(uuid4())
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO mcp_reference(id,client_id,source,version,reference) VALUES(?,?,?,?,?)",
            (reference_id, client["id"], encode(source), version, encode(reference)),
        )
    return reference_id


def get_reference(client, reference_id):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM mcp_reference WHERE id=? AND client_id=?", (reference_id, client["id"])).fetchone()
    if not row:
        return None
    return {**dict(row), "source": json.loads(row["source"]), "reference": json.loads(row["reference"])}


def _grant_allows(client, workspace):
    grant = json.loads(client["workspace"])
    return workspace.get("scope") in ("personal", "team") and (
        grant.get("scope") == "account" or (grant.get("scope"), grant.get("id")) == (workspace.get("scope"), workspace.get("id")))


def create_plan(client, title, items, workspace=None):
    workspace = workspace if workspace is not None else json.loads(client["workspace"])
    if not _grant_allows(client, workspace):
        raise ValueError("A plan requires an authorized concrete workspace")
    plan_id = str(uuid4())
    for item in items:
        item.update(idempotency_key=str(uuid4()), state="pending", generation_id=None)
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO mcp_generation_plan(id,client_id,owner_uid,account_email,workspace,title,items) VALUES(?,?,?,?,?,?,?)",
            (plan_id, client["id"], client["owner_uid"], client["account_email"], encode(workspace), title, encode(items)),
        )
    return get_plan(client, plan_id)


def get_plan(client, plan_id):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM mcp_generation_plan WHERE id=? AND client_id=? AND owner_uid=? AND account_email=?",
            (plan_id, client["id"], client["owner_uid"], client["account_email"]),
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        result["workspace"] = json.loads(row["workspace"])
        if not _grant_allows(client, result["workspace"]):
            return None
        result["items"] = json.loads(row["items"])
        # A crash after local enqueue cannot cause automatic paid re-submission.
        for item in result["items"]:
            queued = conn.execute(
                "SELECT r.gen_id,r.status,g.status AS generation_status FROM gen_request r "
                "LEFT JOIN generation g ON g.id=r.gen_id WHERE r.account_email=? AND r.idempotency_key=?",
                (client["account_email"], item["idempotency_key"]),
            ).fetchone()
            if queued:
                item["generation_id"] = queued["gen_id"]
                item["queue_status"] = queued["status"]
                item["generation_status"] = queued["generation_status"]
                item["state"] = "uncertain" if queued["status"] == "preparing" else "submitted"
    return result


def claim_plan(client, plan_id, workspace=None):
    workspace = workspace if workspace is not None else json.loads(client["workspace"])
    if not _grant_allows(client, workspace):
        return False
    with get_connection() as conn:
        return bool(conn.execute(
            "UPDATE mcp_generation_plan SET status='executing' WHERE id=? AND client_id=? "
            "AND owner_uid=? AND account_email=? AND workspace=? AND status='planned'",
            (plan_id, client["id"], client["owner_uid"], client["account_email"], encode(workspace)),
        ).rowcount)


def update_plan(plan_id, items, status):
    with get_connection() as conn:
        conn.execute("UPDATE mcp_generation_plan SET items=?,status=? WHERE id=?", (encode(items), status, plan_id))


def add_canvas_task(client, plan_id, scene_id, generation_ids, workspace=None):
    workspace = workspace if workspace is not None else json.loads(client["workspace"])
    if not _grant_allows(client, workspace):
        raise ValueError("A canvas task requires the plan workspace")
    task_id = str(uuid4())
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO mcp_canvas_task(id,plan_id,owner_uid,account_email,workspace,scene_id,generation_ids) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(plan_id,scene_id) DO NOTHING",
            (task_id, plan_id, client["owner_uid"], client["account_email"], encode(workspace), scene_id, encode(generation_ids)),
        )
        row = conn.execute("SELECT * FROM mcp_canvas_task WHERE plan_id=? AND scene_id=?", (plan_id, scene_id)).fetchone()
    return _task(row)


def _task(row):
    return {key: json.loads(row[key]) if key in ("workspace", "generation_ids") else row[key]
            for key in ("id", "scene_id", "workspace", "generation_ids", "status")}


def canvas_tasks(owner, email, workspace):
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM mcp_canvas_task WHERE owner_uid=? AND account_email=? "
            "AND json_extract(workspace,'$.scope')=? AND COALESCE(json_extract(workspace,'$.id'),'')=? "
            "AND status='pending' ORDER BY created_at",
            (owner, email, workspace["scope"], workspace.get("id") or ""),
        ).fetchall()
    return [_task(row) for row in rows]


def has_canvas_tasks(owner, email, workspace):
    with get_connection() as conn:
        return conn.execute(
            "SELECT 1 FROM mcp_canvas_task WHERE owner_uid=? AND account_email=? "
            "AND json_extract(workspace,'$.scope')=? AND COALESCE(json_extract(workspace,'$.id'),'')=? "
            "AND status='pending' LIMIT 1",
            (owner, email, workspace["scope"], workspace.get("id") or ""),
        ).fetchone() is not None


def complete_canvas_task(task_id, owner, email, workspace):
    with get_connection() as conn:
        return bool(conn.execute(
            "UPDATE mcp_canvas_task SET status='done' WHERE id=? AND owner_uid=? AND account_email=? "
            "AND json_extract(workspace,'$.scope')=? AND COALESCE(json_extract(workspace,'$.id'),'')=?",
            (task_id, owner, email, workspace["scope"], workspace.get("id") or ""),
        ).rowcount)
