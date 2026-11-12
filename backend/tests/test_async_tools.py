"""R7(코덱스 P1) — to_thread_non_abandon: 취소 시 스레드 완료를 기다린 뒤 취소 전파."""
from __future__ import annotations

import asyncio
import contextvars
import gc
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import anyio

from app.services import async_tools
from app.services.async_tools import to_thread_non_abandon


class ToThreadNonAbandonTests(unittest.TestCase):
    def test_cancellation_waits_for_thread_completion(self):
        started = threading.Event()
        finished = threading.Event()

        def slow_worker():
            started.set()
            # 스레드가 자원(임시파일 등)을 쓰는 구간 — 취소가 이걸 방치하면 안 된다
            threading.Event().wait(0.15)
            finished.set()
            return "done"

        async def scenario():
            task = asyncio.ensure_future(to_thread_non_abandon(slow_worker))
            await asyncio.to_thread(started.wait, 1.0)  # 스레드 진입 확인
            task.cancel()
            cancelled = False
            try:
                await task
            except asyncio.CancelledError:
                cancelled = True
            # ★핵심 계약: 취소가 전파된 시점에 스레드는 이미 완료돼 있다(non-abandon).
            #  순정 to_thread 는 여기서 finished 가 아직 False 였다(코덱스 재현).
            return cancelled, finished.is_set()

        cancelled, thread_done = asyncio.run(scenario())
        self.assertTrue(cancelled)
        self.assertTrue(thread_done)

    def test_repeated_cancellation_still_waits_for_thread(self):
        """코덱스 재확인 P1 — 대기 중 두 번째 취소가 와도 worker 를 방치하지 않는다."""
        started = threading.Event()
        finished = threading.Event()

        def slow_worker():
            started.set()
            threading.Event().wait(0.15)
            finished.set()

        async def scenario():
            task = asyncio.ensure_future(to_thread_non_abandon(slow_worker))
            await asyncio.to_thread(started.wait, 1.0)
            task.cancel()
            await asyncio.sleep(0.02)
            task.cancel()  # 반복 취소 — 종전엔 worker 가 취소돼 helper 가 먼저 반환했다
            await asyncio.sleep(0.02)
            task.cancel()
            cancelled = False
            try:
                await task
            except asyncio.CancelledError:
                cancelled = True
            return cancelled, finished.is_set()

        cancelled, thread_done = asyncio.run(scenario())
        self.assertTrue(cancelled)
        self.assertTrue(thread_done)

    def test_normal_path_returns_result_and_propagates_errors(self):
        async def scenario():
            result = await to_thread_non_abandon(lambda: "값")
            try:
                await to_thread_non_abandon(self._boom)
            except RuntimeError as exc:
                return result, str(exc)
            return result, None

        result, error = asyncio.run(scenario())
        self.assertEqual(result, "값")
        self.assertEqual(error, "스레드 오류")

    def test_arguments_and_context_are_preserved(self):
        marker = contextvars.ContextVar("thread_marker", default="unset")

        def worker(value, *, suffix):
            return value + suffix, marker.get()

        async def scenario():
            token = marker.set("caller")
            try:
                return await to_thread_non_abandon(worker, "a", suffix="b")
            finally:
                marker.reset(token)

        self.assertEqual(asyncio.run(scenario()), ("ab", "caller"))

    def test_anyio_level_cancellation_wait_is_bounded(self):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        cleanup = []
        scopes = []
        waits = []

        def worker():
            started.set()
            release.wait(3)
            finished.set()

        def shield(task):
            waits.append(1)
            return asyncio.shield(task)

        # AnyIO와 시험 실행기 자체의 asyncio는 바꾸지 않는다.
        proxy = SimpleNamespace(create_task=asyncio.create_task, to_thread=asyncio.to_thread,
                                shield=shield, CancelledError=asyncio.CancelledError)

        async def target():
            with anyio.CancelScope() as scope:
                scopes.append(scope)
                try:
                    await to_thread_non_abandon(worker)
                finally:
                    cleanup.append(finished.is_set())

        async def scenario():
            task = asyncio.create_task(target())
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                scopes[0].cancel()
                await asyncio.sleep(0.1)
                pending = not task.done()
                wait_count = len(waits)
            finally:
                release.set()
                await asyncio.wait_for(task, 3)
            return pending, wait_count

        with patch.object(async_tools, "asyncio", proxy):
            pending, wait_count = asyncio.run(scenario())
        self.assertTrue(pending)
        self.assertLessEqual(wait_count, 20, "cancelled scope is busy-waiting")
        self.assertTrue(scopes[0].cancelled_caught)
        self.assertEqual(cleanup, [True])

    def test_worker_failure_during_cancellation_is_retrieved(self):
        for use_anyio in (False, True):
            with self.subTest(use_anyio=use_anyio):
                started = threading.Event()
                release = threading.Event()
                finished = threading.Event()
                scopes = []
                cleanup = []
                failure = RuntimeError("worker failed after cancellation")

                def worker():
                    started.set()
                    release.wait(3)
                    finished.set()
                    raise failure

                async def call():
                    try:
                        await to_thread_non_abandon(worker)
                    finally:
                        cleanup.append(finished.is_set())

                async def target():
                    if use_anyio:
                        with anyio.CancelScope() as scope:
                            scopes.append(scope)
                            await call()
                    else:
                        await call()

                async def scenario():
                    loop = asyncio.get_running_loop()
                    errors = []
                    old_handler = loop.get_exception_handler()
                    loop.set_exception_handler(lambda _loop, context: errors.append(context))
                    task = asyncio.create_task(target())
                    try:
                        self.assertTrue(await asyncio.to_thread(started.wait, 1))
                        if use_anyio:
                            scopes[0].cancel()
                        else:
                            task.cancel("stop")
                        await asyncio.sleep(0.01)
                        self.assertFalse(task.done())
                    finally:
                        release.set()
                    try:
                        if use_anyio:
                            await asyncio.wait_for(task, 3)
                            self.assertTrue(scopes[0].cancelled_caught)
                        else:
                            with self.assertRaises(asyncio.CancelledError) as caught:
                                await asyncio.wait_for(task, 3)
                            self.assertEqual(caught.exception.args, ("stop",))
                        del task
                        gc.collect()
                        await asyncio.sleep(0)
                        # Python 3.14 shield는 회수한 예외도 이 메시지로 알린다.
                        # 미회수 예외 등 다른 오류는 허용하지 않는다.
                        for error in errors:
                            self.assertEqual(error.get("message"),
                                             "RuntimeError exception in shielded future")
                            self.assertIs(error.get("exception"), failure)
                    finally:
                        loop.set_exception_handler(old_handler)

                asyncio.run(scenario())
                self.assertEqual(cleanup, [True])

    @staticmethod
    def _boom():
        raise RuntimeError("스레드 오류")


if __name__ == "__main__":
    unittest.main()
