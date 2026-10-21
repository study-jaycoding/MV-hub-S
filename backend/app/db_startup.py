"""Prepare existing databases at startup above their individual initializers."""
from __future__ import annotations

import logging
from pathlib import Path

from . import db, schema_compat
from .manage_db import init_manage_db
from .repo.trash import init_trash_db


def init_existing_databases(root: Path, env: dict[str, str], *, active_path: Path | None = None) -> None:
    """설치 검사가 볼 비활성 DB도 기존 초기화로 준비하되 실패는 해당 DB에 한정한다."""
    log = logging.getLogger(db.__name__)
    try:
        paths = schema_compat.database_paths(root, env)
    except Exception as exc:
        log.warning("database_discovery_failed: %s", type(exc).__name__)
        return
    initializers = {"content": db.init_db, "trash": init_trash_db, "manage": init_manage_db}
    for kind, path in paths:
        if active_path is not None and path == active_path.resolve():
            continue
        try:
            initializers[kind](path)
        except Exception as exc:
            log.warning("database_prepare_failed: kind=%s key=%s error=%s",
                        kind, schema_compat.database_key(path), type(exc).__name__)
