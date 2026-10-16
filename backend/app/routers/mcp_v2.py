"""Local, persistent MCP clients using the same authorized read and generation routes."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
import math
import secrets
import sqlite3
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlencode, urlsplit
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import Field, StrictBool, ValidationError, model_validator
from starlette.responses import FileResponse

from .. import active_account, config, repo
from ..db_paths import get_db_path
from ..deps import account_actor_uid, actor_id, current_account, resolve_agent_account
from ..emailnorm import norm_email
from ..mcp_models import StrictModel
from ..models import GenRequestIn, WorkspaceContext
from ..repo import mcp_v2 as store
from ..services import auth, cli_bridge, thumbs
from ..services.async_tools import to_thread_non_abandon
from ..services.path_safety import safe_join
from . import _proxy, assets, gen_requests, generation, library, manage, mcp, projects

router = APIRouter(prefix="/api/mcp/v2", tags=["mcp"])
_registration_lock = threading.Lock()
_result_wait_slots = threading.BoundedSemaphore(8)
_RESULT_POLL_SECONDS = 2.0
_ESTIMATE_BUDGET_SECONDS = 20.0


def hub_id():
    path = str(get_db_path().resolve()).casefold()
    return hmac.new(auth.get_secret().encode(), ("mcp-hub-id\0" + path).encode(), hashlib.sha256).hexdigest()


def _required_hub_id():
    try:
        return hub_id()
    except (auth.AuthSecretUnavailable, sqlite3.Error) as exc:  # 비밀값을 DB 에서 다시 읽다 실패한 것도 같은 '잠시 뒤'(Codex 리뷰 ①)
        raise HTTPException(503, "DB 유지보수 중입니다. 잠시 후 다시 시도하세요.", headers={"Retry-After": "5"}) from exc


_UPSTREAM_DOWN = "공유 서버 응답을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요."


def _upstream_me(base, token):
    """공유 서버의 현재 로그인 — 장애(연결 실패·5xx·형식이 틀린 200)는 권한 문제가 아니다. 재등록 안내 대신 '잠시 뒤'로
    (Codex 리뷰 ②: 5xx·잘못된 200 까지 403 '로그인을 확인할 수 없음'으로 바꿔 다시 연결하라고 안내했다). 401·403 만 권한 거부다."""
    try:
        status, account = _proxy.raw_request("GET", base + "/api/auth/me", token=token, timeout=5)
    except HTTPException as exc:  # 연결 실패·시간 초과(502)
        raise HTTPException(502, _UPSTREAM_DOWN, headers={"X-MVHub-MCP-Error": "upstream_unavailable"}) from exc
    if status in (401, 403):
        raise HTTPException(403, "현재 앱 로그인을 확인할 수 없습니다.")
    if status != 200 or not isinstance(account, dict) or not account.get("email"):
        raise HTTPException(502, _UPSTREAM_DOWN, headers={"X-MVHub-MCP-Error": "upstream_unavailable"})
    return account


@dataclass
class Context:
    request: Request
    pin: tuple
    path: Path
    account: dict
    owner: str
    hub: str
    upstream: tuple[str, str] | None
    client: dict | None = None


def _internal(ctx, path, query=None, *, submit=False):
    state = {"account": ctx.account if config.AUTH_ENABLED or submit else None}
    return Request({**ctx.request.scope, "method": "POST" if submit else "GET", "path": path,
                    "raw_path": path.encode(), "query_string": urlencode(query or {}, doseq=True).encode(),
                    "state": state, "headers": []})


def _capture(request, client_secret=None):
    if _proxy.is_shared_team_server():
        raise HTTPException(403, "공유 서버에서는 MCP를 등록하거나 실행할 수 없습니다.")
    pin = active_account.capture_account_pin()
    with active_account.pinned_account_scope(pin):
        path, identity = get_db_path().resolve(), _required_hub_id()
        store.recover_interrupted_plans(str(path).casefold())  # 이 프로세스에서 이 DB 를 처음 볼 때 한 번(앞 프로세스가 남긴 'executing')
        client = store.client_for_secret(mcp.digest(client_secret)) if client_secret else None
        if client_secret and (not client or client["revoked_at"] or not hmac.compare_digest(client["hub_id"], identity)):
            raise HTTPException(403, "MCP 연결이 해제되었거나 허브가 바뀌었습니다. 앱에서 다시 연결하세요.")
        upstream = None
        if config.AUTH_ENABLED:
            email = client["account_email"] if client else norm_email((current_account(request) or {}).get("email"))
            account = repo.get_account(email) if email else None
            active = repo.get_setting("mcp_active_account")
            if (client and active != email) or (active and active != email):
                raise HTTPException(403, "앱의 활성 계정이 바뀌었습니다. 다시 연결하세요.")
        elif _proxy.is_worker_hub():
            email = norm_email(pin[0])
            base, token = _proxy.base_url(), _proxy.token()
            if not email or not token:
                raise HTTPException(401, "앱에서 공유 서버에 로그인하세요.")
            upstream = (base, token)
            account = _upstream_me(base, token)
            if norm_email(account.get("email")) != email:
                raise HTTPException(403, "현재 앱 로그인을 확인할 수 없습니다.")
        else:
            email = norm_email(pin[0])
            account = repo.get_account(email) if email else current_account(request)
        if not account or account.get("status") != "approved" or account.get("hidden"):
            raise HTTPException(403, "승인된 앱 계정으로 로그인하세요.")
        if not config.AUTH_ENABLED:
            local_account = resolve_agent_account(None)
            if norm_email(local_account["email"]) != norm_email(account["email"]):
                raise HTTPException(403, "로컬 생성 계정이 바뀌었습니다. 다시 로그인하세요.")
            # Match the browser's local creator identity, not the shared server's UID.
            account = {**account, "creator_uid": local_account.get("creator_uid")}
        owner = actor_id(request) if not client else config.DEFAULT_WORKER_ID
        if config.AUTH_ENABLED:
            owner = str(account.get("creator_uid") or f"acct:{norm_email(account['email'])}")
        if client and (client["account_email"] != norm_email(account["email"]) or client["owner_uid"] != owner
                       or client["password_stamp"] != account.get("password_changed_at")):
            raise HTTPException(403, "계정 또는 비밀번호가 바뀌었습니다. 앱에서 다시 연결하세요.")
        return Context(request, pin, path, account, owner, identity, upstream, client)


def _still_current(ctx):
    # Inspect the machine pointer, not this request's ContextVar override.
    with active_account.transition_lock:
        key_token = active_account.set_override(None)
        uid_token = active_account._uid_override.set(None)
        try:
            current = active_account.capture_account_pin()
        finally:
            active_account._uid_override.reset(uid_token)
            active_account.reset_override(key_token)
    if current != ctx.pin or get_db_path().resolve() != ctx.path or _required_hub_id() != ctx.hub:
        raise HTTPException(403, "활성 계정 또는 허브가 바뀌었습니다.")
    if ctx.upstream and (ctx.upstream != (_proxy._stored_base_url(), _proxy._stored_token())):
        raise HTTPException(403, "공유 서버 로그인이 바뀌었습니다.")
    if ctx.client:
        fresh = store.client_for_secret(ctx.client["secret_hash"])
        if not fresh or fresh["revoked_at"]:
            raise HTTPException(403, "MCP 연결이 해제되었습니다.")
    if config.AUTH_ENABLED:
        account = repo.get_account(ctx.account["email"])
        active = repo.get_setting("mcp_active_account")
        if (ctx.client and active != ctx.account["email"]) or (active and active != ctx.account["email"]):
            raise HTTPException(403, "앱의 활성 계정이 바뀌었습니다.")
        if not account or account.get("status") != "approved" or account.get("hidden") or account.get("password_changed_at") != ctx.account.get("password_changed_at"):
            raise HTTPException(403, "계정 인증이 바뀌었습니다.")


async def _app_context(request: Request, _headers=Depends(mcp.app_headers)):
    ctx = await asyncio.to_thread(_capture, request)
    with active_account.pinned_account_scope(ctx.pin), _proxy.pinned_connection(ctx.upstream):
        yield ctx


async def _client_context(request: Request, secret=Depends(mcp.client_guard)):
    ctx = await asyncio.to_thread(_capture, request, secret)
    with active_account.pinned_account_scope(ctx.pin), _proxy.pinned_connection(ctx.upstream):
        await asyncio.to_thread(_still_current, ctx)
        await asyncio.to_thread(store.touch_client, ctx.client["id"])
        yield ctx


def _workspace(ctx, workspace):
    ws = WorkspaceContext.model_validate(workspace)
    if ws.scope not in ("personal", "team"):
        raise HTTPException(422, "생성할 워크스페이스를 선택하세요.")
    if ws.scope == "team":
        # This endpoint checks membership upstream even on an AUTH-off worker hub.
        policy = manage.credit_plan_my_models(_internal(ctx, "/api/manage/credit-plan/my-models", {"workspace_id": ws.id}), ws.id)
        if not isinstance(policy, dict) or policy.get("workspace_id") != ws.id or not isinstance(policy.get("allowed_models"), list):
            raise HTTPException(403, "워크스페이스 권한을 확인할 수 없습니다.")
        if not ws.name:
            available = generation.available_workspaces(_internal(ctx, "/api/workspaces/available"))
            match = next((row for row in available.get("workspaces", []) if row.get("id") == ws.id), None)
            if not match:
                raise HTTPException(403, "현재 계정의 워크스페이스를 확인할 수 없습니다.")
            ws = ws.model_copy(update={"name": match.get("name")})
        ws = gen_requests._validated_generation_workspace(ws, norm_email(ctx.account["email"]))
    return ws.model_dump()


class ConfigureIn(StrictModel):
    clients: list[Literal["codex", "claude", "other"]] = Field(min_length=1, max_length=3)
    scope: Literal["workspace", "account"] = "workspace"
    workspace: WorkspaceContext | None = None
    allow_execution: StrictBool = False

    @model_validator(mode="after")
    def check_scope(self):
        if (self.scope == "account" and self.workspace is not None) or (self.scope == "workspace" and self.workspace is None):
            raise ValueError("계정 범위와 고정 워크스페이스는 함께 지정할 수 없습니다")
        return self


@lru_cache(maxsize=1)
def _setup_module():
    path = mcp._ROOT / "tools" / "mcp_adapter" / "local_setup.py"
    spec = importlib.util.spec_from_file_location("mvhub_mcp_local_setup", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _configure_local(client, setup, credential):
    return _setup_module().configure_client(client, setup, credential)


def _remove_profiles(hub, client_ids):
    """다시 등록하며 회수한 연결의 프로필 파일만 지운다 — 실패해도 등록은 그대로(정리일 뿐)."""
    if not client_ids:
        return
    try:
        _setup_module().remove_profiles(hub, client_ids)
    except Exception:  # noqa: BLE001 - 남은 파일은 연결이 이미 회수돼 쓸 수 없다
        pass


def _setup_error_message(exc):
    # Only fixed, known diagnostics may cross the credential/configuration boundary.
    if isinstance(exc, HTTPException) and exc.status_code == 403:
        return "등록 도중 활성 계정이나 허브 연결이 바뀌었습니다. 현재 앱 로그인을 확인한 뒤 다시 연결하세요."
    for message in (
        "MV Hub와 LLM을 같은 Windows 로그인 사용자로 실행하세요. 서비스 계정에서는 자동 연결할 수 없습니다.",
        "MCP 자동 연결은 Windows 사용자 계정에서 설정하세요.",
        "이 Windows 계정에서 MCP 연결 권한을 읽거나 저장할 수 없습니다.",
        "MCP 실행 파일이 없습니다. 앱 설치 상태를 확인하세요.",
        "Windows 사용자 저장 폴더를 확인할 수 없습니다.",
        "설정이 다른 프로그램에서 바뀌었습니다. 다시 연결하세요.",
        "클라이언트 설정이 너무 커 자동 등록할 수 없습니다.",
    ):
        if isinstance(exc, ValueError) and exc.args == (message,):
            return message
    if isinstance(exc, PermissionError):
        return "MCP 연결 파일이나 LLM 설정 파일을 읽거나 저장할 권한이 없습니다. 파일 접근 권한을 확인하세요."
    return "MCP 설정을 완료하지 못했습니다. 앱 설치와 LLM 설정 파일 상태를 확인한 뒤 다시 연결하세요."


def _register_client(ctx, name, setup, workspace, allow_execution):
    # Serialize config replacement and grant rotation together; no await holds this lock.
    with _registration_lock:
        _still_current(ctx)
        email = norm_email(ctx.account["email"])
        secret = secrets.token_urlsafe(32)
        cid = store.create_client(mcp.digest(secret), ctx.hub, ctx.owner, email,
                                  ctx.account.get("password_changed_at"), workspace, name, allow_execution)
        try:
            result = _configure_local(name, setup, {"secret": secret, "hub_id": ctx.hub, "client_id": cid, "url": setup["url"]})
            if result.get("status") not in ("configured", "manual"):
                raise ValueError("configuration failed")
            _still_current(ctx)
            if result["status"] == "configured" and name in ("codex", "claude"):
                _remove_profiles(ctx.hub, store.revoke_replaced_clients(cid, ctx.owner, email, name))
        except Exception as exc:
            store.revoke(cid, ctx.owner, email)
            result = {"client": name, "status": "error", "message": _setup_error_message(exc)}
        return {**result, "id": cid}


@router.post("/app/configure")
async def configure(body: ConfigureIn, request: Request, ctx=Depends(_app_context)):
    # Only newly issued grants can carry this marker; existing grants remain restricted.
    ws = {"scope": "account"} if body.scope == "account" else await asyncio.to_thread(_workspace, ctx, body.workspace.model_dump())
    setup = await mcp.setup(request, identity=None)
    if config.AUTH_ENABLED:
        await asyncio.to_thread(repo.set_setting, "mcp_active_account", norm_email(ctx.account["email"]))
    results = []
    for name in dict.fromkeys(body.clients):
        results.append(await asyncio.to_thread(_register_client, ctx, name, setup, ws, body.allow_execution))
    return {"clients": results}


@router.get("/app/clients")
async def clients(ctx=Depends(_app_context)):
    return {"clients": await asyncio.to_thread(store.list_clients, ctx.owner, norm_email(ctx.account["email"]))}


@router.post("/app/clients/{client_id}/revoke")
async def revoke(client_id: UUID, ctx=Depends(_app_context)):
    if not await asyncio.to_thread(store.revoke, str(client_id), ctx.owner, norm_email(ctx.account["email"])):
        raise HTTPException(404, "연결을 찾을 수 없습니다.")
    return {"ok": True}


@router.post("/client/connect")
async def connect(body: mcp.ConnectIn, ctx=Depends(_client_context)):
    grant = json.loads(ctx.client["workspace"])
    return {"client_id": ctx.client["id"], "hub_id": ctx.hub, "connected": True,
            "can_execute": bool(ctx.client["can_execute"]), "scope": "account" if grant.get("scope") == "account" else "workspace",
            "workspace": None if grant.get("scope") == "account" else grant}


class ReadIn(StrictModel):
    kind: Literal["workspaces", "workspace", "projects", "generations", "models", "references", "scenes", "scene"] = "workspace"
    workspace_scope: Literal["personal", "team"] | None = None
    workspace_id: str | None = Field(default=None, max_length=200)
    project_id: str | None = Field(default=None, max_length=200)
    search: str | None = Field(default=None, max_length=500)
    limit: int = Field(default=30, ge=1, le=100)
    model: str | None = Field(default=None, max_length=200)
    asset_project: str | None = Field(default=None, max_length=200)
    folder_path: str | None = Field(default=None, max_length=500)
    media_type: Literal["image", "video", "audio"] | None = None
    cursor_ts: float | None = Field(default=None, allow_inf_nan=False, strict=True)
    cursor_id: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def check_cursor(self):
        if (self.cursor_ts is None) != (self.cursor_id is None):
            raise ValueError("다음 페이지의 시각과 ID를 함께 지정하세요")
        return self


def _matches(row, workspace):
    return row.get("workspace_scope") == workspace["scope"] and (row.get("workspace_id") or None) == workspace["id"]


def _workspace_identity(workspace):
    return {"scope": workspace.get("scope"), "id": workspace.get("id")}


def _request_workspace(ctx, scope=None, workspace_id=None):
    grant = json.loads(ctx.client["workspace"])
    if scope is None:
        if workspace_id is not None or grant.get("scope") == "account":
            raise HTTPException(422, "워크스페이스를 명시하세요. read_context(kind='workspaces')로 조회할 수 있습니다.")
        selected = grant
    else:
        selected = WorkspaceContext(scope=scope, id=workspace_id).model_dump()
        if grant.get("scope") != "account" and _workspace_identity(grant) != _workspace_identity(selected):
            raise HTTPException(409, "이 연결에 허용된 워크스페이스와 다릅니다.")
        if grant.get("scope") != "account":
            selected = grant
    return _workspace(ctx, selected)


def _available_workspaces(ctx, limit, search=None):
    grant = json.loads(ctx.client["workspace"])
    if grant.get("scope") != "account":
        return [_workspace(ctx, grant)]
    rows = generation.available_workspaces(_internal(ctx, "/api/workspaces/available")).get("workspaces", [])
    candidates = [{"scope": "personal", "id": None, "name": None}]
    candidates.extend({"scope": "team", "id": row.get("id"), "name": row.get("name")} for row in rows)
    result = []
    for candidate in candidates:
        if search and search.casefold() not in " ".join(str(candidate.get(key) or "") for key in ("scope", "id", "name")).casefold():
            continue
        try:
            result.append(_workspace(ctx, candidate))
        except HTTPException as exc:
            if exc.status_code not in (403, 404, 409):
                raise
        if len(result) >= limit:
            break
    _still_current(ctx)
    return result


def _projects(ctx, ws):
    query = {"tab": "my"}
    if ws["id"]:
        query["workspace_id"] = ws["id"]
    result = projects.list_projects(_internal(ctx, "/api/projects", query), False, "my", ws["id"])
    return [row for row in result.get("projects", []) if _matches(row, ws)]


def _folder_tree(ctx, project_id):
    result = manage.get_project_folder(project_id, _internal(ctx, f"/api/manage/project-folders/{project_id}"))
    return result.get("tree") if not result.get("error") else None


def _folder_exists(tree, path):
    return bool(tree and (tree.get("path") == path or any(_folder_exists(child, path) for child in tree.get("children", []))))


def _scenes(ctx, ws):
    result = []
    for row in repo.list_scene_backups(ctx.owner, "", True):
        try:
            scene = json.loads(row["data"])
        except (ValueError, TypeError):
            continue
        if not isinstance(scene, dict):
            continue
        assigned = scene.get("workspace")
        # Unassigned legacy canvases are personal; team attachment needs an exact ID.
        if ws["scope"] == "team":
            matches = isinstance(assigned, dict) and assigned.get("id") == ws["id"]
        else:
            matches = not assigned or (isinstance(assigned, dict) and assigned.get("scope") == "personal")
        if matches:
            entry = {"id": row["id"], "name": row.get("name") or scene.get("name")}
            if scene.get("backupForkOf"):
                # 옛 창 사본(bk_*) — 그 사본을 가져온 브라우저에서만 붙는다. 원래 씬에서 갈라진 사본이라 고르지 않게 알린다(Codex 리뷰 P2)
                entry.update(backup_copy=True, note="옛 창 사본입니다. 이 사본을 연 브라우저에서만 캔버스에 붙습니다 — 보통은 원래 씬을 고르세요.")
            result.append(entry)
    return result


def _generations(ctx, ws, args):
    params = {"tab": "my", "limit": args.limit, "lean_params": 0}
    if ws["id"]:
        params["workspace_id"] = ws["id"]
    else:
        params["workspace_scope"] = "personal"
    if args.project_id:
        params["project_id"] = args.project_id
    if args.search:
        params["search"] = args.search
    params.update({key: value for key in ("folder_path", "media_type", "cursor_ts", "cursor_id")
                   if (value := getattr(args, key)) is not None})
    return library.list_generations(_internal(ctx, "/api/generations", params), BackgroundTasks(),
        tab="my", limit=args.limit, lean_params=0, workspace_id=ws["id"], workspace_ids=[],
        workspace_scope="personal" if ws["scope"] == "personal" else None,
        project_id=args.project_id, search=args.search, colors=[], tags=[], auto_tags=[],
        share_dir=None, media_type=args.media_type, folder_path=args.folder_path,
        cursor_ts=args.cursor_ts, cursor_id=args.cursor_id)


def _asset_tree(ctx, ws, project):
    request = _internal(ctx, "/api/assets/projects", {"workspace_id": ws["id"]} if ws["id"] else {})
    available = assets.list_projects(request, BackgroundTasks(), ws["id"])
    allowed = available.projects if hasattr(available, "projects") else available["projects"]
    if project not in allowed:
        raise HTTPException(404, "허용된 에셋 폴더가 아닙니다.")
    # AUTH-off auto mounts must also occur in the upstream-authorized project set.
    manual = {item["name"] for item in assets._owner_mounts(ctx.owner)} | {assets._COMBINED_INTERNAL}
    if project not in manual and project not in {item["name"] for item in _projects(ctx, ws)}:
        raise HTTPException(404, "프로젝트 에셋 권한이 없습니다.")
    return assets.project_tree(_internal(ctx, "/api/assets/tree", {"project": project}), BackgroundTasks(), project, True)["children"]


def _flatten(nodes):
    for node in nodes:
        if node.get("type") == "dir":
            yield from _flatten(node.get("children", []))
        else:
            yield node


def _issue_references(ctx, ws, args):
    result = []
    if args.asset_project:
        for node in _flatten(_asset_tree(ctx, ws, args.asset_project)):
            if not node.get("version") or node.get("type") not in ("image", "video", "audio"):
                continue
            if args.search and args.search.casefold() not in str(node.get("name", "")).casefold():
                continue
            ref = {"file_path": f"asset:{args.asset_project}|{node['path']}", "type": node["type"], "name": node.get("name")}
            rid = store.save_reference(ctx.client, {"kind": "asset", "project": args.asset_project, "path": node["path"], "workspace": _workspace_identity(ws)}, node["version"], ref)
            result.append({"id": rid, "name": node.get("name"), "type": node["type"]})
            if len(result) >= args.limit:
                break
    else:
        for row in _generations(ctx, ws, args):
            for asset in row.get("assets", []):
                if asset.get("type") not in ("image", "video", "audio"):
                    continue
                ref = {"file_path": asset.get("source_url") or asset["file_path"], "type": asset["type"],
                       "source_gen_id": row["id"], "name": row.get("prompt", "")[:100]}
                rid = store.save_reference(ctx.client, {"kind": "generation", "id": row["id"], "asset_id": asset["id"], "workspace": _workspace_identity(ws)}, mcp.digest(store.encode(row["assets"])), ref)
                result.append({"id": rid, "name": ref["name"], "type": ref["type"], "source_gen_id": row["id"]})
                if len(result) >= args.limit:
                    return result
    return result


def _references(ctx, ws, ids):
    result = []
    for rid in ids:
        saved = store.get_reference(ctx.client, rid)
        if not saved:
            raise HTTPException(404, "참고 자료 핸들을 다시 조회하세요.")
        source = saved["source"]
        issued_workspace = source.get("workspace") or json.loads(ctx.client["workspace"])
        if _workspace_identity(issued_workspace) != _workspace_identity(ws):
            raise HTTPException(404, "다른 워크스페이스에서 발급한 참고 자료입니다.")
        if source["kind"] == "asset":
            node = next((n for n in _flatten(_asset_tree(ctx, ws, source["project"])) if n.get("path") == source["path"]), None)
            version = (node or {}).get("version")
        else:
            row = library.get_generation(source["id"], _internal(ctx, "/api/generations/" + source["id"]))
            if not _matches(row, ws):
                raise HTTPException(404, "참고 자료의 워크스페이스가 다릅니다.")
            version = mcp.digest(store.encode(row.get("assets", [])))
        if not version or version != saved["version"]:
            raise HTTPException(409, "참고 자료가 바뀌었습니다. 다시 조회해 계획을 만드세요.", headers={"X-MVHub-MCP-Error": "reference_changed"})
        reference = dict(saved["reference"])
        reference["role"] = "@" + reference["type"].capitalize() + str(sum(r["type"] == reference["type"] for r in result) + 1)
        result.append(reference)
    return result


async def _models(ctx, ws):
    models = await generation.list_models()
    if ws["id"]:
        policy = await asyncio.to_thread(manage.credit_plan_my_models,
            _internal(ctx, "/api/manage/credit-plan/my-models", {"workspace_id": ws["id"]}), ws["id"])
        allowed = policy.get("allowed_models", [])
        if allowed:
            models = [model for model in models if model["job_set_type"] in allowed]
    return models


async def _read(ctx, args):
    if args.kind == "workspaces":
        return {"workspaces": await asyncio.to_thread(_available_workspaces, ctx, args.limit, args.search)}
    ws = await asyncio.to_thread(_request_workspace, ctx, args.workspace_scope, args.workspace_id)
    if args.kind == "workspace":
        return {"workspace": ws, "can_execute": bool(ctx.client["can_execute"]),
                "instructions": "일반 생성은 캔버스 없이 실행됩니다. 계획 저장 후 명시적으로 실행하세요. 캔버스 추가는 add_to_canvas입니다."}
    if args.kind == "models":
        models = await _models(ctx, ws)
        if args.model:
            if args.model not in {model["job_set_type"] for model in models}:
                raise HTTPException(422, "사용할 수 없는 모델입니다.")
            return await generation.model_params(args.model)
        return {"models": models}
    if args.kind in ("scenes", "scene"):
        return {"scenes": await asyncio.to_thread(_scenes, ctx, ws)}
    if args.kind == "projects":
        rows = await asyncio.to_thread(_projects, ctx, ws)
        if args.project_id:
            if args.project_id not in {row["id"] for row in rows}:
                raise HTTPException(404, "프로젝트를 찾을 수 없습니다.")
            return {"project_id": args.project_id, "tree": await asyncio.to_thread(_folder_tree, ctx, args.project_id)}
        return {"projects": [{key: row.get(key) for key in ("id", "name", "workspace_scope", "workspace_id")} for row in rows][:args.limit]}
    if args.kind == "references":
        return {"references": await asyncio.to_thread(_issue_references, ctx, ws, args)}
    rows = await asyncio.to_thread(_generations, ctx, ws, args)
    await asyncio.to_thread(_still_current, ctx)
    last = rows[-1] if rows else None
    result = {"generations": [{**{key: row.get(key) for key in ("id", "prompt", "model", "status", "project_id", "folder_path", "workspace_scope", "workspace_id")},
                               "asset_count": len(row.get("assets") or [])} for row in rows], "next_cursor": None}
    if last and len(rows) == args.limit:
        timestamp = last.get("sort_ts")
        try:
            valid_timestamp = type(timestamp) in (int, float) and math.isfinite(timestamp)
        except OverflowError:
            valid_timestamp = False
        if valid_timestamp:
            result["next_cursor"] = {"cursor_ts": timestamp, "cursor_id": last["id"]}
        else:
            result.update(pagination_unavailable=True,
                          note="마지막 항목의 정렬 시각이 없어 다음 페이지를 조회할 수 없습니다. 전체 검색이 끝난 것은 아닙니다. 앱에서 결과를 확인하세요.")
    return result


class PlanItem(StrictModel):
    label: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=4000)
    model: str = Field(min_length=1, max_length=200)
    params: dict[str, Any] = Field(default_factory=dict)
    reference_ids: list[str] = Field(default_factory=list, max_length=8)
    project_id: str | None = Field(default=None, max_length=200)
    folder_path: str | None = Field(default=None, max_length=500)


class PlanIn(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    context_id: str | None = Field(default=None, max_length=120)
    workspace_scope: Literal["personal", "team"] | None = None
    workspace_id: str | None = Field(default=None, max_length=200)
    items: list[PlanItem] = Field(min_length=1, max_length=20)


def _validate_params(params, schema):
    fields = {p["name"]: p for p in schema.get("params", []) if isinstance(p, dict) and p.get("name")}
    for name, value in params.items():
        field = fields.get(name)
        if not field or name.lower() in {"prompt", "references", "file_path", "url", "image_url", "video_url", "input_images"}:
            raise HTTPException(422, "지원하지 않는 모델 옵션입니다.", headers={"X-MVHub-MCP-Error": "invalid_option"})
        kind = str(field.get("type", "string")).split("|")[0]
        valid = ((kind == "integer" and type(value) is int) or (kind in ("number", "float") and type(value) in (int, float) and math.isfinite(value))
                 or (kind == "boolean" and type(value) is bool) or (kind == "string" and isinstance(value, str)))
        if not valid or (field.get("enum") and str(value) not in {str(v) for v in field["enum"]}):
            raise HTTPException(422, "모델 옵션 형식이나 선택값이 잘못되었습니다.", headers={"X-MVHub-MCP-Error": "invalid_option"})
        if isinstance(value, str) and (len(value) > 500 or "://" in value or "\\" in value or "/" in value):
            raise HTTPException(422, "자료 경로는 모델 옵션으로 받지 않습니다. reference_ids를 사용하세요.", headers={"X-MVHub-MCP-Error": "invalid_option"})
        for bound, compare in (("minimum", lambda a, b: a < b), ("maximum", lambda a, b: a > b)):
            if bound in field and type(value) in (int, float) and compare(value, field[bound]):
                raise HTTPException(422, "모델 옵션이 허용 범위를 벗어났습니다.", headers={"X-MVHub-MCP-Error": "invalid_option"})


async def _validate_items(ctx, items, ws):
    ws = await asyncio.to_thread(_workspace, ctx, ws)
    models = {model["job_set_type"] for model in await _models(ctx, ws)}
    available = await asyncio.to_thread(_projects, ctx, ws) if any(item.get("project_id") for item in items) else []
    for item in items:
        if item["model"] not in models:
            raise HTTPException(422, "사용할 수 없는 모델입니다.")
        _validate_params(item["params"], await generation.model_params(item["model"]))
        if item.get("project_id") and item["project_id"] not in {p["id"] for p in available}:
            raise HTTPException(404, "선택한 워크스페이스의 프로젝트를 찾을 수 없습니다.")
        if item.get("folder_path"):
            if not item.get("project_id") or not _folder_exists(await asyncio.to_thread(_folder_tree, ctx, item["project_id"]), item["folder_path"]):
                raise HTTPException(422, "프로젝트의 컷 폴더를 다시 조회하세요.")
        item["references"] = await asyncio.to_thread(_references, ctx, ws, item["reference_ids"])
    await asyncio.to_thread(_still_current, ctx)
    return ws


def _presentation(items, *, scope="plan", item_index=None):
    """One observed-state contract for plan and selected-result responses; never an ETA."""
    labels = {"planned": "생성 준비 완료", "queued": "생성 대기 중", "running": "생성 중",
              "completed": "생성 완료", "failed": "생성 실패", "cancelled": "생성 취소",
              "attention": "상태 확인 필요", "unknown": "상태 확인 중"}
    stages = []
    for item in items:
        state, queue, generation = item.get("state"), item.get("queue_status"), item.get("generation_status")
        if state == "pending":
            stage = "planned"
        elif state == "rejected":
            stage = "failed"
        elif state == "uncertain":
            stage = "attention"
        elif state != "submitted":
            stage = "unknown"
        elif queue in {"failed", "rejected"} or generation == "failed":
            stage = "failed"
        elif queue in {"cancelled", "canceled"} or generation in {"cancelled", "canceled"}:
            stage = "cancelled"
        elif generation == "done":
            stage = "completed"
        elif generation == "running":
            stage = "running"
        elif generation in {None, "pending"}:
            stage = "queued"
        else:
            stage = "unknown"
        stages.append(stage)
    counts = {stage: stages.count(stage) for stage in labels}
    distinct = set(stages)
    if not stages:
        stage = "unknown"
    elif len(distinct) == 1:
        stage = stages[0]
    elif distinct & {"unknown", "attention"}:
        stage = "attention"
    elif "running" in distinct:
        stage = "running"
    elif "queued" in distinct:
        stage = "queued"
    else:
        stage = "attention"
    target = f"선택 항목 {item_index + 1}" if scope == "item" else "생성 결과" if scope == "generation" else "전체 계획"
    message = f"{target} · {labels[stage]} · 완료 {counts['completed']}/{len(items)}"
    for key, label in (("failed", "실패"), ("cancelled", "취소"), ("attention", "확인 필요"), ("unknown", "미확인")):
        if counts[key]:
            message += f" · {label} {counts[key]}"
    if len(distinct) > 1 and counts["planned"]:
        message += f" · 미실행 {counts['planned']}"
    result = {"version": 1, "scope": scope, "stage": stage, "message": message,
              "details": {"completed": counts["completed"], "total": len(items), "by_stage": counts}}
    if scope == "item":
        result["item_index"] = item_index
    return result


def _public_plan(plan):
    if plan is None:
        raise HTTPException(404, "계획을 찾을 수 없습니다.")
    result = {"id": plan["id"], "plan_id": plan["id"], "title": plan["title"], "status": plan["status"], "workspace": plan["workspace"],
            "presentation": _presentation(plan["items"]),
            "items": [{key: value for key, value in item.items() if key not in ("references", "idempotency_key")} for item in plan["items"]]}
    if plan["status"] in ("attention", "executing"):
        result["next_step"] = (
            "이 계획을 다시 실행해도 남은 항목을 재개하지 않습니다. get_plan으로 항목별 상태를 확인하세요. "
            "submitted 항목은 이미 접수되었으므로 재생성하지 마세요. uncertain/submitting 항목은 접수 여부가 "
            "확정되기 전 새 계획으로 재시도하지 마세요. attention 상태에서는 pending(미시도) 또는 "
            "rejected(거절) 항목만 원인을 해결한 뒤 새 계획에 넣으세요. executing 상태에서는 먼저 실행 종료를 확인하세요."
        )
    return result


class PlanId(StrictModel):
    plan_id: UUID


class CanvasIn(PlanId):
    scene_id: str = Field(min_length=1, max_length=200)


class ResultIn(PlanId):
    item_index: int = Field(default=0, ge=0, le=19)
    asset_index: int = Field(default=0, ge=0, le=99)
    wait_seconds: int = Field(default=0, ge=0, le=25, strict=True)


class GenerationIn(StrictModel):
    generation_id: UUID
    workspace_scope: Literal["personal", "team"]
    workspace_id: str | None = Field(default=None, max_length=200)
    asset_index: int = Field(default=0, ge=0, le=99, strict=True)


class SelectedResultsIn(PlanId):
    item_indexes: list[Annotated[int, Field(ge=0, le=19, strict=True)]] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def unique_indexes(self):
        if len(set(self.item_indexes)) != len(self.item_indexes):
            raise ValueError("같은 항목을 두 번 선택할 수 없습니다")
        return self


class WaitResultsIn(SelectedResultsIn):
    wait_seconds: int = Field(default=25, ge=0, le=25, strict=True)


class ShowResultsIn(SelectedResultsIn):
    asset_index: int = Field(default=0, ge=0, le=99, strict=True)


async def _authorized_plan(ctx, plan_id):
    plan = await asyncio.to_thread(store.get_plan, ctx.client, plan_id)
    if plan is None:
        raise HTTPException(404, "계획을 찾을 수 없습니다.")
    await asyncio.to_thread(_workspace, ctx, plan["workspace"])
    await asyncio.to_thread(_still_current, ctx)
    return plan


def _read_preview(response):
    if not isinstance(response, FileResponse) or response.media_type != "image/jpeg":
        raise ValueError("Expected cached JPEG")
    root = Path(thumbs.THUMB_DIR)
    if root.is_symlink() or getattr(root, "is_junction", lambda: False)():
        raise ValueError("Redirected thumbnail directory")
    path = Path(response.path)
    target = safe_join(root, path)
    if target is None or target.suffix.lower() not in (".jpg", ".jpeg"):
        raise ValueError("Thumbnail outside cache")
    with target.open("rb") as stream:
        data = stream.read(512 * 1024 + 1)
    if len(data) > 512 * 1024:
        return None
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "JPEG":
            raise ValueError("Invalid thumbnail")
        if max(image.size) > 1024:
            return None
        image.verify()
    return data


def _generation_row(ctx, generation_id):
    row = library.get_generation(generation_id, _internal(ctx, "/api/generations/" + generation_id))
    if not isinstance(row, dict):
        raise HTTPException(502, "생성 결과 응답 형식을 확인할 수 없습니다.")
    return row


async def _result_once(ctx, args, *, preview=True, plan=None):
    """plan 을 받으면(묶음 대기 — _selected_results 가 한 회에 한 번 읽고 앞뒤로 권한을 검사한 계획) 그 계획을 쓰고 항목마다의
    공간·세션 재확인을 건너뛴다 — 항목·2초마다 공간 확인(팀이면 공유 서버)을 다시 물어 8개면 초당 ~8회였다(Codex 리뷰 P2 ③).
    생성물의 공간·만든 이 검사(_matches)는 항목마다 그대로다."""
    batch_plan = plan
    row = None
    direct = isinstance(args, GenerationIn)
    if direct:
        workspace = await asyncio.to_thread(_request_workspace, ctx, args.workspace_scope, args.workspace_id)
        row = await asyncio.to_thread(_generation_row, ctx, str(args.generation_id))
        creator = account_actor_uid(_internal(ctx, "/api/generations")) if config.AUTH_ENABLED else ctx.account.get("creator_uid")
        if not _matches(row, workspace) or not creator or row.get("creator_uid") != creator:
            raise HTTPException(404, "생성 결과를 찾을 수 없습니다.")
        item = {**row, "state": "submitted", "generation_id": row["id"], "generation_status": row.get("status")}
        plan = {"id": None, "title": "생성 결과", "workspace": workspace}
        item_index = None
    else:
        plan = batch_plan if batch_plan is not None else await _authorized_plan(ctx, str(args.plan_id))
        if args.item_index >= len(plan["items"]):
            raise HTTPException(404, "계획 항목을 찾을 수 없습니다.")
        item = plan["items"][args.item_index]
        item_index = args.item_index
    result = {"plan_id": plan["id"], "item_index": item_index, "asset_index": args.asset_index,
              "generation_id": item.get("generation_id"), "generation_status": item.get("generation_status"),
              "item_state": item.get("state"), "queue_status": item.get("queue_status"),
              "asset_count": 0, "asset_type": None, "media": None, "note": "아직 완료된 미리보기가 없습니다."}
    if direct:
        result["source"] = "library"
    # These are already-authorized display fields, not another lookup or the raw prompt.
    result.update(title=plan["title"][:200], workspace=plan["workspace"],
                  **{key: item.get(key) for key in ("label", "model", "project_id", "folder_path")})
    result["params"] = {key: value[:100] if isinstance(value, str) else value
                        for key, value in (item.get("params") or {}).items()
                        if key in {"aspect_ratio", "resolution", "duration"}
                        and isinstance(value, (str, int, float, bool))
                        and (not isinstance(value, float) or math.isfinite(value))}
    if result["generation_id"]:
        if row is None:
            row = await asyncio.to_thread(_generation_row, ctx, result["generation_id"])
        creator = ctx.owner if config.AUTH_ENABLED else ctx.account.get("creator_uid")
        if (not _matches(row, plan["workspace"]) or
                (row.get("creator_uid") and row["creator_uid"] != creator)):
            raise HTTPException(404, "생성 결과를 찾을 수 없습니다.")
        result["generation_status"] = row.get("status")
        assets_list = row.get("assets", [])
        result["asset_count"] = len(assets_list)
        if row.get("status") == "done":
            result["note"] = ("완료되었지만 선택한 미디어가 없습니다. 앱에서 결과를 확인하세요." if preview else
                              "생성이 완료되었습니다. show_results로 결과를 확인하세요.")
        if preview and row.get("status") == "done" and args.asset_index < len(assets_list):
            asset = assets_list[args.asset_index]
            result["asset_type"] = asset.get("type")
            source = asset.get("thumbnail_path")
            if asset.get("type") == "image":
                source = source or asset.get("file_path")
            elif (asset.get("type") != "video" or not source or
                  any(original and urlsplit(source)._replace(query="", fragment="") == urlsplit(original)._replace(query="", fragment="")
                      for original in (asset.get("file_path"), asset.get("source_url"))) or
                  Path(urlsplit(source).path).suffix.lower() in library.VIDEO_EXTENSIONS):
                source = None
            result["note"] = "미리보기를 사용할 수 없습니다. 앱에서 결과를 확인하세요."
            sources = ([asset.get("file_path"), source] if asset.get("type") == "image" else [source])
            for source in dict.fromkeys(value for value in sources if value):
                try:
                    # Only server-selected assets reach the existing SSRF-safe thumbnail route.
                    for width in (1024, 512, 256):
                        response = await library.media_thumb(src=source, w=width)
                        data = await asyncio.to_thread(_read_preview, response)
                        if data is not None:
                            result["media"] = {"mime": "image/jpeg", "data_base64": base64.b64encode(data).decode("ascii")}
                            result["note"] = "완료된 결과의 미리보기입니다."
                            break
                except (HTTPException, OSError, ValueError):
                    pass
                if result["media"] is not None:
                    break
    if _result_pending(result):
        result["note"] = ("생성 진행 중입니다. 같은 generation_id로 다시 조회하세요. 재생성하지 마세요." if direct else
                          "생성 진행 중입니다. 같은 항목의 get_result(wait_seconds=25)로 계속 확인하세요. 재생성하지 마세요.")
    elif result["generation_status"] != "done":
        result["note"] = "완료 대기를 중단했습니다. 항목·생성 상태를 확인하고 실패·취소·불명확한 접수를 자동 재제출하지 마세요."
    result["presentation"] = _presentation(
        [{**item, "generation_status": result["generation_status"]}], scope="generation" if direct else "item", item_index=item_index)
    if batch_plan is None:  # 묶음은 회마다 끝에서 한 번 재확인한다(_selected_results)
        await asyncio.to_thread(_workspace, ctx, plan["workspace"])
        await asyncio.to_thread(_still_current, ctx)
    return result


def _result_pending(result):
    return (result["item_state"] == "submitted"
            and result["queue_status"] not in {"failed", "cancelled", "canceled", "rejected"}
            and result["generation_status"] in {None, "pending", "running"})


async def _result(ctx, args):
    if not args.wait_seconds:
        return await _result_once(ctx, args)
    # Bound sleepers without holding a DB transaction or a worker thread between polls.
    if not _result_wait_slots.acquire(blocking=False):
        raise HTTPException(429, "결과 대기 요청이 많습니다. 잠시 후 기존 계획을 조회하세요. 재생성하지 마세요.",
                            headers={"X-MVHub-MCP-Error": "wait_limit"})
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + args.wait_seconds
        result = await _result_once(ctx, args, preview=False)
        while _result_pending(result) and loop.time() < deadline:
            if await ctx.request.is_disconnected():
                raise HTTPException(499, "결과 조회 연결이 종료되었습니다.")
            await asyncio.sleep(min(_RESULT_POLL_SECONDS, deadline - loop.time()))
            result = await _result_once(ctx, args, preview=False)
        if result["generation_status"] == "done":
            return await _result_once(ctx, args)
        return result
    finally:
        _result_wait_slots.release()


async def _selected_results(ctx, args, *, preview=False):
    plan = await _authorized_plan(ctx, str(args.plan_id))
    if any(index >= len(plan["items"]) for index in args.item_indexes):
        raise HTTPException(422, "계획 항목 범위를 확인하세요.")
    wait = getattr(args, "wait_seconds", 0)
    if wait and not _result_wait_slots.acquire(blocking=False):
        raise HTTPException(429, "결과 대기 요청이 많습니다.", headers={"X-MVHub-MCP-Error": "wait_limit"})
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait
        first = True
        while True:
            if not first:  # 회마다 계획을 한 번 새로 읽고 권한을 본다(앞) — 항목들은 이 계획을 같이 쓴다
                plan = await _authorized_plan(ctx, str(args.plan_id))
            first = False
            items = []
            for index in args.item_indexes:
                selected = ResultIn(plan_id=args.plan_id, item_index=index, asset_index=getattr(args, "asset_index", 0))
                try:
                    result = await _result_once(ctx, selected, preview=preview, plan=plan)
                except HTTPException as exc:
                    if exc.status_code not in (404, 502, 503, 504):
                        raise
                    result = {"plan_id": str(args.plan_id), "item_index": index, "media": None,
                              "error": {"code": "not_found" if exc.status_code == 404 else "request_failed"}}
                items.append(result)
            # Never return partial data after the session or workspace permission changed.
            await _authorized_plan(ctx, str(args.plan_id))
            pending = any(_result_pending(item) for item in items if "error" not in item)
            if not pending or loop.time() >= deadline:
                return {"plan_id": str(args.plan_id), "items": items,
                        "all_done": all(item.get("presentation", {}).get("stage") == "completed" for item in items),
                        "all_terminal": not pending}
            if await ctx.request.is_disconnected():
                raise HTTPException(499, "결과 조회 연결이 종료되었습니다.")
            await asyncio.sleep(max(0, min(_RESULT_POLL_SECONDS, deadline - loop.time())))
    finally:
        if wait:
            _result_wait_slots.release()


async def _estimate_plan(ctx, plan_id):
    plan = await _authorized_plan(ctx, plan_id)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _ESTIMATE_BUDGET_SECONDS
    items = []
    for index, item in enumerate(plan["items"]):
        credits = None
        remaining = deadline - loop.time()
        if remaining > 0:
            await asyncio.to_thread(_still_current, ctx)
            try:
                estimate = await asyncio.wait_for(cli_bridge.estimate_cost(
                    item["model"], item.get("params"), item.get("prompt", ""), timeout=min(5.0, remaining)), remaining)
                value = estimate.get("credits") if isinstance(estimate, dict) else None
                if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                    credits = value
            except (RuntimeError, TimeoutError, ValueError, OverflowError):
                pass
        items.append({"item_index": index, "credits": credits, "status": "estimated" if credits is not None else "unavailable"})
    await _authorized_plan(ctx, plan_id)
    total = sum((item["credits"] for item in items), 0.0) if all(item["credits"] is not None for item in items) else None
    return {"plan_id": plan_id, "is_estimate": True, "items": items,
            "total_credits": total if total is not None and math.isfinite(total) else None,
            "note": "예상 크레딧이며 실제 청구액과 다를 수 있습니다. 견적 조회는 생성하거나 실행을 승인하지 않습니다."}


async def _execute(ctx, plan_id):
    if not ctx.client["can_execute"]:
        raise HTTPException(403, "앱에서 이 클라이언트의 실행을 허용하세요.", headers={"X-MVHub-MCP-Error": "execution_not_allowed"})
    plan = await _authorized_plan(ctx, plan_id)
    if plan["status"] != "planned":
        return _public_plan(plan)
    ws = await _validate_items(ctx, plan["items"], plan["workspace"])
    # 실행권 선점도 끝까지 기다린다 — 선점 중 응답이 끊겨 취소되면, 실제로 선점했을 때만 '주의'로 남긴다(아무 항목도 안 보냈다).
    #  그냥 두면 큐 0·항목 pending·계획 executing 으로 멈춰 같은 프로세스에선 다시 실행도 못 했다(Codex 리뷰 P2). 경쟁 실행의 계획은 건드리지 않는다.
    claim = asyncio.ensure_future(asyncio.to_thread(store.claim_plan, ctx.client, plan_id, plan["workspace"]))
    try:
        claimed = await asyncio.shield(claim)
    except asyncio.CancelledError:
        # 선점 스레드의 예외(DB 오류 등)가 원래 취소를 덮지 않게 함께 삼키고 끝난 상태만 본다(Codex 재리뷰 P2) — 취소는 아래 raise 로 그대로
        while not claim.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(claim)
        if not claim.cancelled() and claim.exception() is None and claim.result():
            await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "attention")
        raise
    if not claimed:
        return _public_plan(await asyncio.to_thread(store.get_plan, ctx.client, plan_id))
    # 계획 쓰기는 끝까지 기다린다(to_thread_non_abandon) — 응답이 끊겨 이 작업이 취소돼도 뒤늦게 끝난 쓰기가 아래 '주의'를 덮지 않게.
    sending = None  # 실제로 제출을 부른 항목 — 접수됐을 수 있다
    try:
        for item in plan["items"]:
            item["state"] = "submitting"
            await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "executing")
            try:
                await asyncio.to_thread(_still_current, ctx)
                body = GenRequestIn.model_validate({"workspace": ws, "kind": "create", "idempotency_key": item["idempotency_key"],
                    "create": {key: item[key] for key in ("prompt", "model", "params", "references", "project_id", "folder_path")}})
                sending = item
                result = await gen_requests.create_gen_request(body, _internal(ctx, "/api/gen-requests", submit=True))
                item.update(state="submitted", generation_id=result["id"])
            except Exception as exc:
                code = exc.status_code if isinstance(exc, HTTPException) else None
                # 409 는 '아무것도 만들기 전 거절' 표식이 있을 때만 거절이다 — 같은 열쇠의 기존 요청 등은 접수됐을 수 있다(Codex 리뷰 P2 ④)
                not_started = code == 409 and (exc.headers or {}).get("X-MVHub-Submission") == "not-started"
                rejected = bool(code) and 400 <= code < 500 and (code not in (408, 409, 429) or not_started)
                item.update(state="rejected" if rejected else "uncertain",
                            error="생성 요청이 거부되었습니다." if code and code < 500 else "접수 여부를 확인할 수 없습니다. get_plan으로 확인하세요.")
                await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "attention")
                return _public_plan(await asyncio.to_thread(store.get_plan, ctx.client, plan_id))
            await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "executing")
        await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "submitted")
    except (asyncio.CancelledError, Exception) as exc:
        # 실행 중 취소·계획 저장 실패(F-A-04 — 전엔 일반 예외면 executing 으로 고착). 보내던 항목만 불명확(접수됐을 수 있다),
        #  보내기 전이면 대기로 되돌리고, 접수된 항목은 그대로 둔다. '주의'로 남기고 뒤 항목 제출·자동 재제출은 없다.
        #  이 정리 저장마저 실패하면 그 오류가 그대로 나간다(성공으로 숨기지 않음 — 남은 executing 은 재시작 복구가 본다).
        for item in plan["items"]:
            if item.get("state") == "submitting":
                if item is sending:
                    item.update(state="uncertain", error="접수 여부를 확인할 수 없습니다. get_plan으로 확인하세요.")
                else:
                    item["state"] = "pending"
        await to_thread_non_abandon(store.update_plan, plan_id, plan["items"], "attention")
        if isinstance(exc, asyncio.CancelledError):
            raise
    return _public_plan(await asyncio.to_thread(store.get_plan, ctx.client, plan_id))


@router.post("/client/action")
async def action(body: mcp.ActionIn, ctx=Depends(_client_context)):
    try:
        if body.method == "read_context":
            return await _read(ctx, ReadIn.model_validate(body.args))
        if body.method == "prepare_generation_plan":
            data = PlanIn.model_validate(body.args)
            items = [item.model_dump() for item in data.items]
            ws = await asyncio.to_thread(_request_workspace, ctx, data.workspace_scope, data.workspace_id)
            ws = await _validate_items(ctx, items, ws)
            return _public_plan(await asyncio.to_thread(store.create_plan, ctx.client, data.title, items, ws))
        if body.method == "get_result":
            return await _result(ctx, ResultIn.model_validate(body.args))
        if body.method == "get_generation":
            return await _result_once(ctx, GenerationIn.model_validate(body.args))
        if body.method == "wait_results":
            return await _selected_results(ctx, WaitResultsIn.model_validate(body.args))
        if body.method == "show_results":
            return await _selected_results(ctx, ShowResultsIn.model_validate(body.args), preview=True)
        if body.method == "estimate_plan":
            return await _estimate_plan(ctx, str(PlanId.model_validate(body.args).plan_id))
        if body.method == "add_to_canvas":
            data = CanvasIn.model_validate(body.args)
            plan = await _authorized_plan(ctx, str(data.plan_id))
            scenes = await asyncio.to_thread(_scenes, ctx, plan["workspace"])
            if data.scene_id not in {scene["id"] for scene in scenes}:
                raise HTTPException(404, "현재 워크스페이스의 캔버스를 찾을 수 없습니다.")
            ids = [item["generation_id"] for item in plan["items"] if item["state"] == "submitted" and item["generation_id"]]
            if len(ids) != len(plan["items"]):
                raise HTTPException(409, "모든 항목의 접수가 확인된 뒤 캔버스에 추가하세요.")
            await asyncio.to_thread(_still_current, ctx)
            try:
                return await asyncio.to_thread(store.add_canvas_task, ctx.client, plan["id"], data.scene_id, ids, plan["workspace"])
            except LookupError as exc:  # 확인 뒤 그사이 씬이 지워졌다
                raise HTTPException(404, "현재 워크스페이스의 캔버스를 찾을 수 없습니다.") from exc
        data = PlanId.model_validate(body.args)
        if body.method == "execute_generation_plan":
            return await _execute(ctx, str(data.plan_id))
        if body.method in ("get_plan", "request_execution"):
            return _public_plan(await _authorized_plan(ctx, str(data.plan_id)))
        raise HTTPException(422, "지원하지 않는 MCP 도구입니다.")
    except ValidationError as exc:
        raise HTTPException(422, "MCP 입력 형식이 올바르지 않습니다.", headers={"X-MVHub-MCP-Error": "invalid_input"}) from exc
    except HTTPException as exc:
        code = {401: "permission_denied", 403: "permission_denied", 404: "not_found", 409: "state_conflict",
                422: "invalid_input", 429: "busy"}.get(exc.status_code, "request_failed")
        exc.headers = {"X-MVHub-MCP-Error": code, **(exc.headers or {})}
        raise


@router.get("/app/canvas-tasks")
async def canvas_tasks(request: Request, workspace_scope: Literal["personal", "team"], workspace_id: str | None = None,
                       _headers=Depends(mcp.app_headers)):
    workspace = {"scope": workspace_scope, "id": workspace_id}
    def has_pending():
        with active_account.pinned_account_scope():
            email = norm_email((current_account(request) or {}).get("email")) if config.AUTH_ENABLED else norm_email(active_account.active_email())
            return bool(email) and store.has_canvas_tasks(actor_id(request), email, workspace)
    if not await asyncio.to_thread(has_pending):
        return {"tasks": []}
    ctx = await asyncio.to_thread(_capture, request)
    with active_account.pinned_account_scope(ctx.pin), _proxy.pinned_connection(ctx.upstream):
        await asyncio.to_thread(_still_current, ctx)
        await asyncio.to_thread(_workspace, ctx, workspace)
        return {"tasks": await asyncio.to_thread(store.canvas_tasks, ctx.owner, norm_email(ctx.account["email"]), workspace)}


class CompleteIn(StrictModel):
    workspace: WorkspaceContext


@router.post("/app/canvas-tasks/{task_id}/complete")
async def complete_task(task_id: UUID, body: CompleteIn, ctx=Depends(_app_context)):
    if not await asyncio.to_thread(store.complete_canvas_task, str(task_id), ctx.owner, norm_email(ctx.account["email"]), body.workspace.model_dump()):
        raise HTTPException(404, "캔버스 작업을 찾을 수 없습니다.")
    return {"ok": True}


@router.post("/app/canvas-tasks/{task_id}/cancel")
async def cancel_task(task_id: UUID, body: CompleteIn, ctx=Depends(_app_context)):
    workspace = await asyncio.to_thread(_workspace, ctx, body.workspace.model_dump())
    await asyncio.to_thread(_still_current, ctx)
    if not await asyncio.to_thread(store.cancel_canvas_task, str(task_id), ctx.owner, norm_email(ctx.account["email"]), workspace):
        raise HTTPException(404, "취소할 대기 작업을 찾을 수 없습니다. 이미 완료되었을 수 있습니다.")
    return {"ok": True}
