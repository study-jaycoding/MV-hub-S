"""video_convert.to_cloud_mp4_path·find_ffmpeg — subprocess/ffmpeg 를 monkeypatch 해 네트워크·ffmpeg 없이 검증."""

import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app.services import video_convert


class ToCloudMp4Tests(unittest.TestCase):


    def test_path_api_returns_file_without_loading_result_bytes(self):
        def fake_run(cmd, **_kw):
            Path(cmd[-1]).write_bytes(b"MP4DATA")
            return types.SimpleNamespace(returncode=0, stderr=b"")

        with TemporaryDirectory() as d:
            source = Path(d) / "source.mov"
            source.write_text("source")
            with mock.patch.object(video_convert, "find_ffmpeg", lambda: "ffmpeg"), \
                 mock.patch.object(video_convert, "_probe_fps", return_value=24.0), \
                 mock.patch.object(video_convert.subprocess, "run", fake_run), \
                 mock.patch.object(Path, "read_bytes", side_effect=AssertionError("read_bytes 금지")):
                    result = video_convert.to_cloud_mp4_path(source)
            try:
                self.assertTrue(result.exists())
                self.assertNotEqual(result, source)
            finally:
                result.unlink(missing_ok=True)


class FindFfmpegTests(unittest.TestCase):
    def test_env_override_when_exists(self):
        with mock.patch.dict("os.environ", {"CONTENT_HUB_FFMPEG": __file__}):
            self.assertEqual(video_convert.find_ffmpeg(), __file__)

    def test_path_fallback(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            video_convert.os.environ.pop("CONTENT_HUB_FFMPEG", None)
            with mock.patch.object(video_convert.shutil, "which", lambda n: "/usr/bin/ffmpeg"):
                self.assertEqual(video_convert.find_ffmpeg(), "/usr/bin/ffmpeg")


if __name__ == "__main__":
    unittest.main()
