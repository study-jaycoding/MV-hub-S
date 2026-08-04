"""캔버스 씬 백업 — 브라우저 localStorage(원본)의 DB 미러. 캐시 소실 시 복구용.

원칙(코덱스 합의 설계):
  · 로컬(브라우저)이 항상 정답 — 이 테이블은 단방향 미러(로컬→DB).
  · 복구는 프론트가 '로컬 버킷 키 자체가 없을 때'만 수행(빈 배열 버킷은 정상 삭제 결과 = 복구 금지).
  · owner_uid 스코프(개인 편집물, asset_meta 패턴) — identity._REMAP_PLAN 이 계정 전환 시 리맵.
  · 삭제는 실제 삭제(미러) — 휴지통·보존기간은 별도 기능(보류).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..db import get_connection

__all__ = [
    "MAX_SCENE_BYTES",
    "MAX_SCENE_UPSERTS",
    "MAX_SCENE_DELETES",
    "MAX_SYNC_TOTAL_BYTES",
    "list_scene_backups",
    "sync_scene_backups",
]

MAX_SCENE_BYTES = 5 * 1024 * 1024  # 씬 1개 상한 — 씬 import 상한과 동일(5MB)
MAX_SCENE_UPSERTS = 200  # 한 요청 upsert 개수 상한 — 초과분은 클라가 분할 전송
MAX_SCENE_DELETES = 500  # 한 요청 삭제 개수 상한 — SQLite 바인딩 한도·폭주 방지(클라 분할)
MAX_SYNC_TOTAL_BYTES = 20 * 1024 * 1024  # 한 요청 data 총량 상한 — 개수 상한만으론 1GB 도 가능해서


def _hash(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def list_scene_backups(
    owner_uid: str, project_id: str = "", include_data: bool = False
) -> list[dict[str, Any]]:
    """내 백업 목록. 기본은 메타만(id/name/updated_at/data_hash) — 클라가 변경분 대조에 쓴다.
    include_data=True 는 복구용 전체 응답(메타 후 N번 GET 대신 한 번에 — 부분 복구 방지)."""
    cols = "scene_id, name, updated_at, data_hash" + (", data" if include_data else "")
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {cols} FROM scene_backup WHERE owner_uid=? AND project_id=? "
            f"ORDER BY updated_at DESC",
            (owner_uid, project_id),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d: dict[str, Any] = {
            "id": r["scene_id"],
            "name": r["name"],
            "updated_at": r["updated_at"],
            "data_hash": r["data_hash"],
        }
        if include_data:
            d["data"] = r["data"]
        out.append(d)
    return out


def sync_scene_backups(
    owner_uid: str,
    project_id: str,
    upserts: list[dict[str, Any]],
    deleted_ids: list[str],
) -> dict[str, int]:
    """변경분 upsert + 삭제 미러를 한 트랜잭션으로. 검증 실패는 ValueError(라우터가 400 변환).
    data 는 JSON 원문 그대로 보관하되 파싱·id 일치·크기만 검증(이중 데이터 불일치 방지)."""
    if len(upserts) > MAX_SCENE_UPSERTS:
        raise ValueError(f"upserts 가 너무 많음(최대 {MAX_SCENE_UPSERTS}) — 분할 전송 필요")
    if len(deleted_ids) > MAX_SCENE_DELETES:
        raise ValueError(f"deleted_ids 가 너무 많음(최대 {MAX_SCENE_DELETES}) — 분할 전송 필요")
    total = sum(len(str(u.get("data") or "").encode("utf-8")) for u in upserts)
    if total > MAX_SYNC_TOTAL_BYTES:
        raise ValueError("요청 data 총량 초과(20MB) — 분할 전송 필요")
    up_ids = [str(u.get("id") or "") for u in upserts]
    if "" in up_ids or len(set(up_ids)) != len(up_ids):
        raise ValueError("upserts 에 id 누락 또는 중복")
    if set(up_ids) & {str(d) for d in deleted_ids}:
        raise ValueError("같은 씬이 upsert 와 delete 에 동시에 있음")
    saved = 0
    deleted = 0
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for u in upserts:
                sid = str(u["id"])
                data = u.get("data")
                if not isinstance(data, str) or not data:
                    raise ValueError(f"data 누락: {sid}")
                if len(data.encode("utf-8")) > MAX_SCENE_BYTES:
                    raise ValueError(f"씬이 너무 큼(5MB 초과): {sid}")
                try:
                    parsed = json.loads(data)
                except Exception:
                    raise ValueError(f"data 가 JSON 이 아님: {sid}")
                if not isinstance(parsed, dict) or str(parsed.get("id")) != sid:
                    raise ValueError(f"data.id 불일치: {sid}")
                conn.execute(
                    "INSERT INTO scene_backup"
                    "(owner_uid, project_id, scene_id, name, data, data_hash, updated_at) "
                    "VALUES(?,?,?,?,?,?,datetime('now')) "
                    "ON CONFLICT(owner_uid, project_id, scene_id) DO UPDATE SET "
                    "name=excluded.name, data=excluded.data, data_hash=excluded.data_hash, "
                    "updated_at=excluded.updated_at",
                    (
                        owner_uid,
                        project_id,
                        sid,
                        # name 은 JSON(data.name) 우선 — body.name 과 갈릴 때 이중 데이터 불일치 방지(코덱스 P2)
                        str(parsed.get("name") or u.get("name") or ""),
                        data,
                        _hash(data),
                    ),
                )
                saved += 1
            if deleted_ids:
                ph = ",".join("?" * len(deleted_ids))
                deleted = conn.execute(
                    f"DELETE FROM scene_backup "
                    f"WHERE owner_uid=? AND project_id=? AND scene_id IN ({ph})",
                    [owner_uid, project_id, *[str(d) for d in deleted_ids]],
                ).rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {"saved": saved, "deleted": deleted}
