"""어셋 파일 감시 등록·합본 캐시 무효화 회귀 테스트."""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from time import monotonic, sleep
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from app.models import ProjectUpdate
from app.routers import assets, projects
from app.services import asset_watcher
from app.services import asset_mounts


class _FakeObserver:
    def __init__(self) -> None:
        self.scheduled: list[tuple[object, str, bool]] = []
        self.handles: list[object] = []
        self.unscheduled: list[object] = []
        self.stopped = False
        self.joined_with: list[float | None] = []
        self.alive = False

    def schedule(self, handler, path: str, recursive: bool):
        self.scheduled.append((handler, path, recursive))
        handle = object()
        self.handles.append(handle)
        return handle

    def unschedule(self, handle) -> None:
        self.unscheduled.append(handle)

    def stop(self) -> None:
        self.stopped = True
        self.alive = False

    def join(self, timeout=None) -> None:
        self.joined_with.append(timeout)

    def is_alive(self) -> bool:
        return self.alive


class AssetWatcherTests(unittest.TestCase):
    def test_modified_media_event_is_not_filtered(self):
        changed: list[str] = []
        handler = asset_watcher._AssetChangeHandler(
            changed.append,
            "C:\\assets",
            lambda _key: False,
        )

        handler.on_any_event(
            SimpleNamespace(
                is_directory=False,
                src_path="C:\\assets\\same-name.png",
                dest_path="",
            )
        )

        self.assertEqual(changed, ["C:\\assets"])

    def test_combined_watch_registers_each_existing_folder(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            (root / "captures").mkdir()
            (root / "imports").mkdir()
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            watcher._observer = observer

            watcher.watch_combined(root, "imp/cap", ("captures", "imports"))

        self.assertEqual(len(observer.scheduled), 2)
        self.assertEqual(
            watcher._dir_projects,
            {
                str(root / "captures"): {"imp/cap"},
                str(root / "imports"): {"imp/cap"},
            },
        )
        self.assertEqual(
            watcher._dir_combined_targets[str(root / "captures")],
            {(str(root), ("captures", "imports"))},
        )

    def test_unwatch_keeps_shared_directory_until_last_registration(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            watcher._observer = observer

            watcher.watch(root, "same", registration_id="owner-a")
            watcher.watch(root, "same", registration_id="owner-b")
            handle = observer.handles[0]

            watcher.unwatch("owner-a")
            self.assertEqual(observer.unscheduled, [])
            self.assertEqual(watcher._dir_projects[str(root)], {"same"})

            watcher.unwatch("owner-b")

        self.assertEqual(observer.unscheduled, [handle])
        self.assertNotIn(str(root), watcher._watches)
        self.assertNotIn(str(root), watcher._dir_projects)
        self.assertEqual(watcher._registration_dirs, {})

    def test_same_registration_moving_path_releases_old_handle(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            first = Path(tmp) / "first"
            second = Path(tmp) / "second"
            first.mkdir()
            second.mkdir()
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            watcher._observer = observer

            watcher.watch(first, "demo", registration_id="auto:p1")
            first_handle = observer.handles[0]
            watcher.watch(second, "demo", registration_id="auto:p1")

        self.assertEqual(observer.unscheduled, [first_handle])
        self.assertNotIn(str(first), watcher._watches)
        self.assertIn(str(second), watcher._watches)
        self.assertEqual(watcher._registration_dirs["auto:p1"], str(second))

    def test_reschedule_increments_generation_and_ignores_old_handler(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            key = str(root)
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            watcher._observer = observer
            watcher.watch(root, "demo", registration_id="owner")
            old_handler = observer.scheduled[0][0]
            old_generation = watcher._watches[key].generation
            observer.alive = True
            clock = [0.0]

            with (
                patch.object(watcher, "_ensure_health_timer_locked"),
                patch.object(watcher, "_start_timer_locked"),
                patch.object(asset_watcher.time, "monotonic", side_effect=lambda: clock[0]),
            ):
                old_handler.on_any_event(
                    SimpleNamespace(
                        is_directory=True,
                        event_type="deleted",
                        src_path=key,
                        dest_path="",
                    )
                )
                clock[0] = asset_watcher._MISSING_RETRY_INITIAL
                watcher._health_check()

                new_handler = observer.scheduled[1][0]
                old_handler.on_any_event(
                    SimpleNamespace(
                        is_directory=False,
                        event_type="created",
                        src_path=str(root / "old.jpg"),
                        dest_path="",
                    )
                )
                self.assertEqual(watcher._pending, set())

                new_handler.on_any_event(
                    SimpleNamespace(
                        is_directory=False,
                        event_type="created",
                        src_path=str(root / "new.jpg"),
                        dest_path="",
                    )
                )

        self.assertEqual(observer.unscheduled, [observer.handles[0]])
        self.assertGreater(watcher._watches[key].generation, old_generation)
        self.assertEqual(watcher._pending, {key})

    def test_watch_path_probe_runs_outside_watcher_lock(self):
        """R5 2-G — 신규 등록의 경로 확인(NAS stat)이 전역 락을 잡은 채 돌면 그 지연
        동안 이벤트·unwatch·복구가 전부 멈춘다. 확인 중에도 락은 자유로워야 한다."""
        import threading

        watcher = asset_watcher._Watcher()
        watcher._observer = _FakeObserver()
        watcher._loop = None
        probing = threading.Event()
        release = threading.Event()

        def slow_identity(_dir_key):
            probing.set()
            release.wait(timeout=2)
            return (1, 2)

        lock_free_during_probe = []
        with patch.object(asset_watcher, "_directory_identity", side_effect=slow_identity):
            worker = threading.Thread(
                target=lambda: watcher.watch(Path("X:\\slow-nas\\proj"), "p")
            )
            worker.start()
            try:
                self.assertTrue(probing.wait(timeout=2))
                acquired = watcher._lock.acquire(timeout=0.5)  # 확인 중 락 획득 시도
                lock_free_during_probe.append(acquired)
                if acquired:
                    watcher._lock.release()
            finally:
                release.set()
                worker.join(timeout=2)
        self.assertEqual(lock_free_during_probe, [True])
        # 확인 성공 → 정상 schedule 완료(재검증 경로가 등록을 잃지 않는다)
        key = str(Path("X:\\slow-nas\\proj"))
        self.assertIsNotNone(watcher._watches[key].handle)
        self.assertEqual(watcher._watches[key].identity, (1, 2))

    def test_nas_transient_missing_waits_for_grace_then_recovers(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            key = str(root)
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            watcher._observer = observer
            watcher.watch(root, "nas", registration_id="owner")
            old_handle = observer.handles[0]
            old_generation = watcher._watches[key].generation
            old_identity = watcher._watches[key].identity
            observer.alive = True
            clock = [0.0]
            available = [False]

            with (
                patch.object(watcher, "_ensure_health_timer_locked"),
                patch.object(
                    asset_watcher,
                    "_directory_identity",
                    side_effect=lambda _key: old_identity if available[0] else None,
                ),
                patch.object(asset_watcher.time, "monotonic", side_effect=lambda: clock[0]),
            ):
                # 첫 단절은 7초 안에 회복한다. 기존 핸들과 세대가 그대로여야 한다.
                for clock[0] in (0.0, 1.0, 3.0):
                    watcher._health_check()
                available[0] = True
                clock[0] = 7.0
                watcher._health_check()

                self.assertEqual(observer.unscheduled, [])
                self.assertIs(watcher._watches[key].handle, old_handle)
                self.assertEqual(watcher._watches[key].generation, old_generation)
                self.assertNotIn(key, watcher._recoveries)

                # 두 번째 단절은 30초 유예를 넘긴다. 그때만 옛 핸들을 죽은 것으로 확정한다.
                available[0] = False
                for clock[0] in (10.0, 11.0, 13.0, 17.0, 25.0, 33.0):
                    watcher._health_check()
                    self.assertEqual(observer.unscheduled, [])
                clock[0] = 41.0
                watcher._health_check()

                self.assertEqual(observer.unscheduled, [old_handle])
                self.assertIsNone(watcher._watches[key].handle)
                self.assertIn(key, watcher._registrations_by_dir)

                available[0] = True
                clock[0] = 49.0
                watcher._health_check()

        self.assertEqual(len(observer.scheduled), 2)
        self.assertIs(watcher._watches[key].handle, observer.handles[1])
        self.assertGreater(watcher._watches[key].generation, old_generation)

    @unittest.skipUnless(
        sys.platform == "win32" and asset_watcher._HAS_WATCHDOG,
        "Windows watchdog 실측 전용",
    )
    def test_windows_delete_and_rename_recreate_reschedule_real_handle(self):
        def wait_until(predicate, message: str, timeout: float = 8.0) -> None:
            deadline = monotonic() + timeout
            while monotonic() < deadline:
                if predicate():
                    return
                sleep(0.02)
            self.fail(message)

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp) / "watched"
            root.mkdir()
            key = str(root)
            watcher = asset_watcher._Watcher()
            loop = asyncio.new_event_loop()
            try:
                with (
                    patch.object(asset_watcher, "_WATCH_HEALTH_INTERVAL", 0.05),
                    patch.object(asset_watcher, "_MISSING_RETRY_INITIAL", 0.05),
                    patch.object(asset_watcher, "_MISSING_RETRY_MAX", 0.1),
                    patch.object(asset_watcher, "_MISSING_GRACE", 0.5),
                    patch.object(asset_watcher, "_DEBOUNCE", 10.0),
                ):
                    watcher.start(loop)
                    watcher.watch(root, "windows-real", registration_id="owner")
                    old_generation = watcher._watches[key].generation
                    old_handle = watcher._watches[key].handle

                    root.rmdir()
                    root.mkdir()

                    wait_until(
                        lambda: (
                            watcher._watches[key].generation > old_generation
                            and watcher._watches[key].handle is not None
                            and watcher._watches[key].handle is not old_handle
                        ),
                        "삭제·재생성 뒤 새 watchdog 핸들이 등록되지 않음",
                    )

                    watcher._on_change(key, old_generation)
                    self.assertNotIn(key, watcher._pending)

                    (root / "after-recreate.jpg").write_bytes(b"jpg")
                    wait_until(
                        lambda: key in watcher._pending,
                        "재생성된 폴더의 실제 파일 이벤트를 받지 못함",
                    )

                    with watcher._lock:
                        if watcher._timer:
                            watcher._timer.cancel()
                            watcher._timer = None
                        watcher._pending.clear()
                        rename_generation = watcher._watches[key].generation
                        rename_handle = watcher._watches[key].handle

                    renamed = root.with_name("watched-renamed")
                    root.rename(renamed)
                    root.mkdir()

                    wait_until(
                        lambda: (
                            watcher._watches[key].generation > rename_generation
                            and watcher._watches[key].handle is not None
                            and watcher._watches[key].handle is not rename_handle
                        ),
                        "이름변경·원래 이름 재생성 뒤 새 watchdog 핸들이 등록되지 않음",
                    )
                    watcher._on_change(key, rename_generation)
                    self.assertNotIn(key, watcher._pending)

                    (root / "after-rename.jpg").write_bytes(b"jpg")
                    wait_until(
                        lambda: key in watcher._pending,
                        "이름변경 뒤 재생성된 폴더의 실제 파일 이벤트를 받지 못함",
                    )
            finally:
                watcher.stop()
                loop.close()

    def test_hide_render_policy_recomputes_after_shared_registration_leaves(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            watcher = asset_watcher._Watcher()
            watcher._observer = _FakeObserver()

            watcher.watch(
                root,
                "auto",
                hide_render=True,
                registration_id="auto:p1",
            )
            watcher.watch(
                root,
                "manual",
                hide_render=False,
                registration_id="manual:owner",
            )
            self.assertFalse(watcher._hide_render_for(str(root)))

            watcher.unwatch("manual:owner")

        self.assertTrue(watcher._hide_render_for(str(root)))

    def test_stop_closes_new_events_before_join_and_clears_registrations(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            watcher = asset_watcher._Watcher()
            observer = _FakeObserver()
            timer = Mock()
            watcher._observer = observer
            watcher.watch(root, "demo", registration_id="owner")
            watcher._timer = timer
            watcher._pending.add(str(root))

            watcher.stop()
            watcher._on_change(str(root))  # stop과 경합한 늦은 watchdog 이벤트는 무시

        timer.cancel.assert_called_once_with()
        self.assertTrue(observer.stopped)
        self.assertEqual(observer.joined_with, [5])
        self.assertEqual(watcher._pending, set())
        self.assertEqual(watcher._watches, {})
        self.assertEqual(watcher._registration_dirs, {})

    def test_manual_mount_replacement_and_delete_unregister_watcher(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            first = root / "first"
            second = root / "second"
            first.mkdir()
            second.mkdir()
            mounts_file = root / "mounts.json"
            asset_mounts.upsert(
                mounts_file,
                name="demo",
                location=str(first),
                owner="owner",
            )
            request = SimpleNamespace()
            registration_id = asset_watcher.manual_registration_id("owner", "demo")

            with (
                patch.object(assets, "_mounts_file", return_value=mounts_file),
                patch.object(assets, "actor_id", return_value="owner"),
                patch.object(assets, "_auto_project_mounts", return_value=[]),
                patch.object(assets.asset_watcher, "unwatch") as unwatch,
            ):
                assets.add_mount(assets.MountIn(name="demo", path=str(second)), request)
                assets.del_mount("demo", request)

        self.assertEqual(
            unwatch.call_args_list,
            [
                call(registration_id),
                call(registration_id),
            ],
        )

    def test_project_identity_change_and_delete_unregister_auto_watcher(self):
        request = SimpleNamespace()
        updated = {"id": "p1", "name": "renamed"}
        registration_id = asset_watcher.auto_registration_id("p1")

        with (
            patch.object(projects._proxy, "proxying", return_value=False),
            patch.object(projects, "require_global_cap"),
            patch.object(projects, "actor_id", return_value="owner"),
            patch.object(projects, "journal_audit_event"),
            patch.object(projects.repo, "get_project", side_effect=[{"id": "p1"}, updated]),
            patch.object(projects.repo, "update_project_identity"),
            patch.object(projects.asset_watcher, "unwatch") as unwatch,
        ):
            result = projects.update_project(
                "p1",
                ProjectUpdate(name="renamed"),
                request,
            )

        self.assertEqual(result, updated)
        unwatch.assert_called_once_with(registration_id)

        with (
            patch.object(projects._proxy, "proxying", return_value=False),
            patch.object(projects, "require_global_cap"),
            patch.object(projects.repo, "get_project", return_value={"id": "p1"}),
            patch.object(
                projects.repo,
                "update_project_identity",
                side_effect=projects.repo.ProjectNameConflictError("중복"),
            ),
            patch.object(projects.asset_watcher, "unwatch") as unwatch,
        ):
            with self.assertRaises(projects.HTTPException) as raised:
                projects.update_project(
                    "p1",
                    ProjectUpdate(name="duplicate"),
                    request,
                )

        self.assertEqual(raised.exception.status_code, 409)
        unwatch.assert_not_called()

        with (
            patch.object(projects._proxy, "proxying", return_value=False),
            patch.object(projects, "require_global_cap"),
            patch.object(projects, "actor_id", return_value="owner"),
            patch.object(projects, "journal_audit_event"),
            patch.object(projects.repo, "delete_project", return_value=True),
            patch.object(projects.asset_watcher, "unwatch") as unwatch,
        ):
            self.assertEqual(projects.delete_project("p1", request), {"ok": True})

        unwatch.assert_called_once_with(registration_id)

    def test_flush_invalidates_project_and_combined_cache(self):
        watcher = asset_watcher._Watcher()
        directory = Path("asset-root") / "captures"
        watcher._pending.add(str(directory))
        watcher._dir_projects[str(directory)] = {"imp/cap"}
        watcher._dir_combined_targets[str(directory)] = {
            ("asset-root", ("captures", "imports"))
        }
        watcher._loop = Mock()
        future = Mock()

        with (
            patch.object(asset_watcher.asset_tree, "invalidate_project_tree") as invalidate_project,
            patch.object(asset_watcher.asset_tree, "invalidate_combined_tree") as invalidate_combined,
            patch("asyncio.run_coroutine_threadsafe", return_value=future) as submit,
        ):
            watcher._flush()

        invalidate_project.assert_called_once_with(directory)
        invalidate_combined.assert_called_once_with(
            Path("asset-root"), ("captures", "imports")
        )
        future.add_done_callback.assert_called_once()
        coroutine = submit.call_args.args[0]
        coroutine.close()


if __name__ == "__main__":
    unittest.main()
