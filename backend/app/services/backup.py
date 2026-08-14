"""DB 세트 자동 백업 (서버 운영).

단일 DB 파일 리스크(파일 손상·실수 삭제·랜섬)를 대비한다. 로드맵 §2-6·§6-1.

핵심: **SQLite 온라인 백업 API(Connection.backup) 를 쓴다.** WAL 모드에서 단순 파일복사
(shutil.copy)는 아직 메인 DB 로 체크포인트되지 않은 -wal 분을 놓쳐 깨진 스냅샷이 된다.
.backup 은 잠금 없이 일관된 스냅샷을 떠 준다(서버는 계속 쓰기 가능).

동작: 콘텐츠 DB를 기준으로 휴지통·프로젝트 관리 DB가 존재하면 같은 시각의 세트로 함께
백업한다. 시작 시 1회(최근 백업이 충분히 새것이면 생략) + 주기(기본 하루).
최근 N세트만 보관(회전).
백업 폴더는 CONTENT_HUB_BACKUP_DIR 로 다른 디스크/NAS 지정 권장(같은 디스크면 동반 손실).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sqlite3
import threading
import time
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from ..config import DATA_DIR
from ..db import get_db_path
from ..manage_db import MANAGE_DB_PATH
from .sqlite_db import validate_hub_db
from .operational_logging import log_event

_backup_log = logging.getLogger("mvhub.backup")

# 백업 보관 폴더 — 기본은 데이터 루트 아래. 실서버에선 다른 디스크/NAS 로 지정 권장.
BACKUP_DIR = Path(
    os.environ.get("CONTENT_HUB_BACKUP_DIR", DATA_DIR / "backups")
).resolve()

# 백업 주기(초). 0 이하이면 비활성. 기본 하루.
BACKUP_INTERVAL = float(os.environ.get("CONTENT_HUB_BACKUP_INTERVAL", str(24 * 3600)))

# 보관 개수(회전) — 이보다 오래된 백업은 삭제. 기본 7개(약 1주).
# 최소 1: 0 이하를 허용하면 방금 만든 백업까지 회전이 지워 백업 자체가 무의미해진다.
BACKUP_KEEP = max(1, int(os.environ.get("CONTENT_HUB_BACKUP_KEEP", "7")))

# 시작 시 중복 백업 방지: 가장 최근 백업이 이 시간(초)보다 새것이면 시작 백업 생략.
# (서버 재기동·개발 리스타트가 잦아도 백업이 난립하지 않게.)
_STARTUP_SKIP_IF_YOUNGER = min(BACKUP_INTERVAL, 3600.0)

_PREFIX = "content_hub_"
_TRASH_PREFIX = "content_trash_"
_MANAGE_PREFIX = "manage_hub_"


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
    """보관 중인 백업 세트(최신순). 콘텐츠 파일은 기존 API의 대표 파일로 유지한다."""
    out: list[dict] = []
    for p in reversed(_list_backups()):
        st = p.stat()
        stamp = p.name[len(_PREFIX):-3]
        related = [p]
        for prefix in (_TRASH_PREFIX, _MANAGE_PREFIX):
            candidate = p.parent / f"{prefix}{stamp}.db"
            if candidate.is_file():
                related.append(candidate)
        out.append(
            {
                "file": p.name,
                "size": sum(item.stat().st_size for item in related),
                "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "files": [item.name for item in related],
            }
        )
    return out


def _rotate() -> None:
    """오래된 백업 삭제 — 최근 BACKUP_KEEP 개만 남긴다."""
    backups = _list_backups()  # 이름이 타임스탬프라 사전순 = 시간순
    excess = len(backups) - BACKUP_KEEP
    for old in backups[: max(0, excess)]:
        stamp = old.name[len(_PREFIX):-3]
        for prefix in (_PREFIX, _TRASH_PREFIX, _MANAGE_PREFIX):
            with contextlib.suppress(OSError):
                (old.parent / f"{prefix}{stamp}.db").unlink()


# 주기 백업과 관리자 수동 백업(POST /api/backup)이 겹칠 수 있어 파일 작업을 직렬화.
# 둘 다 asyncio.to_thread 로 실행되므로 스레드 락이어야 한다(단일 프로세스 운영 전제).
_BACKUP_LOCK = threading.Lock()
_TMP_MARK = ".tmp-"


def _cleanup_stale_tmp(d: Path) -> None:
    """크래시가 남긴 임시 백업 잔재 청소 — 이 모듈이 만든 이름만, 1일 이상 묵은 것만.
    (락 안에서 호출 — 지금 만들고 있는 tmp 를 지울 일이 없다.)"""
    cutoff = time.time() - 86400.0
    for p in d.glob(f".*.db{_TMP_MARK}*"):
        with contextlib.suppress(OSError):
            if p.stat().st_mtime < cutoff:
                p.unlink()


def _validate_sidecar(path: Path, expected_table: str) -> None:
    """휴지통/관리 DB의 SQLite 무결성과 핵심 테이블 존재를 확인한다."""
    uri = f"file:{path.as_posix()}?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as conn:
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise sqlite3.DatabaseError(f"quick_check failed: {result}")
        fk_rows = conn.execute("PRAGMA foreign_key_check").fetchmany(1)
        if fk_rows:
            raise sqlite3.DatabaseError("foreign_key_check failed")
        found = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (expected_table,)
        ).fetchone()
        if not found:
            raise sqlite3.DatabaseError(f"required table missing: {expected_table}")


def _snapshot_database_set(
    sources: list[tuple[str, Path, str, str | None]],
    snapshots: list[tuple[str, Path, Path, str | None]],
) -> None:
    """첨부 DB 전체의 읽기 시점을 먼저 고정한 뒤 각각 온라인 백업한다.

    콘텐츠 삭제가 메인→휴지통으로 이동하는 찰나에도 두 스냅샷 사이에서 사라지거나
    중복되지 않게 한다. WAL 읽기 트랜잭션이라 서버 쓰기를 장시간 막지는 않는다.
    """
    main_source = next(source for label, source, _, _ in sources if label == "content")
    src_conn = sqlite3.connect(str(main_source), isolation_level=None)
    try:
        aliases = {"content": "main"}
        for label, source, _, _ in sources:
            if label == "content":
                continue
            alias = f"side_{label}"
            src_conn.execute(f"ATTACH DATABASE ? AS {alias}", (str(source),))
            aliases[label] = alias
        src_conn.execute("BEGIN")
        try:
            # 각 첨부 DB를 트랜잭션 안에서 읽어 동일한 스냅샷 경계를 확정한다.
            for alias in aliases.values():
                src_conn.execute(f"SELECT name FROM {alias}.sqlite_master LIMIT 1").fetchone()
            for label, _, tmp, _ in snapshots:
                dest_conn = sqlite3.connect(str(tmp))
                try:
                    src_conn.backup(dest_conn, name=aliases[label])
                finally:
                    dest_conn.close()
        finally:
            src_conn.execute("ROLLBACK")
    finally:
        src_conn.close()


def backup_now(stamp: Optional[str] = None) -> Optional[Path]:
    """DB 세트의 일관 스냅샷을 생성하고 대표 콘텐츠 경로를 반환(블로킹).
    DB 파일이 아직 없으면 None. 회전까지 수행.

    ★원자성: 임시 파일(선행 점 + .tmp — _list_backups 의 glob 에 절대 안 걸림)에 스냅샷을 뜬 뒤
    quick_check 무결성 검증을 통과해야만 최종 이름으로 os.replace 한다. 중간 크래시/디스크풀이면
    tmp 쓰레기만 남고, 백업 목록·회전은 검증 통과한 완성본만 본다."""
    src = get_db_path()
    if not src.exists():
        return None
    with _BACKUP_LOCK:
        d = _backup_dir()
        d.mkdir(parents=True, exist_ok=True)
        _cleanup_stale_tmp(d)
        # 마이크로초 포함 — 같은 초의 연속 백업(수동+주기)이 같은 최종 이름을 덮지 않게.
        stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        sources: list[tuple[str, Path, str, str | None]] = [
            ("content", src, _PREFIX, None),
        ]
        trash_src = src.parent / "content_hub_trash.db"
        # 관리 DB는 계정과 무관한 고정 경로(manage_db.MANAGE_DB_PATH)에 산다. 계정 로그인으로
        # 콘텐츠 DB가 acct/<slug>/ 아래로 옮겨가면 src.parent 에는 manage_hub.db 가 없어
        # 백업 세트에서 조용히 빠졌다 — 같은 폴더(레거시/서버 배치) 우선, 없으면 고정 경로.
        manage_src = src.parent / "manage_hub.db"
        if not manage_src.is_file():
            manage_src = MANAGE_DB_PATH
        if trash_src.is_file():
            sources.append(("trash", trash_src, _TRASH_PREFIX, "trashed"))
        if manage_src.is_file():
            sources.append(("manage", manage_src, _MANAGE_PREFIX, "team_generation_fact"))

        snapshots: list[tuple[str, Path, Path, str | None]] = []
        for label, source, prefix, expected_table in sources:
            dest = d / f"{prefix}{stamp}.db"
            tmp = d / f".{prefix}{stamp}.db{_TMP_MARK}{uuid4().hex[:8]}"
            snapshots.append((label, dest, tmp, expected_table))
        try:
            _snapshot_database_set(sources, snapshots)
            for label, _, tmp, expected_table in snapshots:
                if label == "content":
                    validate_hub_db(tmp, require_integrity=True)
                else:
                    _validate_sidecar(tmp, expected_table or "")

            # 콘텐츠 대표 파일을 마지막에 공개한다. 중간 크래시가 나도 목록에는 불완전한
            # 세트가 나타나지 않는다(앞서 공개된 sidecar는 다음 회전에서 함께 정리됨).
            for label, dest, tmp, _ in sorted(snapshots, key=lambda item: item[0] == "content"):
                os.replace(tmp, dest)
        except BaseException:
            for _, _, tmp, _ in snapshots:
                with contextlib.suppress(OSError):
                    tmp.unlink()
            raise
        _rotate()  # 교체 성공 후에만 — 실패 시 기존 정상 백업은 손대지 않는다
        return d / f"{_PREFIX}{stamp}.db"


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
                latest = list_backups_info()[0]
                log_event(
                    _backup_log,
                    "backup_completed",
                    backup_set_files=len(latest.get("files") or [path.name]),
                    backup_set_bytes=latest.get("size"),
                )
                print(f"[backup] DB 세트 백업 생성 → {path.name}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
            log_event(_backup_log, "backup_failed", level=logging.ERROR, exc_info=True)
            print(f"[backup] 오류({type(e).__name__}) — MV_logs.bat에서 상세 확인")


periodic_backup = PeriodicBackup()
