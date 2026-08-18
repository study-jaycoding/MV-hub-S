"""로컬 실행 생성요청(gen-request) 라우터.

흐름(project_content_hub_push_model):
  버튼 → POST /gen-requests : placeholder 카드 즉시 생성 + 요청 큐잉(요청자 계정 소유)
  에이전트 → GET /gen-requests/pending : 자기 계정 대기 요청을 claim(claimed)
            → begin-submission ACK → 로컬 CLI 로 실행 →
            POST /gen-requests/{id}/fulfill : 결과를 placeholder 에 채움(done)
            (실패 시 /fail)
서버는 힉스필드 CLI 를 돌리지 않는다. 모든 엔드포인트는 허브 세션 인증 필수.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request

from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ..deps import (
    account_actor_uid,
    actor_id,
    realtime_scope,
    require_agent_account,
    require_project_role,
    require_view_generation,
)
from ..models import (
    CanvasLinkResolveIn,
    CanvasLinkRepairIn,
    CanvasManualClaimIn,
    FulfillIn,
    GenerationOut,
    GenRequestIn,
    PendingRequestOut,
    RecoveryDecisionIn,
    RegenerateIn,
    WorkspaceContext,
)
from ..services.agent_signals import agent_signals
from ..services.release_update import update_in_progress
from ..usecases.gen_requests import (
    CanvasGenerationConflict,
    GenRequestCommand,
    anchor_request,
    begin_submission,
    claim_gen_requests,
    confirm_generation_not_submitted_and_requeue,
    confirm_not_submitted_and_requeue,
    fail_request,
    fulfill_request,
    reconcile_request,
    release_claim,
    repair_canvas_generation_links,
    require_submission_recovery,
    submit_gen_request,
)
from ._telemetry import schedule_telemetry_drain

# 규율: 이 파일의 async 핸들러에서 동기 repo(SQLite) 호출을 직접 하지 않는다.
# DB만 쓰는 핸들러는 def로 FastAPI 워커 스레드에서 실행하고, WebSocket 알림 등 await가
# 필요한 핸들러의 DB 호출은 asyncio.to_thread로 이관한다.
router = APIRouter(prefix="/api", tags=["gen-requests"])


def _require_matching_project_workspace(pid: str, workspace) -> None:
    """팀 프로젝트 생성물이 다른 워크스페이스 계정으로 제출되는 것을 차단한다."""
    project = repo.get_project(pid)
    if not project:
        raise HTTPException(status_code=400, detail="없는 프로젝트에는 생성할 수 없습니다")
    if project.get("workspace_scope") != "team":
        return  # 기존 미지정 프로젝트는 하위호환
    if workspace.scope != "team" or workspace.id != project.get("workspace_id"):
        raise HTTPException(
            status_code=409,
            detail="현재 워크스페이스와 프로젝트 워크스페이스가 다릅니다",
        )


def _validated_generation_workspace(
    workspace: WorkspaceContext, account_email: str
) -> WorkspaceContext:
    """팀 생성 요청을 계정이 실제 접근 가능한 등록부 정보로 정규화한다."""
    if workspace.scope == "unknown":
        # 생성은 CLI의 현재 선택값을 추측해 실행할 수 없다. 구 프론트·직접 API가 workspace를
        # 빼먹더라도 placeholder/큐를 만들기 전에 막아, 구 에이전트가 직전 팀 공간에 과금하는
        # 배포 버전 혼합 사고를 차단한다. unknown 보존이 필요한 ingest/마이그레이션과는 별도 경계다.
        raise HTTPException(
            status_code=409,
            detail=(
                "생성할 워크스페이스 정보가 확인되지 않았습니다 — 프로그램을 최신 버전으로 "
                "업데이트한 뒤 워크스페이스를 다시 선택하세요"
            ),
        )
    if workspace.scope != "team":
        return workspace

    registered = None
    if AUTH_ENABLED:
        registered = next(
            (
                item
                for item in repo.list_workspace_registry(
                    account_email, available_only=True
                )
                if item.get("id") == workspace.id
            ),
            None,
        )
    else:
        registered = repo.get_registry_workspace(workspace.id)

    official_name = str((registered or {}).get("name") or "").strip()
    if official_name:
        return workspace.model_copy(update={"name": official_name})
    if not AUTH_ENABLED and workspace.name:
        # 로컬 단독 모드는 서버 등록부가 없어도 에이전트가 캡처한 이름을 사용한다.
        return workspace
    raise HTTPException(
        status_code=409,
        detail=(
            "현재 계정에서 워크스페이스 이름을 확인할 수 없습니다 "
            "— 에이전트 동기화 후 다시 시도하세요"
        ),
    )

def _require_account(request: Request) -> dict:
    """생성요청용 신원. 공용 require_agent_account 로 단일화(신원 규칙 분산 방지)."""
    return require_agent_account(request)


@router.post("/gen-requests", response_model=GenerationOut, status_code=201)
async def create_gen_request(body: GenRequestIn, request: Request):
    """버튼이 호출 — placeholder 카드 즉시 생성 + 로컬 실행요청 큐잉. placeholder 반환.

    라우터는 HTTP/인증/권한/입력검증만 하고, 오케스트레이션(생성·큐잉·signal·PM)은
    usecases.gen_requests.submit_gen_request 가 수행한다(ARCHITECTURE.md)."""
    if update_in_progress():
        raise HTTPException(
            status_code=409,
            detail="프로그램 업데이트가 진행 중이라 새 생성을 시작할 수 없습니다",
        )
    acc = _require_account(request)
    workspace = await asyncio.to_thread(
        _validated_generation_workspace, body.workspace, acc["email"]
    )
    # AUTH on 미링크 계정도 자기 신원(acct:email)으로 귀속 — acc.get("creator_uid")가 None이면
    # repo 가 get_my_uid()(서버 하우스 uid)로 폴백해 '내 요청'이 남(하우스)의 신원에 귀속되던 것을 막는다.
    # 나중에 실제 uid 확보 시 remap_creator_uid 가 acct:email→user_ 로 정합한다. AUTH off 는 기존대로.
    creator_uid = account_actor_uid(request) if AUTH_ENABLED else acc.get("creator_uid")
    canvas_link = body.canvas_link.model_dump() if body.canvas_link else None

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
            await asyncio.to_thread(_require_matching_project_workspace, pid, workspace)
            await asyncio.to_thread(
                require_project_role,
                request,
                pid,
                rbac.CREATOR,
                rbac.SUPERVISOR,
                rbac.PROJECT_MANAGER,
                read_only=True,
            )
        cmd = GenRequestCommand(
            kind="create",
            email=acc["email"],
            creator_uid=creator_uid,
            worker_id=body.create.worker_id or DEFAULT_WORKER_ID,
            source_gen_id=body.source_gen_id,
            workspace=workspace.model_dump(),
            data=data,
            canvas_link=canvas_link,
        )
    else:  # regenerate
        if not body.source_gen_id:
            raise HTTPException(status_code=400, detail="source_gen_id 가 필요합니다")
        parent = await asyncio.to_thread(repo.get_generation, body.source_gen_id)
        if not parent:
            raise HTTPException(status_code=404, detail="원본 generation 없음")
        # 비공개·공유 안 된 남의 원본을 id 만 알고 재생성(=프롬프트·소스 복제)하는 우회 차단.
        await asyncio.to_thread(require_view_generation, request, parent)
        # 외부 제출 여부가 불명확한 카드를 일반 재생성으로 우회하면 같은 유료 작업이 두 번
        # 만들어질 수 있다. 복구 확인을 먼저 끝내야 기존 요청을 안전하게 다시 실행할 수 있다.
        recovery_request_id = await asyncio.to_thread(
            repo.get_recovery_request_id_for_generation,
            body.source_gen_id,
            acc["email"],
        )
        if recovery_request_id:
            raise HTTPException(
                status_code=409,
                detail=(
                    "외부 제출 여부를 먼저 확인해야 합니다 — 생성 정보에서 "
                    "'미제출 확인 후 다시 실행'을 사용하세요"
                ),
            )
        # 재생성본은 부모 project_id 를 상속(import_generation) — 부모가 프로젝트에 속하면 그 프로젝트
        # 접근권도 확인한다. 안 하면 '옛날엔 그 프로젝트 멤버였다가 빠진' 사용자가 자기 옛 생성물을
        # 재생성해 그 팀 영역에 다시 주입하는 우회가 남는다(create 가드와 동일 기준).
        ppid = (parent.get("project_id") or "").strip()
        if ppid and ppid != "none":
            await asyncio.to_thread(_require_matching_project_workspace, ppid, workspace)
            await asyncio.to_thread(
                require_project_role,
                request,
                ppid,
                rbac.CREATOR,
                rbac.SUPERVISOR,
                rbac.PROJECT_MANAGER,
                read_only=True,
            )
        reg = body.regenerate or RegenerateIn()
        # worker_id 는 parent 기준으로 라우터가 계산(usecase 가 parent 를 다시 읽으면 동작이 달라짐).
        cmd = GenRequestCommand(
            kind="regenerate",
            email=acc["email"],
            creator_uid=creator_uid,
            worker_id=reg.worker_id or parent["worker_id"] or DEFAULT_WORKER_ID,
            source_gen_id=body.source_gen_id,
            workspace=workspace.model_dump(),
            regenerate=reg,
            canvas_link=canvas_link,
        )

    try:
        gen = await submit_gen_request(cmd)
    except CanvasGenerationConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not gen:
        raise HTTPException(status_code=500, detail="placeholder 생성 실패")
    schedule_telemetry_drain()
    return gen


@router.post("/gen-requests/canvas-links/resolve")
def resolve_canvas_generation_links(body: CanvasLinkResolveIn, request: Request):
    """재시작한 캔버스가 요청 전 저장한 attempt와 실제 generation 연결을 복구한다."""
    acc = _require_account(request)
    return {
        "links": repo.resolve_canvas_generation_links(acc["email"], body.attempt_ids)
    }


@router.post("/gen-requests/canvas-links/repair")
def repair_orphaned_canvas_links(body: CanvasLinkRepairIn, request: Request):
    """placeholder만 저장된 비정상 종료 지점을 소유권 확인 후 다시 큐잉한다."""
    acc = _require_account(request)
    creator_uid = (
        account_actor_uid(request)
        if AUTH_ENABLED
        else acc.get("creator_uid") or repo.get_my_uid()
    )
    links = [link.model_dump() for link in body.links]
    return {
        "links": repair_canvas_generation_links(acc["email"], creator_uid, links)
    }


@router.get("/gen-requests/canvas-candidates")
def canvas_generation_candidates(request: Request, limit: int = 30):
    """어느 카드에도 안 담긴 내 생성물(진짜 고아)만 수동 복구 후보로 돌려준다.

    카드 소속표에 이미 있는 것은 씬을 열 때 자동으로 합쳐지므로 여기 나오면 안 된다.
    """
    acc = _require_account(request)
    ids = repo.list_canvas_generation_candidates(
        acc["email"], limit=limit, owner_uid=actor_id(request)
    )
    items = [repo.get_generation(gen_id) for gen_id in ids]
    return {"items": [item for item in items if item]}


@router.post("/gen-requests/canvas-candidates/claim")
def claim_canvas_generation_candidate(body: CanvasManualClaimIn, request: Request):
    """선택한 구버전 생성물을 한 캔버스 카드에 1회 귀속한다."""
    acc = _require_account(request)
    claimed = repo.claim_canvas_generation_candidate(
        acc["email"], body.generation_id, body.scene_id, body.card_id
    )
    if not claimed:
        raise HTTPException(status_code=404, detail="복구할 수 있는 내 생성 요청이 아닙니다")
    return {"ok": True}


@router.get("/gen-requests/pending", response_model=list[PendingRequestOut])
async def pending_gen_requests(
    request: Request,
    limit: int = 16,
    capability: str = "",
    agent_id: str | None = None,
):
    """에이전트가 호출 — 자기 계정 대기 요청을 원자적으로 claim하고 레시피를 반환한다.

    submission-stage 신 에이전트는 claimed로 받아 준비를 끝내고 begin-submission ACK 뒤에만
    placeholder가 running이 된다. 구 에이전트는 호환을 위해 claim 즉시 submitting/running으로
    전환한다. limit는 에이전트가 지금 제출할 수 있는 요청 수다.
    """
    acc = _require_account(request)
    # capability: 에이전트가 지원 기능을 콤마 목록으로 밝힌다.
    # 'workspace' 가 없으면(구 에이전트) 워크스페이스 지정 요청은 내려주지 않는다 — 지정을
    # 무시하고 현재 CLI 공간에서 실행·과금되는 사고 방지. 구 서버는 이 파라미터를 무시한다(하위호환).
    caps = {c.strip() for c in capability.split(",") if c.strip()}
    # submission-stage는 owner id가 있어야 안전하다. 둘 중 하나라도 빠진 혼합 버전은 기존
    # submitting claim으로 내려 구 에이전트가 별도 begin 호출 없이 계속 동작하게 한다.
    staged_submission = "submission-stage" in caps and bool(agent_id)
    claimed = await claim_gen_requests(
        acc["email"],
        realtime_scope(acc),
        limit,
        workspace_capable="workspace" in caps,
        lease_owner=agent_id,
        submission_stage_capable=staged_submission,
    )
    if claimed:
        schedule_telemetry_drain()
    return claimed


@router.post("/gen-requests/{rid}/begin-submission")
async def begin_gen_request_submission(
    rid: str,
    request: Request,
    agent_id: str,
):
    """신 에이전트의 실제 `generate create` 직전 CAS. 성공 전에는 유료 CLI를 호출하면 안 된다."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    applied = await begin_submission(acc["email"], realtime_scope(acc), rid, agent_id)
    if not applied:
        raise HTTPException(
            status_code=409,
            detail="제출 권한이 만료됐거나 다른 에이전트가 인계했습니다 — 생성하지 않습니다",
        )
    return {"ok": True, "applied": True}


@router.post("/gen-requests/{rid}/release-claim")
async def release_gen_request_claim(
    rid: str,
    request: Request,
    agent_id: str,
):
    """CLI 호출 전에 서버 확인이 실패한 staged claim을 같은 에이전트가 안전하게 반환한다."""
    acc = _require_account(request)
    applied = await release_claim(acc["email"], realtime_scope(acc), rid, agent_id)
    if not applied:
        raise HTTPException(status_code=409, detail="반환할 준비 단계 요청이 없습니다")
    return {"ok": True, "applied": True}


@router.post("/gen-requests/{rid}/recovery-required")
async def mark_gen_request_recovery_required(rid: str, request: Request):
    """CLI 호출은 시작했지만 job_id를 얻지 못한 모호한 결말을 자동 재생성 금지로 격리한다."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    applied = await require_submission_recovery(
        acc["email"], realtime_scope(acc), rid
    )
    if not applied:
        raise HTTPException(status_code=409, detail="복구 보류로 전환할 수 없는 요청 상태입니다")
    return {"ok": True, "applied": True}


@router.post("/gen-requests/{rid}/confirm-not-submitted")
async def confirm_gen_request_not_submitted(
    rid: str,
    body: RecoveryDecisionIn,
    request: Request,
):
    """Higgsfield 기록에 외부 작업이 없음을 직접 확인한 경우에만 재큐잉한다."""
    if not body.confirmed_not_submitted:
        raise HTTPException(
            status_code=400,
            detail="외부 생성이 없음을 확인해야 다시 실행할 수 있습니다",
        )
    acc = _require_account(request)
    applied = await confirm_not_submitted_and_requeue(
        acc["email"], realtime_scope(acc), rid
    )
    if not applied:
        raise HTTPException(status_code=409, detail="재큐잉할 복구 보류 요청이 아닙니다")
    return {"ok": True, "applied": True}


@router.post("/gen-requests/by-generation/{gen_id}/confirm-not-submitted")
async def confirm_generation_not_submitted(
    gen_id: str,
    body: RecoveryDecisionIn,
    request: Request,
):
    """정보창에서 generation id로 호출하는 명시적 복구 동작."""
    if not body.confirmed_not_submitted:
        raise HTTPException(
            status_code=400,
            detail="외부 생성이 없음을 확인해야 다시 실행할 수 있습니다",
        )
    acc = _require_account(request)
    applied = await confirm_generation_not_submitted_and_requeue(
        acc["email"],
        realtime_scope(acc),
        gen_id,
    )
    if not applied:
        raise HTTPException(status_code=409, detail="재큐잉할 복구 보류 요청이 아닙니다")
    return {"ok": True, "applied": True}


@router.post("/gen-requests/{rid}/fulfill", response_model=GenerationOut)
async def fulfill_gen_request(rid: str, body: FulfillIn, request: Request):
    """에이전트가 로컬 실행 완료 후 호출 — 결과(raw 잡)를 placeholder 에 채우고 done 표시."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = await asyncio.to_thread(repo.get_gen_request, rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    if req.get("status") in ("done", "failed"):
        # 이미 종결된 요청 → 멱등 무시(에이전트 재시작·중복 보고로 done↔failed 뒤집힘 방지).
        gen = await asyncio.to_thread(repo.get_generation, req["gen_id"])
        if not gen:
            raise HTTPException(status_code=500, detail="결과 조회 실패")
        return gen

    gen = await fulfill_request(req, rid, body.job, realtime_scope(acc))
    if not gen:
        raise HTTPException(status_code=500, detail="결과 조회 실패")
    schedule_telemetry_drain()
    return gen


@router.post("/gen-requests/{rid}/anchor")
async def anchor_gen_request(rid: str, request: Request, job_id: str, verifying: bool = True):
    """에이전트가 job_id 를 확보하면 호출 — placeholder는 running, 요청은 tracking/verifying으로 기록.
    ★가짜 실패 방지 — 실제 힉스필드엔 생성됐는데 우리만 '실패'로 뜨던 문제를 앵커로 막는다.
    verifying=False(create-first 정상 흐름): '생성중'으로 표시(제출 직후 앵커). verifying=True(모호한
    결말·재시작 복구): '확인중'으로 표시. terminal 완료는 되돌리지 않는다."""
    acc = _require_account(request)
    agent_signals.touch(acc["email"])
    req = await asyncio.to_thread(repo.get_gen_request, rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    applied = await anchor_request(req, rid, job_id, verifying, realtime_scope(acc))
    if applied:
        return {"ok": True, "applied": True}
    # ★미적용을 성공처럼 응답하면 에이전트가 크래시-세이프 outbox 에서 앵커를 지워버려
    #  유료 잡의 job_id 가 영영 카드에 안 붙었다(빈 200 이 원인).
    #  - 요청이 이미 종결/소멸: 재전송 무의미 → 200 + applied=False (구 에이전트가 200 을
    #    성공으로 보고 outbox 를 지워도 결과가 같아 무해).
    #  - 요청이 살아 있는데 거부(레이스 등): 재전송해야 함 → **409** — 구 에이전트도 비-200 을
    #    실패로 해석해 outbox 에 남긴다(혼합 배포에서도 앵커 유실 없음).
    latest = await asyncio.to_thread(repo.get_gen_request, rid)
    status = (latest or {}).get("status") or "missing"
    if status in ("done", "canceled", "failed", "missing"):
        return {"ok": True, "applied": False, "request_status": status}
    raise HTTPException(
        status_code=409,
        detail=f"앵커가 아직 반영되지 않았습니다(요청 상태={status}) — 재시도하세요",
    )


@router.get("/gen-requests/reconcile-candidates")
def reconcile_candidates(request: Request):
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
    req = await asyncio.to_thread(repo.get_gen_request, rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    result = await reconcile_request(req, body.job, force_fail_reason, realtime_scope(acc))
    if result.get("applied"):
        schedule_telemetry_drain()
    return result


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
    req = await asyncio.to_thread(repo.get_gen_request, rid)
    if not req:
        raise HTTPException(status_code=404, detail="없는 요청")
    if req["account_email"] != (acc.get("email") or "").lower():
        raise HTTPException(status_code=403, detail="내 요청이 아닙니다")
    if req.get("status") in ("done", "failed"):
        return {"ok": True}  # 이미 종결 — 멱등 무시(완료된 것을 실패로 뒤집지 않음)
    applied = await fail_request(req, rid, reason, job_id, hf_status, realtime_scope(acc))
    if applied:
        schedule_telemetry_drain()
    return {"ok": True}
