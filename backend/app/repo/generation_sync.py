"""CLI 생성 결과 → 로컬 generation 동기화 저장소.

job 식별·단건/배치 업서트·휴지통 tombstone 경계를 한곳에서 소유한다.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from ..db import get_connection
from ..generation_result import stored_error
from ..workspace_context import normalize_workspace_context, workspace_columns
from ._common import _cached_or_remote, new_id
from .generation_references import _link_reference, _upsert_reference


# 레퍼런스 미부착 등 로컬 검증 실패는 CLI 동기화가 done 으로 되살리지 못한다.
NO_REVIVE_ERROR = "레퍼런스가 적용되지 않았습니다(생성물에 입력 이미지 미부착) — 다시 시도하세요"


# ── 동기화 업서트 (CLI → 로컬) ───────────────────────────────────────────
def _upsert_synced(
    conn,
    parsed: dict[str, Any],
    worker_id: str,
    tombstoned: Optional[set[str]] = None,
    workspace: Optional[dict[str, Any]] = None,
) -> str:
    """업서트 본체 — 주어진 커넥션에서 실행(트랜잭션 제어는 호출측). apply_synced_jobs 가
    한 트랜잭션에 묶어 호출하고, 단건 wrapper(upsert_synced_generation)는 자체 커넥션을 연다.

    tombstoned: 휴지통에 든 잡 id 집합. 여기 포함된 잡은 재적재하지 않는다 — 없으면 사용자가 지운
    생성물이 CLI 목록에 남아 있는 한 다음 동기화마다 새 행으로 되살아난다(삭제 후 재등장 버그).
    트랜잭션 안에서는 휴지통 DB 를 ATTACH 조회할 수 없어(sqlite 제약), 호출측이 미리 넘겨준다."""
    g = parsed["generation"]
    # 잡 자체가 생성 당시 workspace 를 알고 있으면 배치 조회 시점의 현재 선택값보다 우선한다.
    # MCP 백필처럼 서로 다른 workspace 이력이 한 묶음에 들어오는 경로에서 ``workspace or g``를
    # 쓰면 전 이력을 마지막 선택 공간으로 오귀속한다. 개별 값이 unknown일 때만 호출측이 검증한
    # 동기화 묶음 컨텍스트를 fallback으로 사용한다. 기존 DB의 확정 귀속은 아래 UPDATE가 보존한다.
    # 내부 parsed generation의 workspace 표현은 평면 ``workspace_*``만 허용한다. 일반 generation의
    # 다른 의미 ``scope``를 workspace로 오인하지 않는다(parse_job이 외부 중첩 객체를 평면화).
    has_job_workspace = any(
        key in g for key in ("workspace_scope", "workspace_id", "workspace_name")
    )
    job_workspace = normalize_workspace_context(g)
    # 개별 필드가 아예 없을 때만 배치 fallback을 허용한다. 개별 필드가 있는데 검증에 실패해
    # unknown이 된 경우까지 현재 선택값으로 채우면 fail-closed 규칙을 다시 우회하게 된다.
    workspace_source = job_workspace if has_job_workspace else workspace
    workspace_scope, workspace_id, workspace_name = workspace_columns(workspace_source)
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
            "SELECT id, status, error, workspace_scope FROM generation "
            "WHERE id = ? OR job_id = ? LIMIT 1",
            (job_id, job_id),
        ).fetchone()
        # URL 매칭 — id/job_id 로 못 찾았고 결과 URL 이 있으면, 같은 결과물을 가진 로컬 생성본을
        # 찾는다(create 가 job_id 를 못 받았거나 list id 와 다른 경우의 안전망). job_id 를 덮어쓴다.
        adopt = False
        if not existing and result_url:
            existing = conn.execute(
                "SELECT g.id, g.status, g.error, g.workspace_scope FROM generation g "
                "JOIN asset a ON a.generation_id=g.id "
                "WHERE a.file_path=? OR a.source_url=? LIMIT 1",
                (result_url, result_url),
            ).fetchone()
            adopt = existing is not None

        result = "inserted"
        if existing:
            # ★되살림 금지 실패(레퍼런스 미부착) 행은 sync 가 done 으로 되살리지 않는다 — 힉스필드 목록엔
            #  완료로 있어도 우리가 실패 확정한 '엉뚱한 결과'라 재등장시키면 안 됨.
            if existing["status"] == "failed" and (existing["error"] or "") == NO_REVIVE_ERROR:
                return "unchanged"
            target_id = existing["id"]
            workspace_filled = (
                existing["workspace_scope"] == "unknown" and workspace_scope != "unknown"
            )
            result = (
                "updated"
                if existing["status"] != g["status"] or workspace_filled
                else "unchanged"
            )
            # adopt(URL 매칭)면 job_id 를 권위값으로 덮어씀, 아니면 기존 보존(COALESCE).
            # sort_ts 는 힉스필드 정밀 epoch 으로 갱신 → 로컬 생성본도 힉스필드 순서에 정렬(있을 때만).
            job_id_set = "job_id=?" if adopt else "job_id=COALESCE(job_id, ?)"
            # ★error 정합: failed→done 되살림 시 옛 실패 사유를 비운다(stored_error 가 done/pending/running 이면
            #  None). 여전히 실패(failed/nsfw)면 기존 사유를 그대로 보존(existing["error"]) → 사유 유실 방지.
            conn.execute(
                f"UPDATE generation SET status=?, error=?, model=COALESCE(model,?), params=?, "
                f"sort_ts=COALESCE(?, sort_ts), creator_uid=COALESCE(?, creator_uid), "
                f"workspace_scope=CASE WHEN workspace_scope='unknown' THEN ? ELSE workspace_scope END, "
                f"workspace_id=CASE WHEN workspace_scope='unknown' THEN ? ELSE workspace_id END, "
                f"workspace_name=CASE WHEN workspace_scope='unknown' THEN ? ELSE workspace_name END, "
                f"{job_id_set} WHERE id=?",
                (
                    g["status"],
                    stored_error(g["status"], existing["error"]),
                    g["model"],
                    json.dumps(g["params"], ensure_ascii=False),
                    g.get("sort_ts"),
                    g.get("creator_uid"),
                    workspace_scope,
                    workspace_id,
                    workspace_name,
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
                "creator_uid, job_id, origin, workspace_scope, workspace_id, workspace_name) "
                "VALUES(?,?,?,?,?,?,?,?,COALESCE(?, strftime('%s', ?)),?,?, 'synced',?,?,?)",
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
                    workspace_scope,
                    workspace_id,
                    workspace_name,
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


_REFRESHABLE_JOB_STATUSES = frozenset(
    {"pending", "queued", "waiting", "running", "processing", "in_progress"}
)


def job_id_sync_diff(
    job_ids: list[str], creator_uid: Optional[str] = None
) -> dict[str, list[str]]:
    """로컬 job_id 중 서버에 없거나 아직 진행 상태인 항목을 분리한다.

    ``unknown`` 은 신규 적재 대상, ``refresh`` 는 서버에는 있지만 실제 완료 여부를 다시 받아야 할
    대상이다. creator_uid 를 주면 그 계정 소유분만 조회해 남의 job 존재 여부를 노출하지 않는다.
    """
    ids = [j for j in (job_ids or []) if j]
    if not ids:
        return {"unknown": [], "refresh": []}
    ph = ",".join("?" * len(ids))
    sql = f"SELECT job_id, status FROM generation WHERE job_id IN ({ph})"
    args: list[Any] = list(ids)
    if creator_uid:
        sql += " AND creator_uid = ?"
        args.append(creator_uid)
    with get_connection() as conn:
        known = {
            r["job_id"]: str(r["status"] or "").strip().lower()
            for r in conn.execute(sql, args).fetchall()
        }
    return {
        "unknown": [j for j in ids if j not in known],
        "refresh": [
            j for j in ids if j in known and known[j] in _REFRESHABLE_JOB_STATUSES
        ],
    }


def unknown_job_ids(job_ids: list[str], creator_uid: Optional[str] = None) -> list[str]:
    """하위 호환용: 받은 job_id 중 서버에 아직 없는 것만 반환한다."""
    return job_id_sync_diff(job_ids, creator_uid)["unknown"]


def upsert_synced_generation(
    parsed: dict[str, Any], worker_id: str, workspace: Optional[dict[str, Any]] = None
) -> str:
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
                result = _upsert_synced(conn, parsed, worker_id, tombstoned, workspace)
                conn.execute("COMMIT")
                return result
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            trash.detach_trash(conn)


def apply_synced_jobs(
    jobs: list[dict[str, Any]],
    worker_id: str,
    workspace: Optional[dict[str, Any]] = None,
) -> dict[str, int]:
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
                        counts[_upsert_synced(conn, parsed, worker_id, tombstoned, workspace)] += 1
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
