"""어셋 파일 감시 등록·합본 캐시 무효화 회귀 테스트."""

import tempfile
import unittest
from pathlib import Path
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
