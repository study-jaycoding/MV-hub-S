"""편집 공유(서버에 저장 · 다른 편집 보기) — 표·검사·권한·서버 본체 라우터·로컬 허브의 실제 중계(가짜 공유 서버).

설계 = docs/status/편집탭_편집공유_설계_2026-10-23.md · 계약 = docs/status/편집탭_편집공유_구현_2026-10-23.md.
실사용 공유 서버에는 닿지 않는다 — 중계 시험은 127.0.0.1 의 가짜 서버로만 한다.
"""

from __future__ import annotations

import contextvars
import json
import sqlite3
import threading
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import active_account, config, db, db_migrations, deps, mutation_notify, repo
from app.routers import _proxy, edit_shares
from app.services.shared_connection import K_TOKEN
from app.services.upload_limits import UploadBodyLimitMiddleware
from app.shared_server_config import K_URL

HEADER = "X-MVHub-Expect-Account"
OWNER = "a@example.com"


def snapshot(*, pad: str = "", cuts: int = 1) -> str:
    """스냅샷 v1 — 컷마다 영상 조각 하나와 빈 조각 하나(2초 + 3초). pad = 크기 경계용 덧붙임(검사는 모르는 칸을 버리지 않고 둔다)."""
    body = {"v": 1, "total": 5.0 * cuts, "cuts": [
        {"name": f"C{index:04d}", "folder": f"e035/C{index:04d}", "len": 5.0,
         "parts": [{"len": 2.0, "gen": "g1", "kind": "video", "head": 1.0, "speed": 1.5}, {"len": 3.0, "gap": True}]}
        for index in range(cuts)
    ]}
    if pad:
        body["pad"] = pad
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


@pytest.fixture
def server_db(tmp_path, monkeypatch):
    """공유 서버 본체(AUTH on) — 프로젝트 member(멤버 viewer)·other."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content.db"))
    monkeypatch.setattr(db, "_POOL_ENABLED", False)
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    monkeypatch.setattr(deps, "AUTH_ENABLED", True)
    token = active_account.set_override("")
    db.flush_pool()
    db.init_db()
    with db.get_connection() as conn:
        for pid in ("member", "other"):
            conn.execute("INSERT INTO project(id, name) VALUES(?, ?)", (pid, pid))
        conn.execute("INSERT INTO project_member(project_id, creator_uid, project_role) VALUES('member', 'viewer', 'creator')")
    try:
        yield
    finally:
        db.flush_pool()
        active_account.reset_override(token)


def save(owner=OWNER, data=None, *, project="member", seq="e035", viewer="viewer", read_all=False, name="A"):
    return repo.save_edit_share(project, seq, owner, name, data or snapshot(), viewer_uid=viewer, read_all=read_all)


# ── 표 ─────────────────────────────────────────────────────────────────────────────────────────

def test_a_new_database_has_the_table_and_an_existing_one_gets_it_twice_without_touching_other_tables(tmp_path):
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(db.SCHEMA_PATH.read_text(encoding="utf-8"))
        assert [r["name"] for r in conn.execute("PRAGMA table_info(edit_share)")][:4] == ["project_id", "seq", "owner", "owner_key"]
        conn.execute("INSERT INTO edit_doc_head(owner, doc_key, revision, data, data_hash) VALUES('a', 'k', 1, '{}', 'h')")
        conn.execute("INSERT INTO folder_cover(project_id, folder_path, generation_id) VALUES('p', 'f', 'g')")
        conn.execute("DROP TABLE edit_share")
        db_migrations._migrate(conn)
        db_migrations._migrate(conn)
        columns = [r["name"] for r in conn.execute("PRAGMA table_info(edit_share)")]
        kept = (conn.execute("SELECT COUNT(*) FROM edit_doc_head").fetchone()[0], conn.execute("SELECT COUNT(*) FROM folder_cover").fetchone()[0])
        index = conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edit_share_key'").fetchone()
    finally:
        conn.close()
    assert columns == ["project_id", "seq", "owner", "owner_key", "owner_name", "revision", "data", "data_hash", "updated_at"]
    assert kept == (1, 1) and index is not None


def test_one_copy_per_person_and_sequence_same_content_keeps_the_revision_and_the_key_stays(server_db):
    first = save()
    assert first["revision"] == 1
    assert save()["revision"] == 1  # 같은 내용
    second = save(data=snapshot(cuts=2))
    assert second["revision"] == 2 and second["data_hash"] != first["data_hash"]
    listing = repo.list_edit_shares("member", "e035", OWNER, viewer_uid="viewer", read_all=False)
    assert len(listing) == 1 and listing[0]["mine"] is True and listing[0]["name"] == "A"
    assert "owner" not in listing[0] and OWNER not in json.dumps(listing)  # email 은 내보내지 않는다
    key = listing[0]["key"]
    assert len(key) == 32
    save(data=snapshot(cuts=3))
    assert repo.list_edit_shares("member", "e035", "b@example.com", viewer_uid="viewer", read_all=False)[0]["key"] == key
    got = repo.get_edit_share("member", "e035", key, viewer_uid="viewer", read_all=False)
    assert got["data"] == snapshot(cuts=3) and got["revision"] == 3
    assert repo.get_edit_share("member", "e035", "0" * 32, viewer_uid="viewer", read_all=False) == {"data": None}
    save("B@Example.com", name="B")  # 다른 사람 — 한 벌씩
    names = sorted(item["name"] for item in repo.list_edit_shares("member", "e035", OWNER, viewer_uid="viewer", read_all=False))
    assert names == ["A", "B"]


def test_only_members_or_read_all_can_list_read_or_save_and_a_missing_project_is_refused(server_db):
    key = (save(), repo.list_edit_shares("member", "e035", OWNER, viewer_uid="viewer", read_all=False)[0]["key"])[1]
    for call in (
        lambda: save(viewer="stranger"),
        lambda: repo.list_edit_shares("member", "e035", OWNER, viewer_uid="stranger", read_all=False),
        lambda: repo.get_edit_share("member", "e035", key, viewer_uid="stranger", read_all=False),
        lambda: save(project="other"),
        lambda: save(project="ghost", read_all=True),
    ):
        with pytest.raises(LookupError):
            call()
    assert repo.list_edit_shares("member", "e035", None, viewer_uid="boss", read_all=True)[0]["mine"] is False


@pytest.mark.parametrize("mutate", [
    lambda d: d.update(v=2), lambda d: d.update(total=float("inf")), lambda d: d.update(total=0), lambda d: d.update(total=7 * 3600, cuts=[]),
    lambda d: d.update(cuts=[]), lambda d: d["cuts"][0].update(len=4.0), lambda d: d.update(total=6.0),
    lambda d: d.update(v=True), lambda d: d.update(extra=float("nan")),  # true 는 1 이 아니다 · NaN 글자는 화면이 못 읽는다
    lambda d: d["cuts"][0]["parts"][0].update(head=10 ** 400),  # float 로 못 바꾸는 수 — 500 이 아니라 400
    lambda d: d["cuts"][0]["parts"][0].update(speed=5), lambda d: d["cuts"][0]["parts"][0].update(head=-1),
    lambda d: d["cuts"][0]["parts"][0].update(kind="audio"), lambda d: d["cuts"][0]["parts"][0].update(gen=""),
    lambda d: d["cuts"][0].update(name="x" * 201), lambda d: d["cuts"][0]["parts"][0].update(len=True),
    lambda d: d["cuts"][0].update(parts=[{"len": 0.0625, "gap": True}] * 65 + [{"len": 0.9375, "gap": True}]),
])
def test_a_snapshot_that_breaks_a_rule_is_refused(server_db, mutate):
    doc = json.loads(snapshot())
    mutate(doc)
    with pytest.raises(ValueError):
        save(data=json.dumps(doc))
    with pytest.raises(ValueError):
        save(data="not json")


def test_the_size_rule_is_the_ascii_wrapped_length_the_hub_will_forward(server_db):
    base = repo.ascii_json_len(snapshot(pad="x"))
    fits = snapshot(pad="x" * (repo.SHARE_SNAPSHOT_MAX - base + 1))
    assert repo.ascii_json_len(fits) == repo.SHARE_SNAPSHOT_MAX
    assert save(data=fits)["revision"] == 1
    with pytest.raises(ValueError):
        save(data=fits.replace('"pad":"x', '"pad":"xx', 1))
    # 한글 1자는 \uXXXX 6바이트 — 글자 수가 아니라 허브가 넘길 길이로 잰다
    korean = snapshot(pad="가" * ((repo.SHARE_SNAPSHOT_MAX - base) // 6 + 1))
    with pytest.raises(ValueError):
        save(data=korean)
    assert repo.ascii_json_len("\x7f") == 8 and repo.ascii_json_len("😀") == 14  # DEL 은 6 · 보조 평면은 12 (+ 따옴표 2)
    with pytest.raises(ValueError):
        repo.check_share_fields(seq="😀" * 400)


def test_names_are_counted_in_code_points_like_the_screen(server_db):
    doc = json.loads(snapshot())
    doc["cuts"][0]["name"] = "😀" * 200  # 화면도 코드 포인트로 센다(UTF-16 단위면 400)
    assert save(data=json.dumps(doc, ensure_ascii=False))["revision"] == 1
    doc["cuts"][0]["name"] = "😀" * 201
    with pytest.raises(ValueError):
        save(data=json.dumps(doc, ensure_ascii=False))


def test_two_windows_saving_at_once_each_get_their_own_revision_and_the_last_write_stays(server_db):
    results = {}
    barrier = threading.Barrier(2)

    def run(name, data):
        barrier.wait()
        results[name] = save(data=data)

    threads = [
        threading.Thread(target=contextvars.copy_context().run, args=(run, name, data))  # 계정 범위(contextvar)를 스레드에도
        for name, data in (("a", snapshot(cuts=2)), ("b", snapshot(cuts=3)))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(item["revision"] for item in results.values()) == [1, 2]
    last = max(results.values(), key=lambda item: item["revision"])
    listing = repo.list_edit_shares("member", "e035", OWNER, viewer_uid="viewer", read_all=False)
    assert [(item["revision"], item["data_hash"]) for item in listing] == [(2, last["data_hash"])]


# ── 서버 본체 라우터(AUTH on) ───────────────────────────────────────────────────────────────────

def account_request(uid="viewer", email=OWNER, role=""):
    return SimpleNamespace(state=SimpleNamespace(account={"email": email, "creator_uid": uid, "global_role": role, "name": "A"}), headers={})


def test_the_server_saves_for_the_signed_in_account_only_when_the_body_names_the_same_account(server_db):
    body = edit_shares.ShareIn(project_id="member", seq="e035", data=snapshot(), expect_account=OWNER.upper())
    assert edit_shares.save_share(body, account_request())["revision"] == 1
    for expect in ("", "b@example.com"):
        with pytest.raises(HTTPException) as refused:
            edit_shares.save_share(body.model_copy(update={"expect_account": expect}), account_request())
        assert refused.value.status_code == 409
    with pytest.raises(HTTPException) as stranger:
        edit_shares.save_share(body, account_request(uid="stranger"))
    assert stranger.value.status_code == 403
    with pytest.raises(HTTPException) as bad:
        edit_shares.save_share(body.model_copy(update={"data": "{}"}), account_request())
    assert bad.value.status_code == 400
    items = edit_shares.list_shares(account_request(uid="boss", email="boss@example.com", role="admin"), project_id="member", seq="e035")
    assert [item["mine"] for item in items] == [False]
    doc = edit_shares.get_share(account_request(), project_id="member", seq="e035", key=items[0]["key"])
    assert doc["data"] == snapshot()
    with pytest.raises(HTTPException) as unauthenticated:
        edit_shares.list_shares(SimpleNamespace(state=SimpleNamespace(account=None), headers={}), project_id="member", seq="e035")
    assert unauthenticated.value.status_code == 401


def test_a_nameless_account_is_listed_without_its_email_and_the_screen_account_form_is_accepted(server_db):
    nameless = SimpleNamespace(state=SimpleNamespace(account={"email": OWNER, "creator_uid": "viewer", "global_role": "", "name": None}), headers={})
    body = edit_shares.ShareIn(project_id="member", seq="e035", data=snapshot(), expect_account=f"acct:{OWNER}")  # 서버에 바로 붙은 화면의 꼴
    assert edit_shares.save_share(body, nameless)["revision"] == 1
    items = edit_shares.list_shares(account_request(email="b@example.com"), project_id="member", seq="e035")
    assert [item["name"] for item in items] == [""] and OWNER not in json.dumps(items)


# ── 로컬 허브(AUTH off) — 실제 중계 ──────────────────────────────────────────────────────────────

class _FakeShared(BaseHTTPRequestHandler):
    calls: list = []

    def _answer(self, payload, status=200):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        self.calls.append((self.server.name, "GET", self.path, self.headers.get("Authorization"), None))
        self._answer([] if self.path.startswith("/api/edit-shares?") else {"data": None})

    def do_POST(self):  # noqa: N802
        length = int(self.headers["Content-Length"])
        if length > 264 * 1024:  # 공유 서버의 요청 상한(upload_limits)
            return self._answer({"detail": "too large"}, 413)
        body = json.loads(self.rfile.read(length))
        self.calls.append((self.server.name, "POST", self.path, self.headers.get("Authorization"), body))
        try:  # 공유 서버 본체와 같은 검사 — 허브가 넘긴 것을 서버가 받는지
            repo.check_share_fields(project_id=body["project_id"], seq=body["seq"], expect_account=body["expect_account"])
            repo.validate_share_snapshot(body["data"])
        except ValueError:
            return self._answer({"detail": "bad"}, 400)
        self._answer({"revision": 1, "data_hash": "h", "updated_at": "t"})

    def log_message(self, *_args):
        return


@contextmanager
def fake_server(name):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeShared)
    server.name = name
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """로컬 허브 — 계정마다 DB(A·B). 공유 서버 연결은 각 계정 DB 의 설정이다."""
    _FakeShared.calls = []
    monkeypatch.delenv("CONTENT_HUB_DB", raising=False)
    monkeypatch.delenv("CONTENT_HUB_NO_PROXY", raising=False)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(deps, "AUTH_ENABLED", False)
    monkeypatch.setattr(_proxy, "AUTH_ENABLED", False, raising=False)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    token = active_account.set_override(None)
    with fake_server("A") as url_a, fake_server("B") as url_b:
        for owner, url, secret in ((OWNER, url_a, "token-a"), ("b@example.com", url_b, "token-b")):
            active_account.set_active(owner, None)
            db.init_db()
            repo.set_setting(K_URL, url)
            repo.set_setting(K_TOKEN, secret)
        active_account.set_active(OWNER, None)
        app = FastAPI()
        app.add_middleware(UploadBodyLimitMiddleware)
        app.include_router(edit_shares.router)
        with TestClient(app, base_url="http://127.0.0.1:8010") as client:
            yield SimpleNamespace(client=client, url_a=url_a, url_b=url_b)
    db.flush_pool()
    active_account.reset_override(token)


def body(**over):
    return {"project_id": "member", "seq": "e035", "data": snapshot(), **over}


def test_the_hub_forwards_with_the_pinned_account_and_its_own_connection(hub):
    headers = {HEADER: f"acct:{OWNER}"}
    assert hub.client.post("/api/edit-shares/save", json=body(expect_account="someone@else"), headers=headers).json()["revision"] == 1
    assert hub.client.get("/api/edit-shares", params={"project_id": "member", "seq": "e035"}, headers=headers).json() == []
    assert hub.client.get("/api/edit-shares/doc", params={"project_id": "member", "seq": "e035", "key": "a" * 32}, headers=headers).json() == {"data": None}
    posted = [call for call in _FakeShared.calls if call[1] == "POST"]
    assert posted[0][:4] == ("A", "POST", "/api/edit-shares/save", "Bearer token-a")
    assert posted[0][4]["expect_account"] == OWNER  # 허브가 고정한 계정으로 채운다(본문의 값이 아니라)
    assert [call[:3] for call in _FakeShared.calls[1:]] == [
        ("A", "GET", "/api/edit-shares?project_id=member&seq=e035"),
        ("A", "GET", f"/api/edit-shares/doc?project_id=member&seq=e035&key={'a' * 32}"),
    ]
    with active_account.pinned_account_scope((OWNER, None)):
        with db.get_connection() as conn:  # 로컬 DB 에는 쓰지 않는다
            assert conn.execute("SELECT COUNT(*) FROM edit_share").fetchone()[0] == 0


def test_the_hub_refuses_a_missing_or_different_screen_account_a_foreign_origin_and_no_server_login(hub):
    for headers in ({}, {HEADER: "acct:b@example.com"}):
        assert hub.client.post("/api/edit-shares/save", json=body(), headers=headers).status_code == 409
        assert hub.client.get("/api/edit-shares", params={"project_id": "member", "seq": "e035"}, headers=headers).status_code == 409
    foreign = {HEADER: f"acct:{OWNER}", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}
    assert hub.client.post("/api/edit-shares/save", json=body(), headers=foreign).status_code == 403
    with active_account.pinned_account_scope((OWNER, None)):
        repo.set_setting(K_TOKEN, "")
    refused = hub.client.post("/api/edit-shares/save", json=body(), headers={HEADER: f"acct:{OWNER}"})
    assert (refused.status_code, refused.json()["detail"]) == (409, edit_shares.NOT_CONNECTED)
    assert _FakeShared.calls == []


def test_an_account_switch_or_a_server_change_during_the_request_cannot_save_under_someone_else(hub, monkeypatch):
    real_proxying = _proxy.proxying
    real_proxy_json = _proxy.proxy_json

    def switch_then_check():
        active_account.set_active("b@example.com", None)  # 다른 탭이 B 로 로그인했다 — 이 요청은 A 에 고정돼 있다
        return real_proxying()

    def change_server_then_send(*args, **kw):
        with active_account.pinned_account_scope((OWNER, None)):
            repo.set_setting(K_URL, hub.url_b)  # 같은 계정이 서버를 바꿨다 — 이 요청의 연결은 이미 고정됐다
        return real_proxy_json(*args, **kw)

    monkeypatch.setattr(_proxy, "proxying", switch_then_check)
    monkeypatch.setattr(_proxy, "proxy_json", change_server_then_send)
    assert hub.client.post("/api/edit-shares/save", json=body(), headers={HEADER: f"acct:{OWNER}"}).status_code == 200
    assert [call[:4] for call in _FakeShared.calls] == [("A", "POST", "/api/edit-shares/save", "Bearer token-a")]
    assert _FakeShared.calls[0][4]["expect_account"] == OWNER


def test_a_body_over_the_limit_is_refused_before_reading_and_the_largest_valid_request_fits(hub):
    big = "x" * (264 * 1024)
    assert hub.client.post("/api/edit-shares/save", json=body(data=big), headers={HEADER: f"acct:{OWNER}"}).status_code == 413
    assert _FakeShared.calls == []
    base = repo.ascii_json_len(snapshot(pad="가"))
    largest = snapshot(pad="가" * ((repo.SHARE_SNAPSHOT_MAX - base) // 6 + 1))
    while repo.ascii_json_len(largest) > repo.SHARE_SNAPSHOT_MAX:
        largest = largest.replace("가", "", 1)
    fields = {"project_id": "p" * 510, "seq": "s" * 4094, "expect_account": "e" * 1022}
    request_body = {**fields, "data": largest}
    raw = json.dumps(request_body, ensure_ascii=False).encode("utf-8")  # 브라우저(JSON.stringify — 한글은 UTF-8 그대로)
    assert len(raw) <= 264 * 1024
    assert len(json.dumps(request_body).encode()) <= 264 * 1024  # 허브 → 서버의 가장 나쁜 경우(ensure_ascii · 1024 자 계정)
    # 실제 왕복 — 허브가 받아 다시 써서 넘기고, 가짜 서버가 서버와 같은 상한·검사로 받는다
    answer = hub.client.post("/api/edit-shares/save", content=raw, headers={HEADER: f"acct:{OWNER}", "Content-Type": "application/json"})
    assert answer.status_code == 200, answer.text
    forwarded = _FakeShared.calls[-1][4]
    assert (forwarded["data"], forwarded["project_id"], forwarded["seq"]) == (largest, fields["project_id"], fields["seq"])
    assert repo.ascii_json_len(largest) > repo.SHARE_SNAPSHOT_MAX - 6  # 스냅샷은 상한에 붙어 있다(한글 한 자 = 6)
    # 허브는 계정 칸을 고정한 email 로 바꿔 넘긴다 — 세 칸이 모두 최대인 서버 쪽 경우는 허브가 쓰는 꼴(ensure_ascii)로 서버에 직접 보낸다
    worst = json.dumps(request_body).encode()
    sent = urllib.request.Request(f"{hub.url_a}/api/edit-shares/save", data=worst, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(sent, timeout=10) as reply:  # PC 의 프록시 설정을 타지 않게
        assert reply.status == 200
    received = _FakeShared.calls[-1][4]
    assert [len(received[name]) for name in ("project_id", "seq", "expect_account")] == [510, 4094, 1022] and received["data"] == largest


def test_the_paths_stay_on_the_hub_and_saving_does_not_announce_a_library_change():
    assert _proxy.is_local_path("/api/edit-shares") and _proxy.is_local_path("/api/edit-shares/save")
    assert mutation_notify.DOMAIN_LIBRARY not in mutation_notify.notification_domains("POST", "/api/edit-shares/save", 200)
