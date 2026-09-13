"""에이전트 상태 DB 연결은 **반드시 닫힌다.**

★왜(2026-09-12): 모든 사용처가 `with _state_connect() as conn:` 이었는데
 `sqlite3.Connection.__exit__` 은 **트랜잭션만 끝내고 연결은 닫지 않는다**(코덱스 지적).
 이 경로는 한 사이클에 여러 번 불린다 — 유휴 2회 이상, 추적 8건이면 10회 이상.
 실측 `_state_connect` 1회 **1.24ms**(순수 connect 0.10 + PRAGMA·DDL 1.13), 사이클당 약 **12ms**.

★이번에 고친 것은 **명시적 종료뿐**이다. 연결 캐시·DDL 최적화는 회의록에서 보류로 판정했다 —
 12ms 는 작고, `synchronous=FULL` 내구성을 유지한 채 다시 재는 것이 먼저다.

★커밋/롤백 계약은 그대로다: 정상이면 커밋, 예외면 롤백, 그리고 **언제나 닫는다.**
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from test_agent_contracts import _load_agent


class StateDbLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.agent = _load_agent()
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.tmp.cleanup)
        self.agent._agent_state_path = lambda: self.tmp.name + "/state.db"
        self.opened: list[sqlite3.Connection] = []
        real = sqlite3.connect

        def tracking_connect(*a, **k):
            conn = real(*a, **k)
            self.opened.append(conn)
            return conn

        self.patcher = patch.object(self.agent.sqlite3, "connect", side_effect=tracking_connect)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    @staticmethod
    def _is_closed(conn: sqlite3.Connection) -> bool:
        try:
            conn.execute("SELECT 1")
        except sqlite3.ProgrammingError:
            return True
        return False

    def _assert_all_closed(self):
        self.assertTrue(self.opened, "연결이 하나도 안 열렸다 — 시험이 경로를 안 지났다")
        still_open = [c for c in self.opened if not self._is_closed(c)]
        self.assertEqual(still_open, [], f"{len(still_open)}개가 열린 채 남았다")

    # ── 정상 경로 ──────────────────────────────────────────────────────
    def test_a_normal_read_closes_its_connection(self):
        """★이 시험이 이 파일의 이유다 — `with conn` 만으론 안 닫힌다."""
        self.agent._load_txn_marks("http://server", "me@example.com")
        self._assert_all_closed()

    def test_a_normal_write_closes_its_connection(self):
        self.agent._save_txn_marks(
            "http://server", "me@example.com", {"ws-a": {"newest": "2026-09-05T00:00:00Z"}}
        )
        self._assert_all_closed()

    def test_repeated_use_does_not_pile_up_handles(self):
        """한 사이클에 여러 번 불린다 — 쌓이면 그대로 누수다."""
        for _ in range(12):
            self.agent._load_txn_marks("http://server", "me@example.com")
        self.assertGreaterEqual(len(self.opened), 12)
        self._assert_all_closed()

    # ── 예외 경로 ──────────────────────────────────────────────────────
    def test_an_exception_still_closes_the_connection(self):
        """★예외 경로에서 안 닫으면 오류가 날수록 핸들이 쌓인다."""
        with self.assertRaises(RuntimeError):
            with self.agent._state_db() as conn:
                conn.execute("SELECT 1")
                raise RuntimeError("일부러")
        self._assert_all_closed()

    def test_an_exception_rolls_back_and_a_success_commits(self):
        """닫기를 더하느라 커밋/롤백 계약이 바뀌면 안 된다."""
        with self.agent._state_db() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS probe(v TEXT)")
            conn.execute("INSERT INTO probe(v) VALUES('kept')")
        with self.assertRaises(RuntimeError):
            with self.agent._state_db() as conn:
                conn.execute("INSERT INTO probe(v) VALUES('rolled back')")
                raise RuntimeError("일부러")
        with self.agent._state_db() as conn:
            rows = [r[0] for r in conn.execute("SELECT v FROM probe")]
        self.assertEqual(rows, ["kept"])
        self._assert_all_closed()

    # ── 준비 단계 실패 ──────────────────────────────────────────────────
    def test_a_failure_while_preparing_closes_the_connection(self):
        """★`connect` 는 됐는데 **PRAGMA·DDL 에서** 터지면 그 연결도 닫아야 한다.

        ★왜(2026-09-13, 코덱스 3회차 재현): `_state_db()` 는 `conn = _state_connect()` 를
         **try 밖**에서 부른다. 그래서 준비 중 예외가 나면 그쪽 `finally` 에 못 들어가
         **연결이 그대로 남는다** — 다른 프로세스가 `BEGIN EXCLUSIVE` 로 잠근 동안 3회
         실패시켰더니 연결 3개가 미종료로 남았다. 연결을 만든 쪽이 치우게 고쳤다.
        """
        with patch.object(self.agent, "_prepare_state_db", side_effect=sqlite3.OperationalError("database is locked")):
            for _ in range(3):
                with self.assertRaises(sqlite3.OperationalError):
                    self.agent._state_connect()
        self.assertEqual(len(self.opened), 3, "3회 모두 connect 까지는 갔어야 한다")
        self._assert_all_closed()

    def test_a_failure_while_preparing_closes_it_through_the_context_manager_too(self):
        """`_state_db()` 로 들어와도 같다 — 호출자가 달라도 핸들이 안 남는다."""
        with patch.object(self.agent, "_prepare_state_db", side_effect=sqlite3.OperationalError("locked")):
            with self.assertRaises(sqlite3.OperationalError):
                with self.agent._state_db():
                    pass  # pragma: no cover — 여기까지 못 온다
        self._assert_all_closed()

    # ── 내구성 계약 보존 ────────────────────────────────────────────────
    def test_the_durability_pragmas_are_still_applied(self):
        """`synchronous=FULL` 을 유지한 채로 고쳤다 — 성능을 위해 내구성을 낮추지 않았다."""
        with self.agent._state_db() as conn:
            sync = conn.execute("PRAGMA synchronous").fetchone()[0]
            journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        self.assertEqual(sync, 2)  # 2 = FULL
        self.assertEqual(str(journal).lower(), "wal")


if __name__ == "__main__":
    unittest.main()
