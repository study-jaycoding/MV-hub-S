"""Resolve 선택 부모 — 계정·manifest 경계와 WS 중복 억제."""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_selection_monitor
from app.services.resolve_selection_monitor import ResolveSelectionMonitor
from app.services.resolve_selection_worker import RESULT_PREFIX


def selection_line(value: str, count: int = 1) -> bytes:
    return (RESULT_PREFIX + json.dumps({"selected_count": count, "file_path": value}) + "\n").encode()


class FakeProcess:
    def __init__(self):
        self.stdout = asyncio.StreamReader()
        self.returncode = None

    def terminate(self):
        self.returncode = 0
        self.stdout.feed_eof()

    kill = terminate

    async def wait(self):
        return self.returncode


class ResolveSelectionMonitorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.monitor = ResolveSelectionMonitor()

    def _account_patches(self):
        return (
            mock.patch.object(
                self.monitor,
                "_active_account_projects",
                return_value=("user@example.com", "uid-1", ["project-1"], "uid-1"),
            ),
            mock.patch.object(resolve_selection_monitor.active_account, "account_key", return_value="user@example.com"),
            mock.patch.object(resolve_selection_monitor.active_account, "active_uid", return_value="uid-1"),
        )

    def test_exact_manifest_path_resolves_old_clip_without_metadata(self):
        clip_path = r"D:\render\clip.mp4"
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor,
            "manifest_source_roots",
            return_value={"project-1": Path(r"D:\render")},
        ), mock.patch.object(
            self.monitor,
            "_path_index",
            return_value={
                resolve_selection_monitor._normal_path(clip_path): (
                    "project-1",
                    "generation-1",
                )
            },
        ):
            resolved = self.monitor._resolve_selection(
                {"selected_count": 1, "file_path": clip_path}
            )

        self.assertEqual(resolved, ("generation-1", "uid-1"))

    def test_auth_dev_uses_paired_browser_account_and_visible_projects(self):
        account = {
            "email": "user@example.com",
            "creator_uid": "uid-1",
            "global_role": "member",
            "status": "approved",
        }
        with (
            mock.patch.object(resolve_selection_monitor, "AUTH_ENABLED", True),
            mock.patch.object(
                resolve_selection_monitor.local_agent_pair,
                "active_email",
                return_value="user@example.com",
            ),
            mock.patch.object(
                resolve_selection_monitor.repo, "get_account", return_value=account
            ),
            mock.patch.object(
                resolve_selection_monitor.repo,
                "list_projects",
                return_value={"projects": [{"id": "project-1"}]},
            ) as list_projects,
            mock.patch.object(
                resolve_selection_monitor,
                "realtime_scope",
                return_value="acct:user@example.com",
            ),
        ):
            snapshot = self.monitor._active_account_projects()

        self.assertEqual(
            snapshot,
            ("user@example.com", "uid-1", ["project-1"], "acct:user@example.com"),
        )
        list_projects.assert_called_once_with(
            include_archived=True, member_uid="uid-1"
        )

    def test_auth_dev_without_paired_account_fails_closed(self):
        with (
            mock.patch.object(resolve_selection_monitor, "AUTH_ENABLED", True),
            mock.patch.object(
                resolve_selection_monitor.local_agent_pair,
                "active_email",
                return_value=None,
            ),
        ):
            snapshot = self.monitor._active_account_projects()

        self.assertEqual(snapshot, ("", None, [], None))

    def test_metadata_uses_current_account_db_without_manifest_scan(self):
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            self.monitor,
            "_path_index",
        ) as path_index, mock.patch.object(
            resolve_selection_monitor.repo,
            "get_generation",
            return_value={"id": "generation-1"},
        ):
            resolved = self.monitor._resolve_selection(
                {
                    "selected_count": 1,
                    "file_path": r"D:\render\clip.mp4",
                    "generation_id": "generation-1",
                    "project_id": "project-1",
                }
            )

        self.assertEqual(resolved, ("generation-1", "uid-1"))
        path_index.assert_not_called()

    def test_metadata_missing_from_current_account_is_rejected(self):
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor.repo,
            "get_generation",
            return_value=None,
        ):
            resolved = self.monitor._resolve_selection(
                {
                    "selected_count": 1,
                    "generation_id": "someone-else",
                    "project_id": "project-1",
                }
            )

        self.assertIsNone(resolved)

    def test_non_render_path_does_not_scan_manifests(self):
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor,
            "manifest_source_roots",
            return_value={"project-1": Path(r"D:\render")},
        ), mock.patch.object(self.monitor, "_path_index") as path_index:
            resolved = self.monitor._resolve_selection(
                {"selected_count": 1, "file_path": r"E:\ordinary\clip.mp4"}
            )

        self.assertIsNone(resolved)
        path_index.assert_not_called()

    def test_remote_metadata_is_accepted_only_when_manifest_path_matches(self):
        clip_path = r"D:\render\remote.mp4"
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor.repo,
            "get_generation",
            return_value=None,
        ), mock.patch.object(
            resolve_selection_monitor,
            "manifest_source_roots",
            return_value={"project-1": Path(r"D:\render")},
        ), mock.patch.object(
            self.monitor,
            "_path_index",
            return_value={
                resolve_selection_monitor._normal_path(clip_path): (
                    "project-1",
                    "remote-generation",
                )
            },
        ):
            resolved = self.monitor._resolve_selection(
                {
                    "selected_count": 1,
                    "file_path": clip_path,
                    "generation_id": "remote-generation",
                    "project_id": "project-1",
                }
            )

        self.assertEqual(resolved, ("remote-generation", "uid-1"))

    def test_multi_selection_filters_permissions_and_reuses_one_account_snapshot(self):
        patches = self._account_patches()
        with patches[0] as snapshot, patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor.repo, "get_generation", return_value={"id": "exists"},
        ) as get_generation:
            resolved = self.monitor._resolve_selections({
                "selected_count": 4,
                "selections": [
                    {"generation_id": "B", "project_id": "project-1"},
                    {"generation_id": "secret", "project_id": "other-project"},
                    {"generation_id": "A", "project_id": "project-1"},
                    {"generation_id": "B", "project_id": "project-1"},
                ],
            })
        self.assertEqual(resolved, (["A", "B"], "uid-1"))
        snapshot.assert_called_once()
        self.assertNotIn(mock.call("secret"), get_generation.call_args_list)

    def test_multi_selection_retains_exact_manifest_matching_for_old_clips(self):
        patches = self._account_patches()
        path = r"D:\render\old.mp4"
        with patches[0], patches[1], patches[2], mock.patch.object(
            self.monitor, "_source_roots", return_value={"project-1": Path(r"D:\render")},
        ), mock.patch.object(self.monitor, "_path_index", return_value={
            resolve_selection_monitor._normal_path(path): ("project-1", "old-generation"),
        }):
            resolved = self.monitor._resolve_selections({
                "selected_count": 2,
                "selections": [{"file_path": path}, {"file_path": r"E:\unrelated\old.mp4"}],
            })
        self.assertEqual(resolved, (["old-generation"], "uid-1"))

    def test_account_change_drops_whole_batch_including_already_resolved_items(self):
        patches = self._account_patches()
        with patches[0], mock.patch.object(
            self.monitor, "_active_account_identity", return_value=("new@example.com", "uid-2"),
        ), mock.patch.object(self.monitor, "_resolve_selection", return_value=("A", "uid-1")):
            self.assertIsNone(self.monitor._resolve_selections({
                "selected_count": 2, "selections": [{"generation_id": "A"}, {"generation_id": "B"}],
            }))

    def test_batch_mapping_is_bounded_and_unpaired_account_fails_closed(self):
        patches = self._account_patches()
        with patches[0], patches[1], patches[2], mock.patch.object(
            self.monitor, "_resolve_selection", return_value=("A", "uid-1"),
        ) as mapper:
            self.monitor._resolve_selections({"selected_count": 300, "selections": [{}] * 300})
        self.assertEqual(mapper.call_count, resolve_selection_monitor.MAX_SELECTIONS)
        with mock.patch.object(self.monitor, "_active_account_projects", return_value=("", None, [], None)):
            self.assertIsNone(self.monitor._resolve_selections({"selected_count": 0, "selections": []}))

    async def test_multi_wire_contains_ids_only_and_clear_is_scoped_and_deduplicated(self):
        patches = self._account_patches()
        def line(count, items):
            return (RESULT_PREFIX + json.dumps({"selected_count": count, "selections": items})).encode()
        with patches[0], patches[1], patches[2], mock.patch.object(
            resolve_selection_monitor.repo, "get_generation", return_value={"id": "exists"},
        ), mock.patch.object(resolve_selection_monitor.manager, "broadcast", new=mock.AsyncMock()) as broadcast:
            await self.monitor._handle_line(line(2, [
                {"generation_id": "B", "project_id": "project-1", "file_path": r"D:\render\b.mp4"},
                {"generation_id": "A", "project_id": "project-1", "file_path": r"D:\render\a.mp4"},
            ]))
            await self.monitor._handle_line(line(0, []))
            await self.monitor._handle_line(line(0, []))
        self.assertEqual(broadcast.await_count, 2)
        message = broadcast.await_args_list[0].args[0]
        self.assertEqual(message["generation_ids"], ["A", "B"])
        self.assertEqual(message["generation_id"], "A")
        self.assertEqual(message["selected_count"], 2)
        self.assertNotIn("file_path", json.dumps(message))
        self.assertNotIn("project_id", json.dumps(message))
        clear = broadcast.await_args_list[1]
        self.assertEqual(clear.args[0]["generation_ids"], [])
        self.assertIsNone(clear.args[0]["generation_id"])
        self.assertIn("uid-1", list(clear.args[1:]) + list(clear.kwargs.values()))

    async def test_raw_count_and_truncation_changes_are_not_deduplicated(self):
        with mock.patch.object(self.monitor, "_resolve_selections", return_value=(["A"], "uid-1")), mock.patch.object(
            resolve_selection_monitor.manager, "broadcast", new=mock.AsyncMock(),
        ) as broadcast:
            for count, truncated in ((1, False), (2, False), (2, True), (201, False)):
                await self.monitor._handle_line((RESULT_PREFIX + json.dumps({
                    "selected_count": count, "selections": [], "truncated": truncated,
                })).encode())
        self.assertEqual(broadcast.await_count, 4)
        self.assertTrue(broadcast.await_args.args[0]["truncated"])

    async def test_same_worker_event_is_broadcast_only_once(self):
        payload = RESULT_PREFIX + json.dumps(
            {"selected_count": 1, "file_path": "clip.mp4"}
        )
        with (
            mock.patch.object(
                self.monitor,
                "_resolve_selection",
                return_value=("generation-1", "uid-1"),
            ),
            mock.patch.object(
                resolve_selection_monitor.manager,
                "broadcast",
                new=mock.AsyncMock(),
            ) as broadcast,
        ):
            await self.monitor._handle_line(payload.encode("utf-8"))
            await self.monitor._handle_line(payload.encode("utf-8"))

        broadcast.assert_awaited_once()
        message = broadcast.await_args.args[0]
        self.assertEqual(message["generation_id"], "generation-1")
        self.assertTrue(message["selection_id"])

    async def test_first_snapshot_after_child_start_is_only_a_baseline(self):
        self.monitor._priming = True
        payload = RESULT_PREFIX + json.dumps(
            {"selected_count": 1, "file_path": "clip.mp4"}
        )
        with (
            mock.patch.object(self.monitor, "_resolve_selection") as resolve,
            mock.patch.object(
                resolve_selection_monitor.manager,
                "broadcast",
                new=mock.AsyncMock(),
            ) as broadcast,
        ):
            await self.monitor._handle_line(payload.encode("utf-8"))

        resolve.assert_not_called()
        broadcast.assert_not_awaited()
        self.assertFalse(self.monitor._priming)

    async def _start_reader(self):
        process = FakeProcess()
        self.monitor._process = process
        self.monitor._reader_closed = False
        self.monitor._priming = True
        self.monitor._reader_task = asyncio.create_task(self.monitor._read_selections(process))
        return process

    async def test_reader_consumes_baseline_before_coalescing_first_change(self):
        process = await self._start_reader()
        try:
            process.stdout.feed_data(b"not json\n" + selection_line("baseline") + selection_line("A"))
            await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
            revision, raw = self.monitor._latest_line
            self.assertEqual(revision, self.monitor._selection_revision)
            self.assertEqual(json.loads(raw.decode().removeprefix(RESULT_PREFIX))["file_path"], "A")
            self.assertFalse(self.monitor._priming)
        finally:
            await self.monitor._stop_process()

    async def test_slow_mapping_skips_intermediate_choices_and_publishes_latest_only(self):
        process = FakeProcess()
        started = threading.Event()
        release = threading.Event()

        def lookup(payload):
            if payload["file_path"] == "A":
                started.set()
                if not release.wait(2):
                    raise AssertionError("test mapper was not released")
            return payload["file_path"], "uid-1"

        async def launch():
            self.monitor._priming = True
            return process

        with (
            mock.patch.object(self.monitor, "_launch_process", side_effect=launch),
            mock.patch.object(resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})),
            mock.patch.object(self.monitor, "_resolve_selection", side_effect=lookup) as mapper,
            mock.patch.object(resolve_selection_monitor.manager, "broadcast", new=mock.AsyncMock()) as broadcast,
        ):
            self.monitor.start()
            try:
                process.stdout.feed_data(selection_line("baseline") + selection_line("A"))
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                process.stdout.feed_data(selection_line("B") + selection_line("C"))
                await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
                release.set()
                for _ in range(100):
                    if broadcast.await_count:
                        break
                    await asyncio.sleep(.01)
                self.assertEqual([call.args[0]["file_path"] for call in mapper.call_args_list], ["A", "C"])
                self.assertEqual([call.args[0]["generation_id"] for call in broadcast.await_args_list], ["C"])
            finally:
                release.set()
                await self.monitor.stop()
        self.assertIsNone(self.monitor._reader_task)
        self.assertEqual(process.returncode, 0)

    async def test_deselect_eof_and_suspend_reject_late_mapping_and_clear_caches(self):
        for action in ("deselect", "eof", "suspend"):
            with self.subTest(action=action):
                self.monitor = ResolveSelectionMonitor()
                process = await self._start_reader()
                process.stdout.feed_data(selection_line("baseline") + selection_line("A"))
                await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
                revision, raw = self.monitor._latest_line
                self.monitor._latest_line = None
                self.monitor._selection_ready.clear()
                started, release = threading.Event(), threading.Event()

                def lookup(_payload):
                    started.set()
                    if not release.wait(2):
                        raise AssertionError("test mapper was not released")
                    self.monitor._index_cache = ("stale",)
                    self.monitor._roots_cache = ("stale",)
                    return "A", "uid-1"

                with (
                    mock.patch.object(self.monitor, "_resolve_selection", side_effect=lookup),
                    mock.patch.object(resolve_selection_monitor.manager, "broadcast", new=mock.AsyncMock()) as broadcast,
                ):
                    mapping = asyncio.create_task(self.monitor._handle_line(raw, revision))
                    try:
                        self.assertTrue(await asyncio.to_thread(started.wait, 1))
                        if action == "deselect":
                            process.stdout.feed_data(selection_line("", count=0))
                        elif action == "eof":
                            process.stdout.feed_eof()
                        else:
                            async with self.monitor.suspended():
                                pass
                        await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
                        release.set()
                        await mapping
                        broadcast.assert_not_awaited()
                        if action == "deselect":
                            self.assertEqual(self.monitor._index_cache, ("stale",))
                            self.assertEqual(self.monitor._roots_cache, ("stale",))
                        else:
                            self.assertIsNone(self.monitor._index_cache)
                            self.assertIsNone(self.monitor._roots_cache)
                    finally:
                        release.set()
                        await mapping
                        await self.monitor._stop_process()

    async def test_cancel_waits_for_mapper_before_returning(self):
        started, release = threading.Event(), threading.Event()

        def lookup(_payload):
            started.set()
            release.wait(2)
            return "A", "uid-1"

        with (
            mock.patch.object(self.monitor, "_resolve_selection", side_effect=lookup),
            mock.patch.object(resolve_selection_monitor.manager, "broadcast", new=mock.AsyncMock()) as broadcast,
        ):
            mapping = asyncio.create_task(self.monitor._handle_line(selection_line("A")))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                mapping.cancel()
                await asyncio.sleep(0)
                self.assertFalse(mapping.done())
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await mapping
            broadcast.assert_not_awaited()

    async def test_restart_discards_old_slot_and_uses_new_baseline(self):
        previous_process = await self._start_reader()
        previous_process.stdout.feed_data(selection_line("baseline") + selection_line("old"))
        await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
        old_revision = self.monitor._selection_revision
        await self.monitor._stop_process()
        process = await self._start_reader()
        self.monitor._selection_ready.clear()
        try:
            process.stdout.feed_data(selection_line("old") + selection_line("new"))
            await asyncio.wait_for(self.monitor._selection_ready.wait(), 1)
            revision, raw = self.monitor._latest_line
            self.assertGreater(revision, old_revision)
            self.assertIn(b'"new"', raw)
            self.assertFalse(self.monitor._selection_is_current(old_revision))
        finally:
            await self.monitor._stop_process()

    async def test_spawn_success_alone_does_not_reset_restart_backoff(self):
        for successful_attempt, expected in ((None, [2.0, 5.0, 30.0]), (2, [2.0, 2.0, 5.0])):
            with self.subTest(successful_attempt=successful_attempt):
                self.monitor = ResolveSelectionMonitor()
                attempts = 0
                waits = []

                async def launch():
                    nonlocal attempts
                    attempts += 1
                    self.monitor._priming = True
                    self.monitor._worker_had_snapshot = False
                    process = FakeProcess()
                    if attempts == successful_attempt:
                        process.stdout.feed_data(selection_line("baseline"))
                    process.stdout.feed_eof()
                    return process

                async def sleep(delay):
                    waits.append(delay)
                    if len(waits) == 3:
                        self.monitor._stopping = True

                with (
                    mock.patch.object(self.monitor, "_launch_process", side_effect=launch),
                    mock.patch.object(resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})),
                    mock.patch.object(resolve_selection_monitor.asyncio, "sleep", side_effect=sleep),
                ):
                    await asyncio.wait_for(self.monitor._run(), 2)
                self.assertEqual(waits, expected)
                self.assertIsNone(self.monitor._reader_task)


class ControlledReader(asyncio.StreamReader):
    """외부 파이프의 읽기/취소 완료 시점만 조절한다. 감시 reader는 제품 코드다."""

    def __init__(self):
        super().__init__()
        self.reading = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.release_cancel = asyncio.Event()
        self.release_cancel.set()

    async def readline(self):
        self.reading.set()
        try:
            return await super().readline()
        except asyncio.CancelledError:
            self.cancelled.set()
            await self.release_cancel.wait()
            raise


class ControlledProcess(FakeProcess):
    def __init__(self):
        super().__init__()
        self.stdout = ControlledReader()
        self.terminated = asyncio.Event()
        self.exited = asyncio.Event()
        self.exit_on_terminate = True

    def terminate(self):
        self.terminated.set()
        if self.exit_on_terminate:
            self.finish()

    def finish(self):
        if self.returncode is None:
            self.returncode = 0
            self.stdout.feed_eof()
            self.exited.set()

    kill = finish

    async def wait(self):
        await self.exited.wait()
        return self.returncode


class ResolveSelectionLifecycleTests(unittest.IsolatedAsyncioTestCase):
    """start→실제 감시 루프/reader→suspended/stop 경로, 외부 프로세스만 대역."""

    @contextlib.asynccontextmanager
    async def running_monitor(self, process, spawn=None):
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=mock.AsyncMock(side_effect=spawn, return_value=process)),
            mock.patch.object(resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})),
        ):
            monitor.start()
            try:
                yield monitor
            finally:
                process.stdout.release_cancel.set()
                process.finish()
                await asyncio.wait_for(monitor.stop(), 2)

    async def test_concurrent_suspend_waits_for_reader_cancellation(self):
        process = ControlledProcess()
        process.stdout.release_cancel.clear()
        async with self.running_monitor(process) as monitor:
            await asyncio.wait_for(process.stdout.reading.wait(), 1)
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(process.returncode)

            first = asyncio.create_task(transfer())
            await asyncio.wait_for(process.stdout.cancelled.wait(), 1)
            second = asyncio.create_task(transfer())
            try:
                await asyncio.sleep(.02)
                self.assertEqual(entered, [], "두 번째 가져오기도 reader 회수를 기다려야 한다")
            finally:
                process.stdout.release_cancel.set()
                await asyncio.wait_for(asyncio.gather(first, second), 1)
            self.assertEqual(entered, [0, 0])
            self.assertEqual(monitor._pause_count, 0)

    async def test_concurrent_suspend_waits_for_process_exit(self):
        process = ControlledProcess()
        process.exit_on_terminate = False
        async with self.running_monitor(process) as monitor:
            await asyncio.wait_for(process.stdout.reading.wait(), 1)
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(process.returncode)

            first = asyncio.create_task(transfer())
            await asyncio.wait_for(process.terminated.wait(), 1)
            second = asyncio.create_task(transfer())
            try:
                await asyncio.sleep(.02)
                self.assertEqual(entered, [], "terminate 호출만으로 가져오기를 허용하면 안 된다")
            finally:
                process.finish()
                await asyncio.wait_for(asyncio.gather(first, second), 1)
            self.assertEqual(entered, [0, 0])

    async def test_suspend_waits_for_inflight_spawn_and_reaps_child(self):
        process = ControlledProcess()
        spawning, release_spawn = asyncio.Event(), asyncio.Event()

        async def spawn(*_args, **_kwargs):
            spawning.set()
            await release_spawn.wait()
            return process

        async with self.running_monitor(process, spawn) as monitor:
            await asyncio.wait_for(spawning.wait(), 1)
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(process.returncode)

            transfer_task = asyncio.create_task(transfer())
            try:
                await asyncio.sleep(.02)
                self.assertEqual(entered, [], "아직 생성 중인 자식도 회수한 뒤 가져와야 한다")
            finally:
                release_spawn.set()
                await asyncio.wait_for(transfer_task, 1)
            self.assertEqual(entered, [0])
            self.assertIsNone(monitor._process)
            self.assertIsNone(monitor._reader_task)

    async def test_cancelled_suspend_drains_child_and_releases_pause(self):
        process = ControlledProcess()
        process.exit_on_terminate = False
        async with self.running_monitor(process) as monitor:
            await asyncio.wait_for(process.stdout.reading.wait(), 1)
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(True)

            transfer_task = asyncio.create_task(transfer())
            await asyncio.wait_for(process.terminated.wait(), 1)
            try:
                for _ in range(2):
                    transfer_task.cancel()
                    await asyncio.sleep(.01)
                self.assertFalse(transfer_task.done(), "취소돼도 자식 회수보다 먼저 반환하지 않는다")
            finally:
                process.finish()
                outcomes = await asyncio.wait_for(asyncio.gather(transfer_task, return_exceptions=True), 1)
            self.assertIsInstance(outcomes[0], asyncio.CancelledError)
            self.assertEqual(entered, [])
            self.assertEqual(monitor._pause_count, 0)
            self.assertIsNone(monitor._process)
            self.assertIsNone(monitor._reader_task)

    async def test_cancelled_stop_drains_inflight_spawn_and_monitor(self):
        process = ControlledProcess()
        spawning, release_spawn = asyncio.Event(), asyncio.Event()

        async def spawn(*_args, **_kwargs):
            spawning.set()
            await release_spawn.wait()
            return process

        async with self.running_monitor(process, spawn) as monitor:
            await asyncio.wait_for(spawning.wait(), 1)
            monitor_task = monitor._task
            stop_task = asyncio.create_task(monitor.stop())
            try:
                for _ in range(2):
                    await asyncio.sleep(.01)
                    stop_task.cancel()
                await asyncio.sleep(.01)
                self.assertFalse(stop_task.done(), "종료 요청 취소가 생성 중인 자식을 버리면 안 된다")
            finally:
                release_spawn.set()
                outcomes = await asyncio.wait_for(asyncio.gather(stop_task, return_exceptions=True), 1)
            self.assertIsInstance(outcomes[0], asyncio.CancelledError)
            self.assertEqual(process.returncode, 0)
            self.assertTrue(monitor_task.done())
            self.assertIsNone(monitor._task)
            self.assertIsNone(monitor._process)
            self.assertIsNone(monitor._reader_task)
            pending = [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
            self.assertEqual(pending, [])


if __name__ == "__main__":
    unittest.main()
