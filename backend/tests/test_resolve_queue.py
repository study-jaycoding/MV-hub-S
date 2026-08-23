"""Resolve 가져오기 큐 v3 계약 검증.

접수 즉시성·v2 공존·claim 잠금 상호 배제·부팅 복구 상태표·error_code 전달·워커 순차성.
Resolve 실기기가 필요한 부분은 자식 프로세스 결과를 모의한다.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest import mock

from fastapi import Request

from app.routers import resolve_integration
from app.services import (
    resolve_bridge,
    resolve_lock,
    resolve_queue,
    resolve_queue_worker,
    resolve_status_runner,
    resolve_transfer,
)


BACKEND_DIR = Path(__file__).resolve().parents[1]


def _local_request() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 12345)})


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

    def tearDown(self):
        for patch in reversed(self._patches):
            patch.stop()
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
        return resolve_queue.accept_sync(
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

    async def test_route_returns_queued_receipt_and_never_imports(self):
        generations = [self._generation(1)]
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
            mock.patch.object(resolve_integration, "current_account", return_value={}),
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
            mock.patch.object(resolve_integration, "transfer_generations") as transfer,
            mock.patch.object(
                resolve_integration, "run_resolve_import_isolated"
            ) as importer,
        ):
            response = await resolve_integration.create_resolve_transfer(
                body, _local_request()
            )

        self.assertTrue(response["queued"])
        self.assertEqual(response["ahead"], 0)
        self.assertEqual(response["queue"]["state"], "queued")
        self.assertEqual(response["total"], 1)
        self.assertEqual(response["resolve_target"]["project_name"], "EP01_EDIT")
        transfer.assert_not_called()
        importer.assert_not_called()


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

    def test_import_result_code_lands_in_manifest_and_queue_state(self):
        manifest, _ahead = self._accept(transfer_id="code-path")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        state = resolve_queue_worker._apply_import_result(
            manifest,
            {
                "status": "unavailable",
                "error_code": "project_changed",
                "error": "다른 프로젝트가 열려 있습니다",
                "items": [],
            },
        )
        self.assertEqual(state, resolve_queue.STATE_BLOCKED)
        self.assertEqual(manifest["queue"]["blocked"]["code"], "project_changed")
        self.assertEqual(manifest["queue"]["last_error"]["code"], "project_changed")
        self.assertEqual(manifest["queue"]["resume_state"], resolve_queue.STATE_READY)

    def test_unclassified_import_failure_becomes_interrupted(self):
        manifest, _ahead = self._accept(transfer_id="code-unknown")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        state = resolve_queue_worker._apply_import_result(
            manifest,
            {"status": "unavailable", "error_code": "child_crashed", "error": "죽음"},
        )
        self.assertEqual(state, resolve_queue.STATE_INTERRUPTED)
        self.assertEqual(manifest["queue"]["dispatch_policy"], "manual_only")


class WorkerDrainTests(ResolveQueueTestBase):
    def setUp(self):
        super().setUp()
        self.generations = {}
        self._worker_patches = [
            mock.patch.object(
                resolve_queue_worker,
                "_project_ids",
                return_value=["p1"],
            ),
            mock.patch.object(
                resolve_queue_worker.repo,
                "resolve_and_get",
                side_effect=self._resolve_and_get,
            ),
        ]
        for patch in self._worker_patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self._worker_patches):
            patch.stop()
        super().tearDown()

    def _resolve_and_get(self, any_id, account_uid=None):
        gen = self.generations.get(any_id)
        return (gen, any_id if gen else None, any_id)

    def _register(self, count: int) -> list[dict]:
        generations = [self._generation(index) for index in range(1, count + 1)]
        for gen in generations:
            self.generations[gen["id"]] = gen
            self.generations[gen["job_id"]] = gen
        return generations

    def _accept_registered(self, transfer_id: str, count: int = 1):
        generations = self._register(count)
        return resolve_queue.accept_sync(
            "p1",
            generations,
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="", account_email="", creator_uid="", server_origin=""
            ),
            transfer_id=transfer_id,
        )

    async def test_prepare_copies_sources_and_marks_ready(self):
        manifest, _ahead = self._accept_registered("drain-prepare", count=2)
        state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_READY)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(current["downloaded"], 2)
        self.assertEqual(current["status"], "complete")
        self.assertEqual(current["items"][0]["status"], "downloaded")
        self.assertEqual(current["items"][0]["prepare"]["state"], "downloaded")
        self.assertTrue(Path(current["items"][0]["local_path"]).is_file())
        self.assertEqual(current["folder_paths"], ["ep001/c0010"])
        self.assertIsNone(current["queue"]["claim"])

    async def test_prepare_is_idempotent_after_requeue(self):
        manifest, _ahead = self._accept_registered("drain-idempotent")
        await resolve_queue_worker.prepare_transfer(manifest)
        current = resolve_queue.scan_projects(["p1"])[0]
        path = Path(current["manifest_path"])
        resolve_queue.set_state(current, resolve_queue.STATE_QUEUED)
        resolve_queue.save_manifest(path, current)

        state = await resolve_queue_worker.prepare_transfer(current)
        self.assertEqual(state, resolve_queue.STATE_READY)
        again = resolve_queue.scan_projects(["p1"])[0]
        # 이미 준비된 항목은 다시 복사하지 않는다(downloaded 유지, 오류 0).
        self.assertEqual(again["error_count"], 0)
        self.assertEqual(again["downloaded"], 1)

    async def test_missing_source_marks_failed_with_code(self):
        manifest, _ahead = self._accept_registered("drain-missing")
        self.generations.clear()
        state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_FAILED)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(current["items"][0]["prepare"]["error_code"], "source_missing")
        self.assertEqual(current["queue"]["last_error"]["code"], "source_missing")
        self.assertEqual(current["status"], "failed")

    async def test_account_scope_change_blocks_instead_of_failing(self):
        generations = self._register(1)
        manifest, _ahead = resolve_queue.accept_sync(
            "p1",
            generations,
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="acct:someone@example.com",
                account_email="someone@example.com",
                creator_uid="user_1",
                server_origin="",
            ),
            transfer_id="drain-scope",
        )
        with mock.patch.object(
            resolve_queue_worker, "_capture_account_scope", return_value="acct:other@example.com"
        ):
            state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_BLOCKED)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(current["queue"]["blocked"]["code"], "account_scope_changed")
        self.assertEqual(current["queue"]["resume_state"], resolve_queue.STATE_QUEUED)

    async def test_drain_runs_one_thread_at_a_time_in_fifo_order(self):
        self._accept_registered("drain-aaa")
        self._accept_registered("drain-bbb")

        inflight = 0
        peak = 0
        order: list[str] = []
        guard = threading.Lock()
        original_copy = resolve_transfer._copy_atomic

        def _tracked_copy(source, dest):
            nonlocal inflight, peak
            with guard:
                inflight += 1
                peak = max(peak, inflight)
            try:
                return original_copy(source, dest)
            finally:
                with guard:
                    inflight -= 1

        def _tracked_import(manifest):
            nonlocal inflight, peak
            with guard:
                inflight += 1
                peak = max(peak, inflight)
                order.append(str(manifest.get("transfer_id") or ""))
            try:
                return {
                    "status": "complete",
                    "error_code": None,
                    "error": None,
                    "imported": len(manifest.get("items") or []),
                    "skipped": 0,
                    "error_count": 0,
                    "items": [
                        {
                            "generation_id": item["generation_id"],
                            "local_path": item["local_path"],
                            "media_pool_path": "MV Hub/테스트 프로젝트/ep001/c0010",
                            "status": "imported",
                            "error": None,
                            "error_code": None,
                        }
                        for item in manifest.get("items") or []
                    ],
                }
            finally:
                with guard:
                    inflight -= 1

        with (
            mock.patch.object(resolve_transfer, "_copy_atomic", _tracked_copy),
            mock.patch.object(
                resolve_queue_worker, "run_resolve_import_isolated", _tracked_import
            ),
        ):
            worker = resolve_queue_worker.ResolveQueueWorker()
            first = await worker.drain_once()
            second = await worker.drain_once()

        self.assertEqual(peak, 1)
        self.assertEqual(first, [resolve_queue.STATE_READY, resolve_queue.STATE_READY])
        self.assertEqual(
            second, [resolve_queue.STATE_COMPLETE, resolve_queue.STATE_COMPLETE]
        )
        self.assertEqual(order, ["drain-aaa", "drain-bbb"])
        finished = resolve_queue.scan_projects(["p1"])
        for manifest in finished:
            self.assertEqual(
                resolve_queue.queue_state(manifest), resolve_queue.STATE_COMPLETE
            )
            self.assertEqual(manifest["items"][0]["import"]["state"], "imported")
            self.assertTrue(manifest["completed_at"])

    async def test_import_records_result_even_if_caller_is_cancelled(self):
        self._accept_registered("drain-cancel")
        started = threading.Event()

        def _slow_import(manifest):
            started.set()
            import time

            time.sleep(0.3)
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
            resolve_queue_worker, "run_resolve_import_isolated", _slow_import
        ):
            worker = resolve_queue_worker.ResolveQueueWorker()
            await worker.drain_once()  # queued → ready
            task = asyncio.create_task(worker.drain_once())
            await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        current = resolve_queue.scan_projects(["p1"])[0]
        # 실행과 저장이 한 단위라 취소돼도 importing 으로 남지 않는다.
        self.assertEqual(
            resolve_queue.queue_state(current), resolve_queue.STATE_COMPLETE
        )

    async def test_unexpected_prepare_error_does_not_strand_preparing(self):
        manifest, _ahead = self._accept_registered("prepare-boom")
        with mock.patch.object(
            resolve_queue_worker,
            "_source_payload_block",
            side_effect=RuntimeError("예상 밖"),
        ):
            state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_FAILED)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(resolve_queue.queue_state(current), resolve_queue.STATE_FAILED)
        self.assertEqual(current["queue"]["last_error"]["code"], "unexpected_error")

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


class WorkerGateTests(unittest.TestCase):
    def test_worker_is_release_windows_only_unless_overridden(self):
        with (
            mock.patch.dict(
                resolve_queue_worker.os.environ,
                {"CONTENT_HUB_RESOLVE_QUEUE_WORKER": ""},
                clear=False,
            ),
            mock.patch.object(resolve_queue_worker, "install_mode", return_value="development"),
        ):
            self.assertFalse(resolve_queue_worker.worker_enabled())
        with mock.patch.dict(
            resolve_queue_worker.os.environ,
            {"CONTENT_HUB_RESOLVE_QUEUE_WORKER": "1"},
            clear=False,
        ):
            self.assertTrue(resolve_queue_worker.worker_enabled())
        with mock.patch.dict(
            resolve_queue_worker.os.environ,
            {"CONTENT_HUB_RESOLVE_QUEUE_WORKER": "0"},
            clear=False,
        ):
            self.assertFalse(resolve_queue_worker.worker_enabled())

    def test_disabled_worker_never_creates_a_task(self):
        worker = resolve_queue_worker.ResolveQueueWorker()
        with mock.patch.object(resolve_queue_worker, "worker_enabled", return_value=False):
            worker.start()
        self.assertIsNone(worker._task)


if __name__ == "__main__":
    unittest.main()
