"""공유 서버 권위 상태를 로컬 공유/골드 미러에 수렴시키는 전용 워커.

원장은 명령 재생 목록이 아니다. 각 항목을 처리할 때 서버의 현재 상태를 다시 읽고 그 관측값만
로컬에 적용한다. 예외는 합성 finalize의 발행만 성공한 상태로, 설계된 조건부 정리만 수행한다.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional
from urllib.parse import quote

from fastapi import HTTPException

from .. import active_account, repo
from .operational_logging import log_event


# 계층 경계(services→routers import 금지 — test_architecture_boundaries) 때문에 라우터
# 의존(프록시 컨텍스트·HTTP·텔레메트리 킥)은 앱 조립 시점에 주입받는다: main.py lifespan이
# start() 전에 configure_share_state_router_deps() 를 호출한다. 주입 전에는 사이클이 idle 로 끝난다.
_proxy: Any = None
touch_generation_telemetry: Callable[[Any], None] = lambda gen_id: None


def configure_share_state_router_deps(
    *, proxy: Any, touch_telemetry: Callable[[Any], None]
) -> None:
    global _proxy, touch_generation_telemetry
    _proxy = proxy
    touch_generation_telemetry = touch_telemetry


_log = logging.getLogger("mvhub.share_state_reconciler")
_INTERVAL_SECONDS = max(
    1.0, float(os.getenv("CONTENT_HUB_SHARE_RECONCILE_INTERVAL_SECONDS", "30"))
)
_BATCH_LIMIT = 10
_LEASE_SECONDS = 120
_MAX_BACKOFF_SECONDS = 600
_LOCAL_TARGET_LOST_RETRY_LIMIT = 5
# 결과를 모르는 요청(시간 초과·응답 유실·호출 전후를 모르는 크래시)을 서버의 '바라던 상태'가 보일 때까지 지켜보는 기한.
# 서버가 요청을 받고 아직 처리하지 않았을 수 있다 — 허브의 60초 제한은 서버 일의 취소 기한이 아니다. 그동안은 읽기 관측만
# 되풀이한다(명령을 다시 보내지 않는다. 간격은 backoff 로 최대 _MAX_BACKOFF_SECONDS). 기한이 지나면 서버의 지금 상태로
# 닫는다. 서버가 요청별 완료 여부를 알려 주지 않으므로 '절대 늦게 적용되지 않는다'는 증명은 아니다 — 하루는 실제로 있을 법한
# 지연을 덮는 완화책이다. 횟수(fail_streak)로 세지 않는다: 그 숫자는 관측 실패·로컬 대상 유실도 같이 쓴다.
_RESULT_UNKNOWN_WATCH_SECONDS = 24 * 60 * 60
_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


class _RemoteObservationError(RuntimeError):
    def __init__(self, error_code: str, *, status_code: int | None = None) -> None:
        super().__init__(error_code)
        self.error_code = error_code
        self.status_code = status_code


class _RemoteAuthRequired(_RemoteObservationError):
    def __init__(self) -> None:
        super().__init__("remote_auth_required", status_code=401)


def _remote_id(intent: Mapping[str, Any]) -> str:
    return str(
        intent.get("server_generation_id") or intent.get("job_anchor") or ""
    ).strip()


def _proxy_context() -> tuple[str, str] | None:
    """현재 계정에 저장된 권위 서버·토큰. SQLite 접근이라 호출자가 ``to_thread``로 감싼다."""
    if _proxy is None or not _proxy.proxying():
        return None
    token = _proxy.token()
    if not token:
        return None
    return repo.normalize_share_server_origin(_proxy.base_url()), token


def _observed_payload(intent: Mapping[str, Any]) -> dict[str, Any]:
    raw = intent.get("observed_state_json")
    if not raw:
        return {}
    try:
        value = json.loads(str(raw))
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _normalize_observed(item: Mapping[str, Any], remote_id: str) -> dict[str, Any]:
    is_final = bool(item.get("is_final"))
    observed: dict[str, Any] = {
        "shared": bool(item.get("shared")) or is_final,
        "is_final": is_final,
        "id": str(item.get("id") or remote_id),
    }
    if not observed["shared"] or is_final:
        observed["is_held"] = False
    elif isinstance(item.get("is_held"), bool):
        observed["is_held"] = item["is_held"]
    for field in ("job_id", "final_by", "worker_id"):
        if item.get(field) is not None:
            observed[field] = item.get(field)
    return observed


def _observe_remote_states(
    server_origin: str,
    token: str,
    intents: list[Mapping[str, Any]],
) -> dict[str, dict[str, Any]]:
    """한 사이클의 서버 상태 batch 조회. blocking HTTP라 호출자가 ``to_thread``로 감싼다."""
    remote_ids = list(dict.fromkeys(_remote_id(intent) for intent in intents))
    if not remote_ids or any(not remote_id for remote_id in remote_ids):
        raise _RemoteObservationError("remote_identity_missing")
    try:
        status, payload = _proxy.raw_request(
            "POST",
            f"{server_origin}/api/generations/batch",
            token=token,
            body={"gen_ids": remote_ids},
            timeout=15,
        )
    except HTTPException as exc:
        raise _RemoteObservationError(
            "remote_observation_unavailable", status_code=exc.status_code
        ) from exc
    if status == 401:
        raise _RemoteAuthRequired()
    if not 200 <= status < 300 or not isinstance(payload, dict):
        raise _RemoteObservationError(
            f"remote_observation_{status}", status_code=status
        )

    items = payload.get("items") if isinstance(payload.get("items"), dict) else {}
    missing = (
        {str(value) for value in payload.get("missing")}
        if isinstance(payload.get("missing"), list)
        else set()
    )
    observed_by_intent: dict[str, dict[str, Any]] = {}
    for intent in intents:
        remote_id = _remote_id(intent)
        item = items.get(remote_id)
        if isinstance(item, dict):
            observed = _normalize_observed(item, remote_id)
        elif remote_id in missing:
            # 서버 행이 없으면 공유·골드도 존재하지 않는다. write-ahead 직후 크래시도 여기로 온다.
            observed = {
                "shared": False,
                "is_final": False,
                "is_held": False,
                "id": remote_id,
                "missing": True,
            }
        else:
            raise _RemoteObservationError("remote_observation_malformed")
        observed_by_intent[str(intent["intent_id"])] = observed
    return observed_by_intent


def _observe_remote_state(
    server_origin: str,
    token: str,
    intent: Mapping[str, Any],
) -> dict[str, Any]:
    """합성 조건부 정리 직전의 단건 재관측."""
    return _observe_remote_states(server_origin, token, [intent])[str(intent["intent_id"])]


def _is_missing_generation(payload: Any) -> bool:
    detail = payload.get("detail") if isinstance(payload, dict) else payload
    if isinstance(detail, dict):
        detail = detail.get("detail")
    return str(detail or "").strip().lower() in {
        "generation 없음",
        "generation not found",
    }


def _unpublish_remote(
    server_origin: str,
    token: str,
    intent: Mapping[str, Any],
) -> dict[str, Any]:
    """합성 finalize 조건부 정리. 성공 응답만 비공유 확정으로 취급한다."""
    remote_id = _remote_id(intent)
    try:
        status, payload = _proxy.raw_request(
            "POST",
            f"{server_origin}/api/generations/{quote(remote_id, safe='')}/unpublish",
            token=token,
            timeout=15,
        )
    except HTTPException as exc:
        raise _RemoteObservationError(
            "remote_cleanup_unavailable", status_code=exc.status_code
        ) from exc
    if status == 401:
        raise _RemoteAuthRequired()
    if 200 <= status < 300:
        observed = (
            _normalize_observed(payload, remote_id)
            if isinstance(payload, dict)
            else {"id": remote_id}
        )
        observed.update({"shared": False, "is_final": False, "is_held": False, "cleanup": "unpublished"})
        return observed
    if status == 404 and _is_missing_generation(payload):
        return {
            "shared": False,
            "is_final": False,
            "is_held": False,
            "id": remote_id,
            "missing": True,
            "cleanup": "already_missing",
        }
    raise _RemoteObservationError(f"remote_cleanup_{status}", status_code=status)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _result_unknown(intent: Mapping[str, Any]) -> bool:
    """이 의도의 서버 결과를 아직 모르는가.

    ``prepared`` 는 선기록 뒤 성공 응답을 받지 못했다는 뜻이다. 그 상태에서 인증 대기(``auth_required``)를 거치면 상태
    이름이 바뀌므로 관측 기록에 표식(``result_unknown``)을 남겨 이어 간다."""
    return (
        intent.get("status") == "prepared"
        or _observed_payload(intent).get("result_unknown") is True
    )


def _unknown_state(
    intent: Mapping[str, Any], observed: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """결과 불명 표식을 실은 관측 기록. 처음 표시한 시각과 합성 발행 확정 표식은 이어 간다."""
    prior = _observed_payload(intent)
    state = dict(observed) if observed is not None else dict(prior)
    if prior.get("publish_confirmed") is True:
        state["publish_confirmed"] = True
    state["result_unknown"] = True
    state["unknown_since"] = str(
        prior.get("unknown_since") or _utc_now().strftime(_TIME_FORMAT)
    )
    return state


def _unknown_watch_expired(intent: Mapping[str, Any]) -> bool:
    since = _observed_payload(intent).get("unknown_since")
    if not since:
        return False
    try:
        started = datetime.strptime(str(since), _TIME_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (_utc_now() - started).total_seconds() >= _RESULT_UNKNOWN_WATCH_SECONDS


def _keep_watching(
    intent: Mapping[str, Any], claim_token: str, observed: Mapping[str, Any]
) -> bool:
    """결과 불명인 채로 둔다 — 관측만 적고 다음에 다시 본다. 로컬은 건드리지 않는다."""
    transitioned = repo.transition_share_state_intent(
        intent["intent_id"],
        intent["intent_seq"],
        claim_token,
        "prepared",
        observed_state=_unknown_state(intent, observed),
        next_retry_at=_next_retry_at(int(intent.get("fail_streak") or 0)),
        last_error_code="remote_result_unknown",
        increment_fail_streak=True,
    )
    if transitioned:
        repo.release_share_state_intent_claim(
            intent["intent_id"], intent["intent_seq"], claim_token
        )
    return transitioned


def _auth_required_fields(intent: Mapping[str, Any]) -> dict[str, Any]:
    """인증 대기로 보낼 때 같이 적을 것 — 결과 불명이었다면 그 표식을 관측 기록에 남긴다."""
    fields: dict[str, Any] = {"last_error_code": "remote_auth_required"}
    if _result_unknown(intent):
        fields["observed_state"] = _unknown_state(intent)
    return fields


def _next_retry_at(fail_streak: int) -> str:
    exponent = min(max(int(fail_streak), 0), 10)
    delay = min(2 ** exponent, _MAX_BACKOFF_SECONDS)
    due = datetime.now(timezone.utc) + timedelta(seconds=delay)
    return due.strftime("%Y-%m-%d %H:%M:%S")


def _mark_retry(
    intent: Mapping[str, Any],
    claim_token: str,
    *,
    error_code: str,
    waiting_local: bool,
) -> bool:
    next_retry_at = _next_retry_at(int(intent.get("fail_streak") or 0))
    if waiting_local:
        return repo.mark_share_state_intent_waiting_local(
            intent["intent_id"],
            intent["intent_seq"],
            claim_token,
            error_code=error_code,
            next_retry_at=next_retry_at,
        )
    transitioned = repo.transition_share_state_intent(
        intent["intent_id"],
        intent["intent_seq"],
        claim_token,
        str(intent["status"]),
        next_retry_at=next_retry_at,
        last_error_code=error_code,
        increment_fail_streak=True,
    )
    if transitioned:
        # prepared/pending은 transition만으로 lease를 풀지 않는다. 관측 실패는 재시도 가능해야 한다.
        repo.release_share_state_intent_claim(
            intent["intent_id"], intent["intent_seq"], claim_token
        )
    return transitioned


def _link_job_id(intent: Mapping[str, Any], observed: Mapping[str, Any]) -> str | None:
    """서버 id 만 아는 원장(팀 카드에서 낸 요청)이 로컬 행을 찾을 때 쓸 관측의 job_id. 그 밖의 원장은 저장된 앵커로 찾는다."""
    if intent.get("local_id") or intent.get("job_anchor"):
        return None
    job_id = str(observed.get("job_id") or "").strip()
    return job_id if job_id and job_id != _remote_id(intent) else None


def _apply_observed_local(
    intent: Mapping[str, Any],
    claim_token: str,
    observed: Mapping[str, Any],
    *,
    status: str,
    link_job_id: str | None = None,
    held_anchors: tuple[str, ...] | None = None,
) -> str:
    result = repo.apply_share_state_intent_local(
        intent["intent_id"],
        intent["intent_seq"],
        claim_token,
        local_id=intent.get("local_id"),
        shared=bool(observed.get("shared")),
        is_final=bool(observed.get("is_final")),
        is_held=observed.get("is_held"),
        final_by=(str(observed.get("final_by")) if observed.get("final_by") else None),
        shared_by=(str(observed.get("worker_id")) if observed.get("worker_id") else None),
        preservation_reason=(
            "final"
            if observed.get("is_final")
            else "shared" if observed.get("shared") else None
        ),
        status=status,
        observed_state=observed,
        link_job_id=link_job_id,
        held_anchors=held_anchors,
    )
    if result == repo.SHARE_STATE_APPLY_APPLIED:
        saved = repo.get_share_state_intent(str(intent["intent_id"])) or {}
        touch_generation_telemetry(saved.get("local_id"))
    return result


def _terminal_status(intent: Mapping[str, Any], observed: Mapping[str, Any]) -> str:
    desired_held = intent.get("desired_held")
    if desired_held is not None and not isinstance(observed.get("is_held"), bool):
        raise _RemoteObservationError("remote_review_state_unsupported")
    desired = (
        bool(intent.get("desired_shared")),
        bool(intent.get("desired_final")),
    )
    actual = (bool(observed.get("shared")), bool(observed.get("is_final")))
    held_matches = desired_held is None or bool(desired_held) == observed.get("is_held")
    if actual == desired and held_matches:
        return "converged"
    base = (bool(intent.get("base_shared")), bool(intent.get("base_final")))
    base_held = intent.get("base_held")
    base_matches = base_held is None or bool(base_held) == observed.get("is_held")
    if intent.get("status") == "prepared" and actual == base and base_matches:
        # 서버 호출 전에 죽은 write-ahead는 명령을 재생하지 않고 확정 거절로 닫는다.
        return "rejected"
    return "superseded"


def _settle_missing_local_target(
    intent: Mapping[str, Any],
    claim_token: str,
    observed: Mapping[str, Any],
    *,
    status: str,
    ambiguous: bool = False,
) -> str:
    """대상 부재를 경합과 분리해 재시도하거나 관측값만 기록하고 종결한다.

    ``status`` 는 호출자가 이 관측으로 정한 종결 상태다(적용이 됐다면 썼을 그 값 — 두 길이 같은 이름으로 닫히게)."""
    if intent.get("local_id"):
        # 기존 로컬 행은 계정 DB 전환·일시 유실일 수 있어 정해진 횟수만 복구를 기다린다.
        if int(intent.get("fail_streak") or 0) < _LOCAL_TARGET_LOST_RETRY_LIMIT:
            transitioned = repo.transition_share_state_intent(
                intent["intent_id"],
                intent["intent_seq"],
                claim_token,
                "waiting_local",
                observed_state=observed,
                next_retry_at=_next_retry_at(int(intent.get("fail_streak") or 0)),
                last_error_code="local_target_lost",
                increment_fail_streak=True,
            )
            return (
                "waiting_local"
                if transitioned
                else repo.SHARE_STATE_APPLY_CAS_LOST
            )
        terminal_status = "rejected"
        error_code = "local_target_lost"
    else:
        terminal_status = status
        if ambiguous:
            error_code = "local_target_ambiguous"
        elif terminal_status == "converged":
            error_code = "local_mirror_skipped_no_target"
        elif observed.get("unknown_watch_expired") is True:
            error_code = "remote_result_unknown_expired"
        else:
            error_code = "local_target_missing"

    transitioned = repo.transition_share_state_intent(
        intent["intent_id"],
        intent["intent_seq"],
        claim_token,
        terminal_status,
        observed_state=observed,
        last_error_code=error_code,
    )
    return terminal_status if transitioned else repo.SHARE_STATE_APPLY_CAS_LOST


async def _apply_or_retry(
    intent: Mapping[str, Any],
    claim_token: str,
    observed: Mapping[str, Any],
    *,
    status: str,
    link_job_id: str | None = None,
    held_anchors: tuple[str, ...] | None = None,
) -> str:
    try:
        result = await asyncio.to_thread(
            _apply_observed_local,
            intent,
            claim_token,
            observed,
            status=status,
            link_job_id=link_job_id,
            held_anchors=held_anchors,
        )
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 — 로컬 장애는 원장을 남겨 다음 사이클에서 재시도한다.
        result = None
    if result == repo.SHARE_STATE_APPLY_APPLIED:
        return status
    if result == repo.SHARE_STATE_APPLY_CAS_LOST:
        # 새 의도나 다른 claim이 이긴 정상 경합이다. 낡은 워커가 실패 횟수를 올리지 않는다.
        return repo.SHARE_STATE_APPLY_CAS_LOST
    if result == repo.SHARE_STATE_APPLY_KEY_NOT_HELD:
        # 잠금을 정한 뒤에 로컬 대상이 바뀌었다 — 닫지 않고, 다음에 그 행의 키까지 쥐고 다시 본다.
        await asyncio.to_thread(
            _mark_retry,
            intent,
            claim_token,
            error_code="local_target_key_not_held",
            waiting_local=False,
        )
        return "retry"
    if result in (repo.SHARE_STATE_APPLY_NO_TARGET, repo.SHARE_STATE_APPLY_AMBIGUOUS):
        return await asyncio.to_thread(
            functools.partial(
                _settle_missing_local_target,
                intent,
                claim_token,
                observed,
                status=status,
                ambiguous=result == repo.SHARE_STATE_APPLY_AMBIGUOUS,
            )
        )
    await asyncio.to_thread(
        _mark_retry,
        intent,
        claim_token,
        error_code="local_mirror_failed",
        waiting_local=True,
    )
    return "waiting_local"


async def _process_composite_partial(
    intent: Mapping[str, Any],
    claim_token: str,
    server_origin: str,
    token: str,
    observed: dict[str, Any],
    held_anchors: tuple[str, ...] | None = None,
) -> str:
    apply = functools.partial(_apply_or_retry, intent, claim_token, held_anchors=held_anchors)
    if observed.get("is_final"):
        return await apply(observed, status="converged")

    if bool(intent.get("base_shared")):
        # 원래 공유였던 항목은 공유를 유지하고 실패한 final 의도만 포기한다.
        return await apply(observed, status="rejected")

    if observed.get("shared"):
        # 정리 직전 재관측: 그 사이 다른 세션이 골드로 만들었다면 unpublish하지 않는다.
        observed = await asyncio.to_thread(
            _observe_remote_state, server_origin, token, intent
        )
        if observed.get("is_final"):
            return await apply(observed, status="converged")
        if observed.get("shared"):
            observed = await asyncio.to_thread(
                _unpublish_remote, server_origin, token, intent
            )
    # 원래 비공유였던 합성 요청은 골드 실패 시 새로 생긴 공유 노출까지 정리하고 거절로 닫는다.
    return await apply(observed, status="rejected")


async def _process_claimed_intent(
    intent: Mapping[str, Any],
    claim_token: str,
    server_origin: str,
    token: str,
    observed: dict[str, Any],
) -> str:
    identity_key = repo.share_state_identity_key(
        server_origin,
        server_generation_id=intent.get("server_generation_id"),
        job_anchor=intent.get("job_anchor"),
    )
    # 한 생성물을 부르는 이름은 여럿이다 — 팀 카드 쪽 조작은 서버 행의 id 로, 내 작업 쪽 조작은 로컬 행의 job_id(없으면 id)로
    # 서버에 부르고 그 이름으로 잠근다. 원장의 키 하나만 쥐면 다른 이름으로 끝난 조작을 낡은 관측으로 덮을 수 있다(그 조작은
    # 다른 원장의 seq 를 올리므로 이 원장의 CAS 가 못 막는다). 그래서 이름을 모두 쥔다: 원장의 원격 id · 관측한 서버 행의
    # id(팀 카드 쪽 이름) · 지금 적용하면 닿을 로컬 행의 이름(내 작업 쪽 이름). Codex 2·3차 검토 P2.
    link_job_id = _link_job_id(intent, observed)
    route_anchor = await asyncio.to_thread(
        repo.share_state_local_route_anchor, intent, link_job_id
    )
    held = tuple(
        dict.fromkeys(
            name
            for name in (
                _remote_id(intent),
                str(observed.get("id") or "").strip(),
                route_anchor,
            )
            if name
        )
    )
    lock_keys = [identity_key] + [
        repo.share_state_identity_key(server_origin, job_anchor=name) for name in held
    ]
    async with repo.async_share_state_action_locks(lock_keys):
        try:
            if len(held) > 1:
                # 묶음 관측은 원장의 키만 쥔 채 한 것이다. 이름이 둘 이상이면 모두 쥔 지금 다시 본 값만 판정과 적용에 쓴다.
                # 이름이 하나뿐인 생성물은 그 키의 조작이 곧 이 원장의 새 seq 라, 전처럼 CAS 가 낡은 관측을 막는다.
                observed = await asyncio.to_thread(
                    _observe_remote_state, server_origin, token, intent
                )
                link_job_id = _link_job_id(intent, observed)
            prior_observed = _observed_payload(intent)
            composite_partial = bool(
                intent.get("operation_kind") == "composite_finalize"
                and intent.get("desired_final")
                and prior_observed.get("publish_confirmed") is True
            )
            if composite_partial:
                return await _process_composite_partial(
                    intent, claim_token, server_origin, token, observed, held
                )
            unknown = _result_unknown(intent)
            # 기한으로 닫기로 한 원장이 로컬 대상을 기다리다 돌아왔다 — 그 기록과 종결 이름의 규칙을 이어 간다.
            expired = prior_observed.get("unknown_watch_expired") is True
            if expired:
                observed = {**observed, "unknown_watch_expired": True}
            if unknown or expired:
                # 인증 대기·로컬 대상 대기를 거쳐 상태 이름이 바뀌었어도 판정은 결과 불명(prepared)의 규칙으로 한다.
                status = _terminal_status({**intent, "status": "prepared"}, observed)
            else:
                status = _terminal_status(intent, observed)
            if unknown:
                if status != "converged":
                    if not _unknown_watch_expired(intent):
                        # '아직 바라던 상태가 아니다'는 '요청이 거절됐다'도 '다른 조작이 덮었다'도 아니다. 전에는 첫 관측에
                        # rejected(이전 상태)·superseded(그 밖)로 닫아, 서버가 그 뒤에 적용한 최종·보류를 영영 놓쳤다
                        # (실패로 안내 → 서버에는 적용 → 로컬 행은 그대로. 2026-10-14 격리 실측). 결과 불명으로 두고 다시 본다.
                        kept = await asyncio.to_thread(
                            _keep_watching, intent, claim_token, observed
                        )
                        return "retry" if kept else repo.SHARE_STATE_APPLY_CAS_LOST
                    # 지켜볼 만큼 지켜봤다 — 서버의 지금 상태를 로컬에 맞추고 전과 같은 이름으로 닫는다(이전 상태면
                    # rejected, 그 밖이면 superseded. 명령은 다시 보내지 않는다). 기한으로 닫았다는 표식을 남긴다.
                    observed = {**observed, "unknown_watch_expired": True}
                # 서버가 (늦게라도) 받아들였거나 기한이 찼다. 여기서부터는 로컬에 맞추는 길이다 — pending 으로 올리고
                # 다시 보던 횟수를 비운다(로컬 대상 유실의 재시도 예산이 그 횟수에 깎이지 않게).
                moved = await asyncio.to_thread(
                    functools.partial(
                        repo.transition_share_state_intent,
                        intent["intent_id"],
                        intent["intent_seq"],
                        claim_token,
                        "pending",
                        observed_state=dict(observed),
                        reset_fail_streak=True,
                    )
                )
                if not moved:
                    return repo.SHARE_STATE_APPLY_CAS_LOST
                intent = {**intent, "status": "pending", "fail_streak": 0}
            return await _apply_or_retry(
                intent,
                claim_token,
                observed,
                status=status,
                link_job_id=link_job_id,
                held_anchors=held,
            )
        except asyncio.CancelledError:
            raise
        except _RemoteAuthRequired:
            await asyncio.to_thread(
                functools.partial(
                    repo.transition_share_state_intent,
                    intent["intent_id"],
                    intent["intent_seq"],
                    claim_token,
                    "auth_required",
                    **_auth_required_fields(intent),
                )
            )
            return "auth_required"
        except _RemoteObservationError as exc:
            await asyncio.to_thread(
                _mark_retry,
                intent,
                claim_token,
                error_code=exc.error_code,
                waiting_local=False,
            )
            return "retry"
        except Exception:  # noqa: BLE001 — 한 행의 결함이 같은 사이클의 나머지를 막지 않는다.
            await asyncio.to_thread(
                _mark_retry,
                intent,
                claim_token,
                error_code="reconcile_internal_error",
                waiting_local=False,
            )
            log_event(
                _log,
                "share_state_intent_failed",
                level=logging.WARNING,
                intent_id=intent.get("intent_id"),
                exc_info=True,
            )
            return "retry"


async def run_share_state_reconciliation_cycle(
    claim_token: str | None = None,
) -> dict[str, int]:
    """due 원장 한 묶음을 실제 sleep 없이 한 번 처리한다(서비스 테스트 진입점)."""
    counts: dict[str, int] = {"claimed": 0}
    account_key = await asyncio.to_thread(active_account.account_key)
    account_override = active_account.set_override(account_key or "")
    try:
        # 계정 전환이 시작돼도 이 사이클은 캡처한 DB·서버·토큰 조합만 사용한다.
        proxy_context = await asyncio.to_thread(_proxy_context)
        if proxy_context is None:
            return counts
        server_origin, token = proxy_context
        worker_token = claim_token or f"share-state-{uuid.uuid4().hex}"
        claimed = await asyncio.to_thread(
            functools.partial(
                repo.claim_due_share_state_intents,
                worker_token,
                limit=_BATCH_LIMIT,
                lease_seconds=_LEASE_SECONDS,
                # 현 권위 서버 행만 claim(R5 2-A) — 다른 서버의 오래된 due 가 batch 창을
                # 채워 현재 서버 행이 굶던 starvation 제거. 아래 origin-mismatch 분기는
                # 최후 방어선으로 유지한다.
                server_origin=server_origin,
            )
        )
        counts["claimed"] = len(claimed)
        processable: list[dict[str, Any]] = []
        for intent in claimed:
            if intent.get("server_origin") != server_origin:
                # 다른 권위 서버의 행에는 상태 판정·HTTP를 하지 않는다. claim만 즉시 돌려준다.
                await asyncio.to_thread(
                    repo.release_share_state_intent_claim,
                    intent["intent_id"],
                    intent["intent_seq"],
                    worker_token,
                )
                log_event(
                    _log,
                    "share_state_origin_mismatch",
                    level=logging.WARNING,
                    intent_id=intent.get("intent_id"),
                )
                counts["origin_mismatch"] = counts.get("origin_mismatch", 0) + 1
                continue
            processable.append(intent)

        if processable:
            identity_keys = [
                repo.share_state_identity_key(
                    server_origin,
                    server_generation_id=intent.get("server_generation_id"),
                    job_anchor=intent.get("job_anchor"),
                )
                for intent in processable
            ]
            try:
                # 관측 한 번 동안 대상 key를 모두 잠근다. 이후 항목별 재잠금 전에 사용자 액션이
                # 끼면 새 intent_seq가 생겨 아래 로컬 apply CAS가 낡은 관측을 거절한다.
                async with repo.async_share_state_action_locks(identity_keys):
                    observed_by_intent = await asyncio.to_thread(
                        _observe_remote_states, server_origin, token, processable
                    )
            except asyncio.CancelledError:
                raise
            except _RemoteAuthRequired:
                for intent in processable:
                    await asyncio.to_thread(
                        functools.partial(
                            repo.transition_share_state_intent,
                            intent["intent_id"],
                            intent["intent_seq"],
                            worker_token,
                            "auth_required",
                            **_auth_required_fields(intent),
                        )
                    )
                counts["auth_required"] = len(processable)
                observed_by_intent = {}
            except _RemoteObservationError as exc:
                for intent in processable:
                    await asyncio.to_thread(
                        _mark_retry,
                        intent,
                        worker_token,
                        error_code=exc.error_code,
                        waiting_local=False,
                    )
                counts["retry"] = len(processable)
                observed_by_intent = {}
            except Exception:  # noqa: BLE001 — batch 관측 결함도 원장 상태를 보존하고 재시도한다.
                for intent in processable:
                    try:
                        await asyncio.to_thread(
                            _mark_retry,
                            intent,
                            worker_token,
                            error_code="reconcile_internal_error",
                            waiting_local=False,
                        )
                    except Exception:  # noqa: BLE001 — DB 자체 장애면 lease 만료가 마지막 안전망이다.
                        pass
                log_event(
                    _log,
                    "share_state_observation_failed",
                    level=logging.WARNING,
                    exc_info=True,
                )
                counts["failed"] = len(processable)
                observed_by_intent = {}

        for intent in processable:
            observed = observed_by_intent.get(str(intent["intent_id"]))
            if observed is None:
                continue
            try:
                renewed = await asyncio.to_thread(
                    repo.renew_share_state_intent_lease,
                    intent["intent_id"],
                    intent["intent_seq"],
                    worker_token,
                    lease_seconds=_LEASE_SECONDS,
                )
                if not renewed:
                    # 관측 락 해제 후 새 intent_seq 가 이긴 행(R5 reconciler-2) — 종전엔
                    # 여기서도 진행해 stale worker 가 composite partial 의 원격 unpublish
                    # 까지 실행한 뒤에야 로컬 CAS 에서 졌다. ★계약의 정확한 범위: batch
                    # '관측'(read-only GET)은 renew 이전 단계라 이미 수행됐고, 여기서
                    # 차단하는 것은 원격 '변경'(unpublish)·로컬 전이·이후 처리 전부다.
                    counts["cas_lost"] = counts.get("cas_lost", 0) + 1
                    continue
                result = await _process_claimed_intent(
                    intent, worker_token, server_origin, token, observed
                )
                counts[result] = counts.get(result, 0) + 1
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — 한 행의 DB 장애가 뒤 항목까지 막지 않는다.
                log_event(
                    _log,
                    "share_state_claim_failed",
                    level=logging.WARNING,
                    intent_id=intent.get("intent_id"),
                    exc_info=True,
                )
                counts["failed"] = counts.get("failed", 0) + 1
        if claimed:
            log_event(_log, "share_state_reconcile_cycle", counts=counts)
        return counts
    finally:
        active_account.reset_override(account_override)


class PeriodicShareStateReconciler:
    def __init__(self, interval: float = _INTERVAL_SECONDS) -> None:
        self._interval = interval
        self._task: Optional[asyncio.Task[None]] = None
        self._event = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._worker_token = f"share-state-worker-{uuid.uuid4().hex}"

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._loop = asyncio.get_running_loop()
            # lifespan/TestClient가 새 이벤트 루프로 다시 시작돼도 옛 loop에 묶인 Event를 재사용하지 않는다.
            self._event = asyncio.Event()
            self._task = asyncio.create_task(
                self._run(), name="share-state-reconciler"
            )

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        self._loop = None

    def kick(self) -> None:
        """동기 FastAPI 라우트의 threadpool에서도 안전하게 워커를 깨운다."""
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._event.set)

    async def _run(self) -> None:
        while True:
            try:
                await run_share_state_reconciliation_cycle(self._worker_token)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — 주기 워커 자체는 다음 폴링에서 회복한다.
                log_event(
                    _log,
                    "share_state_reconcile_loop_failed",
                    level=logging.WARNING,
                    exc_info=True,
                )
            try:
                await asyncio.wait_for(self._event.wait(), timeout=self._interval)
            except TimeoutError:
                pass
            self._event.clear()


periodic_share_state_reconciler = PeriodicShareStateReconciler()


def kick_share_state_reconciler() -> None:
    periodic_share_state_reconciler.kick()
