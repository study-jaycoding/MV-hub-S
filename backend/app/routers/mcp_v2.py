"""Local, persistent MCP clients using the same authorized read and generation routes."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import importlib.util
import io
import json
import math
import secrets
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode, urlsplit
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import Field, StrictBool, ValidationError, model_validator
from starlette.responses import FileResponse

from .. import active_account, config, repo
from ..db_paths import get_db_path
from ..deps import actor_id, current_account, resolve_agent_account
from ..emailnorm import norm_email
from ..mcp_models import StrictModel
from ..models import GenRequestIn, WorkspaceContext
from ..repo import mcp_v2 as store
from ..services import auth, cli_bridge, thumbs
from ..services.path_safety import safe_join
from . import _proxy, assets, gen_requests, generation, library, manage, mcp, projects

router = APIRouter(prefix="/api/mcp/v2", tags=["mcp"])
_registration_lock = threading.Lock()


def hub_id():
    path = str(get_db_path().resolve()).casefold()
    return hmac.new(auth.get_secret().encode(), ("mcp-hub-id\0" + path).encode(), hashlib.sha256).hexdigest()


def _required_hub_id():
    try:
        return hub_id()
    except auth.AuthSecretUnavailable as exc:
        raise HTTPException(503, "DB 유지보수 중입니다. 잠시 후 다시 시도하세요.", headers={"Retry-After": "5"}) from exc


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
            status, account = _proxy.raw_request("GET", base + "/api/auth/me", token=token, timeout=5)
            if status != 200 or not isinstance(account, dict) or norm_email(account.get("email")) != email:
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
                store.revoke_replaced_clients(cid, ctx.owner, email, name)
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
            result.append({"id": row["id"], "name": row.get("name") or scene.get("name")})
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
    return library.list_generations(_internal(ctx, "/api/generations", params), BackgroundTasks(),
        tab="my", limit=args.limit, lean_params=0, workspace_id=ws["id"], workspace_ids=[],
        workspace_scope="personal" if ws["scope"] == "personal" else None,
        project_id=args.project_id, search=args.search, colors=[], tags=[], auto_tags=[],
        share_dir=None, media_type=None)


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
            raise HTTPException(409, "참고 자료가 바뀌었습니다. 다시 조회해 계획을 만드세요.")
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
    return {"generations": [{key: row.get(key) for key in ("id", "prompt", "model", "status", "project_id", "folder_path", "workspace_scope", "workspace_id")} for row in rows]}


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
            raise HTTPException(422, "지원하지 않는 모델 옵션입니다.")
        kind = str(field.get("type", "string")).split("|")[0]
        valid = ((kind == "integer" and type(value) is int) or (kind in ("number", "float") and type(value) in (int, float) and math.isfinite(value))
                 or (kind == "boolean" and type(value) is bool) or (kind == "string" and isinstance(value, str)))
        if not valid or (field.get("enum") and str(value) not in {str(v) for v in field["enum"]}):
            raise HTTPException(422, "모델 옵션 형식이나 선택값이 잘못되었습니다.")
        if isinstance(value, str) and (len(value) > 500 or "://" in value or "\\" in value or "/" in value):
            raise HTTPException(422, "자료 경로는 모델 옵션으로 받지 않습니다. reference_ids를 사용하세요.")
        for bound, compare in (("minimum", lambda a, b: a < b), ("maximum", lambda a, b: a > b)):
            if bound in field and type(value) in (int, float) and compare(value, field[bound]):
                raise HTTPException(422, "모델 옵션이 허용 범위를 벗어났습니다.")


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


def _public_plan(plan):
    if plan is None:
        raise HTTPException(404, "계획을 찾을 수 없습니다.")
    result = {"id": plan["id"], "plan_id": plan["id"], "title": plan["title"], "status": plan["status"], "workspace": plan["workspace"],
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
        if max(image.size) > 512:
            return None
        image.verify()
    return data


async def _result(ctx, args):
    plan = await _authorized_plan(ctx, str(args.plan_id))
    if args.item_index >= len(plan["items"]):
        raise HTTPException(404, "계획 항목을 찾을 수 없습니다.")
    item = plan["items"][args.item_index]
    result = {"plan_id": plan["id"], "item_index": args.item_index, "asset_index": args.asset_index,
              "generation_id": item.get("generation_id"), "generation_status": item.get("generation_status"),
              "asset_type": None, "media": None, "note": "아직 완료된 미리보기가 없습니다. get_plan으로 상태를 확인하세요."}
    if result["generation_id"]:
        row = await asyncio.to_thread(library.get_generation, result["generation_id"],
                                      _internal(ctx, "/api/generations/" + result["generation_id"]))
        creator = ctx.owner if config.AUTH_ENABLED else ctx.account.get("creator_uid")
        if (not _matches(row, plan["workspace"]) or
                (row.get("creator_uid") and row["creator_uid"] != creator)):
            raise HTTPException(404, "생성 결과를 찾을 수 없습니다.")
        result["generation_status"] = row.get("status")
        assets_list = row.get("assets", [])
        if row.get("status") == "done":
            result["note"] = "완료되었지만 선택한 미디어가 없습니다. 앱에서 결과를 확인하세요."
        if row.get("status") == "done" and args.asset_index < len(assets_list):
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
            if source:
                try:
                    # Only server-selected assets reach the existing SSRF-safe thumbnail route.
                    for width in (512, 256):
                        response = await library.media_thumb(src=source, w=width)
                        data = await asyncio.to_thread(_read_preview, response)
                        if data is not None:
                            result["media"] = {"mime": "image/jpeg", "data_base64": base64.b64encode(data).decode("ascii")}
                            result["note"] = "완료된 결과의 미리보기입니다."
                            break
                except (HTTPException, OSError, ValueError):
                    pass
    await asyncio.to_thread(_workspace, ctx, plan["workspace"])
    await asyncio.to_thread(_still_current, ctx)
    return result


async def _execute(ctx, plan_id):
    if not ctx.client["can_execute"]:
        raise HTTPException(403, "앱에서 이 클라이언트의 실행을 허용하세요.")
    plan = await _authorized_plan(ctx, plan_id)
    if plan["status"] != "planned":
        return _public_plan(plan)
    ws = await _validate_items(ctx, plan["items"], plan["workspace"])
    if not await asyncio.to_thread(store.claim_plan, ctx.client, plan_id, plan["workspace"]):
        return _public_plan(await asyncio.to_thread(store.get_plan, ctx.client, plan_id))
    for item in plan["items"]:
        item["state"] = "submitting"
        await asyncio.to_thread(store.update_plan, plan_id, plan["items"], "executing")
        try:
            await asyncio.to_thread(_still_current, ctx)
            body = GenRequestIn.model_validate({"workspace": ws, "kind": "create", "idempotency_key": item["idempotency_key"],
                "create": {key: item[key] for key in ("prompt", "model", "params", "references", "project_id", "folder_path")}})
            result = await gen_requests.create_gen_request(body, _internal(ctx, "/api/gen-requests", submit=True))
            item.update(state="submitted", generation_id=result["id"])
        except Exception as exc:
            code = exc.status_code if isinstance(exc, HTTPException) else None
            item.update(state="rejected" if code and 400 <= code < 500 and code not in (408, 409, 429) else "uncertain",
                        error="생성 요청이 거부되었습니다." if code and code < 500 else "접수 여부를 확인할 수 없습니다. get_plan으로 확인하세요.")
            await asyncio.to_thread(store.update_plan, plan_id, plan["items"], "attention")
            return _public_plan(await asyncio.to_thread(store.get_plan, ctx.client, plan_id))
        await asyncio.to_thread(store.update_plan, plan_id, plan["items"], "executing")
    await asyncio.to_thread(store.update_plan, plan_id, plan["items"], "submitted")
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
            return await asyncio.to_thread(store.add_canvas_task, ctx.client, plan["id"], data.scene_id, ids, plan["workspace"])
        data = PlanId.model_validate(body.args)
        if body.method == "execute_generation_plan":
            return await _execute(ctx, str(data.plan_id))
        if body.method in ("get_plan", "request_execution"):
            return _public_plan(await _authorized_plan(ctx, str(data.plan_id)))
        raise HTTPException(422, "지원하지 않는 MCP 도구입니다.")
    except ValidationError as exc:
        raise HTTPException(422, "MCP 입력 형식이 올바르지 않습니다.") from exc


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
