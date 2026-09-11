"""크레딧 풀 · 그룹 한도 · 잔액 추이 (repo/manage_credit_plan + 라우터). Jay 결정 2026-09-10.

힉스필드가 한도를 강제하고 우리는 보여주기만 한다. 여기서 고정하는 규칙:
- 사용량 = 워크스페이스 팩트(삭제분 포함, 미분류 포함), 월 = localtime, 크레딧 = COALESCE(실제, 견적, 0), 미상 따로.
- 그룹 남은 양 = base_balance + 한도 × 개월 수 − base 이후 사용. 한도·소속 변경 시 저장 직전 남은 양이 이어진다(재기준화).
- 저장은 revision 낙관적 잠금(409). 설정 권한 = 전역 create_project(PM). 멤버는 자기 그룹 하나만.
"""
import os
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from app import db, manage_db, repo
from app import deps as deps_mod
from app.repo import manage
from app.repo import manage_credit_plan as plan_repo
from app.routers import manage as manage_router


class DummyState:
    pass


class DummyRequest:
    def __init__(self, account: dict | None):
        self.state = DummyState()
        self.state.account = account


def auth_on():
    stack = ExitStack()
    stack.enter_context(mock.patch.object(deps_mod, "AUTH_ENABLED", True))
    stack.enter_context(mock.patch.object(manage_router, "AUTH_ENABLED", True))
    return stack


def _acc(email: str, uid: str | None, role: str = "member") -> DummyRequest:
    return DummyRequest({"email": email, "status": "approved", "global_role": role, "creator_uid": uid})


def _iso(delta_days: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=delta_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fact(gid: str, **kw) -> dict:
    base = {
        "local_gen_id": gid, "job_id": f"job-{gid}", "workspace_scope": "team", "workspace_id": "ws1",
        "workspace_name": "WS1", "project_id": "p1", "project_name": "P", "folder_path": "e001/c0010",
        "model": "seedance", "output_type": "video", "status": "done", "real_credits": None, "est_credits": None,
        "created_at": _iso(0), "is_final": False, "is_shared": False, "is_deleted": False,
    }
    base.update(kw)
    return base


WS = {"id": "ws1", "name": "WS1", "plan_type": "enterprise", "user_role": "member", "is_selected": True}


class CreditPlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"  # 사용자 DB 격리
        db.flush_pool()
        db.init_db()
        manage_db.init_manage_db()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_a', '제이')")
            conn.execute(
                "INSERT INTO account(email, name, password_hash, status, creator_uid) "
                "VALUES('a@x', 'A', 'h', 'approved', 'u_a')"
            )
            conn.executemany(
                "INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES(?,?,?,?)",
                [("ws1", "WS1", "enterprise", 7865), ("ws2", "WS2", "enterprise", 50)],
            )
            conn.executemany(
                "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, user_role, is_selected, "
                "is_available) VALUES(?,?,?,?,?,?)",
                [
                    ("ws1", "a@x", "u_a", "member", 1, 1),
                    ("ws1", "b@x", "u_b", "member", 1, 1),
                    ("ws1", "c@x", "u_c", "member", 0, 0),  # 접근 불가 이력 — 배정 후보에서 뒤로, 사용은 셈
                    ("ws2", "d@x", "u_d", "member", 1, 1),
                ],
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p1', 'P', 'team', 'team', 'ws1', 'WS1')"
            )
        # 월 충전액은 손 입력이 아니라 프로젝트 '예산 한도(매월)' 합에서 파생된다.
        manage.set_planning("p1", budget_credits=20000, budget_period="month")
        # 이번 달: a = 100(실제) + 50(견적) + 미상 + 20(삭제분) = 170 · 미상 1, b = 30, c = 5. 지난달 b = 70.
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("f1", real_credits=100), _fact("f2", est_credits=50), _fact("f3"),
            _fact("f4", real_credits=20, is_deleted=True, deleted_at=_iso(0)),
        ])
        manage_db.upsert_facts("b@x", "u_b", [
            _fact("f5", creator_uid="u_b", real_credits=30),
            _fact("f6", creator_uid="u_b", real_credits=70, created_at=_iso(-35)),
        ])
        manage_db.upsert_facts("c@x", "u_c", [_fact("f7", creator_uid="u_c", real_credits=5)])
        self.month = plan_repo.current_month()

    def tearDown(self) -> None:
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    # ── 도우미 ──
    def _save(self, revision: int, groups: list[dict], members: list[dict], topups: list[dict] | None = None) -> dict:
        return plan_repo.save_settings(
            "ws1", revision=revision, note=None, groups=groups, members=members, topups=topups
        )

    def _group(self, view: dict, name: str) -> dict:
        return next(g for g in view["groups"] if g["name"] == name)

    def _seed_artist_td(self) -> dict:
        return self._save(
            0,
            [{"name": "Artist", "monthly_limit": 1000}, {"name": "TD", "monthly_limit": None}],
            [],
        )

    def _assign(self, settings: dict, mapping: dict[str, str | None]) -> list[dict]:
        ids = {g["name"]: g["id"] for g in settings["groups"]}
        return [{"email": e, "group_id": (ids[n] if n else None)} for e, n in mapping.items()]

    # ── 집계 원천 ──
    def test_month_clock_matches_sqlite_localtime(self) -> None:
        with manage_db.get_connection() as conn:
            sql_month = conn.execute("SELECT strftime('%Y-%m','now','localtime')").fetchone()[0]
        self.assertEqual(self.month, sql_month)

    def test_workspace_email_usage_counts_deleted_and_unknown_by_localtime_day(self) -> None:
        with manage_db.get_connection() as conn:
            today = conn.execute("SELECT date('now','localtime')").fetchone()[0]
        rows = {(r["day"], r["email"]): r for r in manage_db.workspace_email_usage("ws1")}
        a = rows[(today, "a@x")]
        self.assertEqual((round(a["credits"]), a["count"], a["unknown"]), (170, 4, 1))
        self.assertEqual(round(rows[(today, "b@x")]["credits"]), 30)
        # UTC 8/31 20:00 은 KST 9/1 — 날짜 판정은 localtime. 기대값은 sqlite 자신에게 물어 시간대 무관하게 고정.
        manage_db.upsert_facts("a@x", "u_a", [_fact("edge", real_credits=1, created_at="2026-08-31T20:00:00Z")])
        with manage_db.get_connection() as conn:
            expected = conn.execute("SELECT date('2026-08-31T20:00:00Z', 'localtime')").fetchone()[0]
        rows = manage_db.workspace_email_usage("ws1", "2026-08-01")
        self.assertTrue(any(r["day"] == expected and r["email"] == "a@x" for r in rows))
        self.assertEqual(manage_db.workspace_email_usage("ws-none"), [])

    # ── 설정 저장·재기준화 ──
    def test_unconfigured_view_shows_pool_usage_and_unassigned(self) -> None:
        view = plan_repo.plan_view("ws1")
        self.assertFalse(view["configured"])
        self.assertEqual(view["pool"]["used_month"], 205)  # 170 + 30 + 5 (c 는 접근 불가여도 돈은 나감)
        self.assertEqual(view["pool"]["unknown_month"], 1)
        self.assertEqual(view["pool"]["balance"], 7865)
        self.assertEqual(view["pool"]["monthly_topup"], 20000)  # 설정 전이어도 예산 한도(매월)에서 파생
        self.assertEqual(view["pool"]["topups_month"], {"count": 0, "credits": 0})
        self.assertEqual(view["groups"], [])
        self.assertEqual(view["unassigned"]["member_count"], 2)  # available 만 인원으로
        self.assertEqual(view["unassigned"]["used_month"], 205)

    def test_save_then_manager_view(self) -> None:
        settings = self._seed_artist_td()
        self.assertEqual(settings["plan"]["revision"], 1)
        settings = self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]}
                                  for g in settings["groups"]],
                              self._assign(settings, {"a@x": "Artist", "b@x": "Artist"}))
        self.assertEqual(settings["plan"]["revision"], 2)
        view = plan_repo.plan_view("ws1")
        self.assertTrue(view["configured"])
        self.assertEqual(view["pool"]["monthly_topup"], 20000)
        artist = self._group(view, "Artist")
        self.assertEqual((artist["member_count"], artist["used_month"], artist["unknown_month"]), (2, 200, 1))
        self.assertEqual(artist["remaining"], 800)  # 0 + 1000 × 1 − 200
        self.assertTrue(artist["estimated"])
        td = self._group(view, "TD")
        self.assertEqual((td["remaining"], td["used_month"], td["member_count"]), (None, 0, 0))
        self.assertEqual((view["unassigned"]["member_count"], view["unassigned"]["used_month"]), (0, 5))
        # 설정 창 멤버 목록: 접근 불가 c 도 포함(과거 배정 보존용), 이름은 creator → 이메일 앞부분
        members = {m["email"]: m for m in settings["members"]}
        self.assertEqual(members["a@x"]["name"], "제이")
        self.assertFalse(members["c@x"]["is_available"])
        self.assertEqual(members["b@x"]["group_id"], self._group(settings, "Artist")["id"])

    def test_limit_change_rebaselines_so_remaining_continues(self) -> None:
        settings = self._seed_artist_td()
        settings = self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]}
                                  for g in settings["groups"]],
                              self._assign(settings, {"a@x": "Artist", "b@x": "Artist"}))
        artist_id = self._group(settings, "Artist")["id"]
        settings = self._save(2, [{"id": artist_id, "name": "Artist", "monthly_limit": 2000}], [])
        artist = self._group(settings, "Artist")
        # 이번 달 한도가 2000 이 됐으니 남은 양 = 이월 0 + 2000 − 이번 달 사용 200. 과거 달은 건드리지 않는다.
        self.assertEqual(artist["remaining"], 1800)
        self.assertEqual((artist["base_start"], artist["base_balance"]), (f"{self.month}-01", 0))
        self.assertEqual([g["name"] for g in settings["groups"]], ["Artist"])  # TD 는 목록에서 빠져 삭제

    def test_carry_over_across_months_is_not_rewritten_by_a_change(self) -> None:
        settings = self._seed_artist_td()
        settings = self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]}
                                  for g in settings["groups"]],
                              self._assign(settings, {"b@x": "Artist"}))
        artist_id = self._group(settings, "Artist")["id"]
        y, m = (int(x) for x in self.month.split("-"))
        last_month = f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"
        with db.get_connection() as conn:  # 지난달부터 운영해 온 그룹으로 만든다(이월 검증용)
            conn.execute("UPDATE workspace_credit_group SET base_start=? WHERE id=?", (f"{last_month}-01", artist_id))
        artist = self._group(plan_repo.plan_view("ws1"), "Artist")
        self.assertEqual(artist["remaining"], 1900)  # 0 + 1000 × 2개월 − (지난달 70 + 이번 달 30)
        # 이번 달 한도를 2000 으로 — 지난달은 그대로(1000 − 70 = 930 이월), 이번 달만 새 한도.
        settings = self._save(2, [{"id": artist_id, "name": "Artist", "monthly_limit": 2000}], [])
        artist = self._group(settings, "Artist")
        self.assertEqual((artist["base_start"], artist["base_balance"], artist["remaining"]), (f"{self.month}-01", 930, 2900))

    def test_member_move_rebaselines_both_groups(self) -> None:
        settings = self._seed_artist_td()
        settings = self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]}
                                  for g in settings["groups"]],
                              self._assign(settings, {"a@x": "Artist", "b@x": "Artist"}))
        groups_in = [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]} for g in settings["groups"]]
        settings = self._save(2, groups_in, self._assign(settings, {"b@x": "TD"}))  # a 는 안 적음 → 그대로
        artist = self._group(settings, "Artist")
        # b 가 빠지면 이번 달 사용도 b 몫이 빠져 남은 양이 늘어난다(이번 달은 현재 소속으로 다시 셈).
        self.assertEqual((artist["member_count"], artist["used_month"], artist["remaining"]), (1, 170, 830))
        td = self._group(settings, "TD")
        self.assertEqual((td["member_count"], td["used_month"], td["remaining"]), (1, 30, None))

    def test_remaining_override_and_fresh_group(self) -> None:
        settings = self._seed_artist_td()
        artist_id = self._group(settings, "Artist")["id"]
        settings = self._save(
            1,
            [{"id": artist_id, "name": "Artist", "monthly_limit": 1000, "remaining_override": 500},
             {"name": "New", "monthly_limit": 300}],
            self._assign(settings, {"a@x": "Artist"}) + [{"email": "B@X ", "group_id": None}],
        )
        self.assertEqual(self._group(settings, "Artist")["remaining"], 500)
        new = self._group(settings, "New")
        self.assertEqual((new["remaining"], new["base_balance"]), (300, 0))  # 새 그룹은 이번 달 한도에서 시작
        settings = self._save(2, [{"id": new["id"], "name": "New", "monthly_limit": 300}],
                              [{"email": "B@X ", "group_id": new["id"]}])  # 이메일 정규화
        self.assertEqual(self._group(settings, "New")["used_month"], 30)

    def test_recreate_same_name_and_swap_names(self) -> None:
        settings = self._seed_artist_td()
        ids = {g["name"]: g["id"] for g in settings["groups"]}
        # 삭제한 이름으로 새 그룹 + 남은 두 그룹 이름 맞바꾸기 — UNIQUE 충돌로 죽으면 안 된다(코덱스 P2).
        settings = self._save(1, [{"name": "Artist", "monthly_limit": 500}, {"id": ids["TD"], "name": "Artist2", "monthly_limit": None}], [])
        self.assertEqual([g["name"] for g in settings["groups"]], ["Artist", "Artist2"])
        self.assertNotEqual(self._group(settings, "Artist")["id"], ids["Artist"])
        ids = {g["name"]: g["id"] for g in settings["groups"]}
        settings = self._save(2, [{"id": ids["Artist"], "name": "Artist2", "monthly_limit": 500},
                                  {"id": ids["Artist2"], "name": "Artist", "monthly_limit": None}], [])
        self.assertEqual({g["id"]: g["name"] for g in settings["groups"]}, {ids["Artist"]: "Artist2", ids["Artist2"]: "Artist"})

    def test_client_supplied_group_id_allows_assignment_in_one_save(self) -> None:
        gid = "0123456789abcdef0123456789abcdef"
        settings = self._save(0, [{"id": gid, "name": "Artist", "monthly_limit": 1000}],
                              [{"email": "a@x", "group_id": gid}, {"email": "b@x", "group_id": gid}])
        artist = self._group(settings, "Artist")
        self.assertEqual((artist["id"], artist["member_count"], artist["remaining"]), (gid, 2, 800))
        # 다른 워크스페이스가 쓰는 id 는 거부 — 형식이 맞아도 소유 검증.
        with db.get_connection() as conn:
            conn.execute("INSERT INTO workspace_credit_group(id, workspace_id, name, base_start) VALUES(?,?,?,?)",
                         ("f" * 32, "ws2", "Other", f"{self.month}-01"))
        with self.assertRaises(ValueError):
            self._save(1, [{"id": gid, "name": "Artist", "monthly_limit": 1000}, {"id": "f" * 32, "name": "X", "monthly_limit": 1}], [])

    def test_revision_conflict_and_bad_group(self) -> None:
        self._seed_artist_td()
        with self.assertRaises(plan_repo.CreditPlanConflict):
            self._save(0, [], [])
        with self.assertRaises(ValueError):
            self._save(1, [{"name": "X", "monthly_limit": 1}], [{"email": "a@x", "group_id": "nope"}])
        with self.assertRaises(ValueError):  # uuid hex 형식이 아닌 id
            self._save(1, [{"id": "not-mine", "name": "X", "monthly_limit": 1}], [])

    # ── 멤버 뷰 ──
    def test_member_view_only_own_group(self) -> None:
        settings = self._seed_artist_td()
        self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]}
                       for g in settings["groups"]],
                   self._assign(settings, {"a@x": "Artist", "b@x": "Artist"}))
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))
        self.assertEqual(set(view), {"month", "cycle_start", "cycle_end", "configured", "my_group"})
        mine = view["my_group"]
        self.assertEqual((mine["name"], mine["used_month"], mine["my_used_month"], mine["remaining"]), ("Artist", 200, 170, 800))
        self.assertNotIn("base_balance", mine)
        self.assertIsNone(plan_repo.plan_view("ws1", viewer=("u_c", "c@x"))["my_group"])

    # ── 그룹이 쓸 수 있는 모델(허용 목록, 빈 목록=제한 없음) ──
    def test_allowed_models_save_contract(self) -> None:
        # 정규화: 공백·대문자·중복·빈 값 정리, 첫 등장 순서 유지
        settings = self._save(
            0,
            [{"name": "Artist", "monthly_limit": 1000,
              "allowed_models": [" Seedance_2_5 ", "seedance_2_5", "", "nano_banana_pro"]},
             {"name": "TD", "monthly_limit": None}],
            [],
        )
        artist = self._group(settings, "Artist")
        self.assertEqual(artist["allowed_models"], ["seedance_2_5", "nano_banana_pro"])
        self.assertEqual(self._group(settings, "TD")["allowed_models"], [])  # 빈 목록 = 제한 없음
        ids = {g["name"]: g["id"] for g in settings["groups"]}
        base = (artist["base_start"], artist["base_balance"])

        # 키 없음(구버전 앱·'추정' 맞추기 재전송) = 기존값 유지 · 모델만 바꾸는 저장은 재기준화 없이 반영
        settings = self._save(1, [{"id": ids["Artist"], "name": "Artist", "monthly_limit": 1000},
                                  {"id": ids["TD"], "name": "TD", "monthly_limit": None}], [])
        self.assertEqual(self._group(settings, "Artist")["allowed_models"], ["seedance_2_5", "nano_banana_pro"])
        settings = self._save(2, [{"id": ids["Artist"], "name": "Artist", "monthly_limit": 1000,
                                   "allowed_models": ["gpt_image_2"]},
                                  {"id": ids["TD"], "name": "TD", "monthly_limit": None}], [])
        artist = self._group(settings, "Artist")
        self.assertEqual(artist["allowed_models"], ["gpt_image_2"])
        self.assertEqual((artist["base_start"], artist["base_balance"]), base)
        # 명시 [] = 제한 없음으로 되돌림
        settings = self._save(3, [{"id": ids["Artist"], "name": "Artist", "monthly_limit": 1000, "allowed_models": []},
                                  {"id": ids["TD"], "name": "TD", "monthly_limit": None}], [])
        self.assertEqual(self._group(settings, "Artist")["allowed_models"], [])
        # 이름 맞바꾸기는 id 기준이라 설정이 따라간다 · 삭제 뒤 같은 이름의 새 그룹은 빈 목록
        settings = self._save(4, [{"id": ids["Artist"], "name": "TD", "monthly_limit": 1000, "allowed_models": ["z_image"]},
                                  {"id": ids["TD"], "name": "Artist", "monthly_limit": None}], [])
        self.assertEqual(next(g for g in settings["groups"] if g["id"] == ids["Artist"])["allowed_models"], ["z_image"])
        settings = self._save(5, [{"id": ids["TD"], "name": "Artist", "monthly_limit": None}], [])
        settings = self._save(6, [{"id": ids["TD"], "name": "Artist", "monthly_limit": None},
                                  {"name": "TD", "monthly_limit": 10}], [])
        self.assertEqual(self._group(settings, "TD")["allowed_models"], [])
        # 형식·개수 위반은 ValueError(→400)
        for bad in (["bad-id!"], ["x" * 65], [f"m{i}" for i in range(65)], "seedance_2_5", [1]):
            with self.assertRaises(ValueError):
                self._save(7, [{"id": ids["TD"], "name": "Artist", "monthly_limit": None, "allowed_models": bad}], [])
        # 그룹 이름 바꾸기 + 미상 id 보존(미래 모델·구버전 앱)
        settings = self._save(7, [{"id": ids["TD"], "name": "Artist", "monthly_limit": None,
                                   "allowed_models": ["future_model_9"]}], [])
        self.assertEqual(self._group(settings, "Artist")["allowed_models"], ["future_model_9"])

    def test_my_models_and_router(self) -> None:
        settings = self._save(
            0,
            [{"name": "Artist", "monthly_limit": 1000, "allowed_models": ["seedance_2_5"]},
             {"name": "TD", "monthly_limit": None}],
            [],
        )
        self._save(1, [{"id": g["id"], "name": g["name"], "monthly_limit": g["monthly_limit"]} for g in settings["groups"]],
                   self._assign(settings, {"a@x": "Artist", "b@x": "TD"}))
        artist_id = self._group(settings, "Artist")["id"]
        mine = plan_repo.my_models("ws1", "A@X")  # 이메일 정규형으로 대조
        self.assertEqual((mine["group_id"], mine["group_name"], mine["allowed_models"], mine["revision"]),
                         (artist_id, "Artist", ["seedance_2_5"], 2))
        self.assertEqual(plan_repo.my_models("ws1", "b@x")["allowed_models"], [])  # 설정 없는 그룹 = 제한 없음
        unassigned = plan_repo.my_models("ws1", "c@x")
        self.assertEqual((unassigned["group_id"], unassigned["allowed_models"], unassigned["revision"]), (None, [], 2))
        # 멤버 뷰(my_group)와 매니저 뷰(groups)에도 실린다
        self.assertEqual(plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]["allowed_models"], ["seedance_2_5"])
        self.assertEqual(self._group(plan_repo.plan_view("ws1"), "Artist")["allowed_models"], ["seedance_2_5"])
        # 라우터: 멤버·매니저(본인 이메일)·비멤버 403·workspace_id 없음 400·AUTH off 는 빈 목록
        member = _acc("a@x", "u_a")
        pm = _acc("b@x", "u_b", "product_manager")
        with auth_on():
            self.assertEqual(manage_router.credit_plan_my_models(member, workspace_id="ws1")["allowed_models"], ["seedance_2_5"])
            self.assertEqual(manage_router.credit_plan_my_models(pm, workspace_id="ws1")["group_name"], "TD")
            for req, ws, code in ((member, "ws2", 403), (_acc("z@x", "u_z"), "ws1", 403), (member, "", 400)):
                with self.assertRaises(HTTPException) as ctx:
                    manage_router.credit_plan_my_models(req, workspace_id=ws)
                self.assertEqual(ctx.exception.status_code, code)
        self.assertEqual(manage_router.credit_plan_my_models(member, workspace_id="ws1")["allowed_models"], [])

    # ── 라우터 게이트 ──
    def test_router_gates(self) -> None:
        member = _acc("a@x", "u_a")
        pm = _acc("pm@x", "u_pm", "product_manager")
        with auth_on():
            for call in (
                lambda: manage_router.credit_plan_settings("ws1", member),
                lambda: manage_router.put_credit_plan("ws1", manage_router.CreditPlanIn(), member),
            ):
                with self.assertRaises(HTTPException) as ctx:
                    call()
                self.assertEqual(ctx.exception.status_code, 403)
            with self.assertRaises(HTTPException) as ctx:
                manage_router.credit_plan(member, workspace_id="ws2")  # 소속 아님
            self.assertEqual(ctx.exception.status_code, 403)
            with self.assertRaises(HTTPException) as ctx:
                manage_router.credit_plan(member, workspace_id="")
            self.assertEqual(ctx.exception.status_code, 400)
            with self.assertRaises(HTTPException) as ctx:
                manage_router.credit_plan_settings("ws-unknown", pm)
            self.assertEqual(ctx.exception.status_code, 404)
            self.assertEqual(manage_router.credit_plan(member, workspace_id="ws1")["my_group"], None)
            saved = manage_router.put_credit_plan(
                "ws1",
                manage_router.CreditPlanIn(revision=0,
                                           groups=[manage_router.CreditGroupIn(name="Artist", monthly_limit=1000)],
                                           topups=[manage_router.CreditTopupIn(day=f"{self.month}-02", credits=500)]),
                pm,
            )
            self.assertEqual(saved["plan"]["revision"], 1)
            with self.assertRaises(HTTPException) as ctx:
                manage_router.put_credit_plan("ws1", manage_router.CreditPlanIn(revision=0), pm)
            self.assertEqual(ctx.exception.status_code, 409)
            full = manage_router.credit_plan(pm, workspace_id="ws1")
            self.assertIn("pool", full)
            self.assertEqual(manage_router.credit_plan_settings("ws1", pm)["plan"]["revision"], 1)

    def test_day_and_week_limits_carry_over_by_period(self) -> None:
        # a 의 이번 달 170 은 전부 '지금' 만든 것 → 오늘·이번 주 사용도 170. b 는 이번 주 30(지난달 70 은 밖).
        # 일·주 한도도 enterprise 라 이월된다(Jay) — 기준일부터 지난 기간 수 × 한도가 쌓이고 사용만큼 빠진다.
        settings = self._save(0, [{"name": "Daily", "monthly_limit": 500, "limit_period": "day"},
                                  {"name": "Weekly", "monthly_limit": 100, "limit_period": "week"}], [])
        ids = {g["name"]: g["id"] for g in settings["groups"]}
        settings = self._save(1, [{"id": ids["Daily"], "name": "Daily", "monthly_limit": 500, "limit_period": "day"},
                                  {"id": ids["Weekly"], "name": "Weekly", "monthly_limit": 100, "limit_period": "week"}],
                              [{"email": "a@x", "group_id": ids["Daily"]}, {"email": "b@x", "group_id": ids["Weekly"]}])
        daily = self._group(settings, "Daily")
        self.assertEqual((daily["limit_period"], daily["used_period"], daily["remaining"], daily["unknown_period"]), ("day", 170, 330, 1))
        weekly = self._group(settings, "Weekly")
        self.assertEqual((weekly["limit_period"], weekly["used_period"], weekly["remaining"]), ("week", 30, 70))
        self.assertTrue(daily["estimated"])
        # 어제부터 운영한 매일 그룹: 어제분 한도 500 이 이월 → 0 + 500×2 − 170 = 830
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        with db.get_connection() as conn:
            conn.execute("UPDATE workspace_credit_group SET base_start=? WHERE id=?", (yesterday, ids["Daily"]))
        self.assertEqual(self._group(plan_repo.plan_view("ws1"), "Daily")["remaining"], 830)
        # 매일 → 매월로 바꾸면 옛 주기로 이월분(어제까지 500)을 넘기고 이번 달은 새 주기로: 500 + 500 − 170 = 830
        settings = self._save(2, [{"id": ids["Daily"], "name": "Daily", "monthly_limit": 500, "limit_period": "month"},
                                  {"id": ids["Weekly"], "name": "Weekly", "monthly_limit": 100, "limit_period": "week"}], [])
        daily = self._group(settings, "Daily")
        self.assertEqual((daily["limit_period"], daily["base_start"], daily["base_balance"], daily["remaining"]),
                         ("month", f"{self.month}-01", 500, 830))
        with self.assertRaises(ValueError):
            self._save(3, [{"name": "X", "monthly_limit": 1, "limit_period": "year"}], [])
        # 멤버 뷰도 기간 사용을 준다
        mine = plan_repo.plan_view("ws1", viewer=("u_b", "b@x"))["my_group"]
        self.assertEqual((mine["name"], mine["limit_period"], mine["my_used_period"]), ("Weekly", "week", 30))

    # ── 충전 기준일(달 경계) ──
    def test_period_math_with_anchor_day(self) -> None:
        ps = plan_repo.period_start
        self.assertEqual(ps("2026-09-14", "month", 15), "2026-08-15")
        self.assertEqual(ps("2026-09-15", "month", 15), "2026-09-15")
        self.assertEqual(ps("2026-03-01", "month", 28), "2026-02-28")
        self.assertEqual(plan_repo.period_end("2026-09-20", "month", 15), "2026-10-14")
        self.assertEqual(plan_repo.period_end("2026-09-20", "month", 1), "2026-09-30")
        self.assertEqual(ps("2026-09-10", "week"), "2026-09-07")  # 목요일 → 월요일
        self.assertEqual(plan_repo.periods_inclusive("2026-08-15", "2026-10-14", "month", 15), 2)
        self.assertEqual(plan_repo.periods_inclusive("2026-08-15", "2026-10-15", "month", 15), 3)
        self.assertEqual(plan_repo.periods_inclusive("2026-09-01", "2026-09-30", "week"), 5)
        with manage_db.get_connection() as conn:  # SQL 쪽 '매월' 판정도 같은 경계 — 15일 기준 9/14 는 8월 달
            cond = manage_db._period_conditions(15)["month"].replace("created_at", "'2026-09-14T03:00:00Z'").replace(
                "'now'", "'2026-09-20'")
            self.assertEqual(conn.execute(f"SELECT {cond}").fetchone()[0], 0)
            cond = manage_db._period_conditions(15)["month"].replace("created_at", "'2026-09-15T03:00:00Z'").replace(
                "'now'", "'2026-09-20'")
            self.assertEqual(conn.execute(f"SELECT {cond}").fetchone()[0], 1)

    def test_topup_day_moves_the_month_boundary_everywhere(self) -> None:
        today = datetime.now()
        if today.day > 27:
            self.skipTest("월말엔 '내일' 기준일을 만들 수 없다")
        anchor = today.day + 1  # 이번 충전 달 = 지난달 (오늘+1)일 ~ 오늘 → 20일 전 기록이 들어온다
        manage_db.upsert_facts("b@x", "u_b", [_fact("f-20", creator_uid="u_b", real_credits=40, created_at=_iso(-20))])
        settings = plan_repo.save_settings("ws1", revision=0, note=None, groups=None, topup_day=anchor)
        self.assertEqual(settings["plan"]["topup_day"], anchor)
        view = plan_repo.plan_view("ws1")
        self.assertEqual(view["pool"]["topup_day"], anchor)
        self.assertLess(view["cycle_start"], (today - timedelta(days=20)).strftime("%Y-%m-%d"))
        self.assertEqual(view["pool"]["used_month"], 205 + 40)  # 20일 전 40 이 '이번 달'에 들어옴
        # 예산 '매월'(fact_usage) 도 같은 경계 — 기준일 1 이면 20일 전 기록은 달력 달에 따라 빠질 수 있으나 기준일 anchor 면 항상 포함
        usage = manage_db.fact_usage("ws1", ["p1"], {"p1": "month"}, month_anchor_day=anchor)
        self.assertEqual(round(sum(r["credits"] for r in usage["budget_models"]["p1"])), 245)
        # 그룹(매월 한도)도 이번 충전 달 기준으로 센다
        settings = plan_repo.save_settings("ws1", revision=1, note=None, groups=[{"name": "G", "monthly_limit": 1000}],
                                           members=[{"email": "b@x", "group_id": None}])
        gid = settings["groups"][0]["id"]
        settings = plan_repo.save_settings("ws1", revision=2, note=None, groups=[{"id": gid, "name": "G", "monthly_limit": 1000}],
                                           members=[{"email": "b@x", "group_id": gid}])
        g = settings["groups"][0]
        self.assertEqual((g["base_start"], g["used_month"], g["remaining"]), (view["cycle_start"], 70, 930))
        with self.assertRaises(ValueError):
            plan_repo.save_settings("ws1", revision=3, note=None, groups=None, topup_day=31)

    # ── 월 충전(파생)·긴급 충전 ──
    def test_monthly_topup_is_derived_from_monthly_budgets(self) -> None:
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p2', 'P2', 'team', 'team', 'ws1', 'WS1')"
            )
        manage.set_planning("p2", budget_credits=5000, budget_period="month")
        self.assertEqual(plan_repo.plan_view("ws1")["pool"]["monthly_topup"], 25000)  # 두 프로젝트 합
        manage.set_planning("p2", budget_credits=5000, budget_period="week")  # 주 단위 예산은 안 센다
        self.assertEqual(plan_repo.plan_view("ws1")["pool"]["monthly_topup"], 20000)
        manage.set_planning("p1", budget_credits=None, budget_period="month")
        self.assertIsNone(plan_repo.plan_view("ws1")["pool"]["monthly_topup"])
        self.assertIsNone(plan_repo.get_settings("ws1")["plan"]["monthly_topup"])

    def test_emergency_topups_are_recorded_and_summarized(self) -> None:
        settings = self._save(0, [], [], topups=[
            {"day": f"{self.month}-03", "credits": 3000, "note": " 긴급 "},
            {"day": "2025-01-05", "credits": 1000},
        ])
        self.assertEqual([(t["day"], t["credits"], t["note"]) for t in settings["topups"]],
                         [(f"{self.month}-03", 3000, "긴급"), ("2025-01-05", 1000, None)])  # 최근순
        view = plan_repo.plan_view("ws1")
        self.assertEqual(view["pool"]["topups_month"], {"count": 1, "credits": 3000})
        self.assertEqual([t["credits"] for t in view["topups"]], [3000])  # 대시보드 목록은 최근 3개월만
        keep = settings["topups"][0]["id"]
        settings = self._save(1, [], [], topups=[{"id": keep, "day": f"{self.month}-03", "credits": 3500}])
        self.assertEqual([(t["id"], t["credits"]) for t in settings["topups"]], [(keep, 3500)])  # 전체 교체
        settings = self._save(2, [], [])  # topups 를 안 보내면 그대로
        self.assertEqual(len(settings["topups"]), 1)
        # 줄 단위 저장: groups=None 이면 그룹·배정은 손대지 않고 충전 기록만 바뀐다(revision 은 오른다).
        settings = self._save(3, [{"name": "Artist", "monthly_limit": 1000}], [{"email": "a@x", "group_id": None}])
        gid = settings["groups"][0]["id"]
        settings = self._save(4, [{"id": gid, "name": "Artist", "monthly_limit": 1000}], [{"email": "a@x", "group_id": gid}])
        settings = plan_repo.save_settings("ws1", revision=5, note=None, groups=None,
                                           topups=[{"day": f"{self.month}-09", "credits": 700}])
        self.assertEqual(settings["plan"]["revision"], 6)
        self.assertEqual([t["credits"] for t in settings["topups"]], [700])
        self.assertEqual((settings["groups"][0]["name"], settings["groups"][0]["member_count"]), ("Artist", 1))
        with self.assertRaises(plan_repo.CreditPlanConflict):
            plan_repo.save_settings("ws1", revision=5, note=None, groups=None, topups=[])
        for bad in ({"day": "2026-9-3", "credits": 1}, {"day": f"{self.month}-03", "credits": 0},
                    {"day": f"{self.month}-03", "credits": "x"}, {"id": "zz", "day": f"{self.month}-03", "credits": 1}):
            with self.assertRaises(ValueError):
                self._save(6, [], [], topups=[bad])
        self.assertNotIn("topups", plan_repo.plan_view("ws1", viewer=("u_a", "a@x")))

    # ── 잔액 일별 관측 ──
    def test_balance_daily_snapshot_keeps_latest_of_day(self) -> None:
        repo.record_account_status("a@x", {"email": "a@x", "workspaces": [{**WS, "credits": 7000}]})
        repo.record_account_status("a@x", {"email": "a@x", "workspaces": [{**WS, "credits": 6900}]})
        with db.get_connection() as conn:
            rows = conn.execute(
                "SELECT day, credits FROM workspace_balance_daily WHERE workspace_id='ws1'"
            ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["credits"], 6900)
        view = plan_repo.plan_view("ws1")
        self.assertEqual(view["history"], [{"day": rows[0]["day"], "credits": 6900}])
        self.assertEqual(view["pool"]["month_start_balance"], 7000)  # 그날 **첫** 관측값 — 후속 보고로 안 바뀜(코덱스 P2)
        self.assertEqual(view["pool"]["balance"], 6900)  # registry 도 같이 갱신됨
        # 멤버 뷰엔 이력이 없다
        self.assertNotIn("history", plan_repo.plan_view("ws1", viewer=("u_a", "a@x")))


if __name__ == "__main__":
    unittest.main()
