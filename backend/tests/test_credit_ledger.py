"""거래 원장 합계 — 사용 · 환불 · 순사용.

★왜 필요한가(2026-09-12 실측): 걷은 거래 970건 중 **28건 480크레딧이 환불**인데 어디에도
 반영되지 않고 있었다. 힉스필드 잔액은 돌아오는데 우리 장부의 '쓴 돈'은 그대로였다.

환불을 개별 생성물에 잇는 것은 **포기했다** — 같은 (공간·모델·금액) 지출이 시간창 안에
수십~수백 건이라, **거래 후보 분석**에서 후보가 하나뿐인 환불은 15분 창 기준 480크레딧 중
**97(20%)** 이었다(후보가 하나라고 진짜 짝이라는 증명은 아니다 — 생성물 DB 없이 거래만 본 계산).
그래서 총액에서만 뺀다. 프로젝트별 숫자는 환불 전 값 그대로 둔다(어느 프로젝트의 환불인지
모르므로 추측해 배분하지 않는다).

★생성물 팩트와 **더하지 않는다**. 팩트는 생성물별 실제(없으면 견적)이고 원장은 실제로 오간
 거래다. 대상·시각·견적 포함 여부가 달라 두 합계가 같을 이유가 없다.
"""

from __future__ import annotations

import unittest

from app import db
from app.repo.manage_transactions import ledger_totals, record_transactions
from test_credit_precision import _ContentDbCase


def _txn(created_at, credits, action="spend", workspace_id=None, name="Nano Banana 2"):
    return {
        "created_at": created_at,
        "credits": credits,
        "action": action,
        "display_name": name,
        "model": "nano_banana_flash",
        "workspace_id": workspace_id,
    }


class LedgerTotalsTests(_ContentDbCase):
    def _record(self, rows, email="me@example.com"):
        record_transactions("u_me", email, rows)

    def test_spend_and_refund_are_reported_separately_and_netted(self):
        """★환불이 순사용에서 빠진다 — 이게 이 기능의 전부다."""
        self._record([
            _txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c"),
            _txn("2026-09-05T02:00:00Z", -32.5, workspace_id="ws-c"),
            _txn("2026-09-05T03:00:00Z", 52, action="refund", workspace_id="ws-c"),
        ])
        out = ledger_totals(workspace_id="ws-c")
        self.assertEqual(out["spend"], 84.5)
        self.assertEqual(out["refund"], 52.0)
        self.assertEqual(out["net"], 32.5)  # 84.5 − 52
        self.assertEqual((out["spend_count"], out["refund_count"]), (2, 1))

    def test_decimals_survive(self):
        """−1.5·−0.12 는 실측값이다. 반올림하면 33% 과대·전액 소실이 된다."""
        self._record([
            _txn("2026-09-05T01:00:00Z", -1.5, workspace_id="ws-c"),
            _txn("2026-09-05T02:00:00Z", -0.12, workspace_id="ws-c", name="Higgsfield Soul V2"),
        ])
        self.assertEqual(ledger_totals(workspace_id="ws-c")["spend"], 1.62)

    def test_each_workspace_is_counted_on_its_own(self):
        self._record([
            _txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c"),
            _txn("2026-09-05T02:00:00Z", -3, workspace_id="ws-b"),
        ])
        self.assertEqual(ledger_totals(workspace_id="ws-c")["spend"], 52.0)
        self.assertEqual(ledger_totals(workspace_id="ws-b")["spend"], 3.0)
        self.assertEqual(ledger_totals()["spend"], 55.0)  # 공간을 안 주면 전부

    def test_rows_without_a_workspace_are_reported_apart_not_mixed_in(self):
        """★공간을 모르는 옛 거래를 선택 공간에 섞으면 그 공간이 안 쓴 돈을 쓴 것으로 만든다."""
        self._record([
            _txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c"),
            _txn("2026-09-05T02:00:00Z", -3, workspace_id=None),  # 옛 에이전트가 올린 행
        ])
        out = ledger_totals(workspace_id="ws-c")
        self.assertEqual(out["spend"], 52.0)  # 3 이 섞이지 않았다
        self.assertEqual(out["unknown_workspace"]["spend"], 3.0)
        self.assertEqual(out["unknown_workspace"]["count"], 1)
        # 공간을 안 고르면 미상도 이미 총액에 들어 있으니 따로 보고하지 않는다(중복 합산 방지).
        self.assertNotIn("unknown_workspace", ledger_totals())

    def test_a_month_with_only_refunds_reports_a_negative_net(self):
        """걷은 100건 창 안에서 2026-07 MILLION VOLT 에는 환불 138크레딧이 잡혔다(그달 지출이
        아예 없었다는 확인은 아니다 — 창 밖은 안 봤다). 어느 쪽이든 0 으로 막으면 합이 안 맞는다."""
        self._record([_txn("2026-07-20T01:00:00Z", 138, action="refund", workspace_id="ws-m")])
        out = ledger_totals(workspace_id="ws-m", date_from="2026-07-01", date_to="2026-07-31")
        self.assertEqual(out["refund"], 138.0)
        self.assertEqual(out["net"], -138.0)

    def test_the_end_date_includes_that_whole_day(self):
        """`datetime(...) <= '종료일'` 로 비교하면 종료일 늦은 시각 거래가 통째로 빠진다.

        ★기준일은 **실행 환경의 시간대**로 정해진다(`date(...,'localtime')`) — 이 PC 는 KST,
         실서버는 UTC 라 같은 UTC 시각이 다른 날로 잡힌다. 그래서 기대 날짜를 상수로 박지 않고
         DB 에게 물어본다. 시간대 불일치 자체는 팩트와 함께 옮겨야 하는 기존 보류 사항이다."""
        stamp = "2026-09-05T23:30:00Z"
        self._record([
            _txn(stamp, -52, workspace_id="ws-c"),  # 이 날 늦은 시각 — 포함되어야 한다
            _txn("2026-09-03T05:00:00Z", -7, workspace_id="ws-c"),  # 시작일 앞 — 빠져야 한다
            _txn("2026-09-08T05:00:00Z", -9, workspace_id="ws-c"),  # 종료일 뒤 — 빠져야 한다
        ])
        with db.get_connection() as conn:
            day = conn.execute("SELECT date(?, 'localtime')", (stamp,)).fetchone()[0]
        out = ledger_totals(workspace_id="ws-c", date_from=day, date_to=day)
        # 범위 밖 두 건이 없으면 기간 조건을 통째로 지워도 이 시험이 통과한다(코덱스 리뷰).
        self.assertEqual(out["spend"], 52.0)
        self.assertEqual(out["spend_count"], 1)
        self.assertEqual(ledger_totals(workspace_id="ws-c")["spend"], 68.0)  # 조건 없으면 셋 다

    def test_a_member_only_sees_their_own_account(self):
        """일반 멤버 범위는 서버가 이메일로 강제한다 — 전체로 폴백하면 남의 지출이 보인다."""
        self._record([_txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c")], email="me@example.com")
        self._record([_txn("2026-09-05T02:00:00Z", -3, workspace_id="ws-c")], email="other@example.com")
        self.assertEqual(ledger_totals(account_email="me@example.com")["spend"], 52.0)
        self.assertEqual(ledger_totals(account_email="other@example.com")["spend"], 3.0)
        self.assertEqual(ledger_totals()["spend"], 55.0)

    def test_an_unknown_account_gets_nothing_not_everything(self):
        """계정이 없으면 `\\x00` 이 온다 — 그때 전체가 열리면 권한이 뚫린다."""
        self._record([_txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c")])
        self.assertEqual(ledger_totals(account_email="\x00")["spend"], 0.0)

    def test_a_broken_amount_is_left_out_rather_than_counted_as_zero(self):
        """숫자가 아닌 금액이 `ABS()` 를 거쳐 0 으로 섞이면 '정확해 보이는 틀린 수'가 된다."""
        self._record([_txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c")])
        with db.get_connection() as conn:  # 손상된 행을 직접 넣는다(적재 경로는 이미 막는다)
            conn.execute(
                "INSERT INTO credit_txn(id, owner_uid, account_email, display_name, credits, "
                "action, created_at, workspace_id) VALUES('broken','u_me','me@example.com','X',"
                "'not-a-number','spend','2026-09-05T04:00:00Z','ws-c')"
            )
        out = ledger_totals(workspace_id="ws-c")
        self.assertEqual(out["spend"], 52.0)
        self.assertEqual(out["spend_count"], 1)

    def test_a_refund_with_an_unreadable_amount_is_refused_at_the_door(self):
        """★환불도 금액을 검증한다(코덱스 리뷰) — bool 은 SQLite 에서 1.0 이 되고 무한대는 `real`
        로 저장돼 집계에 섞인다(무한대는 JSON 직렬화까지 깨뜨린다)."""
        for bad in (True, float("inf"), "free"):
            with self.subTest(credits=bad):
                self._record([_txn("2026-09-05T01:00:00Z", bad, action="refund", workspace_id="ws-c")])
        self.assertEqual(ledger_totals(workspace_id="ws-c")["refund"], 0.0)

    def test_another_account_does_not_leak_through_the_unknown_bucket(self):
        """미상 집계에도 같은 계정 조건이 걸려야 한다 — 안 그러면 옆길로 남의 지출이 보인다."""
        self._record([_txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c")], email="me@example.com")
        self._record([_txn("2026-09-05T02:00:00Z", -3, workspace_id=None)], email="other@example.com")
        out = ledger_totals(workspace_id="ws-c", account_email="me@example.com")
        self.assertEqual(out["spend"], 52.0)
        self.assertEqual(out["unknown_workspace"]["spend"], 0.0)  # 남의 미상 거래가 안 샌다

    def test_an_empty_email_is_a_restriction_not_a_free_pass(self):
        """`if account_email:` 이면 빈 문자열이 전체 조회가 된다 — 권한이 뚫리는 자리."""
        self._record([_txn("2026-09-05T01:00:00Z", -52, workspace_id="ws-c")])
        self.assertEqual(ledger_totals(account_email="")["spend"], 0.0)
        self.assertEqual(ledger_totals(account_email=None)["spend"], 52.0)  # None 만 전체

    def test_other_actions_are_kept_apart_from_spend_and_refund(self):
        """grant 는 실측 970건에 0건이었다 — 관측되면 따로 보여 주고 충전으로 추정하지 않는다."""
        self._record([_txn("2026-09-05T01:00:00Z", 500, action="grant", workspace_id="ws-c")])
        out = ledger_totals(workspace_id="ws-c")
        self.assertEqual((out["spend"], out["refund"], out["net"]), (0.0, 0.0, 0.0))
        self.assertEqual(out["other"], {"grant": 500.0})


if __name__ == "__main__":
    unittest.main()
