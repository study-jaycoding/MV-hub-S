"""Claude 앱 backend — 격리 DB·합성 기록·가짜 실행기, 실제 CLI/앱 실행 없음."""
import asyncio
import contextlib
import json
import logging
import sqlite3
import subprocess
import sys
import threading
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app import config
from app.repo import agent_chat as store
from app.routers import agent_chat as api
from app.services import agent_chat as chat
from app.services import agent_chat_claude as claude
from app.services import agent_chat_process as process
from app.services import agent_chat_transcript as tr
from test_agent_chat_api import hub, panel_headers, HEADERS, FAKE  # noqa: F401
from test_agent_chat_transcript import transcript  # noqa: F401


@pytest.fixture
def app_chat(hub, transcript, monkeypatch):
    client, _, service = hub
    cases, file, write, read, anchor = transcript
    monkeypatch.setenv("USERPROFILE", str(file.parent.parent.parent.parent))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.setattr(claude, "claude_state", lambda prefix: {"state": "ready", "version": "2.1.296", "subscription": "Max"})
    monkeypatch.setattr(claude, "desktop_precheck", lambda *args: None)
    monkeypatch.setattr(claude.ClaudeLock, "acquire", lambda self: None)
    monkeypatch.setattr(claude.ClaudeLock, "release", lambda self: None)
    monkeypatch.setattr(claude, "reap_desktop_launcher", lambda launcher: True)
    headers = panel_headers(client)
    identity = service.session_identity(headers["X-MVHub-Panel"])
    path = identity.db_file()
    conv = store.create_conversation(path, engine="claude", model="haiku", effort="low", client_id="synthetic-client",
                                     mcp_entry={}, title="합성 대화")
    base = json.loads(file.read_text(encoding="utf-8").splitlines()[0])
    store.update_conversation(path, conv["id"], cli_session_id=cases["session_id"], cli_home=str(file.parent.parent.parent), cli_cwd=base["cwd"])
    turn, _ = store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text="허브 질문", context={})
    store.finish_turn(path, turn["id"], "done")
    spawned = []

    def launch(prefix, sid, cwd, env, current, before_resume):
        current()
        before_resume(12345, 45678)
        spawned.append((sid, cwd, env))
        return {"phase": "handed", "code": 0}

    monkeypatch.setattr(claude, "open_desktop", launch)
    return SimpleNamespace(client=client, headers=headers, identity=identity, service=service, path=path, cid=conv["id"],
                           cases=cases, file=file, write=write, read=read, anchor=anchor, spawned=spawned,
                           url=f"/api/agent-chat/conversations/{conv['id']}/claude-app")


def open_app(a, **values):
    request = {"request_id": str(uuid4()), "expected_revision": 0, **values}
    response = a.client.post(a.url + "/open", headers=a.headers, json=request)
    return request, response


def bring(a, opened, **values):
    request = {"request_id": str(uuid4()), "expected_revision": opened["app_revision"], "handoff_id": opened["app_handoff"]["id"],
               "unlock_only": False, **values}
    response = a.client.post(a.url + "/bring-back", headers=a.headers, json=request)
    return request, response


def test_roundtrip_atomic_import_public_snapshot_mcp_and_same_resume(app_chat):
    a = app_chat
    _, response = open_app(a)
    assert response.status_code == 200, response.text
    opened = response.json()
    assert opened["app_handoff"]["state"] == "handed" and opened["app_revision"] == 1
    assert chat.chat_list(a.path, search=None, limit=20, cursor=None)["conversations"][0]["in_claude_app"] is True
    a.write(a.cases["base"] + a.cases["normal"])
    request, response = bring(a, opened)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["imported"] == 2 and result["app_handoff"] is None and result["app_revision"] == 2
    assert a.client.post(a.url + "/bring-back", headers=a.headers, json=request).json() == result
    snapshot = store.restore_snapshot(a.path, a.cid, 5000)
    assert len(snapshot["turns"]) == 3 and snapshot["unread"]
    assert snapshot["cli_session_id"] == a.cases["session_id"]
    assert snapshot["turns"][1]["origin"] == "claude_app" and "context" not in snapshot["turns"][1]
    assert snapshot["turns"][2]["events"][-1]["status"] == "done"
    mcp = chat.chat_read(a.path, a.cid, limit=20, cursor=None, model_names={}, live=lambda _: False)
    assert mcp["conversation"]["in_claude_app"] is False and mcp["turns"][1]["import"]["origin"] == "claude_app"
    assert mcp["turns"][1]["plans"] == []
    public = a.client.get(f"/api/agent-chat/conversations/{a.cid}", headers=a.headers).json()
    serialized = json.dumps(public)
    assert a.cases["session_id"] not in serialized and str(a.file) not in serialized and "source_uuid" not in serialized
    row = store.get_conversation(a.path, a.cid)
    command = process.build_command("claude", ["fake"], model="haiku", effort="low", resume=row["cli_session_id"],
                                    mcp_entry={}, mcp_file=a.file.parent / "mcp.json", work=a.file.parent)
    assert command[command.index("--resume") + 1] == a.cases["session_id"]


def test_open_titles_app_session_and_import_still_works(app_chat):
    a = app_chat
    _, response = open_app(a)
    opened = response.json()
    lines = a.file.read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[-1]) == {"type": "custom-title", "customTitle": "MV Agent · 합성 대화", "sessionId": a.cases["session_id"]}
    cwd = json.loads(lines[0])["cwd"]
    with a.file.open("a", encoding="utf-8", newline="\n") as stream:  # 앱이 제목 줄 뒤에 이어 적은 모양
        for row in a.cases["normal"]:
            stream.write(json.dumps({"sessionId": a.cases["session_id"], "cwd": cwd, **row}, ensure_ascii=False) + "\n")
    _, back = bring(a, opened)
    assert back.status_code == 200, back.text
    assert back.json()["imported"] == 2


def test_title_rollback_failure_keeps_lock_and_never_launches(app_chat, monkeypatch):
    a = app_chat
    monkeypatch.setattr(tr, "rename_session", lambda *args: (_ for _ in ()).throw(tr.TranscriptError("title_write_failed")))
    _, response = open_app(a)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first["app_handoff"]["state"] == "uncertain" and a.spawned == []
    assert chat.chat_list(a.path, search=None, limit=20, cursor=None)["conversations"][0]["in_claude_app"] is True
    _, again = open_app(a, expected_revision=first["app_revision"], handoff_id=first["app_handoff"]["id"])  # 새 요청으로 다시 열기
    assert again.status_code == 409 and again.json()["detail"] == "title_write_failed" and a.spawned == []


def test_reopen_does_not_write_title_while_app_may_be_writing(app_chat):
    a = app_chat
    _, response = open_app(a)
    first = response.json()
    anchor = store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])["anchor"]
    before = a.file.read_bytes()
    _, response = open_app(a, expected_revision=1, handoff_id=first["app_handoff"]["id"])
    assert response.status_code == 200, response.text
    assert a.file.read_bytes() == before and before.count(b'"custom-title"') == 1
    assert len(a.spawned) == 2
    assert store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])["anchor"] == anchor


def test_idempotency_reopen_stale_and_cross_conversation(app_chat):
    a = app_chat
    request, response = open_app(a)
    opened = response.json()
    assert a.client.post(a.url + "/open", headers=a.headers, json=request).json() == opened
    assert len(a.spawned) == 1
    assert a.file.read_bytes().count(b'"custom-title"') == 1  # 같은 요청 재시도는 제목 줄을 더하지 않는다
    changed = {**request, "expected_revision": 1}
    assert a.client.post(a.url + "/open", headers=a.headers, json=changed).status_code == 409
    _, back = bring(a, opened)
    assert back.json()["imported"] == 0
    _, second = open_app(a, expected_revision=2)
    assert second.json()["app_revision"] == 3
    assert a.client.post(a.url + "/open", headers=a.headers, json=request).json()["detail"] == "stale_handoff"
    assert bring(a, opened, unlock_only=True)[1].status_code == 409
    other = store.create_conversation(a.path, engine="claude", model="haiku", effort="low", client_id="other", mcp_entry={}, title="다른 대화")
    store.update_conversation(a.path, other["id"], cli_session_id=a.cases["session_id"])
    request["expected_revision"] = second.json()["app_revision"]
    request["handoff_id"] = second.json()["app_handoff"]["id"]
    assert a.client.post(f"/api/agent-chat/conversations/{other['id']}/claude-app/open", headers=a.headers, json=request).status_code == 409
    assert len(a.spawned) == 2


@pytest.mark.parametrize("reason", ["job", "launch", "identify"])
def test_open_failure_classification_survives_idempotent_retry(app_chat, monkeypatch, reason):
    a = app_chat
    monkeypatch.setattr(claude, "open_desktop", lambda *args: {"phase": "idle", "code": None, "open_failed": reason})
    request, response = open_app(a)
    assert response.status_code == 200
    assert response.json()["open_failed"] == reason and response.json()["app_handoff"] is None
    monkeypatch.setattr(claude, "open_desktop", lambda *args: pytest.fail("cached request must not launch"))
    assert a.client.post(a.url + "/open", headers=a.headers, json=request).json() == response.json()
    state = store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])
    assert state["last_request"]["result"]["open_failed"] == reason


def test_unreaped_launcher_blocks_reopen_import_and_unlock(app_chat, monkeypatch):
    a = app_chat
    launch = claude.open_desktop

    def uncertain(*args):
        launch(*args)
        return {"phase": "uncertain", "code": None}

    monkeypatch.setattr(claude, "open_desktop", uncertain)
    _, response = open_app(a)
    opened = response.json()
    raw = store.get_conversation(a.path, a.cid)["app_handoff"]
    assert json.loads(raw)["launcher"] == {"pid": 12345, "start": 45678}
    monkeypatch.setattr(claude, "reap_desktop_launcher", lambda launcher: False)
    for response in (open_app(a, expected_revision=1, handoff_id=opened["app_handoff"]["id"])[1],
                     bring(a, opened)[1], bring(a, opened, unlock_only=True)[1]):
        assert response.status_code == 409 and response.json()["detail"] == "launcher_uncertain"
    assert store.get_conversation(a.path, a.cid)["app_handoff"] == raw
    assert len(store.turns_for(a.path, a.cid)) == 1 and len(a.spawned) == 1


@pytest.mark.parametrize("fault", ["env", "empty_env", "saved_home"])
def test_custom_config_blocks_public_state_and_open(app_chat, monkeypatch, fault):
    a = app_chat
    if fault == "saved_home":
        store.update_conversation(a.path, a.cid, cli_home=str(a.file.parent / "custom"))
    else:
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", "" if fault == "empty_env" else str(a.file.parent.parent.parent))
    response = a.client.get(f"/api/agent-chat/conversations/{a.cid}", headers=a.headers)
    assert response.status_code == 200
    public = response.json()["conversation"]
    summary = store.conversation_summary(a.path, a.cid)
    for value in (public, summary):
        assert value["open_app_block"] == "custom_config_dir" and value["can_open_app"] is False
        assert "cli_home" not in value and "_home" not in value
    _, response = open_app(a)
    assert response.status_code == 409 and response.json()["detail"] == "custom_config_dir"
    assert not store.has_handoff(a.path) and a.spawned == []


def test_import_and_regular_turns_in_same_second_keep_insertion_order(app_chat, monkeypatch):
    a = app_chat
    connect = store.connect
    frozen = "2030-01-02 03:04:05"

    @contextlib.contextmanager
    def same_second(*args, **kwargs):
        with connect(*args, **kwargs) as conn:
            conn.create_function("datetime", 1, lambda value: frozen)
            yield conn

    monkeypatch.setattr(store, "connect", same_second)
    before, _ = store.claim_turn(a.path, conversation_id=a.cid, idempotency_key=uuid4().hex, text="앞 일반 차례", context={})
    store.finish_turn(a.path, before["id"], "done")
    _, opened = open_app(a)
    a.cases["normal"][0]["timestamp"] = "2026-11-19T01:02:03.456Z"
    a.write(a.cases["base"] + a.cases["normal"])
    assert bring(a, opened.json())[1].json()["imported"] == 2
    after, _ = store.claim_turn(a.path, conversation_id=a.cid, idempotency_key=uuid4().hex, text="뒤 일반 차례", context={})
    store.finish_turn(a.path, after["id"], "done")
    turns = store.turns_for(a.path, a.cid)[1:]
    assert [t["text"] for t in turns] == ["앞 일반 차례", "앱 첫 질문", "[그림]", "뒤 일반 차례"]
    assert all(t["created_at"] == frozen for t in turns)
    with store.connect(a.path) as conn:
        context = json.loads(conn.execute("SELECT context FROM agent_chat_turn WHERE id=?", (turns[1]["id"],)).fetchone()[0])
    assert context["source_at"] == "2026-11-19T01:02:03.456Z"


def test_compact_without_new_words_imports_zero_and_unlocks(app_chat):
    a = app_chat
    _, opened = open_app(a)
    boundary, summary = a.cases["compact"][:2]
    boundary["logicalParentUuid"] = "a0"
    a.write(a.cases["base"] + [boundary, summary])
    _, response = bring(a, opened.json())
    assert response.status_code == 200 and response.json()["imported"] == 0
    assert response.json()["app_handoff"] is None and not store.has_handoff(a.path)


def test_fork_transaction_handoff_conflict_stays_409(app_chat, monkeypatch):
    a = app_chat
    fork = store.fork_conversation

    def handoff_before_transaction(*args, **kwargs):
        state = {"phase": "handed", "revision": 1, "handoff_id": str(uuid4()), "at": "synthetic", "anchor": a.anchor}
        store.write_handoff(a.path, a.cid, None, state, still_current=lambda: None)
        return fork(*args, **kwargs)

    monkeypatch.setattr(store, "fork_conversation", handoff_before_transaction)
    response = a.client.post(f"/api/agent-chat/conversations/{a.cid}/fork", headers=a.headers, json={"request_id": str(uuid4())})
    assert response.status_code == 409 and response.json()["detail"] == "in_claude_app"
    assert "X-MVHub-Account-Changed" not in response.headers
    assert len(store.list_conversations(a.path)) == 1


def test_handoff_blocks_transactions_and_unstarted_forks_permanently(app_chat, monkeypatch):
    a = app_chat
    fork = store.fork_conversation(a.path, a.cid, request_id=str(uuid4()), client_id="fork", mcp_entry={})
    assert fork["fork_state"] == "ready"
    original = claude.open_desktop

    def during_opening(*args):
        assert store.get_conversation(a.path, fork["id"])["fork_turn"] is not None
        with pytest.raises(HTTPException):
            store.claim_turn(a.path, conversation_id=fork["id"], idempotency_key=uuid4().hex, text="race", context={})
        return original(*args)

    monkeypatch.setattr(claude, "open_desktop", during_opening)
    _, response = open_app(a)
    opened = response.json()
    assert store.fork_state_for(a.path, fork["id"]) == "source_changed"
    for operation in (
        lambda: store.claim_turn(a.path, conversation_id=a.cid, idempotency_key=uuid4().hex, text="x", context={}),
        lambda: store.claim_turn(a.path, conversation_id=fork["id"], idempotency_key=uuid4().hex, text="x", context={}),
        lambda: store.fork_precheck(a.path, a.cid),
        lambda: store.fork_conversation(a.path, a.cid, request_id=str(uuid4()), client_id="fork", mcp_entry={}),
        lambda: store.delete_conversation(a.path, a.cid),
    ):
        with pytest.raises(HTTPException) as error:
            operation()
        assert error.value.status_code == 409
    for method, suffix, body in (("delete", "", None), ("post", "/fork", {"request_id": str(uuid4())})):
        assert a.client.request(method, f"/api/agent-chat/conversations/{a.cid}" + suffix, headers=a.headers, json=body).status_code == 409
    with pytest.raises(HTTPException):
        with a.service.restore_guard([a.identity]):
            pytest.fail("locked restore")
    assert store.has_active(a.path) is False
    assert store.patch_conversation(a.path, a.cid, {"title": "이름은 허용"})["title"] == "이름은 허용"
    assert bring(a, opened, unlock_only=True)[1].status_code == 200
    assert store.fork_state_for(a.path, fork["id"]) == "source_changed"


def test_imported_turns_survive_fork_with_no_plan_bindings(app_chat):
    a = app_chat
    _, opened = open_app(a)
    a.write(a.cases["base"] + a.cases["normal"])
    assert bring(a, opened.json())[1].status_code == 200
    source = store.restore_snapshot(a.path, a.cid, 5000)
    fork = store.fork_conversation(a.path, a.cid, request_id=str(uuid4()), client_id="fork", mcp_entry={})
    copied = store.restore_snapshot(a.path, fork["id"], 5000)
    assert copied["turns"][1]["origin"] == source["turns"][1]["origin"] == "claude_app"
    assert copied["turns"][1]["handoff_id"] == source["turns"][1]["handoff_id"]
    assert copied["turns"][2]["omitted"] == source["turns"][2]["omitted"]
    assert store.bindings_for_conversation(a.path, fork["id"]) == []


@pytest.mark.parametrize("code", ["read_failed", "anchor_changed", "branched", "file_changed", "too_large"])
def test_read_failure_keeps_everything_and_unlock_only_marks_history(app_chat, monkeypatch, code):
    a = app_chat
    _, response = open_app(a)
    opened = response.json()
    before = store.turns_for(a.path, a.cid)

    def fail(*args):
        raise tr.TranscriptError(code)

    monkeypatch.setattr(tr, "read_session", fail)
    response = bring(a, opened)[1]
    assert response.status_code == (413 if code == "too_large" else 409)
    assert store.turns_for(a.path, a.cid) == before and store.has_handoff(a.path)
    request, result = bring(a, opened, unlock_only=True)
    assert result.status_code == 200 and result.json()["resumable"] is False and result.json()["imported"] == 0
    snapshot = store.restore_snapshot(a.path, a.cid, 5000)
    assert snapshot["turns"][-1]["unlock_only"] is True
    assert a.client.post(a.url + "/bring-back", headers=a.headers, json=request).json() == result.json()


@pytest.mark.parametrize("point", ["before_insert", "second_event", "commit"])
def test_import_rolls_back_all_rows_and_lock_on_failure(app_chat, monkeypatch, point):
    a = app_chat
    _, response = open_app(a)
    opened = response.json()
    a.write(a.cases["base"] + a.cases["normal"])
    request = {"request_id": str(uuid4()), "expected_revision": 1, "handoff_id": opened["app_handoff"]["id"], "unlock_only": False}
    turns = a.read(store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])["anchor"])
    original = store._append
    count = 0

    def append(*args):
        nonlocal count
        count += 1
        if point == "second_event" and count == 2:
            raise RuntimeError("synthetic write failure")
        return original(*args)

    monkeypatch.setattr(store, "_append", append)
    if point == "before_insert":
        turns[1]["source_uuid"] = turns[0]["source_uuid"]

    def current():
        if point == "commit":
            raise HTTPException(403, "changed")

    with pytest.raises((RuntimeError, HTTPException)):
        store.import_app_turns(a.path, a.cid, request, turns, resumable=True, still_current=current)
    assert len(store.turns_for(a.path, a.cid)) == 1 and store.has_handoff(a.path)


@pytest.mark.parametrize("body", [{"expected_revision": True}, {"expected_revision": "0"}, {"expected_revision": -1},
                                   {"command": "bad"}, {"session_id": "bad"}, {"handoff_id": "bad"}])
def test_strict_open_request(app_chat, body):
    assert open_app(app_chat, **body)[1].status_code == 422


@pytest.mark.parametrize("value", ["false", 0, 1, None])
def test_unlock_boolean_is_strict(app_chat, value):
    a = app_chat
    _, response = open_app(a)
    assert bring(a, response.json(), unlock_only=value)[1].status_code == 422


@pytest.mark.parametrize("phase,code", [("uncertain", 1), ("uncertain", None), ("idle", None)])
def test_launch_outcome_and_reopen_never_drop_existing_anchor(app_chat, monkeypatch, phase, code):
    a = app_chat
    request, response = open_app(a)
    first = response.json()
    anchor = store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])["anchor"]
    monkeypatch.setattr(claude, "open_desktop", lambda *args: {"phase": phase, "code": code})
    _, response = open_app(a, expected_revision=1, handoff_id=first["app_handoff"]["id"])
    assert response.status_code == 200, response.text
    assert response.json()["app_handoff"]["state"] == "uncertain"
    assert store.handoff_state(store.get_conversation(a.path, a.cid)["app_handoff"])["anchor"] == anchor


def test_restart_opening_uncertain_and_restore_clears_state(app_chat, monkeypatch):
    a = app_chat

    def interrupted(*args):
        args[-1](12345, 45678)
        raise OSError("synthetic crash")

    monkeypatch.setattr(claude, "open_desktop", interrupted)
    request, response = open_app(a)
    assert response.status_code == 503
    store._opened.discard(store.path_key(a.path))
    store.open_db(a.path)
    row = store.get_conversation(a.path, a.cid)
    state = store.handoff_state(row["app_handoff"])
    assert state["phase"] == "uncertain" and state["launcher"] == {"pid": 12345, "start": 45678}
    assert a.client.post(a.url + "/open", headers=a.headers, json=request).status_code == 409
    assert bring(a, store.app_fields(row), unlock_only=True)[1].status_code == 200
    with a.service.restore_guard([a.identity]):
        store.adopt_restored(a.path, "synthetic-restore")
    row = store.get_conversation(a.path, a.cid)
    assert row["app_handoff"] is None and row["app_opened_at"] is None and not row["resumable"]
    assert store.restore_snapshot(a.path, a.cid, 5000)["turns"][-1]["origin"] == "claude_app"


@pytest.mark.parametrize("raw", ["broken", "{}", '{"revision":1,"phase":"future"}', '{"revision":1,"phase":"handed"}'])
def test_corrupt_handoff_fails_closed(app_chat, raw):
    a = app_chat
    with store.connect(a.path) as conn:
        conn.execute("UPDATE agent_chat_conversation SET app_handoff=? WHERE id=?", (raw, a.cid))
    assert store.has_handoff(a.path)
    assert open_app(a)[1].status_code == 409
    assert store.conversation_summary(a.path, a.cid)["app_handoff"]["state"] == "uncertain"


def test_old_database_readonly_and_migration(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(store._SCHEMA)
        conn.execute("INSERT INTO agent_chat_conversation(id,engine,model,effort,client_id,mcp_entry,title) VALUES('old','claude','haiku','low','c','{}','old')")
    before = path.read_bytes()
    assert chat.chat_list(path, search=None, limit=10, cursor=None)["conversations"][0]["in_claude_app"] is False
    assert chat.chat_read(path, "old", limit=10, cursor=None, model_names={}, live=lambda _: False)["conversation"]["in_claude_app"] is False
    assert path.read_bytes() == before
    store.open_db(path)
    row = store.get_conversation(path, "old")
    assert row["app_handoff"] is None and row["app_opened_at"] is None


@pytest.mark.parametrize("stage", ["opening", "reading", "committed"])
def test_cancelled_request_keeps_lock_and_issuance_until_worker_finishes(app_chat, monkeypatch, stage):
    a = app_chat
    ready, release = threading.Event(), threading.Event()
    if stage == "opening":
        original = claude.open_desktop

        def pause(*args):
            ready.set()
            assert release.wait(10)
            return original(*args)

        monkeypatch.setattr(claude, "open_desktop", pause)
        endpoint = "/open"
        request = {"request_id": str(uuid4()), "expected_revision": 0}
    else:
        _, opened = open_app(a)
        a.write(a.cases["base"] + a.cases["normal"])
        request = {"request_id": str(uuid4()), "expected_revision": 1, "handoff_id": opened.json()["app_handoff"]["id"], "unlock_only": False}
        endpoint = "/bring-back"
        original = tr.read_session if stage == "reading" else store.import_app_turns

        def pause(*args, **kwargs):
            result = original(*args, **kwargs)
            ready.set()
            assert release.wait(10)
            return result

        monkeypatch.setattr(tr if stage == "reading" else store, "read_session" if stage == "reading" else "import_app_turns", pause)

    async def run():
        transport = httpx.ASGITransport(app=a.client.app, client=("127.0.0.1", 50431))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8012") as http:
            task = asyncio.create_task(http.post(a.url + endpoint, headers=a.headers, json=request))
            try:
                assert await asyncio.to_thread(ready.wait, 5)
                task.cancel()
                await asyncio.sleep(0.05)
                assert api._turn_lock(a.identity).locked() and not task.done()
                with pytest.raises(HTTPException) as caught:
                    with a.service.restore_guard([a.identity]):
                        pytest.fail("in-flight restore")
                assert caught.value.status_code == 409
            finally:
                release.set()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    a.client.portal.call(run)
    response = a.client.post(a.url + endpoint, headers=a.headers, json=request)
    assert response.status_code == 200
    assert len(a.spawned) == 1
    assert len(store.turns_for(a.path, a.cid)) == (1 if stage == "opening" else 3)


@pytest.mark.parametrize("stage", ["launch", "read", "commit"])
def test_identity_change_prevents_external_launch_or_import(app_chat, monkeypatch, stage):
    a = app_chat
    lost = False

    def current():
        if lost:
            raise HTTPException(403, "changed")

    if stage == "launch":
        def changed(*args):
            nonlocal lost
            lost = True

        monkeypatch.setattr(claude, "desktop_precheck", changed)
        request = {"request_id": str(uuid4()), "expected_revision": 0, "handoff_id": None}
        action = "open"
    else:
        _, opened = open_app(a)
        a.write(a.cases["base"] + a.cases["normal"])
        request = {"request_id": str(uuid4()), "expected_revision": 1, "handoff_id": opened.json()["app_handoff"]["id"], "unlock_only": False}
        action = "bring-back"
        original = tr.read_session if stage == "read" else store._append

        def changed(*args, **kwargs):
            nonlocal lost
            result = original(*args, **kwargs)
            lost = True
            return result

        monkeypatch.setattr(tr if stage == "read" else store, "read_session" if stage == "read" else "_append", changed)
    with pytest.raises(HTTPException) as error:
        a.service.claude_app(a.identity, a.cid, request, action, current)
    assert error.value.status_code == 403 and len(store.turns_for(a.path, a.cid)) == 1
    assert len(a.spawned) == (0 if stage == "launch" else 1)
    if stage != "launch":
        assert store.has_handoff(a.path)


def test_restored_or_fork_inflight_or_active_turn_cannot_open(app_chat, monkeypatch):
    a = app_chat
    monkeypatch.setattr(a.service, "forking_from", lambda sid: True)
    assert open_app(a)[1].json()["detail"] == "fork_running"
    monkeypatch.setattr(a.service, "forking_from", lambda sid: False)
    turn, _ = store.claim_turn(a.path, conversation_id=a.cid, idempotency_key=uuid4().hex, text="busy", context={})
    assert open_app(a)[1].json()["detail"] == "turn_active"
    store.finish_turn(a.path, turn["id"], "done")
    with a.service.restore_guard([a.identity]):
        store.adopt_restored(a.path, "restore")
    assert open_app(a)[1].json()["detail"] == "restored"
    assert a.spawned == []


def test_auth_panel_and_account_checks_apply(app_chat):
    a = app_chat
    body = {"request_id": str(uuid4()), "expected_revision": 0}
    assert a.client.post(a.url + "/open", headers=HEADERS, json=body).status_code == 401
    assert a.client.post(a.url + "/open", headers={**a.headers, "X-MVHub-Expect-Account": "acct:other@example.test"}, json=body).status_code == 409
    assert a.spawned == []


@pytest.mark.parametrize("fault,code", [("missing", "desktop_missing"), ("unknown", "desktop_unknown"), ("outdated", "outdated"),
                                       ("auth", "not_subscription"), ("home", "custom_config_dir"), ("cwd", "environment_changed"), ("token", "unsupported")])
def test_desktop_preflight(tmp_path, monkeypatch, fault, code):
    home, cwd = tmp_path / ".claude", tmp_path / "work"
    home.mkdir()
    cwd.mkdir()
    monkeypatch.setattr(claude, "_login_token_problem", lambda: "other_user" if fault == "token" else None)
    monkeypatch.setattr(claude.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(claude, "claude_state", lambda _: {"state": "not_subscription" if fault == "auth" else "ready",
                                                        "version": "2.1.284" if fault == "outdated" else "2.1.296"})
    monkeypatch.setattr(claude, "desktop_installation", lambda: fault if fault in ("missing", "unknown") else "available")
    with pytest.raises(claude.Busy) as error:
        claude.desktop_precheck(["fake"], str(home), str(cwd / "gone" if fault == "cwd" else cwd),
                                {"USERPROFILE": str(tmp_path), **({"CLAUDE_CONFIG_DIR": str(tmp_path / "different")} if fault == "home" else {})})
    assert error.value.code == code


@pytest.mark.parametrize("fault", ["env", "empty_env", "saved_home"])
def test_desktop_preflight_rejects_custom_config_before_cli(tmp_path, monkeypatch, fault):
    env = {"USERPROFILE": str(tmp_path)}
    home = tmp_path / ".claude"
    if fault == "saved_home":
        home = tmp_path / "custom"
    else:
        env["CLAUDE_CONFIG_DIR"] = "" if fault == "empty_env" else str(home)
    monkeypatch.setattr(claude, "claude_state", lambda *args: pytest.fail("custom config must not query CLI"))
    with pytest.raises(claude.Busy) as error:
        claude.desktop_precheck(["fake"], str(home), str(tmp_path), env)
    assert error.value.code == "custom_config_dir"


def test_default_home_windows_spelling_is_equivalent(tmp_path):
    home = str(tmp_path / ".claude").upper().replace("\\", "/") + "/"
    assert not store.app_custom_config_dir(home, {"USERPROFILE": str(tmp_path)})


def test_default_home_is_resolved_once_per_profile(tmp_path, monkeypatch):
    calls = []
    original = store.path_key
    store._default_claude_home.cache_clear()

    def tracked(path):
        calls.append(str(path))
        return original(path)

    monkeypatch.setattr(store, "path_key", tracked)
    for _ in range(2):
        assert store.app_custom_config_dir(str(tmp_path / "custom"), {"USERPROFILE": str(tmp_path)})
    assert calls.count(str(tmp_path / ".claude")) == 1


@pytest.fixture
def launcher(monkeypatch):
    sequence = []

    class Proc:
        pid, _handle = 100, 200
        code, fail_wait, fail_kill = 0, False, False

        def poll(self):
            return None

        def wait(self, timeout):
            sequence.append(("wait", timeout))
            if self.fail_wait:
                raise subprocess.TimeoutExpired("fake", timeout)
            return self.code

        def kill(self):
            sequence.append("kill")
            if self.fail_kill:
                raise OSError("fake")

    proc = Proc()

    def popen(command, **kwargs):
        sequence.append((command, kwargs))
        return proc

    monkeypatch.setattr(claude.subprocess, "Popen", popen)
    monkeypatch.setattr(claude, "_in_any_job", lambda handle: False)
    monkeypatch.setattr(claude, "_k32", lambda: object())
    monkeypatch.setattr(claude, "_handle_start", lambda *args: 300)
    monkeypatch.setattr(claude, "_resume", lambda p: sequence.append("resume"))
    return proc, sequence


def launch(sequence):
    return claude.open_desktop(["fake"], "session", "work", {"SAFE": "1"}, lambda: sequence.append("current"),
                               lambda pid, start: sequence.append(("record", pid, start)))


def test_exact_desktop_options_and_record_before_resume(launcher, caplog):
    proc, sequence = launcher
    caplog.set_level(logging.INFO, logger=claude.__name__)
    assert launch(sequence) == {"phase": "handed", "code": 0}
    command, options = sequence[1]
    assert command == ["fake", "--desktop", "--resume", "session"]
    assert options["creationflags"] == claude.CREATE_NEW_CONSOLE | claude.CREATE_BREAKAWAY_FROM_JOB | process.CREATE_SUSPENDED
    assert options["startupinfo"].dwFlags == subprocess.STARTF_USESHOWWINDOW
    assert options["startupinfo"].wShowWindow == subprocess.SW_HIDE
    assert options["stdin"] is options["stdout"] is options["stderr"] is None
    assert options["close_fds"] is True and options["shell"] is False
    assert options["env"] == {"SAFE": "1"} and options["cwd"] == "work"
    assert sequence[2:] == ["current", ("record", 100, 300), "resume", ("wait", 30)]
    records = [record for record in caplog.records if record.name == claude.__name__]
    assert len(records) == 1 and records[0].getMessage().startswith("Claude desktop exit_code=0 classification=handed seconds=")


@pytest.mark.parametrize("job", [True, None])
@pytest.mark.parametrize("cleanup", [True, False])
def test_job_not_confirmed_never_resumes(launcher, monkeypatch, job, cleanup):
    proc, sequence = launcher
    monkeypatch.setattr(claude, "_in_any_job", lambda handle: job)
    proc.fail_kill = not cleanup
    result = launch(sequence)
    assert result["phase"] == ("idle" if cleanup else "uncertain") and result["open_failed"] == "job"
    assert "resume" not in sequence and "kill" in sequence


@pytest.mark.parametrize("fault", ["nonzero", "timeout", "resume", "identity", "record", "start_time", "create"])
def test_launch_failure_classification(launcher, monkeypatch, caplog, fault):
    proc, sequence = launcher
    caplog.set_level(logging.INFO, logger=claude.__name__)
    if fault == "nonzero":
        proc.code = 1
    elif fault == "timeout":
        proc.fail_wait = True
    elif fault == "resume":
        monkeypatch.setattr(claude, "_resume", lambda p: (_ for _ in ()).throw(OSError("fake")))
    elif fault == "start_time":
        monkeypatch.setattr(claude, "_handle_start", lambda *args: None)
    elif fault == "create":
        denied = OSError("sensitive-path-session-output")
        denied.winerror = 5
        monkeypatch.setattr(claude.subprocess, "Popen", lambda *a, **k: (_ for _ in ()).throw(denied))
    if fault in ("identity", "record"):
        def fail(*args):
            raise HTTPException(403, "changed")
        with pytest.raises(HTTPException):
            claude.open_desktop(["fake"], "session", "work", {}, fail if fault == "identity" else lambda: None,
                                fail if fault == "record" else lambda *args: None)
        assert "resume" not in sequence
    else:
        result = launch(sequence)
        assert result["phase"] == ("idle" if fault in ("start_time", "create") else "uncertain")
        if fault in ("start_time", "create"):
            assert result["open_failed"] == ("identify" if fault == "start_time" else "launch")
    records = [record for record in caplog.records if record.name == claude.__name__]
    assert len(records) == 1 and "seconds=" in records[0].getMessage()
    assert not any(value in records[0].getMessage() for value in ("sensitive", "session", "work", "fake"))


@pytest.mark.parametrize("value,code,expected", [("available", 0, "available"), ("missing", 0, "missing"), ("unknown", 0, "unknown"),
                                                ("available", 1, "unknown"), ("bad", 0, "unknown")])
def test_installation_three_states(monkeypatch, value, code, expected):
    monkeypatch.setattr(claude.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=value, returncode=code))
    assert claude.desktop_installation() == expected


def test_fake_desktop_rejects_redirected_output(tmp_path):
    result = subprocess.run([sys.executable, "-B", str(FAKE), "--desktop", "--resume", "synthetic"],
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 1 and "redirected output" in result.stderr


@pytest.mark.parametrize("actual,wait,terminate,expected", [(300, 258, True, True), (301, 258, True, True),
                                                          (None, 258, True, False), (300, 0, True, True), (300, 258, False, False)])
def test_recovery_only_terminates_verified_launcher_handle(monkeypatch, actual, wait, terminate, expected):
    calls = []

    class Terminate:
        def __call__(self, handle, code):
            calls.append(("terminate", handle))
            return terminate

    kernel = SimpleNamespace(OpenProcess=lambda *args: 200, CloseHandle=lambda handle: calls.append(("close", handle)),
                             WaitForSingleObject=lambda handle, timeout: wait if timeout == 0 else 0, TerminateProcess=Terminate())
    monkeypatch.setattr(claude, "_k32", lambda: kernel)
    monkeypatch.setattr(claude, "_handle_start", lambda *args: actual)
    assert claude.reap_desktop_launcher({"pid": 100, "start": 300}) is expected
    assert ("terminate", 200) in calls if actual == 300 and wait != 0 else ("terminate", 200) not in calls
    assert calls[-1] == ("close", 200)


def test_installation_query_failure_is_unknown(monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("synthetic")

    monkeypatch.setattr(claude.subprocess, "run", fail)
    assert claude.desktop_installation() == "unknown"
