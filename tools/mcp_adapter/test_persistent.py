"""Real stdio SDK, DPAPI and two clients against a non-generating local HTTP fixture."""
import json
import base64
import os
import re
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
from mcp.server.mcpserver.exceptions import ToolError

from local_setup import configure_client
from server import Broker, MAX_RESPONSE, MAX_RESULT_RESPONSE, write_result_display, validate_display_directory


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.server.probes.append(self.headers.get("X-MVHub-MCP-Secret"))
        self.reply(200, {"mcp_bridge": {"protocol": 1, "transport": "stdio-local", "persistent_protocol": 2, "hub_id": self.server.hub_id}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append((self.path, body))
        client = self.server.clients.get(self.headers.get("X-MVHub-MCP-Secret"))
        if not client:
            return self.reply(403, {"private": "not returned"})
        if self.path == "/api/mcp/v2/client/connect":
            return self.reply(200, {"client_id": client, "can_execute": True, "workspace": {"scope": "personal"}})
        if self.path == "/api/mcp/v2/client/action":
            if body["method"] == "get_result":
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

    def profile(self):
        credential = {"secret": uuid4().hex + uuid4().hex, "hub_id": self.http.hub_id, "url": self.url, "client_id": str(uuid4())}
        result = configure_client("other", {"python": sys.executable, "adapter": str(Path(__file__).with_name("server.py")), "url": self.url}, credential, home=self.root, local_appdata=self.root)
        self.http.clients[credential["secret"]] = credential["client_id"]
        config = json.loads(result["config"])["mcpServers"]["mvhub"]
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
                    self.assertEqual(result.structured_content["hub_url"], self.url)
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
        with patch.object(broker, "require_hub"), patch.object(broker, "request", return_value={}) as request:
            broker.action("get_result", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESULT_RESPONSE)
            self.assertEqual(request.call_args.kwargs["timeout"], 90)
            broker.action("get_result", {"wait_seconds": 25})
            self.assertEqual(request.call_args.kwargs["timeout"], 115)
            broker.action("get_plan", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESPONSE)
            self.assertEqual(request.call_args.kwargs["timeout"], 90)
        self.http.result_value = {"data": "x" * (MAX_RESULT_RESPONSE + 1)}
        with self.assertRaises(ToolError):
            broker.action("get_result", {})

    def test_display_file_roundtrip_and_failures_keep_image(self):
        config, _ = self.profile()
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
                    self.assertEqual(pending.structured_content["display"]["status"], "unavailable")
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
                        display = result.structured_content["display"]
                        self.assertEqual(display["status"], "ready")
                        path = Path(display["path"])
                        files.append(path)
                        self.assertEqual(path.parent, output.resolve())
                        html = path.read_text(encoding="utf-8")
                        self.assertEqual(re.search(r"base64,([A-Za-z0-9+/=]+)", html).group(1), encoded)
                        self.assertEqual(result.content[1].data, encoded)
                        self.assertEqual(html.count("<img "), 1)
                        self.assertNotIn("<script", html)
                        self.assertNotIn("http", html)
                        self.assertLess(len(html.encode()), 1_000_000)
                        self.assertEqual(json.loads(result.content[0].text)["display"], display)
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
                    self.assertEqual(failed.structured_content["display"]["status"], "error")
                    self.assertEqual(failed.content[1].data, encoded)
        anyio.run(exercise)
        self.assertTrue(all(body["method"] == "get_result" for _, body in self.http.calls))

    def test_invalid_display_path_rejected_before_hub_request(self):
        config, _ = self.profile()
        regular = self.root / "regular.txt"
        regular.write_text("keep")
        async def exercise():
            with anyio.fail_after(30):
                async with Client(StdioServerParameters(**config)) as client:
                    for directory in ("relative", "C:relative", "\\rooted", "\\\\server\\share", "//server/share", "\\\\?\\C:\\", str(regular), str(self.root / "missing"), str(self.root) + "\x00", "x" * 1025):
                        result = await client.call_tool("get_result", {"plan_id": "p", "display_directory": directory})
                        self.assertTrue(result.is_error, repr(directory))
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


if __name__ == "__main__":
    unittest.main()
