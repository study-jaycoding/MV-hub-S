from __future__ import annotations

import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .path_safety import safe_join
from ..repo import manage as repo_manage
from ..repo import projects as repo_projects


# UNC/네트워크 드라이브의 Render 트리를 매 API 호출마다 재귀 순회하면 사이드바를 열거나
# 폴더를 클릭할 때마다 UI가 멈춘다. 짧은 프로세스 메모리 캐시로 같은 프로젝트의 반복 순회를
# 합치되, 루트 변경 시 즉시 무효화하고 필요하면 fresh=True 로 강제 갱신할 수 있게 한다.
_FOLDER_TREE_CACHE_TTL = max(
    1.0, float(os.environ.get("CONTENT_HUB_FOLDER_TREE_CACHE_TTL", "30"))
)
_FOLDER_TREE_CACHE: dict[str, tuple[float, str, dict[str, Any]]] = {}
_FOLDER_TREE_LOCKS: dict[str, threading.Lock] = {}
_FOLDER_TREE_GUARD = threading.Lock()


def invalidate_project_folder(pid: str) -> None:
    with _FOLDER_TREE_GUARD:
        _FOLDER_TREE_CACHE.pop(pid, None)


def _folder_tree_lock(pid: str) -> threading.Lock:
    with _FOLDER_TREE_GUARD:
        return _FOLDER_TREE_LOCKS.setdefault(pid, threading.Lock())


def _cached_folder_scan(pid: str, root_raw: str) -> dict[str, Any] | None:
    now = time.monotonic()
    with _FOLDER_TREE_GUARD:
        cached = _FOLDER_TREE_CACHE.get(pid)
        if not cached:
            return None
        saved_at, saved_root, result = cached
        if saved_root != root_raw or now - saved_at >= _FOLDER_TREE_CACHE_TTL:
            _FOLDER_TREE_CACHE.pop(pid, None)
            return None
        return result


def _remember_folder_scan(pid: str, root_raw: str, result: dict[str, Any]) -> None:
    with _FOLDER_TREE_GUARD:
        _FOLDER_TREE_CACHE[pid] = (time.monotonic(), root_raw, result)


def hidden_folder(name: str) -> bool:
    return name.startswith((".", "_"))


def effective_root_path(pid: str) -> str:
    """이 프로젝트의 렌더 루트 경로 — 팀 공유값(서버 project.render_root_path, 로컬 미러) 우선,
    없으면 레거시 로컬 링크(project_folder_link.root_path). 공유값이 있으면 팀 전원이 같은 경로를
    각자 PC 디스크에서 읽는다(경로 문자열만 공유, 파일은 로컬). 드라이브 매핑은 팀 공통(Z:) 전제."""
    shared = repo_projects.get_render_root(pid).strip()
    if shared:
        return shared
    return (repo_manage.get_project_folder(pid).get("root_path") or "").strip()


def projects_sharing_root(pid: str) -> list[str]:
    """이 프로젝트와 **같은 렌더 폴더**를 쓰는 다른 프로젝트의 id — 경로 글자만 견준다(디스크에 묻지 않는다).
    파일의 각인에는 프로젝트가 없어서, 한 폴더를 두 프로젝트가 쓰면 미러는 어느 파일이 어느 프로젝트의 것인지 가릴 수 없다
    (생성물을 다른 프로젝트로 옮긴 경우 이 PC 의 대장 증거까지 옛 프로젝트에 남는다) → 부르는 쪽이 정리를 하지 않는다.
    ponytail: 매핑 드라이브와 UNC 처럼 글자가 다른 같은 폴더는 못 잡는다(드라이브 매핑은 팀 공통 전제) — 필요해지면 resolve 비교로."""
    def key(raw: str) -> str:
        text = (raw or "").strip().replace("\\", "/").rstrip("/").casefold()
        return text[: -len("/render")] if text.endswith("/render") else text

    mine = key(effective_root_path(pid))
    if not mine:
        return []
    return [other for other, _ in repo_projects.list_id_names() if other != pid and key(effective_root_path(other)) == mine]


_EXT_BY_TYPE = {"video": ".mp4", "image": ".png", "audio": ".mp3", "3d": ".glb"}


def export_ext(file_path: str, media_type: str | None) -> str:
    """저장 확장자 — 원본 경로/URL 의 확장자 우선, 없으면 media_type 기본값."""
    src = (file_path or "").split("?", 1)[0]
    dot = src.rfind(".")
    if dot != -1 and 1 <= len(src) - dot - 1 <= 5:
        return src[dot:]
    return _EXT_BY_TYPE.get((media_type or "").lower(), ".bin")


def export_filename(folder_path: str, gen_id: str, file_path: str, media_type: str | None) -> str:
    """저장 파일명(결정적) — <시퀀스>_<gen 앞8자>.<확장자>. 재실행 시 같은 이름 → 멱등."""
    segs = [s for s in folder_path.replace("\\", "/").split("/") if s]
    seq = segs[-1] if segs else "cut"
    # gen_id 앞 12자 — 프로젝트 규모가 커져도 파일명 충돌(→ 멱등 오판) 여지 축소(코덱스 #5).
    return f"{seq}_{gen_id[:12]}{export_ext(file_path, media_type)}"


SHARED_SUBFOLDER = "shared"


def export_folder(folder_path: str, kind: str | None) -> str:
    """저장 폴더 — 최종본은 컷 폴더 그대로, 공유본은 그 안의 `shared/`(Jay 결정 2026-09-21: 이미 저장된 최종본의
    경로가 안 바뀌고, 폴더만 봐도 어느 것이 최종인지 구분된다)."""
    fp = (folder_path or "").strip().replace("\\", "/").strip("/")
    return f"{fp}/{SHARED_SUBFOLDER}" if kind == "shared" and fp else fp


def _dest_parts(folder_path: str, filename: str) -> list[str] | None:
    """목적지의 글자 검증(디스크에 묻지 않는다) — 트래버설·절대경로·드라이브문자 거부. 통과하면 경로 마디들."""
    fp = (folder_path or "").strip().replace("\\", "/")
    segs = [s for s in fp.split("/") if s]
    if not segs or any(s in ("..", ".") for s in segs):
        return None
    if ":" in fp or fp.startswith("/"):  # 드라이브문자(Z:)·절대경로 거부
        return None
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return None
    return [*segs, filename]


def safe_dest(render: Path, folder_path: str, filename: str) -> Path | None:
    """render_root/<folder_path>/<filename> 을 검증해 반환. 트래버설·절대경로·드라이브문자 거부."""
    render = render.resolve()
    parts = _dest_parts(folder_path, filename)
    return safe_join(render, Path(*parts)) if parts else None


def ledger_dest(render_resolved: Path, folder_path: str, filename: str) -> Path | None:
    """저장 대장과 견줄 목적지 — **디스크에 묻지 않는다**(완료 탭을 열 때의 상태 조회 전용: 대상 수백 건마다 `resolve()` 를 하면
    NAS 에서는 건마다 네트워크 왕복이다). `render_resolved` 는 부르는 쪽이 한 번만 해석해 넘긴다. 쓰기·스캔은 safe_dest 를 쓴다.
    ponytail: 렌더 폴더 안쪽에 심볼릭 링크·junction 이 있으면 대장의 해석 경로와 달라 '이미 저장'이 '새로 저장'으로 보인다
    (저장은 실제 폴더를 확인해 건너뛴다) — 그런 구성이 생기면 상태 조회도 safe_dest 로 되돌린다."""
    parts = _dest_parts(folder_path, filename)
    return render_resolved.joinpath(*parts) if parts else None


def render_root(root: Path) -> Path | None:
    """Return the Render folder inside root, or root itself when it is Render."""
    if root.name.lower() == "render":
        return root
    exact = root / "Render"
    if exact.is_dir():
        return exact
    try:
        for child in root.iterdir():
            if child.is_dir() and child.name.lower() == "render":
                return child
    except (OSError, PermissionError):
        return None
    return None


_FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _is_reparse_directory(entry: os.DirEntry[str]) -> bool:
    """Return whether a child directory is a symlink/junction that must not be traversed.

    ``DirEntry.is_dir(follow_symlinks=False)`` is still true for Windows junctions, and
    ``is_symlink()`` is false for them.  The Windows reparse attribute closes that gap.
    A stat failure is treated as unsafe so an inaccessible link cannot escape the render root.
    """
    try:
        if entry.is_symlink():
            return True
        attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
        return bool(attrs & _FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError:
        return True


def folder_tree_node(
    path: Path,
    root: Path,
    stats: dict[str, int],
    *,
    max_nodes: int = 2000,
) -> tuple[dict[str, Any], int]:
    """Build a folder tree with recursive file counts.

    Files are counted while enumerating but only child directories are sorted.  ``Path.iterdir``
    plus repeated ``Path.is_dir/is_file`` checks used to issue two or three metadata probes per
    file, which is especially expensive on UNC roots.  Reparse directories are intentionally
    skipped so a Windows junction cannot recurse outside (or back into) the render root.
    """
    stats["nodes"] += 1
    if stats["nodes"] > max_nodes:
        stats["truncated"] = 1
        return (
            {
                "name": path.name,
                "path": path.relative_to(root).as_posix() if path != root else "",
                "count": 0,
                "children": [],
            },
            0,
        )

    directories: list[tuple[str, Path]] = []
    count = 0
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if hidden_folder(entry.name):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if _is_reparse_directory(entry):
                            stats["truncated"] = 1
                            continue
                        directories.append((entry.name.lower(), Path(entry.path)))
                    elif entry.is_file(follow_symlinks=False):
                        count += 1
                except OSError:
                    continue
    except OSError:
        pass

    children: list[dict[str, Any]] = []
    for _, directory in sorted(directories, key=lambda item: item[0]):
        if stats["nodes"] >= max_nodes:
            stats["truncated"] = 1
            break
        node, child_count = folder_tree_node(directory, root, stats, max_nodes=max_nodes)
        children.append(node)
        count += child_count
    rel = path.relative_to(root).as_posix() if path != root else ""
    return {"name": path.name, "path": rel, "count": count, "children": children}, count


def render_root_state(pid: str) -> dict[str, Any]:
    """렌더 루트 경로/에러만 반환 — 폴더 트리 재귀 스캔 없이(save-finals 상태·저장용).
    UNC 공유에서 트리 전체 순회는 비싸므로, 존재/Render 감지만 가볍게 한다."""
    root_raw = effective_root_path(pid)
    if not root_raw:
        return {"render_path": "", "error": None}
    root = Path(root_raw).expanduser().resolve()
    if not root.is_dir():
        return {"render_path": "", "error": f"폴더가 없습니다: {root}"}
    render = render_root(root)
    if not render:
        return {"render_path": "", "error": f"Render 폴더가 없습니다: {root}"}
    return {"render_path": str(render), "error": None}


def open_project_folder(pid: str, folder_path: str) -> None:
    """연결된 Render 하위의 기존 폴더만 연다. 생성·저장·전체 트리 스캔 없음."""
    relative = folder_path.replace("\\", "/")
    parts = relative.split("/")
    if (not relative or relative.startswith("/") or
            any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in parts) or
            any(char in relative for char in ':"<>|?*') or
            any(ord(char) < 32 or ord(char) == 127 for char in relative)):
        raise ValueError("올바른 하위 폴더 경로가 아닙니다")
    state = render_root_state(pid)
    if state["error"]:
        raise FileNotFoundError("연결된 Render 폴더에 접근할 수 없습니다. 드라이브 연결을 확인해 주세요")
    if not state["render_path"]:
        raise ValueError("프로젝트의 Render 폴더가 연결되지 않았습니다")
    target = safe_join(Path(state["render_path"]), Path(*parts))
    if target is None:
        raise ValueError("연결된 Render 폴더 밖의 위치는 열 수 없습니다")
    if not target.is_dir():
        raise FileNotFoundError("해당 폴더가 없습니다. 폴더 위치와 드라이브 연결을 확인해 주세요")
    command = "explorer.exe" if sys.platform == "win32" else "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.Popen([command, str(target)], shell=False)
    except OSError as exc:
        # 실행 파일 부재(FileNotFoundError)를 폴더 부재(404)와 구분한다.
        raise OSError("탐색기를 실행할 수 없습니다") from exc


def _scan_project_folder(root_raw: str) -> dict[str, Any]:
    """디스크에서 Render 트리만 읽는다. selected_path 같은 개인 상태는 캐시에 넣지 않는다."""
    result: dict[str, Any] = {
        "render_path": "",
        "tree": None,
        "error": None,
        "truncated": False,
    }
    root = Path(root_raw).expanduser().resolve()
    if not root.is_dir():
        result["error"] = f"폴더가 없습니다: {root}"
        return result
    render = render_root(root)
    if not render:
        result["error"] = f"Render 폴더가 없습니다: {root}"
        return result
    stats = {"nodes": 0, "truncated": 0}
    tree, _ = folder_tree_node(render, render, stats)
    result["render_path"] = str(render)
    result["tree"] = tree
    result["truncated"] = bool(stats.get("truncated"))
    return result


def project_folder_state(pid: str, *, fresh: bool = False) -> dict[str, Any]:
    meta = repo_manage.get_project_folder(pid)
    root_raw = effective_root_path(pid)  # 공유(서버) 우선, 없으면 로컬 링크
    state: dict[str, Any] = {
        "project_id": pid,
        "root_path": root_raw,
        "selected_path": meta.get("selected_path") or "",  # selected 는 개인(로컬) 유지
        "render_path": "",
        "tree": None,
        "error": None,
        "truncated": False,
    }
    if not root_raw:
        invalidate_project_folder(pid)
        return state

    scan = None if fresh else _cached_folder_scan(pid, root_raw)
    if scan is None:
        # 같은 프로젝트에 요청이 동시에 몰려도 실제 재귀 순회는 한 번만 수행한다.
        with _folder_tree_lock(pid):
            scan = None if fresh else _cached_folder_scan(pid, root_raw)
            if scan is None:
                scan = _scan_project_folder(root_raw)
                _remember_folder_scan(pid, root_raw, scan)
    state.update(scan)
    return state
