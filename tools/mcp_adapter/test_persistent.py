"""Real stdio SDK, DPAPI and two clients against a non-generating local HTTP fixture."""
import json
import base64
import os
import re
import shutil
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from uuid import uuid4

import anyio
from mcp import Client, StdioServerParameters
from mcp.client import advertise
from mcp.server.mcpserver.exceptions import ToolError

from local_setup import configure_client
from server import Broker, HUB_FEATURES, ADAPTER_VERSION, MAX_RESPONSE, MAX_RESULT_RESPONSE, MAX_GALLERY_RESPONSE, RESULT_UI_URI, result_ui, write_result_display, validate_display_directory, present_result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, error_code=None):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Type", "application/json")
        if error_code is not None:
            self.send_header("X-MVHub-MCP-Error", error_code)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.server.probes.append(self.headers.get("X-MVHub-MCP-Secret"))
        self.reply(200, {"mcp_bridge": {"protocol": 1, "transport": "stdio-local", "persistent_protocol": 2, "hub_id": self.server.hub_id,
                    "features": getattr(self.server, "features", sorted(HUB_FEATURES))}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append((self.path, body))
        client = self.server.clients.get(self.headers.get("X-MVHub-MCP-Secret"))
        if not client:
            return self.reply(403, {"private": "not returned"})
        if self.path == "/api/mcp/v2/client/connect":
            return self.reply(200, {"client_id": client, "can_execute": True, "workspace": {"scope": "personal"}})
        if self.path == "/api/mcp/v2/client/action":
            failure = getattr(self.server, "failure", None)
            if failure:
                return self.reply(failure[0], {"detail": "private upstream error"}, failure[1])
            if body["method"] == "read_context" and body["args"].get("kind") == "models":
                return self.reply(200, {"models": [{"job_set_type": "nano_banana_flash", "display_name": "Nano Banana 2"}]})
            if body["method"] in {"execute_generation_plan", "get_plan"} and hasattr(self.server, "plan_value"):
                return self.reply(200, self.server.plan_value)
            if body["method"] in {"get_result", "get_generation", "show_results", "wait_results"}:
                callback = getattr(self.server, "before_result", None)
                if callback:
                    self.server.before_result = None
                    callback()
                return self.reply(200, self.server.result_value)
            return self.reply(200, {"method": body["method"], "args": body["args"]})
        self.reply(404, {})


@unittest.skipUnless(os.name == "nt", "Windows protected profile")
class PersistentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http.hub_id = "b" * 64
        self.http.clients, self.http.calls, self.http.probes = {}, [], []
        self.http.result_value = {"generation_status": "running", "media": None}
        self.url = f"http://127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(3)
        self.temp.cleanup()

    def profile(self, display_mode="native"):
        credential = {"secret": uuid4().hex + uuid4().hex, "hub_id": self.http.hub_id, "url": self.url, "client_id": str(uuid4())}
        result = configure_client("other", {"python": sys.executable, "adapter": str(Path(__file__).with_name("server.py")), "url": self.url}, credential, home=self.root, local_appdata=self.root)
        self.http.clients[credential["secret"]] = credential["client_id"]
        config = json.loads(result["config"])["mcpServers"]["mvhub"]
        if display_mode != "native":
            config["args"] += ["--display-mode", display_mode]
        return config, credential

    def test_profile_survives_new_adapter_and_revocation_is_immediate(self):
        config, credential = self.profile()
        path = config["args"][-1]
        for _ in range(2):
            broker = Broker(self.url, path)
            self.assertEqual(broker.connect()["client_id"], credential["client_id"])
            self.assertEqual(broker.action("read_context", {"kind": "workspace"})["method"], "read_context")
        self.http.clients.clear()
        with self.assertRaises(ToolError):
            broker.connect()
        self.assertNotIn(credential["secret"], json.dumps(self.http.calls))

    def test_wrong_hub_never_receives_profile_credential(self):
        config, _ = self.profile()
        broker = Broker(self.url, config["args"][-1])
        self.http.hub_id = "c" * 64
        self.assertEqual(broker.check_connection()["status"], "wrong_app")
        with self.assertRaises(ToolError):
            broker.connect()
        self.assertEqual(self.http.calls, [])
        self.assertTrue(all(value is None for value in self.http.probes))

    def test_real_sdk_two_clients_without_browser_or_codes(self):
        first, _ = self.profile()
        second, _ = self.profile()
        async def exercise():
            with anyio.fail_after(30):
                async with Client(StdioServerParameters(**first)) as one, Client(StdioServerParameters(**second)) as two:
                    for client in (one, two):
                        connected = await client.call_tool("connect", {})
                        self.assertFalse(connected.is_error)
                        self.assertNotIn("pair_code", connected.structured_content)
                        self.assertEqual(connected.structured_content["status"], "connected")
                        tools = await client.list_tools()
                        self.assertIn("add_to_canvas", {tool.name for tool in tools.tools})
                        context = await client.call_tool("read_context", {})
                        self.assertEqual(context.structured_content["args"]["kind"], "workspaces")
                        plan = await client.call_tool("prepare_generation_plan", {"title": "plain prompt", "workspace_scope": "team", "workspace_id": "team-one", "items": [{"label": "one", "prompt": "dolphin", "model": "mock", "params": {}}]})
                        self.assertFalse(plan.is_error)
                        self.assertEqual(plan.structured_content["args"]["workspace_id"], "team-one")
                        self.assertIsNone(plan.structured_content["args"]["items"][0]["project_id"])
                        bad = await client.call_tool("add_to_canvas", {"plan_id": "plan"})
                        self.assertTrue(bad.is_error)
                        attached = await client.call_tool("add_to_canvas", {"plan_id": "plan", "scene_id": "chosen-scene"})
                        self.assertFalse(attached.is_error)
        anyio.run(exercise)
        self.assertTrue(all(path.startswith("/api/mcp/v2/client/") for path, _ in self.http.calls))

    def test_real_sdk_image_content_and_text_only_pending(self):
        config, _ = self.profile()
        # Transport fixture only; real JPEG decoding is covered by backend/integration tests.
        jpeg = b"\xff\xd8\xff" + b"x" * MAX_RESPONSE + b"\xff\xd9"
        encoded = base64.b64encode(jpeg).decode("ascii")
        async def exercise():
            with anyio.fail_after(30):
                async with Client(StdioServerParameters(**config)) as client:
                    for state in ("running", "failed"):
                        self.http.result_value = {"generation_status": state, "media": None}
                        result = await client.call_tool("get_result", {"plan_id": "p"})
                        self.assertFalse(result.is_error)
                        self.assertEqual([block.type for block in result.content], ["text"])
                        self.assertEqual(result.structured_content["generation_status"], state)
                    self.http.result_value = {"generation_status": "done", "generation_id": "g", "media": {"mime": "image/jpeg", "data_base64": encoded}}
                    result = await client.call_tool("get_result", {"plan_id": "p", "item_index": 1, "wait_seconds": 25})
                    self.assertFalse(result.is_error)
                    self.assertEqual(self.http.calls[-1][1]["args"]["wait_seconds"], 25)
                    self.assertEqual([block.type for block in result.content], ["text", "image"])
                    self.assertEqual(base64.b64decode(result.content[1].data), jpeg)
                    self.assertEqual(result.content[1].mime_type, "image/jpeg")
                    self.assertNotIn("data_base64", result.content[0].text)
                    self.assertNotIn("media", result.structured_content)
                    self.assertNotIn("hub_url", result.structured_content)
                    self.assertNotIn(self.url, result.content[0].text)
                    for media in ({"mime": "image/svg+xml", "data_base64": encoded}, {"mime": "image/jpeg", "data_base64": "bad!"}):
                        self.http.result_value["media"] = media
                        rejected = await client.call_tool("get_result", {"plan_id": "p"})
                        self.assertTrue(rejected.is_error)
                        self.assertFalse(any(block.type == "image" for block in rejected.content))
                    bad_index = await client.call_tool("get_result", {"plan_id": "p", "item_index": -1})
                    self.assertTrue(bad_index.is_error)
                    for wait in (-1, 26, 1.5, True, "1"):
                        invalid_wait = await client.call_tool("get_result", {"plan_id": "p", "wait_seconds": wait})
                        self.assertTrue(invalid_wait.is_error)
        anyio.run(exercise)
        self.assertTrue(all(body["method"] == "get_result" for _, body in self.http.calls))

    def test_preview_response_limit_does_not_widen_other_actions(self):
        config, _ = self.profile()
        broker = Broker(self.url, config["args"][-1])
        with patch.object(broker, "check_connection", return_value={"status": "available", "hub_features": sorted(HUB_FEATURES)}), patch.object(broker, "request", return_value={}) as request:
            broker.action("get_result", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESULT_RESPONSE)
            self.assertEqual(request.call_args.kwargs["timeout"], 90)
            broker.action("show_results", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_GALLERY_RESPONSE)
            broker.action("wait_results", {"wait_seconds": 25})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESPONSE)
            self.assertEqual(request.call_args.kwargs["timeout"], 115)
            broker.action("get_result", {"wait_seconds": 25})
            self.assertEqual(request.call_args.kwargs["timeout"], 115)
            broker.action("get_plan", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESPONSE)
            self.assertEqual(request.call_args.kwargs["timeout"], 90)
        self.http.result_value = {"data": "x" * (MAX_RESULT_RESPONSE + 1)}
        with self.assertRaises(ToolError):
            broker.action("get_result", {})

    def test_display_file_roundtrip_and_failures_never_duplicate_image(self):
        config, _ = self.profile("conversation")
        output = self.root / "display"
        output.mkdir()
        encoded = base64.b64encode(b"\xff\xd8\xfftransport-fixture\xff\xd9").decode("ascii")
        async def exercise():
            with anyio.fail_after(30):
                async with Client(StdioServerParameters(**config)) as client:
                    tools = await client.list_tools()
                    tool = next(t for t in tools.tools if t.name == "get_result")
                    self.assertFalse(tool.annotations.read_only_hint)
                    self.assertFalse(tool.annotations.destructive_hint)
                    self.assertFalse(tool.annotations.idempotent_hint)
                    args = {"plan_id": "p", "wait_seconds": 25, "display_directory": str(output)}
                    pending = await client.call_tool("get_result", args)
                    self.assertEqual(pending.meta["display"]["status"], "unavailable")
                    self.assertEqual(list(output.iterdir()), [])
                    self.http.result_value = {"generation_status": "done", "media": {"mime": "image/jpeg", "data_base64": "bad!"}}
                    bad = await client.call_tool("get_result", args)
                    self.assertTrue(bad.is_error)
                    self.assertEqual(list(output.iterdir()), [])
                    self.http.result_value = {"generation_status": "done", "label": "<script>untrusted</script>", "media": {"mime": "image/jpeg", "data_base64": encoded}}
                    files = []
                    for _ in range(2):
                        result = await client.call_tool("get_result", args)
                        self.assertFalse(result.is_error)
                        display = result.meta["display"]
                        self.assertEqual(display["status"], "ready")
                        path = Path(display["path"])
                        files.append(path)
                        self.assertEqual(path.parent, output.resolve())
                        html = path.read_text(encoding="utf-8")
                        self.assertEqual(re.search(r"base64,([A-Za-z0-9+/=]+)", html).group(1), encoded)
                        self.assertFalse(any(c.type == "image" for c in result.content))
                        self.assertEqual(result.structured_content["delivery"]["mode"], "conversation")
                        self.assertEqual(html.count("<img "), 1)
                        self.assertNotIn("<script", html)
                        self.assertNotIn("http", html)
                        self.assertLess(len(html.encode()), 1_000_000)
                        self.assertEqual(json.loads(result.content[0].text)["display"], display)
                        self.assertEqual(result.structured_content["display"], display)
                        self.assertEqual(json.loads(display["reference"].removeprefix("visualize").removesuffix("")), {"path": path.as_posix()})
                        self.assertEqual(set(self.http.calls[-1][1]["args"]), {"plan_id", "item_index", "asset_index", "wait_seconds"})
                    self.assertNotEqual(*files)
                    self.assertTrue(all(p.exists() for p in files))
                    failing = self.root / "vanishing"
                    failing.mkdir()
                    self.http.before_result = failing.rmdir
                    failed = await client.call_tool("get_result", {**args, "display_directory": str(failing)})
                    self.assertFalse(failed.is_error)
                    self.assertEqual(failed.structured_content["generation_status"], "done")
                    self.assertEqual(failed.meta["display"]["status"], "error")
                    self.assertFalse(any(c.type == "image" for c in failed.content))
                    self.assertFalse(failed.structured_content["delivery"]["card_in_display"])
                    self.assertTrue(failed.structured_content["delivery"]["repeat_card_text"])
        anyio.run(exercise)
        self.assertTrue(all(body["method"] == "get_result" for _, body in self.http.calls))

    def test_invalid_display_path_rejected_before_hub_request(self):
        config, _ = self.profile("conversation")
        regular = self.root / "regular.txt"
        regular.write_text("keep")
        async def exercise():
            with anyio.fail_after(30):
                async with Client(StdioServerParameters(**config)) as client:
                    for name, args in (("get_result", {"plan_id": "p"}),
                                       ("show_results", {"plan_id": str(uuid4()), "item_indexes": [0]}),
                                       ("get_generation", {"generation_id": str(uuid4()), "workspace_scope": "personal"})):
                        for directory in ("relative", "C:relative", "\\rooted", "\\\\server\\share", "//server/share", "\\\\?\\C:\\", str(regular), str(self.root / "missing"), str(self.root) + "\x00", "x" * 1025):
                            result = await client.call_tool(name, {**args, "display_directory": directory})
                            self.assertTrue(result.is_error, (name, repr(directory)))
        anyio.run(exercise)
        self.assertEqual(self.http.calls, [])
        self.assertEqual(regular.read_text(), "keep")

    def test_display_does_not_overwrite_collision_or_leave_partial_file(self):
        output = self.root / "display"
        output.mkdir()
        existing = output / "mvhub-preview-fixed.html"
        existing.write_text("keep")
        with patch("server.secrets.token_hex", return_value="fixed"):
            with self.assertRaises(FileExistsError):
                write_result_display("data", output)
        self.assertEqual(existing.read_text(), "keep")
        original = Path.open
        def failing_open(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            stream.write = lambda _: (_ for _ in ()).throw(OSError("private error"))
            return stream
        with patch.object(Path, "open", failing_open):
            with self.assertRaises(OSError):
                write_result_display("data", output)
        self.assertEqual(list(output.iterdir()), [existing])

    def test_mapped_network_display_drive_is_rejected(self):
        with patch("ctypes.windll.kernel32.GetDriveTypeW", return_value=4):
            with self.assertRaises(ToolError):
                validate_display_directory(str(self.root))

    def test_common_card_distinguishes_scope_and_escapes_html(self):
        item = {"model": "test-model", "params": {"aspect_ratio": "16:9", "resolution": "1k", "prompt": "DO NOT DISPLAY"},
                "folder_path": "<script>alert(1)</script>", "project_id": "project"}
        metadata = {"presentation": {"version": 1, "scope": "plan", "message": "전체 계획 · 생성 중 · 완료 1/3"},
                    "workspace": {"scope": "team", "name": "<team>"}}
        plan = present_result({**metadata, "items": [item]})
        selected = present_result({**metadata, **item, "presentation": {
            "version": 1, "scope": "item", "item_index": 0, "message": "선택 항목 1 · 생성 완료 · 완료 1/1"}})
        self.assertNotEqual(plan["card_text"], selected["card_text"])
        self.assertIn("전체 계획", plan["card_text"])
        self.assertIn("선택 항목 1", selected["card_text"])
        self.assertEqual(plan["card_text"].splitlines()[1:], selected["card_text"].splitlines()[1:])
        self.assertNotIn("프로젝트 ID", selected["card_text"])
        self.assertNotIn("test-model", selected["card_text"])
        self.assertIn("저장 위치:", selected["card_text"])
        self.assertNotIn("DO NOT DISPLAY", selected["card_text"])
        saved = write_result_display("safe-base64", self.root, selected["card_text"])
        html = Path(saved["path"]).read_text(encoding="utf-8")
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertIn("&lt;team&gt;", html)
        self.assertEqual(saved["rendered"], "unverified")

    def test_friendly_card_preserves_partial_failures_and_ids_only_in_data(self):
        result = {"title": "바나나", "workspace": {"scope": "team", "id": "secret-id", "name": "작업실"},
                  "items": [{"model": "nano_banana_flash", "project_id": "internal-project-id", "folder_path": "e001/c0010",
                             "params": {"aspect_ratio": "16:9"}}],
                  "presentation": {"version": 1, "stage": "running", "scope": "plan",
                                   "details": {"total": 3, "completed": 1, "by_stage": {"failed": 1, "running": 1, "completed": 1}}}}
        card = present_result(result, {"nano_banana_flash": "Nano Banana 2"})["card_text"]
        for value in ("바나나 생성 중입니다.", "완료 1/3", "실패 1", "Nano Banana 2 · 16:9", "작업실 / e001/c0010"):
            self.assertIn(value, card)
        for value in ("nano_banana_flash", "internal-project-id", "secret-id"):
            self.assertNotIn(value, card)
        self.assertEqual(result["items"][0]["project_id"], "internal-project-id")

    def test_sdk_live_card_uses_read_only_results_and_catalog_on_new_session(self):
        config, _ = self.profile()
        plan = str(uuid4())
        item = {"label": "바나나", "model": "nano_banana_flash", "workspace": {"scope": "personal"},
                "params": {"aspect_ratio": "16:9"},
                "presentation": {"version": 1, "scope": "item", "stage": "completed", "item_index": 0},
                "media": {"mime": "image/jpeg", "data_base64": "/9j/eP/Z"}}
        self.http.result_value = {"items": [item], "all_terminal": True, "all_done": True}
        self.http.plan_value = {"plan_id": plan, "items": [{}]}
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                listing = {t.name: t for t in (await client.list_tools()).tools}
                self.assertNotIn("ui", listing["execute_generation_plan"].meta or {})
                reader = listing["read_display_results"]
                self.assertTrue(reader.annotations.read_only_hint)
                self.assertEqual(reader.meta["ui"]["visibility"], ["app"])
                self.assertNotIn("display_directory", reader.input_schema["properties"])
                before = set(self.root.rglob("*"))
                result = await client.call_tool("read_display_results", {"plan_id": plan, "item_indexes": [0]})
                self.assertFalse(result.is_error)
                self.assertIn("Nano Banana 2", result.structured_content["card_text"])
                self.assertEqual(set(self.root.rglob("*")), before)
                self.assertEqual(len([b for b in result.content if b.type == "image"]), 1)
                forbidden = await client.call_tool("read_display_results", {"plan_id": plan, "item_indexes": [0], "display_directory": str(self.root)})
                self.assertNotIn("display", forbidden.structured_content["items"][0])
                self.assertEqual(set(self.root.rglob("*")), before)
                executed = await client.call_tool("execute_generation_plan", {"plan_id": plan})
                self.assertNotIn("live_plan_id", executed.structured_content)
        anyio.run(exercise)
        self.assertEqual([b["method"] for _, b in self.http.calls], ["show_results", "read_context", "show_results", "execute_generation_plan"])

    def test_two_display_modes_get_identical_card_and_exactly_one_image_path(self):
        configs = [self.profile()[0], self.profile("conversation")[0]]
        self.http.result_value = {
            "generation_status": "done", "model": "test-model", "params": {"resolution": "1k"},
            "workspace": {"scope": "personal"}, "presentation": {"version": 1, "scope": "item", "stage": "completed", "message": "생성 완료 · 완료 1/1"},
            "media": {"mime": "image/jpeg", "data_base64": base64.b64encode(b"\xff\xd8\xffx\xff\xd9").decode()},
        }
        async def exercise():
            cards = []
            with anyio.fail_after(30):
                for index, cfg in enumerate(configs):
                    async with Client(StdioServerParameters(**cfg)) as client:
                        args = {"plan_id": "p"}
                        if index:
                            args["display_directory"] = str(self.root)
                        result = await client.call_tool("get_result", args)
                        self.assertFalse(result.is_error)
                        cards.append(result.structured_content["card_text"])
                        self.assertEqual(any(c.type == "image" for c in result.content), index == 0)
                        if index:
                            self.assertEqual(len(result.content), 1)
                            fragment = Path(result.meta["display"]["path"]).read_text(encoding="utf-8")
                            self.assertEqual(fragment.count(cards[-1]), 1)
                            self.assertLess(fragment.index('<img '), fragment.index('<p '))
                        else:
                            self.assertEqual(result.content[-1].text, cards[-1])
                            self.assertNotIn("display", result.structured_content)
                self.assertEqual(*cards)
        anyio.run(exercise)

    def test_real_sdk_result_app_resource_and_path_free_default(self):
        config, _ = self.profile()
        self.http.result_value = {"generation_status": "done", "media": {
            "mime": "image/jpeg", "data_base64": base64.b64encode(b"\xff\xd8\xfftest\xff\xd9").decode()}}
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                tools = await client.list_tools()
                tool = next(t for t in tools.tools if t.name == "get_result")
                self.assertEqual(tool.meta["ui"]["resourceUri"], RESULT_UI_URI)
                resource = await client.read_resource(RESULT_UI_URI)
                self.assertEqual(resource.contents[0].mime_type, "text/html;profile=mcp-app")
                self.assertEqual(resource.contents[0].text, result_ui())
                self.assertFalse(resource.contents[0].meta["ui"]["prefersBorder"])
                before = set(self.root.rglob("*"))
                result = await client.call_tool("get_result", {"plan_id": "p"})
                self.assertFalse(result.is_error)
                self.assertNotIn("display", result.meta or {})
                self.assertEqual(set(self.root.rglob("*")), before)
                self.assertEqual(sum(b.type == "image" for b in result.content), 1)
                self.assertNotIn("hub_url", result.structured_content)
                self.assertNotIn("display", result.structured_content)
        anyio.run(exercise)

    def test_sdk_capability_negotiation_and_old_hub_diagnosis(self):
        config, _ = self.profile()
        async def exercise():
            for supported in (False, True):
                extensions = [advertise("io.modelcontextprotocol/ui", {"mimeTypes": ["text/html;profile=mcp-app"]})] if supported else []
                async with Client(StdioServerParameters(**config), extensions=extensions) as client:
                    self.assertIn("io.modelcontextprotocol/ui", client.server_capabilities.extensions)
                    self.assertEqual(client.server_info.version, ADAPTER_VERSION)
                    resource = await client.read_resource(RESULT_UI_URI)
                    self.assertEqual(resource.contents[0].text, result_ui())
                    response = await client.call_tool("check_connection", {})
                    self.assertFalse(response.is_error)
                    info = response.structured_content
                    self.assertEqual(info["apps_negotiated"], supported)
                    self.assertEqual(info["adapter"], {"version": ADAPTER_VERSION, "tools": 14})
                    self.assertIsNone(info["reload_required"])
            self.http.features = []
            async with Client(StdioServerParameters(**config)) as client:
                response = await client.call_tool("check_connection", {})
                self.assertEqual(response.structured_content["status"], "available")
                self.assertEqual(response.structured_content["reload_required"], "hub")
                before = len(self.http.calls)
                refused = await client.call_tool("estimate_plan", {"plan_id": str(uuid4())})
                self.assertTrue(refused.is_error)
                self.assertEqual(refused.structured_content["error"]["code"], "hub_outdated")
                self.assertEqual(len(self.http.calls), before)
        anyio.run(exercise)

    def test_sdk_apps_import_fallback_keeps_native_images(self):
        config, _ = self.profile()
        self.http.result_value = {"media": {"mime": "image/jpeg", "data_base64": "/9j/eP/Z"}}
        original = config["args"]
        script = "import sys,runpy; sys.modules['mcp.server.apps']=None; sys.path.insert(0," + repr(str(Path(__file__).parent)) + "); sys.argv=" + repr(original) + "; runpy.run_path(sys.argv[0],run_name='__main__')"
        config["args"] = ["-c", script]
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                tools = await client.list_tools()
                self.assertEqual(len(tools.tools), 14)
                image = await client.call_tool("get_result", {"plan_id": "p"})
                self.assertFalse(image.is_error)
                self.assertTrue(any(b.type == "image" for b in image.content))
        anyio.run(exercise)

    def test_sdk_batch_wait_gallery_and_generation_selector(self):
        config, _ = self.profile()
        plan = str(uuid4())
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                tools = {t.name: t for t in (await client.list_tools()).tools}
                self.assertFalse((tools["wait_results"].meta or {}).get("ui"))
                self.assertEqual(tools["show_results"].meta["ui"]["resourceUri"], RESULT_UI_URI)
                self.http.result_value = {"items": [{"item_index": 0, "generation_status": "running"}], "all_terminal": False}
                waiting = await client.call_tool("wait_results", {"plan_id": plan, "item_indexes": [0]})
                self.assertFalse(waiting.is_error)
                self.assertFalse(any(b.type == "image" for b in waiting.content))
                self.http.result_value = {"items": [{"item_index": 0, "note": "failed", "media": None},
                    {"item_index": 1, "note": "done", "media": {"mime": "image/jpeg", "data_base64": "/9j/eP/Z"}}]}
                gallery = await client.call_tool("show_results", {"plan_id": plan, "item_indexes": [0, 1]})
                self.assertFalse(gallery.is_error)
                self.assertEqual(sum(b.type == "image" for b in gallery.content), 1)
                self.assertIsNone(gallery.structured_content["items"][0]["image_index"])
                self.assertEqual(gallery.structured_content["items"][1]["image_index"], 0)
                self.assertNotIn("media", gallery.structured_content["items"][1])
                self.http.result_value["items"][0]["media"] = {"mime": "image/jpeg", "data_base64": "bad!"}
                broken = await client.call_tool("show_results", {"plan_id": plan, "item_indexes": [0, 1]})
                self.assertFalse(broken.is_error)
                self.assertEqual(sum(b.type == "image" for b in broken.content), 1)
                self.assertIn("미리보기를 읽지 못했습니다", broken.structured_content["items"][0]["card_text"])
                for indexes in ([], list(range(9)), [-1], [True]):
                    bad = await client.call_tool("wait_results", {"plan_id": plan, "item_indexes": indexes})
                    self.assertTrue(bad.is_error)
                self.http.result_value = {"generation_id": plan, "media": {"mime": "image/jpeg", "data_base64": "/9j/eP/Z"}}
                one = await client.call_tool("get_generation", {"generation_id": plan, "workspace_scope": "personal"})
                self.assertFalse(one.is_error)
                self.assertEqual(self.http.calls[-1][1]["args"]["generation_id"], plan)
                page = await client.call_tool("read_context", {"kind": "generations", "workspace_scope": "personal",
                    "cursor_ts": 100.5, "cursor_id": "g", "folder_path": "e001/c0010", "media_type": "image"})
                self.assertFalse(page.is_error)
                self.assertEqual(page.structured_content["args"]["cursor_ts"], 100.5)
        anyio.run(exercise)

    def test_sdk_codex_gallery_and_generation_export_only_conversation_images(self):
        config, _ = self.profile("conversation")
        output = self.root / "display"
        output.mkdir()
        plan = str(uuid4())
        encoded = [base64.b64encode(b"\xff\xd8\xff" + bytes([i]) + b"\xff\xd9").decode() for i in range(2)]
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                tools = {t.name: t for t in (await client.list_tools()).tools}
                for name in ("get_result", "show_results", "get_generation"):
                    self.assertFalse(tools[name].annotations.read_only_hint)
                    self.assertFalse(tools[name].annotations.idempotent_hint)
                    self.assertIn("display_directory", tools[name].input_schema["properties"])
                self.http.result_value = {"items": [
                    {"item_index": 0, "generation_status": "failed", "media": None},
                    *[{"item_index": i + 1, "generation_status": "done", "media": {
                        "mime": "image/jpeg", "data_base64": data}} for i, data in enumerate(encoded)]]}
                args = {"plan_id": plan, "item_indexes": [0, 1, 2]}
                gallery = await client.call_tool("show_results", {**args, "display_directory": str(output)})
                self.assertFalse(gallery.is_error)
                items = gallery.structured_content["items"]
                self.assertEqual(gallery.structured_content["delivery"], {"mode": "conversation", "repeat_card_text": False})
                self.assertTrue(items[0]["delivery"]["repeat_card_text"])
                self.assertEqual(items[0]["display"]["status"], "unavailable")
                images = [b.data for b in gallery.content if b.type == "image"]
                self.assertEqual(images, [])
                self.assertEqual(len(list(output.iterdir())), 2)
                for item in items[1:]:
                    self.assertFalse(item["delivery"]["repeat_card_text"])
                    display = item["display"]
                    self.assertEqual(display["rendered"], "unverified")
                    path = Path(display["path"])
                    self.assertEqual(path.parent, output.resolve())
                    self.assertEqual(json.loads(display["reference"].removeprefix("visualize").removesuffix("")), {"path": path.as_posix()})
                    html = path.read_text(encoding="utf-8")
                    self.assertEqual(re.search(r"base64,([A-Za-z0-9+/=]+)", html).group(1), encoded[item["item_index"] - 1])
                    self.assertIsNone(item["image_index"])
                    self.assertLess(path.stat().st_size, 1_000_000)
                self.assertEqual(json.loads(gallery.content[0].text)["items"], items)
                self.assertNotIn("display_directory", self.http.calls[-1][1]["args"])
                self.http.result_value["items"][0]["media"] = {"mime": "image/jpeg", "data_base64": "bad!"}
                failing = self.root / "vanishing"
                failing.mkdir()
                self.http.before_result = failing.rmdir
                failed = await client.call_tool("show_results", {**args, "display_directory": str(failing)})
                self.assertFalse(failed.is_error)
                self.assertEqual([b.data for b in failed.content if b.type == "image"], images)
                self.assertEqual([i["display"]["status"] for i in failed.structured_content["items"]], ["unavailable", "error", "error"])
                self.assertTrue(all(i["delivery"]["repeat_card_text"] for i in failed.structured_content["items"]))
                self.http.result_value = {"generation_id": plan, "media": {"mime": "image/jpeg", "data_base64": encoded[0]}}
                one = await client.call_tool("get_generation", {"generation_id": plan, "workspace_scope": "personal", "display_directory": str(output)})
                self.assertFalse(one.is_error)
                self.assertEqual(one.structured_content["display"], one.meta["display"])
                self.assertEqual(one.structured_content["display"]["status"], "ready")
                self.assertEqual([b.data for b in one.content if b.type == "image"], [])
                self.assertNotIn("display_directory", self.http.calls[-1][1]["args"])
        anyio.run(exercise)
        self.assertEqual([body["method"] for _, body in self.http.calls], ["show_results"] * 2 + ["get_generation"])

    def test_conversation_has_no_ui_registration_or_live_card_even_with_apps_host(self):
        config, _ = self.profile("conversation")
        plan = str(uuid4())
        self.http.plan_value = {"plan_id": plan, "items": [{}]}
        async def exercise():
            async with Client(StdioServerParameters(**config), extensions=[advertise(
                    "io.modelcontextprotocol/ui", {"mimeTypes": ["text/html;profile=mcp-app"]})]) as client:
                listing = (await client.list_tools()).tools
                self.assertEqual(len(listing), 13)
                self.assertNotIn("read_display_results", [t.name for t in listing])
                self.assertTrue(all("ui" not in (t.meta or {}) for t in listing))
                self.assertEqual((await client.list_resources()).resources, [])
                info = (await client.call_tool("check_connection", {})).structured_content
                self.assertEqual(info["display_mode"], "conversation")
                self.assertEqual(info["adapter"]["tools"], 13)
                self.assertFalse(info["apps_available"])
                executed = await client.call_tool("execute_generation_plan", {"plan_id": plan})
                self.assertNotIn("live_plan_id", executed.structured_content)
        anyio.run(exercise)

    def test_display_mode_mismatch_fails_before_read_or_file_write(self):
        async def exercise():
            for mode in ("native", "conversation"):
                config, _ = self.profile(mode)
                async with Client(StdioServerParameters(**config)) as client:
                    for name, args in (("get_result", {"plan_id": "p"}),
                                       ("show_results", {"plan_id": str(uuid4()), "item_indexes": [0]}),
                                       ("get_generation", {"generation_id": str(uuid4()), "workspace_scope": "personal"})):
                        if mode == "native":
                            args["display_directory"] = str(self.root)
                        response = await client.call_tool(name, args)
                        self.assertTrue(response.is_error)
                        self.assertIn("다시 등록" if mode == "native" else "display_directory",
                                      response.content[0].text)
        anyio.run(exercise)
        self.assertEqual(self.http.calls, [])
        self.assertEqual(list(self.root.glob("*.html")), [])

    def test_sdk_gallery_handles_eight_maximum_bounded_previews(self):
        config, _ = self.profile()
        data = base64.b64encode(b"\xff\xd8\xff" + b"x" * (512 * 1024 - 5) + b"\xff\xd9").decode()
        self.http.result_value = {"items": [{"media": {"mime": "image/jpeg", "data_base64": data}} for _ in range(8)]}
        self.assertLess(len(json.dumps(self.http.result_value).encode()), MAX_GALLERY_RESPONSE)
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                result = await client.call_tool("read_display_results", {"plan_id": str(uuid4()), "item_indexes": list(range(8))})
                self.assertFalse(result.is_error)
                self.assertEqual([b.data for b in result.content if b.type == "image"], [data] * 8)
        anyio.run(exercise)

    def test_sdk_safe_errors_are_structured_and_do_not_replay(self):
        config, _ = self.profile()
        async def exercise():
            async with Client(StdioServerParameters(**config)) as client:
                for status, header, expected in ((409, "reference_changed", "reference_changed"),
                    (403, "execution_not_allowed", "execution_not_allowed"), (500, "private-header", "request_failed")):
                    self.http.failure = (status, header)
                    before = len(self.http.calls)
                    failed = await client.call_tool("execute_generation_plan", {"plan_id": "p"})
                    self.assertTrue(failed.is_error)
                    self.assertEqual(failed.structured_content["error"]["code"], expected)
                    self.assertFalse(failed.structured_content["error"]["retryable"])
                    self.assertNotIn("private", failed.content[0].text)
                    self.assertEqual(len(self.http.calls), before + 1)
        anyio.run(exercise)

    def test_result_app_handshake_and_untrusted_messages(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is required for the MCP Apps JavaScript check")
        script = r'''
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
(async () => {
const sent = [], handlers = {};
const timers = new Map(); let timerId = 0;
let now = 0;
const setTimeout = (fn, ms) => { timers.set(++timerId, {fn, ms}); return timerId; };
const clearTimeout = id => timers.delete(id);
let observer, disconnected = false;
const node = tag => ({tag, children: [], events: {}, textContent: '',
  setAttribute(name, value) {this[name] = value;},
  classList: {toggle() {this.expanded = !this.expanded; return this.expanded;}},
  append(child) {this.children.push(child); child.parent = this;},
  replaceChildren() {this.children = [];},
  addEventListener(name, fn) {this.events[name] = fn;},
  remove() {this.parent.children = this.parent.children.filter(c => c !== this);}});
const gallery = node('div'), status = node('p'), refresh = node('button');
const images = () => gallery.children.flatMap(f => f.children).filter(c => c.tag === 'img');
const parent = {postMessage: value => sent.push(value)};
const window = {parent, addEventListener: (name, fn) => handlers[name] = fn};
const document = {body: {getBoundingClientRect: () => ({height: 220})}, createElement: node,
  getElementById: name => ({gallery, status, refresh})[name]};
const ResizeObserver = class {
  constructor(fn) { observer = fn; }
  observe() { observer(); }
  disconnect() { disconnected = true; }
};
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {window, document, ResizeObserver, setTimeout, clearTimeout, Date: {now: () => now}});
const emit = (value, source = parent) => handlers.message({source, data: {jsonrpc: '2.0', ...value}});
assert.equal(sent[0].method, 'ui/initialize');
emit({id: 'mvhub-init', result: {protocolVersion: '2026-01-26'}}, {});
assert.equal(sent.length, 1);
emit({id: 'mvhub-init', result: {protocolVersion: '2026-01-26'}});
assert.equal(sent[1].method, 'ui/notifications/initialized');
assert.equal(sent[2].method, 'ui/notifications/size-changed');
observer(); assert.equal(sent.length, 3);
const data = '/9j/eP/Z';
const result = {structuredContent: {card_text: '<script>untrusted</script>'}, content: [{type: 'image', mimeType: 'image/jpeg', data}]};
emit({method: 'ui/notifications/tool-result', params: result}, {});
assert.equal(images().length, 0);
emit({method: 'ui/notifications/tool-result', params: result});
assert.equal(status.textContent, '<script>untrusted</script>');
assert.equal(images()[0].src, 'data:image/jpeg;base64,' + data);
for (const image of [null, {type: 'image', mimeType: 'image/svg+xml', data},
  {type: 'image', mimeType: 'image/jpeg', data: 'https://unsafe'},
  {type: 'image', mimeType: 'image/jpeg', data: '/9j/' + 'A'.repeat(699052)}]) {
  emit({method: 'ui/notifications/tool-result', params: {content: [image]}});
  assert.equal(images().length, 0);
}
emit({method: 'ui/notifications/tool-result', params: {...result, structuredContent: {items: [
  {card_text: 'failed', image_index: null}, {card_text: '<b>one</b>', image_index: 0}, {card_text: 'two', image_index: 0}]}}});
assert.equal(gallery.children.length, 3);
assert.equal(images().length, 2);
assert.equal(gallery.children[1].children[1].textContent, '<b>one</b>');
images()[0].events.error(); assert.equal(images().length, 1);
emit({method: 'ui/notifications/tool-result', params: {...result, isError: true}});
assert.equal(images().length, 0);
emit({method: 'ui/notifications/tool-result', params: result});
emit({method: 'ui/notifications/tool-cancelled'});
assert.equal(images().length, 0);
// A second host handshake enables the live card without granting generation access.
emit({method: 'ui/notifications/tool-result', params: {structuredContent: {
  live_plan_id: '11111111-1111-4111-8111-111111111111', items: [{}], card_text: '생성 대기 중'}}});
assert.ok(status.textContent.includes('자동 갱신을 지원하지 않습니다'));
assert.equal(sent.filter(m => m.method === 'tools/call').length, 0);
emit({method: 'ui/resource-teardown', id: 8});
emit({id: 'mvhub-init', result: {protocolVersion: '2026-01-26', hostCapabilities: {serverTools: {}}}});
const planId = '11111111-1111-4111-8111-111111111111';
const plan = {live_plan_id: planId, card_text: '생성 대기 중', items: Array(9).fill({}),
  presentation: {details: {by_stage: {queued: 9}}}};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const runTimer = () => {
  const entry = [...timers].find(([, t]) => t.ms === 2500);
  assert.ok(entry); timers.delete(entry[0]); entry[1].fn();
};
const respond = async result => { emit({id: sent.at(-1).id, result}); await flush(); };
emit({method: 'ui/notifications/tool-result', params: {structuredContent: plan}});
assert.equal(status.textContent, '생성 대기 중');
runTimer();
assert.equal(sent.at(-1).params.name, 'get_plan');
assert.equal([...timers.values()].filter(t => t.ms === 2500).length, 0); // no overlapping reads
await respond({structuredContent: {...plan, card_text: '생성 중', presentation: {details: {by_stage: {running: 9}}}}});
assert.equal(status.textContent, '생성 중');
runTimer();
await respond({structuredContent: {...plan, card_text: '완료 8/9 · 실패 1', presentation: {details: {by_stage: {completed: 8, failed: 1}}}}});
assert.equal(sent.at(-1).params.name, 'read_display_results');
assert.deepEqual(Array.from(sent.at(-1).params.arguments.item_indexes), [0,1,2,3,4,5,6,7]);
const batch = {structuredContent: {items: Array.from({length: 8}, (_, i) => ({image_index: i ? 0 : null, card_text: i ? '완료' : '실패'}))}, content: result.content};
await respond(batch);
assert.deepEqual(Array.from(sent.at(-1).params.arguments.item_indexes), [8]);
await respond({structuredContent: {items: [{image_index: 0, card_text: '완료'}]}, content: result.content});
assert.equal(gallery.children.length, 9); assert.equal(images().length, 8);
assert.equal(status.textContent, '완료 8/9 · 실패 1');
assert.equal(timers.size, 0);
assert.equal(refresh.hidden, false);
// Refresh only reads; a host denial stops polling and offers a safe retry.
refresh.events.click();
assert.equal(sent.at(-1).params.name, 'get_plan');
emit({id: sent.at(-1).id, error: {code: -1}}); await flush();
assert.equal(refresh.hidden, false); assert.equal(timers.size, 0);
assert.ok(status.textContent.includes('다시 생성하지 말고'));
refresh.events.click();
await respond({structuredContent: plan});
now = 601000;
runTimer(); await respond({structuredContent: plan});
assert.ok(status.textContent.includes('자동 확인을 잠시 멈췄습니다'));
assert.equal(timers.size, 0);
document.hidden = true;
const countBeforeHide = sent.length;
refresh.events.click(); await flush();
assert.equal(sent.length, countBeforeHide); assert.equal(timers.size, 0);
document.hidden = false;
refresh.events.click();
const lateId = sent.at(-1).id;
emit({method: 'ui/resource-teardown', id: 9});
emit({id: lateId, result: batch}); await flush();
assert.equal(images().length, 0); assert.equal(timers.size, 0);
assert.equal(disconnected, true); assert.equal(sent.at(-1).id, 9);
assert.ok(sent.filter(m => m.method === 'tools/call').every(m => ['get_plan', 'read_display_results'].includes(m.params.name)));
assert.ok(!html.includes('innerHTML') && !html.includes('fetch('));
})().catch(e => { console.error(e); process.exitCode = 1; });
'''
        checked = subprocess.run([node, "-e", script], input=json.dumps(result_ui()), text=True,
                                 capture_output=True, timeout=20)
        self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
