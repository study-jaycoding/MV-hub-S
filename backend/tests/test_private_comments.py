"""비공개 코멘트(is_private) — "내 로컬 DB 밖으로 절대 안 나간다"는 계약 고정.

여기서 잠그는 유출 경로:
  ① 공유 번들 내보내기(export_bundle) — 발행이 비공개 메모를 팀에 실어 보내면 안 된다.
  ② 스레드 목록 — 남의 비공개(이관 DB 등으로 섞인 행)는 보이면 안 된다.
  ③ 알림(C 뱃지·unread) — 비공개는 남의 알림을 울리면 안 되고, 내 글은 내 알림 대상이 아니다.
"""

import os
import tempfile
import unittest

from app import db, repo


class PrivateCommentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO worker(id, name) VALUES('me','me')")
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, creator_uid) "
                "VALUES('g1','me','p','u1')"
            )

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    # ── ① 번들 유출 차단 ──────────────────────────────────────────────
    def test_private_comment_never_exported_in_bundle(self):
        repo.publish("g1", "me")  # shared_by 는 worker FK
        repo.add_generation_comment("g1", "u1", "공유 코멘트")
        repo.add_generation_comment("g1", "u1", "비공개 메모", is_private=True)
        bundle = repo.export_bundle(gen_ids=["g1"])
        comments = [
            c["text"] for item in bundle["generations"] for c in item.get("comments", [])
        ]
        self.assertIn("공유 코멘트", comments)
        self.assertNotIn("비공개 메모", comments)

    # ── ② 목록 가시성 ────────────────────────────────────────────────
    def test_list_hides_others_private(self):
        repo.add_generation_comment("g1", "u1", "내 비공개", is_private=True)
        repo.add_generation_comment("g1", "u2", "남의 비공개", is_private=True)
        repo.add_generation_comment("g1", "u2", "남의 공유")
        texts_u1 = [c["text"] for c in repo.list_generation_comments("g1", "u1")]
        self.assertEqual(sorted(texts_u1), ["남의 공유", "내 비공개"])
        privates = [c for c in repo.list_generation_comments("g1", "u1") if c["private"]]
        self.assertEqual([c["text"] for c in privates], ["내 비공개"])

    def test_private_only_listing_for_merge(self):
        repo.add_generation_comment("g1", "u1", "내 비공개", is_private=True)
        repo.add_generation_comment("g1", "u1", "내 공유")
        mine = repo.list_private_generation_comments("g1", "u1")
        self.assertEqual([c["text"] for c in mine], ["내 비공개"])
        self.assertTrue(all(c["private"] and not c["unread"] for c in mine))

    def test_by_id_private_lookup(self):
        cid = repo.add_generation_comment("g1", "u1", "비공개", is_private=True)
        self.assertTrue(repo.generation_comment_is_private(cid))
        self.assertIsNone(repo.generation_comment_is_private("없는-id"))

    # ── 에셋 쪽 동일 계약 ────────────────────────────────────────────
    def test_asset_private_visibility_and_badges(self):
        repo.add_asset_comment("proj", "a.png", "u1", "내 비공개", is_private=True)
        repo.add_asset_comment("proj", "a.png", "u2", "남의 비공개", is_private=True)
        repo.add_asset_comment("proj", "a.png", "u2", "남의 공유")

        texts = [c["text"] for c in repo.list_asset_comments("proj", "a.png", "u1")]
        self.assertEqual(sorted(texts), ["남의 공유", "내 비공개"])

        meta = repo.get_asset_meta("proj", "u1")["a.png"]
        self.assertEqual(meta["comment_count"], 2)  # 남의 비공개는 안 센다
        self.assertTrue(meta["has_unread"])  # 남의 공유가 미확인

        # u2 시점: 자기 글(공유·비공개)뿐 → 알림 없음(내 글은 내 알림 대상이 아님)
        meta2 = repo.get_asset_meta("proj", "u2")["a.png"]
        self.assertFalse(meta2["has_unread"])

        self.assertEqual(repo.private_asset_comment_counts("proj", "u1"), {"a.png": 1})

    def test_asset_by_id_private_lookup(self):
        cid = repo.add_asset_comment("proj", "a.png", "u1", "비공개", is_private=True)
        self.assertTrue(repo.asset_comment_is_private(cid))
        self.assertFalse(
            repo.asset_comment_is_private(
                repo.add_asset_comment("proj", "a.png", "u1", "공유")
            )
        )
        self.assertIsNone(repo.asset_comment_is_private("없는-id"))


if __name__ == "__main__":
    unittest.main()
