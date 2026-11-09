"""Ask Agent 칸 해석기 — 0단계 실측 출력 모양(설계 6-1)을 줄여 담은 견본. 프로세스·DB·네트워크 없음."""
import json

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
