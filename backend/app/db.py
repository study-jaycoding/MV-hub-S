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
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from . import config

# backend/app/db.py → backend/ 가 기준 디렉터리
BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_PATH = BACKEND_DIR / "schema.sql"

# DB 경로는 환경변수로 재정의 가능(테스트·다중 워크스페이스 대비). 기본은 <데이터 루트>/db/content_hub.db.
# 데이터 루트는 config.DATA_DIR(= CONTENT_HUB_DATA) 를 따른다 — media/shared 와 같은 루트에 묶이게.
DEFAULT_DB_PATH = config.DATA_DIR / "db" / "content_hub.db"
# 구버전 경로(backend 루트 직속) — 재시작 시 새 위치로 1회 자동 이전.
_LEGACY_DB_PATH = BACKEND_DIR / "content_hub.db"

# 백엔드 스위치 — 기본 sqlite(무변경). postgres 면 pgsupport 로 위임(Phase 3, 옵트인).
DB_BACKEND = os.environ.get("CONTENT_HUB_DB_BACKEND", "sqlite").strip().lower()


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
    return path


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
    # 페이지 캐시 64MB(음수 = KiB 단위) — 반복 조회 시 디스크 재접근 감소.
    conn.execute("PRAGMA cache_size = -65536;")
    # 메모리맵 읽기 256MB — read 시스템콜 대신 매핑으로 큰 폭 가속(읽기 위주 워크로드).
    conn.execute("PRAGMA mmap_size = 268435456;")
    # journal_mode=WAL 은 DB 파일에 영속(init_db 가 1회 설정)되므로 커넥션마다 재설정하지 않는다 —
    # 매 요청 재설정은 락을 잡고 체크포인트를 유발해 오히려 지연을 만든다.
    return conn


def get_connection(db_path: Path | None = None):
    """트랜잭션 단위 커넥션 컨텍스트(백엔드 무관). postgres 면 pgsupport 로 위임."""
    if DB_BACKEND == "postgres":
        from . import pgsupport

        return pgsupport.get_connection()
    return _get_connection_sqlite(db_path)


@contextmanager
def _get_connection_sqlite(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """트랜잭션 단위 커넥션 컨텍스트(SQLite).

    블록이 정상 종료되면 commit, 예외가 나면 rollback 후 항상 close.
    """
    conn = _connect(db_path or get_db_path())
    try:
        yield conn
        conn.execute("COMMIT;") if conn.in_transaction else None
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK;")
        raise
    finally:
        conn.close()


def init_db(db_path: Path | None = None) -> Path:
    """schema.sql 을 적용해 DB 를 초기화한다(멱등). 적용된 DB 경로를 반환."""
    if DB_BACKEND == "postgres":
        from . import pgsupport

        pgsupport.init_db()
        return SCHEMA_PATH  # 반환값은 사용처에서 무시됨(PG 는 DSN 기반)
    path = db_path or get_db_path()
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"스키마 파일을 찾을 수 없음: {SCHEMA_PATH}")

    path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_db_location(path)  # 연결 전에 구버전 위치 → 새 위치 이동
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")

    conn = _connect(path)
    try:
        _pre_migrate(conn)  # ★ executescript 이전 — 테이블 리네임(빈 테이블 충돌 회피)
        conn.executescript(schema_sql)
        _migrate(conn)
    finally:
        conn.close()
    return path


def _pre_migrate(conn: sqlite3.Connection) -> None:
    """schema.sql executescript **이전**에 도는 구조 마이그레이션(멱등).

    테이블 리네임은 여기서 해야 한다. schema.sql 의 `CREATE TABLE IF NOT EXISTS history` 가
    먼저 돌면(executescript), 기존 lineage 데이터와 분리된 '빈 history' 테이블이 생겨
    _migrate 의 RENAME 이 충돌한다(AI_CONTEXT §8 마이그레이션 순서 함정).
    """
    def _has(name: str) -> bool:
        return (
            conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            is not None
        )

    # 계보(lineage) → 히스토리(history) 테이블 리네임. lineage 만 있고 history 없을 때 1회.
    if _has("lineage") and not _has("history"):
        # 옛 인덱스는 RENAME 후에도 idx_lineage_* 이름으로 남는다 → 제거(schema.sql/_migrate 가
        # idx_history_* 로 재생성). 그래야 인덱스 네임스페이스도 깔끔히 이전된다.
        for idx in ("idx_lineage_parent", "idx_lineage_child", "idx_lineage_edge"):
            conn.execute(f"DROP INDEX IF EXISTS {idx}")
        conn.execute("ALTER TABLE lineage RENAME TO history")


def _migrate(conn: sqlite3.Connection) -> None:
    """기존 DB 에 누락된 컬럼을 추가(멱등). schema.sql 의 CREATE IF NOT EXISTS 는
    기존 테이블에 컬럼을 더하지 않으므로 여기서 보강한다."""
    for table in ("asset", "reference"):
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "source_url" not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN source_url TEXT")

    gen_cols = {row[1] for row in conn.execute("PRAGMA table_info(generation)")}
    if "job_id" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN job_id TEXT")
    # 소스 라이브러리: 생성본을 @이름 + 태그로 재사용(별도 테이블 없이 generation 플래그)
    if "is_source" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0")
    if "source_name" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN source_name TEXT")
    if "comment" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN comment TEXT")
    # UI 표시용 프롬프트(칩 자리에 @소스명 보존) — CLI 본문(prompt)과 분리
    if "display_prompt" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN display_prompt TEXT")
    # 실패 사유(CLI stderr 등) — status=failed 일 때 정보팝업에 표시
    if "error" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN error TEXT")
    # 힉스필드에서 삭제됨 플래그(로컬-only 판정) — generate get 검증으로 설정
    if "hf_missing" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN hf_missing INTEGER NOT NULL DEFAULT 0")
    # 생성자 식별자(result_url 의 user_<id>) — 팀 워크스페이스에서 작성자 구분
    if "creator_uid" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN creator_uid TEXT")
    # 프로젝트(작업 묶음) 귀속 — NULL = 미분류. 로드맵 §0-4/§4-4.
    if "project_id" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN project_id TEXT")
    # 휴지통(soft delete) — 우리 카탈로그에서만 숨김. NULL=정상, 시각=지운 때.
    # 힉스필드 원본엔 영향 없음(우리 DB 기록만). '지운 생성물 보기' 토글로 흐리게 재표시.
    if "deleted_at" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN deleted_at TEXT")
    # v02 CMS — Supervisor 최종(골드) 마킹. is_final + 누가/언제.
    if "is_final" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0")
    if "final_by" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN final_by TEXT")
    if "final_at" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN final_at TEXT")
    # 정렬용 정밀 epoch — 힉스필드 created_at(sub-second) 순서를 그대로 재현
    if "sort_ts" not in gen_cols:
        conn.execute("ALTER TABLE generation ADD COLUMN sort_ts REAL")
        # 기존 행: created_at(UTC 문자열) → epoch(초 정밀) backfill. 신규 동기화는 sub-second.
        conn.execute(
            "UPDATE generation SET sort_ts = strftime('%s', created_at) "
            "WHERE sort_ts IS NULL AND created_at IS NOT NULL"
        )
    # 코멘트 답글(parent_id) — 기존 asset_comment 에 보강
    ac_cols = {row[1] for row in conn.execute("PRAGMA table_info(asset_comment)")}
    if ac_cols and "parent_id" not in ac_cols:
        conn.execute("ALTER TABLE asset_comment ADD COLUMN parent_id TEXT")
    # 코멘트별 '내 알림 끄기' 캡처(muted) — asset/generation 코멘트 양쪽 보강
    if ac_cols and "muted" not in ac_cols:
        conn.execute("ALTER TABLE asset_comment ADD COLUMN muted INTEGER NOT NULL DEFAULT 0")
    gc_cols = {row[1] for row in conn.execute("PRAGMA table_info(generation_comment)")}
    if gc_cols and "muted" not in gc_cols:
        conn.execute("ALTER TABLE generation_comment ADD COLUMN muted INTEGER NOT NULL DEFAULT 0")
    # 프로젝트 수동 정렬 순서(관리자 탭 ↑/↓) — NULL=미지정(생성물 순 폴백).
    proj_cols = {row[1] for row in conn.execute("PRAGMA table_info(project)")}
    if proj_cols and "sort_order" not in proj_cols:
        conn.execute("ALTER TABLE project ADD COLUMN sort_order INTEGER")
    # ── 전역 태그(auto_tag) 계정별 소유화 — 옛 전역 UNIQUE(name) → UNIQUE(owner_uid, name) ──
    # 이름이 전역 유일이라 다른 계정이 같은 태그를 못 만들던 충돌(409)을 없앤다. 컬럼 추가만으론
    # UNIQUE 제약을 못 바꾸므로 테이블을 재구성(id 보존 → gen_auto_tag FK 유지). 레거시 행은
    # 단독 사용 시절 것이라 제공자(my_creator_uid) 소유로 이관(없으면 NULL).
    at_cols = {row[1] for row in conn.execute("PRAGMA table_info(auto_tag)")}
    if at_cols and "owner_uid" not in at_cols:
        # 제공자(서버 주인) creator_uid — identity.get_my_uid 와 같은 폴백: 설정값 우선,
        # 없으면 동기화된 내 생성물의 creator_uid(하우스 계정)로 추정. 둘 다 없으면 NULL.
        srow = conn.execute(
            "SELECT value FROM app_setting WHERE key='my_creator_uid'"
        ).fetchone()
        my_uid = (srow[0] if srow else None) or None
        if not my_uid:
            grow = conn.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
            my_uid = grow[0] if grow else None
        # 원자성: CREATE→INSERT→DROP→RENAME 를 한 트랜잭션으로 — 중간에 죽으면 auto_tag 가
        # 사라진 채(또는 RENAME 전) 남아 복구불가가 되던 위험 차단. autocommit 연결이라 명시 BEGIN.
        conn.execute("BEGIN")
        try:
            conn.execute(
                "CREATE TABLE auto_tag_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
                "owner_uid TEXT, UNIQUE(owner_uid, name))"
            )
            conn.execute(
                "INSERT INTO auto_tag_new(id, name, owner_uid) SELECT id, name, ? FROM auto_tag",
                (my_uid,),
            )
            conn.execute("DROP TABLE auto_tag")
            conn.execute("ALTER TABLE auto_tag_new RENAME TO auto_tag")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    # ── 에셋 파일 메타(asset_meta) 계정별 개인화 — PK (project,path) → (project,path,owner_uid) ──
    # 같은 파일에 각자 자기 소스/태그/컬러를 가져 남의 설정과 안 섞이게. 컬럼만으론 PK 를 못 바꾸므로
    # 재구성. 레거시 행(소유자 없음)은 단독 시절 것이라 제공자(my_creator_uid) 소유로 이관.
    am_cols = {row[1] for row in conn.execute("PRAGMA table_info(asset_meta)")}
    if am_cols and "owner_uid" not in am_cols:
        srow = conn.execute(
            "SELECT value FROM app_setting WHERE key='my_creator_uid'"
        ).fetchone()
        my_uid = (srow[0] if srow else None) or None
        if not my_uid:
            grow = conn.execute(
                "SELECT creator_uid FROM generation "
                "WHERE id<>job_id AND job_id IS NOT NULL AND creator_uid IS NOT NULL LIMIT 1"
            ).fetchone()
            my_uid = grow[0] if grow else None
        # 원자성: 위 auto_tag 와 동일 이유로 한 트랜잭션으로 묶는다.
        conn.execute("BEGIN")
        try:
            conn.execute(
                "CREATE TABLE asset_meta_new (project TEXT NOT NULL, path TEXT NOT NULL, "
                "owner_uid TEXT NOT NULL DEFAULT '', is_source INTEGER NOT NULL DEFAULT 0, "
                "source_name TEXT, tags TEXT, comment TEXT, color TEXT, "
                "PRIMARY KEY(project, path, owner_uid))"
            )
            conn.execute(
                "INSERT INTO asset_meta_new(project, path, owner_uid, is_source, source_name, "
                "tags, comment, color) SELECT project, path, COALESCE(?, ''), is_source, "
                "source_name, tags, comment, color FROM asset_meta",
                (my_uid,),
            )
            conn.execute("DROP TABLE asset_meta")
            conn.execute("ALTER TABLE asset_meta_new RENAME TO asset_meta")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    # v02 히스토리 타입드 엣지 — 'derived'(재생성/가져오기·강한 1-부모) / 'reference'(@소스 생성·약한 다-부모)
    # (테이블명 lineage→history 리네임은 _pre_migrate 가 executescript 이전에 처리 → 여기선 history 보장)
    hist_cols = {row[1] for row in conn.execute("PRAGMA table_info(history)")}
    if hist_cols and "relation" not in hist_cols:
        conn.execute("ALTER TABLE history ADD COLUMN relation TEXT NOT NULL DEFAULT 'derived'")
    # (parent,child,relation) 중복 방지 — INSERT OR IGNORE 멱등성의 근거
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_history_edge "
        "ON history(parent_gen_id, child_gen_id, relation)"
    )
    # ── v02 RBAC — 전역 4역할(복수 가능) + 프로젝트 3역할 (로드맵 PART 1) ──────
    # 레거시 C0~C5 는 제거됨. global_role(CSV, 복수) + project_role 만 사용.
    cr_cols = {row[1] for row in conn.execute("PRAGMA table_info(creator)")}
    _migrate_rbac(conn, cr_cols)
    # 컬럼이 존재함을 보장한 뒤 인덱스 생성(신규/기존 DB 공통, 멱등)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_job ON generation(job_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_source ON generation(is_source)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_project ON generation(project_id)")
    # 목록 정렬 키(sort_ts DESC, created_at DESC) — 모든 list 조회의 ORDER BY 와 일치 →
    # 매 조회 전체 정렬(filesort) 제거. 인덱스를 그 순서로 읽어 LIMIT 만큼만 본다.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_generation_sort "
        "ON generation(sort_ts DESC, created_at DESC)"
    )
    # 팀 탭/공유 필터의 EXISTS·DISTINCT(share.generation_id) 가속 — 행마다 스캔 방지.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_share_gen ON share(generation_id)")

    # ── Phase 0: 규모 독립 성능(수만~수십만 건) ─────────────────────────────
    # 과거 동기화 경로가 sort_ts 를 NULL 로 남겼을 수 있다(컬럼 추가 시 backfill 은 그때만 1회).
    # 키셋 페이지네이션은 sort_ts 가 NULL 이면 그 행을 영영 못 보므로, 매 부팅마다 NULL 만 보강(멱등).
    conn.execute(
        "UPDATE generation SET sort_ts = strftime('%s', created_at) "
        "WHERE sort_ts IS NULL AND created_at IS NOT NULL"
    )
    # 키셋(seek) 페이지네이션 인덱스 — ORDER BY sort_ts DESC, id DESC 와 정확히 일치.
    # OFFSET(건너뛴 N행 스캔)을 대체해, 몇만 번째 페이지든 일정 속도로 다음 묶음만 읽는다.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_generation_keyset "
        "ON generation(sort_ts DESC, id DESC)"
    )
    # facets 의 SELECT DISTINCT color 가 전체 generation 스캔이 되지 않게(캐싱 대신 인덱스 — staleness 0).
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_color ON generation(color)")
    # 실패 정리·media 필터 등 status 조건 가속.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_generation_status ON generation(status)")
    # 태그·자동태그 역방향(이름 IN (...) → generation) — 사이드바 필터가 행마다 스캔하지 않게.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_gentag_tag ON gen_tag(tag_id, generation_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_genautotag_tag "
        "ON gen_auto_tag(auto_tag_id, generation_id)"
    )
    # ── 생성본 코멘트 '개별 확인(seen)' 시드(1회) ─────────────────────────────
    # 기존 gen 단위 read_at 을 코멘트 단위 seen 으로 승격: 과거에 패널을 열어 read_at 이 박힌
    # 코멘트(created_at <= read_at)는 이미 본 것이므로 seen 으로 채운다. seen 이 비고 read 가
    # 있을 때만(=첫 업그레이드 부팅) 1회 — 멱등 가드로 매 부팅 재스캔 방지.
    seen_empty = conn.execute(
        "SELECT NOT EXISTS(SELECT 1 FROM generation_comment_seen)"
    ).fetchone()[0]
    read_any = conn.execute(
        "SELECT EXISTS(SELECT 1 FROM generation_comment_read)"
    ).fetchone()[0]
    if seen_empty and read_any:
        conn.execute(
            "INSERT OR IGNORE INTO generation_comment_seen(worker_id, comment_id, seen_at) "
            "SELECT rd.worker_id, c.id, rd.read_at "
            "FROM generation_comment c "
            "JOIN generation_comment_read rd ON rd.gen_id = c.gen_id "
            "WHERE c.created_at <= rd.read_at"
        )
    _migrate_fts(conn)


def _migrate_rbac(conn: sqlite3.Connection, cr_cols: set) -> None:
    """v02 RBAC 마이그레이션 — global_role(account·creator, CSV 복수) + project_role(project_member).

    global_role 은 CSV 문자열로 복수 역할을 담는다(예: 'product_director,production_director').
    레거시 C0~C5 는 제거됨. 컬럼만 보강하고, 승인된 계정 중 전역 역할 미지정이면 기본 member 로 채운다."""
    # account.global_role — 로그인 계정(enforcement 가 읽는 축)
    ac_cols = {row[1] for row in conn.execute("PRAGMA table_info(account)")}
    if ac_cols and "global_role" not in ac_cols:
        conn.execute("ALTER TABLE account ADD COLUMN global_role TEXT")
    # 계정 숨김(관리자가 옛/테스트 계정을 목록에서 가림) — NULL/0=보임, 1=숨김. '숨긴 계정 보기'로 재표시.
    if ac_cols and "hidden" not in ac_cols:
        conn.execute("ALTER TABLE account ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")
    # creator.global_role — 멤버 목록(관리자 창이 보여주고 고치는 축)
    if cr_cols and "global_role" not in cr_cols:
        conn.execute("ALTER TABLE creator ADD COLUMN global_role TEXT")
    # project_member.project_role — 그 프로젝트 안에서의 역할(단일)
    pm_cols = {row[1] for row in conn.execute("PRAGMA table_info(project_member)")}
    if pm_cols and "project_role" not in pm_cols:
        conn.execute("ALTER TABLE project_member ADD COLUMN project_role TEXT")

    # 전역 역할 미지정(빈/NULL) 계정은 기본 member 로(enforcement 일관). 멱등.
    if ac_cols:
        conn.execute(
            "UPDATE account SET global_role='member' "
            "WHERE global_role IS NULL OR global_role=''"
        )
        # 락아웃 최종 방어: admin 이 하나도 없으면 가장 먼저 만든 계정을 admin 으로 승격
        # (업그레이드·데이터 이행 등으로 관리자가 사라져 승인·역할부여가 막히는 상황 방지).
        if not conn.execute(
            "SELECT 1 FROM account WHERE global_role LIKE '%admin%' LIMIT 1"
        ).fetchone():
            first = conn.execute(
                "SELECT email FROM account ORDER BY created_at, email LIMIT 1"
            ).fetchone()
            if first:
                conn.execute(
                    "UPDATE account SET global_role='admin' WHERE email=?", (first["email"],)
                )
    # 역할명 변경: product_director → product_manager (CSV 안에서 치환, 멱등).
    # 'production_director' 는 부분문자열이 아니라 영향 없음.
    for tbl in ("account", "creator"):
        if {"global_role"} <= {r[1] for r in conn.execute(f"PRAGMA table_info({tbl})")}:
            conn.execute(
                f"UPDATE {tbl} SET global_role=REPLACE(global_role,'product_director','product_manager') "
                f"WHERE global_role LIKE '%product_director%'"
            )
    # 데드락 방지: 프로젝트를 만들 수 있는 사람(product_manager)이 한 명도 없으면
    # admin 계정에게 product_manager 를 함께 부여한다(소유자가 프로젝트를 못 만드는 상황 해소).
    if ac_cols:
        has_pm = conn.execute(
            "SELECT 1 FROM account WHERE global_role LIKE '%product_manager%' LIMIT 1"
        ).fetchone()
        if not has_pm:
            conn.execute(
                "UPDATE account SET global_role=global_role || ',product_manager' "
                "WHERE status='approved' AND global_role LIKE '%admin%' "
                "AND global_role NOT LIKE '%product_manager%'"
            )
    # 인덱스 — 프로젝트 역할 조회(특정 uid 의 그 프로젝트 역할) 가속
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_member_uid "
        "ON project_member(creator_uid, project_id)"
    )


# FTS5 사용 가능 여부(검색 경로 선택용). _migrate 가 1회 설정. None=아직 미확인.
FTS_ENABLED: bool = False


def _migrate_fts(conn: sqlite3.Connection) -> None:
    """검색 가속용 FTS5(trigram) 인덱스 — prompt LIKE '%...%' 전체 스캔 제거.

    trigram 토크나이저는 부분일치(substring)를 그대로 보존하므로 기존 검색 의미가 안 바뀐다
    (3자 이상일 때. 3자 미만은 repo 가 LIKE 로 폴백). external content + 트리거로 generation 과
    자동 동기 — 어느 코드 경로로 INSERT/UPDATE/DELETE 하든 색인이 따라온다.
    FTS5 미탑재 빌드면 조용히 건너뛰고 검색은 LIKE 로 폴백(기능 동일, 속도만 차이)."""
    global FTS_ENABLED
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_fts'"
        ).fetchone()
        if not exists:
            conn.execute(
                "CREATE VIRTUAL TABLE generation_fts USING fts5("
                "prompt, source_name, content='generation', content_rowid='rowid', "
                "tokenize='trigram')"
            )
            # 트리거 — searchable 필드(prompt/source_name)가 바뀔 때만 재색인(status 등 잦은 갱신엔 무비용).
            conn.executescript(
                """
                CREATE TRIGGER generation_fts_ai AFTER INSERT ON generation BEGIN
                  INSERT INTO generation_fts(rowid, prompt, source_name)
                  VALUES (new.rowid, new.prompt, new.source_name);
                END;
                CREATE TRIGGER generation_fts_ad AFTER DELETE ON generation BEGIN
                  INSERT INTO generation_fts(generation_fts, rowid, prompt, source_name)
                  VALUES ('delete', old.rowid, old.prompt, old.source_name);
                END;
                CREATE TRIGGER generation_fts_au AFTER UPDATE ON generation
                WHEN new.prompt IS NOT old.prompt OR new.source_name IS NOT old.source_name
                BEGIN
                  INSERT INTO generation_fts(generation_fts, rowid, prompt, source_name)
                  VALUES ('delete', old.rowid, old.prompt, old.source_name);
                  INSERT INTO generation_fts(rowid, prompt, source_name)
                  VALUES (new.rowid, new.prompt, new.source_name);
                END;
                """
            )
            # 기존 행 일괄 색인(외부 콘텐츠에서 재구성, 멱등).
            conn.execute("INSERT INTO generation_fts(generation_fts) VALUES('rebuild')")
        FTS_ENABLED = True
    except sqlite3.OperationalError as e:
        FTS_ENABLED = False
        print(f"[migrate] FTS5 사용 불가 — 검색은 LIKE 폴백: {e}")


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
