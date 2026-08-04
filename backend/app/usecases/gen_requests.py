"""gen-request 업무 흐름(usecase).

라우터가 인증·권한·입력검증을 끝낸 값만 받아, placeholder 생성·큐잉부터 claim,
완료/실패/재조정 저장, PM 기록, 계정 범위 알림까지의 오케스트레이션을 수행한다. FastAPI 미의존.
(ARCHITECTURE.md: routers -> usecases -> repo/services)
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .. import repo
from ..config import MANAGE_ENABLED
from ..generation_result import ACTIVE_STATUSES, normalize_job_result
from ..models import RegenerateIn
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..ws import manager


_HF_ENDED_RE = re.compile(
    r"\bjob\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    r"\s+ended with status\s+['\"]?([A-Za-z_ -]+)['\"]?",
    re.IGNORECASE,
)


def pm_best_effort(action) -> None:
    """PM 메트릭 best-effort 실행(분리형). MANAGE_ENABLED off 거나 실패해도 생성 흐름·응답에
    영향 0 — 메트릭 수집은 절대 생성을 막지 않는다(PM_DASHBOARD_DESIGN.md §6-1).
    action 은 manage 모듈을 받는 콜러블."""
    if not MANAGE_ENABLED:
        return
    try:
        from ..repo import manage as _m

        action(_m)
    except Exception:  # noqa: BLE001 — 메트릭 실패가 생성을 막지 않게
        pass


@dataclass
class GenRequestCommand:
    """라우터가 인증·권한·입력검증을 끝내고 만든 '검증된 제출 명령'. usecase 는 이걸 실행만 한다.
    worker_id 는 라우터가 계산해서 담는다(regenerate 는 parent 기준 — usecase 가 다시 읽으면 동작이 달라짐)."""

    kind: str  # 'create' | 'regenerate'
    email: str
    creator_uid: str | None
    worker_id: str
    source_gen_id: str | None
    data: dict | None = None  # kind=create 의 정규화된 GenerationCreate dump
    regenerate: RegenerateIn | None = None  # kind=regenerate 옵션


async def claim_gen_requests(email: str, account_uid: str | None, limit: int) -> list[dict]:
    """에이전트의 빈 슬롯만큼 대기 요청을 claim하고 카드 상태·알림을 함께 갱신한다."""
    agent_signals.touch(email)
    claimed = repo.claim_pending_requests(email, limit=max(1, min(limit, 16)))
    for item in claimed:
        gen_id = item["gen_id"]
        repo.set_status(gen_id, "running", None)
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
    parsed = cli_bridge.parse_job(job)

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
        )
        if applied:
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
        return {"ok": True, "applied": applied, "status": "failed"}

    result = normalize_job_result(parsed)
    if result.status in ("pending", "running"):
        return {"ok": True, "applied": False, "status": result.status}

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
    )
    if applied:
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
    return {"ok": True, "applied": applied, "status": result.status}


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
        gen_id = repo.create_local_generation(cmd.data, cmd.worker_id, creator_uid=cmd.creator_uid)
    else:  # regenerate
        gen_id = repo.import_generation(cmd.source_gen_id, cmd.worker_id, creator_uid=cmd.creator_uid)
        reg = cmd.regenerate or RegenerateIn()
        if reg.color is not None:
            repo.set_color(gen_id, reg.color)
        if reg.prompt or reg.model:
            repo.override_prompt_model(gen_id, prompt=reg.prompt, model=reg.model)
        if reg.auto_tags:
            repo.add_auto_tags(gen_id, reg.auto_tags)

    payload = repo.gen_recipe(gen_id)
    payload["source_gen_id"] = cmd.source_gen_id
    repo.create_gen_request(cmd.email, cmd.creator_uid, gen_id, cmd.kind, payload)
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
        except Exception:  # noqa: BLE001 — 견적 실패가 생성을 막지 않게
            est = None
        pm_best_effort(lambda _m: _m.record_request(gen_id, est_credits=est))

    return repo.get_generation(gen_id)
