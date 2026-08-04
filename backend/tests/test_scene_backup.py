"""캔버스 씬 DB 백업(scene_backup) — 미러 동기화·owner 스코프·검증 규칙 고정.

계약: 로컬(브라우저)이 정답인 단방향 미러. upsert+delete 는 한 트랜잭션, data 는 JSON 원문
보관(파싱·id 일치·5MB 만 검증), data_hash 로 클라가 변경분만 재업로드한다.
"""

import json
import os
import tempfile
import unittest

from app import db, repo


def _scene(sid: str, name: str = "씬") -> str:
    return json.dumps({"id": sid, "name": name, "cards": [], "edges": [], "created_at": 1})


class SceneBackupTests(unittest.TestCase):
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

    def test_sync_upsert_update_delete(self):
        r = repo.sync_scene_backups(
            "u1", "", [{"id": "s1", "name": "A", "data": _scene("s1", "A")}], []
        )
        self.assertEqual(r, {"saved": 1, "deleted": 0})
        metas = repo.list_scene_backups("u1")
        self.assertEqual([m["id"] for m in metas], ["s1"])
        h1 = metas[0]["data_hash"]
        self.assertTrue(h1)
        # 같은 내용 재업서트 → 해시 동일 / 내용 바뀌면 해시 변경
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "B")}], [])
        h2 = repo.list_scene_backups("u1")[0]["data_hash"]
        self.assertNotEqual(h1, h2)
        # include_data 복구 응답 — data 원문 왕복
        full = repo.list_scene_backups("u1", include_data=True)
        self.assertEqual(json.loads(full[0]["data"])["name"], "B")
        # 삭제 미러
        r = repo.sync_scene_backups("u1", "", [], ["s1", "없는것"])
        self.assertEqual(r["deleted"], 1)
        self.assertEqual(repo.list_scene_backups("u1"), [])

    def test_owner_scope(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1")}], [])
        self.assertEqual(repo.list_scene_backups("u2"), [])  # 남의 백업 안 보임
        # 남의 owner 로는 지워지지도 않는다
        r = repo.sync_scene_backups("u2", "", [], ["s1"])
        self.assertEqual(r["deleted"], 0)
        self.assertEqual(len(repo.list_scene_backups("u1")), 1)

    def test_validation_rules(self):
        with self.assertRaises(ValueError):  # data.id ≠ 요청 id (이중 데이터 불일치 방지)
            repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("다른것")}], [])
        with self.assertRaises(ValueError):  # JSON 아님
            repo.sync_scene_backups("u1", "", [{"id": "s1", "data": "not-json"}], [])
        with self.assertRaises(ValueError):  # upsert 와 delete 에 동시에
            repo.sync_scene_backups(
                "u1", "", [{"id": "s1", "data": _scene("s1")}], ["s1"]
            )
        with self.assertRaises(ValueError):  # id 중복
            repo.sync_scene_backups(
                "u1",
                "",
                [
                    {"id": "s1", "data": _scene("s1")},
                    {"id": "s1", "data": _scene("s1")},
                ],
                [],
            )
        # 검증 실패는 트랜잭션 롤백 — 아무것도 안 남는다
        self.assertEqual(repo.list_scene_backups("u1"), [])

    def test_remap_plan_covers_owner(self):
        # 계정 신원 전환(acct:→user_) 시 백업이 사라지지 않게 — 리맵 대상 등록을 고정(코덱스 P1).
        from app.repo.identity import _REMAP_PLAN

        self.assertIn(("scene_backup", "owner_uid", "ignore_del"), _REMAP_PLAN)


if __name__ == "__main__":
    unittest.main()
