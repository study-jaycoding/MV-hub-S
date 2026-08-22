"""R8 Wave 2 GPM-1 — 생성물 개인 메타 로컬+shadow 원자화 계약."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from app import active_account, config, db, repo
from app.routers import generation
from app.usecases import generation_personal_meta as meta


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    """운영 기본인 스레드별 풀 ON에서 transaction-root 잔류를 드러낸다."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _assert_pool_clean() -> None:
    assert db._active_connection_contexts == 0
    with db.get_connection() as conn:
        assert not conn.in_transaction
    assert db._active_connection_contexts == 0


def _seed_personal_meta(kind: str) -> tuple[str, str]:
    local_id = repo.create_local_generation(
        {"model": "m", "prompt": "gpm-1"}, "me", creator_uid="me"
    )
    shadow_anchor = f"shadow-{kind}"
    if kind == "color":
        repo.set_color(local_id, "old")
        repo.set_color_overlay(shadow_anchor, "old")
    else:
        repo.set_tags(local_id, ["old"])
        repo.set_tags_overlay(shadow_anchor, ["old"])
    return local_id, shadow_anchor


def _mutate_both(kind: str, local_id: str, shadow_anchor: str):
    items: list[tuple[str, Any]] = [
        (local_id, "new" if kind == "color" else ["new"]),
        ("server-other", "new" if kind == "color" else ["new"]),
    ]
    common = {
        "proxying": True,
        "my_uid": "me",
        "can_edit": lambda ref: ref.get("creator_uid") == "me",
        "fetch_server_cards": lambda _ids: {
            "server-other": {
                "id": "server-other",
                "job_id": shadow_anchor,
                "creator_uid": "other",
            }
        },
    }
    if kind == "color":
        return meta.set_colors_batch(items, **common)
    return meta.set_tags_batch(items, auto=False, **common)


def _stored_values(kind: str, local_id: str, shadow_anchor: str):
    with db.get_connection() as conn:
        if kind == "color":
            local = conn.execute(
                "SELECT color FROM generation WHERE id=?", (local_id,)
            ).fetchone()["color"]
            shadow = conn.execute(
                "SELECT color FROM gen_color_overlay WHERE anchor=?",
                (shadow_anchor,),
            ).fetchone()["color"]
            return local, shadow
        local = [
            row["name"]
            for row in conn.execute(
                "SELECT t.name FROM tag t JOIN gen_tag gt ON gt.tag_id=t.id "
                "WHERE gt.generation_id=? ORDER BY t.name",
                (local_id,),
            ).fetchall()
        ]
        shadow = [
            row["tag"]
            for row in conn.execute(
                "SELECT tag FROM gen_tag_overlay WHERE anchor=? ORDER BY tag",
                (shadow_anchor,),
            ).fetchall()
        ]
        return local, shadow


@pytest.mark.parametrize("kind", ["color", "tags"])
def test_local_and_shadow_commit_same_value_in_one_root(pooled_db, kind):
    local_id, shadow_anchor = _seed_personal_meta(kind)

    result = _mutate_both(kind, local_id, shadow_anchor)

    assert result == meta.BatchMutationResult([local_id, "server-other"], [])
    expected = "new" if kind == "color" else ["new"]
    assert _stored_values(kind, local_id, shadow_anchor) == (expected, expected)
    _assert_pool_clean()


@pytest.mark.parametrize("kind", ["color", "tags"])
def test_shadow_failure_rolls_back_local_and_leaves_pool_clean(
    pooled_db, monkeypatch, kind
):
    local_id, shadow_anchor = _seed_personal_meta(kind)
    setter_name = (
        "set_color_overlays_batch" if kind == "color" else "set_tag_overlays_batch"
    )
    original_shadow_writer = getattr(repo, setter_name)

    def fail_after_shadow_write(items):
        original_shadow_writer(items)
        raise RuntimeError("shadow write failed")

    monkeypatch.setattr(repo, setter_name, fail_after_shadow_write)

    with pytest.raises(RuntimeError, match="shadow write failed"):
        _mutate_both(kind, local_id, shadow_anchor)

    expected = "old" if kind == "color" else ["old"]
    assert _stored_values(kind, local_id, shadow_anchor) == (expected, expected)
    _assert_pool_clean()


def test_batch_account_scope_is_pinned_without_holding_transition_lock(
    tmp_path, monkeypatch
):
    """A를 캡처한 뒤 B 전환은 즉시 끝나도 배치 문맥의 DB 키·UID는 A로 고정된다."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    active_account.set_active("a@example.com", "uid-a")
    monkeypatch.setattr(generation, "_my_uid", lambda _request: active_account.active_uid())
    switched = threading.Event()

    def switch_account() -> None:
        active_account.set_active("b@example.com", "uid-b")
        switched.set()

    try:
        with generation._personal_meta_account_scope(object()) as my_uid:
            switcher = threading.Thread(target=switch_account)
            switcher.start()
            assert switched.wait(0.5), "배치 처리 중 transition_lock을 보유했습니다"
            switcher.join(timeout=1)
            assert not switcher.is_alive()
            assert my_uid == "uid-a"
            assert active_account.account_key() == "a@example.com"
        assert active_account.account_key() == "b@example.com"
    finally:
        active_account.reset_override(outer_token)
