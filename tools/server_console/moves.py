"""서버 이사(설계 D 1~5판) — 실행기는 감싸개(console_run.py)를 새 콘솔 창으로 띄우고 결과를 기다리기만 한다.
잠금·도구 실행은 감싸개가 한다(실행기가 죽어도 보호는 감싸개와 같은 수명). 화면 판정 셋은 view() 가 따로 낸다.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable

from . import actions, backup, install, jobs, names, power, status

WRAPPER = install.CODE_ROOT / "tools" / "server_console" / "console_run.py"
CREATE_NEW_CONSOLE = 0x00000010


def recompute(inst: install.Installation, job_id: str, request: dict, runner: install.Runner,
              keep_trace: Callable[[tuple[str, str]], bool] = lambda trace: True) -> "actions.Plan | actions.Refusal":
    """실행기·감싸개가 실행 직전에 다시 세우는 계획(화면과 같은 함수). keep_trace 로 자기 git 잠금 흔적을 뺀다."""
    kind = request["kind"]
    params = actions.Plan.from_json(request["plan"]).params
    tasks = install.task_states(runner)
    traces = [trace for trace in status.update_traces(inst) if keep_trace(trace)]
    unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
    selection = stopped = None
    if kind == "move-restore":
        selection = {key: params.get(key) for key in ("root", "folder", "stamp")}
        stopped = power.stopped_problems(inst, runner)
    return actions.plan_move(inst, kind, tasks, traces, unresolved, selection, stopped)


def launch_and_wait(inst: install.Installation, job_id: str, say: Callable[[str], None]) -> tuple[int, dict]:
    """실행기 작업: 감싸개를 새 콘솔 창으로(사람이 그 창의 질문에 답한다) 띄우고 끝날 때까지 기다린다."""
    job = jobs.job_dir(inst, job_id)
    python = inst.python.with_name("python.exe") if inst.python and inst.python.with_name("python.exe").is_file() \
        else inst.python  # pythonw 는 콘솔 입출력이 없다
    argv = [str(python), "-I", "-B", str(WRAPPER), "--install-root", str(inst.root), job_id]
    child = subprocess.Popen(argv, cwd=str(inst.root), env=dict(install.child_env(inst), PYTHONDONTWRITEBYTECODE="1"),
                             creationflags=CREATE_NEW_CONSOLE)
    jobs.write_json(job / "launch.json", {"pid": child.pid, "created": jobs.process_created(child.pid)})
    say("새 콘솔 창에서 진행합니다 — 질문은 그 창에서 답하세요. 이 화면은 결과를 기다립니다")
    child.wait()
    result = jobs.move_result(job, job_id)
    if result is None:  # '결과 미확인'(종료 코드 3) — 사람이 [확인했음] 하기 전까지 새 작업을 막는다(독립 리뷰 P1)
        say("결과 미확인: 감싸개가 결과를 남기지 않고 끝났습니다 — 이사 화면의 상태를 확인하세요")
        return jobs.UNCONFIRMED, {"move": "unconfirmed", "error": "감싸개가 결과를 남기지 않고 끝났습니다"}
    return int(result["exit_code"]), {k: v for k, v in result.items() if k not in ("exit_code", "job_id")}


def archives(inst: install.Installation) -> set[str]:
    """db\\_before_move_<시각>\\ 보관 폴더 이름(복구가 지금 DB 를 옮겨 두는 곳)."""
    db = inst.data_dir / "db"
    try:
        return {entry.name for entry in os.scandir(db) if entry.name.startswith("_before_move_") and entry.is_dir()}
    except OSError:
        return set()


def view(inst: install.Installation) -> dict:
    """화면 판정 셋(설계 2판): 지금 실행 중 / 마지막 이사 결과 / (서버 상태는 상태 화면 판정을 그대로 쓴다)."""
    records = power.move_records(inst)
    running = None
    last = None
    for job_id in jobs.recent_jobs(inst, limit=20):
        state = jobs.read_job(inst, job_id)
        if state.get("kind") not in actions.MOVE_KINDS:
            continue
        if state.get("status") in ("starting", "checking", "running") and running is None:
            running = state
        elif last is None:
            last = state
    out_state, out = records["out"]
    in_state, in_value = records["in"]
    if records["journal"]:
        record = ("bad", f"설치 기록이 남아 있습니다(db\\{names.MOVE_JOURNAL}) — 설치 중이거나 되돌리기 실패, 수동 확인")
    elif out_state == "bad" or in_state == "bad":
        record = ("bad", "이사 기록을 읽지 못했습니다 — 확인 불가")
    elif out_state == "ok" and out.get("phase") in names.MOVE_OUT_ACTIVE:
        record = ("out", f"이 PC 는 내보내기 단계 '{out.get('phase')}' 입니다 — 새 PC 가 이 IP 를 받기 전까지 [되돌리기] 가능")
    elif in_state == "ok" and in_value.get("phase") != "done":
        record = ("in", f"새 서버 들여오기가 '{in_value.get('phase')}' 에서 멈췄습니다 — server_move_IN.bat 을 마저")
    else:
        latest = max(archives(inst), default="")
        record = ("none", "진행 중인 이사 기록 없음" + (f" · 마지막 복구 보관 폴더 {latest}" if latest else ""))
    return {"running": running, "last": last, "record": record,
            "out_phase": out.get("phase") if out_state == "ok" else None}
