"""다운로드 각인 배선 — 내려주는 사본에만 새기고, 보관 원본은 건드리지 않는다.

로컬 보관본(/media/...)은 여러 생성물이 같은 파일을 가리킬 수 있고 썸네일·미리보기도 같은
바이트를 읽는다. 그래서 원본에 새기면 안 되고, 내려보내는 사본에만 새겨야 한다.
"""
from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from PIL import Image

from app.routers import library
from app.services import file_stamp


def _png(path: Path) -> None:
    buf = io.BytesIO()
    Image.new("RGB", (6, 4), (200, 30, 90)).save(buf, format="PNG")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.getvalue())


class DownloadStampTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.media = Path(self.tmp.name)
        self.src = self.media / "ab" / "shot.png"
        _png(self.src)
        self.original = self.src.read_bytes()
        self.patches = [
            patch.object(library, "MEDIA_DIR", self.media),
            patch.object(
                library.file_stamp, "tags_for_generation",
                lambda gen_id: file_stamp.build_tags(gen_id, "job-1"),
            ),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _download(self, gen_id=None):
        return library.download_media(
            BackgroundTasks(), url="/media/ab/shot.png", name="shot.png", gen_id=gen_id
        )

    def test_stamps_the_copy_and_leaves_the_stored_file_alone(self):
        response = self._download(gen_id="gen-1")

        served = Path(response.path)
        self.assertNotEqual(served, self.src)  # 사본을 내려준다
        self.assertEqual(file_stamp.gen_id_of(file_stamp.read_stamp(served)), "gen-1")
        self.assertEqual(self.src.read_bytes(), self.original)  # 보관 원본 불변

    def test_without_gen_id_serves_the_stored_file_unchanged(self):
        response = self._download()

        self.assertEqual(Path(response.path), self.src)
        self.assertEqual(file_stamp.read_stamp(Path(response.path)), {})

    def test_path_traversal_is_rejected(self):
        with self.assertRaises(HTTPException) as caught:
            library.download_media(
                BackgroundTasks(), url="/media/../secret.png", name="x.png", gen_id="gen-1"
            )

        self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
