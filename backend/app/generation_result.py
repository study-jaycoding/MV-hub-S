"""CLI 파싱 결과를 generation 저장 필드로 바꾸는 공통 순수 규칙.

에이전트 fulfill, 수동 reconcile, 서버 주기 reconcile 이 모두 이 모듈을 사용한다.
DB·FastAPI·CLI 호출에는 의존하지 않아 경로별 결과 차이 없이 단위 테스트할 수 있다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional


# 진행/성공 상태에서는 과거 오류를 지우고, failed·nsfw 같은 종료 상태에서만 사유를 보존한다.
ACTIVE_STATUSES = {"done", "pending", "running"}


def stored_error(status: str, error: Optional[str]) -> Optional[str]:
    return error if status not in ACTIVE_STATUSES else None


@dataclass(frozen=True, slots=True)
class NormalizedJobResult:
    job_id: Optional[str]
    status: str
    error: Optional[str]
    asset_type: Optional[str]
    asset_path: Optional[str]
    asset_thumb: Optional[str]
    created_at: Any
    sort_ts: Any


def normalize_job_result(parsed: Mapping[str, Any]) -> NormalizedJobResult:
    """``cli_bridge.parse_job`` 결과에서 세 저장 경로가 공통으로 쓰는 필드를 만든다."""
    generation = parsed.get("generation") or {}
    asset = parsed.get("asset")
    status = generation.get("status") or "done"

    asset_type = asset["type"] if asset else None
    asset_path = asset["file_path"] if asset else None
    asset_thumb = None
    if asset:
        asset_thumb = (
            asset.get("min_result_url") or asset["file_path"]
            if asset["type"] == "image"
            else asset.get("thumbnail_url")
        )

    return NormalizedJobResult(
        job_id=generation.get("id"),
        status=status,
        error=stored_error(status, generation.get("error")),
        asset_type=asset_type,
        asset_path=asset_path,
        asset_thumb=asset_thumb,
        created_at=generation.get("created_at"),
        sort_ts=generation.get("sort_ts"),
    )
