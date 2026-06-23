"""MCP show_generations → CLI list 형태 매핑 (공유).

힉스필드 CLI `generate list` 는 최신 100개·페이지네이션 불가다. 100개 밖 과거 전체는
MCP `show_generations`(cursor/next_cursor 페이지네이션 지원)로만 닿는다. MCP 아이템은
필드명이 CLI 와 달라(model/results.rawUrl/createdAt) 여기서 CLI list 형태로 변환한 뒤
공통 경로(cli_bridge.parse_job → repo.upsert_synced_generation)로 흘려보낸다.

사용처:
  · routers/ingest.py `POST /api/ingest/mcp` — Claude 가 cursor 순회하며 페이지를 자동 적재.
  · backfill_import.py — 오프라인 JSON 덤프 import(같은 매핑 재사용).
"""

from __future__ import annotations

from typing import Any


def mcp_item_to_cli(item: dict[str, Any]) -> dict[str, Any]:
    """원시 MCP show_generations 아이템 → cli_bridge.parse_job 이 먹는 CLI list 형태.

    MCP:  {id, status, model, params{prompt, medias|input_images}, results{rawUrl}, createdAt}
    CLI : {id, status, job_set_type, result_url, created_at, params}
    """
    params = dict(item.get("params") or {})

    # 결과물 URL — results.rawUrl(객체) 또는 배열 첫 원소.
    results = item.get("results") or {}
    raw_url = None
    if isinstance(results, dict):
        raw_url = results.get("rawUrl") or results.get("url") or results.get("minUrl")
    elif isinstance(results, list) and results:
        r0 = results[0] or {}
        raw_url = r0.get("rawUrl") or r0.get("url")

    # 레퍼런스 — medias 가 있으면 그대로, 없고 input_images 만 있으면 medias 형태로 합성.
    if not params.get("medias") and params.get("input_images"):
        params["medias"] = [
            {
                "role": img.get("role") or "image",
                "data": {
                    "id": img.get("id"),
                    "url": img.get("url"),
                    "type": img.get("type"),
                },
            }
            for img in params.get("input_images") or []
            if isinstance(img, dict) and img.get("url")
        ]

    return {
        "id": item.get("id"),
        "status": item.get("status"),
        "job_set_type": item.get("model"),
        "display_name": item.get("model"),
        "result_url": raw_url,
        "created_at": item.get("createdAt"),
        "params": params,
    }
