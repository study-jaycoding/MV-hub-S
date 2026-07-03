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
    sort_ts         REAL,                    -- 정렬용 에포크(숫자) — TEXT 면 affinity 로 문자화되어 정렬 깨짐
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


def _fact_values(account_email: str, cu: Optional[str], gid: str, it: dict, now: str) -> tuple:
    """_FACT_COLS 순서에 맞춘 INSERT 값 튜플. 일반 upsert·tombstone 신규행이 공용."""
    return (
        uuid.uuid4().hex, account_email, cu, it.get("creator_name"), gid, it.get("job_id"),
        it.get("project_id"), it.get("project_name"), it.get("folder_path"), it.get("model"),
        it.get("output_type"), it.get("status"), it.get("real_credits"), it.get("est_credits"),
        it.get("credit_source"), it.get("elapsed_seconds"), it.get("created_at"),
        it.get("started_at"), it.get("completed_at"), it.get("sort_ts"),
        1 if it.get("is_final") else 0, 1 if it.get("is_shared") else 0,
        1 if it.get("is_deleted") else 0, it.get("deleted_at"), now, now,
    )


def upsert_facts(
    account_email: str, my_uid: Optional[str], items: list[dict[str, Any]]
) -> tuple[int, list[str]]:
    """작업자 메타 팩트를 팀 저장소에 멱등 upsert. 반환=(반영된 행수, 스킵된 local_gen_id 목록).

    ★작성자 검증(코덱스): payload 의 작성자를 그대로 믿지 않는다. 인증 세션의 my_uid 와 다른
    creator_uid 를 가진 항목(= 내 로컬에 있는 남의 공유본)은 팀 팩트로 올리지 않는다. account_email 도
    payload 가 아니라 인증 세션 값으로 강제한다. 멱등 키는 (account_email, local_gen_id).

    ★미링크 계정 방어(코덱스): my_uid 가 없으면(서버 계정이 아직 힉스필드 uid 에 연결 안 됨) 팀 집계로
    받지 않는다(0 반환) — 클라이언트는 실패로 보고 재시도해 링크 후 올린다. 미링크 상태에서 payload
    creator_uid 를 그대로 믿는 구멍을 막는다.

    ★스킵 목록 반환: 어떤 항목이 반영 안 됐는지(미링크 전체·남의 것)를 돌려줘, 클라 드레이너가
    '실제로 스킵된 것만' 재시도로 남기고 나머지는 정리하게 한다(성공분까지 재전송하는 낭비 제거)."""
    if not my_uid:
        # 미링크 → 전부 미반영. 클라가 재시도(링크 후)하도록 스킵 목록에 다 담는다.
        skipped_all = [g for it in items if (g := (it.get("local_gen_id") or "").strip())]
        return 0, skipped_all
    now = _utcnow()
    n = 0
    skipped: list[str] = []
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
            if cu != my_uid:
                skipped.append(gid)
                continue  # 남의 것 — 팀 팩트에 올리지 않음(누출·오귀속 방지)
            # job_id 중복 정리(코덱스): 같은 잡이 다른 local_gen_id 로 재적재(계정 DB 이관·재생성)되면
            # 이중 집계된다. 같은 계정+job_id 의 다른 행을 지워 최신 local_gen_id 로 수렴시킨다. tombstone 도 동일.
            jid = it.get("job_id")
            if jid:
                conn.execute(
                    "DELETE FROM team_generation_fact WHERE account_email=? AND job_id=? "
                    "AND local_gen_id<>?",
                    (account_email, jid, gid),
                )
            # tombstone(삭제 통보, T5): 기존 팩트가 있으면 is_deleted 만 세팅하고 차원(프로젝트·모델·크레딧)은
            # 보존한다(전체 덮어쓰기 금지). 없으면 스냅샷 기반으로 신규행 삽입 → 미전송 삭제분도 비용 집계.
            if it.get("is_deleted"):
                cur = conn.execute(
                    "UPDATE team_generation_fact SET is_deleted=1, deleted_at=?, "
                    "last_seen_at=?, updated_at=? WHERE account_email=? AND local_gen_id=?",
                    (now, now, now, account_email, gid),
                )
                if cur.rowcount == 0:  # 팩트 없음 → 스냅샷으로 전체행 삽입(is_deleted=1 포함)
                    conn.execute(sql, _fact_values(account_email, cu, gid, it, now))
                n += 1
                continue
            conn.execute(sql, _fact_values(account_email, cu, gid, it, now))
            n += 1
    return n, skipped


# ── 콘텐츠 작업탭 보조 — 생성 소요시간(elapsed) 폴백 조회 ─────────────────────────
# 콘텐츠 push(/api/ingest ← CLI generate list)는 elapsed 를 안 실어서 콘텐츠 DB 의
# generation_metrics.elapsed_seconds 가 NULL 이다. 반면 텔레메트리 push 는 로컬에서 잰
# elapsed 를 team_generation_fact 에 보존한다. 그래서 작업탭 list_tasks 가 값이 없을 때
# 여기서 job_id 로 끌어와 채운다(읽기 전용, 앱단 병합 — 크로스-DB 조인 아님).
def elapsed_by_job_ids(job_ids: list[str]) -> dict[str, float]:
    """job_id → 생성 소요시간(초). manage_hub.db 가 없거나(구버전·MANAGE off) 조회 실패해도
    작업탭이 깨지지 않게 예외를 삼키고 {} 를 돌린다. 같은 job_id 가 여러 계정 행에 있을 수
    있어(계정별 유니크) MAX 로 결정적으로 합친다. elapsed 없는 행은 제외."""
    ids = sorted({j for j in job_ids if j})  # 중복·빈값 제거
    if not ids:
        return {}
    try:
        with get_connection() as conn:
            ph = ",".join("?" * len(ids))
            rows = conn.execute(
                f"SELECT job_id, MAX(elapsed_seconds) AS e FROM team_generation_fact "
                f"WHERE job_id IN ({ph}) AND elapsed_seconds IS NOT NULL "
                f"GROUP BY job_id",
                ids,
            ).fetchall()
        return {r["job_id"]: r["e"] for r in rows if r["e"] is not None}
    except sqlite3.DatabaseError:
        return {}


# ── 팀 집계 조회(manage-T4) — manage_hub.db 를 읽어 매니저 대시보드에 낸다 ──────────
# 크레딧은 실제(real_credits) 우선, 없으면 견적(est_credits) 폴백. 소요시간은 초 → 시간 환산은 프론트.
# tombstone(is_deleted=1)도 '쓴 크레딧·들인 노력'이라 집계에 포함한다(삭제돼도 비용은 발생).
_CREDIT = "COALESCE(real_credits, est_credits, 0)"


def _agg_where(
    date_from: Optional[str], date_to: Optional[str],
    project_id: Optional[str], creator_uid: Optional[str],
) -> tuple[str, list[Any]]:
    where: list[str] = []
    args: list[Any] = []
    # date() 로 감싸 날짜만 비교 — created_at 은 'YYYY-MM-DDTHH:MM:SSZ'(시각 포함)이라 문자열 비교하면
    # 종료일 당일이 통째로 빠진다('...T12:00Z' <= '2026-07-03' = false). date_from/to 는 YYYY-MM-DD.
    if date_from:
        where.append("date(created_at) >= ?")
        args.append(date_from)
    if date_to:
        where.append("date(created_at) <= ?")
        args.append(date_to)
    if project_id:
        where.append("project_id = ?")
        args.append(project_id)
    if creator_uid:
        where.append("creator_uid = ?")
        args.append(creator_uid)
    return (("WHERE " + " AND ".join(where)) if where else ""), args


def team_overview(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
) -> dict[str, Any]:
    """대시보드 한 방 — 전체 합계 + 작업자별 + 프로젝트별 + 작업자×프로젝트 매트릭스."""
    where, args = _agg_where(date_from, date_to, project_id, creator_uid)
    with get_connection() as conn:
        totals = dict(conn.execute(
            f"SELECT COUNT(*) AS count, COALESCE(SUM({_CREDIT}),0) AS credits, "
            f"COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds, "
            f"COALESCE(SUM(CASE WHEN real_credits IS NULL THEN 1 ELSE 0 END),0) AS estimated_count, "
            f"COALESCE(SUM(is_final),0) AS final_count, "
            f"COUNT(DISTINCT creator_uid) AS workers, COUNT(DISTINCT project_id) AS projects "
            f"FROM team_generation_fact {where}", args,
        ).fetchone())
        by_worker = [dict(r) for r in conn.execute(
            f"SELECT creator_uid, MAX(creator_name) AS creator_name, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds, "
            f"COALESCE(SUM(is_final),0) AS final_count "
            f"FROM team_generation_fact {where} GROUP BY creator_uid ORDER BY credits DESC", args,
        ).fetchall()]
        by_project = [dict(r) for r in conn.execute(
            f"SELECT project_id, MAX(project_name) AS project_name, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds, "
            f"COALESCE(SUM(is_final),0) AS final_count "
            f"FROM team_generation_fact {where} GROUP BY project_id ORDER BY credits DESC", args,
        ).fetchall()]
        matrix = [dict(r) for r in conn.execute(
            f"SELECT creator_uid, MAX(creator_name) AS creator_name, project_id, "
            f"MAX(project_name) AS project_name, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits "
            f"FROM team_generation_fact {where} GROUP BY creator_uid, project_id", args,
        ).fetchall()]
    return {"totals": totals, "by_worker": by_worker, "by_project": by_project, "matrix": matrix}


def team_timeseries(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
    bucket: str = "day",
) -> list[dict[str, Any]]:
    """기간별 추이 — 일(day)/주(week)/월(month) 버킷별 크레딧·건수. created_at(생성일) 기준."""
    fmt = {"week": "%Y-W%W", "month": "%Y-%m"}.get(bucket, "%Y-%m-%d")
    where, args = _agg_where(date_from, date_to, project_id, creator_uid)
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT strftime('{fmt}', created_at) AS bucket, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds "
            f"FROM team_generation_fact {where} "
            f"{'AND' if where else 'WHERE'} created_at IS NOT NULL "
            f"GROUP BY bucket ORDER BY bucket ASC", args,
        ).fetchall()
    return [dict(r) for r in rows]
