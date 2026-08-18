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
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextvars import ContextVar
from typing import Any, Optional

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .. import repo
from ..config import AUTH_ENABLED
from ..mutation_notify import (
    CLIENT_ID_HEADER,
    DOMAIN_ASSETS,
    DOMAIN_LIBRARY,
    DOMAIN_MANAGE,
    MUTATION_DOMAINS_HEADER,
    MUTATION_ID_HEADER,
    notification_domains,
    parse_mutation_origin,
)

_K_URL = "shared_server_url"
_K_TOKEN = "shared_server_token"
_K_ELEV_TOKEN = "shared_server_elev_token"  # 임시 관리자 권한 토큰(계정관리 호출에만)

# 401의 의미를 브라우저까지 보존한다. `invalid`만 실제 세션 만료이며 `preserved`는
# 요청 자체가 거부됐을 뿐 저장된 로그인은 유지됐다는 뜻이다.
AUTH_STATE_HEADER = "X-MVHub-Auth-State"
AUTH_STATE_INVALID = "invalid"
AUTH_STATE_PRESERVED = "preserved"

# 같은 화면의 여러 요청이 한꺼번에 401을 받아도 /api/auth/me 확인을 한 번만 수행한다.
# 네트워크 왕복은 짧은 TTL 동안만 공유하고, 판정 불가도 잠깐 캐시해 장애 중 확인 폭주를 막는다.
_AUTH_PROBE_TTL_SECONDS = 2.0
_AUTH_PROBE_TIMEOUT_SECONDS = 5
_AUTH_PROBE_LOCK = threading.Lock()
_AUTH_PROBE_CACHE: dict[tuple[str, str], tuple[float, str]] = {}
_AUTH_PROBE_IN_FLIGHT: set[tuple[str, str]] = set()

# 로컬 처리 라우터가 내부에서 proxy_json을 호출해도 원 브라우저 요청의 출처를 서버까지 보존한다.
# ContextVar라 동시 요청·FastAPI threadpool·asyncio.to_thread 사이에서 서로 섞이지 않는다.
_REQUEST_MUTATION_ORIGIN: ContextVar[Optional[tuple[str, str]]] = ContextVar(
    "proxy_request_mutation_origin", default=None
)

# publish.py 와 동일한 기본값(한 곳에서 바꾸면 양쪽 반영되도록 env 우선).
_DEFAULT_URL = (os.environ.get("CONTENT_HUB_SHARED_URL") or "http://192.168.1.199:8010").rstrip("/")


def base_url() -> str:
    return (repo.get_setting(_K_URL) or _DEFAULT_URL).rstrip("/")


def token() -> Optional[str]:
    return repo.get_setting(_K_TOKEN)


def elevation_token() -> Optional[str]:
    return repo.get_setting(_K_ELEV_TOKEN)


def is_worker_hub() -> bool:
    """이 프로세스가 워커의 로컬 허브인가 — proxying() 과 달리 **토큰을 요구하지 않는다**.

    버전 게이트(/api/cli-check)용: 아직 허브 로그인 전(토큰 없음)인 워커도 공개 /api/health 로
    서버 버전을 확인해 stale 코드가 게이트를 우회하지 못하게 한다(코덱스 리뷰). 서버 본체(AUTH on)·
    격리 테스트(NO_PROXY)면 False — 서버는 자기 자신을 조회할 필요 없고, 테스트는 운영서버에 안 닿는다."""
    if os.environ.get("CONTENT_HUB_NO_PROXY", "").lower() in ("1", "true", "yes", "on"):
        return False
    return not AUTH_ENABLED


def proxying() -> bool:
    """이 프로세스가 '로컬 허브'(데이터를 공유 서버에 위임)인가?

    서버 직결 하이브리드: 공유 서버 토큰이 있는 AUTH-off 허브면 위임 모드. 서버 본체(AUTH on)는
    토큰이 없으니 자기 repo 로 처리한다(같은 코드가 양쪽에서 돌아도 모드로 갈림).

    ★CONTENT_HUB_NO_PROXY=1: 위임을 강제 OFF — 저장된 공유서버 토큰이 있어도 모든 요청을
    로컬에서 직접 처리한다. 격리 테스트(test_push-db.bat/test_dev_server.bat)가 운영 공유서버에
    전혀 안 닿게 하는 스위치."""
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
    mutation_origin: Optional[tuple[str, str]] = None,
) -> tuple[int, Any]:
    """공유 서버로 보내는 저수준 stdlib HTTP(새 의존성 0). `(status, parsed|text)` 반환.
    연결 실패만 502 로 올리고, 4xx/5xx 는 (code, 본문)으로 돌려준다(호출자가 해석).
    proxy_json(raise 계약)과 publish._http_json(tuple 계약) 양쪽의 단일 구현."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if mutation_origin:
        req.add_header(CLIENT_ID_HEADER, mutation_origin[0])
        req.add_header(MUTATION_ID_HEADER, mutation_origin[1])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw.decode() or "null")
            except (ValueError, UnicodeDecodeError) as exc:
                # 캡티브 포털·게이트웨이가 200 + HTML 을 주는 경우 — 서버 문제인데 그대로
                # 올리면 로컬 허브의 500(우리 버그처럼)이 됐다. 502 로 정확히 진단.
                raise HTTPException(
                    status_code=502,
                    detail=f"공유 서버 응답이 JSON 이 아닙니다(프록시/포털 간섭 의심): {raw[:120]!r}",
                ) from exc
    except urllib.error.HTTPError as e:
        detail: Any = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)
        except (ValueError, TypeError):
            pass
        return e.code, detail
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


def _probe_token_state(tok: Optional[str]) -> str:
    """같은 토큰의 `/api/auth/me`로 세션 상태를 확정한다.

    401만 `invalid`다. 2xx는 `valid`, 연결 실패·5xx·예상 밖 응답은 `unknown`으로 보존한다.
    확인 중 네트워크 오류를 세션 만료로 추측하면 원래 문제(로컬 모드 오전환)가 재발한다.
    """
    if not tok:
        return AUTH_STATE_INVALID
    server = base_url()
    key = (server, tok)
    now = time.monotonic()
    with _AUTH_PROBE_LOCK:
        cached = _AUTH_PROBE_CACHE.get(key)
        if cached and cached[0] > now:
            return cached[1]
        if key in _AUTH_PROBE_IN_FLIGHT:
            # 첫 확인 요청만 네트워크를 사용한다. 같은 순간의 나머지 401은 기다리지 않고
            # 판정 불가로 로그인 상태를 보존해 FastAPI/asyncio threadpool 고갈을 막는다.
            return "unknown"
        _AUTH_PROBE_IN_FLIGHT.add(key)

    try:
        try:
            status, _ = raw_request(
                "GET",
                f"{server}/api/auth/me",
                token=tok,
                timeout=_AUTH_PROBE_TIMEOUT_SECONDS,
            )
            if status == 401:
                state = AUTH_STATE_INVALID
            elif 200 <= status < 300:
                state = "valid"
            else:
                state = "unknown"
        except HTTPException:
            state = "unknown"
    finally:
        with _AUTH_PROBE_LOCK:
            _AUTH_PROBE_IN_FLIGHT.discard(key)

    with _AUTH_PROBE_LOCK:
        # 현재 프로세스에는 일반·임시 관리자 토큰 몇 개만 존재한다. 그래도 테스트·계정 전환으로
        # 오래된 키가 쌓이지 않게 만료 항목을 지우고 작은 상한을 둔다.
        expired = [cache_key for cache_key, value in _AUTH_PROBE_CACHE.items() if value[0] <= now]
        for cache_key in expired:
            _AUTH_PROBE_CACHE.pop(cache_key, None)
        if len(_AUTH_PROBE_CACHE) >= 8:
            oldest = min(_AUTH_PROBE_CACHE, key=lambda cache_key: _AUTH_PROBE_CACHE[cache_key][0])
            _AUTH_PROBE_CACHE.pop(oldest, None)
        _AUTH_PROBE_CACHE[key] = (time.monotonic() + _AUTH_PROBE_TTL_SECONDS, state)
    return state


def _handle_auth_failure(setting_key: str, sent_token: Optional[str], path: str) -> str:
    """401을 확정 만료와 요청별 거부로 분류하고, 확정 만료 토큰만 지운다.

    `/api/auth/me` 자체의 401은 이미 권위 확인 결과라 재조회하지 않는다. 다른 경로는 같은
    토큰으로 me를 확인한다. 확인 뒤 토큰이 바뀌었으면 늦은 응답이 새 로그인을 지우지 않는다.
    """
    state = (
        AUTH_STATE_INVALID
        if path.rstrip("/") == "/api/auth/me"
        else _probe_token_state(sent_token)
    )
    if state != AUTH_STATE_INVALID:
        return AUTH_STATE_PRESERVED
    if sent_token:
        try:
            if repo.get_setting(setting_key) != sent_token:
                # 확인하는 사이 계정 전환·재로그인이 끝났다. 늦은 옛 응답은 새 세션의
                # UI 상태까지 만료로 바꾸면 안 된다.
                return AUTH_STATE_PRESERVED
            repo.set_setting(setting_key, None)
        except Exception:  # noqa: BLE001 — 판정 응답은 보존하고 다음 요청에서 다시 확인한다.
            return AUTH_STATE_PRESERVED
    return AUTH_STATE_INVALID


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
    status, parsed = raw_request(
        method,
        url,
        token=tok,
        body=body,
        timeout=timeout,
        mutation_origin=_REQUEST_MUTATION_ORIGIN.get(),
    )
    if 200 <= status < 300:
        return parsed
    detail = parsed.get("detail") if isinstance(parsed, dict) and "detail" in parsed else parsed
    if status == 401:
        auth_state = _handle_auth_failure(_K_TOKEN, tok, path)
        if auth_state == AUTH_STATE_INVALID:
            detail = "공유 서버 로그인이 만료됐습니다(다시 로그인)"
        raise HTTPException(
            status_code=401,
            detail=detail,
            headers={AUTH_STATE_HEADER: auth_state},
        )
    raise HTTPException(status_code=status, detail=detail)


def proxy_get(path: str, request: Request) -> Any:
    """현재 GET 요청을 쿼리스트링 그대로 공유 서버에 위임하고 parsed JSON 반환.
    로컬우선 모델에서 'tab=team 목록'이나 '팀(서버) 항목 상세'를 조회할 때 핸들러가 호출한다."""
    return proxy_json("GET", path, raw_query=request.url.query or None)


def stream_download(
    path: str,
    dest_tmp: "os.PathLike[str] | str",
    *,
    max_bytes: int = 2 * 1024 * 1024 * 1024,
    timeout: int = 300,
) -> int:
    """서버 {base}{path} 의 응답 본문을 1MiB 청크로 dest_tmp 파일에 저장(save-finals 위임 다운로드).

    raw_request 는 본문 전체를 read() 하므로 대용량(영상 최종본)에 금지 — 이 헬퍼가 유일한
    스트리밍 경로다. 상한·Content-Length 대조·디스크 여유 확인·실패 시 부분파일 정리까지 책임.
    동기(blocking) — 호출측이 asyncio.to_thread 로 오프로딩한다. 반환: 저장한 바이트 수."""
    tok = token()
    if not tok:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 필요합니다")
    req = urllib.request.Request(
        base_url() + path, headers={"Authorization": f"Bearer {tok}"}
    )
    dest = os.fspath(dest_tmp)
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            expected = None
            try:
                cl = int(r.headers.get("Content-Length") or 0)
                expected = cl if cl > 0 else None
            except (TypeError, ValueError):
                expected = None
            if expected is not None and expected > max_bytes:
                raise HTTPException(status_code=413, detail="원본이 너무 큼(상한 초과)")
            # 디스크 여유 — 크기를 알 때만(모르면 상한 검사와 쓰기 실패 처리에 맡긴다).
            if expected is not None:
                try:
                    free = shutil.disk_usage(os.path.dirname(dest) or ".").free
                    if free < expected + 64 * 1024 * 1024:  # 64MB 여유 마진
                        raise HTTPException(status_code=507, detail="대상 디스크 공간 부족")
                except OSError:
                    pass  # UNC 등 조회 실패 — 쓰기 오류로 잡힌다
            with open(dest, "wb") as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise HTTPException(status_code=413, detail="원본이 너무 큼(상한 초과)")
                    f.write(chunk)
            if expected is not None and total != expected:
                raise HTTPException(status_code=502, detail="다운로드 불완전(크기 불일치)")
        return total
    except HTTPException:
        _cleanup_file(dest)
        raise
    except urllib.error.HTTPError as e:
        _cleanup_file(dest)
        if e.code == 404:
            raise HTTPException(status_code=404, detail="서버에 원본이 없습니다")
        headers = None
        if e.code == 401:
            headers = {AUTH_STATE_HEADER: _handle_auth_failure(_K_TOKEN, tok, path)}
        raise HTTPException(
            status_code=e.code,
            detail=f"서버 다운로드 실패({e.code})",
            headers=headers,
        )
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        _cleanup_file(dest)
        raise HTTPException(status_code=502, detail=f"공유 서버 다운로드 실패: {e}")


def _cleanup_file(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


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
    "/api/comfy",          # ComfyUI 연결·파싱·실행(이 PC 의 로컬/Cloud 자원 — 서버 위임 금지)
    "/api/resolve/",       # Render 원본·@davinci 기록 저장 및 Resolve 제어(이 PC 디스크/앱 대상)
    "/api/release-update/",  # 작업자 설치본·프로세스를 교체하는 이 PC 전용 업데이트
    "/api/workspaces",     # CLI 워크스페이스
    "/api/stamp/",         # 끌어다 놓은 로컬 파일의 각인 읽기 — 파일이 이 PC 에 있으므로 로컬 처리
    "/api/shared-server/", # 공유 서버 로그인/토큰/주소(이 허브의 로컬 설정)
    # ── 로컬 우선: 내 작업 데이터는 로컬 DB가 정답. 핸들러가 tab=team/팀항목일 때만 서버로 위임.
    "/api/generations",    # 목록·상세·히스토리·코멘트·태그·컬러·소스·발행 등(내 것=로컬, 팀=핸들러가 프록시)
    "/api/generation-comments/",  # by-id 코멘트 수정/삭제/seen — 핸들러(_comment_local)가 비공개=로컬·공유=서버로 재분기.
                                  #   (프리픽스에서 빠지면 미들웨어가 먼저 서버로 보내 비공개 로컬 댓글 편집·seen 이 유실됨)
    "/api/creators",       # 생성자 목록(my=로컬, team=핸들러 프록시)
    "/api/sources",        # 내 소스 라이브러리(로컬)
    "/api/tags",           # 태그 삭제(개인 로컬 메타 — 읽기가 로컬이라 삭제도 로컬이어야 정합)
    "/api/auto-tags",      # 전역 태그(계정별 owner_uid, 로컬)
    "/api/trash",          # 내 휴지통(로컬)
    "/api/scenes",         # 캔버스 씬 DB 백업(개인 편집물 — 로컬 DB 미러. 서버 전송 금지)
    "/api/db/",            # 내 로컬 DB 내보내기/가져오기(교차 PC 연속성, 서버 무관)
    "/api/ingest",         # 에이전트→내 로컬 DB 동기화(generate list·mcp·known-jobs). 팀크레딧만 서버로 전달
    "/api/projects",       # 목록=하이브리드(서버 정의+로컬 카운트)·assign=로컬, 생성/역할 등 관리는 핸들러가 프록시
    "/api/manage/project-folders",  # PM 폴더 트리만 로컬(이 PC/테스트 DB 기준). 나머지 manage(작업·일정·크레딧·통계)는 팀 공유라 서버로 프록시.
)
_LOCAL_EXACT = frozenset(
    {
        "/api/health",
        "/api/cli-check",     # 코드핀 vs 서버 버전 게이트 — 로컬 허브가 서버를 대신 조회해 대조(프록시 금지)
        "/api/cost",          # CLI 비용 추정
        "/api/account",       # CLI 계정 상태(워크스페이스/크레딧 원천)
        "/api/sync",          # CLI 수동 동기화
        "/api/sync-status",   # 로컬 텔레메트리 outbox 상태(이 허브 자기 상태 — 서버 위임 금지)
        "/api/media-thumb",   # 로컬 보관 미디어 썸네일
        "/api/download",      # 원격 미디어 → attachment 스트리밍(이 PC 가 직접 받아 브라우저로)
        "/api/merge",         # View 타임라인 영상 병합(로컬 ffmpeg·디스크 작업 — 서버 위임 금지)
        "/api/publish-to-shared",  # 자체적으로 서버와 통신(이중 프록시 방지)
        "/api/backups",
        "/api/backup",
        "/api/facets",     # 필터 facet(컬러/태그/생성자) — my=로컬, team=핸들러 프록시
        "/api/cache-all",  # 전 generation 소스·결과물을 이 PC 디스크로 byte-cache(출처 영속화) — 로컬 실행(서버 디스크 대상 아님)
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
    # ★raw_path(퍼센트 인코딩 원본)를 쓴다. request.url.path 는 디코딩돼서 한글 태그 등이
    # 그대로 들어가면 urllib 이 URL 을 ascii 로 인코딩하다 터진다(태그 삭제 500의 원인).
    raw = request.scope.get("raw_path")
    path = raw.decode("latin-1") if raw else request.url.path
    url = base_url() + path + (("?" + qs) if qs else "")
    # 계정관리(/api/auth/accounts*)는 임시 관리자(elev) 토큰이 있으면 그걸로 — 본인이 admin 아니어도 승인 가능.
    used_elev = request.url.path.startswith("/api/auth/accounts") and bool(elevation_token())
    tok = elevation_token() if used_elev else token()
    method = request.method
    ctype = request.headers.get("content-type")
    client_id = request.headers.get(CLIENT_ID_HEADER)
    mutation_id = request.headers.get(MUTATION_ID_HEADER)

    def _do() -> tuple[int, bytes, str]:
        req = urllib.request.Request(url, data=body if body else None, method=method)
        if ctype:
            req.add_header("Content-Type", ctype)
        if client_id:
            req.add_header(CLIENT_ID_HEADER, client_id)
        if mutation_id:
            req.add_header(MUTATION_ID_HEADER, mutation_id)
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
    auth_state = None
    if status == 401:
        auth_state = await asyncio.to_thread(
            _handle_auth_failure,
            _K_ELEV_TOKEN if used_elev else _K_TOKEN,
            tok,
            request.url.path,
        )
    response = Response(content=raw, status_code=status, media_type=resp_ctype)
    if auth_state:
        response.headers[AUTH_STATE_HEADER] = auth_state
    domains = notification_domains(method, request.url.path, status)
    if domains:
        # 위임 성공한 쓰기 → 원격 서버의 WS와 별개로 이 로컬 허브의 창에도 즉시 알린다.
        try:
            from ..ws import manager

            origin = parse_mutation_origin(client_id, mutation_id)
            if DOMAIN_LIBRARY in domains:
                manager.notify_mutation(origin=origin)
            if DOMAIN_ASSETS in domains:
                manager.notify_domain("assets_changed", origin)
            if DOMAIN_MANAGE in domains:
                manager.notify_domain("manage_changed", origin)
            if origin:
                response.headers[MUTATION_ID_HEADER] = origin[1]
                response.headers[MUTATION_DOMAINS_HEADER] = ",".join(domains)
        except Exception:  # noqa: BLE001
            pass
    return response


# 대용량 바이트 경로 — 일반 _forward 는 응답 전체를 r.read() 로 메모리에 올리므로(영상 최종본
# GET 한 방에 수 GB), 이 접두사는 청크 스트리밍 중계로 우회한다(코덱스 P1).
_STREAM_PREFIX = "/api/manage/save-finals/content/"


async def _forward_stream(request: Request) -> Response:
    """GET 전용 스트리밍 중계 — 서버 응답을 1MiB 청크로 그대로 흘려보낸다(허브 메모리 상주 없음).
    Starlette 가 동기 제너레이터를 threadpool 에서 돌리므로 blocking read 여도 이벤트 루프 안전."""
    from fastapi.responses import StreamingResponse

    raw = request.scope.get("raw_path")
    path = raw.decode("latin-1") if raw else request.url.path
    qs = request.url.query
    url = base_url() + path + (("?" + qs) if qs else "")
    req = urllib.request.Request(url)
    tok = token()
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        upstream = await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        ct = e.headers.get_content_type() if e.headers else "application/json"
        response = Response(content=e.read(), status_code=e.code, media_type=ct or "application/json")
        if e.code == 401:
            response.headers[AUTH_STATE_HEADER] = await asyncio.to_thread(
                _handle_auth_failure, _K_TOKEN, tok, request.url.path
            )
        return response
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return Response(
            content=json.dumps({"detail": f"공유 서버 연결 실패: {e}"}).encode(),
            status_code=502,
            media_type="application/json",
        )

    def _iter():
        try:
            while True:
                chunk = upstream.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    headers = {}
    cl = upstream.headers.get("Content-Length")
    if cl:
        headers["Content-Length"] = cl  # 받는 쪽(브라우저·stream_download)이 크기 대조에 쓴다
    media_type = upstream.headers.get_content_type() or "application/octet-stream"
    return StreamingResponse(_iter(), status_code=upstream.status, media_type=media_type, headers=headers)


async def data_proxy_middleware(request: Request, call_next):
    """위임 모드 + 데이터 경로면 서버로 중계, 아니면 로컬 처리."""
    context_token = _REQUEST_MUTATION_ORIGIN.set(
        parse_mutation_origin(
            request.headers.get(CLIENT_ID_HEADER),
            request.headers.get(MUTATION_ID_HEADER),
        )
    )
    try:
        if proxying() and not is_local_path(request.url.path):
            if request.method == "GET" and request.url.path.startswith(_STREAM_PREFIX):
                return await _forward_stream(request)
            return await _forward(request)
        return await call_next(request)
    finally:
        _REQUEST_MUTATION_ORIGIN.reset(context_token)
