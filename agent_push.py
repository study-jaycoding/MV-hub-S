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
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import webbrowser
import uuid
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as futures_wait
from datetime import datetime, timezone
from threading import Event, Lock
from urllib.parse import quote, urlencode, urlparse


def _masked_password_input(prompt: str, *, _read_key=None, _stream=None) -> str:
    """비밀번호를 콘솔에 노출하지 않고 글자 수만 `*`로 표시한다.

    Windows의 일부 실행 환경에서 getpass가 일반 입력으로 폴백해 실제 문자를 표시하는 경우가
    있어, Windows에서는 키를 echo 없이 직접 읽는다. 주입 인자는 콘솔을 건드리지 않는 테스트용이다.
    """
    if os.name != "nt" and _read_key is None:
        return getpass.getpass(prompt)

    restore_console_mode = None
    if _read_key is None:
        import ctypes
        import msvcrt

        _read_key = msvcrt.getwch
        # 일부 CMD/호스트 조합에서 getwch 사용 중에도 콘솔 ECHO_INPUT이 남는 사례를 이중 차단한다.
        # 입력이 끝나면 원래 모드로 반드시 복구해 이후 일반 input()이 정상 동작하게 한다.
        kernel32 = ctypes.windll.kernel32
        stdin_handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_ulong()
        if stdin_handle not in (0, -1) and kernel32.GetConsoleMode(stdin_handle, ctypes.byref(mode)):
            restore_console_mode = (kernel32, stdin_handle, mode.value)
            kernel32.SetConsoleMode(stdin_handle, mode.value & ~0x0004)  # ENABLE_ECHO_INPUT
    stream = _stream or sys.stdout
    chars: list[str] = []
    stream.write(prompt)
    stream.flush()
    try:
        while True:
            char = _read_key()
            if char in ("\r", "\n"):
                stream.write("\n")
                stream.flush()
                return "".join(chars)
            if char == "\x03":  # Ctrl+C
                stream.write("\n")
                stream.flush()
                raise KeyboardInterrupt
            if char == "\b":
                if chars:
                    chars.pop()
                    stream.write("\b \b")
                    stream.flush()
                continue
            if char in ("\x00", "\xe0"):  # 화살표·기능키의 2바이트 시퀀스
                _read_key()
                continue
            if not char or ord(char) < 32:
                continue
            chars.append(char)
            stream.write("*")
            stream.flush()
    finally:
        if restore_console_mode:
            kernel32, stdin_handle, original_mode = restore_console_mode
            kernel32.SetConsoleMode(stdin_handle, original_mode)


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
    호출측이 job.id 필수 검증을 담당 — 여기선 '파싱되는 JSON' 만 돌려준다."""
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


def _run_cli_command(cli: str, *args: str, timeout: int = 120) -> str | None:
    """JSON 출력이 필요 없는 CLI 명령을 실행한다. 성공은 None, 실패는 표시용 사유를 반환한다."""
    try:
        out = subprocess.run(
            [*_cli_argv(cli), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"CLI 시간 초과: {' '.join(args)}"
    if out.returncode != 0:
        return (out.stderr or out.stdout or f"종료 코드 {out.returncode}").strip()[:700]
    return None


def _request_workspace(value) -> dict:
    """서버 요청의 워크스페이스를 에이전트가 사용할 최소 규격으로 정규화한다."""
    value = value if isinstance(value, dict) else {}
    scope = str(value.get("scope") or "unknown").strip().lower()
    workspace_id = str(value.get("id") or "").strip() or None
    name = str(value.get("name") or "").strip() or None
    if scope == "team" and workspace_id:
        return {"scope": "team", "id": workspace_id, "name": name}
    if scope == "personal":
        return {"scope": "personal", "id": None, "name": name}
    return {"scope": "unknown", "id": None, "name": None}


def _workspace_context_from_list(workspaces) -> dict:
    """CLI workspace list에서 현재 선택 컨텍스트를 생성정보용 규격으로 만든다."""
    if not isinstance(workspaces, list):
        return {"scope": "unknown", "id": None, "name": None}
    selected = next(
        (w for w in workspaces if isinstance(w, dict) and w.get("is_selected")),
        None,
    )
    if not selected:
        return {"scope": "unknown", "id": None, "name": None}
    name = str(selected.get("name") or "").strip() or None
    if name:
        workspace_id = str(selected.get("id") or "").strip() or None
        if workspace_id:
            return {"scope": "team", "id": workspace_id, "name": name}
    return {"scope": "personal", "id": None, "name": name}


def _ensure_request_workspace(cli: str, value) -> tuple[bool, str | None]:
    """요청 워크스페이스로 CLI를 전환하고 실제 선택 상태를 다시 확인한다.

    요청 공간이 unknown이면 현재 CLI 선택값을 추측해 사용하지 않는다. CLI의 마지막 선택 공간은
    다른 요청이나 사용자의 수동 전환이 남긴 전역 상태라, 그대로 생성하면 다른 팀에 과금될 수 있다.
    """
    target = _request_workspace(value)
    if target["scope"] == "unknown":
        return False, (
            "요청의 워크스페이스 정보가 없습니다. 허브와 에이전트를 최신 버전으로 업데이트한 뒤 "
            "워크스페이스를 다시 선택하고 생성해 주세요"
        )
    workspaces, error = _run_cli_json(cli, "workspace", "list", timeout=60)
    if error or not isinstance(workspaces, list):
        return False, error or "워크스페이스 목록을 확인할 수 없습니다"

    if target["scope"] == "team":
        candidate = next(
            (
                w
                for w in workspaces
                if isinstance(w, dict) and str(w.get("id") or "") == target["id"]
            ),
            None,
        )
    else:
        # CLI 1.x의 개인 공간도 실제 id로 set 해야 한다. API 규격에는 개인 id를 저장하지 않고,
        # 현재 계정 목록에서 name 없는 개인 항목을 찾아 그 id로 전환한다.
        candidate = next(
            (
                w
                for w in workspaces
                if isinstance(w, dict) and not str(w.get("name") or "").strip()
            ),
            None,
        )
    if not candidate or not candidate.get("id"):
        label = target.get("name") or ("개인" if target["scope"] == "personal" else target["id"])
        return False, f"이 계정에서 워크스페이스를 찾을 수 없습니다: {label}"
    if not candidate.get("is_selected"):
        error = _run_cli_command(cli, "workspace", "set", str(candidate["id"]), timeout=60)
        if error:
            return False, f"워크스페이스 전환 실패: {error}"
        workspaces, error = _run_cli_json(cli, "workspace", "list", timeout=60)
        if error or not isinstance(workspaces, list):
            return False, error or "전환 결과를 확인할 수 없습니다"
    selected = next(
        (w for w in workspaces if isinstance(w, dict) and w.get("is_selected")),
        None,
    )
    if not selected or str(selected.get("id") or "") != str(candidate["id"]):
        return False, "워크스페이스 전환 검증에 실패했습니다"
    return True, None


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
_PROCESSING_RAW = {
    "queued", "in_queue", "pending", "created", "waiting", "running", "processing", "in_progress"
}


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


def _job_image_input_count(job: dict) -> int | None:
    """상세 응답이 입력 이미지 스키마를 실제로 제공할 때만 개수를 반환한다.

    None은 '0개'가 아니라 '이 CLI 버전 응답으로는 확인 불가'다. 확인 불가를 실패로 오판하지 않는다.
    """
    params = job.get("params") if isinstance(job, dict) else None
    if not isinstance(params, dict):
        return None
    count = 0
    recognized = False
    for key in ("input_images", "image_references"):
        if key not in params:
            continue
        recognized = True
        v = params.get(key)
        if isinstance(v, list):
            count += sum(1 for x in v if x)
        elif v:
            count += 1
    if "medias" in params:
        recognized = True
    for m in params.get("medias") or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").lower()
        typ = str(m.get("type") or "").lower()
        if typ == "image" or role.startswith(("image", "@image", "start", "@start", "end", "@end")):
            count += 1
    return count if recognized else None


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


# ── Hub gen-request HTTP 계약 어댑터 ────────────────────────────────────
# 실행 오케스트레이션은 URL·쿼리 형식을 직접 만들지 않는다. 서버 계약 변경 시 이 구간과
# backend/tests/test_agent_contracts.py 만 먼저 확인한다(단일 파일 배포 계약은 유지).
def _gen_request_url(
    server: str,
    rid: str | None = None,
    action: str | None = None,
    query: dict | None = None,
) -> str:
    url = f"{server.rstrip('/')}/api/gen-requests"
    if rid is not None:
        url += f"/{quote(str(rid), safe='')}"
    if action:
        url += f"/{action}"
    if query:
        url += f"?{urlencode(query)}"
    return url


def _claim_pending(server: str, token: str, limit: int, agent_id: str | None = None):
    # submission-stage: claim과 실제 유료 CLI 호출 사이를 서버 상태로 분리한다. 신 서버는 claimed로
    # 내려주고 begin-submission ACK 뒤에만 submitting으로 올린다. 구 서버는 capability를 무시하고
    # 기존 submitting 응답(새 필드 없음)을 주므로 혼합 업데이트 중에도 하위호환된다.
    query = {"limit": limit, "capability": "workspace,submission-stage"}
    if agent_id:
        query["agent_id"] = agent_id
    return _http(
        "GET",
        _gen_request_url(server, action="pending", query=query),
        token=token,
    )


def _pending_exists(server: str, token: str) -> bool:
    # 깨움 조회도 유료 claim 가능성을 묻는 에이전트 계약의 일부다. 신 서버는 이 선언으로
    # 구 에이전트만 차단하고, 구 서버는 모르는 query를 무시해 그대로 동작한다.
    status, body = _http(
        "GET",
        _gen_request_url(
            server,
            action="pending-exists",
            query={
                "capability": "workspace,submission-stage",
                "agent_id": _agent_instance_id(),
            },
        ),
        token=token,
    )
    return status == 200 and isinstance(body, dict) and body.get("pending") is True


def _retry_pause(attempt: int, base: float = 0.5, cap: float = 2.0) -> None:
    """멱등 HTTP 보고 재시도 사이의 짧은 지연(지수+jitter, 상한 소).

    종전엔 일시 장애(0/5xx)에 쉼 없이 3연속 호출했다 — 순단 중 같은 실패를 즉시 반복할 뿐이다.
    총 지연 상한을 작게 유지해(3회 기준 최대 ≈3.5초) claim lease 안에서 끝난다. 4xx 는 각
    호출부가 종전대로 즉시 중단한다. 첫 시도 전에는 부르지 않는다."""
    delay = min(cap, base * (2 ** attempt)) * (0.5 + random.random() / 2)
    time.sleep(delay)


def _begin_submission(
    server: str,
    token: str,
    rid: str,
    agent_id: str,
    submission_fingerprint: dict | None = None,
) -> bool:
    """신 서버의 staged claim을 실제 CLI 호출 직전에 submitting으로 전환한다.

    서버가 전이를 적용한 직후 응답만 유실될 수 있으므로 일시 장애는 멱등 API로 재확인한다.
    명시적인 4xx는 소유권 상실이므로 즉시 중단한다.
    """
    url = _gen_request_url(
        server,
        rid,
        "begin-submission",
        {"agent_id": agent_id},
    )
    for attempt in range(3):
        kwargs = {"token": token, "timeout": 15}
        if submission_fingerprint is not None:
            kwargs["body"] = submission_fingerprint
        status, body = _http("POST", url, **kwargs)
        if status == 200:
            return not isinstance(body, dict) or body.get("applied", True) is not False
        if 400 <= status < 500:
            return False
        if attempt < 2:
            _retry_pause(attempt)
    return False


def _release_claim(
    server: str,
    token: str,
    rid: str,
    agent_id: str,
) -> bool:
    """유료 CLI를 호출하지 못한 claimed 요청을 즉시 pending으로 반환한다."""
    status, _ = _http(
        "POST",
        _gen_request_url(server, rid, "release-claim", {"agent_id": agent_id}),
        token=token,
    )
    return status == 200


def _require_submission_recovery(server: str, token: str, rid: str) -> bool:
    """CLI 호출 뒤 job_id가 없는 모호한 결말을 자동 재생성 금지 상태로 보고한다."""
    url = _gen_request_url(server, rid, "recovery-required")
    for attempt in range(3):
        status, body = _http("POST", url, token=token, timeout=15)
        if status == 200:
            return not isinstance(body, dict) or body.get("applied", True) is not False
        if 400 <= status < 500:
            return False
        if attempt < 2:
            _retry_pause(attempt)
    return False


def _list_reconcile_candidates(server: str, token: str):
    return _http("GET", _gen_request_url(server, action="reconcile-candidates"), token=token)


def _list_recovery_probes(server: str, token: str):
    return _http("GET", _gen_request_url(server, action="recovery-probes"), token=token)


def _report_recovery_probe(
    server: str,
    token: str,
    rid: str,
    outcome: str,
    candidate_count: int,
    job_id: str | None = None,
) -> dict | None:
    body = {"outcome": outcome, "candidate_count": candidate_count}
    if job_id:
        body["job_id"] = job_id
    status, data = _http(
        "POST",
        _gen_request_url(server, rid, "recovery-probe"),
        token=token,
        body=body,
    )
    if status != 200 or not isinstance(data, dict) or data.get("applied") is False:
        return None
    return data


_GENERATE_READ_ACTIONS = frozenset({"list", "get"})


def _read_generate_json(cli: str, action: str, *args: str, timeout: int = 120):
    """자동 조사가 쓸 수 있는 HF 명령을 list/get으로 구조적으로 제한한다."""
    if action not in _GENERATE_READ_ACTIONS:
        raise ValueError(f"읽기 전용 조사에서 금지된 generate action: {action}")
    return _cli_json(cli, "generate", action, *args, timeout=timeout)


def _probe_epoch(value) -> float | None:
    if isinstance(value, (int, float)):
        number = float(value)
        return number / 1000.0 if number > 10_000_000_000 else number
    text = str(value or "").strip()
    if not text:
        return None
    try:
        number = float(text)
        return number / 1000.0 if number > 10_000_000_000 else number
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def _probe_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().lower()


def _job_reference_roles(medias) -> list[str]:
    roles: list[str] = []
    if not isinstance(medias, list):
        return roles
    for media in medias:
        if not isinstance(media, dict):
            continue
        data = media.get("data")
        fallback = data.get("type") if isinstance(data, dict) else ""
        roles.append(_probe_role(media.get("role"), fallback))
    return sorted(roles)


def _matches_submission_fingerprint(request: dict, job: dict) -> bool:
    """계정 범위 최신 목록에서 제출 시각·모델·프롬프트·옵션·레퍼런스를 보수적으로 대조한다."""
    fingerprint = request.get("fingerprint")
    if not isinstance(fingerprint, dict) or not job.get("id"):
        return False
    model = job.get("job_set_type") or job.get("job_type")
    if str(model or "") != str(fingerprint.get("model") or ""):
        return False
    params = job.get("params")
    if not isinstance(params, dict) or not isinstance(params.get("prompt"), str):
        return False
    candidate_prompt = re.sub(r"\s+", " ", params["prompt"].lstrip(_ZWSP)).strip()
    if hashlib.sha256(candidate_prompt.encode("utf-8")).hexdigest() != fingerprint.get(
        "prompt_sha256"
    ):
        return False

    created_at = _probe_epoch(job.get("created_at"))
    submitted_at = _probe_epoch(request.get("submission_started_at"))
    recovery_at = _probe_epoch(request.get("recovery_required_at"))
    if created_at is None or submitted_at is None:
        return False
    # 서버 begin 직전/CLI 시계 오차 2분을 허용하되, 복구 격리 뒤 생긴 동명 작업은 후보에서 뺀다.
    if created_at < submitted_at - 120:
        return False
    if recovery_at is not None and created_at > recovery_at + 120:
        return False

    candidate_options = params
    for key, expected in (fingerprint.get("params") or {}).items():
        # HF 목록이 기본값을 생략할 수 있어 없는 키는 중립으로 둔다. 명시된 값의 충돌은 제외한다.
        if key in candidate_options and _probe_value(candidate_options[key]) != _probe_value(expected):
            return False

    expected_roles = sorted(str(role) for role in (fingerprint.get("reference_roles") or []))
    candidate_roles = _job_reference_roles(params.get("medias"))
    # 공급자가 입력 메타를 통째로 누락한 검증실패 결과도 찾을 수 있게 빈 목록은 중립으로 둔다.
    if candidate_roles and candidate_roles != expected_roles:
        return False
    if not expected_roles and candidate_roles:
        return False
    return True


def recovery_probe_pass(server: str, token: str, cli: str) -> int:
    """모호한 제출을 최신 목록에서 읽기만 해 찾고, 유일 후보만 기존 placeholder에 앵커한다."""
    status, data = _list_recovery_probes(server, token)
    requests = data.get("requests") if status == 200 and isinstance(data, dict) else None
    if not isinstance(requests, list) or not requests:
        return 0
    anchored = 0
    pending_requests: list[dict] = []
    for request in requests:
        if not isinstance(request, dict) or not request.get("id"):
            continue
        # 유일 후보 기록 뒤 앵커 응답만 유실된 경우 최신 목록을 다시 추측하지 않고, ledger에
        # 저장한 같은 job_id만 재전송한다. create 계열 호출은 여전히 이 경로에 없다.
        recorded_job_id = request.get("recovery_probe_job_id")
        if request.get("recovery_probe_status") == "unique" and recorded_job_id:
            if _anchor(
                server, token, str(request["id"]), str(recorded_job_id), verifying=True
            ):
                anchored += 1
                print(f"  ✓ 모호한 제출 자동 복구 재시도: {str(recorded_job_id)[:8]}")
            continue
        pending_requests.append(request)
    if not pending_requests:
        return anchored
    jobs = _read_generate_json(cli, "list", "--size", "100", timeout=120)
    if not isinstance(jobs, list):
        return anchored
    list_saturated = len(jobs) >= 100
    # 창(최신 100건)의 가장 오래된 생성 시각 — 창이 제출 시점까지 거슬러 올라가면, 포화여도
    # 제출 구간 전체를 본 것이라 '없음'을 확정할 수 있다.
    listed_epochs = [
        epoch
        for job in jobs
        if isinstance(job, dict)
        for epoch in (_probe_epoch(job.get("created_at")),)
        if epoch is not None
    ]
    oldest_listed = min(listed_epochs) if listed_epochs else None
    for request in pending_requests:
        matches_by_id = {
            str(job["id"]): job
            for job in jobs
            if isinstance(job, dict) and _matches_submission_fingerprint(request, job)
        }
        matches = list(matches_by_id.values())
        if len(matches) == 1:
            outcome = "unique"
        elif matches:
            outcome = "multiple"
        else:
            # 최신 창이 꽉 찼어도, 창의 가장 오래된 잡이 제출 시각(시계 오차 2분 포함)보다
            # 앞서면 제출 구간 전체를 본 것이므로 '없음'을 확정한다 — 이력이 늘 100건 이상인
            # 계정에서 no_match 가 영구 보류돼 복구 카드가 안 풀리던 문제의 수정. 제출 이후
            # 100건 이상이 새로 쌓여 후보가 창 밖으로 밀렸을 수 있는 경우만 보류한다
            # (CLI list 에는 cursor 계약이 없어 더 과거는 못 본다).
            submitted_at = _probe_epoch(request.get("submission_started_at"))
            window_covers_submission = (
                submitted_at is not None
                and oldest_listed is not None
                and oldest_listed <= submitted_at - 120
            )
            if list_saturated and not window_covers_submission:
                print("  ⚠ 모호한 제출 조사 보류 — 최신 100건 창이 가득 참")
                continue
            outcome = "no_match"
        job_id = str(matches[0]["id"]) if len(matches) == 1 else None
        recorded = _report_recovery_probe(
            server, token, str(request["id"]), outcome, len(matches), job_id
        )
        if not recorded:
            continue
        effective_outcome = recorded.get("outcome", outcome)
        effective_job_id = recorded.get("job_id") if effective_outcome == "unique" else None
        if effective_job_id and _anchor(
            server, token, str(request["id"]), str(effective_job_id), verifying=True
        ):
            anchored += 1
            print(f"  ✓ 모호한 제출 자동 복구: {str(effective_job_id)[:8]}")
        elif effective_outcome in {"unique", "multiple"}:
            print(
                f"  ⚠ 모호한 제출 후보 {recorded.get('candidate_count', len(matches))}개 "
                "— 자동 재실행 보류"
            )
    return anchored


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


def _request_local_pair(server: str, secret: str):
    """test_dev 브라우저 로그인 계정을 로컬 일회성 키로 교환한다."""
    return _http(
        "POST",
        f"{server}/api/agent/local-pair-token",
        body={"secret": secret},
    )


def wait_for_local_pair(server: str, secret: str) -> tuple[str, str]:
    """브라우저 로그인 완료까지 대기한 뒤 (세션 토큰, 이메일)을 반환한다."""
    print("[연결] 브라우저 로그인을 기다립니다. CMD에 이메일/비밀번호를 입력할 필요가 없습니다.")
    while True:
        status, body = _request_local_pair(server, secret)
        if status == 200 and isinstance(body, dict) and body.get("token") and body.get("email"):
            print(f"[연결] 브라우저 계정 자동 연결: {body['email']}")
            return body["token"], body["email"]
        if status in (403, 404):
            sys.exit(f"[오류] 로컬 에이전트 자동 연결 실패(status={status}): {body}")
        time.sleep(1)


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
    """레퍼런스 미부착으로 실패한 잡을 '원래 카드 자동 부착 금지' 목록에 넣는다.

    유료 결과 자체는 다음 push에서 서버 라이브러리에 별도 격리 저장한다. 이 로컬 목록은
    검증 실패를 기억하고 로그로 구분하기 위한 표식이며, 결과 은폐 필터로 사용하지 않는다.
    """
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
    """모호한 생성 실패에 쓰인 오래된 업로드 ID만 제거한다.

    여기서는 CLI 생성을 다시 호출하지 않는다. 사용자가 외부 미제출을 확인하고 기존 요청을
    명시적으로 재큐잉했을 때 다음 시도가 파일을 새로 업로드하게 만들기 위한 정리다.
    """
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
) -> tuple[dict | None, bool]:
    """로컬 레퍼런스 파일을 Higgsfield media_input 으로 업로드하고 (medias[].data, 캐시사용여부) 반환.
    in-flight 잠금: 같은 파일을 여러 스레드가 동시에 올리면 한 스레드만 업로드하고 나머지는 그 결과를
    기다린다(벌크 seedance 제출에서 같은 캐릭터/스토리보드 참조가 겹쳐 중복 업로드되던 것 방지)."""
    key = None
    size = 0
    my_ev = None
    legacy = "_items" not in upload_cache
    if legacy:  # 플랫 dict 캐시 — 실사용 경로 아님(_load_upload_cache 는 항상 _items 생성). 그대로 둔다.
        with upload_lock:
            cached = upload_cache.get(path)
            if cached is not None:
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
                if ev is None:  # 내가 업로드 담당 — 자리표로 대기자에 알림
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


def _fingerprint_params(params: dict, allowed: set) -> dict:
    """CLI에 실제 플래그로 전달되는 스칼라 옵션만 제출 지문에 남긴다."""
    return {
        str(key): value
        for key, value in (params or {}).items()
        if key != "prompt"
        and value not in (None, "")
        and not isinstance(value, (list, dict))
        and (not allowed or key in allowed)
    }


def _probe_role(value, fallback: str = "") -> str:
    raw = str(value or fallback or "").strip().lower()
    raw = raw.replace("simage", "startimage").replace("eimage", "endimage")
    raw = raw.replace("vedio", "video")
    return re.sub(r"[^a-z0-9]", "", raw)


def _submission_fingerprint(model: str, prompt: str, params: dict, allowed: set, refs: list) -> dict:
    """원문 프롬프트를 저장하지 않고 같은 HF 목록 항목을 대조할 안정 지문을 만든다."""
    normalized_prompt = re.sub(r"\s+", " ", prompt.lstrip(_ZWSP)).strip()
    roles = sorted(
        _probe_role(ref.get("role"), ref.get("type") or "image")
        for ref in refs
        if isinstance(ref, dict)
    )
    return {
        "version": 1,
        "model": model,
        "prompt_sha256": hashlib.sha256(normalized_prompt.encode("utf-8")).hexdigest(),
        "params": _fingerprint_params(params, allowed),
        "reference_roles": roles,
    }


def _fail(server: str, token: str, rid: str, reason: str) -> None:
    """요청 실패 보고. reason 에 한글/공백/괄호가 들어가므로 반드시 URL 인코딩한다
    (urllib 은 비-ASCII URL 을 그대로 못 보냄 — 'ascii codec' 오류로 보고 자체가 실패해
    요청이 running 에 영영 멈추는 버그를 막는다)."""
    _http(
        "POST",
        _gen_request_url(server, rid, "fail", {"reason": reason}),
        token=token,
    )


# --- 크래시 세이프 에이전트 상태 저장소 -----------------------------------------
# JSON 한 파일을 여러 서버/에이전트가 덮어쓰던 구조를 서버+계정 스코프 SQLite(WAL)로 바꾼다.
# create 직후 앵커 미전송뿐 아니라 원격 추적 목록도 보존해 재시작 후 같은 job_id를 이어서 확인한다.
_outbox_lock = Lock()


def _agent_state_path() -> str:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return os.path.join(base, "MVHub", "agent_state.db")
    return os.path.join(os.path.expanduser("~"), ".mvhub", "agent_state.db")


def _state_scope(server: str, account_email: str | None) -> tuple[str, str]:
    return server.rstrip("/").lower(), (account_email or "unknown").strip().lower()


def _state_connect() -> sqlite3.Connection:
    path = _agent_state_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=FULL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS anchor_outbox (
          server_key TEXT NOT NULL,
          account_email TEXT NOT NULL,
          rid TEXT NOT NULL,
          job_id TEXT NOT NULL,
          updated_at REAL NOT NULL,
          PRIMARY KEY(server_key, account_email, rid)
        );
        CREATE TABLE IF NOT EXISTS tracked_job (
          server_key TEXT NOT NULL,
          account_email TEXT NOT NULL,
          rid TEXT NOT NULL,
          job_id TEXT NOT NULL,
          expected_image_inputs INTEGER NOT NULL DEFAULT 0,
          provider_status TEXT,
          check_failures INTEGER NOT NULL DEFAULT 0,
          next_check_at REAL NOT NULL,
          deadline_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          PRIMARY KEY(server_key, account_email, job_id)
        );
        """
    )
    return conn


def _agent_instance_id() -> str:
    with _outbox_lock, _state_connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='device_id'").fetchone()
        device_id = row["value"] if row else str(uuid.uuid4())
        if not row:
            conn.execute("INSERT INTO meta(key,value) VALUES('device_id',?)", (device_id,))
    return f"{device_id}:{os.getpid()}"


_ACCOUNT_MUTEX_HANDLE = None


def _acquire_account_mutex(account_email: str) -> bool:
    """같은 Windows 로그인 세션에서 동일 Higgsfield 계정의 생성 에이전트를 하나로 제한한다."""
    global _ACCOUNT_MUTEX_HANDLE
    if _ACCOUNT_MUTEX_HANDLE is not None:
        return True
    if os.name != "nt":
        return True
    import ctypes

    digest = hashlib.sha256(account_email.strip().lower().encode("utf-8")).hexdigest()[:24]
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, f"Local\\MVHub_Higgsfield_{digest}")
    if not handle:
        raise OSError("에이전트 단일 실행 잠금을 만들 수 없습니다")
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return False
    _ACCOUNT_MUTEX_HANDLE = handle
    return True


def _outbox_load(server: str, account_email: str | None) -> list[dict]:
    server_key, account = _state_scope(server, account_email)
    with _outbox_lock, _state_connect() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT rid, job_id FROM anchor_outbox WHERE server_key=? AND account_email=? "
                "ORDER BY updated_at",
                (server_key, account),
            ).fetchall()
        ]


def _outbox_add(server: str, account_email: str | None, rid: str, job_id: str) -> None:
    server_key, account = _state_scope(server, account_email)
    with _outbox_lock:
        with _state_connect() as conn:
            conn.execute(
                "INSERT INTO anchor_outbox(server_key,account_email,rid,job_id,updated_at) "
                "VALUES(?,?,?,?,?) ON CONFLICT(server_key,account_email,rid) DO UPDATE SET "
                "job_id=excluded.job_id, updated_at=excluded.updated_at",
                (server_key, account, rid, job_id, time.time()),
            )


def _outbox_remove(server: str, account_email: str | None, rid: str) -> None:
    server_key, account = _state_scope(server, account_email)
    with _outbox_lock:
        with _state_connect() as conn:
            conn.execute(
                "DELETE FROM anchor_outbox WHERE server_key=? AND account_email=? AND rid=?",
                (server_key, account, rid),
            )


def _tracked_save(server: str, account_email: str | None, tracked: dict) -> None:
    server_key, account = _state_scope(server, account_email)
    now_wall = time.time()
    mono = time.monotonic()
    next_wall = now_wall + max(0.0, tracked.get("next_direct_check", mono) - mono)
    deadline_wall = now_wall + max(1.0, tracked.get("deadline", mono + 3600) - mono)
    with _outbox_lock, _state_connect() as conn:
        conn.execute(
            "INSERT INTO tracked_job(server_key,account_email,rid,job_id,expected_image_inputs,"
            "provider_status,check_failures,next_check_at,deadline_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(server_key,account_email,job_id) DO UPDATE SET "
            "rid=excluded.rid, expected_image_inputs=excluded.expected_image_inputs, "
            "provider_status=excluded.provider_status, check_failures=excluded.check_failures, "
            "next_check_at=excluded.next_check_at, deadline_at=excluded.deadline_at, updated_at=excluded.updated_at",
            (
                server_key,
                account,
                tracked["rid"],
                tracked["job_id"],
                int(tracked.get("expected_image_inputs", 0)),
                tracked.get("provider_status"),
                int(tracked.get("check_failures", 0)),
                next_wall,
                deadline_wall,
                now_wall,
            ),
        )


def _tracked_load(server: str, account_email: str | None) -> dict[str, dict]:
    server_key, account = _state_scope(server, account_email)
    now_wall = time.time()
    mono = time.monotonic()
    with _outbox_lock, _state_connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tracked_job WHERE server_key=? AND account_email=? ORDER BY next_check_at",
            (server_key, account),
        ).fetchall()
    return {
        row["job_id"]: {
            "rid": row["rid"],
            "job_id": row["job_id"],
            "expected_image_inputs": row["expected_image_inputs"],
            "provider_status": row["provider_status"],
            "check_failures": row["check_failures"],
            "next_direct_check": mono + max(0.0, row["next_check_at"] - now_wall),
            "deadline": mono + max(1.0, row["deadline_at"] - now_wall),
        }
        for row in rows
    }


def _tracked_remove(server: str, account_email: str | None, job_id: str) -> None:
    server_key, account = _state_scope(server, account_email)
    with _outbox_lock, _state_connect() as conn:
        conn.execute(
            "DELETE FROM tracked_job WHERE server_key=? AND account_email=? AND job_id=?",
            (server_key, account, job_id),
        )


def _anchor(server: str, token: str, rid: str, job_id: str, verifying: bool = False) -> bool:
    """placeholder 에 job_id 를 박고 running 유지 — create-first(verifying=False)는 '생성중'으로,
    모호한 결말·재시작 복구(verifying=True)는 '확인중'으로 표시.

    True = 서버가 앵커를 반영했거나 재전송이 무의미(요청 종결/소멸) → outbox 에서 제거해도 됨.
    False = 실패 또는 서버가 거부했는데 요청이 아직 살아 있음 → outbox 에 남겨 재전송.
    (예전엔 HTTP 200 만 보고 성공 처리해서, 서버가 조용히 거부한 앵커가 outbox 에서
    지워져 유료 잡이 카드에 영영 안 붙었다.)"""
    st, body = _http(
        "POST",
        _gen_request_url(
            server,
            rid,
            "anchor",
            {"job_id": job_id, "verifying": "true" if verifying else "false"},
        ),
        token=token,
    )
    if st != 200:
        return False
    if not isinstance(body, dict) or "applied" not in body:
        return True  # 구서버(빈 200) 호환 — 기존 동작 유지
    if body.get("applied"):
        return True
    # 서버가 거부 — 요청이 이미 종결/소멸이면 같은 앵커를 다시 보내도 똑같이 거부된다.
    return str(body.get("request_status") or "") in ("done", "canceled", "failed", "missing")


def _anchor_with_retry(
    server: str,
    token: str,
    account_email: str | None,
    rid: str,
    job_id: str,
    attempts: int = 3,
) -> bool:
    """앵커 ACK(200)를 받을 때까지 몇 번 재시도. 성공하면 outbox 에서 제거(서버가 job_id 를 가졌으니
    이후 크래시는 재조정 백스톱이 덮는다). 끝내 실패하면 outbox 에 남겨 다음 사이클/재시작에 재전송."""
    total = max(1, attempts)
    for attempt in range(total):
        if _anchor(server, token, rid, job_id, verifying=False):
            _outbox_remove(server, account_email, rid)
            return True
        if attempt < total - 1:
            _retry_pause(attempt)
    return False


def replay_outbox(server: str, token: str, account_email: str | None) -> None:
    """지난번 크래시/순단으로 서버에 못 닿은 job_id 앵커를 재전송 — 재조정 패스 초에 매번 돈다(idle 포함).
    재시작 복구이므로 '확인중'으로 앵커(verifying=True). 성공분은 outbox 에서 제거."""
    items = _outbox_load(server, account_email)
    if not items:
        return
    print(f"[복구] 미전송 앵커 {len(items)}건 재전송")
    for it in items:
        if not isinstance(it, dict):
            continue
        rid, job_id = it.get("rid"), it.get("job_id")
        if rid and job_id and _anchor(server, token, rid, job_id, verifying=True):
            _outbox_remove(server, account_email, rid)


def _reconcile(server: str, token: str, rid: str, job: dict, force_fail_reason: str | None = None) -> int:
    """create-first 완료 확정 — 목록 조회/get 으로 확보한 최종 job 을 /reconcile 로 권위 보정한다.
    앵커는 gen_request 를 tracking/verifying 으로만 옮기며, 완료는 /reconcile ACK로만 확정한다.
    force_fail_reason 이면 레퍼런스 미부착 등 로컬 검증 실패로 '되살림 금지' failed 확정. 서버 status 반환."""
    st, _ = _report_reconcile(server, token, rid, job, force_fail_reason)
    return st


def _report_reconcile(
    server: str,
    token: str,
    rid: str,
    job: dict,
    force_fail_reason: str | None = None,
):
    query = {"force_fail_reason": force_fail_reason} if force_fail_reason else None
    return _http(
        "POST",
        _gen_request_url(server, rid, "reconcile", query),
        token=token,
        body={"job": job},
    )


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


def _submit_one(
    server: str,
    token: str,
    cli: str,
    account_email: str | None,
    r: dict,
    ref_cache: dict,
    upload_cache: dict,
    upload_lock: Lock,
    workspace_lock: Lock,
    agent_id: str,
) -> dict | None:
    """대기 요청 1건을 내 로컬 CLI 로 제출하고 추적 정보를 반환한다.
    제출 워커에서 호출되므로 정상적인 입력·CLI 실패는 여기서 보고하고 None 을 반환한다.
    레퍼런스는 배치 시작 때 한 번씩만 받아둔 `ref_cache`(값→해석값) 를 조회만 한다(중복 다운로드 방지)."""
    rid, model, prompt = r.get("id"), r.get("model"), r.get("prompt") or ""
    if not model:
        _fail(server, token, rid, "모델 없음")
        return None
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
    allowed_params = _allowed_params(cli, model)
    args += _param_flags(params, allowed_params)
    refs, ref_error = _refs_for_cli(model, r.get("references") or [])
    if ref_error:
        _fail(server, token, rid, ref_error)
        print(f"  ✗ {model}: {ref_error}")
        return None
    # 레퍼런스 — 다운로드 없이 배치 공유 캐시 조회만(해석값=공개 URL 또는 로컬 임시파일경로).
    unresolved: list = []
    upload_failed: list = []
    seedance_media_ids: list = []  # [(role, upload_id)] — 1.x references 플래그용
    seedance_cached_paths: list[str] = []
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
            if from_cache:
                seedance_cached_paths.append(resolved)
            media_role = _media_role(ref)
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
        return None
    if upload_failed:
        _fail(server, token, rid, f"레퍼런스를 업로드할 수 없습니다({len(upload_failed)}개): {upload_failed[0]}")
        print(f"  ✗ 레퍼런스 업로드 실패 — 실행 안 함: {upload_failed[0]}")
        return None
    seedance_ref_args = _seedance_ref_args(seedance_media_ids)
    args += seedance_ref_args
    submission_fingerprint = _submission_fingerprint(
        model, prompt, params, allowed_params, refs
    )
    print(f"  → {model}: {prompt[:40]}")
    # 1) 비대기 제출 → job_id 즉시 확보(create 가 과금원). 응답 실측은 ["<uuid>"] 배열.
    # workspace 선택은 CLI 전역 상태다. 전환·검증부터 generate create 반환까지 한 요청만 진입시켜,
    # 다른 제출 스레드가 중간에 공간을 바꾸는 경합을 막는다. create 반환 뒤 원격 추적은 다시 병렬이다.
    with workspace_lock:
        workspace_ok, workspace_error = _ensure_request_workspace(cli, r.get("workspace"))
        if not workspace_ok:
            reason = f"워크스페이스 확인 실패 — 생성하지 않음: {workspace_error}"
            _fail(server, token, rid, reason)
            print(f"  ✗ {reason}")
            return None
        # 신 서버가 claim_phase=claimed를 보낸 경우에만 2단계 제출 계약을 적용한다. ACK가 없으면
        # generate create를 절대 호출하지 않는다. 구 서버 응답에는 이 필드가 없어 기존 흐름 유지.
        if r.get("claim_phase") == "claimed" and not _begin_submission(
            server, token, rid, agent_id, submission_fingerprint
        ):
            _release_claim(server, token, rid, agent_id)
            print("  ✗ 서버 제출 허가를 확인하지 못해 생성하지 않았습니다")
            return None
        created, cli_error = _run_cli_json(cli, *args, timeout=300)
    job_id = _extract_created_id(created, cli_error)
    if not job_id:
        # generate create를 호출한 뒤에는 exit code·타임아웃만으로 외부 미제출을 증명할 수 없다.
        # 자동 fail/재시도하면 이미 결제된 작업을 한 번 더 만들 수 있으므로 수동 복구 상태로 격리한다.
        reason = "잡 id를 확인하지 못했습니다" if not cli_error else cli_error[:700]
        if cli_error:
            print(f"[경고] {cli_error}")
        if seedance_cached_paths and cli_error and any(
            marker in cli_error.lower()
            for marker in ("media", "reference", "upload", "uuid", "input")
        ):
            for cached_path in seedance_cached_paths:
                _invalidate_upload_cache(upload_cache, cached_path, upload_lock)
            print("  ↻ 다음 명시적 재실행을 위해 실패한 레퍼런스 업로드 캐시를 비웠습니다")
        reported = _require_submission_recovery(server, token, rid)
        suffix = "" if reported else " (서버 보고 실패 — lease 만료 시 자동 격리)"
        print(f"  ⚠ 제출 결과 확인 필요: {reason}{suffix}")
        return None
    # 2) 즉시 앵커(크래시 세이프) — outbox 에 먼저 남기고 서버 ACK 재시도. ACK 실패해도 outbox 가
    #    재조정 패스/재시작 때 재전송하므로 계속 진행한다(잡은 이미 힉스필드에 떠 있음).
    _outbox_add(server, account_email, rid, job_id)
    if not _anchor_with_retry(server, token, account_email, rid, job_id):
        print(f"  ⚠ 앵커 보고 실패 — outbox 보관(재전송 예정): {job_id[:8]}")
    return {
        "rid": rid,
        "job_id": job_id,
        "expected_image_inputs": expected_image_inputs,
        "deadline": time.monotonic() + _ACTIVE_TRACKING_TIMEOUT_SECONDS,
        "next_direct_check": 0.0,
        "provider_status": None,
        "check_failures": 0,
    }


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """환경변수 정수를 안전한 범위로 읽는다(잘못된 값이면 기본값)."""
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


# 로컬 CLI 프로세스 수와 원격 진행 작업 수는 서로 다른 자원이다.
# 제출은 적은 워커로 차례로 밀어 넣고, 제출이 끝난 작업은 단일 조회 루프가 추적한다.
_SUBMIT_WORKERS = _env_int("MVHUB_CLI_SUBMIT_WORKERS", 8, 1, 32)
_MAX_IN_FLIGHT_JOBS = max(
    _SUBMIT_WORKERS,
    _env_int("MVHUB_CLI_MAX_IN_FLIGHT", 64, 1, 256),
)
_JOB_POLL_INTERVAL_SECONDS = 5.0
_DIRECT_CHECK_INTERVAL_SECONDS = 30.0
_DIRECT_CHECK_BATCH_SIZE = _env_int("MVHUB_CLI_TRACK_CHECKS", 8, 1, 32)
_ACTIVE_TRACKING_TIMEOUT_SECONDS = 60 * 60
_SUCCESS_RAW = {"completed", "succeeded", "success", "done"}
_FAILURE_RAW = {
    "failed", "error", "canceled", "cancelled", "nsfw", "nsfw_detected", "rejected"
}
_ACTION_REQUIRED_RAW = {"needs_action", "needs_confirmation", "ip_detected", "user_action_required"}
_ACTIVE_BY_SCOPE: dict[tuple[str, str], dict[str, dict]] = {}
_ACTIVE_BY_SCOPE_LOCK = Lock()


def _provider_status_kind(job: dict) -> str:
    raw = _job_status(job)
    if raw in _PROCESSING_RAW or not raw:
        return "processing"
    if raw in _SUCCESS_RAW:
        return "success"
    if raw in _FAILURE_RAW:
        return "failure"
    if raw in _ACTION_REQUIRED_RAW:
        return "action_required"
    return "unknown"


def _runtime_active(server: str, account_email: str | None) -> dict[str, dict]:
    scope = _state_scope(server, account_email)
    with _ACTIVE_BY_SCOPE_LOCK:
        if scope not in _ACTIVE_BY_SCOPE:
            _ACTIVE_BY_SCOPE[scope] = _tracked_load(server, account_email)
        return _ACTIVE_BY_SCOPE[scope]


def _claim_capacity(submitting_count: int, active_count: int) -> int:
    """로컬 제출 워커와 원격 진행 상한을 모두 넘지 않는 다음 claim 수."""
    local_free = _SUBMIT_WORKERS - submitting_count
    remote_free = _MAX_IN_FLIGHT_JOBS - submitting_count - active_count
    return max(0, min(local_free, remote_free))


def _resolve_refs_for(server: str, token: str, reqs: list, ref_cache: dict | None = None) -> tuple:
    """새로 claim한 요청의 고유 레퍼런스만 받아 공유 캐시에 추가한다.
    반환: (ref_cache={값→해석값}, 이번에 만든 임시파일 리스트)."""
    ref_cache = ref_cache if ref_cache is not None else {}
    ref_temps: list = []
    for val in {
        ref.get("file_path")
        for r in reqs
        for ref in (r.get("references") or [])
        if ref.get("file_path")
    }:
        if val in ref_cache:
            continue
        resolved, tmp = _resolve_ref(server, token, val)
        ref_cache[val] = resolved
        if tmp:
            ref_temps.append(tmp)
    return ref_cache, ref_temps


def _finalize_tracked_job(
    server: str,
    token: str,
    cli: str,
    tracked: dict,
    job: dict,
    *,
    detailed: bool,
) -> bool:
    """종료된 작업을 검증하고 서버에 확정한다. 재확인이 필요하면 False."""
    rid = tracked["rid"]
    job_id = tracked["job_id"]
    expected_image_inputs = tracked.get("expected_image_inputs", 0)

    # 목록 응답은 축약될 수 있다. 입력 이미지 검증이 필요한 작업만 상세 정보를 한 번 더 받는다.
    if expected_image_inputs > 0 and not detailed:
        full, _ = _run_cli_json(cli, "generate", "get", job_id, timeout=120)
        if not (isinstance(full, dict) and full.get("id")):
            return False
        job = full
        detailed = True
    if not (isinstance(job, dict) and job.get("id")):
        return False
    kind = _provider_status_kind(job)
    if kind not in ("success", "failure"):
        return False

    observed_image_inputs = _job_image_input_count(job)
    if expected_image_inputs > 0 and observed_image_inputs is not None and observed_image_inputs <= 0:
        # 상세 응답까지 확인했는데도 입력 이미지가 없으면 잘못 생성된 결과를 카드로 만들지 않는다.
        if not detailed:
            return False
        _suppress_job(job_id)
        reason = "레퍼런스가 적용되지 않았습니다(생성물에 입력 이미지 미부착) — 다시 시도하세요"
        ok = False
        for attempt in range(3):
            status, body = _report_reconcile(server, token, rid, job, force_fail_reason=reason)
            if status == 200 and isinstance(body, dict) and body.get("outcome") in {
                "applied", "already_final_same_job"
            }:
                ok = True
                break
            if attempt < 2:
                _retry_pause(attempt)
        print(
            f"  ✗ 레퍼런스 미부착 — 실패 확정(되살림 금지): {job_id[:8]}"
            if ok else f"  ⚠ 레퍼런스 미부착 실패 보고 안착 실패(다음 사이클 재시도): {job_id[:8]}"
        )
        return ok

    # 성공은 실제 결과 URL과 서버 저장 ACK가 모두 있어야 완료다. 공급자 CDN 지연이면 확인중 유지한다.
    result_url = job.get("result_url")
    usable_result = bool(
        isinstance(result_url, str) and result_url.startswith(("https://", "http://"))
    )
    report_job = job
    if kind == "success" and not usable_result:
        print(f"  ⏳ 완료 상태지만 결과 URL 대기: {job_id[:8]}")
        # 공급자가 completed를 먼저 주고 CDN URL을 나중에 붙이는 경우가 있다. 서버가 빈 완료를
        # 확정하지 못하도록 결과 URL 필드를 명시적으로 비운 사본만 보고한다.
        report_job = dict(job)
        report_job["result_url"] = None
        report_job["min_result_url"] = None
        report_job["thumbnail_url"] = None
    status, body = _report_reconcile(server, token, rid, report_job)
    outcome = body.get("outcome") if isinstance(body, dict) else None
    asset_saved = bool(body.get("asset_saved")) if isinstance(body, dict) else False
    finalized = bool(
        status == 200
        and outcome in {"applied", "already_final_same_job"}
        and (kind == "failure" or asset_saved)
    )
    if finalized:
        print(f"  ✓ 확정 보고({outcome}): {job_id[:8]}")
    else:
        print(f"  ⏳ 확정 보류(status={status}, outcome={outcome or '응답 없음'}): {job_id[:8]}")
    return finalized


def _poll_active_jobs(
    server: str,
    token: str,
    cli: str,
    active: dict,
    account_email: str | None = None,
) -> int:
    """기한이 된 추적 작업을 generate get으로 직접 권위 확인한다.

    한 번에 제한된 수만 확인하되 next_direct_check 순서로 골라 64개에서도 기아가 없게 한다.
    """
    if not active:
        return 0
    now = time.monotonic()
    finished: list[str] = []
    due: list[tuple[str, dict]] = []

    for job_id, tracked in sorted(
        list(active.items()), key=lambda item: item[1].get("next_direct_check", 0.0)
    ):
        if now >= tracked["deadline"]:
            # 오래 걸렸다는 이유로 추적을 버리거나 재생성하지 않는다. 확인 간격만 늘려 계속 보존한다.
            tracked["deadline"] = now + _ACTIVE_TRACKING_TIMEOUT_SECONDS
            tracked["next_direct_check"] = min(tracked.get("next_direct_check", now), now)
            print(f"  ⏳ 장시간 처리중 — 유료 작업 보존·계속 확인: {job_id[:8]}")

        # 목록 응답은 실제 상태보다 늦을 수 있어 완료 판정에는 쓰지 않는다. 예약 시각 순서로 직접
        # 조회해 앞의 작업이 매번 재선점하는 현상 없이 64개 모두 공평하게 확인한다.
        if now < tracked.get("next_direct_check", 0.0):
            continue
        due.append((job_id, tracked))
        if len(due) >= _DIRECT_CHECK_BATCH_SIZE:
            break

    for job_id, tracked in due:
        full, cli_error = _run_cli_json(cli, "generate", "get", job_id, timeout=120)
        if not (isinstance(full, dict) and full.get("id")):
            tracked["check_failures"] = int(tracked.get("check_failures", 0)) + 1
            delay = min(120.0, _DIRECT_CHECK_INTERVAL_SECONDS * (2 ** min(2, tracked["check_failures"] - 1)))
            tracked["next_direct_check"] = time.monotonic() + delay
            if account_email is not None:
                _tracked_save(server, account_email, tracked)
            if cli_error:
                print(f"  ⚠ 상태 조회 실패({job_id[:8]}) — {int(delay)}초 뒤 재시도")
            continue
        if str(full.get("id")) != job_id:
            tracked["next_direct_check"] = time.monotonic() + 60.0
            if account_email is not None:
                _tracked_save(server, account_email, tracked)
            print(f"  ⚠ 작업 ID 불일치 — 적용하지 않음: {job_id[:8]}")
            continue
        tracked["provider_status"] = _job_status(full)
        tracked["check_failures"] = 0
        kind = _provider_status_kind(full)
        if kind in {"processing", "unknown", "action_required"}:
            # 서버에도 원시 상태·마지막 확인 시각을 기록해 UI에서 확인 가능하게 한다.
            _report_reconcile(server, token, tracked["rid"], full)
            tracked["next_direct_check"] = time.monotonic() + _DIRECT_CHECK_INTERVAL_SECONDS
            if account_email is not None:
                _tracked_save(server, account_email, tracked)
            continue
        if _finalize_tracked_job(server, token, cli, tracked, full, detailed=True):
            finished.append(job_id)
        else:
            tracked["next_direct_check"] = time.monotonic() + (
                15.0 if kind == "success" else _DIRECT_CHECK_INTERVAL_SECONDS
            )
            if account_email is not None:
                _tracked_save(server, account_email, tracked)

    for job_id in finished:
        active.pop(job_id, None)
        if account_email is not None:
            _tracked_remove(server, account_email, job_id)
    return len(finished)


def execute_pending(server: str, token: str, cli: str) -> int:
    """제출 워커와 원격 진행 작업 추적을 분리해 대기 요청을 처리한다.
    실행은 유료(내 크레딧). 반환: 이번에 claim한 요청 수."""
    submitting: dict = {}
    account_email = _cli_account_email(cli)
    agent_id = _agent_instance_id()
    active = _runtime_active(server, account_email)
    ref_cache: dict = {}
    ref_temps_all: list = []
    upload_cache: dict = _load_upload_cache(account_email)
    upload_lock = Lock()
    workspace_lock = Lock()
    total = 0
    printed = False
    next_claim_at = 0.0
    next_poll_at = 0.0
    try:
        with ThreadPoolExecutor(max_workers=_SUBMIT_WORKERS) as executor:
            while True:
                # 완료된 제출만 회수한다. 생성 대기는 워커가 아니라 active 목록으로 이동한다.
                for future, request in list(submitting.items()):
                    if not future.done():
                        continue
                    submitting.pop(future, None)
                    try:
                        tracked = future.result()
                    except Exception as exc:  # noqa: BLE001
                        rid = request.get("id")
                        _fail(server, token, rid, f"제출 처리 예외: {exc}")
                        print(f"  ✗ 제출 처리 예외: {exc}")
                        continue
                    if tracked:
                        active[tracked["job_id"]] = tracked
                        _tracked_save(server, account_email, tracked)

                now = time.monotonic()
                if active and now >= next_poll_at:
                    _poll_active_jobs(server, token, cli, active, account_email)
                    next_poll_at = time.monotonic() + _JOB_POLL_INTERVAL_SECONDS

                claimed: list = []
                claim_limit = _claim_capacity(len(submitting), len(active))
                now = time.monotonic()
                if claim_limit > 0 and now >= next_claim_at:
                    _, pending = _claim_pending(server, token, claim_limit, agent_id)
                    claimed = pending if isinstance(pending, list) else []
                    next_claim_at = now if len(claimed) >= claim_limit else now + 3.0

                if claimed:
                    if not printed:
                        print("[실행] 대기 요청 처리")
                        printed = True
                    ref_cache, ref_temps = _resolve_refs_for(server, token, claimed, ref_cache)
                    ref_temps_all.extend(ref_temps)
                    batch_ref_cache = dict(ref_cache)
                    for model in {r.get("model") for r in claimed if r.get("model")}:
                        _allowed_params(cli, model)
                    for request in claimed:
                        future = executor.submit(
                            _submit_one,
                            server,
                            token,
                            cli,
                            account_email,
                            request,
                            batch_ref_cache,
                            upload_cache,
                            upload_lock,
                            workspace_lock,
                            agent_id,
                        )
                        submitting[future] = request
                        total += 1
                    continue

                # 원격 생성 대기는 지속 추적 저장소가 맡는다. 제출 함수가 완료까지 막고 있지 않는다.
                if not submitting:
                    break

                # 제출 완료·다음 목록 조회·다음 claim 중 가장 가까운 시점까지만 쉰다.
                now = time.monotonic()
                wake_times = []
                if claim_limit > 0:
                    wake_times.append(next_claim_at)
                if active:
                    wake_times.append(next_poll_at)
                timeout = 3.0 if not wake_times else max(0.05, min(3.0, min(wake_times) - now))
                if submitting:
                    futures_wait(tuple(submitting), timeout=timeout, return_when=FIRST_COMPLETED)
                else:
                    time.sleep(timeout)
    finally:
        _cleanup(ref_temps_all)  # 공유 임시파일은 추적 종료 뒤 한 번에 삭제
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


def _job_ids_to_sync(server: str, token: str, local_ids: list[str]) -> "set[str] | None":
    """서버에 없거나 서버에서 아직 진행중인 로컬 job id만 고른다.

    신버전 서버의 ``refresh`` 를 합치고, 구버전 서버(POST 라우트 없음 404/405)만 GET 전량
    계약으로 폴백한다. 반환 ``None`` = 판별 실패(네트워크·5xx·malformed) — 빈 차집합과
    구분되는 명시적 '이번 사이클 보류' 신호다. ★종전엔 어떤 실패든 GET 폴백으로 확대되고,
    GET 까지 실패하면 known=빈 것으로 오인해 전량을 다시 보냈다(서버 멱등이라 무해하지만
    장애 때 전량 재전송 낭비 + 서버 전체 목록 응답 강요)."""
    if not local_ids:
        return set()  # 보낼 후보 자체가 없음 — 서버 전량 목록을 받을 이유가 없다
    status, diff = _http(
        "POST", f"{server}/api/ingest/known-jobs", token=token, body={"job_ids": local_ids}
    )
    if status == 200 and isinstance(diff, dict) and isinstance(diff.get("unknown"), list):
        selected = {str(job_id) for job_id in diff["unknown"] if job_id}
        refresh = diff.get("refresh")
        if isinstance(refresh, list):
            selected.update(str(job_id) for job_id in refresh if job_id)
        return selected
    if status not in (404, 405):
        return None  # 일시 장애·malformed 200 — 판별 보류(다음 사이클 재시도)
    status, known = _http("GET", f"{server}/api/ingest/known-jobs", token=token)
    if status != 200 or not isinstance(known, dict) or not isinstance(known.get("job_ids"), list):
        return None  # 구서버 GET 도 실패 — 전량 재전송 대신 보류
    known_ids = {str(job_id) for job_id in known["job_ids"]}
    return {job_id for job_id in local_ids if job_id not in known_ids}


def push_once(server: str, token: str, cli: str, size: int, _allow_relogin: bool = True, reinspect: bool = False) -> None:
    # 1) 로컬 생성물(내 CLI·내 계정) + 크레딧·워크스페이스 상태
    jobs = _cli_json(cli, "generate", "list", "--size", str(size)) or []
    if not isinstance(jobs, list):
        jobs = []

    # 2) 서버에 없는 잡 판별 — 내 로컬 목록(≤size)을 보내 차집합만 받는다(POST).
    # GET(서버 보유 전량 응답)은 라이브러리가 수천 건으로 커지면 매 사이클 왕복이 무거워진다.
    # 구버전 서버(POST 미지원 404/405)면 기존 GET 전량 방식으로 폴백.
    # ★reinspect(재점검): 차집합을 건너뛰고 최신 전량을 다시 보낸다 → 서버 upsert 가 힉스필드 상태와
    #   로컬을 재대조해 어긋난 것(로컬만 실패 등)을 정정. (fresh_ids=None → 아래서 전량 채택)
    local_ids = [j["id"] for j in jobs if isinstance(j, dict) and j.get("id")]
    fresh_ids: set[str] | None = None  # None=전량 채택(reinspect 전용)
    if not reinspect:
        fresh_ids = _job_ids_to_sync(server, token, local_ids)
        if fresh_ids is None:
            # 판별 실패(빈 차집합과 다름) — 전량 재전송 대신 이번 사이클을 건너뛴다.
            print("[보류] 서버 known-jobs 판별 실패 — 이번 push 사이클을 건너뜁니다(다음 사이클 재시도).")
            return
    # account status(크레딧·플랜) + workspace list(내 워크스페이스)를 함께 보고 → 서버가 계정 메뉴에
    # '내 것'으로 표시(브라우저는 내 CLI에 직접 접근 못 하므로 이 보고값이 유일한 내 데이터).
    acct, workspace = _collect_account_status(cli)

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

    # 3) 새 것만 추림(서버에 없거나 격리 라이브러리 행이 아직 없는 job_id).
    # suppression은 이제 결과 은폐가 아니라 원래 카드 자동 부착 금지 표식이다. 서버가 실패
    # placeholder와 별도 synced 행으로 저장하므로, suppressed 잡도 정상 적재 대상으로 보낸다.
    suppressed = _load_suppressed()
    fresh = [
        j
        for j in jobs
        if isinstance(j, dict) and j.get("id") and (reinspect or j["id"] in fresh_ids)
    ]
    n_suppressed = sum(
        1 for j in jobs
        if isinstance(j, dict) and j.get("id") in suppressed and (reinspect or j.get("id") in (fresh_ids or set()))
    )
    # 내 힉스필드 uid = 내 전체 목록의 최다 user_<id>(= 내 본인 것). fresh 만 보면 남의 레퍼런스에
    # 오염될 수 있으므로 반드시 '전체 목록' 기준으로 산출해 명시 전송 → 서버가 올바르게 연결.
    my_uid = _dominant_uid(jobs)
    skip_note = f" · 원카드 부착 금지 {n_suppressed}개(라이브러리 적재)" if n_suppressed else ""
    mode_note = "재점검(전량 재전송)" if reinspect else "새 잡"
    print(f"[로컬] 잡 {len(jobs)}개 중 {mode_note} {len(fresh)}개{skip_note} · 내 uid={my_uid}")
    if not fresh and not acct:
        print("[완료] 올릴 새 결과물이 없습니다.")
        return

    # 4) 서버로 push (메타데이터만 — 미디어는 공개 URL 그대로, 토큰 안 보냄)
    status, body = _http(
        "POST", f"{server}/api/ingest", token=token,
        body={"jobs": fresh, "creator_uid": my_uid, "workspace": workspace, "account_status": acct,
              "account_transactions": txns, "list_fetched": len(jobs)},
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
            return push_once(server, token, cli, size, _allow_relogin=False, reinspect=reinspect)
        print("       올바른 계정으로 허브에 로그인하면 자동으로 다시 시도합니다.")
        return
    print(
        f"[완료] 신규 {body.get('inserted')} · 갱신 {body.get('updated')} · "
        f"변동없음 {body.get('unchanged')} · 건너뜀 {body.get('skipped')} · "
        f"연결 uid={body.get('linked_uid')}"
    )
    if body.get("errors"):
        print(f"[경고] 서버 반영 실패 {body['errors']}건 — 서버 로그 확인 필요(다음 push 에서 재시도됨)")


def reconcile_pass(
    server: str,
    token: str,
    cli: str,
    account_email: str | None = None,
    skip_job_ids: set[str] | None = None,
) -> None:
    """서버가 준 '확인중/유실된 running'(job_id 보유) 로컬 카드를, 내 CLI 계정으로 generate get 해
    실제 상태로 보정 push 한다 — 우리 앱은 '실패/생성중'인데 힉스필드엔 실제로 완료된 카드를 자동 교정.
    조회(get)만 → 재생성·과금 없음. 실패는 조용히 넘겨 다음 사이클에 재시도(루프 유지)."""
    # 지난번 크래시/순단으로 서버에 못 닿은 job_id 앵커를 먼저 재전송 — 앵커돼야 아래 후보에 잡힌다.
    account_email = account_email or _cli_account_email(cli)
    replay_outbox(server, token, account_email)
    st, data = _list_reconcile_candidates(server, token)
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
        if skip_job_ids and job_id in skip_job_ids:
            continue
        job = _cli_json(cli, "generate", "get", job_id, timeout=120)
        # 조회 불가/내 계정 잡 아님(not found)·파싱실패 → 안 건드림(상태 유지, 다음 사이클 재시도).
        if not (isinstance(job, dict) and job.get("id")):
            continue
        st2, body = _report_reconcile(server, token, rid, job)
        if st2 == 200 and isinstance(body, dict) and body.get("applied"):
            print(f"  ✓ 보정: {job_id[:8]} → {body.get('status')}")


def tracking_pass(server: str, token: str, cli: str) -> int:
    """메모리/SQLite 추적 작업을 먼저 확인하고, 나머지 서버 복구 후보를 뒤이어 보정한다."""
    account_email = _cli_account_email(cli)
    active = _runtime_active(server, account_email)
    finished = _poll_active_jobs(server, token, cli, active, account_email) if active else 0
    # job_id를 잃은 제출은 create를 다시 부르지 않고 최신 list 지문 대조만 수행한다.
    recovery_probe_pass(server, token, cli)
    reconcile_pass(server, token, cli, account_email, skip_job_ids=set(active))
    return finished


def _execute_pending_for_watch_cycle(
    server: str,
    token: str,
    cli: str,
    reasons: set[str],
) -> None:
    if "gen-request" in reasons:
        print("[이벤트] 허브 생성/재생성 요청 — 내 CLI로 실행")
        execute_pending(server, token, cli)
        return
    if not reasons and _pending_exists(server, token):
        # 깨움 신호는 지연 단축용일 뿐이다. 프로세스 재시작으로 신호가 사라져도 매 idle마다
        # DB의 pending을 다시 확인해 정확성 책임을 영속 큐에 둔다.
        print("[idle] 대기 요청 재확인 — 내 CLI로 실행")
        execute_pending(server, token, cli)


def _collect_account_status(cli: str):
    """CLI 계정 상태 + 워크스페이스 목록 수집 — (acct dict|None, workspace 컨텍스트) 반환.

    CLI 실패(비-list)면 workspaces 키 자체를 넣지 않는다 — 빈 배열 []는 서버의
    "불완전 보고 보존" 가드를 통과해 그 계정 멤버십 전체를 unavailable 로 밀어버린다.
    push_once(전체 push)와 주기 상태 재보고가 같은 규칙을 쓰도록 공용화."""
    acct = _cli_json(cli, "account", "status", timeout=60)
    workspace = {"scope": "unknown", "id": None, "name": None}
    if isinstance(acct, dict):
        ws = _cli_json(cli, "workspace", "list", timeout=60)
        if isinstance(ws, list):
            acct["workspaces"] = ws
        workspace = _workspace_context_from_list(ws)
        acct["cli_version"] = _cached_cli_version(cli)  # 팀 CLI 버전 현황(버전 skew 진단)
    return acct, workspace


# 상주(watch) 중 계정 상태 재보고 주기 — 힉스필드 쪽 워크스페이스 멤버 추가/제거가 이벤트 없이도
# 이 주기 안에 허브에 반영된다(서버가 이 보고로 멤버 명단·프로젝트 자동 편입을 갱신).
# push 와 독립 일정으로 돈다(push 실패를 성공으로 오인해 보고가 밀리는 결합 제거). 실패는 짧게 재시도.
_STATUS_REPORT_INTERVAL_SECONDS = 600.0
_STATUS_REPORT_RETRY_SECONDS = 60.0


def _report_account_status(server: str, token: str, cli: str) -> bool:
    """경량 상태 보고 — 생성물 없이 account_status 만 서버에 올린다(jobs=[]).
    generate list·transactions 를 생략해 CLI 왕복 2회로 끝난다. 어떤 실패도 삼키고 False
    (호출자가 짧은 백오프로 재시도) — 상주 루프를 죽이지 않는다."""
    try:
        acct, _workspace = _collect_account_status(cli)
        if not isinstance(acct, dict):
            return False
        status, body = _http(
            "POST", f"{server}/api/ingest", token=token,
            body={"jobs": [], "account_status": acct},
        )
    except Exception as e:  # noqa: BLE001 — 주기 보고 실패가 이벤트 루프를 멈추면 안 된다
        print(f"[상태보고] 실패(재시도 예정): {e}")
        return False
    if status != 200:
        detail = body.get("detail") if isinstance(body, dict) else body
        print(f"[상태보고] 보류(status={status}): {str(detail)[:200]}")
        return False
    return True


def _initial_cycle(server: str, token: str, cli: str, size: int, no_push: bool) -> None:
    """에이전트 시작 시 요청 복구와 최신 상태 재대조를 한 번 수행한다."""
    # ① 허브에서 요청한 생성/재생성을 내 로컬 CLI로 실행 → 결과 보고(연속 풀로 자체 소진)
    execute_pending(server, token, cli)
    # ② '실제 상태 미확정'(확인중/유실된 running) 카드를 generate get 으로 보정 — 조회만(과금 없음).
    #    no_push 모드(생성 전용)여도 실행한다: 내가 실행한 요청의 진실을 맞추는 것이라 push 정책과 무관.
    tracking_pass(server, token, cli)
    # ③ 서버에 없거나 아직 대기/생성중인 최신 항목만 동기화한다. 이미 알려진 synced 카드가 test DB
    #    복사·에이전트 재시작 사이에 완료돼도 서버의 refresh 차집합으로 다시 받아 상태를 바로잡는다.
    #    완료된 과거 항목은 제외하므로 현재 워크스페이스 정보가 옛 카드에 잘못 붙지 않는다.
    #    로컬 허브(--no-push)는 기존대로 건너뛴다(공유는 '선택 발행'으로만).
    if not no_push:
        push_once(server, token, cli, size)


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
    ap.add_argument(
        "--pair-secret",
        help="test_dev 전용: 브라우저 로그인 세션을 로컬 일회성 키로 자동 연결",
    )
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
    paired_email: str | None = None
    env_token = os.environ.pop("MVHUB_SESSION_TOKEN", None)
    if args.pair_secret:
        token, paired_email = wait_for_local_pair(server, args.pair_secret)
    elif args.token or env_token:
        # 자동화/안전한 재시작은 환경변수를 사용해 세션 토큰이 프로세스 명령줄에 노출되지 않게 한다.
        token = args.token or env_token
        print(f"[토큰] 전달된 세션 토큰 사용({args.email or '로컬'})")
    else:
        if not args.email:
            sys.exit("[오류] --email 또는 --token 중 하나는 필요합니다.")
        password = args.password or _masked_password_input(f"{args.email} 허브 비밀번호: ")
        token = login(server, args.email, password)
        creds = {"email": args.email, "password": password}

    cli_email = _cli_account_email(cli)
    if not cli_email:
        sys.exit("[오류] Higgsfield CLI 로그인 계정을 확인할 수 없습니다. `hf auth login` 후 다시 실행하세요.")
    if not _acquire_account_mutex(cli_email):
        sys.exit(
            f"[오류] {cli_email} 계정의 생성 에이전트가 이미 실행 중입니다. "
            "기존 에이전트 창 하나만 사용하세요."
        )

    if args.watch:
        # 이벤트 방식 — 평소엔 롱폴로 조용히 대기, 내가 허브에서 생성/재생성·동기화 할 때만 작동.
        print("[이벤트] 대기 모드 — 생성/재생성·동기화 때만 작동 (Ctrl+C 종료)")
        try:
            _initial_cycle(server, token, cli, args.size, args.no_push)
        except Exception as e:  # noqa: BLE001
            print(f"[경고] 초기 처리 오류(무시): {e}")
        next_status_report = time.monotonic() + _STATUS_REPORT_INTERVAL_SECONDS
        while True:
            reason = _wait_event(server, token)  # 이벤트 올 때까지 대기(폴링 없음)
            if args.pair_secret:
                pair_status, pair_body = _request_local_pair(server, args.pair_secret)
                if pair_status == 200 and isinstance(pair_body, dict):
                    next_email = pair_body.get("email")
                    next_token = pair_body.get("token")
                    if next_email and next_token:
                        account_changed = next_email != paired_email
                        token, paired_email = next_token, next_email
                        if account_changed:
                            print(f"[연결] 브라우저 계정 전환: {paired_email}")
                            try:
                                _initial_cycle(server, token, cli, args.size, args.no_push)
                            except Exception as e:  # noqa: BLE001 — 계정 전환 1회 오류로 상주 종료 금지
                                print(f"[경고] 계정 전환 후 초기 처리 오류(무시): {e}")
                            continue
                elif pair_status == 409:
                    print("[연결] 브라우저 로그아웃 감지 — 다음 로그인을 기다립니다.")
                    token, paired_email = wait_for_local_pair(server, args.pair_secret)
                    try:
                        _initial_cycle(server, token, cli, args.size, args.no_push)
                    except Exception as e:  # noqa: BLE001 — 재로그인 1회 오류로 상주 종료 금지
                        print(f"[경고] 재연결 후 초기 처리 오류(무시): {e}")
                    continue
                elif pair_status in (403, 404):
                    sys.exit(
                        f"[오류] 로컬 에이전트 자동 연결 실패(status={pair_status}): {pair_body}"
                    )
            if reason == "__reauth__":
                # 세션 만료 → 자동 재로그인(자격이 메모리에 있을 때만). 실패하면 login 이 종료한다
                # (비밀번호 변경/계정 정지 등 — 무한 재시도 루프 방지).
                if args.pair_secret:
                    token, paired_email = wait_for_local_pair(server, args.pair_secret)
                    continue
                if not creds:
                    sys.exit("[오류] 세션 만료/인증 실패 — 에이전트를 다시 실행하세요.")
                print("[세션] 만료 감지 — 자동 재로그인")
                token = login(server, creds["email"], creds["password"])
                continue
            # 사유가 콤마로 합쳐 올 수 있다(gen-request 와 sync 가 함께 쌓인 경우) → 멤버십으로 검사.
            reasons = set((reason or "").split(",")) if reason else set()
            try:
                _execute_pending_for_watch_cycle(server, token, cli, reasons)
                # 매 사이클(이벤트·idle 타임아웃 모두) '실제 상태 미확정' 카드를 보정 — 확인중 카드를
                #  다음 idle(≈35초) 안에 실제 done/failed 로 확정. reason None/idle 이어도 조용히 돈다.
                #  ★push_once 보다 먼저 — 갓 생성한 카드의 PM 완료시각이 ingest 의 done 처리보다 앞서 기록되게.
                tracking_pass(server, token, cli)
                # gen-request·sync·reinspect 어느 쪽이든 결과를 서버로 올린다(no_push 모드 제외).
                if reasons & {"gen-request", "sync", "reinspect"}:
                    if args.no_push:
                        if reasons & {"sync", "reinspect"} and "gen-request" not in reasons:
                            print("[이벤트] 동기화/재점검 요청 — 생성 전용 모드라 건너뜀(공유는 '선택 발행')")
                    else:
                        reinspect = "reinspect" in reasons
                        if reinspect:
                            print("[이벤트] 생성물 재점검 요청 — 최신 전량을 재전송(상태 정정)")
                        elif "sync" in reasons and "gen-request" not in reasons:
                            print("[이벤트] 내 작업 올리기 요청")
                        push_once(server, token, cli, args.size, reinspect=reinspect)
                # 힉스필드 쪽 워크스페이스 멤버 추가/제거를 상주 중에도 반영 — 이벤트가 없으면 계정
                # 상태가 시작 시점에 박제되므로 주기마다 가볍게 재보고한다(생성물 아님, 메타만).
                # push 와 무관한 독립 일정(성공=600s, 실패=60s 재시도). no_push(생성 전용)는 기존
                # 계약대로 서버에 아무것도 올리지 않는다.
                if not args.no_push and time.monotonic() >= next_status_report:
                    ok = _report_account_status(server, token, cli)
                    next_status_report = time.monotonic() + (
                        _STATUS_REPORT_INTERVAL_SECONDS if ok else _STATUS_REPORT_RETRY_SECONDS
                    )
            except SystemExit:
                raise
            except Exception as e:  # noqa: BLE001 — 한 번 실패해도 루프 유지
                print(f"[경고] 처리 중 오류(무시하고 계속): {e}")
    else:
        _initial_cycle(server, token, cli, args.size, args.no_push)


if __name__ == "__main__":
    main()
