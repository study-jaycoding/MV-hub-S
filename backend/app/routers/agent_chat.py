"""MV Agent 칸 HTTP 입구(설계 docs/status/AskAgent_옆칸_설계_2026-11-09.md 10절).

로컬 허브에서 CONTENT_HUB_AGENT_CHAT=1 일 때만 붙는다(main). 권한 = 로그인 신원(허브 id + DB 경로 + 계정) — 신원 판정은
MCP 와 같은 `mcp_v2._capture`(AUTH off 워커는 공유 서버 로그인까지 대조)·`_still_current` 를 쓴다. 칸 비밀값은 다른
웹페이지의 위조 요청을 막는 표일 뿐이다. 실행(유료)은 사람이 누른 [실행](여기) 또는 칸 연결의 AI 실행(`mcp_v2._panel_execute`
— 이 대화의 계획·도는 차례만, 앱 동작 도구 설계 A2)이 `mcp_v2.submit_plan` 을 부를 때만이다.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
import warnings
from typing import Annotated, Literal
from uuid import UUID, uuid4

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from PIL import Image
from pydantic import AfterValidator, Field, StrictBool, StrictInt, ValidationError, field_validator, model_validator

from .. import active_account, config
from ..deps import expected_account_differs
from ..emailnorm import norm_email
from ..mcp_models import StrictModel
from ..repo import agent_chat as chat_store
from ..repo import mcp_v2 as mcp_store
from ..services import agent_chat as chat
from ..services import agent_chat_claude as claude
from ..services import agent_chat_codex as codex
from ..services import agent_chat_codex_login as codex_login
from ..services import agent_chat_install as installer
from ..services.agent_chat import EFFORTS, MODELS, Identity, service
from ..services.async_tools import to_thread_non_abandon
from ..services.request_guards import require_loopback_browser_request
from . import _proxy, mcp, mcp_v2

router = APIRouter(prefix="/api/agent-chat", tags=["agent-chat"])
_log = logging.getLogger(__name__)
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
    async with chat.request_scope():
        secret_identity = service.session_identity(request.headers.get(_PANEL))
        if secret_identity is None:  # 표 없는 요청에 공유 서버 확인을 쓰지 않는다.
            require_loopback_browser_request(request, "MV Agent 칸은 이 PC 의 앱에서만 쓸 수 있습니다.")
            raise HTTPException(401, "칸 연결이 끝났습니다. 다시 여세요.", headers=_SESSION_GONE)
        try:
            ctx, identity = await _captured(request)
        except HTTPException:
            chat_store.check_current(secret_identity.file_path())
            raise
        if identity != secret_identity:
            raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED)
        chat_store.check_current(identity.file_path())
        with active_account.pinned_account_scope(ctx.pin), _proxy.pinned_connection(ctx.upstream):
            yield ctx, identity


async def _still(ctx) -> None:
    chat_store.check_current(_identity(ctx).file_path())
    try:
        await asyncio.to_thread(mcp_v2._still_current, ctx)
    except chat_store.StaleRequest:
        raise
    except HTTPException as exc:
        raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED) from exc


@router.post("/session")
async def session(request: Request):
    async with chat.request_scope():
        ctx, identity = await _captured(request)
        engines = await asyncio.to_thread(service.engines)
        chat_store.check_current(identity.file_path())
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
            "install": row.get("install"),  # 실행기의 공식 설치 — running·failed·skipped·없음(설치 설계 2-v3-1b)
            "engines": engines}


_CLAUDE_ERROR = "X-MVHub-Claude-Error"


@router.get("/claude/version")
async def claude_version(panel=Depends(_panel)):
    """서랍 아래 줄 — 지금 판(엔진 캐시, exe 를 새로 띄우지 않음)·npm 최신 판·새 판 여부(docs/status/MVAgent_서랍아래줄_2026-11-10.md)."""
    engines = await asyncio.to_thread(service.engines)
    row = next((item for item in engines if item["id"] == "claude"), {})
    current = row.get("version") or None
    latest = await asyncio.to_thread(claude.latest_version)
    strict = re.compile(r"\d+\.\d+\.\d+")
    newer = bool(current and latest and strict.fullmatch(current) and tuple(map(int, latest.split("."))) > tuple(map(int, current.split("."))))
    # 설치 방식은 판과 같은 실행 파일로 센 값(official·npm·other·none) — 보장 문구 없이 방식만(설치 설계 2-v3-2)
    return {"current": current, "latest": latest, "newer": newer, "method": row.get("method", "none")}


@router.post("/claude/login")
async def claude_login(panel=Depends(_panel)):
    """[Claude 연결] — 사람이 보는 로그인 창(스위치가 켜졌을 때만). 창은 사람의 것이라 끄는 경로는 없다."""
    ctx, _ = panel
    try:
        await asyncio.to_thread(claude.open_login_window, lambda: mcp_v2._still_current(ctx))
    except claude.LoginDisabled as exc:
        raise HTTPException(409, "이 PC 에서는 터미널에서 로그인해 주세요.", headers={_CLAUDE_ERROR: "login_window_disabled"}) from exc
    except claude.LoginUnsupported as exc:
        detail = {
            "elevated": "관리자 권한으로 켠 MV Hub 라 버튼 연결을 쓸 수 없어요",
            "service": "이 Windows 로그인에서는 버튼 연결을 쓸 수 없어요",
            "other_user": "다른 Windows 사용자로 켠 MV Hub 라 버튼 연결을 쓸 수 없어요",
        }.get(exc.reason, "권한을 확인하지 못해 버튼 연결을 쓸 수 없어요")
        raise HTTPException(409, detail, headers={_CLAUDE_ERROR: "login_window_unsupported"}) from exc
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


class InstallRequest(StrictModel):
    pass  # 명령·URL·경로를 받지 않는다.


@router.post("/{engine}/install")
async def install_engine(engine: Literal["claude", "codex"], body: InstallRequest | None = None, panel=Depends(_panel)):
    ctx, _ = panel

    def submit():
        if engine == "codex":
            with codex._lock("codex_enabled.lock", wait=True):
                result = installer.request(engine, lambda: mcp_v2._still_current(ctx))
                if result is None:
                    raise installer.RequestBusy("설치 요청 상태를 확인하지 못했어요. 잠시 뒤 다시 해 주세요")
                if result.get("id") and (codex._read("codex_chain.json") or {}).get("id") != result["id"]:
                    codex.start_chain(result["id"])
                return result
        return installer.request(engine, lambda: mcp_v2._still_current(ctx))

    try:
        return await asyncio.to_thread(submit)
    except codex.Busy as exc:
        raise HTTPException(409, "연결 상태를 확인하는 중이에요. 잠시 뒤 다시 해 주세요") from exc
    except installer.RequestBusy as exc:
        raise HTTPException(503, "설치 요청 상태를 확인하지 못했어요. 잠시 뒤 다시 해 주세요") from exc
    except OSError as exc:
        raise HTTPException(503, "설치 요청을 저장하지 못했어요") from exc


@router.get("/{engine}/install")
async def install_status(engine: Literal["claude", "codex"], panel=Depends(_panel)):
    return {"install": await asyncio.to_thread(installer.verified_status, engine),
            "blocked": await asyncio.to_thread(installer.eligibility)}


class CodexLoginRequest(StrictModel):
    reconnect: StrictBool = False


@router.post("/codex/login")
async def open_codex_login(body: CodexLoginRequest | None = None,
                           chain_id: str | None = Query(None, pattern=r"^[a-f0-9]{32}$"), panel=Depends(_panel)):
    ctx, _ = panel
    try:
        return await asyncio.to_thread(codex_login.open_login_window, lambda: mcp_v2._still_current(ctx), chain_id,
                                       body.reconnect if body else False)
    except claude.RecordUnreadable as exc:
        raise HTTPException(409, "로그인 창 상태를 확인하지 못했어요. 잠시 뒤 다시 해 주세요") from exc
    except codex.CodexError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "로그인 창을 열지 못했어요") from exc


@router.get("/codex/login")
async def codex_login_status(chain_id: str = Query(pattern=r"^[a-f0-9]{32}$"), panel=Depends(_panel)):
    try:
        return await asyncio.to_thread(codex_login.status, chain_id)
    except (codex.CodexError, claude.RecordUnreadable) as exc:
        raise HTTPException(409, "로그인 창 상태를 확인하지 못했어요") from exc
    except OSError as exc:
        raise HTTPException(503, "로그인 창 상태를 읽지 못했어요. 잠시 뒤 다시 해 주세요") from exc


@router.post("/codex/enable")
async def codex_enable(chain_id: str | None = Query(None, pattern=r"^[a-f0-9]{32}$"), panel=Depends(_panel)):
    """이 PC에서 Codex 연결 점검을 통과한 뒤 활성화한다(MV 생성 없음)."""
    ctx, _ = panel
    try:
        with anyio.CancelScope(shield=True):
            if chain_id is None:
                await to_thread_non_abandon(codex.enable, MODELS["codex"][0]["id"], lambda: mcp_v2._still_current(ctx))
            else:
                await to_thread_non_abandon(codex.enable, MODELS["codex"][0]["id"], lambda: mcp_v2._still_current(ctx), chain_id)
    except codex.CodexError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "Codex 연결 표식을 저장하지 못했어요") from exc
    finally:
        engines = await asyncio.to_thread(service.engines, True)
    return {"engines": engines}


@router.post("/codex/disable")
async def codex_disable(panel=Depends(_panel)):
    """이 PC의 다음 Codex 차례를 막고 진행 중 점검의 활성화 token을 취소한다."""
    try:
        with anyio.CancelScope(shield=True):
            await to_thread_non_abandon(codex.disable)
    except codex.Busy as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "Codex 연결 표식을 지우지 못했어요") from exc
    finally:
        engines = await asyncio.to_thread(service.engines, True)
    return {"engines": engines}


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
    async with _turn_lock(identity):  # 새 차례 시작도 이 잠금 안 — 확인과 지우기 사이에 가르기가 시작되지 않는다
        source = await asyncio.to_thread(chat_store.get_conversation, identity.db_file(), str(conversation_id))
        if source:
            chat_store.require_app_idle(source)
        if source and service.forking_from(source["cli_session_id"]):
            raise HTTPException(409, "포크한 대화가 이 대화에서 가르는 중이에요. 끝난 뒤 지워 주세요.")
        try:
            row = await asyncio.to_thread(chat_store.delete_conversation, identity.db_file(), str(conversation_id))
        except chat_store.Busy as exc:
            raise HTTPException(409, "이 대화는 아직 일하는 중이에요. 끝난 뒤 지워 주세요.") from exc
    if row is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    if row.get("restored_from") or not row["cli_session_id"]:
        session_file = "none"
    elif row["engine"] != "claude":
        session_file = "codex_kept"
    else:
        session_file = await asyncio.to_thread(claude.delete_session_record, row["cli_session_id"], row["cli_home"], row["cli_cwd"])
    try:
        if not row.get("restored_from"):
            (config.AGENT_CHAT_DIR / "mcp" / f"{conversation_id}.json").unlink(missing_ok=True)
    except OSError:
        pass  # 칸 폴더의 설정 파일 — 남아도 다시 쓰이지 않는다(대화가 없다)
    return {"deleted": True, "session_file": session_file}


class ForkIn(StrictModel):
    request_id: UUID  # 응답을 잃고 다시 눌러도 같은 포크(설계 2-1)


class ClaudeAppOpen(StrictModel):
    request_id: UUID
    expected_revision: Annotated[StrictInt, Field(ge=0)]
    handoff_id: UUID | None = None


class ClaudeAppBringBack(StrictModel):
    request_id: UUID
    expected_revision: Annotated[StrictInt, Field(ge=0)]
    handoff_id: UUID
    unlock_only: StrictBool = False


async def _claude_app(conversation_id, body, panel, action):
    ctx, identity = panel
    async with _turn_lock(identity):
        try:
            with anyio.CancelScope(shield=True):
                return await to_thread_non_abandon(service.claude_app, identity, str(conversation_id), body.model_dump(mode="json"),
                                                   action, lambda: mcp_v2._still_current(ctx))
        except chat.transcript.TranscriptError as exc:
            raise HTTPException(413 if exc.code == "too_large" else 409, exc.code) from exc
        except claude.Busy as exc:
            raise HTTPException(409, exc.code) from exc
        except OSError as exc:
            raise HTTPException(503, "claude_app_failed") from exc


@router.post("/conversations/{conversation_id}/claude-app/open")
async def open_claude_app(conversation_id: UUID, body: ClaudeAppOpen, panel=Depends(_panel)):
    return await _claude_app(conversation_id, body, panel, "open")


@router.post("/conversations/{conversation_id}/claude-app/bring-back")
async def bring_back_claude_app(conversation_id: UUID, body: ClaudeAppBringBack, panel=Depends(_panel)):
    return await _claude_app(conversation_id, body, panel, "bring-back")


_FORK_REFUSED = {"codex": (409, "Codex 대화는 포크할 수 없어요."),
                 "no_session": (409, "이어 갈 세션이 없어 포크할 수 없어요 · 먼저 한 번 대화해 주세요."),
                 "too_long": (413, "대화가 너무 길어 포크할 수 없어요."),
                 "request_mismatch": (409, "다른 대화에 쓴 포크 요청이에요 · 다시 눌러 주세요.")}


def _fork_error(exc: Exception) -> HTTPException:
    if isinstance(exc, chat_store.ForkRefused):
        status, message = _FORK_REFUSED.get(exc.args[0] if exc.args else "", (409, "포크할 수 없어요."))
        return HTTPException(status, message)
    if isinstance(exc, chat_store.Busy):
        return HTTPException(409, "답을 받는 중에는 포크할 수 없어요.")
    return HTTPException(404, "대화를 찾을 수 없습니다.")


@router.post("/conversations/{conversation_id}/fork")
async def fork_conversation(conversation_id: UUID, body: ForkIn, request: Request, panel=Depends(_panel)):
    """포크(docs/status/MVAgent_포크_2026-11-12.md 2-1) — 신원 차례 잠금 안에서 같은 요청 번호 조회 → 확인 → 새 칸 연결 발급 →
    한 거래 복사. 복사는 버리지 않는 작업 스레드로 하고, 실패하면 커밋됐는지(같은 요청 번호 조회)로 연결 회수 여부를 정한다."""
    ctx, identity = panel
    source, request_id = str(conversation_id), str(body.request_id)
    async with _turn_lock(identity):
        path = await asyncio.to_thread(identity.db_file)
        found = await asyncio.to_thread(chat_store.find_fork, path, request_id)  # 원래 존재·바쁨보다 먼저(Codex 2차 P2)
        if found:
            if found["fork_from"] != source:
                raise _fork_error(chat_store.ForkRefused("request_mismatch"))
            return {"conversation": await asyncio.to_thread(chat_store.conversation_summary, path, found["id"])}
        try:
            await asyncio.to_thread(chat_store.fork_precheck, path, source)
        except (chat_store.ForkRefused, chat_store.Busy, LookupError) as exc:
            raise _fork_error(exc) from exc
        setup = await mcp.setup(request, identity=None)

        def work():
            with service.issuance(identity):
                return issue_and_fork()

        def issue_and_fork():
            # 발급·복사·회수를 한 작업 스레드에서 — 요청이 발급 중에 취소돼도 이 스레드가 끝까지 정리한다(포크 독립 리뷰 P2)
            client_id, entry = mcp_v2.issue_panel_client(ctx, setup)
            try:
                return chat_store.fork_conversation(path, source, request_id=request_id, client_id=client_id, mcp_entry=entry,
                                                    still_current=lambda: mcp_v2._still_current(ctx))
            except BaseException:
                # 커밋 여부는 반환값이 아니라 같은 요청 번호로 본다(Codex 3차 P2)
                made = chat_store.find_fork(path, request_id)
                if not made or made.get("fork_from") != source:
                    mcp_store.revoke(client_id, ctx.owner, norm_email(ctx.account["email"]))
                raise

        try:
            # anyio 취소(미들웨어 작업 묶음)는 await 마다 다시 와서 to_thread_non_abandon 의 기다림이 헛돌며 작업 스레드를 굶긴다(실측 2분)
            #  — 막아 두고 작업이 끝난 뒤 바깥 취소를 그대로 받는다
            with anyio.CancelScope(shield=True):
                summary = await to_thread_non_abandon(work)
        except ValueError as exc:
            raise HTTPException(503, mcp_v2._setup_error_message(exc)) from exc
        except HTTPException as exc:  # 발급·커밋 직전 신원 확인
            if isinstance(exc, chat_store.StaleRequest) or (exc.status_code == 409 and exc.detail == "in_claude_app"):
                raise
            raise HTTPException(403, "앱의 계정이나 허브가 바뀌었습니다.", headers=_ACCOUNT_CHANGED) from exc
        except (chat_store.ForkRefused, chat_store.Busy, LookupError) as exc:
            raise _fork_error(exc) from exc
    await _still(ctx)
    return {"conversation": summary}


@router.get("/conversations/{conversation_id}")
async def conversation(conversation_id: UUID, panel=Depends(_panel)):
    ctx, identity = panel

    def load():
        # 대화(읽지 않음 포함)·차례·사건을 한 읽기 시점에서(서랍 메뉴 독립 리뷰 P2)
        found = chat_store.restore_snapshot(identity.db_file(), str(conversation_id), chat.EVENT_PAGE)
        if not found:
            return None
        public = {key: found[key] for key in ("id", "title", "engine", "model", "effort", "updated_at", "resumable",
                                              "can_fork", "fork_block", "fork_state", "restored_from")}
        public.update({key: bool(found.get(key)) for key in ("pinned", "archived", "unread")}, unread_rev=found.get("unread_rev") or 0)
        public.update(chat_store.app_fields(found))
        if public["app_handoff"]:
            public.update(can_fork=False, fork_block="in_claude_app")
        return {"conversation": public, "turns": found["turns"]}

    result = await asyncio.to_thread(load)  # 사건을 먼저 읽고 그다음 스냅샷 — 복원 스냅샷이 함께 돌려준 사건보다 새롭다(설계 A2-5)
    if result is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    if result["conversation"]["restored_from"]:
        result["plans"] = []
        result["restore_reference"] = await asyncio.to_thread(chat.restored_reference, identity.file_path(), str(conversation_id))
        result["references"] = await asyncio.to_thread(_restored_references, identity, str(conversation_id))
    else:
        result["plans"] = await _plan_snapshots(ctx, identity, str(conversation_id))
    await _still(ctx)  # 읽는 사이 계정이 바뀌었으면 넘기지 않는다
    return result


def _restored_references(identity, conversation_id):
    with chat_store.connect_readonly(identity.file_path()):
        bindings = chat_store.bindings_for_conversation(identity.file_path(), conversation_id, limit=100)
        out = []
        for index, binding in enumerate(bindings):
            row = {"plan_id": binding["plan_id"], "status": "unchecked", "generations": []}
            if index < 20:
                try:
                    row = mcp_store.restored_reference(identity.email, binding["client_id"], binding["plan_id"])
                except Exception:  # 확인 실패는 '없음'으로 바꾸지 않는다.
                    pass
            out.append(row)
        return out


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
    source_conversation_id: UUID | None = None
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
    # 화면 동작의 실행 창 번호(옆 칸 마운트마다 새로) — 허브 메모리의 그 차례에만 고정, 기록·사건에 안 남긴다(화면 동작 설계 3-1)
    screen_tab: UUID | None = None

    @model_validator(mode="after")
    def _check_attachments(self):
        if self.source_conversation_id and self.conversation_id:
            raise ValueError("참고 기록은 새 대화에서만 지정하세요")
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


class ClaimIn(StrictModel):
    screen_tab: UUID


class ActionResultIn(StrictModel):
    token: str = Field(min_length=16, max_length=100)
    ok: StrictBool
    summary: str = Field(max_length=300)
    data: dict = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def _small(cls, value):
        if len(json.dumps(value, ensure_ascii=False)) > 4096:
            raise ValueError("결과 자료가 너무 큽니다")
        return value


_ACTION_ID = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]


@router.post("/turns/{turn_id}/actions/{action_id}/claim")
async def claim_action(turn_id: UUID, action_id: _ACTION_ID, body: ClaimIn, panel=Depends(_panel)):
    """화면 동작 실행 표 — 그 차례를 시작한 칸 마운트(screen_tab)만, 처음 한 번(docs/status/MVAgent_화면동작_2026-11-12.md 3-2)."""
    _, identity = panel
    try:
        token = await asyncio.to_thread(service.claim_action, identity, str(turn_id), action_id, str(body.screen_tab))
    except LookupError as exc:
        raise HTTPException(404, "그 화면 동작을 찾을 수 없어요.") from exc
    except PermissionError as exc:
        raise HTTPException(403, "이 칸이 시작한 차례가 아니에요.") from exc
    except chat.ActionClosed as exc:
        raise HTTPException(409, "이미 처리됐거나 기한이 지난 화면 동작이에요.") from exc
    return {"token": token}


@router.post("/turns/{turn_id}/actions/{action_id}/result")
async def action_result(turn_id: UUID, action_id: _ACTION_ID, body: ActionResultIn, panel=Depends(_panel)):
    """실행한 칸의 결과 — 기한 안·차례가 살아 있을 때만 받는다(아니면 accepted=false, 칸 카드는 칸이 이미 그렸다)."""
    _, identity = panel
    accepted = await asyncio.to_thread(service.finish_action, identity, str(turn_id), action_id, body.token, body.ok,
                                       body.summary, body.data)
    return {"accepted": accepted}


def _checked_images(images, attachments) -> list[tuple[int, str, bytes]]:
    formats = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP", "image/gif": "GIF"}
    checked, seen, total = [], set(), 0
    number = 1
    try:
        if not isinstance(images, list) or len(images) > 8:
            raise ValueError
        for number, item in enumerate(images, 1):
            if not isinstance(item, dict) or set(item) != {"index", "media_type", "data"}:
                raise ValueError
            index, media, data = item["index"], item["media_type"], item["data"]
            if type(index) is int and 0 <= index <= 7:
                number = index + 1
            if (type(index) is not int or not 0 <= index < len(attachments) or index in seen
                    or attachments[index].kind == "folder" or not isinstance(media, str) or media not in formats
                    or not isinstance(data, str) or len(data) > 2_000_004):
                raise ValueError
            raw = base64.b64decode(data, validate=True)
            total += len(raw)
            if not raw or len(raw) > 1_500_000 or total > 6_000_000:
                raise ValueError
            signatures = {"image/jpeg": raw.startswith(b"\xff\xd8\xff"),
                          "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
                          "image/gif": raw.startswith((b"GIF87a", b"GIF89a")),
                          "image/webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"}
            if not signatures[media]:
                raise ValueError
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    image.verify()
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format != formats[media] or not all(0 < side <= 2048 for side in image.size):
                        raise ValueError
                    image.load()  # 크기를 본 뒤 픽셀까지 풀어 본다 — verify() 는 압축된 픽셀 손상을 못 잡는다(독립 리뷰 2)
            seen.add(index)
            checked.append((index, media, raw))
    except Exception:
        # 입력·Pillow 예외의 원문에는 그림이 섞일 수 있어 되돌리지 않는다.
        raise HTTPException(422, f"{number}번 그림을 보낼 수 없어요") from None
    return checked


async def _read_turn(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 8_400_000:
            raise HTTPException(413, "보내는 자료가 너무 큽니다.")
        raw.extend(chunk)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(422, [{"loc": ["body"], "msg": "JSON을 읽을 수 없습니다", "type": "json_invalid"}]) from None
    images = data.pop("images", []) if isinstance(data, dict) else []
    try:
        body = TurnIn.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, [{"loc": ["body", *error["loc"]], "msg": error["msg"], "type": error["type"]}
                                  for error in exc.errors(include_input=False, include_context=False)]) from None
    return body, await asyncio.to_thread(_checked_images, images, body.attachments)


@router.post("/turns")
async def start_turn(request: Request, panel=Depends(_panel)):
    ctx, identity = panel
    body, images = await _read_turn(request)
    if body.model not in {row["id"] for row in MODELS[body.engine]}:
        raise HTTPException(422, "모델을 다시 고르세요.")
    if body.effort not in EFFORTS[body.engine]:
        raise HTTPException(422, "생각 깊이를 다시 고르세요.")
    if body.fast and (body.engine != "claude" or body.model not in claude.FAST_MODELS):
        raise HTTPException(422, "빠른 모드는 Opus 5.5 에서만 쓸 수 있어요.")
    if len(json.dumps(body.context, ensure_ascii=False)) > _MAX_CONTEXT:
        raise HTTPException(422, "화면 정보가 너무 큽니다.")
    async with _turn_lock(identity):
        return await _start_turn_locked(body, request, ctx, identity, images)


async def _start_turn_locked(body: TurnIn, request: Request, ctx, identity: Identity, images=()) -> dict:
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
        chat_store.require_app_idle(conv)
        if conv.get("restored_from"):
            raise HTTPException(409, "복원한 기록은 읽기 전용입니다. 새 대화로 시작하세요.")
        if conv["engine"] != body.engine:
            raise HTTPException(409, "엔진을 바꾸면 새 대화로 시작하세요.")
        if not conv["resumable"]:
            raise HTTPException(409, "이 대화는 이어 갈 수 없어요 · 새 대화로 시작하세요.")
        # 아직 갈라지지 않은 포크 — 원래가 누른 때 그대로일 때만(포크 설계 2-2, 요약의 fork_state 와 같은 판정)
        state = await asyncio.to_thread(chat_store.fork_state_for, path, conv["id"])
        if state == "source_changed":
            raise HTTPException(409, "원래 대화가 포크한 뒤 이어져서 그 시점으로 가를 수 없어요 · 다시 포크하세요.")
        if state == "source_gone":
            raise HTTPException(409, "원래 대화가 지워져 이 포크를 이어 갈 수 없어요 · 지우고 다시 포크하세요.")
    else:
        conv = None
    reference = (await asyncio.to_thread(chat.restored_reference, path, str(body.source_conversation_id))
                 if body.source_conversation_id else None)
    setup = await mcp.setup(request, identity=None) if conv is None else None

    def work():
        with service.issuance(identity):
            current = conv
            cid = current["id"] if current is not None else str(uuid4())
            client_id = None
            try:
                new_conversation = None
                if current is None:
                    client_id, entry = mcp_v2.issue_panel_client(ctx, setup)
                    mcp_v2._still_current(ctx)
                    new_conversation = dict(engine=body.engine, model=body.model, effort=body.effort, client_id=client_id,
                                            mcp_entry=entry, title=" ".join(body.text.split())[:40], source_reference=reference)
                turn, created = chat_store.claim_turn(
                    path, conversation_id=cid, idempotency_key=body.idempotency_key, text=body.text, context=body.context,
                    attachments=body.stored_attachments(), new_conversation=new_conversation)
                if current is None:
                    if not created:
                        mcp_store.revoke(client_id, ctx.owner, norm_email(ctx.account["email"]))
                    current = chat_store.get_conversation(path, turn["conversation_id"])
            except BaseException:
                if client_id is not None:
                    try:
                        # 커밋 뒤 조회만 실패했으면 같은 요청으로 회수할 차례와 발급을 보존한다.
                        made = chat_store.turn_by_key(path, body.idempotency_key)
                        if not made or made["conversation_id"] != cid:
                            mcp_store.revoke(client_id, ctx.owner, norm_email(ctx.account["email"]))
                    except Exception:
                        _log.error("Agent first-turn credential cleanup could not be confirmed")
                raise
            if created:
                chat_store.update_conversation(path, current["id"], model=body.model, effort=body.effort)
                try:
                    service.start_turn(identity, conversation=current, turn=turn, model=body.model, effort=body.effort,
                                       text=body.text, context=body.context, still_current=lambda: mcp_v2._still_current(ctx),
                                       fast=body.fast, attachments=body.stored_attachments(), gen_model=body.gen_model,
                                       screen_tab=str(body.screen_tab) if body.screen_tab else None, images=images)
                except chat_store.StaleRequest:
                    raise
                except Exception as exc:
                    chat_store.finish_turn(path, turn["id"], "failed", reason="start_failed", error="AI 프로그램을 시작하지 못했습니다.")
                    raise HTTPException(503, "AI 프로그램을 시작하지 못했습니다.") from exc
            return {"turn_id": turn["id"], "conversation_id": turn["conversation_id"], "status": turn["status"]}

    try:
        with anyio.CancelScope(shield=True):
            return await to_thread_non_abandon(work)
    except ValueError as exc:
        raise HTTPException(503, mcp_v2._setup_error_message(exc)) from exc
    except chat_store.Busy as exc:
        raise HTTPException(409, "앞 차례가 아직 진행 중입니다.") from exc
    except LookupError as exc:
        raise HTTPException(404, "대화를 찾을 수 없습니다.") from exc


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


class PlanActIn(StrictModel):
    conversation_id: UUID  # 화면이 지금 보는 대화 — 묶음의 대화와 같아야 한다(포크 설계 2-1, 없거나 null 이면 422)


async def _bound_plan(ctx, identity: Identity, plan_id: str, conversation_id: str) -> None:
    """허브가 MCP 응답에서 직접 묶어 둔 계획만, 그리고 그 계획을 만든 대화에서만 — 그 칸 연결(실행권 없는 패널 연결)을 ctx 에 싣는다."""
    conversation = await asyncio.to_thread(chat_store.get_conversation, identity.db_file(), conversation_id)
    if conversation and conversation.get("restored_from"):
        raise HTTPException(409, "복원한 기록의 계획은 실행하거나 견적을 조회할 수 없습니다.")
    binding = await asyncio.to_thread(chat_store.binding_for, identity.db_file(), plan_id)
    if not binding or binding["conversation_id"] != conversation_id:  # 포크한 대화의 옛 계획 카드로 원래 계획을 실행하지 않게
        raise HTTPException(404, "이 칸에서 만든 계획이 아닙니다.")
    client = await asyncio.to_thread(_panel_client, ctx, identity, binding["client_id"])
    if not client:
        raise HTTPException(403, "이 계획을 실행할 수 없습니다.")
    ctx.client = client
    await _still(ctx)


@router.post("/plans/{plan_id}/estimate")
async def estimate_plan(plan_id: UUID, body: PlanActIn, panel=Depends(_panel)):
    """계획 카드의 견적(무료 조회 — 생성·실행하지 않는다)."""
    ctx, identity = panel
    await _bound_plan(ctx, identity, str(plan_id), str(body.conversation_id))
    return await mcp_v2._estimate_plan(ctx, str(plan_id))


@router.post("/plans/{plan_id}/execute")
async def execute_plan(plan_id: UUID, body: PlanActIn, panel=Depends(_panel)):
    """사람이 칸의 [실행] 을 눌렀을 때 — 허브가 MCP 응답에서 직접 묶어 둔 계획만, 그 계획을 만든 대화에서만 그 칸 연결로 실행한다.
    응답에 계획 스냅샷(observed_at)을 싣는다 — 화면은 진행 사건과 같은 규칙으로만 넣는다(실패하면 없음, 제출 결과는 그대로)."""
    ctx, identity = panel
    await _bound_plan(ctx, identity, str(plan_id), str(body.conversation_id))
    plan = await mcp_v2.submit_plan(ctx, str(plan_id))
    snapshot = await mcp_v2.panel_snapshot(ctx, str(plan_id), service.turn_for_client(ctx.client["id"]))
    return {**plan, "snapshot": snapshot} if snapshot else plan
