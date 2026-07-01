from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

SQLITE_MAGIC = b"SQLite format 3"


class HubDbValidationError(ValueError):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def hub_db_validation_detail(exc: HubDbValidationError, *, downloaded: bool = False) -> str:
    if exc.reason == "not_sqlite":
        return "받은 파일이 SQLite DB 가 아닙니다" if downloaded else "SQLite DB 파일이 아닙니다"
    if exc.reason == "integrity":
        return "받은 백업이 손상되었습니다(무결성 검사 실패)"
    return "허브 DB 형식이 아닙니다(generation 테이블 없음)"


def validate_hub_db(path: Path, *, require_integrity: bool = False) -> None:
    """MV Hub SQLite DB 인지 확인한다. 라우터는 reason 을 사용자 문구로 바꾼다."""
    try:
        with path.open("rb") as f:
            if f.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
                raise HubDbValidationError("not_sqlite")
    except OSError as exc:
        raise HubDbValidationError("unreadable") from exc

    try:
        with closing(sqlite3.connect(str(path))) as conn:
            ok = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation'"
            ).fetchone()
            if not ok:
                raise HubDbValidationError("missing_generation")
            if require_integrity:
                integrity = conn.execute("PRAGMA quick_check").fetchone()
                if not integrity or integrity[0] != "ok":
                    raise HubDbValidationError("integrity")
    except HubDbValidationError:
        raise
    except sqlite3.DatabaseError as exc:
        raise HubDbValidationError("unreadable") from exc
