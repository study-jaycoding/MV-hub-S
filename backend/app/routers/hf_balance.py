"""Observation-only ingestion: historical reports never restore old membership."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StrictInt

from .. import config
from ..services import shared_connection
from ..usecases import hf_balance
from . import _proxy
from ._telemetry import schedule_telemetry_drain
from .ingest import _agent_write_acc, _validate_balance_sender

router = APIRouter(prefix='/api/ingest', tags=['ingest'])


class BalanceObservationsIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: StrictInt
    account_email: str
    observations: list


@router.post('/balance-observations')
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
