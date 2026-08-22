"""gen-request 업무 흐름(usecase).

라우터가 인증·권한·입력검증을 끝낸 값만 받아, placeholder 생성·큐잉부터 claim,
완료/실패/재조정 저장, PM 기록, 계정 범위 알림까지의 오케스트레이션을 수행한다. FastAPI 미의존.
(ARCHITECTURE.md: routers -> usecases -> repo/services)
"""

from __future__ import annotations

import logging
import asyncio
import functools
import inspect
import json
import re
import sqlite3
import threading
import time
from dataclasses import dataclass

from .. import active_account, repo
from ..config import MANAGE_ENABLED
from ..generation_result import ACTIVE_STATUSES, normalize_job_result
from ..models import RegenerateIn
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..services.async_tools import to_thread_non_abandon
from ..services.event_journal import journal_generation_event
from ..services.operational_logging import log_event
from ..ws import manager
from ..workspace_context import normalize_workspace_context


_generation_log = logging.getLogger("mvhub.generation")
_pm_failure_log_lock = threading.Lock()
_pm_last_failure_log_at = 0.0
_PM_FAILURE_LOG_INTERVAL = 300.0
_estimate_tasks: set[asyncio.Task[None]] = set()


class RecoveryRequeueBlocked(RuntimeError):
    """자동 조사 결론을 먼저 반영해야 해 명시 재큐를 보류할 때의 사용자 안내."""

_HF_ENDED_RE = re.compile(
    r"\bjob\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    r"\s+ended with status\s+['\"]?([A-Za-z_ -]+)['\"]?",
    re.IGNORECASE,
)


async def _sync_io(action, /, *args, **kwargs):
    """동기 SQLite 작업을 워커 스레드에서 끝낸다.

    repo 함수 하나가 여는 get_connection 컨텍스트를 한 번의 to_thread 호출 안에서 완료한다.
    따라서 트랜잭션/스레드-로컬 커넥션이 이벤트 루프와 워커 스레드 사이를 넘지 않는다.
    """
    return await to_thread_non_abandon(action, *args, **kwargs)


def _account_scoped(email_parameter: str, *, from_request_row: bool = False):
    """공개 usecase 전체를 인증 요청의 계정 DB에 고정한다.

    transition_lock은 문자열 캡처까지만 잡는다. 이후 await·네트워크·DB 트랜잭션은
    ContextVar override만 사용하므로 로그인 전환을 막지 않는다.
    """

    def decorate(action):
        signature = inspect.signature(action)

        def account_email(args, kwargs) -> str:
            bound = signature.bind(*args, **kwargs)
            value = bound.arguments[email_parameter]
            if from_request_row:
                value = value.get("account_email") if isinstance(value, dict) else None
            elif not isinstance(value, str):
                value = getattr(value, "email", None)
            if value:
                # 인자로 계정이 이미 정해진 호출은 공유 상태(active.json 포인터)를 전혀 읽지
                # 않는다 — 락 안에서 읽던 것이 없으니 의미 변화 0이고, 로그인 마이그레이션·DB
                # 복원이 transition_lock 을 초 단위로 쥐는 동안 usecase 호출이 통째로 대기하던
                # 것만 사라진다. 락은 '포인터 폴백 캡처'일 때만 잡는다.
                return str(value).strip()
            with active_account.transition_lock:
                return str(active_account.account_key() or "").strip()

        if inspect.iscoroutinefunction(action):
            @functools.wraps(action)
            async def async_scoped(*args, **kwargs):
                captured_email = account_email(args, kwargs)
                token = active_account.set_override(captured_email)
                try:
                    return await action(*args, **kwargs)
                finally:
                    active_account.reset_override(token)

            return async_scoped

        @functools.wraps(action)
        def sync_scoped(*args, **kwargs):
            captured_email = account_email(args, kwargs)
            token = active_account.set_override(captured_email)
            try:
                return action(*args, **kwargs)
            finally:
                active_account.reset_override(token)

        return sync_scoped

    return decorate


def _has_usable_asset_path(value: object) -> bool:
    """완료를 확정할 수 있는 실제 결과 위치인지 확인한다.

    CLI 재조정은 보통 HTTP(S) CDN URL을 주지만, 로컬 테스트/레거시 fulfill은 Windows 절대
    경로를 쓸 수 있어 둘 다 허용한다. 상태 문자열 같은 임의 텍스트는 완료 근거가 아니다.
    """
    if not isinstance(value, str) or not value.strip():
        return False
    path = value.strip()
    return bool(
        path.startswith(("https://", "http://", "/"))
        or re.match(r"^[A-Za-z]:[\\/]", path)
    )


def _log_pm_failure(operation: str, exc: BaseException) -> None:
    """부가 통계 장애는 생성을 막지 않되, 같은 장애의 로그 폭주는 5분에 1회로 제한한다."""
    global _pm_last_failure_log_at
    now = time.monotonic()
    with _pm_failure_log_lock:
        if now - _pm_last_failure_log_at < _PM_FAILURE_LOG_INTERVAL:
            return
        _pm_last_failure_log_at = now
    log_event(
        _generation_log,
        "pm_metrics_failed",
        level=logging.WARNING,
        operation=operation,
        error_type=type(exc).__name__,
    )


def pm_best_effort(
    action,
    *,
    operation: str = "record",
    dirty_gen_id: str | None = None,
) -> None:
    """PM 메트릭 best-effort 실행(분리형). MANAGE_ENABLED off 거나 실패해도 생성 흐름·응답에
    영향 0 — 메트릭 수집은 절대 생성을 막지 않는다(PM_DASHBOARD_DESIGN.md §6-1).
    action은 manage 모듈을 받는 콜러블이다. dirty_gen_id가 있으면 메트릭 저장 뒤 해당 생성물을
    중앙 전송 대기열에 함께 표시한다."""
    if not MANAGE_ENABLED:
        return
    try:
        from ..repo import manage as _m

        action(_m)
        if dirty_gen_id:
            _m.mark_telemetry_dirty([dirty_gen_id])
    except Exception as exc:  # noqa: BLE001 — 메트릭 실패가 생성을 막지 않게
        _log_pm_failure(operation, exc)


async def _record_request_estimate(
    gen_id: str,
    account_email: str,
    payload: dict,
) -> None:
    """부가 견적은 생성 응답과 분리한다. 느린 CLI 조회가 카드 연결을 늦추면 안 된다."""
    token = active_account.set_override(account_email)
    try:
        est = None
        try:
            if cli_bridge.cli_available():
                cc = await cli_bridge.estimate_cost(
                    payload.get("model"), payload.get("params"), payload.get("prompt") or ""
                )
                value = (cc or {}).get("credits")
                est = int(value) if value else None
        except Exception as exc:  # noqa: BLE001 — 부가 견적 실패는 생성에 영향 없음
            _log_pm_failure("estimate_cost", exc)
        await _sync_io(
            pm_best_effort,
            lambda _m: _m.record_request(gen_id, est_credits=est),
            operation="record_request_estimate",
            dirty_gen_id=gen_id,
        )
    finally:
        active_account.reset_override(token)


def _schedule_request_estimate(gen_id: str, account_email: str, payload: dict) -> None:
    if not MANAGE_ENABLED:
        return
    task = asyncio.create_task(_record_request_estimate(gen_id, account_email, payload))
    _estimate_tasks.add(task)
    task.add_done_callback(_estimate_tasks.discard)


async def shutdown_request_estimates() -> None:
    """서버 종료 시 대기·실행 중 견적을 취소하고 CLI 자식 회수까지 기다린다."""
    tasks = tuple(_estimate_tasks)
    if not tasks:
        return
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@dataclass
class GenRequestCommand:
    """라우터가 인증·권한·입력검증을 끝내고 만든 '검증된 제출 명령'. usecase 는 이걸 실행만 한다.
    worker_id 는 라우터가 계산해서 담는다(regenerate 는 parent 기준 — usecase 가 다시 읽으면 동작이 달라짐)."""

    kind: str  # 'create' | 'regenerate'
    email: str
    creator_uid: str | None
    worker_id: str
    source_gen_id: str | None
    workspace: dict | None = None
    data: dict | None = None  # kind=create 의 정규화된 GenerationCreate dump
    regenerate: RegenerateIn | None = None  # kind=regenerate 옵션
    canvas_link: dict[str, str] | None = None
    idempotency_key: str | None = None  # 일반(비캔버스) 제출 의도 UUID
    request_contract: dict | None = None  # 파생 기본값을 제외한 정규화 HTTP payload


class CanvasGenerationConflict(RuntimeError):
    """같은 캔버스 시도 ID가 서로 다른 생성 명령/목적지를 가리킬 때의 안전 중단."""


class GenerationIdempotencyConflict(RuntimeError):
    """같은 일반 요청 키가 서로 다른 생성 payload를 가리킬 때의 안전 중단."""


def _canvas_command_contract(cmd: GenRequestCommand) -> dict:
    """재시도가 최초 제출과 같은 명령인지 판별할 최소 계약."""
    return {
        "kind": cmd.kind,
        "worker_id": cmd.worker_id,
        "source_gen_id": cmd.source_gen_id,
        "workspace": normalize_workspace_context(cmd.workspace),
        "create": cmd.data if cmd.kind == "create" else None,
        "regenerate": (
            (cmd.regenerate or RegenerateIn()).model_dump()
            if cmd.kind == "regenerate"
            else None
        ),
    }


def _idempotency_command_contract(cmd: GenRequestCommand) -> dict:
    """일반 제출 재시도의 동일성을 판별할 정규화된 사용자 입력 계약."""
    if cmd.request_contract is not None:
        return cmd.request_contract
    return {
        "kind": cmd.kind,
        "workspace": normalize_workspace_context(cmd.workspace),
        "create": cmd.data if cmd.kind == "create" else None,
        "source_gen_id": cmd.source_gen_id,
        "regenerate": (
            (cmd.regenerate or RegenerateIn()).model_dump()
            if cmd.kind == "regenerate"
            else None
        ),
    }


def _idempotency_reservation_matches(
    reservation: dict, kind: str, idempotency_key: str, contract: dict
) -> bool:
    if (
        reservation.get("kind") != kind
        or reservation.get("idempotency_key") != idempotency_key
    ):
        return False
    try:
        stored = json.loads(reservation.get("payload") or "{}")
    except (TypeError, ValueError):
        return False
    return stored.get("_idempotency_contract") == contract


def _reservation_matches(
    reservation: dict,
    canvas_link: dict[str, str],
    kind: str,
    contract: dict,
) -> bool:
    if (
        reservation.get("gen_id") != canvas_link["generation_id"]
        or reservation.get("kind") != kind
        or reservation.get("scene_id") != canvas_link["scene_id"]
        or reservation.get("card_id") != canvas_link["card_id"]
    ):
        return False
    try:
        stored = json.loads(reservation.get("payload") or "{}")
    except (TypeError, ValueError):
        stored = {}
    stored_contract = stored.get("_canvas_contract")
    # RL-06 이전 요청은 계약 필드가 없다. 링크 4종이 정확히 같으면 기존 요청을 재사용한다.
    return stored_contract is None or stored_contract == contract


def _expected_create_recipe(cmd: GenRequestCommand) -> dict:
    data = cmd.data or {}
    return {
        "model": data.get("model"),
        "prompt": data.get("prompt"),
        "params": data.get("params") or {},
        "references": [
            {
                "file_path": (
                    ref.get("source_url")
                    if ref.get("source_url") is not None
                    else ref.get("file_path")
                ),
                "type": ref.get("type", "image"),
                "role": ref.get("role"),
            }
            for ref in (data.get("references") or [])
        ],
        "workspace": normalize_workspace_context(cmd.workspace),
    }


async def _resolve_canvas_placeholder_collision(
    cmd: GenRequestCommand,
    contract: dict,
) -> dict | None:
    """동시 재시도가 placeholder를 먼저 만든/활성화한 경우를 권위 DB로 판정한다.

    반환값이 generation이면 다른 요청이 이미 끝낸 것이고, None이면 현재 요청이 preparing
    예약을 이어서 활성화해야 한다. 안전한 동일 요청이 아니면 409용 예외를 낸다.
    """
    link = cmd.canvas_link
    if not link:
        raise CanvasGenerationConflict("캔버스 생성 연결 정보가 없습니다")
    fresh = await _sync_io(
        repo.reserve_canvas_gen_request,
        cmd.email,
        cmd.creator_uid,
        link["generation_id"],
        cmd.kind,
        link,
        contract,
    )
    if not _reservation_matches(fresh, link, cmd.kind, contract):
        raise CanvasGenerationConflict(
            "같은 캔버스 생성 시도 ID가 다른 카드 또는 생성 명령에 이미 사용되었습니다"
        )
    if fresh.get("status") != "preparing":
        generation = await _sync_io(repo.get_generation, link["generation_id"])
        if generation:
            return generation
        raise CanvasGenerationConflict(
            "기존 캔버스 생성 요청의 placeholder를 찾을 수 없습니다"
        )
    if not await _sync_io(
        repo.canvas_placeholder_is_resumable,
        cmd.email,
        cmd.creator_uid,
        link,
        cmd.kind,
        cmd.source_gen_id,
    ):
        raise CanvasGenerationConflict(
            "같은 생성 ID가 다른 요청에 사용 중이라 안전하게 이어갈 수 없습니다"
        )
    return None


async def _resolve_idempotent_placeholder_collision(
    cmd: GenRequestCommand,
    contract: dict,
) -> dict | None:
    """동시 일반 재시도가 같은 placeholder INSERT에서 충돌한 뒤 권위 행으로 수렴한다."""
    if not cmd.idempotency_key:
        raise GenerationIdempotencyConflict("일반 생성 요청 키가 없습니다")
    fresh = await _sync_io(
        repo.reserve_idempotent_gen_request,
        cmd.email,
        cmd.creator_uid,
        cmd.kind,
        cmd.idempotency_key,
        contract,
    )
    if not _idempotency_reservation_matches(
        fresh, cmd.kind, cmd.idempotency_key, contract
    ):
        raise GenerationIdempotencyConflict(
            "같은 생성 요청 키가 다른 payload에 이미 사용되었습니다"
        )
    gen_id = fresh["gen_id"]
    if fresh.get("status") != "preparing":
        generation = await _sync_io(repo.get_generation, gen_id)
        if generation:
            return generation
        raise GenerationIdempotencyConflict(
            "기존 생성 요청의 placeholder를 찾을 수 없습니다"
        )
    if not await _sync_io(
        repo.idempotent_placeholder_is_resumable,
        cmd.email,
        cmd.creator_uid,
        cmd.idempotency_key,
        gen_id,
        cmd.kind,
        cmd.source_gen_id,
    ):
        raise GenerationIdempotencyConflict(
            "같은 생성 요청 키의 placeholder를 안전하게 이어갈 수 없습니다"
        )
    return None


@_account_scoped("email")
def repair_canvas_generation_links(
    email: str,
    creator_uid: str | None,
    links: list[dict[str, str]],
) -> list[dict]:
    """generation만 저장되고 요청행이 빠진 종료 지점을 안전하게 다시 큐잉한다."""
    repaired = False
    for link in links:
        if repo.get_canvas_generation_link(email, link["attempt_id"]):
            continue
        payload = repo.gen_recipe(link["generation_id"])
        if not payload:
            continue
        # RL-04 fail-closed 는 repair 재큐잉에도 적용한다 — unknown 워크스페이스 payload 를
        # pending 에 넣으면 신 에이전트는 거부하지만 구 에이전트가 이것만 골라(claim 게이트가
        # team/personal 을 제외하므로) 현재 CLI 공간으로 실행해 오귀속 과금이 재현된다.
        # 유령 placeholder 로 남기지 않게 명확한 실패로 종결한다(재생성은 사용자가 명시로).
        if (payload.get("workspace") or {}).get("scope") not in ("team", "personal"):
            repo.set_status(
                link["generation_id"],
                "failed",
                error="워크스페이스를 확정할 수 없어 자동 복구를 중단했습니다 — 다시 생성해 주세요",
            )
            continue
        payload["source_gen_id"] = None
        if repo.repair_orphaned_canvas_generation(email, creator_uid, link, payload):
            repaired = True
    if repaired:
        agent_signals.signal(email, "gen-request")
    return repo.resolve_canvas_generation_links(
        email, [link["attempt_id"] for link in links]
    )


@_account_scoped("email")
async def claim_gen_requests(
    email: str,
    account_uid: str | None,
    limit: int,
    *,
    workspace_capable: bool = False,
    lease_owner: str | None = None,
    submission_stage_capable: bool = False,
) -> list[dict]:
    """에이전트의 빈 슬롯만큼 대기 요청을 claim하고 카드 상태·알림을 함께 갱신한다."""
    agent_signals.touch(email)
    expired = await _sync_io(repo.sweep_expired_generation_claims, email)
    for transition in expired:
        gen_id = transition["gen_id"]
        log_event(
            _generation_log,
            "generation_claim_expired",
            level=(logging.WARNING if transition["action"] == "quarantined" else logging.INFO),
            generation_id=gen_id,
            request_id=transition["id"],
            from_phase=transition["from_phase"],
            to_phase=transition["to_phase"],
            recovery_action=transition["action"],
        )
        await _sync_io(
            journal_generation_event,
            "generation_claim_expired",
            gen_id,
            request_id=transition["id"],
            from_phase=transition["from_phase"],
            to_phase=transition["to_phase"],
            actor_uid=account_uid,
            details={"action": transition["action"]},
        )
    if any(item["action"] == "requeued" for item in expired):
        agent_signals.signal(email, "gen-request")
    if expired:
        # execution_phase와 error까지 새로 받아야 하므로 status 한 필드만 바꾸는 progress 대신
        # 계정 범위 전체 재조회 신호를 보낸다.
        await manager.broadcast({"type": "synced"}, account_uid=account_uid)
    claimed = await _sync_io(
        repo.claim_pending_requests,
        email,
        limit=max(1, min(limit, 16)),
        workspace_capable=workspace_capable,
        lease_owner=lease_owner,
        submission_stage_capable=submission_stage_capable,
        sweep_expired=False,
    )
    claimed_needs_refresh = False
    for item in claimed:
        gen_id = item["gen_id"]
        claim_phase = item.get("claim_phase") or "submitting"
        if claim_phase == "submitting":
            await _sync_io(repo.set_status, gen_id, "running", None)
        log_event(
            _generation_log,
            "generation_claimed",
            generation_id=gen_id,
            request_id=item["id"],
            kind=item.get("kind"),
            model=item.get("model"),
            workspace_scope=(item.get("workspace") or {}).get("scope"),
            claim_phase=claim_phase,
        )
        await _sync_io(
            journal_generation_event,
            "generation_claimed",
            gen_id,
            request_id=item["id"],
            from_phase="pending",
            to_phase=claim_phase,
            actor_uid=account_uid,
        )
        if claim_phase == "submitting":
            await _sync_io(
                pm_best_effort,
                lambda manage, gid=gen_id: manage.record_started(gid),
                operation="record_started",
                dirty_gen_id=gen_id,
            )
            await manager.broadcast(
                {"type": "progress", "generation_id": gen_id, "status": "running"},
                account_uid=account_uid,
            )
        else:
            claimed_needs_refresh = True
    if claimed_needs_refresh:
        await manager.broadcast({"type": "synced"}, account_uid=account_uid)
    return claimed


@_account_scoped("email")
async def begin_submission(
    email: str,
    account_uid: str | None,
    request_id: str,
    lease_owner: str,
    submission_fingerprint: dict | None = None,
) -> bool:
    """신 에이전트가 실제 CLI 생성 호출 직전에 claimed를 submitting으로 올린다."""
    result = await _sync_io(
        repo.begin_request_submission,
        request_id,
        email,
        lease_owner,
        submission_fingerprint,
    )
    if not result:
        return False
    if not result["transitioned"]:
        return True
    gen_id = result["gen_id"]
    log_event(
        _generation_log,
        "generation_submission_started",
        generation_id=gen_id,
        request_id=request_id,
    )
    await _sync_io(
        journal_generation_event,
        "generation_submission_started",
        gen_id,
        request_id=request_id,
        from_phase="claimed",
        to_phase="submitting",
        actor_uid=account_uid,
    )
    await _sync_io(
        pm_best_effort,
        lambda manage, gid=gen_id: manage.record_started(gid),
        operation="record_started",
        dirty_gen_id=gen_id,
    )
    await manager.broadcast(
        {"type": "progress", "generation_id": gen_id, "status": "running"},
        account_uid=account_uid,
    )
    return True


@_account_scoped("email")
async def release_claim(
    email: str,
    account_uid: str | None,
    request_id: str,
    lease_owner: str,
) -> bool:
    """서버 제출 허가를 받기 전에 멈춘 claim을 즉시 안전하게 반환한다."""
    gen_id = await _sync_io(
        repo.release_claimed_request,
        request_id,
        email,
        lease_owner,
    )
    if not gen_id:
        return False
    log_event(
        _generation_log,
        "generation_claim_released",
        generation_id=gen_id,
        request_id=request_id,
    )
    agent_signals.signal(email, "gen-request")
    await manager.broadcast({"type": "synced"}, account_uid=account_uid)
    return True


@_account_scoped("email")
async def require_submission_recovery(
    email: str,
    account_uid: str | None,
    request_id: str,
) -> bool:
    """CLI 호출 결말이 불명확한 요청을 새 과금이 일어나지 않는 보류 상태로 격리한다."""
    result = await _sync_io(repo.mark_request_recovery_required, request_id, email)
    if not result:
        return False
    if not result["transitioned"]:
        return True
    gen_id = result["gen_id"]
    log_event(
        _generation_log,
        "generation_recovery_required",
        level=logging.WARNING,
        generation_id=gen_id,
        request_id=request_id,
        reason_code="job_id_unavailable_after_submit",
    )
    await _sync_io(
        journal_generation_event,
        "generation_recovery_required",
        gen_id,
        request_id=request_id,
        to_phase="recovery_required",
        actor_uid=account_uid,
        details={"reason_code": "job_id_unavailable_after_submit"},
    )
    await manager.broadcast({"type": "synced"}, account_uid=account_uid)
    return True


@_account_scoped("email")
async def confirm_not_submitted_and_requeue(
    email: str,
    account_uid: str | None,
    request_id: str,
) -> bool:
    """사용자가 외부 작업 부재를 확인한 경우에만 recovery_required를 pending으로 되돌린다."""
    decision = await _sync_io(repo.prepare_recovery_requeue, request_id, email)
    if decision.get("status") == "probe_required":
        # 사용자의 첫 클릭이 곧 에이전트를 깨워 최신 list를 다시 읽게 한다. create 호출은 없으며,
        # 결과가 기록되기 전에는 재큐하지 않아 오클릭 이중 과금 창을 닫는다.
        agent_signals.signal(email, "recovery-probe")
        raise RecoveryRequeueBlocked(
            "자동 제출 조사를 요청했습니다. 잠시 후 다시 시도해 주세요."
        )
    if decision.get("status") == "candidate_found":
        raise RecoveryRequeueBlocked(
            "자동 조사에서 기존 Higgsfield 생성 후보를 찾았습니다. 재실행하지 않고 자동 연결을 기다립니다."
        )
    if decision.get("status") != "requeued":
        return False
    gen_id = decision["gen_id"]
    log_event(
        _generation_log,
        "generation_recovery_requeued",
        level=logging.WARNING,
        generation_id=gen_id,
        request_id=request_id,
        confirmation="external_job_absent",
    )
    await _sync_io(
        journal_generation_event,
        "generation_recovery_requeued",
        gen_id,
        request_id=request_id,
        from_phase="recovery_required",
        to_phase="pending",
        actor_uid=account_uid,
        details={"confirmation": "external_job_absent"},
    )
    agent_signals.signal(email, "gen-request")
    await manager.broadcast({"type": "synced"}, account_uid=account_uid)
    return True


@_account_scoped("email")
async def confirm_generation_not_submitted_and_requeue(
    email: str,
    account_uid: str | None,
    gen_id: str,
) -> bool:
    """화면 generation id를 자기 복구 요청으로 해석한 뒤 기존 명시 재큐잉 계약을 사용한다."""
    request_id = await _sync_io(
        repo.get_recovery_request_id_for_generation,
        gen_id,
        email,
    )
    if not request_id:
        return False
    return await confirm_not_submitted_and_requeue(
        email,
        account_uid,
        request_id,
    )


@_account_scoped("request_row", from_request_row=True)
async def fulfill_request(
    request_row: dict,
    request_id: str,
    job: dict,
    account_uid: str | None,
) -> dict | None:
    """완료 잡을 placeholder에 원자 적용하고, 실제로 적용된 경우에만 완료 알림을 보낸다."""
    gen_id = request_row["gen_id"]
    result = normalize_job_result(cli_bridge.parse_job(job))
    if result.status == "done" and not _has_usable_asset_path(result.asset_path):
        await _sync_io(
            repo.record_request_check,
            request_id,
            str(job.get("status") or job.get("job_status") or ""),
            phase="verifying",
            error=repo.VERIFYING_NOTE,
            next_seconds=15,
        )
        await _sync_io(repo.set_status, gen_id, "running", repo.VERIFYING_NOTE)
        if request_row.get("status") != "verifying":
            log_event(
                _generation_log,
                "generation_result_waiting",
                level=logging.WARNING,
                generation_id=gen_id,
                request_id=request_id,
                provider_status=str(job.get("status") or job.get("job_status") or ""),
                reason="result_location_missing",
            )
            await _sync_io(
                journal_generation_event,
                "generation_result_waiting",
                gen_id,
                request_id=request_id,
                from_phase=request_row.get("status"),
                to_phase="verifying",
                provider_status=str(job.get("status") or job.get("job_status") or ""),
                reason_code="result_location_missing",
                actor_uid=account_uid,
            )
        return await _sync_io(repo.get_generation, gen_id)
    applied = await _sync_io(
        repo.apply_local_fulfillment,
        gen_id,
        request_id,
        asset_type=result.asset_type,
        asset_path=result.asset_path,
        asset_thumb=result.asset_thumb,
        job_id=result.job_id,
        created_at=result.created_at,
        sort_ts=result.sort_ts,
        status=result.status,
        error=result.error,
        request_status="done" if result.status == "done" else "failed",
    )
    if not applied:
        return await _sync_io(repo.get_generation, gen_id)

    log_event(
        _generation_log,
        "generation_finalized",
        level=logging.ERROR if result.status == "failed" else logging.INFO,
        generation_id=gen_id,
        request_id=request_id,
        job_id=result.job_id,
        status=result.status,
        asset_saved=bool(result.asset_path),
    )
    await _sync_io(
        journal_generation_event,
        "generation_finalized",
        gen_id,
        request_id=request_id,
        job_id=result.job_id,
        from_phase=request_row.get("status"),
        to_phase=result.status,
        actor_uid=account_uid,
    )
    await _sync_io(
        pm_best_effort,
        lambda manage: manage.record_completed(gen_id, job_id=result.job_id),
        operation="record_completed",
        dirty_gen_id=gen_id,
    )
    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": gen_id,
            "status": result.status,
            "result_url": result.asset_path,
            "error": result.error,
        },
        account_uid=account_uid,
    )
    return await _sync_io(repo.get_generation, gen_id)


@_account_scoped("request_row", from_request_row=True)
async def anchor_request(
    request_row: dict,
    request_id: str,
    job_id: str,
    verifying: bool,
    account_uid: str | None,
) -> bool:
    """job_id를 placeholder에 앵커하고, 실제 변경된 경우에만 진행 상태를 알린다."""
    gen_id = request_row["gen_id"]
    applied = await _sync_io(
        repo.apply_local_anchor, gen_id, request_id, job_id, verifying=verifying
    )
    if applied:
        log_event(
            _generation_log,
            "generation_job_anchored",
            generation_id=gen_id,
            request_id=request_id,
            job_id=job_id,
            verifying=verifying,
        )
        await _sync_io(
            journal_generation_event,
            "generation_job_anchored",
            gen_id,
            request_id=request_id,
            job_id=job_id,
            from_phase=request_row.get("status"),
            to_phase="verifying" if verifying else "tracking",
            actor_uid=account_uid,
        )
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": gen_id,
                "status": "running",
                "error": repo.VERIFYING_NOTE if verifying else None,
            },
            account_uid=account_uid,
        )
    return applied


@_account_scoped("request_row", from_request_row=True)
async def reconcile_request(
    request_row: dict,
    job: dict,
    force_fail_reason: str | None,
    account_uid: str | None,
) -> dict:
    """에이전트가 재조회한 권위 상태를 로컬 placeholder에 보정한다."""
    gen_id = request_row["gen_id"]
    raw_provider_status = str(job.get("status") or job.get("job_status") or "").strip().lower()
    provider_kind = cli_bridge.provider_status_kind(raw_provider_status)
    parsed = cli_bridge.parse_job(job)
    parsed_job_id = (parsed.get("generation") or {}).get("id")
    if force_fail_reason:
        job_id = (parsed.get("generation") or {}).get("id")
        applied = await _sync_io(
            repo.apply_reconcile,
            gen_id,
            job_id,
            asset_type=None,
            asset_path=None,
            asset_thumb=None,
            created_at=None,
            sort_ts=None,
            status="failed",
            error=force_fail_reason,
            force_fail_reason=force_fail_reason,
            provider_status=raw_provider_status,
        )
        if applied:
            log_event(
                _generation_log,
                "generation_finalized",
                level=logging.ERROR,
                generation_id=gen_id,
                request_id=request_row.get("id"),
                job_id=job_id,
                status="failed",
                provider_status=raw_provider_status,
                asset_saved=False,
                reason="forced_failure",
            )
            await _sync_io(
                journal_generation_event,
                "generation_finalized",
                gen_id,
                request_id=request_row.get("id"),
                job_id=job_id,
                from_phase=request_row.get("status"),
                to_phase="failed",
                provider_status=raw_provider_status,
                reason_code="forced_failure",
                actor_uid=account_uid,
            )
            await _sync_io(
                pm_best_effort,
                lambda manage: manage.record_completed(gen_id, job_id=job_id),
                operation="record_completed",
                dirty_gen_id=gen_id,
            )
            await manager.broadcast(
                {
                    "type": "progress",
                    "generation_id": gen_id,
                    "status": "failed",
                    "error": force_fail_reason,
                },
                account_uid=account_uid,
            )
        # ★미적용 사유 구분: 예전엔 무조건 already_final_same_job(성공형)을 돌려줘, 앵커가
        #  유실돼 아무것도 못 바꾼 경우까지 에이전트가 성공으로 보고 추적을 끝냈다 —
        #  레퍼런스 미부착(이미 과금) 잡이 서버엔 '생성중'으로 영영 남는 유령 카드.
        #  비-force 경로의 final_matches 판정과 대칭으로, 실제 같은 잡으로 종결된 경우만
        #  성공형을 준다. 그 외(앵커 유실 등)는 rejected → 에이전트가 다음 사이클에 재시도.
        if applied:
            outcome = "applied"
        else:
            current_row = await _sync_io(repo.get_generation, gen_id)
            same_final = (
                (current_row or {}).get("status") in ("done", "failed")
                and (current_row or {}).get("job_id") == job_id
            )
            outcome = "already_final_same_job" if same_final else "rejected"
        return {
            "ok": True,
            "applied": applied,
            "outcome": outcome,
            "status": "failed",
            "job_id": job_id,
            "asset_saved": False,
        }

    current = await _sync_io(repo.get_generation, gen_id)
    expected_job_id = (current or {}).get("job_id")

    if expected_job_id and parsed_job_id and expected_job_id != parsed_job_id:
        log_event(
            _generation_log,
            "generation_job_conflict",
            level=logging.WARNING,
            generation_id=gen_id,
            request_id=request_row.get("id"),
            expected_job_id=expected_job_id,
            received_job_id=parsed_job_id,
        )
        await _sync_io(
            journal_generation_event,
            "generation_job_conflict",
            gen_id,
            request_id=request_row.get("id"),
            job_id=expected_job_id,
            from_phase=request_row.get("status"),
            to_phase=request_row.get("status"),
            reason_code="job_id_mismatch",
            actor_uid=account_uid,
        )
        return {
            "ok": True,
            "applied": False,
            "outcome": "conflict",
            "status": (current or {}).get("status"),
            "job_id": expected_job_id,
            "asset_saved": bool((current or {}).get("assets")),
        }

    result = normalize_job_result(parsed)
    if provider_kind in ("processing", "unknown", "action_required"):
        phase = "tracking" if provider_kind == "processing" else (
            "blocked" if provider_kind == "action_required" else "verifying"
        )
        note = None
        if provider_kind == "unknown":
            note = f"{repo.VERIFYING_NOTE} (알 수 없는 상태: {raw_provider_status or '없음'})"
        elif provider_kind == "action_required":
            note = f"조치 필요 — Higgsfield 상태: {raw_provider_status}"
        await _sync_io(
            repo.record_request_check,
            request_row["id"],
            raw_provider_status,
            phase=phase,
            error=note,
            next_seconds=30,
        )
        await _sync_io(repo.set_status, gen_id, "running", note)
        if (
            provider_kind in ("unknown", "action_required")
            and (
                request_row.get("status") != phase
                or request_row.get("provider_status") != raw_provider_status
            )
        ):
            log_event(
                _generation_log,
                "generation_attention_required",
                level=logging.WARNING,
                generation_id=gen_id,
                request_id=request_row.get("id"),
                job_id=parsed_job_id,
                phase=phase,
                provider_status=raw_provider_status or "missing",
                reason=provider_kind,
            )
            await _sync_io(
                journal_generation_event,
                "generation_attention_required",
                gen_id,
                request_id=request_row.get("id"),
                job_id=parsed_job_id,
                from_phase=request_row.get("status"),
                to_phase=phase,
                provider_status=raw_provider_status,
                reason_code=provider_kind,
                actor_uid=account_uid,
            )
        if note:
            await manager.broadcast(
                {
                    "type": "progress",
                    "generation_id": gen_id,
                    "status": "running",
                    "error": note,
                },
                account_uid=account_uid,
            )
        return {
            "ok": True,
            "applied": False,
            "outcome": "not_ready",
            "status": "running",
            "job_id": parsed_job_id,
            "asset_saved": False,
        }

    # 공급자가 완료를 먼저 알리고 CDN 결과 URL을 나중에 붙이는 경우가 있다. 빈 완료로 닫지 않는다.
    if provider_kind == "success" and not _has_usable_asset_path(result.asset_path):
        await _sync_io(
            repo.record_request_check,
            request_row["id"],
            raw_provider_status,
            phase="verifying",
            error=repo.VERIFYING_NOTE,
            next_seconds=15,
        )
        await _sync_io(repo.set_status, gen_id, "running", repo.VERIFYING_NOTE)
        if (
            request_row.get("status") != "verifying"
            or request_row.get("provider_status") != raw_provider_status
        ):
            log_event(
                _generation_log,
                "generation_result_waiting",
                level=logging.WARNING,
                generation_id=gen_id,
                request_id=request_row.get("id"),
                job_id=result.job_id,
                provider_status=raw_provider_status,
                reason="result_location_missing",
            )
            await _sync_io(
                journal_generation_event,
                "generation_result_waiting",
                gen_id,
                request_id=request_row.get("id"),
                job_id=result.job_id,
                from_phase=request_row.get("status"),
                to_phase="verifying",
                provider_status=raw_provider_status,
                reason_code="result_location_missing",
                actor_uid=account_uid,
            )
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": gen_id,
                "status": "running",
                "error": repo.VERIFYING_NOTE,
            },
            account_uid=account_uid,
        )
        return {
            "ok": True,
            "applied": False,
            "outcome": "not_ready",
            "status": "running",
            "job_id": result.job_id,
            "asset_saved": False,
        }

    applied = await _sync_io(
        repo.apply_reconcile,
        gen_id,
        result.job_id,
        asset_type=result.asset_type,
        asset_path=result.asset_path,
        asset_thumb=result.asset_thumb,
        created_at=result.created_at,
        sort_ts=result.sort_ts,
        status=result.status,
        error=result.error,
        provider_status=raw_provider_status,
    )
    if applied:
        log_event(
            _generation_log,
            "generation_finalized",
            level=logging.ERROR if result.status == "failed" else logging.INFO,
            generation_id=gen_id,
            request_id=request_row.get("id"),
            job_id=result.job_id,
            status=result.status,
            provider_status=raw_provider_status,
            asset_saved=bool(result.asset_path),
        )
        await _sync_io(
            journal_generation_event,
            "generation_finalized",
            gen_id,
            request_id=request_row.get("id"),
            job_id=result.job_id,
            from_phase=request_row.get("status"),
            to_phase=result.status,
            provider_status=raw_provider_status,
            actor_uid=account_uid,
        )
        await _sync_io(
            pm_best_effort,
            lambda manage: manage.record_completed(gen_id, job_id=result.job_id),
            operation="record_completed",
            dirty_gen_id=gen_id,
        )
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": gen_id,
                "status": result.status,
                "result_url": result.asset_path if result.status != "failed" else None,
                "error": result.error,
            },
            account_uid=account_uid,
        )
    final = await _sync_io(repo.get_generation, gen_id)
    asset_saved = bool((final or {}).get("assets"))
    same_job = bool(final and final.get("job_id") == result.job_id)
    final_matches = bool(
        same_job
        and final.get("status") == result.status
        and (result.status != "done" or asset_saved)
    )
    outcome = "applied" if applied else ("already_final_same_job" if final_matches else "rejected")
    return {
        "ok": True,
        "applied": applied,
        "outcome": outcome,
        "status": result.status,
        "job_id": result.job_id,
        "asset_saved": asset_saved,
    }


def _failure_anchor_from_reason(reason: str) -> tuple[str | None, str | None]:
    """구버전 에이전트의 실패 문자열에서 (job_id, 종료 상태)를 복구한다."""
    match = _HF_ENDED_RE.search(reason or "")
    if not match:
        return None, None
    status = cli_bridge.normalize_status(match.group(2).strip().replace(" ", "_"))
    if status in ACTIVE_STATUSES:
        status = "failed"
    return match.group(1), status


@_account_scoped("request_row", from_request_row=True)
async def fail_request(
    request_row: dict,
    request_id: str,
    reason: str,
    job_id: str | None,
    hf_status: str | None,
    account_uid: str | None,
) -> bool:
    """실패를 원자 적용하고, CAS가 성공한 경우에만 완료 기록과 알림을 남긴다."""
    parsed_job_id, parsed_status = _failure_anchor_from_reason(reason)
    final_job_id = job_id or parsed_job_id
    final_status = cli_bridge.normalize_status(hf_status) if hf_status else (parsed_status or "failed")
    if final_status in ACTIVE_STATUSES:
        final_status = "failed"

    # 혼합 업데이트 안전망: 구 에이전트는 create 호출 뒤 job_id를 얻지 못하면 새 전용 복구 API
    # 대신 /fail에 아래 문구를 보낸다. 이 요청을 failed로 닫으면 사용자가 일반 재생성으로 같은
    # 유료 작업을 다시 만들 수 있다. 실제 job_id가 없고 제출 이후일 수 있는 경우만 보수적으로
    # recovery_required에 격리한다. claimed 단계의 입력·업로드 검증 실패는 기존 failed를 유지한다.
    ambiguous_legacy_failure = (
        request_row.get("status") == "submitting"
        and not final_job_id
        and (reason or "").startswith(("제출 실패", "제출 처리 예외"))
    )
    if ambiguous_legacy_failure:
        return await require_submission_recovery(
            request_row.get("account_email") or "",
            account_uid,
            request_id,
        )

    gen_id = request_row["gen_id"]
    applied = await _sync_io(
        repo.apply_local_failure,
        gen_id,
        request_id,
        reason,
        job_id=final_job_id,
        status=final_status,
    )
    if not applied:
        return False

    log_event(
        _generation_log,
        "generation_finalized",
        level=logging.ERROR,
        generation_id=gen_id,
        request_id=request_id,
        job_id=final_job_id,
        status=final_status,
        asset_saved=False,
        reason="agent_reported_failure",
    )
    await _sync_io(
        journal_generation_event,
        "generation_finalized",
        gen_id,
        request_id=request_id,
        job_id=final_job_id,
        from_phase=request_row.get("status"),
        to_phase=final_status,
        reason_code="agent_reported_failure",
        actor_uid=account_uid,
    )
    await _sync_io(
        pm_best_effort,
        lambda manage: manage.record_completed(gen_id, job_id=final_job_id),
        operation="record_completed",
        dirty_gen_id=gen_id,
    )
    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": gen_id,
            "status": final_status,
            "error": reason,
        },
        account_uid=account_uid,
    )
    return True


@_account_scoped("cmd")
async def submit_gen_request(cmd: GenRequestCommand) -> dict | None:
    """placeholder 생성 + 요청 큐잉 + 에이전트 깨우기 + PM 견적. placeholder gen 반환(없으면 None).

    생성 연결에 필요한 저장과 signal까지 마친 뒤 즉시 응답한다. PM 견적은 백그라운드에서 기록한다.
    """
    canvas_contract = _canvas_command_contract(cmd) if cmd.canvas_link else None
    idempotency_contract = (
        _idempotency_command_contract(cmd)
        if cmd.idempotency_key and not cmd.canvas_link
        else None
    )
    reservation: dict | None = None
    if cmd.canvas_link:
        reservation = await _sync_io(
            repo.reserve_canvas_gen_request,
            cmd.email,
            cmd.creator_uid,
            cmd.canvas_link["generation_id"],
            cmd.kind,
            cmd.canvas_link,
            canvas_contract,
        )
        if not _reservation_matches(
            reservation, cmd.canvas_link, cmd.kind, canvas_contract
        ):
            if reservation.get("created"):
                await _sync_io(
                    repo.delete_canvas_gen_request_reservation,
                    cmd.email,
                    cmd.canvas_link["attempt_id"],
                    cmd.canvas_link["generation_id"],
                )
            raise CanvasGenerationConflict(
                "같은 캔버스 생성 시도 ID가 다른 카드 또는 생성 명령에 이미 사용되었습니다"
            )
        if reservation.get("status") != "preparing":
            existing_gen = await _sync_io(
                repo.get_generation, cmd.canvas_link["generation_id"]
            )
            if not existing_gen:
                raise CanvasGenerationConflict(
                    "기존 캔버스 생성 요청의 placeholder를 찾을 수 없습니다"
                )
            return existing_gen
    elif cmd.idempotency_key:
        reservation = await _sync_io(
            repo.reserve_idempotent_gen_request,
            cmd.email,
            cmd.creator_uid,
            cmd.kind,
            cmd.idempotency_key,
            idempotency_contract,
        )
        if not _idempotency_reservation_matches(
            reservation, cmd.kind, cmd.idempotency_key, idempotency_contract
        ):
            raise GenerationIdempotencyConflict(
                "같은 생성 요청 키가 다른 payload에 이미 사용되었습니다"
            )
        if reservation.get("status") != "preparing":
            existing_gen = await _sync_io(
                repo.get_generation, reservation["gen_id"]
            )
            if not existing_gen:
                raise GenerationIdempotencyConflict(
                    "기존 생성 요청의 placeholder를 찾을 수 없습니다"
                )
            return existing_gen

    gen_id = (
        cmd.canvas_link["generation_id"]
        if cmd.canvas_link
        else reservation["gen_id"] if reservation else ""
    )
    existing_placeholder = bool(
        reservation and await _sync_io(repo.get_generation, gen_id)
    )
    try:
        if existing_placeholder:
            if cmd.canvas_link:
                resumable = await _sync_io(
                    repo.canvas_placeholder_is_resumable,
                    cmd.email,
                    cmd.creator_uid,
                    cmd.canvas_link,
                    cmd.kind,
                    cmd.source_gen_id,
                )
            else:
                resumable = await _sync_io(
                    repo.idempotent_placeholder_is_resumable,
                    cmd.email,
                    cmd.creator_uid,
                    cmd.idempotency_key,
                    gen_id,
                    cmd.kind,
                    cmd.source_gen_id,
                )
            if not resumable:
                conflict_type = (
                    CanvasGenerationConflict
                    if cmd.canvas_link
                    else GenerationIdempotencyConflict
                )
                raise conflict_type(
                    "같은 생성 ID가 다른 요청에 사용 중이라 안전하게 이어갈 수 없습니다"
                )
        elif cmd.kind == "create":
            create_kwargs = {"creator_uid": cmd.creator_uid}
            if cmd.workspace is not None:
                create_kwargs["workspace"] = cmd.workspace
            if reservation:
                create_kwargs["generation_id"] = gen_id
            try:
                gen_id = await _sync_io(
                    repo.create_local_generation, cmd.data, cmd.worker_id, **create_kwargs
                )
            except sqlite3.IntegrityError:
                # 다른 동시 재시도가 같은 placeholder를 먼저 저장했는지 권위 DB로 재확인한다.
                if not reservation:
                    raise
                completed = (
                    await _resolve_canvas_placeholder_collision(cmd, canvas_contract)
                    if cmd.canvas_link
                    else await _resolve_idempotent_placeholder_collision(
                        cmd, idempotency_contract
                    )
                )
                if completed:
                    return completed
                gen_id = reservation["gen_id"]
        else:  # regenerate
            import_kwargs = {"creator_uid": cmd.creator_uid}
            if cmd.workspace is not None:
                import_kwargs["workspace"] = cmd.workspace
            if reservation:
                import_kwargs["generation_id"] = gen_id
            try:
                gen_id = await _sync_io(
                    repo.import_generation, cmd.source_gen_id, cmd.worker_id, **import_kwargs
                )
            except sqlite3.IntegrityError:
                if not reservation:
                    raise
                completed = (
                    await _resolve_canvas_placeholder_collision(cmd, canvas_contract)
                    if cmd.canvas_link
                    else await _resolve_idempotent_placeholder_collision(
                        cmd, idempotency_contract
                    )
                )
                if completed:
                    return completed
                gen_id = reservation["gen_id"]

        # regenerate의 후처리는 멱등이라, import 직후 종료된 재시도에서도 그대로 다시 적용한다.
        if cmd.kind == "regenerate":
            reg = cmd.regenerate or RegenerateIn()
            if reg.color is not None:
                await _sync_io(repo.set_color, gen_id, reg.color)
            if reg.prompt or reg.model:
                await _sync_io(
                    repo.override_prompt_model, gen_id, prompt=reg.prompt, model=reg.model
                )
            if reg.auto_tags:
                await _sync_io(repo.add_auto_tags, gen_id, reg.auto_tags)

        payload = await _sync_io(repo.gen_recipe, gen_id)
        if not payload:
            raise RuntimeError("placeholder 레시피를 만들 수 없습니다")
        if (
            cmd.kind == "create"
            and existing_placeholder
            and payload != _expected_create_recipe(cmd)
        ):
            conflict_type = (
                CanvasGenerationConflict
                if cmd.canvas_link
                else GenerationIdempotencyConflict
            )
            raise conflict_type(
                "기존 placeholder 내용이 재시도한 생성 명령과 달라 자동 연결을 중단했습니다"
            )
        payload["source_gen_id"] = cmd.source_gen_id

        if cmd.canvas_link:
            activation = await _sync_io(
                repo.activate_canvas_gen_request,
                cmd.email,
                cmd.canvas_link["attempt_id"],
                gen_id,
                payload,
                canvas_contract,
            )
            if not activation:
                raise CanvasGenerationConflict(
                    "캔버스 생성 예약이 다른 요청으로 바뀌어 활성화를 중단했습니다"
                )
            request_id = activation["id"]
            if not activation["activated"]:
                return await _sync_io(repo.get_generation, gen_id)
        elif cmd.idempotency_key:
            activation = await _sync_io(
                repo.activate_idempotent_gen_request,
                cmd.email,
                cmd.idempotency_key,
                gen_id,
                payload,
                idempotency_contract,
            )
            if not activation:
                raise GenerationIdempotencyConflict(
                    "생성 요청 예약이 다른 요청으로 바뀌어 활성화를 중단했습니다"
                )
            request_id = activation["id"]
            if not activation["activated"]:
                return await _sync_io(repo.get_generation, gen_id)
        else:
            request_id = await _sync_io(
                repo.create_gen_request,
                cmd.email,
                cmd.creator_uid,
                gen_id,
                cmd.kind,
                payload,
                canvas_link=None,
            )
    except CanvasGenerationConflict:
        if cmd.canvas_link and reservation and reservation.get("created"):
            await _sync_io(
                repo.delete_canvas_gen_request_reservation,
                cmd.email,
                cmd.canvas_link["attempt_id"],
                cmd.canvas_link["generation_id"],
            )
        raise
    log_event(
        _generation_log,
        "generation_requested",
        generation_id=gen_id,
        request_id=request_id,
        kind=cmd.kind,
        model=payload.get("model"),
        workspace_scope=(payload.get("workspace") or {}).get("scope"),
        reference_count=len(payload.get("references") or []),
    )
    await _sync_io(
        journal_generation_event,
        "generation_requested",
        gen_id,
        request_id=request_id,
        to_phase="pending",
        actor_uid=cmd.creator_uid,
    )
    # 요청자 에이전트를 즉시 깨움(이벤트 방식) — 30초 폴링 대기 없이 바로 실행.
    agent_signals.signal(cmd.email, "gen-request")

    # pending 상태도 중앙 운영 로그에 즉시 보이게, 느린 견적 조회 전에 기본 요청 시점을 기록한다.
    if MANAGE_ENABLED:
        await _sync_io(
            pm_best_effort,
            lambda manage: manage.record_request(gen_id),
            operation="record_request",
            dirty_gen_id=gen_id,
        )

    # 요청 시점 견적은 부가 통계다. 느린 CLI 응답 때문에 브라우저가 닫히기 전 generation id를
    # 못 받는 일이 없도록 응답 경로에서 분리한다.
    _schedule_request_estimate(gen_id, cmd.email, payload)

    return await _sync_io(repo.get_generation, gen_id)
