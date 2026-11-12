"""리졸브 패널의 담당 창·파일 준비·확인 장부. 중단된 옮기기만 디스크 기록으로 이어 받는다."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from .. import active_account, config, repo
from . import export_names, project_folders, resolve_queue, resolve_transfer as transfer
from .worker_backup import device_identity

INSTANCE = uuid.uuid4().hex
_prepare_lock = asyncio.Lock()
_CACHE_PARALLEL = 3  # 이 PC 로 받아 두기 동시 수 — 요청당 일꾼 수이자 패널 cache 전체 상한(Jay 11-12, 보수적 값·실측 전)
_CACHE_SLOTS = asyncio.Semaphore(_CACHE_PARALLEL)
_source_locks: dict[str, list] = {}  # 원본 주소 → [잠금, 쓰는 수] — 같은 주소의 다른 생성물은 패널에서 먼저 줄 세운다
_inflight: dict[tuple, asyncio.Future] = {}
_prepared: dict[tuple, dict] = {}
_sequences: dict[tuple, int] = {}
_same_files: dict[tuple, set[str]] = {}
write_lock = asyncio.Lock()
_owner: dict = {"window": "", "context": (), "generation": 0, "seen": 0, "bin_id": ""}


@asynccontextmanager
async def mutation_scope():
    await asyncio.wait_for(write_lock.acquire(), timeout=30)
    try:
        yield
    finally:
        write_lock.release()


def hub_key() -> str:
    from .resolve_bridge import _normal_path
    return hashlib.sha1((device_identity()["device_id"] + _normal_path(str(config.MEDIA_DIR))).encode()).hexdigest()[:16]


def owner_generation(ctx, window):
    return _owner["generation"] if _owner["window"] == window and _owner["context"] == context_key(ctx) and time.monotonic() - _owner["seen"] <= 15 else None


def owner_state(ctx, window):
    previous = _owner["context"]
    if (not _owner["window"] or time.monotonic() - _owner["seen"] > 15 or not previous
            or (previous[0], previous[2]) != (ctx["instance"], ctx["epoch"])
            or ((_owner["window"] == window or not config.AUTH_ENABLED) and previous != context_key(ctx))):
        return "unclaimed"
    return "writer" if owner_generation(ctx, window) is not None else "other_window"


async def window_identity(request, window, claim=False):
    ctx = identity(request)
    if claim:
        async with mutation_scope():
            check_context(ctx, request)
            _owner.update(window=window, context=context_key(ctx), generation=_owner["generation"] + 1,
                          seen=time.monotonic(), bin_id="")
    elif _owner["window"] == window and _owner["context"] == context_key(ctx):
        _owner["seen"] = time.monotonic()
    return {**ctx, "writer": owner_generation(ctx, window) is not None,
            "owner_state": owner_state(ctx, window),
            "generation": _owner["generation"], "active_bin_id": _owner["bin_id"]}


def remember_bin(bin_id):
    if _owner["bin_id"] != bin_id:
        _same_files.clear()
    _owner["bin_id"] = bin_id


# target 이 돌려준 컷 빈 — 창을 다시 잡아도(claim) 지우지 않는다(패널 다시 열기가 그때다).
_cut_bins: dict[str, tuple] = {}  # 빈 ID → (창, MV 프로젝트, 컷 경로): 그 창만 그 컷으로 따라가기 stage·비면 지우기
_episode_bins: set[str] = set()  # 지금 에피소드의 컷 빈 — 어느 창의 inventory 정리도 건드리지 않는다
_episode_roots: dict[str, tuple] = {}  # 에피소드 빈 ID → (창, MV 프로젝트, 에피소드 경로): 미리 띄우기가 가져오는 자리로 쓸 수 있는 빈


def remember_episode(window, project_id, bins, episode_bin_id="", episode_path=""):
    _episode_bins.clear()
    for path, bin_id in bins.items():
        if bin_id:
            _cut_bins[bin_id] = (window, project_id, path)
            _episode_bins.add(bin_id)
    if episode_bin_id:
        _episode_roots[episode_bin_id] = (window, project_id, episode_path)


def cut_bin(bin_id, window, project_id, folder_path):
    return bool(bin_id) and _cut_bins.get(bin_id) == (window, project_id, folder_path)


def episode_bin(bin_id, window, project_id, episode_path):
    return bool(bin_id) and _episode_roots.get(bin_id) == (window, project_id, episode_path)


def forget_bin(bin_id):
    _cut_bins.pop(bin_id, None)
    _episode_bins.discard(bin_id)


def forget_project(project_id):
    """다시 짓기로 그 MV 프로젝트의 빈 ID 가 바뀌었다 — 옛 ID 기억을 버린다(지우기·따라가기를 막는 쪽으로 안전)."""
    for bin_id in [key for key, value in _cut_bins.items() if value[1] == project_id]:
        _cut_bins.pop(bin_id, None)
    for bin_id in [key for key, value in _episode_roots.items() if value[1] == project_id]:
        _episode_roots.pop(bin_id, None)
    _episode_bins.clear()
    _owner["bin_id"] = ""


def item_label(gen):
    """다빈치 클립 이름 — '작업자 · 모델 · 5s'(없으면 생성물 ID)."""
    duration = (gen.get("params") or {}).get("duration") or gen.get("duration")
    label = " · ".join(str(value) for value in [gen.get("creator_name") or "", gen.get("model") or "", f"{duration}s" if duration else ""] if value)
    return label or gen["id"]


def episode_scope_ok(episode_path, folder_path, create_paths):
    """만들 컷 빈은 에피소드보다 깊은 경로만 — 조각 단위로 견줘 e02 와 e020 을 섞지 않는다. 빈 에피소드 = 프로젝트 전체라 거절."""
    from .resolve_bridge import _folder_parts
    episode = _folder_parts(episode_path)
    inside = lambda path: _folder_parts(path)[:len(episode)] == episode
    return bool(episode) and inside(folder_path) and all(inside(path) and len(_folder_parts(path)) > len(episode) for path in create_paths)


def _record_path(kind, resolve_project_id, item_id):
    # 리졸브 ID가 파일 이름으로 안전하다는 가정을 하지 않는다.
    safe = lambda value: hashlib.sha256(str(value).encode()).hexdigest()
    return Path(config.DATA_DIR) / "resolve_panel" / kind / safe(resolve_project_id) / (safe(item_id) + ".json")


def save_record(kind, record):
    path = _record_path(kind, record["resolve_project_id"], record["item_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix("." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def records(kind, ctx, resolve_project_id=None, *, include_foreign=False):
    root = Path(config.DATA_DIR) / "resolve_panel" / kind
    found = []
    for path in root.glob("*/*.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
            if (include_foreign or (row["account"] == ctx["account"] and row["hub_key"] == hub_key())) and (not resolve_project_id or row["resolve_project_id"] == resolve_project_id):
                found.append(row)
        except (OSError, ValueError, KeyError):
            continue
    return found


def remove_records(kind, rows):
    for row in rows:
        _record_path(kind, row["resolve_project_id"], row["item_id"]).unlink(missing_ok=True)


def validate_media_root(source_root):
    from .resolve_bridge import _panel_under
    if _panel_under(str(config.MEDIA_DIR), str(source_root)) or _panel_under(str(source_root), str(config.MEDIA_DIR)):
        raise transfer.ResolveTransferError("이 PC 원본 폴더와 NAS 렌더 폴더가 겹칩니다")


async def stage_items(ctx, generations, request=None):
    from .resolve_bridge import _panel_under
    if generations:
        source_root, _ = await asyncio.to_thread(transfer.resolve_transfer_roots, generations[0]["project_id"])
        validate_media_root(source_root)
    items = []
    for gen in sorted(generations, key=lambda row: (str(row.get("created_at") or ""), row["id"]))[:200]:
        check_context(ctx, request)
        async with _prepare_lock:
            check_context(ctx, request)
            asset = generation_asset(gen)
            async with _source_turn(asset):  # 받아 두기와 같은 주소 차례 — cache 가 media_cache 잠금 안에서 이 받기를 기다리지 않게
                check_context(ctx, request)  # 차례를 기다린 사이 계정이 바뀌었을 수 있다
                path = await transfer._cached_source(asset, before_download=lambda: check_context(ctx, request))
        if not _panel_under(str(path), str(config.MEDIA_DIR)) or not Path(path).is_file():
            raise transfer.ResolveTransferError("이 PC 원본 경로를 확인하지 못했습니다")
        items.append({"gen_id": gen["id"], "path": str(path), "label": item_label(gen)})
    return items


class AccountChanged(RuntimeError):
    pass


class _Stale(Exception):
    """cache 받기 직전 확인에서 새 선택이 와 있음 — 그 생성물은 시작하지 않는다(패널 안 표시)."""


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
    # 한 채널만 뒤로 보내면 같은 창의 다른 채널 때문에 오래된 창으로 오인한다.
    for recent in [old for old in _sequences if old[:4] == (*context, window)]:
        _sequences[recent] = _sequences.pop(recent)
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


def _already_local(asset: dict) -> bool:
    """이 PC /media 에 이미 있는 원본 — transfer._cached_source 의 첫 갈래와 같은 조건(safe_join·일반 파일·크기 > 0)."""
    file_path = str(asset.get("file_path") or "")
    if not file_path.startswith("/media/"):
        return False
    local = transfer.safe_join(transfer.MEDIA_DIR, file_path.removeprefix("/media/"))
    return local is not None and local.is_file() and local.stat().st_size > 0


@asynccontextmanager
async def _source_turn(asset: dict):
    """같은 원본 주소(_cached_source 가 처음 받으려는 http 주소)는 한 번에 하나 — 자리를 잡기 전에 기다린다.
    media_cache 의 주소 잠금 안에서 기다리면 그사이 계정·선택이 바뀌어도 다시 보지 않고 받기 시작하므로(독립 리뷰 1차 P2),
    여기서 차례를 받고 자리를 잡은 뒤 다시 확인한다. 쓰는 수가 0 이 되면 지워 쌓이지 않게."""
    key = next((value for value in (str(asset.get("file_path") or ""), str(asset.get("source_url") or ""))
                if value.startswith(("http://", "https://"))), "")
    if not key:
        yield
        return
    entry = _source_locks.setdefault(key, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if not entry[1] and _source_locks.get(key) is entry:
            del _source_locks[key]


async def cache(ctx: dict, seq: int, generations: list[dict], *, window: str = "", request=None) -> dict:
    """이 PC 로 받아 두기 — 요청당 일꾼 _CACHE_PARALLEL 개가 목록 순서대로 하나씩 집고, 패널 cache 전체 동시 수도 같은 상한(Jay 11-12).
    받기는 _prepare_lock 밖(NAS 복사·띄움 준비는 그 잠금) — 같은 파일 중복은 media_cache 주소 잠금이 막는다.
    자리는 joined 주인 안에서만 잡고 잡은 뒤 다시 확인한다 · 이미 이 PC 에 있는 파일은 자리를 기다리지 않는다.
    멈춤은 '새로 집지 않기'뿐 — 일꾼을 취소하지 않는다(취소하면 스레드 다운로드는 남고 자리·잠금만 먼저 풀린다).
    새 선택이 seq 를 올리면 새로 시작하지 않고, 받던 것은 끝까지(캐시에 남고 결과에 들어간다). 오류는 모든 일꾼이 끝난 뒤 첫 것."""
    results: list[dict | None] = [None] * len(generations)
    cursor = iter(range(len(generations)))  # 일꾼들이 나눠 집는 다음 순번(이벤트 루프 하나라 겹치지 않는다)
    failure: list[BaseException] = []

    async def fetch(gen):
        async def one():
            check_context(ctx, request)
            if stale(ctx, seq, "cache", window):
                return None
            try:
                asset = generation_asset(gen)
                if _already_local(asset):
                    return {"gen_id": gen["id"], "state": "cached"}
            except Exception as exc:  # noqa: BLE001 - 생성물마다 실패를 따로 남긴다
                return {"gen_id": gen["id"], "state": "failed", "error": str(exc)}
            def recheck():  # media_cache 주소 잠금 안·실제 받기 직전 — 패널 밖 기능이 같은 주소를 받던 것을 기다린 뒤에도 다시 본다
                check_context(ctx, request)
                if stale(ctx, seq, "cache", window):
                    raise _Stale

            async with _source_turn(asset), _CACHE_SLOTS:  # 같은 주소 차례 → 자리 → 다시 확인 → 받기
                check_context(ctx, request)
                if stale(ctx, seq, "cache", window):
                    return None
                try:
                    await transfer._cached_source(asset, before_download=recheck)
                    return {"gen_id": gen["id"], "state": "cached"}
                except _Stale:
                    return None
                except AccountChanged:  # RuntimeError 계열이라 아래 생성물별 실패보다 먼저
                    raise
                except Exception as exc:  # noqa: BLE001 - 생성물마다 실패를 따로 남긴다
                    return {"gen_id": gen["id"], "state": "failed", "error": str(exc)}

        key = ("cache", *prepared_key(ctx, gen["project_id"], gen["folder_path"], gen["id"]))
        result = await joined(key, one)
        check_context(ctx, request)
        # 앞 요청의 주인이 그 요청의 stale 로 멈췄다(None) — 이 요청이 유효한 동안 다시(주인이 바뀌어 또 멈출 수 있다, 독립 리뷰 1차 P2).
        #  None 은 다른 요청이 낡았다는 뜻이라 요청 수만큼에서 끝난다.
        while result is None and not stale(ctx, seq, "cache", window):
            result = await joined(key, one)
            check_context(ctx, request)
        return result

    async def worker():
        for index in cursor:
            if failure:
                return
            try:
                check_context(ctx, request)
                if stale(ctx, seq, "cache", window):
                    return
                results[index] = await fetch(generations[index])
            except Exception as exc:  # noqa: BLE001 - 계정 바뀜 등: 적어 두고 끝, 다른 일꾼은 새로 안 집는다
                failure.append(exc)
                return

    workers = [asyncio.create_task(worker()) for _ in range(min(_CACHE_PARALLEL, len(generations)))]

    async def wait_all():
        return await asyncio.gather(*workers, return_exceptions=True)

    await resolve_queue.run_non_abandon(wait_all())  # 바깥이 취소돼도 받던 것이 끝날 때까지 자리를 쥔 채 기다린다
    if failure:
        raise failure[0]
    return {"items": [row for row in results if row is not None]}


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
                async with _source_turn(asset):  # 원본 받기가 들어 있다 — 받아 두기와 같은 주소 차례
                    check_context(ctx, request)  # 차례를 기다린 사이 계정이 바뀌었을 수 있다(받기 직전은 guard 가 다시 본다)
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
