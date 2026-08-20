"""소스 재매칭(relink/prune) 스캔 회귀 테스트.

배경: 트리 캐시 리팩터링 때 assets.py 의 _hidden 이 asset_tree 로 이사하면서
_index_by_sha 호출부만 남아 NameError → /sources/relink·prune 전면 500 이 났다.
스캔 헬퍼를 직접 호출해 이름 해석이 다시 깨지면 즉시 잡는다.
"""

import hashlib
import tempfile
import unittest
from pathlib import Path

from app.routers.assets import _index_by_sha


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class AssetSourceRelinkScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_scan_finds_wanted_media_by_content(self):
        data = b"fake-png-bytes"
        (self.root / "cut01.png").write_bytes(data)
        (self.root / "other.png").write_bytes(b"different")
        index, scanned_all = _index_by_sha(self.root, {_sha(data)})
        self.assertTrue(scanned_all)
        self.assertEqual(index, {_sha(data): "cut01.png"})

    def test_hidden_folders_are_excluded(self):
        data = b"hidden-media"
        hidden_dir = self.root / ".mvhub"
        hidden_dir.mkdir()
        (hidden_dir / "cut02.png").write_bytes(data)
        underscore_dir = self.root / "_work"
        underscore_dir.mkdir()
        (underscore_dir / "cut03.png").write_bytes(data)
        index, scanned_all = _index_by_sha(self.root, {_sha(data)})
        self.assertTrue(scanned_all)
        self.assertEqual(index, {})

    def test_non_media_files_are_ignored(self):
        data = b"not-media"
        (self.root / "notes.txt").write_bytes(data)
        index, scanned_all = _index_by_sha(self.root, {_sha(data)})
        self.assertTrue(scanned_all)
        self.assertEqual(index, {})


if __name__ == "__main__":
    unittest.main()
