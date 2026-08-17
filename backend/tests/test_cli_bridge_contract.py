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

        self.assertEqual(results, [{"credits": 7}] * 100)
        self.assertLessEqual(peak, cli_bridge._ESTIMATE_CONCURRENCY)
        self.assertEqual(peak, min(100, cli_bridge._ESTIMATE_CONCURRENCY))
        self.assertEqual(len(cache_snapshots[-1]), 100)

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
