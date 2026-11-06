"""코멘트 그림(획 목록 v1) — 저장·재시도·삭제 기록·구조 검사 계약 고정.

설계: docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C1·C2·C4·C5, §11 계약 dev-comment-drawing-20261105.
"""

import base64
import io
import os
import tempfile
import unittest
import uuid
from unittest import mock

from fastapi import HTTPException

from app import db, repo
from app.repo import comment_drawings
from app.routers import generation
from app.services import comment_strokes as cs


class _State:
    account = {"email": "u1@example.com", "creator_uid": "u1"}


class _Request:
    state = _State()
    headers: dict = {}  # 실제 요청처럼 — 코멘트 목록이 Slack 열기 계정 머리글을 본다


def _uid() -> str:
    return str(uuid.uuid4())


def _jpeg(size=(320, 180)) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _strokes():
    return {"v": 1, "items": [
        {"kind": "shape", "shape": "rect", "color": "#ef4444", "size": 7,
         "from": {"x": 10.04, "y": 20.05}, "to": {"x": 300, "y": 150.25}},
        {"kind": "pen", "erase": False, "color": "#bef264", "size": 8, "points": [{"x": 5, "y": 5}]},
        {"kind": "text", "text": "조개 더미 조금 작게", "color": "#ef4444", "size": 40, "at": {"x": 1, "y": 2}},
    ]}


def _drawing(idx=0, kind="image", **extra):
    base = {"id": _uid(), "idx": idx, "kind": kind, "width": 1920, "height": 1080,
            "time_sec": 1.5 if kind == "video" else None, "strokes": _strokes(),
            "thumb_b64": _jpeg() if kind == "video" else None}
    base.update(extra)
    return base


class StrokeSpecTests(unittest.TestCase):
    def test_rounding_is_half_up_and_integral_values_become_ints(self):
        self.assertEqual(cs.quantize(0.05), 0.1)   # 파이썬 round(0.5)=0 과 다르게 올림 — JS Math.floor(x*10+0.5) 와 같다
        self.assertEqual(cs.quantize(0.25), 0.3)
        self.assertEqual(cs.quantize(2.0), 2)
        self.assertIsInstance(cs.quantize(2.0), int)
        self.assertEqual(cs.canonical({"b": 1.5, "a": [2, "가"]}), '{"a":[2,"가"],"b":1.5}')

    def test_tool_outputs_are_accepted_on_small_sources(self):
        doc = {"v": 1, "items": [
            {"kind": "pen", "erase": False, "color": "#ef4444", "size": 120, "points": [{"x": 3, "y": 4}]},
            {"kind": "text", "text": "A", "color": "#ffffff", "size": 180, "at": {"x": 0, "y": 0}},
        ]}
        out = cs.normalize_strokes(doc, 256, 256)  # 1점 획·굵기 120·글자 180 — max(180, 긴 변/4)
        self.assertEqual(len(out["items"]), 2)

    def test_rejections(self):
        bad = [
            ({"v": 2, "items": []}, "unsupported_version"),
            ({"v": 1, "items": [{"kind": "pen", "erase": False, "color": "#000001", "size": 4, "points": [{"x": 1, "y": 1}]}]}, "bad_color"),
            ({"v": 1, "items": [{"kind": "pen", "erase": False, "color": "#ef4444", "size": 181, "points": [{"x": 1, "y": 1}]}]}, "size_out_of_range"),
            ({"v": 1, "items": [{"kind": "shape", "shape": "rect", "color": "#ef4444", "size": 4, "from": {"x": 0, "y": 0}, "to": {"x": 300, "y": 1}}]}, "point_out_of_range"),
            ({"v": 1, "items": [{"kind": "text", "text": "a\nb", "color": "#ef4444", "size": 4, "at": {"x": 0, "y": 0}}]}, "bad_text"),
            ({"v": 1, "items": [{"kind": "pen", "erase": False, "color": "#ef4444", "size": 4, "points": [{"x": 1, "y": 1}], "extra": 1}]}, "bad_item"),
        ]
        for doc, code in bad:
            with self.subTest(code=code):
                with self.assertRaises(cs.StrokeError) as ctx:
                    cs.normalize_strokes(doc, 256, 256)
                self.assertEqual(str(ctx.exception), code)

    def test_hash_covers_meta_and_thumb_but_not_id(self):
        one = cs.normalize_drawing(_drawing(kind="video"))
        same_other_id = cs.normalize_drawing({**_drawing(kind="video", thumb_b64=None), "thumb_b64": None})
        self.assertNotEqual(one["content_hash"], same_other_id["content_hash"])  # thumb 가 다르면 다르다
        a = cs.normalize_drawing(_drawing(kind="image"))
        b = cs.normalize_drawing(_drawing(kind="image"))
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(a["content_hash"], b["content_hash"])  # id 는 해시 밖
        c = cs.normalize_drawing(_drawing(kind="image", width=1921))
        self.assertNotEqual(a["content_hash"], c["content_hash"])
        with self.assertRaises(cs.StrokeError):
            cs.normalize_drawing(_drawing(kind="image", content_hash="0" * 64))
        with self.assertRaises(cs.StrokeError):
            cs.normalize_drawing(_drawing(kind="image", thumb_b64=_jpeg()))  # 이미지에는 thumb 없음


class _DbCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db = os.environ.get("CONTENT_HUB_DB")
        os.environ["CONTENT_HUB_DB"] = os.path.join(self.tmp.name, "content_hub.db")
        db.flush_pool()
        db.init_db()
        with db.get_connection() as conn:
            conn.execute("INSERT INTO worker(id, name) VALUES('me','me')")
            conn.execute("INSERT INTO generation(id, worker_id, prompt, creator_uid, status) VALUES('g1','me','p','u1','done')")

    def tearDown(self):
        db.flush_pool()
        if self.old_db is None:
            os.environ.pop("CONTENT_HUB_DB", None)
        else:
            os.environ["CONTENT_HUB_DB"] = self.old_db
        db.flush_pool()
        self.tmp.cleanup()

    def post(self, body, gen_id="g1"):
        return generation.add_gen_comment_v2(gen_id, generation.GenCommentV2In(**body), _Request())

    def count(self, table):
        with db.get_connection() as conn:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class LocalCommentV2Tests(_DbCase):
    def test_create_list_fetch_and_replay(self):
        d_img, d_vid = _drawing(0), _drawing(1, "video")
        cid = _uid()
        res = self.post({"id": cid, "text": "  조개 작게  ", "drawings": [d_img, d_vid]})
        self.assertEqual(res["result"], "created")
        self.assertEqual([x["id"] for x in res["drawings"]], [d_img["id"], d_vid["id"]])
        listed = generation.list_gen_comments("g1", _Request())
        self.assertEqual(listed[0]["text"], "조개 작게")
        meta = listed[0]["drawings"]
        self.assertEqual([m["kind"] for m in meta], ["image", "video"])
        self.assertNotIn("strokes", meta[0])  # 목록은 메타만(C5)
        self.assertTrue(meta[1]["has_thumb"])
        got = generation.get_comment_drawing(cid, d_img["id"], _Request())
        self.assertEqual(got.headers["cache-control"], "private, no-store")
        thumb = generation.get_comment_drawing_thumb(cid, d_vid["id"], _Request())
        self.assertEqual(thumb.media_type, "image/jpeg")
        with self.assertRaises(HTTPException) as ctx:
            generation.get_comment_drawing_thumb(cid, d_img["id"], _Request())
        self.assertEqual(ctx.exception.status_code, 404)  # 이미지 그림은 thumb 없음
        # 같은 id·같은 처음 요청 = 같은 결과(그 사이 글을 고쳐도)
        repo.edit_generation_comment(cid, "u1", "고친 글")
        again = self.post({"id": cid, "text": "  조개 작게  ", "drawings": [d_img, d_vid]})
        self.assertEqual(again["result"], "replayed")
        self.assertEqual(self.count("generation_comment"), 1)
        # 같은 id 다른 요청 = 409
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": cid, "text": "다른 글", "drawings": [d_img]})
        self.assertEqual(ctx.exception.status_code, 409)
        # 그림 id 만 바꿔도 다른 요청(지문에 {id, hash})
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": cid, "text": "  조개 작게  ", "drawings": [{**d_img, "id": _uid()}, d_vid]})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_shared_save_wakes_slack_notifier_private_does_not(self):
        from app.services import slack_notify
        with mock.patch.object(slack_notify.notifier, "kick") as kick:
            self.post({"id": _uid(), "text": "알림 깨우기", "drawings": [_drawing(0)]})
            self.assertEqual(kick.call_count, 1)  # 옛 길(POST /comments)과 같이 저장 때 깨운다
            self.post({"id": _uid(), "text": "비공개 메모", "private": True})
            self.assertEqual(kick.call_count, 1)  # 비공개는 알림 대상이 아니다
            with self.assertRaises(HTTPException):
                self.post({"id": _uid(), "text": "   "})
            self.assertEqual(kick.call_count, 1)  # 저장이 안 되면 깨우지 않는다

    def test_delete_records_tombstone_cascades_drawings_and_blocks_retry(self):
        d = _drawing(0)
        cid = _uid()
        self.post({"id": cid, "text": "부모", "drawings": [d]})
        child = _uid()
        self.post({"id": child, "text": "내 답글", "parent_id": cid})
        repo.delete_generation_comment(cid, "u1")
        self.assertEqual(self.count("generation_comment"), 0)
        self.assertEqual(self.count("generation_comment_drawing"), 0)  # 외래키 연쇄
        with db.get_connection() as conn:
            self.assertEqual(comment_drawings.tombstoned(conn, [cid, child]), {cid, child})  # 실제로 지운 id 모두
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": cid, "text": "부모", "drawings": [d]})
        self.assertEqual(ctx.exception.status_code, 410)
        self.assertEqual(self.count("generation_comment"), 0)  # 되살아나지 않는다
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": _uid(), "text": "지운 원글에 답글", "parent_id": cid})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_present_needs_text_match_when_no_ledger(self):
        cid = _uid()
        repo_cid = comment_drawings.create_comment_v2(
            gen_id="g1", gen_key="g1", author="u1", comment_id=cid, text="원본", parent_id=None,
            is_private=False, drawings=[])["id"]
        with db.get_connection() as conn:  # 발행 합치기로 들어온 것처럼 장부만 비운다
            conn.execute("DELETE FROM generation_comment_request WHERE id=?", (repo_cid,))
        self.assertEqual(self.post({"id": cid, "text": "원본"})["result"], "present")
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": cid, "text": "다른 글"})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_private_drawing_stays_local_and_only_author_can_fetch(self):
        d = _drawing(0)
        cid = _uid()
        self.post({"id": cid, "text": "비공개 메모", "private": True, "drawings": [d]})
        repo.publish("g1", "me")
        bundle = repo.export_bundle(gen_ids=["g1"])
        self.assertEqual([c for item in bundle["generations"] for c in item.get("comments", [])], [])

        class _Other:
            state = type("S", (), {"account": {"email": "u2@example.com", "creator_uid": "u2"}})()

        with mock.patch.object(generation, "actor_id", return_value="u2"):
            with self.assertRaises(HTTPException) as ctx:
                generation.get_comment_drawing(cid, d["id"], _Other())
        self.assertEqual(ctx.exception.status_code, 404)

    def test_old_server_route_missing_becomes_409_without_creating(self):
        with mock.patch.object(generation, "_comments_on_server", return_value=True), \
                mock.patch.object(generation.repo, "finalize_id_map", return_value=("g1", "job-1")), \
                mock.patch.object(generation._proxy, "proxy_json",
                                  side_effect=HTTPException(status_code=404, detail="Not Found")):
            with self.assertRaises(HTTPException) as ctx:
                self.post({"id": _uid(), "text": "공유", "drawings": [_drawing(0)]})
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(self.count("generation_comment"), 0)
        with mock.patch.object(generation, "_comments_on_server", return_value=True), \
                mock.patch.object(generation.repo, "finalize_id_map", return_value=("g1", "job-1")), \
                mock.patch.object(generation._proxy, "proxy_json",
                                  side_effect=HTTPException(status_code=404, detail="generation 없음")):
            with self.assertRaises(HTTPException) as ctx:
                self.post({"id": _uid(), "text": "공유", "drawings": [_drawing(0)]})
        self.assertEqual(ctx.exception.status_code, 404)  # 생성물 없음 404 는 그대로


class StructureGuardTests(_DbCase):
    def _break(self, table, columns):
        with db.get_connection() as conn:
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"CREATE TABLE {table}({columns})")

    def test_broken_tombstone_blocks_delete_and_v2_but_not_plain_comments(self):
        cid = repo.add_generation_comment("g1", "u1", "글 전용")
        self._break("generation_comment_tombstone", "id TEXT")
        with self.assertRaises(cs.StructureError):
            repo.delete_generation_comment(cid, "u1")
        self.assertEqual(self.count("generation_comment"), 1)  # 바꾸기 전에 거절
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": _uid(), "text": "v2"})
        self.assertEqual(ctx.exception.status_code, 503)
        repo.add_generation_comment("g1", "u1", "옛 길 글 전용")  # 그대로 된다
        self.assertEqual(self.count("generation_comment"), 2)

    def test_broken_drawing_table_blocks_only_drawings(self):
        self._break("generation_comment_drawing", "id TEXT PRIMARY KEY, comment_id TEXT")
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": _uid(), "text": "그림", "drawings": [_drawing(0)]})
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(self.count("generation_comment"), 0)
        self.assertEqual(self.post({"id": _uid(), "text": "글만"})["result"], "created")

    def test_broken_drawing_table_without_comment_id_still_starts(self):
        # 어긋난 옛 표에 comment_id 가 없어도 schema 적용(시작)이 깨지지 않고, 글 전용은 되고 그림만 막힌다(Codex 독립 리뷰 P1)
        self._break("generation_comment_drawing", "id TEXT PRIMARY KEY")
        db.flush_pool()
        db.init_db()
        self.assertEqual(self.post({"id": _uid(), "text": "글만"})["result"], "created")
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": _uid(), "text": "그림", "drawings": [_drawing(0)]})
        self.assertEqual(ctx.exception.status_code, 503)

    def test_partial_unique_index_is_not_a_unique_constraint(self):
        with db.get_connection() as conn:
            conn.execute("DROP TABLE generation_comment_drawing")
            conn.execute(
                "CREATE TABLE generation_comment_drawing (id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES "
                "generation_comment(id) ON DELETE CASCADE, idx INTEGER NOT NULL, kind TEXT NOT NULL, width INTEGER NOT NULL, "
                "height INTEGER NOT NULL, time_sec REAL, strokes_json TEXT NOT NULL, thumb_jpg BLOB, content_hash TEXT NOT NULL, "
                "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
            conn.execute("CREATE UNIQUE INDEX part_idx ON generation_comment_drawing(comment_id, idx) WHERE idx < 0")
            self.assertFalse(cs.table_ok(conn, cs.DRAWING))  # idx=0 에는 고유성이 없다

    def test_reused_drawing_id_under_new_comment_is_409_without_writes(self):
        d = _drawing(0)
        self.post({"id": _uid(), "text": "먼저 저장된 것", "drawings": [d]})
        with self.assertRaises(HTTPException) as ctx:  # 고친 뒤 새 코멘트 id 로 보냈는데 그림 id 는 그대로
            self.post({"id": _uid(), "text": "고친 것", "drawings": [{**d, "strokes": _strokes()}]})
        self.assertEqual((ctx.exception.status_code, ctx.exception.detail), (409, "drawing_id_conflict"))
        self.assertEqual(self.count("generation_comment"), 1)  # 글까지 통째로 취소

    def test_broken_request_ledger_blocks_v2(self):
        self._break("generation_comment_request", "id TEXT")
        with self.assertRaises(HTTPException) as ctx:
            self.post({"id": _uid(), "text": "글만"})
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(self.count("generation_comment"), 0)


if __name__ == "__main__":
    unittest.main()
