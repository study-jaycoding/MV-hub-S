"""Capability-negotiated share commands; the existing intent owns retries."""
import json
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from fastapi import HTTPException

from ..repo.share_state_intents import store_share_command
from ..repo.share_commands import request_hash


def validate_result(command, result):
    receipt = result.get("receipt") if isinstance(result, dict) else None
    current = result.get("current") if isinstance(result, dict) else None
    if (not isinstance(receipt, dict) or not isinstance(current, dict)
            or result.get("protocol") != "share-command-v1"
            or receipt.get("operation_id") != command["operation_id"]
            or receipt.get("request_hash") != request_hash(command)
            or receipt.get("state") != "completed" or receipt.get("result_code") != "ok"
            or not isinstance(receipt.get("share_revision"), int)
            or current.get("id") != receipt.get("id")):
        raise HTTPException(503, "share_receipt_unconfirmed")
    return result


def supported(proxy):
    try:
        result = proxy.proxy_json("GET", "/api/share/capabilities")
    except HTTPException as exc:
        if exc.status_code in {404, 405}:
            return False
        raise
    return isinstance(result, dict) and result.get("share_command") == 1 and result.get("receipt_replay") is True


def _legacy_fallback(conditional):
    if conditional:
        raise HTTPException(409, "share_revision_precondition_unsupported")
    return None


def build_command(operation_id, target_id, kind, state, parameters=None, *, expected_revision=None):
    """Frozen-command state requires an explicit expected_revision."""
    command = {
        "operation_id": operation_id, "target_id": target_id, "command_kind": kind,
        "workspace_scope": state.get("workspace_scope") or "unknown", "workspace_id": state.get("workspace_id"),
        "expected_revision": state["share_revision"] if expected_revision is None else expected_revision,
        "parameters": parameters or {},
    }
    if state.get("db_generation") is not None:
        command["db_generation"] = state["db_generation"]
    return command


def send(proxy, ref, server_id, kind, parameters=None, *, expected_revision=None):
    saved = json.loads(ref["remote_command_json"]) if ref.get("remote_command_json") else None
    if saved and saved["command_kind"] == kind:
        command = saved
    else:
        if not supported(proxy):
            return _legacy_fallback(expected_revision is not None)
        state = proxy.proxy_json("GET", f"/api/share/command-state/{server_id}")
        if saved and saved.get("db_generation") is not None:
            state = {**state, "db_generation": saved["db_generation"]}
        command = build_command(f"{ref['intent_id']}:{ref['intent_seq']}:{kind}", server_id, kind, state,
                                parameters, expected_revision=expected_revision)
    if not store_share_command(ref, command):
        raise HTTPException(409, "share_intent_superseded")
    result = proxy.proxy_json("POST", "/api/share/commands", body=command)
    validate_result(command, result)
    if not store_share_command(ref, command, result["receipt"]):
        raise HTTPException(409, "share_intent_superseded")
    # The receipt is historical. Fetch current card data for the legacy UI/mirror.
    try:
        current = proxy.proxy_json("GET", f"/api/generations/{result['current']['id']}")
    except HTTPException as exc:
        raise HTTPException(503, "share_current_revision_unconfirmed") from exc
    if (not isinstance(current, dict) or type(current.get("share_revision")) is not int
            or current.get("id") != result["current"]["id"]):
        raise HTTPException(503, "share_current_revision_unconfirmed")
    current["remote_share_revision"] = current["share_revision"]
    return current


def replay(proxy, intent, server_origin, token):
    command = json.loads(intent["remote_command_json"])
    body, path = command, "/api/share/commands"
    if command["command_kind"] == "publish_bundle":
        body = {"bundle": {"provider": command["parameters"].get("provider", {}), "generations": [command["parameters"]["item"]]}, "commands": [command]}
        path = "/api/share/publish-bundle"
    status, payload = proxy.raw_request("POST", f"{server_origin}{path}", token=token, body=body, timeout=15)
    if status != 200 or not isinstance(payload, dict) or payload.get("protocol") != "share-command-v1":
        raise HTTPException(status if status >= 400 else 503, "share_receipt_unconfirmed")
    if command["command_kind"] == "publish_bundle":
        result = payload["command_results"][command["target_id"]]
        if "error" in result:
            raise HTTPException(result["error"]["status_code"], result["error"]["detail"])
        return validate_result(command, result)
    return validate_result(command, payload)


def prepare_bundle(http_json, url, token, bundle, refs_by_anchor, *, expected_revisions=None):
    status, capability = http_json("GET", f"{url}/api/share/capabilities", token=token)
    if status in {404, 405} or (status == 200 and (not isinstance(capability, dict) or capability.get("share_command") != 1 or capability.get("receipt_replay") is not True)):
        return _legacy_fallback(bool(expected_revisions))
    if status != 200:
        raise HTTPException(status if status >= 400 else 503, "share_capability_unavailable")
    commands = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        # Each read keeps the caller's pinned account/DB epoch; writes stay in bundle order.
        reads = [executor.submit(copy_context().run, http_json, "GET",
                                 f"{url}/api/share/command-state/{item['generation']['id']}", token=token)
                 for item in bundle["generations"]]
        try:
            for item, read in zip(bundle["generations"], reads, strict=True):
                generation = item["generation"]
                anchor = generation["id"]
                status, state = read.result()
                if status == 404:
                    state = {**generation, "share_revision": 0, "db_generation": capability.get("db_generation")}
                elif status != 200:
                    raise HTTPException(status if status >= 400 else 503, "share_state_unavailable")
                ref = refs_by_anchor[anchor]
                command = build_command(f"{ref['intent_id']}:{ref['intent_seq']}:publish", anchor, "publish_bundle", state,
                                        {"item": item, "provider": bundle.get("provider", {})},
                                        expected_revision=(expected_revisions or {}).get(anchor, state["share_revision"]))
                if not store_share_command(ref, command):
                    raise HTTPException(409, "share_intent_superseded")
                commands.append(command)
        finally:
            for read in reads:
                read.cancel()
    return commands
