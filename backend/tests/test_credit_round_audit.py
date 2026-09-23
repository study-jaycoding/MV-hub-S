"""옛 반올림 크레딧 판별 도구(`tools/credit_round_audit.py`)가 무엇을 잡고 무엇을 안 잡는지 고정한다.

배경: 소수 보존을 고치기 전에 매칭된 `real_credits` 는 `round(abs(credits))` 로 적혀 있다.
재매칭은 `real_credits IS NULL` 만 보므로 자동으로 안 고쳐진다 — 되살리려면 먼저 **어느 행인지** 가려야 한다.
오탐이 있으면 멀쩡한 장부를 건드리게 되므로, 아래 여섯 경우의 판정을 시험으로 못 박는다.
"""

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

_TOOL = Path(__file__).resolve().parents[2] / "tools" / "credit_round_audit.py"
_spec = importlib.util.spec_from_file_location("credit_round_audit", _TOOL)
audit_mod = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
sys.modules["credit_round_audit"] = audit_mod  # `@dataclass` 가 실행 중에 찾는다
_spec.loader.exec_module(audit_mod)


def _content_db(path: Path, rows: list[tuple]) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE credit_txn (id TEXT PRIMARY KEY, account_email TEXT, display_name TEXT, "
        "credits REAL, action TEXT, created_at TEXT, matched_gen_id TEXT)"
    )
    conn.execute(
        "CREATE TABLE generation_metrics (gen_id TEXT PRIMARY KEY, real_credits, credit_source TEXT, matched INTEGER)"
    )
    for txn_id, email, credits, action, gen_id, stored in rows:
        conn.execute(
            "INSERT INTO credit_txn(id, account_email, display_name, credits, action, created_at, matched_gen_id) "
            "VALUES(?,?,?,?,?,?,?)",
            (txn_id, email, "Nano Banana 2", credits, action, f"2026-09-1{txn_id[-1]}T01:00:00Z", gen_id),
        )
        if stored is not None and gen_id:
            conn.execute(
                "INSERT OR IGNORE INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
                "VALUES(?,?,'transaction',1)",
                (gen_id, stored),
            )
    conn.commit()
    conn.close()


class CreditRoundAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_classifies_each_case(self) -> None:
        content = self.dir / "content_hub.db"
        _content_db(content, [
            # (거래 id, 이메일, 거래 금액, 종류, 생성물, 장부에 적힌 값)
            ("t1", "a@x", -1.5, "spend", "g1", 2.0),    # 반올림 — 되살릴 수 있다
            ("t2", "a@x", -0.12, "spend", "g2", 0.0),   # 반올림(전액 소실)
            ("t3", "a@x", -1.5, "spend", "g3", 1.5),    # 이미 맞다
            ("t4", "a@x", -32.0, "spend", "g4", 32.0),  # 원래 정수 — 손대면 안 된다
            ("t5", "a@x", -1.5, "spend", "g5", 7.0),    # 반올림으로 설명 안 됨
            ("t6", "a@x", -1.5, "spend", "g6", None),   # 생성물 메트릭 없음(영구 삭제)
        ])
        local, server = audit_mod.audit(content, None, samples=0)
        self.assertEqual(({c.gen_id for c in local}, server), ({"g1", "g2"}, []))

    def test_duplicate_links_are_left_alone(self) -> None:
        """한 생성물에 거래가 둘 붙어 있으면 어느 금액이 맞는지 알 수 없다 — 자동 복구 대상이 아니다."""
        content = self.dir / "content_hub.db"
        _content_db(content, [
            ("t1", "a@x", -1.5, "spend", "g1", 2.0),
            ("t2", "a@x", -0.5, "spend", "g1", 2.0),
        ])
        self.assertEqual(audit_mod.audit(content, None, samples=0), ([], []))

    def test_refund_is_not_a_repair_candidate(self) -> None:
        content = self.dir / "content_hub.db"
        _content_db(content, [("t1", "a@x", 1.5, "refund", "g1", 2.0)])
        self.assertEqual(audit_mod.audit(content, None, samples=0), ([], []))

    def test_local_and_server_are_judged_separately(self) -> None:
        """로컬이 맞아도 서버 팩트가 반올림이면 잡아야 한다 — 화면이 읽는 값은 서버 쪽이다.
        (한쪽만 보면 통째로 ok 로 넘어간다 — Codex 코드 리뷰 2026-09-23)"""
        content = self.dir / "content_hub.db"
        _content_db(content, [("t1", "a@x", -1.5, "spend", "g1", 1.5)])  # 로컬은 정확
        manage = self.dir / "manage_hub.db"
        mconn = sqlite3.connect(manage)
        mconn.execute(
            "CREATE TABLE team_generation_fact (account_email TEXT, local_gen_id TEXT, real_credits REAL)"
        )
        mconn.execute(
            "INSERT INTO team_generation_fact(account_email, local_gen_id, real_credits) VALUES('a@x','g1',2.0)"
        )  # 서버만 반올림
        mconn.commit()
        mconn.close()
        local, server = audit_mod.audit(content, manage, samples=0)
        # 로컬은 손댈 것이 없고 서버 자리만 틀렸다 — 그 PC 가 다시 보고하면 따라온다(has_local).
        self.assertEqual((local, [(c.gen_id, c.has_local) for c in server]), ([], [("g1", True)]))

    def test_server_fact_only_row_is_found(self) -> None:
        """생성물이 지워져 메트릭이 없어도 서버 팩트에 반올림 값이 남아 있으면 잡는다."""
        content = self.dir / "content_hub.db"
        _content_db(content, [("t1", "a@x", -1.5, "spend", "g1", None)])
        manage = self.dir / "manage_hub.db"
        mconn = sqlite3.connect(manage)
        mconn.execute(
            "CREATE TABLE team_generation_fact (account_email TEXT, local_gen_id TEXT, real_credits REAL)"
        )
        mconn.execute(
            "INSERT INTO team_generation_fact(account_email, local_gen_id, real_credits) VALUES('A@x','g1',2.0)"
        )
        mconn.commit()
        mconn.close()
        local, server = audit_mod.audit(content, manage, samples=0)
        # 로컬 값이 아예 없다 — 어느 PC 를 고쳐도 안 따라오니 서버에서 따로 봐야 한다.
        self.assertEqual((local, [(c.gen_id, c.has_local) for c in server]), ([], [("g1", False)]))


if __name__ == "__main__":
    unittest.main()
