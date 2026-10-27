"""가격·스키마의 기존값 즉답, 갱신 경합, 실패·종료 보존 계약."""

import asyncio
import time
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch


class MetadataRefreshTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.services import cli_bridge

        self.bridge = cli_bridge
        self.saved = {
            name: dict(getattr(cli_bridge, name))
            for name in ("_CALL_CACHE", "_COST_CACHE", "_PARAM_NAMES_CACHE", "_PARAM_NAMES_SAVED_AT", "_PARAM_NAMES_RETRY_AT")
        }
        for name in self.saved:
            getattr(cli_bridge, name).clear()
        self.was_loaded = cli_bridge._cost_loaded
        cli_bridge._cost_loaded = True
        self.writer = patch.object(cli_bridge, "_ensure_cost_writer")
        self.writer.start()
        self.dirty = patch.object(cli_bridge, "_mark_cost_cache_dirty")
        self.dirty.start()
        cli_bridge.start_model_refreshes()

    async def asyncTearDown(self):
        await self.bridge.shutdown_model_refreshes()
        for name, snapshot in self.saved.items():
            getattr(self.bridge, name).clear()
            getattr(self.bridge, name).update(snapshot)
        self.bridge._cost_loaded = self.was_loaded
        self.writer.stop()
        self.dirty.stop()

    def seed_cost(self):
        self.bridge._PARAM_NAMES_CACHE["model"] = {"quality"}
        self.key = self.bridge._cost_key("model", ["--quality", "high"])
        self.old_time = time.time() - self.bridge._COST_TTL - 60
        self.bridge._COST_CACHE[self.key] = (2.5, self.old_time)

    def seed_params(self):
        self.old_schema = {"job_set_type": "model", "type": "image", "params": [{"name": "old"}],
                           "saved_at": time.time() - 7200, "stale": False}
        self.bridge._CALL_CACHE["params:model"] = (time.monotonic() - 7200, self.old_schema)
        self.bridge._PARAM_NAMES_CACHE["model"] = {"old"}
        self.bridge._PARAM_NAMES_SAVED_AT["model"] = time.monotonic() - 7200

    async def test_cost_stale_returns_before_refresh_and_fresh_waiters_join(self):
        self.seed_cost()
        started, finish = asyncio.Event(), asyncio.Event()

        async def slow(*args, **kwargs):
            started.set()
            await finish.wait()
            return {"credits_exact": 3.75}

        with patch.object(self.bridge, "_run_json", new=AsyncMock(side_effect=slow)) as run:
            stale = await asyncio.wait_for(self.bridge.estimate_cost("model", {"quality": "high"}, allow_stale=True), .5)
            self.assertEqual(stale, {"credits": 2.5, "saved_at": self.old_time, "stale": True})
            await asyncio.wait_for(started.wait(), .5)
            waiters = [asyncio.create_task(self.bridge.estimate_cost("model", {"quality": "high"}, include_metadata=True)) for _ in range(3)]
            await asyncio.sleep(0)
            self.assertTrue(all(not task.done() for task in waiters))
            finish.set()
            results = await asyncio.gather(*waiters)
        self.assertEqual(run.await_count, 1)
        self.assertTrue(all(r["credits"] == 3.75 and not r["stale"] for r in results))
        self.assertEqual(len({r["saved_at"] for r in results}), 1)

    async def test_failed_cost_refresh_preserves_value_and_actual_timestamp(self):
        self.seed_cost()
        for response in (self.bridge.CLIError("offline"), {}, {"credits": -1}, {"credits": True}):
            with self.subTest(response=response):
                run = AsyncMock(side_effect=response) if isinstance(response, Exception) else AsyncMock(return_value=response)
                with patch.object(self.bridge, "_run_json", new=run):
                    result = await self.bridge.estimate_cost("model", {"quality": "high"}, include_metadata=True)
                self.assertEqual(result, {"credits": 2.5, "saved_at": self.old_time, "stale": True})
                self.assertEqual(self.bridge._COST_CACHE[self.key], (2.5, self.old_time))

    async def test_schema_stale_is_immediate_and_refresh_replaces_allowed_names(self):
        self.seed_params()
        started, finish = asyncio.Event(), asyncio.Event()

        async def slow(*args, **kwargs):
            started.set()
            await finish.wait()
            return {"job_type": "model", "type": "image", "params": [{"name": "new"}]}

        with patch.object(self.bridge, "_run_json", new=AsyncMock(side_effect=slow)) as run:
            old = await asyncio.wait_for(self.bridge.get_model_params("model", allow_stale=True), .5)
            self.assertTrue(old["stale"])
            self.assertEqual(old["saved_at"], self.old_schema["saved_at"])
            await asyncio.wait_for(started.wait(), .5)
            fresh = asyncio.create_task(self.bridge.get_model_params("model"))
            await asyncio.sleep(0)
            self.assertFalse(fresh.done())
            finish.set()
            result = await fresh
        self.assertEqual(run.await_count, 1)
        self.assertFalse(result["stale"])
        self.assertEqual(await self.bridge._allowed_param_names("model"), {"new"})
        self.assertGreater(result["saved_at"], self.old_schema["saved_at"])

    async def test_schema_failure_or_empty_keeps_old_schema_and_filter(self):
        self.seed_params()
        old_entry = self.bridge._CALL_CACHE["params:model"]
        for response in (self.bridge.CLIError("offline"), {"params": []}, {"params": ["invalid"]}, []):
            with self.subTest(response=response):
                run = AsyncMock(side_effect=response) if isinstance(response, Exception) else AsyncMock(return_value=response)
                with patch.object(self.bridge, "_run_json", new=run):
                    result = await self.bridge.get_model_params("model")
                self.assertTrue(result["stale"])
                self.assertEqual(result["params"], [{"name": "old"}])
                self.assertEqual(result["saved_at"], self.old_schema["saved_at"])
                self.assertEqual(self.bridge._CALL_CACHE["params:model"], old_entry)
                self.assertEqual(self.bridge._PARAM_NAMES_CACHE["model"], {"old"})

    async def test_expired_allowed_names_wait_for_current_schema(self):
        self.seed_params()
        with patch.object(self.bridge, "_run_json", new=AsyncMock(return_value={"params": [{"name": "new"}]})) as run:
            self.assertEqual(await self.bridge._allowed_param_names("model"), {"new"})
        self.assertEqual(run.await_count, 1)

    async def test_expired_name_lookup_keeps_internal_cost_behind_gate(self):
        self.seed_params()
        gate = self.bridge._estimate_gate()
        for _ in range(self.bridge._ESTIMATE_CONCURRENCY):
            await gate.acquire()
        task = None
        try:
            with patch.object(self.bridge, "_run_json", new=AsyncMock(side_effect=[
                {"params": [{"name": "new"}]}, {"credits": 2},
            ])) as run:
                task = asyncio.create_task(self.bridge.estimate_cost("model", {"new": "value"}))
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                run.assert_not_awaited()
                for _ in range(self.bridge._ESTIMATE_CONCURRENCY):
                    gate.release()
                self.assertEqual(await asyncio.wait_for(task, 1), {"credits": 2})
                self.assertEqual(run.await_count, 2)
        finally:
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            while gate._value < self.bridge._ESTIMATE_CONCURRENCY:
                gate.release()

    async def test_public_old_price_returns_even_when_gate_and_schema_are_stale(self):
        self.seed_params()
        key = self.bridge._cost_key("model", ["--old", "value"])
        saved_at = time.time() - self.bridge._COST_TTL - 60
        self.bridge._COST_CACHE[key] = (6, saved_at)
        gate = self.bridge._estimate_gate()
        for _ in range(self.bridge._ESTIMATE_CONCURRENCY):
            await gate.acquire()
        try:
            with patch.object(self.bridge, "_run_json", new=AsyncMock()) as run:
                result = await asyncio.wait_for(self.bridge.estimate_cost(
                    "model", {"old": "value"}, allow_stale=True,
                ), .5)
                self.assertEqual(result, {"credits": 6, "saved_at": saved_at, "stale": True})
                run.assert_not_awaited()
                await self.bridge.shutdown_model_refreshes()
        finally:
            for _ in range(self.bridge._ESTIMATE_CONCURRENCY):
                gate.release()

    async def test_shutdown_cancels_metadata_refreshes_and_refuses_new_ones(self):
        self.seed_cost()
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def slow(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        with patch.object(self.bridge, "_run_json", new=AsyncMock(side_effect=slow)) as run:
            await self.bridge.estimate_cost("model", {"quality": "high"}, allow_stale=True)
            await asyncio.wait_for(started.wait(), .5)
            await asyncio.wait_for(self.bridge.shutdown_model_refreshes(), .5)
            self.assertTrue(stopped.is_set())
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.estimate_cost("model", {"quality": "high"}, allow_stale=True)
            with self.assertRaises(self.bridge.CLIError):
                await self.bridge.get_model_params("model", allow_stale=True)
            self.assertEqual(run.await_count, 1)
        self.assertEqual(self.bridge._COST_CACHE[self.key], (2.5, self.old_time))

    async def test_internal_cost_response_keeps_legacy_shape(self):
        self.seed_cost()
        with patch.object(self.bridge, "_run_json", new=AsyncMock(return_value={"credits_exact": 4})):
            self.assertEqual(await self.bridge.estimate_cost("model", {"quality": "high"}), {"credits": 4})

    async def test_routes_choose_swr_or_explicit_fresh(self):
        from app.routers import generation

        with patch.object(self.bridge, "estimate_cost", new=AsyncMock(return_value={})) as cost:
            await generation.estimate_cost(generation.CostIn(model="model"))
            self.assertTrue(cost.call_args.kwargs["allow_stale"])
            self.assertTrue(cost.call_args.kwargs["include_metadata"])
            await generation.estimate_cost(generation.CostIn(model="model", fresh=True))
            self.assertFalse(cost.call_args.kwargs["allow_stale"])
            self.assertTrue(cost.call_args.kwargs["include_metadata"])
        with patch.object(self.bridge, "get_model_params", new=AsyncMock(return_value={})) as schema:
            await generation.model_params("model")
            self.assertTrue(schema.call_args.kwargs["allow_stale"])
            await generation.model_params("model", fresh=True)
            self.assertFalse(schema.call_args.kwargs["allow_stale"])

    async def test_cost_capacity_evicts_only_oldest_and_refresh_keeps_other_entries(self):
        self.bridge._COST_CACHE.update({"oldest": (1, 1), "keep": (2, 2)})
        with patch.object(self.bridge, "_COST_CACHE_MAX", 2), patch.object(
            self.bridge, "_run_json", AsyncMock(return_value={"credits": 3})
        ):
            await self.bridge._estimate_cost_miss("new", "model", [], "", 10)
            self.assertEqual(set(self.bridge._COST_CACHE), {"keep", "new"})
            self.assertEqual(self.bridge._COST_CACHE["keep"], (2, 2))
            new_entry = self.bridge._COST_CACHE["new"]
            await self.bridge._estimate_cost_miss("keep", "model", [], "", 10)
            self.assertEqual(set(self.bridge._COST_CACHE), {"keep", "new"})
            self.assertEqual(self.bridge._COST_CACHE["new"], new_entry)
