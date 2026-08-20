"""각인(file_stamp) 계약 — 화질을 건드리지 않고, 실패해도 원본을 지킨다.

이 두 가지가 깨지면 사용자가 받은 파일이 상한다. 그래서 '읽힌다'보다 '원본이 그대로다'를 먼저 센다.
"""
from __future__ import annotations

import io
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

from app.services import file_stamp

TAGS = file_stamp.build_tags(
    "cd9f84ab-d0ba-4571-8c97-eb3b7e646586", "26fb8dec-504b-4afd-95f3-5544c5a00948"
)


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 6), (12, 200, 90)).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 6), (12, 200, 90)).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _pixels(data: bytes) -> bytes:
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("RGB").tobytes()


class StampImageTests(unittest.TestCase):
    def test_png_keeps_original_bytes_and_pixels(self):
        src = _png_bytes()

        out = file_stamp.stamp_bytes(src, TAGS)

        self.assertGreater(len(out), len(src))  # 각인이 실제로 들어갔다
        # IEND 앞에 끼워 넣으므로 원본의 앞부분은 한 바이트도 바뀌지 않는다.
        self.assertTrue(out.startswith(src[: src.rfind(b"\x00\x00\x00\x00IEND")]))
        self.assertEqual(_pixels(src), _pixels(out))  # 화질 손실 없음

    def test_png_round_trip(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.png"
            path.write_bytes(file_stamp.stamp_bytes(_png_bytes(), TAGS))

            stamp = file_stamp.read_stamp(path)

            self.assertEqual(file_stamp.gen_id_of(stamp), "cd9f84ab-d0ba-4571-8c97-eb3b7e646586")
            self.assertEqual(stamp[file_stamp.KEY_JOB], "26fb8dec-504b-4afd-95f3-5544c5a00948")
            self.assertEqual(stamp[file_stamp.KEY_HUB], file_stamp.HUB_TAG)

    def test_jpeg_round_trip_keeps_pixels(self):
        src = _jpeg_bytes()
        out = file_stamp.stamp_bytes(src, TAGS)
        self.assertEqual(_pixels(src), _pixels(out))

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.jpg"
            path.write_bytes(out)
            self.assertEqual(
                file_stamp.gen_id_of(file_stamp.read_stamp(path)),
                "cd9f84ab-d0ba-4571-8c97-eb3b7e646586",
            )

    def test_unstamped_file_reads_empty(self):
        """각인이 없으면 빈 dict — '우리가 만든 파일이 아니다'."""
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "plain.png"
            path.write_bytes(_png_bytes())

            self.assertEqual(file_stamp.read_stamp(path), {})
            self.assertIsNone(file_stamp.gen_id_of({}))


class StampFailureIsHarmlessTests(unittest.TestCase):
    """각인은 '있으면 좋은 것'이다 — 실패가 파일을 상하게 하거나 다운로드를 막으면 안 된다."""

    def test_unknown_format_passes_through(self):
        src = b"this is not an image"

        self.assertEqual(file_stamp.stamp_bytes(src, TAGS), src)

    def test_broken_png_passes_through(self):
        src = file_stamp._PNG_MAGIC + b"broken-no-iend"

        self.assertEqual(file_stamp.stamp_bytes(src, TAGS), src)

    def test_empty_tags_change_nothing(self):
        src = _png_bytes()

        self.assertEqual(file_stamp.stamp_bytes(src, {}), src)

    def test_stamp_file_leaves_original_when_unsupported(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.txt"
            path.write_bytes(b"hello")

            self.assertFalse(file_stamp.stamp_file(path, TAGS))
            self.assertEqual(path.read_bytes(), b"hello")  # 원본 그대로
            self.assertEqual(list(Path(tmp).iterdir()), [path])  # 임시 찌꺼기 없음


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg 가 없는 PC 는 영상 각인을 건너뛴다")
class StampVideoTests(unittest.TestCase):
    def _sample(self, path: Path) -> None:
        subprocess.run(
            [shutil.which("ffmpeg"), "-y", "-v", "error", "-f", "lavfi",
             "-i", "testsrc=size=64x48:rate=10:duration=1", "-pix_fmt", "yuv420p", str(path)],
            check=True, capture_output=True,
        )

    def _video_stream(self, path: Path) -> bytes:
        done = subprocess.run(
            [shutil.which("ffmpeg"), "-v", "quiet", "-i", str(path), "-c", "copy", "-f", "rawvideo", "-"],
            check=True, capture_output=True,
        )
        return done.stdout

    def test_mp4_round_trip_keeps_video_stream(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            self._sample(path)
            before = self._video_stream(path)

            self.assertTrue(file_stamp.stamp_file(path, TAGS))

            self.assertEqual(before, self._video_stream(path))  # 영상은 그대로(재인코딩 없음)
            self.assertEqual(
                file_stamp.gen_id_of(file_stamp.read_stamp(path)),
                "cd9f84ab-d0ba-4571-8c97-eb3b7e646586",
            )
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["clip.mp4"])  # 찌꺼기 없음


if __name__ == "__main__":
    unittest.main()
