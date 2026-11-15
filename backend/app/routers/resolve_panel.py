"""Resolve 패널 HTTP 입구 — 일반 인증 뒤 로컬·계정 문맥을 추가 확인한다."""
from __future__ import annotations

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import active_account, config, repo
from ..services import resolve_panel as panel, resolve_queue, resolve_status_runner as runner, resolve_transfer
from . import _proxy, projects, resolve_integration as integration

router = APIRouter(prefix="/api/resolve/panel", tags=["resolve"])


def _require_panel_enabled():
    if integration.resolve_panel_installer.release_disabled():
        raise HTTPException(403, integration.resolve_panel_installer.RELEASE_DISABLED_REASON)


class Context(BaseModel):
    instance: str = Field(min_length=1, max_length=100)
    account: str = Field(min_length=1, max_length=100)
    epoch: int = Field(ge=0)


class PanelIn(BaseModel):
    ctx: Context
    window: str = Field(default="", max_length=80)
    project_id: str = Field(min_length=1, max_length=200)
    folder_path: str = Field(min_length=1, max_length=2000)
    expect_project: str = Field(default="", max_length=200)  # 화면이 본 다빈치 프로젝트 — 쓰기 전에 자식이 대조한다


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
    # 에피소드를 고르면 생성물 있는 컷 빈을 한 번에 만든다 — 200개를 넘으면 자르지 않고 거절한다.
    episode_path: str = Field(default="", max_length=2000)
    create_paths: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(default_factory=list, max_length=200)
    keep_current: bool = False  # 실시간 새 컷 — 만들고 줄 세운 뒤 사람이 보던 지금 빈으로 되돌린다


class AdoptIn(PrepareIn):
    resolve_project_id: str = Field(min_length=1, max_length=200)
    bin_id: str | None = None
    item_ids: list[str] = Field(default_factory=list, max_length=500)
    defer_save: bool = False


class StageIn(PanelIn):
    seq: int = Field(ge=0)
    gen_ids: list[str] = Field(default_factory=list, max_length=200)
    capped: bool = False
    bin_id: str = Field(default="", max_length=200)  # 다빈치에서 들어간 컷 빈을 따라갈 때 — 그 ID 의 빈에만 넣는다


class CutIn(BaseModel):
    folder_path: str = Field(min_length=1, max_length=2000)
    bin_id: str = Field(min_length=1, max_length=200)
    gen_ids: list[str] = Field(default_factory=list, max_length=200)
    capped: bool = False


class PrestageIn(PanelIn):
    """미리 띄우기 조각 — folder_path = 에피소드, 컷마다 이 창이 target 으로 받은 컷 빈 ID."""
    window: str = Field(min_length=1, max_length=80)
    episode_bin_id: str = Field(default="", max_length=200)
    cuts: list[CutIn] = Field(min_length=1, max_length=200)


class RenameIn(PanelIn):
    window: str = Field(min_length=1, max_length=80)
    cuts: list[CutIn] = Field(min_length=1, max_length=200)
    limit: int = Field(default=10, ge=1, le=50)
    after: list[Annotated[int, Field(ge=0)]] | None = Field(default=None, min_length=2, max_length=2)  # 앞 작업이 멈춘 자리 [빈 순번, 클립 순번]


class SaveIn(PanelIn):
    window: str = Field(min_length=1, max_length=80)
    expect_project: str = Field(min_length=1, max_length=200)  # [저장]이 inventory 에서 고정한 다빈치 프로젝트 — 없으면 저장하지 않는다


class SettleBin(BaseModel):
    folder_path: str = Field(min_length=1, max_length=2000)
    bin_id: str = Field(min_length=1, max_length=200)


class SettleIn(PanelIn):
    """앞 에피소드 컷 빈 한 번에 정리 — 이 창이 target 으로 받은 컷 빈만 지운다."""
    window: str = Field(min_length=1, max_length=80)
    bins: list[SettleBin] = Field(min_length=1, max_length=200)


class UnstageIn(PanelIn):
    bin_id: str = Field(min_length=1, max_length=200)
    inventory_cleanup: bool = False  # 빈 지우기는 settle 만 — 옛 delete_empty 는 없앴다(보내도 모르는 필드로 무시)


async def _project_read(request, project_id, visible_projects=None):
    await asyncio.to_thread(projects._require_project_read, request, project_id)
    if _proxy.proxying():
        if visible_projects is None:
            visible = await asyncio.to_thread(_proxy.proxy_json, "GET", "/api/projects?tab=team")
            visible_projects = {row.get("id") for row in visible.get("projects", [])}
        if project_id not in visible_projects:
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
        counts_by_project = result.pop("project_counts", {})
        visible_projects = None
        if (rows or counts_by_project) and _proxy.proxying():
            projects_result = await asyncio.to_thread(_proxy.proxy_json, "GET", "/api/projects?tab=team")
            visible_projects = {row.get("id") for row in projects_result.get("projects", [])}
        allowed = set()
        for project_id in dict.fromkeys([row["project_id"] for row in rows] + list(counts_by_project)):
            try:
                await _project_read(request, project_id, visible_projects)
                allowed.add(project_id)
            except HTTPException as exc:
                if exc.status_code not in {403, 404}:
                    raise
        ids = list(dict.fromkeys(row["gen_id"] for row in rows if row["project_id"] in allowed))
        generations = {}
        for start in range(0, len(ids), 500):
            _, batch = await integration._authorized_generations(ids[start:start + 500], request, visible_only=True)
            generations.update((gen["id"], gen) for gen in batch)
        for row in rows:
            gen = generations.get(row["gen_id"])
            if row["project_id"] in allowed and gen and gen["project_id"] == row["project_id"]:
                visible.append({**row, "folder_path": gen["folder_path"], "recovery": "ready" in row})
        counts = {"other_owner": 0, "needs_attention": 0}
        for project_id, values in counts_by_project.items():
            if project_id in allowed:
                for key in counts:
                    counts[key] += values[key]
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
        defer_save = body.defer_save or any(row.get("defer_save") for row in recovery)
        ready = panel.prepared(ctx, body.project_id, body.folder_path, body.gen_id)
        if ready is None and recovery:
            ready = recovery[0]["ready"]
        if ready is None:
            return {"state": "not_prepared", "details": {}}
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "gen_id": body.gen_id, "resolve_project_id": body.resolve_project_id,
                   "manifest_root": ready["manifest_root"], "path": ready["item"]["local_path"], "defer_save": defer_save}
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
            row["defer_save"] = defer_save
            await asyncio.to_thread(panel.save_record, "adopt", row)
        payload["records"] = recovery
    elif operation in {"stage", "unstage"}:
        source_root, manifest_root = await asyncio.to_thread(resolve_transfer.resolve_transfer_roots, body.project_id)
        panel.validate_media_root(source_root)
        generations = await _authorized(body, request, body.gen_ids) if operation == "stage" and body.gen_ids else []
        channel = "stage:" + body.project_id + ":" + body.folder_path
        if operation == "stage" and panel.stale(ctx, body.seq, channel, body.window):
            return {"state": "stale"}
        # 틀린 ID 면 그 빈의 다른 컷 항목을 '원하지 않는 내 항목'으로 지운다 — 이 창이 받은 그 컷의 빈만.
        if operation == "stage" and body.bin_id and not panel.cut_bin(body.bin_id, body.window, body.project_id, body.folder_path):
            return {"state": "not_seen"}
        if operation == "unstage" and body.inventory_cleanup and (body.bin_id == panel._owner["bin_id"] or body.bin_id in panel._episode_bins):
            return {"state": "active_bin"}
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "manifest_root": str(manifest_root), "items": await panel.stage_items(ctx, generations, request),
                   "capped": getattr(body, "capped", False) or len(generations) > 200, "import_records": panel.records("import", ctx, include_foreign=True)}
        if operation == "stage" and body.bin_id:
            payload["bin_id"] = body.bin_id
        if operation == "unstage":
            payload["bin_id"] = body.bin_id
        payload["same_file_ids"] = list(panel._same_files.get((*panel.context_key(ctx), body.window, body.project_id, body.folder_path), set()))
    elif operation in {"prestage", "rename"}:
        source_root, manifest_root = await asyncio.to_thread(resolve_transfer.resolve_transfer_roots, body.project_id)
        panel.validate_media_root(source_root)
        # 이 창이 target 으로 받은 그 에피소드의 컷 빈만 — 모르는 빈 ID 로는 가져오거나 이름을 바꾸지 않는다
        if operation == "prestage" and body.episode_bin_id and not panel.episode_bin(body.episode_bin_id, body.window, body.project_id, body.folder_path):
            return {"state": "not_seen"}
        cuts = []
        for cut in body.cuts:
            if not panel.cut_bin(cut.bin_id, body.window, body.project_id, cut.folder_path):
                return {"state": "not_seen"}
            gens = await _authorized(SimpleNamespace(project_id=body.project_id, folder_path=cut.folder_path), request, cut.gen_ids) if cut.gen_ids else []
            cuts.append((cut, gens))
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path, "manifest_root": str(manifest_root)}
        if operation == "prestage":
            payload.update(episode_bin_id=body.episode_bin_id, import_records=panel.records("import", ctx, include_foreign=True), cuts=[
                {"folder_path": cut.folder_path, "bin_id": cut.bin_id, "capped": cut.capped or len(gens) > 200,
                 "items": await panel.stage_items(ctx, gens, request),
                 "same_file_ids": list(panel._same_files.get((*panel.context_key(ctx), body.window, body.project_id, cut.folder_path), set()))}
                for cut, gens in cuts])
        else:
            # 라벨은 권한을 확인한 생성물에서 바로 — 받기 잠금을 잡지 않는다
            payload.update(bin_ids=[cut.bin_id for cut, _gens in cuts], limit=body.limit, after=body.after,
                           labels={gen["id"]: panel.item_label(gen) for _cut, gens in cuts for gen in gens})
    elif operation == "save":
        recovery = panel.records("adopt", ctx, body.expect_project)
        allowed = {body.project_id}  # 선택한 프로젝트는 위에서 이미 권한을 확인했다.
        for project_id in dict.fromkeys(row["project_id"] for row in recovery):
            if project_id in allowed:
                continue
            try:
                await _project_read(request, project_id)
                allowed.add(project_id)
            except HTTPException as exc:
                if exc.status_code not in {403, 404}:
                    raise
        recovery = [row for row in recovery if row["project_id"] in allowed]
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "recovery_records": recovery}
    elif operation == "settle":
        source_root, manifest_root = await asyncio.to_thread(resolve_transfer.resolve_transfer_roots, body.project_id)
        panel.validate_media_root(source_root)
        settle_skipped, seen = {}, set()
        payload = {"operation": operation, "project_id": body.project_id, "folder_path": body.folder_path,
                   "manifest_root": str(manifest_root), "bins": []}
        for row in body.bins:
            if row.bin_id in seen:
                settle_skipped[row.folder_path] = {"state": "duplicate"}  # 같은 빈은 한 번만(이름 다듬기로 두 컷이 한 빈)
                continue
            seen.add(row.bin_id)
            payload["bins"].append({"folder_path": row.folder_path, "bin_id": row.bin_id})

        def settle_filter():
            # 이 창이 받은 그 컷 빈만 · 에피소드 빈·지금 에피소드 컷 빈은 빼기 — 쓰기 잠금 안(자식 띄우기 직전)에서도 다시 부른다
            kept = []
            for row in payload["bins"]:
                if row["bin_id"] in panel._episode_roots:
                    settle_skipped[row["folder_path"]] = {"state": "episode"}
                elif row["bin_id"] in panel._episode_bins:
                    settle_skipped[row["folder_path"]] = {"state": "current_episode"}
                elif not panel.cut_bin(row["bin_id"], body.window, body.project_id, row["folder_path"]):
                    settle_skipped[row["folder_path"]] = {"state": "not_seen"}
                else:
                    kept.append(row)
            payload["bins"] = kept

        settle_filter()
        if not payload["bins"]:
            return {"state": "ok", "bins": settle_skipped, "removed": 0}
    else:
        # 경로 검사는 리졸브 호출 전에 — 에피소드 밖·프로젝트 전체 빈을 만들지 않는다.
        if body.create_paths and (not body.create or not panel.episode_scope_ok(body.episode_path, body.folder_path, body.create_paths)):
            raise HTTPException(400, "에피소드 밖 빈은 만들 수 없습니다")
        if body.keep_current and (not body.create_paths or body.folder_path != body.episode_path):
            raise HTTPException(400, "지금 빈을 지키는 빈 만들기는 에피소드 단위로만 합니다")
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
        if body.create_paths:
            payload.update(episode_path=body.episode_path, create_paths=body.create_paths, keep_current=body.keep_current)

    payload["project_name"] = await asyncio.to_thread(panel.project_name, ctx, body.project_id)
    if not payload["project_name"] and ready:
        payload["project_name"] = ready["project_name"]
    payload.update(_base_payload(operation, ctx))
    if operation in {"target", "stage", "unstage", "prestage", "rename", "save", "settle"} and body.expect_project:
        payload["expect_project"] = body.expect_project

    def before_write():
        panel.check_context(ctx, request)
        integration._reject_if_update_in_progress()
        integration._reject_while_launching()
        if operation == "target" and panel.stale(ctx, body.seq, "target", body.window):
            return {"state": "stale"}
        if operation == "stage" and panel.stale(ctx, body.seq, channel, body.window):
            return {"state": "stale"}
        if operation == "settle":
            settle_filter()  # 그사이 잠금을 먼저 잡은 target 이 막 기억한 빈은 지우지 않는다(runner 는 이 뒤에 payload 를 넘긴다)
            if not payload["bins"]:
                return {"state": "ok", "bins": {}, "removed": 0}
        return None

    async def write():
        panel.check_context(ctx, request)
        async with monitor.suspended():
            result = await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_write)
            panel.check_context(ctx, request)
            # keep_current 의 bin_id 는 되돌린 사람의 지금 빈이다 — 패널이 고른 빈으로 기억하지 않는다
            if operation == "target" and result.get("state") == "ok" and not body.keep_current:
                panel.remember_bin(result.get("bin_id", ""))
            # 다시 짓기(느린 길)는 그 MV 프로젝트의 빈 ID 를 모두 바꾼다 — 끝난 상태와 상관없이 옛 ID 기억을 버린다
            #  (도중에 멈춘 프로젝트 바뀜·복구 대기도 바뀌었을 수 있다고 본다).
            if operation == "target" and body.create_paths and (
                    result.get("ids_changed") or result.get("code") in {"project_changed", "rebuild_recovery_needed", "rebuild_recovery_pending"}):
                panel.forget_project(body.project_id)
            if operation == "target" and "bins" in result:
                panel.remember_episode(body.window, body.project_id, result["bins"], result.get("episode_bin_id", ""), body.episode_path)
            if operation == "settle":
                ids = {row["folder_path"]: row["bin_id"] for row in payload["bins"]}
                for path, done in (result.get("bins") or {}).items():
                    if done.get("bin_deleted") and path in ids:
                        panel.forget_bin(ids[path])
                if result.get("state") in {"ok", "restore_failed"}:
                    result["bins"] = {**settle_skipped, **(result.get("bins") or {})}
            if operation == "prestage":
                # 컷마다 같은 파일 기억 · 복구 기록 저장(멈춘 조각의 leftover 포함) · 끝난 생성물의 옛 기록 지우기
                done_cuts = result.get("cuts") or {}
                for folder, done in done_cuts.items():
                    same_key = (*panel.context_key(ctx), body.window, body.project_id, folder)
                    panel._same_files.setdefault(same_key, set()).update(row["gen_id"] for row in done.get("items", []) if row["state"] == "same_file_exists")
                for row in [*result.get("import_records", []), *(row for done in done_cuts.values() for row in done.get("import_records", []))]:
                    await asyncio.to_thread(panel.save_record, "import", row)
                completed = {row["gen_id"] for done in done_cuts.values() for row in done.get("items", []) if row["state"] in {"staged", "present"}}
                old = [row for row in panel.records("import", ctx, result.get("resolve_project_id"))
                       if row["project_id"] == body.project_id and row["gen_id"] in completed]
                await asyncio.to_thread(panel.remove_records, "import", old)
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
                                  "local_path": row["path"], "nas_path": ready["item"]["local_path"], "ready": ready,
                                  "defer_save": defer_save}
                        panel.check_context(ctx, request)
                        await asyncio.to_thread(panel.save_record, "adopt", record)
                        recovery.append(record)
                        payload["records"].append(record)
                    result = await asyncio.to_thread(runner.run_resolve_panel_isolated, payload, before_start=before_write)
                    panel.check_context(ctx, request)
                    result["missing_record_ids"] = list(missing | set(result.get("missing_record_ids", [])))
                    await asyncio.to_thread(panel.remove_records, "adopt", [row for row in recovery if row["item_id"] in result["missing_record_ids"]])
            if operation == "adopt" and result.get("state") == "in_bin" and not defer_save:
                result = await panel.record_adoption(ctx, body.project_id, body.gen_id, {**ready, "project_name": payload["project_name"]}, result, request=request)
                if result.get("state") == "in_bin":
                    await asyncio.to_thread(panel.remove_records, "adopt", recovery)
            if operation == "save" and result.get("state") == "ok":
                saved = result.pop("saved_adoptions", {})
                missing = set(result.pop("missing_record_ids", []))
                for row in recovery:
                    if row["item_id"] in saved:
                        recorded = await panel.record_adoption(ctx, row["project_id"], row["gen_id"], row["ready"],
                            {**result, "state": "in_bin", "bin_path": saved[row["item_id"]]}, request=request)
                        if recorded.get("state") != "in_bin":
                            return {**result, "state": "ledger_failed", "project_saved": True, "details": recorded.get("details", "")}
                    elif row["item_id"] not in missing:
                        continue
                    await asyncio.to_thread(panel.remove_records, "adopt", [row])
            return result

    key = (operation, *panel.context_key(ctx), body.project_id, body.folder_path,
           body.window, body.model_dump_json())
    return await panel.joined(key, write)


async def _request(operation, body, request, ctx):
    integration._require_local_resolve(request)
    _require_panel_enabled()

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
                        if operation in {"target", "stage", "unstage", "prepare", "adopt", "prestage", "rename", "save", "settle"}:
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
    if operation in {"prepare", "stage", "unstage", "adopt", "target", "prestage", "rename", "save", "settle"}:
        key = ("request", operation, *panel.context_key(ctx), body.model_dump_json())
        return await resolve_queue.run_non_abandon(panel.joined(key, execute))
    return await resolve_queue.run_non_abandon(execute())


@router.get("/identity")
async def get_identity(request: Request, window: str = "", claim: bool = False):
    integration._require_local_resolve(request)
    _require_panel_enabled()
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


@router.post("/prestage")
async def post_prestage(body: PrestageIn, request: Request):
    return await _request("prestage", body, request, body.ctx.model_dump())


@router.post("/rename")
async def post_rename(body: RenameIn, request: Request):
    return await _request("rename", body, request, body.ctx.model_dump())


@router.post("/save")
async def post_save(body: SaveIn, request: Request):
    return await _request("save", body, request, body.ctx.model_dump())


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


@router.post("/settle")
async def post_settle(body: SettleIn, request: Request):
    return await _request("settle", body, request, body.ctx.model_dump())


@router.post("/adopt")
async def post_adopt(body: AdoptIn, request: Request):
    return await _request("adopt", body, request, body.ctx.model_dump())
