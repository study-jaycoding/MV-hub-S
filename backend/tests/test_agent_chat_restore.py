"""전체복원 Agent 경계 — 임시 SQLite·가짜 CLI만 사용한다."""
import asyncio
import contextlib
import json
import sqlite3
import threading
from contextvars import copy_context
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app import config, db
from app.repo import agent_chat as store
from app.repo import mcp_v2 as mcp_store
from app.routers import agent_chat as router, mcp_v2 as api
from app.services import agent_chat as chat, agent_chat_process as process
from test_agent_chat_api import hub, panel_headers, start_turn, wait_status, windows, EMAIL
from test_agent_chat_mcp_read import make_conv, plan_event, local, register, read, own_path, identity as read_identity


def identities(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "chat")
    return (chat.Identity("old", str(tmp_path / "hub.db"), EMAIL),
            chat.Identity("new", str(tmp_path / "hub.db"), EMAIL))


@pytest.mark.parametrize("busy", ["runtime", "issuance"])
def test_busy_rejects_without_epoch_gate_or_cache_changes(tmp_path, monkeypatch, busy):
    old, new = identities(tmp_path, monkeypatch)
    old.db_file()
    service = chat.AgentChat()
    if busy == "runtime":
        service._runtimes["busy"] = SimpleNamespace(path=old.file_path())
    before = (dict(store._epochs), set(store._gates), set(store._opened))
    with service.issuance(old) if busy == "issuance" else contextlib.nullcontext():
        with pytest.raises(HTTPException) as caught:
            with service.restore_guard((old, new)):
                pytest.fail("busy restore entered")
    assert caught.value.status_code == 409
    assert before == (dict(store._epochs), set(store._gates), set(store._opened))


def test_both_paths_drain_until_actual_close_and_late_context_cannot_write(tmp_path, monkeypatch):
    old, new = identities(tmp_path, monkeypatch)
    for ident in (old, new):
        ident.db_file()
    service = chat.AgentChat()
    closing, release, admitted, gate_closed = (threading.Event() for _ in range(4))
    real_connect, real_close = store.sqlite3.connect, store.close_admission

    class SlowClose(sqlite3.Connection):
        def close(self):
            closing.set()
            assert release.wait(5)
            super().close()

    monkeypatch.setattr(store.sqlite3, "connect", lambda *a, **k: real_connect(*a, **k, factory=SlowClose))
    reader = threading.Thread(target=lambda: _read_once(new.file_path()))
    reader.start()
    assert closing.wait(3)
    monkeypatch.setattr(store.sqlite3, "connect", real_connect)

    def close(paths):
        keys = real_close(paths)
        gate_closed.set()
        return keys

    monkeypatch.setattr(store, "close_admission", close)

    def restore():
        with service.restore_guard((old, new)):
            admitted.set()

    with store.request_scope():
        late = copy_context()
        installer = threading.Thread(target=restore)
        installer.start()
        assert gate_closed.wait(3)
        assert not admitted.is_set()
        for ident in (old, new):
            with pytest.raises(store.StaleRequest):
                ident.db_file()
        release.set()
        reader.join(3)
        installer.join(3)
        assert admitted.is_set()
        with pytest.raises(store.StaleRequest):
            late.run(old.db_file)
    assert old.db_file().is_file()


def _read_once(path):
    with store.connect_readonly(path) as conn:
        conn.execute("SELECT 1").fetchone()


def test_timeout_and_close_failure_never_enter_install(tmp_path, monkeypatch):
    old, new = identities(tmp_path, monkeypatch)
    old.db_file()
    service = chat.AgentChat()
    with store.connect(old.file_path()):
        with pytest.raises(store.StaleRequest):
            with service.restore_guard((old, new), timeout=0.01):
                pytest.fail("undrained installation")
    assert not ({store.path_key(old.file_path()), store.path_key(new.file_path())} & store._gates)
    real = store.sqlite3.connect

    class BrokenClose(sqlite3.Connection):
        def close(self):
            super().close()
            raise OSError("close did not report success")

    monkeypatch.setattr(store.sqlite3, "connect", lambda *a, **k: real(*a, **k, factory=BrokenClose))
    with pytest.raises(OSError):
        with store.connect(old.file_path()):
            pass
    with pytest.raises(store.StaleRequest):
        with service.restore_guard((old, new), timeout=0.01):
            pytest.fail("uncertain close installation")
    assert store._connections[store.path_key(old.file_path())] == 1


def test_failed_connection_open_releases_admission_count(tmp_path, monkeypatch):
    old, _ = identities(tmp_path, monkeypatch)
    path = old.file_path()
    with pytest.raises(sqlite3.OperationalError):
        with store.connect(path):
            pass
    assert store._connections[store.path_key(path)] == 0
    with chat.AgentChat().restore_guard((old,), timeout=0.01):
        pass


def test_request_arriving_while_gate_closed_stays_rejected_after_reopen(tmp_path, monkeypatch):
    old, new = identities(tmp_path, monkeypatch)
    old.db_file()
    with chat.AgentChat().restore_guard((old, new)):
        with store.request_scope():
            delayed = copy_context()
    with pytest.raises(store.StaleRequest):
        delayed.run(old.db_file)
    with pytest.raises(store.StaleRequest):
        delayed.run(new.db_file)
    assert not new.file_path().exists()


def test_adopt_keeps_events_bindings_but_removes_external_execution_fields(tmp_path, monkeypatch):
    old, new = identities(tmp_path, monkeypatch)
    path = old.db_file()
    plan = str(uuid4())
    conv, turns = make_conv(path, turns=[{"events": [("text", {"text": "과거 답"}), plan_event(plan)]}])
    store.update_conversation(path, conv["id"], cli_session_id="old-session", cli_home="old-home", cli_cwd="old-cwd")
    store.bind_plan(path, plan_id=plan, turn_id=turns[0]["id"], client_id=conv["client_id"])
    before = store.restore_snapshot(path, conv["id"], 5000)["turns"]
    with chat.AgentChat().restore_guard((old, new)):
        store.adopt_restored(path, "restore-one")
        with pytest.raises(store.StaleRequest):
            store.get_conversation(path, conv["id"])
    after = store.get_conversation(path, conv["id"])
    assert after["restored_from"] == "restore-one" and not after["resumable"]
    assert not any(after[k] for k in ("cli_session_id", "cli_home", "cli_cwd", "fork_session", "client_id", "mcp_entry"))
    assert before == store.restore_snapshot(path, conv["id"], 5000)["turns"]
    assert store.bindings_for_conversation(path, conv["id"])[0]["plan_id"] == plan
    with pytest.raises(store.ForkRefused):
        store.fork_precheck(path, conv["id"])
    with pytest.raises(HTTPException) as caught:
        store.claim_turn(path, conversation_id=conv["id"], idempotency_key=uuid4().hex, text="실행", context={})
    assert caught.value.status_code == 409


def test_reference_allowlist_budget_and_unrestored_rejection(tmp_path, monkeypatch):
    old, _ = identities(tmp_path, monkeypatch)
    path = old.db_file()
    conv, _ = make_conv(path, turns=[{"text": "질문" * 4000, "events": [("text", {"text": "답" * 25000}),
                                       ("tool", {"name": "secret-tool"}), plan_event(str(uuid4()))]}] * 25)
    with pytest.raises(HTTPException):
        chat.restored_reference(path, conv["id"])
    with chat.AgentChat().restore_guard((old,)):
        store.adopt_restored(path, "one")
    reference = chat.restored_reference(path, conv["id"])
    assert reference["earlier_turns"] > 0 and reference["truncated"]
    assert len(json.dumps(reference, ensure_ascii=False).encode()) < 33_000
    assert all(set(t) == {"you", "answer"} for t in reference["turns"])
    assert "secret-tool" not in json.dumps(reference)


def test_stale_finish_and_plain_thread_keep_original_epoch(tmp_path, monkeypatch):
    old, _ = identities(tmp_path, monkeypatch)
    path = old.db_file()
    conv, turns = make_conv(path, turns=[{"status": "running"}])
    service = chat.AgentChat()
    caught = []
    with store.request_scope():
        copied = copy_context()
        with service.restore_guard((old,)):
            pass

        def late():
            try:
                store.finish_turn(path, turns[0]["id"], "failed", error="must not be written")
            except store.StaleRequest:
                caught.append(True)

        thread = threading.Thread(target=copied.run, args=(late,))
        thread.start()
        thread.join(3)
    assert caught == [True]
    snapshot = store.restore_snapshot(path, conv["id"], 5000)
    assert snapshot["turns"][0]["status"] == "running" and snapshot["turns"][0]["events"] == []


def test_stale_start_does_not_call_failure_cleanup(hub, monkeypatch):
    client, _, service = hub
    headers = panel_headers(client)
    calls = []

    def stale(*args, **kwargs):
        raise store.StaleRequest()

    monkeypatch.setattr(service, "start_turn", stale)
    monkeypatch.setattr(store, "finish_turn", lambda *args, **kwargs: calls.append(True))
    assert start_turn(client, headers).status_code == 503
    assert calls == []


def test_stale_still_current_keeps_503(hub, monkeypatch):
    client, _, _ = hub
    headers, _, source, _ = _restored(hub)
    monkeypatch.setattr(api, "_still_current", lambda _: (_ for _ in ()).throw(store.StaleRequest()))
    assert client.get(f"/api/agent-chat/conversations/{source['id']}", headers=headers).status_code == 503


def _restored(hub):
    client, _, service = hub
    headers = panel_headers(client)
    ident = service.session_identity(headers["X-MVHub-Panel"])
    conv, turns = make_conv(ident.db_file(), turns=[{"text": "과거 사용자", "events": [("text", {"text": "과거 AI"})]}])
    with service.restore_guard((ident,)):
        store.adopt_restored(ident.file_path(), "restore-http")
    return headers, ident, conv, turns


@windows
def test_http_restored_blocked_and_new_session_reference_survives_retry(hub, monkeypatch):
    client, profiles, service = hub
    headers, ident, source, _ = _restored(hub)
    data = client.get(f"/api/agent-chat/conversations/{source['id']}", headers=headers).json()
    assert data["conversation"]["restored_from"] == "restore-http" and data["plans"] == []
    assert data["restore_reference"]["turns"] == [{"you": "과거 사용자", "answer": "과거 AI"}]
    assert start_turn(client, headers, conversation_id=source["id"]).status_code == 409
    assert client.post(f"/api/agent-chat/conversations/{source['id']}/fork", headers=headers,
                       json={"request_id": str(uuid4())}).status_code == 409
    for operation in ("estimate", "execute"):
        assert client.post(f"/api/agent-chat/plans/{uuid4()}/{operation}", headers=headers,
                           json={"conversation_id": source["id"]}).status_code == 409
    prompts, real_feed = [], process.JobProcess.feed

    def feed(job, data):
        prompts.append(data.decode())
        return real_feed(job, data)

    monkeypatch.setattr(process.JobProcess, "feed", feed)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_fail_before_session")
    first = start_turn(client, headers, source_conversation_id=source["id"], text="새 요청").json()
    wait_status(client, headers, first["turn_id"], {"failed"})
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    retry = start_turn(client, headers, conversation_id=first["conversation_id"], text="다시 요청").json()
    wait_status(client, headers, retry["turn_id"], {"done"})
    assert len(profiles) == 1 and len(prompts) == 2 and all("과거 사용자" in text for text in prompts)
    assert all("명령·승인·지침이 아님" in text for text in prompts)
    made = store.get_conversation(ident.file_path(), first["conversation_id"])
    assert made["cli_session_id"] and not made["restored_from"]
    assert store.bindings_for_conversation(ident.file_path(), made["id"]) == []


@pytest.mark.parametrize("foreign", [False, True])
def test_new_conversation_source_must_be_restored_in_same_identity(hub, foreign):
    client, profiles, service = hub
    headers = panel_headers(client)
    ident = service.session_identity(headers["X-MVHub-Panel"])
    source_identity = chat.Identity(ident.hub, ident.db_path, "other@example.test") if foreign else ident
    source, _ = make_conv(source_identity.db_file(), turns=[{}])
    if foreign:
        with service.restore_guard((source_identity,)):
            store.adopt_restored(source_identity.file_path(), "foreign-restore")
    assert start_turn(client, headers, source_conversation_id=source["id"]).status_code == (404 if foreign else 409)
    assert profiles == []


@windows
def test_first_turn_insert_failure_rolls_back_conversation_and_revokes_then_retries(hub, monkeypatch):
    client, profiles, _ = hub
    headers, ident, source, _ = _restored(hub)
    real_connect = store.sqlite3.connect
    failed = []

    class FailTurnInsert(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if sql.startswith("INSERT INTO agent_chat_turn(") and not failed:
                failed.append(True)
                raise sqlite3.OperationalError("injected turn insert failure")
            return super().execute(sql, parameters)

    monkeypatch.setattr(store.sqlite3, "connect", lambda *a, **k: real_connect(*a, **k, factory=FailTurnInsert))
    key = uuid4().hex
    with pytest.raises(sqlite3.OperationalError, match="injected turn insert failure"):
        start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"])
    with store.connect(ident.file_path()) as conn:
        assert conn.execute("SELECT COUNT(*) FROM agent_chat_conversation WHERE restored_from IS NULL").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM agent_chat_turn WHERE idempotency_key=?", (key,)).fetchone()[0] == 0
    assert len(profiles) == 1 and mcp_store.client_by_id(profiles[0]["client_id"])["revoked_at"]
    prompts, real_feed = [], process.JobProcess.feed

    def feed(job, data):
        prompts.append(data.decode())
        return real_feed(job, data)

    monkeypatch.setattr(process.JobProcess, "feed", feed)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    retry = start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"])
    assert retry.status_code == 200
    made = retry.json()
    wait_status(client, headers, made["turn_id"], {"done"})
    again = start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"]).json()
    assert again["turn_id"] == made["turn_id"] and again["conversation_id"] == made["conversation_id"]
    assert len(store.list_conversations(ident.file_path())) == 2  # 원본 한 개 + 새 대화 한 개
    assert len(profiles) == 2 and sum(not mcp_store.client_by_id(p["client_id"])["revoked_at"] for p in profiles) == 1
    assert len(prompts) == 1 and "과거 사용자" in prompts[0] and "명령·승인·지침이 아님" in prompts[0]


@pytest.mark.parametrize("read_name", ["get_turn", "get_conversation"])
def test_first_turn_committed_read_failure_preserves_key_and_credential(hub, monkeypatch, read_name):
    client, profiles, service = hub
    headers, ident, source, _ = _restored(hub)
    real_read = getattr(store, read_name)
    failed, starts = [], []

    def fail_read(path, row_id):
        if row_id != source["id"] and not failed:
            failed.append(True)
            raise sqlite3.OperationalError("injected committed read failure")
        return real_read(path, row_id)

    monkeypatch.setattr(store, read_name, fail_read)
    monkeypatch.setattr(service, "start_turn", lambda *a, **k: starts.append(True))
    key = uuid4().hex
    with pytest.raises(sqlite3.OperationalError, match="injected committed read failure"):
        start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"])
    turn = store.turn_by_key(ident.file_path(), key)
    assert turn and len(profiles) == 1
    assert not mcp_store.client_by_id(profiles[0]["client_id"])["revoked_at"]
    response = start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"])
    assert response.status_code == 200
    assert response.json() == {"turn_id": turn["id"], "conversation_id": turn["conversation_id"], "status": turn["status"]}
    assert len(store.list_conversations(ident.file_path())) == 2 and len(profiles) == 1 and starts == []
    made = store.get_conversation(ident.file_path(), turn["conversation_id"])
    assert json.loads(made["source_reference"])["turns"] == [{"you": "과거 사용자", "answer": "과거 AI"}]


def test_first_turn_revoke_failure_keeps_original_error_without_secret_log(hub, monkeypatch, caplog):
    client, _, _ = hub
    headers = panel_headers(client)

    def fail_claim(*a, **k):
        raise sqlite3.OperationalError("original claim failure")

    def fail_revoke(*a, **k):
        raise OSError("private-credential-must-not-be-logged")

    monkeypatch.setattr(store, "claim_turn", fail_claim)
    monkeypatch.setattr(mcp_store, "revoke", fail_revoke)
    with pytest.raises(sqlite3.OperationalError, match="original claim failure"):
        start_turn(client, headers)
    assert "credential cleanup could not be confirmed" in caplog.text
    assert "private-credential-must-not-be-logged" not in caplog.text


@windows
def test_first_turn_start_failure_replays_failed_turn_and_keeps_reference_for_next_turn(hub, monkeypatch):
    client, profiles, service = hub
    headers, ident, source, _ = _restored(hub)
    real_start, calls = service.start_turn, []

    def fail_once(*a, **k):
        calls.append(True)
        if len(calls) == 1:
            raise OSError("injected start failure")
        return real_start(*a, **k)

    monkeypatch.setattr(service, "start_turn", fail_once)
    key = uuid4().hex
    assert start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"]).status_code == 503
    first = store.turn_by_key(ident.file_path(), key)
    assert first["status"] == "failed" and first["reason"] == "start_failed"
    replay = start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"]).json()
    assert replay["turn_id"] == first["id"] and replay["status"] == "failed" and len(calls) == 1
    prompts, real_feed = [], process.JobProcess.feed

    def feed(job, data):
        prompts.append(data.decode())
        return real_feed(job, data)

    monkeypatch.setattr(process.JobProcess, "feed", feed)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    retry = start_turn(client, headers, conversation_id=first["conversation_id"]).json()
    wait_status(client, headers, retry["turn_id"], {"done"})
    assert retry["turn_id"] != first["id"] and retry["conversation_id"] == first["conversation_id"]
    assert len(profiles) == 1 and not mcp_store.client_by_id(profiles[0]["client_id"])["revoked_at"]
    assert len(prompts) == 1 and "과거 사용자" in prompts[0]


def test_deleted_source_returns_404_without_issuing_client(hub):
    client, profiles, _ = hub
    headers, ident, source, _ = _restored(hub)
    store.delete_conversation(ident.file_path(), source["id"])
    response = start_turn(client, headers, source_conversation_id=source["id"], text="작성 중인 새 요청")
    assert response.status_code == 404
    assert profiles == []


@windows
def test_edited_restore_retry_same_key_wins_before_delayed_original_capture(hub, monkeypatch):
    client, profiles, _ = hub
    headers, ident, source, _ = _restored(hub)
    captured, release = threading.Event(), threading.Event()
    real_capture, real_feed = api._capture, process.JobProcess.feed
    original, errors, prompts = [], [], []

    def delayed_capture(request):
        ctx = real_capture(request)
        if request.headers.get("X-Test-Delayed-Capture") == "1":
            captured.set()
            assert release.wait(15)
        return ctx

    def feed(job, data):
        prompts.append(data.decode())
        return real_feed(job, data)

    key = uuid4().hex

    def original_post():
        try:
            original.append(start_turn(client, {**headers, "X-Test-Delayed-Capture": "1"}, idempotency_key=key,
                                       source_conversation_id=source["id"], text="먼저 작성한 말", context={"tab": "my", "folder": "old"}))
        except BaseException as exc:
            errors.append(type(exc).__name__)

    monkeypatch.setattr(api, "_capture", delayed_capture)
    monkeypatch.setattr(process.JobProcess, "feed", feed)
    monkeypatch.setenv("FAKE_AGENT_SCENARIO", "claude_ok")
    thread = threading.Thread(target=original_post)
    thread.start()
    try:
        assert captured.wait(5)
        edited = start_turn(client, headers, idempotency_key=key, source_conversation_id=source["id"],
                            text="고쳐 쓴 말", context={"tab": "my", "folder": "new"})
        assert edited.status_code == 200
        made = edited.json()
        wait_status(client, headers, made["turn_id"], {"done"})
    finally:
        release.set()
        thread.join(10)
    assert not thread.is_alive() and errors == [] and len(original) == 1
    assert original[0].status_code == 200
    assert original[0].json() == {**made, "status": "done"}
    assert len(store.list_conversations(ident.file_path())) == 2  # 복원 원본 + 새 대화 한 개
    assert len(store.turns_for(ident.file_path(), made["conversation_id"])) == 1
    assert len(profiles) == 1 and not mcp_store.client_by_id(profiles[0]["client_id"])["revoked_at"]
    recorded = store.turn_by_key(ident.file_path(), key)
    assert recorded["text"] == "고쳐 쓴 말" and json.loads(recorded["context"])["folder"] == "new"
    assert len(prompts) == 1 and "고쳐 쓴 말" in prompts[0] and "과거 사용자" in prompts[0]
    assert "먼저 작성한 말" not in prompts[0]


def test_source_disappearing_during_reference_read_returns_404(hub, monkeypatch):
    _, ident, source, _ = _restored(hub)
    monkeypatch.setattr(chat, "chat_read", lambda *a, **k: None)
    with pytest.raises(HTTPException) as caught:
        chat.restored_reference(ident.file_path(), source["id"])
    assert caught.value.status_code == 404


def test_reference_failure_and_limit_are_unchecked(hub, monkeypatch):
    _, ident, source, _ = _restored(hub)
    bindings = [{"plan_id": str(index), "client_id": "old-client"} for index in range(21)]
    monkeypatch.setattr(store, "bindings_for_conversation", lambda *a, **k: bindings)
    calls = []

    def check(email, client, plan):
        calls.append(plan)
        if plan == "1":
            raise sqlite3.OperationalError("unreadable")
        return {"plan_id": plan, "status": "missing", "generations": []}

    monkeypatch.setattr(mcp_store, "restored_reference", check)
    rows = router._restored_references(ident, source["id"])
    assert len(calls) == 20
    assert rows[0]["status"] == "missing"
    assert rows[1]["status"] == rows[20]["status"] == "unchecked"


def test_late_http_capture_and_mcp_read_return_503(hub, monkeypatch):
    client, _, service = hub
    headers, ident, source, _ = _restored(hub)
    real = api._capture

    def capture_then_restore(*args, **kwargs):
        captured = real(*args, **kwargs)
        with service.restore_guard((ident,)):
            pass
        return captured

    monkeypatch.setattr(api, "_capture", capture_then_restore)
    response = client.get(f"/api/agent-chat/conversations/{source['id']}", headers=headers)
    assert response.status_code == 503


def test_late_mcp_record_read_does_not_reopen_new_db(local, monkeypatch):
    secret = register(local)
    ident = read_identity(local.account["email"])
    make_conv(own_path(local), turns=[{}])
    real = chat.chat_list

    def delayed(path, **kwargs):
        with chat.service.restore_guard((ident,)):
            pass
        return real(path, **kwargs)

    monkeypatch.setattr(chat, "chat_list", delayed)
    assert read(local, secret, kind="agent_chats").status_code == 503


def test_late_capture_recovery_cannot_write_new_content(hub, monkeypatch):
    client, _, _ = hub
    headers = panel_headers(client)
    writes = []

    def recover_after_replace(_path):
        db.flush_pool()
        with db.get_connection() as conn:
            conn.execute("UPDATE mcp_client SET revoked_at=NULL")
            writes.append(True)

    monkeypatch.setattr(mcp_store, "recover_interrupted_plans", recover_after_replace)
    assert client.get("/api/agent-chat/conversations", headers=headers).status_code == 503
    assert writes == []


def test_late_client_touch_cannot_write_new_content(local, monkeypatch):
    secret = register(local)
    real_touch = mcp_store.touch_client
    writes = []

    def touch_after_replace(client_id):
        db.flush_pool()
        real_touch(client_id)
        writes.append(True)

    monkeypatch.setattr(mcp_store, "touch_client", touch_after_replace)
    assert read(local, secret, kind="agent_chats").status_code == 503
    assert writes == []


def test_cancelled_issue_remains_busy_until_worker_revoke(hub, monkeypatch):
    client, profiles, service = hub
    headers = panel_headers(client)
    ident = service.session_identity(headers["X-MVHub-Panel"])
    ready, release = threading.Event(), threading.Event()
    real = api.issue_panel_client

    def issue(ctx, setup):
        made = real(ctx, setup)
        ready.set()
        assert release.wait(10)
        return made

    def fail(*args, **kwargs):
        raise OSError("claim failed")

    monkeypatch.setattr(api, "issue_panel_client", issue)
    monkeypatch.setattr(store, "claim_turn", fail)

    async def run():
        transport = httpx.ASGITransport(app=client.app, client=("127.0.0.1", 50431))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8012") as http:
            task = asyncio.create_task(http.post("/api/agent-chat/turns", headers=headers, json={
                "idempotency_key": uuid4().hex, "engine": "claude", "model": "haiku", "effort": "low", "text": "새 요청"}))
            assert await asyncio.to_thread(ready.wait, 5)
            task.cancel()
            await asyncio.sleep(0.05)
            with pytest.raises(HTTPException) as caught:
                with service.restore_guard((ident,)):
                    pass
            assert caught.value.status_code == 409 and not task.done()
            release.set()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    client.portal.call(run)
    assert mcp_store.client_by_id(profiles[-1]["client_id"])["revoked_at"]
    with service.restore_guard((ident,)):
        pass


def test_restored_references_use_local_account_client_and_plan_only(hub):
    _, _, _ = hub
    owner = "reference-owner"
    client_id = mcp_store.create_client(uuid4().hex, "hub", owner, EMAIL, None, {"scope": "account"}, "agent_panel", False)
    client = mcp_store.client_by_id(client_id)
    personal = mcp_store.create_plan(client, "개인", [{"model": "test", "prompt": "old"}], {"scope": "personal", "id": None})
    team = mcp_store.create_plan(client, "팀", [{"model": "test", "prompt": "old"}], {"scope": "team", "id": "team-one"})
    with db.get_connection() as conn:
        worker = conn.execute("SELECT id FROM worker LIMIT 1").fetchone()[0]
        conn.execute("INSERT INTO generation(id,worker_id,prompt,workspace_scope) VALUES('present',?,'old','personal')", (worker,))
        conn.execute("UPDATE mcp_generation_plan SET items=? WHERE id=?",
                     (json.dumps([{"generation_id": "present"}, {"generation_id": "gone"}]), personal["id"]))
        conn.execute("UPDATE mcp_generation_plan SET items=? WHERE id=?",
                     (json.dumps([{"generation_id": "upstream-only"}]), team["id"]))
    mcp_store.revoke(client_id, owner, EMAIL)
    assert mcp_store.restored_reference(EMAIL, client_id, personal["id"]) == {
        "plan_id": personal["id"], "status": "available", "generations": [
            {"id": "present", "status": "available"}, {"id": "gone", "status": "missing"}]}
    assert mcp_store.restored_reference(EMAIL, client_id, team["id"])["generations"] == [
        {"id": "upstream-only", "status": "unchecked"}]
    for email, binding, plan in (("other@test", client_id, personal["id"]), (EMAIL, "other-client", personal["id"]),
                                  (EMAIL, client_id, str(uuid4()))):
        assert mcp_store.restored_reference(email, binding, plan)["status"] == "missing"
    assert mcp_store.client_by_id(client_id)["revoked_at"]
