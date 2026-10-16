"""R12-3 — 공유 원본 준비(regen_source, 옛 import_to_workspace) 계정 고정.

공유 탭 '내 워크스페이스 / 재생성'의 앞단은 중간에 _materialize_remote_shared 로 서버를 왕복한다.
그 사이 다른 창에서 A→B 로 전환하면 'A 에서 읽은 원본을 B DB 에 심는' 섞인 조합이 조용히 생긴다 →
@_account_scoped_route 로 라우트 전체를 진입 시점 계정 DB 에 고정한다.

2026-10-16: 예전 import 는 여기서 대기(pending) 복제 행을 만들고 요청행을 넣지 않아 힉스필드로 나가지 않았다.
이제 원본만 돌려주고, 재생성은 화면이 일반 재생성 요청으로 보낸다(복제 행의 소유 uid 는 그쪽이 정한다).
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import active_account, config, db, deps, repo
from app.routers import share


A_EMAIL = "r12-a@example.com"
B_EMAIL = "r12-b@example.com"
A_UID = "r12-a-uid"
B_UID = "r12-b-uid"


@pytest.fixture
def two_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 환경(test_r11_* 와 같은 형태)."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])

    for email, uid in ((A_EMAIL, A_UID), (B_EMAIL, B_UID)):
        active_account.set_active(email, uid)
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        repo.set_setting("my_creator_uid", uid)

    active_account.set_active(A_EMAIL, A_UID)
    db.flush_pool()
    try:
        yield
    finally:
        db.flush_pool()
        active_account.reset_override(outer_token)


def _for_account(email: str, action):
    token = active_account.set_override(email)
    try:
        return action()
    finally:
        active_account.reset_override(token)


def _seed_shared_source(gen_id: str) -> None:
    """지금 활성인 계정 DB 에 '팀에서 가져올 수 있는' 공유 원본을 만든다."""
    repo.create_local_generation(
        {"model": "test-model", "prompt": "shared source"}, "me", generation_id=gen_id
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    repo.publish(gen_id, "me")  # shared_by 는 worker FK — 기본 작업자로


def test_source_stays_on_the_captured_account_when_the_switch_lands_mid_flight(
    two_accounts, monkeypatch
):
    """서버 왕복 중 A→B 전환이 껴도 받아 심은 원본은 A DB 에만 있다."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    source_id = "r12-remote-src"

    def fake_materialize(gen_id, request):
        # 실제 물질화는 '고정된' 계정 DB 에 원본을 쓴다. 그 왕복 사이에 다른 창이 계정을 바꾼다.
        _seed_shared_source(source_id)
        materialized = repo.get_generation(source_id)
        active_account.set_active(B_EMAIL, B_UID)
        db.flush_pool()
        return materialized, source_id

    monkeypatch.setattr(share, "_materialize_remote_shared", fake_materialize)
    request = SimpleNamespace(state=SimpleNamespace(account=None))

    source = share.regen_source("r12-remote-src", request)

    assert source["id"] == source_id
    assert active_account.account_key() == B_EMAIL, "override 는 라우트 안에서만"
    assert _for_account(A_EMAIL, lambda: repo.get_generation(source_id)) is not None
    assert _for_account(B_EMAIL, lambda: repo.get_generation(source_id)) is None


def test_local_source_comes_back_as_is(two_accounts, monkeypatch):
    """이미 이 PC 에 있는 공유 원본은 그대로 돌려준다(서버 왕복 없음)."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    monkeypatch.setattr(share, "_materialize_remote_shared", lambda *_: pytest.fail("로컬에 있으면 서버에 묻지 않는다"))
    _seed_shared_source("r12-local-src")
    request = SimpleNamespace(state=SimpleNamespace(account=None))

    assert share.regen_source("r12-local-src", request)["id"] == "r12-local-src"
    assert active_account.account_key() == A_EMAIL


def test_preparing_the_source_leaves_no_unsent_pending_row(two_accounts, monkeypatch):
    """★10-16 회귀: 예전 가져오기는 대기(pending) 복제 행만 만들고 요청행을 안 넣어 힉스필드로 안 나갔다 —
    원본 준비는 행을 만들지 않는다(재생성 요청이 placeholder 와 요청행을 함께 만든다)."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    _seed_shared_source("r12-count-src")
    request = SimpleNamespace(state=SimpleNamespace(account=None))

    def counts():
        with db.get_connection() as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM generation WHERE status='pending'").fetchone()[0],
            )

    before = counts()
    share.regen_source("r12-count-src", request)
    assert counts() == before


def test_shared_source_regenerate_reaches_the_agent_queue(two_accounts, monkeypatch):
    """★10-16 이어 붙이기(Codex P2): 원본 준비 → 일반 재생성 요청(usecase) → 에이전트가 같은 계정으로 요청을 가져간다.
    예전 가져오기는 여기서 가져갈 요청행이 없었다."""
    import asyncio
    from unittest import mock

    from app.models import RegenerateIn
    from app.usecases.gen_requests import GenRequestCommand, submit_gen_request

    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    _seed_shared_source("r12-queue-src")
    source = share.regen_source("r12-queue-src", SimpleNamespace(state=SimpleNamespace(account=None)))
    command = GenRequestCommand(
        kind="regenerate",
        email=A_EMAIL,
        creator_uid=A_UID,
        worker_id=source["worker_id"] or config.DEFAULT_WORKER_ID,
        source_gen_id=source["id"],
        workspace={"scope": "team", "id": "ws-1", "name": "팀"},
        regenerate=RegenerateIn(prompt=source["prompt"]),
    )
    with mock.patch("app.usecases.gen_requests.MANAGE_ENABLED", False), mock.patch(
        "app.usecases.gen_requests.agent_signals.signal"
    ) as signal, mock.patch("app.usecases.gen_requests.journal_generation_event"):
        child = asyncio.run(submit_gen_request(command))

    assert child and child["id"] != source["id"]
    assert child["creator_uid"] == A_UID
    signal.assert_called()  # 에이전트를 깨웠다
    claimed = repo.claim_pending_requests(A_EMAIL, 1, workspace_capable=True)
    assert [item["gen_id"] for item in claimed] == [child["id"]]
    assert claimed[0]["prompt"] == "shared source"
    assert claimed[0]["workspace"]["id"] == "ws-1"  # 과금 공간 = 화면이 보낸 지금 공간


# ── 소스 구조 계약(순서 회귀 차단) ───────────────────────────────────────────
def _route_function(name: str) -> ast.FunctionDef:
    tree = ast.parse(Path(share.__file__).read_text("utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} 라우트를 찾지 못했다")


def _decorator_names(func: ast.FunctionDef) -> set[str]:
    names = set()
    for dec in func.decorator_list:
        for node in ast.walk(dec):
            if isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Attribute):
                names.add(node.attr)
    return names


@pytest.mark.parametrize("route", ["regen_source", "publish"])
def test_routes_carry_the_account_scope_decorator(route):
    """원본 준비·발행 모두 라우트 전체가 한 계정 DB 로 고정된다."""
    assert "_account_scoped_route" in _decorator_names(_route_function(route))
