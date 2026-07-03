"""SSRF 방어 공용 — 서버가 원격 미디어 URL 을 **대신 받아올 때** 내부/사설망 우회를 차단한다.

원격 URL 을 서버가 열어주는 경로가 둘(라우터 /api/download, 서비스 media_cache)이라, 방어를 한 곳에
모아 양쪽이 같은 규칙을 쓰게 한다. 라우터가 아니므로 도메인 예외(BlockedURLError)만 던지고,
HTTP 변환은 호출부가 한다(FastAPI 의존 없음).
"""

from __future__ import annotations

import ipaddress
import socket
import urllib.parse
import urllib.request


class BlockedURLError(ValueError):
    """URL 이 http(s) 가 아니거나 내부/사설 대역, 또는 리다이렉트로 우회하려 해 차단됨(SSRF 방어)."""


def assert_public_http_url(url: str) -> None:
    """http(s) 공개 호스트인지 검증. 호스트를 **실제 IP 로 해석**해 사설/루프백/링크로컬/예약/멀티캐스트/
    미지정 대역이면 거부한다. 문자열 prefix 검사만으론 10진수 IP(2130706433=127.0.0.1)·IPv6·단축형을
    못 막으므로 ipaddress 로 판정한다(클라우드 메타데이터 169.254.169.254·내부망 차단).
    DNS 리바인딩은 잔여 위험(연결 시점 재해석) — 내부 도구 수준에서 수용."""
    low = url.strip().lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        raise BlockedURLError("http(s) URL 만 받을 수 있습니다")
    host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
    if not host:
        raise BlockedURLError("URL 호스트가 없습니다")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise BlockedURLError("호스트를 해석할 수 없습니다") from e
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        # IPv4-mapped IPv6(::ffff:127.0.0.1) 도 펼쳐 검사
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        # is_global=False 를 기본 차단 — is_private/loopback 열거는 CGNAT(100.64.0.0/10,
        # Tailscale/통신사 내부망)·6to4·기타 비공개 대역을 놓친다. 공개 IP 만 통과시킨다.
        # (IPv6 는 is_global 이 없는 파이썬 버전 대비 열거 검사도 함께 유지.)
        blocked = (
            not getattr(ip, "is_global", True)
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        )
        if blocked:
            raise BlockedURLError("내부/사설 호스트 미디어는 받을 수 없습니다")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트 차단 — urlopen 이 3xx 를 따라가 검증 통과 후 내부망으로 우회(SSRF)하는 것을 막는다.
    공개 미디어 CDN(cloudfront 등)은 직접 200 을 주므로 리다이렉트가 필요 없다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise BlockedURLError("리다이렉트 미디어는 받을 수 없습니다")


def guarded_opener() -> urllib.request.OpenerDirector:
    """리다이렉트를 차단하는 opener(3xx 로 내부망 우회 방지). 호출 전 assert_public_http_url 로
    최초 URL 을 검증하고, 이 opener 로 열어 3xx 우회까지 막는다."""
    return urllib.request.build_opener(_NoRedirect)
