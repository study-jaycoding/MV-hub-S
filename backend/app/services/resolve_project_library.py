"""Disk Project Library의 프로젝트 목록·대표 그림·열기 요청과 Resolve 켜기를 다룬다."""

from __future__ import annotations

import base64
import csv
import os
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from .resolve_bridge import resolve_process_running
from .resolve_library_dialog import (
    _resolve_executable,
    library_name_for_project,
    registered_library_name,
)
from .resolve_status_runner import (
    begin_launch_window,
    end_launch_window,
    end_launch_window_if_closed,
    launch_window_active,
    run_resolve_project_open_isolated,
)


_MAX_PROJECTS = 2000
_MAX_DEPTH = 12


class ResolveProjectLibraryError(RuntimeError):
    """Resolve 프로젝트 라이브러리를 읽거나 열지 못한 경우. code 는 라우터가 HTTP 상태를 고르는 데 쓴다."""

    def __init__(self, message: str, *, code: str = ""):
        super().__init__(message)
        self.code = code


def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        stat = os.stat(path, follow_symlinks=False)
    except OSError:
        return True
    return path.is_symlink() or bool(getattr(stat, "st_file_attributes", 0) & 0x400)


def _projects_root(library_root: Path) -> Path:
    users_root = library_root / "Resolve Projects" / "Users"
    guest_root = users_root / "guest" / "Projects"
    if guest_root.is_dir() and not _is_reparse_or_symlink(guest_root):
        return guest_root
    try:
        candidates = sorted(
            (
                child / "Projects"
                for child in users_root.iterdir()
                if child.is_dir() and not _is_reparse_or_symlink(child)
            ),
            key=lambda path: path.parent.name.casefold(),
        )
    except OSError:
        candidates = []
    return next(
        (
            path
            for path in candidates
            if path.is_dir() and not _is_reparse_or_symlink(path)
        ),
        guest_root,
    )


def list_disk_projects(library_root: Path) -> list[dict[str, Any]]:
    """Project.db를 읽지 않고 위치·수정시각만으로 프로젝트 목록을 만든다."""
    root = Path(library_root)
    projects_root = _projects_root(root)
    if not projects_root.is_dir() or _is_reparse_or_symlink(projects_root):
        raise ResolveProjectLibraryError(
            "Resolve Projects 아래에서 사용자 프로젝트 폴더를 찾지 못했습니다."
        )

    projects: list[dict[str, Any]] = []
    try:
        for current, directories, files in os.walk(projects_root, followlinks=False):
            current_path = Path(current)
            relative = current_path.relative_to(projects_root)
            if len(relative.parts) >= _MAX_DEPTH:
                directories[:] = []
            else:
                directories[:] = [
                    name
                    for name in directories
                    if not _is_reparse_or_symlink(current_path / name)
                ]

            project_db_name = next(
                (name for name in files if name.casefold() == "project.db"), None
            )
            if not project_db_name or not relative.parts:
                continue
            project_db = current_path / project_db_name
            try:
                stat = project_db.stat()
            except OSError:
                continue
            project_folder = "/".join(relative.parts[:-1])
            projects.append(
                {
                    "name": relative.parts[-1],
                    "folder_path": project_folder,
                    "mtime": stat.st_mtime,
                    "size": stat.st_size,
                }
            )
            directories[:] = []
            if len(projects) >= _MAX_PROJECTS:
                break
    except OSError as exc:
        raise ResolveProjectLibraryError(
            "Resolve 프로젝트 목록을 읽지 못했습니다."
        ) from exc

    projects.sort(key=lambda item: (-float(item["mtime"]), str(item["name"]).casefold()))
    return projects


def open_disk_project(
    library_root: Path,
    asset_project_name: str,
    project_name: str,
    folder_path: str,
    launch_id: str = "",
) -> dict[str, Any]:
    """디스크에 실제 존재하는 프로젝트만 공식 Resolve API로 연다.

    이름 없는 빈 새 프로젝트가 열려 있으면 묻지 않고 저장만 건너뛰어 연다(resolve_project_open_worker.
    _release_current). launch_id = 이 열기가 부른 켜기의 번호(launch_resolve) — 켜는 동안엔 이것이 맞는
    열기만 Resolve 에 닿는다. 이름이 라이브러리에서 하나뿐이면 name_unique 를 넘겨, 지금 열린 게 그 프로젝트일 때
    워커가 다시 불러오지 않게 한다(이름은 글자 그대로 센다 — 대소문자·공백을 다듬으면 다른 프로젝트로 오판한다).
    """
    projects = list_disk_projects(library_root)
    target = next(
        (
            item
            for item in projects
            if item["name"] == project_name and item["folder_path"] == folder_path
        ),
        None,
    )
    if target is None:
        raise ResolveProjectLibraryError("선택한 Resolve 프로젝트를 찾지 못했습니다.")

    # 이 폴더가 Resolve 에 어떤 이름으로 등록돼 있는지는 경로로 찾는다(해시가 붙기 전 옛 이름·
    # 사람이 지은 이름일 수 있다). 모르면 우리가 연결할 때 쓰는 이름으로 찾는다.
    library_name = registered_library_name(library_root) or library_name_for_project(
        asset_project_name, library_root
    )
    result = run_resolve_project_open_isolated(
        {
            "library_name": library_name,
            "project_name": project_name,
            "folder_parts": [part for part in folder_path.split("/") if part],
            "name_unique": sum(item["name"] == project_name for item in projects) == 1,
        },
        launch_id=launch_id,
    )
    if result.get("status") != "complete":
        raise ResolveProjectLibraryError(
            str(result.get("error") or "Resolve 프로젝트를 열지 못했습니다."),
            code=str(result.get("error_code") or ""),
        )
    return {**result, "library_name": library_name}


# ── 대표 그림 ──
# Resolve 는 프로젝트마다 그림 1~5장을 Project.db 안 BtThumnail(철자 그대로) 에 JPEG 로 둔다(2026-09-22 실측).
# Resolve API 에는 이걸 주는 함수가 없다(21.1 설명서). 원본은 NAS 위에서 Resolve 가 쓰는 SQLite 라 절대 열지 않고,
# 로컬 임시 복사본만 연다. 표시 전용 — 최신이라는 보장은 없고, 못 믿을 복사본이면 그림을 내지 않는다.
# 상한(Codex P1) — 실측은 프로젝트당 1~5장·장당 4.5~9KB·12개 합 310KB 다. 손상되거나 달라진 DB 하나가
# 응답·메모리·NAS 를 붙잡지 않게 넉넉히 끊는다.
_MAX_FRAMES = 8
_MAX_FRAME_BYTES = 256 * 1024
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_THUMB_SQL = (
    "SELECT t.Buffer FROM BtThumnail_SM_Project m "
    "JOIN BtThumnail t ON t.BtThumnail_id = m.DbAssociate "
    "WHERE m.DbPropertyName = 'Thumbnails' AND length(t.Buffer) <= ? "
    "ORDER BY m.DbIndex LIMIT ?"
)
_SQLITE_MAGIC = b"SQLite format 3" + bytes(1)
_JPEG_MAGIC = bytes((0xFF, 0xD8, 0xFF))
# ── 카드 정보(타임라인 수·해상도·fps) — 같은 복사본에서 함께 읽는다. Resolve API 는 이 값을 주지 않는다
# (GetProjectAttributesInCurrentFolder = 날짜·메모뿐). 해상도 = Sm2Sequence.Resolution(빅엔디언 int64 두 개),
# fps = Sm2Sequence.FrameRate 앞 8바이트(리틀엔디언 double) — 2026-09-22 실측(12개 모두 1920x1080·24,
# 다른 값의 인코딩은 미확인). 타임라인마다 값이 다르면 대표값을 지어내지 않고 비운다(Codex).
_TIMELINES_SQL = (
    "SELECT count(*) FROM SM_Project_Sm2Timeline WHERE DbPropertyName = 'TimelineHandleVec'"
)
_FORMATS_SQL = (
    "SELECT s.Resolution, s.FrameRate FROM SM_Project_Sm2Timeline m "
    "JOIN Sm2Timeline t ON t.Sm2Timeline_id = m.DbAssociate "
    "JOIN Sm2Sequence s ON s.Sm2Sequence_id = t.Sequence "
    "WHERE m.DbPropertyName = 'TimelineHandleVec' LIMIT ?"
)
_MAX_INFO_TIMELINES = 500
# 캐시 값 = (그림 base64 목록, 카드 정보)
_thumb_cache: dict[tuple[str, int, int], tuple[list[str], dict[str, Any]]] = {}
_thumb_lock = threading.Lock()


def _db_signature(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


def _journal_present(path: Path) -> bool:
    return any(path.with_name(path.name + suffix).exists() for suffix in ("-journal", "-wal"))


def _timeline_format(resolution: Any, frame_rate: Any) -> tuple[int, int, float] | None:
    """Sm2Sequence 의 해상도·fps. 모르는 모양이거나 말이 안 되는 값이면 None."""
    if not (isinstance(resolution, bytes) and isinstance(frame_rate, bytes)):
        return None
    if len(resolution) != 16 or len(frame_rate) != 16:
        return None
    width, height = struct.unpack(">2q", resolution)
    (fps,) = struct.unpack("<d", frame_rate[:8])
    # NaN 은 비교가 모두 거짓이라 여기서 걸러진다.
    if not (0 < width <= 32768 and 0 < height <= 32768 and 0 < fps <= 1000):
        return None
    return width, height, round(fps, 3)


def _read_info(connection: sqlite3.Connection) -> dict[str, Any]:
    """타임라인 수와, 모든 타임라인이 같을 때만 해상도·fps. 표가 없거나(다른 Resolve 버전) 모양이 다르면 아는 것만."""
    info: dict[str, Any] = {}
    try:
        (count,) = connection.execute(_TIMELINES_SQL).fetchone()
        info["timelines"] = int(count)
        if info["timelines"] > _MAX_INFO_TIMELINES:
            return info  # 다 비교하지 못하면 '모두 같다'고 말할 수 없다(Codex P1)
        formats = {
            _timeline_format(resolution, frame_rate)
            for resolution, frame_rate in connection.execute(_FORMATS_SQL, (_MAX_INFO_TIMELINES,))
        }
    except (sqlite3.Error, TypeError, ValueError):
        return info
    if len(formats) == 1 and None not in formats:
        width, height, fps = formats.pop()
        info.update(width=width, height=height, fps=fps)
    return info


def _read_project(project_db: Path) -> tuple[list[str], dict[str, Any]] | None:
    """복사본에서 그림(base64)과 카드 정보를 꺼낸다. 복사 도중 Resolve 가 썼거나 WAL 이면 None(Codex P1).

    정보는 따로 읽는다 — 정보 표를 못 읽어도 그림은 잃지 않는다(Codex).
    """
    # 링크(심볼릭·재파스)면 따라가지 않는다 — 폴더는 목록에서 이미 거르지만 파일 자체도 본다(Codex P1).
    if _is_reparse_or_symlink(project_db):
        return None
    before = _db_signature(project_db)
    if before is None or _journal_present(project_db):
        return None
    handle, temp_name = tempfile.mkstemp(suffix=".db", prefix="mvhub-resolve-thumb-")
    os.close(handle)
    temp = Path(temp_name)
    try:
        shutil.copyfile(project_db, temp)
        if _db_signature(project_db) != before or _journal_present(project_db):
            return None
        with temp.open("rb") as copied:
            head = copied.read(20)
        # 머리 18·19 = 2 면 WAL — 본 파일만으로는 마지막 저장이 빠져 있을 수 있다.
        if not head.startswith(_SQLITE_MAGIC) or 2 in (head[18], head[19]):
            return None
        connection = sqlite3.connect(temp.as_uri() + "?mode=ro", uri=True)
        try:
            rows = connection.execute(_THUMB_SQL, (_MAX_FRAME_BYTES, _MAX_FRAMES)).fetchall()
            info = _read_info(connection)
        finally:
            connection.close()
    except (OSError, sqlite3.Error, IndexError):
        return None
    finally:
        temp.unlink(missing_ok=True)
    frames = [bytes(row[0]) for row in rows if row[0]]
    encoded = [base64.b64encode(frame).decode("ascii") for frame in frames if frame[:3] == _JPEG_MAGIC]
    return encoded, info


def project_cards(library_root: Path) -> dict[str, dict[str, Any]]:
    """목록의 프로젝트마다 카드에 쓸 것 → {"thumbnails": {키: 그림 base64 목록(저장 순서)},
    "details": {키: {"timelines", "width"?, "height"?, "fps"?}}}. 키 = "<folder_path>/<name>".

    못 읽은 프로젝트는 빠진다(다음 요청에 다시 본다). 캐시는 (경로, mtime_ns, 크기)가 같을 때만 쓰고,
    이 라이브러리의 이번 목록에 없는 항목은 버린다. 순차로 복사한다(12개 1.6초 실측 — NAS 에 온화하게).
    """
    root = Path(library_root)
    projects_root = _projects_root(root)
    prefix = os.path.normcase(str(projects_root))
    seen: set[tuple[str, int, int]] = set()
    thumbnails: dict[str, list[str]] = {}
    details: dict[str, dict[str, Any]] = {}
    total = 0
    for item in list_disk_projects(root):
        if total >= _MAX_RESPONSE_BYTES:
            break  # 나머지 카드는 아이콘 자리표시 — 응답이 끝없이 커지지 않게
        parts = [part for part in str(item["folder_path"]).split("/") if part]
        project_db = projects_root.joinpath(*parts, str(item["name"]), "Project.db")
        signature = _db_signature(project_db)
        if signature is None:
            continue
        key = (os.path.normcase(str(project_db)), *signature)
        seen.add(key)
        with _thumb_lock:
            cached = _thumb_cache.get(key)
        if cached is None:
            cached = _read_project(project_db)
            if cached is None:
                continue
            with _thumb_lock:
                _thumb_cache[key] = cached
        frames, info = cached
        card_key = f"{item['folder_path']}/{item['name']}"
        if frames:
            thumbnails[card_key] = frames
            total += sum(len(frame) for frame in frames)
        if info:
            details[card_key] = info
    with _thumb_lock:
        for stale in [key for key in _thumb_cache if key[0].startswith(prefix) and key not in seen]:
            del _thumb_cache[stale]
    return {"thumbnails": thumbnails, "details": details}


# ── Resolve 켜기 ──
# 서버는 켜고 바로 돌아온다 — 준비될 때까지 붙잡지 않는다(Codex P1: 화면을 떠난 뒤 늦게 열리는 일 막기).
# 준비는 화면이 launch-state 로 본다. 켜는 동안 서버 전체가 Resolve API 를 부르지 않는다 — 켜기 창
# (resolve_status_runner.begin_launch_window, Jay 2026-09-22 B안). 그 창이 90초 재실행 방지도 겸한다.
_LAUNCH_LOCK = threading.Lock()


def resolve_window_title() -> str | None:
    """Windows 작업 목록의 Resolve.exe 창 제목. 꺼졌거나 모르면 None, 창이 아직 없으면 ''.

    창이 생겼다는 힌트일 뿐 스크립트 API 준비를 뜻하지 않는다 — 화면은 열기가 '준비 안 됨'이면 다시 시도한다.
    """
    if os.name != "nt":
        return None
    try:
        completed = subprocess.run(
            ["tasklist", "/V", "/FI", "IMAGENAME eq Resolve.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for row in csv.reader(completed.stdout.splitlines()):
        if row and row[0].strip().casefold() == "resolve.exe":
            title = row[-1].strip()
            return "" if title in ("", "N/A") else title
    return None


def launch_resolve() -> dict[str, str]:
    """Resolve 가 꺼져 있으면 켠다 → {"status": "running"|"starting", "launch_id"}. 기다리지 않는다.

    launch_id 는 이번에 실제로 켠 호출에만 준다 — 그 화면의 열기만 켜는 동안 Resolve 에 닿게(Codex P1).
    이미 켜는 중이면 빈 값이다(다른 화면이 켠 것을 기다린다).
    """
    running = resolve_process_running()
    if running:
        return {"status": "running", "launch_id": ""}
    if running is None:
        raise ResolveProjectLibraryError(
            "Resolve 가 켜져 있는지 확인하지 못했습니다.", code="state_unknown"
        )
    if os.name != "nt":
        raise ResolveProjectLibraryError("이 기능은 Windows에서만 사용할 수 있습니다.", code="unsupported")
    end_launch_window_if_closed(running)  # 켜다 죽었으면 다시 켤 수 있게
    with _LAUNCH_LOCK:
        if launch_window_active():
            # 방금 켰다 — 작업 목록에 뜨기 전이라 또 켜지 않는다
            return {"status": "starting", "launch_id": ""}
        executable = _resolve_executable()
        if not executable or not Path(executable).is_file():
            raise ResolveProjectLibraryError(
                "DaVinci Resolve 설치 파일을 찾지 못했습니다.", code="resolve_missing"
            )
        # 켜기 '전에' 창을 연다 — 켜지는 틈에 검사·감시가 끼지 않게(Codex P1). 못 켰으면 바로 닫는다.
        launch_id = begin_launch_window()
        try:
            os.startfile(executable)  # noqa: S606 - 레지스트리에 등록된 Resolve.exe 만 켠다
        except OSError as exc:
            end_launch_window()
            raise ResolveProjectLibraryError(
                "DaVinci Resolve 를 켜지 못했습니다.", code="launch_failed"
            ) from exc
    return {"status": "starting", "launch_id": launch_id}
