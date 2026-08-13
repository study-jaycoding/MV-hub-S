#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MV Hub Clip Exporter for DaVinci Resolve.

현재 타임라인의 기준 비디오 트랙을 시간순으로 읽고, 각 TimelineItem 구간을
정확한 이름의 Single Clip 렌더 작업으로 Render Queue에 추가한다.

이 파일은 Resolve의 Workspace > Scripts 메뉴에서 직접 실행되는 독립 파일이다.
외부 패키지나 MV Hub 서버 연결을 요구하지 않는다.
"""

from __future__ import print_function

import os
import re
import string
import sys
import unicodedata


PLUGIN_VERSION = "0.6.2"
CURRENT_SETTINGS_LABEL = "현재 Resolve 설정 유지"
DEFAULT_TEMPLATE = "{project}_{episode}_{sequence}_{description}_v{version:03d}"
WINDOW_ID = "com.millionvolt.mvhub.clip-exporter"
_INVALID_FILE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_SPACES = re.compile(r"\s+")
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
}
_ALLOWED_TEMPLATE_FIELDS = {
    "project",
    "timeline",
    "episode",
    "sequence",
    "clip",
    "source",
    "track",
    "cut",
    "version",
    "description",
}


class ExporterError(RuntimeError):
    """사용자에게 그대로 보여줄 수 있는 내보내기 오류."""


def sanitize_component(value, fallback="unnamed", max_length=80):
    """한글은 보존하고 Windows에서 안전하지 않은 파일명 문자만 정리한다."""
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    text = _SPACES.sub("_", text)
    text = _INVALID_FILE_CHARS.sub("_", text)
    text = text.rstrip(" .")
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = fallback
    if text.upper() in _WINDOWS_RESERVED:
        text = "_" + text
    if len(text) > max_length:
        text = text[:max_length].rstrip(" ._") or fallback
    return text


def format_output_name(template, values):
    """허용한 토큰만 사용해 확장자 없는 렌더 파일명을 만든다."""
    template = str(template or "").strip()
    if not template:
        raise ExporterError("파일명 규칙을 입력하세요")
    try:
        parsed = list(string.Formatter().parse(template))
    except ValueError as exc:
        raise ExporterError("파일명 규칙의 중괄호가 올바르지 않습니다") from exc
    for _literal, field_name, _format_spec, conversion in parsed:
        if field_name is None:
            continue
        if field_name not in _ALLOWED_TEMPLATE_FIELDS:
            raise ExporterError("지원하지 않는 파일명 항목입니다: {0}".format(field_name))
        if conversion:
            raise ExporterError("파일명 규칙에서 ! 변환 문법은 지원하지 않습니다")
    try:
        rendered = template.format(**values)
    except (KeyError, ValueError, TypeError) as exc:
        raise ExporterError("파일명 규칙을 적용할 수 없습니다: {0}".format(exc)) from exc
    return sanitize_component(rendered, "clip", max_length=180)


def _safe_call(obj, method_name, default=None):
    method = getattr(obj, method_name, None)
    if not callable(method):
        return default
    try:
        return method()
    except Exception:
        return default


def _media_item_id(item):
    if item is None:
        return ""
    value = _safe_call(item, "GetUniqueId", "")
    return str(value or "")


def media_pool_paths(media_pool):
    """MediaPoolItem 고유 ID를 Resolve Bin 경로에 매핑한다."""
    root = media_pool.GetRootFolder() if media_pool else None
    if root is None:
        return {}
    result = {}

    def visit(folder, path):
        for media_item in folder.GetClipList() or []:
            unique_id = _media_item_id(media_item)
            if unique_id:
                result[unique_id] = tuple(path)
        for child in folder.GetSubFolderList() or []:
            child_name = str(_safe_call(child, "GetName", "") or "")
            visit(child, tuple(path) + (child_name,))

    visit(root, ())
    return result


def episode_sequence_from_path(path_parts):
    """MV Hub/<프로젝트>/<에피소드>/<시퀀스> 경로에서 작업 단계를 꺼낸다."""
    parts = [str(part or "").strip() for part in path_parts if str(part or "").strip()]
    folded = [part.casefold() for part in parts]
    tail = parts
    if "mv hub" in folded:
        index = folded.index("mv hub")
        # MV Hub 다음 한 단계는 프로젝트 이름이다.
        tail = parts[index + 2 :]
    if len(tail) >= 2:
        return tail[0], tail[1]
    if len(tail) == 1:
        return tail[0], "c0000"
    return "e000", "c0000"


def normalize_episode(value):
    """1, 001, e001, ep001 입력을 MV Hub 표준 e001 형태로 맞춘다."""
    text = str(value or "").strip().casefold()
    match = re.fullmatch(r"(?:ep|e)?(\d{1,4})", text)
    if not match:
        raise ExporterError("에피소드는 1, 001 또는 e001 형식으로 입력하세요")
    number = int(match.group(1))
    if number < 1 or number > 9999:
        raise ExporterError("에피소드는 1~9999 사이여야 합니다")
    return "e{0:03d}".format(number)


def video_track_options(timeline):
    """현재 타임라인에 실제로 존재하는 비디오 트랙 목록을 만든다."""
    if timeline is None:
        return []
    try:
        track_count = int(timeline.GetTrackCount("video") or 0)
    except (AttributeError, TypeError, ValueError):
        return []
    options = []
    for track_index in range(1, track_count + 1):
        track_name = ""
        try:
            track_name = str(timeline.GetTrackName("video", track_index) or "").strip()
        except Exception:
            track_name = ""
        label = "V{0}".format(track_index)
        if track_name and track_name.casefold() != label.casefold():
            label += " · " + track_name
        options.append({"index": track_index, "label": label})
    return options


def collect_timeline_clips(project, track_index=1):
    """현재 타임라인의 기준 트랙에서 렌더 가능한 클립을 시간순으로 수집한다."""
    if project is None:
        raise ExporterError("현재 열려 있는 Resolve 프로젝트가 없습니다")
    timeline = project.GetCurrentTimeline()
    if timeline is None:
        raise ExporterError("현재 열려 있는 타임라인이 없습니다")
    try:
        track_index = int(track_index)
        track_count = int(timeline.GetTrackCount("video") or 0)
    except (TypeError, ValueError) as exc:
        raise ExporterError("비디오 트랙 정보를 읽을 수 없습니다") from exc
    if track_index < 1 or track_index > track_count:
        raise ExporterError("V{0} 트랙이 없습니다".format(track_index))

    media_pool = project.GetMediaPool()
    path_by_id = media_pool_paths(media_pool)
    project_name = str(project.GetName() or "project")
    timeline_name = str(timeline.GetName() or "timeline")
    rows = []
    for item in timeline.GetItemListInTrack("video", track_index) or []:
        enabled = _safe_call(item, "GetClipEnabled", True)
        if enabled is False:
            continue
        try:
            start = int(round(float(item.GetStart())))
            end_exclusive = int(round(float(item.GetEnd())))
        except (AttributeError, TypeError, ValueError):
            continue
        if end_exclusive <= start:
            continue
        media_item = _safe_call(item, "GetMediaPoolItem", None)
        path_parts = path_by_id.get(_media_item_id(media_item), ())
        episode, sequence = episode_sequence_from_path(path_parts)
        source_path = ""
        if media_item is not None:
            try:
                source_path = str(media_item.GetClipProperty("File Path") or "")
            except Exception:
                source_path = ""
        source_name = os.path.splitext(os.path.basename(source_path))[0]
        clip_name = str(_safe_call(item, "GetName", "") or source_name or "clip")
        rows.append(
            {
                "item": item,
                "start": start,
                "end_exclusive": end_exclusive,
                "mark_out": end_exclusive - 1,
                "project": project_name,
                "timeline": timeline_name,
                "episode": episode,
                "sequence": sequence,
                "clip": clip_name,
                "source": source_name or clip_name,
                "source_path": source_path,
                "track": track_index,
            }
        )

    rows.sort(
        key=lambda row: (
            row["start"],
            row["end_exclusive"],
            str(_safe_call(row["item"], "GetUniqueId", "")),
        )
    )
    counters = {}
    for row in rows:
        counter_key = (row["episode"].casefold(), row["sequence"].casefold())
        counters[counter_key] = counters.get(counter_key, 0) + 1
        row["cut"] = counters[counter_key]
    if not rows:
        raise ExporterError("V{0}에 렌더할 활성 영상 클립이 없습니다".format(track_index))
    return rows


def _project_folder_context(source_path):
    """원본 경로의 PROJECT_<이름> 폴더에서 프로젝트명과 10_ai 루트를 찾는다."""
    source_path = str(source_path or "").strip()
    if not source_path:
        return "", ""
    current = os.path.dirname(os.path.abspath(source_path))
    while current:
        folder_name = os.path.basename(current)
        match = re.match(r"^project_(.+)$", folder_name, flags=re.IGNORECASE)
        if match:
            project_name = sanitize_component(
                match.group(1).casefold(), "project", max_length=80
            )
            return project_name, os.path.join(current, "10_ai")
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return "", ""


def infer_project_name(records):
    """첫 번째 PROJECT_<이름> 원본 경로에서 파일명용 프로젝트명을 가져온다."""
    for record in records:
        project_name, _root = _project_folder_context(record.get("source_path"))
        if project_name:
            return project_name
    return ""


def infer_project_root(records):
    """원본 경로에서 10_ai 프로젝트 루트를 찾는다."""
    for record in records:
        source_path = str(record.get("source_path") or "").strip()
        if not source_path:
            continue
        current = os.path.dirname(os.path.abspath(source_path))
        while current:
            if os.path.basename(current).casefold() in ("assets", "render"):
                return os.path.dirname(current)
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        _project_name, project_root = _project_folder_context(source_path)
        if project_root:
            return project_root
    return ""


def infer_output_root(records):
    """프로젝트의 assets/reference 폴더를 출력 루트로 제안한다."""
    project_root = infer_project_root(records)
    if project_root:
        return os.path.join(project_root, "assets", "reference")
    return os.path.join(os.path.expanduser("~"), "Videos", "MV Hub Exports")


def infer_render_root(records, output_root=""):
    """프로젝트의 render 폴더 위치를 찾는다."""
    project_root = infer_project_root(records)
    if not project_root:
        current = os.path.abspath(os.path.expanduser(str(output_root or "").strip()))
        if os.path.basename(current).casefold() == "reference":
            assets_dir = os.path.dirname(current)
            if os.path.basename(assets_dir).casefold() == "assets":
                project_root = os.path.dirname(assets_dir)
    if not project_root:
        raise ExporterError("프로젝트의 assets 또는 render 폴더 위치를 찾을 수 없습니다")
    return os.path.join(project_root, "render")


def build_render_jobs(
    records,
    output_root,
    template=DEFAULT_TEMPLATE,
    version=1,
    description="",
    episode="",
    sequence_step=10,
):
    """클립 정보에서 충돌 없는 렌더 작업 계획을 만든다."""
    output_root = str(output_root or "").strip()
    if not output_root:
        raise ExporterError("출력 폴더를 지정하세요")
    output_root = os.path.abspath(os.path.expanduser(output_root))
    try:
        version = int(version)
    except (TypeError, ValueError) as exc:
        raise ExporterError("버전은 숫자여야 합니다") from exc
    if version < 1 or version > 999:
        raise ExporterError("버전은 001~999 사이여야 합니다")
    try:
        sequence_step = int(sequence_step)
    except (TypeError, ValueError) as exc:
        raise ExporterError("시퀀스 단위는 1, 5 또는 10이어야 합니다") from exc
    if sequence_step not in (1, 5, 10):
        raise ExporterError("시퀀스 단위는 1, 5 또는 10이어야 합니다")

    description = sanitize_component(description, fallback="", max_length=80)
    fixed_episode = normalize_episode(episode) if str(episode or "").strip() else ""
    inferred_project_name = infer_project_name(records)

    jobs = []
    seen = set()
    for index, record in enumerate(records, 1):
        values = {
            "project": inferred_project_name
            or sanitize_component(record.get("project"), "project"),
            "timeline": sanitize_component(record.get("timeline"), "timeline"),
            "episode": fixed_episode
            or sanitize_component(record.get("episode"), "e000"),
            "sequence": "c{0:04d}".format(index * sequence_step),
            "clip": sanitize_component(record.get("clip"), "clip"),
            "source": sanitize_component(record.get("source"), "source"),
            "track": int(record.get("track") or 1),
            "cut": int(record.get("cut") or 1),
            "version": version,
            "description": description,
        }
        output_name = format_output_name(template, values)
        output_dir = os.path.join(output_root, values["episode"])
        identity = os.path.normcase(os.path.join(output_dir, output_name))
        if identity in seen:
            raise ExporterError(
                "같은 파일명이 두 번 만들어집니다: {0}. 규칙에 {{cut}}을 넣으세요".format(
                    output_name
                )
            )
        seen.add(identity)
        job = dict(record)
        job.update(values)
        job["output_dir"] = output_dir
        job["output_name"] = output_name
        jobs.append(job)
    return jobs


def create_render_sequence_folders(jobs, render_root):
    """준비된 클립의 에피소드/시퀀스에 맞는 render 폴더를 만든다."""
    if not jobs:
        raise ExporterError("Render 폴더를 만들 클립 정보가 없습니다")
    render_root = str(render_root or "").strip()
    if not render_root:
        raise ExporterError("Render 폴더 위치를 찾을 수 없습니다")
    render_root = os.path.abspath(os.path.expanduser(render_root))
    created = []
    seen = set()
    for job in jobs:
        episode = sanitize_component(job.get("episode"), "e000")
        sequence = sanitize_component(job.get("sequence"), "c0000")
        target = os.path.join(render_root, episode, sequence)
        identity = os.path.normcase(target)
        if identity in seen:
            continue
        seen.add(identity)
        os.makedirs(target, exist_ok=True)
        created.append(target)
    return created


def _render_extension(project):
    current = project.GetCurrentRenderFormatAndCodec() or {}
    return str(current.get("format") or "").strip().lstrip(".")


def enqueue_render_jobs(project, jobs, preset_name=CURRENT_SETTINGS_LABEL):
    """계획된 구간을 Single Clip 작업으로 추가하며 실패 시 이번 작업만 롤백한다."""
    if not jobs:
        raise ExporterError("Render Queue에 추가할 클립이 없습니다")
    if bool(project.IsRenderingInProgress()):
        raise ExporterError("Resolve가 렌더 중입니다. 완료 후 다시 실행하세요")

    previous_mode = project.GetCurrentRenderMode()
    created_job_ids = []
    try:
        if preset_name and preset_name != CURRENT_SETTINGS_LABEL:
            if not project.LoadRenderPreset(preset_name):
                raise ExporterError("렌더 프리셋을 불러오지 못했습니다: {0}".format(preset_name))
        if not project.SetCurrentRenderMode(1):
            raise ExporterError("Resolve 렌더 모드를 Single Clip으로 바꾸지 못했습니다")

        extension = _render_extension(project)
        for job in jobs:
            if extension:
                target_file = os.path.join(
                    job["output_dir"], job["output_name"] + "." + extension
                )
                if os.path.exists(target_file):
                    raise ExporterError("같은 이름의 파일이 이미 있습니다: {0}".format(target_file))

        for job in jobs:
            os.makedirs(job["output_dir"], exist_ok=True)
            settings = {
                "SelectAllFrames": False,
                "MarkIn": int(job["start"]),
                "MarkOut": int(job["mark_out"]),
                "TargetDir": job["output_dir"],
                "CustomName": job["output_name"],
                "ExportVideo": True,
                "ExportAudio": True,
            }
            if not project.SetRenderSettings(settings):
                raise ExporterError("렌더 설정을 적용하지 못했습니다: {0}".format(job["output_name"]))
            job_id = project.AddRenderJob()
            if not job_id:
                raise ExporterError("렌더 작업을 추가하지 못했습니다: {0}".format(job["output_name"]))
            created_job_ids.append(str(job_id))
        return created_job_ids
    except Exception:
        for job_id in reversed(created_job_ids):
            try:
                project.DeleteRenderJob(job_id)
            except Exception:
                pass
        raise
    finally:
        if previous_mode in (0, 1):
            try:
                project.SetCurrentRenderMode(previous_mode)
            except Exception:
                pass


def start_render_jobs(project, job_ids):
    """이번 실행에서 만든 Render Queue 작업 전체를 순서대로 즉시 시작한다."""
    job_ids = [str(job_id) for job_id in (job_ids or []) if str(job_id or "").strip()]
    if not job_ids:
        raise ExporterError("시작할 렌더 작업이 없습니다")
    if bool(project.IsRenderingInProgress()):
        raise ExporterError("Resolve가 이미 렌더 중입니다")
    try:
        started = project.StartRendering(job_ids, True)
    except Exception as exc:
        raise ExporterError(
            "자동 렌더를 시작하지 못했습니다. 작업은 Render Queue에 남아 있습니다"
        ) from exc
    if not started:
        raise ExporterError(
            "자동 렌더를 시작하지 못했습니다. 작업은 Render Queue에 남아 있습니다"
        )
    return job_ids


def preview_text(jobs):
    lines = []
    for index, job in enumerate(jobs, 1):
        lines.append(
            "{0:02d}. {1}\n    {2}\n    frames {3} ~ {4}".format(
                index,
                job["output_name"],
                job["output_dir"],
                job["start"],
                job["mark_out"],
            )
        )
    return "\n".join(lines)


def _resolve_context():
    resolve_obj = globals().get("resolve")
    app_obj = globals().get("app")
    bmd_obj = globals().get("bmd")
    if resolve_obj is None and app_obj is not None:
        get_resolve = getattr(app_obj, "GetResolve", None)
        if callable(get_resolve):
            resolve_obj = get_resolve()
    if resolve_obj is None or bmd_obj is None:
        try:
            import DaVinciResolveScript as dvr_script
        except ImportError as exc:
            raise ExporterError("DaVinci Resolve 스크립팅 모듈을 불러올 수 없습니다") from exc
        if resolve_obj is None:
            resolve_obj = dvr_script.scriptapp("Resolve")
        if bmd_obj is None:
            bmd_obj = dvr_script
    if resolve_obj is None:
        raise ExporterError("실행 중인 DaVinci Resolve에 연결할 수 없습니다")
    fusion_obj = globals().get("fusion") or resolve_obj.Fusion()
    if fusion_obj is None:
        raise ExporterError("Resolve UIManager를 열 수 없습니다")
    return resolve_obj, fusion_obj, bmd_obj


def show_exporter_window(resolve_obj, fusion_obj, bmd_obj):
    ui = fusion_obj.UIManager
    dispatcher = bmd_obj.UIDispatcher(ui)
    existing = ui.FindWindow(WINDOW_ID)
    if existing:
        existing.Show()
        existing.Raise()
        return

    project_manager = resolve_obj.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    timeline = project.GetCurrentTimeline() if project else None
    track_options = video_track_options(timeline)
    presets = list(project.GetRenderPresetList() or []) if project else []

    window = dispatcher.AddWindow(
        {
            "ID": WINDOW_ID,
            "Geometry": [180, 90, 760, 720],
            "WindowTitle": "MV Hub Clip Exporter {0}".format(PLUGIN_VERSION),
        },
        ui.VGroup(
            {"Spacing": 8},
            [
                ui.Label(
                    {
                        "Text": "MV Hub Clip Exporter",
                        "Font": ui.Font({"PixelSize": 18, "Bold": True}),
                        "Weight": 0,
                    }
                ),
                ui.Label(
                    {
                        "Text": "현재 타임라인의 기준 트랙을 클립별 Render Queue 작업으로 만듭니다.",
                        "Weight": 0,
                    }
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "트랙", "Weight": 0}),
                        ui.ComboBox({"ID": "Track", "Weight": 1}),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "에피소드", "Weight": 0}),
                        ui.LineEdit(
                            {
                                "ID": "Episode",
                                "Text": "e001",
                                "PlaceholderText": "e001",
                                "Weight": 1,
                            }
                        ),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "시퀀스 단위", "Weight": 0}),
                        ui.ComboBox({"ID": "SequenceStep", "Weight": 1}),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "설명", "Weight": 0}),
                        ui.LineEdit(
                            {
                                "ID": "Description",
                                "PlaceholderText": "선택 입력 (예: c)",
                                "Weight": 1,
                            }
                        ),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "버전", "Weight": 0}),
                        ui.LineEdit(
                            {
                                "ID": "Version",
                                "Text": "001",
                                "PlaceholderText": "001",
                                "Weight": 1,
                            }
                        ),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "렌더 프리셋", "Weight": 0}),
                        ui.ComboBox({"ID": "Preset", "Weight": 1}),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "출력 폴더", "Weight": 0}),
                        ui.LineEdit({"ID": "OutputRoot", "Weight": 1}),
                        ui.Button({"ID": "Browse", "Text": "찾기…", "Weight": 0}),
                    ],
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Label({"Text": "파일명 규칙", "Weight": 0}),
                        ui.LineEdit(
                            {"ID": "Template", "Text": DEFAULT_TEMPLATE, "Weight": 1}
                        ),
                    ],
                ),
                ui.Label(
                    {
                        "Text": "사용 가능: {project} {episode} {sequence} {description} {version} {timeline} {clip} {source} {track} {cut}",
                        "Weight": 0,
                    }
                ),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.HGap(0, 1),
                        ui.Button({"ID": "Refresh", "Text": "미리보기 새로고침"}),
                        ui.HGap(0, 1),
                    ],
                ),
                ui.TextEdit(
                    {
                        "ID": "Preview",
                        "ReadOnly": True,
                        "AcceptRichText": False,
                        "LineWrapMode": "NoWrap",
                        "Weight": 1,
                    }
                ),
                ui.Label({"ID": "Status", "Text": "준비 중…", "Weight": 0}),
                ui.HGroup(
                    {"Weight": 0},
                    [
                        ui.Button({"ID": "CreateRenderFolders", "Text": "폴더 생성"}),
                        ui.HGap(0, 1),
                        ui.Button({"ID": "RenderNow", "Text": "Render All"}),
                        ui.Button({"ID": "Close", "Text": "닫기"}),
                    ],
                ),
            ],
        ),
    )
    items = window.GetItems()
    for option in track_options:
        items["Track"].AddItem(option["label"])
    for step in (1, 5, 10):
        items["SequenceStep"].AddItem(str(step))
    items["SequenceStep"].CurrentIndex = 2
    items["Preset"].AddItem(CURRENT_SETTINGS_LABEL)
    for preset in presets:
        items["Preset"].AddItem(str(preset))
    state = {"jobs": []}

    def selected_track_index():
        selected = int(items["Track"].CurrentIndex or 0)
        if selected < 0 or selected >= len(track_options):
            raise ExporterError("선택할 수 있는 비디오 트랙이 없습니다")
        return int(track_options[selected]["index"])

    def refresh(_event=None):
        try:
            active_project = resolve_obj.GetProjectManager().GetCurrentProject()
            records = collect_timeline_clips(active_project, selected_track_index())
            if not str(items["OutputRoot"].Text or "").strip():
                items["OutputRoot"].Text = infer_output_root(records)
            state["jobs"] = build_render_jobs(
                records=records,
                output_root=items["OutputRoot"].Text,
                template=items["Template"].Text,
                version=str(items["Version"].Text or "").strip(),
                description=str(items["Description"].Text or "").strip(),
                episode=str(items["Episode"].Text or "").strip(),
                sequence_step=str(items["SequenceStep"].CurrentText or "10"),
            )
            items["Preview"].PlainText = preview_text(state["jobs"])
            items["Status"].Text = "{0}개 클립 준비됨 · 아직 렌더 작업은 추가되지 않았습니다".format(
                len(state["jobs"])
            )
            return active_project
        except Exception as exc:
            state["jobs"] = []
            items["Preview"].PlainText = ""
            items["Status"].Text = "확인 필요: {0}".format(exc)
            return None

    def browse(_event):
        current = str(items["OutputRoot"].Text or "")
        selected = fusion_obj.RequestDir(current) if current else fusion_obj.RequestDir()
        if selected:
            items["OutputRoot"].Text = str(selected)
            refresh()

    def render_now(_event):
        active_project = refresh()
        if active_project is None or not state["jobs"]:
            return
        try:
            job_ids = enqueue_render_jobs(
                active_project,
                state["jobs"],
                str(items["Preset"].CurrentText or CURRENT_SETTINGS_LABEL),
            )
            start_render_jobs(active_project, job_ids)
            items["Status"].Text = "렌더 시작: {0}개 클립을 순서대로 출력합니다".format(
                len(job_ids)
            )
        except Exception as exc:
            items["Status"].Text = "렌더 시작 실패: {0}".format(exc)

    def create_render_folders(_event):
        active_project = refresh()
        if active_project is None or not state["jobs"]:
            return
        try:
            render_root = infer_render_root(state["jobs"], items["OutputRoot"].Text)
            folders = create_render_sequence_folders(state["jobs"], render_root)
            items["Status"].Text = "완료: render 폴더에 {0}개 시퀀스 폴더를 확인했습니다".format(
                len(folders)
            )
        except Exception as exc:
            items["Status"].Text = "폴더 생성 실패: {0}".format(exc)

    def close(_event):
        dispatcher.ExitLoop()

    window.On[WINDOW_ID].Close = close
    window.On["Close"].Clicked = close
    window.On["Browse"].Clicked = browse
    window.On["Refresh"].Clicked = refresh
    window.On["CreateRenderFolders"].Clicked = create_render_folders
    window.On["RenderNow"].Clicked = render_now
    window.Show()
    refresh()
    dispatcher.RunLoop()
    window.Hide()


def main():
    try:
        resolve_obj, fusion_obj, bmd_obj = _resolve_context()
        show_exporter_window(resolve_obj, fusion_obj, bmd_obj)
    except Exception as exc:
        print("MV Hub Clip Exporter: {0}".format(exc))
        raise


if __name__ == "__main__" or "resolve" in globals():
    main()
