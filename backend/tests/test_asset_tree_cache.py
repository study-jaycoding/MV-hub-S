"""에셋 트리 캐시와 동시 요청 합치기 회귀 테스트."""

import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from app.routers import assets


class AssetTreeCacheTests(unittest.TestCase):
    def setUp(self):
        assets._invalidate_combined_tree_cache()

    def tearDown(self):
        assets._invalidate_combined_tree_cache()

    def test_combined_tree_concurrent_reads_scan_once(self):
        expected = [{"name": "captures", "type": "dir", "path": "captures", "children": []}]

        def slow_scan():
            time.sleep(0.03)
            return expected

        with patch.object(assets, "_scan_combined_internal_children", side_effect=slow_scan) as scan:
            with ThreadPoolExecutor(max_workers=5) as pool:
                results = list(pool.map(lambda _: assets._combined_internal_children(), range(5)))

        self.assertEqual(scan.call_count, 1)
        self.assertTrue(all(result is expected for result in results))

    def test_combined_tree_invalidation_forces_rescan(self):
        with patch.object(
            assets,
            "_scan_combined_internal_children",
            side_effect=[[{"name": "first"}], [{"name": "second"}]],
        ) as scan:
            first = assets._combined_internal_children()
            cached = assets._combined_internal_children()
            assets._invalidate_combined_tree_cache()
            second = assets._combined_internal_children()

        self.assertEqual(scan.call_count, 2)
        self.assertEqual(first, cached)
        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
