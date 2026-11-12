"""MV Agent 서랍 메뉴(설계 docs/status/MVAgent_서랍메뉴_2026-11-12.md 3절 ①~⑧) — 격리 DB·격리 대화 폴더·가짜 CLI.
실제 Claude·Codex·생성·공유 서버 없음. 세션 파일은 임시 폴더의 가짜 Claude 자격 폴더에만 만든다."""
import json
import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest

from app import config
from app.repo import agent_chat as chat_store
from app.services import agent_chat as chat
from app.services import agent_chat_claude as claude
from test_agent_chat_api import hub, panel_headers, start_turn, wait_status, windows  # noqa: F401 - hub 는 fixture


def panel(hub):
    client, _, service = hub
    headers = panel_headers(client)
    path = service.session_identity(headers["X-MVHub-Panel"]).db_file()
    return client, headers, path, service


def make_conv(path, title="대화", engine="claude", running=False):
    conv = chat_store.create_conversation(path, engine=engine, model="haiku" if engine == "claude" else "gpt-6.1-sol",
                                          effort="low", client_id="panel-" + uuid4().hex, mcp_entry={}, title=title)
    turn, _ = chat_store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text="질문", context={"tab": "my"})
    if not running:
        chat_store.finish_turn(path, turn["id"], "done")
    return conv, turn


def row(path, conversation_id):
    with chat_store.connect(path) as conn:
        found = conn.execute("SELECT * FROM agent_chat_conversation WHERE id=?", (conversation_id,)).fetchone()
    return dict(found) if found else None


def patch(client, headers, conversation_id, body):
    return client.patch(f"/api/agent-chat/conversations/{conversation_id}", headers=headers, json=body)


# ① 옛 표 → 칸 추가·기본값 · 남은 차례 정리(끝남 사건·unread) · 칸 추가 실패면 _opened 안 들어가고 다시 시도
def test_old_table_migrates_and_failed_alter_retries(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(chat_store._SCHEMA)  # 칸 없는 옛 표
        conn.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) VALUES('c1','claude','haiku','low','x','{}','옛')")
        conn.execute("INSERT INTO agent_chat_turn(id,conversation_id,idempotency_key,status,text,context) VALUES('t1','c1','k1','running','q','{}')")
    monkeypatch.setattr(chat_store, "_opened", set())
    monkeypatch.setattr(chat_store, "_NEW_COLUMNS", {**chat_store._NEW_COLUMNS, "broken": "INTEGER NOT NULL"})  # 기본값 없는 NOT NULL = 실패
    with pytest.raises(sqlite3.OperationalError):
        chat_store.open_db(path)
    assert str(path).casefold() not in chat_store._opened
    with sqlite3.connect(path) as conn:
        assert "pinned" not in {r[1] for r in conn.execute("PRAGMA table_info(agent_chat_conversation)")}  # 롤백
        assert conn.execute("SELECT status FROM agent_chat_turn").fetchone()[0] == "running"
    monkeypatch.setattr(chat_store, "_NEW_COLUMNS", {k: v for k, v in chat_store._NEW_COLUMNS.items() if k != "broken"})
    chat_store.open_db(path)
    old = row(path, "c1")
    assert (old["pinned"], old["archived"], old["unread"], old["unread_rev"], old["project_override"], old["cli_home"]) == (0, 0, 1, 1, None, None)
    assert chat_store.get_turn(path, "t1")["status"] == "interrupted"
    assert chat_store.events_after(path, "t1")[-1] == {"seq": 1, "kind": "state", "status": "interrupted", "unread_rev": 1}


# ② PATCH 필드·검사 · updated_at·목록 순서 그대로 · ⑧ 칸 비밀값 없음 거절
def test_patch_fields_validation_and_order(hub):
    client, headers, path, _ = panel(hub)
    older, _ = make_conv(path, "먼저")
    newer, _ = make_conv(path, "나중")
    with chat_store.connect(path) as conn:
        conn.execute("UPDATE agent_chat_conversation SET updated_at='2026-01-01 00:00:00' WHERE id=?", (older["id"],))
    before = row(path, older["id"])["updated_at"]
    ok = patch(client, headers, older["id"], {"pinned": True, "title": "  새 이름  ", "project": "proj-1"})
    assert ok.status_code == 200, ok.text
    body = ok.json()["conversation"]
    assert (body["pinned"], body["title"], body["project"]) == (True, "새 이름", "proj-1")
    assert row(path, older["id"])["updated_at"] == before
    listed = client.get("/api/agent-chat/conversations", headers=headers).json()
    assert [c["id"] for c in listed["conversations"]] == [newer["id"], older["id"]] and listed["truncated"] is False
    assert patch(client, headers, older["id"], {"project": None}).json()["conversation"]["project"] is None  # 프로젝트 없음
    assert row(path, older["id"])["project_override"] == ""
    assert patch(client, headers, older["id"], {"archived": True}).json()["conversation"]["archived"] is True
    for bad in ({}, {"title": ""}, {"title": "   "}, {"title": "가" * 81}, {"title": None}, {"pinned": "true"}, {"pinned": None},
                {"unread": 1}, {"seen_rev": 1}, {"unread": True, "seen_rev": 1}, {"unread": False, "seen_rev": -1},
                {"unread": False, "seen_rev": True}, {"project": ""}, {"project": "a\nb"}, {"project": "p" * 201}, {"other": 1}):
        assert patch(client, headers, older["id"], bad).status_code == 422, bad
    assert patch(client, headers, str(uuid4()), {"pinned": True}).status_code == 404
    no_secret = {k: v for k, v in headers.items() if k != "X-MVHub-Panel"}
    assert patch(client, no_secret, older["id"], {"pinned": False}).status_code == 401
    assert client.delete(f"/api/agent-chat/conversations/{older['id']}", headers=no_secret).status_code == 401


# ③ 목록 500개·truncated · MCP 읽기가 옮긴 프로젝트를 따름 · 칸 없는 옛 파일도 MCP 읽기 됨
def test_list_limit_and_mcp_project_override(hub, tmp_path):
    client, headers, path, _ = panel(hub)
    conv, _ = make_conv(path, "옮길 대화")
    patch(client, headers, conv["id"], {"project": "proj-9"})
    assert chat.chat_list(path, search=None, limit=10, cursor=None)["conversations"][0]["project"] == "proj-9"
    with chat_store.connect(path) as conn:
        conn.executemany("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) VALUES(?,?,?,?,?,?,?)",
                         [(str(uuid4()), "claude", "haiku", "low", "x", "{}", f"t{i}") for i in range(500)])
    listed = client.get("/api/agent-chat/conversations", headers=headers).json()
    assert len(listed["conversations"]) == 500 and listed["truncated"] is True
    old = tmp_path / "legacy.db"
    with sqlite3.connect(old) as raw:
        raw.executescript(chat_store._SCHEMA)
        raw.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) VALUES('c1','claude','haiku','low','x','{}','옛')")
    assert [c["title"] for c in chat.chat_list(old, search=None, limit=5, cursor=None)["conversations"]] == ["옛"]


# ④ 읽지 않음 rev — 차례 끝 켬·사건에 rev · 늦은 자동 읽음은 못 끔 · 수동 표시 보호 · 수동 읽음은 조건 없이
def test_unread_revision_rules(hub):
    client, headers, path, _ = panel(hub)
    conv, turn = make_conv(path, running=True)
    assert chat_store.finish_turn(path, turn["id"], "done") is True
    assert chat_store.events_after(path, turn["id"])[-1]["unread_rev"] == 1
    assert (row(path, conv["id"])["unread"], row(path, conv["id"])["unread_rev"]) == (1, 1)
    stale = patch(client, headers, conv["id"], {"unread": False, "seen_rev": 0}).json()["conversation"]
    assert (stale["unread"], stale["unread_rev"]) == (True, 1)
    seen = patch(client, headers, conv["id"], {"unread": False, "seen_rev": 1}).json()["conversation"]
    assert (seen["unread"], seen["unread_rev"]) == (False, 2)
    manual = patch(client, headers, conv["id"], {"unread": True}).json()["conversation"]
    assert (manual["unread"], manual["unread_rev"]) == (True, 3)
    assert patch(client, headers, conv["id"], {"unread": False, "seen_rev": 2}).json()["conversation"]["unread"] is True
    assert patch(client, headers, conv["id"], {"unread": False}).json()["conversation"]["unread"] is False
    opened = client.get(f"/api/agent-chat/conversations/{conv['id']}", headers=headers).json()["conversation"]
    assert (opened["unread"], opened["unread_rev"]) == (False, 4)


def session_home(tmp_path, cwd, session_id, folders=("proj-a",), lines_cwd=None):
    home = tmp_path / "claude-home"
    for folder in folders:
        target = home / "projects" / folder
        target.mkdir(parents=True, exist_ok=True)
        lines = [{"type": "queue-operation", "sessionId": session_id},
                 {"type": "user", "sessionId": session_id, "cwd": lines_cwd or str(cwd)}]
        (target / f"{session_id}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
        (target / "other.jsonl").write_text("{}\n", encoding="utf-8")
    return home


def with_session(path, conv, session_id, home, cwd):
    chat_store.update_conversation(path, conv["id"], cli_session_id=session_id,
                                   cli_home=str(home) if home else None, cli_cwd=str(cwd) if cwd else None)


# ⑤ 삭제 — 행·칸 MCP 파일·세션 파일(확인된 한 개만) · 도는 차례 409 · 지운 대화에 차례·끝남 안 붙음
def test_delete_rows_files_and_busy(hub, tmp_path):
    client, headers, path, _ = panel(hub)
    work = tmp_path / "work"
    sid = str(uuid4())
    home = session_home(tmp_path, work, sid)
    conv, turn = make_conv(path, "지울 대화")
    chat_store.append_event(path, turn["id"], "text", {"text": "답"})
    chat_store.bind_plan(path, plan_id=str(uuid4()), turn_id=turn["id"], client_id=conv["client_id"])
    with_session(path, conv, sid, home, work)
    mcp_file = config.AGENT_CHAT_DIR / "mcp" / f"{conv['id']}.json"
    mcp_file.parent.mkdir(parents=True, exist_ok=True)
    mcp_file.write_text("{}", encoding="utf-8")
    keep, _ = make_conv(path, "남길 대화")
    gone = client.delete(f"/api/agent-chat/conversations/{conv['id']}", headers=headers)
    assert gone.status_code == 200 and gone.json() == {"deleted": True, "session_file": "deleted"}
    assert not (home / "projects" / "proj-a" / f"{sid}.jsonl").exists() and (home / "projects" / "proj-a" / "other.jsonl").exists()
    assert not mcp_file.exists()
    with chat_store.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM agent_chat_turn WHERE conversation_id=?", (conv["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM agent_chat_event WHERE turn_id=?", (turn["id"],)).fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM agent_chat_plan_binding WHERE turn_id=?", (turn["id"],)).fetchone()[0] == 0
    assert row(path, keep["id"]) is not None
    assert chat_store.finish_turn(path, turn["id"], "done") is False  # 지운 차례에 끝남 사건이 되살아나지 않는다
    assert chat_store.events_after(path, turn["id"]) == []
    with pytest.raises(LookupError):
        chat_store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text="q", context={})
    assert client.delete(f"/api/agent-chat/conversations/{conv['id']}", headers=headers).status_code == 404
    busy, _ = make_conv(path, "도는 대화", running=True)
    assert client.delete(f"/api/agent-chat/conversations/{busy['id']}", headers=headers).status_code == 409
    assert row(path, busy["id"]) is not None


@pytest.mark.parametrize("case,expected", [
    ("other_cwd", "not_found"), ("two_candidates", "not_found"), ("no_evidence", "not_found"),
    ("not_uuid", "not_found"), ("codex", "codex_kept"), ("no_session", "none"), ("unlink_fails", "failed"),
    ("lstat_error", "not_found"),
])
def test_delete_session_file_safety(hub, tmp_path, monkeypatch, case, expected):
    client, headers, path, _ = panel(hub)
    work = tmp_path / "work"
    sid = str(uuid4())
    home = session_home(tmp_path, work, sid, folders=("proj-a", "proj-b") if case == "two_candidates" else ("proj-a",),
                        lines_cwd=str(tmp_path / "elsewhere") if case == "other_cwd" else None)
    conv, _ = make_conv(path, engine="codex" if case == "codex" else "claude")
    if case != "no_session":
        with_session(path, conv, "S-not-uuid" if case == "not_uuid" else sid,
                     None if case == "no_evidence" else home, None if case == "no_evidence" else work)
    target = home / "projects" / "proj-a" / f"{sid}.jsonl"
    if case == "unlink_fails":
        original = Path.unlink
        monkeypatch.setattr(Path, "unlink", lambda self, *a, **k: (_ for _ in ()).throw(PermissionError("locked")) if self == target else original(self, *a, **k))
    if case == "lstat_error":
        original_lstat = os.lstat
        monkeypatch.setattr(claude.os, "lstat", lambda p, *a, **k: (_ for _ in ()).throw(PermissionError("denied")) if Path(p) == target else original_lstat(p, *a, **k))
    body = client.delete(f"/api/agent-chat/conversations/{conv['id']}", headers=headers).json()
    assert body == {"deleted": True, "session_file": expected}
    assert target.exists()  # 확인되지 않은 파일은 그대로


# ⑥ 종료 지점 — 시작 실패(오류 사건 포함)·실행 없는 취소 정리도 끝남 사건·unread 를 함께
def test_start_failed_and_no_runtime_cancel_finish_together(hub, monkeypatch):
    client, headers, path, service = panel(hub)
    monkeypatch.setattr(service, "start_turn", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    failed = start_turn(client, headers)
    assert failed.status_code == 503
    conv_id = chat_store.list_conversations(path)[0]["id"]
    turn = chat_store.turns_for(path, conv_id)[0]
    assert turn["status"] == "failed"
    kinds = [(e["kind"], e.get("message"), e.get("status")) for e in chat_store.events_after(path, turn["id"])]
    assert kinds == [("error", "AI 프로그램을 시작하지 못했습니다.", None), ("state", None, "failed")]
    assert row(path, conv_id)["unread"] == 1
    conv, running = make_conv(path, "남은 차례", running=True)
    identity = service.session_identity(headers["X-MVHub-Panel"])
    assert service.cancel(identity, running["id"]) == "cancelled"
    last = chat_store.events_after(path, running["id"])[-1]
    assert (last["kind"], last["status"], row(path, conv["id"])["unread"]) == ("state", "cancelled", 1)


# 독립 리뷰 P1 — 취소 표시와 그 사건은 한 트랜잭션: 끝남이 먼저면 cancelling 이 안 붙고, 지운 차례엔 사건이 안 생긴다
def test_cancelling_is_atomic_with_its_event(hub):
    _, _, path, _ = panel(hub)
    _, turn = make_conv(path, running=True)
    assert chat_store.finish_turn(path, turn["id"], "done") is True
    assert chat_store.mark_cancelling(path, turn["id"]) is False  # 끝남 뒤 — 상태도 사건도 그대로
    assert [e["status"] for e in chat_store.events_after(path, turn["id"])] == ["done"]
    conv, turn = make_conv(path, running=True)
    assert chat_store.mark_cancelling(path, turn["id"]) is True
    assert chat_store.finish_turn(path, turn["id"], "cancelled") is True
    assert [e["status"] for e in chat_store.events_after(path, turn["id"])] == ["cancelling", "cancelled"]
    chat_store.delete_conversation(path, conv["id"])
    assert chat_store.mark_cancelling(path, turn["id"]) is False and chat_store.events_after(path, turn["id"]) == []


# 독립 리뷰 P2 — 복원은 한 읽기 시점: 대화를 읽은 뒤 차례가 끝나도 '끝난 차례 + 이전 읽지 않음'이 같이 오지 않는다
def test_restore_reads_one_snapshot(hub, monkeypatch):
    _, _, path, _ = panel(hub)
    conv, turn = make_conv(path, running=True)
    real = chat_store.connect
    fired = []

    class Proxy:
        def __init__(self, conn):
            self.conn = conn

        def execute(self, sql, *args):
            if "FROM agent_chat_turn" in sql and not fired:  # 대화를 읽은 뒤·차례를 읽기 전에 다른 연결이 차례를 끝낸다
                fired.append(1)
                with real(path) as other:
                    chat_store._tx(other)
                    chat_store._finish(other, turn["id"], "done", None, None)
                    other.execute("COMMIT")
            return self.conn.execute(sql, *args)

    import contextlib

    @contextlib.contextmanager
    def spying(p):
        with real(p) as conn:
            yield Proxy(conn)

    monkeypatch.setattr(chat_store, "connect", spying)
    snap = chat_store.restore_snapshot(path, conv["id"], 100)
    monkeypatch.setattr(chat_store, "connect", real)
    assert fired and (snap["unread"], snap["turns"][-1]["status"]) == (0, "running")  # 같은 시점 — 화면은 이어 받아 끝남을 본다
    assert chat_store.get_turn(path, turn["id"])["status"] == "done"


# ⑦ 띄울 때 잡은 환경의 자격 폴더(상대 CLAUDE_CONFIG_DIR = 자식 작업 폴더 기준)
def test_claude_home_rules(tmp_path):
    work = tmp_path / "work"
    assert claude.claude_home({"CLAUDE_CONFIG_DIR": "rel\\cfg"}, work) == os.path.normpath(str(work / "rel" / "cfg"))
    assert claude.claude_home({"CLAUDE_CONFIG_DIR": str(tmp_path / "abs")}, work) == os.path.normpath(str(tmp_path / "abs"))
    assert claude.claude_home({"USERPROFILE": str(tmp_path / "me")}, work) == os.path.normpath(str(tmp_path / "me" / ".claude"))


@windows
def test_real_turn_records_cli_home_and_marks_unread(hub, monkeypatch, tmp_path):
    client, headers, path, _ = panel(hub)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cfg"))
    body = start_turn(client, headers).json()
    done = wait_status(client, headers, body["turn_id"], {"done"})
    state = [e for e in done["events"] if e["kind"] == "state"]
    stored = row(path, body["conversation_id"])
    assert stored["cli_home"] == os.path.normpath(str(tmp_path / "cfg"))
    assert stored["cli_cwd"] == os.path.normpath(str(config.AGENT_CHAT_DIR / "work"))
    assert stored["unread"] == 1 and (not state or state[-1]["unread_rev"] == stored["unread_rev"])
