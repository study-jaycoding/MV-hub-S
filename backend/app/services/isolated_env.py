"""Build a disposable smoke environment before importing or starting the app."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Mapping


_PATH_KEYS = {
    "CONTENT_HUB_DATA": "data",
    "CONTENT_HUB_DB": "data/db/content_hub.db",
    "CONTENT_HUB_MEDIA": "data/media",
    "CONTENT_HUB_SHARED": "data/shared",
    "CONTENT_HUB_ASSETS_DIR": "data/assets",
    "CONTENT_HUB_BACKUP_DIR": "data/backups",
    "CONTENT_HUB_SERVER_ALERT_PATH": "logs/server_ALERT.txt",
}
_PROFILE_KEYS = ("TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA")


def _local_path(path: Path) -> Path:
    path = Path(path)
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        raise ValueError("smoke paths must be absolute local paths")
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("smoke paths must not traverse symlinks or reparse points")
    return path.resolve()


def validate_smoke_paths(
    work_root: Path,
    paths: Mapping[str, str],
    *,
    allowed_frontend_root: Path,
) -> None:
    root = _local_path(work_root)
    frontend = _local_path(allowed_frontend_root)
    optional_paths = ("CONTENT_HUB_LOG_DIR",) if "CONTENT_HUB_LOG_DIR" in paths else ()
    for key in (*_PATH_KEYS, *_PROFILE_KEYS, "CONTENT_HUB_FRONTEND_DIST", *optional_paths):
        target = _local_path(Path(paths[key]))
        allowed = frontend if key == "CONTENT_HUB_FRONTEND_DIST" else root
        if key == "CONTENT_HUB_FRONTEND_DIST":
            valid = target == allowed
        elif key == "CONTENT_HUB_DATA":
            # Restored sets already use work_root/db, not work_root/data/db.
            valid = target == allowed or target.is_relative_to(allowed)
        else:
            valid = target != allowed and target.is_relative_to(allowed)
        if not valid:
            raise ValueError(f"smoke path outside its allowed root: {key}")


def build_smoke_env(
    parent_env: Mapping[str, str],
    work_root: Path,
    *,
    frontend_dist: Path,
    python_exe: Path,
    port: int,
) -> dict[str, str]:
    """Keep only OS essentials; never inherit product paths or runtime injection."""
    root = _local_path(work_root)
    frontend = _local_path(frontend_dist)
    python = _local_path(python_exe)
    if not 0 < port < 65536:
        raise ValueError("invalid smoke port")
    parent = {key.upper(): value for key, value in parent_env.items()}
    env = {
        key: parent[key]
        for key in ("SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE")
        if key in parent
    }
    system_root = Path(parent.get("SYSTEMROOT", r"C:\Windows"))
    env.update({key: str(root / relative) for key, relative in _PATH_KEYS.items()})
    env.update(
        {
            "CONTENT_HUB_FRONTEND_DIST": str(frontend),
            "CONTENT_HUB_HOST": "127.0.0.1",
            "CONTENT_HUB_PORT": str(port),
            "CONTENT_HUB_AUTH": "0",
            "CONTENT_HUB_MANAGE": "0",
            "CONTENT_HUB_NO_PROXY": "1",
            "CONTENT_HUB_READ_ONLY": "1",
            "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
            "CONTENT_HUB_SERVER_SYNC": "0",
            "CONTENT_HUB_TASK": "1",
            "CONTENT_HUB_RESTART_LIMIT": "1",
            "HOST": "127.0.0.1",
            "PORT": str(port),
            "PYEXE": str(python),
            "PATH": os.pathsep.join(
                (str(system_root / "System32"), str(system_root), str(python.parent))
            ),
            "PYTHONNOUSERSITE": "1",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
            "TEMP": str(root / "temp"),
            "TMP": str(root / "temp"),
            "USERPROFILE": str(root / "profile"),
            "HOME": str(root / "profile"),
            "APPDATA": str(root / "profile" / "AppData" / "Roaming"),
            "LOCALAPPDATA": str(root / "profile" / "AppData" / "Local"),
        }
    )
    validate_smoke_paths(root, env, allowed_frontend_root=frontend)
    # tempfile and third-party home discovery must not fall back to the user's profile.
    for key in ("TEMP", "HOME", "APPDATA", "LOCALAPPDATA"):
        Path(env[key]).mkdir(parents=True, exist_ok=True)
    return env
