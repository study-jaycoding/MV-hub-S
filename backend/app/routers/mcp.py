"""Local-only MCP mailbox and durable plans; no generation execution endpoint."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field, StrictBool

from .. import repo
from ..db_paths import get_db_path
from ..deps import actor_id, session_token
from ..mcp_models import McpApproval, McpItemUpdate, McpPlanIn, McpRevision, StrictModel
from ..services.mcp_broker import BrokerError, McpBroker, digest
from ..services.request_guards import require_loopback_browser_request

router = APIRouter(prefix="/api/mcp", tags=["mcp"])
broker = McpBroker()
_ROOT = Path(__file__).resolve().parents[3]


def _translate(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except BrokerError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


def _secret(request: Request, header: str) -> str:
    values = request.headers.getlist(header)
    if len(values) != 1:
        raise HTTPException(403, "연결 인증이 필요합니다.")
    value = values[0]
    if not 32 <= len(value) <= 128 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in value):
        raise HTTPException(403, "연결 인증이 올바르지 않습니다.")
    return value


async def _size(request: Request, maximum: int):
    if len(await request.body()) > maximum:
        raise HTTPException(413, "요청이 너무 큽니다. 항목 수나 입력을 줄이세요.")


async def client_guard(request: Request) -> str:
    require_loopback_browser_request(request, "MCP는 이 PC의 비브라우저 연결만 허용합니다.")
    if any(name in request.headers for name in ("origin", "referer", "sec-fetch-site")):
        raise HTTPException(403, "브라우저는 MCP 클라이언트 경로를 사용할 수 없습니다.")
    if request.headers.getlist("x-mvhub-mcp") != ["1"]:
        raise HTTPException(403, "MCP 연결 헤더가 필요합니다.")
    await _size(request, 64 * 1024)
    return _secret(request, "x-mvhub-mcp-secret")


def _identity(request: Request) -> tuple[str, str, Path]:
    owner, path = actor_id(request), get_db_path()
    # Password/session rotation and account DB switching revoke the bridge.
    binding = digest(owner + "\0" + str(path) + "\0" + (session_token(request) or ""))
    return owner, binding, path


async def app_headers(request: Request) -> tuple[str, str, Path, str]:
    require_loopback_browser_request(request, "AI 연결은 이 PC의 앱에서만 사용할 수 있습니다.")
    maximum = 260 * 1024 if request.url.path.endswith("/reply") else 64 * 1024
    if request.url.path == "/api/mcp/plans" and request.method == "POST":
        maximum = 256 * 1024
    await _size(request, maximum)
    owner, binding, path = _identity(request)
    return owner, binding, path, _secret(request, "x-mvhub-tab")


async def app_guard(identity=Depends(app_headers)):
    owner, binding, path, tab = identity
    _translate(broker.app_guard, binding, tab)
    return identity


class ConnectIn(StrictModel):
    name: str = Field(default="MV Hub MCP", min_length=1, max_length=80)


class ActionIn(StrictModel):
    method: str = Field(max_length=50)
    args: dict[str, Any] = Field(default_factory=dict)


class PairIn(StrictModel):
    pair_code: str = Field(pattern=r"^\d{6}$")
    allow_execution: StrictBool = False


class ReplyIn(StrictModel):
    id: UUID
    result: dict[str, Any] | None = None
    error: str | None = Field(default=None, max_length=1000)


@router.post("/client/connect")
async def connect(body: ConnectIn, secret=Depends(client_guard)):
    return _translate(broker.connect, secret, body.name)


@router.post("/client/action")
async def action(body: ActionIn, secret=Depends(client_guard)):
    _translate(broker.client_guard, secret)
    return _translate(broker.enqueue, body.method, body.args)


@router.get("/client/result")
async def result(id: UUID, secret=Depends(client_guard)):
    try:
        return await broker.result(secret, str(id))
    except BrokerError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/app/pair")
async def pair(body: PairIn, identity=Depends(app_headers)):
    _, binding, _, tab = identity
    return _translate(broker.pair, body.pair_code, binding, tab, allow_execution=body.allow_execution)


@router.get("/app/setup")
async def setup(request: Request, identity=Depends(app_headers)):
    server = request.scope.get("server")
    if not server or len(server) != 2 or type(server[1]) is not int or not 0 < server[1] <= 65535:
        raise HTTPException(503, "실제 허브 포트를 확인하지 못했습니다. 로컬 앱에서 다시 확인하세요.")
    # Vite/Host 헤더의 프런트 포트가 아니라 실제 수신 소켓을 사용한다.
    host = "[::1]" if ":" in str(server[0]) else "127.0.0.1"
    adapter = _ROOT / "tools" / "mcp_adapter" / "server.py"
    runtime = _ROOT / "runtime" / "python"
    python_args = []
    if (_ROOT / "VERSION.txt").is_file() or runtime.exists():
        python = runtime / "python.exe"
        sdk = adapter.parent / "site-packages" / "mcp" / "__init__.py"
        if not all(path.is_file() for path in (python, adapter, sdk)):
            raise HTTPException(503, "MCP 번들이 불완전합니다. 앱을 다시 설치하세요.")
        python_args = ["-I", "-S"]
    else:
        local = os.environ.get("LOCALAPPDATA")
        python = Path(local) / "MVHub-MCP" / "venv" / "Scripts" / "python.exe" if local else None
    return {"url": f"http://{host}:{server[1]}", "adapter": str(adapter), "adapter_exists": adapter.is_file(),
            "python": str(python) if python else None, "python_exists": bool(python and python.is_file()),
            "python_args": python_args}


@router.get("/app/next")
async def next_action(identity=Depends(app_guard)):
    _, binding, _, tab = identity
    try:
        return await broker.next(binding, tab)
    except BrokerError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/app/reply")
async def reply(body: ReplyIn, identity=Depends(app_guard)):
    _translate(broker.reply, str(body.id), body.result, body.error)
    return {"ok": True}


@router.get("/app/check")
async def check(identity=Depends(app_guard)):
    return {"ok": True}


@router.post("/app/close")
async def close(identity=Depends(app_guard)):
    broker.close()
    return {"ok": True}


@router.post("/plans", status_code=201)
async def create_plan(body: McpPlanIn, identity=Depends(app_guard)):
    owner, _, path, _ = identity
    return await asyncio.to_thread(repo.create_mcp_plan, owner, body.model_dump(), path, broker.client["name"])


@router.get("/plans/{pid}")
async def plan(pid: UUID, identity=Depends(app_guard)):
    owner, _, path, _ = identity
    result = await asyncio.to_thread(repo.get_mcp_plan, owner, str(pid), path)
    if result is None:
        raise HTTPException(404, "계획을 찾을 수 없습니다.")
    return result


async def _update(pid: UUID, body: McpRevision, identity, **kwargs):
    owner, _, path, _ = identity
    try:
        result = await asyncio.to_thread(repo.update_mcp_plan, owner, str(pid), body.revision, path, **kwargs)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if result is None:
        raise HTTPException(404, "계획을 찾을 수 없습니다.")
    return result


@router.post("/plans/{pid}/approve")
async def approve(pid: UUID, body: McpApproval, identity=Depends(app_guard)):
    if body.source == "mcp":
        _, binding, _, tab = identity
        _translate(broker.app_guard, binding, tab)
        _translate(broker.require_execution)
    return await _update(pid, body, identity, approval_source=body.source)


@router.post("/plans/{pid}/item")
async def item(pid: UUID, body: McpItemUpdate, identity=Depends(app_guard)):
    return await _update(pid, body, identity, index=body.index, state=body.state, error=body.error)
