"""다운로드 각인 배선 — 내려주는 사본에만 새기고, 보관 원본은 건드리지 않는다.

로컬 보관본(/media/...)은 여러 생성물이 같은 파일을 가리킬 수 있고 썸네일·미리보기도 같은
바이트를 읽는다. 그래서 원본에 새기면 안 되고, 내려보내는 사본에만 새겨야 한다.
"""
from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from PIL import Image
from starlette.responses import StreamingResponse

from app.routers import library
from app.services import file_stamp


def _png(path: Path) -> None:
    buf = io.BytesIO()
    Image.new("RGB", (6, 4), (200, 30, 90)).save(buf, format="PNG")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())


class DownloadStampTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.media = Path(self.tmp.name)
        self.src = self.media / "ab" / "shot.png"
        _png(self.src)
        self.original = self.src.read_bytes()
        self.patches = [
            patch.object(library, "MEDIA_DIR", self.media),
            patch.object(
                library.file_stamp, "tags_for_generation",
                lambda gen_id: file_stamp.build_tags(gen_id, "job-1"),
            ),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _download(self, gen_id=None):
        return library.download_media(
            BackgroundTasks(), url="/media/ab/shot.png", name="shot.png", gen_id=gen_id
        )

    def test_stamps_the_copy_and_leaves_the_stored_file_alone(self):
        response = self._download(gen_id="gen-1")

        served = Path(response.path)
        self.assertNotEqual(served, self.src)  # 사본을 내려준다
        self.assertEqual(file_stamp.gen_id_of(file_stamp.read_stamp(served)), "gen-1")
        self.assertEqual(self.src.read_bytes(), self.original)  # 보관 원본 불변

    def test_without_gen_id_serves_the_stored_file_unchanged(self):
        response = self._download()

        self.assertEqual(Path(response.path), self.src)
        self.assertEqual(file_stamp.read_stamp(Path(response.path)), {})

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            library.download_media(
                BackgroundTasks(), url="/media/../secret.png", name="x.png", gen_id="gen-1"
            )

        self.assertEqual(caught.exception.status_code, 404)

    def test_unknown_remote_size_over_cap_streams_without_unbounded_temp(self):
        payload = b"0123456789" * 20

        class _Remote(io.BytesIO):
            closed_by_route = False

            def close(self):
                self.closed_by_route = True
                super().close()

        upstream = _Remote(payload)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            temp_path = Path(tmpdir) / "bounded.bin"
            with (
                patch.object(library, "STAMP_MAX_BYTES", 32),
                patch.object(library, "_new_temp_file", return_value=temp_path),
                patch.object(
                    library.file_stamp,
                    "stamp_file",
                    side_effect=AssertionError("상한 초과 파일을 각인하면 안 됩니다"),
                ),
            ):
                response = library._stamped_download(
                    upstream,
                    "application/octet-stream",
                    "large.bin",
                    {"mvhub.gen_id": "g1"},
                    BackgroundTasks(),
                )
                self.assertIsInstance(response, StreamingResponse)

                async def _body() -> bytes:
                    chunks = []
                    async for chunk in response.body_iterator:
                        chunks.append(chunk)
                    return b"".join(chunks)

                self.assertEqual(asyncio.run(_body()), payload)
                self.assertFalse(temp_path.exists())
                self.assertTrue(upstream.closed_by_route)


class _Remote(io.BytesIO):
    """원격 응답 흉내 — 머리글에 밝힌 길이(declared)보다 본문이 짧으면 중간에 끊긴 것이다.
    http.client 의 길이 지정 read() 도 끊기면 예외 없이 짧게 끝난다(그래서 길이를 대조해야 한다)."""

    def __init__(self, payload: bytes, declared: int):
        super().__init__(payload)
        self.headers = Message()
        self.headers["Content-Type"] = "video/mp4"
        self.headers["Content-Length"] = str(declared)
        self.closed_by_route = False

    def close(self):
        self.closed_by_route = True
        super().close()


def _drain(response) -> bytes:
    async def _body() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    return asyncio.run(_body())


class TruncatedRemoteTests(unittest.TestCase):
    """47회차 — 원격이 중간에 끊긴 반쪽 파일을 정상 다운로드로 내보내지 않는다."""

    def _remote_download(self, upstream, gen_id=None):
        opener = type("_Opener", (), {"open": lambda self, req, timeout=None: upstream})()
        with (
            patch.object(library, "assert_public_http_url", lambda url: None),
            patch.object(library, "guarded_opener", lambda: opener),
            patch.object(library.file_stamp, "tags_for_generation", lambda gen_id: {"mvhub.gen_id": gen_id}),
            patch.object(library.file_stamp, "stamp_file", lambda *args, **kwargs: None),
        ):
            return library.download_media(BackgroundTasks(), url="https://cdn.example/clip.mp4", name="clip.mp4", gen_id=gen_id)

    def test_stamped_path_rejects_short_body_and_cleans_temp(self):
        upstream = _Remote(b"x" * 70, declared=100)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            temp_path = Path(tmpdir) / "part.mp4"
            with patch.object(library, "_new_temp_file", return_value=temp_path):
                with self.assertRaises(HTTPException) as caught:
                    self._remote_download(upstream, gen_id="gen-1")
            self.assertEqual(caught.exception.status_code, 502)
            self.assertIn("70/100", caught.exception.detail)
            self.assertFalse(temp_path.exists())
        self.assertTrue(upstream.closed_by_route)

    def test_streamed_path_fails_at_the_end_of_a_short_body(self):
        upstream = _Remote(b"x" * 70, declared=100)
        response = self._remote_download(upstream)  # gen_id 없음 = 각인 없이 흘려보낸다
        self.assertIsInstance(response, StreamingResponse)
        with self.assertRaises(HTTPException):
            _drain(response)  # 끝맺지 않고 끊는다 — 브라우저는 실패로 보고 CDN 직접 받기로 넘어간다
        self.assertTrue(upstream.closed_by_route)

    def test_complete_bodies_pass_on_both_paths(self):
        streamed = self._remote_download(_Remote(b"y" * 100, declared=100))
        self.assertEqual(_drain(streamed), b"y" * 100)
        stamped = self._remote_download(_Remote(b"z" * 100, declared=100), gen_id="gen-1")
        try:
            self.assertEqual(Path(stamped.path).read_bytes(), b"z" * 100)
        finally:
            Path(stamped.path).unlink(missing_ok=True)

    def test_over_cap_stream_also_checks_the_declared_length(self):
        upstream = _Remote(b"w" * 70, declared=100)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
            temp_path = Path(tmpdir) / "big.bin"
            with patch.object(library, "STAMP_MAX_BYTES", 32), patch.object(library, "_new_temp_file", return_value=temp_path):
                response = library._stamped_download(upstream, "video/mp4", "big.mp4", {"mvhub.gen_id": "g1"}, BackgroundTasks())
                with self.assertRaises(HTTPException):
                    _drain(response)
                self.assertFalse(temp_path.exists())


class ReadStampRouteTests(unittest.IsolatedAsyncioTestCase):
    """끌어다 놓은 파일의 각인 읽기 — 각인이 없으면 '우리 파일이 아니다'로 답해야 한다."""

    async def _read(self, data: bytes, filename: str) -> dict:
        upload = _FakeUpload(data, filename)
        return await library.read_file_stamp(upload)  # type: ignore[arg-type]

    async def test_reads_gen_id_from_stamped_png(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.png"
            _png(path)
            stamped = file_stamp.stamp_bytes(
                path.read_bytes(), file_stamp.build_tags("gen-9", "job-9")
            )

            out = await self._read(stamped, "a.png")

        self.assertEqual(out["gen_id"], "gen-9")
        self.assertEqual(out["job_id"], "job-9")
        self.assertEqual(out["hub"], file_stamp.HUB_TAG)

    async def test_plain_file_has_no_stamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.png"
            _png(path)

            out = await self._read(path.read_bytes(), "a.png")

        self.assertIsNone(out["gen_id"])


class _FakeUpload:
    """UploadFile 흉내 — 라우터를 HTTP 없이 직접 부르기 위한 최소 구현.
    R7 2-C 이후 라우터는 동기 helper 에서 .file(SpooledTemporaryFile 동등)을 읽는다."""

    def __init__(self, data: bytes, filename: str):
        import io

        self._data = data
        self._pos = 0
        self.filename = filename
        self.file = io.BytesIO(data)  # 동기 읽기 경로(UploadFile.file 동등)

    async def read(self, size: int = -1) -> bytes:
        chunk = self._data[self._pos :] if size < 0 else self._data[self._pos : self._pos + size]
        self._pos += len(chunk)
        return chunk


if __name__ == "__main__":
    unittest.main()
