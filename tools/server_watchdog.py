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
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
from rotate_text_log import rotate_text_log

ROOT = Path(__file__).resolve().parent.parent  # 저장소 루트(MV_server.bat 위치)
SELF_PID = os.getpid()

_LOG_MAX_BYTES = 2 * 1024 * 1024
_LOG_KEEP = 3
_READY_BODY_LIMIT = 4096


@dataclass(frozen=True)
class ProbeDecision:
    """한 번의 준비상태 확인이 워치독 카운터에 만든 결과."""

    event: str
    previous_fails: int
    previous_busy: int
    previous_maintenance: int
    observable: bool
    should_intervene: bool = False
    should_alert: bool = False


@dataclass
class ProbeTracker:
    """HTTP 상태와 무응답을 섞지 않는 작은 워치독 상태머신."""

    armed: bool = False
    fails: int = 0
    busy_streak: int = 0
    maintenance_streak: int = 0
    busy_alerted: bool = False
    maintenance_alerted: bool = False

    def reset_for_startup(self) -> None:
        self.armed = False
        self.fails = 0
        self.busy_streak = 0
        self.maintenance_streak = 0
        self.busy_alerted = False
        self.maintenance_alerted = False

    def observe(
        self,
        status: str,
        *,
        now: float,
        startup_deadline: float,
        fail_threshold: int,
        busy_threshold: int,
        maintenance_threshold: int,
    ) -> ProbeDecision:
        previous_fails = self.fails
        previous_busy = self.busy_streak
        previous_maintenance = self.maintenance_streak
        observable = self.armed or now >= startup_deadline

        if status == "ok":
            if not self.armed:
                event = "ready_initial"
            elif previous_fails or previous_busy or previous_maintenance:
                event = "ready_recovered"
            else:
                event = "ready"
            self.armed = True
            self.fails = 0
            self.busy_streak = 0
            self.maintenance_streak = 0
            self.busy_alerted = False
            self.maintenance_alerted = False
            return ProbeDecision(
                event,
                previous_fails,
                previous_busy,
                previous_maintenance,
                True,
            )

        if status == "busy":
            self.fails = 0
            self.maintenance_streak = 0
            self.maintenance_alerted = False
            self.busy_streak += 1
            should_alert = (
                observable
                and self.busy_streak >= max(1, int(busy_threshold))
                and not self.busy_alerted
            )
            if should_alert:
                self.busy_alerted = True
            return ProbeDecision(
                "busy_alert" if should_alert else "busy",
                previous_fails,
                previous_busy,
                previous_maintenance,
                observable,
                should_alert=should_alert,
            )

        if status == "maintenance":
            self.fails = 0
            self.busy_streak = 0
            self.busy_alerted = False
            self.maintenance_streak += 1
            should_alert = (
                observable
                and self.maintenance_streak >= max(1, int(maintenance_threshold))
                and not self.maintenance_alerted
            )
            if should_alert:
                self.maintenance_alerted = True
            event = "maintenance_entered" if previous_maintenance == 0 else "maintenance"
            if should_alert:
                event = "maintenance_alert"
            return ProbeDecision(
                event,
                previous_fails,
                previous_busy,
                previous_maintenance,
                observable,
                should_alert=should_alert,
            )

        if status != "dead":
            raise ValueError(f"unknown watchdog probe status: {status}")

        self.busy_streak = 0
        self.maintenance_streak = 0
        self.busy_alerted = False
        self.maintenance_alerted = False
        if not observable:
            return ProbeDecision(
                "startup_grace",
                previous_fails,
                previous_busy,
                previous_maintenance,
                False,
            )
        self.fails += 1
        should_intervene = self.fails >= max(1, int(fail_threshold))
        return ProbeDecision(
            "intervene" if should_intervene else "dead",
            previous_fails,
            previous_busy,
            previous_maintenance,
            True,
            should_intervene=should_intervene,
        )


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
    # 예약 작업의 정상 상태는 watchdog.log 한 곳에만 남긴다. 예외 traceback은 stderr를 통해
    # watchdog_console.log에 계속 기록되므로 장애 진단 정보는 사라지지 않는다.
    if os.environ.get("CONTENT_HUB_TASK") != "1":
        _print_console(line)
    p = _log_path(args)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        rotate_text_log(p, max_bytes=_LOG_MAX_BYTES, keep=_LOG_KEEP)
        with p.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # 로그 실패가 감시를 멈추면 안 된다


def clear_recovered_alert(args) -> bool:
    """현재 워치독이 만든 경고만 서버 정상 확인 뒤 제거한다."""
    alert = _log_path(args).with_name("watchdog_ALERT.txt")
    try:
        if not alert.is_file():
            return False
        alert.unlink()
        log(args, "ALERT 해제 — 서버 정상")
        return True
    except OSError:
        return False


def _http_error_status(error: urllib.error.HTTPError) -> tuple[str, str]:
    """준비상태 응답의 허용된 `status`만 읽고 사용자 데이터는 로그에 남기지 않는다."""
    try:
        raw = error.read(_READY_BODY_LIMIT + 1)
        if len(raw) <= _READY_BODY_LIMIT:
            payload = json.loads(raw.decode("utf-8"))
            if isinstance(payload, dict) and payload.get("status") == "maintenance":
                return "maintenance", f"HTTP {error.code} maintenance"
    except (OSError, UnicodeError, json.JSONDecodeError):
        pass
    return "busy", f"HTTP {error.code}"


def check_ready(url: str, timeout: float) -> tuple[str, str]:
    """('ok'|'busy'|'maintenance'|'dead', 사유).

    ★'busy'와 'dead'를 구분한다 — HTTP 응답이 온 비-200(503 등)은 프로세스가 살아서
    응답 중이라는 증거다(예: 대량 삭제로 DB 검사가 잠시 타임아웃). 이걸 사망과 똑같이
    세면 멀쩡히 일하던 서버를 taskkill 해 오히려 장애를 만든다(오탐 재시작).
    연결거부/타임아웃처럼 응답 자체가 없는 것만 'dead' 로 개입 카운트에 넣는다.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mvhub-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status == 200:
                return "ok", "ok"
            return "busy", f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return _http_error_status(e)
    except Exception as e:  # noqa: BLE001 — 연결거부/타임아웃 등 무응답
        return "dead", f"{type(e).__name__}: {e}"


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
    ap.add_argument("--busy-threshold", type=int, default=30,
                    help="연속 busy(HTTP 응답은 오나 준비 안 됨) 몇 회에 ALERT(개입은 안 함)")
    ap.add_argument(
        "--maintenance-threshold",
        type=int,
        default=60,
        help="연속 maintenance 몇 회에 ALERT(개입은 안 함)",
    )
    # ★부팅-살해 루프 방지: 서버는 소켓을 먼저 열고(listen) 마이그레이션·백필을 돈다 —
    # DB 가 크면 그동안 /api/ready 가 무응답(dead 분류)이라, 유예가 짧으면 부팅 중인
    # 서버를 죽이고 재부팅→또 죽이는 루프가 가능했다. 30분이면 대형 DB 부팅도 덮는다.
    ap.add_argument("--startup-grace", type=float, default=1800.0, help="첫 정상 전 시작 유예(초)")
    ap.add_argument("--post-kill-grace", type=float, default=300.0, help="개입 후 대기(초)")
    ap.add_argument("--storm-window", type=float, default=3600.0, help="폭풍 판정 창(초)")
    ap.add_argument("--storm-limit", type=int, default=3, help="창 내 개입 상한(회)")
    ap.add_argument("--storm-pause", type=float, default=3600.0, help="폭풍 시 개입 중지(초)")
    ap.add_argument("--dry-run", action="store_true", help="종료 없이 로그만")
    ap.add_argument("--log", default="", help="로그 파일 경로")
    ap.add_argument(
        "--max-probes",
        type=int,
        default=0,
        help="검증용 확인 횟수(0이면 운영 기본값인 무한 감시)",
    )
    args = ap.parse_args()

    url = args.url or f"http://127.0.0.1:{args.port}/api/ready"
    log(args, f"워치독 시작 — {url} 주기 {args.interval}s 임계 {args.fail_threshold}회"
              + (" [DRY-RUN]" if args.dry_run else ""))

    # 첫 정상 전에도 시작 유예가 끝나면 dead를 세어 영구 부팅 실패를 복구한다.
    # 시작 유예 중에는 개입하지 않고, 한 번 정상화된 뒤에는 즉시 감시가 활성화된다.
    tracker = ProbeTracker()
    probe_count = 0
    kills: list[float] = []  # 개입 시각 기록(폭풍 판정)
    pause_until = 0.0
    hold_alerted = False   # "포트 뺏김" ALERT 는 상태 지속 중 1회만(매분 스팸 방지)
    startup_deadline = time.monotonic() + max(0.0, args.startup_grace)
    target_alerted = False

    while True:
        status, reason = check_ready(url, args.timeout)
        probe_count += 1
        now = time.monotonic()
        decision = tracker.observe(
            status,
            now=now,
            startup_deadline=startup_deadline,
            fail_threshold=args.fail_threshold,
            busy_threshold=args.busy_threshold,
            maintenance_threshold=args.maintenance_threshold,
        )
        if status == "ok":
            if decision.event == "ready_initial":
                log(args, "서버 정상 확인 — 감시 활성화")
            elif decision.event == "ready_recovered":
                log(
                    args,
                    "복구 확인 "
                    f"(연속 실패 {decision.previous_fails}회·busy "
                    f"{decision.previous_busy}회·maintenance "
                    f"{decision.previous_maintenance}회 후 정상)",
                )
            target_alerted = False
            hold_alerted = False
            clear_recovered_alert(args)
        elif status == "busy":
            # HTTP 응답이 왔다 = 프로세스 생존. 개입(kill) 카운트는 리셋하고 관찰만 한다.
            # 대신 busy 가 오래 지속되면(기본 30주기≈30분) 사람에게 ALERT 로 알린다 —
            # 재시작으로 나아질 상태가 아니므로 자동 개입은 하지 않는다.
            if decision.observable:
                log(
                    args,
                    f"준비 안 됨(busy) {tracker.busy_streak}/{args.busy_threshold} — {reason}",
                )
            if decision.should_alert:
                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                msg = (f"{datetime.now():%Y-%m-%d %H:%M:%S} 서버가 살아 있지만 "
                       f"{tracker.busy_streak}주기 연속 준비 안 됨({reason}) — 자동 재시작 대상이 "
                       "아니므로 서버 로그(DB 검사 실패 등)를 직접 확인하세요.")
                log(args, "★ALERT★ " + msg)
                try:
                    alert.write_text(msg + "\n", encoding="utf-8")
                except OSError:
                    pass
        elif status == "maintenance":
            # DB 교체 게이트가 명시적으로 올라간 상태. 정상 유지보수는 종료하지 않으며 첫 진입과
            # 비정상적으로 긴 지속만 기록한다. HTTP 응답 자체가 사라지면 다음 주기부터 dead로 센다.
            if decision.observable and decision.event == "maintenance_entered":
                log(args, f"DB 유지보수 확인 — 자동 개입 보류 ({reason})")
            if decision.should_alert:
                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                msg = (
                    f"{datetime.now():%Y-%m-%d %H:%M:%S} DB 유지보수가 "
                    f"{tracker.maintenance_streak}주기 연속 지속 중({reason}) — 자동 재시작하지 "
                    "않으므로 DB 복원 작업과 서버 로그를 직접 확인하세요."
                )
                log(args, "★ALERT★ " + msg)
                try:
                    alert.write_text(msg + "\n", encoding="utf-8")
                except OSError:
                    pass
        elif decision.observable:
            prefix = "응답 이상" if tracker.armed else "시작 실패"
            log(args, f"{prefix} {tracker.fails}/{args.fail_threshold} — {reason}")
            if decision.should_intervene:
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
                        if pids and hold_alerted:
                            # 포트 뺏김이 방금 풀려 우리 serve.py 가 다시 포트를 잡았다 —
                            # 점유 기간에 누적된 fails 로 부팅 중인 새 서버를 즉시 죽이면
                            # 안 된다(코덱스 P1). 이번 주기는 개입하지 않고 부팅 유예를 새로 준다.
                            log(args, "포트 점유 해제 감지 — 새 서버에 시작 유예 부여(개입 보류)")
                            hold_alerted = False
                            target_alerted = False
                            tracker.reset_for_startup()
                            startup_deadline = time.monotonic() + args.startup_grace
                        elif pids:
                            log(args, f"개입 — 대상 PID {pids} (판별: {how})")
                            if kill_pids(args, pids):
                                kills.append(now)
                                # 재기동에도 부팅과 같은 유예를 준다 — 재기동 부팅이
                                # 마이그레이션으로 길어질 때 또 죽이는 루프 방지.
                                target_alerted = False
                                tracker.reset_for_startup()
                                startup_deadline = (
                                    time.monotonic() + args.post_kill_grace + args.startup_grace
                                )
                                log(args, f"재기동 대기 {int(args.post_kill_grace)}s")
                                if args.max_probes > 0 and probe_count >= args.max_probes:
                                    log(args, f"검증 종료 — {probe_count}회 확인")
                                    return 0
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
                            if not target_alerted:
                                target_alerted = True
                                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                                phase = "시작되지" if not tracker.armed else "응답하지"
                                msg = (
                                    f"{datetime.now():%Y-%m-%d %H:%M:%S} 서버가 {phase} 않고 "
                                    "종료 대상 프로세스도 안전하게 특정할 수 없습니다 "
                                    f"(대상: {how}). server_console.log를 확인하세요."
                                )
                                log(args, "★ALERT★ " + msg)
                                try:
                                    alert.write_text(msg + "\n", encoding="utf-8")
                                except OSError:
                                    pass
                            # 프로세스가 없으면 감독기/작업 스케줄러의 재시도를 기다린다.
                            tracker.fails = 0
        if args.max_probes > 0 and probe_count >= args.max_probes:
            log(args, f"검증 종료 — {probe_count}회 확인")
            return 0
        # 시작 유예 중 실패는 조용히 대기(부팅/빌드 중)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
