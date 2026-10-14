"""편집 탭의 타임라인을 현재 Resolve 프로젝트에 **새 타임라인**으로 짓는다(타임라인 Resolve 보내기).

들어오는 계획(plan)은 프런트의 ``lib/editResolveExport.ts`` 가 만든 프레임 단위 배치다(format ``mvhub.edit-timeline`` v1 · v2).
v2(2026-10-14 앞 자르기)는 클립에 ``head``(소스의 시작, 24fps 프레임), 소리에 ``track``(그 소리를 내는 영상 클립의 트랙)이 더 있다.
전송 manifest(``mvhub.resolve-transfer`` v2 — 원본 파일 준비·Media Pool 가져오기)와는 **다른 문서**이고 manifest 에 넣지
않는다: 메뉴 스크립트 Importer·pending 목록은 이 전송을 보통의 원본 전송으로만 본다(Codex 설계 검토 10-09).

두 부분이다.
 · ``validate_plan`` — 순수. 프런트가 보낸 값을 믿지 않는다(형식·범위·겹침). **파일을 준비하기 전에** 부른다(잘못된 계획이
   가져오기·Bin 정렬부터 일으키지 않게 — Codex 설계 검토 10-13).
 · ``build_timeline`` — Resolve 조작. 가져오기가 끝난 뒤 같은 자식 프로세스에서 부른다.

이 모듈은 가져오기 자식 프로세스(PC 마다 다른 호환 Python)에서도 돈다 — **표준 라이브러리와 resolve_bridge 만** 쓴다.

Resolve 스크립트 API 의 규칙은 2026-10-09 실측(Resolve Studio 21.1.1, ``docs/EDIT_TAB.md``)에서 잰 것이다.
 · ``AppendToTimeline`` 의 endFrame 은 **끝 미포함**(길이 = end − start). start/endFrame 은 **소스** 프레임이고 타임라인 길이는
   실제 시간으로 환산된다(25fps 125프레임 → 24fps 타임라인 120프레임).
 · recordFrame 은 **절대 좌표**(``timeline.GetStartFrame()`` + 오프셋). 틀린 값도 조용히 받아 타임라인 시작 앞에 놓는다.
 · 겹치면 새 클립이 **잘려 들어가고도 True** 를 돌려준다 → 넣은 뒤 반드시 되읽어 대조한다.
 · 스틸은 준 길이를 무시하고 5초(Resolve 기본값) · mediaType 1 = 영상만, 2 = 소리만(A1).
 · 잠근 트랙에는 못 넣는다 → 잠금은 맨 끝.
 · ``CreateEmptyTimeline`` 은 **현재 Bin** 에 만들고 현재 타임라인을 스스로 바꾼다.
 · 타임라인 fps 를 바꾸면 시작 프레임도 바뀐다(24fps = 86400, 25fps = 90000) → fps 를 먼저 맞추고 시작 프레임을 읽는다.
 · 마커·인/아웃은 타임라인 처음 기준 **상대** 프레임. 마커는 프레임마다 하나(두 번째는 False), 인/아웃의 out 은 **포함** 프레임.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .resolve_bridge import (
    MEDIA_POOL_ROOT,
    ResolveBridgeError,
    _IMPORT_LOCK,
    _assert_expected_project,
    _clips_by_path,
    _connect_resolve,
    _folder_at_path,
    _folder_name,
    _folder_parts,
    _folder_path_from_root,
    _normal_path,
    _project_identity,
    _refresh_folders,
)

PLAN_FORMAT = "mvhub.edit-timeline"
PLAN_VERSIONS = (1, 2)  # 2 = 앞을 자른 클립이 있는 계획(클립의 head · 소리의 track). 그런 클립이 없으면 프런트는 1 을 보낸다
TIMELINE_FPS = 24
MAX_VIDEO_TRACKS = 32
MAX_CLIPS = 2000
MAX_AUDIO = 4000
MAX_MARKERS = 2000
MAX_FRAMES = TIMELINE_FPS * 3600 * 12  # 12시간 — 그보다 긴 값은 계산 실수다
MAX_NAME = 80
MARKER_COLORS = (
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
    "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
)
_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
# 연결·프로젝트 문제 — 타임라인을 만들기 전이면 '보낼 수 없음'(unavailable)으로 알린다(가져오기 결과와 같은 말).
_UNAVAILABLE_CODES = {
    "not_running", "api_unavailable", "module_unavailable", "python_incompatible", "no_project", "project_changed",
}


class TimelinePlanError(ValueError):
    """계획이 형식에 맞지 않는다 — 부르는 쪽(라우트)이 400 으로 돌려준다."""


def _int(value: Any, label: str, *, low: int, high: int) -> int:
    # bool 은 int 의 하위형이다 — 프레임 자리에 true 가 오면 1 로 읽히지 않게 따로 막는다.
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise TimelinePlanError(f"타임라인 계획의 {label} 값이 올바르지 않습니다")
    return value


def _bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise TimelinePlanError(f"타임라인 계획의 {label} 값이 올바르지 않습니다")
    return value


def _list(value: Any, label: str, limit: int) -> list:
    if not isinstance(value, list) or len(value) > limit:
        raise TimelinePlanError(f"타임라인 계획의 {label} 목록이 올바르지 않습니다")
    return value


def _text(value: Any, label: str, limit: int) -> str:
    if not isinstance(value, str):
        raise TimelinePlanError(f"타임라인 계획의 {label} 값이 올바르지 않습니다")
    return _UNSAFE_NAME.sub(" ", value).strip()[:limit]


def _no_overlap(rows: list[dict[str, Any]], label: str) -> None:
    last_end = -1
    for row in sorted(rows, key=lambda item: (item["start"], item["end"])):
        if row["start"] < last_end:
            raise TimelinePlanError(f"타임라인 계획의 {label} 구간이 서로 겹칩니다")
        last_end = row["end"]


def validate_plan(plan: Any, generation_ids: set[str]) -> dict[str, Any]:
    """계획을 검사해 정리한 사본을 돌려준다. generation_ids = 이 요청이 보내는 생성물(계획의 클립은 이 안의 것만)."""
    unknown = TimelinePlanError("타임라인 계획의 형식을 알 수 없습니다(앱을 새로 고친 뒤 다시 보내세요)")
    version = plan.get("version") if isinstance(plan, dict) else None
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT or isinstance(version, bool) or version not in PLAN_VERSIONS:
        raise unknown
    headed = version == 2
    if plan.get("fps") != TIMELINE_FPS or isinstance(plan.get("fps"), bool):
        raise TimelinePlanError(f"타임라인 계획의 fps 는 {TIMELINE_FPS} 이어야 합니다")
    name = _text(plan.get("name"), "이름", MAX_NAME)
    if not name:
        raise TimelinePlanError("타임라인 이름이 비어 있습니다")
    tracks = _int(plan.get("video_tracks"), "트랙 수", low=1, high=MAX_VIDEO_TRACKS)

    def track_list(key: str) -> list[int]:
        return sorted({_int(value, key, low=1, high=tracks) for value in _list(plan.get(key), key, MAX_VIDEO_TRACKS)})

    def gen_id(row: dict[str, Any], label: str) -> str:
        value = row.get("gen_id")
        if not isinstance(value, str) or value not in generation_ids:
            raise TimelinePlanError(f"타임라인 계획의 {label}이 보낼 생성물 목록에 없습니다")
        return value

    def span(row: Any, label: str) -> tuple[int, int]:
        if not isinstance(row, dict):
            raise TimelinePlanError(f"타임라인 계획의 {label} 항목이 올바르지 않습니다")
        start = _int(row.get("start"), f"{label} 시작", low=0, high=MAX_FRAMES)
        end = _int(row.get("end"), f"{label} 끝", low=start + 1, high=MAX_FRAMES)
        return start, end

    clips: list[dict[str, Any]] = []
    for row in _list(plan.get("clips"), "클립", MAX_CLIPS):
        start, end = span(row, "클립")
        if row.get("kind") not in ("video", "image"):
            raise TimelinePlanError("타임라인 계획의 클립 종류가 올바르지 않습니다")
        # 소스의 시작(24fps 프레임). 1 판에 이 칸이 오면 조용히 버리지 않는다 — 버리면 0초부터 놓고도 '계획대로'라고 답한다.
        if headed:
            head = _int(row.get("head"), "클립 시작점", low=0, high=MAX_FRAMES)
            if head and row["kind"] == "image":
                raise TimelinePlanError("타임라인 계획의 그림 클립에 시작점이 있습니다")
        elif "head" in row:
            raise unknown
        else:
            head = 0
        clips.append({
            "gen_id": gen_id(row, "클립"),
            "track": _int(row.get("track"), "클립 트랙", low=1, high=tracks),
            "start": start, "end": end,
            "enabled": _bool(row.get("enabled"), "클립 켬"),
            "kind": row["kind"],
            "head": head,
        })
    if not clips:
        raise TimelinePlanError("타임라인에 올린 클립이 없습니다")
    for track in range(1, tracks + 1):
        _no_overlap([clip for clip in clips if clip["track"] == track], f"V{track} 클립")

    audio: list[dict[str, Any]] = []
    for row in _list(plan.get("audio"), "소리", MAX_AUDIO):
        start, end = span(row, "소리")
        offset = row.get("offset")
        if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset) or not 0 <= offset <= MAX_FRAMES:
            raise TimelinePlanError("타임라인 계획의 소리 시작 값이 올바르지 않습니다")
        sound_id = gen_id(row, "소리")
        # 2 판: 그 소리를 내는 영상 클립을 트랙으로 가리킨다 — 같은 생성물이 두 트랙에 있어도 제 클립의 시작점을 쓰게.
        #  그 트랙의 그 자리에 그 영상 클립이 없으면 다른 클립으로 대신하지 않는다(계획이 틀린 것이다 — Codex 설계 검토).
        if headed:
            carrier_track = _int(row.get("track"), "소리의 영상 트랙", low=1, high=tracks)
            if not any(item["gen_id"] == sound_id and item["track"] == carrier_track and item["kind"] == "video"
                       and item["start"] <= start < item["end"] for item in clips):
                raise TimelinePlanError("타임라인 계획의 소리가 가리키는 영상 클립이 없습니다")
        elif "track" in row:
            raise unknown
        else:
            carrier_track = None
        audio.append({"gen_id": sound_id, "start": start, "end": end, "offset": float(offset), "track": carrier_track})
    _no_overlap(audio, "소리")

    markers: list[dict[str, Any]] = []
    seen: set[int] = set()
    for row in _list(plan.get("markers"), "북마크", MAX_MARKERS):
        if not isinstance(row, dict) or row.get("color") not in MARKER_COLORS:
            raise TimelinePlanError("타임라인 계획의 북마크가 올바르지 않습니다")
        frame = _int(row.get("frame"), "북마크 자리", low=0, high=MAX_FRAMES)
        if frame in seen:
            continue  # Resolve 는 프레임마다 하나 — 먼저 온 것만
        seen.add(frame)
        markers.append({"frame": frame, "color": row["color"], "name": _text(row.get("name", ""), "북마크 이름", 200)})

    mark = plan.get("mark")
    if mark is not None:
        if not isinstance(mark, dict):
            raise TimelinePlanError("타임라인 계획의 인/아웃이 올바르지 않습니다")
        mark_in = _int(mark.get("in"), "인", low=0, high=MAX_FRAMES)
        mark = {"in": mark_in, "out": _int(mark.get("out"), "아웃", low=mark_in + 1, high=MAX_FRAMES)}

    return {
        "format": PLAN_FORMAT, "version": version, "name": name, "fps": TIMELINE_FPS,
        "video_tracks": tracks, "tracks_off": track_list("tracks_off"), "tracks_locked": track_list("tracks_locked"),
        "muted": _bool(plan.get("muted"), "소리 끔"),
        "clips": clips, "audio": audio, "markers": markers, "mark": mark,
        "total": _int(plan.get("total"), "전체 길이", low=0, high=MAX_FRAMES),
    }


def plan_generation_ids(plan: dict[str, Any]) -> list[str]:
    """계획이 쓰는 생성물 id(겹치지 않게, 나온 순서)."""
    return list(dict.fromkeys(row["gen_id"] for row in [*plan["clips"], *plan["audio"]]))


# ── Resolve 조작 ────────────────────────────────────────────────────────────────────────────────


def new_result(*, status: str = "pending", error: str | None = None, error_code: str | None = None) -> dict[str, Any]:
    return {
        "status": status,  # complete | partial(타임라인은 생겼지만 계획과 다르다) | failed · unavailable(타임라인을 만들지 않았다)
        "timeline_name": "",
        "timeline_id": "",
        "step": "",  # 마지막으로 들어선 단계 — 실패했을 때 어디까지 갔는지
        "video": 0,
        "audio": 0,
        "markers_added": 0,
        "markers_skipped": 0,
        "mark": False,
        "saved": False,
        "mismatches": [],  # 되읽어 보니 계획과 다른 자리(short = 자리는 맞고 원본이 짧아 끝만 비었다)
        "short_sources": [],  # 적힌 길이보다 실제 영상이 짧은 클립(만들기 전에 막는다)
        "warnings": [],
        "error": error,
        "error_code": error_code,
    }


def _clip_facts(clip: Any) -> dict[str, Any]:
    try:
        props = clip.GetClipProperty()
    except TypeError:
        props = None
    if not isinstance(props, dict):
        props = {key: clip.GetClipProperty(key) for key in ("FPS", "Frames", "Audio Ch", "Type")}

    def number(key: str) -> float:
        try:
            return float(props.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    frames = int(number("Frames"))
    kind = str(props.get("Type") or "")
    return {
        "fps": number("FPS"),
        "frames": frames,
        "audio": int(number("Audio Ch")) > 0,
        "still": "still" in kind.casefold() or frames <= 1,
    }


def _same_fps(left: float, right: float) -> bool:
    return abs(left - right) < 0.001


def _frame(value: float) -> int:
    """프레임으로 반올림 — **반은 올린다**(계획을 짓는 프런트의 Math.round 와 같다).

    파이썬의 round 는 반을 짝수로 보낸다(round(121.5) = 122, round(238.5) = 238) — 양끝을 따로 반올림하면 반 프레임 경계에서
    한 프레임이 사라진다(Codex 코드 리뷰).
    """
    return math.floor(value + 0.5)


def _timeline_names(project: Any) -> set[str]:
    names: set[str] = set()
    for index in range(1, int(project.GetTimelineCount() or 0) + 1):
        timeline = project.GetTimelineByIndex(index)
        if timeline:
            names.add(str(timeline.GetName() or ""))
    return names


def _free_name(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    for number in range(2, 1000):
        candidate = f"{wanted}_{number}"
        if candidate not in taken:
            return candidate
    raise ResolveBridgeError("같은 이름의 타임라인이 너무 많습니다", code="timeline_name")


def _rows(timeline: Any, kind: str, index: int, base: int) -> list[dict[str, Any]]:
    """그 트랙에 실제로 놓인 것 — (상대 시작, 길이, 소스 시작)."""
    rows = []
    for item in timeline.GetItemListInTrack(kind, index) or []:
        left = getattr(item, "GetLeftOffset", None)
        rows.append({
            "start": int(round(item.GetStart())) - base,
            "dur": int(round(item.GetDuration())),
            "left": int(round(left())) if callable(left) else None,
            "item": item,
        })
    return rows


def _build_locked(manifest: dict[str, Any], plan: dict[str, Any], resolve: Any, result: dict[str, Any]) -> None:
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    if not project:
        raise ResolveBridgeError("현재 열려 있는 Resolve 프로젝트가 없습니다", code="no_project")
    _assert_expected_project(manifest, project)
    project_id, _project_name = _project_identity(project)
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder() if media_pool else None
    if not media_pool or not root:
        raise ResolveBridgeError("현재 Resolve 프로젝트의 Media Pool을 열 수 없습니다", code="api_unavailable")

    timeline: Any = None
    timeline_id = ""

    def guard() -> None:
        """Resolve 를 바꾸기 직전마다 — 프로젝트와 현재 타임라인이 이번 작업의 것인가.

        프로젝트는 **ProjectManager 에서 다시 물어** 본다: 처음 받은 project 객체만 보면 그사이 다른 프로젝트로 바꾼 것을
        놓치고, SaveProject 는 그때의 현재 프로젝트를 저장한다. 타임라인이 달라졌으면 **되돌리지 않고 멈춘다** — 사용자가
        Resolve 에서 다른 타임라인을 연 것이다(Codex 설계 검토 10-13). 사람의 조작과 API 호출 사이의 틈까지 막지는 못한다.
        """
        current = project_manager.GetCurrentProject()
        if not current:
            raise ResolveBridgeError("Resolve 프로젝트가 닫혀 중단했습니다", code="project_changed")
        _assert_expected_project(manifest, current)
        current_id, _name = _project_identity(current)
        if project_id and current_id and current_id != project_id:
            raise ResolveBridgeError("Resolve 프로젝트가 바뀌어 중단했습니다", code="project_changed")
        if timeline is not None:
            now = current.GetCurrentTimeline()
            if not now or str(now.GetUniqueId() or "") != timeline_id:
                raise ResolveBridgeError(
                    "Resolve 에서 다른 타임라인이 열려 중단했습니다(만들던 타임라인은 그대로 남겨 둡니다)",
                    code="timeline_changed",
                )

    # 1) 가져온 클립 찾기 — 타임라인을 만들기 **전에** 다 찾는다(못 찾으면 아무것도 만들지 않는다). 찾기만 한다(Bin 을 만들지 않는다).
    result["step"] = "locate"
    project_label = _folder_name(str(manifest.get("project_name") or ""), str(manifest.get("project_id") or "프로젝트"))
    managed = _folder_at_path(root, (MEDIA_POOL_ROOT, project_label))
    if managed is None:
        raise ResolveBridgeError("Resolve 에 가져온 원본 폴더(MV Hub)를 찾지 못했습니다", code="clip_missing")
    sources = {
        str(item.get("generation_id") or ""): item
        for item in manifest.get("items") or []
        if item.get("status") in {"downloaded", "skipped"}
    }
    by_folder: dict[tuple[str, ...], dict[str, Any]] = {}
    pool: dict[str, Any] = {}
    facts: dict[str, dict[str, Any]] = {}
    for generation_id in plan_generation_ids(plan):
        source = sources.get(generation_id)
        if source is None:
            raise ResolveBridgeError("타임라인에 올린 영상의 원본이 준비되지 않았습니다", code="source_missing")
        parts = tuple(_folder_name(part, "미분류") for part in _folder_parts(str(source.get("folder_path") or "")))
        if parts not in by_folder:
            folder = _folder_at_path(managed, parts)
            by_folder[parts] = _clips_by_path(folder) if folder is not None else {}
        clip = by_folder[parts].get(_normal_path(str(source.get("local_path") or "")))
        if clip is None:
            raise ResolveBridgeError(
                f"Resolve Media Pool 에서 가져온 영상을 찾지 못했습니다: {source.get('filename') or generation_id}",
                code="clip_missing",
            )
        pool[generation_id] = clip
        facts[generation_id] = _clip_facts(clip)

    # 2) 소스 길이 — 적힌 길이보다 실제 영상이 한 프레임 넘게 짧으면 만들지 않는다. 편집 탭은 그 클립의 실제 끝에서 적힌 끝으로
    #    건너뛰는데 Resolve 는 그 사이에 아래 트랙을 보인다 — 화면도 소리(A1)도 달라진다(Codex 설계 검토 10-13).
    result["step"] = "measure"
    video_infos: dict[int, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for clip_plan in plan["clips"]:
        fact = facts[clip_plan["gen_id"]]
        length = clip_plan["end"] - clip_plan["start"]
        info: dict[str, Any] = {
            "mediaPoolItem": pool[clip_plan["gen_id"]],
            "mediaType": 1,
            "trackIndex": clip_plan["track"],
            "recordFrame": clip_plan["start"],  # 아래에서 타임라인 시작 프레임을 더한다
        }
        short = False
        if not fact["still"]:
            if fact["fps"] <= 0 or fact["frames"] <= 0:
                raise ResolveBridgeError("Resolve 가 영상의 길이를 알려 주지 않았습니다", code="clip_unreadable")
            # 소스의 구간 [first, wanted) — 시작점(head)을 소스 프레임으로 한 번 바꾸고, 끝은 **거기서부터** 센다. 소리도 같은 식을
            #  쓴다(아래) — 시작과 끝을 따로 반올림하면 fps 가 다른 원본에서 영상과 소리의 끝이 한 프레임 갈린다(Codex 설계 검토).
            first = _frame(clip_plan["head"] / TIMELINE_FPS * fact["fps"])
            wanted = first + _frame(length / TIMELINE_FPS * fact["fps"])
            if wanted > fact["frames"]:
                missing = (wanted - fact["frames"]) / fact["fps"] * TIMELINE_FPS
                # 시작점이 원본의 끝이거나 그 뒤면 넣을 것이 한 프레임도 없다 — '한 프레임 모자람'으로 넘기지 않는다
                if missing > 1.0 or first >= fact["frames"]:
                    result["short_sources"].append({
                        "gen_id": clip_plan["gen_id"], "track": clip_plan["track"], "start": clip_plan["start"],
                        "planned": length, "actual": max(0, int((fact["frames"] - first) / fact["fps"] * TIMELINE_FPS)),
                    })
                # 한 프레임 이내로 모자란 것은 있는 만큼 넣는다 — 막으면 보낼 길이 없다(브라우저가 잰 길이는 소리 트랙까지 친 것이라
                #  영상 프레임 수보다 조금 길 수 있다). 다만 끝이 비면 계획과 다른 것이라 되읽을 때 그대로 알린다(short).
                wanted = fact["frames"]
                short = True
            info["startFrame"] = first
            info["endFrame"] = max(first + 1, wanted)
        video_infos.setdefault(clip_plan["track"], []).append((info, {**clip_plan, "short": short}))
    if result["short_sources"]:
        raise ResolveBridgeError(
            f"적힌 길이보다 실제 영상이 짧은 클립이 {len(result['short_sources'])}개 있어 타임라인을 만들지 않았습니다. "
            "편집 탭에서 그 컷의 영상을 한 번 재생해 길이를 맞춘 뒤 다시 보내세요",
            code="source_shorter",
        )
    audio_infos: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for audio_plan in plan["audio"]:
        fact = facts[audio_plan["gen_id"]]
        if fact["still"] or not fact["audio"] or fact["fps"] <= 0:
            continue  # 소리가 없는 영상 — 넣을 것이 없다(아래 트랙의 소리를 대신 넣지 않는다)
        # 소스 안의 시작 = **그 영상 클립이 놓인 자리에서 센 것**이다. 화면은 클립의 처음(소스 0)부터 타임라인 프레임대로 흐르므로,
        #  소리도 같은 프레임 차이만큼 들어가야 그림과 맞는다(초로 적힌 offset 을 따로 반올림하면 한 프레임 어긋날 수 있다).
        #  그 클립을 계획에서 못 찾으면(없어야 한다) 적힌 offset 을 쓴다.
        #  2 판은 그 클립을 트랙으로 가리킨다(validate_plan 이 있는 것을 확인했다) — 같은 생성물이 두 트랙에 있을 때 먼저 찾은 것의
        #  시작점을 쓰지 않게.
        carrier = next((row for row in plan["clips"] if row["gen_id"] == audio_plan["gen_id"]
                        and (audio_plan["track"] is None or row["track"] == audio_plan["track"])
                        and row["start"] <= audio_plan["start"] < row["end"]), None)
        lead = (audio_plan["start"] - carrier["start"]) / TIMELINE_FPS if carrier else audio_plan["offset"]
        # 그 영상 클립이 소스의 중간에서 시작하면(head) 소리도 같은 소스 프레임에서 센다 — 영상과 같은 식(위)
        origin = _frame(carrier["head"] / TIMELINE_FPS * fact["fps"]) if carrier else 0
        first = origin + _frame(lead * fact["fps"])
        # 끝도 소스 좌표다(30fps 영상의 5~10초 = [150, 300)). **끝 시각을 한 번** 반올림한다 — 시작 + 반올림한 길이는 한 프레임
        #  어긋날 수 있다(계획을 짓는 쪽과 같은 규칙). 원본이 모자라 줄인 것은 영상과 같이 되읽을 때 알린다(short).
        wanted = origin + _frame((lead + (audio_plan["end"] - audio_plan["start"]) / TIMELINE_FPS) * fact["fps"])
        last = min(wanted, fact["frames"])
        if last <= first:  # 넣을 소리가 한 프레임도 없다 — 조용히 빼지 않는다
            result["mismatches"].append({
                "track": "A1", "gen_id": audio_plan["gen_id"], "start": audio_plan["start"],
                "expected": audio_plan["end"] - audio_plan["start"], "actual": None, "short": True,
            })
            continue
        audio_infos.append(({
            "mediaPoolItem": pool[audio_plan["gen_id"]], "mediaType": 2, "trackIndex": 1,
            "startFrame": first, "endFrame": last, "recordFrame": audio_plan["start"],
        }, {**audio_plan, "left": first, "fps": fact["fps"], "short": wanted > last}))

    # 3) 타임라인 만들기 — 여기서부터 Resolve 가 바뀐다.
    result["step"] = "create"
    guard()
    previous_folder = media_pool.GetCurrentFolder()
    previous_path = _folder_path_from_root(root, previous_folder) if previous_folder else None
    try:
        media_pool.SetCurrentFolder(managed)
        name = _free_name(plan["name"], _timeline_names(project))
        timeline = media_pool.CreateEmptyTimeline(name)
        if not timeline:
            timeline = None
            raise ResolveBridgeError("Resolve 에 새 타임라인을 만들지 못했습니다", code="timeline_create_failed")
        timeline_id = str(timeline.GetUniqueId() or "")
        result["timeline_name"] = str(timeline.GetName() or name)
        result["timeline_id"] = timeline_id
        guard()  # 만든 것이 현재 타임라인인가(CreateEmptyTimeline 이 스스로 바꾼다 — 실측)

        # fps 를 먼저 맞춘다 — 못 맞추면 아무것도 넣지 않는다(프레임 자리가 전부 틀어진다)
        result["step"] = "fps"
        if not _same_fps(float(timeline.GetSetting("timelineFrameRate") or 0), TIMELINE_FPS):
            timeline.SetSetting("useCustomSettings", "1")
            timeline.SetSetting("timelineFrameRate", str(TIMELINE_FPS))
            if not _same_fps(float(timeline.GetSetting("timelineFrameRate") or 0), TIMELINE_FPS):
                raise ResolveBridgeError(f"새 타임라인을 {TIMELINE_FPS}fps 로 맞추지 못했습니다", code="timeline_fps")
        base = int(timeline.GetStartFrame())

        result["step"] = "tracks"
        while int(timeline.GetTrackCount("video") or 0) < plan["video_tracks"]:
            guard()
            if not timeline.AddTrack("video"):
                raise ResolveBridgeError("새 타임라인에 영상 트랙을 더하지 못했습니다", code="timeline_track")

        def place(kind: str, index: int, entries: list[tuple[dict[str, Any], dict[str, Any]]]) -> list[dict[str, Any]]:
            """넣고 되읽는다 — AppendToTimeline 의 반환은 믿지 않는다(겹치면 잘라 넣고도 True)."""
            guard()
            media_pool.AppendToTimeline([{**info, "recordFrame": base + info["recordFrame"]} for info, _plan in entries])
            return _rows(timeline, kind, index, base)

        unread: list[str] = []  # 앞을 자른 영상인데 소스의 시작을 되읽지 못한 것 — 완료라고 하지 않는다

        def check(kind: str, index: int, rows: list[dict[str, Any]], entries: list[tuple[dict[str, Any], dict[str, Any]]]) -> None:
            actual = {row["start"]: row for row in rows}
            for info, row_plan in entries:
                # 견주는 값은 **계획의 길이**다. 줄여 넣은 길이로 바꿔 견주면 끝이 빈 것이 '계획대로'가 된다(Codex 코드 리뷰).
                expected = row_plan["end"] - row_plan["start"]
                fact = facts[row_plan["gen_id"]]
                # 타임라인과 fps 가 다른 소스는 끝 한 프레임이 달라질 수 있다(실측 — 분수 fps). 같은 fps 는 정확해야 하고,
                #  원본이 모자라 줄여 넣은 것(short)은 fps 가 달라도 봐주지 않는다 — 그 한 프레임이 바로 빈 끝이다.
                slack = 0 if fact["still"] or row_plan["short"] or _same_fps(fact["fps"], TIMELINE_FPS) else 1
                found = actual.pop(row_plan["start"], None)
                if found is not None and kind == "video":
                    # 그 자리에 놓인 클립이다 — 길이가 달라도(short) 끄기는 해야 한다. 길이가 맞을 때만 쥐면 짧게 들어간 꺼 둔
                    #  클립이 켜진 채 남는다(Codex 코드 리뷰).
                    row_plan["item"] = found["item"]
                # 소스의 시작 — 소리는 늘, 영상은 앞을 자른 것만 본다(자르지 않은 영상은 전과 같이 자리·길이만: 그 길은 2026-10-09 실측
                #  그대로 둔다). 시작점이 있는 영상을 되읽지 못하면(API 가 없다) 맞는지 모르는 것이다 — 경고로 남긴다.
                trimmed = kind == "video" and info.get("startFrame", 0) > 0
                wrong_source = (kind == "audio" or trimmed) and found is not None and found["left"] is not None and found["left"] != info["startFrame"]
                if trimmed and found is not None and found["left"] is None:
                    unread.append(row_plan["gen_id"])
                if found is None or abs(found["dur"] - expected) > slack or wrong_source:
                    result["mismatches"].append({
                        "track": f"{'V' if kind == 'video' else 'A'}{index}", "gen_id": row_plan["gen_id"],
                        "start": row_plan["start"], "expected": expected, "actual": found["dur"] if found else None,
                        # 원본이 짧아 끝만 빈 것 — 자리가 틀어진 것과 구분해 알린다
                        "short": bool(row_plan["short"] and found is not None and not wrong_source and found["dur"] < expected),
                    })
            for start in actual:  # 계획에 없는 자리에 놓인 것
                result["mismatches"].append({
                    "track": f"{'V' if kind == 'video' else 'A'}{index}", "gen_id": "", "start": start,
                    "expected": None, "actual": actual[start]["dur"], "short": False,
                })

        result["step"] = "video"
        for track in sorted(video_infos):
            entries = sorted(video_infos[track], key=lambda entry: entry[1]["start"])
            rows = place("video", track, entries)
            check("video", track, rows, entries)
            result["video"] += len(rows)
        if audio_infos:
            result["step"] = "audio"
            rows = place("audio", 1, audio_infos)
            check("audio", 1, rows, audio_infos)
            result["audio"] = len(rows)

        # 4) 상태 — 반환값을 본다. 꺼 둔 것이 살아 있으면 편집 탭에서 보던 것과 다르다(Codex 설계 검토 10-13).
        result["step"] = "state"
        guard()
        failed: list[str] = []
        for _info, clip_plan in (entry for entries in video_infos.values() for entry in entries):
            item = clip_plan.pop("item", None)
            if not clip_plan["enabled"] and (item is None or not item.SetClipEnabled(False)):
                failed.append("꺼 둔 클립")
        for track in plan["tracks_off"]:
            if not timeline.SetTrackEnable("video", track, False):
                failed.append(f"V{track} 끄기")
        if plan["muted"] and not timeline.SetTrackEnable("audio", 1, False):
            failed.append("소리 끄기")

        result["step"] = "markers"
        for marker in plan["markers"]:
            if timeline.AddMarker(marker["frame"], marker["color"], marker["name"], "", 1):
                result["markers_added"] += 1
            else:
                result["markers_skipped"] += 1
        if plan["mark"]:
            # out 은 포함 프레임이다(계획은 끝 미포함)
            result["mark"] = bool(timeline.SetMarkInOut(plan["mark"]["in"], plan["mark"]["out"] - 1, "all"))
            if not result["mark"]:
                failed.append("인/아웃")
        for track in plan["tracks_locked"]:  # 잠금은 맨 끝 — 잠근 트랙에는 넣을 수 없다
            if not timeline.SetTrackLock("video", track, True):
                failed.append(f"V{track} 잠금")
        if failed:
            result["warnings"].append("Resolve 에 적용하지 못한 것: " + ", ".join(dict.fromkeys(failed)))
        if result["markers_skipped"]:
            result["warnings"].append(f"북마크 {result['markers_skipped']}개는 Resolve 가 받지 않았습니다")
        if unread:
            result["warnings"].append(f"앞을 자른 클립 {len(unread)}개의 시작점을 Resolve 에서 확인하지 못했습니다(타임라인에서 직접 확인하세요)")

        result["step"] = "save"
        guard()
        result["saved"] = bool(project_manager.SaveProject())
        if not result["saved"]:
            result["warnings"].append("Resolve 프로젝트 저장을 확인하지 못했습니다(Resolve 에서 직접 저장하세요)")
        result["step"] = "done"
        # complete = 계획대로. 빠진 북마크도 '다르다'에 든다 — 경고만 남기면 화면은 완료라고 말한다(Codex 코드 리뷰).
        different = result["mismatches"] or failed or result["markers_skipped"] or not result["saved"] or unread
        result["status"] = "partial" if different else "complete"
    finally:
        if previous_folder:
            try:
                _refresh_folders(media_pool)
                restored = _folder_at_path(root, previous_path) if previous_path is not None else None
                media_pool.SetCurrentFolder(restored or previous_folder)
            except Exception:  # noqa: BLE001 - 복원 실패가 원래 결과를 덮지 않게 한다.
                pass


def build_timeline(manifest: dict[str, Any], plan: dict[str, Any], *, resolve: Any | None = None) -> dict[str, Any]:
    """계획대로 새 타임라인을 짓고 결과를 돌려준다(예외를 던지지 않는다).

    실패해도 만들던 타임라인은 **지우지 않는다** — 어디까지 갔는지(step)와 이름을 돌려준다. 자동으로 다시 만들지도 않는다.
    """
    result = new_result()
    try:
        with _IMPORT_LOCK:
            _build_locked(manifest, plan, resolve or _connect_resolve(), result)
    except ResolveBridgeError as exc:
        _fail(result, str(exc), exc.code)
    except Exception as exc:  # noqa: BLE001 - Resolve 외부 API 오류가 프로세스를 죽이지 않게 한다.
        _fail(result, str(exc), "unexpected_error")
    return result


def _fail(result: dict[str, Any], message: str, code: str) -> None:
    result["error"] = message
    result["error_code"] = code
    if result["timeline_name"]:
        result["status"] = "partial"  # 만들다 만 타임라인이 Resolve 에 남아 있다
    else:
        result["status"] = "unavailable" if code in _UNAVAILABLE_CODES else "failed"
