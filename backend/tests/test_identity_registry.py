"""신원 컬럼 registry 불변식 — acct:<email>→user_ remap 안전망.

스키마(+manage 동적 테이블)의 모든 '신원-의심' 컬럼은 _REMAP_PLAN 에 있거나 _REMAP_EXEMPT(사유)여야 한다.
새 신원 컬럼을 추가하면서 remap 등록을 빠뜨리면 이 테스트가 실패해 강제로 결정하게 한다 — 과거 여러 번
"전 테이블 미정합 → 멤버 중복·가시성 상실·작성자 단절"을 일으킨 remap 누락의 재발을 코드로 차단한다.
"""

import os
import tempfile
import unittest

from app import db, repo
from app.repo import identity, manage

# 신원(uid/actor)을 담는 컬럼으로 볼 이름 규칙: *_uid / *_by 접미사 + 알려진 신원 컬럼명.
#  · *_uid: creator_uid·owner_uid·assignee_uid·tomb_creator_uid …
#  · *_by : shared_by·created_by·final_by·added_by … ('누가 했나' actor — 현재 스키마의 *_by 는 전부 신원)
#  · 접미사에 안 걸리는 알려진 신원 컬럼: author·worker_id.
# (generation_id·project_id·job_id·reference_id 등 '객체 id'는 어디에도 안 걸려 자동 제외.)
_KNOWN_IDENTITY_COLS = {"author", "worker_id"}


def _is_identity_col(col: str) -> bool:
    return col.endswith("_uid") or col.endswith("_by") or col in _KNOWN_IDENTITY_COLS


class IdentityRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_all_identity_columns_registered(self):
        registered = {(t, c) for t, c, _ in identity._REMAP_PLAN} | set(identity._REMAP_EXEMPT)
        unregistered: list[str] = []
        with db.get_connection() as conn:
            manage._ensure_schema(conn)  # credit_txn·project_task·task_*·telemetry_outbox 동적 테이블 포함
            tables = [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            ]
            for t in tables:
                for r in conn.execute(f"PRAGMA table_info({t})").fetchall():
                    col = r[1]
                    if _is_identity_col(col) and (t, col) not in registered:
                        unregistered.append(f"{t}.{col}")
        self.assertEqual(
            sorted(unregistered),
            [],
            "신원 컬럼이 _REMAP_PLAN/_REMAP_EXEMPT 어디에도 없다 → acct:→user_ 전환에서 누락된다. "
            "remap 대상이면 _REMAP_PLAN 에, 아니면 _REMAP_EXEMPT(사유)에 등록하라: " + ", ".join(sorted(unregistered)),
        )

    def test_remap_plan_strategies_valid(self):
        # 전략 문자열 오타(예: "plian")는 registry 엔 등록된 듯 보이지만 remap 분기에 안 걸려 조용히 no-op 된다.
        # 유효 전략 집합으로 고정 — remap_creator_uid 의 분기와 일치해야 한다.
        valid = {"plain", "ignore_del", "member", "autotag", "assetmeta"}
        bad = [(t, c, s) for t, c, s in identity._REMAP_PLAN if s not in valid]
        self.assertEqual(bad, [], f"_REMAP_PLAN 에 알 수 없는 전략(오타 의심): {bad}")

    def test_exempt_entries_have_reasons(self):
        # EXEMPT 는 '왜 remap 안 하는지' 사유가 반드시 있어야 한다(무심코 제외 방지).
        for key, reason in identity._REMAP_EXEMPT.items():
            self.assertTrue(reason and reason.strip(), f"EXEMPT {key} 에 사유가 없다")

    def test_added_by_actually_remapped(self):
        # ★이번에 잡은 누락: task_assignment.added_by 에 acct: 가 저장될 수 있다(add_assignment=actor_id).
        # remap 이 이 audit 컬럼까지 정합하는지 고정.
        with db.get_connection() as conn:
            manage._ensure_schema(conn)
            conn.execute(
                "INSERT INTO task_assignment(task_id, assignee_uid, added_by) VALUES('t1','user_X','acct:a')"
            )
            identity.remap_creator_uid(conn, "acct:a", "user_A")
            row = conn.execute(
                "SELECT added_by FROM task_assignment WHERE task_id='t1'"
            ).fetchone()
        self.assertEqual(row[0], "user_A")


if __name__ == "__main__":
    unittest.main()
