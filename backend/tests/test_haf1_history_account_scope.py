"""HAF-1 — detached history import의 계정 DB 범위 고정 계약."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import active_account, config, db, repo
from app.services import higgsfield_history
from app.services import history_autofill as autofill


A_EMAIL = "history-a@example.com"
B_EMAIL = "history-b@example.com"
A_UID = "history-a-uid"
B_UID = "history-b-uid"


@pytest.fixture
def history_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 history 환경."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(autofill, "AUTH_ENABLED", False)
    monkeypatch.setattr(autofill, "LOCAL_AGENT_PAIR_SECRET", "")
    monkeypatch.setattr(autofill, "EXTERNAL_RECOVERY_ENABLED", True)
    monkeypatch.setattr(autofill, "MANAGE_ENABLED", False)
    autofill._HISTORY_STATES.clear()
    autofill._HISTORY_TASKS.clear()

    for email, uid in ((A_EMAIL, A_UID), (B_EMAIL, B_UID)):
        active_account.set_active(email, uid)
        db.flush_pool()
        db.init_db()
        repo.set_setting("my_creator_uid", uid)

    active_account.set_active(A_EMAIL, A_UID)
    db.flush_pool()
    try:
        yield
    finally:
        autofill._HISTORY_STATES.clear()
        autofill._HISTORY_TASKS.clear()
        db.flush_pool()
        active_account.reset_override(outer_token)


def _for_account(email: str, action):
    token = active_account.set_override(email)
    try:
        return action()
    finally:
        active_account.reset_override(token)


def test_history_import_switch_does_not_hold_lock_or_contaminate_b(
    history_accounts, monkeypatch
) -> None:
    """두 페이지 사이 A→B 전환은 즉시 끝나며 나머지 적재와 완료 audit도 A에 남는다."""
    second_page_waiting = asyncio.Event()
    release_second_page = asyncio.Event()
    cursors: list[object] = []
    ingest_scopes: list[str | None] = []

    async def fetch_page(_token, cursor, *, size):
        assert size == 100
        cursors.append(cursor)
        if cursor is None:
            return higgsfield_history.HistoryPage([{"id": "one"}], "next")
        second_page_waiting.set()
        await release_second_page.wait()
        return higgsfield_history.HistoryPage([{"id": "two"}], None)

    def ingest_runner(_acc, jobs, _list_fetched, _account_status):
        scope = active_account.account_key()
        ingest_scopes.append(scope)
        repo.set_setting(f"haf1_page_{jobs[0]['id']}", scope or "legacy")
        return SimpleNamespace(
            inserted=1,
            updated=0,
            unchanged=0,
            skipped=0,
            errors=0,
        )

    status = AsyncMock(
        return_value={"connected": True, "email": A_EMAIL, "creator_uid": A_UID}
    )
    auth_token = AsyncMock(return_value="a-token")
    monkeypatch.setattr(autofill.cli_bridge, "get_account_status", status)
    monkeypatch.setattr(autofill.cli_bridge, "get_auth_token", auth_token)
    monkeypatch.setattr(autofill.higgsfield_history, "fetch_page", fetch_page)
    monkeypatch.setattr(autofill, "mcp_item_to_cli", lambda item: item)
    monkeypatch.setattr(autofill, "_INGEST_RUNNER", ingest_runner)

    async def scenario() -> None:
        assert autofill._start_history_task(
            A_EMAIL, {"email": "local", "creator_uid": A_UID}, automatic=False
        )
        task = autofill._HISTORY_TASKS[A_EMAIL]
        await second_page_waiting.wait()

        switched = threading.Event()

        def switch_account() -> None:
            active_account.set_active(B_EMAIL, B_UID)
            switched.set()

        switcher = threading.Thread(target=switch_account)
        switcher.start()
        assert switched.wait(0.5), "페이지 대기 중 transition_lock을 보유했습니다"
        switcher.join(timeout=1)
        assert not switcher.is_alive()

        release_second_page.set()
        await task
        assert active_account.account_key() == B_EMAIL

    asyncio.run(scenario())

    assert cursors == [None, "next"]
    assert status.await_count == 1
    assert auth_token.await_count == 1
    assert ingest_scopes == [A_EMAIL, A_EMAIL]
    assert _for_account(A_EMAIL, lambda: repo.get_setting("haf1_page_one")) == A_EMAIL
    assert _for_account(A_EMAIL, lambda: repo.get_setting("haf1_page_two")) == A_EMAIL
    assert _for_account(B_EMAIL, lambda: repo.get_setting("haf1_page_one")) is None
    assert _for_account(B_EMAIL, lambda: repo.get_setting("haf1_page_two")) is None
    assert _for_account(
        A_EMAIL, lambda: repo.get_history_import_audit(A_EMAIL)["last_success_at"]
    )
    assert (
        _for_account(
            B_EMAIL, lambda: repo.get_history_import_audit(A_EMAIL)["last_success_at"]
        )
        is None
    )


def test_auto_start_claim_and_account_lookup_stay_on_captured_a(
    history_accounts, monkeypatch
) -> None:
    """claim 중 포인터가 B로 바뀌어도 claim·계정 조회·task 인자는 모두 A 범위다."""
    real_claim = repo.claim_history_auto_start
    observed: dict[str, object] = {}

    def claim(*args, **kwargs):
        observed["claim_before"] = active_account.account_key()
        claimed = real_claim(*args, **kwargs)
        active_account.set_active(B_EMAIL, B_UID)
        observed["claim_after"] = active_account.account_key()
        return claimed

    def start_task(key, acc, *, automatic):
        observed.update(
            key=key,
            acc=dict(acc),
            automatic=automatic,
            start_scope=active_account.account_key(),
        )
        return True

    monkeypatch.setattr(autofill.repo, "claim_history_auto_start", claim)
    monkeypatch.setattr(autofill, "_start_history_task", start_task)

    assert asyncio.run(autofill.auto_start_history_import(A_EMAIL, reason="gap"))

    assert observed == {
        "claim_before": A_EMAIL,
        "claim_after": A_EMAIL,
        "key": A_EMAIL,
        "acc": {"email": "local", "creator_uid": A_UID},
        "automatic": True,
        "start_scope": A_EMAIL,
    }
    assert active_account.account_key() == B_EMAIL
    assert _for_account(
        A_EMAIL, lambda: repo.get_history_import_audit(A_EMAIL)["last_auto_started_at"]
    )
    assert (
        _for_account(
            B_EMAIL,
            lambda: repo.get_history_import_audit(A_EMAIL)["last_auto_started_at"],
        )
        is None
    )


def test_startup_audit_keeps_initial_scope_when_cli_wait_switches_to_b(
    history_accounts, monkeypatch
) -> None:
    """startup CLI 조회 중 전환돼도 audit 판정과 후속 자동 시작은 처음의 A 범위다."""
    _for_account(A_EMAIL, lambda: repo.mark_history_gap(A_EMAIL))
    _for_account(B_EMAIL, lambda: repo.complete_history_import(A_EMAIL))
    active_account.set_active(A_EMAIL, A_UID)
    observed_scopes: list[str | None] = []

    async def account_status(*_args, **_kwargs):
        active_account.set_active(B_EMAIL, B_UID)
        return {"connected": True, "email": A_EMAIL}

    async def auto_start(email, *, reason):
        assert email == A_EMAIL
        assert reason == "startup"
        observed_scopes.append(active_account.account_key())
        return True

    monkeypatch.setattr(autofill.cli_bridge, "get_account_status", account_status)
    start = AsyncMock(side_effect=auto_start)
    monkeypatch.setattr(autofill, "auto_start_history_import", start)

    assert asyncio.run(autofill.startup_history_audit())

    start.assert_awaited_once_with(A_EMAIL, reason="startup")
    assert observed_scopes == [A_EMAIL]
    assert active_account.account_key() == B_EMAIL


def test_history_override_resets_after_exception(history_accounts, monkeypatch) -> None:
    """잡힌 history 예외로 runner가 끝나도 task의 DB override를 finally에서 되돌린다."""
    active_account.set_active(B_EMAIL, B_UID)
    autofill._HISTORY_STATES[A_EMAIL] = {
        **autofill._history_idle(),
        "state": "running",
    }
    monkeypatch.setattr(
        autofill.cli_bridge,
        "get_account_status",
        AsyncMock(return_value={"connected": True, "email": A_EMAIL}),
    )
    monkeypatch.setattr(
        autofill.cli_bridge, "get_auth_token", AsyncMock(return_value="a-token")
    )
    monkeypatch.setattr(
        autofill.higgsfield_history,
        "fetch_page",
        AsyncMock(side_effect=higgsfield_history.HistoryFetchError("history failed")),
    )
    monkeypatch.setattr(autofill, "_INGEST_RUNNER", lambda *_args: None)
    real_reset = active_account.reset_override
    reset_to: list[str | None] = []

    def reset_override(token) -> None:
        scoped_import = active_account.account_key() == A_EMAIL
        real_reset(token)
        if scoped_import:
            reset_to.append(active_account.account_key())

    monkeypatch.setattr(active_account, "reset_override", reset_override)

    asyncio.run(
        autofill._run_history_import(
            A_EMAIL, {"email": "local"}, account_scope=A_EMAIL
        )
    )

    assert autofill._HISTORY_STATES[A_EMAIL]["state"] == "failed"
    assert reset_to == [B_EMAIL]
    assert active_account.account_key() == B_EMAIL


def test_history_override_resets_after_cancellation(
    history_accounts, monkeypatch
) -> None:
    """취소가 전파되는 경로도 task의 DB override를 finally에서 되돌린다."""
    active_account.set_active(B_EMAIL, B_UID)
    autofill._HISTORY_STATES[A_EMAIL] = {
        **autofill._history_idle(),
        "state": "running",
    }
    fetch_started = asyncio.Event()

    async def blocked_fetch(*_args, **_kwargs):
        assert active_account.account_key() == A_EMAIL
        fetch_started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(
        autofill.cli_bridge,
        "get_account_status",
        AsyncMock(return_value={"connected": True, "email": A_EMAIL}),
    )
    monkeypatch.setattr(
        autofill.cli_bridge, "get_auth_token", AsyncMock(return_value="a-token")
    )
    monkeypatch.setattr(autofill.higgsfield_history, "fetch_page", blocked_fetch)
    monkeypatch.setattr(autofill, "_INGEST_RUNNER", lambda *_args: None)
    real_reset = active_account.reset_override
    reset_to: list[str | None] = []

    def reset_override(token) -> None:
        scoped_import = active_account.account_key() == A_EMAIL
        real_reset(token)
        if scoped_import:
            reset_to.append(active_account.account_key())

    monkeypatch.setattr(active_account, "reset_override", reset_override)

    async def scenario() -> None:
        task = asyncio.create_task(
            autofill._run_history_import(
                A_EMAIL, {"email": "local"}, account_scope=A_EMAIL
            )
        )
        await fetch_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())

    assert autofill._HISTORY_STATES[A_EMAIL]["state"] == "failed"
    assert reset_to == [B_EMAIL]
    assert active_account.account_key() == B_EMAIL
