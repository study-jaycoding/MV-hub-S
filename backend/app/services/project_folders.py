from __future__ import annotations

from pathlib import Path
from typing import Any

from .path_safety import safe_join
from ..repo import manage as repo_manage


def hidden_folder(name: str) -> bool:
    return name.startswith((".", "_"))


_EXT_BY_TYPE = {"video": ".mp4", "image": ".png", "audio": ".mp3", "3d": ".glb"}


def export_filename(folder_path: str, gen_id: str, file_path: str, media_type: str | None) -> str:
    """저장 파일명(결정적) — <시퀀스>_<gen 앞8자>.<확장자>. 재실행 시 같은 이름 → 멱등."""
    segs = [s for s in folder_path.replace("\\", "/").split("/") if s]
    seq = segs[-1] if segs else "cut"
    src = (file_path or "").split("?", 1)[0]
    ext = ""
    dot = src.rfind(".")
    if dot != -1 and 1 <= len(src) - dot - 1 <= 5:
        ext = src[dot:]
    if not ext:
        ext = _EXT_BY_TYPE.get((media_type or "").lower(), ".bin")
    # gen_id 앞 12자 — 프로젝트 규모가 커져도 파일명 충돌(→ 멱등 오판) 여지 축소(코덱스 #5).
    return f"{seq}_{gen_id[:12]}{ext}"


def safe_dest(render: Path, folder_path: str, filename: str) -> Path | None:
    """render_root/<folder_path>/<filename> 을 검증해 반환. 트래버설·절대경로·드라이브문자 거부."""
    render = render.resolve()
    fp = (folder_path or "").strip().replace("\\", "/")
    segs = [s for s in fp.split("/") if s]
    if not segs or any(s in ("..", ".") for s in segs):
        return None
    if ":" in fp or fp.startswith("/"):  # 드라이브문자(Z:)·절대경로 거부
        return None
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return None
    return safe_join(render, Path(*segs) / filename)


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


def folder_tree_node(
    path: Path,
    root: Path,
    stats: dict[str, int],
    *,
    max_nodes: int = 2000,
) -> tuple[dict[str, Any], int]:
    """Build a folder tree with recursive file counts."""
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
    try:
        entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except (OSError, PermissionError):
        entries = []

    children: list[dict[str, Any]] = []
    count = 0
    for entry in entries:
        if hidden_folder(entry.name):
            continue
        if entry.is_dir():
            node, child_count = folder_tree_node(entry, root, stats, max_nodes=max_nodes)
            children.append(node)
            count += child_count
        elif entry.is_file():
            count += 1
    rel = path.relative_to(root).as_posix() if path != root else ""
    return {"name": path.name, "path": rel, "count": count, "children": children}, count


def render_root_state(pid: str) -> dict[str, Any]:
    """렌더 루트 경로/에러만 반환 — 폴더 트리 재귀 스캔 없이(save-finals 상태·저장용).
    UNC 공유에서 트리 전체 순회는 비싸므로, 존재/Render 감지만 가볍게 한다."""
    meta = repo_manage.get_project_folder(pid)
    root_raw = (meta.get("root_path") or "").strip()
    if not root_raw:
        return {"render_path": "", "error": None}
    root = Path(root_raw).expanduser().resolve()
    if not root.is_dir():
        return {"render_path": "", "error": f"폴더가 없습니다: {root}"}
    render = render_root(root)
    if not render:
        return {"render_path": "", "error": f"Render 폴더가 없습니다: {root}"}
    return {"render_path": str(render), "error": None}


def project_folder_state(pid: str) -> dict[str, Any]:
    meta = repo_manage.get_project_folder(pid)
    root_raw = (meta.get("root_path") or "").strip()
    state: dict[str, Any] = {
        "project_id": pid,
        "root_path": root_raw,
        "selected_path": meta.get("selected_path") or "",
        "render_path": "",
        "tree": None,
        "error": None,
        "truncated": False,
    }
    if not root_raw:
        return state

    root = Path(root_raw).expanduser().resolve()
    if not root.is_dir():
        state["error"] = f"폴더가 없습니다: {root}"
        return state
    render = render_root(root)
    if not render:
        state["error"] = f"Render 폴더가 없습니다: {root}"
        return state
    stats = {"nodes": 0, "truncated": 0}
    tree, _ = folder_tree_node(render, render, stats)
    state["render_path"] = str(render)
    state["tree"] = tree
    state["truncated"] = bool(stats.get("truncated"))
    return state
