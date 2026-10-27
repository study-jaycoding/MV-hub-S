"""업데이트 때 남길 원격 작업과 로컬 결과 쓰기 경계."""
from __future__ import annotations

import hashlib
import json
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from .. import active_account
from ..db import get_connection, get_db_path
from ..emailnorm import norm_email
from ..workspace_context import normalize_workspace_context

_KEY = "update_remote_checkpoint"
_write_lock = threading.Lock()
_writers = 0


class UpdateActivityBusy(RuntimeError):
    pass


def active_write_count() -> int:
    with _write_lock:
        return _writers


@contextmanager
def local_write():
    """카운트를 먼저 올리고 checking을 확인해 양쪽 진입 순서의 틈을 막는다."""
    from .release_update import update_in_progress

    global _writers
    with _write_lock:
        _writers += 1
    try:
        if update_in_progress():
            raise UpdateActivityBusy("프로그램 업데이트 중입니다. 결과 저장은 다시 확인합니다.")
        yield
    finally:
        with _write_lock:
            _writers -= 1


def current_scope() -> dict[str, str]:
    # 기존 MCP와 동일한 허브 신원을 재사용한다. 라우터의 초기화 순환을 피하려고 늦게 읽는다.
    from ..routers import _proxy, mcp_v2

    parts = urlsplit(_proxy.base_url())
    host = parts.hostname or ""
    if parts.port:
        host += f":{parts.port}"
    normalized = urlunsplit((parts.scheme.lower(), host.lower(), parts.path.rstrip("/"), "", ""))
    return {"hub_id": mcp_v2.hub_id(),
            "server_key": hashlib.sha256(normalized.encode("utf-8")).hexdigest()}


def remote_recovery_candidates(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT r.id rid,r.gen_id,r.account_email,r.payload,g.job_id "
        "FROM gen_request r JOIN generation g ON g.id=r.gen_id "
        "WHERE r.status IN ('running','tracking','verifying') "
        "AND g.status='running' AND g.job_id IS NOT NULL AND TRIM(g.job_id)<>'' "
        "AND r.account_email IS NOT NULL AND TRIM(r.account_email)<>'' "
        "AND COALESCE(g.generator,'')<>'comfy' ORDER BY r.id"
    ).fetchall()
    result = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
            raw_workspace = payload.get("workspace")
            if raw_workspace is not None and (
                not isinstance(raw_workspace, dict)
                or raw_workspace.get("scope", "unknown") not in ("team", "personal", "unknown")
                or (raw_workspace.get("scope") == "team" and not raw_workspace.get("id"))
            ):
                continue
            workspace = normalize_workspace_context(raw_workspace)
            if raw_workspace and raw_workspace.get("scope") == "team" and workspace["scope"] != "team":
                continue
        except (TypeError, ValueError, AttributeError):
            continue
        result.append({"rid": row["rid"], "gen_id": row["gen_id"], "job_id": row["job_id"],
                       "account_email": norm_email(row["account_email"]), "workspace": workspace})
    return result


def _load(conn) -> list[dict]:
    row = conn.execute("SELECT value FROM app_setting WHERE key=?", (_KEY,)).fetchone()
    if row is None:
        return []
    value = json.loads(row["value"])
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("items"), list):
        raise ValueError("원격 생성 복구 기록을 확인할 수 없습니다")
    for item in value["items"]:
        if not isinstance(item, dict) or not all(
            isinstance(item.get(key), str) and item[key]
            for key in ("rid", "gen_id", "job_id", "account_email", "hub_id", "server_key")
        ) or not isinstance(item.get("workspace"), dict):
            raise ValueError("원격 생성 복구 기록을 확인할 수 없습니다")
    return value["items"]


def _save(conn, items: list[dict]) -> None:
    conn.execute(
        "INSERT INTO app_setting(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (_KEY, json.dumps({"version": 1, "items": items}, ensure_ascii=False)),
    )


def prepare_remote_checkpoint() -> int:
    """현재 계정 DB에서 앵커와 복구 목록을 같은 쓰기 트랜잭션으로 확인한다."""
    from ..routers import _proxy

    if _proxy.is_shared_team_server():
        return 0
    with active_account.pinned_account_scope():
        scope = current_scope()
        path = get_db_path()
        with get_connection(path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                items = _load(conn)
                by_key = {(v["hub_id"], v["server_key"], v["account_email"], v["rid"], v["job_id"]): v for v in items}
                current = remote_recovery_candidates(conn)
                for item in current:
                    item.update(scope)
                    item["saved_at"] = datetime.now(timezone.utc).isoformat()
                    key = (scope["hub_id"], scope["server_key"], item["account_email"], item["rid"], item["job_id"])
                    by_key.setdefault(key, item)
                _save(conn, list(by_key.values()))
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
    return len(current)


def remote_checkpoint_required() -> bool:
    path = get_db_path()
    if not path.is_file():
        return False
    with get_connection(path) as conn:
        return bool(remote_recovery_candidates(conn))


def list_checkpoint(account_email: str) -> list[dict]:
    with active_account.pinned_account_scope():
        scope = current_scope()
        email = norm_email(account_email)
        with get_connection() as conn:
            items = [dict(item) for item in _load(conn)
                     if item["account_email"] == email and all(item[k] == v for k, v in scope.items())]
            for item in items:
                row = conn.execute(
                    "SELECT r.submission_fingerprint,r.payload FROM gen_request r JOIN generation g ON g.id=r.gen_id "
                    "WHERE r.id=? AND r.account_email=? AND g.job_id=?",
                    (item["rid"], email, item["job_id"]),
                ).fetchone()
                try:
                    refs = json.loads(row[0] or "{}").get("submitted_refs") if row else None
                    model = json.loads(row[1] or "{}").get("model") if row else None
                except (ValueError, TypeError, AttributeError):
                    refs = None
                    model = None
                if model == "draw_to_video":
                    item["expected_image_inputs"] = 0
                    continue  # 새 workflow의 get 참조 형태는 강제 실패 근거로 쓰지 않는다.
                if isinstance(refs, list) and all(
                    isinstance(ref, dict) and ref.get("type") in ("image", "video", "audio") for ref in refs
                ):
                    item["expected_image_inputs"] = sum(ref["type"] == "image" for ref in refs)
            return items


def acknowledge_checkpoint(rid: str, job_id: str, account_email: str) -> bool:
    """같은 원격 작업의 최종 상태와 결과 저장을 DB에서 확인한 뒤에만 지운다."""
    from .cli_bridge import provider_status_kind

    with active_account.pinned_account_scope():
        scope = current_scope()
        email = norm_email(account_email)
        path = get_db_path()
    with get_connection(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT r.status request_status,r.provider_status,g.status,g.job_id, "
                "EXISTS(SELECT 1 FROM asset a WHERE a.generation_id=g.id AND TRIM(a.file_path)<>'') has_asset "
                "FROM gen_request r "
                "JOIN generation g ON g.id=r.gen_id WHERE r.id=? AND r.account_email=?",
                (rid, email),
            ).fetchone()
            terminal = row is not None and row["job_id"] == job_id and (
                (row["request_status"] == "done" and row["status"] == "done" and row["has_asset"])
                or (row["request_status"] == "failed" and row["status"] in ("failed", "nsfw")
                    and provider_status_kind(row["provider_status"]) == "failure")
            )
            if not terminal:
                conn.execute("COMMIT")
                return False
            items = _load(conn)
            remaining = [v for v in items if not (
                v["rid"] == rid and v["job_id"] == job_id and v["account_email"] == email
                and all(v[k] == value for k, value in scope.items())
            )]
            if len(remaining) != len(items):
                _save(conn, remaining)
            conn.execute("COMMIT")
            return len(remaining) != len(items)
        except BaseException:
            conn.execute("ROLLBACK")
            raise
