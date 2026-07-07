#!/usr/bin/env python3
"""Content Hub — 로컬 push 에이전트.

각 팀원이 자기 PC에서 실행한다. 자기 힉스필드 CLI(로컬 로그인)로 생성한 결과물의
메타데이터만 공유 서버로 밀어 올린다. **힉스필드 토큰은 이 PC 밖으로 나가지 않는다.**

동작:
  1) 허브에 로그인(이메일/비밀번호) → 세션 토큰 획득(서버엔 힉스필드 토큰 안 보냄)
  2) 서버가 이미 가진 내 job_id 조회 → 새 것만 추림
  3) 로컬 `higgsfield generate list --json` 으로 내 생성물 읽기(내 CLI·내 계정)
  4) 새 잡 + 내 크레딧 상태를 서버 /api/ingest 로 POST
  서버는 이 결과물을 '내 계정' 작업으로 저장하고, 팀 전원이 공유 라이브러리에서 본다.

필요: 이 PC에 higgsfield CLI 설치 + `higgsfield auth login` 완료. Python 3.9+ (표준 라이브러리만).

예시:
  python agent_push.py --server http://192.168.0.10:8010 --email oz1@millionvolt.com
  python agent_push.py --server http://192.168.0.10:8010 --email oz1@millionvolt.com --watch 60
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as futures_wait
from threading import Lock
from urllib.parse import quote, urlencode, urlparse


def _dominant_uid(jobs: list) -> str | None:
    """잡 목록 결과 URL의 user_<id> 중 최다 = 이 CLI 계정 본인의 힉스필드 uid."""
    c: Counter = Counter()
    for j in jobs:
        if not isinstance(j, dict):
            continue
        m = re.search(r"(user_[A-Za-z0-9]+)", j.get("result_url") or "")
        if m:
            c[m.group(1)] += 1
    return c.most_common(1)[0][0] if c else None


def _cli() -> str:
    found = shutil.which("higgsfield") or shutil.which("hf")
    if not found:
        sys.exit("[오류] higgsfield CLI 를 찾을 수 없습니다. 설치 후 `higgsfield auth login` 하세요.")
    return found


def _run_cli_json(cli: str, *args: str, timeout: int = 120):
    """higgsfield CLI 를 --json 으로 실행하고 (파싱 결과, 오류문구) 반환."""
    try:
        out = subprocess.run(
            [cli, *args, "--json"],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None, f"CLI 타임아웃: {' '.join(args)}"
    if out.returncode != 0:
        msg = (out.stderr or out.stdout or "").strip()
        return None, f"CLI 실패({' '.join(args)}): {msg[:700]}"
    try:
        return json.loads(out.stdout), None
    except json.JSONDecodeError:
        return None, f"CLI JSON 파싱 실패: {' '.join(args)}"


def _cli_json(cli: str, *args: str, timeout: int = 120):
    """higgsfield CLI 를 --json 으로 실행하고 파싱 결과 반환(실패 시 None)."""
    data, err = _run_cli_json(cli, *args, timeout=timeout)
    if err:
        print(f"[경고] {err}")
    return data


def _cli_version(cli: str) -> str | None:
    """CLI 빌드 버전 문자열(예: '0.2.3'). `higgsfield version` 은 JSON 이 아니라 평문이라 직접 파싱.
    실패해도 None — 버전 보고는 부가정보(없어도 push 진행)."""
    try:
        out = subprocess.run([cli, "version"], capture_output=True, text=True, timeout=30)
        txt = (out.stdout or out.stderr or "").strip()
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"\d+\.\d+\.\d+", txt)
    return m.group(0) if m else (txt[:40] or None)


# 사이클 간 사실상 불변인 CLI 조회 캐시 — watch 모드에서 이벤트마다 subprocess 를 다시 띄우지 않게.
# model list 는 10분 TTL(신모델 반영 여지), version 은 프로세스 수명 동안 고정(CLI 교체=재시작).
_CLI_INFO_CACHE: dict = {}


def _cached_models(cli: str):
    ent = _CLI_INFO_CACHE.get("models")
    if ent and time.time() - ent[0] < 600:
        return ent[1]
    models = _cli_json(cli, "model", "list")
    if isinstance(models, list):
        _CLI_INFO_CACHE["models"] = (time.time(), models)
    return models


def _cached_cli_version(cli: str) -> str | None:
    if "version" not in _CLI_INFO_CACHE:
        _CLI_INFO_CACHE["version"] = _cli_version(cli)
    return _CLI_INFO_CACHE["version"]


def _http(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: int = 60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        return e.code, detail
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # ★일시 네트워크 오류로 에이전트를 죽이지 않는다 — 롱폴(_wait_event)은 관대하게 재대기하면서
        # 정작 작업 경로(push/claim/보고)는 sys.exit 로 종료하던 비대칭이, 와이파이 순단·서버 재시작
        # 한 번에 팀원 PC 의 에이전트를 조용히 죽였다. 호출부는 전부 status!=200 을 소프트 실패로
        # 처리하므로 0 을 돌려주면 다음 사이클/롱폴에서 자동 재시도된다.
        # (read timeout 은 URLError 가 아니라 socket.timeout=OSError 로 올 수 있어 함께 잡는다 —
        #  _wait_event 의 except 와 동일 집합.)
        print(f"[경고] 서버 연결 실패({url.split('?')[0]}): {e} — 다음 사이클에 재시도")
        return 0, str(e)


def _wait_event(server: str, token: str, timeout: int = 35):
    """롱폴 — 서버가 내 계정 이벤트(생성요청/동기화)가 생길 때까지 잡고 있다 반환.
    반환: reason('gen-request'|'sync') | None(타임아웃=idle 또는 일시 네트워크 오류 → 재대기).
    30초 고정 폴링을 대체 — 평소엔 여기서 조용히 대기하다 액션 순간 즉시 깨어난다."""
    req = urllib.request.Request(f"{server}/api/agent/wait", method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode() or "null")
            return d.get("reason") if isinstance(d, dict) and d.get("wake") else None
    except urllib.error.HTTPError as e:
        if e.code == 401:
            # 세션 만료 — 즉시 종료하지 않고 호출자(main 루프)가 자동 재로그인을 시도하게 알린다.
            # (며칠 상주하다 만료되면 수동 재시작이 필요하던 것을 자가 복구로.)
            return "__reauth__"
        return None
    except (urllib.error.URLError, TimeoutError, OSError):
        time.sleep(3)  # 서버 일시 불가/타임아웃 → 잠깐 쉬고 재대기(폭주 방지)
        return None


def login(server: str, email: str, password: str) -> str:
    status, body = _http("POST", f"{server}/api/auth/login", body={"email": email, "password": password})
    if status != 200 or not isinstance(body, dict) or not body.get("token"):
        sys.exit(f"[오류] 허브 로그인 실패(status={status}): {body}")
    acc = body.get("account") or {}
    print(f"[로그인] {acc.get('name') or email} · {acc.get('status')} · 역할={','.join(acc.get('global_roles') or [])}")
    return body["token"]


# NOTE: 아래 _role_flag / _param_flags / _dominant_uid / _cli_json 은 backend cli_bridge 의
#       _media_flag(역할명 동일) / _param_args / parse_job(uid 추출) / _run_json 과 대응한다.
#       push_agent 는 표준 라이브러리만 써야 해(팀원 무설치) cli_bridge 를 import 못 한다 →
#       의도적 중복. 한쪽을 고치면 다른 쪽도 같이 맞춰라(특히 param 필터 규칙).
_ROLE_TO_FLAG = {
    "@image": "--image", "@video": "--video", "@start": "--start-image",
    "@end": "--end-image", "@audio": "--audio",
}


def _role_flag(role: str) -> str:
    key = (role or "").lower()
    for prefix, flag in _ROLE_TO_FLAG.items():
        if key.startswith(prefix):
            return flag
    return "--image"


# CLI 1.x: Seedance 는 옛 --medias 를 제거하고 역할별 references 플래그(반복)를 받는다.
_MEDIA_ROLE_TO_REF_FLAG = {
    "image": "--image-references", "video": "--video-references", "audio": "--audio-references",
}


def _seedance_ref_args(media_ids: list) -> list:
    """[(role, upload_id)] → [--image-references, id, --video-references, id, ...].
    역할별 *-references 플래그는 upload id(또는 파일경로)를 받고, 여러 개는 반복 전달한다."""
    out: list = []
    for role, mid in media_ids:
        out += [_MEDIA_ROLE_TO_REF_FLAG.get(role, "--image-references"), mid]
    return out


def _uses_single_start_image(model: str) -> bool:
    return (model or "").startswith("seedance")


def _role_key(ref: dict) -> str:
    return (ref.get("role") or "").lower()


def _is_image_ref(ref: dict) -> bool:
    role = _role_key(ref)
    return ref.get("type") == "image" or role.startswith(("@image", "@start", "@end"))


def _is_start_ref(ref: dict) -> bool:
    return _role_key(ref).startswith("@start")


def _is_end_ref(ref: dict) -> bool:
    return _role_key(ref).startswith("@end")


def _is_omni_media_ref(ref: dict) -> bool:
    role = _role_key(ref)
    if _is_start_ref(ref) or _is_end_ref(ref):
        return False
    return role.startswith(("@image", "@video", "@audio")) or ref.get("type") in ("image", "video", "audio")


def _media_role(ref: dict) -> str:
    role = _role_key(ref)
    typ = ref.get("type")
    if role.startswith("@video") or typ == "video":
        return "video"
    if role.startswith("@audio") or typ == "audio":
        return "audio"
    return "image"


def _refs_for_cli(model: str, refs: list) -> tuple[list, str | None]:
    if not _uses_single_start_image(model):
        return refs, None
    image_refs = [ref for ref in refs if isinstance(ref, dict) and _is_image_ref(ref)]
    start_refs = [ref for ref in image_refs if _is_start_ref(ref)]
    end_refs = [ref for ref in image_refs if _is_end_ref(ref)]
    if len(start_refs) > 1:
        return [], "Seedance 영상은 시작 이미지 1장만 지원합니다."
    if len(end_refs) > 1:
        return [], "Seedance 영상은 끝 이미지 1장만 지원합니다."
    return [ref for ref in refs if isinstance(ref, dict)], None


def _upload_cache_path() -> str:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, "MVHub", "higgsfield_upload_cache.json")
    return os.path.join(os.path.expanduser("~"), ".mvhub", "higgsfield_upload_cache.json")


def _load_upload_cache(namespace: str | None) -> dict:
    path = _upload_cache_path()
    items = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
            if isinstance(raw, dict) and isinstance(raw.get("items"), dict):
                items = raw["items"]
    except (OSError, json.JSONDecodeError):
        pass
    return {"_path": path, "_namespace": namespace or "unknown", "_items": items, "_memory": {}}


def _save_upload_cache(upload_cache: dict) -> None:
    path = upload_cache.get("_path")
    items = upload_cache.get("_items")
    if not path or not isinstance(items, dict):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        ranked = sorted(
            items.items(),
            key=lambda kv: (kv[1].get("updated_at") or kv[1].get("created_at") or 0)
            if isinstance(kv[1], dict)
            else 0,
            reverse=True,
        )
        payload = {"version": 1, "items": dict(ranked[:800])}
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError as e:
        print(f"[경고] 업로드 캐시 저장 실패: {e}")


def _file_fingerprint(path: str) -> tuple[str, int] | None:
    try:
        size = os.path.getsize(path)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return "sha256:" + h.hexdigest(), size
    except OSError as e:
        print(f"[경고] 레퍼런스 해시 계산 실패({path}): {e}")
        return None


def _upload_cache_key(upload_cache: dict, digest: str) -> str:
    return f"{upload_cache.get('_namespace') or 'unknown'}|{digest}"


def _invalidate_upload_cache(upload_cache: dict, path: str, upload_lock: Lock) -> None:
    if "_items" not in upload_cache:
        with upload_lock:
            upload_cache.pop(path, None)
        return
    fp = _file_fingerprint(path)
    if not fp:
        return
    digest, _ = fp
    key = _upload_cache_key(upload_cache, digest)
    with upload_lock:
        upload_cache.get("_memory", {}).pop(key, None)
        upload_cache.get("_items", {}).pop(key, None)
        _save_upload_cache(upload_cache)


def _upload_for_media(
    cli: str,
    path: str,
    upload_cache: dict,
    upload_lock: Lock,
    force: bool = False,
) -> tuple[dict | None, bool]:
    """로컬 레퍼런스 파일을 Higgsfield media_input 으로 업로드하고 (medias[].data, 캐시사용여부) 반환."""
    if "_items" not in upload_cache:
        with upload_lock:
            cached = upload_cache.get(path)
            if cached is not None and not force:
                return cached, True
    else:
        fp = _file_fingerprint(path)
        if not fp:
            return None, False
        digest, size = fp
        key = _upload_cache_key(upload_cache, digest)
        with upload_lock:
            if not force:
                cached = upload_cache.get("_memory", {}).get(key)
                if cached is not None:
                    return cached, True
                entry = upload_cache.get("_items", {}).get(key)
                data = entry.get("data") if isinstance(entry, dict) else None
                if isinstance(data, dict) and data.get("id"):
                    upload_cache.setdefault("_memory", {})[key] = data
                    return data, True
    up = _cli_json(cli, "upload", "create", path, timeout=300)
    if isinstance(up, list):
        up = up[0] if up else None
    if not isinstance(up, dict) or not up.get("id"):
        print(f"[경고] 레퍼런스 업로드 실패: {path}")
        return None, False
    data = {"id": up.get("id"), "type": "media_input"}
    if up.get("url"):
        data["url"] = up.get("url")
    if "_items" not in upload_cache:
        with upload_lock:
            upload_cache[path] = data
        return data, False
    with upload_lock:
        upload_cache.setdefault("_memory", {})[key] = data
        upload_cache.setdefault("_items", {})[key] = {
            "data": data,
            "size": size,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        _save_upload_cache(upload_cache)
    return data, False


_PARAM_NAMES_CACHE: dict = {}  # model → 허용 param 이름 집합(빈 집합=스키마 못 받음 → 필터 안 함)


def _allowed_params(cli: str, model: str) -> set:
    """모델이 받는 param 이름 집합 — `model get <model> --json` 의 params[].name.
    cli_bridge._allowed_param_names 와 동일 규칙(조회 실패 시 빈 집합 = 전부 통과, advisor)."""
    if model not in _PARAM_NAMES_CACHE:
        data = _cli_json(cli, "model", "get", model, timeout=60)
        names = set()
        if isinstance(data, dict):
            names = {p.get("name") for p in (data.get("params") or []) if isinstance(p, dict) and p.get("name")}
        _PARAM_NAMES_CACHE[model] = names
    return _PARAM_NAMES_CACHE[model]


def _param_flags(params: dict, allowed: set) -> list[str]:
    """params dict → CLI --플래그(스칼라만; prompt·미디어·복합타입 제외).
    모델 스키마(allowed) 밖 키는 제외 — 동기화 잔여값(width/height/batch_size 등)이 새어
    잘못된 --플래그로 가는 것 방지(cli_bridge._param_args 와 동일). allowed 비면 필터 안 함."""
    out: list[str] = []
    for k, v in (params or {}).items():
        if k == "prompt" or v is None or v == "" or isinstance(v, (list, dict)):
            continue
        if allowed and k not in allowed:  # 스키마 밖(동기화 잔여값). 스키마 못 받았으면 통과.
            continue
        # sync: cli_bridge._param_args 와 동일. CLI 1.x 는 boolean 을 소문자 true/false 로만 받는다
        # (str(True)="True" → "Invalid types: ... should be boolean, got string" 로 seedance 등 실패).
        if isinstance(v, bool):
            out += [f"--{k}", "true" if v else "false"]
        else:
            out += [f"--{k}", str(v)]
    return out


def _fail(server: str, token: str, rid: str, reason: str) -> None:
    """요청 실패 보고. reason 에 한글/공백/괄호가 들어가므로 반드시 URL 인코딩한다
    (urllib 은 비-ASCII URL 을 그대로 못 보냄 — 'ascii codec' 오류로 보고 자체가 실패해
    요청이 running 에 영영 멈추는 버그를 막는다)."""
    _http("POST", f"{server}/api/gen-requests/{rid}/fail?reason={quote(reason)}", token=token)


def _download_ref(server: str, token: str, url: str, suffix: str, timeout: int = 180, auth: bool = True):
    """레퍼런스 파일을 받아 임시파일로 저장 → 경로 반환(실패 시 None).
    asset:/상대경로 레퍼런스는 허브 로그인이 필요해 CLI 가 직접 못 받는다 → 에이전트가 받아
    로컬 파일로 CLI 에 넘긴다(higgsfield 가 로컬 파일을 자동 업로드).
    auth=False 면 Authorization 헤더를 안 붙인다(외부 공개 CDN URL 에 허브 토큰 노출 방지)."""
    req = urllib.request.Request(url, method="GET")
    if auth:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            fd, tmp = tempfile.mkstemp(prefix="chref_", suffix=suffix or ".bin")
            with os.fdopen(fd, "wb") as f:
                shutil.copyfileobj(r, f)
            return tmp
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
        print(f"[경고] 레퍼런스 다운로드 실패({url}): {e}")
        return None


def _resolve_ref(server: str, token: str, val: str):
    """레퍼런스 값 → (CLI 에 넘길 값, 정리할 임시파일경로 | None).
    · http(s) 공개 URL → 바이트로 받아 로컬 임시파일(CLI 의 --image 등은 미디어 UUID·로컬 파일만
      받고 원격 URL 은 "Media <url> is neither a UUID nor an existing file path" 로 거부한다 →
      재생성 시 원본 cloudfront URL 을 레퍼런스로 넘기면 실패. 공개 CDN 이라 토큰 없이 받는다).
    · asset:{project}|{path} → 허브 인증으로 받아 로컬 임시파일(토큰의 | 가 cmd 를 깨뜨리던 문제 해소).
    · /상대경로(/api/...,/media/...) → 서버 기준 인증 다운로드 → 로컬 임시파일.
    · 그 외(해석 불가) → (None, None) → 호출측이 잘못 생성 대신 명확히 실패시킨다."""
    if not val:
        return None, None
    low = val.lower()
    if low.startswith(("http://", "https://")):
        suffix = os.path.splitext(urlparse(val).path)[1]
        tmp = _download_ref(server, token, val, suffix, auth=False)
        return (tmp, tmp) if tmp else (None, None)
    if val.startswith("asset:"):
        body = val[len("asset:"):]
        if "|" not in body:
            return None, None
        project, _, path = body.partition("|")
        suffix = os.path.splitext(path)[1]
        url = f"{server}/api/assets/file?" + urlencode({"project": project, "path": path})
    elif val.startswith("/"):
        suffix = os.path.splitext(val.split("?", 1)[0])[1]
        url = f"{server}{val}"
    else:
        return None, None  # 알 수 없는 형식(베어 토큰 등) — CLI 가 모름
    tmp = _download_ref(server, token, url, suffix)
    return (tmp, tmp) if tmp else (None, None)


def _cleanup(paths: list) -> None:
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _execute_one(
    server: str,
    token: str,
    cli: str,
    r: dict,
    ref_cache: dict,
    upload_cache: dict,
    upload_lock: Lock,
) -> None:
    """대기 요청 1건을 내 로컬 CLI 로 실행 → fulfill/fail. 스레드에서 호출되므로 예외를
    바깥으로 던지지 않는다(한 건 실패가 다른 건 실행을 막지 않게).
    레퍼런스는 배치 시작 때 한 번씩만 받아둔 `ref_cache`(값→해석값) 를 조회만 한다(중복 다운로드 방지)."""
    rid, model, prompt = r.get("id"), r.get("model"), r.get("prompt") or ""
    if not model:
        _fail(server, token, rid, "모델 없음")
        return
    args = ["generate", "create", model, "--prompt", prompt, "--wait"]
    args += _param_flags(r.get("params") or {}, _allowed_params(cli, model))
    refs, ref_error = _refs_for_cli(model, r.get("references") or [])
    if ref_error:
        _fail(server, token, rid, ref_error)
        print(f"  ✗ {model}: {ref_error}")
        return
    # 레퍼런스 — 다운로드 없이 배치 공유 캐시 조회만(해석값=공개 URL 또는 로컬 임시파일경로).
    unresolved: list = []
    upload_failed: list = []
    seedance_media_ids: list = []  # [(role, upload_id)] — 1.x references 플래그용
    seedance_media_inputs: list[tuple[str, str]] = []
    seedance_used_cached_media = False
    for ref in refs:
        val = ref.get("file_path")
        if not val:
            continue
        seedance_media = _uses_single_start_image(model) and _is_omni_media_ref(ref)
        resolved = ref_cache.get(val)
        if not resolved:
            unresolved.append(val)
            continue
        if seedance_media:
            # Seedance 옴니 레퍼런스는 --image 로 넘기면 start_image 로 오해된다. upload create 로
            # id 를 만들어(업로드 캐시 재사용) 역할별 --*-references 플래그로 넘긴다.
            # 옛 --medias 는 CLI 1.x 에서 제거됨("Unknown params: medias").
            data, from_cache = _upload_for_media(cli, resolved, upload_cache, upload_lock)
            if not data:
                upload_failed.append(val)
                continue
            media_role = _media_role(ref)
            seedance_media_inputs.append((resolved, media_role))
            seedance_used_cached_media = seedance_used_cached_media or from_cache
            seedance_media_ids.append((media_role, data["id"]))
            continue
        args += [_role_flag(ref.get("role")), resolved]
    if unresolved:
        # 레퍼런스를 못 가져오면 그대로 생성 시 입력 이미지 없이 엉뚱하게 나오고 크레딧만
        # 소모된다 → 실행하지 않고 명확한 사유로 실패시킨다.
        _fail(server, token, rid, f"레퍼런스를 가져올 수 없습니다({len(unresolved)}개): {unresolved[0]}")
        print(f"  ✗ 레퍼런스 해석 불가 — 실행 안 함: {unresolved[0]}")
        return
    if upload_failed:
        _fail(server, token, rid, f"레퍼런스를 업로드할 수 없습니다({len(upload_failed)}개): {upload_failed[0]}")
        print(f"  ✗ 레퍼런스 업로드 실패 — 실행 안 함: {upload_failed[0]}")
        return
    seedance_ref_args = _seedance_ref_args(seedance_media_ids)
    args += seedance_ref_args
    print(f"  → {model}: {prompt[:40]}")
    job, cli_error = _run_cli_json(cli, *args, timeout=900)
    if (
        not job
        and cli_error
        and seedance_media_inputs
        and seedance_used_cached_media
        and any(s in cli_error.lower() for s in ("media", "reference", "upload", "uuid", "input"))
    ):
        print("  ↻ 캐시된 Higgsfield media id 실패 의심 — 캐시를 버리고 재업로드 후 1회 재시도")
        retry_ids: list = []
        retry_failed = False
        for path, media_role in seedance_media_inputs:
            _invalidate_upload_cache(upload_cache, path, upload_lock)
            data, _ = _upload_for_media(cli, path, upload_cache, upload_lock, force=True)
            if not data:
                retry_failed = True
                break
            retry_ids.append((media_role, data["id"]))
        if not retry_failed:
            # 새 id 로 references 플래그만 교체(base = seedance ref 를 뺀 나머지).
            base_args = args[:len(args) - len(seedance_ref_args)]
            retry_args = base_args + _seedance_ref_args(retry_ids)
            job, cli_error = _run_cli_json(cli, *retry_args, timeout=900)
    if not job:
        reason = "로컬 CLI 실행 실패"
        if cli_error:
            reason = f"{reason}: {cli_error[:500]}"
            print(f"[경고] {cli_error}")
        _fail(server, token, rid, reason)
        return
    if isinstance(job, list):
        job = job[0] if job else None
    if not isinstance(job, dict):
        _fail(server, token, rid, "결과 파싱 실패")
        return
    st, body = _http("POST", f"{server}/api/gen-requests/{rid}/fulfill", token=token, body={"job": job})
    print(f"  ✓ 완료 보고(status={st})" if st == 200 else f"  ✗ 보고 실패: {body}")


# 동시 실행 상한 — team 플랜 16 병렬 생성 기준. 벌크(N장)를 한꺼번에 돌리되 그 이상은 막는다.
# (서버 claim 한도 claim_pending_requests(limit) 와 맞춤 — 둘 다 16.)
_MAX_CONCURRENCY = 16


def _resolve_refs_for(server: str, token: str, reqs: list) -> tuple:
    """이 묶음의 고유 레퍼런스를 한 번씩만 받아 캐시 구성(같은 레퍼런스 N번 다운로드 방지).
    반환: (ref_cache={값→해석값}, 정리할 임시파일 리스트)."""
    ref_cache: dict = {}
    ref_temps: list = []
    for val in {
        ref.get("file_path")
        for r in reqs
        for ref in (r.get("references") or [])
        if ref.get("file_path")
    }:
        resolved, tmp = _resolve_ref(server, token, val)
        ref_cache[val] = resolved
        if tmp:
            ref_temps.append(tmp)
    return ref_cache, ref_temps


def execute_pending(server: str, token: str, cli: str) -> int:
    """대기 요청을 **연속 워커 풀**로 실행 — 슬롯(최대 _MAX_CONCURRENCY)이 비는 즉시 다음 요청을
    claim해 채운다. 한 묶음이 다 끝나길 기다리지 않으므로 빈 병렬 슬롯이 안 생긴다(느린 1건이
    나머지 슬롯을 안 막고, 실행 중 새로 들어온 요청도 즉시 흡수). 대기·실행이 모두 없으면 종료.
    실행은 유료(내 크레딧). 반환: 이번에 처리한 요청 수."""
    in_flight: set = set()
    ref_temps_all: list = []
    upload_cache: dict = _load_upload_cache(_cli_account_email(cli))
    upload_lock = Lock()
    total = 0
    printed = False
    with ThreadPoolExecutor(max_workers=_MAX_CONCURRENCY) as ex:
        while True:
            free = _MAX_CONCURRENCY - len(in_flight)
            claimed: list = []
            if free > 0:
                # 빈 슬롯 수만큼만 claim(서버가 그만큼만 running 표시 → 카드 상태 정확).
                status, pend = _http(
                    "GET", f"{server}/api/gen-requests/pending?limit={free}", token=token
                )
                claimed = pend if isinstance(pend, list) else []
            if claimed:
                if not printed:
                    print(f"[실행] 대기 요청 처리 — 최대 {_MAX_CONCURRENCY}개 병렬, 슬롯 비는 대로 채움")
                    printed = True
                ref_cache, ref_temps = _resolve_refs_for(server, token, claimed)
                ref_temps_all += ref_temps
                for m in {r.get("model") for r in claimed if r.get("model")}:
                    _allowed_params(cli, m)  # 모델 param 스키마 미리 캐시(동시 model get 낭비 방지)
                for r in claimed:
                    in_flight.add(ex.submit(_execute_one, server, token, cli, r, ref_cache, upload_cache, upload_lock))
                    total += 1
                continue  # 곧장 남은 슬롯도 채우러
            if not in_flight:
                break  # claim할 것도, 실행 중인 것도 없음 → 종료
            # 슬롯이 다 찼거나 새 요청 없음 → 하나라도 끝나면(또는 3s마다) 다시 채우러.
            # (1s 틱은 장시간 생성 1건 동안 pending GET 을 초당 1회 반복 — 3s 로도 슬롯 충원 체감 동일)
            _, in_flight = futures_wait(in_flight, timeout=3.0, return_when=FIRST_COMPLETED)
    _cleanup(ref_temps_all)  # 공유 임시파일은 전부 끝난 뒤 한 번에 삭제
    return total


# 같은 CLI 계정에 대해 한 번 '아니오' 하면 매 사이클 재질문하지 않도록 기억(스팸 방지).
_relogin_state = {"declined_email": None}

# CLI(`hf auth logout`)는 로컬 토큰만 지운다 — 브라우저 웹 세션은 그대로라, 이어서 `hf auth login`
# 하면 device 승인 페이지가 '같은 계정'으로 자동 승인돼 계정이 안 바뀌고 409 가 반복된다(이미지1 증상).
# 그래서 계정을 정말 바꾸려면 브라우저에서도 '로그아웃(signout)' 하게 안내·유도하는 동선이 필요하다.
_HF_SITE = "https://higgsfield.ai/"


def _cli_account_email(cli: str) -> str | None:
    acct = _cli_json(cli, "account", "status")
    return acct.get("email") if isinstance(acct, dict) else None


def offer_cli_relogin(cli: str, detail: str) -> bool:
    """계정 불일치(409)일 때, 이 PC 의 CLI 를 허브와 '같은 계정'으로 다시 로그인하도록 즉석 제안한다.
    별도 배치 파일 없이 MV_agent(에이전트) 창에서 바로 CLI 계정을 바꾼다.
    재로그인을 실제로 했으면 True. 비대화형(자동화·리다이렉트)에선 프롬프트 없이 False(안내만)."""
    if not (sys.stdin and sys.stdin.isatty()):
        return False
    cur = _cli_account_email(cli)
    if cur and cur == _relogin_state["declined_email"]:
        return False  # 같은 계정에 이미 '아니오' → 재질문 안 함
    print()
    print("  ------------------------------------------------------------------")
    print("  [계정 바꾸기] 이 PC 의 CLI 계정과 허브 로그인이 다릅니다.")
    if cur:
        print(f"               현재 CLI 계정: {cur}")
    print("  CLI 를 허브와 '같은 이메일'로 다시 로그인하면 push 가 자동 재개됩니다.")
    try:
        ans = input("  지금 CLI 계정을 바꿀까요? 브라우저 로그인 창이 열립니다 (y/N): ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    if ans != "y":
        _relogin_state["declined_email"] = cur
        print("  유지합니다. 나중에 이 창에서 다시 묻거나, 직접 `hf auth login` 으로 바꿀 수 있습니다.")
        print("  ------------------------------------------------------------------")
        return False
    # signout 동선 — CLI 로그아웃만으론 웹 세션이 남아 같은 계정으로 재로그인된다(409 루프).
    # 브라우저 로그아웃까지 거쳐 '다른 계정'으로 갈 수 있게 한 뒤 로그인. 같은 계정으로 돌아오면
    # 이벤트를 기다릴 필요 없이 그 자리에서 '웹 로그아웃 후 재시도'를 반복(무한루프 방지 상한 5회).
    new = cur
    for _ in range(5):
        new = _signout_and_relogin(cli)
        if not new or not cur or new != cur:
            break  # 확인 실패거나 계정이 실제로 바뀜 → 종료
        print("  [경고] 계정이 그대로입니다 — 브라우저 웹 세션이 남아 같은 계정으로 로그인됐습니다.")
        print(f"         {_HF_SITE} 에서 '로그아웃' 했는지 확인하세요.")
        try:
            again = input("  브라우저 로그아웃 후 다시 시도할까요? (y/N): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            again = "n"
        if again != "y":
            break
    switched = bool(new) and new != cur
    # 바뀌었으면 거절 기억 리셋(다음 사이클 정상). 같은 계정이면 매 사이클 자동 재질문은 막되
    # (스팸 방지), 사용자가 직접 y 로 다시 부를 수 있게 둔다.
    _relogin_state["declined_email"] = None if switched else cur
    print(f"  CLI 계정: {new or '(확인 실패)'}")
    print("  ------------------------------------------------------------------")
    return switched  # 정말 바뀌었을 때만 즉시 재시도(같은 계정이면 또 409 → 무한루프 방지)


def _signout_and_relogin(cli: str) -> str | None:
    """CLI + 브라우저(웹) 양쪽 로그아웃을 거친 뒤 다시 로그인 — '다른 계정'으로 전환 가능하게.
    반환: 재로그인 후의 CLI 계정 이메일(확인 실패면 None)."""
    print("  현재 CLI 계정 로그아웃...")
    try:
        subprocess.run([cli, "auth", "logout"], timeout=60)
    except Exception as e:  # noqa: BLE001 — 로그아웃 실패해도 로그인 시도는 진행
        print(f"  (로그아웃 경고: {e})")
    # 웹 세션 로그아웃 안내 — 이게 없으면 device 승인이 같은 계정으로 자동 통과돼 전환이 안 된다.
    print("  [signout] 다른 계정으로 바꾸려면 브라우저에서도 '로그아웃'이 필요합니다.")
    print(f"            브라우저로 {_HF_SITE} 를 엽니다 — 우측 상단 계정 메뉴에서 '로그아웃' 하세요.")
    try:
        webbrowser.open(_HF_SITE)
    except Exception:  # noqa: BLE001 — 브라우저 자동 오픈 실패해도 수동 안내로 진행
        pass
    try:
        input("            웹에서 로그아웃했으면 Enter — 허브와 '같은 계정'으로 로그인 창을 엽니다: ")
    except (EOFError, KeyboardInterrupt):
        print()
    print("  브라우저에서 허브와 '같은 이메일'로 로그인하세요...")
    try:
        subprocess.run([cli, "auth", "login"], timeout=300)
    except Exception as e:  # noqa: BLE001
        print(f"  [오류] CLI 로그인 실행 실패: {e}")
        return None
    return _cli_account_email(cli)


def push_once(server: str, token: str, cli: str, size: int, _allow_relogin: bool = True) -> None:
    # 1) 로컬 생성물(내 CLI·내 계정) + 크레딧·워크스페이스 상태
    jobs = _cli_json(cli, "generate", "list", "--size", str(size)) or []
    if not isinstance(jobs, list):
        jobs = []

    # 2) 서버에 없는 잡 판별 — 내 로컬 목록(≤size)을 보내 차집합만 받는다(POST).
    # GET(서버 보유 전량 응답)은 라이브러리가 수천 건으로 커지면 매 사이클 왕복이 무거워진다.
    # 구버전 서버(POST 미지원 404/405)면 기존 GET 전량 방식으로 폴백.
    local_ids = [j["id"] for j in jobs if isinstance(j, dict) and j.get("id")]
    fresh_ids: set | None = None
    if local_ids:
        st, diff = _http(
            "POST", f"{server}/api/ingest/known-jobs", token=token, body={"job_ids": local_ids}
        )
        if st == 200 and isinstance(diff, dict) and isinstance(diff.get("unknown"), list):
            fresh_ids = set(diff["unknown"])
    if fresh_ids is None:
        status, known = _http("GET", f"{server}/api/ingest/known-jobs", token=token)
        known_ids = set(known.get("job_ids") or []) if isinstance(known, dict) else set()
        fresh_ids = {j for j in local_ids if j not in known_ids}
    # account status(크레딧·플랜) + workspace list(내 워크스페이스)를 함께 보고 → 서버가 계정 메뉴에
    # '내 것'으로 표시(브라우저는 내 CLI에 직접 접근 못 하므로 이 보고값이 유일한 내 데이터).
    acct = _cli_json(cli, "account", "status")
    if isinstance(acct, dict):
        ws = _cli_json(cli, "workspace", "list")
        acct["workspaces"] = ws if isinstance(ws, list) else []
        acct["cli_version"] = _cached_cli_version(cli)  # 팀 CLI 버전 현황(버전 skew 진단)

    # PM: 실제 차감액(account transactions) — 사이클당 1회만(잡마다 호출하지 않음). 서버가
    # (소유자+시각) 매칭으로 생성물 실제 크레딧을 채운다. best-effort(실패해도 push 진행).
    txns = _cli_json(cli, "account", "transactions", "--size", "100")
    # CLI 1.x 는 거래를 {cursor, items} 로 감싼다(0.x 는 bare list). items 를 꺼낸다.
    if isinstance(txns, dict):
        txns = txns.get("items") or []
    if not isinstance(txns, list):
        txns = []
    # 거래 표시명(display_name)을 모델 키(job_set_type)로 변환해 태깅 → 서버가 모델 가드로 정확 매칭.
    # best-effort: model list 실패/미태깅 거래는 서버가 시간+소유자 매칭으로 폴백(하위호환).
    # CLI 1.x model list 는 모델키를 job_set_type → job_type 로 개명. 둘 다 수용(구/신 호환).
    models = _cached_models(cli)
    if isinstance(models, list):
        dn2key = {
            m.get("display_name"): (m.get("job_set_type") or m.get("job_type"))
            for m in models
            if isinstance(m, dict) and m.get("display_name") and (m.get("job_set_type") or m.get("job_type"))
        }
        for t in txns:
            if isinstance(t, dict) and t.get("display_name") in dn2key:
                t["model"] = dn2key[t["display_name"]]

    # 3) 새 것만 추림(서버에 없는 job_id)
    fresh = [j for j in jobs if isinstance(j, dict) and j.get("id") and j["id"] in fresh_ids]
    # 내 힉스필드 uid = 내 전체 목록의 최다 user_<id>(= 내 본인 것). fresh 만 보면 남의 레퍼런스에
    # 오염될 수 있으므로 반드시 '전체 목록' 기준으로 산출해 명시 전송 → 서버가 올바르게 연결.
    my_uid = _dominant_uid(jobs)
    print(f"[로컬] 잡 {len(jobs)}개 중 새 잡 {len(fresh)}개 · 내 uid={my_uid}")
    if not fresh and not acct:
        print("[완료] 올릴 새 결과물이 없습니다.")
        return

    # 4) 서버로 push (메타데이터만 — 미디어는 공개 URL 그대로, 토큰 안 보냄)
    status, body = _http(
        "POST", f"{server}/api/ingest", token=token,
        body={"jobs": fresh, "creator_uid": my_uid, "account_status": acct,
              "account_transactions": txns},
    )
    if status != 200 or not isinstance(body, dict):
        # 적재 실패로 watch 루프를 죽이지 않는다(소프트 보류) — 로그인 전(401·인증 필요)이나
        # 계정 불일치(409·CLI≠허브로그인)는 사용자가 올바른 계정으로 로그인하면 다음 사이클에
        # 자동 성공한다. 메시지는 그대로 보여 원인(특히 409 불일치)을 알게 한다.
        detail = body
        if isinstance(body, dict):
            detail = body.get("detail")
        elif isinstance(body, str):
            try:  # _http 는 에러 본문을 JSON 텍스트로 준다 → detail 만 깔끔히 추출
                detail = json.loads(body).get("detail", body)
            except (ValueError, AttributeError):
                detail = body
        print(f"[보류] 적재 실패(status={status}): {detail}")
        # 계정 불일치(409) → 별도 배치 없이 이 에이전트 창에서 바로 CLI 재로그인 제안 후 즉시 재시도.
        if status == 409 and _allow_relogin and offer_cli_relogin(cli, str(detail)):
            print("[재시도] CLI 재로그인 완료 — 지금 바로 다시 push 합니다.")
            return push_once(server, token, cli, size, _allow_relogin=False)
        print("       올바른 계정으로 허브에 로그인하면 자동으로 다시 시도합니다.")
        return
    print(
        f"[완료] 신규 {body.get('inserted')} · 갱신 {body.get('updated')} · "
        f"변동없음 {body.get('unchanged')} · 건너뜀 {body.get('skipped')} · "
        f"연결 uid={body.get('linked_uid')}"
    )
    if body.get("errors"):
        print(f"[경고] 서버 반영 실패 {body['errors']}건 — 서버 로그 확인 필요(다음 push 에서 재시도됨)")


def main() -> None:
    # 로그를 콘솔에 즉시 찍어 '무엇을 했는지' 실시간으로 보이게(파이프/리다이렉트에서도).
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Content Hub 로컬 push 에이전트")
    ap.add_argument("--server", required=True, help="허브 서버 주소 (예: http://192.168.0.10:8010)")
    ap.add_argument("--email", help="내 허브 로그인 이메일(로그인 모드에서 필요)")
    ap.add_argument("--password", help="허브 비밀번호(생략 시 안전 입력 프롬프트)")
    ap.add_argument("--token", help="허브 세션 토큰 직접 사용(로그인 생략 — 자동화/테스트용)")
    ap.add_argument("--size", type=int, default=100, help="로컬에서 읽을 최근 잡 수(기본 100, CLI 상한)")
    ap.add_argument("--watch", type=int, metavar="SEC", help="상주(이벤트) 모드 — 롱폴로 대기하다 액션 시 즉시 작동. 값은 호환용(무시)")
    ap.add_argument(
        "--no-push", action="store_true",
        help="생성 전용 모드 — 허브의 생성/재생성 요청만 내 CLI로 실행하고, 로컬 CLI 이력을 "
             "서버로 자동 push 하지 않는다(로컬 허브용: 공유는 '선택 발행'으로만).",
    )
    args = ap.parse_args()

    server = args.server.rstrip("/")
    cli = _cli()
    creds: dict | None = None  # 세션 만료 시 자동 재로그인용(메모리에만 유지, 저장 안 함)
    if args.token:
        token = args.token  # AUTH off 로컬 허브는 토큰을 검증하지 않으므로 더미('local')도 됨
        print(f"[토큰] 전달된 세션 토큰 사용({args.email or '로컬'})")
    else:
        if not args.email:
            sys.exit("[오류] --email 또는 --token 중 하나는 필요합니다.")
        password = args.password or getpass.getpass(f"{args.email} 허브 비밀번호: ")
        token = login(server, args.email, password)
        creds = {"email": args.email, "password": password}

    def cycle() -> None:
        # ① 허브에서 요청한 생성/재생성을 내 로컬 CLI로 실행 → 결과 보고(연속 풀로 자체 소진)
        execute_pending(server, token, cli)
        # ② 로컬 CLI 이력 자동 push — 로컬 허브(--no-push)는 안 함(공유는 '선택 발행'으로만)
        if not args.no_push:
            push_once(server, token, cli, args.size)

    if args.watch:
        # 이벤트 방식 — 평소엔 롱폴로 조용히 대기, 내가 허브에서 생성/재생성·동기화 할 때만 작동.
        print("[이벤트] 대기 모드 — 생성/재생성·동기화 때만 작동 (Ctrl+C 종료)")
        try:
            cycle()  # 시작 시 한 번: 밀린 생성요청 처리 + 내 작업 올리기
        except Exception as e:  # noqa: BLE001
            print(f"[경고] 초기 처리 오류(무시): {e}")
        while True:
            reason = _wait_event(server, token)  # 이벤트 올 때까지 대기(폴링 없음)
            if reason == "__reauth__":
                # 세션 만료 → 자동 재로그인(자격이 메모리에 있을 때만). 실패하면 login 이 종료한다
                # (비밀번호 변경/계정 정지 등 — 무한 재시도 루프 방지).
                if not creds:
                    sys.exit("[오류] 세션 만료/인증 실패 — 에이전트를 다시 실행하세요.")
                print("[세션] 만료 감지 — 자동 재로그인")
                token = login(server, creds["email"], creds["password"])
                continue
            # 사유가 콤마로 합쳐 올 수 있다(gen-request 와 sync 가 함께 쌓인 경우) → 멤버십으로 검사.
            reasons = set((reason or "").split(",")) if reason else set()
            try:
                if "gen-request" in reasons:
                    print("[이벤트] 허브 생성/재생성 요청 — 내 CLI로 실행")
                    execute_pending(server, token, cli)  # 연속 풀 — 16칸 채우고 다 비울 때까지
                # gen-request·sync 어느 쪽이든 결과를 서버로 올린다(no_push 모드 제외).
                if reasons & {"gen-request", "sync"}:
                    if args.no_push:
                        if "sync" in reasons and "gen-request" not in reasons:
                            print("[이벤트] 동기화 요청 — 생성 전용 모드라 건너뜀(공유는 '선택 발행')")
                    else:
                        if "sync" in reasons and "gen-request" not in reasons:
                            print("[이벤트] 내 작업 올리기 요청")
                        push_once(server, token, cli, args.size)
                # reason None/타임아웃(idle) → 조용히 재대기
            except SystemExit:
                raise
            except Exception as e:  # noqa: BLE001 — 한 번 실패해도 루프 유지
                print(f"[경고] 처리 중 오류(무시하고 계속): {e}")
    else:
        cycle()


if __name__ == "__main__":
    main()
