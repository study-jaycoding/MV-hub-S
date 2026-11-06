"""코멘트 그림 — 휴지통 왕복·발행 보내기(그림 유무로 나눔)·받기(v2·합치기 검사·삭제 기록 우선)·재전송 경로.

설계: docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C2·C3, §11 계약 dev-comment-drawing-20261105.
임시 DB 만 쓰고, 공유 서버는 가짜 전송(_http_json 바꿔치기)으로 흉내 낸다.
"""

import base64
import io
import json
import os
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.repo import comment_drawings, trash
from app.routers import generation, publish
from app.routers.publish import PublishBundleIn
from app.services import comment_strokes as cs
from app.services import share_commands


def _uid() -> str:
    return str(uuid.uuid4())


def _jpeg() -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (320, 180), (30, 30, 200)).save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _drawing(idx=0, kind="image", **extra):
    base = {"id": _uid(), "idx": idx, "kind": kind, "width": 1920, "height": 1080,
            "time_sec": 2.25 if kind == "video" else None,
            "strokes": {"v": 1, "items": [{"kind": "pen", "erase": False, "color": "#ef4444", "size": 6,
                                           "points": [{"x": 10, "y": 10}, {"x": 40.26, "y": 30}]}]},
            "thumb_b64": _jpeg() if kind == "video" else None}
    base.update(extra)
    return base


class _Request:
    state = SimpleNamespace(account={"email": "u1@example.com", "creator_uid": "u1"})
    headers: dict = {}  # 실제 요청처럼 — 코멘트 목록이 Slack 열기 계정 머리글을 본다


_SERVER_REQUEST = SimpleNamespace(state=SimpleNamespace(account=None))  # 인증 없는 받기 입구(단독·시험)


class _DbCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        with db.get_connection() as conn:
            conn.execute("INSERT OR IGNORE INTO worker(id, name) VALUES('me','me')")
            for gid in ("g1", "g2"):
                conn.execute("INSERT INTO generation(id, job_id, worker_id, prompt, creator_uid, status, project_id) "
                             "VALUES(?,?,'me','p','u1','done','proj')", (gid, "job-" + gid))
                conn.execute("INSERT INTO asset(id, generation_id, type, file_path) VALUES(?,?,'image',?)",
                             (gid + "-a", gid, f"https://cdn.example/{gid}.png"))

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def post(self, gen_id, text, drawings=None, **extra):
        body = {"id": _uid(), "text": text, "drawings": drawings or [], **extra}
        generation.add_gen_comment_v2(gen_id, generation.GenCommentV2In(**body), _Request())
        return body["id"]

    def rows(self, sql, *args):
        with db.get_connection() as conn:
            return [tuple(r) for r in conn.execute(sql, args)]

    def break_table(self, table, columns):
        with db.get_connection() as conn:
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"CREATE TABLE {table}({columns})")


class TrashRoundTripTests(_DbCase):
    def test_drawings_come_back_and_tombstoned_comments_do_not(self):
        keep = self.post("g1", "남길 것", [_drawing(0), _drawing(1, "video")])
        gone = self.post("g1", "따로 지워질 것", [_drawing(0)])
        reply = self.post("g1", "지워질 것의 답글", parent_id=gone)
        before = self.rows("SELECT id, comment_id, idx, kind, time_sec, strokes_json, thumb_jpg, content_hash "
                           "FROM generation_comment_drawing WHERE comment_id=? ORDER BY idx", keep)
        self.assertTrue(trash.move_to_trash("g1"))
        self.assertEqual(self.rows("SELECT id FROM generation_comment_drawing"), [])  # 외래키 연쇄로 메인에선 빠졌다
        with db.get_connection() as conn:  # 휴지통에 있는 동안 다른 곳에서 지운 코멘트(삭제 기록)
            comment_drawings.record_tombstones(conn, [gone, reply], "job-g1")
        self.assertTrue(trash.restore_from_trash("g1"))
        self.assertEqual([r[0] for r in self.rows("SELECT id FROM generation_comment")], [keep])
        after = self.rows("SELECT id, comment_id, idx, kind, time_sec, strokes_json, thumb_jpg, content_hash "
                          "FROM generation_comment_drawing ORDER BY idx")
        self.assertEqual(after, before)  # 획·영상 thumb·해시가 그대로
        listed = generation.list_gen_comments("g1", _Request())
        self.assertEqual([d["kind"] for d in listed[0]["drawings"]], ["image", "video"])

    def test_old_trash_record_without_drawings_still_restores(self):
        cid = repo.add_generation_comment("g1", "u1", "그림 기능 전 코멘트")
        self.assertTrue(trash.move_to_trash("g1"))
        with trash._with_trash() as conn:  # 그림 기능 전의 휴지통 기록 모양
            payload = json.loads(conn.execute("SELECT payload FROM trash.trashed WHERE id='g1'").fetchone()[0])
            payload.pop("comment_drawings")
            conn.execute("UPDATE trash.trashed SET payload=? WHERE id='g1'", (json.dumps(payload),))
        self.assertTrue(trash.restore_from_trash("g1"))
        self.assertEqual(self.rows("SELECT id FROM generation_comment"), [(cid,)])

    def test_broken_drawing_table_keeps_drawn_item_in_trash(self):
        self.post("g1", "그림", [_drawing(0)])
        self.assertTrue(trash.move_to_trash("g1"))
        self.break_table("generation_comment_drawing", "id TEXT PRIMARY KEY, comment_id TEXT")
        with self.assertRaises(cs.StructureError):
            trash.restore_from_trash("g1")
        self.assertEqual(self.rows("SELECT id FROM generation WHERE id='g1'"), [])  # 통째로 거절
        with trash._with_trash() as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM trash.trashed WHERE id='g1'").fetchone())

    def test_broken_tombstone_blocks_restore_of_commented_item(self):
        repo.add_generation_comment("g1", "u1", "글")
        self.assertTrue(trash.move_to_trash("g1"))
        self.break_table("generation_comment_tombstone", "id TEXT")
        with self.assertRaises(cs.StructureError):
            trash.restore_from_trash("g1")
        self.assertEqual(self.rows("SELECT id FROM generation WHERE id='g1'"), [])


class ReceiveTests(_DbCase):
    def item(self, anchor, comments):
        return {"generation": {"id": anchor, "prompt": "p", "model": "m", "status": "done", "creator_uid": "u9",
                               "project_id": "proj"},
                "asset": {"type": "image", "file_path": f"https://cdn.example/{anchor}.png"},
                "tags": [], "auto_tags": [], "comments": comments}

    def receive(self, items, *, v2):
        route = publish.receive_published_bundle_v2 if v2 else publish.receive_published_bundle
        return route(PublishBundleIn(bundle={"generations": items}), _SERVER_REQUEST)

    def comment(self, drawings=None, **extra):
        return {"id": _uid(), "author": "u9", "text": "받은 코멘트", **({"drawings": drawings} if drawings else {}), **extra}

    def test_v1_refuses_drawings_and_v2_merges_them(self):
        c = self.comment([_drawing(0)])
        with self.assertRaises(HTTPException) as ctx:
            self.receive([self.item("job-r1", [c])], v2=False)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(self.rows("SELECT id FROM generation_comment WHERE id=?", c["id"]), [])  # 바꾸기 전에 거절
        out = self.receive([self.item("job-r1", [c])], v2=True)
        self.assertEqual(out["inserted"], 1)
        self.assertEqual(len(self.rows("SELECT id FROM generation_comment_drawing WHERE comment_id=?", c["id"])), 1)
        again = self.receive([self.item("job-r1", [c])], v2=True)  # 같은 묶음 다시 = 그대로
        self.assertEqual(again["blocked"], 0)
        self.assertEqual(len(self.rows("SELECT id FROM generation_comment_drawing")), 1)

    def test_old_receipt_is_completed_and_mismatches_block_only_that_item(self):
        d = _drawing(0)
        c = self.comment()
        self.receive([self.item("job-r2", [c])], v2=False)  # 그림 기능 전 발행(글만)
        out = self.receive([self.item("job-r2", [{**c, "drawings": [d]}])], v2=True)  # 보완
        self.assertEqual(out["blocked"], 0)
        self.assertEqual(len(self.rows("SELECT id FROM generation_comment_drawing WHERE comment_id=?", c["id"])), 1)
        other = cs.normalize_drawing(_drawing(0, strokes={"v": 1, "items": [
            {"kind": "pen", "erase": False, "color": "#ffffff", "size": 6, "points": [{"x": 1, "y": 1}]}]}))
        bad = {**d, "strokes": other["strokes"]}  # 같은 그림 id 에 다른 내용
        out = self.receive([self.item("job-r2", [{**c, "drawings": [bad]}]),
                            self.item("job-r3", [self.comment()])], v2=True)
        self.assertEqual(out["blocked_ids"], ["job-r2"])  # 그 항목만 막힘
        self.assertEqual(out["inserted"], 1)
        stranger = {**c, "author": "u-other", "drawings": [_drawing(1)]}  # 남의 코멘트에 그림 붙이기
        out = self.receive([self.item("job-r2", [stranger])], v2=True)
        self.assertEqual(out["blocked_ids"], ["job-r2"])
        self.assertEqual(len(self.rows("SELECT id FROM generation_comment_drawing WHERE comment_id=?", c["id"])), 1)

    def test_deleted_comment_is_not_resurrected_by_old_path_replay(self):
        c = self.comment()
        reply = self.comment(parent_id=c["id"])
        self.receive([self.item("job-r4", [c, reply])], v2=False)
        repo.delete_generation_comment(c["id"], "u9")  # 기존 삭제 API(글 전용)
        out = self.receive([self.item("job-r4", [c, reply])], v2=False)  # 기존 경로 재전송
        self.assertEqual(sorted(out["skipped_deleted"]), sorted([c["id"], reply["id"]]))
        self.assertEqual(self.rows("SELECT id FROM generation_comment WHERE gen_id IN "
                                   "(SELECT id FROM generation WHERE job_id='job-r4' OR id='job-r4')"), [])
        late_reply = self.comment(parent_id=c["id"])  # 지운 원글에 늦게 온 답글도 건너뛴다
        out = self.receive([self.item("job-r4", [late_reply])], v2=False)
        self.assertEqual(out["skipped_deleted"], [late_reply["id"]])

    def test_broken_tables_refuse_before_changes(self):
        self.break_table("generation_comment_tombstone", "id TEXT")
        with self.assertRaises(HTTPException) as ctx:
            self.receive([self.item("job-r5", [self.comment()])], v2=False)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(self.rows("SELECT id FROM generation WHERE job_id='job-r5' OR id='job-r5'"), [])
        out = self.receive([self.item("job-r6", [])], v2=False)  # 코멘트 없는 발행은 그대로
        self.assertEqual(out["inserted"], 1)


class SendTests(_DbCase):
    def setUp(self):
        super().setUp()
        repo.set_setting("shared_server_url", "http://drawings.fixture")
        repo.set_setting("shared_server_token", "synthetic-test-token")
        self.posts: list[tuple[str, list[str]]] = []
        self.capability = {"share_command": 0, "comment_drawings": 1}
        patches = [
            mock.patch.object(publish, "_http_json", self.remote),
            mock.patch.object(publish, "_touch_telemetry", lambda *a: None),
            mock.patch.object(publish, "kick_share_state_reconciler", lambda: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def remote(self, method, url, **kwargs):
        path = url.removeprefix("http://drawings.fixture")
        if path == "/api/share/capabilities":
            return (200, self.capability) if isinstance(self.capability, dict) else (self.capability, {"detail": "x"})
        assert method == "POST", path
        bundle = kwargs["body"]["bundle"]
        self.posts.append((path, [item["generation"]["id"] for item in bundle["generations"]]))
        return 200, {"ok": True, "inserted": len(bundle["generations"]), "updated": 0, "unchanged": 0,
                     "skipped": 0, "blocked": 0, "blocked_ids": []}

    def test_mixed_publish_is_split_by_drawings(self):
        self.post("g1", "그림 있음", [_drawing(0)])
        self.post("g2", "글만")
        out = publish.publish_bundle_to_server(["g1", "g2"])
        self.assertEqual(out["published"], 2)
        self.assertEqual(sorted(self.posts), [("/api/share/publish-bundle", ["job-g2"]),
                                              ("/api/share/publish-bundle-v2", ["job-g1"])])
        self.assertEqual(out["remote"]["inserted"], 2)

    def test_server_without_drawings_blocks_only_drawn_items(self):
        self.post("g1", "그림 있음", [_drawing(0)])
        self.post("g2", "글만")
        for capability in ({"share_command": 0}, 404):
            with self.subTest(capability=capability):
                self.posts.clear()
                with db.get_connection() as conn:
                    conn.execute("DELETE FROM share")
                self.capability = capability
                out = publish.publish_bundle_to_server(["g1", "g2"])
                self.assertEqual(self.posts, [("/api/share/publish-bundle", ["job-g2"])])  # 그림 쪽은 서버에 안 감
                self.assertEqual((out["published"], out["blocked"]), (1, 1))
                self.assertIn("팀 서버 업데이트", out["message"])
        self.capability = {"share_command": 0}
        with self.assertRaises(HTTPException) as ctx:  # 그림 달린 항목만 고르면 그 발행이 막힌다
            publish.publish_bundle_to_server(["g1"])
        self.assertEqual(ctx.exception.status_code, 409)

    def test_frozen_replay_uses_the_same_route_as_first_send(self):
        drawn = {"generation": {"id": "job-g1"}, "comments": [{"id": "c", "text": "t", "drawings": [{"id": "d"}]}]}
        plain = {"generation": {"id": "job-g2"}, "comments": [{"id": "c2", "text": "t"}]}
        self.assertEqual(share_commands.bundle_path([drawn]), "/api/share/publish-bundle-v2")
        self.assertEqual(share_commands.bundle_path([plain]), "/api/share/publish-bundle")
        sent = []

        def raw(method, url, **kwargs):
            sent.append(url)
            return 503, {}

        for item in (drawn, plain):
            command = {"command_kind": "publish_bundle", "target_id": item["generation"]["id"],
                       "parameters": {"item": item, "provider": {}}}
            intent = {"remote_command_json": json.dumps(command)}
            with self.assertRaises(HTTPException):
                share_commands.replay(SimpleNamespace(raw_request=raw), intent, "http://drawings.fixture", "t")
        self.assertEqual(sent, ["http://drawings.fixture/api/share/publish-bundle-v2",
                                "http://drawings.fixture/api/share/publish-bundle"])


if __name__ == "__main__":
    unittest.main()
