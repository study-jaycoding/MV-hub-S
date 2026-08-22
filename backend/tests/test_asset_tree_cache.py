"""에셋 트리 캐시와 동시 요청 합치기 회귀 테스트."""

import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import BackgroundTasks

from app.routers import assets
from app.services import asset_tree


class AssetTreeCacheTests(unittest.TestCase):
    def setUp(self):
        self.assets_root = Path("test-assets-root")
        self.folders = ("captures", "imports")
        self.project_root = Path("test-project-root")
        asset_tree.invalidate_combined_tree(self.assets_root, self.folders)
        asset_tree.invalidate_project_tree(self.project_root)

    def tearDown(self):
        asset_tree.invalidate_combined_tree(self.assets_root, self.folders)
        asset_tree.invalidate_project_tree(self.project_root)

    def test_combined_tree_concurrent_reads_scan_once(self):
        expected = [{"name": "captures", "type": "dir", "path": "captures", "children": []}]

        def slow_scan(_assets_root, _folders):
            time.sleep(0.03)
            return expected

        with patch.object(asset_tree, "_scan_combined_internal_children", side_effect=slow_scan) as scan:
            with ThreadPoolExecutor(max_workers=5) as pool:
                results = list(
                    pool.map(
                        lambda _: asset_tree.read_combined_tree(
                            self.assets_root, self.folders
                        ),
                        range(5),
                    )
                )

        self.assertEqual(scan.call_count, 1)
        self.assertTrue(all(result is expected for result in results))

    def test_combined_tree_invalidation_forces_rescan(self):
        with patch.object(
            asset_tree,
            "_scan_combined_internal_children",
            side_effect=[[{"name": "first"}], [{"name": "second"}]],
        ) as scan:
            first = asset_tree.read_combined_tree(self.assets_root, self.folders)
            cached = asset_tree.read_combined_tree(self.assets_root, self.folders)
            asset_tree.invalidate_combined_tree(self.assets_root, self.folders)
            second = asset_tree.read_combined_tree(self.assets_root, self.folders)

        self.assertEqual(scan.call_count, 2)
        self.assertEqual(first, cached)
        self.assertNotEqual(first, second)

    def test_combined_invalidation_during_scan_does_not_restore_stale_cache(self):
        scan_started = threading.Event()
        release_stale_scan = threading.Event()
        stale = [{"name": "stale"}]
        current = [{"name": "current"}]
        calls = 0

        def controlled_scan(*_args):
            nonlocal calls
            calls += 1
            if calls == 1:
                scan_started.set()
                self.assertTrue(release_stale_scan.wait(timeout=1.0))
                return stale
            return current

        with patch.object(
            asset_tree,
            "_scan_combined_internal_children",
            side_effect=controlled_scan,
        ):
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale_read = pool.submit(
                    asset_tree.read_combined_tree,
                    self.assets_root,
                    self.folders,
                )
                self.assertTrue(scan_started.wait(timeout=1.0))
                asset_tree.invalidate_combined_tree(self.assets_root, self.folders)
                release_stale_scan.set()
                self.assertIs(stale_read.result(timeout=1.0), stale)

            refreshed = asset_tree.read_combined_tree(self.assets_root, self.folders)
            cached = asset_tree.read_combined_tree(self.assets_root, self.folders)

        self.assertIs(refreshed, current)
        self.assertIs(cached, current)
        self.assertEqual(calls, 2)

    def test_fresh_combined_read_scans_even_if_cache_appears_while_waiting(self):
        key = asset_tree._combined_key(self.assets_root, self.folders)
        scan_lock = asset_tree._tree_scan_lock(key)
        with asset_tree._TREE_CACHE_LOCK:
            before_epoch = asset_tree._TREE_INVALIDATION_EPOCHS.get(key, 0)
        scan_lock.acquire()
        try:
            with patch.object(
                asset_tree,
                "_scan_combined_internal_children",
                return_value=[{"name": "fresh"}],
            ) as scan:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(
                        asset_tree.read_combined_tree,
                        self.assets_root,
                        self.folders,
                        fresh=True,
                    )
                    deadline = time.monotonic() + 1.0
                    epoch_advanced = False
                    while True:
                        with asset_tree._TREE_CACHE_LOCK:
                            epoch = asset_tree._TREE_INVALIDATION_EPOCHS.get(key, 0)
                        if epoch > before_epoch:
                            epoch_advanced = True
                            break
                        if time.monotonic() >= deadline:
                            break
                        time.sleep(0.001)
                    if epoch_advanced:
                        with asset_tree._TREE_CACHE_LOCK:
                            asset_tree._TREE_CACHE[key] = (
                                time.monotonic(),
                                [{"name": "appeared"}],
                            )
                    scan_lock.release()
                    scan_lock = None
                    result = future.result(timeout=1.0)

            self.assertTrue(epoch_advanced)
            self.assertEqual(result, [{"name": "fresh"}])
            scan.assert_called_once()
        finally:
            if scan_lock is not None:
                scan_lock.release()

    def test_project_tree_concurrent_reads_scan_once(self):
        expected = [{"name": "one.png", "type": "image", "path": "one.png"}]

        def slow_scan(*_args, **_kwargs):
            time.sleep(0.03)
            return expected

        with patch.object(asset_tree, "build_tree", side_effect=slow_scan) as scan:
            with ThreadPoolExecutor(max_workers=5) as pool:
                reads = list(
                    pool.map(
                        lambda _: asset_tree.read_project_tree(self.project_root),
                        range(5),
                    )
                )

        self.assertEqual(scan.call_count, 1)
        self.assertTrue(all(read.children is expected for read in reads))
        self.assertEqual(sum(read.scanned for read in reads), 1)

    def test_project_invalidation_during_scan_does_not_restore_stale_cache(self):
        scan_started = threading.Event()
        release_stale_scan = threading.Event()
        stale = [{"name": "stale"}]
        current = [{"name": "current"}]
        calls = 0

        def controlled_scan(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                scan_started.set()
                self.assertTrue(release_stale_scan.wait(timeout=1.0))
                return stale
            return current

        with patch.object(asset_tree, "build_tree", side_effect=controlled_scan):
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale_read = pool.submit(
                    asset_tree.read_project_tree,
                    self.project_root,
                )
                self.assertTrue(scan_started.wait(timeout=1.0))
                asset_tree.invalidate_project_tree(self.project_root)
                release_stale_scan.set()
                self.assertIs(stale_read.result(timeout=1.0).children, stale)

            refreshed = asset_tree.read_project_tree(self.project_root)
            cached = asset_tree.read_project_tree(self.project_root)

        self.assertIs(refreshed.children, current)
        self.assertTrue(refreshed.scanned)
        self.assertIs(cached.children, current)
        self.assertFalse(cached.scanned)
        self.assertEqual(calls, 2)

    def test_fresh_policy_scan_invalidates_inflight_other_policy(self):
        hidden_started = threading.Event()
        release_hidden = threading.Event()
        hidden_calls = 0

        def controlled_scan(*_args, hidden_names=None, **_kwargs):
            nonlocal hidden_calls
            if hidden_names:
                hidden_calls += 1
                if hidden_calls == 1:
                    hidden_started.set()
                    self.assertTrue(release_hidden.wait(timeout=1.0))
                    return [{"name": "stale-hidden"}]
                return [{"name": "current-hidden"}]
            return [{"name": "fresh-visible"}]

        with patch.object(asset_tree, "build_tree", side_effect=controlled_scan):
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale_hidden = pool.submit(
                    asset_tree.read_project_tree,
                    self.project_root,
                    hidden_names={"render"},
                )
                self.assertTrue(hidden_started.wait(timeout=1.0))
                visible = asset_tree.read_project_tree(self.project_root, fresh=True)
                release_hidden.set()
                self.assertEqual(
                    stale_hidden.result(timeout=1.0).children,
                    [{"name": "stale-hidden"}],
                )

            refreshed_hidden = asset_tree.read_project_tree(
                self.project_root,
                hidden_names={"render"},
            )

        self.assertEqual(visible.children, [{"name": "fresh-visible"}])
        self.assertEqual(refreshed_hidden.children, [{"name": "current-hidden"}])
        self.assertEqual(hidden_calls, 2)

    def test_fresh_project_read_scans_even_if_cache_appears_while_waiting(self):
        key = asset_tree._project_key(self.project_root, None)
        scan_lock = asset_tree._tree_scan_lock(key)
        with asset_tree._TREE_CACHE_LOCK:
            before_epoch = asset_tree._TREE_INVALIDATION_EPOCHS.get(
                asset_tree._epoch_key(key),
                0,
            )
        scan_lock.acquire()
        try:
            with patch.object(
                asset_tree,
                "build_tree",
                return_value=[{"name": "fresh"}],
            ) as scan:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(
                        asset_tree.read_project_tree,
                        self.project_root,
                        fresh=True,
                    )
                    deadline = time.monotonic() + 1.0
                    epoch_advanced = False
                    while True:
                        with asset_tree._TREE_CACHE_LOCK:
                            epoch = asset_tree._TREE_INVALIDATION_EPOCHS.get(
                                asset_tree._epoch_key(key),
                                0,
                            )
                        if epoch > before_epoch:
                            epoch_advanced = True
                            break
                        if time.monotonic() >= deadline:
                            break
                        time.sleep(0.001)
                    if epoch_advanced:
                        with asset_tree._TREE_CACHE_LOCK:
                            asset_tree._TREE_CACHE[key] = (
                                time.monotonic(),
                                [{"name": "appeared"}],
                            )
                    scan_lock.release()
                    scan_lock = None
                    result = future.result(timeout=1.0)

            self.assertTrue(epoch_advanced)
            self.assertEqual(result.children, [{"name": "fresh"}])
            self.assertTrue(result.scanned)
            scan.assert_called_once()
        finally:
            if scan_lock is not None:
                scan_lock.release()

    def test_project_tree_keeps_display_policies_in_separate_caches(self):
        def scan_for_policy(*_args, hidden_names=None, **_kwargs):
            policy = "hide-render" if hidden_names else "show-render"
            return [{"name": policy}]

        with patch.object(asset_tree, "build_tree", side_effect=scan_for_policy) as scan:
            hidden = asset_tree.read_project_tree(
                self.project_root, hidden_names={"render"}
            )
            visible = asset_tree.read_project_tree(self.project_root)
            hidden_cached = asset_tree.read_project_tree(
                self.project_root, hidden_names={"render"}
            )
            visible_cached = asset_tree.read_project_tree(self.project_root)
            asset_tree.invalidate_project_tree(self.project_root)
            asset_tree.read_project_tree(
                self.project_root, hidden_names={"render"}
            )
            asset_tree.read_project_tree(self.project_root)

        self.assertEqual(hidden.children, [{"name": "hide-render"}])
        self.assertEqual(visible.children, [{"name": "show-render"}])
        self.assertIs(hidden.children, hidden_cached.children)
        self.assertIs(visible.children, visible_cached.children)
        self.assertEqual(scan.call_count, 4)

    def test_build_tree_keeps_media_and_hides_internal_entries(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            (root / "shots").mkdir()
            (root / "shots" / "frame.png").write_bytes(b"image")
            (root / "clip.MP4").write_bytes(b"video")
            (root / "sound.wav").write_bytes(b"audio")
            (root / "notes.txt").write_text("ignore", encoding="utf-8")
            (root / "README.md").write_text("ignore", encoding="utf-8")
            (root / "_internal").mkdir()
            (root / "_internal" / "hidden.png").write_bytes(b"image")

            tree = asset_tree.build_tree(root, "")

        self.assertEqual(
            [(node["name"], node["type"]) for node in tree],
            [("shots", "dir"), ("clip.MP4", "video"), ("sound.wav", "audio")],
        )
        self.assertEqual(tree[0]["children"][0]["path"], "shots/frame.png")
        self.assertIn("version", tree[1])

    def test_assets_router_uses_tree_service_without_changing_response(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            (root / "frame.png").write_bytes(b"image")
            asset_tree.invalidate_project_tree(root)
            with (
                patch.object(
                    assets,
                    "_project_dir_info",
                    return_value=(root, False, "test:demo"),
                ),
                patch("app.services.asset_watcher.watch") as watch,
                patch.object(assets.thumbs, "prewarm_recently", return_value=True),
            ):
                result = assets.project_tree(
                    SimpleNamespace(),
                    BackgroundTasks(),
                    project="demo",
                    fresh=True,
                )
            asset_tree.invalidate_project_tree(root)

        self.assertEqual(result["project"], "demo")
        self.assertEqual(result["name"], root.name)
        self.assertEqual(result["children"][0]["path"], "frame.png")
        watch.assert_called_once_with(
            root,
            "demo",
            hide_render=False,
            registration_id="test:demo",
        )

    def test_assets_router_hides_mosaic_only_for_target_project(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = Path(tmp)
            (root / "MOSAIC").mkdir()
            (root / "MOSAIC" / "old.png").write_bytes(b"old")
            (root / "Reference").mkdir()
            (root / "Reference" / "new.png").write_bytes(b"new")
            with (
                patch.object(
                    assets,
                    "_project_dir_info",
                    return_value=(root, False, "test:project"),
                ),
                patch("app.services.asset_watcher.watch"),
                patch.object(assets.thumbs, "prewarm_recently", return_value=True),
            ):
                target = assets.project_tree(
                    SimpleNamespace(),
                    BackgroundTasks(),
                    project="뻘뻘뻘",
                    fresh=True,
                )
                other = assets.project_tree(
                    SimpleNamespace(),
                    BackgroundTasks(),
                    project="다른 프로젝트",
                    fresh=True,
                )
            asset_tree.invalidate_project_tree(root)

            self.assertEqual([node["name"] for node in target["children"]], [])
            self.assertEqual(
                [node["name"] for node in other["children"]],
                ["MOSAIC", "Reference"],
            )
            self.assertTrue((root / "MOSAIC" / "old.png").is_file())
            self.assertTrue((root / "Reference" / "new.png").is_file())

    def test_target_auto_project_keeps_render_hidden_too(self):
        self.assertEqual(
            assets._tree_hidden_names("뻘뻘뻘", auto_project=True),
            {"mosaic", "reference", "render"},
        )

    def test_combined_assets_router_registers_internal_folder_watches(self):
        expected = [{"name": "captures", "type": "dir", "children": []}]
        with (
            patch("app.services.asset_watcher.watch_combined") as watch_combined,
            patch.object(asset_tree, "read_combined_tree", return_value=expected),
        ):
            result = assets.project_tree(
                SimpleNamespace(),
                BackgroundTasks(),
                project=assets._COMBINED_INTERNAL,
                fresh=False,
            )

        self.assertEqual(result["children"], expected)
        watch_combined.assert_called_once_with(
            assets.ASSETS_ROOT,
            assets._COMBINED_INTERNAL,
            tuple(assets._INTERNAL_FOLDERS),
        )


if __name__ == "__main__":
    unittest.main()
