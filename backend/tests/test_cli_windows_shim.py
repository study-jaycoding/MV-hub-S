"""F-C-01 — 허브가 npm 셰임(higgsfield.cmd)을 cmd.exe 로 실행하면 인자의 & | 가 명령으로 읽힌다.

셰임 옆 패키지의 JS 를 node 로 직접 실행하고, 못 찾으면 셰임으로 되돌아가지 않아야 한다.
실제 Higgsfield CLI 는 쓰지 않는다 — 가짜 셰임·가짜 JS·(있으면) 이 PC 의 node 로만 본다.
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, skipUnless
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

_JS_REL = Path("node_modules") / "@higgsfield" / "cli" / "bin" / "higgsfield.js"
# 예전처럼 셰임이 실행되면 이 글자가 찍힌다(인자를 출력하지 않는 고정 셰임).
_SHIM_TEXT = "@echo off\r\necho MVHUB_SHIM_RAN\r\n"
_FAKE_JS = r"""
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.MVHUB_FAKE_ARGV_LOG) fs.appendFileSync(process.env.MVHUB_FAKE_ARGV_LOG, JSON.stringify(argv) + '\n');
if (argv[0] === 'spawn-tree') {
  const { spawn } = require('child_process');
  const code = 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(argv[1]) + ', "leaked"), 2000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  fs.writeFileSync(argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
  setTimeout(() => {}, 30000);
} else if (argv[0] === 'generate' && argv[1] === 'cost') {
  process.stdout.write(JSON.stringify({ credits_exact: 1.5 }));
} else {
  process.stdout.write(JSON.stringify(argv));
}
"""
_SYSTEM_NODE = shutil.which("node.exe") if os.name == "nt" else None


def _make_npm_dir(root: Path, *, shim: str = "higgsfield.cmd", with_js: bool = True) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    shim_path = root / shim
    shim_path.write_bytes(_SHIM_TEXT.encode("ascii"))
    if with_js:
        js = root / _JS_REL
        js.parent.mkdir(parents=True, exist_ok=True)
        js.write_text(_FAKE_JS, encoding="utf-8")
    return shim_path


@skipUnless(os.name == "nt", "Windows npm 셰임(.cmd) 계약")
class CliWindowsShimTests(IsolatedAsyncioTestCase):
    def setUp(self):
        from app.services import cli_bridge

        self.bridge = cli_bridge
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        # 한글·공백 경로 — 따옴표 처리·인코딩이 깨지면 여기서 드러난다.
        self.root = Path(self._tmp.name) / "한글 경로"
        self._saved_cli = cli_bridge._CLI_PATH

    def tearDown(self):
        self.bridge._CLI_PATH = self._saved_cli
        self._tmp.cleanup()

    @skipUnless(_SYSTEM_NODE, "이 PC 에 node.exe 가 없다")
    async def test_windows_cli_arguments_are_literal(self):
        bridge = self.bridge
        bridge._CLI_PATH = str(_make_npm_dir(self.root / "npm"))
        cases = [
            ("model", "get", "dummy&echo.MVHUB_PROBE&rem", "--json"),
            ("model", "get", "dummy|echo.MVHUB_PROBE", "--json"),
            ("generate", "create", "--prompt", 'a "b" <<<image1>>> 100%PATH% ^x', "--json"),
        ]
        for args in cases:
            out = await bridge._run(*args, timeout=30)
            lines = [line.strip() for line in out.splitlines()]
            self.assertNotIn("MVHUB_PROBE", lines, f"인자가 명령으로 실행됨: {args!r}")
            self.assertNotIn("MVHUB_SHIM_RAN", out, "셰임(.cmd)이 실행됨")
            self.assertEqual(json.loads(out), list(args))

        # 견적 옵션 값도 같은 _run 을 지난다(estimate_cost → _param_args → _run_json).
        log = Path(self._tmp.name) / "argv.log"
        bridge._COST_CACHE.clear()
        bridge._cost_loaded = True
        bridge._estimate_gates.clear()
        bridge._cost_write_locks.clear()
        bridge._PARAM_NAMES_CACHE["fake_model"] = {"resolution"}
        try:
            with patch.dict(os.environ, {"MVHUB_FAKE_ARGV_LOG": str(log)}), patch.object(
                bridge, "_write_cost_cache", new=lambda payload: True
            ):
                result = await bridge.estimate_cost(
                    "fake_model", {"resolution": "1080p&echo.MVHUB_PROBE&rem"}, prompt="a|b"
                )
        finally:
            bridge._COST_CACHE.clear()
            bridge._PARAM_NAMES_CACHE.pop("fake_model", None)
        self.assertEqual(result, {"credits": 1.5})
        sent = json.loads(log.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(sent[sent.index("--resolution") + 1], "1080p&echo.MVHUB_PROBE&rem")
        self.assertEqual(sent[sent.index("--prompt") + 1], "a|b")

    async def test_unresolved_shim_never_executes_batch(self):
        bridge = self.bridge
        no_js = _make_npm_dir(self.root / "no-js", with_js=False)
        no_node = _make_npm_dir(self.root / "no-node")
        unknown = _make_npm_dir(self.root / "other", shim="hf.bat", with_js=False)
        real_which = shutil.which

        def which_without_node(name, *a, **kw):
            return None if name.lower().startswith("node") else real_which(name, *a, **kw)

        for shim in (no_js, no_node, unknown):
            bridge._CLI_PATH = str(shim)
            spawn = AsyncMock(side_effect=AssertionError("CLI 프로세스를 띄우면 안 된다"))
            with self.subTest(shim=shim.parent.name), patch.object(
                bridge.shutil, "which", side_effect=which_without_node
            ), patch.object(bridge.asyncio, "create_subprocess_exec", new=spawn):
                self.assertFalse(bridge.cli_available())
                with self.assertRaises(bridge.CLIError):
                    await bridge._run("model", "list", "--json", timeout=5)
                spawn.assert_not_called()

    async def test_cli_argv_prefers_shim_node_then_bundle_runtime_then_path(self):
        bridge = self.bridge
        # 전역 npm — 셰임 옆 node.exe 가 먼저
        npm = _make_npm_dir(self.root / "npm-local-node")
        (npm.parent / "node.exe").write_bytes(b"")
        bridge._CLI_PATH = str(npm)
        self.assertEqual(bridge.cli_argv(), [str(npm.parent / "node.exe"), str(npm.parent / _JS_REL)])

        # 릴리스 번들 — runtime\higgsfield\higgsfield.cmd + runtime\node\node.exe
        install = self.root / "설치 폴더"
        shim = _make_npm_dir(install / "runtime" / "higgsfield")
        bundled_node = install / "runtime" / "node" / "node.exe"
        bundled_node.parent.mkdir(parents=True)
        bundled_node.write_bytes(b"")
        bridge._CLI_PATH = str(shim)
        with patch.object(bridge.shutil, "which", return_value=r"C:\elsewhere\node.exe"):
            self.assertEqual(bridge.cli_argv(), [str(bundled_node), str(shim.parent / _JS_REL)])

        # 둘 다 없으면 PATH 의 node.exe(셰임 .cmd 가 아닌 실행 파일 이름으로 찾는다)
        plain = _make_npm_dir(self.root / "npm-path-node")
        bridge._CLI_PATH = str(plain)
        path_node = self.root / "path-node" / "node.exe"
        path_node.parent.mkdir(parents=True)
        path_node.write_bytes(b"")
        with patch.object(bridge.shutil, "which", return_value=str(path_node)) as which:
            self.assertEqual(bridge.cli_argv(), [str(path_node), str(plain.parent / _JS_REL)])
        which.assert_called_with("node.exe")

        # 독립 실행 파일은 그대로 실행한다
        bridge._CLI_PATH = sys.executable
        self.assertEqual(bridge.cli_argv(), [sys.executable])
        self.assertTrue(bridge.cli_available())

    @skipUnless(_SYSTEM_NODE, "이 PC 에 node.exe 가 없다")
    async def test_cancelled_node_cli_kills_the_child_process_tree(self):
        bridge = self.bridge
        bridge._CLI_PATH = str(_make_npm_dir(self.root / "npm"))
        work = Path(self._tmp.name)
        marker, pids_path = work / "grandchild-survived.txt", work / "pids.json"
        pids: dict[str, int] = {}
        task = asyncio.create_task(bridge._run("spawn-tree", str(marker), str(pids_path), timeout=30))
        try:
            for _ in range(250):
                if pids_path.exists():
                    pids = json.loads(pids_path.read_text(encoding="utf-8"))
                    break
                await asyncio.sleep(0.02)
            self.assertTrue(pids, "가짜 node CLI 가 시작되지 않음")
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.sleep(2.3)
            self.assertFalse(marker.exists(), "취소된 CLI 의 node 자식이 살아남음")
        finally:
            if not task.done():
                task.cancel()
            for pid in pids.values():
                os.system(f"taskkill /PID {int(pid)} /T /F >NUL 2>&1")


class ModelIdCheckTests(IsolatedAsyncioTestCase):
    async def test_model_id_check_rejects_shell_and_option_values(self):
        from app.routers import generation
        from app.services import cli_bridge

        bad_ids = (
            "dummy&echo.MVHUB_PROBE&rem", "dummy|echo", "a b", "-x", "--json", "x\n", "x\t",
            'x"', "x^", "x%PATH%", "x<y", "x>y", "", "x" * 200,
        )
        run_json = AsyncMock(return_value={"params": [{"name": "prompt"}]})
        cli_bridge._CALL_CACHE.clear()
        with patch.object(cli_bridge, "_run_json", new=run_json):
            for bad in bad_ids:
                with self.subTest(bad=bad):
                    with self.assertRaises(HTTPException) as route_err:
                        await generation.model_params(bad)
                    self.assertEqual(route_err.exception.status_code, 422)
                    with self.assertRaises(HTTPException) as cost_err:
                        await generation.estimate_cost(generation.CostIn(model=bad))
                    self.assertEqual(cost_err.exception.status_code, 422)
                    # 라우트를 거치지 않는 호출자(견적 기록·MCP 견적)도 브리지에서 막힌다.
                    with self.assertRaises(cli_bridge.CLIError):
                        await cli_bridge.get_model_params(bad)
                    with self.assertRaises(cli_bridge.CLIError):
                        await cli_bridge.estimate_cost(bad)
                    self.assertFalse(cli_bridge.valid_model_id(bad))
            run_json.assert_not_called()
        self.assertFalse(cli_bridge.valid_model_id(None))
        # 실제 카탈로그 id(2026-10 로컬 DB 15종의 꼴)와 기존 시험의 id 는 통과한다.
        for good in ("seedance_2_0", "nano_banana_flash", "gpt_image_2_5", "model-0", "v1.2:x/y"):
            self.assertTrue(cli_bridge.valid_model_id(good), good)
