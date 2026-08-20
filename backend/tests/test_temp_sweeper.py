"""임시파일 청소기 회귀 테스트 — 묵은 잔재만 지우고 신선한(진행 중) 파일은 보존."""

import os
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app.services import media_cache, temp_sweeper, thumbs


class TempSweeperTests(unittest.TestCase):
    def setUp(self):
        self._quota_state_patch = mock.patch.object(
            media_cache,
            "_PRESERVED_QUOTA_STATE",
            media_cache._PreservedQuotaState(),
        )
        self._quota_state_patch.start()

    def tearDown(self):
        self._quota_state_patch.stop()

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

            with (
                mock.patch.object(temp_sweeper, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "MEDIA_DIR", root),
            ):
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
            ), mock.patch.object(
                temp_sweeper, "MEDIA_DIR", Path(d) / "media"
            ), mock.patch.object(media_cache, "MEDIA_DIR", Path(d) / "media"):
                stats = temp_sweeper.sweep_once()

            self.assertFalse(app_file.exists())
            self.assertTrue(user_file.exists())
            self.assertTrue(legacy_file.exists())
            self.assertEqual(stats["comfy_inputs"], 1)

    def test_missing_dirs_are_harmless(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            with mock.patch.object(
                temp_sweeper, "MEDIA_DIR", Path(d) / "nope"
            ), mock.patch.object(media_cache, "MEDIA_DIR", Path(d) / "nope"):
                stats = temp_sweeper.sweep_once()
        self.assertEqual(stats["thumb_source_parts"], 0)
        self.assertEqual(stats["thumb_tmps"], 0)

    def test_stale_db_import_temp_is_removed_but_unrelated_db_is_preserved(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            root = Path(d)
            stale_import = root / "mvhub-import-deadbeef.db"
            unrelated = root / "another-app-import.db"
            for path in (stale_import, unrelated):
                path.write_bytes(b"db")
                old = time.time() - 3 * 86400
                os.utime(path, (old, old))

            with mock.patch.object(
                temp_sweeper.tempfile, "gettempdir", return_value=str(root)
            ), mock.patch.object(
                temp_sweeper, "MEDIA_DIR", root / "media"
            ), mock.patch.object(media_cache, "MEDIA_DIR", root / "media"):
                stats = temp_sweeper.sweep_once()

            self.assertFalse(stale_import.exists())
            self.assertTrue(unrelated.exists())
            self.assertEqual(stats["temp_exports"], 1)

    def test_stale_comfy_staging_is_removed_but_unrelated_file_is_preserved(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            root = Path(d)
            staged = root / "mvhub-comfy-input-deadbeef.part"
            converted = root / "mvhub-comfy-converted-deadbeef.mp4"
            unrelated = root / "comfy-input-deadbeef.part"
            for path in (staged, converted, unrelated):
                path.write_bytes(b"x")
                old = time.time() - 3 * 86400
                os.utime(path, (old, old))

            with mock.patch.object(
                temp_sweeper.tempfile, "gettempdir", return_value=str(root)
            ), mock.patch.object(
                temp_sweeper, "MEDIA_DIR", root / "media"
            ), mock.patch.object(media_cache, "MEDIA_DIR", root / "media"):
                stats = temp_sweeper.sweep_once()

            self.assertFalse(staged.exists())
            self.assertFalse(converted.exists())
            self.assertTrue(unrelated.exists())
            self.assertEqual(stats["comfy_staging"], 2)

    def test_daily_sweep_recalculates_preserved_usage_after_external_changes(self):
        with TemporaryDirectory(ignore_cleanup_errors=True) as d:
            root = Path(d) / "media"
            old = root / "aa" / "old.mp4"
            old.parent.mkdir(parents=True)
            old.write_bytes(b"o" * 8)
            state = media_cache._PreservedQuotaState()

            with (
                mock.patch.object(temp_sweeper, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "MEDIA_DIR", root),
                mock.patch.object(media_cache, "_PRESERVED_QUOTA_STATE", state),
                mock.patch.object(temp_sweeper, "_comfy_input_mvhub_dir", return_value=None),
                mock.patch.object(thumbs, "evict_thumb_cache", return_value=0),
                mock.patch.object(media_cache, "evict_thumb_source_cache", return_value=0),
            ):
                self.assertEqual(media_cache.recalculate_preserved_media_usage(), 8)
                old.unlink()
                added = root / "bb" / "added.mp4"
                added.parent.mkdir(parents=True)
                added.write_bytes(b"n" * 3)

                temp_sweeper.sweep_once()

            self.assertTrue(state.initialized)
            self.assertEqual(state.total_bytes, 3)


if __name__ == "__main__":
    unittest.main()
