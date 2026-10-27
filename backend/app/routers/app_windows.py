"""앱 별도 창 API — 로컬 허브(이 PC)에서만. 앱 창이 다른 프로그램에서 돌아올 때 떠 있는 별도 창을 그 위로 올린다(services/app_windows)."""

from __future__ import annotations

import os
from typing import Annotated

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from . import _proxy
from ..services import app_windows
from ..services.request_guards import require_local_machine_request

router = APIRouter(prefix="/api/app-windows", tags=["app-windows"])

_Title = Annotated[str, Field(min_length=1, max_length=200)]


class RaiseIn(BaseModel):
    main: _Title  # 앱 창 제목 — 맨 앞 창이 이 창일 때만 올린다
    titles: list[_Title] = Field(min_length=1, max_length=8)  # 떠 있는 별도 창 제목


@router.post("/raise")
def raise_windows(body: RaiseIn, request: Request):
    require_local_machine_request(request, "이 PC 에서만 쓸 수 있습니다")
    if os.name != "nt" or _proxy.is_shared_team_server():
        return {"raised": 0}
    return {"raised": app_windows.raise_over_foreground(body.main, body.titles)}
