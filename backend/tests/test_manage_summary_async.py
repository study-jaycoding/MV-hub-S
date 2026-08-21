"""관리 summary 라우트가 SQLite 집계를 이벤트 루프 밖(스레드)에서 실행하는지 검증."""

from __future__ import annotations

import asyncio
import threading
import time
import unittest
from unittest import mock

from fastapi import Request

from app.routers import manage


class ManageSummaryAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_offloads_sqlite_aggregation_off_event_loop(self):
        seen: dict[str, bool] = {}

        def slow_summary(type_map, workspace_id):
            seen["off_main_thread"] = (
                threading.current_thread() is not threading.main_thread()
            )
            time.sleep(0.2)
            return {"ok": True, "workspace_id": workspace_id}

        progress: list[float] = []

        async def probe():
            await asyncio.sleep(0.05)
            progress.append(time.perf_counter())

        request = Request({"type": "http", "client": ("127.0.0.1", 1)})
        with (
            mock.patch.object(
                manage.cli_bridge, "list_models", new=mock.AsyncMock(return_value=[])
            ),
            mock.patch.object(
                manage.repo_manage, "dashboard_summary", side_effect=slow_summary
            ),
            mock.patch.object(manage, "_require_manage_read"),
        ):
            start = time.perf_counter()
            result, _probe = await asyncio.gather(manage.summary(request, None), probe())

        self.assertTrue(result["ok"])
        self.assertTrue(seen["off_main_thread"])
        # 집계(0.2초)가 도는 동안 이벤트 루프가 다른 코루틴을 진행시켰어야 한다.
        self.assertLess(progress[0] - start, 0.15)


if __name__ == "__main__":
    unittest.main()
