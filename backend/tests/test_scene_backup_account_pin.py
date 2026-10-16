"""씬 백업·카드 소속 요청은 화면이 실은 계정과 같은 계정 DB 에서만 읽고 쓴다(81회차 F-A-02).

★왜: 다른 브라우저 프로필(앱 창 전용 프로필 + 일반 크롬)에서 계정을 바꾸면 storage 알림이 프로필을 넘지 않아, 옛 화면은
 자기 계정(A)인 줄 알고 자동 백업을 보낸다. 허브는 기대 계정 없이 그때의 활성 계정(B) DB 에 썼다 — A 의 씬이 B 에 섞이고,
 A 화면의 삭제 미러가 B 의 행을 지울 수 있었다. 복구(GET include_data)는 B 의 씬을 A 의 화면으로 가져왔다.

계약: 화면이 `X-MVHub-Expect-Account`(생성·Comfy 와 같은 헤더)를 실으면 허브는 **계정·DB 를 먼저 고정한 뒤** 비교하고, 다르면 409 로
 아무것도 읽고 쓰지 않는다. 같으면 그 고정 범위에서 읽고 쓴다(비교 직후 전환이 끼어도 A 에 남는다).
 헤더가 없는 옛 화면은 지금처럼 받는다 — 옛 화면까지 막을지는 Jay 결정 대기다(호환).
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import active_account, config, db, deps, repo
from app.routers import scenes

A_EMAIL = "scene-pin-a@example.com"
B_EMAIL = "scene-pin-b@example.com"
HEADER = "X-MVHub-Expect-Account"


@pytest.fixture
def two_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 환경(AUTH off 로컬 허브)."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    for email in (A_EMAIL, B_EMAIL):
        active_account.set_active(email, None)
        db.flush_pool()
        db.init_db()
    active_account.set_active(A_EMAIL, None)
    db.flush_pool()
    try:
        yield
    finally:
        db.flush_pool()
        active_account.reset_override(outer_token)


def _request(expect: str | None):
    return SimpleNamespace(state=SimpleNamespace(account=None), headers={HEADER: expect} if expect else {})


def _switch_to_b() -> None:
    """다른 프로필에서 B 로 로그인 — 머신 포인터가 바뀐다."""
    active_account.set_active(B_EMAIL, None)
    db.flush_pool()


def _scene(sid: str, name: str = "씬") -> str:
    return json.dumps({"id": sid, "name": name, "cards": [], "edges": [], "created_at": 1})


def _sync(request, upserts=(), deleted=()):
    body = scenes.SceneSyncIn(upserts=[scenes.SceneUpsertIn(id=sid, data=_scene(sid)) for sid in upserts], deleted_ids=list(deleted))
    return scenes.sync_scene_backups(body, request)


def _cards(request, added=()):
    body = scenes.CardLinkSyncIn(backfill=[scenes.CardLinkIn(scene_id="s", card_id="c", generation_id=g) for g in added])
    return scenes.sync_scene_card_links(body, request)


def _state(email: str):
    """그 계정 DB 의 씬 백업 id·카드 소속 생성물 — owner 는 라우트와 같은 actor_id."""
    owner = deps.actor_id(_request(None))
    token = active_account.set_override(email)
    try:
        return (
            sorted(row["id"] for row in repo.list_scene_backups(owner)),
            sorted(row["generation_id"] for row in repo.list_scene_card_links(owner, None)),
        )
    finally:
        active_account.reset_override(token)


def _expect_409(call) -> None:
    with pytest.raises(HTTPException) as caught:
        call()
    assert caught.value.status_code == 409


def test_scene_backup_rejects_stale_profile_account(two_accounts) -> None:
    """프로필 A 의 화면은 그대로, 다른 프로필에서 B 로 바꾼 뒤 A 의 자동 저장·삭제·복구·카드 소속 → 409, 양쪽 DB 불변."""
    tab_a = _request(f"acct:{A_EMAIL}")
    _sync(tab_a, upserts=["a-1"])
    _cards(tab_a, added=["g-a"])
    _switch_to_b()
    _sync(_request(f"acct:{B_EMAIL}"), upserts=["b-1"])  # B 화면은 B 로 잘 쓴다
    before = (_state(A_EMAIL), _state(B_EMAIL))
    assert before == ((["a-1"], ["g-a"]), (["b-1"], []))

    _expect_409(lambda: _sync(tab_a, upserts=["a-2"], deleted=["a-1", "b-1"]))  # 자동 저장·삭제 미러
    _expect_409(lambda: scenes.list_scene_backups(tab_a, "", True))  # 복구 — B 의 씬을 A 화면으로 가져오지 않는다
    _expect_409(lambda: scenes.list_scene_backups(tab_a, "", False))  # 변경 대조용 메타
    _expect_409(lambda: _cards(tab_a, added=["g-a2"]))
    _expect_409(lambda: scenes.list_scene_card_links(tab_a, ""))
    assert (_state(A_EMAIL), _state(B_EMAIL)) == before
    # 대소문자만 다른 같은 계정은 통과한다
    assert _sync(_request(f"acct:{B_EMAIL.upper()}"), upserts=["b-2"])["ok"]


def test_scene_backup_without_header_keeps_old_behavior(two_accounts) -> None:
    """헤더 없는 옛 화면은 지금처럼 그때의 활성 계정으로 받는다 — 옛 화면까지 막을지는 Jay 결정 대기(호환)."""
    _switch_to_b()
    assert _sync(_request(None), upserts=["old-1"])["ok"]
    assert _state(B_EMAIL) == (["old-1"], [])
    assert _state(A_EMAIL) == ([], [])


@pytest.mark.parametrize("kind", ["backup", "cards"])
def test_scene_backup_pins_account_through_write(two_accounts, monkeypatch, kind) -> None:
    """비교 직후(저장 직전) 다른 프로필의 전환이 끼어도 A 화면의 쓰기는 A 에만 남는다 — 비교 뒤 DB 를 다시 고르지 않는다."""
    name = "sync_scene_backups" if kind == "backup" else "sync_scene_card_links"
    original = getattr(repo, name)

    def switching(*args, **kwargs):
        _switch_to_b()
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, name, switching)
    tab_a = _request(f"acct:{A_EMAIL}")
    if kind == "backup":
        _sync(tab_a, upserts=["a-1"])
        assert (_state(A_EMAIL), _state(B_EMAIL)) == ((["a-1"], []), ([], []))
    else:
        _cards(tab_a, added=["g-a"])
        assert (_state(A_EMAIL), _state(B_EMAIL)) == (([], ["g-a"]), ([], []))
    assert active_account.account_key() == B_EMAIL  # 라우트가 끝나면 머신 포인터(B)가 다시 보인다
