"""옛 반올림 크레딧 보정 도구(`tools/credit_round_repair.py`) — 무엇을 고치고 무엇을 안 건드리나.

실데이터를 고치는 도구라 판정이 한 칸이라도 느슨하면 멀쩡한 장부를 망친다. 판별 도구와 **같은 기준**이어야
하고("판별엔 안 나왔는데 보정이 건드리는" 행이 없게), 애매하거나 거래에서 오지 않은 값은 남겨야 한다.
"""

import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


repair = _load("credit_round_repair")
audit = _load("credit_round_audit")


def _db(path: Path, rows: list[tuple]) -> None:
    """(거래 id, 이메일, 금액, 종류, 생성물, 장부값, 출처, matched) 로 작은 DB 를 만든다."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE credit_txn (id TEXT PRIMARY KEY, account_email TEXT, display_name TEXT, "
        "credits REAL, action TEXT, created_at TEXT, matched_gen_id TEXT)"
    )
    conn.execute(
        "CREATE TABLE generation_metrics (gen_id TEXT PRIMARY KEY, real_credits, credit_source TEXT, matched INTEGER)"
    )
    # ★outbox 는 제품 스키마를 그대로 쓴다(`repo/manage_schema.py`) — 칸을 줄여 흉내 내면
    #  재전송 표시 코드가 시험에서만 깨지고, 진짜 문제는 못 잡는다.
    conn.execute(
        "CREATE TABLE telemetry_outbox ("
        "local_gen_id TEXT PRIMARY KEY, dirty_at TEXT NOT NULL DEFAULT (datetime('now')), "
        "dirty_rev INTEGER NOT NULL DEFAULT 1, pushed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, "
        "last_error TEXT, is_tombstone INTEGER NOT NULL DEFAULT 0, tomb_job_id TEXT, "
        "tomb_creator_uid TEXT, tomb_snapshot TEXT, fail_streak INTEGER NOT NULL DEFAULT 0, "
        "next_retry_at TEXT)"
    )
    for txn_id, email, credits, action, gen_id, stored, source, matched in rows:
        conn.execute(
            "INSERT INTO credit_txn(id, account_email, display_name, credits, action, created_at, matched_gen_id) "
            "VALUES(?,?,?,?,?,?,?)",
            (txn_id, email, "Nano Banana 2", credits, action, f"2026-07-0{txn_id[-1]}T01:00:00Z", gen_id),
        )
        if stored is not None:
            conn.execute(
                "INSERT OR IGNORE INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
                "VALUES(?,?,?,?)",
                (gen_id, stored, source, matched),
            )
    conn.commit()
    conn.close()


class CreditRoundRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db = Path(self.tmp.name) / "content_hub.db"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _candidates(self) -> list[tuple[str, float, float]]:
        conn = sqlite3.connect(self.db)
        try:
            rows, _ = repair.find_candidates(conn)
        finally:
            conn.close()
        return rows

    def test_picks_only_rounded_transaction_rows(self) -> None:
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),   # 되살릴 것
            ("t2", "a@x", -0.12, "spend", "g2", 0.0, "transaction", 1),  # 되살릴 것(전액 소실)
            ("t3", "a@x", -1.5, "spend", "g3", 1.5, "transaction", 1),   # 이미 맞다
            ("t4", "a@x", -32.0, "spend", "g4", 32.0, "transaction", 1), # 원래 정수
            ("t5", "a@x", -1.5, "spend", "g5", 7.0, "transaction", 1),   # 반올림으로 설명 안 됨
            ("t6", "a@x", -1.5, "spend", "g6", 2.0, "estimate", 0),      # 거래에서 온 값이 아님
            ("t7", "a@x", 1.5, "refund", "g7", 2.0, "transaction", 1),   # 환불
        ])
        picked = {gen for gen, _, _ in self._candidates()}
        self.assertEqual(picked, {"g1", "g2"})

    def test_duplicate_links_are_left_alone(self) -> None:
        """같은 생성물에 거래가 둘이면 어느 금액이 맞는지 알 수 없다 — 건드리지 않는다."""
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),
            ("t2", "a@x", -0.5, "spend", "g1", 2.0, "transaction", 1),
        ])
        self.assertEqual(self._candidates(), [])

    def test_apply_fixes_values_and_marks_resend(self) -> None:
        _db(self.db, [("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1)])
        changed = repair.apply_repair(self.db, self._candidates())
        conn = sqlite3.connect(self.db)
        try:
            value = conn.execute("SELECT real_credits FROM generation_metrics WHERE gen_id='g1'").fetchone()[0]
            dirty = conn.execute("SELECT COUNT(*) FROM telemetry_outbox WHERE local_gen_id='g1'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual((changed, value, dirty), (1, 1.5, 1))
        self.assertEqual(self._candidates(), [])  # 두 번 돌려도 더 고칠 것이 없다

    def test_does_not_touch_a_row_that_changed_meanwhile(self) -> None:
        """읽은 그 값일 때만 바꾼다 — 그 사이 누가 고쳤으면 건너뛴다(경합 안전)."""
        _db(self.db, [("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1)])
        stale = self._candidates()
        conn = sqlite3.connect(self.db)
        conn.execute("UPDATE generation_metrics SET real_credits=1.5 WHERE gen_id='g1'")
        conn.commit()
        conn.close()
        self.assertEqual(repair.apply_repair(self.db, stale), 0)

    def test_matches_the_audit_tool(self) -> None:
        """판별과 보정이 같은 행을 고른다 — 어긋나면 '판별엔 없는데 보정이 건드리는' 행이 생긴다."""
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),
            ("t2", "a@x", -0.12, "spend", "g2", 0.0, "transaction", 1),
            ("t3", "a@x", -1.5, "spend", "g3", 2.0, "estimate", 0),
            ("t4", "a@x", -1.5, "spend", "g4", 7.0, "transaction", 1),
        ])
        self.assertEqual(len(self._candidates()), audit.audit(self.db, None, samples=0))


if __name__ == "__main__":
    unittest.main()
