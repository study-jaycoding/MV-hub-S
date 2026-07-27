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

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import repo
from ..config import MEDIA_DIR
from ..services import comfy_client, comfy_workflow, video_convert

log = logging.getLogger("comfy")

router = APIRouter(prefix="/api/comfy", tags=["comfy"])

# app_setting 키 — 이 PC 로컬 DB 에만 저장되는 ComfyUI 연결 정보.
_K_URL = "comfy_url"
_K_TARGET = "comfy_target"          # "local" | "cloud"
_K_API_KEY = "comfy_api_key"
_K_CONCURRENCY = "comfy_concurrency"
_K_INPUT_DIR = "comfy_input_dir"

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
            base = job.get("created_at") or now
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


def _raw_settings() -> dict:
    """내부용 — 실제 api_key 포함(실행에 사용)."""
    return {
        "comfy_url": (repo.get_setting(_K_URL) or _DEFAULT_URL).rstrip("/"),
        "comfy_target": repo.get_setting(_K_TARGET) or "local",
        "comfy_api_key": repo.get_setting(_K_API_KEY) or "",
        "comfy_concurrency": _to_int(repo.get_setting(_K_CONCURRENCY), 3),
        "comfy_input_dir": repo.get_setting(_K_INPUT_DIR) or "",
    }


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
        repo.set_setting(_K_URL, patch.comfy_url.strip().rstrip("/"))
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


# ── 파싱: 노출 후보/슬롯 조회 ────────────────────────────────────────────────

class ParseReq(BaseModel):
    content: str                       # API 포맷 워크플로우 JSON 원문
    exposed: Optional[list[str]] = None  # 현재 노출된 "node|field" 목록(체크 표시용)


@router.post("/parse")
def parse(req: ParseReq):
    try:
        wf = json.loads(req.content)
        exposed = set(req.exposed or [])
        slots = comfy_workflow.detect_slots(wf, exposed)
        candidates = comfy_workflow.param_candidates(wf, exposed)
    except (json.JSONDecodeError, ValueError) as e:
        raise HTTPException(400, f"워크플로우 파싱 실패: {e}")
    return {"slots": slots, "candidates": candidates, "node_count": slots["node_count"]}


# ── 실행 ─────────────────────────────────────────────────────────────────────

_MEDIA_EXT_KIND = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video",
}


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


def _wait(target: dict, prompt_id: str) -> dict:
    deadline = time.monotonic() + _JOB_TIMEOUT
    if target["cloud"]:
        last = None
        unknown_since = None  # 알 수 없는 상태를 처음 본 시각(grace 초과 시 실패)
        while True:
            now = time.monotonic()
            if now >= deadline:
                raise comfy_client.ComfyError(
                    f"타임아웃 ({_JOB_TIMEOUT // 60}분) — 잡이 끝나지 않았습니다 "
                    f"(마지막 상태={last or '(empty)'})")
            st = comfy_client.cloud_job_status(target, prompt_id)
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
            time.sleep(_POLL_CLOUD)

    entry = None
    while time.monotonic() < deadline:
        entry = comfy_client.get_history(target, prompt_id)
        if entry is not None:
            status = entry.get("status") or {}
            if (comfy_client.history_error(entry) or status.get("completed") is True
                    or status.get("status_str") == "success"
                    or (not status and entry.get("outputs"))):
                break
        time.sleep(_POLL_LOCAL)
    else:
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
            dest = Path(input_dir) / "mvhub" / fname
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
                        input_dir: str) -> dict:
    """meta[i] 는 uploads[i] 와 순서 대응({type}). 타입별로 분리해 이미지→image_slots,
    영상→video_slots 에 순서대로 채우고 미사용 슬롯 prune. 실제 채운 개수를 반환(표시용).
    잘못된 요청(타입 누락/불일치, 슬롯 초과)은 업로드 전에 400 으로 거부한다."""
    if len(meta) != len(uploads):
        raise HTTPException(400, "media 파일 수와 media_meta 수가 일치하지 않습니다")
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
        _inject_media_bytes(target, wf, meta, uploads, settings["comfy_input_dir"])
    except comfy_client.ComfyError as e:
        code = 402 if getattr(e, "auth_error", False) else 502
        raise HTTPException(code, f"입력 미디어 업로드 실패: {e}")
    except ValueError as e:
        raise HTTPException(400, f"워크플로우 파싱 실패: {e}")

    tgt_kind = "cloud" if target["cloud"] else "local"
    try:
        prompt_id = comfy_client.submit(target, wf, settings["comfy_api_key"])
        _update_run_job(job_id, prompt_id=prompt_id)
        log.info("comfy submit ok target=%s prompt_id=%s", tgt_kind, prompt_id)  # api_key 는 절대 안 찍음
        entry = _wait(target, prompt_id)
    except comfy_client.ComfyError as e:
        log.warning("comfy run 실패 target=%s: %s", tgt_kind, e)
        code = 402 if getattr(e, "auth_error", False) else 502
        raise HTTPException(code, str(e))

    # 출력 수집 — 저장(OUTPUT) 노드가 내놓은 결과 전부. 미디어(이미지/영상)와 텍스트가 섞일 수 있고,
    # 복수일 수 있다(SaveText/SaveImage/VideoCombine 등). 미디어는 MEDIA_DIR 로 받아 /media URL 로.
    results: list[dict] = []
    for item in comfy_client.collect_outputs(entry):
        ext = os.path.splitext(item["filename"])[1].lower()
        kind = _MEDIA_EXT_KIND.get(ext, "image")
        rel = f"comfy/{uuid.uuid4().hex[:16]}{ext or '.png'}"
        try:
            comfy_client.download_view(target, item, MEDIA_DIR / rel)
        except comfy_client.ComfyError as e:
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
        raise HTTPException(
            502, "실행은 끝났지만 표시할 출력물이 없습니다(ShowText/SaveImage/VideoCombine 등 결과 노드 필요). "
            f"실제 출력 구조: {comfy_client.outputs_debug(entry, wf)}")
    return {"outputs": results, "prompt_id": prompt_id}


def _run_comfy_job_worker(job_id: str, wf: dict, pvals: Any, meta: list,
                          uploads: list[tuple[str, bytes]], settings: dict) -> None:
    """스레드 진입점 — 실행 결과/에러를 잡 레코드에 기록. HTTPException.status_code 로 402/502 보존."""
    _update_run_job(job_id, state=_RUN_RUNNING)
    try:
        result = _run_comfy_job_impl(job_id, wf, pvals, meta, uploads, settings)
    except HTTPException as e:
        _fail_run_job(job_id, int(e.status_code or 500), e.detail)
    except Exception as e:  # noqa: BLE001
        log.exception("comfy async run 예외 job_id=%s", job_id)
        _fail_run_job(job_id, 500, f"Comfy 실행 중 알 수 없는 오류가 발생했습니다: {e}")
    else:
        _finish_run_job(job_id, result)


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
