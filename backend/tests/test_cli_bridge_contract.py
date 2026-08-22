"""고정 Higgsfield CLI 출력·프로세스 수명주기 계약의 작은 회귀 테스트."""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, skipUnless
from unittest.mock import AsyncMock, patch


class CliBridgeContractTests(IsolatedAsyncioTestCase):
    async def test_waiting_status_is_treated_as_pending(self):
        from app.services import cli_bridge

        self.assertEqual(cli_bridge.normalize_status("waiting"), "pending")

    async def test_model_get_accepts_cli_1_1_20_job_type(self):
        from app.services import cli_bridge

        cli_bridge._CALL_CACHE.clear()
        response = {
            "display_name": "Nano Banana Flash",
            "job_type": "nano_banana_flash",
            "type": "image",
            "params": [{"name": "prompt"}],
        }
        with patch.object(cli_bridge, "_run_json", new=AsyncMock(return_value=response)):
            result = await cli_bridge.get_model_params("nano_banana_flash")

        self.assertEqual(result["job_set_type"], "nano_banana_flash")
        self.assertEqual(result["params"], [{"name": "prompt"}])

    async def test_param_schema_failure_is_not_cached_forever(self):
        """RL-24 — CLI 일시 장애가 프로세스 수명 캐시로 굳으면 그 모델은 영영 필터 없이
        전송된다. 실패는 짧은 TTL 백오프 후 재조회돼야 한다."""
        from app.services import cli_bridge

        cli_bridge._PARAM_NAMES_CACHE.clear()
        cli_bridge._PARAM_NAMES_RETRY_AT.clear()
        ok = {"params": [{"name": "prompt"}, {"name": "seed"}]}
        calls = AsyncMock(side_effect=[cli_bridge.CLIError("cli 죽음"), ok])
        with patch.object(cli_bridge, "get_model_params", new=calls):
            # 1) 실패 → 빈 집합(필터 없음) + 백오프 기록, 캐시엔 안 들어감
            self.assertEqual(await cli_bridge._allowed_param_names("m1"), set())
            self.assertNotIn("m1", cli_bridge._PARAM_NAMES_CACHE)
            # 2) 백오프 중 재호출 — CLI 재기동 없이 빈 집합
            self.assertEqual(await cli_bridge._allowed_param_names("m1"), set())
            self.assertEqual(calls.await_count, 1)
            # 3) TTL 경과(백오프 만료 시뮬레이션) → 재조회 성공이 정상 캐시됨
            cli_bridge._PARAM_NAMES_RETRY_AT.clear()
            self.assertEqual(
                await cli_bridge._allowed_param_names("m1"), {"prompt", "seed"}
            )
            self.assertEqual(cli_bridge._PARAM_NAMES_CACHE["m1"], {"prompt", "seed"})
            # 4) 성공 캐시는 프로세스 수명 유지(추가 CLI 호출 없음)
            await cli_bridge._allowed_param_names("m1")
            self.assertEqual(calls.await_count, 2)
        cli_bridge._PARAM_NAMES_CACHE.clear()
        cli_bridge._PARAM_NAMES_RETRY_AT.clear()

    async def test_empty_fallback_schema_is_not_pinned_forever(self):
        """R5 2-C1(코덱스 적발) — 비-dict 응답의 빈 폴백 스키마가 _PARAM_NAMES_CACHE 에
        set() 으로 영구 박제되면 그 모델은 영영 '필터 없음'으로 굳는다. 실패와 같은
        백오프 TTL 후 재조회돼야 한다."""
        from app.services import cli_bridge

        cli_bridge._PARAM_NAMES_CACHE.clear()
        cli_bridge._PARAM_NAMES_RETRY_AT.clear()
        empty = {"job_set_type": "m2", "type": "image", "params": []}
        ok = {"params": [{"name": "seed"}]}
        calls = AsyncMock(side_effect=[empty, ok])
        with patch.object(cli_bridge, "get_model_params", new=calls):
            self.assertEqual(await cli_bridge._allowed_param_names("m2"), set())
            self.assertNotIn("m2", cli_bridge._PARAM_NAMES_CACHE)  # 박제 금지
            self.assertIn("m2", cli_bridge._PARAM_NAMES_RETRY_AT)  # 백오프로만 관리
            cli_bridge._PARAM_NAMES_RETRY_AT.clear()  # TTL 경과 시뮬레이션
            self.assertEqual(await cli_bridge._allowed_param_names("m2"), {"seed"})
        cli_bridge._PARAM_NAMES_CACHE.clear()
        cli_bridge._PARAM_NAMES_RETRY_AT.clear()

    async def test_concurrent_model_list_misses_join_single_cli_run(self):
        """R5 2-C1 — 동시 같은 miss M개는 CLI 1회에 합류하고, 실패는 그 대기자에게만
        전파(비캐시)돼 다음 호출이 새로 시도한다."""
        from app.services import cli_bridge

        cli_bridge._CALL_CACHE.clear()
        payload = json.dumps([{"display_name": "M", "job_type": "m", "type": "image"}])

        async def slow_run(*args, timeout=60.0):
            await asyncio.sleep(0.02)  # 합류 창 확보
            return payload

        with patch.object(cli_bridge, "_run", new=AsyncMock(side_effect=slow_run)) as run:
            results = await asyncio.gather(*(cli_bridge.list_models() for _ in range(5)))
            self.assertEqual(run.await_count, 1)  # CLI 실행 정확히 1회
            self.assertTrue(all(r == results[0] for r in results))
            self.assertEqual(results[0][0]["job_set_type"], "m")

        cli_bridge._CALL_CACHE.clear()
        failing = AsyncMock(side_effect=cli_bridge.CLIError("cli 죽음"))
        with patch.object(cli_bridge, "_run", new=failing):
            outcomes = await asyncio.gather(
                *(cli_bridge.list_models() for _ in range(3)), return_exceptions=True
            )
            self.assertTrue(all(isinstance(o, cli_bridge.CLIError) for o in outcomes))
            self.assertEqual(failing.await_count, 1)  # 실패도 합류는 1회
            with self.assertRaises(cli_bridge.CLIError):
                await cli_bridge.list_models()  # 실패 비캐시 — 다음 호출은 새로 시도
            self.assertEqual(failing.await_count, 2)
        cli_bridge._CALL_CACHE.clear()

    async def test_parse_job_null_workspace_key_keeps_batch_fallback(self):
        """`workspace: null` 처럼 값 없는 키만 실린 잡은 '잡 자체 명시'가 아니다 —
        검증된 배치 컨텍스트 폴백을 잃고 전부 unknown 이 되면 안 된다(RL-01 보강).
        빈 문자열 등 깨진 명시값은 종전대로 unknown(fail-closed)."""
        from app.services import cli_bridge

        base = {"id": "job-x", "status": "completed"}
        # null 키 → workspace 필드 자체가 없어야 배치 폴백이 산다
        parsed = cli_bridge.parse_job({**base, "workspace": None, "workspace_id": None})
        self.assertNotIn("workspace_scope", parsed["generation"])
        # 깨진 명시값(빈 문자열 아이디) → 명시로 취급하고 unknown 으로 좁힘
        parsed_broken = cli_bridge.parse_job({**base, "workspace_id": ""})
        self.assertEqual(parsed_broken["generation"].get("workspace_scope"), "unknown")

    async def test_estimate_cost_limits_concurrent_cli_processes(self):
        from app.services import cli_bridge

        active = 0
        peak = 0
        cache_snapshots = []

        async def fake_param_args(model, _params):
            return ["--variant", model]

        async def fake_run_json(*_args, **_kwargs):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.03)
            active -= 1
            return {"credits_exact": 7}

        def capture_cost_cache(payload):
            cache_snapshots.append(json.loads(payload))

        cli_bridge._COST_CACHE.clear()
        cli_bridge._cost_loaded = True
        cli_bridge._estimate_gates.clear()
        cli_bridge._cost_write_locks.clear()
        with patch.object(
            cli_bridge, "_param_args", new=AsyncMock(side_effect=fake_param_args)
        ), patch.object(
            cli_bridge, "_run_json", new=AsyncMock(side_effect=fake_run_json)
        ), patch.object(
            cli_bridge, "_write_cost_cache", side_effect=capture_cost_cache
        ):
            results = await asyncio.gather(
                *(
                    cli_bridge.estimate_cost(f"model-{index}")
                    for index in range(100)
                )
            )

            # R5 2-D: 저장은 debounce 백그라운드로 미뤄진다 — 종료 flush 가 잔여를 담는다.
            await cli_bridge.flush_cost_cache()

        self.assertEqual(results, [{"credits": 7}] * 100)
        self.assertLessEqual(peak, cli_bridge._ESTIMATE_CONCURRENCY)
        self.assertEqual(peak, min(100, cli_bridge._ESTIMATE_CONCURRENCY))
        self.assertEqual(len(cache_snapshots[-1]), 100)  # 모든 키가 결국 저장된다
        # 쓰기 증폭 제거 — 종전엔 신규 키마다 전체 저장(100회), 이제 burst 당 소수.
        self.assertLess(len(cache_snapshots), 10)

    async def test_estimate_cache_hit_returns_without_waiting_for_gate(self):
        """R5 2-C2 — '스키마가 CLI 없이 확정된' fresh 캐시 히트는 세마포어에 줄서지
        않는다. 종전엔 캐시 응답도 느린 CLI 견적 2건 뒤에서 대기했다."""
        import time as time_module

        from app.services import cli_bridge

        cli_bridge._COST_CACHE.clear()
        cli_bridge._cost_loaded = True
        cli_bridge._estimate_gates.clear()
        cli_bridge._PARAM_NAMES_CACHE["fast-model"] = {"variant"}
        key = cli_bridge._cost_key("fast-model", ["--variant", "x"])
        cli_bridge._COST_CACHE[key] = (11, time_module.time())

        gate = cli_bridge._estimate_gate()
        for _ in range(cli_bridge._ESTIMATE_CONCURRENCY):
            await gate.acquire()  # 게이트 만석 — 줄서면 아래 wait_for 가 시간초과
        try:
            result = await asyncio.wait_for(
                cli_bridge.estimate_cost("fast-model", {"variant": "x"}), timeout=0.5
            )
        finally:
            for _ in range(cli_bridge._ESTIMATE_CONCURRENCY):
                gate.release()
        self.assertEqual(result, {"credits": 11})
        cli_bridge._COST_CACHE.clear()
        cli_bridge._PARAM_NAMES_CACHE.pop("fast-model", None)

    async def test_same_cost_key_concurrent_misses_join_one_cli_run(self):
        """R5 2-C2 — 같은 (모델·옵션) 동시 miss 는 프롬프트가 달라도 CLI 1회에 합류
        (비용은 프롬프트 무관 계약)."""
        from app.services import cli_bridge

        cli_bridge._COST_CACHE.clear()
        cli_bridge._cost_loaded = True
        cli_bridge._estimate_gates.clear()
        cli_bridge._cost_write_locks.clear()
        cli_bridge._PARAM_NAMES_CACHE["join-model"] = {"variant"}

        async def slow_run_json(*_args, **_kwargs):
            await asyncio.sleep(0.03)
            return {"credits_exact": 5}

        with patch.object(
            cli_bridge, "_run_json", new=AsyncMock(side_effect=slow_run_json)
        ) as run, patch.object(cli_bridge, "_write_cost_cache", new=lambda payload: None):
            results = await asyncio.gather(
                *(
                    cli_bridge.estimate_cost(
                        "join-model", {"variant": "x"}, prompt=f"p{index}"
                    )
                    for index in range(6)
                )
            )
        self.assertEqual(results, [{"credits": 5}] * 6)
        self.assertEqual(run.await_count, 1)
        cli_bridge._COST_CACHE.clear()
        cli_bridge._PARAM_NAMES_CACHE.pop("join-model", None)

    async def test_cost_cache_write_failure_keeps_dirty_until_next_success(self):
        """R5 2-D — 쓰기 실패는 saved revision 을 올리지 않아 dirty 가 유지되고,
        다음 성공 저장(flush 포함)이 담아낸다."""
        from app.services import cli_bridge

        cli_bridge._cost_loaded = True
        cli_bridge._cost_write_locks.clear()
        baseline = cli_bridge._cost_saved_revision
        cli_bridge._mark_cost_cache_dirty()
        with patch.object(cli_bridge, "_COST_DEBOUNCE_SECONDS", 0.0), patch.object(
            cli_bridge, "_write_cost_cache", new=lambda payload: False
        ):
            cli_bridge._ensure_cost_writer()
            task = cli_bridge._cost_writer_tasks.get(asyncio.get_running_loop())
            await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(cli_bridge._cost_saved_revision, baseline)  # dirty 유지
        writes: list[str] = []
        with patch.object(
            cli_bridge, "_write_cost_cache", new=lambda payload: writes.append(payload) or True
        ):
            await cli_bridge.flush_cost_cache()
        self.assertEqual(len(writes), 1)
        self.assertEqual(
            cli_bridge._cost_saved_revision, cli_bridge._cost_dirty_revision
        )

    async def test_flush_serializes_with_inflight_writer_no_stale_overwrite(self):
        """코덱스 P1 — 진행 중 writer 의 과거 스냅샷이 종료 flush 의 최신 저장을 되덮는
        역전이 없어야 한다(flush 는 같은 write lock 으로 직렬화)."""
        import time as time_module

        from app.services import cli_bridge

        cli_bridge._cost_loaded = True
        cli_bridge._cost_write_locks.clear()
        writes: list[str] = []

        def slow_write(payload):
            time_module.sleep(0.05)  # rev1 쓰기를 느리게 — 그 사이 flush 진입 시도
            writes.append(payload)
            return True

        with patch.object(cli_bridge, "_COST_DEBOUNCE_SECONDS", 0.01), patch.object(
            cli_bridge, "_write_cost_cache", new=slow_write
        ):
            cli_bridge._COST_CACHE["k1"] = (1, 111.0)
            cli_bridge._mark_cost_cache_dirty()
            cli_bridge._ensure_cost_writer()
            await asyncio.sleep(0.03)  # writer 가 debounce 를 지나 쓰기에 들어가도록
            cli_bridge._COST_CACHE["k2"] = (2, 222.0)
            cli_bridge._mark_cost_cache_dirty()
            await cli_bridge.flush_cost_cache()
            task = cli_bridge._cost_writer_tasks.get(asyncio.get_running_loop())
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(writes)
        self.assertIn("k2", writes[-1])  # 마지막 기록이 최신 스냅샷(역전 없음)
        self.assertEqual(
            cli_bridge._cost_saved_revision, cli_bridge._cost_dirty_revision
        )
        cli_bridge._COST_CACHE.clear()

    async def test_cost_cache_burst_writes_collapse_to_last_snapshot(self):
        """R5 2-D — 같은 burst 의 writer K명은 마지막 스냅샷 1회만 기록한다."""
        from app.services import cli_bridge

        cli_bridge._cost_loaded = True
        cli_bridge._cost_write_locks.clear()
        writes: list[str] = []
        with patch.object(cli_bridge, "_COST_DEBOUNCE_SECONDS", 0.02), patch.object(
            cli_bridge, "_write_cost_cache", new=lambda payload: writes.append(payload) or True
        ):
            for _ in range(8):
                cli_bridge._mark_cost_cache_dirty()
                cli_bridge._ensure_cost_writer()  # 루프당 writer 1개만 유지된다
            task = cli_bridge._cost_writer_tasks.get(asyncio.get_running_loop())
            await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(len(writes), 1)  # burst 합류 — 전체 재직렬화 8회→1회

    async def test_estimate_cost_uses_stale_cache_when_cli_refresh_fails(self):
        from app.services import cli_bridge

        cli_bridge._COST_CACHE.clear()
        cli_bridge._COST_CACHE["model-a|--size=large"] = (9, 0.0)
        cli_bridge._cost_loaded = True
        cli_bridge._estimate_gates.clear()

        with patch.object(
            cli_bridge,
            "_param_args",
            new=AsyncMock(return_value=["--size", "large"]),
        ), patch.object(
            cli_bridge,
            "_run_json",
            new=AsyncMock(side_effect=cli_bridge.CLIError("temporary failure")),
        ):
            result = await cli_bridge.estimate_cost("model-a")

        self.assertEqual(result, {"credits": 9})

    async def test_timed_out_cli_call_terminates_and_reaps_process(self):
        from app.services import cli_bridge

        class HangingProcess:
            pid = 123
            returncode = None

            async def communicate(self):
                await asyncio.Event().wait()

        process = HangingProcess()
        terminate = AsyncMock()
        with patch.object(cli_bridge, "cli_path", return_value="higgsfield"), patch.object(
            cli_bridge.asyncio,
            "create_subprocess_exec",
            new=AsyncMock(return_value=process),
        ), patch.object(cli_bridge, "_terminate_cli_process", new=terminate):
            with self.assertRaisesRegex(cli_bridge.CLIError, "CLI 타임아웃"):
                await cli_bridge._run("model", "list", timeout=0.01)

        terminate.assert_awaited_once_with(process)

    @skipUnless(os.name == "nt", "Windows taskkill process-tree contract")
    async def test_cancelled_cli_call_kills_the_child_process_tree(self):
        from app.services import cli_bridge

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            root = Path(temp_dir)
            pids_path = root / "pids.json"
            leaked_marker = root / "grandchild-survived.txt"
            grandchild_code = (
                "import time; from pathlib import Path; "
                "time.sleep(2); "
                f"Path({str(leaked_marker)!r}).write_text('leaked', encoding='utf-8')"
            )
            parent_code = (
                "import json, os, subprocess, sys, time; "
                f"child=subprocess.Popen([sys.executable, '-c', {grandchild_code!r}]); "
                f"open({str(pids_path)!r}, 'w', encoding='utf-8').write("
                "json.dumps({'parent': os.getpid(), 'child': child.pid})); "
                "time.sleep(30)"
            )
            task = None
            pids: dict[str, int] = {}
            try:
                with patch.object(cli_bridge, "_CLI_PATH", sys.executable):
                    task = asyncio.create_task(
                        cli_bridge._run("-c", parent_code, timeout=30)
                    )
                    for _ in range(100):
                        if pids_path.exists():
                            pids = json.loads(pids_path.read_text(encoding="utf-8"))
                            break
                        await asyncio.sleep(0.02)
                    self.assertTrue(pids, "test CLI process did not start")
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                await asyncio.sleep(2.3)
                self.assertFalse(
                    leaked_marker.exists(),
                    "cancelled CLI left its grandchild process running",
                )
            finally:
                if task and not task.done():
                    task.cancel()
                for pid in pids.values():
                    subprocess.run(
                        ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
