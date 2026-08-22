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
    if exc.reason == "unreadable":
        return "파일을 읽을 수 없습니다(손상되었거나 열 수 없는 파일)"
    return "허브 DB 형식이 아닙니다(generation 테이블 없음)"


def _read_only_uri(path: Path) -> str:
    """검증 대상은 남이 올린 파일이다 — 절대 read-write 로 열지 않는다(hot journal 롤백·WAL
    체크포인트가 원본을 바꾼다). 짝 -wal 이 없는 독립 파일이면 immutable 까지 붙인다: read-only
    연결은 자기가 만든 -wal/-shm 을 닫을 때 지우지 못해 사이드카가 폴더에 쌓인다."""
    immutable = not Path(str(path) + "-wal").exists()
    return path.resolve().as_uri() + ("?mode=ro&immutable=1" if immutable else "?mode=ro")


def validate_hub_db(path: Path, *, require_integrity: bool = False) -> None:
    """MV Hub SQLite DB 인지 확인한다. 라우터는 reason 을 사용자 문구로 바꾼다."""
    try:
        with path.open("rb") as f:
            if f.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
                raise HubDbValidationError("not_sqlite")
    except OSError as exc:
        raise HubDbValidationError("unreadable") from exc

    try:
        with closing(sqlite3.connect(_read_only_uri(path), uri=True)) as conn:
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
