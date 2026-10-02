"""워크스페이스 콘솔 — 메인 1개 · 서브 N개 표식과 메인의 크레딧 조율 개요(설계: docs/WORKSPACE_CONSOLE_DESIGN.md).

우리 앱은 힉스필드 워크스페이스를 만들 수 없다(CLI 에 생성 명령 없음). '만들기' = 에이전트가 보고한 워크스페이스를
서브로 **연결**하는 것. 그룹·몫·충전은 새로 저장하지 않고 기존 크레딧 플랜(`manage_credit_plan`)을 그대로 쓴다.
개요는 **집계 숫자만** 준다(이메일·이름 없음) — 상세는 기존 settings(create_project) 경로로.
"""
from __future__ import annotations

import re
from datetime import timedelta
from typing import Any, Optional

from ..db import get_connection
from . import manage_credit_plan as credit_plan
from .console_guard import (
    STATUSES,
    ConsoleManaged,
    _RECURRING_COPY_KEY,
    managed_sub,
)
from .event_journal import _record_audit_event, safe_identity
from .manage_schema import _ensure_schema

_SEED_KEY = "workspace_console_seed_v1"
_PROJECT_BACKFILL_KEY = "workspace_console_project_backfill_v1"
_CALENDAR_AHEAD_DAYS = 92  # 달력이 보여 줄 앞으로의 자동 충전 범위(약 3개월)
_MAIN_NAME = "MILLIONVOLT"  # Jay 2026-09-29: 메인 = MILLIONVOLT(이름 정규화: 공백 제거·대문자)


class ConsoleConflict(ValueError):
    """메인을 서브로 연결하려는 등 지금 상태와 맞지 않는 요청 — 라우터가 409 로 바꾼다."""


def _norm_name(name: Any) -> str:
    return re.sub(r"\s+", "", str(name or "")).upper()


def _named_registry(conn) -> list[dict[str, Any]]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT id, name, credits, first_seen_at, last_seen_at FROM workspace_registry "
            "WHERE name IS NOT NULL AND TRIM(name)<>'' ORDER BY name COLLATE NOCASE"
        ).fetchall()
    ]


def _seed(conn) -> None:
    """첫 사용 때 한 번 — 이름이 MILLIONVOLT 하나면 메인, 나머지 이름 있는 워크스페이스는 서브.
    등록부가 비어 있으면 표식을 남기지 않는다(첫 보고 뒤에 시드). 호출측 BEGIN IMMEDIATE 안에서."""
    if conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_SEED_KEY,)).fetchone():
        return
    registry = _named_registry(conn)
    if not registry:
        return
    mains = [r["id"] for r in registry if _norm_name(r["name"]) == _MAIN_NAME]
    main_id = mains[0] if len(mains) == 1 else None  # 0개·여러 개면 비워 두고 admin 이 지정한다
    has_main = conn.execute("SELECT 1 FROM workspace_console WHERE tier='main'").fetchone()
    for r in registry:
        tier = "main" if r["id"] == main_id and not has_main else "sub"
        conn.execute(
            "INSERT OR IGNORE INTO workspace_console(workspace_id, tier, created_by) VALUES(?,?,'seed')",
            (r["id"], tier),
        )
    conn.execute(
        "INSERT INTO manage_schema_state(key, value) VALUES(?, 'complete') "
        "ON CONFLICT(key) DO UPDATE SET value='complete', updated_at=datetime('now')",
        (_SEED_KEY,),
    )


def _seed_done() -> bool:
    with get_connection() as conn:
        _ensure_schema(conn)
        return bool(conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_SEED_KEY,)).fetchone())


def _write(fn):
    """쓰기(시드 포함)는 한 BEGIN IMMEDIATE 안에서 — 메인 교체의 유니크 순서·동시 요청을 한 번에 지킨다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        _seed(conn)
        return fn(conn)


def _copy_recurring_one(conn, workspace_id: str, actor_uid: Optional[str]) -> None:
    """정기 크레딧이 비어 있으면 지금의 파생값(프로젝트 월 예산 합)을 서브스페이스 정기 크레딧으로 한 번 복사한다. 주기·방식 칸은
    건드리지 않는다 — 전환 전에도 파생값이 그 주기로 쓰였으니 화면 숫자가 그대로다."""
    plan = conn.execute("SELECT recurring_topup FROM workspace_credit_plan WHERE workspace_id=?", (workspace_id,)).fetchone()
    if plan and plan["recurring_topup"] is not None:
        return
    derived = credit_plan.project_budget_sum(conn, workspace_id)
    if derived is None:
        return
    conn.execute(
        "INSERT INTO workspace_credit_plan(workspace_id, recurring_topup, updated_by) VALUES(?,?,?) "
        "ON CONFLICT(workspace_id) DO UPDATE SET recurring_topup=excluded.recurring_topup, revision=revision+1, "
        "updated_by=excluded.updated_by, updated_at=datetime('now')",
        (workspace_id, float(derived), safe_identity(actor_uid)),
    )
    _record_audit_event(
        conn, "workspace.credit_plan_changed", actor_uid=actor_uid, target_type="workspace_credit_plan",
        target_id=workspace_id, details={"via": "workspace_console_recurring_copy", "recurring_topup": derived},
    )


def _switch_to_console_credits(actor_uid: Optional[str]) -> None:
    """서브스페이스 전환 — 서브마다 1회 옮기기 뒤 표식. 표식이 생기는 순간 파생 끄기·대시보드 서브스페이스 값·예산/상태 보호가 함께 켜진다.
    create_project 권한자의 콘솔 열기에서만 부른다(프로젝트 1회 채우기와 같은 경로)."""
    def run(conn):
        if not conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_SEED_KEY,)).fetchone():
            return  # 시드 전(등록부 비어 있음) — 다음에
        if conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_RECURRING_COPY_KEY,)).fetchone():
            return
        for r in conn.execute("SELECT workspace_id FROM workspace_console WHERE tier='sub'").fetchall():
            _copy_recurring_one(conn, r["workspace_id"], actor_uid)
        conn.execute(
            "INSERT INTO manage_schema_state(key, value) VALUES(?, 'complete') "
            "ON CONFLICT(key) DO UPDATE SET value='complete', updated_at=datetime('now')",
            (_RECURRING_COPY_KEY,),
        )

    # 이미 옮겼으면 쓰기 트랜잭션을 열지 않는다 — 콘솔을 열 때마다 쓰기 잠금 줄에 서지 않게(2026-10-01 점검 R1-6).
    #  run 안의 재확인은 그대로 둬 동시에 두 번 열려도 한 번만 옮긴다.
    with get_connection() as conn:
        _ensure_schema(conn)
        if conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_RECURRING_COPY_KEY,)).fetchone():
            return
    _write(run)


def _require_registered(conn, workspace_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id, name FROM workspace_registry WHERE id=? AND name IS NOT NULL AND TRIM(name)<>''",
        (workspace_id,),
    ).fetchone()
    if not row:
        raise LookupError("확인되지 않은 워크스페이스")
    return dict(row)


def _audit(conn, action: str, actor_uid: Optional[str], workspace_id: str, details: dict[str, Any]) -> None:
    _record_audit_event(
        conn, action, actor_uid=actor_uid, target_type="workspace_console", target_id=workspace_id, details=details
    )


# ── 쓰기 ──────────────────────────────────────────────────────────────────────
def link_sub(workspace_id: str, actor_uid: Optional[str]) -> dict[str, Any]:
    """'워크스페이스 만들기' — 보고된 워크스페이스를 서브로 연결. 내려 둔 서브면 다시 올린다."""

    def run(conn):
        _require_registered(conn, workspace_id)
        row = conn.execute("SELECT tier, archived FROM workspace_console WHERE workspace_id=?", (workspace_id,)).fetchone()
        if row and row["tier"] == "main":
            raise ConsoleConflict("메인 워크스페이스는 서브로 연결할 수 없습니다")
        if row and not row["archived"]:
            return {"workspace_id": workspace_id, "changed": False}
        conn.execute(
            "INSERT INTO workspace_console(workspace_id, tier, created_by) VALUES(?, 'sub', ?) "
            "ON CONFLICT(workspace_id) DO UPDATE SET archived=0",
            (workspace_id, safe_identity(actor_uid)),
        )
        _audit(conn, "workspace.console_linked", actor_uid, workspace_id, {"relinked": bool(row)})
        if conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_RECURRING_COPY_KEY,)).fetchone():
            _copy_recurring_one(conn, workspace_id, actor_uid)  # 전환 뒤 새로 연결한 서브도 옛 예산을 잃지 않게
        return {"workspace_id": workspace_id, "changed": True}

    return _write(run)


def set_archived(workspace_id: str, archived: bool, actor_uid: Optional[str]) -> dict[str, Any]:
    """서브를 콘솔에서 내리기/다시 올리기. 크레딧 플랜 데이터는 건드리지 않는다."""

    def run(conn):
        row = conn.execute("SELECT tier, archived FROM workspace_console WHERE workspace_id=?", (workspace_id,)).fetchone()
        if not row:
            raise LookupError("콘솔에 없는 워크스페이스")
        if row["tier"] == "main":
            raise ConsoleConflict("메인 워크스페이스는 내릴 수 없습니다")
        if bool(row["archived"]) == archived:
            return {"workspace_id": workspace_id, "changed": False}
        conn.execute("UPDATE workspace_console SET archived=? WHERE workspace_id=?", (int(archived), workspace_id))
        _audit(conn, "workspace.console_archived", actor_uid, workspace_id, {"archived": archived})
        return {"workspace_id": workspace_id, "changed": True}

    return _write(run)


def set_status(workspace_id: str, status: str, actor_uid: Optional[str]) -> dict[str, Any]:
    """서브 상태(활성·비활성·완료) — 표시용. 메인에는 없다."""
    if status not in STATUSES:
        raise ValueError("상태는 active/inactive/done 중 하나여야 합니다")

    def run(conn):
        row = conn.execute("SELECT tier, status FROM workspace_console WHERE workspace_id=?", (workspace_id,)).fetchone()
        if not row:
            raise LookupError("콘솔에 없는 워크스페이스")
        if row["tier"] == "main":
            raise ConsoleConflict("메인 워크스페이스에는 상태가 없습니다")
        if row["status"] == status:
            return {"workspace_id": workspace_id, "changed": False}
        conn.execute("UPDATE workspace_console SET status=? WHERE workspace_id=?", (status, workspace_id))
        _audit(conn, "workspace.console_status", actor_uid, workspace_id, {"status": status, "previous": row["status"]})
        return {"workspace_id": workspace_id, "changed": True}

    return _write(run)


def set_main(workspace_id: str, actor_uid: Optional[str]) -> dict[str, Any]:
    """메인 최초 지정. 이미 지정된 메인은 등록부에서 사라져도 바꾸지 않는다."""

    def run(conn):
        _require_registered(conn, workspace_id)
        old = conn.execute("SELECT workspace_id FROM workspace_console WHERE tier='main'").fetchone()
        old_id = old["workspace_id"] if old else None
        if old_id == workspace_id:
            return {"workspace_id": workspace_id, "changed": False}
        if old_id:
            raise ConsoleConflict("메인 워크스페이스는 바꿀 수 없습니다")
        conn.execute(
            "INSERT INTO workspace_console(workspace_id, tier, created_by) VALUES(?, 'main', ?) "
            "ON CONFLICT(workspace_id) DO UPDATE SET tier='main', archived=0",
            (workspace_id, safe_identity(actor_uid)),
        )
        _audit(conn, "workspace.console_main_changed", actor_uid, workspace_id, {"previous": old_id})
        return {"workspace_id": workspace_id, "changed": True}

    return _write(run)


def set_alloc_base(credits: Optional[float], day: Optional[str], actor_uid: Optional[str]) -> dict[str, Any]:
    """메인의 '할당된 크레딧' 기준값 — 힉스필드 화면의 값과 그 날짜. None 이면 지워서 기록 기준 추정으로 돌아간다."""
    if credits is not None:
        value = credit_plan._valid_quota(credits)
        if value is None or not day or not credit_plan._DAY_RE.fullmatch(day):
            raise ValueError("기준값은 0 이상, 날짜는 YYYY-MM-DD 로 적어 주세요")
        credit_plan._d(day)

    def run(conn):
        row = conn.execute("SELECT workspace_id FROM workspace_console WHERE tier='main'").fetchone()
        if not row:
            raise LookupError("메인 워크스페이스가 정해지지 않았습니다")
        conn.execute(
            "UPDATE workspace_console SET alloc_base=?, alloc_base_day=? WHERE workspace_id=?",
            (None if credits is None else float(credits), None if credits is None else day, row["workspace_id"]),
        )
        _audit(conn, "workspace.console_alloc_base", actor_uid, row["workspace_id"], {"credits": credits, "day": day})
        return {"credits": credits, "day": None if credits is None else day}

    return _write(run)


def _is_charge_day(day: str, period: str, anchor: Optional[str], topup_day: int) -> bool:
    """그날이 자동 정기 충전일인가(지금 설정 기준). 기준 날짜 전은 아니다."""
    if anchor and day < anchor:
        return False
    if period == "day":
        return True
    if period == "week" and anchor:
        return (credit_plan._d(day) - credit_plan._d(anchor)).days % 7 == 0
    return credit_plan.period_start(day, "month", topup_day) == day


def _allocated_since(sub: dict[str, Any], topups: list[dict[str, Any]], base_day: str, today: str) -> float:
    """기준일 **다음 날**부터 오늘까지 이 서브에 들어간 것 — 기록된 추가 크레딧 + 지나간 자동 정기 충전(지금 설정으로 셈)."""
    total = sum(float(t["credits"]) for t in topups if base_day < str(t["day"]) <= today)
    amount = sub["monthly_topup"]
    if sub["recurring_auto"] and amount:
        day = credit_plan._d(base_day) + timedelta(days=1)
        end = credit_plan._d(today)
        for _ in range(400):  # ponytail: 하루씩 훑는다 — 기준일이 1년 넘게 묵으면 그 뒤는 안 센다(그땐 기준값을 다시 넣는다)
            if day > end:
                break
            if _is_charge_day(day.isoformat(), sub["recurring_period"], sub["recurring_anchor"], sub["topup_day"]):
                total += float(amount)
            day += timedelta(days=1)
    return total


def ensure_sub_project(workspace_id: str, actor_uid: Optional[str]) -> Optional[dict[str, Any]]:
    """서브 1개 = 프로젝트 1개 보장(Jay 2026-09-29) — 그 워크스페이스 프로젝트가 **보관 포함 0개**일 때만 같은 이름으로 만든다.
    역할·렌더 폴더·기간·생성물 배정이 전부 프로젝트에 붙기 때문. 메인은 만들지 않는다. 쓰기 트랜잭션 **밖**에서 부른다
    (`create_project` 가 자기 트랜잭션을 연다). 만든 프로젝트를 돌려준다(없으면 None). 이름이 다른 워크스페이스의 활성
    프로젝트와 겹치면 `이름 (워크스페이스 id 앞 6자)` — `create_project` 는 같은 이름이면 **남의 프로젝트를 돌려주므로** 결과의
    워크스페이스를 확인한다(다르면 오류, 다음 호출에서 다시 시도)."""
    from . import projects as repo_projects

    with get_connection() as conn:
        _ensure_schema(conn)
        tier = conn.execute("SELECT tier FROM workspace_console WHERE workspace_id=?", (workspace_id,)).fetchone()
        if not tier or tier["tier"] != "sub":
            return None
        if conn.execute("SELECT 1 FROM project WHERE workspace_id=? LIMIT 1", (workspace_id,)).fetchone():
            return None
        ws = _require_registered(conn, workspace_id)
        name = str(ws["name"]).strip()
        owner = repo_projects._active_name_owner(conn, name)
        if owner:
            name = f"{name} ({workspace_id[:6]})"
    created = repo_projects.create_project(
        name, "team", created_by=actor_uid, workspace={"scope": "team", "id": workspace_id, "name": ws["name"]}
    )
    if created.get("workspace_id") != workspace_id:
        raise RuntimeError(f"프로젝트 이름 '{name}' 이 다른 워크스페이스의 프로젝트와 겹쳐 만들지 못했습니다")
    from ..services.event_journal import journal_audit_event

    # ponytail: 두 연결 요청이 동시에 오면 create_project 가 먼저 만든 것을 돌려줘 감사가 두 번 남을 수 있다(데이터는 한 번).
    #  막으려면 create_project 가 '새로 만들었는지'를 돌려줘야 한다.
    journal_audit_event(
        "project.created", actor_uid=actor_uid, target_type="project", target_id=created.get("id"),
        project_id=created.get("id"), fields=["name", "kind", "workspace"],
        details={"kind": "team", "workspace_scope": "team", "via": "workspace_console"},
    )
    return created


def _backfill_sub_projects() -> None:
    """기존 서브(Education 처럼 프로젝트가 없는 곳)에 한 번 채운다. 표식은 **모두 성공한 뒤에만** 남긴다 — 중간 실패는 다음 조회에서
    다시 시도(`ensure_sub_project` 가 '0개일 때만' 이라 멱등)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        if conn.execute("SELECT 1 FROM manage_schema_state WHERE key=?", (_PROJECT_BACKFILL_KEY,)).fetchone():
            return
        subs = [r["workspace_id"] for r in conn.execute("SELECT workspace_id FROM workspace_console WHERE tier='sub'").fetchall()]
    ok = True
    for wid in subs:
        try:
            ensure_sub_project(wid, "workspace_console_backfill")
        except Exception:  # noqa: BLE001 — 한 곳 실패가 개요를 막지 않게. 표식을 안 남겨 다음에 다시 시도
            ok = False
    if ok:
        _write(lambda conn: conn.execute(
            "INSERT INTO manage_schema_state(key, value) VALUES(?, 'complete') "
            "ON CONFLICT(key) DO UPDATE SET value='complete', updated_at=datetime('now')",
            (_PROJECT_BACKFILL_KEY,),
        ))


# ── 읽기 ──────────────────────────────────────────────────────────────────────
def _alloc_window(today: str, period: str, anchor: Optional[str], topup_day: int) -> tuple[str, str]:
    """이번 할당 주기(시작, 끝) — month=충전일(topup_day) 달력 · week=기준 날짜의 요일부터 7일 · day=그날.
    주 단위인데 기준 날짜가 없으면(옛 행) 달 단위로 본다."""
    if period == "week" and anchor:
        t, a = credit_plan._d(today), credit_plan._d(anchor)
        start = a + timedelta(days=7 * ((t - a).days // 7))  # 기준 날짜가 미래여도 같은 요일 격자(내림 나눗셈)
        return start.isoformat(), (start + timedelta(days=6)).isoformat()
    if period == "day":
        return today, today
    return credit_plan.period_start(today, "month", topup_day), credit_plan.period_end(today, "month", topup_day)


def _occurrences(today: str, until: str, period: str, anchor: Optional[str], topup_day: int, limit: int = 40) -> list[str]:
    """오늘 뒤부터 until(포함)까지의 자동 충전 날짜. 기준 날짜가 미래면 그날 전 것은 뺀다(그날부터 시작)."""
    step_period = period if (period != "week" or anchor) else "month"
    _, end = _alloc_window(today, step_period, anchor, topup_day)
    day = credit_plan._d(end) + timedelta(days=1)
    out: list[str] = []
    while day.isoformat() <= until and len(out) < limit:
        if not anchor or day.isoformat() >= anchor:
            out.append(day.isoformat())
        if step_period == "day":
            day += timedelta(days=1)
        elif step_period == "week":
            day += timedelta(days=7)
        else:
            day = credit_plan._d(credit_plan.period_end(day.isoformat(), "month", topup_day)) + timedelta(days=1)
    return out


def _sub_summary(ws: dict[str, Any], today: str, horizon: str, reported: int, unconfirmed: int) -> dict[str, Any]:
    """서브 한 줄 — 기존 대시보드 카드 계산(plan_view, 매니저 보기)에서 **숫자만** 뽑고, 사용량·추가 할당은
    그 서브의 **할당 주기**(자동 주기, 수동은 달) 창으로 다시 센다."""
    view = credit_plan.plan_view(ws["id"])
    pool = view["pool"]
    amount = pool["monthly_topup"]  # 한 번 충전액(주기마다) — 이름은 옛 계약 그대로
    auto = pool["recurring_auto"]
    period = pool["recurring_period"] if auto else "month"
    anchor = pool["recurring_anchor"] if auto else None
    topup_day = pool["topup_day"]
    start, end = _alloc_window(today, period, anchor, topup_day)
    usage = credit_plan._usage_index(ws["id"], start)
    used = sum(float(r["credits"] or 0) for (day, _), r in usage.items() if start <= day <= end)
    unknown = sum(int(r["unknown"] or 0) for (day, _), r in usage.items() if start <= day <= end)
    window_topups = [t for t in view["topups"] if start <= str(t["day"]) <= end]
    topups = {"count": len(window_topups), "credits": int(sum(int(t["credits"] or 0) for t in window_topups))}
    upcoming = _occurrences(today, horizon, period, anchor, topup_day) if auto and amount else []
    # 전체 기간 사용(우리 기록 기준) — 힉스필드 'credits spent' 에 해당. 앱 도입 전 사용은 없다(추정).
    used_all = sum(float(r["credits"] or 0) for r in credit_plan._usage_index(ws["id"], None).values())
    # 달력용(앞으로 92일) — 일 주기도 담기게 상한을 넉넉히. 개요 응답에서는 calendar.events 로 옮기고 뺀다.
    far = (credit_plan._d(today) + timedelta(days=_CALENDAR_AHEAD_DAYS)).isoformat()
    upcoming_far = _occurrences(today, far, period, anchor, topup_day, limit=_CALENDAR_AHEAD_DAYS + 1) if auto and amount else []
    first = _occurrences(today, "9999-12-31", period, anchor, topup_day, limit=1)
    return {
        "id": ws["id"],
        "name": ws["name"],
        "balance": pool["balance"],
        "balance_seen_at": pool["balance_seen_at"],
        "first_seen_at": ws.get("first_seen_at"),  # 이 앱이 처음 본 날(힉스필드 생성일 대용)
        "used_all": credit_plan._shown(used_all),
        "monthly_topup": amount,
        "monthly_topup_source": pool["monthly_topup_source"],
        "recurring_auto": auto,  # 수동이면 예정표·정기 할당 합계에서 빠진다
        "recurring_period": pool["recurring_period"],
        "recurring_anchor": pool["recurring_anchor"],
        "topup_day": topup_day,
        "next_topup_day": first[0] if first else None,
        "upcoming": upcoming,  # 30일 안 자동 충전 날짜(예정표 계산용)
        "_upcoming_far": upcoming_far,
        "_topups": [{"id": t["id"], "day": str(t["day"]), "credits": int(t["credits"] or 0)} for t in view["topups"]],  # 최근 3개월(메모 제외)
        "cycle_start": start,
        "cycle_end": end,
        "topups_cycle": topups,
        "used_cycle": credit_plan._shown(used),
        "unknown_cycle": unknown,
        # 이번 할당 주기 계획상 남은 양 = 한 번 충전액 + 이번 주기 추가 할당 − 이번 주기 사용. 충전액을 모르면 None.
        "planned_left": None if amount is None else credit_plan._shown(float(amount) + topups["credits"] - used),
        "group_count": len(view["groups"]),
        "participants": {"reported": reported, "unconfirmed": unconfirmed},
    }


def _schedule(main_balance: Optional[float], subs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """메인 잔액 예정표(오늘부터 30일 안) — 서브마다 주기·충전일이 달라 **날짜순으로** 누적해 뺀다(Codex 2차). 이미 충전된
    금액·추가 할당은 보고 잔액에 들어 있으므로 빼지 않는다 — 빼는 것은 앞으로 나갈 자동 정기 할당뿐(주·일 주기는 여러 번)."""
    by_day: dict[str, list[dict[str, Any]]] = {}
    for s in subs:
        for day in s.get("upcoming") or []:
            by_day.setdefault(day, []).append(s)
    out: list[dict[str, Any]] = []
    balance = None if main_balance is None else float(main_balance)
    for day in sorted(by_day):
        amount = sum(float(s["monthly_topup"]) for s in by_day[day])
        if balance is not None:
            balance -= amount
        out.append({
            "day": day,
            "subs": [{"id": s["id"], "name": s["name"]} for s in by_day[day]],
            "amount": credit_plan._shown(amount),
            "balance_after": None if balance is None else credit_plan._shown(balance),
        })
    return out


def _calendar(subs: list[dict[str, Any]], today: str) -> dict[str, Any]:
    """크레딧 달력 — 지난 3개월의 추가 크레딧 기록 + 앞으로 92일의 자동 정기 크레딧. 금액·서브 이름만(메모 없음 — 개요는
    read_all 집계라 개인 문구를 싣지 않는다). 서브 줄에 임시로 붙인 목록은 여기서 떼어 낸다."""
    events: list[dict[str, Any]] = []
    for s in subs:
        for t in s.pop("_topups", []):
            events.append({"day": t["day"], "kind": "topup", "sub_id": s["id"], "name": s["name"], "credits": t["credits"],
                           "topup_id": t["id"]})  # 달력에서 끌어 옮길 때 어느 기록인지(메모는 싣지 않는다)
        for day in s.pop("_upcoming_far", []):
            events.append({"day": day, "kind": "recurring", "sub_id": s["id"], "name": s["name"],
                           "credits": credit_plan._shown(float(s["monthly_topup"] or 0))})
    events.sort(key=lambda e: (e["day"], e["kind"], str(e["name"]).casefold()))
    return {
        "from": credit_plan._months_ago_day(today[:7], 3),
        "to": (credit_plan._d(today) + timedelta(days=_CALENDAR_AHEAD_DAYS)).isoformat(),
        "events": events,
    }


def console_limits(conn, workspace_ids: list[str], detail: bool = False) -> dict[str, dict[str, Any]]:
    """대시보드·관리 표용 서브스페이스 크레딧(설계 §13) — 연결된 서브만, `plan_view` 없이 계획 행·이번 주기 추가 합·활성 프로젝트 수만 읽는다.
    주기 창은 서브스페이스 개요(`_sub_summary`)와 같은 계산. 전환 전이면 빈 dict(종전 프로젝트 예산 표시)."""
    ids = [w for w in dict.fromkeys(workspace_ids) if w and managed_sub(conn, w)]
    if not ids:
        return {}
    today = credit_plan.today_local()
    marks = ",".join("?" for _ in ids)
    reg = {r["id"]: r for r in conn.execute(f"SELECT id, name, credits, last_seen_at FROM workspace_registry WHERE id IN ({marks})", ids)}
    names = {wid: r["name"] for wid, r in reg.items()}
    plans = {r["workspace_id"]: dict(r) for r in conn.execute(f"SELECT * FROM workspace_credit_plan WHERE workspace_id IN ({marks})", ids)}
    shared = {
        r["workspace_id"]: r["n"]
        for r in conn.execute(
            f"SELECT workspace_id, COUNT(*) AS n FROM project WHERE archived=0 AND workspace_scope='team' "
            f"AND workspace_id IN ({marks}) GROUP BY workspace_id", ids
        )
    }
    out: dict[str, dict[str, Any]] = {}
    for wid in ids:
        plan = plans.get(wid)
        auto = credit_plan._plan_auto(plan)
        period = credit_plan._plan_period(plan) if auto else "month"
        anchor = plan.get("recurring_anchor") if plan and auto else None
        start, end = _alloc_window(today, period, anchor, credit_plan._plan_anchor(plan))
        topups = conn.execute(
            "SELECT COALESCE(SUM(credits), 0) AS s FROM workspace_credit_topup WHERE workspace_id=? AND day BETWEEN ? AND ?",
            (wid, start, end),
        ).fetchone()["s"]
        credits = credit_plan._plan_recurring(plan)
        out[wid] = {
            "workspace_id": wid, "workspace_name": names.get(wid), "credits": credits, "period": period, "auto": auto,
            "anchor": anchor, "topup_day": credit_plan._plan_anchor(plan),
            # 서브스페이스 서브 표와 같은 '남은 크레딧 / 할당 크레딧 · 다음 할당일'(§16 후속) — 보고 잔액·다음 충전일(가벼운 계산)
            "balance": reg[wid]["credits"] if wid in reg else None,
            "balance_seen_at": reg[wid]["last_seen_at"] if wid in reg else None,
            "next_topup_day": (lambda first: first[0] if first else None)(
                _occurrences(today, "9999-12-31", period, anchor, credit_plan._plan_anchor(plan), limit=1)),
            "cycle_start": start, "cycle_end": end, "topups_cycle": int(topups or 0), "shared_projects": shared.get(wid, 0),
        }
        if detail:  # 관리 표 한 워크스페이스용(설계 §16) — 서브스페이스 개요 `_sub_summary` 와 같은 계산
            usage = credit_plan._usage_index(wid, start)
            out[wid].update({
                "topups_count": conn.execute(
                    "SELECT COUNT(*) FROM workspace_credit_topup WHERE workspace_id=? AND day BETWEEN ? AND ?", (wid, start, end)
                ).fetchone()[0],
                "used_cycle": credit_plan._shown(sum(float(r["credits"] or 0) for (day, _), r in usage.items() if start <= day <= end)),
                "unknown_cycle": sum(int(r["unknown"] or 0) for (day, _), r in usage.items() if start <= day <= end),
            })
    return out


def overview(backfill_projects: bool = False) -> dict[str, Any]:
    """메인 1 · 서브 목록(내린 것 제외) · 연결 대기 · 예정표. 크레딧 계산은 워크스페이스마다 기존 plan_view 를
    **바깥 트랜잭션 없이** 순차로 부른다(plan_view 가 자기 연결을 연다 — Codex Q-C2)."""
    today = credit_plan.today_local()
    if not _seed_done():  # 조회가 매번 쓰기 잠금을 잡지 않게 — 시드 전(표식 없음)에만 쓰기 트랜잭션(Codex 코드 리뷰)
        _write(lambda conn: None)
    if backfill_projects:
        _backfill_sub_projects()
        _switch_to_console_credits("workspace_console_backfill")
    with get_connection() as conn:
        _ensure_schema(conn)
        registry = {r["id"]: r for r in _named_registry(conn)}
        console = {
            r["workspace_id"]: dict(r)
            for r in conn.execute("SELECT workspace_id, tier, archived, alloc_base, alloc_base_day, status FROM workspace_console").fetchall()
        }
        reported = {
            r["workspace_id"]: r["n"]
            for r in conn.execute(
                "SELECT workspace_id, COUNT(*) AS n FROM workspace_member WHERE is_available=1 GROUP BY workspace_id"
            ).fetchall()
        }
        # 그룹에는 넣었지만 그 사람의 에이전트가 이 워크스페이스를 아직 보고하지 않은 사람('확인 전')
        unconfirmed = {
            r["workspace_id"]: r["n"]
            for r in conn.execute(
                "SELECT gm.workspace_id, COUNT(*) AS n FROM workspace_credit_group_member gm "
                "LEFT JOIN workspace_member m ON m.workspace_id=gm.workspace_id "
                "AND m.account_email=gm.account_email AND m.is_available=1 "
                "WHERE m.account_email IS NULL GROUP BY gm.workspace_id"
            ).fetchall()
        }
        # 서브마다 프로젝트 기간(이름·시작일·종료일만 — 달력 '기간'·서브 표 '기간' 열). 보관된 프로젝트는 뺀다.
        projects_by_ws: dict[str, list[dict[str, Any]]] = {}
        order_by_ws: dict[str, int] = {}  # 서브 순서 = 그 서브 프로젝트 중 가장 앞 sort_order(관리 창 순서와 같게)
        for r in conn.execute(
            "SELECT p.id, p.name, p.workspace_id, p.archived, p.sort_order, pp.start_date, pp.due_date FROM project p "
            "LEFT JOIN project_planning pp ON pp.project_id = p.id "
            "WHERE p.workspace_id IS NOT NULL ORDER BY p.sort_order IS NULL, p.sort_order, p.name COLLATE NOCASE"
        ).fetchall():
            projects_by_ws.setdefault(r["workspace_id"], []).append(
                {"id": r["id"], "name": r["name"], "start_date": r["start_date"], "due_date": r["due_date"],
                 "archived": bool(r["archived"])})
            if r["sort_order"] is not None:
                order_by_ws[r["workspace_id"]] = min(order_by_ws.get(r["workspace_id"], r["sort_order"]), r["sort_order"])
    main_id = next((wid for wid, c in console.items() if c["tier"] == "main"), None)
    main_ws = registry.get(main_id) if main_id else None
    sub_ids = [wid for wid, c in console.items() if c["tier"] == "sub" and not c["archived"] and wid in registry]
    horizon = (credit_plan._d(today) + timedelta(days=30)).isoformat()
    subs = [
        {**_sub_summary(registry[wid], today, horizon, reported.get(wid, 0), unconfirmed.get(wid, 0)),
         "status": console[wid]["status"] or "active", "projects": projects_by_ws.get(wid, [])}
        for wid in sorted(sub_ids, key=lambda w: (order_by_ws.get(w, 1 << 30), str(registry[w]["name"]).casefold()))
    ]
    linked = {wid for wid, c in console.items() if c["tier"] == "main" or not c["archived"]}
    pending = [
        {"id": r["id"], "name": r["name"], "reported": reported.get(r["id"], 0), "last_seen_at": r["last_seen_at"],
         "archived": r["id"] in console}
        for r in registry.values() if r["id"] not in linked
    ]
    main_balance = main_ws["credits"] if main_ws else None
    main_row = console.get(main_id) if main_id else None
    unused = sum(float(s["balance"] or 0) for s in subs)
    if main_row and main_row["alloc_base"] is not None:
        with get_connection() as conn:  # 기준일 뒤 추가 크레딧은 3개월 목록이 아니라 표에서 전부 읽는다
            base_day = main_row["alloc_base_day"]
            rows = conn.execute(
                "SELECT workspace_id, day, credits FROM workspace_credit_topup WHERE day > ?", (base_day,)
            ).fetchall()
        by_ws: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            by_ws.setdefault(r["workspace_id"], []).append(dict(r))
        allocated = float(main_row["alloc_base"]) + sum(_allocated_since(s, by_ws.get(s["id"], []), base_day, today) for s in subs)
        allocation = {"source": "baseline", "base": float(main_row["alloc_base"]), "base_day": base_day,
                      "allocated": credit_plan._shown(allocated), "spent": credit_plan._shown(allocated - unused)}
    else:
        spent_all = sum(float(s["used_all"]) for s in subs)
        allocation = {"source": "estimate", "base": None, "base_day": None,
                      "allocated": credit_plan._shown(spent_all + unused), "spent": credit_plan._shown(spent_all)}
    return {
        "today": today,
        "main": None if not main_ws else {
            "id": main_ws["id"], "name": main_ws["name"], "balance": main_balance,
            "balance_seen_at": main_ws["last_seen_at"], "reported": reported.get(main_ws["id"], 0),
        },
        "main_orphan": {"id": main_id} if main_id and not main_ws else None,
        "subs": subs,
        "totals": {
            # 앞으로 30일 동안 자동으로 나갈 정기 할당 합(주·일 주기는 횟수만큼) — 예정표와 같은 값
            "recurring_30d": credit_plan._shown(sum(float(s["monthly_topup"] or 0) * len(s["upcoming"]) for s in subs)),
            "topups_cycle": sum(s["topups_cycle"]["credits"] for s in subs),
            "topups_count": sum(s["topups_cycle"]["count"] for s in subs),
            "used_cycle": credit_plan._shown(sum(float(s["used_cycle"]) for s in subs)),
            # 엔터프라이즈 풀 카드(힉스필드와 같은 관계) — 할당됨(추정) = 사용(우리 기록 전체) + 미사용(서브 잔액 합)
            "spent_all": credit_plan._shown(sum(float(s["used_all"]) for s in subs)),
            "unused": credit_plan._shown(sum(float(s["balance"] or 0) for s in subs)),
        },
        "schedule": _schedule(main_balance, subs),
        "calendar": _calendar(subs, today),
        # 풀 카드 — 할당된 크레딧 = 기준값(힉스필드 값) + 그 뒤 기록·지나간 자동 충전, 사용 = 할당 − 미사용(서브 잔액 합).
        # 기준값이 없으면 사용 = 우리 기록 전체(추정).
        "allocation": {**allocation, "unused": credit_plan._shown(unused)},
        "pending": pending,
    }
