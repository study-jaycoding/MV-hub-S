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
  · 대상 특정: "포트를 실제로 점유한 프로세스"를 찾고, 그 커맨드라인의 독립 토큰이
    이 배포의 backend\serve.py 절대경로와 정확히 같을 때만 종료한다. 포트 주인이 없으면
    커맨드라인 검색으로 폴백하되 후보가 2개 이상이면 개입하지 않는다.
  · 종료 직전 재확인: CommandLine·CreationDate·포트 소유 상태가 판정 시점과
    달라졌으면 PID 재사용/복구 가능성으로 보고 종료하지 않고 ALERT 만 남긴다.
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
EXPECTED_SERVE_PATH = (ROOT / "backend" / "serve.py").resolve()
SELF_PID = os.getpid()

_LOG_MAX_BYTES = 2 * 1024 * 1024
_LOG_KEEP = 3
_READY_BODY_LIMIT = 4096
_READY_CHECK_VALUES = {
    "content": frozenset({"ok"}),
    "trash": frozenset({"ok", "not_created"}),
    "manage": frozenset({"ok", "disabled"}),
}


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


@dataclass(frozen=True)
class ProcessIdentity:
    """PID 재사용을 검출하기 위해 판정 시점에 저장한 프로세스 정체성."""

    pid: int
    command_line: str
    creation_date: str
    owns_port: bool


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

        if status == "port_hijacked":
            # HTTP 응답은 왔지만 우리 서버라고 확정할 수 없다. dead 누적을
            # 끊어 자동 종료로 절대 흐르지 않게 하고, 시작 유예 중에도 ALERT 는 즉시 남긴다.
            self.fails = 0
            self.busy_streak = 0
            self.maintenance_streak = 0
            self.busy_alerted = False
            self.maintenance_alerted = False
            return ProbeDecision(
                "port_hijacked",
                previous_fails,
                previous_busy,
                previous_maintenance,
                True,
                should_alert=True,
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


def _ready_response_status(response) -> tuple[str, str]:
    """200 본문이 MV Hub readiness 계약일 때만 정상으로 인정한다."""
    try:
        raw = response.read(_READY_BODY_LIMIT + 1)
    except Exception:  # noqa: BLE001 — 헤더만 온 불완전 응답도 종료 금지
        return "port_hijacked", "HTTP 200 ready body unreadable"
    if len(raw) > _READY_BODY_LIMIT:
        return "port_hijacked", "HTTP 200 ready body too large"
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return "port_hijacked", "HTTP 200 ready body is not JSON"
    if not isinstance(payload, dict) or payload.get("status") != "ready":
        return "port_hijacked", "HTTP 200 ready status mismatch"
    checks = payload.get("checks")
    if not isinstance(checks, dict):
        return "port_hijacked", "HTTP 200 ready checks missing"
    if any(checks.get(name) not in allowed for name, allowed in _READY_CHECK_VALUES.items()):
        return "port_hijacked", "HTTP 200 ready DB checks mismatch"
    return "ok", "ok"


def check_ready(url: str, timeout: float) -> tuple[str, str]:
    """('ok'|'busy'|'maintenance'|'dead'|'port_hijacked', 사유).

    ★'busy'와 'dead'를 구분한다 — HTTP 응답이 온 비-200(503 등)은 프로세스가 살아서
    응답 중이라는 증거다(예: 대량 삭제로 DB 검사가 잠시 타임아웃). 이걸 사망과 똑같이
    세면 멀쩡히 일하던 서버를 taskkill 해 오히려 장애를 만든다(오탐 재시작).
    연결거부/타임아웃처럼 응답 자체가 없는 것만 'dead' 로 개입 카운트에 넣는다.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mvhub-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if r.status == 200:
                return _ready_response_status(r)
            return "busy", f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return _http_error_status(e)
    except Exception as e:  # noqa: BLE001 — 연결거부/타임아웃 등 무응답
        return "dead", f"{type(e).__name__}: {e}"


def _powershell_json(script: str) -> tuple[list[object], bool]:
    """PowerShell 조회 결과와 성공 여부. '결과 없음'과 '조회 실패'를 구분한다."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script + " | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return [], False
        raw = (out.stdout or "").strip()
        if not raw:
            return [], True
        data = json.loads(raw)
        return (data if isinstance(data, list) else [data]), True
    except Exception:  # noqa: BLE001
        return [], False


def _command_line_tokens(command_line: str) -> list[str]:
    """restart_server_task.ps1와 같은 Windows 따옴표 토큰 분리."""
    tokens: list[str] = []
    current: list[str] = []
    in_quote = False
    for char in command_line:
        if char == '"':
            in_quote = not in_quote
            continue
        if not in_quote and char in {" ", "\t"}:
            if current:
                tokens.append("".join(current))
                current = []
            continue
        current.append(char)
    if current:
        tokens.append("".join(current))
    return tokens


def command_line_matches_server(
    command_line: str,
    expected_serve_path: Path = EXPECTED_SERVE_PATH,
) -> bool:
    """커맨드라인의 독립 토큰 하나가 우리 serve.py 절대경로와 같은지 확인."""
    if not command_line or not str(expected_serve_path):
        return False
    expected = os.path.normcase(os.path.abspath(str(expected_serve_path)))
    for token in _command_line_tokens(command_line):
        try:
            candidate = os.path.normcase(os.path.abspath(token))
        except (OSError, ValueError):
            candidate = token
        if candidate == expected:
            return True
    return False


def _listen_owner_pids(port: int) -> tuple[list[int], bool]:
    owners, query_ok = _powershell_json(
        "Get-NetTCPConnection -State Listen -ErrorAction Stop"
        f" | Where-Object {{ $_.LocalPort -eq {port} }}"
        " | Select-Object -ExpandProperty OwningProcess -Unique"
    )
    pids: list[int] = []
    for o in owners:
        pid = o if isinstance(o, int) else o.get("value") if isinstance(o, dict) else None
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 and pid != SELF_PID:
            pids.append(pid)
    return sorted(set(pids)), query_ok


def _process_identity(pid: int, *, owns_port: bool) -> ProcessIdentity | None:
    rows, query_ok = _powershell_json(
        f'Get-CimInstance Win32_Process -Filter "ProcessId = {pid}" -ErrorAction Stop'
        " | Select-Object ProcessId, CommandLine, CreationDate"
    )
    if not query_ok or len(rows) != 1 or not isinstance(rows[0], dict):
        return None
    row = rows[0]
    try:
        row_pid = int(row.get("ProcessId") or 0)
    except (TypeError, ValueError):
        return None
    command_line = row.get("CommandLine")
    creation_date = row.get("CreationDate")
    if row_pid != pid or not isinstance(command_line, str) or not command_line:
        return None
    if creation_date is None or not str(creation_date):
        return None
    return ProcessIdentity(pid, command_line, str(creation_date), owns_port)


def _port_owner_targets(port: int) -> tuple[list[ProcessIdentity], str]:
    """포트 점유자가 이 배포의 serve.py 하나임을 입증한다."""
    pids, query_ok = _listen_owner_pids(port)
    if not query_ok:
        return [], "port-owner-query-failed"
    if not pids:
        return [], "port-free"
    if len(pids) != 1:
        return [], "port_hijacked"
    identities: list[ProcessIdentity] = []
    for pid in pids:
        identity = _process_identity(pid, owns_port=True)
        if identity is None or not command_line_matches_server(identity.command_line):
            return [], "port_hijacked"
        identities.append(identity)
    return identities, "port-owner"


def _listen_ports(pid: int) -> tuple[set[int], bool]:
    listens, query_ok = _powershell_json(
        "Get-NetTCPConnection -State Listen -ErrorAction Stop"
        f" | Where-Object {{ $_.OwningProcess -eq {pid} }}"
        " | Select-Object -ExpandProperty LocalPort -Unique"
    )
    ports: set[int] = set()
    for value in listens:
        raw = value if isinstance(value, int) else value.get("value") if isinstance(value, dict) else None
        if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
            ports.add(raw)
    return ports, query_ok


def find_target_pids(port: int) -> tuple[list[ProcessIdentity], str]:
    """(종료 대상 정체성, 판별 방법). 확신이 없으면 빈 목록으로 개입을 보류한다."""
    # 1순위: 포트 LISTEN 소유자의 절대경로 정체성을 확인한다.
    targets, owner_status = _port_owner_targets(port)
    if owner_status == "port-owner":
        return targets, owner_status
    if owner_status != "port-free":
        return [], owner_status

    # 2순위(포트 주인 없음 = 바인딩 전에 멈췄거나 이미 죽음): 커맨드라인 검색.
    # 함정: 같은 PC 에 다른 serve.py(테스트/개발 서버)가 떠 있을 수 있다. 절대경로
    # 토큰이 정확히 같은 후보만 남기고, 다른 포트를 LISTEN 중이면 제외한다.
    rows, query_ok = _powershell_json(
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" -ErrorAction Stop"
        " | Select-Object ProcessId, CommandLine, CreationDate"
    )
    if not query_ok:
        return [], "process-query-failed"
    candidates: list[ProcessIdentity] = []
    identity_incomplete = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        command_line = row.get("CommandLine")
        if not isinstance(command_line, str) or not command_line_matches_server(command_line):
            continue
        try:
            pid = int(row.get("ProcessId") or 0)
        except (TypeError, ValueError):
            identity_incomplete = True
            continue
        creation_date = row.get("CreationDate")
        if pid <= 0 or pid == SELF_PID or creation_date is None or not str(creation_date):
            identity_incomplete = True
            continue
        ports, listens_ok = _listen_ports(pid)
        if not listens_ok:
            return [], "listen-query-failed"
        if ports and ports != {port}:
            continue  # 다른 포트의 살아있는 서버 — 우리 대상 아님
        candidates.append(ProcessIdentity(pid, command_line, str(creation_date), port in ports))
    if len(candidates) == 1:
        return candidates, "cmdline"
    if len(candidates) > 1:
        return [], f"ambiguous({len(candidates)} candidates)"  # 오살 방지 — 개입 보류
    if identity_incomplete:
        return [], "identity-incomplete"
    return [], "not-found"


def _same_process_just_before_kill(target: ProcessIdentity, port: int) -> bool:
    """taskkill 직전 PID 정체성과 포트 소유 상태가 판정 시점과 같은지 재확인."""
    current = _process_identity(target.pid, owns_port=target.owns_port)
    if current is None or not command_line_matches_server(current.command_line):
        return False
    if current.command_line != target.command_line or current.creation_date != target.creation_date:
        return False
    owners, query_ok = _listen_owner_pids(port)
    if not query_ok:
        return False
    return owners == ([target.pid] if target.owns_port else [])


def kill_pids(
    args,
    targets: list[ProcessIdentity],
    port: int,
) -> tuple[bool, str]:
    """(종료 성공 여부, 결과 상태). dry-run 은 성공 취급하되 재확인은 거친다."""
    if len(targets) != 1:
        return False, "identity_mismatch"
    any_ok = False
    for target in targets:
        pid = target.pid
        if not _same_process_just_before_kill(target, port):
            log(args, f"identity_mismatch — PID {pid} 종료 직전 정체성 변경, 개입 보류")
            return False, "identity_mismatch"
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
    return any_ok, "killed" if any_ok else "kill-failed"


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
    identity_alerted = False

    while True:
        status, reason = check_ready(url, args.timeout)
        if status in {"busy", "maintenance"}:
            # 503 등의 응답을 보낸 LISTEN 소유자가 우리 serve.py 인지 저비용으로
            # 확인한다. 다르거나 조회할 수 없으면 busy/dead 어느 쪽으로도 단정하지 않는다.
            _owners, owner_status = _port_owner_targets(args.port)
            if owner_status != "port-owner":
                status = "port_hijacked"
                reason = f"{reason}; {owner_status}"
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
            identity_alerted = False
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
        elif status == "port_hijacked":
            # 200 본문이 우리 ready 계약이 아니거나 busy 포트 주인을 입증할 수 없다.
            # 정상/사망 둘 다로 오판하지 않고 사람에게만 즉시 알린다.
            if decision.observable:
                log(args, f"port_hijacked — 자동 개입 보류 ({reason})")
                if not hold_alerted:
                    hold_alerted = True
                    alert = _log_path(args).with_name("watchdog_ALERT.txt")
                    msg = (
                        f"{datetime.now():%Y-%m-%d %H:%M:%S} port_hijacked — 포트 "
                        f"{args.port}의 응답/점유자가 MV Hub ready 계약과 프로세스 정체성을 "
                        f"확신할 수 없습니다({reason}). 자동 종료하지 않으므로 점유자를 "
                        "직접 확인하세요."
                    )
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
                        targets, how = find_target_pids(args.port)
                        if targets and hold_alerted:
                            # 포트 뺏김이 방금 풀려 우리 serve.py 가 다시 포트를 잡았다 —
                            # 점유 기간에 누적된 fails 로 부팅 중인 새 서버를 즉시 죽이면
                            # 안 된다(코덱스 P1). 이번 주기는 개입하지 않고 부팅 유예를 새로 준다.
                            log(args, "포트 점유 해제 감지 — 새 서버에 시작 유예 부여(개입 보류)")
                            hold_alerted = False
                            target_alerted = False
                            identity_alerted = False
                            tracker.reset_for_startup()
                            startup_deadline = time.monotonic() + args.startup_grace
                        elif targets:
                            target_pids = [target.pid for target in targets]
                            log(args, f"개입 — 대상 PID {target_pids} (판별: {how})")
                            kill_ok, kill_status = kill_pids(args, targets, args.port)
                            if kill_ok:
                                kills.append(now)
                                # 재기동에도 부팅과 같은 유예를 준다 — 재기동 부팅이
                                # 마이그레이션으로 길어질 때 또 죽이는 루프 방지.
                                target_alerted = False
                                identity_alerted = False
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
                            if kill_status == "identity_mismatch":
                                if not identity_alerted:
                                    identity_alerted = True
                                    alert = _log_path(args).with_name("watchdog_ALERT.txt")
                                    msg = (
                                        f"{datetime.now():%Y-%m-%d %H:%M:%S} identity_mismatch — "
                                        f"PID {target_pids}의 CommandLine·CreationDate·포트 소유가 "
                                        "종료 직전 달라져 자동 개입을 중단했습니다. "
                                        "현재 점유자와 서버 로그를 직접 확인하세요."
                                    )
                                    log(args, "★ALERT★ " + msg)
                                    try:
                                        alert.write_text(msg + "\n", encoding="utf-8")
                                    except OSError:
                                        pass
                            else:
                                # 종료 실패(접근 거부 등) — 개입으로 치지 않고 다음 주기에 재시도.
                                log(args, "종료 실패 — 다음 주기에 재시도")
                        elif how == "port_hijacked":
                            # 다른 프로그램이 서버 포트를 차지 — 자동 종료는 위험해서 보류하지만,
                            # 조용히 반복하면 영구 마비를 아무도 모른다(적대 리뷰 P1) → ALERT 1회.
                            # fails 는 리셋하지 않는다: 매 주기 재확인하다 포트가 풀리면 즉시 개입.
                            if not hold_alerted:
                                hold_alerted = True
                                alert = _log_path(args).with_name("watchdog_ALERT.txt")
                                msg = (f"{datetime.now():%Y-%m-%d %H:%M:%S} port_hijacked — 포트 {args.port} 를 "
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
