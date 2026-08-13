"""gen-request 업무 흐름(usecase).

라우터가 인증·권한·입력검증을 끝낸 값만 받아, placeholder 생성·큐잉부터 claim,
완료/실패/재조정 저장, PM 기록, 계정 범위 알림까지의 오케스트레이션을 수행한다. FastAPI 미의존.
(ARCHITECTURE.md: routers -> usecases -> repo/services)
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass

from .. import repo
from ..config import MANAGE_ENABLED
from ..generation_result import ACTIVE_STATUSES, normalize_job_result
from ..models import RegenerateIn
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..services.event_journal import journal_generation_event
from ..services.operational_logging import log_event
from ..ws import manager


_generation_log = logging.getLogger("mvhub.generation")
_pm_failure_log_lock = threading.Lock()
_pm_last_failure_log_at = 0.0
_PM_FAILURE_LOG_INTERVAL = 300.0

_HF_ENDED_RE = re.compile(
    r"\bjob\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    r"\s+ended with status\s+['\"]?([A-Za-z_ -]+)['\"]?",
    re.IGNORECASE,
)


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


def pm_best_effort(action, *, operation: str = "record") -> None:
    """PM 메트릭 best-effort 실행(분리형). MANAGE_ENABLED off 거나 실패해도 생성 흐름·응답에
    영향 0 — 메트릭 수집은 절대 생성을 막지 않는다(PM_DASHBOARD_DESIGN.md §6-1).
    action 은 manage 모듈을 받는 콜러블."""
    if not MANAGE_ENABLED:
        return
    try:
        from ..repo import manage as _m

        action(_m)
    except Exception as exc:  # noqa: BLE001 — 메트릭 실패가 생성을 막지 않게
        _log_pm_failure(operation, exc)


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


async def claim_gen_requests(
    email: str,
    account_uid: str | None,
    limit: int,
    *,
    workspace_capable: bool = False,
    lease_owner: str | None = None,
) -> list[dict]:
    """에이전트의 빈 슬롯만큼 대기 요청을 claim하고 카드 상태·알림을 함께 갱신한다."""
    agent_signals.touch(email)
    claimed = repo.claim_pending_requests(
        email,
        limit=max(1, min(limit, 16)),
        workspace_capable=workspace_capable,
        lease_owner=lease_owner,
    )
    for item in claimed:
        gen_id = item["gen_id"]
        repo.set_status(gen_id, "running", None)
        log_event(
            _generation_log,
            "generation_claimed",
            generation_id=gen_id,
            request_id=item["id"],
            kind=item.get("kind"),
            model=item.get("model"),
            workspace_scope=(item.get("workspace") or {}).get("scope"),
        )
        journal_generation_event(
            "generation_claimed",
            gen_id,
            request_id=item["id"],
            from_phase="pending",
            to_phase="submitting",
            actor_uid=account_uid,
        )
        pm_best_effort(lambda manage, gid=gen_id: manage.record_started(gid))
        await manager.broadcast(
            {"type": "progress", "generation_id": gen_id, "status": "running"},
            account_uid=account_uid,
        )
    return claimed


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
        repo.record_request_check(
            request_id,
            str(job.get("status") or job.get("job_status") or ""),
            phase="verifying",
            error=repo.VERIFYING_NOTE,
            next_seconds=15,
        )
        repo.set_status(gen_id, "running", repo.VERIFYING_NOTE)
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
            journal_generation_event(
                "generation_result_waiting",
                gen_id,
                request_id=request_id,
                from_phase=request_row.get("status"),
                to_phase="verifying",
                provider_status=str(job.get("status") or job.get("job_status") or ""),
                reason_code="result_location_missing",
                actor_uid=account_uid,
            )
        return repo.get_generation(gen_id)
    applied = repo.apply_local_fulfillment(
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
        return repo.get_generation(gen_id)

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
    journal_generation_event(
        "generation_finalized",
        gen_id,
        request_id=request_id,
        job_id=result.job_id,
        from_phase=request_row.get("status"),
        to_phase=result.status,
        actor_uid=account_uid,
    )
    pm_best_effort(lambda manage: manage.record_completed(gen_id, job_id=result.job_id))
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
    return repo.get_generation(gen_id)


async def anchor_request(
    request_row: dict,
    request_id: str,
    job_id: str,
    verifying: bool,
    account_uid: str | None,
) -> bool:
    """job_id를 placeholder에 앵커하고, 실제 변경된 경우에만 진행 상태를 알린다."""
    gen_id = request_row["gen_id"]
    applied = repo.apply_local_anchor(gen_id, request_id, job_id, verifying=verifying)
    if applied:
        log_event(
            _generation_log,
            "generation_job_anchored",
            generation_id=gen_id,
            request_id=request_id,
            job_id=job_id,
            verifying=verifying,
        )
        journal_generation_event(
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
        applied = repo.apply_reconcile(
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
            journal_generation_event(
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
            pm_best_effort(lambda manage: manage.record_completed(gen_id, job_id=job_id))
            await manager.broadcast(
                {
                    "type": "progress",
                    "generation_id": gen_id,
                    "status": "failed",
                    "error": force_fail_reason,
                },
                account_uid=account_uid,
            )
        return {
            "ok": True,
            "applied": applied,
            "outcome": "applied" if applied else "already_final_same_job",
            "status": "failed",
            "job_id": job_id,
            "asset_saved": False,
        }

    current = repo.get_generation(gen_id)
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
        journal_generation_event(
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
        repo.record_request_check(
            request_row["id"],
            raw_provider_status,
            phase=phase,
            error=note,
            next_seconds=30,
        )
        repo.set_status(gen_id, "running", note)
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
            journal_generation_event(
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
        repo.record_request_check(
            request_row["id"],
            raw_provider_status,
            phase="verifying",
            error=repo.VERIFYING_NOTE,
            next_seconds=15,
        )
        repo.set_status(gen_id, "running", repo.VERIFYING_NOTE)
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
            journal_generation_event(
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

    applied = repo.apply_reconcile(
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
        journal_generation_event(
            "generation_finalized",
            gen_id,
            request_id=request_row.get("id"),
            job_id=result.job_id,
            from_phase=request_row.get("status"),
            to_phase=result.status,
            provider_status=raw_provider_status,
            actor_uid=account_uid,
        )
        pm_best_effort(lambda manage: manage.record_completed(gen_id, job_id=result.job_id))
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
    final = repo.get_generation(gen_id)
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

    gen_id = request_row["gen_id"]
    applied = repo.apply_local_failure(
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
    journal_generation_event(
        "generation_finalized",
        gen_id,
        request_id=request_id,
        job_id=final_job_id,
        from_phase=request_row.get("status"),
        to_phase=final_status,
        reason_code="agent_reported_failure",
        actor_uid=account_uid,
    )
    pm_best_effort(lambda manage: manage.record_completed(gen_id, job_id=final_job_id))
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


async def submit_gen_request(cmd: GenRequestCommand) -> dict | None:
    """placeholder 생성 + 요청 큐잉 + 에이전트 깨우기 + PM 견적. placeholder gen 반환(없으면 None).

    부수효과 순서는 원본과 동일하게 보존한다:
    create/import(+tweaks) -> gen_recipe -> create_gen_request -> agent signal -> PM 견적(await) -> get_generation.
    """
    if cmd.kind == "create":
        create_kwargs = {"creator_uid": cmd.creator_uid}
        if cmd.workspace is not None:
            create_kwargs["workspace"] = cmd.workspace
        gen_id = repo.create_local_generation(cmd.data, cmd.worker_id, **create_kwargs)
    else:  # regenerate
        import_kwargs = {"creator_uid": cmd.creator_uid}
        if cmd.workspace is not None:
            import_kwargs["workspace"] = cmd.workspace
        gen_id = repo.import_generation(cmd.source_gen_id, cmd.worker_id, **import_kwargs)
        reg = cmd.regenerate or RegenerateIn()
        if reg.color is not None:
            repo.set_color(gen_id, reg.color)
        if reg.prompt or reg.model:
            repo.override_prompt_model(gen_id, prompt=reg.prompt, model=reg.model)
        if reg.auto_tags:
            repo.add_auto_tags(gen_id, reg.auto_tags)

    payload = repo.gen_recipe(gen_id)
    payload["source_gen_id"] = cmd.source_gen_id
    request_id = repo.create_gen_request(cmd.email, cmd.creator_uid, gen_id, cmd.kind, payload)
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
    journal_generation_event(
        "generation_requested",
        gen_id,
        request_id=request_id,
        to_phase="pending",
        actor_uid=cmd.creator_uid,
    )
    # 요청자 에이전트를 즉시 깨움(이벤트 방식) — 30초 폴링 대기 없이 바로 실행.
    agent_signals.signal(cmd.email, "gen-request")

    # PM 메트릭: 요청 시점 견적 박제. 서버에 CLI 있을 때만 견적(없으면 NULL — 실제값은 후속 거래
    # 매칭으로 채움). 견적 0/실패는 미상(NULL)로 둔다(진짜 0 과 구분 불가).
    if MANAGE_ENABLED:
        est = None
        try:
            if cli_bridge.cli_available():
                cc = await cli_bridge.estimate_cost(
                    payload.get("model"), payload.get("params"), payload.get("prompt") or ""
                )
                v = (cc or {}).get("credits")
                est = int(v) if v else None
        except Exception as exc:  # noqa: BLE001 — 견적 실패가 생성을 막지 않게
            est = None
            _log_pm_failure("estimate_cost", exc)
        pm_best_effort(lambda _m: _m.record_request(gen_id, est_credits=est))

    return repo.get_generation(gen_id)
