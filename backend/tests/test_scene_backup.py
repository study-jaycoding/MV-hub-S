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
        self.assertEqual((r["saved"], r["deleted"], r["kept"]), (1, 0, []))
        self.assertEqual(r["results"][0]["status"], "saved")
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

    # ── Jay 결정 1A(10-15): 오래 안 쓴 창이 씬 백업을 옛 내용으로 덮지 않게 — 판(base_hash)·사본·지움 판 ──
    def _hash_of(self, sid="s1"):
        return {m["id"]: m["data_hash"] for m in repo.list_scene_backups("u1")}.get(sid)

    def _data_of(self, sid):
        return {m["id"]: json.loads(m["data"]) for m in repo.list_scene_backups("u1", include_data=True)}.get(sid)

    def test_base_match_overwrites_and_old_app_without_base_overwrites(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        base = self._hash_of()
        r = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "B"), "base_hash": base}], [])
        self.assertEqual(r["results"][0]["status"], "saved")
        self.assertEqual(self._data_of("s1")["name"], "B")
        r = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "C")}], [])  # 칸 없음 = 옛 앱
        self.assertEqual((r["results"][0]["status"], self._data_of("s1")["name"]), ("saved", "C"))

    def test_base_mismatch_keeps_row_and_stores_copy_once(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "새 창 12장")}], [])
        old = json.dumps({"id": "s1", "name": "옛 창", "cards": [{"id": "c1", "genIds": ["g1"], "pendingGenerationAttempts": [{"attemptId": "a"}]}], "edges": [], "created_at": 1})
        r = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": old, "base_hash": "옛 판"}], [])
        res = r["results"][0]
        self.assertEqual(res["status"], "copied")
        self.assertTrue(res["target_id"].startswith("bk_") and len(res["target_id"]) == 27)
        self.assertEqual(self._data_of("s1")["name"], "새 창 12장")  # 원래 행 그대로
        copy = self._data_of(res["target_id"])
        self.assertEqual((copy["id"], copy["name"], copy["backupForkOf"]["id"]), (res["target_id"], "옛 창 (옛 창 사본)", "s1"))
        self.assertEqual(copy["cards"][0], {"id": "c1", "genIds": ["g1"]})  # 진행 중 생성 표식만 뺀다
        self.assertEqual(res["hash"], self._hash_of(res["target_id"]))
        again = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": old, "base_hash": "옛 판"}], [])["results"][0]  # 응답을 잃고 다시
        self.assertEqual(again["target_id"], res["target_id"])
        self.assertEqual(len(repo.list_scene_backups("u1")), 2)

    def test_unknown_base_with_row_goes_to_copy_and_same_content_is_same(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        same = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A"), "base_hash": ""}], [])
        self.assertEqual(same["results"][0]["status"], "same")
        diff = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "X"), "base_hash": ""}], [])
        self.assertEqual(diff["results"][0]["status"], "copied")
        fresh = repo.sync_scene_backups("u1", "", [{"id": "s2", "data": _scene("s2"), "base_hash": ""}], [])  # 행 없음 = 넣는다
        self.assertEqual(fresh["results"][0]["status"], "saved")

    def test_edited_copy_is_not_overwritten_by_resend(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        first = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "옛"), "base_hash": "x"}], [])["results"][0]
        target = first["target_id"]
        edited = json.dumps({**self._data_of(target), "name": "사본을 고침"})
        repo.sync_scene_backups("u1", "", [{"id": target, "data": edited, "base_hash": first["hash"]}], [])
        again = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "옛"), "base_hash": "x"}], [])["results"][0]
        self.assertNotEqual(again["target_id"], target)  # 고쳐진 사본은 덮지 않고 새 사본
        self.assertEqual(self._data_of(target)["name"], "사본을 고침")

    def test_fork_avoid_picks_another_copy_row(self):
        # 사본 행이 그 브라우저의 별도 씬이 됐으면(fork_avoid) 같은 입력이어도 그 자리를 쓰지 않는다 — 두 씬이 한 행을 미러하지 않게(Codex 1A 5차).
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        first = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "옛"), "base_hash": "x"}], [])["results"][0]
        again = repo.sync_scene_backups(
            "u1", "", [{"id": "s1", "data": _scene("s1", "옛"), "base_hash": "x"}], [], None, [first["target_id"]]
        )["results"][0]
        self.assertEqual(again["status"], "copied")
        self.assertNotEqual(again["target_id"], first["target_id"])
        resend = repo.sync_scene_backups(
            "u1", "", [{"id": "s1", "data": _scene("s1", "옛"), "base_hash": "x"}], [], None, [first["target_id"]]
        )["results"][0]
        self.assertEqual(resend["target_id"], again["target_id"])  # 같은 입력·같은 피할 자리면 같은 새 자리(재전송이 사본을 늘리지 않음)
        self.assertEqual(len(repo.list_scene_backups("u1")), 3)

    def test_delete_bases_keep_newer_row(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        old = self._hash_of()
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "B")}], [])  # 다른 창이 고쳤다
        r = repo.sync_scene_backups("u1", "", [], ["s1"], {"s1": old})
        self.assertEqual((r["deleted"], r["kept"]), (0, ["s1"]))
        r = repo.sync_scene_backups("u1", "", [], ["s1"], {"s1": self._hash_of()})
        self.assertEqual((r["deleted"], r["kept"]), (1, []))

    def test_delete_bases_given_but_id_missing_keeps_row(self):
        # 판 칸을 보낸 새 앱이 판을 모르는 행 — 지우지 않는다(Codex 1A 리뷰 #2). 칸이 없는 옛 앱은 지금처럼 지운다.
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1")}], [])
        r = repo.sync_scene_backups("u1", "", [], ["s1"], {})
        self.assertEqual((r["deleted"], r["kept"]), (0, ["s1"]))
        r = repo.sync_scene_backups("u1", "", [], ["s1"], None)
        self.assertEqual((r["deleted"], r["kept"]), (1, []))
        from app.routers.scenes import SceneSyncIn

        self.assertIsNone(SceneSyncIn.model_validate({"deleted_ids": ["s1"]}).delete_bases)  # 옛 앱 — 칸 없음
        self.assertEqual(SceneSyncIn.model_validate({"deleted_ids": ["s1"], "delete_bases": {}}).delete_bases, {})

    def test_too_big_copy_is_reported_not_raised(self):
        repo.sync_scene_backups("u1", "", [{"id": "s1", "data": _scene("s1", "A")}], [])
        from app.repo import scenes_backup as mod

        big_name = "가" * ((mod.MAX_SCENE_BYTES - 70) // 3)  # 원본은 상한 바로 안 — 사본은 이름 뒤 글자·표식으로 넘친다
        old = json.dumps({"id": "s1", "name": big_name, "cards": [], "edges": [], "created_at": 1}, ensure_ascii=False)
        self.assertLessEqual(len(old.encode("utf-8")), mod.MAX_SCENE_BYTES)
        res = repo.sync_scene_backups("u1", "", [{"id": "s1", "data": old, "base_hash": "x"}], [])["results"][0]
        self.assertEqual(res["status"], "too_big")
        self.assertEqual(len(repo.list_scene_backups("u1")), 1)

    def test_remap_plan_covers_owner(self):
        # 계정 신원 전환(acct:→user_) 시 백업이 사라지지 않게 — 리맵 대상 등록을 고정(코덱스 P1).
        from app.repo.identity import _REMAP_PLAN

        self.assertIn(("scene_backup", "owner_uid", "ignore_del"), _REMAP_PLAN)


if __name__ == "__main__":
    unittest.main()
