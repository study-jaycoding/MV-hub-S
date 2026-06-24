"""내 메타데이터(로컬 DB) 내보내기/가져오기 — 교차 PC 작업 연속성(로컬 우선).

서버와 무관하게 이 허브의 로컬 SQLite 파일을 통째로 주고받는다. 다른 PC에서 내보낸 .db 를
이 PC에 '통째 교체'로 넣으면 내 라이브러리·태그·컬러·계보·코멘트가 그대로 이어진다.
(미디어는 힉스필드 공개 URL 이라 파일 전송 불필요.) 병합이 아니라 교체 — 현재 DB는 자동 백업.
"""

from __future__ import annotations

import secrets
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import _proxy
from .. import db, repo
from ..deps import require_admin
from ..repo import identity

router = APIRouter(prefix="/api/db", tags=["db-transfer"])

_SQLITE_MAGIC = b"SQLite format 3"


@router.get("/export")
def export_db(request: Request):
    """내 로컬 DB 를 단일 .db 파일로 내려준다(일관 스냅샷). 다른 PC에서 '가져오기'로 넣으면 됨.
    AUTH on(공유 서버)에선 admin 만 — 전체 DB(비밀번호 해시 포함) 유출 방지. AUTH off(로컬)면 통과."""
    require_admin(request)
    path = db.get_db_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
    # sqlite backup API 로 임시파일에 일관 복사 — WAL 상태와 무관하게 완전한 스냅샷.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-export-{int(time.time())}.db"
    src = sqlite3.connect(str(path))
    try:
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return FileResponse(
        tmp,
        filename="MV-hub-mydb.db",
        media_type="application/octet-stream",
        background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
    )


@router.post("/import")
async def import_db(request: Request, file: UploadFile = File(...)):
    """업로드한 .db 로 내 로컬 DB 를 통째 교체(병합 아님). 현재 DB는 .bak 으로 자동 백업.
    가져온 DB는 현재 스키마로 마이그레이션하고 신원 캐시를 리셋한다.
    AUTH on(공유 서버)에선 admin 만 — 임의 DB 로 서버를 덮어쓰는 행위 차단. AUTH off(로컬)면 통과."""
    require_admin(request)
    data = await file.read()
    if data[: len(_SQLITE_MAGIC)] != _SQLITE_MAGIC:
        raise HTTPException(status_code=400, detail="SQLite DB 파일이 아닙니다")
    # 임시파일에 받아 유효성(generation 테이블 존재) 검증.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-import-{int(time.time())}.db"
    tmp.write_bytes(data)
    ok = None
    try:
        c = sqlite3.connect(str(tmp))
        try:
            ok = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation'"
            ).fetchone()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        ok = None
    if not ok:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="허브 DB 형식이 아닙니다(generation 테이블 없음)")

    path = db.get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 현재 DB 백업(되돌릴 수 있게) — WAL 접은 뒤 복사.
    if path.is_file():
        try:
            with db.get_connection() as conn:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:  # noqa: BLE001
            pass
        bak = path.with_name(f"{path.stem}.bak-{int(time.time())}.db")
        try:
            shutil.copy2(path, bak)
        except Exception:  # noqa: BLE001
            pass
    # 기존 WAL/SHM 잔재 제거 후 통째 교체.
    for suf in ("-wal", "-shm"):
        Path(str(path) + suf).unlink(missing_ok=True)
    shutil.move(str(tmp), str(path))
    # 가져온 DB를 현재 스키마로 마이그레이션(구버전 .db 호환) + 내 신원 캐시 리셋.
    db.init_db()
    identity._MY_UID_CACHE[0] = None
    # 보안: 가져온 DB 의 app_setting 에 든 '그 PC/그 계정' 세션 정보(공유 서버 토큰·임시 관리자
    # 권한·로그인 신원)를 제거한다. 안 그러면 이 허브가 가져온 DB 주인의 토큰으로 서버에 proxy·발행·
    # 코멘트하게 된다(다른 사람·옛 백업 DB 일 때 위험). 서버 주소만 남기고 토큰·신원을 비워 재로그인을
    # 강제한다(토큰 없음 → proxying()=False → 프론트 게이트가 로그인 화면을 다시 띄움).
    for k in (
        "shared_server_token",
        "shared_server_email",
        "shared_server_name",
        "shared_server_roles",
        "shared_server_elev_token",
        "shared_server_elev_email",
        "shared_server_elev_name",
    ):
        try:
            repo.set_setting(k, None)
        except Exception:  # noqa: BLE001
            pass
    # 보안: 가져온 DB 의 토큰 서명키(auth_secret)를 새로 발급한다. 안 그러면 가져온 DB 주인이
    # 예전에 그 DB 로 발급한 세션 토큰이 이 서버에서 그대로 검증돼 위장 로그인이 가능하다.
    try:
        repo.set_setting("auth_secret", secrets.token_hex(32))
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "relogin_required": True}


@router.post("/migrate-from-server")
def migrate_from_server():
    """서버 직결 기간 동안 서버에만 쌓였던 내 '개인 메타'(컬러/태그/소스/프로젝트/최종)를 로컬로 1회
    가져온다. 생성물 자체는 에이전트의 `generate list` 동기화로 로컬에 재구축되므로(먼저 동기화 권장),
    여기선 로컬에 같은 id 가 있는 항목에 메타 오버레이만 적용한다(없으면 missing 으로 집계)."""
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")
    # assign 검증을 위해 서버 프로젝트 정의를 먼저 로컬에 캐시한다(없으면 assign_to_project 가
    # ValueError → 항목 적용이 중간에 깨진다).
    try:
        pdata = _proxy.proxy_json("GET", "/api/projects")
        repo.cache_projects(pdata.get("projects") or [] if isinstance(pdata, dict) else [])
    except Exception:  # noqa: BLE001 — 프로젝트 캐시 실패는 메타 적용을 막지 않음(아래서 per-item 보호)
        pass
    applied = missing = errors = total = 0
    cursor_ts: float | None = None
    cursor_id: str | None = None
    seen: set[str] = set()
    LIMIT = 500
    # 키셋 커서로 끝까지 순회 — 2000건 단일 페이지로는 큰 라이브러리가 조용히 잘린다.
    while True:
        params: dict = {"tab": "my", "limit": LIMIT}
        if cursor_ts is not None and cursor_id:
            params["cursor_ts"] = cursor_ts
            params["cursor_id"] = cursor_id
        items = _proxy.proxy_json("GET", "/api/generations", params=params)
        items = items if isinstance(items, list) else []
        if not items:
            break
        total += len(items)
        for it in items:
            gid = it.get("id") if isinstance(it, dict) else None
            if not gid or gid in seen:
                continue
            seen.add(gid)
            if not repo.get_generation(gid):
                missing += 1  # 로컬에 아직 없음 → 에이전트 동기화 후 다시 시도
                continue
            try:  # 한 건 실패(예: 누락 프로젝트)가 전체 순회를 멈추지 않게 — 부분 적용 방지
                if it.get("color") is not None:
                    repo.set_color(gid, it.get("color"))
                if it.get("is_source"):
                    repo.set_source(gid, it.get("source_name"), True)
                if it.get("tags"):
                    repo.set_tags(gid, it.get("tags"))
                if it.get("project_id"):
                    repo.assign_to_project([gid], it.get("project_id"))
                if it.get("is_final"):
                    repo.set_final(gid, True, it.get("final_by"))
                applied += 1
            except Exception:  # noqa: BLE001
                errors += 1
        if len(items) < LIMIT:
            break
        last = items[-1]
        cursor_ts = last.get("sort_ts")
        cursor_id = last.get("id")
        if cursor_ts is None or not cursor_id:
            break  # 커서 키 없음 → 무한 루프 방지로 중단
    return {"applied": applied, "missing": missing, "errors": errors, "total": total}
