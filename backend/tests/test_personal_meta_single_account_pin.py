"""단건 개인메타(색·태그)도 라우트 도중 계정 전환에 흔들리지 않는다.

★왜(2026-09-13, 코덱스 3회차 실측): 배치 경로(`set_colors_batch`·태그 배치)는
 `_personal_meta_account_scope` 로 계정을 고정하는데 **단건**은 안 했다. 단건 경로
 (`_set_personal_shadow`) 안에는 판정과 저장 사이에 `_proxy.proxy_get` **네트워크 왕복**이
 있어서, 그 왕복을 기다리는 동안 다른 창에서 A→B 로 바꾸면 `shadow_apply` 가
 **B 계정 DB** 에 썼다. A 에는 아무것도 안 남는다 — 사용자는 "색이 사라졌다" 로 겪는다.

계약: 첫 DB 접근부터 저장까지 **한 계정**이다. 전환을 강제로 끼워 넣어도 기록은 A 에만 남고,
라우트가 끝난 뒤에야 머신 포인터(B)가 보인다.

시험 형태는 기존 `test_r11_p1_scope_atomicity.py` 와 같다 — 제품 라우트를 그대로 부르고
프록시 왕복 지점에서만 전환을 끼운다.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import pytest

from app import active_account, config, db, deps, repo
from app.routers import generation

A_EMAIL = "meta-pin-a@example.com"
B_EMAIL = "meta-pin-b@example.com"
A_UID = "meta-pin-a-uid"
B_UID = "meta-pin-b-uid"
ANCHOR = "server-job-1"


@pytest.fixture
def two_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 환경."""
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


def _request():
    return SimpleNamespace(state=SimpleNamespace(account=None))


def _color_overlays() -> dict[str, str]:
    """지금 활성 계정 DB 의 색 shadow 전부."""
    with db.get_connection() as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='gen_color_overlay'"
        ).fetchall()
        if not rows:
            return {}
        return {
            str(row[0]): str(row[1])
            for row in conn.execute("SELECT anchor, color FROM gen_color_overlay").fetchall()
        }


def _tag_overlays() -> set[tuple[str, str]]:
    with db.get_connection() as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='gen_tag_overlay'"
        ).fetchall()
        if not rows:
            return set()
        return {
            (str(row[0]), str(row[1]))
            for row in conn.execute("SELECT anchor, tag FROM gen_tag_overlay").fetchall()
        }


def _switching_proxy(observed: dict):
    """서버 왕복 도중(=판정 뒤, 저장 전)에 A→B 전환을 끼워 넣는 프록시 대역."""

    def proxy_get(path, _request, **_kwargs):
        observed["path"] = path
        observed["scope_before"] = active_account.account_key()
        active_account.set_active(B_EMAIL, B_UID)  # 다른 창에서 계정 전환
        db.flush_pool()
        observed["pointer_after_switch"] = (active_account._read_pointer() or {}).get("email")
        observed["scope_after_switch"] = active_account.account_key()
        return {"id": "srv-uuid-1", "job_id": ANCHOR}

    return proxy_get


def test_single_color_stays_on_the_captured_account(two_accounts) -> None:
    """★색 단건 — 왕복 중 전환이 껴도 shadow 는 A 에만 남는다."""
    observed: dict = {}
    with (
        mock.patch.object(generation._proxy, "proxying", return_value=True),
        mock.patch.object(
            generation._proxy, "proxy_get", side_effect=_switching_proxy(observed)
        ),
    ):
        out = generation.set_color("srv-uuid-1", generation.ColorIn(color="red"), _request())

    assert out["color"] == "red"
    assert observed["pointer_after_switch"] == B_EMAIL, "전환 자체는 실제로 일어났다"
    assert observed["scope_after_switch"] == A_EMAIL, "라우트 안에서는 계속 A 로 보여야 한다"
    # 라우트가 끝나면 override 가 풀려 머신 포인터(B)가 다시 보인다.
    assert active_account.account_key() == B_EMAIL

    assert _for_account(A_EMAIL, _color_overlays) == {ANCHOR: "red"}
    assert _for_account(B_EMAIL, _color_overlays) == {}, "남의 계정 DB 로 새면 안 된다"


def test_single_tag_stays_on_the_captured_account(two_accounts) -> None:
    """★태그 단건도 같은 계약 — 색만 고치고 태그를 빠뜨리면 반쪽이다."""
    observed: dict = {}
    with (
        mock.patch.object(generation._proxy, "proxying", return_value=True),
        mock.patch.object(
            generation._proxy, "proxy_get", side_effect=_switching_proxy(observed)
        ),
    ):
        generation.set_tags("srv-uuid-1", generation.TagsIn(tags=["검토"]), _request())

    assert observed["scope_after_switch"] == A_EMAIL
    assert _for_account(A_EMAIL, _tag_overlays) == {(ANCHOR, "검토")}
    assert _for_account(B_EMAIL, _tag_overlays) == set()
