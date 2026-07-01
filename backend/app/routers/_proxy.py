"""서버 직결 프록시 헬퍼 — 로컬 허브의 '데이터' 요청을 팀 공유 서버로 중계한다.

하이브리드 모델(plan): 파일 I/O·CLI 는 로컬 허브가 직접 처리하고, 순수 데이터(메타·생성물)는
이 헬퍼로 **저장된 공유 서버 토큰**을 달아 공유 서버에 위임한다. 브라우저는 계속 로컬 허브 한
곳만 호출(단일 오리진) → CORS·브라우저 토큰노출 없음.

`publish.py:_http_json` 와 같은 stdlib 방식(새 의존성 0)이되, 비-2xx 응답을 그대로
`HTTPException` 으로 재발생해 프론트가 서버의 detail 을 보게 한다(detail 객체는 그대로 전달 —
프론트 jsonFetch 가 안전 문자열화함).
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .. import repo
from ..config import AUTH_ENABLED

_K_URL = "shared_server_url"
_K_TOKEN = "shared_server_token"
_K_ELEV_TOKEN = "shared_server_elev_token"  # 임시 관리자 권한 토큰(계정관리 호출에만)

# publish.py 와 동일한 기본값(한 곳에서 바꾸면 양쪽 반영되도록 env 우선).
_DEFAULT_URL = (os.environ.get("CONTENT_HUB_SHARED_URL") or "http://192.168.1.199:8010").rstrip("/")


def base_url() -> str:
    return (repo.get_setting(_K_URL) or _DEFAULT_URL).rstrip("/")


def token() -> Optional[str]:
    return repo.get_setting(_K_TOKEN)


def elevation_token() -> Optional[str]:
    return repo.get_setting(_K_ELEV_TOKEN)


def proxying() -> bool:
    """이 프로세스가 '로컬 허브'(데이터를 공유 서버에 위임)인가?

    서버 직결 하이브리드: 공유 서버 토큰이 있는 AUTH-off 허브면 위임 모드. 서버 본체(AUTH on)는
    토큰이 없으니 자기 repo 로 처리한다(같은 코드가 양쪽에서 돌아도 모드로 갈림).

    ★CONTENT_HUB_NO_PROXY=1: 위임을 강제 OFF — 저장된 공유서버 토큰이 있어도 모든 요청을
    로컬에서 직접 처리한다. 격리 테스트(run-test.bat)가 운영 공유서버에 전혀 안 닿게 하는 스위치."""
    if os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in ("1", "true", "yes", "on"):
        return False
    return not AUTH_ENABLED and bool(token())


def _qs(params: Optional[dict[str, Any]]) -> str:
    if not params:
        return ""
    flat = {k: v for k, v in params.items() if v is not None}
    return ("?" + urllib.parse.urlencode(flat, doseq=True)) if flat else ""


def raw_request(
    method: str,
    url: str,
    *,
    token: Optional[str] = None,
    body: Optional[Any] = None,
    timeout: int = 60,
) -> tuple[int, Any]:
    """공유 서버로 보내는 저수준 stdlib HTTP(새 의존성 0). `(status, parsed|text)` 반환.
    연결 실패만 502 로 올리고, 4xx/5xx 는 (code, 본문)으로 돌려준다(호출자가 해석).
    proxy_json(raise 계약)과 publish._http_json(tuple 계약) 양쪽의 단일 구현."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        detail: Any = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)
        except (ValueError, TypeError):
            pass
        return e.code, detail
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


def proxy_json(
    method: str,
    path: str,
    *,
    body: Optional[Any] = None,
    params: Optional[dict[str, Any]] = None,
    require_token: bool = True,
    timeout: int = 60,
    raw_query: Optional[str] = None,
) -> Any:
    """공유 서버 {base}{path} 로 위임하고 성공 본문(parsed JSON)을 반환.

    - 토큰이 없고 require_token 이면 401(로그인 유도).
    - 서버가 비-2xx 면 그 status·detail 을 그대로 HTTPException 으로 재발생.
    - 연결 실패는 502.
    - raw_query: 원 요청의 쿼리스트링을 그대로 붙일 때(다중값 colors/tags 보존). params 보다 우선.
    """
    tok = token()
    if require_token and not tok:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 필요합니다")

    qs = ("?" + raw_query) if raw_query else _qs(params)
    url = base_url() + path + qs
    status, parsed = raw_request(method, url, token=tok, body=body, timeout=timeout)
    if 200 <= status < 300:
        return parsed
    detail = parsed.get("detail") if isinstance(parsed, dict) and "detail" in parsed else parsed
    if status == 401:
        # 토큰 만료/무효 → 다음 status 조회가 게이트를 다시 띄우게 토큰을 비운다.
        try:
            repo.set_setting(_K_TOKEN, None)
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 만료됐습니다(다시 로그인)")
    raise HTTPException(status_code=status, detail=detail)


def proxy_get(path: str, request: Request) -> Any:
    """현재 GET 요청을 쿼리스트링 그대로 공유 서버에 위임하고 parsed JSON 반환.
    로컬우선 모델에서 'tab=team 목록'이나 '팀(서버) 항목 상세'를 조회할 때 핸들러가 호출한다."""
    return proxy_json("GET", path, raw_query=request.url.query or None)


# ── 중앙 데이터-프록시 미들웨어 ──────────────────────────────────────────────
# 로컬 허브(위임 모드)에서 '데이터' 요청을 통째로 공유 서버로 중계한다. 라우터 40여 개를 개별
# 수정하지 않고 한 곳에서 처리 — 로컬-전용(파일 I/O·CLI·에이전트연결·실행큐)만 allow-list 로
# 빼고 나머지 /api/* 는 전부 서버로 보낸다. 서버 본체(AUTH on)·미로그인 허브는 통과(자기 처리).

# 로컬에서 직접 처리해야 하는 경로 — 이 PC 의 자원(디스크·CLI·에이전트·실행)에 의존.
_LOCAL_PREFIXES = (
    "/api/assets/",        # 파일 I/O(트리/파일/썸/업로드/zip/reveal/마운트) — assets.py 가 메타만 자체 프록시
    "/api/gen-requests",   # 로컬 실행 큐(에이전트가 폴링해 자기 CLI 로 실행)
    "/api/agent/",         # 에이전트 롱폴·상태·다운로드(이 허브에 붙음)
    "/api/models",         # CLI 모델 목록·params
    "/api/workspaces",     # CLI 워크스페이스
    "/api/shared-server/", # 공유 서버 로그인/토큰/주소(이 허브의 로컬 설정)
    # ── 로컬 우선: 내 작업 데이터는 로컬 DB가 정답. 핸들러가 tab=team/팀항목일 때만 서버로 위임.
    "/api/generations",    # 목록·상세·히스토리·코멘트·태그·컬러·소스·발행 등(내 것=로컬, 팀=핸들러가 프록시)
    "/api/creators",       # 생성자 목록(my=로컬, team=핸들러 프록시)
    "/api/sources",        # 내 소스 라이브러리(로컬)
    "/api/auto-tags",      # 전역 태그(계정별 owner_uid, 로컬)
    "/api/trash",          # 내 휴지통(로컬)
    "/api/db/",            # 내 로컬 DB 내보내기/가져오기(교차 PC 연속성, 서버 무관)
    "/api/ingest",         # 에이전트→내 로컬 DB 동기화(generate list·mcp·known-jobs). 팀크레딧만 서버로 전달
    "/api/projects",       # 목록=하이브리드(서버 정의+로컬 카운트)·assign=로컬, 생성/역할 등 관리는 핸들러가 프록시
    "/api/manage/project-folders",  # PM 폴더 트리만 로컬(이 PC/테스트 DB 기준). 나머지 manage(작업·일정·크레딧·통계)는 팀 공유라 서버로 프록시.
)
_LOCAL_EXACT = frozenset(
    {
        "/api/health",
        "/api/cost",          # CLI 비용 추정
        "/api/account",       # CLI 계정 상태(워크스페이스/크레딧 원천)
        "/api/sync",          # CLI 수동 동기화
        "/api/media-thumb",   # 로컬 보관 미디어 썸네일
        "/api/download",      # 원격 미디어 → attachment 스트리밍(이 PC 가 직접 받아 브라우저로)
        "/api/publish-to-shared",  # 자체적으로 서버와 통신(이중 프록시 방지)
        "/api/backups",
        "/api/backup",
        "/api/facets",     # 필터 facet(컬러/태그/생성자) — my=로컬, team=핸들러 프록시
        "/api/manage/save-finals",  # 완료본을 이 PC 렌더 폴더(Z:\…)에 저장 — 반드시 로컬 실행(서버엔 디스크 없음)
        # ★ /api/auth/config 만 로컬(게이트가 auth_enabled 로 ServerLoginScreen 판정).
        #   나머지 /api/auth/*(accounts·me·global-roles·status·password 등)는 서버 계정을
        #   다루므로 프록시 — 안 그러면 관리자탭이 빈 로컬 계정을 조회한다.
        "/api/auth/config",
    }
)


def is_local_path(path: str) -> bool:
    """이 경로를 로컬에서 처리해야 하나(=프록시하면 안 되나)?"""
    if not path.startswith("/api/"):
        return True  # SPA·/media·/ws·정적 — 전부 로컬
    if path in _LOCAL_EXACT:
        return True
    return path.startswith(_LOCAL_PREFIXES)


async def _forward(request: Request) -> Response:
    """원 요청(메서드·경로·쿼리·바디)을 공유 서버로 그대로 중계하고 응답을 verbatim 반환."""
    body = await request.body()
    qs = request.url.query
    url = base_url() + request.url.path + (("?" + qs) if qs else "")
    # 계정관리(/api/auth/accounts*)는 임시 관리자(elev) 토큰이 있으면 그걸로 — 본인이 admin 아니어도 승인 가능.
    used_elev = request.url.path.startswith("/api/auth/accounts") and bool(elevation_token())
    tok = elevation_token() if used_elev else token()
    method = request.method
    ctype = request.headers.get("content-type")

    def _do() -> tuple[int, bytes, str]:
        req = urllib.request.Request(url, data=body if body else None, method=method)
        if ctype:
            req.add_header("Content-Type", ctype)
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(), (r.headers.get_content_type() or "application/json")
        except urllib.error.HTTPError as e:
            ct = e.headers.get_content_type() if e.headers else "application/json"
            return e.code, e.read(), (ct or "application/json")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            payload = json.dumps({"detail": f"공유 서버 연결 실패: {e}"}).encode()
            return 502, payload, "application/json"

    status, raw, resp_ctype = await asyncio.to_thread(_do)
    if status == 401:
        try:
            # elev 토큰으로 보낸 계정관리 호출이 401 → 임시 권한만 해제(본인 세션 토큰은 보존).
            repo.set_setting(_K_ELEV_TOKEN if used_elev else _K_TOKEN, None)
        except Exception:  # noqa: BLE001
            pass
    elif status < 400 and method in ("POST", "PUT", "PATCH", "DELETE"):
        # 위임 성공한 쓰기 → 이 허브의 다른 탭도 즉시 새로고침(로컬 WS).
        try:
            from ..ws import manager

            manager.notify_mutation()
        except Exception:  # noqa: BLE001
            pass
    return Response(content=raw, status_code=status, media_type=resp_ctype)


async def data_proxy_middleware(request: Request, call_next):
    """위임 모드 + 데이터 경로면 서버로 중계, 아니면 로컬 처리."""
    if proxying() and not is_local_path(request.url.path):
        return await _forward(request)
    return await call_next(request)
