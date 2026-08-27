"""DB 세트 자동 백업 (서버 운영).

단일 DB 파일 리스크(파일 손상·실수 삭제·랜섬)를 대비한다. 로드맵 §2-6·§6-1.

핵심: **SQLite 온라인 백업 API(Connection.backup) 를 쓴다.** WAL 모드에서 단순 파일복사
(shutil.copy)는 아직 메인 DB 로 체크포인트되지 않은 -wal 분을 놓쳐 깨진 스냅샷이 된다.
.backup 은 잠금 없이 일관된 스냅샷을 떠 준다(서버는 계속 쓰기 가능).

동작: 콘텐츠 DB를 기준으로 휴지통·프로젝트 관리 DB가 존재하면 같은 stamp의 세트로 함께
백업한다. 각 DB의 읽기 시점은 미세하게 다를 수 있다(아래 스냅샷 주석 참고).
시작 시 1회(최근 백업이 충분히 새것이면 생략) + 주기(기본 하루).
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
from typing import Callable, Optional
from uuid import uuid4

from .. import active_account
from ..config import DATA_DIR
from ..db import get_db_path
from ..manage_db import MANAGE_DB_PATH
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event
from .sqlite_db import validate_hub_db

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

# 개인 메타데이터 변경은 하루를 기다리지 않고 조용해진 뒤 서버 전송용 백업을 만든다.
# 매 수정마다 SQLite 스냅샷을 뜨지 않도록 디바운스와 최소 간격을 함께 둔다.
BACKUP_CHANGE_DEBOUNCE = max(
    5.0, float(os.environ.get("CONTENT_HUB_BACKUP_CHANGE_DEBOUNCE", "300"))
)
BACKUP_MIN_INTERVAL = max(
    BACKUP_CHANGE_DEBOUNCE,
    float(os.environ.get("CONTENT_HUB_BACKUP_MIN_INTERVAL", "900")),
)
BACKUP_POLL_INTERVAL = max(
    5.0, float(os.environ.get("CONTENT_HUB_BACKUP_POLL_INTERVAL", "30"))
)

_PREFIX = "content_hub_"
_TRASH_PREFIX = "content_trash_"
_MANAGE_PREFIX = "manage_hub_"


def _backup_dir() -> Path:
    """백업 폴더 — **활성 계정별**로 분리(계정 전환 시 서로의 백업을 회전-삭제하지 않게).
    로그인하면 backups/<email-slug>/, 미로그인/단독·공유서버면 레거시 평면 폴더(기존 그대로)."""
    key = active_account.account_key()
    return (BACKUP_DIR / active_account.slug(key)) if key else BACKUP_DIR


def _capture_backup_scope() -> tuple[Path, Path, str]:
    """계정 전환과 엇갈리지 않게 원본 DB와 백업 폴더를 한 순간에 캡처한다."""
    with active_account.transition_lock:
        account_key = active_account.account_key() or ""
        return get_db_path(), _backup_dir(), account_key


def _list_backups(backup_dir: Path | None = None) -> list[Path]:
    d = backup_dir or _backup_dir()
    if not d.is_dir():
        return []
    return sorted(d.glob(f"{_PREFIX}*.db"))


def latest_backup_path() -> Optional[Path]:
    """활성 계정의 최신 완성 콘텐츠 백업. 업데이트 뒤 outbox 보강 등에 사용한다."""
    with active_account.transition_lock:
        backup_dir = _backup_dir()
    backups = _list_backups(backup_dir)
    return backups[-1] if backups else None


def _db_change_signature(src: Path | None = None) -> tuple[tuple[str, int, int], ...]:
    """개인 콘텐츠·휴지통의 파일/WAL 변화를 값싼 stat으로 감지한다."""
    content = src or get_db_path()
    trash = content.parent / "content_hub_trash.db"
    result: list[tuple[str, int, int]] = []
    for label, path in (
        ("content", content),
        ("content-wal", Path(str(content) + "-wal")),
        ("trash", trash),
        ("trash-wal", Path(str(trash) + "-wal")),
    ):
        try:
            stat = path.stat()
        except OSError:
            continue
        result.append((label, int(stat.st_mtime_ns), int(stat.st_size)))
    return tuple(result)


def _read_poll_state(
    src: Path,
    backup_dir: Path,
) -> tuple[Optional[float], tuple[tuple[str, int, int], ...], bool]:
    """한 번의 백업 목록 스캔으로 최근 나이·DB 서명·변경 필요 여부를 읽는다.

    NAS의 glob/stat은 느리거나 일시 실패할 수 있으므로 이 동기 helper 전체를 이벤트 루프 밖에서
    실행한다. 읽기 실패한 백업은 기존 계약처럼 건너뛰며, 정상 백업이 하나도 없으면 DB가 존재하는
    것 자체를 백업 필요 상태로 본다.
    """
    newest_mtime_ns: int | None = None
    if backup_dir.is_dir():
        try:
            # 목록은 poll당 정확히 한 번만 순회한다. 최신 시각은 파일명보다 실제 mtime을 따른다.
            for path in backup_dir.glob(f"{_PREFIX}*.db"):
                try:
                    mtime_ns = path.stat().st_mtime_ns
                except OSError:
                    continue
                if newest_mtime_ns is None or mtime_ns > newest_mtime_ns:
                    newest_mtime_ns = mtime_ns
        except OSError:
            # NAS 순단은 '백업 없음'으로 처리해 주기 워커가 다음 poll에서 다시 확인하게 한다.
            newest_mtime_ns = None

    signature = _db_change_signature(src)
    backup_age = (
        None
        if newest_mtime_ns is None
        else max(0.0, time.time() - newest_mtime_ns / 1_000_000_000)
    )
    backup_needed = (
        bool(signature)
        if newest_mtime_ns is None
        else any(mtime_ns > newest_mtime_ns for _label, mtime_ns, _size in signature)
    )
    return backup_age, signature, backup_needed


def _change_backup_due(
    changed_at: float | None,
    backup_age: float | None,
    *,
    now: float,
) -> bool:
    """편집이 잠잠하고 최소 백업 간격도 지난 경우에만 변경 백업을 허용한다."""
    return bool(
        changed_at is not None
        and now - changed_at >= BACKUP_CHANGE_DEBOUNCE
        and (backup_age is None or backup_age >= BACKUP_MIN_INTERVAL)
    )


def list_backups_info(backup_dir: Path | None = None) -> list[dict]:
    """보관 중인 백업 세트(최신순). 콘텐츠 파일은 기존 API의 대표 파일로 유지한다."""
    if backup_dir is None:
        with active_account.transition_lock:
            backup_dir = _backup_dir()
    out: list[dict] = []
    for p in reversed(_list_backups(backup_dir)):
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


def _rotate(backup_dir: Path) -> None:
    """오래된 백업 삭제 — 최근 BACKUP_KEEP 개만 남긴다."""
    backups = _list_backups(backup_dir)  # 이름이 타임스탬프라 사전순 = 시간순
    excess = len(backups) - BACKUP_KEEP
    for old in backups[: max(0, excess)]:
        stamp = old.name[len(_PREFIX):-3]
        for prefix in (_PREFIX, _TRASH_PREFIX, _MANAGE_PREFIX):
            with contextlib.suppress(OSError):
                (old.parent / f"{prefix}{stamp}.db").unlink()
    # 검증·조회가 백업본(WAL 헤더)을 열 때 생긴 -wal/-shm 부산물 청소 — 회전이 .db 만 지워
    # 사이드카가 무기한 쌓였다(실측: 0바이트 -wal, 32KB -shm 다수). 짝 .db 가 없는 것과
    # 회전으로 방금 .db 가 사라진 것 모두 여기서 정리된다. 열려 있으면 unlink 가 거부되므로
    # 사용 중 파일을 지울 위험은 없다(suppress).
    d = backup_dir
    if d.is_dir():
        for side in (*d.glob("*.db-wal"), *d.glob("*.db-shm")):
            base = d / side.name.rsplit("-", 1)[0]
            if not base.is_file():
                with contextlib.suppress(OSError):
                    side.unlink()


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
    """첨부 DB를 한 연결의 읽기 트랜잭션에서 연 뒤 각각 온라인 백업한다.

    SQLite/WAL은 ATTACH된 여러 DB 세트의 원자적 스냅샷을 보장하지 않는다. 별칭별 첫 읽기가
    순차적이므로 DB 사이에는 미세한 시점 차와 이동 중 행의 중복·누락 가능성이 남는다. 복원 때는
    세트 무결성·ready·핵심 수를 검사하고, content/trash 중복은 부팅 정합기가 main을 우선한다.
    한쪽 누락·manage 의미 불일치는 완전히 검출할 수 없으므로 이전 세트와 요약을 대조하고,
    의심되면 이전 정상 세트를 선택한다. WAL 읽기라 서버 쓰기를 장시간 막지는 않는다.
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
            # 각 DB의 스냅샷 경계를 가능한 한 가깝게 잡는다. DB 간 동일 시점 보장은 아니다.
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


def _backup_now_for_scope(
    src: Path,
    backup_dir: Path,
    stamp: Optional[str] = None,
) -> Optional[Path]:
    """이미 캡처한 한 계정의 경로만 사용해 백업과 회전을 끝낸다."""
    if not src.exists():
        return None
    with _BACKUP_LOCK:
        d = backup_dir
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
        _rotate(d)  # 교체 성공 후에만 — 실패 시 기존 정상 백업은 손대지 않는다
        return d / f"{_PREFIX}{stamp}.db"


def backup_now(stamp: Optional[str] = None) -> Optional[Path]:
    """검증 가능한 DB 백업 세트를 생성하고 대표 콘텐츠 경로를 반환(블로킹).
    DB 파일이 아직 없으면 None. 회전까지 수행.

    ★원자성: 임시 파일(선행 점 + .tmp — _list_backups 의 glob 에 절대 안 걸림)에 스냅샷을 뜬 뒤
    quick_check 무결성 검증을 통과해야만 최종 이름으로 os.replace 한다. 중간 크래시/디스크풀이면
    tmp 쓰레기만 남고, 백업 목록·회전은 검증 통과한 완성본만 본다."""
    src, backup_dir, account_key = _capture_backup_scope()
    token = active_account.set_override(account_key)
    try:
        return _backup_now_for_scope(src, backup_dir, stamp)
    finally:
        active_account.reset_override(token)


def _completed_backup_info(path: Path) -> tuple[int, int | None]:
    """방금 반환된 대표 경로를 기준으로 완료 로그용 파일 수와 크기를 읽는다."""
    try:
        # 최신 목록 재탐색 대신 반환 경로의 stat을 먼저 읽어 다른 계정/동시 백업 혼입을 막는다.
        size = path.stat().st_size
    except OSError:
        return 1, None
    stamp = path.name[len(_PREFIX):-3]
    related = [path]
    for prefix in (_TRASH_PREFIX, _MANAGE_PREFIX):
        candidate = path.parent / f"{prefix}{stamp}.db"
        if candidate.is_file():
            related.append(candidate)
            with contextlib.suppress(OSError):
                size += candidate.stat().st_size
    return len(related), size


def _run_backup_cycle(
    src: Path,
    backup_dir: Path,
    completed_callback: Callable[[Path], object] | None,
) -> Optional[Path]:
    """백업·성공 콜백·완료 기록을 취소로 중간 유기할 수 없는 한 동기 단위로 실행한다."""
    path = _backup_now_for_scope(src, backup_dir)
    if path is None:
        return None
    if completed_callback is not None:
        try:
            completed_callback(path)
        except Exception:  # noqa: BLE001 — 성공한 로컬 백업과 콜백 실패는 별개다
            log_event(
                _backup_log,
                "backup_callback_failed",
                level=logging.ERROR,
                exc_info=True,
            )
    file_count, total_size = _completed_backup_info(path)
    log_event(
        _backup_log,
        "backup_completed",
        backup_set_files=file_count,
        backup_set_bytes=total_size,
    )
    print(f"[backup] DB 세트 백업 생성 → {path.name}")
    return path


class PeriodicBackup:
    """백그라운드 주기 백업. PeriodicSync 와 동일한 수명주기 패턴."""

    def __init__(self, interval: float = BACKUP_INTERVAL) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task] = None
        self._completed_callback: Callable[[Path], object] | None = None

    def set_completed_callback(self, callback: Callable[[Path], object] | None) -> None:
        """검증된 세트가 공개된 뒤 실행할 부수효과. 서버·테스트는 기본 None이다."""
        self._completed_callback = callback

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
        # NAS 파일 조회는 한 동기 helper로 묶어 poll당 to_thread 한 번만 사용한다.
        scope = _capture_backup_scope()
        src, backup_dir, _account_key = scope
        age, signature, backup_needed = await asyncio.to_thread(
            _read_poll_state,
            src,
            backup_dir,
        )
        # 시작 백업: 최근 백업이 충분히 새것이면 생략(재기동 난립 방지).
        if age is None or age >= _STARTUP_SKIP_IF_YOUNGER:
            await self._backup_once(scope)
            # 성공·실패 뒤의 최신 백업 시각을 다시 읽어 기존 시작 시점 판단을 보존한다.
            age, signature, backup_needed = await asyncio.to_thread(
                _read_poll_state,
                src,
                backup_dir,
            )
        changed_at = time.monotonic() if backup_needed else None
        while True:
            await asyncio.sleep(min(60.0, BACKUP_POLL_INTERVAL))
            current_scope = _capture_backup_scope()
            src, backup_dir, _account_key = current_scope
            age, current_signature, current_backup_needed = await asyncio.to_thread(
                _read_poll_state,
                src,
                backup_dir,
            )
            now = time.monotonic()
            if current_scope != scope:
                # 계정 전환 시 이전 계정의 dirty 시각을 버리고, 방금 읽은 새 계정 상태를
                # 독립 기준선으로 삼는다. 새 계정이 실제 dirty면 debounce를 지금부터 센다.
                scope = current_scope
                signature = current_signature
                changed_at = now if current_backup_needed else None
            elif current_signature != signature:
                signature = current_signature
                changed_at = now
            daily_due = age is None or age >= self._interval
            quiet_dirty_due = _change_backup_due(
                changed_at,
                age,
                now=now,
            )
            if daily_due or quiet_dirty_due:
                succeeded = await self._backup_once(scope)
                if succeeded:
                    # 백업 중 원본 DB를 쓰지 않으므로 방금 읽은 서명을 다음 비교 기준으로 재사용한다.
                    signature = current_signature
                    changed_at = None
                elif not current_signature:
                    # 초기화 전이거나 제거된 DB는 성공이 아니지만, 사라진 대상의 dirty를
                    # 무한히 유지할 이유도 없다. DB가 생기면 새 서명이 다시 변경을 알린다.
                    changed_at = None

    async def _backup_once(
        self,
        scope: tuple[Path, Path, str] | None = None,
    ) -> bool:
        """검증된 로컬 백업 경로가 생성된 경우에만 True를 반환한다."""
        try:
            # 스케줄러는 poll에서 캡처한 scope를 넘긴다. None은 직접 호출 호환 경로다.
            src, backup_dir, account_key = (
                _capture_backup_scope() if scope is None else scope
            )
            account_token = active_account.set_override(account_key)
            try:
                # 스레드가 백업 파일·콜백을 소유하는 동안 요청 취소가 와도 완료까지 기다린다.
                path = await to_thread_non_abandon(
                    _run_backup_cycle,
                    src,
                    backup_dir,
                    self._completed_callback,
                )
                return path is not None
            finally:
                active_account.reset_override(account_token)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — 워커가 죽지 않도록 격리
            log_event(_backup_log, "backup_failed", level=logging.ERROR, exc_info=True)
            print(f"[backup] 오류({type(e).__name__}) — MV_logs.bat에서 상세 확인")
            return False


periodic_backup = PeriodicBackup()
