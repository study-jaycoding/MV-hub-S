"""PM 대시보드(매니징먼트) 데이터 접근 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 모든 데이터를 **별도 테이블**에 둔다 —
코어(generation·project)는 한 글자도 안 건드린다. 테이블은 이 모듈이 첫 호출 때
`CREATE TABLE IF NOT EXISTS` 로 직접 만든다(db.py·schema.sql 무수정).

기능 비활성(CONTENT_HUB_MANAGE off)이면 main.py 가 이 모듈을 import 하지 않으므로
테이블조차 생성되지 않는다 → 완전 제거 가능(사이드카 테이블 DROP 한 번이면 흔적 0).
"""

from __future__ import annotations

import bisect
import hashlib
import json
from datetime import datetime
from typing import Any, Optional

from ..db import get_connection
from ._common import new_id
from .identity import resolve_display_names

# ── 사이드카 스키마 (코어와 분리) ─────────────────────────────────────────────
# FK/ON DELETE CASCADE 는 일부러 안 건다 — 코어 project 삭제 경로를 안 건드리기 위함.
# 삭제된 프로젝트의 잔존 planning/task 행은 무해하며 project 조인으로 자연히 가려진다.
_SCHEMA = (
    # 생성물별 메트릭(견적·실제 크레딧·시간). 코어 generation 에 컬럼 추가 대신 사이드카.
    """CREATE TABLE IF NOT EXISTS generation_metrics (
        gen_id          TEXT PRIMARY KEY,   -- generation.id (로컬 primary)
        job_id          TEXT,               -- generation.job_id (id<->job_id 이중 매칭용)
        est_credits     INTEGER,            -- generate cost 견적
        real_credits    INTEGER,            -- account transactions 매칭 실제값 (NULL=미상)
        credit_source   TEXT,               -- 'estimate' | 'transaction' | NULL
        requested_at    TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        elapsed_seconds REAL,
        matched         INTEGER NOT NULL DEFAULT 0  -- 1=실제값을 신뢰 매칭으로 채움
    )""",
    # 거래내역 수집(account transactions). 거래엔 고유 id 가 없어 복합 해시를 PK 로 → 재수집 dedup.
    """CREATE TABLE IF NOT EXISTS credit_txn (
        id            TEXT PRIMARY KEY,      -- hash(owner_uid|created_at|credits|action|display_name)
        owner_uid     TEXT,                  -- 누구 계정(creator_uid)
        account_email TEXT,
        display_name  TEXT,                  -- 거래의 모델 표시명
        credits       REAL,                  -- 부호 있음(음수=차감)
        action        TEXT,                  -- spend | refund | grant
        created_at    TEXT,                  -- 거래 시각(UTC ISO)
        matched_gen_id TEXT,                 -- 귀속한 생성물(NULL=미귀속)
        model         TEXT                   -- 모델 키(job_set_type). 에이전트가 display_name→key 변환 태깅(NULL=옛 에이전트)
    )""",
    # 프로젝트 일정/예산(스케줄 사이드카). 코어 project 에 컬럼 추가하지 않음 → 깔끔히 제거 가능.
    """CREATE TABLE IF NOT EXISTS project_planning (
        project_id     TEXT PRIMARY KEY,
        status         TEXT,                 -- active | done | hold
        start_date     TEXT,
        due_date       TEXT,
        budget_credits INTEGER,
        note           TEXT
    )""",
    # 프로젝트 ↔ 실제 제작 폴더 연결. 코어 project 테이블은 건드리지 않고, PM/관리 UI 에서만 사용.
    """CREATE TABLE IF NOT EXISTS project_folder_link (
        project_id    TEXT PRIMARY KEY,
        root_path     TEXT NOT NULL,
        selected_path TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    # 작업(Task) — 프로젝트 하위 관리 단위.
    """CREATE TABLE IF NOT EXISTS project_task (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        name         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'not_started',  -- not_started|pending|in_progress|publish|retake|omit|done
        assignee_uid TEXT,
        start_date   TEXT,
        due_date     TEXT,
        sort_order   INTEGER,
        note         TEXT,
        sequence     TEXT,                          -- 전역 태그(auto_tag)명 — Notion 스타일 '시퀀스'
        description  TEXT,                           -- 설명(자유 입력)
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    # 작업 ↔ 생성물 연결.
    """CREATE TABLE IF NOT EXISTS task_generation (
        task_id TEXT NOT NULL,
        gen_id  TEXT NOT NULL,
        PRIMARY KEY (task_id, gen_id)
    )""",
    # 완료본 렌더폴더 저장 대장(멱등) — "완료만 저장하기"가 저장한 생성물·목적지 기록.
    # gen_id 당 1행. 실제 파일 존재 여부로 멱등 판정(기록만 있고 파일 없으면 재복사).
    """CREATE TABLE IF NOT EXISTS final_export (
        gen_id      TEXT PRIMARY KEY,
        dest_path   TEXT NOT NULL,
        exported_at TEXT NOT NULL DEFAULT (datetime('now'))
    )""",
    # 팀 매니징 텔레메트리 발신 큐(로컬 전용, manage-T2). 내 생성물이 생기거나 바뀌면 여기 dirty 로
    # 표시하고, 드레이너가 팩트를 만들어 서버 manage_hub.db 로 push 후 pushed_at 을 찍는다.
    # 재푸시 대상 판정: pushed_at IS NULL 또는 dirty_at > pushed_at.
    """CREATE TABLE IF NOT EXISTS telemetry_outbox (
        local_gen_id     TEXT PRIMARY KEY,
        dirty_at         TEXT NOT NULL DEFAULT (datetime('now')),
        pushed_at        TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_error       TEXT,
        is_tombstone     INTEGER NOT NULL DEFAULT 0,  -- 1=삭제 통보(생성물이 메인에서 사라짐)
        tomb_job_id      TEXT,                        -- 삭제 시 캡처한 job_id(팩트 못 만드므로 저장)
        tomb_creator_uid TEXT,                        -- 삭제된 생성물의 작성자(내 것)
        tomb_snapshot    TEXT                         -- 삭제 직전 팩트 스냅샷(JSON) — 미전송분도 비용·프로젝트 보존
    )""",
    "CREATE INDEX IF NOT EXISTS idx_telemetry_outbox_pushed ON telemetry_outbox(pushed_at)",
    "CREATE INDEX IF NOT EXISTS idx_credit_txn_owner ON credit_txn(owner_uid, created_at)",
    # 매칭 스캔(미귀속 spend)용 부분 인덱스 — 누적된 거래에서 대상만 빠르게.
    "CREATE INDEX IF NOT EXISTS idx_credit_txn_unmatched ON credit_txn(owner_uid) "
    "WHERE action='spend' AND matched_gen_id IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_project_task_proj ON project_task(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_task_gen_gen ON task_generation(gen_id)",
)


def _ensure_schema(conn) -> None:
    """사이드카 테이블·인덱스 보장(멱등). CREATE IF NOT EXISTS 라 매 호출 비용은 미미하고,
    계정별 분리 DB 마다 각자 만들어져야 하므로 모듈 전역 가드 없이 호출마다 실행한다."""
    for stmt in _SCHEMA:
        conn.execute(stmt)
    # 기존 project_task 에 Notion 스타일 확장 컬럼 멱등 보강(db.py _migrate 패턴).
    cols = {r[1] for r in conn.execute("PRAGMA table_info(project_task)")}
    for col in ("sequence", "description", "folder_path"):
        if col not in cols:
            conn.execute(f"ALTER TABLE project_task ADD COLUMN {col} TEXT")
    # 폴더 자동 작업의 멱등 키 — 프로젝트+폴더당 1개. 수동 작업(folder_path NULL)은 제약 없음(부분 인덱스).
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_folder "
        "ON project_task(project_id, folder_path) WHERE folder_path IS NOT NULL"
    )
    # credit_txn.model 멱등 보강(옛 DB엔 없음) — 모델 가드 매칭용.
    tcols = {r[1] for r in conn.execute("PRAGMA table_info(credit_txn)")}
    if "model" not in tcols:
        conn.execute("ALTER TABLE credit_txn ADD COLUMN model TEXT")
    # telemetry_outbox tombstone 컬럼 멱등 보강(T5 이전 생성 DB엔 없음).
    ocols = {r[1] for r in conn.execute("PRAGMA table_info(telemetry_outbox)")}
    if "is_tombstone" not in ocols:
        conn.execute("ALTER TABLE telemetry_outbox ADD COLUMN is_tombstone INTEGER NOT NULL DEFAULT 0")
    if "tomb_job_id" not in ocols:
        conn.execute("ALTER TABLE telemetry_outbox ADD COLUMN tomb_job_id TEXT")
    if "tomb_creator_uid" not in ocols:
        conn.execute("ALTER TABLE telemetry_outbox ADD COLUMN tomb_creator_uid TEXT")
    if "tomb_snapshot" not in ocols:
        conn.execute("ALTER TABLE telemetry_outbox ADD COLUMN tomb_snapshot TEXT")
    # 상태 세분화 마이그레이션(멱등) — 구 단계 → Notion 세분. 대상 행 없으면 무동작.
    # retake 폐지: 진행 중으로 되돌림. todo→시작전, review→게시.
    for old, new in (("todo", "not_started"), ("review", "publish"), ("retake", "in_progress")):
        conn.execute("UPDATE project_task SET status=? WHERE status=?", (new, old))


def list_project_folders() -> dict[str, dict[str, Any]]:
    """프로젝트별 실제 폴더 연결 메타. 트리는 여기서 만들지 않는다(목록 로드 가볍게)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT project_id, root_path, COALESCE(selected_path, '') AS selected_path, "
            "updated_at FROM project_folder_link"
        ).fetchall()
        return {r["project_id"]: dict(r) for r in rows}


def get_project_folder(project_id: str) -> dict[str, Any]:
    with get_connection() as conn:
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT project_id, root_path, COALESCE(selected_path, '') AS selected_path, "
            "updated_at FROM project_folder_link WHERE project_id=?",
            (project_id,),
        ).fetchone()
        return dict(row) if row else {
            "project_id": project_id,
            "root_path": "",
            "selected_path": "",
            "updated_at": None,
        }


def set_project_folder(
    project_id: str,
    root_path: Optional[str] = None,
    selected_path: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트의 실제 폴더 연결 저장. root_path 빈 값은 연결 제거."""
    root = (root_path or "").strip()
    selected = (selected_path or "").strip().replace("\\", "/").strip("/")
    with get_connection() as conn:
        _ensure_schema(conn)
        if not root:
            conn.execute("DELETE FROM project_folder_link WHERE project_id=?", (project_id,))
            return {
                "project_id": project_id,
                "root_path": "",
                "selected_path": "",
                "updated_at": None,
            }
        conn.execute(
            """INSERT INTO project_folder_link(project_id, root_path, selected_path, updated_at)
               VALUES(?,?,?,datetime('now'))
               ON CONFLICT(project_id) DO UPDATE SET
                 root_path=excluded.root_path,
                 selected_path=excluded.selected_path,
                 updated_at=datetime('now')""",
            (project_id, root, selected),
        )
    return get_project_folder(project_id)


# ── 대시보드 집계 ────────────────────────────────────────────────────────────
_TYPE_KEYS = ("image", "video", "3d", "audio")


def _classify_type(model: Optional[str], asset_type: Optional[str], type_map: dict) -> str:
    """생성물 출력 타입 — 모델 카탈로그(정답) 우선, 없으면 asset_type(URL 추측) 폴백.
    type_map: {job_set_type: 'image'|'video'|'3d'|'audio'} (라우터가 model list 로 채움)."""
    t = type_map.get(model) if model else None
    if not t:
        t = asset_type or "image"
    return t if t in _TYPE_KEYS else "image"


def dashboard_summary(model_type_map: Optional[dict] = None) -> dict[str, Any]:
    """프로젝트별·작업자별 생성수·크레딧·소요시간 + 출력타입·영상길이 + 환불·워크스페이스 요약.

    크레딧 = COALESCE(실제, 견적). 출력타입은 model_type_map(라우터가 CLI model list 로 채움)
    우선, 없으면 asset.type(URL 추측) 폴백. 영상길이는 params.duration 합(초)."""
    tmap = model_type_map or {}
    with get_connection() as conn:
        _ensure_schema(conn)
        proj = conn.execute(
            """SELECT g.project_id AS pid, p.name AS name,
                      COUNT(*) AS gen_count,
                      SUM(CASE WHEN g.status='done' THEN 1 ELSE 0 END) AS done_count,
                      SUM(CASE WHEN g.is_final=1 THEN 1 ELSE 0 END) AS final_count,
                      SUM(CASE WHEN s.generation_id IS NOT NULL THEN 1 ELSE 0 END) AS shared_count,
                      COALESCE(SUM(m.real_credits), 0) AS real_credits,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      COUNT(m.gen_id) AS metric_count,
                      COALESCE(SUM(m.elapsed_seconds), 0) AS elapsed_total
               FROM generation g
               LEFT JOIN project p ON p.id = g.project_id
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               LEFT JOIN share s ON s.generation_id = g.id
               WHERE g.deleted_at IS NULL
               GROUP BY g.project_id
               ORDER BY gen_count DESC"""
        ).fetchall()
        # 설정된 프로젝트(레지스트리) — 미분류(null) 제외, 보관 제외. 생성물이 없어도 0으로 표시.
        reg = conn.execute(
            "SELECT id, name FROM project WHERE archived = 0 "
            "ORDER BY COALESCE(sort_order, 1000000), created_at"
        ).fetchall()
        workers = conn.execute(
            """SELECT g.creator_uid AS uid,
                      COUNT(*) AS gen_count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      COALESCE(SUM(m.elapsed_seconds), 0) AS elapsed_total
               FROM generation g
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL
               GROUP BY g.creator_uid
               ORDER BY gen_count DESC"""
        ).fetchall()
        uids = [w["uid"] for w in workers if w["uid"]]
        names = resolve_display_names(conn, uids) if uids else {}
        planning = {
            r["project_id"]: dict(r)
            for r in conn.execute("SELECT * FROM project_planning").fetchall()
        }
        # 출력타입·영상길이 — 모델 카탈로그(정답)로 분류, params.duration 합(영상만).
        # 한 생성물의 대표 에셋 타입(URL 추측)은 폴백용. 모델→type 가 있으면 그것이 우선.
        per_gen = conn.execute(
            """SELECT g.project_id AS pid, g.model AS model,
                      json_extract(g.params, '$.duration') AS duration,
                      a.type AS asset_type
               FROM generation g
               LEFT JOIN (
                   SELECT generation_id, MIN(type) AS type FROM asset GROUP BY generation_id
               ) a ON a.generation_id = g.id
               WHERE g.deleted_at IS NULL"""
        ).fetchall()
        # 환불·지급 — credit_txn 의 action 별 합(절대값). spend 는 실매칭으로 이미 잡힘.
        io_rows = conn.execute(
            "SELECT action, COALESCE(SUM(ABS(credits)), 0) AS amt FROM credit_txn GROUP BY action"
        ).fetchall()

    # 타입·영상길이 집계(프로젝트별 + 전체)
    type_by_pid: dict = {}
    dur_by_pid: dict = {}
    type_totals = {k: 0 for k in _TYPE_KEYS}
    video_seconds_total = 0.0
    for r in per_gen:
        t = _classify_type(r["model"], r["asset_type"], tmap)
        tb = type_by_pid.setdefault(r["pid"], {k: 0 for k in _TYPE_KEYS})
        tb[t] += 1
        type_totals[t] += 1
        if t == "video" and r["duration"] is not None:
            try:
                sec = float(r["duration"])
                dur_by_pid[r["pid"]] = dur_by_pid.get(r["pid"], 0.0) + sec
                video_seconds_total += sec
            except (ValueError, TypeError):
                pass

    # 표시 프로젝트 = 설정된 프로젝트(레지스트리). 생성물 통계는 pid 로 매칭(없으면 0).
    stats_by_pid = {r["pid"]: r for r in proj}
    projects = []
    for rp in reg:
        pid = rp["id"]
        s = stats_by_pid.get(pid)
        d = {
            "pid": pid,
            "name": rp["name"] or pid,
            "gen_count": s["gen_count"] if s else 0,
            "done_count": s["done_count"] if s else 0,
            "shared_count": s["shared_count"] if s else 0,
            "final_count": s["final_count"] if s else 0,
            "real_credits": s["real_credits"] if s else 0,
            "credits": s["credits"] if s else 0,
            "metric_count": s["metric_count"] if s else 0,
            "elapsed_total": s["elapsed_total"] if s else 0,
            "planning": planning.get(pid),
            "types": type_by_pid.get(pid, {k: 0 for k in _TYPE_KEYS}),
            "video_seconds": round(dur_by_pid.get(pid, 0.0), 1),
        }
        projects.append(d)
    worker_list = []
    for w in workers:
        d = dict(w)
        d["name"] = names.get(w["uid"]) or ("미상" if not w["uid"] else w["uid"])
        worker_list.append(d)

    io = {r["action"]: r["amt"] for r in io_rows}
    # 합계는 전체 생성물 기준(미분류 포함) — 표시 프로젝트 목록은 미분류를 빼지만 '총 생성물'은 전부.
    totals = {
        "gen_count": sum(p["gen_count"] for p in proj),
        "done_count": sum(p["done_count"] for p in proj),
        "credits": sum(p["credits"] for p in proj),
        "real_credits": sum(p["real_credits"] for p in proj),
        "elapsed_total": sum(p["elapsed_total"] for p in proj),
        "metric_count": sum(p["metric_count"] for p in proj),
        "types": type_totals,
        "video_seconds": round(video_seconds_total, 1),
        # 실제 거래 기준 입출(절대값). net = 지출 - 환불.
        "spend_credits": round(io.get("spend", 0)),
        "refund_credits": round(io.get("refund", 0)),
        "grant_credits": round(io.get("grant", 0)),
        "net_credits": round(io.get("spend", 0) - io.get("refund", 0)),
    }
    return {
        "projects": projects,
        "workers": worker_list,
        "totals": totals,
        "workspaces": _workspace_credits(),
    }


def _workspace_credits() -> list[dict[str, Any]]:
    """계정들이 보고한 워크스페이스별 크레딧 풀(account status.workspaces 집계). 같은 워크스페이스는
    가장 최근 보고값으로 dedup. CLI 가 주는 팀 과금 풀 차원 — 이미 수집된 데이터(hf_status:*) 활용."""
    from .identity import list_account_statuses

    out: dict[str, dict[str, Any]] = {}
    try:
        statuses = list_account_statuses()
    except Exception:  # noqa: BLE001
        return []
    for _email, st in (statuses or {}).items():
        if not isinstance(st, dict):
            continue
        for ws in st.get("workspaces") or []:
            if not isinstance(ws, dict) or not ws.get("id"):
                continue
            # 팀 과금 풀만 — 개인(free/personal) 플랜은 제외(PM 관점에서 팀 크레딧만 의미).
            if (ws.get("plan_type") or "").lower() != "team":
                continue
            out[ws["id"]] = {
                "id": ws.get("id"),
                "name": ws.get("name") or "(이름없음)",
                "credits": ws.get("credits"),
                "plan_type": ws.get("plan_type"),
                "user_role": ws.get("user_role"),
            }
    return sorted(out.values(), key=lambda w: (w["credits"] is None, -(w["credits"] or 0)))


# ── 프로젝트 일정/예산 ────────────────────────────────────────────────────────
def get_planning(pid: str) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        _ensure_schema(conn)
        r = conn.execute(
            "SELECT * FROM project_planning WHERE project_id=?", (pid,)
        ).fetchone()
        return dict(r) if r else None


def set_planning(
    pid: str,
    *,
    status: Optional[str] = None,
    start_date: Optional[str] = None,
    due_date: Optional[str] = None,
    budget_credits: Optional[int] = None,
    note: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트 일정/예산 upsert. project_planning 사이드카만 건드린다(코어 project 무수정)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            """INSERT INTO project_planning
                   (project_id, status, start_date, due_date, budget_credits, note)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(project_id) DO UPDATE SET
                   status=excluded.status, start_date=excluded.start_date,
                   due_date=excluded.due_date, budget_credits=excluded.budget_credits,
                   note=excluded.note""",
            (pid, status, start_date, due_date, budget_credits, note),
        )
        return dict(
            conn.execute(
                "SELECT * FROM project_planning WHERE project_id=?", (pid,)
            ).fetchone()
        )


# ── 작업(Task) ────────────────────────────────────────────────────────────────
_TASK_FIELDS = (
    "name", "status", "assignee_uid", "start_date", "due_date", "sort_order", "note",
    "sequence", "description",
)


def task_project_id(tid: str) -> Optional[str]:
    """작업 id 가 속한 프로젝트 id. 권한 검사에서 먼저 사용한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT project_id FROM project_task WHERE id=?", (tid,)
        ).fetchone()
        return row["project_id"] if row else None


def _task_gen_rows(
    conn, tid: str, project_id: str, sequence: Optional[str], folder_path: Optional[str]
):
    """작업에 귀속된 생성물 — 컷 매칭을 2레인으로 분리(전역변수 2종이 안 섞이게):
      · 폴더 자동 작업(folder_path 있음) → g.project_id=? AND g.folder_path=? 로만.
      · 수동 작업(folder_path NULL) → 시퀀스(전역 태그명) 자동 매칭.
    두 경우 모두 ② 수동 드래그 링크(task_generation)는 항상 포함(명시적 사용자 행동).
    정렬은 최종(is_final) → 공유(share) → 일반, 각 최신순(sort_ts DESC). linked=수동 링크 여부."""
    seq = (sequence or "").strip() or None
    fpath = (folder_path or "").strip() or None
    # 폴더 작업이면 시퀀스 레인 비활성(seq=None), 수동 작업이면 폴더 레인 비활성(fpath 이미 None).
    if fpath is not None:
        seq = None
    return conn.execute(
        "SELECT g.id AS id, g.status AS status, g.creator_uid AS creator_uid, "
        "  g.is_final AS is_final, g.created_at AS created_at, g.job_id AS job_id, "
        "  EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared, "
        "  EXISTS(SELECT 1 FROM task_generation tg WHERE tg.task_id=? AND tg.gen_id=g.id) AS linked, "
        # 썸네일: poster(thumbnail_path) 우선. 비디오는 file_path(영상)를 이미지 썸네일로 못 써 깨지므로
        # poster 없으면 NULL(프론트가 <video> 로 첫 프레임 표시). 이미지는 file_path 그대로.
        "  (SELECT COALESCE(a.thumbnail_path, CASE WHEN a.type='video' THEN NULL ELSE a.file_path END) "
        "   FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS thumb, "
        # 비디오 컷은 poster 가 없어도 <video preload=metadata> 로 첫 프레임을 보여주게 원본·타입을 준다.
        "  (SELECT a.type FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS media_type, "
        "  (SELECT a.file_path FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS file_path "
        "FROM generation g "
        "WHERE g.deleted_at IS NULL AND ("
        "   g.id IN (SELECT gen_id FROM task_generation WHERE task_id=?) "
        "   OR (? IS NOT NULL AND g.project_id=? AND g.folder_path=?) "  # 폴더 레인
        "   OR (? IS NOT NULL AND g.project_id=? AND g.id IN ("          # 시퀀스 레인
        "        SELECT gat.generation_id FROM gen_auto_tag gat "
        "        JOIN auto_tag at ON at.id=gat.auto_tag_id WHERE at.name=?)) "
        ") "
        "ORDER BY g.is_final DESC, shared DESC, g.sort_ts DESC",
        (tid, tid, fpath, project_id, fpath, seq, project_id, seq),
    ).fetchall()


def sync_folder_tasks(conn, project_id: str) -> None:
    """폴더로 라벨링된 생성물에서 작업 카드를 자동 생성(create-only, 멱등).

    프로젝트의 distinct folder_path 마다 project_task 1개를 보장 — name=1단계(예 ep001),
    sequence=2단계(예 c0010), folder_path=전체 경로. INSERT OR IGNORE + (project_id, folder_path)
    유니크 인덱스로 이미 있으면 건너뜀 → PM 이 편집한 status/일정/설명을 절대 덮어쓰지 않는다.
    폴더/생성물이 사라져도 자동 작업을 삭제하지 않는다(편집 정보 유실 방지).

    ★읽기(list_tasks)마다 호출되므로, 이미 작업이 있는 folder_path 는 아예 제외해
    불필요한 INSERT 시도를 없앤다(NOT EXISTS). 새 폴더가 없으면 write 0회."""
    fps = conn.execute(
        "SELECT DISTINCT g.folder_path FROM generation g "
        "WHERE g.project_id=? AND g.folder_path IS NOT NULL AND g.folder_path<>'' "
        "  AND g.deleted_at IS NULL "
        "  AND NOT EXISTS (SELECT 1 FROM project_task t "
        "                  WHERE t.project_id=g.project_id AND t.folder_path=g.folder_path)",
        (project_id,),
    ).fetchall()
    for row in fps:
        fp = row["folder_path"]
        parts = [seg for seg in fp.split("/") if seg]
        if not parts:
            continue
        name = parts[0]
        sequence = parts[1] if len(parts) > 1 else None
        conn.execute(
            "INSERT OR IGNORE INTO project_task"
            "(id, project_id, name, status, sequence, folder_path) VALUES(?,?,?,?,?,?)",
            (new_id(), project_id, name, "not_started", sequence, fp),
        )


def list_tasks(project_id: str) -> list[dict[str, Any]]:
    """작업 목록 + 귀속 생성물 파생(컷 썸네일·생성자·크레딧·제작시간·코멘트수).
    귀속=폴더/시퀀스 자동(2레인) ∪ 수동 링크. 보드/테이블/캘린더가 같은 이 데이터를 쓴다.
    조회 전에 폴더 자동 작업을 멱등 동기화(create-only)한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        sync_folder_tasks(conn, project_id)  # 폴더로 만든 생성물 → 작업 카드 자동 생성(멱등)
        rows = conn.execute(
            "SELECT * FROM project_task WHERE project_id=? "
            "ORDER BY COALESCE(sort_order, 1000000), created_at",
            (project_id,),
        ).fetchall()
        out = []
        all_creator_uids: set[str] = set()
        all_gen_ids: set[str] = set()
        per_task_cuts: dict[str, list[dict[str, Any]]] = {}
        # 1차: 작업별 컷만 확보하고 전체 gen_id 를 모은다(크레딧·코멘트는 아래서 1회 배치 조회).
        for r in rows:
            tid = r["id"]
            gens = [
                dict(c)
                for c in _task_gen_rows(conn, tid, project_id, r["sequence"], r["folder_path"])
            ]
            per_task_cuts[tid] = gens
            for g in gens:
                if g["creator_uid"]:
                    all_creator_uids.add(g["creator_uid"])
                all_gen_ids.add(g["id"])
        # ★배치 집계 — 작업 P개마다 반복하던 metrics/comment 쿼리(≈2P회)를 전체 gen_id 로 1회씩.
        # elapsed 는 raw(NULL 유지) — '없음(NULL)'과 '0초'를 구분해야 manage_hub 폴백이 가능(코덱스).
        metrics_by_gen: dict[str, tuple] = {}   # gen_id -> (credits, elapsed|None)
        comments_by_gen: dict[str, int] = {}    # gen_id -> 코멘트 수
        if all_gen_ids:
            idlist = list(all_gen_ids)
            ph = ",".join("?" * len(idlist))
            for m in conn.execute(
                f"SELECT gen_id, COALESCE(real_credits, est_credits) AS credits, "
                f"  elapsed_seconds AS elapsed "
                f"FROM generation_metrics WHERE gen_id IN ({ph})",
                idlist,
            ):
                metrics_by_gen[m["gen_id"]] = (m["credits"] or 0, m["elapsed"])
            for c in conn.execute(
                f"SELECT gen_id, COUNT(*) AS c FROM generation_comment "
                f"WHERE gen_id IN ({ph}) GROUP BY gen_id",
                idlist,
            ):
                comments_by_gen[c["gen_id"]] = c["c"]
        # ★생성 소요시간 폴백 — 콘텐츠 DB elapsed 가 없는(NULL) 컷은 manage_hub.db(텔레메트리로
        # 보존된 elapsed)에서 job_id 로 끌어온다. 콘텐츠 push 경로가 elapsed 를 버려서 작업탭이
        # "—" 로 뜨던 문제를 데이터 그대로(허브 큐 생성분만 존재) 채운다. 실패해도 {} 라 안전.
        elapsed_by_job: dict[str, float] = {}
        need_job_ids = [
            g["job_id"]
            for gens in per_task_cuts.values()
            for g in gens
            if g.get("job_id") and metrics_by_gen.get(g["id"], (0, None))[1] is None
        ]
        if need_job_ids:
            from .. import manage_db
            elapsed_by_job = manage_db.elapsed_by_job_ids(need_job_ids)
        # 2차: 배치 결과를 작업별로 합산해 조립(집계 의미는 기존과 동일).
        for r in rows:
            tid = r["id"]
            gens = per_task_cuts[tid]
            gen_ids = [g["id"] for g in gens]
            credits = sum(metrics_by_gen.get(gid, (0, None))[0] for gid in gen_ids)
            # 컷별 elapsed: 콘텐츠 값 우선, NULL 이면 job_id 로 manage_hub 폴백, 그래도 없으면 0.
            elapsed = 0.0
            for g in gens:
                e = metrics_by_gen.get(g["id"], (0, None))[1]
                if e is None and g.get("job_id"):
                    e = elapsed_by_job.get(g["job_id"])
                elapsed += e or 0
            cc = sum(comments_by_gen.get(gid, 0) for gid in gen_ids)
            d = dict(r)
            d["gen_count"] = len(gen_ids)
            d["credits"] = credits
            d["elapsed"] = elapsed
            d["comment_count"] = cc
            # 기간 파생 — 자동 작업의 시작~마감을 연결 컷의 생성일 범위로 표시(DB 미기록, 반환값만).
            # start_date/due_date 는 PM 입력값 그대로 두고, 별도 derived_* 로 내려 프론트가
            # 'PM값 ?? 파생값'으로 표시(코덱스). created_at 은 시각 포함이라 앞 10자리(날짜)만 쓴다.
            days = sorted(g["created_at"][:10] for g in gens if g.get("created_at"))
            d["derived_start"] = days[0] if days else None
            d["derived_due"] = days[-1] if days else None
            d["derived_date"] = days[0] if days else None  # 기존 캘린더 폴백 호환
            # 폴더 자동 작업은 컷 상태로 열(상태)을 자동 배치: 최종→완료, 공유→게시, 생성물→진행.
            # 단 사용자가 '생략'으로 옮긴 건 수동 종결이라 그대로 둔다(그때 컷 비활성화는 프론트 처리).
            if r["folder_path"] and r["status"] != "omit":
                if any(g["is_final"] for g in gens):
                    d["status"] = "done"
                elif any(g["shared"] for g in gens):
                    d["status"] = "publish"
                elif gens:
                    d["status"] = "in_progress"
                else:
                    d["status"] = "not_started"
            # ★빈 자동 작업 숨김 — 생성물을 휴지통으로 보내면 folder_path 작업 행은 남아(create-only,
            # 삭제 안 함) gen_count=0 유령 카드가 된다. PM 이 손대지 않은(일정·메모·담당·설명·생략
            # 없음) 빈 자동 작업만 목록에서 제외(행은 보존 → 생성물 돌아오면 재등장). 코덱스: sort_order
            # 는 드래그로 찍힐 수 있어 편집 기준에서 제외.
            pm_edited = bool(
                r["start_date"] or r["due_date"] or r["note"]
                or r["assignee_uid"] or r["description"] or r["status"] == "omit"
            )
            if r["folder_path"] and d["gen_count"] == 0 and not pm_edited:
                continue
            out.append(d)
        # 작성자 이름 일괄 해석 후 작업별 distinct 생성자명 부착(정렬 순서 유지).
        names = resolve_display_names(conn, list(all_creator_uids)) if all_creator_uids else {}
        for d in out:
            seen: list[str] = []
            for c in per_task_cuts[d["id"]]:
                nm = names.get(c["creator_uid"]) if c["creator_uid"] else None
                if nm and nm not in seen:
                    seen.append(nm)
                c["creator_name"] = nm
                c.pop("job_id", None)  # 폴백 계산용 내부값 — 응답(컷)엔 노출 안 함(코덱스)
            d["cuts"] = per_task_cuts[d["id"]]
            d["creators"] = seen
        return out


def create_task(project_id: str, name: str, **kw: Any) -> dict[str, Any]:
    tid = new_id()
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO project_task"
            "(id, project_id, name, status, assignee_uid, start_date, due_date, sort_order, "
            " note, sequence, description) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                tid, project_id, name, kw.get("status") or "not_started",
                kw.get("assignee_uid"), kw.get("start_date"), kw.get("due_date"),
                kw.get("sort_order"), kw.get("note"),
                kw.get("sequence"), kw.get("description"),
            ),
        )
        return dict(conn.execute("SELECT * FROM project_task WHERE id=?", (tid,)).fetchone())


def update_task(tid: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    sets = {k: v for k, v in fields.items() if k in _TASK_FIELDS}
    if not sets:
        return None
    with get_connection() as conn:
        _ensure_schema(conn)
        cols = ", ".join(f"{k}=?" for k in sets)
        conn.execute(
            f"UPDATE project_task SET {cols} WHERE id=?", (*sets.values(), tid)
        )
        r = conn.execute("SELECT * FROM project_task WHERE id=?", (tid,)).fetchone()
        return dict(r) if r else None


def delete_task(tid: str) -> bool:
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("DELETE FROM task_generation WHERE task_id=?", (tid,))
        cur = conn.execute("DELETE FROM project_task WHERE id=?", (tid,))
        return cur.rowcount > 0


# ── 완료본 렌더폴더 저장(Phase 3) ─────────────────────────────────────────────
def finals_to_export(project_id: str) -> list[dict[str, Any]]:
    """저장 대상 = 완료(done) 작업의 최종본(is_final)이면서 생성 잡도 완료(status=done)인 컷.
    list_tasks 의 파생 상태를 그대로 재사용해 '생략(omit)' 수동 종결은 자동 제외된다.
    반환: [{gen_id, folder_path, file_path, media_type}] — folder_path 로 저장 위치를 정한다."""
    tasks = list_tasks(project_id)
    gen_ids: set[str] = set()
    for t in tasks:
        if t.get("status") != "done":
            continue
        for c in t.get("cuts", []):
            if c.get("is_final") and c.get("status") == "done":
                gen_ids.add(c["id"])
    if not gen_ids:
        return []
    ids = list(gen_ids)
    with get_connection() as conn:
        _ensure_schema(conn)
        ph = ",".join("?" * len(ids))
        # ★project_id 재제한 — 타 프로젝트 컷이 수동 링크로 done 작업에 끼어도
        #   이 프로젝트 렌더 루트로 새어 저장되지 않게(코덱스 지적 #6).
        rows = conn.execute(
            f"SELECT g.id AS gen_id, g.folder_path AS folder_path, "
            f"  (SELECT a.file_path FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS file_path, "
            f"  (SELECT a.type FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS media_type "
            f"FROM generation g WHERE g.id IN ({ph}) AND g.project_id=? AND g.deleted_at IS NULL",
            ids + [project_id],
        ).fetchall()
        return [dict(r) for r in rows]


def record_export(gen_id: str, dest_path: str) -> None:
    """저장 대장에 기록(멱등) — 목적지 경로·시각 갱신."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO final_export(gen_id, dest_path, exported_at) VALUES(?,?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  dest_path=excluded.dest_path, exported_at=excluded.exported_at",
            (gen_id, dest_path),
        )


def list_exports(project_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """이 프로젝트의 저장 이력(대장) — 최근 limit 개만. dest 파일 존재 확인(UNC stat)은
    라우터가 이 범위에서만 수행한다(이력이 쌓여도 네트워크 stat 폭주 방지)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT fe.gen_id, fe.dest_path, fe.exported_at FROM final_export fe "
            "JOIN generation g ON g.id=fe.gen_id "
            "WHERE g.project_id=? AND g.deleted_at IS NULL "
            "ORDER BY fe.exported_at DESC LIMIT ?",
            (project_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ── 메트릭 수집(생성 생명주기 훅) ─────────────────────────────────────────────
# 서버가 통제하는 시점에 generation_metrics 행을 채운다(에이전트 무변경).
#   create  → record_request   (requested_at + 견적 est_credits)
#   claim   → record_started   (started_at)
#   fulfill/fail → record_completed (completed_at + elapsed)
# 호출측(routers/gen_requests)은 전부 MANAGE_ENABLED 게이트 + try/except 로 감싼다 —
# 메트릭 수집이 생성 흐름을 절대 막지 않게(안전 검토 PM_DASHBOARD_DESIGN.md §6-1).
def record_request(
    gen_id: str, job_id: Optional[str] = None, est_credits: Optional[int] = None
) -> None:
    """요청 시점: requested_at(최초 1회 보존) + 견적 박제. est_credits None=미상(NULL)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, job_id, est_credits, credit_source, requested_at) "
            "VALUES(?,?,?,?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  job_id=COALESCE(excluded.job_id, generation_metrics.job_id), "
            "  est_credits=COALESCE(excluded.est_credits, generation_metrics.est_credits), "
            "  credit_source=COALESCE(generation_metrics.credit_source, excluded.credit_source), "
            "  requested_at=COALESCE(generation_metrics.requested_at, excluded.requested_at)",
            (gen_id, job_id, est_credits, "estimate" if est_credits is not None else None),
        )


def record_started(gen_id: str) -> None:
    """claim 시점: started_at(최초 1회 보존 — 중복 claim 으로 덮어쓰지 않음)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, started_at) VALUES(?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  started_at=COALESCE(generation_metrics.started_at, excluded.started_at)",
            (gen_id,),
        )


def record_completed(gen_id: str, job_id: Optional[str] = None) -> None:
    """완료/실패 시점: completed_at + elapsed_seconds(started_at 있을 때만, 초 단위)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, job_id, completed_at) "
            "VALUES(?,?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  job_id=COALESCE(excluded.job_id, generation_metrics.job_id), "
            "  completed_at=excluded.completed_at",
            (gen_id, job_id),
        )
        # elapsed = completed - started (초). started 없으면(동기화·과거분) NULL 유지.
        conn.execute(
            "UPDATE generation_metrics SET elapsed_seconds = "
            "  (julianday(completed_at) - julianday(started_at)) * 86400.0 "
            "WHERE gen_id=? AND started_at IS NOT NULL AND completed_at IS NOT NULL",
            (gen_id,),
        )


def link_generations(task_id: str, gen_ids: list[str]) -> int:
    """생성물들을 작업에 연결(멱등). 변경 행수 반환."""
    if not gen_ids:
        return 0
    n = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        for gid in gen_ids:
            cur = conn.execute(
                "INSERT OR IGNORE INTO task_generation(task_id, gen_id) VALUES(?,?)",
                (task_id, gid),
            )
            n += cur.rowcount
    return n


def unlink_generation(task_id: str, gen_id: str) -> bool:
    """작업에서 컷(생성물) 연결 해제. 멱등."""
    with get_connection() as conn:
        _ensure_schema(conn)
        cur = conn.execute(
            "DELETE FROM task_generation WHERE task_id=? AND gen_id=?", (task_id, gen_id)
        )
        return cur.rowcount > 0


# ── 분석(시각화) — 추이·매트릭스 ──────────────────────────────────────────────
def timeseries(
    bucket: str = "day",
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """일/주별 생성수·크레딧 추이. 크레딧=COALESCE(실제,견적). created_at(UTC 문자열) 기준.
    project_id 를 주면 그 프로젝트, creator_uid 를 주면 그 작업자 생성물만 집계(세부 분석)."""
    fmt = "%Y-%W" if bucket == "week" else "%Y-%m-%d"
    where = "g.deleted_at IS NULL AND g.created_at IS NOT NULL"
    params: list[Any] = []
    if project_id:
        where += " AND g.project_id = ?"
        params.append(project_id)
    if creator_uid:
        where += " AND g.creator_uid = ?"
        params.append(creator_uid)
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"""SELECT strftime('{fmt}', g.created_at) AS bucket,
                       COUNT(*) AS count,
                       COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits
                FROM generation g
                LEFT JOIN generation_metrics m ON m.gen_id = g.id
                WHERE {where}
                GROUP BY bucket ORDER BY bucket""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def matrix() -> dict[str, Any]:
    """작업자 × 프로젝트 매트릭스 — 셀=건수·크레딧. 미분류 프로젝트는 pid='' 로 표기."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            """SELECT g.creator_uid AS uid, g.project_id AS pid, COUNT(*) AS count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      SUM(CASE WHEN g.is_final = 1 THEN 1 ELSE 0 END) AS final_count,
                      SUM(CASE WHEN EXISTS(
                            SELECT 1 FROM share s WHERE s.generation_id = g.id
                          ) THEN 1 ELSE 0 END) AS shared_count
               FROM generation g
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL
               GROUP BY g.creator_uid, g.project_id"""
        ).fetchall()
        uids = sorted({r["uid"] for r in rows if r["uid"]})
        names = resolve_display_names(conn, uids) if uids else {}
        pnames = {
            r["id"]: r["name"]
            for r in conn.execute("SELECT id, name FROM project").fetchall()
        }
    # 데이터에 등장한 프로젝트만(순서 보존), 미분류는 빈 키
    proj_order: list[str] = []
    seen: set[str] = set()
    cells: dict[str, dict[str, dict[str, Any]]] = {}
    for r in rows:
        u = r["uid"] or ""
        pkey = r["pid"] or ""
        cells.setdefault(u, {})[pkey] = {
            "count": r["count"],
            "credits": r["credits"],
            "shared_count": r["shared_count"] or 0,
            "final_count": r["final_count"] or 0,
        }
        if pkey not in seen:
            seen.add(pkey)
            proj_order.append(pkey)
    workers = [{"uid": u, "name": names.get(u) or u} for u in uids]
    if any((r["uid"] or "") == "" for r in rows):  # 작성자 미상 행도 한 줄로
        workers.append({"uid": "", "name": "미상"})
    projects = [
        {"pid": p, "name": (pnames.get(p) if p else "미분류") or p or "미분류"}
        for p in proj_order
    ]
    return {"workers": workers, "projects": projects, "cells": cells}


def breakdown(project_id: str) -> dict[str, Any]:
    """프로젝트 세부 분석 — (folder_path × 작업자)별 생성/게시/완료/크레딧 플랫 행.
    프론트가 이 하나로 ①작업자별 에피소드·시퀀스 기여 ②에피소드별 진척 ③시퀀스별 완료율 을 파생.
    folder_path 는 렌더루트 기준 상대경로(예 'ep001/c0010'); NULL/'' 는 미지정."""
    with get_connection() as conn:
        _ensure_schema(conn)
        raw = conn.execute(
            """SELECT COALESCE(g.folder_path, '') AS folder_path,
                      g.creator_uid AS uid, COUNT(*) AS count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      SUM(CASE WHEN g.is_final = 1 THEN 1 ELSE 0 END) AS final_count,
                      SUM(CASE WHEN EXISTS(
                            SELECT 1 FROM share s WHERE s.generation_id = g.id
                          ) THEN 1 ELSE 0 END) AS shared_count
               FROM generation g
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL AND g.project_id = ?
               GROUP BY g.folder_path, g.creator_uid""",
            (project_id,),
        ).fetchall()
        uids = sorted({r["uid"] for r in raw if r["uid"]})
        names = resolve_display_names(conn, uids) if uids else {}
    rows = []
    for r in raw:
        fp = r["folder_path"] or ""
        segs = [s for s in fp.split("/") if s]
        rows.append(
            {
                "folder_path": fp,
                "episode": segs[0] if segs else "(미지정)",
                "sequence": segs[1] if len(segs) > 1 else "",
                "uid": r["uid"] or "",
                "name": names.get(r["uid"] or "") or r["uid"] or "미상",
                "count": r["count"],
                "shared_count": r["shared_count"] or 0,
                "final_count": r["final_count"] or 0,
                "credits": r["credits"],
            }
        )
    return {"rows": rows}


# ── 실제 차감액(account transactions) 수집 + 매칭 (2b) ─────────────────────────
# 거래엔 잡 id 가 없어 (모델 시각이 아니라) **소유자+시각 최근접**으로 생성물에 귀속한다.
# 검증(PM_DASHBOARD_DESIGN.md §3): 같은 계정 안에서 거래 시각 ↔ 생성물 sort_ts 오차 <0.3초,
# 윈도우 밖(생성물 없는 옛 거래)은 미귀속으로 안전하게 남는다. 모델 표시명↔job_set_type 사전이
# 서버에 늘 있진 않으므로(공유 서버 CLI 부재) 모델 검증은 생략하고 시각+소유자로만 매칭한다.
_MATCH_WINDOW = 60.0  # 초 — 설계(§3) 기준값. 검증상 실제 매칭은 1초 이내, 비매칭은 수백 초라 여유 충분


def _epoch(iso: Optional[str]) -> Optional[float]:
    """거래 created_at(UTC ISO) → epoch. 생성물 sort_ts(UTC epoch)와 같은 축."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def record_transactions(
    owner_uid: Optional[str], account_email: Optional[str], txns: list[dict]
) -> dict[str, int]:
    """account transactions 를 credit_txn 에 적재(dedup) 후 매칭 실행.
    거래엔 고유 id 가 없어 (owner|created_at|credits|action|display_name) 해시를 PK 로 → 재수집 멱등."""
    if not txns:
        return {"inserted": 0, "matched": 0}
    inserted = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        # 적재 + 매칭을 한 트랜잭션으로 — 매칭 CAS 가 같은 커넥션·트랜잭션에서 돌아야
        # 동시 요청이 같은 미매칭 건을 이중 매칭하지 않는다.
        conn.execute("BEGIN IMMEDIATE")
        try:
            for t in txns:
                if not isinstance(t, dict):
                    continue
                created = t.get("created_at")
                credits = t.get("credits")
                action = t.get("action")
                dn = t.get("display_name")
                model = t.get("model")  # 에이전트가 display_name→job_set_type 변환해 태깅(옛 에이전트는 없음)
                raw = f"{owner_uid}|{created}|{credits}|{action}|{dn}"
                tid = hashlib.sha1(raw.encode("utf-8")).hexdigest()
                cur = conn.execute(
                    "INSERT OR IGNORE INTO credit_txn"
                    "(id, owner_uid, account_email, display_name, credits, action, created_at, model) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (tid, owner_uid, account_email, dn, credits, action, created, model),
                )
                inserted += cur.rowcount
            matched_ids = _match_transactions(conn, owner_uid)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    # T5: 실제 크레딧이 방금 채워진 생성물을 텔레메트리 재push 대상으로(이미 pushed 된 과거 잡의 크레딧
    # 보정 반영). 위 with(풀 커넥션)를 빠져나온 뒤 별도로 호출 — 커넥션 중첩 회피. best-effort.
    if matched_ids:
        try:
            mark_telemetry_dirty(matched_ids)
        except Exception:  # noqa: BLE001
            pass
    return {"inserted": inserted, "matched": len(matched_ids), "matched_ids": matched_ids}


def match_transactions(owner_uid: Optional[str]) -> int:
    """미귀속 spend 거래 ↔ 미측정 생성물을 (소유자+시각 최근접, 윈도우 내) 전역 그리디 매칭.
    한 거래는 한 생성물에만(역도 동일). 매칭되면 generation_metrics.real_credits(양수=사용액) 채우고
    credit_txn.matched_gen_id 표시. 반환: 새로 귀속한 건수."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            matched_ids = _match_transactions(conn, owner_uid)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    if matched_ids:
        try:
            mark_telemetry_dirty(matched_ids)
        except Exception:  # noqa: BLE001
            pass
    return len(matched_ids)


def _match_transactions(conn, owner_uid: Optional[str]) -> list[str]:
    """매칭 본문 — caller 가 BEGIN IMMEDIATE 를 연 뒤 같은 conn 으로 호출한다. 반환=방금 매칭된 gen id 목록.
    각 쌍은 SAVEPOINT + CAS(조건부 UPDATE)로 확정해, 동시 실행이 같은 거래/생성물을 이중 매칭하지 못하게 한다."""
    txns = conn.execute(
        "SELECT id, credits, created_at, owner_uid, model FROM credit_txn "
        "WHERE action='spend' AND matched_gen_id IS NULL "
        "AND (owner_uid IS ? OR ? IS NULL)",
        (owner_uid, owner_uid),
    ).fetchall()
    if not txns:
        return []
    gens = conn.execute(
        "SELECT g.id AS id, g.sort_ts AS sort_ts, g.creator_uid AS creator_uid, "
        "  g.model AS model FROM generation g "
        "LEFT JOIN generation_metrics m ON m.gen_id = g.id "
        "WHERE g.sort_ts IS NOT NULL AND g.deleted_at IS NULL "
        "AND (g.creator_uid = ? OR ? IS NULL) "
        "AND m.real_credits IS NULL",
        (owner_uid, owner_uid),
    ).fetchall()
    if not gens:
        return []

    # 후보쌍을 거리순 그리디로 확정. 각 거래는 시각 ±윈도우 안 생성물만 이분탐색으로 훑는다
    # → O(T·G) 전체쌍 대신 O(T·logG + 후보수)(누적 백필에서 반복비용 급증 방지).
    # 가드(둘 다 "양쪽 값을 다 알 때만" 스킵 → 미연결/옛 데이터는 시간매칭 폴백, 회귀 없음):
    #   (1)소유자 — 거래 owner_uid·생성물 creator_uid 둘 다 있고 다르면 스킵(전역 호출 시 남의 것 오염 차단).
    #   (2)모델 — 거래·생성물 양쪽 model 을 다 알고 다르면 스킵(옛 에이전트 NULL 이면 시간매칭 폴백).
    order = sorted(range(len(gens)), key=lambda gi: gens[gi]["sort_ts"])
    gts = [gens[gi]["sort_ts"] for gi in order]
    pairs: list[tuple[float, int, int]] = []
    tepochs = [_epoch(t["created_at"]) for t in txns]
    for ti, te in enumerate(tepochs):
        if te is None:
            continue
        t = txns[ti]
        lo = bisect.bisect_left(gts, te - _MATCH_WINDOW)
        hi = bisect.bisect_right(gts, te + _MATCH_WINDOW)
        for k in range(lo, hi):
            gi = order[k]
            g = gens[gi]
            if t["owner_uid"] and g["creator_uid"] and t["owner_uid"] != g["creator_uid"]:
                continue
            tm, gm = t["model"], g["model"]
            if tm and gm and tm != gm:
                continue
            pairs.append((abs(g["sort_ts"] - te), ti, gi))
    pairs.sort()
    used_t: set[int] = set()
    used_g: set[int] = set()
    matched_ids: list[str] = []
    for d, ti, gi in pairs:
        if ti in used_t or gi in used_g:
            continue
        t = txns[ti]
        g = gens[gi]
        credits = t["credits"]
        real = round(abs(credits)) if credits is not None else None  # 사용액=양수
        # 쌍 확정 — credit_txn 은 '아직 미매칭'일 때만(CAS), metrics 는 '아직 real_credits 비었을'
        # 때만. 하나라도 이미 다른 매처가 채웠으면 이 쌍 전체를 롤백(SAVEPOINT)하고 건너뛴다.
        conn.execute("SAVEPOINT match_pair")
        cur_txn = conn.execute(
            "UPDATE credit_txn SET matched_gen_id=? WHERE id=? AND matched_gen_id IS NULL",
            (g["id"], t["id"]),
        )
        if cur_txn.rowcount != 1:
            conn.execute("ROLLBACK TO match_pair")
            conn.execute("RELEASE match_pair")
            continue
        cur_m = conn.execute(
            "INSERT INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
            "VALUES(?,?, 'transaction', 1) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  real_credits=excluded.real_credits, credit_source='transaction', matched=1 "
            "  WHERE generation_metrics.real_credits IS NULL",
            (g["id"], real),
        )
        if cur_m.rowcount != 1:
            conn.execute("ROLLBACK TO match_pair")
            conn.execute("RELEASE match_pair")
            continue
        conn.execute("RELEASE match_pair")
        # 선점은 쌍이 실제로 확정된 뒤에 — CAS 가 실패해 건너뛴 거래/생성물은 다른 후보와
        # 매칭될 기회를 남긴다(동시 매칭 경계에서 덜 매칭되던 문제 방지).
        used_t.add(ti)
        used_g.add(gi)
        matched_ids.append(g["id"])  # T5: 실제 크레딧이 방금 채워진 생성물 — 텔레메트리 재push 대상
    return matched_ids


# ── 팀 매니징 텔레메트리 발신(manage-T2) ───────────────────────────────────────
# 로컬 outbox 는 '내 생성물 중 서버에 올려야 할 것'만 추적한다. 실제 팩트(메타)는 build 로 그때그때
# 로컬 generation+metrics 에서 뽑아 만든다(중복 저장 안 함). 드레이너(T3)가 이 함수들을 엮어 push 한다.


def mark_telemetry_dirty(gen_ids: list[str]) -> None:
    """내 생성물이 생기거나(프로젝트·폴더·상태·크레딧) 바뀌면 outbox 에 dirty 표시(멱등).
    사이드카라 코어 트랜잭션과 분리 — best-effort 로 호출(실패해도 코어 동작 무영향)."""
    ids = [g for g in (gen_ids or []) if g]
    if not ids:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        for gid in ids:
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at) "
                "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(local_gen_id) DO UPDATE SET "
                "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pushed_at=NULL, is_tombstone=0",
                (gid,),
            )


def mark_telemetry_tombstone(gen_id: str, snapshot: dict[str, Any]) -> None:
    """생성물이 삭제(휴지통 이동)됐다 — 서버 팩트를 is_deleted 로 넘길 tombstone 을 큐에 넣는다.
    생성물이 메인에서 사라져 build 로 팩트를 못 만들므로, 삭제 직전 스냅샷(비용·프로젝트·모델 포함)을
    JSON 으로 저장해 둔다. 서버에 아직 팩트가 없던(미전송) 생성물도 이 스냅샷으로 비용이 집계된다.
    같은 local_gen_id 의 대기 중 일반 push 는 tombstone 으로 덮인다(삭제가 최종 상태)."""
    if not gen_id:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO telemetry_outbox"
            "(local_gen_id, dirty_at, is_tombstone, tomb_job_id, tomb_creator_uid, tomb_snapshot) "
            "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, ?, ?, ?) "
            "ON CONFLICT(local_gen_id) DO UPDATE SET "
            "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pushed_at=NULL, is_tombstone=1, "
            "tomb_job_id=excluded.tomb_job_id, tomb_creator_uid=excluded.tomb_creator_uid, "
            "tomb_snapshot=excluded.tomb_snapshot",
            (gen_id, snapshot.get("job_id"), snapshot.get("creator_uid"),
             json.dumps(snapshot, ensure_ascii=False)),
        )


def mark_ingested_dirty(job_ids: list[str], my_uid: Optional[str]) -> int:
    """적재된 잡(job_id)들을 내 로컬 generation.id 로 역매핑해 outbox 에 dirty 표시. 반환=표시 수.
    동기화본은 id==job_id, placeholder 채움본은 job_id 로 매칭 → (id IN OR job_id IN) 둘 다 커버.
    my_uid 지정 시 내 생성물만(남의 공유본 제외)."""
    ids = [j for j in (job_ids or []) if j]
    if not ids:
        return 0
    ph = ",".join("?" for _ in ids)
    where = f"(id IN ({ph}) OR job_id IN ({ph}))"
    args: list[Any] = ids + ids
    if my_uid:
        where += " AND creator_uid = ?"
        args.append(my_uid)
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"SELECT id FROM generation WHERE {where} AND deleted_at IS NULL", args
        ).fetchall()
        local_ids = [r["id"] for r in rows]
        for gid in local_ids:
            conn.execute(
                "INSERT INTO telemetry_outbox(local_gen_id, dirty_at) "
                "VALUES(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(local_gen_id) DO UPDATE SET "
                "dirty_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pushed_at=NULL, is_tombstone=0",
                (gid,),
            )
    return len(local_ids)


def list_dirty_telemetry(limit: int = 200) -> list[dict[str, Any]]:
    """push 가 필요한 항목 목록 [{local_gen_id, dirty_at}] (pushed_at IS NULL). 오래된 것 먼저.
    dirty_at 을 함께 반환 — 드레이너가 mark_telemetry_pushed 에 되돌려 CAS(그 사이 재dirty 된 건 안
    비움) 하기 위함."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT local_gen_id, dirty_at, is_tombstone, tomb_job_id, tomb_creator_uid, tomb_snapshot "
            "FROM telemetry_outbox WHERE pushed_at IS NULL ORDER BY dirty_at ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def build_telemetry_facts(
    gen_ids: Optional[list[str]] = None, my_uid: Optional[str] = None
) -> list[dict[str, Any]]:
    """로컬 generation+metrics 에서 매니징 팩트(메타만)를 만든다. 프롬프트·미디어·레퍼런스 제외.
    my_uid 지정 시 '내 생성물'만(남의 공유본은 팀 팩트로 안 올림). gen_ids 지정 시 그 집합만."""
    where = ["g.deleted_at IS NULL"]
    args: list[Any] = []
    if my_uid:
        where.append("g.creator_uid = ?")
        args.append(my_uid)
    if gen_ids is not None:
        ids = [g for g in gen_ids if g]
        if not ids:
            return []
        where.append(f"g.id IN ({','.join('?' for _ in ids)})")
        args.extend(ids)
    sql = (
        "SELECT g.id AS local_gen_id, g.job_id, g.creator_uid, c.name AS creator_name, "
        "g.project_id, p.name AS project_name, g.folder_path, g.model, "
        "(SELECT a.type FROM asset a WHERE a.generation_id=g.id LIMIT 1) AS output_type, "
        "g.status, g.created_at, g.sort_ts, g.is_final, "
        "(CASE WHEN EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) THEN 1 ELSE 0 END) AS is_shared, "
        "m.real_credits, m.est_credits, m.credit_source, m.elapsed_seconds, "
        "m.started_at, m.completed_at "
        "FROM generation g "
        "LEFT JOIN generation_metrics m ON m.gen_id=g.id "
        "LEFT JOIN creator c ON c.uid=g.creator_uid "
        "LEFT JOIN project p ON p.id=g.project_id "
        f"WHERE {' AND '.join(where)}"
    )
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(sql, args).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        d["is_final"] = bool(d.get("is_final"))
        d["is_shared"] = bool(d.get("is_shared"))
        d["is_deleted"] = False
        d["deleted_at"] = None
        out.append(d)
    return out


def mark_telemetry_pushed(items: list[dict[str, Any]]) -> None:
    """push 성공한 항목에 pushed_at 을 찍는다(재푸시 대상에서 빠짐).
    ★CAS(코덱스): list_dirty 때 읽은 dirty_at 과 지금 dirty_at 이 같을 때만 비운다. drain 도중
    프로젝트·공유·최종이 바뀌어 재dirty(dirty_at 갱신+pushed_at=NULL) 됐다면 이 UPDATE 는 매칭되지
    않아 큐에 남는다 → 그 변경이 유실되지 않고 다음 drain 에 다시 전송된다.
    items = list_dirty_telemetry 가 준 [{local_gen_id, dirty_at}] 그대로."""
    with get_connection() as conn:
        _ensure_schema(conn)
        for it in items or []:
            gid = it.get("local_gen_id")
            if not gid:
                continue
            conn.execute(
                "UPDATE telemetry_outbox SET pushed_at=datetime('now'), "
                "attempts=attempts+1, last_error=NULL "
                "WHERE local_gen_id=? AND dirty_at=? AND pushed_at IS NULL",
                (gid, it.get("dirty_at")),
            )


def mark_telemetry_failed(gen_ids: list[str], err: str) -> None:
    """push 실패 기록(재시도 카운트+오류). pushed_at 은 그대로 두어 다음에 다시 대상이 된다."""
    ids = [g for g in (gen_ids or []) if g]
    if not ids:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        for gid in ids:
            conn.execute(
                "UPDATE telemetry_outbox SET attempts=attempts+1, last_error=? "
                "WHERE local_gen_id=?",
                (err[:500], gid),
            )
