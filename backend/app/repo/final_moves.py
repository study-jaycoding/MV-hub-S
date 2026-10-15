"""최종본의 프로젝트 귀속을 바꾸는 쓰기에 양쪽 검수자 확인(Jay 결정 3A, 10-15).

최종(골드)본의 project_id 가 실제로 바뀔 때만 본다(같은 프로젝트 안 폴더 이동·최종 아닌 것은 그대로). 전역 admin 은 통과,
아니면 **출발이 프로젝트면 그 검수자 · 도착이 프로젝트면 그 검수자**(미분류 쪽은 볼 검수자가 없다). 판정은 각 쓰기의
**같은 트랜잭션·같은 연결**에서 한다 — 확인과 쓰기 사이에 귀속·역할이 바뀌어 낡은 판정으로 옮기지 않게.
설계: docs/status/결정일곱_설계_2026-10-15.md 3A.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from .. import rbac

__all__ = ["FINAL_MOVE_DENIED", "FinalMoveActor", "FinalMoveDenied", "FinalProjectChanged", "check_final_moves"]

FINAL_MOVE_DENIED = "최종본은 두 프로젝트의 검수자(또는 관리자)만 옮길 수 있습니다"


class FinalMoveDenied(Exception):
    """최종본 이동이 막혔다 — 라우터가 403 으로 바꾼다."""

    def __init__(self, project_names: list[str]):
        self.project_names = project_names
        suffix = f" — {', '.join(project_names)}" if project_names else ""
        super().__init__(FINAL_MOVE_DENIED + suffix)


class FinalProjectChanged(Exception):
    """최종 지정·해제의 권한을 본 뒤 그사이 귀속 프로젝트가 바뀌었다 — 라우터가 409 로 바꾼다."""


@dataclass(frozen=True)
class FinalMoveActor:
    """요청한 사람 — AUTH off(단독)는 판정하지 않으므로 이 값을 만들지 않는다(None)."""

    uid: Optional[str]
    admin: bool

    def supervises(self, conn, project_id: Optional[str]) -> bool:
        if not project_id or self.admin:
            return True
        if not self.uid:
            return False
        row = conn.execute(
            "SELECT project_role FROM project_member WHERE project_id=? AND creator_uid=?",
            (project_id, self.uid),
        ).fetchone()
        return bool(row) and rbac.has_any_project_role(row["project_role"], rbac.SUPERVISOR)


def check_final_moves(
    conn,
    actor: Optional[FinalMoveActor],
    moves: Iterable[tuple[bool, Optional[str], Optional[str]]],
) -> None:
    """moves = (최종인가, 지금 project_id, 바뀔 project_id). 하나라도 걸리면 FinalMoveDenied(아무것도 쓰기 전에 부른다)."""
    if actor is None:
        return
    denied: list[str] = []
    for is_final, before, after in moves:
        if not is_final or (before or None) == (after or None):
            continue
        for project_id in (before, after):
            if project_id and not actor.supervises(conn, project_id) and project_id not in denied:
                denied.append(project_id)
    if denied:
        names = [
            (row["name"] if row else pid)
            for pid, row in ((pid, conn.execute("SELECT name FROM project WHERE id=?", (pid,)).fetchone()) for pid in denied)
        ]
        raise FinalMoveDenied(names)
