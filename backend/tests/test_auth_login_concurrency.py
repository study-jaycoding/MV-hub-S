from __future__ import annotations

import asyncio
import contextlib
import threading
import time

from app.routers import auth as auth_router


def test_login_capacity_uses_process_cpu_count_and_bounded_override(monkeypatch):
    monkeypatch.delenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", raising=False)
    monkeypatch.setattr(auth_router.os, "process_cpu_count", lambda: 2, raising=False)
    assert auth_router._login_verify_capacity() == 2

    monkeypatch.setenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", "99")
    assert auth_router._login_verify_capacity() == auth_router._LOGIN_VERIFY_MAX

    monkeypatch.setenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", "invalid")
    assert auth_router._login_verify_capacity() == 2


def test_login_work_waits_without_exceeding_the_cpu_limit(monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", "2")
    state_lock = threading.Lock()
    active = 0
    maximum = 0

    def expensive_auth(value: int) -> int:
        nonlocal active, maximum
        with state_lock:
            active += 1
            maximum = max(maximum, active)
        try:
            time.sleep(0.02)
            return value
        finally:
            with state_lock:
                active -= 1

    async def run() -> list[int]:
        loop = asyncio.get_running_loop()
        if hasattr(loop, auth_router._LOGIN_LIMITER_ATTR):
            delattr(loop, auth_router._LOGIN_LIMITER_ATTR)
        try:
            return await asyncio.gather(
                *(
                    auth_router._run_login_work(expensive_auth, value)
                    for value in range(20)
                )
            )
        finally:
            if hasattr(loop, auth_router._LOGIN_LIMITER_ATTR):
                delattr(loop, auth_router._LOGIN_LIMITER_ATTR)

    assert asyncio.run(run()) == list(range(20))
    assert maximum == 2


def test_cancelled_login_keeps_its_permit_until_hash_work_finishes(monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_LOGIN_VERIFY_CONCURRENCY", "1")
    first_started = threading.Event()
    second_started = threading.Event()
    release_first = threading.Event()
    state_lock = threading.Lock()
    active = 0
    maximum = 0

    def expensive_auth(value: int) -> int:
        nonlocal active, maximum
        with state_lock:
            active += 1
            maximum = max(maximum, active)
        try:
            if value == 1:
                first_started.set()
                release_first.wait(timeout=2)
            else:
                second_started.set()
            return value
        finally:
            with state_lock:
                active -= 1

    async def run() -> int:
        first = asyncio.create_task(auth_router._run_login_work(expensive_auth, 1))
        assert await asyncio.to_thread(first_started.wait, 1)
        first.cancel()
        second = asyncio.create_task(auth_router._run_login_work(expensive_auth, 2))
        await asyncio.sleep(0.05)
        assert not second_started.is_set()
        release_first.set()
        with contextlib.suppress(asyncio.CancelledError):
            await first
        return await second

    assert asyncio.run(run()) == 2
    assert maximum == 1
