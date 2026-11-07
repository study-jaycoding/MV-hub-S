"""보이는 값이 그대로인 쓰기는 라이브러리 synced 를 내지 않는다(2026-11-07 속도 점검 2-A).

판정은 처리 코드가 쓰는 그 순간에 하고(`request.state.library_unchanged`), main 의 mutation_notify 는 synced 만 뺀다.
- 에이전트의 처리 중 반복 보고: 두 저장 함수가 한 트랜잭션에서 changed·same·not_applied 를 가르고, 둘 다 same 일 때만.
  이미 done 인 카드에 늦게 온 보고(not_applied)는 synced 를 남긴다 — note 의 progress(running) 가 완료 카드를 덮을 때 화면을 되돌리는 계기.
- MCP 읽기 메서드 8개만. execute_generation_plan(내부 create_gen_request — 이 신호가 새 카드의 유일한 계기)·모르는 메서드는 그대로.
합성 SQLite 만 쓴다. 실제 CLI·공급자·네트워크·사용자 DB 없음.
"""
from __future__ import annotations

import asyncio
import socket
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import Request
from fastapi.responses import Response

from app import active_account, db, main, repo
from app.models import FulfillIn
from app.routers import gen_requests as routes, mcp_v2
from app.routers.mcp import ActionIn
from app.usecases import gen_requests as usecase

ACCOUNT = "synthetic-2a@example.invalid"
UID = "synthetic-2a-uid"
GEN = "synthetic-2a-generation"
JOB = "synthetic-2a-job"


def _request(path="/synthetic", method="POST"):
    req = Request({"type": "http", "method": method, "scheme": "http", "path": path,
                   "headers": [(b"host", b"127.0.0.1")], "query_string": b"",
                   "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 8012)})
    req.state.account = {"email": ACCOUNT, "creator_uid": UID}
    return req


async def _synchronous_io(function, *args, **kwargs):
    return function(*args, **kwargs)


def _immediate(coroutine):
    """IO 는 모두 동기로 바꿨다 — 진짜 비동기 경계가 없어야 한다(이벤트 루프 소켓 불필요)."""
    try:
        try:
            yielded = coroutine.send(None)
        except StopIteration as done:
            return done.value
        raise AssertionError("Unexpected async boundary: " + type(yielded).__name__)
    finally:
        coroutine.close()


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str((tmp_path / "content_hub.db").resolve()))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "agent"))
    monkeypatch.setattr(active_account, "_cache", [True, {"email": ACCOUNT, "uid": UID}])
    monkeypatch.setattr(routes.asyncio, "to_thread", _synchronous_io)
    monkeypatch.setattr(usecase, "_sync_io", _synchronous_io)
    monkeypatch.setattr(usecase.manager, "broadcast", AsyncMock())
    monkeypatch.setattr(routes.agent_signals, "touch", Mock())
    monkeypatch.setattr(routes, "schedule_telemetry_drain", Mock())
    monkeypatch.setattr(socket.socket, "connect", Mock(side_effect=AssertionError("Real network forbidden")))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO generation(id,worker_id,prompt,model,status,creator_uid,origin,created_at,sort_ts) "
                     "VALUES(?,'me','Synthetic prompt','synthetic','pending',?,'local','2026-09-17 00:00:00',1)", (GEN, UID))
    rid = repo.create_gen_request(ACCOUNT, UID, GEN, "create", {"model": "synthetic", "prompt": "Synthetic prompt"})
    assert [item["id"] for item in repo.claim_pending_requests(ACCOUNT, limit=1, sweep_expired=False)] == [rid]
    yield rid
    db.flush_pool()


def _report(rid, status):
    req = _request()
    out = _immediate(routes.reconcile_gen_request(rid, FulfillIn(job={"id": JOB, "status": status}), req))
    return out, bool(getattr(req.state, "library_unchanged", False))


def test_only_repeated_processing_reports_are_quiet(isolated):
    out, quiet = _report(isolated, "queued")
    assert out["outcome"] == "not_ready" and not quiet  # claimed→tracking·pending→running 첫 전환
    out, quiet = _report(isolated, "queued")
    assert out["outcome"] == "not_ready" and quiet  # 확인 시각만 바뀐 반복 보고
    out, quiet = _report(isolated, "in_progress")
    assert not quiet  # 공급자 상태가 바뀜 — 툴팁 값이 바뀐다
    _, quiet = _report(isolated, "in_progress")
    assert quiet
    _, quiet = _report(isolated, "mystery_status")
    assert not quiet  # unknown → 단계·사유가 바뀜
    with db.get_connection() as conn:
        row = conn.execute("SELECT next_check_at, last_checked_at FROM gen_request WHERE id=?", (isolated,)).fetchone()
        assert conn.execute("SELECT (julianday(?) - julianday(?)) * 86400", (row[0], row[1])).fetchone()[0] == pytest.approx(15, abs=1)


def test_late_report_for_a_finished_card_keeps_the_correcting_signal(isolated):
    _report(isolated, "queued")
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (GEN,))
        conn.execute("UPDATE gen_request SET status='done' WHERE id=?", (isolated,))
    for status in ("mystery_status", "needs_action", "queued"):
        _, quiet = _report(isolated, status)
        assert not quiet  # not_applied — 완료 카드를 progress(running) 가 덮어도 synced 가 DB 값으로 되돌린다
    with db.get_connection() as conn:
        assert conn.execute("SELECT status FROM generation WHERE id=?", (GEN,)).fetchone()[0] == "done"


def test_store_functions_tell_changed_same_and_not_applied_in_one_transaction(isolated):
    assert repo.set_status(GEN, "running", None) == "changed"
    assert repo.set_status(GEN, "running", None) == "same"
    assert repo.set_status("missing-generation", "running", None) == "not_applied"
    assert repo.record_request_check(isolated, "queued", phase="tracking", next_seconds=15) == "changed"
    assert repo.record_request_check(isolated, "queued", phase="tracking", next_seconds=15) == "same"
    assert repo.record_request_check(isolated, "queued", phase="tracking", error="조치 필요", next_seconds=15) == "changed"
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (GEN,))
        conn.execute("UPDATE gen_request SET status='failed' WHERE id=?", (isolated,))
    assert repo.set_status(GEN, "running", "늦은 보고") == "not_applied"
    assert repo.record_request_check(isolated, "queued", phase="tracking") == "not_applied"
    assert repo.record_request_check("missing-request", "queued", phase="tracking") == "not_applied"


def _mcp(method, args=None):
    req = _request("/api/mcp/v2/client/action")
    ctx = SimpleNamespace(request=req)
    asyncio.run(mcp_v2.action(ActionIn(method=method, args=args or {}), ctx))
    return bool(getattr(req.state, "library_unchanged", False))


def test_mcp_read_methods_are_quiet_but_execute_and_unknown_still_signal(monkeypatch):
    for name in ("_read", "_result", "_result_once", "_selected_results", "_estimate_plan", "_execute"):
        monkeypatch.setattr(mcp_v2, name, AsyncMock(return_value={}))
    monkeypatch.setattr(mcp_v2, "_authorized_plan", AsyncMock(return_value={"items": []}))
    monkeypatch.setattr(mcp_v2, "_public_plan", lambda plan: plan)
    plan = {"plan_id": str(uuid.uuid4())}
    assert mcp_v2._LIBRARY_READ_METHODS == {
        "read_context", "get_result", "get_generation", "wait_results", "show_results",
        "estimate_plan", "get_plan", "request_execution",
    }
    assert _mcp("read_context")
    assert _mcp("estimate_plan", plan)
    assert _mcp("get_plan", plan)
    assert _mcp("request_execution", plan)
    assert not _mcp("execute_generation_plan", plan)  # 새 카드를 알리는 유일한 계기
    with pytest.raises(Exception):
        _mcp("no_such_tool", plan)


def _notify(path, *, quiet, status=200, origin=None):
    sent = {"library": 0, "domains": []}
    monkey = pytest.MonkeyPatch()
    monkey.setattr(main.manager, "notify_mutation", lambda *a, **k: sent.__setitem__("library", sent["library"] + 1))
    monkey.setattr(main.manager, "notify_domain", lambda name, *_a, **_k: sent["domains"].append(name))
    headers = [(b"host", b"127.0.0.1")]
    if origin:
        headers += [(b"x-mvhub-client-id", origin[0].encode()), (b"x-mvhub-mutation-id", origin[1].encode())]
    req = Request({"type": "http", "method": "POST", "scheme": "http", "path": path, "headers": headers,
                   "query_string": b"", "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 8012)})
    if quiet:
        req.state.library_unchanged = True

    async def call_next(_request):
        return Response(status_code=status)

    try:
        response = asyncio.run(main.mutation_notify(req, call_next))
    finally:
        monkey.undo()
    return sent, response


def test_middleware_drops_only_the_library_domain_when_marked():
    origin = ("client_a-123", "mutation_b-456")
    sent, response = _notify("/api/gen-requests/r1/reconcile", quiet=True, origin=origin)
    assert sent == {"library": 0, "domains": []}
    assert "x-mvhub-mutation-domains" not in response.headers  # 실제로 알린 영역만 적는다
    sent, response = _notify("/api/gen-requests/r1/reconcile", quiet=False, origin=origin)
    assert sent["library"] == 1 and response.headers["x-mvhub-mutation-domains"] == "library"
    sent, response = _notify("/api/manage/hf-missing-apply", quiet=True, origin=origin)
    assert sent == {"library": 0, "domains": ["manage_changed"]}  # 다른 영역은 그대로
    assert response.headers["x-mvhub-mutation-domains"] == "manage"
