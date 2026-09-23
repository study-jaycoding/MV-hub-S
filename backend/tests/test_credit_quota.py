"""사람별 몫(할당량) — 계산 규칙과 '조용히 지워지지 않는다' 보장. 설계: docs/CREDIT_QUOTA_DESIGN.md

힉스필드는 그룹 한도까지만 알려 주고 개인은 자기 몫을 못 본다. 우리 앱이 그 칸을 채운다.
여기서 고정하는 것:
- 몫 = 덮어쓴 값, 없으면 (그룹 한도 − 고정분) ÷ 자동 인원. 한도를 올리면 **즉시** 반영된다(Jay 예시 4,000→5,000).
- 남은 양 = 내 몫 − **이번 기간** 내 사용. 개인에겐 이월이 없다(그룹 이월은 'group_carryover' 로 따로).
- 경계: 자동 인원 0명·무제한·한도 0·고정분 초과·소수 분배.
- **저장이 몫을 지우지 않는다**: 구버전 본문(몫 키 없음)·그룹 한 칸 저장·그룹 이동·그룹 삭제·추정 맞추기.
"""

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import db, manage_db, repo
from app.repo import manage
from app.repo import manage_credit_plan as plan_repo


def _iso(delta_days: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=delta_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fact(gid: str, email: str, uid: str, credits: float) -> dict:
    return {
        "local_gen_id": gid, "job_id": f"job-{gid}", "workspace_scope": "team", "workspace_id": "ws1",
        "workspace_name": "WS1", "project_id": "p1", "project_name": "P", "folder_path": "e001/c0010",
        "model": "seedance", "output_type": "video", "status": "done", "real_credits": credits,
        "est_credits": None, "created_at": _iso(0), "is_final": False, "is_shared": False, "is_deleted": False,
    }


class CreditQuotaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
        db.flush_pool()
        db.init_db()
        manage_db.init_manage_db()
        with db.get_connection() as conn:
            conn.executemany(
                "INSERT INTO creator(uid, name) VALUES(?,?)",
                [("u_a", "A"), ("u_b", "B"), ("u_c", "C")],
            )
            conn.executemany(
                "INSERT INTO account(email, name, password_hash, status, creator_uid) VALUES(?,?,?,?,?)",
                [(f"{n}@x", n.upper(), "h", "approved", f"u_{n}") for n in ("a", "b", "c")],
            )
            conn.execute(
                "INSERT INTO workspace_registry(id, name, plan_type, credits) VALUES('ws1','WS1','enterprise',9000)"
            )
            conn.executemany(
                "INSERT INTO workspace_member(workspace_id, account_email, creator_uid, user_role, is_selected, "
                "is_available) VALUES('ws1',?,?,'member',1,1)",
                [(f"{n}@x", f"u_{n}") for n in ("a", "b", "c")],
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p1','P','team','team','ws1','WS1')"
            )

    def tearDown(self) -> None:
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        db.flush_pool()
        os.environ.pop("CONTENT_HUB_DB", None)
        self.tmp.cleanup()

    # ── 도우미 ──
    def _group(self, limit, members, *, period="month", quotas=None):
        """그룹 하나 + 배정(+몫)을 저장하고 settings 를 돌려준다. 같은 시험 안에서 여러 번 불러도
        되도록 현재 revision 을 읽어서 쓴다(낙관적 잠금이라 0 으로 고정하면 두 번째 호출이 409)."""
        current = plan_repo.get_settings("ws1")
        settings = plan_repo.save_settings(
            "ws1", revision=current["plan"]["revision"], note=None,
            groups=[{"name": "Artist", "monthly_limit": limit, "limit_period": period}], members=[],
        )
        gid = settings["groups"][0]["id"]
        rows = [{"email": e, "group_id": gid} for e in members]
        for row in rows:
            if quotas and row["email"] in quotas:
                row["quota"] = quotas[row["email"]]
        return plan_repo.save_settings(
            "ws1", revision=settings["plan"]["revision"], note=None,
            groups=[{"id": gid, "name": "Artist", "monthly_limit": limit, "limit_period": period}], members=rows,
        )

    def _member_row(self, settings: dict, email: str) -> dict:
        return next(m for m in settings["members"] if m["email"] == email)

    # ── 계산 규칙 ──
    def test_auto_share_splits_limit_by_head_count(self) -> None:
        s = self._group(900, ["a@x", "b@x", "c@x"])
        self.assertEqual(s["groups"][0]["quota_auto"], 300)
        self.assertEqual(self._member_row(s, "a@x")["quota_effective"], 300)
        self.assertEqual(self._member_row(s, "a@x")["quota_source"], "auto")

    def test_manual_override_takes_the_rest_from_the_others(self) -> None:
        s = self._group(1000, ["a@x", "b@x", "c@x"], quotas={"a@x": 600})
        group = s["groups"][0]
        self.assertEqual((group["quota_fixed"], group["quota_auto"], group["quota_over"]), (600, 200, False))
        self.assertEqual(self._member_row(s, "a@x")["quota_source"], "manual")
        self.assertEqual(self._member_row(s, "b@x")["quota_effective"], 200)

    def test_raising_the_limit_shows_up_right_away(self) -> None:
        """Jay 예시: 4,000 을 다 썼는데 한도를 5,000 으로 올리면 남은 양이 1,000 이 된다."""
        s = self._group(4000, ["a@x"])
        manage_db.upsert_facts("a@x", "u_a", [_fact("g1", "a@x", "u_a", 4000)])
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]
        self.assertEqual((view["my_quota"], view["my_used_period"], view["my_remaining"]), (4000, 4000, 0))
        gid = s["groups"][0]["id"]
        plan_repo.save_settings(
            "ws1", revision=s["plan"]["revision"], note=None,
            groups=[{"id": gid, "name": "Artist", "monthly_limit": 5000}], members=[],
        )
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]
        self.assertEqual((view["my_quota"], view["my_remaining"]), (5000, 1000))

    def test_over_quota_shows_negative_not_blocked(self) -> None:
        self._group(100, ["a@x"])
        manage_db.upsert_facts("a@x", "u_a", [_fact("g1", "a@x", "u_a", 130)])
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]
        self.assertEqual(view["my_remaining"], -30)

    def test_boundaries(self) -> None:
        with self.subTest("자동 인원 0명 — 나눗셈을 하지 않는다"):
            s = self._group(1000, ["a@x"], quotas={"a@x": 400})
            self.assertIsNone(s["groups"][0]["quota_auto"])
        with self.subTest("고정분이 한도를 넘으면 자동 몫 0 + 경고"):
            s = self._group(500, ["a@x", "b@x"], quotas={"a@x": 900})
            group = s["groups"][0]
            self.assertEqual((group["quota_auto"], group["quota_over"]), (0, True))
        with self.subTest("한도 0 — 쓸 몫이 없다"):
            s = self._group(0, ["a@x", "b@x"])
            self.assertEqual(s["groups"][0]["quota_auto"], 0)
        with self.subTest("무제한 그룹 — 자동 몫은 없고 덮어쓴 사람만 몫이 있다"):
            s = self._group(None, ["a@x", "b@x"], quotas={"a@x": 300})
            self.assertIsNone(s["groups"][0]["quota_auto"])
            self.assertEqual(self._member_row(s, "a@x")["quota_effective"], 300)
            self.assertIsNone(self._member_row(s, "b@x")["quota_effective"])
        with self.subTest("소수 — 표시는 33.33 이지만 계산은 33.333… 그대로다"):
            s = self._group(100, ["a@x", "b@x", "c@x"])
            self.assertEqual(s["groups"][0]["quota_auto"], 33.33)  # 화면 값(둘째 자리)
            # ★계산은 깎인 값을 쓰면 안 된다(Codex 코드 리뷰): 33.33 으로 먼저 줄이면 세 사람 합이 99.99 가 되고
            #  33.335 를 쓴 사람의 남은 양이 −0.01 로 보인다. 저장소 내부 값은 원값이어야 한다.
            from app.repo.manage_credit_plan import _quota_split

            raw = _quota_split({"monthly_limit": 100}, {"a@x", "b@x", "c@x"}, {})
            self.assertAlmostEqual(raw["quota_auto"] * 3, 100.0, places=9)
        with self.subTest("숫자가 아니거나 음수면 400"):
            for bad in (-1, "x", float("inf")):
                with self.assertRaises(ValueError):
                    self._group(100, ["a@x"], quotas={"a@x": bad})

    def test_remaining_uses_unrounded_share(self) -> None:
        """몫 33.333… 인 사람이 33.335 를 쓰면 남은 양은 **0 근처**다(−0.0017).
        몫을 33.33 으로 먼저 깎고 빼면 −0.01 이 되어 '초과'로 보인다(Codex 코드 리뷰가 든 예)."""
        self._group(100, ["a@x", "b@x", "c@x"])
        manage_db.upsert_facts("a@x", "u_a", [_fact("g1", "a@x", "u_a", 33.335)])
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]
        self.assertEqual(view["my_quota"], 33.33)  # 화면 값은 둘째 자리
        self.assertEqual(view["my_remaining"], 0)  # 깎인 몫으로 계산하면 −0.01

    def test_personal_quota_has_no_carryover_but_group_does(self) -> None:
        """개인 몫은 이번 기간만 본다(Jay). 그룹의 이월은 'group_carryover' 로 따로 알려 준다."""
        s = self._group(100, ["a@x"])
        gid = s["groups"][0]["id"]
        with db.get_connection() as conn:  # 그룹이 어제부터 있었던 것으로 — 어제 몫 100 이 이월된다
            yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
            conn.execute(
                "UPDATE workspace_credit_group SET base_start=?, limit_period='day' WHERE id=?", (yesterday, gid)
            )
        view = plan_repo.plan_view("ws1", viewer=("u_a", "a@x"))["my_group"]
        self.assertEqual(view["my_quota"], 100)  # 내 몫은 오늘치 100 뿐
        self.assertEqual(view["remaining"], 200)  # 그룹은 이월 포함 200
        self.assertEqual(view["group_carryover"], 100)

    # ── 저장이 몫을 지우지 않는다(Codex 치명 ②) ──
    def test_quota_survives_other_saves(self) -> None:
        s = self._group(1000, ["a@x", "b@x"], quotas={"a@x": 600})
        gid = s["groups"][0]["id"]
        rev = s["plan"]["revision"]

        def quota_of(settings: dict) -> float | None:
            return self._member_row(settings, "a@x")["quota"]

        with self.subTest("몫을 모르는 구버전 본문(그룹 전체 재전송)"):
            s = plan_repo.save_settings(
                "ws1", revision=rev, note=None,
                groups=[{"id": gid, "name": "Artist", "monthly_limit": 1000}],
                members=[{"email": "a@x", "group_id": gid}, {"email": "b@x", "group_id": gid}],
            )
            self.assertEqual(quota_of(s), 600)
        with self.subTest("그룹 색 한 칸 저장(members 없음)"):
            s = plan_repo.save_settings(
                "ws1", revision=s["plan"]["revision"], note=None,
                groups=[{"id": gid, "name": "Artist", "monthly_limit": 1000, "color": "#84cc16"}], members=[],
            )
            self.assertEqual(quota_of(s), 600)
        with self.subTest("추정 맞추기(remaining_override)"):
            s = plan_repo.save_settings(
                "ws1", revision=s["plan"]["revision"], note=None,
                groups=[{"id": gid, "name": "Artist", "monthly_limit": 1000, "remaining_override": 800}], members=[],
            )
            self.assertEqual(quota_of(s), 600)
        with self.subTest("다른 사람의 소속만 바꾸는 저장"):
            s = plan_repo.save_settings(
                "ws1", revision=s["plan"]["revision"], note=None,
                groups=[{"id": gid, "name": "Artist", "monthly_limit": 1000}],
                members=[{"email": "c@x", "group_id": gid}],
            )
            self.assertEqual(quota_of(s), 600)
        with self.subTest("배정을 풀면 그 사람 몫도 사라진다"):
            s = plan_repo.save_settings(
                "ws1", revision=s["plan"]["revision"], note=None,
                groups=[{"id": gid, "name": "Artist", "monthly_limit": 1000}],
                members=[{"email": "a@x", "group_id": None}],
            )
            self.assertIsNone(quota_of(s))

    def test_quota_null_resets_to_auto(self) -> None:
        s = self._group(900, ["a@x", "b@x", "c@x"], quotas={"a@x": 500})
        gid = s["groups"][0]["id"]
        s = plan_repo.save_settings(
            "ws1", revision=s["plan"]["revision"], note=None,
            groups=[{"id": gid, "name": "Artist", "monthly_limit": 900}],
            members=[{"email": "a@x", "quota": None}],  # 소속은 안 건드리고 몫만 자동으로
        )
        self.assertIsNone(self._member_row(s, "a@x")["quota"])
        self.assertEqual(self._member_row(s, "a@x")["quota_effective"], 300)

    # ── 정기 충전(손 입력 우선, 비면 파생) ──
    def test_recurring_topup_manual_wins_and_null_falls_back(self) -> None:
        manage.set_planning("p1", budget_credits=20000, budget_period="month")
        s = plan_repo.save_settings("ws1", revision=0, note=None, groups=None, topups=[])
        self.assertEqual((s["plan"]["monthly_topup"], s["plan"]["monthly_topup_source"]), (20000, "derived"))
        s = plan_repo.save_settings(
            "ws1", revision=s["plan"]["revision"], note=None, groups=None, recurring_topup=24491.5
        )
        self.assertEqual((s["plan"]["monthly_topup"], s["plan"]["monthly_topup_source"]), (24491.5, "manual"))
        self.assertEqual(plan_repo.plan_view("ws1")["pool"]["monthly_topup"], 24491.5)
        with self.subTest("키를 안 보내면 그대로"):
            s = plan_repo.save_settings("ws1", revision=s["plan"]["revision"], note="메모", groups=None)
            self.assertEqual(s["plan"]["monthly_topup"], 24491.5)
        with self.subTest("null 이면 파생으로 되돌아간다"):
            s = plan_repo.save_settings(
                "ws1", revision=s["plan"]["revision"], note=None, groups=None, recurring_topup=None
            )
            self.assertEqual((s["plan"]["monthly_topup"], s["plan"]["monthly_topup_source"]), (20000, "derived"))


if __name__ == "__main__":
    unittest.main()
