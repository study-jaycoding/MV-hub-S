from __future__ import annotations

from pathlib import Path
from typing import Any

from ..repo import manage as repo_manage


def hidden_folder(name: str) -> bool:
    return name.startswith((".", "_"))


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
