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
from .manage_schema import _SCHEMA_ENSURED, _ensure_schema, unresolved_workspace_sql
from .manage_tasks import (
    TaskMissingError,
    TaskProjectMissingError,
    TaskWorkspaceConflictError,
    _assert_tasks_current_for_write,
    _batched,
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
    sync_folder_tasks_batch,
    task_context,
    task_contexts,
    task_projects,
    task_projects_for_workspace,
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
    list_dirty_telemetry,
    mark_ingested_dirty,
    mark_telemetry_dirty,
    mark_telemetry_failed,
    mark_telemetry_pushed,
    mark_telemetry_tombstone,
    telemetry_outbox_status,
)
from .manage_account_reports import (
    account_report_outbox_status,
    latest_account_status_payload,
    list_due_account_reports,
    mark_account_reports_conflicted,
    mark_account_reports_dead_lettered,
    mark_account_reports_failed,
    mark_account_reports_pushed,
    queue_account_reports,
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


def _workspace_filter(alias: str, workspace_id: Optional[str]) -> tuple[str, list[str]]:
    """선택 워크스페이스의 팀 데이터만 읽는 공통 SQL 조건.

    workspace_id가 없으면 개인 탭의 '전체 워크스페이스' 계약을 유지한다.
    """
    if not workspace_id:
        return "", []
    return (
        f" AND {alias}.workspace_scope='team' AND {alias}.workspace_id=?",
        [workspace_id],
    )


def _classify_type(model: Optional[str], asset_type: Optional[str], type_map: dict) -> str:
    """생성물 출력 타입 — 모델 카탈로그(정답) 우선, 없으면 asset_type(URL 추측) 폴백.
    type_map: {job_set_type: 'image'|'video'|'3d'|'audio'} (라우터가 model list 로 채움)."""
    t = type_map.get(model) if model else None
    if not t:
        t = asset_type or "image"
    return t if t in _TYPE_KEYS else "image"


def _project_folder_breakdowns(
    conn,
    project_ids: Optional[list[str]],
    fact_rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """프로젝트의 등록 폴더(project_task, content)와 팩트 폴더 원시행을 합쳐 시퀀스별 사용량을 만든다.

    fact_rows = manage_db.fact_usage()["folder_rows"](pid·folder_path·creator_uid·creator_name·model·count·
    final_count·credits·elapsed_seconds·created_start·created_end). project_ids 밖의 행은 버린다.
    멤버 표시이름은 content creator 표(현재 이름) 우선, 없으면 팩트 스냅샷, 그래도 없으면 '팀원'."""
    task_params: list[str] = []
    task_filter = ""
    allowed: Optional[set[str]] = None
    if project_ids is not None:
        if not project_ids:
            return {}
        marks = ",".join("?" for _ in project_ids)
        task_filter = f" AND pt.project_id IN ({marks})"
        task_params = list(project_ids)
        allowed = set(project_ids)

    def normalized(value: Optional[str]) -> str:
        path = (value or "").strip().replace("\\", "/").strip("/")
        return path or "(폴더 미지정)"

    def empty_folder(path: str) -> dict[str, Any]:
        return {
            "folder_path": path,
            "count": 0,
            "final_count": 0,
            "credits": 0,
            "elapsed_seconds": 0,
            "created_start": None,
            "created_end": None,
            "_models": {},
            "_members": {},
        }

    by_project: dict[str, dict[str, dict[str, Any]]] = {}

    # 폴더 스캔으로 만든 자동 작업을 먼저 넣어 생성물이 0개인 시퀀스도 구조에 남긴다.
    task_rows = conn.execute(
        f"""SELECT pt.project_id AS pid, pt.folder_path
            FROM project_task pt
            WHERE pt.folder_path IS NOT NULL AND TRIM(pt.folder_path) <> ''
              AND COALESCE(pt.archived, 0)=0{task_filter}
            ORDER BY pt.project_id, pt.folder_path COLLATE NOCASE""",
        task_params,
    ).fetchall()
    for row in task_rows:
        pid = row["pid"]
        if not pid:
            continue
        path = normalized(row["folder_path"])
        by_project.setdefault(pid, {}).setdefault(path, empty_folder(path))

    rows_in_scope = [
        row for row in fact_rows
        if row.get("pid") and (allowed is None or row["pid"] in allowed)
    ]
    creator_uids = {row["creator_uid"] for row in rows_in_scope if row.get("creator_uid")}
    creator_names = resolve_display_names(conn, creator_uids) if creator_uids else {}
    for row in rows_in_scope:
        pid = row["pid"]
        path = normalized(row["folder_path"])
        folder = by_project.setdefault(pid, {}).setdefault(path, empty_folder(path))
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

        creator_uid = row.get("creator_uid")
        if creator_uid:
            member = folder["_members"].setdefault(
                creator_uid,
                {
                    "uid": creator_uid,
                    "name": creator_names.get(creator_uid) or row.get("creator_name") or "팀원",
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


def _credit_topup_day(conn, workspace_id: Optional[str]) -> int:
    """워크스페이스의 매월 충전 기준일(1~28, 기본 1) — 예산 '매월' 계산의 달 경계. 워크스페이스 미지정이면 1일."""
    if not workspace_id:
        return 1
    row = conn.execute(
        "SELECT topup_day FROM workspace_credit_plan WHERE workspace_id=?", (workspace_id,)
    ).fetchone()
    try:
        day = int(row["topup_day"]) if row and row["topup_day"] is not None else 1
    except (TypeError, ValueError):
        day = 1
    return day if 1 <= day <= 28 else 1


def _budget_periods(planning: dict[str, dict[str, Any]], project_ids: list[str]) -> dict[str, str]:
    """planning 이 있는 프로젝트의 예산 주기(없으면 month) — 팩트 예산 집계 입력."""
    return {
        pid: (planning[pid].get("budget_period") or "month")
        for pid in project_ids
        if pid in planning
    }


def _shared_counts(conn, project_ids: Optional[list[str]], workspace_id: Optional[str]) -> dict[str, int]:
    """프로젝트별 공유(발행) 수 — 발행 원장은 content share 표가 정확하다(팩트 is_shared 는 작성자 PC 보고값).
    매니저(팀 전체) 전용 — 일반 멤버의 '내 공유 수'는 content 에 이메일이 없어 uid 위조를 못 막으므로(코덱스 P2)
    project_dashboard_summary 가 팩트 is_shared(uid+이메일 절이 걸린 같은 WHERE)로 센다."""
    workspace_filter, params = _workspace_filter("g", workspace_id)
    project_filter = ""
    if project_ids is not None:
        if not project_ids:
            return {}
        marks = ",".join("?" for _ in project_ids)
        project_filter = f" AND g.project_id IN ({marks})"
        params = list(project_ids) + params
    rows = conn.execute(
        f"SELECT g.project_id AS pid, COUNT(*) AS shared_count FROM generation g "
        f"JOIN share s ON s.generation_id = g.id WHERE 1=1{project_filter}{workspace_filter} "
        f"GROUP BY g.project_id",
        params,
    ).fetchall()
    return {row["pid"]: row["shared_count"] or 0 for row in rows}


def _usage_fields(stats: Optional[dict[str, Any]]) -> dict[str, Any]:
    """팩트 프로젝트 stats → 응답 필드(없으면 0)."""
    keys = (
        "gen_count", "done_count", "final_count", "real_credits", "credits",
        "metric_count", "elapsed_total", "credit_real_count", "credit_est_count",
        "credit_unknown_count",
    )
    return {key: (stats[key] if stats and stats.get(key) else 0) for key in keys}


def dashboard_summary(
    model_type_map: Optional[dict] = None,
    workspace_id: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트별·작업자별 생성수·크레딧·소요시간 + 출력타입·영상길이 + 환불·워크스페이스 요약.

    ★사용량(생성수·크레딧·소요시간·모델·폴더·작업자·totals)은 manage_hub 팩트(team_generation_fact)
    에서 센다(2026-09-09, "출근부 장부") — 공유 안 한 생성물도 포함, tombstone 포함. content DB 는
    프로젝트 레지스트리·planning·공유(발행) 수·빈 시퀀스·표시이름·출력타입/영상길이·거래 입출에만 쓴다.
    totals 는 워크스페이스 전체 팩트(미분류·보관·삭제된 프로젝트 포함)라 표시 행 합보다 클 수 있다(종전과 동일).
    크레딧 = COALESCE(실제, 견적). 출력타입은 model_type_map(라우터가 CLI model list 로 채움)
    우선, 없으면 asset.type(URL 추측) 폴백. 영상길이는 params.duration 합(초)."""
    from .. import manage_db  # 지연 import — 작업탭 elapsed 폴백(manage_tasks)과 같은 방식

    tmap = model_type_map or {}
    with get_connection() as conn:
        _ensure_schema(conn)
        generation_filter, generation_params = _workspace_filter("g", workspace_id)
        project_filter, project_params = _workspace_filter("p", workspace_id)
        shared_by_pid = _shared_counts(conn, None, workspace_id)
        # 설정된 프로젝트(레지스트리) — 미분류(null) 제외, 보관 제외. 생성물이 없어도 0으로 표시.
        reg = conn.execute(
            f"SELECT id, name FROM project p WHERE archived = 0{project_filter} "
            "ORDER BY COALESCE(sort_order, 1000000), created_at",
            project_params,
        ).fetchall()
        planning = {
            r["project_id"]: dict(r)
            for r in conn.execute("SELECT * FROM project_planning").fetchall()
        }
        registry_ids = [row["id"] for row in reg]
        # 팩트 사용량 — 워크스페이스 전체를 한 스냅샷으로(이동 프로젝트·totals 판정에 전체가 필요).
        usage = manage_db.fact_usage(
            workspace_id, None, _budget_periods(planning, list(planning)),
            month_anchor_day=_credit_topup_day(conn, workspace_id),
        )
        fact_stats = usage["stats"]
        fact_workers = usage["workers"]
        # 워크스페이스를 떠난(이동된) 프로젝트라도 이 공간에 생성 기록(팩트)이 있으면 행으로 표시한다.
        # 정책: 생성물의 workspace 는 생성 당시 과금 스냅샷이라 기록은 이전 공간에 남는다 — 행에서
        # 빼면 totals(팩트 기준)와 행 합이 어긋나는 유령 수치가 된다. 미분류(pid 없음)·삭제된
        # 프로젝트(name 없음)·보관(archived)은 종전대로 행에서 제외(합계 주석 참조).
        registry_set = set(registry_ids)
        moved_ids = [pid for pid in fact_stats if pid and pid not in registry_set]
        moved: list[dict[str, Any]] = []
        if moved_ids:
            marks = ",".join("?" for _ in moved_ids)
            for r in conn.execute(
                f"SELECT id, name, archived FROM project WHERE id IN ({marks})", moved_ids
            ).fetchall():
                if r["name"] is not None and not r["archived"]:
                    moved.append({"pid": r["id"], "name": r["name"]})
        moved.sort(key=lambda item: -(fact_stats[item["pid"]]["gen_count"] or 0))
        breakdown_ids = registry_ids + [item["pid"] for item in moved]
        project_models, budget_models = usage["models"], usage["budget_models"]
        project_folders = _project_folder_breakdowns(conn, breakdown_ids, usage["folder_rows"])
        # 예산은 프로젝트 누적이 아니라 설정된 현재 일/주/월 모델 사용량 합과 비교한다.
        budget_usage = {
            pid: sum(row["credits"] for row in rows)
            for pid, rows in budget_models.items()
        }
        # 출력타입·영상길이 — 모델 카탈로그(정답)로 분류, params.duration 합(영상만). content 기준(종전).
        # 한 생성물의 대표 에셋 타입(URL 추측)은 폴백용. 모델→type 가 있으면 그것이 우선.
        per_gen = conn.execute(
            f"""SELECT g.project_id AS pid, g.model AS model,
                      json_extract(g.params, '$.duration') AS duration,
                      a.type AS asset_type
               FROM generation g
               LEFT JOIN (
                   SELECT generation_id, MIN(type) AS type FROM asset GROUP BY generation_id
               ) a ON a.generation_id = g.id
               WHERE 1=1{generation_filter}""",
            generation_params,
        ).fetchall()
        # 환불·지급 — credit_txn 의 action 별 합(절대값). spend 는 실매칭으로 이미 잡힘.
        # credit_txn에는 workspace 차원이 없다. 선택 범위에 전사 합계를 섞어 거짓 수치를 만들지 않는다.
        # ★2026-09-12: credit_txn 에 workspace_id 가 생겨 공간을 골라도 셀 수 있다(종전엔 빈 배열).
        #  숫자인 행만 센다 — 손상된 값이 ABS() 를 거쳐 0 으로 섞이면 '정확해 보이는 틀린 수'가 된다.
        #  ⚠`/team-overview` 는 `manage_transactions.ledger_totals` 를 쓴다. 여기서 같은 함수를
        #   부르지 않는 이유는 이 블록이 이미 커넥션 안이고 그 함수가 자기 커넥션·트랜잭션을 열기
        #   때문이다(중첩). 통합은 별도 작업으로 남긴다.
        io_rows = conn.execute(
            "SELECT action, COALESCE(SUM(ABS(credits)), 0) AS amt FROM credit_txn "
            "WHERE typeof(credits) IN ('integer','real')"
            + (" AND workspace_id = ?" if workspace_id else "")
            + " GROUP BY action",
            [workspace_id] if workspace_id else [],
        ).fetchall()
        # 작업자 표시이름 — content creator 표(현재 이름) 우선, 없으면 팩트 스냅샷.
        uids = [w["uid"] for w in fact_workers if w["uid"]]
        names = resolve_display_names(conn, uids) if uids else {}

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

    # 표시 프로젝트 = 설정된 프로젝트(레지스트리) + 이 공간에 기록이 남은 이동 프로젝트.
    # 사용량은 pid 로 팩트 매칭(없으면 0). 이동 행은 workspace_moved=True 로 구분한다.
    row_sources = [
        {"id": r["id"], "name": r["name"], "moved": False} for r in reg
    ] + [
        {"id": item["pid"], "name": item["name"], "moved": True} for item in moved
    ]
    projects = []
    for rp in row_sources:
        pid = rp["id"]
        d = {
            "pid": pid,
            "name": rp["name"] or pid,
            "workspace_moved": rp["moved"],
            **_usage_fields(fact_stats.get(pid)),
            "shared_count": shared_by_pid.get(pid, 0),
            "budget_used_credits": budget_usage.get(pid, 0),
            "models": project_models.get(pid, []),
            "budget_models": budget_models.get(pid, []),
            "folders": project_folders.get(pid, []),
            "planning": planning.get(pid),
            "types": type_by_pid.get(pid, {k: 0 for k in _TYPE_KEYS}),
            "video_seconds": round(dur_by_pid.get(pid, 0.0), 1),
        }
        projects.append(d)
    worker_list = []
    for w in fact_workers:
        uid = w["uid"]
        worker_list.append(
            {
                "uid": uid,
                "name": names.get(uid) or w.get("name") or ("미상" if not uid else uid),
                "gen_count": w["gen_count"] or 0,
                "credits": w["credits"] or 0,
                "elapsed_total": w["elapsed_total"] or 0,
            }
        )

    io = {r["action"]: r["amt"] for r in io_rows}
    # 합계는 전체 팩트 기준(미분류 포함) — 표시 프로젝트 목록은 미분류를 빼지만 '총 생성물'은 전부.
    totals = {
        "gen_count": sum(s["gen_count"] or 0 for s in fact_stats.values()),
        "done_count": sum(s["done_count"] or 0 for s in fact_stats.values()),
        "credits": sum(s["credits"] or 0 for s in fact_stats.values()),
        "real_credits": sum(s["real_credits"] or 0 for s in fact_stats.values()),
        "elapsed_total": sum(s["elapsed_total"] or 0 for s in fact_stats.values()),
        "metric_count": sum(s["metric_count"] or 0 for s in fact_stats.values()),
        "types": type_totals,
        "video_seconds": round(video_seconds_total, 1),
        # 실제 거래 기준 입출(절대값). net = 지출 - 환불.
        # ★반올림하지 않는다(2026-09-12) — 크레딧은 소수다. 표시 자리수는 화면이 정한다.
        "spend_credits": io.get("spend", 0),
        "refund_credits": io.get("refund", 0),
        "grant_credits": io.get("grant", 0),
        "net_credits": io.get("spend", 0) - io.get("refund", 0),
    }
    return {
        "projects": projects,
        "workers": worker_list,
        "totals": totals,
        "workspaces": _workspace_credits(workspace_id),
        "usage_source": "facts",
        "usage_scope": "all",  # read_all 전용 — 팀원 미공유분 포함
    }


def project_dashboard_summary(
    project_ids: list[str],
    workspace_id: Optional[str] = None,
    viewer: Optional[tuple[str, str]] = None,
) -> dict[str, Any]:
    """접근 가능한 프로젝트의 작업 현황에 필요한 최소 집계만 반환한다.

    사용량은 dashboard_summary 와 같은 팩트 원천(team_generation_fact)이다. ★노출 범위(Jay 결정 2026-09-10):
    viewer=(creator_uid, account_email) 가 있으면(일반 멤버) **내 작업만** 센다 — 팀원 것은 공유 여부와
    무관하게 매니저(read_all, viewer=None)만 본다. 공유 수 shared_count 도 본인 것만 — 멤버는 팩트 is_shared
    (본인 PC 보고값, uid+이메일 절 안)로, 매니저는 content share 원장(팀 전체)으로.
    전사 작업자·워크스페이스 통계는 의도적으로 읽지 않는다. 호출측이 멤버십으로 허용된 project_ids만 넘기며,
    팩트 SQL 도 그 id·열람 범위로 한정해 일반 멤버 요청이 전사 데이터 집계 비용이나 노출 경로로 이어지지 않게 한다.
    """
    from .. import manage_db  # 지연 import — dashboard_summary 와 동일

    usage_scope = "all" if viewer is None else "mine"
    ids = list(dict.fromkeys(pid for pid in project_ids if pid))
    if not ids:
        return {"projects": [], "usage_source": "facts", "usage_scope": usage_scope}

    marks = ",".join("?" for _ in ids)
    with get_connection() as conn:
        _ensure_schema(conn)
        project_filter, project_params = _workspace_filter("p", workspace_id)
        registry = conn.execute(
            f"SELECT id, name FROM project p WHERE archived=0 AND id IN ({marks}){project_filter} "
            "ORDER BY COALESCE(sort_order, 1000000), created_at",
            ids + project_params,
        ).fetchall()
        scoped_ids = [row["id"] for row in registry]
        if not scoped_ids:
            return {"projects": [], "usage_source": "facts", "usage_scope": usage_scope}
        marks = ",".join("?" for _ in scoped_ids)
        # 매니저만 content 원장 — 멤버 공유 수는 아래에서 팩트 stats.shared_count 로(uid 위조 방어, 코덱스 P2).
        shared_by_pid = _shared_counts(conn, scoped_ids, workspace_id) if viewer is None else {}
        planning = {
            row["project_id"]: dict(row)
            for row in conn.execute(
                f"SELECT * FROM project_planning WHERE project_id IN ({marks})", scoped_ids
            ).fetchall()
        }
        # 허용된 프로젝트·열람 범위만 SQL 에서부터 센다(코덱스 P2) — 한 스냅샷.
        usage = manage_db.fact_usage(
            workspace_id,
            scoped_ids,
            _budget_periods(planning, scoped_ids),
            viewer=viewer,
            month_anchor_day=_credit_topup_day(conn, workspace_id),
        )
        fact_stats = usage["stats"]
        project_models, budget_models = usage["models"], usage["budget_models"]
        project_folders = _project_folder_breakdowns(conn, scoped_ids, usage["folder_rows"])
        budget_usage = {
            pid: sum(row["credits"] for row in rows)
            for pid, rows in budget_models.items()
        }

    projects: list[dict[str, Any]] = []
    for project in registry:
        pid = project["id"]
        projects.append(
            {
                "pid": pid,
                "name": project["name"] or pid,
                **_usage_fields(fact_stats.get(pid)),
                "shared_count": (
                    shared_by_pid.get(pid, 0)
                    if viewer is None
                    else int((fact_stats.get(pid) or {}).get("shared_count") or 0)
                ),
                "budget_used_credits": budget_usage.get(pid, 0),
                "models": project_models.get(pid, []),
                "budget_models": budget_models.get(pid, []),
                "folders": project_folders.get(pid, []),
                "planning": planning.get(pid),
            }
        )
    return {"projects": projects, "usage_source": "facts", "usage_scope": usage_scope}


def _workspace_credits(workspace_id: Optional[str] = None) -> list[dict[str, Any]]:
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
            if workspace_id and ws.get("id") != workspace_id:
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
    archive_after_days: Optional[int] = None,
    note: Optional[str] = None,
) -> dict[str, Any]:
    """프로젝트 일정/예산 upsert. project_planning 사이드카만 건드린다(코어 project 무수정)."""
    with get_connection() as conn:
        _ensure_schema(conn)
        # 구버전 클라이언트는 budget_period를 보내지 않는다. 기존 설정은 보존하고,
        # 최초 저장일 때만 매월을 기본값으로 사용한다.
        if budget_period not in {"day", "week", "month"}:
            existing = conn.execute(
                "SELECT budget_period, archive_after_days FROM project_planning WHERE project_id=?",
                (pid,),
            ).fetchone()
            budget_period = (
                existing["budget_period"]
                if existing and existing["budget_period"] in {"day", "week", "month"}
                else "month"
            )
        else:
            existing = conn.execute(
                "SELECT archive_after_days FROM project_planning WHERE project_id=?", (pid,)
            ).fetchone()
        if archive_after_days is None:
            archive_after_days = (
                existing["archive_after_days"]
                if existing and existing["archive_after_days"] is not None
                else 30
            )
        archive_after_days = max(1, min(int(archive_after_days), 3650))
        conn.execute(
            """INSERT INTO project_planning
                   (project_id, status, start_date, due_date, budget_credits, budget_period,
                    archive_after_days, note)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(project_id) DO UPDATE SET
                   status=excluded.status, start_date=excluded.start_date,
                   due_date=excluded.due_date, budget_credits=excluded.budget_credits,
                   budget_period=excluded.budget_period,
                   archive_after_days=excluded.archive_after_days, note=excluded.note""",
            (
                pid, status, start_date, due_date, budget_credits, budget_period,
                archive_after_days, note,
            ),
        )
        return dict(
            conn.execute(
                "SELECT * FROM project_planning WHERE project_id=?", (pid,)
            ).fetchone()
        )


# ── 완료본 렌더폴더 저장(Phase 3) ─────────────────────────────────────────────
def final_export_task_facts(
    project_id: str, *, gen_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """완료본 내보내기 판정용 '원자료'만 반환 — 판정(정책)은 하지 않는다.

    반환: [{task_id, status(raw), folder_path, archived, cuts:[{id,status,is_final,shared}]}].
    · 작업 status 는 파생 전 raw 값이다 — 폴더 자동 작업의 '완료' 파생(최종 컷 존재)은
      정책 계층이 cuts.is_final 로 동일하게 재현한다(list_tasks 파생 규칙에서 유도).
    · gen_id 를 주면 cuts 를 그 생성물로만 제한하고(레인 SQL 수준), 폴더 자동 작업
      동기화도 그 생성물의 폴더만 보장한다 — 프로젝트 전수 스캔 없이 단건 판정용.
    · ★작업 선택은 list_tasks 와 같은 워크스페이스 스냅샷 predicate 를 쓴다 — 프로젝트가
      다른 워크스페이스로 이동하면 과거 공간 작업(과거 완료본)은 제외된다(코덱스 P1).
    """
    unresolved_task = unresolved_workspace_sql("t")
    with get_connection() as conn:
        _ensure_schema(conn)
        if gen_id:
            target = conn.execute(
                "SELECT folder_path FROM generation "
                "WHERE id=? AND project_id=? AND deleted_at IS NULL",
                (gen_id, project_id),
            ).fetchone()
            if not target:
                return []
            folder = (target["folder_path"] or "").strip()
            if folder:
                # 이 폴더의 자동 작업만 보장 — 전체 GROUP BY·수명주기 갱신은 목록 GET 경로 몫.
                sync_folder_tasks_batch(conn, [project_id], folder_paths=[folder])
        else:
            sync_folder_tasks_batch(conn, [project_id])
        tasks = conn.execute(
            "SELECT t.id, t.project_id, t.folder_path, t.sequence, t.status, t.archived, "
            "t.workspace_scope, t.workspace_id, t.workspace_name "
            "FROM project_task t LEFT JOIN project p ON p.id=t.project_id "
            "WHERE t.project_id=? AND (" + unresolved_task + " OR "
            "(LOWER(TRIM(COALESCE(t.workspace_scope, '')))='team' "
            " AND p.workspace_scope='team' "
            " AND TRIM(COALESCE(t.workspace_id, ''))=p.workspace_id) OR "
            "(LOWER(TRIM(COALESCE(t.workspace_scope, '')))='personal' "
            " AND p.workspace_scope='personal'))",
            (project_id,),
        ).fetchall()
        rows_by_task = _batch_task_gen_rows(
            conn,
            project_id,
            tasks,
            generation_ids={gen_id} if gen_id else None,
        )
    return [
        {
            "task_id": t["id"],
            "status": t["status"],
            "folder_path": t["folder_path"],
            "archived": t["archived"],
            "cuts": [
                {"id": g["id"], "status": g["status"], "is_final": bool(g["is_final"]), "shared": bool(g["shared"])}
                for g in rows_by_task.get(t["id"], [])
            ],
        }
        for t in tasks
    ]


def final_export_sources(
    project_id: str, gen_ids: "list[str] | set[str]"
) -> list[dict[str, Any]]:
    """판정 통과한 gen_id 들의 저장 원자료(폴더·첫 asset). 종전 finals_to_export 후반부와
    동일 SQL — ★project_id 재제한·deleted 제외로 타 프로젝트 수동 링크 유출을 막는다."""
    ids = list(dict.fromkeys(g for g in (gen_ids or []) if g))
    if not ids:
        return []
    with get_connection() as conn:
        _ensure_schema(conn)
        result: list[dict[str, Any]] = []
        for id_batch in _batched(ids):
            ph = ",".join("?" * len(id_batch))
            rows = conn.execute(
                f"SELECT g.id AS gen_id, g.folder_path AS folder_path, "
                f"  (SELECT a.file_path FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS file_path, "
                f"  (SELECT a.type FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS media_type, "
                f"  (SELECT a.source_url FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS source_url "
                f"FROM generation g WHERE g.id IN ({ph}) AND g.project_id=? AND g.deleted_at IS NULL",
                [*id_batch, project_id],
            ).fetchall()
            result.extend(dict(r) for r in rows)
        return result


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


def export_dest_paths(gen_ids: "list[str] | set[str]") -> dict[str, str]:
    """이 PC 의 저장 대장에서 gen_id → 마지막 저장 경로. '이 파일은 우리가 여기 저장했다'의 가장 싼 증거."""
    ids = list(dict.fromkeys(g for g in (gen_ids or []) if g))
    out: dict[str, str] = {}
    with get_connection() as conn:
        _ensure_schema(conn)
        for id_batch in _batched(ids):
            ph = ",".join("?" * len(id_batch))
            for r in conn.execute(f"SELECT gen_id, dest_path FROM final_export WHERE gen_id IN ({ph})", list(id_batch)):
                out[r["gen_id"]] = r["dest_path"]
    return out


def forget_exports(gen_ids: "list[str] | set[str]") -> None:
    """대장에서 지운다 — 비교가 '대장에는 있는데 폴더에는 없는' 파일을 찾았을 때(누가 손으로 지웠거나 미러가 옮김)."""
    ids = list(dict.fromkeys(g for g in (gen_ids or []) if g))
    with get_connection() as conn:
        _ensure_schema(conn)
        for id_batch in _batched(ids):
            ph = ",".join("?" * len(id_batch))
            conn.execute(f"DELETE FROM final_export WHERE gen_id IN ({ph})", list(id_batch))


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
        # elapsed 는 UPSERT 의 DO UPDATE 절에서 함께 계산(R6 manage-1) — 종전엔 같은 행을
        # 직후 UPDATE 로 또 써 완료마다 쓰기·WAL 기록이 2회였다. started 없으면(신규 행·
        # 동기화·과거분) elapsed 는 종전대로 NULL/기존값 유지.
        conn.execute(
            "INSERT INTO generation_metrics(gen_id, job_id, completed_at) "
            "VALUES(?,?, datetime('now')) "
            "ON CONFLICT(gen_id) DO UPDATE SET "
            "  job_id=COALESCE(excluded.job_id, generation_metrics.job_id), "
            "  completed_at=excluded.completed_at, "
            "  elapsed_seconds=CASE WHEN generation_metrics.started_at IS NOT NULL "
            "    THEN (julianday(excluded.completed_at) - julianday(generation_metrics.started_at)) * 86400.0 "
            "    ELSE generation_metrics.elapsed_seconds END",
            (gen_id, job_id),
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
    """생성물들을 작업에 연결(멱등).

    작업 스냅샷과 프로젝트가 모두 같은 생성물만 한 트랜잭션으로 연결한다. 하나라도
    불일치/누락이면 일부만 연결하지 않고 요청 전체를 취소한다.
    """
    gen_ids = list(dict.fromkeys(str(gen_id or "").strip() for gen_id in gen_ids))
    gen_ids = [gen_id for gen_id in gen_ids if gen_id]
    if not gen_ids:
        return 0
    n = 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        _assert_tasks_current_for_write(conn, [task_id])
        task = conn.execute(
            "SELECT project_id, workspace_scope, workspace_id FROM project_task WHERE id=?",
            (task_id,),
        ).fetchone()
        if not task:
            raise ValueError("없는 작업입니다")
        task_scope = str(task["workspace_scope"] or "").strip().lower()
        task_workspace_id = str(task["workspace_id"] or "").strip() or None
        if task_scope not in {"team", "personal"}:
            raise ValueError("작업의 워크스페이스 귀속을 먼저 확인해야 합니다")

        generations: dict[str, Any] = {}
        for id_batch in _batched(gen_ids):
            placeholders = ",".join("?" * len(id_batch))
            rows = conn.execute(
                f"SELECT id, project_id, workspace_scope, workspace_id FROM generation "
                f"WHERE deleted_at IS NULL AND id IN ({placeholders})",
                id_batch,
            ).fetchall()
            generations.update({row["id"]: row for row in rows})
        missing = [gen_id for gen_id in gen_ids if gen_id not in generations]
        if missing:
            raise ValueError(f"연결할 수 없는 생성물입니다: {missing[0]}")

        for gid in gen_ids:
            generation = generations[gid]
            generation_scope = str(generation["workspace_scope"] or "").strip().lower()
            generation_workspace_id = str(generation["workspace_id"] or "").strip() or None
            if generation["project_id"] != task["project_id"]:
                raise ValueError("다른 프로젝트의 생성물은 연결할 수 없습니다")
            same_workspace = (
                task_scope == "personal" and generation_scope == "personal"
            ) or (
                task_scope == "team"
                and generation_scope == "team"
                and task_workspace_id == generation_workspace_id
            )
            if not same_workspace:
                raise ValueError("다른 워크스페이스의 생성물은 연결할 수 없습니다")

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
        conn.execute("BEGIN IMMEDIATE")
        if task_id not in _assert_tasks_current_for_write(conn, [task_id]):
            return False
        cur = conn.execute(
            "DELETE FROM task_generation WHERE task_id=? AND gen_id=?", (task_id, gen_id)
        )
        return cur.rowcount > 0


# ── 영구 삭제 시 사이드카 고아 정리 ──────────────────────────────────────────
def purge_generation_sidecar_in_connection(conn, gen_id: str) -> None:
    """호출자가 연 트랜잭션에서 영구 삭제된 생성물의 사이드카를 정리한다.

    스키마는 새로 만들지 않으며 이 함수는 BEGIN/COMMIT/ROLLBACK을 소유하지 않는다.
    사이드카는 별도 manage DB가 아닌 현재 계정의 main 콘텐츠 DB에 있다.
    """
    if not gen_id:
        return
    tables = ("generation_metrics", "task_generation", "final_export")
    # MANAGE off 계약: 이미 있는 테이블만 정리하고 _ensure_schema는 호출하지 않는다.
    have = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table' AND name IN "
            "('generation_metrics','task_generation','final_export')"
        )
    }
    if not have:
        return
    # 복원·크래시 오버랩 등으로 본체가 살아 있으면 그 본체의 사이드카일 수 있다.
    if conn.execute(
        "SELECT 1 FROM main.generation WHERE id=? LIMIT 1", (gen_id,)
    ).fetchone():
        return
    for table in tables:
        if table in have:
            conn.execute(f"DELETE FROM main.{table} WHERE gen_id=?", (gen_id,))


def purge_generation_sidecar(gen_id: str) -> None:
    """생성물이 '영구 삭제'(휴지통 purge)될 때 남는 사이드카 고아 행 정리 — generation_metrics·
    task_generation·final_export(모두 gen_id 키). 이 행들은 메인/휴지통 어디에도 대응 생성물이 없어
    LEFT JOIN 에서 영영 안 잡히며 무한 누적된다(영구삭제만 해당 — 휴지통 이동 땐 복원용으로 보존).
    ★telemetry_outbox 는 건드리지 않는다 — 삭제 tombstone 은 아직 서버에 push 안 됐을 수 있어
    드레이너가 소유(purge 는 서버로의 '삭제 통보'를 취소하는 게 아니다).
    ★transaction-root 전용(바깥 트랜잭션 안 호출 금지 — 중첩은 sqlite 오류로 fail-fast)."""
    if not gen_id:
        return
    with get_connection() as conn:
        # 생존 재확인~삭제를 한 트랜잭션으로(R6 manage-2) — 확인 뒤 복원이 끼면 살아있는
        # 생성물의 사이드카를 지우거나 일부 테이블만 지운 반쪽 상태가 남았다.
        conn.execute("BEGIN IMMEDIATE")
        try:
            purge_generation_sidecar_in_connection(conn, gen_id)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
