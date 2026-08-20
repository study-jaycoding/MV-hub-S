"""원격 media-thumb가 외부 URL로 리다이렉트되지 않는 경계 회귀."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app.routers import library


class MediaThumbSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_failures_end_locally_without_redirect(self):
        src = "https://evil.example/image.png"
        with mock.patch.object(
            library.media_cache,
            "cache_thumb_source",
            new=mock.AsyncMock(return_value=None),
        ):
            with self.assertRaises(HTTPException) as cache_error:
                await library.media_thumb(src)
        self.assertEqual(cache_error.exception.status_code, 502)

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            target = Path(temp_dir) / "broken.png"
            target.write_bytes(b"not-an-image")
            with (
                mock.patch.object(
                    library.media_cache,
                    "cache_thumb_source",
                    new=mock.AsyncMock(return_value="cached/broken.png"),
                ),
                mock.patch.object(library.thumbs, "_media_target", return_value=target),
                mock.patch.object(library.thumbs, "ensure_thumb", return_value=None),
            ):
                with self.assertRaises(HTTPException) as thumb_error:
                    await library.media_thumb(src)
        self.assertEqual(thumb_error.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
