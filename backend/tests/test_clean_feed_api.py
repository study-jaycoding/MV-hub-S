"""클린 피드 세션·API — services/clean_feed_session · routers/clean_feed · 계정 세대값 +1 자리 · 인증 공개 예외.

계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md 'session-relay'·'api-guards'·'media-relay'.
창은 가짜(FakeWindows — 바로 끝나는 Future), WS 는 가짜 소켓(FakeWS) 또는 TestClient, 공유 서버는 `_proxy._open` 가짜.
실제 크롬·창·공유 서버에는 닿지 않는다.
"""

from __future__ import annotations

import asyncio
import email.message
import functools
import io
import json
import os
import shutil
import socket
import threading
import time
import types
import urllib.error
import urllib.request
from concurrent.futures import Future
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.websockets import WebSocketDisconnect

from app import active_account, config, db, db_paths
from app.deps import SESSION_COOKIE
from app.routers import _proxy, db_transfer, ingest, library
from app.routers import auth as auth_router
from app.routers import clean_feed as router_mod
from app.services import auth as auth_svc
from app.services import clean_feed_session as cfs
from app.services import local_agent_pair, operational_logging, request_guards
from app.services.clean_feed_session import Hub, Identity, token_sha
from app.services.clean_feed_window import OpenError, Screen

ACCOUNT_A = "feed-a@example.invalid"
ACCOUNT_B = "feed-b@example.invalid"
ORIGIN = "http://127.0.0.1:8010"
BROWSER = ("chrome", r"C:\Chrome\chrome.exe")
SCREEN = Screen(1920, 0, 1080, 1920, 1.0, False)
TAB1, TAB2 = "tab-aaaaaaaa", "tab-bbbbbbbb"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _done(value) -> Future:
    future: Future = Future()
    future.set_result(value)
    return future


class FakeWindows:
    """창 스레드 대신 — 명령을 적고 바로 끝나는 Future 를 준다. 대기 창은 release 가 성공한 release id 를 '다시 쓸 수 있음'으로 흉내 낸다."""

    def __init__(self) -> None:
        self.listener = lambda kind, session: None
        self.opens: list[dict] = []
        self.closes: list = []
        self.active: list[tuple[str, bool]] = []
        self.fail: OpenError | None = None
        self.hang = False
        self.pending = False
        self.armed: list[str] = []
        self.readied: list[str] = []
        self.releases: list[tuple[str, str]] = []
        self.release_futures: list[Future] = []
        self.release_ok = True
        self.release_hang = False  # release 결과를 시험이 줄 때까지 안 끝낸다
        self.standby_closes: list[str] = []
        self.reusable: str | None = None  # 이 release id 의 대기 창이 살아 있다(open(reuse=…) 이 다시 쓴다)

    def cleanup_pending(self):
        return self.pending

    def open(self, *, session, url, screen, browser, reuse=None):
        self.opens.append({"session": session, "url": url, "screen": screen, "browser": browser, "reuse": reuse})
        future: Future = Future()
        if self.fail:
            future.set_exception(self.fail)
        elif not self.hang:
            reused = reuse is not None and reuse == self.reusable
            self.reusable = None  # 다시 썼거나(세션 창이 됨) 새로 띄우며 끝냈다
            future.set_result({"reused": reused})
        return future

    def arm(self, session):
        self.armed.append(session)
        return _done(True)

    def ready(self, session):
        self.readied.append(session)
        return _done(True)

    def release(self, session, release_id):
        self.releases.append((session, release_id))
        future: Future = Future()
        self.release_futures.append(future)
        if not self.release_hang:
            self.finish_release(future, release_id)
        return future

    def finish_release(self, future, release_id, ok=None):
        ok = self.release_ok if ok is None else ok
        if ok:
            self.reusable = release_id
        future.set_result(ok)

    def close_standby(self, release_id):
        self.standby_closes.append(release_id)
        if self.reusable == release_id:
            self.reusable = None
        return _done(True)

    def close(self, session=None):
        self.closes.append(session)
        future: Future = Future()
        future.set_result(True)
        return future

    def set_active(self, session, value):
        self.active.append((session, value))

    def stop(self):
        pass


class FakeWS:
    """serve_ws 가 쓰는 만큼만 — 받을 글은 inbox, 보낸 글은 sent(JSON)."""

    def __init__(self, send_hangs: bool = False) -> None:
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed: int | None = None
        self.send_hangs = send_hangs

    async def accept(self, subprotocol=None):
        self.subprotocol = subprotocol

    async def receive_text(self):
        item = await self.inbox.get()
        if item is None:
            raise WebSocketDisconnect(1000)
        return item

    async def send_text(self, text):
        if self.send_hangs:
            await asyncio.Event().wait()
        self.sent.append(json.loads(text))

    async def close(self, code=1000):
        self.closed = code
        self.inbox.put_nowait(None)

    def kinds(self):
        return [m["t"] for m in self.sent]


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    """인증 끔(로컬 허브) — 머신 포인터를 임시 폴더로, 계정 A 로 시작."""
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    active_account.set_active(ACCOUNT_A, "uid-a")
    try:
        yield
    finally:
        active_account._uid_override.reset(uid_token)
        active_account.reset_override(key_token)


def _identity() -> Identity:
    return Identity(active_account.account_epoch(), active_account.capture_account_pin())


def _open(hub, *, client=TAB1, seq=1, takeover=True, identity=None, proxying=False):
    return hub.open(screen=SCREEN, takeover=takeover, client=client, seq=seq, origin=ORIGIN, identity=identity or _identity(),
                    proxying=proxying, browser=BROWSER)


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)
    await asyncio.sleep(0.01)


async def _connect(hub, role):
    ws = FakeWS()
    task = asyncio.create_task(hub.serve_ws(ws, hub.session, role))
    await _settle()
    return ws, task


async def _drop(ws, task):
    ws.inbox.put_nowait(None)
    await asyncio.wait_for(task, 2)


def _scene(rev, sources=None):
    return json.dumps({"t": "scene", "rev": rev, "layout": {"total": 10}, "doc": {"tracks": []}, "sources": sources or {}})


def _clock(rev, time_=1.0, sync=0, **extra):
    return json.dumps({"t": "clock", "rev": rev, "time": time_, "at": 5.0, "playing": True, "moving": True, "rate": 1, "limit": 10,
                       "sync": sync, **extra})


def _key(key=" ", code="Space", **extra):
    return json.dumps({"t": "key", "key": key, "code": code, "ctrlKey": False, "shiftKey": False, "altKey": False, "metaKey": False,
                       "repeat": False, **extra})


def run(coro):
    return asyncio.run(coro)


# ── open · close · takeover · 순번 ─────────────────────────────────────────────────────────────────
def test_open_issues_session_and_takeover_rules(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        a = await _open(hub, client=TAB1, seq=1)
        assert set(a) == {"session", "key", "instance", "reused"} and a["instance"] == hub.instance and a["reused"] is False
        assert hub.windows.armed == [a["session"]]  # 등록 뒤에 2단계(창 찾기)를 시작한다
        assert hub.windows.opens[0]["url"] == f"{ORIGIN}/?cleanfeed={a['session']}&key={a['key']}"
        with pytest.raises(HTTPException) as busy:  # 자동 다시 열기는 남을 밀어내지 않는다
            await _open(hub, client=TAB2, seq=1, takeover=False)
        assert (busy.value.status_code, busy.value.detail) == (409, "busy")
        assert hub.describe(a["session"]) == {"session": "live", "ended_reason": None}
        b = await _open(hub, client=TAB2, seq=2, takeover=True)
        assert hub.describe(a["session"]) == {"session": "ended", "ended_reason": "taken"}
        assert hub.live(a["session"], a["key"]) is None and hub.windows.closes[-1] == a["session"]
        assert hub.live(b["session"], b["key"]) is hub.session
        assert hub.describe("f" * 32) == {"session": "unknown", "ended_reason": None}

    run(go())


def test_same_tab_lower_seq_is_stale_and_other_tab_ignores_seq(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        b = await _open(hub, client=TAB1, seq=5)  # 수동 B 가 먼저 처리됨
        for seq in (4, 5):  # 늦게 처리된 수동 A(더 낮은 순번)·같은 순번 — 밀어내지 않는다
            with pytest.raises(HTTPException) as stale:
                await _open(hub, client=TAB1, seq=seq, takeover=True)
            assert (stale.value.status_code, stale.value.detail) == (409, "stale")
        assert hub.live(b["session"], b["key"]) is hub.session and len(hub.windows.opens) == 1
        c = await _open(hub, client=TAB2, seq=1, takeover=True)  # 다른 탭은 순번과 무관(그 탭의 사람 선택)
        assert hub.describe(b["session"])["ended_reason"] == "taken" and hub.session.id == c["session"]

    run(go())


def test_close_requires_live_key_and_old_generation_is_ignored(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        a = await _open(hub, seq=1)
        b = await _open(hub, seq=2)
        assert await hub.close(a["session"], a["key"]) is False  # 옛 세대의 close — 지금 세션을 끄지 않는다
        assert await hub.close(b["session"], "x" * 48) is False
        assert hub.session.ended is None
        assert await hub.close(b["session"], b["key"]) is True
        assert hub.describe(b["session"]) == {"session": "ended", "ended_reason": "closed"}
        assert await hub.close(b["session"], b["key"]) is False  # 끝난 key 는 다시 안 통한다

    run(go())


def test_open_failure_and_timeout_are_recorded(accounts, monkeypatch):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        hub.windows.fail = OpenError("profile-in-use")
        with pytest.raises(HTTPException) as failed:
            await _open(hub, seq=1)
        assert (failed.value.status_code, failed.value.detail) == (409, "profile-in-use")
        assert hub.session is None and list(hub.ended.values()) == ["open-failed"]
        hub.windows.fail, hub.windows.hang = None, True
        monkeypatch.setattr(cfs, "OPEN_TIMEOUT", 0.05)
        with pytest.raises(HTTPException) as late:
            await _open(hub, seq=2)
        assert (late.value.status_code, late.value.detail) == (504, "window-timeout")
        assert hub.windows.closes[-1] == hub.windows.opens[-1]["session"]  # 늦게 뜨는 창도 닫는다

    run(go())


def test_ended_reasons_and_tab_seqs_keep_last_32(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        ids = [(await _open(hub, client=f"tab-{n:08d}", seq=1))["session"] for n in range(34)]
        assert len(hub.ended) == cfs.KEEP and len(hub.clients) == cfs.KEEP
        assert hub.describe(ids[0]) == {"session": "unknown", "ended_reason": None}  # 끝난 기록 33개째 — 가장 옛 것이 밀려남
        assert hub.describe(ids[1]) == {"session": "ended", "ended_reason": "taken"}
        assert hub.describe(ids[-1])["session"] == "live"

    run(go())


def test_shutdown_ends_session(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        a = await _open(hub)
        await hub.shutdown()
        assert hub.describe(a["session"])["ended_reason"] == "hub-stopped"

    run(go())


# ── WS 중계 ──────────────────────────────────────────────────────────────────────────────────────
def test_new_main_gets_current_resync_first_and_visible_replays_scene_then_sample(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, main_task = await _connect(hub, "main")
        assert main.sent == [{"t": "resync", "sync": 0}]
        main.inbox.put_nowait(_scene(1, {"c1": {"state": "ready", "type": "video", "url": "/media/ab/c1.mp4", "thumb": None}}))
        main.inbox.put_nowait(_clock(1, 2.0))
        await _settle()
        feed, feed_task = await _connect(hub, "feed")  # 늦게 붙은 피드 — (보이는 창이라) visible → 장면 → 표본
        assert feed.kinds() == ["visible", "scene", "clock"] and feed.sent[0]["sync"] == 0 and feed.sent[2]["time"] == 2.0
        feed.sent.clear()
        hub.on_window("visible", hub.session.id)
        await _settle()
        assert feed.kinds() == ["visible", "scene", "clock"] and feed.sent[0]["sync"] == 1
        assert main.sent[-1] == {"t": "resync", "sync": 1}
        await _drop(main, main_task)
        main2, main2_task = await _connect(hub, "main")  # 다시 붙은 main — 놓친 resync 를 되살린다
        assert main2.sent[0] == {"t": "resync", "sync": 1}
        await _drop(main2, main2_task)
        await _drop(feed, feed_task)

    run(go())


def test_feed_reconnecting_after_hidden_to_visible_gets_visible_again(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, main_task = await _connect(hub, "main")
        main.inbox.put_nowait(_scene(1))
        await _settle()
        feed, feed_task = await _connect(hub, "feed")
        hub.on_window("hidden", hub.session.id)
        await _drop(feed, feed_task)  # 숨은 채 끊김
        hub.on_window("visible", hub.session.id)  # 끊긴 사이 보임 — 피드가 없어 visible 을 못 받았다
        await _settle()
        assert main.sent[-1] == {"t": "resync", "sync": 1}
        feed2, feed2_task = await _connect(hub, "feed")
        assert feed2.kinds()[:2] == ["visible", "scene"] and feed2.sent[0]["sync"] == 1  # 지금 번호의 visible 부터
        hub.on_window("hidden", hub.session.id)
        await _drop(feed2, feed2_task)
        feed3, feed3_task = await _connect(hub, "feed")  # 숨은 채 다시 붙음 — visible 을 꾸며 내지 않는다
        assert feed3.kinds() == ["scene"]
        await _drop(feed3, feed3_task)
        await _drop(main, main_task)

    run(go())


def test_roles_cannot_send_other_kinds_and_big_messages_are_dropped(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, main_task = await _connect(hub, "main")
        feed, feed_task = await _connect(hub, "feed")
        main.sent.clear()
        for text in (_key(), json.dumps({"t": "visible", "sync": 9}), json.dumps({"t": "closed", "reason": "x"}), "not json", "[1]"):
            main.inbox.put_nowait(text)  # main 이 피드 글·허브 글을 위조
        for text in (_scene(3), _clock(3), json.dumps({"t": "resync", "sync": 7}), json.dumps({"t": "active", "active": True})):
            feed.inbox.put_nowait(text)  # 피드가 앱 글·허브 글을 위조
        main.inbox.put_nowait(_clock(0, extra="x" * cfs.OTHER_MAX))  # 4 KB 넘는 시계
        main.inbox.put_nowait(json.dumps({"t": "scene", "rev": 0, "sources": {}, "pad": "x" * cfs.SCENE_MAX}))  # 512 KB 넘는 장면
        feed.sent.clear()
        await _settle()
        assert feed.sent == [] and main.sent == [] and hub.session.scene is None
        assert hub.windows.active == [(hub.session.id, False)]  # main 등록 때의 초기화뿐 — 피드의 active 위조는 안 통한다
        await _drop(main, main_task)
        await _drop(feed, feed_task)

    run(go())


def test_latest_only_for_scene_clock_and_scene_rev_never_goes_back(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        sess = hub.session
        main = cfs._Conn(FakeWS(), "main", 1)
        feed = cfs._Conn(FakeWS(), "feed", 2)  # 보내는 쪽(sender)을 안 돌려 대기에 쌓이는 모양을 본다
        sess.conns.update(main=main, feed=feed)
        for rev in (1, 2):
            hub._receive(sess, main, _scene(rev))
        for t in (1.0, 2.0, 3.0):
            hub._receive(sess, main, _clock(2, t))
        assert set(feed.latest) == {"scene", "clock"} and not feed.ctrl
        assert json.loads(feed.latest["scene"])["rev"] == 2 and json.loads(feed.latest["clock"])["time"] == 3.0
        hub._receive(sess, main, _scene(1))  # 옛 rev 장면 — 버린다
        assert sess.scene_rev == 2 and json.loads(feed.latest["scene"])["rev"] == 2
        hub._receive(sess, main, _clock(1, 9.0))  # 옛 rev 표본은 지금 장면의 표본으로 남기지 않는다(피드에는 가고 피드가 거른다)
        assert json.loads(sess.sample)["time"] == 3.0

    run(go())


def test_sample_sent_before_its_scene_is_kept_for_a_late_feed(accounts):
    """멈춘 채 6초에서 장면을 고쳤다 — 앱은 새 rev 의 표본을 장면보다 먼저 보내고 그 뒤 표본이 없다. 늦게 붙은 피드도 장면 → 6초 표본을 받는다."""
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, main_task = await _connect(hub, "main")
        main.inbox.put_nowait(_scene(0))
        main.inbox.put_nowait(_clock(0, 6.0, playing=False, moving=False))
        main.inbox.put_nowait(_clock(1, 6.0, playing=False, moving=False))  # rev 를 올린 뒤의 표본이 장면보다 먼저
        main.inbox.put_nowait(_scene(1))
        await _settle()
        feed, feed_task = await _connect(hub, "feed")
        assert feed.kinds() == ["visible", "scene", "clock"]
        assert feed.sent[1]["rev"] == 1 and (feed.sent[2]["rev"], feed.sent[2]["time"]) == (1, 6.0)
        main.inbox.put_nowait(_scene(2))  # 그 rev 의 표본 없이 다음 장면 — 옛 rev 의 표본은 내린다
        await _settle()
        assert hub.session.sample is None
        await _drop(feed, feed_task)
        await _drop(main, main_task)

    run(go())


def test_keys_keep_order_and_overflow_reports_error(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        sess = hub.session
        main = cfs._Conn(FakeWS(), "main", 1)
        feed = cfs._Conn(FakeWS(), "feed", 2)
        sess.conns.update(main=main, feed=feed)
        hub._receive(sess, feed, _key())
        hub._receive(sess, feed, _key(repeat=True, ctrlKey="yes"))  # 참이 아닌 값은 false
        hub._receive(sess, feed, _key(key="x" * 33))  # 이상한 키는 버린다
        got = [json.loads(k) for k in main.keys]
        assert [g["code"] for g in got] == ["Space", "Space"]  # Space 두 번이 두 번
        assert got[0]["repeat"] is False and got[1]["repeat"] is True and got[1]["ctrlKey"] is False
        for _ in range(cfs.KEY_QUEUE):
            hub._receive(sess, feed, _key())
        assert len(main.keys) == cfs.KEY_QUEUE
        assert json.loads(main.ctrl[-1]) == {"t": "error", "reason": "key-overflow"}

    run(go())


def test_send_timeout_closes_that_connection(accounts, monkeypatch):
    monkeypatch.setattr(cfs, "SEND_TIMEOUT", 0.05)

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        ws = FakeWS(send_hangs=True)
        task = asyncio.create_task(hub.serve_ws(ws, hub.session, "main"))  # 첫 resync 보내기가 끝나지 않는다
        await asyncio.wait_for(task, 2)
        assert ws.closed == 1011 and "main" not in hub.session.conns

    run(go())


def test_replaced_connection_cleanup_does_not_clear_new_one(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main1, task1 = await _connect(hub, "main")
        old = hub.session.conns["main"]
        main2, task2 = await _connect(hub, "main")
        await asyncio.wait_for(task1, 2)  # 옛 연결은 끊기고 그 정리가 끝났다
        assert main1.closed == 4000
        assert hub.session.conns["main"].ws is main2 and hub.session.main_lost is None
        sid = hub.session.id
        assert hub.windows.active == [(sid, False), (sid, False)]  # 등록마다 초기화뿐 — 옛 정리가 하나 더 지우지 않는다
        hub._receive(hub.session, old, _scene(5))  # 옛 연결이 기다리던 글이 늦게 들어왔다
        hub._receive(hub.session, old, json.dumps({"t": "active", "active": True}))
        assert hub.session.scene is None and hub.windows.active == [(sid, False), (sid, False)]
        await _drop(main2, task2)
        assert hub.windows.active[-1] == (sid, False) and len(hub.windows.active) == 3 and hub.session.main_lost is not None

    run(go())


def test_end_tells_connections_then_closes_them(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, main_task = await _connect(hub, "main")
        feed, feed_task = await _connect(hub, "feed")
        await _open(hub, seq=2)  # 다른 선택이 가져감
        await asyncio.wait_for(asyncio.gather(main_task, feed_task), 2)
        assert main.sent[-1] == {"t": "taken", "reason": "taken"} and feed.sent[-1] == {"t": "taken", "reason": "taken"}
        assert main.closed == 1000 and feed.closed == 1000

    run(go())


# ── 계정 · main 3초 ─────────────────────────────────────────────────────────────────────────────
def test_main_gone_boundary_2_9_keeps_3_1_ends(accounts):
    async def go():
        clock = Clock()
        hub = Hub(FakeWindows(), clock=clock)
        await _open(hub)
        clock.t += 2.9
        await hub.check()
        assert hub.session.ended is None  # 한 번도 안 붙었어도 created 부터 3초
        main, task = await _connect(hub, "main")
        clock.t += 10
        await hub.check()
        assert hub.session.ended is None
        await _drop(main, task)  # 끊김
        clock.t += 2.9
        await hub.check()
        main, task = await _connect(hub, "main")  # 2.9초에 다시 붙음 — 유지
        clock.t += 5
        await hub.check()
        assert hub.session.ended is None
        await _drop(main, task)
        clock.t += 3.1
        await hub.check()
        assert hub.session.ended == "main-gone"

    run(go())


@pytest.mark.parametrize("change", ["logout", "logout_then_same", "a_b_a", "switch_b"])
def test_account_change_between_checks_ends_session_even_with_main_alive(accounts, change):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, task = await _connect(hub, "main")
        if change == "logout":
            active_account.clear_active()
        elif change == "logout_then_same":  # 점검 사이 A→로그아웃→A — 식별값은 같고 세대값만 다르다
            active_account.clear_active()
            active_account.set_active(ACCOUNT_A, "uid-a")
        elif change == "a_b_a":
            active_account.set_active(ACCOUNT_B, "uid-b")
            active_account.set_active(ACCOUNT_A, "uid-a")
        else:
            active_account.set_active(ACCOUNT_B, "uid-b")
        assert active_account.capture_account_pin() == (ACCOUNT_A, "uid-a") or change in ("logout", "switch_b")
        await hub.check()  # close 가 안 와도
        assert hub.session.ended == "account"
        await asyncio.wait_for(task, 2)
        assert main.sent[-1] == {"t": "closed", "reason": "account"}

    run(go())


def test_account_change_is_caught_by_next_ws_message_too(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, task = await _connect(hub, "main")
        active_account.clear_active()
        main.inbox.put_nowait(_clock(0))
        await asyncio.wait_for(task, 2)
        assert hub.session.ended == "account"
        assert main.sent[-1] == {"t": "closed", "reason": "account"} and main.closed == 1000  # 알린 뒤 닫는다

    run(go())


def test_session_that_ended_before_accept_is_closed_not_registered(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        sess = hub.session
        hub.end(sess, "closed")
        ws = FakeWS()
        await asyncio.wait_for(hub.serve_ws(ws, sess, "main"), 2)
        assert ws.closed == 4404 and sess.conns == {} and ws.sent == []

    run(go())


def test_watcher_checks_every_second_and_stops_with_session(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        a = await _open(hub)
        active_account.clear_active()  # close 도 WS 글도 없이
        await asyncio.sleep(1.3)
        assert hub.describe(a["session"])["ended_reason"] == "account"
        await asyncio.sleep(1.1)
        assert hub._watch.done()  # 세션이 끝나면 멈춘다(다음 open 이 다시 띄운다)
        await _open(hub, seq=2)
        assert not hub._watch.done()

    run(go())


def test_unchanged_account_keeps_session(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        main, task = await _connect(hub, "main")
        for _ in range(3):
            active_account.capture_account_pin()  # 읽기만(/me 같은 것)은 세대값을 안 올린다
            await hub.check()
        assert hub.session.ended is None
        await _drop(main, task)

    run(go())


def _session(identity, proxying=False):
    return cfs.Session(id="a" * 32, key="k" * 48, origin=ORIGIN, generation=1, identity=identity, proxying=proxying, created=0.0)


def test_auth_on_identity_checks_token_like_middleware(monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    accounts_db = {"a@example.invalid": {"email": "a@example.invalid", "status": "approved", "password_changed_at": None}}
    monkeypatch.setattr(auth_svc, "verify_token", lambda token: "a@example.invalid" if token.startswith("tok-a") else None)
    monkeypatch.setattr(auth_svc, "token_password_stamp", lambda token: token.split(":")[1] if ":" in token else None)
    from app import repo
    monkeypatch.setattr(repo, "get_account", lambda email: accounts_db.get(email))
    hub = Hub(FakeWindows())
    epoch = active_account.account_epoch()

    def ident(token, sha=None):
        return Identity(epoch, ("", None), email="a@example.invalid", token_sha=sha or token_sha(token), token=token)

    assert hub.identity_ok(_session(ident("tok-a")))
    assert not hub.identity_ok(_session(ident("tok-a", sha=token_sha("other"))))  # 지문과 사본이 다름
    assert not hub.identity_ok(_session(ident("tok-x")))  # 무효 토큰
    accounts_db["a@example.invalid"]["password_changed_at"] = "s1"
    assert not hub.identity_ok(_session(ident("tok-a:s0")))  # 비밀번호가 바뀐 옛 토큰
    assert hub.identity_ok(_session(ident("tok-a:s1")))
    accounts_db["a@example.invalid"]["status"] = "pending"
    assert not hub.identity_ok(_session(ident("tok-a:s1")))
    active_account.bump_account_epoch()
    accounts_db["a@example.invalid"]["status"] = "approved"
    assert not hub.identity_ok(_session(ident("tok-a:s1")))  # 세대값이 다름


def _http_request(host="127.0.0.1"):
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": (host, 50000),
                    "server": ("127.0.0.1", 8012), "scheme": "http", "query_string": b""})


def test_auth_routes_bump_epoch_on_token_issue_and_logout_only(tmp_path, monkeypatch):
    """로그인(같은 계정 재로그인 포함)·access·register(토큰 발급)·logout 은 +1 · /me·local-pair-token·대기 계정 가입은 그대로."""
    from app import main as main_module

    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "hub.db"))
    db.flush_pool()
    db.init_db()
    monkeypatch.setattr(main_module, "AUTH_ENABLED", True)
    monkeypatch.setattr(ingest, "LOCAL_AGENT_PAIR_SECRET", "pair-key")
    monkeypatch.setattr(local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key")
    monkeypatch.setattr(auth_router.agent_signals, "signal", Mock())
    local_agent_pair.clear(_http_request())
    epoch = active_account.account_epoch
    client = TestClient(main_module.app, client=("127.0.0.1", 50000))
    try:
        a = {"email": "epoch-a@example.com", "password": "smoke-test-only", "name": "A"}
        before = epoch()
        assert client.post("/api/auth/register", json=a).json()["token"]  # 첫 계정 = 승인·토큰
        assert epoch() == before + 1
        before = epoch()
        token = client.post("/api/auth/login", json=a).json()["token"]
        assert epoch() == before + 1
        headers = {"Authorization": f"Bearer {token}"}
        before = epoch()
        for _ in range(2):
            assert client.get("/api/auth/me", headers=headers).status_code == 200
        assert client.post("/api/agent/local-pair-token", json={"secret": "pair-key"}).status_code == 200
        assert epoch() == before
        opened = _session(Identity(epoch(), ("", None)))
        assert client.post("/api/auth/login", json=a).status_code == 200  # 같은 계정 재로그인 = 새 토큰
        assert not Hub(FakeWindows()).epoch_ok(opened)
        before = epoch()
        assert client.post("/api/auth/access", json=a).json()["token"]
        assert epoch() == before + 1
        before = epoch()
        assert client.post("/api/auth/register", json={**a, "email": "epoch-b@example.com"}).json()["token"] is None  # 대기 계정
        assert epoch() == before
        before = epoch()
        assert client.post("/api/auth/logout", headers=headers).status_code == 200
        assert epoch() == before + 1
    finally:
        client.close()
        local_agent_pair.clear(_http_request())
        db.flush_pool()


def test_pair_account_change_bumps_epoch_only_when_it_changes(monkeypatch):
    monkeypatch.setattr(local_agent_pair, "LOCAL_AGENT_PAIR_SECRET", "pair-key")
    monkeypatch.setattr(auth_router.agent_signals, "signal", Mock())
    request = _http_request()
    local_agent_pair.clear(request)
    try:
        before = active_account.account_epoch()
        auth_router._activate_local_agent(request, "pair-a@example.com")  # 처음 짝(로그인 경로가 이미 올렸다)
        auth_router._activate_local_agent(request, "PAIR-A@example.com")  # 같은 계정(/me 반복)
        assert active_account.account_epoch() == before
        auth_router._activate_local_agent(request, "pair-b@example.com")
        assert active_account.account_epoch() == before + 1
    finally:
        local_agent_pair.clear(request)


@pytest.fixture
def restore_env(tmp_path, monkeypatch):
    """DB 복원(인증 끔) — test_db_restore_account_boundary 의 설비를 줄인 것. 합성 SQLite 만 설치한다."""
    db.flush_pool()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer, "AUTH_ENABLED", False)
    monkeypatch.setattr(db_transfer, "DATA_DIR", tmp_path)
    monkeypatch.setattr(active_account, "_POINTER", tmp_path / "active.json")
    monkeypatch.setattr(active_account, "_cache", [False, None])
    monkeypatch.setattr(db_paths, "DEFAULT_DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setenv("CONTENT_HUB_DB", "")
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(db_transfer.tempfile, "tempdir", str(temp))
    seed = tmp_path / "seed" / "source.db"
    seed.parent.mkdir()
    db.init_db(seed)
    db.flush_pool()
    key_token = active_account.set_override(None)
    uid_token = active_account._uid_override.set(None)
    active_account.set_active(ACCOUNT_A, "uid-a")
    for path in (active_account.account_db_path(ACCOUNT_A), db_paths.DEFAULT_DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(seed, path)
    source = tmp_path / "input.db"
    shutil.copy2(seed, source)
    try:
        yield source
    finally:
        active_account._uid_override.reset(uid_token)
        active_account.reset_override(key_token)
        db.flush_pool()


def test_db_restore_pointer_clear_ends_session(restore_env):
    opened = _session(_identity())
    expected = db_transfer._capture_restore_target()
    before = active_account.account_epoch()
    assert db_transfer._install_db(restore_env, expected=expected)["ok"]
    assert active_account.account_epoch() == before + 1  # _strict_clear_active — clear_active 를 거치지 않는 해제
    assert not Hub(FakeWindows()).identity_ok(opened)


def test_db_restore_rollback_pointer_restore_ends_session(restore_env, monkeypatch):
    opened = _session(_identity())
    expected = db_transfer._capture_restore_target()
    monkeypatch.setattr(db_transfer, "_post_install_security_init", Mock(side_effect=RuntimeError("synthetic failure")))
    before = active_account.account_epoch()
    with pytest.raises(RuntimeError, match="synthetic failure"):
        db_transfer._install_db(restore_env, expected=expected)
    assert active_account.account_epoch() == before + 1 and active_account.account_key() == ACCOUNT_A  # 되돌린 포인터 — 같은 계정이어도
    assert not Hub(FakeWindows()).identity_ok(opened)


# ── 켜기 단축: 두 단계 열기 · 끈 창 다시 쓰기(docs/status/편집탭_클린피드_허브켜기단축_2026-10-26.md) ─────────────
async def _adopted_with_feed(hub, *, seq=1, client=TAB1):
    """새로 띄운 창을 찾아 맞춘 세션(adopted) + main·feed 연결."""
    opened = await _open(hub, client=client, seq=seq)
    hub.on_window("adopted", opened["session"])
    main, main_task = await _connect(hub, "main")
    feed, feed_task = await _connect(hub, "feed")
    return opened, (main, main_task), (feed, feed_task)


async def _standby_ready(hub):
    opened, (main, main_task), (feed, feed_task) = await _adopted_with_feed(hub)
    assert await hub.close(opened["session"], opened["key"]) is True
    await _settle()
    token = next(m for m in feed.sent if m["t"] == "closed")["standby"]
    return opened, token


async def _standby_conn(hub, token):
    st = hub.standby_for(token, ORIGIN)
    assert st is not None
    ws = FakeWS()
    task = asyncio.create_task(hub.serve_standby(ws, st, cfs.STANDBY_PROTOCOL + token))
    await _settle()
    return ws, task


def test_window_failure_after_answer_ends_session_with_that_reason(accounts):
    async def go():
        for reason in ("window-not-found", "wrong-monitor"):
            hub = Hub(FakeWindows(), clock=Clock())
            opened = await _open(hub)
            main, _ = await _connect(hub, "main")
            feed, _ = await _connect(hub, "feed")
            hub.on_window(reason, opened["session"])
            await _settle()
            assert hub.describe(opened["session"]) == {"session": "ended", "ended_reason": reason}
            assert {"t": "closed", "reason": reason} in main.sent and {"t": "closed", "reason": reason} in feed.sent  # 남기지 않는다(토큰 없음)
            assert hub.standby is None and hub.windows.releases == []

    run(go())


def test_late_window_events_of_an_ended_session_are_ignored(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        a = await _open(hub, client=TAB1, seq=1)
        b = await _open(hub, client=TAB2, seq=1)
        for kind in ("wrong-monitor", "window-not-found", "closed", "adopted", "focus-lost", "visible"):
            hub.on_window(kind, a["session"])
        assert hub.describe(b["session"])["session"] == "live" and not hub.session.adopted and hub.session.sync == 0

    run(go())


def test_focus_lost_before_main_is_held_and_sent_once(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        opened = await _open(hub)
        hub.on_window("focus-lost", opened["session"])
        main, _ = await _connect(hub, "main")
        assert main.kinds() == ["resync", "focus-lost"]
        main2, _ = await _connect(hub, "main")  # 다시 붙어도 또 보내지 않는다
        assert main2.kinds() == ["resync"]
        hub.on_window("focus-lost", opened["session"])  # main 이 있으면 바로
        await _settle()
        assert main2.kinds() == ["resync", "focus-lost"]

    run(go())


def test_adopted_session_closed_with_feed_becomes_standby_and_token_goes_only_to_feed(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        opened, (main, _), (feed, _) = await _adopted_with_feed(hub)
        assert await hub.close(opened["session"], opened["key"]) is True
        await _settle()
        closed_feed = next(m for m in feed.sent if m["t"] == "closed")
        closed_main = next(m for m in main.sent if m["t"] == "closed")
        assert closed_main == {"t": "closed", "reason": "closed"}  # 앱 연결에는 토큰이 없다
        assert closed_feed["reason"] == "closed" and len(closed_feed["standby"]) == 48 and int(closed_feed["standby"], 16) >= 0  # hex(하위 프로토콜에 쓸 수 있는 글자)
        st = hub.standby
        assert hub.windows.releases == [(opened["session"], st.release)] and opened["session"] not in hub.windows.closes
        assert st.state == "ready" and st.origin == ORIGIN and st.browser == BROWSER  # release 결과가 루프에서 반영됐다

    run(go())


def test_window_is_not_kept_unless_adopted_with_feed_and_kept_reason(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        opened = await _open(hub)  # 아직 찾아 맞추지 않았다
        await _connect(hub, "feed")
        await hub.close(opened["session"], opened["key"])
        assert hub.standby is None and hub.windows.closes[-1] == opened["session"]
        hub = Hub(FakeWindows(), clock=Clock())
        opened = await _open(hub)
        hub.on_window("adopted", opened["session"])
        await hub.close(opened["session"], opened["key"])  # 피드 연결이 없다 — 토큰을 받을 곳이 없다
        assert hub.standby is None and hub.windows.closes[-1] == opened["session"]
        hub = Hub(FakeWindows(), clock=Clock())
        opened, *_ = await _adopted_with_feed(hub)
        active_account.bump_account_epoch()
        await hub.check()  # account — 남기지 않는다
        assert hub.describe(opened["session"])["ended_reason"] == "account" and hub.standby is None
        assert hub.windows.closes[-1] == opened["session"]

    run(go())


def test_reuse_assigns_the_new_session_through_the_standby_connection_once(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        first, token = await _standby_ready(hub)
        release = hub.standby.release
        conn, conn_task = await _standby_conn(hub, token)
        assert conn.subprotocol == cfs.STANDBY_PROTOCOL + token
        b = await _open(hub, seq=2)
        assert b["reused"] is True and hub.windows.opens[-1]["reuse"] == release and hub.windows.armed[-1] == b["session"]
        assert hub.session.shown is False and not hub.session.adopted
        await _settle()
        assert conn.sent == [{"t": "assign", "session": b["session"], "key": b["key"]}]
        assert hub.standby is None and hub.standby_for(token, ORIGIN) is None  # 보냈다 = 토큰 소모
        await asyncio.sleep(1.1)
        assert conn.closed is not None  # 피드가 안 닫으면 허브가 닫는다

    run(go())


def test_reuse_before_the_standby_connects_sends_assign_when_it_connects(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        _first, token = await _standby_ready(hub)
        b = await _open(hub, seq=2)
        assert b["reused"] is True and hub.standby.state == "assigned"
        assert hub.standby_for(token, ORIGIN) is not None  # 아직 안 보냈다 — 늦게 붙는 대기 연결도 받는다
        conn, _ = await _standby_conn(hub, token)
        assert conn.sent == [{"t": "assign", "session": b["session"], "key": b["key"]}] and hub.standby is None

    run(go())


def test_assign_is_sent_at_most_once_even_if_the_connection_changes_while_sending(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        _first, token = await _standby_ready(hub)
        st = hub.standby
        stuck = FakeWS(send_hangs=True)
        task = asyncio.create_task(hub.serve_standby(stuck, st, cfs.STANDBY_PROTOCOL + token))
        await _settle()
        await _open(hub, seq=2)
        await _settle()
        assert st.sending is not None and hub.standby_for(token, ORIGIN) is None  # 보내는 중 — 새 대기 연결을 받지 않는다
        await asyncio.sleep(cfs.SEND_TIMEOUT + 0.2)  # 시한 — 실패, 다시 보내지 않는다(세션은 ready 기한으로 끝난다)
        assert hub.standby is None and stuck.sent == []

    run(go())


def test_lost_standby_connection_is_not_reused_and_is_dropped_after_the_gap(accounts, monkeypatch):
    monkeypatch.setattr(cfs, "STANDBY_LOST_WAIT", 0.05)

    async def go():
        # ① 끊긴 뒤 틈 안에 온 open — assign 을 받을 연결이 없으니 다시 쓰지 않고 새로 띄운다(대기 창은 창 스레드가 끝낸다)
        hub = Hub(FakeWindows(), clock=Clock())
        _first, token = await _standby_ready(hub)
        st = hub.standby
        conn, _ = await _standby_conn(hub, token)
        conn.inbox.put_nowait(None)  # 피드 쪽 끊김 — 피드는 다시 안 붙는다
        await _settle()
        assert st.lost and st.conn is None and hub.standby is st
        b = await _open(hub, seq=2)
        assert b["reused"] is False and hub.windows.opens[-1]["reuse"] is None and hub.standby is None
        # ② 아무도 안 열면 틈이 지나 기록을 버리고 그 대기 창만 끝낸다
        hub2 = Hub(FakeWindows(), clock=Clock())
        _first2, token2 = await _standby_ready(hub2)
        st2 = hub2.standby
        conn2, _ = await _standby_conn(hub2, token2)
        conn2.inbox.put_nowait(None)
        await asyncio.sleep(0.15)
        assert hub2.standby is None and hub2.windows.standby_closes == [st2.release]
        # ③ 틈 안에 새 연결(개발 화면 StrictMode 의 교체) — 그대로 두고 다시 쓴다
        hub3 = Hub(FakeWindows(), clock=Clock())
        _first3, token3 = await _standby_ready(hub3)
        st3 = hub3.standby
        conn3a, _ = await _standby_conn(hub3, token3)
        conn3a.inbox.put_nowait(None)
        await _settle()
        conn3b, _ = await _standby_conn(hub3, token3)
        await asyncio.sleep(0.15)
        assert hub3.standby is st3 and st3.conn is not None and not st3.lost and hub3.windows.standby_closes == []
        c = await _open(hub3, seq=2)
        await _settle()
        assert c["reused"] is True and conn3b.sent == [{"t": "assign", "session": c["session"], "key": c["key"]}]

    run(go())


def test_an_earlier_loss_timer_does_not_cut_the_gap_of_a_later_loss(accounts, monkeypatch):
    monkeypatch.setattr(cfs, "STANDBY_LOST_WAIT", 0.2)

    async def go():
        # A 끊김 → B 붙음 → B 끊김 → A 의 예약 시각이 지나도 B 의 끊김부터 0.2초 안이면 기록이 남는다(독립 리뷰 2차 P2)
        hub = Hub(FakeWindows(), clock=Clock())
        _first, token = await _standby_ready(hub)
        st = hub.standby
        conn_a, _ = await _standby_conn(hub, token)
        conn_a.inbox.put_nowait(None)
        await asyncio.sleep(0.08)
        conn_b, _ = await _standby_conn(hub, token)
        await asyncio.sleep(0.08)
        conn_b.inbox.put_nowait(None)
        await asyncio.sleep(0.1)  # A 의 예약(0.2초)은 지났다 — B 의 끊김부터는 0.1초
        assert hub.standby is st and hub.windows.standby_closes == []
        conn_c, _ = await _standby_conn(hub, token)  # 틈 안의 새 연결은 받는다
        await asyncio.sleep(0.25)
        assert hub.standby is st and st.conn is not None and hub.windows.standby_closes == []

    run(go())


def test_reuse_needs_the_same_account_and_current_epoch(accounts):
    async def go():
        for change in ("epoch", "account"):
            hub = Hub(FakeWindows(), clock=Clock())
            _first, token = await _standby_ready(hub)
            release = hub.standby.release
            if change == "epoch":
                active_account.bump_account_epoch()
            else:
                active_account.set_active(ACCOUNT_B, "uid-b")
            assert hub.standby_for(token, ORIGIN) is None  # 대기 WS 도 세대값을 본다
            b = await _open(hub, seq=2)
            assert b["reused"] is False and hub.windows.opens[-1]["reuse"] is None, change
            assert hub.standby is None, change
            active_account.set_active(ACCOUNT_A, "uid-a")
            assert release  # 기록은 버렸다(창은 새로 띄우는 길이 끝냈다)

    run(go())


def test_epoch_change_drops_a_standby_even_without_a_live_session(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _standby_ready(hub)
        release = hub.standby.release
        assert hub._watch is not None and not hub._watch.done()  # 세션이 없어도 대기 기록이 있으면 점검이 돈다
        active_account.bump_account_epoch()
        await hub.check()
        assert hub.standby is None and hub.windows.standby_closes == [release]

    run(go())


def test_takeover_waits_for_the_release_it_just_queued_then_reuses(accounts):
    async def go():
        windows = FakeWindows()
        windows.release_hang = True
        hub = Hub(windows, clock=Clock())
        a, *_ = await _adopted_with_feed(hub)
        loop = asyncio.get_running_loop()

        def finish():
            windows.finish_release(windows.release_futures[-1], windows.releases[-1][1])

        loop.call_later(0.05, finish)  # 모니터를 바꿀 때 새 open 이 앞 close 보다 먼저 왔다 — 같은 open 안에서 taken 으로 남긴 것을 기다린다
        b = await _open(hub, seq=2)
        assert hub.describe(a["session"])["ended_reason"] == "taken" and b["reused"] is True

    run(go())


def test_cancelled_open_does_not_cancel_the_release_it_waits_for(accounts):
    async def go():
        windows = FakeWindows()
        windows.release_hang = True
        hub = Hub(windows, clock=Clock())
        await _adopted_with_feed(hub)
        task = asyncio.create_task(_open(hub, seq=2))
        await _settle()
        future = windows.release_futures[-1]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not future.cancelled()  # 창 큐는 취소된 Future 의 일을 건너뛴다 — 기다림만 끝났다
        windows.finish_release(future, windows.releases[-1][1])
        await _settle()
        assert hub.standby is not None and hub.standby.state == "ready"

    run(go())


def test_release_failure_drops_the_record_and_its_early_connection(accounts):
    async def go():
        windows = FakeWindows()
        windows.release_hang = True
        hub = Hub(windows, clock=Clock())
        opened, _main, (feed, _) = await _adopted_with_feed(hub)
        await hub.close(opened["session"], opened["key"])
        await _settle()
        token = next(m for m in feed.sent if m["t"] == "closed")["standby"]
        conn, _ = await _standby_conn(hub, token)  # release 결과 전(reserved)에도 받는다 — 첫 거절이 없다
        windows.finish_release(windows.release_futures[-1], windows.releases[-1][1], ok=False)
        await _settle()
        assert hub.standby is None and conn.closed == 4404 and hub.standby_for(token, ORIGIN) is None

    run(go())


def test_reused_session_is_shown_only_after_ready_within_its_deadline(accounts):
    async def go():
        clock = Clock()
        hub = Hub(FakeWindows(), clock=clock)
        await _standby_ready(hub)
        b = await _open(hub, seq=2)
        feed, _ = await _connect(hub, "feed")
        feed.inbox.put_nowait(json.dumps({"t": "ready"}))
        await _settle()
        assert hub.windows.readied == [b["session"]] and hub.session.adopted and hub.session.shown is False  # 보임은 visible 사건이 정한다
        hub.on_window("visible", b["session"])
        assert hub.session.shown is True and hub.session.sync == 1
        for late in ("ready", "check"):  # 기한을 넘긴 ready · 1초 점검 — 숨긴 채 끝내고 남기지 않는다
            hub2 = Hub(FakeWindows(), clock=clock)
            await _standby_ready(hub2)
            c = await _open(hub2, seq=2)
            clock.t += cfs.FEED_READY_WAIT + 0.1
            if late == "ready":
                feed2, _ = await _connect(hub2, "feed")
                feed2.inbox.put_nowait(json.dumps({"t": "ready"}))
                await _settle()
            else:
                await hub2.check()
            assert hub2.describe(c["session"])["ended_reason"] == "window-not-found", late  # main-gone 보다 먼저
            assert hub2.windows.readied == [] and hub2.standby is None and hub2.windows.closes[-1] == c["session"], late

    run(go())


def test_old_session_main_cleanup_does_not_overwrite_the_new_sessions_active(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, client=TAB1, seq=1)
        main_a, task_a = await _connect(hub, "main")
        await _open(hub, client=TAB2, seq=1)  # A taken
        before = list(hub.windows.active)
        await _drop(main_a, task_a)
        assert hub.windows.active == before  # 끝난 A 의 연결 정리가 지금 세션의 active 를 덮지 않는다

    run(go())


def test_standby_ended_event_drops_only_that_release(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _standby_ready(hub)
        hub.on_window("standby-ended", "other")
        assert hub.standby is not None
        hub.on_window("standby-ended", hub.standby.release)
        assert hub.standby is None

    run(go())


# ── 미디어 ──────────────────────────────────────────────────────────────────────────────────────
def test_media_kind_accepts_only_same_origin_media_and_media_thumb():
    assert cfs.media_kind("/media/ab/x.mp4") == "media"
    assert cfs.media_kind("/api/media-thumb?src=/media/ab/x.png&w=320") == "thumb"
    assert cfs.media_kind("/api/media-thumb?src=%2Fmedia%2Fab%2Fx.png") == "thumb"
    for bad in ("/media/../db/hub.db", "/media/ab/%2e%2e/x", "/media/ab\\x", "/media/ab/x.mp4?y=1", "/api/media-picture?src=/media/ab/x.png",
                "/api/media-thumb?src=https://cdn.example/x.png", "/api/media-thumb?src=/media/a.png&src=/media/b.png",
                "/api/media-thumb?src=/media/a.png&other=1", "/api/db/export", "media/ab/x", "https://cdn.example/x.mp4", None, 5,
                "/media/" + "x" * 5000):
        assert cfs.media_kind(bad) is None, bad


def test_scene_numbers_are_stable_and_never_reused(accounts):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        sess = hub.session
        main = cfs._Conn(FakeWS(), "main", 1)
        sess.conns["main"] = main
        sources = {"c1": {"state": "ready", "type": "video", "url": "/media/ab/1.mp4", "thumb": "/api/media-thumb?src=/media/ab/1.mp4&w=320"},
                   "c2": {"state": "ready", "type": "video", "url": "https://cdn.example/2.mp4", "thumb": "/api/db/export"},
                   "c3": {"state": "ready", "type": "image", "url": "/media/../x", "thumb": None}}
        hub._receive(sess, main, _scene(1, sources))
        first = json.loads(sess.scene)["sources"]
        prefix = f"{cfs.MEDIA_PATH}{sess.id}/"
        assert first["c1"]["url"] == f"{prefix}1?key={sess.key}" and first["c1"]["thumb"] == f"{prefix}2?key={sess.key}"
        assert first["c2"] == {"state": "ready", "type": "video", "url": "https://cdn.example/2.mp4", "thumb": None}  # 절대 주소는 그대로
        assert first["c3"]["url"] is None
        hub._receive(sess, main, _scene(2, {"c1": sources["c1"], "c4": {"state": "ready", "type": "image", "url": "/media/ab/4.png"}}))
        second = json.loads(sess.scene)["sources"]
        assert second["c1"]["url"] == first["c1"]["url"]  # 같은 원본 = 같은 번호
        assert second["c4"]["url"] == f"{prefix}3?key={sess.key}"  # 새 원본은 새 번호(옛 번호를 다시 주지 않는다)
        assert sess.media == {1: "/media/ab/1.mp4", 2: "/api/media-thumb?src=/media/ab/1.mp4&w=320", 3: "/media/ab/4.png"}

    run(go())


class Upstream:
    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = io.BytesIO(body)
        self.closed = False
        self.headers = email.message.Message()
        for name, value in (headers or {}).items():
            self.headers[name] = value

    def read(self, size=-1):
        if self.closed:
            raise ValueError("closed")
        return self._body.read(size)

    def close(self):
        self.closed = True


@pytest.fixture
def shared(monkeypatch):
    """서버 보존본 중계 — 계정마다 다른 공유 서버 주소·토큰(저장소 값) · `_proxy._open` 가짜가 요청을 적는다."""
    state = types.SimpleNamespace(
        bases={ACCOUNT_A: "http://a.invalid", ACCOUNT_B: "http://b.invalid"},
        tokens={ACCOUNT_A: "tok-a", ACCOUNT_B: "tok-b"},
        seen=[], reply=lambda req: Upstream(200, b"0123456789", {"Content-Type": "video/mp4", "Content-Length": "10"}),
    )
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: state.bases[active_account.account_key()])
    monkeypatch.setattr(_proxy, "_stored_token", lambda: state.tokens[active_account.account_key()])

    def fake_open(req, timeout):
        state.seen.append({"url": req.full_url, "method": req.get_method(), "timeout": timeout,
                           "headers": {k.lower(): v for k, v in req.header_items()}})
        result = state.reply(req)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(_proxy, "_open", fake_open)
    return state


def _starlette_request(method="GET", headers=None):
    encoded = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": method, "path": "/", "headers": encoded, "client": ("127.0.0.1", 1),
                    "server": ("127.0.0.1", 8010), "scheme": "http", "query_string": b""})


def test_relay_uses_pinned_account_and_rereads_its_token(accounts, shared):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        sess = _session(_identity(), proxying=True)
        active_account.set_active(ACCOUNT_B, "uid-b")  # 중계 도중 기계 계정이 B 로
        path = "/api/media-thumb?src=/media/ab/x.png&w=320"
        response = await hub._relay(_starlette_request(headers={"Range": "bytes=2-5", "If-None-Match": '"e1"'}), sess, path, cfs._Slot(sess))
        seen = shared.seen[-1]
        assert seen["url"] == "http://a.invalid" + path and seen["headers"]["authorization"] == "Bearer tok-a"  # A 의 연결·토큰
        assert seen["headers"]["range"] == "bytes=2-5" and seen["headers"]["if-none-match"] == '"e1"'
        assert seen["headers"]["accept-encoding"] == "identity" and seen["timeout"] == 30
        assert "key=" not in seen["url"] and "clean-feed" not in seen["url"]  # 피드 경로·key 가 안 나간다
        assert response.headers["cache-control"] == "no-store"
        shared.tokens[ACCOUNT_A] = "tok-a2"  # 같은 pin 안에서 저장된 토큰만 바뀜(재로그인 없이)
        await hub._relay(_starlette_request(), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert shared.seen[-1]["headers"]["authorization"] == "Bearer tok-a2"

    run(go())


def test_relay_keeps_status_and_headers_and_head_has_no_body(accounts, shared):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        sess = _session(_identity(), proxying=True)

        def http_error(code, headers, body=b""):
            msg = email.message.Message()
            for name, value in headers.items():
                msg[name] = value
            return urllib.error.HTTPError("http://a.invalid/x", code, "x", msg, io.BytesIO(body))

        shared.reply = lambda req: Upstream(206, b"2345", {"Content-Type": "video/mp4", "Content-Range": "bytes 2-5/10", "Content-Length": "4",
                                                           "Accept-Ranges": "bytes", "ETag": '"e1"', "Last-Modified": "Mon, 01 Jan 2026 00:00:00 GMT",
                                                           "Cache-Control": "public, max-age=31536000", "Set-Cookie": "x=1"})
        partial = await hub._relay(_starlette_request(headers={"Range": "bytes=2-5"}), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert partial.status_code == 206 and partial.media_type == "video/mp4"
        for name in ("content-range", "content-length", "accept-ranges", "etag", "last-modified"):
            assert name in partial.headers
        assert partial.headers["cache-control"] == "no-store" and "set-cookie" not in partial.headers  # 그 밖의 헤더는 안 옮긴다
        assert sess.streams  # 진행 중 스트림 — 세션이 끝나면 끊는다
        shared.reply = lambda req: http_error(304, {"ETag": '"e1"'})
        not_modified = await hub._relay(_starlette_request(headers={"If-None-Match": '"e1"'}), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert not_modified.status_code == 304 and not_modified.body == b"" and not_modified.headers["etag"] == '"e1"'
        shared.reply = lambda req: http_error(416, {"Content-Range": "bytes */10", "Content-Type": "text/plain"}, b"range")
        bad_range = await hub._relay(_starlette_request(headers={"Range": "bytes=99-"}), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert bad_range.status_code == 416 and bad_range.headers["content-range"] == "bytes */10"
        upstream = Upstream(200, b"0123456789", {"Content-Type": "video/mp4", "Content-Length": "10"})
        shared.reply = lambda req: upstream
        head = await hub._relay(_starlette_request("HEAD"), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert shared.seen[-1]["method"] == "HEAD" and head.body == b"" and head.headers["content-length"] == "10" and upstream.closed
        boundary = "multipart/byteranges; boundary=3d6b6a416f9b5"  # 여러 구간 Range — boundary 가 없으면 본문을 못 가른다
        shared.reply = lambda req: Upstream(206, b"--3d6b6a416f9b5...", {"Content-Type": boundary, "Content-Length": "18"})
        multi = await hub._relay(_starlette_request(headers={"Range": "bytes=0-1,5-6"}), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert multi.headers["content-type"] == boundary
        shared.reply = lambda req: http_error(500, {"Content-Type": "text/plain; charset=euc-kr"}, "오류".encode("euc-kr"))
        failed = await hub._relay(_starlette_request(), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert failed.status_code == 500 and failed.headers["content-type"] == "text/plain; charset=euc-kr"
        shared.reply = lambda req: urllib.error.URLError("down")
        with pytest.raises(HTTPException) as down:
            await hub._relay(_starlette_request(), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        assert down.value.status_code == 502 and down.value.headers["Cache-Control"] == "no-store"

    run(go())


def test_session_ending_while_relay_connects_closes_that_upstream(accounts, shared):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        upstream = Upstream(200, b"x" * 10, {"Content-Type": "video/mp4"})

        def ends_meanwhile(req):
            hub._loop.call_soon_threadsafe(hub.end, sess, "closed")  # 연결을 기다리는 사이 세션이 끝난다
            time.sleep(0.05)
            return upstream

        shared.reply = ends_meanwhile
        sess.in_flight = 1
        with pytest.raises(HTTPException) as gone:
            await hub._relay(_starlette_request(), sess, "/media/ab/x.mp4", cfs._Slot(sess))
        await _settle()
        assert gone.value.status_code == 404 and upstream.closed and not sess.streams  # end() 가 모르는 응답으로 남지 않는다

    run(go())


def test_session_ending_while_reading_an_error_body_closes_it(accounts, shared):
    class SlowBody:
        def __init__(self):
            self.closed = threading.Event()

        def read(self, size=-1):
            assert self.closed.wait(3), "end() 가 닫지 않았다"
            raise ValueError("I/O operation on closed file")

        def close(self):
            self.closed.set()

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        body = SlowBody()
        msg = email.message.Message()
        msg["Content-Type"] = "text/plain"
        shared.reply = lambda req: urllib.error.HTTPError("http://a.invalid/x", 416, "x", msg, body)
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        response = await hub._relay(_starlette_request(headers={"Range": "bytes=99-"}), sess, "/media/ab/x.mp4", slot)
        assert response.status_code == 416 and sess.streams  # 오류 본문도 정상 본문과 같은 스트림 — end() 가 끊을 수 있게 올려 두었다

        async def send(message):
            pass

        async def receive():
            await asyncio.sleep(30)
            return {"type": "http.disconnect"}

        scope = {"type": "http", "method": "GET", "path": "/", "headers": [], "http_version": "1.1", "query_string": b""}
        task = asyncio.create_task(cfs._SessionBound(response, sess, slot)(scope, receive, send))
        await asyncio.sleep(0.1)  # 오류 본문을 읽는 중
        hub.end(sess, "closed")
        await asyncio.wait_for(task, 3)  # 끊긴 응답은 밖으로 예외를 내지 않는다
        assert body.closed.is_set() and not sess.streams and sess.in_flight == 0

    run(go())


def test_error_response_arriving_after_session_ended_is_not_read(accounts, shared):
    class Body:
        reads = 0
        closed = False

        def read(self, size=-1):
            Body.reads += 1
            return b"late"

        def close(self):
            Body.closed = True

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        msg = email.message.Message()
        msg["Content-Type"] = "text/plain"

        def ends_then_errors(req):
            hub._loop.call_soon_threadsafe(hub.end, sess, "closed")  # 연결을 기다리는 사이 끝남
            time.sleep(0.05)
            raise urllib.error.HTTPError("http://a.invalid/x", 416, "x", msg, Body())  # 그 뒤에 온 오류 응답

        shared.reply = ends_then_errors
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        with pytest.raises(HTTPException) as gone:
            await hub._relay(_starlette_request(headers={"Range": "bytes=99-"}), sess, "/media/ab/x.mp4", slot)
        slot.release()  # media() 가 하는 정리
        assert gone.value.status_code == 404 and Body.reads == 0 and Body.closed and not sess.streams and sess.in_flight == 0

    run(go())


def _stalled_server(monkeypatch, status):
    """실제 소켓 — 머리와 본문 10바이트를 보내고 멈추는 로컬 서버. (멈춤 해제 이벤트, 서버 소켓)."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    release = threading.Event()

    def serve():
        conn, _ = server.accept()
        conn.recv(65536)
        conn.sendall(f"HTTP/1.1 {status} X\r\nContent-Type: video/mp4\r\nContent-Length: 1000000\r\n\r\n".encode() + b"x" * 10)
        release.wait(15)  # 본문을 더 보내지 않고 멈춘다
        conn.close()

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: f"http://127.0.0.1:{port}")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "tok-a")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 시스템 프록시를 타지 않는 실제 HTTP
    monkeypatch.setattr(_proxy, "_open", lambda req, timeout: opener.open(req, timeout=timeout))
    return release, server


@pytest.mark.parametrize("status", [206, 416])
def test_media_request_cancelled_before_headers_keeps_its_slot_until_the_late_response_is_closed(accounts, monkeypatch, tmp_path, status):
    """머리를 받기 전 취소 → 연결 작업(스레드)은 돈다 → 그동안 자리를 쥐고(동시 4개 밖에서 쌓이지 않게) · 늦게 온 응답은 닫고 자리를 비운다."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    headers_go, release = threading.Event(), threading.Event()

    def serve():
        conn, _ = server.accept()
        conn.recv(65536)
        headers_go.wait(10)  # 머리를 늦게 보낸다
        conn.sendall(f"HTTP/1.1 {status} X\r\nContent-Type: video/mp4\r\nContent-Length: 1000000\r\n\r\n".encode() + b"x" * 10)
        release.wait(10)
        conn.close()

    threading.Thread(target=serve, daemon=True).start()
    monkeypatch.setattr(_proxy, "_stored_base_url", lambda: f"http://127.0.0.1:{port}")
    monkeypatch.setattr(_proxy, "_stored_token", lambda: "tok-a")
    monkeypatch.setattr(_proxy, "MEDIA_DIR", tmp_path / "media")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    got = []

    def recording_open(req, timeout):
        try:
            response = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            got.append(exc)
            raise
        got.append(response)
        return response

    monkeypatch.setattr(_proxy, "_open", recording_open)

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        path = hub._feed_url(sess, "/media/ab/server-only.mp4")
        number = int(path.split("/")[-1].split("?")[0])
        task = asyncio.create_task(hub.media(_starlette_request(headers={"Range": "bytes=0-"}), sess.id, number, sess.key))
        await asyncio.sleep(0.3)  # 연결은 됐고 머리를 기다리는 중
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert sess.in_flight == 1  # 연결 작업이 아직 돈다 — 자리를 쥔다
        headers_go.set()
        for _ in range(200):
            if sess.in_flight == 0:
                break
            await asyncio.sleep(0.01)
        assert sess.in_flight == 0 and got and got[0].closed and not sess.streams  # 늦은 응답을 닫고 자리를 비웠다

    try:
        run(go())
    finally:
        headers_go.set()
        release.set()
        server.close()


def test_releasing_on_the_loop_while_a_thread_reads_does_not_block_the_loop(accounts, monkeypatch):
    """자리 비우기가 루프 위에서 불렸는데 다른 스레드가 아직 그 응답을 읽고 있다(취소된 작업 등) — 소켓만 끊고 close 는 실행기에서(루프를 세우지 않는다)."""
    release, server = _stalled_server(monkeypatch, 206)

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        await hub._relay(_starlette_request(headers={"Range": "bytes=0-"}), sess, "/media/ab/x.mp4", slot)
        upstream = slot.upstream
        reader = asyncio.ensure_future(asyncio.to_thread(upstream.read, 1024 * 1024))  # 멈춘 소켓에서 읽는 스레드
        await asyncio.sleep(0.3)
        t0 = time.perf_counter()
        slot.release()
        assert time.perf_counter() - t0 < 0.2  # 루프가 서지 않는다
        with pytest.raises(Exception):
            await asyncio.wait_for(reader, 3)  # 소켓을 끊어 읽기가 끝났다
        await asyncio.sleep(0.3)
        assert sess.in_flight == 0 and not sess.streams and upstream.closed

    try:
        run(go())
    finally:
        release.set()
        server.close()


@pytest.mark.parametrize("spec", ["2.3", "2.4"])
@pytest.mark.parametrize("status", [206, 416])
def test_client_disconnect_during_a_stalled_relay_body_frees_the_slot_at_once(accounts, monkeypatch, spec, status):
    """세션은 살아 있고 상류 본문(정상·오류)만 멈췄는데 피드 창이 요청을 끊었다 — 막힌 읽기를 깨워 응답이 곧 끝나고 자리가 돌아온다(60초 읽기 시한까지 묶이지 않는다)."""
    release, server = _stalled_server(monkeypatch, status)

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        response = await hub._relay(_starlette_request(headers={"Range": "bytes=0-"}), sess, "/media/ab/x.mp4", slot)
        assert response.status_code == status  # 오류 본문도 감시를 받는 스트림 응답으로 바로 돌아온다
        disconnect = asyncio.Event()
        state = {"first": True}

        async def receive():
            if state.pop("first", False):
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if disconnect.is_set():
                raise OSError("client gone")  # 서버가 끊긴 연결에 보내면 그렇다

        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": spec}, "method": "GET", "path": "/", "headers": [],
                 "http_version": "1.1", "query_string": b""}
        task = asyncio.create_task(cfs._SessionBound(response, sess, slot)(scope, receive, send))
        await asyncio.sleep(0.5)  # 본문 읽기가 멈춘 소켓에서 기다리는 중
        assert sess.in_flight == 1
        t0 = time.perf_counter()
        disconnect.set()
        await asyncio.wait_for(task, 2)  # 끊긴 응답은 밖으로 예외를 내지 않는다
        assert time.perf_counter() - t0 < 1.0 and sess.in_flight == 0 and not sess.streams
        assert hub.live(sess.id, sess.key) is sess  # 세션은 그대로 — 다음 요청이 자리를 받는다

    try:
        run(go())
    finally:
        release.set()
        server.close()


@pytest.mark.parametrize("status", [206, 416])
def test_ending_session_while_relay_reads_a_stalled_real_socket_does_not_block_the_loop(accounts, monkeypatch, status):
    """실제 소켓 — 서버가 본문을 조금 보내고 멈춘 사이 세션이 끝난다. 읽는 스레드가 버퍼 잠금을 쥐고 있어도 end() 가 루프를 세우지 않고 읽기를 끝낸다."""
    release, server = _stalled_server(monkeypatch, status)

    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        scope = {"type": "http", "method": "GET", "path": "/", "headers": [], "http_version": "1.1", "query_string": b""}

        async def send(message):
            pass

        async def receive():
            await asyncio.sleep(30)
            return {"type": "http.disconnect"}

        async def relay():
            response = await hub._relay(_starlette_request(headers={"Range": "bytes=0-"}), sess, "/media/ab/x.mp4", slot)
            await cfs._SessionBound(response, sess, slot)(scope, receive, send)  # 본문(정상·오류)을 읽는 스레드가 멈춘 소켓에서 기다린다

        task = asyncio.create_task(relay())
        await asyncio.sleep(0.5)  # 본문 읽기가 멈춘 소켓에서 기다리는 중
        assert sess.streams
        t0 = time.perf_counter()
        hub.end(sess, "closed")
        took = time.perf_counter() - t0
        beat = time.perf_counter()
        await asyncio.sleep(0.01)
        assert took < 0.2 and time.perf_counter() - beat < 0.5  # 이벤트 루프가 서지 않는다
        await asyncio.wait_for(task, 5)  # 끊긴 응답은 밖으로 예외를 내지 않는다
        await asyncio.sleep(0.3)
        assert sess.in_flight == 0 and not sess.streams and slot.upstream.closed  # 읽기·소켓·자리 모두 정리

    try:
        run(go())
    finally:
        release.set()
        server.close()


@pytest.mark.parametrize("kind", ["file", "stream"])
def test_media_response_is_cut_when_session_ends_mid_body(accounts, tmp_path, kind):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub)
        sess = hub.session
        sess.in_flight = 1
        if kind == "file":
            path = tmp_path / "big.bin"
            path.write_bytes(b"x" * (1024 * 1024))
            inner = FileResponse(path)
        else:
            inner = StreamingResponse(iter([b"a" * 1000] * 50), media_type="video/mp4")
        bound = cfs._SessionBound(inner, sess, cfs._Slot(sess))
        bodies = []

        async def send(message):
            if message["type"] == "http.response.body":
                bodies.append(len(message.get("body", b"")))
                if len(bodies) == 1:
                    hub.end(sess, "closed")  # 보내는 도중 끝남(로그아웃·닫기)

        async def receive():
            await asyncio.sleep(5)
            return {"type": "http.disconnect"}

        scope = {"type": "http", "method": "GET", "path": "/", "headers": [], "http_version": "1.1", "query_string": b""}
        await asyncio.wait_for(bound(scope, receive, send), 3)  # 끊긴 응답은 밖으로 예외를 내지 않는다
        assert len(bodies) == 1 and sess.in_flight == 0  # 더 보내지 않고 · 자리는 비웠다

    run(go())


def test_end_cuts_streams_in_flight_and_slot_releases_once(accounts, shared):
    async def go():
        hub = Hub(FakeWindows(), clock=Clock())
        await _open(hub, proxying=True)
        sess = hub.session
        upstream = Upstream(200, b"x" * 10, {"Content-Type": "video/mp4"})
        shared.reply = lambda req: upstream
        sess.in_flight = 1
        slot = cfs._Slot(sess)
        await hub._relay(_starlette_request(), sess, "/media/ab/x.mp4", slot)
        assert upstream in sess.streams and not upstream.closed
        hub.end(sess, "closed")
        assert upstream.closed and not sess.streams
        slot.release()
        slot.release()
        assert sess.in_flight == 0

    run(go())


# ── 라우터 ──────────────────────────────────────────────────────────────────────────────────────
@pytest.fixture
def api(accounts, tmp_path, monkeypatch):
    windows = FakeWindows()
    hub = Hub(windows, clock=Clock())
    monkeypatch.setattr(hub, "_watcher", lambda: asyncio.sleep(0))  # 1초 점검은 Hub 시험(check·watcher)이 본다 — 여기서는 경쟁을 없앤다
    cfs.reset_for_tests(hub)
    monkeypatch.setattr(router_mod, "_browser", lambda: BROWSER)
    monkeypatch.setattr(router_mod, "os", types.SimpleNamespace(name="nt", environ=os.environ))
    monkeypatch.setattr(config, "HOST", "127.0.0.1")
    monkeypatch.setattr(_proxy, "is_shared_team_server", lambda: False)
    monkeypatch.setattr(_proxy, "MEDIA_DIR", tmp_path / "media")
    monkeypatch.delenv("MVHUB_DEV_FRONTEND_PORT", raising=False)
    monkeypatch.setattr(request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1", "::1", "localhost"}))
    app = FastAPI()
    app.include_router(router_mod.router)
    with TestClient(app, base_url="http://127.0.0.1:8010", client=("127.0.0.1", 50000)) as client:
        try:
            yield types.SimpleNamespace(client=client, hub=hub, windows=windows, media=tmp_path / "media")
        finally:
            if hub._watch:
                client.portal.call(hub._watch.cancel)
    cfs.reset_for_tests(None)


OPEN_BODY = {"screen": {"left": 1920, "top": 0, "width": 1080, "height": 1920, "dpr": 1, "primary": False}, "takeover": True,
             "client": TAB1, "seq": 1}


def _api_open(api, origin=ORIGIN, **body):
    return api.client.post("/api/clean-feed/open", json={**OPEN_BODY, **body}, headers={"origin": origin})


def test_status_reports_support_instance_and_session(api):
    status = api.client.get("/api/clean-feed/status").json()
    assert status == {"supported": True, "reason": None, "instance": api.hub.instance, "session": None, "ended_reason": None}
    opened = _api_open(api).json()
    assert opened["instance"] == api.hub.instance
    assert api.windows.opens[0]["screen"] == Screen(1920, 0, 1080, 1920, 1.0, False) and api.windows.opens[0]["browser"] == BROWSER
    assert api.client.get("/api/clean-feed/status", params={"session": opened["session"]}).json()["session"] == "live"
    closed = api.client.post("/api/clean-feed/close", content=json.dumps({"session": opened["session"], "key": opened["key"]}),
                             headers={"content-type": "text/plain"})  # pagehide 의 sendBeacon
    assert closed.json() == {"closed": True}
    assert api.client.get("/api/clean-feed/status", params={"session": opened["session"]}).json()["ended_reason"] == "closed"
    api.windows.pending = True  # 앞 창이 아직 안 끝났다(정리 실패) — 메뉴가 처음부터 팝업 방식으로 가게
    pending = api.client.get("/api/clean-feed/status").json()
    assert (pending["supported"], pending["reason"]) == (False, "cleanup-failed")


@pytest.mark.parametrize("change,reason", [("windows", "windows-only"), ("team", "team-server"), ("host", "not-loopback"), ("browser", "no-browser")])
def test_unsupported_places_refuse_everything(api, monkeypatch, change, reason):
    opened = _api_open(api).json()
    if change == "windows":
        monkeypatch.setattr(router_mod, "os", types.SimpleNamespace(name="posix", environ=os.environ))
    elif change == "team":
        monkeypatch.setattr(_proxy, "is_shared_team_server", lambda: True)
    elif change == "host":
        monkeypatch.setattr(config, "HOST", "0.0.0.0")
    else:
        monkeypatch.setattr(router_mod, "_browser", lambda: None)
    status = api.client.get("/api/clean-feed/status").json()
    assert (status["supported"], status["reason"]) == (False, reason)
    assert _api_open(api, seq=2).status_code == 404
    media = api.client.get(f"/api/clean-feed/media/{opened['session']}/1", params={"key": opened["key"]})
    assert media.status_code == 404 and media.headers["cache-control"] == "no-store"
    with pytest.raises(WebSocketDisconnect) as closed:
        with api.client.websocket_connect(f"/ws/clean-feed?session={opened['session']}&key={opened['key']}&role=main", headers={"origin": ORIGIN}):
            pass
    assert closed.value.code == 4404


def test_open_trusts_only_socket_port_origins(api, monkeypatch):
    for origin in ("http://127.0.0.1:8010", "http://localhost:8010", "http://[::1]:8010"):
        assert _api_open(api, origin=origin, seq=len(api.windows.opens) + 1).status_code == 200, origin
    seq = len(api.windows.opens) + 1
    assert _api_open(api, origin="http://127.0.0.1:5175", seq=seq).status_code == 403  # dev 포트는 설정됐을 때만
    spoofed = api.client.post("/api/clean-feed/open", json={**OPEN_BODY, "seq": seq + 1},
                              headers={"origin": "http://127.0.0.1:5175", "host": "127.0.0.1:5175"})  # Host 를 바꿔도 소켓 포트로
    assert spoofed.status_code == 403
    assert _api_open(api, origin="https://evil.example", seq=seq + 2).status_code == 403
    assert api.client.post("/api/clean-feed/open", json={**OPEN_BODY, "seq": seq + 3}).status_code == 403  # Origin 없음
    monkeypatch.setenv("MVHUB_DEV_FRONTEND_PORT", "5175")
    ok = _api_open(api, origin="http://127.0.0.1:5175", seq=seq + 4)
    assert ok.status_code == 200 and api.hub.session.origin == "http://127.0.0.1:5175"  # 그 출처를 세션에 고정
    monkeypatch.setenv("MVHUB_DEV_FRONTEND_PORT", "99999")
    assert _api_open(api, origin="http://127.0.0.1:99999", seq=seq + 5).status_code == 403
    assert _api_open(api, client="bad id!", seq=seq + 6).status_code == 422


def test_http_routes_refuse_other_machines(api):
    remote = TestClient(api.client.app, base_url="http://127.0.0.1:8010", client=("192.168.1.50", 50000))
    try:
        assert remote.get("/api/clean-feed/status").status_code == 403
        assert remote.post("/api/clean-feed/open", json=OPEN_BODY, headers={"origin": ORIGIN}).status_code == 403
        assert remote.post("/api/clean-feed/close", content=b"{}").status_code == 403
        assert remote.get(f"/api/clean-feed/media/{'a' * 32}/1", params={"key": "k"}).status_code == 403
    finally:
        remote.close()


def test_close_body_limits(api):
    assert api.client.post("/api/clean-feed/close", content=b"x" * 1025).status_code == 413
    assert api.client.post("/api/clean-feed/close", content=b"not json").status_code == 400
    assert api.client.post("/api/clean-feed/close", content=json.dumps({"session": "s"})).status_code == 400
    assert api.client.post("/api/clean-feed/close", content=json.dumps({"session": "s", "key": "k"})).json() == {"closed": False}


def _ws_path(opened, role="main", key=None):
    return f"/ws/clean-feed?session={opened['session']}&key={key or opened['key']}&role={role}"


def _ws_refused(api, path, headers):
    with pytest.raises(WebSocketDisconnect) as closed:
        with api.client.websocket_connect(path, headers=headers):
            pass
    return closed.value.code


def test_ws_guards_before_accept(api, monkeypatch):
    opened = _api_open(api).json()
    ok_headers = {"origin": ORIGIN}
    assert _ws_refused(api, _ws_path(opened, role="admin"), ok_headers) == 4404
    assert _ws_refused(api, _ws_path(opened, key="x" * 48), ok_headers) == 4404
    assert _ws_refused(api, _ws_path(opened), {"origin": "http://localhost:8010"}) == 4403  # 세션 출처와 다름
    assert _ws_refused(api, _ws_path(opened), {**ok_headers, "x-forwarded-for": "127.0.0.1, 192.168.1.50"}) == 4403  # Vite 경유 LAN
    with api.client.websocket_connect(_ws_path(opened), headers={**ok_headers, "x-forwarded-for": "192.168.1.50, 127.0.0.1"}) as ws:
        assert ws.receive_json() == {"t": "resync", "sync": 0}  # 마지막 전달 주소가 이 PC
    remote = TestClient(api.client.app, base_url="http://127.0.0.1:8010", client=("192.168.1.50", 50000))
    try:
        with pytest.raises(WebSocketDisconnect) as closed:
            with remote.websocket_connect(_ws_path(opened), headers=ok_headers):
                pass
        assert closed.value.code == 4403
    finally:
        remote.close()
    active_account.bump_account_epoch()
    assert _ws_refused(api, _ws_path(opened), ok_headers) == 4409
    assert api.hub.describe(opened["session"])["ended_reason"] == "account"
    assert _ws_refused(api, _ws_path(opened), ok_headers) == 4404  # 끝난 세션의 key 는 다시 안 통한다


def test_ws_main_cookie_token_must_match_session_when_auth_on(api, monkeypatch):
    monkeypatch.setattr(config, "AUTH_ENABLED", True)
    identity = Identity(active_account.account_epoch(), ("", None), email="a@example.invalid", token_sha=token_sha("tok-a"), token="tok-a")
    opened = api.client.portal.call(functools.partial(api.hub.open, screen=SCREEN, takeover=True, client=TAB2, seq=1, origin=ORIGIN,
                                                      identity=identity, proxying=False, browser=BROWSER))
    with api.client.websocket_connect(_ws_path(opened), headers={"origin": ORIGIN, "cookie": f"{SESSION_COOKIE}=tok-a"}) as ws:
        assert ws.receive_json()["t"] == "resync"
    with api.client.websocket_connect(_ws_path(opened, role="feed"), headers={"origin": ORIGIN}):
        pass  # 피드 창(전용 프로필)은 쿠키가 없다 — 쿠키 대조는 main 만
    assert api.hub.describe(opened["session"])["session"] == "live"
    code = _ws_refused(api, _ws_path(opened), {"origin": ORIGIN, "cookie": f"{SESSION_COOKIE}=tok-b"})  # 다시 로그인한 토큰
    assert code == 4409 and api.hub.describe(opened["session"])["ended_reason"] == "account"


def test_ws_standby_takes_token_only_as_single_subprotocol(api):
    opened = _api_open(api).json()
    for role in ("main", "feed"):  # main·feed 는 여전히 key 가 있어야(standby 때문에 key 가 선택 쿼리가 됐다)
        assert _ws_refused(api, f"/ws/clean-feed?session={opened['session']}&role={role}", {"origin": ORIGIN}) == 4404
    api.client.portal.call(api.hub.on_window, "adopted", opened["session"])
    with api.client.websocket_connect(_ws_path(opened, role="feed"), headers={"origin": ORIGIN}) as feed:
        assert api.client.post("/api/clean-feed/close", json={"session": opened["session"], "key": opened["key"]}).json() == {"closed": True}
        token = next(m for m in iter(feed.receive_json, None) if m["t"] == "closed")["standby"]
    path = "/ws/clean-feed?session=standby&role=standby"
    good = cfs.STANDBY_PROTOCOL + token
    for protocols, origin in (([], ORIGIN), ([cfs.STANDBY_PROTOCOL + "x" * 48], ORIGIN), ([good, good], ORIGIN), ([good], "http://localhost:8010")):
        with pytest.raises(WebSocketDisconnect) as closed:
            with api.client.websocket_connect(path, subprotocols=protocols, headers={"origin": origin}):
                pass
        assert closed.value.code == 4404, (protocols, origin)
    with api.client.websocket_connect(path, subprotocols=["other", good], headers={"origin": ORIGIN}) as standby:
        assert standby.accepted_subprotocol == good  # 토큰은 주소(로그에 남는 경로+쿼리)가 아니라 하위 프로토콜로만
        assert api.hub.standby.conn is not None


def test_media_serves_local_file_with_range_head_and_no_store(api):
    opened = _api_open(api).json()
    target = api.media / "ab" / "clip.mp4"
    target.parent.mkdir(parents=True)
    target.write_bytes(bytes(range(256)) * 4)
    path = api.hub._feed_url(api.hub.session, "/media/ab/clip.mp4")
    partial = api.client.get(path, headers={"Range": "bytes=10-19"})
    assert partial.status_code == 206 and partial.content == bytes(range(10, 20))
    assert partial.headers["cache-control"] == "no-store" and partial.headers["content-range"] == "bytes 10-19/1024"
    head = api.client.head(path)
    assert head.status_code == 200 and head.content == b"" and head.headers["content-length"] == "1024"
    assert api.hub.session.in_flight == 0  # 자리는 응답 뒤 비운다
    missing = api.client.get(api.hub._feed_url(api.hub.session, "/media/ab/none.mp4"))  # 위임 아님 → 없음
    assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"
    assert api.client.get(f"{cfs.MEDIA_PATH}{opened['session']}/99", params={"key": opened["key"]}).status_code == 404
    assert api.client.get(path.replace(opened["key"], "x" * 48)).status_code == 404


def test_media_thumb_uses_local_thumb_and_overrides_long_cache(api, monkeypatch):
    _api_open(api)
    (api.media / "ab").mkdir(parents=True)
    (api.media / "ab" / "pic.png").write_bytes(b"png")
    seen = []

    async def fake_thumb(src, w):
        seen.append((src, w))
        return Response(b"jpg", media_type="image/jpeg", headers={"Cache-Control": "public, max-age=31536000, immutable"})

    monkeypatch.setattr(library, "media_thumb", fake_thumb)
    response = api.client.get(api.hub._feed_url(api.hub.session, "/api/media-thumb?src=/media/ab/pic.png&w=320"))
    assert response.status_code == 200 and response.content == b"jpg" and seen == [("/media/ab/pic.png", 320)]
    assert response.headers["cache-control"] == "no-store"


def test_media_relays_server_only_file_through_route(api, monkeypatch, shared):
    monkeypatch.setattr(_proxy, "proxying", lambda: True)
    _api_open(api)
    assert api.hub.session.proxying is True
    shared.reply = lambda req: Upstream(206, b"2345", {"Content-Type": "video/mp4", "Content-Range": "bytes 2-5/10", "Content-Length": "4"})
    path = api.hub._feed_url(api.hub.session, "/media/ab/server-only.mp4")
    response = api.client.get(path, headers={"Range": "bytes=2-5"})
    assert response.status_code == 206 and response.content == b"2345" and response.headers["cache-control"] == "no-store"
    assert shared.seen[-1]["url"] == "http://a.invalid/media/ab/server-only.mp4" and shared.seen[-1]["headers"]["range"] == "bytes=2-5"
    assert api.hub.session.in_flight == 0


def test_media_limits_concurrency_and_ends_on_account_change(api):
    opened = _api_open(api).json()
    path = api.hub._feed_url(api.hub.session, "/media/ab/x.mp4")
    api.hub.session.in_flight = cfs.MEDIA_SLOTS
    busy = api.client.get(path)
    assert busy.status_code == 503 and busy.headers["cache-control"] == "no-store"
    api.hub.session.in_flight = 0
    active_account.set_active(ACCOUNT_B, "uid-b")
    switched = api.client.get(path)
    assert switched.status_code == 409 and switched.headers["cache-control"] == "no-store"
    assert api.hub.describe(opened["session"])["ended_reason"] == "account"
    assert api.client.get(path).status_code == 404


# ── 미들웨어 · 위임 · 로그 ──────────────────────────────────────────────────────────────────────
def test_auth_public_exception_is_only_media_get_head(monkeypatch):
    from app import main as main_module

    monkeypatch.setattr(main_module, "AUTH_ENABLED", True)
    cfs.reset_for_tests(Hub(FakeWindows()))
    client = TestClient(main_module.app, base_url="http://127.0.0.1:8010", client=("127.0.0.1", 50000))
    try:
        sid = "0123456789abcdef" * 2
        assert client.get(f"/api/clean-feed/media/{sid}/1?key=k").status_code == 404  # 인증 대신 라우터가 거절
        assert client.head(f"/api/clean-feed/media/{sid}/1?key=k").status_code == 404
        for method, path in (("POST", f"/api/clean-feed/media/{sid}/1"), ("PUT", f"/api/clean-feed/media/{sid}/1"),
                             ("GET", f"/api/clean-feed/media/{sid}/1/x"), ("GET", f"/api/clean-feed/media/{sid.upper()}/1"),
                             ("GET", f"/api/clean-feed/media/{sid}x/1"), ("GET", "/api/clean-feed/status"),
                             ("POST", "/api/clean-feed/open"), ("POST", "/api/clean-feed/close"),
                             ("GET", f"/api/clean-feed/media/{sid}/12345678901")):
            assert client.request(method, path).status_code == 401, (method, path)
    finally:
        client.close()
        cfs.reset_for_tests(None)


def test_clean_feed_paths_stay_local_when_delegating():
    assert _proxy.is_local_path("/api/clean-feed/status") and _proxy.is_local_path("/api/clean-feed/media/x/1")


def test_clean_feed_posts_are_not_library_changes_and_other_kinds_stay():
    from app import mutation_notify

    for path in ("/api/clean-feed/open", "/api/clean-feed/close"):
        assert mutation_notify.notification_domains("POST", path, 200) == ()  # 열고 닫을 때마다 모든 창이 목록을 다시 읽지 않게
    assert mutation_notify.notification_domains("POST", "/api/generations/g1/tags", 200) == ("library",)
    assert mutation_notify.notification_domains("POST", "/api/assets/folders", 200) == ("assets",)
    assert mutation_notify.notification_domains("POST", "/api/manage/tasks", 200) == ("manage",)
    assert mutation_notify.notification_domains("POST", "/api/manage/hf-missing-apply", 200) == ("library", "manage")


def test_logs_redact_feed_key():
    for line in ("GET /api/clean-feed/media/abc/1?key=SECRETKEY HTTP/1.1", "/ws/clean-feed?session=s&key=SECRETKEY&role=main",
                 "http://127.0.0.1:8010/?cleanfeed=s&key=SECRETKEY"):
        assert "SECRETKEY" not in operational_logging._redact(line)
