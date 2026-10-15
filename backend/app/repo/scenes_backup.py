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
from typing import Any, Optional

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


def _fork_copy(sid: str, parsed: dict[str, Any], incoming_hash: str, salt: str = "") -> tuple[str, str]:
    """옛 창의 내용을 덮지 않고 남길 사본 — (target_id, data). id 는 원본 id·들어온 지문(·고쳐진 기존 사본 지문)에서 고정 길이로
    정한다(같은 입력을 다시 보내도 같은 사본으로 모이고, 갈래의 갈래도 길이가 늘지 않는다). 카드의 진행 중 생성 표식은 뺀다 —
    새 id 에서는 생성 복구가 씬 id 불일치로 결과를 카드에서 지운다(canvasGenerationRecovery). 결과 id(genIds)는 남긴다."""
    target = "bk_" + hashlib.sha256(f"{sid}|{incoming_hash}|{salt}".encode("utf-8")).hexdigest()[:24]
    copy = dict(parsed)
    copy["id"] = target
    copy["name"] = f"{parsed.get('name') or '씬'} (옛 창 사본)"
    copy["backupForkOf"] = {"id": sid, "sum": incoming_hash}
    copy["cards"] = [
        {k: v for k, v in card.items() if k != "pendingGenerationAttempts"} if isinstance(card, dict) else card
        for card in (parsed.get("cards") or [])
    ]
    return target, json.dumps(copy, ensure_ascii=False, separators=(",", ":"))


def _row_hash(conn, owner_uid: str, project_id: str, scene_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT data_hash FROM scene_backup WHERE owner_uid=? AND project_id=? AND scene_id=?",
        (owner_uid, project_id, scene_id),
    ).fetchone()
    return row["data_hash"] if row else None


def _upsert_row(conn, owner_uid: str, project_id: str, scene_id: str, name: str, data: str) -> None:
    conn.execute(
        "INSERT INTO scene_backup"
        "(owner_uid, project_id, scene_id, name, data, data_hash, updated_at) "
        "VALUES(?,?,?,?,?,?,datetime('now')) "
        "ON CONFLICT(owner_uid, project_id, scene_id) DO UPDATE SET "
        "name=excluded.name, data=excluded.data, data_hash=excluded.data_hash, "
        "updated_at=excluded.updated_at",
        (owner_uid, project_id, scene_id, name, data, _hash(data)),
    )


def sync_scene_backups(
    owner_uid: str,
    project_id: str,
    upserts: list[dict[str, Any]],
    deleted_ids: list[str],
    delete_bases: Optional[dict[str, str]] = None,
    fork_avoid: Optional[list[str]] = None,
) -> dict[str, Any]:
    """변경분 upsert + 삭제 미러를 한 트랜잭션으로. 검증 실패는 ValueError(라우터가 400 변환).
    data 는 JSON 원문 그대로 보관하되 파싱·id 일치·크기만 검증(이중 데이터 불일치 방지).

    판(Jay 결정 1A, 10-15) — upsert 의 `base_hash` 는 '이 창이 마지막으로 서버와 맞춘 지문'(""=모름). 칸이 없으면(옛 앱) 지금처럼 덮는다.
    행 지문이 그 판과 다르면(그사이 다른 창이 올렸다) 덮지 않고 **사본 행**으로 남긴다. `delete_bases` 를 주면 행 지문이 그 판과 같을 때만
    지운다(옛 창이 다른 창의 새 내용을 지우지 않게 — 칸에 없는 id 는 판 "" 로 본다). 결과는 씬마다 `results: [{id, status, target_id, hash}]`(saved|same|copied|too_big),
    지우지 않고 남긴 것은 `kept`. `fork_avoid` = 사본 자리로 쓰지 않을 id(그 브라우저에서 이미 별도 씬이 된 사본 행 — 두 씬이 한 행을 쓰지 않게)."""
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
    results: list[dict[str, Any]] = []
    kept: list[str] = []
    avoid = {str(a) for a in (fork_avoid or [])}
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
                incoming = _hash(data)
                base = u.get("base_hash")
                current = _row_hash(conn, owner_uid, project_id, sid)
                if current == incoming:
                    results.append({"id": sid, "status": "same", "target_id": sid, "hash": incoming})
                    continue
                if current is None or base is None or current == base:
                    # name 은 JSON(data.name) 우선 — body.name 과 갈릴 때 이중 데이터 불일치 방지(코덱스 P2)
                    _upsert_row(conn, owner_uid, project_id, sid, str(parsed.get("name") or u.get("name") or ""), data)
                    saved += 1
                    results.append({"id": sid, "status": "saved", "target_id": sid, "hash": incoming})
                    continue
                # 그사이 다른 창이 올렸다 — 덮지 않고 사본으로. 같은 입력의 사본이 이미 있고 그대로면 그것, 그 뒤 고쳐졌으면 새 사본(Codex E3).
                salt = ""
                for _ in range(8):
                    target, copy_data = _fork_copy(sid, parsed, incoming, salt)
                    existing = _row_hash(conn, owner_uid, project_id, target)
                    if target not in avoid and (existing is None or existing == _hash(copy_data)):
                        break
                    salt = existing or target  # 고쳐진 사본·피할 자리 — 그 값을 섞어 다음 자리로(같은 입력이면 같은 자리)
                else:
                    raise ValueError(f"사본 자리를 정하지 못함: {sid}")
                if len(copy_data.encode("utf-8")) > MAX_SCENE_BYTES:
                    results.append({"id": sid, "status": "too_big", "target_id": target, "hash": None})
                    continue
                if existing is None:
                    _upsert_row(conn, owner_uid, project_id, target, json.loads(copy_data)["name"], copy_data)
                    saved += 1
                results.append({"id": sid, "status": "copied", "target_id": target, "hash": _hash(copy_data)})
            for sid in [str(d) for d in deleted_ids]:
                # 판 칸을 보낸 새 앱 — 칸에 없는 id 는 '모름'("")이라 남긴다(Codex 1A 리뷰 #2). 칸이 없으면(옛 앱) 지금처럼 지운다.
                if delete_bases is not None and _row_hash(conn, owner_uid, project_id, sid) not in (None, delete_bases.get(sid, "")):
                    kept.append(sid)  # 그사이 다른 창이 올린 새 내용 — 지우지 않는다
                    continue
                deleted += conn.execute(
                    "DELETE FROM scene_backup WHERE owner_uid=? AND project_id=? AND scene_id=?",
                    (owner_uid, project_id, sid),
                ).rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {"saved": saved, "deleted": deleted, "results": results, "kept": kept}
