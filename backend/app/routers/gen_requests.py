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

import asyncio

from fastapi import APIRouter, HTTPException, Request

from . import _proxy
from .. import repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID
from ..deps import require_view_generation
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
def create_gen_request(body: GenRequestIn, request: Request):
    """버튼이 호출 — placeholder 카드 즉시 생성 + 로컬 실행요청 큐잉. placeholder 반환."""
    acc = _require_account(request)
    creator_uid = acc.get("creator_uid")

    if body.kind == "create":
        if not body.create:
            raise HTTPException(status_code=400, detail="create 본문이 필요합니다")
        data = body.create.model_dump()
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

    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=500, detail="placeholder 생성 실패")
    return gen


@router.get("/gen-requests/active", response_model=list[GenerationOut])
def active_gen_requests(request: Request):
    """진행중(pending/running) 내 로컬 생성물 — '생성중' 카드 표시용(서버 직결 모드).
    로컬 실행 큐라 프록시되지 않고 이 허브 자기 DB 를 본다. 프론트가 주기적으로 받아 서버
    라이브러리 위에 머지한다(완료되면 done 이 되어 빠지고 서버 push 본이 그 자리를 채움)."""
    acc = _require_account(request)
    return repo.list_active_generations(acc.get("creator_uid"))


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
        await manager.broadcast(
            {"type": "progress", "generation_id": c["gen_id"], "status": "running"}
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

    gen_id = req["gen_id"]
    parsed = cli_bridge.parse_job(body.job)
    g = parsed.get("generation") or {}
    asset = parsed.get("asset")
    if asset:
        thumb = asset["file_path"] if asset["type"] == "image" else None
        repo.add_asset(gen_id, asset["type"], asset["file_path"], thumb)
    if g.get("id"):
        repo.set_job_id(gen_id, g["id"])
    repo.set_generation_timestamp(gen_id, g.get("created_at"), g.get("sort_ts"))

    status = g.get("status") or "done"
    err = g.get("error") if status == "failed" else None
    repo.set_status(gen_id, status, err)
    repo.mark_request(rid, "done" if status != "failed" else "failed", err)

    # 서버 직결 모드: 완료된 그 잡을 '즉시' 서버로 push(배치 push_once 를 안 기다림) → 4장 동시
    # 생성 때도 완료되는 즉시 한 건씩 서버에 떠, 프론트가 그 자리에서 한 건씩 결과로 교체한다.
    # 멱등(job_id PK)이라 뒤따르는 주기 push_once 와 중복 안 됨. 실패는 무시(주기 push 가 안전망).
    if status != "failed" and _proxy.proxying():
        try:
            await asyncio.to_thread(
                _proxy.proxy_json,
                "POST",
                "/api/ingest",
                body={"jobs": [body.job], "creator_uid": None, "account_status": None},
            )
        except Exception:  # noqa: BLE001 — 즉시 push 실패는 무시(주기 push_once 가 보완)
            pass

    await manager.broadcast(
        {
            "type": "progress",
            "generation_id": gen_id,
            "status": status,
            "result_url": asset["file_path"] if asset else None,
            "error": err,
        }
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
    repo.set_status(req["gen_id"], "failed", reason)
    repo.mark_request(rid, "failed", reason)
    await manager.broadcast(
        {"type": "progress", "generation_id": req["gen_id"], "status": "failed", "error": reason}
    )
    return {"ok": True}
