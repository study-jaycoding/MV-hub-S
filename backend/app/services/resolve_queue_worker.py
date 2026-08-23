"""Resolve 가져오기 큐 전담 워커 (manifest v3 명세 §2·§D).

한 번에 하나씩만 처리한다. 준비(원본 복사)는 이번 단계에서 동시 1개, Resolve
가져오기는 명세대로 항상 1개다. 자식 프로세스 대기에는 timeout 을 두지 않는다 —
Media Pool 재정렬 도중을 끊으면 워커 안의 복구 코드가 실행되지 못한다.

실행 조건은 Windows + release 설치다. 개발·서버 설치에서는 켜지 않는다
(``CONTENT_HUB_RESOLVE_QUEUE_WORKER=1|0`` 으로 강제 지정 가능 — 테스트용).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .. import active_account, repo
from . import project_folders, resolve_lock, resolve_queue, resolve_transfer
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event
from .release_update import install_mode
from .resolve_queue import (
    DISPATCH_AUTO,
    DISPATCH_MANUAL_ONLY,
    PREPARE_DOWNLOADED,
    PREPARE_ERROR,
    PREPARE_SKIPPED,
    STATE_BLOCKED,
    STATE_COMPLETE,
    STATE_FAILED,
    STATE_IMPORTING,
    STATE_INTERRUPTED,
    STATE_PREPARING,
    STATE_QUEUED,
    STATE_READY,
)
from .resolve_status_runner import run_resolve_import_isolated
from .resolve_transfer import ResolveTransferError


_log = logging.getLogger("mvhub.resolve_queue")
_INTERVAL_SECONDS = max(
    2.0, float(os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_INTERVAL_SECONDS", "15"))
)
_STARTUP_DELAY_SECONDS = max(
    0.0, float(os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_STARTUP_DELAY_SECONDS", "5"))
)
_BLOCKED_RETRY_SECONDS = max(
    5.0, float(os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_BLOCKED_RETRY_SECONDS", "60"))
)
_BLOCKED_RETRY_MAX_SECONDS = 900.0

# 조건이 회복되면 자동 재평가할 수 있는 보류 코드(§B). 그 외(결과 유실 가능)는 interrupted.
_BLOCKING_CODES = frozenset(
    {
        "project_changed",
        "target_unverifiable",
        "not_running",
        "no_project",
        "api_unavailable",
        "python_incompatible",
        "module_unavailable",
        "spawn_failed",
        "locking_unsupported",
        "account_scope_changed",
        "destination_changed",
    }
)

# 서버 위임 모드에서 로컬에 없는 생성물을 다시 찾는 훅. 계층 경계(services→routers 금지)
# 때문에 라우터가 자기 모듈 로드 시 주입한다.
_remote_lookup: Optional[Callable[[str], Optional[dict[str, Any]]]] = None


def set_remote_lookup(lookup: Optional[Callable[[str], Optional[dict[str, Any]]]]) -> None:
    global _remote_lookup
    _remote_lookup = lookup


def worker_enabled() -> bool:
    override = os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_WORKER", "").strip().lower()
    if override in {"0", "off", "false", "no"}:
        return False
    if override in {"1", "on", "true", "yes"}:
        return True
    return os.name == "nt" and install_mode() == "release"


def _capture_account_scope() -> str:
    """claim 직전 계정을 캡처한다. ★반드시 워커 스레드에서 — transition_lock 은 로그인
    마이그레이션·DB 복원이 초 단위로 쥐고 있어 이벤트 루프에서 기다리면 서버가 멈춘다."""
    with active_account.transition_lock:
        return active_account.account_key() or ""


def _project_ids() -> list[str]:
    payload = repo.list_projects(include_archived=True)
    return [str(project.get("id") or "") for project in (payload.get("projects") or [])]


# ── 소스 재구성 (§1.6) ────────────────────────────────────────────────────────
def _lookup_generation(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    ref = item.get("source_ref") or {}
    for key in ("local_generation_id", "job_id"):
        any_id = str(ref.get(key) or "")
        if not any_id:
            continue
        gen, _local_id, _server_id = repo.resolve_and_get(any_id)
        if gen:
            return gen
    return None


def _pick_asset(gen: dict[str, Any], item: dict[str, Any]) -> Optional[dict[str, Any]]:
    """asset_id 가 있으면 정확 일치만, 없을 때만 ordinal+타입 일치를 쓴다(§1.6 3단계)."""
    ref = item.get("source_ref") or {}
    assets = [asset for asset in (gen.get("assets") or []) if isinstance(asset, dict)]
    wanted_id = str(ref.get("asset_id") or "")
    if wanted_id:
        for asset in assets:
            if str(asset.get("id") or "") == wanted_id:
                return asset
        return None
    ordinal = int(ref.get("asset_ordinal") or 0)
    media_type = str(ref.get("media_type") or "")
    if 0 <= ordinal < len(assets):
        asset = assets[ordinal]
        if not media_type or str(asset.get("type") or "") == media_type:
            return asset
    return None


def _source_payload_block(manifest: dict[str, Any]) -> Optional[dict[str, Any]]:
    """계정 scope·목적지 루트가 접수 때와 같은지 확인한다. 다르면 blocked 사유를 돌려준다."""
    payload = manifest.get("source_payload") or {}
    scope = payload.get("account_scope") or {}
    expected_key = str(scope.get("account_key") or "")
    if expected_key:
        current_key = _capture_account_scope()
        if current_key and current_key != expected_key:
            return {
                "code": "account_scope_changed",
                "expected": expected_key,
                "observed": current_key,
                "last_checked_at": resolve_queue._utc_now(),
            }
    contract = payload.get("destination_contract") or {}
    expected_identity = str(contract.get("root_identity") or "")
    if expected_identity:
        try:
            source_root, _manifest_root = resolve_transfer.resolve_transfer_roots(
                str(manifest.get("project_id") or "")
            )
        except (ResolveTransferError, OSError) as exc:
            return {
                "code": "destination_changed",
                "message": str(exc),
                "last_checked_at": resolve_queue._utc_now(),
            }
        if resolve_queue.path_identity(source_root) != expected_identity:
            return {
                "code": "destination_changed",
                "expected": expected_identity,
                "observed": resolve_queue.path_identity(source_root),
                "last_checked_at": resolve_queue._utc_now(),
            }
    return None


async def _prepare_item(manifest: dict[str, Any], item: dict[str, Any]) -> None:
    prepare = item.get("prepare") or {}
    if prepare.get("state") in {PREPARE_DOWNLOADED, PREPARE_SKIPPED}:
        return  # 재개 멱등 — 이미 준비된 항목은 다시 복사하지 않는다.
    if prepare.get("state") == PREPARE_ERROR and prepare.get("error_code") in {
        "destination_changed",
        "source_changed",
    }:
        return  # 접수 시점에 확정된 영구 오류.

    def _fail(code: str, message: str) -> None:
        prepare["state"] = PREPARE_ERROR
        prepare["error_code"] = code
        prepare["error"] = message

    destination = item.get("destination") or {}
    source_root = Path(str(manifest.get("source_root") or ""))
    dest = project_folders.safe_dest(
        source_root,
        str(destination.get("relative_folder") or ""),
        str(destination.get("filename") or ""),
    )
    if dest is None or str(dest) != str(item.get("local_path") or ""):
        _fail("destination_changed", "복사 직전 경로 안전성 확인에 실패했습니다")
        return

    gen = await to_thread_non_abandon(_lookup_generation, item)
    if gen is None and _remote_lookup is not None:
        ref = item.get("source_ref") or {}
        with contextlib.suppress(Exception):
            gen = await to_thread_non_abandon(
                _remote_lookup, str(ref.get("local_generation_id") or "")
            )
    if gen is None:
        _fail("source_missing", "원본 생성물을 다시 찾을 수 없습니다")
        return
    asset = _pick_asset(gen, item)
    if asset is None:
        _fail("source_changed", "원본 파일 정보가 접수 때와 달라졌습니다")
        return

    try:
        source = await resolve_transfer._cached_source(asset)
    except ResolveTransferError as exc:
        _fail("source_missing", str(exc))
        return
    except Exception as exc:  # noqa: BLE001 - 한 항목 실패가 나머지를 막지 않는다.
        _fail("unexpected_error", str(exc))
        return

    try:
        status = await to_thread_non_abandon(resolve_transfer._copy_atomic, source, dest)
    except ResolveTransferError as exc:
        # 메시지 파싱 없이 상태로 판정한다 — 목적지에 다른 파일이 있으면 충돌이다.
        _fail(
            "destination_conflict" if dest.exists() else "unexpected_error", str(exc)
        )
        return
    except Exception as exc:  # noqa: BLE001
        _fail("unexpected_error", str(exc))
        return

    prepare["state"] = PREPARE_DOWNLOADED if status == "downloaded" else PREPARE_SKIPPED
    prepare["error_code"] = None
    prepare["error"] = None
    with contextlib.suppress(OSError):
        prepare["size"] = dest.stat().st_size


async def prepare_transfer(manifest: dict[str, Any]) -> Optional[str]:
    """queued 한 건을 preparing → ready/blocked/failed 로 끝낸다. 반환=최종 상태."""
    path = resolve_queue.manifest_path_of(manifest)
    lock = resolve_queue.transfer_lock(manifest)
    if not await to_thread_non_abandon(lock.try_acquire):
        return None
    account_token = None
    try:
        current = await to_thread_non_abandon(resolve_queue.read_manifest, path)
        if resolve_queue.queue_state(current) != STATE_QUEUED:
            return None
        attempt_id = resolve_queue.new_attempt_id()
        claim = resolve_queue.build_claim(
            current, purpose="prepare", attempt_id=attempt_id
        )

        def _start() -> None:
            block = resolve_queue.queue_block(current)
            block["claim"] = claim
            block["last_attempt_id"] = attempt_id
            resolve_queue.set_state(current, STATE_PREPARING)
            resolve_queue.save_manifest(path, current)

        await to_thread_non_abandon(_start)

        blocked = await to_thread_non_abandon(_source_payload_block, current)
        if blocked is not None:
            def _blocked() -> None:
                resolve_queue.set_state(
                    current,
                    STATE_BLOCKED,
                    blocked=blocked,
                    resume_state=STATE_QUEUED,
                    error={"code": blocked["code"], "message": blocked.get("message", "")},
                    clear_claim=True,
                )
                resolve_queue.save_manifest(path, current)

            await to_thread_non_abandon(_blocked)
            return STATE_BLOCKED

        scope_key = str(
            ((current.get("source_payload") or {}).get("account_scope") or {}).get(
                "account_key"
            )
            or ""
        )
        if scope_key:
            account_token = active_account.set_override(scope_key)
        for item in current.get("items") or []:
            if isinstance(item, dict):
                await _prepare_item(current, item)

        def _finish() -> str:
            resolve_queue.refresh_projection(current)
            prepared = int(current.get("downloaded") or 0) + int(
                current.get("skipped") or 0
            )
            if prepared:
                catalog_path, folder_paths = resolve_transfer._update_folder_catalog(
                    current
                )
                current["folder_catalog_path"] = str(catalog_path)
                current["folder_paths"] = folder_paths
                resolve_queue.set_state(current, STATE_READY, clear_claim=True)
                state = STATE_READY
            else:
                first = next(
                    (
                        (item.get("prepare") or {})
                        for item in current.get("items") or []
                        if (item.get("prepare") or {}).get("state") == PREPARE_ERROR
                    ),
                    {},
                )
                resolve_queue.set_state(
                    current,
                    STATE_FAILED,
                    error={
                        "code": str(first.get("error_code") or "unexpected_error"),
                        "message": str(first.get("error") or "준비할 수 있는 원본이 없습니다"),
                    },
                    clear_claim=True,
                )
                state = STATE_FAILED
            resolve_queue.save_manifest(path, current)
            return state

        return await to_thread_non_abandon(_finish)
    except resolve_queue.ResolveQueueError:
        return None
    except asyncio.CancelledError:
        # preparing 그대로 둔다 — 부팅 복구가 재큐잉한다(복사는 멱등).
        raise
    except Exception:  # noqa: BLE001 - 예상 밖 오류로 preparing 에 영원히 갇히지 않게 한다.
        log_event(_log, "resolve_queue_prepare_failed", level=logging.WARNING, exc_info=True)
        with contextlib.suppress(Exception):
            failed = resolve_queue.read_manifest(path)
            if resolve_queue.queue_state(failed) == STATE_PREPARING:
                resolve_queue.set_state(
                    failed,
                    STATE_FAILED,
                    error={"code": "unexpected_error", "message": "원본 준비가 실패했습니다"},
                    clear_claim=True,
                )
                resolve_queue.save_manifest(path, failed)
        return STATE_FAILED
    finally:
        if account_token is not None:
            active_account.reset_override(account_token)
        lock.release()


# ── 가져오기 (§2.1 락 순서 · §C error_code) ───────────────────────────────────
def _acquire_import_locks(manifest: dict[str, Any]) -> Optional[list[resolve_lock.FileLock]]:
    """machine → project → transfer 순으로 잡는다. 하나라도 경쟁이면 전부 푼다."""
    manifest_root = Path(str(manifest.get("manifest_root") or ""))
    paths = [
        resolve_lock.machine_lock_path(),
        resolve_lock.project_lock_path(manifest_root),
        resolve_lock.transfer_lock_path(
            manifest_root, str(manifest.get("transfer_id") or "")
        ),
    ]
    held: list[resolve_lock.FileLock] = []
    for path in paths:
        lock = resolve_lock.FileLock(path)
        try:
            acquired = lock.try_acquire()
        except BaseException:
            _release_locks(held)
            raise
        if not acquired:
            _release_locks(held)
            return None
        held.append(lock)
    return held


def _release_locks(locks: list[resolve_lock.FileLock]) -> None:
    for lock in reversed(locks):
        lock.release()


def _apply_import_result(manifest: dict[str, Any], result: dict[str, Any]) -> str:
    """자식 결과를 항목·권위 상태에 반영한다. error_code 는 절대 버리지 않는다(§C)."""
    by_key = {}
    for entry in result.get("items") or []:
        if isinstance(entry, dict):
            by_key[
                (
                    str(entry.get("generation_id") or ""),
                    resolve_queue.path_identity(str(entry.get("local_path") or "")),
                )
            ] = entry
    for item in manifest.get("items") or []:
        if not isinstance(item, dict):
            continue
        entry = by_key.get(
            (
                str(item.get("generation_id") or ""),
                resolve_queue.path_identity(str(item.get("local_path") or "")),
            )
        )
        if entry is None:
            continue
        target = item.setdefault("import", {})
        target["state"] = str(entry.get("status") or "pending")
        target["media_pool_path"] = str(entry.get("media_pool_path") or "")
        target["error_code"] = entry.get("error_code")

    status = str(result.get("status") or "")
    code = str(result.get("error_code") or "")
    message = str(result.get("error") or "")
    if status == "complete":
        manifest["completed_at"] = resolve_queue._utc_now()
        resolve_queue.set_state(manifest, STATE_COMPLETE, clear_claim=True)
        return STATE_COMPLETE
    if status == "unavailable":
        if code in _BLOCKING_CODES:
            resolve_queue.set_state(
                manifest,
                STATE_BLOCKED,
                blocked={
                    "code": code,
                    "message": message,
                    "last_checked_at": resolve_queue._utc_now(),
                },
                resume_state=STATE_READY,
                error={"code": code, "message": message},
                clear_claim=True,
            )
            return STATE_BLOCKED
        # 결과를 확정하지 못했다 — 자동 재실행 금지.
        resolve_queue.set_state(
            manifest,
            STATE_INTERRUPTED,
            error={"code": code or "invalid_child_result", "message": message},
            policy=DISPATCH_MANUAL_ONLY,
            clear_claim=True,
        )
        return STATE_INTERRUPTED
    resolve_queue.set_state(
        manifest,
        STATE_FAILED,
        error={"code": code or "unexpected_error", "message": message},
        clear_claim=True,
    )
    return STATE_FAILED


def _import_and_record(
    path: Path, manifest: dict[str, Any], attempt: dict[str, Any]
) -> str:
    """가져오기 실행과 결과 기록을 한 동기 단위로 묶는다.

    ★분리하면 취소·종료가 그 사이를 끊었을 때 Resolve 는 바뀌었는데 manifest 는
    importing 으로 남는다(결과 유실). 그래서 자식 실행→journal→manifest 저장이 한
    스레드 안에서 끝난다.
    """
    result = run_resolve_import_isolated(manifest)
    attempt["result"] = {
        "status": str(result.get("status") or ""),
        "imported": int(result.get("imported") or 0),
        "skipped": int(result.get("skipped") or 0),
        "error_count": int(result.get("error_count") or 0),
    }
    attempt["error_code"] = result.get("error_code")
    attempt["error"] = result.get("error")
    attempt["phase"] = "complete" if result.get("status") == "complete" else "failed"
    with contextlib.suppress(OSError):
        resolve_queue.write_attempt(manifest, attempt)
    manifest["resolve_import"] = result
    state = _apply_import_result(manifest, result)
    resolve_queue.save_manifest(path, manifest)
    return state


async def import_transfer(manifest: dict[str, Any]) -> Optional[str]:
    """ready 한 건을 importing → complete/blocked/failed/interrupted 로 끝낸다."""
    path = resolve_queue.manifest_path_of(manifest)
    locks = await to_thread_non_abandon(_acquire_import_locks, manifest)
    if locks is None:
        return None
    try:
        current = await to_thread_non_abandon(resolve_queue.read_manifest, path)
        if resolve_queue.queue_state(current) != STATE_READY:
            return None
        if resolve_queue.dispatch_policy(current) != DISPATCH_AUTO:
            return None
        attempt_id = resolve_queue.new_attempt_id()
        claim = resolve_queue.build_claim(
            current, purpose="import", attempt_id=attempt_id
        )
        attempt = resolve_queue.new_attempt(
            current, attempt_id=attempt_id, claim=claim, executor="push_worker"
        )

        def _start() -> None:
            # attempt journal 을 먼저 쓴다 — 이 기록이 실패하면 Resolve 를 부르지 않는다.
            resolve_queue.write_attempt(current, attempt)
            block = resolve_queue.queue_block(current)
            block["claim"] = claim
            block["last_attempt_id"] = attempt_id
            resolve_queue.set_state(current, STATE_IMPORTING)
            resolve_queue.save_manifest(path, current)

        await to_thread_non_abandon(_start)
        return await resolve_queue.run_non_abandon(
            asyncio.to_thread(_import_and_record, path, current, attempt)
        )
    except resolve_queue.ResolveQueueError:
        return None
    finally:
        _release_locks(locks)


# ── blocked 재평가 (§B) ───────────────────────────────────────────────────────
def _blocked_retry_due(manifest: dict[str, Any]) -> bool:
    block = resolve_queue.queue_block(manifest)
    blocked = block.get("blocked") if isinstance(block.get("blocked"), dict) else {}
    if str(blocked.get("code") or "") not in _BLOCKING_CODES:
        return False
    changed = resolve_queue._parse_utc(str(block.get("state_changed_at") or ""))
    if changed is None:
        return True
    # 재시도마다 간격을 늘린다 — Resolve 를 닫아 둔 PC 에서 무한 재시도로 자식 프로세스를
    # 계속 띄우지 않게 한다.
    tries = int(block.get("blocked_retry_count") or 0)
    delay = min(_BLOCKED_RETRY_SECONDS * (2**tries), _BLOCKED_RETRY_MAX_SECONDS)
    waited = (datetime.now(timezone.utc) - changed).total_seconds()
    return waited >= delay


def _resume_blocked(manifest: dict[str, Any]) -> Optional[str]:
    """조건 회복 여부는 다음 실행이 판정한다 — 재큐잉만 하고 자동 재시도 횟수를 남긴다."""
    path = resolve_queue.manifest_path_of(manifest)
    lock = resolve_queue.transfer_lock(manifest)
    if not lock.try_acquire():
        return None
    try:
        current = resolve_queue.read_manifest(path)
        block = resolve_queue.queue_block(current)
        if resolve_queue.queue_state(current) != STATE_BLOCKED:
            return None
        tries = int(block.get("blocked_retry_count") or 0) + 1
        resume = str(block.get("resume_state") or STATE_QUEUED)
        resolve_queue.set_state(
            current, resume if resume in {STATE_QUEUED, STATE_READY} else STATE_QUEUED
        )
        resolve_queue.queue_block(current)["blocked_retry_count"] = tries
        resolve_queue.save_manifest(path, current)
        return resume
    except resolve_queue.ResolveQueueError:
        return None
    finally:
        lock.release()


# ── 드레인 루프 ───────────────────────────────────────────────────────────────
class ResolveQueueWorker:
    """전담 단일 워커. 준비·가져오기를 순차로 한 건씩 처리한다."""

    def __init__(self, interval: float = _INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        if not worker_enabled():
            return
        ok, detail = resolve_lock.self_test()
        if not ok:
            log_event(
                _log,
                "resolve_queue_locking_unsupported",
                level=logging.WARNING,
                detail=detail,
            )
            return
        self._task = asyncio.create_task(self._run(), name="resolve-queue")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        try:
            project_ids = await to_thread_non_abandon(_project_ids)
            counts = await to_thread_non_abandon(resolve_queue.recover_boot, project_ids)
            if counts:
                log_event(_log, "resolve_queue_boot_recovery", **counts)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 복구 실패가 워커 자체를 죽이지 않게 한다.
            log_event(
                _log, "resolve_queue_boot_recovery_failed", level=logging.WARNING, exc_info=True
            )
        await asyncio.sleep(_STARTUP_DELAY_SECONDS)
        while True:
            try:
                await self.drain_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log_event(_log, "resolve_queue_drain_failed", level=logging.WARNING, exc_info=True)
            await asyncio.sleep(self._interval)

    async def drain_once(self) -> list[str]:
        """FIFO 로 한 바퀴 처리한다. 반환값은 이번에 확정된 상태들(테스트·로그용)."""
        project_ids = await to_thread_non_abandon(_project_ids)
        manifests = await to_thread_non_abandon(
            resolve_queue.scan_projects, project_ids, states=resolve_queue.ACTIVE_STATES
        )
        done: list[str] = []
        for manifest in manifests:
            state = resolve_queue.queue_state(manifest)
            try:
                if state == STATE_QUEUED:
                    result = await prepare_transfer(manifest)
                elif state == STATE_READY and resolve_queue.dispatch_policy(
                    manifest
                ) == DISPATCH_AUTO:
                    result = await import_transfer(manifest)
                elif state == STATE_BLOCKED and _blocked_retry_due(manifest):
                    result = await to_thread_non_abandon(_resume_blocked, manifest)
                else:
                    result = None
            except resolve_lock.ResolveLockUnsupported as exc:
                log_event(
                    _log,
                    "resolve_queue_locking_unsupported",
                    level=logging.WARNING,
                    detail=str(exc),
                )
                return done
            if result:
                done.append(result)
        return done


periodic_resolve_queue = ResolveQueueWorker()
