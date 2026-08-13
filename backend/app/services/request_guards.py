from __future__ import annotations

import ipaddress
import os
import socket
from functools import lru_cache

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
    for name in {socket.gethostname(), socket.getfqdn()}:
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
    if not is_local_machine_host(client_host(request)):
        raise HTTPException(status_code=403, detail=detail)
