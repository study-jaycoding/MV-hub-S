"""생성물의 현재 워크스페이스 귀속을 안전하게 수동 보정한다.

태그와 달리 워크스페이스는 프로젝트·관리 집계의 기준이다. 따라서 선택 항목 중 하나라도
존재/소유권/프로젝트 정합성 검증에 실패하면 같은 요청의 모든 변경을 취소한다.
"""

from __future__ import annotations

import unicodedata
from typing import Any, Optional

from ..db import get_connection
from ..emailnorm import norm_email


class WorkspaceAssignmentError(ValueError):
    """워크스페이스 귀속 변경의 사용자 입력/정합성 오류."""


class WorkspaceNameNotFound(WorkspaceAssignmentError):
    pass


class WorkspaceNameAmbiguous(WorkspaceAssignmentError):
    pass


class WorkspaceGenerationNotFound(WorkspaceAssignmentError):
    pass


class WorkspaceOwnershipError(WorkspaceAssignmentError):
    pass


def _normalized_workspace_name(value: str) -> str:
    return unicodedata.normalize("NFC", str(value or "").strip()).casefold()


def resolve_workspace_name(
    name: str,
    *,
    account_email: Optional[str] = None,
) -> dict[str, str]:
    """사용 가능한 실제 팀 워크스페이스 이름을 UUID와 정식 표시명으로 해석한다.

    AUTH 계정은 그 계정이 최근 보고한 접근 가능한 목록만 사용한다. 단독 개발 모드는
    로컬 등록부 전체를 사용하되, 같은 이름의 서로 다른 UUID가 있으면 임의 선택하지 않는다.
    """
    from .identity import list_workspace_options, list_workspace_registry

    cleaned = unicodedata.normalize("NFC", str(name or "").strip())
    if not cleaned:
        raise WorkspaceNameNotFound("워크스페이스 이름을 입력하세요")
    rows = (
        list_workspace_registry(account_email, available_only=True)
        if account_email
        else list_workspace_options()
    )
    wanted = _normalized_workspace_name(cleaned)
    matches: dict[str, dict[str, Any]] = {}
    for row in rows:
        workspace_id = str(row.get("id") or "").strip()
        workspace_name = str(row.get("name") or "").strip()
        if workspace_id and _normalized_workspace_name(workspace_name) == wanted:
            matches[workspace_id] = row
    if not matches:
        raise WorkspaceNameNotFound(f"워크스페이스 '{cleaned}'이(가) 존재하지 않습니다")
    if len(matches) > 1:
        raise WorkspaceNameAmbiguous(
            f"워크스페이스 이름 '{cleaned}'이(가) 여러 개입니다. 고유한 이름으로 변경한 뒤 다시 시도하세요"
        )
    row = next(iter(matches.values()))
    return {"id": str(row["id"]), "name": str(row["name"]).strip()}


def resolve_workspace_id(
    workspace_id: str,
    *,
    account_email: Optional[str] = None,
) -> dict[str, str]:
    """현재 계정이 사용할 수 있는 워크스페이스를 UUID로 정확히 해석한다.

    표시명은 서로 다른 워크스페이스에서 중복될 수 있다. 선택 UI가 이미 UUID를 알고 있을
    때는 이름을 다시 검색하지 않고 이 경로를 사용해야 엉뚱한 공간을 고르거나 모호성 오류가
    발생하지 않는다. 계정이 접근할 수 없는 UUID도 존재하지 않는 값과 똑같이 거절한다.
    """
    cleaned = str(workspace_id or "").strip()
    if not cleaned:
        raise WorkspaceNameNotFound("워크스페이스 식별자를 확인할 수 없습니다")
    with get_connection() as conn:
        if account_email:
            row = conn.execute(
                "SELECT w.id, w.name FROM workspace_registry w "
                "JOIN workspace_member m ON m.workspace_id=w.id "
                "WHERE w.id=? AND m.account_email=? AND m.is_available=1 LIMIT 1",
                (cleaned, norm_email(account_email)),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id, name FROM workspace_registry WHERE id=? LIMIT 1",
                (cleaned,),
            ).fetchone()
    if row:
        row_id = str(row["id"] or "").strip()
        row_name = str(row["name"] or "").strip()
        if row_id and row_name:
            return {"id": row_id, "name": row_name}
    raise WorkspaceNameNotFound("접근 가능한 워크스페이스를 찾을 수 없습니다")


def _dedupe_refs(generation_ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in generation_ids or []:
        ref = str(raw or "").strip()
        if ref and ref not in seen:
            seen.add(ref)
            out.append(ref)
    return out


def _build_plan(
    conn,
    generation_ids: list[str],
    operation: str,
    workspace: dict[str, str],
    owner_uid: Optional[str],
) -> dict[str, Any]:
    refs = _dedupe_refs(generation_ids)
    if operation not in {"assign", "remove"}:
        raise WorkspaceAssignmentError("알 수 없는 워크스페이스 변경 방식입니다")
    if not refs:
        raise WorkspaceGenerationNotFound("변경할 생성물을 선택하세요")

    # VALUES CTE는 id/job_id 두 IN 목록을 만들지 않아 500개 선택에서도 SQLite 변수 상한을
    # 안전하게 지킨다. requested_id를 함께 반환해 어떤 입력이 어떤 로컬 행과 매칭됐는지 보존한다.
    values = ",".join("(?)" for _ in refs)
    rows = conn.execute(
        f"WITH requested(requested_id) AS (VALUES {values}) "
        "SELECT requested.requested_id, g.id, g.job_id, g.creator_uid, g.deleted_at, "
        "g.workspace_scope, g.workspace_id, g.workspace_name, g.project_id, "
        "p.workspace_scope AS project_workspace_scope, p.workspace_id AS project_workspace_id, "
        "p.workspace_name AS project_workspace_name, "
        "EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared "
        "FROM requested JOIN generation g "
        "ON g.id=requested.requested_id OR g.job_id=requested.requested_id "
        "LEFT JOIN project p ON p.id=g.project_id",
        refs,
    ).fetchall()

    matched: dict[str, list[dict[str, Any]]] = {ref: [] for ref in refs}
    for row in rows:
        matched[str(row["requested_id"])].append(dict(row))
    missing = [ref for ref, candidates in matched.items() if not candidates]
    ambiguous = [ref for ref, candidates in matched.items() if len(candidates) > 1]
    if missing:
        raise WorkspaceGenerationNotFound(
            f"생성물을 찾을 수 없습니다: {', '.join(missing[:3])}"
        )
    if ambiguous:
        raise WorkspaceGenerationNotFound(
            f"생성물 식별자가 중복되어 변경할 수 없습니다: {', '.join(ambiguous[:3])}"
        )

    resolved = [matched[ref][0] for ref in refs]
    deleted = [row["requested_id"] for row in resolved if row.get("deleted_at")]
    if deleted:
        raise WorkspaceGenerationNotFound(
            f"휴지통의 생성물은 변경할 수 없습니다: {', '.join(deleted[:3])}"
        )
    if owner_uid is not None:
        foreign = [
            row["requested_id"]
            for row in resolved
            if row.get("creator_uid") != owner_uid
        ]
        if foreign:
            raise WorkspaceOwnershipError("내 생성카드만 워크스페이스를 변경할 수 있습니다")

    target_id = workspace["id"]
    # #+ 는 프로젝트도 함께 옮긴다(Jay 결정: 워크스페이스를 바꾸면 프로젝트도 그걸로).
    # 대상 워크스페이스의 활성 프로젝트가 정확히 1개일 때만 자동 배정(워크스페이스당 프로젝트
    # 1개 운영 전제). 0개/여러 개면 어느 프로젝트인지 정할 수 없어 미분류로 둔다.
    assigned_project: Optional[dict[str, Any]] = None
    if operation == "assign":
        target_projects = conn.execute(
            "SELECT id, name FROM project "
            "WHERE workspace_scope='team' AND workspace_id=? AND archived=0",
            (target_id,),
        ).fetchall()
        if len(target_projects) == 1:
            assigned_project = dict(target_projects[0])

    changed: list[dict[str, Any]] = []
    unchanged: list[dict[str, Any]] = []
    for row in resolved:
        project_id = row.get("project_id")
        in_team_project = bool(project_id) and row.get("project_workspace_scope") == "team"
        current_matches = (
            row.get("workspace_scope") == "team" and row.get("workspace_id") == target_id
        )
        if operation == "assign":
            # 프로젝트 연동: 이미 대상 워크스페이스의 프로젝트면 유지, 대상에 유일 프로젝트가
            # 있으면 그리로 이동/배정, 없으면(0개·다중) 다른 워크스페이스 프로젝트만 해제.
            # 개인(비팀) 프로젝트 소속은 워크스페이스와 무관하므로 건드리지 않는다.
            if in_team_project and row.get("project_workspace_id") == target_id:
                project_action = "keep"
            elif assigned_project:
                project_action = "keep" if project_id == assigned_project["id"] else "set"
            elif in_team_project:
                project_action = "clear"
            else:
                project_action = "keep"
            needs_change = (
                not current_matches
                or row.get("workspace_name") != workspace["name"]
                or project_action != "keep"
            )
        else:
            # 제거는 도장이 그 워크스페이스인 카드만 대상 — 팀 프로젝트 소속이면 프로젝트도
            # 함께 해제한다(예전엔 거부했지만, #- 가 프로젝트까지 되돌리는 게 새 계약).
            needs_change = current_matches
            project_action = "clear" if needs_change and in_team_project else "keep"
        row["project_action"] = project_action
        (changed if needs_change else unchanged).append(row)

    return {
        "workspace": workspace,
        "operation": operation,
        "resolved": resolved,
        "changed": changed,
        "unchanged": unchanged,
        "assigned_project": assigned_project,
    }


def plan_generation_workspace_batch(
    generation_ids: list[str],
    operation: str,
    workspace: dict[str, str],
    owner_uid: Optional[str] = None,
) -> dict[str, Any]:
    """쓰기 없이 전체 선택의 변경 가능 여부와 매칭 결과를 계산한다."""
    with get_connection() as conn:
        return _build_plan(conn, generation_ids, operation, workspace, owner_uid)


def set_generation_workspace_batch(
    generation_ids: list[str],
    operation: str,
    workspace: dict[str, str],
    owner_uid: Optional[str] = None,
) -> dict[str, Any]:
    """전체 검증과 귀속 변경을 한 쓰기 트랜잭션으로 수행한다."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        plan = _build_plan(conn, generation_ids, operation, workspace, owner_uid)
        assigned_project = plan.get("assigned_project")
        for row in plan["changed"]:
            action = row.get("project_action", "keep")
            if operation == "assign":
                # 프로젝트 이동/해제 시 folder_path 도 초기화 — 옛 프로젝트의 폴더 경로는
                # 새 소속에서 유령 폴더가 된다(미분류 해제와 동일 규칙, assign_to_project 참조).
                if action == "set" and assigned_project:
                    conn.execute(
                        "UPDATE generation SET workspace_scope='team', workspace_id=?, "
                        "workspace_name=?, project_id=?, folder_path=NULL WHERE id=?",
                        (workspace["id"], workspace["name"], assigned_project["id"], row["id"]),
                    )
                elif action == "clear":
                    conn.execute(
                        "UPDATE generation SET workspace_scope='team', workspace_id=?, "
                        "workspace_name=?, project_id=NULL, folder_path=NULL WHERE id=?",
                        (workspace["id"], workspace["name"], row["id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE generation SET workspace_scope='team', workspace_id=?, workspace_name=? "
                        "WHERE id=?",
                        (workspace["id"], workspace["name"], row["id"]),
                    )
            else:
                # unknown은 과거 미확인 데이터라 다음 CLI 동기화가 현재 팀 컨텍스트로 보강할 수 있다.
                # 사용자가 명시적으로 제거한 결과는 personal로 저장해야 다시 팀 귀속이 살아나지 않는다.
                if action == "clear":
                    conn.execute(
                        "UPDATE generation SET workspace_scope='personal', workspace_id=NULL, "
                        "workspace_name=NULL, project_id=NULL, folder_path=NULL WHERE id=?",
                        (row["id"],),
                    )
                else:
                    conn.execute(
                        "UPDATE generation SET workspace_scope='personal', workspace_id=NULL, "
                        "workspace_name=NULL WHERE id=?",
                        (row["id"],),
                    )

    changed_local_ids = [str(row["id"]) for row in plan["changed"]]
    if changed_local_ids:
        # 관리 대시보드는 별도 팩트 DB를 읽으므로 다음 에이전트 push에서 즉시 재집계되게 한다.
        from .manage_telemetry import mark_telemetry_dirty

        mark_telemetry_dirty(changed_local_ids)
    return plan
