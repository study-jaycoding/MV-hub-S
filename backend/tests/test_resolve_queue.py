"""Resolve 가져오기 큐 v3 계약 검증.

접수 즉시성·v2 공존·claim 잠금 상호 배제·부팅 복구 상태표·error_code 전달·워커 순차성.
Resolve 실기기가 필요한 부분은 자식 프로세스 결과를 모의한다.
"""

from __future__ import annotations

import asyncio
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
    resolve_queue_worker,
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
        resolve_queue_worker.reset_resolve_project_memo()

    def tearDown(self):
        for patch in reversed(self._patches):
            patch.stop()
        resolve_queue.reset_scan_memo()
        resolve_queue.reset_cancel_requests()
        resolve_lock.reset_root_self_test()
        resolve_queue_worker.reset_resolve_project_memo()
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


class WorkerFixtureBase(ResolveQueueTestBase):
    """워커 테스트 공용 픽스처 — 로컬 생성물 조회를 메모리 사전으로 대신한다."""

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
        manifest, ahead, _duplicate = resolve_queue.accept_sync(
            "p1",
            generations,
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="", account_email="", creator_uid="", server_origin=""
            ),
            transfer_id=transfer_id,
        )
        return manifest, ahead


class WorkerDrainTests(WorkerFixtureBase):
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
        manifest, _ahead, _duplicate = resolve_queue.accept_sync(
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

    def test_render_root_change_keeps_old_manifests_visible_and_blocks(self):
        manifest, _ahead = self._accept(transfer_id="root-moved")
        # ★@davinci 는 Render 의 '부모' 아래라, 같은 부모 안에서 이름만 바꾸면 manifest
        # 루트가 그대로다. 프로젝트 폴더째 옮긴 상황이라야 고립이 재현된다.
        moved = self.root / "MovedProject" / "Render"
        moved.mkdir(parents=True)
        with mock.patch.object(
            resolve_transfer.project_folders,
            "render_root_state",
            return_value={"render_path": str(moved), "error": None},
        ):
            found = resolve_queue.scan_projects(["p1"])
            blocked = resolve_queue_worker._source_payload_block(manifest)
        # 옛 루트의 manifest 가 고립되지 않는다.
        self.assertEqual([item["transfer_id"] for item in found], ["root-moved"])
        # 그리고 destination_changed 전이가 실제로 일어날 수 있다.
        self.assertEqual(blocked["code"], "destination_changed")

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

    def test_worker_reports_the_real_task_state_not_the_setting(self):
        worker = resolve_queue_worker.ResolveQueueWorker()
        with (
            mock.patch.dict(
                resolve_queue_worker.os.environ,
                {"CONTENT_HUB_RESOLVE_QUEUE_WORKER": "1"},
                clear=False,
            ),
            mock.patch.object(
                resolve_queue_worker, "periodic_resolve_queue", worker
            ),
            mock.patch.object(
                resolve_lock, "self_test", return_value=(False, "잠금 미지원")
            ),
        ):
            worker.start()
            self.assertFalse(worker.running)
            # 설정만 보면 켜짐이지만, 실제로는 워커가 없다.
            self.assertTrue(resolve_queue_worker.worker_enabled())
            self.assertFalse(resolve_queue_worker.worker_active())
            self.assertIn("잠금 미지원", resolve_queue_worker.worker_detail())


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
        # 자동 재평가가 가능한 일시 조건이라 blocked 로 다뤄진다.
        self.assertIn("journal_unavailable", resolve_queue_worker._BLOCKING_CODES)

    def test_parent_merges_child_journal_and_isolates_orphan_staging(self):
        manifest = self._importing("journal-merge", "attempt-merge")
        path = Path(manifest["manifest_path"])
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id="attempt-merge",
            claim={"token": "tok", "epoch": 3},
            executor="push_worker",
        )
        resolve_queue.write_attempt(manifest, attempt)

        def _child_dies(payload):
            # 자식이 rebuild 도중 자기 phase 를 남기고 죽은 상황.
            record = resolve_queue.read_attempt(payload, "attempt-merge")
            record["phase"] = "rebuild_to_staging"
            record["staging_bin"] = "__MVHUB_REBUILD_deadbeef__"
            record["executor_pid"] = 4242
            resolve_queue.write_attempt(payload, record)
            return {
                "status": "unavailable",
                "error_code": "child_crashed",
                "error": "자식이 죽었습니다",
                "items": [],
            }

        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated", _child_dies
        ):
            state = resolve_queue_worker._import_and_record(path, manifest, attempt)

        self.assertEqual(state, resolve_queue.STATE_RECOVERY_REQUIRED)
        record = resolve_queue.read_attempt(manifest, "attempt-merge")
        # 부모가 자기 사본으로 덮어썼다면 이 근거가 사라진다.
        self.assertEqual(record["staging_bin"], "__MVHUB_REBUILD_deadbeef__")
        self.assertEqual(record["phase"], "rebuild_to_staging")
        self.assertEqual(record["executor_pid"], 4242)
        saved = resolve_queue.read_manifest(path)
        self.assertEqual(saved["queue"]["last_error"]["code"], "orphan_rebuild_bin")
        self.assertEqual(saved["queue"]["dispatch_policy"], "manual_only")


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

    async def test_drain_does_not_import_a_project_held_by_a_live_child(self):
        held = self._importing_with_live_child("fence-drain-held")
        ready, _ahead = self._accept(transfer_id="fence-drain-ready")
        resolve_queue.set_state(ready, resolve_queue.STATE_READY)
        resolve_queue.save_manifest(Path(ready["manifest_path"]), ready)

        with (
            mock.patch.object(
                resolve_queue_worker, "_project_ids", return_value=["p1"]
            ),
            mock.patch.object(resolve_lock, "process_liveness", return_value="alive"),
            mock.patch.object(
                resolve_queue_worker, "run_resolve_import_isolated"
            ) as importer,
        ):
            await resolve_queue_worker.ResolveQueueWorker().drain_once()

        importer.assert_not_called()
        self.assertEqual(
            resolve_queue.queue_state(resolve_queue.read_manifest(Path(held["manifest_path"]))),
            resolve_queue.STATE_IMPORTING,
        )


class AcceptAccountPinTests(ResolveQueueTestBase):
    """P1-4 — 접수 라우트 전체가 같은 계정을 본다 + server_origin 검증."""

    async def test_route_pins_the_account_before_the_first_db_access(self):
        generations = [self._generation(1)]
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
                resolve_integration, "current_account", return_value={"email": "pinned@example.com"}
            ),
            mock.patch.object(
                resolve_integration, "account_scope_uid", return_value="user-pinned"
            ),
            mock.patch.object(resolve_integration._proxy, "proxying", return_value=False),
        ):
            response = await resolve_integration.create_resolve_transfer(
                body, _local_request()
            )

        self.assertEqual(seen, ["acct:pinned@example.com"])
        manifest = resolve_queue.scan_projects(["p1"])[0]
        scope = manifest["source_payload"]["account_scope"]
        self.assertEqual(manifest["transfer_id"], response["transfer_id"])
        self.assertEqual(scope["account_key"], "acct:pinned@example.com")
        self.assertEqual(scope["creator_uid_at_accept"], "user-pinned")
        # 오버라이드는 라우트가 끝나면 반드시 풀린다.
        self.assertIsNone(active_account._override.get())

    async def test_same_account_on_a_different_server_blocks_instead_of_running(self):
        manifest, _ahead, _duplicate = resolve_queue.accept_sync(
            "p1",
            [self._generation(1)],
            resolve_target={"project_id": "resolve-1", "project_name": "EP01_EDIT"},
            account_scope=resolve_queue.build_account_scope(
                account_key="acct:artist@example.com",
                account_email="artist@example.com",
                creator_uid="user_1",
                server_origin="https://hub-a.example.com",
            ),
            transfer_id="server-moved",
        )
        with (
            mock.patch.object(
                resolve_queue_worker,
                "_capture_account_scope",
                return_value="acct:artist@example.com",
            ),
            mock.patch.object(
                resolve_queue_worker, "_server_origin", lambda: "https://hub-b.example.com"
            ),
        ):
            state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_BLOCKED)
        current = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(current["queue"]["blocked"]["code"], "server_changed")
        self.assertEqual(current["queue"]["resume_state"], resolve_queue.STATE_QUEUED)
        self.assertIn("server_changed", resolve_queue_worker._BLOCKING_CODES)


class PartialResultTests(WorkerFixtureBase):
    """P1-5 — 준비 실패가 남았는데 complete 로 확정하지 않는다."""

    async def test_partial_prepare_ends_as_failed_with_partial_projection(self):
        manifest, _ahead = self._accept_registered("partial-prepare", count=2)
        # 두 번째 원본만 사라진 상황(첫 번째는 정상 준비된다).
        second = manifest["items"][1]["source_ref"]
        self.generations.pop(second["local_generation_id"], None)
        self.generations.pop(second["job_id"], None)

        self.assertEqual(
            await resolve_queue_worker.prepare_transfer(manifest),
            resolve_queue.STATE_READY,
        )
        current = resolve_queue.scan_projects(["p1"])[0]

        def _import_ok(payload):
            return {
                "status": "complete",
                "error_code": None,
                "error": None,
                "imported": 1,
                "skipped": 0,
                "error_count": 0,
                "items": [
                    {
                        "generation_id": payload["items"][0]["generation_id"],
                        "local_path": payload["items"][0]["local_path"],
                        "media_pool_path": "MV Hub/테스트 프로젝트/ep001/c0010",
                        "status": "imported",
                        "error": None,
                        "error_code": None,
                    }
                ],
            }

        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated", _import_ok
        ):
            state = await resolve_queue_worker.import_transfer(current)

        self.assertEqual(state, resolve_queue.STATE_FAILED)
        saved = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(saved["queue"]["last_error"]["code"], "source_missing")
        # 성공분은 imported 로 보존되고, v2 투영은 partial 이다(§1.3).
        self.assertEqual(saved["items"][0]["import"]["state"], "imported")
        self.assertEqual(saved["items"][1]["prepare"]["state"], "error")
        self.assertEqual(saved["resolve_import"]["status"], "partial")
        self.assertEqual(saved["status"], "partial")

    async def test_all_prepared_and_imported_still_completes(self):
        manifest, _ahead = self._accept_registered("partial-none", count=1)
        await resolve_queue_worker.prepare_transfer(manifest)
        current = resolve_queue.scan_projects(["p1"])[0]
        with mock.patch.object(
            resolve_queue_worker,
            "run_resolve_import_isolated",
            lambda payload: {
                "status": "complete",
                "error_code": None,
                "error": None,
                "imported": 1,
                "skipped": 0,
                "error_count": 0,
                "items": [],
            },
        ):
            state = await resolve_queue_worker.import_transfer(current)
        self.assertEqual(state, resolve_queue.STATE_COMPLETE)


class PreparedIntegrityTests(WorkerFixtureBase):
    """P1-6 — 준비 파일 무결성(복사 중 해시 · 가져오기 직전 재검증)."""

    async def _prepared(self, transfer_id: str) -> dict:
        manifest, _ahead = self._accept_registered(transfer_id)
        await resolve_queue_worker.prepare_transfer(manifest)
        return resolve_queue.scan_projects(["p1"])[0]

    async def test_prepare_records_sha256_without_reading_the_file_again(self):
        with mock.patch.object(
            resolve_queue, "file_sha256", side_effect=AssertionError("재해시 금지")
        ):
            current = await self._prepared("integrity-record")
        prepare = current["items"][0]["prepare"]
        local = Path(current["items"][0]["local_path"])
        self.assertEqual(prepare["sha256"], resolve_queue.file_sha256(local))
        self.assertEqual(prepare["size"], local.stat().st_size)
        self.assertEqual(prepare["mtime_ns"], local.stat().st_mtime_ns)

    async def test_unchanged_prepared_file_is_not_rehashed_before_import(self):
        current = await self._prepared("integrity-fast")
        with mock.patch.object(
            resolve_queue, "file_sha256", side_effect=AssertionError("재해시 금지")
        ):
            self.assertEqual(resolve_queue.verify_prepared_items(current), 0)

    async def test_replaced_prepared_file_is_caught_before_import(self):
        current = await self._prepared("integrity-swap")
        local = Path(current["items"][0]["local_path"])
        original = local.read_bytes()
        # 크기는 그대로, 내용만 바뀐 경우도 잡아야 한다(크기 비교만으로는 못 잡는다).
        local.write_bytes(b"x" * len(original))
        stat_result = local.stat()
        os.utime(local, ns=(stat_result.st_atime_ns, stat_result.st_mtime_ns + 1000))

        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated"
        ) as importer:
            state = await resolve_queue_worker.import_transfer(current)

        importer.assert_not_called()
        self.assertEqual(state, resolve_queue.STATE_FAILED)
        saved = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(
            saved["items"][0]["prepare"]["error_code"], resolve_queue.INTEGRITY_MISMATCH
        )
        self.assertEqual(
            saved["queue"]["last_error"]["code"], resolve_queue.INTEGRITY_MISMATCH
        )

    async def test_deleted_prepared_file_is_caught_before_import(self):
        current = await self._prepared("integrity-gone")
        Path(current["items"][0]["local_path"]).unlink()
        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated"
        ) as importer:
            state = await resolve_queue_worker.import_transfer(current)
        importer.assert_not_called()
        self.assertEqual(state, resolve_queue.STATE_FAILED)

    async def test_legacy_prepared_item_without_hash_is_hashed_once(self):
        current = await self._prepared("integrity-legacy")
        prepare = current["items"][0]["prepare"]
        prepare["sha256"] = None
        prepare["mtime_ns"] = None
        calls: list[Path] = []
        original = resolve_queue.file_sha256
        with mock.patch.object(
            resolve_queue,
            "file_sha256",
            side_effect=lambda path: (calls.append(path), original(path))[1],
        ):
            self.assertEqual(resolve_queue.verify_prepared_items(current), 0)
            self.assertEqual(resolve_queue.verify_prepared_items(current), 0)
        self.assertEqual(len(calls), 1)  # 기록을 채운 뒤에는 다시 해시하지 않는다


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

    async def test_prepare_stops_between_items_when_cancelled(self):
        manifest, _ahead = self._accept_registered("cancel-between", count=2)
        original = resolve_queue_worker._prepare_item

        async def _one_then_cancel(current, item):
            await original(current, item)
            resolve_queue.request_cancel("cancel-between", requested_by="user-1")

        with mock.patch.object(resolve_queue_worker, "_prepare_item", _one_then_cancel):
            state = await resolve_queue_worker.prepare_transfer(manifest)

        self.assertEqual(state, resolve_queue.STATE_CANCELLED)
        current = resolve_queue.scan_projects(["p1"])[0]
        # 시작한 파일 하나는 끝까지 복사하고, 다음 항목은 손대지 않는다.
        self.assertEqual(current["items"][0]["prepare"]["state"], "downloaded")
        self.assertEqual(current["items"][1]["prepare"]["state"], "queued")
        self.assertIsNone(resolve_queue.cancel_requested("cancel-between"))

    def test_import_cannot_be_cancelled_without_explicit_force(self):
        manifest, _ahead = self._accept_registered("cancel-import")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)

        with self.assertRaises(resolve_queue.ResolveQueueError):
            resolve_queue.cancel_sync(manifest)
        # 거절된 요청은 표에도 남지 않는다(다음 취소가 조용히 강제되면 안 된다).
        self.assertIsNone(resolve_queue.cancel_requested("cancel-import"))

    async def test_force_cancel_during_import_ends_in_recovery_required(self):
        manifest, _ahead = self._accept_registered("cancel-force")
        await resolve_queue_worker.prepare_transfer(manifest)
        current = resolve_queue.scan_projects(["p1"])[0]

        def _killed(_payload):
            # 사용자가 자식을 끊어 결과 없이 죽은 상황.
            resolve_queue.request_cancel("cancel-force", force=True, requested_by="user-1")
            return {
                "status": "unavailable",
                "error_code": "child_crashed",
                "error": "중단됨",
                "items": [],
            }

        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated", _killed
        ):
            state = await resolve_queue_worker.import_transfer(current)

        self.assertEqual(state, resolve_queue.STATE_RECOVERY_REQUIRED)
        saved = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(saved["queue"]["last_error"]["code"], "cancelled")
        self.assertTrue(saved["queue"]["cancel"]["force"])
        self.assertEqual(saved["queue"]["dispatch_policy"], "manual_only")
        self.assertIsNone(resolve_queue.cancel_requested("cancel-force"))

    def test_force_stop_kills_only_the_child_the_journal_recorded(self):
        manifest, _ahead = self._accept_registered("cancel-kill")
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id="attempt-kill",
            claim={"token": "t", "epoch": 1},
            executor="push_worker",
        )
        attempt["executor_pid"] = 4242
        attempt["host_id"] = resolve_lock.host_id()
        attempt["process_started_at_filetime"] = "123"
        resolve_queue.write_attempt(manifest, attempt)

        with mock.patch.object(
            resolve_lock, "terminate_process", return_value=True
        ) as killed:
            self.assertTrue(resolve_queue_worker.force_stop_import(manifest))
        killed.assert_called_once_with(4242, "123")

    def test_force_stop_never_targets_a_parent_only_journal(self):
        manifest, _ahead = self._accept_registered("cancel-kill-parent")
        attempt = resolve_queue.new_attempt(
            manifest,
            attempt_id="attempt-parent",
            claim={"token": "t", "epoch": 1},
            executor="push_worker",
        )
        self.assertEqual(attempt["executor_pid"], 0)
        resolve_queue.write_attempt(manifest, attempt)

        with mock.patch.object(resolve_lock, "terminate_process") as killed:
            self.assertFalse(resolve_queue_worker.force_stop_import(manifest))
        killed.assert_not_called()


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


class PrepareConcurrencyTests(WorkerFixtureBase):
    """2단계 A′ — 준비만 동시 3개, Resolve 가져오기는 계속 1개."""

    async def test_prepare_runs_up_to_three_at_once(self):
        for index in range(4):
            self._accept_registered(f"par-{index}")
        inflight = 0
        peak = 0
        original = resolve_queue_worker._prepare_item

        async def _tracked(manifest, item):
            nonlocal inflight, peak
            inflight += 1
            peak = max(peak, inflight)
            try:
                await asyncio.sleep(0.05)
                return await original(manifest, item)
            finally:
                inflight -= 1

        with mock.patch.object(resolve_queue_worker, "_prepare_item", _tracked):
            states = await resolve_queue_worker.ResolveQueueWorker().drain_once()

        self.assertEqual(states, [resolve_queue.STATE_READY] * 4)
        self.assertEqual(peak, resolve_queue_worker._PREPARE_SLOTS)
        self.assertLessEqual(resolve_queue_worker._PREPARE_SLOTS, 3)

    async def test_prepare_results_stay_in_fifo_order(self):
        for name in ("par-b", "par-a", "par-c"):
            self._accept_registered(name)
        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated"
        ) as importer:
            first = await resolve_queue_worker.ResolveQueueWorker().drain_once()
        importer.assert_not_called()
        self.assertEqual(first, [resolve_queue.STATE_READY] * 3)
        self.assertEqual(
            [row["transfer_id"] for row in resolve_queue.scan_projects(["p1"])],
            # FIFO = 접수 순서. 예전에는 같은 초 접수가 transfer_id 로 갈려 알파벳순
            # (par-a, par-b, par-c)이 나왔는데, 그게 뒤바뀜 버그의 정체였다.
            ["par-b", "par-a", "par-c"],
        )


class RecoveryFlowTests(WorkerFixtureBase):
    """2단계 — interrupted → 누락분만 다시 가져오기(자동 재실행 금지 유지)."""

    async def _interrupted(self, transfer_id: str) -> dict:
        manifest, _ahead = self._accept_registered(transfer_id, count=2)
        await resolve_queue_worker.prepare_transfer(manifest)
        current = resolve_queue.scan_projects(["p1"])[0]

        def _half_done(payload):
            first = payload["items"][0]
            return {
                "status": "unavailable",
                "error_code": "child_crashed",
                "error": "자식이 죽었습니다",
                "items": [
                    {
                        "generation_id": first["generation_id"],
                        "local_path": first["local_path"],
                        "media_pool_path": "MV Hub/테스트 프로젝트/ep001/c0010",
                        "status": "imported",
                        "error": None,
                        "error_code": None,
                    }
                ],
            }

        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated", _half_done
        ):
            state = await resolve_queue_worker.import_transfer(current)
        self.assertEqual(state, resolve_queue.STATE_INTERRUPTED)
        return resolve_queue.scan_projects(["p1"])[0]

    async def test_interrupted_lists_missing_items_but_never_reruns_itself(self):
        current = await self._interrupted("recover-missing")
        recovery = current["recovery"]

        self.assertEqual(recovery["reason"], "interrupted_import_missing_items")
        self.assertEqual(recovery["missing_count"], 1)
        self.assertEqual(recovery["existing_count"], 1)
        self.assertEqual(recovery["missing_item_ids"], ["item-0002"])
        # 목록만 자동이다 — 워커는 manual_only 라 집어가지 않는다.
        self.assertEqual(current["queue"]["dispatch_policy"], "manual_only")
        with mock.patch.object(
            resolve_queue_worker, "run_resolve_import_isolated"
        ) as importer:
            await resolve_queue_worker.ResolveQueueWorker().drain_once()
        importer.assert_not_called()

    async def test_user_confirmation_requeues_only_the_missing_items(self):
        current = await self._interrupted("recover-confirm")
        outcome = resolve_queue.resume_sync(current)

        self.assertEqual(outcome["state"], resolve_queue.STATE_READY)
        saved = resolve_queue.scan_projects(["p1"])[0]
        self.assertEqual(saved["queue"]["dispatch_policy"], "auto")
        self.assertEqual(saved["recovery"]["missing_item_ids"], ["item-0002"])
        # 이미 확정된 항목은 그대로 남는다.
        self.assertEqual(saved["items"][0]["import"]["state"], "imported")

    async def test_recheck_with_nothing_missing_confirms_complete(self):
        current = await self._interrupted("recover-none")
        for item in current["items"]:
            item["import"]["state"] = "imported"
        resolve_queue.save_manifest(Path(current["manifest_path"]), current)

        outcome = resolve_queue.resume_sync(resolve_queue.scan_projects(["p1"])[0])
        self.assertEqual(outcome["state"], resolve_queue.STATE_COMPLETE)

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

    def test_orphan_bin_recovery_keeps_the_backup_path_for_the_user(self):
        manifest, _ahead = self._accept_registered("recover-orphan")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        state = resolve_queue_worker._isolate_orphan_rebuild(
            manifest,
            "__MVHUB_REBUILD_ab12cd34__",
            {"drp_path": r"D:\Projects\EP01\@davinci\.mvhub\resolve-backups\x.drp"},
        )
        self.assertEqual(state, resolve_queue.STATE_RECOVERY_REQUIRED)
        self.assertEqual(manifest["recovery"]["staging_bin"], "__MVHUB_REBUILD_ab12cd34__")
        self.assertIn("x.drp", manifest["recovery"]["drp_path"])


class BlockedReevaluationTests(WorkerFixtureBase):
    """2단계 — Resolve 상태 조회 성공을 §B 재평가 트리거로 쓴다."""

    def _blocked_on_project(self, transfer_id: str) -> dict:
        manifest, _ahead = self._accept_registered(transfer_id)
        resolve_queue.set_state(
            manifest,
            resolve_queue.STATE_BLOCKED,
            blocked={"code": "project_changed", "expected": "resolve-1", "observed": "other"},
            resume_state=resolve_queue.STATE_READY,
        )
        resolve_queue.queue_block(manifest)["blocked_retry_count"] = 5
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        return manifest

    def test_opening_the_expected_project_resumes_without_waiting_for_backoff(self):
        manifest = self._blocked_on_project("blocked-project")
        resumed = resolve_queue_worker.note_resolve_project(
            {"status": "ready", "project_id": "resolve-1", "project_name": "EP01_EDIT"}
        )

        self.assertEqual(resumed, 1)
        current = resolve_queue.read_manifest(Path(manifest["manifest_path"]))
        self.assertEqual(resolve_queue.queue_state(current), resolve_queue.STATE_READY)
        # 사건 기반 재개라 백오프를 처음으로 되돌린다.
        self.assertEqual(current["queue"]["blocked_retry_count"], 0)

    def test_another_project_does_not_resume_the_transfer(self):
        manifest = self._blocked_on_project("blocked-other")
        resumed = resolve_queue_worker.note_resolve_project(
            {"status": "ready", "project_id": "resolve-9", "project_name": "OTHER"}
        )
        self.assertEqual(resumed, 0)
        self.assertEqual(
            resolve_queue.queue_state(
                resolve_queue.read_manifest(Path(manifest["manifest_path"]))
            ),
            resolve_queue.STATE_BLOCKED,
        )

    def test_the_same_project_is_only_scanned_once(self):
        self._blocked_on_project("blocked-memo")
        status = {"status": "ready", "project_id": "resolve-1", "project_name": "EP01_EDIT"}
        self.assertEqual(resolve_queue_worker.note_resolve_project(status), 1)
        with mock.patch.object(resolve_queue, "scan_projects") as scan:
            self.assertEqual(resolve_queue_worker.note_resolve_project(status), 0)
        scan.assert_not_called()

    def test_unready_status_is_not_a_trigger(self):
        self._blocked_on_project("blocked-notready")
        self.assertEqual(
            resolve_queue_worker.note_resolve_project({"status": "not_running"}), 0
        )


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


class QueueRouteTests(WorkerFixtureBase):
    """2단계 — 취소·재시도 로컬 API 계약."""

    def _projects_patch(self):
        return mock.patch.object(
            resolve_integration.repo,
            "list_projects",
            return_value={"projects": [{"id": "p1"}]},
        )

    async def test_cancel_route_discards_a_queued_transfer(self):
        self._accept_registered("route-cancel")
        with self._projects_patch():
            response = await resolve_integration.cancel_resolve_queue_transfer(
                "route-cancel",
                resolve_integration.ResolveQueueCancelIn(force=False),
                _local_request(),
            )
        self.assertEqual(response["state"], resolve_queue.STATE_CANCELLED)
        self.assertTrue(response["applied"])
        self.assertFalse(response["child_stopped"])

    async def test_cancel_route_refuses_import_without_force(self):
        manifest, _ahead = self._accept_registered("route-import")
        resolve_queue.set_state(manifest, resolve_queue.STATE_IMPORTING)
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        with self._projects_patch():
            with self.assertRaises(resolve_integration.HTTPException) as caught:
                await resolve_integration.cancel_resolve_queue_transfer(
                    "route-import",
                    resolve_integration.ResolveQueueCancelIn(force=False),
                    _local_request(),
                )
        self.assertEqual(caught.exception.status_code, 409)

    async def test_unknown_transfer_is_404(self):
        with self._projects_patch():
            with self.assertRaises(resolve_integration.HTTPException) as caught:
                await resolve_integration.resume_resolve_queue_transfer(
                    "nope", _local_request()
                )
        self.assertEqual(caught.exception.status_code, 404)

    async def test_status_route_reevaluates_blocked_transfers(self):
        manifest, _ahead = self._accept_registered("route-status")
        resolve_queue.set_state(
            manifest,
            resolve_queue.STATE_BLOCKED,
            blocked={"code": "no_project"},
            resume_state=resolve_queue.STATE_READY,
        )
        resolve_queue.save_manifest(Path(manifest["manifest_path"]), manifest)
        ready = {
            "status": "ready",
            "project_id": "resolve-1",
            "project_name": "EP01_EDIT",
        }
        with (
            self._projects_patch(),
            mock.patch.object(
                resolve_integration,
                "resolve_connection_status_bounded",
                return_value=ready,
            ),
        ):
            response = await resolve_integration.get_resolve_connection_status(
                _local_request()
            )
        self.assertEqual(response, ready)
        self.assertEqual(
            resolve_queue.queue_state(
                resolve_queue.read_manifest(Path(manifest["manifest_path"]))
            ),
            resolve_queue.STATE_READY,
        )


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


if __name__ == "__main__":
    unittest.main()
