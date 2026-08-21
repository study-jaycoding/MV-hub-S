"""프로젝트 멤버 자동 편입 공용부(leaf) — 워크스페이스 자기보고를 프로젝트 멤버로 반영한다.

두 경로가 같은 규칙을 써야 한다: ①프로젝트 생성/워크스페이스 (재)지정(projects.py 일괄 추가)
②계정 상태 보고(identity.record_account_status — 새로 확인된 멤버를 기존 프로젝트에 편입).
identity ↔ projects 는 서로 import 할 수 없어(순환) 규칙을 이 leaf 에 모은다.

규칙: 확인된(is_available=1, creator_uid 해석 가능) 워크스페이스 멤버를 기본 역할로 추가하되
이미 있는 멤버·수동 조정 역할은 절대 건드리지 않고(INSERT DO NOTHING), PM 이 ✕ 로 뺀
수동 제외(project_member_removed)는 자동 편입이 되살리지 않는다 — 해제는 수동 재추가만.
같은 creator 가 복수 계정으로 보고돼도 전역 역할은 합집합으로 한 번만 계산한다.
모든 함수는 호출자의 conn(트랜잭션) 안에서 실행된다."""

from __future__ import annotations

import sqlite3
from typing import Optional


def _workspace_default_roles(
    conn: sqlite3.Connection, workspace_id: str, only_uid: Optional[str] = None
) -> dict[str, str]:
    """워크스페이스 확인 멤버별 기본 프로젝트 역할 CSV — {uid: role_csv}. only_uid 로 한 명만 계산."""
    from .. import rbac

    sql = (
        "SELECT COALESCE(m.creator_uid, a.creator_uid) creator_uid, a.global_role "
        "FROM workspace_member m "
        "LEFT JOIN account a ON a.email=m.account_email "
        "WHERE m.workspace_id=? AND m.is_available=1 "
        "AND COALESCE(m.creator_uid, a.creator_uid) IS NOT NULL"
    )
    args: list = [workspace_id]
    if only_uid is not None:
        sql += " AND COALESCE(m.creator_uid, a.creator_uid)=?"
        args.append(only_uid)
    globals_by_uid: dict[str, set[str]] = {}
    for row in conn.execute(sql, args).fetchall():
        uid = (row["creator_uid"] or "").strip()
        if not uid:
            continue
        globals_by_uid.setdefault(uid, set()).update(rbac.effective_roles(row["global_role"]))
    return {
        uid: (rbac.project_roles_to_str(rbac.default_project_roles(roles)) or rbac.CREATOR)
        for uid, roles in globals_by_uid.items()
    }


def _insert_members(conn: sqlite3.Connection, pid: str, roles_by_uid: dict[str, str]) -> int:
    """누락분만 추가 — 기존 멤버 보존(DO NOTHING), 수동 제외(tombstone)는 건너뜀."""
    added = 0
    for uid, role_csv in roles_by_uid.items():
        cur = conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) "
            "SELECT ?,?,? WHERE NOT EXISTS("
            "SELECT 1 FROM project_member_removed r WHERE r.project_id=? AND r.creator_uid=?) "
            "ON CONFLICT(project_id, creator_uid) DO NOTHING",
            (pid, uid, role_csv, pid, uid),
        )
        added += cur.rowcount
    return added


def enroll_workspace_members_into_project(
    conn: sqlite3.Connection, pid: str, workspace_id: str
) -> int:
    """워크스페이스의 현재 확인 멤버 전원을 이 프로젝트에 누락분만 추가. 추가한 행 수 반환."""
    return _insert_members(conn, pid, _workspace_default_roles(conn, workspace_id))


def enroll_uid_into_workspace_projects(
    conn: sqlite3.Connection, workspace_id: str, creator_uid: str
) -> int:
    """확인된 멤버 한 명을 그 워크스페이스가 지정된 활성(비보관) 프로젝트 전부에 편입.

    계정 상태 보고마다 멱등 실행 — 실패·배포 순서로 놓친 편입을 다음 보고가 자가치유한다."""
    roles_by_uid = _workspace_default_roles(conn, workspace_id, only_uid=creator_uid)
    if not roles_by_uid:
        return 0
    total = 0
    for row in conn.execute(
        "SELECT id FROM project WHERE workspace_scope='team' AND workspace_id=? AND archived=0",
        (workspace_id,),
    ).fetchall():
        total += _insert_members(conn, row["id"], roles_by_uid)
    return total


def record_manual_removal(conn: sqlite3.Connection, pid: str, creator_uid: str) -> None:
    """PM 의 ✕ 를 기록 — 이후 자동 편입이 이 멤버를 되살리지 않는다. 멱등."""
    conn.execute(
        "INSERT INTO project_member_removed(project_id, creator_uid) VALUES(?,?) "
        "ON CONFLICT(project_id, creator_uid) DO UPDATE SET removed_at=datetime('now')",
        (pid, creator_uid),
    )


def clear_manual_removal(conn: sqlite3.Connection, pid: str, creator_uid: str) -> None:
    """수동 재추가(역할 지정)의 제외 해제 — 다시 자동 편입 대상이 된다."""
    conn.execute(
        "DELETE FROM project_member_removed WHERE project_id=? AND creator_uid=?",
        (pid, creator_uid),
    )
