"""SQLite 연결·초기화 (Phase 1).

설계 근거: DESIGN.md §1(로컬 우선) / §2(데이터 모델), CLAUDE.md 설계 원칙 1.

핵심:
- WAL 저널 모드 — 읽기(UI 탐색)와 쓰기(생성 기록)가 서로를 막지 않게 한다.
  WAL 은 DB 파일에 영속되는 설정이라 한 번만 켜도 유지되지만, 신규 파일에서도
  확실히 적용되도록 init 시 명시적으로 선언한다.
- foreign_keys 는 SQLite 에서 커넥션마다 꺼진 채 시작하므로, 모든 커넥션에서
  다시 ON 으로 켠다. 안 켜면 ON DELETE CASCADE / 참조 무결성이 동작하지 않는다.

사용:
    from app.db import get_connection, init_db

    init_db()                      # 최초 1회 (스키마 적용 + WAL 확인)
    with get_connection() as conn:
        conn.execute("INSERT INTO worker (id, name) VALUES (?, ?)", (...))

CLI:
    python -m app.db init          # DB 생성 + 스키마 적용
    python -m app.db check         # 현재 PRAGMA 상태 출력
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from . import config
from . import db_migrations
# 계정별 DB 순수 헬퍼(순환 없음) — ensure_account_db 가 호출하고, db._copy_sqlite 는 db_transfer.py 가 쓴다.
from .db_account_dbs import _copy_sqlite, _legacy_owner, _seed_default_worker
from .db_paths import DEFAULT_DB_PATH, LEGACY_DB_PATH as _LEGACY_DB_PATH, get_db_path

# backend/app/db.py → backend/ 가 기준 디렉터리
BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

# 백엔드 스위치 — sqlite 만 지원. 다른 값이 설정돼도 조용히 오작동하지 않게 진입에서 명시 차단한다.
DB_BACKEND = os.environ.get("CONTENT_HUB_DB_BACKEND", "sqlite").strip().lower()
_UNSUPPORTED_BACKEND = "CONTENT_HUB_DB_BACKEND=%s 는 미지원입니다 — sqlite 를 쓰세요."


def _assert_supported_backend() -> None:
    """모든 DB 접근 진입(get_connection·init_db)에서 호출 — sqlite 아닌 백엔드를 즉시 차단.
    startup 뿐 아니라 테스트·관리 스크립트·백업/복원도 get_connection 을 직접 쓰므로 여기서 막는다."""
    if DB_BACKEND != "sqlite":
        raise RuntimeError(_UNSUPPORTED_BACKEND % DB_BACKEND)


def ensure_account_db(email: str, owner_uid: Optional[str] = None) -> Path:
    """그 계정(email) 전용 DB 가 없으면 만든다(현재 스키마로 init). 레거시 단일 DB 의 주인
    (my_creator_uid == owner_uid)이면 1회 통째 이관(휴지통·마운트 동반) — 기존 단독 사용자의
    데이터가 첫 계정 전환 때 그 계정 DB 로 자연스럽게 옮겨가게 한다. 멱등."""
    from .active_account import account_db_path

    path = account_db_path(email)
    if path.exists():
        _seed_default_worker(path)  # 이전 버전이 안 넣은 기존 계정 DB 도 로그인 때 보강(멱등)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    legacy = DEFAULT_DB_PATH
    if legacy.is_file() and owner_uid and _legacy_owner(legacy) == owner_uid:
        # 레거시 → 계정 DB 통째 이관(WAL 접은 일관 스냅샷). 휴지통도 같은 폴더로 복사.
        _copy_sqlite(legacy, path)
        legacy_trash = legacy.parent / "content_hub_trash.db"
        if legacy_trash.is_file():
            _copy_sqlite(legacy_trash, path.parent / "content_hub_trash.db")
        # 에셋 마운트(레거시 단일 파일)도 그 주인 계정 폴더로 이관 — 폴더 목록 보존.
        legacy_mounts = config.DATA_DIR / "asset_mounts.json"
        if legacy_mounts.is_file():
            try:
                shutil.copy2(legacy_mounts, path.parent / "asset_mounts.json")
            except OSError:
                pass
        print(f"[migrate] 레거시 DB → 계정 DB 이관: {legacy} → {path}")
    init_db(path)  # 빈 DB든 이관본이든 현재 스키마로 보강(멱등)
    _seed_default_worker(path)  # ★기본 작업자('me') 시드 — 없으면 첫 적재가 FK 로 깨진다
    return path


def _migrate_db_location(path: Path) -> None:
    """구버전 backend/content_hub.db → data/db/ 로 1회 이전(멱등, WAL·SHM 동반).
    기본 경로를 쓰고 새 위치가 아직 없을 때만 이동(env 재정의·기존 데이터 보호)."""
    if path != DEFAULT_DB_PATH or path.exists() or not _LEGACY_DB_PATH.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(_LEGACY_DB_PATH) + suffix)
        if src.exists():
            shutil.move(str(src), str(Path(str(path) + suffix)))
    print(f"[migrate] DB 이전: {_LEGACY_DB_PATH} → {path}")


def _connect(db_path: Path) -> sqlite3.Connection:
    """커넥션을 만들고 로컬-우선 워크로드에 맞는 PRAGMA 를 적용한다."""
    conn = sqlite3.connect(
        db_path,
        # 파이썬이 BEGIN 을 자동 삽입하지 않게 해 명시적 트랜잭션 제어를 가능케 한다.
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    # 커넥션마다 반드시 다시 켜야 하는 설정(SQLite 는 연결마다 꺼진 채 시작)
    conn.execute("PRAGMA foreign_keys = ON;")
    # WAL 과 함께 쓰는 권장 동기화 레벨 — 내구성과 속도의 균형
    conn.execute("PRAGMA synchronous = NORMAL;")
    # 동기화 쓰기(20초 주기)와 읽기가 겹쳐도 'database is locked' 즉시 실패 대신 대기.
    conn.execute("PRAGMA busy_timeout = 5000;")
    # 정렬/임시 B-tree(ORDER BY·GROUP BY)를 디스크 대신 메모리에서 — 목록 정렬 가속.
    conn.execute("PRAGMA temp_store = MEMORY;")
    # 페이지 캐시 32MB(음수 = KiB 단위) — 반복 조회 시 디스크 재접근 감소. 풀로 커넥션이 스레드별
    # 장수명이 되어 합산 메모리가 커질 수 있으므로 64→32MB 로 낮춰 상한을 묶는다(핫 페이지는 충분).
    conn.execute("PRAGMA cache_size = -32768;")
    # 메모리맵 읽기 256MB — read 시스템콜 대신 매핑으로 큰 폭 가속(읽기 위주 워크로드).
    conn.execute("PRAGMA mmap_size = 268435456;")
    # journal_mode=WAL 은 DB 파일에 영속(init_db 가 1회 설정)되므로 커넥션마다 재설정하지 않는다 —
    # 매 요청 재설정은 락을 잡고 체크포인트를 유발해 오히려 지연을 만든다.
    try:
        from .services.runtime_metrics import metrics

        metrics.record_db_connection_opened()
    except Exception:
        pass  # 관측 실패가 DB 연결을 막지 않게
    return conn


def get_connection(db_path: Path | None = None):
    """트랜잭션 단위 커넥션 컨텍스트(sqlite). 미지원 백엔드면 진입에서 차단."""
    _assert_supported_backend()
    return _get_connection_sqlite(db_path)


# ── 스레드별 커넥션 풀(요청 경로) ──────────────────────────────────────────────
# 매 요청 새 커넥션 + 6개 PRAGMA(특히 mmap 256MB) 재설정 비용을 없앤다. FastAPI 동기 엔드포인트는
# anyio 스레드풀에서 돌고, SQLite 커넥션은 '스레드당 하나'면 안전하다(한 스레드는 요청을 순차 처리).
# DB 경로가 바뀌면(계정 전환 → active.json) 옛 커넥션을 닫고 새로 연다. 예외가 난 커넥션은 손상
# 가능성이 있어 폐기하고 다음 요청이 새로 열게 한다. CONTENT_HUB_DB_POOL=0 으로 끌 수 있다(안전장치).
_POOL_ENABLED = os.environ.get("CONTENT_HUB_DB_POOL", "1").strip() != "0"
_tls = threading.local()
# 풀 홀더는 워커 스레드의 thread-local 이 강하게 보유하고, 전역에는 약하게만 등록한다.
# 죽은 워커 스레드의 holder/커넥션을 이 레지스트리가 영구히 붙잡아 Windows 파일 잠금을
# 남기지 않게 WeakSet 을 쓴다.
class _PooledConnectionHolder:
    def __init__(self) -> None:
        self.conn: sqlite3.Connection | None = None
        self.path: tuple[str, int] | None = None

    def __del__(self) -> None:
        # 죽은 워커의 thread-local 이 사라질 때도 SQLite 핸들을 즉시 닫는다. WeakSet 은 holder를
        # 살려 두지 않으므로 이 경로가 없으면 GC 시점까지 Windows 파일 잠금이 남을 수 있다.
        conn = self.conn
        self.conn = None
        self.path = None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


_pool_lock = threading.RLock()
_pool_condition = threading.Condition(_pool_lock)
_pooled_holders: weakref.WeakSet[_PooledConnectionHolder] = weakref.WeakSet()
# 풀 에폭 — 올리면 모든 스레드의 풀 커넥션이 다음 사용 때 강제 재오픈된다(키에 포함). DB 파일을
# 같은 경로에 통째 교체(import/복원)하면 경로 문자열은 그대로라 재오픈이 안 되므로 에폭으로 무효화한다.
_pool_epoch = 0
_maintenance_active = False
_active_connection_contexts = 0
# 복원은 오래 열린 요청을 강제로 닫지 않는다. 이 시간 안에 끝나지 않으면 교체를 취소해 원본을
# 지키고, 게이트를 풀어 해당 요청이 계속 처리되게 한다.
_MAINTENANCE_DRAIN_SECONDS = 5.0


class DatabaseMaintenanceTimeout(RuntimeError):
    """진행 중 DB 요청이 유지보수 대기 시간 안에 끝나지 않았을 때의 안전 중단."""


def maintenance_active() -> bool:
    """DB 파일 교체 게이트가 올라가 있는지 잠금 안에서 즉시 확인한다.

    `/api/ready` 같은 생존 점검은 유지보수 종료를 기다리면 워치독에 무응답으로 보일 수 있다.
    이 함수는 DB 커넥션을 열지 않고 현재 상태만 반환해 유지보수를 명시적인 503으로 알리게 한다.
    """
    with _pool_condition:
        return _maintenance_active


def _thread_pooled_holder() -> _PooledConnectionHolder:
    """현재 워커의 풀 상태를 만들고 약한 전역 레지스트리에 등록한다."""
    holder = getattr(_tls, "holder", None)
    if holder is None:
        holder = _PooledConnectionHolder()
        _tls.holder = holder
        # 등록과 레지스트리 순회/플러시는 같은 락으로 직렬화한다.
        with _pool_condition:
            _pooled_holders.add(holder)
    return holder


def _pooled_conn(db_path: Path) -> sqlite3.Connection:
    holder = _thread_pooled_holder()
    # 에폭 읽기·holder 교체·전역 flush 는 한 락 규율로 묶는다. 유지보수 게이트가 올라간
    # 뒤에는 새 get_connection() 이 여기까지 오지 않으므로, close 뒤 옛 파일을 다시 여는
    # 경합도 없다.
    with _pool_condition:
        key = (str(db_path), _pool_epoch)
        if holder.conn is not None and holder.path == key:
            return holder.conn
        if holder.conn is not None:  # 경로/에폭 변경 → 옛 것 닫고 교체
            try:
                holder.conn.close()
            except sqlite3.Error:
                pass
        conn = _connect(db_path)
        holder.conn = conn
        holder.path = key
        return conn


def pool_epoch() -> int:
    """현재 풀 에폭 — DB 파일 교체(import/복원)를 감지해야 하는 캐시 키에 쓴다(repo.manage 스키마 가드 등)."""
    with _pool_condition:
        return _pool_epoch


def flush_pool() -> None:
    """모든 스레드의 풀 커넥션을 무효화 — 다음 사용 때 새 파일로 재오픈한다. DB 파일을 같은 경로에
    교체(import/복원)한 직후 호출: 경로 문자열이 그대로라 _pooled_conn 이 옛 파일(이미 교체됨)을 계속
    돌려주는 걸 막는다. 에폭을 올려 캐시 키를 어긋나게 하고, 레지스트리의 전 커넥션을 닫는다.

    활성 컨텍스트를 닫는 것은 안전하지 않으므로, DB 파일 교체에서는 반드시 maintenance_gate() 안에서
    호출한다. 일반 flush 는 기존처럼 호출자가 그 안전 시점을 보장해야 한다.
    """
    global _pool_epoch
    with _pool_condition:
        _pool_epoch += 1
        holders = list(_pooled_holders)
        for holder in holders:
            conn = holder.conn
            holder.conn = None
            holder.path = None
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass


def _discard_pooled_conn() -> None:
    holder = getattr(_tls, "holder", None)
    if holder is None:
        return
    with _pool_condition:
        conn = holder.conn
        holder.conn = None
        holder.path = None
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass


def _enter_connection_context() -> None:
    """유지보수 중에는 새 DB 요청을 멈추고, 아니면 활성 요청 수를 기록한다."""
    global _active_connection_contexts
    with _pool_condition:
        while _maintenance_active:
            _pool_condition.wait()
        _active_connection_contexts += 1


def _leave_connection_context() -> None:
    global _active_connection_contexts
    with _pool_condition:
        _active_connection_contexts -= 1
        if _active_connection_contexts == 0:
            _pool_condition.notify_all()


@contextmanager
def maintenance_gate(timeout: float = _MAINTENANCE_DRAIN_SECONDS) -> Iterator[None]:
    """DB 파일 교체 전용 게이트.

    새 get_connection() 진입을 막은 뒤 이미 실행 중인 컨텍스트가 자연 종료할 때까지 기다린다.
    시간 안에 비워지지 않으면 열린 커넥션을 강제로 닫지 않고 교체 자체를 취소한다. 게이트 안에서는
    flush_pool() → checkpoint/sidecar 정리 → 파일 교체 → init_db 순서만 수행해야 한다.
    """
    global _maintenance_active
    with _pool_condition:
        while _maintenance_active:
            _pool_condition.wait()
        _maintenance_active = True
        deadline = time.monotonic() + timeout
        while _active_connection_contexts:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _maintenance_active = False
                _pool_condition.notify_all()
                raise DatabaseMaintenanceTimeout(
                    "진행 중인 DB 요청이 끝나지 않아 복원을 안전하게 시작할 수 없습니다"
                )
            _pool_condition.wait(remaining)
    try:
        yield
    finally:
        with _pool_condition:
            _maintenance_active = False
            _pool_condition.notify_all()


@contextmanager
def _get_connection_sqlite(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """트랜잭션 단위 커넥션 컨텍스트(SQLite).

    요청 경로(db_path=None)면 스레드별 풀 커넥션을 재사용(닫지 않음, 예외 시 폐기). 명시 경로나
    풀 비활성(CONTENT_HUB_DB_POOL=0)이면 1회용으로 열고 항상 닫는다. 정상 종료=commit, 예외=rollback.
    """
    _enter_connection_context()
    pooled = db_path is None and _POOL_ENABLED
    conn: sqlite3.Connection | None = None
    try:
        conn = _pooled_conn(get_db_path()) if pooled else _connect(db_path or get_db_path())
        yield conn
        if conn.in_transaction:
            conn.execute("COMMIT;")
    except BaseException as exc:
        if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
            try:
                from .services.runtime_metrics import metrics

                metrics.record_db_locked()
            except Exception:
                pass  # 관측 실패가 원래 DB 예외를 가리지 않게
        if conn is not None:
            try:
                if conn.in_transaction:
                    conn.execute("ROLLBACK;")
            except sqlite3.Error:
                pass
        if pooled:
            _discard_pooled_conn()  # 손상 가능 → 다음 요청이 새로 연다
        raise
    finally:
        try:
            if not pooled and conn is not None:
                conn.close()
        finally:
            _leave_connection_context()


def init_db(db_path: Path | None = None) -> Path:
    """schema.sql 을 적용해 DB 를 초기화한다(멱등). 적용된 DB 경로를 반환."""
    _assert_supported_backend()
    path = db_path or get_db_path()
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"스키마 파일을 찾을 수 없음: {SCHEMA_PATH}")

    path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_db_location(path)  # 연결 전에 구버전 위치 → 새 위치 이동
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    conn = _connect(path)
    try:
        db_migrations._pre_migrate(conn)  # ★ executescript 이전 — 테이블 리네임(빈 테이블 충돌 회피)
        conn.executescript(schema_sql)
        db_migrations._migrate(conn)
    finally:
        conn.close()
    return path


def check_db(db_path: Path | None = None) -> dict[str, str]:
    """현재 DB 의 주요 PRAGMA 상태를 읽어 반환(진단용)."""
    path = db_path or get_db_path()
    conn = _connect(path)
    try:
        journal = conn.execute("PRAGMA journal_mode;").fetchone()[0]
        fk = conn.execute("PRAGMA foreign_keys;").fetchone()[0]
        sync = conn.execute("PRAGMA synchronous;").fetchone()[0]
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
            ).fetchall()
        ]
    finally:
        conn.close()
    return {
        "db_path": str(path),
        "journal_mode": journal,
        "foreign_keys": "ON" if fk else "OFF",
        "synchronous": str(sync),
        "tables": ", ".join(tables) or "(없음)",
    }


def _main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "init"
    if cmd == "init":
        path = init_db()
        print(f"[init] DB 초기화 완료 → {path}")
        for k, v in check_db().items():
            print(f"  {k}: {v}")
        return 0
    if cmd == "check":
        for k, v in check_db().items():
            print(f"{k}: {v}")
        return 0
    print(f"알 수 없는 명령: {cmd!r} (사용: init | check)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
