"""캔버스 카드 소속(scene_card_generation) — 더하기 전용 계약 고정.

이 테이블이 필요한 이유: scene_backup 은 씬을 통째로 덮어쓰는 미러라 늦게 저장한 브라우저가
이겨 다른 브라우저에서 쌓은 결과가 사라진다. 여기서 고정하는 건 그 재발을 막는 성질들이다.
  · 멱등(백필을 몇 번 돌려도 한 줄)
  · 제거는 행 삭제가 아니라 표시(안 그러면 모르는 브라우저가 합집합으로 되살린다)
  · 휴지통 생성물은 읽기에서 제외 / 이 DB 에 아직 없는 생성물은 유지
  · owner 스코프 격리
"""

import os
import tempfile
import unittest

from app import db, repo


def _link(scene: str, card: str, gen: str) -> dict:
    return {"scene_id": scene, "card_id": card, "generation_id": gen}


class SceneCardLinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def _keys(self, owner="u1", scene=None):
        return [
            (i["scene_id"], i["card_id"], i["generation_id"])
            for i in repo.list_scene_card_links(owner, scene)
        ]

    def test_add_is_idempotent(self):
        """백필은 여러 번 돌 수 있다(앱을 여러 번 켜거나 재시도). 몇 번을 보내도 한 줄이어야 한다."""
        rows = [_link("s1", "c1", "g1"), _link("s1", "c1", "g2")]
        self.assertEqual(repo.sync_scene_card_links("u1", rows, []), {"added": 2, "removed": 0})
        repo.sync_scene_card_links("u1", rows, [])
        self.assertEqual(self._keys(), [("s1", "c1", "g1"), ("s1", "c1", "g2")])

    def test_duplicate_inside_one_request_collapses(self):
        self.assertEqual(
            repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")] * 3, []),
            {"added": 1, "removed": 0},
        )
        self.assertEqual(len(self._keys()), 1)

    def test_remove_marks_instead_of_deleting(self):
        """행을 지우면 아직 모르는 브라우저가 자기 로컬 목록으로 되살린다 — 흔적이 남아야 한다."""
        repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")], [])
        repo.sync_scene_card_links("u1", [], [_link("s1", "c1", "g1")])
        items = repo.list_scene_card_links("u1")
        self.assertEqual(len(items), 1)
        self.assertIsNotNone(items[0]["removed_at"])

    def test_remove_unknown_link_still_recorded(self):
        """이 브라우저엔 없던 소속을 뺀 경우 — 그래도 '뺐다'가 남아야 다른 브라우저가 안 되살린다."""
        repo.sync_scene_card_links("u1", [], [_link("s1", "c1", "gX")])
        items = repo.list_scene_card_links("u1")
        self.assertEqual(len(items), 1)
        self.assertIsNotNone(items[0]["removed_at"])

    def test_backfill_readd_never_revives_tombstone(self):
        """자동 백필은 제거 표시를 절대 해제 못 한다(합의 B — 적대 리뷰 P2).

        낡은 로컬 목록을 가진 브라우저 A 의 자동 백필이, 브라우저 B 가 그 사이 뺀 것을
        되살리면 안 된다 — 제거 의도가 항상 이긴다."""
        repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")], [])
        repo.sync_scene_card_links("u1", [], [_link("s1", "c1", "g1")])
        repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")], [])  # 자동 백필
        self.assertIsNotNone(repo.list_scene_card_links("u1")[0]["removed_at"])

    def test_explicit_readd_clears_removed_mark(self):
        """뺐다가 도로 넣는 '사용자 의도'(undo 부활 등)만 표시를 푼다."""
        repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")], [])
        repo.sync_scene_card_links("u1", [], [_link("s1", "c1", "g1")])
        repo.sync_scene_card_links("u1", [], [], explicit=[_link("s1", "c1", "g1")])
        self.assertIsNone(repo.list_scene_card_links("u1")[0]["removed_at"])

    def test_identity_remap_preserves_tombstone(self):
        """acct:→user_ 신원 병합에서 '뺐음' 표시가 사라지면 안 된다(적대 리뷰 P1).

        같은 소속이 acct:(제거 표시)와 user_(활성) 양쪽에 있을 때 acct: 행을 그냥 버리면
        제거 의도가 사라져 add-only 병합이 지웠던 생성물을 되살린다 — 제거가 항상 이겨야 한다."""
        from app.repo import identity

        old, new = "acct:a@b.c", "user_new"
        repo.sync_scene_card_links(old, [_link("s1", "c1", "g1")], [])
        repo.sync_scene_card_links(old, [], [_link("s1", "c1", "g1")])  # acct: 쪽 제거 표시
        repo.sync_scene_card_links(new, [_link("s1", "c1", "g1")], [])  # user_ 쪽 활성
        repo.sync_scene_card_links(old, [_link("s2", "c2", "g2")], [])  # 비충돌 — 그대로 이관
        with db.get_connection() as conn:
            identity.remap_creator_uid(conn, old, new)
        self.assertEqual(repo.list_scene_card_links(old), [])  # 옛 신원 행 정리
        items = {
            (i["scene_id"], i["card_id"], i["generation_id"]): i["removed_at"]
            for i in repo.list_scene_card_links(new)
        }
        self.assertIsNotNone(items[("s1", "c1", "g1")])  # ★제거 표시 보존
        self.assertIsNone(items[("s2", "c2", "g2")])  # 비충돌 행은 활성 그대로

    def test_same_link_in_both_lists_rejected(self):
        with self.assertRaises(ValueError):
            repo.sync_scene_card_links(
                "u1", [_link("s1", "c1", "g1")], [_link("s1", "c1", "g1")]
            )

    def test_incomplete_link_ignored(self):
        repo.sync_scene_card_links(
            "u1",
            [{"scene_id": "s1", "card_id": "", "generation_id": "g1"}, _link("s1", "c1", "g1")],
            [],
        )
        self.assertEqual(self._keys(), [("s1", "c1", "g1")])

    def test_scene_filter(self):
        repo.sync_scene_card_links(
            "u1", [_link("s1", "c1", "g1"), _link("s2", "c9", "g9")], []
        )
        self.assertEqual(self._keys(scene="s2"), [("s2", "c9", "g9")])

    def test_owner_isolation(self):
        """개인 편집물 — 남의 소속이 내 씬에 섞이면 안 된다."""
        repo.sync_scene_card_links("u1", [_link("s1", "c1", "g1")], [])
        self.assertEqual(self._keys("u2"), [])

    def test_trashed_generation_excluded_but_unknown_kept(self):
        """휴지통 간 것은 빼고(되살아나면 안 됨), 이 DB 에 아직 없는 것은 남긴다.

        0단계 실측에서 카드가 가리키는 57건 중 54건이 '이 DB 에 없는' 상태였다(다른 설치본).
        없다고 지우면 동기화된 뒤에도 카드로 못 돌아온다.
        """
        with db.get_connection() as conn:
            conn.execute("INSERT INTO worker(id, name) VALUES('me','me')")
            for gid in ("g_live", "g_trash"):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt) VALUES(?,'me','p')", (gid,)
                )
            conn.execute("UPDATE generation SET deleted_at=datetime('now') WHERE id='g_trash'")
        repo.sync_scene_card_links(
            "u1",
            [
                _link("s1", "c1", "g_live"),
                _link("s1", "c1", "g_trash"),
                _link("s1", "c1", "g_elsewhere"),  # 다른 설치본에서 만든 것
            ],
            [],
        )
        got = {k[2] for k in self._keys()}
        self.assertEqual(got, {"g_live", "g_elsewhere"})

    def test_request_limit(self):
        rows = [_link("s1", "c1", f"g{i}") for i in range(repo.MAX_SCENE_CARD_LINKS + 1)]
        with self.assertRaises(ValueError):
            repo.sync_scene_card_links("u1", rows, [])


class SceneCardLinkRouteTests(unittest.TestCase):
    """라우터 왕복 — 프론트가 실제로 부르는 경로가 붙어 있고 검증 오류가 400 이 되는지."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        self.old_np = os.environ.get("CONTENT_HUB_NO_PROXY")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        os.environ["CONTENT_HUB_NO_PROXY"] = "1"
        db.flush_pool()
        db.init_db()
        from fastapi.testclient import TestClient
        from app.main import app

        # AUTH off 모드는 loopback 요청만 허용 → client host 를 127.0.0.1 로.
        self.client = TestClient(app, client=("127.0.0.1", 50000))

    def tearDown(self):
        self.client.close()
        db.flush_pool()
        for k, v in (("CONTENT_HUB_DB", self.old_db), ("CONTENT_HUB_NO_PROXY", self.old_np)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        db.flush_pool()
        self.tmp.cleanup()

    def test_put_then_get_roundtrip(self):
        r = self.client.put(
            "/api/scenes/cards",
            json={"added": [_link("s1", "c1", "g1"), _link("s1", "c1", "g1")], "removed": []},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["added"], 1)  # 같은 요청 안 중복은 접힌다

        items = self.client.get("/api/scenes/cards", params={"scene_id": "s1"}).json()["items"]
        self.assertEqual(len(items), 1)
        self.assertIsNone(items[0]["removed_at"])

        r = self.client.put(
            "/api/scenes/cards", json={"added": [], "removed": [_link("s1", "c1", "g1")]}
        )
        self.assertEqual(r.status_code, 200, r.text)
        items = self.client.get("/api/scenes/cards", params={"scene_id": "s1"}).json()["items"]
        self.assertIsNotNone(items[0]["removed_at"])  # 지우지 않고 표시만

        self.assertEqual(
            self.client.get("/api/scenes/cards", params={"scene_id": "s2"}).json()["items"], []
        )

    def test_conflicting_lists_are_400(self):
        r = self.client.put(
            "/api/scenes/cards",
            json={"added": [_link("s1", "c1", "g1")], "removed": [_link("s1", "c1", "g1")]},
        )
        self.assertEqual(r.status_code, 400, r.text)


if __name__ == "__main__":
    unittest.main()
