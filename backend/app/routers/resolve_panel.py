"""Resolve 패널 HTTP 입구 — 일반 인증 뒤 로컬·계정 문맥을 추가 확인한다."""
from __future__ import annotations

import asyncio
from contextlib import nullcontext

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import active_account, config, repo
from ..services import resolve_panel as panel, resolve_queue, resolve_status_runner as runner, resolve_transfer
from . import _proxy, projects, resolve_integration as integration

router = APIRouter(prefix="/api/resolve/panel", tags=["resolve"])


class Context(BaseModel):
    instance: str = Field(min_length=1, max_length=100)
    account: str = Field(min_length=1, max_length=100)
    epoch: int = Field(ge=0)


class PanelIn(BaseModel):
    ctx: Context
    window: str = Field(default="", max_length=80)
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
    bin_id: str | None = None
    item_ids: list[str] = Field(default_factory=list, max_length=500)


class StageIn(PanelIn):
    seq: int = Field(ge=0)
    gen_ids: list[str] = Field(default_factory=list, max_length=200)
    capped: bool = False


class UnstageIn(PanelIn):
    bin_id: str = Field(min_length=1, max_length=200)
    inventory_cleanup: bool = False


async def _project_read(request, project_id):
    await asyncio.to_thread(projects._require_project_read, request, project_id)
    if _proxy.proxying():
        visible = await asyncio.to_thread(_proxy.proxy_json, "GET", "/api/projects?tab=team")
        if not any(row.get("id") == project_id for row in visible.get("projects", [])):
            raise HTTPException(403, "프로젝트 권한이 없습니다")


def _base_payload(operation, ctx):
    return {"operation": operation, "hub_key": panel.hub_key(), "media_root": str(config.MEDIA_DIR), "account": ctx["account"]}


async def _inventory(ctx, request, after=None, *, include_recovery=False):
    monitor = integration.resolve_selection_monitor
    def before_read():
        panel.check_context(ctx, request)
        return {"state": "busy"} if monitor._held() else None
    return await asyncio.to_thread(runner.run_resolve_panel_isolated,
                                   {**_base_payload("inventory", ctx), "after": after,
                                    "recovery_records": panel.records("adopt", ctx) if include_recovery else []}, before_start=before_read)


async def _authorized(body, request, ids):
    ids = integration._clean_gen_ids(ids)
    generations = []
    for start in range(0, len(ids), 500):
        project_id, batch = await integration._authorized_generations(ids[start:start + 500], request)
        if project_id != body.project_id or any(str(gen.get("folder_path") or "") != body.folder_path for gen in batch):
            raise HTTPException(400, "요청한 프로젝트·폴더와 생성물의 위치가 다릅니다")
        generations.extend(batch)
    return generations


async def _operate(operation, body, request, ctx):
    if operation not in {"cache", "current-bin", "inventory"}:
        await _project_read(request, body.project_id)
    if operation in {"cache", "prepare"}:
        ids = body.gen_ids if operation == "cache" else [body.gen_id]
        generations = await _authorized(body, request, ids)
        panel.check_context(ctx, request)
        if operation == "cache":
            return await panel.cache(ctx, body.seq, generations, window=body.window, request=request)
        return await panel.prepare(ctx, generations[0], request=request)

    monitor = integration.resolve_selection_monitor
    if operation == "inventory":
        result = await _inventory(ctx, request, body.get("after"), include_recovery=True)
        if result.get("state") != "ok":
            return result
        visible = []
        rows = result.get("items", [])
        for row in rows:
            try:
                await _project_read(request, row["project_id"])
                # 폴더는 빈 이름에서 추측하지 않고 권한을 확인한 생성물에서 읽는다.
                _, generations = await integration._authorized_generations([row["gen_id"]], request)
                gen = next((gen for gen in generations if gen["id"] == row["gen_id"] and gen["project_id"] == row["project_id"]), None)
                if gen:
                    visible.append({**row, "folder_path": gen["folder_path"], "recovery": "ready" in row})
            except HTTPException:
                continue
        counts = {"other_owner": 0, "needs_attention": 0}
        for project_id, values in result.pop("project_counts", {}).items():
            try:
                await _project_read(request, project_id)
                for key in counts:
                    counts[key] += values[key]
            except HTTPException:
                continue
        return {**result, **counts, "items": visible, "active_bin_id": panel._owner["bin_id"]}
    if operation == "current-bin":
        if monitor._held():
            return {"state": "busy"}

        def before_read():
            panel.check_context(ctx, request)
            return {"state": "busy"} if monitor._held() else None

        payload = _base_payload(operation, ctx)
        if body and body.get("project_id"):
            await _project_read(request, body["project_id"])
            payload.update(body)
            payload["project_name"] = await asyncio.to_thread(panel.project_name, ctx, body["project_id"])
        return await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_read)

    ready = None
    if operation == "adopt":
        await _authorized(body, request, [body.gen_id])
        recovery = [row for row in panel.records("adopt", ctx, body.resolve_project_id)
                    if row["gen_id"] == body.gen_id and row["project_id"] == body.project_id]
        ready = panel.prepared(ctx, body.project_id, body.folder_path, body.gen_id)
        if ready is None and recovery:
            ready = recovery[0]["ready"]
        if ready is None:
            return {"state": "not_prepared", "details": {}}
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "gen_id": body.gen_id, "resolve_project_id": body.resolve_project_id,
                   "manifest_root": ready["manifest_root"], "path": ready["item"]["local_path"]}
        after = None
        candidates = []
        while True:
            inventory = await _inventory(ctx, request, after)
            if inventory.get("state") != "ok":
                return inventory
            if inventory["resolve_project_id"] != body.resolve_project_id:
                return {"state": "project_changed"}
            candidates.extend(row for row in inventory["items"] if row["gen_id"] == body.gen_id and row["project_id"] == body.project_id)
            if not inventory.get("more"):
                break
            after = inventory["after"]
        if body.item_ids and not set(body.item_ids).issubset({row["item_id"] for row in candidates + recovery}):
            return {"state": "conflict"}
        if body.bin_id and not any(row["bin_id"] == body.bin_id for row in candidates + recovery):
            return {"state": "not_seen"}
        known = {row["item_id"] for row in recovery}
        for row in candidates:
            if row["item_id"] not in known:
                recovery.append({**row, "account": ctx["account"], "hub_key": panel.hub_key(),
                                 "local_path": row["path"], "nas_path": ready["item"]["local_path"], "ready": ready})
        panel.check_context(ctx, request)
        for row in recovery:
            await asyncio.to_thread(panel.save_record, "adopt", row)
        payload["records"] = recovery
    elif operation in {"stage", "unstage"}:
        source_root, manifest_root = await asyncio.to_thread(resolve_transfer.resolve_transfer_roots, body.project_id)
        panel.validate_media_root(source_root)
        generations = await _authorized(body, request, body.gen_ids) if operation == "stage" and body.gen_ids else []
        channel = "stage:" + body.project_id + ":" + body.folder_path
        if operation == "stage" and panel.stale(ctx, body.seq, channel, body.window):
            return {"state": "stale"}
        if operation == "unstage" and body.inventory_cleanup and body.bin_id == panel._owner["bin_id"]:
            return {"state": "active_bin"}
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "manifest_root": str(manifest_root), "items": await panel.stage_items(ctx, generations, request),
                   "capped": getattr(body, "capped", False) or len(generations) > 200, "import_records": panel.records("import", ctx, include_foreign=True)}
        if operation == "unstage":
            payload["bin_id"] = body.bin_id
        payload["same_file_ids"] = list(panel._same_files.get((*panel.context_key(ctx), body.window, body.project_id, body.folder_path), set()))
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
    if not payload["project_name"] and ready:
        payload["project_name"] = ready["project_name"]
    payload.update(_base_payload(operation, ctx))

    def before_write():
        panel.check_context(ctx, request)
        integration._reject_if_update_in_progress()
        integration._reject_while_launching()
        if operation == "target" and panel.stale(ctx, body.seq, "target", body.window):
            return {"state": "stale"}
        if operation == "stage" and panel.stale(ctx, body.seq, channel, body.window):
            return {"state": "stale"}
        return None

    async def write():
        panel.check_context(ctx, request)
        async with monitor.suspended():
            result = await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_write)
            panel.check_context(ctx, request)
            if operation == "target" and result.get("state") == "ok":
                panel.remember_bin(result.get("bin_id", ""))
            if operation in {"stage", "unstage"}:
                same_key = (*panel.context_key(ctx), body.window, body.project_id, body.folder_path)
                panel._same_files.setdefault(same_key, set()).update(row["gen_id"] for row in result.get("items", []) if row["state"] == "same_file_exists")
                for row in result.get("import_records", []):
                    await asyncio.to_thread(panel.save_record, "import", row)
                completed = {row["gen_id"] for row in result.get("items", []) if row["state"] in {"staged", "present"}}
                old = [row for row in panel.records("import", ctx, result.get("resolve_project_id"))
                       if row["project_id"] == body.project_id and row["gen_id"] in completed]
                await asyncio.to_thread(panel.remove_records, "import", old)
            if operation == "adopt":
                missing = set(result.get("missing_record_ids", []))
                await asyncio.to_thread(panel.remove_records, "adopt", [row for row in recovery if row["item_id"] in missing])
                replacements = result.get("adoption_candidates", [])
                if replacements:
                    # 자식이 새로 찾은 소유 항목도 바꿔 끼우기 전에 먼저 디스크 증거를 남긴다.
                    payload["records"] = [row for row in recovery if row["item_id"] not in missing]
                    for row in replacements:
                        record = {**row, "account": ctx["account"], "hub_key": payload["hub_key"],
                                  "local_path": row["path"], "nas_path": ready["item"]["local_path"], "ready": ready}
                        panel.check_context(ctx, request)
                        await asyncio.to_thread(panel.save_record, "adopt", record)
                        recovery.append(record)
                        payload["records"].append(record)
                    result = await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_write)
                    panel.check_context(ctx, request)
                    result["missing_record_ids"] = list(missing | set(result.get("missing_record_ids", [])))
                    await asyncio.to_thread(panel.remove_records, "adopt", [row for row in recovery if row["item_id"] in result["missing_record_ids"]])
            if operation == "adopt" and result.get("state") == "in_bin":
                result = await panel.record_adoption(ctx, body.project_id, body.gen_id, {**ready, "project_name": payload["project_name"]}, result, request=request)
                if result.get("state") == "in_bin":
                    await asyncio.to_thread(panel.remove_records, "adopt", recovery)
            return result

    key = (operation, *panel.context_key(ctx), body.project_id, body.folder_path,
           body.window, body.model_dump_json())
    return await panel.joined(key, write)


async def _request(operation, body, request, ctx):
    integration._require_local_resolve(request)

    async def execute():
        try:
            panel.check_context(ctx, request)
            generation = panel.owner_generation(ctx, getattr(body, "window", ""))
            pin = await asyncio.to_thread(active_account.capture_account_pin)
            panel.check_context(ctx, request)
            if operation in {"cache", "target"}:
                # 두 요청의 seq는 같은 화면 선택 순번이다 — 빈 선택만 먼저 와도 옛 캐시는 멈춘다.
                panel.note_sequence(ctx, body.seq, "cache", body.window)
                panel.note_sequence(ctx, body.seq, "target", body.window)
            if operation == "stage":
                panel.note_sequence(ctx, body.seq, "stage:" + body.project_id + ":" + body.folder_path, body.window)
            with active_account.pinned_account_scope(pin):
                upstream = await asyncio.to_thread(lambda: (_proxy.base_url(), _proxy.token()) if _proxy.proxying() else None)
                panel.check_context(ctx, request)
                with _proxy.pinned_connection(upstream):
                    if operation != "cache":
                        integration._reject_while_launching()
                    async with integration._tracked_resolve_transfer() if operation not in {"current-bin", "inventory"} else nullcontext():
                        if operation not in {"current-bin", "inventory"}:
                            await asyncio.to_thread(integration._reject_if_update_in_progress)
                        if operation in {"target", "stage", "unstage", "prepare", "adopt"}:
                            async with panel.mutation_scope():
                                panel.check_context(ctx, request)
                                if generation is None or generation != panel.owner_generation(ctx, body.window):
                                    return {"state": "other_window"}
                                result = await _operate(operation, body, request, ctx)
                        else:
                            result = await _operate(operation, body, request, ctx)
                        panel.check_context(ctx, request)
                        if operation == "adopt":
                            if result.get("state") == "unavailable":
                                result = {**result, "state": "unknown"}
                            result.setdefault("details", {})
                        return result
        except panel.AccountChanged as exc:
            return {"state": "account_changed", "details": str(exc)}
        except TimeoutError:
            return {"state": "busy"}
        except resolve_transfer.ResolveTransferError as exc:
            raise HTTPException(400, str(exc)) from exc

    # 보호 핸들·고정 계정·장부 기록까지 한 단위로 끝낸 뒤 요청 취소를 전파한다.
    if operation in {"prepare", "stage", "unstage", "adopt", "target"}:
        key = ("request", operation, *panel.context_key(ctx), body.model_dump_json())
        return await resolve_queue.run_non_abandon(panel.joined(key, execute))
    return await resolve_queue.run_non_abandon(execute())


@router.get("/identity")
async def get_identity(request: Request, window: str = "", claim: bool = False):
    integration._require_local_resolve(request)
    if len(window) > 80 or (claim and not window):
        raise HTTPException(400, "창 ID를 확인하세요")
    try:
        return await panel.window_identity(request, window, claim)
    except TimeoutError:
        raise HTTPException(409, "다른 변경 작업이 끝나기를 기다리고 있습니다")


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
async def get_current_bin(request: Request, instance: str, account: str, epoch: int, project_id: str = "", folder_path: str = ""):
    return await _request("current-bin", {"project_id": project_id, "folder_path": folder_path}, request, {"instance": instance, "account": account, "epoch": epoch})


@router.get("/inventory")
async def get_inventory(request: Request, instance: str, account: str, epoch: int, after: str = ""):
    import json
    try:
        cursor = json.loads(after) if after else None
        if cursor is not None and (not isinstance(cursor, list) or len(cursor) != 2 or not all(isinstance(value, str) for value in cursor)):
            raise ValueError()
    except ValueError as exc:
        raise HTTPException(400, "이어 보기 위치가 잘못되었습니다") from exc
    return await _request("inventory", {"after": cursor}, request, {"instance": instance, "account": account, "epoch": epoch})


@router.post("/stage")
async def post_stage(body: StageIn, request: Request):
    return await _request("stage", body, request, body.ctx.model_dump())


@router.post("/unstage")
async def post_unstage(body: UnstageIn, request: Request):
    return await _request("unstage", body, request, body.ctx.model_dump())


@router.post("/adopt")
async def post_adopt(body: AdoptIn, request: Request):
    return await _request("adopt", body, request, body.ctx.model_dump())
