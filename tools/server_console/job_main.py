"""작업 실행기 진입점: pythonw -I -B <code_root>\\tools\\server_console\\job_main.py --install-root <루트> <작업 ID>.

관리 창과 따로 돈다. 관리 창 코드는 이 파일이 든 트리(루트 또는 관리 창 stage), 기록·Python 은 설치 루트.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))  # -I 라 스크립트 폴더가 경로에 없다 — 이 판의 관리 창 코드만

from server_console import (actions, backup, console_stage, install, jobs, moves, names, power,  # noqa: E402
                            release, server_api, status, winjob)


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


def _stdin():
    """pythonw 도 파이프를 넘겨받으면 표준 입력이 생긴다. 없으면 0번을 직접 연다(없으면 OSError)."""
    return sys.stdin.buffer if sys.stdin is not None else open(0, "rb")  # noqa: SIM115 — read_token 이 닫는다


def take_token(inst: install.Installation, job_id: str, request: dict) -> str | None:
    """인증 작업의 토큰을 먼저 받는다 — 받기 전에는 업무 데이터를 건드리지 않는다. 못 받으면 runner_error 를 남기고 None."""
    try:
        token = jobs.read_token(_stdin())
    except OSError:
        token = None
    if token is None:
        jobs.write_json(jobs.job_dir(inst, job_id) / "state.json",
                        {"status": "runner_error", "error": "로그인 정보를 받지 못했습니다 — 다시 로그인한 뒤 시작하세요",
                         "finished_at": time.time()})
        jobs.record_action(inst, job_id, request, "runner_error")
    return token


def run_intake(inst: install.Installation, job_id: str, request: dict, token: str) -> int:
    """생성 접수 바꾸기: 서버를 다시 확인하고 지금 값을 다시 읽어 확인 대상과 비교한 뒤 PUT → 다시 읽어 확인."""
    params = actions.Plan.from_json(request["plan"]).params
    want = params.get("paused")
    runner = install.default_runner(inst)

    def recompute() -> "actions.Plan | actions.Refusal":
        try:
            server = server_api.verify_server(inst, runner)
            return actions.plan_intake_set(inst, server, server_api.read_intake(server, token), want,
                                           moving=jobs.move_active(inst))
        except server_api.ServerError as exc:
            return actions.Refusal((str(exc),))

    def apply(_job, say) -> tuple[int, dict]:
        say(f"생성 접수를 '{'중지' if want else '가능'}'으로 바꿉니다")
        try:
            after = server_api.set_intake(params["server"], token, want)
        except server_api.ServerError as exc:
            say(f"실패: {exc}")
            return 1, {"error": str(exc)[:500], "auth_expired": isinstance(exc, server_api.AuthExpired)}
        say(f"완료: 서버 값 = {'중지' if after else '가능'}(다시 읽어 확인)")
        return 0, {"intake": {"paused": after}}

    return jobs.run_job(inst, job_id, recompute, work=apply)


def run_backup(inst: install.Installation, job_id: str, request: dict) -> int:
    """백업 위치 저장(시험 복사)·지금 복사: 화면이 본 위치 지문·예약 작업 조건을 다시 확인한 뒤 실행."""
    kind = request["kind"]
    params = actions.Plan.from_json(request["plan"]).params
    runner = install.default_runner(inst)

    def recompute() -> "actions.Plan | actions.Refusal":
        view = backup.read_view(inst, runner, with_sets=False)
        unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
        if kind == "backup-save":
            return actions.plan_backup_save(inst, view, str(params.get("target") or ""), unresolved)
        return actions.plan_backup_run(inst, view, unresolved)

    work = backup.save_work if kind == "backup-save" else backup.run_work
    return jobs.run_job(inst, job_id, recompute, work=lambda _job, say: work(inst, runner, params, say))


def run_release(inst: install.Installation, job_id: str, request: dict, token: str) -> int:
    """릴리스 배포·이어서 하기·재공지·해제: 서버를 다시 확인하고 공지·표지를 다시 읽어 확인 대상과 비교한 뒤 실행."""
    kind = request["kind"]
    params = actions.Plan.from_json(request["plan"]).params
    runner = install.default_runner(inst)
    job = jobs.job_dir(inst, job_id)

    def plan_item(item: dict, server: dict, source: str, unresolved, read: dict | None = None):
        notice = (release.find_delete_notice(server, token, item) if kind == "release-delete"
                  else release.find_notice(server, token, item["sha256"]))
        if kind == "release-delete":
            # 정확한 파일 지문은 실제 삭제의 발행 잠금 안에서 다시 비교한다.
            fields = {key: item[key] for key in (*release.FIELDS, "sidecars")}
            return actions.plan_release_delete(inst, server, source, read or {}, fields, notice, unresolved)
        if kind == "release-deploy":
            fields = {key: item[key] for key in release.FIELDS}
            return actions.plan_release_deploy(inst, server, source, read or {}, fields, notice, unresolved)
        return actions.plan_notice_action(inst, kind, server, notice, item["sha256"], unresolved)

    def fresh_plan(item: dict | None = None) -> "actions.Plan | actions.Refusal":
        server = server_api.verify_server(inst, runner)
        source = release.release_source(inst)
        unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
        read = None
        if kind in ("release-delete", "release-deploy"):
            read = release.helper(inst, job / "scratch", source, "read")
            if not read.get("ok") or read.get("packages_error") or read.get("overview_error"):
                return actions.Refusal((str(read.get("error") or read.get("packages_error")
                                            or read.get("overview_error") or "릴리스 폴더를 읽지 못했습니다"),))
        if item is not None:
            return plan_item(item, server, source, unresolved, read)
        if "items" in params:
            if not isinstance(params["items"], list) or not params["items"]:
                return actions.Refusal(("일괄 처리 대상이 올바르지 않습니다",))
            plans = []
            for selected in params["items"]:
                current = plan_item(selected, server, source, unresolved, read)
                if isinstance(current, actions.Refusal):
                    return current
                plans.append(current)
            return actions.plan_release_batch(inst, kind, plans)
        return plan_item(params, server, source, unresolved, read)

    def recompute() -> "actions.Plan | actions.Refusal":
        try:
            if kind == "release-resume":
                server = server_api.verify_server(inst, runner)
                source = release.release_source(inst)
                unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
                from_params, from_state, intent = release.resume_source(inst, params["from_job"])
                return actions.plan_release_resume(inst, server, source, params["from_job"], from_params, from_state,
                                                   intent, unresolved, release.resume_chain(inst, params["from_job"]))
            return fresh_plan()
        except (server_api.ServerError, release.ReleaseError) as exc:
            return actions.Refusal((str(exc),))
        except (KeyError, TypeError, ValueError):
            return actions.Refusal(("릴리스 작업의 확인 대상 형식이 올바르지 않습니다",))

    def work(_job, say) -> tuple[int, dict]:
        if "items" in params:
            def one(item: dict) -> tuple[int, dict]:
                try:
                    current = fresh_plan(item)
                except (server_api.ServerError, release.ReleaseError) as exc:
                    return 1, {"error": str(exc)[:500], "auth_expired": isinstance(exc, server_api.AuthExpired)}
                expected = actions.Plan(kind, str(inst.root), "server", "", (), params=item)
                if isinstance(current, actions.Refusal):
                    return 1, {"error": " / ".join(current.reasons)}
                if not actions.same_target(expected, current):
                    return 1, {"error": "확인한 대상이 바뀌었습니다 — 남은 항목을 시작하지 않습니다"}
                return (release.delete_work(inst, job, item, token, say) if kind == "release-delete"
                        else release.remove_work(item, token, say))
            return release.batch_work(job, params["items"], one, say)
        if kind == "release-deploy":
            return release.deploy_work(inst, job, params, token, say)
        if kind == "release-resume":
            _params, _state, intent = release.resume_source(inst, params["from_job"])
            code, extra = release.resume_work(inst, job, params, intent, token, say)
            if code == 0:  # 서버·NAS 를 다시 읽어 끝냈다 — 멈춘 배포와 앞선 재개 시도가 새 작업을 막지 않게
                release.settle_chain(inst, params["from_job"], release.resume_chain(inst, params["from_job"]))
            return code, extra
        if kind == "release-announce":
            return release.announce_work(params, token, say)
        if kind == "release-delete":
            return release.delete_work(inst, job, params, token, say)
        return release.remove_work(params, token, say)

    return jobs.run_job(inst, job_id, recompute, work=work)


def run_address(inst: install.Installation, job_id: str, request: dict) -> int:
    """주소 공지: 화면이 본 공지 판·릴리스 폴더를 다시 확인한 뒤 판+1 로 쓴다(로그인 없음 — NAS 쓰기 권한이 경계)."""
    params = actions.Plan.from_json(request["plan"]).params
    job = jobs.job_dir(inst, job_id)

    def recompute() -> "actions.Plan | actions.Refusal":
        source = release.release_source(inst)
        return actions.plan_address_notice(inst, source, release.read_location(inst, job / "scratch", source),
                                           str(params.get("url") or ""), str(params.get("name") or ""),
                                           jobs.unresolved_jobs(inst, exclude=job_id))

    return jobs.run_job(inst, job_id, recompute, work=lambda _job, say: release.address_work(inst, job, params, say))


def _refuse(inst: install.Installation, job_id: str, request: dict, reason: str) -> int:
    jobs.write_json(jobs.job_dir(inst, job_id) / "state.json",
                    {"status": "refused", "reasons": [reason], "finished_at": time.time()})
    jobs.record_action(inst, job_id, request, "refused")
    return 2


def run_server_control(inst: install.Installation, job_id: str, request: dict) -> int:
    """끄기·켜기·다시 켜기·자동시작 재등록·백업 확인: 먼저 자기 자신을 Job 에 넣고(실패하면 시작 안 함) 그 뒤에만 자식을
    띄운다. 서버 제어는 git-update.lock 을 쥔 채 잠금 안에서 다시 확인한다(설계 3~5판)."""
    kind = request["kind"]
    params = actions.Plan.from_json(request["plan"]).params
    runner = install.default_runner(inst)
    try:
        job_obj = winjob.SelfJob()
    except winjob.JobError as exc:
        return _refuse(inst, job_id, request, f"{exc} — 시작하지 않았습니다")

    def recompute(keep=lambda trace: True) -> "actions.Plan | actions.Refusal":
        unresolved = jobs.unresolved_jobs(inst, exclude=job_id)
        if kind == "backup-drill":
            return actions.plan_drill(inst, dict(params), unresolved)
        tasks = install.task_states(runner)
        traces = [trace for trace in status.update_traces(inst) if keep(trace)]
        if kind == "server-autostart":
            return actions.plan_autostart(inst, tasks, traces, unresolved)
        return actions.plan_power(inst, kind, tasks, traces, unresolved)

    def work(job: Path, say) -> tuple[int, dict]:
        if kind == "backup-drill":
            return backup.drill_work(inst, runner, job_obj, job, params, say)
        with console_stage.UpdateLock(inst):
            again = recompute(keep=lambda trace: trace[0] != "git")  # 잠금 흔적(git)은 지금 이 실행기 것
            confirmed = actions.Plan.from_json(request["plan"])
            if isinstance(again, actions.Refusal) or not actions.same_target(confirmed, again):
                reasons = again.reasons if isinstance(again, actions.Refusal) else ("대상이 그새 바뀌었습니다",)
                raise power.PowerError("시작하지 않음: " + " / ".join(reasons))
            if kind == "server-autostart":
                return power.autostart_work(inst, runner, job_obj, job_id, say)
            return power.power_work(inst, runner, kind, job_id, say)

    return jobs.run_job(inst, job_id, recompute, work=work)


def run_move(inst: install.Installation, job_id: str, request: dict) -> int:
    """이사 계열: 실행기는 Job·잠금을 쓰지 않는다(감싸개가 쥔다) — 감싸개를 새 콘솔 창으로 띄우고 기다린다."""
    runner = install.default_runner(inst)
    return jobs.run_job(inst, job_id, lambda: moves.recompute(inst, job_id, request, runner),
                        work=lambda _job, say: moves.launch_and_wait(inst, job_id, say))


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
    server_api.bind(inst, install.default_runner(inst))  # 토큰을 실은 요청은 보내기 바로 전에 서버를 다시 확인한다
    request: dict = {}
    try:
        job = jobs.job_dir(inst, job_id)
        request = jobs.read_json(job / "request.json") or {}
        kind = request.get("kind")
        if kind in actions.AUTH_KINDS:
            token = take_token(inst, job_id, request)  # 받기 전에는 아무것도 하지 않는다
            if token is None:
                return 70
            if kind == "intake-set":
                return run_intake(inst, job_id, request, token)
            return run_release(inst, job_id, request, token)
        if kind == "address-notice":
            return run_address(inst, job_id, request)
        if kind in actions.POWER_KINDS or kind == "backup-drill":
            return run_server_control(inst, job_id, request)
        if kind in actions.MOVE_KINDS:
            return run_move(inst, job_id, request)
        if kind in ("backup-save", "backup-run"):
            return run_backup(inst, job_id, request)
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
        jobs.record_action(inst, job_id, request, "refused")
        return 2
    except Exception as exc:  # noqa: BLE001 — 결과를 잃지 않게 이유를 남긴다
        try:
            jobs.write_json(jobs.job_dir(inst, job_id) / "state.json",
                             {"status": "runner_error", "error": f"{type(exc).__name__}: {exc}"[:500],
                              "finished_at": time.time()})
            jobs.record_action(inst, job_id, request, "runner_error")
        except Exception:  # noqa: BLE001
            pass
        return 70


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
