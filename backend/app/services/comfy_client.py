"""ComfyUI 서버(로컬/Cloud)와의 HTTP 통신 — stdlib urllib 만 사용(새 의존성 0).

animetic-enhancement 의 services/comfy_client.py(httpx 기반)를 MV-hub-S 규약에 맞춰
urllib 로 이식한 것. 로컬/Cloud 를 target 기술자로 통일한다.

주의: ComfyUI 는 보통 사설/로컬 IP(127.0.0.1:8188 등)라서 net_guard(사설망 차단)를
일부러 통과하지 않는다 — 사용자가 설정에서 지정한 신뢰 호스트이기 때문.
"""
import json
import mimetypes
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .net_guard import assert_public_http_url, guarded_opener, BlockedURLError

CLIENT_ID = f"mvhub-{uuid.uuid4().hex[:8]}"
CLOUD_BASE = "https://cloud.comfy.org"
CLOUD_MAX_CONCURRENCY = 5  # Pro 티어 문서 기준


class ComfyError(RuntimeError):
    def __init__(self, message: str, auth_error: bool = False):
        super().__init__(message)
        self.auth_error = auth_error  # 인증/크레딧 문제 → 배치 중단 사유


def make_target(settings: dict) -> dict:
    """로컬/클라우드를 동일 인터페이스로 다루기 위한 대상 기술자.
    Cloud API는 로컬과 라우트가 거의 같고 /api 접두사 + X-API-Key 헤더만 다르다."""
    if settings.get("comfy_target") == "cloud":
        return {
            "cloud": True,
            "base": CLOUD_BASE,
            "prefix": "/api",
            "headers": {"X-API-Key": settings.get("comfy_api_key", "")},
        }
    return {"cloud": False, "base": (settings.get("comfy_url") or "").rstrip("/"),
            "prefix": "", "headers": {}}


def _url(target: dict, route: str) -> str:
    return f"{target['base']}{target['prefix']}{route}"


def _classify(status_code: int, text: str) -> ComfyError:
    # HTTP 상태코드로만 인증 오류 판정(401/402/403) — 본문 키워드 매칭은 일반 검증 오류를
    # 배치 중단으로 오분류할 수 있어 쓰지 않는다.
    auth = status_code in (401, 402, 403)
    return ComfyError(f"ComfyUI 오류 (HTTP {status_code}): {text[:500]}", auth_error=auth)


# 실행 중(history) 오류 메시지에서 인증/크레딧 문제를 식별하는 좁은 패턴
_AUTH_PATTERNS = ("api_key", "api key", "unauthorized", "insufficient credit",
                  "credit balance", "payment required", "please log", "insufficientfunds")


def looks_like_auth_error(message: str) -> bool:
    lowered = (message or "").lower()
    return any(p in lowered for p in _AUTH_PATTERNS)


# ── 저수준 요청 헬퍼(urllib) ──────────────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """리다이렉트 자동 추적 금지 — 3xx 를 HTTPError 로 올려 호출부가 수동 처리하게 한다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def _request(method: str, url: str, *, headers: dict | None = None,
             json_body=None, data: bytes | None = None,
             content_type: str | None = None, timeout: int = 60) -> tuple[int, bytes]:
    """(status, body_bytes) 반환. 비-2xx 는 HTTPError 를 잡아 (code, body) 로 되돌린다.
    연결 실패는 ComfyError 로 올린다."""
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        content_type = "application/json"
    # http/https 만 허용 — file://·ftp:// 등으로 서버가 임의 로컬 자원을 읽는 것 차단(SSRF 2차 방어).
    if urllib.parse.urlsplit(url).scheme.lower() not in ("http", "https"):
        raise ComfyError(f"허용되지 않은 URL 스킴입니다(http/https 만): {url[:80]}")
    req = urllib.request.Request(url, data=data, method=method.upper())
    if content_type:
        req.add_header("Content-Type", content_type)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ComfyError(f"ComfyUI에 연결할 수 없습니다: {e}")


def _get_json(target: dict, route: str, *, timeout: int = 15, cloud_route=True) -> dict:
    url = _url(target, route) if cloud_route else f"{target['base']}{route}"
    status, body = _request("GET", url, headers=target["headers"], timeout=timeout)
    if status != 200:
        raise _classify(status, body.decode("utf-8", "replace"))
    try:
        return json.loads(body.decode("utf-8") or "null")
    except json.JSONDecodeError:
        raise ComfyError(f"ComfyUI 응답 JSON 파싱 실패: {body[:200]!r}")


def check_alive(target: dict) -> bool:
    try:
        if target["cloud"]:
            if not target["headers"].get("X-API-Key"):
                return False
            status, _ = _request("GET", _url(target, "/queue"),
                                  headers=target["headers"], timeout=4)
            return status == 200  # 401/402/429 등은 alive 아님(인증·크레딧·권한 문제 숨기지 않게)
        status, _ = _request("GET", f"{target['base']}/system_stats", timeout=2)
        return status == 200
    except ComfyError:
        return False


_OBJECT_INFO_CACHE: dict[tuple, tuple[float, dict]] = {}
_OBJECT_INFO_TTL = 300.0  # 5분 — object_info 는 노드 설치 전엔 안 바뀐다(재다운로드 낭비 방지)


def _cache_key(target: dict) -> tuple:
    """캐시 키 — base/prefix 뿐 아니라 api_key 까지 포함해야 키/워크스페이스를 바꿔도 옛 캐시가 안 남는다."""
    return (target.get("base", ""), target.get("prefix", ""),
            (target.get("headers") or {}).get("X-API-Key", ""))


def get_object_info(target: dict, *, use_cache: bool = True) -> dict:
    """ComfyUI 전체 /object_info (노드별 입력 위젯 스펙 = COMBO 드롭다운 후보 등).
    ★Comfy Cloud 는 개별 /object_info/{class} 를 지원하지 않고 전체 /object_info 만 지원하므로
    항상 전체를 받는다. 응답이 크므로(수 MB) target(base+prefix+api_key)별 TTL 캐시로 재다운로드를 줄인다.
    실패(서버 꺼짐·비2xx)는 ComfyError 로 올린다(호출부가 best-effort 폴백)."""
    key = _cache_key(target)
    now = time.time()
    if use_cache:
        hit = _OBJECT_INFO_CACHE.get(key)
        if hit and now - hit[0] < _OBJECT_INFO_TTL:
            return hit[1]
    data = _get_json(target, "/object_info", timeout=30)
    _OBJECT_INFO_CACHE[key] = (now, data)
    return data


_SUBSCRIPTION_CACHE: dict[tuple, tuple[float, "str | None"]] = {}
_SUBSCRIPTION_TTL = 300.0  # 5분 — 구독 등급은 거의 안 바뀐다


def get_subscription_tier(target: dict, *, use_cache: bool = True) -> "str | None":
    """Comfy Cloud 첫 워크스페이스의 구독 등급(예: 'PRO'). 로컬/미지원/실패면 None.
    크레딧 표시용(생성 정보) — target(base+prefix+api_key)별 TTL 캐시. 예외는 삼키고 None 반환(best-effort)."""
    key = _cache_key(target)
    now = time.time()
    if use_cache:
        hit = _SUBSCRIPTION_CACHE.get(key)
        if hit and now - hit[0] < _SUBSCRIPTION_TTL:
            return hit[1]
    tier: "str | None" = None
    try:
        data = _get_json(target, "/workspaces", timeout=10)
        wss = data.get("workspaces") if isinstance(data, dict) else None
        if isinstance(wss, list) and wss and isinstance(wss[0], dict):
            t = wss[0].get("subscription_tier")
            tier = str(t) if t else None
    except ComfyError:
        tier = None
    _SUBSCRIPTION_CACHE[key] = (now, tier)
    return tier


def upload_bytes(target: dict, filename: str, data: bytes, subfolder: str = "mvhub") -> str:
    """바이트를 ComfyUI /upload/image 로 업로드하고 노드 입력에 쓸 이름을 반환.
    (이미지·영상 모두 이 엔드포인트로 올린다 — VHS 영상도 input 폴더 기준으로 받는다.)
    로컬: input/<subfolder>/ 에 저장 → 'subfolder/파일명'. Cloud: 반환 이름을 그대로 사용."""
    fname = filename or "input.bin"
    fields = ({"type": "input"} if target["cloud"]
              else {"subfolder": subfolder, "overwrite": "true"})
    ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    body, boundary = _encode_multipart(fields, "image", fname, data, ctype)
    status, resp = _request(
        "POST", _url(target, "/upload/image"), headers=target["headers"],
        data=body, content_type=f"multipart/form-data; boundary={boundary}", timeout=600)
    if status != 200:
        raise _classify(status, resp.decode("utf-8", "replace"))
    try:
        info = json.loads(resp.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        raise ComfyError(f"업로드 응답 JSON 파싱 실패: {resp[:200]!r}")
    name = info.get("name") or fname
    sub = info.get("subfolder") or ""
    return f"{sub}/{name}" if sub else name


def upload_input(target: dict, path: str, subfolder: str = "mvhub") -> str:
    """로컬 파일 경로를 업로드(upload_bytes 래퍼)."""
    p = Path(path)
    return upload_bytes(target, p.name, p.read_bytes(), subfolder)


def _encode_multipart(fields: dict, file_field: str, filename: str,
                      file_bytes: bytes, file_ctype: str) -> tuple[bytes, str]:
    """stdlib 로 multipart/form-data 본문 구성(httpx.files 대체)."""
    boundary = f"----mvhub{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        parts.append(f"{v}\r\n".encode())
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        .encode())
    parts.append(f"Content-Type: {file_ctype}\r\n\r\n".encode())
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


# Cloud 제출 검증오류에서 '미지원 노드'를 뽑는 패턴(예: unsupported node type 'SaveText|pysssss')
_UNSUPPORTED_NODE_RE = re.compile(r"unsupported node type ['\"]([^'\"]+)['\"]", re.IGNORECASE)


def _unsupported_node_message(body_text: str) -> str | None:
    """제출 응답 본문에서 'Cloud 미지원 커스텀 노드' 안내 메시지를 만든다. 해당 없으면 None.

    Cloud 는 워크플로우에 자기 환경에 없는 커스텀 노드가 있으면 400 VALIDATION_ERROR 로 거부한다.
    원문 JSON 대신, 어떤 노드가 문제인지 + Local 로 바꾸라는 안내를 돌려준다.
    """
    msg = body_text or ""
    try:
        data = json.loads(body_text or "null")
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                msg = str(err.get("message") or msg)
            elif isinstance(err, str):
                msg = err
            elif data.get("message"):
                msg = str(data["message"])
    except json.JSONDecodeError:
        pass
    m = _UNSUPPORTED_NODE_RE.search(msg)
    if not m:
        return None
    node = m.group(1)
    return (f"Comfy Cloud 미지원 노드: '{node}'. 이 워크플로우엔 클라우드에 없는 커스텀 노드가 있습니다 — "
            f"설정에서 Local(로컬 ComfyUI)로 바꾸거나, 이 노드를 클라우드 지원 노드로 교체하세요. "
            f"(다른 미지원 노드가 더 있을 수 있습니다)")


def submit(target: dict, workflow: dict, api_key: str = "") -> str:
    """치환 완료된 API 포맷 JSON을 제출하고 prompt_id 반환."""
    body: dict = {"prompt": workflow, "client_id": CLIENT_ID}
    if api_key:
        body["extra_data"] = {"api_key_comfy_org": api_key}
    status, raw = _request("POST", _url(target, "/prompt"),
                           headers=target["headers"], json_body=body, timeout=60)
    if status != 200:
        text = raw.decode("utf-8", "replace")
        friendly = _unsupported_node_message(text)  # Cloud 미지원 노드면 친절한 안내로 대체
        if friendly:
            raise ComfyError(friendly)
        raise _classify(status, text)
    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        raise ComfyError(f"ComfyUI 응답 JSON 파싱 실패: {raw[:200]!r}")
    if "prompt_id" not in data:
        raise ComfyError(f"prompt_id 없음: {str(data)[:300]}")
    return data["prompt_id"]


# ---------- 로컬 폴링 ----------

def get_history(target: dict, prompt_id: str) -> dict | None:
    """완료 전이면 None, 완료되면 해당 history 엔트리. (로컬 전용)"""
    data = _get_json(target, f"/history/{prompt_id}", timeout=10, cloud_route=False)
    return (data or {}).get(prompt_id)


def history_error(entry: dict) -> str | None:
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        msgs = [
            str(m[1].get("exception_message", m[1]))[:300]
            for m in status.get("messages", [])
            if isinstance(m, (list, tuple)) and len(m) > 1
            and isinstance(m[1], dict) and "exception_message" in m[1]
        ]
        return "; ".join(msgs) or "실행 오류 (상세 메시지 없음)"
    return None


# ---------- Cloud 폴링 ----------

CLOUD_DONE = ("completed", "success")
# ★cancelled 도 종료(실패)로 본다 — 없으면 취소된 잡을 완료/실패 어디에도 못 넣어 타임아웃까지 무한 폴링했다.
CLOUD_FAIL = ("error", "failed", "cancelled", "canceled")
# 정상 대기/진행 상태(풀 타임아웃까지 대기 허용). 이 목록에도 DONE/FAIL 에도 없는 값(빈 문자열·미지 키)은
# '알 수 없음'으로 보고 짧은 grace 뒤 실패시킨다 — 응답 형식이 어긋나 30분간 '실행중' 고착되는 것을 막는다.
CLOUD_PENDING = ("waiting_to_dispatch", "pending", "queued", "in_progress", "running", "dispatched",
                 "executing")  # ★Cloud 가 실행중을 'executing' 으로 보고한다 — 없으면 미지 상태로 90초 뒤 오실패


def cloud_job_status(target: dict, prompt_id: str) -> str:
    data = _get_json(target, f"/job/{prompt_id}/status", timeout=15)
    return str(data.get("status", ""))


def cloud_job_detail(target: dict, prompt_id: str) -> dict:
    return _get_json(target, f"/jobs/{prompt_id}", timeout=30)


def cloud_error_message(detail: dict) -> str:
    """Cloud 잡 상세에서 실패 사유 문자열을 최대한 넓게 추출(없으면 빈 문자열)."""
    if not isinstance(detail, dict):
        return ""
    exec_err = detail.get("execution_error")
    if isinstance(exec_err, dict):
        m = exec_err.get("exception_message") or exec_err.get("message")
        if m:
            return str(m)
    for k in ("error_message", "error", "message", "status_message"):
        v = detail.get(k)
        if v:
            return str(v)
    return ""


def cloud_cancel_pending(target: dict, prompt_id: str) -> None:
    """Cloud 대기열에서 지정 잡을 취소한다.

    취소 자체는 호출부가 best-effort 로 처리한다. 여기서 오류를 삼키면 호출부가 운영 로그를
    남길 수 없으므로, 연결/HTTP 오류는 ComfyError 로 그대로 올린다.
    """
    status, body = _request(
        "POST", _url(target, "/queue"), headers=target["headers"],
        json_body={"delete": [prompt_id]}, timeout=10,
    )
    if not 200 <= status < 300:
        raise _classify(status, body.decode("utf-8", "replace"))


# ---------- 공통 ----------

def collect_outputs(entry: dict) -> list[dict]:
    """모든 출력 노드의 모든 키를 순회해 filename/subfolder/type 항목을 수집.
    (출력 키를 images/videos로 가정하지 않는다 — VHS는 gifs 등 임의 키 사용)"""
    found = []
    for node_output in (entry.get("outputs") or {}).values():
        if not isinstance(node_output, dict):
            continue
        for value in node_output.values():
            if not isinstance(value, list):
                continue
            for item in value:
                if isinstance(item, dict) and "filename" in item:
                    found.append({
                        "filename": item["filename"],
                        "subfolder": item.get("subfolder", ""),
                        "type": item.get("type", "output"),
                    })
    return found


def collect_texts(entry: dict) -> list[str]:
    """출력 노드에서 텍스트(문자열) 결과를 수집 — ShowText/SaveText 등 OUTPUT_NODE 의 UI 텍스트.
    노드마다 키 이름(text/string/value…)도 중첩 형태({"text":"s"} / {"text":["s"]} / [["s"]] 등)도
    제각각이라, outputs 구조를 재귀적으로 훑어 문자열을 모두 모은다. 미디어 항목({filename,…})은
    텍스트가 아니므로 건너뛴다. 앞뒤 공백만 다른 중복도 제거."""
    out: list[str] = []
    seen: set[str] = set()

    def walk(v) -> None:
        if isinstance(v, str):
            key = v.strip()
            if key and key not in seen:
                seen.add(key)
                out.append(key)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            if "filename" in v:  # 미디어 출력 항목 — 텍스트 아님
                return
            for x in v.values():
                walk(x)

    for node_output in (entry.get("outputs") or {}).values():
        walk(node_output)
    return out


def outputs_debug(entry: dict, wf: dict | None = None) -> str:
    """출력물이 안 잡힐 때 실제 history outputs 구조를 사람이 읽게 요약(진단용)."""
    parts = []
    for nid, no in (entry.get("outputs") or {}).items():
        ct = str(((wf or {}).get(nid) or {}).get("class_type", "?"))
        if isinstance(no, dict):
            body = ", ".join(f"{k}:{type(v).__name__}" for k, v in no.items()) or "빈dict"
        else:
            body = type(no).__name__
        parts.append(f"{nid}[{ct}]={{{body}}}")
    return " | ".join(parts) or "출력 노드 없음"


def view_bytes(target: dict, params: dict) -> bytes:
    """/view 로 파일 바이트를 받아 반환(출력물·저장된 텍스트 파일 등).
    Cloud 는 서명된 스토리지 URL 로 302 redirect — 그 두 번째 요청엔 인증 헤더를 붙이지 않는다
    (X-API-Key 가 외부 스토리지 호스트로 새는 것 방지)."""
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{_url(target, '/view')}?{qs}"
    req = urllib.request.Request(url, method="GET")
    for k, v in (target["headers"] or {}).items():
        req.add_header(k, v)
    try:
        with _NO_REDIRECT_OPENER.open(req, timeout=600) as r:
            body, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            loc = e.headers.get("Location")
            if not loc:
                raise ComfyError("리다이렉트 응답에 Location 헤더가 없습니다")
            # ★리다이렉트 대상 검증(SSRF·로컬파일 읽기 차단). 원래 comfy 직결은 사설/로컬을 허용(위 주석)
            #  하지만 /view 302 는 '공개 서명 스토리지 URL' 이어야 한다. 검증 없이 urlopen 하면 악의적
            #  Comfy 서버가 `Location: file:///…`(urllib 은 file:// 지원) 이나 내부망 IP 를 돌려줘 서버
            #  로컬 파일·내부 서비스를 읽게 할 수 있다. http(s)+공개 IP 만 허용하고, 두 번째 요청도
            #  no-redirect opener 로 열어 체인 리다이렉트 우회까지 막는다(헤더 미첨부 → X-API-Key 미유출).
            try:
                assert_public_http_url(loc)
                with guarded_opener().open(loc, timeout=600) as r2:
                    return r2.read()
            except BlockedURLError as e2:
                raise ComfyError(f"출력물 리다이렉트가 차단되었습니다(SSRF 방어): {e2}")
            except (urllib.error.URLError, TimeoutError, OSError) as e2:
                raise ComfyError(f"출력물 다운로드 실패: {e2}")
        raise _classify(e.code, e.read().decode("utf-8", "replace")[:200])
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ComfyError(f"ComfyUI에 연결할 수 없습니다: {e}")
    if status != 200:
        raise _classify(status, body.decode("utf-8", "replace")[:200])
    return body


def download_view(target: dict, item: dict, dst: Path) -> None:
    """/view 로 출력 파일 바이트를 받아 dst 에 저장."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(view_bytes(target, item))


def interrupt(target: dict) -> None:
    """실행 중 작업 중단 — 로컬·Cloud 모두 '현재 실행 중 전체'가 대상.

    취소 호출자는 실패를 사용자 실행 실패에 덧붙이지 않고 로그만 남긴다. 그 판단을 할 수
    있도록 이 저수준 함수는 오류를 삼키지 않는다.
    """
    status, body = _request(
        "POST", _url(target, "/interrupt"), headers=target["headers"], timeout=5,
    )
    if not 200 <= status < 300:
        raise _classify(status, body.decode("utf-8", "replace"))
