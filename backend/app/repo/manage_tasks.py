"""PM 작업 저장소 — 작업 조회·자동 폴더 작업·담당자 배정·CRUD.

외부 호출은 호환 파사드인 repo.manage 를 유지한다. 이 모듈은 작업 테이블과
작업에 연결된 생성물의 조회/집계 경계만 소유한다.
"""

from __future__ import annotations

from typing import Any, Optional

from ..db import get_connection
from ._common import new_id
from .identity import resolve_display_names
from .manage_schema import _ensure_schema


# ── 작업(Task) ────────────────────────────────────────────────────────────────
_TASK_FIELDS = (
    "name", "status", "start_date", "due_date", "sort_order", "note",
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


def _batch_task_gen_rows(conn, project_id: str, tasks) -> dict[str, list[dict[str, Any]]]:
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

    # ① 수동 링크 — 항상 포함 + linked 표시.
    ph_t = ",".join("?" * len(task_ids))
    for r in conn.execute(
        f"SELECT task_id, gen_id FROM task_generation WHERE task_id IN ({ph_t})",
        task_ids,
    ):
        tid, gid = r["task_id"], r["gen_id"]
        if tid in membership:
            membership[tid].add(gid)
            linked[tid].add(gid)

    # ② 폴더 레인 — folder_path 별로 그 경로를 가진 작업들에 매핑.
    fpath_to_tasks: dict[str, list[str]] = {}
    for tid in task_ids:
        fpath = meta[tid][0]
        if fpath is not None:
            fpath_to_tasks.setdefault(fpath, []).append(tid)
    if fpath_to_tasks:
        fpaths = list(fpath_to_tasks.keys())
        ph_f = ",".join("?" * len(fpaths))
        for r in conn.execute(
            f"SELECT id, folder_path FROM generation "
            f"WHERE project_id=? AND deleted_at IS NULL AND folder_path IN ({ph_f})",
            [project_id, *fpaths],
        ):
            for tid in fpath_to_tasks.get(r["folder_path"], []):
                membership[tid].add(r["id"])

    # ③ 시퀀스 레인 — folder_path 없고 sequence 있는 작업. auto_tag.name=sequence.
    seq_to_tasks: dict[str, list[str]] = {}
    for tid in task_ids:
        fpath, seq = meta[tid]
        if fpath is None and seq is not None:
            seq_to_tasks.setdefault(seq, []).append(tid)
    if seq_to_tasks:
        seqs = list(seq_to_tasks.keys())
        ph_s = ",".join("?" * len(seqs))
        for r in conn.execute(
            f"SELECT g.id AS id, at.name AS seqname FROM generation g "
            f"JOIN gen_auto_tag gat ON gat.generation_id=g.id "
            f"JOIN auto_tag at ON at.id=gat.auto_tag_id "
            f"WHERE g.project_id=? AND g.deleted_at IS NULL AND at.name IN ({ph_s})",
            [project_id, *seqs],
        ):
            for tid in seq_to_tasks.get(r["seqname"], []):
                membership[tid].add(r["id"])

    # 등장한 모든 gen_id 상세를 1회 조회(원 함수의 컬럼·서브쿼리 그대로).
    all_ids: set[str] = set()
    for s in membership.values():
        all_ids |= s
    detail: dict[str, dict[str, Any]] = {}
    if all_ids:
        idlist = list(all_ids)
        ph_g = ",".join("?" * len(idlist))
        for g in conn.execute(
            f"SELECT g.id AS id, g.status AS status, g.creator_uid AS creator_uid, "
            f"  g.is_final AS is_final, g.created_at AS created_at, g.job_id AS job_id, "
            f"  g.sort_ts AS sort_ts, "
            f"  EXISTS(SELECT 1 FROM share s WHERE s.generation_id=g.id) AS shared, "
            f"  (SELECT COALESCE(a.thumbnail_path, CASE WHEN a.type='video' THEN NULL ELSE a.file_path END) "
            f"   FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS thumb, "
            f"  (SELECT a.type FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS media_type, "
            f"  (SELECT a.file_path FROM asset a WHERE a.generation_id=g.id ORDER BY a.rowid LIMIT 1) AS file_path "
            # ★deleted_at IS NULL — 원 함수는 이 필터를 전체 lane 바깥에 둬서 '수동 링크된 삭제 생성물'도
            #  제외한다. 멤버십에 그 gid 가 있어도 detail 에 없으면 아래 조립에서 걸러진다(회귀 방지).
            f"FROM generation g WHERE g.id IN ({ph_g}) AND g.deleted_at IS NULL",
            idlist,
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
            if not d:
                continue
            row = dict(d)
            row["linked"] = 1 if gid in linked[tid] else 0
            gens.append(row)
        gens.sort(key=_order)
        for row in gens:
            row.pop("sort_ts", None)  # 정렬용 내부값 — 원 함수 출력엔 없으므로 제거(shape 일치)
        result[tid] = gens
    return result


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
        # 1차: 작업별 컷을 '한 번에' 확보(작업당 1쿼리 N+1 → 레인별 배치) + 전체 gen_id 수집.
        per_task_cuts: dict[str, list[dict[str, Any]]] = _batch_task_gen_rows(conn, project_id, rows)
        for r in rows:
            for g in per_task_cuts.get(r["id"], []):
                if g["creator_uid"]:
                    all_creator_uids.add(g["creator_uid"])
                all_gen_ids.add(g["id"])
        # 담당(배정) 배치 조회 — 실제 생성자(per_task_cuts)와 별개 축. PM 이 대시보드에서 배정한다.
        task_ids = [r["id"] for r in rows]
        assigned_by_task: dict[str, list[str]] = {}
        if task_ids:
            ph_t = ",".join("?" * len(task_ids))
            for pr in conn.execute(
                f"SELECT task_id, assignee_uid FROM task_assignment "
                f"WHERE task_id IN ({ph_t}) ORDER BY created_at",
                task_ids,
            ).fetchall():
                assigned_by_task.setdefault(pr["task_id"], []).append(pr["assignee_uid"])
                all_creator_uids.add(pr["assignee_uid"])
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
                or assigned_by_task.get(r["id"]) or r["description"] or r["status"] == "omit"
            )
            if r["folder_path"] and d["gen_count"] == 0 and not pm_edited:
                continue
            out.append(d)
        # 작성자·담당자 이름 일괄 해석(단일 해석기) 후 작업별 부착.
        # all_creator_uids 에 담당(assignee)도 이미 포함(위 배치 조회에서 add).
        names = resolve_display_names(conn, list(all_creator_uids)) if all_creator_uids else {}
        for d in out:
            seen: list[str] = []
            for c in per_task_cuts[d["id"]]:
                nm = names.get(c["creator_uid"]) if c["creator_uid"] else None
                if nm and nm not in seen:
                    seen.append(nm)
                c["creator_name"] = nm
                # 컷별 크레딧 — 참여자별 크레딧 집계(대시보드 참여자 세부)에 쓴다.
                c["credits"] = metrics_by_gen.get(c["id"], (0, None))[0]
                c.pop("job_id", None)  # 폴백 계산용 내부값 — 응답(컷)엔 노출 안 함(코덱스)
            d["cuts"] = per_task_cuts[d["id"]]
            d["creators"] = seen  # 실제 생성자(연결 컷 파생) — 기존 필터·캘린더 호환 유지
            # 담당(배정, 복수) — {uid, name}. 대시보드에서 지정, 작업탭 '내 배분' 필터·표시에 사용.
            d["assigned_creators"] = [
                {"uid": u, "name": names.get(u)} for u in assigned_by_task.get(d["id"], [])
            ]
        return out


def add_assignment(task_id: str, assignee_uid: str, added_by: Optional[str]) -> bool:
    """작업에 담당(배정) 추가(멱등). PM 이 대시보드에서 작업자를 배정할 때."""
    assignee_uid = (assignee_uid or "").strip()
    if not assignee_uid:
        return False
    with get_connection() as conn:
        _ensure_schema(conn)
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
        conn.execute(
            "INSERT INTO project_task"
            "(id, project_id, name, status, start_date, due_date, sort_order, "
            " note, sequence, description) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                tid, project_id, name, kw.get("status") or "not_started",
                kw.get("start_date"), kw.get("due_date"),
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


def bulk_update_task_orders(items: list[tuple[str, int]]) -> int:
    """여러 작업의 표시 순서를 한 트랜잭션으로 저장한다."""
    if not items:
        return 0
    with get_connection() as conn:
        _ensure_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "UPDATE project_task SET sort_order=? WHERE id=?",
            [(sort_order, task_id) for task_id, sort_order in items],
        )
    return len(items)


def delete_task(tid: str) -> bool:
    with get_connection() as conn:
        _ensure_schema(conn)
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
