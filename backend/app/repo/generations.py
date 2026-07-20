"""생성본(generation) 업서트·로컬 생성·상태·조회/직렬화·소스 검색."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Iterable, Optional

from ..config import DEFAULT_WORKER_ID
from ..db import get_connection
from . import identity, tags
from .generation_rows import (  # 조회 응답 보강·행 페치(분리) — 단방향 import
    _attach_children,
    _fetch_generation,
)
from .lineage import _record_history  # generations 가 쓰는 lineage private helper (단방향: generations → lineage)
from ._common import (
    ALERT_COMMENT_JOINS,
    ALERT_COMMENT_PREDICATE,
    _cached_or_remote,
    clean_folder_path as _clean_folder_path,
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
def _upsert_synced(
    conn, parsed: dict[str, Any], worker_id: str, tombstoned: Optional[set[str]] = None
) -> str:
    """업서트 본체 — 주어진 커넥션에서 실행(트랜잭션 제어는 호출측). apply_synced_jobs 가
    한 트랜잭션에 묶어 호출하고, 단건 wrapper(upsert_synced_generation)는 자체 커넥션을 연다.

    tombstoned: 휴지통에 든 잡 id 집합. 여기 포함된 잡은 재적재하지 않는다 — 없으면 사용자가 지운
    생성물이 CLI 목록에 남아 있는 한 다음 동기화마다 새 행으로 되살아난다(삭제 후 재등장 버그).
    트랜잭션 안에서는 휴지통 DB 를 ATTACH 조회할 수 없어(sqlite 제약), 호출측이 미리 넘겨준다."""
    g = parsed["generation"]
    # CLI 로 넘길 때 붙인 zero-width space sentinel(통째 JSON 프롬프트를 CLI 가 문자열로 받게 하는 방어)이
    # generate list 를 통해 되돌아오면 저장 데이터에 안 보이는 문자가 낀다 → sync/ingest/공유 import 가
    # 모두 지나는 이 공통 관문에서 선행분을 떼어낸다(display_prompt 는 이 경로에서 안 만들어져 제외).
    if isinstance(g.get("prompt"), str):
        g["prompt"] = g["prompt"].lstrip(chr(0x200B))
    if isinstance(g.get("params"), dict) and isinstance(g["params"].get("prompt"), str):
        g["params"]["prompt"] = g["params"]["prompt"].lstrip(chr(0x200B))
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
            # 삭제(휴지통)된 잡은 새 행으로 되살리지 않는다 — 여기(existing 없음=신규 INSERT 직전)에서만
            # 거른다. 위 existing 분기(id/job_id/URL 매칭된 live 행)는 정상 갱신되게 둔다(같은 job_id 가
            # 메인에 살아있는데도 갱신이 막히던 문제 방지 — 코덱스 리뷰 #2). 없으면 삭제물이 재등장한다.
            if tombstoned and job_id in tombstoned:
                return "unchanged"
            # ★Phase 0b: 동기화 행도 id 는 uuid, job_id 는 속성으로만(더는 id==job_id 아님). 이로써
            # 새 데이터의 id 이중성이 사라진다 — 식별은 항상 uuid, job_id 는 동기화 멱등 키. 멱등 매칭은
            # 위 existing 조회의 `job_id=?` 가, 번들 import 의 계보·코멘트는 _find_id_by_job(job_id)→uuid
            # 가 처리하므로(id==job_id 가정 없음) 다운스트림 무변. 레거시 id==job_id 행은 그대로 호환.
            target_id = new_id()
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, model, params, color, status, created_at, sort_ts, "
                # sort_ts 누락 시 created_at 에서 파생 — 키셋 페이지네이션이 이 행을 놓치지 않게(NULL 금지).
                # origin='synced' — 순수 동기화본(판별을 id==job_id 좌표가 아닌 명시 마커로).
                "creator_uid, job_id, origin) VALUES(?,?,?,?,?,?,?,?,COALESCE(?, strftime('%s', ?)),?,?, 'synced')",
                (
                    target_id,
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
            if is_img:
                # 로컬 캐시된 이미지(fp=/media): thumb=로컬경로 → 자체 리사이즈(공짜·고화질).
                # 원격(미캐시) 이미지: 원본 full 대신 CLI 경량 썸네일(min_result_url)을 thumbnail_path 로
                # 써서 팀 browse 로 원본을 통째 받지 않게 한다(원본 보존은 완료 저장이 선별로 담당).
                # thumbnail_url 폴백: 공유받은 이미지는 min-url 이 thumbnail_url 로 실려온다(share.py 가
                # http 썸네일을 그 키로 보존) → 이걸 무시하면 수신측이 원본 full 을 다시 캐시하게 된다.
                if not fp.startswith("/media/"):
                    thumb = a.get("min_result_url") or a.get("thumbnail_url") or thumb
            else:
                thumb = thumb or a.get("thumbnail_url")  # 영상: CLI 정적 포스터(우리 썸네일러가 영상 미지원)
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

        # ★공유 전용 share_url 백필 — 로컬 토큰 레퍼런스(asset:캡쳐 등)에도 힉스필드 공개 URL 을 보관해
        # 두면, 팀에 공유했을 때 받는 쪽이 내 PC 파일 없이도 그 소스를 쓸 수 있다. 로컬 동작(file_path/
        # source_url)은 절대 안 건드린다(번들 export 만 share_url 을 씀).
        # 동기화 medias 의 공개 URL 과 로컬 레퍼런스를 '개수 일치 시 순서'로만 매칭(오매칭 방지).
        synced_urls = [
            r["file_path"]
            for r in parsed.get("references", [])
            if r.get("file_path") and str(r["file_path"]).startswith("http")
        ]
        if synced_urls:
            # 제출(parsed) 순서와 맞추려면 gr.rowid(삽입=제출 순서) 로 정렬해야 한다. gr.role 알파벳순은
            # @Image10<@Image2·@Video 위치가 어긋나 엉뚱한 URL 이 엉뚱한 ref 에 박히고 COALESCE 로
            # 영구 고정됐다(_link_reference 가 parsed 순서대로 INSERT 하므로 rowid 가 곧 제출 순서).
            local_refs = conn.execute(
                "SELECT gr.reference_id FROM gen_reference gr WHERE gr.generation_id=? "
                "ORDER BY gr.rowid",
                (target_id,),
            ).fetchall()
            if len(local_refs) == len(synced_urls):
                for lr, url in zip(local_refs, synced_urls):
                    conn.execute(
                        "UPDATE reference SET share_url=COALESCE(share_url, ?) WHERE id=?",
                        (url, lr["reference_id"]),
                    )

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


def unknown_job_ids(job_ids: list[str], creator_uid: Optional[str] = None) -> list[str]:
    """받은 job_id 중 서버에 아직 없는 것만 — POST known-jobs 차집합용(전량 응답 대체).
    creator_uid 를 주면 그 계정 소유분만 known 으로 봐 GET known_job_ids 와 같은 경계를 유지한다
    (남 계정 job 존재 여부 oracle 방지). 잡 id 는 힉스필드 전역 유일이라 스코프해도 판정은 정확."""
    ids = [j for j in (job_ids or []) if j]
    if not ids:
        return []
    ph = ",".join("?" * len(ids))
    sql = f"SELECT job_id FROM generation WHERE job_id IN ({ph})"
    args: list[Any] = list(ids)
    if creator_uid:
        sql += " AND creator_uid = ?"
        args.append(creator_uid)
    with get_connection() as conn:
        known = {r["job_id"] for r in conn.execute(sql, args).fetchall()}
    return [j for j in ids if j not in known]


def upsert_synced_generation(parsed: dict[str, Any], worker_id: str) -> str:
    """cli_bridge.parse_job 결과를 로컬 DB 에 업서트(단건, 자체 커넥션).

    반환: 'inserted'(신규) | 'updated'(상태 변동) | 'unchanged'. job id 를 PK 로 써서
    재동기는 멱등. 기존 사용자 메타(태그/컬러/display_prompt/명명 레퍼런스)는 보존한다.
    여러 건을 한 번에 처리할 땐 apply_synced_jobs(한 트랜잭션·fsync 1회)를 쓴다."""
    from . import trash  # 지연 import(순환 회피)

    job_id = (parsed.get("generation") or {}).get("id")
    with get_connection() as conn:
        trash.attach_trash(conn)  # 휴지통 ATTACH(트랜잭션 밖)
        try:
            # generation + asset 캐시 + reference 링크를 한 트랜잭션으로 — 중간 실패 시 반쪽 데이터 방지.
            conn.execute("BEGIN IMMEDIATE")
            try:
                # 쓰기락 획득 후 tombstone 조회(삭제 경합 차단) — apply_synced_jobs 와 동일 원리.
                tombstoned = trash.tombstoned_among(conn, [job_id] if job_id else [])
                result = _upsert_synced(conn, parsed, worker_id, tombstoned)
                conn.execute("COMMIT")
                return result
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            trash.detach_trash(conn)


def apply_synced_jobs(jobs: list[dict[str, Any]], worker_id: str) -> dict[str, int]:
    """동기화 잡 묶음을 **한 커넥션·한 트랜잭션**으로 업서트 + hf_missing 해제. 카운트 반환.

    이전엔 잡마다 커넥션을 새로 열고(autocommit) execute 마다 fsync 가 일어나, 100건 동기화가
    수백 fsync + 커넥션 100회로 버스트를 만들었다. 묶으면 fsync 1회로 줄어 경합이 급감한다.
    ⚠️ 동기 블로킹 — 호출측(syncer.sync_now)이 asyncio.to_thread 로 워커 스레드에서 돌린다."""
    from . import trash  # 지연 import(순환 회피)

    counts = {"inserted": 0, "updated": 0, "unchanged": 0, "errors": 0}
    job_ids = [
        p["generation"]["id"]
        for p in jobs
        if p.get("generation") and p["generation"].get("id")
    ]
    with get_connection() as conn:
        trash.attach_trash(conn)  # 휴지통 ATTACH(트랜잭션 밖) — 아래 BEGIN 안에서 최신 삭제상태 조회
        try:
            conn.execute("BEGIN IMMEDIATE")  # 전체 묶음을 1회 커밋(fsync 1회) + 즉시 쓰기락
            try:
                # ★쓰기락 획득 '후' tombstone 조회 → 삭제 직후 동기화 경합에서도 방금 삭제된 잡을 본다
                #  (재등장 차단). 들어온 잡만 IN 조회라 휴지통이 커져도 스캔 비용이 안 늘어난다.
                tombstoned = trash.tombstoned_among(conn, job_ids)
                for parsed in jobs:
                    # 잡별 SAVEPOINT 격리 — 한 잡이 깨져도(ROLLBACK TO) 나머지는 그대로 반영.
                    conn.execute("SAVEPOINT j")
                    try:
                        counts[_upsert_synced(conn, parsed, worker_id, tombstoned)] += 1
                    except Exception as e:  # noqa: BLE001 — 잡 1건 실패가 전체 동기화를 막지 않게
                        conn.execute("ROLLBACK TO j")
                        counts["errors"] += 1
                        print(f"[sync] 잡 1건 건너뜀: {e}")
                    finally:
                        conn.execute("RELEASE j")
                if job_ids:
                    ph = ",".join("?" * len(job_ids))
                    conn.execute(
                        f"UPDATE generation SET hf_missing=0 WHERE job_id IN ({ph})", job_ids
                    )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            trash.detach_trash(conn)  # 성공/실패 무관 반드시 뗀다(풀 커넥션 재사용 대비)
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
        # generation + 태그 + 레퍼런스 + 히스토리 엣지를 한 트랜잭션으로 — 중간 실패 시
        # generation 만 있고 태그·레퍼런스·계보가 빠진 반쪽 데이터가 생기지 않게.
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id, folder_path, creator_uid, origin) "
                "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?, 'local')",  # origin='local' — 내가 만든 행
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
                    _clean_folder_path(data.get("folder_path")),  # 무장 폴더(렌더 루트 상대 경로)
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
            conn.execute("COMMIT")
            return gen_id
        except Exception:
            conn.execute("ROLLBACK")
            raise




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


def list_stuck_synced_active(older_than_seconds: float = 300.0) -> list[tuple[str, str]]:
    """유령 '생성중' 카드 후보 [(id, job_id)] — 힉스필드에 제출됐다 사라진(rejected) 잡이
    동기화본 pending/running 으로 남아 세션 내내 '생성중'에 멈춘 것. 오살 방지로 좁게 겨냥:
      · origin='synced' + gen_request 없음 → 로컬 생성 진행중(정상)·요청 있는 행은 제외
      · job_id 보유 → generate get 으로 검증 가능한 것만
      · sort_ts 가 older_than 초과 → 방금 제출돼 아직 get API 에 전파 안 된 잡의 일시 not-found 오판 방지
    실제 삭제 판정은 호출측이 generate get(job_exists=False) 로 확정한다(존재·확인불가는 안 건드림)."""
    cutoff = time.time() - older_than_seconds
    with get_connection() as conn:
        return [
            (r["id"], r["job_id"])
            for r in conn.execute(
                "SELECT g.id, g.job_id FROM generation g "
                "WHERE g.origin='synced' AND g.status IN ('pending','running') "
                "AND g.job_id IS NOT NULL AND g.job_id<>'' AND g.deleted_at IS NULL "
                "AND g.sort_ts IS NOT NULL AND g.sort_ts < ? "
                "AND NOT EXISTS (SELECT 1 FROM gen_request r WHERE r.gen_id=g.id)",
                (cutoff,),
            ).fetchall()
        ]


def set_job_id(gen_id: str, job_id: str) -> None:
    """로컬 생성본에 실제 Higgsfield 잡 id 를 기록 — 이후 동기화가 이 행을
    중복 생성 없이 갱신하도록(중복 방지의 핵심).

    레이스 병합: 로컬 생성이 끝나기 전에 주기 동기화가 같은 잡을 먼저 동기화본
    (id == job_id)으로 INSERT 했을 수 있다. 그 경우 사용자 메타(display_prompt·@소스명·
    태그·컬러)가 없는 동기화본은 버리고 로컬을 남긴다(병합).

    ★ SELECT dup → delete → UPDATE 를 BEGIN IMMEDIATE 로 직렬화한다 — autocommit 단발이면
    그 사이 동기화가 같은 잡을 INSERT 해 중복 2행이 살아남던 레이스(apply_local_fulfillment 는
    이미 IMMEDIATE 로 막은 것과 동일)를 set_job_id 경로에서도 닫는다."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        # 동기화 중복본(origin='synced' 이고 같은 job_id)을 찾는다 — id==job_id 좌표가 아닌 마커로(0a).
        dup = conn.execute(
            "SELECT id FROM generation WHERE job_id=? AND id<>? AND origin='synced'",
            (job_id, gen_id),
        ).fetchone()
        if dup:
            _delete_generation(conn, dup["id"])  # 레이스로 생긴 동기화 중복본 제거
        conn.execute("UPDATE generation SET job_id=? WHERE id=?", (job_id, gen_id))


def update_asset_cache(
    asset_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """asset 을 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        # thumbnail_path 는 새 값이 있을 때만 갱신(COALESCE) — 영상 캐시는 thumb=None 이라, 무조건
        # 덮으면 CLI 정적 포스터(thumbnail_url)가 지워진다. 이미지는 local 경로(non-None)라 정상 갱신.
        conn.execute(
            "UPDATE asset SET file_path=?, thumbnail_path=COALESCE(?, thumbnail_path), "
            "source_url=COALESCE(source_url, ?) WHERE id=?",
            (file_path, thumbnail_path, source_url, asset_id),
        )


def update_reference_cache(
    ref_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """reference 를 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    with get_connection() as conn:
        # thumbnail_path 는 새 값이 있을 때만 갱신(COALESCE) — 영상 포스터 보존(update_asset_cache 와 동일).
        conn.execute(
            "UPDATE reference SET file_path=?, thumbnail_path=COALESCE(?, thumbnail_path), "
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
) -> bool:
    """gen-request fulfill 의 다단계 쓰기(에셋 추가·job_id 병합·타임스탬프·상태·요청표시)를 한
    트랜잭션으로 묶는다 — 예전엔 5개 분리 커밋이라 중간에 주기 동기화가 끼면 부분 상태(예: job_id 만
    반영되고 status 는 아직 옛값)를 보는 창이 있었다. BEGIN IMMEDIATE 로 전부 한 번에 커밋.

    ★ 멱등 CAS: 요청표시 UPDATE 를 `WHERE status NOT IN ('done','failed')` 로 먼저 시도해
    rowcount 0(이미 종결)이면 ROLLBACK 하고 False 반환 — 동시 fulfill/fail 이 라우터의 트랜잭션
    밖 status 검사를 동시 통과해 done↔failed 가 뒤집히던 TOCTOU 를 닫는다. 적용했으면 True."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE gen_request SET status=?, error=?, updated_at=datetime('now') "
            "WHERE id=? AND status NOT IN ('done','failed')",
            (request_status, error, rid),
        )
        if cur.rowcount == 0:  # 이미 종결된 요청 → 아무 것도 안 함(멱등)
            conn.execute("ROLLBACK")
            return False
        if asset_type and asset_path:
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                "VALUES(?,?,?,?,?)",
                (new_id(), gen_id, asset_type, asset_path, asset_thumb),
            )
        if job_id:
            # 레이스 병합: 동기화가 같은 잡을 동기화본으로 먼저 넣었으면 그 중복본 제거(origin 마커로 판별).
            dup = conn.execute(
                "SELECT id FROM generation WHERE job_id=? AND id<>? AND origin='synced'",
                (job_id, gen_id),
            ).fetchone()
            if dup:
                _delete_generation(conn, dup["id"])
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
    return True


def apply_local_failure(gen_id: str, rid: str, reason: str) -> bool:
    """gen-request fail 을 원자·CAS 로 적용 — 요청표시와 generation 상태를 한 트랜잭션에.
    요청이 이미 종결(done/failed)이면 ROLLBACK·False(완료를 실패로 뒤집지 않음 — fulfill 과 대칭).
    예전엔 set_status + mark_request 2개 분리 커밋이라 그 사이 fulfill 이 끼면 split 상태가 났다."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE gen_request SET status='failed', error=?, updated_at=datetime('now') "
            "WHERE id=? AND status NOT IN ('done','failed')",
            (reason, rid),
        )
        if cur.rowcount == 0:
            conn.execute("ROLLBACK")
            return False
        conn.execute(
            "UPDATE generation SET status='failed', error=? WHERE id=?", (reason, gen_id)
        )
    return True


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
    없어 본체만 지우면 FK 에러나 고아 행이 남는다 → 명시적으로 전부 정리.
    ★child 테이블을 추가하면 backend/cleanup_orphan_creators.py 의 복사본도 같이 고칠 것
    (그 스크립트는 표준 라이브러리만 쓰는 독립 도구라 이 함수를 import 하지 않는다)."""
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
    where = "job_id IS NOT NULL AND job_id<>'' AND deleted_at IS NULL"
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


def get_generation_identity(gen_id: str) -> tuple[Optional[str], Optional[str]]:
    """서버 재검증용 (creator_uid, job_id) — 공개 get_generation dict 엔 job_id 가 없어 직접 조회한다.
    HF 삭제 검토 적용 시 '내 것이고 job_id 일치'를 확인하는 데 쓴다. 없으면 (None, None)."""
    with get_connection() as conn:
        r = conn.execute(
            "SELECT creator_uid, job_id FROM generation WHERE id=?", (gen_id,)
        ).fetchone()
        return (r["creator_uid"], r["job_id"]) if r else (None, None)


def set_hf_missing(gen_id: str, missing: bool) -> None:
    """힉스필드 삭제 검증 결과 반영(로컬-only 흐림 처리/필터에 사용)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET hf_missing=? WHERE id=?", (1 if missing else 0, gen_id)
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
                        "SELECT id, job_id, origin FROM generation WHERE id=?", (gid,)
                    ).fetchone()
                    for gid in ids
                )
                if r
            ]
            # 동기화본 vs 로컬: id==job_id 좌표가 아니라 명시 마커(origin)로 판별(0a). NULL=레거시→local.
            synced = [r for r in rows if (r["origin"] or "local") == "synced"]
            local = [r for r in rows if (r["origin"] or "local") != "synced"]
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
    # 내 신원 해석은 트랜잭션 전에 — identity.get_my_uid()가 내부에서 커넥션을 열 수 있어
    # BEGIN IMMEDIATE 안에서 부르면 중첩/별도 커넥션 문제가 된다.
    my_uid = creator_uid or identity.get_my_uid()
    with get_connection() as conn:
        # 자식 generation + 레퍼런스·태그 복제 + 계보 엣지를 한 트랜잭션으로(반쪽 복제 방지).
        conn.execute("BEGIN IMMEDIATE")
        try:
            src = conn.execute(
                "SELECT prompt, display_prompt, model, params, color, project_id, folder_path "
                "FROM generation WHERE id=?",
                (source_gen_id,),
            ).fetchone()
            if not src:
                raise ValueError(f"원본 generation 없음: {source_gen_id}")

            child_id = new_id()
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, project_id, folder_path, creator_uid, origin) "
                "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?, 'local')",  # origin='local' — 가져오기는 내 새 행
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
                    src["folder_path"],  # 재생성본은 부모와 같은 폴더에 귀속(일관성)
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
            conn.execute("COMMIT")
            return child_id
        except Exception:
            conn.execute("ROLLBACK")
            raise


# ── 조회 / 직렬화 ────────────────────────────────────────────────────────
# _attach_children 은 generation_rows.py 로 분리(조회 응답 보강). 상단에서 import 한다.


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
        if team_member_projects is not None:
            if team_member_projects:
                ph = ",".join("?" * len(team_member_projects))
                if actor_uid:
                    where.append(f"(g.creator_uid = ? OR g.project_id IN ({ph}))")
                    args.append(actor_uid)
                else:
                    where.append(f"g.project_id IN ({ph})")
                args += list(team_member_projects)
            elif actor_uid:
                where.append("g.creator_uid = ?")
                args.append(actor_uid)
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
        "g.comment, g.error, g.creator_uid, g.project_id, g.folder_path, g.deleted_at, "
        "g.is_final, g.final_by, g.job_id, "  # job_id: 팀 카드(서버 UUID)↔로컬 개인메타 매핑 앵커
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
        return _fetch_generation(conn, gen_id, account_uid)


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


# id 해석(finalize_id_map/resolve_local_id/resolve_and_get/personal_meta_by_anchor)은 id_resolve.py 로,
# 가계 조회(get_history/get_history_graph)는 history.py 로 분리.




