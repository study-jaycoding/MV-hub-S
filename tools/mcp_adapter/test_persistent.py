"""Real stdio SDK, DPAPI and two clients against a non-generating local HTTP fixture."""
import json
import base64
import os
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
from server import Broker, MAX_RESPONSE, MAX_RESULT_RESPONSE


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
                    result = await client.call_tool("get_result", {"plan_id": "p", "item_index": 1})
                    self.assertFalse(result.is_error)
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
        anyio.run(exercise)
        self.assertTrue(all(body["method"] == "get_result" for _, body in self.http.calls))

    def test_preview_response_limit_does_not_widen_other_actions(self):
        config, _ = self.profile()
        broker = Broker(self.url, config["args"][-1])
        with patch.object(broker, "require_hub"), patch.object(broker, "request", return_value={}) as request:
            broker.action("get_result", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESULT_RESPONSE)
            broker.action("get_plan", {})
            self.assertEqual(request.call_args.kwargs["maximum"], MAX_RESPONSE)
        self.http.result_value = {"data": "x" * (MAX_RESULT_RESPONSE + 1)}
        with self.assertRaises(ToolError):
            broker.action("get_result", {})


if __name__ == "__main__":
    unittest.main()
