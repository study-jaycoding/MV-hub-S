"""Assets 디스크 서비스의 원자성·정리 동작 회귀 테스트."""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
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
            calls: list[str] = []

            async def non_abandon(func, *args, **kwargs):
                calls.append(func.__name__)
                return func(*args, **kwargs)

            with (
                patch.object(asset_io, "to_thread_non_abandon", side_effect=non_abandon),
                self.assertRaises(asset_io.UploadTooLarge),
            ):
                asyncio.run(
                    asset_io.stream_upload_tmp(
                        _ChunkUpload(b"1234", b"5678"),
                        root,
                        max_bytes=5,
                    )
                )

            self.assertEqual(calls, ["_open_part", "write", "close", "unlink"])
            self.assertEqual(list(root.glob(".upload-*.part")), [])

    def test_stream_upload_uses_non_abandon_writes_in_chunk_order(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            chunks: list[bytes] = []

            calls: list[str] = []

            async def non_abandon(func, *args, **kwargs):
                calls.append(func.__name__)
                if args and isinstance(args[0], bytes):
                    chunks.append(args[0])
                return func(*args, **kwargs)

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
            self.assertEqual(calls, ["_open_part", "write", "write", "close"])
            self.assertEqual(offload.await_count, 4)
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
            calls: list[str] = []

            async def non_abandon(func, *args, **kwargs):
                calls.append(func.__name__)
                return func(*args, **kwargs)

            with (
                patch.object(asset_io, "to_thread_non_abandon", side_effect=non_abandon),
                self.assertRaises(asyncio.CancelledError),
            ):
                asyncio.run(asset_io.stream_upload_tmp(CancelledUpload(), root))

            self.assertEqual(calls, ["_open_part", "write", "close", "unlink"])
            self.assertEqual(list(root.glob(".upload-*.part")), [])

    def test_stream_upload_closes_handle_when_cancelled_after_open(self) -> None:
        """open 스레드 완료 직후 취소돼 반환값을 못 받아도 Windows 핸들을 닫고 .part를 지운다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            calls: list[str] = []

            async def cancel_after_open(func, *args, **kwargs):
                calls.append(func.__name__)
                result = func(*args, **kwargs)
                if func.__name__ == "_open_part":
                    raise asyncio.CancelledError
                return result

            with (
                patch.object(asset_io, "to_thread_non_abandon", side_effect=cancel_after_open),
                self.assertRaises(asyncio.CancelledError),
            ):
                asyncio.run(asset_io.stream_upload_tmp(_ChunkUpload(b"unused"), root))

            self.assertEqual(calls, ["_open_part", "close", "unlink"])
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
        # ★2026-09-29 Jay "옛 방식": 붙여넣기·부분수정 그림은 **이 PC 설치 폴더의 captures** 에 둔다.
        #  폼의 project 는 받되 쓰지 않는다(NAS 프로젝트 폴더로 올리지 않는다).
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            nas = root / "nas"
            nas.mkdir()
            upload = UploadFile(filename="capture.png", file=io.BytesIO(b"capture-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=nas),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree") as combined,
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon),
            ):
                result = asyncio.run(
                    assets.upload_capture(SimpleNamespace(), project="proj", file=upload)
                )

            self.assertEqual(result["project"], "captures")
            self.assertNotIn("/", result["path"])  # 설치 폴더 captures 바로 아래
            self.assertEqual((root / "captures" / result["path"]).read_bytes(), b"capture-image")
            self.assertEqual(list(nas.iterdir()), [])  # NAS 쪽에는 아무것도 안 생긴다
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offloaded, [assets._commit_capture_with_discard_token])
            self.assertTrue(result["discard_token"])  # 신규 파일 — 정리 토큰 발급
            self.assertTrue(result["sha256"])  # 씬 참조의 내용 지문
            combined.assert_called_once_with(root, assets._INTERNAL_FOLDERS)  # Assets 의 imp/cap 합본

    def test_reference_import_route_saves_media_and_cleans_temp_on_failure(self) -> None:
        # ★2026-09-29 Jay "옛 방식": 끌어다 놓은 파일은 **이 PC 설치 폴더의 imports** 에 둔다.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            nas = root / "nas"
            nas.mkdir()
            upload = UploadFile(filename="reference.png", file=io.BytesIO(b"reference-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=nas),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree") as combined,
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon),
            ):
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[upload])
                )

            saved = result["saved"][0]
            self.assertEqual(saved["project"], "imports")
            self.assertEqual(saved["path"], "reference.png")  # 설치 폴더 imports 바로 아래
            self.assertEqual((root / "imports" / saved["path"]).read_bytes(), b"reference-image")
            self.assertEqual(list(nas.iterdir()), [])  # NAS 쪽에는 아무것도 안 생긴다
            self.assertEqual(saved["bytes"], len(b"reference-image"))
            self.assertTrue(saved["sha256"])  # 나중에 내용으로 다시 찾기 위한 지문
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offloaded, [asset_io.find_or_commit_media])
            combined.assert_called_once_with(root, assets._INTERNAL_FOLDERS)  # Assets 의 imp/cap 합본

            failed = UploadFile(filename="broken.png", file=io.BytesIO(b"broken-image"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                # AIO-2 계약 변경: 라우터는 검색과 확정을 분리하지 않고 이 함수 한 번에 위임한다.
                patch.object(asset_io, "find_or_commit_media", side_effect=RuntimeError("hash failed")),
                self.assertRaises(RuntimeError),
            ):
                asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[failed])
                )

            self.assertEqual(list(root.rglob(".upload-*.part")), [])

    def test_reference_import_keeps_the_file_on_this_pc_without_scanning_the_project(self) -> None:
        """★2026-09-29 Jay "옛 방식으로 해야한다": 반입은 NAS 프로젝트 폴더를 훑지 않고 이 PC 설치
        폴더에 둔다 — 프로젝트에 같은 내용이 있어도 그렇다. 서버 원본으로 잇는 일은 자동 복구(/locate)가
        한다. (09-28 에는 여기서 프로젝트 전체를 훑어 끌어다 놓을 때마다 2초대가 걸렸다.)"""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            proj = root / "proj"
            (proj / "BG").mkdir(parents=True)
            (proj / "BG" / "sea.png").write_bytes(b"same-bytes")  # 서버에도 같은 내용이 있다

            upload = UploadFile(filename="sea.png", file=io.BytesIO(b"same-bytes"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                patch.object(assets, "_build_index", side_effect=AssertionError("반입은 NAS 를 훑지 않는다")),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree"),
            ):
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[upload])
                )

            saved = result["saved"][0]
            self.assertEqual((saved["project"], saved["path"]), ("imports", "sea.png"))
            self.assertEqual((root / "imports" / "sea.png").read_bytes(), b"same-bytes")
            self.assertFalse((proj / "imports").exists())  # 프로젝트 폴더는 건드리지 않는다
            self.assertEqual(list(root.rglob(".upload-*.part")), [])

    def test_locate_moves_legacy_local_copies_to_project_originals(self) -> None:
        """옛 씬의 '이 PC 안 사본' 토큰을 내용이 같은 프로젝트 원본으로 바꿔 준다(자동 복구).
        여러 프로젝트에 같은 파일이 있으면 어느 것인지 단정할 수 없어 바꾸지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "sea.png").write_bytes(b"same-bytes")
            (root / "imports" / "only-here.png").write_bytes(b"nowhere-else")
            (root / "imports" / "both.png").write_bytes(b"in-two-places")
            proj_a = root / "A"
            (proj_a / "BG").mkdir(parents=True)
            (proj_a / "BG" / "sea.png").write_bytes(b"same-bytes")
            (proj_a / "both.png").write_bytes(b"in-two-places")
            proj_b = root / "B"
            proj_b.mkdir()
            (proj_b / "both.png").write_bytes(b"in-two-places")

            dirs = {"A": proj_a, "B": proj_b}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(
                    assets, "_auto_project_mounts", return_value=[{"name": "A"}, {"name": "B"}]
                ),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=[
                            "asset:imports|sea.png",
                            "asset:imports|only-here.png",
                            "asset:imports|both.png",
                            "asset:A|BG/sea.png",  # 이미 프로젝트 기준 — 건드리지 않는다
                        ]
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual(
                reply["fixed"],
                [{"project": "A", "path": "BG/sea.png", "sha256": hashlib.sha256(b"same-bytes").hexdigest(),
                  "bytes": len(b"same-bytes"), "token": "asset:imports|sea.png"}],
            )
            self.assertEqual(
                reply["unresolved"],
                ["asset:imports|only-here.png", "asset:imports|both.png", "asset:A|BG/sea.png"],
            )

            # 개인 등록 폴더만 있어도 찾는다 — 이름이 한쪽에만 있으면 어느 PC 에서나 같은 뜻이다
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[]),
                patch.object(assets, "_owner_mounts", return_value=[{"name": "A"}]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                manual_only = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:imports|sea.png"]), SimpleNamespace()
                )
            self.assertEqual([(f["project"], f["path"]) for f in manual_only["fixed"]], [("A", "BG/sea.png")])

            # 이름이 개인·PM 양쪽에 등록돼 있어도 찾는다 — 둘 다 같은 서버(NAS)를 가리키므로
            # 어느 쪽에서 찾든 같은 파일이다(Jay 2026-09-28).
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(
                    assets,
                    "_auto_project_mounts",
                    return_value=[{"name": "A", "path": str(proj_a), "project_id": "p1"}],
                ),
                patch.object(assets, "_owner_mounts", return_value=[{"name": "A", "path": str(proj_a)}]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                both_sides = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:imports|sea.png"]), SimpleNamespace()
                )
            self.assertEqual(
                [(f["project"], f["path"]) for f in both_sides["fixed"]], [("A", "BG/sea.png")]
            )

    def test_locate_treats_one_folder_registered_twice_as_one_file(self) -> None:
        """같은 폴더를 두 이름·두 깊이로 등록했을 때 — 한 그림이 두 곳에서 찾히지만 같은 파일이다.

        ★Jay 의 실제 구성: `뻘뻘뻘`=…\10_ai, `뻘뻘뻘_RnD`=…\10_ai\assets. 이걸 '여럿'으로 세면
        도리어 아무것도 못 고친다 — 물리 경로로 묶어 하나로 본다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            outer = root / "P"  # …/10_ai 에 해당
            (outer / "assets" / "CH").mkdir(parents=True)
            (outer / "assets" / "CH" / "hero.png").write_bytes(b"one picture")
            inner = outer / "assets"  # …/10_ai/assets 에 해당 — 같은 폴더를 더 깊이 등록

            dirs = {"P": outer, "P_RnD": inner}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[{"name": "P_RnD"}]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    # 이 PC 에 없는 제3의 이름으로 적힌 참조 — 두 등록 모두에서 같은 파일이 찾힌다
                    assets.LocateIn(tokens=["asset:다른이름|CH/hero.png"]), SimpleNamespace()
                )

            self.assertEqual(len(reply["fixed"]), 1)
            self.assertEqual(reply["fixed"][0]["token"], "asset:다른이름|CH/hero.png")
            # 어느 이름으로 잡히든 가리키는 파일은 하나다
            got = dirs[reply["fixed"][0]["project"]] / reply["fixed"][0]["path"]
            self.assertEqual(got.read_bytes(), b"one picture")

    def test_internal_folders_stay_on_this_pc_even_with_same_named_mounts(self) -> None:
        """반입은 프로젝트 없이도 된다(옛 방식). 그리고 내장 폴더 imports·captures 는 같은 이름의 등록
        폴더가 있어도 이 PC 설치 폴더로 풀린다 — 파일·썸네일·캡처 정리가 NAS 로 새지 않게(Codex)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            nas = root / "nas"
            (nas / "imports").mkdir(parents=True)
            (nas / "captures").mkdir(parents=True)
            mounts = [
                {"name": "imports", "path": str(nas / "imports")},
                {"name": "captures", "path": str(nas / "captures")},
            ]
            upload = UploadFile(filename="x.png", file=io.BytesIO(b"x"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_owner_mounts", return_value=mounts),
                patch.object(assets, "_auto_project_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets.asset_tree, "invalidate_combined_tree"),
            ):
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="", files=[upload])
                )
                (root / "captures").mkdir()
                imports_dir = assets._safe_project_dir("imports", SimpleNamespace())
                captures_dir = assets._safe_project_dir("captures", SimpleNamespace())

            self.assertEqual(result["saved"][0]["project"], "imports")
            self.assertEqual(imports_dir, (root / "imports").resolve())
            self.assertEqual(captures_dir, (root / "captures").resolve())
            self.assertEqual(list((nas / "imports").iterdir()), [])

    def test_locate_finds_by_path_but_never_by_name_alone(self) -> None:
        """사본이 없어도(남이 준 씬) 프로젝트 참조는 경로로 서버에서 찾아 잇는다 — 이름만으로는 잇지 않는다.

        ★Jay 2026-09-28: 같은 폴더를 사람마다 다른 깊이로 등록하면 같은 그림이 `CH/x.png` 도 되고
        `assets/CH/x.png` 도 된다. 에셋 창에서 끌어온 참조는 지문이 없다 — 그래서 경로 끝 두 조각 이상
        (부모 폴더/이름)으로 찾는다. ★2026-09-29: 이름만 같은 것으로 이으면 `download.jpg` 같은 흔한 이름이
        엉뚱한 그림을 붙인다 — 지문 없는 사본 참조는 잇지 않고, 한 조각(이름뿐)짜리 경로도 잇지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()  # 사본은 하나도 없다 — 남이 준 씬과 같은 상황
            proj = root / "P"
            (proj / "assets" / "CH" / "바바라").mkdir(parents=True)
            (proj / "assets" / "CH" / "바바라" / "body.png").write_bytes(b"x")
            (proj / "assets" / "CH" / "낙지").mkdir(parents=True)
            (proj / "assets" / "CH" / "낙지" / "octopus.png").write_bytes(b"y")
            (proj / "CH" / "매튜").mkdir(parents=True)
            (proj / "CH" / "매튜" / "deep.png").write_bytes(b"d")
            (proj / "only-root.png").write_bytes(b"r")

            dirs = {"P": proj}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=[
                            # 프로젝트 이름이 이 PC 에 없다 + 경로가 assets/ 만큼 짧다
                            "asset:P_RnD|CH/바바라/body.png",
                            # 반대로 참조가 더 길다(이 PC 가 더 깊이 등록) — 끝 두 조각 CH/매튜/deep.png 로 맞는다
                            "asset:P_top|art/CH/매튜/deep.png",
                            # 사본 참조인데 사본이 없고 지문도 없다 → 이름이 같아도 잇지 않는다
                            "asset:imports|octopus.png",
                            # 폴더가 다른 같은 이름 — 잇지 않는다
                            "asset:P_RnD|BG/octopus.png",
                            # 한 조각(이름뿐) — 등록 깊이를 알 수 없어 잇지 않는다
                            "asset:P_RnD|only-root.png",
                        ]
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual(
                [(f["token"], f["project"], f["path"]) for f in reply["fixed"]],
                [
                    ("asset:P_RnD|CH/바바라/body.png", "P", "assets/CH/바바라/body.png"),
                    ("asset:P_top|art/CH/매튜/deep.png", "P", "CH/매튜/deep.png"),
                ],
            )
            self.assertEqual(
                reply["unresolved"],
                ["asset:imports|octopus.png", "asset:P_RnD|BG/octopus.png", "asset:P_RnD|only-root.png"],
            )

    def test_locate_uses_the_fingerprint_a_reference_carries(self) -> None:
        """참조가 든 지문(씬 파일로 함께 온 content_sha·bytes)으로 찾는다 — 이 PC 에 사본이 없어도(2026-09-29).

        · 사본이 없는 받은 사람도 내용으로 잇는다
        · 이 PC 사본이 같은 이름의 **다른 그림**이면 참조의 지문을 믿는다 — 서버에도 없으면 '서버에 없음'
          (안 그러면 그 다른 그림이 그대로 보인다, Codex)
        · 지문이 있으면 이름이 같아도 내용이 다른 파일로는 잇지 않는다"""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "download.jpg").write_bytes(b"my own different picture")
            proj = root / "P"
            (proj / "CH").mkdir(parents=True)
            (proj / "CH" / "sent.png").write_bytes(b"the sender's picture")
            (proj / "CH" / "download.jpg").write_bytes(b"yet another picture")  # 이름만 같다
            dirs = {"P": proj}
            mounts = [{"name": "P", "path": str(proj)}]

            def fp(data: bytes) -> dict:
                return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=["asset:imports|sent.png", "asset:imports|download.jpg"],
                        fingerprints={
                            "asset:imports|sent.png": fp(b"the sender's picture"),
                            "asset:imports|download.jpg": fp(b"the sender's download"),  # 서버 어디에도 없다
                        },
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual(
                reply["fixed"],
                [{"project": "P", "path": "CH/sent.png", "sha256": hashlib.sha256(b"the sender's picture").hexdigest(),
                  "bytes": len(b"the sender's picture"), "token": "asset:imports|sent.png"}],
            )
            # 내 imports 의 download.jpg 는 다른 그림이다 — 이음도 '이 PC 에만'도 아니고 서버에 없음
            self.assertEqual(reply["missing"], ["asset:imports|download.jpg"])
            self.assertEqual(reply["local"], [])

            # 모양이 틀린 지문은 없는 것으로 본다 — 그러면 이 PC 사본의 지문으로 판정한다(이 PC 에만)
            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=["asset:imports|download.jpg"],
                        fingerprints={"asset:imports|download.jpg": {"sha256": "not-a-sha", "bytes": 5}},
                    ),
                    SimpleNamespace(),
                )
            self.assertEqual((reply["missing"], reply["local"]), ([], ["asset:imports|download.jpg"]))

    def test_locate_takes_at_most_one_batch_of_fingerprints(self) -> None:
        """지문은 한 번에 받는 토큰 수(200)까지만 받고, 처리하는 토큰의 것만 읽는다 — 무관한 지문 수만 개로
        메모리·CPU 를 쓰게 두지 않는다(Codex 2026-09-29)."""
        fp = {"sha256": "a" * 64, "bytes": 1}
        with self.assertRaises(ValidationError):
            assets.LocateIn(tokens=["asset:imports|x.png"], fingerprints={f"t{i}": fp for i in range(201)})
        self.assertEqual(
            len(assets.LocateIn(fingerprints={f"t{i}": fp for i in range(200)}).fingerprints), 200
        )

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            (proj / "CH").mkdir(parents=True)
            (proj / "CH" / "x.png").write_bytes(b"x")
            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [{"name": "P", "path": str(proj)}])
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=["asset:Q|CH/x.png"],
                        # 다른 토큰의 지문은 이 토큰의 판단에 쓰이지 않는다
                        fingerprints={"asset:Q|CH/other.png": {"sha256": "b" * 64, "bytes": 9}},
                    ),
                    SimpleNamespace(),
                )
            self.assertEqual([f["path"] for f in reply["fixed"]], ["CH/x.png"])

    def test_locate_says_nothing_about_an_unreadable_local_copy(self) -> None:
        """이 PC 사본 파일은 있는데 0바이트라 지문을 못 내면 '서버에 없음'·'이 PC 에만' 둘 다 말하지 않는다 —
        같은 그림이 서버에 있는지 알 수 없다(2026-09-29). 사본 파일이 아예 없으면 이름조차 없을 때만 서버에 없음."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "empty.png").write_bytes(b"")
            proj = root / "P"
            (proj / "BG").mkdir(parents=True)
            (proj / "BG" / "named.png").write_bytes(b"n")
            dirs = {"P": proj}
            mounts = [{"name": "P", "path": str(proj)}]
            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=["asset:imports|empty.png", "asset:imports|named.png", "asset:imports|nowhere.png"]
                    ),
                    SimpleNamespace(),
                )
            self.assertEqual(reply["fixed"], [])
            self.assertEqual(reply["local"], [])
            # named.png 는 같은 이름이 서버에 있어 모른다, empty.png 는 이 PC 에 파일이 있다
            self.assertEqual(reply["missing"], ["asset:imports|nowhere.png"])

    def test_locate_stops_when_the_local_copy_says_the_contents_differ(self) -> None:
        """사본이 있는데 내용이 같은 파일이 없으면 거기서 멈춘다.

        ★이름만 같은 다른 그림을 붙이면 조용히 **틀린 그림**이 씬에 박힌다(Codex 2026-09-28).
        근거가 센 단계(지문)를 쓸 수 있었다면, 약한 단계로 내려가지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "octopus.png").write_bytes(b"mine")
            proj = root / "P"
            (proj / "CH").mkdir(parents=True)
            (proj / "CH" / "octopus.png").write_bytes(b"a different picture")  # 이름만 같다

            dirs = {"P": proj}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:imports|octopus.png"]), SimpleNamespace()
                )

            self.assertEqual(reply["fixed"], [])
            self.assertEqual(reply["unresolved"], ["asset:imports|octopus.png"])

    def test_locate_prefers_a_path_match_over_a_name_match_in_another_project(self) -> None:
        """경로 뒷부분까지 맞는 것이 이름만 맞는 것을 이긴다 — 프로젝트가 달라도 마찬가지."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            a = root / "A"
            (a / "assets" / "CH").mkdir(parents=True)
            (a / "assets" / "CH" / "hero.png").write_bytes(b"1")  # 경로 뒷부분 일치
            b_dir = root / "B"
            b_dir.mkdir()
            (b_dir / "hero.png").write_bytes(b"2")  # 이름만 일치

            dirs = {"A": a, "B": b_dir}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(
                    assets, "_auto_project_mounts", return_value=[{"name": "A"}, {"name": "B"}]
                ),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"]), SimpleNamespace()
                )

            self.assertEqual(
                [(f["project"], f["path"]) for f in reply["fixed"]], [("A", "assets/CH/hero.png")]
            )

    def test_locate_will_not_choose_between_two_projects_with_the_same_name(self) -> None:
        """서로 다른 프로젝트에 같은 경로가 있으면 고르지 않는다 — 어느 쪽인지 단정할 수 없다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            a = root / "A"
            (a / "CH").mkdir(parents=True)
            (a / "CH" / "hero.png").write_bytes(b"1")
            b_dir = root / "B"
            (b_dir / "CH").mkdir(parents=True)
            (b_dir / "CH" / "hero.png").write_bytes(b"2")

            dirs = {"A": a, "B": b_dir}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(
                    assets, "_auto_project_mounts", return_value=[{"name": "A"}, {"name": "B"}]
                ),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"]), SimpleNamespace()
                )

            self.assertEqual(reply["fixed"], [])

    def test_locate_searches_the_scene_workspace_first(self) -> None:
        """캔버스 탭에 지정된 공간의 프로젝트 폴더부터 찾는다.

        ★Jay 2026-09-28: 탭에 공간을 걸면 Assets 폴더가 그 공간으로 좁혀진다 — 찾기도 같은
        규칙을 쓴다. 그러면 다른 프로젝트에 같은 이름이 있어도 헷갈리지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            a = root / "A"
            (a / "CH").mkdir(parents=True)
            (a / "CH" / "hero.png").write_bytes(b"in A")
            b_dir = root / "B"
            (b_dir / "CH").mkdir(parents=True)
            (b_dir / "CH" / "hero.png").write_bytes(b"in B")

            dirs = {"A": a, "B": b_dir}

            def auto(_request, workspace_id=None):
                # 'ws-1' 공간에는 A 만 등록돼 있다(Assets 목록이 좁혀지는 것과 같은 규칙).
                ma = {"name": "A", "path": str(a), "project_id": "pa"}
                mb = {"name": "B", "path": str(b_dir), "project_id": "pb"}
                return [ma] if workspace_id == "ws-1" else [ma, mb]

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", side_effect=auto),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                scoped = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"], workspace_id="ws-1"), SimpleNamespace()
                )
                wide = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"]), SimpleNamespace()
                )

            # 공간이 지정되면 그 안에서 하나로 좁혀진다
            self.assertEqual([(f["project"], f["path"]) for f in scoped["fixed"]], [("A", "CH/hero.png")])
            # 지정이 없으면 두 곳에 있어 고르지 않는다
            self.assertEqual(wide["fixed"], [])

    def _locate_env(self, root: Path, dirs: dict, auto):
        """locate 시험 공통 — 폴더 해석만 가짜로, 나머지는 실제 코드."""
        return (
            patch.object(assets, "ASSETS_ROOT", root),
            patch.object(assets, "_auto_project_mounts", side_effect=auto),
            patch.object(assets, "_owner_mounts", return_value=[]),
            patch.object(assets, "actor_id", return_value="me"),
            patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
        )

    def test_locate_reuses_the_scan_within_one_relink_and_rescans_on_the_next(self) -> None:
        """한 번의 자동 복구(scan_id) 안에서는 폴더를 한 번만 훑는다 — 200개씩 여러 번 묻는 동안
        같은 NAS 를 매번 다시 훑던 것(요청 3번 × 16초) 을 막는다. 새 복구는 다시 훑는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            proj.mkdir()
            (proj / "a.png").write_bytes(b"a")
            dirs = {"P": proj}
            scans: list[str] = []
            real = assets._build_index

            def counting(d, **kw):
                scans.append(str(d))
                return real(d, **kw)

            env = self._locate_env(root, dirs, lambda _r, _w=None: [{"name": "P"}])
            with env[0], env[1], env[2], env[3], env[4], patch.object(assets, "_build_index", side_effect=counting):
                for _ in range(3):  # 같은 복구의 배치 3개
                    assets.locate_legacy_assets(
                        assets.LocateIn(tokens=["asset:Q|a.png"], scan_id="run-1"), SimpleNamespace()
                    )
                self.assertEqual(len(scans), 1)

                assets.locate_legacy_assets(  # 다음 F5 — 새로 훑는다
                    assets.LocateIn(tokens=["asset:Q|a.png"], scan_id="run-2"), SimpleNamespace()
                )
                self.assertEqual(len(scans), 2)

                assets.locate_legacy_assets(  # 작업 id 가 없으면 예전처럼 매번 새로 훑는다
                    assets.LocateIn(tokens=["asset:Q|a.png"]), SimpleNamespace()
                )
                self.assertEqual(len(scans), 3)

    def test_locate_does_not_scan_other_projects_when_the_workspace_answers(self) -> None:
        """캔버스의 공간에서 다 찾히면 다른 프로젝트는 **아예 훑지 않는다** — 예전에는 좁히기 전에
        전부 훑어 좁히기가 속도에 아무 효과가 없었다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            mine = root / "Mine"
            (mine / "CH").mkdir(parents=True)
            (mine / "CH" / "hero.png").write_bytes(b"x")
            big = root / "Big"
            big.mkdir()
            (big / "other.png").write_bytes(b"y")
            dirs = {"Mine": mine, "Big": big}
            scanned: list[str] = []
            real = assets._build_index

            def counting(d, **kw):
                scanned.append(Path(d).name)
                return real(d, **kw)

            def auto(_r, workspace_id=None):
                m = {"name": "Mine", "path": str(mine), "project_id": "p1"}
                g = {"name": "Big", "path": str(big), "project_id": "p2"}
                return [m] if workspace_id == "ws" else [m, g]

            env = self._locate_env(root, dirs, auto)
            with env[0], env[1], env[2], env[3], env[4], patch.object(assets, "_build_index", side_effect=counting):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"], workspace_id="ws"), SimpleNamespace()
                )

            self.assertEqual([(f["project"], f["path"]) for f in reply["fixed"]], [("Mine", "CH/hero.png")])
            self.assertEqual(scanned, ["Mine"])  # Big 은 훑지 않았다

    def test_walk_skips_hidden_folders_and_stops_at_the_limit(self) -> None:
        """빠른 걸음도 예전 계약을 지킨다 — 숨김은 후보가 아니고, 한도를 넘으면 완주가 아니다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "CH").mkdir()
            (root / "CH" / "a.png").write_bytes(b"1")
            (root / "CH" / "b.png").write_bytes(b"22")
            (root / "CH" / "note.txt").write_bytes(b"not media")
            (root / ".cache").mkdir()
            (root / ".cache" / "hidden.png").write_bytes(b"333")

            entries, complete = assets._walk_media(root)
            self.assertTrue(complete)
            self.assertEqual(sorted((rel, size) for rel, _n, size in entries), [("CH/a.png", 1), ("CH/b.png", 2)])

            capped, complete = assets._walk_media(root, limit=1)
            self.assertEqual(len(capped), 1)  # 넘친 항목은 넣지 않는다
            self.assertFalse(complete)  # 끊겼으면 '없다'고 단정하지 않게

    @unittest.skipUnless(os.name == "nt", "Windows 긴 경로(확장 접두)")
    def test_registered_folder_reads_paths_longer_than_260(self) -> None:
        """LongPathsEnabled 가 꺼진 PC(윈도우 기본)에서도 등록 폴더 아래 260자 넘는 경로를 끝까지 훑는다 — 등록 폴더를
        확장 접두로 풀어 그 아래 모든 경로가 따라가게(2026-10-01: 뻘뻘뻘 1,142항목이 260자 이상이라 전부 '확인 못 함')."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            deep = assets.extended_path(root)  # 만들 때도 접두로 — 시험 PC 의 설정과 무관하게
            for i in range(6):
                deep = deep / f"깊은폴더_{'x' * 40}{i}"
            deep.mkdir(parents=True)
            (deep / "hero.png").write_bytes(b"1234")
            assets._MOUNT_PATH_CACHE.clear()

            resolved = assets._resolve_mount_path(str(root))
            self.assertTrue(str(resolved).startswith("\\\\?\\"))
            entries, complete = assets._walk_media(resolved)
            self.assertTrue(complete)
            [(rel, name, size)] = entries
            self.assertEqual((name, size), ("hero.png", 4))
            self.assertGreater(len(str(assets.path_comparison_key(resolved / rel))), 260)

            # 등록 폴더 경로 자체가 260자를 넘어도 풀린다(접두를 resolve 보다 먼저 붙인다).
            assets._MOUNT_PATH_CACHE.clear()
            long_root = assets._resolve_mount_path(str(assets.path_comparison_key(deep)))
            self.assertTrue(str(long_root).startswith("\\\\?\\"))
            self.assertEqual([e[1] for e in assets._walk_media(long_root)[0]], ["hero.png"])

    def test_walk_survives_a_nas_that_drops_while_listing(self) -> None:
        """목록을 읽는 **도중** NAS 가 끊겨도(반복 중 OSError) locate 가 500 이 되지 않는다 — 읽은 데까지만
        쓰고 완주가 아니라고 한다. 그러면 '서버에 없음'도 말하지 않는다(2026-09-29)."""
        real_scandir = os.scandir

        class _DropsAfterOne:
            def __init__(self, path):
                self._it = real_scandir(path)
                self._given = 0

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                self._it.close()

            def __iter__(self):
                return self

            def __next__(self):
                if self._given >= 1:
                    raise OSError(64, "The specified network name is no longer available")
                self._given += 1
                return next(self._it)

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            proj.mkdir()
            for name in ("a.png", "b.png", "c.png"):
                (proj / name).write_bytes(name.encode())

            with patch.object(assets.os, "scandir", side_effect=_DropsAfterOne):
                entries, complete = assets._walk_media(proj)
            self.assertFalse(complete)
            self.assertLessEqual(len(entries), 1)

            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [{"name": "P", "path": str(proj)}])
            with env[0], env[1], env[2], env[3], env[4], patch.object(assets.os, "scandir", side_effect=_DropsAfterOne):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/gone.png"]), SimpleNamespace()
                )
            self.assertEqual((reply["fixed"], reply["missing"]), ([], []))
            self.assertEqual(reply["unresolved"], ["asset:Q|CH/gone.png"])

    @unittest.skipUnless(sys.platform == "win32", "Windows 정션")
    def test_walk_does_not_follow_a_junction(self) -> None:
        """정션 폴더는 따라가지 않는다 — 에셋 트리와 같은 재분석 지점 속성으로 가린다(DirEntry.is_junction 은
        파이썬 3.12+ 전용이라 3.11 에서는 locate 가 통째로 실패했다, 2026-09-29)."""
        import _winapi

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir) / "root"
            (root / "CH").mkdir(parents=True)
            (root / "CH" / "a.png").write_bytes(b"1")
            outside = Path(tmp_dir) / "outside"
            outside.mkdir()
            (outside / "secret.png").write_bytes(b"2")
            _winapi.CreateJunction(str(outside), str(root / "link"))

            entries, complete = assets._walk_media(root)
            self.assertTrue(complete)
            self.assertEqual([rel for rel, _name, _size in entries], ["CH/a.png"])

    def test_pm_projects_skip_render_folders_like_the_asset_tree(self) -> None:
        """PM 프로젝트로 풀린 폴더는 에셋 트리처럼 render 에 내려가지 않는다(깊이 무관·대소문자 무시) — 렌더 프레임이
        한도(6만)를 채워 그 프로젝트 전체가 '완주 못 함'이 되지 않게(2026-09-29). 개인 등록으로 풀리면 트리도
        render 를 보여 주므로 훑는다. render 안을 가리키는 참조는 '서버에 없음'을 말하지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            (proj / "CH" / "render").mkdir(parents=True)
            (proj / "CH" / "hero.png").write_bytes(b"h")
            (proj / "CH" / "render" / "turn.png").write_bytes(b"t")
            (proj / "Render" / "v1").mkdir(parents=True)
            (proj / "Render" / "v1" / "frame.png").write_bytes(b"f")

            everything, _ = assets._walk_media(proj)
            pruned, complete = assets._walk_media(proj, hide_render=True)
            self.assertEqual(len(everything), 3)
            self.assertEqual(([rel for rel, _n, _s in pruned], complete), (["CH/hero.png"], True))

            tokens = ["asset:Q|CH/render/turn.png", "asset:Q|CH/hero.png"]
            gone = "asset:Q|CH/render/gone.png"  # render 안을 가리키는데 어디에도 없다
            mount = {"name": "P", "path": str(proj)}
            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [mount])  # PM 프로젝트
            with env[0], env[1], env[2], env[3], env[4]:
                as_pm = assets.locate_legacy_assets(assets.LocateIn(tokens=[*tokens, gone]), SimpleNamespace())
            self.assertEqual([f["path"] for f in as_pm["fixed"]], ["CH/hero.png"])
            self.assertEqual(as_pm["missing"], [])  # render 안 참조 — 안 훑었으니 없다고 하지 않는다
            # 그래도 '판정 못 끝냄'은 아니다 — 자동 복구는 render 를 원래 안 훑는다(앱이 기억하고 다시 안 묻는다)
            self.assertEqual(as_pm["incomplete"], [])

            # '레퍼런스 찾기' 단추(include_render) — PM 프로젝트도 render 까지 훑어 잇고, 없는 것은 없다고 한다
            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [mount])
            with env[0], env[1], env[2], env[3], env[4]:
                with_render = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=[*tokens, gone], include_render=True), SimpleNamespace()
                )
            self.assertEqual([f["path"] for f in with_render["fixed"]], ["CH/render/turn.png", "CH/hero.png"])
            self.assertEqual(with_render["missing"], [gone])

            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [])
            with env[0], env[1], env[3], env[4], patch.object(assets, "_owner_mounts", return_value=[mount]):
                as_manual = assets.locate_legacy_assets(assets.LocateIn(tokens=tokens), SimpleNamespace())
            self.assertEqual(
                [f["path"] for f in as_manual["fixed"]], ["CH/render/turn.png", "CH/hero.png"]
            )

    def test_a_bare_name_is_not_linked_through_a_changed_extension(self) -> None:
        """이름뿐인 참조는 확장자만 다른 파일로도 잇지 않는다 — 폴더 근거가 없다. 대신 그런 파일이 있으니
        '서버에 없음'이라고도 하지 않는다(2026-09-29)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            (proj / "CH").mkdir(parents=True)
            (proj / "CH" / "hero.jpeg").write_bytes(b"j")
            env = self._locate_env(root, {"P": proj}, lambda _r, _w=None: [{"name": "P", "path": str(proj)}])
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|hero.png", "asset:Q|CH/hero.png"]), SimpleNamespace()
                )
            self.assertEqual([(f["token"], f["path"]) for f in reply["fixed"]], [("asset:Q|CH/hero.png", "CH/hero.jpeg")])
            self.assertEqual(reply["missing"], [])

    def test_workspace_scope_ignores_a_name_that_points_elsewhere_on_this_pc(self) -> None:
        """공간의 프로젝트 이름이 이 PC 에서는 **다른 폴더**(개인 등록)로 풀리면 쓰지 않는다.

        ★공간 범위를 이름으로 만들면 실제로는 개인 폴더를 훑게 되고, 고친 참조가 이 PC 에서
        엉뚱한 폴더를 가리킨다 — 공간이 신뢰 경계라는 결정이 뚫린다(Codex 2026-09-28).
        ★2026-09-29: 전체 바퀴에서도 그 이름으로는 잇지 않는다 — 다른 PC 는 PM 쪽으로 풀어 같은 참조가
        PC 마다 다른 폴더를 가리킨다(같은 이름·다른 폴더)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            space = root / "space_P"  # 공간에 등록된 P
            (space / "CH").mkdir(parents=True)
            (space / "CH" / "hero.png").write_bytes(b"space")
            mine = root / "my_P"  # 이 PC 에서 개인 등록한 같은 이름 P — 다른 폴더
            (mine / "CH").mkdir(parents=True)
            (mine / "CH" / "hero.png").write_bytes(b"mine")

            def auto(_r, workspace_id=None):
                return [{"name": "P", "path": str(space), "project_id": "p1"}]

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", side_effect=auto),
                patch.object(assets, "_owner_mounts", return_value=[{"name": "P", "path": str(mine)}]),
                patch.object(assets, "actor_id", return_value="me"),
                # 이 PC 는 개인 등록을 먼저 본다
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: mine if name == "P" else None),
            ):
                scanned: list[str] = []
                real = assets._build_index

                def counting(d, **kw):
                    scanned.append(Path(d).name)
                    return real(d, **kw)

                with patch.object(assets, "_build_index", side_effect=counting):
                    reply = assets.locate_legacy_assets(
                        assets.LocateIn(tokens=["asset:Q|CH/hero.png"], workspace_id="ws"), SimpleNamespace()
                    )

            self.assertNotIn("space_P", scanned)  # 공간 라운드에서 쓰지 않았다
            # 전체 라운드도 그 이름으로는 잇지 않는다 — 같은 이름이 개인·PM 에서 다른 폴더다
            self.assertEqual(reply["fixed"], [])
            self.assertEqual(reply["missing"], [])

    def test_waiting_on_a_stuck_scan_gives_up_instead_of_hanging(self) -> None:
        """같은 폴더를 먼저 훑는 요청이 NAS 에 멈추면, 기다리던 요청은 영원히 붙잡히지 않고 포기한다
        ('완주 못 함' — 그 폴더로는 아무것도 바꾸지 않는다, Codex 2026-09-28)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            proj.mkdir()
            (proj / "hero.png").write_bytes(b"x")
            # 다른 F5(다른 작업 id)가 이 폴더를 훑다가 NAS 에 멈춘 상태 — 폴더 기준으로 막힌다
            flight = ("me", os.path.normcase(str(proj)))
            with assets._SCAN_GUARD:
                assets._SCAN_INFLIGHT[flight] = threading.Event()
            try:
                with patch.object(assets, "_SCAN_WAIT", 0.05):
                    snap = assets._locate_snapshot("me", "another-run", proj)
                    # 엔드포인트까지 — 그 폴더로는 아무것도 바꾸지 않고 unresolved 로 둔다
                    with (
                        patch.object(assets, "ASSETS_ROOT", root),
                        patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                        patch.object(assets, "_owner_mounts", return_value=[]),
                        patch.object(assets, "actor_id", return_value="me"),
                        patch.object(assets, "_safe_project_dir", side_effect=lambda n, _r: proj if n == "P" else None),
                    ):
                        reply = assets.locate_legacy_assets(
                            assets.LocateIn(tokens=["asset:Q|hero.png"], scan_id="third-run"), SimpleNamespace()
                        )
            finally:
                with assets._SCAN_GUARD:
                    assets._SCAN_INFLIGHT.pop(flight, None)
            self.assertEqual(snap, ({}, {}, False))
            self.assertEqual(reply["fixed"], [])
            self.assertEqual(reply["unresolved"], ["asset:Q|hero.png"])

    def test_locate_follows_a_picture_whose_extension_was_changed(self) -> None:
        """누가 `x.png` 를 `x.jpeg` 로 바꿔 저장해 두면 씬은 옛 `.png` 를 가리킨다 — 같은 종류이고
        **폴더 경로까지 같을 때만** 이어 준다(Jay 2026-09-28 실측: 매튜_바바라받으려는동작(e025))."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            (proj / "assets" / "CH" / "매튜").mkdir(parents=True)
            (proj / "assets" / "CH" / "매튜" / "catch.jpeg").write_bytes(b"x")  # png 가 jpeg 로 바뀌었다
            (proj / "assets" / "CH" / "매튜" / "clip.mp4").write_bytes(b"v")  # 종류가 다르다
            (proj / "BG").mkdir()
            (proj / "BG" / "far.jpeg").write_bytes(b"f")  # 폴더가 다르다
            (proj / "assets" / "CH" / "매튜" / "twin.jpeg").write_bytes(b"1")
            (proj / "assets" / "CH" / "매튜" / "twin.webp").write_bytes(b"2")  # 후보가 둘

            dirs = {"P": proj}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=[
                            "asset:P|assets/CH/매튜/catch.png",  # → catch.jpeg
                            "asset:P|assets/CH/매튜/clip.png",  # 영상으로 잇지 않는다
                            "asset:P|CH/매튜/far.png",  # 다른 폴더의 far.jpeg 로 잇지 않는다
                            "asset:P|assets/CH/매튜/twin.png",  # jpeg·webp 둘 — 고르지 않는다
                        ]
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual(
                [(f["token"], f["path"]) for f in reply["fixed"]],
                [("asset:P|assets/CH/매튜/catch.png", "assets/CH/매튜/catch.jpeg")],
            )

    def test_an_exact_path_match_beats_a_changed_extension(self) -> None:
        """원래 확장자 그대로의 파일이 있으면 그것을 쓴다 — 확장자만 다른 것은 맨 마지막 근거다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            (proj / "CH").mkdir(parents=True)
            (proj / "CH" / "hero.png").write_bytes(b"png")
            (proj / "CH" / "hero.jpeg").write_bytes(b"jpeg")

            dirs = {"P": proj}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|CH/hero.png"]), SimpleNamespace()
                )

            self.assertEqual([f["path"] for f in reply["fixed"]], ["CH/hero.png"])

    def test_an_ambiguous_name_match_does_not_fall_through_to_a_changed_extension(self) -> None:
        """이름이 같은 파일이 여럿이라 고르지 못했으면, 확장자만 다른 것이 하나 있어도 내려가지 않는다 —
        앞 단계에 후보가 있었다는 건 '이 이름의 파일이 실제로 있다'는 뜻이다(Codex 2026-09-28)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            proj = root / "P"
            for sub in ("A", "B", "X"):
                (proj / sub).mkdir(parents=True)
            (proj / "A" / "hero.png").write_bytes(b"a")  # 이름만 일치 — 둘이라 모호
            (proj / "B" / "hero.png").write_bytes(b"b")
            (proj / "X" / "hero.jpeg").write_bytes(b"x")  # 확장자만 다름 — 하나뿐

            dirs = {"P": proj}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "P"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|X/hero.png"]), SimpleNamespace()
                )

            self.assertEqual(reply["fixed"], [])

    def test_locate_leaves_references_that_already_open_here(self) -> None:
        """이 PC 에서 이미 열리는 참조는 건드리지 않는다 — 멀쩡한 것을 옮기면 더 나빠진다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            a = root / "A"
            (a / "BG").mkdir(parents=True)
            (a / "BG" / "same.png").write_bytes(b"1")
            b_dir = root / "B"
            (b_dir / "BG").mkdir(parents=True)
            (b_dir / "BG" / "same.png").write_bytes(b"1")  # B 에도 같은 이름이 있다

            dirs = {"A": a, "B": b_dir}
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(
                    assets, "_auto_project_mounts", return_value=[{"name": "A"}, {"name": "B"}]
                ),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:A|BG/same.png"]), SimpleNamespace()
                )

            self.assertEqual(reply["fixed"], [])
            self.assertEqual(reply["unresolved"], ["asset:A|BG/same.png"])

    def test_locate_reports_what_is_nowhere_on_the_server(self) -> None:
        """못 고친 참조 중 '서버 어디에도 없는 것'을 따로 알려 준다(Jay 2026-09-29 — 캔버스가 빨갛게
        그린다). missing = 이 PC 에서도 안 열리고 후보가 하나도 없음 · local = 설치 폴더 안 사본에만 있음."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "mine.png").write_bytes(b"only-on-this-pc")
            (root / "imports" / "shared.png").write_bytes(b"also-on-the-nas")
            proj = root / "P"
            (proj / "BG").mkdir(parents=True)
            (proj / "BG" / "shared.png").write_bytes(b"also-on-the-nas")
            (proj / "BG" / "here.png").write_bytes(b"h")
            (root / "imports" / "both.png").write_bytes(b"in-two-projects")
            (proj / "both.png").write_bytes(b"in-two-projects")
            proj2 = root / "P2"
            proj2.mkdir()
            (proj2 / "both.png").write_bytes(b"in-two-projects")  # 서버 두 곳에 있다 — '이 PC 에만' 아님
            dirs = {"P": proj, "P2": proj2}
            mounts = [{"name": "P", "path": str(proj)}, {"name": "P2", "path": str(proj2)}]
            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(
                        tokens=[
                            "asset:imports|mine.png",  # 이 PC 안 사본에만 있다 → local
                            "asset:imports|shared.png",  # 서버에 같은 내용이 있다 → 고친다
                            "asset:Q|CH/gone.png",  # 남이 준 씬 — 어디에도 없다 → missing
                            "asset:imports|other-pc.png",  # 남의 PC 사본 — 여기에도 서버에도 없다
                            "asset:P|BG/here.png",  # 이미 열린다 → 표시 없음
                            "asset:imports|both.png",  # 서버에 있지만 두 곳이라 못 고른다 → 표시 없음
                            "asset:Q|CH/gone.png",  # 같은 토큰이 또 와도 같은 답
                            "asset:P|BG/here.png",
                        ]
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual([f["token"] for f in reply["fixed"]], ["asset:imports|shared.png"])
            self.assertEqual(
                reply["missing"],
                ["asset:Q|CH/gone.png", "asset:imports|other-pc.png", "asset:Q|CH/gone.png"],
            )
            self.assertEqual(reply["local"], ["asset:imports|mine.png"])
            self.assertIn("asset:imports|both.png", reply["unresolved"])
            # 이미 열리는 참조는 open(중복도 같은 답), 두 곳이라 못 고른 것은 '판정 끝' — 앱이 기억하고 다시 안 묻는다
            self.assertEqual(reply["open"], ["asset:P|BG/here.png", "asset:P|BG/here.png"])
            self.assertEqual(reply["incomplete"], [])
            buckets = [set(reply[k]) for k in ("missing", "local", "open", "incomplete")]
            self.assertTrue(all(b <= set(reply["unresolved"]) for b in buckets))  # 모두 unresolved 의 부분집합
            self.assertEqual(sum(len(b) for b in buckets), len(set().union(*buckets)))  # 한 토큰은 한 목록에만

    def test_locate_only_calls_a_ref_missing_after_a_full_search(self) -> None:
        """후보가 여럿이거나, 끝까지 못 훑었거나, 볼 폴더가 없으면 '서버에 없음'이라 하지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "mine.png").write_bytes(b"only-on-this-pc")
            proj = root / "P"
            (proj / "BG").mkdir(parents=True)
            (proj / "BG" / "twice.png").write_bytes(b"1")
            (proj / "twice.png").write_bytes(b"2")
            dirs = {"P": proj}
            mounts = [{"name": "P", "path": str(proj)}]
            tokens = ["asset:Q|twice.png", "asset:Q|gone.png", "asset:imports|mine.png"]

            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(assets.LocateIn(tokens=tokens), SimpleNamespace())
            self.assertEqual(reply["missing"], ["asset:Q|gone.png"])  # 두 곳에 있는 twice 는 빠진다
            self.assertEqual(reply["local"], ["asset:imports|mine.png"])
            self.assertEqual(reply["incomplete"], [])  # twice 는 끝까지 훑고도 못 고른 것 — 판정 끝

            # 끝까지 못 훑었거나 볼 폴더가 없으면 셋 다 '판정 못 끝냄' — 앱이 기억하지 않고 다음 실행에 다시 묻는다
            real = assets._build_index
            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with (
                env[0], env[1], env[2], env[3], env[4],
                patch.object(assets, "_build_index", side_effect=lambda d, **kw: (*real(d, **kw)[:2], False)),
            ):
                reply = assets.locate_legacy_assets(assets.LocateIn(tokens=tokens), SimpleNamespace())
            self.assertEqual((reply["missing"], reply["local"]), ([], []))  # 끝까지 못 훑었다
            self.assertEqual(reply["incomplete"], tokens)

            env = self._locate_env(root, {}, lambda _r, _w=None: [])
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(assets.LocateIn(tokens=tokens), SimpleNamespace())
            self.assertEqual((reply["missing"], reply["local"]), ([], []))  # 볼 폴더가 없다
            self.assertEqual(reply["incomplete"], tokens)

    def test_locate_says_nothing_is_missing_while_a_registered_folder_is_unreachable(self) -> None:
        """등록한 폴더를 하나라도 못 읽으면(NAS 끊김) '서버에 없음'·'이 PC 에만'을 말하지 않는다.
        이름 해석이 설치 폴더의 같은 이름 폴더로 넘어가 열린 것처럼 보여도 등록한 원래 경로로 본다(Codex)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "mine.png").write_bytes(b"only-on-this-pc")
            proj = root / "P"
            proj.mkdir()
            fallback = root / "NAS"  # 설치 폴더 안 같은 이름 폴더 — 이름 해석은 이리로 넘어간다
            fallback.mkdir()
            dirs = {"P": proj, "NAS": fallback}
            mounts = [
                {"name": "P", "path": str(proj)},
                {"name": "NAS", "path": str(root / "unreachable" / "NAS")},  # 원래 경로는 안 닿는다
            ]
            env = self._locate_env(root, dirs, lambda _r, _w=None: mounts)
            with env[0], env[1], env[2], env[3], env[4]:
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|gone.png", "asset:imports|mine.png"]),
                    SimpleNamespace(),
                )

            self.assertEqual((reply["missing"], reply["local"]), ([], []))
            self.assertEqual(reply["unresolved"], ["asset:Q|gone.png", "asset:imports|mine.png"])

    def test_locate_says_nothing_is_missing_when_one_name_points_to_two_folders(self) -> None:
        """같은 이름을 개인 등록과 PM 이 서로 다른 폴더로 가리키면 이름으로는 개인 쪽만 훑는다 — 안 훑은
        PM 폴더에 있을 수 있으니 '서버에 없음'이라 하지 않는다(Codex 2026-09-29)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            mine = root / "mine"
            mine.mkdir()
            team = root / "team"
            team.mkdir()
            (team / "only-in-team.png").write_bytes(b"t")  # PM 폴더에만 있다
            env = self._locate_env(root, {"P": mine}, lambda _r, _w=None: [{"name": "P", "path": str(team)}])
            with (
                env[0], env[1], env[3], env[4],
                patch.object(assets, "_owner_mounts", return_value=[{"name": "P", "path": str(mine)}]),
            ):
                reply = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:Q|only-in-team.png"]), SimpleNamespace()
                )

            self.assertEqual(reply["missing"], [])
            self.assertEqual(reply["unresolved"], ["asset:Q|only-in-team.png"])

    def test_locate_rescans_so_a_file_added_elsewhere_is_not_missed(self) -> None:
        """자동 복구는 **다시 훑는다** — 60초 캐시를 그대로 믿으면 다른 PC 가 방금 넣은 같은 파일을
        못 보고 '한 곳에만 있다'고 단정한다(Codex 2026-09-28)."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            (root / "imports" / "x.png").write_bytes(b"shared-bytes")
            proj_a, proj_b = root / "A", root / "B"
            proj_a.mkdir()
            proj_b.mkdir()
            (proj_a / "x.png").write_bytes(b"shared-bytes")
            dirs = {"A": proj_a, "B": proj_b}
            ctx = (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_auto_project_mounts", return_value=[{"name": "A"}, {"name": "B"}]),
                patch.object(assets, "_owner_mounts", return_value=[]),
                patch.object(assets, "actor_id", return_value="me"),
                patch.object(assets, "_safe_project_dir", side_effect=lambda name, _req: dirs.get(name)),
            )
            with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4]:
                first = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:imports|x.png"]), SimpleNamespace()
                )
                self.assertEqual(len(first["fixed"]), 1)  # 아직 A 에만 있다 → 고친다
                (proj_b / "x.png").write_bytes(b"shared-bytes")  # 다른 PC 가 B 에도 넣었다
                second = assets.locate_legacy_assets(
                    assets.LocateIn(tokens=["asset:imports|x.png"]), SimpleNamespace()
                )
            self.assertEqual(second["fixed"], [])  # 두 곳에 있으니 손대지 않는다
            self.assertEqual(second["unresolved"], ["asset:imports|x.png"])


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
