"""PM 대시보드(매니징먼트) 데이터 접근 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 모든 데이터를 **별도 테이블**에 둔다 —
코어(generation·project)는 한 글자도 안 건드린다. 테이블은 이 모듈이 첫 호출 때
`CREATE TABLE IF NOT EXISTS` 로 직접 만든다(db.py·schema.sql 무수정).

기능 비활성(CONTENT_HUB_MANAGE off)이면 main.py 가 이 모듈을 import 하지 않으므로
테이블조차 생성되지 않는다 → 완전 제거 가능(사이드카 테이블 DROP 한 번이면 흔적 0).
"""

from __future__ import annotations

import hashlib
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
        matched_gen_id TEXT                  -- 귀속한 생성물(NULL=미귀속)
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
    "CREATE INDEX IF NOT EXISTS idx_credit_txn_owner ON credit_txn(owner_uid, created_at)",
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
    for col in ("sequence", "description"):
        if col not in cols:
            conn.execute(f"ALTER TABLE project_task ADD COLUMN {col} TEXT")
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
                      COALESCE(SUM(m.real_credits), 0) AS real_credits,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                      COUNT(m.gen_id) AS metric_count,
                      COALESCE(SUM(m.elapsed_seconds), 0) AS elapsed_total
               FROM generation g
               LEFT JOIN project p ON p.id = g.project_id
               LEFT JOIN generation_metrics m ON m.gen_id = g.id
               WHERE g.deleted_at IS NULL
               GROUP BY g.project_id
               ORDER BY gen_count DESC"""
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
                      (SELECT a.type FROM asset a WHERE a.generation_id = g.id LIMIT 1) AS asset_type
               FROM generation g
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

    projects = []
    for r in proj:
        d = dict(r)
        d["name"] = d["name"] or ("미분류" if d["pid"] is None else d["pid"])
        d["planning"] = planning.get(d["pid"])
        d["types"] = type_by_pid.get(d["pid"], {k: 0 for k in _TYPE_KEYS})
        d["video_seconds"] = round(dur_by_pid.get(d["pid"], 0.0), 1)
        projects.append(d)
    worker_list = []
    for w in workers:
        d = dict(w)
        d["name"] = names.get(w["uid"]) or ("미상" if not w["uid"] else w["uid"])
        worker_list.append(d)

    io = {r["action"]: r["amt"] for r in io_rows}
    totals = {
        "gen_count": sum(p["gen_count"] for p in projects),
        "done_count": sum(p["done_count"] for p in projects),
        "credits": sum(p["credits"] for p in projects),
        "real_credits": sum(p["real_credits"] for p in projects),
        "elapsed_total": sum(p["elapsed_total"] for p in projects),
        "metric_count": sum(p["metric_count"] for p in projects),
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
        "agents": _agent_versions(),
    }


def _agent_versions() -> list[dict[str, Any]]:
    """계정(에이전트)별 CLI 버전·플랜·잔액 — 팀 CLI 버전 skew 진단용. 에이전트가 account status
    올릴 때 함께 보고한 cli_version(hf_status:*)을 모은다(이미 수집된 데이터 활용)."""
    from .identity import list_account_statuses

    out: list[dict[str, Any]] = []
    try:
        statuses = list_account_statuses()
    except Exception:  # noqa: BLE001
        return []
    for email, st in (statuses or {}).items():
        if not isinstance(st, dict):
            continue
        out.append(
            {
                "label": email.split("@")[0] if email else "?",
                "cli_version": st.get("cli_version"),
                "plan": st.get("plan") or st.get("subscription_plan_type"),
                "credits": st.get("credits"),
            }
        )
    return sorted(out, key=lambda a: a["label"])


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


def _task_gen_rows(conn, tid: str, project_id: str, sequence: Optional[str]):
    """작업에 귀속된 생성물 — ① 시퀀스(전역 태그명) 자동 귀속 ∪ ② 수동 드래그 링크(task_generation).
    정렬은 최종(is_final) → 공유(share) → 일반, 각 최신순(sort_ts DESC). 한 생성물이 여러 경로로
    잡혀도 DISTINCT(g.id)로 1번만. linked=수동 링크 여부(✕ 해제 가능 표시용)."""
    seq = (sequence or "").strip() or None
    return conn.execute(
        "SELECT g.id AS id, g.status AS status, g.creator_uid AS creator_uid, "
        "  g.is_final AS is_final, "
        "  EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared, "
        "  EXISTS(SELECT 1 FROM task_generation tg WHERE tg.task_id=? AND tg.gen_id=g.id) AS linked, "
        "  (SELECT COALESCE(a.thumbnail_path, a.file_path) FROM asset a "
        "   WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS thumb "
        "FROM generation g "
        "WHERE g.deleted_at IS NULL AND ("
        "   g.id IN (SELECT gen_id FROM task_generation WHERE task_id=?) "
        "   OR (? IS NOT NULL AND g.project_id=? AND g.id IN ("
        "        SELECT gat.generation_id FROM gen_auto_tag gat "
        "        JOIN auto_tag at ON at.id=gat.auto_tag_id WHERE at.name=?)) "
        ") "
        "ORDER BY g.is_final DESC, shared DESC, g.sort_ts DESC",
        (tid, tid, seq, project_id, seq),
    ).fetchall()


def list_tasks(project_id: str) -> list[dict[str, Any]]:
    """작업 목록 + 귀속 생성물 파생(컷 썸네일·생성자·크레딧·제작시간·코멘트수).
    귀속=시퀀스(전역 태그) 자동 ∪ 수동 링크. 보드/테이블/캘린더가 같은 이 데이터를 쓴다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT * FROM project_task WHERE project_id=? "
            "ORDER BY COALESCE(sort_order, 1000000), created_at",
            (project_id,),
        ).fetchall()
        out = []
        all_creator_uids: set[str] = set()
        per_task_cuts: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            tid = r["id"]
            gens = [dict(c) for c in _task_gen_rows(conn, tid, project_id, r["sequence"])]
            per_task_cuts[tid] = gens
            gen_ids = [g["id"] for g in gens]
            for g in gens:
                if g["creator_uid"]:
                    all_creator_uids.add(g["creator_uid"])
            # 크레딧·제작시간·코멘트 — 귀속 생성물 집합에서 합산.
            if gen_ids:
                ph = ",".join("?" * len(gen_ids))
                agg = conn.execute(
                    f"SELECT COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)),0) AS credits, "
                    f"  COALESCE(SUM(m.elapsed_seconds),0) AS elapsed "
                    f"FROM generation_metrics m WHERE m.gen_id IN ({ph})",
                    gen_ids,
                ).fetchone()
                cc = conn.execute(
                    f"SELECT COUNT(*) FROM generation_comment WHERE gen_id IN ({ph})",
                    gen_ids,
                ).fetchone()[0]
                credits, elapsed = agg["credits"], agg["elapsed"]
            else:
                credits, elapsed, cc = 0, 0, 0
            d = dict(r)
            d["gen_count"] = len(gen_ids)
            d["credits"] = credits
            d["elapsed"] = elapsed
            d["comment_count"] = cc
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
def timeseries(bucket: str = "day") -> list[dict[str, Any]]:
    """일/주별 생성수·크레딧 추이. 크레딧=COALESCE(실제,견적). created_at(UTC 문자열) 기준."""
    fmt = "%Y-%W" if bucket == "week" else "%Y-%m-%d"
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            f"""SELECT strftime('{fmt}', g.created_at) AS bucket,
                       COUNT(*) AS count,
                       COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits
                FROM generation g
                LEFT JOIN generation_metrics m ON m.gen_id = g.id
                WHERE g.deleted_at IS NULL AND g.created_at IS NOT NULL
                GROUP BY bucket ORDER BY bucket"""
        ).fetchall()
    return [dict(r) for r in rows]


def matrix() -> dict[str, Any]:
    """작업자 × 프로젝트 매트릭스 — 셀=건수·크레딧. 미분류 프로젝트는 pid='' 로 표기."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            """SELECT g.creator_uid AS uid, g.project_id AS pid, COUNT(*) AS count,
                      COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits
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
        cells.setdefault(u, {})[pkey] = {"count": r["count"], "credits": r["credits"]}
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


# ── 실제 차감액(account transactions) 수집 + 매칭 (2b) ─────────────────────────
# 거래엔 잡 id 가 없어 (모델 시각이 아니라) **소유자+시각 최근접**으로 생성물에 귀속한다.
# 검증(PM_DASHBOARD_DESIGN.md §3): 같은 계정 안에서 거래 시각 ↔ 생성물 sort_ts 오차 <0.3초,
# 윈도우 밖(생성물 없는 옛 거래)은 미귀속으로 안전하게 남는다. 모델 표시명↔job_set_type 사전이
# 서버에 늘 있진 않으므로(공유 서버 CLI 부재) 모델 검증은 생략하고 시각+소유자로만 매칭한다.
_MATCH_WINDOW = 90.0  # 초 — 검증상 실제 매칭은 1초 이내, 비매칭은 수백 초라 분리 여유 충분


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
        for t in txns:
            if not isinstance(t, dict):
                continue
            created = t.get("created_at")
            credits = t.get("credits")
            action = t.get("action")
            dn = t.get("display_name")
            raw = f"{owner_uid}|{created}|{credits}|{action}|{dn}"
            tid = hashlib.sha1(raw.encode("utf-8")).hexdigest()
            cur = conn.execute(
                "INSERT OR IGNORE INTO credit_txn"
                "(id, owner_uid, account_email, display_name, credits, action, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (tid, owner_uid, account_email, dn, credits, action, created),
            )
            inserted += cur.rowcount
    matched = match_transactions(owner_uid)
    return {"inserted": inserted, "matched": matched}


def match_transactions(owner_uid: Optional[str]) -> int:
    """미귀속 spend 거래 ↔ 미측정 생성물을 (소유자+시각 최근접, 윈도우 내) 전역 그리디 매칭.
    한 거래는 한 생성물에만(역도 동일). 매칭되면 generation_metrics.real_credits(양수=사용액) 채우고
    credit_txn.matched_gen_id 표시. 반환: 새로 귀속한 건수."""
    with get_connection() as conn:
        _ensure_schema(conn)
        txns = conn.execute(
            "SELECT id, credits, created_at FROM credit_txn "
            "WHERE action='spend' AND matched_gen_id IS NULL "
            "AND (owner_uid IS ? OR ? IS NULL)",
            (owner_uid, owner_uid),
        ).fetchall()
        if not txns:
            return 0
        gens = conn.execute(
            "SELECT g.id AS id, g.sort_ts AS sort_ts FROM generation g "
            "LEFT JOIN generation_metrics m ON m.gen_id = g.id "
            "WHERE g.sort_ts IS NOT NULL AND g.deleted_at IS NULL "
            "AND (g.creator_uid = ? OR ? IS NULL) "
            "AND m.real_credits IS NULL",
            (owner_uid, owner_uid),
        ).fetchall()
        if not gens:
            return 0

        # (거리, 거래idx, 생성물idx) 전 쌍 중 윈도우 내만 모아 거리순 그리디 — 가장 가까운 쌍부터 확정.
        pairs: list[tuple[float, int, int]] = []
        tepochs = [_epoch(t["created_at"]) for t in txns]
        for ti, te in enumerate(tepochs):
            if te is None:
                continue
            for gi, g in enumerate(gens):
                d = abs(g["sort_ts"] - te)
                if d <= _MATCH_WINDOW:
                    pairs.append((d, ti, gi))
        pairs.sort()
        used_t: set[int] = set()
        used_g: set[int] = set()
        applied = 0
        for d, ti, gi in pairs:
            if ti in used_t or gi in used_g:
                continue
            used_t.add(ti)
            used_g.add(gi)
            t = txns[ti]
            g = gens[gi]
            credits = t["credits"]
            real = round(abs(credits)) if credits is not None else None  # 사용액=양수
            conn.execute(
                "INSERT INTO generation_metrics(gen_id, real_credits, credit_source, matched) "
                "VALUES(?,?, 'transaction', 1) "
                "ON CONFLICT(gen_id) DO UPDATE SET "
                "  real_credits=excluded.real_credits, credit_source='transaction', matched=1",
                (g["id"], real),
            )
            conn.execute(
                "UPDATE credit_txn SET matched_gen_id=? WHERE id=?", (g["id"], t["id"])
            )
            applied += 1
        return applied
