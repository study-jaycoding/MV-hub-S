"""Assets 원본 파일 응답의 같은 오리진 실행 방지 회귀."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

from app.routers import assets
from app.services.media_types import (
    ASSET_CONTENT_TYPES,
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    asset_content_type,
)


class AssetFileResponseTests(unittest.TestCase):
    def _response_for(self, path: Path):
        with (
            patch.object(assets, "_safe_project_dir", return_value=path.parent),
            patch.object(assets, "_safe_resolve", return_value=path),
        ):
            return assets.get_file(SimpleNamespace(), "project", path.name)

    def test_every_supported_extension_has_an_explicit_content_type(self) -> None:
        expected = set(IMAGE_EXTENSIONS + VIDEO_EXTENSIONS + AUDIO_EXTENSIONS)
        self.assertEqual(set(ASSET_CONTENT_TYPES), expected)
        for extension in expected:
            with self.subTest(extension=extension):
                self.assertIsNotNone(asset_content_type(f"asset{extension.upper()}"))

    def test_supported_media_is_inline_with_fixed_security_headers(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            target = Path(temp_dir) / "frame 한글.PNG"
            target.write_bytes(b"<html><script>alert(1)</script></html>")

            response = self._response_for(target)

        self.assertEqual(response.media_type, "image/png")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(
            response.headers["content-security-policy"],
            "default-src 'none'; sandbox",
        )
        self.assertEqual(response.headers["cross-origin-resource-policy"], "same-origin")
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertTrue(response.headers["content-disposition"].startswith("inline;"))
        self.assertNotIn("text/html", response.headers["content-type"])

    def test_unsupported_or_double_extension_is_rejected(self) -> None:
        for filename in ("page.html", "vector.svg", "frame.png.html", "script.js"):
            with self.subTest(filename=filename):
                with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
                    target = Path(temp_dir) / filename
                    target.write_text("<script>alert(1)</script>", encoding="utf-8")
                    with self.assertRaises(HTTPException) as raised:
                        self._response_for(target)
                self.assertEqual(raised.exception.status_code, 415)

    def test_thumbnail_has_the_same_nosniff_boundary(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            root = Path(temp_dir)
            target = root / "frame.png"
            target.write_bytes(b"source")
            cached = root / "thumb.jpg"
            cached.write_bytes(b"thumbnail")
            with (
                patch.object(assets, "_safe_project_dir", return_value=root),
                patch.object(assets, "_safe_resolve", return_value=target),
                patch.object(assets.thumbs, "ensure_thumb", return_value=cached),
                patch.object(assets.thumbs, "mark_thumb_used"),
            ):
                response = assets.get_thumb(
                    SimpleNamespace(), "project", target.name, 512, None
                )

        self.assertEqual(response.media_type, "image/jpeg")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["cache-control"], "no-cache")

    def test_zip_export_remains_attachment_and_is_not_sniffed(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
            root = Path(temp_dir)
            target = root / "frame.png"
            target.write_bytes(b"source")
            with (
                patch.object(assets, "_safe_project_dir", return_value=root),
                patch.object(assets, "_safe_resolve", return_value=target),
            ):
                response = assets.export_zip(
                    SimpleNamespace(), "project", [target.name]
                )
            try:
                self.assertEqual(response.media_type, "application/zip")
                self.assertEqual(
                    response.headers["x-content-type-options"], "nosniff"
                )
                self.assertTrue(
                    response.headers["content-disposition"].startswith("attachment;")
                )
            finally:
                Path(response.path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
