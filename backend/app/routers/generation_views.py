"""마지막으로 크게 열어본 생성물 — 개인 표시("Last viewed" 배지) 읽기/쓰기.

경로를 `/api/generations/...` 아래 두지 않는다. 두 가지가 걸린다:
  · library.router 가 generation.router 보다 먼저 등록되고 거기 `/generations/{gen_id}` 가 있어,
    `/generations/viewed` 는 gen_id="viewed" 로 잡혀 프록시 조회까지 간다.
  · 배지 이동은 라이브러리 변경이 아니다. mutation_notify 가 경로로 분류하므로 정확히
    맞출 수 있는 고정 경로여야 다른 창의 목록 재조회를 유발하지 않는다.

owner 는 서버가 actor_id 로 정한다 — 클라이언트는 owner 를 보내지 않는다(계정 혼선 방지,
routers/scenes.py 와 같은 규칙).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .. import repo
from ..deps import actor_id

router = APIRouter(prefix="/api/generation-views", tags=["generation-views"])


class ViewIn(BaseModel):
    generation_id: str
    scene_id: str = ""  # 캔버스 밖(목록·히스토리)이면 둘 다 빈 문자열
    card_id: str = ""


@router.get("")
def get_generation_views(request: Request, scene_id: str = ""):
    """그 씬의 묶음별 마지막 + 그 씬에서 마지막으로 본 카드. scene_id 없으면 캔버스 밖 행."""
    return repo.list_generation_views(actor_id(request), scene_id=scene_id)


@router.put("")
def put_generation_view(body: ViewIn, request: Request):
    """미리보기에 항목이 실제로 표시된 순간 1회 호출한다.

    로컬에 없는 생성물(팀 탭에서 본 남의 것)은 기록하지 않고 recorded=false 로 알린다 —
    저장한 척하고 조회에서 조용히 버리면 화면과 DB 가 어긋난다.
    """
    gen_id = (body.generation_id or "").strip()
    if not gen_id:
        raise HTTPException(400, "generation_id 가 필요합니다")
    try:
        saved = repo.record_generation_view(
            actor_id(request),
            gen_id,
            scene_id=body.scene_id,
            card_id=body.card_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"recorded": saved is not None, "view": saved}
