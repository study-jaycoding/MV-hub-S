"""Ask Agent 칸 해석기 — 0단계 실측 출력 모양(설계 6-1)을 줄여 담은 견본. 프로세스·DB·네트워크 없음."""
import ast
import json
from pathlib import Path

from app.services.agent_chat_parse import CLAUDE_ALLOWED, ClaudeParser, CodexParser, MAX_LINE


def lines(*values):
    return [json.dumps(value, ensure_ascii=False) for value in values]


def feed(parser, values):
    events = []
    for line in lines(*values):
        events.extend(parser.feed(line))
    return events


def test_claude_stream_text_tool_and_result():
    events = feed(ClaudeParser(), [
        {"type": "system", "subtype": "init", "session_id": "S1", "tools": sorted(CLAUDE_ALLOWED),
         "mcp_servers": [{"name": "mvhub_panel", "status": "connected"}], "apiKeySource": "none"},
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "안"}}},
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": ""}}},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__mvhub_panel__prepare_generation_plan", "input": {}}]}},
        {"type": "user", "parent_tool_use_id": None, "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": True}]}},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "text", "text": "안녕"}]}},
        {"type": "result", "subtype": "success", "is_error": False, "session_id": "S1"},
    ])
    kinds = [event["kind"] for event in events]
    assert kinds == ["session", "text_delta", "tool", "tool", "text", "result"]
    assert events[0] == {"kind": "session", "cli_session_id": "S1", "auth": "none"}
    assert events[2] == {"kind": "tool", "name": "prepare_generation_plan", "status": "started"}
    assert events[3] == {"kind": "tool", "name": "prepare_generation_plan", "status": "failed"}
    assert events[-1]["ok"] is True


def test_claude_extra_tool_or_failed_mcp_is_reported():
    events = feed(ClaudeParser(), [
        {"type": "system", "subtype": "init", "session_id": "S1", "tools": sorted(CLAUDE_ALLOWED) + ["Bash", "mcp__claude_ai_Higgsfield__generate_image"],
         "mcp_servers": [{"name": "mvhub_panel", "status": "failed"}]},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "tool_use", "id": "x", "name": "Bash"}]}},
    ])
    violations = [event for event in events if event["kind"] == "violation"]
    assert violations[0]["detail"] == ["Bash", "mcp__claude_ai_Higgsfield__generate_image"]
    assert violations[1]["detail"] == ["Bash"]
    assert any(event["kind"] == "error" for event in events)


def test_claude_error_result_subagent_and_garbage_are_safe():
    parser = ClaudeParser()
    assert parser.feed("not json") == []
    assert parser.feed("[1,2]") == []
    assert parser.feed("x" * (MAX_LINE + 1)) == []
    assert feed(parser, [{"type": "assistant", "parent_tool_use_id": "t9", "message": {"content": [{"type": "text", "text": "숨김"}]}}]) == []
    result = feed(parser, [{"type": "result", "subtype": "error_during_execution", "is_error": True, "errors": ["로그인 필요"], "session_id": "S2"}])
    assert result == [{"kind": "result", "ok": False, "cli_session_id": "S2", "message": "로그인 필요"}]


def test_claude_usage_weekly_and_context():
    """사용량 원(docs/status/MVAgent_모델설정사용량_2026-11-12.md) — 0단계 원본 실측 모양 그대로."""
    parser = ClaudeParser()
    events = feed(parser, [
        {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": 1794319200, "rateLimitType": "seven_day",
                                                         "unifiedWindows": {"seven_day": {"utilization": 0.45, "resetsAt": 1794319200}}}},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"usage": {"input_tokens": 2, "cache_creation_input_tokens": 956,
                                                                                "cache_read_input_tokens": 3512, "output_tokens": 24}, "content": []}},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"usage": {"input_tokens": 2, "cache_creation_input_tokens": 100,
                                                                                "cache_read_input_tokens": 4468, "output_tokens": 8}, "content": []}},
        {"type": "result", "subtype": "success", "is_error": False, "session_id": "S1",
         "modelUsage": {"claude-haiku-5-5": {"contextWindow": 1000000, "inputTokens": 1443}, "x": "bad"}},
    ])
    assert events[0] == {"kind": "usage", "weekly": {"utilization": 0.45, "resets_at": 1794319200}}
    assert events[1] == {"kind": "usage", "context": {"used": 4578, "window": 1000000}}  # 마지막 assistant 줄만
    assert events[2]["kind"] == "result"
    # 모양이 다르면 사용량을 만들지 않는다(결과는 그대로)
    odd = ClaudeParser()
    assert feed(odd, [{"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"seven_day": {"utilization": "45%"}}}},
                      {"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"seven_day": {"utilization": True}}}},
                      {"type": "rate_limit_event", "rate_limit_info": None}]) == []
    clipped = feed(odd, [{"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"seven_day": {"utilization": 1.7, "resetsAt": "soon"}}}}])
    assert clipped == [{"kind": "usage", "weekly": {"utilization": 1.0, "resets_at": None}}]
    no_window = feed(odd, [{"type": "assistant", "parent_tool_use_id": None, "message": {"usage": {"input_tokens": 9}, "content": []}},
                           {"type": "result", "subtype": "success", "is_error": False, "session_id": "S"}])
    assert [e["kind"] for e in no_window] == ["result"]


def test_codex_items_and_turn_end():
    events = feed(CodexParser(), [
        {"type": "thread.started", "thread_id": "T1"},
        {"type": "turn.started"},
        {"type": "item.started", "item": {"id": "i0", "type": "mcp_tool_call", "server": "mvhub_panel", "tool": "read_context", "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "i0", "type": "mcp_tool_call", "server": "mvhub_panel", "tool": "read_context", "status": "failed"}},
        {"type": "item.completed", "item": {"id": "i1", "type": "agent_message", "text": "답"}},
        {"type": "turn.completed", "usage": {}},
    ])
    assert [event["kind"] for event in events] == ["session", "tool", "tool", "text", "result"]
    assert events[2] == {"kind": "tool", "name": "read_context", "status": "failed"}
    assert events[-1]["ok"] is True


def test_codex_violations_and_failure_message():
    parser = CodexParser()
    events = feed(parser, [
        {"type": "item.started", "item": {"type": "mcp_tool_call", "server": "codex_apps", "tool": "higgsfield_generate_image"}},
        {"type": "item.started", "item": {"type": "command_execution", "command": "cmd /c ver"}},
        {"type": "error", "message": "Reconnecting... 5/5"},
        {"type": "turn.failed", "error": {}},
    ])
    assert [event["kind"] for event in events if event["kind"] == "violation"] == ["violation", "violation"]
    assert events[-1] == {"kind": "result", "ok": False, "cli_session_id": "", "message": "Reconnecting... 5/5"}


def _frozenset_assign(path: Path, name: str) -> set[str]:
    """어댑터는 백엔드 venv 에 없는 mcp 패키지를 쓴다 — import 하지 않고 ast 로 그 이름의 frozenset({...}) 글자만 읽는다."""
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return set(ast.literal_eval(node.value.args[0]))
    raise AssertionError(f"{name} 를 찾지 못했다")


def test_panel_tool_lists_agree():
    """세 허용 목록(어댑터 --panel·해석기→CLI 허용·허브 _PANEL_METHODS) + 가짜 CLI 가 같은 뜻(앱 동작 도구 설계 A3)."""
    from app.routers.mcp_v2 import _PANEL_METHODS
    from app.services.agent_chat_parse import PANEL_TOOLS
    import agent_chat_fake_cli

    root = Path(__file__).resolve().parents[2]
    adapter = _frozenset_assign(root / "tools" / "mcp_adapter" / "server.py", "PANEL_TOOLS")
    assert adapter == set(PANEL_TOOLS)
    assert CLAUDE_ALLOWED == {f"mcp__mvhub_panel__{name}" for name in PANEL_TOOLS} == set(agent_chat_fake_cli.ALLOWED)
    assert set(_PANEL_METHODS) == set(PANEL_TOOLS) - {"check_connection", "connect"}  # 이 둘은 어댑터 안에서 끝난다
    assert {"execute_generation_plan", "wait_results", "add_to_canvas"} <= set(PANEL_TOOLS)
    assert not {"get_result", "show_results", "get_generation"} & set(PANEL_TOOLS)  # 그림을 CLI 로 보내는 도구는 칸에 없다
