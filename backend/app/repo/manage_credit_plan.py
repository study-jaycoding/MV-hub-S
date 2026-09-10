"""크레딧 풀 · 그룹 한도 · 긴급 충전 — 워크스페이스 단위 설정과 대시보드 읽기 모델(Jay 결정 2026-09-10).

힉스필드가 서브 워크스페이스에 매달 충전하고(enterprise 는 이월) 작업자는 User Group 의 한도 안에서 쓴다.
**한도 강제는 힉스필드가 한다** — 여기서는 우리 대시보드가 그 구조를 알고 보여주기·경고만 한다.
힉스필드는 충전·그룹·배정을 알려주지 않으므로(status 에 칸 없음, CLI 명령 없음) 매니저가 손으로 적는다.

저장(모두 content DB 사이드카, `manage_schema._SCHEMA`):
  workspace_credit_plan          워크스페이스당 1행 — note·**topup_day**(매월 충전 기준일 1~28)·revision(낙관적 잠금).
                                 **월 충전액은 저장하지 않는다** — 프로젝트들의 '예산 한도(매월)' 합에서 파생(Jay: 같은 값).
  workspace_credit_group         그룹 — monthly_limit(NULL=∞)·limit_period(day/week/month)·base_start·base_balance(재기준점)
  workspace_credit_group_member  이메일 → 그룹(워크스페이스당 이메일 1개 = 힉스필드 Members 와 같은 키.
                                 팩트 account_email 과 직결되고 uid 위조와 무관)
  workspace_credit_topup         긴급 충전 기록 — day·credits·note (정기 충전 밖의 추가 충전, 손 입력)
  workspace_balance_daily(코어)   에이전트 status 보고 때 하루 한 행(잔액 관측) — 추이 그래프용

달 경계 = 충전 기준일(topup_day): 기준일 15 이면 9/15~10/14 가 '이번 달'. 예산 '매월'(manage_db._period_conditions)·
그룹 이월·풀 카드의 이번 달 사용·긴급 충전 합·월초 잔액이 모두 이 경계를 쓴다. 주 = 월요일 시작, 일 = 그날.
이월 계산(그룹, 세 주기 공통 — enterprise 는 일·주·월 어느 주기든 안 쓴 양이 넘어간다, Jay):
  remaining = base_balance + limit × (base_start 가 속한 기간 ~ 이번 기간 개수) − base_start 이후 사용 합.
**재기준화(코덱스 P2)**: 한도·주기·소속이 바뀌면 과거가 소급되지 않게 저장 시점에 base_start=이번 기간 시작,
base_balance=이번 기간으로 넘어온 이월분(옛 소속·옛 한도로 지난 기간까지)으로 다시 잡는다(remaining_override 가
있으면 지금 남은 양이 그 값이 되게). 사용량은 팩트(`manage_db.workspace_email_usage`, 날짜×이메일) — 삭제분(tombstone)
포함, 크레딧 = COALESCE(실제, 견적, 0), 미상(둘 다 없음) 건수는 따로 세어 '추정' 표시 근거로 준다.
날짜는 팩트 created_at 의 localtime(서버 KST).
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Optional

from ..db import get_connection
from ..emailnorm import norm_email
from ._common import _email_localpart
from .manage_schema import _ensure_schema

_CLIENT_ID_RE = re.compile(r"[0-9a-f]{32}")  # 클라이언트가 새 그룹·충전 기록에 미리 붙이는 id(uuid hex) 형식
_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_PERIODS = ("day", "week", "month")

Usage = dict[tuple[str, str], dict[str, Any]]  # {(day 'YYYY-MM-DD', email): {credits, count, unknown}}


class CreditPlanConflict(Exception):
    """다른 곳에서 먼저 저장됨(revision 불일치) — 라우터가 409 로 바꾼다."""


# ── 달력 ──────────────────────────────────────────────────────────────────────
def today_local() -> str:
    """'YYYY-MM-DD' — 서버 OS 시간대(팀 표준시 KST, SERVER.md). 팩트 날짜 집계의 localtime 과 같은 시계."""
    return datetime.now().strftime("%Y-%m-%d")


def current_month() -> str:
    return today_local()[:7]


def _d(day: str) -> date:
    return date.fromisoformat(day)


def _clamp_anchor(anchor: Any) -> int:
    try:
        value = int(anchor or 1)
    except (TypeError, ValueError):
        return 1
    return value if 1 <= value <= 28 else 1


def period_start(day: str, period: str, anchor: int = 1) -> str:
    """day 가 속한 기간의 시작일 — day 그날 / week 월요일 / month 이번 '충전 달'의 기준일
    (anchor=15 면 9/14 → 8/15, 9/15 → 9/15)."""
    d = _d(day)
    if period == "week":
        return (d - timedelta(days=d.weekday())).isoformat()
    if period == "month":
        a = _clamp_anchor(anchor)
        if d.day >= a:
            return d.replace(day=a).isoformat()
        prev = d.replace(day=1) - timedelta(days=1)
        return prev.replace(day=a).isoformat()
    return d.isoformat()


def period_end(day: str, period: str, anchor: int = 1) -> str:
    """day 가 속한 기간의 마지막 날(포함)."""
    start = _d(period_start(day, period, anchor))
    if period == "day":
        return start.isoformat()
    if period == "week":
        return (start + timedelta(days=6)).isoformat()
    nxt = (start.replace(day=1) + timedelta(days=32)).replace(day=_clamp_anchor(anchor))
    return (nxt - timedelta(days=1)).isoformat()


def periods_inclusive(base_start: str, day: str, period: str, anchor: int = 1) -> int:
    """base_start 가 속한 기간부터 day 가 속한 기간까지 포함 개수. base 가 미래면 0."""
    try:
        b = _d(period_start(base_start, period, anchor))
        t = _d(period_start(day, period, anchor))
    except ValueError:
        return 0
    if b > t:
        return 0
    if period == "day":
        return (t - b).days + 1
    if period == "week":
        return (t - b).days // 7 + 1
    return (t.year - b.year) * 12 + (t.month - b.month) + 1


def months_inclusive(base_month: str, month: str) -> int:
    """(호환) 'YYYY-MM' 두 달 사이 포함 개월 수."""
    return periods_inclusive(f"{base_month}-01", f"{month}-01", "month")


# ── 팩트 사용량 ───────────────────────────────────────────────────────────────
def _usage_index(workspace_id: str, day_from: str) -> Usage:
    """{(day, email): {credits, count, unknown}} — 팩트 한 스냅샷(지연 import: manage_db 는 다른 DB)."""
    from .. import manage_db

    rows = manage_db.workspace_email_usage(workspace_id, day_from)
    return {(r["day"], r["email"]): r for r in rows}


def _sum_usage(
    usage: Usage,
    emails: set[str],
    *,
    day_from: Optional[str] = None,
    before_day: Optional[str] = None,
) -> tuple[float, int]:
    """(크레딧 합, 미상 건수) — day_from 이후(포함), before_day 전(미포함)."""
    credits = 0.0
    unknown = 0
    for (day, email), r in usage.items():
        if email not in emails:
            continue
        if day_from is not None and day < day_from:
            continue
        if before_day is not None and day >= before_day:
            continue
        credits += float(r["credits"] or 0)
        unknown += int(r["unknown"] or 0)
    return credits, unknown


def _group_period(group: dict[str, Any]) -> str:
    period = str(group.get("limit_period") or "month")
    return period if period in _PERIODS else "month"


def _group_remaining(
    group: dict[str, Any], emails: set[str], usage: Usage, today: str, anchor: int
) -> tuple[Optional[float], int]:
    """(남은 양(이월 포함) 또는 None(∞), base 이후 미상 수)."""
    limit = group.get("monthly_limit")
    base = group["base_start"]
    used_since, unknown_since = _sum_usage(usage, emails, day_from=base)
    if limit is None:
        return None, unknown_since
    n = periods_inclusive(base, today, _group_period(group), anchor)
    return float(group["base_balance"] or 0) + float(limit) * n - used_since, unknown_since


def _carry_in(group: dict[str, Any], emails: set[str], usage: Usage, today: str, anchor: int) -> float:
    """이번 기간 시작 시점에 넘어온 양(이월분) — base 부터 지난 기간까지, **옛 소속·옛 한도·옛 주기**로. ∞ 는 0.
    재기준화의 근거: 이번 기간 사용은 항상 현재 소속·현재 한도로 다시 세고, 과거 기간은 소급하지 않는다."""
    limit = group.get("monthly_limit")
    if limit is None:
        return 0.0
    period = _group_period(group)
    cur_start = period_start(today, period, anchor)
    periods_before = max(0, periods_inclusive(group["base_start"], today, period, anchor) - 1)
    used_before, _ = _sum_usage(usage, emails, day_from=group["base_start"], before_day=cur_start)
    return float(group["base_balance"] or 0) + float(limit) * periods_before - used_before


# ── 저장소 읽기 ───────────────────────────────────────────────────────────────
def _load(conn, workspace_id: str) -> tuple[Optional[dict], list[dict], dict[str, set[str]], list[dict]]:
    """(plan 행, 그룹 행 목록(정렬), {group_id: 이메일 집합}, 긴급 충전 기록(최근순))."""
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
    for g in groups:  # 옛 행(달 단위 base_month 만 있음) 호환 — 그 달 1일을 기준일로
        if not g.get("base_start"):
            g["base_start"] = f"{g.get('base_month') or current_month()}-01"
    members: dict[str, set[str]] = {g["id"]: set() for g in groups}
    for r in conn.execute(
        "SELECT account_email, group_id FROM workspace_credit_group_member WHERE workspace_id=?",
        (workspace_id,),
    ).fetchall():
        members.setdefault(r["group_id"], set()).add(r["account_email"])
    topups = [
        dict(r)
        for r in conn.execute(
            "SELECT id, day, credits, note, created_at FROM workspace_credit_topup WHERE workspace_id=? "
            "ORDER BY day DESC, created_at DESC",
            (workspace_id,),
        ).fetchall()
    ]
    return (dict(plan_row) if plan_row else None), groups, members, topups


def _plan_anchor(plan: Optional[dict]) -> int:
    return _clamp_anchor(plan.get("topup_day") if plan else 1)


def _monthly_budget(conn, workspace_id: str) -> Optional[int]:
    """월 충전액 = 이 워크스페이스 프로젝트들의 '예산 한도(주기=매월)' 합. 매월 예산이 하나도 없으면 None.
    (Jay: 예산 한도와 월 충전은 같은 값 — 칸 하나만 두고 파생한다. 하루·한 주 주기는 안 센다.)"""
    row = conn.execute(
        "SELECT SUM(pp.budget_credits) AS total, COUNT(pp.budget_credits) AS n FROM project_planning pp "
        "JOIN project p ON p.id=pp.project_id "
        "WHERE p.workspace_id=? AND p.archived=0 AND pp.budget_period='month' AND pp.budget_credits IS NOT NULL",
        (workspace_id,),
    ).fetchone()
    if not row or not row["n"]:
        return None
    return int(row["total"] or 0)


def _day_from_for(groups: list[dict], cycle_start: str) -> str:
    """팩트를 읽을 시작일 — 그룹 base 중 가장 이른 날과 이번 충전 달 시작 중 이른 것(미배정 '이번 달' 합에도 필요)."""
    return min([g["base_start"] for g in groups if g.get("base_start")] + [cycle_start])


def _workspace_row(conn, workspace_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT id, name, credits, last_seen_at FROM workspace_registry WHERE id=?", (workspace_id,)
    ).fetchone()
    return dict(row) if row else None


def _topup_summary(topups: list[dict], cycle_start: str, cycle_end: str) -> dict[str, Any]:
    mine = [t for t in topups if cycle_start <= str(t["day"]) <= cycle_end]
    return {"count": len(mine), "credits": int(sum(int(t["credits"] or 0) for t in mine))}


def _group_summary(group: dict, emails: set[str], usage: Usage, today: str, anchor: int) -> dict[str, Any]:
    """그룹 한 줄 — 이번 기간 사용(used_period)·이번 충전 달 사용(used_month)·남은 양(이월 포함)·미상."""
    period = _group_period(group)
    cur_start = period_start(today, period, anchor)
    used_month, unknown_month = _sum_usage(usage, emails, day_from=period_start(today, "month", anchor))
    used_period, unknown_period = _sum_usage(usage, emails, day_from=cur_start)
    remaining, unknown_since = _group_remaining(group, emails, usage, today, anchor)
    return {
        "id": group["id"],
        "name": group["name"],
        "monthly_limit": group.get("monthly_limit"),
        "limit_period": period,
        "base_start": group.get("base_start"),
        "base_balance": group.get("base_balance"),
        "member_count": len(emails),
        "used_month": round(used_month),
        "unknown_month": unknown_month,
        "used_period": round(used_period),
        "unknown_period": unknown_period,
        "remaining": None if remaining is None else round(remaining),
        "unknown_since_base": unknown_since,
        "estimated": unknown_since > 0,
    }


# ── 설정(매니저) ───────────────────────────────────────────────────────────────
def get_settings(workspace_id: str) -> dict[str, Any]:
    """프로젝트 설정 창용 — 플랜·그룹(현재 남은 양 포함)·멤버(이메일 기준, 접근 불가·과거 배정도 포함)·긴급 충전 기록."""
    today = today_local()
    with get_connection() as conn:
        _ensure_schema(conn)
        plan, groups, members, topups = _load(conn, workspace_id)
        monthly_topup = _monthly_budget(conn, workspace_id)
        rows = conn.execute(
            "SELECT m.account_email AS email, m.is_available, m.user_role, "
            "COALESCE(NULLIF(c.name,''), NULLIF(a.name,'')) AS name "
            "FROM workspace_member m "
            "LEFT JOIN account a ON a.email=m.account_email "
            "LEFT JOIN creator c ON c.uid=COALESCE(m.creator_uid, a.creator_uid) "
            "WHERE m.workspace_id=? ORDER BY m.is_available DESC, name COLLATE NOCASE, m.account_email",
            (workspace_id,),
        ).fetchall()
    anchor = _plan_anchor(plan)
    cycle_start = period_start(today, "month", anchor)
    usage = _usage_index(workspace_id, _day_from_for(groups, cycle_start))
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
        "month": today[:7],
        "today": today,
        "cycle_start": cycle_start,
        "cycle_end": period_end(today, "month", anchor),
        "plan": {
            "monthly_topup": monthly_topup,  # 파생값(예산 한도 매월 합) — 설정 창은 읽기만
            "topup_day": anchor,
            "note": plan["note"] if plan else None,
            "revision": int(plan["revision"]) if plan else 0,
            "updated_at": plan["updated_at"] if plan else None,
        },
        "groups": [_group_summary(g, members.get(g["id"], set()), usage, today, anchor) for g in groups],
        "members": member_list,
        "topups": [{"id": t["id"], "day": t["day"], "credits": int(t["credits"] or 0), "note": t["note"]} for t in topups],
    }


def _prepare_topups(topups: list[dict[str, Any]], existing_ids: set[str]) -> list[tuple[str, str, int, Optional[str]]]:
    """긴급 충전 입력 검증 → (id, day, credits, note). day 는 YYYY-MM-DD, credits 는 양의 정수."""
    out: list[tuple[str, str, int, Optional[str]]] = []
    seen: set[str] = set()
    for t in topups:
        day = str(t.get("day") or "").strip()
        if not _DAY_RE.fullmatch(day):
            raise ValueError("충전 날짜는 YYYY-MM-DD 로 적어 주세요")
        try:
            credits = int(t.get("credits"))
        except (TypeError, ValueError):
            raise ValueError("충전 크레딧은 정수로 적어 주세요") from None
        if credits <= 0:
            raise ValueError("충전 크레딧은 0 보다 커야 합니다")
        tid = str(t.get("id") or "").strip()
        if tid and tid not in existing_ids and not _CLIENT_ID_RE.fullmatch(tid):
            raise ValueError("충전 기록 id 형식이 올바르지 않습니다")
        if not tid:
            tid = uuid.uuid4().hex
        if tid in seen:
            raise ValueError("충전 기록 id 가 겹칩니다")
        seen.add(tid)
        note = str(t.get("note") or "").strip() or None
        out.append((tid, day, credits, note))
    return out


def save_settings(
    workspace_id: str,
    *,
    revision: int,
    note: Optional[str],
    groups: Optional[list[dict[str, Any]]],
    members: Optional[list[dict[str, Any]]] = None,
    topups: Optional[list[dict[str, Any]]] = None,
    topup_day: Optional[int] = None,
) -> dict[str, Any]:
    """전체 저장(한 트랜잭션). revision 이 현재와 다르면 CreditPlanConflict(409).

    topup_day: 매월 충전 기준일(1~28) · None 이면 그대로. 바뀌면 달 경계가 바뀌므로 매월 한도 그룹은 재기준화된다.
    groups=None 이면 그룹·배정은 **그대로 두고** 긴급 충전 기록(topups)·note·topup_day 만 바꾼다(설정 창의 줄 단위 저장 —
    편집 중인 그룹 초안을 건드리지 않게). members 는 groups 와 함께일 때만 뜻이 있다.
    groups: [{id?, name, monthly_limit|None, limit_period?, remaining_override?}] — 목록에 없는 기존 그룹은 삭제(배정도 삭제).
    id 가 없거나 모르는 uuid hex 면 새 그룹(클라이언트가 미리 붙인 id 로 같은 저장에 멤버 배정 가능).
    members: [{email, group_id|None}] — **적힌 이메일만** 바꾼다(None=배정 해제). 안 적힌 이메일은 그대로(코덱스 P2).
    group_id 는 이 워크스페이스 그룹이어야 한다(아니면 ValueError → 400).
    topups: [{id?, day, credits, note?}] — 긴급 충전 기록 전체 교체(None 이면 그대로 둔다).
    재기준화(코덱스 P2 — 과거 소급 금지): 한도·주기·소속(·달 경계)이 바뀐 그룹은 base_start=이번 기간 시작으로 옮기고
    base_balance 에 "이번 기간으로 넘어온 이월분"(`_carry_in`, 옛 규칙으로 지난 기간까지 계산)을 넣는다. 그러면
    지난 기간까지는 그대로, 이번 기간은 현재 소속·한도로 다시 센다. remaining_override 가 있으면 지금 남은 양이
    그 값이 되게 잡는다(대시보드 '추정' → 힉스필드 값 맞추기). ∞→한도 전환·새 그룹은 이월분 0 에서 시작."""
    today = today_local()
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        plan, old_groups, old_members, old_topups = _load(conn, workspace_id)
        cur_rev = int(plan["revision"]) if plan else 0
        if int(revision or 0) != cur_rev:
            raise CreditPlanConflict(f"revision {revision} != {cur_rev}")
        old_anchor = _plan_anchor(plan)
        new_anchor = old_anchor if topup_day is None else _clamp_anchor(topup_day)
        if topup_day is not None and not 1 <= int(topup_day) <= 28:
            raise ValueError("충전 기준일은 1~28 사이여야 합니다")
        old_by_id = {g["id"]: g for g in old_groups}
        prepared_topups = (
            None if topups is None else _prepare_topups(topups, {t["id"] for t in old_topups})
        )
        if groups is None:  # 충전 기록·note·기준일만 — 그룹·배정은 손대지 않는다(달 경계가 바뀌면 매월 그룹만 재기준화)
            if new_anchor != old_anchor:
                _rebase_month_groups_for_anchor(conn, workspace_id, old_groups, old_members, today, old_anchor, new_anchor)
            _write_topups_and_plan(conn, workspace_id, prepared_topups, note, cur_rev, new_anchor)
            conn.execute("COMMIT")  # get_settings 는 새 커넥션으로 읽으므로 먼저 확정한다(컨텍스트 종료 commit 은 no-op)
            return get_settings(workspace_id)
        usage = _usage_index(workspace_id, _day_from_for(old_groups, period_start(today, "month", min(old_anchor, new_anchor))))

        # 1) 새 소속표 = 기존 배정에 요청의 변경만 덮는다.
        new_assign: dict[str, str] = {}
        for gid, emails in old_members.items():
            for email in emails:
                new_assign[email] = gid
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
            period = str(g.get("limit_period") or "month")
            if period not in _PERIODS:
                raise ValueError("한도 주기는 day·week·month 중 하나여야 합니다")
            prepared.append(
                {"id": gid, "name": name, "monthly_limit": limit, "limit_period": period, "sort_order": order,
                 "remaining_override": g.get("remaining_override"), "is_new": gid not in old_by_id}
            )
        valid_ids = {p["id"] for p in prepared}
        if len({p["name"] for p in prepared}) != len(prepared):
            raise ValueError("그룹 이름이 겹칩니다")
        for m in members or []:
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
            period = p["limit_period"]
            cur_start = period_start(today, period, new_anchor)
            used_period_new, _ = _sum_usage(usage, emails_new, day_from=cur_start)
            old = old_by_id.get(gid)
            changed = (
                old is None
                or old.get("monthly_limit") != limit
                or _group_period(old) != period
                or old_members.get(gid, set()) != emails_new
                or (period == "month" and new_anchor != old_anchor)
            )
            override = p["remaining_override"]
            if old is not None and not changed and override is None:
                conn.execute(
                    "UPDATE workspace_credit_group SET name=?, sort_order=? WHERE id=?",
                    (p["name"], p["sort_order"], gid),
                )
                continue
            if limit is None:
                base_balance = 0
            elif override is not None:
                base_balance = round(float(override) - float(limit) + used_period_new)
            elif old is not None and old.get("monthly_limit") is not None:
                # 이월분만 넘기고 이번 기간은 새 소속·새 한도·새 주기로 다시 센다(옛 주기·옛 달 경계로 지난 기간까지 계산).
                base_balance = round(_carry_in(old, old_members.get(gid, set()), usage, today, old_anchor))
            else:  # 새 그룹·∞→한도 전환은 이월 0 에서 시작
                base_balance = 0
            if old is None:
                conn.execute(
                    "INSERT INTO workspace_credit_group(id, workspace_id, name, monthly_limit, limit_period, "
                    "base_start, base_month, base_balance, sort_order) VALUES(?,?,?,?,?,?,?,?,?)",
                    (gid, workspace_id, p["name"], limit, period, cur_start, cur_start[:7], base_balance, p["sort_order"]),
                )
            else:
                conn.execute(
                    "UPDATE workspace_credit_group SET name=?, monthly_limit=?, limit_period=?, base_start=?, "
                    "base_month=?, base_balance=?, sort_order=? WHERE id=?",
                    (p["name"], limit, period, cur_start, cur_start[:7], base_balance, p["sort_order"], gid),
                )
        # 4) 배정 전체 재기록(이 워크스페이스만)
        conn.execute("DELETE FROM workspace_credit_group_member WHERE workspace_id=?", (workspace_id,))
        conn.executemany(
            "INSERT INTO workspace_credit_group_member(workspace_id, account_email, group_id) VALUES(?,?,?)",
            [(workspace_id, email, gid) for email, gid in sorted(new_assign.items())],
        )
        # 5) 긴급 충전 기록 전체 교체(요청에 있을 때만) + 6) 플랜·revision
        _write_topups_and_plan(conn, workspace_id, prepared_topups, note, cur_rev, new_anchor)
    return get_settings(workspace_id)


def _rebase_month_groups_for_anchor(
    conn, workspace_id: str, groups: list[dict], members: dict[str, set[str]], today: str, old_anchor: int, new_anchor: int
) -> None:
    """충전 기준일만 바뀐 저장(groups=None) — 매월 한도 그룹의 달 경계가 옮겨지므로 옛 경계로 이월분을 계산해
    새 경계의 이번 달 시작으로 재기준화한다(그룹·배정 자체는 그대로)."""
    month_groups = [g for g in groups if _group_period(g) == "month" and g.get("monthly_limit") is not None]
    if not month_groups:
        return
    usage = _usage_index(workspace_id, _day_from_for(month_groups, period_start(today, "month", min(old_anchor, new_anchor))))
    new_start = period_start(today, "month", new_anchor)
    for g in month_groups:
        carry = round(_carry_in(g, members.get(g["id"], set()), usage, today, old_anchor))
        conn.execute(
            "UPDATE workspace_credit_group SET base_start=?, base_month=?, base_balance=? WHERE id=?",
            (new_start, new_start[:7], carry, g["id"]),
        )


def _write_topups_and_plan(
    conn,
    workspace_id: str,
    prepared_topups: Optional[list[tuple[str, str, int, Optional[str]]]],
    note: Optional[str],
    cur_rev: int,
    topup_day: int,
) -> None:
    """긴급 충전 기록 전체 교체(None 이면 그대로) + 플랜 note·topup_day·revision+1. 호출측 트랜잭션 안에서."""
    if prepared_topups is not None:
        conn.execute("DELETE FROM workspace_credit_topup WHERE workspace_id=?", (workspace_id,))
        conn.executemany(
            "INSERT INTO workspace_credit_topup(id, workspace_id, day, credits, note) VALUES(?,?,?,?,?)",
            [(tid, workspace_id, day, credits, memo) for tid, day, credits, memo in prepared_topups],
        )
    conn.execute(
        "INSERT INTO workspace_credit_plan(workspace_id, note, topup_day, revision, updated_at) "
        "VALUES(?,?,?,?,datetime('now')) "
        "ON CONFLICT(workspace_id) DO UPDATE SET note=excluded.note, topup_day=excluded.topup_day, "
        "revision=workspace_credit_plan.revision+1, updated_at=excluded.updated_at",
        (workspace_id, (note or "").strip() or None, topup_day, cur_rev + 1),
    )


# ── 대시보드 읽기 ─────────────────────────────────────────────────────────────
def plan_view(workspace_id: str, viewer: Optional[tuple[str, str]] = None) -> dict[str, Any]:
    """대시보드 카드. viewer=None(매니저): 풀·그룹 전체·미배정·긴급 충전·잔액 이력·revision(추정 맞추기 저장용).
    viewer=(uid, email)(일반 멤버): 자기 그룹 하나(합계·그중 내 사용)만 — 다른 그룹·이메일·풀 잔액·충전·이력은 주지 않는다."""
    today = today_local()
    month = today[:7]
    with get_connection() as conn:
        _ensure_schema(conn)
        plan, groups, members, topups = _load(conn, workspace_id)
        monthly_topup = _monthly_budget(conn, workspace_id) if viewer is None else None
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
    anchor = _plan_anchor(plan)
    cycle_start = period_start(today, "month", anchor)
    cycle_end = period_end(today, "month", anchor)
    usage = _usage_index(workspace_id, _day_from_for(groups, cycle_start))

    if viewer is not None:
        email = viewer[1]
        mine = next((g for g in groups if email in members.get(g["id"], set())), None)
        out: dict[str, Any] = {"month": month, "cycle_start": cycle_start, "cycle_end": cycle_end,
                               "configured": configured, "my_group": None}
        if mine is not None:
            summary = _group_summary(mine, members[mine["id"]], usage, today, anchor)
            summary.pop("base_balance", None)
            summary.pop("base_start", None)
            my_used, my_unknown = _sum_usage(usage, {email}, day_from=cycle_start)
            my_p, my_p_unknown = _sum_usage(usage, {email}, day_from=period_start(today, summary["limit_period"], anchor))
            summary["my_used_month"] = round(my_used)
            summary["my_unknown_month"] = my_unknown
            summary["my_used_period"] = round(my_p)
            summary["my_unknown_period"] = my_p_unknown
            out["my_group"] = summary
        return out

    assigned_emails = set().union(*members.values()) if members else set()
    all_emails = {email for (_, email) in usage.keys()} | available
    unassigned_emails = {e for e in all_emails if e not in assigned_emails}
    un_used, un_unknown = _sum_usage(usage, unassigned_emails, day_from=cycle_start)
    used_month, unknown_month = _sum_usage(usage, all_emails | assigned_emails, day_from=cycle_start)
    first_in_cycle = next((h for h in history if h["day"] >= cycle_start), None)
    recent_topups = [t for t in topups if t["day"] >= _months_ago_day(month, 3)]
    return {
        "month": month,
        "today": today,
        "cycle_start": cycle_start,
        "cycle_end": cycle_end,
        "configured": configured,
        "revision": int(plan["revision"]) if plan else 0,
        "pool": {
            "monthly_topup": monthly_topup,  # 예산 한도(매월) 합 — 손 입력 아님
            "topup_day": anchor,
            "note": plan["note"] if plan else None,
            "used_month": round(used_month),
            "unknown_month": unknown_month,
            "balance": ws["credits"] if ws else None,
            "balance_seen_at": ws["last_seen_at"] if ws else None,
            # 월초 잔액 = 이번 충전 달 첫 관측일의 **첫** 관측값(같은 날 후속 보고로 안 바뀜 — 코덱스 P2). 관측이 없으면 None.
            "month_start_balance": first_in_cycle["first_credits"] if first_in_cycle else None,
            "month_start_day": first_in_cycle["day"] if first_in_cycle else None,
            "topups_month": _topup_summary(topups, cycle_start, cycle_end),  # 이번 충전 달 긴급 충전 합·횟수
        },
        "groups": [_group_summary(g, members.get(g["id"], set()), usage, today, anchor) for g in groups],
        "unassigned": {
            "member_count": len([e for e in available if e not in assigned_emails]),
            "used_month": round(un_used),
            "unknown_month": un_unknown,
        },
        "topups": [
            {"id": t["id"], "day": t["day"], "credits": int(t["credits"] or 0), "note": t["note"]}
            for t in recent_topups
        ],
        "history": [{"day": h["day"], "credits": h["credits"]} for h in history],
    }


def _months_ago_day(month: str, n: int) -> str:
    """month('YYYY-MM') 에서 n 개월 전 달의 1일 — 대시보드 긴급 충전 목록 범위(최근 3개월)."""
    y, m = (int(x) for x in month.split("-"))
    total = y * 12 + (m - 1) - n
    return f"{total // 12:04d}-{total % 12 + 1:02d}-01"
