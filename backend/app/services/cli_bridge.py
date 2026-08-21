"""higgsfield CLI 브리지 (Phase 3).

asyncio subprocess 로 `higgsfield` CLI 를 감싼다. 필드 매핑은 실제
`higgsfield generate list --json` / `model list --json` 출력으로 검증함
(DESIGN.md §5 Phase 3 전제조건).

Windows 함정(검증 완료):
- `higgsfield` 는 npm 셰임 `higgsfield.CMD` 다. PATH 이름이 아니라
  `shutil.which()` 로 해석한 절대경로로 실행해야 FileNotFoundError 가 안 난다.
- subprocess 는 Proactor 이벤트 루프가 필요하다. Python 3.14 의 Windows 기본
  루프가 이미 Proactor 이고 uvicorn 도 이를 사용하므로 별도 정책 설정은 안 한다.

검증된 list 항목 매핑:
    id            → higgsfield job id (generation.id 로 그대로 사용해 재동기 멱등)
    status        → completed|... → 로컬 status 로 정규화
    job_set_type  → generation.model
    display_name  → 모델 표시명
    result_url    → asset.file_path (확장자로 image/video 판별)
    created_at    → epoch(float) → ISO 문자열
    params.prompt → generation.prompt
    params.medias → [{data:{id,url}, role}] → reference 목록
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import threading
import time
import weakref
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import DATA_DIR
from ..workspace_context import normalize_workspace_context  # leaf 모듈(순환 없음 확인)
from .atomic_io import atomic_write_text
from .media_types import media_type_from_url

# ── CLI 경로 해석 (셰임 함정 회피) ────────────────────────────────────────
_CLI_PATH: Optional[str] = None

# ── 짧은 TTL 호출 캐시 ────────────────────────────────────────────────────
# 모델 목록·파라미터 스키마는 사실상 불변, 계정상태는 잦은 조회용. 매 요청 subprocess(콜드스타트
# 수백 ms~초)를 새로 띄우는 대신 메모이즈한다. CLI 가 바인딩하는 힉스필드 계정은 프로세스 수명 동안
# 고정(서버=하우스, 로컬=그 PC) — 허브 로그인/DB 전환은 CLI 계정을 안 바꾸므로 전역 캐시가 안전하다.
_CALL_CACHE: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str, ttl: float) -> Any:
    hit = _CALL_CACHE.get(key)
    if hit and (time.monotonic() - hit[0]) < ttl:
        return hit[1]
    return None


def _cache_put(key: str, value: Any) -> None:
    _CALL_CACHE[key] = (time.monotonic(), value)


# ── 동시 miss 합류(single-flight, R5 2-C1) ────────────────────────────────
# TTL 캐시는 조회 후에만 채워지므로 동시 요청이 같은 miss 를 보면 모두 subprocess 를
# 띄웠다(콜드스타트 수백 ms~초 × M). 이벤트 루프별·키별 in-flight task 를 공유해 CLI
# 실행을 1회로 합친다. 결과 캐시는 각 함수의 기존 성공 조건이 그대로 담당 — 여기서는
# '동시' 합류만 하고 완료 즉시 등록을 지운다(실패는 그 순간의 대기자에게만 전파,
# 이후 호출은 새로 시도 → 실패·빈 결과 비캐시 계약 유지).
_inflight_guard = threading.Lock()
_inflight_calls: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[str, "asyncio.Task[Any]"]
] = weakref.WeakKeyDictionary()


async def _single_flight(key: str, factory) -> Any:
    loop = asyncio.get_running_loop()
    with _inflight_guard:
        calls = _inflight_calls.get(loop)
        if calls is None:
            calls = {}
            _inflight_calls[loop] = calls
        task = calls.get(key)
        if task is None:
            task = loop.create_task(factory())

            def _cleanup(done: "asyncio.Task[Any]", key=key, calls=calls) -> None:
                calls.pop(key, None)
                if not done.cancelled():
                    done.exception()  # 대기자 전원 취소 시 '미회수 예외' 경고 방지

            task.add_done_callback(_cleanup)
            calls[key] = task
    return await task


class CLIError(RuntimeError):
    """CLI 호출 실패(0이 아닌 종료코드 또는 미설치)."""


async def _terminate_cli_process(proc: asyncio.subprocess.Process) -> None:
    """취소·타임아웃된 CLI의 부모와 자식 프로세스를 끝내고 반드시 회수한다."""
    if proc.returncode is None and os.name == "nt" and proc.pid:
        killer = None
        try:
            taskkill = shutil.which("taskkill.exe") or os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"),
                "System32",
                "taskkill.exe",
            )
            killer = await asyncio.create_subprocess_exec(
                taskkill,
                "/PID",
                str(proc.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            await asyncio.wait_for(killer.wait(), timeout=5.0)
        except (OSError, asyncio.TimeoutError):
            if killer and killer.returncode is None:
                try:
                    killer.kill()
                except OSError:
                    pass
                try:
                    await killer.wait()
                except OSError:
                    pass
    if proc.returncode is None:
        try:
            proc.kill()
        except OSError:
            pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except (OSError, asyncio.TimeoutError):
        pass


def cli_path() -> str:
    global _CLI_PATH
    if _CLI_PATH is None:
        found = shutil.which("higgsfield") or shutil.which("hf")
        if not found:
            raise CLIError("higgsfield CLI 를 찾을 수 없음 (PATH 확인)")
        _CLI_PATH = found
    return _CLI_PATH


def cli_available() -> bool:
    try:
        cli_path()
        return True
    except CLIError:
        return False


async def _run(*args: str, timeout: float = 60.0) -> str:
    """CLI 를 실행하고 stdout(텍스트)을 반환. 절대경로로 실행."""
    proc = await asyncio.create_subprocess_exec(
        cli_path(),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        await _terminate_cli_process(proc)
        raise CLIError(f"CLI 타임아웃: higgsfield {' '.join(args)}") from e
    except asyncio.CancelledError:
        await _terminate_cli_process(proc)
        raise
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace").strip()
        raise CLIError(f"higgsfield {' '.join(args)} 실패(rc={proc.returncode}): {msg}")
    return (out or b"").decode("utf-8", "replace")


async def job_exists(job_id: str, timeout: float = 30.0) -> Optional[bool]:
    """힉스필드에 이 잡이 아직 있나? generate get <id> 결과로 판정.
    True=있음, False=삭제됨('Job not found'), None=확인불가(타임아웃/네트워크/모르는 출력 → 상태 변경 금지)."""
    try:
        raw = (await _run("generate", "get", job_id, "--json", timeout=timeout)).strip()
    except CLIError as e:
        # 삭제된 잡은 CLI 가 비정상종료 + stderr "Job not found" 로 알린다(rc≠0 → _run 이 CLIError).
        # 그 에러 메시지에 not-found 신호가 있으면 삭제로 확정. 그 외(타임아웃·네트워크·PATH 등)는
        # 확인불가(None) 로 두어 일시 오류로 멀쩡한 걸 지우지 않게 한다.
        return False if "job not found" in str(e).lower() else None
    if "job not found" in raw.lower():
        return False
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return True if isinstance(data, dict) and data.get("id") else None


async def get_job_raw(job_id: str, timeout: float = 30.0) -> Optional[dict[str, Any]]:
    """generate get <id> --json → 원시 잡 dict(없음/확인불가면 None). 재조정(하우스 계정)용 —
    job_exists 는 True/False 만 주지만 이건 status·result_url 이 담긴 실제 잡을 돌려준다.
    삭제/타임아웃/파싱실패는 None(상태 변경 금지). 호출부가 parse_job 으로 정규화한다."""
    try:
        raw = (await _run("generate", "get", job_id, "--json", timeout=timeout)).strip()
    except CLIError:
        return None
    if not raw or "job not found" in raw.lower():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and data.get("id") else None


async def _run_capture(*args: str, timeout: float = 600.0) -> tuple[str, str, int]:
    """create 전용 — stdout/stderr/returncode 를 모두 반환(예외 안 던짐, 타임아웃만 예외).
    소프트 실패(rc=0 인데 status=failed) 시 stderr 에 담긴 사유를 살리기 위함."""
    proc = await asyncio.create_subprocess_exec(
        cli_path(),
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        await _terminate_cli_process(proc)
        raise CLIError(f"CLI 타임아웃: higgsfield {' '.join(args)}") from e
    except asyncio.CancelledError:
        await _terminate_cli_process(proc)
        raise
    return (
        (out or b"").decode("utf-8", "replace"),
        (err or b"").decode("utf-8", "replace"),
        proc.returncode if proc.returncode is not None else -1,
    )


async def _run_json(*args: str, timeout: float = 60.0) -> Any:
    raw = await _run(*args, "--json", timeout=timeout)
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise CLIError(f"JSON 파싱 실패: {raw[:200]}") from e


# ── 정규화 헬퍼 ──────────────────────────────────────────────────────────
_STATUS_MAP = {
    "completed": "done",
    "succeeded": "done",
    "success": "done",
    "done": "done",
    "failed": "failed",
    "error": "failed",
    "canceled": "failed",
    "cancelled": "failed",
    "queued": "pending",
    "in_queue": "pending",
    "pending": "pending",
    "created": "pending",
    "waiting": "pending",
    "running": "running",
    "processing": "running",
    "in_progress": "running",
    "nsfw": "nsfw",  # 콘텐츠 차단(결과 없음) — 터미널 상태로 그대로 보존
    "nsfw_detected": "nsfw",  # 1.x 표기 — 같은 콘텐츠 차단
    "rejected": "failed",  # 제출 후 거부 — 실패로 취급(재조정이 '생성중' 유령을 실패로 확정)
}

_PROVIDER_SUCCESS = {"completed", "succeeded", "success", "done"}
_PROVIDER_FAILURE = {
    "failed", "error", "canceled", "cancelled", "nsfw", "nsfw_detected", "rejected"
}
_PROVIDER_PROCESSING = {
    "queued", "in_queue", "pending", "created", "waiting", "running", "processing", "in_progress"
}
_PROVIDER_ACTION_REQUIRED = {
    "needs_action", "needs_confirmation", "ip_detected", "user_action_required"
}


def provider_status_kind(raw: Optional[str]) -> str:
    """공급자 원시 상태를 안전한 다섯 종류로 분류한다.

    모르는 신규 상태는 terminal로 추측하지 않는다. `unknown`은 조회를 계속해야 한다는 뜻이다.
    """
    value = (raw or "").strip().lower()
    if value in _PROVIDER_SUCCESS:
        return "success"
    if value in _PROVIDER_FAILURE:
        return "failure"
    if value in _PROVIDER_PROCESSING or not value:
        return "processing"
    if value in _PROVIDER_ACTION_REQUIRED:
        return "action_required"
    return "unknown"

def normalize_status(raw: Optional[str]) -> str:
    """CLI status → generation의 보수적 상태.

    원시값은 gen_request.provider_status에 따로 보존한다. 모르는 값을 그대로 노출하면 기존 코드가
    terminal로 오해하므로, generation은 running으로 유지하고 직접 조회를 계속한다.
    """
    if not raw:
        return "pending"
    value = raw.lower()
    return _STATUS_MAP.get(value, "running")
def _to_epoch(value: Any) -> Optional[float]:
    """원시 created_at → epoch float(sub-second 보존). 정렬키용. 실패 시 None.
    CLI 0.x 는 float epoch, CLI 1.x 는 ISO8601 문자열('...Z')로 준다 — 둘 다 처리."""
    if value is None:
        return None
    try:
        return float(value)  # 0.x: epoch(float/int) 또는 숫자문자열
    except (TypeError, ValueError):
        pass
    try:  # 1.x: ISO8601 (예: '2026-07-07T05:00:02.667612Z')
        return datetime.fromisoformat(str(value).strip().replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def epoch_to_iso(value: Any) -> str:
    """created_at(epoch float 또는 1.x ISO 문자열) → 'YYYY-MM-DD HH:MM:SS' (UTC). 실패 시 현재시각."""
    ep = _to_epoch(value)
    if ep is not None:
        try:
            return datetime.fromtimestamp(ep, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            pass
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def parse_job(job: dict[str, Any]) -> dict[str, Any]:
    """list/get 의 한 잡(dict) → 로컬 DB 업서트용 정규 구조.

    반환 구조:
        {
          generation: {id, prompt, model, params(json), status, created_at, display_name},
          asset: {type, file_path} | None,
          references: [{id, type, file_path, role}],
        }
    """
    params = job.get("params") or {}
    result_url = job.get("result_url")

    # CLI 1.1.23 목록에는 현재 workspace 필드가 없지만, MCP/향후 CLI 응답 또는 오프라인
    # 백필에는 개별 잡 컨텍스트가 포함될 수 있다. 변환 중 버리지 않고 내부 평면 규격으로 보존한다.
    # 명시된 ``workspace`` 객체가 있으면 그것만 읽는다(불완전하면 unknown, 평면값 추측 금지).
    # 값이 None(JSON null)인 키는 "잡 자체 워크스페이스 명시"로 치지 않는다 — MCP/덤프가
    # 관행적으로 `workspace: null` 을 실어 보내면 검증된 배치 컨텍스트까지 잃고 전부
    # unknown 이 되는 것을 막는다. 빈 문자열 등 깨진 명시값은 종전대로 unknown(fail-closed).
    has_job_workspace = job.get("workspace") is not None or any(
        job.get(key) is not None
        for key in ("workspace_scope", "workspace_id", "workspace_name")
    )
    raw_workspace = job.get("workspace") if "workspace" in job else job
    job_workspace = normalize_workspace_context(raw_workspace)

    references: list[dict[str, Any]] = []
    from ..repo._common import _UID_RE  # 생성자 uid 패턴 단일 정의(중복 하드코딩 방지)

    _m = _UID_RE.search(result_url or "")
    creator_uid = _m.group(1) if _m else None  # 결과 URL 경로의 생성자 식별자
    for m in params.get("medias") or []:
        data = (m or {}).get("data") or {}
        url = data.get("url")
        if not url:
            continue
        references.append(
            {
                "id": data.get("id"),
                "type": media_type_from_url(url),
                "file_path": url,
                "role": m.get("role"),
            }
        )

    asset = None
    if result_url:
        asset = {
            "type": media_type_from_url(result_url),
            "file_path": result_url,
            # CLI 1.x: 영상 잡은 thumbnail_url(정적 포스터 이미지)을 준다. 영상 asset 의 thumbnail_path
            # 로 써서 그리드/팝업에 가벼운 포스터를 붙인다(우리 썸네일러는 영상 미지원).
            "thumbnail_url": job.get("thumbnail_url"),
            # 이미지 잡은 min_result_url(경량 축소본)을 준다. 원격 이미지 썸네일로 이걸 쓰면 팀 browse
            # 시 원본 full 을 통째로 받지 않아 디스크를 아낀다(원본 보존은 완료 저장이 선별로 담당).
            "min_result_url": job.get("min_result_url"),
        }

    return {
        "generation": {
            "id": job.get("id"),
            "prompt": params.get("prompt") or "(제목 없음)",
            # CLI 1.x 는 generate 출력의 모델키를 job_set_type → job_type 로 개명. 둘 다 수용
            # (구버전 job_set_type / 신버전 job_type). 내부 표준 필드명은 계속 model=job_set_type.
            "model": job.get("job_set_type") or job.get("job_type"),
            "display_name": job.get("display_name"),
            "params": params,
            # 일부 응답은 status 대신 job_status 를 쓴다(millionvolt 실측) → 폴백으로 둘 다 수용.
            "status": normalize_status(job.get("status") or job.get("job_status")),
            "created_at": epoch_to_iso(job.get("created_at")),
            "sort_ts": _to_epoch(job.get("created_at")),  # 정밀 정렬키(sub-second 보존)
            "creator_uid": creator_uid,  # 생성자(team 워크스페이스에서 작성자 구분)
            **(
                {
                    "workspace_scope": job_workspace["scope"],
                    "workspace_id": job_workspace["id"],
                    "workspace_name": job_workspace["name"],
                }
                if has_job_workspace
                else {}
            ),
            # 실패 사유(rc=0 인데 잡 자체가 실패한 경우 — NSFW 거부 등). 키는 방어적으로 탐색.
            # 힉스필드 실패 잡 JSON 은 보통 사유 필드를 안 주지만(검증됨), 줄 때를 대비해 폭넓게 탐색.
            "error": (
                job.get("error")
                or job.get("error_message")
                or job.get("failure_reason")
                or job.get("fail_reason")
                or job.get("reason")
                or job.get("detail")
                or job.get("message")
            ),
        },
        "asset": asset,
        "references": references,
    }


# ── 공개 API ─────────────────────────────────────────────────────────────
async def list_jobs(timeout: float = 60.0, size: int = 100) -> list[dict[str, Any]]:
    """생성 잡 목록(정규화된 구조). size 최대 100(CLI 상한, 페이지네이션 없음)."""
    data = await _run_json("generate", "list", "--size", str(size), timeout=timeout)
    if not isinstance(data, list):
        return []
    return [parse_job(j) for j in data if isinstance(j, dict)]


async def list_models(timeout: float = 60.0) -> list[dict[str, Any]]:
    """생성 모달용 모델 목록 [{display_name, job_set_type, type}]. 5분 TTL 캐시(거의 불변).
    동시 miss 는 single-flight 로 CLI 1회에 합류(R5 2-C1)."""
    cached = _cache_get("models", 300.0)
    if cached is not None:
        return cached
    return await _single_flight("models", lambda: _list_models_uncached(timeout))


async def _list_models_uncached(timeout: float) -> list[dict[str, Any]]:
    data = await _run_json("model", "list", timeout=timeout)
    if not isinstance(data, list):
        return []
    out = []
    for m in data:
        if not isinstance(m, dict):
            continue
        # CLI 1.x model list 는 job_set_type → job_type 로 개명. 둘 다 수용(빈 모델키 방지 = 모델선택 깨짐 방지).
        jst = m.get("job_set_type") or m.get("job_type")
        out.append(
            {
                "display_name": m.get("display_name") or jst or "?",
                "job_set_type": jst or "",
                "type": m.get("type") or "image",
            }
        )
    if out:  # 성공(비어있지 않음)만 캐시 — 일시 실패([])를 5분 고정하지 않게
        _cache_put("models", out)
    return out


async def get_model_params(job_set_type: str, timeout: float = 60.0) -> dict[str, Any]:
    """모델의 CLI 조절 가능 파라미터 스키마 — model get <job_set_type> --json. 1시간 TTL 캐시(불변).
    동시 miss 는 single-flight 로 CLI 1회에 합류(R5 2-C1)."""
    ckey = f"params:{job_set_type}"
    cached = _cache_get(ckey, 3600.0)
    if cached is not None:
        return cached
    return await _single_flight(
        ckey, lambda: _get_model_params_uncached(ckey, job_set_type, timeout)
    )


async def _get_model_params_uncached(
    ckey: str, job_set_type: str, timeout: float
) -> dict[str, Any]:
    data = await _run_json("model", "get", job_set_type, timeout=timeout)
    if not isinstance(data, dict):
        return {"job_set_type": job_set_type, "type": "image", "params": []}
    result = {
        "display_name": data.get("display_name"),
        # CLI 1.1.20 model get 도 job_set_type 대신 job_type 을 반환한다. 내부 응답 계약은
        # 계속 job_set_type 으로 유지하되 신·구 CLI 필드를 모두 받는다.
        "job_set_type": data.get("job_set_type") or data.get("job_type") or job_set_type,
        "type": data.get("type") or "image",
        "params": data.get("params") or [],
    }
    if result["params"]:  # 파라미터를 실제로 받았을 때만 캐시(폴백 빈 스키마는 캐시 안 함)
        _cache_put(ckey, result)
    return result


# 모델별 허용 파라미터 이름 캐시(프로세스 수명). 동기화/재사용 시 힉스필드가 채운
# 잔여 필드(width/height/batch_size/input_images …)가 --param 으로 새어 나가 CLI 가
# "Unknown params" 로 거부하는 것을 막는다.
# 조회 실패는 캐시하지 않는다(RL-24) — CLI 일시 장애 한 번이 프로세스 수명 내내
# "필터 없음"으로 굳지 않게, 짧은 TTL 뒤 다음 호출에서 다시 조회한다.
_PARAM_NAMES_CACHE: dict[str, set[str]] = {}
_PARAM_NAMES_RETRY_AT: dict[str, float] = {}
_PARAM_NAMES_FAIL_TTL = 120.0


async def _allowed_param_names(model: str) -> set[str]:
    """모델이 받는 파라미터 이름 집합. 조회 실패 시 빈 집합(→ 필터하지 않음=전부 전송)."""
    cached = _PARAM_NAMES_CACHE.get(model)
    if cached is not None:
        return cached
    retry_at = _PARAM_NAMES_RETRY_AT.get(model)
    if retry_at is not None and time.monotonic() < retry_at:
        return set()  # 백오프 중 — CLI 를 매 호출 재기동하지 않는다
    try:
        data = await get_model_params(model)
    except CLIError:
        _PARAM_NAMES_RETRY_AT[model] = time.monotonic() + _PARAM_NAMES_FAIL_TTL
        return set()
    _PARAM_NAMES_RETRY_AT.pop(model, None)
    names = {p.get("name") for p in data.get("params", []) if p.get("name")}
    if names:
        _PARAM_NAMES_CACHE[model] = names
    else:
        # 빈 폴백 스키마를 프로세스 수명 캐시로 박제하지 않는다(R5 2-C1, 코덱스 적발) —
        # get_model_params 가 비-dict 응답에 빈 params 를 돌려준 경우 종전엔 set() 이
        # 영구 캐시돼 '필터 없음'이 굳었다. 실패 백오프와 같은 TTL 로 재조회한다.
        _PARAM_NAMES_RETRY_AT[model] = time.monotonic() + _PARAM_NAMES_FAIL_TTL
    return names


async def _param_args(model: str, params: Optional[dict[str, Any]]) -> list[str]:
    """params → CLI --플래그. 모델 스키마 밖 키·복합 타입(list/dict)·prompt 는 제외.
    스키마를 못 받았으면(빈 집합) 이름 필터를 적용하지 않는다 — 전부 비워 기본값으로
    엉뚱하게 생성(크레딧 소모)되는 것보다 기존 동작 유지가 안전(advisor)."""
    allowed = await _allowed_param_names(model)
    out: list[str] = []
    for k, v in (params or {}).items():
        if v is None or v == "":
            continue
        if k == "prompt":  # 프롬프트는 --prompt 로 따로 전달
            continue
        if isinstance(v, (list, dict)):  # 미디어/복합 타입은 media 플래그로 처리 → --param 금지
            continue
        if allowed and k not in allowed:  # 스키마 밖(동기화/잔여값). 단, 스키마 못 받았으면 통과
            continue
        # CLI 1.x 는 타입을 엄격 검증한다: boolean 은 반드시 소문자 true/false.
        # 파이썬 str(True)="True" 를 그대로 넘기면 "Invalid types: ... should be boolean, got string".
        if isinstance(v, bool):
            out += [f"--{k}", "true" if v else "false"]
        else:
            out += [f"--{k}", str(v)]
    return out


# 비용은 (모델 + 옵션)에 대해 결정적(프롬프트·계정 무관) → 한 번 받은 값은 캐시해 CLI 재호출을
# 없앤다. 옵션 토글로 오갈 때, 정보팝업으로 같은 설정의 생성물을 볼 때 즉시 응답(딜레이 제거).
# 설정 조합 수는 적어 사실상 무한 증가 없음(안전상 소프트 캡).
# 비용 견적 영속 캐시 — 파일(DATA_DIR/cost_cache.json)에 (모델+옵션)→(크레딧, 저장시각)을 보관.
# 재시작·새 탭·재방문 시 CLI 재호출 없이 즉시. TTL 이 지난 항목은 다음 조회 때 CLI 로 재확인해
# 힉스필드 가격 변동을 자동 반영한다(bat·수동 갱신 불필요).
_COST_CACHE_FILE = DATA_DIR / "cost_cache.json"
_COST_CACHE: dict[str, tuple[int, float]] = {}  # key → (credits, saved_epoch)
_COST_CACHE_MAX = 4096
_COST_TTL = float(os.environ.get("CONTENT_HUB_COST_TTL", 7 * 86400))  # 기본 7일(가격 변동 자동 반영)
_cost_loaded = False


def _bounded_env_int(name: str, default: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, maximum))


# 견적은 부가 통계라 실제 생성 응답을 늦추지 않아야 한다. 여러 사용자·탭이 동시에 요청해도
# Higgsfield CLI 프로세스는 기본 2개만 실행하고 나머지는 코루틴으로 대기한다.
_ESTIMATE_CONCURRENCY = _bounded_env_int("CONTENT_HUB_ESTIMATE_CONCURRENCY", 2, 8)
_loop_gate_lock = threading.Lock()
_estimate_gates: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Semaphore
] = weakref.WeakKeyDictionary()
_cost_write_locks: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Lock
] = weakref.WeakKeyDictionary()


def _estimate_gate() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    with _loop_gate_lock:
        gate = _estimate_gates.get(loop)
        if gate is None:
            gate = asyncio.Semaphore(_ESTIMATE_CONCURRENCY)
            _estimate_gates[loop] = gate
        return gate


def _cost_write_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    with _loop_gate_lock:
        lock = _cost_write_locks.get(loop)
        if lock is None:
            lock = asyncio.Lock()
            _cost_write_locks[loop] = lock
        return lock


def _cost_key(model: str, param_args: list[str]) -> str:
    # 키는 '실제 CLI 로 나가는 인자'(_param_args 결과)만으로 만든다 — 스키마 밖 잔여값
    # (medias/prompt/width/height …)은 CLI 호출에서 걸러지므로 키에도 없어야 비용이 같은 조합의
    # 캐시가 쪼개지지 않는다(키↔호출 일치). 순서 무관하게 (플래그,값) 쌍을 정렬.
    pairs = sorted(
        (param_args[i], param_args[i + 1]) for i in range(0, len(param_args) - 1, 2)
    )
    return model + "|" + ";".join(f"{k}={v}" for k, v in pairs)


def _load_cost_cache() -> None:
    """부팅 후 최초 조회 때 파일에서 캐시를 1회 로드한다(멱등)."""
    global _cost_loaded
    if _cost_loaded:
        return
    _cost_loaded = True
    try:
        raw = json.loads(_COST_CACHE_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(raw, dict):
        return
    for k, v in raw.items():
        if isinstance(v, list) and len(v) == 2:
            try:
                _COST_CACHE[k] = (int(v[0]), float(v[1]))
            except (TypeError, ValueError):
                pass


def _serialize_cost_cache() -> str:
    """메인(호출) 스레드에서 dict 스냅샷을 직렬화 — to_thread 안에서 _COST_CACHE 를 순회하면
    다른 코루틴의 갱신과 'dict changed during iteration' 경쟁이 날 수 있어 여기서 미리 만든다."""
    return json.dumps({k: [c, t] for k, (c, t) in _COST_CACHE.items()}, ensure_ascii=False)


def _write_cost_cache(payload: str) -> None:
    """직렬화된 문자열만 디스크에 원자적 저장 — 호출부가 asyncio.to_thread 로 실행(루프 비블로킹)."""
    try:
        atomic_write_text(_COST_CACHE_FILE, payload)
    except OSError:
        pass


_ZWSP = chr(0x200B)  # zero-width space (U+200B)


def _shield_json_prompt(text: str) -> str:
    """CLI 는 --prompt 값이 통째로 유효한 JSON(object/array)이면 문자열이 아니라 '객체'로 파싱해
    'prompt should be string, got object' 로 거부한다(힉스 웹은 문자열 그대로 받아 정상 처리).
    그런 경우 zero-width space 를 앞에 붙여 CLI 가 문자열로 받게 한다(zwsp 는 모델·표시에 안 보여
    내용은 그대로 보존). agent_push._shield_json_prompt 와 동일 로직(두 모듈은 독립 실행이라 각자 둔다)."""
    s = text.lstrip()
    if s[:1] not in ("{", "["):
        return text
    try:
        json.loads(s)
    except (ValueError, TypeError):
        return text  # 완전한 JSON 이 아니면 CLI 도 문자열로 보므로 그대로 둔다
    return _ZWSP + text


async def estimate_cost(
    model: str,
    params: Optional[dict[str, Any]] = None,
    prompt: str = "",
    timeout: float = 120.0,
) -> dict[str, int]:
    """잡 생성 없이 크레딧만 추정 — generate cost <model> [--param value] --json.
    레퍼런스(미디어)는 비용 추정에 불필요+업로드 비용 → 제외(PV 와 동일).
    동일 (모델·옵션) 결과는 캐시(CLI 재호출 없이 즉시) — 비용은 결정적이라 안전."""
    async with _estimate_gate():
        _load_cost_cache()
        # 실제 CLI 인자를 먼저 만든다(스키마 필터·타입 정규화 반영). 캐시 키를 이것으로 만들어야
        # 키↔호출이 일치한다. _param_args→_allowed_param_names 는 프로세스 캐시라 히트 시 subprocess 없음.
        param_args = await _param_args(model, params)
        key = _cost_key(model, param_args)
        entry = _COST_CACHE.get(key)
        if entry is not None and (time.time() - entry[1]) < _COST_TTL:
            return {"credits": entry[0]}  # TTL 안 → 캐시 즉시(CLI 호출 없음)
        args: list[str] = [
            "generate",
            "cost",
            model,
            "--prompt",
            _shield_json_prompt(prompt or "preview"),
        ]
        args += param_args
        try:
            data = await _run_json(*args, timeout=timeout)
        except CLIError:
            # 가격 갱신은 생성 자체가 아닌 보조 정보다. CLI/네트워크가 잠깐 불안정할 때
            # 이미 검증한 예전 가격까지 버려 502를 내면 화면의 예상 크레딧이 깜박이고
            # 서버 로그도 불필요하게 오염된다. 만료된 값이라도 있으면 이번 한 번은
            # 안전한 폴백으로 쓰고, 다음 조회에서 다시 최신 가격 갱신을 시도한다.
            if entry is not None:
                return {"credits": entry[0]}
            raise
        if not isinstance(data, dict):
            return {"credits": entry[0]} if entry else {"credits": 0}  # 실패 시 옛 값 폴백
        credits = data.get("credits_exact")
        if credits is None:
            credits = data.get("credits", 0)
        try:
            credits_int = int(round(float(credits)))
        except (TypeError, ValueError):
            return {"credits": entry[0]} if entry else {"credits": 0}
        if len(_COST_CACHE) >= _COST_CACHE_MAX:
            _COST_CACHE.clear()  # 소프트 캡(드묾)
        _COST_CACHE[key] = (credits_int, time.time())  # TTL 만료분 재확인 시 최신값·시각으로 갱신
        # 두 견적이 병렬 완료돼도 오래된 스냅샷이 나중에 파일을 덮지 않도록 파일 저장은 직렬화한다.
        async with _cost_write_lock():
            payload = _serialize_cost_cache()
            await asyncio.to_thread(_write_cost_cache, payload)
        return {"credits": credits_int}


async def get_account_status(timeout: float = 30.0) -> dict[str, Any]:
    """계정 상태(연결·크레딧·이메일·플랜) — account status --json. 하단 상태줄 수동 확인용.
    10초 TTL 캐시 — 연타·여러 탭에서 동시 조회해도 subprocess 폭주를 막는다(크레딧은 약간 지연 OK).
    동시 miss 는 single-flight 로 CLI 1회에 합류(R5 2-C1)."""
    cached = _cache_get("account_status", 10.0)
    if cached is not None:
        return cached
    return await _single_flight(
        "account_status", lambda: _get_account_status_uncached(timeout)
    )


async def _get_account_status_uncached(timeout: float) -> dict[str, Any]:
    try:
        data = await _run_json("account", "status", timeout=timeout)
    except CLIError:
        return {"connected": False, "credits": None, "email": "", "plan": ""}
    if not isinstance(data, dict) or data.get("error"):
        return {"connected": False, "credits": None, "email": "", "plan": ""}
    credits = data.get("credits_exact")
    if credits is None:
        credits = data.get("credits")
    try:
        credits_val = float(credits) if credits is not None else None
    except (TypeError, ValueError):
        credits_val = None
    result = {
        "connected": True,
        "credits": credits_val,
        "email": data.get("email", ""),
        "plan": data.get("subscription_plan_type", ""),
    }
    _cache_put("account_status", result)  # 10초 TTL — 상태줄 연타 시 subprocess 폭주 방지
    return result


async def get_auth_token(timeout: float = 30.0) -> str:
    """현재 CLI OAuth 토큰을 메모리로만 읽는다.

    과거 이력 MCP 조회처럼 공식 CLI와 같은 Higgsfield 계정 권한이 필요한 로컬 기능용이다.
    토큰은 파일/DB/로그에 저장하지 않으며, 호출부도 예외 문자열에 값을 포함하면 안 된다.
    CLI 버전에 따라 평문 또는 JSON 객체로 올 수 있어 둘 다 수용한다.
    """
    raw = (await _run("auth", "token", "--json", timeout=timeout)).strip()
    if not raw:
        raise CLIError("Higgsfield CLI 로그인이 필요합니다")
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise CLIError("Higgsfield CLI 로그인 정보를 읽지 못했습니다") from exc
        if isinstance(data, dict):
            token = str(data.get("access_token") or data.get("token") or "").strip()
            if token:
                return token
        raise CLIError("Higgsfield CLI 로그인이 필요합니다")
    return raw


# ── 워크스페이스(팀 공유 UUID 공간) ───────────────────────────────────────
async def list_workspaces(timeout: float = 30.0) -> list[dict[str, Any]]:
    """워크스페이스 목록 [{id, name, plan_type, credits, is_selected, user_role}].
    선택 안 됨(개인 컨텍스트)이면 모두 is_selected=false."""
    try:
        data = await _run_json("workspace", "list", timeout=timeout)
    except CLIError:
        return []
    return data if isinstance(data, list) else []


async def set_workspace(workspace_id: str, timeout: float = 30.0) -> None:
    """이후 모든 요청을 이 워크스페이스(팀 공유 UUID 공간)로 스코프. CLI 전역 상태."""
    await _run("workspace", "set", workspace_id, timeout=timeout)


async def unset_workspace(timeout: float = 30.0) -> None:
    """워크스페이스 해제 → 개인 계정 컨텍스트로 복귀."""
    await _run("workspace", "unset", timeout=timeout)


# (create_job/get_job 제거 — 푸시 모델에선 서버가 CLI 로 직접 생성하지 않는다. 생성은 각 PC 의
#  push_agent 가 로컬 CLI 로 수행하고 결과만 ingest 로 올린다. 미사용 사장 코드였음.)
