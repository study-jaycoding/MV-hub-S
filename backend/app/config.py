"""앱 설정·경로 (Phase 2).

로컬 우선 원칙(CLAUDE.md §1): 모든 경로는 backend/ 기준 로컬 디렉터리.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# 데이터 루트 — DB·미디어·공유를 한 폴더 아래로 분리(backend 루트 오염 방지).
#   data/db/      content_hub.db      (사실+오버레이 = 내 누적 DB)
#   data/media/   로컬 보관 결과물
#   data/shared/  share_<제공자>.json  (내것=내 신원 / 받은것=남의 신원)
DATA_DIR = Path(os.environ.get("CONTENT_HUB_DATA", BACKEND_DIR / "data")).resolve()

# 결과물·썸네일·레퍼런스 원본을 받아둘 로컬 캐시(향후 byte-caching 용).
# 현재는 동기화한 원격 result_url 을 그대로 file_path 로 보관하고,
# 로컬로 받아둔 파일만 이 디렉터리에 저장한다.
MEDIA_DIR = Path(os.environ.get("CONTENT_HUB_MEDIA", DATA_DIR / "media")).resolve()

# 팀 공유 번들 폴더 — share_<제공자>.json. 내 신원과 일치하는 파일 = 내가 만든 것(편집·재생성 대상),
# 나머지 = 받은 것(읽기). 제공자명이 내것/받은것을 자동 구분하고 서버 파일겹침도 방지.
SHARED_DIR = Path(os.environ.get("CONTENT_HUB_SHARED", DATA_DIR / "shared")).resolve()

# 구버전 경로(backend 루트 직속) — 재시작 시 새 data/ 레이아웃으로 1회 자동 이전.
_LEGACY_MEDIA_DIR = BACKEND_DIR / "media"

# 기본 작업자(개인 워크스테이션의 "나"). DESIGN.md §2 worker.
DEFAULT_WORKER_ID = os.environ.get("CONTENT_HUB_WORKER_ID", "me")
DEFAULT_WORKER_NAME = os.environ.get("CONTENT_HUB_WORKER_NAME", "나")

# Assets(구성) 패널 — 비마운트 프로젝트·캡쳐의 기본 저장 루트. 등록(마운트)한 외부 폴더는 각자
# 자기 절대경로를 쓰므로 이 값과 무관하다(영향 없음).
# 기본은 설치 폴더 기준 DATA_DIR/assets — 하드코딩 절대경로 없이 어느 PC 에서도 동작(포터블).
# 특정 폴더를 쓰고 싶으면 CONTENT_HUB_ASSETS_DIR 환경변수로 지정.
ASSETS_ROOT = Path(
    os.environ.get("CONTENT_HUB_ASSETS_DIR", str(DATA_DIR / "assets"))
).resolve()
ASSETS_ROOT.mkdir(parents=True, exist_ok=True)  # 없으면 만들어 캡쳐 등 쓰기가 항상 성공하게
DEFAULT_PROJECT = os.environ.get("CONTENT_HUB_DEFAULT_PROJECT", "v001")

# 개발용 CORS 허용 오리진(Vite 기본 5173).
# ⚠️ 서버 모드(백엔드가 dist 를 직접 서빙)에서는 프론트·API 가 같은 오리진이라
#    CORS 가 필요 없다. 이 목록은 개발 중 Vite dev server(5173)에서 접속할 때만 쓰인다.
CORS_ORIGINS = os.environ.get(
    "CONTENT_HUB_CORS",
    "http://localhost:5173,http://127.0.0.1:5173",
).split(",")

# ── 서버 모드 ───────────────────────────────────────────────────────────────
# 빌드된 프론트엔드(frontend/dist)를 백엔드가 직접 서빙해 단일 오리진으로 만든다.
# 그러면 프론트의 상대경로(/api·/ws·/media)가 그대로 동작 → 실서버에 올려도 무변경.
# 폴더가 없으면 API 전용(개발은 Vite dev server 가 프론트를 담당).
FRONTEND_DIST = Path(
    os.environ.get("CONTENT_HUB_FRONTEND_DIST", BACKEND_DIR.parent / "frontend" / "dist")
).resolve()

# ── 인증 enforcement 스위치 ──────────────────────────────────────────────────
# 기본 off — 로드맵 "식별 먼저, 차단은 나중(진짜 막을 게 생겼을 때)". 1/true 면 로그인 필수:
#   모든 /api/*(인증·헬스 제외)가 승인된 세션을 요구하고, 관리자 작업은 C0/C1 만 허용.
# 끄면(기본) 현재처럼 누구나 접근(개인 PC·개발). 팀 서버에서 막고 싶을 때 켠다.
AUTH_ENABLED = os.environ.get("CONTENT_HUB_AUTH", "0").lower() in ("1", "true", "yes", "on")

# ── PM 대시보드(매니징먼트) 모듈 스위치 ───────────────────────────────────────
# 기본 on. 분리형 사이드카 기능(routers/manage·repo/manage). 런처(MV_agent/MV_server.bat)가 이미
# 비어있으면 =1 로 강제하므로 실사용은 늘 on 이었고, 코드 기본값도 여기에 맞춘다 — 켰다 껐다 하며
# 팀 크레딧 집계에 구멍(off 기간 미집계)이 생기지 않게. 명시적으로 끄려면 CONTENT_HUB_MANAGE=0.
# off 면 라우터 미등록 + 사이드카 테이블 미생성(설계: PM_DASHBOARD_DESIGN.md).
MANAGE_ENABLED = os.environ.get("CONTENT_HUB_MANAGE", "1").lower() in ("1", "true", "yes", "on")

# 서버 바인딩 — 인증이 꺼진 개인/개발 모드는 기본적으로 로컬에만 묶는다. 공유 서버 스크립트는
# CONTENT_HUB_AUTH=1 + CONTENT_HUB_HOST=0.0.0.0 을 명시하므로 LAN 공개 동작은 그대로 유지된다.
HOST = os.environ.get(
    "CONTENT_HUB_HOST",
    "0.0.0.0" if AUTH_ENABLED else "127.0.0.1",
)
PORT = int(os.environ.get("CONTENT_HUB_PORT", "8000"))

# 특별한 운영 사유로 AUTH off 서버를 LAN 에 열어야 할 때만 명시 허용. 기본은 차단.
ALLOW_REMOTE_AUTH_OFF = os.environ.get("CONTENT_HUB_ALLOW_REMOTE_AUTH_OFF", "0").lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def migrate_storage_layout() -> None:
    """구버전 backend/media → data/media 로 1회 이전(멱등).
    새 위치가 아직 없을 때만 통째로 옮긴다(덮어쓰기 방지). mkdir 보다 먼저 호출해야 함.

    ⚠️ CONTENT_HUB_MEDIA 로 경로를 직접 지정한 경우(env 오버라이드)엔 이전하지 않는다 —
    오퍼레이터가 '이 폴더를 그냥 써라'라고 한 것을, 빈 폴더라고 legacy 를 그리로 옮겨버리면 안 됨
    (db.py _migrate_db_location 이 env 오버라이드를 건너뛰는 것과 동일한 안전장치)."""
    if os.environ.get("CONTENT_HUB_MEDIA"):
        return  # 명시적 지정 → 자동 이전 금지
    if (
        MEDIA_DIR != _LEGACY_MEDIA_DIR
        and _LEGACY_MEDIA_DIR.exists()
        and not MEDIA_DIR.exists()
    ):
        MEDIA_DIR.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(_LEGACY_MEDIA_DIR), str(MEDIA_DIR))
        print(f"[migrate] media 이전: {_LEGACY_MEDIA_DIR} → {MEDIA_DIR}")


def ensure_dirs() -> None:
    migrate_storage_layout()  # 반드시 mkdir 전에(새 위치 부재 조건으로 판정)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
