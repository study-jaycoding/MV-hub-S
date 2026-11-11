"""Resolve 패널 HTTP 입구 — 일반 인증 뒤 로컬·계정 문맥을 추가 확인한다."""
from __future__ import annotations

import asyncio
from contextlib import nullcontext

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import active_account, repo
from ..services import resolve_panel as panel, resolve_queue, resolve_status_runner as runner, resolve_transfer
from . import _proxy, projects, resolve_integration as integration

router = APIRouter(prefix="/api/resolve/panel", tags=["resolve"])


class Context(BaseModel):
    instance: str = Field(min_length=1, max_length=100)
    account: str = Field(min_length=1, max_length=100)
    epoch: int = Field(ge=0)


class PanelIn(BaseModel):
    ctx: Context
    project_id: str = Field(min_length=1, max_length=200)
    folder_path: str = Field(min_length=1, max_length=2000)


class CacheIn(PanelIn):
    window: str = Field(min_length=1, max_length=80)
    seq: int = Field(ge=0)
    gen_ids: list[str] = Field(min_length=1, max_length=500)


class PrepareIn(PanelIn):
    gen_id: str = Field(min_length=1, max_length=200)


class TargetIn(PanelIn):
    window: str = Field(min_length=1, max_length=80)
    seq: int = Field(ge=0)
    create: bool = False


class AdoptIn(PrepareIn):
    resolve_project_id: str = Field(min_length=1, max_length=200)


async def _authorized(body, request, ids):
    project_id, generations = await integration._authorized_generations(integration._clean_gen_ids(ids), request)
    if project_id != body.project_id or any(str(gen.get("folder_path") or "") != body.folder_path for gen in generations):
        raise HTTPException(400, "요청한 프로젝트·폴더와 생성물의 위치가 다릅니다")
    return generations


async def _operate(operation, body, request, ctx):
    if operation in {"cache", "prepare"}:
        ids = body.gen_ids if operation == "cache" else [body.gen_id]
        generations = await _authorized(body, request, ids)
        panel.check_context(ctx, request)
        if operation == "cache":
            return await panel.cache(ctx, body.seq, generations, window=body.window, request=request)
        return await panel.prepare(ctx, generations[0], request=request)

    monitor = integration.resolve_selection_monitor
    if operation == "current-bin":
        if monitor._held():
            return {"state": "busy"}

        def before_read():
            panel.check_context(ctx, request)
            return {"state": "busy"} if monitor._held() else None

        return await asyncio.to_thread(runner.run_resolve_panel_isolated, {"operation": operation}, before_start=before_read)

    ready = None
    if operation == "adopt":
        ready = panel.prepared(ctx, body.project_id, body.folder_path, body.gen_id)
        if ready is None:
            return {"state": "not_prepared", "details": {}}
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "gen_id": body.gen_id, "resolve_project_id": body.resolve_project_id,
                   "manifest_root": ready["manifest_root"], "path": ready["item"]["local_path"]}
    else:
        if panel.stale(ctx, body.seq, "target", body.window):
            return {"state": "stale"}
        await asyncio.to_thread(projects._require_project_read, request, body.project_id)
        if _proxy.proxying():
            # 위임 모드의 프로젝트 열람은 공유 서버가 판정한다 — 로컬 역할 우회로 끝내지 않는다.
            visible = await asyncio.to_thread(_proxy.proxy_json, "GET", "/api/projects?tab=team")
            if not any(row.get("id") == body.project_id for row in visible.get("projects", [])):
                raise HTTPException(403, "프로젝트 권한이 없습니다")
        panel.check_context(ctx, request)
        _source_root, manifest_root = await asyncio.to_thread(resolve_transfer.resolve_transfer_roots, body.project_id)
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "manifest_root": str(manifest_root), "create": body.create}

    payload["project_name"] = await asyncio.to_thread(panel.project_name, ctx, body.project_id)

    def before_write():
        panel.check_context(ctx, request)
        integration._reject_if_update_in_progress()
        integration._reject_while_launching()
        if operation == "target" and panel.stale(ctx, body.seq, "target", body.window):
            return {"state": "stale"}
        return None

    async def write():
        panel.check_context(ctx, request)
        async with monitor.suspended():
            result = await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_write)
            panel.check_context(ctx, request)
            if operation == "adopt" and result.get("state") == "in_bin":
                result = await panel.record_adoption(ctx, body.project_id, body.gen_id, {**ready, "project_name": payload["project_name"]}, result, request=request)
            return result

    key = (operation, *panel.context_key(ctx), body.project_id, body.folder_path,
           body.window if operation == "target" else "",
           body.seq if operation == "target" else body.gen_id,
           body.create if operation == "target" else body.resolve_project_id)
    return await panel.joined(key, write)


async def _request(operation, body, request, ctx):
    integration._require_local_resolve(request)

    async def execute():
        try:
            panel.check_context(ctx, request)
            pin = await asyncio.to_thread(active_account.capture_account_pin)
            panel.check_context(ctx, request)
            if operation in {"cache", "target"}:
                # 두 요청의 seq는 같은 화면 선택 순번이다 — 빈 선택만 먼저 와도 옛 캐시는 멈춘다.
                panel.note_sequence(ctx, body.seq, "cache", body.window)
                panel.note_sequence(ctx, body.seq, "target", body.window)
            with active_account.pinned_account_scope(pin):
                upstream = await asyncio.to_thread(lambda: (_proxy.base_url(), _proxy.token()) if _proxy.proxying() else None)
                panel.check_context(ctx, request)
                with _proxy.pinned_connection(upstream):
                    if operation in {"target", "adopt", "current-bin"}:
                        integration._reject_while_launching()
                    async with integration._tracked_resolve_transfer() if operation != "current-bin" else nullcontext():
                        if operation != "current-bin":
                            await asyncio.to_thread(integration._reject_if_update_in_progress)
                        result = await _operate(operation, body, request, ctx)
                        panel.check_context(ctx, request)
                        if operation == "adopt":
                            if result.get("state") == "unavailable":
                                result = {**result, "state": "unknown"}
                            result.setdefault("details", {})
                        return result
        except panel.AccountChanged as exc:
            return {"state": "account_changed", "details": str(exc)}
        except resolve_transfer.ResolveTransferError as exc:
            raise HTTPException(400, str(exc)) from exc

    # 보호 핸들·고정 계정·장부 기록까지 한 단위로 끝낸 뒤 요청 취소를 전파한다.
    return await resolve_queue.run_non_abandon(execute())


@router.get("/identity")
async def get_identity(request: Request):
    integration._require_local_resolve(request)
    return await asyncio.to_thread(panel.identity, request)


@router.post("/cache")
async def post_cache(body: CacheIn, request: Request):
    return await _request("cache", body, request, body.ctx.model_dump())


@router.post("/prepare")
async def post_prepare(body: PrepareIn, request: Request):
    return await _request("prepare", body, request, body.ctx.model_dump())


@router.post("/target")
async def post_target(body: TargetIn, request: Request):
    return await _request("target", body, request, body.ctx.model_dump())


@router.get("/current-bin")
async def get_current_bin(request: Request, instance: str, account: str, epoch: int):
    return await _request("current-bin", None, request, {"instance": instance, "account": account, "epoch": epoch})


@router.post("/adopt")
async def post_adopt(body: AdoptIn, request: Request):
    return await _request("adopt", body, request, body.ctx.model_dump())
