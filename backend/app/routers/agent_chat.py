"""MV Agent 칸 HTTP 입구(설계 docs/status/AskAgent_옆칸_설계_2026-11-09.md 10절).

로컬 허브에서 CONTENT_HUB_AGENT_CHAT=1 일 때만 붙는다(main). 권한 = 로그인 신원(허브 id + DB 경로 + 계정) — 신원 판정은
MCP 와 같은 `mcp_v2._capture`(AUTH off 워커는 공유 서버 로그인까지 대조)·`_still_current` 를 쓴다. 칸 비밀값은 다른
웹페이지의 위조 요청을 막는 표일 뿐이다. 실행(유료)은 사람이 누른 [실행](여기) 또는 칸 연결의 AI 실행(`mcp_v2._panel_execute`
— 이 대화의 계획·도는 차례만, 앱 동작 도구 설계 A2)이 `mcp_v2.submit_plan` 을 부를 때만이다.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import AfterValidator, Field, StrictBool, StrictInt, field_validator, model_validator

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


@router.get("/claude/version")
async def claude_version(panel=Depends(_panel)):
    """서랍 아래 줄 — 지금 판(엔진 캐시, exe 를 새로 띄우지 않음)·npm 최신 판·새 판 여부(docs/status/MVAgent_서랍아래줄_2026-11-10.md)."""
    engines = await asyncio.to_thread(service.engines)
    current = next((item["version"] for item in engines if item["id"] == "claude"), "") or None
    latest = await asyncio.to_thread(claude.latest_version)
    strict = re.compile(r"\d+\.\d+\.\d+")
    newer = bool(current and latest and strict.fullmatch(current) and tuple(map(int, latest.split("."))) > tuple(map(int, current.split("."))))
    return {"current": current, "latest": latest, "newer": newer}


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


_LIST_LIMIT = 500  # 서랍 메뉴(설계 docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-2) — 넘치면 truncated, 화면이 "최근 500개만"


@router.get("/conversations")
async def conversations(panel=Depends(_panel)):
    _, identity = panel
    rows = await asyncio.to_thread(chat_store.list_conversations, identity.db_file(), _LIST_LIMIT + 1)
    return {"conversations": rows[:_LIST_LIMIT], "truncated": len(rows) > _LIST_LIMIT}


class ConversationPatch(StrictModel):
    """준 필드만 바꾼다(updated_at 은 그대로). title 1~80자 · 참거짓은 진짜 참거짓만 · seen_rev 는 unread:false 와 함께만 ·
    project 문자열 = 그 프로젝트, null = 프로젝트 없음, 생략 = 그대로."""
    title: str | None = None
    pinned: StrictBool | None = None
    archived: StrictBool | None = None
    unread: StrictBool | None = None
    seen_rev: StrictInt | None = Field(default=None, ge=0)
    project: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def check(self):
        given = self.model_fields_set
        if not given:
            raise ValueError("바꿀 것을 지정하세요")
        for name in ("title", "pinned", "archived", "unread", "seen_rev"):
            if name in given and getattr(self, name) is None:
                raise ValueError(f"{name} 는 null 일 수 없습니다")
        if "title" in given and not 1 <= len(self.title.strip()) <= 80:
            raise ValueError("이름은 1~80자")
        if "seen_rev" in given and self.unread is not False:
            raise ValueError("seen_rev 는 unread:false 와 함께만")
        if self.project is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in self.project):
            raise ValueError("프로젝트 값이 올바르지 않습니다")
        return self


@router.patch("/conversations/{conversation_id}")
async def patch_conversation(conversation_id: UUID, body: ConversationPatch, panel=Depends(_panel)):
    _, identity = panel
    given = body.model_fields_set
    fields = {name: getattr(body, name) for name in ("pinned", "archived", "unread") if name in given}
    if "title" in given:
        fields["title"] = body.title.strip()
    if "project" in given:
        fields["project_override"] = body.project if body.project is not None else ""
    row = await asyncio.to_thread(chat_store.patch_conversation, identity.db_file(), str(conversation_id), fields,
                                  body.seen_rev if "seen_rev" in given else None)
    if row is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return {"conversation": row}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: UUID, panel=Depends(_panel)):
    """대화 지우기(되돌릴 수 없음) — 신원 차례 잠금 안에서 한 트랜잭션으로 기록을 지우고, 커밋 뒤 그 대화의 Claude 세션 파일
    (확인된 한 개만)·칸 MCP 설정 파일을 지운다. session_file 로 결과를 알린다(설계 2-5). 만든 그림·계획은 그대로."""
    _, identity = panel
    async with _turn_lock(identity):
        try:
            row = await asyncio.to_thread(chat_store.delete_conversation, identity.db_file(), str(conversation_id))
        except chat_store.Busy as exc:
            raise HTTPException(409, "이 대화는 아직 일하는 중이에요. 끝난 뒤 지워 주세요.") from exc
    if row is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    if not row["cli_session_id"]:
        session_file = "none"
    elif row["engine"] != "claude":
        session_file = "codex_kept"
    else:
        session_file = await asyncio.to_thread(claude.delete_session_record, row["cli_session_id"], row["cli_home"], row["cli_cwd"])
    try:
        (config.AGENT_CHAT_DIR / "mcp" / f"{conversation_id}.json").unlink(missing_ok=True)
    except OSError:
        pass  # 칸 폴더의 설정 파일 — 남아도 다시 쓰이지 않는다(대화가 없다)
    return {"deleted": True, "session_file": session_file}


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: UUID, panel=Depends(_panel)):
    ctx, identity = panel

    def load():
        # 대화(읽지 않음 포함)·차례·사건을 한 읽기 시점에서(서랍 메뉴 독립 리뷰 P2)
        found = chat_store.restore_snapshot(identity.db_file(), str(conversation_id), chat.EVENT_PAGE)
        if not found:
            return None
        public = {key: found[key] for key in ("id", "title", "engine", "model", "effort", "updated_at", "resumable")}
        public.update({key: bool(found.get(key)) for key in ("pinned", "archived", "unread")}, unread_rev=found.get("unread_rev") or 0)
        return {"conversation": public, "turns": found["turns"]}

    result = await asyncio.to_thread(load)  # 사건을 먼저 읽고 그다음 스냅샷 — 복원 스냅샷이 함께 돌려준 사건보다 새롭다(설계 A2-5)
    if result is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    result["plans"] = await _plan_snapshots(ctx, identity, str(conversation_id))
    await _still(ctx)  # 읽는 사이 계정이 바뀌었으면 넘기지 않는다
    return result


_RESTORE_SECONDS = 15.0


async def _plan_snapshots(ctx, identity: Identity, conversation_id: str) -> list[dict]:
    """대화 복원 보정 — 이 대화에 묶인 계획(최근 20개)의 지금 상태. 전체 15초 예산은 바인딩·연결 조회까지 한 마감으로(독립 리뷰 P2),
    넘으면 그때까지 읽은 것만 — 못 읽은 계획은 뺀다(카드는 사건으로 복원한 그대로)."""
    out: list[dict] = []

    async def collect():
        bindings = await asyncio.to_thread(chat_store.bindings_for_conversation, identity.db_file(), conversation_id)
        for binding in bindings:
            client = await asyncio.to_thread(_panel_client, ctx, identity, binding["client_id"])
            if not client:
                continue
            ctx.client = client
            snapshot = await mcp_v2.panel_snapshot(ctx, binding["plan_id"], service.turn_for_client(client["id"]))
            if snapshot:
                out.append(snapshot)

    try:
        await asyncio.wait_for(collect(), _RESTORE_SECONDS)
    except asyncio.TimeoutError:
        pass
    return out


# ── 끌어다 넣기(설계 docs/status/MVAgent_끌어다넣기_2026-11-12.md 2-2) — 정확한 식별자만. 허브는 조회하지 않는다(AI 의 정확히 찾기가 확인) ──
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _no_control(value: str) -> str:
    if _CONTROL.search(value):
        raise ValueError("제어 글자를 쓸 수 없습니다")
    return value


def _ident(max_length: int):
    return Annotated[str, Field(min_length=1, max_length=max_length), AfterValidator(_no_control)]


class _AttachBase(StrictModel):
    name: str | None = None  # 화면 표시용 — 거절하지 않고 정리(줄바꿈 등 제어 글자 → 공백, 120자)

    @field_validator("name", mode="before")
    @classmethod
    def _clean_name(cls, value):
        if not isinstance(value, str):
            return value
        return _CONTROL.sub(" ", value).strip()[:120].strip() or None


class AttachGeneration(_AttachBase):
    kind: Literal["generation"]
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")


class AttachAsset(_AttachBase):
    kind: Literal["asset"]
    project: _ident(200)
    path: _ident(1000)


class AttachFolder(_AttachBase):
    kind: Literal["folder"]
    project_id: _ident(200)
    path: _ident(500)  # MCP read_context 의 folder_path 상한과 같게


class AttachWorkspace(StrictModel):
    scope: Literal["personal", "team"]
    id: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def _check(self):
        if (self.scope == "team") != (self.id is not None):
            raise ValueError("팀 공간은 id 가, 개인 공간은 id 없이")
        return self


def _attach_key(item) -> tuple:
    return (item.kind, getattr(item, "id", None), getattr(item, "project", None), getattr(item, "project_id", None), getattr(item, "path", None))


class TurnIn(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    conversation_id: UUID | None = None
    engine: Literal["claude", "codex"]
    model: str = Field(min_length=1, max_length=40)
    effort: Literal["low", "medium", "high", "xhigh", "max"]
    fast: bool = False  # 빠른 모드 — Opus 만, 매 차례 켬/끔을 CLI 에 적는다(Claude 추가 사용 크레딧)
    # 칸 설정 '먼저 쓸 생성 모델'(앱 모델 코드) — 프롬프트 한 줄로만 쓴다(docs/status/MVAgent_모델설정사용량_2026-11-12.md)
    gen_model: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.:-]+$")
    text: str = Field(min_length=1, max_length=8000)
    context: dict = Field(default_factory=dict)
    attachments: list[Annotated[AttachGeneration | AttachAsset | AttachFolder, Field(discriminator="kind")]] = Field(
        default_factory=list, max_length=8)
    attach_workspace: AttachWorkspace | None = None

    @model_validator(mode="after")
    def _check_attachments(self):
        if bool(self.attachments) != (self.attach_workspace is not None):
            raise ValueError("붙인 자료와 그 공간은 함께 보내세요")
        keys = [_attach_key(item) for item in self.attachments]
        if len(set(keys)) != len(keys):
            raise ValueError("같은 자료를 두 번 붙였습니다")
        screen = self.context.get("workspace")
        if self.attach_workspace and isinstance(screen, dict) and (
                screen.get("scope"), screen.get("id") or None) != (self.attach_workspace.scope, self.attach_workspace.id):
            raise ValueError("붙인 자료의 공간이 지금 화면과 다릅니다")
        return self

    def stored_attachments(self) -> dict | None:
        """저장·프롬프트에 쓰는 한 모양 — {"workspace": {scope, id}, "items": [...]}(핸들 없음)."""
        if not self.attachments:
            return None
        return {"workspace": self.attach_workspace.model_dump(),
                "items": [item.model_dump(exclude_none=True) for item in self.attachments]}


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
            path, conversation_id=conv["id"], idempotency_key=body.idempotency_key, text=body.text, context=body.context,
            attachments=body.stored_attachments()))
    except chat_store.Busy as exc:
        raise HTTPException(409, "앞 차례가 아직 진행 중입니다.") from exc
    except LookupError as exc:  # 사이에 지워진 대화(설계 2-5)
        raise HTTPException(404, "대화를 찾을 수 없습니다.") from exc
    if created:
        await asyncio.to_thread(chat_store.update_conversation, path, conv["id"], model=body.model, effort=body.effort)
        try:
            service.start_turn(identity, conversation=conv, turn=turn, model=body.model, effort=body.effort,
                               text=body.text, context=body.context, still_current=lambda: mcp_v2._still_current(ctx),
                               fast=body.fast, attachments=body.stored_attachments(), gen_model=body.gen_model)
        except Exception as exc:  # noqa: BLE001 - 실행 전 실패는 그 차례를 끝내고 알린다
            await asyncio.to_thread(lambda: chat_store.finish_turn(path, turn["id"], "failed", reason="start_failed",
                                                                   error="AI 프로그램을 시작하지 못했습니다."))
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
