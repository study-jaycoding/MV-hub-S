"""push 직전의 `account status` 는 **중복이 아니라 신원 재확인**이다.

★2026-09-12: 한 push 사이클이 `hf account status` 를 두 번 띄우는 것이 낭비로 보여
 (CLI 1회 실측 약 470ms) 앞의 응답을 캐시해 합치려 했다. **되돌렸다.**

 코덱스가 반례를 댔고 코드로 확인했다: 서버는 에이전트가 보고한 `account_status.email` 로
 계정을 대조한다(`routers/ingest.py` 의 409). 다른 터미널에서 CLI 계정을 A→B 로 바꾸면
 `generate list` 는 **B 의 잡**을 주는데 보고 이메일만 캐시된 **A** 로 남아,
 B 의 생성물이 A 에게 귀속되고 서버 검사도 통과한다.

 기존 계약 시험(`test_agent_contracts.py` 의 `test_account_cycle_snapshot_shares_cli_calls_
 within_one_cycle`)도 `status_calls == 2` 를 "email 1 + collect 1" 로 명시하고 있었다.
 **그 2회는 의도된 설계다.** 이 파일은 그 이유를 시험으로 못 박아 다시 '최적화'되지 않게 한다.

이 파일이 지키는 것:
  · push 시점의 계정 조회는 **그때의 CLI 계정**을 봐야 한다(캐시 금지)
  · 재로그인 **시도 시작**에 사이클 snapshot 을 버린다(로그아웃만 되고 로그인이 실패해도)
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent


class AccountIdentityRecheckTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()
        self.agent._begin_account_cycle()
        self.calls: list[tuple] = []
        self.account = {"email": "a@example.com", "credits": 100.0, "plan": "enterprise"}
        self.workspaces = [{"id": "ws-a", "name": "A 공간", "is_selected": True}]

    def _cli(self):
        def fake(cli, *args, **kwargs):
            self.calls.append(args)
            if args[:2] == ("account", "status"):
                return dict(self.account)
            if args[:2] == ("workspace", "list"):
                return [dict(w) for w in self.workspaces]
            return None

        return fake

    def _count(self, name: tuple) -> int:
        return sum(1 for a in self.calls if a[: len(name)] == name)

    def test_an_account_switched_outside_the_agent_is_seen_at_push_time(self):
        """★이 시험이 이 파일의 이유다 — 캐시로 합치면 여기서 걸린다.

        A 로 사이클을 시작한 뒤 **다른 터미널에서** B 로 로그인했다. push 가 보고하는
        이메일은 **B** 여야 한다. A 를 보고하면 B 의 생성물이 A 에게 귀속되고,
        서버의 이메일 대조(409)도 통과해 버린다.
        """
        with patch.object(self.agent, "_cli_json", side_effect=self._cli()), \
             patch.object(self.agent, "_cached_cli_version", return_value="1.1.24"):
            self.assertEqual(self.agent._cycle_account_email("hf"), "a@example.com")
            # ── 여기서 외부 전환이 일어난다 ──
            self.account = {"email": "b@example.com", "credits": 20.0, "plan": "team"}
            self.workspaces = [{"id": "ws-b", "name": "B 공간", "is_selected": True}]
            acct, workspace = self.agent._cycle_collect_account_status("hf")
        self.assertEqual(acct["email"], "b@example.com")
        self.assertEqual(workspace["id"], "ws-b")

    def test_the_balance_reported_at_push_time_is_the_one_after_submitting(self):
        """제출(과금)은 이메일 조회와 push 사이에 일어난다 — 잔액도 그때 값이어야 한다."""
        with patch.object(self.agent, "_cli_json", side_effect=self._cli()), \
             patch.object(self.agent, "_cached_cli_version", return_value="1.1.24"):
            self.agent._cycle_account_email("hf")
            self.account = {**self.account, "credits": 70.0}  # 제출로 30 차감
            acct, _ws = self.agent._cycle_collect_account_status("hf")
        self.assertEqual(acct["credits"], 70.0)

    def test_the_workspace_list_is_collected_with_it(self):
        """서버는 `workspaces` **키 없음**과 **빈 배열**을 다르게 다룬다(빈 배열=멤버십 비활성화)."""
        with patch.object(self.agent, "_cli_json", side_effect=self._cli()), \
             patch.object(self.agent, "_cached_cli_version", return_value="1.1.24"):
            acct, workspace = self.agent._cycle_collect_account_status("hf")
        self.assertEqual([w["id"] for w in acct["workspaces"]], ["ws-a"])
        self.assertEqual(workspace["id"], "ws-a")
        self.assertIn("cli_version", acct)

    def test_a_failed_status_call_leaves_no_workspaces_key_at_all(self):
        """CLI 실패를 빈 배열로 메우면 서버가 그 계정 멤버십을 통째로 내린다."""
        def fake(cli, *args, **kwargs):
            self.calls.append(args)
            return None if args[:2] == ("account", "status") else []

        with patch.object(self.agent, "_cli_json", side_effect=fake):
            acct, workspace = self.agent._cycle_collect_account_status("hf")
        self.assertIsNone(acct)
        self.assertEqual(workspace["scope"], "unknown")

    def test_a_failed_email_lookup_is_not_cached_as_success(self):
        """실패를 캐시로 굳히면 사이클 내내 계정을 모르는 상태가 고정된다(기존 계약)."""
        def fake(cli, *args, **kwargs):
            self.calls.append(args)
            return None

        with patch.object(self.agent, "_cli_json", side_effect=fake):
            self.assertIsNone(self.agent._cycle_account_email("hf"))
            self.assertIsNone(self.agent._cycle_account_email("hf"))
        self.assertEqual(self._count(("account", "status")), 2)  # 실패는 재시도한다
        self.assertNotIn("email", self.agent._ACCT_CYCLE)

    def test_a_relogin_attempt_drops_the_snapshot_before_logging_out(self):
        """★로그인 실행이 예외로 끝나도 이전 계정 snapshot 이 남으면 안 된다.

        `auth logout` 은 이미 실행됐으므로 그 시점의 CLI 계정은 더 이상 옛 계정이 아니다.
        종전엔 로그인까지 마친 뒤에야 무효화해서, 예외 반환 경로가 캐시를 남겼다.
        """
        with patch.object(self.agent, "_cli_json", side_effect=self._cli()):
            self.agent._cycle_account_email("hf")
        self.assertIn("email", self.agent._ACCT_CYCLE)

        def boom(argv, **kwargs):
            if argv[-1] == "login":
                raise OSError("로그인 창을 띄우지 못함")
            return None

        with (
            patch.object(self.agent.subprocess, "run", side_effect=boom),
            patch.object(self.agent.webbrowser, "open", return_value=True),
            patch("builtins.input", return_value=""),
        ):
            self.assertIsNone(self.agent._signout_and_relogin("hf"))
        self.assertEqual(self.agent._ACCT_CYCLE, {})

    def test_a_successful_relogin_also_starts_clean(self):
        """정상 재로그인도 이전 계정 값을 물고 오면 안 된다."""
        with patch.object(self.agent, "_cli_json", side_effect=self._cli()):
            self.agent._cycle_account_email("hf")
            self.account = {"email": "b@example.com", "credits": 1.0}
            with (
                patch.object(self.agent.subprocess, "run", return_value=None),
                patch.object(self.agent.webbrowser, "open", return_value=True),
                patch("builtins.input", return_value=""),
            ):
                self.assertEqual(self.agent._signout_and_relogin("hf"), "b@example.com")


if __name__ == "__main__":
    unittest.main()
