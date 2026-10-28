"""higgsfield CLI 브리지 (Phase 3).

asyncio subprocess 로 `higgsfield` CLI 를 감싼다. 필드 매핑은 실제
`higgsfield generate list --json` / `model list --json` 출력으로 검증함
(DESIGN.md §5 Phase 3 전제조건).

Windows 함정(검증 완료):
- `higgsfield` 는 npm 셰임 `higgsfield.CMD` 다. PATH 이름이 아니라
  `shutil.which()` 로 해석한 절대경로로 찾고, 실행은 셰임이 아니라 옆 패키지의
  JS 를 node 로 직접 한다(cli_argv — cmd.exe 가 인자의 & | 를 명령으로 읽는다).
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
import hashlib
from urllib.parse import urlsplit
import json
import logging
import math
import re
import os
import shutil
import subprocess
import threading
import time
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import DATA_DIR
from ..workspace_context import normalize_workspace_context  # leaf 모듈(순환 없음 확인)
from .atomic_io import atomic_write_text
from .media_types import media_type_from_url
from .operational_logging import log_event

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


def _single_flight_task(key: str, factory) -> asyncio.Task[Any]:
    """공유 leader 자체를 반환한다. 종료 소유자는 shield 바깥이 아닌 이것을 취소한다."""
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
    return task


async def _single_flight(key: str, factory) -> Any:
    task = _single_flight_task(key, factory)
    # shield: waiter 개별 취소가 공유 leader·다른 waiter 까지 취소시키지 않게 격리
    # (코덱스 P2). 전원 취소돼도 task 는 완주해 결과를 캐시한다(성공 조건 시).
    return await asyncio.shield(task)


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


_CLI_JS_REL = os.path.join("node_modules", "@higgsfield", "cli", "bin", "higgsfield.js")


def cli_argv() -> list[str]:
    """실행 인자 앞부분. Windows npm 셰임(.cmd/.bat)은 cmd.exe 가 인자의 & | 를 명령으로
    읽으므로(F-C-01) 셰임 옆 패키지의 JS 를 node 로 직접 실행한다. 전역 npm·릴리스 번들
    (runtime\\higgsfield) 모두 같은 상대 구조다. 못 찾으면 셰임으로 되돌아가지 않고 실패한다."""
    path = cli_path()
    if os.name != "nt" or not path.lower().endswith((".cmd", ".bat")):
        return [path]
    base = os.path.dirname(path)
    js = os.path.join(base, _CLI_JS_REL)
    if not os.path.isfile(js):
        raise CLIError("higgsfield CLI 의 JS 진입점을 찾을 수 없음 (셰임 .cmd 는 실행하지 않음)")
    # 셰임 옆 → 번들 runtime\node → PATH. PATH 는 'node.exe' 로 찾아 node.cmd 류 셰임을 피한다.
    for node in (
        os.path.join(base, "node.exe"),
        os.path.join(os.path.dirname(base), "node", "node.exe"),
        shutil.which("node.exe"),
    ):
        if node and os.path.isfile(node):
            return [node, js]
    raise CLIError("node.exe 를 찾을 수 없음 (셰임 .cmd 는 실행하지 않음)")


def cli_available() -> bool:
    try:
        cli_argv()
        return True
    except CLIError:
        return False


# 모델 id 는 인자로 CLI 에 그대로 간다. 실제 카탈로그 꼴(영숫자 시작, _ . - : /)만 받는다 —
# 공백·제어문자·셸 문자·'-' 로 시작하는 옵션 꼴은 거절(라우트·브리지 공용).
_MODEL_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")


def valid_model_id(value: Any) -> bool:
    return isinstance(value, str) and _MODEL_ID_RE.fullmatch(value) is not None


def _require_model_id(value: Any) -> None:
    if not valid_model_id(value):
        raise CLIError("모델 id 형식이 올바르지 않습니다")


async def _run(*args: str, timeout: float = 60.0) -> str:
    """CLI 를 실행하고 stdout(텍스트)을 반환. 절대경로로 실행."""
    proc = await asyncio.create_subprocess_exec(
        *cli_argv(),
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


# CLI 가 "그 잡은 없다"고 **말한** 형태만 삭제로 본다. 실측(CLI 1.1.24, 2026-09-12):
# 없는 잡 → stdout 비어 있고 stderr `Error: Job not found`, 종료코드 3. 잘못된 id →
# `Error: invalid id: ...`. 즉 정상 잡의 stdout(JSON)에는 이 형태가 나타나지 않는다.
_JOB_NOT_FOUND_RE = re.compile(r"\berror:\s*job not found\s*$", re.IGNORECASE | re.MULTILINE)


def _error_text(job: dict[str, Any]) -> Optional[str]:
    """공급자 응답에서 실패 사유를 **문자열로** 꺼낸다.

    값이 dict/list 면 그대로 흘려보내지 않는다 — SQLite 바인딩에서 터지면 그 잡 한 건이
    SAVEPOINT 로 롤백되고(적재 누락), 단건 경로는 예외가 호출자까지 올라간다."""
    for key in ("error", "error_message", "failure_reason", "fail_reason",
                "reason", "detail", "message"):
        value = job.get(key)
        if isinstance(value, str):
            if value.strip():
                return value
            continue
        if value is None or value == "" or value == [] or value == {}:
            continue
        try:
            return json.dumps(value, ensure_ascii=False)[:600]
        except (TypeError, ValueError):
            return str(value)[:600]
    return None


def _says_job_not_found(text: str) -> bool:
    """CLI 의 not-found **통보**인가. 본문 아무 데나 있는 문자열로 판정하지 않는다.

    ★2026-09-12 재현: 종전엔 응답 전문에서 "job not found" 를 찾아, 프롬프트에 그 문구가
     들어간 **살아 있는 생성물**이 삭제로 판정됐다(status=completed·result_url 있음인데
     False). 그 False 는 곧바로 휴지통 이동(usecases/hf_missing.py)으로 이어진다.

    ★줄 끝에 고정한다(코덱스 리뷰): `Error: Job not found in cache; retry upstream` 같은
     **다른 뜻의 메시지**가 부분일치로 통과하면 같은 오삭제가 난다.
    """
    return bool(_JOB_NOT_FOUND_RE.search(text or ""))


async def job_exists(job_id: str, timeout: float = 30.0) -> Optional[bool]:
    """힉스필드에 이 잡이 아직 있나? generate get <id> 결과로 판정.
    True=있음, False=삭제됨(CLI 가 not-found 라고 통보), None=확인불가(→ 상태 변경 금지)."""
    try:
        raw = (await _run("generate", "get", job_id, "--json", timeout=timeout)).strip()
    except CLIError as e:
        # 삭제된 잡은 CLI 가 비정상종료 + stderr not-found 로 알린다(rc≠0 → _run 이 CLIError).
        # 그 외(타임아웃·네트워크·PATH 등)는 확인불가(None) 로 두어 일시 오류로 멀쩡한 걸
        # 지우지 않게 한다. 이 경로의 인자는 `generate get <id> --json` 뿐이라 프롬프트가 섞이지 않는다.
        return False if _says_job_not_found(str(e)) else None
    # ★정상 잡 JSON 이 있으면 **그것이 답이다.** 문자열 검색을 먼저 하면 안 된다(위 주석).
    # ★정상 종료(rc=0)의 stdout 은 **잡 JSON 이 아니면 확인불가**로 둔다(코덱스 리뷰).
    #  실측상 not-found 는 stdout 으로 오지 않는다(stderr + rc=3). 그래서 여기서 문자열을
    #  보는 것은 참을 만들지 못하고 거짓 양성만 만든다 — 잘린 JSON·프록시 오류 본문이
    #  그 문구를 품으면 멀쩡한 생성물이 사라진다.
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    # 물어본 잡을 돌려줬을 때만 '있다'로 확정한다. 다른 잡·id 없음은 이 잡의 생사를
    # 말해 주지 않으므로 None(상태 변경 금지)이 정직하다.
    returned = str(data.get("id") or "").strip()
    if returned and returned.lower() == str(job_id).strip().lower():
        return True
    return None


async def get_job_raw(job_id: str, timeout: float = 30.0) -> Optional[dict[str, Any]]:
    """generate get <id> --json → 원시 잡 dict(없음/확인불가면 None). 재조정(하우스 계정)용 —
    job_exists 는 True/False 만 주지만 이건 status·result_url 이 담긴 실제 잡을 돌려준다.
    삭제/타임아웃/파싱실패는 None(상태 변경 금지). 호출부가 parse_job 으로 정규화한다."""
    try:
        raw = (await _run("generate", "get", job_id, "--json", timeout=timeout)).strip()
    except CLIError:
        return None
    if not raw or _says_job_not_found(raw):
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) and data.get("id") else None


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
          asset: {type, file_path, thumbnail_url, min_result_url} | None,
          references: [{id, type, file_path, role}],
        }
    """
    from ..models import AUDIO_MODELS_V1, AUDIO_PARAMS, TTS_MODELS, VIDEO_VOICE_MODELS, VIDEO_VOICE_PARAMS, audio_stored_params
    model = job.get("job_set_type") or job.get("job_type") or job.get("model")
    params = audio_stored_params(model, job.get("params") or {})
    if model in VIDEO_VOICE_MODELS:
        # 입력 영상 객체(input_video)·folder_id 는 params 로 저장하지 않는다 — 재생성이 그대로 복사해 거부된다.
        params = {key: value for key, value in params.items() if key in VIDEO_VOICE_PARAMS[model]}
    result_url = job.get("result_url")
    # 결과 배열만 읽는다. params의 입력 미디어는 결과로 승격하지 않는다.
    if not result_url:
        outputs = job.get("outputs") or job.get("results")
        if isinstance(outputs, list):
            for output in outputs:
                if not isinstance(output, dict):
                    continue
                url = output.get("url") or output.get("rawUrl") or output.get("result_url")
                if isinstance(url, str) and url:
                    result_url = url
                    if output.get("type") in ("image", "video", "audio"):
                        job = {**job, "result_media_type": output["type"]}
                    break

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
    medias = params.get("medias")
    for m in medias if isinstance(medias, list) else []:  # MCP/덤프의 malformed medias(문자열 등)는 무시
        data = m.get("data") if isinstance(m, dict) else None
        url = data.get("url") if isinstance(data, dict) else None
        if not isinstance(url, str) or not url:
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
        # MCP 이력 항목(mcp_item_to_cli)은 result_media_type 으로 타입을 명시한다 — 확장자 없는 영상 URL 이
        # image 로 오분류돼 입력 축소본이 썸네일로 저장되지 않게 명시값(image|video)을 확장자 판정보다 우선.
        explicit_type = job.get("result_media_type") or job.get("type")
        model = job.get("job_set_type") or job.get("job_type") or job.get("model")
        if explicit_type not in ("image", "video", "audio") and "." not in urlsplit(result_url).path.rsplit("/", 1)[-1]:
            explicit_type = "audio" if model in TTS_MODELS else "video" if model in VIDEO_VOICE_MODELS else explicit_type
        asset = {
            "type": explicit_type
            if explicit_type in ("image", "video", "audio")
            else media_type_from_url(result_url),
            "file_path": result_url,
            # CLI 1.x: 영상 잡은 thumbnail_url(정적 포스터 이미지)을 준다. 영상 asset 의 thumbnail_path
            # 로 써서 그리드/팝업에 가벼운 포스터를 붙인다(우리 썸네일러는 영상 미지원).
            "thumbnail_url": None if explicit_type == "audio" else job.get("thumbnail_url"),
            # 이미지 잡은 min_result_url(경량 축소본)을 준다. 원격 이미지 썸네일로 이걸 쓰면 팀 browse
            # 시 원본 full 을 통째로 받지 않아 디스크를 아낀다(원본 보존은 완료 저장이 선별로 담당).
            "min_result_url": None if explicit_type == "audio" else job.get("min_result_url"),
        }

    return {
        "generation": {
            "id": job.get("id"),
            "prompt": params.get("prompt") or "(제목 없음)",
            # CLI 1.x 는 generate 출력의 모델키를 job_set_type → job_type 로 개명. 둘 다 수용
            # (구버전 job_set_type / 신버전 job_type). 내부 표준 필드명은 계속 model=job_set_type.
            "model": job.get("job_set_type") or job.get("job_type"),
            "display_name": job.get("display_name"),
            "params": ({key: value for key, value in params.items() if key in AUDIO_PARAMS[model]}
                       if model in AUDIO_MODELS_V1 and "dialogue" not in params else params),
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
            # ★2026-09-14 실측(CLI 1.1.24, 목록 100건 중 실패 4건): 응답 최상위 키는 created_at·
            #  display_name·id·job_type·min_result_url·params·result_url·status 뿐이고 오류 키가
            #  **하나도 없다**(generate get 단건도 같음). 지금 여기서 건지는 것은 없고, 사유는 우리가
            #  만든다(CLI 실패 문구·복구 경로). 필드가 생길 때를 대비해 탐색은 남긴다.
            "error": _error_text(job),
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


_MODEL_FRESH_TTL = 300.0
# params 캐시와 같은 1시간은 운영 절충치이며 검증된 안전값은 아니다.
_MODEL_MAX_AGE = 3600.0
_MODEL_RETRY_DELAY = 60.0
_model_log = logging.getLogger(__name__ + ".models")


@dataclass
class _ModelRefreshState:
    task: asyncio.Task[Any] | None = None
    retry_at: float = 0.0
    stopping: bool = False


_model_refresh_states: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, _ModelRefreshState
] = weakref.WeakKeyDictionary()


def _model_refresh_state() -> _ModelRefreshState:
    # 호출과 태스크 예약은 해당 이벤트 루프 스레드에서만 수행한다.
    loop = asyncio.get_running_loop()
    state = _model_refresh_states.get(loop)
    if state is None:
        state = _ModelRefreshState()
        _model_refresh_states[loop] = state
    return state


def start_model_refreshes() -> None:
    """새 lifespan에서만 다시 예약을 허용한다. 목록 prewarm은 하지 않는다."""
    state = _model_refresh_state()
    with _inflight_guard:
        calls = _inflight_calls.get(asyncio.get_running_loop(), {})
        active = any(not task.done() for key, task in calls.items()
                     if key == "models" or key.startswith(("params:", "cost:", "voices:", "voice:")))
    if active or (state.task is not None and not state.task.done()):
        raise RuntimeError("Model metadata refresh is still running")
    state.stopping = False


async def shutdown_model_refreshes() -> None:
    """새 예약을 먼저 막고 실제 leader 취소 후 _run의 자식 회수를 기다린다."""
    state = _model_refresh_state()
    already_stopping = state.stopping
    state.stopping = True
    with _inflight_guard:
        calls = _inflight_calls.get(asyncio.get_running_loop(), {})
        tasks = {task for key, task in calls.items()
                 if key == "models" or key.startswith(("params:", "cost:", "voices:", "voice:"))}
    if state.task is not None:
        tasks.add(state.task)
    if tasks:
        if not already_stopping:
            for task in tasks:
                if not task.done():
                    task.cancel()
        # shutdown 자체의 취소도 CLI 회수를 중간에 다시 취소하지 않도록 한다.
        drain = asyncio.gather(*tasks, return_exceptions=True)
        try:
            await asyncio.shield(drain)
        except asyncio.CancelledError:
            await drain
            raise


async def list_models(timeout: float = 60.0) -> list[dict[str, Any]]:
    """5분 신선도, 마지막 성공부터 1시간까지 stale 즉답 + 공유 CLI 갱신."""
    state = _model_refresh_state()
    if state.stopping:
        raise CLIError("Model catalog is shutting down")
    hit = _CALL_CACHE.get("models")
    now = time.monotonic()
    age = now - hit[0] if hit is not None else None
    if hit is not None and age < _MODEL_FRESH_TTL:
        return hit[1]
    stale_allowed = hit is not None and age < _MODEL_MAX_AGE
    task = state.task
    if task is None or task.done():
        # 캐시 없는 조회는 종전처럼 실패 후에도 다시 시도한다.
        if hit is not None and now < state.retry_at:
            if stale_allowed:
                return hit[1]
            raise CLIError("Model catalog expired; refresh retry is delayed")
        task = _single_flight_task("models", lambda: _refresh_models(state, timeout))
        state.task = task  # 강한 참조. 요청별 바깥 태스크를 만들지 않는다.

        def _clear_model_task(done: asyncio.Task[Any]) -> None:
            if state.task is done:
                state.task = None

        task.add_done_callback(_clear_model_task)
    if stale_allowed:
        return hit[1]
    # cold / 상한 초과 / stale 갱신은 모두 위의 models leader에 합류한다.
    return await asyncio.shield(task)


async def _refresh_models(state: _ModelRefreshState, timeout: float) -> list[dict[str, Any]]:
    try:
        result = await _list_models_uncached(timeout)
    except Exception as exc:
        now = time.monotonic()
        hit = _CALL_CACHE.get("models")
        state.retry_at = now + _MODEL_RETRY_DELAY
        # 예외 본문, stderr, traceback에는 토큰/경로가 섞일 수 있다. 종류만 기록한다.
        error_kind = (
            "JSONDecodeError" if isinstance(exc.__cause__, json.JSONDecodeError)
            else type(exc).__name__
        )
        log_event(
            _model_log, "model_catalog_refresh_failed", level=logging.WARNING,
            error_kind=error_kind,
            cache_age_seconds=round(now - hit[0], 3) if hit is not None else None,
            next_retry_at_utc=datetime.fromtimestamp(
                time.time() + _MODEL_RETRY_DELAY, timezone.utc
            ).isoformat(),
        )
        raise CLIError("Model catalog refresh failed") from None
    state.retry_at = 0.0
    return result


async def _list_models_uncached(timeout: float) -> list[dict[str, Any]]:
    data = await _run_json("model", "list", timeout=timeout)
    if not isinstance(data, list):
        raise ValueError("Invalid model catalog response")
    out = []
    for m in data:
        if not isinstance(m, dict):
            continue
        # CLI 1.x model list 는 job_set_type → job_type 로 개명. 둘 다 수용(빈 모델키 방지 = 모델선택 깨짐 방지).
        jst = m.get("job_set_type") or m.get("job_type")
        if not isinstance(jst, str) or not jst.strip():
            continue
        # 키가 유효해도 표시 필드가 객체/숫자면 ModelOut 응답 검증이 실패한다.
        # 선택 키는 보존하고 부가 필드는 기존 기본값으로 정규화한다.
        display_name = m.get("display_name")
        model_type = m.get("type")
        out.append(
            {
                "display_name": display_name if isinstance(display_name, str) and display_name else jst,
                "job_set_type": jst,
                "type": model_type if isinstance(model_type, str) and model_type else "image",
            }
        )
    if not out:
        raise ValueError("Model catalog has no valid model keys")
    _cache_put("models", out)
    return out


_PARAMS_TTL = 3600.0


async def get_model_params(
    job_set_type: str, timeout: float = 60.0, *, allow_stale: bool = False,
) -> dict[str, Any]:
    """1시간 스키마 캐시. 화면은 기존 값을 먼저 받고 같은 갱신에 다시 합류한다."""
    _require_model_id(job_set_type)
    if _model_refresh_state().stopping:
        raise CLIError("Model metadata is shutting down")
    ckey = f"params:{job_set_type}"
    cached = _cache_get(ckey, _PARAMS_TTL)
    if cached is not None:
        return cached
    task = _single_flight_task(
        ckey, lambda: _get_model_params_uncached(ckey, job_set_type, timeout)
    )
    old = _CALL_CACHE.get(ckey)
    if allow_stale and old is not None:
        return {**old[1], "stale": True}
    return await asyncio.shield(task)


async def _get_model_params_uncached(
    ckey: str, job_set_type: str, timeout: float
) -> dict[str, Any]:
    old = _CALL_CACHE.get(ckey)
    try:
        from ..models import VIDEO_VOICE_MODELS
        command = "workflow" if job_set_type == "draw_to_video" or job_set_type in VIDEO_VOICE_MODELS else "model"
        data = await _run_json(command, "get", job_set_type, timeout=timeout)
    except CLIError:
        if old is not None:
            return {**old[1], "stale": True}
        raise
    params = data.get("params") if isinstance(data, dict) else None
    if not isinstance(params, list) or not params or any(
        not isinstance(p, dict) or not isinstance(p.get("name"), str) or not p["name"].strip()
        for p in params
    ):
        if old is not None:
            return {**old[1], "stale": True}
        return {"job_set_type": job_set_type, "type": "image", "params": [],
                "saved_at": None, "stale": True}
    result = {
        "display_name": data.get("display_name"),
        # CLI 1.1.20 model get 도 job_set_type 대신 job_type 을 반환한다. 내부 응답 계약은
        # 계속 job_set_type 으로 유지하되 신·구 CLI 필드를 모두 받는다.
        "job_set_type": data.get("job_set_type") or data.get("job_type") or job_set_type,
        "type": data.get("type") or "image",
        "params": params,
        "saved_at": time.time(),
        "stale": False,
    }
    if job_set_type in {"elevenlabs_v4", "elevenlabs_v4_turbo"}:
        # 화면·MCP는 저장용 목소리 필드를 받고, CLI 전송 때만 dialogue로 변환한다.
        result["params"] = [*params,
                            {"name": "voice_id", "type": "string", "default": None, "required": True},
                            {"name": "voice_type", "type": "string", "default": None, "required": True, "enum": ["preset"]}]
    _cache_put(ckey, result)
    _PARAM_NAMES_CACHE[job_set_type] = {p["name"] for p in params}
    _PARAM_NAMES_SAVED_AT[job_set_type] = _CALL_CACHE[ckey][0]
    _PARAM_NAMES_RETRY_AT.pop(job_set_type, None)
    return result


# 모델별 허용 파라미터 이름 캐시(스키마와 같은 TTL). 동기화/재사용 시 힉스필드가 채운
# 잔여 필드(width/height/batch_size/input_images …)가 --param 으로 새어 나가 CLI 가
# "Unknown params" 로 거부하는 것을 막는다.
# 조회 실패는 캐시하지 않는다(RL-24) — CLI 일시 장애 한 번이 프로세스 수명 내내
# "필터 없음"으로 굳지 않게, 짧은 TTL 뒤 다음 호출에서 다시 조회한다.
_PARAM_NAMES_CACHE: dict[str, set[str]] = {}
_PARAM_NAMES_SAVED_AT: dict[str, float] = {}
_PARAM_NAMES_RETRY_AT: dict[str, float] = {}
_PARAM_NAMES_FAIL_TTL = 120.0


async def _allowed_param_names(model: str, *, allow_stale: bool = False) -> set[str]:
    """모델이 받는 파라미터 이름 집합. 조회 실패 시 빈 집합(→ 필터하지 않음=전부 전송)."""
    cached = _PARAM_NAMES_CACHE.get(model)
    now = time.monotonic()
    if cached is not None and (allow_stale or now - _PARAM_NAMES_SAVED_AT.get(model, now) < _PARAMS_TTL):
        return cached
    retry_at = _PARAM_NAMES_RETRY_AT.get(model)
    if retry_at is not None and time.monotonic() < retry_at:
        return cached if cached is not None else set()
    try:
        data = await get_model_params(model)
    except CLIError:
        _PARAM_NAMES_RETRY_AT[model] = time.monotonic() + _PARAM_NAMES_FAIL_TTL
        return cached if cached is not None else set()
    if data.get("stale"):
        _PARAM_NAMES_RETRY_AT[model] = time.monotonic() + _PARAM_NAMES_FAIL_TTL
        return cached if cached is not None else set()
    _PARAM_NAMES_RETRY_AT.pop(model, None)
    names = {p.get("name") for p in data.get("params", []) if isinstance(p, dict) and p.get("name")}
    if names:
        _PARAM_NAMES_CACHE[model] = names
        _PARAM_NAMES_SAVED_AT[model] = _CALL_CACHE.get(f"params:{model}", (time.monotonic(), None))[0]
    else:
        # 빈 폴백 스키마를 프로세스 수명 캐시로 박제하지 않는다(R5 2-C1, 코덱스 적발) —
        # get_model_params 가 비-dict 응답에 빈 params 를 돌려준 경우 종전엔 set() 이
        # 영구 캐시돼 '필터 없음'이 굳었다. 실패 백오프와 같은 TTL 로 재조회한다.
        _PARAM_NAMES_RETRY_AT[model] = time.monotonic() + _PARAM_NAMES_FAIL_TTL
    return names


async def _param_args(
    model: str, params: Optional[dict[str, Any]], *, allow_stale: bool = False,
) -> list[str]:
    """params → CLI --플래그. 모델 스키마 밖 키·복합 타입(list/dict)·prompt 는 제외.
    스키마를 못 받았으면(빈 집합) 이름 필터를 적용하지 않는다 — 전부 비워 기본값으로
    엉뚱하게 생성(크레딧 소모)되는 것보다 기존 동작 유지가 안전(advisor)."""
    allowed = (await _allowed_param_names(model, allow_stale=True) if allow_stale
               else await _allowed_param_names(model))
    if model == "seedance_2_5" and allowed:
        # A cached pre-Draft schema must not change the quoted or submitted mode.
        allowed = allowed | {"draft", "draft_job_id"}
    from ..models import audio_cli_params
    params = audio_cli_params(model, str((params or {}).get("prompt", "")), params or {})
    out: list[str] = []
    for k, v in (params or {}).items():
        if v is None or v == "":
            continue
        if k == "prompt":  # 프롬프트는 --prompt 로 따로 전달
            continue
        if k == "dialogue" and model in {"elevenlabs_v4", "elevenlabs_v4_turbo"}:
            out += ["--dialogue", json.dumps(v, ensure_ascii=False)]
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
# 비용 견적 영속 캐시 — 파일(DATA_DIR/cost_cache_v2.json)에 (모델+옵션)→(크레딧, 저장시각)을 보관.
# 재시작·새 탭·재방문 시 CLI 재호출 없이 즉시. TTL 이 지난 항목은 다음 조회 때 CLI 로 재확인해
# 힉스필드 가격 변동을 자동 반영한다(bat·수동 갱신 불필요).
# ★v2 로 파일을 갈아탄 이유(2026-09-11): v1 은 값을 **정수로 반올림해** 저장했다. 22.5 를 22 로,
#  1.5 를 2 로 적어 둔 항목이 그대로 남아 있어, 소수를 살린 새 코드로 읽어도 복원되지 않는다
#  (기본 TTL 7일이라 일주일 동안 옛 값이 이긴다). 새 이름으로 시작해 옛 파일은 건드리지 않는다.
_COST_CACHE_FILE = DATA_DIR / "cost_cache_v2.json"
_COST_CACHE: dict[str, tuple[float, float]] = {}  # key → (credits, saved_epoch)
_COST_CACHE_MAX = 4096
_COST_TTL = float(os.environ.get("CONTENT_HUB_COST_TTL", 12 * 3600))
_cost_loaded = False


def _valid_cost(value: Any) -> Optional[float]:
    """CLI 가 준 크레딧을 검증한다 — **소수를 그대로 살린다**.

    ★2026-09-11 실측: 견적도 실제 청구도 소수다(`generate cost seedance_2_0` = 22.5,
     거래 `Nano Banana 2` = −1.5, `Higgsfield Soul V2` = −0.12). 종전엔 여기서 정수로
     반올림해 −1.5 를 2 로(33% 과대), −0.12 를 0 으로(전액 소실) 적었다.
    bool 은 int 의 하위형이라 따로 막는다(True 가 1.0 으로 새면 가짜 가격이 된다).
    NaN·무한대·음수는 가격이 아니다 — 견적은 0 이상이고, 거래의 부호는 호출부가 다룬다."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0:
        return None
    return number


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


def _cost_key(model: str, param_args: list[str], prompt: str = "") -> str:
    # 키는 '실제 CLI 로 나가는 인자'(_param_args 결과)만으로 만든다 — 스키마 밖 잔여값
    # (medias/prompt/width/height …)은 CLI 호출에서 걸러지므로 키에도 없어야 비용이 같은 조합의
    # 캐시가 쪼개지지 않는다(키↔호출 일치). 순서 무관하게 (플래그,값) 쌍을 정렬.
    pairs = sorted(
        (param_args[i], param_args[i + 1]) for i in range(0, len(param_args) - 1, 2)
    )
    key = model + "|" + ";".join(f"{k}={hashlib.sha256(v.encode('utf-8')).hexdigest() if k == '--dialogue' else v}" for k, v in pairs)
    from ..models import TTS_MODELS
    if model in TTS_MODELS:
        key += "|prompt_sha256=" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    return key


_cost_load_lock = threading.Lock()


def _load_cost_cache() -> None:
    """부팅 후 최초 조회 때 파일에서 캐시를 1회 로드한다(멱등). 게이트 밖에서 불리므로
    (R5 2-C2) load-once 를 lock 으로 동기화한다 — 종전 의미(실패해도 재시도 없음) 유지."""
    global _cost_loaded
    if _cost_loaded:
        return
    with _cost_load_lock:
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
                credits = _valid_cost(v[0])
                if credits is None:
                    continue  # 손상·옛 형식 항목은 버린다(다음 조회에서 CLI 로 다시 받는다)
                try:
                    _COST_CACHE[k] = (credits, float(v[1]))
                except (TypeError, ValueError):
                    pass


def _serialize_cost_cache() -> str:
    """메인(호출) 스레드에서 dict 스냅샷을 직렬화 — to_thread 안에서 _COST_CACHE 를 순회하면
    다른 코루틴의 갱신과 'dict changed during iteration' 경쟁이 날 수 있어 여기서 미리 만든다."""
    return json.dumps({k: [c, t] for k, (c, t) in _COST_CACHE.items()}, ensure_ascii=False)


def _write_cost_cache(payload: str) -> bool:
    """직렬화된 문자열만 디스크에 원자적 저장 — 호출부가 asyncio.to_thread 로 실행(루프 비블로킹).
    성공 여부를 반환한다(R5 2-D) — 실패면 호출부가 saved revision 을 안 올려 dirty 가 유지된다."""
    try:
        atomic_write_text(_COST_CACHE_FILE, payload)
        return True
    except OSError:
        return False


# ── 비용 캐시 저장 debounce(R5 2-D) ──────────────────────────────────────
# 종전엔 새 키 성공마다 전체 dict 를 직렬화·원자 저장해 K개 신규 키 burst 가 O(K²)
# 쓰기 증폭을 만들었다. 이벤트 루프당 '추적되는 writer 태스크 1개'만 두고(코덱스 P1 —
# 미추적 다중 writer 는 종료 flush 와 경합해 과거 스냅샷이 최신 파일을 되덮었다),
# writer 는 write lock 안에서 debounce 후 최신 revision 스냅샷을 기록한다. 지속 burst
# 최대 미저장 시간 ≈ debounce(1s)+쓰기 시간. 쓰기 실패는 saved 미갱신 = dirty 유지 →
# 재시도는 다음 변경 또는 종료 flush(실패 무한 루프 방지). flush 는 같은 write lock
# 으로 진행 중 writer 와 직렬화되고, revision 단조 증가 가드로 역순 덮어쓰기가 없다.
_COST_DEBOUNCE_SECONDS = 1.0
_cost_dirty_revision = 0
_cost_saved_revision = 0
_cost_writer_tasks: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, "asyncio.Task[None]"
] = weakref.WeakKeyDictionary()


def _mark_cost_cache_dirty() -> None:
    global _cost_dirty_revision
    _cost_dirty_revision += 1


def _ensure_cost_writer() -> None:
    """루프당 writer 태스크를 1개만 유지한다(무제한 태스크 누적 방지). 이벤트 루프
    스레드에서만 호출되므로 확인-생성 사이 경합이 없다. writer 종료 직전의 새 dirty 는
    다음 변경의 재호출 또는 종료 flush 가 담는다."""
    loop = asyncio.get_running_loop()
    task = _cost_writer_tasks.get(loop)
    if task is not None and not task.done():
        return
    task = loop.create_task(_cost_writer())
    task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
    _cost_writer_tasks[loop] = task


async def _cost_writer() -> None:
    """단일 writer — dirty 가 남는 한 debounce 주기로 최신 스냅샷을 기록한다.
    쓰기 실패면 1회로 중단(dirty 유지 — 다음 변경/flush 가 재시도)."""
    global _cost_saved_revision
    while True:
        async with _cost_write_lock():
            if _cost_saved_revision >= _cost_dirty_revision:
                return
            await asyncio.sleep(_COST_DEBOUNCE_SECONDS)  # burst 합류 창(lock 안 — flush 와 직렬)
            snapshot_revision = _cost_dirty_revision
            payload = _serialize_cost_cache()
            if not await asyncio.to_thread(_write_cost_cache, payload):
                return
            _cost_saved_revision = snapshot_revision


async def flush_cost_cache(timeout: float = 3.0) -> None:
    """종료 훅 — 미저장 비용 캐시를 상한 시간 안에 저장. write lock 을 잡아 진행 중
    writer 의 쓰기와 직렬화한다(과거 스냅샷이 flush 결과를 되덮는 역전 방지).
    실패·시간초과는 무시한다(견적 캐시는 보조 정보)."""

    async def _flush_locked() -> None:
        global _cost_saved_revision
        async with _cost_write_lock():
            if _cost_saved_revision >= _cost_dirty_revision:
                return
            snapshot_revision = _cost_dirty_revision
            payload = _serialize_cost_cache()
            if await asyncio.to_thread(_write_cost_cache, payload):
                _cost_saved_revision = snapshot_revision

    try:
        await asyncio.wait_for(_flush_locked(), timeout=timeout)
    except (asyncio.TimeoutError, OSError):
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
    *, allow_stale: bool = False, include_metadata: bool = False, video_ref: Optional[str] = None,
) -> dict[str, Any]:
    """잡 생성 없이 크레딧만 추정 — generate cost <model> [--param value] --json.
    레퍼런스(미디어)는 비용 추정에 불필요+업로드 비용 → 제외(PV 와 동일).
    동일 (모델·옵션) 결과는 캐시(CLI 재호출 없이 즉시) — 비용은 결정적이라 안전."""
    # 게이트 경계(R5 2-C2, 코덱스 확정): '스키마가 CLI 없이 확정된 비용 캐시 히트'만
    # semaphore-free 로 즉시 반환한다 — 종전엔 캐시 응답도 동시 2개 게이트 뒤에 줄서
    # 느린 CLI 견적이 즉시 응답을 막았다. 스키마 miss 가능 경로는 게이트 안에서만 CLI 를
    # 부른다(게이트 밖 무제한 model get 방지).
    _require_model_id(model)
    from ..models import TTS_MODELS, VIDEO_VOICE_MODELS, validate_media_request, video_voice_cost_context
    if model in VIDEO_VOICE_MODELS:
        # 견적은 cost_params(길이·번역 fps)만 받는다 — 생성 옵션·파일·prompt 를 넣으면 CLI 가 거부한다(10-28 실측).
        ctx = video_voice_cost_context(model, params or {})
        if ctx is None:
            raise CLIError("영상 길이를 확인할 수 없어 견적을 낼 수 없습니다")
        params = {"duration": ctx["duration"], **({"fps": ctx["fps"]} if "fps" in ctx else {})}
    if model in TTS_MODELS:
        try:
            validate_media_request(model, prompt, params or {}, [])
        except ValueError as exc:
            raise CLIError(str(exc)) from None
        params = {**(params or {}), "prompt": prompt}
    if model == "draw_to_video":
        params = {key: value for key, value in (params or {}).items() if key in {"duration", "resolution"}}
    if _model_refresh_state().stopping:
        raise CLIError("Model metadata is shutting down")
    if model == "seedance_2_5" and not (params or {}).get("draft_job_id"):
        from .seedance_draft import fresh_params
        params = fresh_params(model, params)
    _load_cost_cache()
    now = time.monotonic()
    cached_names = model in _PARAM_NAMES_CACHE and (
        allow_stale or now - _PARAM_NAMES_SAVED_AT.get(model, now) < _PARAMS_TTL
    )
    if model in VIDEO_VOICE_MODELS:
        # 생성 스키마(params)에 없는 cost_params 라 이름 필터(_param_args)를 거치지 않는다.
        param_args = [arg for key, value in params.items() for arg in (f"--{key}", format(value, "g"))]
    elif cached_names:
        # 화면의 기존 견적은 캐시한 이름으로 즉답; 스키마 갱신은 params 조회가 담당한다.
        param_args = (await _param_args(model, params, allow_stale=True) if allow_stale
                      else await _param_args(model, params))
    else:
        async with _estimate_gate():
            param_args = await _param_args(model, params)
    # 영상 수정 견적은 고칠 영상이 있어야 한다(없으면 CLI 가 거절) — 화면이 그 영상의 힉스필드 작업 id 를 준다.
    #  값은 영상 길이를 따르므로 캐시 키에도 들어간다(10-28 실측: Kling 3.0 Omni Edit pro 4초 8·8초 16).
    if video_ref and model in _VIDEO_EDIT_COST_MODELS:
        param_args = [*param_args, "--video-references", video_ref]
    key = _cost_key(model, param_args, prompt)
    entry = _COST_CACHE.get(key)
    if entry is not None and (time.time() - entry[1]) < _COST_TTL:
        return _cost_result(entry) if include_metadata or allow_stale else {"credits": entry[0]}
    if _model_refresh_state().stopping:
        raise CLIError("Model metadata is shutting down")
    # 같은 (모델·옵션) 동시 miss 는 leader 1명의 CLI 실행에 합류(비용은 프롬프트 무관 계약)
    task = _single_flight_task(
        f"cost:{key}",
        lambda: _estimate_cost_miss(key, model, param_args, prompt, timeout),
    )
    if allow_stale and entry is not None:
        return _cost_result(entry)
    result = await asyncio.shield(task)
    return result if include_metadata or allow_stale else {"credits": result["credits"]}


def _cost_result(entry: tuple[float, float]) -> dict[str, Any]:
    return {"credits": entry[0], "saved_at": entry[1],
            "stale": time.time() - entry[1] >= _COST_TTL}


# 참조 필수 모드의 견적용 더미 참조(2026-08-31 실측) — 씨댄스 2.5 는 mode 별 "참조 미디어 ≥1"
# 규칙을 견적(generate cost)에도 적용해, 참조를 뺀 우리 견적 호출이 거부된다. cost 는 참조
# '개수'만 검사하고 실체는 열어보지 않으며(가짜 UUID 통과), 가격도 모드·참조와 무관하다
# (t2v=omni_reference=video_extension 동일). 껍데기 UUID 하나로 규칙만 통과시킨다.
# video_edit 는 입력 영상의 실제 길이가 가격을 정해 더미 불가 — 견적 실패(=미표시)가 정직하다.
_COST_DUMMY_REF = "00000000-0000-4000-8000-000000000000"
_COST_REF_REQUIRED_MODES = {
    "omni_reference": "--image-references",
    "video_extension": "--video-references",
}
# 수정 창이 고칠 영상(작업 id·업로드 id)을 견적에 붙이는 모델 — 위 더미와 달리 진짜 영상이라 길이대로 값이 나온다.
_VIDEO_EDIT_COST_MODELS = frozenset({"kling_video_edit", "kling4_0", "seedance_2_5"})


def _cost_dummy_ref_args(param_args: list[str]) -> list[str]:
    """견적 인자의 --mode 가 참조 필수 모드면 그 모드가 요구하는 더미 참조 플래그를 돌려준다."""
    try:
        mode = param_args[param_args.index("--mode") + 1]
    except (ValueError, IndexError):
        return []
    flag = _COST_REF_REQUIRED_MODES.get(mode)
    return [flag, _COST_DUMMY_REF] if flag else []


async def _estimate_cost_miss(
    key: str,
    model: str,
    param_args: list[str],
    prompt: str,
    timeout: float,
) -> dict[str, Any]:
    async with _estimate_gate():  # leader 만 세마포어 취득
        entry = _COST_CACHE.get(key)
        if entry is not None and (time.time() - entry[1]) < _COST_TTL:
            return _cost_result(entry)
        from ..models import VIDEO_VOICE_MODELS
        workflow = model == "draw_to_video" or model in VIDEO_VOICE_MODELS
        no_prompt = model in {"elevenlabs_v4", "elevenlabs_v4_turbo"} or model in VIDEO_VOICE_MODELS
        args: list[str] = [
            "generate", "cost",
            *(["workflow"] if workflow else []), model,
            *([] if no_prompt else ["--prompt", _shield_json_prompt(prompt or "preview")]),
        ]
        args += param_args
        # 캐시 키(param_args 기준)는 더미와 무관하게 유지 — CLI 호출에만 끼운다.
        if not workflow:
            args += _cost_dummy_ref_args(param_args)
        try:
            data = await _run_json(*args, timeout=timeout)
        except CLIError:
            # 가격 갱신은 생성 자체가 아닌 보조 정보다. CLI/네트워크가 잠깐 불안정할 때
            # 이미 검증한 예전 가격까지 버려 502를 내면 화면의 예상 크레딧이 깜박이고
            # 서버 로그도 불필요하게 오염된다. 만료된 값이라도 있으면 이번 한 번은
            # 안전한 폴백으로 쓰고, 다음 조회에서 다시 최신 가격 갱신을 시도한다.
            if entry is not None:
                return _cost_result(entry)
            raise
        # ★응답이 이상하면 **0 을 지어내지 않는다**(2026-09-11). 종전엔 캐시가 없을 때 0 을
        #  돌려줘 화면·장부에 '무료'로 적혔다. 0 은 정상 가격이기도 해서 실패와 구분되지 않는다.
        #  옛 값이 있으면 그걸 쓰고, 없으면 실패를 그대로 알린다(호출부가 '견적 없음'으로 표시).
        if not isinstance(data, dict):
            if entry is not None:
                return _cost_result(entry)
            raise CLIError(f"견적 응답이 JSON 객체가 아닙니다: {model}")
        credits = data.get("credits_exact")
        if credits is None:
            credits = data.get("credits")
        credits_value = _valid_cost(credits)
        if credits_value is None:
            if entry is not None:
                return _cost_result(entry)
            raise CLIError(f"견적 금액을 읽을 수 없습니다: {model} ({credits!r})")
        if key not in _COST_CACHE and len(_COST_CACHE) >= _COST_CACHE_MAX:
            oldest = min(_COST_CACHE, key=lambda cached_key: _COST_CACHE[cached_key][1])
            _COST_CACHE.pop(oldest)
        _COST_CACHE[key] = (credits_value, time.time())  # TTL 만료분 재확인 시 최신값·시각으로 갱신
        _mark_cost_cache_dirty()
        # 저장은 루프당 단일 writer 태스크가 백그라운드로(R5 2-D) — 응답·게이트를
        # debounce 만큼 잡지 않고, 태스크 누적·flush 역전도 없다(코덱스 P1 반영).
        _ensure_cost_writer()
        return _cost_result(_COST_CACHE[key])


async def list_voices(timeout: float = 30.0, *, cursor: str | None = None) -> dict[str, Any]:
    if _model_refresh_state().stopping:
        raise CLIError("Model metadata is shutting down")
    key = "voices:" + (cursor or "")
    cached = _cache_get(key, _PARAMS_TTL)
    if cached is not None:
        return cached

    async def load():
        try:
            data = await _run_json("voices", "list", "--size", "100", *(["--cursor", cursor] if cursor else []), timeout=timeout)
        except CLIError as exc:
            _log_cli_query_failure("voices", exc)
            raise CLIError("목소리 목록을 확인할 수 없습니다") from None
        items = data if isinstance(data, list) else data.get("items", data.get("voices")) if isinstance(data, dict) else None
        if not isinstance(items, list):
            _log_cli_query_failure("voices", "invalid response")
            raise CLIError("목소리 목록을 확인할 수 없습니다")
        result = {"items": [voice for voice in items if isinstance(voice, dict) and voice.get("id") and voice.get("voice_type") == "preset"],
                  "cursor": data.get("cursor") if isinstance(data, dict) else None}
        _cache_put(key, result)
        return result

    return await _single_flight(key, load)


async def get_voice(voice_id: str, timeout: float = 30.0) -> dict[str, Any]:
    if _model_refresh_state().stopping:
        raise CLIError("Model metadata is shutting down")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", voice_id):
        raise CLIError("목소리 ID가 올바르지 않습니다")
    key = "voice:" + voice_id
    cached = _cache_get(key, _PARAMS_TTL)
    if cached is not None:
        return cached

    async def load():
        try:
            data = await _run_json("voices", "get", voice_id, timeout=timeout)
        except CLIError as exc:
            _log_cli_query_failure("voice", exc)
            raise CLIError("목소리를 확인할 수 없습니다") from None
        if not isinstance(data, dict) or data.get("id") != voice_id or data.get("voice_type") != "preset":
            _log_cli_query_failure("voice", "invalid response")
            raise CLIError("공식 프리셋 목소리를 확인할 수 없습니다")
        _cache_put(key, data)
        return data

    return await _single_flight(key, load)


async def validate_media_submission(model: str, prompt: str, params: dict, references: list) -> None:
    from ..models import (MEDIA_V2_MODELS, AUDIO_MODELS_V1, TTS_MODELS, VIDEO_VOICE_MODELS, audio_cli_params,
                          validate_media_request, video_voice_cli_params)
    validate_media_request(model, prompt, params, references)
    if model not in MEDIA_V2_MODELS | AUDIO_MODELS_V1 | VIDEO_VOICE_MODELS:
        return
    schema = await get_model_params(model)
    if schema.get("stale"):
        raise CLIError("생성 옵션을 새로 확인할 수 없습니다. 잠시 후 다시 시도하세요")
    definitions = {p["name"]: p for p in schema.get("params", [])}
    wire = video_voice_cli_params(params) if model in VIDEO_VOICE_MODELS else audio_cli_params(model, prompt, params)
    for key, value in wire.items():
        definition = definitions.get(key)
        if not definition or definition.get("enum") and str(value) not in {str(item) for item in definition["enum"]}:
            raise ValueError("현재 모델이 지원하지 않는 옵션입니다")
    if (model in TTS_MODELS or model == "voice_change") and params.get("voice_id"):
        await get_voice(params["voice_id"])


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
    except CLIError as exc:
        kind = _log_cli_query_failure("account_status", exc)
        return {"connected": False, "credits": None, "email": "", "plan": "", "error_kind": kind}
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("email"), str) or not data["email"].strip():
        kind = _log_cli_query_failure("account_status", data)
        return {"connected": False, "credits": None, "email": "", "plan": "", "error_kind": kind}
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
_CLI_QUERY_FAILURES = {
    "auth": ("Higgsfield 로그인 정보를 확인할 수 없습니다.", "Higgsfield CLI에 다시 로그인하세요."),
    "permission": ("Higgsfield 조회 권한이 없습니다.", "선택한 계정과 과금 공간의 권한을 확인하세요."),
    "network": ("Higgsfield 통신이 일시적으로 실패했습니다.", "연결을 확인한 뒤 다시 시도하세요."),
    "invalid": ("Higgsfield 응답 형식을 확인할 수 없습니다.", "CLI 버전과 Host 콘솔을 확인하세요."),
}


def _log_cli_query_failure(operation: str, error: Any) -> str:
    """원문은 분류에만 쓰고 콘솔에는 고정된 사유·조치만 남긴다."""
    text = str(error).lower()
    if re.search(
        r"not authenticated|unauthorized|authentication (?:required|failed)|auth login|"
        r"(?:session|access token|authentication token) (?:has )?expired|"
        r"invalid (?:access|authentication|auth) token|"
        r"(?:http(?: status(?: code)?)?|status(?:_code)?)[\s:=\"']*401\b", text,
    ):
        kind = "auth"
    elif re.search(
        r"forbidden|permission denied|access denied|you (?:do not|don't) have (?:access|permission)|"
        r"(?:http(?: status(?: code)?)?|status(?:_code)?)[\s:=\"']*403\b", text,
    ):
        kind = "permission"
    elif re.search(
        r"timeout|timed out|타임아웃|etimedout|econn|connection|network|dns|tls|certificate|"
        r"service unavailable|bad gateway|rate limit|too many requests|"
        r"(?:http(?: status(?: code)?)?|status(?:_code)?)[\s:=\"']*(?:429|5\d\d)\b", text,
    ):
        kind = "network"
    else:
        kind = "invalid"
    reason, action = _CLI_QUERY_FAILURES[kind]
    log_event(logging.getLogger(__name__), "cli_query_failed", level=logging.WARNING,
              operation=operation, error_kind=kind, reason=reason, action=action)
    return kind


async def list_workspaces(timeout: float = 30.0) -> list[dict[str, Any]]:
    """워크스페이스 목록 [{id, name, plan_type, credits, is_selected, user_role}].
    선택 안 됨(개인 컨텍스트)이면 모두 is_selected=false.

    ⚠️`is_selected` 는 **'마지막으로 생성한 공간'** 이지 '사용자가 고른 공간' 이 아니다(2026-09-11).
     허브는 더 이상 CLI 전역을 바꾸지 않고, 에이전트가 제출 직전에 요청의 공간으로 맞춘다.
     앱의 선택은 앱이 소유한다 — 이 값을 앱 선택으로 채택하면 방금 고른 공간이 되돌아간다."""
    return await _single_flight("workspaces", lambda: _list_workspaces_uncached(timeout))


async def _list_workspaces_uncached(timeout: float) -> list[dict[str, Any]]:
    try:
        data = await _run_json("workspace", "list", timeout=timeout)
    except CLIError as exc:
        kind = _log_cli_query_failure("workspace_list", exc)
        raise CLIError(_CLI_QUERY_FAILURES[kind][0]) from None
    if not isinstance(data, list) or any(not isinstance(row, dict) for row in data):
        kind = _log_cli_query_failure("workspace_list", data)
        raise CLIError(_CLI_QUERY_FAILURES[kind][0])
    return data


# (create_job/get_job 제거 — 푸시 모델에선 서버가 CLI 로 직접 생성하지 않는다. 생성은 각 PC 의
#  push_agent 가 로컬 CLI 로 수행하고 결과만 ingest 로 올린다. 미사용 사장 코드였음.)
