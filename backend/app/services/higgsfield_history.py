"""Higgsfield MCP의 커서 기반 생성 이력 조회.

공식 CLI의 ``generate list``는 최대 100건이지만, 같은 CLI OAuth 토큰은 MCP
``show_generations``에도 사용할 수 있다. 토큰은 이 모듈에 저장하지 않고 요청 헤더에만
잠깐 사용한다. 응답은 Streamable HTTP의 JSON 또는 SSE 한 이벤트 형식을 모두 받는다.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


MCP_ENDPOINT = "https://mcp.higgsfield.ai/mcp"


class HistoryFetchError(RuntimeError):
    """사용자에게 안전하게 보여줄 수 있는 과거 이력 조회 오류."""


@dataclass(frozen=True)
class HistoryPage:
    items: list[dict[str, Any]]
    next_cursor: int | float | str | None


def _decode_response(raw: bytes, content_type: str) -> dict[str, Any]:
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        raise HistoryFetchError("Higgsfield에서 빈 응답을 받았습니다")
    if "text/event-stream" in content_type.lower() or text.startswith("event:"):
        payload = None
        for line in text.splitlines():
            if line.startswith("data:"):
                candidate = line[5:].strip()
                if candidate and candidate != "[DONE]":
                    payload = candidate
                    break
        if payload is None:
            raise HistoryFetchError("Higgsfield 응답 형식을 읽지 못했습니다")
        text = payload
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HistoryFetchError("Higgsfield 응답 형식을 읽지 못했습니다") from exc
    if not isinstance(data, dict):
        raise HistoryFetchError("Higgsfield 응답 형식이 올바르지 않습니다")
    return data


def _post(token: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(MCP_ENDPOINT, data=body, method="POST")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json, text/event-stream")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _decode_response(
                response.read(), response.headers.get("Content-Type", "application/json")
            )
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise HistoryFetchError(
                "Higgsfield CLI 로그인이 만료되었습니다. CLI에 다시 로그인한 뒤 재시도하세요."
            ) from exc
        if exc.code == 429:
            raise HistoryFetchError(
                "Higgsfield 요청이 잠시 제한되었습니다. 잠시 뒤 다시 눌러주세요."
            ) from exc
        raise HistoryFetchError(f"Higgsfield 조회 실패(HTTP {exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HistoryFetchError("Higgsfield에 연결하지 못했습니다. 인터넷 연결을 확인하세요.") from exc


def _page_from_rpc(data: dict[str, Any]) -> HistoryPage:
    rpc_error = data.get("error")
    if rpc_error:
        message = rpc_error.get("message") if isinstance(rpc_error, dict) else str(rpc_error)
        raise HistoryFetchError(f"Higgsfield 조회 오류: {message or '알 수 없는 오류'}")
    result = data.get("result")
    if not isinstance(result, dict):
        raise HistoryFetchError("Higgsfield 조회 결과가 없습니다")
    if result.get("isError"):
        content = result.get("content") or []
        message = next(
            (
                str(block.get("text") or "").strip()
                for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            ),
            "Higgsfield가 조회를 거부했습니다",
        )
        raise HistoryFetchError(message)
    structured = result.get("structuredContent")
    if not isinstance(structured, dict):
        # 구형 MCP 응답은 content.text에 JSON을 담을 수 있다.
        for block in result.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            try:
                candidate = json.loads(str(block.get("text") or ""))
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                structured = candidate
                break
    if not isinstance(structured, dict):
        raise HistoryFetchError("Higgsfield 생성 이력 형식을 읽지 못했습니다")
    if structured.get("error"):
        raise HistoryFetchError(str(structured["error"]))
    raw_items = structured.get("items") or []
    if not isinstance(raw_items, list):
        raise HistoryFetchError("Higgsfield 생성 이력 목록이 올바르지 않습니다")
    items = [item for item in raw_items if isinstance(item, dict)]
    return HistoryPage(items=items, next_cursor=structured.get("next_cursor"))


async def fetch_page(
    token: str,
    cursor: int | float | str | None = None,
    *,
    size: int = 100,
    timeout: float = 60.0,
) -> HistoryPage:
    """``show_generations`` 한 페이지를 읽는다. 읽기 전용이며 생성/과금은 하지 않는다."""
    arguments: dict[str, Any] = {"size": max(1, min(int(size), 100))}
    if cursor is not None:
        arguments["cursor"] = cursor
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "show_generations", "arguments": arguments},
    }
    data = await asyncio.to_thread(_post, token, payload, timeout)
    return _page_from_rpc(data)
