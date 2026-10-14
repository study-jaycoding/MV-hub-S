"""MP4 그림 트랙 길이(services/mp4_picture) · /api/media-picture — 편집 탭 클립 길이(2026-10-14).

Seedance 원본은 소리가 그림보다 약 1프레임 길어, 브라우저의 video.duration 으로 잰 클립이 Resolve 의 원본보다 길었다.
여기서는 그림 트랙의 프레임 수를 읽는다 — 일반 MP4 만 받고 나머지는 PictureError(화면은 예전 방식으로 물러난다).
"""

import asyncio
import io
import struct
import tempfile
from pathlib import Path
from unittest import mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response

from app.routers import _proxy, library
from app.services import mp4_picture
from app.services.mp4_picture import PictureError, file_picture, picture_from_moov, read_picture, remote_picture


def box(kind: str, *parts: bytes) -> bytes:
    body = b"".join(parts)
    return struct.pack(">I4s", 8 + len(body), kind.encode()) + body


def full(kind: str, body: bytes, version: int = 0) -> bytes:
    return box(kind, bytes([version, 0, 0, 0]) + body)


MOVIE_SCALE = 1000  # mvhd 의 timescale — 편집 목록의 구간 길이 단위


def edit(segment: int, media_time: int = 1024, rate: tuple[int, int] = (1, 0)) -> bytes:
    return struct.pack(">Iihh", segment, media_time, *rate)


def trak(handler: bytes, frames: int, timescale: int, deltas, elst: list[bytes] | None = None, ctts=None) -> bytes:
    stts = struct.pack(">I", len(deltas)) + b"".join(struct.pack(">II", count, delta) for count, delta in deltas)
    parts = []
    if elst is not None:
        parts.append(box("edts", full("elst", struct.pack(">I", len(elst)) + b"".join(elst))))
    tables = [full("stsz", struct.pack(">II", 0, frames)), full("stts", stts)]
    if ctts is not None:  # 음수 보정이 있으면 버전 1(부호 있음)
        signed = any(o < 0 for _n, o in ctts)
        rows = b"".join(struct.pack(">Ii" if signed else ">II", n, o) for n, o in ctts)
        tables.append(full("ctts", struct.pack(">I", len(ctts)) + rows, version=1 if signed else 0))
    parts.append(box("mdia",
        full("mdhd", struct.pack(">IIII", 0, 0, timescale, 0) + b"\0" * 4),
        full("hdlr", b"\0" * 4 + handler + b"\0" * 12),
        box("minf", box("stbl", *tables)),
    ))
    return box("trak", *parts)


# Seedance 원본과 같은 모양(실측 32개) — 그림 97프레임(12288 / 512 = 24fps) · 소리 트랙 · moov 가 파일 끝 · B 프레임(ctts — 첫
#  프레임의 표시 시각 0 + 1024) · 편집 목록 한 줄(시작점 1024 = 첫 프레임, 구간 4042/1000초 = 그림 전체)
SEEDANCE_CTTS = [(1, 1024), (1, 2560), (1, 1024), (1, 0), (93, 1024)]
SEEDANCE_VIDEO = trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(4042)], ctts=SEEDANCE_CTTS)
SOUND = trak(b"soun", 190, 44100, [(190, 1024)])


def moov(*traks: bytes, extra: bytes = b"") -> bytes:
    return box("moov", full("mvhd", struct.pack(">IIII", 0, 0, MOVIE_SCALE, 0) + b"\0" * 80), *traks, extra)


def mp4(moov_box: bytes, mdat_size: int = 4096, faststart: bool = False) -> bytes:
    head = box("ftyp", b"isom\0\0\x02\0isomiso2mp41") + box("free")
    mdat = box("mdat", b"\x55" * mdat_size)
    return head + (moov_box + mdat if faststart else mdat + moov_box)


def body_of(moov_box: bytes) -> bytes:
    return moov_box[8:]


def write(tmp: Path, data: bytes) -> Path:
    path = tmp / "clip.mp4"
    path.write_bytes(data)
    return path


def test_seedance_shape_reads_picture_frames_not_sound(tmp_path):
    for faststart in (False, True):
        picture = file_picture(write(tmp_path, mp4(moov(SEEDANCE_VIDEO, SOUND), faststart=faststart)))
        assert (picture.frames, picture.fps) == (97, 24.0)
        assert picture.seconds == pytest.approx(97 / 24)


@pytest.mark.parametrize("moov_box, reason", [
    (moov(trak(b"vide", 97, 12288, [(48, 512), (49, 513)])), "간격이 고르지 않다"),
    (moov(trak(b"vide", 97, 12288, [(90, 512)])), "stts 합이 프레임 수와 다르다"),
    (moov(SEEDANCE_VIDEO, SEEDANCE_VIDEO), "그림 트랙이 둘"),
    (moov(SOUND), "그림 트랙이 없다"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(2000), edit(2042)], ctts=SEEDANCE_CTTS)), "편집 목록이 여러 줄"),
    # Codex 코드 리뷰 — 줄 수만 보면 아래를 그림 전체로 읽었다
    (moov(trak(b"vide", 240, 12288, [(240, 512)], elst=[edit(2000)], ctts=[(240, 1024)])), "10초 중 2초만 튼다"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(4042, rate=(2, 0))], ctts=SEEDANCE_CTTS)), "2배속"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(4042, media_time=-1)], ctts=SEEDANCE_CTTS)), "빈 구간"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[b""], ctts=SEEDANCE_CTTS)), "한 줄이라면서 본문이 없다"),
    # Codex 재검토 — B 프레임 없이 시작점 5초 · 구간 0(끝까지)은 남은 5초만 튼다
    (moov(trak(b"vide", 240, 12288, [(240, 512)], elst=[edit(0, media_time=5 * 24 * 512)])), "앞 5초를 자른다"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(0, media_time=1536)], ctts=SEEDANCE_CTTS)), "첫 프레임보다 늦게 시작"),
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(4042)], ctts=[(50, 1024)])), "ctts 표본 수가 다르다"),
    # Codex 세 번째 확인 — ctts v1 의 음수 보정으로 첫 표시 시각이 -1 이면 빈 구간(-1)이 '같다'로 통과했다
    (moov(trak(b"vide", 97, 12288, [(97, 512)], elst=[edit(4042, media_time=-1)], ctts=[(97, -1)])), "음수 보정 + 빈 구간"),
    (moov(SEEDANCE_VIDEO, extra=box("mvex")), "분할 MP4"),
    (moov(trak(b"vide", 97, 0, [(97, 512)])), "timescale 0"),
], ids=lambda value: value if isinstance(value, str) else "moov")  # 시험 이름 = 사유
def test_unusual_files_are_refused(moov_box, reason):
    with pytest.raises(PictureError):
        picture_from_moov(body_of(moov_box))


def test_edit_list_that_plays_everything_is_accepted():
    for elst, ctts in (
        ([edit(0)], SEEDANCE_CTTS),  # 구간 0 = 끝까지
        ([edit(4042, media_time=0)], None),  # B 프레임 없음 — 시작점 0
        ([], None),  # 빈 목록
    ):
        assert picture_from_moov(body_of(moov(trak(b"vide", 97, 12288, [(97, 512)], elst=elst, ctts=ctts)))).frames == 97


def test_truncated_or_lying_boxes_are_refused(tmp_path):
    good = mp4(moov(SEEDANCE_VIDEO))
    with pytest.raises(PictureError):  # moov 가 잘렸다
        file_picture(write(tmp_path, good[:-20]))
    lying = bytearray(good)
    struct.pack_into(">I", lying, 0, len(good) + 100)  # ftyp 가 파일보다 크다고 한다
    with pytest.raises(PictureError):
        file_picture(write(tmp_path, bytes(lying)))
    with pytest.raises(PictureError):  # 분할 MP4(moof)
        file_picture(write(tmp_path, box("ftyp", b"isom") + box("moof") + box("mdat", b"x")))


def test_reads_only_box_heads_and_moov_never_mdat():
    data = mp4(moov(SEEDANCE_VIDEO, SOUND), mdat_size=10_000_000)
    reads = []

    def read_at(offset, length):
        reads.append((offset, length))
        return data[offset:offset + length]

    assert read_picture(read_at, len(data)).frames == 97
    assert sum(length for _o, length in reads) < 5_000  # 10MB 의 mdat 는 읽지 않는다


# ── 원격: Range 요청만 받는다 ──

class FakeResponse(io.BytesIO):
    def __init__(self, status, headers, body):
        super().__init__(body)
        self.status = status
        self.headers = headers

    def getcode(self):
        return self.status

    def read1(self, size=-1):
        return self.read(size)


class FakeCDN:
    """bytes=a-b 를 206 으로 답하는 원격. mode 로 어긋나는 서버를 흉내 낸다."""

    def __init__(self, data: bytes, mode: str = "ok"):
        self.data = data
        self.mode = mode
        self.ranges = []

    def open(self, request, timeout):
        start, end = (int(part) for part in request.get_header("Range").removeprefix("bytes=").split("-"))
        self.ranges.append((start, end))
        assert request.get_header("Accept-encoding") == "identity"
        total = len(self.data) + (len(self.ranges) - 1 if self.mode == "changing" else 0)
        end = min(end, total - 1)
        if self.mode == "ignores-range":
            return FakeResponse(200, {"Content-Length": str(total)}, self.data)
        if self.mode == "wrong-range":
            start, end = start + 1, end + 1
        if self.mode == "gzip":
            return FakeResponse(206, {"Content-Encoding": "gzip", "Content-Range": f"bytes {start}-{end}/{total}"}, b"")
        return FakeResponse(206, {"Content-Range": f"bytes {start}-{end}/{total}"}, self.data[start:end + 1])


@pytest.fixture
def public_url():
    with mock.patch("app.services.net_guard.assert_public_http_url", return_value=None):
        yield "https://cdn.example/clip.mp4"


def test_remote_reads_heads_and_moov_with_range_requests(public_url):
    cdn = FakeCDN(mp4(moov(SEEDANCE_VIDEO, SOUND), mdat_size=10_000_000))
    assert remote_picture(public_url, opener=cdn).frames == 97
    assert len(cdn.ranges) <= 5  # ftyp(첫 16바이트에 같이) · free · mdat · moov 머리 · moov 본문
    assert sum(end - start + 1 for start, end in cdn.ranges) < 5_000


@pytest.mark.parametrize("mode", ["ignores-range", "wrong-range", "changing", "gzip"])
def test_remote_refuses_servers_that_do_not_honour_the_range(public_url, mode):
    with pytest.raises(PictureError):
        remote_picture(public_url, opener=FakeCDN(mp4(moov(SEEDANCE_VIDEO)), mode))


def test_remote_gives_up_after_too_many_requests(public_url):
    many_heads = box("ftyp", b"isom") + box("free") * 20 + moov(SEEDANCE_VIDEO)
    cdn = FakeCDN(many_heads)
    with pytest.raises(PictureError):
        remote_picture(public_url, opener=cdn)
    assert len(cdn.ranges) == mp4_picture.MAX_REQUESTS


def test_remote_deadline_counts_from_the_address_check_and_caps_each_request(public_url):
    # Codex 코드 리뷰 — 시한이 주소 확인(DNS) 뒤에야 시작했고, 요청마다 15초를 통째로 줬다
    now = [0.0]
    cdn = FakeCDN(mp4(moov(SEEDANCE_VIDEO)))
    timeouts = []
    real_open = cdn.open

    def slow_open(request, timeout):
        timeouts.append(timeout)
        now[0] += 6.0  # 요청마다 6초 걸린다
        return real_open(request, timeout)

    cdn.open = slow_open

    def slow_check(_url):
        now[0] += 5.0  # 주소 확인에 5초

    with mock.patch("app.services.net_guard.assert_public_http_url", side_effect=slow_check):
        with pytest.raises(PictureError):
            remote_picture(public_url, opener=cdn, clock=lambda: now[0])
    assert timeouts[0] == pytest.approx(10.0)  # 첫 요청: 남은 10초(15 − 5) — 한 번의 시한(10초)과 같다
    assert timeouts[1] == pytest.approx(4.0)  # 둘째: 15 − 5 − 6
    assert len(timeouts) == 2  # 셋째 전에 시간이 다 됐다


def test_endpoint_gives_up_waiting_and_frees_the_slot():
    import threading

    release = threading.Event()

    def stuck(_url):
        release.wait(5)
        return mp4_picture.Picture(frames=97, fps=24.0)

    async def run():
        with (
            mock.patch.object(library._proxy, "is_shared_team_server", return_value=False),
            mock.patch.object(library.mp4_picture, "remote_picture_cached", side_effect=stuck),
            mock.patch.object(library, "PICTURE_WAIT", 0.05),
        ):
            with pytest.raises(HTTPException) as late:
                await library.media_picture("https://cdn.example/slow.mp4")
            free = library._PICTURE_SLOTS._value
            release.set()  # 남은 스레드를 풀어 준다(asyncio.run 이 끝나며 기다린다)
            return late.value.status_code, free

    try:
        assert asyncio.run(run()) == (504, 4)  # 답했고, 자리는 비었다
    finally:
        release.set()


def test_endpoint_deadline_includes_waiting_for_a_slot():
    # Codex 재검토 — 시한이 자리를 얻은 뒤에야 시작해, 겹친 다섯째는 '앞 넷의 시한 + 제 시한'을 기다렸다
    import threading
    import time

    release = threading.Event()

    def stuck(_url):
        release.wait(5)
        return mp4_picture.Picture(frames=97, fps=24.0)

    async def one():
        started = time.monotonic()
        with pytest.raises(HTTPException) as late:
            await library.media_picture("https://cdn.example/slow.mp4")
        return late.value.status_code, time.monotonic() - started

    async def run():
        with (
            mock.patch.object(library._proxy, "is_shared_team_server", return_value=False),
            mock.patch.object(library.mp4_picture, "remote_picture_cached", side_effect=stuck),
            mock.patch.object(library, "PICTURE_WAIT", 0.2),
            mock.patch.object(library, "_PICTURE_SLOTS", asyncio.Semaphore(4)),
        ):
            results = await asyncio.gather(*(one() for _ in range(5)))
        release.set()
        return results

    try:
        results = asyncio.run(run())
    finally:
        release.set()
    assert [status for status, _t in results] == [504] * 5
    assert max(took for _s, took in results) < 0.35  # 다섯째도 시한 한 번(0.2초) 안쪽 — 고치기 전엔 0.4초


def test_remote_refuses_private_addresses():
    from app.services.net_guard import BlockedURLError

    with mock.patch("app.services.net_guard.assert_public_http_url", side_effect=BlockedURLError("private")):
        with pytest.raises(PictureError):
            remote_picture("http://192.168.1.10/clip.mp4", opener=FakeCDN(b""))


# ── /api/media-picture ──

def test_endpoint_reads_local_media_and_reports_failures(tmp_path):
    good = write(tmp_path, mp4(moov(SEEDANCE_VIDEO, SOUND)))
    with mock.patch.object(library.thumbs, "_media_target", return_value=good):
        assert asyncio.run(library.media_picture("/media/aa/clip.mp4")) == {"frames": 97, "fps": 24.0}
    with mock.patch.object(library.thumbs, "_media_target", return_value=tmp_path / "missing.mp4"):
        with pytest.raises(HTTPException) as missing:
            asyncio.run(library.media_picture("/media/aa/missing.mp4"))
    assert missing.value.status_code == 404
    odd = tmp_path / "odd.mp4"
    odd.write_bytes(mp4(moov(SOUND)))
    with mock.patch.object(library.thumbs, "_media_target", return_value=odd):
        with pytest.raises(HTTPException) as unreadable:
            asyncio.run(library.media_picture("/media/aa/odd.mp4"))
    assert unreadable.value.status_code == 422
    with pytest.raises(HTTPException) as escape:
        asyncio.run(library.media_picture("C:\\Windows\\win.ini"))
    assert escape.value.status_code == 400


def test_endpoint_remote_runs_on_worker_hub_only():
    picture = mp4_picture.Picture(frames=97, fps=24.0)
    with (
        mock.patch.object(library._proxy, "is_shared_team_server", return_value=False),
        mock.patch.object(library.mp4_picture, "remote_picture_cached", return_value=picture) as read,
    ):
        assert asyncio.run(library.media_picture("https://cdn.example/a.mp4")) == {"frames": 97, "fps": 24.0}
    read.assert_called_once_with("https://cdn.example/a.mp4")
    with (
        mock.patch.object(library._proxy, "is_shared_team_server", return_value=True),
        mock.patch.object(library.mp4_picture, "remote_picture_cached") as never,
    ):
        with pytest.raises(HTTPException) as on_server:
            asyncio.run(library.media_picture("https://cdn.example/a.mp4"))
    assert on_server.value.status_code == 404
    never.assert_not_called()


def _request(path: str, query: str) -> Request:
    return Request({
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": path, "raw_path": path.encode(), "query_string": query.encode(), "headers": [],
        "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8012),
    })


def test_media_picture_is_local_but_falls_back_to_server_for_missing_shared_media():
    assert _proxy.is_local_path("/api/media-picture")

    async def call_next(_request):
        return Response(content=b"local", status_code=200)

    forward = mock.AsyncMock(return_value=Response(content=b"server", status_code=200))
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
        (Path(temp_dir) / "aa").mkdir()
        (Path(temp_dir) / "aa" / "here.mp4").write_bytes(b"x")
        with (
            mock.patch.object(_proxy, "MEDIA_DIR", Path(temp_dir)),
            mock.patch.object(_proxy, "proxying", return_value=True),
            mock.patch.object(_proxy, "_forward_stream", forward),
        ):
            here = asyncio.run(_proxy.data_proxy_middleware(_request("/api/media-picture", "src=%2Fmedia%2Faa%2Fhere.mp4"), call_next))
            gone = asyncio.run(_proxy.data_proxy_middleware(_request("/api/media-picture", "src=%2Fmedia%2Faa%2Fgone.mp4"), call_next))
            remote = asyncio.run(_proxy.data_proxy_middleware(
                _request("/api/media-picture", "src=https%3A%2F%2Fcdn.example%2Fa.mp4"), call_next))
    assert [here.body, gone.body, remote.body] == [b"local", b"server", b"local"]
    forward.assert_awaited_once()
