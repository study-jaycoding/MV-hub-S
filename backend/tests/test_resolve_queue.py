"""Resolve 가져오기 큐 v3 계약 검증.

접수 즉시성·v2 공존·claim 잠금 상호 배제·부팅 복구 상태표·error_code 전달·취소 요청 영속·Bin 조회.
(전담 워커 모듈과 워커 없이는 못 도는 테스트는 2026-08-27 삭제 — 직접 전송이 현행.)
Resolve 실기기가 필요한 부분은 자식 프로세스 결과를 모의한다.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import Request

from app import active_account
from app.routers import resolve_integration
from app.services import (
    resolve_bridge,
    resolve_import_worker,
    resolve_lock,
    resolve_queue,
    resolve_status_runner,
    resolve_transfer,
)


BACKEND_DIR = Path(__file__).resolve().parents[1]


def _local_request() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 12345)})


def _load_menu_importer(name: str):
    """Resolve 메뉴 Importer 를 모듈로 불러온다(설치본과 같은 파일)."""
    import importlib.util

    script = BACKEND_DIR / "app" / "resources" / "resolve" / "MVHub_Importer.py"
    spec = importlib.util.spec_from_file_location(name, script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResolveQueueTestBase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.render = self.root / "Render"
        self.render.mkdir()
        self.media = self.root / "media"
        self.media.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.manifest_root = self.root / "@davinci"
        self._patches = [
            mock.patch.object(
                resolve_transfer.project_folders,
                "render_root_state",
                return_value={"render_path": str(self.render), "error": None},
            ),
            mock.patch.object(resolve_transfer, "MEDIA_DIR", self.media),
            mock.patch.object(resolve_lock, "DATA_DIR", self.data),
        ]
        for patch in self._patches:
            patch.start()
        # 프로세스 전역 기억(터미널 스캔 메모·루트 self-test·취소 요청표)은 테스트마다 비운다.
        resolve_queue.reset_scan_memo()
        resolve_queue.reset_cancel_requests()
        resolve_lock.reset_root_self_test()

    def tearDown(self):
        for patch in reversed(self._patches):
            patch.stop()
        resolve_queue.reset_scan_memo()
        resolve_queue.reset_cancel_requests()
        resolve_lock.reset_root_self_test()
        self.tmp.cleanup()

    def _generation(self, index: int, folder: str = "ep001/c0010") -> dict:
        rel = f"/media/{index:02d}/source-{index}.mp4"
        source = self.media / rel.removeprefix("/media/")
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes((f"video-{index}" * 50).encode())
        return {
            "id": f"generation-{index:02d}",
            "job_id": f"job-{index:02d}",
            "project_id": "p1",
            "project_name": "테스트 프로젝트",
            "folder_path": folder,
            "status": "done",
            "assets": [
                {
                    "id": f"asset-{index:02d}",
                    "type": "video",
                    "file_path": rel,
                    "source_url": f"https://cdn.example/source-{index}.mp4",
                }
            ],
        }

    def _accept(self, count: int = 1, transfer_id: str | None = None):
        generations = [self._generation(index) for index in range(1, count + 1)]
        manifest, ahead, _duplicate = resolve_queue.accept_sync(
            "p1",
            generations,
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="",
                account_email="",
                creator_uid="",
                server_origin="",
            ),
            transfer_id=transfer_id,
        )
        return manifest, ahead


class AcceptContractTests(ResolveQueueTestBase):
    def test_accept_writes_v3_manifest_without_copying_sources(self):
        manifest, ahead = self._accept(count=2, transfer_id="accept-basic")

        self.assertEqual(manifest["format"], "mvhub.resolve-transfer.v3")
        self.assertEqual(manifest["version"], 3)
        self.assertEqual(manifest["queue"]["state"], resolve_queue.STATE_QUEUED)
        self.assertEqual(manifest["queue"]["revision"], 1)
        self.assertEqual(manifest["queue"]["dispatch_policy"], "auto")
        self.assertEqual(ahead, 0)
        self.assertEqual(manifest["status"], "pending")
        self.assertEqual(manifest["total"], 2)
        # 접수는 파일을 만들지 않는다 — Render 아래가 비어 있어야 한다.
        self.assertEqual(list(self.render.rglob("*.mp4")), [])
        saved = json.loads(Path(manifest["manifest_path"]).read_text("utf-8"))
        self.assertEqual(saved["queue"]["state"], "queued")
        self.assertEqual(saved["items"][0]["prepare"]["state"], "queued")
        self.assertEqual(saved["items"][0]["item_id"], "item-0001")

    def test_runtime_queue_is_scoped_to_the_pc_that_accepted_it(self):
        def accept_for_host(transfer_id: str, host_id: str):
            return resolve_queue.accept_sync(
                "p1",
                [self._generation(1)],
                resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
                account_scope=resolve_queue.build_account_scope(
                    account_key="acct:artist@example.com",
                    account_email="artist@example.com",
                    creator_uid="user-1",
                    server_origin="https://hub.example.com",
                    host_id=host_id,
                ),
                transfer_id=transfer_id,
            )[0]

        own = accept_for_host("owned-here", "host-a")
        accept_for_host("owned-elsewhere", "host-b")
        self._accept(transfer_id="legacy-without-host")

        rows = resolve_queue.queue_snapshot(["p1"], owner_host_id="host-a")

        self.assertEqual([row["transfer_id"] for row in rows], ["owned-here"])
        self.assertEqual(
            resolve_queue.find_manifest(
                ["p1"], "owned-here", owner_host_id="host-a"
            )["manifest_path"],
            own["manifest_path"],
        )
        with self.assertRaises(resolve_queue.ResolveQueueError):
            resolve_queue.find_manifest(
                ["p1"], "owned-elsewhere", owner_host_id="host-a"
            )

    def test_source_payload_keeps_restartable_keys_and_no_cdn_url(self):
        manifest, _ahead = self._accept(transfer_id="accept-payload")
        payload = manifest["source_payload"]
        self.assertEqual(payload["schema"], 1)
        self.assertEqual(
            payload["reconstruction"]["generation_lookup_order"],
            ["local_generation_id", "local_job_id", "scoped_remote_generation_id"],
        )
        self.assertEqual(payload["reconstruction"]["cdn_credentials"], "never_persist")
        contract = payload["destination_contract"]
        self.assertEqual(contract["accepted_root"], str(self.render))
        self.assertTrue(contract["root_identity"])
        ref = manifest["items"][0]["source_ref"]
        self.assertEqual(ref["local_generation_id"], "generation-01")
        self.assertEqual(ref["job_id"], "job-01")
        self.assertEqual(ref["asset_id"], "asset-01")
        self.assertEqual(ref["cached_media_ref"], "/media/01/source-1.mp4")
        # 서명 URL·토큰은 어디에도 남지 않는다.
        self.assertNotIn("cdn.example", json.dumps(manifest, ensure_ascii=False))

    def test_ahead_counts_active_transfers_only(self):
        self._accept(transfer_id="accept-first")
        _manifest, ahead = self._accept(transfer_id="accept-second")
        self.assertEqual(ahead, 1)

    def test_account_scope_origin_drops_query_and_userinfo(self):
        scope = resolve_queue.build_account_scope(
            account_key="acct:artist@example.com",
            account_email="artist@example.com",
            creator_uid="user_1",
            server_origin="https://user:pw@hub.example.com/path?token=secret#frag",
        )
        self.assertEqual(scope["server_origin"], "https://hub.example.com")
        self.assertEqual(scope["kind"], "shared_account")

    async def test_route_prepares_and_imports_directly(self):
        generations = [self._generation(1)]
        manifest = {
            "transfer_id": "direct-1",
            "project_id": "p1",
            "project_name": "테스트 프로젝트",
            "total": 1,
            "downloaded": 1,
            "skipped": 0,
            "error_count": 0,
            "items": [],
        }
        imported = {
            "status": "complete",
            "imported": 1,
            "skipped": 0,
            "error_count": 0,
            "items": [],
        }
        body = resolve_integration.ResolveTransferIn(
            gen_ids=["generation-01"],
            resolve_project_id="resolve-1",
            resolve_project_name="EP01_EDIT",
        )
        with (
            mock.patch.object(
                resolve_integration.repo,
                "get_generations_batch",
                return_value={"generation-01": generations[0]},
            ),
            mock.patch.object(
                resolve_integration, "batch_view_member_projects", return_value=set()
            ),
            mock.patch.object(
                resolve_integration,
                "can_view_generation_with_member_projects",
                return_value=True,
            ),
            mock.patch.object(
                resolve_integration.active_account, "account_key", return_value=""
            ),
            mock.patch.object(
                resolve_integration.active_account, "active_email", return_value=""
            ),
            mock.patch.object(
                resolve_integration, "account_scope_uid", return_value=None
            ),
            mock.patch.object(resolve_integration._proxy, "proxying", return_value=False),
            mock.patch.object(
                resolve_integration,
                "transfer_generations",
                new=mock.AsyncMock(return_value=manifest),
            ) as transfer,
            mock.patch.object(
                resolve_integration,
                "run_resolve_import_isolated",
                return_value=imported,
            ) as importer,
            mock.patch.object(
                resolve_integration, "save_manifest", new=mock.AsyncMock()
            ) as save,
        ):
            response = await resolve_integration.create_resolve_transfer(
                body, _local_request()
            )

        self.assertEqual(response["transfer_id"], "direct-1")
        self.assertEqual(response["resolve_target"]["project_name"], "EP01_EDIT")
        self.assertEqual(response["resolve_import"], imported)
        transfer.assert_awaited_once_with("p1", generations)
        importer.assert_called_once_with(manifest)
        self.assertEqual(save.await_count, 2)


class ManifestCoexistenceTests(ResolveQueueTestBase):
    async def test_v2_scanner_ignores_v3_and_v3_scanner_ignores_v2(self):
        v2 = await resolve_transfer.transfer_generations(
            "p1", [self._generation(9)], transfer_id="legacy-v2"
        )
        self.assertEqual(v2["format"], "mvhub.resolve-transfer")
        self._accept(transfer_id="modern-v3")

        pending = resolve_transfer.list_pending_manifests(["p1"])
        self.assertEqual([item["transfer_id"] for item in pending], ["legacy-v2"])

        queued = resolve_queue.scan_projects(["p1"])
        self.assertEqual([item["transfer_id"] for item in queued], ["modern-v3"])

    async def test_v2_manifest_is_never_rewritten_by_queue_layer(self):
        v2 = await resolve_transfer.transfer_generations(
            "p1", [self._generation(8)], transfer_id="legacy-untouched"
        )
        path = Path(v2["manifest_path"])
        before = path.read_bytes()
        self._accept(transfer_id="modern-untouched")
        resolve_queue.recover_boot(["p1"])
        self.assertEqual(path.read_bytes(), before)

    def test_menu_importer_skips_v3_manifests(self):
        import importlib.util

        script = BACKEND_DIR / "app" / "resources" / "resolve" / "MVHub_Importer.py"
        spec = importlib.util.spec_from_file_location("mvhub_importer_v3_test", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertTrue(module._requires_claim({"format": "mvhub.resolve-transfer.v3"}))
        self.assertTrue(module._requires_claim({"version": 3}))
        self.assertFalse(module._requires_claim({"format": "mvhub.resolve-transfer"}))
        self.assertFalse(module._requires_claim({}))


class ClaimLockTests(ResolveQueueTestBase):
    def test_second_process_cannot_take_the_same_transfer_lock(self):
        manifest, _ahead = self._accept(transfer_id="lock-exclusive")
        lock_path = resolve_lock.transfer_lock_path(
            Path(manifest["manifest_root"]), "lock-exclusive"
        )
        script = textwrap.dedent(
            f"""
            import sys
            sys.path.insert(0, {str(BACKEND_DIR)!r})
            from app.services import resolve_lock
            lock = resolve_lock.FileLock({str(lock_path)!r})
            print("acquired" if lock.try_acquire() else "busy")
            """
        )
        holder = resolve_lock.FileLock(lock_path)
        self.assertTrue(holder.try_acquire())
        try:
            busy = subprocess.run(
                [sys.executable, "-c", script], capture_output=True, text=True
            )
        finally:
            holder.release()
        free = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True
        )

        self.assertEqual(busy.stdout.strip(), "busy", busy.stderr)
        self.assertEqual(free.stdout.strip(), "acquired", free.stderr)

    def test_lock_file_survives_acquire_release_cycles(self):
        path = self.data / "locks" / "keepme.lock"
        for _ in range(3):
            lock = resolve_lock.FileLock(path)
            self.assertTrue(lock.try_acquire())
            lock.release()
        self.assertTrue(path.is_file())

    @unittest.skipUnless(sys.platform == "win32", "LockFileEx 자체 검사는 Windows 계약")
    def test_self_test_detects_working_byte_range_locks(self):
        ok, detail = resolve_lock.self_test(self.data / "locks")
        self.assertTrue(ok, detail)


class BootRecoveryTests(ResolveQueueTestBase):
    def _accept_in_state(self, transfer_id: str, state: str) -> dict:
        manifest, _ahead = self._accept(transfer_id=transfer_id)
        path = Path(manifest["manifest_path"])
        resolve_queue.set_state(manifest, state)
        resolve_queue.save_manifest(path, manifest)
        return manifest

    def test_state_table_requeues_prepare_and_isolates_import(self):
        self._accept_in_state("boot-queued", resolve_queue.STATE_QUEUED)
        self._accept_in_state("boot-preparing", resolve_queue.STATE_PREPARING)
        self._accept_in_state("boot-ready", resolve_queue.STATE_READY)
        self._accept_in_state("boot-importing", resolve_queue.STATE_IMPORTING)

        resolve_queue.recover_boot(["p1"])
        states = {
            manifest["transfer_id"]: resolve_queue.queue_state(manifest)
            for manifest in resolve_queue.scan_projects(["p1"])
        }
        self.assertEqual(states["boot-queued"], resolve_queue.STATE_QUEUED)
        self.assertEqual(states["boot-preparing"], resolve_queue.STATE_QUEUED)
        self.assertEqual(states["boot-ready"], resolve_queue.STATE_READY)
        self.assertEqual(states["boot-importing"], resolve_queue.STATE_INTERRUPTED)

        interrupted = next(
            manifest
            for manifest in resolve_queue.scan_projects(["p1"])
            if manifest["transfer_id"] == "boot-importing"
        )
        # 자동 재실행 금지 — 사용자 확인 전에는 워커가 집어가지 않는다.
        self.assertEqual(interrupted["queue"]["dispatch_policy"], "manual_only")
        self.assertEqual(interrupted["queue"]["last_error"]["code"], "child_crashed")

    def test_orphan_rebuild_bin_journal_forces_recovery_required(self):
        manifest = self._accept_in_state(
            "boot-orphan", resolve_queue.STATE_IMPORTING
        )
        attempt_id = "attempt-orphan"
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id=attempt_id,
            claim={"token": "t", "epoch": 1},
            executor="push_worker",
        )
        attempt["phase"] = "rebuild_to_staging"
        attempt["side_effects_started"] = True
        # 브리지가 실제로 만드는 이름 형식(__MVHUB_REBUILD_<hex>__).
        attempt["staging_bin"] = "__MVHUB_REBUILD_a1b2c3d4e5f6__"
        resolve_queue.write_attempt(manifest, attempt)

        resolve_queue.recover_boot(["p1"])
        recovered = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(recovered), resolve_queue.STATE_RECOVERY_REQUIRED
        )
        self.assertEqual(recovered["queue"]["last_error"]["code"], "orphan_rebuild_bin")
        self.assertEqual(recovered["queue"]["dispatch_policy"], "manual_only")
        incident = resolve_queue.recovery_path(Path(recovered["manifest_root"]), "resolve-1")
        self.assertTrue(incident.is_file())

    def test_live_lock_holder_is_not_recovered(self):
        manifest = self._accept_in_state("boot-live", resolve_queue.STATE_IMPORTING)
        lock = resolve_queue.transfer_lock(manifest)
        self.assertTrue(lock.try_acquire())
        try:
            resolve_queue.recover_boot(["p1"])
        finally:
            lock.release()
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_IMPORTING
        )

    def test_orphan_bin_pattern_matches_bridge_staging_names(self):
        # resolve_bridge 는 정렬용 임시 Bin 을 __MVHUB_REBUILD_<uuid hex>__ 로 만든다.
        self.assertTrue(
            resolve_queue.is_orphan_rebuild_bin("__MVHUB_REBUILD_" + "0a1b2c3d" * 4 + "__")
        )
        self.assertFalse(resolve_queue.is_orphan_rebuild_bin("MV Hub"))
        self.assertFalse(resolve_queue.is_orphan_rebuild_bin("__MVHUB_REBUILD__"))


class ErrorCodeContractTests(ResolveQueueTestBase):
    def test_bridge_outer_catch_preserves_bridge_error_code(self):
        def _boom(_manifest, _resolve):
            raise resolve_bridge.ResolveBridgeError(
                "프로젝트가 달라졌습니다", code="project_changed"
            )

        with mock.patch.object(resolve_bridge, "_import_manifest_locked", _boom):
            result = resolve_bridge.import_manifest_to_current_project(
                {"items": []}, resolve=object()
            )

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_code"], "project_changed")

    def test_bridge_unknown_exception_is_unexpected_error(self):
        def _boom(_manifest, _resolve):
            raise RuntimeError("무슨 일이 났는지 모름")

        with mock.patch.object(resolve_bridge, "_import_manifest_locked", _boom):
            result = resolve_bridge.import_manifest_to_current_project(
                {"items": []}, resolve=object()
            )

        self.assertEqual(result["error_code"], "unexpected_error")

    def test_runner_labels_child_crash_and_missing_interpreter(self):
        crashed = subprocess.CompletedProcess(
            args=[], returncode=3221225477, stdout="", stderr=""
        )
        with (
            mock.patch.object(
                resolve_status_runner,
                "_select_interpreter",
                return_value=("python.exe", {"status": "ready"}, ""),
            ),
            mock.patch.object(
                resolve_status_runner.subprocess, "run", return_value=crashed
            ),
        ):
            result = resolve_status_runner.run_resolve_import_isolated({"items": []})
        self.assertEqual(result["error_code"], "child_crashed")

        with mock.patch.object(
            resolve_status_runner, "_select_interpreter", return_value=(None, None, "x")
        ):
            missing = resolve_status_runner.run_resolve_import_isolated({"items": []})
        self.assertEqual(missing["error_code"], "python_incompatible")


class WorkerFixtureBase(ResolveQueueTestBase):
    """접수(accept_sync) 기반 테스트 공용 픽스처 — 생성물 N개를 만들어 접수까지 해 준다."""

    def _register(self, count: int) -> list[dict]:
        return [self._generation(index) for index in range(1, count + 1)]

    def _accept_registered(
        self, transfer_id: str, count: int = 1, *, host_id: str | None = None
    ):
        generations = self._register(count)
        manifest, ahead, _duplicate = resolve_queue.accept_sync(
            "p1",
            generations,
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="",
                account_email="",
                creator_uid="",
                server_origin="",
                host_id=host_id if host_id is not None else resolve_lock.host_id(),
            ),
            transfer_id=transfer_id,
        )
        return manifest, ahead


class QueueSnapshotTests(WorkerFixtureBase):


    async def test_queue_snapshot_reports_state_and_ahead(self):
        self._accept_registered("snap-aaa")
        self._accept_registered("snap-bbb")
        rows = await asyncio.to_thread(resolve_queue.queue_snapshot, ["p1"])

        self.assertEqual([row["transfer_id"] for row in rows], ["snap-aaa", "snap-bbb"])
        self.assertEqual([row["ahead"] for row in rows], [0, 1])
        self.assertEqual(rows[0]["state"], "queued")
        self.assertEqual(rows[0]["resolve_target"]["project_name"], "EP01_EDIT")


class RetryRouteAtomicityTests(ResolveQueueTestBase):
    async def test_retry_saves_import_result_even_when_request_is_cancelled(self):
        manifest = {"project_id": "p1", "transfer_id": "retry-shield"}
        started = threading.Event()

        def _slow_import(_manifest):
            started.set()
            import time

            time.sleep(0.3)
            return {"status": "complete", "error_code": None, "imported": 1}

        with (
            mock.patch.object(
                resolve_integration,
                "load_manifest",
                new=mock.AsyncMock(return_value=manifest),
            ),
            mock.patch.object(
                resolve_integration, "run_resolve_import_isolated", _slow_import
            ),
            mock.patch.object(
                resolve_integration, "save_manifest", new=mock.AsyncMock()
            ) as save,
        ):
            task = asyncio.create_task(
                resolve_integration.retry_resolve_transfer(
                    resolve_integration.ResolveRetryIn(
                        project_id="p1", transfer_id="retry-shield"
                    ),
                    _local_request(),
                )
            )
            await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        # 실행만 살고 저장이 유기되면 다음 실행이 같은 가져오기를 또 한다.
        save.assert_awaited_once_with(manifest)
        self.assertEqual(manifest["resolve_import"]["status"], "complete")


class ScannerCoverageTests(ResolveQueueTestBase):
    """P1-1 — 스캐너가 새 접수를 놓치지 않는다(유실 0)."""

    def _finish(self, transfer_id: str) -> None:
        manifest, _ahead = self._accept(transfer_id=transfer_id)
        path = Path(manifest["manifest_path"])
        resolve_queue.set_state(manifest, resolve_queue.STATE_COMPLETE)
        resolve_queue.save_manifest(path, manifest)

    def test_completed_backlog_never_hides_a_newly_accepted_transfer(self):
        # 이름순으로 앞서는 완료본이 상한을 넘게 쌓여 있어도 새 접수는 발견돼야 한다.
        for index in range(5):
            self._finish(f"aaa-done-{index:02d}")
        self._accept(transfer_id="zzz-new")

        with mock.patch.object(resolve_queue, "_SCAN_FILE_LIMIT", 3):
            active = resolve_queue.scan_projects(
                ["p1"], states=resolve_queue.ACTIVE_STATES
            )
        self.assertEqual([item["transfer_id"] for item in active], ["zzz-new"])

    def test_terminal_manifests_are_read_once_then_skipped_by_stat(self):
        for index in range(3):
            self._finish(f"aaa-done-{index:02d}")
        self._accept(transfer_id="zzz-new")
        resolve_queue.reset_scan_memo()  # 접수 중 ahead 스캔이 이미 기억한 것을 지운다
        original = resolve_queue.read_manifest
        with mock.patch.object(
            resolve_queue, "read_manifest", wraps=original
        ) as reader:
            resolve_queue.scan_projects(["p1"], states=resolve_queue.ACTIVE_STATES)
            first = reader.call_count
            reader.reset_mock()
            resolve_queue.scan_projects(["p1"], states=resolve_queue.ACTIVE_STATES)
            second = reader.call_count
        self.assertEqual(first, 4)  # 첫 바퀴는 전량 판독
        self.assertEqual(second, 1)  # 완료본 3건은 stat 만으로 건너뛴다


    def test_manifest_root_registry_records_accept_root(self):
        self._accept(transfer_id="root-remembered")
        roots = [
            resolve_queue.path_identity(root)
            for root in resolve_queue.known_manifest_roots("p1")
        ]
        self.assertIn(resolve_queue.path_identity(self.manifest_root), roots)


class MenuImporterLockTests(ResolveQueueTestBase):
    """P1-2 — 메뉴 Importer 가 허브 워커와 같은 .lock 에 참여한다."""

    def test_importer_lock_is_the_same_file_the_hub_worker_takes(self):
        module = _load_menu_importer("mvhub_importer_lock_same_file")
        lock_path = resolve_lock.project_lock_path(self.manifest_root)
        self.assertEqual(
            module._project_lock_path({"manifest_root": str(self.manifest_root)}),
            str(lock_path),
        )
        holder = resolve_lock.FileLock(lock_path)
        self.assertTrue(holder.try_acquire())
        importer_lock = module.FileLock(str(lock_path))
        try:
            self.assertFalse(importer_lock.try_acquire())
        finally:
            holder.release()
        self.assertTrue(importer_lock.try_acquire())
        importer_lock.release()

    def test_importer_stops_when_hub_worker_holds_the_machine_lock(self):
        module = _load_menu_importer("mvhub_importer_lock_machine")
        machine_lock_path = resolve_lock.machine_lock_path()

        def _http(method, path, payload=None, bases=None):
            if path == "/api/resolve/transfers/pending":
                return {"items": [{"format": "mvhub.resolve-transfer"}]}, "http://hub"
            if path == "/api/resolve/locks":
                return {"machine_lock_path": str(machine_lock_path)}, "http://hub"
            raise AssertionError(path)

        holder = resolve_lock.FileLock(machine_lock_path)
        self.assertTrue(holder.try_acquire())
        resolve_obj = mock.MagicMock()
        try:
            with mock.patch.object(module, "_http_json", _http):
                message = module.import_pending(resolve_obj)
        finally:
            holder.release()

        self.assertEqual(message, module.BUSY_MESSAGE)
        # Resolve 는 아예 건드리지 않는다.
        resolve_obj.GetProjectManager.assert_not_called()

    def test_importer_skips_a_project_the_worker_is_importing(self):
        module = _load_menu_importer("mvhub_importer_lock_project")
        media = self.render / "ready.mp4"
        media.write_bytes(b"clip")
        manifest = {
            "format": "mvhub.resolve-transfer",
            "transfer_id": "v2-busy",
            "project_id": "p1",
            "project_name": "테스트 프로젝트",
            "manifest_root": str(self.manifest_root),
            "items": [
                {
                    "status": "downloaded",
                    "local_path": str(media),
                    "folder_path": "ep001/c0010",
                }
            ],
        }

        def _http(method, path, payload=None, bases=None):
            if path == "/api/resolve/transfers/pending":
                return {"items": [manifest]}, "http://hub"
            if path == "/api/resolve/locks":
                return {"machine_lock_path": ""}, "http://hub"
            raise AssertionError(path)

        holder = resolve_lock.FileLock(
            resolve_lock.project_lock_path(self.manifest_root)
        )
        self.assertTrue(holder.try_acquire())
        resolve_obj = mock.MagicMock()
        media_pool = (
            resolve_obj.GetProjectManager.return_value.GetCurrentProject.return_value.GetMediaPool.return_value
        )
        media_pool.GetCurrentFolder.return_value = None
        try:
            with mock.patch.object(module, "_http_json", _http):
                message = module.import_pending(resolve_obj)
        finally:
            holder.release()

        self.assertIn("사용 중", message)
        media_pool.AddSubFolder.assert_not_called()
        media_pool.ImportMedia.assert_not_called()


class RootLockingSelfTestTests(ResolveQueueTestBase):
    """P1-2 — self-test 를 실제 manifest 루트(NAS)에서 한다."""

    @unittest.skipUnless(sys.platform == "win32", "LockFileEx 자체 검사는 Windows 계약")
    def test_self_test_runs_inside_the_manifest_root_not_local_data(self):
        self._accept(transfer_id="selftest-root")
        probe = self.manifest_root / ".mvhub" / "locks" / "locking-self-test.lock"
        self.assertTrue(probe.is_file())

    def test_accept_is_refused_when_the_manifest_root_cannot_lock(self):
        with (
            mock.patch.object(resolve_queue.os, "name", "nt"),
            mock.patch.object(
                resolve_lock, "root_self_test", return_value=(False, "SMB 잠금 없음")
            ),
        ):
            with self.assertRaises(resolve_transfer.ResolveTransferError) as caught:
                self._accept(transfer_id="selftest-refused")
        self.assertIn("SMB 잠금 없음", str(caught.exception))


class ChildJournalTests(ResolveQueueTestBase):
    """P1-3 — 자식이 journal 을 실제로 쓰고, 부모가 그걸 덮지 않는다."""

    def _importing(self, transfer_id: str, attempt_id: str) -> dict:
        manifest, _ahead = self._accept(transfer_id=transfer_id)
        block = resolve_queue.queue_block(manifest)
        block["last_attempt_id"] = attempt_id
        block["claim"] = {"token": "tok", "epoch": 3, "owner": {}}
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        return manifest

    def test_child_refuses_to_touch_resolve_when_journal_cannot_be_written(self):
        manifest = self._importing("journal-broken", "attempt-broken")
        called = []
        with (
            mock.patch.object(
                resolve_import_worker,
                "atomic_write_text",
                side_effect=OSError("공유 폴더 오류"),
            ),
            mock.patch.object(
                resolve_import_worker,
                "import_manifest_to_current_project",
                lambda payload: called.append(payload),
            ),
        ):
            result = resolve_import_worker.run(manifest)

        self.assertEqual(result["error_code"], "journal_unavailable")
        self.assertEqual(called, [])

    def test_child_journal_path_matches_the_queue_layer(self):
        manifest = self._importing("journal-path", "attempt-path")
        self.assertEqual(
            resolve_import_worker.attempt_journal_path(manifest),
            resolve_queue.attempt_path(manifest, "attempt-path"),
        )
        # v2(큐 밖) manifest 에는 journal 이 없다 — 기존 재시도 경로는 그대로 동작한다.
        self.assertIsNone(
            resolve_import_worker.attempt_journal_path(
                {"manifest_root": str(self.manifest_root), "transfer_id": "v2"}
            )
        )

    def test_child_records_own_pid_phase_and_terminal_result(self):
        manifest = self._importing("journal-child", "attempt-child")

        def _fake_import(payload):
            resolve_bridge._journal("mutation_started", side_effects_started=True)
            resolve_bridge._journal(
                "rebuild_staging_created", staging_bin="__MVHUB_REBUILD_ab12cd34__"
            )
            return {
                "status": "complete",
                "error_code": None,
                "error": None,
                "imported": 1,
                "skipped": 0,
                "error_count": 0,
                "items": [],
            }

        with mock.patch.object(
            resolve_import_worker, "import_manifest_to_current_project", _fake_import
        ):
            result = resolve_import_worker.run(manifest)

        self.assertEqual(result["status"], "complete")
        record = resolve_queue.read_attempt(manifest, "attempt-child")
        self.assertIsNotNone(record)
        self.assertEqual(record["executor_pid"], resolve_import_worker.os.getpid())
        self.assertEqual(record["pid"], resolve_import_worker.os.getpid())
        self.assertTrue(record["process_started_at_filetime"] or sys.platform != "win32")
        self.assertEqual(record["claim_token"], "tok")
        self.assertEqual(record["staging_bin"], "__MVHUB_REBUILD_ab12cd34__")
        self.assertTrue(record["side_effects_started"])
        self.assertEqual(record["phase"], "complete")
        self.assertEqual(record["result"]["status"], "complete")


class ExecutorFencingTests(ResolveQueueTestBase):
    """P1-3 — 부모가 죽어도 자식이 살아 있으면 인계하지 않는다."""

    def _importing_with_live_child(self, transfer_id: str) -> dict:
        manifest, _ahead = self._accept(transfer_id=transfer_id)
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id="attempt-live",
            claim={"token": "tok", "epoch": 1},
            executor="push_worker",
        )
        attempt["executor_pid"] = 987654
        attempt["pid"] = 987654
        attempt["host_id"] = resolve_lock.host_id()
        attempt["phase"] = "import_batch_calling"
        attempt["side_effects_started"] = True
        resolve_queue.write_attempt(manifest, attempt)
        return manifest

    def test_boot_recovery_leaves_importing_alone_while_the_child_lives(self):
        self._importing_with_live_child("fence-alive")
        with mock.patch.object(resolve_lock, "process_liveness", return_value="alive"):
            counts = resolve_queue.recover_boot(["p1"])
        self.assertEqual(counts.get("import_executor_alive"), 1)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_IMPORTING
        )

    def test_parent_only_journal_is_never_mistaken_for_a_live_child(self):
        # 자식이 시작하기도 전에 죽은 경우 journal 에는 부모 PID 만 있다. 그 PID 가
        # 재사용돼 살아 있어도 '자식 생존'으로 읽으면 큐가 영원히 멈춘다.
        manifest, _ahead = self._accept(transfer_id="fence-parent-only")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id="attempt-parent-only",
            claim={"token": "tok", "epoch": 1},
            executor="push_worker",
        )
        self.assertEqual(attempt["executor_pid"], 0)
        resolve_queue.write_attempt(manifest, attempt)

        with mock.patch.object(resolve_lock, "process_liveness", return_value="alive"):
            self.assertEqual(resolve_queue.executor_liveness(attempt), "none")
            resolve_queue.recover_boot(["p1"])
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_INTERRUPTED
        )

    def test_dead_child_is_isolated_as_interrupted(self):
        self._importing_with_live_child("fence-dead")
        with mock.patch.object(resolve_lock, "process_liveness", return_value="dead"):
            resolve_queue.recover_boot(["p1"])
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_INTERRUPTED
        )


class AcceptAccountPinTests(ResolveQueueTestBase):
    """P1-4 — 접수 라우트 전체가 같은 계정을 본다 + server_origin 검증."""

    async def test_route_pins_the_account_before_the_first_db_access(self):
        generations = [self._generation(1)]
        manifest = {
            "transfer_id": "direct-pinned",
            "project_id": "p1",
            "project_name": "테스트 프로젝트",
            "total": 1,
            "downloaded": 1,
            "skipped": 0,
            "error_count": 0,
            "items": [],
        }
        seen: list[str | None] = []

        def _batch(ids, account_uid=None):
            # 첫 DB 접근 시점의 계정 — 고정이 없으면 머신 포인터를 그대로 읽는다.
            seen.append(active_account.account_key())
            return {"generation-01": generations[0]}

        body = resolve_integration.ResolveTransferIn(
            gen_ids=["generation-01"],
            resolve_project_id="resolve-1",
            resolve_project_name="EP01_EDIT",
        )
        with (
            mock.patch.object(active_account.config, "AUTH_ENABLED", False),
            mock.patch.object(
                resolve_integration,
                "_capture_account_pin",
                return_value=("acct:pinned@example.com", "user-pinned"),
            ),
            mock.patch.object(
                resolve_integration.repo, "get_generations_batch", side_effect=_batch
            ),
            mock.patch.object(
                resolve_integration, "batch_view_member_projects", return_value=set()
            ),
            mock.patch.object(
                resolve_integration,
                "can_view_generation_with_member_projects",
                return_value=True,
            ),
            mock.patch.object(
                resolve_integration, "account_scope_uid", return_value="user-pinned"
            ),
            mock.patch.object(resolve_integration._proxy, "proxying", return_value=False),
            mock.patch.object(
                resolve_integration,
                "transfer_generations",
                new=mock.AsyncMock(return_value=manifest),
            ),
            mock.patch.object(
                resolve_integration,
                "run_resolve_import_isolated",
                return_value={"status": "complete"},
            ),
            mock.patch.object(
                resolve_integration, "save_manifest", new=mock.AsyncMock()
            ),
        ):
            response = await resolve_integration.create_resolve_transfer(
                body, _local_request()
            )

        self.assertEqual(seen, ["acct:pinned@example.com"])
        self.assertEqual(manifest["transfer_id"], response["transfer_id"])
        # 오버라이드는 라우트가 끝나면 반드시 풀린다.
        self.assertIsNone(active_account._override.get())


class AcceptIdempotencyTests(ResolveQueueTestBase):
    """2단계 — 202 직전 크래시 뒤 재요청이 두 번째 전송을 만들지 않는다."""

    def _accept_with_key(self, key: str):
        return resolve_queue.accept_sync(
            "p1",
            [self._generation(1)],
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="", account_email="", creator_uid="", server_origin=""
            ),
            idempotency_key=key,
        )

    def test_same_accept_key_returns_the_first_transfer(self):
        first, _ahead, duplicate_first = self._accept_with_key("click-1")
        second, _ahead2, duplicate_second = self._accept_with_key("click-1")

        self.assertFalse(duplicate_first)
        self.assertTrue(duplicate_second)
        self.assertEqual(first["transfer_id"], second["transfer_id"])
        self.assertEqual(len(resolve_queue.scan_projects(["p1"])), 1)

    def test_different_accept_keys_stay_separate_transfers(self):
        first, _a, _d = self._accept_with_key("click-1")
        second, _b, duplicate = self._accept_with_key("click-2")
        self.assertNotEqual(first["transfer_id"], second["transfer_id"])
        self.assertFalse(duplicate)

    def test_same_accept_key_cannot_reuse_another_pcs_transfer(self):
        def accept(host_id: str):
            return resolve_queue.accept_sync(
                "p1",
                [self._generation(1)],
                resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
                account_scope=resolve_queue.build_account_scope(
                    account_key="acct:artist@example.com",
                    account_email="artist@example.com",
                    creator_uid="user-1",
                    server_origin="https://hub.example.com",
                    host_id=host_id,
                ),
                idempotency_key="same-click-key",
            )

        accept("host-a")
        with self.assertRaises(resolve_transfer.ResolveTransferError):
            accept("host-b")

    def test_ahead_ignores_other_projects_sharing_a_manifest_root(self):
        other = dict(self._generation(2), project_id="p2", project_name="다른 프로젝트")
        resolve_queue.accept_sync(
            "p2",
            [other],
            resolve_target={"project_id": "resolve-2", "project_name": "OTHER"},
            account_scope=resolve_queue.build_account_scope(
                account_key="", account_email="", creator_uid="", server_origin=""
            ),
            transfer_id="aaa-other-project",
        )
        _manifest, ahead = self._accept(transfer_id="zzz-mine")
        # 같은 @davinci 루트를 쓰지만 다른 프로젝트라 내 앞 대기가 아니다.
        self.assertEqual(ahead, 0)

    def test_ahead_ignores_finished_transfers(self):
        done, _ahead = self._accept(transfer_id="aaa-done")
        resolve_queue.set_state(done, resolve_queue.STATE_COMPLETE)
        resolve_queue.save_manifest(Path(done["manifest_path"]), done)
        _manifest, ahead = self._accept(transfer_id="zzz-next")
        self.assertEqual(ahead, 0)


class ManifestRevisionCasTests(ResolveQueueTestBase):
    """2단계 — 오래된 사본이 최신 manifest 를 조용히 덮어쓰지 못한다."""

    def test_stale_copy_cannot_overwrite_a_newer_manifest(self):
        stale, _ahead = self._accept(transfer_id="cas-guard")
        path = Path(stale["manifest_path"])
        fresh = resolve_queue.read_manifest(path)
        resolve_queue.set_state(fresh, resolve_queue.STATE_PREPARING)
        resolve_queue.save_manifest(path, fresh)

        resolve_queue.set_state(stale, resolve_queue.STATE_READY)
        with self.assertRaises(resolve_queue.ResolveQueueError):
            resolve_queue.save_manifest(path, stale)
        # 앞선 기록이 살아 있다.
        self.assertEqual(
            resolve_queue.queue_state(resolve_queue.read_manifest(path)),
            resolve_queue.STATE_PREPARING,
        )


class CancelContractTests(WorkerFixtureBase):
    """2단계 — 상태별 취소 시맨틱(§D)."""

    def test_queued_transfer_is_cancelled_immediately(self):
        manifest, _ahead = self._accept_registered("cancel-queued")
        outcome = resolve_queue.cancel_sync(manifest, requested_by="user-1")

        self.assertTrue(outcome["applied"])
        self.assertEqual(outcome["state"], resolve_queue.STATE_CANCELLED)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_CANCELLED
        )
        self.assertEqual(current["queue"]["cancel"]["requested_by"], "user-1")
        # v2 투영이 "pending" 으로 남으면 기존 화면이 아직 진행 중으로 읽는다.
        self.assertNotEqual(current["status"], "pending")
        self.assertNotEqual(current["resolve_import"]["status"], "pending")

    def test_running_transfer_only_gets_a_cooperative_request(self):
        manifest, _ahead = self._accept_registered("cancel-running")
        lock = resolve_queue.transfer_lock(manifest)
        self.assertTrue(lock.try_acquire())
        try:
            outcome = resolve_queue.cancel_sync(manifest)
        finally:
            lock.release()

        self.assertFalse(outcome["applied"])
        self.assertTrue(outcome["cooperative"])
        self.assertIsNotNone(resolve_queue.cancel_requested("cancel-running"))
        # 실행 중인 워커만 manifest 를 쓸 수 있다 — API 는 건드리지 않았다.
        self.assertEqual(
            resolve_queue.queue_state(resolve_queue.scan_projects(["p1"])[0]),
            resolve_queue.STATE_QUEUED,
        )


    def test_import_cannot_be_cancelled_without_explicit_force(self):
        manifest, _ahead = self._accept_registered("cancel-import")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)

        with self.assertRaises(resolve_queue.ResolveQueueError):
            resolve_queue.cancel_sync(manifest)
        # 거절된 요청은 표에도 남지 않는다(다음 취소가 조용히 강제되면 안 된다).
        self.assertIsNone(resolve_queue.cancel_requested("cancel-import"))


class ImportWatchdogTests(ResolveQueueTestBase):
    """2단계 — 오래 걸리는 import 는 경고만 붙인다(자동 kill 금지)."""

    def _importing_since(self, transfer_id: str, seconds: int) -> dict:
        manifest, _ahead = self._accept(transfer_id=transfer_id)
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        started = datetime.now(timezone.utc) - timedelta(seconds=seconds)
        resolve_queue.queue_block(manifest)["state_changed_at"] = started.isoformat(
            timespec="seconds"
        )
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        return manifest

    def test_long_import_gets_a_warning_and_is_not_killed(self):
        self._importing_since("watch-slow", resolve_queue.IMPORT_WARN_SECONDS + 60)
        row = resolve_queue.queue_snapshot(["p1"])[0]

        self.assertEqual(row["state"], resolve_queue.STATE_IMPORTING)
        self.assertEqual(row["warning"]["code"], "import_slow")
        self.assertIn("대화상자", row["warning"]["message"])
        self.assertGreaterEqual(row["warning"]["elapsed_seconds"], resolve_queue.IMPORT_WARN_SECONDS)

    def test_fresh_import_has_no_warning(self):
        self._importing_since("watch-fresh", 5)
        self.assertIsNone(resolve_queue.queue_snapshot(["p1"])[0]["warning"])

    def test_only_importing_can_warn(self):
        manifest, _ahead = self._accept(transfer_id="watch-queued")
        old = datetime.now(timezone.utc) - timedelta(days=1)
        resolve_queue.queue_block(manifest)["state_changed_at"] = old.isoformat(
            timespec="seconds"
        )
        self.assertIsNone(resolve_queue.import_warning(manifest))


class RecoveryFlowTests(WorkerFixtureBase):
    """2단계 — interrupted → 누락분만 다시 가져오기(자동 재실행 금지 유지)."""


    def test_recovery_required_only_steps_down_to_interrupted(self):
        manifest, _ahead = self._accept_registered("recover-guarded")
        resolve_queue.set_state(
            manifest,
            resolve_queue.STATE_RECOVERY_REQUIRED,
            policy=resolve_queue.DISPATCH_MANUAL_ONLY,
        )
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)

        outcome = resolve_queue.resume_sync(manifest)
        self.assertEqual(outcome["state"], resolve_queue.STATE_INTERRUPTED)
        saved = resolve_queue.scan_projects(["p1"])[0]
        # 한 번에 되살리지 않는다 — 여전히 사용자가 한 번 더 확인해야 한다.
        self.assertEqual(saved["queue"]["dispatch_policy"], "manual_only")


class ImportItemErrorCodeTests(ResolveQueueTestBase):
    """2단계 P2 — 배치 실패 항목도 error_code 를 남긴다(문자열 파싱 금지)."""

    def test_unverified_batch_items_carry_a_code(self):
        media_pool = mock.MagicMock()
        media_pool.SetCurrentFolder.return_value = True
        media_pool.ImportMedia.return_value = []
        target = mock.MagicMock()
        target.GetClipList.return_value = []
        item = {"status": "pending", "error": None, "error_code": None}
        result = {"imported": 0, "error_count": 0}

        with mock.patch.object(resolve_bridge, "_MEDIA_IMPORT_ATTEMPTS", 1):
            resolve_bridge._import_media_batch(
                media_pool, target, [(item, Path("clip.mp4"), "clip.mp4")], result
            )

        self.assertEqual(item["status"], "error")
        self.assertEqual(item["error_code"], "media_import_failed")
        self.assertEqual(result["error_count"], 1)


class FifoOrderTests(ResolveQueueTestBase):
    """접수 순서 = 큐 순서 (실환경 재현: 같은 초에 연속 3건 접수)."""

    def test_same_second_accepts_keep_submission_order(self):
        # 워커를 끈 채 빠르게 3회 접수하면 created_at(초 단위)이 같아진다. 예전에는 그때
        # transfer_id 문자열로 갈려 큐 순서·ahead 가 실제 접수 순서와 뒤바뀌었다.
        submitted = ["t-c-first", "t-a-second", "t-b-third"]
        frozen = "2026-08-23T11:50:01+00:00"
        aheads = []
        with mock.patch.object(resolve_queue, "_utc_now", return_value=frozen):
            for transfer_id in submitted:
                _manifest, ahead = self._accept(transfer_id=transfer_id)
                aheads.append(ahead)

        rows = resolve_queue.queue_snapshot(["p1"])
        self.assertEqual([row["created_at"] for row in rows], [frozen] * 3)
        self.assertEqual([row["transfer_id"] for row in rows], submitted)
        self.assertEqual([row["ahead"] for row in rows], [0, 1, 2])
        # 접수 응답이 알려 주는 '앞 대기 건수'도 같은 키를 쓴다.
        self.assertEqual(aheads, [0, 1, 2])

    def test_created_ns_stays_monotonic_when_the_clock_does_not_move(self):
        with mock.patch("time.time_ns", return_value=1_700_000_000_000_000_000):
            values = [resolve_queue.next_created_ns() for _ in range(5)]
        self.assertEqual(len(set(values)), 5)
        self.assertEqual(values, sorted(values))

    def _strip_ns(self, manifest: dict, created_at: str) -> None:
        """새 필드가 없던 기존 v3 manifest 로 되돌린다(하위호환 검증용)."""
        path = Path(manifest["manifest_path"])
        data = json.loads(path.read_text(encoding="utf-8"))
        data.pop("created_at_ns", None)
        data["created_at"] = created_at
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def test_legacy_manifests_without_ns_keep_the_old_tie_break(self):
        for transfer_id in ("legacy-b", "legacy-a"):
            manifest, _ahead = self._accept(transfer_id=transfer_id)
            self._strip_ns(manifest, "2026-08-23T11:50:01+00:00")

        rows = resolve_queue.queue_snapshot(["p1"])
        # 나노초 키가 없는 옛 기록끼리는 예전 규칙(created_at → transfer_id) 그대로다.
        self.assertEqual([row["transfer_id"] for row in rows], ["legacy-a", "legacy-b"])

    def test_new_manifest_queues_behind_an_older_legacy_manifest(self):
        legacy, _ahead = self._accept(transfer_id="legacy-old")
        self._strip_ns(legacy, "2020-01-01T00:00:00+00:00")
        self._accept(transfer_id="fresh-new")

        rows = resolve_queue.queue_snapshot(["p1"])
        # 옛 기록의 초 단위 created_at 은 나노초로 환산돼 새 기록과 같은 축에서 비교된다.
        self.assertEqual([row["transfer_id"] for row in rows], ["legacy-old", "fresh-new"])


class KilledOwnerRecoveryTests(ResolveQueueTestBase):
    """소유자 프로세스를 강제 종료했을 때의 생존 판정·부팅 복구.

    실환경 재현: importing 도중 uvicorn PID 를 강제 종료하고 재기동. Windows 는 프로세스가
    끝나도 누군가 핸들을 쥐고 있으면 커널 객체를 남기므로 ``OpenProcess`` 가 그 PID 로
    계속 성공하고, 생성 시각도 그대로 남는다. 여기서는 ``subprocess.Popen`` 이 핸들을
    쥔 채로 자식을 죽여 같은 조건을 만든다.
    """

    def _spawn_and_kill(self) -> tuple[int, str]:
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # ★Popen 객체를 테스트가 끝날 때까지 살려 둬야 핸들이 열려 있고, 그래야 '종료했는데
        # PID 로 열리는' 상황이 재현된다.
        self._proc = proc
        filetime = resolve_lock.process_started_at_filetime(proc.pid)
        proc.kill()
        proc.wait(timeout=30)
        return proc.pid, filetime

    def test_killed_process_is_dead_even_while_its_handle_stays_open(self):
        pid, filetime = self._spawn_and_kill()
        self.assertEqual(resolve_lock.process_liveness(pid, filetime), "dead")

    def test_boot_recovery_takes_over_the_claim_of_a_killed_hub(self):
        pid, filetime = self._spawn_and_kill()
        manifest, _ahead = self._accept(transfer_id="boot-killed-hub")
        path = Path(manifest["manifest_path"])
        now = datetime.now(timezone.utc)
        resolve_queue.queue_block(manifest)["claim"] = {
            "token": "claim-killed-hub",
            "epoch": 1,
            "purpose": "import",
            "owner": {
                "kind": "push_worker",
                "host_id": resolve_lock.host_id(),
                # 재기동했으므로 hub_instance_id 는 지금 프로세스와 다르다.
                "hub_instance_id": "previous-hub-instance",
                "process_id": pid,
                "process_started_at_filetime": filetime,
                "process_nonce": "previous-nonce",
                "executor_pid": 0,
            },
            "attempt_id": "attempt-killed-hub",
            "acquired_at": now.isoformat(timespec="seconds"),
            "heartbeat_at": now.isoformat(timespec="seconds"),
            # lease 는 아직 살아 있다 — 만료를 기다려서가 아니라 '죽은 걸 확인해서' 회수해야 한다.
            "lease_expires_at": (now + timedelta(hours=1)).isoformat(timespec="seconds"),
        }
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(path, manifest)

        self.assertEqual(resolve_queue.claim_disposition(manifest), "free")

        resolve_queue.recover_boot(["p1"])
        recovered = resolve_queue.read_manifest(path)
        # 30초 넘게 importing/auto 로 고착되던 자리 — interrupted + manual_only 로 확정된다.
        self.assertEqual(
            resolve_queue.queue_state(recovered), resolve_queue.STATE_INTERRUPTED
        )
        self.assertEqual(recovered["queue"]["dispatch_policy"], "manual_only")
        self.assertEqual(recovered["queue"]["last_error"]["code"], "child_crashed")
        self.assertIsNone(recovered["queue"]["claim"])


class CancelPersistenceTests(WorkerFixtureBase):
    """후속 백로그 2 — 취소 요청은 허브가 죽어도 살아남는다(manifest 옆 사이드카).

    재현: 실행 중(preparing)인 건을 취소한 직후 허브가 죽는다. 예전에는 요청이 프로세스
    메모리에만 있어 그대로 증발했고, 재기동한 워커는 아무 일도 없었던 듯 계속했다.
    """

    def _marker(self, manifest: dict) -> Path:
        return resolve_queue.cancel_marker_path(
            Path(manifest["manifest_root"]), manifest["transfer_id"]
        )

    def test_request_is_written_beside_the_manifest_not_into_the_queue(self):
        manifest, _ahead = self._accept_registered("persist-write")
        resolve_queue.request_cancel(
            "persist-write", force=True, requested_by="user-1", manifest=manifest
        )

        marker = self._marker(manifest)
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.suffix, resolve_queue.CANCEL_SUFFIX)
        self.assertEqual(marker.parent, Path(manifest["manifest_path"]).parent)
        # ★스캐너는 *.json 만 본다 — 사이드카가 전송 목록에 끼어들면 안 된다.
        self.assertEqual(len(resolve_queue.scan_projects(["p1"])), 1)
        # manifest 자체는 손대지 않는다(락은 실행 중인 워커가 쥐고 있을 수 있다).
        self.assertEqual(
            resolve_queue.queue_state(resolve_queue.scan_projects(["p1"])[0]),
            resolve_queue.STATE_QUEUED,
        )

    def test_a_restarted_hub_inherits_the_pending_request(self):
        manifest, _ahead = self._accept_registered("persist-inherit")
        resolve_queue.request_cancel(
            "persist-inherit", force=True, requested_by="user-1", manifest=manifest
        )
        resolve_queue.reset_cancel_requests()  # 허브 재시작 = 프로세스 메모리 소멸

        self.assertIsNone(resolve_queue.cancel_requested("persist-inherit"))
        inherited = resolve_queue.cancel_requested("persist-inherit", manifest)
        self.assertIsNotNone(inherited)
        self.assertTrue(inherited["force"])
        self.assertEqual(inherited["requested_by"], "user-1")
        # 한 번 승계하면 메모리 표에 올라온다(조회마다 NAS 를 읽지 않는다).
        self.assertIsNotNone(resolve_queue.cancel_requested("persist-inherit"))


    def test_boot_recovery_adopts_a_request_left_by_a_dead_hub(self):
        manifest, _ahead = self._accept_registered("persist-boot")
        resolve_queue.set_state(manifest, resolve_queue.STATE_PREPARING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        resolve_queue.request_cancel(
            "persist-boot", requested_by="user-1", manifest=manifest
        )
        resolve_queue.reset_cancel_requests()

        counts = resolve_queue.recover_boot(["p1"])

        # 예전에는 queued 로 되돌려 놓고 사용자가 다시 취소해야 했다.
        self.assertEqual(counts, {resolve_queue.STATE_CANCELLED: 1})
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_CANCELLED
        )
        self.assertEqual(current["queue"]["cancel"]["requested_by"], "user-1")
        self.assertFalse(self._marker(manifest).exists())

    def test_boot_recovery_of_an_interrupted_import_still_goes_to_recovery(self):
        """importing 중단분은 폐기가 아니라 복구 확인이다(§D) — 요청 사실만 남긴다."""
        manifest, _ahead = self._accept_registered("persist-boot-import")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        resolve_queue.request_cancel(
            "persist-boot-import", force=True, requested_by="user-1", manifest=manifest
        )
        resolve_queue.reset_cancel_requests()

        resolve_queue.recover_boot(["p1"])

        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_INTERRUPTED
        )
        self.assertTrue(current["queue"]["cancel"]["force"])

    def test_resume_withdraws_an_inherited_request(self):
        manifest, _ahead = self._accept_registered("persist-resume")
        resolve_queue.set_state(
            manifest,
            resolve_queue.STATE_FAILED,
            error={"code": "unexpected_error", "message": "실패"},
        )
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        resolve_queue.request_cancel(
            "persist-resume", requested_by="user-1", manifest=manifest
        )
        resolve_queue.reset_cancel_requests()

        outcome = resolve_queue.resume_sync(resolve_queue.scan_projects(["p1"])[0])

        self.assertEqual(outcome["state"], resolve_queue.STATE_QUEUED)
        # '다시 시도' 는 앞선 취소의 철회다 — 남겨 두면 되살린 전송을 워커가 곧장 폐기한다.
        self.assertFalse(self._marker(manifest).exists())
        self.assertIsNone(resolve_queue.cancel_requested("persist-resume", manifest))

    def test_confirmed_and_cooperative_requests_end_in_the_right_place(self):
        confirmed, _ahead = self._accept_registered("persist-confirm")
        self.assertTrue(resolve_queue.cancel_sync(confirmed, requested_by="u")["applied"])
        self.assertFalse(self._marker(confirmed).exists())  # 확정했으면 요청은 소멸한다

        running, _ahead = self._accept_registered("persist-cooperative")
        lock = resolve_queue.transfer_lock(running)
        self.assertTrue(lock.try_acquire())
        try:
            outcome = resolve_queue.cancel_sync(running, requested_by="u")
        finally:
            lock.release()
        self.assertFalse(outcome["applied"])
        self.assertTrue(outcome["cooperative"])
        self.assertTrue(self._marker(running).is_file())  # 확정 전이면 살아 있어야 한다


class TerminalCleanupTests(WorkerFixtureBase):
    """후속 백로그 3 — 보존 기간이 지난 터미널 기록만 소량씩 지운다."""

    def _terminal(
        self,
        transfer_id: str,
        *,
        state: str = resolve_queue.STATE_COMPLETE,
        age_days: int = 40,
    ) -> dict:
        manifest, _ahead = self._accept_registered(transfer_id)
        stamp = datetime.now(timezone.utc) - timedelta(days=age_days)
        resolve_queue.set_state(manifest, state)
        resolve_queue.queue_block(manifest)["state_changed_at"] = stamp.isoformat(
            timespec="seconds"
        )
        path = Path(manifest["manifest_path"])
        resolve_queue.save_manifest(path, manifest)
        os.utime(path, (stamp.timestamp(), stamp.timestamp()))
        resolve_queue.reset_scan_memo()
        return resolve_queue.read_manifest(path)

    def test_expired_record_is_removed_with_its_journal_lock_and_marker(self):
        manifest = self._terminal("cleanup-old")
        journal = resolve_queue.write_attempt(
            manifest,
            resolve_queue.new_attempt(
                manifest,
                attempt_id="attempt-old",
                claim={"token": "t", "epoch": 1},
                executor="push_worker",
            ),
        )
        marker = self._cancel_marker(manifest)
        lock_path = resolve_lock.transfer_lock_path(
            Path(manifest["manifest_root"]), "cleanup-old"
        )
        self.assertTrue(journal.is_file())
        self.assertTrue(marker.is_file())

        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"]), 1)

        self.assertFalse(Path(manifest["manifest_path"]).exists())
        self.assertFalse(journal.exists())
        self.assertFalse(marker.exists())
        self.assertFalse(lock_path.exists())
        self.assertEqual(resolve_queue.scan_projects(["p1"]), [])

    def _cancel_marker(self, manifest: dict) -> Path:
        resolve_queue.request_cancel(
            str(manifest["transfer_id"]), requested_by="u", manifest=manifest
        )
        resolve_queue.reset_cancel_requests()
        return resolve_queue.cancel_marker_path(
            Path(manifest["manifest_root"]), str(manifest["transfer_id"])
        )

    def test_recent_and_unfinished_records_are_never_touched(self):
        self._terminal("cleanup-recent", age_days=1)
        self._terminal("cleanup-failed", state=resolve_queue.STATE_FAILED, age_days=90)
        self._accept_registered("cleanup-active")

        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"]), 0)
        self.assertEqual(len(resolve_queue.scan_projects(["p1"])), 3)

    def test_v2_manifests_are_never_read_or_deleted(self):
        """★v2 는 구버전 메뉴 pull 경로 소유다 — 나이가 아무리 많아도 건드리지 않는다."""
        manifest = self._terminal("cleanup-v2-neighbour")
        legacy = (
            resolve_queue.transfer_dir(Path(manifest["manifest_root"])) / "legacy-v2.json"
        )
        legacy.write_text(
            json.dumps(
                {
                    "format": "mvhub.resolve-transfer",
                    "version": 2,
                    "transfer_id": "legacy-v2",
                    "status": "complete",
                }
            ),
            encoding="utf-8",
        )
        ancient = (datetime.now(timezone.utc) - timedelta(days=400)).timestamp()
        os.utime(legacy, (ancient, ancient))

        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"]), 1)
        self.assertTrue(legacy.is_file())

    def test_cleanup_is_capped_per_round(self):
        for index in range(3):
            self._terminal(f"cleanup-batch-{index}")

        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"], limit=2), 2)
        self.assertEqual(len(resolve_queue.scan_projects(["p1"])), 1)
        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"], limit=2), 1)
        self.assertEqual(resolve_queue.scan_projects(["p1"]), [])

    def test_retention_window_is_a_knob(self):
        self._terminal("cleanup-knob", age_days=10)
        self.assertEqual(resolve_queue.purge_expired_terminals(["p1"]), 0)  # 기본 30일
        self.assertEqual(
            resolve_queue.purge_expired_terminals(["p1"], retention_days=5), 1
        )

    def test_a_record_revived_after_the_scan_is_left_alone(self):
        """스캔과 삭제 사이에 사용자가 되살렸다면 그건 더 이상 터미널이 아니다."""
        manifest = self._terminal("cleanup-revived")
        path = Path(manifest["manifest_path"])
        stale = resolve_queue.read_manifest(path)
        resolve_queue.set_state(stale, resolve_queue.STATE_QUEUED)
        resolve_queue.save_manifest(path, stale)

        self.assertFalse(
            resolve_queue._purge_one(
                manifest, cutoff=1.0, now=datetime.now(timezone.utc)
            )
        )
        self.assertTrue(path.is_file())


class BinReconciliationTests(WorkerFixtureBase):
    """후속 백로그 4 — 누락 판정을 manifest 가 아니라 실제 Media Pool 로 확인한다(§3.3)."""




    def test_bridge_reads_the_bin_without_creating_or_moving_anything(self):
        manifest, _ahead = self._accept_registered("bins-bridge")
        item = manifest["items"][0]
        clip = mock.MagicMock()
        clip.GetClipProperty.return_value = {"File Path": item["local_path"]}
        leaf = self._folder("c0010", clips=[clip])
        tree = self._folder(
            "MV Hub",
            children=[self._folder("테스트 프로젝트", children=[self._folder("ep001", children=[leaf])])],
        )
        root = self._folder("Master", children=[tree])
        resolve_obj = mock.MagicMock()
        project = resolve_obj.GetProjectManager.return_value.GetCurrentProject.return_value
        project.GetUniqueId.return_value = "resolve-1"
        project.GetName.return_value = "EP01_EDIT"
        media_pool = project.GetMediaPool.return_value
        media_pool.GetRootFolder.return_value = root

        result = resolve_bridge.inspect_manifest_bins(manifest, resolve=resolve_obj)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(
            result["bins"],
            {resolve_bridge.bin_key("ep001/c0010"): [resolve_queue.path_identity(item["local_path"])]},
        )
        # ★읽기 전용 계약 — Bin 을 만들지도, 현재 폴더를 옮기지도 않는다.
        media_pool.AddSubFolder.assert_not_called()
        media_pool.SetCurrentFolder.assert_not_called()
        media_pool.ImportMedia.assert_not_called()

    def test_bridge_reports_a_project_mismatch_instead_of_guessing(self):
        manifest, _ahead = self._accept_registered("bins-mismatch")
        resolve_obj = mock.MagicMock()
        project = resolve_obj.GetProjectManager.return_value.GetCurrentProject.return_value
        project.GetUniqueId.return_value = "other-project"
        project.GetName.return_value = "다른 프로젝트"

        result = resolve_bridge.inspect_manifest_bins(manifest, resolve=resolve_obj)

        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error_code"], "project_changed")
        self.assertEqual(result["bins"], {})

    def test_bridge_returns_an_empty_listing_when_the_bin_does_not_exist(self):
        manifest, _ahead = self._accept_registered("bins-absent")
        root = self._folder("Master")
        resolve_obj = mock.MagicMock()
        project = resolve_obj.GetProjectManager.return_value.GetCurrentProject.return_value
        project.GetUniqueId.return_value = "resolve-1"
        project.GetName.return_value = "EP01_EDIT"
        project.GetMediaPool.return_value.GetRootFolder.return_value = root

        result = resolve_bridge.inspect_manifest_bins(manifest, resolve=resolve_obj)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["bins"], {})
        self.assertEqual(resolve_queue.reconcile_imported_bins(manifest, {}), 0)

    def _folder(self, name: str, *, clips=(), children=()) -> mock.MagicMock:
        folder = mock.MagicMock()
        folder.GetName.return_value = name
        folder.GetClipList.return_value = list(clips)
        folder.GetSubFolderList.return_value = list(children)
        return folder

    def test_child_process_dispatches_the_inspect_mode(self):
        """자식 진입점 계약 — 봉투에 모드가 있으면 가져오기가 아니라 실사 조회다."""
        payload = {
            resolve_import_worker.MODE_KEY: resolve_import_worker.INSPECT_MODE,
            "manifest": {"transfer_id": "t"},
        }
        with (
            mock.patch.object(
                resolve_import_worker,
                "inspect_manifest_bins",
                return_value={"status": "ok", "bins": {}},
            ) as inspect,
            mock.patch.object(resolve_import_worker, "run") as run,
            mock.patch("sys.stdin", io.StringIO(json.dumps(payload))),
            mock.patch("builtins.print"),
        ):
            resolve_import_worker.main()
        inspect.assert_called_once_with({"transfer_id": "t"})
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
