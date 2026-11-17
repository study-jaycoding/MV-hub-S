"""계정 DB 백업 업로드의 고정 메모리·동시성 계약."""

import asyncio
import io
import tempfile
import threading
import time
import unittest
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import HTTPException, FastAPI
from fastapi.testclient import TestClient

from app.routers import db_backup, db_transfer
from app.services import backup_manifest, upload_limits
from test_worker_offdisk_backup import worker_store
from test_shared_transport import certificates, required_tls, transport_server


class GuardedStream(io.BytesIO):
    """전체 read를 호출하면 실패하는 테스트 스트림."""

    def read(self, size=-1):
        if size < 0 or size > db_backup._CHUNK_BYTES:
            raise AssertionError("백업 스트림을 청크보다 크게 읽었습니다")
        return super().read(size)


@pytest.fixture
def v3_receiver(tmp_path, monkeypatch):
    from test_worker_offdisk_backup import _server_v3_fixture
    value, paths = _server_v3_fixture(tmp_path / 'source')
    monkeypatch.setattr(db_backup, '_acct', lambda _: {'email': 'artist@example.com'})
    monkeypatch.setattr(db_backup, '_dir', lambda _: tmp_path / 'server')
    app = FastAPI()
    app.include_router(db_backup.router)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, value, paths


def _v3_files(paths):
    return [(role, (backup_manifest.WORKER_FILENAMES[role], path.read_bytes())) for role, path in paths.items()]


def test_v3_route_accepts_all_typed_files(v3_receiver, tmp_path):
    client, value, paths = v3_receiver
    response = client.post('/api/db-backup/sets', data={'manifest': backup_manifest.canonical(value)}, files=_v3_files(paths))
    assert response.status_code == 200, response.text
    assert set(response.json()['files']) == set(paths)
    folder = tmp_path / 'server/sets' / value['backup_set_id']
    assert (folder / 'asset_mounts.json').read_bytes() == paths['asset_mounts'].read_bytes()


@pytest.mark.parametrize('damage', ['malformed', 'missing_table'])
def test_v3_trash_invalid_sqlite_is_400(v3_receiver, tmp_path, damage):
    client, value, paths = v3_receiver
    if damage == 'malformed':
        paths['trash'].write_bytes(b'this is not a SQLite database')
    else:
        with sqlite3.connect(paths['trash']) as conn:
            conn.execute('DROP TABLE trashed')
    value['roles']['trash'].update(size=paths['trash'].stat().st_size,
                                   sha256=backup_manifest.file_digest(paths['trash']))
    value = backup_manifest.seal(value)
    response = client.post('/api/db-backup/sets', data={'manifest': backup_manifest.canonical(value)},
                           files=_v3_files(paths))
    assert response.status_code == 400, response.text
    assert 'accepted' not in response.json()
    assert not (tmp_path / 'server/sets' / value['backup_set_id']).exists()


@pytest.mark.parametrize('damage', ['duplicate', 'unknown', 'unknown_text', 'duplicate_manifest', 'absent', 'account', 'bytes'])
def test_v3_route_rejects_ambiguous_or_invalid_parts(v3_receiver, tmp_path, damage):
    client, value, paths = v3_receiver
    files = _v3_files(paths)
    data = {}
    if damage == 'duplicate': files.append(files[-1])
    elif damage == 'unknown': files.append(('unknown', ('unknown.db', b'unknown')))
    elif damage == 'unknown_text': data['unknown'] = 'unexpected'
    elif damage == 'absent':
        value['roles']['agent_chat'] = {'state': 'absent', 'captured_at': value['captured_at']}
        value['consistency_roles'].remove('agent_chat')
    elif damage == 'account': value['account_scope_digest'] = '0' * 64
    elif damage == 'bytes': files[-1] = ('asset_mounts', ('asset_mounts.json', b'{}'))
    value = backup_manifest.seal(value)
    data['manifest'] = backup_manifest.canonical(value)
    if damage == 'duplicate_manifest': files.append(('manifest', (None, data['manifest'])))
    response = client.post('/api/db-backup/sets', data=data, files=files)
    assert response.status_code == 400, response.text
    assert not (tmp_path / 'server/sets' / value['backup_set_id']).exists()


def test_v3_route_json_limit_and_database_limit_are_separate(v3_receiver, monkeypatch):
    client, value, paths = v3_receiver
    role = value['roles']['asset_mounts']
    role['size'] = upload_limits.MIB + 1
    value = backup_manifest.seal(value)
    response = client.post('/api/db-backup/sets', data={'manifest': backup_manifest.canonical(value)}, files=_v3_files(paths))
    assert response.status_code == 413
    role['size'] = paths['asset_mounts'].stat().st_size
    value = backup_manifest.seal(value)
    monkeypatch.setattr(db_backup, '_MAX_BYTES', 100)
    response = client.post('/api/db-backup/sets', data={'manifest': backup_manifest.canonical(value)}, files=_v3_files(paths))
    assert response.status_code == 413


@pytest.mark.parametrize('extra', ['agent_chat', 'asset_mounts'])
def test_v2_route_still_rejects_new_members(v3_receiver, worker_store, tmp_path, extra):
    from test_worker_offdisk_backup import _queued
    client, _, _ = v3_receiver
    _, stage, value = _queued(worker_store)
    paths = {role: stage / backup_manifest.WORKER_FILENAMES[role] for role in value['roles']}
    files = _v3_files(paths)
    files.append((extra, (backup_manifest.WORKER_FILENAMES[extra], b'{}')))
    response = client.post('/api/db-backup/sets', data={'manifest': backup_manifest.canonical(value)}, files=files)
    assert response.status_code == 400, response.text
    assert not (tmp_path / 'server/sets' / value['backup_set_id']).exists()


@pytest.mark.parametrize('parser', ['server', 'nas'])
def test_deep_manifest_parse_failure_is_closed(tmp_path, monkeypatch, parser):
    def too_deep(*args, **kwargs):
        raise RecursionError('fixture nesting')
    if parser == 'server':
        monkeypatch.setattr(db_backup.json, 'loads', too_deep)
        with pytest.raises(db_backup.BackupSetValidationError):
            db_backup._normalise_set_manifest('{}')
    else:
        from test_backup_replicate import _module
        replicate = _module()
        (tmp_path / 'manifest.json').write_text('{}', encoding='utf-8')
        monkeypatch.setattr(replicate.json, 'loads', too_deep)
        assert replicate._set_manifest(tmp_path) is None


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

    async def test_cancelled_request_keeps_slot_until_store_thread_finishes(self):
        active = 0
        peak = 0
        counter_lock = threading.Lock()
        first_started = threading.Event()
        release_first = threading.Event()
        calls = 0

        def fake_store(_directory, _name, source):
            nonlocal active, peak, calls
            with counter_lock:
                calls += 1
                call_number = calls
                active += 1
                peak = max(peak, active)
            try:
                if call_number == 1:
                    first_started.set()
                    release_first.wait(timeout=2)
                return len(source.read()), 1
            finally:
                with counter_lock:
                    active -= 1

        old_slots = db_backup._store_slots
        db_backup._store_slots = asyncio.Semaphore(1)
        try:
            with mock.patch.object(db_backup, "_store_backup", side_effect=fake_store):
                first = asyncio.create_task(
                    db_backup._store_backup_limited(
                        self._test_dir / "first", "first.db", io.BytesIO(b"first")
                    )
                )
                self.assertTrue(
                    await asyncio.to_thread(first_started.wait, 1),
                    "첫 저장 스레드가 시작되지 않았습니다",
                )
                first.cancel()
                second = asyncio.create_task(
                    db_backup._store_backup_limited(
                        self._test_dir / "second", "second.db", io.BytesIO(b"second")
                    )
                )
                await asyncio.sleep(0.02)
                self.assertFalse(second.done())
                self.assertEqual(peak, 1)
                release_first.set()
                results = await asyncio.gather(first, second, return_exceptions=True)
        finally:
            release_first.set()
            db_backup._store_slots = old_slots

        self.assertIsInstance(results[0], asyncio.CancelledError)
        self.assertEqual(results[1], (6, 1))
        self.assertEqual(peak, 1)

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


def test_db_transfer_upload_and_download_use_tls(required_tls, tmp_path):
    source = tmp_path / 'source.db'
    source.write_bytes(b'synthetic sqlite bytes')
    with transport_server(required_tls, body=b'{"ok":true}') as (base, seen):
        assert db_transfer._multipart_upload(base + '/upload', 'synthetic', source) == (200, {'ok': True})
        dest = tmp_path / 'download.db'
        assert db_transfer._download_to(base + '/download', 'synthetic', dest) == 200
        assert dest.read_bytes() == b'{"ok":true}'
        assert all(r[1]['Authorization'] == 'Bearer synthetic' for r in seen)
    with transport_server(required_tls, status=302) as (base, seen):
        assert db_transfer._multipart_upload(base + '/upload', 'synthetic', source)[0] == 302
        assert db_transfer._download_to(base + '/download', 'synthetic', tmp_path / 'redirect.db') == 302
        assert len(seen) == 2
        assert not (tmp_path / 'redirect.db').exists()


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
