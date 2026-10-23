"""작업 실행기 진입점: pythonw -I -B <code_root>\\tools\\server_console\\job_main.py --install-root <루트> <작업 ID>.

관리 창과 따로 돈다. 관리 창 코드는 이 파일이 든 트리(루트 또는 관리 창 stage), 기록·Python 은 설치 루트.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))  # -I 라 스크립트 폴더가 경로에 없다 — 이 판의 관리 창 코드만

from server_console import actions, console_stage, install, jobs, names, status  # noqa: E402


def recompute(inst: install.Installation, job_id: str) -> "actions.Plan | actions.Refusal":
    runner = install.default_runner(inst)
    tasks = install.task_states(runner)
    # 권한은 알림만이라(actions.acl_warnings) 실행 직전에는 다시 훑지 않는다.
    return actions.plan_git_update(inst, install.server_task_matches(inst, tasks), status.update_traces(inst), [],
                                   unresolved_jobs=jobs.unresolved_jobs(inst, exclude=job_id))


def _recheck_under_lock(inst: install.Installation, job_id: str) -> list[str]:
    """관리 도구 갱신이 잠금을 잡은 뒤 다시 본다 — 잠금 흔적(git)은 지금 이 실행기 것이라 뺀다."""
    unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
    reasons = [text for kind, text in status.update_traces(inst) if kind != "git"]
    if unresolved is None:
        reasons.append("지난 작업 기록을 확인하지 못했습니다")
    reasons += [f"이전 작업({j[:8]})이 진행 중이거나 결과를 확인하지 않았습니다" for j in unresolved or []]
    return reasons


def _jobs_in_use(inst: install.Installation) -> list[str]:
    roots = []
    for job_id in jobs.unresolved_jobs(inst) or []:
        state = jobs.read_json(jobs.job_dir(inst, job_id) / "state.json") or {}
        if isinstance(state.get("code_root"), str):
            roots.append(state["code_root"])
    ui = jobs.read_json(inst.logs / names.UI_MARK) or {}
    if isinstance(ui.get("code_root"), str) and jobs.process_alive(int(ui.get("pid") or 0), ui.get("created")):
        roots.append(ui["code_root"])
    return roots


def _parse(argv: list[str]) -> tuple[Path | None, str]:
    if len(argv) == 4 and argv[1] == "--install-root":
        return Path(argv[2]), argv[3]
    if len(argv) == 2:  # 1단계 화면이 띄운 실행기(설치 루트 = 이 파일의 루트)
        return None, argv[1]
    raise SystemExit(64)


def main(argv: list[str]) -> int:
    install_root, job_id = _parse(argv)
    if install_root is not None:
        install.configure(install_root)
    inst = install.resolve_installation()
    try:
        job = jobs.job_dir(inst, job_id)
        request = jobs.read_json(job / "request.json") or {}
        kind = request.get("kind")
        if kind == "git-update":
            return jobs.run_job(inst, job_id, lambda: recompute(inst, job_id), before=lambda: status.prepare_runs(inst),
                                observe=lambda prior: status.run_outcome(inst, prior))
        if kind == "tools-update":
            runner = console_stage.default_runner_for(inst)
            return jobs.run_job(
                inst, job_id,
                lambda: actions.plan_tools_update(inst, status.update_traces(inst),
                                                  jobs.unresolved_jobs(inst, exclude=job_id)),
                work=lambda _job, say: console_stage.update_work(
                    inst, runner, lambda: _recheck_under_lock(inst, job_id), lambda: _jobs_in_use(inst), say))
        if kind == "console-rollback":
            def rollback(_job, say):
                params = actions.Plan.from_json(request["plan"]).params
                return console_stage.rollback_work(inst, params["from_sha"], params["to_sha"], say)
            return jobs.run_job(
                inst, job_id,
                lambda: actions.plan_console_rollback(inst, console_stage.read_pointer(inst.root),
                                                      status.update_traces(inst),
                                                      jobs.unresolved_jobs(inst, exclude=job_id)),
                work=rollback)
        jobs.write_json(job / "state.json", {"status": "refused", "reasons": ["알 수 없는 작업입니다"],
                                              "finished_at": time.time()})
        return 2
    except Exception as exc:  # noqa: BLE001 — 결과를 잃지 않게 이유를 남긴다
        try:
            jobs.write_json(jobs.job_dir(inst, job_id) / "state.json",
                             {"status": "runner_error", "error": f"{type(exc).__name__}: {exc}"[:500],
                              "finished_at": time.time()})
        except Exception:  # noqa: BLE001
            pass
        return 70


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
