"""임시파일 청소기 회귀 테스트 — 묵은 잔재만 지우고 신선한(진행 중) 파일은 보존."""

import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app.services import temp_sweeper


class TempSweeperTests(unittest.TestCase):
    def test_only_stale_files_are_removed(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            root = Path(d)
            (root / ".thumb-sources" / "ab").mkdir(parents=True)
            stale = root / ".thumb-sources" / "ab" / "x.part"
            fresh = root / ".thumb-sources" / "ab" / "y.part"
            keep = root / ".thumb-sources" / "ab" / "cached.png"  # 패턴 밖 — 손대면 안 됨
            for p in (stale, fresh, keep):
                p.write_bytes(b"junk")
            old = time.time() - 2 * 86400
            os.utime(stale, (old, old))
            os.utime(keep, (old, old))

            with mock.patch.object(temp_sweeper, "MEDIA_DIR", root):
                stats = temp_sweeper.sweep_once()

            self.assertFalse(stale.exists())
            self.assertTrue(fresh.exists())  # 24시간 미만 — 진행 중일 수 있어 보존
            self.assertTrue(keep.exists())   # 정상 캐시 파일은 패턴에 안 걸림
            self.assertEqual(stats["thumb_source_parts"], 1)

    def test_comfy_sweep_only_touches_app_generated_names(self):
        # mvhub 폴더에 사용자가 직접 둔 파일·접두 없는 구버전 업로드는 절대 지우지 않는다.
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            mvhub = Path(d) / "input" / "mvhub"
            mvhub.mkdir(parents=True)
            app_file = mvhub / "aaaabbbbcccc-0-image1.png"   # 우리 접두(잡uuid-순번-)
            user_file = mvhub / "my-reference.png"           # 사용자 파일
            legacy_file = mvhub / "image1.png"               # 접두 없는 구버전 업로드
            for p in (app_file, user_file, legacy_file):
                p.write_bytes(b"x")
                old = time.time() - 3 * 86400
                os.utime(p, (old, old))

            with mock.patch.object(
                temp_sweeper, "_comfy_input_mvhub_dir", return_value=mvhub
            ), mock.patch.object(temp_sweeper, "MEDIA_DIR", Path(d) / "media"):
                stats = temp_sweeper.sweep_once()

            self.assertFalse(app_file.exists())
            self.assertTrue(user_file.exists())
            self.assertTrue(legacy_file.exists())
            self.assertEqual(stats["comfy_inputs"], 1)

    def test_missing_dirs_are_harmless(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            with mock.patch.object(temp_sweeper, "MEDIA_DIR", Path(d) / "nope"):
                stats = temp_sweeper.sweep_once()
        self.assertEqual(stats["thumb_source_parts"], 0)
        self.assertEqual(stats["thumb_tmps"], 0)


if __name__ == "__main__":
    unittest.main()
