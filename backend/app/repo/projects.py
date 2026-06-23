"""프로젝트(작업 묶음) 데이터 접근 — 로드맵 §0-4/§4-4.

프로젝트는 **공유·이동의 단위**다(개인필터인 태그·컬러와 다름). 선택하면 그 안의
결과물만 보인다. generation.project_id 로 귀속하고, NULL = 미분류.

로그인·등급은 아직 없으므로 가시성 enforcement(멤버만 보기)는 하지 않는다 —
project_member 는 전방 호환용으로 기록만 한다(로드맵: 식별 먼저, 차단은 나중).
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id

_SELECT = (
    "SELECT p.id, p.name, p.kind, p.created_by, p.created_at, p.archived, "
    # 그리드와 동일 기준(삭제분 제외) — 안 그러면 옛 소프트삭제 잔존이 카운트만 부풀린다.
    "(SELECT COUNT(*) FROM generation g WHERE g.project_id = p.id AND g.deleted_at IS NULL) AS count "
    "FROM project p"
)


def _provider_uid() -> Optional[str]:
    """프로젝트 created_by 기본값 — 로그인 전엔 제공자 신원(없으면 None)."""
    from .identity import get_provider

    try:
        return get_provider().get("uid")
    except Exception:  # noqa: BLE001 — 신원 미설정이어도 프로젝트 생성은 가능해야
        return None


def _row(conn: sqlite3.Connection, pid: str) -> Optional[dict[str, Any]]:
    row = conn.execute(f"{_SELECT} WHERE p.id = ?", (pid,)).fetchone()
    return dict(row) if row else None


def create_project(
    name: str, kind: str = "team", created_by: Optional[str] = None
) -> dict[str, Any]:
    """새 프로젝트 생성. 같은 이름(미보관)이 이미 있으면 그것을 반환(멱등적 생성)."""
    name = (name or "").strip()
    if not name:
        raise ValueError("빈 프로젝트 이름")
    kind = kind if kind in ("team", "personal") else "team"
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM project WHERE name = ? AND archived = 0", (name,)
        ).fetchone()
        if existing:
            return _row(conn, existing["id"])  # type: ignore[return-value]
        pid = new_id()
        conn.execute(
            "INSERT INTO project(id, name, kind, created_by) VALUES(?,?,?,?)",
            (pid, name, kind, created_by or _provider_uid()),
        )
        return _row(conn, pid)  # type: ignore[return-value]


def get_project(pid: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        return _row(conn, pid)


def list_projects(
    include_archived: bool = False,
    member_uid: Optional[str] = None,
    viewer_uid: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트 목록 + 미분류 수 + 보관 개수. 결과물 많은 순 → 이름 순.
    반환: {"projects": [...], "unassigned": N, "archived_count": M}.

    역할이 다른 두 필터:
      · member_uid — 가시성: 주어지면(전역 read_all 없는 일반 멤버) 그 계정이 멤버인 프로젝트만.
        read_all(admin·PM·PD) 보유자는 호출측에서 member_uid=None(전체)로 부른다(§5-3).
      · viewer_uid — 카운트: 주어지면 프로젝트 count·미분류 수를 '내 생성물'만 센다(My Work 사이드바).
        없으면(AUTH off/단독) 전체를 센다. → 다른 계정에 내 미분류/카운트가 새지 않게 한다."""
    conds: list[str] = []
    args: list[Any] = []
    if not include_archived:
        conds.append("p.archived = 0")
    if member_uid is not None:
        conds.append("p.id IN (SELECT project_id FROM project_member WHERE creator_uid = ?)")
        args.append(member_uid)
    clause = (" WHERE " + " AND ".join(conds)) if conds else ""
    # 프로젝트 count — viewer_uid 가 있으면 그 계정 생성물만(내 작업 기준).
    gen_cond = "g.project_id = p.id AND g.deleted_at IS NULL"
    count_args: list[Any] = []
    if viewer_uid:
        gen_cond += " AND g.creator_uid = ?"
        count_args.append(viewer_uid)
    # count = viewer 의 것(사이드바 My Work), total = 프로젝트 전체(관리자 탭에서 표시).
    select = (
        "SELECT p.id, p.name, p.kind, p.created_by, p.created_at, p.archived, "
        f"(SELECT COUNT(*) FROM generation g WHERE {gen_cond}) AS count, "
        "(SELECT COUNT(*) FROM generation gt WHERE gt.project_id=p.id AND gt.deleted_at IS NULL) AS total "
        "FROM project p"
    )
    sql = f"{select}{clause} ORDER BY count DESC, p.name COLLATE NOCASE"
    # 미분류 수 — 동일하게 viewer 의 것만.
    un_cond = "project_id IS NULL AND deleted_at IS NULL"
    un_args: list[Any] = []
    if viewer_uid:
        un_cond += " AND creator_uid = ?"
        un_args.append(viewer_uid)
    with get_connection() as conn:
        projects = [dict(r) for r in conn.execute(sql, count_args + args).fetchall()]
        unassigned = conn.execute(
            f"SELECT COUNT(*) AS c FROM generation WHERE {un_cond}", un_args
        ).fetchone()["c"]
        archived_count = conn.execute(
            "SELECT COUNT(*) AS c FROM project WHERE archived = 1"
        ).fetchone()["c"]
    return {"projects": projects, "unassigned": unassigned, "archived_count": archived_count}


def rename_project(pid: str, name: str) -> bool:
    name = (name or "").strip()
    if not name:
        raise ValueError("빈 프로젝트 이름")
    with get_connection() as conn:
        cur = conn.execute("UPDATE project SET name = ? WHERE id = ?", (name, pid))
        return cur.rowcount > 0


def set_archived(pid: str, archived: bool) -> bool:
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE project SET archived = ? WHERE id = ?", (1 if archived else 0, pid)
        )
        return cur.rowcount > 0


def delete_project(pid: str) -> bool:
    """프로젝트 삭제 — 귀속 결과물은 지우지 않고 미분류(NULL)로 되돌린다.
    project_member 는 FK ON DELETE CASCADE 로 함께 정리."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET project_id = NULL WHERE project_id = ?", (pid,)
        )
        cur = conn.execute("DELETE FROM project WHERE id = ?", (pid,))
        return cur.rowcount > 0


def assign_to_project(generation_ids: list[str], project_id: Optional[str]) -> int:
    """결과물들을 프로젝트에 귀속(또는 project_id=None 으로 미분류 해제). 변경 행수 반환.
    project_id 가 실재하는지 검증(없으면 ValueError)."""
    if not generation_ids:
        return 0
    with get_connection() as conn:
        if project_id is not None and not conn.execute(
            "SELECT 1 FROM project WHERE id = ?", (project_id,)
        ).fetchone():
            raise ValueError(f"없는 프로젝트: {project_id}")
        placeholders = ",".join("?" for _ in generation_ids)
        cur = conn.execute(
            f"UPDATE generation SET project_id = ? WHERE id IN ({placeholders})",
            [project_id, *generation_ids],
        )
        return cur.rowcount


def set_project_roles(pid: str, creator_uid: str, project_roles) -> bool:
    """그 프로젝트에서 멤버의 역할(복수)을 지정 — 리스트/CSV → CSV 저장. 빈값이면 역할만 비움.
    멤버 행이 없으면 만든다(부여가 곧 멤버 추가)."""
    from .. import rbac

    csv = rbac.project_roles_to_str(project_roles)
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM project WHERE id = ?", (pid,)).fetchone():
            raise ValueError(f"없는 프로젝트: {pid}")
        conn.execute(
            "INSERT INTO project_member(project_id, creator_uid, project_role) VALUES(?,?,?) "
            "ON CONFLICT(project_id, creator_uid) DO UPDATE SET project_role=excluded.project_role",
            (pid, creator_uid, csv or None),
        )
        return True


def remove_project_member(pid: str, creator_uid: str) -> bool:
    """프로젝트에서 멤버를 제거(project_member 행 삭제). 멱등."""
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM project_member WHERE project_id=? AND creator_uid=?",
            (pid, creator_uid),
        )
        return cur.rowcount > 0


def get_project_roles(pid: str, creator_uid: str) -> str:
    """그 프로젝트에서 이 uid 의 역할들(CSV, 멤버 아님→'')."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT project_role FROM project_member WHERE project_id=? AND creator_uid=?",
            (pid, creator_uid),
        ).fetchone()
    return (row["project_role"] if row else None) or ""


def my_member_projects(creator_uid: str) -> list[str]:
    """이 계정이 멤버(역할 무관)인 모든 project_id — Team 탭 공유물을 내 프로젝트로 한정하는 데 쓴다."""
    with get_connection() as conn:
        return [
            r["project_id"]
            for r in conn.execute(
                "SELECT project_id FROM project_member WHERE creator_uid=?", (creator_uid,)
            ).fetchall()
        ]


def projects_where_role(creator_uid: str, roles: list[str]) -> list[str]:
    """이 계정이 주어진 프로젝트 역할(예: supervisor/project_manager) 중 하나라도 가진 project_id 목록.
    프론트가 '최종(골드) 지정 가능 여부'를 카드별로 판단하는 데 쓴다."""
    from .. import rbac

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT project_id, project_role FROM project_member WHERE creator_uid=?",
            (creator_uid,),
        ).fetchall()
    out: list[str] = []
    for r in rows:
        rs = rbac.parse_project_roles(r["project_role"])
        if any(role in rs for role in roles):
            out.append(r["project_id"])
    return out


def list_project_members(pid: str) -> list[dict[str, Any]]:
    """프로젝트 멤버 [{uid, roles[], name}] — 역할 관리 UI 용. 이름은 creator 에서 조인."""
    from .. import rbac

    with get_connection() as conn:
        # 이름은 creator.name → account.name → 이메일 로컬파트 순 폴백(UI 는 절대 uid 를 보이지 않음).
        rows = conn.execute(
            "SELECT m.creator_uid uid, m.project_role role, "
            "COALESCE(NULLIF(c.name,''), NULLIF(a.name,'')) name, a.email email "
            "FROM project_member m "
            "LEFT JOIN creator c ON c.uid = m.creator_uid "
            "LEFT JOIN account a ON a.creator_uid = m.creator_uid "
            "WHERE m.project_id = ? ORDER BY name",
            (pid,),
        ).fetchall()
    return [
        {
            "uid": r["uid"],
            "roles": rbac.parse_project_roles(r["role"]),
            "name": r["name"] or (r["email"].split("@")[0] if r["email"] else None),
        }
        for r in rows
    ]


def list_all_project_members() -> dict[str, list[dict[str, Any]]]:
    """모든 프로젝트의 멤버를 한 쿼리로 {pid: [{uid, roles, name}]} 반환.
    관리자 창이 프로젝트마다 따로 요청하던 것을 1회로 — 요청 N→1, 라운드트립 제거."""
    from .. import rbac

    out: dict[str, list[dict[str, Any]]] = {}
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT m.project_id pid, m.creator_uid uid, m.project_role role, c.name name "
            "FROM project_member m LEFT JOIN creator c ON c.uid = m.creator_uid "
            "ORDER BY m.project_id, c.name"
        ).fetchall()
    for r in rows:
        out.setdefault(r["pid"], []).append(
            {"uid": r["uid"], "roles": rbac.parse_project_roles(r["role"]), "name": r["name"]}
        )
    return out
