"""DB 자동 백업 (서버 운영).

단일 DB 파일 리스크(파일 손상·실수 삭제·랜섬)를 대비한다. 로드맵 §2-6·§6-1.

핵심: **SQLite 온라인 백업 API(Connection.backup) 를 쓴다.** WAL 모드에서 단순 파일복사
(shutil.copy)는 아직 메인 DB 로 체크포인트되지 않은 -wal 분을 놓쳐 깨진 스냅샷이 된다.
.backup 은 잠금 없이 일관된 스냅샷을 떠 준다(서버는 계속 쓰기 가능).

동작: 시작 시 1회(최근 백업이 충분히 새것이면 생략) + 주기(기본 하루). 최근 N개만 보관(회전).
백업 폴더는 CONTENT_HUB_BACKUP_DIR 로 다른 디스크/NAS 지정 권장(같은 디스크면 동반 손실).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import DATA_DIR
from ..db import get_db_path

# 백업 보관 폴더 — 기본은 데이터 루트 아래. 실서버에선 다른 디스크/NAS 로 지정 권장.
BACKUP_DIR = Path(
    os.environ.get("CONTENT_HUB_BACKUP_DIR", DATA_DIR / "backups")
).resolve()

# 백업 주기(초). 0 이하이면 비활성. 기본 하루.
BACKUP_INTERVAL = float(os.environ.get("CONTENT_HUB_BACKUP_INTERVAL", str(24 * 3600)))

# 보관 개수(회전) — 이보다 오래된 백업은 삭제. 기본 7개(약 1주).
BACKUP_KEEP = int(os.environ.get("CONTENT_HUB_BACKUP_KEEP", "7"))

# 시작 시 중복 백업 방지: 가장 최근 백업이 이 시간(초)보다 새것이면 시작 백업 생략.
# (서버 재기동·개발 리스타트가 잦아도 백업이 난립하지 않게.)
_STARTUP_SKIP_IF_YOUNGER = min(BACKUP_INTERVAL, 3600.0)

_PREFIX = "content_hub_"


def _backup_dir() -> Path:
    """백업 폴더 — **활성 계정별**로 분리(계정 전환 시 서로의 백업을 회전-삭제하지 않게).
    로그인하면 backups/<email-slug>/, 미로그인/단독·공유서버면 레거시 평면 폴더(기존 그대로)."""
    from ..active_account import account_key, slug

    key = account_key()
    return (BACKUP_DIR / slug(key)) if key else BACKUP_DIR


def _list_backups() -> list[Path]:
    d = _backup_dir()
    if not d.is_dir():
        return []
    return sorted(d.glob(f"{_PREFIX}*.db"))


def _newest_age_seconds() -> Optional[float]:
    """가장 최근 백업의 나이(초). 백업이 없으면 None."""
    backups = _list_backups()
    if not backups:
        return None
    newest_mtime = max(p.stat().st_mtime for p in backups)
    return max(0.0, time.time() - newest_mtime)


def list_backups_info() -> list[dict]:
    """보관 중인 백업 목록(최신순) — 파일명·크기·수정시각. 운영/관리자용."""
    out: list[dict] = []
    for p in reversed(_list_backups()):
        st = p.stat()
        out.append(
            {
                "file": p.name,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
            }
        )
    return out


def _rotate() -> None:
    """오래된 백업 삭제 — 최근 BACKUP_KEEP 개만 남긴다."""
    backups = _list_backups()  # 이름이 타임스탬프라 사전순 = 시간순
    excess = len(backups) - BACKUP_KEEP
    for old in backups[: max(0, excess)]:
        with contextlib.suppress(OSError):
            old.unlink()


def backup_now(stamp: Optional[str] = None) -> Optional[Path]:
    """DB 의 일관 스냅샷을 백업 폴더에 생성하고 경로를 반환(블로킹).
    DB 파일이 아직 없으면 None. 회전까지 수행."""
    src = get_db_path()
    if not src.exists():
        return None
    d = _backup_dir()
    d.mkdir(parents=True, exist_ok=True)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    dest_path = d / f"{_PREFIX}{stamp}.db"

    src_conn = sqlite3.connect(str(src))
    try:
        dest_conn = sqlite3.connect(str(dest_path))
        try:
            src_conn.backup(dest_conn)  # 온라인 일관 스냅샷(WAL 포함, 잠금 없음)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()

    _rotate()
    return dest_path


class PeriodicBackup:
    """백그라운드 주기 백업. PeriodicSync 와 동일한 수명주기 패턴."""

    def __init__(self, interval: float = BACKUP_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._interval <= 0:
            return  # 비활성
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="periodic-backup")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        # 시작 백업: 최근 백업이 충분히 새것이면 생략(재기동 난립 방지).
        age = _newest_age_seconds()
        if age is None or age >= _STARTUP_SKIP_IF_YOUNGER:
            await self._backup_once()
        while True:
            await asyncio.sleep(self._interval)
            await self._backup_once()

    async def _backup_once(self) -> None:
        try:
            # sqlite backup 은 블로킹 → 스레드로 빼 이벤트 루프를 막지 않는다.
            path = await asyncio.to_thread(backup_now)
            if path:
                print(f"[backup] DB 백업 생성 → {path.name}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
            print(f"[backup] 오류: {e}")


periodic_backup = PeriodicBackup()
