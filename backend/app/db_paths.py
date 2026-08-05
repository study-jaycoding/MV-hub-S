"""SQLite 파일 위치 결정의 단일 출처.

DB 연결 모듈과 운영 지표가 서로 import하지 않도록 경로 계산만 독립시킨다.
``app.db``는 이 함수와 상수를 다시 노출하므로 기존 호출부는 바뀌지 않는다.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import config


BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = config.DATA_DIR / "db" / "content_hub.db"
LEGACY_DB_PATH = BACKEND_DIR / "content_hub.db"


def get_db_path() -> Path:
    """환경변수, 활성 로컬 계정, 기본 DB 순서로 현재 파일을 결정한다."""
    configured = os.environ.get("CONTENT_HUB_DB")
    if configured:
        return Path(configured).expanduser().resolve()

    from .active_account import account_db_path, account_key

    key = account_key()
    return account_db_path(key) if key else DEFAULT_DB_PATH
