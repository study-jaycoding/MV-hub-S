"""External-screen HTTP boundary; isolated DB, controllable time, no CLI or generation."""
import threading
import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import active_account
from app.services import mcp_screen
from app.ws import manager
from test_mcp_persistent import local, configure, action, APP_HEADERS, _scene_row  # noqa: F401
from app.routers import mcp_v2 as api


@pytest.fixture
def screen(local, monkeypatch):  # noqa: F811
    now = [100.0]
    service = mcp_screen.ScreenService(lambda: now[0])
    monkeypatch.setattr(mcp_screen, "service", service)
    configure(local)
    client = api.store.client_for_secret(api.mcp.digest(local[1]["codex"]["secret"]))
    _scene_row(client, "scene")
    headers = {**APP_HEADERS, "X-MVHub-Expect-Account": "acct:" + local[2]["email"]}
    body = {"hub_id": api.hub_id(), "seq": 1, "epoch": 1, "workspace": {"scope": "personal", "id": None},
            "scene_id": "scene", "visible": True, "enabled": True}
    def presence(**changes):
        return local[0].post("/api/mcp/v2/app/screen-presence", headers=headers, json={**body, **changes})
    registered = presence()
    assert registered.status_code == 200, registered.text
    receiver = registered.json()
    credentials = {"receiver_id": receiver["receiver_id"], "secret": receiver["receiver_secret"]}
    wakes, ready = [], threading.Event()
    async def broadcast(message, account_uid=None):
        wakes.append((message, account_uid)); ready.set()
    monkeypatch.setattr(manager, "broadcast", broadcast)
    return local, service, now, headers, presence, credentials, wakes, ready


def ticket(s):
    r = action(s[0], "read_context", {"kind": "screen"})
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"workspace", "scene_id", "screen_context", "expires_in"}
    return r.json()["screen_context"]


def start(s, pool, name="canvas.read_selection", args=None):
    token = ticket(s)
    future = pool.submit(action, s[0], "screen_action", {"name": name, "args": args or {"scene_id": "scene"}, "screen_context": token})
    assert s[7].wait(5), "wake missing"
    wake, scope = s[6][-1]
    assert set(wake) == {"type", "receiver_id", "action_id"}
    assert scope == "acct:" + s[0][2]["email"]
    return future, wake["action_id"]


def claim(s, aid, **changes):
    return s[0][0].post(f"/api/mcp/v2/app/screen-actions/{aid}/claim", headers=s[3], json={**s[5], **changes})


def finish(s, aid, token, **changes):
    return s[0][0].post(f"/api/mcp/v2/app/screen-actions/{aid}/result", headers=s[3],
                         json={**s[5], "token": token, "ok": True, "summary": "done", "data": {}, **changes})


def test_registration_secret_and_minimal_ticket(screen):
    s = screen
    r = s[1].receivers[s[5]["receiver_id"]]
    assert r.secret_hash != s[5]["secret"] and r.secret_hash == mcp_screen.digest(s[5]["secret"])
    ticket(s)
    assert s[4](**s[5], seq=2).status_code == 200
    assert s[4](**s[5], seq=1, epoch=2, enabled=False).status_code == 409
    assert s[4](**{**s[5], "secret": "x" * 43}, seq=3).status_code == 403
    assert s[4](hub_id="other").status_code == 403
    for headers in (APP_HEADERS, {**s[3], "X-MVHub-Expect-Account": "acct:other@test"}):
        response = s[0][0].post("/api/mcp/v2/app/screen-presence", headers=headers,
                              json={"hub_id": api.hub_id(), "seq": 1, "epoch": 1, "workspace": {"scope": "personal"}, "visible": True, "enabled": True})
        assert response.status_code == 403


def test_disabled_selection_falls_back_but_does_not_reselect_when_enabled(screen):
    s = screen
    second = s[4]().json()
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_ambiguous"
    assert s[4](**s[5], seq=2, select=True).status_code == 200
    ticket(s)
    assert s[4](receiver_id=second["receiver_id"], secret=second["receiver_secret"], seq=2).status_code == 200
    assert s[4](**s[5], seq=3, epoch=2, enabled=False).status_code == 200
    assert not s[1].selected
    assert s[1].target(s[0][2]["email"]).id == second["receiver_id"]
    ticket(s)
    assert s[4](**s[5], seq=4, epoch=3).status_code == 200
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_ambiguous"


def test_hidden_registration_selection_and_presence_ttl_150(screen):
    s = screen
    second = s[4](visible=False).json()
    assert second["multiple"] is True
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_ambiguous"
    credentials = {"receiver_id": second["receiver_id"], "secret": second["receiver_secret"]}
    assert s[4](**credentials, seq=2, visible=False, select=True).status_code == 200
    s[2][0] += 149
    ticket(s)
    s[2][0] += 1
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_unavailable"
    assert s[4](**credentials, seq=3, visible=False).status_code == 403


def test_visibility_keeps_epoch_ticket_action_and_result(screen):
    s = screen
    context = ticket(s)
    assert s[4](**s[5], seq=2, visible=False).status_code == 200
    with ThreadPoolExecutor() as pool:
        future = pool.submit(action, s[0], "screen_action", {"name": "canvas.read_selection",
            "args": {"scene_id": "scene"}, "screen_context": context})
        assert s[7].wait(5)
        aid = s[6][-1][0]["action_id"]
        s[2][0] += 7
        result = claim(s, aid)
        assert result.status_code == 200, result.text
        assert result.json()["remaining_ms"] == 23_000
        assert s[4](**s[5], seq=3, visible=True).status_code == 200
        assert s[4](**s[5], seq=4, visible=False).status_code == 200
        assert s[1].receivers[s[5]["receiver_id"]].epoch == 1
        assert finish(s, aid, result.json()["token"]).json() == {"accepted": True}
        assert future.result(5).json()["status"] == "done"


@pytest.mark.parametrize("claimed", [False, True])
def test_release_removes_target_selection_and_rejects_late_heartbeat(screen, claimed):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        if claimed:
            assert claim(s, aid).status_code == 200
        assert s[4](**s[5], seq=2, select=True).status_code == 200
        second = s[4](visible=False).json()
        assert s[4](**s[5], seq=3, epoch=2, enabled=False, release=True).status_code == 200
        assert s[5]["receiver_id"] not in s[1].receivers
        assert s[1].selected == {}
        assert s[1].target(s[0][2]["email"]).id == second["receiver_id"]
        ticket(s)
        assert s[4](**s[5], seq=4, epoch=3).status_code == 403
        assert future.result(5).json()["status"] == ("unknown" if claimed else "expired_unclaimed")


@pytest.mark.parametrize("change", ["scene", "off", "epoch", "expired", "logout", "restart"])
def test_old_ticket_never_revives(screen, monkeypatch, change):
    s = screen; token = ticket(s)
    if change in ("scene", "off", "epoch"):
        changed = {"scene_id": "other"} if change == "scene" else {"enabled": False} if change == "off" else {}
        assert s[4](**s[5], seq=2, epoch=2, **changed).status_code == 200
        assert s[4](**s[5], seq=3, epoch=3).status_code == 200
    elif change == "expired":
        s[2][0] += 31
    elif change == "logout":
        s[0][0].post("/api/auth/logout")
    else:
        monkeypatch.setattr(mcp_screen, "service", mcp_screen.ScreenService())
    r = action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": "scene"}, "screen_context": token})
    assert r.status_code in (403, 409)
    assert not s[6]


def test_claim_once_result_once_and_forged_receiver(screen):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        assert claim(s, aid, secret="x" * 43).status_code == 403
        other = s[4]().json()
        assert s[4](**s[5], seq=2, select=True).status_code == 200
        assert claim(s, aid, receiver_id=other["receiver_id"], secret=other["receiver_secret"]).status_code == 403
        result = claim(s, aid); assert result.status_code == 200, result.text
        token = result.json()["token"]
        assert claim(s, aid).status_code == 409
        assert finish(s, aid, "x" * 43).json() == {"accepted": False}
        assert finish(s, aid, token).json() == {"accepted": True}
        assert finish(s, aid, token).json() == {"accepted": False}
        assert future.result(5).json()["status"] == "done"


@pytest.mark.parametrize("claimed", [False, True])
def test_expiry_and_late_result_same_lock(screen, claimed):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        token = claim(s, aid).json()["token"] if claimed else "x" * 43
        # Keep receiver live while expiring the command, then race terminal paths.
        s[2][0] += 20; s[4](**s[5], seq=2)
        s[2][0] += 11
        s[1].expire(s[1].actions[aid])
        assert finish(s, aid, token).json() == {"accepted": False}
        assert future.result(5).json()["status"] == ("unknown" if claimed else "expired_unclaimed")


@pytest.mark.parametrize("phase", ["claim", "result"])
def test_revoked_client_cannot_claim_or_return_data(screen, phase):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        token = claim(s, aid).json()["token"] if phase == "result" else "x" * 43
        row = s[1].actions[aid].context.client
        s[0][0].post(f"/api/mcp/v2/app/clients/{row['id']}/revoke", headers=APP_HEADERS)
        response = claim(s, aid) if phase == "claim" else finish(s, aid, token)
        assert response.status_code == 403
        s[1].expire(s[1].actions[aid])
        assert future.result(5).status_code == 403


def test_read_only_unsaved_scope_and_one_use(screen):
    s = screen
    configure(s[0], ["claude"], execute=False)
    context = action(s[0], "read_context", {"kind": "screen"}, name="claude").json()["screen_context"]
    assert action(s[0], "screen_action", {"name": "canvas.create_nodes", "args": {"scene_id": "scene", "nodes": [{"kind": "text"}]}, "screen_context": context}, name="claude").status_code == 403
    assert s[4](**s[5], seq=2, epoch=2, scene_id="unsaved").status_code == 200
    context = ticket(s)
    args = {"name": "canvas.read_selection", "args": {"scene_id": "unsaved"}, "screen_context": context}
    assert action(s[0], "screen_action", args).status_code == 409
    assert action(s[0], "screen_action", args).json()["detail"] == "screen_context_invalid"
    assert s[4](**s[5], seq=3, epoch=3, workspace={"scope": "team", "id": "forbidden"}).status_code == 200
    response = action(s[0], "read_context", {"kind": "screen"})
    assert response.status_code == 409 and "forbidden" not in response.text


def test_account_busy_and_budget_no_refund(screen):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool, "canvas.create_nodes", {"scene_id": "scene", "nodes": [{"kind": "text"}] * 5})
        args = {"name": "canvas.create_nodes", "args": {"scene_id": "scene", "nodes": [{"kind": "text"}] * 5}, "screen_context": ticket(s)}
        assert action(s[0], "screen_action", args).status_code == 429
        s[1].expire(s[1].actions[aid]); assert future.result(5).status_code == 200
        s[7].clear()
        future, aid = start(s, pool, "canvas.create_nodes", args["args"])
        s[1].expire(s[1].actions[aid]); assert future.result(5).status_code == 200
        args["screen_context"] = ticket(s)
        assert action(s[0], "screen_action", args).json()["detail"] == "screen_limit"


def test_heartbeat_no_upstream_and_account_epoch(screen, monkeypatch):
    s = screen
    monkeypatch.setattr(api, "_capture", lambda *_: pytest.fail("heartbeat must not capture upstream identity"))
    assert s[4](**s[5], seq=2).status_code == 200
    active_account.bump_account_epoch()
    assert s[4](**s[5], seq=3).status_code == 403


def test_invalid_requests_are_rate_limited_and_db_replacement_invalidates(screen):
    from app import db
    s = screen
    for _ in range(30):
        assert action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": "scene"}, "screen_context": "x" * 43}).status_code == 409
    assert action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {}, "screen_context": "x" * 43}).status_code == 429
    s[2][0] += 151
    assert s[4](**s[5], seq=2).status_code == 403
    r = s[4]().json()
    db.flush_pool()
    assert s[4](receiver_id=r["receiver_id"], secret=r["receiver_secret"], seq=2).status_code == 403


def test_validation_error_never_echoes_capability(local):  # noqa: F811
    from fastapi import FastAPI
    from fastapi.exceptions import RequestValidationError
    from fastapi.testclient import TestClient
    from app.main import screen_validation_error
    app = FastAPI()
    app.add_exception_handler(RequestValidationError, screen_validation_error)
    app.include_router(api.router)
    with TestClient(app, base_url="http://127.0.0.1:8123", client=("127.0.0.1", 51000)) as client:
        secret = "do-not-echo-secret"
        response = client.post("/api/mcp/v2/app/screen-actions/action/claim", headers=APP_HEADERS,
                               json={"receiver_id": "r", "secret": secret})
        assert response.status_code == 422 and secret not in response.text


@pytest.mark.parametrize("claimed", [False, True])
def test_http_cancellation_closes_without_replay(screen, claimed):
    import httpx
    from test_mcp_persistent import headers
    s = screen; context = ticket(s)
    async def run():
        transport = httpx.ASGITransport(app=s[0][0].app, client=("127.0.0.1", 51000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8123") as client:
            pending = asyncio.create_task(client.post("/api/mcp/v2/client/action", headers=headers(s[0]),
                json={"method": "screen_action", "args": {"name": "canvas.read_selection", "args": {"scene_id": "scene"}, "screen_context": context}}))
            assert await asyncio.to_thread(s[7].wait, 5)
            aid = s[6][-1][0]["action_id"]
            if claimed:
                assert (await asyncio.to_thread(claim, s, aid)).status_code == 200
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            assert s[1].actions[aid].state == ("unknown" if claimed else "expired_unclaimed")
            assert claim(s, aid).status_code == 409
    asyncio.run(run())


def test_registration_bound_and_expiry_cleanup(screen):
    s = screen
    for _ in range(15):
        assert s[4]().status_code == 200
    assert s[4]().status_code == 429
    s[2][0] += 150
    assert s[4]().status_code == 200 and len(s[1].receivers) == 1


def test_same_account_other_session_cannot_claim(screen):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        response = s[0][0].post(f"/api/mcp/v2/app/screen-actions/{aid}/claim",
                                headers={**s[3], "Authorization": "Bearer different-app-session"}, json=s[5])
        assert response.status_code == 403
        response = s[0][0].post(f"/api/mcp/v2/app/screen-actions/{aid}/claim",
                                headers={**s[3], "X-MVHub-Expect-Account": "acct:other@test"}, json=s[5])
        assert response.status_code == 403
        s[1].expire(s[1].actions[aid]); future.result(5)


def test_global_caps_rate_windows_and_terminal_retention():
    from types import SimpleNamespace
    from fastapi import HTTPException
    clock = [100.0]
    service = mcp_screen.ScreenService(lambda: clock[0])
    body = api.ScreenPresenceIn(hub_id="hub", seq=1, epoch=1, workspace={"scope": "personal"}, visible=True, enabled=True)
    receivers = []
    for i in range(128):
        account = f"account-{i // 16}"
        r, _ = service.register(("db", "hub", 1, account, "session", (), 1), account, None, body)
        receivers.append(r)
    with pytest.raises(HTTPException) as exc:
        service.register(("db", "hub", 1, "ninth", "session", (), 1), "ninth", None, body)
    assert exc.value.status_code == 429
    active = []
    for i in range(8):
        r = receivers[i * 16]
        service.selected[r.account] = r.id
        active.append(service.issue(r, 1, SimpleNamespace(client={"id": str(i)}), "canvas.read_selection", {}, 0))
    assert len([a for a in service.actions.values() if not a.settled.is_set()]) == 8
    # A ninth account can register after one registration expires; the global action cap still applies.
    receivers[-1].expires = 0
    r, _ = service.register(("db", "hub", 1, "ninth", "session", (), 1), "ninth", None, body)
    ctx = SimpleNamespace(client={"id": "ninth"})
    with pytest.raises(HTTPException) as exc:
        service.issue(r, 1, ctx, "canvas.read_selection", {}, 0)
    assert exc.value.status_code == 429
    for a in active:
        service.expire(a)
    for _ in range(260):
        service.expire(service.issue(r, 1, ctx, "canvas.read_selection", {}, 0))
    assert len(service.actions) == 256
    for i in range(60):
        service.rate(str(i // 20), "one-account")
    with pytest.raises(HTTPException):
        service.rate("fresh-client", "one-account")
    clock[0] += 151
    service.rate("fresh-client", "one-account")
    assert not service.actions and not service.receivers and len(service.requests) == 1


def test_receipt_bound_accepts_the_full_allowed_id_batch_and_unicode():
    from pydantic import ValidationError
    fields = {"receiver_id": "r" * 32, "secret": "s" * 43, "token": "t" * 43, "ok": True, "summary": "완료"}
    assert api.ScreenResultIn(**fields, data={"changed": [str(i).zfill(80) for i in range(50)]}).ok
    assert api.ScreenResultIn(**fields, data={"cards": [{"id": str(i), "label": "한" * 40} for i in range(20)]}).ok
    for data in ({"undo": {}}, {"large": "x" * 8192}, {"value": float("nan")}):
        with pytest.raises(ValidationError):
            api.ScreenResultIn(**fields, data=data)


@pytest.mark.parametrize("change", ["scene", "workspace", "revoke"])
def test_final_response_uses_issued_screen_but_rechecks_authority(screen, monkeypatch, change):
    s = screen
    waiting, proceed = threading.Event(), threading.Event()
    original = api._screen_validate
    def validate(ctx, receiver, name=None, commit=None, args=None):
        if args is not None and commit is None:
            waiting.set()
            assert proceed.wait(5), "final authorization barrier timed out"
        return original(ctx, receiver, name, commit, args)
    monkeypatch.setattr(api, "_screen_validate", validate)
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool, "canvas.create_nodes", {"scene_id": "scene", "nodes": [{"kind": "text"}]})
        token = claim(s, aid).json()["token"]
        try:
            assert finish(s, aid, token).json() == {"accepted": True}
            assert waiting.wait(5)
            if change == "revoke":
                cid = s[1].actions[aid].context.client["id"]
                assert s[0][0].post(f"/api/mcp/v2/app/clients/{cid}/revoke", headers=APP_HEADERS).status_code == 200
            else:
                changes = {"scene_id": None} if change == "scene" else {"workspace": {"scope": "team", "id": "other"}, "scene_id": None}
                assert s[4](**s[5], seq=2, epoch=2, **changes).status_code == 200
        finally:
            proceed.set()
        result = future.result(5)
        if change == "revoke":
            assert result.status_code == 403
        else:
            assert result.status_code == 200 and result.json()["status"] == "done"
        assert len(s[6]) == 1


def test_empty_owned_generation_set_skips_without_issuing(screen):
    s = screen
    result = action(s[0], "screen_action", {"name": "library.set_hidden", "args": {
        "generation_ids": ["missing", "missing"], "hidden": True}, "screen_context": ticket(s)})
    assert result.status_code == 200, result.text
    assert result.json() == {"status": "skipped", "ok": False, "summary": "바꿀 수 있는 내 생성물이 없어요", "data": {}, "skipped": ["missing"]}
    assert not s[1].actions and not s[1].usage and not s[6]


def test_ticket_cap_is_per_client_and_expires(screen):
    s = screen
    configure(s[0], ["claude"])
    for _ in range(8):
        ticket(s)
    assert action(s[0], "read_context", {"kind": "screen"}).status_code == 429
    assert action(s[0], "read_context", {"kind": "screen"}, name="claude").status_code == 200
    assert len(s[1].tickets) == 9
    s[2][0] += 31
    assert s[4](**s[5], seq=2).status_code == 200
    ticket(s)
    assert len(s[1].tickets) == 1


def test_screen_reads_and_actions_share_request_rate_limit(screen):
    s = screen
    s[1].invalidate()
    for _ in range(30):
        assert action(s[0], "read_context", {"kind": "screen"}).status_code == 409
    assert action(s[0], "read_context", {"kind": "screen"}).status_code == 429
    assert action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {}, "screen_context": "x" * 43}).status_code == 429


@pytest.mark.parametrize("known", [False, True])
def test_logout_only_invalidates_a_known_account(screen, monkeypatch, known):
    from dataclasses import replace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routers import auth as auth_router
    s = screen
    receiver = s[1].receivers[s[5]["receiver_id"]]
    s[1].receivers["other-receiver"] = replace(receiver, id="other-receiver", account="other@example.test")
    monkeypatch.setattr(active_account, "active_email", lambda: "")
    monkeypatch.setattr(auth_router.local_agent_pair, "clear", lambda *_: None)
    app = FastAPI()
    @app.middleware("http")
    async def identity(request, call_next):
        request.state.account = s[0][2] if known else None
        return await call_next(request)
    app.include_router(auth_router.router)
    with TestClient(app, base_url="http://127.0.0.1:8123") as client:
        assert client.post("/api/auth/logout").status_code == 200
    assert set(s[1].receivers) == ({"other-receiver"} if known else {receiver.id, "other-receiver"})


def test_rejected_selection_still_closes_disabled_receiver_action(screen):
    s = screen
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        response = s[4](**s[5], seq=2, epoch=2, enabled=False, select=True)
        assert response.status_code == 409
        assert not s[1].receivers[s[5]["receiver_id"]].enabled
        assert s[1].actions[aid].settled.is_set()
        assert future.result(5).json()["status"] == "expired_unclaimed"


def test_scene_mismatch_keeps_ticket_for_one_correct_execution(screen):
    s = screen
    context = ticket(s)
    payload = {"name": "canvas.read_selection", "args": {"scene_id": "other"}, "screen_context": context}
    response = action(s[0], "screen_action", payload)
    assert response.status_code == 409 and response.json()["detail"] == "screen_scene_mismatch"
    assert mcp_screen.digest(context) in s[1].tickets and not s[6]
    payload["args"]["scene_id"] = "scene"
    with ThreadPoolExecutor() as pool:
        future = pool.submit(action, s[0], "screen_action", payload)
        assert s[7].wait(5)
        aid = s[6][-1][0]["action_id"]
        assert finish(s, aid, claim(s, aid).json()["token"]).json()["accepted"]
        assert future.result(5).json()["status"] == "done"
    assert action(s[0], "screen_action", payload).json()["detail"] == "screen_context_invalid"


def test_no_scene_and_invalid_arguments_keep_ticket(screen):
    s = screen
    context = ticket(s)
    response = action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {}, "screen_context": context})
    assert response.status_code == 422
    assert mcp_screen.digest(context) in s[1].tickets
    assert s[4](**s[5], seq=2, epoch=2, scene_id=None).status_code == 200
    context = ticket(s)
    response = action(s[0], "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": "scene"}, "screen_context": context})
    assert response.json()["detail"] == "screen_scene_unavailable"
    assert mcp_screen.digest(context) in s[1].tickets


def test_same_ticket_concurrent_requests_issue_once(screen):
    s = screen
    payload = {"name": "canvas.read_selection", "args": {"scene_id": "scene"}, "screen_context": ticket(s)}
    barrier = threading.Barrier(2)
    def send():
        barrier.wait(5)
        return action(s[0], "screen_action", payload)
    with ThreadPoolExecutor() as pool:
        futures = [pool.submit(send) for _ in range(2)]
        assert s[7].wait(5)
        aid = s[6][-1][0]["action_id"]
        assert finish(s, aid, claim(s, aid).json()["token"]).json()["accepted"]
        results = [f.result(5) for f in futures]
    assert sorted(r.status_code for r in results) == [200, 409]
    assert next(r for r in results if r.status_code == 409).json()["detail"] == "screen_context_invalid"
    assert len(s[6]) == 1


@pytest.mark.parametrize("before", [False, True])
def test_registration_cancel_before_arrival_or_after_lost_response(screen, before):
    s = screen
    registration = "r" * 48
    s[1].invalidate()
    if not before:
        registered = s[4](registration=registration, select=True)
        assert registered.status_code == 200 and registration not in registered.text
        r = s[1].target(s[0][2]["email"])
        assert r.registration_hash == mcp_screen.digest(registration)
        ticket(s)
    response = s[4](registration=registration, enabled=False, release=True)
    assert response.status_code == 200 and response.json() == {"released": True}
    assert not s[1].receivers and not s[1].tickets and not s[1].selected
    if before:
        assert s[4](registration=registration).json()["detail"] == "screen_stale"


def test_cancel_during_registration_rechecks_tombstone_before_storing(screen, monkeypatch):
    s = screen
    original = api._capture
    waiting, proceed = threading.Event(), threading.Event()
    def capture(*args):
        result = original(*args)
        waiting.set()
        assert proceed.wait(5)
        return result
    monkeypatch.setattr(api, "_capture", capture)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(s[4], registration="r" * 48)
        try:
            assert waiting.wait(5)
            assert s[4](registration="r" * 48, release=True, enabled=False).status_code == 200
        finally:
            proceed.set()
        assert future.result(5).json()["detail"] == "screen_stale"
    assert len(s[1].receivers) == 1


@pytest.mark.parametrize("elapsed", [149.999, 150.001])
def test_tombstone_boundary_and_new_receiver_ttl(screen, elapsed):
    s = screen
    assert s[4](registration="r" * 48, release=True, enabled=False).status_code == 200
    s[2][0] += elapsed
    result = s[4](registration="r" * 48)
    if elapsed < 150:
        assert result.json()["detail"] == "screen_stale"
    else:
        assert result.status_code == 200
        r = s[1].receivers[result.json()["receiver_id"]]
        assert r.expires == s[2][0] + 150


@pytest.mark.parametrize("delay_at", ["binding", "capture"])
def test_registration_deadline_starts_before_first_await(screen, monkeypatch, delay_at):
    s = screen
    name = "_screen_binding" if delay_at == "binding" else "_capture"
    original = getattr(api, name)
    def delayed(*args):
        result = original(*args)
        s[2][0] += 20.001
        return result
    monkeypatch.setattr(api, name, delayed)
    result = s[4](registration="r" * 48)
    assert result.json()["detail"] == "screen_stale"
    assert len(s[1].receivers) == 1


@pytest.mark.parametrize("change", ["account", "binding", "legacy"])
def test_cancel_cannot_remove_unrelated_or_legacy_receiver(screen, change):
    s = screen
    registration = "r" * 48
    if change == "legacy":
        r = s[1].receivers[s[5]["receiver_id"]]
    else:
        result = s[4](registration=registration).json()
        r = s[1].receivers[result["receiver_id"]]
    binding, account = r.binding, r.account
    if change == "account":
        account = "other@example.test"
    if change == "binding":
        binding = (*binding[:4], "other-session", *binding[5:])
    s[1].cancel_registration(binding, account, registration)
    assert r.id in s[1].receivers


def test_cancel_releases_selected_receiver_and_pending_action(screen):
    s = screen
    r = s[1].receivers[s[5]["receiver_id"]]
    r.registration_hash = mcp_screen.digest("r" * 48)
    with ThreadPoolExecutor() as pool:
        future, aid = start(s, pool)
        assert s[4](**s[5], seq=2, select=True).status_code == 200
        other = s[4]().json()
        assert s[4](registration="r" * 48, release=True, enabled=False).status_code == 200
        assert not s[1].selected
        assert s[1].target(r.account).id == other["receiver_id"]
        assert future.result(5).json()["status"] == "expired_unclaimed"


def test_tombstone_caps_do_not_evict_live_cancellations():
    from fastapi import HTTPException
    now = [100.0]
    service = mcp_screen.ScreenService(lambda: now[0])
    binding = ("db", "hub", 1, "account", "session", (), 1)
    for account in range(32):
        for index in range(16):
            service.cancel_registration(binding, str(account), str(index).zfill(32))
        if account == 0:
            with pytest.raises(HTTPException) as error:
                service.cancel_registration(binding, "0", "new" * 11)
            assert error.value.status_code == 429 and len(service.cancelled) == 16
    before = dict(service.cancelled)
    for account in ("0", "new-account"):
        with pytest.raises(HTTPException) as error:
            service.cancel_registration(binding, account, "new" * 11)
        assert error.value.status_code == 429
        assert service.cancelled == before
    service.cancel_registration(binding, "0", "0" * 32)  # idempotent even at capacity
    assert service.cancelled == before
    now[0] += 150
    service.cancel_registration(binding, "new-account", "new" * 11)
    assert len(service.cancelled) == 1


def test_http_cancel_requires_same_account_and_app_session(screen):
    s = screen
    registration = "r" * 48
    registered = s[4](registration=registration).json()
    body = {"hub_id": api.hub_id(), "seq": 2, "epoch": 2, "workspace": {"scope": "personal"},
            "visible": False, "enabled": False, "release": True, "registration": registration}
    for headers, status in (({**s[3], "X-MVHub-Expect-Account": "acct:other@example.test"}, 403),
                            ({**s[3], "Authorization": "Bearer other-session"}, 200)):
        response = s[0][0].post("/api/mcp/v2/app/screen-presence", headers=headers, json=body)
        assert response.status_code == status
        assert registered["receiver_id"] in s[1].receivers


@pytest.mark.parametrize("registration", ["", "r" * 31, "r" * 101, 123])
def test_registration_length_and_release_validation(screen, registration):
    s = screen
    assert s[4](registration=registration).status_code == 422
    assert s[4](registration="r" * 32, release=True).status_code == 422
    assert s[4](registration="r" * 32, release=True, enabled=False, select=True).status_code == 422
    assert s[4](release=True, enabled=False).status_code == 422


def test_expired_selection_is_cleared_before_targeting(screen):
    s = screen
    assert s[4](**s[5], seq=2, select=True).status_code == 200
    s[2][0] += 100
    second = s[4]().json()
    s[2][0] += 50
    assert s[1].target(s[0][2]["email"]).id == second["receiver_id"]
    assert not s[1].selected


@pytest.mark.parametrize("lookup", ["_upstream_me", "_request_workspace", "_generation_row"])
def test_all_upstream_screen_checks_leave_registration_lock_free(screen, monkeypatch, lookup):
    from dataclasses import replace
    from test_mcp_persistent import headers
    s = screen
    r = s[1].receivers[s[5]["receiver_id"]]
    ctx = api._capture(r.context.request, headers(s[0])["X-MVHub-MCP-Secret"])
    if lookup == "_upstream_me":
        ctx = replace(ctx, upstream=("http://isolated.invalid", "test-token"))
        monkeypatch.setattr(api._proxy, "_stored_base_url", lambda: ctx.upstream[0])
        monkeypatch.setattr(api._proxy, "_stored_token", lambda: ctx.upstream[1])
    original = getattr(api, lookup)
    waiting, proceed = threading.Event(), threading.Event()
    def blocked(*args):
        waiting.set()
        assert proceed.wait(5)
        if lookup == "_upstream_me":
            return ctx.account
        if lookup == "_generation_row":
            return {"creator_uid": api._owner_uid(ctx), "workspace_scope": "personal", "workspace_id": None}
        return original(*args)
    monkeypatch.setattr(api, lookup, blocked)
    with ThreadPoolExecutor() as pool:
        check = pool.submit(api._screen_validate, ctx, r, "library.set_hidden", lambda: True, {"generation_ids": ["test"]} if lookup == "_generation_row" else {})
        try:
            assert waiting.wait(5)
            registration = pool.submit(configure, s[0], ["claude"])
            assert registration.result(3)
        finally:
            proceed.set()
        assert check.result(5) is True


@pytest.mark.parametrize("change", ["scene", "workspace", "epoch", "permission", "revoke", "login", "database"])
def test_authority_and_screen_rechecked_after_slow_lookup(screen, monkeypatch, change):
    from fastapi import HTTPException
    from test_mcp_persistent import headers
    s = screen
    r = s[1].receivers[s[5]["receiver_id"]]
    ctx = api._capture(r.context.request, headers(s[0])["X-MVHub-MCP-Secret"])
    original = api._request_workspace
    waiting, proceed, committed = threading.Event(), threading.Event(), []
    def blocked(*args):
        result = original(*args)
        waiting.set()
        assert proceed.wait(5)
        return result
    monkeypatch.setattr(api, "_request_workspace", blocked)
    with ThreadPoolExecutor() as pool:
        check = pool.submit(api._screen_validate, ctx, r, "library.set_hidden", lambda: committed.append(True))
        try:
            assert waiting.wait(5)
            if change in ("scene", "workspace", "epoch"):
                changes = {"scene_id": "other"} if change == "scene" else {"workspace": {"scope": "team", "id": "other"}} if change == "workspace" else {}
                assert s[4](**s[5], seq=2, epoch=2, **changes).status_code == 200
            elif change == "permission":
                configure(s[0], execute=False)
            elif change == "revoke":
                assert s[0][0].post(f"/api/mcp/v2/app/clients/{ctx.client['id']}/revoke", headers=APP_HEADERS).status_code == 200
            elif change == "login":
                active_account.bump_account_epoch()
            else:
                api.db.flush_pool()
        finally:
            proceed.set()
        with pytest.raises(HTTPException):
            check.result(5)
    assert not committed
