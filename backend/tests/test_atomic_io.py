"""원자적 파일 저장(atomic_write_text) 불변식 — 잘린 파일·tmp 잔재 없음."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services.atomic_io import atomic_write_text


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_writes_and_reads_back(self):
        p = self.dir / "a.json"
        atomic_write_text(p, '{"x": 1}')
        self.assertEqual(p.read_text("utf-8"), '{"x": 1}')

    def test_overwrite_replaces_atomically(self):
        p = self.dir / "b.json"
        atomic_write_text(p, "old")
        atomic_write_text(p, "new-longer-content")
        self.assertEqual(p.read_text("utf-8"), "new-longer-content")

    def test_creates_parent_dirs(self):
        p = self.dir / "sub" / "deep" / "c.json"
        atomic_write_text(p, "hi")
        self.assertEqual(p.read_text("utf-8"), "hi")

    def test_no_tmp_leftover(self):
        p = self.dir / "d.json"
        atomic_write_text(p, "content")
        # 성공적으로 교체되면 대상 파일 1개만, .tmp 잔재 없어야.
        leftovers = [f.name for f in self.dir.iterdir() if f.name != "d.json"]
        self.assertEqual(leftovers, [], f"tmp 잔재가 남음: {leftovers}")

    def test_failure_preserves_original_and_cleans_tmp(self):
        # ★교체(os.replace) 실패 시: 기존 완전본이 보존되고 tmp 잔재가 없어야(원자성의 핵심).
        p = self.dir / "f.json"
        atomic_write_text(p, "original")
        with mock.patch("app.services.atomic_io.os.replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                atomic_write_text(p, "half-written-new")
        self.assertEqual(p.read_text("utf-8"), "original")  # 기존본 그대로
        leftovers = [f.name for f in self.dir.iterdir() if f.name != "f.json"]
        self.assertEqual(leftovers, [], f"실패 후 tmp 잔재: {leftovers}")

    def test_utf8_roundtrip(self):
        p = self.dir / "e.json"
        atomic_write_text(p, '{"name": "제이", "note": "한글·特殊"}')
        self.assertEqual(p.read_text("utf-8"), '{"name": "제이", "note": "한글·特殊"}')


if __name__ == "__main__":
    unittest.main()
