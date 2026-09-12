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

import math
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
    workspace_scope TEXT NOT NULL DEFAULT 'unknown', -- team|personal|unknown
    workspace_id    TEXT,                    -- team일 때 Higgsfield workspace UUID
    workspace_name  TEXT,                    -- 현재 귀속 이름(생성 시 기본값, 수동 변경 가능)
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


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """기존 manage_hub.db에 워크스페이스 차원과 조회 인덱스를 멱등 추가한다."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(team_generation_fact)")}
    if "workspace_scope" not in columns:
        conn.execute(
            "ALTER TABLE team_generation_fact ADD COLUMN workspace_scope TEXT "
            "NOT NULL DEFAULT 'unknown'"
        )
    if "workspace_id" not in columns:
        conn.execute("ALTER TABLE team_generation_fact ADD COLUMN workspace_id TEXT")
    if "workspace_name" not in columns:
        conn.execute("ALTER TABLE team_generation_fact ADD COLUMN workspace_name TEXT")
    conn.execute(
        "UPDATE team_generation_fact "
        "SET workspace_scope='unknown', workspace_id=NULL, workspace_name=NULL "
        "WHERE workspace_scope IS NULL OR workspace_scope NOT IN ('team','personal','unknown') "
        "OR (workspace_scope='team' AND (workspace_id IS NULL OR TRIM(workspace_id)=''))"
    )
    conn.execute(
        "UPDATE team_generation_fact SET workspace_id=NULL "
        "WHERE workspace_scope IN ('personal','unknown')"
    )
    conn.execute(
        "UPDATE team_generation_fact SET workspace_name=NULL WHERE workspace_scope='unknown'"
    )
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_tgf_workspace_created "
        "ON team_generation_fact(workspace_scope, workspace_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_tgf_workspace_creator_created "
        "ON team_generation_fact(workspace_scope, workspace_id, creator_uid, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_tgf_workspace_project_created "
        "ON team_generation_fact(workspace_scope, workspace_id, project_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_tgf_workspace_model_created "
        "ON team_generation_fact(workspace_scope, workspace_id, model, created_at)",
        # 전체 공간 모델 필터 — 기존 인덱스는 (workspace_scope, workspace_id, model, ...) 라
        # 앞 두 조건이 없는 조회에는 맞지 않아 전량 SCAN 이었다(2026-09-12 EXPLAIN 확인).
        # 코덱스 실측: 같은 집계가 1.879ms → 0.010ms. 쓰기 비용은 1,000건 upsert 에 +2.4~3.0ms,
        # 인덱스 약 928KiB — 절대량이 작아 채택.
        "CREATE INDEX IF NOT EXISTS idx_tgf_model_created "
        "ON team_generation_fact(model, created_at)",
        # 날짜 범위 조회 — `date(created_at,'localtime')` 이 열을 감싸 인덱스를 못 쓰던 것을
        # `julianday(created_at)` 표현식 인덱스로 바꿨다(2026-09-12). 실측 8.62 → 0.04ms.
        # 쓰기 비용: 1,000건 upsert 에 +1.4~2.0ms, 인덱스 약 356KiB(코덱스 실측).
        "CREATE INDEX IF NOT EXISTS idx_tgf_julian "
        "ON team_generation_fact(julianday(created_at))",
        # 관리 요약(프로젝트 대시보드) 폴더 집계 — project_id+folder_path GROUP BY(2026-09-09)
        "CREATE INDEX IF NOT EXISTS idx_tgf_project_folder "
        "ON team_generation_fact(project_id, folder_path)",
    ):
        conn.execute(statement)


def init_manage_db() -> Path:
    """manage_hub.db 를 만들고 스키마를 적용한다(멱등). 시작 시 MANAGE_ENABLED 일 때만 호출."""
    MANAGE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(MANAGE_DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=WAL")  # 동시 읽기(집계 조회) 중 쓰기 허용
        conn.executescript(_SCHEMA)
        _migrate_schema(conn)
        conn.commit()
    finally:
        conn.close()
    return MANAGE_DB_PATH


def backfill_workspace_names(workspaces: list[dict[str, Any]]) -> int:
    """콘텐츠 등록부에서 받은 정확한 ID→이름으로 빈 팀 팩트 이름만 보강한다.

    관리 DB는 콘텐츠 DB와 물리적으로 격리되어 있으므로 조인하지 않고, 시작 코드가 검증된
    등록부 스냅샷을 명시적으로 넘긴다. 이미 이름이 있거나 등록부에 없는 ID는 보존한다.
    """
    canonical = {
        str(item.get("id") or "").strip(): str(item.get("name") or "").strip()
        for item in workspaces
        if str(item.get("id") or "").strip()
        and str(item.get("name") or "").strip()
    }
    updated = 0
    if not canonical:
        return updated
    with get_connection() as conn:
        for workspace_id, workspace_name in canonical.items():
            cursor = conn.execute(
                "UPDATE team_generation_fact SET workspace_name=? "
                "WHERE workspace_scope='team' AND workspace_id=? "
                "AND TRIM(COALESCE(workspace_name,''))=''",
                (workspace_name, workspace_id),
            )
            updated += max(cursor.rowcount, 0)
    return updated


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
    "workspace_scope=CASE WHEN excluded.workspace_scope='unknown' "
    "THEN team_generation_fact.workspace_scope ELSE excluded.workspace_scope END, "
    "workspace_id=CASE WHEN excluded.workspace_scope='unknown' "
    "THEN team_generation_fact.workspace_id ELSE excluded.workspace_id END, "
    "workspace_name=CASE WHEN excluded.workspace_scope='unknown' "
    "THEN team_generation_fact.workspace_name ELSE excluded.workspace_name END, "
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
    "workspace_scope", "workspace_id", "workspace_name",
    "project_id", "project_name", "folder_path", "model", "output_type", "status",
    "real_credits", "est_credits", "credit_source", "elapsed_seconds",
    "created_at", "started_at", "completed_at", "sort_ts",
    "is_final", "is_shared", "is_deleted", "deleted_at", "last_seen_at", "updated_at",
)


def _fact_values(account_email: str, cu: Optional[str], gid: str, it: dict, now: str) -> tuple:
    """_FACT_COLS 순서에 맞춘 INSERT 값 튜플. 일반 upsert·tombstone 신규행이 공용."""
    from .workspace_context import workspace_columns

    workspace_scope, workspace_id, workspace_name = workspace_columns(it)
    return (
        uuid.uuid4().hex, account_email, cu, it.get("creator_name"), gid, it.get("job_id"),
        workspace_scope, workspace_id, workspace_name,
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
        conn = sqlite3.connect(
            f"{MANAGE_DB_PATH.resolve().as_uri()}?mode=ro", uri=True
        )
        conn.row_factory = sqlite3.Row
        try:
            ph = ",".join("?" * len(ids))
            rows = conn.execute(
                f"SELECT job_id, MAX(elapsed_seconds) AS e FROM team_generation_fact "
                f"WHERE job_id IN ({ph}) AND elapsed_seconds IS NOT NULL "
                f"GROUP BY job_id",
                ids,
            ).fetchall()
        finally:
            conn.close()
        return {r["job_id"]: r["e"] for r in rows if r["e"] is not None}
    except sqlite3.DatabaseError:
        return {}


# ── 팀 집계 조회(manage-T4) — manage_hub.db 를 읽어 매니저 대시보드에 낸다 ──────────
# 크레딧은 실제(real_credits) 우선, 없으면 견적(est_credits) 폴백. 소요시간은 초 → 시간 환산은 프론트.
# tombstone(is_deleted=1)도 '쓴 크레딧·들인 노력'이라 집계에 포함한다(삭제돼도 비용은 발생).
_CREDIT = "COALESCE(real_credits, est_credits, 0)"


Viewer = tuple[str, str]  # (creator_uid, account_email) — 일반 멤버의 '내 기록' 판정 쌍


def _viewer_clause(viewer: Optional[Viewer], where: list[str], args: list[Any]) -> None:
    """일반 멤버 범위 — 팩트의 creator_uid **와** account_email 이 세션 계정과 둘 다 맞는 행만.
    (코덱스 P1) uid 하나만 보면 미링크 계정이 첫 ingest 때 남의 uid 로 연결하는 경로로 남의 기록을 볼 수
    있다 — 팩트 account_email 은 push 때 세션 이메일로 강제되므로 둘을 함께 대조하면 막힌다.
    권한용 값은 특수 필터('__none__' 등) 해석 없이 문자열 그대로 비교한다."""
    if viewer is None:
        return
    uid, email = viewer
    where.append("creator_uid=? AND account_email=?")
    args.extend([uid, email])


def _agg_where(
    date_from: Optional[str], date_to: Optional[str],
    project_id: Optional[str], creator_uid: Optional[str],
    workspace_id: Optional[str] = None, model: Optional[str] = None,
    viewer: Optional[Viewer] = None,
) -> tuple[str, list[Any]]:
    where: list[str] = []
    args: list[Any] = []
    _viewer_clause(viewer, where, args)
    # date() 로 감싸 날짜만 비교 — created_at 은 'YYYY-MM-DDTHH:MM:SSZ'(시각 포함)이라 문자열 비교하면
    # 종료일 당일이 통째로 빠진다('...T12:00Z' <= '2026-07-03' = false). date_from/to 는 YYYY-MM-DD.
    # 'localtime' 은 팀 표준시(KST) 통일 — 프론트가 보내는 날짜도 브라우저 로컬(KST) 기준이고,
    # 다른 집계(예: task 시수)와 예산 계산도 localtime 이라 여기만 UTC 면 일 경계가 9시간 어긋난다.
    # 전제: 서버 OS 시간대 = KST (SERVER.md 명시).
    # ★날짜 **범위**는 열을 함수로 감싸지 않는다(2026-09-12). `date(created_at,'localtime')` 은
    #  인덱스를 무력화해 전량 SCAN 이었다 — 실측 8.62ms(SCAN) vs 0.04ms(SEARCH), **244배**.
    #  대신 **인자 쪽**을 변환해 `julianday(created_at)` 표현식 인덱스에 닿게 한다.
    #  경계는 '시작일 로컬 자정 이상 · 종료일 다음날 로컬 자정 미만'. 시간대 의미는 그대로다
    #  (177일 전량 + 무작위 범위 40건에서 기존 조건과 결과 완전 일치).
    if date_from:
        where.append("julianday(created_at) >= julianday(?, 'utc')")
        args.append(date_from)
    if date_to:
        where.append("julianday(created_at) < julianday(?, '+1 day', 'utc')")
        args.append(date_to)
    if project_id == "__none__":
        where.append("project_id IS NULL")
    elif project_id:
        where.append("project_id = ?")
        args.append(project_id)
    if creator_uid == "__none__":
        where.append("creator_uid IS NULL")
    elif creator_uid:
        where.append("creator_uid = ?")
        args.append(creator_uid)
    if workspace_id:
        where.append("workspace_scope = 'team' AND workspace_id = ?")
        args.append(workspace_id)
    if model:
        where.append("model = ?")
        args.append(model)
    return (("WHERE " + " AND ".join(where)) if where else ""), args


def _max_name(current: Optional[str], value: Optional[str]) -> Optional[str]:
    """SQL `MAX(name)` 과 같게 — NULL 은 빼고, 전부 NULL 이면 NULL 을 남긴다."""
    if value is None:
        return current
    return value if current is None or value > current else current


class _Bucket:
    """접기용 누적기. 실수 합계는 **마지막에 `math.fsum` 으로 한 번** 더한다.

    ★왜 한 번에 더하나(실측): SQLite 3.50.4 의 `SUM` 은 **보정합산**이라
     `SUM(0.1,0.2,0.3)` 이 정확히 `0.6` 이다. 부분합을 **왼쪽부터 누적**하면
     `0.6000000000000001` 이 되어 그 정밀도를 잃는다. `fsum` 은 정확히 반올림한다.
     (참고: CPython 3.12+ 의 `sum()` 도 실수엔 보정합산을 쓴다 — 이 런타임은 3.14.3 이라
      `sum` 으로도 같은 값이 나온다. `fsum` 은 그 보장을 런타임에 기대지 않으려는 것이다.)
    ★한계: **부분합 안에서 이미 잃은 값은 복구하지 못한다**(코덱스 지적).
     크기가 1e16 처럼 극단이면 접기와 직접 합이 갈린다(실측 차 0.4).
     이 앱의 크레딧은 실측 범위가 0~330 이고, 실데이터 22,392행에서 잰 차이는 **0.0** 이다.
    """

    __slots__ = ("count", "_credits", "_elapsed", "final_count", "estimated_count",
                 "creator_name", "project_name")

    def __init__(self) -> None:
        self.count = 0
        self._credits: list[float] = []
        self._elapsed: list[float] = []
        self.final_count = 0
        self.estimated_count = 0
        self.creator_name: Optional[str] = None
        self.project_name: Optional[str] = None

    def add(self, row: sqlite3.Row) -> None:
        self.count += row["count"]
        self._credits.append(row["credits"])
        self._elapsed.append(row["elapsed_seconds"])
        self.final_count += row["final_count"]
        self.estimated_count += row["estimated_count"]
        self.creator_name = _max_name(self.creator_name, row["creator_name"])
        self.project_name = _max_name(self.project_name, row["project_name"])

    @property
    def credits(self) -> float:
        return math.fsum(self._credits)

    @property
    def elapsed_seconds(self) -> float:
        return math.fsum(self._elapsed)


def _fold(groups: list[sqlite3.Row], key) -> dict[Any, _Bucket]:
    out: dict[Any, _Bucket] = {}
    for row in groups:
        bucket_key = key(row)
        bucket = out.get(bucket_key)
        if bucket is None:
            bucket = out[bucket_key] = _Bucket()
        bucket.add(row)
    return out


def _nulls_first(value: Optional[str]) -> tuple[bool, str]:
    """NULL 을 앞에 두는 비교 키 — 파이썬은 None 과 str 을 직접 비교하지 못한다."""
    return (value is not None, value if value is not None else "")


# ★합성 키 하나로 훑고 파이썬에서 접는다(2026-09-12, D-3).
#  종전에는 같은 WHERE 로 **10번** 훑었다 — 실측 22,392행에서 중앙값 120.9ms.
#  합성 키로 한 번 훑으면 37.4ms(3.2배·83.6ms 절감)이고, 이 데이터의 고유 조합은 418개(1.9%)다.
#  걸러낸 부분집합을 임시표에 넣고 같은 10집계를 돌리는 안은 95.0ms(1.3배)라 기각했다.
#
#  ★원시 키로 묶고 **정규화 값은 SQL 식으로 함께 읽는다.** 파이썬에서 정규화하면 의미가 바뀐다:
#   - `LOWER()` — SQLite 는 `Ae`(대문자 움라우트)와 소문자를 **다르게** 보는데 파이썬
#     `.lower()` 는 같게 만든다(코덱스). 골든에서 실제로 별도 행으로 확인했다.
#   - 모델 표시명은 유일하지 않다 — 원시값 NULL, 빈 문자열, 그리고 문자열 '알 수 없음' 이
#     **같은 표시명**으로 나오는 서로 다른 세 그룹이다. 표시명을 접기 키로 쓰면 행이 사라진다.
#   - 폴더 경로도 집계 **전에** 다듬으면 안 된다 — 역슬래시 경로와 슬래시 경로는 지금 별도 행이고,
#     구분자·공백 정리는 집계 **뒤** 파생값(episode/scene)에만 적용된다.
_FOLD_COLUMNS = (
    "creator_uid, project_id, model, output_type, "
    "MAX(creator_name) AS creator_name, MAX(project_name) AS project_name, "
    "COALESCE(NULLIF(model,''),'알 수 없음') AS model_label, "
    "COALESCE(NULLIF(LOWER(output_type),''),'other') AS output_label, "
    "COUNT(*) AS count, COALESCE(SUM({credit}),0) AS credits, "
    "COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds, "
    "COALESCE(SUM(is_final),0) AS final_count, "
    "COALESCE(SUM(CASE WHEN real_credits IS NULL THEN 1 ELSE 0 END),0) AS estimated_count"
).format(credit=_CREDIT)
_FOLD_GROUP_BY = "GROUP BY creator_uid, project_id, model, output_type"
# ★폴더는 합성 키에 **넣지 않는다.** 폴더만 카디널리티가 열려 있어서(에피소드/씬이 아니라
#  생성물마다 다른 경로가 들어오면) 합성 그룹이 행 수까지 불어난다. 실측: 폴더를 넣고 22,392행이
#  전부 다른 폴더면 **247ms -> 421ms 로 오히려 느려졌다**(파이썬 객체·정렬 비용). 폴더를 빼면
#  나머지 축(작업자·프로젝트·모델·출력)은 실데이터에서 418조합, 최악에도 그 곱으로 막힌다.
#  폴더 집계는 **원래 SQL 그대로** 따로 한 번 더 훑는다 — 정렬·NULL·구분자 의미가 그대로 보존된다.
_FOLDER_SQL = (
    "SELECT project_id, MAX(project_name) AS project_name, "
    "COALESCE(NULLIF(folder_path,''),'(폴더 미지정)') AS folder_path, "
    "COUNT(*) AS count, COALESCE(SUM(is_final),0) AS final_count, "
    "COALESCE(SUM({credit}),0) AS credits "
    "FROM team_generation_fact {{where}} "
    "GROUP BY project_id, COALESCE(NULLIF(folder_path,''),'(폴더 미지정)') "
    "ORDER BY project_name, folder_path"
).format(credit=_CREDIT)


def team_overview(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None, model: Optional[str] = None,
    viewer: Optional[Viewer] = None,
) -> dict[str, Any]:
    """워크스페이스 사용량 대시보드 한 방 집계.

    합계·작업자·프로젝트·모델·폴더 Yield를 같은 필터 스냅샷으로 계산해 화면 값이 서로 어긋나지
    않게 한다. 모델 상세 배열은 count/credits 값에 마우스를 올렸을 때 쓰인다.
    viewer=(uid, email) 이면 일반 멤버의 '내 기록' 범위 — **걸러내기를 접기 전에** 하므로
    matrix·worker_models·폴더 행에도 남의 기록이 섞이지 않는다(`_viewer_clause`).

    ★정렬 계약(2026-09-12): 기존 우선순위 뒤에 **원시 식별자**를 붙여 결정적 순서를 만든다.
     종전 SQLite 의 동점 순서는 보장된 적이 없다 — 이건 재현 계약이 아니라 **새 계약**이다.
     보조 키는 크레딧이 **정확히 같을 때만** 작용하므로, 접기로 미세한 차이가 생기면 기존
     동점이 깨질 수 있다. 그 변화도 허용한다.
    """
    where, args = _agg_where(
        date_from, date_to, project_id, creator_uid, workspace_id, model, viewer
    )
    with get_connection() as conn:
        conn.execute("BEGIN")  # 한 번만 훑지만 읽기 시점을 WAL 스냅샷에 고정한다.
        groups = conn.execute(
            f"SELECT {_FOLD_COLUMNS} FROM team_generation_fact {where} {_FOLD_GROUP_BY}", args,
        ).fetchall()
        folders = [dict(r) for r in conn.execute(_FOLDER_SQL.format(where=where), args).fetchall()]

    by_worker_map = _fold(groups, lambda r: r["creator_uid"])
    by_project_map = _fold(groups, lambda r: r["project_id"])
    matrix_map = _fold(groups, lambda r: (r["creator_uid"], r["project_id"]))
    by_model_map = _fold(groups, lambda r: r["model"])
    by_output_map = _fold(groups, lambda r: r["output_label"])
    output_model_map = _fold(groups, lambda r: (r["output_label"], r["model"]))
    worker_model_map = _fold(groups, lambda r: (r["creator_uid"], r["model"]))
    project_model_map = _fold(groups, lambda r: (r["project_id"], r["model"]))
    # 원시값 -> 표시명. 표시명은 유일하지 않으므로 **원시값으로 접은 뒤** 라벨을 붙인다.
    model_label = {r["model"]: r["model_label"] for r in groups}

    total = _Bucket()
    for row in groups:
        total.add(row)
    # `COUNT(DISTINCT x)` 는 NULL 을 세지 않는다. 빈 문자열은 센다.
    totals = {
        "count": total.count,
        "credits": total.credits,
        "elapsed_seconds": total.elapsed_seconds,
        "estimated_count": total.estimated_count,
        "final_count": total.final_count,
        "workers": sum(1 for k in by_worker_map if k is not None),
        "projects": sum(1 for k in by_project_map if k is not None),
        "models": sum(1 for k in by_model_map if k is not None),
        "features": len({r["output_type"] for r in groups if r["output_type"] is not None}),
    }

    by_worker = [
        {"creator_uid": uid, "creator_name": b.creator_name, "count": b.count,
         "credits": b.credits, "elapsed_seconds": b.elapsed_seconds, "final_count": b.final_count}
        for uid, b in sorted(
            by_worker_map.items(), key=lambda kv: (-kv[1].credits, _nulls_first(kv[0]))
        )
    ]
    by_project = [
        {"project_id": pid, "project_name": b.project_name, "count": b.count,
         "credits": b.credits, "elapsed_seconds": b.elapsed_seconds, "final_count": b.final_count}
        for pid, b in sorted(
            by_project_map.items(), key=lambda kv: (-kv[1].credits, _nulls_first(kv[0]))
        )
    ]
    matrix = [
        {"creator_uid": uid, "creator_name": b.creator_name, "project_id": pid,
         "project_name": b.project_name, "count": b.count, "credits": b.credits}
        for (uid, pid), b in sorted(
            matrix_map.items(), key=lambda kv: (_nulls_first(kv[0][0]), _nulls_first(kv[0][1]))
        )
    ]
    by_model = [
        {"model": model_label[key], "count": b.count, "credits": b.credits,
         "elapsed_seconds": b.elapsed_seconds, "final_count": b.final_count}
        for key, b in sorted(
            by_model_map.items(), key=lambda kv: (-kv[1].credits, _nulls_first(kv[0]))
        )
    ]
    by_output_type = [
        {"output_type": label, "count": b.count, "credits": b.credits}
        for label, b in sorted(by_output_map.items(), key=lambda kv: (-kv[1].credits, kv[0]))
    ]
    output_models = [
        {"output_type": label, "model": model_label[key], "count": b.count, "credits": b.credits}
        for (label, key), b in sorted(
            output_model_map.items(),
            key=lambda kv: (kv[0][0], -kv[1].credits, _nulls_first(kv[0][1])),
        )
    ]
    worker_models = [
        {"creator_uid": uid, "model": model_label[key], "count": b.count,
         "credits": b.credits, "final_count": b.final_count}
        for (uid, key), b in sorted(
            worker_model_map.items(),
            key=lambda kv: (_nulls_first(kv[0][0]), -kv[1].credits, _nulls_first(kv[0][1])),
        )
    ]
    project_models = [
        {"project_id": pid, "model": model_label[key], "count": b.count,
         "credits": b.credits, "final_count": b.final_count}
        for (pid, key), b in sorted(
            project_model_map.items(),
            key=lambda kv: (_nulls_first(kv[0][0]), -kv[1].credits, _nulls_first(kv[0][1])),
        )
    ]
    for row in folders:
        count = int(row.get("count") or 0)
        final_count = int(row.get("final_count") or 0)
        folder_path = str(row.get("folder_path") or "").strip().replace("\\", "/")
        levels = [level.strip() for level in folder_path.split("/") if level.strip()]
        if not folder_path or folder_path == "(폴더 미지정)":
            levels = []
        row["episode"] = levels[0] if levels else None
        row["scene"] = "/".join(levels[1:]) if len(levels) > 1 else None
        row["yield_percent"] = round((final_count / count) * 100, 1) if count else 0
        row["final_rate_tenths"] = round((final_count / count) * 10, 1) if count else 0
        row["attempts_per_final"] = round(count / final_count, 2) if final_count else None
    return {
        "totals": totals,
        "by_worker": by_worker,
        "by_project": by_project,
        "by_model": by_model,
        "by_output_type": by_output_type,
        "output_models": output_models,
        "worker_models": worker_models,
        "project_models": project_models,
        "folder_efficiency": folders,
        "matrix": matrix,
    }


def workspace_email_usage(workspace_id: str, day_from: Optional[str] = None) -> list[dict[str, Any]]:
    """워크스페이스의 (날짜 'YYYY-MM-DD' localtime, account_email) 별 크레딧 합·건수·미상 수 — 크레딧 풀·그룹 한도용.
    삭제분(tombstone) 포함(돈은 이미 나갔다), 크레딧 = COALESCE(실제, 견적, 0), 미상 = 둘 다 없음.
    day_from 이 있으면 그날 이후만(그룹 base_start 최소값). 워크스페이스 축(scope='team')이라 프로젝트
    폴더 미배정(미분류) 생성물도 들어간다 — 힉스필드 풀에서 빠진 돈은 전부. 일·주·월 어느 주기든 호출측이
    날짜로 묶는다(예산 주기 규칙과 같은 달력: 주=월요일 시작, 월=1일)."""
    where = "WHERE workspace_scope='team' AND workspace_id=?"
    args: list[Any] = [workspace_id]
    if day_from:  # 범위 필터는 인자 쪽을 변환한다(위 `_usage_scope_where` 주석 참조)
        where += " AND julianday(created_at) >= julianday(?, 'utc')"
        args.append(day_from)
    with get_connection() as conn:
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_generation_fact'"
        ).fetchone():
            return []
        rows = conn.execute(
            f"SELECT date(created_at, 'localtime') AS day, account_email AS email, "
            f"COUNT(*) AS count, COALESCE(SUM({_CREDIT}),0) AS credits, "
            f"SUM(CASE WHEN real_credits IS NULL AND est_credits IS NULL THEN 1 ELSE 0 END) AS unknown "
            f"FROM team_generation_fact {where} AND created_at IS NOT NULL "
            f"GROUP BY day, account_email",
            args,
        ).fetchall()
    return [dict(r) for r in rows]


def team_usage_export(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None, model: Optional[str] = None,
    viewer: Optional[Viewer] = None,
) -> list[dict[str, Any]]:
    """HF ``team-members-usage.csv``와 같은 날짜·멤버·모델 단위 사용량 행. viewer 는 team_overview 와 동일."""
    where, args = _agg_where(
        date_from, date_to, project_id, creator_uid, workspace_id, model, viewer
    )
    created_clause = f"{'AND' if where else 'WHERE'} created_at IS NOT NULL"
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT date(created_at, 'localtime') AS date, account_email AS user_email, "
            f"creator_uid AS user_id, COALESCE(NULLIF(model,''),'알 수 없음') AS model, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits_used, COUNT(*) AS jobs "
            f"FROM team_generation_fact {where} {created_clause} "
            f"GROUP BY date(created_at, 'localtime'), account_email, creator_uid, model "
            f"ORDER BY date ASC, account_email COLLATE NOCASE ASC, model COLLATE NOCASE ASC",
            args,
        ).fetchall()
    return [dict(row) for row in rows]


def team_usage_detail_export(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None, model: Optional[str] = None,
    viewer: Optional[Viewer] = None,
) -> list[dict[str, Any]]:
    """'프로젝트 상세 보고서' — 생성물 1건 = 1행(묶지 않음). 프로젝트·폴더(에피소드/컷)·작성자·모델·
    크레딧·생성 소요시간까지 팩트 열을 그대로 내보낸다(Jay 요청 2026-09-10, HF 호환 CSV 와 별도).
    필터·열람 범위(viewer)는 team_usage_export 와 같다. tombstone(is_deleted) 도 비용 이력이라 포함하고
    열로 표시만 한다. 시각은 팀 표준시(localtime)로 맞춘다 — created_at 이 UTC 라 그대로 내보내면 날짜가 밀린다.
    credit_basis 는 합산에 실제로 쓰인 값의 출처(real → est → 없음)라 대시보드 합계와 1:1 로 맞는다.
    생성일이 없는 행(날짜 없는 tombstone 등)도 team_overview 합계엔 들어가므로 **빼지 않고 빈 날짜로 맨 뒤에**
    싣는다(코덱스 P2 — 기간 필터가 있으면 date() 비교에서 자연히 빠진다). 정렬은 원본 문자열이 아니라
    julianday 로 — 'YYYY-MM-DD HH:MM:SS' 와 'YYYY-MM-DDTHH:MM:SSZ' 가 섞이면 문자열 순서가 시간 순서와 어긋난다."""
    where, args = _agg_where(
        date_from, date_to, project_id, creator_uid, workspace_id, model, viewer
    )
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT date(created_at, 'localtime') AS date, "
            f"datetime(created_at, 'localtime') AS created_local, "
            f"account_email AS user_email, creator_uid AS user_id, creator_name AS user_name, "
            f"workspace_name, project_id, project_name, folder_path, "
            f"COALESCE(NULLIF(model,''),'알 수 없음') AS model, output_type, status, "
            f"{_CREDIT} AS credits, "
            f"CASE WHEN real_credits IS NOT NULL THEN 'real' "
            f"WHEN est_credits IS NOT NULL THEN 'est' ELSE 'unknown' END AS credit_basis, "
            f"elapsed_seconds, "
            f"datetime(started_at, 'localtime') AS started_local, "
            f"datetime(completed_at, 'localtime') AS completed_local, "
            f"COALESCE(is_final,0) AS is_final, COALESCE(is_shared,0) AS is_shared, "
            f"COALESCE(is_deleted,0) AS is_deleted, job_id "
            f"FROM team_generation_fact {where} "
            f"ORDER BY (created_at IS NULL) ASC, julianday(created_at) ASC, "
            f"project_name COLLATE NOCASE ASC, folder_path COLLATE NOCASE ASC, "
            f"account_email COLLATE NOCASE ASC, id ASC",
            args,
        ).fetchall()
    return [dict(row) for row in rows]


def team_timeseries(
    date_from: Optional[str] = None, date_to: Optional[str] = None,
    project_id: Optional[str] = None, creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None, model: Optional[str] = None,
    bucket: str = "day", time_from: Optional[str] = None, time_to: Optional[str] = None,
    viewer: Optional[Viewer] = None,
) -> list[dict[str, Any]]:
    """기간별 추이 — 시간/일/주/월 버킷별 크레딧·건수. created_at(생성일) 기준. viewer 는 team_overview 와 동일."""
    fmt = {
        "minute": "%Y-%m-%dT%H:%M",
        "hour": "%Y-%m-%dT%H:00",
        "week": "%Y-W%W",
        "month": "%Y-%m",
    }.get(bucket, "%Y-%m-%d")
    where, args = _agg_where(
        date_from, date_to, project_id, creator_uid, workspace_id, model, viewer
    )
    # time_from/to 는 프론트가 보내는 브라우저 로컬(KST) 나이브 문자열 — created_at(UTC)을
    # localtime 으로 맞춰 비교해야 시간 차트가 9시간 밀리지 않는다.
    # 범위 필터는 인자 쪽을 변환한다(위 `_agg_where` 주석 참조). 여기는 날짜가 아니라 시각이다.
    # ★`datetime(?)` 으로 **초 단위로 정규화**하고 종료는 **다음 초 미만**으로 쓴다(2026-09-12).
    #  종전 `datetime(created_at,'localtime') <= datetime(?)` 은 양쪽 다 소수 초를 **버리고**
    #  비교했다. `julianday` 는 소수 초까지 비교하므로 그대로 `<=` 로 두면 `06:59:59.500Z` 같은
    #  행이 빠진다(코덱스가 team_timeseries 로 재현). 프론트는 종료를 `HH:59:59` 로 보낸다.
    if time_from:
        where += (
            " AND " if where else "WHERE "
        ) + "julianday(created_at) >= julianday(datetime(?), 'utc')"
        args.append(time_from)
    if time_to:
        where += (
            " AND " if where else "WHERE "
        ) + "julianday(created_at) < julianday(datetime(?), '+1 second', 'utc')"
        args.append(time_to)
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT strftime('{fmt}', created_at, 'localtime') AS bucket, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds "
            f"FROM team_generation_fact {where} "
            f"{'AND' if where else 'WHERE'} created_at IS NOT NULL "
            f"GROUP BY bucket ORDER BY bucket ASC", args,
        ).fetchall()
    return [dict(r) for r in rows]


# ── 관리 요약(프로젝트 대시보드) 팩트 집계 — 2026-09-09 ──────────────────────────────
# '관리 요약' 카드·에피소드·시퀀스 표는 원래 content DB(generation = 공유 서버에선 발행분만)를
# 집계했다. 공유 안 한 생성물의 크레딧·생성시간이 통째로 빠지고(뻘뻘뻘 e020: 16폴더 중 15폴더 0cr),
# 생성시간은 아예 없었다(공유 번들에 metrics 미탑재). Jay 결정: "출근부 장부(팩트)로 봐야 한다".
# 규칙은 team_overview 와 같다 — 크레딧=COALESCE(real, est, 0)·tombstone 포함(삭제돼도 비용은 발생)·
# 워크스페이스 필터=team+id(없으면 전체). 프로젝트 레지스트리·planning·공유(발행) 수·빈 시퀀스·
# 표시이름 폴백은 content 몫(repo/manage.py 가 조립).
# 중복 정책(코덱스 P3 명시): 같은 계정+job_id 는 upsert 가 최신 local_gen_id 로 수렴시키지만, **계정이
# 다르거나 job_id 가 없는 같은 잡은 두 번 센다** — team_overview 와 같은 한계(테스트로 고정).
_DONE_STATUSES = ("done", "completed", "success")
_PERIOD_MATCH = {  # 예산 주기 비교식 — content 경로에서 쓰던 식 그대로(전제: 서버 TZ=KST, SERVER.md)
    "day": "date(created_at,'localtime') = date('now','localtime')",
    "week": (
        "date(created_at,'localtime','weekday 0','-6 days') = "
        "date('now','localtime','weekday 0','-6 days')"
    ),
    "month": "strftime('%Y-%m', created_at,'localtime') = strftime('%Y-%m','now','localtime')",
}


def _period_conditions(month_anchor_day: int = 1) -> dict[str, str]:
    """예산 주기 비교식 — '매월'은 충전 기준일(1~28)로 달 경계를 옮긴다: 날짜를 (기준일−1)일 앞당기면
    기준일~다음 달 전날이 달력상 한 달로 겹쳐 strftime('%Y-%m') 비교로 판정된다(예: 15일 기준 → 9/15~10/14).
    기본 1일이면 종전 식 그대로."""
    shift = max(0, min(int(month_anchor_day or 1), 28) - 1)
    if not shift:
        return dict(_PERIOD_MATCH)
    out = dict(_PERIOD_MATCH)
    out["month"] = (
        f"strftime('%Y-%m', created_at,'localtime','-{shift} days') = "
        f"strftime('%Y-%m','now','localtime','-{shift} days')"
    )
    return out


def _usage_scope_where(
    workspace_id: Optional[str],
    project_ids: Optional[list[str]] = None,
    viewer: Optional[Viewer] = None,
) -> tuple[str, list[Any]]:
    """팩트 사용량 집계의 공통 WHERE — 워크스페이스(team+id, 없으면 전체)·프로젝트 IN·열람자 범위.

    viewer=(uid, email) 가 있으면(일반 멤버) **내 작업만** 센다 — 팀원 것은 공유 여부와 무관하게
    매니저(read_all, viewer=None)만 본다(Jay 결정 2026-09-10, 같은 날 아침의 '내 것+팀원 공유분'을 대체).
    본인 판정은 `_viewer_clause`(uid+email 동시 대조)."""
    where: list[str] = []
    args: list[Any] = []
    _viewer_clause(viewer, where, args)
    if workspace_id:
        where.append("workspace_scope='team' AND workspace_id=?")
        args.append(workspace_id)
    if project_ids is not None:
        if not project_ids:
            return "WHERE 0", []
        where.append(f"project_id IN ({','.join('?' for _ in project_ids)})")
        args.extend(project_ids)
    return (("WHERE " + " AND ".join(where)) if where else ""), args


def fact_usage(
    workspace_id: Optional[str],
    project_ids: Optional[list[str]] = None,
    budget_periods: Optional[dict[str, str]] = None,
    viewer: Optional[Viewer] = None,
    month_anchor_day: int = 1,
) -> dict[str, Any]:
    """관리 요약용 팩트 사용량을 **한 읽기 스냅샷**에서 전부 센다(코덱스 P2 — 조회 범위·스냅샷).
    month_anchor_day = 워크스페이스의 매월 충전 기준일(1~28) — 예산 '매월' 집계의 달 경계(`_period_conditions`).

    반환:
      stats         {pid: gen_count·done_count·final_count·shared_count(PC 보고 is_shared 합)·real_credits·credits·
                     metric_count·credit_real_count·credit_est_count·credit_unknown_count·elapsed_total} — 미분류(None) 포함
      models        {pid: [model·count·credits·final_count·elapsed_seconds]}
      budget_models {pid: [model·count·credits·final_count]} — budget_periods={pid: day|week|month} 인 프로젝트만
      folder_rows   [pid·folder_path·creator_uid·creator_name·model·count·final_count·credits·elapsed_seconds·
                     created_start·created_end] — repo/manage.py 가 빈 시퀀스·표시이름과 합쳐 folders[] 로 조립
      workers       [uid·name·gen_count·credits·elapsed_total]
    project_ids=None 이면 워크스페이스 전체(대시보드 — 이동 프로젝트·totals 판정에 전체가 필요), 목록이면
    그 프로젝트만(멤버용 project-summary — 허용된 것 밖은 SQL 에서부터 안 센다). viewer=(uid, email) 는
    일반 멤버의 열람 범위(내 작업만) — `_usage_scope_where` 참조.
    metric_count = 크레딧을 아는 행(실제 또는 견적). credit_unknown_count = 둘 다 없는 행 — 작업자 PC 의
    거래 대조가 실패한 구멍(예: 리버 e003 148건)을 화면에서 0원과 구분하기 위한 값.
    created_start/end 는 datetime(created_at,'localtime') 로 통일 — 팩트 created_at 은 'YYYY-MM-DD HH:MM:SS'
    와 'YYYY-MM-DDTHH:MM:SSZ' 가 섞여 문자열 MIN/MAX 가 같은 날 안에서 뒤집힌다(코덱스 P2). 둘 다 UTC 전제,
    표시는 팀 표준시(KST=서버 TZ) 날짜.
    """
    where, args = _usage_scope_where(workspace_id, project_ids, viewer)
    periods = budget_periods or {}
    done = ",".join("?" for _ in _DONE_STATUSES)
    model_expr = "COALESCE(NULLIF(TRIM(model),''),'알 수 없음')"
    # ★요청에 실제로 등장하는 주기만 집계한다(2026-09-12). 종전엔 day·week·month 를 모두
    #  계산했는데, 소비부는 프로젝트마다 지정된 **한 주기**만 읽는다(아래 `periods.get(pid)`).
    #  실측 계획 3개가 전부 `month` 였고, 코덱스 비교에서 반환값이 동일한 채 142.13 → 110.52ms.
    #  `_period_conditions` 는 month_anchor_day 를 반영하므로 거기서 고른다(식을 새로 쓰지 않는다).
    # 유효성 검사는 따로 두지 않는다 — 아래 루프가 `_period_conditions` 의 이름만 돌므로
    # 잘못된 주기명(옛 데이터·손입력)은 애초에 일치하지 않는다(소비부도 같은 이유로 건너뛴다).
    wanted = set(periods.values())
    period_cols = "".join(
        f", SUM(CASE WHEN {cond} THEN 1 ELSE 0 END) AS {name}_count"
        f", SUM(CASE WHEN {cond} THEN {_CREDIT} ELSE 0 END) AS {name}_credits"
        f", SUM(CASE WHEN {cond} THEN is_final ELSE 0 END) AS {name}_final"
        for name, cond in _period_conditions(month_anchor_day).items()
        if name in wanted
    )
    empty: dict[str, Any] = {
        "stats": {}, "models": {}, "budget_models": {}, "folder_rows": [], "workers": [],
    }
    with get_connection() as conn:
        # 관리 DB 가 아직 초기화되지 않은 설치본(팩트 없음)에서 요약이 500 으로 죽지 않게 — 빈 사용량.
        # (MANAGE on 이면 시작 시 init_manage_db 가 만들므로 운영에선 거의 안 걸린다.)
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_generation_fact'"
        ).fetchone():
            return empty
        conn.execute("BEGIN")  # 아래 모든 집계를 같은 WAL 읽기 스냅샷에 고정
        stat_rows = conn.execute(
            f"SELECT project_id AS pid, COUNT(*) AS gen_count, "
            f"SUM(CASE WHEN LOWER(COALESCE(status,'')) IN ({done}) THEN 1 ELSE 0 END) AS done_count, "
            f"COALESCE(SUM(is_final),0) AS final_count, "
            f"COALESCE(SUM(is_shared),0) AS shared_count, "
            f"COALESCE(SUM(real_credits),0) AS real_credits, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, "
            f"SUM(CASE WHEN real_credits IS NOT NULL THEN 1 ELSE 0 END) AS credit_real_count, "
            f"SUM(CASE WHEN real_credits IS NULL AND est_credits IS NOT NULL THEN 1 ELSE 0 END) "
            f"  AS credit_est_count, "
            f"SUM(CASE WHEN real_credits IS NULL AND est_credits IS NULL THEN 1 ELSE 0 END) "
            f"  AS credit_unknown_count, "
            f"COALESCE(SUM(elapsed_seconds),0) AS elapsed_total "
            f"FROM team_generation_fact {where} GROUP BY project_id",
            [*_DONE_STATUSES, *args],
        ).fetchall()
        model_rows = conn.execute(
            f"SELECT project_id AS pid, {model_expr} AS model, COUNT(*) AS count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, COALESCE(SUM(is_final),0) AS final_count, "
            f"COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds{period_cols} "
            f"FROM team_generation_fact {where} GROUP BY project_id, {model_expr} "
            f"ORDER BY credits DESC, count DESC, model COLLATE NOCASE",
            args,
        ).fetchall()
        folder_rows = conn.execute(
            f"SELECT project_id AS pid, folder_path, creator_uid, MAX(creator_name) AS creator_name, "
            f"{model_expr} AS model, COUNT(*) AS count, COALESCE(SUM(is_final),0) AS final_count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, "
            f"COALESCE(SUM(elapsed_seconds),0) AS elapsed_seconds, "
            f"MIN(datetime(created_at,'localtime')) AS created_start, "
            f"MAX(datetime(created_at,'localtime')) AS created_end "
            f"FROM team_generation_fact {where} "
            f"GROUP BY project_id, folder_path, creator_uid, {model_expr} "
            f"ORDER BY project_id, folder_path COLLATE NOCASE, credits DESC",
            args,
        ).fetchall()
        worker_rows = conn.execute(
            f"SELECT creator_uid AS uid, MAX(creator_name) AS name, COUNT(*) AS gen_count, "
            f"COALESCE(SUM({_CREDIT}),0) AS credits, "
            f"COALESCE(SUM(elapsed_seconds),0) AS elapsed_total "
            f"FROM team_generation_fact {where} GROUP BY creator_uid ORDER BY gen_count DESC",
            args,
        ).fetchall()
    stats: dict[Optional[str], dict[str, Any]] = {}
    for r in stat_rows:
        d = dict(r)
        d["metric_count"] = int(d["credit_real_count"] or 0) + int(d["credit_est_count"] or 0)
        stats[d["pid"]] = d
    models: dict[str, list[dict[str, Any]]] = {}
    budget: dict[str, list[dict[str, Any]]] = {}
    for r in model_rows:
        pid = r["pid"]
        models.setdefault(pid, []).append(
            {
                "model": r["model"],
                "count": r["count"] or 0,
                "credits": r["credits"] or 0,
                "final_count": r["final_count"] or 0,
                "elapsed_seconds": r["elapsed_seconds"] or 0,
            }
        )
        period = periods.get(pid)
        if period not in _PERIOD_MATCH:
            continue
        count = r[f"{period}_count"] or 0
        if not count:
            continue
        budget.setdefault(pid, []).append(
            {
                "model": r["model"],
                "count": count,
                "credits": r[f"{period}_credits"] or 0,
                "final_count": r[f"{period}_final"] or 0,
            }
        )
    for rows_ in budget.values():
        rows_.sort(key=lambda it: (-it["credits"], -it["count"], it["model"].lower()))
    return {
        "stats": stats,
        "models": models,
        "budget_models": budget,
        "folder_rows": [dict(r) for r in folder_rows],
        "workers": [dict(r) for r in worker_rows],
    }
