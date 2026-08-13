"""Render 폴더 Resolve 전송 — 구조 보존·manifest 분리·경로 안전성 검증."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_transfer


class ResolveTransferTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.render = self.root / "Render"
        self.render.mkdir()
        self.media = self.root / "media"
        self.media.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def _generation(self, index: int, folder: str) -> dict:
        rel = f"/media/{index:02d}/source-{index}.mp4"
        source = self.media / rel.removeprefix("/media/")
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes((f"video-{index}" * 100).encode())
        return {
            "id": f"generation-{index:02d}",
            "project_id": "p1",
            "project_name": "테스트 프로젝트",
            "folder_path": folder,
            "status": "done",
            "assets": [
                {
                    "type": "video",
                    "file_path": rel,
                    "source_url": f"https://cdn.example/source-{index}.mp4",
                }
            ],
        }

    async def _transfer(self, generations: list[dict], transfer_id: str):
        with (
            mock.patch.object(
                resolve_transfer.project_folders,
                "render_root_state",
                return_value={"render_path": str(self.render), "error": None},
            ),
            mock.patch.object(resolve_transfer, "MEDIA_DIR", self.media),
        ):
            return await resolve_transfer.transfer_generations(
                "p1", generations, transfer_id=transfer_id
            )

    async def test_three_videos_keep_folder_tree_and_write_manifest(self):
        generations = [
            self._generation(1, "ep001/c0010"),
            self._generation(2, "ep001/c0020"),
            self._generation(3, "ep002/c0010"),
        ]

        result = await self._transfer(generations, "transfer-three")

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            (result["downloaded"], result["skipped"], result["error_count"]),
            (3, 0, 0),
        )
        for item in result["items"]:
            path = Path(item["local_path"])
            self.assertTrue(path.is_file())
            self.assertEqual(
                path.parent.relative_to(self.render).as_posix(),
                item["folder_path"],
            )
        manifest_path = Path(result["manifest_path"])
        self.assertEqual(Path(result["source_root"]), self.render)
        self.assertEqual(Path(result["manifest_root"]), self.root / "@davinci")
        self.assertEqual(
            manifest_path.parent,
            self.root / "@davinci" / ".mvhub" / "transfers",
        )
        self.assertFalse((self.root / "ResolveSource").exists())
        saved = json.loads(manifest_path.read_text("utf-8"))
        self.assertEqual(saved["status"], "complete")
        self.assertEqual(saved["format"], resolve_transfer.MANIFEST_FORMAT)
        catalog_path = Path(result["folder_catalog_path"])
        self.assertEqual(
            catalog_path,
            self.root / "@davinci" / ".mvhub" / "folder-catalog.json",
        )
        catalog = json.loads(catalog_path.read_text("utf-8"))
        self.assertEqual(catalog["format"], resolve_transfer.FOLDER_CATALOG_FORMAT)
        self.assertEqual(
            catalog["paths"],
            ["ep001/c0010", "ep001/c0020", "ep002/c0010"],
        )
        self.assertEqual(result["folder_paths"], catalog["paths"])
        result["resolve_import"] = {"status": "complete", "imported": 3}
        await resolve_transfer.save_manifest(result)
        saved = json.loads(manifest_path.read_text("utf-8"))
        self.assertEqual(saved["resolve_import"]["imported"], 3)
        # 만료 가능한 CDN 주소·토큰은 편집 패키지 manifest에 남기지 않는다.
        self.assertNotIn("cdn.example", manifest_path.read_text("utf-8"))

    async def test_repeated_transfer_skips_same_files(self):
        generations = [self._generation(i, "ep001/c0010") for i in range(1, 4)]
        first = await self._transfer(generations, "first")
        second = await self._transfer(generations, "second")

        self.assertEqual(first["downloaded"], 3)
        self.assertEqual(
            (second["downloaded"], second["skipped"], second["error_count"]),
            (0, 3, 0),
        )

    async def test_separate_transfers_replace_catalog_with_current_selection(self):
        await self._transfer([self._generation(1, "ep001/c0015")], "first-late")
        second = await self._transfer(
            [self._generation(2, "ep001/c0010")], "second-early"
        )

        catalog = json.loads(Path(second["folder_catalog_path"]).read_text("utf-8"))
        self.assertEqual(catalog["paths"], ["ep001/c0010"])
        self.assertEqual(second["folder_paths"], catalog["paths"])

    async def test_unsafe_folder_is_reported_without_escape(self):
        result = await self._transfer(
            [self._generation(1, "../outside")], "unsafe-folder"
        )

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_count"], 1)
        self.assertIn("경로 안전성", result["items"][0]["error"])
        self.assertFalse((self.root / "outside").exists())

    async def test_existing_different_file_is_not_overwritten(self):
        generation = self._generation(1, "ep001/c0010")
        filename = resolve_transfer._transfer_filename(
            "ep001/c0010",
            generation["id"],
            generation["assets"][0]["source_url"],
            "video",
        )
        dest = self.render / "ep001" / "c0010" / filename
        dest.parent.mkdir(parents=True)
        source = self.media / generation["assets"][0]["file_path"].removeprefix("/media/")
        different_same_size = b"x" * source.stat().st_size
        dest.write_bytes(different_same_size)

        result = await self._transfer([generation], "conflict")

        self.assertEqual(result["status"], "failed")
        self.assertIn("다른 파일", result["items"][0]["error"])
        self.assertEqual(dest.read_bytes(), different_same_size)
        self.assertEqual(list(dest.parent.glob("*.part")), [])

    async def test_unsafe_transfer_id_is_rejected_before_manifest_write(self):
        with self.assertRaises(resolve_transfer.ResolveTransferError):
            await self._transfer([self._generation(1, "ep001/c0010")], "../escape")
        self.assertFalse((self.root / "@davinci" / "escape.json").exists())

    async def test_existing_davinci_file_is_not_overwritten(self):
        davinci = self.root / "@davinci"
        davinci.write_text("keep", encoding="utf-8")

        with self.assertRaises(resolve_transfer.ResolveTransferError):
            await self._transfer([self._generation(1, "ep001/c0010")], "blocked")

        self.assertEqual(davinci.read_text("utf-8"), "keep")
        self.assertFalse((self.render / "ep001" / "c0010").exists())

    async def test_remote_original_is_cached_then_copied_without_url_in_manifest(self):
        generation = self._generation(1, "ep001/c0010")
        generation["assets"][0]["file_path"] = "https://cdn.example/fresh.mp4?token=secret"
        generation["assets"][0]["source_url"] = ""
        cached_rel = "/media/ff/fresh.mp4"
        cached = self.media / cached_rel.removeprefix("/media/")

        async def fake_cache(url: str):
            self.assertIn("token=secret", url)
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(b"fresh-video")
            return cached_rel

        with mock.patch.object(
            resolve_transfer.media_cache, "cache_url", side_effect=fake_cache
        ):
            result = await self._transfer([generation], "remote-source")

        self.assertEqual(result["status"], "complete")
        self.assertEqual(Path(result["items"][0]["local_path"]).read_bytes(), b"fresh-video")
        self.assertNotIn("token=secret", Path(result["manifest_path"]).read_text("utf-8"))

    async def test_copy_failure_removes_part_file_and_keeps_destination_absent(self):
        generation = self._generation(1, "ep001/c0010")

        def fail_after_partial_copy(_source: Path, tmp: Path):
            Path(tmp).write_bytes(b"partial")
            raise OSError("simulated copy failure")

        with mock.patch.object(
            resolve_transfer.shutil, "copy2", side_effect=fail_after_partial_copy
        ):
            result = await self._transfer([generation], "copy-failure")

        item = result["items"][0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("simulated copy failure", item["error"])
        dest = Path(item["local_path"])
        self.assertFalse(dest.exists())
        self.assertEqual(list(dest.parent.glob("*.part")), [])

    def test_resolve_routes_are_always_local(self):
        from app.routers._proxy import is_local_path

        self.assertTrue(is_local_path("/api/resolve/transfers"))


if __name__ == "__main__":
    unittest.main()
