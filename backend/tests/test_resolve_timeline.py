"""타임라인 Resolve 보내기 — 계획 검증(순수)과 새 타임라인 짓기(가짜 Resolve).

가짜는 2026-10-09 실측(Resolve Studio 21.1.1)에서 잰 규칙대로 군다: endFrame 끝 미포함 · recordFrame 절대 좌표 ·
소스 fps → 타임라인 길이 환산(**내림** — 2026-10-23 실측 4: 30fps 46프레임 → 36, 25fps 52프레임 → 49) · 겹치면 잘라 넣고도 참 ·
스틸은 5초 · 잠근 트랙엔 못 넣음 · 마커는 프레임마다 하나 · CreateEmptyTimeline 이 현재 타임라인을 바꾼다 · 타임라인 fps 를 바꾸면
시작 프레임도 바뀐다. 속도(2026-10-23 실측 1~4): SetSpeed(리플 없음)는 길이를 두고 원본 끝을 바꾼다(내림) · 원본 끝에 닿으면
끝 프레임으로 읽힌다(E − 1) · GetSpeed 는 사전.
"""

from __future__ import annotations

import contextlib
import copy
import io
import json
import math
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException, Request

from app.routers import resolve_integration
from app.services import resolve_status_runner, resolve_timeline, resolve_timeline_worker
from app.services.resolve_bridge import _normal_path
from app.services.resolve_timeline import TimelinePlanError, _frame, build_timeline, validate_plan

FPS = 24
COLORS = set(resolve_timeline.MARKER_COLORS)


class FakeClip:
    def __init__(self, path: str, *, fps: float = 24.0, frames: int = 240, audio: int = 2, still: bool = False):
        self.path = path
        self.fps, self.frames, self.audio, self.still = fps, (1 if still else frames), (0 if still else audio), still

    def GetClipProperty(self, key=None):
        props = {
            "File Path": self.path, "FPS": self.fps, "Frames": str(self.frames), "Audio Ch": str(self.audio),
            "Type": "Still" if self.still else ("Video + Audio" if self.audio else "Video"),
        }
        return props.get(key, "") if key else props

    def GetUniqueId(self):
        return f"clip-{self.path}"


class FakeFolder:
    def __init__(self, name: str):
        self.name, self.children, self.clips = name, [], []

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return f"folder-{id(self)}"

    def GetSubFolderList(self):
        return self.children

    def GetClipList(self):
        return self.clips

    def child(self, name: str) -> "FakeFolder":
        found = next((item for item in self.children if item.name == name), None)
        if found is None:
            found = FakeFolder(name)
            self.children.append(found)
        return found


class FakeItem:
    # 시험이 바꾸는 속도 API 의 이상(mock.patch.object 로) — SetSpeed 가 False · GetSpeed 가 사전이 아님 · 다른 미디어 풀 아이템
    set_speed_ok = True
    speed_reply = "normal"
    pool_item_override = None

    def __init__(self, clip: FakeClip, start: int, duration: int, left: int):
        self.clip, self.start, self.duration, self.left, self.enabled = clip, start, duration, left, True
        self.enable_result = True
        self.speed: dict | None = None
        self.source_end = left + math.floor(duration * clip.fps / 24 + 1e-6)

    def GetStart(self, _sub=False):
        return float(self.start)

    def GetDuration(self, _sub=False):
        return float(self.duration)

    def GetLeftOffset(self, _sub=False):
        return float(self.left)

    def GetSourceStartFrame(self):
        return self.left

    def GetSourceEndFrame(self):
        return self.source_end

    def GetMediaPoolItem(self):
        return self.pool_item_override or self.clip

    def SetSpeed(self, options):
        if not self.set_speed_ok:
            return False
        self.speed = dict(options)
        # 길이는 그대로, 원본 끝 = 시작 + 내림(길이 × 소스 fps ÷ 24 × 배율) — 원본 끝에 닿으면 끝 프레임으로 읽힌다(실측)
        end = self.left + math.floor(self.duration * self.clip.fps / 24 * options["Percentage"] / 100 + 1e-6)
        self.source_end = end if end < self.clip.frames else self.clip.frames - 1
        return True

    def GetSpeed(self):
        if self.speed_reply == "none":
            return None
        if self.speed_reply == "empty":
            return {}
        if self.speed_reply in ("nan", "inf"):
            return {"Percentage": float(self.speed_reply)}
        return dict(self.speed or {"Percentage": 100.0})

    def SetClipEnabled(self, enabled):
        if self.enable_result:
            self.enabled = enabled
        return self.enable_result


class FakeTimeline:
    def __init__(self, name: str, fps: float):
        self.name, self.unique_id = name, f"timeline-{name}"
        self.settings = {"timelineFrameRate": fps, "useCustomSettings": "0"}
        self.video: list[list[FakeItem]] = [[]]
        self.audio: list[list[FakeItem]] = [[]]
        self.video_off: set[int] = set()
        self.audio_off: set[int] = set()
        self.locked: set[int] = set()
        self.markers: dict[int, dict] = {}
        self.mark = None
        self.fps_settable = True
        self.lock_result = True

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return self.unique_id

    def GetSetting(self, key):
        return self.settings.get(key, "")

    def SetSetting(self, key, value):
        if key == "timelineFrameRate":
            if self.settings["useCustomSettings"] != "1" or not self.fps_settable:
                return False
            self.settings[key] = float(value)
            return True
        self.settings[key] = value
        return True

    def GetStartFrame(self):
        return int(round(3600 * self.settings["timelineFrameRate"]))  # 01:00:00:00

    def GetTrackCount(self, kind):
        return len(self.video if kind == "video" else self.audio)

    def AddTrack(self, kind, _sub=None):
        (self.video if kind == "video" else self.audio).append([])
        return True

    def GetItemListInTrack(self, kind, index):
        return sorted((self.video if kind == "video" else self.audio)[index - 1], key=lambda item: item.start)

    def SetTrackEnable(self, kind, index, enabled):
        target = self.video_off if kind == "video" else self.audio_off
        (target.discard if enabled else target.add)(index)
        return True

    def SetTrackLock(self, kind, index, locked):
        if not self.lock_result:
            return False
        (self.locked.add if locked else self.locked.discard)(index)
        return True

    def AddMarker(self, frame, color, name, note, duration, custom=None):
        if frame in self.markers or color not in COLORS:
            return False
        self.markers[frame] = {"color": color, "name": name, "duration": duration}
        return True

    def SetMarkInOut(self, mark_in, mark_out, kind=None):
        self.mark = (mark_in, mark_out, kind)
        return True


class FakeMediaPool:
    def __init__(self, project: "FakeProject"):
        self.project = project
        self.root = FakeFolder("Master")
        self.current = self.root
        self.timeline_folders: dict[str, FakeFolder] = {}
        self.append_calls: list[list[dict]] = []
        self.before_append = None  # 넣기 직전에 끼어드는 사용자 조작 흉내

    def GetRootFolder(self):
        return self.root

    def GetCurrentFolder(self):
        return self.current

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def RefreshFolders(self):
        return True

    def CreateEmptyTimeline(self, name):
        if any(timeline.name == name for timeline in self.project.timelines):
            return None
        timeline = FakeTimeline(name, self.project.fps)
        timeline.fps_settable = self.project.timeline_fps_settable
        self.project.timelines.append(timeline)
        self.project.current_timeline = timeline  # 스스로 현재 타임라인을 바꾼다(실측)
        self.timeline_folders[name] = self.current
        return timeline

    def AppendToTimeline(self, infos):
        self.append_calls.append(list(infos))
        timeline = self.project.current_timeline  # 늘 '현재' 타임라인에 넣는다
        placed = []
        for info in infos:
            clip: FakeClip = info["mediaPoolItem"]
            track = info.get("trackIndex", 1)
            first = int(info.get("startFrame", 0))
            if clip.still:
                duration = 5 * round(timeline.settings["timelineFrameRate"])  # 준 길이를 무시한다
            else:
                frames = int(info.get("endFrame", clip.frames)) - first  # 끝 미포함
                if frames <= 0:
                    continue
                duration = math.floor(frames / clip.fps * timeline.settings["timelineFrameRate"] + 1e-6)  # 내림(실측 4)
            start, end = int(info["recordFrame"]), int(info["recordFrame"]) + duration
            kinds = {1: ["video"], 2: ["audio"]}.get(info.get("mediaType"), ["video", "audio"])
            ok = False
            for kind in kinds:
                index = track if kind == "video" else 1
                if kind == "video" and index in timeline.locked:
                    continue
                lane = (timeline.video if kind == "video" else timeline.audio)[index - 1]
                # 겹치면 빈 자리만큼만 잘라 넣는다 — 그래도 참을 돌려준다
                free_start, free_end = start, end
                for other in sorted(lane, key=lambda item: item.start):
                    if other.start <= free_start < other.start + other.duration:
                        free_start = other.start + other.duration
                    elif free_start < other.start < free_end:
                        free_end = other.start
                if free_end > free_start:
                    lane.append(FakeItem(clip, free_start, free_end - free_start, first + (free_start - start)))
                    ok = True
            if ok:
                placed.append(True)
        return placed


class FakeProject:
    def __init__(self, name: str = "임시 테스트", unique_id: str = "resolve-project-1", fps: float = 24.0):
        self.name, self.unique_id, self.fps = name, unique_id, fps
        self.timelines: list[FakeTimeline] = []
        self.current_timeline = None
        self.timeline_fps_settable = True
        self.media_pool = FakeMediaPool(self)

    def GetName(self):
        return self.name

    def GetUniqueId(self):
        return self.unique_id

    def GetMediaPool(self):
        return self.media_pool

    def GetTimelineCount(self):
        return len(self.timelines)

    def GetTimelineByIndex(self, index):
        return self.timelines[index - 1] if 1 <= index <= len(self.timelines) else None

    def GetCurrentTimeline(self):
        return self.current_timeline

    def SetCurrentTimeline(self, timeline):
        self.current_timeline = timeline
        return True


class FakeProjectManager:
    def __init__(self, project: FakeProject):
        self.project, self.saved, self.save_result = project, 0, True

    def GetCurrentProject(self):
        return self.project

    def SaveProject(self):
        self.saved += 1
        return self.save_result


class FakeResolve:
    def __init__(self, manager: FakeProjectManager):
        self.manager = manager

    def GetProjectManager(self):
        return self.manager


def clip(gen_id, track, start, end, *, enabled=True, kind="video", head=None):
    """head 를 주면 2 판의 클립이다(소스의 시작, 24fps 프레임) — 안 주면 그 칸이 없다(1 판)."""
    row = {"gen_id": gen_id, "track": track, "start": start, "end": end, "enabled": enabled, "kind": kind}
    if head is not None:
        row["head"] = head
    return row


def sound(gen_id, start, end, track, offset=0):
    """2 판의 소리 — 그 소리를 내는 영상 클립의 트랙을 가리킨다."""
    return {"gen_id": gen_id, "start": start, "end": end, "offset": offset, "track": track}


def sped(gen_id, track, start, end, speed, *, head=0, enabled=True):
    """3 판의 속도 클립 — src = 보내는 프레임 수 ÷ 24 × 속도(프런트 editResolveExport 와 같은 식)."""
    return {**clip(gen_id, track, start, end, enabled=enabled, head=head), "speed": speed, "src": (end - start) / 24 * speed}


def sped_sound(gen_id, start, end, track, speed, offset=0):
    return {**sound(gen_id, start, end, track, offset), "speed": speed}


def plan(clips, *, audio=(), markers=(), mark=None, tracks=3, off=(), locked=(), muted=False, name="뻘뻘뻘_e035", version=1):
    return {
        "format": "mvhub.edit-timeline", "version": version, "name": name, "fps": 24, "video_tracks": tracks,
        "tracks_off": list(off), "tracks_locked": list(locked), "muted": muted,
        "clips": list(clips), "audio": list(audio), "markers": list(markers), "mark": mark,
        "total": max((item["end"] for item in clips), default=0),
    }


class ValidatePlanTests(unittest.TestCase):
    IDS = {"a", "b"}

    def ok(self, **changes):
        base = plan([clip("a", 1, 0, 120), clip("b", 2, 0, 96)], audio=[{"gen_id": "b", "start": 0, "end": 96, "offset": 0}])
        base.update(changes)
        return validate_plan(base, self.IDS)

    def bad(self, **changes):
        with self.assertRaises(TimelinePlanError):
            self.ok(**changes)

    def test_normalizes_a_valid_plan(self):
        out = self.ok(
            tracks_off=[3, 3], tracks_locked=[2], name="A/B:C  이름",
            markers=[{"frame": 12, "color": "Red", "name": "하나"}, {"frame": 12, "color": "Blue", "name": "같은 프레임"}],
            mark={"in": 0, "out": 48},
        )
        self.assertEqual(out["name"], "A B C  이름")
        self.assertEqual((out["tracks_off"], out["tracks_locked"]), ([3], [2]))
        self.assertEqual(out["markers"], [{"frame": 12, "color": "Red", "name": "하나"}])  # 프레임마다 하나 — 먼저 온 것
        self.assertEqual(out["mark"], {"in": 0, "out": 48})
        self.assertEqual(resolve_timeline.plan_generation_ids(out), ["a", "b"])

    def test_version_two_carries_the_source_start_and_the_audio_carrier(self):
        # 앞 자르기(2026-10-14) — 2 판은 클립마다 head(소스의 시작, 24fps 프레임), 소리마다 track(제 영상 클립의 트랙)이 있어야 한다
        v2 = {"version": 2, "clips": [clip("a", 1, 0, 120, head=0), clip("b", 2, 0, 96, head=24)], "audio": [sound("b", 0, 96, 2, 1)]}
        out = self.ok(**v2)
        self.assertEqual(out["version"], 2)  # 받은 버전을 그대로 돌려준다
        self.assertEqual([(row["gen_id"], row["head"]) for row in out["clips"]], [("a", 0), ("b", 24)])
        self.assertEqual(out["audio"][0]["track"], 2)
        one = self.ok()
        self.assertEqual((one["version"], [row["head"] for row in one["clips"]], one["audio"][0]["track"]), (1, [0, 0], None))
        self.bad(version=3)
        self.bad(version=True)
        self.bad(**{**v2, "clips": [clip("a", 1, 0, 120), clip("b", 2, 0, 96, head=24)]})  # 2 판인데 head 가 빠진 클립
        self.bad(**{**v2, "clips": [clip("a", 1, 0, 120, head=0), clip("b", 2, 0, 96, head=-1)]})
        self.bad(**{**v2, "clips": [clip("a", 1, 0, 120, head=0), clip("b", 2, 0, 96, head=1.5)]})
        self.bad(**{**v2, "clips": [clip("a", 1, 0, 120, head=0), clip("b", 2, 0, 96, head=True)]})
        self.bad(**{**v2, "clips": [clip("a", 1, 0, 120, head=5, kind="image"), clip("b", 2, 0, 96, head=24)]})  # 그림에는 시작점이 없다
        self.bad(**{**v2, "audio": [{"gen_id": "b", "start": 0, "end": 96, "offset": 1}]})  # 소리에 track 이 없다
        self.bad(**{**v2, "audio": [sound("b", 0, 96, 1, 1)]})  # V1 의 그 자리에는 b 가 없다 — 다른 클립으로 대신하지 않는다
        self.bad(**{**v2, "audio": [sound("b", 96, 110, 2, 1)]})  # b 가 놓인 구간 밖
        self.bad(**{**v2, "audio": [sound("b", 0, 96, 9, 1)]})  # 없는 트랙
        # 1 판에 2 판의 칸이 오면 조용히 버리지 않는다(버리면 0초부터 놓고 완료라고 답한다)
        self.bad(clips=[clip("a", 1, 0, 120, head=24), clip("b", 2, 0, 96)])
        self.bad(clips=[clip("a", 1, 0, 120, head=0), clip("b", 2, 0, 96)])
        self.bad(audio=[sound("b", 0, 96, 2)])

    def test_version_three_carries_speed_and_checks_it(self):
        # 속도(2026-10-23) — 3 판 = 2 판의 칸 + 속도 클립의 speed·src(floor(src × 24 ÷ speed + 1e-6) = 길이) + 그 소리의 speed(운반 클립과 같다)
        fast = sped("b", 2, 0, 96, 1.27, head=24)
        v3 = {"version": 3, "clips": [clip("a", 1, 0, 120, head=0), fast], "audio": [sped_sound("b", 0, 96, 2, 1.27, 1)]}
        out = self.ok(**v3)
        self.assertEqual([(row["speed"], row["src"]) for row in out["clips"]], [(1.0, None), (1.27, 96 / 24 * 1.27)])
        self.assertEqual((out["version"], out["audio"][0]["speed"], out["audio"][0]["track"]), (3, 1.27, 2))
        self.assertEqual(self.ok(**{**v3, "clips": [clip("a", 1, 0, 120, head=0), sped("b", 2, 0, 96, 0.25)], "audio": []})["clips"][1]["speed"], 0.25)

        def with_b(**row):
            return {**v3, "clips": [clip("a", 1, 0, 120, head=0), {**fast, **row}]}

        for value in (5, 0.2, True, float("nan"), "1.5"):
            self.bad(**with_b(speed=value))
        self.bad(**with_b(src=97 / 24 * 1.27))  # 그 원본·속도로는 97프레임이다
        self.bad(**with_b(src=95.9 / 24 * 1.27))  # 95프레임
        self.bad(**with_b(src=0))
        self.bad(**with_b(src=None))
        self.bad(**{**v3, "clips": [clip("a", 1, 0, 120, head=0), {key: value for key, value in fast.items() if key != "src"}]})
        self.bad(**{**v3, "clips": [clip("a", 1, 0, 120, head=0), {key: value for key, value in fast.items() if key != "speed"}]})
        self.bad(**{**v3, "clips": [sped("a", 1, 0, 120, 2.0, head=0) | {"kind": "image"}, fast]})  # 그림에는 속도가 없다
        self.bad(**{**v3, "audio": [sped_sound("b", 0, 96, 2, 1.5, 1)]})  # 운반 클립과 다른 속도
        self.bad(**{**v3, "audio": [sound("b", 0, 96, 2, 1)]})  # 속도 클립의 소리에 속도가 없다
        self.bad(**{**v3, "audio": [sped_sound("b", 0, 97, 2, 1.27, 1)]})  # 운반 클립 밖까지
        # 다른 판에 속도 칸이 오면 조용히 버리지 않는다
        self.bad(**{**v3, "version": 2})
        self.bad(clips=[clip("a", 1, 0, 120), {**clip("b", 2, 0, 96), "speed": 1.27, "src": 96 / 24 * 1.27}])
        self.bad(audio=[{"gen_id": "b", "start": 0, "end": 96, "offset": 0, "speed": 1.27}])
        self.bad(audio=[{"gen_id": "b", "start": 0, "end": 96, "offset": 0, "src": 4.0}])  # 소리에는 어느 판에도 src 가 없다
        self.bad(**{**v3, "audio": [sped_sound("b", 0, 96, 2, 1.27, 1) | {"src": 5.08}]})

    def test_rejects_wrong_shape_before_anything_is_prepared(self):
        self.bad(format="mvhub.resolve-transfer")
        self.bad(version=2)  # 2 판인데 클립에 head 가 없다
        self.bad(version=0)
        self.bad(version="1")
        self.bad(fps=25)
        self.bad(fps=True)
        self.bad(name="  ")
        self.bad(video_tracks=0)
        self.bad(video_tracks=999)
        self.bad(clips=[])
        self.bad(clips="nope")
        self.bad(muted=1)
        self.bad(tracks_off=[9])
        self.bad(total=-1)

    def test_rejects_untrusted_clip_values(self):
        self.bad(clips=[clip("stranger", 1, 0, 10)])  # 이 요청이 보내는 생성물이 아니다
        self.bad(clips=[clip("a", 4, 0, 10)])  # 없는 트랙
        self.bad(clips=[clip("a", 1, 10, 10)])  # 길이 0
        self.bad(clips=[clip("a", 1, -1, 10)])
        self.bad(clips=[clip("a", 1, 0, 10**9)])  # 거대한 프레임
        self.bad(clips=[clip("a", 1, True, 10)])  # bool 은 프레임이 아니다
        self.bad(clips=[clip("a", 1, 0.5, 10)])
        self.bad(clips=[clip("a", 1, 0, 10, enabled="yes")])
        self.bad(clips=[clip("a", 1, 0, 10, kind="audio")])
        self.bad(clips=[clip("a", 1, 0, 100), clip("b", 1, 99, 200)])  # 같은 트랙의 겹침
        self.ok(clips=[clip("a", 1, 0, 100), clip("b", 1, 100, 200)])  # 맞닿는 것은 겹침이 아니다
        self.ok(clips=[clip("a", 1, 0, 100), clip("b", 2, 50, 200)])  # 다른 트랙

    def test_rejects_untrusted_audio_markers_and_marks(self):
        self.bad(audio=[{"gen_id": "a", "start": 0, "end": 10, "offset": float("nan")}])
        self.bad(audio=[{"gen_id": "a", "start": 0, "end": 10, "offset": -1}])
        self.bad(audio=[{"gen_id": "a", "start": 0, "end": 10, "offset": True}])
        self.bad(audio=[{"gen_id": "a", "start": 0, "end": 50, "offset": 0}, {"gen_id": "b", "start": 49, "end": 90, "offset": 0}])
        self.bad(audio=[{"gen_id": "nope", "start": 0, "end": 10, "offset": 0}])
        self.bad(markers=[{"frame": 1, "color": "Orange", "name": ""}])
        self.bad(markers=[{"frame": -1, "color": "Red", "name": ""}])
        self.bad(markers=[{"frame": 1, "color": "Red", "name": 5}])
        self.bad(mark={"in": 10, "out": 10})
        self.bad(mark="all")


class BuildTimelineTests(unittest.TestCase):
    def setUp(self):
        self.project = FakeProject()
        self.pool = self.project.media_pool
        self.manager = FakeProjectManager(self.project)
        self.resolve = FakeResolve(self.manager)
        self.user_folder = self.pool.root.child("사용자 폴더")
        self.pool.current = self.user_folder
        self.items: list[dict] = []
        self.managed = self.pool.root.child("MV Hub").child("프로젝트_테스트")

    def add(self, gen_id: str, folder: str = "e035/C0010", **clip_kwargs) -> FakeClip:
        """가져오기가 끝난 상태 — manifest 항목과 그 Bin 의 클립."""
        path = str(Path("D:/render") / folder / f"{gen_id}.mp4")
        target = self.managed
        for part in folder.split("/"):
            target = target.child(part)
        made = FakeClip(path, **clip_kwargs)
        target.clips.append(made)
        self.items.append({"generation_id": gen_id, "folder_path": folder, "local_path": path, "filename": f"{gen_id}.mp4", "status": "skipped"})
        return made

    def manifest(self, **more):
        return {"project_id": "p1", "project_name": "프로젝트/테스트", "items": self.items,
                "resolve_target": {"project_id": "resolve-project-1", "project_name": "임시 테스트"}, **more}

    def build(self, raw_plan, **more):
        checked = validate_plan(copy.deepcopy(raw_plan), {item["generation_id"] for item in self.items})
        return build_timeline(self.manifest(**more), checked, resolve=self.resolve)

    def lane(self, timeline, kind, index):
        base = timeline.GetStartFrame()
        return [(item.clip.path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1], item.start - base, item.duration, item.left)
                for item in timeline.GetItemListInTrack(kind, index)]

    def test_builds_the_layout_frame_for_frame(self):
        self.add("low", frames=144)
        self.add("top", frames=96)
        self.add("third", "e035/C0030", frames=240)
        self.add("pal", "e035/C0040", fps=25.0, frames=125)  # 25fps 5초 → 타임라인 120프레임
        self.add("still", "e035/C0050", still=True)
        self.add("mute", "e035/C0060", frames=120, audio=0)
        result = self.build(plan(
            [clip("low", 1, 0, 144), clip("top", 2, 0, 96), clip("third", 1, 264, 504),  # 144~264 는 빈 컷
             clip("pal", 1, 504, 624), clip("still", 1, 624, 744, kind="image"), clip("mute", 3, 744, 864, enabled=False)],
            audio=[{"gen_id": "top", "start": 0, "end": 96, "offset": 0}, {"gen_id": "low", "start": 96, "end": 144, "offset": 4},
                   {"gen_id": "third", "start": 264, "end": 504, "offset": 0}, {"gen_id": "pal", "start": 504, "end": 624, "offset": 0},
                   {"gen_id": "mute", "start": 744, "end": 864, "offset": 0}],
            markers=[{"frame": 12, "color": "Blue", "name": "첫 표시"}, {"frame": 264, "color": "Red", "name": ""}],
            mark={"in": 264, "out": 504}, off=[3], locked=[2], muted=True,
        ))
        self.assertEqual((result["status"], result["error"], result["mismatches"], result["warnings"]), ("complete", None, [], []))
        timeline = self.project.timelines[0]
        self.assertEqual((result["timeline_name"], result["timeline_id"]), ("뻘뻘뻘_e035", timeline.unique_id))
        self.assertEqual(self.lane(timeline, "video", 1), [
            ("low.mp4", 0, 144, 0), ("third.mp4", 264, 240, 0), ("pal.mp4", 504, 120, 0), ("still.mp4", 624, 120, 0),
        ])
        self.assertEqual(self.lane(timeline, "video", 2), [("top.mp4", 0, 96, 0)])
        self.assertEqual(self.lane(timeline, "video", 3), [("mute.mp4", 744, 120, 0)])
        # 소리 = 보이는 영상 하나의 것. 아래 클립은 소스의 4초(96프레임)부터, 소리 없는 영상은 넣지 않는다
        self.assertEqual(self.lane(timeline, "audio", 1), [
            ("top.mp4", 0, 96, 0), ("low.mp4", 96, 48, 96), ("third.mp4", 264, 240, 0), ("pal.mp4", 504, 120, 0),
        ])
        self.assertEqual((result["video"], result["audio"]), (6, 4))
        # recordFrame 은 절대 좌표, endFrame 은 소스 프레임(끝 미포함)
        first = self.pool.append_calls[0][0]
        self.assertEqual((first["recordFrame"], first["startFrame"], first["endFrame"], first["mediaType"], first["trackIndex"]), (86400, 0, 144, 1, 1))
        pal = next(info for call in self.pool.append_calls for info in call if info["mediaPoolItem"].path.endswith("pal.mp4") and info["mediaType"] == 1)
        self.assertEqual(pal["endFrame"], 125)
        # 끈 클립·끈 트랙·소리 끔·잠금(맨 끝)·북마크·인/아웃(out 은 포함 프레임)
        self.assertFalse(timeline.GetItemListInTrack("video", 3)[0].enabled)
        self.assertEqual((timeline.video_off, timeline.audio_off, timeline.locked), ({3}, {1}, {2}))
        self.assertEqual(timeline.markers, {12: {"color": "Blue", "name": "첫 표시", "duration": 1}, 264: {"color": "Red", "name": "", "duration": 1}})
        self.assertEqual(timeline.mark, (264, 503, "all"))
        self.assertEqual((result["markers_added"], result["markers_skipped"], result["mark"], result["saved"]), (2, 0, True, True))
        # 타임라인은 MV Hub/<프로젝트> Bin 에, 현재 Bin 은 원래대로, 새 타임라인은 현재 타임라인으로 남는다
        self.assertIs(self.pool.timeline_folders["뻘뻘뻘_e035"], self.managed)
        self.assertIs(self.pool.current, self.user_folder)
        self.assertIs(self.project.current_timeline, timeline)
        self.assertEqual(self.manager.saved, 1)

    def test_a_second_send_makes_another_timeline(self):
        self.add("a", frames=120)
        raw = plan([clip("a", 1, 0, 120)], tracks=1)
        self.assertEqual(self.build(raw)["timeline_name"], "뻘뻘뻘_e035")
        self.assertEqual(self.build(raw)["timeline_name"], "뻘뻘뻘_e035_2")
        self.assertEqual(self.build(raw)["timeline_name"], "뻘뻘뻘_e035_3")
        self.assertEqual([len(timeline.video[0]) for timeline in self.project.timelines], [1, 1, 1])  # 앞의 것은 그대로

    def test_matches_fps_before_reading_the_start_frame(self):
        self.project.fps = 25.0  # 프로젝트가 25fps — 새 타임라인만 24fps 로
        self.add("a", frames=120)
        result = self.build(plan([clip("a", 1, 48, 168)], tracks=1))
        timeline = self.project.timelines[0]
        self.assertEqual((result["status"], timeline.settings["timelineFrameRate"], timeline.settings["useCustomSettings"]), ("complete", 24.0, "1"))
        self.assertEqual(self.pool.append_calls[0][0]["recordFrame"], 86400 + 48)  # 25fps 의 시작(90000)이 아니다
        self.assertEqual(self.project.fps, 25.0)  # 프로젝트 fps 는 건드리지 않는다

    def test_stops_before_placing_when_fps_cannot_be_set(self):
        self.project.fps = 30.0
        self.project.timeline_fps_settable = False
        self.add("a", frames=120)
        result = self.build(plan([clip("a", 1, 0, 120)], tracks=1))
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("partial", "timeline_fps", "fps"))
        self.assertEqual(result["timeline_name"], "뻘뻘뻘_e035")  # 만든 타임라인은 지우지 않는다 — 이름을 알려 준다
        self.assertEqual((self.pool.append_calls, self.manager.saved), ([], 0))

    def test_nothing_is_created_when_a_clip_is_not_in_the_media_pool(self):
        self.add("a", frames=120)
        self.items.append({"generation_id": "ghost", "folder_path": "e035/C0090", "local_path": "D:/render/e035/C0090/ghost.mp4", "status": "downloaded"})
        result = self.build(plan([clip("a", 1, 0, 120), clip("ghost", 1, 120, 240)], tracks=1))
        self.assertEqual((result["status"], result["error_code"], result["step"], result["timeline_name"]), ("failed", "clip_missing", "locate", ""))
        self.assertEqual((self.project.timelines, self.manager.saved), ([], 0))
        self.assertIs(self.pool.current, self.user_folder)

    def test_refuses_when_the_real_video_is_shorter_than_planned(self):
        # 적힌 길이 10초, 실제 6초 — 편집 탭은 실제 끝에서 건너뛰지만 Resolve 는 그 사이 아래 트랙을 보인다
        self.add("short", frames=144)
        self.add("under", frames=288)
        result = self.build(plan([clip("under", 1, 0, 288), clip("short", 2, 0, 240)]))
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("failed", "source_shorter", "measure"))
        self.assertEqual(result["short_sources"], [{"gen_id": "short", "track": 2, "start": 0, "planned": 240, "actual": 144}])
        self.assertEqual(self.project.timelines, [])

    def test_a_source_one_frame_short_is_placed_but_not_called_complete(self):
        # 한 프레임 이내로 모자란 원본은 있는 만큼 넣는다(막으면 보낼 길이 없다) — 다만 끝이 비므로 '계획대로'가 아니다(Codex 코드 리뷰:
        #  줄여 넣은 길이를 기대값으로 삼아 complete 라고 했다).
        self.add("near", "e035/C0020", frames=239)
        self.add("ntsc", "e035/C0030", fps=30.0, frames=149)  # 5초(150프레임)에 한 프레임 모자란다 — fps 가 달라도 봐주지 않는다
        result = self.build(plan(
            [clip("near", 1, 0, 240), clip("ntsc", 1, 240, 360)],
            audio=[{"gen_id": "near", "start": 0, "end": 240, "offset": 0}], tracks=1,
        ))
        timeline = self.project.timelines[0]
        self.assertEqual(self.lane(timeline, "video", 1), [("near.mp4", 0, 239, 0), ("ntsc.mp4", 240, 119, 0)])
        self.assertEqual(result["status"], "partial")
        self.assertEqual(
            [(row["track"], row["gen_id"], row["start"], row["expected"], row["actual"], row["short"]) for row in result["mismatches"]],
            [("V1", "near", 0, 240, 239, True), ("V1", "ntsc", 240, 120, 119, True), ("A1", "near", 0, 240, 239, True)],
        )
        self.assertEqual((result["error"], result["saved"]), (None, True))  # 멈춘 것이 아니다 — 끝까지 짓고 다른 점을 알린다

    def test_a_disabled_clip_that_went_in_short_is_still_disabled(self):
        # 길이가 맞을 때만 클립을 쥐면, 짧게 들어간 꺼 둔 클립이 켜진 채 남는다(Codex 코드 리뷰)
        self.add("near", frames=119)
        result = self.build(plan([clip("near", 1, 0, 120, enabled=False)], tracks=1))
        item = self.project.timelines[0].GetItemListInTrack("video", 1)[0]
        self.assertFalse(item.enabled)
        self.assertEqual((result["status"], result["warnings"]), ("partial", []))  # 다른 점은 길이뿐 — 끄기는 됐다
        self.assertEqual([(row["gen_id"], row["short"]) for row in result["mismatches"]], [("near", True)])

    def test_frames_round_half_up_like_the_planner(self):
        # 파이썬의 round 는 반을 짝수로 보낸다(121.5 → 122, 238.5 → 238) — 프런트의 Math.round 와 달라 반 프레임 경계에서 한 프레임이 사라졌다
        self.assertEqual([_frame(121.5), _frame(238.5), _frame(0.49), _frame(120.0)], [122, 239, 0, 120])
        # Codex 의 반례: 위 = 48fps 영상(계획 122프레임), 아래 = 24fps 239프레임. 아래 소리 [122, 239) 는 117프레임이어야 한다.
        #  위는 244프레임이다 — 반례의 243프레임(5.0625초)은 122프레임에 반 프레임 모자라, 내림으로 환산하는 Resolve(실측 4)에서는
        #  121프레임으로 들어간다(그것은 '원본이 짧음'으로 따로 알린다 — test_a_source_one_frame_short…)
        self.add("upper", fps=48.0, frames=244)
        self.add("lower", "e035/C0020", frames=239)
        result = self.build(plan(
            [clip("lower", 1, 0, 239), clip("upper", 2, 0, 122)],
            audio=[{"gen_id": "upper", "start": 0, "end": 122, "offset": 0}, {"gen_id": "lower", "start": 122, "end": 239, "offset": 5.0625}],
        ))
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("upper.mp4", 0, 122, 0), ("lower.mp4", 122, 117, 122)])
        self.assertEqual((result["status"], result["mismatches"]), ("complete", []))

    def test_audio_starts_where_its_picture_is_on_the_timeline(self):
        # 소리의 소스 시작은 그 영상 클립이 놓인 프레임에서 센다 — 초로 적힌 offset(4.98초 → 119.52 → 120)을 따로 반올림하면
        #  그림(타임라인 119프레임째 = 소스 119)과 한 프레임 어긋난다
        self.add("a", frames=240)
        result = self.build(plan([clip("a", 1, 0, 240)], audio=[{"gen_id": "a", "start": 119, "end": 240, "offset": 4.98}], tracks=1))
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("a.mp4", 119, 121, 119)])
        self.assertEqual(result["status"], "complete")
        # 그 클립을 계획에서 못 찾으면 적힌 offset 으로 — 양끝을 같은 규칙으로 반올림한다([122, 239) = 117프레임)
        self.setUp()
        self.add("a", frames=600)
        self.build(plan([clip("a", 1, 300, 540)], audio=[{"gen_id": "a", "start": 122, "end": 239, "offset": 5.0625}], tracks=1))
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("a.mp4", 122, 117, 122)])

    # ── 앞 자르기(2026-10-14) — 클립이 소스의 중간에서 시작한다 ────────────────────────────────────────
    def test_a_clip_can_start_inside_its_source(self):
        # top 은 원본 1~3초, ntsc(30fps)는 원본 2~4초. 영상과 소리가 같은 소스 프레임에서 시작하고 같이 끝난다
        self.add("low", frames=192)
        self.add("top", frames=120)
        self.add("ntsc", "e035/C0020", fps=30.0, frames=300)
        result = self.build(plan(
            [clip("low", 1, 0, 192, head=0), clip("top", 2, 0, 48, head=24), clip("ntsc", 1, 192, 240, head=48)],
            audio=[sound("top", 0, 48, 2, 1), sound("low", 48, 192, 1, 2), sound("ntsc", 192, 240, 1, 2)], version=2,
        ))
        self.assertEqual((result["status"], result["mismatches"], result["warnings"]), ("complete", [], []))
        timeline = self.project.timelines[0]
        self.assertEqual(self.lane(timeline, "video", 1), [("low.mp4", 0, 192, 0), ("ntsc.mp4", 192, 48, 60)])  # 30fps 의 2초 = 소스 60프레임
        self.assertEqual(self.lane(timeline, "video", 2), [("top.mp4", 0, 48, 24)])
        self.assertEqual(self.lane(timeline, "audio", 1), [("top.mp4", 0, 48, 24), ("low.mp4", 48, 144, 48), ("ntsc.mp4", 192, 48, 60)])
        ranges = {(info["mediaPoolItem"].path.rsplit("\\", 1)[-1].rsplit("/", 1)[-1], info["mediaType"]): (info["startFrame"], info["endFrame"])
                  for call in self.pool.append_calls for info in call}
        self.assertEqual((ranges[("top.mp4", 1)], ranges[("top.mp4", 2)]), ((24, 72), (24, 72)))
        self.assertEqual((ranges[("ntsc.mp4", 1)], ranges[("ntsc.mp4", 2)]), ((60, 120), (60, 120)))

    def test_picture_and_sound_use_one_source_frame_rule(self):
        # Codex 설계 검토: 시작과 끝을 따로 반올림하면 30fps 원본의 [1프레임에서 시작 · 1프레임 길이]가 영상과 소리에서 갈린다.
        #  끝은 둘 다 시작에서 센 **올림**이다(2026-10-23 — 1.25 소스 프레임 → 2: 내림으로 환산하는 Resolve 에서 타임라인 1프레임이 된다)
        self.add("ntsc", fps=30.0, frames=300)
        self.add("next", "e035/C0020", frames=240)
        result = self.build(plan([clip("ntsc", 1, 0, 1, head=1), clip("next", 1, 1, 241, head=0)], audio=[sound("ntsc", 0, 1, 1, 1 / 24)], version=2, tracks=1))
        calls = [info for call in self.pool.append_calls for info in call if info["mediaPoolItem"].path.endswith("ntsc.mp4")]
        self.assertEqual([(info["mediaType"], info["startFrame"], info["endFrame"]) for info in calls], [(1, 1, 3), (2, 1, 3)])
        self.assertEqual((result["status"], result["mismatches"]), ("complete", []))

    def test_refuses_when_the_start_point_leaves_too_little_source(self):
        self.add("a", frames=120)  # 5초
        result = self.build(plan([clip("a", 1, 0, 96, head=48)], version=2, tracks=1))  # 2초부터 4초를 쓰겠다 — 남은 것은 3초다
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("failed", "source_shorter", "measure"))
        self.assertEqual(result["short_sources"], [{"gen_id": "a", "track": 1, "start": 0, "planned": 96, "actual": 72}])
        self.setUp()
        self.add("a", frames=120)
        # 시작점이 원본의 끝이다 — 넣을 것이 한 프레임도 없다('한 프레임 모자람'으로 넘기지 않는다)
        result = self.build(plan([clip("a", 1, 0, 1, head=120)], version=2, tracks=1))
        self.assertEqual((result["error_code"], result["short_sources"][0]["actual"]), ("source_shorter", 0))
        self.assertEqual(self.project.timelines, [])

    def test_the_reread_checks_where_a_trimmed_clip_starts(self):
        self.add("a", frames=240)
        original = FakeMediaPool.AppendToTimeline

        def from_zero(pool, infos):  # Resolve 가 시작점을 무시하고 0초부터 놓았다(길이는 같다)
            return original(pool, [{**info, "startFrame": 0, "endFrame": info["endFrame"] - info.get("startFrame", 0)} for info in infos])

        FakeMediaPool.AppendToTimeline = from_zero
        try:
            result = self.build(plan([clip("a", 1, 0, 96, head=48)], version=2, tracks=1))
        finally:
            FakeMediaPool.AppendToTimeline = original
        self.assertEqual(result["status"], "partial")  # 자리와 길이가 맞아도 다른 구간이다
        self.assertEqual([(row["track"], row["gen_id"], row["expected"], row["actual"], row["short"]) for row in result["mismatches"]],
                         [("V1", "a", 96, 96, False)])
        # 시작점을 되읽지 못하면(API 가 없다) 완료라고 하지 않는다 — 경고를 남긴다
        self.setUp()
        self.add("a", frames=240)
        with mock.patch.object(FakeItem, "GetLeftOffset", None):
            result = self.build(plan([clip("a", 1, 0, 96, head=48)], version=2, tracks=1))
        self.assertEqual((result["status"], result["mismatches"]), ("partial", []))
        self.assertEqual(result["warnings"], ["앞을 자른 클립 1개의 시작점을 Resolve 에서 확인하지 못했습니다(타임라인에서 직접 확인하세요)"])
        # 앞을 자르지 않은 영상은 되읽지 못해도 전과 같다(완료)
        self.setUp()
        self.add("a", frames=240)
        with mock.patch.object(FakeItem, "GetLeftOffset", None):
            self.assertEqual(self.build(plan([clip("a", 1, 0, 96)], tracks=1))["status"], "complete")

    def test_sound_follows_its_own_picture_when_one_source_is_on_two_tracks(self):
        # Codex 설계 검토: 같은 생성물이 두 트랙에 있으면(옛 id 와 새 id 가 같은 것으로 이어진 문서) 먼저 찾은 클립의 시작점을 쓰면 안 된다
        self.add("a", frames=240)
        result = self.build(plan([clip("a", 1, 0, 96, head=0), clip("a", 2, 0, 48, head=48)],
                                 audio=[sound("a", 0, 48, 2, 2), sound("a", 48, 96, 1, 2)], version=2))
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("a.mp4", 0, 48, 48), ("a.mp4", 48, 48, 48)])
        self.assertEqual(result["status"], "complete")

    def test_a_marker_resolve_refuses_is_not_called_complete(self):
        self.add("a", frames=120)
        original = FakeTimeline.AddMarker
        FakeTimeline.AddMarker = lambda timeline, *args: False
        try:
            result = self.build(plan([clip("a", 1, 0, 120)], markers=[{"frame": 12, "color": "Blue", "name": ""}], tracks=1))
        finally:
            FakeTimeline.AddMarker = original
        self.assertEqual((result["status"], result["markers_added"], result["markers_skipped"]), ("partial", 0, 1))
        self.assertEqual(result["warnings"], ["북마크 1개는 Resolve 가 받지 않았습니다"])

    def test_audio_source_range_uses_the_clip_fps(self):
        self.add("ntsc", fps=30.0, frames=450)  # 15초
        # 5~10초 구간의 소리 → 소스 [150, 300)
        result = self.build(plan([clip("ntsc", 1, 0, 360)], audio=[{"gen_id": "ntsc", "start": 120, "end": 240, "offset": 5}], tracks=1))
        self.assertEqual(result["status"], "complete")
        sound = self.pool.append_calls[1][0]
        self.assertEqual((sound["startFrame"], sound["endFrame"], sound["mediaType"], sound["trackIndex"], sound["recordFrame"]), (150, 300, 2, 1, 86400 + 120))
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("ntsc.mp4", 120, 120, 150)])

    def test_reports_partial_when_the_reread_layout_differs(self):
        self.add("a", frames=240)
        self.add("b", "e035/C0020", frames=240)
        original = FakeMediaPool.AppendToTimeline

        def shifted(pool, infos):  # Resolve 가 둘째 클립을 다른 자리에 놓았다
            return original(pool, [{**info, "recordFrame": info["recordFrame"] + (7 if index else 0)} for index, info in enumerate(infos)])

        FakeMediaPool.AppendToTimeline = shifted
        try:
            result = self.build(plan([clip("a", 1, 0, 240), clip("b", 1, 240, 480)], tracks=1))
        finally:
            FakeMediaPool.AppendToTimeline = original
        self.assertEqual(result["status"], "partial")
        # 자리가 틀어진 것은 '원본이 짧아 끝만 빈 것'(short)이 아니다
        self.assertEqual([(row["track"], row["gen_id"], row["start"], row["expected"], row["actual"], row["short"]) for row in result["mismatches"]],
                         [("V1", "b", 240, 240, None, False), ("V1", "", 247, None, 240, False)])
        self.assertEqual(result["timeline_name"], "뻘뻘뻘_e035")

    def test_reports_partial_when_required_state_is_not_applied(self):
        self.add("a", frames=120)
        self.manager.save_result = False
        result = self.build(plan([clip("a", 1, 0, 120, enabled=False)], tracks=1, locked=[1]))
        timeline = self.project.timelines[0]
        self.assertEqual((result["status"], result["saved"]), ("partial", False))
        self.assertIn("저장", result["warnings"][-1])
        # 끄기가 실패한 경우 — 꺼 둔 영상이 살아 있으면 편집 탭에서 보던 것과 다르다
        self.setUp()
        self.add("a", frames=120)
        original = FakeItem.SetClipEnabled
        FakeItem.SetClipEnabled = lambda item, enabled: False
        try:
            result = self.build(plan([clip("a", 1, 0, 120, enabled=False)], tracks=1))
        finally:
            FakeItem.SetClipEnabled = original
        self.assertEqual(result["status"], "partial")
        self.assertIn("꺼 둔 클립", result["warnings"][0])
        self.assertIs(timeline, timeline)

    def test_stops_when_the_user_opens_another_timeline(self):
        self.add("a", frames=120)
        self.add("b", "e035/C0020", frames=120)
        other = FakeTimeline("사용자 타임라인", 24.0)
        self.project.timelines.append(other)
        original = FakeMediaPool.AppendToTimeline
        calls = []

        def switch_after_first(pool, infos):
            calls.append(len(infos))
            placed = original(pool, infos)
            pool.project.current_timeline = other  # 첫 트랙을 넣은 뒤 사용자가 다른 타임라인을 열었다
            return placed

        FakeMediaPool.AppendToTimeline = switch_after_first
        try:
            result = self.build(plan([clip("a", 1, 0, 120), clip("b", 2, 0, 120)]))
        finally:
            FakeMediaPool.AppendToTimeline = original
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("partial", "timeline_changed", "video"))
        self.assertEqual(calls, [1])  # 둘째 트랙은 넣지 않았다
        self.assertEqual((other.video, self.manager.saved), ([[]], 0))  # 남의 타임라인은 건드리지 않고 저장도 하지 않는다
        self.assertIs(self.project.current_timeline, other)  # 되돌리지 않는다

    def test_stops_when_the_project_changes(self):
        self.add("a", frames=120)
        elsewhere = FakeProject("다른 프로젝트", "resolve-project-2")
        result = build_timeline(
            self.manifest(), validate_plan(plan([clip("a", 1, 0, 120)], tracks=1), {"a"}), resolve=FakeResolve(FakeProjectManager(elsewhere)),
        )
        self.assertEqual((result["status"], result["error_code"], elsewhere.timelines), ("unavailable", "project_changed", []))
        # 만든 뒤에 바뀐 경우 — ProjectManager 에 다시 물어 본다(처음 받은 project 객체만 보면 놓친다)
        original = FakeMediaPool.CreateEmptyTimeline

        def create_then_switch(pool, name):
            timeline = original(pool, name)
            self.manager.project = elsewhere
            return timeline

        FakeMediaPool.CreateEmptyTimeline = create_then_switch
        try:
            result = self.build(plan([clip("a", 1, 0, 120)], tracks=1))
        finally:
            FakeMediaPool.CreateEmptyTimeline = original
        self.assertEqual((result["status"], result["error_code"]), ("partial", "project_changed"))
        self.assertEqual((self.pool.append_calls, self.manager.saved, elsewhere.timelines), ([], 0, []))

    def test_finds_clips_by_normalized_path_without_creating_bins(self):
        made = self.add("a", frames=120)
        made.path = made.path.upper()  # Resolve 가 다른 표기로 기록했다
        self.assertEqual(_normal_path(made.path), _normal_path(self.items[0]["local_path"]))
        before = [child.name for child in self.managed.children]
        self.assertEqual(self.build(plan([clip("a", 1, 0, 120)], tracks=1))["status"], "complete")
        self.assertEqual([child.name for child in self.managed.children], before)

    # ── 속도(2026-10-23 Ctrl+R) · 100% 끝 올림 ───────────────────────────────────────────────────────
    def speed_items(self, kind="video", index=1):
        return self.project.timelines[0].GetItemListInTrack(kind, index)

    def test_full_speed_clips_go_in_with_a_rounded_up_end(self):
        # 실측 4: 반올림으로 넣으면 fps 가 다른 원본이 1프레임 짧게 들어갔다(30fps head 12 · 37 → 36, 25fps 50 → 49). 올리면 정확하다
        self.add("ntsc", fps=30.0, frames=300)
        self.add("pal", "e035/C0020", fps=25.0, frames=250)
        result = self.build(plan([clip("ntsc", 1, 0, 37, head=12), clip("pal", 1, 37, 87, head=0)],
                                 audio=[sound("ntsc", 0, 37, 1, 0.5)], version=2, tracks=1))
        self.assertEqual((result["status"], result["mismatches"]), ("complete", []))
        self.assertEqual(self.lane(self.project.timelines[0], "video", 1), [("ntsc.mp4", 0, 37, 15), ("pal.mp4", 37, 50, 0)])
        self.assertEqual(self.lane(self.project.timelines[0], "audio", 1), [("ntsc.mp4", 0, 37, 15)])
        ranges = [(info["startFrame"], info["endFrame"]) for call in self.pool.append_calls for info in call]
        self.assertEqual(ranges, [(15, 62), (0, 53), (15, 62)])  # 46.25 → 47 · 52.08 → 53
        # 정수에 아주 가까운 값은 하나 더 올리지 않는다(25fps 24프레임 = 25.0) · 속도 뒤의 끝은 내림(실측 48 × 1.27 → +60)
        self.assertEqual([resolve_timeline._full_end(0, 24, 25.0), resolve_timeline._full_end(0, 48, 30.0)], [25, 60])
        self.assertEqual([resolve_timeline._speed_end(0, 48, 24.0, 1.25), resolve_timeline._speed_end(10, 48, 24.0, 1.27),
                          resolve_timeline._speed_end(0, 48, 30.0, 1.27), resolve_timeline._speed_end(0, 10, 24.0, 0.7)], [60, 70, 76, 7])

    def test_a_speed_clip_goes_in_at_its_planned_length_then_gets_its_speed(self):
        self.add("a", frames=240)
        self.add("ntsc", "e035/C0020", fps=30.0, frames=300)
        result = self.build(plan(
            [sped("a", 1, 0, 48, 1.27), sped("ntsc", 1, 48, 96, 1.27, enabled=False)],
            audio=[sped_sound("a", 0, 48, 1, 1.27)], version=3, tracks=1,
        ))
        self.assertEqual((result["status"], result["mismatches"], result["speed_failed"], result["warnings"]), ("complete", [], [], []))
        self.assertEqual(result["speed_applied"], 3)
        # 100% 로 계획 길이만큼 넣고(a [0, 48) · 30fps [0, 60)) 속도를 건다 — 길이는 그대로, 원본 끝이 바뀐다(+60 · +76)
        self.assertEqual([(info["startFrame"], info["endFrame"]) for call in self.pool.append_calls for info in call], [(0, 48), (0, 60), (0, 48)])
        video = self.speed_items()
        self.assertEqual([(item.duration, item.source_end, round(item.speed["Percentage"], 6)) for item in video], [(48, 60, 127.0), (48, 76, 127.0)])
        self.assertFalse(video[1].enabled)  # 꺼 둔 속도 클립도 속도를 걸고 꺼 둔다
        sound_item = self.speed_items("audio")[0]
        self.assertEqual((sound_item.source_end, sound_item.speed["PitchCorrection"]), (60, True))  # 소리는 음 높이 유지
        self.assertNotIn("PitchCorrection", video[0].speed)

    def test_a_slow_clip_may_end_exactly_at_its_source_end(self):
        # 원본 40프레임에 50% × 80프레임 = 원본을 끝까지 쓴다(E = 40). 100% 끝(80)은 원본을 넘어도 넣는다 — 속도를 걸면 원본 안으로 들어온다.
        #  Resolve 는 원본 끝을 끝 프레임(39)으로 읽는다(실측) — 그것은 맞다
        self.add("a", frames=40)
        result = self.build(plan([sped("a", 1, 0, 80, 0.5)], audio=[sped_sound("a", 0, 80, 1, 0.5)], version=3, tracks=1))
        self.assertEqual((result["status"], result["speed_failed"], result["speed_applied"]), ("complete", [], 2))
        self.assertEqual([(item.duration, item.source_end) for item in self.speed_items()], [(80, 39)])
        # 한 프레임이라도 원본을 넘으면 만들지 않는다(E = 41 > 40)
        self.setUp()
        self.add("a", frames=40)
        result = self.build(plan([sped("a", 1, 0, 82, 0.5)], version=3, tracks=1))
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("failed", "source_shorter", "measure"))
        self.assertEqual(result["short_sources"], [{"gen_id": "a", "track": 1, "start": 0, "planned": 82, "actual": 80}])
        self.assertEqual(self.project.timelines, [])

    def test_a_refused_unreadable_or_different_speed_is_reported_and_the_rest_go_on(self):
        raw = plan([sped("a", 1, 0, 48, 2.0), sped("b", 1, 48, 96, 0.5)], version=3, tracks=1)
        original = FakeItem.SetSpeed
        cases = [
            ("SetSpeed", lambda item, options: False if item.clip.path.endswith("a.mp4") else original(item, options), "set"),
            ("speed_reply", "none", "unread"),
            ("speed_reply", "empty", "unread"),
            ("speed_reply", "nan", "unread"),  # NaN 은 어떤 비교도 거짓이라 '맞음'으로 새면 안 된다(Codex 독립 리뷰)
            ("speed_reply", "inf", "unread"),
            ("GetSourceEndFrame", lambda item: item.source_end + (1 if item.clip.path.endswith("a.mp4") else 0), "readback"),
            ("GetSourceEndFrame", lambda item: None if item.clip.path.endswith("a.mp4") else item.source_end, "unread"),
        ]
        for attribute, value, reason in cases:
            with self.subTest(reason=reason, attribute=attribute):
                self.setUp()
                self.add("a", frames=240)
                self.add("b", "e035/C0020", frames=240)
                with mock.patch.object(FakeItem, attribute, value):
                    result = self.build(raw)
                failed = [(row["gen_id"], row["reason"]) for row in result["speed_failed"]]
                self.assertEqual(result["status"], "partial")  # 완료라고 하지 않는다
                self.assertEqual(failed, [("a", reason)] if attribute != "speed_reply" else [("a", reason), ("b", reason)])
                self.assertEqual(result["speed_applied"], 2 - len(failed))  # 나머지는 계속 걸었다
                self.assertEqual((result["error"], result["saved"]), (None, True))
                self.assertTrue(result["warnings"])

    def test_no_speed_is_applied_when_any_speed_clip_is_not_where_planned(self):
        # 걸기 전 확인 — 미디어 풀 아이템(또는 자리·길이·원본 시작)이 하나라도 다르면 하나도 걸지 않는다(Codex 5차)
        self.add("a", frames=240)
        self.add("b", "e035/C0020", frames=240)
        stranger = FakeClip("D:/elsewhere/x.mp4")
        original = FakeItem.GetMediaPoolItem
        with mock.patch.object(FakeItem, "GetMediaPoolItem", lambda item: stranger if item.clip.path.endswith("b.mp4") else original(item)):
            result = self.build(plan([sped("a", 1, 0, 48, 2.0), sped("b", 1, 48, 96, 0.5)], version=3, tracks=1))
        self.assertEqual(result["status"], "partial")
        # 결과 줄은 빠짐없이 — 다른 것(mismatch)과 그 때문에 걸지 않은 것(skipped)
        self.assertEqual([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], [("a", "skipped"), ("b", "mismatch")])
        self.assertEqual((result["speed_applied"], [item.speed for item in self.speed_items()]), (0, [None, None]))
        self.assertIn("1개가 계획한 자리·원본과 달라 속도를 하나도 걸지 않았습니다", result["warnings"][0])
        # 원본 시작을 읽지 못해도(API 가 없다) · 미디어 풀 아이템 id 를 둘 다 못 읽어도("" — 같은 것으로 치면 안 된다) 식별이 불확실하다
        #  · 원본 시작이 숫자가 아니다(None) — 읽지 못한 것이지 예외가 아니다
        for attribute, owner, value in (("GetSourceStartFrame", FakeItem, None), ("GetUniqueId", FakeClip, lambda _clip: ""),
                                        ("GetSourceStartFrame", FakeItem, lambda _item: None)):
            with self.subTest(attribute=attribute, value=value):
                self.setUp()
                self.add("a", frames=240)
                with mock.patch.object(owner, attribute, value):
                    result = self.build(plan([sped("a", 1, 0, 48, 2.0)], version=3, tracks=1))
                self.assertEqual(([row["reason"] for row in result["speed_failed"]], result["speed_applied"]), (["mismatch"], 0))
        # 걸기 전 확인 도중 Resolve 호출이 예외를 던졌다 — 하나도 걸지 않고 모든 대상을 결과 줄에 적은 채 멈춘다(Codex 독립 리뷰 2차)
        for attribute, owner in (("GetSourceStartFrame", FakeItem), ("GetUniqueId", FakeClip)):
            with self.subTest(raising=attribute):
                self.setUp()
                self.add("a", frames=240)
                self.add("b", "e035/C0020", frames=240)

                def boom(*_args):
                    raise RuntimeError("Resolve 연결이 끊겼습니다")

                with mock.patch.object(owner, attribute, boom):
                    result = self.build(plan([sped("a", 1, 0, 48, 2.0), sped("b", 1, 48, 96, 0.5)], version=3, tracks=1))
                self.assertEqual((result["status"], result["error_code"], result["step"]), ("partial", "unexpected_error", "speed"))
                self.assertEqual([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], [("a", "stopped"), ("b", "stopped")])
                self.assertEqual([item.speed for item in self.speed_items()], [None, None])

    def test_a_speed_clip_whose_source_cannot_fill_one_frame_is_not_built(self):
        # 원본 2프레임에 400% — 앱은 그 클립을 한 프레임으로 둔다(문서를 버리지 않는다). 프런트 계획은 정확히 아래 줄이다
        #  (editSpeed.test.tsx '0프레임이 된 속도 클립' — dur 2/24 · speed 4 → start 0 · end 1 · head 0 · speed 4 · src 4/24).
        #  그 한 프레임을 400% 로 채우려면 원본이 4프레임 있어야 한다(E = 4 > 2) — 100% 클립의 '실제 영상이 적힌 길이보다 짧음'과 같은 규칙으로
        #  만들지 않는다(편집 탭은 그 틈을 건너뛰지만 Resolve 에는 다른 것이 보인다).
        self.add("tiny", frames=2)
        result = self.build(plan([sped("tiny", 1, 0, 1, 4.0)], version=3, tracks=1))
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("failed", "source_shorter", "measure"))
        self.assertEqual(result["short_sources"], [{"gen_id": "tiny", "track": 1, "start": 0, "planned": 1, "actual": 0}])
        self.assertEqual(self.project.timelines, [])
        # 같은 원본 2프레임에 210% — 앱은 floor(2 ÷ 2.1) = 0 이라 한 프레임으로 둔다. 그 한 프레임은 원본 floor(1 × 2.1) = 2프레임으로 **채워진다**
        #  (Resolve 의 내림 — 실측 1·4) → 만든다. 앱도 Resolve 도 한 프레임이다(Codex 독립 리뷰 3차의 반례 — 가르는 것은 '0프레임 보정'이 아니라
        #  '그 프레임을 채울 원본이 있는가'(E ≤ 원본 프레임 수)다)
        self.setUp()
        self.add("tiny", frames=2)
        result = self.build(plan([sped("tiny", 1, 0, 1, 2.1)], version=3, tracks=1))
        self.assertEqual((result["status"], result["speed_applied"]), ("complete", 1))
        self.assertEqual([(item.duration, item.source_end) for item in self.speed_items()], [(1, 1)])  # E = 2 = 원본 끝 → 끝 프레임(1)으로 읽힘

    def test_a_speed_clip_on_a_low_fps_source_must_land_on_its_planned_length(self):
        # 12fps 원본은 한 프레임이 타임라인 두 프레임이다 — 놓을 수 있는 길이가 짝수뿐이다. 60프레임(5초) · 210% → 계획 floor(120 ÷ 2.1) = 57 은
        #  올림(29 → 58)으로도 못 놓는다 → 만들지 않는다(Codex 독립 리뷰 4차). 200% → 60 은 놓인다(30 → 60) → 짓는다
        self.add("lo", fps=12.0, frames=60)
        result = self.build(plan([sped("lo", 1, 0, 57, 2.1)], audio=[sped_sound("lo", 0, 57, 1, 2.1)], version=3, tracks=1))
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("failed", "speed_fps", "measure"))
        self.assertEqual([(row["gen_id"], row["track"], row["planned"]) for row in result["speed_unplaceable"]], [("lo", 1, 57), ("lo", 0, 57)])
        self.assertEqual(self.project.timelines, [])
        self.setUp()
        self.add("lo", fps=12.0, frames=60)
        result = self.build(plan([sped("lo", 1, 0, 60, 2.0)], version=3, tracks=1))
        self.assertEqual((result["status"], result["speed_applied"]), ("complete", 1))
        self.assertEqual([(item.duration, item.source_end) for item in self.speed_items()], [(60, 59)])  # E = 60 = 원본 끝 → 끝 프레임으로 읽힘

    def test_unreadable_place_after_speed_is_reported_and_the_rest_go_on(self):
        # 걸고 나서 길이를 숫자가 아닌 값으로 돌려준다 — Resolve 호출 예외가 아니라 '되읽지 못함'이다: 그 클립만 적고 다음 클립은 건다(Codex 독립 리뷰 3차)
        self.add("a", frames=240)
        self.add("b", "e035/C0020", frames=240)
        original = FakeItem.GetDuration

        def blank_after_speed(item, _sub=False):
            return None if item.speed is not None and item.clip.path.endswith("a.mp4") else original(item)

        with mock.patch.object(FakeItem, "GetDuration", blank_after_speed):
            result = self.build(plan([sped("a", 1, 0, 48, 2.0), sped("b", 1, 48, 96, 0.5)], version=3, tracks=1))
        self.assertEqual(([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], result["speed_applied"]), ([("a", "unread")], 1))
        self.assertEqual((result["status"], result["error"]), ("partial", None))

    def test_speed_stops_when_a_clip_moved_or_resolve_changed_midway(self):
        def three():
            self.setUp()
            for name in ("a", "b", "c"):
                self.add(name, f"e035/{name}", frames=240)
            return plan([sped("a", 1, 0, 48, 2.0), sped("b", 1, 48, 96, 2.0), sped("c", 1, 96, 144, 2.0)], version=3, tracks=2)

        original = FakeItem.SetSpeed
        # 걸기 시작한 뒤 뒤 클립이 움직였다 — 그 뒤는 걸지 않는다. 같은 시작·길이로 다른 트랙에 옮겨진 것도 움직인 것이다(Codex 독립 리뷰)
        for how in ("later", "other_track"):
            with self.subTest(how=how):
                raw = three()

                def shove(item, options):
                    done = original(item, options)
                    lanes = self.project.timelines[0].video
                    for other in [other for other in lanes[0] if other is not item]:
                        if how == "later":
                            other.start += 1
                        else:
                            lanes[0].remove(other)
                            lanes[1].append(other)
                    return done

                with mock.patch.object(FakeItem, "SetSpeed", shove):
                    result = self.build(raw)
                self.assertEqual([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], [("b", "moved"), ("c", "stopped")])
                self.assertEqual((result["status"], result["speed_applied"]), ("partial", 1))
        # 사용자가 다른 타임라인을 열었다 — guard 가 멈춘다(저장하지 않는다)
        raw = three()
        other = FakeTimeline("사용자 타임라인", 24.0)

        def switch(item, options):
            done = original(item, options)
            self.project.current_timeline = other
            return done

        with mock.patch.object(FakeItem, "SetSpeed", switch):
            result = self.build(raw)
        self.assertEqual((result["status"], result["error_code"], result["step"], self.manager.saved), ("partial", "timeline_changed", "speed", 0))
        # 멈춘 자리부터 남은 것을 결과 줄에 빠짐없이(a 는 걸렸다)
        self.assertEqual(([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], result["speed_applied"]),
                         ([("b", "stopped"), ("c", "stopped")], 1))
        # Resolve 호출이 예외를 던졌다(연결 끊김) — 멈춘다
        raw = three()

        def broken(_item, _options):
            raise RuntimeError("Resolve 연결이 끊겼습니다")

        with mock.patch.object(FakeItem, "SetSpeed", broken):
            result = self.build(raw)
        self.assertEqual((result["status"], result["error_code"], result["step"]), ("partial", "unexpected_error", "speed"))
        self.assertEqual([(row["gen_id"], row["reason"]) for row in result["speed_failed"]], [("a", "stopped"), ("b", "stopped"), ("c", "stopped")])

    def test_slow_sound_may_need_one_more_source_frame_than_its_picture(self):
        # 소리의 원본 시작은 운반 클립의 S + round(앞섬 × 속도 × fps) — 그 반올림 몫만큼 영상보다 한 프레임 더 원본 끝을 넘을 수 있다.
        #  원본 40프레임 · 50% × 81프레임(영상 끝 E = 40 — 원본 끝) · 소리는 1프레임 뒤에서 시작(원본 1 + floor(80 × 0.5) = 41) → 원본 끝(40)으로 본다
        self.add("a", frames=40)
        result = self.build(plan([sped("a", 1, 0, 81, 0.5)], audio=[sped_sound("a", 1, 81, 1, 0.5)], version=3, tracks=1))
        self.assertEqual((result["status"], result["speed_failed"], result["speed_applied"]), ("complete", [], 2))
        self.assertEqual([(item.left, item.source_end) for item in self.speed_items("audio")], [(1, 39)])
        # 두 프레임 넘으면 만들지 않는다
        self.setUp()
        self.add("a", frames=39)
        result = self.build(plan([sped("a", 1, 0, 78, 0.5)], audio=[sped_sound("a", 1, 78, 1, 0.5)], version=3, tracks=1))
        self.assertEqual(result["status"], "complete")  # 영상 끝 39 · 소리 1 + floor(77 × 0.5) = 39 — 넘지 않는다
        self.setUp()
        self.add("a", frames=38)
        result = self.build(plan([sped("a", 1, 0, 76, 0.5)], audio=[sped_sound("a", 3, 76, 1, 0.5)], version=3, tracks=1))
        self.assertEqual((result["status"], result["error_code"]), ("complete", None))  # 소리 2 + floor(73 × 0.5) = 38 — 원본 끝

    def test_a_half_frame_short_source_is_still_reported(self):
        # 48fps 243프레임(5.0625초)에 122프레임을 쓰면 반 프레임 모자란다 — 내림으로 환산하는 Resolve 에서 121 → '원본이 짧음'(완료가 아니다)
        self.add("upper", fps=48.0, frames=243)
        result = self.build(plan([clip("upper", 1, 0, 122)], tracks=1))
        self.assertEqual(result["status"], "partial")
        self.assertEqual([(row["gen_id"], row["expected"], row["actual"], row["short"]) for row in result["mismatches"]], [("upper", 122, 121, True)])


class TimelineWorkerTests(unittest.TestCase):
    """자식 프로세스 — 가져오기에 이어 타임라인을 짓고, 전송 보호를 처음부터 끝까지 쥔다."""

    PLAN = {"name": "x"}

    def run_worker(self, imported, *, lease=None):
        events: list[str] = []

        @contextlib.contextmanager
        def fake_lease():
            events.append("lease+")
            try:
                yield
            finally:
                events.append("lease-")

        def fake_import(manifest):
            events.append("import")
            return imported

        def fake_build(manifest, plan):
            events.append("build")
            return resolve_timeline.new_result(status="complete")

        with (
            mock.patch.object(resolve_timeline_worker, "transfer_lease", lease or fake_lease),
            mock.patch.object(resolve_timeline_worker, "_run_import", fake_import),
            mock.patch.object(resolve_timeline_worker, "build_timeline", fake_build),
        ):
            return resolve_timeline_worker.run({"manifest": {"items": []}, "timeline": self.PLAN}), events

    def test_builds_after_a_complete_import_under_one_lease(self):
        result, events = self.run_worker({"status": "complete", "imported": 2})
        self.assertEqual(events, ["lease+", "import", "build", "lease-"])  # 타임라인이 끝날 때까지 보호를 놓지 않는다
        self.assertEqual((result["import"]["status"], result["timeline"]["status"]), ("complete", "complete"))

    def test_does_not_build_when_the_import_is_incomplete(self):
        for imported in ({"status": "partial", "error": "1개 실패"}, {"status": "unavailable", "error": "Resolve 꺼짐"}, {"status": "failed"}):
            result, events = self.run_worker(imported)
            self.assertEqual(events, ["lease+", "import", "lease-"])
            self.assertEqual((result["timeline"]["status"], result["timeline"]["error_code"]), ("unavailable", "import_incomplete"))
            self.assertEqual(result["timeline"]["timeline_name"], "")

    def test_update_gate_blocks_both_steps(self):
        @contextlib.contextmanager
        def busy():
            raise resolve_timeline_worker.ResolveTransferGateBusy("업데이트 중")
            yield  # pragma: no cover

        result, events = self.run_worker({"status": "complete"}, lease=busy)
        self.assertEqual(events, [])
        self.assertEqual((result["import"]["error_code"], result["timeline"]["error_code"]), ("update_in_progress", "update_in_progress"))

    def test_main_prints_one_prefixed_json_line(self):
        payload = {"manifest": {}, "timeline": {}}
        with (
            mock.patch.object(resolve_timeline_worker, "run", return_value={"import": {"status": "complete"}, "timeline": {"status": "complete"}}),
            mock.patch.object(resolve_timeline_worker.sys, "stdin", io.StringIO(json.dumps(payload))),
            mock.patch.object(resolve_timeline_worker.sys, "stdout", new_callable=io.StringIO) as out,
        ):
            resolve_timeline_worker.main()
        line = out.getvalue().strip()
        self.assertTrue(line.startswith("MVHUB_RESOLVE_TIMELINE="))
        self.assertEqual(json.loads(line.removeprefix("MVHUB_RESOLVE_TIMELINE="))["timeline"]["status"], "complete")


class TimelineRunnerTests(unittest.TestCase):
    """부모 쪽 — 가져오기와 같은 길(호환 인터프리터·제한 시간 없음), 다른 자식·다른 머리글."""

    def setUp(self):
        resolve_status_runner._working_interpreter = None
        resolve_status_runner._last_selection = None
        running = mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=True)
        running.start()
        self.addCleanup(running.stop)

    def run_child(self, completed):
        with (
            mock.patch.object(resolve_status_runner, "_select_interpreter", return_value=(r"C:\Python311\python.exe", {"status": "ready"}, "")),
            mock.patch.object(resolve_status_runner.subprocess, "run", return_value=completed) as run,
        ):
            return resolve_status_runner.run_resolve_timeline_isolated({"items": []}, {"name": "x"}), run

    def test_returns_both_results_from_the_timeline_worker(self):
        payload = {"import": {"status": "complete"}, "timeline": {"status": "complete", "timeline_name": "뻘뻘뻘_e035"}}
        completed = subprocess.CompletedProcess(["python"], 0, stdout="log\nMVHUB_RESOLVE_TIMELINE=" + json.dumps(payload) + "\n", stderr="")
        result, run = self.run_child(completed)
        self.assertEqual(result, payload)
        self.assertEqual(run.call_args.args[0][-1], "app.services.resolve_timeline_worker")
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"manifest": {"items": []}, "timeline": {"name": "x"}})
        self.assertIsNone(run.call_args.kwargs["timeout"])  # 강제 종료가 Media Pool 정렬 복구를 끊지 않게

    def test_child_crash_is_reported_on_both_results(self):
        result, _run = self.run_child(subprocess.CompletedProcess(["python"], 3221225477, stdout="", stderr=""))
        self.assertEqual((result["import"]["status"], result["import"]["error_code"]), ("unavailable", "child_crashed"))
        self.assertEqual((result["timeline"]["status"], result["timeline"]["error_code"]), ("unavailable", "child_crashed"))
        self.assertIn("타임라인 보내기", result["timeline"]["error"])

    def test_malformed_child_result_is_not_trusted(self):
        completed = subprocess.CompletedProcess(["python"], 0, stdout='MVHUB_RESOLVE_TIMELINE={"import": 5}\n', stderr="")
        result, _run = self.run_child(completed)
        self.assertEqual(result["timeline"]["error_code"], "invalid_child_result")

    def test_resolve_not_running_never_starts_a_child(self):
        with (
            mock.patch.object(resolve_status_runner, "resolve_process_running", return_value=False),
            mock.patch.object(resolve_status_runner.subprocess, "run") as run,
        ):
            result = resolve_status_runner.run_resolve_timeline_isolated({"items": []}, {})
        self.assertEqual((result["timeline"]["status"], result["timeline"]["error_code"]), ("unavailable", "not_running"))
        run.assert_not_called()


class TimelineRouteTests(unittest.IsolatedAsyncioTestCase):
    """라우트 — 원본 전송과 같은 관문·권한, 계획은 파일 준비보다 먼저 검사, manifest 에는 계획을 넣지 않는다."""

    GENERATION = {"id": "g1", "job_id": "j1", "project_id": "p1", "project_name": "테스트", "folder_path": "e035/C0010", "status": "done", "assets": []}

    def body(self, timeline=None, gen_ids=("g1",)):
        return resolve_integration.ResolveTimelineIn(
            gen_ids=list(gen_ids), resolve_project_id="resolve-1", resolve_project_name="EP01_EDIT",
            timeline=timeline if timeline is not None else plan([clip("g1", 1, 0, 120)], tracks=1),
        )

    async def call(self, body, *, built=None, events=None, save_error_after_build=None, save_error_before_build=None, prepare_error=None):
        manifest = {"transfer_id": "t-1", "project_id": "p1", "items": [], "total": 1}
        built = built or {"import": {"status": "complete"}, "timeline": {"status": "complete", "timeline_name": "뻘뻘뻘_e035"}}
        events = events if events is not None else []

        @contextlib.asynccontextmanager
        async def suspended():
            events.append("suspend+")
            try:
                yield
            finally:
                events.append("suspend-")

        def run(manifest_arg, plan_arg):
            events.append("worker")
            return built

        async def save(manifest_arg):
            events.append("save:" + ("timeline" if "timeline" in manifest_arg else "plain"))
            if save_error_after_build is not None and "worker" in events:
                raise save_error_after_build
            if save_error_before_build is not None and "worker" not in events:
                raise save_error_before_build

        with (
            mock.patch.object(resolve_integration.repo, "get_generations_batch", return_value={"g1": self.GENERATION}),
            mock.patch.object(resolve_integration, "batch_view_member_projects", return_value=set()),
            mock.patch.object(resolve_integration, "can_view_generation_with_member_projects", return_value=True),
            mock.patch.object(resolve_integration.active_account, "account_key", return_value=""),
            mock.patch.object(resolve_integration.active_account, "active_email", return_value=""),
            mock.patch.object(resolve_integration, "account_scope_uid", return_value=None),
            mock.patch.object(resolve_integration._proxy, "proxying", return_value=False),
            mock.patch.object(resolve_integration, "transfer_generations", new=mock.AsyncMock(return_value=manifest, side_effect=prepare_error)) as transfer,
            mock.patch.object(resolve_integration, "run_resolve_timeline_isolated", side_effect=run) as worker,
            mock.patch.object(resolve_integration, "save_manifest", new=save),
            mock.patch.object(resolve_integration.resolve_selection_monitor, "suspended", suspended),
        ):
            response = await resolve_integration.create_resolve_timeline(body, Request({"type": "http", "client": ("127.0.0.1", 1)}))
        return response, transfer, worker, events

    async def test_prepares_imports_builds_and_keeps_the_plan_out_of_the_manifest(self):
        response, transfer, worker, events = await self.call(self.body())
        self.assertEqual(response["timeline"], {"status": "complete", "timeline_name": "뻘뻘뻘_e035"})
        self.assertEqual(response["transfer"]["resolve_import"], {"status": "complete"})
        self.assertEqual(response["transfer"]["resolve_target"], {"project_id": "resolve-1", "project_name": "EP01_EDIT"})
        self.assertNotIn("timeline", response["transfer"])  # manifest 는 보통의 원본 전송으로 남는다
        transfer.assert_awaited_once_with("p1", [self.GENERATION])
        manifest_arg, plan_arg = worker.call_args.args
        self.assertEqual((plan_arg["format"], plan_arg["clips"][0]["gen_id"]), ("mvhub.edit-timeline", "g1"))
        # 대상 프로젝트를 먼저 적고 → 선택 감시를 멈춘 채 자식을 돌리고 → 결과를 적는다
        self.assertEqual(events, ["save:plain", "suspend+", "worker", "suspend-", "save:plain"])

    async def test_a_record_save_failure_after_the_build_is_not_a_400(self):
        # Resolve 가 이미 바뀐 뒤다 — 400 으로 올리면 화면은 '시작 전에 거절됐다(만든 것이 없다)'로 읽고 다시 눌러 둘이 된다(Codex 코드 리뷰)
        for error in (resolve_integration.ResolveTransferError("전송 목록 저장 경로가 안전하지 않습니다"), OSError("디스크가 사라졌다")):
            response, _transfer, _worker, _events = await self.call(self.body(), save_error_after_build=error)
            self.assertEqual((response["timeline"]["status"], response["timeline"]["timeline_name"]), ("complete", "뻘뻘뻘_e035"))
            self.assertEqual(response["timeline"]["warnings"], [f"전송 기록을 저장하지 못했습니다: {error}"])
            self.assertEqual(response["transfer"]["resolve_import"], {"status": "complete"})

    async def test_a_record_write_failure_before_resolve_is_touched_is_a_400(self):
        # 81회차 P2b 2-a — 원본 준비·대상 기록의 NAS 쓰기 실패는 시작 전 거절(4xx)이다. 500 이면 화면이 '만들어졌을 수 있습니다'로 읽었다.
        for kwargs in ({"prepare_error": OSError(5, "Input/output error")}, {"save_error_before_build": OSError(28, "No space left on device")}):
            events: list[str] = []
            with self.assertRaises(HTTPException) as raised:
                await self.call(self.body(), events=events, **kwargs)
            self.assertEqual(raised.exception.status_code, 400)
            self.assertIn("이미 복사한 파일은 건너뜁니다", raised.exception.detail)
            self.assertNotIn("worker", events)

    async def test_a_bad_plan_is_rejected_before_any_file_is_prepared(self):
        for bad in ({"format": "nope"}, plan([clip("stranger", 1, 0, 120)], tracks=1), plan([clip("g1", 1, 0, 120), clip("g1", 1, 100, 200)], tracks=1)):
            with self.assertRaises(HTTPException) as raised:
                await self.call(self.body(bad))
            self.assertEqual(raised.exception.status_code, 400)
        with (
            mock.patch.object(resolve_integration, "transfer_generations", new=mock.AsyncMock()) as transfer,
            mock.patch.object(resolve_integration.repo, "get_generations_batch") as lookup,
        ):
            with self.assertRaises(HTTPException):
                await resolve_integration.create_resolve_timeline(self.body({"format": "nope"}), Request({"type": "http", "client": ("127.0.0.1", 1)}))
        transfer.assert_not_awaited()
        lookup.assert_not_called()

    async def test_only_the_local_machine_may_send(self):
        with self.assertRaises(HTTPException) as raised:
            await resolve_integration.create_resolve_timeline(self.body(), Request({"type": "http", "client": ("192.168.1.50", 1)}))
        self.assertEqual(raised.exception.status_code, 403)

    async def test_the_existing_transfer_route_still_works_after_the_split(self):
        imported = {"status": "complete", "imported": 1}
        manifest = {"transfer_id": "t-2", "project_id": "p1", "items": []}
        with (
            mock.patch.object(resolve_integration.repo, "get_generations_batch", return_value={"g1": self.GENERATION}),
            mock.patch.object(resolve_integration, "batch_view_member_projects", return_value=set()),
            mock.patch.object(resolve_integration, "can_view_generation_with_member_projects", return_value=True),
            mock.patch.object(resolve_integration.active_account, "account_key", return_value=""),
            mock.patch.object(resolve_integration.active_account, "active_email", return_value=""),
            mock.patch.object(resolve_integration, "account_scope_uid", return_value=None),
            mock.patch.object(resolve_integration._proxy, "proxying", return_value=False),
            mock.patch.object(resolve_integration, "transfer_generations", new=mock.AsyncMock(return_value=manifest)),
            mock.patch.object(resolve_integration, "run_resolve_import_isolated", return_value=imported),
            mock.patch.object(resolve_integration, "save_manifest", new=mock.AsyncMock()),
        ):
            response = await resolve_integration.create_resolve_transfer(
                resolve_integration.ResolveTransferIn(gen_ids=[" g1 ", "g1", ""]), Request({"type": "http", "client": ("127.0.0.1", 1)}),
            )
        self.assertEqual((response["transfer_id"], response["resolve_import"]), ("t-2", imported))


if __name__ == "__main__":
    unittest.main()
