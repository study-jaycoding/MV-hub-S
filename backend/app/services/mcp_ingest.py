"""MCP show_generations → CLI list 형태 매핑 (공유).

힉스필드 CLI `generate list` 는 최신 100개·페이지네이션 불가다. 100개 밖 과거 전체는
MCP `show_generations`(cursor/next_cursor 페이지네이션 지원)로만 닿는다. MCP 아이템은
필드명이 CLI 와 달라(model/results.rawUrl/createdAt) 여기서 CLI list 형태로 변환한 뒤
공통 경로(cli_bridge.parse_job → repo.upsert_synced_generation)로 흘려보낸다.

사용처:
  · routers/ingest.py 과거 전체 가져오기 — 앱이 cursor 끝까지 자동 조회·적재.
  · routers/ingest.py `POST /api/ingest/mcp` — 구버전 수동 가져오기 호환 API.
  · backfill_import.py — 오프라인 복구 도구(같은 매핑 재사용).
"""

from __future__ import annotations

from typing import Any, Optional

from .media_types import media_type_from_url, same_media_url


def mcp_item_to_cli(item: dict[str, Any]) -> dict[str, Any]:
    """원시 MCP show_generations 아이템 → cli_bridge.parse_job 이 먹는 CLI list 형태.

    MCP:  {id, status, model, params{prompt, medias|input_images}, results{rawUrl}, createdAt}
    CLI : {id, status, job_set_type, result_url, created_at, params}
    """
    # 원시 MCP/덤프 입력은 형식 보장이 없다 — dict 가 아니면 그 항목만 버린다(전체 500 방지).
    raw_params = item.get("params")
    params = dict(raw_params) if isinstance(raw_params, dict) else {}

    # 결과물 URL — results.rawUrl(객체) 또는 배열 첫 원소. 비어 있지 않은 문자열만 URL 로 인정한다
    # (dict/list 같은 값이 통과하면 parse_job 의 정규식·lower() 경로에서 예외 → 페이지 전체 적재 중단).
    results = item.get("results") or {}
    res_obj: dict[str, Any] = (
        results
        if isinstance(results, dict)
        else (results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else {})
    )

    def _url(key: str) -> Optional[str]:
        value = res_obj.get(key)
        return value if isinstance(value, str) and value.strip() else None

    # MCP 항목은 type 을 명시한다(image|video). 확장자 없는 결과 URL 이 image 로 오분류되지 않게
    # parse_job 까지 전달한다(result_media_type). 그 외 값은 명시로 치지 않는다.
    explicit_type = item.get("type") if item.get("type") in ("image", "video") else None
    raw_url = _url("rawUrl") or _url("url")
    # 입력 미디어 URL — 아래 썸네일/축소본이 '결과'가 아니라 '입력'인지 가리는 기준.
    input_urls: list[str] = []
    for media in (params.get("medias") or []) if isinstance(params.get("medias"), list) else []:
        data = media.get("data") if isinstance(media, dict) else None
        url = data.get("url") if isinstance(data, dict) else None
        if isinstance(url, str) and url:
            input_urls.append(url)
    for img in (params.get("input_images") or []) if isinstance(params.get("input_images"), list) else []:
        url = img.get("url") if isinstance(img, dict) else None
        if isinstance(url, str) and url:
            input_urls.append(url)

    def _is_input(url: Optional[str]) -> bool:
        return any(same_media_url(url, candidate) for candidate in input_urls)

    is_video = explicit_type == "video" or media_type_from_url(raw_url) == "video"
    min_url = _url("minUrl") or _url("min_result_url")
    if min_url and _is_input(min_url):
        min_url = None
    # 축소본을 결과 URL 로 폴백하는 것은 객체형 results 의 이미지 항목에서만(종전 동작). 영상의 minUrl 은
    # 입력 이미지일 수 있어 결과로 승격하지 않는다 → rawUrl/url 이 없으면 asset 을 만들지 않는다.
    if not raw_url and isinstance(results, dict) and not is_video and min_url:
        raw_url = min_url

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

    # 썸네일 — ★2026-08-27 실측: MCP show_generations 의 영상 항목 results.thumbnailUrl 은 결과 포스터가
    # 아니라 첫 입력 이미지(params.medias[0].data.url)와 같다(영상 100건 표본: 썸네일 있는 59건 중 57건 동일,
    # 진짜 포스터 0건). 그대로 asset.thumbnail_path 로 쓰면 라이브러리·캔버스에 레퍼런스 시트가 영상 포스터로
    # 뜬다. 영상은 무조건 버리고(진짜 포스터는 CLI generate get 이 준다), 이미지도 입력과 같은 값은 버린다.
    thumb_url = None if is_video else (_url("thumbnailUrl") or _url("thumbUrl") or _url("posterUrl"))
    if thumb_url and _is_input(thumb_url):
        thumb_url = None
    if explicit_type == "video":
        min_url = None  # 영상 축소본(minUrl)도 입력 이미지일 수 있고 영상엔 쓰이지 않는다.
    return {
        "id": item.get("id"),
        "status": item.get("status"),
        "job_set_type": item.get("model"),
        "display_name": item.get("model"),
        "result_url": raw_url,
        "result_media_type": explicit_type,
        "thumbnail_url": thumb_url,
        "min_result_url": min_url,
        "created_at": item.get("createdAt"),
        "params": params,
        # MCP/덤프가 제공한 생성 당시 workspace 를 parse_job까지 전달한다. 값이 불완전하면
        # parse_job의 공통 정규화가 unknown으로 축소하며, 현재 선택값으로 추측하지 않는다.
        **(
            {"workspace": item.get("workspace")}
            if "workspace" in item
            else {
                key: item.get(key)
                for key in ("workspace_scope", "workspace_id", "workspace_name")
                if key in item
            }
        ),
    }
