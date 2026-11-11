"""리졸브 패널의 실행 문맥·파일 준비·확인 장부. 준비 기록은 허브 수명 동안만 둔다."""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from pathlib import Path

from .. import active_account, config, repo
from . import export_names, project_folders, resolve_transfer as transfer
from .worker_backup import device_identity

INSTANCE = uuid.uuid4().hex
_prepare_lock = asyncio.Lock()
_inflight: dict[tuple, asyncio.Future] = {}
_prepared: dict[tuple, dict] = {}
_sequences: dict[tuple, int] = {}


class AccountChanged(RuntimeError):
    pass


def identity(request=None) -> dict:
    # pinned scope 안에서도 실제 활성 포인터를 본다 — 고정된 옛 계정과 비교하면 전환을 놓친다.
    token = active_account.set_override(None)
    try:
        # 전환 락 대기는 라우터의 to_thread(capture_account_pin)에만 둔다 — 이벤트 루프를 붙잡지 않게.
        key = active_account.account_key() or ""
        if config.AUTH_ENABLED:
            account = getattr(request.state, "account", None) if request is not None else None
            key = str((account or {}).get("email") or "").strip().lower()
        account = hashlib.sha256(key.encode()).hexdigest()[:16]
        return {"instance": INSTANCE, "account": account, "epoch": active_account.account_epoch(),
                "protocol": {"min": 1, "max": 1}}
    finally:
        active_account.reset_override(token)


def context_key(ctx: dict) -> tuple:
    return ctx["instance"], ctx["account"], ctx["epoch"]


def check_context(ctx: dict, request=None) -> None:
    if context_key(ctx) != context_key(identity(request)):
        raise AccountChanged("허브 또는 계정이 바뀌었습니다. 패널을 새로 여세요")


def note_sequence(ctx: dict, seq: int, channel: str, window: str = "") -> None:
    context = context_key(ctx)
    # AUTH-on의 동시 로그인은 서로 지우지 않고, 끝난 허브·epoch와 오래된 창만 비운다.
    for old in list(_sequences):
        if (old[0], old[2]) != (context[0], context[2]) or (not config.AUTH_ENABLED and old[1] != context[1]):
            del _sequences[old]
    key = (*context, window, channel)
    _sequences[key] = max(seq, _sequences.get(key, -1))
    windows = list(dict.fromkeys(old[3] for old in _sequences if old[:3] == context))
    for expired in windows[:-64]:
        for old in list(_sequences):
            if old[:3] == context and old[3] == expired:
                del _sequences[old]


def stale(ctx: dict, seq: int, channel: str, window: str = "") -> bool:
    return seq < _sequences.get((*context_key(ctx), window, channel), -1)


def project_name(ctx: dict, project_id: str) -> str:
    """빈 이름과 복구 관문의 이름 원천을 맞춘다 — 생성물 카드의 옛 이름이 남을 수 있다."""
    project = repo.get_project(project_id)
    if project and project.get("name"):
        return str(project["name"])
    return next((ready["project_name"] for key, ready in _prepared.items()
                 if key[:3] == context_key(ctx) and key[3] == project_id), "")


async def joined(key: tuple, work):
    pending = _inflight.get(key)
    if pending is not None:
        return await asyncio.shield(pending)
    pending = asyncio.get_running_loop().create_future()
    _inflight[key] = pending
    try:
        # 첫 요청이 직접 실행한다 — 라우터가 이 실행과 합류자의 수명을 끝까지 보호한다.
        result = await work()
        pending.set_result(result)
        return result
    except BaseException as exc:
        pending.set_exception(exc)
        pending.exception()
        raise
    finally:
        _inflight.pop(key, None)


def prepared_key(ctx: dict, project_id: str, folder_path: str, gen_id: str) -> tuple:
    return (*context_key(ctx), project_id, folder_path, gen_id)


def prepared(ctx: dict, project_id: str, folder_path: str, gen_id: str) -> dict | None:
    return _prepared.get(prepared_key(ctx, project_id, folder_path, gen_id))


def generation_asset(gen: dict) -> dict:
    assets = gen.get("assets") or []
    asset = assets[0] if assets and isinstance(assets[0], dict) else {}
    if gen.get("status") != "done" or not gen.get("id") or not gen.get("folder_path"):
        raise transfer.ResolveTransferError("폴더에 배정된 완료 생성물만 준비할 수 있습니다")
    if asset.get("type") not in {"video", "audio", "image"}:
        raise transfer.ResolveTransferError("Resolve 전송을 지원하지 않는 원본입니다")
    return asset


async def cache(ctx: dict, seq: int, generations: list[dict], *, window: str = "", request=None) -> dict:
    results = []
    for gen in generations:
        check_context(ctx, request)
        if stale(ctx, seq, "cache", window):
            break

        async def one():
            async with _prepare_lock:
                check_context(ctx, request)
                if stale(ctx, seq, "cache", window):
                    return None
                try:
                    await transfer._cached_source(generation_asset(gen))
                    return {"gen_id": gen["id"], "state": "cached"}
                except Exception as exc:
                    return {"gen_id": gen["id"], "state": "failed", "error": str(exc)}

        key = ("cache", *prepared_key(ctx, gen["project_id"], gen["folder_path"], gen["id"]))
        result = await joined(key, one)
        check_context(ctx, request)
        if result is None and not stale(ctx, seq, "cache", window):
            result = await joined(key, one)
        if result is not None:
            results.append(result)
    return {"items": results}


async def prepare(ctx: dict, gen: dict, *, request=None) -> dict:
    key = prepared_key(ctx, gen["project_id"], gen["folder_path"], gen["id"])

    async def one():
        async with _prepare_lock:
            check_context(ctx, request)
            try:
                asset = generation_asset(gen)
                source_root, manifest_root = await asyncio.to_thread(transfer.resolve_transfer_roots, gen["project_id"])
                check_context(ctx, request)
                if await asyncio.to_thread(transfer._folder_dir, source_root, gen["folder_path"]) is None:
                    raise transfer.ResolveTransferError("경로 안전성 위반")
                item = {"generation_id": gen["id"], "folder_path": gen["folder_path"],
                        "media_type": asset["type"], "filename": "", "local_path": "", "status": "pending", "error": None}
                ident = export_names.Ident(gen["project_id"], gen.get("project_name"), gen.get("job_id"), gen["id"], gen.get("creator_name"))
                ext = project_folders.export_ext(str(asset.get("source_url") or asset.get("file_path") or ""), asset["type"])
                check_context(ctx, request)
                await transfer.prepare_generation_files(item, asset, source_root, str(gen.get("job_id") or gen["id"]),
                                                        ext, export_names.Books(source_root), ident, guard=lambda: check_context(ctx, request))
                check_context(ctx, request)
                _prepared[key] = {"item": item, "source_root": str(source_root), "manifest_root": str(manifest_root),
                                  "project_name": gen.get("project_name") or "", "created_at": transfer._utc_now()}
                return {"gen_id": gen["id"], "state": "prepared", "path": item["local_path"]}
            except AccountChanged:
                raise
            except Exception as exc:
                return {"gen_id": gen["id"], "state": "failed", "path": "", "error": str(exc)}

    return await joined(("prepare", *key), one)


async def record_adoption(ctx: dict, project_id: str, gen_id: str, ready: dict, result: dict, *, request=None) -> dict:
    try:
        check_context(ctx, request)
        device = await asyncio.to_thread(device_identity)
        path = ready["item"]["local_path"]
        key = json.dumps([device["device_id"], result["resolve_project_id"], gen_id, path], ensure_ascii=True)
        transfer_id = "panel-" + hashlib.sha1(key.encode()).hexdigest()[:20]
        manifest_path = await asyncio.to_thread(transfer._manifest_path, Path(ready["manifest_root"]), transfer_id)
        imported_item = {"generation_id": gen_id, "local_path": path, "media_pool_path": result["bin_path"],
                         "status": "skipped", "error": None, "error_code": None}
        manifest = {"format": transfer.MANIFEST_FORMAT, "version": transfer.MANIFEST_VERSION,
                    "transfer_id": transfer_id, "origin": "panel", **device, "project_id": project_id,
                    "project_name": ready["project_name"], "source_root": ready["source_root"],
                    "manifest_root": ready["manifest_root"], "manifest_path": str(manifest_path),
                    "folder_paths": [ready["item"]["folder_path"]], "created_at": ready["created_at"],
                    "status": "complete", "total": 1, "items": [dict(ready["item"])],
                    "resolve_target": {"project_id": result["resolve_project_id"], "project_name": result["resolve_project_name"]},
                    "resolve_import": {"status": "complete", "project_name": result["resolve_project_name"],
                        "target_root": "/".join(result["bin_path"].split("/")[:2]), "total": 1, "imported": 0,
                        "skipped": 1, "error_count": 0, "error": None, "error_code": None, "items": [imported_item]}}
        transfer._refresh_summary(manifest, finished=True)
        check_context(ctx, request)
        await transfer.save_manifest(manifest)
        return {**result, "transfer_id": transfer_id}
    except AccountChanged:
        raise
    except Exception as exc:
        return {**result, "state": "ledger_failed", "details": str(exc)}
