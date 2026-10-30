"""Durable canvas receipts. All read/check/write operations own one SQL transaction."""
from __future__ import annotations

import json
import time
from typing import Literal, NotRequired, TypedDict

from ..db import get_connection


Disposition = Literal["attached", "superseded", "card_missing"]


class CanvasOutput(TypedDict):
    output_key: str
    kind: str
    state: str
    text: NotRequired[str]
    generation_id: NotRequired[str]


class CanvasResolution(TypedDict):
    attempt_id: str
    state: str
    result_revision: int
    outputs: list[CanvasOutput]
    disposition: NotRequired[Disposition]
    origin: dict[str, str]


class CanvasRunConflict(ValueError):
    pass


def isRunFullySaved(outputsEnumerated: bool, outputs: list[dict]) -> bool:
    return bool(outputsEnumerated and outputs and all(
        (out.get("state") in ("saved", "deleted") and out.get("generation_id"))
        or (out.get("kind") == "text" and out.get("state") == "text" and isinstance(out.get("text"), str))
        for out in outputs
    ))


def _read(conn, attempt_id: str):
    row = conn.execute("SELECT * FROM comfy_canvas_run WHERE attempt_id=?", (attempt_id,)).fetchone()
    if row is None:
        return None
    result = dict(row)
    result["context"] = json.loads(result.pop("context_json"))
    result["outputs"] = []
    for item in conn.execute("SELECT * FROM comfy_canvas_output WHERE attempt_id=? ORDER BY rowid", (attempt_id,)):
        output = dict(item)
        output["metadata"] = json.loads(output.pop("metadata_json"))
        result["outputs"].append(output)
    return result


def get(attempt_id: str):
    with get_connection() as conn:
        return _read(conn, attempt_id)


def by_job(job_id: str, owner: str):
    with get_connection() as conn:
        row = conn.execute("SELECT attempt_id FROM comfy_canvas_run WHERE job_id=? AND owner=?", (job_id, owner)).fetchone()
        return _read(conn, row[0]) if row else None


def unsettled(owner: str) -> list[dict]:
    with get_connection() as conn:
        ids = conn.execute("SELECT attempt_id FROM comfy_canvas_run WHERE owner=? AND state NOT IN ('linked','dismissed')", (owner,)).fetchall()
        return [_read(conn, row[0]) for row in ids]


def claim(descriptor: dict, *, owner: str, hub_id: str, device_id: str,
          job_id: str, request_fp: str, context: dict) -> tuple[str, str]:
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, descriptor["attempt_id"])
        if row:
            same = (row["owner"] == owner and row["hub_id"] == hub_id and row["device_id"] == device_id
                    and row["request_fp"] == request_fp
                    and all(row[key] == value for key, value in descriptor.items()))
            return ("same" if same else "conflict", row["job_id"])
        now = time.time()
        fields = ("attempt_id", "run_group_id", "group_seq", "copy_index", "scene_id", "card_id", "config_fp", "input_fp")
        conn.execute(
            "INSERT INTO comfy_canvas_run (" + ",".join(fields) + ",owner,hub_id,device_id,job_id,request_fp,context_json,created_at,updated_at) "
            "VALUES (" + ",".join("?" for _ in range(16)) + ")",
            (*[descriptor[key] for key in fields], owner, hub_id, device_id, job_id, request_fp,
             json.dumps(context, ensure_ascii=False), now, now),
        )
        return "new", job_id


def _state(conn, row: dict, state: str) -> None:
    if row["state"] != state:
        conn.execute("UPDATE comfy_canvas_run SET state=?, result_revision=result_revision+1, updated_at=? WHERE attempt_id=?",
                     (state, time.time(), row["attempt_id"]))


def set_state(attempt_id: str, state: str) -> None:
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, attempt_id)
        if row and row["state"] not in ("linked", "dismissed"):
            _state(conn, row, state)


def record_context(attempt_id: str, context: dict) -> None:
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, attempt_id)
        if row and row["state"] not in ("linked", "dismissed"):
            conn.execute("UPDATE comfy_canvas_run SET context_json=?, updated_at=? WHERE attempt_id=?",
                         (json.dumps({**row["context"], **context}, ensure_ascii=False), time.time(), attempt_id))


def record_outputs(attempt_id: str, outputs: list[dict], *, enumerated: bool) -> None:
    def pending(row):
        previous = {out["output_key"]: out for out in row["outputs"]}
        changed = []
        for item in outputs:
            old = previous.get(item["output_key"])
            if old and old.get("generation_id"):
                continue  # Includes deleted generations; never resurrect them.
            if old and old["state"] == "ready" and item["state"] in ("pending", "unavailable"):
                continue  # A stale journal cannot erase a durable download receipt.
            if (old and all(old.get(key) == item.get(key) for key in ("state", "kind", "text"))
                    and old["metadata"] == item.get("metadata", {})):
                continue
            changed.append(item)
        return changed

    with get_connection() as conn:
        row = _read(conn, attempt_id)
        if not row or row["state"] in ("linked", "dismissed"):
            return
        if not (enumerated and not row["outputs_enumerated"]) and not pending(row):
            return
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, attempt_id)
        if not row or row["state"] in ("linked", "dismissed"):
            return
        changed = bool(enumerated and not row["outputs_enumerated"])
        previous = {out["output_key"]: out for out in row["outputs"]}
        for item in pending(row):
            old = previous.get(item["output_key"])
            metadata = json.dumps(item.get("metadata", {}), ensure_ascii=False)
            changed |= not old or any(old.get(key) != item.get(key) for key in ("state", "kind", "text"))
            conn.execute("""INSERT INTO comfy_canvas_output(attempt_id,output_key,kind,text,state,metadata_json)
                VALUES(?,?,?,?,?,?) ON CONFLICT(attempt_id,output_key) DO UPDATE SET
                kind=excluded.kind,text=excluded.text,state=excluded.state,metadata_json=excluded.metadata_json""",
                (attempt_id, item["output_key"], item["kind"], item.get("text"), item["state"], metadata))
        conn.execute("UPDATE comfy_canvas_run SET outputs_enumerated=MAX(outputs_enumerated,?), "
                     "result_revision=result_revision+?, updated_at=? WHERE attempt_id=?",
                     (int(enumerated), int(changed), time.time(), attempt_id))


def linked_output(conn, attempt_id: str, output_key: str):
    """Called only inside the generation writer's BEGIN IMMEDIATE transaction."""
    row = conn.execute("SELECT o.generation_id,r.state FROM comfy_canvas_output o JOIN comfy_canvas_run r USING(attempt_id) "
                       "WHERE o.attempt_id=? AND o.output_key=?", (attempt_id, output_key)).fetchone()
    if row is None:
        raise CanvasRunConflict("출력 목록이 기록되지 않았습니다")
    if row[0]:
        return row[0]
    if row[1] in ("linked", "dismissed"):
        raise CanvasRunConflict("이미 정리된 실행입니다")
    return None


def link_output(conn, attempt_id: str, output_key: str, generation_id: str) -> None:
    conn.execute("UPDATE comfy_canvas_output SET generation_id=?,state='saved' WHERE attempt_id=? AND output_key=?",
                 (generation_id, attempt_id, output_key))
    conn.execute("UPDATE comfy_canvas_run SET result_revision=result_revision+1,updated_at=? WHERE attempt_id=?",
                 (time.time(), attempt_id))


def _settlement(conn, row: dict, fallback: str) -> tuple[str, list[str]]:
    if row["state"] in ("linked", "dismissed"):
        return row["state"], []
    deleted = []
    for output in row["outputs"]:
        if output.get("generation_id") and output["state"] != "deleted":
            gen = conn.execute("SELECT deleted_at FROM generation WHERE id=?", (output["generation_id"],)).fetchone()
            if gen is None or gen[0]:
                deleted.append(output["output_key"])
    # An enumerated empty result cannot be collected or saved later.
    state = "failed" if row["outputs_enumerated"] and not row["outputs"] else (
        "saved" if isRunFullySaved(row["outputs_enumerated"], row["outputs"]) else fallback)
    return state, deleted


def settle(attempt_id: str, fallback: str = "needs_collect") -> dict:
    with get_connection() as conn:
        row = _read(conn, attempt_id)
        state, deleted = _settlement(conn, row, fallback)
        if state == row["state"] and not deleted:
            return row  # Frequent reconciliation must not acquire a write lock for a no-op.
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, attempt_id)
        state, deleted = _settlement(conn, row, fallback)
        for key in deleted:
            conn.execute("UPDATE comfy_canvas_output SET state='deleted' WHERE attempt_id=? AND output_key=?", (attempt_id, key))
            conn.execute("UPDATE comfy_canvas_run SET result_revision=result_revision+1 WHERE attempt_id=?", (attempt_id,))
        _state(conn, row, state)
        return _read(conn, attempt_id)


def acknowledge(attempt_id: str, *, owner: str, hub_id: str, device_id: str,
                result_revision: int, disposition: Disposition) -> dict:
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _read(conn, attempt_id)
        if not row or (row["owner"], row["hub_id"], row["device_id"]) != (owner, hub_id, device_id):
            raise CanvasRunConflict("이 계정·허브·PC의 실행을 찾을 수 없습니다")
        if row["result_revision"] != result_revision or row["state"] not in ("saved", "failed", "dismissed", "linked"):
            raise CanvasRunConflict("완료 영수증이 현재 결과와 다릅니다")
        if row["state"] == "linked" and row["disposition"] != disposition:
            raise CanvasRunConflict("이미 다른 영수증으로 연결됐습니다")
        # Retain outputs/linkage so stale save requests cannot resurrect deleted files.
        conn.execute("UPDATE comfy_canvas_run SET state='linked',disposition=?,context_json='{}',updated_at=? WHERE attempt_id=?",
                     (disposition, time.time(), attempt_id))
        return _read(conn, attempt_id)


def resolution(row: dict) -> CanvasResolution:
    result: CanvasResolution = {
        "attempt_id": row["attempt_id"], "state": row["state"], "result_revision": row["result_revision"],
        "outputs": [{key: out[key] for key in ("output_key", "kind", "text", "generation_id", "state") if out.get(key) is not None}
                    for out in row["outputs"]],
        "origin": {"hub_id": row["hub_id"], "device_id": row["device_id"]},
    }
    if row.get("disposition"):
        result["disposition"] = row["disposition"]
    return result
