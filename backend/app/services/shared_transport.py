"""공유 서버 전송 경계 — 저장 신원은 그대로 두고 전송에서만 TLS를 강제한다."""
from __future__ import annotations

import http.client
import logging
from functools import lru_cache
from pathlib import Path
import socket
import ssl
import threading
import urllib.request
from urllib.parse import urlsplit

from .operational_logging import log_event


TLS_REQUIRED = False  # 전환 릴리스에서 공개 인증서와 함께 켠다.
BUNDLE_PATH = Path(__file__).resolve().parents[1] / "resources" / "tls" / "shared_server.pem"
_CONNECT_TIMEOUT_S = 3.0
_logged: set[str] = set()
_log_lock = threading.Lock()
_log = logging.getLogger("mvhub.shared_transport")


class TLSConfigError(OSError):
    """필수 공개 인증서를 읽을 수 없어 전송을 중단했다."""


def _log_state(state: str) -> None:
    with _log_lock:
        if state not in _logged:
            log_event(_log, "shared_transport_state", state=state,
                      level=logging.WARNING if state == "error" else logging.INFO)
            _logged.add(state)


@lru_cache(maxsize=1)
def _pinned_context(path: str, mtime_ns: int, size: int) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=path)
    context.verify_flags |= ssl.VERIFY_X509_STRICT | ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def ssl_context() -> ssl.SSLContext:
    if not TLS_REQUIRED:
        _log_state("off")
        return ssl.create_default_context()
    try:
        stat = BUNDLE_PATH.stat()
        context = _pinned_context(str(BUNDLE_PATH.resolve()), stat.st_mtime_ns, stat.st_size)
    except (OSError, ValueError) as exc:
        _log_state("error")
        raise TLSConfigError("공유 서버 인증서 확인 실패: 공개 인증서가 없거나 올바르지 않습니다") from exc
    _log_state("on")
    return context


def transport_url(url: str) -> str:
    if not TLS_REQUIRED:
        _log_state("off")
        return url
    ssl_context()  # 파일 누락·손상은 HTTP 요청을 만들기 전에 거절한다.
    if urlsplit(url).scheme.lower() not in ("http", "https", "ws", "wss"):
        raise TLSConfigError("공유 서버 전송 URL의 프로토콜을 지원하지 않습니다")
    if url[:7].lower() == "http://":
        return "https://" + url[7:]
    if url[:5].lower() == "ws://":
        return "wss://" + url[5:]
    return url


def _fast_connect(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None, **kwargs):
    if timeout is socket._GLOBAL_DEFAULT_TIMEOUT:
        timeout = socket.getdefaulttimeout()
    connect_timeout = _CONNECT_TIMEOUT_S if timeout is None else min(timeout, _CONNECT_TIMEOUT_S)
    sock = socket.create_connection(address, connect_timeout, source_address, **kwargs)
    sock.settimeout(timeout)
    return sock


class _FastConnectHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _fast_connect


class _FastConnectHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _fast_connect


class _FastConnectHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        if TLS_REQUIRED:
            raise TLSConfigError("공유 서버 HTTPS가 필수입니다: HTTP 전송을 거절합니다")
        return self.do_open(_FastConnectHTTPConnection, req)


class _FastConnectHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        context = ssl_context() if TLS_REQUIRED else self._context
        return self.do_open(_FastConnectHTTPSConnection, req, context=context)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener(*, proxy: bool = True) -> urllib.request.OpenerDirector:
    handlers = [_FastConnectHTTPHandler, _FastConnectHTTPSHandler, _NoRedirect]
    if not proxy:
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


@lru_cache(maxsize=2)
def _cached_opener(proxy: bool) -> urllib.request.OpenerDirector:
    return opener(proxy=proxy)


def cached_opener(*, proxy: bool = True) -> urllib.request.OpenerDirector:
    return _cached_opener(bool(proxy))
