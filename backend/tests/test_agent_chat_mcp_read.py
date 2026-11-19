"""MV Agent 대화 기록 MCP 읽기(설계 docs/status/MVAgent_대화기록_MCP읽기_2026-11-12.md 4절 ①~⑯) — 격리 DB·격리 대화 폴더, 실제 CLI·생성 없음."""
import json
import secrets
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config, db, deps, repo
from app.db_paths import get_db_path
from app.emailnorm import norm_email
from app.repo import agent_chat as chat_store
from app.repo import mcp_v2 as store
from app.routers import agent_chat as panel_router, auth as auth_router, gen_requests, mcp as mcp_router, mcp_v2 as api
from app.services import agent_chat as chat

APP_HEADERS = {"X-MVHub-Tab": "t" * 40}
SECRET_MARK = "SECRET-DO-NOT-LEAK"


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "hub.db"))
    monkeypatch.setenv("CONTENT_HUB_NO_PROXY", "1")
    db.flush_pool()
    db.init_db()
    for module in (config, deps, gen_requests):
        monkeypatch.setattr(module, "AUTH_ENABLED", True)
    monkeypatch.setattr(config, "AGENT_CHAT_DIR", tmp_path / "agent_chat")
    account = repo.register("Reader@Example.test", "testpass")
    credentials = {}

    def configure(name, setup, credential):
        credentials[name] = credential
        return {"client": name, "status": "configured", "message": "ok"}

    monkeypatch.setattr(api, "_configure_local", configure)
    monkeypatch.setattr(api, "_remove_profiles", lambda hub, ids: None)

    async def models():
        return [{"job_set_type": "nano_banana_flash", "display_name": "Nano Banana 2", "type": "image"}]

    monkeypatch.setattr(api.generation, "list_models", models)
    app = FastAPI()

    @app.middleware("http")
    async def session(request, call_next):
        request.state.account = repo.get_account(account["email"])
        return await call_next(request)

    app.include_router(api.router)
    app.include_router(auth_router.router)
    with TestClient(app, base_url="http://127.0.0.1:8012", client=("127.0.0.1", 50461)) as client:
        yield SimpleNamespace(client=client, credentials=credentials, account=account, tmp=tmp_path)
    db.flush_pool()


def register(env, name="claude", scope="account", execute=True):
    response = env.client.post("/api/mcp/v2/app/configure", headers=APP_HEADERS, json={
        "clients": [name], "scope": scope, **({"workspace": {"scope": "personal"}} if scope == "workspace" else {}),
        "allow_execution": execute})
    assert response.status_code == 200, response.text
    return env.credentials[name]["secret"]


def read(env, secret, **args):
    return env.client.post("/api/mcp/v2/client/action", headers={"X-MVHub-MCP": "1", "X-MVHub-MCP-Secret": secret},
                           json={"method": "read_context", "args": args})


def identity(email, db_path=None):
    return chat.Identity(api._required_hub_id(), db_path or str(get_db_path().resolve()), norm_email(email))


def own_path(env):
    return identity(env.account["email"]).file_path()


def add_events(path, turn_id, events):
    """사건을 한 연결로 한꺼번에(수천 개 시험이 느리지 않게) — 순번은 append_event 와 같은 규칙."""
    with chat_store.connect(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        start = conn.execute("SELECT COALESCE(MAX(seq),0) FROM agent_chat_event WHERE turn_id=?", (turn_id,)).fetchone()[0]
        conn.executemany("INSERT INTO agent_chat_event(turn_id,seq,kind,payload) VALUES(?,?,?,?)",
                         [(turn_id, start + i + 1, kind, json.dumps(payload, ensure_ascii=False)) for i, (kind, payload) in enumerate(events)])
        conn.execute("COMMIT")


def make_conv(path, title="고양이 대화", engine="claude", turns=()):
    store_path = chat_store.open_db(path)
    conv = chat_store.create_conversation(store_path, engine=engine, model="opus" if engine == "claude" else "gpt-6.1-sol",
                                          effort="medium", client_id="panel-" + uuid4().hex,
                                          mcp_entry={"command": "python", "args": ["--profile", f"C:/{SECRET_MARK}/profile.bin"]}, title=title)
    made = []
    for spec in turns:
        turn, _ = chat_store.claim_turn(store_path, conversation_id=conv["id"], idempotency_key=uuid4().hex,
                                        text=spec.get("text", "질문"), context=spec.get("context", {"tab": "my"}))
        add_events(store_path, turn["id"], spec.get("events", []))
        if spec.get("status", "done") != "running":
            chat_store.set_status(store_path, turn["id"], spec.get("status", "done"), reason=spec.get("reason"))
        made.append(turn)
    return conv, made


def plan_event(plan_id, items=1, prompt="딸기", extra=None):
    return ("plan", {"plan": {"plan_id": plan_id, "title": "과일 계획", "status": "pending", SECRET_MARK: "x",
                              "workspace": {"scope": "team", "id": "ws-1", "name": "팀", "token": SECRET_MARK},
                              "items": [{"model": "nano_banana_flash", "prompt": prompt, "secret": SECRET_MARK,
                                         "params": {"aspect_ratio": "16:9", "seed": 7, "api_key": SECRET_MARK}}] * items,
                              **(extra or {})}})


def progress_event(plan_id, state="done"):
    return ("plan_progress", {"plan_id": plan_id, "plan_status": "submitted", "observed_at": "2026-11-12T10:00:00",
                              "items": [{"index": 0, "state": "submitted", "generation_id": "gen-1", "generation_status": state,
                                         "secret": SECRET_MARK}]})


# ① 모양·허용 목록 · ⑥ Claude 조각/Codex 통째 · ⑨ 뒤 차례 진행 · ⑬ 오류 까닭
def test_read_shape_is_allowlisted_and_answers_reconstructed(local):
    secret = register(local)
    path = own_path(local)
    plan_id = str(uuid4())
    conv, _ = make_conv(path, turns=[
        {"text": "딸기 그려 줘", "context": {"tab": "compose", "workspace": {"scope": "team", "id": "ws-1", "name": "팀", "token": SECRET_MARK},
                                         "project": "뻘뻘뻘", "scene": {"id": "s1", "name": "씬 1"}, "selected_ids": ["a", "b"], "api_key": SECRET_MARK},
         "events": [("text_delta", {"text": "계획을 "}), ("text_delta", {"text": "세울게요."}), ("text", {"text": "계획을 세울게요."}),
                    ("tool", {"name": "read_context", "status": "started"}), ("tool", {"name": "read_context", "status": "done"}),
                    ("tool", {"name": "read_context", "status": "started"}), ("tool", {"name": "read_context", "status": "failed"}),
                    plan_event(plan_id), ("text_delta", {"text": "다 됐어요"}),
                    ("error", {"message": "10분이 지나 멈췄습니다."}), ("error", {"message": f"이 AI 는 지금 쓸 수 없습니다 — {SECRET_MARK}"})],
         "status": "failed", "reason": "timeout"},
        {"text": "결과는?", "events": [progress_event(plan_id)]},  # 앞 차례 계획의 진행이 이 차례에 기록됨
    ])
    codex_conv, _ = make_conv(path, title="코덱스", engine="codex", turns=[{"events": [("text", {"text": "통째 답"})]}])

    listing = read(local, secret, kind="agent_chats")
    assert listing.status_code == 200, listing.text
    rows = listing.json()["conversations"]
    assert {row["id"] for row in rows} == {conv["id"], codex_conv["id"]}
    assert set(rows[0]) == {"id", "title", "engine", "model", "updated_at", "project", "turns", "in_claude_app"}
    assert all(row["in_claude_app"] is False for row in rows)
    assert {row["model"] for row in rows} == {"Opus 5.5", "GPT-6.1 Sol"}

    body = read(local, secret, kind="agent_chat", conversation_id=conv["id"]).json()
    assert SECRET_MARK not in json.dumps(body, ensure_ascii=False)  # 연결 정보·임의 열쇠·CLI 원문이 안 나감
    first, second = body["turns"]
    assert first["answer"] == "계획을 세울게요.\n\n다 됐어요"  # 조각+통째가 한 번씩만
    assert first["screen"] == {"tab": "compose", "project": "뻘뻘뻘", "workspace": {"scope": "team", "name": "팀"}, "scene": "씬 1", "selected": 2}
    assert first["tools"] == [{"name": "read_context", "count": 2, "failed": 1}]
    assert first["errors"] == ["10분이 지나 멈췄습니다.", "실행 중 문제가 있었습니다."]
    plan = first["plans"][0]
    assert plan["items"] == [{"model": "Nano Banana 2", "prompt": "딸기", "params": {"aspect_ratio": "16:9"}}]
    assert (plan["workspace_scope"], plan["workspace_id"]) == ("team", "ws-1")
    assert plan["progress"]["items"] == [{"index": 0, "state": "submitted", "generation_status": "done", "generation_id": "gen-1"}]
    assert second["plans"] == [] and "live" not in second
    assert set(body["conversation"]) == {"id", "title", "engine", "model", "effort", "updated_at", "in_claude_app"}
    assert body["conversation"]["in_claude_app"] is False
    assert "get_plan" in body["note"] and body["earlier_turns"] == 0 and body["next_cursor"] is None
    codex = read(local, secret, kind="agent_chat", conversation_id=codex_conv["id"]).json()
    assert codex["turns"][0]["answer"] == "통째 답"


# ② 신원 — 칸과 같은 식, 다른 계정·다른 DB 경로 파일은 안 보임
def test_identity_matches_panel_and_other_identities_are_invisible(local):
    ctx = SimpleNamespace(hub="hub-x", path=Path("C:/data/hub.db"), account={"email": "Mixed@Example.TEST"})
    assert api._chat_identity(ctx) == panel_router._identity(ctx)
    secret = register(local)
    mine, _ = make_conv(own_path(local), title="내 대화")
    make_conv(identity("other@example.test").file_path(), title="남의 대화")
    make_conv(identity(local.account["email"], db_path=str(local.tmp / "other.db")).file_path(), title="다른 DB")
    rows = read(local, secret, kind="agent_chats").json()["conversations"]
    assert [row["id"] for row in rows] == [mine["id"]]


# ③ 공간 고정 403 · 실행권 없는 일반 연결은 읽힘 · ④ 칸 연결 403
def test_only_account_scope_non_panel_clients_read(local):
    make_conv(own_path(local))
    fixed = register(local, "codex", scope="workspace")
    assert read(local, fixed, kind="agent_chats").status_code == 403
    viewer = register(local, "other", execute=False)
    assert read(local, viewer, kind="agent_chats").status_code == 200
    row = store.client_for_secret(mcp_router.digest(viewer))
    panel_secret = secrets.token_urlsafe(32)
    store.create_client(mcp_router.digest(panel_secret), row["hub_id"], row["owner_uid"], row["account_email"],
                        row["password_stamp"], {"scope": "account"}, api.PANEL_CLIENT, False)
    refused = read(local, panel_secret, kind="agent_chats")
    assert refused.status_code == 403 and "칸" in refused.json()["detail"]


# ⑤ 없는 파일 = 빈 결과·파일 안 생김 · ⑭ 읽기 전후 파일 그대로 · ⑩·⑯ 앞 프로세스의 running 차례
def test_read_never_creates_or_changes_files(local, monkeypatch):
    secret = register(local)
    path = own_path(local)
    assert read(local, secret, kind="agent_chats").json()["conversations"] == []
    assert not path.exists() and not path.parent.exists()
    conv, _ = make_conv(path, turns=[{"events": [("text_delta", {"text": "그리는 중"})], "status": "running"}])
    db.flush_pool()

    def files():
        return {suffix: (Path(str(path) + suffix).read_bytes() if Path(str(path) + suffix).exists() else b"") for suffix in ("", "-wal")}

    before = files()
    monkeypatch.setattr(chat_store, "_opened", set())  # 새 프로세스처럼 — open_db 였다면 running 을 interrupted 로 바꿨을 것
    body = read(local, secret, kind="agent_chat", conversation_id=conv["id"]).json()
    turn = body["turns"][0]
    assert (turn["status"], turn["live"], turn["answer"]) == ("running", False, "그리는 중")
    assert files() == before
    with chat_store.connect(path) as conn:
        assert conn.execute("SELECT status FROM agent_chat_turn").fetchone()[0] == "running"


# ⑭ 손상 파일은 503(빈 결과로 숨기지 않음)
def test_corrupt_file_is_503(local):
    secret = register(local)
    path = own_path(local)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a database" * 100)
    response = read(local, secret, kind="agent_chats")
    assert response.status_code == 503 and response.json()["detail"] == "대화 기록을 읽지 못했습니다."


# ⑦ 예산·커서 — 실제로 돌려준 가장 오래된 차례 기준, 쪽 사이 중복·누락 없음(같은 시각 차례), 사건 수천 개도 끝까지
def test_budget_paging_reaches_every_turn_once(local):
    secret = register(local)
    long_answer = "가" * 12_000
    conv, made = make_conv(own_path(local), turns=[{"text": f"질문 {i}", "events": [("text", {"text": long_answer})]} for i in range(20)]
                           + [{"text": "긴 답", "events": [("text_delta", {"text": "나" * 10})] * 3000}])
    seen, cursor, pages = [], None, 0
    while True:
        args = {"kind": "agent_chat", "conversation_id": conv["id"], "limit": 50, **({"chat_cursor": cursor} if cursor else {})}
        response = read(local, secret, **args)
        assert response.status_code == 200, response.text
        assert len(response.content) <= chat.CHAT_READ_BUDGET
        body = response.json()
        assert body["earlier_turns"] == len(made) - len(seen) - len(body["turns"])
        seen = [turn["you"] for turn in body["turns"]] + seen
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == [f"질문 {i}" for i in range(20)] + ["긴 답"] and pages > 1
    last = read(local, secret, kind="agent_chat", conversation_id=conv["id"], limit=1).json()["turns"][0]
    assert last["answer"] == "나" * 12_000 and last["answer_truncated"] is True  # 앞 500건 너머까지 읽음


def test_single_oversized_turn_is_shrunk_and_lists_are_capped(local):
    secret = register(local)
    plans = [plan_event(str(uuid4()), items=25, prompt="다" * 500) for _ in range(12)]
    conv, _ = make_conv(own_path(local), turns=[{"events": [("text", {"text": "라" * 12_000}), *plans]
                                                 + [("error", {"message": "10분이 지나 멈췄습니다."})] * 7}])
    response = read(local, secret, kind="agent_chat", conversation_id=conv["id"])
    assert response.status_code == 200 and len(response.content) <= chat.CHAT_READ_BUDGET
    turn = response.json()["turns"][0]
    assert len(turn["errors"]) == 5 and turn["omitted"]["errors"] == 2
    assert turn["omitted"]["plans"] >= 2 and len(turn["plans"]) <= 10
    assert all(len(item["prompt"]) <= 100 for plan in turn["plans"] for item in plan["items"])


# ⑧ 목록 검색(대소문자 무시)·쪽 넘김 · 커서 섞기 422
def test_list_search_paging_and_cursor_misuse(local):
    secret = register(local)
    path = own_path(local)
    a, _ = make_conv(path, title="Cat 하나", turns=[{}])
    b, _ = make_conv(path, title="cat 둘", turns=[{}])
    make_conv(path, title="개")
    found = read(local, secret, kind="agent_chats", search="CAT").json()
    assert {row["id"] for row in found["conversations"]} == {a["id"], b["id"]} and found["next_cursor"] is None
    page1 = read(local, secret, kind="agent_chats", limit=2).json()
    page2 = read(local, secret, kind="agent_chats", limit=2, chat_cursor=page1["next_cursor"]).json()
    ids = [row["id"] for row in page1["conversations"] + page2["conversations"]]
    assert len(ids) == len(set(ids)) == 3 and page2["next_cursor"] is None
    turn_cursor = read(local, secret, kind="agent_chat", conversation_id=a["id"], limit=1).json()["next_cursor"]
    assert turn_cursor is None  # 차례 하나뿐
    two, _ = make_conv(path, title="둘", turns=[{}, {}])
    cursor = read(local, secret, kind="agent_chat", conversation_id=two["id"], limit=1).json()["next_cursor"]
    for bad in (dict(kind="agent_chat", conversation_id=a["id"], chat_cursor=cursor),      # 다른 대화의 차례 커서
                dict(kind="agent_chats", chat_cursor=cursor),                                  # 목록에 차례 커서
                dict(kind="agent_chat", conversation_id=two["id"], chat_cursor=page1["next_cursor"]),
                dict(kind="agent_chats", chat_cursor="!!garbage!!")):
        assert read(local, secret, **bad).status_code == 422, bad


# 독립 리뷰 1차 — 커서 순번 범위(500 대신 422) · 목록 글 상한 · 잘린 조각 뒤 통째 글
def test_review_regressions(local):
    secret = register(local)
    path = own_path(local)
    conv, _ = make_conv(path, title="제" * 300, turns=[{"context": {"tab": "my", "project": "가" * 100_000}},
                                                      {"events": [("text", {"text": ""}), ("text", {"text": "라" * 12_000})]},
                                                      {"events": [("text", {"text": "다" * 12_000}), ("text", {"text": "추가 답"})]},
                                                      {"events": [("text_delta", {"text": "나" * 20_000}), ("text", {"text": "짧은 최종"})]}])
    overflow = chat._encode_cursor("t", "2026-11-12 00:00:00", 2 ** 63, conv["id"])
    assert read(local, secret, kind="agent_chat", conversation_id=conv["id"], chat_cursor=overflow).status_code == 422
    listing = read(local, secret, kind="agent_chats")
    row = listing.json()["conversations"][0]
    assert (len(row["project"]), len(row["title"])) == (200, 80) and len(listing.content) < 10_000
    exact, full, last = read(local, secret, kind="agent_chat", conversation_id=conv["id"], limit=3).json()["turns"]
    assert exact["answer"] == "라" * 12_000 and "answer_truncated" not in exact  # 빈 덩어리는 빈 줄 자리를 먹지 않는다(독립 리뷰 3차)
    assert last["answer"] == "짧은 최종" and "answer_truncated" not in last  # 잘린 조각을 짧은 최종 글이 바꾸면 잘림 아님
    assert full["answer"] == "다" * 12_000 and full["answer_truncated"] is True  # 자리가 없어 못 담은 뒤 덩어리도 잘림(독립 리뷰 2차)


# ⑪ 읽는 사이 해제 → 403
def test_revoked_during_read_is_refused(local, monkeypatch):
    secret = register(local)
    make_conv(own_path(local))
    row = store.client_for_secret(mcp_router.digest(secret))
    original = chat.chat_list

    def revoke_then_list(*args, **kwargs):
        store.revoke(row["id"], row["owner_uid"], row["account_email"])
        return original(*args, **kwargs)

    monkeypatch.setattr(chat, "chat_list", revoke_then_list)
    assert read(local, secret, kind="agent_chats").status_code == 403


# ⑫ 없는 대화 404 · 입력 형식 422
def test_not_found_and_invalid_inputs(local):
    secret = register(local)
    make_conv(own_path(local))
    assert read(local, secret, kind="agent_chat", conversation_id=str(uuid4())).status_code == 404
    for bad in (dict(kind="agent_chat", conversation_id="not-a-uuid"), dict(kind="agent_chat"),
                dict(kind="agent_chats", conversation_id=str(uuid4())), dict(kind="agent_chats", workspace_scope="personal"),
                dict(kind="agent_chats", limit=60), dict(kind="projects", workspace_scope="personal", chat_cursor="x")):
        assert read(local, secret, **bad).status_code == 422, bad


# ⑬ 오류 사건 없이 끝난 까닭(restart)
def test_reason_without_error_event_is_explained(local):
    secret = register(local)
    conv, _ = make_conv(own_path(local), turns=[{"status": "interrupted", "reason": "restart"}])
    turn = read(local, secret, kind="agent_chat", conversation_id=conv["id"]).json()["turns"][0]
    assert turn["errors"] == ["허브가 다시 켜져 멈췄습니다."]


# ⑮ 칸 기능이 꺼진 허브도 있는 기록은 읽는다
def test_disabled_panel_still_reads_existing_history(local, monkeypatch):
    monkeypatch.setattr(config, "AGENT_CHAT_ENABLED", False)
    secret = register(local)
    conv, _ = make_conv(own_path(local))
    assert [row["id"] for row in read(local, secret, kind="agent_chats").json()["conversations"]] == [conv["id"]]
