"""서브스페이스(워크스페이스 콘솔)의 프로젝트 변경 보호 — 다른 repo 모듈을 import 하지 않는 잎 모듈.
크레딧 계획·프로젝트·신원 모듈이 이 판정만 부르므로 workspace_console 과 서로 부르는 import 순환이 생기지 않는다
(tests/test_architecture_boundaries.py 가 함수 안 import 까지 센다). workspace_console 이 같은 이름으로 재노출한다."""
from __future__ import annotations

from typing import Optional

_RECURRING_COPY_KEY = "workspace_console_recurring_copy_v1"  # 서브스페이스 전환 스위치(설계 §13)
STATUSES = ("active", "inactive", "done")
PLAN_STATUS = {"active": "active", "inactive": "hold", "done": "done"}


class ConsoleManaged(ValueError):
    """서브스페이스가 정하는 값(서브 프로젝트의 예산·상태·보관)을 다른 창에서 바꾸려는 요청 — 400."""


def managed_sub(conn, workspace_id: Optional[str]) -> Optional[str]:
    """서브스페이스 전환(1회 옮기기 표식) 뒤 **연결된 서브**면 그 콘솔 상태, 아니면 None. 이 값이 켜지면 크레딧은 서브스페이스 값만 쓰고
    (파생 끔) 그 프로젝트의 예산·상태·보관은 서브스페이스를 따라야 한다(설계 §13 합의안). 표식 전에는 전부 종전대로."""
    if not workspace_id:
        return None
    row = conn.execute(
        "SELECT status FROM workspace_console WHERE workspace_id=? AND tier='sub' AND archived=0 "
        "AND EXISTS(SELECT 1 FROM manage_schema_state WHERE key=?)",
        (workspace_id, _RECURRING_COPY_KEY),
    ).fetchone()
    return (row["status"] or "active") if row else None


def guard_project_change(conn, pid: str, *, budget: Optional[tuple] = None, status: Optional[str] = None,
                         archived: Optional[bool] = None) -> None:
    """구버전 관리 창이 서브스페이스 값을 덮지 못하게(서버 판정). 바뀌는 값만 넘긴다 — 예산은 (credits, period) 가 달라지면 거절,
    상태·보관은 콘솔 상태의 짝이 아니면 거절. 서브스페이스는 콘솔 상태를 먼저 쓰고 뒤따라 맞추므로 통과한다."""
    row = conn.execute("SELECT workspace_id FROM project WHERE id=?", (pid,)).fetchone()
    console_status = managed_sub(conn, row["workspace_id"] if row else None)
    if not console_status:
        return
    if budget is not None:
        raise ConsoleManaged("이 프로젝트의 크레딧은 서브스페이스에서 정합니다")
    if status is not None and status != PLAN_STATUS[console_status]:
        raise ConsoleManaged("이 프로젝트의 상태는 서브스페이스에서 정합니다")
    if archived is not None and archived != (console_status == "done"):
        raise ConsoleManaged("이 프로젝트의 보관은 서브스페이스 상태로 정합니다")
