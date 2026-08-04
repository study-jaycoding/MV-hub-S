"""gen-request 업무 흐름(usecase).

라우터가 인증·권한·입력검증을 끝내고 만든 '검증된 명령'을 받아, placeholder 생성부터
큐잉·에이전트 깨우기·PM 견적까지의 오케스트레이션을 수행한다. FastAPI 미의존.
(ARCHITECTURE.md: routers -> usecases -> repo/services)
"""

from __future__ import annotations

from dataclasses import dataclass

from .. import repo
from ..config import MANAGE_ENABLED
from ..models import RegenerateIn
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..ws import manager


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
