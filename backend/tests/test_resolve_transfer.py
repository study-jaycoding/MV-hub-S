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
from app.services import export_names, request_guards, resolve_transfer


def dv(base: str, seq: int, worker: str = "noname") -> str:
    """§7 다빈치 이름 — 픽스처의 프로젝트 `테스트 프로젝트` · 작업자 이름이 없으면 `noname`."""
    return f"테스트_프로젝트_{base}_davinci_{worker}_{seq:03d}.mp4"


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

    async def test_repeated_transfer_reuses_the_files_already_sent(self):
        """같은 묶음을 다시 보내면 있는 파일을 그대로 쓴다 — 사본도 새 번호도 생기지 않는다(Jay 2026-10-08)."""
        generations = [self._generation(i, "ep001/c0010") for i in range(1, 4)]
        first = await self._transfer(generations, "first")
        second = await self._transfer(generations, "second")

        names = [dv("ep001_c0010", 1), dv("ep001_c0010", 2), dv("ep001_c0010", 3)]
        self.assertEqual((first["downloaded"], first["skipped"]), (3, 0))
        self.assertEqual([item["filename"] for item in first["items"]], names)
        self.assertEqual((second["downloaded"], second["skipped"], second["error_count"]), (0, 3, 0))
        self.assertEqual([item["filename"] for item in second["items"]], names)
        self.assertEqual([item["local_path"] for item in second["items"]], [item["local_path"] for item in first["items"]])
        self.assertEqual(second["status"], "complete")  # 건너뛴 것도 준비된 파일이다 — 그대로 가져온다
        self.assertEqual(sorted(p.name for p in (self.render / "ep001" / "c0010").iterdir()), names)

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

    async def test_selection_index_keeps_completed_manifest_paths(self):
        result = await self._transfer(
            [self._generation(1, "ep001/c0010")], "selection-history"
        )
        result["resolve_import"] = {"status": "complete", "imported": 1}
        await resolve_transfer.save_manifest(result)

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            entries = resolve_transfer.manifest_generation_entries(["p1"])

        self.assertIn(
            {
                "project_id": "p1",
                "generation_id": "generation-01",
                "local_path": str(Path(result["items"][0]["local_path"]).resolve()),
            },
            entries,
        )

    async def test_selection_index_rejects_manifest_item_outside_render_root(self):
        result = await self._transfer(
            [self._generation(1, "ep001/c0010")], "selection-unsafe"
        )
        manifest_path = Path(result["manifest_path"])
        saved = json.loads(manifest_path.read_text("utf-8"))
        saved["items"][0]["local_path"] = str(self.root / "outside.mp4")
        manifest_path.write_text(json.dumps(saved), encoding="utf-8")

        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(self.render), "error": None},
        ):
            entries = resolve_transfer.manifest_generation_entries(["p1"])

        self.assertEqual(entries, [])

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
        """파일명 = <프로젝트>_<폴더 경로를 _ 로 이음>_davinci_<작업자>_<번호 3자리>(§7). 번호는 폴더·작업자마다 따로 센다(001 부터)."""
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
                dv("ep001_c0010", 1),
                dv("ep002_c0020", 1),
                dv("ep001_c0010", 2),
            ],
        )
        for item in result["items"]:
            self.assertTrue(Path(item["local_path"]).is_file())

    async def test_old_numbered_files_stay_and_numbers_on_disk_are_never_reused(self):
        """옛 규칙(<폴더>_NN · <폴더>_davinci_NNN)의 파일은 그대로 둔다. 새 이름은 장부가 정하되, 장부에 없더라도 폴더에
        이미 있는 같은 작업자의 §7 번호는 **종류와 무관하게** 건너뛴다(장부를 잃어도 있는 파일의 번호를 다른 영상에 주지 않는다)."""
        folder = self.render / "ep001" / "c0010"
        (folder / "shared").mkdir(parents=True)
        kept = {
            folder / "ep001_c0010_00.mp4": b"older-take",  # 옛 다빈치 이름
            folder / "ep001_c0010_davinci_009.mp4": b"sent-under-the-previous-rule",  # §6 이름 — §7 번호와 무관하다
            folder / "테스트_프로젝트_ep001_c0010_fin_noname_004.mp4": b"saved-final",  # 같은 작업자의 저장본 — 번호 한 줄을 같이 쓴다
            folder / "shared" / "테스트_프로젝트_ep001_c0010_share_noname_006.mp4": b"saved-shared",  # shared/ 안의 것도
            folder / "테스트_프로젝트_ep001_c0010_davinci_리버_020.mp4": b"another-worker",  # 다른 작업자의 줄
        }
        for path, data in kept.items():
            path.write_bytes(data)

        result = await self._transfer([self._generation(1, "ep001/c0010")], "gap")

        self.assertEqual(result["items"][0]["filename"], dv("ep001_c0010", 7))
        self.assertEqual({path: path.read_bytes() for path in kept}, kept)
        self.assertEqual(list(folder.glob("*.part")), [])

    async def test_resending_the_same_generation_keeps_one_file(self):
        """같은 생성물을 또 보내도 파일은 하나다 — 처음 받은 이름의 그 파일을 그대로 쓴다."""
        generation = self._generation(1, "ep001/c0010")

        first = await self._transfer([generation], "resend-first")
        second = await self._transfer([generation], "resend-second")
        third = await self._transfer([generation], "resend-third")

        self.assertEqual([r["items"][0]["status"] for r in (first, second, third)], ["downloaded", "skipped", "skipped"])
        self.assertEqual({r["items"][0]["filename"] for r in (first, second, third)}, {dv("ep001_c0010", 1)})
        self.assertEqual(
            sorted(path.name for path in (self.render / "ep001" / "c0010").iterdir()),
            [dv("ep001_c0010", 1)],
        )

    async def test_emptying_the_folder_keeps_each_generations_number(self):
        """폴더를 다 비워도 번호는 처음부터 다시 세지 않는다 — 생성물은 제 이름으로 돌아오고, 새 생성물은 다음 번호를 받는다."""
        first_gen = self._generation(1, "ep001/c0010")
        await self._transfer([first_gen, self._generation(2, "ep001/c0010")], "wipe-1")
        folder = self.render / "ep001" / "c0010"
        for path in list(folder.iterdir()):
            path.unlink()

        again = await self._transfer([first_gen, self._generation(3, "ep001/c0010")], "wipe-2")

        self.assertEqual([item["filename"] for item in again["items"]], [dv("ep001_c0010", 1), dv("ep001_c0010", 3)])
        self.assertEqual([item["status"] for item in again["items"]], ["downloaded", "downloaded"])

    async def test_deleted_file_comes_back_under_the_same_name(self):
        """가운데 파일만 지웠으면 다시 보낼 때 같은 이름으로 다시 놓인다(다빈치가 물고 있던 그 경로가 살아난다)."""
        gone = self._generation(2, "ep001/c0010")
        await self._transfer(
            [self._generation(1, "ep001/c0010"), gone, self._generation(3, "ep001/c0010")],
            "hole-1",
        )
        (self.render / "ep001" / "c0010" / dv("ep001_c0010", 2)).unlink()

        again = await self._transfer([gone], "hole-2")

        self.assertEqual((again["items"][0]["filename"], again["items"][0]["status"]), (dv("ep001_c0010", 2), "downloaded"))

    async def test_names_are_kept_in_the_render_folder_registry(self):
        """번호는 렌더 폴더의 이름 장부(_mvhub_sync/names2 — 저장본과 같은 장부)가 기억한다 — @davinci 에는 번호 파일을 두지 않는다."""
        await self._transfer([self._generation(1, "ep001/c0010")], "registry")

        self.assertFalse((self.root / "@davinci" / ".mvhub" / "sequence.json").exists())
        entries = sorted(p.name.split(".")[0] for p in (self.render / "_mvhub_sync" / "names2").rglob("*") if p.is_file())
        self.assertEqual(entries, ["d", "g", "n"])  # 확정 표식 · 생성물의 번호 · 번호의 주인
        self.assertFalse((self.render / "_mvhub_sync" / "names").exists())  # 옛 장부에는 새 번호를 만들지 않는다

    async def test_one_generation_has_one_number_whatever_the_kind(self):
        """저장본과 다빈치 파일은 서로 다른 파일이지만 번호는 같다 — 그 생성물이 이름을 처음 받을 때 정해진 번호다."""
        shared_first = self._generation(2, "ep001/c0010")
        ident = export_names.Ident("p1", "테스트 프로젝트", None, shared_first["id"], None)
        folder = self.render / "ep001" / "c0010"
        saved = export_names.NameBook2(self.render, "ep001/c0010").allocate(ident, "share", ".mp4", [folder, folder / "shared"])
        self.assertEqual(saved, "테스트_프로젝트_ep001_c0010_share_noname_001.mp4")  # 공유 저장이 먼저 번호를 받았다

        result = await self._transfer([self._generation(1, "ep001/c0010"), shared_first], "same-number")

        self.assertEqual([item["filename"] for item in result["items"]], [dv("ep001_c0010", 2), dv("ep001_c0010", 1)])

    async def test_the_worker_shown_on_the_card_is_in_the_name(self):
        mine, theirs = self._generation(1, "ep001/c0010"), self._generation(2, "ep001/c0010")
        mine["creator_name"], theirs["creator_name"] = "리버", "Jay Lee"

        result = await self._transfer([mine, theirs], "workers")

        self.assertEqual([item["filename"] for item in result["items"]],
                         [dv("ep001_c0010", 1, "리버"), dv("ep001_c0010", 1, "Jay_Lee")])  # 작업자마다 001 부터

    async def test_a_file_sent_under_the_previous_rule_is_reused_as_it_is(self):
        """§6 이름(`<폴더>_davinci_<번호>`)으로 이미 보낸 파일은 그대로 다시 쓴다 — §7 이름으로 한 번 더 놓지 않는다.
        그 파일이 지워졌으면 §7 이름으로 새로 놓는다."""
        generation = self._generation(1, "ep001/c0010")
        folder = self.render / "ep001" / "c0010"
        folder.mkdir(parents=True)
        old = export_names.Books(self.render).get("ep001/c0010", export_names.DAVINCI)
        sent = folder / old.allocate(generation["id"], ".mp4", folder)
        sent.write_bytes(b"sent-under-the-previous-rule")
        old.mark_done(generation["id"])

        again = await self._transfer([generation], "previous-rule")

        self.assertEqual((again["items"][0]["status"], again["items"][0]["filename"]), ("skipped", "ep001_c0010_davinci_001.mp4"))
        self.assertEqual([p.name for p in folder.iterdir()], ["ep001_c0010_davinci_001.mp4"])
        self.assertFalse((self.render / "_mvhub_sync" / "names2").exists())  # 번호도 만들지 않았다
        sent.unlink()
        fresh = await self._transfer([generation], "previous-rule-gone")
        self.assertEqual((fresh["items"][0]["status"], fresh["items"][0]["filename"]), ("downloaded", dv("ep001_c0010", 1)))

    async def test_unreadable_folder_fails_instead_of_restarting_at_zero(self):
        """폴더(장부)를 못 읽으면 '비었다' 로 보고 001 부터 세지 않고 실패로 남긴다."""
        generation = self._generation(1, "ep001/c0010")

        def explode(_path):
            raise PermissionError("NAS 접근 실패")

        with mock.patch.object(Path, "iterdir", explode):
            result = await self._transfer([generation], "unreadable")

        self.assertEqual(result["status"], "failed")
        self.assertIn("읽지 못했습니다", result["items"][0]["error"])

    async def test_existing_file_is_never_overwritten(self):
        """이미 그 번호를 쓰고 있는 파일은 크기가 같아도 건드리지 않고 다음 번호로 간다."""
        same = self._generation(1, "ep001/c0010")
        folder = self.render / "ep001" / "c0010"
        folder.mkdir(parents=True)
        source = self.media / same["assets"][0]["file_path"].removeprefix("/media/")
        # 크기만 같고 내용이 다른 파일이 001 을 차지하고 있다(장부에는 없다).
        (folder / dv("ep001_c0010", 1)).write_bytes(b"x" * source.stat().st_size)

        result = await self._transfer([same], "bytes")

        self.assertEqual(result["items"][0]["filename"], dv("ep001_c0010", 2))
        self.assertEqual((folder / dv("ep001_c0010", 1)).read_bytes(), b"x" * source.stat().st_size)

    async def test_a_file_dropped_in_after_the_folder_was_listed_is_refused_not_overwritten(self):
        """대상 폴더는 전송 한 건에 한 번만 훑는다(파일마다 훑지 않는다). 그 뒤 장부 없이 다음 번호 이름으로 놓인 파일은
        건너뛰지 못한다 — 덮지 않고 그 건만 오류로 남기며, 나머지는 다음 번호로 간다."""
        folder = self.render / "ep001" / "c0010"
        folder.mkdir(parents=True)
        dropped = folder / "ep001_c0010_davinci_002.mp4"
        real = resolve_transfer.export_names.disk_numbers
        listed = []

        def listed_then_dropped(target, base, token):
            found = real(target, base, token)
            listed.append(target)
            dropped.write_bytes(b"dropped-in-mid-transfer")
            return found

        generations = [self._generation(index, "ep001/c0010") for index in (1, 2, 3)]
        with (
            mock.patch.object(resolve_transfer.export_names, "disk_numbers", side_effect=listed_then_dropped),
            mock.patch.object(resolve_transfer.time, "sleep"),
        ):
            result = await self._transfer(generations, "dropped")

        self.assertEqual(len(listed), 1)  # 세 건을 보내도 폴더 열거는 한 번
        self.assertEqual([item["status"] for item in result["items"]], ["downloaded", "error", "downloaded"])
        self.assertIn("확인할 수 없는 파일", result["items"][1]["error"])
        self.assertEqual(dropped.read_bytes(), b"dropped-in-mid-transfer")
        self.assertEqual(
            [result["items"][0]["filename"], result["items"][2]["filename"]],
            ["ep001_c0010_davinci_001.mp4", "ep001_c0010_davinci_003.mp4"],
        )

    async def test_a_file_at_my_name_without_a_done_mark_is_trusted_only_if_bytes_match(self):
        """장부는 이 생성물의 이름이라 하는데 확정 표식이 없다(확정 직후 끊긴 전송·남이 놓은 파일) —
        원본과 바이트가 같을 때만 그 파일을 쓰고, 다르면 덮지 않고 오류로 남긴다."""
        generation = self._generation(1, "ep001/c0010")
        first = await self._transfer([generation], "mark-1")
        dest = Path(first["items"][0]["local_path"])
        marks = list((self.render / "_mvhub_sync" / "names2").rglob("d.davinci.*"))
        self.assertEqual(len(marks), 1)
        marks[0].unlink()

        with mock.patch.object(resolve_transfer.time, "sleep"):
            healed = await self._transfer([generation], "mark-2")
            self.assertEqual((healed["items"][0]["status"], healed["items"][0]["local_path"]), ("skipped", str(dest)))
            self.assertEqual(len(list((self.render / "_mvhub_sync" / "names2").rglob("d.davinci.*"))), 1)  # 표식을 다시 채웠다
            list((self.render / "_mvhub_sync" / "names2").rglob("d.davinci.*"))[0].unlink()
            dest.write_bytes(b"someone-elses-file")
            refused = await self._transfer([generation], "mark-3")
        self.assertEqual(refused["items"][0]["status"], "error")
        self.assertIn("확인할 수 없는 파일", refused["items"][0]["error"])
        self.assertEqual(dest.read_bytes(), b"someone-elses-file")

    async def test_a_file_already_sent_is_reused_even_when_the_original_is_gone(self):
        """전에 보낸 파일이 그대로 있으면 원본을 찾지 않는다 — 로컬 원본이 정리됐거나 원본 주소가 만료돼도 다시 보낼 수 있다."""
        generation = self._generation(1, "ep001/c0010")
        first = await self._transfer([generation], "gone-1")
        (self.media / generation["assets"][0]["file_path"].removeprefix("/media/")).unlink()

        async def no_source(_asset):
            raise AssertionError("이미 보낸 파일인데 원본을 찾았다")

        with mock.patch.object(resolve_transfer, "_cached_source", side_effect=no_source):
            again = await self._transfer([generation], "gone-2")

        self.assertEqual((again["items"][0]["status"], again["items"][0]["local_path"]), ("skipped", first["items"][0]["local_path"]))
        self.assertEqual(again["status"], "complete")

    async def test_the_creator_and_a_teammate_get_the_same_file_for_one_clip(self):
        """만든 PC(로컬 id + job_id)와 받은 PC(공유 카드의 id = job_id)가 같은 영상을 같은 이름으로 본다."""
        mine = self._generation(1, "ep001/c0010")
        mine["job_id"] = "hf-job-1"
        theirs = dict(mine, id="hf-job-1", job_id=None)

        first = await self._transfer([mine], "creator")
        second = await self._transfer([theirs], "teammate")

        self.assertEqual((first["items"][0]["status"], second["items"][0]["status"]), ("downloaded", "skipped"))
        self.assertEqual(first["items"][0]["local_path"], second["items"][0]["local_path"])

    async def test_resending_links_a_job_id_that_was_filled_in_later(self):
        """job_id 가 없을 때 보낸 영상 — job_id 가 채워진 뒤 다시 보내면(있는 파일을 그대로 쓴다) 그 job_id 로도 같은 번호를 찾게
        적는다. 안 적으면 job_id 만 같은 PC(받은 쪽 — id 가 다르다)가 같은 영상을 새 번호로 한 번 더 놓는다(Codex 코드 리뷰 P1)."""
        mine = self._generation(1, "ep001/c0010")
        first = await self._transfer([mine], "before-job-id")
        mine["job_id"] = "hf-job-1"
        again = await self._transfer([mine], "after-job-id")
        theirs = dict(mine, id="id-on-another-pc")

        teammate = await self._transfer([theirs], "teammate")

        self.assertEqual([r["items"][0]["status"] for r in (first, again, teammate)], ["downloaded", "skipped", "skipped"])
        self.assertEqual({r["items"][0]["local_path"] for r in (first, again, teammate)}, {first["items"][0]["local_path"]})
        self.assertEqual([p.name for p in (self.render / "ep001" / "c0010").iterdir()], [dv("ep001_c0010", 1)])

    async def test_a_file_confirmed_under_my_old_number_while_i_waited_is_used_not_refused(self):
        """복사를 마치고 확정하려는데 그 이름을 다른 전송이 먼저 확정했고, 그사이 이 영상의 번호가 다른 번호로 이어졌다 — 다시 읽은
        장부에서 그 파일은 '이어지기 전 번호의 확정 파일'이다. 지금 이름만 견주면 "확인할 수 없는 파일"로 거절한다(Codex 코드 리뷰)."""
        mine = self._generation(1, "ep001/c0010")
        folder = self.render / "ep001" / "c0010"
        ident = export_names.Ident("p1", "테스트 프로젝트", None, mine["id"], None)
        real_copy = resolve_transfer._copy_new

        def another_transfer_wins(source, dest):
            real_copy(source, dest)  # 같은 영상을 보내던 다른 전송이 같은 이름으로 먼저 확정했다
            other = export_names.NameBook2(self.render, "ep001/c0010")
            other.mark_done(ident, "davinci")
            other.allocate(export_names.Ident("p1", "테스트 프로젝트", None, "another-generation", None), "davinci", ".mp4", [folder])
            line = next(other.dir.glob("n.*.001")).name.split(".")[1]  # 그 뒤 001 이 002 로 이어졌다
            (other.dir / f"r.{line}.001").write_text(json.dumps({"line": line, "seq": 2, "folder": other.key}), encoding="utf-8")
            return False  # 나는 확정에 졌다

        with mock.patch.object(resolve_transfer, "_copy_new", side_effect=another_transfer_wins), mock.patch.object(resolve_transfer.time, "sleep"):
            result = await self._transfer([mine], "joined-while-waiting")

        self.assertEqual((result["items"][0]["status"], result["items"][0]["error"]), ("skipped", None))
        self.assertEqual(result["items"][0]["filename"], dv("ep001_c0010", 1))  # 이미 있는 그 파일을 그대로 쓴다
        self.assertEqual([p.name for p in folder.iterdir()], [dv("ep001_c0010", 1)])

    async def test_concurrent_same_destination_copies_serialize_without_overwrite(self):
        """R5 2-B — 같은 생성물을 동시에 보내면 같은 이름으로 모이고 목적지 락으로 직렬화된다: 대용량
        복사는 1회뿐이고 뒤엣것은 그 파일을 그대로 쓴다(last-writer 덮어쓰기 없음)."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "src.mp4"
            source.write_bytes(b"payload-bytes")
            ident = export_names.Ident("p1", "P", None, "gen-a", None)
            copy2 = resolve_transfer.shutil.copy2
            copy_calls: list[str] = []
            barrier = threading_module.Barrier(2)

            def slow_copy(src, dst):
                copy_calls.append(str(dst))
                time.sleep(0.05)  # 경합 창 확대 — 직렬화 없으면 둘 다 여기 진입한다
                return copy2(src, dst)

            results: list[tuple[str, bool]] = []
            errors: list[Exception] = []

            def run():
                barrier.wait()
                try:
                    with mock.patch.object(resolve_transfer.shutil, "copy2", slow_copy):
                        written, fresh = resolve_transfer._place_copy(
                            source, root, "out", "gen-a", ".mp4", resolve_transfer.export_names.Books(root), ident
                        )
                        results.append((written.name, fresh))
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading_module.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(errors, [])
            # 둘이 같은 이름으로 모인다 — 번호는 누가 먼저 적었느냐에 달렸다(진 쪽이 쥐었던 번호는 결번): 001 아니면 002
            name = results[0][0]
            self.assertRegex(name, r"^P_out_davinci_noname_00[12]\.mp4$")
            self.assertEqual(sorted(results), [(name, False), (name, True)])
            self.assertEqual(len(copy_calls), 1)  # 같은 이름에 두 번 복사되지 않는다
            self.assertEqual((root / "out" / name).read_bytes(), b"payload-bytes")
            self.assertEqual([p.name for p in (root / "out").iterdir()], [name])
            self.assertEqual(resolve_transfer._DEST_LOCKS, {})  # 레지스트리 회수 계약

    @unittest.skipUnless(os.name == "nt", "Windows extended 경로 잠금 키 검사")
    def test_dest_lock_uses_same_key_for_extended_and_normal_windows_path(self):
        normal = self.render / "out" / "final_00.mp4"
        extended = Path("\\\\?\\" + str(normal).upper())
        keys = []
        for path in (normal, extended):
            with resolve_transfer._dest_lock(path):
                self.assertEqual(len(resolve_transfer._DEST_LOCKS), 1)
                keys.append(next(iter(resolve_transfer._DEST_LOCKS)))
            self.assertEqual(resolve_transfer._DEST_LOCKS, {})
        self.assertEqual(keys[0], keys[1])

    async def test_concurrent_different_generations_take_different_numbers(self):
        """다른 생성물을 동시에 보내면 장부가 번호를 갈라 준다 — 둘 다 저장되고 어느 쪽도 덮이지 않는다."""
        import threading as threading_module

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_a = root / "a.mp4"
            source_a.write_bytes(b"content-a")
            source_b = root / "b.mp4"
            source_b.write_bytes(b"content-b")
            barrier = threading_module.Barrier(2)
            results: list[str] = []
            errors: list[Exception] = []

            def run(src, gen_key):
                barrier.wait()
                try:
                    path, _fresh = resolve_transfer._place_copy(
                        src, root, "out", gen_key, ".mp4", resolve_transfer.export_names.Books(root),
                        export_names.Ident("p1", "P", None, gen_key, None),
                    )
                    results.append(path.name)
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [
                threading_module.Thread(target=run, args=(src, key))
                for src, key in ((source_a, "gen-a"), (source_b, "gen-b"))
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(errors, [])
            self.assertEqual(sorted(results), ["P_out_davinci_noname_001.mp4", "P_out_davinci_noname_002.mp4"])
            written_paths = [path for path in (root / "out").iterdir() if path.is_file()]
            self.assertEqual(len(written_paths), 2)
            written = {path.read_bytes() for path in written_paths}
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
