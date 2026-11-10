"""Server-PC administration only. No validation errors echo secret-bearing inputs."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request, Response

from .. import config, deps, rbac, repo
from ..services.async_tools import to_thread_non_abandon
from ..services.hf_org_usage_key import UsageError
from ..services.request_guards import require_local_machine_request
from ..usecases import hf_org_usage as usecase

router = APIRouter(tags=["hf-org-usage"])


def _admin(request: Request) -> str:
    if not config.AUTH_ENABLED or not config.MANAGE_ENABLED:
        raise HTTPException(404, "Not Found")
    require_local_machine_request(request, "서버 PC 에서만 쓸 수 있습니다")
    deps.require_admin(request)
    account = deps.current_account(request) or {}
    deps.assert_account_current(account)
    fresh = repo.get_account(account.get("email", "")) or {}
    if fresh.get("status") != "approved" or not rbac.has_any_global_role(fresh.get("global_role"), rbac.ADMIN):
        raise HTTPException(403, "관리자 권한이 필요합니다")
    return fresh["email"]


async def _body(request: Request) -> dict:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 4096:
            raise HTTPException(413, "body_too_large")
        data.extend(chunk)
    try:
        body = json.loads(data)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except (ValueError, UnicodeError):
        raise HTTPException(400, "invalid_body") from None


def _revision(body: dict) -> int:
    value = body.get("expected_revision")
    if type(value) is not int or not 0 <= value < 2**63 - 1:
        raise HTTPException(400, "invalid_revision")
    return value


def _key(body: dict, required=False) -> str | None:
    key = body.get("api_key")
    if key is None and not required:
        return None
    if not isinstance(key, str) or not 1 <= len(key) <= 1024 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise HTTPException(400, "invalid_key")
    return key


def _call(request, function, *args, **kwargs):
    _admin(request)
    try:
        result = function(*args, **kwargs)
    except UsageError as exc:
        raise HTTPException(409, exc.code) from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "usage_unavailable") from None
    _admin(request)
    return result


@router.get("/api/admin/hf-org-usage/status")
def get_status(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return _call(request, usecase.status)


@router.put("/api/admin/hf-org-usage/key")
async def put_key(request: Request, response: Response):
    actor = await asyncio.to_thread(_admin, request)
    body = await _body(request)
    response.headers["Cache-Control"] = "no-store"
    expiry = body.get("expires_on")
    if expiry is not None and (not isinstance(expiry, str) or len(expiry) > 10):
        raise HTTPException(400, "invalid_expiry")
    return await to_thread_non_abandon(_call, request, usecase.register_key, _key(body, True),
                                      _revision(body), expiry, actor, lambda: _admin(request))


@router.post("/api/admin/hf-org-usage/key/check")
async def check_key(request: Request, response: Response):
    await asyncio.to_thread(_admin, request)
    body = await _body(request)
    response.headers["Cache-Control"] = "no-store"
    return await to_thread_non_abandon(_call, request, usecase.check_key, _key(body), _revision(body), lambda: _admin(request))


@router.delete("/api/admin/hf-org-usage/key")
async def delete_key(request: Request):
    await asyncio.to_thread(_admin, request)
    body = await _body(request)
    return await to_thread_non_abandon(_call, request, usecase.delete_key, _revision(body))


@router.patch("/api/admin/hf-org-usage/collector")
async def set_collector(request: Request):
    await asyncio.to_thread(_admin, request)
    body = await _body(request)
    if type(body.get("enabled")) is not bool:
        raise HTTPException(400, "invalid_enabled")
    return await to_thread_non_abandon(_call, request, usecase.set_collection, body["enabled"], _revision(body))


@router.post("/api/admin/hf-org-usage/refresh", status_code=202)
async def refresh(request: Request):
    await asyncio.to_thread(_admin, request)
    body = await _body(request)
    return await to_thread_non_abandon(_call, request, usecase.request_refresh, body.get("start"), body.get("end"))


@router.get("/api/admin/hf-org-usage/comparison")
def comparison(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return _call(request, usecase.compare_usage, request.query_params.get("start"), request.query_params.get("end"))
