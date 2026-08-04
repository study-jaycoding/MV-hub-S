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

import re

from fastapi import APIRouter, HTTPException, Request

from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ..generation_result import ACTIVE_STATUSES, normalize_job_result
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
from ..services import cli_bridge
from ..services.agent_signals import agent_signals
from ..usecases.gen_requests import (
    GenRequestCommand,
    claim_gen_requests,
    pm_best_effort as _pm,
    submit_gen_request,
)
from ..ws import manager

router = APIRouter(prefix="/api", tags=["gen-requests"])

# 진행/성공 상태(ACTIVE_STATUSES) 밖(failed·nsfw 등)만 error(사유)를 보존한다 — 판정·필드는
# generation_result 의 단일 정의를 공유한다.
# 구버전 에이전트의 /fail 은 job_id 를 안 넘긴다 — CLI 실패 사유 문자열에서 job_id·상태를 되찾아
#  원래 placeholder 에 앵커한다("... job <uuid> ended with status 'nsfw' ...").
_HF_ENDED_RE = re.compile(
    r"\bjob\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    r"\s+ended with status\s+['\"]?([A-Za-z_ -]+)['\"]?",
    re.IGNORECASE,
)


def _failure_anchor_from_reason(reason: str) -> tuple[str | None, str | None]:
    """실패 사유 문자열에서 (job_id, 정규화 상태) 를 되찾는다. 못 찾으면 (None, None).
    진행/성공 상태로 파싱되면 failed 로 강등."""
    m = _HF_ENDED_RE.search(reason or "")
    if not m:
        return None, None
    status = cli_bridge.normalize_status(m.group(2).strip().replace(" ", "_"))
    if status in ACTIVE_STATUSES:
        status = "failed"
    return m.group(1), status


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
    완료될 때까지 '생성중'이 안 보였음). limit=에이전트의 빈 병렬 슬롯 수(연속 풀이 그만큼만 집음)."""
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

    gen_id = req["gen_id"]
    parsed = cli_bridge.parse_job(body.job)
    result = normalize_job_result(parsed)
    # ★원자 적용(+CAS): 에셋·job_id·타임스탬프·상태·요청표시를 한 트랜잭션으로. 동시 fulfill/fail 로
    # 이미 종결됐으면 False → 멱등 반환(완료를 덮어쓰지 않음·중복 브로드캐스트 안 함).
    applied = repo.apply_local_fulfillment(
        gen_id,
        rid,
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
        gen = repo.get_generation(gen_id)
        if not gen:
            raise HTTPException(status_code=500, detail="결과 조회 실패")
        return gen
    # PM 메트릭: completed_at + elapsed(started_at 대비). applied=True 일 때만 → 멱등(중복 보고 무영향).
    _pm(lambda _m: _m.record_completed(gen_id, job_id=result.job_id))
    # 로컬 우선: 결과는 로컬 DB 에 저장만 하면 내 화면(로컬 읽기)에 바로 보인다. 서버로는
    # 보내지 않는다 — 공유는 '선택 발행'(번들 push)으로만 일어난다(CLAUDE.md 원칙 2).

    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": gen_id,
            "status": result.status,
            "result_url": result.asset_path,
            "error": result.error,
        },
        account_uid=realtime_scope(acc),  # 그 계정 소켓에만
    )
    gen = repo.get_generation(gen_id)
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
    if not repo.apply_local_anchor(req["gen_id"], rid, job_id, verifying=verifying):
        return {"ok": True}
    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": req["gen_id"],
            "status": "running",
            "error": repo.VERIFYING_NOTE if verifying else None,
        },
        account_uid=realtime_scope(acc),  # 그 계정 소켓에만
    )
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
    """재조정 — 에이전트가 generate get/wait 로 확보한 '권위 있는' 잡 상태로 placeholder 를 보정한다.
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
    gen_id = req["gen_id"]
    parsed = cli_bridge.parse_job(body.job)
    # 로컬 검증 실패(레퍼런스 미부착 등) — 힉스필드엔 (엉뚱한) 결과가 완료로 있어도 되살림 금지 failed 확정.
    if force_fail_reason:
        # 강제 실패에는 job id 만 필요하다. 잘못 붙은 결과 asset 이 불완전해도 정규화 전에 실패를
        # 확정해야 하므로 이 분기를 normalize_job_result 보다 먼저 둔다.
        job_id = (parsed.get("generation") or {}).get("id")
        applied = repo.apply_reconcile(
            gen_id, job_id,
            asset_type=None, asset_path=None, asset_thumb=None,
            created_at=None, sort_ts=None, status="failed", error=force_fail_reason,
            force_fail_reason=force_fail_reason,
        )
        if applied:
            _pm(lambda _m: _m.record_completed(gen_id, job_id=job_id))
            await manager.broadcast(
                {"type": "progress", "generation_id": gen_id, "status": "failed", "error": force_fail_reason},
                account_uid=realtime_scope(acc),
            )
        return {"ok": True, "applied": applied, "status": "failed"}
    result = normalize_job_result(parsed)
    # 아직 처리중(pending/running)이면 확정하지 않는다 — '확인중' 유지, 다음 사이클 재시도.
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
        _pm(lambda _m: _m.record_completed(gen_id, job_id=result.job_id))
        await manager.broadcast(
            {
                "type": "progress",
                "generation_id": gen_id,
                "status": result.status,
                "result_url": result.asset_path if result.status != "failed" else None,
                "error": result.error,
            },
            account_uid=realtime_scope(acc),
        )
    return {"ok": True, "applied": applied, "status": result.status}


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
    parsed_job_id, parsed_status = _failure_anchor_from_reason(reason)
    final_job_id = job_id or parsed_job_id
    final_status = cli_bridge.normalize_status(hf_status) if hf_status else (parsed_status or "failed")
    if final_status in repo.ACTIVE_STATUSES:
        final_status = "failed"
    # 원자·CAS 적용 — 동시 fulfill 이 라우터 밖 status 검사를 함께 통과해 done 을 failed 로 뒤집던
    # TOCTOU 를 닫는다. 이미 종결됐으면 False → 멱등 반환(브로드캐스트 안 함).
    if not repo.apply_local_failure(req["gen_id"], rid, reason, job_id=final_job_id, status=final_status):
        return {"ok": True}
    _pm(lambda _m: _m.record_completed(req["gen_id"], job_id=final_job_id))  # PM 메트릭: 실패도 종료시각 기록
    await manager.broadcast(
        {"type": "progress", "generation_id": req["gen_id"], "status": final_status, "error": reason},
        account_uid=realtime_scope(acc),  # 그 계정 소켓에만
    )
    return {"ok": True}
