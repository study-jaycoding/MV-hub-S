"""계정별 DB 백업 (공유 서버측).

각 팀원이 자기 로컬 허브의 **계정별 메타데이터 DB** 를 서버에 올리고(POST) 나중에 다시
내려받아(GET) 그대로 작업을 이어간다. 기존 '파일 다운로드→재업로드' 를 '서버에 백업→서버에서
가져오기' 로 바꾸는 서버 입구다.

- 저장: data/db-backups/<email-slug>/<ts>.db — **계정별 폴더**. 세션 신원(creator 계정)으로만 접근,
  남의 백업은 못 본다(목록·다운로드·업로드 모두 본인 것).
- 보안: 민감정보(공유서버 토큰·auth_secret·세션)는 **로컬 허브가 업로드 전에 비워** 보낸다(plan 결정).
  서버는 받은 바이트를 그대로 저장만 한다. 복원 시 로컬이 auth_secret 재발급·재로그인을 강제한다.
- AUTH on(공유 서버)에서만 의미가 있다 — 미들웨어가 세션을 요구하므로 current_account 가 채워진다.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from ..active_account import slug
from ..config import DATA_DIR
from ..deps import current_account
from ..services.sqlite_db import HubDbValidationError, hub_db_validation_detail, validate_hub_db

router = APIRouter(prefix="/api/db-backup", tags=["db-backup"])

_KEEP = 10  # 계정별 보관 버전 수(오래된 것부터 정리)
_MAX_BYTES = 512 * 1024 * 1024  # 업로드 상한 512MB(메타 DB 는 보통 수 MB)


def _acct(request: Request) -> dict:
    acc = current_account(request)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return acc


def _dir(email: str) -> Path:
    return DATA_DIR / "db-backups" / slug(email)


# 계정 폴더별 저장 직렬화 — to_thread 전환으로 같은 계정의 동시 업로드가 실제로 겹칠 수 있어,
# 저장·정리·개수 계산이 섞이지 않게 폴더 단위로 잠근다(계정 수만큼만 생기니 크기 걱정 없음).
_dir_locks: dict[str, threading.Lock] = {}
_dir_locks_guard = threading.Lock()


def _dir_lock(d: Path) -> threading.Lock:
    key = str(d)
    with _dir_locks_guard:
        lock = _dir_locks.get(key)
        if lock is None:
            lock = _dir_locks[key] = threading.Lock()
    return lock


def _store_backup(d: Path, name: str, data: bytes) -> int:
    """디스크 쓰기·무결성 검증·오래된 백업 정리(전부 동기 I/O). 남은 백업 개수를 돌려준다.

    최대 512MB 쓰기와 SQLite 검증이 이벤트 루프를 막지 않게 호출부가 스레드로 실행한다.
    """
    with _dir_lock(d):
        d.mkdir(parents=True, exist_ok=True)
        path = d / name
        tmp = d / f".upload-{uuid.uuid4().hex}.tmp"
        tmp.write_bytes(data)
        try:
            # 백업 보관본은 복원의 마지막 보루 — 깨진 파일을 받아두면 복원 시점에야 터진다.
            # quick_check 까지 통과해야 저장(수 MB 메타 DB 라 비용 미미).
            validate_hub_db(tmp, require_integrity=True)
        except HubDbValidationError:
            tmp.unlink(missing_ok=True)
            raise
        tmp.replace(path)
        # 오래된 백업 정리(이름=타임스탬프라 정렬이 곧 시간순)
        backups = sorted(d.glob("*.db"))
        for old in backups[:-_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass
        return len(sorted(d.glob("*.db")))


@router.post("")
async def upload_backup(request: Request, file: UploadFile = File(...)):
    """내 계정 DB 백업 1건 저장. 같은 계정 폴더에 타임스탬프로 누적, 오래된 건 _KEEP 넘으면 정리."""
    acc = _acct(request)
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="백업 파일이 너무 큽니다(512MB 초과)")
    d = _dir(acc["email"])
    # 같은 초 동시 업로드 충돌 방지 — 앞부분 타임스탬프로 시간순 정렬 유지, 뒤 uuid 로 유일성 보장.
    name = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.db"
    try:
        count = await asyncio.to_thread(_store_backup, d, name, data)
    except HubDbValidationError as exc:
        raise HTTPException(status_code=400, detail=hub_db_validation_detail(exc))
    return {"ok": True, "name": name, "size": len(data), "count": count}


@router.get("")
def list_backups(request: Request):
    """내 계정 백업 버전 목록(최신순)."""
    acc = _acct(request)
    d = _dir(acc["email"])
    out = []
    for p in sorted(d.glob("*.db"), reverse=True):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    return {"backups": out}


@router.get("/latest")
def download_latest(request: Request):
    """내 계정의 가장 최근 백업을 내려준다(복원용)."""
    acc = _acct(request)
    d = _dir(acc["email"])
    files = sorted(d.glob("*.db"))
    if not files:
        raise HTTPException(status_code=404, detail="이 계정의 서버 백업이 없습니다")
    latest = files[-1]
    return FileResponse(
        latest,
        filename="MV-hub-restore.db",
        media_type="application/octet-stream",
    )
