"""워크스페이스 콘솔(서브스페이스 탭) — 메인·서브 표식·연결·메인 지정·조율 개요(docs/WORKSPACE_CONSOLE_DESIGN.md)."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db, deps, manage_db
from app.repo import event_journal, manage_credit_plan as credit, manage_schema
from app.repo import workspace_console as console
from app.routers import manage as routes
from app.routers import workspace_console as console_routes

TODAY = "2026-09-29"
ROLES = {"admin": "admin", "pm": "product_manager", "member": "member"}


def _registry(rows):
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES(?,?,'enterprise',?)", rows
        )


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "usage.db")
    monkeypatch.setattr(credit, "today_local", lambda: TODAY)
    db.flush_pool()
    db.init_db()
    manage_db.init_manage_db()
    with db.get_connection() as conn:
        manage_schema._ensure_schema(conn)
    yield
    db.flush_pool()


@pytest.fixture
def client(isolated, monkeypatch):
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    monkeypatch.setattr(routes, "AUTH_ENABLED", True)
    monkeypatch.setattr(console_routes, "AUTH_ENABLED", True)
    app = FastAPI()

    @app.middleware("http")
    async def test_account(request, call_next):
        who = request.headers.get("x-actor", "admin")
        request.state.account = {
            "email": f"{who}@example.test", "creator_uid": f"u_{who}", "status": "approved", "global_role": ROLES[who],
        }
        return await call_next(request)

    app.include_router(routes.router)
    with TestClient(app) as http:
        yield http


def _tiers():
    with db.get_connection() as conn:
        return {r["workspace_id"]: (r["tier"], r["archived"]) for r in conn.execute("SELECT * FROM workspace_console")}


def test_seed_picks_millionvolt_once(isolated):
    _registry([("mv", "MILLION VOLT", 180000), ("a", "Studio A", 10), ("b", "Studio B", 20)])
    out = console.overview()
    assert out["main"]["id"] == "mv"
    assert [s["id"] for s in out["subs"]] == ["a", "b"]
    # 시드는 한 번뿐 — 나중에 보고된 워크스페이스는 자동 서브가 아니라 연결 대기
    _registry([("c", "Studio C", 0)])
    out = console.overview()
    assert [s["id"] for s in out["subs"]] == ["a", "b"]
    assert [p["id"] for p in out["pending"]] == ["c"]


@pytest.mark.parametrize("names", [["Studio A"], ["MILLIONVOLT", "millionvolt"]])
def test_seed_without_single_main_leaves_main_empty(isolated, names):
    _registry([(f"w{i}", n, 0) for i, n in enumerate(names)])
    out = console.overview()
    assert out["main"] is None
    assert len(out["subs"]) == len(names)


def test_empty_registry_seeds_after_first_report(isolated):
    assert console.overview()["subs"] == []
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    out = console.overview()
    assert out["main"]["id"] == "mv" and [s["id"] for s in out["subs"]] == ["a"]


def test_link_archive_and_errors(client):
    client.headers["x-actor"] = "pm"  # 연결·내리기 = create_project(PM). admin 역할엔 이 권한이 없다(크레딧 저장과 같은 규칙)
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    client.get("/api/manage/console/overview")
    _registry([("c", "C", 0)])
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "c"}).json()["changed"] is True
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "c"}).json()["changed"] is False
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "mv"}).status_code == 409
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "nope"}).status_code == 404
    assert client.patch("/api/manage/console/workspaces/c", json={"archived": True}).json()["changed"] is True
    out = client.get("/api/manage/console/overview").json()
    assert "c" not in [s["id"] for s in out["subs"]]
    assert {"id": "c", "archived": True}.items() <= next(p for p in out["pending"] if p["id"] == "c").items()
    assert client.patch("/api/manage/console/workspaces/mv", json={"archived": True}).status_code == 409
    client.post("/api/manage/console/workspaces", json={"workspace_id": "c"})  # 다시 연결 = 올리기
    assert _tiers()["c"] == ("sub", 0)
    actions = [e["action"] for e in event_journal.list_audit_events(limit=100)]
    assert actions.count("workspace.console_linked") == 2 and "workspace.console_archived" in actions


def test_sub_status_is_saved_and_validated(client):
    client.headers["x-actor"] = "pm"
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    assert client.get("/api/manage/console/overview").json()["subs"][0]["status"] == "active"
    assert client.patch("/api/manage/console/workspaces/a", json={"status": "done"}).json()["changed"] is True
    assert client.get("/api/manage/console/overview").json()["subs"][0]["status"] == "done"
    assert client.patch("/api/manage/console/workspaces/a", json={"status": "paused"}).status_code == 400
    assert client.patch("/api/manage/console/workspaces/mv", json={"status": "done"}).status_code == 409
    assert "workspace.console_status" in [e["action"] for e in event_journal.list_audit_events(limit=100)]


def test_set_main_is_fixed_after_first_set_admin_only(client):
    _registry([("a", "A", 0), ("b", "B", 0)])
    assert client.get("/api/manage/console/overview").json()["main"] is None
    assert client.put("/api/manage/console/main", json={"workspace_id": "a"}, headers={"x-actor": "pm"}).status_code == 403
    assert client.put("/api/manage/console/main", json={"workspace_id": "a"}).json()["changed"] is True
    assert _tiers() == {"a": ("main", 0), "b": ("sub", 0)}
    assert client.put("/api/manage/console/main", json={"workspace_id": "a"}).json()["changed"] is False
    before = _tiers()
    rejected = client.put("/api/manage/console/main", json={"workspace_id": "b"})
    assert rejected.status_code == 409 and rejected.json()["detail"] == "메인 워크스페이스는 바꿀 수 없습니다"
    assert _tiers() == before
    assert "workspace.console_main_changed" in [e["action"] for e in event_journal.list_audit_events(limit=100)]


def test_orphaned_main_is_reported_and_cannot_be_replaced(client):
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    client.get("/api/manage/console/overview")
    with db.get_connection() as conn:
        conn.execute("DELETE FROM workspace_registry WHERE id='mv'")
    out = client.get("/api/manage/console/overview").json()
    assert out["main"] is None and out["main_orphan"] == {"id": "mv"}
    before = _tiers()
    assert client.put("/api/manage/console/main", json={"workspace_id": "a"}).status_code == 409
    assert _tiers() == before


def test_main_uniqueness_is_enforced_by_index(isolated):
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    console.overview()
    with pytest.raises(Exception), db.get_connection() as conn:
        conn.execute("UPDATE workspace_console SET tier='main' WHERE workspace_id='a'")


def test_permissions(client):
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    assert client.get("/api/manage/console/overview", headers={"x-actor": "member"}).status_code == 403
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "a"}, headers={"x-actor": "member"}).status_code == 403
    assert client.get("/api/manage/console/overview", headers={"x-actor": "pm"}).status_code == 200


def test_overview_numbers_schedule_and_no_personal_data(client):
    _registry([("mv", "MILLIONVOLT", 100000), ("a", "A", 21000), ("b", "B", 18000), ("d", "D", 5)])
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, is_available) VALUES(?,?,?,?)",
            [("a", "x@example.test", "u_x", 1), ("a", "gone@example.test", "u_g", 0), ("b", "y@example.test", "u_y", 1)],
        )
    # A: 매월 1일 60,000 + 이번 주기 추가 8,000 · 그룹에 보고 안 된 사람 1명 / B: 매월 15일 40,000 / D: 할당 없음
    ga = "a" * 32
    credit.save_settings("a", revision=0, note="메모", recurring_topup=60000, topup_day=1,
                         groups=[{"id": ga, "name": "애니", "monthly_limit": 8000}],
                         members=[{"email": "x@example.test", "group_id": ga}, {"email": "new@example.test", "group_id": ga}],
                         topups=[{"day": "2026-09-10", "credits": 8000}, {"day": "2026-08-10", "credits": 999}])
    credit.save_settings("b", revision=0, note=None, groups=None, recurring_topup=40000, topup_day=15)
    manage_db.upsert_facts("x@example.test", "u_x", [{
        "local_gen_id": "f1", "job_id": "j1", "workspace_scope": "team", "workspace_id": "a", "workspace_name": "A",
        "model": "m", "output_type": "video", "status": "done", "real_credits": 46620.5, "est_credits": None,
        "created_at": "2026-09-20T03:00:00Z", "is_final": False, "is_shared": False, "is_deleted": False,
    }])

    out = client.get("/api/manage/console/overview", headers={"x-actor": "pm"}).json()
    a = next(s for s in out["subs"] if s["id"] == "a")
    assert a["next_topup_day"] == "2026-10-01" and a["topups_cycle"] == {"count": 1, "credits": 8000}
    assert a["used_cycle"] == 46620.5 and a["planned_left"] == 21379.5
    assert a["participants"] == {"reported": 1, "unconfirmed": 1}
    assert a["group_count"] == 1
    b = next(s for s in out["subs"] if s["id"] == "b")
    assert b["next_topup_day"] == "2026-10-15" and b["cycle_start"] == "2026-09-15"
    assert out["totals"]["recurring_30d"] == 100000
    # 충전일이 다르면 날짜순으로 따로 뺀다. 할당 없는 D 는 예정에 없다.
    assert [(r["day"], r["amount"], r["balance_after"]) for r in out["schedule"]] == [
        ("2026-10-01", 60000, 40000), ("2026-10-15", 40000, 0),
    ]
    assert "@" not in json.dumps(out, ensure_ascii=False)  # read_all 개요에는 이메일이 나가지 않는다


def test_occurrences_follow_period_and_anchor():
    occ = console._occurrences
    assert occ("2026-10-01", "2026-10-31", "month", None, 1) == []  # 다음 달 1일(11-01)은 30일 창 밖
    assert occ("2026-09-29", "2026-10-29", "week", "2026-09-30", 1) == [
        "2026-09-30", "2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"]
    assert occ("2026-09-29", "2026-10-02", "day", None, 1) == ["2026-09-30", "2026-10-01", "2026-10-02"]
    assert occ("2026-09-29", "2026-10-02", "day", "2026-10-01", 1) == ["2026-10-01", "2026-10-02"]  # 기준 날짜부터
    assert console._alloc_window("2026-09-29", "week", "2026-09-30", 1) == ("2026-09-23", "2026-09-29")


def test_weekly_sub_charges_every_week_in_schedule(isolated):
    _registry([("mv", "MILLIONVOLT", 10000), ("w", "W", 0)])
    credit.save_settings("w", revision=0, note=None, groups=None, recurring_topup=1000,
                         recurring_period="week", recurring_anchor="2026-09-30")
    out = console.overview()
    w = out["subs"][0]
    assert (w["recurring_period"], w["next_topup_day"], w["cycle_start"]) == ("week", "2026-09-30", "2026-09-23")
    assert out["totals"]["recurring_30d"] == 5000
    assert [r["balance_after"] for r in out["schedule"]] == [9000, 8000, 7000, 6000, 5000]
    with pytest.raises(ValueError):
        credit.save_settings("w", revision=1, note=None, groups=None, recurring_period="year")


def test_manual_recurring_leaves_schedule_and_is_kept_by_other_saves(isolated):
    _registry([("mv", "MILLIONVOLT", 1000), ("a", "A", 0), ("b", "B", 0)])
    credit.save_settings("a", revision=0, note=None, groups=None, recurring_topup=100, topup_day=1)
    credit.save_settings("b", revision=0, note="메모", groups=None, recurring_topup=200, topup_day=15, recurring_auto=False)
    assert credit.get_settings("a")["plan"]["recurring_auto"] is True  # 옛 행·기본 = 자동
    out = console.overview()
    assert [r["day"] for r in out["schedule"]] == ["2026-10-01"]  # 수동 B 는 예정표에 없다
    assert out["totals"]["recurring_30d"] == 100
    # 방식 키 없이 저장(정기 금액만·충전 기록 추가)해도 수동은 그대로
    credit.save_settings("b", revision=1, note="메모", groups=None, recurring_topup=250)
    plan = credit.get_settings("b")["plan"]
    assert (plan["recurring_auto"], plan["monthly_topup"], plan["topup_day"], plan["note"]) == (False, 250, 15, "메모")


def test_recurring_schedule_keys_through_the_route(client):
    client.headers["x-actor"] = "pm"
    _registry([("mv", "MILLIONVOLT", 0), ("w", "W", 0)])
    body = {"revision": 0, "note": "메모", "recurring_topup": 500, "recurring_auto": True,
            "recurring_period": "week", "recurring_anchor": "2026-10-07"}
    assert client.put("/api/manage/credit-plan/w", json=body).status_code == 200
    # 방식·주기·기준 날짜 키 없이 저장해도 그대로
    assert client.put("/api/manage/credit-plan/w", json={"revision": 1, "note": "메모", "recurring_topup": 600}).status_code == 200
    plan = client.get("/api/manage/credit-plan/w/settings").json()["plan"]
    assert (plan["recurring_auto"], plan["recurring_period"], plan["recurring_anchor"], plan["monthly_topup"]) == (True, "week", "2026-10-07", 600)
    bad = client.put("/api/manage/credit-plan/w", json={"revision": 2, "note": None, "recurring_period": "year"})
    assert bad.status_code == 422
    bad = client.put("/api/manage/credit-plan/w", json={"revision": 2, "note": None, "recurring_anchor": "10/07"})
    assert bad.status_code == 400


def test_calendar_lists_past_topups_and_future_recurring_without_notes(isolated):
    _registry([("mv", "MILLIONVOLT", 10000), ("w", "W", 0)])
    credit.save_settings("w", revision=0, note=None, groups=None, recurring_topup=1000, recurring_period="week",
                         recurring_anchor="2026-09-30", topups=[{"day": "2026-09-10", "credits": 300, "note": "비밀 메모"}])
    out = console.overview()
    cal = out["calendar"]
    assert (cal["from"], cal["to"]) == ("2026-06-01", "2026-12-30")
    kinds = [(e["day"], e["kind"], e["credits"]) for e in cal["events"]]
    assert kinds[0] == ("2026-09-10", "topup", 300)
    assert cal["events"][0]["topup_id"]  # 끌어 옮기기용 기록 id
    assert [d for d, k, _ in kinds if k == "recurring"][:2] == ["2026-09-30", "2026-10-07"]
    assert len([k for _, k, _ in kinds if k == "recurring"]) == 14  # 92일 안 매주
    assert "비밀 메모" not in json.dumps(out, ensure_ascii=False)
    assert "_topups" not in out["subs"][0] and "_upcoming_far" not in out["subs"][0]


def test_pool_card_totals_follow_higgsfield_relation(client):
    _registry([("mv", "MILLIONVOLT", 1000), ("a", "A", 885), ("b", "B", 10)])
    manage_db.upsert_facts("x@example.test", "u_x", [{
        "local_gen_id": "f9", "job_id": "j9", "workspace_scope": "team", "workspace_id": "a", "workspace_name": "A",
        "model": "m", "output_type": "video", "status": "done", "real_credits": 115, "est_credits": None,
        "created_at": "2026-05-01T03:00:00Z", "is_final": False, "is_shared": False, "is_deleted": False,
    }])
    t = client.get("/api/manage/console/overview").json()["totals"]
    assert (t["spent_all"], t["unused"]) == (115, 895)  # 할당됨(추정) = 1,010


def test_allocation_baseline_adds_later_topups_and_passed_recurring(client):
    client.headers["x-actor"] = "pm"
    _registry([("mv", "MILLIONVOLT", 5000), ("a", "A", 300), ("b", "B", 200)])
    credit.save_settings("a", revision=0, note=None, groups=None, recurring_topup=100, topup_day=25,
                         topups=[{"day": "2026-09-15", "credits": 70}, {"day": "2026-09-22", "credits": 50}])
    before = client.get("/api/manage/console/overview").json()["allocation"]
    assert before["source"] == "estimate"
    assert client.put("/api/manage/console/allocation-base", json={"credits": 1000, "day": "2026-09-20"}).status_code == 200
    alloc = client.get("/api/manage/console/overview").json()["allocation"]
    # 1000 + 추가 50(09-22, 기준일 뒤) + 자동 정기 100(09-25) · 09-15 추가는 기준일 전이라 이미 기준값에 들어 있다
    assert (alloc["source"], alloc["allocated"], alloc["unused"], alloc["spent"]) == ("baseline", 1150, 500, 650)
    assert client.put("/api/manage/console/allocation-base", json={"credits": 1, "day": "09/20"}).status_code == 400
    assert client.put("/api/manage/console/allocation-base", json={"credits": None}).json()["day"] is None
    assert client.get("/api/manage/console/overview").json()["allocation"]["source"] == "estimate"


def test_overview_lists_sub_project_periods(isolated):
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO project(id, name, kind, workspace_scope, workspace_id, archived) VALUES(?,?,'team','team',?,?)",
                         [("p1", "P1", "a", 0), ("p2", "P2", "a", 1)])
        conn.execute("INSERT INTO project_planning(project_id, start_date, due_date) VALUES('p1','2026-09-01','2026-10-31')")
    sub = console.overview()["subs"][0]
    assert [(p["id"], p["start_date"], p["due_date"], p["archived"]) for p in sub["projects"]] == [
        ("p1", "2026-09-01", "2026-10-31", False), ("p2", None, None, True)]  # 보관된 것도 싣고 표시


def _projects_of(ws):
    with db.get_connection() as conn:
        return [dict(r) for r in conn.execute("SELECT name, workspace_id, archived FROM project WHERE workspace_id=?", (ws,))]


def test_sub_gets_one_project_on_link_and_backfill_but_main_does_not(client):
    client.headers["x-actor"] = "pm"
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    client.get("/api/manage/console/overview", headers={"x-actor": "admin"})  # admin 은 read_all 만 — 조회로 프로젝트를 만들지 않는다
    assert _projects_of("a") == []
    client.get("/api/manage/console/overview")  # PM(create_project) 조회 = 1회 채우기: 서브 A 에 프로젝트, 메인은 없음
    assert [p["name"] for p in _projects_of("a")] == ["A"] and _projects_of("mv") == []
    # 다른 워크스페이스에 같은 이름의 활성 프로젝트가 있으면 이름 뒤에 id 를 붙여 남의 것을 가져오지 않는다
    _registry([("c", "A", 0)])
    res = client.post("/api/manage/console/workspaces", json={"workspace_id": "c"}).json()
    assert res["project_created"] is True and [p["name"] for p in _projects_of("c")] == ["A (c)"]
    # 이미 프로젝트가 있으면 다시 만들지 않는다(재연결)
    assert client.post("/api/manage/console/workspaces", json={"workspace_id": "c"}).json()["project_created"] is False
    assert "project.created" in [e["action"] for e in event_journal.list_audit_events(limit=100)]


def test_switch_after_done_opens_no_write_transaction(isolated, monkeypatch):
    """2026-10-01 점검 R1-6 — 전환이 끝난 뒤 콘솔을 다시 열어도 쓰기 잠금(BEGIN IMMEDIATE)을 잡지 않는다."""
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    console.overview(backfill_projects=True)  # 시드 + 1회 전환
    writes = []
    real_write = console._write
    monkeypatch.setattr(console, "_write", lambda fn: (writes.append(fn), real_write(fn))[1])
    console._switch_to_console_credits("u_pm")
    console._switch_to_console_credits("u_pm")
    assert writes == []


def _pid_of(ws):
    with db.get_connection() as conn:
        return conn.execute("SELECT id FROM project WHERE workspace_id=?", (ws,)).fetchone()["id"]


def test_switch_copies_budget_then_console_owns_credits_status_and_archive(client):
    """설계 §13 — 전환(1회 옮기기) 전엔 종전대로, 뒤엔 서브스페이스 값만: 파생 끔·대시보드 서브스페이스 값·구버전 예산/상태/보관 쓰기 거절."""
    from app.repo import manage as repo_manage, projects as repo_projects

    client.headers["x-actor"] = "pm"
    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 100), ("b", "B", 0)])
    console.overview()  # 시드만(채우기·전환 없음)
    console.ensure_sub_project("a", "u_pm")
    pa = _pid_of("a")
    repo_manage.set_planning(pa, status="active", budget_credits=500, budget_period="month")
    assert repo_manage.dashboard_summary({}, "a")["projects"][0]["console_limit"] is None  # 전환 전 = 종전 예산 표시
    repo_manage.set_planning(pa, status="active", budget_credits=600, budget_period="month")  # 전환 전엔 막지 않는다

    client.get("/api/manage/console/overview")  # PM 열기 = 채우기 + 전환
    settings = credit.get_settings("a")["plan"]
    assert (settings["recurring_topup"], settings["monthly_topup_source"]) == (600, "manual")  # 옛 예산을 잃지 않는다
    # 전환 뒤: 예산이 바뀌어도 파생되지 않고, 구버전의 예산 변경은 거절, 읽은 값을 되보내며 기간만 바꾸면 통과
    body = {"status": "active", "start_date": "2026-10-01", "due_date": None, "budget_credits": 600, "budget_period": "month"}
    assert client.put(f"/api/manage/planning/{pa}", json=body).status_code == 200
    assert client.put(f"/api/manage/planning/{pa}", json={**body, "budget_credits": 900}).status_code == 400
    assert client.put(f"/api/manage/planning/{pa}", json={**body, "budget_period": None}).status_code == 200  # 구버전: 주기 안 보냄
    # 상태·보관은 콘솔 상태의 짝일 때만
    assert client.put(f"/api/manage/planning/{pa}", json={**body, "status": "hold"}).status_code == 400
    with pytest.raises(console.ConsoleManaged):
        repo_projects.update_project_identity(pa, archived=True)
    console.set_status("a", "done", "u_pm")
    repo_projects.update_project_identity(pa, archived=True)
    assert client.put(f"/api/manage/planning/{pa}", json={**body, "status": "done"}).status_code == 200
    console.set_status("a", "active", "u_pm")
    repo_projects.update_project_identity(pa, archived=False)
    # 서브스페이스에서 정기를 비우면 '없음'(파생으로 돌아가지 않는다)
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_credit_plan SET recurring_topup=NULL WHERE workspace_id='a'")
    assert credit.get_settings("a")["plan"]["monthly_topup_source"] == "none"
    with db.get_connection() as conn:
        conn.execute("UPDATE workspace_credit_plan SET recurring_topup=1000 WHERE workspace_id='a'")
        conn.execute("INSERT INTO workspace_credit_topup(id, workspace_id, day, credits) VALUES('t1','a',?,250)", (TODAY,))
    limit = repo_manage.dashboard_summary({}, "a")["projects"][0]["console_limit"]
    assert (limit["credits"], limit["topups_cycle"], limit["period"], limit["shared_projects"]) == (1000, 250, "month", 1)
    assert limit["balance"] == 100  # 서브스페이스 서브 표와 같은 '남은 크레딧'(보고 잔액)
    # 관리 표(§14): '서브스페이스가 정한다' 표식은 늘, 금액은 크레딧을 볼 수 있을 때만
    from app.repo import manage_member_table

    blind = manage_member_table.member_table("a", with_credit=False)
    assert blind["projects"][0]["console_managed"] is True and blind["projects"][0]["console_limit"] is None and blind["console_limit"] is None
    assert blind["projects"][0]["workspace_name"] == "A"  # 이름 옆 워크스페이스 배지
    full = manage_member_table.member_table("a", with_credit=True)
    assert full["console_limit"]["credits"] == 1000 and full["console_limit"]["topup_day"] == 1
    # §16 요약용 상세 — 서브스페이스 개요와 같은 값(잔액·이번 주기 추가 건수·Next)
    sub = next(x for x in console.overview()["subs"] if x["id"] == "a")
    detail = full["console_limit"]
    assert (detail["balance"], detail["topups_count"], detail["next_topup_day"], detail["used_cycle"]) == (
        sub["balance"], sub["topups_cycle"]["count"], sub["next_topup_day"], sub["used_cycle"])
    # 전환 뒤 새로 연결한 서브도 옛 예산을 서브스페이스로 옮긴다 / 메인은 대상 아님
    console.set_archived("b", True, "u_pm")
    console.ensure_sub_project("b", "u_pm")
    pb = _pid_of("b")
    repo_manage.set_planning(pb, status="active", budget_credits=300, budget_period="month")  # 내린 서브 = 보호 없음
    client.post("/api/manage/console/workspaces", json={"workspace_id": "b"})
    assert credit.get_settings("b")["plan"]["recurring_topup"] == 300
    with db.get_connection() as conn:
        assert console.console_limits(conn, ["mv"]) == {}


def test_member_table_main_lists_every_linked_sub_project(isolated):
    """관리 표에서 메인을 고르면 서브스페이스 메인처럼 연결된 서브 프로젝트를 모두(보관 포함) — 내린 서브·다른 곳은 빼고."""
    from app.repo import manage_member_table

    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0), ("b", "B", 0), ("c", "C", 0)])
    console.overview()  # 시드: mv=메인, a·b·c=서브
    console.set_archived("c", True, "u_pm")
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, archived, sort_order) VALUES(?,?,'team','team',?,?,?)",
            [("pm", "PM", "mv", 0, 0), ("pa", "PA", "a", 0, 1), ("pb", "PB", "b", 1, 2), ("pc", "PC", "c", 0, 3)])
    main = manage_member_table.member_table("mv", with_credit=False)["projects"]
    assert [(p["id"], p["workspace_id"], p["archived"]) for p in main] == [
        ("pm", "mv", False), ("pa", "a", False), ("pb", "b", True)]
    assert [p["id"] for p in manage_member_table.member_table("a", with_credit=False)["projects"]] == ["pa"]  # 서브는 종전대로
    # 크레딧 시트 합본용 — 서브 목록·순서는 서브스페이스 왼쪽 목록(프로젝트 없는 서브 d 도, 내린 c 는 빼고), 잔액은 크레딧 권한일 때만
    _registry([("d", "D", 0)])
    console.link_sub("d", "u_pm")
    blind = manage_member_table.member_table("mv", with_credit=False)
    assert (blind["console_subs"], blind["main_balance"]) == (["a", "b", "d"], None)
    assert manage_member_table.member_table("mv", with_credit=True)["main_balance"]["credits"] == 0
    assert manage_member_table.member_table("a", with_credit=True)["console_subs"] is None


def test_member_table_main_lists_every_visible_account(isolated):
    """메인 = 전체 보기(Jay 2026-10-02): 메인 보고자 + 서브에만 있는 사람 + 아직 보고 전인 가입 계정, 숨긴 계정만 뺀다. 서브는 종전대로."""
    from app.repo import manage_member_table

    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0)])
    console.overview()  # 시드: mv=메인, a=서브
    with db.get_connection() as conn:
        conn.executemany(
            "INSERT INTO account(email, name, password_hash, status, creator_uid, hidden) VALUES(?,?,'h',?,?,?)",
            [("m@x", "메인", "approved", "u_m", 0), ("s@x", "서브만", "approved", "acct:s@x", 0),
             ("n@x", "보고전", "pending", None, 0), ("h@x", "숨김", "rejected", None, 1),
             ("admin@millionvolt.com", "시스템", "approved", None, 0)],
        )
        conn.executemany(
            "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, user_role, is_selected, is_available) "
            "VALUES(?,?,?,'member',1,1)",
            [("mv", "m@x", "u_m"), ("a", "s@x", "acct:s@x")],
        )
    rows = {r["email"]: r for r in manage_member_table.member_table("mv", with_credit=False)["rows"]}
    # 메인 보고자 먼저, 나머지는 이름순 · 숨김·시스템 계정 제외(필터 없는 옛 앱에도 안 보이게 — Codex main 검토 P2-1)
    assert list(rows) == ["m@x", "n@x", "s@x"]
    assert (rows["m@x"]["is_available"], rows["s@x"]["is_available"], rows["s@x"]["project_lock"]) == (True, False, "unlinked")
    assert [r["email"] for r in manage_member_table.member_table("a", with_credit=False)["rows"]] == ["s@x"]


def test_workspace_options_carry_console_tier(isolated):
    """대시보드 선택기의 메인·서브 칩 — 메인·연결된 서브만, 내린 서브·미연결은 None."""
    from app.repo import identity

    _registry([("mv", "MILLIONVOLT", 0), ("a", "A", 0), ("b", "B", 0)])
    console.overview()  # 시드: mv=메인, a·b=서브
    console.set_archived("b", True, "u_pm")
    _registry([("c", "C", 0)])  # 시드 뒤 보고 = 연결 대기
    tiers = {w["id"]: w["console_tier"] for w in identity.list_workspace_options()}
    assert tiers == {"mv": "main", "a": "sub", "b": None, "c": None}
    # 순서 = 서브스페이스 왼쪽 목록(상태 묶음 → 프로젝트 순서 → 이름): 이름순이면 a 가 먼저지만 d 프로젝트가 앞이고, 비활성 e 는 뒤
    _registry([("d", "D", 0), ("e", "E", 0)])
    console.link_sub("d", "u_pm"); console.link_sub("e", "u_pm")
    console.set_status("e", "inactive", "u_pm")
    with db.get_connection() as conn:
        conn.executemany("INSERT INTO project(id, name, kind, workspace_scope, workspace_id, sort_order) VALUES(?,?,'team','team',?,?)",
                         [("pa", "PA", "a", 5), ("pd", "PD", "d", 1), ("pe", "PE", "e", 0)])
    order = {w["id"]: w["console_order"] for w in identity.list_workspace_options() if w["console_order"] is not None}
    assert sorted(order, key=order.get) == ["mv", "d", "a", "e"]
