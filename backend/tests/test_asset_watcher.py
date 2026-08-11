"""어셋 파일 감시 등록·합본 캐시 무효화 회귀 테스트."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services import asset_watcher


class _FakeObserver:
    def __init__(self) -> None:
        self.scheduled: list[tuple[object, str, bool]] = []

    def schedule(self, handler, path: str, recursive: bool):
        self.scheduled.append((handler, path, recursive))
        return object()


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
