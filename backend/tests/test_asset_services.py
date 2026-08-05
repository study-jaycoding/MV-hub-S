"""Assets 디스크 서비스의 원자성·정리 동작 회귀 테스트."""

from __future__ import annotations

import asyncio
import hashlib
import io
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from starlette.datastructures import UploadFile

from app.routers import assets
from app.services import asset_io, asset_mounts


class _ChunkUpload:
    def __init__(self, *chunks: bytes):
        self._chunks = list(chunks)

    async def read(self, _size: int = -1) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class AssetIoTests(unittest.TestCase):
    def test_stream_upload_writes_chunks_and_digest(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            payload = b"first-second"
            result = asyncio.run(
                asset_io.stream_upload_tmp(
                    _ChunkUpload(b"first-", b"second"),
                    root,
                    max_bytes=100,
                )
            )
            tmp, size, digest = result

            self.assertEqual(tmp.read_bytes(), payload)
            self.assertEqual(size, len(payload))
            self.assertEqual(digest, hashlib.sha256(payload).hexdigest())

    def test_stream_upload_removes_partial_file_over_limit(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            with self.assertRaises(asset_io.UploadTooLarge):
                asyncio.run(
                    asset_io.stream_upload_tmp(
                        _ChunkUpload(b"1234", b"5678"),
                        root,
                        max_bytes=5,
                    )
                )

            self.assertEqual(list(root.glob(".upload-*.part")), [])

    def test_commit_unique_never_overwrites_existing_file(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "image.png").write_bytes(b"old")
            pending = root / ".pending.part"
            pending.write_bytes(b"new")

            target = asset_io.commit_unique_tmp(pending, root, "image.png")

            self.assertEqual(target.name, "image_2.png")
            self.assertEqual((root / "image.png").read_bytes(), b"old")
            self.assertEqual(target.read_bytes(), b"new")
            self.assertFalse(pending.exists())

    def test_commit_unique_removes_temp_after_fatal_filesystem_error(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            pending = root / ".pending.part"
            pending.write_bytes(b"new")

            with (
                patch.object(asset_io.os, "link", side_effect=OSError("no links")),
                patch.object(asset_io.os, "open", side_effect=PermissionError("denied")),
                self.assertRaises(PermissionError),
            ):
                asset_io.commit_unique_tmp(pending, root, "image.png")

            self.assertFalse(pending.exists())

    def test_find_same_media_hashes_only_same_size_candidates(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "small.png").write_bytes(b"123")
            match = root / "match.png"
            match.write_bytes(b"1234")

            with patch.object(asset_io, "sha256_file", return_value="digest") as sha:
                found = asset_io.find_same_media(root, "digest", "image", size=4)

            self.assertEqual(found, match)
            sha.assert_called_once_with(match)

    def test_assets_upload_route_saves_and_invalidates_tree(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            upload = UploadFile(
                filename="frame.png",
                file=io.BytesIO(b"test-image"),
            )
            with (
                patch.object(assets, "_safe_project_dir", return_value=root),
                patch.object(assets.asset_tree, "invalidate_project_tree") as invalidate,
            ):
                result = asyncio.run(
                    assets.upload_assets(
                        SimpleNamespace(),
                        project="demo",
                        dir="",
                        files=[upload],
                    )
                )

            self.assertEqual(result, {"saved": ["frame.png"], "skipped": []})
            self.assertEqual((root / "frame.png").read_bytes(), b"test-image")
            invalidate.assert_called_once_with(root)


class AssetMountStoreTests(unittest.TestCase):
    def test_owner_mounts_migrates_only_legacy_entries(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            path = Path(tmp_dir) / "mounts.json"
            asset_mounts.save(
                path,
                [
                    {"name": "legacy", "path": "C:/legacy", "owner": ""},
                    {"name": "mine", "path": "C:/mine", "owner": "me"},
                    {"name": "other", "path": "C:/other", "owner": "other"},
                ],
            )

            mine = asset_mounts.owner_mounts(path, "me", "legacy-worker")
            persisted = asset_mounts.load(path)

            self.assertEqual([mount["name"] for mount in mine], ["legacy", "mine"])
            self.assertEqual(persisted[0]["owner"], "me")
            self.assertEqual(persisted[2]["owner"], "other")

    def test_concurrent_upserts_do_not_lose_mounts(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            path = Path(tmp_dir) / "mounts.json"

            def add(index: int) -> None:
                asset_mounts.upsert(
                    path,
                    name=f"project-{index}",
                    location=f"C:/project-{index}",
                    owner="me",
                )

            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(add, range(24)))

            mounts = asset_mounts.load(path)
            self.assertEqual(len(mounts), 24)
            self.assertEqual(
                {mount["name"] for mount in mounts},
                {f"project-{i}" for i in range(24)},
            )

    def test_remove_preserves_same_name_owned_by_another_account(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            path = Path(tmp_dir) / "mounts.json"
            asset_mounts.save(
                path,
                [
                    {"name": "shared", "path": "C:/mine", "owner": "me"},
                    {"name": "shared", "path": "C:/other", "owner": "other"},
                ],
            )

            asset_mounts.remove(path, name="shared", owner="me")

            self.assertEqual(
                asset_mounts.load(path),
                [{"name": "shared", "path": "C:/other", "owner": "other"}],
            )


if __name__ == "__main__":
    unittest.main()
