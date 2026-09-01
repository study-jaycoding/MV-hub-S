"""Assets 디스크 서비스의 원자성·정리 동작 회귀 테스트."""

from __future__ import annotations

import asyncio
import hashlib
import io
import tempfile
import threading
import time
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

    def test_stream_upload_uses_non_abandon_writes_in_chunk_order(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            chunks: list[bytes] = []

            async def non_abandon(write, chunk):
                chunks.append(chunk)
                return write(chunk)

            with patch.object(
                asset_io,
                "to_thread_non_abandon",
                side_effect=non_abandon,
            ) as offload:
                tmp, size, digest = asyncio.run(
                    asset_io.stream_upload_tmp(
                        _ChunkUpload(b"first", b"second"),
                        root,
                        max_bytes=100,
                    )
                )

            self.assertEqual(chunks, [b"first", b"second"])
            self.assertEqual(offload.await_count, 2)
            self.assertEqual(tmp.read_bytes(), b"firstsecond")
            self.assertEqual(size, len(b"firstsecond"))
            self.assertEqual(digest, hashlib.sha256(b"firstsecond").hexdigest())

    def test_stream_upload_removes_partial_file_on_base_exception(self) -> None:
        class CancelledUpload:
            calls = 0

            async def read(inner_self, _size: int = -1) -> bytes:
                inner_self.calls += 1
                if inner_self.calls == 1:
                    return b"partial"
                raise asyncio.CancelledError()

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(asset_io.stream_upload_tmp(CancelledUpload(), root))

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

    def test_find_or_commit_serializes_normalized_key_and_reclaims_waiters(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            alias_part = root / "alias"
            alias_part.mkdir()
            first_tmp = root / ".first.part"
            second_tmp = root / ".second.part"
            payload = b"same-image"
            first_tmp.write_bytes(payload)
            second_tmp.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            commit_entered = threading.Event()
            release_commit = threading.Event()
            original_commit = asset_io.commit_unique_tmp

            def slow_commit(*args):
                commit_entered.set()
                self.assertTrue(release_commit.wait(timeout=1.0))
                return original_commit(*args)

            with (
                patch.object(asset_io, "commit_unique_tmp", side_effect=slow_commit) as commit,
                ThreadPoolExecutor(max_workers=2) as pool,
            ):
                first = pool.submit(
                    asset_io.find_or_commit_media,
                    first_tmp,
                    root,
                    "first.png",
                    digest,
                    "image",
                    len(payload),
                )
                self.assertTrue(commit_entered.wait(timeout=1.0))
                second = pool.submit(
                    asset_io.find_or_commit_media,
                    second_tmp,
                    alias_part / "..",
                    "second.png",
                    digest,
                    "image",
                    len(payload),
                )
                deadline = time.monotonic() + 1.0
                while True:
                    with asset_io._MEDIA_COMMIT_LOCKS_GUARD:
                        refcounts = [entry[1] for entry in asset_io._MEDIA_COMMIT_LOCKS.values()]
                    if refcounts == [2]:
                        break
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.001)
                release_commit.set()
                results = [first.result(timeout=1.0), second.result(timeout=1.0)]

            self.assertEqual(commit.call_count, 1)
            self.assertEqual(results[0][0], results[1][0])
            self.assertEqual(sorted(reused for _, reused in results), [False, True])
            self.assertEqual([path.name for path in root.glob("*.png")], ["first.png"])
            self.assertFalse(first_tmp.exists())
            self.assertFalse(second_tmp.exists())
            self.assertEqual(asset_io._MEDIA_COMMIT_LOCKS, {})

    def test_find_or_commit_different_keys_do_not_block_each_other(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            payloads = (b"a", b"b")
            pending = (root / ".a.part", root / ".b.part")
            for path, payload in zip(pending, payloads):
                path.write_bytes(payload)
            both_entered = threading.Event()
            release_commits = threading.Event()
            entered = 0
            entered_guard = threading.Lock()
            original_commit = asset_io.commit_unique_tmp

            def parallel_commit(*args):
                nonlocal entered
                with entered_guard:
                    entered += 1
                    if entered == 2:
                        both_entered.set()
                release_commits.wait(timeout=1.0)
                return original_commit(*args)

            with (
                patch.object(asset_io, "commit_unique_tmp", side_effect=parallel_commit),
                ThreadPoolExecutor(max_workers=2) as pool,
            ):
                futures = [
                    pool.submit(
                        asset_io.find_or_commit_media,
                        pending[index],
                        root,
                        f"{index}.png",
                        hashlib.sha256(payload).hexdigest(),
                        "image",
                        len(payload),
                    )
                    for index, payload in enumerate(payloads)
                ]
                ran_in_parallel = both_entered.wait(timeout=1.0)
                release_commits.set()
                results = [future.result(timeout=1.0) for future in futures]

            self.assertTrue(ran_in_parallel)
            self.assertEqual([reused for _, reused in results], [False, False])
            self.assertEqual(asset_io._MEDIA_COMMIT_LOCKS, {})

    def test_find_or_commit_failure_cleans_temp_and_registry(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            pending = root / ".pending.part"
            pending.write_bytes(b"image")

            with (
                patch.object(asset_io, "find_same_media", side_effect=RuntimeError("hash failed")),
                self.assertRaisesRegex(RuntimeError, "hash failed"),
            ):
                asset_io.find_or_commit_media(
                    pending,
                    root,
                    "image.png",
                    "digest",
                    "image",
                    5,
                )

            self.assertFalse(pending.exists())
            self.assertEqual(asset_io._MEDIA_COMMIT_LOCKS, {})

    def test_find_or_commit_preserves_hash_kind_and_size_reuse_criteria(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            payload = b"same"
            digest = hashlib.sha256(payload).hexdigest()
            existing = root / "existing.png"
            existing.write_bytes(payload)

            kind_tmp = root / ".kind.part"
            kind_tmp.write_bytes(payload)
            kind_target, kind_reused = asset_io.find_or_commit_media(
                kind_tmp,
                root,
                "clip.mp4",
                digest,
                "video",
                len(payload),
            )

            hash_tmp = root / ".hash.part"
            hash_payload = b"diff"
            hash_tmp.write_bytes(hash_payload)
            hash_target, hash_reused = asset_io.find_or_commit_media(
                hash_tmp,
                root,
                "different.png",
                hashlib.sha256(hash_payload).hexdigest(),
                "image",
                len(hash_payload),
            )

            reuse_tmp = root / ".reuse.part"
            reuse_tmp.write_bytes(payload)
            reused_target, reused = asset_io.find_or_commit_media(
                reuse_tmp,
                root,
                "reuse.png",
                digest,
                "image",
                len(payload),
            )

            size_tmp = root / ".size.part"
            size_tmp.write_bytes(payload)
            size_target, size_reused = asset_io.find_or_commit_media(
                size_tmp,
                root,
                "size.png",
                digest,
                "image",
                len(payload) + 1,
            )

            self.assertEqual(kind_target.name, "clip.mp4")
            self.assertFalse(kind_reused)
            self.assertEqual(hash_target.name, "different.png")
            self.assertFalse(hash_reused)
            self.assertEqual(reused_target, existing)
            self.assertTrue(reused)
            self.assertEqual(size_target.name, "size.png")
            self.assertFalse(size_reused)
            self.assertFalse(reuse_tmp.exists())

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

    def test_capture_route_saves_image_without_leaving_temp_file(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            upload = UploadFile(filename="capture.png", file=io.BytesIO(b"capture-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree"),
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon) as offload,
            ):
                result = asyncio.run(assets.upload_capture(SimpleNamespace(), upload))

            self.assertEqual(result["project"], "captures")
            self.assertEqual((root / "captures" / result["path"]).read_bytes(), b"capture-image")
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offload.await_count, 1)
            # 커밋+토큰 부기 원자화 래퍼가 스레드로 offload 된다(안에서 find_or_commit_media 호출)
            self.assertEqual(offloaded, [assets._commit_capture_with_discard_token])
            self.assertTrue(result["discard_token"])  # 신규 파일 — 정리 토큰 발급

    def test_reference_import_route_saves_media_and_cleans_temp_on_failure(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            upload = UploadFile(filename="reference.png", file=io.BytesIO(b"reference-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree"),
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon) as offload,
            ):
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), files=[upload])
                )

            saved = result["saved"][0]
            self.assertEqual(saved["project"], "imports")
            self.assertEqual((root / "imports" / saved["path"]).read_bytes(), b"reference-image")
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offload.await_count, 1)
            self.assertEqual(offloaded, [asset_io.find_or_commit_media])

            failed = UploadFile(filename="broken.png", file=io.BytesIO(b"broken-image"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                # AIO-2 계약 변경: 라우터는 검색과 확정을 분리하지 않고 이 함수 한 번에 위임한다.
                patch.object(asset_io, "find_or_commit_media", side_effect=RuntimeError("hash failed")),
                self.assertRaises(RuntimeError),
            ):
                asyncio.run(assets.upload_reference_import(SimpleNamespace(), files=[failed]))

            self.assertEqual(list(root.rglob(".upload-*.part")), [])


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
