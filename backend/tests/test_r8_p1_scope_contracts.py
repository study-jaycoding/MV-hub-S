"""R8 적대 리뷰 P1 — 하우스 정리와 텔레메트리 계정 범위 고정 계약."""

from __future__ import annotations

import asyncio
import threading
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from app import active_account, config, db, repo
from app.repo import manage as repo_manage
from app.repo import trash
from app.routers import _telemetry
from app.services import syncer, telemetry_drain


HOUSE_EMAIL = "house@example.com"
HOUSE_UID = "user_house"
MEMBER_UID = "user_member"
A_EMAIL = "telemetry-a@example.com"
B_EMAIL = "telemetry-b@example.com"
A_UID = "user_telemetry_a"
B_UID = "user_telemetry_b"


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    try:
        yield
    finally:
        db.flush_pool()


def _seed_stuck_synced(gen_id: str, job_id: str, creator_uid: str | None) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO generation("
            "id, worker_id, prompt, model, status, created_at, sort_ts, job_id, origin, creator_uid"
            ") VALUES(?, 'me', 'prompt', 'model', 'running', "
            "'1970-01-01 00:01:40', 100, ?, 'synced', ?)",
            (gen_id, job_id, creator_uid),
        )


def test_stuck_synced_candidates_include_only_exact_house_uid(isolated_db):
    """공유 서버 후보는 하우스 uid와 정확히 같은 행만 포함하고 NULL도 제외한다."""
    _seed_stuck_synced("house-gen", "house-job", HOUSE_UID)
    _seed_stuck_synced("member-gen", "member-job", MEMBER_UID)
    _seed_stuck_synced("null-gen", "null-job", None)

    assert repo.list_stuck_synced_active(0, HOUSE_UID) == [
        ("house-gen", "house-job")
    ]


def test_stuck_synced_guard_rechecks_house_uid_before_move(isolated_db):
    """원격 확인 중 소유자가 바뀌면 BEGIN IMMEDIATE 재검증에서 이동을 거부한다."""
    _seed_stuck_synced("changed-gen", "changed-job", HOUSE_UID)
    assert repo.list_stuck_synced_active(0, HOUSE_UID) == [
        ("changed-gen", "changed-job")
    ]
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET creator_uid=? WHERE id='changed-gen'",
            (MEMBER_UID,),
        )

    assert trash.move_to_trash_if_stuck_synced(
        "changed-gen", "changed-job", time.time(), HOUSE_UID
    ) is False
    with db.get_connection() as conn:
        assert conn.execute(
            "SELECT creator_uid FROM generation WHERE id='changed-gen'"
        ).fetchone()["creator_uid"] == MEMBER_UID


def test_stuck_synced_cleanup_skips_when_house_uid_is_unresolved(monkeypatch):
    """AUTH on에서 하우스 계정의 creator_uid가 없으면 CLI 조회 전 fail-closed한다."""
    candidates = MagicMock()
    job_exists = AsyncMock()
    monkeypatch.setattr(syncer, "AUTH_ENABLED", True)
    monkeypatch.setattr(
        syncer, "_house_account_email", AsyncMock(return_value=HOUSE_EMAIL)
    )
    monkeypatch.setattr(syncer.repo, "get_account", lambda _email: {"creator_uid": None})
    monkeypatch.setattr(syncer.repo, "list_stuck_synced_active", candidates)
    monkeypatch.setattr(syncer.cli_bridge, "job_exists", job_exists)

    assert asyncio.run(syncer.reconcile_stuck_synced()) == 0
    candidates.assert_not_called()
    job_exists.assert_not_awaited()


@pytest.fixture
def account_scope(tmp_path, monkeypatch):
    """실제 사용자 포인터와 DB를 건드리지 않는 A/B 로컬 계정 환경."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    db.flush_pool()
    active_account.set_active(A_EMAIL, A_UID)
    try:
        yield
    finally:
        db.flush_pool()
        active_account.reset_override(outer_token)


def _seed_account_scope(
    email: str,
    uid: str,
    *,
    local_gen_id: str,
    with_account_report: bool = False,
) -> None:
    active_account.set_active(email, uid)
    db.flush_pool()
    db.init_db()
    repo.set_setting("my_creator_uid", uid)
    repo.set_setting("provider_email", email)
    repo_manage.mark_telemetry_tombstone(
        local_gen_id,
        {"job_id": f"job-{local_gen_id}", "creator_uid": uid, "status": "done"},
    )
    if with_account_report:
        repo_manage.queue_account_reports(
            {"email": email, "credits": 100, "plan": "team"}, []
        )


def _pending_telemetry(email: str) -> int:
    token = active_account.set_override(email)
    try:
        return int(repo_manage.telemetry_outbox_status()["pending"])
    finally:
        active_account.reset_override(token)


def _pending_account_reports(email: str) -> int:
    token = active_account.set_override(email)
    try:
        return int(repo_manage.account_report_outbox_status()["account_report_pending"])
    finally:
        active_account.reset_override(token)


def _switch_pointer_without_waiting_for_network(email: str, uid: str) -> None:
    """★판정은 '전환이 0.5초 안에 끝났는가'(벽시계 대리 측정 — 부하가 걸리면 간헐 오탐)가
    아니라 '전환 락을 잡을 수 있는가'로 한다. 락은 새 스레드에서 잡는다 — RLock 이라
    드레인을 돌리는 이 스레드에서 acquire 하면 보유 중에도 재진입 성공해 계약이 죽는다."""
    acquired: list[bool] = []

    def switch() -> None:
        got = active_account.transition_lock.acquire(timeout=0.5)
        acquired.append(got)
        if not got:
            return
        try:
            active_account.set_active(email, uid)  # RLock 재진입 OK
        finally:
            active_account.transition_lock.release()

    worker = threading.Thread(target=switch)
    worker.start()
    worker.join(timeout=5)
    assert not worker.is_alive()
    assert acquired == [True], "네트워크 중 transition_lock을 보유했습니다"


def test_drain_once_keeps_account_key_and_uid_paired_across_switch(
    account_scope, monkeypatch
):
    """uid 읽기 직후 A→B 전환돼도 B 팩트를 foreign/non_sent로 소거하지 않는다."""
    _seed_account_scope(A_EMAIL, A_UID, local_gen_id="fact-a")
    _seed_account_scope(B_EMAIL, B_UID, local_gen_id="fact-b")
    active_account.set_active(A_EMAIL, A_UID)
    captured: list[dict] = []
    real_remote_drain = telemetry_drain.drain_remote_telemetry

    def switch_then_drain(push, *, my_uid):
        assert my_uid == A_UID
        _switch_pointer_without_waiting_for_network(B_EMAIL, B_UID)
        return real_remote_drain(push, my_uid=my_uid)

    def proxy_json(_method, path, *, body):
        assert path == "/api/manage/telemetry/push"
        captured.extend(body["items"])
        return {"upserted": len(body["items"]), "skipped": []}

    monkeypatch.setattr(_telemetry, "MANAGE_ENABLED", True)
    monkeypatch.setattr(_telemetry._proxy, "proxying", lambda: True)
    monkeypatch.setattr(_telemetry._proxy, "proxy_json", proxy_json)
    monkeypatch.setattr(_telemetry, "drain_remote_telemetry", switch_then_drain)
    monkeypatch.setattr(
        _telemetry,
        "drain_remote_account_reports",
        lambda _push, *, creator_uid: {"creator_uid": creator_uid},
    )

    _telemetry._drain_once()

    assert [item["creator_uid"] for item in captured] == [A_UID]
    assert _pending_telemetry(A_EMAIL) == 0
    assert _pending_telemetry(B_EMAIL) == 1
    assert active_account.account_key() == B_EMAIL


def test_drain_once_pins_account_report_to_telemetry_scope_during_switch(
    account_scope, monkeypatch
):
    """telemetry 네트워크 중 전환돼도 후속 account-report는 A DB와 A uid를 쓴다."""
    _seed_account_scope(
        A_EMAIL, A_UID, local_gen_id="fact-a", with_account_report=True
    )
    _seed_account_scope(
        B_EMAIL, B_UID, local_gen_id="fact-b", with_account_report=True
    )
    active_account.set_active(A_EMAIL, A_UID)
    telemetry_scopes: list[str | None] = []
    report_scopes: list[str | None] = []
    report_payloads: list[dict] = []

    def proxy_json(_method, path, *, body):
        if path == "/api/manage/telemetry/push":
            telemetry_scopes.append(active_account.account_key())
            _switch_pointer_without_waiting_for_network(B_EMAIL, B_UID)
            return {"upserted": len(body["items"]), "skipped": []}
        assert path == "/api/ingest/account-report"
        report_scopes.append(active_account.account_key())
        report_payloads.append(body)
        return {"accepted": True}

    monkeypatch.setattr(_telemetry, "MANAGE_ENABLED", True)
    monkeypatch.setattr(_telemetry._proxy, "proxying", lambda: True)
    monkeypatch.setattr(_telemetry._proxy, "proxy_json", proxy_json)

    _telemetry._drain_once()

    assert telemetry_scopes == [A_EMAIL]
    assert report_scopes == [A_EMAIL]
    assert len(report_payloads) == 1
    assert report_payloads[0]["creator_uid"] == A_UID
    assert report_payloads[0]["account_status"]["email"] == A_EMAIL
    assert _pending_account_reports(A_EMAIL) == 0
    assert _pending_account_reports(B_EMAIL) == 1
    assert _pending_telemetry(B_EMAIL) == 1
    assert active_account.account_key() == B_EMAIL
