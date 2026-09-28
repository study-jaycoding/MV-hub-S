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

from fastapi import HTTPException
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
        # ★2026-09-28: 붙여넣기·부분수정 그림도 **프로젝트 폴더의 imports** 에 저장한다.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            proj = root / "proj"
            proj.mkdir()
            upload = UploadFile(filename="capture.png", file=io.BytesIO(b"capture-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon) as offload,
            ):
                result = asyncio.run(
                    assets.upload_capture(SimpleNamespace(), project="proj", file=upload)
                )

            self.assertEqual(result["project"], "proj")
            self.assertTrue(result["path"].startswith("imports/"))
            self.assertEqual((proj / result["path"]).read_bytes(), b"capture-image")
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offload.await_count, 2)
            # NAS 목적지 준비와 커밋+토큰 부기 모두 non-abandon 스레드 관문을 탄다.
            self.assertEqual(
                offloaded,
                [assets._prepare_project_import_dir, assets._commit_capture_with_discard_token],
            )
            self.assertTrue(result["discard_token"])  # 신규 파일 — 정리 토큰 발급

    def test_reference_import_route_saves_media_and_cleans_temp_on_failure(self) -> None:
        # ★2026-09-28 계약 변경: 반입은 **그 프로젝트 폴더** 기준으로 기록한다(이 PC 안 imports 아님).
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            proj = root / "proj"
            proj.mkdir()
            upload = UploadFile(filename="reference.png", file=io.BytesIO(b"reference-image"))
            offloaded: list[object] = []

            async def non_abandon(func, *args):
                offloaded.append(func)
                return func(*args)

            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
                patch.object(assets, "to_thread_non_abandon", side_effect=non_abandon) as offload,
            ):
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[upload])
                )

            saved = result["saved"][0]
            self.assertEqual(saved["project"], "proj")
            self.assertEqual(saved["path"], "imports/reference.png")  # 프로젝트 루트 기준 상대경로
            self.assertEqual((proj / saved["path"]).read_bytes(), b"reference-image")
            self.assertEqual(saved["bytes"], len(b"reference-image"))
            self.assertTrue(saved["sha256"])  # 나중에 내용으로 다시 찾기 위한 지문
            self.assertEqual(list(root.rglob(".upload-*.part")), [])
            self.assertEqual(offload.await_count, 2)
            self.assertEqual(
                offloaded,
                [assets._prepare_project_import_dir, asset_io.find_or_commit_media],
            )

            failed = UploadFile(filename="broken.png", file=io.BytesIO(b"broken-image"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                # AIO-2 계약 변경: 라우터는 검색과 확정을 분리하지 않고 이 함수 한 번에 위임한다.
                patch.object(asset_io, "find_or_commit_media", side_effect=RuntimeError("hash failed")),
                self.assertRaises(RuntimeError),
            ):
                asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[failed])
                )

            self.assertEqual(list(root.rglob(".upload-*.part")), [])

    def test_reference_import_reuses_existing_project_file_instead_of_copying(self) -> None:
        """끌어다 놓은 파일이 이미 프로젝트 안에 있으면 사본을 만들지 않고 그 경로를 쓴다.
        (브라우저는 원래 경로를 주지 않으므로 내용으로 찾는다 — Jay 2026-09-28)"""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            proj = root / "proj"
            (proj / "BG" / "갯벌").mkdir(parents=True)
            original = proj / "BG" / "갯벌" / "sea.png"
            original.write_bytes(b"same-bytes")
            decoy = proj / "BG" / "other.png"
            decoy.write_bytes(b"same-size!")  # 크기는 같고 내용이 다른 파일 — 잡히면 안 된다
            self.assertEqual(len(b"same-size!"), len(b"same-bytes"))

            upload = UploadFile(filename="sea.png", file=io.BytesIO(b"same-bytes"))
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
            ):
                assets.invalidate_size_index(proj)
                result = asyncio.run(
                    assets.upload_reference_import(SimpleNamespace(), project="proj", files=[upload])
                )

            saved = result["saved"][0]
            self.assertEqual(saved["path"], "BG/갯벌/sea.png")  # 원본 자리를 그대로 가리킨다
            self.assertTrue(saved["reused"])
            self.assertFalse((proj / "imports").exists())  # 사본을 만들지 않았다
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
                for proj_dir in dirs.values():
                    assets.invalidate_size_index(proj_dir)
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

    def test_reference_import_requires_a_project(self) -> None:
        """프로젝트를 모르면 이 PC 안에 몰래 사본을 만들지 않고 막는다(남에게 안 보이는 사본 방지)."""
        upload = UploadFile(filename="x.png", file=io.BytesIO(b"x"))
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(assets.upload_reference_import(SimpleNamespace(), project="", files=[upload]))
        self.assertEqual(caught.exception.status_code, 400)

    def test_locate_finds_by_path_or_name_when_there_is_no_local_copy(self) -> None:
        """사본이 없어도(남이 준 씬) 경로·이름으로 서버에서 찾아 잇는다.

        ★Jay 2026-09-28: 같은 폴더를 사람마다 다른 깊이로 등록하면 같은 그림이 `CH/x.png` 도 되고
        `assets/CH/x.png` 도 된다. 사본이 없으니 지문은 낼 수 없다 — 그래서 경로 뒷부분, 그것도
        없으면 파일 이름으로 찾는다. 여러 곳에 있으면 단정하지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()  # 사본은 하나도 없다 — 남이 준 씬과 같은 상황
            proj = root / "P"
            (proj / "assets" / "CH" / "바바라").mkdir(parents=True)
            (proj / "assets" / "CH" / "바바라" / "body.png").write_bytes(b"x")
            (proj / "assets" / "CH" / "낙지").mkdir(parents=True)
            (proj / "assets" / "CH" / "낙지" / "octopus.png").write_bytes(b"y")
            (proj / "assets" / "BG").mkdir(parents=True)
            (proj / "assets" / "BG" / "twice.png").write_bytes(b"z")
            (proj / "twice.png").write_bytes(b"z")  # 같은 이름이 두 곳 — 고르지 않는다

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
                            # 사본 참조인데 사본이 없다 → 이름으로 찾는다
                            "asset:imports|octopus.png",
                            "asset:P_RnD|CH/없는것.png",  # 서버에도 없다
                            "asset:P_RnD|twice.png",  # 같은 이름이 두 곳 — 그대로 둔다
                        ]
                    ),
                    SimpleNamespace(),
                )

            self.assertEqual(
                [(f["token"], f["project"], f["path"]) for f in reply["fixed"]],
                [
                    ("asset:P_RnD|CH/바바라/body.png", "P", "assets/CH/바바라/body.png"),
                    ("asset:imports|octopus.png", "P", "assets/CH/낙지/octopus.png"),
                ],
            )
            self.assertEqual(
                reply["unresolved"], ["asset:P_RnD|CH/없는것.png", "asset:P_RnD|twice.png"]
            )

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
        """서로 다른 프로젝트에 같은 이름이 있으면 고르지 않는다 — 어느 쪽인지 단정할 수 없다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            (root / "imports").mkdir()
            a = root / "A"
            a.mkdir()
            (a / "hero.png").write_bytes(b"1")
            b_dir = root / "B"
            b_dir.mkdir()
            (b_dir / "hero.png").write_bytes(b"2")

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
                    assets.LocateIn(tokens=["asset:Q|hero.png"]), SimpleNamespace()
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

    def test_reference_import_leaves_no_empty_imports_folder(self) -> None:
        """전부 기존 원본으로 이어졌으면 이 요청이 만든 빈 imports 폴더는 도로 치운다.
        단 **원래 있던** 빈 폴더는 남의 것이라 건드리지 않는다."""
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            root = Path(tmp_dir)
            proj = root / "proj"
            proj.mkdir()
            (proj / "keep.png").write_bytes(b"already-here")
            with (
                patch.object(assets, "ASSETS_ROOT", root),
                patch.object(assets, "_safe_project_dir", return_value=proj),
                patch.object(assets.asset_tree, "invalidate_project_tree"),
            ):
                assets.invalidate_size_index(proj)
                asyncio.run(
                    assets.upload_reference_import(
                        SimpleNamespace(),
                        project="proj",
                        files=[UploadFile(filename="keep.png", file=io.BytesIO(b"already-here"))],
                    )
                )
                self.assertFalse((proj / "imports").exists())  # 만들었다가 도로 치웠다

                (proj / "imports").mkdir()  # 사람이 미리 만들어 둔 빈 폴더
                assets.invalidate_size_index(proj)
                asyncio.run(
                    assets.upload_reference_import(
                        SimpleNamespace(),
                        project="proj",
                        files=[UploadFile(filename="keep.png", file=io.BytesIO(b"already-here"))],
                    )
                )
                self.assertTrue((proj / "imports").exists())  # 남의 폴더는 그대로 둔다


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
