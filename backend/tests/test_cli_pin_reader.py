"""CLI pin(hf_cli_version.txt) 읽기 규칙 단일화 계약 — BOM·첫 줄·폴백."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services.read_utf8_sig_first_line import read_first_line


class ReadFirstLineContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, data: bytes) -> Path:
        path = self.root / "hf_cli_version.txt"
        path.write_bytes(data)
        return path

    def test_bom_and_plain_files_read_identically(self):
        with_bom = self._write("﻿  1.2.3  \n".encode("utf-8"))
        self.assertEqual(read_first_line(with_bom), "1.2.3")
        plain = self._write(b"  1.2.3  \n")
        self.assertEqual(read_first_line(plain), "1.2.3")

    def test_empty_and_whitespace_only_return_empty_string(self):
        self.assertEqual(read_first_line(self._write(b"")), "")
        self.assertEqual(read_first_line(self._write(b"   \n  \n")), "")

    def test_multi_line_file_uses_first_line_only(self):
        path = self._write(b"1.2.3\nnotes: ignore me\n")
        self.assertEqual(read_first_line(path), "1.2.3")

    def test_missing_file_raises_oserror(self):
        with self.assertRaises(OSError):
            read_first_line(self.root / "no-such-file.txt")

    def test_invalid_utf8_raises_decode_error(self):
        path = self._write(b"\xff\xfe\x00invalid")
        with self.assertRaises(ValueError):
            read_first_line(path)


class PinCallerFallbackTests(unittest.TestCase):
    """호출부 3곳(main·ingest run-bat·release 검사)의 폴백 매핑이 유지되는지."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_main_pinned_cli_version_maps_missing_and_empty_to_none(self):
        from app import main

        backend_dir = self.root / "backend"
        backend_dir.mkdir()
        with mock.patch.object(main, "BACKEND_DIR", backend_dir):
            self.assertIsNone(main._pinned_cli_version())  # 파일 부재
            (self.root / "hf_cli_version.txt").write_text("   \n", encoding="utf-8")
            self.assertIsNone(main._pinned_cli_version())  # 공백뿐
            (self.root / "hf_cli_version.txt").write_text(
                "﻿1.1.23\n", encoding="utf-8"
            )
            self.assertEqual(main._pinned_cli_version(), "1.1.23")  # BOM 제거·첫 줄


if __name__ == "__main__":
    unittest.main()
