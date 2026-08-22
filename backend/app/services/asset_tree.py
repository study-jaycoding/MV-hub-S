"""Assets 폴더 트리 탐색과 프로세스 메모리 캐시.

라우터는 프로젝트 경로와 표시 정책만 결정하고, 재귀 파일 탐색·동시 요청 합치기·
캐시 무효화는 이 서비스가 전담한다. 파일 감시기도 이 모듈의 무효화 함수만 호출하므로
서비스 계층이 라우터를 역으로 참조하지 않는다.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from .media_types import asset_media_type
from .path_safety import safe_join
from .project_folders import hidden_folder


_TREE_MAX_DEPTH = 24
_TREE_MAX_NODES = 20000
_TREE_TTL = max(
    1.0, float(os.environ.get("CONTENT_HUB_ASSET_TREE_CACHE_TTL", "30"))
)

_CacheKey = tuple[str, str, tuple[str, ...]]
_EpochKey = tuple[str, str, tuple[str, ...]]
_TREE_CACHE: dict[_CacheKey, tuple[float, list[dict[str, Any]]]] = {}
_TREE_SCAN_LOCKS: dict[_CacheKey, threading.Lock] = {}
_TREE_INVALIDATION_EPOCHS: dict[_EpochKey, int] = {}
_TREE_CACHE_LOCK = threading.Lock()


@dataclass(frozen=True)
class AssetTreeRead:
    children: list[dict[str, Any]]
    scanned: bool


def is_hidden_name(name: str) -> bool:
    """트리에서 숨기는 이름(숨김 폴더/파일 + readme) — 라우터의 재매칭 스캔도 같은 규칙을 쓴다."""
    return hidden_folder(name) or name.lower() == "readme.md"


_hidden = is_hidden_name


def _hidden_key(hidden_names: Optional[set[str]]) -> tuple[str, ...]:
    return tuple(sorted(name.lower() for name in (hidden_names or set())))


def _project_key(directory: Path, hidden_names: Optional[set[str]]) -> _CacheKey:
    return ("project", str(directory), _hidden_key(hidden_names))


def _combined_key(assets_root: Path, folders: Iterable[str]) -> _CacheKey:
    return ("combined", str(assets_root), tuple(folders))


def _tree_scan_lock(key: _CacheKey) -> threading.Lock:
    with _TREE_CACHE_LOCK:
        return _TREE_SCAN_LOCKS.setdefault(key, threading.Lock())


def _epoch_key(key: _CacheKey) -> _EpochKey:
    # 표시 제외 정책이 달라도 같은 프로젝트 디스크를 읽으므로 무효화 세대를 공유한다.
    return (key[0], key[1], ()) if key[0] == "project" else key


def _scan_epoch(key: _CacheKey) -> int:
    with _TREE_CACHE_LOCK:
        return _TREE_INVALIDATION_EPOCHS.get(_epoch_key(key), 0)


def _cached_tree(key: _CacheKey) -> list[dict[str, Any]] | None:
    with _TREE_CACHE_LOCK:
        cached = _TREE_CACHE.get(key)
        if cached and (time.monotonic() - cached[0]) < _TREE_TTL:
            return cached[1]
        if cached:
            _TREE_CACHE.pop(key, None)
    return None


def _remember_tree(
    key: _CacheKey,
    children: list[dict[str, Any]],
    scan_epoch: int,
) -> None:
    with _TREE_CACHE_LOCK:
        if _TREE_INVALIDATION_EPOCHS.get(_epoch_key(key), 0) == scan_epoch:
            _TREE_CACHE[key] = (time.monotonic(), children)


def invalidate_project_tree(directory: Path) -> None:
    """같은 디스크 폴더의 표시 정책별 캐시를 모두 비운다."""
    directory_key = str(directory)
    with _TREE_CACHE_LOCK:
        epoch_key: _EpochKey = ("project", directory_key, ())
        _TREE_INVALIDATION_EPOCHS[epoch_key] = (
            _TREE_INVALIDATION_EPOCHS.get(epoch_key, 0) + 1
        )
        stale = [
            key
            for key in _TREE_CACHE
            if key[0] == "project" and key[1] == directory_key
        ]
        for key in stale:
            _TREE_CACHE.pop(key, None)


def invalidate_combined_tree(assets_root: Path, folders: Iterable[str]) -> None:
    key = _combined_key(assets_root, folders)
    with _TREE_CACHE_LOCK:
        _TREE_INVALIDATION_EPOCHS[key] = _TREE_INVALIDATION_EPOCHS.get(key, 0) + 1
        _TREE_CACHE.pop(key, None)


def build_tree(
    directory: Path,
    rel_prefix: str,
    *,
    hidden_names: Optional[set[str]] = None,
    _depth: int = 0,
    _budget: Optional[list[int]] = None,
) -> list[dict[str, Any]]:
    """폴더 우선으로 재귀 순회하고 미디어 파일만 트리에 포함한다.

    심볼릭 링크·Windows 정션은 따라가지 않고, 깊이·노드 상한으로 거대하거나
    순환하는 트리가 요청 스레드를 계속 점유하지 않게 한다.
    """
    if _budget is None:
        _budget = [_TREE_MAX_NODES]
    if _depth > _TREE_MAX_DEPTH or _budget[0] <= 0:
        return []

    try:
        entries: list[tuple[os.DirEntry[str], bool, bool]] = []
        with os.scandir(directory) as scan:
            for entry in scan:
                if _hidden(entry.name):
                    continue
                if hidden_names and entry.name.lower() in hidden_names:
                    continue
                try:
                    is_symlink = entry.is_symlink()
                    is_dir = entry.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                entries.append((entry, is_dir, is_symlink))
        entries.sort(key=lambda item: (not item[1], item[0].name.lower()))
    except (PermissionError, OSError):
        return []

    out: list[dict[str, Any]] = []
    reparse_point_attr = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
    for entry, is_dir, is_symlink in entries:
        if _budget[0] <= 0:
            break
        if is_symlink:
            continue

        rel = f"{rel_prefix}{entry.name}"
        if is_dir:
            try:
                entry_stat = entry.stat(follow_symlinks=False)
                if getattr(entry_stat, "st_file_attributes", 0) & reparse_point_attr:
                    continue
            except OSError:
                continue
            _budget[0] -= 1
            out.append(
                {
                    "name": entry.name,
                    "type": "dir",
                    "path": rel,
                    "children": build_tree(
                        Path(entry.path),
                        rel + "/",
                        hidden_names=hidden_names,
                        _depth=_depth + 1,
                        _budget=_budget,
                    ),
                }
            )
            continue

        media_type = asset_media_type(entry.name, include_audio=True)
        if not media_type:
            continue
        try:
            entry_stat = entry.stat(follow_symlinks=False)
            if getattr(entry_stat, "st_file_attributes", 0) & reparse_point_attr:
                continue
        except OSError:
            continue
        _budget[0] -= 1
        out.append(
            {
                "name": entry.name,
                "type": media_type,
                "path": rel,
                "mtime": entry_stat.st_mtime,
                "version": f"{entry_stat.st_mtime_ns}-{entry_stat.st_size}",
            }
        )
    return out


def read_project_tree(
    directory: Path,
    *,
    fresh: bool = False,
    hidden_names: Optional[set[str]] = None,
) -> AssetTreeRead:
    """프로젝트 트리를 읽는다. 같은 키의 동시 캐시 미스는 한 번만 스캔한다."""
    normalized_hidden = set(_hidden_key(hidden_names)) or None
    key = _project_key(directory, normalized_hidden)
    if fresh:
        invalidate_project_tree(directory)

    if not fresh:
        children = _cached_tree(key)
        if children is not None:
            return AssetTreeRead(children=children, scanned=False)

    with _tree_scan_lock(key):
        if not fresh:
            children = _cached_tree(key)
            if children is not None:
                return AssetTreeRead(children=children, scanned=False)
        scan_epoch = _scan_epoch(key)
        children = build_tree(directory, "", hidden_names=normalized_hidden)
        _remember_tree(key, children, scan_epoch)
        return AssetTreeRead(children=children, scanned=True)


def _scan_combined_internal_children(
    assets_root: Path, folders: tuple[str, ...]
) -> list[dict[str, Any]]:
    children: list[dict[str, Any]] = []
    for folder in folders:
        directory = (assets_root / folder).resolve()
        if not directory.is_dir():
            continue
        subtree = build_tree(directory, f"{folder}/")
        if subtree:
            children.append(
                {
                    "name": folder,
                    "type": "dir",
                    "path": folder,
                    "children": subtree,
                }
            )
    return children


def read_combined_tree(
    assets_root: Path,
    folders: Iterable[str],
    *,
    fresh: bool = False,
) -> list[dict[str, Any]]:
    """여러 내장 폴더를 하나의 루트 아래에 묶어 캐시된 트리로 반환한다."""
    folder_tuple = tuple(folders)
    key = _combined_key(assets_root, folder_tuple)
    if fresh:
        invalidate_combined_tree(assets_root, folder_tuple)

    if not fresh:
        children = _cached_tree(key)
        if children is not None:
            return children

    with _tree_scan_lock(key):
        if not fresh:
            children = _cached_tree(key)
            if children is not None:
                return children
        scan_epoch = _scan_epoch(key)
        children = _scan_combined_internal_children(assets_root, folder_tuple)
        _remember_tree(key, children, scan_epoch)
    return children


def collect_media(
    nodes: list[dict[str, Any]], project_dir: Path
) -> list[tuple[Path, str]]:
    """트리에서 썸네일 프리워밍 대상 이미지·영상 경로를 수집한다."""
    out: list[tuple[Path, str]] = []
    for node in nodes:
        media_type = node.get("type")
        if media_type == "dir":
            out.extend(collect_media(node.get("children") or [], project_dir))
        elif media_type in ("image", "video"):
            target = safe_join(project_dir, str(node.get("path") or ""))
            if target and target.is_file():
                out.append((target, media_type))
    return out
