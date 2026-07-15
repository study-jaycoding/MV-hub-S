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
    gen_args: list[Any] = [account_uid] if account_uid else []
    with get_connection() as conn:
        colors = [
            r["color"]
            for r in conn.execute(
                "SELECT DISTINCT g.color FROM generation g "
                "WHERE g.color IS NOT NULL AND g.color <> '' AND g.deleted_at IS NULL"
                f"{gen_filter} ORDER BY g.color",
                gen_args,
            ).fetchall()
        ]
        tags_list = [
            r["name"]
            for r in conn.execute(
                "SELECT DISTINCT t.name FROM tag t "
                "JOIN gen_tag gt ON gt.tag_id = t.id "
                "JOIN generation g ON g.id = gt.generation_id "
                f"WHERE g.deleted_at IS NULL{gen_filter} ORDER BY t.name",
                gen_args,
            ).fetchall()
        ]
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
        workers = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, account_type FROM worker ORDER BY name"
            ).fetchall()
        ]
    return {"colors": colors, "tags": tags_list, "auto_tags": auto_tags, "workers": workers}
