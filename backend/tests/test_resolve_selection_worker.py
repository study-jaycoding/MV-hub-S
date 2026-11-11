"""Resolve 선택 자식 — UI 없이 최소 식별 정보만 읽는 계약."""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from app.services import resolve_selection_worker
from app.services.resolve_bridge import MVHUB_METADATA_KEY, mvhub_clip_metadata
from app.services.resolve_selection_worker import selected_snapshot


class FakeClip:
    def __init__(self, media_id: str, path: str, metadata: str = "") -> None:
        self.media_id = media_id
        self.path = path
        self.metadata = metadata
        self.media_id_calls = 0
        self.file_path_calls = 0
        self.metadata_calls = 0

    def GetMediaId(self):
        self.media_id_calls += 1
        return self.media_id

    def GetClipProperty(self, key=None):
        self.file_path_calls += 1
        values = {"File Path": self.path}
        return values.get(key, "") if key else values

    def GetThirdPartyMetadata(self, key=None):
        self.metadata_calls += 1
        return self.metadata if key == MVHUB_METADATA_KEY else ""


class FakeMediaPool:
    def __init__(self, clips):
        self.clips = clips

    def GetSelectedClips(self):
        return self.clips


class FakeProject:
    def __init__(self, clips):
        self.pool = FakeMediaPool(clips)
        self.unique_id = "resolve-project"

    def GetMediaPool(self):
        return self.pool

    def GetUniqueId(self):
        return self.unique_id


class FakeManager:
    def __init__(self, project):
        self.project = project

    def GetCurrentProject(self):
        return self.project


class FakeResolve:
    def __init__(self, clips):
        self.manager = FakeManager(FakeProject(clips))

    def GetProjectManager(self):
        return self.manager


class DisconnectedResolve:
    def GetProjectManager(self):
        return None


class ResolveSelectionWorkerTests(unittest.TestCase):
    def test_one_selected_clip_includes_mvhub_metadata(self):
        clip = FakeClip(
            "media-1",
            r"D:\\render\\clip.mp4",
            mvhub_clip_metadata("generation-1", "project-1"),
        )

        fingerprint, payload = selected_snapshot(FakeResolve([clip]))

        self.assertEqual(fingerprint, ("resolve-project", "1", "media-1"))
        self.assertEqual(payload["generation_id"], "generation-1")
        self.assertEqual(payload["project_id"], "project-1")
        self.assertEqual(payload["file_path"], clip.path)

    def test_empty_selection_clears_and_multiple_selection_includes_each_clip(self):
        _fingerprint, empty = selected_snapshot(FakeResolve([]))
        _fingerprint, multiple = selected_snapshot(
            FakeResolve([FakeClip("a", "a.mp4"), FakeClip("b", "b.mp4")])
        )

        self.assertEqual(empty, {"selected_count": 0, "selections": []})
        self.assertEqual(multiple["selected_count"], 2)
        self.assertEqual([item["media_id"] for item in multiple["selections"]], ["a", "b"])

    def test_missing_project_manager_is_distinguished_from_no_selection(self):
        fingerprint, payload = selected_snapshot(DisconnectedResolve())

        self.assertEqual(fingerprint, ("no_manager",))
        self.assertEqual(payload["connection_state"], "no_manager")

    def test_first_snapshot_reads_each_clip_api_once(self):
        clip = FakeClip("media-1", "clip.mp4")

        _fingerprint, payload = selected_snapshot(FakeResolve([clip]))

        self.assertEqual(payload["media_id"], "media-1")
        self.assertEqual(payload["resolve_project_id"], "resolve-project")
        self.assertEqual(clip.media_id_calls, 1)
        self.assertEqual(clip.file_path_calls, 1)
        self.assertEqual(clip.metadata_calls, 1)

    def test_unchanged_selection_does_not_read_clip_details_again(self):
        clip = FakeClip("media-1", "clip.mp4")
        resolve = FakeResolve([clip])
        previous, _payload = selected_snapshot(resolve)

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertEqual(fingerprint, previous)
        self.assertEqual(payload, {"selected_count": 1})
        self.assertEqual(clip.media_id_calls, 2)
        self.assertEqual(clip.file_path_calls, 1)
        self.assertEqual(clip.metadata_calls, 1)

    def test_changed_clip_returns_fresh_details(self):
        original = FakeClip("media-1", "original.mp4")
        selected = FakeClip(
            "media-2", "selected.mp4", mvhub_clip_metadata("generation-2", "project-2")
        )
        resolve = FakeResolve([original])
        previous, _payload = selected_snapshot(resolve)
        resolve.manager.project.pool.clips = [selected]

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertNotEqual(fingerprint, previous)
        self.assertEqual(payload["generation_id"], "generation-2")
        self.assertEqual(payload["project_id"], "project-2")
        self.assertEqual(payload["file_path"], "selected.mp4")
        self.assertEqual(selected.media_id_calls, 1)
        self.assertEqual(selected.file_path_calls, 1)
        self.assertEqual(selected.metadata_calls, 1)

    def test_missing_media_id_compares_path_but_skips_unchanged_metadata(self):
        clip = FakeClip(
            "", "clip.mp4", mvhub_clip_metadata("generation-1", "project-1")
        )
        resolve = FakeResolve([clip])
        previous, first_payload = selected_snapshot(resolve)

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertEqual(previous, ("resolve-project", "1", "clip.mp4"))
        self.assertEqual(fingerprint, previous)
        self.assertEqual(first_payload["generation_id"], "generation-1")
        self.assertEqual(first_payload["media_id"], "")
        self.assertEqual(payload, {"selected_count": 1})
        self.assertEqual(clip.media_id_calls, 2)
        self.assertEqual(clip.file_path_calls, 2)
        self.assertEqual(clip.metadata_calls, 1)

    def test_changed_fallback_path_refreshes_metadata(self):
        clip = FakeClip("", "original.mp4")
        resolve = FakeResolve([clip])
        previous, _payload = selected_snapshot(resolve)
        clip.path = "selected.mp4"
        clip.metadata = mvhub_clip_metadata("generation-2", "project-2")

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertEqual(fingerprint, ("resolve-project", "1", "selected.mp4"))
        self.assertEqual(payload["file_path"], "selected.mp4")
        self.assertEqual(payload["generation_id"], "generation-2")
        self.assertEqual(clip.file_path_calls, 2)
        self.assertEqual(clip.metadata_calls, 2)

    def test_unavailable_media_id_api_keeps_path_fallback(self):
        for getter in (None, mock.Mock(side_effect=RuntimeError("unsupported"))):
            with self.subTest(getter_available=callable(getter)):
                clip = FakeClip("", "clip.mp4")
                resolve = FakeResolve([clip])
                with mock.patch.object(clip, "GetMediaId", getter):
                    previous, first_payload = selected_snapshot(resolve)
                    fingerprint, payload = selected_snapshot(
                        resolve, previous=previous
                    )

                self.assertEqual(previous, ("resolve-project", "1", "clip.mp4"))
                self.assertEqual(fingerprint, previous)
                self.assertEqual(first_payload["file_path"], "clip.mp4")
                self.assertEqual(payload, {"selected_count": 1})
                self.assertEqual(clip.file_path_calls, 2)
                self.assertEqual(clip.metadata_calls, 1)
                if getter is not None:
                    self.assertEqual(getter.call_count, 2)

    def test_project_change_refreshes_details_for_same_media_id(self):
        clip = FakeClip("media-1", "clip.mp4")
        resolve = FakeResolve([clip])
        previous, _payload = selected_snapshot(resolve)
        resolve.manager.project.unique_id = "another-resolve-project"
        clip.metadata = mvhub_clip_metadata("generation-2", "project-2")

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertEqual(fingerprint, ("another-resolve-project", "1", "media-1"))
        self.assertEqual(payload["resolve_project_id"], "another-resolve-project")
        self.assertEqual(payload["generation_id"], "generation-2")
        self.assertEqual(clip.media_id_calls, 2)
        self.assertEqual(clip.file_path_calls, 2)
        self.assertEqual(clip.metadata_calls, 2)

    def test_multiple_selection_order_does_not_change_fingerprint(self):
        clips = [FakeClip("b", "b.mp4"), FakeClip("a", "a.mp4")]
        resolve = FakeResolve(clips)
        previous, _payload = selected_snapshot(resolve)
        resolve.manager.project.pool.clips = list(reversed(clips))

        fingerprint, payload = selected_snapshot(resolve, previous=previous)

        self.assertEqual(previous, ("resolve-project", "2", "a", "b"))
        self.assertEqual(fingerprint, previous)
        self.assertEqual(payload, {"selected_count": 2})
        for clip in clips:
            self.assertEqual(clip.media_id_calls, 2)
            self.assertEqual(clip.file_path_calls, 1)
            self.assertEqual(clip.metadata_calls, 1)

    def test_multiple_selection_metadata_count_changes_and_detail_reuse(self):
        clips = [FakeClip(str(i), f"{i}.mp4", mvhub_clip_metadata(f"g-{i}", "p")) for i in range(200)]
        resolve = FakeResolve(clips)
        before, payload = selected_snapshot(resolve)
        after, unchanged = selected_snapshot(resolve, previous=before)
        self.assertEqual(after, before)
        self.assertEqual(len(payload["selections"]), 200)
        self.assertEqual(payload["selections"][0]["generation_id"], "g-0")
        self.assertEqual(unchanged, {"selected_count": 200})
        self.assertTrue(all(c.metadata_calls == 1 and c.file_path_calls == 1 for c in clips))
        resolve.manager.project.pool.clips = []
        empty_fingerprint, empty = selected_snapshot(resolve, previous=before)
        self.assertNotEqual(empty_fingerprint, before)
        self.assertEqual(empty, {"selected_count": 0, "selections": []})

    def test_large_selection_is_explicitly_truncated_before_clip_queries(self):
        clips = [FakeClip(str(i), f"{i}.mp4") for i in range(205)]
        _fingerprint, payload = selected_snapshot(FakeResolve(clips))
        self.assertEqual(payload["selected_count"], 205)
        self.assertEqual(len(payload["selections"]), 200)
        self.assertTrue(payload["truncated"])
        self.assertEqual(clips[-1].media_id_calls, 0)

    def test_long_unicode_paths_cannot_overflow_reader_line_limit(self):
        payload = {"selected_count": 200, "selections": [{"file_path": "한" * 3000}] * 200}
        line = resolve_selection_worker.serialize_selection(payload)
        self.assertLessEqual(len(line.encode("utf-8")), resolve_selection_worker.MAX_LINE_BYTES)
        bounded = json.loads(line.removeprefix(resolve_selection_worker.RESULT_PREFIX))
        self.assertEqual(bounded["selected_count"], 200)
        self.assertTrue(bounded["truncated"])
        self.assertLess(len(bounded["selections"]), 200)

    def test_main_reuses_previous_snapshot_and_emits_only_changes(self):
        clip = FakeClip("media-1", "clip.mp4")
        resolve = FakeResolve([clip])
        with (
            mock.patch.object(
                resolve_selection_worker, "_connect_resolve", return_value=resolve
            ),
            mock.patch.object(resolve_selection_worker, "POLL_SECONDS", 0.05),
            mock.patch.object(
                resolve_selection_worker.time,
                "sleep",
                side_effect=[None, None, StopIteration],
            ) as sleep,
            mock.patch("builtins.print") as output,
        ):
            with self.assertRaises(StopIteration):
                resolve_selection_worker.main()

        self.assertEqual(clip.media_id_calls, 3)
        self.assertEqual(clip.file_path_calls, 1)
        self.assertEqual(clip.metadata_calls, 1)
        output.assert_called_once()
        self.assertTrue(
            output.call_args.args[0].startswith(resolve_selection_worker.RESULT_PREFIX)
        )
        self.assertEqual(sleep.call_args_list, [mock.call(0.05)] * 3)

    def test_missing_manager_keeps_twenty_attempts_and_half_second_waits(self):
        with (
            mock.patch.object(
                resolve_selection_worker,
                "_connect_resolve",
                return_value=DisconnectedResolve(),
            ),
            mock.patch.object(resolve_selection_worker, "POLL_SECONDS", 0.05),
            mock.patch.object(
                resolve_selection_worker.time,
                "sleep",
                side_effect=[None] * 19 + [AssertionError("retry limit exceeded")],
            ) as sleep,
            mock.patch("builtins.print") as output,
        ):
            result = resolve_selection_worker.main()

        self.assertEqual(result, 4)
        self.assertEqual(sleep.call_args_list, [mock.call(0.5)] * 19)
        output.assert_called_once()

    def test_missing_project_waits_at_least_half_a_second(self):
        resolve = FakeResolve([])
        resolve.manager.project = None
        for poll_seconds, expected_wait in ((0.05, 0.5), (0.8, 0.8)):
            with self.subTest(poll_seconds=poll_seconds):
                with (
                    mock.patch.object(
                        resolve_selection_worker, "_connect_resolve", return_value=resolve
                    ),
                    mock.patch.object(
                        resolve_selection_worker, "POLL_SECONDS", poll_seconds
                    ),
                    mock.patch.object(
                        resolve_selection_worker.time, "sleep", side_effect=StopIteration
                    ) as sleep,
                    mock.patch("builtins.print"),
                ):
                    with self.assertRaises(StopIteration):
                        resolve_selection_worker.main()

                sleep.assert_called_once_with(expected_wait)

    def test_poll_interval_defaults_to_fifty_ms_with_same_lower_bound(self):
        variable = "CONTENT_HUB_RESOLVE_SELECTION_POLL_SECONDS"
        try:
            for configured, expected in ((None, 0.05), ("0.01", 0.05), ("0.1", 0.1), ("0.8", 0.8)):
                with self.subTest(configured=configured), mock.patch.dict(os.environ):
                    if configured is None:
                        os.environ.pop(variable, None)
                    else:
                        os.environ[variable] = configured
                    importlib.reload(resolve_selection_worker)
                    self.assertEqual(resolve_selection_worker.POLL_SECONDS, expected)
        finally:
            importlib.reload(resolve_selection_worker)


class ParentStdinWatchTests(unittest.TestCase):
    """부모(허브)가 쥔 stdin 이 닫히면 작업자가 스스로 끝난다 — 허브 강제 종료 뒤 고아 방지."""

    def test_stays_alive_until_stdin_closes_then_leaves(self):
        read_fd, write_fd = os.pipe()
        left = threading.Event()
        codes = []

        def leave(code):
            codes.append(code)
            left.set()

        with os.fdopen(read_fd, "rb", buffering=0) as stream:
            thread = resolve_selection_worker._exit_when_stdin_closes(stream, leave)
            os.write(write_fd, b"ignored")  # 받은 글자는 버린다 — 닫힘만 신호
            self.assertFalse(left.wait(0.3), "stdin 이 열려 있는 동안 끝나면 안 된다")
            os.close(write_fd)
            self.assertTrue(left.wait(3), "stdin 이 닫혔는데 끝나지 않았다")
            thread.join(3)
        self.assertEqual(codes, [0])
        self.assertTrue(thread.daemon)

    def test_real_child_exits_when_parent_process_is_killed(self):
        """실제 프로세스 — 가짜 허브(이 venv 파이썬)를 강제 종료하면 그 자식(감시만 켠 작업자 대역)이 사라진다.

        venv 실행기(python.exe → 진짜 파이썬)를 거쳐도 닿는지, 선택이 안 바뀌어 아무것도 쓰지 않는 상태에서도 끝나는지 본다.
        """
        backend = str(Path(resolve_selection_worker.__file__).resolve().parents[2])
        child = (
            "import os, sys, time\n"
            f"sys.path.insert(0, {backend!r})\n"
            "from app.services.resolve_selection_worker import _exit_when_stdin_closes\n"
            "_exit_when_stdin_closes()\n"
            "print(os.getpid(), flush=True)\n"
            "time.sleep(60)\n"
        )
        hub = (
            "import os, subprocess, sys, time\n"
            "p = subprocess.Popen([sys.executable, '-c', sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)\n"
            "print(os.getpid(), int(p.stdout.readline()), flush=True)\n"
            "time.sleep(60)\n"
        )
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        process = subprocess.Popen([sys.executable, "-c", hub, child], stdout=subprocess.PIPE, creationflags=flags)
        hub_pid = worker_pid = 0
        try:
            hub_pid, worker_pid = map(int, process.stdout.readline().split())
            self.assertTrue(_pid_alive(worker_pid))
            _kill(hub_pid)  # 실행기 뒤의 진짜 허브 파이썬 — 종료 정리(lifespan)가 돌지 않는 죽음
            deadline = time.monotonic() + 10
            while _pid_alive(worker_pid) and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertFalse(_pid_alive(worker_pid), "허브가 죽었는데 작업자가 남았다")
        finally:
            for pid in (worker_pid, hub_pid, process.pid):
                if pid and _pid_alive(pid):
                    _kill(pid)
            process.stdout.close()
            process.wait(10)


def _pid_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
    return str(pid) in out


def _kill(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
    else:
        with contextlib.suppress(OSError):
            os.kill(pid, 9)


if __name__ == "__main__":
    unittest.main()
