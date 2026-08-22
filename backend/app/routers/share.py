"""공유·가져오기·최종 선택 라우터.

단독·공유 서버 모드에서는 로컬 SQLite를 직접 변경하고, 작업자 프록시 모드에서는 공유 서버를
권위로 삼아 write-ahead 원장으로 로컬 표시를 수렴시킨다.
"""

from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from . import _proxy
from .. import active_account, rbac, repo
from ..config import DEFAULT_WORKER_ID
from ._telemetry import touch_generation_telemetry
from ..db import get_connection
from ..deps import (
    account_global_roles,
    actor_id,
    current_account,
    require_edit_generation,
    require_project_role,
    require_view_generation,
)
from ..models import GenerationOut, ImportIn, PublishIn
from ..services.async_tools import to_thread_non_abandon
from ..services.event_journal import journal_audit_event
from ..services.media_preservation import preserve_generation_now
from ..services.share_state_reconciler import kick_share_state_reconciler

router = APIRouter(prefix="/api", tags=["share"])

_FINAL_UNPUBLISH_DETAIL = (
    "최종(골드)으로 지정된 항목은 공유를 해제할 수 없습니다 (먼저 최종 해제)"
)


# 단일 정의로 통합(_telemetry.touch_generation_telemetry) — publish.py 와 복붙돼 있던 것.
_touch_telemetry = touch_generation_telemetry


@contextmanager
def _stable_proxy_identity_lock(requested_id: str):
    """잠금 전후 id 매핑이 같은 identity를 가리킬 때만 프록시 변경을 허용한다.

    로컬 행 물질화 등으로 기다리는 사이 server_id가 바뀌면 실제 대상 키를 잡지 않은 상태다.
    원장 prepare 전에 409로 닫아 다음 요청이 새 매핑으로 다시 잠그게 한다.
    """
    server_origin = _proxy.base_url()
    local_id, server_id = repo.finalize_id_map(requested_id)
    locked_key = repo.share_state_identity_key(server_origin, job_anchor=server_id)
    with repo.share_state_action_locks([locked_key]):
        local_id, server_id = repo.finalize_id_map(requested_id)
        actual_key = repo.share_state_identity_key(server_origin, job_anchor=server_id)
        if actual_key != locked_key:
            raise HTTPException(
                status_code=409,
                detail="generation 식별자가 갱신되었습니다. 요청을 다시 시도하세요",
            )
        yield local_id, server_id


def _local_id_from_out(out) -> str | None:
    """프록시 응답(out)의 job_id 앵커로 로컬 행 id 를 되찾는다. 팀 탭 카드는 서버 UUID(id≠job_id, Phase 0b)라
    finalize_id_map(gen_id) 이 로컬을 못 찾아 local_id=None 이 된다 → 서버가 돌려준 job_id 로 로컬 미러
    대상을 확정해, 팀 탭에서 공유해제/최종해도 내작업이 함께 갱신되게 한다."""
    if isinstance(out, dict) and out.get("job_id"):
        return repo.finalize_id_map(out["job_id"])[0]
    return None


def _ensure_not_final_before_unpublish(gen: dict[str, Any] | None) -> None:
    """로컬 미러가 최종이면 서버를 변경하기 전에 공유 해제를 차단한다.

    서버 404를 목표 달성으로 취급하는 프록시 경로에서도 이 검사를 먼저 해야
    ``is_final => shared`` 로컬 불변식이 깨지지 않는다.
    """
    if gen and gen.get("is_final"):
        raise HTTPException(status_code=409, detail=_FINAL_UNPUBLISH_DETAIL)


def _journal_share_change(request: Request, gen: dict[str, Any], *, shared: bool) -> None:
    """실제로 바뀐 공유 상태만 장기 감사 이력에 남긴다.

    프롬프트와 결과 URL은 넣지 않고 생성물·프로젝트 식별자와 공개 여부만 기록한다.
    """
    journal_audit_event(
        "generation.published" if shared else "generation.unpublished",
        actor_uid=actor_id(request),
        target_type="generation",
        target_id=gen.get("id"),
        project_id=gen.get("project_id"),
        fields=["shared"],
        details={"shared": shared},
    )


def _is_remote_generation_missing(exc: HTTPException) -> bool:
    """라우트 자체가 없는 404와 서버에 generation 행이 없는 404를 구분한다.

    업데이트 중 구버전 서버의 FastAPI 기본 404(``Not Found``)를 목표 달성으로 오판하면
    서버 공유는 남아 있는데 로컬 배지만 사라질 수 있다. 현재 서버가 generation 조회 실패에
    쓰는 명시적 detail만 멱등 성공으로 인정하고, 모르는 404는 안전하게 전파한다.
    """
    detail = exc.detail
    if isinstance(detail, dict):
        detail = detail.get("detail")
    return str(detail or "").strip().lower() in {
        "generation 없음",
        "generation not found",
    }


def _prepare_proxy_intent(
    *,
    local_id: str | None,
    server_id: str,
    operation_kind: str,
    desired_shared: bool,
    desired_final: bool,
    base_shared: bool,
    base_final: bool,
    expected_final_by: str | None = None,
) -> dict[str, Any]:
    """프록시 mutation의 서버 호출 전 prepared 기록. 실패하면 503으로 서버 호출을 막는다."""
    try:
        return repo.prepare_share_state_intent(
            _proxy.base_url(),
            server_generation_id=(None if local_id else server_id),
            job_anchor=(server_id if local_id else None),
            local_id=local_id,
            operation_kind=operation_kind,
            desired_shared=desired_shared,
            desired_final=desired_final,
            base_shared=base_shared,
            base_final=base_final,
            expected_final_by=expected_final_by,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="공유 상태 원장을 기록하지 못해 서버 호출을 중단했습니다",
        ) from exc


def _transition_proxy_intent(
    ref: dict[str, Any], status: str, **fields: Any
) -> bool:
    return repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        status,
        **fields,
    )


def _record_proxy_failure(
    ref: dict[str, Any], exc: HTTPException, *, composite_partial: bool = False
) -> None:
    """확정 4xx만 종결한다. 연결/5xx는 서버 결과가 불명이라 prepared를 보존한다."""
    should_kick = False
    try:
        if exc.status_code == 401:
            _transition_proxy_intent(
                ref, "auth_required", last_error_code="remote_auth_required"
            )
        elif 400 <= exc.status_code < 500:
            if composite_partial:
                # 발행은 됐지만 finalize가 거절된 합성 의도다. 3b가 base_shared에 따라
                # 조건부 unpublish 또는 공유 유지+final rejected 정책을 수행해야 한다.
                if _transition_proxy_intent(
                    ref,
                    "pending",
                    observed_state={
                        "shared": True,
                        "is_final": False,
                        "publish_confirmed": True,
                    },
                    last_error_code=f"finalize_remote_{exc.status_code}",
                ):
                    repo.release_share_state_intent_claim(
                        ref["intent_id"], ref["intent_seq"], ref["claim_token"]
                    )
                    should_kick = True
            else:
                _transition_proxy_intent(
                    ref, "rejected", last_error_code=f"remote_{exc.status_code}"
                )
        else:
            # 결과가 불명인 prepared는 즉시 관측 가능하게 route lease만 반납한다.
            repo.release_share_state_intent_claim(
                ref["intent_id"], ref["intent_seq"], ref["claim_token"]
            )
            should_kick = True
    except Exception:  # noqa: BLE001 — 원래 서버 오류를 가리지 않으며 prepared 잔존도 안전하다
        pass
    if should_kick:
        kick_share_state_reconciler()


def _mirror_proxy_success(
    ref: dict[str, Any],
    out: dict[str, Any] | None,
    *,
    local_id: str | None,
    shared: bool,
    is_final: bool,
    final_by: str | None = None,
    shared_by: str | None = None,
    preservation_reason: str | None = None,
) -> bool:
    """서버 성공 관측을 pending으로 보강한 뒤 로컬 적용+converged CAS를 원자로 수행한다."""
    observed = {"shared": shared, "is_final": is_final}
    if isinstance(out, dict) and out.get("final_by") is not None:
        observed["final_by"] = out.get("final_by")
    server_generation_id = out.get("id") if isinstance(out, dict) else None
    job_anchor = out.get("job_id") if isinstance(out, dict) else None
    try:
        transitioned = _transition_proxy_intent(
            ref,
            "pending",
            server_generation_id=(server_generation_id or ref.get("server_generation_id")),
            job_anchor=(job_anchor or ref.get("job_anchor")),
            local_id=local_id,
            observed_state=observed,
        )
        applied = (
            transitioned
            and repo.apply_share_state_intent_local(
                ref["intent_id"],
                ref["intent_seq"],
                ref["claim_token"],
                local_id=local_id,
                shared=shared,
                is_final=is_final,
                final_by=final_by,
                shared_by=shared_by,
                preservation_reason=preservation_reason,
                observed_state=observed,
            )
            == repo.SHARE_STATE_APPLY_APPLIED
        )
    except Exception:
        applied = False
    if not applied:
        try:
            repo.mark_share_state_intent_waiting_local(
                ref["intent_id"], ref["intent_seq"], ref["claim_token"]
            )
        except Exception:  # noqa: BLE001 — prepared/pending 잔존 자체가 재시작 안전망
            pass
        kick_share_state_reconciler()
    return applied


def _mirror_pending_response(out: dict[str, Any] | None) -> JSONResponse:
    """response_model 필터를 우회해 실패가 아닌 서버 성공 + 미러 대기 의미를 보존한다."""
    payload = dict(out or {})
    payload["mirror_pending"] = True
    return JSONResponse(status_code=200, content=jsonable_encoder(payload))


def _require_unpublish(request: Request, gen: dict[str, Any]) -> None:
    """공유 해제 권한(B안) — 본인/admin(system), 또는 그 항목 프로젝트의 SUPERVISOR.

    창작자는 자기 공유물을 내릴 수 있고(require_edit_generation 통과), 슈퍼바이저는 팀 전체를
    내릴 수 있다. 미분류(프로젝트 없음)는 슈퍼바이저 개념이 없어 본인/admin 만."""
    try:
        require_edit_generation(request, gen)  # 본인/admin 이면 통과
        return
    except HTTPException as e:
        if e.status_code != 403:
            raise  # 403(권한 없음)만 슈퍼바이저 체크로 넘어감 — 그 외는 전파
    pid = (gen.get("project_id") or "").strip()
    if not (pid and pid != "none"):
        raise HTTPException(status_code=403, detail="공유 해제 권한이 없습니다")
    require_project_role(request, pid, rbac.SUPERVISOR)  # 슈퍼바이저 아니면 403


@contextmanager
def _pinned_account_scope():
    """이 블록 전체를 '들어올 때의 계정 DB' 하나로 고정한다.

    finalize·unpublish 는 로컬 읽기 → 원장 prepare → 프록시 토큰 → 서버 호출 → 로컬 미러 →
    텔레메트리 → BackgroundTask 등록으로 이어지는 긴 흐름이고, repo·_proxy.token() 은 전부
    **호출 시점의** 활성 계정 DB 를 읽는다. 서버 왕복을 기다리는 사이 다른 창에서 A→B 로
    전환하면 'A 의 intent + B 의 토큰 + B 로 간 미러/텔레메트리' 같은 섞인 조합이 조용히 생긴다.
    첫 DB 접근 전에 키를 한 번 캡처해 override 로 얹으면 응답까지 모든 단계가 같은 계정을 본다.

    캡처 시점의 override 값은 account_key() 가 이미 돌려주던 값과 같아 동작은 그대로고
    (AUTH on 서버는 항상 None → "" → 레거시 단일 DB) '중간 전환에 흔들리지 않음'만 더해진다.
    ★finalize/unpublish 는 동기 def 라우트(threadpool)라 여기서 전환 락을 직접 기다려도
    이벤트 루프를 막지 않는다 — async 라우트라면 _capture_account_scope 를 워커로 빼야 한다.

    ★계정 키와 uid 는 한 쌍으로 캡처해 둘 다 고정한다. 키만 고정하면 라우트 본문의
    active_uid() 가 머신 포인터를 따로 읽어 'DB=A · 소유 uid=B' 오귀속이 남는다(R13-IMPORT-1).
    """
    account_key, account_uid = _capture_account_pin()
    account_token = active_account.set_override(account_key)
    uid_token = active_account.set_uid_override(account_uid)
    try:
        yield
    finally:
        active_account.reset_uid_override(uid_token)
        active_account.reset_override(account_token)


def _account_scoped_route(fn):
    """라우트 호출 전체를 _pinned_account_scope 로 감싼다(동기 라우트 전용).

    functools.wraps 가 __wrapped__ 를 남기므로 FastAPI 의 시그니처 해석(inspect.signature)은
    원래 파라미터를 그대로 보고, 코루틴이 아니므로 종전대로 threadpool 에서 실행된다.
    """

    @wraps(fn)
    def wrapper(*args, **kwargs):
        with _pinned_account_scope():
            return fn(*args, **kwargs)

    return wrapper


@router.post("/generations/{gen_id}/publish", response_model=GenerationOut)
@_account_scoped_route
def publish(gen_id: str, body: PublishIn, request: Request):
    """generation 을 팀에 발행한다(명시적). 한 generation 은 0~1개의 share.
    발행 = share-set 에 추가(서버 발행은 publish-to-shared 번들 경로가 담당).
    ★네트워크 왕복이 없는 로컬 전용 구간이지만, 읽기(get_generation)~쓰기(publish·보존요청·
    텔레메트리)가 여러 DB 왕복으로 나뉘어 있어 같은 계정 DB 고정을 동일하게 적용한다."""
    if _proxy.proxying():
        # 프록시 모드의 서버 발행은 번들 write-ahead 경로만 허용한다. 이 로컬-only API를
        # 열어 두면 서버에는 없고 이 PC에만 shared인 상태가 생긴다.
        raise HTTPException(
            status_code=400,
            detail="프록시 모드에서는 /api/publish-to-shared 번들 발행을 사용하세요",
        )
    gen = repo.get_generation(gen_id)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    require_edit_generation(request, gen)  # 공유는 본인(또는 admin)만 — 남의 작업 공유 불가
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 발행할 수 있음")
    # 공유자는 항상 인증된 본인 — body.shared_by 는 신뢰하지 않는다(위장 방지).
    # 프론트는 이 필드를 보내지 않으므로 동작 변화 없음(필드는 하위호환용으로만 남김).
    shared_by = actor_id(request)
    was_shared = bool(gen.get("shared"))
    repo.publish(gen_id, shared_by, body.visibility)
    repo.request_media_preservation(gen_id, "shared")
    _touch_telemetry(gen_id)
    out = repo.get_generation(gen_id)
    if out and not was_shared and out.get("shared"):
        _journal_share_change(request, out, shared=True)
    return out


@router.post("/generations/{gen_id}/unpublish", response_model=GenerationOut)
@_account_scoped_route
def unpublish(gen_id: str, request: Request):
    """팀 공유 해제 — share 행을 제거한다(내가 공유한 것을 되돌림).
    ⚠️ 최종(골드)인 항목은 공유 해제 불가 — '최종인데 공유 안 됨' 모순 차단(먼저 최종 해제).
    ★finalize 와 동일하게 첫 DB 접근부터 응답까지 한 계정 DB 로 고정한다(_pinned_account_scope):
    서버 unpublish 왕복 중 계정이 바뀌면 A 원장에 prepare 해 놓고 B 토큰으로 호출하거나
    B DB 에 미러/텔레메트리를 쓰게 된다."""
    requested_id = gen_id
    gen_id = repo.resolve_local_id(gen_id)  # 서버 핸들러가 job_id 로 와도 자기 행을 찾게(내작업탭→서버 방향)
    gen = repo.get_generation(gen_id)
    # 로컬 우선: 발행은 번들로 서버에 올라가 있으므로 '서버 해제'가 진실이다. 서버를 먼저 호출해
    # 성공해야 로컬도 해제한다 — 실패(서버 다운/권한/만료)를 삼키면 "로컬은 해제됨, 팀엔 그대로
    # 노출"이라는 프라이버시 누수가 무음으로 생긴다. 단 404(서버에 이미 없음)는 목표 달성으로 간주.
    if _proxy.proxying():
        with _stable_proxy_identity_lock(requested_id) as (local_id, server_id):
            # 잠금을 기다린 뒤 로컬 final 가드도 다시 읽어 finalize 교차 실행을 직렬화한다.
            current = repo.get_generation(local_id) if local_id else None
            _ensure_not_final_before_unpublish(current)
            ref = _prepare_proxy_intent(
                local_id=local_id,
                server_id=server_id,
                operation_kind="unpublish",
                desired_shared=False,
                desired_final=False,
                base_shared=bool(current.get("shared")) if current else True,
                base_final=bool(current.get("is_final")) if current else False,
            )
            try:
                out = _proxy.proxy_json(
                    "POST", f"/api/generations/{server_id}/unpublish"
                )
            except HTTPException as exc:
                if exc.status_code != 404 or not _is_remote_generation_missing(exc):
                    _record_proxy_failure(ref, exc)
                    raise
                out = None  # 서버에 이미 없음 = desired shared=false 달성

            if local_id is None:
                local_id = _local_id_from_out(out)
            if local_id is None and out is None:
                # 서버·로컬 모두 없는 멱등 404는 적용할 미러 자체가 없다.
                _transition_proxy_intent(
                    ref,
                    "converged",
                    observed_state={"shared": False, "is_final": False},
                )
                raise HTTPException(status_code=404, detail="generation 없음")
            mirrored = _mirror_proxy_success(
                ref,
                out,
                local_id=local_id,
                shared=False,
                is_final=False,
            )
            if mirrored and local_id:
                _touch_telemetry(local_id)
                return repo.get_generation(local_id)
            if out is not None:
                return _mirror_pending_response(out)
            if local_id:
                server_state = dict(current or {})
                server_state.update({"shared": False, "is_final": False})
                return _mirror_pending_response(server_state)
            raise HTTPException(status_code=404, detail="generation 없음")
    # 비프록시(서버 본체/단독 모드): 로컬에서 직접 처리.
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    _require_unpublish(request, gen)  # 공유 해제 = 본인/admin, 또는 그 프로젝트 슈퍼바이저(B안)
    try:
        was_shared = repo.unpublish_generation_if_not_final(gen_id)
    except repo.FinalGenerationUnpublishError as exc:
        raise HTTPException(status_code=409, detail=_FINAL_UNPUBLISH_DETAIL) from exc
    _touch_telemetry(gen_id)
    out = repo.get_generation(gen_id)
    if out and was_shared and not out.get("shared"):
        _journal_share_change(request, out, shared=False)
    return out


# ── v02 CMS — Supervisor 최종(골드) 선별 (로드맵 PART 2) ────────────────────
def _finalizer_uid(request: Request) -> str | None:
    """최종 지정자 uid — 로그인 계정의 creator_uid, 없으면 제공자(나) uid."""
    acc = current_account(request)
    if acc and acc.get("creator_uid"):
        return acc["creator_uid"]
    try:
        return repo.get_provider().get("uid")
    except Exception:  # noqa: BLE001
        return None


def _capture_account_pin() -> tuple[str, str | None]:
    """계정 DB 키와 그 계정의 uid 를 **같은 전환 락 구간**에서 한 쌍으로 캡처한다.

    둘을 따로 읽으면 그 사이에 낀 전환이 'A DB 에 쓰면서 소유자는 B' 같은 조합을 조용히
    만든다 — 락 안에서 함께 떠야 (A,A) 아니면 (B,B) 만 나온다(R13-IMPORT-1)."""
    with active_account.transition_lock:
        return active_account.account_key() or "", active_account.active_uid()


def _capture_account_scope() -> str:
    """현재 계정 DB 키만 전환 락 아래 짧게 캡처한다(느린 보존·서버 왕복은 락 밖).

    _pinned_account_scope 가 라우트 진입 시 한 번 부르고, 그 override 아래에서 다시 불리는
    BackgroundTask 등록부(add_task 인자)는 같은 키를 그대로 돌려받는다."""
    return _capture_account_pin()[0]


async def _preserve_final_media(local_id: str, account_scope: str) -> None:
    """최종(골드) 지정 시 그 생성물의 원본을 로컬로 byte-cache 한다 — 힉스필드 CDN URL 이 나중에 죽어도
    최종본은 로컬 보존본으로 남는다(선택 보존). best-effort: 실패해도 finalize 결과엔 영향 없음.
    ★썸네일 LRU 삭제는 .thumbs 만 대상이라, 여기서 MEDIA_DIR 에 받은 원본 보존본은 지워지지 않는다.

    ★응답 이후(BackgroundTask)에 도는 코드다. ① 동기 DB 는 워커 스레드로 — 여기서 루프를 잡으면
    유지보수 게이트 대기가 서버 전체를 세운다. ② 계정 범위는 라우트에서 캡처한 키로 고정 — 응답
    뒤에 계정 전환이 끼면 B DB 를 읽어 gen 이 None 이 되고 골드 원본 보존이 조용히 유실됐다."""
    account_token = active_account.set_override(account_scope or "")
    try:
        # 요청을 먼저 영속화하므로 프로세스가 여기서 중단돼도 다음 시작의 주기 워커가 이어간다.
        gen = await to_thread_non_abandon(repo.get_generation, local_id)
        if not gen or not gen.get("is_final"):
            return
        await to_thread_non_abandon(repo.request_media_preservation, local_id, "final")
        await preserve_generation_now(local_id)
    finally:
        active_account.reset_override(account_token)


@router.post("/generations/{gen_id}/finalize", response_model=GenerationOut)
@_account_scoped_route
def finalize(gen_id: str, request: Request, background: BackgroundTasks):
    """생성본을 최종(골드)으로 지정 — 그 프로젝트의 Supervisor 만(검수권). AUTH off 면 통과.
    최종은 곧 후보 확정이므로 공유(share)가 없으면 함께 발행한다(게이트 아님: 공유는 이미 자유).
    로컬 우선: 골드는 '공유된 항목의 서버 상태'다. 프록시 모드면 (필요시 번들 발행 후) 서버에
    finalize 를 위임하고 — 역할 검증·골드 상태는 서버가 가진다 — 내 로컬 카드에도 골드를 미러한다.
    ★첫 DB 접근(resolve_local_id)부터 응답까지 한 계정 DB 로 고정한다(_pinned_account_scope).
    프록시 토큰·intent·미러·텔레메트리·BackgroundTask 인자가 전부 같은 계정을 보게 하기 위함."""
    requested_id = gen_id
    gen_id = repo.resolve_local_id(gen_id)  # 서버 핸들러가 job_id 로 와도 자기 행을 찾게(내작업탭→서버 방향)
    gen = repo.get_generation(gen_id)
    if _proxy.proxying():
        with _stable_proxy_identity_lock(requested_id) as (local_id, server_id):
            current = repo.get_generation(local_id) if local_id else None
            finalizer_uid = _finalizer_uid(request)
            composite = bool(current is not None and not current.get("shared"))
            if composite:
                if current["status"] != "done":
                    raise HTTPException(status_code=409, detail="완료된 생성만 최종 지정할 수 있음")
                from .publish import publish_bundle_to_server

                pub = publish_bundle_to_server(
                    [local_id],
                    operation_kind="composite_finalize",
                    desired_final=True,
                    expected_final_by=finalizer_uid,
                    settle_intents=False,
                )
                ref = pub.intent_refs.get(server_id)
                if not ref:
                    raise HTTPException(
                        status_code=503,
                        detail="합성 최종 원장을 찾지 못해 서버 finalize를 중단했습니다",
                    )
                # 서버 발행 승인 여부로 판정한다. 로컬 미러 실패는 원장 대기일 뿐 finalize를
                # 되돌리거나 중단할 이유가 아니다.
                if not pub.remote_accepted:
                    raise HTTPException(
                        status_code=409,
                        detail=pub.get("message")
                        or "서버가 발행을 반영하지 않아 최종 지정을 중단했습니다",
                    )
            else:
                ref = _prepare_proxy_intent(
                    local_id=local_id,
                    server_id=server_id,
                    operation_kind="finalize",
                    desired_shared=True,
                    desired_final=True,
                    base_shared=bool(current.get("shared")) if current else True,
                    base_final=bool(current.get("is_final")) if current else False,
                    expected_final_by=finalizer_uid,
                )

            try:
                out = _proxy.proxy_json(
                    "POST", f"/api/generations/{server_id}/finalize"
                )
            except HTTPException as exc:
                _record_proxy_failure(ref, exc, composite_partial=composite)
                raise
            if local_id is None:
                local_id = _local_id_from_out(out)
                current = repo.get_generation(local_id) if local_id else current
            mirrored = _mirror_proxy_success(
                ref,
                out,
                local_id=local_id,
                shared=True,
                is_final=True,
                final_by=finalizer_uid,
                shared_by=(current.get("worker_id") if current else DEFAULT_WORKER_ID),
                preservation_reason="final",
            )
            if mirrored and local_id:
                _touch_telemetry(local_id)
                background.add_task(
                    _preserve_final_media, local_id, _capture_account_scope()
                )
                return out
            return _mirror_pending_response(out)
    # 비프록시(서버 본체/단독 모드): 로컬에서 직접 처리.
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen["status"] != "done":
        raise HTTPException(status_code=409, detail="완료된 생성만 최종 지정할 수 있음")
    if gen.get("project_id"):
        # 골드(최종) 결정권 = 그 프로젝트의 SUPERVISOR 만(PM 은 생성·멤버배치 역할이라 제외).
        # 전역 admin 은 최상위 관리자라 예외로 통과.
        if not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
            require_project_role(request, gen["project_id"], rbac.SUPERVISOR)
    else:
        # 프로젝트 미배정 → 검수자(Supervisor) 개념이 없다. 본인/admin 만(남의 비공개 강제 공유 차단).
        require_edit_generation(request, gen)
    # 최종 = 후보 확정 → 공유 동반. 공유 확인부터 final 기록까지 한 쓰기락으로 묶어
    # 로컬 unpublish가 둘 사이에 끼어드는 모순(is_final=1, share 없음)을 차단한다.
    repo.finalize_generation_with_share(
        gen_id, actor_id(request), _finalizer_uid(request), "team"
    )
    _touch_telemetry(gen_id)
    journal_audit_event(
        "generation.finalized",
        actor_uid=actor_id(request),
        target_type="generation",
        target_id=gen_id,
        project_id=gen.get("project_id"),
        fields=["is_final", "final_by", "final_at"],
        details={"is_final": True},
    )
    # 최종본 원본 로컬 보존 — 응답 뒤에 도는 태스크라 지금의 계정 DB 키를 같이 넘긴다.
    background.add_task(_preserve_final_media, gen_id, _capture_account_scope())
    return repo.get_generation(gen_id)


@router.post("/generations/{gen_id}/unfinalize", response_model=GenerationOut)
@_account_scoped_route
def unfinalize(gen_id: str, request: Request):
    """최종(골드) 해제 → 일반 공유 상태로 복귀(공유는 유지). Supervisor 만.
    ★unpublish 와 같은 구조(원장 prepare → 서버 왕복 → 로컬 미러)라 같은 계정 고정을 쓴다."""
    requested_id = gen_id
    gen_id = repo.resolve_local_id(gen_id)  # 서버 핸들러가 job_id 로 와도 자기 행을 찾게(내작업탭→서버 방향)
    gen = repo.get_generation(gen_id)
    if _proxy.proxying():
        with _stable_proxy_identity_lock(requested_id) as (local_id, server_id):
            current = repo.get_generation(local_id) if local_id else None
            ref = _prepare_proxy_intent(
                local_id=local_id,
                server_id=server_id,
                operation_kind="unfinalize",
                desired_shared=True,
                desired_final=False,
                base_shared=bool(current.get("shared")) if current else True,
                base_final=bool(current.get("is_final")) if current else True,
            )
            try:
                out = _proxy.proxy_json(
                    "POST", f"/api/generations/{server_id}/unfinalize"
                )
            except HTTPException as exc:
                _record_proxy_failure(ref, exc)
                raise
            if local_id is None:
                local_id = _local_id_from_out(out)
                current = repo.get_generation(local_id) if local_id else current
            mirrored = _mirror_proxy_success(
                ref,
                out,
                local_id=local_id,
                shared=True,
                is_final=False,
                shared_by=(current.get("worker_id") if current else DEFAULT_WORKER_ID),
            )
            if mirrored and local_id:
                _touch_telemetry(local_id)
                return out
            return _mirror_pending_response(out)
    if not gen:
        raise HTTPException(status_code=404, detail="generation 없음")
    if gen.get("project_id"):
        # 골드(최종) 결정권 = 그 프로젝트의 SUPERVISOR 만(PM 은 생성·멤버배치 역할이라 제외).
        # 전역 admin 은 최상위 관리자라 예외로 통과.
        if not rbac.has_any_global_role(account_global_roles(request), rbac.ADMIN):
            require_project_role(request, gen["project_id"], rbac.SUPERVISOR)
    else:
        require_edit_generation(request, gen)  # 미배정 → 본인/admin 만
    repo.set_final(gen_id, False)
    _touch_telemetry(gen_id)
    journal_audit_event(
        "generation.unfinalized",
        actor_uid=actor_id(request),
        target_type="generation",
        target_id=gen_id,
        project_id=gen.get("project_id"),
        fields=["is_final", "final_by", "final_at"],
        details={"is_final": False},
    )
    return repo.get_generation(gen_id)


# ── 제공자 신원 ───────────────────────────────────────────────────────────
@router.get("/provider")
def get_provider() -> dict[str, Any]:
    """내 제공자 신원 {uid, name, email}. 작성자 표기의 기준."""
    return repo.get_provider()


def _remote_media_url(item: dict[str, Any]) -> str | None:
    """서버 GenerationOut 의 미디어 경로를 번들 import 가 먹을 수 있는 URL 로 정규화."""
    raw = item.get("source_url") or item.get("file_path")
    url = str(raw).strip() if raw else ""
    return url or None


def _remote_generation_item(remote: dict[str, Any]) -> dict[str, Any]:
    """프록시로 받은 서버 generation 1건을 로컬 import_bundle_item 입력 형태로 변환."""
    assets = remote.get("assets") or []
    asset = None
    for a in assets:
        if not isinstance(a, dict):
            continue
        url = _remote_media_url(a)
        if url:
            asset = {"type": a.get("type") or "image", "file_path": url}
            # 영상 포스터(원격 http 썸네일)도 보존 → _upsert_synced 가 thumbnail_path 로 복원.
            thumb = a.get("thumbnail_path")
            if thumb and thumb.startswith("http"):
                asset["thumbnail_url"] = thumb
            break

    refs: list[dict[str, Any]] = []
    for r in remote.get("references") or []:
        if not isinstance(r, dict):
            continue
        url = _remote_media_url(r)
        if not url:
            continue
        refs.append(
            {
                "id": r.get("id"),
                "type": r.get("type") or "image",
                "file_path": url,
                "role": r.get("role"),
                "source": r.get("source") or "uploaded",
            }
        )

    return {
        "generation": {
            # 앵커 보존 — 번들 규약(id=job_id||id)과 동일하게. 서버 UUID 를 그대로 쓰면 물질화된
            # 로컬 행의 job_id 가 원래 앵커가 아니라 서버 UUID 가 되어, 이후 동기화·확인(ack)·개인메타의
            # job_id 매칭이 전부 어긋난다(코덱스 P1 보강).
            "id": remote.get("job_id") or remote.get("id"),
            "prompt": remote.get("prompt") or "",
            "display_prompt": remote.get("display_prompt"),
            "model": remote.get("model"),
            "params": remote.get("params") or {},
            "status": remote.get("status") or "done",
            "created_at": remote.get("created_at") or "",
            "sort_ts": remote.get("sort_ts"),
            "creator_uid": remote.get("creator_uid"),
            "workspace_scope": remote.get("workspace_scope") or "unknown",
            "workspace_id": remote.get("workspace_id"),
            "workspace_name": remote.get("workspace_name"),
            "project_id": remote.get("project_id"),
            "folder_path": remote.get("folder_path"),
        },
        "asset": asset,
        "references": refs,
        "tags": remote.get("tags") or [],
        "auto_tags": remote.get("auto_tags") or [],
        "comments": [],
    }


def _materialize_remote_shared(gen_id: str, request: Request) -> tuple[dict[str, Any] | None, str | None]:
    """로컬 프록시 모드에서 서버에만 있는 팀 공유 항목을 로컬 DB 에 먼저 심는다.

    가져오기(import_generation)는 로컬 DB 행을 원본으로 삼아 프롬프트·레퍼런스·히스토리를 복제하므로,
    팀 탭의 남의 카드처럼 로컬에 아직 없는 항목은 서버에서 단건 조회 후 동기화본으로 물질화한다.
    """
    if not _proxy.proxying():
        return None, None
    remote = _proxy.proxy_get(f"/api/generations/{gen_id}", request)
    if not isinstance(remote, dict) or not remote.get("id"):
        return None, None
    if not remote.get("shared"):
        raise HTTPException(status_code=409, detail="공유되지 않은 항목은 가져올 수 없음")

    shared_by = str(remote.get("creator_uid") or remote.get("worker_id") or "team").strip()
    if not shared_by or shared_by == DEFAULT_WORKER_ID:
        shared_by = "team"
    shared_name = remote.get("creator_name") or remote.get("worker_name") or shared_by
    with get_connection() as conn:
        repo.ensure_worker(conn, shared_by, shared_name, "team")

    repo.import_bundle_item(_remote_generation_item(remote), DEFAULT_WORKER_ID, shared_by)
    # 되찾기도 앵커로 — 물질화 행은 job_id=앵커로 저장되므로 서버 UUID 로는 못 찾는다(위 id 규약과 쌍).
    anchor = str(remote.get("job_id") or remote["id"])
    local_id, _ = repo.finalize_id_map(anchor)
    source_id = local_id or anchor
    return repo.get_generation(source_id), source_id


@router.post("/generations/{gen_id}/import", response_model=GenerationOut, status_code=201)
@_account_scoped_route
def import_to_workspace(gen_id: str, body: ImportIn, request: Request):
    """공유 항목을 내 워크스페이스로 복제(프롬프트·레퍼런스 보존) + history.
    ★finalize/unpublish 와 같은 계정 고정(_pinned_account_scope): 이 라우트는 중간에
    _materialize_remote_shared 로 서버를 왕복하고, 그 사이 다른 창에서 A→B 로 전환하면
    'A 에서 읽은 원본을 B DB 에 복제'하는 섞인 조합이 조용히 생긴다."""
    # 복제본은 가져온 계정 소유로 — house uid 로 떨어지면 내 작업에 안 잡힘(격리 일관성).
    # ★소유 uid 는 캡처 직후·네트워크 전에 확정한다. active_uid() 는 라우트 진입 때 계정 키와
    # 한 쌍으로 캡처된 값을 돌려주므로(_pinned_account_scope) 서버 왕복 중 전환이 껴도 DB 와
    # 소유 uid 가 갈리지 않는다 — 캡처보다 앞서 읽는 일이 없게 순서도 그대로 둔다.
    acc = current_account(request)
    creator_uid = acc.get("creator_uid") if acc else None
    if not creator_uid and _proxy.proxying():
        from ..active_account import active_uid

        creator_uid = active_uid()
    src = repo.get_generation(gen_id)
    if not src and _proxy.proxying():
        # 팀 탭은 서버 id(job_id)로 표시 → 내 로컬 항목이면 job_id 로 재해석해 찾는다.
        # (남의 공유본은 로컬에 원본이 없어 여전히 404 — 그건 별개 사안.)
        local_id, _ = repo.finalize_id_map(gen_id)
        if local_id and local_id != gen_id:
            gen_id = local_id
            src = repo.get_generation(gen_id)
        if not src:
            src, materialized_id = _materialize_remote_shared(gen_id, request)
            if materialized_id:
                gen_id = materialized_id
    if not src:
        raise HTTPException(status_code=404, detail="원본 generation 없음")
    require_view_generation(request, src)  # ⑥: 볼 수 있는 것만 가져올 수 있다(멤버십 경계 일치)
    if not src["shared"]:
        raise HTTPException(status_code=409, detail="공유되지 않은 항목은 가져올 수 없음")
    worker_id = body.worker_id or DEFAULT_WORKER_ID
    child_id = repo.import_generation(gen_id, worker_id, creator_uid=creator_uid)
    child = repo.get_generation(child_id)
    if not child:
        raise HTTPException(status_code=500, detail="복제 실패")
    return child
