"""동기화 라우터 (Phase 2/3 보조).

`higgsfield generate list --json` 을 끌어와 로컬 DB 에 업서트한다.
이걸로 라이브러리가 실제 생성 이력으로 채워진다.

CLAUDE.md 원칙 2(자동 동기화 금지)에 따라 **사용자가 명시적으로 호출**할 때만
동작한다. 시작 시 자동 실행하지 않는다. job id 를 PK 로 써서 재동기는 멱등.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..repo import manage
from ..services import cli_bridge, syncer

router = APIRouter(prefix="/api", tags=["sync"])


@router.get("/sync-status")
def sync_status():
    """로컬 텔레메트리 outbox 의 push 대기·실패 상태(관측성) — 조용히 묻히던 매니징 push 실패를 노출.
    ★로컬 허브 자기 상태라 프록시하지 않는다(_proxy _LOCAL_EXACT). 동작은 안 바꾸고 '기록만' 읽는다."""
    return manage.telemetry_outbox_status()


class SyncResult(BaseModel):
    fetched: int
    inserted: int
    updated: int


@router.post("/sync", response_model=SyncResult)
async def sync_from_cli(worker_id: str | None = None):
    """CLI 에서 최근 생성 이력을 가져와 로컬 DB 업서트(수동 즉시 동기화).
    백그라운드 주기 동기화(services/syncer)도 같은 로직을 공유한다."""
    try:
        c = await syncer.sync_now(worker_id)
    except cli_bridge.CLIError as e:
        raise HTTPException(status_code=502, detail=f"CLI 동기화 실패: {e}")
    return SyncResult(fetched=c["fetched"], inserted=c["inserted"], updated=c["updated"])
