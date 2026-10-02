"""에셋 대장 도우미 PC 훑기 — **이 PC 전용**(로컬 허브). 설계: docs/ASSET_REGISTRY.md §10.

서버가 NAS 를 못 읽을 때 관리자 창의 [이 PC 에서 훑기]가 부른다. 이 PC 가 NAS 를 훑어 결과를 서버에 올린다
(services/asset_registry_helper). `/api/asset-registry/*`(서버 권위)와 접두사를 일부러 다르게 둔다 — _LOCAL_PREFIXES 로
이 PC 에서 처리한다. 권한(system)은 서버가 자리(lease)를 줄 때 막는다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import active_account
from ..services import shared_connection
from ..services.asset_registry import SCHEDULE_TICK_S
from ..services.asset_registry_helper import helper
from ..services.operational_logging import log_event
from . import _proxy, publish
from ._assets_access import require_local_assets

router = APIRouter(prefix="/api/registry-helper", tags=["asset-registry"])
_log = logging.getLogger("mvhub.asset_registry")
CLAIM_TIMEOUT_S = 10


# ── 정한 시간 자동 훑기 — 로컬 모드에서 '그 시간에 켜진 관리자 PC 한 대'(Jay 2026-10-02, 설계 r3) ─────────────
# 60초마다 공유 서버에 '이번 회차를 이 PC 가 맡나'를 묻는다. 회차 판정은 서버 시계로 서버가 한다(이 PC 시계는 안 씀).
# main 이 워커 허브·READ_ONLY 아님에서만 띄운다. 응답 유실이면 그 회차는 소비됐을 수 있다 — 결과 보장이 아니라
# '최대 한 PC 에 시도 기회'다(docs/ASSET_REGISTRY.md §11).
def _capture_context() -> Optional[tuple[str, str]]:
    """서버 주소·토큰·관리자 여부를 계정 전환 잠금 한 구간에서 함께 읽는다 — 다른 계정의 주소·토큰이 섞이지 않게(Codex r2).
    관리자가 아니면(로그인 때 저장한 역할 — 사전 거르기일 뿐, 서버가 다시 본다) None."""
    with active_account.transition_lock:
        if not _proxy.proxying() or not publish._is_admin():
            return None
        token = shared_connection.token()
        return (shared_connection.base_url(), token) if token else None


def _runner_name() -> str:
    name = "".join(ch for ch in os.environ.get("COMPUTERNAME", "") if ch.isprintable())[:40]
    return name or "PC"


def _claim(ctx: tuple[str, str]) -> bool:
    base, token = ctx
    request = urllib.request.Request(
        base + "/api/asset-registry/schedule/claim",
        data=json.dumps({"runner": _runner_name()}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=CLAIM_TIMEOUT_S) as response:
            data = json.loads(response.read() or b"{}")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False  # 권한 없음·옛 서버(404·405)·꺼짐(503)·연결 실패 — 조용히 다음 틱
    return bool(isinstance(data, dict) and data.get("run"))


async def schedule_loop() -> None:
    while True:
        await asyncio.sleep(SCHEDULE_TICK_S)
        try:
            ctx = await asyncio.to_thread(_capture_context)
            if ctx is None or helper.busy():
                continue
            if await asyncio.to_thread(_claim, ctx):
                started, why = helper.begin(None, mode="auto", ctx=ctx)
                log_event(_log, "asset_registry_scheduled", runner="this_pc", started=started, note=why)
        except Exception:  # noqa: BLE001 — 한 틱의 실패가 이후 회차를 없애지 않게
            _log.warning("asset_registry_schedule_claim_failed", exc_info=True)


class HelperScanIn(BaseModel):
    project_ids: list[Annotated[str, Field(max_length=64)]] = Field(default_factory=list, max_length=200)


@router.post("/scan", dependencies=[Depends(require_local_assets)])
async def scan(body: HelperScanIn) -> dict[str, Any]:
    if not _proxy.proxying():
        raise HTTPException(status_code=409, detail="공유 서버에 로그인한 앱에서만 쓸 수 있습니다")
    ok, why = helper.begin(body.project_ids or None)
    if not ok:
        raise HTTPException(status_code=409, detail=why)
    return {"started": True}


@router.get("/status", dependencies=[Depends(require_local_assets)])
def status() -> dict[str, Any]:
    # available — 이 PC 가 도우미가 될 수 있나(공유 서버에 로그인한 앱만. dev·격리 서버는 자기 자신이 서버다)
    return {**helper.helper_status(), "available": _proxy.proxying()}
