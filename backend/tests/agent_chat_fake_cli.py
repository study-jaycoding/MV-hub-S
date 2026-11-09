"""Ask Agent 칸 시험용 가짜 CLI — 진짜 Claude Code·Codex·유료 생성을 쓰지 않는다.

FAKE_AGENT_SCENARIO 로 고른다. 실행기가 붙이는 실제 CLI 옵션은 무시하고 stdin(UTF-8 프롬프트)만 읽는다.
FAKE_AGENT_PIDFILE 가 있으면 오래 걸리는 장면에서 손자 프로세스 pid 를 남긴다(트리 회수 확인용).
"""
import json
import os
import subprocess
import sys
import time

ALLOWED = ["mcp__mvhub_panel__check_connection", "mcp__mvhub_panel__connect", "mcp__mvhub_panel__read_context",
           "mcp__mvhub_panel__prepare_generation_plan", "mcp__mvhub_panel__get_plan", "mcp__mvhub_panel__estimate_plan"]


def out(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def init(tools=ALLOWED, session="S-claude-1"):
    out({"type": "system", "subtype": "init", "session_id": session, "tools": tools,
         "mcp_servers": [{"name": "mvhub_panel", "status": "connected"}],
         "apiKeySource": os.environ.get("FAKE_AGENT_INIT_AUTH", "none")})


def grandchild_and_wait():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    path = os.environ.get("FAKE_AGENT_PIDFILE")
    if path:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(child.pid))
    time.sleep(120)


def main():
    if "--version" in sys.argv:
        print(os.environ.get("FAKE_AGENT_VERSION", "0.162.0-alpha.17.2"))
        return
    auth = os.environ.get("FAKE_AGENT_AUTH", "subscription")  # subscription | api_key | none
    if sys.argv[1:3] == ["auth", "status"]:  # Claude 모양
        print(json.dumps({"loggedIn": auth != "none", "authMethod": "claude.ai" if auth == "subscription" else "console",
                          "apiProvider": "firstParty"}))
        return
    if sys.argv[1:3] == ["login", "status"]:  # Codex 모양
        print({"subscription": "Logged in using ChatGPT", "api_key": "Logged in using an API key"}.get(auth, "Not logged in"))
        return
    prompt = sys.stdin.buffer.read().decode("utf-8")
    user = prompt.rsplit("[사용자]\n", 1)[-1].strip()
    scenario = os.environ.get("FAKE_AGENT_SCENARIO", "claude_ok")
    if scenario == "claude_ok":
        init()
        for piece in ("받은 ", "말: "):
            out({"type": "stream_event", "parent_tool_use_id": None,
                 "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": piece}}})
        out({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__mvhub_panel__read_context", "input": {}}]}})
        out({"type": "user", "parent_tool_use_id": None, "message": {"content": [{"type": "tool_result", "tool_use_id": "t1"}]}})
        out({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "text", "text": "받은 말: " + user}]}})
        out({"type": "result", "subtype": "success", "is_error": False, "session_id": "S-claude-1"})
    elif scenario == "claude_violation":
        init(tools=ALLOWED + ["Bash"])
        time.sleep(30)
        out({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "text", "text": "늦은 글"}]}})
    elif scenario == "claude_slow":
        init()
        grandchild_and_wait()
    elif scenario == "silent":
        return
    elif scenario == "orphan_stdout":  # 부모는 끝나는데 손자가 같은 stdout 을 쥐고 남는다
        init()
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], stdout=sys.stdout)
        path = os.environ.get("FAKE_AGENT_PIDFILE")
        if path:
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(str(child.pid))
        out({"type": "result", "subtype": "success", "is_error": False, "session_id": "S-claude-1"})
    elif scenario == "pause_after_delta":  # 짧은 조각 뒤 한참 조용 — 다음 출력이 없어도 조각이 보여야 한다
        init()
        out({"type": "stream_event", "parent_tool_use_id": None,
             "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "짧은 답"}}})
        time.sleep(3)
        out({"type": "result", "subtype": "success", "is_error": False, "session_id": "S-claude-1"})
    elif scenario == "flood":
        init()
        for index in range(5000):
            out({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "text", "text": f"줄 {index}"}]}})
        out({"type": "result", "subtype": "success", "is_error": False, "session_id": "S-claude-1"})
    elif scenario == "long_line":
        init()
        sys.stdout.write("x" * (2 * 1024 * 1024) + "\n")
        out({"type": "assistant", "parent_tool_use_id": None, "message": {"content": [{"type": "text", "text": "긴 줄 뒤"}]}})
        out({"type": "result", "subtype": "success", "is_error": False, "session_id": "S-claude-1"})
    elif scenario == "codex_ok":
        out({"type": "thread.started", "thread_id": "T-codex-1"})
        out({"type": "turn.started"})
        item = {"id": "item_0", "type": "mcp_tool_call", "server": "mvhub_panel", "tool": "read_context", "status": "in_progress"}
        out({"type": "item.started", "item": item})
        out({"type": "item.completed", "item": {**item, "status": "completed"}})
        out({"type": "item.completed", "item": {"id": "item_1", "type": "agent_message", "text": "받은 말: " + user}})
        out({"type": "turn.completed", "usage": {}})


if __name__ == "__main__":
    main()
