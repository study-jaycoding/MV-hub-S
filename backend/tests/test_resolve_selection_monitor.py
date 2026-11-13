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


_NO_JOB = mock.patch.object(resolve_selection_monitor, "_new_job", return_value=None)


def setUpModule():
    # 대역 프로세스에는 OS 프로세스가 없다 — 기본은 Job 없는 길로 본다. Job 길은 아래 JobReapTests(대역 Job)와 test_win_job(실제 프로세스)이 본다.
    _NO_JOB.start()


def tearDownModule():
    _NO_JOB.stop()


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

    async def test_a_worker_that_goes_silent_is_ended_while_one_that_only_beats_is_kept(self):
        """작업자가 기한 넘게 한 줄도 내지 않으면(= Resolve 호출에 멈춤 — 변경 문을 쥔 채) 부모가 끝낸다. 선택이 안 바뀌어 신호 줄만 내는
        작업자는 두고, 신호 줄은 선택으로 치지 않는다."""
        process = ControlledProcess()
        with (
            mock.patch.object(resolve_selection_monitor, "_WORKER_SILENT_SECONDS", 1.5),
            mock.patch.object(resolve_selection_monitor, "_RESTART_DELAYS", (0.01,)),
        ):
            async with self.running_monitor(process) as monitor:
                await asyncio.wait_for(process.stdout.reading.wait(), 1)
                revision = monitor._selection_revision
                watch = monitor._silence_task
                waited: list[int] = []
                real_wait = process.wait

                async def counted_wait():
                    waited.append(1)
                    return await real_wait()

                process.wait = counted_wait
                await asyncio.sleep(1.2)  # 아직 한 줄도 없다(처음 연결 중) — 기한은 뜬 때부터 센다
                self.assertFalse(process.terminated.is_set(), "막 뜬 작업자를 곧바로 끝내지 않는다")
                for _beat in range(6):  # 3초 동안 신호만 — 기한(1.5초)의 두 배
                    process.stdout.feed_data(b"MVHUB_RESOLVE_BEAT\n")
                    await asyncio.sleep(0.5)
                self.assertFalse(process.terminated.is_set(), "신호를 내는 작업자는 끝내지 않는다")
                self.assertEqual(monitor._selection_revision, revision, "신호 줄은 선택이 아니다")
                self.assertEqual(waited, [], "침묵 감시는 틱마다 직접 자식의 종료를 기다리지 않는다(취소된 기다림이 쌓이지 않는다)")
                await asyncio.wait_for(process.terminated.wait(), 5)  # 신호가 끊겼다
                await asyncio.wait_for(asyncio.shield(watch), 2)  # 침묵 감시가 회수를 끝까지 마쳤다(회수 도중 자기 자신을 취소하지 않는다)

    async def test_silence_is_noticed_even_while_the_loop_is_busy_mapping_an_earlier_selection(self):
        """감시 루프가 앞 선택의 DB·NAS 조회에 붙잡혀 있어도(그동안 작업자의 다음 Resolve 읽기가 문을 쥔 채 멈췄다) 침묵 감시는 따로 돌아 끝낸다."""
        import threading
        process = ControlledProcess()
        release = threading.Event()
        with (
            mock.patch.object(resolve_selection_monitor, "_WORKER_SILENT_SECONDS", 1.5),
            mock.patch.object(resolve_selection_monitor, "_RESTART_DELAYS", (0.01,)),
        ):
            async with self.running_monitor(process) as monitor:
                with mock.patch.object(monitor, "_resolve_selections", side_effect=lambda _payload: release.wait(20) and None) as mapping:
                    try:
                        await asyncio.wait_for(process.stdout.reading.wait(), 1)
                        process.stdout.feed_data(selection_line("baseline"))
                        process.stdout.feed_data(selection_line("a"))
                        await asyncio.wait_for(process.terminated.wait(), 6)
                        mapping.assert_called_once()  # 조회는 아직 안 끝났다 — 루프는 그 안에 있다
                    finally:
                        release.set()

    async def test_silence_reap_works_after_only_the_launcher_exited_and_restart_waits_for_the_backoff(self):
        await self._silence_reap_then_restart(mapping_fails=False)

    async def test_silence_reap_followed_by_a_failed_mapping_still_backs_off_only_once(self):
        """침묵 회수 뒤 그 조회가 오류로 끝나도 백오프는 한 번이다 — 오류 분기의 백오프와 침묵 표시의 백오프를 겹쳐 쉬지 않는다(겹치면 1초 + 5초)."""
        await self._silence_reap_then_restart(mapping_fails=True)

    async def _silence_reap_then_restart(self, mapping_fails: bool):
        """직접 자식(실행기)만 끝나고 진짜 작업자는 남아 멈춘 경우 — 감시 루프가 앞 선택의 조회에 묶여 있어도 침묵 감시가 끝낸다(직접 자식의
        종료로 물러나지 않는다). 그렇게 끝낸 뒤에는 루프가 돌아와도 곧바로 다시 띄우지 않고 백오프를 한 번 한 뒤 띄운다."""
        import threading
        process = ControlledProcess()
        release = threading.Event()

        def blocked(_payload):
            release.wait(20)
            if mapping_fails:
                raise OSError("nas gone")

        with (
            mock.patch.object(resolve_selection_monitor, "_WORKER_SILENT_SECONDS", 1.5),
            mock.patch.object(resolve_selection_monitor, "_RESTART_DELAYS", (1.0, 5.0)),
        ):
            async with self.running_monitor(process) as monitor:
                spawn = resolve_selection_monitor.asyncio.create_subprocess_exec
                with mock.patch.object(monitor, "_resolve_selections", side_effect=blocked) as mapping:
                    try:
                        await asyncio.wait_for(process.stdout.reading.wait(), 1)
                        process.stdout.feed_data(selection_line("baseline"))
                        process.stdout.feed_data(selection_line("a"))
                        for _ in range(100):  # 루프가 조회에 들어갈 때까지
                            if mapping.called:
                                break
                            await asyncio.sleep(0.02)
                        process.returncode = 0  # 실행기만 끝났다 — stdout 은 아직 열려 있다(진짜 작업자가 쥐고 있다)
                        process.exited.set()
                        for _ in range(250):  # 침묵 감시가 회수에 들어갈 때까지(최대 5초)
                            if monitor._process is None:
                                break
                            await asyncio.sleep(0.02)
                        self.assertIsNone(monitor._process, "루프가 묶여 있어도, 직접 자식이 이미 끝났어도 침묵 감시가 회수한다")
                        self.assertEqual(spawn.call_count, 1)
                    finally:
                        process.stdout.feed_eof()  # 트리가 끝났다(단언이 실패해도 닫는다 — 뒷정리가 EOF 를 기다리며 멈추지 않게)
                        release.set()
                    await asyncio.sleep(0.4)
                    self.assertEqual(spawn.call_count, 1, "돌아온 루프가 곧바로 다시 띄우지 않는다(백오프 1초)")
                    for _ in range(150):
                        if spawn.call_count >= 2:
                            break
                        await asyncio.sleep(0.02)
                    self.assertGreaterEqual(spawn.call_count, 2, "백오프 한 번(1초) 뒤에는 다시 띄운다 — 두 번 쉬지 않는다")

    async def test_silence_watch_leaves_a_worker_that_was_replaced_while_it_waited_for_the_lock(self):
        """침묵 감시는 자기가 지키던 작업자만 끝낸다 — 잠금을 기다리는 사이 작업자가 바뀌었으면 새 작업자에 손대지 않는다."""
        monitor = ResolveSelectionMonitor()
        old, new = ControlledProcess(), ControlledProcess()
        monitor._process, monitor._last_output = old, 0.0
        with mock.patch.object(resolve_selection_monitor, "_WORKER_SILENT_SECONDS", 0.2):
            await monitor._process_lock.acquire()
            watch = asyncio.create_task(monitor._watch_silence(old))
            await asyncio.sleep(0.3)  # 침묵을 보고 잠금을 기다린다
            monitor._process = new
            monitor._process_lock.release()
            await asyncio.wait_for(watch, 2)
        self.assertIs(monitor._process, new)
        self.assertFalse(new.terminated.is_set() or old.terminated.is_set())

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


class FakeJob:
    """win_job.ProcessJob 대역 — 남은 프로세스 수를 시험이 정한다."""

    def __init__(self):
        self.alive = 1
        self.adopted: list[int] = []
        self.terminated = 0
        self.closed = 0
        self.die_on_terminate = True
        self.fail_adopt: BaseException | None = None
        self.fail_active: BaseException | None = None

    def adopt_suspended(self, pid):
        if self.fail_adopt:
            raise self.fail_adopt
        self.adopted.append(pid)

    def active(self):
        if self.fail_active:
            raise self.fail_active
        return self.alive

    def terminate(self):
        self.terminated += 1
        if self.die_on_terminate:
            self.alive = 0

    def close(self):
        self.closed += 1


class JobReapTests(unittest.IsolatedAsyncioTestCase):
    """Job 이 자식 트리를 소유할 때의 회수 — 종료는 Job 에 묻고, 직접 자식의 returncode·stdout 에 기대지 않는다."""

    def setUp(self):
        self.job = FakeJob()
        self.process = ControlledProcess()
        self.process.pid = 4242
        self.process.stdin = FakeStdin()
        self.spawn = mock.AsyncMock(return_value=self.process)
        self.monitor = ResolveSelectionMonitor()
        patches = (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=self.spawn),
            mock.patch.object(resolve_selection_monitor, "_new_job", return_value=self.job),
            mock.patch.object(resolve_selection_monitor, "_SELF_EXIT_SECONDS", 0.1),
            mock.patch.object(resolve_selection_monitor, "_REAP_SECONDS", 0.4),
            mock.patch.object(resolve_selection_monitor, "_REAP_POLL_SECONDS", 0.01),
        )
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def enter_suspended(self) -> list[bool]:
        entered: list[bool] = []
        async with self.monitor.suspended():
            entered.append(True)
        return entered

    async def test_child_is_created_suspended_then_adopted_into_the_job(self):
        await self.monitor._start_process()
        flags = self.spawn.call_args.kwargs["creationflags"]
        self.assertTrue(flags & resolve_selection_monitor.CREATE_SUSPENDED, "멈춘 채 만들어야 후손이 Job 밖에 남지 않는다")
        self.assertEqual(self.job.adopted, [4242])
        self.assertIs(getattr(self.process, resolve_selection_monitor._JOB_ATTR), self.job)

    async def test_adopt_failure_kills_the_still_suspended_child_and_raises(self):
        self.job.fail_adopt = OSError("assign failed")
        self.job.alive = 0  # 넣기 실패 — 자식은 Job 밖에 있다
        with self.assertRaises(OSError):
            await self.monitor._start_process()
        self.assertEqual(self.process.returncode, 0)  # kill 됨(대역의 kill = 종료) — 끝난 것을 기다려 확인한 뒤 올린다
        self.assertTrue(self.process.exited.is_set())
        self.assertEqual(self.job.closed, 1)
        self.assertIsNone(self.monitor._process)
        self.assertIsNone(self.monitor._unconfirmed)

    async def test_job_creation_failure_on_windows_spawns_nothing_and_can_retry(self):
        """Job 을 못 만들면 자식을 띄우지 않는다(Job 없는 길로 내려가지 않는다) — 잠금은 풀리고 다음 시도는 다시 할 수 있다."""
        with mock.patch.object(resolve_selection_monitor, "_new_job", side_effect=OSError("CreateJobObject failed")):
            with self.assertRaises(OSError):
                await self.monitor._start_process()
        self.assertEqual(self.spawn.await_count, 0)
        self.assertFalse(self.monitor._process_lock.locked())
        self.assertIsNone(self.monitor._process)
        await self.monitor._start_process()  # 다음 시도(Job 을 만들 수 있게 된 뒤)
        self.assertEqual(self.spawn.await_count, 1)
        self.assertEqual(self.job.adopted, [4242])

    async def test_spawn_failure_closes_the_empty_job(self):
        self.spawn.side_effect = OSError("spawn failed")
        with self.assertRaises(OSError):
            await self.monitor._start_process()
        self.assertEqual(self.job.closed, 1)

    async def test_resume_failure_inside_the_job_is_reaped_through_the_job(self):
        """풀기 실패 — 자식은 Job 안에서 멈춘 채다. Job 회수 길(통째 종료 → 남은 수 0 확인)로 끝내고, 직접 kill 에 기대지 않는다."""
        self.job.fail_adopt = OSError("resume failed")  # Job 에는 들어갔다(alive = 1)
        original = self.job.terminate
        self.job.terminate = lambda: (original(), self.process.finish())[0]
        with self.assertRaises(OSError):
            await self.monitor._start_process()
        self.assertEqual((self.job.terminated, self.job.closed), (1, 1))
        self.assertIsNone(self.monitor._unconfirmed)
        self.assertIsNone(self.monitor._process)

    async def test_resume_failure_inside_the_job_that_does_not_die_is_kept_with_its_job_and_asked_once_later(self):
        self.job.fail_adopt = OSError("resume failed")
        self.job.die_on_terminate = False
        with self.assertRaises(OSError):
            await self.monitor._start_process()
        self.assertIs(self.monitor._unconfirmed, self.process)
        self.assertIs(getattr(self.process, resolve_selection_monitor._JOB_ATTR), self.job, "Job 을 붙인 채 붙든다 — 다음 확인도 Job 에 묻는다")
        self.assertEqual(self.job.closed, 0)
        loop = asyncio.get_running_loop()
        began = loop.time()
        with self.assertRaises(TimeoutError):
            await self.enter_suspended()  # 두 번째 회수 — 기한만큼 또 기다리지 않는다
        self.assertLess(loop.time() - began, 0.2)
        self.job.alive = 0
        self.process.finish()
        self.assertEqual(await self.enter_suspended(), [True])
        self.assertIsNone(self.monitor._unconfirmed)

    async def test_adopt_failure_with_a_child_that_does_not_die_in_time_keeps_it_and_later_checks_never_wait_unbounded(self):
        """넣기 실패 뒤 끝내라고 했는데 기한 안에 끝난 것이 확인되지 않으면 그 자식을 붙든다 — kill 자체가 실패해도 Job 은 닫는다.
        그 뒤의 회수(suspended·stop)는 기다리지 않고 한 번만 보고 실패한다(Job 없는 길의 기한 없는 대기로 가지 않는다). 끝나면 회복한다."""
        for kill in (lambda: None, mock.Mock(side_effect=OSError("access denied"))):
            with self.subTest(kill=kill):
                job = FakeJob()
                job.fail_adopt = OSError("assign failed")
                job.alive = 0  # Job 밖
                process = ControlledProcess()
                process.pid = 4343
                process.stdin = FakeStdin()
                process.kill = kill  # 끝내라는 요청이 듣지 않는다
                monitor = ResolveSelectionMonitor()
                with (
                    mock.patch.object(resolve_selection_monitor, "_new_job", return_value=job),
                    mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=mock.AsyncMock(return_value=process)),
                    mock.patch.object(resolve_selection_monitor, "_DISCARD_SECONDS", 0.1),
                ):
                    with self.assertRaises(OSError):
                        await monitor._start_process()
                    self.assertIs(monitor._unconfirmed, process)
                    self.assertEqual(job.closed, 1)
                    self.assertFalse(monitor._process_lock.locked())
                    await monitor._start_process()  # 종료 미확인 — 새 자식 0
                    self.assertIsNone(monitor._process)
                    loop = asyncio.get_running_loop()
                    for again in ("suspended", "stop"):
                        began = loop.time()
                        with self.subTest(again=again), self.assertRaises(TimeoutError):
                            if again == "suspended":
                                async with monitor.suspended():
                                    self.fail("종료 미확인인데 본문에 들어갔다")
                            else:
                                await monitor.stop()
                        self.assertLess(loop.time() - began, 0.5, "기다리지 않고 한 번만 본다")
                        self.assertIs(monitor._unconfirmed, process)
                    process.finish()  # 나중에 실제로 끝났다
                    async with monitor.suspended():
                        pass
                    self.assertIsNone(monitor._unconfirmed)

    async def test_self_exit_after_stdin_close_needs_no_job_terminate(self):
        await self.monitor._start_process()

        def exits_a_little_later():
            asyncio.get_running_loop().call_later(0.03, lambda: (setattr(self.job, "alive", 0), self.process.finish()))

        self.process.stdin.on_close = exits_a_little_later  # stdin 이 닫힌 뒤 조금 있다 스스로 끝난다(유예 안)
        self.assertEqual(await self.enter_suspended(), [True])
        self.assertEqual(self.process.stdin.closed, 1)
        self.assertEqual(self.job.terminated, 0, "유예 안에 스스로 끝난 트리를 강제로 끝내지 않는다")
        self.assertEqual(self.job.closed, 1)

    async def test_stuck_tree_is_terminated_as_a_whole_without_trusting_returncode_or_stdout(self):
        await self.monitor._start_process()
        # 직접 자식(실행기)은 끝난 것처럼 보이고 stdout 은 읽기 오류 — 그래도 Job 에 프로세스가 남아 있으면 끝난 것이 아니다
        self.process.returncode = 0
        self.process.exited.set()
        self.process.stdout.set_exception(OSError("pipe read failed"))
        self.assertEqual(await self.enter_suspended(), [True])
        self.assertEqual(self.job.terminated, 1)
        self.assertFalse(self.process.terminated.is_set(), "직접 자식만 끝내는 terminate 를 쓰지 않는다")
        self.assertIsNone(self.monitor._unconfirmed)

    async def test_deadline_without_confirmation_fails_keeps_child_releases_lock_and_recovers_later(self):
        await self.monitor._start_process()
        self.job.die_on_terminate = False  # 끝내라고 했는데도 남아 있다
        started = asyncio.get_running_loop().time()
        with self.assertRaises(TimeoutError):
            await self.enter_suspended()
        self.assertLess(asyncio.get_running_loop().time() - started, 2.0, "기한 안에 명시적 실패로 끝난다")
        self.assertIs(self.monitor._unconfirmed, self.process)
        self.assertFalse(self.monitor._process_lock.locked(), "실패해도 잠금을 쥔 채 남지 않는다")
        self.assertEqual(self.monitor._pause_count, 0)
        await self.monitor._start_process()  # 종료 미확인 — 새 자식 0
        self.assertEqual(self.spawn.await_count, 1)
        self.job.alive = 0  # 나중에 실제로 끝났다 — 다음 회수가 다시 물어 회복한다
        self.assertEqual(await self.enter_suspended(), [True])
        self.assertIsNone(self.monitor._unconfirmed)
        self.assertEqual(self.job.closed, 1)

    async def test_after_a_timeout_later_checks_ask_once_without_waiting_and_the_loop_logs_once(self):
        await self.monitor._start_process()
        self.job.die_on_terminate = False
        with self.assertRaises(TimeoutError):
            await self.enter_suspended()
        loop = asyncio.get_running_loop()
        began = loop.time()
        with self.assertRaises(TimeoutError):
            await self.enter_suspended()  # 다시 온 Resolve 변경 요청 — 기한만큼 또 기다리지 않는다
        self.assertLess(loop.time() - began, 0.2)
        self.assertEqual(self.job.terminated, 1, "통째 종료를 다시 보내지 않는다")
        with (
            mock.patch.object(resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})),
            mock.patch.object(resolve_selection_monitor, "_RESTART_DELAYS", (0.01,)),
            self.assertLogs("mvhub.resolve_selection", level="ERROR") as logs,
        ):
            self.monitor.start()
            await asyncio.sleep(0.3)  # 감시 루프가 여러 바퀴 다시 묻는다
            self.assertFalse(self.monitor._task.done())
            self.assertEqual(self.spawn.await_count, 1)
        self.assertEqual(sum("종료를 확인하지 못했습니다" in line for line in logs.output), 1, "같은 자식의 오류는 한 번만 남긴다")
        self.job.alive = 0  # 끝났다 — 루프의 다음 물음이 회복한다
        self.monitor._stopping = True
        await self.monitor.stop()
        self.assertIsNone(self.monitor._unconfirmed)

    async def test_job_query_failure_is_not_exit_proof(self):
        await self.monitor._start_process()
        self.job.fail_active = OSError("query failed")
        with self.assertRaises(OSError):
            await self.enter_suspended()
        self.assertIs(self.monitor._unconfirmed, self.process)
        self.assertEqual(self.job.closed, 0)

    async def test_just_spawned_unregistered_child_is_reaped_through_its_job_too(self):
        release = asyncio.Event()
        spawned = asyncio.Event()

        async def slow_spawn(*_args, **_kwargs):
            spawned.set()
            await release.wait()
            return self.process

        self.spawn.side_effect = slow_spawn
        self.job.die_on_terminate = False
        starting = asyncio.create_task(self.monitor._start_process())
        await asyncio.wait_for(spawned.wait(), 2)
        suspending = asyncio.create_task(self.enter_suspended())
        await asyncio.sleep(0.02)
        release.set()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(starting, 3)
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(suspending, 3)
        self.assertIs(self.monitor._unconfirmed, self.process)
        self.assertEqual(self.job.adopted, [4242])


class FakeStdin:
    def __init__(self, on_close=None):
        self.closed = 0
        self.on_close = on_close

    def close(self):
        self.closed += 1
        if self.on_close:
            self.on_close()


class ParentStdinCloseTests(unittest.IsolatedAsyncioTestCase):
    """자식 회수 순서 — stdin 닫기(자식이 스스로 끝남) → 짧게 기다림 → 안 끝나면 terminate."""

    async def test_child_gets_stdin_pipe_and_exit_on_close_needs_no_terminate(self):
        process = ControlledProcess()
        process.stdin = FakeStdin(process.finish)
        spawn = mock.AsyncMock(return_value=process)
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=spawn),
        ):
            await monitor._start_process()
            self.assertIs(spawn.call_args.kwargs["stdin"], asyncio.subprocess.PIPE)
            await asyncio.wait_for(monitor._stop_process(), 2)
        self.assertEqual(process.stdin.closed, 1)
        self.assertFalse(process.terminated.is_set(), "스스로 끝난 자식에 terminate 를 보낼 필요가 없다")
        self.assertEqual(process.returncode, 0)

    async def test_child_that_exits_a_moment_after_stdin_close_is_given_the_grace_and_not_terminated(self):
        """Job 없는 길 — stdin 이 닫힌 뒤 조금 있다 스스로 끝나는 자식은 유예(0.5초) 안에 끝나므로 terminate 를 보내지 않는다."""
        process = ControlledProcess()
        process.stdin = FakeStdin(lambda: asyncio.get_running_loop().call_later(0.05, process.finish))
        await asyncio.wait_for(ResolveSelectionMonitor._terminate_process(process), 2)
        self.assertFalse(process.terminated.is_set())
        self.assertEqual(process.returncode, 0)

    async def test_child_that_ignores_terminate_is_killed_after_the_wait(self):
        """Job 없는 길 — terminate 를 보내도 2초 안에 안 끝나면 kill 로 끝내고 돌아온다."""
        process = ControlledProcess()
        process.exit_on_terminate = False  # terminate 무시 — kill(대역에서는 종료)만 듣는다
        await asyncio.wait_for(ResolveSelectionMonitor._terminate_process(process), 5)
        self.assertTrue(process.terminated.is_set())
        self.assertEqual(process.returncode, 0)

    async def test_child_stuck_after_stdin_close_is_terminated_and_awaited(self):
        process = ControlledProcess()
        process.stdin = FakeStdin()
        process.exit_on_terminate = False
        task = asyncio.create_task(ResolveSelectionMonitor._terminate_process(process))
        await asyncio.wait_for(process.terminated.wait(), 2)
        self.assertEqual(process.stdin.closed, 1)
        await asyncio.sleep(0.02)
        self.assertFalse(task.done(), "terminate 만 보내고 종료를 기다리지 않으면 안 된다")
        process.finish()
        await asyncio.wait_for(task, 2)

    async def test_launcher_exit_alone_is_not_enough_waits_until_worker_pipe_closes(self):
        """실행기는 이미 끝났지만(returncode 있음) 진짜 작업자가 아직 살아 stdout 파이프를 쥐고 있다 — stdin 을 닫고, 파이프가 닫힐 때까지 돌아가지 않는다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        process.returncode = 0  # 실행기만 끝남 — stdout 은 아직 열려 있다(작업자 생존)
        task = asyncio.create_task(ResolveSelectionMonitor._terminate_process(process))
        await asyncio.sleep(0.05)
        self.assertEqual(process.stdin.closed, 1)
        self.assertFalse(task.done(), "실행기 종료만 보고 돌아가면 안 된다")
        process.stdout.feed_data(b"late line\n")  # 끝나기 전 남긴 출력은 버린다
        await asyncio.sleep(0.02)
        self.assertFalse(task.done())
        process.stdout.feed_eof()  # 작업자가 EOF 를 보고 끝남 → 파이프 닫힘
        await asyncio.wait_for(task, 2)
        self.assertFalse(process.terminated.is_set())

    async def test_stdout_read_failure_is_not_exit_proof_suspend_refuses_and_no_new_worker(self):
        """실행기는 끝났고 작업자는 살아 있을 수 있는데 stdout 읽기가 실패한다 — EOF 가 아니므로 회수는 실패로 올라가고, 본문에 들어가지 않고, 자식을 잊지 않고, 새로 띄우지 않는다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        spawn = mock.AsyncMock(return_value=process)
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=spawn),
            mock.patch.object(resolve_selection_monitor.manager, "stats", new=mock.AsyncMock(return_value={"connections": 1})),
            mock.patch.object(resolve_selection_monitor, "_RESTART_DELAYS", (0.01,)),
            self.assertLogs("mvhub.resolve_selection", level="ERROR"),
        ):
            await monitor._start_process()
            process.returncode = 0  # 실행기만 끝남
            process.exited.set()
            process.stdout.set_exception(OSError("pipe read failed"))
            entered = []
            with self.assertRaises(OSError):
                async with monitor.suspended():
                    entered.append(True)
            self.assertEqual(entered, [])
            self.assertIs(monitor._unconfirmed, process)
            self.assertEqual(monitor._pause_count, 0)
            # 감시 루프는 죽지 않고 다시 확인만 한다 — 확인될 때까지 새 자식 0
            monitor.start()
            await asyncio.sleep(0.1)
            self.assertFalse(monitor._task.done())
            self.assertEqual(spawn.await_count, 1)
            self.assertIs(monitor._unconfirmed, process)
            task = monitor._task
            with self.assertRaises(OSError):
                await monitor.stop()
            self.assertIs(monitor._unconfirmed, process)
            self.assertTrue(task.done(), "회수가 실패로 끝나도 감시 태스크는 거둔다")
            self.assertIsNone(monitor._task)

    async def test_read_failure_while_reaping_a_just_spawned_unregistered_child_is_kept_too(self):
        """생성은 끝났지만 등록 전에 suspend 가 들어와 직접 회수하는 경로 — 그 회수가 stdout 읽기 실패로 끝나도 자식을 붙들고, 본문에 안 들어가고, 더 띄우지 않는다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        process.returncode = 0  # 실행기는 바로 끝남(작업자는 살아 있을 수 있다)
        process.stdout.set_exception(OSError("pipe read failed"))
        release = asyncio.Event()
        spawned = asyncio.Event()

        async def spawn(*_args, **_kwargs):
            spawned.set()
            await release.wait()
            return process

        create = mock.AsyncMock(side_effect=spawn)
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=create),
        ):
            starting = asyncio.create_task(monitor._start_process())
            await asyncio.wait_for(spawned.wait(), 2)
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(True)

            suspending = asyncio.create_task(transfer())
            await asyncio.sleep(0.02)  # suspend 가 멈춤 표시를 올리고 잠금을 기다린다
            release.set()
            with self.assertRaises(OSError):
                await asyncio.wait_for(starting, 2)
            with self.assertRaises(OSError):
                await asyncio.wait_for(suspending, 2)
            self.assertEqual(entered, [])
            self.assertIs(monitor._unconfirmed, process)
            self.assertIsNone(monitor._process)
            await monitor._start_process()  # 재확인 실패 중 — 새 자식 0
            self.assertEqual(create.await_count, 1)

    async def test_unobservable_stdout_is_not_exit_proof_either(self):
        """stdout 을 아예 볼 수 없으면(None) 종료를 확인할 길이 없다 — 회수는 실패로 올라가고 자식을 붙든다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=mock.AsyncMock(return_value=process)),
        ):
            await monitor._start_process()
            process.finish()  # 실행기 종료
            await asyncio.sleep(0)
            process.stdout = None
            entered = []
            with self.assertRaises(RuntimeError):
                async with monitor.suspended():
                    entered.append(True)
            self.assertEqual(entered, [])
            self.assertIs(monitor._unconfirmed, process)
            self.assertEqual(monitor._pause_count, 0)

    async def test_stop_raises_the_reap_error_even_when_the_monitor_task_failed_too(self):
        """회수 오류와 감시 태스크 오류가 함께 나면 회수 오류를 올리고, 태스크 오류는 기록만, 태스크 참조는 비운다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        process.returncode = 0
        process.stdout.set_exception(OSError("pipe read failed"))
        monitor = ResolveSelectionMonitor()
        monitor._process = process

        async def broken():
            raise ValueError("monitor loop crashed")

        monitor._task = asyncio.create_task(broken())
        await asyncio.sleep(0)
        with self.assertLogs("mvhub.resolve_selection", level="ERROR") as logs, self.assertRaises(OSError):
            await monitor.stop()
        self.assertTrue(any("감시 태스크가 오류로" in line for line in logs.output))
        self.assertIsNone(monitor._task)
        self.assertIs(monitor._unconfirmed, process)

    async def test_stop_swallows_a_monitor_task_error_when_reap_succeeded(self):
        monitor = ResolveSelectionMonitor()

        async def broken():
            raise ValueError("monitor loop crashed")

        monitor._task = asyncio.create_task(broken())
        await asyncio.sleep(0)
        with self.assertLogs("mvhub.resolve_selection", level="ERROR"):
            await monitor.stop()  # 회수할 자식이 없다 — 태스크 오류만으로 종료를 실패시키지 않는다
        self.assertIsNone(monitor._task)

    async def test_suspend_body_waits_for_worker_pipe_after_launcher_exit(self):
        """suspended 본문은 실행기가 끝난 뒤에도 작업자 파이프가 닫히기 전에는 시작하지 않는다."""
        process = ControlledProcess()
        process.stdin = FakeStdin()
        process.exit_on_terminate = False
        monitor = ResolveSelectionMonitor()
        with (
            mock.patch.object(resolve_selection_monitor, "resolve_compatible_interpreter", return_value=("fake-python", None)),
            mock.patch.object(resolve_selection_monitor.asyncio, "create_subprocess_exec", new=mock.AsyncMock(return_value=process)),
        ):
            await monitor._start_process()
            entered = []

            async def transfer():
                async with monitor.suspended():
                    entered.append(True)

            task = asyncio.create_task(transfer())
            await asyncio.wait_for(process.terminated.wait(), 2)  # 0.5초 유예 뒤 terminate
            process.returncode = 0  # 실행기 종료(작업자는 아직)
            process.exited.set()
            await asyncio.sleep(0.05)
            self.assertEqual(entered, [], "작업자 종료 확인 전에 Resolve 변경을 시작하면 안 된다")
            process.stdout.feed_eof()
            await asyncio.wait_for(task, 2)
            self.assertEqual(entered, [True])


if __name__ == "__main__":
    unittest.main()
