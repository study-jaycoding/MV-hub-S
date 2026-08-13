"""Resolve 내부 MV Hub Clip Exporter의 이름·구간·롤백 계약."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "app"
    / "resources"
    / "resolve"
    / "MVHub_Clip_Exporter.py"
)
SPEC = importlib.util.spec_from_file_location("mvhub_clip_exporter", SCRIPT_PATH)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


class FakeMediaItem:
    def __init__(self, unique_id: str, name: str, path: str):
        self.unique_id = unique_id
        self.name = name
        self.path = path

    def GetUniqueId(self):
        return self.unique_id

    def GetName(self):
        return self.name

    def GetClipProperty(self, name):
        return self.path if name == "File Path" else ""


class FakeFolder:
    def __init__(self, name: str, *, children=None, clips=None):
        self.name = name
        self.children = list(children or [])
        self.clips = list(clips or [])

    def GetName(self):
        return self.name

    def GetSubFolderList(self):
        return self.children

    def GetClipList(self):
        return self.clips


class FakeMediaPool:
    def __init__(self, root):
        self.root = root

    def GetRootFolder(self):
        return self.root


class FakeTimelineItem:
    def __init__(self, unique_id, name, start, end, media_item, enabled=True):
        self.unique_id = unique_id
        self.name = name
        self.start = start
        self.end = end
        self.media_item = media_item
        self.enabled = enabled

    def GetUniqueId(self):
        return self.unique_id

    def GetName(self):
        return self.name

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.end

    def GetMediaPoolItem(self):
        return self.media_item

    def GetClipEnabled(self):
        return self.enabled


class FakeTimeline:
    def __init__(self, items, track_count=1):
        self.items = list(items)
        self.track_count = track_count

    def GetName(self):
        return "편집본"

    def GetTrackCount(self, track_type):
        return self.track_count if track_type == "video" else 0

    def GetTrackName(self, track_type, index):
        return "메인" if track_type == "video" and index == 1 else ""

    def GetItemListInTrack(self, track_type, index):
        return self.items if track_type == "video" and index == 1 else []


class FakeProject:
    def __init__(self, timeline=None, media_pool=None, fail_job_number=None):
        self.timeline = timeline
        self.media_pool = media_pool
        self.mode = 0
        self.settings = []
        self.job_ids = []
        self.deleted = []
        self.loaded_preset = None
        self.fail_job_number = fail_job_number
        self.started_job_ids = []
        self.start_result = True

    def GetName(self):
        return "뻘뻘뻘"

    def GetCurrentTimeline(self):
        return self.timeline

    def GetMediaPool(self):
        return self.media_pool

    def IsRenderingInProgress(self):
        return False

    def GetCurrentRenderMode(self):
        return self.mode

    def SetCurrentRenderMode(self, mode):
        self.mode = mode
        return True

    def LoadRenderPreset(self, name):
        self.loaded_preset = name
        return True

    def GetCurrentRenderFormatAndCodec(self):
        return {"format": "mp4", "codec": "H264"}

    def SetRenderSettings(self, settings):
        self.settings.append(dict(settings))
        return True

    def AddRenderJob(self):
        number = len(self.settings)
        if self.fail_job_number == number:
            return ""
        job_id = f"job-{number}"
        self.job_ids.append(job_id)
        return job_id

    def DeleteRenderJob(self, job_id):
        self.deleted.append(job_id)
        return True

    def StartRendering(self, job_ids, is_interactive=False):
        self.started_job_ids = list(job_ids)
        self.render_interactive = is_interactive
        return self.start_result


def media_tree(first, second):
    return FakeMediaPool(
        FakeFolder(
            "Master",
            children=[
                FakeFolder(
                    "MV Hub",
                    children=[
                        FakeFolder(
                            "뻘뻘뻘",
                            children=[
                                FakeFolder(
                                    "e001",
                                    children=[
                                        FakeFolder("c0010", clips=[first]),
                                        FakeFolder("c0015", clips=[second]),
                                    ],
                                )
                            ],
                        )
                    ],
                )
            ],
        )
    )


class ResolveClipExporterTests(unittest.TestCase):
    def test_safe_filename_keeps_korean_and_rejects_unknown_template_field(self):
        self.assertEqual(exporter.sanitize_component(" 장면:01? "), "장면_01")
        self.assertEqual(exporter.sanitize_component("CON"), "_CON")
        with self.assertRaisesRegex(exporter.ExporterError, "지원하지 않는"):
            exporter.format_output_name("{unknown}", {})

    def test_collects_v1_in_timeline_order_and_reads_mvhub_folder_path(self):
        first = FakeMediaItem("m1", "원본1", r"D:\Project\Render\e001\c0010\a.mp4")
        second = FakeMediaItem("m2", "원본2", r"D:\Project\Render\e001\c0015\b.mp4")
        disabled = FakeTimelineItem("t0", "제외", 0, 5, first, enabled=False)
        later = FakeTimelineItem("t2", "두번째", 30, 50, second)
        earlier = FakeTimelineItem("t1", "첫번째", 10, 30, first)
        timeline = FakeTimeline([later, disabled, earlier])
        project = FakeProject(timeline, media_tree(first, second))

        rows = exporter.collect_timeline_clips(project, 1)

        self.assertEqual([row["clip"] for row in rows], ["첫번째", "두번째"])
        self.assertEqual(
            [(row["episode"], row["sequence"]) for row in rows],
            [("e001", "c0010"), ("e001", "c0015")],
        )
        self.assertEqual([row["cut"] for row in rows], [1, 1])
        self.assertEqual([row["mark_out"] for row in rows], [29, 49])

    def test_builds_default_names_and_render_export_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            render = Path(temp) / "Render"
            source = render / "e001" / "c0010" / "source.mp4"
            record = {
                "project": "뻘뻘뻘",
                "timeline": "편집본",
                "episode": "e001",
                "sequence": "c0010",
                "clip": "장면",
                "source": "source",
                "source_path": str(source),
                "track": 1,
                "cut": 1,
                "start": 100,
                "mark_out": 123,
            }

            root = exporter.infer_output_root([record])
            jobs = exporter.build_render_jobs(
                [record], root, version="002", description="c", episode="001"
            )

            self.assertEqual(Path(root), Path(temp) / "assets" / "reference")
            self.assertEqual(
                jobs[0]["output_name"], "뻘뻘뻘_e001_c0010_c_v002"
            )
            self.assertEqual(Path(jobs[0]["output_dir"]), Path(temp) / "assets" / "reference" / "e001")

    def test_creates_render_episode_sequence_folders_from_jobs(self):
        with tempfile.TemporaryDirectory() as temp:
            render_root = Path(temp) / "render"
            jobs = [
                {"episode": "e001", "sequence": "c0010"},
                {"episode": "e001", "sequence": "c0015"},
                {"episode": "e001", "sequence": "c0010"},
            ]

            folders = exporter.create_render_sequence_folders(jobs, render_root)

            self.assertEqual(
                [Path(folder) for folder in folders],
                [render_root / "e001" / "c0010", render_root / "e001" / "c0015"],
            )
            self.assertTrue((render_root / "e001" / "c0010").is_dir())
            self.assertTrue((render_root / "e001" / "c0015").is_dir())

    def test_project_folder_in_source_path_sets_name_and_10_ai_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            project_folder = Path(temp) / "PROJECT_MUDX"
            source = (
                project_folder
                / "01_pre"
                / "02_animatics"
                / "publish"
                / "mudx1"
                / "clip.mov"
            )
            record = {
                "project": "Resolve Project",
                "episode": "e001",
                "sequence": "c0099",
                "source_path": str(source),
                "track": 1,
                "cut": 1,
                "start": 0,
                "mark_out": 9,
            }

            output_root = exporter.infer_output_root([record])
            render_root = exporter.infer_render_root([record], output_root)
            jobs = exporter.build_render_jobs([record], output_root, episode="1")

            self.assertEqual(
                Path(output_root), project_folder / "10_ai" / "assets" / "reference"
            )
            self.assertEqual(Path(render_root), project_folder / "10_ai" / "render")
            self.assertEqual(jobs[0]["project"], "mudx")
            self.assertEqual(jobs[0]["output_name"], "mudx_e001_c0010_v001")

    def test_empty_description_does_not_leave_an_extra_separator(self):
        record = {
            "project": "project",
            "episode": "e001",
            "sequence": "c0010",
            "track": 1,
            "cut": 1,
            "start": 100,
            "mark_out": 123,
        }

        jobs = exporter.build_render_jobs([record], r"D:\Export", version="001")

        self.assertEqual(jobs[0]["output_name"], "project_e001_c0010_v001")

    def test_episode_input_and_sequence_step_number_clips_in_timeline_order(self):
        records = [
            {
                "project": "project",
                "episode": "old",
                "sequence": "old",
                "track": 1,
                "cut": index,
                "start": index * 10,
                "mark_out": index * 10 + 9,
            }
            for index in range(1, 4)
        ]

        jobs = exporter.build_render_jobs(
            records,
            r"D:\Export",
            version="001",
            episode="ep2",
            sequence_step=5,
        )

        self.assertEqual([job["episode"] for job in jobs], ["e002"] * 3)
        self.assertEqual(
            [job["sequence"] for job in jobs], ["c0005", "c0010", "c0015"]
        )
        self.assertEqual(
            [job["output_name"] for job in jobs],
            [
                "project_e002_c0005_v001",
                "project_e002_c0010_v001",
                "project_e002_c0015_v001",
            ],
        )

    def test_default_sequence_step_is_ten(self):
        records = [
            {"project": "project", "track": 1, "start": 0, "mark_out": 9},
            {"project": "project", "track": 1, "start": 10, "mark_out": 19},
        ]

        jobs = exporter.build_render_jobs(records, r"D:\Export", episode="1")

        self.assertEqual([job["sequence"] for job in jobs], ["c0010", "c0020"])

    def test_lists_existing_video_tracks_with_resolve_names(self):
        timeline = FakeTimeline([], track_count=2)

        self.assertEqual(
            exporter.video_track_options(timeline),
            [
                {"index": 1, "label": "V1 · 메인"},
                {"index": 2, "label": "V2"},
            ],
        )

    def test_enqueue_uses_exact_inclusive_out_and_does_not_start_by_itself(self):
        with tempfile.TemporaryDirectory() as temp:
            project = FakeProject()
            jobs = [
                {
                    "output_dir": str(Path(temp) / "e001" / "c0010"),
                    "output_name": "clip_001",
                    "start": 10,
                    "mark_out": 29,
                },
                {
                    "output_dir": str(Path(temp) / "e001" / "c0010"),
                    "output_name": "clip_002",
                    "start": 30,
                    "mark_out": 49,
                },
            ]

            job_ids = exporter.enqueue_render_jobs(project, jobs, "H.264 Master")

            self.assertEqual(job_ids, ["job-1", "job-2"])
            self.assertEqual(project.loaded_preset, "H.264 Master")
            self.assertEqual(project.settings[0]["MarkIn"], 10)
            self.assertEqual(project.settings[0]["MarkOut"], 29)
            self.assertEqual(project.settings[1]["MarkIn"], 30)
            self.assertEqual(project.settings[1]["MarkOut"], 49)
            self.assertNotIn("ReplaceExistingFilesInPlace", project.settings[0])
            self.assertEqual(project.mode, 0)
            self.assertEqual(project.started_job_ids, [])

    def test_starts_every_new_job_in_one_resolve_render_request(self):
        project = FakeProject()

        started = exporter.start_render_jobs(project, ["job-1", "job-2", "job-3"])

        self.assertEqual(started, ["job-1", "job-2", "job-3"])
        self.assertEqual(project.started_job_ids, ["job-1", "job-2", "job-3"])
        self.assertTrue(project.render_interactive)

    def test_failed_start_keeps_created_queue_jobs_for_manual_retry(self):
        project = FakeProject()
        project.job_ids = ["existing-job"]
        project.start_result = False

        with self.assertRaisesRegex(exporter.ExporterError, "Queue에 남아"):
            exporter.start_render_jobs(project, ["job-1", "job-2"])

        self.assertEqual(project.deleted, [])
        self.assertEqual(project.job_ids, ["existing-job"])

    def test_enqueue_rolls_back_only_jobs_created_by_this_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            project = FakeProject(fail_job_number=2)
            jobs = [
                {
                    "output_dir": temp,
                    "output_name": "clip_001",
                    "start": 0,
                    "mark_out": 9,
                },
                {
                    "output_dir": temp,
                    "output_name": "clip_002",
                    "start": 10,
                    "mark_out": 19,
                },
            ]

            with self.assertRaisesRegex(exporter.ExporterError, "추가하지 못했습니다"):
                exporter.enqueue_render_jobs(project, jobs)

            self.assertEqual(project.deleted, ["job-1"])
            self.assertEqual(project.mode, 0)

    def test_existing_output_blocks_queue_before_any_job_is_added(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            (output / "clip_001.mp4").write_bytes(b"existing")
            project = FakeProject()
            jobs = [
                {
                    "output_dir": temp,
                    "output_name": "clip_001",
                    "start": 0,
                    "mark_out": 9,
                }
            ]

            with self.assertRaisesRegex(exporter.ExporterError, "이미 있습니다"):
                exporter.enqueue_render_jobs(project, jobs)

            self.assertEqual(project.job_ids, [])
            self.assertEqual(project.mode, 0)


if __name__ == "__main__":
    unittest.main()
