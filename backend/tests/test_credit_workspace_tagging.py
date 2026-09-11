"""거래에 '어느 공간에서 빠진 돈인지'를 남긴다.

힉스필드 거래 응답에는 공간 표시가 없어(키는 action·created_at·credits·display_name 넷)
에이전트가 공간별로 걷을 때 붙여 보낸다([[test_agent_transaction_workspaces]]).

★거래 **신원**(UNIQUE 인덱스·ID 산식)에는 공간을 넣지 않는다. created_at 이 마이크로초까지
 있어 (이메일+시각+금액+action+표시명)이 사실상 고유하고, 신원을 바꾸면 배포 전 행과 배포 후
 행이 갈려 **같은 거래가 두 번 세어진다**. 공간은 model 과 같은 보강 컬럼으로 다룬다.
"""

from __future__ import annotations

import unittest

from app import db
from app.repo import manage
from test_credit_precision import BASE, _ContentDbCase


def _transaction(**overrides) -> dict:
    row = {
        "created_at": BASE.isoformat().replace("+00:00", "Z"),
        "credits": -1.5,
        "action": "spend",
        "display_name": "Nano Banana 2",
        "model": "nano_banana_flash",
    }
    row.update(overrides)
    return row


class WorkspaceTaggingTests(_ContentDbCase):
    def _stored(self):
        with db.get_connection() as conn:
            return conn.execute(
                "SELECT id, workspace_id FROM credit_txn ORDER BY created_at"
            ).fetchall()

    def test_the_workspace_is_stored_with_the_transaction(self):
        manage.record_transactions(
            "u_me", "me@example.com", [_transaction(workspace_id="ws-c")]
        )
        rows = self._stored()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["workspace_id"], "ws-c")

    def test_an_older_row_without_a_workspace_is_filled_in_later(self):
        """옛 에이전트가 올린 행(NULL)은 새 에이전트의 보고로 채워진다 — 행이 늘지 않는다."""
        manage.record_transactions("u_me", "me@example.com", [_transaction()])
        self.assertIsNone(self._stored()[0]["workspace_id"])

        manage.record_transactions(
            "u_me", "me@example.com", [_transaction(workspace_id="ws-c")]
        )
        rows = self._stored()
        self.assertEqual(len(rows), 1)  # ★같은 거래다 — 신원에 공간이 안 들어가야 성립한다
        self.assertEqual(rows[0]["workspace_id"], "ws-c")

    def test_an_existing_workspace_is_not_overwritten(self):
        """이미 붙은 공간을 다른 값으로 조용히 바꾸면 '어디서 빠진 돈인가'를 잃는다."""
        manage.record_transactions(
            "u_me", "me@example.com", [_transaction(workspace_id="ws-c")]
        )
        manage.record_transactions(
            "u_me", "me@example.com", [_transaction(workspace_id="ws-b")]
        )
        rows = self._stored()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["workspace_id"], "ws-c")

    def test_transactions_from_different_workspaces_stay_separate_rows(self):
        """시각이 다르면(실측은 마이크로초까지 온다) 공간이 달라도 각자 한 행이다."""
        manage.record_transactions(
            "u_me",
            "me@example.com",
            [
                _transaction(created_at="2026-09-11T10:30:19.805680Z", workspace_id="ws-c"),
                _transaction(created_at="2026-09-05T03:58:13.105183Z", workspace_id="ws-b"),
            ],
        )
        rows = self._stored()
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["workspace_id"] for r in rows}, {"ws-b", "ws-c"})

    def test_a_blank_workspace_is_stored_as_unknown_not_as_empty_text(self):
        manage.record_transactions(
            "u_me", "me@example.com", [_transaction(workspace_id="   ")]
        )
        self.assertIsNone(self._stored()[0]["workspace_id"])


if __name__ == "__main__":
    unittest.main()
