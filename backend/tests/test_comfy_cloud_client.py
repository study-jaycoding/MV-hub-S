"""Comfy Cloud 클라이언트/폴링 검증 — 외부 네트워크 없이 요청·상태 전이를 검증.

라이브 클라우드(api_key)에 접근하지 않고, 다음을 고정한다:
 · 제출 엔드포인트/헤더/body 형태(POST /api/prompt, X-API-Key, prompt·extra_data)
 · 상태/상세 라우트(/api/job/{id}/status, /api/jobs/{id})
 · 상태 전이(pending→completed) 완료, cancelled/error 즉시 실패, 미지 상태 타임아웃(마지막 상태 표면화)
 · 인증/크레딧 오류 분류(401/402/403), check_alive 는 200 만 alive
"""

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app.services import comfy_client
from app.routers import comfy


def _cloud_target(key="k-123"):
    return comfy_client.make_target({"comfy_target": "cloud", "comfy_api_key": key})


class MakeTargetTests(unittest.TestCase):
    def test_cloud_target_shape(self):
        t = _cloud_target()
        self.assertTrue(t["cloud"])
        self.assertEqual(t["base"], "https://cloud.comfy.org")
        self.assertEqual(t["prefix"], "/api")
        self.assertEqual(t["headers"]["X-API-Key"], "k-123")

    def test_url_join(self):
        self.assertEqual(comfy_client._url(_cloud_target(), "/prompt"),
                         "https://cloud.comfy.org/api/prompt")


class SubmitTests(unittest.TestCase):
    def test_submit_posts_prompt(self):
        calls = {}

        def fake(method, url, *, headers=None, json_body=None, data=None,
                 content_type=None, timeout=60):
            calls.update(method=method, url=url, headers=headers, json_body=json_body)
            return 200, b'{"prompt_id": "pid-1"}'

        with mock.patch.object(comfy_client, "_request", fake):
            pid = comfy_client.submit(_cloud_target(), {"1": {"class_type": "X"}}, api_key="k-9")
        self.assertEqual(pid, "pid-1")
        self.assertEqual(calls["method"], "POST")
        self.assertEqual(calls["url"], "https://cloud.comfy.org/api/prompt")
        self.assertEqual(calls["headers"]["X-API-Key"], "k-123")
        self.assertEqual(calls["json_body"]["prompt"], {"1": {"class_type": "X"}})
        self.assertEqual(calls["json_body"]["extra_data"]["api_key_comfy_org"], "k-9")

    def test_submit_auth_error_flags(self):
        for code in (401, 402, 403):
            with mock.patch.object(comfy_client, "_request", lambda *a, **k: (code, b"nope")):
                with self.assertRaises(comfy_client.ComfyError) as cm:
                    comfy_client.submit(_cloud_target(), {"1": {}})
            self.assertTrue(cm.exception.auth_error, f"{code} 는 auth_error 여야 함")

    def test_submit_missing_prompt_id(self):
        with mock.patch.object(comfy_client, "_request", lambda *a, **k: (200, b"{}")):
            with self.assertRaises(comfy_client.ComfyError):
                comfy_client.submit(_cloud_target(), {"1": {}})

    def test_submit_unsupported_node_friendly_message(self):
        body = (b'{"error":{"message":"Invalid workflow: unsupported node type '
                b'\'SaveText|pysssss\'","type":"VALIDATION_ERROR"}}')
        with mock.patch.object(comfy_client, "_request", lambda *a, **k: (400, body)):
            with self.assertRaises(comfy_client.ComfyError) as cm:
                comfy_client.submit(_cloud_target(), {"1": {"class_type": "SaveText|pysssss"}})
        msg = str(cm.exception)
        self.assertIn("SaveText|pysssss", msg)
        self.assertIn("Local", msg)


class StreamingUploadTests(unittest.TestCase):
    def test_upload_file_streams_bounded_chunks_with_exact_length(self):
        seen = {}

        def fake_request(
            method,
            url,
            *,
            headers=None,
            json_body=None,
            data=None,
            content_type=None,
            content_length=None,
            timeout=60,
        ):
            chunk_sizes = []
            total = 0
            for chunk in data:
                chunk_sizes.append(len(chunk))
                total += len(chunk)
            seen.update(
                method=method,
                url=url,
                content_type=content_type,
                content_length=content_length,
                total=total,
                chunk_sizes=chunk_sizes,
            )
            return 200, b'{"name":"stored.bin","subfolder":"mvhub"}'

        with TemporaryDirectory() as d:
            source = Path(d) / "large.bin"
            source.write_bytes(b"x" * (2 * 1024 * 1024 + 17))
            with mock.patch.object(comfy_client, "_request", fake_request):
                name = comfy_client.upload_file(
                    {
                        "cloud": False,
                        "base": "http://127.0.0.1:8188",
                        "prefix": "",
                        "headers": {},
                    },
                    "large.bin",
                    source,
                )

        self.assertEqual(name, "mvhub/stored.bin")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["total"], seen["content_length"])
        # 파일 구간은 1MiB 이하이며, 작은 multipart 머리·꼬리만 별도 조각이다.
        self.assertLessEqual(max(seen["chunk_sizes"]), 1024 * 1024)
        self.assertIn("multipart/form-data", seen["content_type"])

    def test_upload_filename_cannot_inject_headers(self):
        captured = {}

        def fake_request(*_args, data=None, **_kwargs):
            captured["body"] = b"".join(data)
            return 200, b'{}'

        with TemporaryDirectory() as d:
            source = Path(d) / "x"
            source.write_bytes(b"x")
            with mock.patch.object(comfy_client, "_request", fake_request):
                comfy_client.upload_file(
                    {"cloud": False, "base": "http://x", "prefix": "", "headers": {}},
                    'bad"\r\nX-Evil: yes.png',
                    source,
                )
        self.assertNotIn(b"\r\nX-Evil:", captured["body"])

    def test_real_urllib_sends_iterable_with_content_length(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                remaining = int(self.headers["Content-Length"])
                received["content_length"] = remaining
                received["transfer_encoding"] = self.headers.get("Transfer-Encoding")
                total = 0
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    total += len(chunk)
                    remaining -= len(chunk)
                received["total"] = total
                body = json.dumps({"name": "stored.bin", "subfolder": "mvhub"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with TemporaryDirectory() as d:
                source = Path(d) / "large.bin"
                source.write_bytes(b"x" * (2 * 1024 * 1024 + 17))
                name = comfy_client.upload_file(
                    {
                        "cloud": False,
                        "base": f"http://127.0.0.1:{server.server_port}",
                        "prefix": "",
                        "headers": {},
                    },
                    "large.bin",
                    source,
                )
        finally:
            worker.join(timeout=5)
            server.server_close()

        self.assertFalse(worker.is_alive())
        self.assertEqual(name, "mvhub/stored.bin")
        self.assertEqual(received["total"], received["content_length"])
        self.assertIsNone(received["transfer_encoding"])


class UnsupportedNodeMessageTests(unittest.TestCase):
    def test_extracts_node_name(self):
        m = comfy_client._unsupported_node_message(
            '{"error":{"message":"unsupported node type \'ShowText|pysssss\'"}}')
        self.assertIsNotNone(m)
        self.assertIn("ShowText|pysssss", m)

    def test_plain_string_error(self):
        m = comfy_client._unsupported_node_message(
            "Invalid workflow: unsupported node type 'FooBar'")
        self.assertIsNotNone(m)
        self.assertIn("FooBar", m)

    def test_none_for_other_errors(self):
        self.assertIsNone(comfy_client._unsupported_node_message(
            '{"error":{"message":"insufficient credits"}}'))
        self.assertIsNone(comfy_client._unsupported_node_message("some random 500 error"))


class DownloadViewStreamingTests(unittest.TestCase):
    """R5 2-F — 출력 파일 저장은 chunk 스트리밍 + .part→os.replace(실패 시 기존 dst 보존)."""

    def _local_target(self, port: int) -> dict:
        return {
            "cloud": False,
            "base": f"http://127.0.0.1:{port}",
            "prefix": "",
            "headers": {},
        }

    def test_streams_to_part_then_replaces_atomically(self):
        payload = b"v" * (3 * 1024 * 1024 + 5)  # 청크(1MB) 경계 비배수

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with TemporaryDirectory() as d:
                dst = Path(d) / "out" / "clip.mp4"
                comfy_client.download_view(
                    self._local_target(server.server_port),
                    {"filename": "clip.mp4", "type": "output"},
                    dst,
                )
                self.assertEqual(dst.read_bytes(), payload)
                self.assertEqual(list(dst.parent.glob("*.part")), [])  # 임시파일 정리
        finally:
            worker.join(timeout=5)
            server.server_close()

    def test_failure_preserves_existing_destination_and_cleans_part(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(500)
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"boom")

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.handle_request, daemon=True)
        worker.start()
        try:
            with TemporaryDirectory() as d:
                dst = Path(d) / "clip.mp4"
                dst.write_bytes(b"previous-good")  # 이전 성공본
                with self.assertRaises(comfy_client.ComfyError):
                    comfy_client.download_view(
                        self._local_target(server.server_port),
                        {"filename": "clip.mp4", "type": "output"},
                        dst,
                    )
                self.assertEqual(dst.read_bytes(), b"previous-good")  # dst 보존
                self.assertEqual(list(dst.parent.glob("*.part")), [])
        finally:
            worker.join(timeout=5)
            server.server_close()


class ObjectInfoSingleFlightTests(unittest.TestCase):
    """R5 2-E — 수 MB object_info 의 동시 miss 는 leader 1명만 내려받는다."""

    def setUp(self):
        comfy_client._OBJECT_INFO_CACHE.clear()
        comfy_client._object_info_waits.clear()

    tearDown = setUp

    def test_concurrent_misses_download_once(self):
        target = _cloud_target()
        calls: list[float] = []

        def slow_get(_target, path, timeout=30):
            calls.append(time.time())
            time.sleep(0.05)  # 합류 창 — 직렬화 없으면 스레드 전부 진입
            return {"NodeA": {"input": {}}}

        results = []
        with mock.patch.object(comfy_client, "_get_json", side_effect=slow_get):
            threads = [
                threading.Thread(
                    target=lambda: results.append(comfy_client.get_object_info(target))
                )
                for _ in range(5)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(len(calls), 1)  # 대형 다운로드 정확히 1회
        self.assertEqual(len(results), 5)
        self.assertTrue(all(r == {"NodeA": {"input": {}}} for r in results))
        self.assertEqual(comfy_client._object_info_waits, {})  # in-flight 회수

    def test_leader_failure_releases_waiters_and_is_not_cached(self):
        target = _cloud_target()
        attempts: list[int] = []

        def flaky_get(_target, path, timeout=30):
            attempts.append(1)
            if len(attempts) == 1:
                time.sleep(0.03)
                raise comfy_client.ComfyError("일시 장애")
            return {"NodeA": {}}

        outcomes: list[object] = []

        def run():
            try:
                outcomes.append(comfy_client.get_object_info(target))
            except comfy_client.ComfyError as exc:
                outcomes.append(exc)

        with mock.patch.object(comfy_client, "_get_json", side_effect=flaky_get):
            threads = [threading.Thread(target=run) for _ in range(3)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        # leader 1명은 실패(예외), waiter 는 해제 후 재시도로 성공 — 고아 대기 없음
        errors = [o for o in outcomes if isinstance(o, comfy_client.ComfyError)]
        successes = [o for o in outcomes if o == {"NodeA": {}}]
        self.assertEqual(len(errors), 1)
        self.assertEqual(len(successes), 2)
        self.assertEqual(comfy_client._object_info_waits, {})

    def test_force_refresh_bypasses_join_and_empty_dict_is_not_cached(self):
        target = _cloud_target()
        with mock.patch.object(comfy_client, "_get_json", return_value={}):
            self.assertEqual(comfy_client.get_object_info(target, use_cache=False), {})
        self.assertEqual(comfy_client._OBJECT_INFO_CACHE, {})  # 빈 dict 비캐시


class SubscriptionTierCacheTests(unittest.TestCase):
    """R5 comfy-1 — 일시 실패로 만든 None 은 캐시하지 않는다(회복 즉시 자기치유)."""

    def setUp(self):
        comfy_client._SUBSCRIPTION_CACHE.clear()

    def tearDown(self):
        comfy_client._SUBSCRIPTION_CACHE.clear()

    def test_transient_error_is_not_cached_and_recovers_immediately(self):
        target = _cloud_target()
        with mock.patch.object(
            comfy_client, "_get_json", side_effect=comfy_client.ComfyError("탈락")
        ):
            self.assertIsNone(comfy_client.get_subscription_tier(target))
        self.assertEqual(comfy_client._SUBSCRIPTION_CACHE, {})  # 실패값 미캐시
        with mock.patch.object(
            comfy_client,
            "_get_json",
            return_value={"workspaces": [{"subscription_tier": "PRO"}]},
        ) as get_json:
            self.assertEqual(comfy_client.get_subscription_tier(target), "PRO")
            # 정상 응답은 캐시 — 같은 target 재조회는 네트워크 없이 즉시
            self.assertEqual(comfy_client.get_subscription_tier(target), "PRO")
            get_json.assert_called_once()

    def test_normal_response_without_tier_is_cached_none(self):
        target = _cloud_target()
        with mock.patch.object(
            comfy_client, "_get_json", return_value={"workspaces": []}
        ) as get_json:
            self.assertIsNone(comfy_client.get_subscription_tier(target))
            self.assertIsNone(comfy_client.get_subscription_tier(target))
            get_json.assert_called_once()  # '정말 등급 없음'은 종전대로 캐시

    def test_malformed_response_is_not_cached(self):
        target = _cloud_target()
        with mock.patch.object(comfy_client, "_get_json", return_value="broken"):
            self.assertIsNone(comfy_client.get_subscription_tier(target))
        self.assertEqual(comfy_client._SUBSCRIPTION_CACHE, {})  # 형식 깨짐도 미캐시


class StatusRouteTests(unittest.TestCase):
    def test_status_and_detail_routes(self):
        seen = []

        def fake(method, url, *, headers=None, json_body=None, data=None,
                 content_type=None, timeout=60):
            seen.append(url)
            if url.endswith("/status"):
                return 200, b'{"status": "in_progress"}'
            return 200, b'{"outputs": {}}'

        with mock.patch.object(comfy_client, "_request", fake):
            st = comfy_client.cloud_job_status(_cloud_target(), "pid")
            comfy_client.cloud_job_detail(_cloud_target(), "pid")
        self.assertEqual(st, "in_progress")
        self.assertIn("https://cloud.comfy.org/api/job/pid/status", seen)
        self.assertIn("https://cloud.comfy.org/api/jobs/pid", seen)


class ErrorMessageTests(unittest.TestCase):
    def test_extracts_various(self):
        self.assertEqual(comfy_client.cloud_error_message({"error_message": "boom"}), "boom")
        self.assertEqual(
            comfy_client.cloud_error_message({"execution_error": {"exception_message": "x"}}), "x")
        self.assertEqual(comfy_client.cloud_error_message({"status_message": "y"}), "y")
        self.assertEqual(comfy_client.cloud_error_message({}), "")


class MiscTests(unittest.TestCase):
    def test_cancelled_is_fail(self):
        self.assertIn("cancelled", comfy_client.CLOUD_FAIL)

    def test_cloud_alive_only_200(self):
        with mock.patch.object(comfy_client, "_request", lambda *a, **k: (200, b"{}")):
            self.assertTrue(comfy_client.check_alive(_cloud_target()))
        with mock.patch.object(comfy_client, "_request", lambda *a, **k: (401, b"no")):
            self.assertFalse(comfy_client.check_alive(_cloud_target()))

    def test_cloud_alive_no_key(self):
        self.assertFalse(comfy_client.check_alive(_cloud_target("")))


class WaitCloudTests(unittest.TestCase):
    def test_wait_completes(self):
        statuses = iter(["pending", "in_progress", "completed"])
        with mock.patch.object(comfy.comfy_client, "cloud_job_status", lambda t, p: next(statuses)), \
             mock.patch.object(comfy.comfy_client, "cloud_job_detail",
                               lambda t, p: {"outputs": {"1": "ok"}}), \
             mock.patch.object(comfy.time, "sleep", lambda s: None):
            entry = comfy._wait(_cloud_target(), "pid")
        self.assertEqual(entry, {"outputs": {"1": "ok"}})

    def test_wait_cancelled_raises_fast(self):
        with mock.patch.object(comfy.comfy_client, "cloud_job_status", lambda t, p: "cancelled"), \
             mock.patch.object(comfy.comfy_client, "cloud_job_detail",
                               lambda t, p: {"error_message": "user cancelled"}), \
             mock.patch.object(comfy.time, "sleep", lambda s: None):
            with self.assertRaises(comfy_client.ComfyError) as cm:
                comfy._wait(_cloud_target(), "pid")
        self.assertIn("user cancelled", str(cm.exception))

    def test_wait_timeout_reports_last_status(self):
        # 정상 pending 이 오래 지속되면 타임아웃까지 대기하되, 마지막 상태를 메시지에 담아 진단 가능하게.
        ticks = iter([0.0, 0.0, 100.0, 100.0])
        with mock.patch.object(comfy.comfy_client, "cloud_job_status", lambda t, p: "in_progress"), \
             mock.patch.object(comfy.comfy_client, "cloud_cancel_pending") as cancel, \
             mock.patch.object(comfy.time, "sleep", lambda s: None), \
             mock.patch.object(comfy.time, "monotonic", lambda: next(ticks)), \
             mock.patch.object(comfy, "_JOB_TIMEOUT", 10):
            with self.assertRaises(comfy_client.ComfyError) as cm:
                comfy._wait(_cloud_target(), "pid")
        self.assertIn("in_progress", str(cm.exception))
        cancel.assert_called_once_with(_cloud_target(), "pid")

    def test_wait_unknown_status_grace_fail(self):
        # 미지/빈 상태가 grace 넘게 지속되면 30분 안 기다리고 조기 실패(형식 어긋남 진단).
        ticks = iter([0.0, 1.0, 2.0, 3.0])
        with mock.patch.object(comfy.comfy_client, "cloud_job_status", lambda t, p: ""), \
             mock.patch.object(comfy.time, "sleep", lambda s: None), \
             mock.patch.object(comfy.time, "monotonic", lambda: next(ticks)), \
             mock.patch.object(comfy, "_JOB_TIMEOUT", 1000), \
             mock.patch.object(comfy, "_CLOUD_UNKNOWN_GRACE", 0):
            with self.assertRaises(comfy_client.ComfyError) as cm:
                comfy._wait(_cloud_target(), "pid")
        self.assertIn("해석할 수 없", str(cm.exception))


class EnvIntTests(unittest.TestCase):
    def test_default_when_unset(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            comfy.os.environ.pop("CH_TEST_X", None)
            self.assertEqual(comfy._env_int("CH_TEST_X", 1800), 1800)

    def test_fallback_on_nonnumeric(self):
        with mock.patch.dict("os.environ", {"CH_TEST_X": "abc"}):
            self.assertEqual(comfy._env_int("CH_TEST_X", 1800), 1800)

    def test_clamp_below_minimum(self):
        with mock.patch.dict("os.environ", {"CH_TEST_X": "5"}):
            self.assertEqual(comfy._env_int("CH_TEST_X", 1800, minimum=30), 30)

    def test_valid_value(self):
        with mock.patch.dict("os.environ", {"CH_TEST_X": "120"}):
            self.assertEqual(comfy._env_int("CH_TEST_X", 1800, minimum=30), 120)


class SchemeGuardTests(unittest.TestCase):
    """SSRF 방어 — http/https 아닌 스킴은 urlopen 도달 전에 거부한다."""

    def test_file_scheme_rejected(self):
        with self.assertRaises(comfy_client.ComfyError):
            comfy_client._request("GET", "file:///etc/passwd")

    def test_non_http_scheme_rejected(self):
        with self.assertRaises(comfy_client.ComfyError):
            comfy_client._request("GET", "gopher://127.0.0.1/x")

    def test_http_scheme_passes_guard(self):
        # http 스킴은 게이트를 통과해 urlopen 까지 간다(연결 자체는 monkeypatch 로 가로챈다).
        with mock.patch.object(comfy_client.urllib.request, "urlopen") as m:
            m.return_value.__enter__.return_value.status = 200
            m.return_value.__enter__.return_value.read.return_value = b"ok"
            status, body = comfy_client._request("GET", "http://127.0.0.1:8188/system_stats")
        self.assertEqual((status, body), (200, b"ok"))


if __name__ == "__main__":
    unittest.main()
