"""거래는 공간마다 걷고, 못 다 읽은 구간은 다음 사이클이 이어 본다.

★2026-09-11 실측(CLI 1.1.24, 읽기 전용)으로 확인한 것:
· `account transactions` 는 **공간별**이다. 전역 선택을 뻘뻘뻘로 둔 채 같은 명령을 env 만 바꿔
  실행하니 뻘뻘뻘 최신 거래는 09-05, R&D 는 **09-11**(그날 쓴 1크레딧)이었다. 전역 조회에는
  그 1크레딧이 **안 보인다**.
· 응답에는 어느 공간인지 **표시가 없다**(키는 action·created_at·credits·display_name 넷뿐).
  → 호출할 때 우리가 붙이는 수밖에 없다.
· 한 페이지는 최대 100건·최신순이고 `--cursor` 로 이어 읽는다. 실측 세 공간 모두 `cursor=100`
  (더 있음)이었고, 뻘뻘뻘의 100건은 **7시간 치**였다 — 한 사람이 반나절이면 창을 채운다.

2026-09-11 부터 허브는 CLI 전역을 안 바꾸므로(워크스페이스 선택은 앱이 소유) 전역은
'에이전트가 마지막으로 제출한 요청의 공간'에 머문다. 그 외 공간은 영구 사각지대였다.

수집 상태는 공간마다 셋이다:
  newest          — **끝까지 훑은** 스캔의 최신 시각. 다음 스캔은 여기서 6시간 겹쳐 내려간다
  cursor          — 상한에 걸려 못 다 읽었을 때 이어 볼 위치
  pending_newest  — 그 미완결 스캔에서 본 최신(완결되는 사이클에 newest 로 승격)
★상한에 걸렸는데 newest 를 올려 버리면 다음 사이클이 같은 앞부분만 되풀이하고 뒤쪽은
 영영 안 읽힌다(코덱스 P1 — 600건이면 500 → 100 → 다시 앞 500 이 되어 뒤 100 을 못 본다).
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent


WORKSPACES = [
    {"id": "ws-b", "name": "뻘뻘뻘"},
    {"id": "ws-c", "name": "R&D"},
]


def _txn(created_at: str, credits: float = -1.5, name: str = "Nano Banana 2") -> dict:
    return {
        "action": "spend",
        "created_at": created_at,
        "credits": credits,
        "display_name": name,
    }


def _settled(newest: str) -> dict:
    return {"newest": newest, "cursor": None, "pending_newest": None}


class _FakeCompleted:
    def __init__(self, stdout: str):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""


class CollectionTests(unittest.TestCase):
    """가짜는 subprocess 경계에만 둔다 — env 조립·페이지 넘김·태깅은 제품 코드가 한다."""

    def setUp(self):
        self.agent = _load_agent()

    def _collect(self, pages_by_workspace, marks=None, *, reinspect=False, fail=()):
        """pages_by_workspace: {ws_id: [응답, ...]}. 항목이 None 이면 그 호출은 CLI 실패."""
        calls: list[dict] = []
        remaining = {k: list(v) for k, v in pages_by_workspace.items()}

        def fake_run(cmd, **kwargs):
            env = kwargs.get("env") or {}
            workspace_id = env.get("HIGGSFIELD_WORKSPACE_ID")
            calls.append({"cmd": list(cmd), "workspace": workspace_id})
            if workspace_id in fail:
                return type("R", (), {"returncode": 1, "stdout": "", "stderr": "boom"})()
            queue = remaining.get(workspace_id) or []
            page = queue.pop(0) if queue else {"items": []}
            if page is None:
                return type("R", (), {"returncode": 1, "stdout": "", "stderr": "boom"})()
            return _FakeCompleted(json.dumps(page))

        with patch.object(self.agent.subprocess, "run", side_effect=fake_run):
            collected, state = self.agent._collect_workspace_transactions(
                "hf", WORKSPACES, marks or {}, reinspect=reinspect
            )
        return collected, state, calls

    # ── 공간별 봉투 ──────────────────────────────────────────────────────────
    def test_every_workspace_is_read_with_its_own_envelope(self):
        """★핵심 — 공간마다 `HIGGSFIELD_WORKSPACE_ID` 를 박아 따로 부른다."""
        collected, state, calls = self._collect(
            {
                "ws-b": [{"cursor": None, "items": [_txn("2026-09-05T03:58:13Z", -52, "Seedance 2.5")]}],
                "ws-c": [{"cursor": None, "items": [_txn("2026-09-11T10:30:19Z", -1)]}],
            }
        )
        self.assertEqual([c["workspace"] for c in calls], ["ws-b", "ws-c"])
        self.assertTrue(all("transactions" in c["cmd"] for c in calls))
        # 응답에 공간 표시가 없으니 우리가 붙인다 — 안 붙이면 서버가 출처를 영영 모른다.
        self.assertEqual(sorted(t["workspace_id"] for t in collected), ["ws-b", "ws-c"])
        self.assertEqual(state["ws-b"]["newest"], "2026-09-05T03:58:13Z")
        self.assertEqual(state["ws-c"]["newest"], "2026-09-11T10:30:19Z")

    def test_the_parent_environment_is_never_touched(self):
        """부모 os.environ 을 바꾸면 동시에 도는 생성 호출이 그 공간으로 과금된다."""
        before = os.environ.get("HIGGSFIELD_WORKSPACE_ID")
        self._collect({"ws-b": [{"items": [_txn("2026-09-05T00:00:00Z")]}]})
        self.assertEqual(os.environ.get("HIGGSFIELD_WORKSPACE_ID"), before)

    def test_workspaces_without_an_id_are_skipped(self):
        with patch.object(self.agent.subprocess, "run", side_effect=AssertionError("불려선 안 됨")):
            out, state = self.agent._collect_workspace_transactions("hf", [{"name": "이름만"}], {})
        self.assertEqual((out, state), ([], {}))

    # ── 페이지 넘김 ──────────────────────────────────────────────────────────
    def test_a_full_page_is_continued_with_its_cursor(self):
        """★100건이 꽉 차면 이어 읽는다 — 실측상 한 사람의 100건이 7시간 치다."""
        page1 = {"cursor": "100", "items": [_txn("2026-09-10T12:00:00Z")] * 100}
        page2 = {"cursor": None, "items": [_txn("2026-09-01T00:00:00Z")]}
        collected, _state, calls = self._collect({"ws-b": [page1, page2]}, {})
        ws_b = [c for c in calls if c["workspace"] == "ws-b"]
        self.assertEqual(len(ws_b), 2)
        self.assertIn("--cursor", ws_b[1]["cmd"])
        self.assertIn("100", ws_b[1]["cmd"])
        self.assertEqual(len(collected), 101)

    def test_a_short_page_with_a_cursor_still_continues(self):
        """★cursor 가 기준이다 — '100건 미만이면 끝'으로 보면 남은 구간을 통째로 잃는다."""
        page1 = {"cursor": "7", "items": [_txn("2026-09-10T12:00:00Z")]}  # 겨우 1건인데 더 있다
        page2 = {"cursor": None, "items": [_txn("2026-09-09T00:00:00Z")]}
        collected, _state, calls = self._collect({"ws-b": [page1, page2]}, {})
        self.assertEqual(len([c for c in calls if c["workspace"] == "ws-b"]), 2)
        self.assertEqual(len(collected), 2)

    def test_paging_stops_once_it_reaches_what_we_already_saw(self):
        """이미 본 구간까지 내려오면 멈춘다 — 안 그러면 매 사이클 전체를 다시 읽는다."""
        page1 = {"cursor": "100", "items": [_txn("2026-09-10T12:00:00Z")] * 100}
        page2 = {"cursor": "200", "items": [_txn("2026-09-01T00:00:00Z")] * 100}
        _collected, _state, calls = self._collect(
            {"ws-b": [page1, page2, page2]}, {"ws-b": _settled("2026-09-05T00:00:00Z")}
        )
        self.assertEqual(len([c for c in calls if c["workspace"] == "ws-b"]), 2)

    def test_sub_second_stamps_are_compared_as_time_not_text(self):
        """★`12:00:00.5Z` 는 `12:00:00Z` 보다 **나중**이다 — 문자열로는 '.'<'Z' 라 거꾸로다."""
        page = {"cursor": None, "items": [_txn("2026-09-10T12:00:00.500000Z")]}
        _collected, state, _calls = self._collect(
            {"ws-b": [page]}, {"ws-b": _settled("2026-09-10T12:00:00Z")}
        )
        self.assertEqual(state["ws-b"]["newest"], "2026-09-10T12:00:00.500000Z")

    def test_the_newest_of_a_page_is_picked_by_time_not_text(self):
        """★한 페이지 안에서 고를 때도 마찬가지다 — 문자열 max 는 `12:00:00Z` 를 고른다.

        실측 거래 시각은 `2026-09-11T10:30:19.805680Z` 처럼 소수 자리가 있는 것과 없는 것이
        섞여 온다. 여기서 지면 기준이 과거로 밀려 이미 본 구간을 매번 다시 읽는다."""
        page = {
            "cursor": None,
            "items": [_txn("2026-09-10T12:00:00Z"), _txn("2026-09-10T12:00:00.500000Z")],
        }
        _collected, state, _calls = self._collect({"ws-b": [page]}, {})
        self.assertEqual(state["ws-b"]["newest"], "2026-09-10T12:00:00.500000Z")

    def test_a_later_page_does_not_overwrite_a_newer_stamp(self):
        """★페이지를 넘어가며 최신을 고를 때가 진짜 함정이다.

        2쪽의 `12:00:00Z` 는 1쪽의 `12:00:00.5Z` 보다 **과거**인데 문자열로는 더 크다.
        문자열로 비교하면 기준이 과거로 밀려 다음 사이클이 이미 본 구간을 다시 읽는다."""
        page1 = {"cursor": "2", "items": [_txn("2026-09-10T12:00:00.500000Z")]}
        page2 = {"cursor": None, "items": [_txn("2026-09-10T12:00:00Z")]}
        _collected, state, _calls = self._collect({"ws-b": [page1, page2]}, {})
        self.assertEqual(state["ws-b"]["newest"], "2026-09-10T12:00:00.500000Z")

    def test_reinspect_ignores_the_mark(self):
        """재점검은 기준을 무시하고 다시 훑는다 — 서버 DB 를 되돌렸을 때의 복구 경로."""
        page = {"cursor": "100", "items": [_txn("2026-09-01T00:00:00Z")] * 100}
        _collected, _state, calls = self._collect(
            {"ws-b": [page] * 5}, {"ws-b": _settled("2026-09-05T00:00:00Z")}, reinspect=True
        )
        self.assertEqual(len([c for c in calls if c["workspace"] == "ws-b"]), 5)

    # ── 상한과 이어읽기 ──────────────────────────────────────────────────────
    def test_hitting_the_page_cap_keeps_the_mark_and_remembers_where_to_resume(self):
        """★P1 — 상한에 걸리면 newest 를 올리지 않고 cursor 를 남긴다.

        올려 버리면 다음 사이클이 같은 앞부분만 되풀이하고 뒤쪽은 영영 안 읽힌다."""
        page = {"cursor": "next-9", "items": [_txn("2026-09-10T12:00:00Z")] * 100}
        _collected, state, calls = self._collect(
            {"ws-b": [page] * 9}, {"ws-b": _settled("2026-08-01T00:00:00Z")}
        )
        self.assertEqual(
            len([c for c in calls if c["workspace"] == "ws-b"]), self.agent._TXN_MAX_PAGES
        )
        self.assertEqual(state["ws-b"]["newest"], "2026-08-01T00:00:00Z")  # 그대로
        self.assertEqual(state["ws-b"]["cursor"], "next-9")  # 이어 볼 위치
        self.assertEqual(state["ws-b"]["pending_newest"], "2026-09-10T12:00:00Z")

    def test_the_next_cycle_resumes_from_the_saved_cursor(self):
        """★저장한 cursor 에서 이어 읽고, 끝까지 가면 그때 newest 를 승격한다."""
        last = {"cursor": None, "items": [_txn("2026-08-20T00:00:00Z")]}
        _collected, state, calls = self._collect(
            {"ws-b": [last]},
            {"ws-b": {"newest": "2026-08-01T00:00:00Z", "cursor": "next-9",
                      "pending_newest": "2026-09-10T12:00:00Z"}},
        )
        ws_b = [c for c in calls if c["workspace"] == "ws-b"]
        self.assertIn("next-9", ws_b[0]["cmd"])  # 앞부분을 다시 읽지 않는다
        # 이어 보던 최신값이 승격된다 — 이번 페이지(08-20)보다 지난 사이클(09-10)이 최신이다.
        self.assertEqual(state["ws-b"]["newest"], "2026-09-10T12:00:00Z")
        self.assertIsNone(state["ws-b"]["cursor"])
        self.assertIsNone(state["ws-b"]["pending_newest"])

    def test_reinspect_still_finishes_an_unfinished_scan(self):
        """★재점검이 무시하는 것은 **기준 시각**이지 '어디까지 읽었나'가 아니다.

        cursor 까지 버리면 재점검을 아무리 반복해도 앞부분만 되풀이하고 끝까지 못 간다."""
        page = {"cursor": None, "items": [_txn("2026-08-20T00:00:00Z")]}
        _collected, _state, calls = self._collect(
            {"ws-b": [page]},
            {"ws-b": {"newest": "2026-09-01T00:00:00Z", "cursor": "next-9",
                      "pending_newest": "2026-09-10T00:00:00Z"}},
            reinspect=True,
        )
        self.assertIn("next-9", [c for c in calls if c["workspace"] == "ws-b"][0]["cmd"])

    # ── 실패 ────────────────────────────────────────────────────────────────
    def test_one_failing_workspace_does_not_block_the_others(self):
        collected, state, calls = self._collect(
            {"ws-c": [{"items": [_txn("2026-09-11T10:30:19Z")]}]}, fail=("ws-b",)
        )
        self.assertEqual([t["workspace_id"] for t in collected], ["ws-c"])
        self.assertIn("ws-c", state)
        self.assertNotIn("ws-b", state)  # 실패한 공간은 상태를 건드리지 않는다
        self.assertEqual(len(calls), 2)

    def test_a_workspace_that_breaks_midway_keeps_its_old_state(self):
        """★첫 페이지는 읽혔는데 다음 페이지에서 끊기면 기준을 **옮기지 않는다**."""
        page1 = {"cursor": "100", "items": [_txn("2026-09-10T12:00:00Z")] * 100}
        collected, state, _calls = self._collect({"ws-b": [page1, None]}, {})
        self.assertEqual(len(collected), 100)  # 읽은 것은 그대로 올린다(멱등이라 안전)
        self.assertNotIn("ws-b", state)

    def test_a_saved_cursor_that_fails_is_thrown_away(self):
        """★만료된 cursor 를 계속 두드리면 그 공간은 영영 막힌다 — 버리고 처음부터 읽는다."""
        _collected, state, _calls = self._collect(
            {"ws-b": [None]},
            {"ws-b": {"newest": "2026-09-01T00:00:00Z", "cursor": "stale-9",
                      "pending_newest": "2026-09-10T00:00:00Z"}},
        )
        self.assertIsNone(state["ws-b"]["cursor"])
        self.assertEqual(state["ws-b"]["newest"], "2026-09-01T00:00:00Z")  # 기준은 그대로

    def test_a_malformed_page_is_not_mistaken_for_the_end(self):
        """★오류 객체를 '정상 빈 페이지'로 읽으면 스캔을 끝난 것으로 치고 기준을 옮긴다."""
        page1 = {"cursor": "100", "items": [_txn("2026-09-10T12:00:00Z")] * 100}
        _collected, state, _calls = self._collect({"ws-b": [page1, {"error": "nope"}]}, {})
        self.assertNotIn("ws-b", state)


class AckPolicyTests(unittest.TestCase):
    """서버가 '장부에 넣었다'고 답할 때만 기준을 옮긴다."""

    def setUp(self):
        self.agent = _load_agent()
        self.states = {
            "ws-done": {"newest": "2026-09-10T00:00:00Z", "cursor": None, "pending_newest": None},
            "ws-mid": {"newest": "2026-09-01T00:00:00Z", "cursor": "next-9",
                       "pending_newest": "2026-09-10T00:00:00Z"},
        }

    def test_a_confirmed_write_persists_everything(self):
        self.assertEqual(self.agent._marks_to_persist(True, self.states), self.states)

    def test_an_old_server_persists_only_finished_scans(self):
        """★옛 서버는 저장 성공을 못 알려 준다 — 미완결 cursor 를 옮기면 저장 안 된 페이지를
        건너뛰고 그 구간을 아무도 다시 읽지 않는다. 완결분은 6시간 겹침이 받쳐 준다."""
        kept = self.agent._marks_to_persist(None, self.states)
        self.assertEqual(list(kept), ["ws-done"])

    def test_a_refused_write_persists_nothing(self):
        self.assertEqual(self.agent._marks_to_persist(False, self.states), {})


class MarkStorageTests(unittest.TestCase):
    """수집 상태는 (서버, 계정, 공간)마다 따로 — 서버를 옮기면 기준도 따로 간다."""

    def setUp(self):
        self.agent = _load_agent()
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.patcher = patch.object(
            self.agent, "_agent_state_path",
            return_value=os.path.join(self.tmp.name, "agent_state.db"),
        )
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_state_round_trips_per_server_account_and_workspace(self):
        self.agent._save_txn_marks("https://a", "me@example.com", {"ws-b": _settled("2026-09-05T00:00:00Z")})
        self.agent._save_txn_marks("https://b", "me@example.com", {"ws-b": _settled("2026-09-09T00:00:00Z")})
        self.assertEqual(
            self.agent._load_txn_marks("https://a", "me@example.com")["ws-b"]["newest"],
            "2026-09-05T00:00:00Z",
        )
        self.assertEqual(
            self.agent._load_txn_marks("https://b", "me@example.com")["ws-b"]["newest"],
            "2026-09-09T00:00:00Z",
        )
        self.assertEqual(self.agent._load_txn_marks("https://a", "other@example.com"), {})

    def test_the_resume_cursor_survives_a_restart(self):
        """이어 볼 위치가 안 남으면 다음 사이클이 앞부분만 되풀이한다."""
        self.agent._save_txn_marks(
            "https://a", "me@example.com",
            {"ws-b": {"newest": "2026-08-01T00:00:00Z", "cursor": "next-9",
                      "pending_newest": "2026-09-10T12:00:00Z"}},
        )
        loaded = self.agent._load_txn_marks("https://a", "me@example.com")["ws-b"]
        self.assertEqual(loaded["cursor"], "next-9")
        self.assertEqual(loaded["pending_newest"], "2026-09-10T12:00:00Z")
        self.assertEqual(loaded["newest"], "2026-08-01T00:00:00Z")

    def test_finishing_a_scan_clears_the_resume_cursor(self):
        self.agent._save_txn_marks(
            "https://a", "me@example.com",
            {"ws-b": {"newest": None, "cursor": "next-9", "pending_newest": "2026-09-10T00:00:00Z"}},
        )
        self.agent._save_txn_marks("https://a", "me@example.com", {"ws-b": _settled("2026-09-10T00:00:00Z")})
        loaded = self.agent._load_txn_marks("https://a", "me@example.com")["ws-b"]
        self.assertIsNone(loaded["cursor"])
        self.assertEqual(loaded["newest"], "2026-09-10T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
