"""Model catalog SWR contracts through the real parser, cache and single-flight."""

import asyncio
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, skipUnless
from unittest.mock import AsyncMock, patch


def payload(key):
    # The CLI currently calls this field job_type; consumers use job_set_type.
    return json.dumps([{"job_type": key, "display_name": key.upper(), "type": "image"}])


class ModelCatalogSWRTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.services import cli_bridge

        self.bridge = cli_bridge
        self.saved_cache = dict(cli_bridge._CALL_CACHE)
        cli_bridge._CALL_CACHE.pop("models", None)
        self.loop = asyncio.get_running_loop()
        self.saved_state = cli_bridge._model_refresh_states.pop(self.loop, None)
        self.tasks = []
        self.gates = []
        cli_bridge.start_model_refreshes()

    async def asyncTearDown(self):
        # Always release fake CLI cleanup, even when an assertion failed.
        for gate in self.gates:
            gate.set()
        await self.bridge.shutdown_model_refreshes()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.bridge._model_refresh_states.pop(self.loop, None)
        if self.saved_state is not None:
            self.bridge._model_refresh_states[self.loop] = self.saved_state
        self.bridge._CALL_CACHE.clear()
        self.bridge._CALL_CACHE.update(self.saved_cache)

    def gate(self):
        event = asyncio.Event()
        self.gates.append(event)
        return event

    def task(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.append(task)
        return task

    async def seed(self, key="old"):
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value=payload(key))):
            result = await self.bridge.list_models()
        self.assertEqual(result[0]["job_set_type"], key)
        return result

    def age(self, seconds):
        snapshot = self.bridge._CALL_CACHE["models"][1]
        timestamp = time.monotonic() - seconds
        self.bridge._CALL_CACHE["models"] = (timestamp, snapshot)
        return timestamp

    async def drain_refresh(self):
        leader = self.bridge._model_refresh_state().task
        self.assertIsNotNone(leader, "the actual CLI leader must have a strong reference")
        return await asyncio.wait_for(asyncio.shield(leader), timeout=2)

    async def test_fresh_returns_without_cli(self):
        old = await self.seed()
        self.age(100)
        with patch.object(self.bridge, "_run", new=AsyncMock()) as run:
            self.assertEqual(await self.bridge.list_models(), old)
        run.assert_not_awaited()

    async def test_fresh_boundary_uses_stale_response_and_max_age_boundary_waits(self):
        old = await self.seed()
        self.age(300)
        started, release = self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            await release.wait()
            return payload("new")

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            self.assertEqual(await asyncio.wait_for(self.bridge.list_models(), 2), old)
            await asyncio.wait_for(started.wait(), 2)
            self.age(3600)
            waiting = self.task(self.bridge.list_models())
            await asyncio.sleep(0)
            self.assertFalse(waiting.done())
            release.set()
            self.assertEqual((await asyncio.wait_for(waiting, 2))[0]["job_set_type"], "new")
        run.assert_awaited_once()

    async def test_stale_burst_returns_before_cli_finishes_and_refreshes_once(self):
        old = await self.seed()
        self.age(301)
        started, release = self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            await release.wait()
            return payload("new")

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            results = await asyncio.wait_for(
                asyncio.gather(*(self.bridge.list_models() for _ in range(30))), 2
            )
            self.assertTrue(all(result == old for result in results))
            await asyncio.wait_for(started.wait(), 2)
            self.assertFalse(release.is_set())
            self.assertFalse(self.bridge._model_refresh_state().task.done())
            run.assert_awaited_once()
            release.set()
            await self.drain_refresh()
            self.assertEqual((await self.bridge.list_models())[0]["job_set_type"], "new")
            run.assert_awaited_once()
            self.assertLess(time.monotonic() - self.bridge._CALL_CACHE["models"][0], 2)

    async def test_bad_refresh_keeps_last_success_and_logs_without_sensitive_text(self):
        old = await self.seed()
        secret = "private-token-and-private-path"
        failures = [
            self.bridge.CLIError(secret),
            RuntimeError(secret),
            "[]",
            secret + " malformed JSON",
            '[{}, {"job_type": ""}, {"job_set_type": "   "}]',
            '{"unexpected": "object"}',
        ]
        for failure in failures:
            with self.subTest(failure_type=type(failure).__name__):
                timestamp = self.age(301)
                self.bridge._model_refresh_state().retry_at = 0
                fake = AsyncMock(
                    side_effect=failure if isinstance(failure, Exception) else None,
                    return_value=failure if isinstance(failure, str) else None,
                )
                with patch.object(self.bridge, "_run", new=fake), self.assertLogs(
                    self.bridge._model_log, level="WARNING"
                ) as logs:
                    self.assertEqual(await self.bridge.list_models(), old)
                    try:
                        await self.drain_refresh()
                    except self.bridge.CLIError:
                        pass
                self.assertEqual(self.bridge._CALL_CACHE["models"], (timestamp, old))
                state = self.bridge._model_refresh_state()
                self.assertGreater(state.retry_at, time.monotonic())
                for record in logs.records:
                    rendered = record.getMessage() + repr(record.__dict__)
                    self.assertNotIn(secret, rendered)
                    self.assertIsNone(record.exc_info, "raw CLI errors must not leak via traceback")
                    self.assertNotIn("\u2014", record.getMessage())
                joined = " ".join(record.getMessage() + repr(record.__dict__) for record in logs.records)
                for field in ("model_catalog_refresh_failed", "error_kind", "cache_age_seconds", "next_retry_at_utc"):
                    self.assertIn(field, joined)
                with patch.object(self.bridge, "_run", new=AsyncMock()) as retry:
                    for _ in range(4):
                        self.assertEqual(await self.bridge.list_models(), old)
                    retry.assert_not_awaited()

    async def test_mixed_rows_replace_snapshot_with_usable_models_only(self):
        await self.seed()
        self.age(301)
        raw = json.dumps([{}, {"job_type": ""}, {"job_set_type": "new", "display_name": "New"}])
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value=raw)):
            await self.bridge.list_models()
            await self.drain_refresh()
            result = await self.bridge.list_models()
        self.assertEqual([row["job_set_type"] for row in result], ["new"])

    async def test_expired_cache_joins_running_refresh_and_never_returns_stale(self):
        old = await self.seed()
        self.age(301)
        started, release = self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            await release.wait()
            return payload("new")

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            self.assertEqual(await self.bridge.list_models(), old)
            await asyncio.wait_for(started.wait(), 2)
            self.age(3601)
            waiting = self.task(self.bridge.list_models())
            await asyncio.sleep(0)
            self.assertFalse(waiting.done(), "hard-expired snapshot must not be returned")
            run.assert_awaited_once()
            release.set()
            self.assertEqual((await asyncio.wait_for(waiting, 2))[0]["job_set_type"], "new")
            run.assert_awaited_once()

    async def test_valid_keys_with_invalid_display_fields_still_make_valid_responses(self):
        raw = json.dumps([{"job_type": "new", "display_name": 123, "type": {"bad": True}}])
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value=raw)):
            result = await self.bridge.list_models()
        from app.models import ModelOut

        validated = [ModelOut(**row) for row in result]
        self.assertEqual(validated[0].job_set_type, "new")
        self.assertEqual(validated[0].display_name, "new")
        self.assertEqual(validated[0].type, "image")

    async def test_expired_backoff_fails_fast_without_cli(self):
        await self.seed()
        self.age(3601)
        self.bridge._model_refresh_state().retry_at = time.monotonic() + 60
        with patch.object(self.bridge, "_run", new=AsyncMock()) as run:
            for _ in range(3):
                with self.assertRaises(self.bridge.CLIError):
                    await asyncio.wait_for(self.bridge.list_models(), 2)
        run.assert_not_awaited()

    async def test_hard_expired_refresh_failure_is_error_and_preserves_snapshot(self):
        old = await self.seed()
        timestamp = self.age(3601)
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value="[]")) as run:
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.list_models()
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.list_models()
        run.assert_awaited_once()
        self.assertEqual(self.bridge._CALL_CACHE["models"], (timestamp, old))

    async def test_retry_after_backoff_can_refresh(self):
        old = await self.seed()
        self.age(301)
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value="[]")):
            self.assertEqual(await self.bridge.list_models(), old)
            try:
                await self.drain_refresh()
            except self.bridge.CLIError:
                pass
        self.bridge._model_refresh_state().retry_at = time.monotonic() - 1
        with patch.object(self.bridge, "_run", new=AsyncMock(return_value=payload("new"))) as run:
            self.assertEqual(await self.bridge.list_models(), old)
            await self.drain_refresh()
            self.assertEqual((await self.bridge.list_models())[0]["job_set_type"], "new")
            self.assertEqual(self.bridge._model_refresh_state().retry_at, 0)
        run.assert_awaited_once()

    async def test_cold_waiters_join_and_cancelled_request_does_not_cancel_cli(self):
        started, release = self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            await release.wait()
            return payload("new")

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            waiters = [self.task(self.bridge.list_models()) for _ in range(10)]
            await asyncio.wait_for(started.wait(), 2)
            self.assertTrue(all(not task.done() for task in waiters))
            leader = self.bridge._model_refresh_state().task
            waiters[0].cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiters[0]
            self.assertFalse(leader.done())
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*waiters[1:]), 2)
            self.assertTrue(all(result[0]["job_set_type"] == "new" for result in results))
        run.assert_awaited_once()

    async def test_only_waiter_cancelled_still_populates_cache(self):
        started, release = self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            await release.wait()
            return payload("new")

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            waiter = self.task(self.bridge.list_models())
            await asyncio.wait_for(started.wait(), 2)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            release.set()
            await self.drain_refresh()
            self.assertEqual((await self.bridge.list_models())[0]["job_set_type"], "new")
        run.assert_awaited_once()

    async def test_shutdown_waits_for_actual_cli_cleanup_and_blocks_new_work(self):
        await self.seed()
        self.age(301)
        started, cancelled, cleanup_release = self.gate(), self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await cleanup_release.wait()
                raise

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            await self.bridge.list_models()
            await asyncio.wait_for(started.wait(), 2)
            leader = self.bridge._model_refresh_state().task
            shutdown = self.task(self.bridge.shutdown_model_refreshes())
            await asyncio.wait_for(cancelled.wait(), 2)
            self.assertFalse(shutdown.done(), "shutdown must wait for child cleanup")
            self.assertFalse(leader.done())
            self.assertTrue(self.bridge._model_refresh_state().stopping)
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.list_models()
            cleanup_release.set()
            await asyncio.wait_for(shutdown, 2)
            self.assertTrue(leader.cancelled())
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.list_models()
            run.assert_awaited_once()

    async def test_cancelled_shutdown_and_second_shutdown_still_wait_for_cleanup(self):
        started, cancelled, cleanup_release = self.gate(), self.gate(), self.gate()

        async def blocked_run(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await cleanup_release.wait()
                raise

        with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=blocked_run)) as run:
            waiter = self.task(self.bridge.list_models())
            await asyncio.wait_for(started.wait(), 2)
            shutdown = self.task(self.bridge.shutdown_model_refreshes())
            await asyncio.wait_for(cancelled.wait(), 2)
            shutdown.cancel()
            second_shutdown = self.task(self.bridge.shutdown_model_refreshes())
            await asyncio.sleep(0)
            self.assertFalse(shutdown.done())
            self.assertFalse(second_shutdown.done())
            cleanup_release.set()
            outcomes = await asyncio.wait_for(
                asyncio.gather(waiter, shutdown, second_shutdown, return_exceptions=True), 2
            )
            self.assertIsInstance(outcomes[0], asyncio.CancelledError)
            self.assertIsInstance(outcomes[1], asyncio.CancelledError)
            self.assertIsNone(outcomes[2])
            run.assert_awaited_once()
            self.assertNotIn("models", self.bridge._CALL_CACHE)

    @skipUnless(os.name == "nt", "Windows process-tree cleanup contract")
    async def test_shutdown_reaps_real_cli_parent_and_child(self):
        # Only _run is adapted. The original _run still owns subprocess creation,
        # cancellation, taskkill and communicate; no sockets or paid CLI are used.
        real_run = self.bridge._run
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.WaitForSingleObject.restype = ctypes.c_ulong
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            pids_path = Path(temp_dir) / "pids.json"
            parent_code = (
                "import json,os,subprocess,sys,time; "
                "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                f"open({str(pids_path)!r},'w',encoding='utf-8').write("
                "json.dumps([os.getpid(),child.pid])); time.sleep(30)"
            )

            async def python_cli(*args, **kwargs):
                # cli_path remains real: its cached executable is the process boundary.
                return await real_run("-c", parent_code, timeout=30)

            saved_cli = self.bridge._CLI_PATH
            self.bridge._CLI_PATH = sys.executable
            handles, pids = [], []
            try:
                with patch.object(self.bridge, "_run", new=AsyncMock(side_effect=python_cli)):
                    waiter = self.task(self.bridge.list_models())
                    for _ in range(200):
                        if pids_path.exists():
                            try:
                                pids = json.loads(pids_path.read_text(encoding="utf-8"))
                                break
                            except json.JSONDecodeError:
                                pass
                        await asyncio.sleep(0.01)
                    self.assertEqual(len(pids), 2, "test CLI parent and child did not start")
                    for pid in pids:
                        handle = kernel32.OpenProcess(0x00100000, False, pid)
                        self.assertTrue(handle, "could not observe test process")
                        handles.append(handle)
                    await asyncio.wait_for(self.bridge.shutdown_model_refreshes(), 12)
                    with self.assertRaises(asyncio.CancelledError):
                        await waiter
                    for handle in handles:
                        self.assertEqual(kernel32.WaitForSingleObject(handle, 0), 0)
                    with self.assertRaises(self.bridge.CLIError):
                        await self.bridge.list_models()
            finally:
                self.bridge._CLI_PATH = saved_cli
                for pid, handle in zip(pids, handles):
                    if kernel32.WaitForSingleObject(handle, 0) == 0x102:
                        subprocess.run(
                            ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                            check=False,
                        )
                    kernel32.CloseHandle(handle)
