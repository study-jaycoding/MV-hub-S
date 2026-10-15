"""Local, owner-scoped AI plans; every submission intent is persisted before HTTP."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ..db import get_connection

__all__ = ["create_mcp_plan", "get_mcp_plan", "update_mcp_plan"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode(row):
    if not row:
        return None
    result = dict(row)
    result["plan"] = json.loads(result["plan"])
    result["items"] = json.loads(result["items"])
    result.pop("owner_uid", None)
    return result


def create_mcp_plan(owner: str, plan: dict, db_path: Path, client_name: str = "") -> dict:
    pid, now = str(uuid4()), _now()
    states = [{"state": "pending", "error": None, "updated_at": now, "events": []} for _ in plan["items"]]
    with get_connection(db_path) as conn:
        conn.execute("INSERT INTO ai_generation_batch(id,owner_uid,status,revision,plan,items,created_at,updated_at,client_name) VALUES(?,?,'proposed',0,?,?,?,?,?)",
                     (pid, owner, json.dumps(plan, ensure_ascii=False), json.dumps(states), now, now, client_name))
    return get_mcp_plan(owner, pid, db_path)


def get_mcp_plan(owner: str, pid: str, db_path: Path) -> dict | None:
    with get_connection(db_path) as conn:
        return _decode(conn.execute("SELECT * FROM ai_generation_batch WHERE id=? AND owner_uid=?", (pid, owner)).fetchone())


def update_mcp_plan(owner: str, pid: str, revision: int, db_path: Path, *, index: int | None = None,
                    state: str | None = None, error: str | None = None, approval_source: str = "app") -> dict | None:
    with get_connection(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        result = _decode(conn.execute("SELECT * FROM ai_generation_batch WHERE id=? AND owner_uid=?", (pid, owner)).fetchone())
        if result is None:
            return None
        if result["revision"] != revision:
            raise ValueError("계획 상태가 바뀌었습니다. 다시 조회하세요")
        if index is None:
            if result["status"] != "proposed":
                return result
            result["status"] = "approved"
            result["approved_at"] = _now()
            for item in result["items"]:
                item["events"] = item.get("events", []) + [{"state": "approved", "source": approval_source, "at": result["approved_at"]}]
        else:
            if result["status"] == "proposed" or index >= len(result["items"]):
                raise ValueError("승인되지 않았거나 없는 계획 항목입니다")
            old = result["items"][index]["state"]
            allowed = {"pending": {"submitting"}, "submitting": {"submitted", "uncertain", "rejected"},
                       "uncertain": {"submitted"}, "rejected": set(), "submitted": set()}
            if state not in allowed.get(old, set()):
                raise ValueError("이 항목을 다시 제출할 수 없습니다. 기존 요청 상태를 확인하세요")
            now = _now()
            events = result["items"][index].get("events", []) + [{"state": state, "at": now}]
            result["items"][index] = {"state": state, "error": error, "updated_at": now, "events": events}
            result["status"] = "submitted" if all(i["state"] == "submitted" for i in result["items"]) else "approved"
        now = _now()
        conn.execute("UPDATE ai_generation_batch SET status=?,revision=revision+1,items=?,approved_at=?,updated_at=? WHERE id=? AND owner_uid=? AND revision=?",
                     (result["status"], json.dumps(result["items"], ensure_ascii=False), result["approved_at"], now, pid, owner, revision))
    return get_mcp_plan(owner, pid, db_path)
