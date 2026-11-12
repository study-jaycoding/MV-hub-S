"""MV Agent 화면 동작(docs/status/MVAgent_화면동작_2026-11-12.md) — 허브가 차례 시작 때 고정한 실행 창 번호·공간·씬으로 검사하고
실행 표를 발급, 그 번호의 칸만 한 번 claim·결과, 기한·종료 상태. 격리 DB·가짜 CLI(claude_slow 로 차례를 살려 둔다)·실제 생성 없음."""
import threading
import time
from uuid import uuid4

from fastapi import HTTPException

from app.routers import mcp_v2 as mcp_api
from app.services import agent_chat as chat
from test_agent_chat_api import adapter_action, hub, panel_headers, start_turn, wait_status, windows  # noqa: F401 - hub 는 fixture

assert hub

SCENE = "scene-1"
CONTEXT = {"tab": "compose", "workspace": {"scope": "personal", "id": None, "name": "내 공간"}, "scene": {"id": SCENE, "name": "씬"}}


def _turn(client, headers, tab=None, context=CONTEXT, **body):
    turn = start_turn(client, headers, context=context, **({"screen_tab": tab} if tab else {}), **body)
    assert turn.status_code == 200, turn.text
    return turn.json()


def _events(client, headers, turn_id, kind):
    events = client.get(f"/api/agent-chat/turns/{turn_id}/events?after=0", headers=headers).json()["events"]
    return [e for e in events if e["kind"] == kind]


def _act_async(client, secret, name, args):
    box = {}

    def run():
        box["response"] = adapter_action(client, secret, "screen_action", {"name": name, "args": args})

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, box


def _wait_action(client, headers, turn_id, count=1, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = _events(client, headers, turn_id, "ui_action")
        if len(found) >= count:
            return found[count - 1]
        time.sleep(0.05)
    raise AssertionError("ui_action 사건이 오지 않았다")


def _claim(client, headers, turn_id, action_id, tab):
    return client.post(f"/api/agent-chat/turns/{turn_id}/actions/{action_id}/claim", headers=headers, json={"screen_tab": tab})


def _result(client, headers, turn_id, action_id, token, ok=True, summary="새 노드 1개 만듦", data=None):
    return client.post(f"/api/agent-chat/turns/{turn_id}/actions/{action_id}/result", headers=headers,
                       json={"token": token, "ok": ok, "summary": summary, "data": data or {}})


def _stop(client, headers, turn_id):
    client.post(f"/api/agent-chat/turns/{turn_id}/cancel", headers=headers)
    wait_status(client, headers, turn_id, {"cancelled", "failed", "interrupted"})


@windows
def test_screen_action_refusals(hub):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    plain = _turn(client, headers)  # 새 창·화면 정보를 뺀 차례 = 실행 창 번호 없음
    secret = profiles[-1]["secret"]
    no_tab = adapter_action(client, secret, "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": SCENE}})
    assert no_tab.status_code == 409 and "옆 칸" in no_tab.json()["detail"]
    _stop(client, headers, plain["turn_id"])
    tab = str(uuid4())
    away = _turn(client, headers, tab, context={**CONTEXT, "scene": None, "scene_unavailable": "away"}, conversation_id=plain["conversation_id"])
    refused = adapter_action(client, secret, "screen_action", {"name": "canvas.create_nodes", "args": {"scene_id": SCENE, "nodes": [{"kind": "text"}]}})
    assert refused.status_code == 409 and "별도 창" in refused.json()["detail"]
    _stop(client, headers, away["turn_id"])
    live = _turn(client, headers, tab, conversation_id=plain["conversation_id"])
    other = adapter_action(client, secret, "screen_action", {"name": "canvas.connect", "args": {"scene_id": "other", "pairs": [["a", "b"]]}})
    assert other.status_code == 409  # 그 차례에 사람이 보던 씬만
    for bad in ({"name": "library.delete", "args": {}},
                {"name": "canvas.create_nodes", "args": {"scene_id": SCENE, "nodes": [{"kind": "list"}]}},
                {"name": "canvas.create_nodes", "args": {"scene_id": SCENE, "nodes": [{"kind": "text"}] * 6}},
                {"name": "canvas.connect", "args": {"scene_id": SCENE, "pairs": [["a"]]}},
                {"name": "library.set_hidden", "args": {"generation_ids": [], "hidden": True}}):
        assert adapter_action(client, secret, "screen_action", bad).status_code == 422, bad
    _stop(client, headers, live["turn_id"])
    gone = adapter_action(client, secret, "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": SCENE}})
    assert gone.status_code == 409  # 진행 중인 차례 없음


@windows
def test_screen_action_claim_once_by_the_starting_tab_and_result(hub):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    thread, box = _act_async(client, secret, "canvas.create_nodes", {"scene_id": SCENE, "nodes": [{"kind": "text", "text": "제목"}]})
    action = _wait_action(client, headers, turn["turn_id"])
    assert action["name"] == "canvas.create_nodes" and action["args"]["nodes"] == [{"kind": "text", "text": "제목"}]
    assert tab not in str(action)  # 번호는 허브 메모리에만
    aid = action["action_id"]
    assert _claim(client, headers, turn["turn_id"], aid, str(uuid4())).status_code == 403  # 다른 탭·새 창·다시 연 마운트
    claimed = _claim(client, headers, turn["turn_id"], aid, tab)
    assert claimed.status_code == 200
    token = claimed.json()["token"]
    assert _claim(client, headers, turn["turn_id"], aid, tab).status_code == 409  # 한 번만
    assert _result(client, headers, turn["turn_id"], aid, "x" * 32).json() == {"accepted": False}
    assert _result(client, headers, turn["turn_id"], aid, token).json() == {"accepted": True}
    assert _result(client, headers, turn["turn_id"], aid, token).json() == {"accepted": False}  # 두 번째 결과는 받지 않는다
    thread.join(10)
    reply = box["response"]
    assert reply.status_code == 200, reply.text
    assert reply.json()["status"] == "done" and reply.json()["ok"] is True and reply.json()["summary"] == "새 노드 1개 만듦"
    results = _events(client, headers, turn["turn_id"], "ui_action_result")
    assert [(r["action_id"], r["status"]) for r in results] == [(aid, "done")]
    detail = client.get(f"/api/agent-chat/conversations/{turn['conversation_id']}", headers=headers).text
    assert tab not in detail  # 복원 응답·차례 기록에도 번호가 없다
    _stop(client, headers, turn["turn_id"])


@windows
def test_screen_action_expiry_states_and_late_results(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    monkeypatch.setattr(chat, "SCREEN_ACTION_SECONDS", 1.0)
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    # 아무도 claim 하지 않음 = 실행 안 됨
    unclaimed = adapter_action(client, secret, "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": SCENE}})
    assert unclaimed.status_code == 200 and unclaimed.json()["status"] == "expired_unclaimed" and unclaimed.json()["ok"] is False
    # claim 뒤 답 없음 = 결과 불명, 기한 뒤 결과는 받지 않는다(사건도 없음)
    thread, box = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    action = _wait_action(client, headers, turn["turn_id"], count=2)
    token = _claim(client, headers, turn["turn_id"], action["action_id"], tab).json()["token"]
    thread.join(10)
    assert box["response"].json()["status"] == "unknown"
    assert _result(client, headers, turn["turn_id"], action["action_id"], token).json() == {"accepted": False}
    statuses = [r["status"] for r in _events(client, headers, turn["turn_id"], "ui_action_result")]
    assert statuses == ["expired_unclaimed", "unknown"]
    first = _events(client, headers, turn["turn_id"], "ui_action")[0]["action_id"]
    assert _claim(client, headers, turn["turn_id"], first, tab).status_code == 409  # 기한이 지난 동작은 claim 도 안 된다
    _stop(client, headers, turn["turn_id"])


@windows
def test_screen_action_turn_limits_and_turn_end(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    monkeypatch.setattr(chat, "SCREEN_ACTION_SECONDS", 0.3)
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    five = {"name": "canvas.create_nodes", "args": {"scene_id": SCENE, "nodes": [{"kind": "generation"}] * 5}}
    assert adapter_action(client, secret, "screen_action", five).status_code == 200
    assert adapter_action(client, secret, "screen_action", five).status_code == 200
    over = adapter_action(client, secret, "screen_action", {**five, "args": {**five["args"], "nodes": [{"kind": "text"}]}})
    assert over.status_code == 409 and "10" in over.json()["detail"]  # 쪼개 보내도 한 차례 누적 10
    # 차례가 끝나면 기다리던 동작은 닫히고, 그 뒤에는 사건을 내지 않는다
    monkeypatch.setattr(chat, "SCREEN_ACTION_SECONDS", 30.0)
    thread, box = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    _wait_action(client, headers, turn["turn_id"], count=3)
    before = len(_events(client, headers, turn["turn_id"], "ui_action_result"))
    _stop(client, headers, turn["turn_id"])
    thread.join(10)
    assert box["response"].json()["status"] == "closed"
    assert len(_events(client, headers, turn["turn_id"], "ui_action_result")) == before


@windows
def test_screen_action_hidden_only_my_generations_in_the_fixed_workspace(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    monkeypatch.setattr(chat, "SCREEN_ACTION_SECONDS", 0.3)
    rows = {"mine": {"id": "mine", "creator_uid": "u1", "ws": "here"}, "theirs": {"id": "theirs", "creator_uid": "u2", "ws": "here"},
            "elsewhere": {"id": "elsewhere", "creator_uid": "u1", "ws": "there"}}
    seen_ws = []

    def row(ctx, generation_id):
        if generation_id not in rows:
            raise HTTPException(404, "없음")
        return rows[generation_id]

    def workspace(ctx, scope, wid):
        seen_ws.append((scope, wid))
        return {"scope": scope, "id": wid}

    monkeypatch.setattr(mcp_api, "_generation_row", row)
    monkeypatch.setattr(mcp_api, "_request_workspace", workspace)
    monkeypatch.setattr(mcp_api, "_matches", lambda item, ws: item["ws"] == "here")
    monkeypatch.setattr(mcp_api, "_owner_uid", lambda ctx: "u1")
    headers = panel_headers(client)
    turn = _turn(client, headers, str(uuid4()))
    secret = profiles[-1]["secret"]
    thread, box = _act_async(client, secret, "library.set_hidden", {"generation_ids": ["mine", "theirs", "elsewhere", "nope", "mine"], "hidden": True})
    action = _wait_action(client, headers, turn["turn_id"])
    assert action["args"] == {"generation_ids": ["mine"], "hidden": True}  # 소유자·공간 대조로 남긴 것만 화면에 보낸다
    thread.join(10)
    assert sorted(box["response"].json()["skipped"]) == ["elsewhere", "nope", "theirs"]
    assert seen_ws == [("personal", None)]  # 차례 시작 때 고정한 공간
    none_left = adapter_action(client, secret, "screen_action", {"name": "library.set_hidden", "args": {"generation_ids": ["theirs"], "hidden": False}})
    assert none_left.status_code == 200 and none_left.json()["ok"] is False and none_left.json()["status"] == "skipped"
    _stop(client, headers, turn["turn_id"])


@windows
def test_cancel_first_means_the_result_is_not_taken_and_no_events(hub, monkeypatch):  # noqa: F811
    """취소가 잠금에서 먼저 정해지면 claim 한 동작의 결과도 받지 않고 상태 사건도 내지 않는다(독립 리뷰 P1)."""
    client, profiles, service = hub
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    thread, box = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    action = _wait_action(client, headers, turn["turn_id"])
    token = _claim(client, headers, turn["turn_id"], action["action_id"], tab).json()["token"]
    runtime = service._runtimes[turn["turn_id"]]
    chat._stop(runtime, "cancelled")  # 차례가 끝나기(done) 전, 멈춤만 정해진 순간
    assert _result(client, headers, turn["turn_id"], action["action_id"], token).json() == {"accepted": False}
    _stop(client, headers, turn["turn_id"])
    thread.join(40)
    assert box["response"].json()["status"] == "closed"
    assert _events(client, headers, turn["turn_id"], "ui_action_result") == []


@windows
def test_turn_without_screen_info_gets_no_screen_tab(hub):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    turn = _turn(client, headers, str(uuid4()), context={})  # '지금 화면' 칩을 뺀 차례
    refused = adapter_action(client, profiles[-1]["secret"], "screen_action", {"name": "canvas.read_selection", "args": {"scene_id": SCENE}})
    assert refused.status_code == 409 and "옆 칸" in refused.json()["detail"]
    _stop(client, headers, turn["turn_id"])


@windows
def test_concurrent_claims_give_one_token_and_other_limits(hub, monkeypatch):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    thread, _box = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    action = _wait_action(client, headers, turn["turn_id"])
    codes = []
    racers = [threading.Thread(target=lambda: codes.append(_claim(client, headers, turn["turn_id"], action["action_id"], tab).status_code))
              for _ in range(4)]
    for racer in racers:
        racer.start()
    for racer in racers:
        racer.join(10)
    assert sorted(codes) == [200, 409, 409, 409]  # 동시에 청해도 실행 표는 하나
    monkeypatch.setattr(chat, "SCREEN_ACTION_SECONDS", 0.2)
    ten = {"name": "canvas.connect", "args": {"scene_id": SCENE, "pairs": [["a", "b"]] * 10}}
    assert adapter_action(client, secret, "screen_action", ten).status_code == 200
    assert adapter_action(client, secret, "screen_action", ten).status_code == 200
    over = adapter_action(client, secret, "screen_action", {**ten, "args": {**ten["args"], "pairs": [["a", "b"]]}})
    assert over.status_code == 409 and "20" in over.json()["detail"]  # 잇기 한 차례 누적 20
    _stop(client, headers, turn["turn_id"])
    thread.join(40)


@windows
def test_deadline_is_checked_by_claim_and_result_themselves(hub):  # noqa: F811
    """만료 처리가 아직 안 돌았어도 실제 기한을 넘긴 claim·결과는 받지 않는다(독립 리뷰 2차 P2)."""
    client, profiles, service = hub
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    secret = profiles[-1]["secret"]
    runtime = service._runtimes[turn["turn_id"]]
    first, _ = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    late_claim = _wait_action(client, headers, turn["turn_id"])
    runtime.actions[late_claim["action_id"]].deadline = time.monotonic() - 1  # 기한만 지남(만료 처리 전)
    assert _claim(client, headers, turn["turn_id"], late_claim["action_id"], tab).status_code == 409
    second, _ = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    late_result = _wait_action(client, headers, turn["turn_id"], count=2)
    token = _claim(client, headers, turn["turn_id"], late_result["action_id"], tab).json()["token"]
    runtime.actions[late_result["action_id"]].deadline = time.monotonic() - 1
    assert _result(client, headers, turn["turn_id"], late_result["action_id"], token).json() == {"accepted": False}
    assert runtime.actions[late_result["action_id"]].state == "claimed"  # 결과로 확정하지 않았다(만료가 정한다)
    _stop(client, headers, turn["turn_id"])
    first.join(40)
    second.join(40)


@windows
def test_result_and_expiry_race_settles_once_and_cancel_blocks_new_actions(hub):  # noqa: F811
    client, _, service = hub
    headers = panel_headers(client)
    tab = str(uuid4())
    turn = _turn(client, headers, tab)
    runtime = service._runtimes[turn["turn_id"]]
    identity = runtime.identity
    for _ in range(15):
        action = service.issue_action(runtime, runtime.client_id, "canvas.read_selection", {"scene_id": SCENE}, 0)
        token = service.claim_action(identity, turn["turn_id"], action.action_id, tab)
        results = []
        racers = [threading.Thread(target=lambda: results.append(service.finish_action(identity, turn["turn_id"], action.action_id, token,
                                                                                       True, "ok", {}))),
                  threading.Thread(target=lambda: service.expire_action(runtime, action))]
        for racer in racers:
            racer.start()
        for racer in racers:
            racer.join(10)
        assert action.settled.is_set() and action.state in ("done", "unknown")
        assert results == [action.state == "done"]  # 결과가 받아들여졌다 = 결과가 먼저 확정
    events = _events(client, headers, turn["turn_id"], "ui_action_result")
    assert len(events) == 15 and len({e["action_id"] for e in events}) == 15  # 동작마다 정확히 하나
    chat._stop(runtime, "cancelled")
    try:
        service.issue_action(runtime, runtime.client_id, "canvas.read_selection", {"scene_id": SCENE}, 0)
        raise AssertionError("멈춘 차례에 동작을 발급했다")
    except chat.TurnGone:
        pass
    _stop(client, headers, turn["turn_id"])


@windows
def test_same_idempotency_key_keeps_the_first_screen_tab(hub):  # noqa: F811
    client, profiles, _ = hub
    headers = panel_headers(client)
    first, second = str(uuid4()), str(uuid4())
    key = uuid4().hex
    turn = _turn(client, headers, first, idempotency_key=key)
    again = start_turn(client, headers, context=CONTEXT, screen_tab=second, idempotency_key=key, conversation_id=turn["conversation_id"])
    assert again.json()["turn_id"] == turn["turn_id"]
    secret = profiles[-1]["secret"]
    thread, _box = _act_async(client, secret, "canvas.read_selection", {"scene_id": SCENE})
    action = _wait_action(client, headers, turn["turn_id"])
    assert _claim(client, headers, turn["turn_id"], action["action_id"], second).status_code == 403
    assert _claim(client, headers, turn["turn_id"], action["action_id"], first).status_code == 200
    _stop(client, headers, turn["turn_id"])
    thread.join(40)
