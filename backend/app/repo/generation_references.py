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
    content_sha: Optional[str] = None,
    content_bytes: Optional[int] = None,
    registry_asset_id: Optional[str] = None,
    version_verified: Optional[int] = None,
) -> str:
    rid = ref_id or new_id()
    content_id = (
        "sha256:" + content_sha
        if content_sha and len(content_sha) == 64
        and all(ch in "0123456789abcdef" for ch in content_sha)
        and content_bytes is not None and content_bytes > 0 else None
    )
    conn.execute(
        "INSERT INTO reference(id, type, file_path, thumbnail_path, source, source_url, "
        "content_sha, content_bytes, registry_asset_id, version_verified, asset_content_id) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, "
        "type=excluded.type, source_url=COALESCE(reference.source_url, excluded.source_url), "
        "content_sha=COALESCE(reference.content_sha, excluded.content_sha), "
        "content_bytes=COALESCE(reference.content_bytes, excluded.content_bytes), "
        "registry_asset_id=COALESCE(reference.registry_asset_id, excluded.registry_asset_id), "
        "version_verified=COALESCE(reference.version_verified, excluded.version_verified), "
        "asset_content_id=COALESCE(reference.asset_content_id, excluded.asset_content_id)",
        (
            rid, type_, file_path, thumbnail_path, source, source_url,
            content_sha, content_bytes, registry_asset_id, version_verified, content_id,
        ),
    )
    return rid


def _link_reference(
    conn: sqlite3.Connection, gen_id: str, ref_id: str, role: Optional[str], position: Optional[int] = None
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO gen_reference(generation_id, reference_id, role, position) "
        "VALUES(?,?,?,?)",
        (gen_id, ref_id, role or "", position),
    )


def _reference_copy_positions(refs: list[sqlite3.Row]) -> list[Optional[int]]:
    """혼합 목록의 NULL만 원본 rowid로 고정해 복제 뒤에도 순서를 보존한다."""
    has_position = any(ref["position"] is not None for ref in refs)
    return [
        ref["source_rowid"] if has_position and ref["position"] is None else ref["position"]
        for ref in refs
    ]
