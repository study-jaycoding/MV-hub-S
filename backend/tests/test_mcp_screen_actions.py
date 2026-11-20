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


def test_multiple_selection_and_no_fallback(screen):
    s = screen
    second = s[4]().json()
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_ambiguous"
    assert s[4](**s[5], seq=2, select=True).status_code == 200
    ticket(s)
    assert s[4](receiver_id=second["receiver_id"], secret=second["receiver_secret"], seq=2).status_code == 200
    assert s[4](**s[5], seq=3, epoch=2, visible=False).status_code == 200
    assert action(s[0], "read_context", {"kind": "screen"}).json()["detail"] == "screen_unavailable"


@pytest.mark.parametrize("change", ["scene", "hidden", "off", "epoch", "expired", "logout", "restart"])
def test_old_ticket_never_revives(screen, monkeypatch, change):
    s = screen; token = ticket(s)
    if change in ("scene", "hidden", "off", "epoch"):
        changed = {"scene_id": "other"} if change == "scene" else {"visible": False} if change == "hidden" else {"enabled": False} if change == "off" else {}
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
    s[2][0] += 61
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
    s[2][0] += 26
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
    clock[0] += 61
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
