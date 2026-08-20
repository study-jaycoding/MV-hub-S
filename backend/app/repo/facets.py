"""필터 사이드바 facet — 컬러/일반태그/자동태그/워커.

generations.py 에서 분리(관심사 분리). 라이브러리 조회 응답 형태는 그대로 유지한다.
"""
from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from .identity import get_my_uid


def get_facets(account_uid: Optional[str] = None) -> dict[str, Any]:
    """필터 사이드바 facet — 컬러/일반태그/자동태그. account_uid 가 있으면 '내 생성물에 쓰인 것'만
    돌려준다(개인 설정 — 다른 사람의 컬러/태그가 사이드바에 새지 않게). 없으면(AUTH off/단독) 전체."""
    gen_filter = " AND g.creator_uid = ?" if account_uid else ""
    active_project_filter = (
        " AND NOT EXISTS(SELECT 1 FROM project p "
        "WHERE p.id=g.project_id AND p.archived=1)"
    )
    gen_args: list[Any] = [account_uid] if account_uid else []
    with get_connection() as conn:
        colors = [
            r["color"]
            for r in conn.execute(
                "SELECT DISTINCT g.color FROM generation g "
                "WHERE g.color IS NOT NULL AND g.color <> '' AND g.deleted_at IS NULL"
                f"{active_project_filter}{gen_filter} ORDER BY g.color",
                gen_args,
            ).fetchall()
        ]
        tags_list = [
            r["name"]
            for r in conn.execute(
                "SELECT DISTINCT t.name FROM tag t "
                "JOIN gen_tag gt ON gt.tag_id = t.id "
                "JOIN generation g ON g.id = gt.generation_id "
                f"WHERE g.deleted_at IS NULL{active_project_filter}{gen_filter} ORDER BY t.name",
                gen_args,
            ).fetchall()
        ]
        # 내가 남의 팀 카드에 단 shadow 태그도 같은 레지스트리로 합친다 — 내작업·팀·캔버스 태그 목록 통합
        # (안 그러면 팀 카드에만 단 태그가 내작업 탭 '등록된 태그'에 안 보여 따로 노는 것처럼 됨).
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_tag_overlay'"
        ).fetchone():
            overlay = [r["tag"] for r in conn.execute("SELECT DISTINCT tag FROM gen_tag_overlay").fetchall()]
            if overlay:
                tags_list = sorted(set(tags_list) | set(overlay))
        # 전역 태그(auto_tag)는 별도 테이블 — 일반 tags 와 완전 분리(누출 없음). 계정별 소유라
        # **그 계정이 만든 것 전부**를 돌려준다(쓰인 것만이 아니라 — 방금 +로 만든 태그도 즉시 보여
        # 무장·삭제할 수 있게). owner: 로그인 계정 uid, 단독(None)이면 제공자 my_uid 로 폴백.
        owner_uid = account_uid if account_uid is not None else get_my_uid()
        auto_tags = [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM auto_tag WHERE owner_uid IS ? ORDER BY name",
                (owner_uid,),
            ).fetchall()
        ]
        # ★생성자 필터 후보는 '이 사용자가 볼 수 있는 생성물의 생성자'만 — 예전엔 worker
        #  테이블 전체를 무필터로 돌려줘, members 라우터가 일반 사용자에게 감추는 전 계정
        #  식별자(이름 미설정 계정은 name 칸에 이메일 그대로)까지 facets 한 번으로 새어 나갔다.
        #  가시 범위 = 내 생성물 ∪ 공유(share)된 생성물 — 카드로 이미 보이는 정보만 노출.
        #  account_uid 없음(AUTH off/단독)은 로컬 단일 사용자라 전체 생성자 허용(기존 동작).
        if account_uid:
            visible = "(g.creator_uid = ? OR EXISTS(SELECT 1 FROM share s WHERE s.generation_id = g.id))"
            worker_args: list[Any] = [account_uid]
        else:
            visible = "1=1"
            worker_args = []
        workers = [
            dict(r)
            for r in conn.execute(
                "SELECT w.id, w.name, w.account_type FROM worker w "
                "WHERE EXISTS(SELECT 1 FROM generation g "
                f"             WHERE g.creator_uid = w.id AND g.deleted_at IS NULL AND {visible}) "
                "ORDER BY w.name",
                worker_args,
            ).fetchall()
        ]
    return {"colors": colors, "tags": tags_list, "auto_tags": auto_tags, "workers": workers}
