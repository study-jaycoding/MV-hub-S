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
