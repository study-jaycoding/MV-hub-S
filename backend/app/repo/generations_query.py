"""생성본(generation) 조회/직렬화 — 읽기 전용 계열(generations.py 에서 분리).

list_generations·get_generation·통계·코멘트수. 쓰기(생성·상태·삭제)와 달리 순수 조회라
쓰기 함수에 의존하지 않는다(단방향: query -> generation_rows/_common). 파사드 re-export 로
`repo.get_generation` 등 외부 API 는 동일하게 유지된다.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from ._common import ALERT_COMMENT_JOINS, ALERT_COMMENT_PREDICATE, GEN_BASE_JOINS
from .generation_rows import (  # 조회 응답 보강·행 페치 — 단방향 import
    _attach_children,
    _fetch_generation,
    _fetch_gens,
)
from ._visibility import team_generation_visibility_clause

# FTS5(generation_fts) 존재 여부 — 검색 경로 선택용. DB 경로별로 1회 확인 후 메모이즈.
# ★경로로 키잉: 계정 전환·DB 이관으로 활성 DB 가 바뀌면 재확인한다(예전엔 전역 bool 로 1회만 확인해,
#   FTS 있는 DB 로 시작 후 FTS 없는 DB 로 전환하면 없는 테이블에 MATCH 를 던져 검색이 500 났다).
_FTS_READY: Optional[bool] = None
_FTS_READY_PATH: Optional[str] = None


def _fts_ready() -> bool:
    """FTS5 검색 인덱스가 준비됐는지(없으면 LIKE 폴백). 활성 DB 경로가 바뀔 때만 재확인."""
    global _FTS_READY, _FTS_READY_PATH
    from ..db import get_db_path

    path = str(get_db_path())
    if _FTS_READY is None or _FTS_READY_PATH != path:
        _FTS_READY_PATH = path
        with get_connection() as conn:
            _FTS_READY = bool(
                conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_fts'"
                ).fetchone()
            )
    return _FTS_READY


def list_generations(
    *,
    tab: str = "my",
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = None,  # None | 'mine'(내가 공유) | 'received'(타 작업자 공유본)
    local_only: bool = False,  # 힉스필드에 없고 로컬에만 있는 것(job_id 없음 or hf_missing)
    creator_uid: Optional[str] = None,  # 특정 생성자(팀원)만
    workspace_id: Optional[str] = None,  # 선택한 팀 워크스페이스. 개인 선택은 None=전체
    account_uid: Optional[str] = None,  # 로그인 계정의 생성자 uid — tab='my' 를 이 계정 것만으로 한정
    team_member_projects: Optional[list[str]] = None,  # tab='team' 일 때 내가 멤버인 프로젝트의 공유물만(None=전체)
    project_id: Optional[str] = None,  # 프로젝트 귀속 필터. 'none'=미분류(NULL), 그 외=해당 프로젝트
    folder_path: Optional[str] = None,  # 폴더 접두사 필터 — 그 폴더 + 하위 전부(prefix). 없으면 미적용
    search: Optional[str] = None,
    include_deleted: bool = False,  # 휴지통(soft delete) 포함 여부. 기본은 제외(정상만)
    deleted_only: bool = False,  # 지운 것만 보기(휴지통 전용 뷰). include_deleted 보다 우선
    # 서버사이드 인스턴트 필터(무한 스크롤이 서버에서 거르도록 — 클라이언트 전량 로드 제거):
    media_type: Optional[str] = None,  # image|video|audio (무자산 pending 은 항상 통과)
    colors: Optional[list[str]] = None,  # 다중 컬러(OR)
    tags: Optional[list[str]] = None,  # 다중 태그(OR)
    auto_tags: Optional[list[str]] = None,  # 무장된 전역 태그(OR)
    shared_only: bool = False,  # 팀 공유된 것만(내 작업 탭 내 토글)
    comment_only: bool = False,  # 코멘트가 하나라도 있는 것만
    final_only: bool = False,  # 최종(골드)으로 지정된 것만
    limit: int = 500,
    # 키셋(seek) 페이지네이션 커서 — 직전 페이지 마지막 행의 (sort_ts, id). 둘 다 주면 그 뒤부터.
    # OFFSET 을 대체(건너뛴 N행 스캔 제거) → 수만 번째 페이지도 일정 속도.
    cursor_ts: Optional[float] = None,
    cursor_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """필터 적용된 generation 목록(DESIGN.md §4 좌측 필터).

    tab='team' 이면 공유된 것만 보여준다(로컬 단일 DB 에서 팀 공유 갤러리 모사).
    """
    where: list[str] = []
    args: list[Any] = []
    actor_uid = account_uid if account_uid and account_uid != "\x00" else None

    if deleted_only:
        where.append("g.deleted_at IS NOT NULL")  # 휴지통 전용 뷰 — 지운 것만
    elif not include_deleted:
        where.append("g.deleted_at IS NULL")  # 휴지통 제외(기본)
    if tab == "team":
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)")
        # 공유물은 내가 만든 것 또는 내가 멤버인 프로젝트에 속한 것만.
        # 작성자 본인 예외를 둬야 프로젝트 미배정/비멤버 프로젝트로 정리된 내 공유물이
        # 관리자에게만 보이고 정작 본인에게 숨는 일을 막을 수 있다.
        # team_member_projects=None 이면(read_all·단독) 전체 공유물.
        visibility, visibility_args = team_generation_visibility_clause(
            team_member_projects, actor_uid
        )
        if visibility:
            where.append(visibility)
            args += visibility_args
    elif account_uid:
        # 내 작업 = 로그인 계정 본인이 만든 것만(계정별 분리). 비로그인(account_uid 없음)은 전체.
        where.append("g.creator_uid = ?")
        args.append(account_uid)
    if worker_id:
        where.append("g.worker_id = ?")
        args.append(worker_id)
    if color:
        where.append("g.color = ?")
        args.append(color)
    if share_dir == "mine":
        # 공유한 것 — 계정 모드에선 creator_uid 기준, 레거시 로컬 표식(me)은 내 생성물일 때만 인정.
        if actor_uid:
            where.append(
                "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id "
                "AND (s.shared_by = ? OR (s.shared_by = ? AND g.creator_uid = ?)))"
            )
            args += [actor_uid, DEFAULT_WORKER_ID, actor_uid]
        else:
            where.append(
                "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id AND s.shared_by = ?)"
            )
            args.append(DEFAULT_WORKER_ID)
    elif share_dir == "received":
        # 공유 받은 것 — 제공자(나 아닌 누군가)를 발신자로 한 share 행이 있는 결과물.
        # worker_id(작업 워크스테이션=항상 'me')가 아니라 shared_by 로 판별 — 가져온 번들은
        # worker_id='me' 로 들어오므로(import_bundle_payload), shared_by<>'me' 가 올바른 기준.
        if actor_uid:
            where.append(
                "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id "
                "AND s.shared_by <> ? AND NOT (s.shared_by = ? AND g.creator_uid = ?))"
            )
            args += [actor_uid, DEFAULT_WORKER_ID, actor_uid]
        else:
            where.append(
                "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id AND s.shared_by <> ?)"
            )
            args.append(DEFAULT_WORKER_ID)
    if local_only:
        # 힉스필드에 없음 = job_id 미보유(한 번도 안 감) 또는 검증으로 삭제 확인됨
        where.append("(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1)")
    if creator_uid:
        where.append("g.creator_uid = ?")
        args.append(creator_uid)
    if workspace_id:
        where.append("g.workspace_scope = 'team' AND g.workspace_id = ?")
        args.append(workspace_id)
    if project_id == "none":
        where.append("g.project_id IS NULL")
    elif project_id:
        where.append("g.project_id = ?")
        args.append(project_id)
    else:
        # 보관(archived) 프로젝트의 결과물은 기본 브라우즈에서 제외 → 핫 데이터셋 축소(콜드 분리).
        # 특정 프로젝트를 직접 선택(project_id)했거나 검색 중이면 제외 안 함(언제든 찾을 수 있게).
        if not search:
            where.append(
                "(g.project_id IS NULL OR g.project_id NOT IN "
                "(SELECT id FROM project WHERE archived = 1))"
            )
    if folder_path:
        # 접두사 필터 — 그 폴더 자신 + 하위 전부(ep001 → ep001, ep001/c0010, …). LIKE 특수문자 이스케이프.
        esc = folder_path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append("(g.folder_path = ? OR g.folder_path LIKE ? ESCAPE '\\')")
        args += [folder_path, esc + "/%"]
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name = ?)"
        )
        args.append(tag)
    if search:
        s = search.strip()
        tag_pred = (
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name LIKE ?)"
        )
        # 3자 이상이면 FTS5(trigram) 부분일치로 가속(전체 스캔 제거), 그 외엔 LIKE 폴백.
        # trigram MATCH 는 3자 미만에서 에러 → 길이 가드. 의미(부분일치)는 양쪽 동일.
        if len(s) >= 3 and _fts_ready():
            match = '"' + s.replace('"', '""') + '"'  # 특수문자 무력화(부분일치 문자열)
            where.append(
                f"(g.rowid IN (SELECT rowid FROM generation_fts "
                f"WHERE generation_fts MATCH ?) OR {tag_pred})"
            )
            args += [match, f"%{s}%"]
        else:
            where.append(f"(g.prompt LIKE ? OR {tag_pred})")
            args += [f"%{s}%", f"%{s}%"]
    # ── 서버사이드 인스턴트 필터 ──
    if media_type in ("image", "video", "audio"):
        # 무자산 pending(타입 미정)은 항상 통과, 자산이 있으면 그 타입이 있어야 함(클라이언트 규칙과 동일).
        where.append(
            "(NOT EXISTS (SELECT 1 FROM asset a WHERE a.generation_id=g.id) "
            "OR EXISTS (SELECT 1 FROM asset a WHERE a.generation_id=g.id AND a.type=?))"
        )
        args.append(media_type)
    if colors:
        ph = ",".join("?" * len(colors))
        where.append(f"g.color IN ({ph})")
        args += list(colors)
    if tags:
        ph = ",".join("?" * len(tags))
        where.append(
            f"EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            f"WHERE gt.generation_id=g.id AND t.name IN ({ph}))"
        )
        args += list(tags)
    if auto_tags:
        ph = ",".join("?" * len(auto_tags))
        where.append(
            f"EXISTS (SELECT 1 FROM gen_auto_tag gat JOIN auto_tag a ON a.id=gat.auto_tag_id "
            f"WHERE gat.generation_id=g.id AND a.name IN ({ph}))"
        )
        args += list(auto_tags)
    if shared_only:
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id=g.id)")
    if comment_only:
        where.append("EXISTS (SELECT 1 FROM generation_comment c WHERE c.gen_id=g.id)")
    if final_only:
        where.append("g.is_final=1")
    # 키셋 커서 — 직전 페이지 마지막 행 뒤부터. ORDER BY(sort_ts DESC, id DESC)와 동일 비교식 →
    # idx_generation_keyset 가 범위+정렬을 한 번에 만족(OFFSET 스캔 없음).
    if cursor_ts is not None and cursor_id is not None:
        where.append("(g.sort_ts < ? OR (g.sort_ts = ? AND g.id < ?))")
        args += [cursor_ts, cursor_ts, cursor_id]

    clause = (" WHERE " + " AND ".join(where)) if where else ""
    sql = (
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
        "g.params, g.color, g.status, g.created_at, g.sort_ts, g.is_source, g.source_name, "
        "g.comment, g.error, gr.status AS execution_phase, gr.provider_status, "
        "gr.last_checked_at, gr.next_check_at, COALESCE(gr.check_failures,0) AS check_failures, "
        "g.creator_uid, g.workspace_scope, g.workspace_id, g.workspace_name, "
        "g.project_id, g.folder_path, g.deleted_at, "
        "g.is_final, g.final_by, g.job_id, "  # job_id: 팀 카드(서버 UUID)↔로컬 개인메타 매핑 앵커
        "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
        f"{GEN_BASE_JOINS}"
        # 정렬키: 힉스필드 created_at(sub-second) 보존 sort_ts. 동률은 id 로 안정화(키셋 total order).
        f"{clause} ORDER BY g.sort_ts DESC, g.id DESC LIMIT ?"
    )
    args.append(limit)

    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        return _attach_children(conn, rows, viewer_uid=account_uid)


def generation_comment_counts(
    gen_ids: list[str],
    viewer_uid: Optional[str] = None,
    read_all: bool = False,
    member_projects: Optional[list[str]] = None,
) -> dict[str, dict[str, Any]]:
    """주어진 gen_id 들의 코멘트 수 + 미확인(has_unread) 여부 — 배치. 로컬 우선에서 '발행본'(서버
    공유) 카드의 코멘트 뱃지를 서버 기준으로 보강(enrich)하는 데 쓴다(_attach_children 와 동일 규칙).
    뷰어=로그인 viewer_uid(seen 기록과 동일 신원이어야 뱃지가 꺼짐)."""
    ids = [g for g in (gen_ids or []) if g]
    out: dict[str, dict[str, Any]] = {g: {"comment_count": 0, "has_unread": False} for g in ids}
    if not ids:
        return out
    cviewer = viewer_uid if viewer_uid is not None else DEFAULT_WORKER_ID
    with get_connection() as conn:
        # 가시성 필터 — can_view 와 동일 경계(내 것/내가 멤버인 프로젝트의 공유물/read_all). 안 보이는
        # id 는 count 0 으로 남겨 존재·코멘트 수가 id 추측으로 새지 않게 한다.
        if viewer_uid and not read_all:
            iph = ",".join("?" * len(ids))
            mp = [p for p in (member_projects or []) if p]
            if mp:
                pph = ",".join("?" * len(mp))
                vq = (
                    f"SELECT id FROM generation WHERE id IN ({iph}) AND "
                    f"(creator_uid = ? OR (project_id IN ({pph}) "
                    f"AND EXISTS (SELECT 1 FROM share s WHERE s.generation_id = generation.id)))"
                )
                visible = {r["id"] for r in conn.execute(vq, [*ids, viewer_uid, *mp]).fetchall()}
            else:
                vq = f"SELECT id FROM generation WHERE id IN ({iph}) AND creator_uid = ?"
                visible = {r["id"] for r in conn.execute(vq, [*ids, viewer_uid]).fetchall()}
            ids = [i for i in ids if i in visible]
            if not ids:
                return out
        ph = ",".join("?" * len(ids))
        for r in conn.execute(
            f"SELECT gen_id, COUNT(*) AS cnt FROM generation_comment "
            f"WHERE gen_id IN ({ph}) GROUP BY gen_id",
            ids,
        ).fetchall():
            out[r["gen_id"]]["comment_count"] = r["cnt"]
        for r in conn.execute(
            f"SELECT DISTINCT c.gen_id FROM generation_comment c "
            f"{ALERT_COMMENT_JOINS} "
            f"WHERE c.gen_id IN ({ph}) AND {ALERT_COMMENT_PREDICATE}",
            [cviewer, *ids, cviewer, cviewer, cviewer],
        ).fetchall():
            out[r["gen_id"]]["has_unread"] = True
    return out


def generation_stats(
    viewer_id: str = DEFAULT_WORKER_ID,
    account_uid: Optional[str] = None,
) -> dict[str, Any]:
    """무한 스크롤에서 전량 로드하지 않는 패널 파생값.

      · failed_count: 실패 정리 버튼과 같은 계정 범위의 비정상 건수(휴지통 제외)
      · has_unread:   미확인 코멘트가 하나라도 있나(C 뱃지용, 전역)

    ``account_uid``가 None인 단독 모드는 전체를 세고, AUTH 계정 모드는 현재 작성자만 센다.
    정리 API의 ``delete_failed_orphans(account_uid=...)``와 반드시 같은 범위를 써야 숫자가 남지 않는다.
    """
    failed_where = (
        "status NOT IN ('done','pending','running') AND deleted_at IS NULL"
    )
    failed_args: list[Any] = []
    if account_uid is not None:
        failed_where += " AND creator_uid=?"
        failed_args.append(account_uid)
    with get_connection() as conn:
        failed = conn.execute(
            f"SELECT COUNT(*) FROM generation WHERE {failed_where}",
            failed_args,
        ).fetchone()[0]
        unread = conn.execute(
            f"SELECT EXISTS (SELECT 1 FROM generation_comment c "
            f"{ALERT_COMMENT_JOINS} "
            f"WHERE {ALERT_COMMENT_PREDICATE})",
            (viewer_id, viewer_id, viewer_id, viewer_id),
        ).fetchone()[0]
    return {"failed_count": int(failed), "has_unread": bool(unread)}


def get_generation(gen_id: str, account_uid: Optional[str] = None) -> Optional[dict[str, Any]]:
    with get_connection() as conn:
        return _fetch_generation(conn, gen_id, account_uid)


def get_generations_with_materials(
    gen_ids: list[str], account_uid: Optional[str] = None
) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]]]:
    """여러 생성물과 직접 레퍼런스 부모를 한 커넥션에서 일괄 조회한다.

    캔버스는 카드별로 단건 generation + history API 를 호출하지 않고 이 결과를 한 번 받아 쓴다.
    반환 materials 는 발견된 generation id마다 빈 배열을 포함하므로, 레퍼런스가 없는 경우도
    프론트가 확정값으로 캐시해 다시 묻지 않는다.
    """
    ids = list(dict.fromkeys(g for g in (gen_ids or []) if g))
    if not ids:
        return {}, {}
    with get_connection() as conn:
        # 씬 파일에는 로컬 PK(id) 또는 공유 서버 앵커(job_id)가 들어올 수 있다. 응답 키는
        # 요청한 id 그대로 유지해 카드 바인딩이 깨지지 않게 한다.
        wanted_values = ",".join("(?)" for _ in ids)
        resolved_rows = conn.execute(
            f"WITH wanted(value) AS (VALUES {wanted_values}) "
            "SELECT id, job_id FROM generation "
            "WHERE id IN (SELECT value FROM wanted) OR job_id IN (SELECT value FROM wanted)",
            ids,
        ).fetchall()
        exact = {row["id"]: row["id"] for row in resolved_rows if row["id"] in ids}
        by_job = {
            row["job_id"]: row["id"]
            for row in resolved_rows
            if row["job_id"] and row["job_id"] in ids
        }
        requested_to_local = {
            requested: exact.get(requested) or by_job[requested]
            for requested in ids
            if requested in exact or requested in by_job
        }
        local_ids = list(dict.fromkeys(requested_to_local.values()))
        local_gens = _fetch_gens(conn, local_ids, viewer_uid=account_uid)
        gens = {
            requested: local_gens[local_id]
            for requested, local_id in requested_to_local.items()
            if local_id in local_gens
        }
        materials_by_local: dict[str, list[str]] = {local_id: [] for local_id in local_gens}
        if local_gens:
            found = list(local_gens)
            ph = ",".join("?" * len(found))
            for row in conn.execute(
                f"SELECT child_gen_id, parent_gen_id FROM history "
                f"WHERE relation='reference' AND child_gen_id IN ({ph})",
                found,
            ).fetchall():
                materials_by_local[row["child_gen_id"]].append(row["parent_gen_id"])
        materials = {
            requested: materials_by_local.get(local_id, [])
            for requested, local_id in requested_to_local.items()
            if local_id in local_gens
        }
        return gens, materials


def get_generation_metrics(gen_id: str) -> Optional[dict[str, Any]]:
    """생성물의 실제 크레딧·소요시간(generation_metrics). 매니지/인제스트 전이라 테이블이 없거나
    행이 없으면 None. real_credits=account transactions 매칭 실제값(NULL=미상),
    elapsed_seconds=허브가 기록한 생성 소요시간(초, hub-originated 만)."""
    try:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT est_credits, real_credits, credit_source, elapsed_seconds "
                "FROM generation_metrics WHERE gen_id=?",
                (gen_id,),
            ).fetchone()
    except sqlite3.OperationalError:
        return None
    if not row:
        return None
    return {
        "est_credits": row["est_credits"],
        "real_credits": row["real_credits"],
        "credit_source": row["credit_source"],
        "elapsed_seconds": row["elapsed_seconds"],
    }
