"""각인(file_stamp) 계약 — 화질을 건드리지 않고, 실패해도 원본을 지킨다.

이 두 가지가 깨지면 사용자가 받은 파일이 상한다. 그래서 '읽힌다'보다 '원본이 그대로다'를 먼저 센다.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock

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

    def test_png_temp_is_unique_same_directory_and_fd_is_closed(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "frame.png"
            path.write_bytes(_png_bytes())
            real_mkstemp = tempfile.mkstemp
            real_close = os.close
            created: list[tuple[int, Path, dict]] = []

            def tracked_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created.append((fd, Path(raw_path), kwargs))
                return fd, raw_path

            with (
                mock.patch.object(
                    file_stamp.tempfile,
                    "mkstemp",
                    side_effect=tracked_mkstemp,
                ),
                mock.patch.object(file_stamp.os, "close", wraps=real_close) as close,
            ):
                self.assertTrue(file_stamp.stamp_file(path, TAGS))

            fd, temp_path, kwargs = created[0]
            close.assert_called_once_with(fd)
            self.assertEqual(Path(kwargs["dir"]), path.parent)
            self.assertNotEqual(temp_path, path)
            self.assertFalse(temp_path.exists())
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_png_replace_failure_removes_only_unreplaced_temp(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "frame.png"
            original = _png_bytes()
            path.write_bytes(original)

            with mock.patch.object(
                file_stamp.os,
                "replace",
                side_effect=OSError("replace failed"),
            ):
                self.assertFalse(file_stamp.stamp_file(path, TAGS))

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_video_replace_failure_cleans_temp_and_keeps_copy_codec(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            original = b"original-video-container"
            path.write_bytes(original)
            seen_args: list[str] = []

            def fake_popen(args, **_kwargs):
                seen_args.extend(args)
                Path(args[-1]).write_bytes(b"stamped-video-container")
                return SimpleNamespace(returncode=0, communicate=lambda timeout=None: (None, b""), poll=lambda: 0)

            with (
                mock.patch.object(file_stamp, "_ffmpeg", return_value="ffmpeg"),
                mock.patch.object(file_stamp.subprocess, "Popen", side_effect=fake_popen),
                mock.patch.object(
                    file_stamp.os,
                    "replace",
                    side_effect=OSError("replace failed"),
                ),
            ):
                self.assertFalse(file_stamp.stamp_file(path, TAGS))

            self.assertEqual(seen_args[seen_args.index("-c") + 1], "copy")
            metadata = {
                seen_args[index + 1]
                for index, value in enumerate(seen_args)
                if value == "-metadata"
            }
            self.assertEqual(metadata, {f"{key}={value}" for key, value in TAGS.items()})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_video_stamp_stops_ffmpeg_when_cancelled(self):
        # 09-23 점검: 동기 대기(최대 5분)라 완료본 저장의 [취소]가 파일 하나를 다 기다렸다. 이제 기다리는 사이에 본다.
        class StuckFfmpeg:
            returncode = None
            killed = False
            reaped = False
            waits = 0

            def communicate(self, timeout=None):
                self.waits += 1
                if self.killed:
                    self.reaped = True  # 죽인 뒤 회수했다(좀비·파이프를 남기지 않게)
                if not self.killed and self.waits <= 10:  # 취소를 안 보면 10번 뒤 스스로 끝난다 — 시험이 멈추지 않고 실패하게
                    raise subprocess.TimeoutExpired("ffmpeg", timeout)
                self.returncode = self.returncode if self.killed else 0
                return None, b""

            def kill(self):
                self.killed = True
                self.returncode = 1

            def poll(self):
                return self.returncode

        proc = StuckFfmpeg()
        asked: list[int] = []
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            path.write_bytes(b"original-video-container")
            with (
                mock.patch.object(file_stamp, "_ffmpeg", return_value="ffmpeg"),
                mock.patch.object(file_stamp.subprocess, "Popen", return_value=proc),
            ):
                self.assertFalse(file_stamp.stamp_file(path, TAGS, should_cancel=lambda: asked.append(1) or len(asked) >= 2))

            self.assertTrue(proc.killed and proc.reaped)
            self.assertEqual(len(asked), 2)
            self.assertEqual(path.read_bytes(), b"original-video-container")  # 원본은 그대로 — 저장은 각인 없이 이어진다
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_video_stamp_error_while_waiting_still_stops_ffmpeg(self):
        # Codex 리뷰: 기다리던 중 예외(I/O·콜백)면 False 만 돌려주고 ffmpeg 를 남겼다 — 임시 파일도 쥔 채로.
        class BrokenPipe:
            returncode = None
            killed = False
            reaped = False

            def communicate(self, timeout=None):
                if not self.killed:
                    raise OSError("pipe broke")
                self.reaped = True
                return None, b""

            def kill(self):
                self.killed = True
                self.returncode = 1

            def poll(self):
                return self.returncode

        proc = BrokenPipe()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            path.write_bytes(b"original-video-container")
            with (
                mock.patch.object(file_stamp, "_ffmpeg", return_value="ffmpeg"),
                mock.patch.object(file_stamp.subprocess, "Popen", return_value=proc),
            ):
                self.assertFalse(file_stamp.stamp_file(path, TAGS))
            self.assertTrue(proc.killed and proc.reaped)
            self.assertEqual(path.read_bytes(), b"original-video-container")
            self.assertEqual(list(path.parent.iterdir()), [path])


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
