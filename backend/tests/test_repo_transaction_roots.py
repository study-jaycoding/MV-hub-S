"""R6 — transaction-root 계약(신규 BEGIN IMMEDIATE 함수) + 인덱스 마이그레이션.

★풀 ON(운영 기본)으로 검증한다 — conftest 전역은 풀 OFF 라, 같은 스레드가 커넥션을
재사용할 때의 트랜잭션 중첩·잔류(in_transaction 으로 남아 다음 호출을 깨는 것)가
평소 테스트에서 가려진다(코덱스 설계 검토 적발). 이 파일이 그 사각을 고정한다.
"""
from __future__ import annotations

import pytest

from app import db, repo


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)  # 운영 기본(풀 ON) 재현
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()  # 같은 스레드 풀 커넥션 회수(Windows 파일 잠금 방지)


def _assert_pool_connection_clean() -> None:
    """직전 호출이 풀 커넥션을 열린 트랜잭션 상태로 남기지 않았는지 확인."""
    with db.get_connection() as conn:
        assert not conn.in_transaction


def test_comment_lock_mutations_are_transaction_root_safe_with_pool(pooled_db):
    """assets-1 — 같은 풀 커넥션으로 연속 호출해도 중첩 오류·잔류 트랜잭션이 없다."""
    cid = repo.add_asset_comment("proj", "a.png", "me", "첫 코멘트")
    _assert_pool_connection_clean()
    repo.edit_asset_comment(cid, "me", "수정")
    _assert_pool_connection_clean()
    # 타인 답글 → 잠금(예외 경로가 ROLLBACK 으로 끝나 커넥션이 깨끗해야 다음 호출이 산다)
    repo.add_asset_comment("proj", "a.png", "other", "답글", parent_id=cid)
    with pytest.raises(PermissionError):
        repo.edit_asset_comment(cid, "me", "잠긴 뒤 수정")
    _assert_pool_connection_clean()
    with pytest.raises(PermissionError):
        repo.delete_asset_comment(cid, "me")
    _assert_pool_connection_clean()
    # 정상 삭제 경로(잠기지 않은 별도 코멘트)
    cid2 = repo.add_asset_comment("proj", "b.png", "me", "둘째")
    repo.delete_asset_comment(cid2, "me")
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        remaining = conn.execute(
            "SELECT COUNT(*) FROM asset_comment WHERE id=?", (cid2,)
        ).fetchone()[0]
    assert remaining == 0  # COMMIT 실제 반영


def test_project_mutations_are_transaction_root_safe_with_pool(pooled_db):
    """projects-1 — workspace 변경·reorder·삭제 연속 호출(풀 커넥션 재사용) 무결."""
    project = repo.create_project("루트계약")
    _assert_pool_connection_clean()
    gen_id = repo.create_local_generation({"model": "m", "prompt": "p"}, "me")
    repo.assign_to_project([gen_id], project["id"])
    assert repo.set_project_workspace(
        project["id"], {"scope": "team", "id": "ws-1", "name": "팀"}
    )
    _assert_pool_connection_clean()
    repo.reorder_projects([project["id"]])
    _assert_pool_connection_clean()
    assert repo.delete_project(project["id"])
    _assert_pool_connection_clean()
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM project WHERE id=?", (project["id"],)
        ).fetchone()[0] == 0
        # 귀속 생성물은 삭제가 아니라 미분류(1-J 계약)
        row = conn.execute(
            "SELECT project_id FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
    assert row is not None and row["project_id"] is None


def test_relink_asset_path_transaction_root_safe_with_pool(pooled_db):
    """assets-2 — SELECT 포함 임계구역이 풀 커넥션을 깨끗하게 반납한다."""
    repo.set_asset_source("proj", "old.png", "소스명", True, owner_uid="me")
    _assert_pool_connection_clean()
    repo.relink_asset_path("proj", "old.png", "new.png", owner_uid="me")
    _assert_pool_connection_clean()
    meta = repo.get_asset_meta("proj", viewer_uid="me")
    assert meta["new.png"]["is_source"] in (True, 1)
    assert "old.png" not in meta  # 옛 행이 병합·이관됨(COMMIT 반영)


def test_new_indexes_exist_on_fresh_and_migrated_db(pooled_db):
    """1-G/1-K/1-L — 신규 DB(schema)와 기존 DB(_migrate 재실행) 양쪽에서 인덱스 보장."""
    expected = {
        "idx_account_creator_uid",
        "idx_scene_card_gen_owner_generation_active",
        "idx_ssi_claim_token",
    }

    def index_names() -> set[str]:
        with db.get_connection() as conn:
            return {
                r["name"]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                ).fetchall()
            }

    assert expected <= index_names()  # 신규 DB(schema.sql 경로)
    with db.get_connection() as conn:
        for name in expected:
            conn.execute(f"DROP INDEX {name}")  # 레거시 DB(인덱스 없던 시절) 재현
    assert not (expected & index_names())
    db.init_db()  # 재부팅 마이그레이션 경로 — _migrate 가 재생성해야 한다
    assert expected <= index_names()
    # 실측 근거 고정: creator_uid 해석이 SCAN 이 아니라 인덱스 탐색이어야 한다
    with db.get_connection() as conn:
        plan = " ".join(
            r["detail"]
            for r in conn.execute(
                "EXPLAIN QUERY PLAN SELECT email FROM account WHERE creator_uid IN (?,?)",
                ("u1", "u2"),
            ).fetchall()
        )
    assert "idx_account_creator_uid" in plan
