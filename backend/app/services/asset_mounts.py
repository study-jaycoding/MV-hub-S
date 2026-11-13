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
from .path_safety import extended_path, path_comparison_key


Mount = dict[str, str]

_LOCKS_GUARD = threading.Lock()
_FILE_LOCKS: dict[str, threading.RLock] = {}


def mounts_file(account_email: str | None = None) -> Path:
    from .. import active_account, config

    email = active_account.account_key() if account_email is None else account_email
    return (active_account.account_dir(email) if email else config.DATA_DIR) / "asset_mounts.json"


def restore_key(email: str | None = None) -> str:
    from .. import active_account

    email = active_account.account_key() if email is None else email
    return "asset_mount_restore:" + active_account.slug(email or "")


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(os.path.normpath(str(path_comparison_key(Path(value).expanduser()))))


def canonical_path(value: str | Path) -> str:
    return normalized_path(extended_path(Path(value).expanduser()).resolve())


def restore_state(conn, email: str | None = None) -> dict | None:
    row = conn.execute("SELECT value FROM app_setting WHERE key=?", (restore_key(email),)).fetchone()
    if row is None:
        return None
    try:
        state = json.loads(row[0])
        if (not isinstance(state, dict) or not isinstance(state.get("id"), str) or not state["id"]
                or not isinstance(state.get("confirmed"), list)):
            raise ValueError("invalid restore state")
        for pair in state["confirmed"]:
            if (not isinstance(pair, dict) or not isinstance(pair.get("name"), str) or not pair["name"]
                    or not isinstance(pair.get("path"), str) or not Path(pair["path"]).is_absolute()):
                raise ValueError("invalid confirmed path")
        return state
    except (ValueError, TypeError):
        return {"id": "", "confirmed": [], "invalid": True}


def allowed(state: dict | None, name: str, path: str | Path) -> bool:
    return state is None or any(pair["name"] == name and normalized_path(pair["path"]) == normalized_path(path)
                                for pair in state["confirmed"])


def confirm(conn, path: Path, *, name: str, location: str, owner: str,
            restore_id: str | None, register: bool = False, manual: bool = True,
            source_location: str | None = None) -> None:
    """The caller admits/starts the content transaction before taking the file lock."""
    state = restore_state(conn)
    if state is not None:
        if state.get("invalid"):
            raise ValueError("asset_restore_invalid")
        if restore_id != state["id"]:
            raise ValueError("asset_restore_changed")
    elif restore_id or not register:
        raise ValueError("asset_restore_changed")
    with _file_lock(path):
        original = path.read_bytes() if path.exists() else None
        mounts = _read_unlocked(path)
        if not register and manual and not any(m["name"] == name and normalized_path(m["path"]) == normalized_path(source_location or location)
                                               for m in mounts):
            raise ValueError("asset_restore_changed")
        if manual:
            mounts = [m for m in mounts if not (m["name"] == name and ((register and m.get("owner", "") == owner)
                      or (not register and normalized_path(m["path"]) == normalized_path(source_location or location))))]
            mounts.append({"name": name, "path": location, "owner": owner})
        try:
            if manual:
                _write_unlocked(path, mounts)
            if state is not None:
                state["confirmed"] = [p for p in state["confirmed"] if p["name"] != name]
                state["confirmed"].append({"name": name, "path": location})
                conn.execute("UPDATE app_setting SET value=? WHERE key=?", (json.dumps(state, ensure_ascii=False), restore_key()))
            conn.commit()
        except BaseException:
            conn.rollback()
            if manual:
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_write_text(path, original.decode("latin-1"), encoding="latin-1")
            raise


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


def owner_mounts(path: Path, owner: str, legacy_owner: str, *, restored: bool = False) -> list[Mount]:
    """현재 소유자의 마운트와 소유자 없는 레거시 항목을 반환한다.

    레거시 항목의 소유권 이관도 같은 잠금 안에서 저장하여 동시 요청의 변경을 잃지 않는다.
    """
    with _file_lock(path):
        mounts = _read_unlocked(path)
        if restored:
            return mounts
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


def remove(path: Path, *, name: str, owner: str, conn=None,
           location: str | None = None, restore_id: str | None = None) -> None:
    state = restore_state(conn) if conn is not None else None
    if state is not None:
        if (state.get("invalid") or not location or restore_id != state["id"]
                or not allowed(state, name, location)):
            raise ValueError("asset_restore_changed")
    elif location is not None or restore_id is not None:
        raise ValueError("asset_restore_changed")

    def mutate(mounts: list[Mount]) -> list[Mount]:
        return [
            mount
            for mount in mounts
            if not (mount["name"] == name and (normalized_path(mount["path"]) == normalized_path(location)
                    if state is not None else mount.get("owner", "") == owner))
        ]

    if conn is None:
        _update(path, mutate)
        return
    with _file_lock(path):
        original = path.read_bytes() if path.exists() else None
        try:
            _write_unlocked(path, mutate(_read_unlocked(path)))
            if state is not None:
                state["confirmed"] = [p for p in state["confirmed"] if not (p["name"] == name
                                      and normalized_path(p["path"]) == normalized_path(location))]
                conn.execute("UPDATE app_setting SET value=? WHERE key=?", (json.dumps(state, ensure_ascii=False), restore_key()))
            conn.commit()
        except BaseException:
            conn.rollback()
            if original is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write_text(path, original.decode("latin-1"), encoding="latin-1")
            raise
