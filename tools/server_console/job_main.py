"""작업 실행기 진입점: pythonw -I tools\\server_console\\job_main.py <작업 ID>. 관리 창과 따로 돈다."""
from __future__ import annotations

import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))  # -I 라 스크립트 폴더가 경로에 없다 — 보호된 설치 루트만 넣는다

from server_console import actions, install, jobs, status  # noqa: E402


def recompute(inst: install.Installation, job_id: str) -> "actions.Plan | actions.Refusal":
    runner = install.default_runner(inst)
    tasks = install.task_states(runner)
    # 권한은 알림만이라(actions.acl_warnings) 실행 직전에는 다시 훑지 않는다.
    return actions.plan_git_update(inst, install.server_task_matches(inst, tasks), status.update_traces(inst), [],
                                   unresolved_jobs=jobs.unresolved_jobs(inst, exclude=job_id))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return 64
    inst = install.resolve_installation()
    job_id = argv[1]
    try:
        job = jobs.job_dir(inst, job_id)
        request = jobs.read_json(job / "request.json") or {}
        if request.get("kind") != "git-update":
            jobs.write_json(job / "state.json", {"status": "refused", "reasons": ["알 수 없는 작업입니다"],
                                                  "finished_at": time.time()})
            return 2
        return jobs.run_job(inst, job_id, lambda: recompute(inst, job_id), before=lambda: status.prepare_runs(inst),
                            observe=lambda prior: status.run_outcome(inst, prior))
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
