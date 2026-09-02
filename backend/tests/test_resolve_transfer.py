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

    async def test_repeated_transfer_continues_the_numbering(self):
        """같은 묶음을 다시 보내면 그냥 다음 번호로 이어진다(꼬리 없음)."""
        generations = [self._generation(i, "ep001/c0010") for i in range(1, 4)]
        first = await self._transfer(generations, "first")
        second = await self._transfer(generations, "second")

        self.assertEqual(first["downloaded"], 3)
        self.assertEqual(
            [item["filename"] for item in first["items"]],
            ["ep001_c0010_00.mp4", "ep001_c0010_01.mp4", "ep001_c0010_02.mp4"],
        )
        self.assertEqual((second["downloaded"], second["error_count"]), (3, 0))
        self.assertEqual(
            [item["filename"] for item in second["items"]],
            ["ep001_c0010_03.mp4", "ep001_c0010_04.mp4", "ep001_c0010_05.mp4"],
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

    async def test_import_order_names_files_by_folder_sequence(self):
        """파일명 = <폴더 경로를 _ 로 이음>_<가져온 순번 2자리>. 순번은 폴더마다 따로 센다."""
        generations = [
            self._generation(1, "ep001/c0010"),
            self._generation(2, "ep002/c0020"),
            self._generation(3, "ep001/c0010"),
        ]

        result = await self._transfer(generations, "sequence")

        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            [item["filename"] for item in result["items"]],
            [
                "ep001_c0010_00.mp4",
                "ep002_c0020_00.mp4",
                "ep001_c0010_01.mp4",
            ],
        )
        for item in result["items"]:
            self.assertTrue(Path(item["local_path"]).is_file())

    async def test_new_generation_takes_the_next_number_without_filling_gaps(self):
        """새 생성물은 남아 있는 파일의 마지막 번호 다음을 받는다 — 장부가 없어도 디스크에서
        이어받고, 가운데 빈 번호는 채우지 않는다."""
        folder = self.render / "ep001" / "c0010"
        folder.mkdir(parents=True)
        (folder / "ep001_c0010_00.mp4").write_bytes(b"older-take")
        (folder / "ep001_c0010_02.mp4").write_bytes(b"another-take")  # 01 은 비어 있다

        result = await self._transfer([self._generation(1, "ep001/c0010")], "gap")

        self.assertEqual(result["items"][0]["filename"], "ep001_c0010_03.mp4")
        self.assertEqual((folder / "ep001_c0010_00.mp4").read_bytes(), b"older-take")
        self.assertEqual(list(folder.glob("*.part")), [])

    async def test_resending_the_same_generation_takes_the_next_number(self):
        """같은 생성물을 또 가져와도 다음 번호를 받는다 — 사본이 하나씩 늘어난다."""
        generation = self._generation(1, "ep001/c0010")

        first = await self._transfer([generation], "resend-first")
        second = await self._transfer([generation], "resend-second")
        third = await self._transfer([generation], "resend-third")

        self.assertEqual(first["items"][0]["filename"], "ep001_c0010_00.mp4")
        self.assertEqual(second["items"][0]["filename"], "ep001_c0010_01.mp4")
        self.assertEqual(third["items"][0]["filename"], "ep001_c0010_02.mp4")
        self.assertEqual(
            sorted(path.name for path in (self.render / "ep001" / "c0010").iterdir()),
            [
                "ep001_c0010_00.mp4",
                "ep001_c0010_01.mp4",
                "ep001_c0010_02.mp4",
            ],
        )

    async def test_emptying_the_folder_restarts_numbering_from_zero(self):
        """폴더를 다 비우면 00 부터 다시 센다 — 번호의 근거는 폴더뿐이다."""
        first_gen = self._generation(1, "ep001/c0010")
        await self._transfer([first_gen, self._generation(2, "ep001/c0010")], "wipe-1")
        folder = self.render / "ep001" / "c0010"
        for path in list(folder.iterdir()):
            path.unlink()

        again = await self._transfer([first_gen], "wipe-2")

        self.assertEqual(again["items"][0]["filename"], "ep001_c0010_00.mp4")

    async def test_deleted_generation_gets_a_fresh_number_not_a_letter(self):
        """가운데 파일만 지우면 그 생성물은 '없는 것' 이 돼 다음 번호를 새로 받는다."""
        gone = self._generation(2, "ep001/c0010")
        await self._transfer(
            [self._generation(1, "ep001/c0010"), gone, self._generation(3, "ep001/c0010")],
            "hole-1",
        )
        (self.render / "ep001" / "c0010" / "ep001_c0010_01.mp4").unlink()

        again = await self._transfer([gone], "hole-2")

        self.assertEqual(again["items"][0]["filename"], "ep001_c0010_03.mp4")

    async def test_no_ledger_file_is_written(self):
        """번호를 적어 두는 파일은 만들지 않는다 — 폴더가 유일한 근거다."""
        await self._transfer([self._generation(1, "ep001/c0010")], "no-ledger")

        davinci = self.root / "@davinci"
        self.assertFalse((davinci / ".mvhub" / "sequence.json").exists())

    async def test_unreadable_folder_fails_instead_of_restarting_at_zero(self):
        """대상 폴더를 못 읽으면 '비었다' 로 보고 00 부터 세지 않고 실패로 남긴다."""
        generation = self._generation(1, "ep001/c0010")

        def explode(_path):
            raise PermissionError("NAS 접근 실패")

        with mock.patch.object(Path, "iterdir", explode):
            result = await self._transfer([generation], "unreadable")

        self.assertEqual(result["status"], "failed")
        self.assertIn("읽을 수 없습니다", result["items"][0]["error"])

    async def test_existing_file_is_never_overwritten(self):
        """이미 그 번호를 쓰고 있는 파일은 크기가 같아도 건드리지 않고 다음 번호로 간다."""
        same = self._generation(1, "ep001/c0010")
        folder = self.render / "ep001" / "c0010"
        folder.mkdir(parents=True)
        source = self.media / same["assets"][0]["file_path"].removeprefix("/media/")
        # 크기만 같고 내용이 다른 파일이 00 을 차지하고 있다.
        (folder / "ep001_c0010_00.mp4").write_bytes(b"x" * source.stat().st_size)

        result = await self._transfer([same], "bytes")

        self.assertEqual(result["items"][0]["filename"], "ep001_c0010_01.mp4")

    async def test_concurrent_same_destination_copies_serialize_without_overwrite(self):
        """R5 2-B — 같은 이름을 노린 동시 복사는 목적지 락으로 직렬화된다: 한 이름에
        대용량 복사는 1회뿐이고 뒤엣것은 다음 이름으로 갈라진다(last-writer 덮어쓰기 없음)."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "src.mp4"
            source.write_bytes(b"payload-bytes")
            dest = root / "out" / "final_00.mp4"
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
                        written = resolve_transfer._place_copy(
                            source, root, "out", "final", ".mp4", {}
                        )
                        results.append(written.name)
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading_module.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(errors, [])
            self.assertEqual(sorted(results), ["final_00.mp4", "final_01.mp4"])
            # 이름마다 정확히 한 번씩 — 같은 이름에 두 번 복사되지 않는다.
            names = [Path(call).name for call in copy_calls]
            self.assertEqual(len(names), len(set(names)))
            self.assertEqual(dest.read_bytes(), b"payload-bytes")
            self.assertEqual(resolve_transfer._DEST_LOCKS, {})  # 레지스트리 회수 계약

    async def test_concurrent_different_source_same_name_takes_next_number(self):
        """같은 번호를 노린 다른 원본 동시 요청 — 둘 다 저장되고 뒤엣것이 다음 번호로 간다."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_a = root / "a.mp4"
            source_a.write_bytes(b"content-a")
            source_b = root / "b.mp4"
            source_b.write_bytes(b"content-b")
            dest = root / "out" / "final_00.mp4"
            barrier = threading_module.Barrier(2)
            results: list[str] = []
            errors: list[Exception] = []

            def run(src):
                barrier.wait()
                try:
                    path = resolve_transfer._place_copy(
                        src, root, "out", "final", ".mp4", {}
                    )
                    results.append(path.name)
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

            self.assertEqual(errors, [])
            self.assertEqual(sorted(results), ["final_00.mp4", "final_01.mp4"])
            # 먼저 잡은 쪽이 _00, 나중 쪽이 _01 — 어느 쪽도 덮이지 않는다.
            written = {
                path.read_bytes() for path in dest.parent.iterdir() if path.is_file()
            }
            self.assertEqual(written, {b"content-a", b"content-b"})
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
        # 실패한 항목에는 경로가 안 남고, 폴더에도 빈 선점 파일이 남지 않는다.
        self.assertEqual(item["local_path"], "")
        folder = self.render / "ep001" / "c0010"
        self.assertEqual(list(folder.iterdir()) if folder.exists() else [], [])

    def test_resolve_routes_are_always_local(self):
        from app.routers._proxy import is_local_path

        self.assertTrue(is_local_path("/api/resolve/transfers"))


if __name__ == "__main__":
    unittest.main()
