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
import time
from datetime import datetime, timezone
from typing import Any, Optional

from ..config import DATA_DIR
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


class CLIError(RuntimeError):
    """CLI 호출 실패(0이 아닌 종료코드 또는 미설치)."""


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
        proc.kill()
        # kill 후 반드시 회수 — 안 하면 좀비/파이프가 남는다(Windows npm shim 은 자식 트리도 남을 수 있음).
        try:
            await proc.wait()
        except ProcessLookupError:
            pass
        raise CLIError(f"CLI 타임아웃: higgsfield {' '.join(args)}") from e
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
        proc.kill()
        # kill 후 반드시 회수 — 안 하면 좀비/파이프가 남는다(Windows npm shim 은 자식 트리도 남을 수 있음).
        try:
            await proc.wait()
        except ProcessLookupError:
            pass
        raise CLIError(f"CLI 타임아웃: higgsfield {' '.join(args)}") from e
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
    "running": "running",
    "processing": "running",
    "in_progress": "running",
    "nsfw": "nsfw",  # 콘텐츠 차단(결과 없음) — 터미널 상태로 그대로 보존
}

def normalize_status(raw: Optional[str]) -> str:
    """CLI status → 로컬 status. 모르는 값은 그대로 통과(방어적)."""
    if not raw:
        return "pending"
    return _STATUS_MAP.get(raw.lower(), raw.lower())
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
            "status": normalize_status(job.get("status")),
            "created_at": epoch_to_iso(job.get("created_at")),
            "sort_ts": _to_epoch(job.get("created_at")),  # 정밀 정렬키(sub-second 보존)
            "creator_uid": creator_uid,  # 생성자(team 워크스페이스에서 작성자 구분)
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
    """생성 모달용 모델 목록 [{display_name, job_set_type, type}]. 5분 TTL 캐시(거의 불변)."""
    cached = _cache_get("models", 300.0)
    if cached is not None:
        return cached
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
    """모델의 CLI 조절 가능 파라미터 스키마 — model get <job_set_type> --json. 1시간 TTL 캐시(불변)."""
    ckey = f"params:{job_set_type}"
    cached = _cache_get(ckey, 3600.0)
    if cached is not None:
        return cached
    data = await _run_json("model", "get", job_set_type, timeout=timeout)
    if not isinstance(data, dict):
        return {"job_set_type": job_set_type, "type": "image", "params": []}
    result = {
        "display_name": data.get("display_name"),
        "job_set_type": data.get("job_set_type") or job_set_type,
        "type": data.get("type") or "image",
        "params": data.get("params") or [],
    }
    if result["params"]:  # 파라미터를 실제로 받았을 때만 캐시(폴백 빈 스키마는 캐시 안 함)
        _cache_put(ckey, result)
    return result


# 모델별 허용 파라미터 이름 캐시(프로세스 수명). 동기화/재사용 시 힉스필드가 채운
# 잔여 필드(width/height/batch_size/input_images …)가 --param 으로 새어 나가 CLI 가
# "Unknown params" 로 거부하는 것을 막는다.
_PARAM_NAMES_CACHE: dict[str, set[str]] = {}


async def _allowed_param_names(model: str) -> set[str]:
    """모델이 받는 파라미터 이름 집합. 조회 실패 시 빈 집합(→ 필터하지 않음=전부 전송)."""
    if model not in _PARAM_NAMES_CACHE:
        try:
            data = await get_model_params(model)
            _PARAM_NAMES_CACHE[model] = {
                p.get("name") for p in data.get("params", []) if p.get("name")
            }
        except CLIError:
            _PARAM_NAMES_CACHE[model] = set()
    return _PARAM_NAMES_CACHE[model]


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


def _save_cost_cache() -> None:
    try:
        atomic_write_text(
            _COST_CACHE_FILE,
            json.dumps({k: [c, t] for k, (c, t) in _COST_CACHE.items()}, ensure_ascii=False),
        )
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
    _load_cost_cache()
    # 실제 CLI 인자를 먼저 만든다(스키마 필터·타입 정규화 반영). 캐시 키를 이것으로 만들어야
    # 키↔호출이 일치한다. _param_args→_allowed_param_names 는 프로세스 캐시라 히트 시 subprocess 없음.
    param_args = await _param_args(model, params)
    key = _cost_key(model, param_args)
    entry = _COST_CACHE.get(key)
    if entry is not None and (time.time() - entry[1]) < _COST_TTL:
        return {"credits": entry[0]}  # TTL 안 → 캐시 즉시(CLI 호출 없음)
    args: list[str] = ["generate", "cost", model, "--prompt", _shield_json_prompt(prompt or "preview")]
    args += param_args
    data = await _run_json(*args, timeout=timeout)
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
    _save_cost_cache()
    return {"credits": credits_int}


async def get_account_status(timeout: float = 30.0) -> dict[str, Any]:
    """계정 상태(연결·크레딧·이메일·플랜) — account status --json. 하단 상태줄 수동 확인용.
    10초 TTL 캐시 — 연타·여러 탭에서 동시 조회해도 subprocess 폭주를 막는다(크레딧은 약간 지연 OK)."""
    cached = _cache_get("account_status", 10.0)
    if cached is not None:
        return cached
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
