"""'관리 요약' 사용량 = manage_hub 팩트(team_generation_fact) 계약 (2026-09-09, "출근부 장부").

공유 안 한 생성물·tombstone 도 센다. content DB 는 레지스트리·planning·공유 수·빈 시퀀스·이름만.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import db, manage_db, repo
from app.repo import manage


def _iso(delta_days: int = 0, fmt: str = "z") -> str:
    """팩트 created_at — 로컬 허브가 저장하는 두 형식('…T…Z' / '… …')을 섞어 쓴다(둘 다 UTC)."""
    t = datetime.now(timezone.utc) + timedelta(days=delta_days)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if fmt == "z" else t.strftime("%Y-%m-%d %H:%M:%S")


def _fact(gid: str, **kw) -> dict:
    base = {
        "local_gen_id": gid,
        "job_id": f"job-{gid}",
        "workspace_scope": "team",
        "workspace_id": "ws1",
        "workspace_name": "WS1",
        "project_id": "p1",
        "project_name": "Project",
        "folder_path": "e001/c0010",
        "model": "seedance",
        "output_type": "video",
        "status": "done",
        "real_credits": None,
        "est_credits": None,
        "credit_source": None,
        "elapsed_seconds": None,
        "created_at": _iso(0),
        "sort_ts": datetime.now(timezone.utc).timestamp(),
        "is_final": False,
        "is_shared": False,
        "is_deleted": False,
        "deleted_at": None,
    }
    base.update(kw)
    return base


class FactUsageSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage_path = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"  # 사용자 DB 격리(코덱스 P1)
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        manage_db.init_manage_db()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_a', '제이')")
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p1', 'Project', 'team', 'team', 'ws1', 'WS1')"
            )
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p2', 'Other', 'team', 'team', 'ws2', 'WS2')"
            )
            # 빈 시퀀스(폴더 스캔 자동 작업) — 생성물 0개여도 구조에 남아야 한다.
            conn.execute(
                "INSERT INTO project_task(id, project_id, name, folder_path) "
                "VALUES('t-empty', 'p1', 'e001', 'e001/c0090')"
            )
            # content 에만 있는 생성물(발행분) — 사용량엔 세지 않고, 공유 수에만 쓴다.
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, folder_path, "
                "created_at, sort_ts, project_id, workspace_scope, workspace_id) "
                "VALUES('content-only', 'me', 'u_a', 'p', 'done', 'seedance', 'e001/c0010', "
                "datetime('now'), strftime('%s','now'), 'p1', 'team', 'ws1')"
            )
            conn.execute(
                "INSERT INTO generation_metrics(gen_id, real_credits, elapsed_seconds) "
                "VALUES('content-only', 500, 999)"
            )
            conn.execute(
                "INSERT INTO share(generation_id, shared_by) VALUES('content-only', 'me')"
            )
        manage.set_planning("p1", budget_credits=100, budget_period="day")
        # 팩트 — 계정 a(u_a): 미공유·공유·미상·미분류 폴더·tombstone·다른 워크스페이스·미분류 프로젝트
        n, skipped = manage_db.upsert_facts(
            "a@x", "u_a",
            [
                _fact("f1", real_credits=10, elapsed_seconds=30, is_final=True, created_at=_iso(0, "z")),
                _fact("f2", est_credits=4, is_shared=True, created_at=_iso(-40, "plain")),
                _fact("f3", folder_path="e001/c0020", model="nano", status="failed"),
                _fact("f4", folder_path=None, real_credits=2),
                _fact("f5", real_credits=6, is_deleted=True, deleted_at=_iso(0)),
                _fact("f6", workspace_id="ws2", workspace_name="WS2", real_credits=99),
                _fact("f7", project_id=None, project_name=None, folder_path=None, real_credits=1),
            ],
        )
        self.assertEqual((n, skipped), (7, []))
        # 계정 b(u_b): content creator 표에 없어 팩트 스냅샷 이름('리버')으로 표시돼야 한다.
        n, skipped = manage_db.upsert_facts(
            "b@x", "u_b",
            [_fact("f8", creator_uid="u_b", creator_name="리버", real_credits=7, elapsed_seconds=10)],
        )
        self.assertEqual((n, skipped), (1, []))

    def tearDown(self) -> None:
        db.flush_pool()
        manage_db.MANAGE_DB_PATH = self.old_manage_path
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    # ── 멤버용 project-summary ────────────────────────────────────────────────
    def test_project_summary_counts_unshared_and_tombstone_from_facts(self) -> None:
        out = manage.project_dashboard_summary(["p1"], "ws1")
        self.assertEqual(out["usage_source"], "facts")
        (project,) = out["projects"]
        # f1 f2 f3 f4 f5 f8 (f6=ws2 제외, f7=미분류 제외). content-only(500cr) 는 세지 않는다.
        self.assertEqual(project["gen_count"], 6)
        self.assertEqual(project["done_count"], 5)  # f3 failed
        self.assertEqual(project["final_count"], 1)
        self.assertEqual(project["credits"], 10 + 4 + 2 + 6 + 7)
        self.assertEqual(project["real_credits"], 10 + 2 + 6 + 7)
        self.assertEqual(project["metric_count"], 5)
        self.assertEqual(project["credit_real_count"], 4)
        self.assertEqual(project["credit_est_count"], 1)
        self.assertEqual(project["credit_unknown_count"], 1)  # f3 — 0원이 아니라 '미상'
        self.assertEqual(project["elapsed_total"], 40)
        self.assertEqual(project["shared_count"], 1)  # content share 표(content-only)
        # 예산(일): 오늘 만든 f1 10 + f4 2 + f5 6 + f8 7 + f3 0 = 25 (f2 는 40일 전)
        self.assertEqual(project["budget_used_credits"], 25)
        self.assertEqual(
            [(m["model"], m["count"], m["credits"]) for m in project["budget_models"]],
            [("seedance", 4, 25), ("nano", 1, 0)],
        )
        self.assertEqual(
            project["models"],
            [
                {"model": "seedance", "count": 5, "credits": 29, "final_count": 1, "elapsed_seconds": 40},
                {"model": "nano", "count": 1, "credits": 0, "final_count": 0, "elapsed_seconds": 0},
            ],
        )

    def test_project_summary_folders_merge_facts_empty_sequences_and_names(self) -> None:
        (project,) = manage.project_dashboard_summary(["p1"], "ws1")["projects"]
        folders = {f["folder_path"]: f for f in project["folders"]}
        self.assertEqual(
            [f["folder_path"] for f in project["folders"]],
            ["e001/c0010", "e001/c0020", "e001/c0090", "(폴더 미지정)"],
        )
        c0010 = folders["e001/c0010"]
        self.assertEqual(
            {k: c0010[k] for k in ("count", "final_count", "credits", "elapsed_seconds")},
            {"count": 4, "final_count": 1, "credits": 10 + 4 + 6 + 7, "elapsed_seconds": 40},
        )
        # 기간: 40일 전(f2, '… …' 형식) ~ 오늘 — datetime(…,'localtime') 로 통일된 문자열
        self.assertLess(c0010["created_start"], c0010["created_end"])
        self.assertRegex(c0010["created_start"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
        # 멤버: u_a 는 content creator 표 이름, u_b 는 팩트 스냅샷 이름. 생성수 내림차순.
        self.assertEqual(
            c0010["members"],
            [
                {"uid": "u_a", "name": "제이", "count": 3, "credits": 20, "final_count": 1},
                {"uid": "u_b", "name": "리버", "count": 1, "credits": 7, "final_count": 0},
            ],
        )
        self.assertEqual(folders["e001/c0090"]["count"], 0)  # 빈 시퀀스 유지
        self.assertEqual(folders["e001/c0090"]["models"], [])
        self.assertEqual(folders["e001/c0020"]["credits"], 0)
        self.assertEqual(folders["(폴더 미지정)"]["credits"], 2)

    def test_project_summary_scopes_facts_to_allowed_projects_and_workspace(self) -> None:
        # ws2 에는 p1 레지스트리가 없다 → 빈 목록(팩트 f6 이 있어도 멤버 경로엔 행이 없다).
        self.assertEqual(manage.project_dashboard_summary(["p1"], "ws2")["projects"], [])
        # 허용 목록 밖(p1)은 SQL 에서부터 안 센다 — p2 만 요청하면 p2(0건)만.
        (project,) = manage.project_dashboard_summary(["p2"], "ws2")["projects"]
        self.assertEqual((project["pid"], project["gen_count"], project["credits"]), ("p2", 0, 0))

    # ── read_all 대시보드 ───────────────────────────────────────────────────
    def test_dashboard_summary_totals_workers_and_moved_project(self) -> None:
        summary = manage.dashboard_summary(workspace_id="ws1")
        self.assertEqual(summary["usage_source"], "facts")
        rows = {row["pid"]: row for row in summary["projects"]}
        self.assertEqual(list(rows), ["p1"])
        self.assertEqual(rows["p1"]["credits"], 29)
        self.assertEqual(rows["p1"]["shared_count"], 1)
        # totals = 워크스페이스 전체 팩트(미분류 f7 포함, ws2 의 f6 제외)
        self.assertEqual(summary["totals"]["gen_count"], 7)
        self.assertEqual(summary["totals"]["credits"], 30)
        self.assertEqual(summary["totals"]["elapsed_total"], 40)
        self.assertEqual(
            [(w["uid"], w["name"], w["gen_count"], w["credits"]) for w in summary["workers"]],
            [("u_a", "제이", 6, 23), ("u_b", "리버", 1, 7)],
        )
        # ws2: p1 은 레지스트리 밖이지만 팩트(f6)가 있어 '이동 프로젝트' 행으로 남는다.
        summary_b = manage.dashboard_summary(workspace_id="ws2")
        rows_b = {row["pid"]: row for row in summary_b["projects"]}
        self.assertEqual(set(rows_b), {"p1", "p2"})
        self.assertTrue(rows_b["p1"]["workspace_moved"])
        self.assertEqual(rows_b["p1"]["credits"], 99)
        self.assertFalse(rows_b["p2"]["workspace_moved"])
        self.assertEqual(summary_b["totals"]["credits"], 99)

    # ── 삭제(tombstone) 비용 불변 — 삭제→복원→재삭제 ───────────────────────────
    def test_tombstone_cost_survives_delete_restore_delete(self) -> None:
        def credits() -> int:
            (project,) = manage.project_dashboard_summary(["p1"], "ws1")["projects"]
            return project["credits"]

        self.assertEqual(credits(), 29)
        manage_db.upsert_facts("a@x", "u_a", [_fact("f1", is_deleted=True, deleted_at=_iso(0))])
        self.assertEqual(credits(), 29)  # tombstone 은 차원(크레딧) 보존
        manage_db.upsert_facts("a@x", "u_a", [_fact("f1", real_credits=10, elapsed_seconds=30, is_final=True)])
        self.assertEqual(credits(), 29)  # 복원 — 이중 합산 없음
        manage_db.upsert_facts("a@x", "u_a", [_fact("f1", is_deleted=True, deleted_at=_iso(0))])
        self.assertEqual(credits(), 29)

    # ── 일반 멤버 열람 범위 = 내 작업 전부 + 팀원 공유분 (Jay 결정 2026-09-10) ───────
    def test_member_scope_hides_teammates_unshared_work(self) -> None:
        # 팀원 u_b 의 팩트 둘을 추가 — 공유 판정은 PC 보고값(is_shared)이 아니라 서버 공유 원장(share 표):
        #  f9  = PC 는 공유라고 보고했지만 서버 원장엔 없음(공유 해제 뒤 미보고) → 멤버에게 숨김
        #  f10 = PC 보고는 미공유지만 서버에 발행돼 있음(발행 직후 미보고) → 멤버에게 보임(2cr)
        manage_db.upsert_facts(
            "b@x", "u_b",
            [
                _fact("f9", creator_uid="u_b", creator_name="리버", real_credits=3, is_shared=True),
                _fact("f10", creator_uid="u_b", creator_name="리버", real_credits=2),
            ],
        )
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, folder_path, "
                "created_at, sort_ts, project_id, workspace_scope, workspace_id, job_id) "
                "VALUES('srv-f10', 'me', 'u_b', 'p', 'done', 'seedance', 'e001/c0010', "
                "datetime('now'), strftime('%s','now'), 'p1', 'team', 'ws1', 'job-f10')"
            )
            conn.execute("INSERT INTO share(generation_id, shared_by) VALUES('srv-f10', 'me')")
        # 매니저(viewer_uid=None): 전부 — 6 + f9 + f10 = 8건, 29 + 3 + 2 = 34cr
        out = manage.project_dashboard_summary(["p1"], "ws1")
        self.assertEqual(out["usage_scope"], "all")
        self.assertEqual((out["projects"][0]["gen_count"], out["projects"][0]["credits"]), (8, 34))
        # 일반 멤버 u_a: 내 것 전부(f1 f2 f3 f4 f5 = 5건·22cr) + 팀원 서버 공유분(f10 2cr). f8·f9 제외.
        out = manage.project_dashboard_summary(["p1"], "ws1", viewer_uid="u_a")
        self.assertEqual(out["usage_scope"], "mine_plus_shared")
        (project,) = out["projects"]
        self.assertEqual((project["gen_count"], project["credits"]), (6, 24))
        c0010 = next(f for f in project["folders"] if f["folder_path"] == "e001/c0010")
        self.assertEqual(
            [(m["uid"], m["count"], m["credits"]) for m in c0010["members"]],
            [("u_a", 3, 20), ("u_b", 1, 2)],
        )
        # 아무 작업도 없는 멤버(u_zero): 서버 공유 원장에 있는 팀원 작업만 — f10 하나
        #  (f2 는 PC 가 공유라고 보고했을 뿐 서버 원장엔 없어 숨김).
        out = manage.project_dashboard_summary(["p1"], "ws1", viewer_uid="u_zero")
        self.assertEqual((out["projects"][0]["gen_count"], out["projects"][0]["credits"]), (1, 2))

    # ── 중복 정책(코덱스 P3 고정) ─────────────────────────────────────────────
    def test_duplicate_policy_same_account_job_converges_other_account_double_counts(self) -> None:
        def count() -> int:
            (project,) = manage.project_dashboard_summary(["p1"], "ws1")["projects"]
            return project["gen_count"]

        self.assertEqual(count(), 6)
        # 같은 계정·같은 job_id 를 다른 local_gen_id 로 재적재 → 최신 행으로 수렴(1건 유지)
        manage_db.upsert_facts("a@x", "u_a", [_fact("f1-again", job_id="job-f1", real_credits=10)])
        self.assertEqual(count(), 6)
        # 다른 계정이 같은 job_id 를 올리면 두 번 센다(알려진 한계 — team_overview 와 동일)
        manage_db.upsert_facts("c@x", "u_c", [_fact("f1-c", creator_uid="u_c", job_id="job-f1", real_credits=10)])
        self.assertEqual(count(), 7)


if __name__ == "__main__":
    unittest.main()
