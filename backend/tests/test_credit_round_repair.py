"""옛 반올림 크레딧 보정 도구(`tools/credit_round_repair.py`) — 무엇을 고치고 무엇을 안 건드리나.

실데이터를 고치는 도구라 판정이 한 칸이라도 느슨하면 멀쩡한 장부를 망친다. 판별 도구와 **같은 기준**이어야
하고("판별엔 안 나왔는데 보정이 건드리는" 행이 없게), 애매하거나 거래에서 오지 않은 값은 남겨야 한다.
지운 생성물의 삭제 통보(tombstone)를 일반 재전송 표시로 덮지 않는 것도 여기서 지킨다.
"""

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    # `@dataclass` 는 실행 중에 `sys.modules[모듈명]` 을 찾는다 — 먼저 꽂지 않으면 AttributeError 로 죽는다.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rules = _load("credit_round_rules")
repair = _load("credit_round_repair")
audit = _load("credit_round_audit")


def _db(path: Path, rows: list[tuple], dead: set[str] = frozenset()) -> None:
    """(거래 id, 이메일, 금액, 종류, 생성물, 장부값, 출처, matched) 로 작은 DB 를 만든다.

    `dead` 에 든 생성물은 지워진 것으로 둔다(`deleted_at` 있음)."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE credit_txn (id TEXT PRIMARY KEY, account_email TEXT, display_name TEXT, "
        "credits REAL, action TEXT, created_at TEXT, matched_gen_id TEXT)"
    )
    conn.execute(
        "CREATE TABLE generation_metrics (gen_id TEXT PRIMARY KEY, real_credits, credit_source TEXT, matched INTEGER)"
    )
    conn.execute("CREATE TABLE generation (id TEXT PRIMARY KEY, deleted_at TEXT)")
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
        conn.execute(
            "INSERT OR IGNORE INTO generation(id, deleted_at) VALUES(?,?)",
            (gen_id, "2026-08-01T00:00:00Z" if gen_id in dead else None),
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

    def _candidates(self) -> set[str]:
        conn = rules.connect_ro(self.db)
        try:
            local, _, _ = rules.scan(conn)
        finally:
            conn.close()
        return {item.gen_id for item in local}

    def test_picks_only_rounded_transaction_rows(self) -> None:
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),   # 되살릴 것
            ("t2", "a@x", -0.12, "spend", "g2", 0.0, "transaction", 1),  # 되살릴 것(전액 소실)
            ("t3", "a@x", -1.5, "spend", "g3", 1.5, "transaction", 1),   # 이미 맞다
            ("t4", "a@x", -32.0, "spend", "g4", 32.0, "transaction", 1),  # 원래 정수
            ("t5", "a@x", -1.5, "spend", "g5", 7.0, "transaction", 1),   # 반올림으로 설명 안 됨
            ("t6", "a@x", -1.5, "spend", "g6", 2.0, "estimate", 0),      # 거래에서 온 값이 아님
            ("t7", "a@x", 1.5, "refund", "g7", 2.0, "transaction", 1),   # 환불
        ])
        self.assertEqual(self._candidates(), {"g1", "g2"})

    def test_duplicate_links_are_left_alone(self) -> None:
        """같은 생성물에 거래가 둘이면 어느 금액이 맞는지 알 수 없다 — 건드리지 않는다."""
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),
            ("t2", "a@x", -0.5, "spend", "g1", 2.0, "transaction", 1),
        ])
        self.assertEqual(self._candidates(), set())

    def test_apply_fixes_values_and_marks_resend(self) -> None:
        _db(self.db, [("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1)])
        changed, resend, _ = repair.apply_repair(self.db)
        conn = sqlite3.connect(self.db)
        try:
            value = conn.execute("SELECT real_credits FROM generation_metrics WHERE gen_id='g1'").fetchone()[0]
            dirty = conn.execute("SELECT COUNT(*) FROM telemetry_outbox WHERE local_gen_id='g1'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual((changed, resend, value, dirty), (1, 1, 1.5, 1))
        self.assertEqual(self._candidates(), set())  # 두 번 돌려도 더 고칠 것이 없다
        self.assertEqual(repair.apply_repair(self.db)[0], 0)

    def test_deleted_generation_keeps_its_tombstone(self) -> None:
        """지운 생성물은 값만 고치고 **삭제 통보를 덮지 않는다** — 일반 dirty 는 `is_tombstone=0` 으로 만든다."""
        _db(self.db, [("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1)], dead={"g1"})
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO telemetry_outbox(local_gen_id, is_tombstone, tomb_job_id) VALUES('g1', 1, 'job-1')"
        )
        conn.commit()
        conn.close()
        changed, resend, _ = repair.apply_repair(self.db)
        conn = sqlite3.connect(self.db)
        try:
            row = conn.execute(
                "SELECT is_tombstone, tomb_job_id FROM telemetry_outbox WHERE local_gen_id='g1'"
            ).fetchone()
            value = conn.execute("SELECT real_credits FROM generation_metrics WHERE gen_id='g1'").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual((changed, resend), (1, 0))       # 값은 고치고 재전송 표시는 안 한다
        self.assertEqual((row[0], row[1], value), (1, "job-1", 1.5))

    def test_matches_the_audit_tool(self) -> None:
        """판별과 보정이 **같은 id 집합**을 고른다 — 어긋나면 '판별엔 없는데 보정이 건드리는' 행이 생긴다."""
        _db(self.db, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0, "transaction", 1),
            ("t2", "a@x", -0.12, "spend", "g2", 0.0, "transaction", 1),
            ("t3", "a@x", -1.5, "spend", "g3", 2.0, "estimate", 0),
            ("t4", "a@x", -1.5, "spend", "g4", 7.0, "transaction", 1),
        ])
        seen = {item.gen_id for item in audit.audit(self.db, None, samples=0)[0]}
        self.assertEqual(seen, self._candidates())


if __name__ == "__main__":
    unittest.main()
