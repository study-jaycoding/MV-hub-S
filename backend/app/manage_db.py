"""팀 매니징 텔레메트리 전용 DB(manage_hub.db) — 콘텐츠/공유 DB와 물리적으로 분리.

왜 별도 파일인가(코덱스+클로드 합의):
  콘텐츠·공유 쿼리는 generation 테이블을 직접 조인한다(repo/manage.py 등). 같은 DB 안에
  팀 전체의 '비공유' 작업 메타까지 넣으면, 라이브러리·검색·폴더 카운트에서 그 데이터가 다시
  샐 수 있다(실제로 folder 카운트 누출 사고가 있었다). 파일을 분리하면 콘텐츠 코드가
  구조적으로 이 저장소를 열 수 없어 누출이 원천 차단된다.

무엇을 담나: 메타(작업자·프로젝트·폴더·모델·크레딧·시간·상태)만. 프롬프트·미디어·레퍼런스·
  댓글은 담지 않는다. 각 작업자의 로컬 허브가 /api/manage/telemetry/push 로 이 저장소에 올린다
  (upsert 멱등). 이 파일은 주로 공유 서버(AUTH on)에서 팀 전체를 모으는 용도다.

읽기 우선/로컬 우선과의 관계: '읽기=로컬 DB'는 그대로다. 이 저장소는 별개 채널(자동 메타 push)로,
  콘텐츠 열람 경로와 섞이지 않는다.
"""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from .config import DATA_DIR

# 콘텐츠 DB(content_hub.db) 와 같은 폴더에 두되 파일만 분리 — 백업은 폴더 통째로 한 번에 된다.
MANAGE_DB_PATH = (DATA_DIR / "db" / "manage_hub.db").resolve()

# 단일 팩트 테이블 — 생성물 1건 = 1행. 이름(프로젝트·작성자)은 스냅샷으로 박아 콘텐츠 DB 조인을
# 아예 없앤다(격리의 핵심). 멱등 키는 (account_email, local_gen_id): 항상 존재하고 계정 내 유일.
# job_id 는 매칭·보조 조회용 인덱스(nullable). 삭제는 tombstone(is_deleted)로 남겨 비용 이력 보존.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS team_generation_fact (
    id              TEXT PRIMARY KEY,        -- 서버 생성 uuid(행 식별)
    account_email   TEXT NOT NULL,           -- 올린 계정(서버가 인증 신원과 대조)
    creator_uid     TEXT,                    -- 힉스필드 생성자 uid(귀속)
    creator_name    TEXT,                    -- 표시이름 스냅샷
    local_gen_id    TEXT NOT NULL,           -- 작업자 로컬 generation id
    job_id          TEXT,                    -- 힉스필드 잡 앵커(nullable)
    project_id      TEXT,
    project_name    TEXT,                    -- 스냅샷(콘텐츠 DB 조인 회피)
    folder_path     TEXT,
    model           TEXT,
    output_type     TEXT,                    -- image/video 등
    status          TEXT,
    real_credits    REAL,                    -- 로컬에서 트랜잭션 매칭된 실제 크레딧(늦게 채워질 수 있어 NULL 허용)
    est_credits     REAL,
    credit_source   TEXT,
    elapsed_seconds REAL,
    created_at      TEXT,                    -- 생성일
    started_at      TEXT,
    completed_at    TEXT,
    sort_ts         TEXT,
    is_final        INTEGER DEFAULT 0,
    is_shared       INTEGER DEFAULT 0,
    is_deleted      INTEGER DEFAULT 0,       -- tombstone(비용 이력 보존)
    deleted_at      TEXT,
    last_seen_at    TEXT,                    -- 마지막 push 시각
    updated_at      TEXT,
    UNIQUE(account_email, local_gen_id)      -- 멱등 upsert 대상
);
CREATE INDEX IF NOT EXISTS idx_tgf_creator ON team_generation_fact(creator_uid);
CREATE INDEX IF NOT EXISTS idx_tgf_project ON team_generation_fact(project_id);
CREATE INDEX IF NOT EXISTS idx_tgf_job     ON team_generation_fact(job_id);
CREATE INDEX IF NOT EXISTS idx_tgf_created ON team_generation_fact(created_at);
"""


def init_manage_db() -> Path:
    """manage_hub.db 를 만들고 스키마를 적용한다(멱등). 시작 시 MANAGE_ENABLED 일 때만 호출."""
    MANAGE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(MANAGE_DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=WAL")  # 동시 읽기(집계 조회) 중 쓰기 허용
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()
    return MANAGE_DB_PATH


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    """매니징 DB 전용 커넥션(1회용). 정상 종료=commit, 예외=rollback. 콘텐츠 풀과 완전 별개."""
    conn = sqlite3.connect(MANAGE_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# upsert 시 갱신할 컬럼들. real_credits·credit_source 는 COALESCE(늦게 채워지는 값이 NULL 로 덮이지
# 않게) — 나머지는 최신 값으로 덮는다(프로젝트·폴더·상태 이동 반영).
_UPSERT_SET = (
    "creator_uid=excluded.creator_uid, creator_name=excluded.creator_name, "
    "job_id=excluded.job_id, project_id=excluded.project_id, project_name=excluded.project_name, "
    "folder_path=excluded.folder_path, model=excluded.model, output_type=excluded.output_type, "
    "status=excluded.status, "
    "real_credits=COALESCE(excluded.real_credits, team_generation_fact.real_credits), "
    "est_credits=COALESCE(excluded.est_credits, team_generation_fact.est_credits), "
    "credit_source=COALESCE(excluded.credit_source, team_generation_fact.credit_source), "
    "elapsed_seconds=excluded.elapsed_seconds, created_at=excluded.created_at, "
    "started_at=excluded.started_at, completed_at=excluded.completed_at, sort_ts=excluded.sort_ts, "
    "is_final=excluded.is_final, is_shared=excluded.is_shared, is_deleted=excluded.is_deleted, "
    "deleted_at=excluded.deleted_at, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at"
)

_FACT_COLS = (
    "id", "account_email", "creator_uid", "creator_name", "local_gen_id", "job_id",
    "project_id", "project_name", "folder_path", "model", "output_type", "status",
    "real_credits", "est_credits", "credit_source", "elapsed_seconds",
    "created_at", "started_at", "completed_at", "sort_ts",
    "is_final", "is_shared", "is_deleted", "deleted_at", "last_seen_at", "updated_at",
)


def upsert_facts(
    account_email: str, my_uid: Optional[str], items: list[dict[str, Any]]
) -> int:
    """작업자 메타 팩트를 팀 저장소에 멱등 upsert. 반환=반영된 행수.

    ★작성자 검증(코덱스): payload 의 작성자를 그대로 믿지 않는다. 인증 세션의 my_uid 와 다른
    creator_uid 를 가진 항목(= 내 로컬에 있는 남의 공유본)은 팀 팩트로 올리지 않는다. account_email 도
    payload 가 아니라 인증 세션 값으로 강제한다. 멱등 키는 (account_email, local_gen_id)."""
    now = _utcnow()
    n = 0
    placeholders = ",".join("?" for _ in _FACT_COLS)
    sql = (
        f"INSERT INTO team_generation_fact({','.join(_FACT_COLS)}) VALUES({placeholders}) "
        f"ON CONFLICT(account_email, local_gen_id) DO UPDATE SET {_UPSERT_SET}"
    )
    with get_connection() as conn:
        for it in items:
            gid = (it.get("local_gen_id") or "").strip()
            if not gid:
                continue
            cu = it.get("creator_uid") or my_uid
            if my_uid and cu and cu != my_uid:
                continue  # 남의 것 — 팀 팩트에 올리지 않음(누출·오귀속 방지)
            conn.execute(
                sql,
                (
                    uuid.uuid4().hex,       # id (신규행에만 쓰임, 충돌 시 기존 id 유지)
                    account_email,          # ★세션값 강제
                    cu,
                    it.get("creator_name"),
                    gid,
                    it.get("job_id"),
                    it.get("project_id"),
                    it.get("project_name"),
                    it.get("folder_path"),
                    it.get("model"),
                    it.get("output_type"),
                    it.get("status"),
                    it.get("real_credits"),
                    it.get("est_credits"),
                    it.get("credit_source"),
                    it.get("elapsed_seconds"),
                    it.get("created_at"),
                    it.get("started_at"),
                    it.get("completed_at"),
                    it.get("sort_ts"),
                    1 if it.get("is_final") else 0,
                    1 if it.get("is_shared") else 0,
                    1 if it.get("is_deleted") else 0,
                    it.get("deleted_at"),
                    now,                    # last_seen_at
                    now,                    # updated_at
                ),
            )
            n += 1
    return n
