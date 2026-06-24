"""FastAPI 엔트리 (Phase 2/3).

앱 팩토리: 시작 시 DB 초기화 + 기본 작업자 시드, 잡 큐 워커 기동,
라우터·정적 미디어·WebSocket 마운트.

실행: uvicorn app.main:app  (backend/ 에서)
⚠️ Windows 에서는 --reload 금지 — SelectorEventLoop 이 강제돼 CLI subprocess 가 깨진다.
"""

from __future__ import annotations

import asyncio
import sys
import warnings
from contextlib import asynccontextmanager

# Windows 함정: CLI 브리지(asyncio subprocess)는 Proactor 이벤트 루프가 필요하다.
# 아래처럼 import 시점에 Proactor 정책을 박아두면 일반 실행(uvicorn app.main:app)에서는
# subprocess 가 동작한다. 단, uvicorn --reload 는 리로더가 SelectorEventLoop 을 강제하므로
# 이 정책으로도 막을 수 없다(NotImplementedError) → Windows 에서는 --reload 없이 실행.
if sys.platform == "win32":
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except Exception:
            pass

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import repo
from .config import AUTH_ENABLED, CORS_ORIGINS, FRONTEND_DIST, MEDIA_DIR, ensure_dirs
from .db import init_db
from .deps import session_token
from .routers import (
    _proxy,
    assets,
    auth,
    db_transfer,
    gen_requests,
    generation,
    ingest,
    library,
    members,
    projects,
    publish,
    share,
    sync,
)
from .services import auth as auth_svc
from .services.backup import periodic_backup
from .services.syncer import periodic_sync
from .ws import manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 시작: DB 스키마 적용(멱등) + 기본 작업자 + 미디어 디렉터리 + 잡 큐 워커
    init_db()
    ensure_dirs()
    repo.ensure_default_worker()
    # 부트스트랩 관리자 — 서버(AUTH on)면 admin 계정을 자동 생성(없을 때만). '따로 안 만들어도
    # 처음부터 admin 이 있게'. 기본 admin@millionvolt.com / admin1985, env 로 변경 가능.
    if AUTH_ENABLED:
        import os as _os

        _ae = (_os.environ.get("CONTENT_HUB_ADMIN_EMAIL") or "admin@millionvolt.com").strip()
        _ap = _os.environ.get("CONTENT_HUB_ADMIN_PASSWORD") or "admin1985"
        if repo.ensure_admin_account(_ae, _ap):
            print(f"[startup] 부트스트랩 관리자 자동 생성: {_ae}")
    # 미디어 디렉터리 샤딩(1회 이전, 멱등) — 평면 /media/<sha> → /media/<2>/<sha>. 핫 폴더 비대화 방지.
    from .services import media_cache

    sharded = media_cache.migrate_sharding()
    if sharded:
        print(f"[startup] 미디어 {sharded}개를 샤딩 디렉터리로 이전")
    # 크래시/재시작 복구: 이전 프로세스에서 끊긴 진행중 잡(pending/running)을 failed 로 정리.
    orphaned = repo.fail_orphaned_jobs()
    if orphaned:
        print(f"[startup] 고아 잡 {orphaned}개를 failed 로 정리")
    # create/sync 레이스로 생긴 중복(같은 결과물 2행) 병합 정리
    dups = repo.reconcile_duplicates()
    if dups:
        print(f"[startup] 중복 동기화본 {dups}개를 병합 정리")
    # 옛 소프트삭제(deleted_at) 잔존 → 새 휴지통 DB 로 이전(1회, 멱등). 카운트 유령 제거.
    legacy = repo.migrate_legacy_soft_deleted()
    if legacy:
        print(f"[startup] 옛 소프트삭제 {legacy}개를 휴지통 DB 로 이전")
    # 생성자 식별자(result_url user_<id>) 백필 — 팀 워크스페이스 작성자 구분
    cu = repo.backfill_creator_uids()
    if cu:
        print(f"[startup] 생성자 uid {cu}개 백필")
    # 제공자 신원 — CLI account status 이메일로 기본값 캡처(공유 파일명·작성자 표기 기준).
    # 사용자가 바꾼 이름은 절대 안 덮어씀. CLI 오프라인이면 조용히 건너뜀(다음 기회).
    try:
        from .services import cli_bridge

        status = await cli_bridge.get_account_status()
        repo.capture_provider_identity(status.get("email") or None)
    except Exception as e:  # noqa: BLE001 — 신원 캡처 실패가 부팅을 막지 않게
        print(f"[startup] 제공자 신원 캡처 건너뜀: {e}")
    # 로그인 계정 ↔ 생성자(creator) 연결 보장(멱등) — 소유자=힉스필드 uid, 그 외=acct:<email>.
    # 이래야 신규 계정이 멤버·프로젝트 후보에 뜨고, '내 작업'이 계정별로 분리된다.
    linked = repo.link_accounts_to_creators()
    if linked:
        print(f"[startup] 계정 {linked}개를 생성자에 연결")
    # 썸네일 사전 생성(백그라운드 데몬, 1회) — 첫 프로젝트 선택·스크롤에서도 생성 지연 없이 즉시 표시.
    # 살짝 throttle 해 시작 직후 CPU 스파이크를 피한다(PIL 은 C 구간서 GIL 해제 → 응답성 유지).
    import threading

    from .services import thumbs

    def _prewarm() -> None:
        try:
            n = thumbs.prewarm_generation_thumbs(512, throttle=0.005)
            if n:
                print(f"[startup] 썸네일 {n}개 사전 생성 완료(백그라운드)")
        except Exception as e:  # noqa: BLE001
            print(f"[startup] 썸네일 사전 생성 건너뜀: {e}")

    threading.Thread(target=_prewarm, daemon=True, name="thumb-prewarm").start()
    # 주기 동기화는 서버 직결 로컬 허브(AUTH off)에선 끈다 — 데이터는 서버가 정답이고 적재는
    # 에이전트(push)가 한다. 로컬에서 20초마다 CLI 동기화+broadcast 하면 라이브러리가 계속
    # 새로고침돼(로딩 깜빡임) 불필요. 서버(AUTH on)에서만 동작(거기도 CLI 없으면 무해 no-op).
    if AUTH_ENABLED:
        periodic_sync.start()
    periodic_backup.start()  # DB 자동 백업(서버 운영) — 시작 1회 + 주기, 회전 보관
    yield
    # 종료: 주기 백업 + 주기 동기화 정리
    await periodic_backup.stop()
    if AUTH_ENABLED:
        await periodic_sync.stop()


app = FastAPI(title="Millionvolt Hub", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(library.router)
app.include_router(generation.router)
app.include_router(share.router)
app.include_router(sync.router)
app.include_router(assets.router)
app.include_router(projects.router)
app.include_router(members.router)
app.include_router(ingest.router)
app.include_router(gen_requests.router)
app.include_router(publish.router)
app.include_router(auth.router)
app.include_router(db_transfer.router)


# ── 인증 enforcement 미들웨어 (로드맵 §4-6 '서버가 매번 검증') ─────────────────
# AUTH_ENABLED 일 때만 작동. 보호 경로(/api/* 와 /media/*)는 승인된 세션을 요구한다.
# 토큰은 Authorization: Bearer <token> 또는 세션 쿠키(ch_session — img/태그·WS 용).
# 검증되면 request.state.account 에 계정을 싣는다. 정적 SPA 는 공개, /ws 는 핸들러에서 검증.
# /api/agent/download(push_agent.py)은 공개 — MV_agent.bat 이 인증 없이 curl 로 받게.
# 스크립트엔 비밀이 없다(클라이언트 코드일 뿐, 실제 push 는 여전히 허브 로그인 필요).
_AUTH_PUBLIC_PREFIXES = ("/api/auth/", "/api/health", "/api/agent/download")


@app.middleware("http")
async def auth_enforcement(request: Request, call_next):
    request.state.account = None
    path = request.url.path
    # 토큰(헤더 또는 쿠키)이 있으면 모드와 무관하게 계정을 실어둔다(/me·관리자 검증·표시에).
    token = session_token(request)
    if token:
        email = auth_svc.verify_token(token)
        if email:
            acc = repo.get_account(email)
            if acc and acc["status"] == "approved":
                request.state.account = acc
    if not AUTH_ENABLED:
        return await call_next(request)
    # 보호: /api/*(로그인·가입·헬스 제외) + /media/*. 정적 SPA·/ws 는 여기서 제외.
    api_protected = path.startswith("/api/") and not path.startswith(_AUTH_PUBLIC_PREFIXES)
    media_protected = path.startswith("/media")
    if (api_protected or media_protected) and request.state.account is None:
        return JSONResponse({"detail": "로그인이 필요합니다"}, status_code=401)
    return await call_next(request)


# ── 변경 전파 미들웨어 ────────────────────────────────────────────────────────
# 한 클라이언트의 쓰기(태그·소스·컬러·코멘트·프로젝트 등)를 DB 저장만 하지 않고,
# 연결된 다른 클라이언트(같은 계정의 다른 기기/탭)에 'synced' 를 push 해 즉시 새로고침시킨다.
# 엔드포인트마다 손대지 않고 미들웨어 한 곳에서 처리(디바운스는 ws.manager 가 담당).
# 라이브러리 데이터와 무관한 경로는 제외(불필요한 reload 방지).
_NOTIFY_EXCLUDE = ("/api/auth/", "/api/health", "/api/backup")
_NOTIFY_METHODS = ("POST", "PUT", "PATCH", "DELETE")


@app.middleware("http")
async def mutation_notify(request: Request, call_next):
    response = await call_next(request)
    try:
        path = request.url.path
        if (
            request.method in _NOTIFY_METHODS
            and path.startswith("/api/")
            and not path.startswith(_NOTIFY_EXCLUDE)
            and response.status_code < 400
        ):
            # 변경한 계정의 탭/기기에만 알림(AUTH off 면 account 없음 → 전체). 남의 비공개
            # 변경에 전원이 reload 하던 폭주를 막는다.
            acc = getattr(request.state, "account", None)
            manager.notify_mutation(acc.get("creator_uid") if acc else None)
    except Exception:  # noqa: BLE001 — 알림 실패가 응답을 막지 않게
        pass
    return response


# ── 서버 직결 데이터-프록시 (최외곽) ──────────────────────────────────────────
# 로컬 허브(위임 모드)에서 데이터 요청을 통째로 공유 서버로 중계한다. 가장 마지막에 등록해
# 최외곽에서 먼저 돌며, 데이터 경로면 로컬 라우터에 닿기 전에 단락(서버 응답 verbatim).
# 서버 본체(AUTH on)·미로그인 허브는 통과해 자기 라우터로 처리.
@app.middleware("http")
async def data_proxy(request: Request, call_next):
    return await _proxy.data_proxy_middleware(request, call_next)

# 로컬에 받아둔 미디어 원본 서빙(현재는 원격 URL 직접 사용, 향후 byte-cache 용).
# StaticFiles 는 마운트 시점에 디렉터리가 있어야 하므로 먼저 생성한다.
ensure_dirs()
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.get("/api/health")
def health():
    from .services import cli_bridge

    return {"status": "ok", "cli_available": cli_bridge.cli_available()}


@app.get("/api/backups")
def list_backups():
    """보관 중인 DB 백업 목록(최신순). 운영/관리자용."""
    from .services.backup import list_backups_info

    return list_backups_info()


@app.post("/api/backup")
async def trigger_backup():
    """수동 DB 백업 즉시 실행(회전 포함). 관리자/운영용."""
    from .services.backup import backup_now

    path = await asyncio.to_thread(backup_now)
    return {"ok": path is not None, "file": path.name if path else None}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """생성 진행률 push 채널. AUTH_ENABLED 면 세션 쿠키(또는 ?token=)로 인증 후 수락."""
    account_uid: str | None = None
    if AUTH_ENABLED:
        from .deps import SESSION_COOKIE

        token = ws.cookies.get(SESSION_COOKIE) or ws.query_params.get("token")
        email = auth_svc.verify_token(token) if token else None
        acc = repo.get_account(email) if email else None
        if not acc or acc["status"] != "approved":
            await ws.close(code=1008)  # policy violation
            return
        account_uid = acc.get("creator_uid")  # 이 소켓이 받을 진행률·알림을 이 계정으로 한정
    await manager.connect(ws, account_uid)
    try:
        while True:
            # 클라이언트 → 서버 메시지는 현재 쓰지 않지만 연결 유지를 위해 수신.
            await ws.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(ws)
    except Exception:
        await manager.disconnect(ws)


# ── 서버 모드: 빌드된 프론트엔드(dist) 서빙 ──────────────────────────────────
# 백엔드가 프론트를 같은 오리진에서 제공 → 프론트의 상대경로가 그대로 동작하고
# CORS 도 불필요. dist 가 없으면(개발: Vite dev server 사용) 이 블록은 건너뛴다.
# 라우터·/media 마운트보다 *뒤*에 등록해야 API 경로를 가리지 않는다.
if FRONTEND_DIST.is_dir():
    _ASSETS_DIR = FRONTEND_DIST / "assets"
    if _ASSETS_DIR.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_ASSETS_DIR)), name="spa-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA 진입점. 실제 파일이면 그 파일을, 아니면 index.html 을 돌려준다.
        알 수 없는 /api·/ws·/media 요청은 200(index.html)으로 삼키지 않고 404 로."""
        if full_path.startswith(("api/", "ws", "media/")):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        # 경로 탈출 방지: dist 바깥을 가리키면 거부
        if (
            full_path
            and candidate.is_file()
            and str(candidate).startswith(str(FRONTEND_DIST))
        ):
            return FileResponse(str(candidate))
        # index.html 은 캐시 금지 — 빌드 때 바뀐 해시 자산(특히 CSS)을 가리키는데, 브라우저가
        # 옛 index.html 을 캐시하면 지워진 옛 CSS 를 요청해 404 → 디자인 깨짐(자산은 해시라 영구캐시 OK).
        return FileResponse(
            str(FRONTEND_DIST / "index.html"),
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
else:
    print(f"[startup] 프론트엔드 dist 없음 → API 전용 모드 ({FRONTEND_DIST})")


def run() -> None:
    """`python -m app.main` — 서버 모드 실행(0.0.0.0 바인딩, env 로 host/port 재정의).
    ⚠️ Windows 에서 --reload 는 금지(SelectorEventLoop 강제로 CLI subprocess 깨짐)이라
    여기서도 reload=False 고정. CLI 와 동일한 검증된 실행 경로."""
    import uvicorn

    from .config import HOST, PORT

    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False, log_level="info")


if __name__ == "__main__":
    run()
