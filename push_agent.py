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
  python push_agent.py --server http://192.168.0.10:8010 --email oz1@millionvolt.com
  python push_agent.py --server http://192.168.0.10:8010 --email oz1@millionvolt.com --watch 60
"""

from __future__ import annotations

import argparse
import getpass
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
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as futures_wait
from urllib.parse import quote, urlencode


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


def _cli_json(cli: str, *args: str, timeout: int = 120):
    """higgsfield CLI 를 --json 으로 실행하고 파싱 결과 반환(실패 시 None)."""
    try:
        out = subprocess.run(
            [cli, *args, "--json"],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        print(f"[경고] CLI 타임아웃: {' '.join(args)}")
        return None
    if out.returncode != 0:
        print(f"[경고] CLI 실패({' '.join(args)}): {out.stderr.strip()[:200]}")
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        print(f"[경고] CLI JSON 파싱 실패: {' '.join(args)}")
        return None


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
    except urllib.error.URLError as e:
        sys.exit(f"[오류] 서버 연결 실패({url}): {e}")


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
            sys.exit("[오류] 세션 만료/인증 실패 — 에이전트를 다시 실행하세요.")
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
        out += [f"--{k}", str(v)]
    return out


def _fail(server: str, token: str, rid: str, reason: str) -> None:
    """요청 실패 보고. reason 에 한글/공백/괄호가 들어가므로 반드시 URL 인코딩한다
    (urllib 은 비-ASCII URL 을 그대로 못 보냄 — 'ascii codec' 오류로 보고 자체가 실패해
    요청이 running 에 영영 멈추는 버그를 막는다)."""
    _http("POST", f"{server}/api/gen-requests/{rid}/fail?reason={quote(reason)}", token=token)


def _download_ref(server: str, token: str, url: str, suffix: str, timeout: int = 180):
    """레퍼런스 파일을 허브 인증으로 받아 임시파일로 저장 → 경로 반환(실패 시 None).
    asset:/상대경로 레퍼런스는 허브 로그인이 필요해 CLI 가 직접 못 받는다 → 에이전트가 받아
    로컬 파일로 CLI 에 넘긴다(higgsfield 가 로컬 파일을 자동 업로드)."""
    req = urllib.request.Request(url, method="GET")
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
    · http(s) 공개 URL → 그대로(CLI 가 직접 받음). cmd 메타문자(|) 없음.
    · asset:{project}|{path} → 허브 인증으로 받아 로컬 임시파일(토큰의 | 가 cmd 를 깨뜨리던 문제 해소).
    · /상대경로(/api/...,/media/...) → 서버 기준 인증 다운로드 → 로컬 임시파일.
    · 그 외(해석 불가) → (None, None) → 호출측이 잘못 생성 대신 명확히 실패시킨다."""
    if not val:
        return None, None
    low = val.lower()
    if low.startswith(("http://", "https://")):
        return val, None
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


def _execute_one(server: str, token: str, cli: str, r: dict, ref_cache: dict) -> None:
    """대기 요청 1건을 내 로컬 CLI 로 실행 → fulfill/fail. 스레드에서 호출되므로 예외를
    바깥으로 던지지 않는다(한 건 실패가 다른 건 실행을 막지 않게).
    레퍼런스는 배치 시작 때 한 번씩만 받아둔 `ref_cache`(값→해석값) 를 조회만 한다(중복 다운로드 방지)."""
    rid, model, prompt = r.get("id"), r.get("model"), r.get("prompt") or ""
    if not model:
        _fail(server, token, rid, "모델 없음")
        return
    args = ["generate", "create", model, "--prompt", prompt, "--wait"]
    args += _param_flags(r.get("params") or {}, _allowed_params(cli, model))
    # 레퍼런스 — 다운로드 없이 배치 공유 캐시 조회만(해석값=공개 URL 또는 로컬 임시파일경로).
    unresolved: list = []
    for ref in r.get("references") or []:
        val = ref.get("file_path")
        if not val:
            continue
        resolved = ref_cache.get(val)
        if not resolved:
            unresolved.append(val)
            continue
        args += [_role_flag(ref.get("role")), resolved]
    if unresolved:
        # 레퍼런스를 못 가져오면 그대로 생성 시 입력 이미지 없이 엉뚱하게 나오고 크레딧만
        # 소모된다 → 실행하지 않고 명확한 사유로 실패시킨다.
        _fail(server, token, rid, f"레퍼런스를 가져올 수 없습니다({len(unresolved)}개): {unresolved[0]}")
        print(f"  ✗ 레퍼런스 해석 불가 — 실행 안 함: {unresolved[0]}")
        return
    print(f"  → {model}: {prompt[:40]}")
    job = _cli_json(cli, *args, timeout=900)
    if not job:
        _fail(server, token, rid, "로컬 CLI 실행 실패")
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
                    in_flight.add(ex.submit(_execute_one, server, token, cli, r, ref_cache))
                    total += 1
                continue  # 곧장 남은 슬롯도 채우러
            if not in_flight:
                break  # claim할 것도, 실행 중인 것도 없음 → 종료
            # 슬롯이 다 찼거나 새 요청 없음 → 하나라도 끝나면(또는 1s마다) 다시 채우러
            _, in_flight = futures_wait(in_flight, timeout=1.0, return_when=FIRST_COMPLETED)
    _cleanup(ref_temps_all)  # 공유 임시파일은 전부 끝난 뒤 한 번에 삭제
    return total


def push_once(server: str, token: str, cli: str, size: int) -> None:
    # 1) 서버가 이미 가진 내 job_id
    status, known = _http("GET", f"{server}/api/ingest/known-jobs", token=token)
    known_ids = set(known.get("job_ids") or []) if isinstance(known, dict) else set()

    # 2) 로컬 생성물(내 CLI·내 계정) + 크레딧·워크스페이스 상태
    jobs = _cli_json(cli, "generate", "list", "--size", str(size)) or []
    if not isinstance(jobs, list):
        jobs = []
    # account status(크레딧·플랜) + workspace list(내 워크스페이스)를 함께 보고 → 서버가 계정 메뉴에
    # '내 것'으로 표시(브라우저는 내 CLI에 직접 접근 못 하므로 이 보고값이 유일한 내 데이터).
    acct = _cli_json(cli, "account", "status")
    if isinstance(acct, dict):
        ws = _cli_json(cli, "workspace", "list")
        acct["workspaces"] = ws if isinstance(ws, list) else []

    # 3) 새 것만 추림(서버에 없는 job_id)
    fresh = [j for j in jobs if isinstance(j, dict) and j.get("id") and j["id"] not in known_ids]
    # 내 힉스필드 uid = 내 전체 목록의 최다 user_<id>(= 내 본인 것). fresh 만 보면 남의 레퍼런스에
    # 오염될 수 있으므로 반드시 '전체 목록' 기준으로 산출해 명시 전송 → 서버가 올바르게 연결.
    my_uid = _dominant_uid(jobs)
    print(f"[로컬] 잡 {len(jobs)}개 중 새 잡 {len(fresh)}개 (서버 보유 {len(known_ids)}개) · 내 uid={my_uid}")
    if not fresh and not acct:
        print("[완료] 올릴 새 결과물이 없습니다.")
        return

    # 4) 서버로 push (메타데이터만 — 미디어는 공개 URL 그대로, 토큰 안 보냄)
    status, body = _http(
        "POST", f"{server}/api/ingest", token=token,
        body={"jobs": fresh, "creator_uid": my_uid, "account_status": acct},
    )
    if status != 200 or not isinstance(body, dict):
        # 적재 실패로 watch 루프를 죽이지 않는다(소프트 보류) — 로그인 전(401·인증 필요)이나
        # 계정 불일치(409·CLI≠허브로그인)는 사용자가 올바른 계정으로 로그인하면 다음 사이클에
        # 자동 성공한다. 메시지는 그대로 보여 원인(특히 409 불일치)을 알게 한다.
        detail = body.get("detail") if isinstance(body, dict) else body
        print(f"[보류] 적재 실패(status={status}): {detail}")
        print("       올바른 계정으로 허브에 로그인하면 자동으로 다시 시도합니다.")
        return
    print(
        f"[완료] 신규 {body.get('inserted')} · 갱신 {body.get('updated')} · "
        f"변동없음 {body.get('unchanged')} · 건너뜀 {body.get('skipped')} · "
        f"연결 uid={body.get('linked_uid')}"
    )


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
    if args.token:
        token = args.token  # AUTH off 로컬 허브는 토큰을 검증하지 않으므로 더미('local')도 됨
        print(f"[토큰] 전달된 세션 토큰 사용({args.email or '로컬'})")
    else:
        if not args.email:
            sys.exit("[오류] --email 또는 --token 중 하나는 필요합니다.")
        password = args.password or getpass.getpass(f"{args.email} 허브 비밀번호: ")
        token = login(server, args.email, password)

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
            try:
                if reason == "gen-request":
                    print("[이벤트] 허브 생성/재생성 요청 — 내 CLI로 실행")
                    execute_pending(server, token, cli)  # 연속 풀 — 16칸 채우고 다 비울 때까지
                    # ★ 실행 결과를 서버로 올린다(서버 직결: fulfill 은 로컬 DB 라 UI 에 안 보임 —
                    #    완료된 잡을 generate list→/api/ingest 로 push 해야 서버 DB 에 들어가 보인다).
                    if not args.no_push:
                        push_once(server, token, cli, args.size)
                elif reason == "sync":
                    if args.no_push:
                        print("[이벤트] 동기화 요청 — 생성 전용 모드라 건너뜀(공유는 '선택 발행')")
                    else:
                        print("[이벤트] 내 작업 올리기 요청")
                        push_once(server, token, cli, args.size)
                # reason None = 타임아웃(idle) → 조용히 재대기
            except SystemExit:
                raise
            except Exception as e:  # noqa: BLE001 — 한 번 실패해도 루프 유지
                print(f"[경고] 처리 중 오류(무시하고 계속): {e}")
    else:
        cycle()


if __name__ == "__main__":
    main()
