"""Resolve 가져오기 큐 전담 워커 (manifest v3 명세 §2·§D).

준비(원본 복사)는 최대 3개 동시, Resolve 가져오기는 명세대로 항상 1개다. 자식 프로세스
대기에는 timeout 을 두지 않는다 — Media Pool 재정렬 도중을 끊으면 워커 안의 복구
코드가 실행되지 못한다. 유일한 예외는 사용자가 2차 확인까지 한 '강제 중단'이다.

실행 조건은 Windows + release 설치다. 개발·서버 설치에서는 켜지 않는다
(``CONTENT_HUB_RESOLVE_QUEUE_WORKER=1|0`` 으로 강제 지정 가능 — 테스트용).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
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
    STATE_CANCELLED,
    STATE_COMPLETE,
    STATE_FAILED,
    STATE_IMPORTING,
    STATE_INTERRUPTED,
    STATE_PREPARING,
    STATE_QUEUED,
    STATE_READY,
    STATE_RECOVERY_REQUIRED,
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
# 준비(복사) 동시 실행 수. 명세 §D: 기본 3, 허용 2~3, 최대 3. Resolve import 는 항상 1.
# ★같은 목적지 파일은 resolve_transfer._DEST_LOCKS 가 계속 직렬화하므로, 동시성이
# 늘어도 '둘이 같은 파일을 각자 복사한 뒤 서로 덮어쓰는' 경합은 생기지 않는다.
_PREPARE_SLOTS = max(
    2,
    min(3, int(os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_PREPARE_SLOTS", "3") or 3)),
)

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
        "journal_unavailable",
        "account_scope_changed",
        "destination_changed",
        "server_changed",
    }
)

# 서버 위임 모드에서 로컬에 없는 생성물을 다시 찾는 훅. 계층 경계(services→routers 금지)
# 때문에 라우터가 자기 모듈 로드 시 주입한다.
_remote_lookup: Optional[Callable[[str], Optional[dict[str, Any]]]] = None
# 지금 이 허브가 붙어 있는 공유 서버 origin 을 알려주는 훅(같은 이유로 라우터가 주입).
_server_origin: Optional[Callable[[], str]] = None


def set_remote_lookup(lookup: Optional[Callable[[str], Optional[dict[str, Any]]]]) -> None:
    global _remote_lookup
    _remote_lookup = lookup


def set_server_origin(provider: Optional[Callable[[], str]]) -> None:
    global _server_origin
    _server_origin = provider


def worker_enabled() -> bool:
    """설정상 v3 자동 워커를 켤 조건인가(§D)."""
    override = os.environ.get("CONTENT_HUB_RESOLVE_QUEUE_WORKER", "").strip().lower()
    if override in {"0", "off", "false", "no"}:
        return False
    if override in {"1", "on", "true", "yes"}:
        return True
    return os.name == "nt" and install_mode() == "release"


def worker_active() -> bool:
    """실제로 드레인 task 가 살아 있는가.

    ★API 는 이 값을 보고해야 한다. 설정 조건만 보면 잠금 self-test 실패로 워커가 아예
    기동하지 못한 PC 에서도 UI 가 '자동 가져오기 켜짐'으로 보여 사용자가 영원히 기다린다.
    """
    return periodic_resolve_queue.running


def worker_detail() -> str:
    """워커가 꺼져 있는 이유(있으면). UI 가 사용자에게 그대로 보여 준다."""
    if periodic_resolve_queue.running:
        return ""
    if not worker_enabled():
        return "이 PC에서는 Resolve 자동 가져오기를 쓰지 않습니다"
    return periodic_resolve_queue.last_error or "Resolve 가져오기 워커가 아직 시작되지 않았습니다"


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
    # 같은 계정이라도 붙어 있는 공유 서버가 바뀌면 접수 때와 다른 원본을 재조회하게 된다
    # (로그인 화면의 '서버 주소 변경' 탈출구가 실제로 이 조합을 만든다).
    expected_origin = str(scope.get("server_origin") or "")
    if _server_origin is not None:
        current_origin = ""
        with contextlib.suppress(Exception):
            current_origin = resolve_queue._origin_only(_server_origin() or "")
        if current_origin != expected_origin:
            return {
                "code": "server_changed",
                "expected": expected_origin,
                "observed": current_origin,
                "message": "접수할 때와 다른 공유 서버에 연결되어 있습니다",
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
        outcome = await to_thread_non_abandon(
            resolve_transfer.copy_prepared, source, dest
        )
    except ResolveTransferError as exc:
        # 메시지 파싱 없이 상태로 판정한다 — 목적지에 다른 파일이 있으면 충돌이다.
        _fail(
            "destination_conflict" if dest.exists() else "unexpected_error", str(exc)
        )
        return
    except Exception as exc:  # noqa: BLE001
        _fail("unexpected_error", str(exc))
        return

    prepare["state"] = (
        PREPARE_DOWNLOADED if outcome.status == "downloaded" else PREPARE_SKIPPED
    )
    prepare["error_code"] = None
    prepare["error"] = None
    # 해시는 복사 스트림에서 이미 계산됐다 — 여기서 파일을 다시 읽지 않는다(§3.2).
    prepare["sha256"] = outcome.sha256
    prepare["size"] = outcome.size
    prepare["mtime_ns"] = outcome.mtime_ns


def _cancel_now(path: Path, manifest: dict[str, Any], request: dict[str, Any]) -> str:
    """협력적 취소를 확정한다 — 이미 복사한 파일은 그대로 두고 큐만 폐기한다."""
    resolve_queue.record_cancel(manifest, request)
    resolve_queue.set_state(
        manifest,
        STATE_CANCELLED,
        error={"code": "cancelled", "message": "사용자가 전송을 폐기했습니다"},
        clear_claim=True,
    )
    resolve_queue.save_manifest(path, manifest)
    return STATE_CANCELLED


async def prepare_transfer(manifest: dict[str, Any]) -> Optional[str]:
    """queued 한 건을 preparing → ready/blocked/failed/cancelled 로 끝낸다. 반환=최종 상태."""
    path = resolve_queue.manifest_path_of(manifest)
    transfer_id = str(manifest.get("transfer_id") or "")
    lock = resolve_queue.transfer_lock(manifest)
    if not await to_thread_non_abandon(lock.try_acquire):
        return None
    account_token = None
    try:
        current = await to_thread_non_abandon(resolve_queue.read_manifest, path)
        if resolve_queue.queue_state(current) != STATE_QUEUED:
            return None
        cancel = resolve_queue.cancel_requested(transfer_id, current)
        if cancel is not None:
            # 락을 잡기 직전에 취소가 들어온 경우 — 복사를 시작조차 하지 않는다.
            state = await to_thread_non_abandon(_cancel_now, path, current, cancel)
            resolve_queue.clear_cancel(transfer_id, current)
            return state
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
            if not isinstance(item, dict):
                continue
            # ★취소는 '항목 사이'에서만 본다(§D 협력적 취소). 복사 한 건을 중간에서
            # 끊으면 .part 정리와 무결성 기록이 어긋난다 — 한 파일은 끝까지 간다.
            # ★여기서는 사이드카를 읽지 않는다(manifest 를 넘기지 않는다): 항목마다 NAS 에
            # 없는 파일을 열어 보면 100개짜리 전송이 왕복 100번을 더 한다. 앞선 프로세스의
            # 요청은 이 단계 진입 때 이미 승계했고, 이 프로세스의 새 요청은 메모리에 있다.
            cancel = resolve_queue.cancel_requested(transfer_id)
            if cancel is not None:
                state = await to_thread_non_abandon(_cancel_now, path, current, cancel)
                resolve_queue.clear_cancel(transfer_id, current)
                return state
            await _prepare_item(current, item)

        cancel = resolve_queue.cancel_requested(transfer_id, current)
        if cancel is not None:
            state = await to_thread_non_abandon(_cancel_now, path, current, cancel)
            resolve_queue.clear_cancel(transfer_id, current)
            return state

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


def _isolate_orphan_rebuild(
    manifest: dict[str, Any], staging: str, attempt: Optional[dict[str, Any]] = None
) -> str:
    """journal 이 가리키는 고아 임시 Bin 을 격리한다(§3.1). 자동 재실행 금지."""
    drp_path = str((attempt or {}).get("drp_path") or "")
    manifest["recovery"] = {
        **resolve_queue.build_recovery(
            manifest, reason="orphan_rebuild_bin", attempt=attempt
        ),
        "staging_bin": staging,
        "drp_path": drp_path,
    }
    with contextlib.suppress(OSError):
        resolve_queue.write_recovery_incident(
            manifest,
            {
                "reason": "orphan_rebuild_bin",
                "transfer_id": str(manifest.get("transfer_id") or ""),
                "staging_bin": staging,
                "drp_path": drp_path,
            },
        )
    resolve_queue.set_state(
        manifest,
        resolve_queue.STATE_RECOVERY_REQUIRED,
        error={
            "code": "orphan_rebuild_bin",
            "message": (
                "Resolve Bin 재정렬이 끝나기 전에 중단됐습니다. "
                f"임시 Bin {staging} 을(를) 확인한 뒤 복구 방법을 선택하세요"
            ),
        },
        policy=DISPATCH_MANUAL_ONLY,
        clear_claim=True,
    )
    return resolve_queue.STATE_RECOVERY_REQUIRED


def _apply_import_result(
    manifest: dict[str, Any],
    result: dict[str, Any],
    *,
    attempt: Optional[dict[str, Any]] = None,
) -> str:
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
        # ★가져온 것만 보고 complete 로 확정하면, 준비 단계에서 떨어진 항목이 조용히
        # 사라진다. 권위 상태는 실패로 두고(재시도 가능) v2 투영만 partial 로 적는다
        # (명세 §1.3 "partial 은 권위 상태로 쓰지 않는다").
        prepare_errors = resolve_queue.prepared_error_codes(manifest)
        if prepare_errors:
            manifest["completed_at"] = resolve_queue._utc_now()
            projection = manifest.get("resolve_import")
            if isinstance(projection, dict):
                projection["status"] = "partial"
            first_code, first_message = prepare_errors[0]
            resolve_queue.set_state(
                manifest,
                STATE_FAILED,
                error={
                    "code": first_code,
                    "message": (
                        f"원본 {len(prepare_errors)}개를 준비하지 못해 일부만 가져왔습니다"
                        + (f": {first_message}" if first_message else "")
                    ),
                },
                clear_claim=True,
            )
            return STATE_FAILED
        manifest["completed_at"] = resolve_queue._utc_now()
        resolve_queue.set_state(manifest, STATE_COMPLETE, clear_claim=True)
        return STATE_COMPLETE
    # 자식이 남긴 journal 이 rebuild 중간 phase 에 멈춰 있으면 임시 Bin 이 그대로다.
    # 실패·중단 결과보다 이 격리가 우선한다(§3.1 — 자동 import 를 막아야 한다).
    staging = resolve_queue.orphan_staging_bin(attempt)
    if staging:
        return _isolate_orphan_rebuild(manifest, staging, attempt)
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
        # 결과를 확정하지 못했다 — 자동 재실행 금지. 누락 목록만 자동으로 만든다(§3.3).
        manifest["recovery"] = resolve_queue.build_recovery(
            manifest, reason="interrupted_import_missing_items", attempt=attempt
        )
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


def force_stop_import(manifest: dict[str, Any]) -> bool:
    """진행 중인 가져오기 자식을 끊는다 — 사용자의 2차 확인(force)이 있을 때만(§D).

    자식이 attempt journal 에 자기 PID 와 생성 시각을 적어 두므로 그 프로세스만 정확히
    끊을 수 있다(PID 재사용을 확인 없이 죽이지 않는다). 부모를 재시작한 뒤 남은 고아
    자식도 같은 방법으로 끊을 수 있어, 부모가 쥔 핸들에 의존하는 방식보다 넓게 듣는다.
    """
    attempt = resolve_queue.latest_attempt(manifest)
    if not isinstance(attempt, dict):
        return False
    if str(attempt.get("host_id") or "") not in {"", resolve_lock.host_id()}:
        return False  # 다른 PC 의 자식은 여기서 끊을 수 없다.
    try:
        pid = int(attempt.get("executor_pid") or 0)
    except (TypeError, ValueError):
        return False
    if pid <= 0 or pid == os.getpid():
        # ★자식이 시작하기 전이면 journal 에는 부모 PID 만 있다. 그걸 끊으면 허브가 죽는다.
        return False
    stopped = resolve_lock.terminate_process(
        pid, str(attempt.get("process_started_at_filetime") or "")
    )
    if stopped:
        log_event(
            _log,
            "resolve_queue_import_force_stopped",
            level=logging.WARNING,
            transfer_id=str(manifest.get("transfer_id") or ""),
        )
    return stopped


def _force_cancelled_import(
    manifest: dict[str, Any], attempt: Optional[dict[str, Any]]
) -> str:
    """강제 중단된 가져오기 — 부수효과 범위를 알 수 없으므로 항상 복구 확인이다(§D)."""
    manifest["recovery"] = resolve_queue.build_recovery(
        manifest, reason="force_cancelled_import", attempt=attempt
    )
    with contextlib.suppress(OSError):
        resolve_queue.write_recovery_incident(
            manifest,
            {
                "reason": "force_cancelled_import",
                "transfer_id": str(manifest.get("transfer_id") or ""),
                "drp_path": str((attempt or {}).get("drp_path") or ""),
            },
        )
    resolve_queue.set_state(
        manifest,
        STATE_RECOVERY_REQUIRED,
        error={
            "code": "cancelled",
            "message": (
                "가져오기를 강제로 중단했습니다. Resolve 의 MV Hub Bin 과 임시 Bin 을 "
                "확인한 뒤 복구 방법을 선택하세요"
            ),
        },
        policy=DISPATCH_MANUAL_ONLY,
        clear_claim=True,
    )
    return STATE_RECOVERY_REQUIRED


def _import_and_record(
    path: Path, manifest: dict[str, Any], attempt: dict[str, Any]
) -> str:
    """가져오기 실행과 결과 기록을 한 동기 단위로 묶는다.

    ★분리하면 취소·종료가 그 사이를 끊었을 때 Resolve 는 바뀌었는데 manifest 는
    importing 으로 남는다(결과 유실). 그래서 자식 실행→journal→manifest 저장이 한
    스레드 안에서 끝난다.
    """
    result = run_resolve_import_isolated(manifest)
    # ★자식이 같은 파일에 phase·staging Bin·자기 PID 를 적어 뒀다. 부모의 옛 사본으로
    # 통째로 덮어쓰면 고아 Bin 근거가 사라진다 — 디스크본을 다시 읽어 결과만 얹는다.
    written = resolve_queue.read_attempt(manifest, str(attempt.get("attempt_id") or ""))
    record = written if written is not None else attempt
    record["result"] = {
        "status": str(result.get("status") or ""),
        "imported": int(result.get("imported") or 0),
        "skipped": int(result.get("skipped") or 0),
        "error_count": int(result.get("error_count") or 0),
    }
    record["error_code"] = result.get("error_code")
    record["error"] = result.get("error")
    # ★rebuild 중간 phase 는 덮지 않는다 — 자식이 그 지점에서 죽었다는 사실이 고아 임시
    # Bin 을 격리할 유일한 근거다. 여기서 failed 로 지우면 복구기가 찾지 못한다.
    if str(record.get("phase") or "") not in resolve_queue.REBUILD_PENDING_PHASES:
        record["phase"] = "complete" if result.get("status") == "complete" else "failed"
    with contextlib.suppress(OSError):
        resolve_queue.write_attempt(manifest, record)
    manifest["resolve_import"] = result
    transfer_id = str(manifest.get("transfer_id") or "")
    cancel = resolve_queue.cancel_requested(transfer_id, manifest)
    if cancel is not None and cancel.get("force"):
        # 사용자가 자식을 끊었다 — 결과가 무엇이든 부수효과 범위를 확정할 수 없다.
        resolve_queue.record_cancel(manifest, cancel)
        state = _force_cancelled_import(manifest, record)
    else:
        state = _apply_import_result(manifest, result, attempt=record)
    resolve_queue.save_manifest(path, manifest)
    resolve_queue.clear_cancel(transfer_id, manifest)
    return state


async def import_transfer(manifest: dict[str, Any]) -> Optional[str]:
    """ready 한 건을 importing → complete/blocked/failed/interrupted 로 끝낸다."""
    path = resolve_queue.manifest_path_of(manifest)
    transfer_id = str(manifest.get("transfer_id") or "")
    locks = await to_thread_non_abandon(_acquire_import_locks, manifest)
    if locks is None:
        return None
    try:
        current = await to_thread_non_abandon(resolve_queue.read_manifest, path)
        if resolve_queue.queue_state(current) != STATE_READY:
            return None
        if resolve_queue.dispatch_policy(current) != DISPATCH_AUTO:
            return None
        cancel = resolve_queue.cancel_requested(transfer_id, current)
        if cancel is not None:
            # Resolve 를 아직 만지지 않은 경계 — 여기서 멈추면 부수효과가 없다.
            state = await to_thread_non_abandon(_cancel_now, path, current, cancel)
            resolve_queue.clear_cancel(transfer_id, current)
            return state
        # 준비한 파일이 그 사이에 바뀌지 않았는지 확인한다(§3.2). 복사 때 스트림에서
        # 계산해 둔 sha256 이 권위이고, 크기·mtime 이 기록과 같으면 재해시는 생략한다.
        if await to_thread_non_abandon(resolve_queue.verify_prepared_items, current):
            prepared = int(current.get("downloaded") or 0) + int(current.get("skipped") or 0)
            if not prepared:
                def _integrity_failed() -> None:
                    resolve_queue.set_state(
                        current,
                        STATE_FAILED,
                        error={
                            "code": resolve_queue.INTEGRITY_MISMATCH,
                            "message": "준비한 원본이 달라져 가져오기를 중단했습니다",
                        },
                        clear_claim=True,
                    )
                    resolve_queue.save_manifest(path, current)

                await to_thread_non_abandon(_integrity_failed)
                return STATE_FAILED
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


def _resume_blocked(
    manifest: dict[str, Any], *, reset_retries: bool = False
) -> Optional[str]:
    """조건 회복 여부는 다음 실행이 판정한다 — 재큐잉만 하고 자동 재시도 횟수를 남긴다.

    ``reset_retries`` 는 '조건이 실제로 바뀐 사건'(Resolve 프로젝트 열림 등)으로 불릴 때
    쓴다. 시간이 흘러서가 아니라 상황이 달라져 재시도하는 것이므로 백오프를 처음으로
    되돌린다.
    """
    path = resolve_queue.manifest_path_of(manifest)
    lock = resolve_queue.transfer_lock(manifest)
    if not lock.try_acquire():
        return None
    try:
        current = resolve_queue.read_manifest(path)
        block = resolve_queue.queue_block(current)
        if resolve_queue.queue_state(current) != STATE_BLOCKED:
            return None
        tries = 0 if reset_retries else int(block.get("blocked_retry_count") or 0) + 1
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


# Resolve 연결 상태 조회가 관측한 마지막 프로젝트. 같은 값이면 아무 것도 하지 않는다
# (상태 조회는 UI 가 자주 부르므로 매번 NAS manifest 를 훑으면 안 된다).
_last_seen_project: Optional[tuple[str, str]] = None
_LAST_SEEN_GUARD = threading.Lock()
# 열린 Resolve 프로젝트가 바뀌면 즉시 되살릴 수 있는 보류 코드(§B 재평가 트리거).
_PROJECT_EVENT_CODES = frozenset(
    {"project_changed", "target_unverifiable", "not_running", "no_project", "api_unavailable"}
)


def reset_resolve_project_memo() -> None:
    global _last_seen_project
    with _LAST_SEEN_GUARD:
        _last_seen_project = None


def note_resolve_project(status: dict[str, Any]) -> int:
    """Resolve 상태 조회가 성공했을 때 blocked 를 **즉시** 재평가한다(§B 트리거).

    백오프는 최대 15분까지 벌어진다. 사용자가 대상 프로젝트를 방금 열었는데 그만큼
    기다리게 하면 '큐가 멈춘 것처럼' 보인다. 관측된 프로젝트가 직전과 달라진 순간에만
    한 번 훑어 되살린다(같은 값이면 파일을 읽지 않는다).
    """
    global _last_seen_project
    if str(status.get("status") or "") != "ready":
        return 0
    observed = (
        str(status.get("project_id") or ""),
        str(status.get("project_name") or ""),
    )
    if not observed[0] and not observed[1]:
        return 0
    with _LAST_SEEN_GUARD:
        if _last_seen_project == observed:
            return 0
        _last_seen_project = observed
    resumed = 0
    for manifest in resolve_queue.scan_projects(
        _project_ids(), states={STATE_BLOCKED}
    ):
        block = resolve_queue.queue_block(manifest)
        blocked = block.get("blocked") if isinstance(block.get("blocked"), dict) else {}
        if str(blocked.get("code") or "") not in _PROJECT_EVENT_CODES:
            continue
        if not _targets_project(manifest, observed):
            continue
        if _resume_blocked(manifest, reset_retries=True):
            resumed += 1
    return resumed


def _targets_project(manifest: dict[str, Any], observed: tuple[str, str]) -> bool:
    """이 전송의 대상이 지금 열린 프로젝트인가(§B 일치 규칙 — ID 우선, 없으면 이름)."""
    target = manifest.get("resolve_target") or {}
    expected_id = str(target.get("project_id") or "")
    expected_name = str(target.get("project_name") or "")
    observed_id, observed_name = observed
    if not expected_id and not expected_name:
        return True  # 대상을 고정하지 않은 전송은 어떤 프로젝트에서도 재평가한다.
    if expected_id and observed_id:
        return expected_id == observed_id
    return bool(expected_name) and expected_name == observed_name


# ── 드레인 루프 ───────────────────────────────────────────────────────────────
class ResolveQueueWorker:
    """전담 단일 워커. 준비·가져오기를 순차로 한 건씩 처리한다."""

    def __init__(self, interval: float = _INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None
        self.last_error: str = ""

    @property
    def running(self) -> bool:
        """드레인 task 가 실제로 살아 있는가(API 가 보고하는 값의 근거)."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        if not worker_enabled():
            return
        ok, detail = resolve_lock.self_test()
        if not ok:
            self.last_error = detail or "이 PC에서는 파일 범위 잠금을 쓸 수 없습니다"
            log_event(
                _log,
                "resolve_queue_locking_unsupported",
                level=logging.WARNING,
                detail=detail,
            )
            return
        self.last_error = ""
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
        """FIFO 로 한 바퀴 처리한다. 반환값은 이번에 확정된 상태들(테스트·로그용).

        준비(복사)는 최대 3개를 동시에 돌리고, Resolve 가져오기는 항상 하나씩 FIFO 로
        한다. 반환 순서는 동시 실행과 무관하게 항상 FIFO 다.
        """
        project_ids = await to_thread_non_abandon(_project_ids)
        manifests = await to_thread_non_abandon(
            resolve_queue.scan_projects, project_ids, states=resolve_queue.ACTIVE_STATES
        )
        # 부모(허브)가 죽어도 살아 있는 자식이 있는 프로젝트는 Resolve 를 만지지 않는다.
        held = await to_thread_non_abandon(resolve_queue.import_held_roots, manifests)
        if held:
            log_event(
                _log,
                "resolve_queue_import_executor_alive",
                level=logging.WARNING,
                roots=len(held),
            )
        usable: list[dict[str, Any]] = []
        for manifest in manifests:
            manifest_root = str(manifest.get("manifest_root") or "")
            ok, detail = await to_thread_non_abandon(
                resolve_queue._root_locking_ok, Path(manifest_root)
            )
            if ok:
                usable.append(manifest)
                continue
            # 이 루트에서는 이중 드레인을 막을 수단이 없다 — 건드리지 않는다(§2.2).
            log_event(
                _log,
                "resolve_queue_root_locking_unsupported",
                level=logging.WARNING,
                detail=detail,
                manifest_root=manifest_root,
            )
        outcomes: list[Optional[str]] = [None] * len(usable)
        unsupported = False

        # ── 1) 준비: 최대 3개 동시 ──────────────────────────────────────────
        # 파일 복사는 Resolve 를 전혀 만지지 않으므로 병렬이 안전하다. 같은 목적지는
        # resolve_transfer._DEST_LOCKS 가 계속 직렬화하고, 서로 다른 전송은 각자의
        # transfer 락을 잡으므로 manifest 경합도 없다.
        slots = asyncio.Semaphore(_PREPARE_SLOTS)

        async def _prepare_slot(manifest: dict[str, Any]) -> Optional[str]:
            nonlocal unsupported
            async with slots:
                try:
                    return await prepare_transfer(manifest)
                except resolve_lock.ResolveLockUnsupported as exc:
                    unsupported = True
                    log_event(
                        _log,
                        "resolve_queue_locking_unsupported",
                        level=logging.WARNING,
                        detail=str(exc),
                    )
                    return None

        prepare_slots = [
            index
            for index, manifest in enumerate(usable)
            if resolve_queue.queue_state(manifest) == STATE_QUEUED
        ]
        if prepare_slots:
            # ★return_exceptions — 한 건이 터졌다고 gather 가 먼저 반환하면 나머지 준비
            # task 가 락을 쥔 채 아무도 기다리지 않는 고아가 된다. 전부 끝난 뒤 모은다.
            prepared = await asyncio.gather(
                *(_prepare_slot(usable[index]) for index in prepare_slots),
                return_exceptions=True,
            )
            for index, state in zip(prepare_slots, prepared):
                if isinstance(state, BaseException):
                    log_event(
                        _log,
                        "resolve_queue_prepare_failed",
                        level=logging.WARNING,
                        detail=str(state),
                    )
                    continue
                outcomes[index] = state

        # ── 2) 가져오기·보류 재평가: 항상 순차 ──────────────────────────────
        for index, manifest in enumerate(usable):
            state = resolve_queue.queue_state(manifest)
            if state == STATE_QUEUED:
                continue  # 위에서 이미 처리했다.
            manifest_root = str(manifest.get("manifest_root") or "")
            try:
                if (
                    state == STATE_READY
                    and not unsupported
                    and resolve_queue.dispatch_policy(manifest) == DISPATCH_AUTO
                    and resolve_queue.path_identity(manifest_root) not in held
                ):
                    outcomes[index] = await import_transfer(manifest)
                elif state == STATE_BLOCKED and _blocked_retry_due(manifest):
                    outcomes[index] = await to_thread_non_abandon(
                        _resume_blocked, manifest
                    )
            except resolve_lock.ResolveLockUnsupported as exc:
                log_event(
                    _log,
                    "resolve_queue_locking_unsupported",
                    level=logging.WARNING,
                    detail=str(exc),
                )
                break

        # ── 3) 완료분 정리: 보존 기간이 지난 터미널 기록만 소량씩 ────────────
        # 활성 처리가 다 끝난 뒤에 한다 — 정리는 절대 큐 진행을 늦추면 안 된다.
        await self._purge_expired(project_ids)
        return [state for state in outcomes if state]

    async def _purge_expired(self, project_ids: list[str]) -> int:
        """오래된 터미널 manifest 청소. 실패는 로그만 남기고 드레인을 계속한다."""
        try:
            removed = await to_thread_non_abandon(
                resolve_queue.purge_expired_terminals, project_ids
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 청소 실패가 큐 처리를 멈출 이유는 없다.
            log_event(_log, "resolve_queue_cleanup_failed", level=logging.WARNING, exc_info=True)
            return 0
        if removed:
            log_event(
                _log,
                "resolve_queue_cleanup",
                removed=removed,
                retention_days=resolve_queue.TERMINAL_RETENTION_DAYS,
            )
        return removed


periodic_resolve_queue = ResolveQueueWorker()
