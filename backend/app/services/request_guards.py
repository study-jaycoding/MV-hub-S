from __future__ import annotations

from fastapi import HTTPException, Request

LOOPBACK_CLIENTS = ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def client_host(request: Request) -> str:
    return (request.client.host if request.client else "") or ""


def is_loopback_host(host: str) -> bool:
    return host in LOOPBACK_CLIENTS


def is_loopback_request(request: Request) -> bool:
    return is_loopback_host(client_host(request))


def require_loopback_request(request: Request, detail: str) -> None:
    if not is_loopback_request(request):
        raise HTTPException(status_code=403, detail=detail)
