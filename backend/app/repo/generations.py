"""생성본(generation) 업서트·로컬 생성·상태·조회/직렬화·소스 검색."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from . import identity, tags
from ._common import (
    ALERT_COMMENT_JOINS,
    ALERT_COMMENT_PREDICATE,
    _cached_or_remote,
    new_id,
)

# FTS5(generation_fts) 존재 여부 — 검색 경로 선택용. DB 경로별로 1회 확인 후 메모이즈.
# ★경로로 키잉: 계정 전환·DB 이관으로 활성 DB 가 바뀌면 재확인한다(예전엔 전역 bool 로 1회만 확인해,
#   FTS 있는 DB 로 시작 후 FTS 없는 DB 로 전환하면 없는 테이블에 MATCH 를 던져 검색이 500 났다).
_FTS_READY: Optional[bool] = None
_FTS_READY_PATH: Optional[str] = None


def _fts_ready() -> bool:
    """FTS5 검색 인덱스가 준비됐는지(없으면 LIKE 폴백). 활성 DB 경로가 바뀔 때만 재확인.
    PostgreSQL 백엔드면 FTS5 미사용 → False(검색은 ILIKE, pg_trgm GIN 인덱스가 가속)."""
    global _FTS_READY, _FTS_READY_PATH
    from ..db import DB_BACKEND, get_db_path

    if DB_BACKEND == "postgres":
        return False
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


def _upsert_reference(
    conn: sqlite3.Connection,
    *,
    ref_id: Optional[str],
    type_: str,
    file_path: str,
    source: str,
    thumbnail_path: Optional[str] = None,
    source_url: Optional[str] = None,
) -> str:
    rid = ref_id or new_id()
    conn.execute(
        "INSERT INTO reference(id, type, file_path, thumbnail_path, source, source_url) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, "
        "type=excluded.type, source_url=COALESCE(reference.source_url, excluded.source_url)",
        (rid, type_, file_path, thumbnail_path, source, source_url),
    )
    return rid


def _link_reference(
    conn: sqlite3.Connection, gen_id: str, ref_id: str, role: Optional[str]
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO gen_reference(generation_id, reference_id, role) "
        "VALUES(?,?,?)",
        (gen_id, ref_id, role or ""),
    )


# ── 동기화 업서트 (CLI → 로컬) ───────────────────────────────────────────
def _upsert_synced(conn, parsed: dict[str, Any], worker_id: str) -> str:
    """업서트 본체 — 주어진 커넥션에서 실행(트랜잭션 제어는 호출측). apply_synced_jobs 가
    한 트랜잭션에 묶어 호출하고, 단건 wrapper(upsert_synced_generation)는 자체 커넥션을 연다."""
    g = parsed["generation"]
    job_id = g["id"]
    if not job_id:
        return "unchanged"
    # 결과 미디어 URL — id/job_id 매칭이 깨졌을 때 '같은 결과물' 판정의 안정적 키.
    a0 = parsed.get("asset") or {}
    result_url = a0.get("file_path")
    if not (isinstance(result_url, str) and result_url.startswith("http")):
        result_url = None

    if True:
        # 이미 이 잡을 대표하는 행이 있는가? — 동기화본(id=job_id) 이거나
        # 로컬 생성본(job_id 컬럼=job_id). 있으면 그 행을 갱신해 중복 삽입을 막는다.
        existing = conn.execute(
            "SELECT id, status FROM generation WHERE id = ? OR job_id = ? LIMIT 1",
            (job_id, job_id),
        ).fetchone()
        # URL 매칭 — id/job_id 로 못 찾았고 결과 URL 이 있으면, 같은 결과물을 가진 로컬 생성본을
        # 찾는다(create 가 job_id 를 못 받았거나 list id 와 다른 경우의 안전망). job_id 를 덮어쓴다.
        adopt = False
        if not existing and result_url:
            existing = conn.execute(
                "SELECT g.id, g.status FROM generation g JOIN asset a ON a.generation_id=g.id "
                "WHERE a.file_path=? OR a.source_url=? LIMIT 1",
                (result_url, result_url),
            ).fetchone()
            adopt = existing is not None

        result = "inserted"
        if existing:
            target_id = existing["id"]
            result = "updated" if existing["status"] != g["status"] else "unchanged"
            # adopt(URL 매칭)면 job_id 를 권위값으로 덮어씀, 아니면 기존 보존(COALESCE).
            # sort_ts 는 힉스필드 정밀 epoch 으로 갱신 → 로컬 생성본도 힉스필드 순서에 정렬(있을 때만).
            job_id_set = "job_id=?" if adopt else "job_id=COALESCE(job_id, ?)"
            conn.execute(
                f"UPDATE generation SET status=?, model=COALESCE(model,?), params=?, "
                f"sort_ts=COALESCE(?, sort_ts), creator_uid=COALESCE(?, creator_uid), "
                f"{job_id_set} WHERE id=?",
                (
                    g["status"],
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    g.get("sort_ts"),
                    g.get("creator_uid"),
                    job_id,
                    target_id,
                ),
            )
        else:
            target_id = job_id
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, model, params, color, status, created_at, sort_ts, "
                # sort_ts 누락 시 created_at 에서 파생 — 키셋 페이지네이션이 이 행을 놓치지 않게(NULL 금지).
                "creator_uid, job_id) VALUES(?,?,?,?,?,?,?,?,COALESCE(?, strftime('%s', ?)),?,?)",
                (
                    job_id,
                    worker_id,
                    g["prompt"],
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    None,
                    g["status"],
                    g["created_at"],
                    g.get("sort_ts"),
                    g["created_at"],
                    g.get("creator_uid"),
                    job_id,
                ),
            )

        # asset: generation 당 1개로 단순화(재동기 시 교체).
        # 이미 로컬 보관된 결과물이면 로컬 경로를 유지(출처 영속, 재동기로 안 깨짐).
        if parsed.get("asset"):
            a = parsed["asset"]
            is_img = a["type"] == "image"
            fp, thumb, src = _cached_or_remote(a["file_path"], is_img)
            # 성능: 이미 같은 asset 1개가 있으면 재기록 생략(주기 동기화의 '변동 없음' 케이스에서
            # 매번 DELETE+INSERT 하던 쓰기를 제거 → WAL 쓰기·fsync 급감). 다르면(또는 0/복수면) 교체.
            cur_assets = conn.execute(
                "SELECT type, file_path, thumbnail_path, source_url FROM asset WHERE generation_id=?",
                (target_id,),
            ).fetchall()
            same_asset = (
                len(cur_assets) == 1
                and cur_assets[0]["type"] == a["type"]
                and cur_assets[0]["file_path"] == fp
                and (cur_assets[0]["thumbnail_path"] or None) == (thumb or None)
                and (cur_assets[0]["source_url"] or None) == (src or None)
            )
            if not same_asset:
                conn.execute("DELETE FROM asset WHERE generation_id=?", (target_id,))
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path, source_url) "
                    "VALUES(?,?,?,?,?,?)",
                    (new_id(), target_id, a["type"], fp, thumb, src),
                )

        # references — 이미 레퍼런스가 있으면 건드리지 않는다(중복 방지 + 로컬 명명 보존).
        #  · 로컬 생성본: display_prompt 와 @소스명이 달린 레퍼런스를 그대로 유지.
        #  · 순수 동기화본: 첫 동기화 때만 medias 를 'uploaded' 로 넣고, 재동기엔 건드리지 않음.
        has_refs = conn.execute(
            "SELECT 1 FROM gen_reference WHERE generation_id=? LIMIT 1", (target_id,)
        ).fetchone()
        if not has_refs:
            for ref in parsed.get("references", []):
                is_img = ref["type"] == "image"
                fp, thumb, src = _cached_or_remote(ref["file_path"], is_img)
                rid = _upsert_reference(
                    conn,
                    ref_id=ref.get("id"),
                    type_=ref["type"],
                    file_path=fp,
                    # 번들이 실어 온 @소스명 보존(없으면 'uploaded') — create_local_generation 과 동일 규칙.
                    # buildPromptParts 가 이 source 로 display_prompt 의 인라인 칩 위치를 복원.
                    source=ref.get("source") or "uploaded",
                    thumbnail_path=thumb,
                    source_url=src,
                )
                _link_reference(conn, target_id, rid, ref.get("role"))

    return result


def known_job_ids(creator_uid: str) -> list[str]:
    """이 생성자(creator_uid)로 이미 적재된 힉스필드 job_id 목록 — push 에이전트가 새 것만 보내게."""
    if not creator_uid:
        return []
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT job_id FROM generation WHERE creator_uid=? AND job_id IS NOT NULL AND job_id<>''",
            (creator_uid,),
        ).fetchall()
    return [r["job_id"] for r in rows]


def upsert_synced_generation(parsed: dict[str, Any], worker_id: str) -> str:
    """cli_bridge.parse_job 결과를 로컬 DB 에 업서트(단건, 자체 커넥션).

    반환: 'inserted'(신규) | 'updated'(상태 변동) | 'unchanged'. job id 를 PK 로 써서
    재동기는 멱등. 기존 사용자 메타(태그/컬러/display_prompt/명명 레퍼런스)는 보존한다.
    여러 건을 한 번에 처리할 땐 apply_synced_jobs(한 트랜잭션·fsync 1회)를 쓴다."""
    with get_connection() as conn:
        return _upsert_synced(conn, parsed, worker_id)


def apply_synced_jobs(jobs: list[dict[str, Any]], worker_id: str) -> dict[str, int]:
    """동기화 잡 묶음을 **한 커넥션·한 트랜잭션**으로 업서트 + hf_missing 해제. 카운트 반환.

    이전엔 잡마다 커넥션을 새로 열고(autocommit) execute 마다 fsync 가 일어나, 100건 동기화가
    수백 fsync + 커넥션 100회로 버스트를 만들었다. 묶으면 fsync 1회로 줄어 경합이 급감한다.
    ⚠️ 동기 블로킹 — 호출측(syncer.sync_now)이 asyncio.to_thread 로 워커 스레드에서 돌린다."""
    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "errors": 0}
    with get_connection() as conn:
        conn.execute("BEGIN")  # 명시적 트랜잭션 — 전체 묶음을 1회 커밋(컨텍스트가 COMMIT)
        for parsed in jobs:
            # 잡별 SAVEPOINT 격리 — 한 잡이 깨져도(ROLLBACK TO) 나머지는 그대로 반영.
            # 견고성 + 성능 둘 다: 여전히 커밋(fsync)은 마지막 1회.
            conn.execute("SAVEPOINT j")
            try:
                counts[_upsert_synced(conn, parsed, worker_id)] += 1
            except Exception as e:  # noqa: BLE001 — 잡 1건 실패가 전체 동기화를 막지 않게
                conn.execute("ROLLBACK TO j")
                counts["errors"] += 1
                print(f"[sync] 잡 1건 건너뜀: {e}")
            finally:
                conn.execute("RELEASE j")
        ids = [
            p["generation"]["id"]
            for p in jobs
            if p.get("generation") and p["generation"].get("id")
        ]
        if ids:
            ph = ",".join("?" * len(ids))
            conn.execute(
                f"UPDATE generation SET hf_missing=0 WHERE job_id IN ({ph})", ids
            )
    return counts


# ── 로컬 생성 (POST create) ──────────────────────────────────────────────
def create_local_generation(
    data: dict[str, Any], worker_id: str, creator_uid: Optional[str] = None
) -> str:
    """status=pending 인 로컬 generation 레코드 생성. gen_id 반환.

    data: GenerationCreate.model_dump() 형태.
    creator_uid: 로그인한 계정의 생성자 신원(있으면 그것으로 귀속 → 계정별 '내 작업' 분리).
                 없으면(비로그인/단독) 제공자 my_uid 로 폴백(기존 동작).
    """
    gen_id = new_id()
    # 내가 지금 만드는 것이므로 내 신원으로 즉시 귀속 — 동기화로 creator_uid 가 채워지기 전
    # 'pending' 상태에서도 is_mine=True(=나)가 되게 한다(팀원으로 오표시되던 버그 수정).
    # 로그인 계정이면 그 계정 uid, 아니면 제공자 my_uid(없으면 NULL → 단독 사용자 취급).
    my_uid = creator_uid or identity.get_my_uid()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id, creator_uid) "
            "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?)",
            (
                gen_id,
                worker_id,
                data["prompt"],
                data.get("display_prompt"),
                data.get("model"),
                json.dumps(data.get("params") or {}, ensure_ascii=False),
                data.get("color"),
                time.time(),  # 정렬키 — 동기화되면 힉스필드 정밀 epoch 으로 갱신됨
                data.get("project_id"),  # 생성 시 보던 프로젝트로 자동 귀속(없으면 미분류)
                my_uid,  # 내 생성자 신원(있으면) — 로컬 생성물 = 내 작업
            ),
        )
        tags._set_tags(conn, gen_id, data.get("tags") or [])
        tags._set_auto_tags(conn, gen_id, data.get("auto_tags") or [])
        src_gen_ids: set[str] = set()
        for ref in data.get("references") or []:
            rid = _upsert_reference(
                conn,
                ref_id=None,
                type_=ref.get("type", "image"),
                file_path=ref["file_path"],
                thumbnail_path=ref.get("thumbnail"),  # 표시용(에셋 소스 썸네일)
                source=ref.get("name") or "uploaded",  # 칩 이름(@소스명) — 인라인 칩 복원 키
                source_url=ref.get("source_url"),
            )
            _link_reference(conn, gen_id, rid, ref.get("role"))
            sgid = ref.get("source_gen_id")
            if sgid and sgid != gen_id:
                src_gen_ids.add(sgid)
        # @소스로 만든 결과물 → 그 소스를 부모로 한 'reference' 엣지(provenance). 멱등.
        for sgid in src_gen_ids:
            _record_history(conn, sgid, gen_id, "reference")
    return gen_id


def _record_history(
    conn: sqlite3.Connection, parent_gen_id: str, child_gen_id: str, relation: str
) -> bool:
    """히스토리 엣지 1개 기록(멱등) — (parent,child,relation) 유니크. 부모가 실재할 때만.
    relation: 'derived'(재생성/가져오기) | 'reference'(@소스로 생성)."""
    if not parent_gen_id or parent_gen_id == child_gen_id:
        return False
    if not conn.execute(
        "SELECT 1 FROM generation WHERE id=?", (parent_gen_id,)
    ).fetchone():
        return False  # 소스가 우리 DB에 없으면(외부 등) 엣지 생략 — FK 위반 방지
    conn.execute(
        "INSERT OR IGNORE INTO history(id, parent_gen_id, child_gen_id, relation) "
        "VALUES(?,?,?,?)",
        (new_id(), parent_gen_id, child_gen_id, relation),
    )
    return True


def _descendants(conn: sqlite3.Connection, root: str) -> set[str]:
    """root 의 모든 자손 id(모든 relation, BFS). 순환 방어용."""
    out: set[str] = set()
    frontier = [root]
    while frontier:
        ph = ",".join("?" * len(frontier))
        nxt = [
            r["child_gen_id"]
            for r in conn.execute(
                f"SELECT child_gen_id FROM history WHERE parent_gen_id IN ({ph})", frontier
            ).fetchall()
        ]
        frontier = [c for c in nxt if c not in out]
        out.update(frontier)
    return out


def _derived_depth_batch(
    conn: sqlite3.Connection, ids: list[str]
) -> dict[str, int]:
    """각 id 의 'derived' 조상 수(자기 버전 체인 깊이, 루트=0)를 **레벨별 일괄 조회**로 계산.
    예전엔 id 마다 체인을 따로 while-조회(N+1)했으나, 같은 깊이의 커서를 한 번의 IN 쿼리로
    묶어 올려 조회 수를 체인 길이(보통 1~5회)로 줄인다. id 별 방문집합으로 순환 방어."""
    depth = {i: 0 for i in ids}
    cursor = {i: i for i in ids}  # 각 시작 노드의 현재 체인 끝
    seen = {i: {i} for i in ids}  # 시작 노드별 방문집합(순환 방어)
    active = list(dict.fromkeys(ids))  # 중복 제거, 순서 보존
    while active:
        cur_ids = list({cursor[i] for i in active})
        ph = ",".join("?" * len(cur_ids))
        parent_of = {
            r["child_gen_id"]: r["parent_gen_id"]
            for r in conn.execute(
                f"SELECT child_gen_id, parent_gen_id FROM history "
                f"WHERE relation='derived' AND child_gen_id IN ({ph})",
                cur_ids,
            ).fetchall()
        }
        nxt: list[str] = []
        for i in active:
            p = parent_of.get(cursor[i])
            if not p or p in seen[i]:
                continue
            cursor[i] = p
            seen[i].add(p)
            depth[i] += 1
            nxt.append(i)
        active = nxt
    return depth


def add_history_edge(
    parent_gen_id: str, child_gen_id: str, relation: str = "derived"
) -> bool:
    """수동 히스토리 연결(동기화 잡 등 자동 히스토리가 없는 결과물을 손으로 묶기). 멱등.
    순환(부모가 자식의 자손)·자기참조·없는 부모는 거부(ValueError/False)."""
    if relation not in ("derived", "reference"):
        relation = "derived"
    if not parent_gen_id or parent_gen_id == child_gen_id:
        raise ValueError("자기 자신을 부모로 지정할 수 없습니다.")
    with get_connection() as conn:
        if not conn.execute(
            "SELECT 1 FROM generation WHERE id=?", (child_gen_id,)
        ).fetchone():
            raise ValueError(f"없는 generation: {child_gen_id}")
        if not conn.execute(
            "SELECT 1 FROM generation WHERE id=?", (parent_gen_id,)
        ).fetchone():
            raise ValueError(f"없는 부모 generation: {parent_gen_id}")
        if parent_gen_id in _descendants(conn, child_gen_id):
            raise ValueError("순환이 생깁니다(그 부모는 이 결과물의 자손입니다).")
        return _record_history(conn, parent_gen_id, child_gen_id, relation)


def record_derived_parents(child_id: str, parent_ids: list[str]) -> list[str]:
    """파생 부모(들)를 'derived' 엣지로 기록하되 **전이 축소**한다.

    후보 중 다른 후보(또는 child)의 **조상**인 것은 잉여(그 자손을 거쳐 이미 도달 가능) → 기록 안 함.
    가장 가까운 부모만 남겨 계보 그래프가 평탄해지지 않게 한다(원본→중간→자식 체인 보존).
    드래그 부모 + 보드 포커스/선택이 합쳐져 들어와도 항상 깔끔한 체인. 기록한 부모 목록 반환."""
    # 중복·자기참조 제거(입력 순서 보존)
    cands = [p for p in dict.fromkeys(parent_ids or []) if p and p != child_id]
    if not cands:
        return []
    with get_connection() as conn:
        # 실재하는 후보만(없는 부모는 조상 판정에서도 제외)
        cands = [
            p
            for p in cands
            if conn.execute("SELECT 1 FROM generation WHERE id=?", (p,)).fetchone()
        ]
        if not cands:
            return []
        # 각 후보의 자손 집합으로 'p 가 다른 후보/child 의 조상인지' 판정 → 그러면 p 는 잉여.
        targets = set(cands) | {child_id}
        kept = [
            p
            for p in cands
            if not (_descendants(conn, p) & (targets - {p}))
        ]
        for p in kept:
            _record_history(conn, p, child_id, "derived")
        return kept


def remove_history_edge(parent_gen_id: str, child_gen_id: str) -> bool:
    """히스토리 엣지 제거(잘못 묶인 것 풀기). 멱등."""
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM history WHERE parent_gen_id=? AND child_gen_id=?",
            (parent_gen_id, child_gen_id),
        )
        return cur.rowcount > 0


def set_status(gen_id: str, status: str, error: Optional[str] = None) -> None:
    """상태 전이. failed 면 error(사유)를 저장하고, 그 외 전이는 error 를 비운다
    (재시도/재생성으로 성공·진행 시 옛 사유가 남지 않게)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status=?, error=? WHERE id=?",
            (status, error if status == "failed" else None, gen_id),
        )


def fail_orphaned_jobs() -> int:
    """서버 시작 시 호출 — 인메모리 잡 큐는 부팅 시 비어 있으므로, DB 의
    pending/running 은 모두 이전 프로세스에서 끊긴 고아 잡이다(워커가 사라져
    영영 완료되지 않음). failed 로 정리해 UI 가 '생성중'에 멈추지 않게 한다.
    실제 결과는 Higgsfield 에 있으므로 사용자가 동기화로 가져올 수 있다."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE generation SET status='failed', "
            "error=COALESCE(error, '서버 재시작으로 생성이 중단되었습니다. 동기화로 결과를 가져오거나 재생성하세요.') "
            "WHERE status IN ('pending','running')"
        )
        return cur.rowcount


def set_generation_timestamp(
    gen_id: str, created_at: Optional[str], sort_ts: Optional[float]
) -> None:
    """힉스필드가 부여한 created_at/sort_ts 를 로컬 생성본에 즉시 반영 — 주기 동기화를
    기다리지 않고 생성 완료 시점에 바로 '제자리'(정확한 순서)를 잡게 한다.
    sort_ts 가 없으면(응답에 created_at 없음) 로컬 시각 유지 → 다음 동기화가 채택."""
    if sort_ts is None:
        return
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET sort_ts=?, created_at=COALESCE(?, created_at) WHERE id=?",
            (sort_ts, created_at, gen_id),
        )


def set_job_id(gen_id: str, job_id: str) -> None:
    """로컬 생성본에 실제 Higgsfield 잡 id 를 기록 — 이후 동기화가 이 행을
    중복 생성 없이 갱신하도록(중복 방지의 핵심).

    레이스 병합: 로컬 생성이 끝나기 전에 주기 동기화가 같은 잡을 먼저 동기화본
    (id == job_id)으로 INSERT 했을 수 있다. 그 경우 사용자 메타(display_prompt·@소스명·
    태그·컬러)가 없는 동기화본은 버리고 로컬을 남긴다(병합)."""
    with get_connection() as conn:
        dup = conn.execute(
            "SELECT id FROM generation WHERE id=? AND id<>?", (job_id, gen_id)
        ).fetchone()
        if dup:
            _delete_generation(conn, job_id)  # 레이스로 생긴 동기화 중복본 제거
        conn.execute("UPDATE generation SET job_id=? WHERE id=?", (job_id, gen_id))


def update_asset_cache(
    asset_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """asset 을 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE asset SET file_path=?, thumbnail_path=?, "
            "source_url=COALESCE(source_url, ?) WHERE id=?",
            (file_path, thumbnail_path, source_url, asset_id),
        )


def update_reference_cache(
    ref_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """reference 를 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE reference SET file_path=?, thumbnail_path=?, "
            "source_url=COALESCE(source_url, ?) WHERE id=?",
            (file_path, thumbnail_path, source_url, ref_id),
        )


def all_generation_ids() -> list[str]:
    with get_connection() as conn:
        return [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM generation ORDER BY created_at DESC"
            ).fetchall()
        ]


def add_asset(
    gen_id: str, type_: str, file_path: str, thumbnail_path: Optional[str] = None
) -> str:
    aid = new_id()
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
            "VALUES(?,?,?,?,?)",
            (aid, gen_id, type_, file_path, thumbnail_path),
        )
    return aid


def apply_local_fulfillment(
    gen_id: str,
    rid: str,
    *,
    asset_type: Optional[str],
    asset_path: Optional[str],
    asset_thumb: Optional[str],
    job_id: Optional[str],
    created_at: Optional[str],
    sort_ts: Optional[float],
    status: str,
    error: Optional[str],
    request_status: str,
) -> None:
    """gen-request fulfill 의 다단계 쓰기(에셋 추가·job_id 병합·타임스탬프·상태·요청표시)를 한
    트랜잭션으로 묶는다 — 예전엔 5개 분리 커밋이라 중간에 주기 동기화가 끼면 부분 상태(예: job_id 만
    반영되고 status 는 아직 옛값)를 보는 창이 있었다. BEGIN IMMEDIATE 로 전부 한 번에 커밋."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if asset_type and asset_path:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                "VALUES(?,?,?,?,?)",
                (new_id(), gen_id, asset_type, asset_path, asset_thumb),
            )
        if job_id:
            # 레이스 병합: 동기화가 같은 잡을 동기화본(id==job_id)으로 먼저 넣었으면 그 중복본 제거.
            dup = conn.execute(
                "SELECT id FROM generation WHERE id=? AND id<>?", (job_id, gen_id)
            ).fetchone()
            if dup:
                _delete_generation(conn, job_id)
            conn.execute("UPDATE generation SET job_id=? WHERE id=?", (job_id, gen_id))
        if sort_ts is not None:
            conn.execute(
                "UPDATE generation SET sort_ts=?, created_at=COALESCE(?, created_at) WHERE id=?",
                (sort_ts, created_at, gen_id),
            )
        conn.execute(
            "UPDATE generation SET status=?, error=? WHERE id=?",
            (status, error if status == "failed" else None, gen_id),
        )
        conn.execute(
            "UPDATE gen_request SET status=?, error=?, updated_at=datetime('now') WHERE id=?",
            (request_status, error, rid),
        )


def set_color(gen_id: str, color: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE generation SET color=? WHERE id=?", (color, gen_id))


def set_source(gen_id: str, name: Optional[str], is_source: bool = True) -> None:
    """생성본을 소스 라이브러리에 등록/해제(@이름)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET is_source=?, source_name=? WHERE id=?",
            (1 if is_source else 0, (name or None) if is_source else None, gen_id),
        )


def set_comment(gen_id: str, comment: Optional[str]) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET comment=? WHERE id=?", (comment or None, gen_id)
        )


# ── v02 CMS — Supervisor 최종(골드) 선별 ───────────────────────────────────
def set_final(gen_id: str, is_final: bool, by_uid: Optional[str] = None) -> None:
    """Supervisor 가 생성본을 최종(골드)으로 지정/해제. 지정 시 누가/언제 기록.
    공유 잠금('최종인데 공유 안 됨' 모순 차단)은 라우터의 unpublish 가드가 담당한다."""
    with get_connection() as conn:
        if is_final:
            conn.execute(
                "UPDATE generation SET is_final=1, final_by=?, final_at=datetime('now') WHERE id=?",
                (by_uid, gen_id),
            )
        else:
            conn.execute(
                "UPDATE generation SET is_final=0, final_by=NULL, final_at=NULL WHERE id=?",
                (gen_id,),
            )


def is_final(gen_id: str) -> bool:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT is_final FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
    return bool(row and row["is_final"])


def override_prompt_model(
    gen_id: str, prompt: Optional[str] = None, model: Optional[str] = None
) -> None:
    """재생성 시 프롬프트/모델만 선택적으로 덮어쓴다(None 은 기존 값 유지).

    프롬프트를 교체하면 부모에서 복제된 display_prompt(레퍼런스 위치가 박힌 옛 프롬프트)는
    무효 → NULL 로 비운다. 응답이 `display_prompt || prompt` 로 렌더되므로, 비우지 않으면
    CLI 엔 새 텍스트가 가도 화면·내보내기엔 옛 프롬프트가 남는다. 모델만 바꿀 땐 보존."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET prompt=COALESCE(?,prompt), "
            "model=COALESCE(?,model), "
            "display_prompt=CASE WHEN ? IS NOT NULL THEN NULL ELSE display_prompt END "
            "WHERE id=?",
            (prompt, model, prompt, gen_id),
        )


def _delete_generation(conn: sqlite3.Connection, gen_id: str) -> bool:
    """generation + 모든 자식 행을 한 트랜잭션에서 제거.
    share·history 는 ON DELETE CASCADE 가 없고, generation_comment(_read) 는 FK 자체가
    없어 본체만 지우면 FK 에러나 고아 행이 남는다 → 명시적으로 전부 정리."""
    conn.execute("DELETE FROM share WHERE generation_id=?", (gen_id,))
    conn.execute(
        "DELETE FROM history WHERE parent_gen_id=? OR child_gen_id=?", (gen_id, gen_id)
    )
    # 코멘트 seen(comment_id 기준)은 generation_comment 삭제 전에 먼저 정리 — 안 그러면 고아로 남아
    # 무한 누적되고, comment_id 충돌(복원 등) 시 새 코멘트가 '이미 확인됨'으로 잘못 표시될 수 있다.
    try:
        conn.execute(
            "DELETE FROM generation_comment_seen WHERE comment_id IN "
            "(SELECT id FROM generation_comment WHERE gen_id=?)",
            (gen_id,),
        )
    except Exception:  # noqa: BLE001 — 구버전 DB 에 테이블이 없을 수 있음
        pass
    conn.execute("DELETE FROM generation_comment WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM generation_comment_read WHERE gen_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_auto_tag WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM gen_reference WHERE generation_id=?", (gen_id,))
    conn.execute("DELETE FROM asset WHERE generation_id=?", (gen_id,))
    return conn.execute("DELETE FROM generation WHERE id=?", (gen_id,)).rowcount > 0


def delete_generation(gen_id: str) -> bool:
    """사용자 삭제 = **휴지통 DB 로 이동**(메인에서 제거). 힉스필드 원본엔 영향 없음.
    검색·복원·영구삭제는 휴지통 창(repo.trash)에서. 메인 DB 는 항상 가볍게 유지된다.
    ⚠️ 시스템 정리(sync 중복 등)는 _delete_generation(물리 삭제)을 직접 쓴다(휴지통 안 거침)."""
    from . import trash  # 지연 import — trash 가 이 모듈의 _delete_generation 을 import(순환 회피)
    return trash.move_to_trash(gen_id)


def restore_generation(gen_id: str, account_uid: Optional[str] = None) -> bool:
    """휴지통 DB 에서 메인으로 복원(자식 전부 재생성). account_uid 주면 본인 것만(소유권 게이트)."""
    from . import trash
    return trash.restore_from_trash(gen_id, account_uid)


def gens_with_job_id(account_uid: Optional[str] = None) -> list[tuple[str, str]]:
    """job_id 를 가진 generation [(id, job_id)] — 힉스필드 존재 검증 대상.
    account_uid 지정(AUTH on)이면 내 것만 — 공유 DB 에서 남의 잡을 (다른 신원의) 하우스 CLI 로
    조회·오판해 휴지통 보내는 사고를 막는다. None(단독)이면 전체(기존 동작)."""
    where = "job_id IS NOT NULL AND job_id<>''"
    args: list[Any] = []
    if account_uid is not None:
        where += " AND creator_uid=?"
        args.append(account_uid)
    with get_connection() as conn:
        return [
            (r["id"], r["job_id"])
            for r in conn.execute(
                f"SELECT id, job_id FROM generation WHERE {where}", args
            ).fetchall()
        ]


def set_hf_missing(gen_id: str, missing: bool) -> None:
    """힉스필드 삭제 검증 결과 반영(로컬-only 흐림 처리/필터에 사용)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET hf_missing=? WHERE id=?", (1 if missing else 0, gen_id)
        )


def mark_present_by_job_ids(job_ids: Iterable[str]) -> None:
    """동기화 목록에 나타난 잡 = 힉스필드에 존재 → hf_missing 해제(재등장 항목 흐림 해제)."""
    ids = [j for j in job_ids if j]
    if not ids:
        return
    with get_connection() as conn:
        ph = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE generation SET hf_missing=0 WHERE job_id IN ({ph})", ids
        )


def reconcile_duplicates() -> int:
    """create/sync 레이스로 생긴 중복(같은 결과 URL 을 가진 로컬+동기화 행) 정리.
    로컬(id<>job_id, 사용자 메타 보존)을 남기고 동기화본(id==job_id)의 권위 job_id 를
    로컬에 보장한 뒤 동기화 중복본을 삭제. 예상 모양(로컬 1개)이 아니면 건너뜀(안전)."""
    with get_connection() as conn:
        groups = conn.execute(
            "SELECT GROUP_CONCAT(DISTINCT g.id) ids "
            "FROM generation g JOIN asset a ON a.generation_id=g.id "
            "WHERE COALESCE(a.source_url, a.file_path) LIKE 'http%' "
            "GROUP BY COALESCE(a.source_url, a.file_path) HAVING COUNT(DISTINCT g.id) > 1"
        ).fetchall()
        merged = 0
        for grp in groups:
            ids = [x for x in (grp["ids"] or "").split(",") if x]
            rows = [
                r
                for r in (
                    conn.execute(
                        "SELECT id, job_id FROM generation WHERE id=?", (gid,)
                    ).fetchone()
                    for gid in ids
                )
                if r
            ]
            synced = [r for r in rows if r["job_id"] and r["job_id"] == r["id"]]
            local = [r for r in rows if not (r["job_id"] and r["job_id"] == r["id"])]
            if len(local) != 1 or not synced:
                continue  # 예상 모양(로컬 1 + 동기화 N) 아님 → 안전하게 건너뜀
            keep = local[0]
            conn.execute(
                "UPDATE generation SET job_id=? WHERE id=?", (synced[0]["job_id"], keep["id"])
            )
            for s in synced:
                _delete_generation(conn, s["id"])
                merged += 1
        return merged


def delete_failed_orphans(account_uid: Optional[str] = None) -> int:
    """완료(done)도 진행중(pending/running)도 아닌 비정상 종료 생성물을 모두 **휴지통 DB 로 이동**.
    failed·nsfw(NSFW 차단)는 물론, 향후 새로 생길 차단/오류 status 도 자동 포함된다 —
    '실패'를 특정 값으로 한정하지 않고 '성공/진행중이 아닌 것'으로 일반화. 휴지통에서 복구 가능,
    힉스필드 원본엔 영향 없음.
    account_uid 지정(AUTH on)이면 내 것만 — 공유 DB 에서 남의 실패본까지 쓸어 담는 사고를 막는다."""
    from . import trash
    where = "status NOT IN ('done','pending','running')"
    args: list[Any] = []
    if account_uid is not None:
        where += " AND creator_uid=?"
        args.append(account_uid)
    with get_connection() as conn:
        ids = [
            r["id"]
            for r in conn.execute(
                f"SELECT id FROM generation WHERE {where}", args
            ).fetchall()
        ]
    return sum(1 for gid in ids if trash.move_to_trash(gid))


def migrate_legacy_soft_deleted() -> int:
    """옛 소프트삭제(메인 generation 의 deleted_at) 잔존 행을 새 휴지통 DB 로 1회 이전(멱등).

    이번 모델 전환 전엔 삭제 = deleted_at 만 찍기(메인에 잔류)였다. 전환 후 삭제 = 휴지통 DB 이동
    이라, 옛 deleted_at 행들은 그리드엔 안 보이고(deleted_at IS NULL 만 표시) 휴지통 창(별도 DB)
    에도 없는 '유령'이 되어 프로젝트 카운트만 부풀린다. 이를 휴지통으로 옮겨 복구 가능하게 한다."""
    from . import trash
    with get_connection() as conn:
        ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM generation WHERE deleted_at IS NOT NULL"
            ).fetchall()
        ]
    return sum(1 for gid in ids if trash.move_to_trash(gid))


def import_generation(
    source_gen_id: str, worker_id: str, creator_uid: Optional[str] = None
) -> str:
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + history 기록.

    DESIGN.md §3-6/7, CLAUDE.md 원칙 3·4. 새 gen_id 반환.
    creator_uid: 로그인 계정 신원(있으면 그 계정 작업으로 귀속). 없으면 제공자 my_uid 폴백.
    """
    with get_connection() as conn:
        src = conn.execute(
            "SELECT prompt, display_prompt, model, params, color, project_id "
            "FROM generation WHERE id=?",
            (source_gen_id,),
        ).fetchone()
        if not src:
            raise ValueError(f"원본 generation 없음: {source_gen_id}")

        child_id = new_id()
        # 재생성·가져오기 모두 '내 워크스페이스에 내가 새로 만드는' 자식 → 내 신원으로 귀속
        # (pending 상태에서 팀원으로 오표시되지 않게). 로그인 계정이면 그 계정 uid 로.
        my_uid = creator_uid or identity.get_my_uid()
        conn.execute(
            "INSERT INTO generation"
            "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id, creator_uid) "
            "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?)",
            (
                child_id,
                worker_id,
                src["prompt"],
                src["display_prompt"],  # @소스명 위치 보존 → 인라인 칩 정상 표시
                src["model"],
                src["params"],
                src["color"],
                time.time(),  # 재생성/임포트 직후 맨 위에 보이게(완료 시 힉스필드 시각으로 갱신)
                src["project_id"],  # 재생성본은 부모와 같은 프로젝트에 귀속(일관성)
                my_uid,  # 내 생성자 신원 — 자식은 내 작업
            ),
        )
        # 레퍼런스 연결 복제(원본 reference 레코드는 공유)
        refs = conn.execute(
            "SELECT reference_id, role FROM gen_reference WHERE generation_id=?",
            (source_gen_id,),
        ).fetchall()
        for r in refs:
            _link_reference(conn, child_id, r["reference_id"], r["role"])
        # 태그 복제
        tag_rows = conn.execute(
            "SELECT t.name FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=?",
            (source_gen_id,),
        ).fetchall()
        tags._set_tags(conn, child_id, [t["name"] for t in tag_rows])
        # 자동 태그 복제(일반 태그와 동일하게 — 재생성 시 부모 자동태그 유지)
        auto = conn.execute(
            "SELECT at.name FROM gen_auto_tag gat JOIN auto_tag at ON at.id=gat.auto_tag_id "
            "WHERE gat.generation_id=?",
            (source_gen_id,),
        ).fetchall()
        tags._set_auto_tags(conn, child_id, [a["name"] for a in auto])
        # history 기록 — 재생성/가져오기는 '강한' 파생(derived)
        _record_history(conn, source_gen_id, child_id, "derived")
    return child_id


# ── 조회 / 직렬화 ────────────────────────────────────────────────────────
def _attach_children(
    conn: sqlite3.Connection,
    gens: list[dict[str, Any]],
    viewer_id: str = DEFAULT_WORKER_ID,
    viewer_uid: Optional[str] = None,
) -> list[dict[str, Any]]:
    """generation dict 목록에 assets/references/tags/shared/parent 를 채운다.
    viewer_uid(로그인 계정 creator_uid)가 있으면 프로젝트 이름을 채우고(uuid 노출 금지),
    남의 공유물은 작성자 개인설정(컬러·태그)을 숨긴다(프롬프트·소스·공유여부만 공유)."""
    if not gens:
        return gens
    ids = [g["id"] for g in gens]
    placeholders = ",".join("?" * len(ids))
    by_id = {g["id"]: g for g in gens}
    for g in gens:
        g["assets"] = []
        g["references"] = []
        g["tags"] = []
        g["auto_tags"] = []  # 별도 네임스페이스 — 필터 사이드바 전용(카드·# 피커엔 안 씀)
        g["shared"] = False
        g["parent_gen_id"] = None
        g["child_count"] = 0  # 이 결과물을 부모로 한 파생/사용 수(히스토리 뱃지 ⑂N)
        g["source_count"] = 0  # 이 결과물이 @소스로 쓴 재료(reference 부모) 수
        g["params"] = json.loads(g["params"]) if g.get("params") else None
        g["deleted"] = bool(g.get("deleted_at"))  # 휴지통 여부(카드 흐림·복구 버튼용)
        if "is_source" in g:
            g["is_source"] = bool(g["is_source"])
        if "is_final" in g:
            g["is_final"] = bool(g["is_final"])  # v02 CMS 최종(골드) 여부

    # 생성자(creator_uid) → is_mine + 사용자 지정 이름.
    # is_mine 기준은 '보고 있는 로그인 계정'(viewer_uid)이 우선 — house 가 아닌 계정도 자기 작업이
    # is_mine=true 가 되게 한다. viewer_uid 없으면(단독/AUTH off) 서버 제공자 신원으로 폴백.
    # uid 없을 때: 신원이 정해지기 전(단일 사용자)이면 내 것 취급(옛 데이터 보존), 정해진 팀 모드면 단정 안 함.
    my_uid = viewer_uid or identity.get_my_uid()
    cuids = {g.get("creator_uid") for g in gens if g.get("creator_uid")}
    # 작성자 표시이름 — 사이드바·멤버·코멘트와 동일한 단일 해석기(creator.name → account.name →
    # 이메일 로컬파트). 읽기 시점 해석이라 표시이름 변경이 즉시 전파된다.
    cnames = identity.resolve_display_names(conn, cuids)
    for g in gens:
        cu = g.get("creator_uid")
        g["is_mine"] = (cu == my_uid) if cu else (my_uid is None)
        g["creator_name"] = cnames.get(cu)

    for r in conn.execute(
        f"SELECT id, generation_id, type, file_path, thumbnail_path, source_url "
        f"FROM asset WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        d = dict(r)
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[d["generation_id"]]["assets"].append(d)

    for r in conn.execute(
        f"SELECT gr.generation_id, r.id, r.type, r.file_path, r.thumbnail_path, "
        f"r.source, r.source_url, gr.role FROM gen_reference gr "
        f"JOIN reference r ON r.id = gr.reference_id "
        f"WHERE gr.generation_id IN ({placeholders}) "
        f"ORDER BY gr.rowid",  # 삽입(=제출) 순서 보장 → 인라인 칩 위치 매칭
        ids,
    ).fetchall():
        d = dict(r)
        gid = d.pop("generation_id")
        d["cached"] = bool(d.get("file_path", "").startswith("/media/"))
        by_id[gid]["references"].append(d)

    for r in conn.execute(
        f"SELECT gt.generation_id, t.name FROM gen_tag gt "
        f"JOIN tag t ON t.id = gt.tag_id "
        f"WHERE gt.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["tags"].append(r["name"])

    # 자동 태그(별도 네임스페이스) — 사이드바 필터 전용. 카드/# 피커는 gen.tags 만 읽으므로 누출 없음.
    for r in conn.execute(
        f"SELECT gat.generation_id, a.name FROM gen_auto_tag gat "
        f"JOIN auto_tag a ON a.id = gat.auto_tag_id "
        f"WHERE gat.generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["auto_tags"].append(r["name"])

    for r in conn.execute(
        f"SELECT DISTINCT generation_id FROM share "
        f"WHERE generation_id IN ({placeholders})",
        ids,
    ).fetchall():
        by_id[r["generation_id"]]["shared"] = True

    # 파생 부모(강한 — derived만): 카드 ↻ 뱃지·버전 체인. reference 부모는 source_count 로 따로.
    for r in conn.execute(
        f"SELECT child_gen_id, parent_gen_id FROM history "
        f"WHERE child_gen_id IN ({placeholders}) AND relation='derived'",
        ids,
    ).fetchall():
        by_id[r["child_gen_id"]]["parent_gen_id"] = r["parent_gen_id"]

    # 파생/사용 수(이 결과물이 부모 — 모든 relation): 카드 ⑂N 뱃지용. 배치로 N+1 회피.
    for r in conn.execute(
        f"SELECT parent_gen_id, COUNT(*) AS c FROM history "
        f"WHERE parent_gen_id IN ({placeholders}) GROUP BY parent_gen_id",
        ids,
    ).fetchall():
        if r["parent_gen_id"] in by_id:
            by_id[r["parent_gen_id"]]["child_count"] = r["c"]

    # 재료 수(이 결과물이 @소스로 쓴 reference 부모 개수) — 뱃지 표시 조건 보강(소스만 있어도 표시).
    for r in conn.execute(
        f"SELECT child_gen_id, COUNT(*) AS c FROM history "
        f"WHERE child_gen_id IN ({placeholders}) AND relation='reference' GROUP BY child_gen_id",
        ids,
    ).fetchall():
        if r["child_gen_id"] in by_id:
            by_id[r["child_gen_id"]]["source_count"] = r["c"]

    # 공유 코멘트 스레드 메타: 글 수 + 미확인 여부(뷰어=로그인 viewer_uid, 내 글 제외).
    # 그리드 C 뱃지가 카드마다 떠야 하므로 list 경로에서 배치로 계산(N+1 회피).
    for g in gens:
        g["comment_count"] = 0
        g["has_unread"] = False
    for r in conn.execute(
        f"SELECT gen_id, COUNT(*) AS cnt FROM generation_comment "
        f"WHERE gen_id IN ({placeholders}) GROUP BY gen_id",
        ids,
    ).fetchall():
        by_id[r["gen_id"]]["comment_count"] = r["cnt"]
    # 코멘트 단위 미확인(seen 행 없음) + 알림 정책. 패널에서 개별 코멘트를 클릭해 확인하면 그 행이
    # seen 에 들어가고, 그 gen 의 알림 대상 코멘트가 모두 seen 이면 C 뱃지가 꺼진다.
    # ★ 뷰어는 로그인 계정(viewer_uid) — 패널 seen 기록과 동일 신원이어야 뱃지가 꺼진다.
    #   비로그인(AUTH off)이면 viewer_id('me') 로 폴백.
    # ★ 알림 정책: ① 내가 만든 생성물에 달린 코멘트(g.creator_uid=뷰어), 또는 ② 내 코멘트에 달린
    #   답글(부모 코멘트 author=뷰어)만 알림. 내가 쓴 코멘트는 제외(author<>뷰어). 그 외는 패널에서
    #   볼 수 있어도 알림(뱃지·NEW)은 울리지 않는다 — _alert_comments_sql 로 list/stats 와 규칙 통일.
    cviewer = viewer_uid if viewer_uid is not None else viewer_id
    for r in conn.execute(
        f"SELECT DISTINCT c.gen_id FROM generation_comment c "
        f"{ALERT_COMMENT_JOINS} "
        f"WHERE c.gen_id IN ({placeholders}) AND {ALERT_COMMENT_PREDICATE}",
        [cviewer, *ids, cviewer, cviewer, cviewer],
    ).fetchall():
        by_id[r["gen_id"]]["has_unread"] = True

    # 프로젝트 이름(코드 인식용 uuid 를 사용자에게 노출하지 않는다 — 브라우저 표기는 항상 이름).
    pids = {g["project_id"] for g in gens if g.get("project_id")}
    if pids:
        ph2 = ",".join("?" * len(pids))
        pnames = {
            r["id"]: r["name"]
            for r in conn.execute(
                f"SELECT id, name FROM project WHERE id IN ({ph2})", list(pids)
            ).fetchall()
        }
    else:
        pnames = {}
    for g in gens:
        g["project_name"] = pnames.get(g.get("project_id"))
        # 남의 공유물을 볼 때: 작성자 개인설정(컬러·태그)은 공유하지 않는다.
        # 공유되는 것은 프롬프트·소스(레퍼런스)·공유여부까지. 본인·단독(viewer_uid 없음)은 그대로.
        if viewer_uid and g.get("creator_uid") and g["creator_uid"] != viewer_uid:
            g["color"] = None
            g["tags"] = []
            g["auto_tags"] = []

    return gens


def list_generations(
    *,
    tab: str = "my",
    worker_id: Optional[str] = None,
    color: Optional[str] = None,
    tag: Optional[str] = None,
    share_dir: Optional[str] = None,  # None | 'mine'(내가 공유) | 'received'(타 작업자 공유본)
    local_only: bool = False,  # 힉스필드에 없고 로컬에만 있는 것(job_id 없음 or hf_missing)
    creator_uid: Optional[str] = None,  # 특정 생성자(팀원)만
    account_uid: Optional[str] = None,  # 로그인 계정의 생성자 uid — tab='my' 를 이 계정 것만으로 한정
    team_member_projects: Optional[list[str]] = None,  # tab='team' 일 때 내가 멤버인 프로젝트의 공유물만(None=전체)
    project_id: Optional[str] = None,  # 프로젝트 귀속 필터. 'none'=미분류(NULL), 그 외=해당 프로젝트
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

    if deleted_only:
        where.append("g.deleted_at IS NOT NULL")  # 휴지통 전용 뷰 — 지운 것만
    elif not include_deleted:
        where.append("g.deleted_at IS NULL")  # 휴지통 제외(기본)
    if tab == "team":
        where.append("EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id)")
        # 공유물은 내가 멤버인 프로젝트에 속한 것만(미분류·비멤버 프로젝트 공유물 제외).
        # team_member_projects=None 이면(read_all·단독) 전체 공유물.
        if team_member_projects is not None:
            if team_member_projects:
                ph = ",".join("?" * len(team_member_projects))
                where.append(f"g.project_id IN ({ph})")
                args += list(team_member_projects)
            else:
                where.append("1=0")  # 멤버인 프로젝트 없음 → 공유물 0건
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
        # 공유한 것 — 내가 공유(발행)한 결과물
        where.append(
            "EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id AND s.shared_by = ?)"
        )
        args.append(DEFAULT_WORKER_ID)
    elif share_dir == "received":
        # 공유 받은 것 — 제공자(나 아닌 누군가)를 발신자로 한 share 행이 있는 결과물.
        # worker_id(작업 워크스테이션=항상 'me')가 아니라 shared_by 로 판별 — 가져온 번들은
        # worker_id='me' 로 들어오므로(import_bundle_payload), shared_by<>'me' 가 올바른 기준.
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
        "g.comment, g.error, g.creator_uid, g.project_id, g.deleted_at, "
        "g.is_final, g.final_by, "
        "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id"
        # 정렬키: 힉스필드 created_at(sub-second) 보존 sort_ts. 동률은 id 로 안정화(키셋 total order).
        f"{clause} ORDER BY g.sort_ts DESC, g.id DESC LIMIT ?"
    )
    args.append(limit)

    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        return _attach_children(conn, rows, viewer_uid=account_uid)


def generation_comment_counts(
    gen_ids: list[str], viewer_uid: Optional[str] = None
) -> dict[str, dict[str, Any]]:
    """주어진 gen_id 들의 코멘트 수 + 미확인(has_unread) 여부 — 배치. 로컬 우선에서 '발행본'(서버
    공유) 카드의 코멘트 뱃지를 서버 기준으로 보강(enrich)하는 데 쓴다(_attach_children 와 동일 규칙).
    뷰어=로그인 viewer_uid(seen 기록과 동일 신원이어야 뱃지가 꺼짐)."""
    ids = [g for g in (gen_ids or []) if g]
    out: dict[str, dict[str, Any]] = {g: {"comment_count": 0, "has_unread": False} for g in ids}
    if not ids:
        return out
    ph = ",".join("?" * len(ids))
    cviewer = viewer_uid if viewer_uid is not None else DEFAULT_WORKER_ID
    with get_connection() as conn:
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


def generation_stats(viewer_id: str = DEFAULT_WORKER_ID) -> dict[str, Any]:
    """전역 파생값 — 무한 스크롤로 전량 로드를 안 하므로 클라이언트 대신 서버가 계산.
      · failed_count: 실패·차단 등 비정상(휴지통 제외) 건수('실패 정리' 버튼용, 전역)
      · has_unread:   미확인 코멘트가 하나라도 있나(C 뱃지용, 전역)
    """
    with get_connection() as conn:
        failed = conn.execute(
            "SELECT COUNT(*) FROM generation "
            "WHERE status NOT IN ('done','pending','running') AND deleted_at IS NULL"
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
        row = conn.execute(
            "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
            "g.params, g.color, g.status, g.created_at, g.sort_ts, g.is_source, g.source_name, "
            "g.comment, g.error, g.creator_uid, g.project_id, g.deleted_at, "
            "g.is_final, g.final_by, "
            "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
            "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
            "WHERE g.id = ?",
            (gen_id,),
        ).fetchone()
        if not row:
            return None
        return _attach_children(conn, [dict(row)], viewer_uid=account_uid)[0]


def finalize_id_map(any_id: str) -> tuple[Optional[str], str]:
    """(local_id, server_id) 해석.

    공유 번들은 job_id 를 앵커 id 로 쓴다([repo/share.py] export_bundle) → 서버의 generation id =
    job_id, 로컬 id = 별도 uuid 라 서로 다르다. 그래서 finalize/unfinalize 위임 시 변환이 필요:
      · server_id = 그 로컬 행의 job_id(없으면 로컬 id) — 서버가 아는 id.
      · local_id  = 로컬 generation.id — 골드 미러용.
    any_id 가 로컬 id 든(내 작업·히스토리) 서버 job_id 든(팀 탭) 모두 같은 행을 찾는다.
    로컬에 없으면 (None, any_id) — 서버 위임은 받은 id 그대로."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, job_id FROM generation WHERE id=? OR job_id=? LIMIT 1",
            (any_id, any_id),
        ).fetchone()
    if not row:
        return None, any_id
    return row["id"], (row["job_id"] or row["id"])


_GEN_SELECT_COLS = (
    "g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
    "g.params, g.color, g.status, g.created_at, g.sort_ts, g.is_source, g.source_name, "
    "g.comment, g.error, g.creator_uid, g.project_id, g.deleted_at, g.is_final, g.final_by, "
    "(g.job_id IS NULL OR g.job_id='' OR g.hf_missing=1) AS local_only "
    "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id"
)


def _fetch_gens(
    conn: sqlite3.Connection, ids: list[str], viewer_uid: Optional[str] = None
) -> dict[str, dict[str, Any]]:
    """id 목록 → {id: 직렬화된 generation dict}. 순서 보존 안 함(호출부가 id 순서로 재구성).
    viewer_uid 가 있으면 남의 공유물 색/태그를 가린다(_attach_children 규칙)."""
    if not ids:
        return {}
    ph = ",".join("?" * len(ids))
    rows = [
        dict(r)
        for r in conn.execute(
            f"SELECT {_GEN_SELECT_COLS} WHERE g.id IN ({ph})", ids
        ).fetchall()
    ]
    return {g["id"]: g for g in _attach_children(conn, rows, viewer_uid=viewer_uid)}


def _gen_row_visible(
    g: Optional[dict[str, Any]], viewer_uid: Optional[str], read_all: bool
) -> bool:
    """계보(history) 노드 가시성 — 공유된 것/내 것/전역 read_all 만 노출.
    원칙: 내가 볼 수 없는 남의 비공개 생성물은 계보에서도 빼서 프롬프트·파라미터 유출을 막는다."""
    if not g:
        return False
    if read_all or g.get("shared"):
        return True
    return bool(viewer_uid) and g.get("creator_uid") == viewer_uid


def get_history(
    gen_id: str, viewer_uid: Optional[str] = None, read_all: bool = True
) -> Optional[dict[str, Any]]:
    """한 결과물의 가계(히스토리) — relation 별로 분리:
        {ancestors:[파생 부모→…→루트], materials:[쓴 @소스], target,
         children:[파생 버전], used_by:[이걸 @소스로 쓴 것]}.

    - ancestors: 'derived' 부모를 위로 따라간 버전 체인(루트가 마지막).
    - materials: 이 결과물이 @소스로 쓴 'reference' 부모들(재료 ⬆).
    - children: 이 결과물을 부모로 한 'derived' 파생 버전(최신순).
    - used_by: 이 결과물을 @소스로 쓴 'reference' 자식들(사용처, 최신순).
    모두 완전 직렬화된 generation. 순환·중복은 방문집합으로 방어. 없는 id 면 None."""
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            return None
        # 조상 체인: 'derived' 부모만 위로 따라간다(버전 히스토리).
        anc_ids: list[str] = []
        seen = {gen_id}
        cur = gen_id
        while True:
            row = conn.execute(
                "SELECT parent_gen_id FROM history WHERE child_gen_id=? AND relation='derived' LIMIT 1",
                (cur,),
            ).fetchone()
            if not row or row["parent_gen_id"] in seen:
                break
            pid = row["parent_gen_id"]
            anc_ids.append(pid)
            seen.add(pid)
            cur = pid
        material_ids = [
            r["parent_gen_id"]
            for r in conn.execute(
                "SELECT parent_gen_id FROM history WHERE child_gen_id=? AND relation='reference'",
                (gen_id,),
            ).fetchall()
        ]
        child_ids = [
            r["child_gen_id"]
            for r in conn.execute(
                "SELECT child_gen_id FROM history WHERE parent_gen_id=? AND relation='derived'",
                (gen_id,),
            ).fetchall()
        ]
        used_by_ids = [
            r["child_gen_id"]
            for r in conn.execute(
                "SELECT child_gen_id FROM history WHERE parent_gen_id=? AND relation='reference'",
                (gen_id,),
            ).fetchall()
        ]
        # 약한 형제(Phase C) — 같은 입력 소스(레퍼런스 URL)를 공유한 다른 결과물.
        # 동기화 잡은 자동 히스토리가 없으므로(힉스필드 원본에 부모 없음) 입력 소스 동일성으로 묶는다.
        ref_keys = [
            r["k"]
            for r in conn.execute(
                "SELECT DISTINCT COALESCE(r.source_url, r.file_path) k FROM gen_reference gr "
                "JOIN reference r ON r.id = gr.reference_id WHERE gr.generation_id = ?",
                (gen_id,),
            ).fetchall()
            if r["k"]
        ]
        sibling_ids: list[str] = []
        if ref_keys:
            exclude = {gen_id, *anc_ids, *material_ids, *child_ids, *used_by_ids}
            kph = ",".join("?" * len(ref_keys))
            for r in conn.execute(
                f"SELECT DISTINCT gr.generation_id gid FROM gen_reference gr "
                f"JOIN reference r ON r.id = gr.reference_id "
                f"JOIN generation g ON g.id = gr.generation_id "
                f"WHERE COALESCE(r.source_url, r.file_path) IN ({kph}) "
                f"AND g.deleted_at IS NULL",
                ref_keys,
            ).fetchall():
                if r["gid"] not in exclude:
                    sibling_ids.append(r["gid"])
                    exclude.add(r["gid"])
            sibling_ids = sibling_ids[:24]  # 과도한 목록 방지(상한)
        # 형제를 깊이별로 묶어 보여주기 위한 각 형제의 'derived' 체인 깊이(일괄 조회).
        sib_depth = _derived_depth_batch(conn, sibling_ids)
        gens = _fetch_gens(
            conn,
            [gen_id, *anc_ids, *material_ids, *child_ids, *used_by_ids, *sibling_ids],
            viewer_uid=viewer_uid,
        )
    me = gens.get(gen_id)
    if not me:
        return None
    # 가시성 정책: **공유된(=내가 볼 수 있는) 결과물의 계보는 전부 노출**한다 — 다른 작업자도 이
    # 결과물이 어떻게 만들어졌는지(조상·재료, 연결된 라인)를 확인할 수 있어야 하기 때문. 라우터가
    # 포커스 가시성을 이미 보장하므로, 포커스가 보이면 중간에 공유 안 된 노드라도 계보 안에선 보인다.
    # (포커스를 못 보는 방어적 경우에만 노드별로 거른다 — 보통 라우터가 먼저 404.)
    focus_visible = _gen_row_visible(me, viewer_uid, read_all)

    def _vis(i: str) -> bool:
        return focus_visible or _gen_row_visible(gens.get(i), viewer_uid, read_all)

    anc_ids = [i for i in anc_ids if _vis(i)]
    material_ids = [i for i in material_ids if _vis(i)]
    child_ids = [i for i in child_ids if _vis(i)]
    used_by_ids = [i for i in used_by_ids if _vis(i)]
    sibling_ids = [i for i in sibling_ids if _vis(i)]

    def _newest(ids: list[str]) -> list[dict[str, Any]]:
        return sorted(
            (gens[i] for i in ids if i in gens),
            key=lambda g: g.get("sort_ts") or 0,
            reverse=True,
        )

    return {
        "ancestors": [gens[i] for i in anc_ids if i in gens],  # 부모 → 루트 순
        "materials": _newest(material_ids),
        "target": me,
        "children": _newest(child_ids),
        "used_by": _newest(used_by_ids),
        # 형제엔 깊이를 실어 보낸다(프론트에서 깊이별 그룹화 + 깊이로 연결 방향 결정).
        "siblings": [{**s, "depth": sib_depth.get(s["id"], 0)} for s in _newest(sibling_ids)],
    }


def _directed_lineage(conn: sqlite3.Connection, gen_id: str, limit: int = 300) -> set[str]:
    """gen_id 의 '연결된 라인' 노드집합 — 조상(부모 위로) + 자신 + 자손(자식 아래로).
    형제·곁가지(부모의 다른 자식, 자손의 다른 부모)는 제외 — 이 결과물로 이어지는 직계 라인만.
    타 작업자가 공유물의 계보를 볼 때 쓴다(연결된 라인만 보이고 나머지는 안 보여도 됨)."""
    out: set[str] = {gen_id}
    # 위로(조상): child_gen_id 가 현재 집합인 부모들
    frontier = [gen_id]
    while frontier and len(out) < limit:
        ph = ",".join("?" * len(frontier))
        nxt = [
            r["x"]
            for r in conn.execute(
                f"SELECT parent_gen_id x FROM history WHERE child_gen_id IN ({ph})", frontier
            ).fetchall()
        ]
        frontier = [n for n in nxt if n not in out]
        out.update(frontier)
    # 아래로(자손): parent_gen_id 가 현재 집합인 자식들
    frontier = [gen_id]
    while frontier and len(out) < limit:
        ph = ",".join("?" * len(frontier))
        nxt = [
            r["x"]
            for r in conn.execute(
                f"SELECT child_gen_id x FROM history WHERE parent_gen_id IN ({ph})", frontier
            ).fetchall()
        ]
        frontier = [n for n in nxt if n not in out]
        out.update(frontier)
    return out


def get_history_graph(
    gen_id: str, limit: int = 300, viewer_uid: Optional[str] = None, read_all: bool = True
) -> Optional[dict[str, Any]]:
    """gen_id 가 속한 **연결된 가계 전체**(노드+엣지+루트) — 구성탭 히스토리 트리용.

    history 엣지를 양방향으로 따라 연결 컴포넌트를 모으고(약한형제는 제외 — 명시 엣지만),
    그 안의 모든 엣지(relation 포함)와 완전 직렬화된 generation 을 돌려준다.
    roots = 컴포넌트 안에서 들어오는 엣지가 없는 노드(원본). 없는 id 면 None.
    limit: 안전 상한(폭주 방지) — BFS 가 이 수에 닿으면 멈춘다."""
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM generation WHERE id=?", (gen_id,)).fetchone():
            return None
        # 가시 범위 결정: 내 작업(또는 read_all)이면 연결된 가계 **전체**(형제·곁가지 포함),
        # 남의 공유물을 보는 타 작업자에겐 이 결과물의 **연결된 라인만**(조상+자손, 형제·곁가지 제외).
        frow = conn.execute(
            "SELECT creator_uid FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
        focus_owned = bool(viewer_uid) and frow and frow["creator_uid"] == viewer_uid
        if read_all or focus_owned:
            # 연결 컴포넌트 BFS(부모·자식 양방향). 명시 history 엣지만(약한형제 제외).
            node_ids: set[str] = {gen_id}
            frontier = [gen_id]
            while frontier and len(node_ids) < limit:
                ph = ",".join("?" * len(frontier))
                neigh = [
                    r["x"]
                    for r in conn.execute(
                        f"SELECT child_gen_id x FROM history WHERE parent_gen_id IN ({ph}) "
                        f"UNION SELECT parent_gen_id x FROM history WHERE child_gen_id IN ({ph})",
                        [*frontier, *frontier],
                    ).fetchall()
                ]
                frontier = [n for n in neigh if n not in node_ids]
                node_ids.update(frontier)
        else:
            node_ids = _directed_lineage(conn, gen_id, limit)
        ids = list(node_ids)
        iph = ",".join("?" * len(ids))
        edges = [
            {"parent_gen_id": r["parent_gen_id"], "child_gen_id": r["child_gen_id"], "relation": r["relation"]}
            for r in conn.execute(
                f"SELECT parent_gen_id, child_gen_id, relation FROM history "
                f"WHERE parent_gen_id IN ({iph}) AND child_gen_id IN ({iph})",
                [*ids, *ids],
            ).fetchall()
        ]
        gens = _fetch_gens(conn, ids, viewer_uid=viewer_uid)
    if gen_id not in gens:
        return None
    # 가시성 정책: 포커스(공유물)가 보이면 **연결된 가계 전체를 노출**한다 — 중간에 공유 안 된
    # 노드가 있어도 계보 라인이 끊기지 않게(다른 작업자도 이 결과물의 연결 라인을 본다). 포커스를
    # 못 보는 방어적 경우에만 노드별로 거르고, 그 노드에 닿는 엣지도 끊는다(라우터가 보통 먼저 404).
    if not _gen_row_visible(gens.get(gen_id), viewer_uid, read_all):
        gens = {
            i: g for i, g in gens.items() if _gen_row_visible(g, viewer_uid, read_all)
        }
        if gen_id not in gens:
            return None
    edges = [
        e
        for e in edges
        if e["parent_gen_id"] in gens and e["child_gen_id"] in gens
    ]
    ids = list(gens.keys())
    # 루트 = 컴포넌트 안에서 부모 엣지를 받지 않는 노드(원본). 시간 오름차순으로.
    has_parent = {e["child_gen_id"] for e in edges}
    roots = [
        gens[i]
        for i in sorted(ids, key=lambda x: gens[x].get("sort_ts") or 0)
        if i not in has_parent and i in gens
    ]
    nodes = sorted(gens.values(), key=lambda g: g.get("sort_ts") or 0)
    return {
        "nodes": nodes,
        "edges": edges,
        "root_ids": [r["id"] for r in roots],
        "focus_id": gen_id,
    }


# 에셋 소스 합성용 — 레퍼런스 타입은 image|video 만(오디오 등 제외)
_ASSET_IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_ASSET_VID_EXT = (".mp4", ".mov", ".webm", ".mkv", ".avi")


def _asset_media_type(name: str) -> Optional[str]:
    low = name.lower()
    if low.endswith(_ASSET_IMG_EXT):
        return "image"
    if low.endswith(_ASSET_VID_EXT):
        return "video"
    return None


def _asset_sources(
    conn: sqlite3.Connection,
    query: Optional[str],
    tag: Optional[str],
    project: str,
    directory: Optional[str],
    limit: int,
    owner_uid: str = "",
) -> list[dict[str, Any]]:
    """에셋 파트(asset_meta)의 소스(is_source=1)를 Generation 모양으로 합성.

    현재 에셋 폴더(directory)로 스코프 — 그 폴더 및 하위만. @ 피커에 생성 소스와 함께 노출.
    asset_meta 는 계정별 개인화라 **내(owner_uid) 소스만** 합류한다(남의 소스 안 섞임).
    레퍼런스 값은 'asset:{project}|{path}' 토큰(생성 시 절대 로컬경로로 resolve → CLI 자동 업로드).
    """
    from urllib.parse import quote

    where = ["project = ?", "is_source = 1", "owner_uid = ?"]
    args: list[Any] = [project, owner_uid]
    if directory:
        where.append("(path = ? OR path LIKE ?)")
        args += [directory, directory + "/%"]
    if query:
        where.append("source_name LIKE ?")
        args.append(f"%{query}%")
    sql = (
        "SELECT path, source_name, tags, color FROM asset_meta WHERE "
        + " AND ".join(where)
        + " ORDER BY source_name IS NULL, source_name LIMIT ?"
    )
    args.append(limit)

    out: list[dict[str, Any]] = []
    for r in conn.execute(sql, args).fetchall():
        path = r["path"]
        name = path.split("/")[-1]
        mt = _asset_media_type(name)
        if not mt:  # 오디오 등은 레퍼런스 타입(image|video) 밖 → 제외
            continue
        tags_val = json.loads(r["tags"]) if r["tags"] else []
        if tag and tag not in tags_val:  # # 태그 필터(asset_meta tags 는 JSON 이라 파이썬서 필터)
            continue
        qp = f"project={quote(project)}&path={quote(path)}"
        sid = f"asset:{project}:{path}"
        out.append(
            {
                "id": sid,
                "worker_id": DEFAULT_WORKER_ID,
                "worker_name": None,
                "prompt": r["source_name"] or name,
                "model": None,
                "params": None,
                "color": r["color"],
                "status": "done",
                "created_at": "",
                "tags": tags_val,
                "shared": False,
                "parent_gen_id": None,
                "is_source": True,
                "source_name": r["source_name"] or name.rsplit(".", 1)[0],
                "comment": None,
                "assets": [
                    {
                        "id": sid,
                        "generation_id": sid,
                        "type": mt,
                        "file_path": f"/api/assets/file?{qp}",
                        "thumbnail_path": f"/api/assets/thumb?{qp}&w=512" if mt == "image" else None,
                        "source_url": f"asset:{project}|{path}",
                        "cached": True,
                    }
                ],
                "references": [],
            }
        )
    return out


def search_sources(
    query: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = 60,
    asset_project: Optional[str] = None,
    asset_dir: Optional[str] = None,
    owner_uid: str = "",
) -> list[dict[str, Any]]:
    """소스 등록된 생성본을 @이름/프롬프트(query) 또는 #태그(tag)로 검색.

    스포트라이트의 @/# 피커가 사용. is_source=1 인 것만.
    asset_project 가 주어지면 에셋 파트 소스(현재 폴더 asset_dir 로 스코프)도 합류한다.
    """
    # 휴지통(soft delete)으로 보낸 소스는 @ 피커에서도 제외 — 카탈로그에서 숨겼는데
    # 재사용 가능하면 안 됨(하드삭제 때와 동일한 가시성 유지).
    where = ["g.is_source = 1", "g.deleted_at IS NULL"]
    args: list[Any] = []
    if owner_uid:
        # 가시성: 내 것 또는 공유된 것만 — 다계정(AUTH on) 서버에서 남의 '비공개' 소스
        # (프롬프트·모델·params·URL)가 @ 피커로 유출되던 구멍 차단. owner_uid 없으면(AUTH off/단독) 전체.
        where.append(
            "(g.creator_uid = ? OR EXISTS (SELECT 1 FROM share s WHERE s.generation_id = g.id))"
        )
        args.append(owner_uid)
    if query:
        where.append("(g.source_name LIKE ? OR g.prompt LIKE ?)")
        args += [f"%{query}%", f"%{query}%"]
    if tag:
        where.append(
            "EXISTS (SELECT 1 FROM gen_tag gt JOIN tag t ON t.id=gt.tag_id "
            "WHERE gt.generation_id=g.id AND t.name = ?)"
        )
        args.append(tag)
    sql = (
        "SELECT g.id, g.worker_id, w.name AS worker_name, g.prompt, g.display_prompt, g.model, "
        "g.params, g.color, g.status, g.created_at, g.is_source, g.source_name, g.comment, g.error "
        "FROM generation g LEFT JOIN worker w ON w.id = g.worker_id "
        "WHERE " + " AND ".join(where) +
        " ORDER BY g.source_name IS NULL, g.source_name, g.created_at DESC LIMIT ?"
    )
    args.append(limit)
    with get_connection() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
        gen_sources = _attach_children(conn, rows)
        asset_sources = (
            _asset_sources(conn, query, tag, asset_project, asset_dir, limit, owner_uid)
            if asset_project
            else []
        )
    return gen_sources + asset_sources


def get_facets(account_uid: Optional[str] = None) -> dict[str, Any]:
    """필터 사이드바 facet — 컬러/일반태그/자동태그. account_uid 가 있으면 '내 생성물에 쓰인 것'만
    돌려준다(개인 설정 — 다른 사람의 컬러/태그가 사이드바에 새지 않게). 없으면(AUTH off/단독) 전체."""
    gen_filter = " AND g.creator_uid = ?" if account_uid else ""
    gen_args: list[Any] = [account_uid] if account_uid else []
    with get_connection() as conn:
        colors = [
            r["color"]
            for r in conn.execute(
                "SELECT DISTINCT g.color FROM generation g "
                "WHERE g.color IS NOT NULL AND g.color <> '' AND g.deleted_at IS NULL"
                f"{gen_filter} ORDER BY g.color",
                gen_args,
            ).fetchall()
        ]
        tags_list = [
            r["name"]
            for r in conn.execute(
                "SELECT DISTINCT t.name FROM tag t "
                "JOIN gen_tag gt ON gt.tag_id = t.id "
                "JOIN generation g ON g.id = gt.generation_id "
                f"WHERE g.deleted_at IS NULL{gen_filter} ORDER BY t.name",
                gen_args,
            ).fetchall()
        ]
        # 전역 태그(auto_tag)는 별도 테이블 — 일반 tags 와 완전 분리(누출 없음). 계정별 소유라
        # **그 계정이 만든 것 전부**를 돌려준다(쓰인 것만이 아니라 — 방금 +로 만든 태그도 즉시 보여
        # 무장·삭제할 수 있게). owner: 로그인 계정 uid, 단독(None)이면 제공자 my_uid 로 폴백.
        owner_uid = account_uid if account_uid is not None else identity.get_my_uid()
        auto_tags = [
            r["name"]
            for r in conn.execute(
                "SELECT name FROM auto_tag WHERE owner_uid IS ? ORDER BY name",
                (owner_uid,),
            ).fetchall()
        ]
        workers = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, account_type FROM worker ORDER BY name"
            ).fetchall()
        ]
    return {"colors": colors, "tags": tags_list, "auto_tags": auto_tags, "workers": workers}
