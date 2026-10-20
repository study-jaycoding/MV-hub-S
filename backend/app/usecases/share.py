"""Share command acceptance: authority, CAS, mutation and receipt on one connection."""
import json
import copy
from ..db import get_connection
from ..repo import share_commands as commands
from ..repo.share import FinalGenerationUnpublishError, GenerationHoldStateError


class ShareCommandError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def inspect_state(load_actor, target):
    with get_connection() as conn:
        conn.execute("BEGIN")
        actor = load_actor(conn)
        gen = commands.state(conn, target)
        if not gen:
            raise ShareCommandError("generation_missing")
        actor.authorize(gen)
        return {**commands.public_state(gen), "db_generation": commands.database_generation(conn)}


def execute(load_actor, command, publication=None):
    digest = commands.request_hash(command)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        actor = load_actor(conn)
        gen = commands.state(conn, command["target_id"])
        previous = commands.receipt(conn, actor.actor_id, command["operation_id"])
        if previous:
            previous_gen = commands.state(conn, previous["target_id"])
            if previous_gen is None:
                raise ShareCommandError("generation_missing")
            actor.authorize(previous_gen)
            if previous["request_hash"] != digest:
                raise ShareCommandError("operation_id_request_mismatch")
            return {"protocol": "share-command-v1", "receipt": json.loads(previous["result_json"]),
                    "current": commands.public_state(previous_gen), "replayed": True}
        if not gen and publication is None:
            raise ShareCommandError("generation_missing")
        expected_target = gen["id"] if gen else None
        if gen is None:
            gen = {**command["parameters"]["item"]["generation"], "id": command["target_id"], "share_revision": 0}
        if (gen.get("workspace_scope") or "unknown") != command["workspace_scope"] or gen.get("workspace_id") != command["workspace_id"]:
            raise ShareCommandError("workspace_changed")
        if publication is None:
            actor.authorize(gen, command["command_kind"])
        if command.get("db_generation") is not None and command["db_generation"] != commands.database_generation(conn):
            raise ShareCommandError("share_database_generation_changed")
        if gen["share_revision"] != command["expected_revision"]:
            raise ShareCommandError("share_revision_conflict")
        if gen.get("deleted_at") or gen["status"] != "done":
            raise ShareCommandError("generation_not_ready")
        try:
            import_result = None
            if publication is None:
                commands.apply(conn, gen, command, actor.shared_by, actor.finalizer)
            else:
                from ..repo import share as share_repo
                worker_id, shared_by, _, author_uids = publication
                if actor.author_uids is not None and actor.author_uids != author_uids:
                    raise ShareCommandError("publication_actor_changed")
                def validate_target(actual_target):
                    if actual_target != expected_target:
                        raise ShareCommandError("generation_identity_changed")
                import_result = share_repo._import_bundle_item(
                    conn, copy.deepcopy(command["parameters"]["item"]), worker_id, shared_by,
                    actor.final_actor, author_uids, validate_target=validate_target)
                if import_result in {"blocked", "skipped"}:
                    raise ShareCommandError("publish_blocked")
        except (FinalGenerationUnpublishError, GenerationHoldStateError) as exc:
            raise ShareCommandError(str(exc)) from exc
        result = commands.public_state(commands.state(conn, gen["id"]))
        if import_result is not None:
            result["import_result"] = import_result
        result.update(operation_id=command["operation_id"], request_hash=digest, result_code="ok", state="completed")
        commands.complete(conn, actor.actor_id, command, digest, result)
        return {"protocol": "share-command-v1", "receipt": result, "current": commands.public_state(commands.state(conn, gen["id"])), "replayed": False}
