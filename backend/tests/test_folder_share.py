"""폴더 우클릭 '팀에 공유' / '최종 경로로 저장' (2026-09-09) — 후보 판정·분할 발행·프록시 로컬 경로·폴더 필터."""
from __future__ import annotations

import contextlib
import os
import tempfile
import unittest
from unittest import mock

from fastapi import HTTPException, Request

from app import db, repo
from app.routers import _proxy, manage, publish


def _local() -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 40000), "headers": []})


class FolderShareCandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        repo.ensure_default_worker()
        with db.get_connection() as conn:
            conn.execute(
                "INSERT INTO project(id, name, kind, archived, workspace_scope, workspace_id) "
                "VALUES('p1','P1','team',0,'team','ws-1')"
            )
            rows = [
                # id, status, creator_uid, project, folder, deleted_at
                ("g_root", "done", "u_me", "p1", "e020", None),
                ("g_sub", "done", "u_me", "p1", "e020/c0010", None),
                ("g_sub2", "done", "u_me", "p1", "e020/c0020", None),
                ("g_prefix_trap", "done", "u_me", "p1", "e0200/c0010", None),  # 접두 오탐 방지
                ("g_other_owner", "done", "u_other", "p1", "e020/c0010", None),
                ("g_no_owner", "done", None, "p1", "e020/c0010", None),
                ("g_running", "running", "u_me", "p1", "e020/c0010", None),
                ("g_trashed", "done", "u_me", "p1", "e020/c0010", "2026-09-01"),
                ("g_other_project", "done", "u_me", "p2", "e020/c0010", None),
                ("g_shared", "done", "u_me", "p1", "e020/c0030", None),
            ]
            for i, (gid, status, cu, pid, fp, deleted) in enumerate(rows):
                conn.execute(
                    "INSERT INTO generation(id, worker_id, prompt, status, created_at, sort_ts, creator_uid, "
                    "project_id, folder_path, deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (gid, "me", "p", status, "2026-09-01", i, cu, pid, fp, deleted),
                )
        repo.publish("g_shared", "me", "team")  # shared_by 는 worker FK — 기본 워커 me

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def test_candidates_are_mine_done_unshared_within_folder_prefix(self):
        # 상위 폴더 → 자기 + 하위 전부. e0200 은 e020 의 하위가 아니다. 남의 것·주인 없는 것·진행 중·휴지통·다른 프로젝트·이미 공유는 제외.
        self.assertEqual(
            repo.folder_share_candidates("p1", "e020", "u_me"), ["g_root", "g_sub", "g_sub2"]
        )
        self.assertEqual(repo.folder_share_candidates("p1", "e020/c0010", "u_me"), ["g_sub"])
        self.assertEqual(repo.folder_share_candidates("p1", "/e020/", "u_me"), ["g_root", "g_sub", "g_sub2"])
        self.assertEqual(repo.folder_share_candidates("p1", "e020/c0030", "u_me"), [])  # 공유됨

    def test_candidates_without_identity_only_take_ownerless_rows(self):
        # is_mine 과 같은 규칙 — 신원이 없으면 creator_uid 없는 행만 '내 것'(남의 것이 후보가 되지 않는다).
        self.assertEqual(repo.folder_share_candidates("p1", "e020", None), ["g_no_owner"])
        self.assertEqual(repo.folder_share_candidates("p1", "", "u_me"), [])
        self.assertEqual(repo.folder_share_candidates("", "e020", "u_me"), [])


class FolderShareRouteTests(unittest.TestCase):
    def test_folder_route_is_served_locally_not_proxied(self):
        # 후보(내 미공유물)는 로컬 DB 에만 있다 — 서버로 넘기면 0건(코덱스 설계 검토 P1).
        self.assertIn("/api/publish-to-shared/folder", _proxy._LOCAL_EXACT)

    def test_folder_share_publishes_in_chunks_and_aggregates(self):
        ids = [f"g{i}" for i in range(5)]
        calls: list[list[str]] = []

        def fake_publish(body, request):
            calls.append(list(body.gen_ids))
            return {
                "ok": True,
                "published": len(body.gen_ids) - 1,
                "blocked": 1,
                "message": "1건 차단",
                "mirror_pending": True,
                "remote": {"inserted": len(body.gen_ids) - 1, "skipped": 1},
            }

        with mock.patch.object(publish, "_FOLDER_SHARE_CHUNK", 2), mock.patch.object(
            publish.repo, "folder_share_candidates", return_value=ids
        ), mock.patch.object(publish, "current_account", return_value={"creator_uid": "u_me"}), mock.patch.object(
            publish, "publish_to_shared", side_effect=fake_publish
        ):
            out = publish.publish_folder_to_shared(
                publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020"), _local()
            )
        self.assertEqual(calls, [["g0", "g1"], ["g2", "g3"], ["g4"]])
        self.assertEqual(out["total"], 5)
        self.assertEqual(out["attempted"], 5)
        self.assertEqual(out["published"], 2)  # 1+1+0 — 후보 수(total)가 성공 수가 아니다
        self.assertEqual(out["accepted"], 2)  # 비프록시: 로컬 표식 수
        self.assertEqual(out["blocked"], 3)
        self.assertTrue(out["mirror_pending"])
        self.assertEqual(out["message"], "1건 차단")
        self.assertEqual(out["remote"]["inserted"], 2)
        self.assertEqual(out["remote"]["skipped"], 3)
        self.assertIsNone(out["error"])
        self.assertEqual(out["unprocessed"], 0)

    def test_folder_share_keeps_earlier_success_when_a_chunk_fails(self):
        ids = [f"g{i}" for i in range(5)]
        answers = [
            {"ok": True, "published": 2, "remote": {}},
            HTTPException(status_code=502, detail="서버 응답 없음"),
        ]

        def fake_publish(body, request):
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a

        with mock.patch.object(publish, "_FOLDER_SHARE_CHUNK", 2), mock.patch.object(
            publish.repo, "folder_share_candidates", return_value=ids
        ), mock.patch.object(publish, "current_account", return_value=None), mock.patch.object(
            publish.identity, "get_my_uid", return_value="u_me"
        ), mock.patch.object(publish, "publish_to_shared", side_effect=fake_publish):
            out = publish.publish_folder_to_shared(
                publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020"), _local()
            )
        self.assertEqual(out["attempted"], 2)
        self.assertEqual(out["published"], 2)  # 앞선 성공 보존
        self.assertEqual(out["error"], "서버 응답 없음")
        self.assertEqual(out["unprocessed"], 3)  # 실패 배치부터 끝까지 — 자동 재전송 없음
        self.assertNotIn("p1\ne020", publish._FOLDER_SHARE_INFLIGHT)  # 실패해도 진행 표식 해제

    def test_folder_share_rejects_concurrent_same_folder_and_requires_ids(self):
        with mock.patch.object(publish.repo, "folder_share_candidates", return_value=[]), mock.patch.object(
            publish, "current_account", return_value={"creator_uid": "u_me"}
        ):
            publish._FOLDER_SHARE_INFLIGHT.add("p1\ne020")
            try:
                with self.assertRaises(HTTPException) as caught:
                    publish.publish_folder_to_shared(
                        publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020"), _local()
                    )
                self.assertEqual(caught.exception.status_code, 409)
            finally:
                publish._FOLDER_SHARE_INFLIGHT.discard("p1\ne020")
            # 후보 0건은 정상 결과(에러 아님)
            out = publish.publish_folder_to_shared(
                publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020/c0010"), _local()
            )
            self.assertEqual((out["total"], out["attempted"], out["published"]), (0, 0, 0))
            with self.assertRaises(HTTPException) as bad:
                publish.publish_folder_to_shared(
                    publish.PublishFolderToSharedIn(project_id="p1", folder_path="  /  "), _local()
                )
            self.assertEqual(bad.exception.status_code, 400)


class FolderShareProxyAndPinTests(unittest.TestCase):
    def test_proxy_batches_sum_server_accepted_not_attempted(self):
        # 프록시: 배치마다 번들 전송. 성공 수는 서버가 실제 수락한 remote_accepted 합산(중복 anchor·사라진 후보 제외).
        ids = [f"g{i}" for i in range(5)]
        bundles: list[list[str]] = []

        def fake_bundle(gen_ids, **kw):
            bundles.append(list(gen_ids))
            return publish.PublishBundleResult(
                {"published": 0, "mirror_pending": True, "remote": {"inserted": len(gen_ids) - 1}},
                {},
                len(gen_ids) - 1,
            )

        with mock.patch.object(publish, "_FOLDER_SHARE_CHUNK", 2), mock.patch.object(
            publish.repo, "folder_share_candidates", return_value=ids
        ), mock.patch.object(publish, "current_account", return_value={"creator_uid": "u_me"}), mock.patch.object(
            publish._proxy, "proxying", return_value=True
        ), mock.patch.object(publish, "publish_bundle_to_server", side_effect=fake_bundle), mock.patch.object(
            publish, "publish_to_shared"
        ) as local_publish:
            out = publish.publish_folder_to_shared(
                publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020"), _local()
            )
        local_publish.assert_not_called()
        self.assertEqual(bundles, [["g0", "g1"], ["g2", "g3"], ["g4"]])
        self.assertEqual(out["attempted"], 5)
        self.assertEqual(out["accepted"], 2)  # (2-1)+(2-1)+(1-1) — attempted−blocked(5) 가 아니다
        self.assertEqual(out["published"], 0)
        self.assertTrue(out["mirror_pending"])
        self.assertEqual(out["remote"]["inserted"], 2)

    def test_candidates_and_all_batches_run_under_one_pinned_account(self):
        # 배치 사이 계정 전환(A→B) 방지 — 후보 조회와 모든 배치가 같은 계정 고정 블록 안에서 돈다(코덱스 P1).
        state = {"pinned": False, "batches_inside": 0, "candidates_inside": False}

        @contextlib.contextmanager
        def fake_pin():
            state["pinned"] = True
            try:
                yield
            finally:
                state["pinned"] = False

        def candidates(project_id, folder_path, my_uid):
            state["candidates_inside"] = state["pinned"]
            return ["g0", "g1", "g2"]

        def fake_publish(body, request):
            if state["pinned"]:
                state["batches_inside"] += 1
            return {"ok": True, "published": len(body.gen_ids), "remote": {}}

        with mock.patch.object(publish, "_pinned_account_scope", fake_pin), mock.patch.object(
            publish, "_FOLDER_SHARE_CHUNK", 2
        ), mock.patch.object(publish.repo, "folder_share_candidates", side_effect=candidates), mock.patch.object(
            publish, "current_account", return_value={"creator_uid": "u_me"}
        ), mock.patch.object(publish, "publish_to_shared", side_effect=fake_publish):
            out = publish.publish_folder_to_shared(
                publish.PublishFolderToSharedIn(project_id="p1", folder_path="e020"), _local()
            )
        self.assertTrue(state["candidates_inside"])
        self.assertEqual(state["batches_inside"], 2)
        self.assertFalse(state["pinned"])  # 끝나면 고정 해제
        self.assertEqual(out["accepted"], 3)
        self.assertNotIn("p1\ne020", publish._FOLDER_SHARE_INFLIGHT)


class SaveFinalsFolderFilterTests(unittest.TestCase):
    def test_only_in_folder_keeps_self_and_descendants_only(self):
        items = [
            {"gen_id": "a", "folder_path": "e020"},
            {"gen_id": "b", "folder_path": "e020/c0010"},
            {"gen_id": "c", "folder_path": "e0200/c0010"},  # 접두 오탐 아님
            {"gen_id": "d", "folder_path": "e002/c0010"},
            {"gen_id": "e", "folder_path": None},
        ]
        self.assertEqual([i["gen_id"] for i in manage._only_in_folder(items, "e020")], ["a", "b"])
        self.assertEqual([i["gen_id"] for i in manage._only_in_folder(items, "/e020/c0010/")], ["b"])
        self.assertEqual(manage._only_in_folder(items, None), items)  # 폴더 없음 = 종전 프로젝트 전체
        self.assertEqual(manage._only_in_folder(items, "  "), items)


if __name__ == "__main__":
    unittest.main()
