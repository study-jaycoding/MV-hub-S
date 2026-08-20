"""비공개 코멘트(is_private) — 팀 공유 경계 밖으로 나가지 않는 계약 고정.

개인 DB 자체의 복구용 백업에는 포함될 수 있지만, 팀 스레드·발행 번들·통계에는 노출하지 않는다.

여기서 잠그는 유출 경로:
  ① 공유 번들 내보내기(export_bundle) — 발행이 비공개 메모를 팀에 실어 보내면 안 된다.
  ② 스레드 목록 — 남의 비공개(이관 DB 등으로 섞인 행)는 보이면 안 된다.
  ③ 알림(C 뱃지·unread) — 비공개는 남의 알림을 울리면 안 되고, 내 글은 내 알림 대상이 아니다.
"""

import os
import tempfile
import unittest
from unittest import mock

from app import db, repo
from app.routers import generation


class _State:
    account = {"email": "u1@example.com", "creator_uid": "u1"}


class _Request:
    state = _State()


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

    # ── ①-b 공유 팀 서버 본체는 비공개 저장 자체를 거절 ──────────────
    # 브라우저가 팀 서버에 직결된 배포에서 private=true 가 중앙 DB 에 남으면
    # '비공개=내 로컬에만' 불변식이 깨진다 — 서버가 강제 지점이다.
    def test_team_server_rejects_private_generation_comment(self):
        from fastapi import HTTPException

        body = generation.GenCommentAddIn(text="pv", private=True)
        with mock.patch.object(
            generation._proxy, "is_shared_team_server", return_value=True
        ):
            with self.assertRaises(HTTPException) as ctx:
                generation.add_gen_comment("g1", body, _Request())
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(repo.list_private_generation_comments("g1", "u1"), [])

    def test_team_server_rejects_private_asset_comment(self):
        from fastapi import HTTPException

        from app.routers import assets_metadata

        body = assets_metadata.CommentAddIn(
            project="p", path="a.png", text="pv", private=True
        )
        with mock.patch.object(
            assets_metadata._proxy, "is_shared_team_server", return_value=True
        ):
            with self.assertRaises(HTTPException) as ctx:
                assets_metadata.add_comment(body, _Request())
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(repo.list_private_asset_comments("p", "a.png", "u1"), [])

    # ── ①-c 팀 탭(서버 UUID) 앵커 정규화 ─────────────────────────────
    # 같은 생성물이 팀 탭에선 서버 UUID(S), 내 탭에선 로컬 id(L)로 보인다. 비공개를 S 로
    # 저장하면 L 로 열 때 스레드가 갈라진다 — 서버에서 job_id 를 되찾아 L 로 저장해야 한다.
    def test_private_anchor_reclaims_local_row_for_team_card(self):
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO generation(id, worker_id, prompt, creator_uid, job_id) "
                "VALUES('L1','me','p','u1','J1')"
            )
        body = generation.GenCommentAddIn(text="팀탭 비공개", private=True)
        with (
            mock.patch.object(generation._proxy, "proxying", return_value=True),
            mock.patch.object(
                generation._proxy, "proxy_get", return_value={"id": "S1", "job_id": "J1"}
            ),
        ):
            generation.add_gen_comment("S1", body, _Request())
        # 서버 UUID(S1)가 아니라 로컬 행(L1)에 저장 — 내 탭 스레드와 합쳐진다
        self.assertEqual(
            [c["text"] for c in repo.list_private_generation_comments("L1", "u1")],
            ["팀탭 비공개"],
        )
        self.assertEqual(repo.list_private_generation_comments("S1", "u1"), [])

    # ── ①-d 비공개 답글 달린 부모 삭제는 서버 경로에서도 차단 ─────────
    # 프론트 잠금(🔒)은 조언일 뿐 — 다른 탭/직접 API 로 우회되면 부모만 서버에서 지워지고
    # 로컬 비공개 답글이 고아로 남는다. 삭제 라우트가 강제 지점이다(검증 P2).
    def test_delete_parent_with_private_reply_is_blocked(self):
        from fastapi import HTTPException

        from app.routers import assets_metadata

        pid = repo.add_generation_comment("g1", "u1", "부모 공유")
        repo.add_generation_comment("g1", "u1", "비공개 답글", pid, False, True)
        with self.assertRaises(HTTPException) as ctx:
            generation.delete_gen_comment(pid, _Request())
        self.assertEqual(ctx.exception.status_code, 409)
        # 부모가 그대로 남아 있어야 한다
        self.assertIn(
            "부모 공유", [c["text"] for c in repo.list_generation_comments("g1", "u1")]
        )

        apid = repo.add_asset_comment("p", "a.png", "u1", "부모")
        repo.add_asset_comment("p", "a.png", "u1", "비공개 답글", apid, False, True)
        with self.assertRaises(HTTPException) as ctx2:
            assets_metadata.delete_comment(apid, _Request())
        self.assertEqual(ctx2.exception.status_code, 409)

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

    def test_generation_badge_counts_only_shared_and_my_private(self):
        repo.add_generation_comment("g1", "u1", "내 비공개", is_private=True)
        repo.add_generation_comment("g1", "u2", "남의 비공개", is_private=True)
        repo.add_generation_comment("g1", "u2", "남의 공유")

        counts = repo.generation_comment_counts(["g1"], "u1", read_all=True)
        self.assertEqual(counts["g1"]["comment_count"], 2)
        self.assertEqual(repo.private_generation_comment_counts(["g1"], "u1"), {"g1": 1})
        self.assertEqual(repo.private_generation_comment_counts(["g1"], "u2"), {"g1": 1})

    def test_proxy_badge_merges_server_shared_and_local_private_counts(self):
        with (
            mock.patch.object(generation._proxy, "proxying", return_value=True),
            mock.patch.object(
                generation._proxy,
                "proxy_json",
                return_value={"server-g1": {"comment_count": 2, "has_unread": True}},
            ),
            mock.patch.object(generation.repo, "finalize_id_map", return_value=("g1", "server-g1")),
            mock.patch.object(
                generation.repo,
                "private_generation_comment_counts",
                return_value={"g1": 1},
            ) as private_counts,
        ):
            result = generation.gen_comment_counts(
                generation.CommentCountsIn(gen_ids=["g1"]), _Request()  # type: ignore[arg-type]
            )

        self.assertEqual(result["g1"], {"comment_count": 3, "has_unread": True})
        private_counts.assert_called_once_with(["g1"], "u1")

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
