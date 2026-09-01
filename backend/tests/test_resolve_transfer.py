"""Render 폴더 Resolve 전송 — 구조 보존·manifest 분리·경로 안전성 검증."""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from app import db
from app.routers import resolve_integration
from app.services import request_guards, resolve_transfer


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

    async def test_completed_manifest_can_be_loaded_for_retry(self):
        result = await self._transfer([self._generation(1, "ep001/c0010")], "retry-me")

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            loaded = await resolve_transfer.load_manifest("p1", "retry-me")

        self.assertEqual(loaded["transfer_id"], result["transfer_id"])
        self.assertEqual(loaded["items"][0]["status"], "downloaded")

    async def test_manual_importer_lists_only_safe_pending_manifests(self):
        pending = await self._transfer(
            [self._generation(1, "ep001/c0010")], "manual-pending"
        )
        completed = await self._transfer(
            [self._generation(2, "ep001/c0020")], "manual-completed"
        )
        completed["resolve_import"] = {"status": "complete", "imported": 1}
        await resolve_transfer.save_manifest(completed)

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            found = resolve_transfer.list_pending_manifests(["p1"])

        self.assertEqual([item["transfer_id"] for item in found], ["manual-pending"])
        self.assertEqual(found[0]["manifest_path"], pending["manifest_path"])

    async def test_completed_newest_manifest_does_not_hide_older_pending_limit(self):
        pending = await self._transfer(
            [self._generation(1, "ep001/c0010")], "older-pending"
        )
        completed = await self._transfer(
            [self._generation(2, "ep001/c0020")], "newer-completed"
        )
        completed["resolve_import"] = {"status": "complete", "imported": 1}
        await resolve_transfer.save_manifest(completed)
        now = time.time()
        os.utime(pending["manifest_path"], (now - 10, now - 10))
        os.utime(completed["manifest_path"], (now, now))

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            found = resolve_transfer.list_pending_manifests(["p1"], limit=1)

        self.assertEqual([item["transfer_id"] for item in found], ["older-pending"])

    async def test_manual_importer_rejects_media_outside_project_render(self):
        pending = await self._transfer(
            [self._generation(1, "ep001/c0010")], "unsafe-manual"
        )
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"outside")
        pending["items"][0]["local_path"] = str(outside)
        await resolve_transfer.save_manifest(pending)

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            found = resolve_transfer.list_pending_manifests(["p1"])

        self.assertEqual(found, [])

    async def test_retry_route_reuses_manifest_without_copying_sources(self):
        manifest = {
            "project_id": "p1",
            "transfer_id": "retry-existing",
            "resolve_import": {"status": "unavailable"},
        }
        imported = {"status": "complete", "imported": 1, "skipped": 0}
        with (
            mock.patch.object(
                resolve_integration,
                "load_manifest",
                new=mock.AsyncMock(return_value=manifest),
            ) as load,
            mock.patch.object(
                resolve_integration,
                "run_resolve_import_isolated",
                return_value=imported,
            ) as import_prepared,
            mock.patch.object(
                resolve_integration,
                "save_manifest",
                new=mock.AsyncMock(),
            ) as save,
            mock.patch.object(resolve_integration, "transfer_generations") as transfer,
        ):
            result = await resolve_integration.retry_resolve_transfer(
                resolve_integration.ResolveRetryIn(
                    project_id="p1", transfer_id="retry-existing"
                ),
                Request({"type": "http", "client": ("127.0.0.1", 12345)}),
            )

        load.assert_awaited_once_with("p1", "retry-existing")
        import_prepared.assert_called_once_with(manifest)
        save.assert_awaited_once_with(manifest)
        transfer.assert_not_called()
        self.assertEqual(result["resolve_import"], imported)

    async def test_all_resolve_operations_reject_remote_pc_requests(self):
        remote = Request({"type": "http", "client": ("192.168.1.50", 12345)})

        with mock.patch.object(
            request_guards,
            "local_machine_hosts",
            return_value=frozenset({"127.0.0.1", "192.168.1.38"}),
        ):
            for operation in (
                lambda: resolve_integration.get_resolve_connection_status(remote),
                lambda: resolve_integration.create_resolve_transfer(
                    resolve_integration.ResolveTransferIn(gen_ids=["g1"]), remote
                ),
                lambda: resolve_integration.retry_resolve_transfer(
                    resolve_integration.ResolveRetryIn(project_id="p1", transfer_id="t1"),
                    remote,
                ),
                lambda: resolve_integration.pending_resolve_transfers(remote),
                lambda: resolve_integration.record_manual_resolve_result(
                    resolve_integration.ResolveManualResultIn(
                        project_id="p1",
                        transfer_id="t1",
                        status="complete",
                        total=1,
                        imported=1,
                        skipped=0,
                        error_count=0,
                    ),
                    remote,
                ),
            ):
                with self.assertRaises(HTTPException) as raised:
                    await operation()
                self.assertEqual(raised.exception.status_code, 403)

    async def test_manual_import_result_is_validated_and_saved(self):
        manifest = {"project_id": "p1", "transfer_id": "manual-result"}
        request = Request({"type": "http", "client": ("127.0.0.1", 12345)})
        body = resolve_integration.ResolveManualResultIn(
            project_id="p1",
            transfer_id="manual-result",
            status="partial",
            total=3,
            imported=1,
            skipped=1,
            error_count=1,
            error="one failed",
        )
        with (
            mock.patch.object(
                resolve_integration,
                "load_manifest",
                new=mock.AsyncMock(return_value=manifest),
            ),
            mock.patch.object(
                resolve_integration, "save_manifest", new=mock.AsyncMock()
            ) as save,
        ):
            result = await resolve_integration.record_manual_resolve_result(body, request)

        self.assertTrue(result["ok"])
        self.assertEqual(manifest["resolve_import"]["method"], "resolve_menu_script")
        self.assertEqual(manifest["resolve_import"]["status"], "partial")
        save.assert_awaited_once_with(manifest)

    async def test_manual_importer_endpoint_works_without_browser_cookie_only_locally(self):
        from app import main as main_module

        with mock.patch.dict(
            os.environ,
            {"CONTENT_HUB_DB": str(self.root / "endpoint-content-hub.db")},
            clear=False,
        ):
            db.flush_pool()
            db.init_db()
            try:
                with (
                    mock.patch.object(main_module, "AUTH_ENABLED", True),
                    mock.patch.object(
                        request_guards,
                        "local_machine_hosts",
                        # testclient=접속 IP, testserver=TestClient 의 Host 헤더 —
                        # 가드가 Host 까지 검사하므로(브라우저 문맥 검사) 둘 다 로컬로 등록
                        return_value=frozenset({"127.0.0.1", "testclient", "testserver"}),
                    ),
                    mock.patch.object(
                        resolve_integration.repo,
                        "list_projects",
                        return_value={"projects": []},
                    ),
                ):
                    response = TestClient(main_module.app).get(
                        "/api/resolve/transfers/pending"
                    )
            finally:
                db.flush_pool()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"items": []})

    async def test_large_transfer_checkpoints_manifest_instead_of_rewriting_every_item(self):
        generations = [self._generation(i, "ep001/c0010") for i in range(1, 26)]
        original = resolve_transfer._write_manifest
        with (
            mock.patch.object(resolve_transfer, "_MANIFEST_CHECKPOINT_ITEMS", 10),
            mock.patch.object(
                resolve_transfer, "_write_manifest", wraps=original
            ) as write_manifest,
        ):
            result = await self._transfer(generations, "checkpointed")

        self.assertEqual(result["downloaded"], 25)
        self.assertEqual(write_manifest.call_count, 4)

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

    async def test_concurrent_same_destination_copies_serialize_to_one_write(self):
        """R5 2-B — 같은 목적지 동시 복사는 목적지 락으로 직렬화: 한쪽 downloaded·
        한쪽 skipped(같은 원본), last-writer 덮어쓰기·이중 대용량 복사 없음."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "src.mp4"
            source.write_bytes(b"payload-bytes")
            dest = Path(tmp) / "out" / "final.mp4"
            copy2 = resolve_transfer.shutil.copy2
            copy_calls: list[str] = []
            barrier = threading_module.Barrier(2)

            def slow_copy(src, dst):
                copy_calls.append(str(dst))
                time.sleep(0.05)  # 경합 창 확대 — 직렬화 없으면 둘 다 여기 진입한다
                return copy2(src, dst)

            results: list[str] = []
            errors: list[Exception] = []

            def run():
                barrier.wait()
                try:
                    with mock.patch.object(resolve_transfer.shutil, "copy2", slow_copy):
                        results.append(resolve_transfer._copy_atomic(source, dest))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading_module.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(errors, [])
            self.assertEqual(sorted(results), ["downloaded", "skipped"])
            self.assertEqual(len(copy_calls), 1)  # 대용량 복사는 정확히 1회
            self.assertEqual(dest.read_bytes(), b"payload-bytes")
            self.assertEqual(resolve_transfer._DEST_LOCKS, {})  # 레지스트리 회수 계약

    async def test_concurrent_different_source_same_destination_conflicts(self):
        """같은 목적지·다른 원본 동시 요청 — 하나만 성공, 다른 하나는 종전 오류."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            source_a = Path(tmp) / "a.mp4"
            source_a.write_bytes(b"content-a")
            source_b = Path(tmp) / "b.mp4"
            source_b.write_bytes(b"content-b")
            dest = Path(tmp) / "out" / "final.mp4"
            barrier = threading_module.Barrier(2)
            results: list[str] = []
            errors: list[Exception] = []

            def run(src):
                barrier.wait()
                try:
                    results.append(resolve_transfer._copy_atomic(src, dest))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [
                threading_module.Thread(target=run, args=(src,))
                for src in (source_a, source_b)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(results, ["downloaded"])
            self.assertEqual(len(errors), 1)
            self.assertIn("다른 파일", str(errors[0]))
            self.assertIn(dest.read_bytes(), {b"content-a", b"content-b"})
            self.assertEqual(resolve_transfer._DEST_LOCKS, {})

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
