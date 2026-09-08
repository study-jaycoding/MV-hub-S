"""generation 조회들이 공유하는 팀 가시성 SQL 조각.

목록·작성자·폴더 카운트·신규 배지가 모두 같은 범위를 보도록 한 곳에서 조건과 인자를 만든다.
호출 SQL은 generation 테이블 별칭을 ``g``로 사용해야 한다.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence


def team_generation_visibility_clause(
    team_member_projects: Optional[Sequence[str]],
    actor_uid: Optional[str],
) -> tuple[Optional[str], list[Any]]:
    """팀 공유 generation의 가시성 조건과 바인딩 인자를 반환한다.

    ``team_member_projects=None``은 read_all·단독 모드라 추가 제한이 없다. 일반 사용자는 본인이
    만든 공유물 또는 멤버 프로젝트의 공유물만 본다. actor가 없고 멤버 프로젝트도 없으면 0건이다.
    ``\x00``은 미확정 계정용 센티넬이므로 actor 없음으로 취급한다.
    """
    if team_member_projects is None:
        return None, []

    actor = actor_uid if actor_uid and actor_uid != "\x00" else None
    projects = list(team_member_projects)
    if projects:
        placeholders = ",".join("?" * len(projects))
        if actor:
            return f"(g.creator_uid = ? OR g.project_id IN ({placeholders}))", [actor, *projects]
        return f"g.project_id IN ({placeholders})", projects
    if actor:
        return "g.creator_uid = ?", [actor]
    return "1=0", []


def alert_comment_visibility_clause(viewer_uid: str, read_all: bool) -> tuple[str, list[Any]]:
    """코멘트 알림 대상 생성물이 뷰어에게 '지금도 보이는지' — (AND 로 덧붙일 SQL 조각, 바인딩). read_all 이면 빈 조각.

    ALERT_COMMENT_TARGET_PREDICATE 의 '내 댓글에 달린 답글' 가지는 생성물 가시성을 보지 않아, 프로젝트를
    나갔거나 공유가 해제된 뒤의 답글도 본문·썸네일과 함께 알림으로 왔다(코덱스 레인C C2). 그 상수는 카드
    배지·패널이 위치 바인딩으로 공유하므로 건드리지 않고, 알림 센터(목록·모두 읽음)와 전역 통계의 미확인
    집계에 이 절을 덧붙인다 — 셋이 같은 경계여야 '모두 읽음' 뒤 벨 숫자가 남지 않는다(코덱스 코드 리뷰).
    경계는 team 탭 목록과 같다: 내 생성물이거나, 공유돼 있고(share 행) 내가 멤버인 프로젝트(또는 내가 만든 공유물).
    별칭 전제: g=generation.
    """
    if read_all:
        return "", []
    from .projects import my_member_projects  # 지역 import(순환 회피)

    vis_sql, vis_params = team_generation_visibility_clause(my_member_projects(viewer_uid), viewer_uid)
    if vis_sql is None:
        return "", []
    return (
        "AND (g.creator_uid = ? OR (EXISTS (SELECT 1 FROM share sh WHERE sh.generation_id = g.id) "
        "AND " + vis_sql + ")) ",
        [viewer_uid, *vis_params],
    )
