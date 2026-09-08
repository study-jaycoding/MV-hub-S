"""마지막으로 크게 열어본 생성물 — 사용자별 개인 표시("Last viewed" 배지의 원천).

계약:
  · 기록 시점은 **미리보기(크게보기)에 그 항목이 실제로 표시된 순간**뿐이다. 카드 선택·호버·
    썸네일 자동재생은 기록하지 않는다(프론트 MediaPreview 한 곳에서만 호출한다 — 진입점이
    10군데라 호출부마다 달면 반드시 샌다).
  · 묶음 = 캔버스 카드 하나. 키는 (scene_id, card_id) 두 개가 **함께**여야 유일하다 —
    importScene 이 씬 id 만 새로 만들고 카드는 그대로 가져오므로 같은 씬을 두 번 들이면
    다른 씬에 같은 card_id 가 생긴다.
  · 캔버스 밖(생성물 목록·히스토리) 열람은 scene_id=''·card_id='' 한 행에 모으고,
    **캔버스 배지를 움직이지 않는다**(사용자 확정 — "캔버스는 캔버스대로").
  · 최신 판정은 viewed_seq 로 한다. viewed_at 으로 정렬하지 않는다 — 같은 초에 두 번 열거나
    시스템 시계가 뒤로 가면 순서가 모호해진다. viewed_at 은 사람이 읽는 용도.
  · generation FK 를 걸지 않는다. 휴지통은 메인 행을 실제로 지웠다가 복원 때 재삽입하므로
    (repo/trash.py restore_from_trash) CASCADE 면 휴지통에 넣는 순간 표시가 죽고 복원해도
    안 돌아온다. 대신 **읽을 때** generation 실재를 확인해, 휴지통에 있는 동안만 감춘다.
  · owner_uid = deps.actor_id(행위자 신원). deps.account_scope_uid 는 쿼리 스코프 전용이라
    쓰지 않는다 — 미링크 계정에서 '\\x00' 이 저장돼 본인 것에도 안 맞게 된다.
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection

__all__ = [
    "record_generation_view",
    "list_generation_views",
]


def record_generation_view(
    owner_uid: str,
    generation_id: str,
    *,
    scene_id: str = "",
    card_id: str = "",
) -> Optional[dict[str, Any]]:
    """열람을 기록한다. 생성물이 이 DB 에 없으면 기록하지 않고 None 을 반환한다.

    팀 탭에서 본 남의 생성물은 로컬에 행이 없다(사용자 확정: 팀 항목은 기록하지 않는다).
    저장한 척하고 조회에서 조용히 버리면 화면과 DB 가 어긋나므로 여기서 분명히 거절한다.
    """
    scene_id = scene_id or ""
    card_id = card_id or ""
    # 캔버스 문맥은 둘 다 있거나 둘 다 없어야 한다 — 한쪽만 오면 다른 씬의 같은 카드와 섞인다.
    if bool(scene_id) != bool(card_id):
        raise ValueError("scene_id 와 card_id 는 함께 주거나 함께 비워야 합니다")
    with get_connection() as conn:
        # seq 채번과 UPSERT 를 한 트랜잭션에 묶는다 — 두 창이 동시에 열면 같은 seq 가 나온다.
        conn.execute("BEGIN IMMEDIATE")
        exists = conn.execute(
            "SELECT 1 FROM generation WHERE id=?", (generation_id,)
        ).fetchone()
        if not exists:
            return None
        row = conn.execute(
            "SELECT IFNULL(MAX(viewed_seq), 0) AS seq FROM generation_view WHERE owner_uid=?",
            (owner_uid,),
        ).fetchone()
        seq = int(row["seq"]) + 1
        conn.execute(
            "INSERT INTO generation_view"
            " (owner_uid, scene_id, card_id, generation_id, viewed_seq, viewed_at)"
            " VALUES (?,?,?,?,?, datetime('now'))"
            " ON CONFLICT(owner_uid, scene_id, card_id) DO UPDATE SET"
            "   generation_id=excluded.generation_id,"
            "   viewed_seq=excluded.viewed_seq,"
            "   viewed_at=excluded.viewed_at",
            (owner_uid, scene_id, card_id, generation_id, seq),
        )
    return {
        "scene_id": scene_id,
        "card_id": card_id,
        "generation_id": generation_id,
        "viewed_seq": seq,
    }


def list_generation_views(owner_uid: str, *, scene_id: Optional[str] = None) -> dict[str, Any]:
    """배지를 그리는 데 필요한 것만 돌려준다.

    · card: {card_id: generation_id} — 그 씬의 묶음별 마지막(팝업 배지)
    · last_card_id: 그 씬에서 마지막으로 본 카드 하나(캔버스 배지). 없으면 None.

    scene_id 를 주지 않으면 캔버스 밖 행('')만 본다. 휴지통에 간 생성물은 제외한다 —
    행은 남겨 두므로 복원하면 배지가 저절로 돌아온다.
    """
    key = scene_id or ""
    sql = (
        "SELECT v.scene_id, v.card_id, v.generation_id, v.viewed_seq "
        "FROM generation_view v "
        "JOIN generation g ON g.id = v.generation_id "
        "WHERE v.owner_uid=? AND v.scene_id=? "
        "ORDER BY v.viewed_seq DESC"
    )
    with get_connection() as conn:
        rows = conn.execute(sql, (owner_uid, key)).fetchall()
    # (owner, scene) 을 고정한 조회라 PK 상 같은 card_id 는 한 행뿐이다.
    by_card = {str(r["card_id"]): str(r["generation_id"]) for r in rows}
    # 첫 행이 seq 최대 — 그 씬에서 마지막으로 본 카드다(캔버스 밖 조회면 card_id 가 '').
    last_card_id = str(rows[0]["card_id"]) if rows else None
    return {
        "scene_id": key,
        "card": by_card,
        "last_card_id": last_card_id or None,
    }
