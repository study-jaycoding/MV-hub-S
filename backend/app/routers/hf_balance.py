"""Observation-only ingestion: historical reports never restore old membership."""
from __future__ import annotations

import time

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, StrictInt

from .. import config, deps, rbac
from ..services import shared_connection
from ..usecases import hf_balance
from . import _proxy
from ._telemetry import schedule_telemetry_drain
from .ingest import _agent_write_acc, _validate_balance_sender

router = APIRouter(prefix='/api', tags=['balance'])


class BalanceObservationsIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: StrictInt
    account_email: str
    observations: list


@router.post('/ingest/balance-observations')
def receive_observations(body: BalanceObservationsIn, request: Request, background_tasks: BackgroundTasks):
    if not config.MANAGE_ENABLED:
        raise HTTPException(503, '잔액 기록을 사용할 수 없습니다')
    acc = _agent_write_acc(request)
    _validate_balance_sender(request, acc, body.account_email)
    try:
        receipt, changed = hf_balance.receive(acc, body.account_email, body.version, body.observations,
                                     target=_proxy.base_url() if _proxy.proxying() else None,
                                     receiver='server' if shared_connection.is_shared_team_server() else 'hub')
    except ValueError as exc:
        raise HTTPException(422, '잔액 보고 형식을 확인하세요') from exc
    if changed:
        from ..ws import manager
        from ..deps import realtime_scope
        background_tasks.add_task(manager.broadcast, {'type': 'credits_changed'}, account_uid=realtime_scope(acc))
        schedule_telemetry_drain()
    return receipt


@router.get('/manage/balances')
def get_balances(request: Request, workspace_id: str | None = None):
    if not config.MANAGE_ENABLED:
        raise HTTPException(404, 'unsupported')
    if _proxy.proxying():
        return _proxy.proxy_get('/api/manage/balances', request)
    at = int(time.time() * 1000)
    if not config.AUTH_ENABLED:
        return dict(balance_protocol=1, as_of_ms=at, balances=[], basis='unavailable', reason_codes=['auth_unavailable'])
    acc = deps.current_account(request)
    if not acc or acc.get('status') != 'approved':
        raise HTTPException(401, 'authentication_required')
    try:
        views = hf_balance.balances(acc['email'], workspace_id,
                                   read_all=rbac.has_global_cap(deps.account_global_roles(request), 'read_all'), at=at)
    except PermissionError as exc:
        raise HTTPException(403, 'workspace_membership') from exc
    return dict(balance_protocol=1, as_of_ms=at, balances=views)


@router.get('/manage/console/balance-ledger')
def get_balance_ledger(request: Request, workspace_id: str, start: str | None = None, end: str | None = None,
                       limit: int = Query(100, ge=1, le=500), cursor: str | None = None):
    if not config.MANAGE_ENABLED:
        raise HTTPException(404, 'unsupported')
    if _proxy.proxying():
        return _proxy.proxy_get('/api/manage/console/balance-ledger', request)
    if not config.AUTH_ENABLED:
        raise HTTPException(404, 'unavailable')
    acc = deps.current_account(request)
    if not acc or acc.get('status') != 'approved':
        raise HTTPException(401, 'authentication_required')
    if not rbac.has_any_global_role(deps.account_global_roles(request), rbac.ADMIN):
        raise HTTPException(403, 'admin_required')
    from ..repo import hf_balance_ledger
    try:
        return hf_balance_ledger.ledger(workspace_id, start, end, limit=limit, cursor=cursor)
    except hf_balance_ledger.AnalysisChanged as exc:
        raise HTTPException(409, 'analysis_changed') from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
