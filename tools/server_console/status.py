"""서버 상태를 읽고 판정한다. 값마다 관측 시각·출처를 함께 두고, 모르면 '확인 불가'로 둔다."""
from __future__ import annotations

import json
import msvcrt
import os
import re
import socket
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import names
from .install import Installation

_READ_TAIL_BYTES = 2_000_000


@dataclass(frozen=True)
class Ready:
    code: int | None          # HTTP 상태 코드, 응답이 없으면 None
    payload: dict | None
    error: str                 # '' | 'refused' | 'timeout' | 'other'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_ready(port: int, timeout: float = 3.0, tls: bool = False) -> Ready:
    """이 PC 의 서버에 /api/ready 를 묻는다(인증 없는 읽기). 프록시·리다이렉트를 쓰지 않는다."""
    handlers: list = [urllib.request.ProxyHandler({}), _NoRedirect]
    if tls:
        import ssl
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # 127.0.0.1 의 준비 상태만 읽고 아무것도 보내지 않는다
        handlers.append(urllib.request.HTTPSHandler(context=context))
    opener = urllib.request.build_opener(*handlers)
    scheme = "https" if tls else "http"
    try:
        with opener.open(f"{scheme}://127.0.0.1:{port}/api/ready", timeout=timeout) as response:
            return Ready(response.status, _json_or_none(response.read(65536)), "")
    except urllib.error.HTTPError as exc:
        return Ready(exc.code, _json_or_none(exc.read(65536)), "")
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, ConnectionRefusedError):
            return Ready(None, None, "refused")
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return Ready(None, None, "timeout")
        return Ready(None, None, "other")


def _json_or_none(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def parse_ts(value: object) -> float | None:
    try:
        stamp = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.timestamp()


def read_tail_lines(path: Path, max_bytes: int = _READ_TAIL_BYTES) -> list[str]:
    """파일 끝부분의 완전한 줄만. 첫 줄은 중간에서 잘렸을 수 있어 버린다."""
    with path.open("rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        start = max(0, size - max_bytes)
        handle.seek(start)
        data = handle.read()
    lines = data.split(b"\n")
    if start > 0 and lines:
        lines = lines[1:]
    if lines and lines[-1] == b"":
        lines = lines[:-1]
    elif lines:
        lines = lines[:-1]  # 마지막 줄이 아직 쓰는 중일 수 있다
    return [line.decode("utf-8", errors="replace").rstrip("\r") for line in lines]


def latest_snapshots(path: Path, count: int = 2) -> tuple[str, list[dict]]:
    """('ok'|'missing'|'unreadable'|'none', 최신부터 runtime_snapshot 최대 count 개)."""
    if not path.exists():
        return "missing", []
    try:
        lines = read_tail_lines(path)
    except OSError:
        return "unreadable", []
    found = []
    for raw in reversed(lines):
        if '"runtime_snapshot"' not in raw:
            continue
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("event") == "runtime_snapshot":
            found.append(payload)
            if len(found) >= count:
                break
    return ("ok" if found else "none"), found


def request_rate(latest: dict, previous: dict | None) -> tuple[int, float] | None:
    """같은 프로세스의 두 snapshot 사이 요청 증가와 실제 간격(초). 다른 프로세스면 None."""
    if not previous or latest.get("pid") != previous.get("pid"):
        return None
    t1, t0 = parse_ts(latest.get("ts")), parse_ts(previous.get("ts"))
    try:
        n1 = int(((latest.get("snapshot") or {}).get("requests") or {}).get("total"))
        n0 = int(((previous.get("snapshot") or {}).get("requests") or {}).get("total"))
    except (TypeError, ValueError):
        return None
    if t1 is None or t0 is None or t1 <= t0 or n1 < n0:
        return None
    return n1 - n0, t1 - t0


def _read_json(path: Path) -> tuple[str, Any]:
    """('ok', 값) | ('missing', None) | ('unreadable', None). 파일 없음만 '없음' — 열기 실패는 없음이 아니다."""
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            text = handle.read()
    except FileNotFoundError:
        return "missing", None
    except OSError:
        return "unreadable", None
    try:
        return "ok", json.loads(text)
    except ValueError:
        return "unreadable", None


_BUILD_ID = re.compile(r"^[0-9a-f]{32}$")  # coordinator 의 uuid4().hex
_REPARSE_POINT = 0x400


def plain_child(base: Path, *parts: str) -> Path | None:
    """base 아래 parts 경로. base 부터 끝 파일까지 어느 것도 연결 지점(junction·심볼릭 링크)이 아니어야 한다.

    없는 경로·확인 실패도 None. parts 는 호출자가 형식을 검사한 이름만 넘긴다(경로 결합으로 밖에 나가지 않게).
    """
    chain = [base]
    for part in parts:
        chain.append(chain[-1] / part)
    try:
        if any(getattr(os.lstat(path), "st_file_attributes", 0) & _REPARSE_POINT for path in chain):
            return None
    except OSError:
        return None
    return chain[-1]


def _commit_of(inst: Installation, build_id: str) -> str:
    descriptor_path = plain_child(inst.logs, "server-stages", build_id, "server-stage.json")
    state, descriptor = _read_json(descriptor_path) if descriptor_path else ("missing", None)
    commit = descriptor.get("source_commit") if state == "ok" and isinstance(descriptor, dict) else ""
    return commit if isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit) else ""


def running_code(inst: Installation) -> dict[str, str]:
    """돌고 있는 코드: stage 면 그 stage 의 source_commit, legacy 면 루트 소스."""
    unknown = {"source": "unknown", "build_id": "", "commit": ""}
    current_path = plain_child(inst.logs, names.SERVER_CURRENT)
    state, current = _read_json(current_path) if current_path else ("missing", None)
    if state != "ok" or not isinstance(current, dict):
        return unknown
    build_id = current.get("build_id")
    if build_id == "legacy-source":
        return {"source": "legacy", "build_id": build_id, "commit": ""}
    if not isinstance(build_id, str) or not _BUILD_ID.fullmatch(build_id):
        return unknown
    if plain_child(inst.logs, "server-stages", build_id) is None:
        return unknown  # 없거나 연결 지점(상위 server-stages 포함)
    return {"source": "stage", "build_id": build_id, "commit": _commit_of(inst, build_id)}


_RUN_RECORD = re.compile(r"^server-prepare-([0-9a-f]{32})\.json$")


def prepare_runs(inst: Installation) -> set[str] | None:
    """지금 있는 준비 실행 이름(run_id) 전부. 실행 직전에 재 두고 끝난 뒤 새로 생긴 것만 이 작업 것으로 본다."""
    try:
        return {m.group(1) for entry in os.scandir(inst.logs) if (m := _RUN_RECORD.match(entry.name))}
    except OSError:
        return None


def run_outcome(inst: Installation, before: set[str] | None) -> dict:
    """이 작업이 띄운 준비 실행과 그 커밋. 실행 전에 없던 준비 기록이 정확히 하나일 때만 잇는다(아니면 linked=False).

    성공(종료 코드 0)한 실행에서만 부른다(jobs.run_job). 실패한 실행은 기록을 만들기 전에 끝났을 수 있어 그 사이
    다른 실행이 만든 기록 하나를 제 것으로 잘못 이을 수 있다.
    shortcut: 성공한 실행과 같은 때 손으로 돌린 업데이트가 겹치면 둘이 생겨 '미확인'이 된다 — coordinator 가
    run_id 를 넘겨 줄 수 있게 되면 그것으로 바꾼다.
    """
    running = running_code(inst)
    after = prepare_runs(inst)
    new = sorted(after - before) if before is not None and after is not None else []
    if len(new) != 1:
        return {"linked": False, "running": running, "candidates": len(new)}
    run_id = new[0]
    record_path = plain_child(inst.logs, f"server-prepare-{run_id}.json")
    state, record = _read_json(record_path) if record_path else ("missing", None)
    prepare = record.get("status") if state == "ok" and isinstance(record, dict) else None
    prepare = prepare if isinstance(prepare, str) else ""
    if prepare == "up_to_date":  # 새로 설치하지 않았다 — 지금 서버 코드를 이 작업의 결과로 적지 않는다
        return {"linked": True, "run_id": run_id, "prepare": prepare, "commit": "", "installed": False,
                "running": running}
    return {"linked": True, "run_id": run_id, "prepare": prepare, "commit": _commit_of(inst, run_id),
            "installed": running.get("build_id") == run_id, "running": running}


def _byte_locked(path: Path) -> bool | None:
    """다른 프로세스가 0번 바이트를 잠갔는지 — 잠금을 잡지 않고 읽어만 본다. None = 판단 불가."""
    try:
        handle = path.open("rb")
    except FileNotFoundError:
        return False
    except OSError:
        return None  # 열지도 못함 — 권한 문제 등, 잠금이라고 단정하지 않는다
    with handle:
        try:
            handle.read(1)
        except PermissionError:
            return True  # 열렸는데 읽기만 막힘 = 다른 프로세스의 바이트 잠금(C 런타임이 33 을 EACCES 로 바꿈)
        except OSError as exc:
            return True if getattr(exc, "winerror", None) == 33 else None
    return False


Trace = tuple[str, str]  # (종류: git|request|journal|prepare|unknown, 화면 문구)
# coordinator(server_release_update.py write_progress)가 쓰는 상태 전부. 모르는 값은 흔적으로 막는다.
_PREPARE_STATES = ("running", "prepared", "up_to_date", "failed", "interrupted")


def update_traces(inst: Installation) -> list[Trace]:
    """업데이트·전환이 진행 중이거나 끝을 모르는 흔적. 하나라도 있으면 새 업데이트를 막는다."""
    traces = []
    locked = _byte_locked(inst.logs / names.GIT_UPDATE_LOCK)
    if locked:
        traces.append(("git", "Git 업데이트가 실행 중입니다(git-update.lock)"))
    elif locked is None:
        traces.append(("unknown", "Git 업데이트 잠금을 확인하지 못했습니다"))
    state, _ = _read_json(inst.logs / names.UPDATE_REQUEST)
    if state != "missing":  # 내용과 상관없이 남아 있으면(못 읽어도) 전환 대기다
        traces.append(("request", "서버 전환 요청이 남아 있습니다(server-update-request.json)"))
    state, journal = _read_json(inst.logs / names.INSTALL_JOURNAL)
    phase = journal.get("phase") if state == "ok" and isinstance(journal, dict) else None
    if state == "ok" and not isinstance(phase, str):
        traces.append(("unknown", "전환 기록 형식을 알 수 없습니다(server-install-journal.json)"))
    elif state == "unreadable":
        traces.append(("unknown", "전환 기록을 읽지 못했습니다(server-install-journal.json)"))
    elif state == "ok" and phase not in names.TERMINAL_PHASES:
        traces.append(("journal", f"서버 전환이 끝나지 않았습니다(단계 {phase})"))
    state, prepare = _read_json(inst.logs / names.PREPARE_RECORD)
    status_value = prepare.get("status") if state == "ok" and isinstance(prepare, dict) else None
    if state == "unreadable" or (state == "ok" and status_value not in _PREPARE_STATES):
        traces.append(("unknown", "준비 기록을 읽지 못했거나 상태를 알 수 없습니다(server-prepare.json)"))
    elif status_value == "running":
        traces.append(("prepare", "새 코드 준비가 실행 중이거나 중간에 멈췄습니다(server-prepare.json)"))
    return traces


class DbBusy(RuntimeError):
    """DB 를 바꾸는 이사 도구(진짜 OUT·백업 복구)가 DB 잠금을 쥐고 있다 — 이번 차례는 읽지 않는다."""


@contextmanager
def db_read_lock(inst: Installation):
    """관리 창의 직접 DB 읽기는 이 잠금(logs\\console-db.lock 0번 바이트)을 쥔 동안에만 한다(설계 3판). 이사 감싸개가
    쥐고 있으면 DbBusy, 잠금 파일 자체를 못 열면 OSError — 둘을 다른 문구로 보인다."""
    handle = (inst.logs / names.DB_LOCK).open("a+b")
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        handle.close()
        raise DbBusy("서버 이사·복구 중 — DB 를 읽지 않습니다") from exc
    try:
        yield
    finally:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            handle.close()


def inspect_intake(inst: Installation) -> tuple[dict | None, str]:
    """생성 접수 멈춤·진행 중 생성(DB 읽기 전용). 접수 멈춤은 업데이트 admission 과 다른 상태다."""
    try:
        import deploy_fence_check
        with db_read_lock(inst):
            return deploy_fence_check.inspect_fence(inst.content_db), ""
    except DbBusy as exc:
        return None, str(exc)
    except FileNotFoundError:
        return None, "DB 파일 없음"
    except Exception as exc:  # noqa: BLE001 — 화면에는 '확인 불가'와 이유만
        return None, f"DB 읽기 실패({type(exc).__name__})"


SERVER_LABELS = {
    "ok": "정상", "switching": "전환 중", "starting": "시작 중", "maintenance": "유지보수 중",
    "not_ready": "응답하나 준비 실패", "no_answer": "응답 없음", "stopped": "정지 확인", "unknown": "확인 불가",
    "no_task": "서버 작업 없음", "blocked": "요청 차단 중",
}
_ADMISSION_OPEN = ("normal", "activated")  # activated = 전환이 끝나 정상 운영 중(runtime_activation.py:62)


def is_mvhub(ready: Ready) -> bool:
    """/api/ready 응답이 MV Hub 서버의 것인지(main.py ready() 의 세 가지 모양). 아무 HTTP 응답이나 '확인'으로 보지 않는다."""
    payload = ready.payload if isinstance(ready.payload, dict) else {}
    return ((ready.code == 200 and payload.get("status") == "ready" and isinstance(payload.get("checks"), dict))
            or (ready.code == 503 and payload.get("status") in ("maintenance", "not_ready")))


def classify_server(ready: Ready, tasks: dict | None, traces: list[Trace]) -> str:
    switching = any(kind in ("request", "journal") for kind, _ in traces)
    if ready.code == 200 and isinstance(ready.payload, dict) and ready.payload.get("status") == "ready":
        runtime = ready.payload.get("runtime")
        admission = str((runtime if isinstance(runtime, dict) else {}).get("admission") or "normal")
        if switching:
            return "switching"
        return "ok" if admission in _ADMISSION_OPEN else "blocked"
    if ready.code == 503:
        if isinstance(ready.payload, dict) and ready.payload.get("status") == "maintenance":
            return "maintenance"
        return "not_ready"
    if ready.code is not None:
        return "unknown"
    if switching:
        return "switching"
    server_state = ((tasks or {}).get(names.TASK_SERVER) or {}).get("state")
    if ready.error == "refused":
        if server_state == "Running":
            return "starting"
        if server_state == "Missing":
            return "no_task"   # 이 PC 에는 서버 예약 작업이 없다(서버 PC 가 아님)
        if server_state in ("Ready", "Disabled"):
            return "stopped"
    return "no_answer" if ready.error == "timeout" else "unknown"


@dataclass
class Status:
    observed_at: float
    ready: Ready
    server: str
    code: dict[str, str]
    traces: list[Trace]
    snapshot_state: str
    snapshot: dict | None
    snapshot_age: float | None
    rate: tuple[int, float] | None
    intake: dict | None
    intake_error: str
    tasks: dict | None = None
    task_match: str = "unknown"
    extras: dict = field(default_factory=dict)


def collect_status(inst: Installation, tasks: dict | None, task_match: str, now: float | None = None) -> Status:
    now = time.time() if now is None else now
    ready = read_ready(inst.port, tls=inst.tls)
    traces = update_traces(inst)
    snap_state, snaps = latest_snapshots(inst.runtime_log)
    snapshot = snaps[0] if snaps else None
    age = None
    if snapshot:
        stamp = parse_ts(snapshot.get("ts"))
        age = now - stamp if stamp is not None else None
        if age is None or age > names.SNAPSHOT_STALE_SECONDS:
            snap_state = "stale"
    rate = request_rate(snaps[0], snaps[1]) if len(snaps) == 2 else None
    intake, intake_error = inspect_intake(inst)
    return Status(observed_at=now, ready=ready, server=classify_server(ready, tasks, traces),
                  code=running_code(inst), traces=traces, snapshot_state=snap_state, snapshot=snapshot,
                  snapshot_age=age, rate=rate, intake=intake, intake_error=intake_error,
                  tasks=tasks, task_match=task_match)
