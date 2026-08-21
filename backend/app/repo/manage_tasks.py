"""PM 작업 저장소 — 작업 조회·자동 폴더 작업·담당자 배정·CRUD.

외부 호출은 호환 파사드인 repo.manage 를 유지한다. 이 모듈은 작업 테이블과
작업에 연결된 생성물의 조회/집계 경계만 소유한다.
"""

from __future__ import annotations

import os
import threading
import time
import weakref
from typing import Any, Optional

from ..db import get_connection, pool_epoch
from ..db_paths import get_db_path
from ._common import new_id
from .identity import resolve_display_names
from .manage_schema import _ensure_schema, unresolved_workspace_sql


# ── 작업(Task) ────────────────────────────────────────────────────────────────
_TASK_FIELDS = (
    "name", "status", "start_date", "due_date", "sort_order", "note",
    "sequence", "description",
)
_SQLITE_IN_BATCH = 900  # 오래된 SQLite 의 기본 변수 상한(999)보다 작게 유지.
_SQLITE_PAIRED_IN_BATCH = 400  # project+folder/sequence 두 IN 목록 합이 999 미만.
_TASK_READ_CACHE_TTL = max(
    0.0, float(os.environ.get("CONTENT_HUB_TASK_READ_CACHE_TTL", "0.75"))
)
_TASK_READ_CACHE_GUARD = threading.Lock()
_TASK_READ_CACHE: dict[tuple, tuple[float, tuple, dict[str, list[dict[str, Any]]]]] = {}
_TASK_READ_FLIGHTS: weakref.WeakValueDictionary[tuple, threading.Lock] = (
    weakref.WeakValueDictionary()
)


def _batched(values: list[str], size: int = _SQLITE_IN_BATCH):
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _file_stamp(path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


def _task_cache_stamp() -> tuple | None:
    """내용·WAL·텔레메트리 파일이 그대로일 때만 재사용할 수 있는 싼 변경 표식."""
    content = get_db_path()
    content_stamp = _file_stamp(content)
    if content_stamp is None:
        return None
    from .. import manage_db

    return (
        str(content),
        # 같은 경로의 DB 파일을 복원·계정 전환으로 통째 교체하면 크기와 mtime이 우연히
        # 같을 수 있다. flush_pool()이 올리는 에폭까지 포함해 옛 작업표/ETag를 즉시 버린다.
        pool_epoch(),
        content_stamp,
        _file_stamp(content.with_name(content.name + "-wal")),
        _file_stamp(manage_db.MANAGE_DB_PATH),
        _file_stamp(manage_db.MANAGE_DB_PATH.with_name(manage_db.MANAGE_DB_PATH.name + "-wal")),
    )


def clear_task_read_cache() -> None:
    """DB 교체·테스트에서 짧은 작업 조회 스냅샷을 명시적으로 비운다."""
    with _TASK_READ_CACHE_GUARD:
        _TASK_READ_CACHE.clear()
        _TASK_READ_FLIGHTS.clear()


def _task_cache_hit(key: tuple, stamp: tuple, now: float):
    with _TASK_READ_CACHE_GUARD:
        cached = _TASK_READ_CACHE.get(key)
        if cached and cached[0] >= now and cached[1] == stamp:
            return cached[2]
        if cached:
            _TASK_READ_CACHE.pop(key, None)
        return None


def _task_flight_lock(key: tuple) -> threading.Lock:
    with _TASK_READ_CACHE_GUARD:
        # 약한 참조는 실행·대기 중인 호출이 가진 잠금만 보존한다. 임의 개수 제한으로
        # 잠깐 풀린 대기 잠금을 지우면 같은 키 계산이 둘로 갈라질 수 있으므로, 수동
        # 축출 대신 마지막 호출이 끝난 뒤 Python이 안전하게 정리하도록 맡긴다.
        return _TASK_READ_FLIGHTS.setdefault(key, threading.Lock())


def task_project_id(tid: str) -> Optional[str]:
    """작업 id 가 속한 프로젝트 id. 권한 검사에서 먼저 사용한다."""
    with get_connection() as conn:
        _ensure_schema(conn)
        row = conn.execute(
            "SELECT project_id FROM project_task WHERE id=?", (tid,)
        ).fetchone()
        return row["project_id"] if row else None


def _task_workspace(row) -> tuple[str, Optional[str], Optional[str]]:
    # generation 배치 조회는 비교에 필요한 scope/id 만 읽는다. sqlite.Row 는 없는 키에
    # IndexError 를 내므로 선택 컬럼이 더 적은 행도 같은 정규화기를 안전하게 사용한다.
    keys = set(row.keys()) if hasattr(row, "keys") else set(row)
    scope = str(row["workspace_scope"] or "").strip().lower() if "workspace_scope" in keys else ""
    workspace_id = (
        str(row["workspace_id"] or "").strip() or None
        if "workspace_id" in keys else None
    )
    workspace_name = (
        str(row["workspace_name"] or "").strip() or None
        if "workspace_name" in keys else None
    )
    if scope == "team" and workspace_id:
        return "team", workspace_id, workspace_name
    if scope == "personal":
        return "personal", None, None
    return "unknown", None, None


def _project_workspace(conn, project_id: str) -> tuple[str, Optional[str], Optional[str]]:
    row = conn.execute(
        "SELECT workspace_scope, workspace_id, workspace_name FROM project WHERE id=?",
        (project_id,),
    ).fetchone()
    return _task_workspace(row) if row else ("unknown", None, None)


def _same_workspace(
    task_scope: str,
    task_workspace_id: Optional[str],
    row,
    *,
    explicitly_linked: bool = False,
) -> bool:
    generation_scope, generation_workspace_id, _name = _task_workspace(row)
    if task_scope == "team":
        return generation_scope == "team" and generation_workspace_id == task_workspace_id
    if task_scope == "personal":
        return generation_scope == "personal"
    # 귀속 미확정 수동 작업은 명시 링크를 증거로 보여주되 자동 폴더/태그 매칭으로 범위를
    # 임의 확장하지 않는다. 미상 생성물은 같은 미상 범위라 자동 매칭할 수 있다.
    return explicitly_linked or generation_scope == "unknown"


def task_contexts(task_ids: list[str]) -> dict[str, dict[str, Any]]:
    """작업의 저장 위치와 프로젝트 현재 위치를 한 번에 반환한다."""
    task_ids = list(dict.fromkeys(task_id for task_id in task_ids if task_id))
    if not task_ids:
        return {}
    out: dict[str, dict[str, Any]] = {}
    with get_connection() as conn:
        _ensure_schema(conn)
        for batch in _batched(task_ids):
            placeholders = ",".join("?" * len(batch))
            rows = conn.execute(
                f"SELECT t.id, t.project_id, t.workspace_scope, t.workspace_id, "
                f"t.workspace_name, t.workspace_origin, "
                f"p.workspace_scope AS project_workspace_scope, "
                f"p.workspace_id AS project_workspace_id, "
                f"p.workspace_name AS project_workspace_name "
                f"FROM project_task t LEFT JOIN project p ON p.id=t.project_id "
                f"WHERE t.id IN ({placeholders})",
                batch,
            ).fetchall()
            for row in rows:
                item = dict(row)
                task_scope, task_workspace_id, _task_name = _task_workspace(row)
                project_scope = str(row["project_workspace_scope"] or "").strip().lower()
                project_workspace_id = str(row["project_workspace_id"] or "").strip() or None
                item["is_current"] = task_scope != "unknown" and (
                    (task_scope == "team" and project_scope == "team" and task_workspace_id == project_workspace_id)
                    or (task_scope == "personal" and project_scope == "personal")
                )
                item["workspace_unresolved"] = task_scope == "unknown"
                out[row["id"]] = item
    return out


def task_context(tid: str) -> Optional[dict[str, Any]]:
    return task_contexts([tid]).get(tid)


class TaskWorkspaceConflictError(ValueError):
    """현재 프로젝트 위치와 다른 작업 스냅샷을 쓰려 할 때의 안전 중단."""


class TaskProjectMissingError(ValueError):
    """작업 생성 트랜잭션에서 대상 프로젝트가 이미 사라졌을 때의 안전 중단."""


class TaskMissingError(ValueError):
    """권한 검사 뒤 실제 쓰기 전에 작업이 사라졌을 때의 안전 중단."""


def _assert_tasks_current_for_write(conn, task_ids: list[str]) -> set[str]:
    """쓰기 트랜잭션 안에서 과거·미귀속 작업 변경을 다시 차단한다.

    라우터의 권한 검사는 사용자에게 빠르고 정확한 응답을 주기 위한 1차 검사다. 프로젝트가
    그 검사 직후 다른 워크스페이스로 이동할 수 있으므로, 실제 변경과 같은 ``BEGIN IMMEDIATE``
    트랜잭션에서도 스냅샷과 프로젝트 현재 위치를 비교해야 한다.
    """
    unique_ids = list(dict.fromkeys(task_id for task_id in task_ids if task_id))
    if not unique_ids:
        return set()
    existing: set[str] = set()
    for batch in _batched(unique_ids):
        placeholders = ",".join("?" * len(batch))
        rows = conn.execute(
            f"SELECT t.id, t.workspace_scope, t.workspace_id, "
            f"p.workspace_scope AS project_workspace_scope, "
            f"p.workspace_id AS project_workspace_id "
            f"FROM project_task t LEFT JOIN project p ON p.id=t.project_id "
            f"WHERE t.id IN ({placeholders})",
            batch,
        ).fetchall()
        for row in rows:
            existing.add(row["id"])
            task_scope, task_workspace_id, _task_name = _task_workspace(row)
            project_scope = str(row["project_workspace_scope"] or "").strip().lower()
            project_workspace_id = str(row["project_workspace_id"] or "").strip() or None
            if task_scope == "unknown":
                raise TaskWorkspaceConflictError(
                    "작업의 워크스페이스 귀속을 확인해야 수정할 수 있습니다"
                )
            current = (
                task_scope == "personal" and project_scope == "personal"
            ) or (
                task_scope == "team"
                and project_scope == "team"
                and task_workspace_id == project_workspace_id
            )
            if not current:
                raise TaskWorkspaceConflictError("과거 워크스페이스 작업은 읽기 전용입니다")
    missing = [task_id for task_id in unique_ids if task_id not in existing]
    if missing:
        raise TaskMissingError(f"없는 작업: {missing[0]}")
    return existing


def _task_gen_rows(
    conn,
    tid: str,
    project_id: str,
    sequence: Optional[str],
    folder_path: Optional[str],
    workspace_scope: Optional[str] = None,
    workspace_id: Optional[str] = None,
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
    if workspace_scope is None:
        task = conn.execute(
            "SELECT workspace_scope, workspace_id, workspace_name FROM project_task WHERE id=?",
            (tid,),
        ).fetchone()
        workspace_scope, workspace_id, _workspace_name = (
            _task_workspace(task) if task else ("unknown", None, None)
        )
    if workspace_scope == "team":
        workspace_clause = "g.workspace_scope='team' AND g.workspace_id=?"
        workspace_args: tuple[Any, ...] = (workspace_id,)
    elif workspace_scope == "personal":
        workspace_clause = "g.workspace_scope='personal'"
        workspace_args = ()
    else:
        workspace_clause = (
            "(g.workspace_scope='unknown' OR g.id IN "
            "(SELECT gen_id FROM task_generation WHERE task_id=?))"
        )
        workspace_args = (tid,)
    return conn.execute(
        "SELECT g.id AS id, g.status AS status, g.creator_uid AS creator_uid, g.model AS model, "
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
        f"AND ({workspace_clause}) "
        "ORDER BY g.is_final DESC, shared DESC, g.sort_ts DESC",
        (tid, tid, fpath, project_id, fpath, seq, project_id, seq, *workspace_args),
    ).fetchall()


def _batch_task_gen_rows(
    conn,
    project_id: Optional[str],
    tasks,
    generation_ids: Optional[set[str]] = None,
) -> dict[str, list[dict[str, Any]]]:
    """모든 작업의 귀속 컷을 '한 번에' 조회 — 작업당 1쿼리(N+1)를 레인별 배치 쿼리로 대체.
    각 작업별 결과는 _task_gen_rows 와 완전히 동일(행·순서·필드) 해야 한다(비교 테스트로 고정).
    레인(작업 메타에 따라):
      · 수동 링크(task_generation) — 항상 포함 + linked=1
      · 폴더 레인(folder_path 있음) — g.project_id=? AND g.folder_path=작업.folder_path
      · 시퀀스 레인(folder_path 없음 + sequence 있음) — auto_tag.name=작업.sequence
    정렬: is_final DESC, shared DESC, sort_ts DESC (SQLite 와 동일 — NULL sort_ts 는 뒤)."""
    task_ids = [t["id"] for t in tasks]
    if not task_ids:
        return {}
    # 단일 프로젝트 호출은 기존 project_id 인자를 쓰고, 다중 프로젝트 호출은 각 행의 project_id 를 쓴다.
    task_projects = {
        t["id"]: (t["project_id"] if "project_id" in t.keys() else project_id)
        for t in tasks
    }
    task_scopes = {
        task["id"]: _task_workspace(task)[:2]
        for task in tasks
    }
    # 작업별 (folder_path, sequence) — 폴더작업이면 시퀀스 레인 비활성(원 함수와 동일 규칙).
    meta: dict[str, tuple[Optional[str], Optional[str]]] = {}
    for t in tasks:
        fpath = (t["folder_path"] or "").strip() or None
        seq = (t["sequence"] or "").strip() or None
        if fpath is not None:
            seq = None
        meta[t["id"]] = (fpath, seq)

    membership: dict[str, set[str]] = {tid: set() for tid in task_ids}
    linked: dict[str, set[str]] = {tid: set() for tid in task_ids}

    # generation_ids 제한(완료본 단건 판정용)은 레인 SQL 에 직접 밀어 넣는다 — 교집합만으로는
    # 결과는 같아도 프로젝트 전수 행을 읽은 뒤 버리는 스캔이 남는다(코덱스 P2). 아래 교집합은
    # 정확성의 권위로 유지한다. IN 목록이 SQLite 변수 상한을 위협하면 SQL 제한은 생략한다.
    gen_ids_sql: Optional[list[str]] = None
    if generation_ids is not None and 0 < len(generation_ids) <= _SQLITE_IN_BATCH:
        gen_ids_sql = sorted(generation_ids)
    gen_ph = ",".join("?" * len(gen_ids_sql)) if gen_ids_sql else ""

    # ① 수동 링크 — 항상 포함 + linked 표시.
    manual_gen_filter = f" AND gen_id IN ({gen_ph})" if gen_ids_sql else ""
    for task_batch in _batched(task_ids):
        ph_t = ",".join("?" * len(task_batch))
        for r in conn.execute(
            f"SELECT task_id, gen_id FROM task_generation WHERE task_id IN ({ph_t})"
            + manual_gen_filter,
            [*task_batch, *(gen_ids_sql or [])],
        ):
            tid, gid = r["task_id"], r["gen_id"]
            if tid in membership:
                membership[tid].add(gid)
                linked[tid].add(gid)

    # ② 폴더 레인 — project_id+folder_path 키로 정확히 매핑한다. 두 IN 목록은 400개씩 나눠
    # 오래된 SQLite 변수 상한을 지키면서도 작업×생성물 조인 후보 폭증을 피한다.
    fpath_to_tasks: dict[tuple[str, str], list[str]] = {}
    for tid in task_ids:
        fpath = meta[tid][0]
        pid = task_projects[tid]
        if fpath is not None and pid:
            fpath_to_tasks.setdefault((pid, fpath), []).append(tid)
    if fpath_to_tasks:
        projects = list(dict.fromkeys(pid for pid, _path in fpath_to_tasks))
        fpaths = list(dict.fromkeys(path for _pid, path in fpath_to_tasks))
        for project_batch in _batched(projects, _SQLITE_PAIRED_IN_BATCH):
            for fpath_batch in _batched(fpaths, _SQLITE_PAIRED_IN_BATCH):
                ph_p = ",".join("?" * len(project_batch))
                ph_f = ",".join("?" * len(fpath_batch))
                for r in conn.execute(
                    f"SELECT id, project_id, folder_path, workspace_scope, workspace_id "
                    f"FROM generation "
                    f"WHERE project_id IN ({ph_p}) AND deleted_at IS NULL "
                    f"AND folder_path IN ({ph_f})"
                    + (f" AND id IN ({gen_ph})" if gen_ids_sql else ""),
                    [*project_batch, *fpath_batch, *(gen_ids_sql or [])],
                ):
                    for tid in fpath_to_tasks.get((r["project_id"], r["folder_path"]), []):
                        scope, workspace_id = task_scopes[tid]
                        if _same_workspace(scope, workspace_id, r):
                            membership[tid].add(r["id"])

    # ③ 시퀀스 레인 — folder_path 없고 sequence 있는 작업. project_id+auto_tag.name 키로 매핑.
    seq_to_tasks: dict[tuple[str, str], list[str]] = {}
    for tid in task_ids:
        fpath, seq = meta[tid]
        pid = task_projects[tid]
        if fpath is None and seq is not None and pid:
            seq_to_tasks.setdefault((pid, seq), []).append(tid)
    if seq_to_tasks:
        projects = list(dict.fromkeys(pid for pid, _seq in seq_to_tasks))
        seqs = list(dict.fromkeys(seq for _pid, seq in seq_to_tasks))
        for project_batch in _batched(projects, _SQLITE_PAIRED_IN_BATCH):
            for seq_batch in _batched(seqs, _SQLITE_PAIRED_IN_BATCH):
                ph_p = ",".join("?" * len(project_batch))
                ph_s = ",".join("?" * len(seq_batch))
                for r in conn.execute(
                    f"SELECT g.id AS id, g.project_id AS project_id, at.name AS seqname, "
                    f"g.workspace_scope AS workspace_scope, g.workspace_id AS workspace_id "
                    f"FROM generation g "
                    f"JOIN gen_auto_tag gat ON gat.generation_id=g.id "
                    f"JOIN auto_tag at ON at.id=gat.auto_tag_id "
                    f"WHERE g.project_id IN ({ph_p}) AND g.deleted_at IS NULL "
                    f"AND at.name IN ({ph_s})"
                    + (f" AND g.id IN ({gen_ph})" if gen_ids_sql else ""),
                    [*project_batch, *seq_batch, *(gen_ids_sql or [])],
                ):
                    for tid in seq_to_tasks.get((r["project_id"], r["seqname"]), []):
                        scope, workspace_id = task_scopes[tid]
                        if _same_workspace(scope, workspace_id, r):
                            membership[tid].add(r["id"])

    # generation_ids 제한(완료본 단건 판정용) — 레인 산출 뒤 교집합이라 무제한 결과에서
    # 해당 id 만 남긴 것과 정확히 같다(레인·워크스페이스·정렬 규칙 무변).
    if generation_ids is not None:
        for tid in membership:
            membership[tid] &= generation_ids

    # 등장한 모든 gen_id 상세를 1회 조회(원 함수의 컬럼·서브쿼리 그대로).
    all_ids: set[str] = set()
    for s in membership.values():
        all_ids |= s
    detail: dict[str, dict[str, Any]] = {}
    if all_ids:
        idlist = list(all_ids)
        for id_batch in _batched(idlist):
            ph_g = ",".join("?" * len(id_batch))
            for g in conn.execute(
                f"SELECT g.id AS id, g.status AS status, g.creator_uid AS creator_uid, g.model AS model, "
                f"  g.is_final AS is_final, g.created_at AS created_at, g.job_id AS job_id, "
                f"  g.workspace_scope AS workspace_scope, g.workspace_id AS workspace_id, "
                f"  g.sort_ts AS sort_ts, "
                f"  EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared, "
                f"  (SELECT COALESCE(a.thumbnail_path, CASE WHEN a.type='video' THEN NULL ELSE a.file_path END) "
                f"   FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS thumb, "
                f"  (SELECT a.type FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS media_type, "
                f"  (SELECT a.file_path FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS file_path "
                # ★deleted_at IS NULL — 원 함수는 이 필터를 전체 lane 바깥에 둬서 수동 링크 삭제물도 제외.
                f"FROM generation g WHERE g.id IN ({ph_g}) AND g.deleted_at IS NULL",
                id_batch,
            ):
                detail[g["id"]] = dict(g)

    def _order(g):
        st = g["sort_ts"]
        return (
            -(g["is_final"] or 0),
            -(g["shared"] or 0),
            (0, -st) if st is not None else (1, 0.0),  # sort_ts DESC, NULL 뒤(SQLite 동일)
            g["id"],  # 완전 동점(is_final·shared·sort_ts 동일) 시 결정적 순서(원 SQL 은 미정의였음)
        )

    result: dict[str, list[dict[str, Any]]] = {}
    for tid in task_ids:
        gens = []
        for gid in membership[tid]:
            d = detail.get(gid)
            scope, workspace_id = task_scopes[tid]
            if not d or not _same_workspace(
                scope, workspace_id, d, explicitly_linked=gid in linked[tid]
            ):
                continue
            row = dict(d)
            row["linked"] = 1 if gid in linked[tid] else 0
            row.pop("workspace_scope", None)
            row.pop("workspace_id", None)
            gens.append(row)
        gens.sort(key=_order)
        for row in gens:
            row.pop("sort_ts", None)  # 정렬용 내부값 — 원 함수 출력엔 없으므로 제거(shape 일치)
        result[tid] = gens
    return result


def sync_folder_tasks(conn, project_id: str) -> None:
    """폴더로 라벨링된 생성물에서 작업 카드를 자동 생성·갱신한다.

    프로젝트의 distinct folder_path 마다 project_task 1개를 보장 — name=1단계(예 ep001),
    sequence=2단계(예 c0010), folder_path=전체 경로. INSERT OR IGNORE + (project_id, folder_path)
    유니크 인덱스로 이미 있으면 건너뜀 → PM 이 편집한 status/일정/설명을 절대 덮어쓰지 않는다.
    폴더/생성물이 사라져도 자동 작업을 삭제하지 않는다(편집 정보 유실 방지). 마지막 생성이
    프로젝트 설정 기간보다 오래됐고 계획 마감일도 지났을 때만 archived=1로 전환한다."""
    sync_folder_tasks_batch(conn, [project_id])


def sync_folder_tasks_batch(
    conn, project_ids: list[str], folder_paths: Optional[list[str]] = None
) -> None:
    """여러 프로젝트의 폴더 작업을 한 조회로 동기화하고 수명주기를 갱신한다.

    팀 프로젝트는 프로젝트와 같은 workspace의 생성물만 작업으로 인정한다. 기존 행은 삭제하지
    않고 마지막 관측 시각을 갱신하며, 새 생성물이 다시 보이면 과거 기록에서 자동 복원한다.

    folder_paths 를 주면 그 폴더의 자동 작업 보장만 수행한다(완료본 단건 판정용 —
    프로젝트 전체 GROUP BY 를 피한다). 이때 백필·보관 수명주기 갱신은 건너뛴다:
    판정에 영향이 없고(archived 는 제외 조건이 아님), 목록 GET 경로가 늘 수행한다.
    """
    project_ids = list(dict.fromkeys(pid for pid in project_ids if pid))
    if not project_ids:
        return
    if folder_paths is not None:
        folder_paths = list(dict.fromkeys(fp for fp in folder_paths if fp))
        if not folder_paths:
            return
    # task_projects_for_workspace는 워크스페이스 전체 프로젝트를 넘길 수 있다. SQLite
    # 변수 상한보다 큰 IN 절을 만들지 않도록 같은 연결 안에서 안전한 크기로 나눈다.
    if len(project_ids) > _SQLITE_IN_BATCH:
        for batch in _batched(project_ids):
            sync_folder_tasks_batch(conn, batch, folder_paths)
        return
    placeholders = ",".join("?" * len(project_ids))
    folder_filter = ""
    folder_args: list[str] = []
    if folder_paths is not None:
        folder_filter = " AND g.folder_path IN (" + ",".join("?" * len(folder_paths)) + ")"
        folder_args = folder_paths
    source_rows = conn.execute(
        "SELECT g.project_id, g.folder_path, g.workspace_scope, g.workspace_id, "
        "MAX(g.workspace_name) AS workspace_name, "
        "MAX(COALESCE(NULLIF(g.created_at, ''), datetime(g.sort_ts, 'unixepoch'))) "
        "AS source_last_seen_at FROM generation g "
        "WHERE g.project_id IN (" + placeholders + ") "
        "  AND g.folder_path IS NOT NULL AND g.folder_path<>'' "
        "  AND g.deleted_at IS NULL" + folder_filter + " "
        "GROUP BY g.project_id, g.folder_path, g.workspace_scope, g.workspace_id",
        [*project_ids, *folder_args],
    ).fetchall()
    fps: dict[tuple[str, str, str, Optional[str]], dict[str, Any]] = {}
    for raw in source_rows:
        scope, workspace_id, workspace_name = _task_workspace(raw)
        key = (raw["project_id"], raw["folder_path"], scope, workspace_id)
        row = dict(raw)
        row.update(
            workspace_scope=scope,
            workspace_id=workspace_id,
            workspace_name=workspace_name,
        )
        previous = fps.get(key)
        if previous is None or str(row["source_last_seen_at"] or "") > str(
            previous["source_last_seen_at"] or ""
        ):
            fps[key] = row
    # ★읽기(list_tasks*)마다 호출된다 — 변화가 없는 정상 상태에선 write 0회를 보장해야
    # 여러 클라이언트가 30초 폴링하는 공유 서버에서 GET 이 SQLite 쓰기락을 다투지 않는다.
    # (같은 값 UPDATE 도 행 재기록 = WAL 증가이므로, 기존 값을 먼저 읽어 달라진 행만 쓴다.)
    existing: dict[tuple[str, str, str, Optional[str]], Any] = {}
    existing_folder_filter = folder_filter.replace("g.folder_path", "folder_path")
    for r in conn.execute(
            "SELECT id, project_id, folder_path, source_kind, source_last_seen_at, archived, "
            "workspace_scope, workspace_id, workspace_name "
            "FROM project_task WHERE project_id IN (" + placeholders + ") "
            "AND folder_path IS NOT NULL AND folder_path<>''" + existing_folder_filter,
            [*project_ids, *folder_args],
        ):
        scope, workspace_id, _workspace_name = _task_workspace(r)
        # 불완전한 구행도 source 쪽과 같은 정규화 키로 찾는다. 그렇지 않으면 같은 폴더의
        # unknown 작업을 하나 더 만들어 중복 카드가 생긴다.
        existing[(r["project_id"], r["folder_path"], scope, workspace_id)] = r
    for row in fps.values():
        fp = row["folder_path"]
        parts = [seg for seg in fp.replace("\\", "/").split("/") if seg]
        if not parts:
            continue
        name = parts[0]
        sequence = parts[1] if len(parts) > 1 else None
        cur = existing.get(
            (row["project_id"], fp, row["workspace_scope"], row["workspace_id"])
        )
        if cur is None:
            conn.execute(
                "INSERT OR IGNORE INTO project_task"
                "(id, project_id, name, status, sequence, folder_path, source_kind, "
                " source_last_seen_at, archived, workspace_scope, workspace_id, workspace_name, "
                " workspace_origin) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,'generation')",
                (
                    new_id(), row["project_id"], name, "not_started", sequence, fp,
                    "generation", row["source_last_seen_at"], row["workspace_scope"],
                    row["workspace_id"], row["workspace_name"],
                ),
            )
            continue
        # PM이 편집한 이름·상태·일정은 보존하고 자동 수명주기 필드만, 달라졌을 때만 갱신한다.
        if (
            cur["source_kind"] != "generation"
            or cur["source_last_seen_at"] != row["source_last_seen_at"]
            or cur["archived"]
        ):
            conn.execute(
                "UPDATE project_task SET source_kind='generation', source_last_seen_at=?, archived=0 "
                "WHERE id=?",
                (row["source_last_seen_at"], cur["id"]),
            )

    if folder_paths is not None:
        # targeted 모드: 이 폴더의 작업 보장까지만 — 수명주기(백필·보관)는 목록 GET 몫.
        return

    # 구 DB에서 생성 기반 작업으로 분류됐지만 마지막 관측 시각이 없는 행은
    # 작업 생성 시각을 최초 기준으로 삼는다. 이값조차 추측하지 않고 남겨두지 않게 한다.
    # (대상이 있을 때만 UPDATE — 읽기 무쓰기 유지)
    backfill_where = (
        "project_id IN (" + placeholders + ") "
        "AND source_kind='generation' AND source_last_seen_at IS NULL"
    )
    if conn.execute(
        "SELECT 1 FROM project_task WHERE " + backfill_where + " LIMIT 1", project_ids
    ).fetchone():
        conn.execute(
            "UPDATE project_task SET source_last_seen_at=created_at WHERE " + backfill_where,
            project_ids,
        )

    # 보관 조건 = 마지막 관측+N일이 지났고, 작업/프로젝트 계획 마감일도 모두 지남.
    # 삭제가 아니라 archived 플래그만 바꾸므로 PM 메모·배정·수동 링크는 보존된다.
    # (동일 조건 SELECT 로 대상 유무를 먼저 확인 — 정상 상태 GET 은 쓰기 트랜잭션이 되지 않는다)
    archive_where = (
        "project_id IN (" + placeholders + ") "
        "AND source_kind='generation' AND archived=0 "
        "AND source_last_seen_at IS NOT NULL "
        "AND datetime(source_last_seen_at, printf('+%d days', "
        "  MAX(1, MIN(COALESCE((SELECT pp.archive_after_days FROM project_planning pp "
        "                           WHERE pp.project_id=project_task.project_id), 30), 3650))"
        ")) < datetime('now') "
        "AND (due_date IS NULL OR TRIM(due_date)='' OR date(due_date)<date('now')) "
        "AND NOT EXISTS (SELECT 1 FROM project_planning pp "
        "                WHERE pp.project_id=project_task.project_id "
        "                  AND pp.due_date IS NOT NULL AND TRIM(pp.due_date)<>'' "
        "                  AND date(pp.due_date)>=date('now'))"
    )
    if conn.execute(
        "SELECT 1 FROM project_task WHERE " + archive_where + " LIMIT 1", project_ids
    ).fetchone():
        conn.execute(
            "UPDATE project_task SET archived=1 WHERE " + archive_where, project_ids
        )


def _list_tasks_batch_uncached(
    project_ids: list[str], *, include_archived: bool = False, workspace_id: Optional[str] = None
) -> dict[str, list[dict[str, Any]]]:
    """여러 프로젝트의 작업과 파생값을 한 DB 조회 묶음으로 반환한다.

    작업 목록 + 귀속 생성물 파생(컷 썸네일·생성자·크레딧·제작시간·코멘트수).
    귀속=폴더/시퀀스 자동(2레인) ∪ 수동 링크. 보드/테이블/캘린더가 같은 이 데이터를 쓴다.
    조회 전에 폴더 자동 작업을 멱등 동기화(create-only)한다. 프로젝트 수와 무관하게 컷·담당·
    메트릭·코멘트·이름 집계를 각각 한 번만 실행한다."""
    project_ids = list(dict.fromkeys(pid for pid in project_ids if pid))
    if not project_ids:
        return {}
    with get_connection() as conn:
        _ensure_schema(conn)
        sync_folder_tasks_batch(conn, project_ids)
        placeholders = ",".join("?" * len(project_ids))
        archived_filter = "" if include_archived else " AND t.archived=0"
        workspace_filter = ""
        workspace_args: list[Any] = []
        unresolved_task = unresolved_workspace_sql("t")
        if workspace_id:
            # 미상 작업은 현재 프로젝트가 선택 공간에 있을 때만 관리자 확인용으로 보인다.
            # 이동한 프로젝트의 과거 화면에 미상 PM 메타를 임의 귀속해 노출하지 않는다.
            workspace_filter = (
                " AND ((LOWER(TRIM(COALESCE(t.workspace_scope, '')))='team' "
                "AND TRIM(COALESCE(t.workspace_id, ''))=?) OR ("
                + unresolved_task
                + " AND p.workspace_scope='team' AND p.workspace_id=?))"
            )
            workspace_args += [workspace_id, workspace_id]
        else:
            workspace_filter = (
                " AND (" + unresolved_task + " OR "
                "(LOWER(TRIM(COALESCE(t.workspace_scope, '')))='team' "
                " AND p.workspace_scope='team' "
                " AND TRIM(COALESCE(t.workspace_id, ''))=p.workspace_id) OR "
                "(LOWER(TRIM(COALESCE(t.workspace_scope, '')))='personal' "
                " AND p.workspace_scope='personal'))"
            )
        rows = conn.execute(
            f"SELECT t.* FROM project_task t LEFT JOIN project p ON p.id=t.project_id "
            f"WHERE t.project_id IN ({placeholders}){archived_filter}{workspace_filter} "
            "ORDER BY t.project_id, COALESCE(t.sort_order, 1000000), t.created_at",
            [*project_ids, *workspace_args],
        ).fetchall()
        project_workspaces = {
            row["id"]: _task_workspace(row)
            for row in conn.execute(
                f"SELECT id, workspace_scope, workspace_id, workspace_name "
                f"FROM project WHERE id IN ({placeholders})",
                project_ids,
            ).fetchall()
        }
        out = []
        all_creator_uids: set[str] = set()
        all_gen_ids: set[str] = set()
        # 1차: 작업별 컷을 '한 번에' 확보(작업당 1쿼리 N+1 → 레인별 배치) + 전체 gen_id 수집.
        per_task_cuts: dict[str, list[dict[str, Any]]] = _batch_task_gen_rows(conn, None, rows)
        for r in rows:
            for g in per_task_cuts.get(r["id"], []):
                if g["creator_uid"]:
                    all_creator_uids.add(g["creator_uid"])
                all_gen_ids.add(g["id"])
        # 담당(배정) 배치 조회 — 실제 생성자(per_task_cuts)와 별개 축. PM 이 대시보드에서 배정한다.
        task_ids = [r["id"] for r in rows]
        assigned_by_task: dict[str, list[str]] = {}
        if task_ids:
            for pr in conn.execute(
                f"SELECT ta.task_id, ta.assignee_uid FROM task_assignment ta "
                f"JOIN project_task t ON t.id=ta.task_id "
                f"WHERE t.project_id IN ({placeholders}) ORDER BY ta.created_at",
                project_ids,
            ).fetchall():
                if pr["task_id"] in per_task_cuts:
                    assigned_by_task.setdefault(pr["task_id"], []).append(pr["assignee_uid"])
                    all_creator_uids.add(pr["assignee_uid"])
        # ★배치 집계 — 작업 P개마다 반복하던 metrics/comment 쿼리(≈2P회)를 전체 gen_id 로 1회씩.
        # elapsed 는 raw(NULL 유지) — '없음(NULL)'과 '0초'를 구분해야 manage_hub 폴백이 가능(코덱스).
        metrics_by_gen: dict[str, tuple] = {}   # gen_id -> (credits, elapsed|None)
        comments_by_gen: dict[str, int] = {}    # gen_id -> 코멘트 수
        if all_gen_ids:
            idlist = list(all_gen_ids)
            for id_batch in _batched(idlist):
                ph = ",".join("?" * len(id_batch))
                for m in conn.execute(
                    f"SELECT gen_id, COALESCE(real_credits, est_credits) AS credits, "
                    f"  elapsed_seconds AS elapsed "
                    f"FROM generation_metrics WHERE gen_id IN ({ph})",
                    id_batch,
                ):
                    metrics_by_gen[m["gen_id"]] = (m["credits"] or 0, m["elapsed"])
                for c in conn.execute(
                    # 비공개 코멘트는 팀 통계에 세지 않는다(존재 자체가 개인 정보)
                    f"SELECT gen_id, COUNT(*) AS c FROM generation_comment "
                    f"WHERE gen_id IN ({ph}) AND is_private=0 GROUP BY gen_id",
                    id_batch,
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
            for job_batch in _batched(list(dict.fromkeys(need_job_ids))):
                elapsed_by_job.update(manage_db.elapsed_by_job_ids(job_batch))
        # 개인 작업표가 작업 전체 합계가 아니라 '내가 만든 컷'만 다시 합산할 수 있도록
        # 컷별 소요시간도 응답에 싣는다. 콘텐츠 DB 값이 없으면 위 텔레메트리 폴백을 그대로 쓴다.
        elapsed_by_gen: dict[str, float] = {}
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
                cut_elapsed = e or 0
                elapsed_by_gen[g["id"]] = cut_elapsed
                elapsed += cut_elapsed
            cc = sum(comments_by_gen.get(gid, 0) for gid in gen_ids)
            d = dict(r)
            task_scope, task_workspace_id, task_workspace_name = _task_workspace(r)
            # 응답도 Python/SQL 판정과 같은 정규형으로 내려 프론트가 불완전한 구데이터를
            # 현재 team 작업으로 오인하지 않게 한다. 원본 DB 행 자체는 삭제·추측 수정하지 않는다.
            d["workspace_scope"] = task_scope
            d["workspace_id"] = task_workspace_id
            d["workspace_name"] = task_workspace_name
            d["workspace_unresolved"] = task_scope == "unknown"
            project_scope, project_workspace_id, _project_name = project_workspaces.get(
                r["project_id"], ("unknown", None, None)
            )
            d["workspace_historical"] = task_scope != "unknown" and not (
                (task_scope == "team" and project_scope == "team" and task_workspace_id == project_workspace_id)
                or (task_scope == "personal" and project_scope == "personal")
            )
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
                or assigned_by_task.get(r["id"]) or r["description"] or r["status"] == "omit"
            )
            # 과거 기록 화면에서는 실제로 보관 처리된 자동 작업을 보여줘야 한다. 단순히 생성물이
            # 사라진 활성 유령 행은 include_archived=True여도 계속 숨긴다.
            show_archived_history = include_archived and bool(r["archived"])
            if (
                r["folder_path"]
                and d["gen_count"] == 0
                and not pm_edited
                and not show_archived_history
            ):
                continue
            out.append(d)
        # 작성자·담당자 이름 일괄 해석(단일 해석기) 후 작업별 부착.
        # all_creator_uids 에 담당(assignee)도 이미 포함(위 배치 조회에서 add).
        names: dict[str, Optional[str]] = {}
        for uid_batch in _batched(list(all_creator_uids)):
            names.update(resolve_display_names(conn, uid_batch))
        for d in out:
            seen: list[str] = []
            for c in per_task_cuts[d["id"]]:
                nm = names.get(c["creator_uid"]) if c["creator_uid"] else None
                if nm and nm not in seen:
                    seen.append(nm)
                c["creator_name"] = nm
                # 컷별 수치 — 프론트가 현재 작업자 기준으로 생성수·크레딧·시간·댓글을
                # 자동 재집계할 때 사용한다. 작업 전체 합계와 같은 원본 값을 공유한다.
                c["credits"] = metrics_by_gen.get(c["id"], (0, None))[0]
                c["elapsed"] = elapsed_by_gen.get(c["id"], 0)
                c["comment_count"] = comments_by_gen.get(c["id"], 0)
                c.pop("job_id", None)  # 폴백 계산용 내부값 — 응답(컷)엔 노출 안 함(코덱스)
            d["cuts"] = per_task_cuts[d["id"]]
            d["creators"] = seen  # 실제 생성자(연결 컷 파생) — 기존 필터·캘린더 호환 유지
            # 담당(배정, 복수) — {uid, name}. 대시보드에서 지정, 작업탭 '내 배분' 필터·표시에 사용.
            d["assigned_creators"] = [
                {"uid": u, "name": names.get(u)} for u in assigned_by_task.get(d["id"], [])
            ]
        by_project = {project_id: [] for project_id in project_ids}
        for task in out:
            by_project[task["project_id"]].append(task)
        return by_project


def list_tasks_batch(
    project_ids: list[str], *, include_archived: bool = False, workspace_id: Optional[str] = None
) -> dict[str, list[dict[str, Any]]]:
    """동일한 동시 작업 조회는 한 번만 계산하고 DB 변경 시 즉시 다시 계산한다.

    응답 조립은 200개 작업 기준 수십 ms가 들며 100명이 같은 폴링 시각에 들어오면 CPU 큐가
    길어진다. 내용 DB·WAL·elapsed 보조 DB 표식이 앞뒤로 같은 경우에만 0.75초 동안 불변 결과를
    공유한다. 계산 중 쓰기가 끼면 캐시하지 않으므로 변경 전후가 섞인 결과도 재사용하지 않는다.
    """
    project_ids = list(dict.fromkeys(pid for pid in project_ids if pid))
    if not project_ids or _TASK_READ_CACHE_TTL <= 0:
        return _list_tasks_batch_uncached(
            project_ids, include_archived=include_archived, workspace_id=workspace_id
        )
    key = (
        str(get_db_path()),
        tuple(project_ids),
        bool(include_archived),
        str(workspace_id or ""),
    )
    stamp = _task_cache_stamp()
    if stamp is None:
        return _list_tasks_batch_uncached(
            project_ids, include_archived=include_archived, workspace_id=workspace_id
        )
    cached = _task_cache_hit(key, stamp, time.monotonic())
    if cached is not None:
        return cached

    with _task_flight_lock(key):
        stamp = _task_cache_stamp()
        if stamp is None:
            return _list_tasks_batch_uncached(
                project_ids, include_archived=include_archived, workspace_id=workspace_id
            )
        cached = _task_cache_hit(key, stamp, time.monotonic())
        if cached is not None:
            return cached
        result = _list_tasks_batch_uncached(
            project_ids, include_archived=include_archived, workspace_id=workspace_id
        )
        if _task_cache_stamp() == stamp:
            with _TASK_READ_CACHE_GUARD:
                _TASK_READ_CACHE[key] = (
                    time.monotonic() + _TASK_READ_CACHE_TTL,
                    stamp,
                    result,
                )
                if len(_TASK_READ_CACHE) > 128:
                    oldest = min(_TASK_READ_CACHE, key=lambda item: _TASK_READ_CACHE[item][0])
                    if oldest != key:
                        _TASK_READ_CACHE.pop(oldest, None)
        return result


def list_tasks(
    project_id: str, *, include_archived: bool = False, workspace_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """단일 프로젝트 호환 API. 실제 조회는 다중 프로젝트 배치 경로를 공유한다."""
    return list_tasks_batch(
        [project_id], include_archived=include_archived, workspace_id=workspace_id
    ).get(project_id, [])


def add_assignment(task_id: str, assignee_uid: str, added_by: Optional[str]) -> bool:
    """작업에 담당(배정) 추가(멱등). PM 이 대시보드에서 작업자를 배정할 때."""
    assignee_uid = (assignee_uid or "").strip()
    if not assignee_uid:
        return False
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        if task_id not in _assert_tasks_current_for_write(conn, [task_id]):
            return False
        conn.execute(
            "INSERT INTO task_assignment(task_id, assignee_uid, added_by) VALUES(?,?,?) "
            "ON CONFLICT(task_id, assignee_uid) DO NOTHING",
            (task_id, assignee_uid, added_by),
        )
    return True


def remove_assignment(task_id: str, assignee_uid: str) -> bool:
    """작업 담당(배정)에서 제거."""
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        if task_id not in _assert_tasks_current_for_write(conn, [task_id]):
            return False
        cur = conn.execute(
            "DELETE FROM task_assignment WHERE task_id=? AND assignee_uid=?",
            (task_id, (assignee_uid or "").strip()),
        )
        return cur.rowcount > 0


def is_assignee(task_id: str, uid: str) -> bool:
    """그 작업에 배정된 작업자인가 — 배정 작업자의 '진행'(제한적 patch) 권한 판정용."""
    uid = (uid or "").strip()
    if not uid:
        return False
    with get_connection() as conn:
        _ensure_schema(conn)
        return bool(
            conn.execute(
                "SELECT 1 FROM task_assignment WHERE task_id=? AND assignee_uid=?",
                (task_id, uid),
            ).fetchone()
        )


def bulk_set_assignments(
    items: list[dict[str, Any]], mode: str, added_by: Optional[str]
) -> int:
    """여러 작업의 담당(배정)을 한 트랜잭션으로 설정.
    mode='replace'(전체 교체) | 'add'(추가) | 'remove'(지정 담당만 해제).
    items=[{task_id, assignee_uids}].
    한 번에 전부 성공/실패(원자). 권한은 라우터가 프로젝트별로 검사한 뒤 호출한다."""
    if mode not in ("replace", "add", "remove"):
        raise ValueError(f"지원하지 않는 배정 모드: {mode}")
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        try:
            _assert_tasks_current_for_write(
                conn, [str(it.get("task_id") or "") for it in items]
            )
            for it in items:
                tid = it.get("task_id")
                if not tid:
                    continue
                uids = [(u or "").strip() for u in (it.get("assignee_uids") or []) if (u or "").strip()]
                if mode == "replace":
                    conn.execute("DELETE FROM task_assignment WHERE task_id=?", (tid,))
                if mode == "remove":
                    conn.executemany(
                        "DELETE FROM task_assignment WHERE task_id=? AND assignee_uid=?",
                        [(tid, uid) for uid in uids],
                    )
                    continue
                for u in uids:
                    conn.execute(
                        "INSERT INTO task_assignment(task_id, assignee_uid, added_by) "
                        "VALUES(?,?,?) ON CONFLICT(task_id, assignee_uid) DO NOTHING",
                        (tid, u, added_by),
                    )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return len(items)


def create_task(project_id: str, name: str, **kw: Any) -> dict[str, Any]:
    tid = new_id()
    with get_connection() as conn:
        _ensure_schema(conn)
        # 프로젝트 위치 읽기와 스냅샷 저장 사이에 워크스페이스 이동이 끼지 않게 묶는다.
        conn.execute("BEGIN IMMEDIATE")
        project = conn.execute(
            "SELECT workspace_scope, workspace_id, workspace_name FROM project WHERE id=?",
            (project_id,),
        ).fetchone()
        if not project:
            raise TaskProjectMissingError("없는 프로젝트")
        workspace_scope, workspace_id, workspace_name = _task_workspace(project)
        workspace_origin = "snapshot" if workspace_scope != "unknown" else "unknown"
        conn.execute(
            "INSERT INTO project_task"
            "(id, project_id, name, status, start_date, due_date, sort_order, "
            " note, sequence, description, workspace_scope, workspace_id, workspace_name, "
            " workspace_origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                tid, project_id, name, kw.get("status") or "not_started",
                kw.get("start_date"), kw.get("due_date"),
                kw.get("sort_order"), kw.get("note"),
                kw.get("sequence"), kw.get("description"), workspace_scope, workspace_id,
                workspace_name, workspace_origin,
            ),
        )
        return dict(conn.execute("SELECT * FROM project_task WHERE id=?", (tid,)).fetchone())


def update_task(tid: str, fields: dict[str, Any]) -> Optional[dict[str, Any]]:
    sets = {k: v for k, v in fields.items() if k in _TASK_FIELDS}
    if not sets:
        return None
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        if tid not in _assert_tasks_current_for_write(conn, [tid]):
            return None
        cols = ", ".join(f"{k}=?" for k in sets)
        conn.execute(
            f"UPDATE project_task SET {cols} WHERE id=?", (*sets.values(), tid)
        )
        r = conn.execute("SELECT * FROM project_task WHERE id=?", (tid,)).fetchone()
        return dict(r) if r else None


def task_projects(task_ids: list[str]) -> dict[str, str]:
    """작업 여러 건의 ``task_id -> project_id``를 한 쿼리로 반환한다."""
    if not task_ids:
        return {}
    with get_connection() as conn:
        _ensure_schema(conn)
        placeholders = ",".join("?" * len(task_ids))
        rows = conn.execute(
            f"SELECT id, project_id FROM project_task WHERE id IN ({placeholders})",
            task_ids,
        ).fetchall()
    return {row["id"]: row["project_id"] for row in rows}


def task_projects_for_workspace(
    workspace_id: str, *, include_historical: bool = False
) -> list[dict[str, Any]]:
    """작업 화면 전용 프로젝트 목록. 과거 모드에서는 이동한 프로젝트도 포함한다."""
    workspace_id = str(workspace_id or "").strip()
    if not workspace_id:
        return []
    with get_connection() as conn:
        _ensure_schema(conn)
        historical_clause = (
            " OR EXISTS(SELECT 1 FROM project_task t WHERE t.project_id=p.id "
            "AND LOWER(TRIM(COALESCE(t.workspace_scope, '')))='team' "
            "AND TRIM(COALESCE(t.workspace_id, ''))=?) "
            "OR EXISTS(SELECT 1 FROM generation g WHERE g.project_id=p.id "
            "AND g.deleted_at IS NULL AND g.workspace_scope='team' AND g.workspace_id=?)"
            if include_historical
            else ""
        )
        args: list[Any] = [workspace_id]
        if include_historical:
            args.extend((workspace_id, workspace_id))
        rows = conn.execute(
            "SELECT p.id, p.name, p.workspace_scope, p.workspace_id, p.archived "
            "FROM project p WHERE (p.workspace_scope='team' AND p.workspace_id=?"
            + historical_clause
            + ")"
            + ("" if include_historical else " AND p.archived=0")
            + " ORDER BY p.name COLLATE NOCASE, p.id",
            args,
        ).fetchall()
        return [
            {
                "id": row["id"],
                "name": row["name"],
                "archived": row["archived"],
                "workspace_moved": not (
                    row["workspace_scope"] == "team" and row["workspace_id"] == workspace_id
                ),
            }
            for row in rows
        ]


def bulk_update_task_orders(items: list[tuple[str, int]]) -> int:
    """여러 작업의 표시 순서를 한 트랜잭션으로 저장한다."""
    if not items:
        return 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        _assert_tasks_current_for_write(conn, [task_id for task_id, _sort_order in items])
        conn.executemany(
            "UPDATE project_task SET sort_order=? WHERE id=?",
            [(sort_order, task_id) for task_id, sort_order in items],
        )
    return len(items)


def delete_task(tid: str) -> bool:
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        if tid not in _assert_tasks_current_for_write(conn, [tid]):
            return False
        conn.execute("DELETE FROM task_generation WHERE task_id=?", (tid,))
        conn.execute("DELETE FROM task_assignment WHERE task_id=?", (tid,))
        cur = conn.execute("DELETE FROM project_task WHERE id=?", (tid,))
        return cur.rowcount > 0


def bulk_delete_tasks(task_ids: list[str]) -> int:
    """작업·수동 링크·담당 배정을 한 트랜잭션으로 일괄 삭제한다."""
    if not task_ids:
        return 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        _assert_tasks_current_for_write(conn, task_ids)
        placeholders = ",".join("?" * len(task_ids))
        existing = conn.execute(
            f"SELECT id FROM project_task WHERE id IN ({placeholders})",
            task_ids,
        ).fetchall()
        existing_ids = [row["id"] for row in existing]
        if not existing_ids:
            return 0
        existing_placeholders = ",".join("?" * len(existing_ids))
        conn.execute(
            f"DELETE FROM task_generation WHERE task_id IN ({existing_placeholders})",
            existing_ids,
        )
        conn.execute(
            f"DELETE FROM task_assignment WHERE task_id IN ({existing_placeholders})",
            existing_ids,
        )
        conn.execute(
            f"DELETE FROM project_task WHERE id IN ({existing_placeholders})",
            existing_ids,
        )
    return len(existing_ids)
