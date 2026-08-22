"""R11 백엔드 배치 2 계약 회귀 — 서명 시크릿 프로세스 캐시(A1)·최초 생성 경합(A2)·
수제 non-abandon 3곳의 반복 취소(A4).

핵심 계약
- A1: 토큰이 달린 요청의 서명 경로는 DB 를 열지 않는다(=유지보수 게이트에 걸려 이벤트 루프를
      멈추지 않는다). 단, 복원으로 auth_secret 이 회전하면 옛 토큰은 반드시 거부된다(R7 0-B).
- A2: 시크릿 최초 생성이 동시에 일어나도 모두 같은 값을 받는다(나중 쓰기 승 금지).
- A4: 반복 취소 뒤 helper 가 반환하는 시점엔 워커 스레드가 이미 끝나 있고 슬롯도 그때 풀린다.
"""

from __future__ import annotations

import asyncio
import io
import threading
import time
from pathlib import Path
from unittest import mock

import pytest

from app import db
from app.routers import auth as auth_router
from app.routers import db_backup, db_transfer
from app.services import auth as auth_svc


EMAIL = "r11-wave2@example.com"


# ── 공용 픽스처 ───────────────────────────────────────────────────────────────


@pytest.fixture()
def isolated_auth_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """이 테스트 전용 DB + 빈 시크릿 캐시(다른 테스트의 캐시·env 를 타지 않게)."""
    path = tmp_path / "auth.db"
    monkeypatch.delenv("CONTENT_HUB_AUTH_SECRET", raising=False)
    monkeypatch.setenv("CONTENT_HUB_DB", str(path))
    monkeypatch.setattr(auth_svc, "_secret_cache", None)
    db.flush_pool()
    db.init_db()
    try:
        yield path
    finally:
        auth_svc._secret_cache = None
        db.flush_pool()


def _refuse_connection(*_args, **_kwargs):
    raise AssertionError("서명 경로가 DB 커넥션을 열었습니다")


# ── A1: 서명 경로에서 DB 접근 제거 ────────────────────────────────────────────


def test_warm_signing_path_needs_no_database_even_inside_maintenance_gate(
    isolated_auth_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = auth_svc.make_token(EMAIL)  # 첫 서명이 시크릿을 캐시에 채운다
    monkeypatch.setattr(auth_svc, "get_connection", _refuse_connection)

    with db.maintenance_gate():
        started = time.monotonic()
        assert auth_svc.verify_token(token) == EMAIL
        assert auth_svc.token_password_stamp(token) is None  # 스탬프 조회도 DB 없이
        elapsed = time.monotonic() - started

    assert elapsed < 1.0  # 게이트를 기다리지 않는다(이벤트 루프 비차단)


def test_cold_signing_path_fails_closed_during_maintenance_instead_of_blocking(
    isolated_auth_db: Path,
) -> None:
    token = auth_svc.make_token(EMAIL)
    auth_svc._secret_cache = None  # 복원 직후처럼 캐시가 비어 있는 상태

    with db.maintenance_gate():
        started = time.monotonic()
        with mock.patch.object(auth_svc, "get_connection", _refuse_connection):
            assert auth_svc.verify_token(token) is None  # 검증 불가 → 미인증(fail-closed)
        elapsed = time.monotonic() - started

    assert elapsed < 1.0
    # 게이트가 풀리면 평소대로 동작해야 한다(영구 거부가 아니다).
    assert auth_svc.verify_token(token) == EMAIL


def test_secret_cache_is_invalidated_by_pool_epoch(isolated_auth_db: Path) -> None:
    """복원이 쓰는 무효화 신호(flush_pool → pool_epoch)가 캐시를 확실히 깬다."""
    first = auth_svc.get_secret()
    with db.get_connection() as conn:  # 캐시가 없다면 이 새 값을 바로 봤을 것
        conn.execute("UPDATE app_setting SET value='rotated' WHERE key='auth_secret'")
    assert auth_svc.get_secret() == first  # 에폭이 그대로면 캐시 유지(DB 재조회 없음)

    db.flush_pool()  # = 복원이 게이트 안에서 하는 일

    assert auth_svc.get_secret() == "rotated"


def test_restore_rotates_the_secret_so_old_tokens_are_rejected(
    isolated_auth_db: Path,
) -> None:
    """R7 0-B 보안 계약 — 실제 _install_db 를 태워도 캐시가 옛 시크릿을 살리지 못한다."""
    token = auth_svc.make_token(EMAIL)
    assert auth_svc.verify_token(token) == EMAIL  # 캐시 워밍 포함
    before = auth_svc.get_secret()

    incoming = isolated_auth_db.parent / "incoming.db"
    db.init_db(incoming)
    with mock.patch.object(db_transfer, "AUTH_ENABLED", True):
        assert db_transfer._install_db(incoming) == {"ok": True, "relogin_required": True}

    assert auth_svc.get_secret() != before  # 교체 DB 의 새 시크릿
    assert auth_svc.verify_token(token) is None  # 옛 시크릿 서명 토큰은 거부
    assert auth_svc.verify_token(auth_svc.make_token(EMAIL)) == EMAIL  # 새 토큰은 정상


def test_environment_secret_still_wins_and_never_reads_the_database(
    isolated_auth_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CONTENT_HUB_AUTH_SECRET", "env-secret")
    monkeypatch.setattr(auth_svc, "_secret_cache", None)
    monkeypatch.setattr(auth_svc, "get_connection", _refuse_connection)

    assert auth_svc.get_secret() == "env-secret"
    assert auth_svc.verify_token(auth_svc.make_token(EMAIL)) == EMAIL


# ── A2: 최초 생성 경합 ────────────────────────────────────────────────────────


def _secret_rows() -> list[str]:
    with db.get_connection() as conn:
        return [
            row["value"]
            for row in conn.execute("SELECT value FROM app_setting WHERE key='auth_secret'")
        ]


def test_concurrent_first_generation_agrees_on_one_secret(
    isolated_auth_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    barrier = threading.Barrier(2, timeout=5)
    real_token_hex = auth_svc.secrets.token_hex

    def synced_token_hex(size: int) -> str:
        # 두 스레드가 '아직 시크릿 없음'을 모두 확인한 뒤에야 쓰기로 넘어가게 맞춘다.
        barrier.wait()
        return real_token_hex(size)

    monkeypatch.setattr(auth_svc.secrets, "token_hex", synced_token_hex)

    results: list[str] = []
    errors: list[BaseException] = []

    def load() -> None:
        try:
            results.append(auth_svc._load_secret())
        except BaseException as exc:  # 스레드 실패를 본 테스트로 전달
            errors.append(exc)

    threads = [threading.Thread(target=load) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert errors == []
    assert len(results) == 2
    assert results[0] == results[1]  # 나중 쓰기가 앞선 시크릿을 덮지 않는다
    assert _secret_rows() == [results[0]]


def test_concurrent_get_secret_returns_the_same_value(isolated_auth_db: Path) -> None:
    results: list[str] = []

    def read() -> None:
        results.append(auth_svc.get_secret())

    threads = [threading.Thread(target=read) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert len(results) == 2 and results[0] == results[1]
    assert _secret_rows() == [results[0]]


# ── A4: 반복 취소에도 슬롯을 스레드보다 먼저 놓지 않는다 ───────────────────────


def _blocking_worker(started: threading.Event, release: threading.Event, finished: threading.Event):
    def work(*_args, **_kwargs):
        started.set()
        release.wait(timeout=5)
        finished.set()
        return "done"

    return work


async def _cancel_twice(task: asyncio.Task, started: threading.Event) -> None:
    assert await asyncio.to_thread(started.wait, 5), "워커 스레드가 시작되지 않았습니다"
    task.cancel()
    await asyncio.sleep(0)
    task.cancel()  # ★반복 취소 — 수제 판은 여기서 스레드보다 먼저 반환했다
    await asyncio.sleep(0.05)


def _run_repeated_cancel_case(make_coro, semaphore_of) -> None:
    started, release, finished = (threading.Event() for _ in range(3))

    async def scenario() -> None:
        task = asyncio.create_task(make_coro(_blocking_worker(started, release, finished)))
        try:
            await _cancel_twice(task, started)
            assert not task.done()  # 스레드가 끝날 때까지 helper 는 반환하지 않는다
            assert not finished.is_set()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()  # 반환 시점엔 워커 완료
        assert not semaphore_of().locked()  # 슬롯/permit 은 그때 정상 반환

    asyncio.run(scenario())


def test_repeated_cancel_keeps_the_backup_store_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_backup, "_store_slots", asyncio.Semaphore(1))

    def make_coro(work):
        monkeypatch.setattr(db_backup, "_store_backup", work)
        return db_backup._store_backup_limited(Path("d"), "n.db", io.BytesIO(b"x"))

    _run_repeated_cancel_case(make_coro, lambda: db_backup._store_slots)


def test_repeated_cancel_keeps_the_backup_set_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_backup, "_store_slots", asyncio.Semaphore(1))

    def make_coro(work):
        monkeypatch.setattr(db_backup, "_store_backup_set", work)
        return db_backup._store_backup_set_limited(Path("d"), {}, {})

    _run_repeated_cancel_case(make_coro, lambda: db_backup._store_slots)


def test_repeated_cancel_keeps_the_login_permit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", "1")
    limiter: list[asyncio.Semaphore] = []

    def make_coro(work):
        async def run():
            limiter.append(auth_router._login_limiter())
            return await auth_router._run_login_work(work, "pw")

        return run()

    _run_repeated_cancel_case(make_coro, lambda: limiter[0])
