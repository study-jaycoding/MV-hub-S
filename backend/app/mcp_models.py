"""Bounded, immutable AI batch inputs. Provider options contain no MCP metadata."""
from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import GenRequestIn, WorkspaceContext


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class McpPlanItem(StrictModel):
    label: str = Field(min_length=1, max_length=200)
    request: GenRequestIn
    estimated_credits: float = Field(ge=0)
    reference_snapshot: list[dict[str, Any]] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def check_request(self):
        r = self.request
        if r.kind != "create" or not r.create or not r.canvas_link or r.regenerate or r.idempotency_key:
            raise ValueError("MCP 계획에는 사전 카드 연결을 가진 create 요청만 허용합니다")
        if len(r.create.prompt) > 4000 or len(r.create.references) > 8 or not math.isfinite(self.estimated_credits):
            raise ValueError("프롬프트·자료·견적 범위가 올바르지 않습니다")
        return self


class McpPlanIn(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    context_id: str = Field(min_length=1, max_length=120)
    scene_id: str = Field(min_length=1, max_length=120)
    scene_hash: str = Field(min_length=1, max_length=128)
    workspace: WorkspaceContext
    items: list[McpPlanItem] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def check_items(self):
        if self.workspace.scope not in ("personal", "team"):
            raise ValueError("과금 워크스페이스를 확정하세요")
        links = [i.request.canvas_link for i in self.items]
        for field in ("attempt_id", "generation_id", "card_id"):
            if len({getattr(link, field) for link in links}) != len(links):
                raise ValueError("항목별 생성 연결 ID가 중복되었습니다")
        for item in self.items:
            if item.request.canvas_link.scene_id != self.scene_id or item.request.workspace != self.workspace:
                raise ValueError("계획과 생성 대상이 다릅니다")
        return self


class McpRevision(StrictModel):
    revision: int = Field(ge=0)


class McpApproval(McpRevision):
    source: Literal["app", "mcp"] = "app"


class McpItemUpdate(McpRevision):
    index: int = Field(ge=0, lt=20)
    state: Literal["submitting", "submitted", "uncertain", "rejected"]
    error: str | None = Field(default=None, max_length=1000)
