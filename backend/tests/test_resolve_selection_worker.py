"""Resolve 선택 자식 — UI 없이 최소 식별 정보만 읽는 계약."""

from __future__ import annotations

import importlib
import json
import os
import unittest
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


if __name__ == "__main__":
    unittest.main()
