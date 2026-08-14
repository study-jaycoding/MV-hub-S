# -*- coding: utf-8 -*-
r"""공유 서버 워치독 — 죽음(크래시)과 멈춤(행) 둘 다에서 자동 복구한다.

동작 원리:
  MV_server.bat가 server_supervisor.py를 실행하고, 감독기는 serve.py가
  "종료"되면 지수 대기 후 재기동한다.
  그러나 프로세스가 살아있는 채 응답만 안 하는 '행' 상태는 루프가 감지하지 못한다.
  이 워치독이 /api/ready(DB 읽기 포함 준비상태)를 주기 확인하고, 연속 실패 시
  serve.py 프로세스만 강제 종료해 bat 루프가 되살리게 만든다.

안전장치(설계 합의 사항 — 코덱스 리뷰 반영):
  · 시작 유예: 첫 정상 응답을 받기 전에는 절대 개입하지 않는다
    (부팅 직후 DB 마이그레이션 등으로 준비가 지연될 수 있다). 단, 유예가 끝난 뒤에도
    정상 응답이 한 번도 없으면 시작 실패/행으로 판단해 ALERT 또는 안전한 개입을 한다.
  · 대상 특정: "포트를 실제로 점유한 프로세스"를 찾고, 그 커맨드라인에 serve.py 가
    있는지 확인한 뒤에만 종료한다. 포트 주인이 없으면 커맨드라인 검색으로 폴백하되
    후보가 2개 이상이면 오살 위험이 있으므로 개입하지 않고 로그만 남긴다.
  · 재시작 폭풍 차단: 최근 storm-window(기본 60분) 안에 storm-limit(기본 3회) 이상
    개입했으면 storm-pause(기본 60분) 동안 개입을 멈추고 ALERT 파일을 남긴다.
    (창 60분인 이유 — 개입 1회의 사이클이 '유예 5분+실패 3회×1분'≈8분이라,
    15분 창으로는 3회가 한 창에 안 들어와 차단이 영영 발동하지 않는다. 코덱스 P1.)
  · 개입 직후 유예: 종료 후 post-kill-grace(기본 5분)는 재기동 시간을 기다린다.

실행(서버 PC): MV_watchdog.bat  (또는 python tools\server_watchdog.py)
검증용: --dry-run 이면 종료 대상만 로그로 보여주고 실제로 죽이지 않는다.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # 저장소 루트(MV_server.bat 위치)
SELF_PID = os.getpid()

_LOG_MAX_BYTES = 2 * 1024 * 1024
_LOG_KEEP_LINES = 500


def _log_path(args) -> Path:
    return Path(args.log) if args.log else ROOT / "logs" / "watchdog.log"


def _print_console(line: str) -> None:
    """운영 로그 문자가 Windows 콘솔 코드페이지와 달라도 감시를 멈추지 않는다."""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "ascii"
        safe = line.encode(encoding, errors="backslashreplace").decode(encoding)
        print(safe, flush=True)


def log(args, msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    _print_console(line)
    p = _log_path(args)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        # 단순 크기 상한 — 넘치면 뒷부분만 남긴다(외부 로테이션 도구 없이 자급).
        if p.exists() and p.stat().st_size > _LOG_MAX_BYTES:
            tail = p.read_text(encoding="utf-8", errors="replace").splitlines()[-_LOG_KEEP_LINES:]
            p.write_text("\n".join(tail) + "\n", encoding="utf-8")
        with p.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # 로그 실패가 감시를 멈추면 안 된다


def check_ready(url: str, timeout: float) -> tuple[bool, str]:
    """(정상 여부, 사유). 200 이면 정상 — /api/ready 는 DB 읽기 실패 시 503 을 준다."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mvhub-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status == 200:
                return True, "ok"
            return False, f"HTTP {r.status}"
    except Exception as e:  # noqa: BLE001 — 연결거부/타임아웃/HTTPError 전부 '실패 1회'
        return False, f"{type(e).__name__}: {e}"


def _powershell_json(script: str) -> list[dict]:
    """PowerShell 조회 결과를 JSON 리스트로. 실패하면 빈 리스트(개입 보류 방향으로 실패)."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script + " | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=30,
        )
        raw = (out.stdout or "").strip()
        if not raw:
            return []
        data = json.loads(raw)
        return data if isinstance(data, list) else [data]
    except Exception:  # noqa: BLE001
        return []


def find_target_pids(port: int) -> tuple[list[int], str]:
    """(종료 대상 PID 목록, 판별 방법). 확신이 없으면 빈 목록을 돌려 개입을 보류한다."""
    # 1순위: 포트를 LISTEN 중인 프로세스 → 커맨드라인에 serve.py 확인(정확 판별)
    owners = _powershell_json(
        f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue"
        " | Select-Object -ExpandProperty OwningProcess -Unique"
    )
    pids: list[int] = []
    for o in owners:
        pid = o if isinstance(o, int) else o.get("value") if isinstance(o, dict) else None
        if isinstance(pid, int) and pid > 0 and pid != SELF_PID:
            pids.append(pid)
    confirmed = []
    for pid in pids:
        rows = _powershell_json(
            f'Get-CimInstance Win32_Process -Filter "ProcessId = {pid}"'
            " | Select-Object ProcessId, CommandLine"
        )
        cmd = (rows[0].get("CommandLine") or "") if rows else ""
        if "serve.py" in cmd and "server_watchdog" not in cmd:
            confirmed.append(pid)
    if confirmed:
        return confirmed, "port-owner"
    if pids:
        # 포트 주인이 있는데 serve.py 가 아니다 — 다른 프로그램이 포트를 차지한 상황.
        # 이때 커맨드라인 폴백으로 내려가면 무관한 serve.py 를 죽일 수 있으므로 보류.
        return [], "port-owned-by-other"

    # 2순위(포트 주인 없음 = 바인딩 전에 멈췄거나 이미 죽음): 커맨드라인 검색.
    # 함정: 같은 PC 에 다른 serve.py(테스트/개발 서버)가 떠 있을 수 있다. CommandLine 은
    # "python serve.py" 뿐이라 저장소를 구분 못 하므로, "다른 포트에서 정상 LISTEN 중"인
    # 후보는 남의 서버로 보고 제외한다(우리의 행 서버는 감시 포트 외를 들을 이유가 없다).
    rows = _powershell_json(
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\""
        " | Select-Object ProcessId, CommandLine"
    )
    candidates = [
        int(r["ProcessId"]) for r in rows
        if isinstance(r, dict)
        and "serve.py" in (r.get("CommandLine") or "")
        and "server_watchdog" not in (r.get("CommandLine") or "")
        and int(r.get("ProcessId") or 0) != SELF_PID
    ]
    filtered: list[int] = []
    for pid in candidates:
        listens = _powershell_json(
            f"Get-NetTCPConnection -OwningProcess {pid} -State Listen -ErrorAction SilentlyContinue"
            " | Select-Object -ExpandProperty LocalPort -Unique"
        )
        ports = {p if isinstance(p, int) else p.get("value") for p in listens}
        ports.discard(None)
        if ports and ports != {port}:
            continue  # 다른 포트의 살아있는 서버 — 우리 대상 아님
        filtered.append(pid)
    if len(filtered) == 1:
        return filtered, "cmdline"
    if len(filtered) > 1:
        return [], f"ambiguous({len(filtered)} candidates)"  # 오살 방지 — 개입 보류
    return [], "not-found"


def kill_pids(args, pids: list[int]) -> bool:
    """반환: 하나라도 실제로 종료했는가(dry-run 은 성공 취급). 실패한 개입을 성공으로
    기록하면 5분 유예·폭풍 카운트가 진짜 복구를 늦추므로 호출부가 이 값으로 분기한다."""
    any_ok = False
    for pid in pids:
        if args.dry_run:
            log(args, f"[DRY-RUN] taskkill /PID {pid} /T /F (실제 종료 안 함)")
            any_ok = True
            continue
        r = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True, text=True, timeout=30,
        )
        log(args, f"taskkill PID {pid} → rc={r.returncode} {(r.stdout or r.stderr or '').strip()}")
        if r.returncode == 0:
            any_ok = True
    return any_ok


def main() -> int:
    ap = argparse.ArgumentParser(description="MV-hub 공유 서버 워치독")
    default_port = int(os.environ.get("CONTENT_HUB_PORT", "8010"))
    ap.add_argument("--port", type=int, default=default_port)
    ap.add_argument("--url", default="", help="기본 http://127.0.0.1:<port>/api/ready")
    ap.add_argument("--interval", type=float, default=60.0, help="확인 주기(초)")
    ap.add_argument("--timeout", type=float, default=10.0, help="요청 타임아웃(초)")
    ap.add_argument("--fail-threshold", type=int, default=3, help="연속 실패 몇 회에 개입")
    ap.add_argument("--startup-grace", type=float, default=600.0, help="첫 정상 전 시작 유예(초)")
    ap.add_argument("--post-kill-grace", type=float, default=300.0, help="개입 후 대기(초)")
    ap.add_argument("--storm-window", type=float, default=3600.0, help="폭풍 판정 창(초)")
    ap.add_argument("--storm-limit", type=int, default=3, help="창 내 개입 상한(회)")
    ap.add_argument("--storm-pause", type=float, default=3600.0, help="폭풍 시 개입 중지(초)")
    ap.add_argument("--dry-run", action="store_true", help="종료 없이 로그만")
    ap.add_argument("--log", default="", help="로그 파일 경로")
    args = ap.parse_args()

    url = args.url or f"http://127.0.0.1:{args.port}/api/ready"
    log(args, f"워치독 시작 — {url} 주기 {args.interval}s 임계 {args.fail_threshold}회"
              + (" [DRY-RUN]" if args.dry_run else ""))

    armed = False          # 첫 정상 응답 전에는 개입 금지(부팅 빌드 유예)
    fails = 0
    kills: list[float] = []  # 개입 시각 기록(폭풍 판정)
    pause_until = 0.0
    hold_alerted = False   # "포트 뺏김" ALERT 는 상태 지속 중 1회만(매분 스팸 방지)
    startup_deadline = time.monotonic() + max(0.0, args.startup_grace)
    startup_alerted = False

    while True:
        ok, reason = check_ready(url, args.timeout)
        now = time.monotonic()
        if ok:
            if not armed:
                log(args, "서버 정상 확인 — 감시 활성화")
            elif fails:
                log(args, f"복구 확인 (연속 실패 {fails}회 후 정상)")
            armed = True
            fails = 0
            hold_alerted = False
        elif armed or now >= startup_deadline:
            fails += 1
            prefix = "응답 이상" if armed else "시작 실패"
            log(args, f"{prefix} {fails}/{args.fail_threshold} — {reason}")
            if fails >= args.fail_threshold:
                if now < pause_until:
                    log(args, f"폭풍 차단 중 — 개입 보류(남은 {int(pause_until - now)}s)")
                else:
                    kills[:] = [t for t in kills if now - t < args.storm_window]
                    if len(kills) >= args.storm_limit:
                        pause_until = now + args.storm_pause
                        alert = _log_path(args).with_name("watchdog_ALERT.txt")
                        msg = (f"{datetime.now():%Y-%m-%d %H:%M:%S} 재시작 폭풍 감지 — "
                               f"{int(args.storm_window)}s 내 {len(kills)}회 개입. "
                               f"{int(args.storm_pause)}s 동안 자동 개입을 멈춥니다. "
                               "서버 로그를 직접 확인하세요.")
                        log(args, "★ALERT★ " + msg)
                        try:
                            alert.write_text(msg + "\n", encoding="utf-8")
                        except OSError:
                            pass
                    else:
                        pids, how = find_target_pids(args.port)
                        if pids:
                            log(args, f"개입 — 대상 PID {pids} (판별: {how})")
                            if kill_pids(args, pids):
                                kills.append(now)
                                fails = 0
                                log(args, f"재기동 대기 {int(args.post_kill_grace)}s")
                                time.sleep(args.post_kill_grace)
                                continue
                            # 종료 실패(접근 거부 등) — 개입으로 치지 않고 다음 주기에 재시도.
                            log(args, "종료 실패 — 다음 주기에 재시도")
                        elif how == "port-owned-by-other":
                            # 다른 프로그램이 서버 포트를 차지 — 자동 종료는 위험해서 보류하지만,
                            # 조용히 반복하면 영구 마비를 아무도 모른다(적대 리뷰 P1) → ALERT 1회.
                            # fails 는 리셋하지 않는다: 매 주기 재확인하다 포트가 풀리면 즉시 개입.
                            if not hold_alerted:
                                hold_alerted = True
                                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                                msg = (f"{datetime.now():%Y-%m-%d %H:%M:%S} 포트 {args.port} 를 "
                                       "다른 프로그램이 점유 중 — 서버가 못 뜨고 있는데 자동 조치가 "
                                       "불가합니다. 서버 PC에서 점유 프로그램을 확인·종료하세요.")
                                log(args, "★ALERT★ " + msg)
                                try:
                                    alert.write_text(msg + "\n", encoding="utf-8")
                                except OSError:
                                    pass
                            else:
                                log(args, "포트 점유 지속 — 개입 보류(ALERT 기록됨)")
                        else:
                            log(args, f"종료 대상 특정 실패({how}) — 개입 보류")
                            if not armed and not startup_alerted:
                                startup_alerted = True
                                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                                msg = (
                                    f"{datetime.now():%Y-%m-%d %H:%M:%S} 서버가 시작 유예 "
                                    f"{int(args.startup_grace)}초 안에 한 번도 준비되지 않았습니다 "
                                    f"(대상: {how}). server_console.log를 확인하세요."
                                )
                                log(args, "★ALERT★ " + msg)
                                try:
                                    alert.write_text(msg + "\n", encoding="utf-8")
                                except OSError:
                                    pass
                            # 프로세스가 없으면 감독기/작업 스케줄러의 재시도를 기다린다.
                            fails = 0
        # 시작 유예 중 실패는 조용히 대기(부팅/빌드 중)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
