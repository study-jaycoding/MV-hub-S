"""MCP 어댑터 독립 업데이트의 로컬 API(/api/mcp/app/adapter*).

앱 계정 확인은 mcp_v2 의 것을 쓴다. mcp_v2 가 routers/mcp 를 import 하므로 이 경로들을 mcp 에 두면 순환이 된다.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field

from ..mcp_models import StrictModel
from ..services import mcp_update
from ..services.async_tools import to_thread_non_abandon
from . import mcp, mcp_v2

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class AdapterUpdateIn(StrictModel):
    expected_manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


async def adapter_context(request: Request, identity=Depends(mcp.app_headers)):
    async for ctx in mcp_v2._app_context(request, identity):
        yield ctx


async def _adapter_call(ctx, function, *args, mutate=False, **kwargs):
    await asyncio.to_thread(mcp_v2._still_current, ctx)
    try:
        result = await (to_thread_non_abandon(function, *args, **kwargs) if mutate else
                        asyncio.to_thread(function, *args, **kwargs))
    except mcp_update.McpUpdateError as exc:
        raise HTTPException(409 if mutate else 503, str(exc)) from exc
    await asyncio.to_thread(mcp_v2._still_current, ctx)
    return result


@router.get("/app/adapter")
async def adapter_status(ctx=Depends(adapter_context)):
    return await _adapter_call(ctx, mcp_update.status, mcp._ROOT)


@router.post("/app/adapter/update")
async def adapter_update(body: AdapterUpdateIn, ctx=Depends(adapter_context)):
    return await _adapter_call(ctx, mcp_update.apply, mcp._ROOT, body.expected_manifest_sha256, mutate=True)


@router.post("/app/adapter/rollback")
async def adapter_rollback(body: AdapterUpdateIn, ctx=Depends(adapter_context)):
    return await _adapter_call(ctx, mcp_update.apply, mcp._ROOT, body.expected_manifest_sha256, rollback=True, mutate=True)
