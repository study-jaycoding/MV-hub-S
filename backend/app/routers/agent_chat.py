"""MV Agent 칸 HTTP 입구(설계 docs/status/AskAgent_옆칸_설계_2026-11-09.md 10절).

로컬 허브에서 CONTENT_HUB_AGENT_CHAT=1 일 때만 붙는다(main). 권한 = 로그인 신원(허브 id + DB 경로 + 계정) — 신원 판정은
MCP 와 같은 `mcp_v2._capture`(AUTH off 워커는 공유 서버 로그인까지 대조)·`_still_current` 를 쓴다. 칸 비밀값은 다른
웹페이지의 위조 요청을 막는 표일 뿐이다. 실행(유료)은 사람이 누른 [실행](여기) 또는 칸 연결의 AI 실행(`mcp_v2._panel_execute`
— 이 대화의 계획·도는 차례만, 앱 동작 도구 설계 A2)이 `mcp_v2.submit_plan` 을 부를 때만이다.
"""
from __future__ import annotations

import asyncio
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field

from .. import active_account, config
from ..deps import expected_account_differs
from ..emailnorm import norm_email
from ..mcp_models import StrictModel
from ..repo import agent_chat as chat_store
from ..repo import mcp_v2 as mcp_store
from ..services import agent_chat as chat
from ..services import agent_chat_claude as claude
from ..services.agent_chat import EFFORTS, MODELS, Identity, service
from ..services.request_guards import require_loopback_browser_request
from . import _proxy, mcp, mcp_v2

router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])
_EXPECT = "x-mvhub-expect-account"
_PANEL = "x-mvhub-panel"
_MAX_CONTEXT = 4096
_SESSION_GONE = {"X-MVHub-Panel-Error": "session", "X-MVHub-Auth-State": "preserved"}  # 로그인 만료로 보지 않게
_ACCOUNT_CHANGED = {"X-MVHub-Panel-Error": "account"}
# 같은 신원의 차례 시작·취소를 한 줄로 — 선점과 실행 등록 사이에 취소·같은 열쇠 재요청이 끼면 실행 정보 없는 차례가
# 끝난 것으로 바뀐 채 CLI 가 뒤늦게 뜨거나, 같은 열쇠에 대화가 둘 생긴다(독립 리뷰 2차). 허브는 이벤트 루프 하나다.
_turn_locks: dict[str, asyncio.Lock] = {}


def _turn_lock(identity: Identity) -> asyncio.Lock:
    return _turn_locks.setdefault(identity.key(), asyncio.Lock())


def _identity(ctx) -> Identity:
    return Identity(ctx.hub, str(ctx.path), norm_email(ctx.account["email"]))


async def _captured(request: Request):
    require_loopback_browser_request(request, "MV Agent 칸은 이 PC 의 앱에서만 쓸 수 있습니다.")
    if len(request.headers.getlist(_EXPECT)) != 1 or not request.headers.get(_EXPECT, "").strip():
        raise HTTPException(400, "계정 확인 머리글이 필요합니다.")
    ctx = await asyncio.to_thread(mcp_v2._capture, request)
    identity = _identity(ctx)
    if expected_account_differs(request, identity.email):
        raise HTTPException(409, "앱의 계정이 바뀌었습니다. 화면을 새로 고치세요.", headers=_ACCOUNT_CHANGED)
    return ctx, identity


async def _panel(request: Request):
    secret_identity = service.session_identity(request.headers.get(_PANEL))
    if secret_identity is None:  # 신원 확인 전에 먼저 본다 — 표 없는 요청에 공유 서버 확인을 쓰지 않게
        require_loopback_browser_request(request, "MV Agent 칸은 이 PC 의 앱에서만 쓸 수 있습니다.")
        raise HTTPException(401, "칸 연결이 끝났습니다. 다시 여세요.", headers=_SESSION_GONE)
    ctx, identity = await _captured(request)
    if identity != secret_identity:
        raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED)
    with active_account.pinned_account_scope(ctx.pin), _proxy.pinned_connection(ctx.upstream):
        yield ctx, identity


async def _still(ctx) -> None:
    try:
        await asyncio.to_thread(mcp_v2._still_current, ctx)
    except HTTPException as exc:
        raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED) from exc


@router.post("/session")
async def session(request: Request):
    ctx, identity = await _captured(request)
    engines = await asyncio.to_thread(service.engines)
    return {"secret": service.issue_session(identity), "account_email": identity.email, "identity_key": identity.key(),
            "engines": engines}


def _window_open() -> bool:
    try:
        return claude.window_alive()
    except claude.RecordUnreadable:
        return True  # 깨진 기록은 '열려 있음'처럼 막는다(상태 문구가 까닭을 알린다)


@router.get("/claude")
async def claude_status(panel=Depends(_panel)):
    """캐시 없이 지금 Claude 상태 — 연결 안내 화면이 2초마다 본다. 엔진 목록도 새로(입력칸·모델 선택 갱신용)."""
    engines = await asyncio.to_thread(service.engines, True)
    row = next(item for item in engines if item["id"] == "claude")
    return {"state": row["state"], "version": row["version"] or None, "subscription": row["subscription"],
            "login_window": await asyncio.to_thread(_window_open), "login_window_enabled": config.AGENT_CHAT_LOGIN_WINDOW,
            "engines": engines}


_CLAUDE_ERROR = "X-MVHub-Claude-Error"


@router.post("/claude/login")
async def claude_login(panel=Depends(_panel)):
    """[Claude 연결] — 사람이 보는 로그인 창(스위치가 켜졌을 때만). 창은 사람의 것이라 끄는 경로는 없다."""
    ctx, _ = panel
    try:
        await asyncio.to_thread(claude.open_login_window, lambda: mcp_v2._still_current(ctx))
    except claude.LoginDisabled as exc:
        raise HTTPException(409, "이 PC 에서는 터미널에서 로그인해 주세요.", headers={_CLAUDE_ERROR: "login_window_disabled"}) from exc
    except claude.BreakawayDenied as exc:
        raise HTTPException(409, "로그인 창을 열 수 없는 환경이에요 — 터미널에서 로그인해 주세요.",
                            headers={_CLAUDE_ERROR: "breakaway_denied"}) from exc
    except claude.Busy as exc:
        raise HTTPException(409, str(exc), headers={_CLAUDE_ERROR: exc.code}) from exc
    except HTTPException as exc:  # 띄우기 직전 신원 재대조에서 계정·허브가 바뀜
        raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED) from exc
    except OSError as exc:
        raise HTTPException(503, "로그인 창을 열지 못했어요 — 터미널에서 로그인해 주세요.",
                            headers={_CLAUDE_ERROR: "spawn_failed"}) from exc
    await asyncio.to_thread(service.engines, True)  # 캐시 비움
    return {"opened": True}


@router.get("/conversations")
async def conversations(panel=Depends(_panel)):
    _, identity = panel
    return {"conversations": await asyncio.to_thread(chat_store.list_conversations, identity.db_file())}


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: UUID, panel=Depends(_panel)):
    ctx, identity = panel

    def load():
        path = identity.db_file()
        found = chat_store.get_conversation(path, str(conversation_id))
        if not found:
            return None
        turns = [{**turn, "events": chat_store.events_after(path, turn["id"], 0, limit=chat.EVENT_PAGE)}
                 for turn in chat_store.turns_for(path, found["id"])]
        public = {key: found[key] for key in ("id", "title", "engine", "model", "effort", "updated_at", "resumable")}
        return {"conversation": public, "turns": turns}

    result = await asyncio.to_thread(load)  # 사건을 먼저 읽고 그다음 스냅샷 — 복원 스냅샷이 함께 돌려준 사건보다 새롭다(설계 A2-5)
    if result is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    result["plans"] = await _plan_snapshots(ctx, identity, str(conversation_id))
    await _still(ctx)  # 읽는 사이 계정이 바뀌었으면 넘기지 않는다
    return result


_RESTORE_SECONDS = 15.0


async def _plan_snapshots(ctx, identity: Identity, conversation_id: str) -> list[dict]:
    """대화 복원 보정 — 이 대화에 묶인 계획(최근 20개)의 지금 상태. 전체 15초 예산, 못 읽은 계획은 뺀다(카드는 사건으로 복원한 그대로)."""
    bindings = await asyncio.to_thread(chat_store.bindings_for_conversation, identity.db_file(), conversation_id)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _RESTORE_SECONDS
    out = []
    for binding in bindings:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        client = await asyncio.to_thread(_panel_client, ctx, identity, binding["client_id"])
        if not client:
            continue
        ctx.client = client
        try:
            snapshot = await asyncio.wait_for(
                mcp_v2.panel_snapshot(ctx, binding["plan_id"], service.turn_for_client(client["id"])), remaining)
        except asyncio.TimeoutError:
            break
        if snapshot:
            out.append(snapshot)
    return out


class TurnIn(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    conversation_id: UUID | None = None
    engine: Literal["claude", "codex"]
    model: str = Field(min_length=1, max_length=40)
    effort: Literal["low", "medium", "high", "xhigh", "max"]
    fast: bool = False  # 빠른 모드 — Opus 만, 매 차례 켬/끔을 CLI 에 적는다(Claude 추가 사용 크레딧)
    text: str = Field(min_length=1, max_length=8000)
    context: dict = Field(default_factory=dict)


@router.post("/turns")
async def start_turn(body: TurnIn, request: Request, panel=Depends(_panel)):
    ctx, identity = panel
    if body.model not in {row["id"] for row in MODELS[body.engine]}:
        raise HTTPException(422, "모델을 다시 고르세요.")
    if body.effort not in EFFORTS[body.engine]:
        raise HTTPException(422, "생각 깊이를 다시 고르세요.")
    if body.fast and (body.engine != "claude" or body.model not in claude.FAST_MODELS):
        raise HTTPException(422, "빠른 모드는 Opus 5.5 에서만 쓸 수 있어요.")
    if len(json.dumps(body.context, ensure_ascii=False)) > _MAX_CONTEXT:
        raise HTTPException(422, "화면 정보가 너무 큽니다.")
    async with _turn_lock(identity):
        return await _start_turn_locked(body, request, ctx, identity)


async def _start_turn_locked(body: TurnIn, request: Request, ctx, identity: Identity) -> dict:
    path = await asyncio.to_thread(identity.db_file)
    existing = await asyncio.to_thread(chat_store.turn_by_key, path, body.idempotency_key)
    if existing:  # 응답을 잃고 다시 보낸 같은 요청 — 새로 실행하지 않는다
        return {"turn_id": existing["id"], "conversation_id": existing["conversation_id"], "status": existing["status"]}
    if await asyncio.to_thread(chat_store.has_active, path):
        raise HTTPException(409, "앞 차례가 아직 진행 중입니다.")
    # 새 대화든 이어 가기든 지금 설치된 판을 다시 본다(실행 직전에도 한 번 더 — 서비스)
    problem = await asyncio.to_thread(service.engine_problem, body.engine)
    if problem:
        raise HTTPException(409, f"이 AI 는 지금 쓸 수 없습니다 — {problem}")
    if body.engine == "claude":  # 다른 허브 대화 중·로그인 창 — 빠른 확인(실제 잠금은 차례 스레드가 잡는다)
        blocked = await asyncio.to_thread(claude.would_block)
        if blocked:
            raise HTTPException(409, blocked)
    if body.conversation_id:
        conv = await asyncio.to_thread(chat_store.get_conversation, path, str(body.conversation_id))
        if not conv:
            raise HTTPException(404, "대화를 찾을 수 없습니다.")
        if conv["engine"] != body.engine:
            raise HTTPException(409, "엔진을 바꾸면 새 대화로 시작하세요.")
        if not conv["resumable"]:
            raise HTTPException(409, "이 대화는 이어 갈 수 없어요 · 새 대화로 시작하세요.")
    else:
        setup = await mcp.setup(request, identity=None)
        try:
            client_id, entry = await asyncio.to_thread(mcp_v2.issue_panel_client, ctx, setup)
        except ValueError as exc:
            raise HTTPException(503, mcp_v2._setup_error_message(exc)) from exc
        conv = await asyncio.to_thread(lambda: chat_store.create_conversation(
            path, engine=body.engine, model=body.model, effort=body.effort, client_id=client_id, mcp_entry=entry,
            title=" ".join(body.text.split())[:40]))
    try:
        turn, created = await asyncio.to_thread(lambda: chat_store.claim_turn(
            path, conversation_id=conv["id"], idempotency_key=body.idempotency_key, text=body.text, context=body.context))
    except chat_store.Busy as exc:
        raise HTTPException(409, "앞 차례가 아직 진행 중입니다.") from exc
    if created:
        await asyncio.to_thread(chat_store.update_conversation, path, conv["id"], model=body.model, effort=body.effort)
        try:
            service.start_turn(identity, conversation=conv, turn=turn, model=body.model, effort=body.effort,
                               text=body.text, context=body.context, still_current=lambda: mcp_v2._still_current(ctx),
                               fast=body.fast)
        except Exception as exc:  # noqa: BLE001 - 실행 전 실패는 그 차례를 끝내고 알린다
            await asyncio.to_thread(chat_store.set_status, path, turn["id"], "failed", reason="start_failed")
            await asyncio.to_thread(chat_store.append_event, path, turn["id"], "error", {"message": "AI 프로그램을 시작하지 못했습니다."})
            raise HTTPException(503, "AI 프로그램을 시작하지 못했습니다.") from exc
    return {"turn_id": turn["id"], "conversation_id": turn["conversation_id"], "status": turn["status"]}


@router.get("/turns/{turn_id}/events")
async def turn_events(turn_id: UUID, after: int = Query(0, ge=0), panel=Depends(_panel)):
    ctx, identity = panel
    result = await service.wait_events(identity, str(turn_id), after)
    if result["status"] == "missing":
        raise HTTPException(404, "차례를 찾을 수 없습니다.")
    await _still(ctx)  # 기다리는 사이 계정이 바뀌었으면 늦은 사건을 넘기지 않는다
    return result


@router.post("/turns/{turn_id}/cancel")
async def cancel_turn(turn_id: UUID, panel=Depends(_panel)):
    _, identity = panel
    async with _turn_lock(identity):  # 시작이 실행 정보를 등록할 때까지 기다린다
        status = await asyncio.to_thread(service.cancel, identity, str(turn_id))
    if status == "missing":
        raise HTTPException(404, "차례를 찾을 수 없습니다.")
    return {"status": status}


def _panel_client(ctx, identity: Identity, client_id: str) -> dict | None:
    """이 신원·허브의 살아 있는 칸 연결이면 그 행, 아니면 None."""
    client = mcp_store.client_by_id(client_id)
    if (not client or client["revoked_at"] or client["name"] != mcp_v2.PANEL_CLIENT or client["hub_id"] != ctx.hub
            or client["account_email"] != identity.email):
        return None
    return client


async def _bound_plan(ctx, identity: Identity, plan_id: str) -> None:
    """허브가 MCP 응답에서 직접 묶어 둔 계획만 — 그 칸 연결(실행권 없는 패널 연결)을 ctx 에 싣는다."""
    binding = await asyncio.to_thread(chat_store.binding_for, identity.db_file(), plan_id)
    if not binding:
        raise HTTPException(404, "이 칸에서 만든 계획이 아닙니다.")
    client = await asyncio.to_thread(_panel_client, ctx, identity, binding["client_id"])
    if not client:
        raise HTTPException(403, "이 계획을 실행할 수 없습니다.")
    ctx.client = client
    await _still(ctx)


@router.post("/plans/{plan_id}/estimate")
async def estimate_plan(plan_id: UUID, panel=Depends(_panel)):
    """계획 카드의 견적(무료 조회 — 생성·실행하지 않는다)."""
    ctx, identity = panel
    await _bound_plan(ctx, identity, str(plan_id))
    return await mcp_v2._estimate_plan(ctx, str(plan_id))


@router.post("/plans/{plan_id}/execute")
async def execute_plan(plan_id: UUID, panel=Depends(_panel)):
    """사람이 칸의 [실행] 을 눌렀을 때 — 허브가 MCP 응답에서 직접 묶어 둔 계획만 그 칸 연결로 실행한다.
    응답에 계획 스냅샷(observed_at)을 싣는다 — 화면은 진행 사건과 같은 규칙으로만 넣는다(실패하면 없음, 제출 결과는 그대로)."""
    ctx, identity = panel
    await _bound_plan(ctx, identity, str(plan_id))
    plan = await mcp_v2.submit_plan(ctx, str(plan_id))
    snapshot = await mcp_v2.panel_snapshot(ctx, str(plan_id), service.turn_for_client(ctx.client["id"]))
    return {**plan, "snapshot": snapshot} if snapshot else plan
