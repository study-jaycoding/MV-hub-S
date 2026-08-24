"""R11 적대 리뷰 P1 2건 — 라우트 도중 계정 전환이 껴도 계정 범위가 갈리지 않는다.

P1-1 (share.finalize / share.unpublish)
    두 라우트는 '로컬 읽기 → 원장 prepare → 프록시 토큰 → 서버 왕복 → 로컬 미러 →
    BackgroundTask 등록'이라는 긴 흐름이고, repo·_proxy.token() 은 전부 호출 시점의 활성
    계정 DB 를 읽는다. 서버 왕복을 기다리는 사이 다른 창에서 A→B 로 전환하면 A 원장에
    prepare 해 두고 B 토큰으로 호출하거나 미러·보존 등록이 B DB 로 새어 나갔다.
    계약: 첫 DB 접근 뒤~응답 사이에 전환을 강제해도 모든 기록이 A DB·A 신원으로 남는다.

P1-2 (ingest 의 history start/status)
    scope 캡처와 acc/key 계산이 갈리면 'B DB 를 고정한 채 A 신원'이라는 섞인 조합이 나온다.
    계약: (scope, acc, key) 는 한 override 안에서 만들어진 원자 세트다 — 전환이 껴도
    (A,A,A) 또는 (B,B,B) 만 나오고 섞이지 않는다.
"""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from unittest import mock
from unittest.mock import AsyncMock

import pytest
from fastapi import BackgroundTasks

from app import active_account, config, db, deps, repo
from app.routers import ingest, share
from app.services import history_autofill as autofill


A_EMAIL = "r11p1-a@example.com"
B_EMAIL = "r11p1-b@example.com"
A_UID = "r11p1-a-uid"
B_UID = "r11p1-b-uid"


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
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])

    for email, uid, server_token in (
        (A_EMAIL, A_UID, "token-A"),
        (B_EMAIL, B_UID, "token-B"),
    ):
        active_account.set_active(email, uid)
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        repo.set_setting("my_creator_uid", uid)
        repo.set_setting("shared_server_url", "http://share.example.test")
        repo.set_setting("shared_server_token", server_token)

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


def _seed_generation(*, shared: bool, final: bool = False) -> str:
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "scope pinning"}, "me", generation_id="local-1"
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status='done', job_id=? WHERE id=?",
            ("server-1", gen_id),
        )
    if shared:
        repo.publish(gen_id, "me", "team")
    if final:
        repo.set_final(gen_id, True, A_UID)
    return gen_id


def _ledger_rows() -> list[dict]:
    with db.get_connection() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM share_state_intent ORDER BY created_at, intent_id"
            ).fetchall()
        ]


def _switching_proxy(observed: dict, payload: dict):
    """서버 왕복 도중(=첫 DB 접근 뒤, 응답 전)에 A→B 전환을 끼워 넣는 프록시 대역."""

    def proxy_json(_method, path, **_kwargs):
        observed["path"] = path
        observed["token"] = share._proxy.token()  # 호출 시점의 활성 계정 DB 에서 읽는다
        active_account.set_active(B_EMAIL, B_UID)  # 다른 창에서 계정 전환
        db.flush_pool()
        # 머신 포인터는 실제로 B 로 넘어갔지만, 라우트 안에서 보이는 계정은 고정된 A 여야 한다.
        observed["pointer_after_switch"] = (active_account._read_pointer() or {}).get("email")
        observed["scope_after_switch"] = active_account.account_key()
        return payload

    return proxy_json


# 고정 대상 프록시 mutation 3종 — 씨앗 상태와 서버가 돌려주는 성공 응답.
_ROUTE_CASES: dict[str, dict] = {
    "finalize": {
        "seed": {"shared": True},
        "payload": {"id": "server-1", "job_id": "server-1", "shared": True, "is_final": True},
    },
    "unpublish": {
        "seed": {"shared": True},
        "payload": {"id": "server-1", "job_id": "server-1", "shared": False, "is_final": False},
    },
    "unfinalize": {
        "seed": {"shared": True, "final": True},
        "payload": {"id": "server-1", "job_id": "server-1", "shared": True, "is_final": False},
    },
}


# ── P1-1 · finalize / unpublish / unfinalize 의 계정 고정 ───────────────────
def test_p1_1_finalize_keeps_every_record_on_the_captured_account(
    two_accounts, monkeypatch
) -> None:
    """서버 왕복 중 A→B 전환이 껴도 토큰·원장·미러·보존 등록이 전부 A 로 간다."""
    gen_id = _seed_generation(shared=True)
    observed: dict = {}
    background = BackgroundTasks()

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=_switching_proxy(
                observed,
                {
                    "id": "server-1",
                    "job_id": "server-1",
                    "shared": True,
                    "is_final": True,
                    "final_by": A_UID,
                },
            ),
        ),
    ):
        out = share.finalize(gen_id, _request(), background)

    assert out["is_final"] is True
    assert observed["path"] == "/api/generations/server-1/finalize"
    assert observed["token"] == "token-A", "프록시 토큰은 캡처한 A 계정 DB 에서 읽어야 한다"
    assert observed["pointer_after_switch"] == B_EMAIL, "전환 자체는 실제로 일어났다"
    assert observed["scope_after_switch"] == A_EMAIL, "라우트 안에서는 계속 A 로 보여야 한다"
    # override 는 라우트 안에서만 — 라우트가 끝나면 머신 포인터(B)가 다시 보인다.
    assert active_account.account_key() == B_EMAIL

    a_rows = _for_account(A_EMAIL, _ledger_rows)
    assert [row["status"] for row in a_rows] == ["converged"]
    assert _for_account(B_EMAIL, _ledger_rows) == []

    a_gen = _for_account(A_EMAIL, lambda: repo.get_generation(gen_id))
    assert a_gen and a_gen["is_final"] is True and a_gen["shared"] is True
    assert _for_account(B_EMAIL, lambda: repo.get_generation(gen_id)) is None

    scopes = [task.args[1] for task in background.tasks]
    assert scopes == [A_EMAIL], "보존 BackgroundTask 도 캡처한 A 범위를 받아야 한다"


def test_p1_1_finalize_preservation_task_registers_in_the_captured_account(
    two_accounts, monkeypatch
) -> None:
    """등록된 보존 태스크를 실제로 돌려도 골드 원본 보존은 A DB 에 남는다(A6 계약 유지)."""
    gen_id = _seed_generation(shared=True)
    background = BackgroundTasks()
    monkeypatch.setattr(share, "preserve_generation_now", AsyncMock(return_value=None))

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=_switching_proxy(
                {},
                {
                    "id": "server-1",
                    "job_id": "server-1",
                    "shared": True,
                    "is_final": True,
                },
            ),
        ),
    ):
        share.finalize(gen_id, _request(), background)

    task = background.tasks[0]
    asyncio.run(task.func(*task.args, **task.kwargs))

    a_state = _for_account(A_EMAIL, lambda: repo.get_media_preservation(gen_id))
    assert a_state and a_state["reason"] == "final"
    assert _for_account(B_EMAIL, lambda: repo.get_media_preservation(gen_id)) is None


def test_p1_1_unpublish_keeps_every_record_on_the_captured_account(
    two_accounts, monkeypatch
) -> None:
    """unpublish 도 같은 결함이 있었다 — 서버 왕복 중 전환이 껴도 A 원장·A 미러로 수렴한다."""
    gen_id = _seed_generation(shared=True)
    observed: dict = {}

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=_switching_proxy(
                observed,
                {
                    "id": "server-1",
                    "job_id": "server-1",
                    "shared": False,
                    "is_final": False,
                },
            ),
        ),
    ):
        out = share.unpublish(gen_id, _request())

    assert out["shared"] is False
    assert observed["path"] == "/api/generations/server-1/unpublish"
    assert observed["token"] == "token-A"

    a_rows = _for_account(A_EMAIL, _ledger_rows)
    assert [row["status"] for row in a_rows] == ["converged"]
    assert _for_account(B_EMAIL, _ledger_rows) == []

    a_gen = _for_account(A_EMAIL, lambda: repo.get_generation(gen_id))
    assert a_gen and a_gen["shared"] is False
    assert _for_account(B_EMAIL, lambda: repo.get_generation(gen_id)) is None


def test_p1_1_unfinalize_keeps_every_record_on_the_captured_account(
    two_accounts, monkeypatch
) -> None:
    """unfinalize 도 unpublish 와 같은 구조라 같은 고정을 받는다(coordinator 판정 ①)."""
    gen_id = _seed_generation(shared=True, final=True)
    observed: dict = {}

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy,
            "proxy_json",
            side_effect=_switching_proxy(observed, _ROUTE_CASES["unfinalize"]["payload"]),
        ),
    ):
        out = share.unfinalize(gen_id, _request())

    assert out["is_final"] is False
    assert observed["path"] == "/api/generations/server-1/unfinalize"
    assert observed["token"] == "token-A"
    assert observed["scope_after_switch"] == A_EMAIL

    assert [row["status"] for row in _for_account(A_EMAIL, _ledger_rows)] == ["converged"]
    assert _for_account(B_EMAIL, _ledger_rows) == []

    a_gen = _for_account(A_EMAIL, lambda: repo.get_generation(gen_id))
    assert a_gen and a_gen["is_final"] is False and a_gen["shared"] is True
    assert _for_account(B_EMAIL, lambda: repo.get_generation(gen_id)) is None


@pytest.mark.parametrize("route_name", sorted(_ROUTE_CASES))
def test_p1_1_unpinned_body_would_drift_to_the_other_account(
    two_accounts, monkeypatch, route_name
) -> None:
    """고정을 벗겨낸 원본 본체(__wrapped__)는 전환 뒤 B 로 샌다 — 회귀 감시용 대조군."""
    case = _ROUTE_CASES[route_name]
    gen_id = _seed_generation(**case["seed"])
    payload = case["payload"]
    unpinned = getattr(share, route_name).__wrapped__
    args = (gen_id, _request()) + ((BackgroundTasks(),) if route_name == "finalize" else ())
    observed: dict = {}

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(
            share._proxy, "proxy_json", side_effect=_switching_proxy(observed, payload)
        ),
    ):
        unpinned(*args)

    # 전환 뒤의 단계들이 B 를 보게 되면서 A 원장은 converged 로 닫히지 못한다.
    assert observed["token"] == "token-A", "전환 전에 읽은 토큰까지는 A 가 맞다"
    assert [row["status"] for row in _for_account(A_EMAIL, _ledger_rows)] != ["converged"]


def test_p1_1_decorated_routes_keep_their_fastapi_signature() -> None:
    """데코레이터가 FastAPI 의 파라미터 해석을 가리지 않는다(경로/의존성 주입 유지)."""
    import inspect

    from fastapi.dependencies.utils import get_dependant
    from fastapi.routing import APIRoute

    assert list(inspect.signature(share.finalize).parameters) == [
        "gen_id",
        "request",
        "background",
    ]
    for route_name in ("unpublish", "unfinalize"):
        assert list(inspect.signature(getattr(share, route_name)).parameters) == [
            "gen_id",
            "request",
        ]
    # 동기 라우트로 남아야 threadpool 에서 돈다(전환 락을 직접 기다려도 루프가 안 멈춘다).
    assert not inspect.iscoroutinefunction(share.finalize)

    # FastAPI 가 실제로 푸는 방식 그대로 — path 파라미터·Request·BackgroundTasks 인식 확인.
    dependant = get_dependant(path="/api/generations/{gen_id}/finalize", call=share.finalize)
    assert [param.name for param in dependant.path_params] == ["gen_id"]
    assert dependant.request_param_name == "request"
    assert dependant.background_tasks_param_name == "background"

    routes = {
        (route.path, tuple(sorted(route.methods))): route
        for route in share.router.routes
        if isinstance(route, APIRoute)
    }
    for route_name in _ROUTE_CASES:
        route = routes[(f"/api/generations/{{gen_id}}/{route_name}", ("POST",))]
        assert [param.name for param in route.dependant.path_params] == ["gen_id"]


def test_p1_1_route_restores_the_outer_scope_after_an_error(
    two_accounts, monkeypatch
) -> None:
    """라우트가 예외로 끝나도 override 는 finally 에서 반드시 풀린다."""
    gen_id = _seed_generation(shared=True)

    def boom(*_args, **_kwargs):
        raise RuntimeError("서버 왕복 실패")

    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=boom),
        pytest.raises(RuntimeError),
    ):
        share.finalize(gen_id, _request(), BackgroundTasks())

    assert active_account._override.get() is None
    assert active_account.account_key() == A_EMAIL


# ── P1-2 · history 시작/상태의 (scope, acc, key) 원자 세트 ───────────────────
@pytest.fixture
def history_ready(monkeypatch):
    monkeypatch.setattr(autofill, "AUTH_ENABLED", False)
    monkeypatch.setattr(autofill, "LOCAL_AGENT_PAIR_SECRET", "")
    monkeypatch.setattr(autofill, "_HISTORY_TASKS", {})
    monkeypatch.setattr(autofill, "_HISTORY_STATES", {})
    yield


def _switch_after_capture(monkeypatch) -> None:
    """계정 범위를 캡처하자마자 A→B 전환이 끼어들게 만든다(리뷰가 지적한 창)."""
    real_capture = autofill._capture_history_scope

    def capture_then_switch() -> str:
        scope = real_capture()
        active_account.set_active(B_EMAIL, B_UID)
        db.flush_pool()
        return scope

    monkeypatch.setattr(autofill, "_capture_history_scope", capture_then_switch)


def test_p1_2_identity_set_is_atomic_when_a_switch_lands_right_after_capture(
    two_accounts, history_ready, monkeypatch
) -> None:
    """캡처 직후 전환이 껴도 (scope, acc, key) 는 전부 A — 섞인 조합이 나오지 않는다."""
    _switch_after_capture(monkeypatch)

    scope, acc, key = ingest._capture_history_identity(None)

    assert (scope, acc["creator_uid"], key) == (A_EMAIL, A_UID, A_EMAIL)
    assert active_account.account_key() == B_EMAIL, "전환 자체는 실제로 일어났다"


def test_p1_2_identity_set_is_atomic_when_the_switch_lands_before_capture(
    two_accounts, history_ready
) -> None:
    """캡처 전에 전환이 끝났으면 세 값이 모두 B — 역시 한 계정으로 일관된다."""
    active_account.set_active(B_EMAIL, B_UID)
    db.flush_pool()

    scope, acc, key = ingest._capture_history_identity(None)

    assert (scope, acc["creator_uid"], key) == (B_EMAIL, B_UID, B_EMAIL)


def test_p1_2_identity_capture_runs_under_the_transition_lock(
    two_accounts, history_ready, monkeypatch
) -> None:
    """범위 캡처는 종전대로 전환 락 아래에서 일어난다(HAF-1/A7 계약 유지)."""
    held: list[int] = []
    real_lock = active_account.transition_lock

    class _RecordingLock:
        def __enter__(self):
            held.append(threading.get_ident())
            return real_lock.__enter__()

        def __exit__(self, *exc_info):
            return real_lock.__exit__(*exc_info)

    monkeypatch.setattr(active_account, "transition_lock", _RecordingLock())

    ingest._capture_history_identity(None)

    assert held, "캡처가 전환 락을 지나야 한다"


def test_p1_2_start_route_passes_one_account_to_task_and_snapshot(
    two_accounts, history_ready, monkeypatch
) -> None:
    """start 라우트: 시작 task 인자와 최초 snapshot 이 같은 계정 범위로 간다."""
    _for_account(A_EMAIL, lambda: repo.mark_history_gap(A_EMAIL))
    _switch_after_capture(monkeypatch)
    started: dict = {}

    def start_task(key, acc, *, automatic, account_scope=None):
        started.update(
            key=key,
            uid=acc.get("creator_uid"),
            account_scope=account_scope,
            automatic=automatic,
        )
        return True

    monkeypatch.setattr(autofill, "_start_history_task", start_task)

    out = asyncio.run(ingest.start_history_import(_request()))

    assert started == {
        "key": A_EMAIL,
        "uid": A_UID,
        "account_scope": A_EMAIL,
        "automatic": False,
    }
    # 감사 행은 A DB 에만 있다 — snapshot 이 B 를 읽었다면 gap 이 안 보인다.
    assert out["gap_detected_at"], "snapshot 도 캡처한 A DB 에서 읽어야 한다"


def test_p1_2_status_route_reads_the_snapshot_from_the_key_it_computed(
    two_accounts, history_ready, monkeypatch
) -> None:
    """status 라우트: 키 계산과 snapshot 조회가 같은 override 안에서 끝난다."""
    _for_account(A_EMAIL, lambda: repo.mark_history_gap(A_EMAIL))
    _switch_after_capture(monkeypatch)

    out = asyncio.run(ingest.history_import_status(_request()))

    assert out["gap_detected_at"], "키는 A, snapshot 은 B 처럼 갈리면 안 된다"
    assert active_account.account_key() == B_EMAIL


def test_p1_2_history_routes_keep_the_lock_and_db_off_the_event_loop(
    two_accounts, history_ready, monkeypatch
) -> None:
    """신원 계산이 워커 스레드로 옮겨져도 루프에서 전환 락을 기다리지 않는다(A7 계약)."""
    lock_threads: list[int] = []
    real_lock = active_account.transition_lock

    class _RecordingLock:
        def __enter__(self):
            lock_threads.append(threading.get_ident())
            return real_lock.__enter__()

        def __exit__(self, *exc_info):
            return real_lock.__exit__(*exc_info)

    monkeypatch.setattr(active_account, "transition_lock", _RecordingLock())
    monkeypatch.setattr(autofill, "_start_history_task", lambda *a, **k: True)
    loop_threads: list[int] = []

    async def scenario():
        loop_threads.append(threading.get_ident())
        return await ingest.start_history_import(_request())

    asyncio.run(scenario())

    assert lock_threads
    assert loop_threads[0] not in lock_threads
