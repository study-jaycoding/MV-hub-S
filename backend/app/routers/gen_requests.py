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
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ..deps import (
    account_actor_uid,
    realtime_scope,
    require_agent_account,
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
from ..services.agent_signals import agent_signals
from ..usecases.gen_requests import (
    GenRequestCommand,
    anchor_request,
    claim_gen_requests,
    fail_request,
    fulfill_request,
    reconcile_request,
    submit_gen_request,
)

router = APIRouter(prefix="/api", tags=["gen-requests"])

def _require_account(request: Request) -> dict:
    """생성요청용 신원. 공용 require_agent_account 로 단일화(신원 규칙 분산 방지)."""
    return require_agent_account(request)


@router.post("/gen-requests", response_model=GenerationOut, status_code=201)
async def create_gen_request(body: GenRequestIn, request: Request):
    """버튼이 호출 — placeholder 카드 즉시 생성 + 로컬 실행요청 큐잉. placeholder 반환.

    라우터는 HTTP/인증/권한/입력검증만 하고, 오케스트레이션(생성·큐잉·signal·PM)은
    usecases.gen_requests.submit_gen_request 가 수행한다(ARCHITECTURE.md)."""
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
        cmd = GenRequestCommand(
            kind="create",
            email=acc["email"],
            creator_uid=creator_uid,
            worker_id=body.create.worker_id or DEFAULT_WORKER_ID,
            source_gen_id=body.source_gen_id,
            data=data,
        )
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
        # worker_id 는 parent 기준으로 라우터가 계산(usecase 가 parent 를 다시 읽으면 동작이 달라짐).
        cmd = GenRequestCommand(
            kind="regenerate",
            email=acc["email"],
            creator_uid=creator_uid,
            worker_id=reg.worker_id or parent["worker_id"] or DEFAULT_WORKER_ID,
            source_gen_id=body.source_gen_id,
            regenerate=reg,
        )

    gen = await submit_gen_request(cmd)
    if not gen:
        raise HTTPException(status_code=500, detail="placeholder 생성 실패")
    return gen


@router.get("/gen-requests/pending", response_model=list[PendingRequestOut])
async def pending_gen_requests(request: Request, limit: int = 16):
    """에이전트가 호출 — 자기 계정 대기 요청을 claim(running)하고 레시피 반환.
    claim 즉시 placeholder 카드를 'running'(로컬 생성중)으로 올려 브로드캐스트한다 —
    에이전트가 실제로 내 PC에서 돌리기 시작했다는 피드백(이전엔 pending=로컬 대기 그대로라
    완료될 때까지 '생성중'이 안 보였음). limit=에이전트가 지금 제출할 수 있는 요청 수."""
    acc = _require_account(request)
    return await claim_gen_requests(acc["email"], realtime_scope(acc), limit)


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

    gen = await fulfill_request(req, rid, body.job, realtime_scope(acc))
    if not gen:
        raise HTTPException(status_code=500, detail="결과 조회 실패")
    return gen


@router.post("/gen-requests/{rid}/anchor")
async def anchor_gen_request(rid: str, request: Request, job_id: str, verifying: bool = True):
    """에이전트가 job_id 를 확보하면 호출 — placeholder 를 running 유지 + job_id 기록(요청은 done 으로
    닫아 30분 stale 회수가 이 카드를 실패로 뒤집지 않게). 재조정 패스가 나중에 generate get 으로 확정.
    ★가짜 실패 방지 — 실제 힉스필드엔 생성됐는데 우리만 '실패'로 뜨던 문제를 앵커로 막는다.
    verifying=False(create-first 정상 흐름): '생성중'으로 표시(제출 직후 앵커). verifying=True(모호한
    결말·재시작 복구): '확인중'으로 표시. ★멱등: 요청이 이미 done 이어도 apply_local_anchor 가 no-op 처리
    (failed 요청은 되살려 앵커 — stale/부팅정리 복구). 라우터에서 미리 걸러내지 않는다."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = repo.get_gen_request(rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    await anchor_request(req, rid, job_id, verifying, realtime_scope(acc))
    return {"ok": True}


@router.get("/gen-requests/reconcile-candidates")
async def reconcile_candidates(request: Request):
    """에이전트가 주기적으로 호출 — 이 계정의 '실제 상태 미확정' 로컬 카드 목록을 받아, 각 job_id 를
    자기 CLI 계정으로 generate get 해 확정하고 /reconcile 로 보정 push 한다(push 모델·계정 소유권).
    조회만이라 과금 없음. [{rid, gen_id, job_id}]."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    cands = repo.list_reconcile_candidates((acc.get("email") or "").lower())
    return {"candidates": cands}


@router.post("/gen-requests/{rid}/reconcile")
async def reconcile_gen_request(
    rid: str, body: FulfillIn, request: Request, force_fail_reason: str | None = None
):
    """재조정 — 에이전트가 generate list/get 으로 확보한 '권위 있는' 잡 상태로 placeholder 를 보정한다.
    fulfill 과 달리 이미 종결(done/failed)이어도, 특히 failed→done '되살리기'도 허용한다(가짜 실패 복구).
    안전: job_id 일치 + origin='local' + 내 계정일 때만(repo.apply_reconcile 강조건). 아직 처리중이면 보정 안 함.
    force_fail_reason: create-first 에서 레퍼런스 미부착 등 '로컬 검증 실패'를 되살림 금지로 확정할 때."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = repo.get_gen_request(rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    return await reconcile_request(req, body.job, force_fail_reason, realtime_scope(acc))


@router.post("/gen-requests/{rid}/fail")
async def fail_gen_request(
    rid: str,
    request: Request,
    reason: str = "로컬 실행 실패",
    job_id: str | None = None,
    hf_status: str | None = None,
):
    """에이전트가 로컬 실행 실패를 보고 — 요청·placeholder 모두 failed.
    job_id/hf_status 를 주면(신에이전트) 그대로, 없으면(구에이전트) 사유 문자열에서 되찾아 placeholder 에
    앵커한다 → generate list ingest 가 새 유령 행을 안 만들고 이 행을 UPDATE(멱등)한다."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = repo.get_gen_request(rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    if req.get("status") in ("done", "failed"):
        return {"ok": True}  # 이미 종결 — 멱등 무시(완료된 것을 실패로 뒤집지 않음)
    await fail_request(req, rid, reason, job_id, hf_status, realtime_scope(acc))
    return {"ok": True}
