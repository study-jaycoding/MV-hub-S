"""계정별 Assets 마운트 저장소.

JSON 형식의 하위 호환은 유지하면서, 한 프로세스 안의 여러 Assets 창이 동시에 등록·해제할 때
각 요청의 ``읽기→수정→원자 저장`` 전체를 파일별 잠금으로 묶어 변경 유실을 막는다.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable

from .atomic_io import atomic_write_text


Mount = dict[str, str]

_LOCKS_GUARD = threading.Lock()
_FILE_LOCKS: dict[str, threading.RLock] = {}


def _file_lock(path: Path) -> threading.RLock:
    # Windows는 경로 대소문자를 구분하지 않으므로 같은 파일의 표기 차이도 같은 잠금을 쓴다.
    key = os.path.normcase(str(path.resolve()))
    with _LOCKS_GUARD:
        return _FILE_LOCKS.setdefault(key, threading.RLock())


def _read_unlocked(path: Path) -> list[Mount]:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return []
    mounts = data.get("mounts", []) if isinstance(data, dict) else []
    out: list[Mount] = []
    for mount in mounts:
        if not isinstance(mount, dict):
            continue
        name = str(mount.get("name", "")).strip()
        location = str(mount.get("path", "")).strip()
        if not (name and location):
            continue
        out.append(
            {
                "name": name,
                "path": location,
                "owner": str(mount.get("owner", "")).strip(),
            }
        )
    return out


def _write_unlocked(path: Path, mounts: list[Mount]) -> None:
    atomic_write_text(
        path,
        json.dumps({"mounts": mounts}, ensure_ascii=False, indent=2),
    )


def load(path: Path) -> list[Mount]:
    with _file_lock(path):
        return _read_unlocked(path)


def save(path: Path, mounts: list[Mount]) -> None:
    with _file_lock(path):
        _write_unlocked(path, mounts)


def _update(path: Path, mutate: Callable[[list[Mount]], list[Mount]]) -> list[Mount]:
    with _file_lock(path):
        mounts = _read_unlocked(path)
        updated = mutate(mounts)
        _write_unlocked(path, updated)
        return updated


def owner_mounts(path: Path, owner: str, legacy_owner: str) -> list[Mount]:
    """현재 소유자의 마운트와 소유자 없는 레거시 항목을 반환한다.

    레거시 항목의 소유권 이관도 같은 잠금 안에서 저장하여 동시 요청의 변경을 잃지 않는다.
    """
    with _file_lock(path):
        mounts = _read_unlocked(path)
        migrated = False
        out: list[Mount] = []
        for mount in mounts:
            mount_owner = mount.get("owner", "")
            if mount_owner == owner:
                out.append(mount)
            elif mount_owner in ("", legacy_owner):
                mount["owner"] = owner
                migrated = True
                out.append(mount)
        if migrated:
            _write_unlocked(path, mounts)
        return out


def upsert(path: Path, *, name: str, location: str, owner: str) -> None:
    def mutate(mounts: list[Mount]) -> list[Mount]:
        kept = [
            mount
            for mount in mounts
            if not (mount["name"] == name and mount.get("owner", "") == owner)
        ]
        kept.append({"name": name, "path": location, "owner": owner})
        return kept

    _update(path, mutate)


def remove(path: Path, *, name: str, owner: str) -> None:
    def mutate(mounts: list[Mount]) -> list[Mount]:
        return [
            mount
            for mount in mounts
            if not (mount["name"] == name and mount.get("owner", "") == owner)
        ]

    _update(path, mutate)
