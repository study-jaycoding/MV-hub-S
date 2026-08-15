"""ComfyUI 통합 라우터 — 캔버스 Comfy 노드가 쓰는 연결 설정·파싱·실행.

로컬 우선 모델: ComfyUI 는 각 작업자 PC 의 로컬(또는 그 계정의 Cloud) 자원이라, 이 라우터는
공유 서버로 위임하지 않고 항상 로컬 허브에서 실행된다(_proxy._LOCAL_PREFIXES 에 /api/comfy 등록).

Phase 1: Comfy 노드 '단독 실행' — 워크플로우에 박힌 입력 + 노출 파라미터 override.
Phase 2a: 연결된 레퍼런스(이미지·영상)를 타입별로 LoadImage/LoadVideo 슬롯에 자동 주입 —
  연결 개수만큼 슬롯을 채우고 미사용 슬롯은 노드째 prune(원본 입력이 결과에 섞이는 것 방지).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from .. import rbac, repo
from ..config import AUTH_ENABLED, DEFAULT_WORKER_ID, MANAGE_ENABLED, MEDIA_DIR
from ..deps import (
    account_actor_uid,
    can_view_generation,
    require_agent_account,
    require_project_role,
)
from ..services import comfy_client, comfy_workflow, video_convert
from ..services.release_update import update_in_progress
from ..services.request_guards import require_loopback_request

log = logging.getLogger("comfy")


def _require_local_comfy(request: Request) -> None:
    """Comfy 실행·설정·파싱은 로컬 허브(loopback) 전용. 공유 서버(AUTH on)에서 LAN/원격 사용자가
    서버를 시켜 임의 comfy_url 로 요청(SSRF)하거나, 서버 단일 DB 에 저장된 '남의 키'를 /run 으로
    대신 쓰는 것을 막는다. 로컬 허브는 AUTH off + 127.0.0.1 바인드라 그대로 통과한다
    (설계상 Comfy 는 각자 자기 로컬에서 자기 키로 사용 — 팀 서버엔 Comfy 를 공유하지 않는다)."""
    if AUTH_ENABLED:
        require_loopback_request(request, "Comfy 기능은 로컬 허브에서만 사용할 수 있습니다")


# 라우터 전체에 로컬 게이트 — 모든 /api/comfy/* 가 공유 서버 원격에서 차단된다(프록시는 로컬 위임).
router = APIRouter(prefix="/api/comfy", tags=["comfy"], dependencies=[Depends(_require_local_comfy)])

# app_setting 키 — 이 PC 로컬 DB 에만 저장되는 ComfyUI 연결 정보.
_K_URL = "comfy_url"
_K_TARGET = "comfy_target"          # "local" | "cloud"
_K_API_KEY = "comfy_api_key"
_K_CONCURRENCY = "comfy_concurrency"
_K_INPUT_DIR = "comfy_input_dir"
# 제출은 됐지만 아직 이 프로세스가 결과를 회수하지 못한 잡. app_setting 은 이 PC 로컬 DB라
# 별도 파일 경로·권한 문제 없이 재시작 흔적을 남길 수 있다(키·워크플로우는 저장하지 않는다).
_K_INFLIGHT_RUNS = "comfy_inflight_runs"

_DEFAULT_URL = (os.environ.get("CONTENT_HUB_COMFY_URL") or "http://127.0.0.1:8188").rstrip("/")
_MASK = "***"

# 단독 실행 폴링
def _env_int(name: str, default: int, minimum: int = 1) -> int:
    """env 정수 파싱 — 비숫자/빈값이면 기본값, 최소값 아래면 클램프(잘못된 env 로 import 크래시 방지)."""
    try:
        v = int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default
    return max(minimum, v)


_JOB_TIMEOUT = _env_int("CONTENT_HUB_COMFY_TIMEOUT_SEC", 60 * 30, minimum=30)  # 기본 30분(env 로 조정)
_POLL_LOCAL = 2.0
_POLL_CLOUD = 4.0
_CLOUD_UNKNOWN_GRACE = 90  # 알 수 없는 Cloud 상태가 이 시간(초) 넘게 지속되면 실패(형식 어긋남 조기 진단)
# 일시적인 Comfy 재시작/프록시 연결 끊김이 30분 전체 실행 실패가 되지 않게 한다. N번째 연속
# 오류에서만 실패하며, 그 전에는 폴링 간격을 지수 백오프로 늘려 서버에 재접속 폭주도 막는다.
_POLL_ERROR_RETRY_LIMIT = _env_int("CONTENT_HUB_COMFY_POLL_ERROR_RETRIES", 5)
_POLL_ERROR_BACKOFF_MAX_SEC = 30.0

# ── 비동기 실행 잡 스토어 ─────────────────────────────────────────────────────
# /run 이 긴 HTTP 연결을 붙잡던 구조(제출→폴링→다운로드)를 백그라운드 스레드로 분리한다.
# 배치 병렬 시 긴 연결이 끊겨 프론트가 'Failed to fetch' 로 오판하던 문제를 없앤다.
# 프로세스 메모리 상주(재시작 시 소실) — 이 PC 로컬 허브 전용이라 허용.
_RUN_JOB_TTL_SEC = _env_int("CONTENT_HUB_COMFY_RUN_JOB_TTL_SEC", 60 * 60, minimum=300)
_RUN_ACTIVE_JOB_TTL_SEC = max(_JOB_TIMEOUT + 600, _RUN_JOB_TTL_SEC)

_RUN_PENDING = "pending"
_RUN_RUNNING = "running"
_RUN_DONE = "done"
_RUN_FAILED = "failed"

_RUN_JOBS_LOCK = threading.Lock()
_RUN_JOBS: dict[str, dict[str, Any]] = {}
_RUN_PERSIST_LOCK = threading.Lock()


def active_run_job_count() -> int:
    """업데이트 안전 게이트가 확인할 현재 Comfy 실행 수."""
    with _RUN_JOBS_LOCK:
        _sweep_run_jobs_locked()
        return sum(
            1
            for job in _RUN_JOBS.values()
            if job.get("state") in (_RUN_PENDING, _RUN_RUNNING)
        )

# ── 동시 실행 게이트 ──────────────────────────────────────────────────────────
# comfy_concurrency 설정만큼만 동시에 제출·폴링하도록 워커 스레드를 대기시킨다.
# (배치 병렬 시 클라우드 동시성 한도(5) 초과로 429 나는 것 방지. capacity 는 실행 시점 설정값.)
_RUN_GATE = threading.Condition()
_RUN_SLOTS_ACTIVE = 0


def _acquire_run_slot(capacity: int, job_id: Optional[str] = None) -> None:
    global _RUN_SLOTS_ACTIVE
    cap = max(1, capacity)
    with _RUN_GATE:
        while _RUN_SLOTS_ACTIVE >= cap:
            # 유한 대기 + 하트비트 — 큰 배치의 후순위 잡이 슬롯을 기다리는 동안에도
            # updated_at 이 갱신돼, 살아 있는 대기 잡이 스윕으로 증발하지 않는다.
            _RUN_GATE.wait(timeout=30.0)
            if job_id:
                _update_run_job(job_id)
        _RUN_SLOTS_ACTIVE += 1


def _release_run_slot() -> None:
    global _RUN_SLOTS_ACTIVE
    with _RUN_GATE:
        _RUN_SLOTS_ACTIVE = max(0, _RUN_SLOTS_ACTIVE - 1)
        # 설정별 cap 이 다른 대기자가 섞일 수 있다. 하나만 깨우면 아직 cap 미달인 대기자를
        # 깨워 다시 재우고, 이미 들어갈 수 있는 대기자는 30초 timeout 까지 놓칠 수 있다.
        _RUN_GATE.notify_all()


def _sweep_run_jobs_locked(now: Optional[float] = None) -> None:
    """접근 시 오래된 job 제거. 별도 timer thread 는 두지 않는다(락 안에서 호출)."""
    now = time.time() if now is None else now
    stale: list[str] = []
    for job_id, job in _RUN_JOBS.items():
        state = job.get("state")
        if state in (_RUN_DONE, _RUN_FAILED):
            base = job.get("finished_at") or job.get("updated_at") or job.get("created_at") or now
            ttl = _RUN_JOB_TTL_SEC
        else:
            # 활성 잡은 '마지막 하트비트' 기준. created_at 기준이면 큰 배치의 후순위 잡이
            # 큐 대기시간 때문에 실행 도중 스윕돼 결과가 증발했다(크레딧은 소모된 채 404).
            # 워커가 대기/폴링 중 주기적으로 updated_at 을 갱신하므로, 살아 있는 잡은 절대
            # 안 걸리고 죽은 스레드의 잔재만 TTL 뒤 정리된다.
            base = job.get("updated_at") or job.get("created_at") or now
            ttl = _RUN_ACTIVE_JOB_TTL_SEC
        if now - float(base) > ttl:
            stale.append(job_id)
    for job_id in stale:
        _RUN_JOBS.pop(job_id, None)


def _create_run_job() -> str:
    now = time.time()
    job_id = uuid.uuid4().hex
    with _RUN_JOBS_LOCK:
        _sweep_run_jobs_locked(now)
        _RUN_JOBS[job_id] = {
            "state": _RUN_PENDING,
            "created_at": now,
            "updated_at": now,
            "finished_at": None,
            "result": None,
            "error": None,
            "code": None,
            "auth_error": False,
            "prompt_id": None,
            "cancel_attempted": False,
        }
    return job_id


def _update_run_job(job_id: str, **updates: Any) -> None:
    with _RUN_JOBS_LOCK:
        job = _RUN_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = time.time()


def _finish_run_job(job_id: str, result: dict) -> None:
    now = time.time()
    with _RUN_JOBS_LOCK:
        job = _RUN_JOBS.get(job_id)
        if not job:
            return
        job.update({
            "state": _RUN_DONE, "updated_at": now, "finished_at": now,
            "result": result, "prompt_id": result.get("prompt_id"),
        })
    _forget_inflight_run(job_id)


def _fail_run_job(job_id: str, code: int, detail: Any) -> None:
    now = time.time()
    error = detail if isinstance(detail, str) else str(detail)
    with _RUN_JOBS_LOCK:
        job = _RUN_JOBS.get(job_id)
        if not job:
            return
        job.update({
            "state": _RUN_FAILED, "updated_at": now, "finished_at": now,
            "error": error, "code": code, "auth_error": code == 402,
        })
    _forget_inflight_run(job_id)


def _stored_inflight_runs_locked() -> list[dict[str, Any]]:
    """app_setting JSON 을 읽어 최소 필드가 있는 항목만 되돌린다(_RUN_PERSIST_LOCK 보유 전제)."""
    raw = repo.get_setting(_K_INFLIGHT_RUNS) or "[]"
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        log.warning("comfy in-flight 영속 저장 형식이 손상돼 비웁니다")
        return []
    if not isinstance(value, list):
        log.warning("comfy in-flight 영속 저장 형식이 목록이 아니어서 비웁니다")
        return []
    return [
        item for item in value
        if isinstance(item, dict)
        and isinstance(item.get("job_id"), str)
        and isinstance(item.get("prompt_id"), str)
        and item.get("target") in ("local", "cloud")
    ]


def _write_inflight_runs_locked(runs: list[dict[str, Any]]) -> None:
    """작은 JSON 목록 전체를 원자적으로 교체한다(_RUN_PERSIST_LOCK 보유 전제)."""
    repo.set_setting(
        _K_INFLIGHT_RUNS,
        json.dumps(runs, ensure_ascii=False, separators=(",", ":")),
    )


def _track_inflight_run(job_id: str, prompt_id: str, target_kind: str) -> None:
    """원격 제출 성공 직후 재시작 진단용 최소 흔적을 남긴다.

    ★best-effort — 이 기록이 실패해도(순간 DB 잠금 등) 호출부는 실행을 계속한다.
    이미 제출·과금된 멀쩡한 잡을 진단 기록 실패 때문에 취소하면 손해가 더 크다.
    잃는 것은 '재시작 시 이 잡의 흔적 로그·Cloud 취소' 뿐이다.
    """
    record = {
        "job_id": job_id,
        "prompt_id": prompt_id,
        "target": "cloud" if target_kind == "cloud" else "local",
        "created_at": time.time(),
    }
    with _RUN_PERSIST_LOCK:
        runs = [r for r in _stored_inflight_runs_locked() if r["job_id"] != job_id]
        runs.append(record)
        _write_inflight_runs_locked(runs)


def _forget_inflight_run(job_id: str) -> None:
    """완료/실패가 확정된 잡의 재시작 흔적을 best-effort 로 제거한다."""
    try:
        with _RUN_PERSIST_LOCK:
            runs = _stored_inflight_runs_locked()
            kept = [r for r in runs if r["job_id"] != job_id]
            if len(kept) != len(runs):
                _write_inflight_runs_locked(kept)
    except Exception as e:  # noqa: BLE001 — 이미 끝난 실행 결과를 영속 정리 실패로 뒤집지 않는다.
        log.warning("comfy in-flight 영속 정리 실패 job_id=%s: %s", job_id, e)


def _raw_settings() -> dict:
    """내부용 — 실제 api_key 포함(실행에 사용)."""
    return {
        "comfy_url": (repo.get_setting(_K_URL) or _DEFAULT_URL).rstrip("/"),
        "comfy_target": repo.get_setting(_K_TARGET) or "local",
        "comfy_api_key": repo.get_setting(_K_API_KEY) or "",
        "comfy_concurrency": _to_int(repo.get_setting(_K_CONCURRENCY), 3),
        "comfy_input_dir": repo.get_setting(_K_INPUT_DIR) or "",
    }


def _cancel_remote_run(target: dict, prompt_id: str, reason: str,
                       job_id: Optional[str] = None) -> None:
    """실패 뒤 원격 잡을 best-effort 로 멈춘다.

    Cloud·로컬 모두 **지정 prompt 를 대기열에서 삭제**(/queue delete)만 한다 — 로컬의
    blanket interrupt 는 '현재 실행 중'을 멈추는데 그게 우리 다른 배치 잡이거나 사용자가
    ComfyUI 로 직접 돌리는 작업일 수 있어 표적 없는 중단은 피해가 더 크다. 이미 실행에
    들어간 로컬 프롬프트는 끝까지 돌게 둔다(로컬은 크레딧 소모가 없다). 동일 잡의
    타임아웃→worker 실패 경로가 두 번 취소하지 않도록 메모리 잡에 시도 표식을 남긴다.
    취소 실패는 원래 실행 오류보다 우선하지 않는다.
    """
    if not prompt_id:
        return
    if job_id:
        with _RUN_JOBS_LOCK:
            job = _RUN_JOBS.get(job_id)
            if job:
                if job.get("cancel_attempted"):
                    return
                job["cancel_attempted"] = True
                job["updated_at"] = time.time()
    try:
        if target.get("cloud"):
            comfy_client.cloud_cancel_pending(target, prompt_id)
        else:
            # ★로컬은 대기열에서 이 prompt 만 지운다(/queue delete 는 로컬도 지원).
            #  블랭킷 interrupt 는 '현재 실행 중'을 멈추는데, 배치에서는 그게 우리 다른
            #  잡이거나 사용자가 ComfyUI 로 직접 돌리는 작업일 수 있다 — 표적 없는 중단은
            #  피해가 더 크다(통합 검토에서 완화). 이미 실행에 들어간 프롬프트는 그냥
            #  끝까지 돌게 둔다(로컬은 크레딧 소모가 없어 낭비도 전기값뿐).
            comfy_client.cloud_cancel_pending(target, prompt_id)
    except Exception as e:  # noqa: BLE001 — 취소 실패가 원래 실패를 가리면 안 된다.
        log.warning(
            "comfy 원격 잡 취소 실패 target=%s prompt_id=%s reason=%s: %s",
            "cloud" if target.get("cloud") else "local", prompt_id, reason, e,
        )


def _cancel_failed_run(settings: dict, job_id: str, reason: str) -> None:
    """worker 에서 실패가 확정되기 전, 제출 완료된 prompt 만 취소한다."""
    with _RUN_JOBS_LOCK:
        job = _RUN_JOBS.get(job_id)
        prompt_id = str(job.get("prompt_id") or "") if job else ""
    if not prompt_id:
        return
    try:
        _cancel_remote_run(comfy_client.make_target(settings), prompt_id, reason, job_id)
    except Exception as e:  # noqa: BLE001 — settings 손상 등도 실행 실패를 덮지 않게 한다.
        log.warning("comfy 원격 잡 취소 준비 실패 job_id=%s: %s", job_id, e)


def recover_interrupted_run_jobs() -> None:
    """부팅 시 이전 프로세스의 in-flight 흔적을 운영 로그로 남기고 비운다.

    풀 자동복구는 하지 않는다. 특히 Cloud 는 현재 저장된 API 키로 지정 prompt 취소를 한 번
    시도해 재시작 뒤의 크레딧 누수를 줄인다. 키가 바뀌었거나 완료된 잡이면 실패/거절도 로그만
    남기고, 이 PC는 더 이상 그 잡을 추적하지 않는다는 사실을 명확히 한다.
    """
    try:
        with _RUN_PERSIST_LOCK:
            runs = _stored_inflight_runs_locked()
    except Exception as e:  # noqa: BLE001 — 재시작 정리 실패가 서버 부팅을 막으면 안 된다.
        log.warning("comfy in-flight 재시작 정리 조회 실패: %s", e)
        return

    try:
        for run in runs:
            job_id = run["job_id"]
            prompt_id = run["prompt_id"]
            target_kind = run["target"]
            log.warning(
                "comfy 서버 재시작으로 추적이 끊긴 잡 job_id=%s prompt_id=%s target=%s "
                "(결과는 ComfyUI 히스토리에서 수동 확인 필요)",
                job_id, prompt_id, target_kind,
            )
            if target_kind == "cloud":
                # 당시 키는 보관하지 않는다. 현재 Cloud 키로만 취소를 시도한다(없거나 바뀌면 로그만).
                try:
                    settings = _raw_settings()
                    settings["comfy_target"] = "cloud"
                    _cancel_remote_run(comfy_client.make_target(settings), prompt_id, "server restart")
                except Exception as e:  # noqa: BLE001 — 한 항목 오류가 다른 Cloud 취소를 막지 않게 한다.
                    log.warning("comfy 재시작 Cloud 취소 준비 실패 prompt_id=%s: %s", prompt_id, e)
    finally:
        # 이 라이트 버전은 재연결/결과 수집을 하지 않는다. 같은 흔적을 다음 부팅마다 반복하지 않게
        # 취소 성공 여부와 무관하게 비운다.
        try:
            with _RUN_PERSIST_LOCK:
                _write_inflight_runs_locked([])
        except Exception as e:  # noqa: BLE001
            log.warning("comfy in-flight 재시작 정리 저장 실패: %s", e)


def _to_int(v, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _public_settings() -> dict:
    """GET 응답 — api_key 는 마스킹, 저장 여부만 노출."""
    s = _raw_settings()
    return {
        "comfy_url": s["comfy_url"],
        "comfy_target": s["comfy_target"],
        "comfy_api_key": _MASK if s["comfy_api_key"] else "",
        "has_api_key": bool(s["comfy_api_key"]),
        "comfy_concurrency": s["comfy_concurrency"],
        "comfy_input_dir": s["comfy_input_dir"],
    }


class SettingsPatch(BaseModel):
    comfy_url: Optional[str] = None
    comfy_target: Optional[str] = None
    comfy_api_key: Optional[str] = None
    comfy_concurrency: Optional[int] = None
    comfy_input_dir: Optional[str] = None


@router.get("/settings")
def get_settings():
    return _public_settings()


@router.put("/settings")
def put_settings(patch: SettingsPatch):
    if patch.comfy_url is not None:
        url = patch.comfy_url.strip().rstrip("/")
        # 스킴은 http/https 만 허용 — file://·gopher:// 등으로 서버가 임의 자원을 읽는 것 차단(SSRF 방어).
        # (로컬/LAN ComfyUI 는 http 라 정상 통과. 사설 IP 자체는 막지 않는다 — 로컬이 정상 사용처.)
        if url and urlsplit(url).scheme.lower() not in ("http", "https"):
            raise HTTPException(400, "ComfyUI 주소는 http:// 또는 https:// 만 허용됩니다")
        repo.set_setting(_K_URL, url)
    if patch.comfy_target is not None:
        tgt = patch.comfy_target if patch.comfy_target in ("local", "cloud") else "local"
        repo.set_setting(_K_TARGET, tgt)
    # api_key 는 마스킹 에코("***")면 저장하지 않는다(마스크를 실제 값으로 덮어쓰기 방지).
    if patch.comfy_api_key is not None and patch.comfy_api_key != _MASK:
        repo.set_setting(_K_API_KEY, patch.comfy_api_key.strip())
    if patch.comfy_concurrency is not None:
        n = max(1, min(comfy_client.CLOUD_MAX_CONCURRENCY, _to_int(patch.comfy_concurrency, 3)))
        repo.set_setting(_K_CONCURRENCY, str(n))
    if patch.comfy_input_dir is not None:
        repo.set_setting(_K_INPUT_DIR, patch.comfy_input_dir.strip())
    return _public_settings()


@router.get("/health")
def health():
    target = comfy_client.make_target(_raw_settings())
    return {"alive": comfy_client.check_alive(target), "target": target["base"]}


@router.get("/subscription")
def subscription():
    """Comfy 실행 대상의 크레딧 표시용 정보. Cloud 는 구독 등급(예 'PRO'), 로컬은 tier 없음.
    Comfy Cloud 는 건별 크레딧을 API 로 노출하지 않아(정액 구독제) 등급만 보여준다. best-effort."""
    s = _raw_settings()
    is_cloud = (s.get("comfy_target") or "local") == "cloud"
    tier = None
    if is_cloud:
        try:
            tier = comfy_client.get_subscription_tier(comfy_client.make_target(s))
        except Exception:  # noqa: BLE001 — 조회 실패해도 target 만 반환
            tier = None
    return {"target": "cloud" if is_cloud else "local", "tier": tier}


# ── 파싱: 노출 후보/슬롯 조회 ────────────────────────────────────────────────

class ParseReq(BaseModel):
    content: str                       # API 포맷 워크플로우 JSON 원문
    exposed: Optional[list[str]] = None  # 현재 노출된 "node|field" 목록(체크 표시용)


def _enrich_choices(candidates: list[dict]) -> None:
    """ComfyUI /object_info 의 COMBO 위젯 후보를 candidates 에 채워 dropdown 으로 만든다(best-effort).
    이미 CURATED choices 가 있으면 유지. 서버 꺼짐·미지원이면 조용히 넘어간다(텍스트 폴백).
    class_type 당 1회만 조회(같은 노드종류 여러 필드 공유)."""
    need = {c["class_type"] for c in candidates if not c.get("choices")}
    if not need:
        return
    try:
        target = comfy_client.make_target(_raw_settings())
        full = comfy_client.get_object_info(target)  # 전체 1회(캐시) — cloud 는 개별 조회 불가
    except Exception:  # noqa: BLE001 — 서버 꺼짐·설정 미비 등: 선택지 없이(텍스트) 진행
        return
    combos: dict[str, dict] = {}
    for c in candidates:
        if c.get("choices"):
            continue
        ct = c["class_type"]
        if ct not in combos:
            combos[ct] = comfy_workflow.extract_combo_choices(full, ct)
        ch = combos[ct].get(c["field"])
        if ch:
            c["choices"] = ch


@router.post("/parse")
def parse(req: ParseReq):
    try:
        wf = json.loads(req.content)
        exposed = set(req.exposed or [])
        slots = comfy_workflow.detect_slots(wf, exposed)
        candidates = comfy_workflow.param_candidates(wf, exposed)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(400, f"워크플로우 파싱 실패: {e}")
    _enrich_choices(candidates)  # ComfyUI 위젯 후보를 dropdown 으로(best-effort)
    return {"slots": slots, "candidates": candidates, "node_count": slots["node_count"]}


# ── 실행 ─────────────────────────────────────────────────────────────────────

_MEDIA_EXT_KIND = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
}


def _media_kind(filename: str) -> Optional[str]:
    """파일명 확장자로 미디어 종류 판정. 이미지/영상 확장자만 인정 — 그 외(.txt 등)는 None.
    (SaveText 가 낸 .txt 같은 비미디어 파일을 image 로 잘못 저장하던 문제 방지 — 텍스트는 별도 경로.)"""
    ext = os.path.splitext(filename or "")[1].lower()
    return _MEDIA_EXT_KIND.get(ext)


def _inject_params(wf: dict, param_values: dict[str, Any]) -> None:
    """플랫 {"node|field": value} 를 워크플로우 inputs 에 주입. 원래 값 타입으로 강제."""
    for key, val in (param_values or {}).items():
        nid, sep, field = str(key).partition("|")
        if not sep:
            continue
        node = wf.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or field not in inputs:
            continue  # 존재하지 않는 필드는 새로 만들지 않는다(오래된/잘못된 override 방어)
        cur = inputs[field]
        if isinstance(cur, (list, dict)):
            continue  # wire([id,slot])/구조 입력은 덮어쓰지 않는다(그래프 연결 파손 방지)
        inputs[field] = _coerce(val, cur)


def _coerce(val, like):
    """override 값을 원래 입력값 타입으로 맞춘다(문자열로 온 숫자/불리언 방어)."""
    if isinstance(like, bool):
        return bool(val) if not isinstance(val, str) else val.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(like, int) and not isinstance(like, bool):
        try:
            f = float(val)
            return int(f) if f.is_integer() else like  # 정수칸에 소수가 오면 원값 유지(조용한 절삭 방지)
        except (TypeError, ValueError):
            return like
    if isinstance(like, float):
        try:
            return float(val)
        except (TypeError, ValueError):
            return like
    return val


def _wait(target: dict, prompt_id: str, job_id: Optional[str] = None) -> dict:
    def _heartbeat() -> None:
        # 폴링이 살아 있다는 표식 — 활성 잡 스윕(updated_at 기준)에서 안 걸리게.
        if job_id:
            _update_run_job(job_id)

    def _retry_delay(poll_interval: float, failures: int) -> float:
        return min(poll_interval * (2 ** (failures - 1)), _POLL_ERROR_BACKOFF_MAX_SEC)

    deadline = time.monotonic() + _JOB_TIMEOUT
    if target["cloud"]:
        last = None
        unknown_since = None  # 알 수 없는 상태를 처음 본 시각(grace 초과 시 실패)
        poll_errors = 0
        while True:
            now = time.monotonic()
            if now >= deadline:
                _cancel_remote_run(target, prompt_id, "poll timeout", job_id)
                raise comfy_client.ComfyError(
                    f"타임아웃 ({_JOB_TIMEOUT // 60}분) — 잡이 끝나지 않았습니다 "
                    f"(마지막 상태={last or '(empty)'})")
            try:
                st = comfy_client.cloud_job_status(target, prompt_id)
            except comfy_client.ComfyError as e:
                poll_errors += 1
                if poll_errors >= _POLL_ERROR_RETRY_LIMIT:
                    raise comfy_client.ComfyError(
                        f"Cloud 상태 조회가 {poll_errors}회 연속 실패했습니다: {e}",
                        auth_error=getattr(e, "auth_error", False),
                    ) from e
                delay = _retry_delay(_POLL_CLOUD, poll_errors)
                log.warning(
                    "comfy cloud 상태 조회 일시 오류(%s/%s), %.1f초 뒤 재시도 prompt_id=%s: %s",
                    poll_errors, _POLL_ERROR_RETRY_LIMIT, delay, prompt_id, e,
                )
                _heartbeat()
                time.sleep(delay)
                continue
            poll_errors = 0
            if st != last:
                log.info("comfy cloud job %s status=%s", prompt_id, st or "(empty)")
                last = st
            if st in comfy_client.CLOUD_DONE:
                return comfy_client.cloud_job_detail(target, prompt_id)
            if st in comfy_client.CLOUD_FAIL:
                detail = {}
                try:
                    detail = comfy_client.cloud_job_detail(target, prompt_id)
                except comfy_client.ComfyError:
                    pass
                msg = (comfy_client.cloud_error_message(detail)
                       or f"Cloud 실행 실패 (status={st})")[:400]
                raise comfy_client.ComfyError(
                    f"워크플로우 실행 오류: {msg}",
                    auth_error=comfy_client.looks_like_auth_error(msg))
            # 정상 pending 은 풀 타임아웃까지 대기. 미지/빈 상태가 grace 넘게 지속되면 조기 실패(형식 어긋남 진단).
            if st in comfy_client.CLOUD_PENDING:
                unknown_since = None
            elif unknown_since is None:
                unknown_since = now
            elif now - unknown_since >= _CLOUD_UNKNOWN_GRACE:
                raise comfy_client.ComfyError(
                    f"Cloud 상태를 해석할 수 없습니다 (status={st or '(empty)'}) — "
                    "잡이 제출됐지만 응답 형식/엔드포인트를 확인해야 할 수 있습니다")
            _heartbeat()
            time.sleep(_POLL_CLOUD)

    entry = None
    poll_errors = 0
    while time.monotonic() < deadline:
        try:
            entry = comfy_client.get_history(target, prompt_id)
        except comfy_client.ComfyError as e:
            poll_errors += 1
            if poll_errors >= _POLL_ERROR_RETRY_LIMIT:
                raise comfy_client.ComfyError(
                    f"로컬 ComfyUI 상태 조회가 {poll_errors}회 연속 실패했습니다: {e}",
                    auth_error=getattr(e, "auth_error", False),
                ) from e
            delay = _retry_delay(_POLL_LOCAL, poll_errors)
            log.warning(
                "comfy local 상태 조회 일시 오류(%s/%s), %.1f초 뒤 재시도 prompt_id=%s: %s",
                poll_errors, _POLL_ERROR_RETRY_LIMIT, delay, prompt_id, e,
            )
            _heartbeat()
            time.sleep(delay)
            continue
        poll_errors = 0
        if entry is not None:
            status = entry.get("status") or {}
            if (comfy_client.history_error(entry) or status.get("completed") is True
                    or status.get("status_str") == "success"
                    or (not status and entry.get("outputs"))):
                break
        _heartbeat()
        time.sleep(_POLL_LOCAL)
    else:
        _cancel_remote_run(target, prompt_id, "poll timeout", job_id)
        raise comfy_client.ComfyError(f"타임아웃 ({_JOB_TIMEOUT // 60}분) — 잡이 끝나지 않았습니다")
    err = comfy_client.history_error(entry)
    if err:
        raise comfy_client.ComfyError(
            f"워크플로우 실행 오류: {err}",
            auth_error=comfy_client.looks_like_auth_error(err))
    return entry


def _prune_node(wf: dict, node_id: str) -> None:
    """노드를 제거하고, 그 노드 출력을 참조하던 입력(배선)도 함께 지운다.
    (레퍼런스 소켓은 선택 입력 — 연결을 끊어야 원본 입력이 결과에 안 섞인다.)"""
    wf.pop(node_id, None)
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        for key in [k for k, v in inputs.items()
                    if isinstance(v, list) and len(v) == 2 and str(v[0]) == node_id]:
            del inputs[key]


def _fill_images(target: dict, wf: dict, slots: list, uploads: list) -> int:
    """이미지 uploads 를 image_slots 에 순서대로 업로드·주입하고, 미사용 슬롯은 prune. 채운 개수 반환."""
    if not uploads:
        return 0
    used = 0
    for slot, (fname, data) in zip(slots, uploads):
        name = comfy_client.upload_bytes(target, fname, data)
        node = wf.get(slot["node_id"])
        if isinstance(node, dict):
            node.setdefault("inputs", {})[slot["field"]] = name
        used += 1
    for slot in slots[used:]:  # 연결 안 된 나머지 슬롯은 노드째 제거(원본이 결과에 섞이는 것 방지)
        _prune_node(wf, slot["node_id"])
    return used


def _fill_videos(target: dict, wf: dict, slots: list, uploads: list, input_dir: str) -> int:
    """영상 uploads 를 video_slots 에 채우고 미사용 슬롯 prune.
    파일 선택형(VHS_LoadVideo 등)은 /upload/image 로 올려 그 이름을 주입.
    경로 입력형(VHS_LoadVideoPath)은 절대경로를 요구 → comfy_input_dir 에 저장해 그 경로를 주입.
    (Cloud 는 로컬 경로를 못 봐 경로형 미지원 → 400.)"""
    if not uploads:
        return 0
    used = 0
    for slot, (fname, data) in zip(slots, uploads):
        node = wf.get(slot["node_id"])
        if not isinstance(node, dict):
            used += 1
            continue
        if slot.get("mode") == "path":
            if target["cloud"] or not input_dir:
                raise HTTPException(
                    400,
                    f"영상 노드({slot['class_type']})가 경로 입력형입니다. "
                    "설정에서 ComfyUI input 폴더를 지정하거나 파일 선택형(VHS_LoadVideo) 노드를 쓰세요.",
                )
            # 파일명은 경로 성분을 제거해 mvhub 폴더 밖으로 못 빠지게 한다(경로 탈출 방어).
            safe = Path(fname).name or "input.bin"
            dest = Path(input_dir) / "mvhub" / safe
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            node.setdefault("inputs", {})[slot["field"]] = str(dest.resolve())
        else:
            if target["cloud"]:
                # Cloud 는 표준 코덱·정상 프레임레이트만 받는다 → 업로드 전에 H.264 MP4 로 자동 변환한다.
                # (ffmpeg 없으면 원본 그대로 — 최선 노력. 변환 실패면 명확한 사유로 502.)
                try:
                    conv = video_convert.to_cloud_mp4(data)
                except video_convert.VideoConvertError as e:
                    raise HTTPException(
                        502,
                        f"입력 영상을 클라우드용(H.264 MP4)으로 변환하지 못했습니다: {e}. "
                        "영상을 표준 MP4로 다시 내보내거나 설정에서 Local 을 쓰세요.",
                    )
                if conv is not data:  # 실제로 변환됐으면 이름도 .mp4 로(클라우드 인식용)
                    data = conv
                    fname = os.path.splitext(fname)[0] + ".mp4"
            name = comfy_client.upload_bytes(target, fname, data)
            node.setdefault("inputs", {})[slot["field"]] = name
        used += 1
    for slot in slots[used:]:
        _prune_node(wf, slot["node_id"])
    return used


def _read_media_uploads(files: list[UploadFile]) -> list[tuple[str, bytes]]:
    """UploadFile 은 응답 후 FastAPI 가 닫을 수 있으므로 request 안에서 bytes 로 고정한다.
    (worker thread 에는 UploadFile 객체가 아니라 (filename, bytes) 만 넘긴다.)"""
    uploads: list[tuple[str, bytes]] = []
    for i, uf in enumerate(files):
        uploads.append((uf.filename or f"input_{i}.bin", uf.file.read()))
    return uploads


def _inject_media_bytes(target: dict, wf: dict, meta: list, uploads: list[tuple[str, bytes]],
                        input_dir: str, job_id: str = "") -> dict:
    """meta[i] 는 uploads[i] 와 순서 대응({type}). 타입별로 분리해 이미지→image_slots,
    영상→video_slots 에 순서대로 채우고 미사용 슬롯 prune. 실제 채운 개수를 반환(표시용).
    잘못된 요청(타입 누락/불일치, 슬롯 초과)은 업로드 전에 400 으로 거부한다."""
    if len(meta) != len(uploads):
        raise HTTPException(400, "media 파일 수와 media_meta 수가 일치하지 않습니다")
    # ★잡별 유일 파일명: 프론트가 주는 이름은 image1.png 식이라 병렬 배치에서 잡 B 의
    #  업로드(overwrite=true)가 잡 A 의 input/mvhub/image1.png 를 덮어써, A 가 B 의
    #  이미지를 입력으로 실행되는 무오류 오답이 났다. 잡 uuid + **업로드 순번** 접두로
    #  잡 간·잡 내(같은 원본 이름 2개 업로드) 충돌을 모두 차단한다
    #  (반환된 이름이 그대로 노드에 주입되므로 이 한 곳이 유일한 관문이다).
    if job_id:
        prefix = job_id[:12]
        uploads = [(f"{prefix}-{i}-{Path(fname).name or 'input.bin'}", data)
                   for i, (fname, data) in enumerate(uploads)]
    slots = comfy_workflow.detect_slots(wf, set())
    images: list[tuple[str, bytes]] = []
    videos: list[tuple[str, bytes]] = []
    for i, entry in enumerate(uploads):
        m = meta[i] if isinstance(meta[i], dict) else {}
        t = m.get("type")
        if t not in ("image", "video"):
            raise HTTPException(400, f"미디어 {i} 의 type 이 image/video 가 아닙니다: {t!r}")
        (videos if t == "video" else images).append(entry)
    if len(images) > len(slots["image_slots"]):
        raise HTTPException(
            400, f"연결된 이미지 {len(images)}개가 워크플로우 이미지 슬롯 "
            f"{len(slots['image_slots'])}개보다 많습니다")
    if len(videos) > len(slots["video_slots"]):
        raise HTTPException(
            400, f"연결된 영상 {len(videos)}개가 워크플로우 영상 슬롯 "
            f"{len(slots['video_slots'])}개보다 많습니다")
    ni = _fill_images(target, wf, slots["image_slots"], images)
    nv = _fill_videos(target, wf, slots["video_slots"], videos, input_dir)
    return {"images": ni, "videos": nv,
            "image_slots": len(slots["image_slots"]), "video_slots": len(slots["video_slots"])}


def _read_saved_texts(target: dict, wf: dict) -> list[str]:
    """SaveText 계열 노드가 쓴 파일을 /view 로 읽어 내용 반환(ShowText 가 히스토리에 안 실리는 경우 보완).
    append(누적) 모드 파일은 과거 실행분이 쌓여 이번 실행만 못 뽑으므로 건너뛴다 — overwrite 로 쓰게 유도."""
    out: list[str] = []
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", "")).lower()
        if "savetext" not in ct and "text save" not in ct and "save text" not in ct:
            continue
        inputs = node.get("inputs") or {}
        if str(inputs.get("append", "")).strip().lower() == "append":
            continue  # 누적 모드 — 중복 방지 위해 파일 읽기 생략
        fname = inputs.get("file")
        if not isinstance(fname, str) or not fname:
            continue
        root = inputs.get("root_dir")
        typ = root if root in ("input", "output", "temp") else "output"
        rel = fname.replace("\\", "/")
        sub, _, base = rel.rpartition("/")
        try:
            data = comfy_client.view_bytes(
                target, {"filename": base or rel, "subfolder": sub, "type": typ})
            txt = data.decode("utf-8", "replace").strip()
        except comfy_client.ComfyError:
            continue
        if txt:
            out.append(txt)
    return out


def _run_comfy_job_impl(job_id: str, wf: dict, pvals: Any, meta: list,
                        uploads: list[tuple[str, bytes]], settings: dict) -> dict:
    """실제 무거운 실행 — 미디어 주입 → 제출 → 폴링 → 출력 수집. 백그라운드 스레드에서 돈다.
    (예전 /run 동기 핸들러 본문을 그대로 옮긴 것. 에러는 HTTPException 으로 던져 worker 가 잡는다.)"""
    target = comfy_client.make_target(settings)
    _inject_params(wf, pvals if isinstance(pvals, dict) else {})

    # 연결된 레퍼런스를 타입별 슬롯에 자동 주입(+미사용 슬롯 prune)
    try:
        _inject_media_bytes(target, wf, meta, uploads, settings["comfy_input_dir"], job_id)
    except comfy_client.ComfyError as e:
        code = 402 if getattr(e, "auth_error", False) else 502
        raise HTTPException(code, f"입력 미디어 업로드 실패: {e}")
    except ValueError as e:
        raise HTTPException(400, f"워크플로우 파싱 실패: {e}")

    tgt_kind = "cloud" if target["cloud"] else "local"
    prompt_id: Optional[str] = None
    try:
        prompt_id = comfy_client.submit(target, wf, settings["comfy_api_key"])
        # 원격 제출 성공과 메모리 등록 사이의 재시작에도 prompt_id 를 잃지 않게 먼저 영속화한다.
        # ★단, 이 기록은 재시작 진단용 best-effort 다 — 기록 실패(순간 DB 잠금 등)가
        #  이미 제출·과금된 멀쩡한 잡을 취소·실패시키면 손해가 더 크다(통합 검토에서 완화).
        try:
            _track_inflight_run(job_id, prompt_id, tgt_kind)
        except Exception as e:  # noqa: BLE001
            log.warning("comfy in-flight 영속 기록 실패(실행은 계속) job_id=%s: %s", job_id, e)
        _update_run_job(job_id, prompt_id=prompt_id)
        log.info("comfy submit ok target=%s prompt_id=%s", tgt_kind, prompt_id)  # api_key 는 절대 안 찍음
        entry = _wait(target, prompt_id, job_id)
    except comfy_client.ComfyError as e:
        if prompt_id:
            _cancel_remote_run(target, prompt_id, "run failure", job_id)
        log.warning("comfy run 실패 target=%s: %s", tgt_kind, e)
        code = 402 if getattr(e, "auth_error", False) else 502
        raise HTTPException(code, str(e))
    except Exception:
        # 영속 저장 실패처럼 ComfyError 가 아닌 예외도 제출 뒤라면 원격 잡은 남기지 않는다.
        if prompt_id:
            _cancel_remote_run(target, prompt_id, "run failure", job_id)
        raise

    # 출력 수집 — 저장(OUTPUT) 노드가 내놓은 결과 전부. 미디어(이미지/영상)와 텍스트가 섞일 수 있고,
    # 복수일 수 있다(SaveText/SaveImage/VideoCombine 등). 미디어는 MEDIA_DIR 로 받아 /media URL 로.
    results: list[dict] = []
    for item in comfy_client.collect_outputs(entry):
        kind = _media_kind(item["filename"])
        if kind is None:
            continue  # 이미지/영상 확장자가 아니면 미디어로 저장하지 않는다(.txt 등 → 아래 텍스트 경로에서 처리)
        ext = os.path.splitext(item["filename"])[1].lower()
        rel = f"comfy/{uuid.uuid4().hex[:16]}{ext}"
        try:
            comfy_client.download_view(target, item, MEDIA_DIR / rel)
        except comfy_client.ComfyError as e:
            _cancel_remote_run(target, prompt_id, "output download failure", job_id)
            raise HTTPException(502, f"출력물 다운로드 실패: {e}")
        results.append({"kind": kind, "url": f"/media/{rel}"})

    # 텍스트 출력: (1) 히스토리 UI 텍스트(ShowText 등) + (2) SaveText 가 쓴 파일 내용.
    # ShowText 는 히스토리에 안 실리는 구성이 있어, SaveText(overwrite) 파일도 읽어 보완한다.
    # append(누적) 모드 SaveText 는 과거 실행분이 쌓여 이번 실행만 못 뽑으므로 건너뛴다(중복 방지).
    texts: list[str] = []
    seen: set[str] = set()
    for text in [*comfy_client.collect_texts(entry), *_read_saved_texts(target, wf)]:
        key = text.strip()
        if key and key not in seen:
            seen.add(key)
            texts.append(key)
    for text in texts:
        results.append({"kind": "text", "text": text})

    if not results:
        # 원본 outputs 전체를 로그로 남긴다(정확한 구조 파악용) — 카드에는 요약만.
        try:
            log.warning("comfy /run 출력 없음. raw outputs=%s",
                        json.dumps(entry.get("outputs"), ensure_ascii=False)[:4000])
        except Exception:  # noqa: BLE001
            log.warning("comfy /run 출력 없음(직렬화 실패). keys=%s", list((entry.get("outputs") or {})))
        _cancel_remote_run(target, prompt_id, "empty output", job_id)
        raise HTTPException(
            502, "실행은 끝났지만 표시할 출력물이 없습니다(ShowText/SaveImage/VideoCombine 등 결과 노드 필요). "
            f"실제 출력 구조: {comfy_client.outputs_debug(entry, wf)}")
    return {"outputs": results, "prompt_id": prompt_id}


def _run_comfy_job_worker(job_id: str, wf: dict, pvals: Any, meta: list,
                          uploads: list[tuple[str, bytes]], settings: dict) -> None:
    """스레드 진입점 — 실행 결과/에러를 잡 레코드에 기록. HTTPException.status_code 로 402/502 보존.
    설정한 동시 실행 수만큼만 실제 제출하도록 슬롯을 획득한 뒤 실행한다(초과분은 슬롯 날 때까지 PENDING 대기)."""
    _acquire_run_slot(_to_int(settings.get("comfy_concurrency"), 3), job_id)
    try:
        _update_run_job(job_id, state=_RUN_RUNNING)
        try:
            result = _run_comfy_job_impl(job_id, wf, pvals, meta, uploads, settings)
        except HTTPException as e:
            _cancel_failed_run(settings, job_id, "worker failure")
            _fail_run_job(job_id, int(e.status_code or 500), e.detail)
        except Exception as e:  # noqa: BLE001
            log.exception("comfy async run 예외 job_id=%s", job_id)
            _cancel_failed_run(settings, job_id, "worker unexpected failure")
            _fail_run_job(job_id, 500, f"Comfy 실행 중 알 수 없는 오류가 발생했습니다: {e}")
        else:
            _finish_run_job(job_id, result)
    finally:
        _release_run_slot()


@router.post("/run")
def run(
    content: str = Form(...),
    param_values: str = Form("{}"),
    media_meta: str = Form("[]"),
    media: list[UploadFile] = File(default=[]),
):
    """Comfy 노드 실행 '시작' — 실제 제출/폴링/다운로드는 백그라운드 스레드에서 처리하고 즉시 job_id 반환.
    (긴 HTTP 연결을 붙잡지 않아 배치 병렬 시 연결 끊김='Failed to fetch' 오판을 없앤다.)
    프론트는 /run_status?job_id= 를 폴링해 완료 시 기존과 동일한 {outputs, prompt_id} 를 받는다.
    멀티파트: content(워크플로우), param_values(JSON 플랫), media_meta(JSON [{type}]), media(파일들))."""
    if update_in_progress():
        raise HTTPException(409, "프로그램 업데이트가 진행 중이라 새 Comfy 작업을 시작할 수 없습니다")
    try:
        wf = json.loads(content)
        pvals = json.loads(param_values or "{}")
        meta = json.loads(media_meta or "[]")
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"요청 파싱 실패: {e}")
    if not isinstance(wf, dict) or not wf:
        raise HTTPException(400, "빈 워크플로우입니다")
    if not isinstance(meta, list):
        meta = []

    media_files = media or []
    if len(meta) != len(media_files):
        raise HTTPException(400, "media 파일 수와 media_meta 수가 일치하지 않습니다")

    # UploadFile 은 응답 후 닫힐 수 있다 → request 안에서 bytes 로 읽어 두고, 스레드엔 bytes 만 넘긴다.
    uploads = _read_media_uploads(media_files)
    settings = _raw_settings()

    job_id = _create_run_job()
    thread = threading.Thread(
        target=_run_comfy_job_worker,
        args=(job_id, wf, pvals, meta, uploads, settings),
        name=f"comfy-run-{job_id[:8]}",
        daemon=True,
    )
    try:
        thread.start()
    except RuntimeError as e:
        _fail_run_job(job_id, 500, f"Comfy 작업 스레드를 시작하지 못했습니다: {e}")
        raise HTTPException(500, f"Comfy 작업 스레드를 시작하지 못했습니다: {e}")
    return {"job_id": job_id}


@router.get("/run_status")
def run_status(job_id: str):
    """실행 잡 상태 조회. 완료면 기존 /run 과 동일한 {outputs, prompt_id} 를, 실패면 원래 코드(402/502)로 던진다."""
    with _RUN_JOBS_LOCK:
        _sweep_run_jobs_locked()
        job = _RUN_JOBS.get(job_id)
        snapshot = dict(job) if job else None
    if not snapshot:
        raise HTTPException(404, "작업을 찾을 수 없습니다(만료되었을 수 있습니다)")

    state = snapshot.get("state")
    if state in (_RUN_PENDING, _RUN_RUNNING):
        resp = {"job_id": job_id, "state": state}
        if snapshot.get("prompt_id"):
            resp["prompt_id"] = snapshot["prompt_id"]
        return resp
    if state == _RUN_DONE:
        result = snapshot.get("result")
        if isinstance(result, dict):
            return result
        raise HTTPException(500, "작업 결과가 올바르지 않습니다")
    if state == _RUN_FAILED:
        raise HTTPException(int(snapshot.get("code") or 500), snapshot.get("error") or "Comfy 실행 실패")
    raise HTTPException(500, "작업 상태가 올바르지 않습니다")


# ── Comfy 출력 → "내 작업" 라이브러리 저장 ────────────────────────────────────

class ComfyOutputItem(BaseModel):
    url: str                       # /media/comfy/... (또는 원격 URL)
    kind: str                      # 'image' | 'video' | 'text'(저장 제외)


class ComfyRefItem(BaseModel):
    url: str
    type: str = "image"            # 'image' | 'video'
    source_gen_id: Optional[str] = None  # 입력이 생성물에서 왔으면 계보 엣지 기록
    name: Optional[str] = None           # @소스명(칩)
    source_url: Optional[str] = None
    role: Optional[str] = None


class SaveToLibraryReq(BaseModel):
    outputs: list[ComfyOutputItem]
    name: Optional[str] = None      # 워크플로 이름
    prompt: Optional[str] = None    # 프롬프트(text 파라미터 값)
    params: Optional[dict[str, Any]] = None
    inputs: Optional[list[ComfyRefItem]] = None  # 연결된 입력 레퍼런스
    project_id: Optional[str] = None
    folder_path: Optional[str] = None
    elapsed_seconds: Optional[float] = None  # 실행 누른→결과 나온 소요시간(프론트 측정). PM 메트릭용.


def _pm(action) -> None:
    """PM 메트릭 best-effort — MANAGE off 거나 실패해도 저장 흐름에 영향 0(gen_requests 와 동일 패턴)."""
    if not MANAGE_ENABLED:
        return
    try:
        from ..repo import manage as _m

        action(_m)
    except Exception:  # noqa: BLE001 — 메트릭 실패가 저장을 막지 않게
        pass


@router.post("/save-to-library")
def save_to_library(req: SaveToLibraryReq, request: Request):
    """Comfy 노드 출력(이미지/영상)을 라이브러리 generation 으로 물질화 → '내 작업'에 편입.
    힉스필드 생성물과 구분(generator='comfy', job_id 없음). 텍스트 출력은 제외.
    멱등: 같은 출력 파일(asset.file_path)이 이미 저장돼 있으면 그 gen 을 재사용(중복 방지)."""
    acc = require_agent_account(request)
    # 생성요청과 동일한 신원 규칙 — AUTH on 은 account_actor_uid(미링크는 acct:email), off 는 계정 uid.
    creator_uid = account_actor_uid(request) if AUTH_ENABLED else acc.get("creator_uid")

    # project_id 검증(생성요청과 동일) — 존재 + 역할까지. 남의 프로젝트에 주입 방지. AUTH off 로컬은 통과.
    pid = (req.project_id or "").strip()
    if pid in ("", "none"):
        pid = None
    elif AUTH_ENABLED:
        if not repo.get_project(pid):
            raise HTTPException(400, "없는 프로젝트에는 저장할 수 없습니다")
        require_project_role(
            request, pid, rbac.CREATOR, rbac.SUPERVISOR, rbac.PROJECT_MANAGER, read_only=True
        )

    prompt = (req.prompt or "").strip() or (req.name or "Comfy 출력")
    params = dict(req.params or {})
    if req.name:
        params.setdefault("workflow_name", req.name)
    # 입력 계보(source_gen_id)는 열람 권한이 있는 것만 엣지로 남긴다 — 남의 비공개 생성물 id 를
    # 알고 넘겨 계보로 노출시키는 것을 막는다(엣지만 드롭, ref URL 자체는 그대로 보존).
    ref_dicts: list[dict[str, Any]] = []
    for r in (req.inputs or []):
        sgid = r.source_gen_id
        if sgid:
            g = repo.get_generation(sgid)
            if not g or not can_view_generation(request, g):
                sgid = None
        ref_dicts.append(
            {"file_path": r.url, "type": r.type, "source_gen_id": sgid,
             "name": r.name, "source_url": r.source_url, "role": r.role}
        )

    saved: list[dict[str, Any]] = []
    for o in req.outputs:
        if o.kind not in ("image", "video"):
            continue  # 텍스트 등 미디어 아닌 출력은 라이브러리 저장 대상 아님
        # Comfy 출력은 항상 로컬 /media/ 아래다 — 외부/임의 URL 저장 차단(HF 동기화 URL 과 겹쳐
        # job_id 가 붙어 generator='comfy' 인데 HF 삭제검증 대상이 되는 불변식 붕괴 방지).
        if not o.url.startswith("/media/"):
            raise HTTPException(400, "저장 가능한 출력은 로컬 미디어(/media/…)만 지원합니다")
        # 멱등은 create 내부에서 같은 트랜잭션(BEGIN IMMEDIATE)으로 판정 — find→create 사이
        # 레이스로 중복 생성되던 것을 닫는다. (gen_id, existed) 반환.
        gid, existed = repo.create_comfy_generation(
            worker_id=DEFAULT_WORKER_ID,
            creator_uid=creator_uid,
            prompt=prompt,
            display_prompt=None,
            params=params,
            kind=o.kind,
            file_path=o.url,
            thumbnail_path=None,
            references=ref_dicts,
            project_id=pid,
            folder_path=req.folder_path,
        )
        # 새로 만든 것만 소요시간 기록(재저장은 원래 값 유지). '실행→결과' 시간을 PM 메트릭에.
        if not existed and req.elapsed_seconds is not None:
            _pm(lambda _m, g=gid: _m.record_elapsed(g, req.elapsed_seconds))
        saved.append({"url": o.url, "generation_id": gid, "existed": existed})
    return {"saved": saved}
