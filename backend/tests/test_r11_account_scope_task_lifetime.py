"""R11 배치3 — 계정 범위·전환 락·태스크 수명 계약(A6·A7·A8·C2).

세 가지를 한 묶음으로 지킨다.
  · 응답 뒤/주기 작업이 **어느 계정 DB** 에 쓰는지는 시작 시점에 캡처한 키로 고정된다.
  · transition_lock 획득과 동기 SQLite 는 **이벤트 루프 스레드에서 돌지 않는다**
    (로그인 마이그레이션·DB 복원이 이 락을 초 단위로 쥐고 있어 서버 전체가 멈춘다).
  · 종료가 시작되면 자동 시작 예약(starter)은 취소되고 새로 생기지도 않는다.
"""

from __future__ import annotations

import ast
import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import active_account, config, db, repo
from app.routers import ingest, share
from app.services import history_autofill as autofill
from app.services import syncer


A_EMAIL = "r11-a@example.com"
B_EMAIL = "r11-b@example.com"
A_UID = "r11-a-uid"
B_UID = "r11-b-uid"


@pytest.fixture(autouse=True)
def _enable_legacy_preservation_contract(monkeypatch):
    """이 파일은 명시적 opt-in 보존 기능의 계정 격리 계약을 검증한다."""
    monkeypatch.setattr(share, "MEDIA_PRESERVATION_ENABLED", True)


@pytest.fixture
def two_accounts(tmp_path, monkeypatch):
    """실제 사용자 포인터·DB를 건드리지 않는 A/B 계정별 환경(HAF-1 fixture 형태)."""
    outer_token = active_account.set_override(None)
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
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


@pytest.fixture
def history_registries(monkeypatch):
    """history task/starter 등록부와 종료 플래그를 테스트마다 격리한다."""
    monkeypatch.setattr(autofill, "_HISTORY_TASKS", {})
    monkeypatch.setattr(autofill, "_HISTORY_STARTERS", set())
    monkeypatch.setattr(autofill, "_HISTORY_STOPPING", False)
    monkeypatch.setattr(autofill, "AUTH_ENABLED", False)
    monkeypatch.setattr(autofill, "LOCAL_AGENT_PAIR_SECRET", "")
    yield


def _for_account(email: str, action):
    token = active_account.set_override(email)
    try:
        return action()
    finally:
        active_account.reset_override(token)


class _RecordingLock:
    """transition_lock 을 어느 스레드에서 잡았는지 기록하는 얇은 래퍼."""

    def __init__(self, inner, threads: list[int]) -> None:
        self._inner = inner
        self._threads = threads

    def __enter__(self):
        self._threads.append(threading.get_ident())
        return self._inner.__enter__()

    def __exit__(self, *exc_info):
        return self._inner.__exit__(*exc_info)


# ── A6 · finalize 백그라운드 보존 ────────────────────────────────────────────
def test_a6_preserve_task_never_runs_sync_db_on_the_event_loop(monkeypatch) -> None:
    """등록된 보존 태스크의 두 동기 DB 호출은 워커 스레드에서만 돈다."""
    db_threads: list[int] = []

    def get_generation(gen_id: str):
        db_threads.append(threading.get_ident())
        return {"id": gen_id, "is_final": 1}

    def request_media_preservation(gen_id: str, reason: str):
        db_threads.append(threading.get_ident())
        return True

    monkeypatch.setattr(share.repo, "get_generation", get_generation)
    monkeypatch.setattr(
        share.repo, "request_media_preservation", request_media_preservation
    )
    monkeypatch.setattr(share, "preserve_generation_now", AsyncMock(return_value=None))

    loop_threads: list[int] = []

    async def scenario() -> None:
        loop_threads.append(threading.get_ident())
        await share._preserve_final_media("gen-1", "")

    asyncio.run(scenario())

    assert len(db_threads) == 2, "두 repo 호출이 모두 실행돼야 한다"
    assert loop_threads[0] not in db_threads


def test_a6_preserve_task_registers_in_captured_account_after_switch(
    two_accounts, monkeypatch
) -> None:
    """응답 뒤 A→B 전환이 껴도 골드 원본 보존 등록은 캡처한 A DB 에 남는다."""
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "gold"}, "me", generation_id="r11-final-1"
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    repo.set_final(gen_id, True, A_UID)

    captured = share._capture_account_scope()  # finalize 라우트(동기 def)가 하는 캡처
    assert captured == A_EMAIL
    monkeypatch.setattr(share, "preserve_generation_now", AsyncMock(return_value=None))

    active_account.set_active(B_EMAIL, B_UID)  # 응답 직후 계정 전환
    db.flush_pool()

    asyncio.run(share._preserve_final_media(gen_id, captured))

    assert active_account.account_key() == B_EMAIL, "override 는 태스크 안에서만 유효"
    a_state = _for_account(A_EMAIL, lambda: repo.get_media_preservation(gen_id))
    assert a_state and a_state["reason"] == "final"
    assert _for_account(B_EMAIL, lambda: repo.get_media_preservation(gen_id)) is None


def test_a6_preserve_task_without_capture_would_miss_the_gold_original(
    two_accounts, monkeypatch
) -> None:
    """캡처 없이 전환 후 실행하면(=수정 전 동작) 보존 등록이 조용히 유실된다 — 회귀 감시용."""
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "gold"}, "me", generation_id="r11-final-2"
    )
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done' WHERE id=?", (gen_id,))
    repo.set_final(gen_id, True, A_UID)
    monkeypatch.setattr(share, "preserve_generation_now", AsyncMock(return_value=None))

    active_account.set_active(B_EMAIL, B_UID)
    db.flush_pool()
    asyncio.run(share._preserve_final_media(gen_id, B_EMAIL))

    assert _for_account(A_EMAIL, lambda: repo.get_media_preservation(gen_id)) is None
    assert _for_account(B_EMAIL, lambda: repo.get_media_preservation(gen_id)) is None


def test_a6_finalize_routes_pass_the_captured_scope_to_the_task() -> None:
    """두 등록 지점 모두 캡처한 계정 키를 인자로 넘긴다(인자 누락 회귀 차단)."""
    tree = ast.parse(Path(share.__file__).read_text("utf-8"))
    registrations = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_task"
        and node.args
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == "_preserve_final_media"
    ]
    assert len(registrations) == 2
    for node in registrations:
        assert len(node.args) == 3, "local_id 와 계정 범위를 함께 넘겨야 한다"
        scope_arg = node.args[2]
        assert isinstance(scope_arg, ast.Call)
        assert isinstance(scope_arg.func, ast.Name)
        assert scope_arg.func.id == "_capture_account_scope"


# ── A7 · history 라우트가 루프에서 전환 락을 잡지 않는다 ─────────────────────
def test_a7_history_start_route_keeps_lock_and_db_off_the_loop(
    two_accounts, history_registries, monkeypatch
) -> None:
    """start 라우트 처리 중 transition_lock·감사 조회 어느 것도 루프 스레드에서 돌지 않는다."""
    lock_threads: list[int] = []
    snapshot_threads: list[int] = []
    captured: list[str | None] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, lock_threads),
    )

    def start_task(key, acc, *, automatic, account_scope=None):
        captured.append(account_scope)
        return True

    def snapshot(key):
        snapshot_threads.append(threading.get_ident())
        return {"state": "running", "key": key}

    monkeypatch.setattr(autofill, "_start_history_task", start_task)
    monkeypatch.setattr(autofill, "_history_snapshot", snapshot)

    request = SimpleNamespace(
        state=SimpleNamespace(account={"email": A_EMAIL, "creator_uid": A_UID})
    )
    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await ingest.start_history_import(request)

    out = asyncio.run(scenario())

    assert out["state"] == "running"
    assert captured == [A_EMAIL], "캡처한 계정 키가 태스크 인자로 전달돼야 한다"
    assert lock_threads, "전환 락 캡처 자체는 그대로 일어나야 한다"
    assert loop_threads[0] not in lock_threads
    assert loop_threads[0] not in snapshot_threads


def test_a7_history_status_route_keeps_db_off_the_loop(
    two_accounts, history_registries, monkeypatch
) -> None:
    """status 폴링의 동기 SQLite 조회도 워커 스레드에서 돈다."""
    snapshot_threads: list[int] = []

    def snapshot(key):
        snapshot_threads.append(threading.get_ident())
        return {"state": "idle", "key": key}

    monkeypatch.setattr(autofill, "_history_snapshot", snapshot)
    request = SimpleNamespace(
        state=SimpleNamespace(account={"email": A_EMAIL, "creator_uid": A_UID})
    )
    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await ingest.history_import_status(request)

    out = asyncio.run(scenario())

    assert out["state"] == "idle"
    assert snapshot_threads and loop_threads[0] not in snapshot_threads


def test_a7_locked_transition_does_not_freeze_the_event_loop(
    two_accounts, history_registries, monkeypatch
) -> None:
    """전환 락이 잡혀 있는 동안에도 루프는 계속 돈다(폴링 한 번이 서버를 세우지 않는다)."""
    monkeypatch.setattr(autofill, "_start_history_task", lambda *a, **k: True)
    monkeypatch.setattr(autofill, "_history_snapshot", lambda key: {"state": "running"})
    request = SimpleNamespace(
        state=SimpleNamespace(account={"email": A_EMAIL, "creator_uid": A_UID})
    )

    async def scenario():
        release = threading.Event()
        holding = threading.Event()

        def hold_lock():
            with active_account.transition_lock:
                holding.set()
                release.wait(5.0)

        holder = threading.Thread(target=hold_lock)
        holder.start()
        assert holding.wait(2.0)

        route = asyncio.create_task(ingest.start_history_import(request))
        ticks = 0
        for _ in range(20):
            await asyncio.sleep(0.01)
            ticks += 1
        assert ticks == 20, "루프가 락 대기에 묶이면 여기까지 못 온다"
        assert not route.done(), "라우트는 락이 풀릴 때까지 워커 스레드에서 기다린다"

        release.set()
        holder.join(timeout=2)
        assert not holder.is_alive()
        assert (await asyncio.wait_for(route, 2.0))["state"] == "running"

    asyncio.run(scenario())


# ── A8 · history 자동시작 starter 수명 ──────────────────────────────────────
def test_a8_stop_cancels_starters_before_import_tasks(
    history_registries, monkeypatch
) -> None:
    """starter 를 먼저 취소·gather 한 뒤에야 import task 를 정리한다."""
    order: list[str] = []

    async def blocked(name: str) -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            order.append(name)
            raise

    async def scenario():
        starter = asyncio.create_task(blocked("starter"))
        importer = asyncio.create_task(blocked("import"))
        autofill._HISTORY_STARTERS.add(starter)
        autofill._HISTORY_TASKS["k"] = importer
        await asyncio.sleep(0)
        await autofill.stop_history_imports()
        assert starter.cancelled() and importer.cancelled()

    asyncio.run(scenario())

    assert order == ["starter", "import"]


def test_a8_scheduled_starter_is_registered_and_cancellable(
    history_registries, monkeypatch
) -> None:
    """gap 예약이 만든 starter 는 등록부에 들어가 종료가 취소할 수 있다."""
    entered = asyncio.Event()

    async def blocking_auto_start(email, *, reason):
        assert reason == "gap"
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(autofill, "auto_start_history_import", blocking_auto_start)

    async def scenario():
        autofill.bind_history_loop(asyncio.get_running_loop())
        try:
            autofill.schedule_history_auto_start(A_EMAIL)
            await asyncio.wait_for(entered.wait(), 2.0)
            assert len(autofill._HISTORY_STARTERS) == 1
            await autofill.stop_history_imports()
            assert not [t for t in autofill._HISTORY_STARTERS if not t.done()]
        finally:
            autofill.unbind_history_loop(asyncio.get_running_loop())

    asyncio.run(scenario())


def test_a8_late_spawn_after_stop_never_starts(history_registries, monkeypatch) -> None:
    """stop 이 끝난 뒤 실행되는 늦은 예약은 새 작업을 만들지 않는다(teardown 후 DB 쓰기 차단)."""
    started: list[str] = []

    async def auto_start(email, *, reason):
        started.append(email)
        return True

    monkeypatch.setattr(autofill, "auto_start_history_import", auto_start)

    async def scenario():
        loop = asyncio.get_running_loop()
        autofill.bind_history_loop(loop)
        try:
            # 동기 ingest 워커가 stop 직전에 예약해 둔 spawn 을 재현한다.
            spawned: list[None] = []

            def late_schedule():
                autofill.schedule_history_auto_start("late@example.com")
                spawned.append(None)

            await autofill.stop_history_imports()
            loop.call_soon(late_schedule)
            for _ in range(5):
                await asyncio.sleep(0)
            assert spawned, "예약 콜백 자체는 실행됐다"
            assert started == []
            assert not autofill._HISTORY_STARTERS
        finally:
            autofill.unbind_history_loop(loop)

    asyncio.run(scenario())


def test_a8_bind_loop_clears_the_stopping_flag(history_registries) -> None:
    """다음 부팅은 지난 종료의 차단 플래그를 물려받지 않는다."""

    async def scenario():
        loop = asyncio.get_running_loop()
        await autofill.stop_history_imports()
        assert autofill._HISTORY_STOPPING is True
        autofill.bind_history_loop(loop)
        try:
            assert autofill._HISTORY_STOPPING is False
        finally:
            autofill.unbind_history_loop(loop)

    asyncio.run(scenario())


# ── C2 · sync_now 계정 범위 캡처 ────────────────────────────────────────────
def test_c2_sync_applies_to_captured_account_when_cli_wait_switches(
    two_accounts, monkeypatch
) -> None:
    """CLI 응답을 기다리는 사이 A→B 로 바뀌어도 적재는 캡처한 A DB 로 간다."""
    monkeypatch.setattr(syncer, "MANAGE_ENABLED", False)
    monkeypatch.setattr(syncer, "AUTH_ENABLED", False)
    calls: list[int] = []

    async def list_jobs():
        calls.append(1)
        active_account.set_active(B_EMAIL, B_UID)  # CLI 대기 중 계정 전환
        return []

    def apply_synced_jobs(jobs, wid, *, changed_job_ids, track_telemetry):
        repo.set_setting("r11_sync_scope", active_account.account_key() or "legacy")
        return {"inserted": 0, "updated": 0, "unchanged": 0}

    monkeypatch.setattr(syncer.cli_bridge, "list_jobs", list_jobs)
    monkeypatch.setattr(repo, "apply_synced_jobs", apply_synced_jobs)

    counts = asyncio.run(syncer.sync_now())

    assert len(calls) == 1, "CLI 호출 횟수는 그대로 1회"
    assert counts["fetched"] == 0 and counts["gap_warning"] == 0
    assert _for_account(A_EMAIL, lambda: repo.get_setting("r11_sync_scope")) == A_EMAIL
    assert _for_account(B_EMAIL, lambda: repo.get_setting("r11_sync_scope")) is None
    assert active_account.account_key() == B_EMAIL, "override 는 sync_now 안에서만"


def test_c2_sync_capture_does_not_hold_the_lock_on_the_loop(
    two_accounts, monkeypatch
) -> None:
    """계정 범위 캡처의 transition_lock 획득은 워커 스레드에서 일어난다."""
    monkeypatch.setattr(syncer, "MANAGE_ENABLED", False)
    monkeypatch.setattr(syncer, "AUTH_ENABLED", False)
    lock_threads: list[int] = []
    monkeypatch.setattr(
        active_account,
        "transition_lock",
        _RecordingLock(active_account.transition_lock, lock_threads),
    )

    async def list_jobs():
        return []

    monkeypatch.setattr(syncer.cli_bridge, "list_jobs", list_jobs)
    monkeypatch.setattr(
        repo,
        "apply_synced_jobs",
        lambda jobs, wid, **kwargs: {"inserted": 0, "updated": 0, "unchanged": 0},
    )
    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await syncer.sync_now()

    asyncio.run(scenario())

    assert lock_threads, "캡처는 여전히 전환 락 아래에서 일어난다"
    assert loop_threads[0] not in lock_threads
