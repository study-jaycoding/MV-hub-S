"""에셋 대장 도우미 PC 훑기 — **이 PC 전용**(로컬 허브). 설계: docs/ASSET_REGISTRY.md §10.

서버가 NAS 를 못 읽을 때 관리자 창의 [이 PC 에서 훑기]가 부른다. 이 PC 가 NAS 를 훑어 결과를 서버에 올린다
(services/asset_registry_helper). `/api/asset-registry/*`(서버 권위)와 접두사를 일부러 다르게 둔다 — _LOCAL_PREFIXES 로
이 PC 에서 처리한다. 권한(system)은 서버가 자리(lease)를 줄 때 막는다.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..services.asset_registry_helper import helper
from . import _proxy
from ._assets_access import require_local_assets

router = APIRouter(prefix="/api/registry-helper", tags=["asset-registry"])


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
