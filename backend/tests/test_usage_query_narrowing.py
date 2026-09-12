"""읽는 양을 줄이되 **답은 그대로** — 예산 주기 집계와 개인 메타 조회.

★왜(2026-09-12 코덱스 감사):
· `fact_usage` 는 프로젝트마다 지정된 **한 주기**만 소비하면서 day·week·month 를 **전부** 계산했다.
  실측 계획 3개가 전부 `month` 였고, 월만 계산한 비교에서 반환값이 동일한 채 142.13 → 110.52ms.
· `personal_meta_by_anchor` 는 색·태그 셋만 쓰면서 `_fetch_gens` 로 어셋·레퍼런스·계보·댓글까지
  조립했다. 팀 라이브러리 응답마다 돈다. 코덱스 실측 200행 16 SELECT·17.29ms → 3 SELECT·3.07ms.

이 파일이 지키는 것: **좁혀도 값이 달라지지 않는다.** 빠르기가 아니라 동등성이 계약이다.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app import db, manage_db, repo
from app.repo import id_resolve, manage
from app.repo.id_resolve import personal_meta_by_anchor


def _at(days: int = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fact(gid: str, **kw) -> dict:
    base = {
        "local_gen_id": gid,
        "job_id": "job-" + gid,
        "workspace_scope": "team",
        "workspace_id": "ws1",
        "workspace_name": "WS1",
        "project_id": "p1",
        "project_name": "P1",
        "folder_path": "e001/c0010",
        "model": "seedance",
        "output_type": "video",
        "status": "done",
        "real_credits": 10.0,
        "est_credits": None,
        "credit_source": "transaction",
        "elapsed_seconds": 3,
        "created_at": _at(0),
        "sort_ts": datetime.now(timezone.utc).timestamp(),
        "is_final": False,
        "is_shared": False,
        "is_deleted": False,
        "deleted_at": None,
    }
    base.update(kw)
    return base


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmp.cleanup)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_manage = manage_db.MANAGE_DB_PATH
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        manage_db.MANAGE_DB_PATH = Path(self.tmp.name) / "manage_hub.db"
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        manage_db.init_manage_db()

    def tearDown(self) -> None:
        manage_db.MANAGE_DB_PATH = self.old_manage
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()


class BudgetPeriodNarrowingTests(_Case):
    def setUp(self) -> None:
        super().setUp()
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            for pid in ("p1", "p2", "p3"):
                conn.execute(
                    "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, "
                    "workspace_name) VALUES(?, ?, 'team', 'team', 'ws1', 'WS1')",
                    (pid, pid),
                )
        manage_db.upsert_facts(
            "a@x.com",
            "u_a",
            [
                _fact("g-today", project_id="p1", created_at=_at(0)),
                _fact("g-old", project_id="p1", created_at=_at(-40)),
                _fact("g-p2", project_id="p2", created_at=_at(0)),
                _fact("g-p3", project_id="p3", created_at=_at(0)),
            ],
        )

    def _usage(self, periods, anchor=1):
        return manage_db.fact_usage("ws1", None, periods, None, anchor)

    def test_narrowing_to_the_used_period_gives_the_same_answer(self):
        """★이 시험이 이 파일의 이유다 — 안 쓰는 주기를 빼도 결과가 같아야 한다."""
        only_month = self._usage({"p1": "month"})
        self.assertEqual(only_month["budget_models"]["p1"][0]["count"], 1)  # 이번 달 것만
        self.assertEqual(only_month["budget_models"]["p1"][0]["credits"], 10.0)
        # 주기와 무관한 전체 통계는 그대로다 — 좁히기가 조회 범위를 건드리면 안 된다.
        self.assertEqual(only_month["stats"]["p1"]["gen_count"], 2)

    def test_each_project_gets_its_own_period(self):
        """프로젝트마다 주기가 다르면 세 주기가 다 필요하다 — 그때는 다 계산해야 한다."""
        out = self._usage({"p1": "day", "p2": "week", "p3": "month"})
        for pid in ("p1", "p2", "p3"):
            self.assertEqual(out["budget_models"][pid][0]["count"], 1, pid)

    def test_a_project_without_a_budget_has_no_budget_rows(self):
        out = self._usage({"p1": "month"})
        self.assertNotIn("p2", out["budget_models"])
        self.assertNotIn("p3", out["budget_models"])

    def test_no_budgets_at_all_still_returns_the_plain_stats(self):
        """예산이 하나도 없으면 주기 열이 하나도 안 만들어진다 — SQL 이 깨지면 안 된다."""
        out = self._usage({})
        self.assertEqual(out["budget_models"], {})
        self.assertEqual(out["stats"]["p1"]["gen_count"], 2)

    def test_an_unknown_period_name_is_ignored_not_crashed(self):
        """잘못된 주기(옛 데이터·손입력)는 기존처럼 조용히 건너뛴다."""
        out = self._usage({"p1": "fortnight", "p2": "month"})
        self.assertNotIn("p1", out["budget_models"])
        self.assertEqual(out["budget_models"]["p2"][0]["count"], 1)

    def test_the_month_anchor_day_still_reaches_the_query(self):
        """좁히기가 `_period_conditions` 를 우회해 식을 새로 쓰면 기준일이 사라진다."""
        for anchor in (1, 28):
            with self.subTest(anchor=anchor):
                out = self._usage({"p1": "month"}, anchor=anchor)
                self.assertIn("p1", out["budget_models"])


class PersonalMetaTests(_Case):
    def setUp(self) -> None:
        super().setUp()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_me','나')")
            conn.execute("INSERT INTO creator(uid, name) VALUES('u_other','남')")
            for gid, uid, color, job in (
                ("g1", "u_me", "#ff0000", "job-1"),
                ("g2", "u_me", None, "job-2"),  # 색 없음도 상태다
                ("g3", "u_other", "#00ff00", "job-3"),  # 남의 것
            ):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, creator_uid, prompt, status, model, "
                    "created_at, sort_ts, color, job_id) VALUES(?, 'me', ?, 'p', 'done', 'm', "
                    "datetime('now'), strftime('%s','now'), ?, ?)",
                    (gid, uid, color, job),
                )
            conn.execute("INSERT INTO tag(id, name) VALUES(1,'인물')")
            conn.execute("INSERT INTO tag(id, name) VALUES(2,'야경')")
            conn.execute("INSERT INTO auto_tag(id, name) VALUES(1,'auto-A')")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g1',1)")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g1',2)")
            conn.execute("INSERT INTO gen_auto_tag(generation_id, auto_tag_id) VALUES('g1',1)")
            conn.execute("INSERT INTO gen_tag(generation_id, tag_id) VALUES('g3',1)")

    def test_it_returns_the_same_three_values(self):
        out = personal_meta_by_anchor(["g1"], "u_me")
        self.assertEqual(out["g1"]["color"], "#ff0000")
        self.assertEqual(sorted(out["g1"]["tags"]), ["야경", "인물"])
        self.assertEqual(out["g1"]["auto_tags"], ["auto-A"])

    def test_both_the_local_id_and_the_job_id_are_keys(self):
        """서버 앵커가 어느 쪽이든 잡혀야 한다(기존 계약)."""
        out = personal_meta_by_anchor(["g1"], "u_me")
        self.assertIs(out["g1"], out["job-1"])
        out2 = personal_meta_by_anchor(["job-1"], "u_me")
        self.assertEqual(out2["g1"]["color"], "#ff0000")

    def test_empty_values_are_preserved_not_dropped(self):
        """★색 없음·태그 없음은 '모름'이 아니라 '사용자가 그렇게 둔 상태'다."""
        out = personal_meta_by_anchor(["g2"], "u_me")
        self.assertIsNone(out["g2"]["color"])
        self.assertEqual(out["g2"]["tags"], [])
        self.assertEqual(out["g2"]["auto_tags"], [])

    def test_another_persons_row_never_comes_back(self):
        """★소유자 조건이 사라지면 남의 개인 색·태그가 샌다."""
        out = personal_meta_by_anchor(["g1", "g3", "job-3"], "u_me")
        self.assertIn("g1", out)
        self.assertNotIn("g3", out)
        self.assertNotIn("job-3", out)

    def test_another_persons_tags_do_not_attach_to_my_row(self):
        """태그를 소유자 필터 없이 통째로 읽어 붙이면 여기서 걸린다."""
        out = personal_meta_by_anchor(["g1"], "u_me")
        self.assertNotIn("g3", out)
        self.assertEqual(sorted(out["g1"]["tags"]), ["야경", "인물"])

    def test_unknown_anchors_and_empty_input_give_an_empty_map(self):
        self.assertEqual(personal_meta_by_anchor([], "u_me"), {})
        self.assertEqual(personal_meta_by_anchor(["nope"], "u_me"), {})
        self.assertEqual(personal_meta_by_anchor(["g1"], ""), {})

    def _trace(self, anchors, owner):
        """이 함수가 실제로 실행한 SQL 을 모은다 — '덜 읽는다'가 이 수정의 목적이라 값만으론 못 지킨다.

        가짜는 커넥션 **획득 경계**에만 둔다 — 진짜 DB 에 진짜 질의가 나간다.
        """
        seen: list[str] = []
        real = id_resolve.get_connection

        @contextlib.contextmanager
        def traced(*args, **kwargs):
            with real(*args, **kwargs) as conn:
                conn.set_trace_callback(seen.append)
                try:
                    yield conn
                finally:
                    conn.set_trace_callback(None)

        with patch.object(id_resolve, "get_connection", traced):
            personal_meta_by_anchor(anchors, owner)
        return [q for q in seen if q.strip().upper().startswith("SELECT")]

    def test_it_reads_only_what_it_needs(self):
        """★값이 같아도 **전체 태그 테이블을 훑으면** 이 수정의 뜻이 사라진다.

        태그 조회는 소유자 행의 id 목록에 묶여야 한다. 안 묶으면 팀 라이브러리 응답마다
        태그 전량을 읽는다(값은 같아서 다른 시험으로는 안 잡힌다).
        """
        queries = self._trace(["g1"], "u_me")
        self.assertEqual(len(queries), 3, queries)  # generation + tag + auto_tag
        for q in queries:
            self.assertIn("IN (", q, q)  # 셋 다 id 목록으로 좁혀져 있다
        # 생성물 전체 보강(어셋·레퍼런스·공유)을 다시 부르지 않는다.
        joined = " ".join(queries).lower()
        for table in ("asset", "gen_reference", "share"):
            self.assertNotIn(f"from {table}", joined)


if __name__ == "__main__":
    unittest.main()
