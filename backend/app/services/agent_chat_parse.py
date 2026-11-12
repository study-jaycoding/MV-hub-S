"""MV Agent 칸 — Claude Code·Codex 의 JSON 줄을 화면 사건으로 바꾸는 순수 해석기(프로세스·DB·HTTP 없음).

사건 모양은 docs/status/AskAgent_옆칸_설계_2026-11-09.md 10절. 해석기는 한 차례(프로세스 하나)마다 새로 만든다 —
도구 id → 이름 표를 차례 안에서만 들고 있다. 허용 목록 밖 도구·명령 실행·파일 변경은 `violation` 으로 알려
실행기가 즉시 끄게 한다(0단계 실측 6-1: Claude 는 시작 사건의 도구 목록으로, Codex 는 나타난 항목으로 본다).
"""
from __future__ import annotations

import json

PANEL_SERVER = "mvhub_panel"
PANEL_TOOLS = ("check_connection", "connect", "read_context", "prepare_generation_plan", "get_plan", "estimate_plan",
               "execute_generation_plan", "wait_results", "add_to_canvas")  # 어댑터 --panel·허브 _PANEL_METHODS 와 같은 뜻(시험이 대조)
CLAUDE_ALLOWED = frozenset(f"mcp__{PANEL_SERVER}__{name}" for name in PANEL_TOOLS)
MAX_TEXT = 20_000
MAX_LINE = 1_048_576


def _short(name: str) -> str:
    prefix = f"mcp__{PANEL_SERVER}__"
    return name[len(prefix):] if name.startswith(prefix) else name


def _text(value: object) -> str:
    return str(value or "")[:MAX_TEXT]


def _load(line: str | bytes) -> dict | None:
    if len(line) > MAX_LINE:
        return None
    try:
        data = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _count(value: object) -> int:
    return value if type(value) is int and 0 <= value < 2 ** 53 else 0


def _weekly(data: dict) -> dict | None:
    """rate_limit_event → 주간 한도(0단계 원본 실측: rate_limit_info.unifiedWindows.seven_day = {utilization 0~1, resetsAt 초})."""
    info = data.get("rate_limit_info")
    windows = info.get("unifiedWindows") if isinstance(info, dict) else None
    week = windows.get("seven_day") if isinstance(windows, dict) else None
    used = week.get("utilization") if isinstance(week, dict) else None
    if type(used) not in (int, float) or used != used:  # NaN 도 거른다
        return None
    resets = week.get("resetsAt")
    return {"utilization": min(max(float(used), 0.0), 1.0), "resets_at": resets if type(resets) is int and 0 < resets < 2 ** 40 else None}


class ClaudeParser:
    """`claude -p --output-format stream-json --verbose --include-partial-messages` 한 줄씩."""

    def __init__(self) -> None:
        self.tools: dict[str, str] = {}
        self.context = 0  # 마지막 assistant 줄의 입력+캐시+출력 토큰 = 지금 대화가 문맥 창을 채운 양

    def feed(self, line: str | bytes) -> list[dict]:
        data = _load(line)
        if data is None:
            return []
        kind = data.get("type")
        if data.get("parent_tool_use_id") is not None:
            return []  # 하위 에이전트 사건 — 칸에는 보이지 않는다(도구가 잠겨 생기지도 않는다)
        if kind == "system" and data.get("subtype") == "init":
            tools = [str(name) for name in data.get("tools") or []]
            out = [{"kind": "session", "cli_session_id": _text(data.get("session_id")), "auth": data.get("apiKeySource")}]
            extra = sorted(set(tools) - CLAUDE_ALLOWED)
            if extra:
                out.append({"kind": "violation", "what": "tools", "detail": extra[:20]})
            failed = [str(s.get("name")) for s in data.get("mcp_servers") or [] if isinstance(s, dict) and s.get("status") != "connected"]
            if failed:
                out.append({"kind": "error", "message": "MV Hub 연결을 열지 못했습니다. 허브를 다시 켠 뒤 새 대화로 시도하세요."})
            return out
        if kind == "system":
            # init 밖 시스템 알림(예: 빠른 모드를 쓸 수 없어 표준 모드로 돌렸다) — 사람이 읽을 글이 있으면 칸에 그대로 보인다.
            # shortcut: 알림 줄 모양을 0단계에서 아직 못 잡아 message/text/content 글만 본다 — 실제 모양을 잡으면 좁힌다
            note = next((data.get(key) for key in ("message", "text", "content") if isinstance(data.get(key), str)), "")
            return [{"kind": "notice", "text": _text(note)[:500]}] if note.strip() else []
        if kind == "stream_event":
            event = data.get("event") or {}
            delta = event.get("delta") or {}
            if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta" and delta.get("text"):
                return [{"kind": "text_delta", "text": _text(delta.get("text"))}]
            return []
        if kind == "rate_limit_event":
            weekly = _weekly(data)
            return [{"kind": "usage", "weekly": weekly}] if weekly else []
        if kind == "assistant":
            usage = (data.get("message") or {}).get("usage")
            if isinstance(usage, dict):
                used = sum(_count(usage.get(key)) for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
                self.context = used or self.context
            out = []
            for block in (data.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    out.append({"kind": "text", "text": _text(block.get("text"))})
                elif block.get("type") == "tool_use":
                    name = str(block.get("name") or "")
                    self.tools[str(block.get("id"))] = name
                    if name not in CLAUDE_ALLOWED:
                        out.append({"kind": "violation", "what": "tool", "detail": [name]})
                    out.append({"kind": "tool", "name": _short(name), "status": "started"})
            return out
        if kind == "user":
            out = []
            for block in (data.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    name = self.tools.get(str(block.get("tool_use_id")), "")
                    out.append({"kind": "tool", "name": _short(name), "status": "failed" if block.get("is_error") else "done"})
            return out
        if kind == "result":
            ok = data.get("subtype") == "success" and not data.get("is_error")
            event = {"kind": "result", "ok": ok, "cli_session_id": _text(data.get("session_id"))}
            if not ok:
                errors = data.get("errors") if isinstance(data.get("errors"), list) else []
                event["message"] = _text(errors[0] if errors else data.get("result") or data.get("subtype") or "실행 실패")
            models = data.get("modelUsage") if isinstance(data.get("modelUsage"), dict) else {}
            window = max((_count(m.get("contextWindow")) for m in models.values() if isinstance(m, dict)), default=0)
            if self.context and window:  # 사용량 원(입력칸) — 결과 앞에 둔다
                return [{"kind": "usage", "context": {"used": min(self.context, window), "window": window}}, event]
            return [event]
        return []


class CodexParser:
    """`codex exec --json` 한 줄씩. 글 조각은 없고 항목이 끝날 때 통째로 온다."""

    def __init__(self) -> None:
        self.last_error = ""

    def feed(self, line: str | bytes) -> list[dict]:
        data = _load(line)
        if data is None:
            return []
        kind = data.get("type")
        if kind == "thread.started":
            return [{"kind": "session", "cli_session_id": _text(data.get("thread_id")), "auth": None}]
        if kind == "error":
            self.last_error = _text(data.get("message"))
            return []
        if kind == "turn.completed":
            return [{"kind": "result", "ok": True, "cli_session_id": ""}]
        if kind == "turn.failed":
            message = (data.get("error") or {}).get("message") if isinstance(data.get("error"), dict) else None
            return [{"kind": "result", "ok": False, "cli_session_id": "", "message": _text(message or self.last_error or "실행 실패")}]
        if kind not in ("item.started", "item.completed"):
            return []
        item = data.get("item") if isinstance(data.get("item"), dict) else {}
        itype = item.get("type")
        if itype == "agent_message":
            return [{"kind": "text", "text": _text(item.get("text"))}] if kind == "item.completed" and item.get("text") else []
        if itype == "mcp_tool_call":
            out = []
            if item.get("server") != PANEL_SERVER or item.get("tool") not in PANEL_TOOLS:
                out.append({"kind": "violation", "what": "tool", "detail": [f"{item.get('server')}.{item.get('tool')}"]})
            status = "started" if kind == "item.started" else ("done" if item.get("status") == "completed" else "failed")
            out.append({"kind": "tool", "name": _text(item.get("tool")), "status": status})
            return out
        if itype in ("command_execution", "file_change", "web_search", "collab_tool_call"):
            return [{"kind": "violation", "what": itype, "detail": []}]
        if itype == "error" and kind == "item.completed":
            self.last_error = _text(item.get("message"))
        return []


def parser_for(engine: str):
    return ClaudeParser() if engine == "claude" else CodexParser()
