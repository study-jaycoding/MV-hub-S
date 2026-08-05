"""generation 레퍼런스 행 upsert/link 공용 쓰기 헬퍼."""

from __future__ import annotations

import sqlite3
from typing import Optional

from ._common import new_id


def _upsert_reference(
    conn: sqlite3.Connection,
    *,
    ref_id: Optional[str],
    type_: str,
    file_path: str,
    source: str,
    thumbnail_path: Optional[str] = None,
    source_url: Optional[str] = None,
) -> str:
    rid = ref_id or new_id()
    conn.execute(
        "INSERT INTO reference(id, type, file_path, thumbnail_path, source, source_url) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, "
        "type=excluded.type, source_url=COALESCE(reference.source_url, excluded.source_url)",
        (rid, type_, file_path, thumbnail_path, source, source_url),
    )
    return rid


def _link_reference(
    conn: sqlite3.Connection, gen_id: str, ref_id: str, role: Optional[str]
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO gen_reference(generation_id, reference_id, role) "
        "VALUES(?,?,?)",
        (gen_id, ref_id, role or ""),
    )
