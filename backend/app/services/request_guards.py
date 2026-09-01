from __future__ import annotations

import ipaddress
import os
import socket
from functools import lru_cache
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

LOOPBACK_CLIENTS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def client_host(request: Request) -> str:
    direct = (request.client.host if request.client else "") or ""
    # 개발용 Vite 프록시는 같은 PC의 loopback으로 백엔드에 연결한다. 이 경우에만
    # 프록시가 마지막에 기록한 직접 접속 주소를 사용해, 다른 LAN PC가 로컬 기능을
    # 우회하지 못하게 한다. 앞쪽에 사용자가 임의로 넣은 주소는 신뢰하지 않는다.
    if is_loopback_host(direct):
        forwarded = ""
        for name, value in request.scope.get("headers") or ():
            if name.lower() == b"x-forwarded-for":
                forwarded = value.decode("latin-1")
                break
        original = forwarded.rsplit(",", 1)[-1].strip()
        if original:
            return original
    return direct


def is_loopback_host(host: str) -> bool:
    return host in LOOPBACK_CLIENTS


def is_loopback_request(request: Request) -> bool:
    return is_loopback_host(client_host(request))


def require_loopback_request(request: Request, detail: str) -> None:
    if not is_loopback_request(request):
        raise HTTPException(status_code=403, detail=detail)


def request_host_header(request: Request) -> str:
    """요청의 Host 헤더 원문(없으면 빈 문자열). scope 를 직접 읽어 client_host 와 같은 방식."""
    for name, value in request.scope.get("headers") or ():
        if name.lower() == b"host":
            return value.decode("latin-1")
    return ""


def _authority_hostname(raw: str) -> str:
    """Host 헤더 형태("host[:port]")에서 hostname 만 — 형식 불량이면 빈 문자열.
    userinfo·경로·쿼리·제어문자가 섞인 값은 정상 Host 가 아니므로 전부 거부한다."""
    host = raw.strip()
    if not host:
        return ""
    if any(ch in host for ch in "@/\\?#") or any(ord(ch) < 33 for ch in host):
        return ""
    try:
        parts = urlsplit(f"//{host}")
        parts.port  # 포트 형식·범위 불량이면 ValueError
    except ValueError:
        return ""
    if parts.path or parts.query or parts.fragment or parts.username is not None:
        return ""
    return parts.hostname or ""


def _is_loopback_name(hostname: str) -> bool:
    try:
        return ipaddress.ip_address(_normalized_ip(hostname)).is_loopback
    except ValueError:  # localhost 외의 도메인 이름 — 해석하지 않고 거부
        return False


def is_loopback_host_header(raw: str) -> bool:
    """Host 헤더가 이 PC 자신을 가리키는 이름(localhost/127.0.0.1/[::1], 포트 무관)인가.

    빈 값(=Host 헤더 없음)은 통과시킨다. HTTP/1.1 브라우저는 Host 를 반드시 붙이므로,
    헤더가 없는 요청은 브라우저가 아니고 이 검사가 막으려는 공격 경로도 아니다.
    """
    if not raw.strip():
        return True
    hostname = _authority_hostname(raw)
    return bool(hostname) and _is_loopback_name(hostname)


def _request_header(request: Request, name: str) -> str:
    target = name.lower().encode()
    for key, value in request.scope.get("headers") or ():
        if key.lower() == target:
            return value.decode("latin-1")
    return ""


def _origin_hostname(raw: str) -> str:
    """Origin/Referer 값에서 hostname 만 — http(s) 가 아니거나 형식 불량이면 빈 문자열.
    "null"(샌드박스 iframe·file://)은 scheme 파싱에서 걸려 거부된다."""
    value = raw.strip()
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        parts.port  # 포트 형식·범위 불량이면 ValueError
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https") or parts.username is not None:
        return ""
    return parts.hostname or ""


def _require_same_machine_browser_context(
    request: Request, detail: str, host_ok
) -> None:
    """브라우저 문맥 검사(공통) — Host·Sec-Fetch-Site·Origin·Referer.

    CSRF: 최신 브라우저의 cross-origin POST 는 Origin(과 Sec-Fetch-Site)을 반드시 붙이므로
    이 검사가 막는다. 세 헤더가 전부 없는 요청(비브라우저 스크립트·curl)은 호환을 위해
    통과시킨다 — 구형 브라우저까지의 절대 차단은 아니며, 그 잔여 위협은 문서화로 갈음
    (완전 차단은 커스텀 헤더/CSRF 토큰이 필요해 비브라우저 호환과 양립 불가).
    DNS 리바인딩: 공격자 도메인이 로컬 IP 로 재해석되면 접속 IP 는 로컬이 되지만
    Host 헤더에 공격자 도메인이 남으므로 Host 검사가 막는다.
    """
    host_header = request_host_header(request)
    if host_header.strip():
        hostname = _authority_hostname(host_header)
        if not hostname or not host_ok(hostname):
            raise HTTPException(status_code=403, detail=detail)
    if _request_header(request, "sec-fetch-site").strip().lower() == "cross-site":
        raise HTTPException(status_code=403, detail=detail)
    origin = _request_header(request, "origin").strip()
    if origin:
        hostname = _origin_hostname(origin)
        if not hostname or not host_ok(hostname):
            raise HTTPException(status_code=403, detail=detail)
    referer = _request_header(request, "referer").strip()
    if referer:
        hostname = _origin_hostname(referer)
        if not hostname or not host_ok(hostname):
            raise HTTPException(status_code=403, detail=detail)


def require_loopback_browser_request(request: Request, detail: str) -> None:
    """loopback 접속 + 브라우저 문맥(Host·Origin 등)도 loopback — DNS 리바인딩·CSRF 방어.

    ``require_loopback_request`` 만으로는 부족하다: 공격자 페이지의 도메인이 127.0.0.1 로
    재해석(rebinding)되면 브라우저가 이 허브로 직접 접속하므로 클라이언트 IP 는 loopback 이
    된다. 그때 Host 헤더에는 공격자 도메인이 남으므로, Host 까지 검사해야 그 우회를 막는다.
    """
    require_loopback_request(request, detail)
    _require_same_machine_browser_context(request, detail, _is_loopback_name)


def _normalized_ip(host: str) -> str:
    raw = host.strip().split("%", 1)[0]
    if raw.casefold() == "localhost":
        return "127.0.0.1"
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return raw.casefold()
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    return address.compressed


@lru_cache(maxsize=1)
def local_machine_hosts() -> frozenset[str]:
    """현재 PC의 loopback 및 네트워크 어댑터 IP 주소를 반환한다."""
    hosts = {_normalized_ip(host) for host in LOOPBACK_CLIENTS}
    configured = os.environ.get("CONTENT_HUB_LOCAL_HOSTS", "")
    hosts.update(
        _normalized_ip(host)
        for host in configured.split(",")
        if host.strip()
    )
    # 머신 이름 자체는 gethostname 만 자동 신뢰(Host: DESKTOP-X 형태 접속 허용).
    # getfqdn 은 DNS 가 결정할 수 있어 이름으로는 넣지 않는다(리바인딩 면적 축소,
    # 코덱스 검토) — FQDN 접속이 필요하면 CONTENT_HUB_LOCAL_HOSTS 로 명시한다.
    own_name = socket.gethostname()
    if own_name:
        hosts.add(_normalized_ip(own_name))
    for name in {own_name, socket.getfqdn()}:
        if not name:
            continue
        try:
            rows = socket.getaddrinfo(name, None, type=socket.SOCK_STREAM)
        except OSError:
            continue
        for _family, _socktype, _proto, _canonname, address in rows:
            if address and address[0]:
                hosts.add(_normalized_ip(str(address[0])))
    return frozenset(hosts)


def is_local_machine_host(host: str) -> bool:
    normalized = _normalized_ip(host)
    try:
        if ipaddress.ip_address(normalized).is_loopback:
            return True
    except ValueError:
        pass
    return normalized in local_machine_hosts()


def require_local_machine_request(request: Request, detail: str) -> None:
    """이 PC 에서 온 요청만 — 접속 IP + 브라우저 문맥(Host·Sec-Fetch-Site·Origin·Referer).

    IP 검사만으로는 브라우저 경유 공격(악성 페이지의 127.0.0.1 폼 POST = CSRF,
    DNS 리바인딩)이 통과한다 — 브라우저 문맥 헤더까지 로컬 머신인지 검사한다.
    비브라우저 클라이언트(Resolve 스크립트·urllib)는 Host 가 로컬이고 Origin 이 없어
    그대로 통과한다. 실패는 검사 종류를 노출하지 않는 동일 403.
    """
    if not is_local_machine_host(client_host(request)):
        raise HTTPException(status_code=403, detail=detail)
    _require_same_machine_browser_context(request, detail, is_local_machine_host)
