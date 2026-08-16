"""PM 대시보드(매니징먼트) 데이터 접근 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 모든 데이터를 **별도 테이블**에 둔다 —
코어(generation·project)는 한 글자도 안 건드린다. 테이블은 이 모듈이 첫 호출 때
`CREATE TABLE IF NOT EXISTS` 로 직접 만든다(db.py·schema.sql 무수정).

기능 비활성(CONTENT_HUB_MANAGE off)이면 main.py 가 이 모듈을 import 하지 않으므로
테이블조차 생성되지 않는다 → 완전 제거 가능(사이드카 테이블 DROP 한 번이면 흔적 0).
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from .identity import resolve_display_names
from .manage_schema import _SCHEMA_ENSURED, _ensure_schema
from .manage_tasks import (
    _batch_task_gen_rows,
    _task_gen_rows,
    add_assignment,
    bulk_delete_tasks,
    bulk_set_assignments,
    bulk_update_task_orders,
    create_task,
    delete_task,
    is_assignee,
    list_tasks,
    list_tasks_batch,
    remove_assignment,
    sync_folder_tasks,
    task_projects,
    task_project_id,
    update_task,
)
from .manage_analytics import breakdown, matrix, timeseries
from .manage_transactions import (
    _MATCH_WINDOW,
    _epoch,
    _match_transactions,
    record_transactions,
)
from .manage_telemetry import (
    account_emails_by_creator_uids,
    build_telemetry_facts,
    ensure_ingested_tracked,
    list_dirty_telemetry,
    mark_ingested_dirty,
    mark_telemetry_dirty,
    mark_telemetry_failed,
    mark_telemetry_pushed,
    mark_telemetry_tombstone,
    telemetry_outbox_status,
)


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


def _project_model_breakdowns(
    conn,
    project_ids: Optional[list[str]] = None,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    """프로젝트별 모델 집계와 현재 예산 주기 모델 집계를 한 번씩 조회한다."""
    params: list[str] = []
    project_filter = ""
    if project_ids is not None:
        if not project_ids:
            return {}, {}
        marks = ",".join("?" for _ in project_ids)
        project_filter = f" AND g.project_id IN ({marks})"
        params = project_ids

    columns = """g.project_id AS pid,
                 COALESCE(NULLIF(TRIM(g.model), ''), '알 수 없음') AS model,
                 COUNT(*) AS count,
                 COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                 SUM(CASE WHEN g.is_final=1 THEN 1 ELSE 0 END) AS final_count"""
    # 삭제(휴지통)된 생성물도 포함 — 크레딧은 이미 소진됐으므로 사용량·예산에서 빼면
    # "쓰고 지우면 예산이 줄어드는" 구멍이 생긴다(manage_hub 팩트 집계와 같은 철학).
    all_rows = conn.execute(
        f"""SELECT {columns}
            FROM generation g
            LEFT JOIN generation_metrics m ON m.gen_id = g.id
            WHERE 1=1{project_filter}
            GROUP BY g.project_id, COALESCE(NULLIF(TRIM(g.model), ''), '알 수 없음')
            ORDER BY credits DESC, count DESC, model COLLATE NOCASE""",
        params,
    ).fetchall()
    period_rows = conn.execute(
        f"""SELECT {columns}
            FROM generation g
            JOIN project_planning pp ON pp.project_id = g.project_id
            LEFT JOIN generation_metrics m ON m.gen_id = g.id
            WHERE g.created_at IS NOT NULL{project_filter}
              AND CASE COALESCE(pp.budget_period, 'month')
                WHEN 'day' THEN
                  date(g.created_at, 'localtime') = date('now', 'localtime')
                WHEN 'week' THEN
                  date(g.created_at, 'localtime', 'weekday 0', '-6 days') =
                  date('now', 'localtime', 'weekday 0', '-6 days')
                ELSE
                  strftime('%Y-%m', g.created_at, 'localtime') =
                  strftime('%Y-%m', 'now', 'localtime')
              END
            GROUP BY g.project_id, COALESCE(NULLIF(TRIM(g.model), ''), '알 수 없음')
            ORDER BY credits DESC, count DESC, model COLLATE NOCASE""",
        params,
    ).fetchall()

    def grouped(rows) -> dict[str, list[dict[str, Any]]]:
        result: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            pid = row["pid"]
            if not pid:
                continue
            result.setdefault(pid, []).append(
                {
                    "model": row["model"],
                    "count": row["count"] or 0,
                    "credits": row["credits"] or 0,
                    "final_count": row["final_count"] or 0,
                }
            )
        return result

    return grouped(all_rows), grouped(period_rows)


def _project_folder_breakdowns(
    conn,
    project_ids: Optional[list[str]] = None,
) -> dict[str, list[dict[str, Any]]]:
    """프로젝트의 등록 폴더와 실제 생성물을 합쳐 시퀀스별 사용량을 만든다."""
    params: list[str] = []
    task_filter = ""
    generation_filter = ""
    if project_ids is not None:
        if not project_ids:
            return {}
        marks = ",".join("?" for _ in project_ids)
        task_filter = f" AND pt.project_id IN ({marks})"
        generation_filter = f" AND g.project_id IN ({marks})"
        params = project_ids

    def normalized(value: Optional[str]) -> str:
        path = (value or "").strip().replace("\\", "/").strip("/")
        return path or "(폴더 미지정)"

    by_project: dict[str, dict[str, dict[str, Any]]] = {}

    # 폴더 스캔으로 만든 자동 작업을 먼저 넣어 생성물이 0개인 시퀀스도 구조에 남긴다.
    task_rows = conn.execute(
        f"""SELECT pt.project_id AS pid, pt.folder_path
            FROM project_task pt
            WHERE pt.folder_path IS NOT NULL AND TRIM(pt.folder_path) <> ''{task_filter}
            ORDER BY pt.project_id, pt.folder_path COLLATE NOCASE""",
        params,
    ).fetchall()
    for row in task_rows:
        pid = row["pid"]
        if not pid:
            continue
        path = normalized(row["folder_path"])
        by_project.setdefault(pid, {}).setdefault(
            path,
            {
                "folder_path": path,
                "count": 0,
                "final_count": 0,
                "credits": 0,
                "elapsed_seconds": 0,
                "created_start": None,
                "created_end": None,
                "_models": {},
                "_members": {},
            },
        )

    generation_rows = conn.execute(
        f"""SELECT g.project_id AS pid, g.folder_path, g.creator_uid,
                   COALESCE(NULLIF(TRIM(g.model), ''), '알 수 없음') AS model,
                   COUNT(*) AS count,
                   SUM(CASE WHEN g.is_final=1 THEN 1 ELSE 0 END) AS final_count,
                   COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                   COALESCE(SUM(m.elapsed_seconds), 0) AS elapsed_seconds,
                   MIN(g.created_at) AS created_start,
                   MAX(g.created_at) AS created_end
            FROM generation g
            LEFT JOIN generation_metrics m ON m.gen_id = g.id
            WHERE 1=1{generation_filter}
            GROUP BY g.project_id, g.folder_path, g.creator_uid,
                     COALESCE(NULLIF(TRIM(g.model), ''), '알 수 없음')
            ORDER BY g.project_id, g.folder_path COLLATE NOCASE, credits DESC""",
        params,
    ).fetchall()
    creator_uids = {row["creator_uid"] for row in generation_rows if row["creator_uid"]}
    creator_names = resolve_display_names(conn, creator_uids) if creator_uids else {}
    for row in generation_rows:
        pid = row["pid"]
        if not pid:
            continue
        path = normalized(row["folder_path"])
        folder = by_project.setdefault(pid, {}).setdefault(
            path,
            {
                "folder_path": path,
                "count": 0,
                "final_count": 0,
                "credits": 0,
                "elapsed_seconds": 0,
                "created_start": None,
                "created_end": None,
                "_models": {},
                "_members": {},
            },
        )
        count = row["count"] or 0
        final_count = row["final_count"] or 0
        credits = row["credits"] or 0
        elapsed = row["elapsed_seconds"] or 0
        folder["count"] += count
        folder["final_count"] += final_count
        folder["credits"] += credits
        folder["elapsed_seconds"] += elapsed
        start = row["created_start"]
        end = row["created_end"]
        if start and (not folder["created_start"] or start < folder["created_start"]):
            folder["created_start"] = start
        if end and (not folder["created_end"] or end > folder["created_end"]):
            folder["created_end"] = end

        model = folder["_models"].setdefault(
            row["model"],
            {
                "model": row["model"],
                "count": 0,
                "credits": 0,
                "final_count": 0,
                "elapsed_seconds": 0,
            },
        )
        model["count"] += count
        model["credits"] += credits
        model["final_count"] += final_count
        model["elapsed_seconds"] += elapsed

        creator_uid = row["creator_uid"]
        if creator_uid:
            member = folder["_members"].setdefault(
                creator_uid,
                {
                    "uid": creator_uid,
                    "name": creator_names.get(creator_uid) or "팀원",
                    "count": 0,
                    "credits": 0,
                    "final_count": 0,
                },
            )
            member["count"] += count
            member["credits"] += credits
            member["final_count"] += final_count

    result: dict[str, list[dict[str, Any]]] = {}
    for pid, folders in by_project.items():
        rows: list[dict[str, Any]] = []
        for folder in folders.values():
            models = sorted(
                folder.pop("_models").values(),
                key=lambda item: (-item["credits"], -item["count"], item["model"].lower()),
            )
            members = sorted(
                folder.pop("_members").values(),
                key=lambda item: (-item["count"], item["name"].lower()),
            )
            folder["models"] = models
            folder["members"] = members
            rows.append(folder)
        result[pid] = sorted(
            rows,
            key=lambda item: (
                item["folder_path"] == "(폴더 미지정)",
                item["folder_path"].lower(),
            ),
        )
    return result


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
               GROUP BY g.creator_uid
               ORDER BY gen_count DESC"""
        ).fetchall()
        uids = [w["uid"] for w in workers if w["uid"]]
        names = resolve_display_names(conn, uids) if uids else {}
        planning = {
            r["project_id"]: dict(r)
            for r in conn.execute("SELECT * FROM project_planning").fetchall()
        }
        project_models, budget_models = _project_model_breakdowns(conn)
        project_folders = _project_folder_breakdowns(conn)
        # 예산은 프로젝트 누적이 아니라 설정된 현재 일/주/월 모델 사용량 합과 비교한다.
        budget_usage = {
            pid: sum(row["credits"] for row in rows)
            for pid, rows in budget_models.items()
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
               ) a ON a.generation_id = g.id"""
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
            "budget_used_credits": budget_usage.get(pid, 0),
            "models": project_models.get(pid, []),
            "budget_models": budget_models.get(pid, []),
            "folders": project_folders.get(pid, []),
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


def project_dashboard_summary(project_ids: list[str]) -> dict[str, Any]:
    """접근 가능한 프로젝트의 작업 현황에 필요한 최소 집계만 반환한다.

    전사 작업자·워크스페이스 통계는 의도적으로 읽지 않는다. 호출측이 멤버십으로 허용된
    project_ids만 넘기며, 이 함수도 SQL 범위를 해당 id로 한정해 일반 멤버 요청이 전사
    데이터 집계 비용이나 노출 경로로 이어지지 않게 한다.
    """
    ids = list(dict.fromkeys(pid for pid in project_ids if pid))
    if not ids:
        return {"projects": []}

    marks = ",".join("?" for _ in ids)
    with get_connection() as conn:
        _ensure_schema(conn)
        registry = conn.execute(
            f"SELECT id, name FROM project WHERE archived=0 AND id IN ({marks}) "
            "ORDER BY COALESCE(sort_order, 1000000), created_at",
            ids,
        ).fetchall()
        stats = conn.execute(
            f"""SELECT g.project_id AS pid,
                       COUNT(*) AS gen_count,
                       SUM(CASE WHEN g.status='done' THEN 1 ELSE 0 END) AS done_count,
                       SUM(CASE WHEN g.is_final=1 THEN 1 ELSE 0 END) AS final_count,
                       SUM(CASE WHEN s.generation_id IS NOT NULL THEN 1 ELSE 0 END) AS shared_count,
                       COALESCE(SUM(m.real_credits), 0) AS real_credits,
                       COALESCE(SUM(COALESCE(m.real_credits, m.est_credits)), 0) AS credits,
                       COUNT(m.gen_id) AS metric_count,
                       COALESCE(SUM(m.elapsed_seconds), 0) AS elapsed_total
                FROM generation g
                LEFT JOIN generation_metrics m ON m.gen_id = g.id
                LEFT JOIN share s ON s.generation_id = g.id
                WHERE g.project_id IN ({marks})
                GROUP BY g.project_id""",
            ids,
        ).fetchall()
        planning = {
            row["project_id"]: dict(row)
            for row in conn.execute(
                f"SELECT * FROM project_planning WHERE project_id IN ({marks})", ids
            ).fetchall()
        }
        project_models, budget_models = _project_model_breakdowns(conn, ids)
        project_folders = _project_folder_breakdowns(conn, ids)
        budget_usage = {
            pid: sum(row["credits"] for row in rows)
            for pid, rows in budget_models.items()
        }

    stats_by_pid = {row["pid"]: row for row in stats}
    projects: list[dict[str, Any]] = []
    for project in registry:
        pid = project["id"]
        row = stats_by_pid.get(pid)
        projects.append(
            {
                "pid": pid,
                "name": project["name"] or pid,
                "gen_count": row["gen_count"] if row else 0,
                "done_count": row["done_count"] if row else 0,
                "shared_count": row["shared_count"] if row else 0,
                "final_count": row["final_count"] if row else 0,
                "real_credits": row["real_credits"] if row else 0,
                "credits": row["credits"] if row else 0,
                "budget_used_credits": budget_usage.get(pid, 0),
                "models": project_models.get(pid, []),
                "budget_models": budget_models.get(pid, []),
                "folders": project_folders.get(pid, []),
                "metric_count": row["metric_count"] if row else 0,
                "elapsed_total": row["elapsed_total"] if row else 0,
                "planning": planning.get(pid),
            }
        )
    return {"projects": projects}


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
    budget_period: Optional[str] = None,
    note: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트 일정/예산 upsert. project_planning 사이드카만 건드린다(코어 project 무수정)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        # 구버전 클라이언트는 budget_period를 보내지 않는다. 기존 설정은 보존하고,
        # 최초 저장일 때만 매월을 기본값으로 사용한다.
        if budget_period not in {"day", "week", "month"}:
            existing = conn.execute(
                "SELECT budget_period FROM project_planning WHERE project_id=?", (pid,)
            ).fetchone()
            budget_period = (
                existing["budget_period"]
                if existing and existing["budget_period"] in {"day", "week", "month"}
                else "month"
            )
        conn.execute(
            """INSERT INTO project_planning
                   (project_id, status, start_date, due_date, budget_credits, budget_period, note)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(project_id) DO UPDATE SET
                   status=excluded.status, start_date=excluded.start_date,
                   due_date=excluded.due_date, budget_credits=excluded.budget_credits,
                   budget_period=excluded.budget_period, note=excluded.note""",
            (pid, status, start_date, due_date, budget_credits, budget_period, note),
        )
        return dict(
            conn.execute(
                "SELECT * FROM project_planning WHERE project_id=?", (pid,)
            ).fetchone()
        )


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


def record_export(gen_id: str, dest_path: str, project_id: Optional[str] = None) -> None:
    """저장 대장에 기록(멱등) — 목적지 경로·시각 갱신. project_id 는 위임 모드 이력 조회의
    권위 키(팀원 생성물은 로컬 generation 조인이 불가) — 신코드는 항상 채운다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO final_export(gen_id, dest_path, project_id, exported_at) "
            "VALUES(?,?,?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  dest_path=excluded.dest_path, exported_at=excluded.exported_at, "
            "  project_id=COALESCE(excluded.project_id, final_export.project_id)",
            (gen_id, dest_path, project_id),
        )


def list_exports(project_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """이 프로젝트의 저장 이력(대장) — 최근 limit 개만. dest 파일 존재 확인(UNC stat)은
    라우터가 이 범위에서만 수행한다(이력이 쌓여도 네트워크 stat 폭주 방지).
    project_id 컬럼 우선, 옛 행(NULL)은 generation 조인 폴백 — 위임 모드 팀원 생성물 이력 보존."""
    with get_connection() as conn:
        _ensure_schema(conn)
        rows = conn.execute(
            "SELECT fe.gen_id, fe.dest_path, fe.exported_at FROM final_export fe "
            "LEFT JOIN generation g ON g.id=fe.gen_id "
            "WHERE (fe.project_id=?) "
            "   OR (fe.project_id IS NULL AND g.project_id=? AND g.deleted_at IS NULL) "
            "ORDER BY fe.exported_at DESC LIMIT ?",
            (project_id, project_id, limit),
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


def record_elapsed(gen_id: str, seconds: float) -> None:
    """실행 소요시간(초)을 측정값으로 직접 기록 — started/completed 타임스탬프가 아니라.
    Comfy 처럼 generation 이 완료 후 저장되는 경우: 프론트가 '실행 누른→결과 나온' 시각을 재서 넘긴다.
    (기존 힉스필드 허브 생성은 record_started→record_completed 로 계산. 이건 그 자리에 값만 채운다.)"""
    if seconds is None or seconds < 0:
        return
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, elapsed_seconds) VALUES(?,?) "
            "ON CONFLICT(gen_id) DO UPDATE SET elapsed_seconds=excluded.elapsed_seconds",
            (gen_id, float(seconds)),
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


# ── 영구 삭제 시 사이드카 고아 정리 ──────────────────────────────────────────
def purge_generation_sidecar(gen_id: str) -> None:
    """생성물이 '영구 삭제'(휴지통 purge)될 때 남는 사이드카 고아 행 정리 — generation_metrics·
    task_generation·final_export(모두 gen_id 키). 이 행들은 메인/휴지통 어디에도 대응 생성물이 없어
    LEFT JOIN 에서 영영 안 잡히며 무한 누적된다(영구삭제만 해당 — 휴지통 이동 땐 복원용으로 보존).
    ★telemetry_outbox 는 건드리지 않는다 — 삭제 tombstone 은 아직 서버에 push 안 됐을 수 있어
    드레이너가 소유(purge 는 서버로의 '삭제 통보'를 취소하는 게 아니다)."""
    if not gen_id:
        return
    tables = ("generation_metrics", "task_generation", "final_export")
    with get_connection() as conn:
        # MANAGE off 계약: 사이드카 스키마가 없으면 새로 만들지 않는다(_ensure_schema 호출 금지).
        #  → 이미 있는 테이블만 정리. 과거 MANAGE on 때 쌓인 고아는 off 여도 청소 가능.
        have = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
                "('generation_metrics','task_generation','final_export')"
            )
        }
        if not have:
            return
        # 안전: 메인에 같은 id 의 살아있는 생성물이 남아있으면(크래시로 메인·휴지통 오버랩 등) 지우지 않는다
        #  — 사이드카는 그 살아있는 생성물의 것일 수 있다. 정상 purge 는 이미 메인에서 사라진 뒤라 무해.
        if conn.execute("SELECT 1 FROM generation WHERE id=? LIMIT 1", (gen_id,)).fetchone():
            return
        for t in tables:
            if t in have:
                conn.execute(f"DELETE FROM {t} WHERE gen_id=?", (gen_id,))
