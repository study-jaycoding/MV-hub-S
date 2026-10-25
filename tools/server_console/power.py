"""서버 켜기·끄기·다시 켜기·자동시작 재등록 — 관리 창이 직접 한다(설계 B·C·D 1~5판, `restart_server_task.ps1` 은 안 씀).

- 계약: [켜기] = Server·Watchdog 둘 다 켬(원래 상태 복원이 아니다). BackupCopy 는 건드리지 않고 결과에 상태만 보인다.
- 끈 기록 logs\\console-server-off.json = {phase: stopping|stopped|starting|start_failed, job_id, updated_at}.
  기동 완료(두 작업 Enabled·Running + verify_server)를 확인한 뒤에만 지운다.
- '이 설치' 프로세스 = argv[1] 이 정확히 루트의 supervisor·watchdog(등록 Python) 또는 루트·지금 포인터 stage 의 serve.py
  (서버 Python). 포트와 상관없이 전체에서 찾고, 다른 build 의 stage serve.py 가 있으면 '정지 확인 불가'(자동으로 끄지 않음).
- 실행기 안에서만 바꾼다. 실행기는 시작할 때 자기 자신을 Job 에 넣고(winjob) git-update.lock 을 쥔 채 한다.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Callable

from . import names, server_api, status
from .install import Installation, Runner, child_env, powershell_exe, task_root, task_states, windows_dir
from .jobs import read_json, write_json
from .winjob import SelfJob, run_streamed

Say = Callable[[str], None]
OFF_PHASES = ("stopping", "stopped", "starting", "start_failed")
TASK_WAIT = 15.0
PORT_WAIT = 15.0
READY_WAIT = 180.0
REGISTER_TIMEOUT = 600.0
CMD_SPECIALS = set('"%!^&|<>()')
_STAGE_SERVE = re.compile(r"^[0-9a-f]{32}$")
_PROBLEMS = {"stage_copy": "stage 사본 안에서 열린 관리 창입니다 — 서버 루트의 바로가기로 여세요",
             "no_runtime_python": "등록된 Python 기록(.mvhub-runtime\\python.txt)이 없습니다"}


class PowerError(RuntimeError):
    pass


# ---- 기록 ----

def _record(path: Path) -> tuple[str, dict | None]:
    """('missing'|'ok'|'bad', 값). 연결 지점·못 읽음·객체 아님 = bad."""
    if not os.path.lexists(path):
        return "missing", None
    if path.is_symlink() or getattr(os.lstat(path), "st_file_attributes", 0) & 0x400:
        return "bad", None
    value = read_json(path)
    return ("ok", value) if isinstance(value, dict) else ("bad", None)


def read_off(inst: Installation) -> tuple[str, dict | None]:
    state, value = _record(inst.logs / names.SERVER_OFF)
    if state == "ok" and (value.get("phase") not in OFF_PHASES or not isinstance(value.get("job_id"), str)):
        return "bad", None
    return state, value


def write_off(inst: Installation, phase: str, job_id: str) -> None:
    write_json(inst.logs / names.SERVER_OFF, {"phase": phase, "job_id": job_id, "updated_at": time.time()})


def clear_off(inst: Installation) -> None:
    (inst.logs / names.SERVER_OFF).unlink(missing_ok=True)


def _same(a, b) -> bool:
    try:
        return os.path.normcase(os.path.normpath(str(a))) == os.path.normcase(os.path.normpath(str(b)))
    except (TypeError, ValueError):
        return False


def valid_out_state(value: dict) -> bool:
    """이사 도구의 `_valid_out_state` 와 같은 조건(도구를 관리 창에 import 하지 않으려고 옮겨 적음)."""
    tasks = value.get("tasks")
    pause, port, ready = value.get("pause_original"), value.get("port"), value.get("was_ready")
    return (isinstance(value.get("content_db"), str) and bool(value["content_db"])
            and (pause is None or isinstance(pause, str))
            and (ready is None or isinstance(ready, bool))
            and (port is None or (isinstance(port, int) and not isinstance(port, bool)))
            and isinstance(tasks, dict)
            and all(isinstance(tasks.get(name), dict)
                    and all(isinstance(tasks[name].get(key), bool) for key in ("exists", "enabled", "running"))
                    for name in names.TASKS))


def move_records(inst: Installation) -> dict:
    return {"out": _record(inst.data_dir / names.MOVE_OUT_STATE),
            "in": _record(inst.data_dir / names.MOVE_IN_STATE),
            "journal": os.path.lexists(inst.data_dir / "db" / names.MOVE_JOURNAL)}


def move_refusals(inst: Installation, kind: str, records: dict | None = None) -> list[str]:
    """동작별 허용표(설계 3판). UNDO 만 끝나지 않은 OUT 기록을 대상으로 허용한다."""
    records = records or move_records(inst)
    reasons = []
    if records["journal"]:
        reasons.append(f"서버 이사 설치 기록이 남아 있습니다(db\\{names.MOVE_JOURNAL}) — 수동 확인이 필요합니다")
    in_state, in_value = records["in"]
    if in_state == "bad":
        reasons.append("새 서버 들여오기 기록을 읽지 못했습니다 — 수동 확인이 필요합니다")
    elif in_state == "ok" and in_value.get("phase") != "done":
        reasons.append(f"새 서버 들여오기가 끝나지 않았습니다(단계 {in_value.get('phase')}) — server_move_IN.bat 을 마저 하세요")
    out_state, out = records["out"]
    if kind == "move-undo":
        if out_state != "ok" or not valid_out_state(out):
            reasons.append("되돌릴 이사 기록이 없거나 형식이 다릅니다")
        elif out.get("phase") not in names.MOVE_OUT_ACTIVE:
            reasons.append(f"되돌릴 단계가 아닙니다(단계 {out.get('phase')})")
        elif not _same(out["content_db"], inst.content_db) or int(out.get("port") or names.DEFAULT_PORT) != inst.port:
            reasons.append("이사 기록의 DB·포트가 이 관리 창의 대상과 다릅니다 — 수동 확인이 필요합니다")
    elif out_state == "bad" or (out_state == "ok" and not (valid_out_state(out) and out.get("phase") == "undone")):
        phase = out.get("phase") if out_state == "ok" else "읽지 못함"
        reasons.append(f"서버 이사(내보내기)가 끝나지 않았습니다(단계 {phase}) — 서버 이사 화면에서 되돌리기 또는 수동 확인")
    return reasons


def common_refusals(inst: Installation, kind: str, tasks: dict | None, traces: list[tuple[str, str]],
                    unresolved: list[str] | None) -> list[str]:
    """서버 제어·이사 종류 공통 거절. 자동시작 재등록만 '작업 없음'을 허용한다(그것을 고치는 동작)."""
    reasons = [_PROBLEMS[p] for p in inst.problems if p in _PROBLEMS]
    if inst.tls:
        reasons.append("서버가 https(인증서)로 설정돼 있어 관리 창이 서버 신원을 확인하지 못합니다 — 수동 절차(SERVER_RECOVERY.md)로")
    if tasks is None:
        reasons.append("예약 작업 상태를 확인하지 못했습니다")
    else:
        for name in names.TASKS:
            state = (tasks.get(name) or {}).get("state")
            if state == "Missing":
                if name != names.TASK_BACKUP and kind != "server-autostart":
                    reasons.append(f"예약 작업({name})이 없습니다 — 서버 PC 에서만 씁니다")
                continue
            root = task_root((tasks.get(name) or {}).get("action", ""))
            if state in (None, "", "Error") or root is None:
                reasons.append(f"예약 작업({name})을 확인하지 못했습니다")
            elif not _same(root, inst.root):
                reasons.append(f"예약 작업({name})이 이 설치가 아닌 다른 설치를 가리킵니다")
    if unresolved is None:
        reasons.append("지난 작업 기록을 확인하지 못했습니다(logs\\console-jobs)")
    reasons += [f"이전 작업({job_id[:8]})이 진행 중이거나 결과를 확인하지 않았습니다" for job_id in unresolved or []]
    reasons += [f"업데이트 흔적: {text}" for _kind, text in traces]
    return reasons + move_refusals(inst, kind)


# ---- 프로세스 ----

_PROC_SCRIPT = r"""
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction Stop | ForEach-Object {
  $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }
  "PROC`t$([int]$_.ProcessId)`t$c`t$($_.ExecutablePath)`t$($_.CommandLine)"
}
"DONE"
"""

Proc = tuple[int, "int | None", str, str]  # (PID, 생성 시각, 실행 파일, 명령줄) — server_api.listeners 와 같은 모양


def python_processes(runner: Runner) -> list[Proc] | None:
    """Python 프로세스 전부(WMI). None = 조회 실패 — '없음'으로 보지 않는다."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command", _PROC_SCRIPT], 60)
    lines = [line.rstrip("\r") for line in out.splitlines()]
    if code != 0 or "DONE" not in lines:
        return None
    found = []
    for line in lines:
        if not line.startswith("PROC"):
            continue
        parts = line.split("\t", 4)
        if len(parts) != 5 or not parts[1].isdigit() or not (parts[2] == "" or parts[2].isdigit()):
            return None
        found.append((int(parts[1]), int(parts[2]) if parts[2] else None, parts[3], parts[4]))
    return found


def classify(inst: Installation, procs: list[Proc]) -> tuple[list[tuple[Proc, str]], list[str]]:
    """(이 설치 프로세스와 역할, 자동으로 끄지 않을 서버 후보 문구)."""
    tools = inst.root / "tools"
    registered = server_api.python_family(inst.python) if inst.python else []
    server_pythons = registered + server_api.expected_pythons(inst)
    try:
        expected, _build = server_api.expected_server(inst)
    except server_api.ServerError:
        expected = None
    stages = inst.logs / "server-stages"
    ours, others = [], []
    for proc in procs:
        argv = server_api.split_command_line(proc[3])
        if len(argv) < 2:
            continue
        script, exe = argv[1], proc[2]
        role = ("supervisor" if _same(script, tools / "server_supervisor.py")
                else "watchdog" if _same(script, tools / "server_watchdog.py") else "")
        if role:
            if any(_same(exe, python) for python in registered):
                ours.append((proc, role))
            else:
                others.append(f"PID {proc[0]}: 이 설치의 {role} 인데 실행 파일이 등록 Python 이 아닙니다")
            continue
        path = Path(script)
        is_root = _same(path, inst.root / "backend" / "serve.py")
        is_stage = (path.name.lower() == "serve.py" and path.parent.name.lower() == "backend"
                    and _same(path.parent.parent.parent, stages) and _STAGE_SERVE.fullmatch(path.parent.parent.name))
        if not (is_root or is_stage):
            continue
        if (is_root or (expected is not None and _same(path, expected))) and \
                any(_same(exe, python) for python in server_pythons):
            ours.append((proc, "serve"))
        else:
            others.append(f"PID {proc[0]}: 지금 서버가 아닌 serve.py({path.parent.parent.name})가 남아 있습니다")
    order = {"supervisor": 0, "watchdog": 1, "serve": 2}
    return sorted(ours, key=lambda item: order[item[1]]), others


def _taskkill(runner: Runner, pid: int) -> None:
    runner([str(windows_dir() / "System32" / "taskkill.exe"), "/PID", str(pid), "/T", "/F"], 30)


def clear_processes(inst: Installation, runner: Runner, say: Say, timeout: float = TASK_WAIT) -> None:
    """이 설치 프로세스를 끝낸다 — 끝내기 직전 다시 읽어 PID·생성 시각·명령줄이 같을 때만(재사용 대비)."""
    deadline = time.monotonic() + timeout
    while True:
        procs = python_processes(runner)
        if procs is None:
            raise PowerError("프로세스 목록을 읽지 못했습니다 — 정지를 확인할 수 없습니다")
        ours, others = classify(inst, procs)
        if others:
            raise PowerError("정지 확인 불가: " + " / ".join(others))
        if not ours:
            return
        if time.monotonic() > deadline:
            raise PowerError("이 설치 서버 프로세스가 끝나지 않습니다: "
                             + ", ".join(f"PID {proc[0]}({role})" for proc, role in ours))
        again = {proc[0]: proc for proc in python_processes(runner) or []}
        for proc, role in ours:
            if again.get(proc[0]) == proc:
                say(f"  {role} PID {proc[0]} 를 끝냅니다")
                _taskkill(runner, proc[0])
        time.sleep(1.0)


def stopped_problems(inst: Installation, runner: Runner) -> list[str]:
    """'실제로 꺼짐'인지 그 자리에서 — 두 작업 Disabled · 이 설치 프로세스 없음 · 포트 빔(끈 기록만 믿지 않는다)."""
    tasks = task_states(runner)
    if tasks is None:
        return ["예약 작업 상태를 읽지 못했습니다"]
    reasons = [f"예약 작업({n})이 꺼져 있지 않습니다({_state(tasks, n)}) — 먼저 [끄기]"
               for n in (names.TASK_SERVER, names.TASK_WATCHDOG) if _state(tasks, n) not in ("Disabled", "Missing")]
    procs = python_processes(runner)
    if procs is None:
        return reasons + ["프로세스 목록을 읽지 못했습니다"]
    ours, others = classify(inst, procs)
    reasons += [f"이 설치 서버 프로세스가 남아 있습니다(PID {proc[0]}, {role})" for proc, role in ours] + others
    found = server_api.listeners(inst.port, runner)
    if found is None:
        reasons.append(f"{inst.port} 포트를 확인하지 못했습니다")
    elif found:
        reasons.append(f"{inst.port} 포트를 쓰는 프로세스가 있습니다(PID {', '.join(str(p[0]) for p in found)})")
    return reasons


def wait_port_free(inst: Installation, runner: Runner, timeout: float = PORT_WAIT) -> None:
    deadline = time.monotonic() + timeout
    while True:
        found = server_api.listeners(inst.port, runner)
        if found == []:
            return
        if time.monotonic() > deadline:
            if found is None:
                raise PowerError(f"{inst.port} 포트를 확인하지 못했습니다")
            raise PowerError(f"{inst.port} 포트를 다른 프로세스(PID {', '.join(str(p[0]) for p in found)})가 쓰고 있습니다"
                             " — 손대지 않았습니다")
        time.sleep(1.0)


# ---- 예약 작업 ----

def _schtasks(runner: Runner, *args: str) -> int | None:
    code, _ = runner([str(windows_dir() / "System32" / "schtasks.exe"), *args], 30)
    return code


def _states(runner: Runner) -> dict:
    tasks = task_states(runner)
    if tasks is None:
        raise PowerError("예약 작업 상태를 읽지 못했습니다")
    return tasks


def _wait_tasks(runner: Runner, ok: Callable[[dict], bool], what: str, timeout: float = TASK_WAIT) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        tasks = _states(runner)
        if ok(tasks):
            return tasks
        if time.monotonic() > deadline:
            shown = ", ".join(f"{n}={(tasks.get(n) or {}).get('state')}" for n in (names.TASK_SERVER, names.TASK_WATCHDOG))
            raise PowerError(f"{what}({shown})")
        time.sleep(0.5)


def _state(tasks: dict, name: str) -> str:
    return str((tasks.get(name) or {}).get("state") or "")


def backup_note(runner: Runner) -> str:
    state = _state(task_states(runner) or {}, names.TASK_BACKUP)
    return {"Disabled": "NAS 복사 예약(MVHub BackupCopy)이 꺼져 있습니다 — 백업 복제가 돌지 않습니다",
            "Missing": "NAS 복사 예약(MVHub BackupCopy)이 없습니다"}.get(state, "")


# ---- 끄기·켜기 ----

def stop_sequence(inst: Installation, runner: Runner, job_id: str, say: Say) -> None:
    write_off(inst, "stopping", job_id)
    tasks = _states(runner)
    present = [n for n in (names.TASK_WATCHDOG, names.TASK_SERVER) if _state(tasks, n) not in ("Missing", "")]
    say("[1/5] 예약 작업 끄기(Watchdog → Server)")
    for name in present:
        if _schtasks(runner, "/Change", "/TN", name, "/DISABLE") != 0:
            raise PowerError(f"예약 작업({name})을 끄지 못했습니다")
    say("[2/5] 예약 작업 멈추기")
    for name in present:
        _schtasks(runner, "/End", "/TN", name)  # 이미 멈췄으면 실패해도 된다
    _wait_tasks(runner, lambda t: all(_state(t, n) != "Running" for n in present), "예약 작업이 멈추지 않습니다")
    say("[3/5] 남은 이 설치 서버 프로세스 정리")
    clear_processes(inst, runner, say)
    say("[4/5] 포트가 비는지 확인")
    wait_port_free(inst, runner)
    say("[5/5] 확인")
    tasks = _states(runner)
    if any(_state(tasks, n) not in ("Disabled",) for n in present):
        raise PowerError("예약 작업이 꺼진 상태로 남지 않았습니다")
    clear_processes(inst, runner, say, timeout=0)
    write_off(inst, "stopped", job_id)
    say("완료: 서버를 껐습니다(예약 작업 꺼짐 · 이 설치 프로세스 없음 · 포트 비어 있음)")


def _running(tasks: dict) -> bool:
    return all(_state(tasks, n) == "Running" for n in (names.TASK_SERVER, names.TASK_WATCHDOG))


def _confirm_up(inst: Installation, runner: Runner) -> dict:
    server = server_api.verify_server(inst, runner)
    tasks = _states(runner)
    if not _running(tasks):
        raise PowerError("서버는 응답하지만 예약 작업이 둘 다 실행 중이 아닙니다")
    return server


def _clear_alerts(inst: Installation) -> None:
    for name in names.ALERT_FILES:
        path = status.plain_child(inst.logs, name)
        if path is not None:
            path.unlink(missing_ok=True)


def start_sequence(inst: Installation, runner: Runner, job_id: str, say: Say) -> dict:
    write_off(inst, "starting", job_id)
    try:
        tasks = _states(runner)
        ready = status.read_ready(inst.port)
        if ready.code == 200 and _state(tasks, names.TASK_SERVER) == "Running":
            try:
                server_api.verify_server(inst, runner)
                already = True
            except server_api.ServerError:
                already = False
            if already:
                say("서버가 이미 정상입니다 — 꺼진·멈춘 예약 작업만 켭니다")
                for name in (names.TASK_SERVER, names.TASK_WATCHDOG):
                    if _state(tasks, name) == "Disabled" and _schtasks(runner, "/Change", "/TN", name, "/ENABLE") != 0:
                        raise PowerError(f"예약 작업({name})을 켜지 못했습니다")
                if _state(_states(runner), names.TASK_WATCHDOG) != "Running":
                    _schtasks(runner, "/Run", "/TN", names.TASK_WATCHDOG)
                _wait_tasks(runner, _running, "예약 작업이 둘 다 실행되지 않습니다")
                server = _confirm_up(inst, runner)
                clear_off(inst)
                return {"already": True, "build_id": server["build_id"], "server_pid": server["pid"]}
        say("[1/4] 남은 이 설치 서버 프로세스 정리")
        clear_processes(inst, runner, say)
        wait_port_free(inst, runner, timeout=3.0)
        say("[2/4] 예약 작업 켜고 시작(Server → Watchdog)")
        for name in (names.TASK_SERVER, names.TASK_WATCHDOG):
            if _schtasks(runner, "/Change", "/TN", name, "/ENABLE") != 0:
                raise PowerError(f"예약 작업({name})을 켜지 못했습니다")
        if _schtasks(runner, "/Run", "/TN", names.TASK_SERVER) != 0:
            raise PowerError("예약 작업(MVHub Server)을 시작하지 못했습니다")
        _wait_tasks(runner, lambda t: _state(t, names.TASK_SERVER) == "Running", "서버 작업이 실행되지 않습니다")
        if _schtasks(runner, "/Run", "/TN", names.TASK_WATCHDOG) != 0:
            raise PowerError("예약 작업(MVHub Watchdog)을 시작하지 못했습니다")
        _wait_tasks(runner, _running, "예약 작업이 둘 다 실행되지 않습니다")
        say(f"[3/4] 서버 응답 기다림(최대 {int(READY_WAIT)}초)")
        deadline = time.monotonic() + READY_WAIT
        while status.read_ready(inst.port).code != 200:
            if time.monotonic() > deadline:
                raise PowerError(f"{int(READY_WAIT)}초 안에 서버가 준비되지 않았습니다 — logs\\server_console.log 를 확인하세요")
            time.sleep(3.0)
        say("[4/4] 확인(서버 신원·예약 작업)")
        server = _confirm_up(inst, runner)
        _clear_alerts(inst)
        clear_off(inst)
        return {"already": False, "build_id": server["build_id"], "server_pid": server["pid"]}
    except Exception:
        write_off(inst, "start_failed", job_id)
        raise


# ---- 자동시작 재등록 ----

def register_snapshot(inst: Installation, runner: Runner) -> dict:
    tasks = task_states(runner) or {}
    snap = {f"task:{n}": f"{_state(tasks, n)} {(tasks.get(n) or {}).get('action', '')}" for n in names.TASKS}
    for name in ("python.txt", "node_dir.txt"):
        try:
            snap[name] = (inst.root / ".mvhub-runtime" / name).read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            snap[name] = "(없음)"
    return snap


def changed_items(before: dict, after: dict) -> list[str]:
    return [key for key in before if before[key] != after.get(key)]


def register_command(inst: Installation) -> tuple[list[str], dict[str, str]]:
    if CMD_SPECIALS & set(str(inst.root)):
        raise PowerError("설치 경로에 cmd 특수 문자가 있어 bat 을 안전하게 부를 수 없습니다 — register_autostart.bat 을 직접 실행하세요")
    env = dict(child_env(inst), MVHUB_SERVER_PYEXE=str(inst.python), CONTENT_HUB_NO_PAUSE="1")
    if inst.port_known:
        env["PORT"] = str(inst.port)
    return [str(windows_dir() / "System32" / "cmd.exe"), "/d", "/c", str(inst.root / "register_autostart.bat")], env


def autostart_work(inst: Installation, runner: Runner, job: SelfJob, job_id: str, say: Say) -> tuple[int, dict]:
    argv, env = register_command(inst)
    before = register_snapshot(inst, runner)
    say("먼저 이 설치 서버를 멈춥니다(등록 bat 의 재시작은 stage 서버를 못 치운다)")
    stop_sequence(inst, runner, job_id, say)
    write_off(inst, "starting", job_id)
    say("register_autostart.bat 실행(예약 작업 3개 다시 만들기 → 서버 시작)")
    code, reaped = run_streamed(job, argv, str(inst.root), env, say, REGISTER_TIMEOUT)
    after = register_snapshot(inst, runner)
    changed = changed_items(before, after)
    extra = {"changed": changed, "reaped": reaped, "backup_note": backup_note(runner)}
    try:
        if code != 0:
            raise PowerError("등록 bat 이 시간 안에 끝나지 않았습니다" if code is None else f"등록 bat 이 실패했습니다(종료 코드 {code})")
        tasks = _states(runner)
        wrong = [n for n in names.TASKS if not _same(task_root((tasks.get(n) or {}).get("action", "")) or "", inst.root)]
        if wrong:
            raise PowerError("다시 만든 예약 작업이 이 설치를 가리키지 않습니다: " + ", ".join(wrong))
        server = _confirm_up(inst, runner)
    except (PowerError, server_api.ServerError) as exc:
        write_off(inst, "start_failed", job_id)
        say(f"실패: {exc}")
        say("바뀐 것: " + (", ".join(changed) if changed else "없음") + " — 수동 복구가 필요하면 SERVER_RECOVERY.md")
        return 1, {**extra, "error": str(exc)[:500]}
    clear_off(inst)
    say(f"완료: 자동시작을 다시 등록했고 서버가 정상입니다(build {server['build_id'][:12]})")
    return 0, {**extra, "build_id": server["build_id"]}


def power_work(inst: Installation, runner: Runner, kind: str, job_id: str, say: Say) -> tuple[int, dict]:
    if kind == "server-stop":
        stop_sequence(inst, runner, job_id, say)
        return 0, {"phase": "stopped", "backup_note": backup_note(runner)}
    if kind == "server-restart":
        stop_sequence(inst, runner, job_id, say)
    result = start_sequence(inst, runner, job_id, say)
    say("완료: 서버가 정상입니다" + (" (이미 켜져 있었음)" if result["already"] else "")
        + f" — build {result['build_id'][:12]}")
    return 0, {**result, "backup_note": backup_note(runner)}
