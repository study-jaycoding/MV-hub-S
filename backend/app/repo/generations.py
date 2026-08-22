"""생성본 로컬 생성·상태·삭제·재조정.

조회/직렬화는 generations_query.py, CLI 결과 적재는 generation_sync.py가 소유한다.
"""

from __future__ import annotations

from contextvars import ContextVar
import json
import sqlite3
import time
from typing import Any, Callable, Literal, Optional, Sequence

from ..db import get_connection
from ..generation_result import ACTIVE_STATUSES, stored_error
from ..workspace_context import workspace_columns
from . import identity, tags
from .generation_references import _link_reference, _upsert_reference
from .generation_delete import delete_generation_rows as _delete_generation
from .generation_sync import NO_REVIVE_ERROR
from .lineage import _record_history  # generations 가 쓰는 lineage private helper (단방향: generations → lineage)
from .personal_meta_transactions import _current_personal_meta_batch_connection
from ._common import (
    clean_folder_path as _clean_folder_path,
    new_id,
)

# ── 로컬 생성 (POST create) ──────────────────────────────────────────────
def create_local_generation(
    data: dict[str, Any], worker_id: str, creator_uid: Optional[str] = None,
    workspace: Optional[dict[str, Any]] = None,
    generation_id: Optional[str] = None,
) -> str:
    """status=pending 인 로컬 generation 레코드 생성. gen_id 반환.

    data: GenerationCreate.model_dump() 형태.
    creator_uid: 로그인한 계정의 생성자 신원(있으면 그것으로 귀속 → 계정별 '내 작업' 분리).
                 없으면(비로그인/단독) 제공자 my_uid 로 폴백(기존 동작).
    """
    gen_id = generation_id or new_id()
    # 내가 지금 만드는 것이므로 내 신원으로 즉시 귀속 — 동기화로 creator_uid 가 채워지기 전
    # 'pending' 상태에서도 is_mine=True(=나)가 되게 한다(팀원으로 오표시되던 버그 수정).
    # 로그인 계정이면 그 계정 uid, 아니면 제공자 my_uid(없으면 NULL → 단독 사용자 취급).
    my_uid = creator_uid or identity.get_my_uid()
    workspace_scope, workspace_id, workspace_name = workspace_columns(workspace)
    with get_connection() as conn:
        # generation + 태그 + 레퍼런스 + 히스토리 엣지를 한 트랜잭션으로 — 중간 실패 시
        # generation 만 있고 태그·레퍼런스·계보가 빠진 반쪽 데이터가 생기지 않게.
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, "
                "project_id, folder_path, creator_uid, origin, workspace_scope, workspace_id, workspace_name) "
                "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?, 'local', ?, ?, ?)",  # origin='local' — 내가 만든 행
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
                    workspace_scope,
                    workspace_id,
                    workspace_name,
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


def find_comfy_generation_by_asset(
    file_path: str, creator_uid: Optional[str] = None
) -> Optional[str]:
    """이미 저장된 Comfy 출력인지 asset.file_path 로 조회(중복 저장 방지). 있으면 gen_id.
    creator_uid 지정 시 그 계정 저장본만(계정별 '내 작업' 분리). 휴지통 행은 제외."""
    where = "a.file_path=? AND g.generator='comfy' AND g.deleted_at IS NULL"
    args: list[Any] = [file_path]
    if creator_uid:
        where += " AND g.creator_uid=?"
        args.append(creator_uid)
    with get_connection() as conn:
        row = conn.execute(
            "SELECT g.id FROM generation g JOIN asset a ON a.generation_id=g.id "
            f"WHERE {where} LIMIT 1",
            args,
        ).fetchone()
        return row["id"] if row else None


def create_comfy_generation(
    *,
    worker_id: str,
    creator_uid: Optional[str],
    prompt: str,
    display_prompt: Optional[str],
    params: dict[str, Any],
    kind: str,
    file_path: str,
    thumbnail_path: Optional[str],
    references: Optional[list[dict[str, Any]]] = None,
    project_id: Optional[str] = None,
    folder_path: Optional[str] = None,
    workspace: Optional[dict[str, Any]] = None,
) -> tuple[str, bool]:
    """캔버스 Comfy 노드 출력 1개를 라이브러리 generation(+asset)으로 물질화. (gen_id, existed) 반환.

    힉스필드 생성물과 구분: origin='local'(내 것), generator='comfy'(만든 도구),
    job_id=NULL(=HF 삭제검증 대상 아님), status='done'. asset 1행을 같은 트랜잭션으로 넣어
    '내 작업' 그리드에 바로 뜨게 한다. 입력 refs 는 계보(reference/history)로 기록.

    멱등: 같은 file_path(+creator_uid)로 이미 저장된 comfy 저장본이 있으면 그것을 재사용한다.
    조회→INSERT 를 한 BEGIN IMMEDIATE 트랜잭션 안에서 처리해 동시 저장(더블클릭) 중복을 막는다.
    """
    gen_id = new_id()
    my_uid = creator_uid or identity.get_my_uid()
    workspace_scope, workspace_id, workspace_name = workspace_columns(workspace)
    now = time.time()
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            # 같은 트랜잭션 안에서 중복 검사(레이스 차단). 있으면 그 gen 재사용.
            dedup_where = "a.file_path=? AND g.generator='comfy' AND g.deleted_at IS NULL"
            dedup_args: list[Any] = [file_path]
            if my_uid:
                dedup_where += " AND g.creator_uid=?"
                dedup_args.append(my_uid)
            dup = conn.execute(
                "SELECT g.id FROM generation g JOIN asset a ON a.generation_id=g.id "
                f"WHERE {dedup_where} LIMIT 1",
                dedup_args,
            ).fetchone()
            if dup:
                conn.execute("COMMIT")
                return dup["id"], True
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, display_prompt, model, params, status, sort_ts, "
                " project_id, folder_path, creator_uid, origin, generator, "
                "workspace_scope, workspace_id, workspace_name) "
                "VALUES(?,?,?,?, 'comfy', ?, 'done', ?, ?, ?, ?, 'local', 'comfy', ?, ?, ?)",
                (
                    gen_id,
                    worker_id,
                    prompt,
                    display_prompt,
                    json.dumps(params or {}, ensure_ascii=False),
                    now,
                    project_id,
                    _clean_folder_path(folder_path),
                    my_uid,
                    workspace_scope,
                    workspace_id,
                    workspace_name,
                ),
            )
            conn.execute(
                "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                "VALUES(?,?,?,?,?)",
                (new_id(), gen_id, kind, file_path, thumbnail_path or file_path),
            )
            src_gen_ids: set[str] = set()
            for ref in references or []:
                rid = _upsert_reference(
                    conn,
                    ref_id=None,
                    type_=ref.get("type", "image"),
                    file_path=ref["file_path"],
                    thumbnail_path=ref.get("thumbnail"),
                    source=ref.get("name") or "uploaded",
                    source_url=ref.get("source_url"),
                )
                _link_reference(conn, gen_id, rid, ref.get("role"))
                sgid = ref.get("source_gen_id")
                if sgid and sgid != gen_id:
                    src_gen_ids.add(sgid)
            for sgid in src_gen_ids:
                _record_history(conn, sgid, gen_id, "reference")
            conn.execute("COMMIT")
            return gen_id, False
        except Exception:
            conn.execute("ROLLBACK")
            raise


def set_status(gen_id: str, status: str, error: Optional[str] = None) -> None:
    """상태 전이. 터미널(failed·nsfw 등)이면 error(사유)를 저장하고, 그 외 전이는 error 를 비운다
    (재시도/재생성으로 성공·진행 시 옛 사유가 남지 않게).

    ★done 보호: 완료된 카드는 절대 되돌리지 않는다. 호출처 4곳 전부 'running' 으로 내리는
    경로인데, 주기 동기화가 먼저 done 으로 확정한 직후 늦은 reconcile(캐시된 generate get,
    빈 바디 POST /reconcile 포함)이 도착하면 완료본이 '생성중'으로 회귀해 사용자가 재생성
    → 크레딧 이중 지출로 이어졌다. 형제 함수들(apply_reconcile·apply_local_anchor·
    apply_local_fulfillment)과 같은 규약. failed→running 은 허용(고아 복구 경로)."""
    with get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status=?, error=? WHERE id=? AND status <> 'done'",
            (status, stored_error(status, error), gen_id),
        )


def fail_orphaned_jobs() -> int:
    """서버 시작 시 호출 — 영속 gen_request가 없는 옛 인메모리 잡만 고아로 정리한다.

    현재 생성 큐는 DB에 영속된다. 따라서 정상 pending/claimed 요청이나 제출 여부가 불명확한
    recovery_required 요청의 placeholder를 서버 재시작만으로 failed로 만들면 안 된다. job_id가
    있는 카드는 기존 작업을 재조정하고, 활성 gen_request가 전혀 없는 옛 카드만 실패 처리한다.
    반환: 실제로 failed로 정리한 옛 고아 수."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE generation SET status='failed', "
            "error=COALESCE(error, '서버 재시작으로 생성이 중단되었습니다. 동기화로 결과를 가져오거나 재생성하세요.') "
            "WHERE status IN ('pending','running') AND (job_id IS NULL OR job_id='') "
            "AND NOT EXISTS ("
            "  SELECT 1 FROM gen_request r WHERE r.gen_id=generation.id "
            "  AND r.status IN ('preparing','pending','claimed','submitting','running','tracking','verifying','blocked','recovery_required')"
            ")"
        )
        # job_id 보유분 → running 유지 + '확인중'(재조정 대기). 이미 문구가 있으면 덮지 않는다.
        conn.execute(
            "UPDATE generation SET status='running', error=? "
            "WHERE status IN ('pending','running') AND job_id IS NOT NULL AND job_id<>'' "
            "AND (error IS NULL OR error='')",
            (VERIFYING_NOTE,),
        )
        return cur.rowcount


def list_stuck_synced_active(
    older_than_seconds: float = 300.0,
    creator_uid: Optional[str] = None,
) -> list[tuple[str, str]]:
    """유령 '생성중' 카드 후보 [(id, job_id)] — 힉스필드에 제출됐다 사라진(rejected) 잡이
    동기화본 pending/running 으로 남아 세션 내내 '생성중'에 멈춘 것. 오살 방지로 좁게 겨냥:
      · origin='synced' + gen_request 없음 → 로컬 생성 진행중(정상)·요청 있는 행은 제외
      · job_id 보유 → generate get 으로 검증 가능한 것만
      · sort_ts 가 older_than 초과 → 방금 제출돼 아직 get API 에 전파 안 된 잡의 일시 not-found 오판 방지
      · creator_uid 지정 시 정확히 같은 소유자만(NULL 포함 불명확 소유자는 제외)
    실제 삭제 판정은 호출측이 generate get(job_exists=False) 로 확정한다(존재·확인불가는 안 건드림)."""
    cutoff = time.time() - older_than_seconds
    creator_scope = " AND g.creator_uid=?" if creator_uid is not None else ""
    args: list[Any] = [cutoff]
    if creator_uid is not None:
        args.append(creator_uid)
    with get_connection() as conn:
        return [
            (r["id"], r["job_id"])
            for r in conn.execute(
                "SELECT g.id, g.job_id FROM generation g "
                "WHERE g.origin='synced' AND g.status IN ('pending','running') "
                "AND g.job_id IS NOT NULL AND g.job_id<>'' AND g.deleted_at IS NULL "
                "AND g.sort_ts IS NOT NULL AND g.sort_ts < ? "
                "AND NOT EXISTS (SELECT 1 FROM gen_request r WHERE r.gen_id=g.id)"
                + creator_scope,
                args,
            ).fetchall()
        ]


def list_reconcile_candidates(account_email: str, limit: int = 200) -> list[dict[str, Any]]:
    """재조정 후보 [{rid, gen_id, job_id}] — 이 계정 소유의 로컬 카드 중 '실제 상태 미확정'인 것.
    판정(레이스 안전): generation 이 non-terminal(running/pending) + job_id 보유 + 요청이
    tracking/verifying/blocked인 카드. 구버전 앵커(done/failed)도 한 릴리즈 동안 복구 후보로 수용한다.
      · 제외: job_id 없는 하드 실패(로컬검증실패)·done/failed 확정본. 오염 없음."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT r.id AS rid, g.id AS gen_id, g.job_id AS job_id
            FROM generation g
            JOIN gen_request r ON r.gen_id = g.id
            WHERE g.origin='local'
              AND g.job_id IS NOT NULL AND g.job_id<>''
              AND g.status IN ('running','pending')
              AND g.deleted_at IS NULL
              AND r.status IN ('tracking','verifying','blocked','done','failed')
              AND r.account_email = ?
            ORDER BY g.sort_ts ASC
            LIMIT ?
            """,
            (account_email.lower(), limit),
        ).fetchall()
    return [dict(r) for r in rows]


def apply_reconcile(
    gen_id: str,
    job_id: str,
    *,
    asset_type: Optional[str],
    asset_path: Optional[str],
    asset_thumb: Optional[str],
    created_at: Optional[str],
    sort_ts: Optional[float],
    status: str,
    error: Optional[str],
    force_fail_reason: Optional[str] = None,
    provider_status: Optional[str] = None,
) -> bool:
    """재조정 권위 보정 — 에이전트가 `generate list/get` 으로 확보한 실제 상태를 로컬 카드에 적용한다.
    ★fulfill 의 CAS 와 달리 failed→done '되살리기'를 허용한다(가짜 실패 복구). 대신 조건이 강하다:
      · id·job_id 동시 일치 + origin='local' 일 때만(다른 카드·동기화본 오염 차단).
      · 이미 done 확정본은 절대 뒤집지 않는다(에셋 있는 완료본 보호).
      · 상태 변화가 없으면 no-op(False).
    force_fail_reason 이 주어지면(레퍼런스 미부착 등 '로컬 검증 실패') — 힉스필드엔 (엉뚱한) 결과가
    완료로 있어도 원래 행은 failed 로 확정하고 job_id·NO_REVIVE_ERROR 를 남긴다. 동기화 저장소는 이
    표식을 보고 실제 유료 결과를 별도 synced 행으로 격리하므로, 원래 카드에는 자동 부착되지 않는다.
    (status=failed 라 backstop 후보에서도 제외됨). done 확정본은 여기서도 건드리지 않는다.
    적용했으면 True(호출부가 브로드캐스트)."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT status, error FROM generation WHERE id=? AND job_id=? AND origin='local'",
            (gen_id, job_id),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return False
        if row["status"] == "done":
            conn.execute(
                "UPDATE gen_request SET status='done', provider_status=?, error=NULL, "
                "last_checked_at=datetime('now'), terminal_at=COALESCE(terminal_at,datetime('now')), "
                "updated_at=datetime('now') WHERE gen_id=?",
                (provider_status, gen_id),
            )
            return False
        if force_fail_reason:
            if row["status"] == "failed":
                conn.execute("ROLLBACK")  # 이미 실패 확정
                return False
            # 되살림 금지 실패 — job_id 유지 + error=NO_REVIVE_ERROR(아래 일반경로·_upsert_synced 가 보호).
            conn.execute(
                "UPDATE generation SET status='failed', error=? WHERE id=?",
                (NO_REVIVE_ERROR, gen_id),
            )
            conn.execute(
                "UPDATE gen_request SET status='failed', provider_status=?, error=?, "
                "terminal_at=datetime('now'), updated_at=datetime('now') WHERE gen_id=?",
                (provider_status, force_fail_reason, gen_id),
            )
            return True
        # 되살림 금지 실패 행은 일반 재조정(done 승격)으로도 되살리지 않는다(백스톱 레이스 최종 방어).
        if status == "done" and row["status"] == "failed" and (row["error"] or "") == NO_REVIVE_ERROR:
            conn.execute("ROLLBACK")
            return False
        if row["status"] == status:
            request_status = "done" if status == "done" else "failed"
            conn.execute(
                "UPDATE gen_request SET status=?, provider_status=?, error=?, "
                "last_checked_at=datetime('now'), terminal_at=COALESCE(terminal_at,datetime('now')), "
                "updated_at=datetime('now') WHERE gen_id=?",
                (request_status, provider_status, error, gen_id),
            )
            return False
        # ★done 인데 결과물(에셋)이 아직 없으면 확정하지 않는다 — generate get 이 완료를 먼저 주고 result_url
        #  이 늦게 붙는 경우 '빈 완료 카드'가 되는 것을 막는다. 확인중 유지 → 다음 사이클에 result_url 붙으면 확정.
        if status == "done" and not asset_path:
            conn.execute("ROLLBACK")
            return False
        # 성공계열(done 등)이고 아직 에셋이 없으면 에셋 INSERT(fulfill 과 동일 규칙). 실패/nsfw 는 에셋 없음.
        if status != "failed" and asset_type and asset_path:
            has_asset = conn.execute(
                "SELECT 1 FROM asset WHERE generation_id=? LIMIT 1", (gen_id,)
            ).fetchone()
            if not has_asset:
                conn.execute(
                    "INSERT INTO asset(id, generation_id, type, file_path, thumbnail_path) "
                    "VALUES(?,?,?,?,?)",
                    (new_id(), gen_id, asset_type, asset_path, asset_thumb),
                )
        if sort_ts is not None:
            conn.execute(
                "UPDATE generation SET sort_ts=?, created_at=COALESCE(?, created_at) WHERE id=?",
                (sort_ts, created_at, gen_id),
            )
        conn.execute(
            "UPDATE generation SET status=?, error=? WHERE id=?",
            (status, stored_error(status, error), gen_id),
        )
        request_status = "done" if status == "done" else "failed"
        conn.execute(
            "UPDATE gen_request SET status=?, provider_status=?, error=?, "
            "last_checked_at=datetime('now'), terminal_at=datetime('now'), "
            "lease_owner=NULL, lease_expires_at=NULL, updated_at=datetime('now') WHERE gen_id=?",
            (request_status, provider_status, error, gen_id),
        )
    return True


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


MediaCacheUpdate = tuple[
    Literal["asset", "ref"], str, str, Optional[str], Optional[str]
]
MediaCacheUpdater = Callable[[str, str, Optional[str], Optional[str]], None]
_media_cache_batch_conn: ContextVar[sqlite3.Connection | None] = ContextVar(
    "media_cache_batch_conn", default=None
)


def _update_asset_cache(
    conn: sqlite3.Connection,
    asset_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    # thumbnail_path 는 새 값이 있을 때만 갱신(COALESCE) — 영상 캐시는 thumb=None 이라, 무조건
    # 덮으면 CLI 정적 포스터(thumbnail_url)가 지워진다. 이미지는 local 경로(non-None)라 정상 갱신.
    conn.execute(
        "UPDATE asset SET file_path=?, thumbnail_path=COALESCE(?, thumbnail_path), "
        "source_url=COALESCE(source_url, ?) WHERE id=?",
        (file_path, thumbnail_path, source_url, asset_id),
    )


def update_asset_cache(
    asset_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """asset 을 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    batch_conn = _media_cache_batch_conn.get()
    if batch_conn is not None:
        _update_asset_cache(batch_conn, asset_id, file_path, thumbnail_path, source_url)
        return
    with get_connection() as conn:
        _update_asset_cache(conn, asset_id, file_path, thumbnail_path, source_url)


def _update_reference_cache(
    conn: sqlite3.Connection,
    ref_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    # thumbnail_path 는 새 값이 있을 때만 갱신(COALESCE) — 영상 포스터 보존(update_asset_cache 와 동일).
    conn.execute(
        "UPDATE reference SET file_path=?, thumbnail_path=COALESCE(?, thumbnail_path), "
        "source_url=COALESCE(source_url, ?) WHERE id=?",
        (file_path, thumbnail_path, source_url, ref_id),
    )


def update_reference_cache(
    ref_id: str, file_path: str, thumbnail_path: Optional[str], source_url: Optional[str]
) -> None:
    """reference 를 로컬 캐시 경로로 전환하고 원본 URL 을 source_url 에 보존."""
    batch_conn = _media_cache_batch_conn.get()
    if batch_conn is not None:
        _update_reference_cache(batch_conn, ref_id, file_path, thumbnail_path, source_url)
        return
    with get_connection() as conn:
        _update_reference_cache(conn, ref_id, file_path, thumbnail_path, source_url)


def apply_generation_media_cache_updates(
    updates: Sequence[MediaCacheUpdate],
    *,
    asset_updater: Optional[MediaCacheUpdater] = None,
    reference_updater: Optional[MediaCacheUpdater] = None,
) -> None:
    """성공한 미디어 경로 전부를 한 ``BEGIN IMMEDIATE`` 트랜잭션으로 반영한다.

    ★transaction-root 전용(바깥 트랜잭션 안 호출 금지). 배치 문맥을 단건 공개 함수에
    전달해 기존 호출 계약은 유지하면서도 행마다 ``get_connection`` 을 중첩하지 않는다.
    """
    if not updates:
        return
    apply_asset = asset_updater or update_asset_cache
    apply_reference = reference_updater or update_reference_cache
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        token = _media_cache_batch_conn.set(conn)
        try:
            for kind, media_id, file_path, thumbnail_path, source_url in updates:
                if kind == "asset":
                    apply_asset(media_id, file_path, thumbnail_path, source_url)
                elif kind == "ref":
                    apply_reference(media_id, file_path, thumbnail_path, source_url)
                else:
                    raise ValueError(f"지원하지 않는 미디어 캐시 종류: {kind}")
            conn.execute("COMMIT")
        except Exception:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            _media_cache_batch_conn.reset(token)


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
            "UPDATE gen_request SET status=?, error=?, terminal_at=datetime('now'), "
            "lease_owner=NULL, lease_expires_at=NULL, updated_at=datetime('now') "
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
            (status, stored_error(status, error), gen_id),
        )
    return True


# '확인중' 마커 — 모호한 결말(타임아웃/파싱실패)에서 job_id 만 확보했을 때 generation.error 에 담는다.
#  status 는 running 유지(새 enum 안 만듦 — fail_orphaned_jobs 등 상태판정과 충돌 방지). 프론트는 이
#  문구로 '확인중' 라벨을 띄우고, 재조정이 done/failed 로 확정하면 error 를 지우거나 실제 사유로 덮는다.
VERIFYING_NOTE = "확인중 — 실제 상태 재확인 대기"
RECOVERY_REQUIRED_NOTE = (
    "복구 확인 필요 — 외부 제출 여부가 불명확하여 자동 재생성을 차단했습니다"
)


def apply_local_anchor(gen_id: str, rid: str, job_id: str, *, verifying: bool = True) -> bool:
    """job_id 앵커: 요청은 tracking/verifying으로 옮기고 generation은 running으로 유지한다.

    verifying=True(모호한 결말·재시작 복구): generation.error 에 '확인중' 문구 → UI '확인중' 표시.
    verifying=False(create-first 정상 흐름): 제출 직후 곧바로 앵커 — error=NULL 로 둬 UI 는 '생성중'으로
      자연스럽게 표시하고, wait 이 완료를 확정할 때까지 유지한다.

    같은 job_id 재전송은 멱등이며, terminal 완료/취소는 절대 되돌리지 않는다."""
    note = VERIFYING_NOTE if verifying else None
    phase = "verifying" if verifying else "tracking"
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute(
            "SELECT r.status, g.job_id FROM gen_request r JOIN generation g ON g.id=r.gen_id "
            "WHERE r.id=? AND r.gen_id=?",
            (rid, gen_id),
        ).fetchone()
        if not current or current["status"] in ("done", "canceled"):
            conn.execute("ROLLBACK")
            return False
        if current["status"] == "failed" and current["job_id"] not in (None, "", job_id):
            conn.execute("ROLLBACK")
            return False
        cur = conn.execute(
            "UPDATE gen_request SET status=?, error=?, check_failures=0, "
            "next_check_at=datetime('now'), lease_expires_at=datetime('now','+5 minutes'), "
            "updated_at=datetime('now') WHERE id=?",
            (phase, note, rid),
        )
        if cur.rowcount == 0:
            conn.execute("ROLLBACK")
            return False
        # 레이스 병합: 동기화가 같은 잡을 synced 로 먼저 넣었으면 그 중복본 제거(fulfill 과 동일 패턴).
        dup = conn.execute(
            "SELECT id FROM generation WHERE job_id=? AND id<>? AND origin='synced'",
            (job_id, gen_id),
        ).fetchone()
        if dup:
            _delete_generation(conn, dup["id"])
        # generation: running + job_id. done 만 보호하고 failed 는 되살린다(부팅정리·stale 회수 복구).
        conn.execute(
            "UPDATE generation SET job_id=?, status='running', error=? WHERE id=? AND status <> 'done'",
            (job_id, note, gen_id),
        )
    return True


def apply_local_failure(
    gen_id: str,
    rid: str,
    reason: str,
    *,
    job_id: Optional[str] = None,
    status: str = "failed",
) -> bool:
    """gen-request fail 을 원자·CAS 로 적용 — 요청표시와 generation 상태를 한 트랜잭션에.
    요청이 이미 종결(done/failed)이면 ROLLBACK·False(완료를 실패로 뒤집지 않음 — fulfill 과 대칭).
    예전엔 set_status + mark_request 2개 분리 커밋이라 그 사이 fulfill 이 끼면 split 상태가 났다.

    ★job_id 앵커 + 유령 정리: 실패에 job_id 가 있으면(에이전트가 넘기거나 사유 문자열에서 파싱) 그 값을
    원래 placeholder 에 박는다 → 이후 generate list ingest 가 이 행을 UPDATE(멱등)하고 새 synced 행을
    INSERT 하지 않는다. 이미 레이스로 생긴 같은 job_id 의 origin='synced' 중복 행은 여기서 제거한다.
    (NSFW 처럼 결과 URL 이 없는 실패는 URL 매칭이 불가능해 예전엔 유령 카드가 하나 더 생겼다.)"""
    if status in ACTIVE_STATUSES:
        status = "failed"  # 방어 — 실패 경로에 진행/성공 상태가 들어오면 failed 로 강등
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE gen_request SET status='failed', error=?, terminal_at=datetime('now'), "
            "lease_owner=NULL, lease_expires_at=NULL, updated_at=datetime('now') "
            "WHERE id=? AND status NOT IN ('done','failed')",
            (reason, rid),
        )
        if cur.rowcount == 0:
            conn.execute("ROLLBACK")
            return False
        if job_id:
            # 같은 job_id 의 동기화 유령 행 제거(원래 placeholder gen_id 는 보존).
            for dup in conn.execute(
                "SELECT id FROM generation WHERE job_id=? AND id<>? AND origin='synced'",
                (job_id, gen_id),
            ).fetchall():
                _delete_generation(conn, dup["id"])
            conn.execute(
                "UPDATE generation SET job_id=COALESCE(job_id, ?), status=?, error=? WHERE id=?",
                (job_id, status, stored_error(status, reason), gen_id),
            )
        else:
            conn.execute(
                "UPDATE generation SET status=?, error=? WHERE id=?",
                (status, stored_error(status, reason), gen_id),
            )
    return True


def set_color(gen_id: str, color: Optional[str]) -> None:
    set_generation_colors_batch([(gen_id, color)])


def set_generation_colors_batch(items: list[tuple[str, Optional[str]]]) -> int:
    """여러 생성물 색상을 한 트랜잭션으로 저장한다. 같은 id는 마지막 값이 이긴다."""
    final_by_id: dict[str, Optional[str]] = {}
    for gen_id, color in items or []:
        if gen_id:
            final_by_id[gen_id] = color
    if not final_by_id:
        return 0

    def apply(conn: sqlite3.Connection) -> None:
        conn.executemany(
            "UPDATE generation SET color=? WHERE id=?",
            [(color, gen_id) for gen_id, color in final_by_id.items()],
        )

    batch_conn = _current_personal_meta_batch_connection()
    if batch_conn is not None:
        apply(batch_conn)
    else:
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            apply(conn)
    return len(final_by_id)


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
    저수준 단건 함수이며 공유 불변식은 보장하지 않는다. 서버 본체의 최종 지정은
    ``finalize_generation_with_share`` transaction-root를 사용해야 한다."""
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


def delete_generation(gen_id: str) -> bool:
    """사용자 삭제 = **휴지통 DB 로 이동**(메인에서 제거). 힉스필드 원본엔 영향 없음.
    검색·복원·영구삭제는 휴지통 창(repo.trash)에서. 메인 DB 는 항상 가볍게 유지된다.
    ⚠️ 시스템 정리(sync 중복 등)는 _delete_generation(물리 삭제)을 직접 쓴다(휴지통 안 거침)."""
    from . import trash
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


def get_generation_identities_batch(
    gen_ids: list[str],
) -> dict[str, tuple[Optional[str], Optional[str]]]:
    """여러 생성물의 ``id -> (creator_uid, job_id)``를 변수 상한 아래에서 일괄 조회한다."""
    ids = list(dict.fromkeys(gen_id for gen_id in (gen_ids or []) if gen_id))
    if not ids:
        return {}
    out: dict[str, tuple[Optional[str], Optional[str]]] = {}
    with get_connection() as conn:
        for offset in range(0, len(ids), 900):
            batch = ids[offset:offset + 900]
            placeholders = ",".join("?" * len(batch))
            rows = conn.execute(
                f"SELECT id, creator_uid, job_id FROM generation WHERE id IN ({placeholders})",
                batch,
            ).fetchall()
            out.update(
                {row["id"]: (row["creator_uid"], row["job_id"]) for row in rows}
            )
    return out


def set_hf_missing_batch(items: list[tuple[str, bool]]) -> int:
    """여러 생성물의 HF 원본 누락 표시를 한 트랜잭션으로 저장한다. 같은 id는 마지막 값이 이긴다."""
    final_by_id: dict[str, bool] = {}
    for gen_id, missing in items or []:
        if gen_id:
            final_by_id[gen_id] = bool(missing)
    if not final_by_id:
        return 0
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "UPDATE generation SET hf_missing=? WHERE id=?",
            [(1 if missing else 0, gen_id) for gen_id, missing in final_by_id.items()],
        )
    return len(final_by_id)


def reconcile_duplicates() -> int:
    """create/sync 레이스로 생긴 중복(같은 결과 URL 을 가진 로컬+동기화 행) 정리.
    로컬(id<>job_id, 사용자 메타 보존)을 남기고 동기화본의 권위 job_id 를 로컬에 보장한
    뒤 동기화 중복본을 삭제. 그룹별 BEGIN IMMEDIATE 안에서 재검증(R6 2-H) — 종전
    autocommit 다문장은 중간 실패·동시 sync 에서 반쪽 병합이 가능했고,
    synced[0].job_id 임의 선택이 비정형 그룹에서 잘못된 anchor 를 쓸 수 있었다.
    ★transaction-root 전용(중첩 호출 금지)."""
    merged = 0
    with get_connection() as conn:
        url_keys = [
            r["url_key"]
            for r in conn.execute(
                "SELECT COALESCE(a.source_url, a.file_path) AS url_key "
                "FROM generation g JOIN asset a ON a.generation_id=g.id "
                "WHERE COALESCE(a.source_url, a.file_path) LIKE 'http%' "
                "GROUP BY COALESCE(a.source_url, a.file_path) HAVING COUNT(DISTINCT g.id) > 1"
            ).fetchall()
        ]
        for url_key in url_keys:
            conn.execute("BEGIN IMMEDIATE")
            try:
                merged += _reconcile_duplicate_group_locked(conn, url_key)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
    return merged


def _reconcile_duplicate_group_locked(conn, url_key: str) -> int:
    """한 URL 그룹을 잠금 안에서 재검증 후 병합. 비정형이면 0(전부 skip — 코덱스 확정 조건)."""
    rows = conn.execute(
        "SELECT DISTINCT g.id, g.job_id, g.origin FROM generation g "
        "JOIN asset a ON a.generation_id=g.id "
        "WHERE COALESCE(a.source_url, a.file_path)=?",
        (url_key,),
    ).fetchall()
    if len(rows) < 2:
        return 0  # 재검증 — 그 사이 중복이 해소됨
    # 동기화본 vs 로컬: id==job_id 좌표가 아니라 명시 마커(origin)로 판별(0a). NULL=레거시→local.
    synced = [r for r in rows if (r["origin"] or "local") == "synced"]
    local = [r for r in rows if (r["origin"] or "local") != "synced"]
    if len(local) != 1 or not synced:
        return 0  # 예상 모양(로컬 1 + 동기화 N) 아님
    anchors = {r["job_id"] for r in synced if r["job_id"]}
    if len(anchors) != 1:
        return 0  # 권위 anchor 가 하나로 수렴하지 않음(임의 선택 금지)
    anchor = next(iter(anchors))
    keep = local[0]
    if keep["job_id"] and keep["job_id"] != anchor:
        return 0  # 로컬이 이미 다른 잡에 앵커됨 — 덮어쓰지 않는다
    synced_ids = [r["id"] for r in synced]
    ph = ",".join("?" * len(synced_ids))
    synced_assets = {
        row["url"]
        for row in conn.execute(
            f"SELECT DISTINCT COALESCE(source_url, file_path) AS url FROM asset "
            f"WHERE generation_id IN ({ph}) "
            f"AND COALESCE(source_url, file_path) LIKE 'http%'",
            synced_ids,
        )
    }
    local_assets = {
        row["url"]
        for row in conn.execute(
            "SELECT DISTINCT COALESCE(source_url, file_path) AS url FROM asset "
            "WHERE generation_id=? AND COALESCE(source_url, file_path) LIKE 'http%'",
            (keep["id"],),
        )
    }
    if synced_assets - local_assets:
        return 0  # 삭제될 동기화본만 가진 원격 asset 존재 — 지우면 유실
    conn.execute("UPDATE generation SET job_id=? WHERE id=?", (anchor, keep["id"]))
    merged = 0
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
    # 이동 직전 잠금 안 재검증 경로(R6 2-0, 코덱스 승격) — 목록을 읽은 뒤 done 으로
    # 수렴한 완료본이 휴지통에 들어가던 TOCTOU 를 막는다.
    return sum(1 for gid in ids if trash.move_to_trash_if_failed(gid, account_uid))


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
    source_gen_id: str, worker_id: str, creator_uid: Optional[str] = None,
    workspace: Optional[dict[str, Any]] = None,
    generation_id: Optional[str] = None,
) -> str:
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + history 기록.

    DESIGN.md §3-6/7, CLAUDE.md 원칙 3·4. 새 gen_id 반환.
    creator_uid: 로그인 계정 신원(있으면 그 계정 작업으로 귀속). 없으면 제공자 my_uid 폴백.
    """
    # 내 신원 해석은 트랜잭션 전에 — identity.get_my_uid()가 내부에서 커넥션을 열 수 있어
    # BEGIN IMMEDIATE 안에서 부르면 중첩/별도 커넥션 문제가 된다.
    my_uid = creator_uid or identity.get_my_uid()
    workspace_scope, workspace_id, workspace_name = workspace_columns(workspace)
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

            child_id = generation_id or new_id()
            conn.execute(
                "INSERT INTO generation"
                "(id, worker_id, prompt, display_prompt, model, params, color, status, sort_ts, "
                "project_id, folder_path, creator_uid, origin, workspace_scope, workspace_id, workspace_name) "
                "VALUES(?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?, 'local', ?, ?, ?)",  # origin='local' — 가져오기는 내 새 행
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
                    workspace_scope,
                    workspace_id,
                    workspace_name,
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


# id 해석(finalize_id_map/resolve_local_id/resolve_and_get/personal_meta_by_anchor)은 id_resolve.py 로,
# 가계 조회(get_history/get_history_graph)는 history.py 로 분리.




