"""이사 감싸개: python.exe -I -B <코드 트리>\\tools\\server_console\\console_run.py --install-root <루트> <작업 ID>.

실행기가 새 콘솔 창으로 띄운다. git-update.lock(→ 진짜 OUT·백업 복구는 console-db.lock)을 쥔 채 이사 도구를
**이 프로세스 안에서** main() 으로 부른다 — 감싸개가 죽으면 도구도 죽고, 살아 있으면 잠금도 살아 있다(설계 4판).
도구가 띄우는 자식(드릴의 격리 서버 등)은 자기 Job 으로 묶는다. 도구·deploy_fence_check·app.* 는 설치 루트에서만 가져온다.
"""
from __future__ import annotations

import msvcrt
import os
import sys
import time
import traceback
from contextlib import contextmanager, nullcontext
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))  # -I 라 스크립트 폴더가 경로에 없다 — 이 판의 관리 창 코드만

from server_console import actions, console_stage, install, jobs, moves, names, winjob  # noqa: E402

DB_LOCK_WAIT = 30.0
DB_KINDS = ("move-out", "move-restore")  # DB 파일을 바꾸는 것만 관리 창 DB 읽기를 막는다(연습·UNDO 는 아님)


def _say(text: str = "") -> None:
    print(text, flush=True)


@contextmanager
def db_lock(inst: install.Installation):
    """관리 창 DB 읽기와 같은 잠금 — 진행 중 읽기가 끝날 때까지 기다렸다가(최대 30초) 도구가 끝날 때까지 쥔다."""
    handle = (inst.logs / names.DB_LOCK).open("a+b")
    deadline = time.monotonic() + DB_LOCK_WAIT
    while True:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            break
        except OSError:
            if time.monotonic() > deadline:
                handle.close()
                raise RuntimeError("관리 창의 DB 읽기가 끝나지 않아 시작하지 않았습니다(30초)") from None
            time.sleep(0.5)
    try:
        yield
    finally:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            handle.close()


def tool_args(inst: install.Installation, kind: str, params: dict) -> tuple[str, list[str]]:
    data, port = str(params["data_dir"]), str(int(params["port"]))
    if kind == "move-rehearsal":
        return "server_move_easy", ["out", "--purpose", "rehearsal", "--port", port, "--data-dir", data]
    if kind == "move-out":
        return "server_move_easy", ["out", "--purpose", "move", "--port", port, "--data-dir", data]
    if kind == "move-undo":
        return "server_move_easy", ["undo-out", "--data-dir", data]
    from server_console import backup
    files = backup.find_set(inst, params)
    return "server_move", ["import", "--backup-set", str(files["content"]), "--install", "--data-dir", data,
                           "--port", port]


def run_tool(inst: install.Installation, kind: str, params: dict) -> tuple[int, dict]:
    """도구를 이 프로세스 안에서. 정상 반환 코드는 그대로, 그 밖의 끝남은 실패(0 으로 바꾸거나 다시 실행하지 않는다)."""
    tools = (inst.root / "tools").resolve()
    sys.path.insert(0, str(tools))
    name, args = tool_args(inst, kind, params)
    tool = __import__(name)
    # 도구와 그 의존(deploy_fence_check·server_move·app.*)은 설치 루트 것이어야 한다(관리 창 stage 와 섞이지 않게).
    homes = {name: tools, "server_move": tools, "deploy_fence_check": tools, "app": (inst.root / "backend").resolve()}
    for module, home in homes.items():
        loaded = sys.modules.get(module)
        file = getattr(loaded, "__file__", None)
        if loaded is not None and (not file or home not in Path(file).resolve().parents
                                   and Path(file).resolve().parent != home):
            return 1, {"error": f"이사 도구 모듈 {module} 을 설치 루트가 아닌 곳에서 가져왔습니다({file})"}
    before = moves.archives(inst)
    os.chdir(inst.root)
    extra: dict = {}
    try:
        code = tool.main(args)
        code = code if type(code) is int else 1
    except SystemExit as exc:
        code = exc.code if type(exc.code) is int else 1
    except (EOFError, KeyboardInterrupt) as exc:
        code, extra = 1, {"error": "입력이 끊겨 멈췄습니다" if isinstance(exc, EOFError) else "Ctrl+C 로 멈췄습니다"}
    except Exception as exc:  # noqa: BLE001 — 도구 안의 되돌리기는 이미 끝났다(예외가 여기까지 올라왔다)
        traceback.print_exc()
        code, extra = 1, {"error": f"{type(exc).__name__}: {exc}"[:500]}
    if kind == "move-restore":
        extra["archive"] = sorted(moves.archives(inst) - before)  # 이번 실행이 만든 보관 폴더만
    return code, extra


def save_result(job: Path, job_id: str, kind: str, code: int, extra: dict) -> bool:
    try:
        jobs.write_json(job / "result.json", {**extra, "job_id": job_id, "kind": kind, "exit_code": code,
                                              "finished_at": time.time()})
        return True
    except OSError:
        return False


def _wait_enter(text: str) -> None:
    try:
        input(text)
    except (EOFError, KeyboardInterrupt):
        pass


def run(inst: install.Installation, job_id: str) -> int:
    job = jobs.job_dir(inst, job_id)
    request = jobs.read_json(job / "request.json") or {}
    kind = request.get("kind")
    me = os.getpid()
    marker = {"pid": me, "created": jobs.process_created(me), "at": time.time()}
    jobs.write_json(job / "wrapper.json", {**marker, "phase": "starting"})  # ① 잠금·도구보다 먼저
    _say("=" * 60)
    _say(f"  MV Hub 관리 창 — {actions.ACTIONS.get(kind, kind)} (작업 {job_id[:8]})")
    _say("=" * 60)
    if kind not in actions.MOVE_KINDS:
        save_result(job, job_id, str(kind), 2, {"not_started": True, "reasons": ["알 수 없는 작업입니다"]})
        return 2
    runner = install.default_runner(inst)
    saved = True
    try:
        winjob.SelfJob()  # 핸들은 닫지 않는다 — 이 프로세스가 끝날 때 OS 가 닫으며 남은 자식(격리 서버 등)을 끝낸다
        with console_stage.UpdateLock(inst), (db_lock(inst) if kind in DB_KINDS else nullcontext()):
            if (job / "ack.json").exists():  # ③ 그새 [확인했음]으로 정리된 작업이면 도구를 돌리지 않는다
                raise RuntimeError("관리 창에서 이미 정리된 작업입니다")
            confirmed = actions.Plan.from_json(request["plan"])
            current = moves.recompute(inst, job_id, request, runner, keep_trace=lambda t: t[0] != "git")
            if isinstance(current, actions.Refusal):
                raise RuntimeError(" / ".join(current.reasons))
            if not actions.same_target(confirmed, current):
                raise RuntimeError("확인한 대상과 실행 직전 대상이 다릅니다 — 관리 창에서 다시 확인하세요")
            jobs.write_json(job / "wrapper.json", {**marker, "phase": "running"})
            code, extra = run_tool(inst, kind, confirmed.params)  # ④
            saved = save_result(job, job_id, kind, code, extra)  # ⑤
            if not saved:  # 잠금을 쥔 채 사람에게 알린다 — 닫으면 '결과 미확인'
                _say("\n[주의] 결과를 기록하지 못했습니다 — 관리 창에서 상태를 확인하세요.")
                _wait_enter("Enter 를 누르면 잠금을 풀고 창을 닫습니다 ")
    except Exception as exc:  # noqa: BLE001 — 도구를 돌리기 전 거절·잠금 실패
        code = 2
        _say(f"\n  [시작 안 함] {exc}")
        saved = save_result(job, job_id, kind, 2, {"not_started": True, "reasons": [str(exc)[:500]]})
    jobs.write_json(job / "wrapper.json", {**marker, "phase": "done"})
    if saved:
        _say(f"\n완료 — 결과 기록됨(종료 코드 {code}). 이 창은 닫아도 됩니다. 관리 창에서 결과를 확인하세요.")
        _wait_enter("Enter 를 누르면 창을 닫습니다 ")
    return code


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "--install-root":
        return 64
    install.configure(Path(argv[2]))
    return run(install.resolve_installation(), argv[3])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
