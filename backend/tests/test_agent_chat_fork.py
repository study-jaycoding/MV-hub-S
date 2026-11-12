"""MV Agent 포크(docs/status/MVAgent_포크_2026-11-12.md) — 복사·중복 방지·첫 차례 확인·가르기·원래 보호·정리.
격리 DB·가짜 CLI(옵션은 무시 — 명령은 build_command 를 엿봐 확인). 실제 Claude·생성·공유 서버 없음."""
import asyncio
import contextlib
import json
import sqlite3
import threading
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app import config
from app.repo import agent_chat as chat_store
from app.repo import mcp_v2 as mcp_store
from app.routers import mcp_v2 as mcp_api
from app.services import agent_chat_process as process
from test_agent_chat_api import hub, panel_headers, start_turn, wait_status, windows  # noqa: F401 - hub 는 fixture

assert hub


def _db():
    return next(config.AGENT_CHAT_DIR.glob("*.db"))


def _commands(monkeypatch):
    seen = []
    real = process.build_command

    def spy(*args, **kwargs):
        seen.append({"resume": kwargs.get("resume"), "fork": kwargs.get("fork", False)})
        return real(*args, **kwargs)

    monkeypatch.setattr(process, "build_command", spy)
    return seen


def _source(client, headers, monkeypatch, session="S-orig"):
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    monkeypatch.setenv("FAKE_AGENT_SESSION", session)
    turn = start_turn(client, headers, text="원래 첫 말").json()
    wait_status(client, headers, turn["turn_id"], {"done"})
    return turn


def _messages(client, headers, turn_id):
    events = client.get(f"/api/agent-chat/turns/{turn_id}/events?after=0", headers=headers).json()["events"]
    return [e.get("message") for e in events if e.get("kind") == "error"]


def _fork(client, headers, conversation_id, request_id=None):
    return client.post(f"/api/agent-chat/conversations/{conversation_id}/fork", headers=headers,
                       json={"request_id": request_id or str(uuid4())})


def _add_plan(turn_id, conversation_client):
    """원래 대화에 계획 사건·묶음을 넣는다(실제 계획 경로는 test_agent_chat_api 가 본다)."""
    plan_id = str(uuid4())
    with chat_store.connect(_db()) as conn:
        conn.execute("INSERT INTO agent_chat_event(turn_id,seq,kind,payload) VALUES(?,?,?,?)",
                     (turn_id, 99, "plan", json.dumps({"plan": {"plan_id": plan_id, "title": "고양이", "status": "draft"}})))
        conn.execute("INSERT INTO agent_chat_plan_binding(plan_id,turn_id,client_id) VALUES(?,?,?)", (plan_id, turn_id, conversation_client))
    return plan_id


@windows
def test_fork_copies_finished_turns_marks_plans_and_dedupes(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    origin = chat_store.get_conversation(_db(), source["conversation_id"])
    plan_id = _add_plan(source["turn_id"], origin["client_id"])
    request_id = str(uuid4())
    made = _fork(client, headers, source["conversation_id"], request_id)
    assert made.status_code == 200, made.text
    fork = made.json()["conversation"]
    assert fork["title"] == "원래 첫 말 (포크)" and fork["id"] != source["conversation_id"]
    assert (fork["can_fork"], fork["fork_block"], fork["fork_state"]) == (False, "forked_unstarted", "ready")
    assert "_sid" not in fork and "cli_session_id" not in fork  # 세션 id 는 화면에 안 보낸다
    row = chat_store.get_conversation(_db(), fork["id"])
    assert (row["cli_session_id"], row["fork_session"], row["fork_from"], row["fork_turn"]) == (
        None, "S-orig", source["conversation_id"], source["turn_id"])
    assert row["client_id"] != origin["client_id"] and len(profiles) == 2  # 새 칸 연결
    detail = client.get(f"/api/agent-chat/conversations/{fork['id']}", headers=headers).json()
    assert [t["text"] for t in detail["turns"]] == ["원래 첫 말"] and detail["turns"][0]["id"] != source["turn_id"]
    plans = [e["plan"] for t in detail["turns"] for e in t["events"] if e["kind"] == "plan"]
    assert plans == [{"plan_id": plan_id, "title": "고양이", "status": "draft", "forked": True}]
    assert detail["plans"] == [] and detail["conversation"]["fork_state"] == "ready"  # 계획 묶음은 복사 안 함
    # 포크 카드로 원래 계획을 실행·견적하지 못한다(대화 id 대조)
    for action in ("execute", "estimate"):
        assert client.post(f"/api/agent-chat/plans/{plan_id}/{action}", headers=headers,
                           json={"conversation_id": fork["id"]}).status_code == 404
    # 같은 요청 번호 = 같은 포크(새 연결 없음) · 다른 원래 대화에 같은 번호 = 409
    again = _fork(client, headers, source["conversation_id"], request_id)
    assert again.status_code == 200 and again.json()["conversation"]["id"] == fork["id"] and len(profiles) == 2
    assert _fork(client, headers, fork["id"], request_id).status_code == 409
    # 아직 갈라지지 않은 포크는 다시 포크할 수 없다(세션 없음)
    assert _fork(client, headers, fork["id"]).status_code == 409


@windows
def test_fork_first_turn_forks_once_then_uses_its_own_session(hub, monkeypatch):  # noqa: F811
    client, _, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    fork = _fork(client, headers, source["conversation_id"]).json()["conversation"]
    seen = _commands(monkeypatch)
    monkeypatch.setenv("FAKE_AGENT_SESSION", "S-fork")
    first = start_turn(client, headers, conversation_id=fork["id"], text="포크 첫 말")
    assert first.status_code == 200, first.text
    wait_status(client, headers, first.json()["turn_id"], {"done"})
    assert seen[-1] == {"resume": "S-orig", "fork": True}
    assert chat_store.get_conversation(_db(), fork["id"])["cli_session_id"] == "S-fork"
    second = start_turn(client, headers, conversation_id=fork["id"], text="포크 둘째 말").json()
    wait_status(client, headers, second["turn_id"], {"done"})
    assert seen[-1] == {"resume": "S-fork", "fork": False}
    monkeypatch.setenv("FAKE_AGENT_SESSION", "S-orig")
    back = start_turn(client, headers, conversation_id=source["conversation_id"], text="원래 둘째 말").json()
    wait_status(client, headers, back["turn_id"], {"done"})
    assert seen[-1] == {"resume": "S-orig", "fork": False}  # 원래는 원래 세션 그대로
    summary = chat_store.conversation_summary(_db(), fork["id"])
    assert (summary["can_fork"], summary["fork_state"]) == (True, None)  # 갈라진 뒤엔 상태·잠금이 풀린다


@windows
def test_unstarted_fork_refused_when_source_moved_or_gone(hub, monkeypatch):  # noqa: F811
    client, _, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    moved = _fork(client, headers, source["conversation_id"]).json()["conversation"]
    gone = _fork(client, headers, source["conversation_id"]).json()["conversation"]
    later = start_turn(client, headers, conversation_id=source["conversation_id"], text="원래가 이어짐").json()
    wait_status(client, headers, later["turn_id"], {"done"})
    refused = start_turn(client, headers, conversation_id=moved["id"], text="포크")
    assert refused.status_code == 409 and "다시 포크" in refused.json()["detail"]
    assert chat_store.conversation_summary(_db(), moved["id"])["fork_state"] == "source_changed"
    assert client.delete(f"/api/agent-chat/conversations/{source['conversation_id']}", headers=headers).status_code == 200
    assert start_turn(client, headers, conversation_id=gone["id"], text="포크").status_code == 409
    listing = {c["id"]: c for c in client.get("/api/agent-chat/conversations", headers=headers).json()["conversations"]}
    assert listing[gone["id"]]["fork_state"] == "source_gone"


@windows
def test_fork_never_saves_the_source_session_and_retries_after_early_failure(hub, monkeypatch):  # noqa: F811
    client, _, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    fork = _fork(client, headers, source["conversation_id"]).json()["conversation"]
    # 가르기 실패(시작 사건 id = 원래) — 저장하지 않고 멈춘다
    failed = start_turn(client, headers, conversation_id=fork["id"], text="포크").json()
    wait_status(client, headers, failed["turn_id"], {"failed"})
    assert "포크하지 못했어요 — 원래 대화는 그대로예요." in _messages(client, headers, failed["turn_id"])
    row = chat_store.get_conversation(_db(), fork["id"])
    assert (row["cli_session_id"], row["resumable"]) == (None, True)
    # 답 없이 끝남(가르기 전) — 포크를 잠그지 않는다
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "silent")
    silent = start_turn(client, headers, conversation_id=fork["id"], text="포크").json()
    wait_status(client, headers, silent["turn_id"], {"failed"})
    assert "포크를 시작하지 못했어요 · 다시 보내 보세요." in _messages(client, headers, silent["turn_id"])
    assert chat_store.get_conversation(_db(), fork["id"])["resumable"] is True
    # 다음 말이 다시 가른다
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    monkeypatch.setenv("FAKE_AGENT_SESSION", "S-fork")
    ok = start_turn(client, headers, conversation_id=fork["id"], text="포크").json()
    wait_status(client, headers, ok["turn_id"], {"done"})
    assert chat_store.get_conversation(_db(), fork["id"])["cli_session_id"] == "S-fork"


@windows
def test_source_delete_blocked_while_fork_turn_runs_even_after_new_session(hub, monkeypatch):  # noqa: F811
    client, _, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    fork = _fork(client, headers, source["conversation_id"]).json()["conversation"]
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_slow")
    monkeypatch.setenv("FAKE_AGENT_SESSION", "S-fork")
    running = start_turn(client, headers, conversation_id=fork["id"], text="포크").json()
    # 시작 사건으로 새 id 가 저장될 때까지 기다린 뒤에도 원래 지우기는 막힌다(첫 차례가 끝날 때까지)
    for _ in range(200):
        if chat_store.get_conversation(_db(), fork["id"])["cli_session_id"]:
            break
        wait_status(client, headers, running["turn_id"], {"running"}, timeout=1)
    assert chat_store.get_conversation(_db(), fork["id"])["cli_session_id"] == "S-fork"
    with chat_store.connect(_db()) as conn:
        assert conn.execute("SELECT status FROM agent_chat_turn WHERE id=?", (running["turn_id"],)).fetchone()[0] == "running"
    blocked = client.delete(f"/api/agent-chat/conversations/{source['conversation_id']}", headers=headers)
    assert blocked.status_code == 409 and "가르는 중" in blocked.json()["detail"]
    client.post(f"/api/agent-chat/turns/{running['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, running["turn_id"], {"cancelled", "failed", "interrupted"})
    # 갈라진 뒤의 차례(자기 세션 S-fork 를 이어 감)가 도는 중에는 원래를 지울 수 있다(포크 독립 리뷰 2차 P2)
    second = start_turn(client, headers, conversation_id=fork["id"], text="포크 둘째 말").json()
    wait_status(client, headers, second["turn_id"], {"running"}, timeout=10)
    assert client.delete(f"/api/agent-chat/conversations/{source['conversation_id']}", headers=headers).status_code == 200
    client.post(f"/api/agent-chat/turns/{second['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, second["turn_id"], {"cancelled", "failed", "interrupted"})


@windows
def test_fork_refusals_and_cleanup(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    assert _fork(client, headers, uuid4()).status_code == 404
    source = _source(client, headers, monkeypatch)
    monkeypatch.setattr(chat_store, "FORK_MAX_TURNS", 0)
    assert _fork(client, headers, source["conversation_id"]).status_code == 413
    monkeypatch.setattr(chat_store, "FORK_MAX_TURNS", 500)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_slow")
    busy = start_turn(client, headers, conversation_id=source["conversation_id"], text="도는 중").json()
    assert _fork(client, headers, source["conversation_id"]).status_code == 409
    client.post(f"/api/agent-chat/turns/{busy['turn_id']}/cancel", headers=headers)
    wait_status(client, headers, busy["turn_id"], {"cancelled", "failed", "interrupted"})
    # 복사가 커밋 전에 실패하면 발급한 연결을 회수한다
    real = chat_store.fork_conversation

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(chat_store, "fork_conversation", broken)
    with pytest.raises(RuntimeError):
        _fork(client, headers, source["conversation_id"])
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]
    # 커밋 뒤에 실패하면(응답만 잃음) 회수하지 않고, 같은 요청 번호가 그 포크를 받는다
    request_id = str(uuid4())

    def committed_then_lost(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("response lost")

    monkeypatch.setattr(chat_store, "fork_conversation", committed_then_lost)
    with pytest.raises(RuntimeError):
        _fork(client, headers, source["conversation_id"], request_id)
    assert not mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]
    monkeypatch.setattr(chat_store, "fork_conversation", real)
    made = chat_store.find_fork(_db(), request_id)
    assert made["fork_from"] == source["conversation_id"]
    again = _fork(client, headers, source["conversation_id"], request_id)
    assert again.status_code == 200 and again.json()["conversation"]["id"] == made["id"]


def _cancel_when(client, headers, source_id, request_id, ready, release):
    """포크 요청을 보내고, 작업 스레드가 ready 를 알리면 요청을 취소한다. 돌려주는 것 = 취소 뒤에도 요청(신원 차례 잠금 구간)이
    작업 스레드를 기다리며 끝나지 않았는가."""
    async def run():
        transport = httpx.ASGITransport(app=client.app, client=("127.0.0.1", 50431))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8012") as http:
            task = asyncio.create_task(http.post(f"/api/agent-chat/conversations/{source_id}/fork", headers=headers,
                                                 json={"request_id": request_id}))
            assert await asyncio.to_thread(ready.wait, 10)
            task.cancel()
            await asyncio.sleep(0.3)
            held = not task.done()
            release.set()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            return held

    return client.portal.call(run)


@windows
def test_fork_cancelled_while_issuing_still_revokes_in_the_worker(hub, monkeypatch):  # noqa: F811
    """요청이 연결 발급 중에 취소돼도 같은 작업 스레드가 복사·회수까지 끝낸다(포크 독립 리뷰 P2)."""
    client, profiles, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    issued, release = threading.Event(), threading.Event()
    real_issue = mcp_api.issue_panel_client

    def slow_issue(ctx, setup):
        made = real_issue(ctx, setup)
        issued.set()
        release.wait(10)  # 이 사이에 요청이 취소된다
        return made

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(mcp_api, "issue_panel_client", slow_issue)
    monkeypatch.setattr(chat_store, "fork_conversation", broken)
    request_id = str(uuid4())
    assert _cancel_when(client, headers, source["conversation_id"], request_id, issued, release)
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]  # 취소된 요청의 연결도 회수됐다
    assert chat_store.find_fork(_db(), request_id) is None


@windows
@pytest.mark.parametrize("commit", [True, False])
def test_fork_cancelled_just_before_commit(hub, monkeypatch, commit):  # noqa: F811
    """커밋 직전(신원 확인 자리)에 취소 — 잠금은 작업이 끝날 때까지, 커밋되면 연결 유지·같은 요청 번호로 그 포크, 안 되면 회수."""
    client, profiles, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    at_commit, release, armed = threading.Event(), threading.Event(), []
    real_issue, real_still = mcp_api.issue_panel_client, mcp_api._still_current

    def issue_then_arm(ctx, setup):
        made = real_issue(ctx, setup)
        armed.append(True)
        return made

    def still(ctx):
        if armed:
            armed.clear()
            at_commit.set()
            release.wait(10)
            if not commit:
                raise RuntimeError("disk full")  # 커밋 직전 실패 — 되돌린다
        return real_still(ctx)

    monkeypatch.setattr(mcp_api, "issue_panel_client", issue_then_arm)
    monkeypatch.setattr(mcp_api, "_still_current", still)
    request_id = str(uuid4())
    assert _cancel_when(client, headers, source["conversation_id"], request_id, at_commit, release)
    made = chat_store.find_fork(_db(), request_id)
    assert bool(made) is commit
    assert bool(mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]) is not commit
    if commit:
        again = _fork(client, headers, source["conversation_id"], request_id)
        assert again.status_code == 200 and again.json()["conversation"]["id"] == made["id"] and len(profiles) == 2  # 새 연결 없음


@windows
def test_fork_cancelled_just_after_commit_keeps_the_connection(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    committed, release = threading.Event(), threading.Event()
    real = chat_store.fork_conversation

    def commit_then_wait(*args, **kwargs):
        summary = real(*args, **kwargs)
        committed.set()
        release.wait(10)  # 커밋 직후 — 응답을 돌려주기 전에 취소된다
        return summary

    monkeypatch.setattr(chat_store, "fork_conversation", commit_then_wait)
    request_id = str(uuid4())
    assert _cancel_when(client, headers, source["conversation_id"], request_id, committed, release)
    made = chat_store.find_fork(_db(), request_id)
    assert made and not mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]
    monkeypatch.setattr(chat_store, "fork_conversation", real)
    again = _fork(client, headers, source["conversation_id"], request_id)
    assert again.status_code == 200 and again.json()["conversation"]["id"] == made["id"]


@windows
def test_fork_rolls_back_and_revokes_when_identity_changes_before_commit(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    source = _source(client, headers, monkeypatch)
    armed = []
    real_issue, real_still = mcp_api.issue_panel_client, mcp_api._still_current

    def issue_then_arm(ctx, setup):
        made = real_issue(ctx, setup)
        armed.append(True)  # 발급 뒤부터 계정이 바뀐 것으로
        return made

    def still(ctx):
        if armed:
            raise HTTPException(403, "활성 계정 또는 허브가 바뀌었습니다.")
        return real_still(ctx)

    monkeypatch.setattr(mcp_api, "issue_panel_client", issue_then_arm)
    monkeypatch.setattr(mcp_api, "_still_current", still)
    request_id = str(uuid4())
    refused = _fork(client, headers, source["conversation_id"], request_id)
    assert refused.status_code == 403
    assert chat_store.find_fork(_db(), request_id) is None  # 커밋 직전 확인에서 되돌렸다
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]


def test_old_db_gets_fork_columns_before_unique_index(tmp_path):
    """옛 기록 파일(포크 칸 없음)을 처음 열 때 칸을 더한 뒤 고유 색인을 만든다 — 다시 열어도 그대로."""
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(chat_store._SCHEMA)
        conn.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) "
                     "VALUES('c1','claude','haiku','low','x','{}','옛 대화')")
    chat_store.open_db(path)
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_chat_conversation)")}
        indexes = {row[1] for row in conn.execute("PRAGMA index_list(agent_chat_conversation)")}
    assert {"fork_session", "fork_turn", "fork_from", "fork_request"} <= columns
    assert "idx_agent_chat_fork_request" in indexes
    chat_store._opened.discard(str(path).casefold())
    chat_store.open_db(path)  # 다시 열기
    summary = chat_store.conversation_summary(path, "c1")
    assert (summary["can_fork"], summary["fork_block"], summary["fork_state"]) == (False, "no_session", None)
