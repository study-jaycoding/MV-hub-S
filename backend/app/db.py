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
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from . import config
from . import db_migrations

# backend/app/db.py → backend/ 가 기준 디렉터리
BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

# DB 경로는 환경변수로 재정의 가능(테스트·다중 워크스페이스 대비). 기본은 <데이터 루트>/db/content_hub.db.
# 데이터 루트는 config.DATA_DIR(= CONTENT_HUB_DATA) 를 따른다 — media/shared 와 같은 루트에 묶이게.
DEFAULT_DB_PATH = config.DATA_DIR / "db" / "content_hub.db"
# 구버전 경로(backend 루트 직속) — 재시작 시 새 위치로 1회 자동 이전.
_LEGACY_DB_PATH = BACKEND_DIR / "content_hub.db"

# 백엔드 스위치 — 현재 sqlite 만 지원. postgres 스택(pgsupport.py)은 미완(스키마·락 미갱신)이라
# 런타임 진입에서 명시 차단한다. 파일은 미래 복구용으로 보존하되, 옵트인처럼 조용히 실행되지 않게 한다.
DB_BACKEND = os.environ.get("CONTENT_HUB_DB_BACKEND", "sqlite").strip().lower()
_UNSUPPORTED_BACKEND = (
    "CONTENT_HUB_DB_BACKEND=%s 는 현재 미지원입니다 — sqlite 를 쓰세요. "
    "PostgreSQL 지원은 스키마·동시성(락) 갱신 전까지 보류 상태입니다(pgsupport.py 미완)."
)


def _assert_supported_backend() -> None:
    """모든 DB 접근 진입(get_connection·init_db)에서 호출 — sqlite 아닌 백엔드를 즉시 차단.
    startup 뿐 아니라 테스트·관리 스크립트·백업/복원도 get_connection 을 직접 쓰므로 여기서 막는다.
    나중에 PG 완성 시 이 가드만 풀면 복구된다."""
    if DB_BACKEND != "sqlite":
        raise RuntimeError(_UNSUPPORTED_BACKEND % DB_BACKEND)


def get_db_path() -> Path:
    """현재 사용할 DB 파일 경로.

    우선순위: ① 환경변수 CONTENT_HUB_DB ② 활성 계정(로컬 프록시 로그인 계정)의 전용 DB
    ③ 레거시 단일 DB(미로그인/단독·공유 서버). ②가 계정별 격리의 핵심 — 로그인 계정마다
    data/db/acct/<uid>/content_hub.db 로 갈라 다른 계정 데이터가 섞이지 않게 한다."""
    env = os.environ.get("CONTENT_HUB_DB")
    if env:
        return Path(env).expanduser().resolve()
    from .active_account import account_db_path, account_key

    key = account_key()
    return account_db_path(key) if key else DEFAULT_DB_PATH


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


def _seed_default_worker(path: Path) -> None:
    """새 계정 DB 에 기본 작업자('me') 행을 넣는다(멱등). generation.worker_id 는
    worker(id) 를 NOT NULL 참조하므로, 이 행이 없으면 첫 generation INSERT 가
    'FOREIGN KEY constraint failed'(500) 로 깨진다. startup 의 ensure_default_worker 는
    그 시점 활성 DB 에만 적용돼, 로그인 때 새로 만든 계정 DB 는 비어 있었다."""
    try:
        c = sqlite3.connect(str(path))
        try:
            c.execute(
                "INSERT INTO worker(id, name, account_type) VALUES(?,?,?) "
                "ON CONFLICT(id) DO NOTHING",
                (config.DEFAULT_WORKER_ID, config.DEFAULT_WORKER_NAME, "personal"),
            )
            c.commit()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        pass


def _legacy_owner(legacy: Path) -> Optional[str]:
    """레거시 DB 의 소유자 creator_uid 판별 — **강한 소유 신호만** 사용:
    ① my_creator_uid 설정 ② 로컬 생성본(id<>job_id = 이 허브가 직접 만든 것)의 creator_uid.

    ⚠️ '최다 creator_uid' 다수결은 일부러 쓰지 않는다 — 남의 공유 번들을 많이 동기화한 DB 라면
    그 남(teammate)의 uid 가 최다라서, 그 사람이 같은 PC 로 로그인하면 이 PC 주인의 사적 작업까지
    그 사람 계정 DB 로 복사되는 '교차 계정 누출'이 난다. id<>job_id 는 '이 PC 가 직접 생성' 한
    것이라 기계 주인의 확실한 표식이다(동기화본 id==job_id 와 구분). 둘 다 못 정하면 None(이관 안 함
    = 빈 DB 가 더 안전하다 — 잘못된 계정으로의 이관보다)."""
    try:
        c = sqlite3.connect(str(legacy))
        try:
            row = c.execute(
                "SELECT value FROM app_setting WHERE key='my_creator_uid'"
            ).fetchone()
            if row and row[0]:
                return row[0]
            row = c.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
            return row[0] if row and row[0] else None
        finally:
            c.close()
    except sqlite3.DatabaseError:
        return None


def _copy_sqlite(src: Path, dst: Path) -> None:
    """sqlite backup API 로 일관 복사(WAL 상태 무관 완전 스냅샷)."""
    s = sqlite3.connect(str(src))
    try:
        d = sqlite3.connect(str(dst))
        try:
            s.backup(d)
        finally:
            d.close()
    finally:
        s.close()


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
# 풀 에폭 — 올리면 모든 스레드의 풀 커넥션이 다음 사용 때 강제 재오픈된다(키에 포함). DB 파일을
# 같은 경로에 통째 교체(import/복원)하면 경로 문자열은 그대로라 재오픈이 안 되므로 에폭으로 무효화한다.
_pool_epoch = 0


def _pooled_conn(db_path: Path) -> sqlite3.Connection:
    key = (str(db_path), _pool_epoch)
    conn = getattr(_tls, "conn", None)
    if conn is not None and getattr(_tls, "path", None) == key:
        return conn
    if conn is not None:  # 경로/에폭 변경 → 옛 것 닫고 교체
        try:
            conn.close()
        except sqlite3.Error:
            pass
    conn = _connect(db_path)
    _tls.conn = conn
    _tls.path = key
    return conn


def pool_epoch() -> int:
    """현재 풀 에폭 — DB 파일 교체(import/복원)를 감지해야 하는 캐시 키에 쓴다(repo.manage 스키마 가드 등)."""
    return _pool_epoch


def flush_pool() -> None:
    """모든 스레드의 풀 커넥션을 무효화 — 다음 사용 때 새 파일로 재오픈한다. DB 파일을 같은 경로에
    교체(import/복원)한 직후 호출: 경로 문자열이 그대로라 _pooled_conn 이 옛 파일(이미 교체됨)을 계속
    돌려주는 걸 막는다. 에폭을 올려 캐시 키를 어긋나게 하고, 호출 스레드 것은 즉시 닫는다."""
    global _pool_epoch
    _pool_epoch += 1
    _discard_pooled_conn()


def _discard_pooled_conn() -> None:
    conn = getattr(_tls, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass
    _tls.conn = None
    _tls.path = None


@contextmanager
def _get_connection_sqlite(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """트랜잭션 단위 커넥션 컨텍스트(SQLite).

    요청 경로(db_path=None)면 스레드별 풀 커넥션을 재사용(닫지 않음, 예외 시 폐기). 명시 경로나
    풀 비활성(CONTENT_HUB_DB_POOL=0)이면 1회용으로 열고 항상 닫는다. 정상 종료=commit, 예외=rollback.
    """
    pooled = db_path is None and _POOL_ENABLED
    conn = _pooled_conn(get_db_path()) if pooled else _connect(db_path or get_db_path())
    try:
        yield conn
        if conn.in_transaction:
            conn.execute("COMMIT;")
    except Exception:
        try:
            if conn.in_transaction:
                conn.execute("ROLLBACK;")
        except sqlite3.Error:
            pass
        if pooled:
            _discard_pooled_conn()  # 손상 가능 → 다음 요청이 새로 연다
        raise
    finally:
        if not pooled:
            conn.close()


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
