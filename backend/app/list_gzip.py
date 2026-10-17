"""생성물 목록 응답만 gzip 으로 압축한다.

★왜(2026-09-12 실측, C-14): `/api/generations?limit=200` 응답이 **1,664,434 B** 인데
 지금은 **압축을 전혀 안 한다**(`Accept-Encoding: gzip` 을 보내도 `content-encoding` 이 없다).
 팀 탭은 이 목록을 유휴 15초·활성 잡이 있으면 **3초**마다 다시 받는다
 (`useGenerationAutoRefresh.ts:34` 의 `hasActiveJob ? 3000 : 15000`).

| 폴 주기 | 지금 | gzip -6 |
|---|---|---|
| 유휴 15초 | 6.35 MB/분 | **0.33 MB/분** |
| 활성 잡 3초 | 31.75 MB/분 | **1.63 MB/분** |

 압축률 **5.1%**(1,664,434 → 85,501 B), 압축 6.6ms · 해제 1.1ms.

★**전역으로 켜지 않는다.** 표준 `GZipMiddleware` 는 (설치본 확인):
 - 기본 `compresslevel=9`(우리는 **6** — 실측상 -9 가 오히려 더 컸고 2ms 더 느렸다)
 - **미디어를 MIME 으로 걸러 주지 않는다** — `206 video/mp4` 도 압축하면서 `Content-Range` 를
   그대로 남긴다(코덱스가 재현). 그러면 **부분 다운로드 계약이 깨진다.**
 - `gzip;q=0`(명시적 거부)을 존중하지 않는다 — 문자열에 'gzip' 이 있다는 이유로 압축한다.
 그래서 **경로·메서드를 좁혀** 감싼다. 미디어·스트리밍·Range 는 아예 닿지 않는다.

★이 앱이 전부 무압축이었던 것은 아니다 — 관리 작업표(`routers/manage.py`)는 이미
 레벨 1 gzip + 압축 결과 캐시 + ETag 를 쓴다. 무압축이던 것은 **생성물 목록**이다.

★허브(AUTH off)가 **같은 PC 브라우저**에 주는 목록은 압축하지 않는다(82회차, Codex 레인 FD 후보 1):
 목록 한 건(200행 6.86MB) 압축에 약 55~60ms(81·82회차 실측)가 드는데 같은 PC 안 전송은 네트워크를 타지 않는다
 (대신 6.86MB 를 그대로 넘긴다 — 왕복 절감 폭은 별도 실측 대상). 루프백 판정은
 `request_guards.is_loopback_request` 그대로(Vite 경유는 x-forwarded-for 마지막 값) — Host 헤더는 보지 않고,
 주소가 없거나 원격이면 압축한다. 공유 서버(AUTH on)는 루프백이어도 압축한다.

★공유 서버(AUTH on)는 레벨 **2** 로 압축한다(82회차 FD 후보 2): 압축은 서버 한 프로세스의 이벤트 루프를
 잡아 동시 진입 때 줄을 세운다. 실제 팀 목록 200행(6,862,056 B) 30회 실측 — 레벨 6 = 1,077,366 B·중앙 55ms,
 레벨 2 = 1,407,172 B·중앙 26.5ms, 레벨 1 = 1,841,042 B·중앙 17ms. 1 은 크기가 판정선(1.5MB)을 넘고 100Mbps 에서는
 늘어난 전송(약 61ms)이 줄인 CPU 보다 커서 2 를 쓴다. 형식은 같은 gzip 이라 옛 허브(`_proxy.decode_proxy_body`)도 그대로 푼다.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from .services.request_guards import is_loopback_request

#: 압축할 경로 — **정확히 일치**해야 한다. `/api/generations/{id}` 같은 하위 경로는 포함하지 않는다
#: (상세·미디어·히스토리가 그 아래에 있다).
COMPRESSED_PATHS = frozenset({"/api/generations"})

MINIMUM_SIZE = 1024
COMPRESS_LEVEL = 6
SERVER_COMPRESS_LEVEL = 2  # 공유 서버(AUTH on) — 머리말의 82회차 실측


def mode_options(auth_enabled: bool) -> dict:
    """운영 모드별 생성 인자 — `main.py` 가 등록할 때 쓴다(허브 = AUTH off)."""
    if auth_enabled:
        return {"compresslevel": SERVER_COMPRESS_LEVEL}
    return {"skip_loopback": True}


def accepts_gzip(accept_encoding: str | None) -> bool:
    """`Accept-Encoding` 이 gzip 을 **실제로 원하는가** — `q=0` 은 거부다.

    표준 미들웨어는 `"gzip" in header` 로만 보아 `gzip;q=0`(명시적 거부)에도 압축한다.
    """
    if not accept_encoding:
        return False
    fallback = False
    for part in accept_encoding.split(","):
        token, _, params = part.strip().partition(";")
        name = token.strip().lower()
        if name not in ("gzip", "*"):
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.strip().partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 0.0
        if name == "gzip":
            return quality > 0
        fallback = quality > 0  # `*` 는 gzip 을 명시한 항목이 없을 때만 쓴다
    return fallback


class ListGzipMiddleware:
    """`GET /api/generations` 의 정상 응답만 표준 gzip 으로 넘긴다."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        minimum_size: int = MINIMUM_SIZE,
        compresslevel: int = COMPRESS_LEVEL,
        skip_loopback: bool = False,
    ) -> None:
        self.app = app
        self.skip_loopback = skip_loopback
        self._gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    @staticmethod
    def eligible(scope: Scope) -> bool:
        if scope.get("type") != "http":
            return False
        if scope.get("method") != "GET":  # HEAD 는 본문이 없고 길이 계약이 걸린다
            return False
        if scope.get("path") not in COMPRESSED_PATHS:
            return False
        headers = Headers(scope=scope)
        if headers.get("range"):  # 부분 요청은 건드리지 않는다
            return False
        return accepts_gzip(headers.get("accept-encoding"))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.eligible(scope) and not (self.skip_loopback and is_loopback_request(Request(scope))):
            await self._gzip(scope, receive, send)
            return
        await self.app(scope, receive, send)
