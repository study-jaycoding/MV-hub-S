"""팀 탭 색 overlay 2단계(B안) 특성화 — 남의 카드는 로컬 shadow(gen_color_overlay), 내 카드는 g.color.

남의 팀 카드에도 '내 로컬 색'을 달 수 있게 한 뒤(각자 계정DB 전용이라 안 겹침), 팀 목록 overlay 가
① 내 카드는 로컬 generation.color(지운 것 포함 우선) ② 남의 카드는 shadow 색을 덧입히는지 고정한다.
"""

import os
import tempfile
import unittest


class TeamColorOverlayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "ch.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"  # 격리 — 운영 공유서버에 안 닿게(overlay 는 proxying 을 직접 패치)
        from app import db, repo

        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        # 내 카드(로컬 행) — 내 색은 g.color 에 산다.
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, job_id, worker_id, creator_uid, prompt, model, status, "
                "created_at, sort_ts, color) "
                "VALUES('locMine','jobMine','me','me','p','m','done','2026-01-01',2,'#111111')"
            )
        # 남의 카드 색 = 내 로컬 shadow(로컬 generation 행 없음).
        repo.set_color_overlay("jobOther", "#ff0000")

    def tearDown(self):
        from app import db

        db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.flush_pool()
        self.tmp.cleanup()

    def _overlay(self, rows, my="me", proxying=True):
        from app.routers import library

        req = object()
        orig_scope = library.account_scope_uid
        orig_proxying = library._proxy.proxying
        library.account_scope_uid = lambda r: my
        library._proxy.proxying = lambda: proxying
        try:
            return library._overlay_personal_meta(rows, req)
        finally:
            library.account_scope_uid = orig_scope
            library._proxy.proxying = orig_proxying

    def test_shadow_color_on_others_card_and_gcolor_on_mine(self):
        rows = [
            {"id": "srvMine", "job_id": "jobMine", "creator_uid": "me", "color": None},
            {"id": "srvOther", "job_id": "jobOther", "creator_uid": "other", "color": None},
        ]
        by = {r["id"]: r for r in self._overlay(rows)}
        self.assertEqual(by["srvMine"]["color"], "#111111")  # 내 카드: 로컬 g.color
        self.assertEqual(by["srvOther"]["color"], "#ff0000")  # 남의 카드: shadow

    def test_my_cleared_color_not_resurrected_by_stale_shadow(self):
        from app import db, repo

        repo.set_color_overlay("jobMine", "#00ff00")  # 내 카드에 낡은 shadow(있을 리 없지만)
        with db.get_connection() as conn:
            conn.execute("UPDATE generation SET color=NULL WHERE id='locMine'")  # 내 색 지움
        rows = [{"id": "srvMine", "job_id": "jobMine", "creator_uid": "me", "color": "#111111"}]
        out = self._overlay(rows)
        self.assertIsNone(out[0]["color"])  # g.color(None) 우선 → shadow 로 부활 안 함

    def test_shadow_tags_on_others_card(self):
        from app import repo

        repo.set_tags_overlay("jobOther", ["hero", "bg"])
        rows = [{"id": "srvOther", "job_id": "jobOther", "creator_uid": "other", "color": None, "tags": []}]
        out = self._overlay(rows)
        self.assertEqual(sorted(out[0]["tags"]), ["bg", "hero"])  # 남 카드에 내 shadow 태그 표시

    def test_shadow_tags_skip_my_card(self):
        # 내 카드는 로컬 태그가 진실 → shadow 태그로 안 덮음.
        from app import repo

        repo.set_tags_overlay("jobMine", ["ghost"])  # 있을 리 없는 stale shadow
        rows = [{"id": "srvMine", "job_id": "jobMine", "creator_uid": "me", "color": None, "tags": []}]
        out = self._overlay(rows)  # my="me" → 내 카드(로컬 행 locMine 있음)로 처리, shadow skip
        self.assertNotIn("ghost", out[0].get("tags") or [])

    def test_my_server_card_without_local_row_uses_shadow(self):
        # 내 카드지만 이 허브 로컬 DB 에 행이 없는 경우(교차PC·초기화 등) — 로컬 메타를 못 붙이므로
        # step1 에서 handled 안 됨 → step2 shadow 로 표시돼야 한다(코덱스 지적한 buggy skip 방지).
        from app import repo

        repo.set_color_overlay("jobMineNL", "#abcdef")
        rows = [{"id": "srvMineNL", "job_id": "jobMineNL", "creator_uid": "me", "color": None}]
        out = self._overlay(rows)  # my="me" — 내 카드지만 로컬 행 없음
        self.assertEqual(out[0]["color"], "#abcdef")

    def test_no_shadow_when_not_proxying(self):
        rows = [{"id": "srvOther", "job_id": "jobOther", "creator_uid": "other", "color": None}]
        out = self._overlay(rows, proxying=False)
        self.assertIsNone(out[0]["color"])  # 비프록시(로컬)면 남의 카드 개념 없음 → shadow 미적용
