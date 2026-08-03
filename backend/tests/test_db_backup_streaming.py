"""계정 DB 백업 업로드의 고정 메모리·동시성 계약."""

import asyncio
import io
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app.routers import db_backup, db_transfer


class GuardedStream(io.BytesIO):
    """전체 read를 호출하면 실패하는 테스트 스트림."""

    def read(self, size=-1):
        if size < 0 or size > db_backup._CHUNK_BYTES:
            raise AssertionError("백업 스트림을 청크보다 크게 읽었습니다")
        return super().read(size)


class BackupStreamingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_store_reads_in_chunks_and_returns_exact_size(self):
        payload = b"x" * (db_backup._CHUNK_BYTES * 2 + 17)
        with mock.patch.object(db_backup, "validate_hub_db"):
            size, count = db_backup._store_backup(
                self.root, "backup.db", GuardedStream(payload)
            )
        self.assertEqual(size, len(payload))
        self.assertEqual(count, 1)
        self.assertEqual((self.root / "backup.db").read_bytes(), payload)
        self.assertEqual(list(self.root.glob(".upload-*.tmp")), [])

    def test_over_limit_removes_partial_file_and_publishes_nothing(self):
        payload = b"x" * 9
        with (
            mock.patch.object(db_backup, "_MAX_BYTES", 8),
            mock.patch.object(db_backup, "_CHUNK_BYTES", 4),
            self.assertRaises(db_backup.BackupTooLargeError),
        ):
            db_backup._store_backup(self.root, "too-big.db", GuardedStream(payload))
        self.assertFalse((self.root / "too-big.db").exists())
        self.assertEqual(list(self.root.glob(".upload-*.tmp")), [])


class BackupConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_route_limits_concurrent_store_workers(self):
        active = 0
        peak = 0
        counter_lock = threading.Lock()

        def fake_store(_directory, _name, source):
            nonlocal active, peak
            with counter_lock:
                active += 1
                peak = max(peak, active)
            try:
                time.sleep(0.03)
                return len(source.read()), 1
            finally:
                with counter_lock:
                    active -= 1

        old_slots = db_backup._store_slots
        db_backup._store_slots = asyncio.Semaphore(2)
        try:
            with (
                mock.patch.object(
                    db_backup,
                    "_acct",
                    side_effect=lambda request: {"email": request.email},
                ),
                mock.patch.object(
                    db_backup,
                    "_dir",
                    side_effect=lambda email: self._test_dir / email,
                ),
                mock.patch.object(db_backup, "_store_backup", side_effect=fake_store),
            ):
                await asyncio.gather(
                    *(
                        db_backup.upload_backup(
                            SimpleNamespace(email=f"user-{index}"),
                            SimpleNamespace(file=io.BytesIO(b"data")),
                        )
                        for index in range(8)
                    )
                )
        finally:
            db_backup._store_slots = old_slots
        self.assertEqual(peak, 2)

    @property
    def _test_dir(self) -> Path:
        if not hasattr(self, "_tmp_dir"):
            self._tmp = tempfile.TemporaryDirectory()
            self.addCleanup(self._tmp.cleanup)
            self._tmp_dir = Path(self._tmp.name)
        return self._tmp_dir


class BackupRouteLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_route_returns_413_for_stream_limit(self):
        with (
            mock.patch.object(db_backup, "_acct", return_value={"email": "u@example.com"}),
            mock.patch.object(db_backup, "_dir", return_value=Path("unused")),
            mock.patch.object(
                db_backup,
                "_store_backup",
                side_effect=db_backup.BackupTooLargeError,
            ),
        ):
            with self.assertRaises(HTTPException) as caught:
                await db_backup.upload_backup(
                    SimpleNamespace(), SimpleNamespace(file=io.BytesIO(b"x"))
                )
        self.assertEqual(caught.exception.status_code, 413)


class MultipartStreamingTests(unittest.TestCase):
    def test_stdlib_client_streams_valid_multipart_with_content_length(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                received["content_type"] = self.headers["Content-Type"]
                received["authorization"] = self.headers["Authorization"]
                received["body"] = self.rfile.read(length)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok": true}')

            def log_message(self, _format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / "backup.db"
                payload = b"sqlite-backup" * 1000
                source.write_bytes(payload)
                status, body = db_transfer._multipart_upload(
                    f"http://127.0.0.1:{server.server_port}/upload",
                    "token-1",
                    source,
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})
        self.assertEqual(received["authorization"], "Bearer token-1")
        self.assertIn("multipart/form-data; boundary=", received["content_type"])
        self.assertIn(payload, received["body"])
        self.assertTrue(received["body"].endswith(b"--\r\n"))


if __name__ == "__main__":
    unittest.main()
