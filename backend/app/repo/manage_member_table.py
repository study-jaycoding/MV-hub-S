"""PM 대시보드 '관리 표' 읽기 — 계정 한 줄에 등급·크레딧 그룹·프로젝트 참여·보고된 사실을 짜 맞춘다.

설계: docs/MEMBER_TABLE_DESIGN.md. **쓰기는 없다** — 표의 칸은 저마다 기존 API 로 저장한다.
신원 키가 둘이다: 크레딧 그룹·사용량은 이메일, 등급·프로젝트 참여는 creator_uid. 줄은 계정(이메일) 하나이고
uid 는 따로 준다 — 없거나 합성(`acct:`)이면 None 이고 그 줄은 프로젝트에 넣을 수 없다.
두 DB(content · manage_hub)를 읽으므로 원자적 한 스냅샷은 아니다."""

from __future__ import annotations

from typing import Any, Optional

from .. import rbac
from ..emailnorm import norm_email
from . import identity
from . import manage_credit_plan as credit_plan
from .manage_schema import _ensure_schema
from ..db import get_connection


def _real_uid(uid: Optional[str]) -> Optional[str]:
    return uid if uid and not str(uid).startswith("acct:") else None


def member_table(workspace_id: Optional[str], *, with_credit: bool) -> dict[str, Any]:
    """workspace_id 가 있으면 그 워크스페이스 멤버(+그룹 배정만 남은 이메일), 없으면 숨기지 않은 전체 계정.
    with_credit=False 면 그룹 설정 원문(credit)은 주지 않는다(줄의 group_id 는 준다)."""
    settings = credit_plan.get_settings(workspace_id) if workspace_id else None
    with get_connection() as conn:
        _ensure_schema(conn)
        accounts = {
            r["email"]: r
            for r in conn.execute(
                "SELECT a.email, a.status, a.global_role, a.creator_uid, COALESCE(a.hidden,0) AS hidden, "
                "COALESCE(NULLIF(c.name,''), NULLIF(a.name,'')) AS name "
                "FROM account a LEFT JOIN creator c ON c.uid=a.creator_uid "
                "ORDER BY a.created_at, a.email"
            ).fetchall()
        }
        seen_rows = conn.execute(
            "SELECT account_email AS email, MAX(creator_uid) AS uid, MAX(last_seen_at) AS last_seen_at "
            "FROM workspace_member" + (" WHERE workspace_id=?" if workspace_id else "") + " GROUP BY account_email",
            (workspace_id,) if workspace_id else (),
        ).fetchall()
        project_rows = conn.execute(
            "SELECT p.id, p.name, pp.project_id AS planning_id, pp.status, pp.start_date, pp.due_date, "
            "pp.budget_credits, pp.budget_period, pp.archive_after_days, pp.note "
            "FROM project p LEFT JOIN project_planning pp ON pp.project_id=p.id "
            "WHERE p.kind='team' AND COALESCE(p.archived,0)=0"
            + (" AND p.workspace_scope='team' AND p.workspace_id=?" if workspace_id else "")
            + " ORDER BY p.sort_order IS NULL, p.sort_order, p.name COLLATE NOCASE",
            (workspace_id,) if workspace_id else (),
        ).fetchall()
        projects = [
            {
                "id": r["id"],
                "name": r["name"],
                "planning": None if not r["planning_id"] else {
                    "project_id": r["id"],
                    "status": r["status"],
                    "start_date": r["start_date"],
                    "due_date": r["due_date"],
                    "budget_credits": r["budget_credits"],
                    "budget_period": r["budget_period"],
                    "archive_after_days": r["archive_after_days"],
                    "note": r["note"],
                },
            }
            for r in project_rows
        ]
        roles_by_uid: dict[str, dict[str, list[str]]] = {}
        if projects:
            marks = ",".join("?" * len(projects))
            for r in conn.execute(
                f"SELECT project_id, creator_uid, project_role FROM project_member WHERE project_id IN ({marks})",
                [p["id"] for p in projects],
            ).fetchall():
                roles_by_uid.setdefault(r["creator_uid"], {})[r["project_id"]] = rbac.parse_project_roles(r["project_role"])
    seen = {r["email"]: r for r in seen_rows}
    linked: dict[str, int] = {}
    for a in accounts.values():
        uid = _real_uid(a["creator_uid"])
        if uid:
            linked[uid] = linked.get(uid, 0) + 1
    plans = {norm_email(email): (st or {}).get("plan") for email, st in identity.list_account_statuses().items()}
    usage: dict[str, dict[str, float]] = {}
    if settings:
        from .. import manage_db  # 지연 import — 다른 DB(manage_hub)

        for u in manage_db.workspace_email_usage(workspace_id, settings["cycle_start"]):
            if u["day"] < settings["cycle_start"]:
                continue
            slot = usage.setdefault(u["email"], {"credits": 0.0, "count": 0, "unknown": 0})
            slot["credits"] += float(u["credits"] or 0)
            slot["count"] += int(u["count"] or 0)
            slot["unknown"] += int(u["unknown"] or 0)

    if settings:
        base = list(settings["members"])
        base_uids: set[str] = set()
        for member in base:
            account = accounts.get(member["email"])
            account_uid = _real_uid(account["creator_uid"] if account else None)
            reported_uid = _real_uid((seen.get(member["email"]) or {"uid": None})["uid"])
            if account_uid or reported_uid:
                base_uids.add(account_uid or reported_uid)
        # 워크스페이스 등록부에는 없어도 이 워크스페이스 프로젝트에 직접 추가된 가입 계정은
        # 관리 표에 남긴다. 같은 uid의 복수 계정은 한 줄만 보강한다.
        for account in accounts.values():
            uid = _real_uid(account["creator_uid"])
            if account["hidden"] or not uid or uid in base_uids or uid not in roles_by_uid:
                continue
            base.append({
                "email": account["email"],
                "name": account["name"],
                "workspace_role": None,
                "is_available": False,
                "group_id": None,
            })
            base_uids.add(uid)
    else:
        base = [
            {"email": a["email"], "name": a["name"], "workspace_role": None, "is_available": None, "group_id": None}
            for a in accounts.values()
        ]
    rows: list[dict[str, Any]] = []
    for m in base:
        email = m["email"]
        account = accounts.get(email)
        if account is not None and account["hidden"]:
            continue  # 숨긴 계정은 /api/members 와 같이 뺀다
        # uid 는 로그인 계정의 것을 먼저 쓴다(권한·자동 편입이 보는 축). 워크스페이스 보고의 uid 와 둘 다 실제인데 서로 다르면
        # (레거시·부분 이관) 어느 쪽에 역할을 줘야 할지 알 수 없으므로 프로젝트 칸을 잠근다(코덱스 P2).
        account_uid = _real_uid(account["creator_uid"] if account else None)
        reported_uid = _real_uid((seen.get(email) or {"uid": None})["uid"])
        uid = account_uid or reported_uid
        lock = "unlinked" if uid is None else ("uid_conflict" if account_uid and reported_uid and account_uid != reported_uid else None)
        used = usage.get(email)
        rows.append(
            {
                "email": email,
                "name": m["name"] or (account["name"] if account else None) or email.split("@", 1)[0],
                "status": account["status"] if account else None,
                "global_roles": rbac.parse_roles(account["global_role"]) if account else [],
                "uid": uid,
                "project_editable": lock is None,
                "project_lock": lock,  # unlinked | uid_conflict | None
                "linked_accounts": linked.get(uid, 0) if uid else 0,
                "workspace_role": m["workspace_role"],
                "is_available": m["is_available"],
                "last_seen_at": (seen.get(email) or {"last_seen_at": None})["last_seen_at"],
                "hf_plan": plans.get(norm_email(email)),
                "group_id": m["group_id"],
                "projects": roles_by_uid.get(uid, {}) if uid else {},
                "usage": (
                    {"credits": round(used["credits"], 2), "count": used["count"], "unknown": used["unknown"]}
                    if used
                    else ({"credits": 0, "count": 0, "unknown": 0} if settings else None)
                ),
            }
        )
    if not settings:
        rows.sort(key=lambda r: (r["name"] or "").lower())
    return {
        "workspace_id": workspace_id or None,
        "cycle_start": settings["cycle_start"] if settings else None,
        "cycle_end": settings["cycle_end"] if settings else None,
        "rows": rows,
        "projects": projects,
        # 그룹 이름·한도·남은 양은 보기만 하는 사람에게도 준다(칸 표시용). 저장에 쓰는 원문은 credit 에만.
        "groups": [
            {k: g[k] for k in ("id", "name", "monthly_limit", "limit_period", "remaining", "member_count", "color")}
            for g in (settings["groups"] if settings else [])
        ],
        "credit": settings if (settings and with_credit) else None,
    }
