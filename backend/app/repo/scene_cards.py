"""캔버스 생성카드 소속 — "이 카드에 이 생성물이 담겨 있다"는 사실 저장.

씬 백업(scene_backup)은 씬 전체를 통째로 덮어쓰는 미러라, 늦게 저장한 브라우저가 이겨
다른 브라우저에서 쌓은 결과가 사라진다. 소속만 여기로 분리해 **더하기 전용**으로 쌓는다.

계약:
  · 추가는 upsert(멱등) — 같은 (씬,카드,생성물)을 몇 번 보내도 한 줄. 백필을 반복해도 안전.
  · 제거는 행 삭제가 아니라 removed_at 표시 — 행을 지우면 아직 모르는 다른 브라우저가
    자기 로컬 목록으로 그 생성물을 되살린다(합치기가 합집합이므로).
  · 다시 담으면 removed_at=NULL 로 되돌린다(뺐다가 도로 넣는 건 정상 조작).
  · 읽기는 휴지통에 간 생성물만 제외. 이 DB 에 아직 없는 생성물은 남긴다 — 다른 설치본에서
    만들어 아직 동기화 안 된 경우라, 지우면 동기화 뒤에도 카드에 못 돌아온다(0단계 실측:
    카드가 가리키는 57건 중 54건이 다른 설치본 DB 에 있었다).
  · owner_uid = deps.actor_id. 개인 편집물이라 팀 서버로 보내지 않는다(_proxy 로컬 처리).
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection

__all__ = [
    "MAX_SCENE_CARD_LINKS",
    "list_scene_card_links",
    "sync_scene_card_links",
]

MAX_SCENE_CARD_LINKS = 2000  # 한 요청 상한(추가+제거 합산) — 백필 최대치의 여유분. 초과는 클라가 분할


def _clean(items: list[dict[str, Any]]) -> list[tuple[str, str, str]]:
    """(scene_id, card_id, generation_id) 3종이 다 있는 것만 남기고 중복 제거(순서 보존)."""
    out: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items:
        key = (
            str(item.get("scene_id") or ""),
            str(item.get("card_id") or ""),
            str(item.get("generation_id") or ""),
        )
        if "" in key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def list_scene_card_links(
    owner_uid: str, scene_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """내 카드 소속. scene_id 를 주면 그 씬만(씬 열 때), 없으면 전부(백필 대조용).

    휴지통에 간 생성물은 제외한다 — 안 그러면 합치기에서 버린 생성물이 카드에 되살아난다.
    generation 행이 아예 없는 건 남긴다(다른 설치본에서 만든 것일 수 있어 지우면 영영 못 찾음).
    """
    sql = (
        "SELECT s.scene_id, s.card_id, s.generation_id, s.removed_at "
        "FROM scene_card_generation s "
        "LEFT JOIN generation g ON g.id = s.generation_id "
        "WHERE s.owner_uid=? AND g.deleted_at IS NULL"
    )
    args: list[Any] = [owner_uid]
    if scene_id:
        sql += " AND s.scene_id=?"
        args.append(scene_id)
    sql += " ORDER BY s.created_at, s.rowid"
    with get_connection() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [
        {
            "scene_id": r["scene_id"],
            "card_id": r["card_id"],
            "generation_id": r["generation_id"],
            "removed_at": r["removed_at"],
        }
        for r in rows
    ]


def sync_scene_card_links(
    owner_uid: str,
    added: list[dict[str, Any]],
    removed: list[dict[str, Any]],
) -> dict[str, int]:
    """담김/뺌을 한 트랜잭션으로 반영. 검증 실패는 ValueError(라우터가 400 변환)."""
    add = _clean(added)
    rem = _clean(removed)
    if len(add) + len(rem) > MAX_SCENE_CARD_LINKS:
        raise ValueError(f"한 요청 상한 초과(최대 {MAX_SCENE_CARD_LINKS}) — 분할 전송 필요")
    both = set(add) & set(rem)
    if both:
        raise ValueError("같은 (씬,카드,생성물)이 added 와 removed 에 동시에 있음")

    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for scene_id, card_id, generation_id in add:
                # 다시 담는 경우 removed_at 을 지운다 — 뺐다가 도로 넣는 건 정상 조작.
                conn.execute(
                    "INSERT INTO scene_card_generation"
                    "(owner_uid, scene_id, card_id, generation_id) VALUES(?,?,?,?) "
                    "ON CONFLICT(owner_uid, scene_id, card_id, generation_id) "
                    "DO UPDATE SET removed_at=NULL",
                    (owner_uid, scene_id, card_id, generation_id),
                )
            for scene_id, card_id, generation_id in rem:
                # 없던 행이어도 '뺐다'를 남긴다 — 다른 브라우저가 자기 로컬 목록으로 되살리는 걸 막는다.
                conn.execute(
                    "INSERT INTO scene_card_generation"
                    "(owner_uid, scene_id, card_id, generation_id, removed_at) "
                    "VALUES(?,?,?,?,datetime('now')) "
                    "ON CONFLICT(owner_uid, scene_id, card_id, generation_id) "
                    "DO UPDATE SET removed_at=datetime('now')",
                    (owner_uid, scene_id, card_id, generation_id),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return {"added": len(add), "removed": len(rem)}
