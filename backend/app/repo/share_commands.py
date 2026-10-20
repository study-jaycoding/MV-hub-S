"""Share command receipts participate in the caller's single transaction."""
import hashlib
import json

from . import share


def request_hash(command):
    return hashlib.sha256(json.dumps(command, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def database_generation(conn):
    row = conn.execute("SELECT value FROM app_setting WHERE key='share_db_generation'").fetchone()
    return row[0] if row else None


def state(conn, target_id):
    row = conn.execute("SELECT g.*, EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared "
                       "FROM generation g WHERE g.id=? OR g.job_id=? ORDER BY (g.id=?) DESC LIMIT 1",
                       (target_id, target_id, target_id)).fetchone()
    return dict(row) if row else None


def public_state(gen):
    return {key: (bool(gen.get(key)) if key in {"shared", "is_final", "is_held"} else gen.get(key)) for key in ("id", "job_id", "workspace_scope", "workspace_id", "project_id",
            "shared", "is_final", "is_held", "final_by", "final_at", "share_revision")}


def receipt(conn, actor, operation):
    row = conn.execute("SELECT * FROM share_command_receipt WHERE actor_id=? AND operation_id=?", (actor, operation)).fetchone()
    return dict(row) if row else None


def complete(conn, actor, command, digest, result):
    conn.execute("INSERT INTO share_command_receipt(actor_id,operation_id,workspace_scope,target_id,command_kind,"
                 "request_hash,expected_revision,resulting_revision,state,result_code,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                 (actor, command["operation_id"], command["workspace_scope"], result["id"], command["command_kind"],
                  digest, command["expected_revision"], result["share_revision"], "completed", "ok",
                  json.dumps(result, sort_keys=True, separators=(",", ":"))))


def apply(conn, gen, command, actor, finalizer):
    kind, params, gid = command["command_kind"], command["parameters"], gen["id"]
    if kind == "publish":
        conn.execute("INSERT INTO share(id,generation_id,shared_by,visibility) VALUES(?,?,?,?) ON CONFLICT(generation_id) DO NOTHING",
                     (share.new_id(), gid, actor, params.get("visibility", "team")))
    elif kind == "unpublish":
        share._unpublish_generation_if_not_final(conn, gid)
    elif kind == "finalize":
        if not gen["is_final"] or not gen["shared"]:
            share._finalize_generation_with_share(conn, gid, actor, finalizer, expect_project=gen.get("project_id"))
    elif kind == "unfinalize":
        share._release_final(conn, gid, restore_held=params.get("restore_held", False), expect_project=gen.get("project_id"))
    elif kind == "final_review":
        share._transition_final_review(conn, gid, params["state"], gen.get("worker_id") or actor, expect_project=gen.get("project_id"))
    elif kind in {"hold", "unhold"}:
        share._set_generation_hold(conn, gid, kind == "hold")
    else:
        raise ValueError("unsupported_share_command")
