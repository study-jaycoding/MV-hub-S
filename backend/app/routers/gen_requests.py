"""로컬 실행 생성요청(gen-request) 라우터.

흐름(project_content_hub_push_model):
  버튼 → POST /gen-requests : placeholder 카드 즉시 생성 + 요청 큐잉(요청자 계정 소유)
  에이전트 → GET /gen-requests/pending : 자기 계정 대기 요청을 claim(running)
            → 로컬 CLI 로 실행 →
            POST /gen-requests/{id}/fulfill : 결과를 placeholder 에 채움(done)
            (실패 시 /fail)
서버는 힉스필드 CLI 를 돌리지 않는다. 모든 엔드포인트는 허브 세션 인증 필수.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID, MANAGE_ENABLED
from ..deps import (
    account_actor_uid,
    realtime_scope,
    require_project_role,
    require_view_generation,
)
from ..models import (
    FulfillIn,
    GenerationOut,
    GenRequestIn,
    PendingRequestOut,
    RegenerateIn,
)
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..ws import manager

router = APIRouter(prefix="/api", tags=["gen-requests"])


def _pm(action) -> None:
    """PM 메트릭 best-effort 실행(분리형). MANAGE_ENABLED off 거나 실패해도 생성 흐름·응답에
    영향 0 — 메트릭 수집은 절대 생성을 막지 않는다(안전 검토 PM_DASHBOARD_DESIGN.md §6-1).
    action 은 manage 모듈을 받는 콜러블."""
    if not MANAGE_ENABLED:
        return
    try:
        from ..repo import manage as _m

        action(_m)
    except Exception:  # noqa: BLE001 — 메트릭 실패가 생성을 막지 않게
        pass


def _require_account(request: Request) -> dict:
    acc = getattr(request.state, "account", None)
    if acc:
        return acc
    # 무로그인/단독 모드(AUTH off): 미들웨어가 account 를 안 채운다 → 제공자(나) 신원으로 폴백해
    # 로컬 생성을 막지 않는다(광고된 개인 모드 보존). AUTH on 에서는 그대로 401.
    if not AUTH_ENABLED:
        return {"email": "local", "creator_uid": repo.get_my_uid()}
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")


@router.post("/gen-requests", response_model=GenerationOut, status_code=201)
async def create_gen_request(body: GenRequestIn, request: Request):
    """버튼이 호출 — placeholder 카드 즉시 생성 + 로컬 실행요청 큐잉. placeholder 반환."""
    acc = _require_account(request)
    # AUTH on 미링크 계정도 자기 신원(acct:email)으로 귀속 — acc.get("creator_uid")가 None이면
    # repo 가 get_my_uid()(서버 하우스 uid)로 폴백해 '내 요청'이 남(하우스)의 신원에 귀속되던 것을 막는다.
    # 나중에 실제 uid 확보 시 remap_creator_uid 가 acct:email→user_ 로 정합한다. AUTH off 는 기존대로.
    creator_uid = account_actor_uid(request) if AUTH_ENABLED else acc.get("creator_uid")

    if body.kind == "create":
        if not body.create:
            raise HTTPException(status_code=400, detail="create 본문이 필요합니다")
        data = body.create.model_dump()
        # project_id 검증(AUTH on) — 남의 프로젝트 id 를 넣어 그 팀 영역에 작업을 주입하거나
        # 존재하지 않는 project_id 로 귀속시키는 것을 막는다. read_only=True 라 그 프로젝트 멤버이거나
        # 전역 read_all(admin·PM·PD)이면 통과. 로컬 허브(AUTH off)는 가드가 즉시 통과(개인 모드 보존).
        pid = (data.get("project_id") or "").strip()
        if pid == "none":
            data["project_id"] = None  # UI sentinel '미분류' 를 저장 전에 정규화(API 직접 호출 대비)
        elif pid:
            if not repo.get_project(pid):
                raise HTTPException(status_code=400, detail="없는 프로젝트에는 생성할 수 없습니다")
            require_project_role(
                request, pid, rbac.CREATOR, rbac.SUPERVISOR, rbac.PROJECT_MANAGER, read_only=True
            )
        worker_id = body.create.worker_id or DEFAULT_WORKER_ID
        gen_id = repo.create_local_generation(data, worker_id, creator_uid=creator_uid)
    else:  # regenerate
        if not body.source_gen_id:
            raise HTTPException(status_code=400, detail="source_gen_id 가 필요합니다")
        parent = repo.get_generation(body.source_gen_id)
        if not parent:
            raise HTTPException(status_code=404, detail="원본 generation 없음")
        # 비공개·공유 안 된 남의 원본을 id 만 알고 재생성(=프롬프트·소스 복제)하는 우회 차단.
        require_view_generation(request, parent)
        # 재생성본은 부모 project_id 를 상속(import_generation) — 부모가 프로젝트에 속하면 그 프로젝트
        # 접근권도 확인한다. 안 하면 '옛날엔 그 프로젝트 멤버였다가 빠진' 사용자가 자기 옛 생성물을
        # 재생성해 그 팀 영역에 다시 주입하는 우회가 남는다(create 가드와 동일 기준).
        ppid = (parent.get("project_id") or "").strip()
        if ppid and ppid != "none":
            require_project_role(
                request, ppid, rbac.CREATOR, rbac.SUPERVISOR, rbac.PROJECT_MANAGER, read_only=True
            )
        reg = body.regenerate or RegenerateIn()
        worker_id = reg.worker_id or parent["worker_id"] or DEFAULT_WORKER_ID
        gen_id = repo.import_generation(body.source_gen_id, worker_id, creator_uid=creator_uid)
        if reg.color is not None:
            repo.set_color(gen_id, reg.color)
        if reg.prompt or reg.model:
            repo.override_prompt_model(gen_id, prompt=reg.prompt, model=reg.model)
        if reg.auto_tags:
            repo.add_auto_tags(gen_id, reg.auto_tags)

    payload = repo.gen_recipe(gen_id)
    payload["source_gen_id"] = body.source_gen_id
    repo.create_gen_request(acc["email"], creator_uid, gen_id, body.kind, payload)
    # 요청자 에이전트를 즉시 깨움(이벤트 방식) — 30초 폴링 대기 없이 바로 실행.
    agent_signals.signal(acc["email"], "gen-request")

    # PM 메트릭: 요청 시점 requested_at + 견적 박제. 서버에 CLI 있을 때만 견적(없으면 NULL —
    # 실제값은 후속 단계의 거래 매칭으로 채움). 견적 0/실패는 미상(NULL)로 둔다(진짜 0 과 구분 불가).
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
        _pm(lambda _m: _m.record_request(gen_id, est_credits=est))

    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=500, detail="placeholder 생성 실패")
    return gen


@router.get("/gen-requests/pending", response_model=list[PendingRequestOut])
async def pending_gen_requests(request: Request, limit: int = 16):
    """에이전트가 호출 — 자기 계정 대기 요청을 claim(running)하고 레시피 반환.
    claim 즉시 placeholder 카드를 'running'(로컬 생성중)으로 올려 브로드캐스트한다 —
    에이전트가 실제로 내 PC에서 돌리기 시작했다는 피드백(이전엔 pending=로컬 대기 그대로라
    완료될 때까지 '생성중'이 안 보였음). limit=에이전트의 빈 병렬 슬롯 수(연속 풀이 그만큼만 집음)."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])  # 생성 실행 중 ~1초마다 폴링 → '연결됨' 유지(꺼짐 깜빡임 방지)
    claimed = repo.claim_pending_requests(acc["email"], limit=max(1, min(limit, 16)))
    for c in claimed:
        repo.set_status(c["gen_id"], "running", None)
        _pm(lambda _m: _m.record_started(c["gen_id"]))  # PM 메트릭: started_at
        await manager.broadcast(
            {"type": "progress", "generation_id": c["gen_id"], "status": "running"},
            account_uid=realtime_scope(acc),  # 그 계정 소켓에만(남에게 진행률 누출 방지)
        )
    return claimed


@router.post("/gen-requests/{rid}/fulfill", response_model=GenerationOut)
async def fulfill_gen_request(rid: str, body: FulfillIn, request: Request):
    """에이전트가 로컬 실행 완료 후 호출 — 결과(raw 잡)를 placeholder 에 채우고 done 표시."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = repo.get_gen_request(rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    if req.get("status") in ("done", "failed"):
        # 이미 종결된 요청 → 멱등 무시(에이전트 재시작·중복 보고로 done↔failed 뒤집힘 방지).
        gen = repo.get_generation(req["gen_id"])
        if not gen:
            raise HTTPException(status_code=500, detail="결과 조회 실패")
        return gen

    gen_id = req["gen_id"]
    parsed = cli_bridge.parse_job(body.job)
    g = parsed.get("generation") or {}
    asset = parsed.get("asset")
    status = g.get("status") or "done"
    err = g.get("error") if status == "failed" else None
    # ★원자 적용(+CAS): 에셋·job_id·타임스탬프·상태·요청표시를 한 트랜잭션으로. 동시 fulfill/fail 로
    # 이미 종결됐으면 False → 멱등 반환(완료를 덮어쓰지 않음·중복 브로드캐스트 안 함).
    applied = repo.apply_local_fulfillment(
        gen_id,
        rid,
        asset_type=asset["type"] if asset else None,
        asset_path=asset["file_path"] if asset else None,
        asset_thumb=(asset["file_path"] if asset and asset["type"] == "image" else None),
        job_id=g.get("id"),
        created_at=g.get("created_at"),
        sort_ts=g.get("sort_ts"),
        status=status,
        error=err,
        request_status="done" if status != "failed" else "failed",
    )
    if not applied:
        gen = repo.get_generation(gen_id)
        if not gen:
            raise HTTPException(status_code=500, detail="결과 조회 실패")
        return gen
    # PM 메트릭: completed_at + elapsed(started_at 대비). applied=True 일 때만 → 멱등(중복 보고 무영향).
    _pm(lambda _m: _m.record_completed(gen_id, job_id=g.get("id")))
    # 로컬 우선: 결과는 로컬 DB 에 저장만 하면 내 화면(로컬 읽기)에 바로 보인다. 서버로는
    # 보내지 않는다 — 공유는 '선택 발행'(번들 push)으로만 일어난다(CLAUDE.md 원칙 2).

    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": gen_id,
            "status": status,
            "result_url": asset["file_path"] if asset else None,
            "error": err,
        },
        account_uid=realtime_scope(acc),  # 그 계정 소켓에만
    )
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=500, detail="결과 조회 실패")
    return gen


@router.post("/gen-requests/{rid}/fail")
async def fail_gen_request(rid: str, request: Request, reason: str = "로컬 실행 실패"):
    """에이전트가 로컬 실행 실패를 보고 — 요청·placeholder 모두 failed."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = repo.get_gen_request(rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    if req.get("status") in ("done", "failed"):
        return {"ok": True}  # 이미 종결 — 멱등 무시(완료된 것을 실패로 뒤집지 않음)
    # 원자·CAS 적용 — 동시 fulfill 이 라우터 밖 status 검사를 함께 통과해 done 을 failed 로 뒤집던
    # TOCTOU 를 닫는다. 이미 종결됐으면 False → 멱등 반환(브로드캐스트 안 함).
    if not repo.apply_local_failure(req["gen_id"], rid, reason):
        return {"ok": True}
    _pm(lambda _m: _m.record_completed(req["gen_id"]))  # PM 메트릭: 실패도 종료시각 기록
    await manager.broadcast(
        {"type": "progress", "generation_id": req["gen_id"], "status": "failed", "error": reason},
        account_uid=realtime_scope(acc),  # 그 계정 소켓에만
    )
    return {"ok": True}
