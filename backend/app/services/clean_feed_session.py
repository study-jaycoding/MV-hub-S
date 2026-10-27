"""클린 피드 세션 — 앱(main)·피드 창(feed) 사이 WS 중계 · 계정 고정과 영구 종료 · 미디어 번호와 중계 · 허브 인스턴스.

계약 = docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md('구현에서 정한 것' 1·2·4·5·8). 창 제어는 services/clean_feed_window(전용 스레드).
- 세션은 허브당 하나. 끝나면(close·taken·사람이 닫음·계정 세대값/식별값 바뀜·토큰 무효·main 3초 없음·허브 종료) 영구히 끝 — 그 key 는 다시 안 통한다.
- 역할마다 연결 하나 · 역할마다 보낼 수 있는 글 종류 고정 · scene/clock/active 는 최신 하나만 · key 는 순서 그대로(64) · 보내기 1초 시한.
- 미디어: 앱이 장면에 넣은 같은 출처 상대 주소(/media/… · src 가 /media/… 인 /api/media-thumb)에만 번호 — 로컬 파일은 직접, 이 PC 에 없는 서버 보존본만
  세션의 계정 고정값(pin) 안에서 공유 서버 연결을 다시 읽어 원래 경로로 중계. 자기 자신에게 다시 요청하지 않는다.
- 켜기 단축(docs/status/편집탭_클린피드_허브켜기단축_2026-10-26.md — Codex·Claude 합의 472e4909): open 은 크롬을 띄우자마자 등록·응답(창 찾기는 arm 뒤 창 스레드) ·
  closed·taken·main-gone 으로 끝난 adopted 세션의 창은 대기 창(대기 기록 reserved→ready→assigned→delivered — 토큰은 그 세션의 피드 연결로만, 대기 WS 는 하위 프로토콜)으로
  남겨 같은 출처·브라우저·계정의 다음 open 이 다시 쓴다(새 피드 ready 전엔 안 보임 · 3초).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.requests import ClientDisconnect

from .. import active_account, config
from .clean_feed_window import FeedWindows, OpenError, Screen

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class MediaTools:
    """라우터 계층의 미디어 도구 — services 는 routers 를 가져오지 않는다(계층 검사). routers/clean_feed 가 가져올 때 넘긴다."""

    local_target: Callable[[str], Optional[Path]]  # 안전한 /media/... 면 이 PC 의 파일 자리
    thumb: Callable[..., Awaitable[Response]]  # 썸네일 응답(src, w)
    base_url: Callable[[], str]  # 공유 서버 주소 — 계정 고정 안에서 부른다
    token: Callable[[], Optional[str]]
    open: Callable[..., Any]  # 공유 서버 연결 열기(urllib Request, timeout) — 빠른 연결 끊기 규칙 그대로


_MEDIA_TOOLS: Optional[MediaTools] = None


def set_media_tools(tools: MediaTools) -> None:
    global _MEDIA_TOOLS
    _MEDIA_TOOLS = tools


def _media_tools() -> MediaTools:
    if _MEDIA_TOOLS is None:  # 라우터를 안 거친 실행 — 다른 길로 가지 않고 실패로 끝낸다
        raise HTTPException(503, "media-unavailable", headers=NO_STORE)
    return _MEDIA_TOOLS


MAIN_GRACE = 3.0  # main 연결이 이만큼 없으면(한 번도 안 붙은 것 포함) main-gone 으로 끝
FEED_READY_WAIT = 3.0  # 다시 쓴 창의 새 피드가 이만큼 안에 ready 를 안 보내면 window-not-found
KEEP_REASONS = {"closed", "taken", "main-gone"}  # 이 사유로 끝난 adopted 세션의 창은 숨겨 대기 창으로(다시 쓴다)
LATE_OPEN_FAILURES = {"window-not-found", "wrong-monitor"}  # 응답 뒤 2단계 실패 — 앱은 open 실패처럼
STANDBY_PROTOCOL = "mvhub-standby."  # 대기 WS 의 하위 프로토콜 = 이것 + 토큰(주소에 토큰을 안 넣는다 — uvicorn 이 INFO 로 경로+쿼리를 남긴다)
RELEASE_WAIT = 5.0  # 다시 쓸 대기 기록이 아직 reserved 면 그 release 결과를 이만큼 기다린다
STANDBY_LOST_WAIT = 1.0  # 대기 연결이 끊긴 뒤 새 연결(개발 화면 StrictMode 의 교체)을 기다리는 틈 — 지나면 기록을 버리고 창을 끝낸다
SCENE_MAX = 512 * 1024
OTHER_MAX = 4 * 1024
KEY_QUEUE = 64
SEND_TIMEOUT = 1.0
MEDIA_SLOTS = 4
KEEP = 32  # 끝난 세션 사유·탭 순번을 이만큼 기억
OPEN_TIMEOUT = 12.0
MEDIA_PATH = "/api/clean-feed/media/"
NO_STORE = {"Cache-Control": "no-store"}
_KINDS = {"main": {"scene", "clock", "active"}, "feed": {"ready", "key", "error"}, "standby": set()}
_KEY_FIELDS = ("key", "code", "ctrlKey", "shiftKey", "altKey", "metaKey", "repeat")
# Content-Type 은 값 그대로(매개변수까지 — multipart/byteranges 의 boundary·charset). 응답의 media_type 은 이것이 없을 때만 쓰인다
_RELAY_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified")


def token_sha(token: Optional[str]) -> Optional[str]:
    return hashlib.sha256(token.encode("utf-8")).hexdigest() if token else None


@dataclass(frozen=True)
class Identity:
    """open 때의 계정 — 세대값은 늘 · 로컬 허브(인증 끔)는 pin · 인증 켬은 email + 토큰 지문(검증용 메모리 사본)."""

    epoch: int
    pin: tuple[str, Optional[str]]
    email: Optional[str] = None
    token_sha: Optional[str] = None
    token: Optional[str] = field(default=None, repr=False)


class _Conn:
    def __init__(self, ws: Any, role: str, conn_id: int) -> None:
        self.ws, self.role, self.id = ws, role, conn_id
        self.ctrl: deque[str] = deque()  # 허브 글 — 순서 그대로
        self.latest: dict[str, str] = {}  # scene → clock → active, 종류마다 최신 하나
        self.keys: deque[str] = deque()  # 순서 그대로(최대 KEY_QUEUE)
        self.wake = asyncio.Event()
        self.closed = False
        self.sender: Optional[asyncio.Task] = None

    def put(self, text: str, kind: Optional[str] = None) -> None:
        if kind:
            self.latest[kind] = text
        else:
            self.ctrl.append(text)
        self.wake.set()


@dataclass
class Session:
    id: str
    key: str
    origin: str
    generation: int
    identity: Identity
    proxying: bool
    created: float
    conns: dict = field(default_factory=dict)  # role → _Conn
    main_lost: Optional[float] = None  # main 이 마지막으로 끊긴 때(없으면 created 부터 센다)
    main_seen: bool = False
    scene: Optional[str] = None  # 피드에 보낼 장면 글(미디어 주소를 바꾼 뒤)
    scene_rev: int = -1
    sample: Optional[str] = None  # 지금 장면(또는 아직 안 온 다음 장면)의 마지막 표본
    sample_rev: int = -1
    sync: int = 0
    media: dict = field(default_factory=dict)  # 번호 → 원래 주소
    media_ids: dict = field(default_factory=dict)  # 원래 주소 → 번호
    next_media: int = 1
    streams: set = field(default_factory=set)
    in_flight: int = 0
    shown: bool = True  # 창이 지금 보이나(띄운 직후 보임) — 다시 붙은 피드에 visible 을 되살린다
    ended: Optional[str] = None
    browser: tuple = ("", "")
    reused: bool = False  # 대기 창을 다시 썼다 — 새 피드 ready 전엔 안 보인다
    adopted: bool = False  # 새 창은 창 스레드 adopted, 다시 쓴 창은 기한 안 ready — 이래야 끝날 때 대기 창으로 남긴다
    focus_lost: bool = False  # 초점 되돌림 실패 — main 이 붙을 때 한 번 알린다


@dataclass
class Standby:
    """대기 창의 기록 — reserved(release 결과 전) → ready → assigned(새 세션을 붙여 assign 을 정해 둠) → delivered(보냄 = 토큰 소모, 끝).
    토큰은 끝난 세션의 피드 연결로만 갔다. 계정 Identity(세대값)가 같아야 다시 쓴다."""

    release: str
    token: str
    origin: str
    browser: tuple
    identity: Identity
    future: Any = None  # release 결과(창 스레드 Future)
    state: str = "reserved"
    conn: Optional[_Conn] = None
    assign: Optional[str] = None  # assigned 때 보낼 글
    session: Optional[str] = None  # assigned — 붙인 세션
    sending: Optional[_Conn] = None  # assign 을 보내기로 정한 연결(하나 — 바뀌거나 실패해도 다시 안 보낸다)
    lost: bool = False  # 붙었던 대기 연결이 끊겼다(피드는 다시 안 붙는다) — 새 연결이 오기 전엔 다시 쓰지 않는다
    lost_timer: Any = None  # 그 끊김의 정리 예약 — 새 연결이 붙으면 취소(앞 끊김의 예약이 다음 끊김의 틈을 줄이지 않게)


class _Slot:
    """미디어 동시 자리 하나 — 어느 길(오류·HEAD·파일·스트림 끝·응답 뒤)로 끝나도 한 번만 비운다."""

    def __init__(self, sess: "Session") -> None:
        self._sess, self._done, self._held = sess, False, False
        self.upstream: Any = None  # 중계 중인 서버 응답 — 받는 쪽이 끊겨 스트림이 다 안 돌아도 여기서 닫는다
        self.aborted = False  # 받는 쪽이 끊어 상류 소켓을 끊었다 — 읽기 고리는 그 오류를 멈춤으로 본다

    def hold(self) -> None:
        """요청은 취소됐지만 연결 작업(스레드)이 아직 돈다 — 그 작업이 끝날 때까지 자리를 비우지 않는다(동시 4개 밖에서 쌓이지 않게)."""
        self._held = True

    def unhold(self) -> None:
        self._held = False
        self.release()

    def release(self) -> None:
        if self._done or self._held:
            return
        self._done = True
        self._sess.in_flight = max(0, self._sess.in_flight - 1)
        if self.upstream is None:
            return
        upstream = self.upstream
        self._sess.streams.discard(upstream)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # 읽던 스레드(중계 청크 고리의 finally) — 읽기를 끝낸 쪽이 바로 닫는다
            _quiet_close(upstream)
            return
        # 이벤트 루프 위(요청 취소·응답 끝·오류) — 다른 스레드가 아직 읽고 있을 수 있다(취소된 to_thread 는 스레드를 멈추지 않는다).
        #  소켓 핸들을 끊어 그 읽기를 깨우고, 버퍼 잠금이 필요한 close() 는 실행기 스레드에서(루프를 세우지 않는다 — 리뷰 5차)
        _abort(upstream)
        try:
            loop.run_in_executor(None, _quiet_close, upstream)
        except RuntimeError:  # 실행기가 이미 닫혔다(허브 종료 중) — 소켓은 끊었으니 바로 닫아도 기다릴 읽기가 없다
            _quiet_close(upstream)


def _quiet_close(response: Any) -> None:
    try:
        response.close()
    except Exception:  # noqa: BLE001
        pass


class _Cut(Exception):
    """보내는 도중 세션이 끝났다 — 응답을 끊는다(밖으로 내보내지 않는다)."""


class _SessionBound(Response):
    """미디어 응답 — 보내는 동안 세션이 끝나면 끊고(로컬 파일·중계 모두), 어느 길로 끝나도 자리를 한 번 비운다. 몸통·헤더는 inner 가 보낸다."""

    def __init__(self, inner: Response, sess: "Session", slot: "_Slot") -> None:  # noqa: super 를 부르지 않는다 — inner 가 응답이다
        self.inner, self.sess, self.slot = inner, sess, slot
        self.status_code = inner.status_code
        self.background = None
        self.raw_headers = inner.raw_headers

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        gone = asyncio.Event()

        async def watch() -> None:
            """받는 쪽(피드 창)이 끊었나 — 끊으면 막힌 상류 본문 읽기부터 깨운다. 응답의 취소(ASGI 2.4 미만)·다음 보내기 실패(2.4 이상)는
            그 읽기 스레드가 끝나야 진행돼, 기다리면 자리가 읽기 시한(60초)까지 묶인다(리뷰 7차)."""
            while True:
                message = await receive()
                if message.get("type") == "http.disconnect":
                    self.slot.aborted = True
                    if self.slot.upstream is not None:
                        _abort(self.slot.upstream)
                    gone.set()
                    return

        async def inner_receive() -> Any:  # 응답이 듣는 끊김(ASGI 2.4 미만) — 위 watch 가 받은 것을 전한다
            await gone.wait()
            return {"type": "http.disconnect"}

        async def guarded(message: Any) -> None:
            if self.sess.ended:
                raise _Cut()
            await send(message)

        watcher = asyncio.create_task(watch())
        try:
            await self.inner(scope, inner_receive, guarded)
        except BaseException as exc:  # 스트리밍 응답은 작업 묶음 안에서 보내 예외가 묶음으로 올라온다
            if not (_only_cut(exc) or (gone.is_set() and _only_disconnect(exc))):
                raise
        finally:
            watcher.cancel()
            self.slot.release()


def _only_disconnect(exc: BaseException) -> bool:
    """받는 쪽이 끊긴 뒤의 보내기 실패(ClientDisconnect·OSError) — 정상 종료로 본다."""
    if isinstance(exc, BaseExceptionGroup):
        return all(_only_disconnect(inner) or _only_cut(inner) for inner in exc.exceptions)
    return isinstance(exc, (ClientDisconnect, OSError))


def _only_cut(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        return all(_only_cut(inner) for inner in exc.exceptions)
    return isinstance(exc, _Cut)


def _sock_of(response: Any) -> Optional[socket.socket]:
    """중계 응답의 소켓 — HTTPError → HTTPResponse → BufferedReader → SocketIO → socket."""
    obj = response
    for _ in range(5):
        sock = getattr(obj, "_sock", None)
        if isinstance(sock, socket.socket):
            return sock
        obj = getattr(obj, "raw", None) or getattr(obj, "fp", None)
        if obj is None:
            return None
    return None


def _abort(response: Any) -> None:
    """읽던 중계를 끊는다 — 소켓 핸들을 바로 닫아 다른 스레드가 기다리던 recv 를 취소한다(윈도우는 shutdown 만으로는 깨우지 않는다 — 실측).
    응답의 close() 는 쓰지 않는다: 버퍼 잠금을 읽는 스레드가 쥐고 있으면 이벤트 루프가 그 읽기가 끝날 때까지 선다(리뷰 4차). 응답 객체의 정리는
    읽기를 끝낸 쪽(자리 비우기)이 한다. urllib 은 응답을 만든 뒤 소켓 객체를 '닫힘'으로 표시해 두지만 핸들은 파일 객체가 쥐고 있어 살아 있다.
    소켓이 없는 것(시험의 가짜)만 바로 닫는다."""
    sock = _sock_of(response)
    if sock is None:
        try:
            response.close()
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # 이미 끊김
    try:
        fd = sock.detach()  # 객체는 -1 이 된다 — 읽던 쪽이 다시 시도하면 오류로 멈춘다
        if fd >= 0:
            socket.close(fd)
    except OSError:
        pass


def _msg(kind: str, **body: Any) -> str:
    return json.dumps({"t": kind, **body}, ensure_ascii=False, separators=(",", ":"))


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def media_kind(url: Any) -> Optional[str]:
    """번호를 줄 수 있는 같은 출처 상대 주소인가 — 'media' · 'thumb' · None(그 밖 — 절대 주소는 그대로 두고 나머지는 버린다)."""
    if not isinstance(url, str) or len(url) > 4096 or "\\" in url or ".." in urllib.parse.unquote(url):
        return None
    if url.startswith("/media/") and "?" not in url and "#" not in url:
        return "media"
    if url.startswith("/api/media-thumb?"):
        query = urllib.parse.parse_qs(url.split("?", 1)[1], keep_blank_values=True)
        src = query.get("src", [""])
        if set(query) <= {"src", "w"} and len(src) == 1 and media_kind(src[0]) == "media":
            return "thumb"
    return None


def _absolute(url: Any) -> bool:
    return isinstance(url, str) and url.startswith(("https://", "http://")) and len(url) <= 4096


class Hub:
    """허브의 클린 피드 — 세션 하나 · 인스턴스 id · 끝난 세션 사유(32) · 탭 순번(32). open·close·정리는 잠금 하나로 하나씩."""

    def __init__(self, windows: Optional[FeedWindows] = None, *, clock=time.monotonic) -> None:
        self.instance = secrets.token_hex(8)
        self.windows = windows or FeedWindows()
        self.windows.listener = self._from_window
        self.clock = clock
        self.session: Optional[Session] = None
        self.ended: "OrderedDict[str, str]" = OrderedDict()
        self.clients: "OrderedDict[str, int]" = OrderedDict()
        self.generation = 0
        self.lock = asyncio.Lock()
        self._conn_ids = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._watch: Optional[asyncio.Task] = None
        self.standby: Optional[Standby] = None  # 대기 창의 기록(한 창뿐)

    # ── 상태 ────────────────────────────────────────────────────────────────────────────────────
    def live(self, session_id: str, key: Optional[str] = None) -> Optional[Session]:
        sess = self.session
        if sess is None or sess.ended or sess.id != session_id:
            return None
        if key is not None and not secrets.compare_digest(sess.key, key):
            return None
        return sess

    def describe(self, session_id: Optional[str]) -> dict:
        if not session_id:
            return {"session": None, "ended_reason": None}
        if self.live(session_id):
            return {"session": "live", "ended_reason": None}
        if session_id in self.ended:
            return {"session": "ended", "ended_reason": self.ended[session_id]}
        return {"session": "unknown", "ended_reason": None}

    def _remember(self, table: OrderedDict, key: str, value: Any) -> None:
        table[key] = value
        table.move_to_end(key)
        while len(table) > KEEP:
            table.popitem(last=False)

    # ── 계정 ────────────────────────────────────────────────────────────────────────────────────
    def epoch_ok(self, sess: Session) -> bool:
        return active_account.account_epoch() == sess.identity.epoch

    def identity_ok(self, sess: Session) -> bool:
        """세대값 + 모드별 식별값(+ 인증 켬이면 토큰이 아직 유효한가 — 미들웨어와 같은 판정). 동기 — 스레드에서 부른다."""
        if not self.epoch_ok(sess):
            return False
        if not config.AUTH_ENABLED:
            return active_account.capture_account_pin() == sess.identity.pin
        token = sess.identity.token
        if not token or token_sha(token) != sess.identity.token_sha:
            return False
        from .. import repo
        from . import auth as auth_svc

        email = auth_svc.verify_token(token)
        if not email or email != sess.identity.email:
            return False
        acc = repo.get_account(email)
        if not acc or acc.get("status") != "approved":
            return False
        stamp = acc.get("password_changed_at")
        return not stamp or auth_svc.token_password_stamp(token) == stamp

    # ── open · close · 끝 ────────────────────────────────────────────────────────────────────────
    async def open(self, *, screen: Screen, takeover: bool, client: str, seq: int, origin: str, identity: Identity,
                   proxying: bool, browser: tuple[str, str]) -> dict:
        self._loop = asyncio.get_running_loop()
        async with self.lock:
            last = self.clients.get(client)
            if last is not None and seq <= last:  # 같은 탭의 옛 선택 — 새 선택을 이기지 못한다(밀어내지 않음)
                raise HTTPException(409, "stale")
            self._remember(self.clients, client, seq)
            current = self.session if self.session and not self.session.ended else None
            if current and not takeover:
                raise HTTPException(409, "busy")
            if current:
                self.end(current, "taken")  # adopted 면 그 창은 여기서 대기 창으로(release 가 아래 open 보다 먼저 큐에 들어간다)
            standby = await self._reusable(origin, browser, identity)
            self.generation += 1
            sess = Session(id=secrets.token_hex(16), key=secrets.token_hex(24), origin=origin, generation=self.generation,
                           identity=identity, proxying=proxying, created=self.clock(), browser=browser)
            url = f"{origin}/?cleanfeed={sess.id}&key={sess.key}"
            try:
                done = await asyncio.wait_for(asyncio.wrap_future(self.windows.open(
                    session=sess.id, url=url, screen=screen, browser=browser, reuse=standby.release if standby else None)), OPEN_TIMEOUT)
            except OpenError as exc:
                self._remember(self.ended, sess.id, "open-failed")
                self._drop_standby(kill=True)  # 띄우는 길이었으면 창 스레드가 이미 끝냈다 — 아니면(다시 쓰다 모니터 없음) 여기서
                raise HTTPException(409, exc.code) from exc
            except asyncio.TimeoutError as exc:
                self._remember(self.ended, sess.id, "open-failed")
                self.windows.close(sess.id)
                self._drop_standby(kill=True)
                raise HTTPException(504, "window-timeout") from exc
            except asyncio.CancelledError:  # 요청이 끊겼다 — 창 스레드는 띄우기·붙이기를 계속한다 · 그 뒤에 닫기를 줄 세운다(등록 안 된 창이 남지 않게)
                self._remember(self.ended, sess.id, "open-failed")
                self.windows.close(sess.id)
                self._drop_standby(kill=True)
                raise
            # 등록 → (다시 쓴 창이면 assign 보내기 예약) → arm → 응답 — 사이에 await 없음(arm 전엔 창 스레드가 이 창의 사건을 내지 않는다)
            reused = bool(done.get("reused"))
            sess.reused, sess.shown, sess.created = reused, not reused, self.clock()  # 다시 쓴 창은 새 피드 ready 전엔 안 보인다 · 기한은 등록부터
            self.session = sess
            if reused and standby is not None and self.standby is standby:
                standby.state, standby.session = "assigned", sess.id
                standby.assign = _msg("assign", session=sess.id, key=sess.key)
                self._send_assign(standby)
            else:
                self._drop_standby(kill=False)  # 띄우는 길은 대기 창을 이미 끝냈다(_close_now)
            self.windows.arm(sess.id)
            self._ensure_watcher()
            return {"session": sess.id, "key": sess.key, "instance": self.instance, "reused": reused}

    # ── 대기 창 ──────────────────────────────────────────────────────────────────────────────────
    def _standby_matches(self, st: Standby, origin: str, browser: tuple, identity: Identity) -> bool:
        return (st.origin == origin and st.browser == browser and st.identity == identity
                and st.identity.epoch == active_account.account_epoch())

    async def _reusable(self, origin: str, browser: tuple, identity: Identity) -> Optional[Standby]:
        """다시 쓸 대기 기록 — 같은 출처·브라우저·계정(Identity·지금 세대값). reserved 면 그 release 결과를 기다린 뒤 다시 본다
        (모니터를 바꿀 때 새 open 이 앞 close 보다 먼저 와 같은 open 안에서 taken 으로 남긴 경우). 기다림은 release 를 취소하지 않는다(shield)."""
        st = self.standby
        if st is None or st.state not in ("reserved", "ready") or not self._standby_matches(st, origin, browser, identity):
            return None
        if st.lost and st.conn is None:  # assign 을 받을 연결이 없다 — 다시 쓰면 3초 뒤 실패만 한다(새로 띄운다)
            return None
        if st.state == "reserved":
            try:
                ok = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(st.future)), RELEASE_WAIT)
            except Exception:  # noqa: BLE001 — 시한·실패 — 다시 쓰지 않고 새로 띄운다
                return None
            self._apply_release(st.release, bool(ok))
        if self.standby is not st or st.state != "ready" or not self._standby_matches(st, origin, browser, identity) or (st.lost and st.conn is None):
            return None
        return st

    def _apply_release(self, release: str, ok: bool) -> None:
        """release 결과 반영 — 지금 기록이 그 id 이고 reserved 일 때만(콜백과 open 이 둘 다 불러도 한 번, 버린·쓴 기록을 늦은 결과가 못 되살림)."""
        st = self.standby
        if st is None or st.release != release or st.state != "reserved":
            return
        if ok:
            st.state = "ready"
        else:
            self._drop_standby(kill=False)  # 창 스레드가 이미 창을 끝냈다

    def _release_done(self, release: str, future: Any) -> None:
        try:
            ok = bool(future.result())
        except BaseException:  # noqa: BLE001 — 취소·오류 = 실패
            ok = False
        self._apply_release(release, ok)

    def _drop_standby(self, kill: bool) -> None:
        st = self.standby
        if st is None:
            return
        self.standby = None
        st.state = "dropped"
        if st.conn is not None:
            self._close_conn(st.conn, 4404)
        if kill:
            self.windows.close_standby(st.release)  # 그 release id 의 대기 창일 때만 끝낸다(다른 창은 안 건드림)

    def standby_for(self, token: str, origin: str) -> Optional[Standby]:
        """대기 WS accept 전 검사 — 기록 있음·reserved/ready/assigned(보내기 전)·토큰(상수 시간)·출처·세대값."""
        st = self.standby
        if st is None or st.state not in ("reserved", "ready", "assigned") or st.sending is not None:
            return None
        if not token or not secrets.compare_digest(st.token, token) or origin != st.origin:
            return None
        if st.identity.epoch != active_account.account_epoch():
            return None
        return st

    async def serve_standby(self, ws: WebSocket, st: Standby, protocol: str) -> None:
        self._loop = asyncio.get_running_loop()
        await ws.accept(subprotocol=protocol)
        if self.standby is not st or st.state not in ("reserved", "ready", "assigned") or st.sending is not None:
            await self._safe_close(ws, 4404)  # 검사와 accept 사이에 버려졌거나 이미 보냈다
            return
        self._conn_ids += 1
        conn = _Conn(ws, "standby", self._conn_ids)
        old, st.conn, st.lost = st.conn, conn, False
        if st.lost_timer is not None:
            st.lost_timer.cancel()
            st.lost_timer = None
        if old is not None:
            self._close_conn(old, 4000)
        self._send_assign(st)
        try:
            while not conn.closed:
                await ws.receive_text()  # 피드가 보낼 글은 없다 — 끊김만 본다
        except Exception:  # noqa: BLE001 — 끊김
            pass
        finally:
            conn.closed = True
            if st.conn is conn:
                st.conn, st.lost = None, True
                st.lost_timer = asyncio.get_running_loop().call_later(STANDBY_LOST_WAIT, self._standby_lost, st)

    def _standby_lost(self, st: Standby) -> None:
        """끊긴 대기 연결 뒤 틈 안에 새 연결이 없고 아직 붙이지 않은 기록이면 버리고 창을 끝낸다(붙인 기록은 ready 기한이 끝낸다)."""
        if self.standby is st and st.conn is None and st.state in ("reserved", "ready"):
            self._drop_standby(kill=True)

    def _send_assign(self, st: Standby) -> None:
        """assign 을 한 번 — 보낼 연결을 하나로 정한 뒤 별도 작업에서 시한 안에 보낸다. 보낸 뒤 같은 기록·연결이면 delivered(토큰 소모·기록 끝).
        보내는 중 바뀌거나 실패해도 다시 보내지 않는다 — 그 세션은 ready 기한(3초)으로 끝난다."""
        conn = st.conn
        if st.state != "assigned" or st.assign is None or st.sending is not None or conn is None or conn.closed:
            return
        st.sending = conn
        text = st.assign

        async def send() -> None:
            try:
                await asyncio.wait_for(conn.ws.send_text(text), SEND_TIMEOUT)
                ok = True
            except Exception:  # noqa: BLE001
                ok = False
            if self.standby is not st or st.sending is not conn:
                return
            if ok:
                st.state = "delivered"
                self.standby = None
                asyncio.get_running_loop().call_later(1.0, self._close_conn, conn)  # 피드가 닫는다 — 안 닫으면
            else:
                self._drop_standby(kill=False)

        asyncio.ensure_future(send())

    def _ensure_watcher(self) -> None:
        if self._watch is None or self._watch.done():
            self._watch = asyncio.create_task(self._watcher())

    async def close(self, session_id: str, key: str) -> bool:
        async with self.lock:
            sess = self.live(session_id, key)
            if sess is None:
                return False  # 옛 세대·끝난 세션의 close 는 무시
            self.end(sess, "closed")
            return True

    def end(self, sess: Session, reason: str) -> None:
        """영구 종료 — 사유를 남기고, 연결에 알린 뒤 닫고, 진행 중 스트림을 끊고, 창을 닫는다(사람이 닫은 창은 이미 없다).
        closed·taken·main-gone 으로 끝난 adopted 세션의 창은 끝내지 않고 대기 창으로 남긴다 — 그 토큰은 그 세션의 피드 연결에만 간다."""
        if sess.ended:
            return
        sess.ended = reason
        self._remember(self.ended, sess.id, reason)
        if self.standby is not None and self.standby.session == sess.id:  # 붙여 놓고 아직 보내지 못한 기록 — 그 창은 아래에서 끝난다
            self._drop_standby(kill=False)
        st = None
        # 피드 연결이 지금 없으면 토큰을 받을 곳이 없다 — 남겨도 다시 쓸 때 3초 뒤 실패만 한다(Claude 합의 P2)
        if reason in KEEP_REASONS and sess.adopted and "feed" in sess.conns:
            self._drop_standby(kill=True)  # 한 허브에 창 하나 — 남은 옛 기록은 버린다(그 release id 의 창일 때만 끝낸다)
            st = Standby(release=secrets.token_hex(8), token=secrets.token_hex(24), origin=sess.origin, browser=sess.browser, identity=sess.identity)
            self.standby = st
        for conn in list(sess.conns.values()):  # 연결이 있으면 이벤트 루프 안이다(WS 가 그 루프에서 돈다)
            body: dict = {"reason": reason}
            if st is not None and conn.role == "feed":
                body["standby"] = st.token
            conn.put(_msg("taken" if reason == "taken" else "closed", **body))
            asyncio.get_running_loop().call_later(0.2, self._close_conn, conn)
        for upstream in list(sess.streams):
            _abort(upstream)  # 이벤트 루프를 막지 않고 읽는 스레드를 깨운다 — 닫기는 자리를 비울 때
        sess.streams.clear()
        if reason == "user-closed":
            return
        if st is None:
            self.windows.close(sess.id)
            return
        # 동기로 큐에 — 뒤따르는 open 보다 먼저 창 스레드가 숨긴다. 결과 반영은 루프에서(허브 잠금을 쓰지 않음)
        st.future = self.windows.release(sess.id, st.release)
        st.future.add_done_callback(lambda done, release=st.release: self._soon(self._release_done, release, done))
        self._ensure_watcher()

    def _soon(self, fn: Any, *args: Any) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(fn, *args)

    def _close_conn(self, conn: _Conn, code: int = 1000) -> None:
        if conn.closed:
            return
        conn.closed = True
        conn.wake.set()
        asyncio.ensure_future(self._safe_close(conn.ws, code))

    @staticmethod
    async def _safe_close(ws: Any, code: int) -> None:
        try:
            await ws.close(code=code)
        except Exception:  # noqa: BLE001 — 이미 닫힘
            pass

    async def _watcher(self) -> None:
        """1초마다 check — 지금 세션도 대기 기록도 없으면 멈춘다(다음 open·대기가 다시 띄운다)."""
        while True:
            await asyncio.sleep(1.0)
            if (self.session is None or self.session.ended) and self.standby is None:
                return
            await self.check()

    async def check(self) -> None:
        """1초 점검 한 번 — 대기 기록의 세대값 · 다시 쓴 창의 ready 기한(main-gone 보다 먼저) · 계정(세대값·식별값·토큰) · main 3초 없음."""
        st = self.standby
        if st is not None and st.identity.epoch != active_account.account_epoch():
            self._drop_standby(kill=True)  # 계정이 바뀌었다 — 대기 창을 다시 쓰지 않는다
        sess = self.session
        if sess is None or sess.ended:
            return
        if sess.reused and not sess.adopted and self.clock() - sess.created > FEED_READY_WAIT:
            self.end(sess, "window-not-found")  # 숨긴 채 끝냄 — adopted 아님이라 남기지 않는다
            return
        if not await asyncio.to_thread(self.identity_ok, sess):
            self.end(sess, "account")
            return
        if "main" not in sess.conns:
            since = sess.main_lost if sess.main_lost is not None else sess.created
            if self.clock() - since > MAIN_GRACE:
                self.end(sess, "main-gone")

    # ── 창 사건(전용 스레드 → 이벤트 루프) ─────────────────────────────────────────────────────────
    def _from_window(self, kind: str, session_id: str) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self.on_window, kind, session_id)

    def on_window(self, kind: str, session_id: str) -> None:
        if kind == "standby-ended":  # 대기 창이 10분 지났거나 죽었다 — 그 release id 의 기록일 때만(창 스레드가 이미 끝냈다)
            if self.standby is not None and self.standby.release == session_id:
                self._drop_standby(kill=False)
            return
        sess = self.live(session_id)
        if sess is None:  # 끝난 세션에 늦게 온 결과는 버린다
            return
        if kind == "closed":
            self.end(sess, "user-closed")
        elif kind in LATE_OPEN_FAILURES:  # 2단계 실패 — 창 스레드가 이미 창을 놓았다
            self.end(sess, kind)
        elif kind == "adopted":
            if not sess.reused:  # 다시 쓴 창은 피드의 ready 가 adopted
                sess.adopted = True
        elif kind == "focus-lost":
            main = sess.conns.get("main")
            if main is not None:
                main.put(_msg("focus-lost"))
            else:
                sess.focus_lost = True  # main 이 붙을 때 한 번
        elif kind == "hidden":
            sess.shown = False
        elif kind == "visible":
            sess.shown = True
            sess.sync += 1
            feed = sess.conns.get("feed")
            if feed:
                feed.put(_msg("visible", sync=sess.sync))
                self._replay(sess, feed)
            main = sess.conns.get("main")
            if main:
                main.put(_msg("resync", sync=sess.sync))

    def _replay(self, sess: Session, feed: _Conn) -> None:
        if sess.scene:
            feed.put(sess.scene, "scene")
        if sess.sample:
            feed.put(sess.sample, "clock")

    # ── WS ─────────────────────────────────────────────────────────────────────────────────────
    async def serve_ws(self, ws: WebSocket, sess: Session, role: str) -> None:
        """accept 전 검사는 라우터가 끝냈다. 같은 역할의 옛 연결은 끊는다(옛 정리는 지금 연결 id 가 자기일 때만)."""
        self._loop = asyncio.get_running_loop()
        await ws.accept()
        if sess.ended:  # 검사와 accept 사이에 끝났다 — end() 가 모르는 연결로 남기지 않는다
            await self._safe_close(ws, 4404)
            return
        self._conn_ids += 1
        conn = _Conn(ws, role, self._conn_ids)
        old = sess.conns.get(role)
        sess.conns[role] = conn
        if old:
            self._close_conn(old, 4000)
        if role == "main":
            sess.main_seen = True
            sess.main_lost = None
            if self.session is sess:  # 지금 세션의 연결만 active 를 바꾼다(옛 세션이 새 세션 active 를 덮지 않게)
                self.windows.set_active(sess.id, False)  # 새 main 의 첫 active 전까지 — 옛 연결의 active 를 이어 쓰지 않는다
            conn.put(_msg("resync", sync=sess.sync))  # 새 main 연결마다 현재 번호 먼저 — 놓친 resync 를 되살린다
            if sess.focus_lost:  # 붙기 전에 초점 되돌림이 실패했다 — 한 번
                sess.focus_lost = False
                conn.put(_msg("focus-lost"))
        else:
            if sess.shown:  # 끊긴 사이 보임으로 바뀌었을 수 있다 — 지금 번호의 visible 부터(피드의 숨김 상태가 풀린다)
                conn.put(_msg("visible", sync=sess.sync))
            self._replay(sess, conn)
        conn.sender = asyncio.create_task(self._sender(sess, conn))
        try:
            while not conn.closed:  # 세션이 끝나도 end() 가 알림을 보낼 틈(0.2초)을 준 뒤 닫는다 — 그사이 받은 글은 _receive 가 버린다
                text = await ws.receive_text()
                self._receive(sess, conn, text)
        except Exception:  # noqa: BLE001 — 끊김
            pass
        finally:
            conn.closed = True
            conn.wake.set()
            if sess.conns.get(role) is conn:
                del sess.conns[role]
                if role == "main":
                    sess.main_lost = self.clock()
                    if self.session is sess and not sess.ended:  # 옛 세션 main 의 늦은 정리가 새 세션 active 를 덮지 않게
                        self.windows.set_active(sess.id, False)
            if conn.sender:
                conn.sender.cancel()

    async def _sender(self, sess: Session, conn: _Conn) -> None:
        try:
            while not conn.closed:
                await conn.wake.wait()
                conn.wake.clear()
                while not conn.closed:
                    if conn.ctrl:
                        text = conn.ctrl.popleft()
                    elif conn.latest:
                        kind = next(k for k in ("scene", "clock", "active") if k in conn.latest)
                        text = conn.latest.pop(kind)
                    elif conn.keys:
                        text = conn.keys.popleft()
                    else:
                        break
                    try:
                        await asyncio.wait_for(conn.ws.send_text(text), SEND_TIMEOUT)
                    except Exception:  # noqa: BLE001 — 보내기 시한·끊김 → 그 연결을 닫는다(앱은 다시 붙는다)
                        self._close_conn(conn, 1011)
                        return
        except asyncio.CancelledError:
            pass

    def _receive(self, sess: Session, conn: _Conn, text: str) -> None:
        # 교체된 옛 연결이 기다리던 글(이미 받아 둔 것)은 지금 연결의 상태를 못 바꾼다
        if sess.ended or conn.closed or sess.conns.get(conn.role) is not conn or len(text) > SCENE_MAX:
            return
        try:
            body = json.loads(text)
        except ValueError:
            return
        kind = body.get("t") if isinstance(body, dict) else None
        if kind not in _KINDS[conn.role] or (kind != "scene" and len(text) > OTHER_MAX):
            return  # 그 역할이 보낼 수 없는 글(허브 글 위조 포함)은 버린다
        if not self.epoch_ok(sess):
            self.end(sess, "account")
            return
        feed, main = sess.conns.get("feed"), sess.conns.get("main")
        if kind == "scene":
            rewritten = self._scene_for_feed(sess, body)
            if rewritten is None:
                return
            sess.scene, sess.scene_rev = rewritten, int(body["rev"])
            if sess.sample is not None and sess.sample_rev < sess.scene_rev:
                sess.sample = None  # 옛 장면의 표본
            if feed:
                feed.put(rewritten, "scene")
        elif kind == "clock":
            sample = self._clock_sample(body)
            if sample is None:
                return
            text = _msg("clock", **sample)
            # 지금 장면이나 아직 안 온 다음 장면의 표본 — 앱은 rev 를 올린 뒤 장면을 0.1초 늦게 보내 표본이 먼저 올 수 있다(멈춘 화면은 그 뒤 표본이
            #  더 없다). 늦게 붙은 피드에 장면 → 표본으로 준다(리뷰 10차)
            if sample["rev"] >= sess.scene_rev:
                sess.sample, sess.sample_rev = text, sample["rev"]
            if feed:
                feed.put(text, "clock")
        elif kind == "active":
            if self.session is sess:
                self.windows.set_active(sess.id, body.get("active") is True)
        elif kind == "ready":
            # 다시 쓴 창의 새 피드가 화면을 초기화하고 붙었다 — 기한 안이면 adopted · 창을 보여도 된다(보임은 지금 규칙 — visible 사건이 shown·sync)
            if sess.reused and not sess.adopted:
                if self.clock() - sess.created > FEED_READY_WAIT:
                    self.end(sess, "window-not-found")
                    return
                sess.adopted = True
                self.windows.ready(sess.id)
        elif kind == "key":
            event = {name: body.get(name) for name in _KEY_FIELDS}
            if not isinstance(event["key"], str) or not isinstance(event["code"], str) or len(event["key"]) > 32 or len(event["code"]) > 32:
                return
            for name in _KEY_FIELDS[2:]:
                event[name] = event[name] is True
            if main:
                if len(main.keys) >= KEY_QUEUE:
                    main.put(_msg("error", reason="key-overflow"))
                else:
                    main.keys.append(_msg("key", **event))
                    main.wake.set()
        elif kind == "error" and main:
            main.put(_msg("error", reason="feed", detail=str(body.get("detail") or "")[:200]))

    @staticmethod
    def _clock_sample(body: dict) -> Optional[dict]:
        # 글의 't' 는 종류('clock') — 시각은 'time'
        time_, at, rate, limit = _num(body.get("time")), _num(body.get("at")), _num(body.get("rate")), _num(body.get("limit"))
        rev, sync = body.get("rev"), body.get("sync", 0)
        if None in (time_, at, rate, limit) or not isinstance(rev, int) or isinstance(rev, bool) or not isinstance(sync, int) or isinstance(sync, bool):
            return None
        return {"rev": rev, "time": time_, "at": at, "playing": body.get("playing") is True, "moving": body.get("moving") is True,
                "rate": rate, "limit": limit, "sync": sync}

    def _scene_for_feed(self, sess: Session, body: dict) -> Optional[str]:
        rev, sources = body.get("rev"), body.get("sources")
        if not isinstance(rev, int) or isinstance(rev, bool) or rev < sess.scene_rev or not isinstance(sources, dict):
            return None
        out: dict[str, dict] = {}
        for clip_key, source in sources.items():
            if not isinstance(clip_key, str) or not isinstance(source, dict):
                continue
            item = {"state": source.get("state"), "type": source.get("type")}
            for name in ("url", "thumb"):
                item[name] = self._feed_url(sess, source.get(name))
            out[clip_key] = item
        return _msg("scene", rev=rev, layout=body.get("layout"), doc=body.get("doc"), sources=out)

    def _feed_url(self, sess: Session, url: Any) -> Optional[str]:
        if media_kind(url):
            number = sess.media_ids.get(url)
            if number is None:
                number = sess.next_media
                sess.next_media += 1  # 버린 번호를 다른 원본에 주지 않는다
                sess.media[number], sess.media_ids[url] = url, number
            return f"{MEDIA_PATH}{sess.id}/{number}?key={sess.key}"
        return url if _absolute(url) else None

    # ── 미디어 ──────────────────────────────────────────────────────────────────────────────────
    async def media(self, request: Request, session_id: str, number: int, key: str) -> Response:
        sess = self.live(session_id, key)
        if sess is None:
            raise HTTPException(404, "세션이 없습니다", headers=NO_STORE)
        if not await asyncio.to_thread(self.identity_ok, sess):
            self.end(sess, "account")
            raise HTTPException(409, "account", headers=NO_STORE)
        url = sess.media.get(number)
        if url is None:
            raise HTTPException(404, "번호가 없습니다", headers=NO_STORE)
        if sess.in_flight >= MEDIA_SLOTS:
            raise HTTPException(503, "busy", headers=NO_STORE)
        sess.in_flight += 1
        slot = _Slot(sess)
        try:
            response = await self._media_response(request, sess, url, slot)
            if sess.ended:  # 기다리는 사이(파일 확인·중계 연결) 끝났다 — 중계 응답은 아래 자리 비우기가 닫는다
                raise HTTPException(404, "세션이 끝났습니다", headers=NO_STORE)
        except BaseException:
            slot.release()
            raise
        response.headers["Cache-Control"] = "no-store"
        return _SessionBound(response, sess, slot)  # 보내는 동안 끝나면 끊는다 · 끝나면(어느 길로든) 자리를 한 번 비운다

    async def _media_response(self, request: Request, sess: Session, url: str, slot: "_Slot") -> Response:
        tools = _media_tools()
        kind = media_kind(url)
        if kind == "media":
            target = tools.local_target(url)
            if target is not None and await asyncio.to_thread(target.is_file):
                return FileResponse(target, headers=dict(NO_STORE))
        else:
            query = urllib.parse.parse_qs(url.split("?", 1)[1])
            src = query["src"][0]
            target = tools.local_target(src)
            if target is not None and await asyncio.to_thread(target.is_file):
                width = query.get("w", ["512"])[0]
                return await tools.thumb(src=src, w=max(64, min(1024, int(width) if width.isdigit() else 512)))
        if not sess.proxying:
            raise HTTPException(404, "파일 없음", headers=NO_STORE)
        return await self._relay(request, sess, url, slot)

    async def _relay(self, request: Request, sess: Session, path: str, slot: "_Slot") -> Response:
        """이 PC 에 없는 서버 보존본 — 세션 계정(pin) 안에서 연결을 다시 읽어 원래 경로로(Range·조건부 헤더 그대로)."""
        tools = _media_tools()

        def prepare() -> urllib.request.Request:
            with active_account.pinned_account_scope(sess.identity.pin):
                base, tok = tools.base_url(), tools.token()
            req = urllib.request.Request(base + path, method=request.method if request.method == "HEAD" else "GET")
            if tok:
                req.add_header("Authorization", f"Bearer {tok}")
            for name in ("Range", "If-Range", "If-None-Match", "If-Modified-Since"):
                value = request.headers.get(name)
                if value:
                    req.add_header(name, value)
            req.add_header("Accept-Encoding", "identity")
            return req

        req = await asyncio.to_thread(prepare)

        def headers_of(source: Any) -> dict[str, str]:
            out = dict(NO_STORE)
            for name in _RELAY_HEADERS:
                value = source.get(name) if source else None
                if value:
                    out[name] = value
            return out

        def connect() -> Any:
            try:
                return tools.open(req, timeout=30)
            except urllib.error.HTTPError as exc:  # 오류도 응답이다 — 취소된 뒤 늦게 와도 닫을 수 있게 값으로 돌려준다
                return exc

        work = asyncio.get_running_loop().run_in_executor(None, connect)
        try:
            upstream = await asyncio.shield(work)  # 취소돼도 연결 작업은 돈다 — 그 끝을 아래 콜백이 맡는다
        except asyncio.CancelledError:
            slot.hold()
            work.add_done_callback(lambda done: self._late_open(done, slot))
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HTTPException(502, f"공유 서버 연결 실패: {exc}", headers=NO_STORE) from exc
        if sess.ended:  # 연결하는 사이 끝났다 — end() 는 이 응답을 모른다 · 아무도 안 읽었으니 여기서 닫는다
            _quiet_close(upstream)
            raise HTTPException(404, "세션이 끝났습니다", headers=NO_STORE)
        # 304·416·오류(HTTPError)도 정상 응답과 같은 길 — 상태·헤더를 그대로, 본문은 아래 스트림으로(받는 쪽 끊김 감시·세션 종료 끊기를 같이 받는다)
        error = isinstance(upstream, urllib.error.HTTPError)
        status, source = (upstream.code, upstream.headers) if error else (upstream.status, upstream.headers)
        media_type = source.get_content_type() if source else "application/octet-stream"
        if request.method == "HEAD" or status == 304:  # 본문 없음
            _quiet_close(upstream)
            return Response(status_code=status, media_type=media_type, headers=headers_of(source))
        sock = _sock_of(upstream)
        if sock is not None:
            try:
                sock.settimeout(60)  # 읽기 시한
            except OSError:
                pass
        sess.streams.add(upstream)  # 세션이 끝나면 end() 가 소켓을 끊는다 — 읽던 스레드는 오류로 멈춘다
        slot.upstream = upstream

        def chunks():
            try:
                while not sess.ended and not slot.aborted:
                    try:
                        chunk = upstream.read(1024 * 1024)
                    except Exception:  # noqa: BLE001
                        if sess.ended or slot.aborted:  # end() 나 받는 쪽의 끊김이 소켓을 끊었다
                            break
                        raise
                    if not chunk:
                        break
                    yield chunk
            finally:
                slot.release()  # 읽기를 끝낸 이 스레드에서 응답을 닫는다

        return StreamingResponse(chunks(), status_code=status, media_type=media_type, headers=headers_of(source))

    @staticmethod
    def _late_open(work: Any, slot: "_Slot") -> None:
        """취소된 미디어 요청의 연결 작업이 끝났다 — 아무도 읽지 않은 응답을 닫고(루프 위 — 읽는 스레드가 없다) 쥐고 있던 자리를 비운다."""
        try:
            response = work.result()
        except BaseException:  # noqa: BLE001 — 연결 실패·취소
            response = None
        if response is not None:
            _quiet_close(response)
        slot.unhold()

    async def shutdown(self) -> None:
        sess = self.session
        if sess and not sess.ended:
            self.end(sess, "hub-stopped")
        self._drop_standby(kill=False)  # 창 스레드의 stop 이 대기 창까지 끝낸다
        try:
            await asyncio.wait_for(asyncio.to_thread(self.windows.stop), 5)
        except Exception:  # noqa: BLE001 — 끝나는 허브 — 크롬은 Job 이 끝낸다
            pass


_HUB: Optional[Hub] = None


def hub() -> Hub:
    global _HUB
    if _HUB is None:
        _HUB = Hub()
    return _HUB


def reset_for_tests(new: Optional[Hub] = None) -> None:
    global _HUB
    _HUB = new
