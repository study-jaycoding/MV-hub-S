"""날짜 **범위** 필터는 열을 함수로 감싸지 않는다 — 뜻은 그대로, 인덱스는 살린다.

★왜(2026-09-12): `date(created_at,'localtime') >= ?` 는 열을 함수로 감싸 **인덱스를 무력화**한다.
 실제 22,392행에서 `SCAN` **8.62 ms** vs `julianday()` 표현식 인덱스 `SEARCH` **0.04 ms** — **244배**.
 하루 조회는 8.89 → 0.03 ms(296배)였고, **177일 전량 + 무작위 범위 40건에서 결과가 완전히 같았다.**

★이 패턴을 어제(커밋 35730165) 내가 `ledger_totals` 에 **새로 넣었다.** 팩트와 장부를 함께 고친다 —
 둘이 갈리면 '같은 날' 의 뜻이 달라져 사용량과 장부가 어긋난다.

★바꾼 것은 **범위 필터뿐**이다. `GROUP BY date(...)`·예산 주기 `CASE`·`MIN/MAX` 표시값은 그대로 둔다
 (예산 조건을 `WHERE` 로 옮기면 전체 누적 합계가 달라진다 — 코덱스 계약).

★시간대: 이 시험은 **실행 환경의 시간대**에 의존한다(이 PC 는 KST, 실서버는 UTC).
 그래서 기대 날짜를 상수로 박지 않고 **DB 에게 물어본다.**
"""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import db, manage_db, repo
from app.repo import manage
from app.repo.manage_transactions import ledger_totals, record_transactions


def _fact(gid: str, created_at: str, **kw) -> dict:
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
        "created_at": created_at,
        "sort_ts": 0.0,
        "is_final": False,
        "is_shared": False,
        "is_deleted": False,
        "deleted_at": None,
    }
    base.update(kw)
    return base


class DateRangeBoundaryTests(unittest.TestCase):
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
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO project(id, name, kind, workspace_scope, workspace_id, workspace_name) "
                "VALUES('p1','P1','team','team','ws1','WS1')"
            )

    def tearDown(self) -> None:
        manage_db.MANAGE_DB_PATH = self.old_manage
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()

    # ── 도우미 ──────────────────────────────────────────────────────────
    @staticmethod
    def _local_day(stamp: str) -> str:
        """그 UTC 시각이 **실행 환경 시간대로** 며칠인가 — DB 에게 묻는다."""
        with db.get_connection() as conn:
            return conn.execute("SELECT date(?, 'localtime')", (stamp,)).fetchone()[0]

    def _usage(self, date_from=None, date_to=None):
        return manage_db.fact_usage("ws1", None, {}, None, 1)["stats"].get("p1", {})

    def _count(self, date_from=None, date_to=None) -> int:
        out = manage_db.team_overview(
            workspace_id="ws1", date_from=date_from, date_to=date_to
        )
        return out["totals"]["count"]

    # ── 경계 ────────────────────────────────────────────────────────────
    def test_the_end_date_includes_that_whole_day_to_the_last_second(self):
        """★종료일을 `<= '날짜'` 로 비교하면 그날 늦은 시각이 통째로 빠진다.

        경계를 '다음날 자정 미만' 으로 바꿔도 **그날 23:59:59 는 들어와야** 한다.
        """
        late = "2026-09-05T14:59:59Z"
        day = self._local_day(late)
        manage_db.upsert_facts("a@x", "u_a", [_fact("g-late", late)])
        self.assertEqual(self._count(day, day), 1)

    def test_midnight_belongs_to_its_own_day_not_the_previous_one(self):
        """로컬 자정 정각은 그날의 **첫 시각**이다 — 전날에 붙으면 하루가 밀린다."""
        with db.get_connection() as conn:
            # 로컬 자정을 UTC 로 환산해 그 시각의 팩트를 만든다
            midnight_utc = conn.execute(
                "SELECT datetime('2026-09-05', 'utc')"
            ).fetchone()[0]
        manage_db.upsert_facts("a@x", "u_a", [_fact("g-mid", midnight_utc)])
        self.assertEqual(self._count("2026-09-05", "2026-09-05"), 1)
        self.assertEqual(self._count("2026-09-04", "2026-09-04"), 0)

    def test_rows_outside_the_range_stay_outside(self):
        """범위 밖이 없으면 조건을 통째로 지워도 시험이 통과한다(앞 회차에서 밟은 함정)."""
        mid = "2026-09-05T06:00:00Z"
        day = self._local_day(mid)
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-in", mid),
            _fact("g-before", "2026-09-01T06:00:00Z"),
            _fact("g-after", "2026-09-09T06:00:00Z"),
        ])
        self.assertEqual(self._count(day, day), 1)
        self.assertEqual(self._count(), 3)  # 조건이 없으면 전부

    def test_both_timestamp_formats_are_handled(self):
        """팩트 `created_at` 은 `'YYYY-MM-DD HH:MM:SS'` 와 `'...T...Z'` 가 섞인다."""
        a, b = "2026-09-05T06:00:00Z", "2026-09-05 07:00:00"
        day = self._local_day(a)
        self.assertEqual(day, self._local_day(b))  # 같은 날이어야 의미 있는 시험
        manage_db.upsert_facts("a@x", "u_a", [_fact("g-z", a), _fact("g-space", b)])
        self.assertEqual(self._count(day, day), 2)

    def test_a_broken_timestamp_is_simply_out_of_range_not_a_crash(self):
        """잘못된 시각은 `julianday()` 가 NULL 이라 비교가 거짓이 된다 — 조용히 빠진다."""
        good = "2026-09-05T06:00:00Z"
        day = self._local_day(good)
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-ok", good),
            _fact("g-bad", "언제인지 모름"),
            _fact("g-empty", ""),
        ])
        self.assertEqual(self._count(day, day), 1)
        self.assertEqual(self._count(), 3)  # 조건이 없으면 전부 보인다(집계에서 사라지지 않는다)

    # ── 시간 차트의 경계 (날짜와 규칙이 다르다) ─────────────────────────
    def _buckets(self, time_from=None, time_to=None):
        out = manage_db.team_timeseries(
            workspace_id="ws1", bucket="hour", time_from=time_from, time_to=time_to
        )
        return sum(b["count"] for b in out)

    @staticmethod
    def _local_naive(stamp: str) -> str:
        """그 UTC 시각을 프론트가 보내는 **로컬 나이브 문자열**로."""
        with db.get_connection() as conn:
            return conn.execute("SELECT datetime(?, 'localtime')", (stamp,)).fetchone()[0]

    def test_the_end_second_includes_its_fractional_part(self):
        """★내가 만든 회귀 — 종전 `datetime()` 은 소수 초를 **버리고** 비교했다.

        `julianday` 는 소수 초까지 비교하므로 `<=` 로 두면 `…:59:59.500Z` 가 빠진다
        (코덱스가 `team_timeseries` 로 재현). 종료 인자를 초로 정규화하고 **다음 초 미만**으로 쓴다.
        프론트는 종료를 `HH:59:59` 형태로 보낸다.
        """
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-000", "2026-09-05T06:59:59Z"),
            _fact("g-500", "2026-09-05T06:59:59.500Z"),
            _fact("g-999", "2026-09-05T06:59:59.999Z"),
            _fact("g-next", "2026-09-05T07:00:00Z"),
        ])
        end = self._local_naive("2026-09-05T06:59:59Z")
        self.assertEqual(self._buckets(time_to=end), 3)  # .000/.500/.999 는 들어오고
        self.assertEqual(self._buckets(), 4)             # 다음 초는 조건 없을 때만

    def test_the_start_second_includes_its_fractional_part(self):
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-before", "2026-09-05T05:59:59.500Z"),
            _fact("g-at", "2026-09-05T06:00:00Z"),
            _fact("g-after", "2026-09-05T06:00:00.500Z"),
        ])
        start = self._local_naive("2026-09-05T06:00:00Z")
        self.assertEqual(self._buckets(time_from=start), 2)

    def test_a_fractional_second_argument_is_normalised_like_before(self):
        """★인자 쪽 소수 초도 종전처럼 **버린다**.

        옛 조건은 `datetime(?)` 으로 인자를 초 단위로 잘랐다. `julianday(?)` 로 그냥 두면
        `15:00:00.500` 을 시작으로 줬을 때 `15:00:00.000` 행이 빠진다 — 종전엔 들어왔다.
        프론트는 초 단위로 보내지만, 계약이 바뀌면 다른 호출자가 걸린다.
        """
        manage_db.upsert_facts("a@x", "u_a", [_fact("g-at", "2026-09-05T06:00:00Z")])
        start = self._local_naive("2026-09-05T06:00:00Z")  # '... 15:00:00'
        self.assertEqual(self._buckets(time_from=start), 1)
        self.assertEqual(self._buckets(time_from=start + ".500"), 1)  # 인자의 소수 초는 버려진다

    def test_a_time_window_keeps_rows_outside_it_outside(self):
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-in", "2026-09-05T06:30:00Z"),
            _fact("g-early", "2026-09-05T05:00:00Z"),
            _fact("g-late", "2026-09-05T08:00:00Z"),
        ])
        lo = self._local_naive("2026-09-05T06:00:00Z")
        hi = self._local_naive("2026-09-05T06:59:59Z")
        self.assertEqual(self._buckets(lo, hi), 1)
        self.assertEqual(self._buckets(), 3)

    # ── 팩트와 장부가 같은 날을 말해야 한다 ──────────────────────────────
    def test_the_ledger_uses_the_same_day_boundary_as_the_facts(self):
        """★둘이 갈리면 '9월 5일 사용량' 과 '9월 5일 장부' 가 다른 날을 가리킨다."""
        late = "2026-09-05T14:59:59Z"
        day = self._local_day(late)
        manage_db.upsert_facts("a@x", "u_a", [_fact("g-late", late)])
        record_transactions("u_me", "me@x", [{
            "created_at": late, "credits": -10, "action": "spend",
            "display_name": "Seedance 2.5", "model": "seedance", "workspace_id": "ws1",
        }])
        self.assertEqual(self._count(day, day), 1)
        self.assertEqual(ledger_totals(date_from=day, date_to=day)["spend"], 10.0)
        # 하루 앞뒤로는 둘 다 비어야 한다
        with db.get_connection() as conn:
            prev, nxt = conn.execute(
                "SELECT date(?, '-1 day'), date(?, '+1 day')", (day, day)
            ).fetchone()
        self.assertEqual(self._count(prev, prev), 0)
        self.assertEqual(ledger_totals(date_from=nxt, date_to=nxt)["spend"], 0.0)

    def test_decimals_and_refunds_survive_the_new_boundary(self):
        """경계를 바꾸느라 소수·환불 계약이 깨지면 안 된다."""
        stamp = "2026-09-05T06:00:00Z"
        day = self._local_day(stamp)
        record_transactions("u_me", "me@x", [
            {"created_at": stamp, "credits": -1.5, "action": "spend",
             "display_name": "Nano Banana 2", "workspace_id": "ws1"},
            {"created_at": stamp, "credits": -0.12, "action": "spend",
             "display_name": "Higgsfield Soul V2", "workspace_id": "ws1"},
            {"created_at": stamp, "credits": 0.5, "action": "refund",
             "display_name": "Nano Banana 2", "workspace_id": "ws1"},
        ])
        out = ledger_totals(date_from=day, date_to=day)
        self.assertEqual(out["spend"], 1.62)
        self.assertEqual(out["refund"], 0.5)
        self.assertEqual(out["net"], 1.12)

    def test_the_account_scope_still_holds_with_a_date_range(self):
        """범위 조건을 바꾸느라 권한 조건이 헐거워지면 남의 지출이 보인다."""
        stamp = "2026-09-05T06:00:00Z"
        day = self._local_day(stamp)
        for email, amount in (("me@x", -10), ("other@x", -3)):
            record_transactions("u_" + email[:2], email, [{
                "created_at": stamp, "credits": amount, "action": "spend",
                "display_name": "M", "workspace_id": "ws1",
            }])
        self.assertEqual(
            ledger_totals(date_from=day, date_to=day, account_email="me@x")["spend"], 10.0
        )
        self.assertEqual(ledger_totals(date_from=day, date_to=day)["spend"], 13.0)

    # ── 인덱스가 실제로 쓰이는가 ────────────────────────────────────────
    @staticmethod
    def _traced(run, connect):
        """제품이 **실제로 실행한** SQL 을 모은다.

        ★시험이 SQL 을 손으로 쓰면 제품이 무엇을 만드는지는 아무것도 검증하지 못한다
         (열을 다시 함수로 감싸는 회귀를 못 잡는다). 그래서 실행된 문장을 받아 온다.
        """
        seen: list[str] = []
        import contextlib
        from unittest.mock import patch

        real = connect[0]

        @contextlib.contextmanager
        def traced(*a, **k):
            with real(*a, **k) as conn:
                conn.set_trace_callback(seen.append)
                try:
                    yield conn
                finally:
                    conn.set_trace_callback(None)

        with patch.object(connect[1], "get_connection", traced):
            run()
        return seen

    def _plans_for(self, statements, table):  # noqa: D401
        """실행된 문장 중 그 테이블의 날짜 범위 조회들의 실행계획."""
        out = []
        with manage_db.get_connection() as conn:
            for sql in statements:
                text = " ".join(sql.split())
                if not text.upper().startswith("SELECT") or table not in text:
                    continue
                if "created_at" not in text:
                    continue
                # ★예외를 삼키면 안 된다 — 하나도 못 얻어도 빈 목록이라 검사 반복문이
                #  통과해 버린다(코덱스 지적). 실패는 실패로 드러낸다.
                plan = " ".join(
                    str(r[-1]) for r in conn.execute("EXPLAIN QUERY PLAN " + sql)
                )
                out.append((text, plan))
        return out

    def test_the_fact_range_filter_actually_uses_an_index(self):
        """★제품이 만든 질의가 `SCAN` 이면 이 수정은 뜻이 없다.

        ★공간을 지정하면 SQLite 는 **공간 복합 인덱스**를 고른다(그게 더 좁으니 맞다).
         그래서 표현식 인덱스의 효과는 **공간 없이 날짜만으로** 거를 때 드러난다 —
         코덱스의 244배 측정도 그 조건이었다. 두 경우를 나눠 본다.
        """
        manage_db.upsert_facts("a@x", "u_a", [_fact("g1", "2026-09-05T06:00:00Z")])
        stmts = self._traced(
            lambda: manage_db.team_overview(
                workspace_id="ws1", date_from="2026-09-05", date_to="2026-09-05"
            ),
            (manage_db.get_connection, manage_db),
        )
        ranged = [
            s for s in stmts
            if "team_generation_fact" in s and "julianday(created_at)" in s
        ]
        self.assertTrue(ranged, "제품이 julianday 범위 조건을 쓰지 않는다: " + str(stmts)[:400])
        # ① 공간이 있을 때: 어떤 인덱스든 쓰되 전량 SCAN 이면 안 된다
        plans = self._plans_for(ranged, "team_generation_fact")
        self.assertTrue(plans, "실행계획을 하나도 못 얻었다 — 빈 목록이면 아래 검사가 무의미하다")
        for text, plan in plans:
            self.assertNotIn("SCAN team_generation_fact", plan, text[:200])
        # ② 공간 없이 날짜만: 표현식 인덱스가 실제로 걸려야 한다.
        #    조건은 **제품이 만든 것**을 그대로 쓴다(손으로 SQL 을 쓰면 회귀를 못 잡는다).
        where, args = manage_db._agg_where(
            "2026-09-05", "2026-09-05", None, None, None, None, None
        )
        with manage_db.get_connection() as conn:
            plan = " ".join(
                str(r[-1])
                for r in conn.execute(
                    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM team_generation_fact " + where,
                    args,
                )
            )
        self.assertIn("idx_tgf_julian", plan, plan)

    def test_the_ledger_range_filter_actually_uses_an_index(self):
        """장부도 같다 — 제품이 만든 질의를 본다."""
        record_transactions("u_me", "me@x", [{
            "created_at": "2026-09-05T06:00:00Z", "credits": -1, "action": "spend",
            "display_name": "M", "workspace_id": "ws1",
        }])
        from app.repo import manage_transactions as mt
        stmts = self._traced(
            lambda: ledger_totals(date_from="2026-09-05", date_to="2026-09-05"),
            (mt.get_connection, mt),  # ★임포트된 이름을 쓰는 **그 모듈**에서 패치한다
        )
        ranged = [s for s in stmts if "credit_txn" in s and "julianday(created_at)" in s]
        self.assertTrue(ranged, "제품이 julianday 범위 조건을 쓰지 않는다: " + str(stmts)[:400])
        with db.get_connection() as conn:
            plans = [
                " ".join(str(r[-1]) for r in conn.execute("EXPLAIN QUERY PLAN " + sql))
                for sql in ranged
            ]
        self.assertTrue(
            any("idx_credit_txn_julian" in plan for plan in plans),
            "표현식 인덱스를 쓰지 않는다: " + str(plans)[:400],
        )

    # ── 손대지 않기로 한 것 ─────────────────────────────────────────────
    def test_budget_period_totals_are_untouched(self):
        """예산 주기 `CASE` 는 그대로 둔다 — `WHERE` 로 옮기면 전체 누적 합계가 달라진다."""
        now = datetime.now(timezone.utc)
        manage_db.upsert_facts("a@x", "u_a", [
            _fact("g-now", now.strftime("%Y-%m-%dT%H:%M:%SZ")),
            _fact("g-old", (now - timedelta(days=400)).strftime("%Y-%m-%dT%H:%M:%SZ")),
        ])
        out = manage_db.fact_usage("ws1", None, {"p1": "month"}, None, 1)
        self.assertEqual(out["stats"]["p1"]["gen_count"], 2)  # 전체는 둘 다
        self.assertEqual(out["budget_models"]["p1"][0]["count"], 1)  # 이번 달은 하나


if __name__ == "__main__":
    unittest.main()
