"""크레딧 풀 · 그룹 한도 — 워크스페이스 단위 설정과 대시보드 읽기 모델(Jay 결정 2026-09-10).

힉스필드가 서브 워크스페이스에 매달 충전하고(enterprise 는 이월) 작업자는 User Group 의 월 한도 안에서 쓴다.
**한도 강제는 힉스필드가 한다** — 여기서는 우리 대시보드가 그 구조를 알고 보여주기·경고만 한다.
힉스필드는 충전·그룹·배정을 알려주지 않으므로(status 에 칸 없음, CLI 명령 없음) 매니저가 손으로 적는다.

저장(모두 content DB 사이드카, `manage_schema._SCHEMA`):
  workspace_credit_plan          워크스페이스당 1행 — monthly_topup(설정값)·note·revision(낙관적 잠금)
  workspace_credit_group         그룹 — monthly_limit(NULL=∞)·base_month·base_balance(재기준점)
  workspace_credit_group_member  이메일 → 그룹(워크스페이스당 이메일 1개 = 힉스필드 Members 와 같은 키.
                                 팩트 account_email 과 직결되고 uid 위조와 무관)
  workspace_balance_daily(코어)   에이전트 status 보고 때 하루 한 행(잔액 관측) — 추이 그래프용

이월 계산(그룹): remaining = base_balance + limit × (base_month~이번 달 개월 수) − base_month 이후 사용 합.
**재기준화(코덱스 P2)**: 한도·배정이 바뀌면 과거가 소급되지 않게 저장 시점에 base_month=이번 달,
base_balance 를 "저장 직전 남은 양이 그대로 이어지도록" 다시 잡는다(remaining_override 가 있으면 그 값으로).
사용량은 팩트(`manage_db.workspace_email_usage`) — 삭제분(tombstone) 포함, 크레딧 = COALESCE(실제, 견적, 0),
미상(둘 다 없음) 건수는 따로 세어 '추정' 표시 근거로 준다. 월 경계는 팩트 created_at 의 localtime(서버 KST).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Optional

_CLIENT_ID_RE = re.compile(r"[0-9a-f]{32}")  # 클라이언트가 새 그룹에 미리 붙이는 id(uuid hex) 형식

from ..db import get_connection
from ..emailnorm import norm_email
from ._common import _email_localpart
from .manage_schema import _ensure_schema


class CreditPlanConflict(Exception):
    """다른 곳에서 먼저 저장됨(revision 불일치) — 라우터가 409 로 바꾼다."""


def current_month() -> str:
    """'YYYY-MM' — 서버 OS 시간대(팀 표준시 KST, SERVER.md). 팩트 월 집계의 localtime 과 같은 시계."""
    return datetime.now().strftime("%Y-%m")


def months_inclusive(base_month: str, month: str) -> int:
    """base_month 부터 month 까지 포함 개월 수. base 가 미래면 0."""
    try:
        by, bm = (int(x) for x in base_month.split("-")[:2])
        y, m = (int(x) for x in month.split("-")[:2])
    except (ValueError, AttributeError):
        return 0
    return max(0, (y - by) * 12 + (m - bm) + 1)


def _usage_index(workspace_id: str, month_from: str) -> dict[tuple[str, str], dict[str, Any]]:
    """{(month, email): {credits, count, unknown}} — 팩트 한 스냅샷(지연 import: manage_db 는 다른 DB)."""
    from .. import manage_db

    rows = manage_db.workspace_email_usage(workspace_id, month_from)
    return {(r["month"], r["email"]): r for r in rows}


def _sum_usage(
    usage: dict[tuple[str, str], dict[str, Any]],
    emails: set[str],
    *,
    month: Optional[str] = None,
    month_from: Optional[str] = None,
    before_month: Optional[str] = None,
) -> tuple[float, int]:
    """(크레딧 합, 미상 건수) — month 는 그 달만, month_from 은 그 달 이후, before_month 는 그 달 전까지."""
    credits = 0.0
    unknown = 0
    for (mo, email), r in usage.items():
        if email not in emails:
            continue
        if month is not None and mo != month:
            continue
        if month_from is not None and mo < month_from:
            continue
        if before_month is not None and mo >= before_month:
            continue
        credits += float(r["credits"] or 0)
        unknown += int(r["unknown"] or 0)
    return credits, unknown


def _group_remaining(
    group: dict[str, Any], emails: set[str], usage: dict, month: str
) -> tuple[Optional[float], int]:
    """(남은 양(이월 포함) 또는 None(∞), base 이후 미상 수)."""
    limit = group.get("monthly_limit")
    used_since, unknown_since = _sum_usage(usage, emails, month_from=group["base_month"])
    if limit is None:
        return None, unknown_since
    months = months_inclusive(group["base_month"], month)
    return float(group["base_balance"] or 0) + float(limit) * months - used_since, unknown_since


def _carry_in(group: dict[str, Any], emails: set[str], usage: dict, month: str) -> float:
    """이번 달 시작 시점에 넘어온 양(이월분) — base_month 부터 지난달까지, **옛 소속·옛 한도**로. ∞ 는 0.
    재기준화의 근거: 이번 달 사용은 항상 현재 소속·현재 한도로 다시 세고, 과거 달은 소급하지 않는다."""
    limit = group.get("monthly_limit")
    if limit is None:
        return 0.0
    months_before = max(0, months_inclusive(group["base_month"], month) - 1)
    used_before, _ = _sum_usage(usage, emails, month_from=group["base_month"], before_month=month)
    return float(group["base_balance"] or 0) + float(limit) * months_before - used_before


def _load(conn, workspace_id: str) -> tuple[Optional[dict], list[dict], dict[str, set[str]]]:
    """(plan 행, 그룹 행 목록(정렬), {group_id: 이메일 집합})."""
    plan_row = conn.execute(
        "SELECT * FROM workspace_credit_plan WHERE workspace_id=?", (workspace_id,)
    ).fetchone()
    groups = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM workspace_credit_group WHERE workspace_id=? ORDER BY sort_order, created_at, name",
            (workspace_id,),
        ).fetchall()
    ]
    members: dict[str, set[str]] = {g["id"]: set() for g in groups}
    for r in conn.execute(
        "SELECT account_email, group_id FROM workspace_credit_group_member WHERE workspace_id=?",
        (workspace_id,),
    ).fetchall():
        members.setdefault(r["group_id"], set()).add(r["account_email"])
    return (dict(plan_row) if plan_row else None), groups, members


def _month_from_for(groups: list[dict], month: str) -> str:
    return min([g["base_month"] for g in groups if g.get("base_month")] + [month])


def _workspace_row(conn, workspace_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT id, name, credits, last_seen_at FROM workspace_registry WHERE id=?", (workspace_id,)
    ).fetchone()
    return dict(row) if row else None


# ── 설정(매니저) ───────────────────────────────────────────────────────────────
def get_settings(workspace_id: str) -> dict[str, Any]:
    """프로젝트 설정 창용 — 플랜·그룹(현재 남은 양 포함)·멤버(이메일 기준, 접근 불가·과거 배정도 포함)."""
    month = current_month()
    with get_connection() as conn:
        _ensure_schema(conn)
        plan, groups, members = _load(conn, workspace_id)
        rows = conn.execute(
            "SELECT m.account_email AS email, m.is_available, m.user_role, "
            "COALESCE(NULLIF(c.name,''), NULLIF(a.name,'')) AS name "
            "FROM workspace_member m "
            "LEFT JOIN account a ON a.email=m.account_email "
            "LEFT JOIN creator c ON c.uid=COALESCE(m.creator_uid, a.creator_uid) "
            "WHERE m.workspace_id=? ORDER BY m.is_available DESC, name COLLATE NOCASE, m.account_email",
            (workspace_id,),
        ).fetchall()
    usage = _usage_index(workspace_id, _month_from_for(groups, month))
    assigned: dict[str, str] = {}
    for gid, emails in members.items():
        for email in emails:
            assigned[email] = gid
    member_list: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        email = r["email"]
        seen.add(email)
        member_list.append(
            {
                "email": email,
                "name": r["name"] or _email_localpart(email),
                "workspace_role": r["user_role"],
                "is_available": bool(r["is_available"]),
                "group_id": assigned.get(email),
            }
        )
    for email, gid in sorted(assigned.items()):
        if email not in seen:  # 등록부에서 사라진 과거 배정 — 화면에 남겨 전체 교체 때 지워지지 않게(코덱스 P2)
            member_list.append(
                {"email": email, "name": _email_localpart(email), "workspace_role": None,
                 "is_available": False, "group_id": gid}
            )
    return {
        "workspace_id": workspace_id,
        "month": month,
        "plan": {
            "monthly_topup": plan["monthly_topup"] if plan else None,
            "note": plan["note"] if plan else None,
            "revision": int(plan["revision"]) if plan else 0,
            "updated_at": plan["updated_at"] if plan else None,
        },
        "groups": [_group_summary(g, members.get(g["id"], set()), usage, month) for g in groups],
        "members": member_list,
    }


def _group_summary(group: dict, emails: set[str], usage: dict, month: str) -> dict[str, Any]:
    used_month, unknown_month = _sum_usage(usage, emails, month=month)
    remaining, unknown_since = _group_remaining(group, emails, usage, month)
    return {
        "id": group["id"],
        "name": group["name"],
        "monthly_limit": group.get("monthly_limit"),
        "base_month": group.get("base_month"),
        "base_balance": group.get("base_balance"),
        "member_count": len(emails),
        "used_month": round(used_month),
        "unknown_month": unknown_month,
        "remaining": None if remaining is None else round(remaining),
        "unknown_since_base": unknown_since,
        "estimated": unknown_since > 0,
    }


def save_settings(
    workspace_id: str,
    *,
    revision: int,
    monthly_topup: Optional[int],
    note: Optional[str],
    groups: list[dict[str, Any]],
    members: list[dict[str, Any]],
) -> dict[str, Any]:
    """전체 저장(한 트랜잭션). revision 이 현재와 다르면 CreditPlanConflict(409).

    groups: [{id?, name, monthly_limit|None, remaining_override?}] — 목록에 없는 기존 그룹은 삭제(배정도 삭제).
    id 가 없거나 모르는 uuid hex 면 새 그룹(클라이언트가 미리 붙인 id 로 같은 저장에 멤버 배정 가능).
    members: [{email, group_id|None}] — **적힌 이메일만** 바꾼다(None=배정 해제). 안 적힌 이메일은 그대로(코덱스 P2).
    group_id 는 이 워크스페이스 그룹이어야 한다(아니면 ValueError → 400).
    재기준화(코덱스 P2 — 과거 소급 금지): 한도나 소속이 바뀐 그룹은 base_month=이번 달로 옮기고 base_balance 에
    "이번 달로 넘어온 이월분"(`_carry_in`, 옛 소속·옛 한도로 지난달까지 계산)을 넣는다. 그러면 지난달까지는 그대로,
    이번 달은 현재 소속·현재 한도로 다시 센다(예: 이번 달 한도 1000→2000 이면 남은 양 +1000, 이번 달에 들어온
    사람의 이번 달 사용은 새 그룹에 잡힘). remaining_override 가 있으면 지금 남은 양이 그 값이 되게 잡는다.
    ∞→한도 전환·새 그룹은 이월분 0 에서 시작."""
    month = current_month()
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        plan, old_groups, old_members = _load(conn, workspace_id)
        cur_rev = int(plan["revision"]) if plan else 0
        if int(revision or 0) != cur_rev:
            raise CreditPlanConflict(f"revision {revision} != {cur_rev}")
        old_by_id = {g["id"]: g for g in old_groups}
        usage = _usage_index(workspace_id, _month_from_for(old_groups, month))

        # 1) 새 소속표 = 기존 배정에 요청의 변경만 덮는다.
        new_assign: dict[str, str] = {}
        for gid, emails in old_members.items():
            for email in emails:
                new_assign[email] = gid
        incoming_ids = {str(g.get("id")) for g in groups if g.get("id")}
        # 이 저장에서 새로 만드는 그룹은 id 를 미리 발급해 배정이 같이 들어올 수 있게 한다.
        prepared: list[dict[str, Any]] = []
        for order, g in enumerate(groups):
            name = str(g.get("name") or "").strip()
            if not name:
                raise ValueError("그룹 이름이 비었습니다")
            gid = str(g.get("id") or "").strip()
            if gid and gid not in old_by_id:
                # 새 그룹에 클라이언트가 미리 붙인 id — 같은 저장에 멤버 배정을 싣기 위해(설정 창의 그룹 편집 모달).
                # 형식이 uuid hex 가 아니거나 이미 다른 워크스페이스가 쓰는 id 면 거부(코덱스 P1 — 소유 검증).
                if not _CLIENT_ID_RE.fullmatch(gid):
                    raise ValueError("그룹 id 형식이 올바르지 않습니다")
                if conn.execute("SELECT 1 FROM workspace_credit_group WHERE id=?", (gid,)).fetchone():
                    raise ValueError("이 워크스페이스의 그룹이 아닙니다")
            if not gid:
                gid = uuid.uuid4().hex
            limit = g.get("monthly_limit")
            limit = None if limit is None else max(0, int(limit))
            prepared.append(
                {"id": gid, "name": name, "monthly_limit": limit, "sort_order": order,
                 "remaining_override": g.get("remaining_override"), "is_new": gid not in old_by_id}
            )
        valid_ids = {p["id"] for p in prepared}
        if len({p["name"] for p in prepared}) != len(prepared):
            raise ValueError("그룹 이름이 겹칩니다")
        for m in members:
            email = norm_email(str(m.get("email") or ""))
            if not email:
                continue
            gid = m.get("group_id")
            if gid is None or gid == "":
                new_assign.pop(email, None)
                continue
            if str(gid) not in valid_ids:
                raise ValueError("이 워크스페이스의 그룹이 아닙니다")
            new_assign[email] = str(gid)
        # 삭제되는 그룹의 배정은 함께 사라진다.
        for email in [e for e, gid in new_assign.items() if gid not in valid_ids]:
            new_assign.pop(email, None)
        new_members: dict[str, set[str]] = {p["id"]: set() for p in prepared}
        for email, gid in new_assign.items():
            new_members[gid].add(email)

        # 2) 그룹 삭제를 먼저, 남는 그룹은 이름을 임시값으로 비워 UNIQUE(workspace_id, name) 충돌을 피한다 —
        #    삭제 뒤 같은 이름으로 다시 만들기·두 그룹 이름 맞바꾸기가 500 으로 죽지 않게(코덱스 P2).
        for gid in set(old_by_id) - valid_ids:
            conn.execute("DELETE FROM workspace_credit_group WHERE id=?", (gid,))
        for gid in valid_ids & set(old_by_id):
            conn.execute("UPDATE workspace_credit_group SET name=? WHERE id=?", (f"\x00{gid}", gid))
        # 3) 그룹 upsert + 재기준화
        for p in prepared:
            gid = p["id"]
            emails_new = new_members[gid]
            limit = p["monthly_limit"]
            used_month_new, _ = _sum_usage(usage, emails_new, month=month)
            old = old_by_id.get(gid)
            changed = (
                old is None
                or old.get("monthly_limit") != limit
                or old_members.get(gid, set()) != emails_new
            )
            override = p["remaining_override"]
            if old is not None and not changed and override is None:
                conn.execute(
                    "UPDATE workspace_credit_group SET name=?, sort_order=? WHERE id=?",
                    (p["name"], p["sort_order"], gid),
                )
                continue
            base_month = month
            if limit is None:
                base_balance = 0
            elif override is not None:
                base_balance = round(float(override) - float(limit) + used_month_new)
            else:  # 이월분만 넘기고 이번 달은 새 소속·새 한도로 다시 센다. 새 그룹·∞→한도는 이월 0.
                base_balance = round(_carry_in(old, old_members.get(gid, set()), usage, month)) if old else 0
            if old is None:
                conn.execute(
                    "INSERT INTO workspace_credit_group(id, workspace_id, name, monthly_limit, base_month, "
                    "base_balance, sort_order) VALUES(?,?,?,?,?,?,?)",
                    (gid, workspace_id, p["name"], limit, base_month, base_balance, p["sort_order"]),
                )
            else:
                conn.execute(
                    "UPDATE workspace_credit_group SET name=?, monthly_limit=?, base_month=?, base_balance=?, "
                    "sort_order=? WHERE id=?",
                    (p["name"], limit, base_month, base_balance, p["sort_order"], gid),
                )
        # 4) 배정 전체 재기록(이 워크스페이스만)
        conn.execute("DELETE FROM workspace_credit_group_member WHERE workspace_id=?", (workspace_id,))
        conn.executemany(
            "INSERT INTO workspace_credit_group_member(workspace_id, account_email, group_id) VALUES(?,?,?)",
            [(workspace_id, email, gid) for email, gid in sorted(new_assign.items())],
        )
        # 5) 플랜 + revision
        topup = None if monthly_topup is None else max(0, int(monthly_topup))
        conn.execute(
            "INSERT INTO workspace_credit_plan(workspace_id, monthly_topup, note, revision, updated_at) "
            "VALUES(?,?,?,?,datetime('now')) "
            "ON CONFLICT(workspace_id) DO UPDATE SET monthly_topup=excluded.monthly_topup, note=excluded.note, "
            "revision=workspace_credit_plan.revision+1, updated_at=excluded.updated_at",
            (workspace_id, topup, (note or "").strip() or None, cur_rev + 1),
        )
    return get_settings(workspace_id)


# ── 대시보드 읽기 ─────────────────────────────────────────────────────────────
def plan_view(workspace_id: str, viewer: Optional[tuple[str, str]] = None) -> dict[str, Any]:
    """대시보드 카드. viewer=None(매니저): 풀·그룹 전체·미배정·잔액 이력. viewer=(uid, email)(일반 멤버):
    자기 그룹 하나(합계·그중 내 사용)만 — 다른 그룹·이메일·풀 잔액·이력은 주지 않는다."""
    month = current_month()
    with get_connection() as conn:
        _ensure_schema(conn)
        plan, groups, members = _load(conn, workspace_id)
        ws = _workspace_row(conn, workspace_id)
        available = {
            r["account_email"]
            for r in conn.execute(
                "SELECT account_email FROM workspace_member WHERE workspace_id=? AND is_available=1",
                (workspace_id,),
            ).fetchall()
        }
        history = [
            {"day": r["day"], "credits": r["credits"], "first_credits": r["first_credits"]}
            for r in conn.execute(
                "SELECT day, credits, first_credits FROM workspace_balance_daily WHERE workspace_id=? "
                "AND day >= date('now','localtime','-60 days') ORDER BY day",
                (workspace_id,),
            ).fetchall()
        ] if viewer is None else []
    configured = plan is not None or bool(groups)
    usage = _usage_index(workspace_id, _month_from_for(groups, month))

    if viewer is not None:
        email = viewer[1]
        mine = next((g for g in groups if email in members.get(g["id"], set())), None)
        out: dict[str, Any] = {"month": month, "configured": configured, "my_group": None}
        if mine is not None:
            summary = _group_summary(mine, members[mine["id"]], usage, month)
            my_used, my_unknown = _sum_usage(usage, {email}, month=month)
            summary.pop("base_balance", None)
            summary.pop("base_month", None)
            summary["my_used_month"] = round(my_used)
            summary["my_unknown_month"] = my_unknown
            out["my_group"] = summary
        return out

    assigned_emails = set().union(*members.values()) if members else set()
    all_emails = {email for (_, email) in usage.keys()} | available
    unassigned_emails = {e for e in all_emails if e not in assigned_emails}
    un_used, un_unknown = _sum_usage(usage, unassigned_emails, month=month)
    used_month, unknown_month = _sum_usage(usage, all_emails | assigned_emails, month=month)
    month_start = next((h for h in history if h["day"] >= f"{month}-01"), None)
    return {
        "month": month,
        "configured": configured,
        "pool": {
            "monthly_topup": plan["monthly_topup"] if plan else None,
            "note": plan["note"] if plan else None,
            "used_month": round(used_month),
            "unknown_month": unknown_month,
            "balance": ws["credits"] if ws else None,
            "balance_seen_at": ws["last_seen_at"] if ws else None,
            # 월초 잔액 = 이번 달 첫 관측일의 **첫** 관측값(같은 날 후속 보고로 안 바뀜 — 코덱스 P2). 관측이 없으면 None.
            "month_start_balance": month_start["first_credits"] if month_start else None,
            "month_start_day": month_start["day"] if month_start else None,
        },
        "groups": [_group_summary(g, members.get(g["id"], set()), usage, month) for g in groups],
        "unassigned": {
            "member_count": len([e for e in available if e not in assigned_emails]),
            "used_month": round(un_used),
            "unknown_month": un_unknown,
        },
        "history": [{"day": h["day"], "credits": h["credits"]} for h in history],
    }
