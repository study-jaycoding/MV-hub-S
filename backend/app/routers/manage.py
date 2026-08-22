"""PM 대시보드(매니징먼트) 라우터 — 분리형 사이드카 모듈.

설계: PM_DASHBOARD_DESIGN.md. 요청 모델도 여기 인라인으로 둔다(공용 models.py 무수정 → 격리).
★main.py 는 CONTENT_HUB_MANAGE=1 일 때만 이 라우터를 등록한다 → 기본 off 면 엔드포인트
자체가 없어 운영 동작에 영향 0(올려도 꺼진 채, 플래그만 켜면 활성).
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
import weakref
from pathlib import Path
from typing import Literal, NoReturn, Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from . import _proxy
from .. import rbac, repo
from ..config import AUTH_ENABLED, MEDIA_DIR
from ..deps import (
    account_actor_uid,
    account_global_roles,
    account_scope_uid,
    actor_id,
    batch_view_member_projects,
    can_view_generation_with_member_projects,
    current_account,
    project_roles_of,
    require_agent_account,
    require_global_cap,
    require_project_role,
)
from ..repo import manage as repo_manage
from ..repo import manage_tasks as repo_manage_tasks
from ..services import cli_bridge, file_stamp, final_export, media_cache, project_folders
from ..services.event_journal import journal_audit_event
from ..services.telemetry_drain import drain_isolated_telemetry
from ..services.net_guard import BlockedURLError, assert_public_http_url, guarded_opener
from ..services.path_safety import safe_join
from ..services.operational_logging import log_event

router = APIRouter(prefix="/api/manage", tags=["manage"])
_manage_log = logging.getLogger("mvhub.manage")


_PROJECT_READ_ROLES = (rbac.PROJECT_MANAGER, rbac.SUPERVISOR, rbac.CREATOR)
_TASK_RESPONSE_TTL = max(
    0.0, float(os.environ.get("CONTENT_HUB_TASK_READ_CACHE_TTL", "0.75"))
)
_TASK_RESPONSE_GUARD = threading.Lock()
_TASK_RESPONSE_CACHE: dict[tuple, tuple[float, tuple, bytes]] = {}
_TASK_RESPONSE_FLIGHTS: weakref.WeakValueDictionary[tuple, threading.Lock] = (
    weakref.WeakValueDictionary()
)


def _task_response_lock(key: tuple) -> threading.Lock:
    with _TASK_RESPONSE_GUARD:
        # 실행·대기 중인 인코딩은 같은 잠금을 공유하고, 마지막 사용 뒤에는 약한 참조가
        # 자동 정리한다. 잠금의 순간 상태만 보고 지우는 경쟁 조건을 만들지 않는다.
        return _TASK_RESPONSE_FLIGHTS.setdefault(key, threading.Lock())


def _accepts_gzip(value: str | None) -> bool:
    """``Accept-Encoding``에서 gzip 허용 여부를 보수적으로 판정한다."""
    explicit: float | None = None
    wildcard: float | None = None
    for part in str(value or "").split(","):
        fields = [field.strip() for field in part.split(";")]
        token = fields[0].lower()
        if not token:
            continue
        quality = 1.0
        for parameter in fields[1:]:
            name, separator, raw_quality = parameter.partition("=")
            if separator and name.strip().lower() == "q":
                try:
                    quality = max(0.0, min(1.0, float(raw_quality.strip())))
                except ValueError:
                    quality = 0.0
        if token == "gzip":
            explicit = quality
        elif token == "*":
            wildcard = quality
    quality = explicit if explicit is not None else wildcard
    return quality is not None and quality > 0


def _task_response_etag(key: tuple, stamp: tuple | None) -> str | None:
    if stamp is None:
        return None
    digest = hashlib.sha256(repr((key, stamp)).encode("utf-8")).hexdigest()
    return f'"{digest}"'


def _etag_matches(value: str | None, etag: str | None) -> bool:
    if not value or not etag:
        return False

    def weak_value(token: str) -> str:
        token = token.strip()
        return token[2:].strip() if token.lower().startswith("w/") else token

    expected = weak_value(etag)
    return any(
        token.strip() == "*" or weak_value(token) == expected
        for token in str(value).split(",")
    )


def _task_response_headers(*, gzip_encoded: bool, etag: str | None) -> dict[str, str]:
    headers = {
        # 브라우저 개인 캐시에만 저장하고 매번 ETag를 확인한다. 변경 신호 직후에도 오래된
        # 본문을 임의로 쓰지 않으면서, 불변인 대형 작업표를 다시 전송·파싱하지 않는다.
        "Cache-Control": "private, no-cache",
        "Vary": "Accept-Encoding",
    }
    if gzip_encoded:
        headers["Content-Encoding"] = "gzip"
    if etag:
        headers["ETag"] = etag
    return headers


def _encoded_task_response(
    encoded: bytes, *, gzip_encoded: bool, etag: str | None
) -> Response:
    headers = _task_response_headers(gzip_encoded=gzip_encoded, etag=etag)
    return Response(content=encoded, media_type="application/json", headers=headers)


def _task_json_response(
    key: tuple,
    payload: dict,
    *,
    expected_stamp: tuple | None,
    gzip_encoded: bool = False,
    etag: str | None = None,
) -> Response:
    """동일 권한 범위의 최종 JSON 인코딩도 동시 요청끼리 한 번만 수행한다.

    ``expected_stamp``는 작업 조회를 시작하기 직전의 DB 표식이다. 조회 뒤 현재 표식과 다르면
    결과 자체는 해당 요청의 일관된 스냅샷으로 반환하되 캐시에는 넣지 않는다. 그렇지 않으면
    조회가 끝난 직후 쓰기가 완료된 경우 이전 payload를 새 DB 표식으로 잘못 저장할 수 있다.
    """
    current_stamp = repo_manage_tasks._task_cache_stamp()
    stamp = expected_stamp if expected_stamp == current_stamp else None
    now = time.monotonic()
    if stamp is not None and _TASK_RESPONSE_TTL > 0:
        with _TASK_RESPONSE_GUARD:
            cached = _TASK_RESPONSE_CACHE.get(key)
            if cached and cached[0] >= now and cached[1] == stamp:
                return _encoded_task_response(
                    cached[2], gzip_encoded=gzip_encoded, etag=etag
                )
            if cached:
                _TASK_RESPONSE_CACHE.pop(key, None)

    lock = _task_response_lock(key)
    with lock:
        current_stamp = repo_manage_tasks._task_cache_stamp()
        stamp = expected_stamp if expected_stamp == current_stamp else None
        now = time.monotonic()
        if stamp is not None and _TASK_RESPONSE_TTL > 0:
            with _TASK_RESPONSE_GUARD:
                cached = _TASK_RESPONSE_CACHE.get(key)
                if cached and cached[0] >= now and cached[1] == stamp:
                    return _encoded_task_response(
                        cached[2], gzip_encoded=gzip_encoded, etag=etag
                    )
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if gzip_encoded:
            # 대형 작업 목록은 짧은 TTL 동안 같은 결과를 여러 사용자가 반복해서 읽는다.
            # 압축 결과 자체를 캐시해 요청마다 JSON 인코딩·gzip CPU를 다시 쓰지 않는다.
            encoded = gzip.compress(encoded, compresslevel=1, mtime=0)
        if (
            stamp is not None
            and _TASK_RESPONSE_TTL > 0
            and repo_manage_tasks._task_cache_stamp() == stamp
        ):
            with _TASK_RESPONSE_GUARD:
                _TASK_RESPONSE_CACHE[key] = (
                    time.monotonic() + _TASK_RESPONSE_TTL,
                    stamp,
                    encoded,
                )
                if len(_TASK_RESPONSE_CACHE) > 128:
                    oldest = min(
                        _TASK_RESPONSE_CACHE,
                        key=lambda item: _TASK_RESPONSE_CACHE[item][0],
                    )
                    if oldest != key:
                        _TASK_RESPONSE_CACHE.pop(oldest, None)
        return _encoded_task_response(
            encoded, gzip_encoded=gzip_encoded, etag=etag
        )


def _require_manage_read(request: Request) -> None:
    """전사 PM 집계 열람. admin/PM/PD 같은 read_all 보유자만."""
    require_global_cap(request, "read_all")


def _refresh_isolated_telemetry() -> None:
    """격리 스냅샷의 과거 미전송 outbox를 대시보드 조회 직전에 복구한다."""
    try:
        drain_isolated_telemetry()
    except Exception:  # noqa: BLE001 - 복구 실패가 기존 통계 조회까지 막지 않게
        pass


def _require_workspace_read(request: Request, workspace_id: Optional[str]) -> None:
    """선택한 워크스페이스 자체의 열람 권한을 먼저 확인한다.

    프로젝트가 다른 공간으로 이동한 뒤에도 과거 작업은 남으므로 프로젝트의 *현재*
    workspace_id만으로는 멤버십을 검사할 수 없다. 전사 read_all 보유자는 예외다.
    """
    workspace_id = str(workspace_id or "").strip() or None
    if not workspace_id or not AUTH_ENABLED:
        return
    if rbac.has_global_cap(account_global_roles(request), "read_all"):
        return
    account = current_account(request)
    if not account:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    try:
        repo.resolve_workspace_id(workspace_id, account_email=account.get("email"))
    except repo.WorkspaceAssignmentError as exc:
        # 접근할 수 없는 UUID와 존재하지 않는 UUID를 같은 404로 다뤄 정보 노출을 막는다.
        raise HTTPException(status_code=404, detail="접근 가능한 워크스페이스가 아닙니다") from exc


def _require_project_read(
    request: Request,
    pid: str,
    workspace_id: Optional[str] = None,
    *,
    allow_historical: bool = False,
    workspace_checked: bool = False,
) -> None:
    if not workspace_checked:
        _require_workspace_read(request, workspace_id)
    project = repo.get_project(pid)
    if not project:
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    if workspace_id and not allow_historical and not (
        project.get("workspace_scope") == "team"
        and project.get("workspace_id") == workspace_id
    ):
        # 다른 워크스페이스 프로젝트의 존재 자체를 노출하지 않는다.
        raise HTTPException(status_code=404, detail="선택한 워크스페이스에 없는 프로젝트")
    require_project_role(request, pid, *_PROJECT_READ_ROLES, read_only=True)


def _require_project_manage(request: Request, pid: str) -> None:
    if not repo.get_project(pid):
        raise HTTPException(status_code=404, detail="없는 프로젝트")
    if not AUTH_ENABLED:
        return
    roles = account_global_roles(request)
    if (
        rbac.has_global_cap(roles, "system")
        or rbac.has_global_cap(roles, "create_project")
        or rbac.has_global_cap(roles, "grant_project_role")
    ):
        return
    project_roles = project_roles_of(request, pid)
    if rbac.has_project_cap(project_roles, "schedule") or rbac.has_project_cap(
        project_roles, "manage_members"
    ):
        return
    raise HTTPException(status_code=403, detail="프로젝트 관리 권한이 없습니다")


def _task_project_or_404(tid: str) -> str:
    pid = repo_manage.task_project_id(tid)
    if not pid:
        raise HTTPException(status_code=404, detail="없는 작업")
    return pid


def _require_task_current(tid: str) -> dict:
    """쓰기 전에 작업 스냅샷이 현재 프로젝트 위치와 같은지 강제한다."""
    context = repo_manage.task_context(tid)
    if not context:
        raise HTTPException(status_code=404, detail="없는 작업")
    if context.get("workspace_unresolved"):
        raise HTTPException(
            status_code=409,
            detail="작업의 워크스페이스 귀속을 확인해야 수정할 수 있습니다",
        )
    if not context.get("is_current"):
        raise HTTPException(
            status_code=409,
            detail="과거 워크스페이스 작업은 읽기 전용입니다",
        )
    return context


def _require_task_manage_current(tid: str, request: Request) -> dict:
    """작업 상태를 노출하기 전에 프로젝트 관리 권한부터 확인한다.

    과거/귀속 미확정 작업은 409로 구분되므로 권한 검사보다 먼저 확인하면, 작업 ID를
    아는 비멤버가 그 상태를 추측할 수 있다. 프로젝트를 찾고 manage 권한을 통과한 뒤에만
    현재성 검사를 수행한다. 실제 쓰기 함수의 트랜잭션 재검사는 별도로 계속 적용된다.
    """
    project_id = _task_project_or_404(tid)
    _require_project_manage(request, project_id)
    return _require_task_current(tid)


def _task_write_conflict(exc: repo_manage.TaskWorkspaceConflictError) -> NoReturn:
    """라우터 검사 뒤 발생한 프로젝트 이동도 사용자에게 읽기 전용 충돌로 알린다."""
    raise HTTPException(status_code=409, detail=str(exc)) from exc


def _task_write_missing(exc: repo_manage.TaskMissingError) -> NoReturn:
    """라우터 검사 뒤 삭제된 작업을 거짓 성공으로 응답하지 않는다."""
    raise HTTPException(status_code=404, detail=str(exc)) from exc


def _visible_tasks(request: Request, tasks: list[dict]) -> list[dict]:
    """귀속 미확정 행은 전사 관리 화면에서만 노출한다.

    미상 작업의 과거 수동 링크에는 여러 워크스페이스 생성물이 섞였을 수 있어 일반 프로젝트
    멤버에게 보여주면 다른 공간의 썸네일/생성자 정보가 새어 나갈 수 있다.
    """
    if not AUTH_ENABLED or rbac.has_global_cap(account_global_roles(request), "read_all"):
        return tasks
    return [task for task in tasks if not task.get("workspace_unresolved")]


# ── 팀 매니징 텔레메트리(manage-T2) — 요청 모델 인라인(models.py 무수정 → 격리) ──────
class TelemetryFactIn(BaseModel):
    """작업자 로컬 생성물 1건의 매니징 메타(미디어·프롬프트 없음). 로컬이 만들어 서버로 push.
    account_email·creator_uid 는 서버가 인증 세션값으로 강제/검증한다(payload 값 불신)."""

    local_gen_id: str
    job_id: Optional[str] = None
    creator_uid: Optional[str] = None  # 서버가 세션 uid 와 대조(다르면 스킵)
    creator_name: Optional[str] = None
    workspace_scope: str = Field(default="unknown", pattern="^(team|personal|unknown)$")
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    folder_path: Optional[str] = None
    model: Optional[str] = None
    output_type: Optional[str] = None
    status: Optional[str] = None
    real_credits: Optional[float] = None
    est_credits: Optional[float] = None
    credit_source: Optional[str] = None
    elapsed_seconds: Optional[float] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    sort_ts: Optional[float] = None
    is_final: bool = False
    is_shared: bool = False
    is_deleted: bool = False
    deleted_at: Optional[str] = None


class TelemetryPushIn(BaseModel):
    items: list[TelemetryFactIn] = Field(default_factory=list)


def _telemetry_activity_summary(
    items: list[dict], upserted: int, skipped: list[str]
) -> dict[str, int]:
    statuses = [str(item.get("status") or "").strip().lower() for item in items]
    return {
        "received_items": len(items),
        "upserted_items": int(upserted),
        "skipped_items": len(skipped),
        "active_items": sum(
            status in {
                "pending", "claimed", "submitting", "running", "tracking", "verifying",
                "blocked", "recovery_required",
            }
            for status in statuses
        ),
        "completed_items": sum(status in {"done", "completed", "success"} for status in statuses),
        "failed_items": sum(status in {"failed", "error"} for status in statuses),
    }


def _push_acc(request: Request) -> dict:
    """텔레메트리 push 신원. 공용 require_agent_account 로 단일화(신원 규칙 분산 방지)."""
    return require_agent_account(request)


@router.post("/telemetry/push")
def telemetry_push(body: TelemetryPushIn, request: Request):
    """작업자 로컬 → 팀 매니징 저장소(manage_hub.db) 메타 upsert. 순수 수신자(재프록시 안 함) —
    보낼 곳 결정은 클라이언트(로컬 드레이너)가 한다. 작성자=세션 신원으로 강제/검증."""
    acc = _push_acc(request)
    from ..manage_db import upsert_facts

    items = [it.model_dump() for it in body.items]
    n, skipped = upsert_facts(acc.get("email") or "local", acc.get("creator_uid"), items)
    if items:
        worker_name = str(acc.get("name") or "").strip() or "이름 미설정"
        log_event(
            _manage_log,
            "worker_telemetry_received",
            worker_name=worker_name,
            **_telemetry_activity_summary(items, n, skipped),
        )
    # skipped = 서버가 반영 안 한 항목(미링크 전체·남의 것). 클라가 이것만 재시도로 남기고 나머지는 정리.
    return {"upserted": n, "skipped": skipped}


@router.get("/team-overview")
def team_overview(
    request: Request,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None,
    model: Optional[str] = None,
):
    """팀 전체 집계(합계+작업자별+프로젝트별+매트릭스). 집계는 서버 manage_hub.db 에 있으므로
    로컬 허브는 서버로 위임(프록시), 서버 본체는 로컬 manage_hub.db 를 읽는다. 권한=read_all(매니저)."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/team-overview", request)
    _require_manage_read(request)
    _refresh_isolated_telemetry()
    from ..manage_db import team_overview as _ov

    return _ov(date_from, date_to, project_id, creator_uid, workspace_id, model)


@router.get("/workspaces")
def manage_workspaces(request: Request):
    """관리 대시보드에서 선택할 검증된 팀 워크스페이스 목록."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/workspaces", request)
    _require_manage_read(request)
    _refresh_isolated_telemetry()
    return {"workspaces": repo.list_workspace_options()}


@router.get("/team-timeseries")
def team_timeseries(
    request: Request,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None,
    model: Optional[str] = None,
    bucket: str = "day",
    time_from: Optional[str] = None,
    time_to: Optional[str] = None,
):
    """팀 전체 기간별 추이(시간/일/주/월 버킷). 프록시/권한 규칙은 team-overview 와 동일."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/team-timeseries", request)
    _require_manage_read(request)
    _refresh_isolated_telemetry()
    from ..manage_db import team_timeseries as _ts

    return {
        "buckets": _ts(
            date_from, date_to, project_id, creator_uid, workspace_id, model, bucket,
            time_from, time_to,
        )
    }


@router.get("/usage-export")
def usage_export(
    request: Request,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    project_id: Optional[str] = None,
    creator_uid: Optional[str] = None,
    workspace_id: Optional[str] = None,
    model: Optional[str] = None,
):
    """HF 보고서와 호환되는 날짜·사용자·모델 단위 사용량 행."""
    if _proxy.proxying():
        return _proxy.proxy_get("/api/manage/usage-export", request)
    _require_manage_read(request)
    _refresh_isolated_telemetry()
    from ..manage_db import team_usage_export as _export

    return {
        "rows": _export(
            date_from, date_to, project_id, creator_uid, workspace_id, model
        )
    }


# ── 서버 공유본 HF 삭제 검토(서버가 CLI 없이, 로컬이 검증 결과를 올린다) ──────────────
class HfCheckResult(BaseModel):
    gen_id: str
    job_id: str
    exists: bool  # 로컬 CLI 판정(True=존재, False=HF 삭제됨). None(확인불가)은 로컬이 안 보냄.


class HfMissingApplyIn(BaseModel):
    results: list[HfCheckResult] = Field(default_factory=list)


@router.get("/hf-missing-candidates")
def hf_missing_candidates(request: Request):
    """내 서버 공유본 중 job_id 있는 것(HF 삭제 검증 후보). 서버는 CLI 가 없으므로 목록만 주고,
    로컬 허브(원 작성자 CLI 보유)가 각 job_id 를 검증한다. 내 creator_uid 것만 반환(남의 잡 오판 방지).
    /api/manage/* 는 미들웨어가 로컬→서버로 프록시하므로, 이 핸들러는 서버에서 실행된다."""
    acc = _push_acc(request)
    uid = acc.get("creator_uid")
    if not uid:
        return {"candidates": []}
    return {
        "candidates": [
            {"gen_id": gid, "job_id": jid} for gid, jid in repo.gens_with_job_id(account_uid=uid)
        ]
    }


@router.post("/hf-missing-apply")
def hf_missing_apply(body: HfMissingApplyIn, request: Request):
    """로컬 CLI 검증 결과 반영 — exists=False(HF 삭제 확정)만 서버 휴지통으로. 작성자·job_id 를 서버가
    재검증해 남의 것/불일치는 건드리지 않는다. exists=True 면 흐림(hf_missing) 해제. 반환 {trashed}."""
    acc = _push_acc(request)
    my_uid = acc.get("creator_uid")
    if not my_uid:
        return {"trashed": 0}
    identities = repo.get_generation_identities_batch(
        [result.gen_id for result in body.results]
    )
    trashed = 0
    reappeared: list[tuple[str, bool]] = []
    for r in body.results:
        # ★재검증: 내 것이고 job_id 가 일치할 때만(로컬이 보낸 값을 그대로 믿지 않음).
        # get_generation 공개 dict 엔 job_id 가 없어 identity 를 직접 조회한다(코덱스).
        creator_uid, job_id = identities.get(r.gen_id, (None, None))
        if creator_uid != my_uid or (job_id or "") != r.job_id:
            continue
        if r.exists:
            reappeared.append((r.gen_id, False))  # 재등장 → 흐림 해제
        elif repo.delete_generation(r.gen_id):  # HF 삭제 확정 → 서버 휴지통(soft delete)
            trashed += 1
    repo.set_hf_missing_batch(reappeared)
    return {"trashed": trashed}


@router.get("/summary")
async def summary(request: Request, workspace_id: Optional[str] = None):
    """프로젝트별·작업자별 생성수·크레딧·시간 + 출력타입·영상길이·환불·워크스페이스 요약.
    출력타입 정확화를 위해 CLI model list 로 (job_set_type→type) 맵을 만들어 넘긴다 —
    CLI 없으면(공유 서버) 빈 맵 → asset.type 추측으로 폴백(graceful)."""
    _require_manage_read(request)
    type_map: dict = {}
    try:
        for m in await cli_bridge.list_models():
            jt, t = m.get("job_set_type"), m.get("type")
            if jt and t:
                type_map[jt] = t
    except Exception:  # noqa: BLE001 — 모델목록 실패해도 요약은 폴백으로 동작
        type_map = {}
    # async 라우트라 SQLite 집계를 이벤트 루프에서 직접 돌리면 busy 대기(최대 5초)가
    # 서버 전체 응답을 막는다 — 집계는 스레드로 격리한다.
    return await asyncio.to_thread(repo_manage.dashboard_summary, type_map, workspace_id)


@router.get("/project-summary")
def project_summary(request: Request, workspace_id: Optional[str] = None):
    """프로젝트 작업 현황용 요약.

    read_all 보유자는 전체 프로젝트, 일반 멤버는 project_member에 들어간 프로젝트만 반환한다.
    워크스페이스·작업자 전체 통계는 포함하지 않아 대시보드 전체 권한과 분리한다.
    """
    read_all = not AUTH_ENABLED or rbac.has_global_cap(
        account_global_roles(request), "read_all"
    )
    member_uid = None if read_all else (account_scope_uid(request) or "\x00")
    visible = repo.list_projects(
        include_archived=False, member_uid=member_uid, workspace_id=workspace_id
    )
    project_ids = [
        project.get("id")
        for project in visible.get("projects") or []
        if isinstance(project, dict) and project.get("id")
    ]
    if not read_all:
        readable_ids = set(
            repo.projects_where_role(member_uid, list(_PROJECT_READ_ROLES))
        )
        project_ids = [pid for pid in project_ids if pid in readable_ids]
    return repo_manage.project_dashboard_summary(project_ids, workspace_id)


# ── 프로젝트 일정/예산 ────────────────────────────────────────────────────────
class PlanningIn(BaseModel):
    status: Optional[str] = None        # active | done | hold
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    budget_credits: Optional[int] = None
    budget_period: Optional[Literal["day", "week", "month"]] = None
    archive_after_days: Optional[int] = Field(default=None, ge=1, le=3650)
    note: Optional[str] = None


class ProjectFolderIn(BaseModel):
    root_path: Optional[str] = None
    selected_path: Optional[str] = None


class ProjectFolderSelectionIn(BaseModel):
    selected_path: str = ""


@router.get("/project-folders")
def project_folder_links(request: Request):
    links = repo_manage.list_project_folders()  # 로컬 링크(selected_path·레거시 root)
    read_all = not AUTH_ENABLED or rbac.has_global_cap(account_global_roles(request), "read_all")
    if read_all:
        projects = repo.list_projects(include_archived=True).get("projects") or []
    else:
        uid = account_scope_uid(request)
        if not uid:
            return {"links": {}}
        projects = repo.list_projects(include_archived=True, member_uid=uid).get("projects") or []
    # 팀 공유 렌더 루트(project.render_root_path)를 병합 — 로컬 링크가 없어도 '연결됨'으로 노출해
    # 다른 PC(로컬 링크 없음)에서도 폴더가 보이게 한다. selected_path 는 로컬 것(개인) 유지.
    for p in projects:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        shared = (p.get("render_root_path") or "").strip()
        if pid and shared:
            cur = links.get(pid) or {
                "project_id": pid, "root_path": "", "selected_path": "", "updated_at": None,
            }
            links[pid] = {**cur, "root_path": shared}  # 공유 루트 우선
    if read_all:
        return {"links": links}
    visible_ids = {p.get("id") for p in projects if isinstance(p, dict)}
    return {"links": {pid: link for pid, link in links.items() if pid in visible_ids}}


@router.get("/project-folders/{pid}")
def get_project_folder(pid: str, request: Request):
    _require_project_read(request, pid)
    return project_folders.project_folder_state(pid)


@router.put("/project-folders/{pid}")
def put_project_folder(pid: str, body: ProjectFolderIn, request: Request):
    _require_project_manage(request, pid)
    # 렌더 루트 경로는 팀 공유(서버 프로젝트 정의). selected_path(내가 보는 하위폴더)는 개인 로컬.
    # ★루트가 '실제로 바뀔 때만' 서버에 저장한다 — 하위폴더만 클릭(selected 변경)해도 프론트가 같은
    # root_path 를 함께 보내는데, 매번 서버 PATCH 를 쏘면 (1) 불필요한 쓰기 (2) create_project 없는
    # 매니저가 폴더 탐색만 해도 403 이 난다. 값이 같으면 서버를 건드리지 않는다.
    current_root = project_folders.effective_root_path(pid)
    root_changed = False
    if body.root_path is not None:
        new_root = body.root_path.strip()
        root_changed = new_root != current_root
        if root_changed:  # 루트가 실제 변경됨
            # 위임 모드: 공유 서버에 먼저 저장(실패 시 예외 전파 → 로컬 미변경으로 불일치 방지) → 로컬 미러.
            if _proxy.proxying():
                _proxy.proxy_json(
                    "PATCH", f"/api/projects/{pid}", body={"render_root_path": new_root}
                )
            repo.set_render_root(pid, new_root)  # 로컬 미러(즉시 반영) / 서버 본체면 이게 진실
    # root_path 를 생략한 구형 호출도 기존 루트를 지우지 않도록 보존한다.
    root_for_local = body.root_path if body.root_path is not None else current_root
    repo_manage.set_project_folder(pid, root_for_local, body.selected_path)
    if root_changed:
        project_folders.invalidate_project_folder(pid)
    return project_folders.project_folder_state(pid, fresh=root_changed)


@router.patch("/project-folders/{pid}/selection")
def patch_project_folder_selection(pid: str, body: ProjectFolderSelectionIn, request: Request):
    """개인 선택 경로만 저장한다. 디스크 트리를 읽거나 큰 트리 JSON을 되돌려주지 않는다."""
    _require_project_read(request, pid)
    root = project_folders.effective_root_path(pid)
    meta = repo_manage.set_project_folder(pid, root, body.selected_path)
    return {**meta, "root_path": root}


@router.get("/planning/{pid}")
def get_planning(pid: str, request: Request):
    _require_project_read(request, pid)
    return repo_manage.get_planning(pid) or {}


@router.put("/planning/{pid}")
def put_planning(pid: str, body: PlanningIn, request: Request):
    _require_project_manage(request, pid)
    result = repo_manage.set_planning(pid, **body.model_dump())
    changed = body.model_dump(exclude_none=True)
    journal_audit_event(
        "project.planning_changed",
        actor_uid=actor_id(request),
        target_type="project_planning",
        target_id=pid,
        project_id=pid,
        fields=list(changed.keys()),
        details={
            "status": body.status,
            "budget_credits": body.budget_credits,
            "budget_period": body.budget_period,
            "start_date": body.start_date,
            "due_date": body.due_date,
            "archive_after_days": body.archive_after_days,
        },
    )
    return result


# ── 작업(Task) ────────────────────────────────────────────────────────────────
class TaskIn(BaseModel):
    project_id: str
    name: str
    status: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None  # 전역 태그명(Notion 시퀀스)
    description: Optional[str] = None


class TaskPatch(BaseModel):
    # 담당(assignee)은 여기서 다루지 않는다 — 대시보드의 /tasks/{tid}/assignees 로 배정한다.
    name: Optional[str] = None
    status: Optional[str] = None
    start_date: Optional[str] = None
    due_date: Optional[str] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    sequence: Optional[str] = None
    description: Optional[str] = None


class TaskLinkIn(BaseModel):
    gen_ids: list[str]


class TaskOrderItem(BaseModel):
    task_id: str
    sort_order: int


class TaskOrderBatchIn(BaseModel):
    # 신형 계약: 보드 전체 순서 스냅샷(ordered_task_ids — 위치가 곧 순서). delta(items)는
    # 대기 중 합침(latest-merge)과 조합 시 중간 드래그가 유실돼 전체 상태 전송으로 전환했다.
    # 구형 프론트 호환을 위해 items 도 계속 받는다(스냅샷이 있으면 우선).
    items: list[TaskOrderItem] = Field(default_factory=list)
    ordered_task_ids: Optional[list[str]] = None


class TaskIdsIn(BaseModel):
    task_ids: list[str] = Field(default_factory=list)


def _require_tasks_manage(
    task_ids: list[str], request: Request, *, reject_duplicates: bool = True, limit: int = 500
) -> list[str]:
    """배치 쓰기 전에 모든 작업 존재와 프로젝트별 manage 권한을 확인한다."""
    unique_ids = list(dict.fromkeys(task_ids))
    if reject_duplicates and len(unique_ids) != len(task_ids):
        raise HTTPException(status_code=400, detail="중복 작업 id가 있습니다")
    if len(unique_ids) > limit:
        raise HTTPException(status_code=400, detail=f"한 번에 최대 {limit}개 작업까지 변경할 수 있습니다")
    contexts = repo_manage.task_contexts(unique_ids)
    # 찾은 작업의 권한부터 확인한다. 아래 409 상태를 먼저 반환하면 비멤버가 과거/미확정
    # 여부를 구분할 수 있다. 모두 없는 입력은 확인할 프로젝트가 없으므로 그대로 404다.
    for project_id in dict.fromkeys(context["project_id"] for context in contexts.values()):
        _require_project_manage(request, project_id)
    missing = [task_id for task_id in unique_ids if task_id not in contexts]
    if missing:
        raise HTTPException(status_code=404, detail=f"없는 작업: {missing[0]}")
    unresolved = [task_id for task_id in unique_ids if contexts[task_id].get("workspace_unresolved")]
    if unresolved:
        raise HTTPException(
            status_code=409,
            detail=f"워크스페이스 귀속 확인이 필요한 작업: {unresolved[0]}",
        )
    historical = [task_id for task_id in unique_ids if not contexts[task_id].get("is_current")]
    if historical:
        raise HTTPException(
            status_code=409,
            detail=f"과거 워크스페이스의 읽기 전용 작업: {historical[0]}",
        )
    return unique_ids


@router.get("/task-projects")
def list_task_projects(
    request: Request,
    workspace_id: str,
    include_historical: bool = False,
):
    """작업 화면용 프로젝트 목록. 과거 모드에서는 다른 공간으로 이동한 프로젝트도 반환한다."""
    _require_workspace_read(request, workspace_id)
    projects = repo_manage.task_projects_for_workspace(
        workspace_id, include_historical=include_historical
    )
    allowed: list[dict] = []
    for project in projects:
        try:
            _require_project_read(
                request,
                project["id"],
                workspace_id,
                allow_historical=True,
                workspace_checked=True,
            )
            allowed.append(project)
        except HTTPException as exc:
            # 프로젝트 단위의 비가시성만 목록에서 제외한다. 로그인 만료나 서버 오류까지
            # 빈 목록으로 숨기면 사용자는 데이터가 사라진 것으로 오인하고 운영 로그도 원인을
            # 추적하기 어렵다. tasks-batch와 같은 경계를 유지한다.
            if exc.status_code not in (403, 404):
                raise
            continue
    return {"projects": allowed}


@router.get("/tasks")
def list_tasks(
    project_id: str,
    request: Request,
    workspace_id: Optional[str] = None,
    include_archived: bool = False,
):
    _require_project_read(
        request, project_id, workspace_id, allow_historical=include_archived
    )
    return _visible_tasks(
        request,
        repo_manage.list_tasks(
            project_id, include_archived=include_archived, workspace_id=workspace_id
        ),
    )


@router.get("/tasks-batch")
def list_tasks_batch(
    request: Request,
    project_id: list[str] = Query(default_factory=list),
    workspace_id: Optional[str] = None,
    include_archived: bool = False,
):
    """여러 프로젝트의 작업을 한 번에 반환 — WorkBoard 가 프로젝트 수만큼 GET /tasks 하던 fan-out 을
    1요청으로. ★GET(읽기)이라 mutation 알림을 유발하지 않는다(POST 였으면 폴링마다 라이브러리 reload).
    pid 별로 기존 read 게이트(_require_project_read)를 그대로 적용해 **접근 가능한 프로젝트만**
    {pid:[tasks]} 로 반환한다. 내부 DB 오류는 빈 목록으로 숨기지 않고 500으로 드러내 재시도와
    운영 로그 추적이 가능하게 한다."""
    unique_ids = list(dict.fromkeys(project_id))
    if len(unique_ids) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 프로젝트까지 조회할 수 있습니다")
    # 같은 workspace 멤버십을 프로젝트마다 반복 조회하지 않는다. 로그인 만료나 접근할 수 없는
    # workspace 오류도 빈 작업표로 삼키지 않고 여기서 한 번 정확히 반환한다.
    _require_workspace_read(request, workspace_id)
    allowed: list[str] = []
    for pid in unique_ids:
        try:
            _require_project_read(
                request,
                pid,
                workspace_id,
                allow_historical=include_archived,
                workspace_checked=True,
            )
        except HTTPException as exc:
            if exc.status_code not in (403, 404):
                raise
            continue
        allowed.append(pid)
    if not allowed:
        return {}
    # 이 표식을 결과 조립보다 먼저 잡아야 이전 결과를 쓰기 완료 뒤의 새 표식으로 캐시하지 않는다.
    response_stamp = repo_manage_tasks._task_cache_stamp()
    can_read_unresolved = not AUTH_ENABLED or rbac.has_global_cap(
        account_global_roles(request), "read_all"
    )
    gzip_encoded = _accepts_gzip(request.headers.get("accept-encoding"))
    response_key = (
        str(repo_manage_tasks.get_db_path()),
        tuple(allowed),
        bool(include_archived),
        str(workspace_id or ""),
        can_read_unresolved,
        gzip_encoded,
    )
    response_etag = _task_response_etag(response_key, response_stamp)
    if _etag_matches(request.headers.get("if-none-match"), response_etag):
        return Response(
            status_code=304,
            headers=_task_response_headers(
                gzip_encoded=False,
                etag=response_etag,
            ),
        )
    result = repo_manage.list_tasks_batch(
        allowed, include_archived=include_archived, workspace_id=workspace_id
    )
    visible = {
        project_id: _visible_tasks(request, tasks) for project_id, tasks in result.items()
    }
    return _task_json_response(
        response_key,
        visible,
        expected_stamp=response_stamp,
        gzip_encoded=gzip_encoded,
        etag=response_etag,
    )


@router.post("/tasks", status_code=201)
def create_task(body: TaskIn, request: Request):
    _require_project_manage(request, body.project_id)
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="빈 작업 이름")
    data = body.model_dump()
    data.pop("project_id")
    data.pop("name")
    try:
        return repo_manage.create_task(body.project_id, name, **data)
    except repo_manage.TaskProjectMissingError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/tasks/{tid}")
def patch_task(tid: str, body: TaskPatch, request: Request):
    pid = _task_project_or_404(tid)
    fields = body.model_dump(exclude_unset=True)
    # 배정된 작업자는 자기 배분 작업을 '진행'(상태·설명·메모)할 수 있다. 그 외 관리 필드는 PM 권한.
    actor = account_actor_uid(request) or actor_id(request)
    if fields and set(fields) <= {"status", "note", "description"} and repo_manage.is_assignee(tid, actor):
        _require_project_read(request, pid)
    else:
        _require_project_manage(request, pid)
    _require_task_current(tid)
    try:
        r = repo_manage.update_task(tid, fields)
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)
    if not r:
        raise HTTPException(status_code=404, detail="없는 작업(또는 변경 필드 없음)")
    return r


@router.delete("/tasks/{tid}")
def remove_task(tid: str, request: Request):
    _require_task_manage_current(tid, request)
    try:
        return {"ok": repo_manage.delete_task(tid)}
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)


@router.patch("/tasks-batch/order")
def update_task_order_batch(body: TaskOrderBatchIn, request: Request):
    if body.ordered_task_ids is not None:
        # 전체 스냅샷 모드 — 리스트 위치로 순번(i*10)을 서버가 한 트랜잭션에 부여한다.
        # 보드 전체가 오므로 상한은 delta(500)보다 넉넉히 2000(권한 조회는 단일 IN 쿼리).
        ids = _require_tasks_manage(body.ordered_task_ids, request, limit=2000)
        try:
            count = repo_manage.bulk_update_task_orders(
                [(task_id, index * 10) for index, task_id in enumerate(ids)]
            )
        except repo_manage.TaskMissingError as exc:
            _task_write_missing(exc)
        except repo_manage.TaskWorkspaceConflictError as exc:
            _task_write_conflict(exc)
        return {"ok": True, "count": count}
    task_ids = [item.task_id for item in body.items]
    _require_tasks_manage(task_ids, request)
    try:
        count = repo_manage.bulk_update_task_orders(
            [(item.task_id, item.sort_order) for item in body.items]
        )
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)
    return {"ok": True, "count": count}


@router.post("/tasks-batch/delete")
def delete_tasks_batch(body: TaskIdsIn, request: Request):
    task_ids = _require_tasks_manage(body.task_ids, request)
    try:
        count = repo_manage.bulk_delete_tasks(task_ids)
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)
    return {"ok": True, "count": count}


@router.post("/tasks/{tid}/generations")
def link_generations(tid: str, body: TaskLinkIn, request: Request):
    _require_task_manage_current(tid, request)
    if len(body.gen_ids) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 생성물까지 연결할 수 있습니다")
    # 종전과 같은 PK 전용 조회·입력 순서 판정을 유지하되, 항목별 단건 직렬화+멤버십
    # 재조회(N+1) 대신 배치 1회 조회 + 멤버십 1회 고정으로 바꾼다. 실패 계약 불변:
    # 숨김 생성물=404(존재 은닉), 부재·휴지통은 아래 연결 단계에서 종전대로 처리.
    gens = repo.get_generations_batch(body.gen_ids)
    member_projects = batch_view_member_projects(request, gens.values())
    for gid in body.gen_ids:
        gen = gens.get(gid)
        if gen and not can_view_generation_with_member_projects(request, gen, member_projects):
            raise HTTPException(status_code=404, detail="generation 없음")
    try:
        return {"linked": repo_manage.link_generations(tid, body.gen_ids)}
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/tasks/{tid}/assignees/{uid}")
def add_assignee(tid: str, uid: str, request: Request):
    """작업에 담당(배정) 추가 — PM 이 대시보드에서 작업자를 배정(=컷 분배). manage 권한."""
    _require_task_manage_current(tid, request)
    try:
        repo_manage.add_assignment(tid, uid, actor_id(request))
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)
    return {"ok": True}


@router.delete("/tasks/{tid}/assignees/{uid}")
def remove_assignee(tid: str, uid: str, request: Request):
    """작업 담당(배정)에서 특정 작업자 제거 — manage 권한."""
    _require_task_manage_current(tid, request)
    try:
        return {"removed": repo_manage.remove_assignment(tid, uid)}
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)


class BulkAssignItem(BaseModel):
    task_id: str
    assignee_uids: list[str] = Field(default_factory=list)


class BulkAssignIn(BaseModel):
    mode: str = "replace"  # replace | add | remove
    items: list[BulkAssignItem] = Field(default_factory=list)


@router.patch("/tasks/assignees/bulk")
def bulk_set_assignments(body: BulkAssignIn, request: Request):
    """여러 작업의 담당(배정)을 한 번에 설정 — 전부 PM(manage) 권한."""
    if body.mode not in ("replace", "add", "remove"):
        raise HTTPException(status_code=400, detail="mode 는 replace, add 또는 remove")
    # 상한 초과는 무음 절단([:500]) 대신 명시 거절 — 잘린 뒤쪽 작업의 배정이 조용히
    # 유실되는 것을 막는다. 프론트가 500 단위로 나눠 보낸다(batching.ts).
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="한 번에 최대 500개 작업까지 배정할 수 있습니다")
    items = [item.model_dump() for item in body.items]
    if not items:
        return {"ok": True, "count": 0}
    actor = actor_id(request)
    # 작업당 담당 상한(20명)은 무음 절단([:20]) 대신 명시 거절(R7 1-C) — 뒤쪽 담당자가
    # 조용히 유실된 채 {ok:true} 로 전체 성공처럼 보이던 것을 막는다(위 500 상한과 동일 정책).
    for it in items:
        assignees = [u for u in (it.get("assignee_uids") or [])]
        if len(assignees) > 20:
            raise HTTPException(
                status_code=400, detail="작업당 담당자는 최대 20명까지 지정할 수 있습니다"
            )
        it["assignee_uids"] = assignees
    # task→project도 한 번에 조회한다. 예전에는 저장만 배치고 여기서 작업 수만큼 DB를 다시 열었다.
    # 같은 task를 여러 줄로 보낸 기존 입력 순서 의미는 유지하므로 이 경로만 중복을 허용한다.
    task_ids = [it["task_id"] for it in items]
    _require_tasks_manage(task_ids, request, reject_duplicates=False)
    try:
        n = repo_manage.bulk_set_assignments(items, body.mode, actor)
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)
    return {"ok": True, "count": n}


@router.delete("/tasks/{tid}/generations/{gen_id}")
def unlink_generation(tid: str, gen_id: str, request: Request):
    """컷(생성물) 연결 해제 — 드래그로 뺀 컷 제거."""
    _require_task_manage_current(tid, request)
    try:
        return {"ok": repo_manage.unlink_generation(tid, gen_id)}
    except repo_manage.TaskMissingError as exc:
        _task_write_missing(exc)
    except repo_manage.TaskWorkspaceConflictError as exc:
        _task_write_conflict(exc)


# ── 완료본 렌더폴더 저장(Phase 3 + 위임 모드) ────────────────────────────────
# 역할 분리(코덱스 합의): 서버 = 저장 '대상 판정' 권위(팀원 최종본·folder_path·task done 은 서버
# DB 에만 있음) / 로컬 허브 = NAS 저장 권위(렌더 폴더는 이 PC 디스크). 위임 모드의 로컬 GET/POST
# 는 서버 targets 를 받아 로컬 디스크 판정(saved·render 연결)과 조합한다.


def _save_finals_targets_facts(project_id: str) -> list[dict]:
    """저장 대상 '사실'만 — render_path/saved 등 디스크 판정 절대 미포함(그건 저장하는 PC 의 몫).
    filename 은 원본 확장자가 필요해 여기(사실 보유측)서 계산한다."""
    out: list[dict] = []
    for f in final_export.finals_to_export(project_id):
        fp = f.get("folder_path")
        file_path = f.get("file_path")
        reason: Optional[str] = None
        filename = ""
        if not fp:
            reason = "폴더 경로 없음"
        elif not file_path:
            reason = "원본 파일 없음"
        else:
            filename = project_folders.export_filename(
                fp, f["gen_id"], file_path, f.get("media_type")
            )
        out.append(
            {
                "gen_id": f["gen_id"],
                "folder_path": fp,
                "media_type": f.get("media_type"),
                "filename": filename,
                "reason": reason,  # None=저장 가능(사실 측면), 값 있으면 불가 사유
            }
        )
    return out


@router.get("/save-finals/targets")
def save_finals_targets(project_id: str, request: Request):
    """위임 모드의 판정 권위 API — 로컬 허브가 프록시 미들웨어로 이 경로를 서버에 위임한다
    (_LOCAL_EXACT 는 /save-finals 본체만이라 하위 경로는 자동 프록시). 서버 DB 기준 사실만."""
    _require_project_read(request, project_id)
    return {"targets": _save_finals_targets_facts(project_id)}


@router.get("/save-finals/content/{gen_id}")
def save_finals_content(gen_id: str, request: Request):
    """저장 대상 1건의 원본 바이트 스트리밍(위임 다운로드용) — manage 권한 재검증 후
    '그 프로젝트의 저장 대상'인 생성물만. 서버 /media 파일 또는 원격(CDN) URL 만 중계하고
    임의 절대경로는 다루지 않는다(파일시스템 노출 금지)."""
    from fastapi.responses import FileResponse, StreamingResponse

    gen = repo.get_generation(gen_id)
    if not gen or not gen.get("project_id"):
        raise HTTPException(status_code=404, detail="없는 생성물(또는 프로젝트 미배정)")
    _require_project_manage(request, gen["project_id"])
    # 단건 판정 — 종전엔 content 요청마다 프로젝트 전수 판정(finals_to_export)을 다시
    # 계산했다(위임 저장 N건 × 전수 판정). 같은 정책 함수의 단건 경로로 대체(성능-08).
    fin = final_export.final_to_export(gen["project_id"], gen_id)
    if not fin:
        raise HTTPException(status_code=404, detail="저장 대상이 아닙니다")
    file_path = fin.get("file_path") or ""
    if file_path.startswith("/media/"):
        src = safe_join(MEDIA_DIR, file_path.removeprefix("/media/"))
        if src is None or not src.exists():
            raise HTTPException(status_code=404, detail="서버에 원본이 없습니다")
        return FileResponse(src)
    if file_path.startswith(("http://", "https://")):
        import urllib.error
        import urllib.request

        try:
            # 발행 번들의 file_path 는 외부 입력이다. 문자열이 http(s)라는 이유만으로 신뢰하면
            # 프로젝트 관리자가 이 중계 API를 통해 127.0.0.1·사설망·클라우드 메타데이터를 읽는
            # SSRF 경로가 된다. 공용 미디어 캐시와 같은 공개 IP+리다이렉트 차단 규칙을 적용한다.
            assert_public_http_url(file_path)
            req = urllib.request.Request(
                file_path, headers={"User-Agent": "content-hub/0.1"}
            )
            upstream = guarded_opener().open(req, timeout=60)
        except BlockedURLError as e:
            raise HTTPException(status_code=400, detail=f"허용되지 않는 원본 URL: {e}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise HTTPException(status_code=502, detail=f"원본(CDN) 조회 실패: {e}")

        def _iter():
            try:
                while True:
                    chunk = upstream.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                upstream.close()

        headers = {}
        cl = upstream.headers.get("Content-Length")
        if cl:
            headers["Content-Length"] = cl  # 로컬 허브가 크기 대조(불완전 다운로드 검출)에 쓴다
        media_type = upstream.headers.get("Content-Type") or "application/octet-stream"
        return StreamingResponse(_iter(), media_type=media_type, headers=headers)
    raise HTTPException(status_code=404, detail="원본 파일 없음")


def _save_finals_facts(project_id: str) -> tuple[list[dict], bool]:
    """저장 대상 사실 목록 — 위임 모드면 서버 targets(판정 권위), 아니면 로컬 DB.
    반환: (facts, server_outdated). 구서버(라우트 없음 404)는 0건으로 숨기지 않고 표식을 올린다."""
    if _proxy.proxying():
        try:
            r = _proxy.proxy_json(
                "GET", "/api/manage/save-finals/targets", params={"project_id": project_id}
            )
            return (r or {}).get("targets") or [], False
        except HTTPException as e:
            # 구서버 판별은 '라우트 없음'의 표준 본문("Not Found")만 — 프로젝트 404("없는 프로젝트"
            # 등 상세 사유)까지 구서버로 오인하면 진짜 오류가 "서버 업데이트 필요"로 가려진다(코덱스 P2).
            if e.status_code == 404 and str(e.detail).strip() == "Not Found":
                return [], True  # 구서버 — UI 가 "서버 업데이트 필요"로 표시(완료조건 ①)
            raise
    return _save_finals_targets_facts(project_id), False


@router.get("/save-finals")
def save_finals_status(project_id: str, request: Request):
    """저장 대상(최종본) 미리보기 + 저장 이력(대장). 읽기 전용 — 다운로드/복사 없음.
    targets: 사실(서버/로컬) + 이 PC 디스크 판정(saved·렌더 연결) 조합. history: 대장(파일 존재)."""
    _require_project_read(request, project_id)
    state = project_folders.render_root_state(project_id)
    render_path = state.get("render_path") or ""
    render = Path(render_path) if render_path else None
    facts, server_outdated = _save_finals_facts(project_id)
    targets: list[dict] = []
    for t in facts:
        reason = t.get("reason")
        filename = t.get("filename") or ""
        saved = False
        # 저장 불가 사유를 미리 알려 헛클릭 방지(POST 와 같은 판정 순서).
        if not reason:
            if render is None:
                reason = "렌더 폴더 미연결"
            else:
                dest = project_folders.safe_dest(render, t.get("folder_path") or "", filename)
                if dest is None:
                    reason = "경로 안전성 위반"
                else:
                    saved = bool(dest.exists())
        targets.append(
            {
                "gen_id": t["gen_id"],
                "folder_path": t.get("folder_path"),
                "filename": filename,
                "saved": saved,
                "reason": reason,  # None=저장 가능, 값 있으면 저장 불가 사유
            }
        )
    history = [
        {**e, "exists": Path(e["dest_path"]).exists()}
        for e in repo_manage.list_exports(project_id)
    ]
    return {
        "render_path": render_path,
        "error": state.get("error"),
        "server_outdated": server_outdated,
        "targets": targets,
        "history": history,
    }


@router.post("/save-finals")
async def save_finals(project_id: str, request: Request):
    """완료 작업의 최종본만 렌더 폴더 경로 구조 그대로 물리 저장(멱등).
    로컬 전용(_proxy 로컬 목록) — render_root 는 이 PC 의 디스크(Z:\\…).
    위임 모드: 대상은 서버 targets(판정 권위), 바이트는 content 스트림으로 받아 이 PC 가 저장."""
    _require_project_manage(request, project_id)
    state = project_folders.render_root_state(project_id)
    if state.get("error"):
        raise HTTPException(status_code=400, detail=state["error"])
    render_path = state.get("render_path")
    if not render_path:
        raise HTTPException(status_code=400, detail="렌더 폴더가 연결되지 않았습니다")
    render = Path(render_path)

    if _proxy.proxying():
        facts, server_outdated = _save_finals_facts(project_id)
        if server_outdated:
            raise HTTPException(
                status_code=400,
                detail="공유 서버 업데이트가 필요합니다(완료본 저장 API 없음) — 서버를 먼저 배포하세요",
            )
        saved, skipped = 0, 0
        errors: list[dict[str, str]] = []
        # 순차 처리 — NAS 대역폭·서버 부하를 한 줄로(동시 다운로드 폭주 방지).
        for t in facts:
            gen_id = t["gen_id"]
            try:
                if t.get("reason"):
                    errors.append({"gen_id": gen_id, "reason": t["reason"]})
                    continue
                dest = project_folders.safe_dest(
                    render, t.get("folder_path") or "", t.get("filename") or ""
                )
                if dest is None:
                    errors.append({"gen_id": gen_id, "reason": "경로 안전성 위반(트래버설)"})
                    continue
                if dest.exists():  # 멱등 — 이미 저장됨
                    repo_manage.record_export(gen_id, str(dest), project_id)
                    skipped += 1
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                # NAS '같은 폴더'에 .part 로 받고 원자 교체 — 로컬 경로와 동일 규율.
                tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
                try:
                    await asyncio.to_thread(
                        _proxy.stream_download,
                        f"/api/manage/save-finals/content/{gen_id}",
                        tmp,
                    )
                    await asyncio.to_thread(
                        file_stamp.stamp_file, tmp, file_stamp.tags_for_generation(gen_id), dest.suffix
                    )
                    os.replace(tmp, dest)
                except OSError:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise
                repo_manage.record_export(gen_id, str(dest), project_id)
                saved += 1
            except HTTPException as e:  # stream_download 의 상태별 사유를 그대로 노출
                errors.append({"gen_id": gen_id, "reason": str(e.detail)})
            except Exception as e:  # noqa: BLE001 — 파일 1건 실패 격리
                errors.append({"gen_id": gen_id, "reason": str(e)})
        return {"saved": saved, "skipped": skipped, "errors": errors}

    finals = final_export.finals_to_export(project_id)
    saved, skipped = 0, 0
    errors: list[dict[str, str]] = []
    for f in finals:
        gen_id = f["gen_id"]
        # 파일 1건 처리 전체를 격리 — 한 건 실패(경로/DB/OS)가 나머지 저장을 막지 않게(코덱스 #7).
        try:
            folder_path = f.get("folder_path")
            file_path = f.get("file_path")
            if not folder_path:
                errors.append({"gen_id": gen_id, "reason": "폴더 경로 없음(저장 위치 불명)"})
                continue
            if not file_path:
                errors.append({"gen_id": gen_id, "reason": "원본 파일 없음"})
                continue
            filename = project_folders.export_filename(folder_path, gen_id, file_path, f.get("media_type"))
            dest = project_folders.safe_dest(render, folder_path, filename)
            if dest is None:
                errors.append({"gen_id": gen_id, "reason": "경로 안전성 위반(트래버설)"})
                continue
            # 멱등: 목적지 파일이 이미 있으면 skip(사용자가 지웠으면 재복사 — 자기치유).
            if dest.exists():
                repo_manage.record_export(gen_id, str(dest), project_id)
                skipped += 1
                continue
            rel = await media_cache.cache_url(file_path)
            if not rel:
                errors.append({"gen_id": gen_id, "reason": "원본 다운로드 실패"})
                continue
            # 원본도 MEDIA_DIR 밖으로 나가지 못하게 검증(코덱스 #3 — /media/../.. 방어).
            src = safe_join(MEDIA_DIR, rel.removeprefix("/media/"))
            if src is None:
                errors.append({"gen_id": gen_id, "reason": "원본 경로 안전성 위반"})
                continue
            if not src.exists():
                errors.append({"gen_id": gen_id, "reason": "로컬 원본 없음"})
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            # 원자적 저장(코덱스 #2) — 임시 .part 로 복사 후 교체. 복사 중 크래시/드라이브 끊김이
            # 나도 불완전 파일이 목적지에 남아 영구 skip 되는 일이 없다.
            # 임시명에 uuid — 동시 실행/재실행 시 같은 .part 를 두 요청이 다투지 않게.
            # 대용량·NAS 복사는 to_thread 로 오프로딩해 이벤트 루프(백엔드 응답성)를 막지 않는다.
            tmp = dest.with_name(dest.name + f".{uuid.uuid4().hex}.part")
            try:
                await asyncio.to_thread(shutil.copy2, src, tmp)
                await asyncio.to_thread(
                    file_stamp.stamp_file, tmp, file_stamp.tags_for_generation(gen_id), dest.suffix
                )
                os.replace(tmp, dest)
            except OSError:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            repo_manage.record_export(gen_id, str(dest), project_id)
            saved += 1
        except Exception as e:  # noqa: BLE001 — 파일 1건 실패 격리(위 주석)
            errors.append({"gen_id": gen_id, "reason": str(e)})
    return {"saved": saved, "skipped": skipped, "errors": errors}


# ── 분석(시각화) ──────────────────────────────────────────────────────────────
@router.get("/timeseries")
def timeseries(
    request: Request,
    bucket: str = "day",
    project_id: str | None = None,
    creator_uid: str | None = None,
):
    """일/주별 생성수·크레딧 추이(추이 차트용). project_id/creator_uid 주면 그 범위만."""
    _require_manage_read(request)
    return repo_manage.timeseries(
        "week" if bucket == "week" else "day",
        project_id=project_id or None,
        creator_uid=creator_uid or None,
    )


@router.get("/matrix")
def matrix(request: Request):
    """작업자 × 프로젝트 매트릭스(건수·크레딧)."""
    _require_manage_read(request)
    return repo_manage.matrix()


@router.get("/breakdown")
def breakdown(request: Request, project_id: str):
    """프로젝트 세부 분석 — (folder_path × 작업자)별 생성/게시/완료/크레딧 플랫 행."""
    _require_manage_read(request)
    return repo_manage.breakdown(project_id)
