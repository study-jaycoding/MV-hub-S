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


class FakeFusionInput:
    def __init__(self, input_id):
        self.input_id = input_id
        self.expression = ""

    def GetAttrs(self):
        return {"INPS_ID": self.input_id}

    def SetExpression(self, expression):
        self.expression = expression

    def GetExpression(self):
        return self.expression


class FakeFusionTool:
    def __init__(self, name):
        self.name = name
        self.values = {"Blend": 1.0}
        self.inputs = (
            {"StyledText": FakeFusionInput("StyledText")}
            if name == "Text1"
            else {}
        )

    def SetInput(self, name, value, _time):
        self.values[name] = value

    def GetInput(self, name, _time):
        return self.values.get(name)

    def GetInputList(self):
        return self.inputs


class FakeFusionComp:
    def __init__(self):
        self.tools = {
            "Merge1": FakeFusionTool("Merge1"),
            "Text1": FakeFusionTool("Text1"),
        }

    def FindTool(self, name):
        return self.tools.get(name)


class FakeTimelineItem:
    def __init__(
        self,
        unique_id,
        name,
        start,
        end,
        media_item,
        enabled=True,
        fail_fusion_import=False,
    ):
        self.unique_id = unique_id
        self.name = name
        self.start = start
        self.end = end
        self.media_item = media_item
        self.enabled = enabled
        self.fail_fusion_import = fail_fusion_import
        self.fusion_names = []
        self.fusion_comps = {}
        self.imported_setting_text = ""

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

    def GetFusionCompNameList(self):
        return list(self.fusion_names)

    def ImportFusionComp(self, path):
        if self.fail_fusion_import:
            return None
        self.imported_setting_text = Path(path).read_text(encoding="utf-8")
        name = f"Composition {len(self.fusion_names) + 1}"
        self.fusion_names.append(name)
        comp = FakeFusionComp()
        self.fusion_comps[name] = comp
        return comp

    def RenameFusionCompByName(self, old_name, new_name):
        if old_name not in self.fusion_names or new_name in self.fusion_names:
            return False
        self.fusion_names[self.fusion_names.index(old_name)] = new_name
        self.fusion_comps[new_name] = self.fusion_comps.pop(old_name)
        return True

    def GetFusionCompByName(self, name):
        return self.fusion_comps.get(name)

    def DeleteFusionCompByName(self, name):
        if name not in self.fusion_names:
            return False
        self.fusion_names.remove(name)
        self.fusion_comps.pop(name, None)
        return True


class FakeTimeline:
    def __init__(self, items, track_count=1, frame_rate="24"):
        self.items = list(items)
        self.track_count = track_count
        self.frame_rate = frame_rate

    def GetName(self):
        return "편집본"

    def GetTrackCount(self, track_type):
        return self.track_count if track_type == "video" else 0

    def GetTrackName(self, track_type, index):
        return "메인" if track_type == "video" and index == 1 else ""

    def GetItemListInTrack(self, track_type, index):
        return self.items if track_type == "video" and index == 1 else []

    def GetSetting(self, name=None):
        settings = {
            "timelineFrameRate": self.frame_rate,
            "timelinePlaybackFrameRate": self.frame_rate,
        }
        return settings if name is None else settings.get(name)


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

            self.assertEqual(Path(root), Path(temp) / "assets" / "CLIP")
            self.assertEqual(
                jobs[0]["output_name"], "뻘뻘뻘_e001_c0010_c_v002"
            )
            self.assertEqual(
                Path(jobs[0]["output_dir"]), Path(temp) / "assets" / "CLIP" / "e001"
            )

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

    def test_clip_output_root_can_find_sibling_render_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            output_root = Path(temp) / "assets" / "CLIP"

            render_root = exporter.infer_render_root([], str(output_root))

            self.assertEqual(Path(render_root), Path(temp) / "render")

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
                Path(output_root), project_folder / "10_ai" / "assets" / "CLIP"
            )
            self.assertEqual(Path(render_root), project_folder / "10_ai" / "render")
            self.assertEqual(jobs[0]["project"], "mudx")
            self.assertEqual(jobs[0]["output_name"], "mudx_e001_c0010_v001")

    def test_ui_starts_with_empty_episode_and_clear_labels(self):
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        episode_label = source.index('ui.Label({"Text": "에피소드"')
        render_preset_label = source.index('ui.Label({"Text": "렌더 프리셋"')
        field_row_start = source.rindex("ui.HGroup(", 0, episode_label)
        field_row_end = source.rindex("ui.HGroup(", 0, render_preset_label)
        field_row = source[field_row_start:field_row_end]

        self.assertIn('"PlaceholderText": "에피소드 입력 (예: e001)"', source)
        self.assertNotIn('"ID": "Episode",\n                                "Text":', source)
        self.assertIn(
            '"PlaceholderText": "선택 입력 (예: c-클린 버전, m-모자이크 버전)"',
            source,
        )
        self.assertLess(
            source.index('ui.Label({"Text": "설명"'),
            source.index('ui.Label({"Text": "시퀀스 단위"'),
        )
        self.assertEqual(field_row.count("ui.HGroup("), 1)
        self.assertLess(
            field_row.index('"ID": "Episode"'), field_row.index('"ID": "Description"')
        )
        self.assertLess(
            field_row.index('"ID": "Description"'), field_row.index('"ID": "SequenceStep"')
        )
        self.assertLess(field_row.index('"ID": "SequenceStep"'), field_row.index('"ID": "Version"'))
        self.assertIn('"ID": "TimeCounter"', source)
        self.assertIn('"Text": "타임카운터 적용"', source)
        self.assertIn('"Checked": True', source)
        self.assertIn('"Text": "렌더 폴더 생성"', source)
        self.assertRegex(
            source,
            r'"ID": "CreateRenderFolders",[\s\S]*?"Enabled": False',
        )
        self.assertRegex(
            source,
            r'"ID": "RenderNow",[\s\S]*?"Enabled": False',
        )
        self.assertIn('window.On["Episode"].TextChanged = refresh', source)
        self.assertIn('raise ExporterError("에피소드를 입력하세요 (예: e001)")', source)

    def test_time_counter_is_applied_once_and_removed_without_touching_other_comps(self):
        media = FakeMediaItem("m1", "원본", r"D:\Project\clip.mov")
        item = FakeTimelineItem("t1", "클립", 0, 24, media)
        item.fusion_names = ["사용자 효과"]
        jobs = [
            {"item": item, "frame_rate": 29.97, "frame_count": 300},
            {"item": item, "frame_rate": 29.97, "frame_count": 300},
        ]

        first_count = exporter.apply_time_counter(jobs)
        second_count = exporter.apply_time_counter(jobs)

        self.assertEqual(first_count, 1)
        self.assertEqual(second_count, 1)
        self.assertEqual(
            item.fusion_names,
            ["사용자 효과", exporter.TIME_COUNTER_COMP_NAME],
        )
        self.assertIn('SourceOp = "Text1"', item.imported_setting_text)
        self.assertIn("Value = 299", item.imported_setting_text)
        self.assertIn("/ 29.97", item.imported_setting_text)
        self.assertNotIn("Width = Input", item.imported_setting_text)
        self.assertNotIn("Height = Input", item.imported_setting_text)

        removed_count = exporter.remove_time_counter(jobs)

        self.assertEqual(removed_count, 1)
        self.assertEqual(
            item.fusion_names,
            ["사용자 효과", exporter.TIME_COUNTER_COMP_NAME],
        )
        comp = item.GetFusionCompByName(exporter.TIME_COUNTER_COMP_NAME)
        self.assertEqual(comp.FindTool("Merge1").GetInput("Blend", 0), 0.0)

        exporter.apply_time_counter(jobs)

        self.assertEqual(comp.FindTool("Merge1").GetInput("Blend", 0), 1.0)
        self.assertIn(
            "/ 29.97",
            comp.FindTool("Text1").inputs["StyledText"].GetExpression(),
        )

    def test_time_counter_apply_rolls_back_new_comps_when_a_later_clip_fails(self):
        media = FakeMediaItem("m1", "원본", r"D:\Project\clip.mov")
        first = FakeTimelineItem("t1", "첫번째", 0, 24, media)
        second = FakeTimelineItem(
            "t2", "두번째", 24, 48, media, fail_fusion_import=True
        )

        with self.assertRaisesRegex(exporter.ExporterError, "가져오지 못했습니다"):
            exporter.apply_time_counter(
                [
                    {"item": first, "frame_rate": 24, "frame_count": 24},
                    {"item": second, "frame_rate": 24, "frame_count": 24},
                ]
            )

        self.assertEqual(first.fusion_names, [])
        self.assertEqual(second.fusion_names, [])

    def test_time_counter_setting_uses_fractional_fps_and_each_clip_length(self):
        setting = exporter.build_time_counter_setting("23.976 DF", 1440)

        self.assertIn("Value = 1439", setting)
        self.assertIn("/ (23.976 * 60)", setting)
        self.assertIn("/ 23.976", setting)
        self.assertNotIn("__MVHUB_", setting)

    def test_collect_records_carries_timeline_fps_and_clip_length(self):
        media = FakeMediaItem("m1", "원본", r"D:\Project\clip.mov")
        item = FakeTimelineItem("t1", "클립", 10, 310, media)
        timeline = FakeTimeline([item], frame_rate="59.94")
        project = FakeProject(timeline, media_tree(media, media))

        rows = exporter.collect_timeline_clips(project, 1)

        self.assertEqual(rows[0]["frame_rate"], 59.94)
        self.assertEqual(rows[0]["frame_count"], 300)

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
