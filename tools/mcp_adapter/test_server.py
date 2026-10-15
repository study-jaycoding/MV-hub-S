"""Run with the isolated MCP Python: python tools/mcp_adapter/test_server.py."""

import json
import os
from pathlib import Path
import sys
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from uuid import uuid4

import anyio
from mcp import Client, StdioServerParameters
from mcp.server.mcpserver.exceptions import ToolError

from server import Broker, MAX_REQUEST, MAX_RESPONSE, local_url


class FakeBroker(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.calls.append((self.path, payload))
        secret = self.headers.get("X-MVHub-MCP-Secret")
        if self.headers.get("X-MVHub-MCP") != "1" or not secret:
            return self.reply(403, {})
        if self.path == "/api/mcp/client/connect":
            self.server.secret = secret
            return self.reply(200, {"client_id": "client-test", "pair_code": "123456", "paired": self.server.paired,
                                    "can_execute": self.server.can_execute})
        if secret != self.server.secret or not self.server.paired:
            return self.reply(401, {"error": "private backend detail"})
        if self.path != "/api/mcp/client/action":
            return self.reply(404, {})
        if payload["method"] == "execute_generation_plan" and not self.server.can_execute:
            return self.reply(409, {"detail": "execution_not_granted: private backend detail"})
        request_id = str(uuid4())
        self.server.results[request_id] = {"method": payload["method"], "args": payload["args"]}
        self.reply(200, {"id": request_id})

    def do_GET(self):
        self.server.gets.append(self.path)
        if self.path == "/api/health":
            self.server.health_credentials.append(self.headers.get("X-MVHub-MCP-Secret"))
            return self.reply(200, self.server.health)
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", self.server.url + "/sink")
            self.end_headers()
            return
        if self.path == "/oversized":
            return self.reply(200, {"value": "x" * MAX_RESPONSE})
        if self.path == "/secret":
            return self.reply(200, {"secret": self.headers["X-MVHub-MCP-Secret"]})
        if self.path == "/invalid":
            return self.reply(200, [1, 2, 3])
        if self.path.startswith("/api/mcp/client/result?id="):
            if self.headers.get("X-MVHub-MCP-Secret") != self.server.secret:
                return self.reply(403, {})
            result = self.server.results.get(self.path.split("=", 1)[1])
            if result is None:
                return self.reply(404, {})
            return self.reply(200, {"status": "done", "result": result})
        self.reply(200, {})


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), FakeBroker)
        self.http.url = f"http://127.0.0.1:{self.http.server_port}"
        self.http.calls = []
        self.http.gets = []
        self.http.results = {}
        self.http.secret = None
        self.http.paired = False
        self.http.can_execute = False
        self.http.health = {"mcp_bridge": {"protocol": 1, "transport": "stdio-local"}}
        self.http.health_credentials = []
        self.worker = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.worker.join(timeout=3)

    def test_url_rejects_remote_dns_credentials_and_ambiguous_targets(self):
        for url in ["http://example.com:8010", "http://localhost:8010", "http://192.168.1.171:8010", "http://127.0.0.1.evil:8010", "http://user:password@127.0.0.1:8010", "http://127.0.0.1:8010/path", "http://127.0.0.1:8010?x=1", "http://127.0.0.1:8010#x", "https://127.0.0.1:8010", "http://127.0.0.1:0", "http://127.0.0.1:\n8010"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                local_url(url)
        self.assertEqual(local_url("http://[::1]:8012/"), "http://[::1]:8012")

    def test_proxy_redirect_limits_and_secret_protection(self):
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": ""}):
            broker = Broker(self.http.url)
            self.assertEqual(broker.connect()["pair_code"], "123456")
        for path in ["/redirect", "/oversized", "/secret", "/invalid"]:
            with self.subTest(path=path), self.assertRaises(ToolError) as error:
                broker.request(path)
            self.assertNotIn(broker.secret, str(error.exception))
        self.assertNotIn("/sink", self.http.gets)
        count = len(self.http.calls)
        with self.assertRaises(ToolError):
            broker.request("/api/mcp/client/action", {"value": "x" * MAX_REQUEST})
        self.assertEqual(len(self.http.calls), count)

    def test_uncertain_post_is_not_retried(self):
        broker = Broker(self.http.url)
        for method in ("request_execution", "execute_generation_plan"):
            with self.subTest(method=method):
                with patch.object(broker, "require_hub"), patch.object(broker.opener, "open", side_effect=TimeoutError) as send:
                    with self.assertRaises(ToolError):
                        broker.action(method, {"plan_id": "example"})
                self.assertEqual(send.call_count, 1)
                self.assertEqual(send.call_args.args[0].get_method(), "POST")

    def test_execution_grant_and_sanitized_denial(self):
        broker = Broker(self.http.url)
        self.assertFalse(broker.connect()["can_execute"])
        self.http.paired = True
        with self.assertRaises(ToolError) as error:
            broker.action("execute_generation_plan", {"plan_id": "test"})
        message = str(error.exception)
        self.assertIn("실행", message)
        self.assertIn("연결", message)
        self.assertNotIn("private backend detail", message)
        self.assertNotIn(broker.secret, message)
        self.http.can_execute = True
        self.assertTrue(broker.connect()["can_execute"])
        self.assertEqual(broker.action("execute_generation_plan", {"plan_id": "test"}),
                         {"method": "execute_generation_plan", "args": {"plan_id": "test"}})

    def test_poll_expiry_and_bad_response_do_not_resubmit(self):
        broker = Broker(self.http.url)
        with patch.object(broker, "request", side_effect=[self.http.health, {"id": str(uuid4())}, {"status": "pending"}]) as send:
            with patch("server.time.monotonic", side_effect=[0, 0, 91, 91]):
                with self.assertRaises(ToolError):
                    broker.action("get_plan", {"plan_id": "test"})
        self.assertEqual(send.call_count, 3)
        with patch.object(broker, "request", side_effect=[self.http.health, {"id": "x&secret=bad"}]):
            with self.assertRaises(ToolError):
                broker.action("get_plan", {})

    def test_wrong_app_never_receives_credentials_or_post(self):
        broker = Broker(self.http.url)
        self.http.health = {"status": "ok"}
        self.assertEqual(broker.check_connection()["status"], "wrong_app")
        for invoke in [broker.connect, lambda: broker.action("get_plan", {"plan_id": "old"})]:
            with self.assertRaises(ToolError):
                invoke()
        self.assertEqual(self.http.calls, [])
        self.assertTrue(self.http.health_credentials)
        self.assertTrue(all(value is None for value in self.http.health_credentials))

    def test_unavailable_probe_does_not_pair_and_url_is_required(self):
        broker = Broker(self.http.url)
        with patch.object(broker.opener, "open", side_effect=TimeoutError) as send:
            self.assertEqual(broker.check_connection()["status"], "unavailable")
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.http.calls, [])
        process = subprocess.run([sys.executable, str(Path(__file__).with_name("server.py"))],
                                 capture_output=True, timeout=10)
        self.assertEqual(process.returncode, 2)
        self.assertIn(b"--url", process.stderr)

    def test_capability_allows_extra_fields_but_not_wrong_protocol(self):
        broker = Broker(self.http.url)
        self.http.health["mcp_bridge"]["description"] = "future optional metadata"
        self.assertEqual(broker.check_connection()["status"], "available")
        for version in [True, "1", 2, None]:
            self.http.health["mcp_bridge"]["protocol"] = version
            with self.subTest(version=version):
                self.assertEqual(broker.check_connection()["status"], "wrong_app")
        self.assertEqual(self.http.calls, [])

    def test_real_sdk_stdio_tools_pairing_plan_and_approval_request(self):
        async def exercise():
            params = StdioServerParameters(
                command=sys.executable,
                args=[str(Path(__file__).with_name("server.py")), "--url", self.http.url],
            )
            with anyio.fail_after(30):
                async with Client(params) as client:
                    tools = await client.list_tools()
                    self.assertEqual({t.name for t in tools.tools}, {"check_connection", "connect", "read_context", "prepare_generation_plan", "get_plan", "request_execution", "execute_generation_plan"})
                    execution = next(t for t in tools.tools if t.name == "execute_generation_plan")
                    annotations = execution.annotations.model_dump(by_alias=True)
                    self.assertFalse(annotations["readOnlyHint"])
                    self.assertTrue(annotations["destructiveHint"])
                    self.assertTrue(annotations["openWorldHint"])
                    self.assertFalse(annotations["idempotentHint"])
                    probe = await client.call_tool("check_connection", {})
                    self.assertEqual(probe.structured_content["status"], "available")
                    self.assertEqual(self.http.calls, [])
                    denied = await client.call_tool("read_context", {})
                    self.assertTrue(denied.is_error)
                    connected = await client.call_tool("connect", {})
                    self.assertEqual(connected.structured_content["pair_code"], "123456")
                    self.assertFalse(connected.structured_content["paired"])
                    self.assertFalse(connected.structured_content["can_execute"])
                    self.assertEqual(connected.structured_content["status"], "waiting_for_pairing")
                    self.assertNotIn(self.http.secret, str(connected))
                    still_denied = await client.call_tool("read_context", {})
                    self.assertTrue(still_denied.is_error)
                    self.assertNotIn("private backend detail", str(still_denied))
                    self.http.paired = True
                    context = await client.call_tool("read_context", {"kind": "scene", "limit": 5})
                    self.assertFalse(context.is_error)
                    self.assertEqual(context.structured_content["method"], "read_context")
                    item = {"label": "장면 010", "prompt": "테스트", "model": "mock-model", "params": {}, "reference_ids": [], "project_id": "p1", "folder_path": "cut-010"}
                    before = len(self.http.calls)
                    bad = await client.call_tool("prepare_generation_plan", {"title": "plan", "context_id": "context-1", "items": [{**item, "depends_on": ["other"]}]})
                    self.assertTrue(bad.is_error)
                    excessive = await client.call_tool("read_context", {"limit": 51})
                    self.assertTrue(excessive.is_error)
                    long_prompt = await client.call_tool("prepare_generation_plan", {"title": "plan", "context_id": "context-1", "items": [{**item, "prompt": "x" * 4001}]})
                    self.assertTrue(long_prompt.is_error)
                    long_context = await client.call_tool("prepare_generation_plan", {"title": "plan", "context_id": "x" * 121, "items": [item]})
                    self.assertTrue(long_context.is_error)
                    for folder in ("", "x" * 501):
                        invalid_folder = await client.call_tool("prepare_generation_plan", {"title": "plan", "context_id": "context-1", "items": [{**item, "folder_path": folder}]})
                        self.assertTrue(invalid_folder.is_error)
                    self.assertEqual(len(self.http.calls), before)
                    plan = await client.call_tool("prepare_generation_plan", {"title": "plan", "context_id": "context-1", "items": [item]})
                    self.assertFalse(plan.is_error)
                    self.assertEqual(plan.structured_content["args"]["items"][0]["label"], "장면 010")
                    state = await client.call_tool("get_plan", {"plan_id": "plan-1"})
                    self.assertFalse(state.is_error)
                    requested = await client.call_tool("request_execution", {"plan_id": "plan-1"})
                    self.assertFalse(requested.is_error)
                    self.assertEqual(requested.structured_content, {"method": "request_execution", "args": {"plan_id": "plan-1"}})
                    denied_execution = await client.call_tool("execute_generation_plan", {"plan_id": "plan-1"})
                    self.assertTrue(denied_execution.is_error)
                    self.assertNotIn("private backend detail", str(denied_execution))
                    self.http.can_execute = True
                    connected = await client.call_tool("connect", {})
                    self.assertTrue(connected.structured_content["can_execute"])
                    executed = await client.call_tool("execute_generation_plan", {"plan_id": "plan-1"})
                    self.assertFalse(executed.is_error)
                    self.assertEqual(executed.structured_content,
                                     {"method": "execute_generation_plan", "args": {"plan_id": "plan-1"}})
                    self.assertTrue(all(path in {"/api/mcp/client/connect", "/api/mcp/client/action"} for path, _ in self.http.calls))
                    self.assertNotIn(self.http.secret, json.dumps(self.http.calls))
                    self.assertNotIn(self.http.secret, json.dumps(self.http.gets))
                    self.assertTrue(all(value is None for value in self.http.health_credentials))
        anyio.run(exercise)


if __name__ == "__main__":
    unittest.main()
