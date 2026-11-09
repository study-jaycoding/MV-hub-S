"""어셋(파일) 코멘트 그림 — 저장·재시도·받는 쪽 모드별 대조·그림 조회 권한·구조 검사 계약 고정.

설계: docs/status/어셋코멘트그림_설계_2026-11-05.md §3, §11 계약 dev-asset-comment-drawing-20261109.
생성물 쪽 같은 계약은 test_comment_drawings.py.
"""

import base64
import io
import os
import tempfile
import unittest
import uuid
from unittest import mock

import pydantic
from fastapi import HTTPException

from app import db, repo
from app.repo import asset_comment_drawings as acd
from app.repo import comment_drawings
from app.routers import _assets_access, _proxy, assets_metadata as am
from app.services import comment_strokes as cs

SERVER = "http://team.example:8010"


class _State:
    def __init__(self, email="u1@example.com", uid="u1"):
        self.account = {"email": email, "creator_uid": uid}


class _Request:
    def __init__(self, expect="local", email="u1@example.com", uid="u1"):
        self.state = _State(email, uid)
        self.headers = {} if expect is None else {"X-MVHub-Expect-Account": expect}


def _uid() -> str:
    return str(uuid.uuid4())


def _jpeg() -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (320, 180), (200, 30, 30)).save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _strokes():
    return {"v": 1, "items": [
        {"kind": "shape", "shape": "rect", "color": "#ef4444", "size": 7,
         "from": {"x": 10, "y": 20}, "to": {"x": 300, "y": 150}},
    ]}


def _drawing(idx=0, kind="image", **extra):
    base = {"id": _uid(), "idx": idx, "kind": kind, "width": 1920, "height": 1080,
            "time_sec": 1.5 if kind == "video" else None, "strokes": _strokes(),
            "thumb_b64": _jpeg() if kind == "video" else None}
    base.update(extra)
    return base


def _body(**over):
    base = {"id": _uid(), "project": "P1", "path": "shots/a.png", "text": "조개 작게", "private": False,
            "drawings": [_drawing()], "expected_target": "local"}
    base.update(over)
    return base


class _DbCase(unittest.TestCase):
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

    def post(self, body, request=None):
        return am.add_comment_v2(am.AssetCommentV2In(**body), request or _Request())

    def count(self, table):
        with db.get_connection() as conn:
            return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def counts(self):
        return (self.count("asset_comment"), self.count(cs.ASSET_DRAWING), self.count(cs.ASSET_REQUEST))

    def assert_code(self, ctx, status, code):
        self.assertEqual(ctx.exception.status_code, status)
        self.assertEqual((ctx.exception.detail or {}).get("code"), code)


class LocalStoreTests(_DbCase):
    """로그인 끔·중계 안 함 허브 — 비공개·공유 모두 이 DB."""

    def test_create_list_fetch_replay_delete(self):
        d_img = _drawing(0)
        body = _body(drawings=[d_img], text="  조개 작게  ")
        res = self.post(body)
        self.assertEqual(res["result"], "created")
        self.assertEqual([d["id"] for d in res["drawings"]], [d_img["id"]])
        listed = am.list_comments(_Request(), project="P1", path="shots/a.png")
        self.assertEqual(len(listed), 1)
        meta = listed[0]["drawings"][0]
        self.assertEqual(meta["id"], d_img["id"])
        self.assertNotIn("strokes", meta)  # 목록에는 메타만
        self.assertEqual(listed[0]["text"], "조개 작게")
        got = am.get_asset_comment_drawing(body["id"], d_img["id"], _Request())
        self.assertEqual(got.headers["cache-control"], "private, no-store")
        # 같은 요청 재시도 = 처음 결과(그 뒤 글을 고쳤어도)
        repo.edit_asset_comment(body["id"], "u1", "고친 글")
        again = self.post(body)
        self.assertEqual(again["result"], "replayed")
        self.assertEqual(self.counts(), (1, 1, 1))
        # 같은 id 다른 내용 = 409 conflict, 아무것도 안 바뀜
        with self.assertRaises(HTTPException) as ctx:
            self.post({**body, "text": "다른 글"})
        self.assert_code(ctx, 409, "conflict")
        # 지우면 그림이 같이 지워지고 장부는 남는다 → 재시도 410
        am.delete_comment(body["id"], _Request())
        self.assertEqual(self.counts(), (0, 0, 1))
        with self.assertRaises(HTTPException) as ctx:
            self.post(body)
        self.assert_code(ctx, 410, "deleted")
        self.assertEqual(self.counts(), (0, 0, 1))

    def test_text_only_and_private_and_video(self):
        self.post(_body(drawings=None))
        vid = _drawing(0, "video")
        self.post(_body(path="cuts/b.mp4", drawings=[vid], private=True))
        listed = am.list_comments(_Request(), project="P1", path="cuts/b.mp4")
        self.assertTrue(listed[0]["private"])
        self.assertTrue(listed[0]["drawings"][0]["has_thumb"])
        thumb = am.get_asset_comment_drawing_thumb(listed[0]["id"], vid["id"], _Request())
        self.assertEqual(thumb.media_type, "image/jpeg")
        self.assertEqual(self.count("asset_comment"), 2)

    def test_validation_rejects_without_writing_anything(self):
        cases = [
            (_body(drawings=[_drawing(0, "video")]), "kind_mismatch"),  # png 에 영상 그림
            (_body(path="music/a.mp3"), "unsupported_file_type"),       # 오디오 파일
            (_body(path="docs/a.txt"), "unsupported_file_type"),
            (_body(drawings=[{**_drawing(), "content_hash": "0" * 64}]), "content_hash_mismatch"),
            (_body(text="   "), "빈 코멘트"),
            (_body(parent_id=_uid()), None),
            (_body(id="not-a-uuid"), "bad_comment_id"),
        ]
        for body, detail in cases:
            with self.subTest(detail=detail):
                with self.assertRaises(HTTPException) as ctx:
                    self.post(body)
                self.assertEqual(ctx.exception.status_code, 400)
                if detail:
                    self.assertEqual(ctx.exception.detail, detail)
        big = _strokes()
        big["items"] = [{"kind": "pen", "erase": False, "color": "#ef4444", "size": 4,
                         "points": [{"x": i % 1900 + 0.1, "y": i % 1000 + 0.1} for i in range(5000)]}] * 4
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body(drawings=[_drawing(strokes=big)]))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(pydantic.ValidationError):  # 13장 이상 — 파싱 단계에서 거절
            am.AssetCommentV2In(**_body(drawings=[_drawing(i % 12) for i in range(13)]))
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_drawing_id_conflict_rolls_back_everything(self):
        shared = _drawing()
        self.post(_body(drawings=[shared]))
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body(drawings=[shared]))  # 다른 코멘트가 이미 가진 그림 id
        self.assert_code(ctx, 409, "conflict")
        self.assertEqual(self.counts(), (1, 1, 1))

    def test_author_is_authenticated_identity_and_private_is_author_only(self):
        body = _body(private=True)
        self.post(body, _Request(uid="u1"))
        with db.get_connection() as conn:
            self.assertEqual(conn.execute("SELECT author FROM asset_comment").fetchone()[0], "u1")
        drawing_id = body["drawings"][0]["id"]
        with self.assertRaises(HTTPException) as ctx:
            am.get_asset_comment_drawing(body["id"], drawing_id, _Request(uid="u2"))
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.headers["Cache-Control"], "private, no-store")

    def test_expected_values_are_checked_before_the_ledger(self):
        body = _body()
        with self.assertRaises(HTTPException) as ctx:
            self.post(body, _Request(expect=None))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            self.post(body, _Request(expect="acct:other@example.com"))
        self.assert_code(ctx, 409, "context_changed")
        with self.assertRaises(HTTPException) as ctx:
            self.post({**body, "expected_target": None})
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            self.post({**body, "expected_target": "server"})  # 중계가 꺼진 허브인데 화면은 서버로 뜻함
        self.assert_code(ctx, 409, "context_changed")
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_account_policy_is_kept(self):
        from app.repo import account_cleanup, identity

        # 계정 정리: 그림·장부 표는 지우는 칸이 아니고, 어셋 댓글은 계정 삭제를 막는 이력 그대로
        removed_tables = {table for table, _ in account_cleanup.REMOVED_WITH_ACCOUNT}
        self.assertFalse(removed_tables & {cs.ASSET_DRAWING, cs.ASSET_REQUEST})
        self.assertEqual(account_cleanup._KIND_OF["asset_comment"], "댓글")
        # 작성자 이관: 그림은 comment_id 로 따라가고, 같은 id 재시도는 지문(작성자)이 달라 409
        body = _body()
        self.post(body, _Request(uid="acct:u1@example.com"))
        with db.get_connection() as conn:
            identity.remap_creator_uid(conn, "acct:u1@example.com", "user_1")
        listed = am.list_comments(_Request(uid="user_1"), project="P1", path="shots/a.png")
        self.assertEqual(listed[0]["author"], "user_1")
        self.assertEqual(len(listed[0]["drawings"]), 1)
        with self.assertRaises(HTTPException) as ctx:
            self.post(body, _Request(uid="user_1"))
        self.assert_code(ctx, 409, "conflict")

    def test_generation_fingerprint_bytes_are_unchanged(self):
        # 생성물 지문 직렬화(gen_key)는 이미 저장된 장부와 같아야 한다 — 어셋 키가 섞이지 않는다
        fp = comment_drawings.fingerprint(author="u1", gen_key="g1", is_private=False, parent_id=None,
                                          text="t", drawings=[])
        self.assertEqual(fp, __import__("hashlib").sha256(cs.canonical(
            {"author": "u1", "gen_key": "g1", "private": False, "parent_id": None, "text": "t", "drawings": []}
        ).encode("utf-8")).hexdigest())


class RelayHubTests(_DbCase):
    """로그인 끔 + 중계 중 허브 — 비공개 = 로컬, 공유 = 고정한 서버로."""

    def setUp(self):
        super().setUp()
        self.patches = [
            mock.patch.object(_proxy, "proxying", return_value=True),
            mock.patch.object(_proxy, "base_url", return_value=SERVER),
            mock.patch.object(_proxy, "token", return_value="tok"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        super().tearDown()

    def shared(self, **over):
        return _body(expected_target="server", expected_server_url=SERVER + "/",
                     expected_server_account="u1@example.com", **over)

    def test_shared_goes_to_server_with_normalized_key(self):
        sent = {}

        def fake(method, path, body=None, **kw):
            sent.update(method=method, path=path, body=body, base=_proxy.base_url())
            return {"id": body["id"], "result": "created", "drawings": []}

        with mock.patch.object(_proxy, "proxy_json", side_effect=fake):
            res = self.post(self.shared())
        self.assertEqual(res["result"], "created")
        self.assertEqual(sent["path"], "/api/assets/comments-v2")
        self.assertEqual(sent["body"]["expected_target"], "server")
        self.assertEqual(self.counts(), (0, 0, 0))  # 로컬 사본 없음

    def test_route_missing_becomes_update_needed_and_business_404_passes(self):
        with mock.patch.object(_proxy, "proxy_json", side_effect=HTTPException(404, "Not Found")):
            with self.assertRaises(HTTPException) as ctx:
                self.post(self.shared())
        self.assert_code(ctx, 409, "server_update_needed")
        with mock.patch.object(_proxy, "proxy_json", side_effect=HTTPException(404, "코멘트 없음")):
            with self.assertRaises(HTTPException) as ctx:
                self.post(self.shared())
        self.assertEqual((ctx.exception.status_code, ctx.exception.detail), (404, "코멘트 없음"))
        self.assertEqual(self.counts(), (0, 0, 0))

    def test_server_url_change_is_context_changed(self):
        with mock.patch.object(_proxy, "proxy_json") as relay:
            with self.assertRaises(HTTPException) as ctx:
                self.post({**self.shared(), "expected_server_url": "http://other:8010"})
            self.assert_code(ctx, 409, "context_changed")
            with self.assertRaises(HTTPException) as ctx:
                self.post({**self.shared(), "expected_server_url": None})
            self.assertEqual(ctx.exception.status_code, 400)
            with self.assertRaises(HTTPException) as ctx:
                self.post({**self.shared(), "expected_target": "local"})  # 화면은 로컬로 뜻했는데 지금은 서버
            self.assert_code(ctx, 409, "context_changed")
            relay.assert_not_called()

    def test_private_stays_local(self):
        with mock.patch.object(_proxy, "proxy_json") as relay:
            res = self.post(_body(private=True))
            relay.assert_not_called()
        self.assertEqual(res["result"], "created")
        self.assertEqual(self.counts(), (1, 1, 1))
        listed_server = [{"id": "s1", "created_at": "2000-01-01", "text": "서버"}]
        with mock.patch.object(_proxy, "proxy_json", return_value=listed_server):
            listed = am.list_comments(_Request(), project="P1", path="shots/a.png")
        self.assertEqual([c["id"] for c in listed][0], "s1")
        self.assertIn("drawings", listed[1])  # 로컬 비공개분에 로컬 메타

    def test_locally_stored_shared_comment_is_stored_local_when_relaying(self):
        body = _body()  # 서버 없을 때 공유로 로컬에 저장
        with mock.patch.object(_proxy, "proxying", return_value=False):
            self.post(body)
        with mock.patch.object(_proxy, "proxy_json") as relay:
            for _ in range(2):  # 같은 id 로 다시 눌러도 같은 409
                with self.assertRaises(HTTPException) as ctx:
                    self.post({**body, "expected_target": "server", "expected_server_url": SERVER})
                self.assert_code(ctx, 409, "stored_local")
            relay.assert_not_called()

    def test_drawing_fetch_is_server_authority_with_limits(self):
        calls = []

        def fake_bytes(path, max_bytes, timeout=30):
            calls.append((path, max_bytes))
            return b'{"id":"d"}', "application/json"

        with mock.patch.object(_proxy, "proxy_bytes", side_effect=fake_bytes):
            res = am.get_asset_comment_drawing("c1", "d1", _Request())  # 로컬에 행이 없어도 서버로
            am.get_asset_comment_drawing_thumb("c1", "d1", _Request())
        self.assertEqual(res.headers["cache-control"], "private, no-store")
        self.assertEqual(calls, [("/api/assets/comments/c1/drawings/d1", 320 * 1024),
                                 ("/api/assets/comments/c1/drawings/d1/thumb", cs.MAX_THUMB_BYTES)])
        with mock.patch.object(_proxy, "proxy_bytes", side_effect=HTTPException(403, "권한 없음")):
            with self.assertRaises(HTTPException) as ctx:
                am.get_asset_comment_drawing("c1", "d1", _Request())
        self.assertEqual(ctx.exception.status_code, 403)  # 로컬 사본으로 대신하지 않는다
        self.assertEqual(ctx.exception.headers["Cache-Control"], "private, no-store")


class TeamServerTests(_DbCase):
    """공유 서버 본체(로그인 켬·중계 안 함) — 본문 기대값을 인증 계정과 대조, 비공개 거절."""

    def setUp(self):
        super().setUp()
        self.patches = [
            mock.patch.object(_proxy, "is_shared_team_server", return_value=True),
            mock.patch.object(_assets_access, "AUTH_ENABLED", True),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        super().tearDown()

    def body(self, **over):
        return _body(**{"expected_target": "server", "expected_server_account": "u1@example.com", **over})

    def test_checks_and_permission(self):
        with self.assertRaises(HTTPException) as ctx:
            self.post(self.body(private=True), _Request(expect=None))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            self.post({**self.body(), "expected_server_account": None}, _Request(expect=None))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            self.post(self.body(expected_server_account="other@example.com"), _Request(expect=None))
        self.assert_code(ctx, 409, "context_changed")
        with mock.patch.object(_assets_access, "require_asset_comment_access",
                               side_effect=HTTPException(403, "권한 없음")):
            with self.assertRaises(HTTPException) as ctx:
                self.post(self.body(), _Request(expect=None))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.counts(), (0, 0, 0))
        with mock.patch.object(_assets_access, "require_asset_comment_access") as access:
            res = self.post(self.body(), _Request(expect=None))
        access.assert_called_once()
        self.assertTrue(access.call_args.kwargs["write"])
        self.assertEqual(res["result"], "created")


class IsolatedLocalTests(_DbCase):
    """로그인 켬 + 중계 끔(dev test_dev.bat) — 고정 DB 키가 없어 인증 계정과 대조, 비공개 허용."""

    def setUp(self):
        super().setUp()
        self.patches = [
            mock.patch.object(_assets_access, "AUTH_ENABLED", True),
            mock.patch.object(_assets_access, "require_asset_comment_access"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        super().tearDown()

    def test_authenticated_account_is_the_expectation(self):
        self.post(_body(), _Request(expect="acct:u1@example.com"))
        self.post(_body(private=True), _Request(expect="acct:u1@example.com"))
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body(), _Request(expect="acct:other@example.com"))
        self.assert_code(ctx, 409, "context_changed")
        self.assertEqual(self.count("asset_comment"), 2)

    def test_relayed_request_to_isolated_test_server_uses_body_expectation(self):
        # 격리 허브 → 격리 시험 서버 실측: 허브 중계는 머리글을 옮기지 않는다 — 본문 server 기대값을 인증 계정과 대조
        relayed = _body(expected_target="server", expected_server_account="u1@example.com")
        self.assertEqual(self.post(relayed, _Request(expect=None))["result"], "created")
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body(expected_target="server", expected_server_account="x@example.com"), _Request(expect=None))
        self.assert_code(ctx, 409, "context_changed")


class FlagTests(_DbCase):
    def test_hub_server_and_status_flags(self):
        from app.routers import auth, publish, share

        config = auth.auth_config()
        self.assertIn("asset_comment_drawings_v1", config["features"])
        self.assertIn("shared_team_server", config)
        with mock.patch.object(share._proxy, "proxying", return_value=False):
            self.assertEqual(share.share_capabilities()["asset_comment_drawings"], 1)
        # 토큰이 있어도 NO_PROXY 면 중계가 아니다 — has_token 이 아니라 실제 판정값을 싣는다
        repo.set_setting(publish._K_TOKEN, "tok")
        with mock.patch.object(publish, "_require_local_shared_connection"), \
                mock.patch.dict(os.environ, {"CONTENT_HUB_NO_PROXY": "1"}):
            status = publish.shared_server_status(_Request())
        self.assertTrue(status["has_token"])
        self.assertFalse(status["proxying"])


class StructureTests(_DbCase):
    def test_broken_drawing_table_rejects_drawings_but_keeps_text_comments(self):
        with db.get_connection() as conn:
            conn.execute(f"DROP TABLE {cs.ASSET_DRAWING}")
            conn.execute(f"CREATE TABLE {cs.ASSET_DRAWING}(id TEXT, comment_id TEXT)")
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body())
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(self.count("asset_comment"), 0)
        self.post(_body(drawings=None))  # 장부는 멀쩡 — 글만 v2 는 된다
        am.add_comment(am.CommentAddIn(project="P1", path="shots/a.png", text="옛 길"), _Request())
        self.assertEqual(self.count("asset_comment"), 2)

    def test_broken_ledger_rejects_v2_without_writing(self):
        with db.get_connection() as conn:
            conn.execute(f"DROP TABLE {cs.ASSET_REQUEST}")
            conn.execute(f"CREATE TABLE {cs.ASSET_REQUEST}(id TEXT)")
        with self.assertRaises(HTTPException) as ctx:
            self.post(_body())
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(self.count("asset_comment"), 0)
        self.assertEqual(self.count(cs.ASSET_DRAWING), 0)

    def test_fresh_db_has_valid_tables(self):
        with db.get_connection() as conn:
            self.assertTrue(cs.table_ok(conn, cs.ASSET_DRAWING))
            self.assertTrue(cs.table_ok(conn, cs.ASSET_REQUEST))
        self.assertEqual(acd.asset_key("P1", "a.png"), "P1\0a.png")


if __name__ == "__main__":
    unittest.main()
