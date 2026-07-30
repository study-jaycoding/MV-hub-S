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
from threading import Event, Lock
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


# ── Windows .CMD 셰임 우회 ─────────────────────────────────────────────
# npm 글로벌 CLI 는 `higgsfield.CMD`(배치)로 잡힌다. subprocess 가 이를 실행하면 cmd.exe 를 거치는데,
# cmd.exe 는 인자 안의 `<` `>` 를 리다이렉션으로 해석한다 → 프롬프트의 `<<<imageN>>>` 토큰이
# "<< was unexpected at this time." 로 깨진다. 셰임이 부르는 실제 `higgsfield.js` 를 찾아
# `node <js>` 로 직접 실행하면 cmd.exe 를 우회해 토큰이 그대로 전달된다.
def _shim_target_js(cmd_path):
    """`.cmd`/`.bat` 셰임이 실행하는 node .js 경로. 못 찾으면 None."""
    try:
        with open(cmd_path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()
    except OSError:
        return None
    m = re.search(r'"([^"]*?\.js)"', text)
    if not m:
        return None
    dp0 = os.path.dirname(cmd_path)
    js = m.group(1).replace("%~dp0%", dp0).replace("%dp0%", dp0).replace("%~dp0", dp0)
    js = os.path.normpath(js)
    return js if os.path.exists(js) else None


_CLI_ARGV_CACHE = {}


def _cli_argv(cli):
    """subprocess 실행용 argv 접두 리스트. Windows .cmd/.bat 셰임이면 node+js 로 풀어 cmd.exe 를 우회."""
    cached = _CLI_ARGV_CACHE.get(cli)
    if cached is not None:
        return cached
    argv = [cli]
    if os.name == "nt" and cli.lower().endswith((".cmd", ".bat")):
        js = _shim_target_js(cli)
        if js:
            argv = [shutil.which("node") or "node", js]
    _CLI_ARGV_CACHE[cli] = argv
    return argv


def _parse_cli_json(stdout: str):
    """CLI stdout → 파싱값(실패 시 None). `--json` 단일 JSON 이면 그대로.
    `generate create --wait` 처럼 진행줄+최종 JSON 이 섞여 whole 파싱이 안 되면, 뒤에서부터
    마지막 JSON 을 복구한다(JSONL 이든 여러 줄 pretty-print 든). ★생성 결과 오인식 방지는
    호출측(_execute_one)이 job.id 필수 검증으로 담당 — 여기선 '파싱되는 JSON' 만 돌려준다."""
    s = stdout or ""
    if not s.strip():
        return None
    # 1) 정상 단일 JSON(배열 포함) — list/model get/upload/account status 등은 여기서 끝(영향 없음).
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # 2) JSONL/진행줄 — 뒤에서부터 한 줄씩 파싱해 마지막으로 성공하는 값을 채택.
    for line in reversed(s.splitlines()):
        t = line.strip()
        if t[:1] in ("{", "["):
            try:
                return json.loads(t)
            except json.JSONDecodeError:
                continue
    # 3) 여러 줄 pretty-print 최종 JSON — 줄머리가 여는 괄호인 위치에서 raw_decode(뒤→앞).
    dec = json.JSONDecoder()
    starts, pos = [], 0
    for line in s.splitlines(keepends=True):
        if line.lstrip()[:1] in ("{", "["):
            starts.append(pos + (len(line) - len(line.lstrip())))
        pos += len(line)
    for st in reversed(starts):
        try:
            return dec.raw_decode(s[st:])[0]
        except json.JSONDecodeError:
            continue
    return None


# exit 0 인데 --json 출력이 파싱 안 될 때의 오류 prefix. 복구(_extract_created_id)는 이 케이스에만
# 적용한다 — 진짜 CLI 실패 메시지("CLI 실패(...)") 안의 UUID 를 잘못 복구하지 않도록 게이트.
_PARSE_FAIL_PREFIX = "CLI JSON 파싱 실패(비-JSON 출력): "


def _as_text(v) -> str:
    """subprocess 출력(bytes|str|None)을 문자열로. TimeoutExpired.stdout 은 text 모드여도 bytes 로
    올 수 있어 방어적으로 디코드한다."""
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return str(v)


# 타임아웃 오류 prefix. 이 뒤엔 '순수 CLI 출력'(우리 args 아님)만 담아, _extract_created_id 가 args 에 박힌
# 레퍼런스 업로드 UUID 가 아니라 진짜 잡 id 만 되찾게 한다. 파싱실패와 함께 '모호한 결말'로 취급한다.
_TIMEOUT_PREFIX = "CLI 타임아웃(부분출력): "


def _run_cli_json(cli: str, *args: str, timeout: int = 120):
    """higgsfield CLI 를 --json 으로 실행하고 (파싱 결과, 오류문구) 반환."""
    try:
        out = subprocess.run(
            [*_cli_argv(cli), *args, "--json"],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        # 타임아웃이어도 CLI 가 이미 찍은 부분 출력에 방금 만든 job id 가 있을 수 있다 → 버리지 않고
        # (순수 CLI 출력만) 담아, _extract_created_id 가 그 UUID 로 job_id 를 되찾게 한다(가짜 실패 방지).
        partial = _as_text(e.stdout) or _as_text(e.stderr)
        partial = "".join(ch for ch in partial if ch == "\n" or ch >= " ").strip()[:800]
        print(f"[경고] CLI 타임아웃: {' '.join(args)[:160]}")
        return None, f"{_TIMEOUT_PREFIX}{partial}"
    if out.returncode != 0:
        msg = (out.stderr or out.stdout or "").strip()
        # 진짜 CLI 에러를 앞에 둔다 — 뒤에서 잘려도 원인이 남게. 긴 명령어(JSON 프롬프트·ref UUID)는
        # 짧게 뒤에 붙인다(예전엔 명령어가 앞이라 하류 500자 컷에 실제 실패 사유가 통째로 잘렸다).
        return None, f"CLI 실패: {msg[:600]} — cmd: {' '.join(args)[:160]}"
    parsed = _parse_cli_json(out.stdout)
    if parsed is not None:
        return parsed, None
    # exit 0 인데 파싱 불가 — 실제 출력을 담아 원인 규명이 되게 한다(예전엔 args 만 찍어 원인을 잃었다).
    # 제어문자 제거·800자 제한.
    raw = (out.stdout or "").strip() or (out.stderr or "").strip()
    raw = "".join(ch for ch in raw if ch == "\n" or ch >= " ")[:800]
    return None, f"{_PARSE_FAIL_PREFIX}{raw or ' '.join(args)}"


def _cli_json(cli: str, *args: str, timeout: int = 120):
    """higgsfield CLI 를 --json 으로 실행하고 파싱 결과 반환(실패 시 None)."""
    data, err = _run_cli_json(cli, *args, timeout=timeout)
    if err:
        print(f"[경고] {err}")
    return data


# 잡 id(UUID) 추출용 — generate create 가 --wait 조합에서 JSON 대신 평문(잡 id 또는 결과 URL)만
# 내보낸 경우를 대비해, 출력에서 잡 id 를 되찾는다.
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def _extract_created_id(created, cli_error: str | None) -> str | None:
    """비대기 `generate create --json` 응답에서 방금 만든 job_id 를 뽑는다. 실측 응답은 ["<uuid>"] 배열
    이지만 dict{id}·평문도 방어적으로 수용한다. 파싱실패/타임아웃 오류출력에서도 UUID 를 복구한다
    (진짜 실패 메시지 "CLI 실패:" 는 제외 — args 에 박힌 레퍼런스 UUID 를 잘못 잡지 않도록 게이트)."""
    cands: list[str] = []
    if isinstance(created, list):
        for el in created:
            if isinstance(el, str):
                cands.append(el)
            elif isinstance(el, dict) and el.get("id"):
                cands.append(str(el["id"]))
    elif isinstance(created, dict):
        if created.get("id"):
            cands.append(str(created["id"]))
    elif isinstance(created, str):
        cands.append(created)
    for c in cands:
        m = _UUID_RE.search(c)
        if m:
            return m.group(0)
    if cli_error and cli_error.startswith((_PARSE_FAIL_PREFIX, _TIMEOUT_PREFIX)):
        ids = _UUID_RE.findall(cli_error)
        if ids:
            return ids[-1]
    return None


# 아직 '처리중'인 원시 상태값 — 이 상태의 잡을 (모호한 결말에서) 되찾으면 실패로 끝내지 않고 anchor 로
# job_id 만 박고 '확인중(running)' 유지한다. 재조정 패스가 done/failed 로 확정. (done/failed/nsfw 등
# 종료계열은 기존 fulfill 경로가 처리 — 서버 normalize_status 가 최종 매핑.)
_PROCESSING_RAW = {"queued", "in_queue", "pending", "created", "running", "processing", "in_progress"}


def _job_status(job: dict) -> str:
    """잡 dict 의 상태 원시값(소문자). 일부 응답은 status 대신 job_status 를 쓰므로 폴백."""
    return str(job.get("status") or job.get("job_status") or "").strip().lower()


# 생성된 잡에 실제로 붙은 입력 이미지 개수 — 모델별 스키마 차이를 모두 커버(pro=params.input_images,
# flash/lite=params.medias[role=image], 스펙명 image_references). 레퍼런스를 붙여 실행했는데 여기서 0 이면
# 힉스필드가 입력 이미지를 안 받은 것(=레퍼런스 미적용 → 엉뚱한 결과)이라, fulfill 전에 방어 실패시킨다.
# 레퍼런스 토큰 → CLI 용 <<<kindN>>>. 두 형태 모두 정규화한다:
#  · @imageN(알약 serialize 형태) — 앞뒤 경계로 foo@image1 오인 방지
#  · <<<image_1>>>/<<<IMAGE1>>>/<<< image 1 >>> 등 변형 — 언더바·대소문자·공백 정리
_MEDIA_REF_AT = re.compile(
    r"(?<![A-Za-z0-9_])@(simage|eimage|image|video|vedio|audio)_?(\d+)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_MEDIA_REF_ANGLE = re.compile(
    r"<<<\s*(simage|eimage|image|video|vedio|audio)\s*_?\s*(\d+)\s*>>>",
    re.IGNORECASE,
)


def _canon_kind(raw: str) -> str:
    raw = raw.lower()
    return "video" if raw == "vedio" else ("image" if raw in ("simage", "eimage") else raw)


def _canon_media_ref_tokens(text: str) -> str:
    text = _MEDIA_REF_ANGLE.sub(lambda m: f"<<<{_canon_kind(m.group(1))}{m.group(2)}>>>", text)
    text = _MEDIA_REF_AT.sub(lambda m: f"<<<{_canon_kind(m.group(1))}{m.group(2)}>>>", text)
    return text


# CLI 는 --prompt 값이 통째로 유효한 JSON(object/array)이면 문자열이 아니라 '객체'로 파싱해
# "prompt should be string, got object" 로 거부한다(힉스 웹은 문자열 그대로 받아 정상 생성).
# 작업자가 JSON 형태의 지시서를 프롬프트로 넣는 경우가 있어, 그럴 때 zero-width space 한 글자를
# 맨 앞에 붙여 CLI 가 문자열로 받게 한다(zwsp 는 모델·표시에 보이지 않아 프롬프트 내용은 그대로 보존).
_ZWSP = chr(0x200B)  # zero-width space (U+200B)


def _shield_json_prompt(text: str) -> str:
    s = text.lstrip()
    if s[:1] not in ("{", "["):
        return text
    try:
        json.loads(s)
    except (ValueError, TypeError):
        return text  # 완전한 JSON 이 아니면(뒤에 텍스트 등) CLI 도 문자열로 보므로 그대로 둔다
    return _ZWSP + text


def _job_image_input_count(job: dict) -> int:
    params = job.get("params") if isinstance(job, dict) else None
    if not isinstance(params, dict):
        return 0
    count = 0
    for key in ("input_images", "image_references"):
        v = params.get(key)
        if isinstance(v, list):
            count += sum(1 for x in v if x)
        elif v:
            count += 1
    for m in params.get("medias") or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").lower()
        typ = str(m.get("type") or "").lower()
        if typ == "image" or role.startswith(("image", "@image", "start", "@start", "end", "@end")):
            count += 1
    return count


def _cli_version(cli: str) -> str | None:
    """CLI 빌드 버전 문자열(예: '0.2.3'). `higgsfield version` 은 JSON 이 아니라 평문이라 직접 파싱.
    실패해도 None — 버전 보고는 부가정보(없어도 push 진행)."""
    try:
        out = subprocess.run([*_cli_argv(cli), "version"], capture_output=True, text=True, timeout=30)
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


_SUPPRESSED_JOBS: "set[str] | None" = None  # 미부착 등으로 '카드화 금지'한 고아 job id (지연 로드)


def _suppress_path() -> str:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, "MVHub", "higgsfield_suppressed_jobs.json")
    return os.path.join(os.path.expanduser("~"), ".mvhub", "higgsfield_suppressed_jobs.json")


def _load_suppressed() -> "set[str]":
    global _SUPPRESSED_JOBS
    if _SUPPRESSED_JOBS is not None:
        return _SUPPRESSED_JOBS
    ids: set = set()
    try:
        with open(_suppress_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
            if isinstance(raw, dict) and isinstance(raw.get("job_ids"), list):
                ids = {j for j in raw["job_ids"] if isinstance(j, str)}
    except (OSError, json.JSONDecodeError):
        pass
    _SUPPRESSED_JOBS = ids
    return ids


def _suppress_job(job_id: "str | None") -> None:
    """레퍼런스 미부착으로 실패한 고아 잡을 '카드화 금지' 목록에 넣는다 — 다음 push 사이클의
    generate list 에 남아 있어도 서버로 올리지 않는다(실패는 실패로 끝, 엉뚱한 카드가 안 생긴다)."""
    if not job_id:
        return
    ids = _load_suppressed()
    if job_id in ids:
        return
    ids.add(job_id)
    try:
        path = _suppress_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = {"version": 1, "job_ids": list(ids)[-2000:]}  # 무한 증식 방지(최근 2000개)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError as e:
        print(f"[경고] 억제목록 저장 실패: {e}")


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
    """로컬 레퍼런스 파일을 Higgsfield media_input 으로 업로드하고 (medias[].data, 캐시사용여부) 반환.
    in-flight 잠금: 같은 파일을 여러 스레드가 동시에 올리면 한 스레드만 업로드하고 나머지는 그 결과를
    기다린다(벌크 seedance 에서 같은 캐릭터/스토리보드 참조가 16병렬로 겹쳐 중복 업로드되던 것 방지)."""
    key = None
    size = 0
    my_ev = None
    legacy = "_items" not in upload_cache
    if legacy:  # 플랫 dict 캐시 — 실사용 경로 아님(_load_upload_cache 는 항상 _items 생성). 그대로 둔다.
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
        while True:  # 캐시 재확인 + in-flight 조정 루프
            wait_ev = None
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
                inflight = upload_cache.setdefault("_inflight", {})
                ev = inflight.get(key)
                if ev is None or force:  # 내가 업로드 담당(또는 force 재업로드) — 자리표로 대기자에 알림
                    my_ev = Event()
                    inflight[key] = my_ev
                    break
                wait_ev = ev  # 다른 스레드가 올리는 중 — 대기 후 처음으로(성공 시 캐시히트로 반환)
            wait_ev.wait(timeout=300)  # 업로더 완료(또는 실패)까지 대기. 실패면 재확인 후 내가 승격.
    try:
        up = _cli_json(cli, "upload", "create", path, timeout=300)
        if isinstance(up, list):
            up = up[0] if up else None
        if not isinstance(up, dict) or not up.get("id"):
            print(f"[경고] 레퍼런스 업로드 실패: {path}")
            return None, False
        data = {"id": up.get("id"), "type": "media_input"}
        if up.get("url"):
            data["url"] = up.get("url")
        if legacy:
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
    finally:
        if my_ev is not None:  # 자리표 정리 + 대기자 깨우기(성공/실패 무관)
            with upload_lock:
                if upload_cache.get("_inflight", {}).get(key) is my_ev:
                    upload_cache["_inflight"].pop(key, None)
            my_ev.set()


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


# --- 크래시 세이프 앵커 outbox ---------------------------------------------------
# create 로 job_id 를 얻은 직후, 서버 앵커가 닿기 전에 죽어도(네트워크 순단·프로세스 종료) job_id 를
# 잃지 않도록 로컬 파일에 먼저 적어둔다. 재조정 패스/재시작이 이 outbox 를 재전송해 반드시 앵커되게 한다.
_outbox_lock = Lock()


def _outbox_path() -> str:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, "MVHub", "anchor_outbox.json")
    return os.path.join(os.path.expanduser("~"), ".mvhub", "anchor_outbox.json")


def _outbox_load() -> list:
    try:
        with open(_outbox_path(), "r", encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _outbox_save(items: list) -> None:
    path = _outbox_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items[-500:], f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def _outbox_add(rid: str, job_id: str) -> None:
    with _outbox_lock:
        items = _outbox_load()
        if not any(isinstance(it, dict) and it.get("rid") == rid for it in items):
            items.append({"rid": rid, "job_id": job_id})
            _outbox_save(items)


def _outbox_remove(rid: str) -> None:
    with _outbox_lock:
        items = [it for it in _outbox_load() if not (isinstance(it, dict) and it.get("rid") == rid)]
        _outbox_save(items)


def _anchor(server: str, token: str, rid: str, job_id: str, verifying: bool = False) -> bool:
    """placeholder 에 job_id 를 박고 running 유지 — create-first(verifying=False)는 '생성중'으로,
    모호한 결말·재시작 복구(verifying=True)는 '확인중'으로 표시. 서버 200 이면 True."""
    st, _ = _http(
        "POST",
        f"{server}/api/gen-requests/{rid}/anchor?job_id={quote(job_id)}"
        f"&verifying={'true' if verifying else 'false'}",
        token=token,
    )
    return st == 200


def _anchor_with_retry(server: str, token: str, rid: str, job_id: str, attempts: int = 3) -> bool:
    """앵커 ACK(200)를 받을 때까지 몇 번 재시도. 성공하면 outbox 에서 제거(서버가 job_id 를 가졌으니
    이후 크래시는 재조정 백스톱이 덮는다). 끝내 실패하면 outbox 에 남겨 다음 사이클/재시작에 재전송."""
    for _ in range(max(1, attempts)):
        if _anchor(server, token, rid, job_id, verifying=False):
            _outbox_remove(rid)
            return True
    return False


def replay_outbox(server: str, token: str) -> None:
    """지난번 크래시/순단으로 서버에 못 닿은 job_id 앵커를 재전송 — 재조정 패스 초에 매번 돈다(idle 포함).
    재시작 복구이므로 '확인중'으로 앵커(verifying=True). 성공분은 outbox 에서 제거."""
    items = _outbox_load()
    if not items:
        return
    print(f"[복구] 미전송 앵커 {len(items)}건 재전송")
    for it in items:
        if not isinstance(it, dict):
            continue
        rid, job_id = it.get("rid"), it.get("job_id")
        if rid and job_id and _anchor(server, token, rid, job_id, verifying=True):
            _outbox_remove(rid)


def _reconcile(server: str, token: str, rid: str, job: dict, force_fail_reason: str | None = None) -> int:
    """create-first 완료 확정 — generate wait/get 로 확보한 최종 job 을 /reconcile 로 권위 보정한다.
    앵커가 gen_request 를 done 으로 닫았으므로 /fulfill 은 멱등 no-op → 완료는 /reconcile 로만 확정한다.
    force_fail_reason 이면 레퍼런스 미부착 등 로컬 검증 실패로 '되살림 금지' failed 확정. 서버 status 반환."""
    url = f"{server}/api/gen-requests/{rid}/reconcile"
    if force_fail_reason:
        url += f"?force_fail_reason={quote(force_fail_reason)}"
    st, _ = _http("POST", url, token=token, body={"job": job})
    return st


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
    # ★CLI 프롬프트는 반드시 한 줄 — 개행이 있으면 Higgsfield 가 레퍼런스(입력 이미지)를 못 붙여 '엉뚱한
    #  결과물'이 나온다(실측). 프론트 신규·재사용·재생성·직접 API·옛 DB 데이터 어느 경로로 왔든 최종 관문인
    #  여기서 한 번에 접는다(display_prompt 는 서버가 별도 보관하므로 표시·재사용 줄바꿈은 영향 없음).
    prompt = re.sub(r"\s+", " ", prompt).strip()
    # 레퍼런스 토큰 @imageN 은 알약이 serialize 한 형태다. CLI 는 <<<imageN>>> 를 받아야 하므로 여기서도 되돌린다
    #  (재생성·옛 데이터 등 프론트 정규화를 우회한 경로 방어). simage/eimage→image, vedio→video.
    prompt = _canon_media_ref_tokens(prompt)
    # 통째 JSON 프롬프트(작업자가 지시서를 붙여넣는 경우)는 CLI 가 '객체'로 파싱해 거부한다 →
    # zero-width space 를 앞에 붙여 문자열로 받게 한다(힉스 웹과 동일 동작, 내용은 그대로).
    prompt = _shield_json_prompt(prompt)
    # ★create-first: --wait 없이 제출해 job_id 를 즉시 확보한다. 긴 대기(15~30분)를 시작하기 전에
    #  job_id 를 서버에 앵커해두어, 대기 중 프로그램이 꺼져도 재조정이 반드시 이어받아 완료시킨다.
    args = ["generate", "create", model, "--prompt", prompt]
    # ★batch_size 는 1 로 강제 — create-first 는 잡 1개(=카드 1개)를 앵커·대기하므로, N>1 이면 나머지
    #  잡이 앵커·검증 없이 나중에 synced 독립 카드로 새어 나온다(프론트 배치는 요청 N개 복제 방식이라 무영향).
    params = dict(r.get("params") or {})
    if str(params.get("batch_size", "1")) != "1":
        print(f"  ⚠ batch_size={params.get('batch_size')} → 1 강제(카드 1개=잡 1개 원칙)")
        params["batch_size"] = 1
    args += _param_flags(params, _allowed_params(cli, model))
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
    expected_image_inputs = 0  # 우리가 실제로 CLI 에 넣은 입력 이미지 개수(사후 부착 검증용)
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
            if media_role == "image":
                expected_image_inputs += 1
            continue
        flag = _role_flag(ref.get("role"))
        args += [flag, resolved]
        if flag in ("--image", "--start-image", "--end-image"):
            expected_image_inputs += 1
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
    # 1) 비대기 제출 → job_id 즉시 확보(create 가 과금원). 응답 실측은 ["<uuid>"] 배열.
    created, cli_error = _run_cli_json(cli, *args, timeout=300)
    if (
        not _extract_created_id(created, None)
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
            created, cli_error = _run_cli_json(cli, *retry_args, timeout=300)
    job_id = _extract_created_id(created, cli_error)
    if not job_id:
        # job_id 를 못 얻음 = 제출 자체 실패(레퍼런스 오류 등은 위에서 이미 걸러짐). 진짜 실패이므로 hard fail.
        reason = "제출 실패(잡 id 없음)" if not cli_error else f"제출 실패: {cli_error[:700]}"
        if cli_error:
            print(f"[경고] {cli_error}")
        _fail(server, token, rid, reason)
        print(f"  ✗ 제출 실패: {job_id or ''}")
        return
    # 2) 즉시 앵커(크래시 세이프) — outbox 에 먼저 남기고 서버 ACK 재시도. ACK 실패해도 outbox 가
    #    재조정 패스/재시작 때 재전송하므로 계속 진행한다(잡은 이미 힉스필드에 떠 있음).
    _outbox_add(rid, job_id)
    if not _anchor_with_retry(server, token, rid, job_id):
        print(f"  ⚠ 앵커 보고 실패 — outbox 보관(재전송 예정): {job_id[:8]}")
    # 3) 완료까지 대기(최대 30분). wait 는 조회 성격(과금 없음). 실패/타임아웃이면 확정하지 않고
    #    백스톱 재조정에 위임한다 — 앵커돼 있으므로 반드시 이어받는다.
    print(f"  ⏳ 대기: {job_id[:8]} (최대 30분)")
    job, _werr = _run_cli_json(
        cli, "generate", "wait", job_id, "--timeout", "30m", "--interval", "5s", "--quiet", timeout=1860
    )
    if isinstance(job, list):
        job = job[0] if job else None
    if not (isinstance(job, dict) and job.get("id")):
        # wait 이 애매하게 끝남(타임아웃/파싱실패) → get 으로 1회 권위 재확인.
        job, _ = _run_cli_json(cli, "generate", "get", job_id, timeout=120)
    if not (isinstance(job, dict) and job.get("id")):
        print(f"  ⏳ 대기 결과 미확정 — 백스톱 재조정에 위임: {job_id[:8]}")
        return
    if _job_status(job) in _PROCESSING_RAW:
        print(f"  ⏳ 아직 처리중 — 백스톱 재조정에 위임: {job_id[:8]}")
        return
    # 4) 레퍼런스 미부착 방어 — 입력 이미지를 붙여 실행했는데(expected_image_inputs>0) 생성물에 0개면
    #    힉스필드가 레퍼런스를 무시한 것(엉뚱한 결과). 되살림 금지 force-fail 로 확정(백스톱이 done 으로
    #    되살리지 못하게 서버가 job_id 를 지운다). count>0 이면 통과, 0 이면 generate get 으로 1회 재확인.
    if expected_image_inputs > 0 and _job_image_input_count(job) <= 0:
        full, _ = _run_cli_json(cli, "generate", "get", job["id"], timeout=120)
        if isinstance(full, dict) and full.get("id"):
            job = full
        if _job_image_input_count(job) <= 0:
            _suppress_job(job.get("id"))
            # ★force-fail 은 반드시 서버에 안착해야 한다(안착 전엔 카드가 running+job_id 후보로 남아
            #  백스톱이 done 으로 되살릴 수 있음) → 200 받을 때까지 몇 번 재시도.
            reason = "레퍼런스가 적용되지 않았습니다(생성물에 입력 이미지 미부착) — 다시 시도하세요"
            ok = False
            for _ in range(3):
                if _reconcile(server, token, rid, job, force_fail_reason=reason) == 200:
                    ok = True
                    break
            print(
                f"  ✗ 레퍼런스 미부착 — 실패 확정(되살림 금지): {job['id'][:8]}"
                if ok else f"  ⚠ 레퍼런스 미부착 실패 보고 안착 실패(다음 사이클 재시도): {job['id'][:8]}"
            )
            return
    # 5) 완료/실패 확정 — reconcile 로 권위 보정(요청은 앵커가 done 으로 닫았으므로 fulfill 은 no-op).
    st = _reconcile(server, token, rid, job)
    print(f"  ✓ 확정 보고(reconcile status={st})" if st == 200 else f"  ✗ 확정 보고 실패(status={st})")


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
        subprocess.run([*_cli_argv(cli), "auth", "logout"], timeout=60)
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
        subprocess.run([*_cli_argv(cli), "auth", "login"], timeout=300)
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

    # 3) 새 것만 추림(서버에 없는 job_id) — 단, 미부착으로 실패한 고아 잡은 카드로 안 올린다.
    suppressed = _load_suppressed()
    fresh = [
        j
        for j in jobs
        if isinstance(j, dict) and j.get("id") and j["id"] in fresh_ids and j["id"] not in suppressed
    ]
    n_suppressed = sum(1 for j in jobs if isinstance(j, dict) and j.get("id") in suppressed and j.get("id") in (fresh_ids or set()))
    # 내 힉스필드 uid = 내 전체 목록의 최다 user_<id>(= 내 본인 것). fresh 만 보면 남의 레퍼런스에
    # 오염될 수 있으므로 반드시 '전체 목록' 기준으로 산출해 명시 전송 → 서버가 올바르게 연결.
    my_uid = _dominant_uid(jobs)
    skip_note = f" · 미부착 억제 {n_suppressed}개" if n_suppressed else ""
    print(f"[로컬] 잡 {len(jobs)}개 중 새 잡 {len(fresh)}개{skip_note} · 내 uid={my_uid}")
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


def reconcile_pass(server: str, token: str, cli: str) -> None:
    """서버가 준 '확인중/유실된 running'(job_id 보유) 로컬 카드를, 내 CLI 계정으로 generate get 해
    실제 상태로 보정 push 한다 — 우리 앱은 '실패/생성중'인데 힉스필드엔 실제로 완료된 카드를 자동 교정.
    조회(get)만 → 재생성·과금 없음. 실패는 조용히 넘겨 다음 사이클에 재시도(루프 유지)."""
    # 지난번 크래시/순단으로 서버에 못 닿은 job_id 앵커를 먼저 재전송 — 앵커돼야 아래 후보에 잡힌다.
    replay_outbox(server, token)
    st, data = _http("GET", f"{server}/api/gen-requests/reconcile-candidates", token=token)
    if st != 200 or not isinstance(data, dict):
        return
    cands = data.get("candidates")
    if not isinstance(cands, list) or not cands:
        return
    print(f"[재조정] 미확정 카드 {len(cands)}건 — 실제 상태 확인")
    for c in cands:
        if not isinstance(c, dict):
            continue
        rid, job_id = c.get("rid"), c.get("job_id")
        if not rid or not job_id:
            continue
        job = _cli_json(cli, "generate", "get", job_id, timeout=120)
        # 조회 불가/내 계정 잡 아님(not found)·파싱실패 → 안 건드림(상태 유지, 다음 사이클 재시도).
        if not (isinstance(job, dict) and job.get("id")):
            continue
        st2, body = _http(
            "POST", f"{server}/api/gen-requests/{rid}/reconcile", token=token, body={"job": job}
        )
        if st2 == 200 and isinstance(body, dict) and body.get("applied"):
            print(f"  ✓ 보정: {job_id[:8]} → {body.get('status')}")


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
        # ② '실제 상태 미확정'(확인중/유실된 running) 카드를 generate get 으로 보정 — 조회만(과금 없음).
        #    no_push 모드(생성 전용)여도 실행한다: 내가 실행한 요청의 진실을 맞추는 것이라 push 정책과 무관.
        reconcile_pass(server, token, cli)
        # ③ 로컬 CLI 이력 자동 push — 로컬 허브(--no-push)는 안 함(공유는 '선택 발행'으로만)
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
                # 매 사이클(이벤트·idle 타임아웃 모두) '실제 상태 미확정' 카드를 보정 — 확인중 카드를
                #  다음 idle(≈35초) 안에 실제 done/failed 로 확정. reason None/idle 이어도 조용히 돈다.
                #  ★push_once 보다 먼저 — 갓 생성한 카드의 PM 완료시각이 ingest 의 done 처리보다 앞서 기록되게.
                reconcile_pass(server, token, cli)
                # gen-request·sync 어느 쪽이든 결과를 서버로 올린다(no_push 모드 제외).
                if reasons & {"gen-request", "sync"}:
                    if args.no_push:
                        if "sync" in reasons and "gen-request" not in reasons:
                            print("[이벤트] 동기화 요청 — 생성 전용 모드라 건너뜀(공유는 '선택 발행')")
                    else:
                        if "sync" in reasons and "gen-request" not in reasons:
                            print("[이벤트] 내 작업 올리기 요청")
                        push_once(server, token, cli, args.size)
            except SystemExit:
                raise
            except Exception as e:  # noqa: BLE001 — 한 번 실패해도 루프 유지
                print(f"[경고] 처리 중 오류(무시하고 계속): {e}")
    else:
        cycle()


if __name__ == "__main__":
    main()
