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


# FAKE_AGENT_AUTH → Claude `auth status` 모양(문서: 로그아웃이면 종료 코드 1, authMethod ∈ none·claude.ai·oauth_token·api_key·…)
CLAUDE_STATUS = {
    "subscription": ({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}, 0),
    "team": ({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "team"}, 0),
    "free": ({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "free"}, 0),
    "unknown_plan": ({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "galaxy"}, 0),
    "missing_plan": ({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty"}, 0),
    "api_key": ({"loggedIn": True, "authMethod": "api_key", "apiProvider": "firstParty", "subscriptionType": None}, 0),
    "api_key_helper": ({"loggedIn": True, "authMethod": "api_key_helper", "apiProvider": "firstParty"}, 0),
    "oauth_token": ({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty", "subscriptionType": "max"}, 0),
    "third_party": ({"loggedIn": True, "authMethod": "third_party", "apiProvider": "bedrock"}, 0),
    "none": ({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty", "subscriptionType": None}, 1),
}


def main():
    args = sys.argv[1:]
    claude = "--fake-engine=claude" in args  # 시험의 실행기 앞부분이 엔진을 알려 준다(판이 엔진마다 다르다)
    if "--version" in args:
        default = "2.1.296 (Claude Code)" if claude else "0.162.0-alpha.17.2"
        print(os.environ.get("FAKE_CLAUDE_VERSION" if claude else "FAKE_AGENT_VERSION", default))
        return
    auth = os.environ.get("FAKE_AGENT_AUTH", "subscription")
    if "auth" in args and args[args.index("auth") + 1:args.index("auth") + 2] == ["status"]:  # Claude 모양
        if auth == "badjson":
            print("not json")
            return
        if auth == "slow":
            time.sleep(60)
        if auth == "leak":  # 응답·기록으로 새면 안 되는 값들
            print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                              "subscriptionType": "max", "email": "secret@example.test", "orgId": "org-SECRET",
                              "configDirectory": "C:\\Users\\SECRET\\.claude"}))
            return
        data, code = CLAUDE_STATUS.get(auth, CLAUDE_STATUS["subscription"])
        print(json.dumps({**data, "email": "secret@example.test", "orgId": "org-SECRET"}))
        sys.exit(code)
    if args[-2:] == ["login", "status"] or (len(args) >= 2 and args[0:2] == ["login", "status"]):  # Codex 모양
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
