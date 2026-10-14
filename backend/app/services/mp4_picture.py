"""MP4 의 그림 트랙 길이(프레임 수) — 파일의 머리 정보(moov)만 읽는다.

편집 탭은 클립 길이를 브라우저의 video.duration 으로 쟀는데, 그것은 파일 전체(소리 포함) 길이다. Seedance 원본은 소리가 그림보다
약 1프레임 길어서(그림 97f = 4.042s, 소리 4.087s) 클립이 그림보다 길게 적혔고, Resolve 로 보낼 때 막히거나 끝 1프레임이 비었다
(2026-10-14). Resolve 는 그림 트랙의 프레임을 본다 — 여기서 같은 것을 읽는다.

받는 것은 좁게 둔다(Codex 설계 검토): 그림 트랙이 **하나**, 프레임 간격이 **고른**(stts 가 한 간격) 일반 MP4, 편집 목록은 없거나 한 줄.
분할 MP4(moof · mvex)·여러 그림 트랙·간격이 고르지 않은 것·잘린 상자는 PictureError — 부르는 쪽은 예전 방식으로 물러난다.
"""
from __future__ import annotations

import re
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable

MAX_MOOV = 16 * 1024 * 1024  # moov 를 이보다 크게 읽지 않는다
MAX_TOP_BOXES = 64  # 최상위 상자를 이보다 많이 넘기지 않는다
MAX_CHILDREN = 4096  # 한 상자 안의 자식 상자 상한


class PictureError(Exception):
    """그림 길이를 확정하지 못했다 — 부르는 쪽은 다른 길로 잰다."""


@dataclass(frozen=True)
class Picture:
    frames: int
    fps: float

    @property
    def seconds(self) -> float:
        return self.frames / self.fps


def _header(buf: bytes, pos: int, end: int) -> tuple[str, int, int]:
    """(종류, 본문 시작, 상자 끝). 32/64비트 크기 · 크기 0(끝까지) · 잘린 머리 · 부모 밖으로 나가는 크기를 거른다."""
    if end - pos < 8:
        raise PictureError("상자 머리가 잘렸다")
    size, kind = struct.unpack_from(">I4s", buf, pos)
    head = 8
    if size == 1:
        if end - pos < 16:
            raise PictureError("상자 머리가 잘렸다")
        size = struct.unpack_from(">Q", buf, pos + 8)[0]
        head = 16
    elif size == 0:
        size = end - pos
    if size < head or pos + size > end:
        raise PictureError("상자 크기가 맞지 않는다")
    return kind.decode("latin-1"), pos + head, pos + size


def _children(buf: bytes, start: int, end: int):
    pos, count = start, 0
    while pos < end:
        kind, body, stop = _header(buf, pos, end)
        yield kind, body, stop
        pos = stop
        count += 1
        if count > MAX_CHILDREN:
            raise PictureError("상자가 너무 많다")


def _one(buf: bytes, start: int, end: int, kind: str) -> tuple[int, int]:
    found = [(body, stop) for name, body, stop in _children(buf, start, end) if name == kind]
    if len(found) != 1:
        raise PictureError(f"{kind} 가 하나가 아니다")
    return found[0]


def _full(buf: bytes, body: int, stop: int, need: int) -> int:
    """full box 의 버전(본문 첫 바이트) — 읽을 자리가 상자 안에 있는지도 본다."""
    if stop - body < need:
        raise PictureError("상자 본문이 짧다")
    return buf[body]


def picture_from_moov(moov: bytes) -> Picture:
    """moov 의 본문(머리 뒤)에서 그림 트랙의 프레임 수와 fps."""
    end = len(moov)
    names = [name for name, _b, _s in _children(moov, 0, end)]
    if "mvex" in names:
        raise PictureError("분할 MP4 다")
    videos = []
    for name, start, stop in _children(moov, 0, end):
        if name != "trak":
            continue
        mdia = _one(moov, start, stop, "mdia")
        hdlr = _one(moov, *mdia, "hdlr")
        _full(moov, *hdlr, 12)
        if moov[hdlr[0] + 8: hdlr[0] + 12] == b"vide":
            videos.append((start, stop, mdia))
    if len(videos) != 1:
        raise PictureError("그림 트랙이 하나가 아니다")
    start, stop, mdia = videos[0]

    mdhd = _one(moov, *mdia, "mdhd")
    if _full(moov, *mdhd, 4) == 1:
        _full(moov, *mdhd, 32)
        timescale = struct.unpack_from(">I", moov, mdhd[0] + 20)[0]
    else:
        _full(moov, *mdhd, 20)
        timescale = struct.unpack_from(">I", moov, mdhd[0] + 12)[0]
    stbl = _one(moov, *_one(moov, *mdia, "minf"), "stbl")
    stsz = _one(moov, *stbl, "stsz")
    _full(moov, *stsz, 12)
    frames = struct.unpack_from(">I", moov, stsz[0] + 8)[0]
    stts = _one(moov, *stbl, "stts")
    _full(moov, *stts, 8)
    entries = struct.unpack_from(">I", moov, stts[0] + 4)[0]
    _full(moov, *stts, 8 + 8 * entries)
    pairs = [struct.unpack_from(">II", moov, stts[0] + 8 + 8 * i) for i in range(entries)]
    deltas = {delta for count, delta in pairs if count}
    if timescale <= 0 or frames <= 0 or len(deltas) != 1 or sum(count for count, _d in pairs) != frames:
        raise PictureError("프레임 간격이 고르지 않거나 비었다")
    delta = deltas.pop()
    if delta <= 0:
        raise PictureError("프레임 간격이 0 이다")

    edts = [(b, s) for name, b, s in _children(moov, start, stop) if name == "edts"]
    if edts:
        _check_edit_list(moov, _one(moov, *edts[0], "elst"), frames, delta, timescale)
    return Picture(frames=frames, fps=timescale / delta)


def _check_edit_list(moov: bytes, elst: tuple[int, int], frames: int, delta: int, timescale: int) -> None:
    """편집 목록이 그림 전체를 1배속으로 트는 한 줄(ffmpeg 의 시작 보정)인지 본다 — 아니면 PictureError(Codex 코드 리뷰).
    줄 수만 보면 '240프레임 중 2초만 튼다'는 파일도 10초로 읽는다. 재생 구간 길이(segment_duration — moov 의 mvhd 단위)가 그림
    길이와 반 프레임 안으로 같아야 하고, 시작점(media_time)은 0 이상, 배속은 1 이어야 한다. 구간 길이 0 은 '끝까지'로 본다."""
    version = _full(moov, *elst, 8)
    count = struct.unpack_from(">I", moov, elst[0] + 4)[0]
    if count == 0:
        return
    if count > 1:  # 여러 줄은 재생 구간이 따로 놀 수 있다
        raise PictureError("편집 목록이 여러 줄이다")
    if version == 1:
        _full(moov, *elst, 8 + 20)
        segment, media_time = struct.unpack_from(">Qq", moov, elst[0] + 8)
        rate = struct.unpack_from(">hh", moov, elst[0] + 24)
    else:
        _full(moov, *elst, 8 + 12)
        segment, media_time = struct.unpack_from(">Ii", moov, elst[0] + 8)
        rate = struct.unpack_from(">hh", moov, elst[0] + 16)
    if media_time < 0 or rate != (1, 0):
        raise PictureError("편집 목록이 빈 구간이거나 배속이 다르다")
    if segment:
        mvhd = _one(moov, 0, len(moov), "mvhd")
        if _full(moov, *mvhd, 4) == 1:
            _full(moov, *mvhd, 24)
            movie_scale = struct.unpack_from(">I", moov, mvhd[0] + 20)[0]
        else:
            _full(moov, *mvhd, 16)
            movie_scale = struct.unpack_from(">I", moov, mvhd[0] + 12)[0]
        if movie_scale <= 0:
            raise PictureError("mvhd 의 timescale 이 0 이다")
        shown = segment * timescale / movie_scale  # 그림 트랙 단위
        if abs(shown - frames * delta) * 2 > delta:
            raise PictureError("편집 목록이 그림 일부만 튼다")


def read_picture(read_at: Callable[[int, int], bytes], size: int) -> Picture:
    """최상위 상자 머리만 차례로 읽어 moov 를 찾고, moov 만 통째로 읽는다(mdat 는 건너뛴다)."""
    pos = 0
    for _ in range(MAX_TOP_BOXES):
        remaining = size - pos
        if remaining < 8:
            break
        kind, first, box = _peek(read_at(pos, min(16, remaining)), remaining)  # box ≥ first ≥ 8 — 늘 앞으로 간다
        if kind in ("moof", "mfra"):
            raise PictureError("분할 MP4 다")
        if kind == "moov":
            if box - first > MAX_MOOV:
                raise PictureError("moov 가 너무 크다")
            return picture_from_moov(read_at(pos + first, box - first))
        pos += box
    raise PictureError("moov 를 찾지 못했다")


def _peek(head: bytes, remaining: int) -> tuple[str, int, int]:
    """머리 16바이트만 읽었을 때 — 크기는 남은 파일 길이(remaining)에 대어 본다."""
    if len(head) < 8:
        raise PictureError("상자 머리가 잘렸다")
    size, kind = struct.unpack_from(">I4s", head, 0)
    first = 8
    if size == 1:
        if len(head) < 16:
            raise PictureError("상자 머리가 잘렸다")
        size = struct.unpack_from(">Q", head, 8)[0]
        first = 16
    elif size == 0:
        size = remaining
    if size < first or size > remaining:
        raise PictureError("상자 크기가 맞지 않는다")
    return kind.decode("latin-1"), first, size


@lru_cache(maxsize=1024)
def local_picture(path: str, size: int, mtime_ns: int) -> Picture:
    """file_picture 를 (경로, 크기, 수정 시각)으로 기억한다 — 파일이 바뀌면 다른 키다. 실패는 기억하지 않는다."""
    del size, mtime_ns  # 키에만 쓴다
    return file_picture(path)


def file_picture(path) -> Picture:
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()

        def read_at(offset: int, length: int) -> bytes:
            f.seek(offset)
            data = f.read(length)
            if len(data) != length:
                raise PictureError("파일이 짧다")
            return data

        return read_picture(read_at, size)


# 원격(공유받은 생성물의 CDN 주소) — 머리 상자와 moov 만 Range 요청으로 읽는다(mdat 는 받지 않는다).
#  요청은 206 + 그 범위의 Content-Range 만 받는다: 범위를 무시하는 서버(200)는 파일 전체를 보내므로 그만둔다.
#  지문 수집기(result_probe)와 같은 방어 — 공용 주소만·리다이렉트 재검사(guarded_opener)·압축 본문 거절·전체 시한.
_IO_TIMEOUT = 10  # 연결·읽기 한 번
_TOTAL_TIMEOUT = 15.0  # 한 파일 전체 — 라우터(PICTURE_WAIT 18초)·화면(lib/videoDuration 20초)보다 짧다
MAX_REQUESTS = 12  # 머리 상자마다 한 번 + moov 한 번 — 일반 MP4 는 2~6번이다
_CONTENT_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")


def remote_picture(url: str, *, opener=None, clock: Callable[[], float] = time.monotonic) -> Picture:
    from .net_guard import BlockedURLError, assert_public_http_url, guarded_opener
    from .result_probe import ProbeError, _read_exact

    deadline = clock() + _TOTAL_TIMEOUT  # 주소 확인(DNS)부터 센다(Codex 코드 리뷰)
    try:
        assert_public_http_url(url)
    except BlockedURLError as exc:
        raise PictureError("허용되지 않는 주소다") from exc
    use = opener or guarded_opener()
    seen = {"requests": 0, "total": None}

    def fetch(offset: int, length: int) -> tuple[bytes, int]:
        seen["requests"] += 1
        if seen["requests"] > MAX_REQUESTS:
            raise PictureError("요청이 너무 많다")
        left = deadline - clock()
        if left <= 0:
            raise PictureError("시간이 다 됐다")
        # 요청마다 남은 시간만 준다. ponytail: 소켓 시한은 recv 한 번마다라, 머리글을 한 바이트씩 흘리는 서버는 이 스레드를 그보다
        #  오래 붙잡을 수 있다 — 화면 쪽은 라우터의 시한(PICTURE_WAIT)에서 끊고 물러난다. 끝까지 막으려면 소켓을 닫는 감시가 필요하다.
        timeout = min(_IO_TIMEOUT, left)
        request = urllib.request.Request(url, headers={
            "Range": f"bytes={offset}-{offset + length - 1}",
            "Accept-Encoding": "identity",
            "User-Agent": "content-hub/0.1",
        })
        try:
            with use.open(request, timeout=timeout) as resp:
                if (resp.headers.get("Content-Encoding") or "").strip().lower() not in ("", "identity"):
                    raise PictureError("압축된 본문이다")
                if resp.getcode() != 206:
                    raise PictureError("범위 요청을 받지 않는다")
                match = _CONTENT_RANGE_RE.match((resp.headers.get("Content-Range") or "").strip())
                if not match:
                    raise PictureError("Content-Range 가 맞지 않는다")
                start, end, total = (int(part) for part in match.groups())
                if start != offset or end != min(offset + length, total) - 1 or total <= 0:
                    raise PictureError("받은 범위가 다르다")
                if seen["total"] is not None and total != seen["total"]:
                    raise PictureError("읽는 사이 파일이 바뀌었다")
                seen["total"] = total
                return _read_exact(resp, end - start + 1, deadline, clock), total
        except PictureError:
            raise
        except ProbeError as exc:
            raise PictureError(str(exc)) from exc
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise PictureError(type(exc).__name__) from exc

    head, size = fetch(0, 16)

    def read_at(offset: int, length: int) -> bytes:
        if offset == 0 and length <= len(head):
            return head[:length]
        data, _total = fetch(offset, length)
        if len(data) != length:
            raise PictureError("파일이 짧다")
        return data

    return read_picture(read_at, size)


@lru_cache(maxsize=1024)
def remote_picture_cached(url: str) -> Picture:
    """원격 주소별로 기억한다 — 생성물의 결과 주소는 내용이 바뀌지 않는다. 실패는 기억하지 않는다(다음에 다시)."""
    return remote_picture(url)
