"""개인 타임라인의 계정 DB 백업: 최신본 CAS와 충돌·복원 직전 원문 보존."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..db import get_connection

__all__ = ["get_edit_backup", "save_edit_backup", "restore_edit_backup"]
MAX_EDIT_BYTES = 1024 * 1024


def _key(doc_key: str) -> None:
    if not isinstance(doc_key, str) or not 1 <= len(doc_key) <= 4096 or "\0" in doc_key:
        raise ValueError("편집 문서 키가 올바르지 않습니다")
    doc_key.encode("utf-8")


def _raw(data: str) -> str:
    if not isinstance(data, str) or len(data.encode("utf-8")) > MAX_EDIT_BYTES:
        raise ValueError("편집 문서는 1 MiB 이하여야 합니다")
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("중복 JSON 필드")
        value[key] = item
    return value


def _invalid_constant(value):
    raise ValueError("유한하지 않은 JSON 수")


def _document(data: str) -> str:
    digest = _raw(data)
    try:
        value = json.loads(data, object_pairs_hook=_object, parse_constant=_invalid_constant)
    except (ValueError, RecursionError) as exc:
        raise ValueError("편집 문서가 유효한 JSON이 아닙니다") from exc
    # v 2 = 속도(speed)를 쓴 편집 문서 · v 3 = 같은 컷을 컷 사이에 한 번 더 놓은 문서(반복 자리, 2026-10-23) — 칸 검사는 프런트 parseEditDoc 이 한다(백업은 원문 보관)
    if not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] not in (1, 2, 3) or not isinstance(value.get("clips"), list):
        raise ValueError("지원하지 않는 편집 문서 형식입니다")
    return digest


def _revision(value: int | None) -> None:
    if value is not None and (type(value) is not int or value < 1):
        raise ValueError("백업 버전이 올바르지 않습니다")


def _head(conn, owner: str, doc_key: str):
    return conn.execute("SELECT revision,data,data_hash,updated_at FROM edit_doc_head WHERE owner=? AND doc_key=?", (owner, doc_key)).fetchone()


def _meta(row, include_data=False) -> dict[str, Any] | None:
    if row is None:
        return None
    result = {key: row[key] for key in row.keys() if key != "data"}
    result["bytes"] = len(row["data"].encode("utf-8"))
    if include_data:
        result["data"] = row["data"]
    return result


def _copy(conn, owner: str, doc_key: str, data: str, digest: str, kind: str) -> None:
    # 같은 원문의 재시도는 기존 복구 사본을 덮거나 보존 시각을 새로 쓰지 않는다.
    conn.execute("INSERT OR IGNORE INTO edit_doc_copy(owner,doc_key,data_hash,data,kind) VALUES(?,?,?,?,?)",
                 (owner, doc_key, digest, data, kind))


def get_edit_backup(owner: str, doc_key: str, *, include_data: bool = False,
                    copy_hash: str | None = None, offset: int = 0, limit: int = 20) -> dict[str, Any]:
    _key(doc_key)
    if not 0 <= offset or not 1 <= limit <= 100:
        raise ValueError("백업 목록 범위가 올바르지 않습니다")
    with get_connection() as conn:
        head = _head(conn, owner, doc_key)
        # 목록에는 원문을 싣지 않는다. 큰 사본이 많아도 한 응답이 전체 문서를 적재하지 않는다.
        copies = conn.execute(
            "SELECT data_hash,kind,created_at,length(CAST(data AS BLOB)) AS bytes FROM edit_doc_copy "
            "WHERE owner=? AND doc_key=? ORDER BY created_at DESC,data_hash DESC LIMIT ? OFFSET ?",
            (owner, doc_key, limit, offset),
        ).fetchall()
        count = conn.execute("SELECT COUNT(*) FROM edit_doc_copy WHERE owner=? AND doc_key=?", (owner, doc_key)).fetchone()[0]
        result = {"head": _meta(head, include_data and not copy_hash), "copies": [dict(row) for row in copies], "total_copies": count}
        if copy_hash is not None:
            row = conn.execute("SELECT data_hash,kind,created_at,data FROM edit_doc_copy WHERE owner=? AND doc_key=? AND data_hash=?",
                               (owner, doc_key, copy_hash)).fetchone()
            if row is None:
                raise LookupError("백업 사본을 찾을 수 없습니다")
            result["copy"] = _meta(row, include_data)
        return result


def save_edit_backup(owner: str, doc_key: str, data: str, base_revision: int | None) -> dict[str, Any]:
    _key(doc_key)
    _revision(base_revision)
    digest = _document(data)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = _head(conn, owner, doc_key)
            if current is not None and current["data"] == data:
                status = "same"
            elif (current is None and base_revision is None) or (current is not None and current["revision"] == base_revision):
                revision = current["revision"] + 1 if current is not None else 1
                conn.execute(
                    "INSERT INTO edit_doc_head(owner,doc_key,revision,data,data_hash) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(owner,doc_key) DO UPDATE SET revision=excluded.revision,data=excluded.data,"
                    "data_hash=excluded.data_hash,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                    (owner, doc_key, revision, data, digest),
                )
                status = "saved"
            else:
                _copy(conn, owner, doc_key, data, digest, "conflict")
                status = "conflict"
            result = {"status": status, "head": _meta(_head(conn, owner, doc_key))}
            if status == "conflict":
                result["copy_hash"] = digest
            conn.execute("COMMIT")
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise


def restore_edit_backup(owner: str, doc_key: str, base_revision: int | None, *,
                        data: str | None = None, copy_hash: str | None = None,
                        local_raw: str | None = None, kind: str = "pre_restore") -> dict[str, Any]:
    _key(doc_key)
    _revision(base_revision)
    if (data is None) == (copy_hash is None) or kind not in ("pre_restore", "pre_adopt"):
        raise ValueError("복원할 원문이나 사본 하나를 선택하세요")
    local_hash = _raw(local_raw) if local_raw is not None else None
    if data is not None:
        _document(data)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            if copy_hash is not None:
                source = conn.execute("SELECT data FROM edit_doc_copy WHERE owner=? AND doc_key=? AND data_hash=?",
                                      (owner, doc_key, copy_hash)).fetchone()
                if source is None:
                    raise LookupError("복원할 백업 사본을 찾을 수 없습니다")
                data = source["data"]
            digest = _document(data)
            current = _head(conn, owner, doc_key)
            same = current is not None and current["data"] == data
            if not same and (current["revision"] if current else None) != base_revision:
                conn.execute("COMMIT")
                return {"status": "conflict", "head": _meta(current)}
            if local_raw is not None and local_raw != data and (current is None or local_raw != current["data"]):
                _copy(conn, owner, doc_key, local_raw, local_hash, "local_preserve")
            if not same:
                if current is not None:
                    _copy(conn, owner, doc_key, current["data"], current["data_hash"], kind)
                revision = current["revision"] + 1 if current is not None else 1
                conn.execute(
                    "INSERT INTO edit_doc_head(owner,doc_key,revision,data,data_hash) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(owner,doc_key) DO UPDATE SET revision=excluded.revision,data=excluded.data,"
                    "data_hash=excluded.data_hash,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                    (owner, doc_key, revision, data, digest),
                )
            result = {"status": "same" if same else "saved", "head": _meta(_head(conn, owner, doc_key)), "data": data}
            conn.execute("COMMIT")
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise
