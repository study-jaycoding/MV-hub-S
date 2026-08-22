"""R13-IMPORT-1 — (계정 키, uid) 는 한 전환 락 구간에서 함께 캡처된다.

R12 는 가져오기 라우트 전체를 진입 시점 계정 DB 에 고정(@_account_scoped_route)하고 소유 uid
계산을 네트워크 앞으로 당겼다. 그래도 구멍이 하나 남았다: 데코레이터가 **키만** 캡처하고,
라우트 본문의 active_uid() 는 머신 포인터(active.json)를 따로 읽었다. 그 두 읽기 사이에
계정 전환이 착지하면 'DB=A · creator_uid=B' 라는 조용한 오귀속이 생긴다.

계약: 키와 uid 는 같은 transition_lock 구간에서 한 쌍으로 뜨고, 고정 구간 안의 active_uid()
는 그 캡처값을 돌려준다 — 캡처 직후에 전환이 착지해도 (A,A) 만 나온다.
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from app import active_account, config, db, deps, repo
from app.models import ImportIn
from app.routers import share


A_EMAIL = "r13-a@example.com"
B_EMAIL = "r13-b@example.com"
A_UID = "r13-a-uid"
B_UID = "r13-b-uid"


@pytest.fixture
def two_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 환경(test_r12_import_account_pin 과 동형)."""
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


# ── 캡처 원자성 ──────────────────────────────────────────────────────────────
def test_capture_reads_key_and_uid_inside_one_transition_lock(two_accounts, monkeypatch):
    """키를 읽은 직후 다른 스레드의 전환이 끼어들어도 uid 는 같은 계정의 것이다."""
    key_read = threading.Event()
    switched = threading.Event()

    def switch_account() -> None:
        key_read.wait(2)
        active_account.set_active(B_EMAIL, B_UID)  # 전환 락을 기다린다(캡처가 잡고 있음)
        switched.set()

    real_account_key = active_account.account_key

    def account_key_then_invite_the_switch():
        key_read.set()
        time.sleep(0.05)  # 전환 스레드가 락을 잡을 기회를 준다 — 잠기지 않았다면 여기서 낀다
        return real_account_key()

    switcher = threading.Thread(target=switch_account)
    switcher.start()
    monkeypatch.setattr(active_account, "account_key", account_key_then_invite_the_switch)
    try:
        pin = share._capture_account_pin()
    finally:
        switcher.join(5)

    assert pin == (A_EMAIL, A_UID), "키와 uid 가 갈리면 'A DB 에 쓰면서 소유자는 B'가 된다"
    assert switched.is_set(), "전환은 캡처가 끝난 뒤에 진행됐어야 한다"


def test_pinned_scope_freezes_active_uid_until_it_exits(two_accounts):
    """고정 구간 안에서는 포인터가 움직여도 키·uid 가 진입 시점 값으로 얼어 있다."""
    with share._pinned_account_scope():
        active_account.set_active(B_EMAIL, B_UID)  # 구간 도중 다른 창에서 전환
        assert active_account.account_key() == A_EMAIL
        assert active_account.active_uid() == A_UID

    assert active_account.account_key() == B_EMAIL  # 구간을 나오면 현재 포인터 그대로
    assert active_account.active_uid() == B_UID


# ── 라우트 계약 ──────────────────────────────────────────────────────────────
def test_import_owner_uid_survives_a_switch_landing_right_after_the_capture(
    two_accounts, monkeypatch
):
    """★핵심 회귀: 캡처 직후(라우트 본문 진입 전) A→B 전환이 착지해도 creator_uid 는 A 다."""
    monkeypatch.setattr(share._proxy, "proxying", lambda: True)
    _seed_shared_source("r13-import-src")
    real_capture = share._capture_account_pin

    def capture_then_switch():
        pin = real_capture()
        active_account.set_active(B_EMAIL, B_UID)  # 캡처와 본문 사이에 정확히 끼워 넣는다
        db.flush_pool()
        return pin

    monkeypatch.setattr(share, "_capture_account_pin", capture_then_switch)

    request = SimpleNamespace(state=SimpleNamespace(account=None))

    child = share.import_to_workspace("r13-import-src", ImportIn(), request)

    assert child["creator_uid"] == A_UID, "포인터를 직독하면 여기서 B_UID 가 박힌다"
    assert _for_account(A_EMAIL, lambda: repo.get_generation(child["id"])) is not None
    assert _for_account(B_EMAIL, lambda: repo.get_generation(child["id"])) is None
    assert active_account.account_key() == B_EMAIL, "override 는 라우트 안에서만"
