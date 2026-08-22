"""R12-3 — import_to_workspace 계정 고정 + 소유 uid 계산 순서.

가져오기는 중간에 _materialize_remote_shared 로 서버를 왕복한다. 그 사이 다른 창에서 A→B 로
전환하면 'A 에서 읽은 원본을 B DB 에 복제'하는 섞인 조합이 조용히 생긴다 →
@_account_scoped_route 로 라우트 전체를 진입 시점 계정 DB 에 고정한다.

★고정만 붙이면 새 구멍이 생긴다: creator_uid 폴백인 active_uid() 는 override 를 보지 않고
active.json 포인터를 직독하므로, 서버 왕복 '뒤'에 계산하면 DB=A 인데 소유 uid=B 인 오귀속이
된다. 그래서 uid 계산을 캡처 직후·네트워크 전으로 옮기는 것까지가 한 처방이다.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import active_account, config, db, deps, repo
from app.models import ImportIn
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


def test_import_stays_on_the_captured_account_when_the_switch_lands_mid_flight(
    two_accounts, monkeypatch
):
    """서버 왕복 중 A→B 전환이 껴도 복제 행과 소유 uid 는 모두 A 다."""
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

    child = share.import_to_workspace("r12-remote-src", ImportIn(), request)

    assert child, "복제본이 만들어져야 한다"
    assert active_account.account_key() == B_EMAIL, "override 는 라우트 안에서만"
    # ① 복제 행은 캡처한 A DB 에만 있다.
    assert _for_account(A_EMAIL, lambda: repo.get_generation(child["id"])) is not None
    assert _for_account(B_EMAIL, lambda: repo.get_generation(child["id"])) is None
    # ② 소유 uid 도 A — 네트워크 뒤에 계산했다면 포인터 직독으로 B_UID 가 박힌다.
    assert child["creator_uid"] == A_UID


def test_import_without_the_switch_keeps_the_same_owner_uid(two_accounts, monkeypatch):
    """전환이 없을 때의 폴백 순서·값 의미는 그대로다(계정=A → 소유 uid=A)."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    _seed_shared_source("r12-local-src")
    request = SimpleNamespace(state=SimpleNamespace(account=None))

    child = share.import_to_workspace("r12-local-src", ImportIn(), request)

    assert child["creator_uid"] == A_UID
    assert active_account.account_key() == A_EMAIL


def test_session_account_uid_still_wins_over_the_pointer(two_accounts, monkeypatch):
    """세션 계정의 creator_uid 가 있으면 그대로 우선 — 폴백은 프록시 모드에서만."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    _seed_shared_source("r12-session-src")
    request = SimpleNamespace(
        state=SimpleNamespace(account={"email": A_EMAIL, "creator_uid": "session-uid"})
    )

    child = share.import_to_workspace("r12-session-src", ImportIn(), request)

    assert child["creator_uid"] == "session-uid"


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


def _statement_index(func: ast.FunctionDef, symbol: str) -> int:
    for index, statement in enumerate(func.body):
        for node in ast.walk(statement):
            if isinstance(node, ast.Name) and node.id == symbol:
                return index
    raise AssertionError(f"{symbol} 를 함수 본문에서 찾지 못했다")


@pytest.mark.parametrize("route", ["import_to_workspace", "publish"])
def test_routes_carry_the_account_scope_decorator(route):
    """가져오기·발행 모두 라우트 전체가 한 계정 DB 로 고정된다."""
    assert "_account_scoped_route" in _decorator_names(_route_function(route))


def test_owner_uid_is_computed_before_the_remote_round_trip():
    """★uid 계산이 네트워크(물질화)보다 앞에 있어야 한다 — 조용한 오귀속 회귀 차단."""
    func = _route_function("import_to_workspace")
    assert _statement_index(func, "active_uid") < _statement_index(
        func, "_materialize_remote_shared"
    )
