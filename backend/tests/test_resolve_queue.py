"""Resolve 직접 전송 경로의 살아있는 계약 검증.

직접 준비·반입 라우트, 현행 pending 스캐너의 옛 v3 파일 무시, 메뉴 Importer 의 v3 거부·잠금 참여, 잠금 파일
self-test, bridge/runner 의 error_code 전달, v2 자식 워커의 journal 없는 반입, 재시도 라우트의 '실행+저장' 원자성,
계정 pin, 항목별 error_code, 죽은 프로세스 판정, 자식의 inspect 모드 분기. (큐 v3 의 접수·상태 전이·claim·취소·복구·스캔 테스트는 2026-08-27 `resolve_queue.py` 를
`run_non_abandon` 만 남기고 정리하면서 함께 삭제 — 직접 전송이 현행이라 그 코드에 닿는 경로가 없다.)
Resolve 실기기가 필요한 부분은 자식 프로세스 결과를 모의한다.
"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fastapi import Request

from app import active_account
from app.routers import resolve_integration
from app.services import (
    resolve_bridge,
    resolve_import_worker,
    resolve_lock,
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
        # 프로세스 전역 기억(루트 self-test)은 테스트마다 비운다.
        resolve_lock.reset_root_self_test()

    def tearDown(self):
        for patch in reversed(self._patches):
            patch.stop()
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


class AcceptContractTests(ResolveQueueTestBase):


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


    async def test_pending_scanner_ignores_a_preserved_v3_manifest(self):
        """현행 `list_pending_manifests` 는 같은 폴더의 옛 v3 manifest 를 읽어도 format 으로 제외한다."""
        v2 = await resolve_transfer.transfer_generations(
            "p1", [self._generation(9)], transfer_id="legacy-v2"
        )
        self.assertEqual(v2["format"], "mvhub.resolve-transfer")
        # 큐 v3 코드는 삭제됐으므로 보존 중인 v3 파일을 그 형식 그대로 직접 둔다.
        v3_path = Path(v2["manifest_path"]).parent / "modern-v3.json"
        v3_path.write_text(
            json.dumps(
                {
                    "format": "mvhub.resolve-transfer.v3",
                    "version": 3,
                    "transfer_id": "modern-v3",
                    "project_id": "p1",
                    "manifest_root": str(self.manifest_root),
                    "queue": {"state": "ready"},
                }
            ),
            encoding="utf-8",
        )

        pending = resolve_transfer.list_pending_manifests(["p1"])
        self.assertEqual([item["transfer_id"] for item in pending], ["legacy-v2"])
        self.assertTrue(v3_path.exists())  # 읽기만 하고 지우지 않는다

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


class DirectImportChildTests(ResolveQueueTestBase):
    """현행 v2 직접 전송의 자식 워커 — attempt journal 없이 bridge 로 바로 간다.

    (journal 을 쓰는 분기는 큐 v3 manifest 의 ``queue.last_attempt_id`` 가 있어야 도달하며, 그 코드는
    2026-08-27 에 삭제됐다. 여기서는 v2 manifest 가 그 분기를 타지 않는 것을 고정한다.)
    """

    def test_v2_manifest_has_no_journal_and_goes_straight_to_the_bridge(self):
        manifest = {
            "format": "mvhub.resolve-transfer",
            "manifest_root": str(self.manifest_root),
            "transfer_id": "v2-direct",
        }
        self.assertIsNone(resolve_import_worker.attempt_journal_path(manifest))
        called = []
        with (
            mock.patch.object(
                resolve_import_worker,
                "atomic_write_text",
                side_effect=AssertionError("v2 직접 전송은 journal 을 쓰지 않는다"),
            ),
            mock.patch.object(
                resolve_import_worker,
                "import_manifest_to_current_project",
                lambda payload: called.append(payload) or {"status": "complete", "error_code": ""},
            ),
        ):
            result = resolve_import_worker.run(manifest)
        self.assertEqual(called, [manifest])
        self.assertEqual(result, {"status": "complete", "error_code": ""})

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


class MenuImporterLockTests(ResolveQueueTestBase):
    """메뉴 Importer 가 허브(`GET /locks`)와 같은 .lock 파일에 참여한다 — 다른 보유자가 잡고 있으면 멈추거나 건너뛴다."""

    def test_importer_lock_is_the_shared_project_lock_file(self):
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

    def test_importer_stops_when_another_holder_has_the_machine_lock(self):
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

    def test_importer_skips_a_project_another_holder_is_importing(self):
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


class KilledProcessLivenessTests(ResolveQueueTestBase):
    """강제 종료된 프로세스의 생존 판정(`resolve_lock.process_liveness`) — 잠금 보유자 판정의 근거.

    실환경 재현: 허브 PID 를 강제 종료한 뒤의 상태. Windows 는 프로세스가
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


class InspectModeDispatchTests(ResolveQueueTestBase):
    """자식 워커 진입점 — 실사 조회(inspect) 봉투는 가져오기가 아니라 읽기 전용 조회로 분기한다."""

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
