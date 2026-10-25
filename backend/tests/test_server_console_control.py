"""서버 관리 창 마무리 B·D(설계 1~5판): 켜기·끄기·재등록·드릴·이사 감싸개·DB 잠금·Job·작업 판정.

실제 예약 작업·서버(8010)는 건드리지 않는다 — 예약 작업·프로세스 목록·포트는 가짜로 바꿔 끼우고, Job·잠금·감싸개는
별도 Python 프로세스로 실제로 돌려 본다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows server console")

from server_console import actions, backup, install, jobs, moves, names, power, server_api, status  # noqa: E402

PY = Path(sys.executable)
BUILD = "a" * 32
OTHER_BUILD = "b" * 32


def make_inst(tmp_path: Path, **overrides) -> install.Installation:
    root = tmp_path / "root"
    (root / "logs").mkdir(parents=True, exist_ok=True)
    data = root / "backend" / "data"
    (data / "db").mkdir(parents=True, exist_ok=True)
    values = dict(root=root, data_dir=data, log_dir=data / "logs", content_db=data / "db" / "content_hub.db",
                  port=8010, port_known=False, python=PY, problems=())
    values.update(overrides)
    return install.Installation(**values)


def _action(inst, mode):
    return f'cmd /c call "{inst.root}\\task_launch.bat" {mode}'


def tasks_of(inst, server="Running", watchdog="Running", backup_state="Ready", root=None):
    root = root or inst.root
    fake = install.Installation(**{**inst.__dict__, "root": Path(root)})
    return {names.TASK_SERVER: {"state": server, "action": _action(fake, "server")},
            names.TASK_WATCHDOG: {"state": watchdog, "action": _action(fake, "watchdog")},
            names.TASK_BACKUP: {"state": backup_state, "action": _action(fake, "backup")}}


def _proc(pid, script, exe=PY, created=1000):
    return (pid, created, str(exe), f'"{exe}" "{script}" --x')


# ---------- 생사 판정 셋·DB 잠금 ----------

def test_process_state_tells_alive_gone_and_reuse():
    me = os.getpid()
    assert jobs.process_state(me, jobs.process_created(me)) == "alive"
    assert jobs.process_state(me, None) == "alive"
    assert jobs.process_state(me, 123) == "gone"  # 같은 PID 의 다른 프로세스(재사용)
    child = subprocess.Popen([str(PY), "-c", "pass"])
    created = jobs.process_created(child.pid)
    child.wait()
    assert jobs.process_state(child.pid, created) == "gone"
    assert jobs.process_state(0, None) == "unknown" and jobs.process_state(-5, None) == "unknown"


def test_db_read_lock_excludes_a_second_holder_and_inspect_reports_busy(tmp_path):
    inst = make_inst(tmp_path)
    with status.db_read_lock(inst):
        with pytest.raises(status.DbBusy):
            with status.db_read_lock(inst):
                pass
        intake, why = status.inspect_intake(inst)
        assert intake is None and "이사" in why
        from server_console import activity
        with pytest.raises(status.DbBusy):
            activity.read_activity(inst)
    with status.db_read_lock(inst):  # 풀린 뒤에는 다시 잡힌다
        pass


# ---------- 이사 기록 허용표·공통 거절 ----------

def _out_state(inst, phase, **extra):
    tasks = {name: {"exists": True, "enabled": True, "running": True} for name in names.TASKS}
    value = {"content_db": str(inst.content_db), "port": inst.port, "pause_original": None, "was_ready": True,
             "tasks": tasks, "phase": phase, **extra}
    (inst.data_dir / names.MOVE_OUT_STATE).write_text(json.dumps(value), encoding="utf-8")


@pytest.mark.parametrize("phase,undo_ok,others_ok", [
    (None, False, True), ("undone", False, True), ("prepared", True, False), ("paused", True, False),
    ("stopped", True, False), ("exported", True, False), ("strange", False, False),
])
def test_move_table_allows_undo_only_for_an_unfinished_out(tmp_path, phase, undo_ok, others_ok):
    inst = make_inst(tmp_path)
    if phase:
        _out_state(inst, phase)
    assert (power.move_refusals(inst, "move-undo") == []) is undo_ok
    for kind in ("server-start", "server-stop", "move-out", "move-restore", "move-rehearsal"):
        assert (power.move_refusals(inst, kind) == []) is others_ok


def test_move_table_refuses_broken_or_foreign_records(tmp_path):
    inst = make_inst(tmp_path)
    _out_state(inst, "exported", port=9999)
    assert "대상과 다릅니다" in power.move_refusals(inst, "move-undo")[0]
    _out_state(inst, "exported", content_db="E:\\other\\content_hub.db")
    assert "대상과 다릅니다" in power.move_refusals(inst, "move-undo")[0]
    _out_state(inst, "exported", tasks={})
    assert "형식" in power.move_refusals(inst, "move-undo")[0]
    (inst.data_dir / names.MOVE_OUT_STATE).write_text("{broken", encoding="utf-8")
    assert power.move_refusals(inst, "server-start") and power.move_refusals(inst, "move-undo")
    (inst.data_dir / names.MOVE_OUT_STATE).unlink()
    (inst.data_dir / names.MOVE_IN_STATE).write_text(json.dumps({"phase": "installed"}), encoding="utf-8")
    assert "들여오기" in power.move_refusals(inst, "server-start")[0]
    (inst.data_dir / names.MOVE_IN_STATE).write_text(json.dumps({"phase": "done"}), encoding="utf-8")
    assert power.move_refusals(inst, "server-start") == []
    (inst.data_dir / "db" / names.MOVE_JOURNAL).write_text("{}", encoding="utf-8")
    assert "설치 기록" in power.move_refusals(inst, "server-start")[0]


def test_common_refusals_check_every_task_install_and_tls(tmp_path):
    inst = make_inst(tmp_path)
    good = tasks_of(inst)
    assert power.common_refusals(inst, "server-stop", good, [], []) == []
    mixed = {**good, names.TASK_WATCHDOG: tasks_of(inst, root="E:\\other")[names.TASK_WATCHDOG]}
    assert "다른 설치" in power.common_refusals(inst, "server-stop", mixed, [], [])[0]
    missing = {**good, names.TASK_SERVER: {"state": "Missing", "action": ""}}
    assert power.common_refusals(inst, "server-start", missing, [], [])
    assert power.common_refusals(inst, "server-autostart", missing, [], []) == []  # 고치는 동작은 '없음'을 허용
    assert power.common_refusals(inst, "server-stop", None, [], [])
    assert power.common_refusals(inst, "server-stop", good, [("git", "x")], ["c" * 32])
    tls = make_inst(tmp_path, tls=True)
    assert "https" in power.common_refusals(tls, "server-stop", good, [], [])[0]


# ---------- 프로세스 판별 ----------

def _stage(inst, build):
    serve = inst.logs / "server-stages" / build / "backend" / "serve.py"
    serve.parent.mkdir(parents=True, exist_ok=True)
    serve.write_text("", encoding="utf-8")
    return serve


def test_classify_finds_this_install_by_exact_script_and_python(tmp_path):
    inst = make_inst(tmp_path)
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": BUILD, "python": str(PY)}), encoding="utf-8")
    current, other = _stage(inst, BUILD), _stage(inst, OTHER_BUILD)
    tools = inst.root / "tools"
    procs = [_proc(1, tools / "server_supervisor.py"), _proc(2, tools / "server_watchdog.py"),
             _proc(3, current), _proc(4, tools / "other.py"), _proc(5, "E:\\elsewhere\\tools\\server_supervisor.py"),
             (6, 1, str(PY), f'"{PY}" "x" "{tools / "server_supervisor.py"}"')]  # 인자로만 든 경로는 아니다
    ours, others = power.classify(inst, procs)
    assert [(p[0], role) for p, role in ours] == [(1, "supervisor"), (2, "watchdog"), (3, "serve")]
    assert others == []
    ours, others = power.classify(inst, procs + [_proc(7, other)])
    assert len(others) == 1 and "PID 7" in others[0]  # 다른 build 의 serve.py 는 자동으로 끄지 않는다
    ours, others = power.classify(inst, [_proc(8, tools / "server_watchdog.py", exe="C:\\Other\\python.exe")])
    assert ours == [] and "등록 Python" in others[0]


# ---------- 끄기·켜기 순서(가짜 예약 작업·프로세스·포트) ----------

class FakeServer:
    def __init__(self, inst, monkeypatch, server="Running", watchdog="Running", running=True, ready=True):
        self.inst = inst
        self.state = {names.TASK_SERVER: server, names.TASK_WATCHDOG: watchdog, names.TASK_BACKUP: "Ready"}
        tools = inst.root / "tools"
        self.supervisor = _proc(11, tools / "server_supervisor.py")
        self.watchdog = _proc(12, tools / "server_watchdog.py")
        self.serve = _proc(13, inst.root / "backend" / "serve.py")
        self.procs = [self.supervisor, self.watchdog, self.serve] if running else []
        self.ready = ready and running
        self.calls, self.killed = [], []
        self.verify_ok = True
        self.reuse = False  # 짝수 번째 읽기(끝내기 직전 다시 읽기)마다 생성 시각을 바꿔 PID 재사용을 흉내 낸다
        self.reads = 0
        self.fail_disable: set[str] = set()
        for name, value in (("task_states", self.tasks), ("_schtasks", self.schtasks), ("_taskkill", self.taskkill),
                            ("python_processes", self.processes)):
            monkeypatch.setattr(power, name, value)
        monkeypatch.setattr(server_api, "listeners", lambda port, runner: [self.serve] if self.serve in self.procs else [])
        monkeypatch.setattr(server_api, "verify_server", self.verify)
        monkeypatch.setattr(status, "read_ready", lambda port, timeout=3.0, tls=False: status.Ready(
            200 if self.ready else None, {"status": "ready"} if self.ready else None, "" if self.ready else "refused"))
        monkeypatch.setattr(power.time, "sleep", lambda s: None)
        monkeypatch.setattr(power, "TASK_WAIT", 0.5)
        monkeypatch.setattr(power, "PORT_WAIT", 0.5)
        monkeypatch.setattr(power, "READY_WAIT", 0.5)

    def tasks(self, runner):
        return {n: {"state": s, "action": _action(self.inst, n.split()[-1].lower().replace("backupcopy", "backup"))}
                for n, s in self.state.items()}

    def schtasks(self, runner, *args):
        self.calls.append(args)
        verb, name = args[0], args[2]
        if verb == "/Change":
            if args[3] == "/DISABLE" and name in self.fail_disable:
                return 1
            self.state[name] = "Disabled" if args[3] == "/DISABLE" else "Ready"
        elif verb == "/End" and self.state[name] == "Running":
            self.state[name] = "Ready"
        elif verb == "/Run":
            if self.state[name] == "Disabled":
                return 1
            self.state[name] = "Running"
            if name == names.TASK_SERVER:
                self.procs += [self.supervisor, self.serve]
                self.ready = True
            else:
                self.procs.append(self.watchdog)
        return 0

    def taskkill(self, runner, pid):
        self.killed.append(pid)
        tree = {11: (11, 13)}.get(pid, (pid,))
        self.procs = [p for p in self.procs if p[0] not in tree]
        if 13 in tree:
            self.ready = False

    def processes(self, runner):
        self.reads += 1
        if self.reuse and self.reads % 2 == 0:
            return [(p[0], p[1] + 1, *p[2:]) for p in self.procs]  # 같은 PID, 다른 프로세스
        return list(self.procs)

    def verify(self, inst, runner):
        if not (self.verify_ok and self.serve in self.procs):
            raise server_api.ServerError("서버 확인 실패")
        return {"port": 8010, "pid": 13, "created": 1000, "nonce": "n", "build_id": "legacy-source"}


def test_stop_disables_first_ends_then_clears_only_this_install(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    stranger = _proc(40, inst.root / "tools" / "other.py")
    fake.procs.append(stranger)
    fake.state[names.TASK_SERVER] = "Ready"  # 작업은 멈췄는데 supervisor·serve 가 떠돌이로 남은 경우
    lines: list[str] = []
    power.stop_sequence(inst, None, "j" * 32, lines.append)
    assert fake.calls[:4] == [("/Change", "/TN", names.TASK_WATCHDOG, "/DISABLE"),
                              ("/Change", "/TN", names.TASK_SERVER, "/DISABLE"),
                              ("/End", "/TN", names.TASK_WATCHDOG), ("/End", "/TN", names.TASK_SERVER)]
    assert {11, 12} <= set(fake.killed) and 40 not in fake.killed and stranger in fake.procs
    assert power.read_off(inst)[1]["phase"] == "stopped"
    assert fake.state[names.TASK_BACKUP] == "Ready"  # NAS 복사 예약은 건드리지 않는다


def test_stop_refuses_to_guess_when_another_stage_server_is_left(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    fake.procs.append(_proc(50, _stage(inst, OTHER_BUILD)))
    with pytest.raises(power.PowerError, match="정지 확인 불가"):
        power.stop_sequence(inst, None, "j" * 32, lambda line: None)
    assert power.read_off(inst)[1]["phase"] == "stopping" and 50 not in fake.killed


def test_stop_kills_current_stage_server_even_if_it_is_not_listening(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": BUILD, "python": str(PY)}), encoding="utf-8")
    fake = FakeServer(inst, monkeypatch, running=False)
    starting = _proc(60, _stage(inst, BUILD))  # 아직 포트를 안 연 stage serve.py
    fake.procs.append(starting)
    power.stop_sequence(inst, None, "j" * 32, lambda line: None)
    assert fake.killed == [60]


def test_reused_pid_is_not_killed(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    fake.reuse = True  # 끝내기 직전 다시 읽으면 생성 시각이 다르다
    with pytest.raises(power.PowerError, match="끝나지 않습니다"):
        power.clear_processes(inst, None, lambda line: None, timeout=0.3)
    assert fake.killed == []


def test_start_turns_both_on_and_clears_the_record_only_after_identity(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch, server="Disabled", watchdog="Disabled", running=False)
    power.write_off(inst, "stopped", "o" * 32)
    alert = inst.logs / "server_ALERT.txt"
    alert.write_text("old", encoding="utf-8")
    result = power.start_sequence(inst, None, "j" * 32, lambda line: None)
    assert result["already"] is False and fake.state[names.TASK_SERVER] == fake.state[names.TASK_WATCHDOG] == "Running"
    assert power.read_off(inst) == ("missing", None) and not alert.exists()
    order = [c[:3] for c in fake.calls]
    assert order.index(("/Run", "/TN", names.TASK_SERVER)) < order.index(("/Run", "/TN", names.TASK_WATCHDOG))


def test_start_when_already_up_only_turns_on_the_missing_watchdog(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch, watchdog="Disabled")
    fake.procs.remove(fake.watchdog)
    result = power.start_sequence(inst, None, "j" * 32, lambda line: None)
    assert result["already"] is True and fake.killed == [] and fake.state[names.TASK_WATCHDOG] == "Running"


def test_start_failure_keeps_a_start_failed_record(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch, server="Disabled", watchdog="Disabled", running=False)
    fake.verify_ok = False
    with pytest.raises(server_api.ServerError):
        power.start_sequence(inst, None, "j" * 32, lambda line: None)
    assert power.read_off(inst)[1]["phase"] == "start_failed"


def test_restart_is_stop_then_start_in_one_job(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    code, extra = power.power_work(inst, None, "server-restart", "j" * 32, lambda line: None)
    assert code == 0 and extra["already"] is False and 11 in fake.killed
    assert power.read_off(inst) == ("missing", None)


def test_autostart_reports_what_changed_when_it_fails(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    snaps = iter([{"task:a": "1", "python.txt": "p"}, {"task:a": "2", "python.txt": "p"}])
    monkeypatch.setattr(power, "register_snapshot", lambda inst, runner: next(snaps))
    monkeypatch.setattr(power, "run_streamed", lambda *a, **k: (1, True))
    code, extra = power.autostart_work(inst, None, None, "j" * 32, lambda line: None)
    assert code == 1 and extra["changed"] == ["task:a"] and "종료 코드 1" in extra["error"]
    assert power.read_off(inst)[1]["phase"] == "start_failed"


def test_autostart_failure_in_the_stop_step_still_reports_changes(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    fake.fail_disable = {names.TASK_SERVER}  # Watchdog 은 이미 껐는데 Server 끄기가 실패
    snaps = iter([{"task:MVHub Watchdog": "Running"}, {"task:MVHub Watchdog": "Disabled"}])
    monkeypatch.setattr(power, "register_snapshot", lambda inst, runner: next(snaps))
    code, extra = power.autostart_work(inst, None, None, "j" * 32, lambda line: None)
    assert code == 1 and extra["stage"] == "끄기" and extra["changed"] == ["task:MVHub Watchdog"]
    assert power.read_off(inst)[1]["phase"] == "stopping"  # 끄기 단계 실패는 그 단계 그대로
    from server_console import ui
    unknown = ui.area_result_text({"status": "finished", "kind": "server-autostart", "exit_code": 1,
                                   "changed": None, "stage": "확인", "error": "e"})[0]
    assert "확인하지 못함" in unknown and "확인 단계" in unknown


def test_autostart_success_requires_system_tasks(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    monkeypatch.setattr(power, "register_snapshot", lambda inst, runner: {"task:x": "same"})

    def bat(*args, **kwargs):  # 등록 bat 이 작업을 다시 만들고 서버를 켠 것처럼
        for name in (names.TASK_SERVER, names.TASK_WATCHDOG):
            fake.state[name] = "Running"
        fake.procs = [fake.supervisor, fake.watchdog, fake.serve]
        return 0, True
    monkeypatch.setattr(power, "run_streamed", bat)
    users = {name: power.SYSTEM_SID for name in names.TASKS}
    monkeypatch.setattr(power, "task_users", lambda runner: dict(users))
    code, extra = power.autostart_work(inst, None, None, "j" * 32, lambda line: None)
    assert code == 0 and extra["changed"] == [] and power.read_off(inst) == ("missing", None)
    users[names.TASK_BACKUP] = "S-1-5-21-1-2-3-1001"
    code, extra = power.autostart_work(inst, None, None, "k" * 32, lambda line: None)
    assert code == 1 and "SYSTEM" in extra["error"] and extra["stage"] == "확인"
    monkeypatch.setattr(power, "task_users", lambda runner: None)  # 계정을 못 읽으면 성공이 아니다
    assert power.autostart_work(inst, None, None, "m" * 32, lambda line: None)[0] == 1


def test_processes_without_a_start_time_are_never_killed(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    fake = FakeServer(inst, monkeypatch)
    fake.procs = [(p[0], None, *p[2:]) for p in fake.procs]
    with pytest.raises(power.PowerError, match="시작 시각"):
        power.clear_processes(inst, None, lambda line: None)
    assert fake.killed == []


def test_reaping_keeps_its_deadline_for_every_process(monkeypatch):
    import types
    from server_console import winjob
    clock = [0.0]
    monkeypatch.setattr(winjob.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(winjob.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))

    def in_job(handle, job, ref):
        ref._obj.value = 1
        return 1

    def wait(handle, ms):  # 끝나지 않는 프로세스 — 기다린 만큼 시계만 간다
        clock[0] += ms / 1000
        return 0x102
    fake = types.SimpleNamespace(OpenProcess=lambda *a: 5, IsProcessInJob=in_job, TerminateProcess=lambda *a: 1,
                                 WaitForSingleObject=wait, CloseHandle=lambda h: 1)
    monkeypatch.setattr(winjob, "_k32", fake)
    job = object.__new__(winjob.SelfJob)
    job.handle = 1
    monkeypatch.setattr(winjob.SelfJob, "members", lambda self: [os.getpid(), *range(1000, 1040)])
    assert job.kill_others(timeout=29.5) is False and clock[0] <= 29.5 + 1e-6  # 2초 대기의 배수가 아닌 상한


def test_register_command_refuses_cmd_special_paths_and_pins_python(tmp_path):
    inst = make_inst(tmp_path)
    argv, env = power.register_command(inst)
    assert argv[1:3] == ["/d", "/c"] and env["MVHUB_SERVER_PYEXE"] == str(PY) and "PORT" not in env
    assert power.register_command(make_inst(tmp_path, port_known=True, port=8020))[1]["PORT"] == "8020"
    odd = make_inst(tmp_path, root=tmp_path / "a&b")
    with pytest.raises(power.PowerError):
        power.register_command(odd)


# ---------- 계획(확인 대상·거절) ----------

def test_plans_for_power_drill_and_move(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    good = tasks_of(inst)
    plan = actions.plan_power(inst, "server-stop", good, [], [], {"runtime": {"update_blockers": {"generation": 2}}})
    assert plan.params == {"enabled": {names.TASK_SERVER: True, names.TASK_WATCHDOG: True}, "off": ""}
    assert any("생성 2" in line for line in plan.summary)
    assert isinstance(actions.plan_power(inst, "server-restart", tasks_of(inst, server="Disabled"), [], []),
                      actions.Refusal)
    power.write_off(inst, "stopped", "o" * 32)
    assert actions.plan_power(inst, "server-start", good, [], []).params["off"] == "stopped:" + "o" * 32
    refused = actions.plan_move(inst, "move-out", good, [], [])
    assert any("[켜기] 뒤에" in r for r in refused.reasons)
    assert isinstance(actions.plan_move(inst, "move-restore", good, [], [], None, []), actions.Refusal)
    assert isinstance(actions.plan_drill(inst, None, []), actions.Refusal)
    (inst.logs / names.SERVER_OFF).write_text("{bad", encoding="utf-8")
    assert any("끈 기록" in r for r in actions.plan_power(inst, "server-start", good, [], []).reasons)


def test_intake_change_is_refused_only_while_moving(tmp_path):
    inst = make_inst(tmp_path)
    assert isinstance(actions.plan_intake_set(inst, {"port": 1}, False, True), actions.Plan)
    assert "이사" in actions.plan_intake_set(inst, {"port": 1}, False, True, moving=True).reasons[0]


# ---------- 백업 세트 다시 찾기·드릴 ----------

def _backup_set(inst, stamp="20261025_010203", folder="", roles=("content_hub", "content_trash", "manage_hub")):
    base = backup.backup_root(inst) / folder if folder else backup.backup_root(inst)
    base.mkdir(parents=True, exist_ok=True)
    for prefix in roles:
        (base / f"{prefix}_{stamp}.db").write_bytes(b"x" * 10)
    return {"root": str(backup.backup_root(inst)), "folder": folder, "stamp": stamp}


def test_find_set_rejects_moved_root_bad_names_and_incomplete_sets(tmp_path, monkeypatch):
    monkeypatch.setattr(backup, "machine_env", lambda name: "")
    inst = make_inst(tmp_path)
    good = _backup_set(inst, folder="auto/2026")
    assert set(backup.find_set(inst, good)) == {"content", "trash", "manage"}
    rows = backup.recent_sets(inst)
    assert rows[0]["folder"] == "auto/2026" and rows[0]["stamp"] == good["stamp"]
    for bad in ({**good, "root": "E:\\other"}, {**good, "stamp": "../x"}, {**good, "folder": "../x"},
                {**good, "folder": "C:/x"}, {**good, "folder": "a\\b"}, {**good, "folder": "auto//2026"}):
        with pytest.raises(backup.BackupError):
            backup.find_set(inst, bad)
    partial = _backup_set(inst, stamp="20261025_020000", roles=("content_hub", "manage_hub"))
    with pytest.raises(backup.BackupError, match="불완전"):
        backup.find_set(inst, partial)
    other = tmp_path / "other-backups"
    (other / "auto" / "2026").mkdir(parents=True)
    for prefix in ("content_hub", "content_trash", "manage_hub"):
        (other / "auto" / "2026" / f"{prefix}_{good['stamp']}.db").write_bytes(b"y")
    monkeypatch.setattr(backup, "machine_env", lambda name: str(other) if name == "CONTENT_HUB_BACKUP_DIR" else "")
    with pytest.raises(backup.BackupError, match="다릅니다"):  # 목록을 읽은 뒤 백업 폴더 설정이 바뀌었다
        backup.find_set(inst, rows[0])


_DRILL_HELPER = textwrap.dedent(r"""
    import json, sys
    from pathlib import Path
    sys.path.insert(0, sys.argv[1])
    from server_console import backup, install, winjob
    import os
    root, params, timeout = Path(sys.argv[2]), json.loads(sys.argv[3]), float(sys.argv[4])
    backup.machine_env = lambda name: ""
    backup.DRILL_TIMEOUT = timeout
    plain = backup.child_env  # 깨끗한 환경에 가짜 도구의 조절값만 더한다
    backup.child_env = lambda inst: {**plain(inst), **{k: v for k, v in os.environ.items() if k.startswith("FAKE_")}}
    inst = install.Installation(root=root, data_dir=root / "backend" / "data", log_dir=root / "logs",
                                content_db=root / "backend" / "data" / "db" / "content_hub.db", port=8010,
                                port_known=False, python=Path(sys.executable), problems=())
    job = root / "logs" / "job"
    job.mkdir(parents=True, exist_ok=True)
    lines = []
    code, extra = backup.drill_work(inst, lambda argv, t: (1, ""), winjob.SelfJob(), job, params, lines.append)
    print(json.dumps({"code": code, "extra": extra, "lines": lines}))
""")

_FAKE_MOVE_TOOL = textwrap.dedent(r"""
    import os, subprocess, sys, tempfile, time
    grand = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    open(os.path.join(tempfile.gettempdir(), "grandchild.pid"), "w").write(str(grand.pid))
    print("검증 중", flush=True)
    time.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
    sys.exit(int(os.environ.get("FAKE_CODE", "0")))
""")


def _drill(tmp_path, monkeypatch, sleep="0", code="0", timeout=60.0):
    monkeypatch.setattr(backup, "machine_env", lambda name: "")
    inst = make_inst(tmp_path)
    (inst.root / "tools").mkdir(exist_ok=True)
    (inst.root / "tools" / "server_move.py").write_text(_FAKE_MOVE_TOOL, encoding="utf-8")
    params = _backup_set(inst)
    helper = tmp_path / "drill_helper.py"
    helper.write_text(_DRILL_HELPER, encoding="utf-8")
    env = {**os.environ, "FAKE_SLEEP": sleep, "FAKE_CODE": code, "PYTHONUTF8": "1"}
    done = subprocess.run([str(PY), str(helper), str(TOOLS), str(inst.root), json.dumps(params), str(timeout)],
                          capture_output=True, env=env, timeout=120)
    assert done.returncode == 0, done.stderr.decode("utf-8", "replace")
    result = json.loads(done.stdout.decode("utf-8").strip().splitlines()[-1])
    return inst, result


def _gone(pid_file: Path) -> bool:
    return jobs.process_state(int(pid_file.read_text()), None) == "gone"


def test_drill_runs_in_the_job_temp_folder_reaps_grandchildren_and_cleans(tmp_path, monkeypatch):
    inst, result = _drill(tmp_path, monkeypatch)
    extra = result["extra"]
    assert result["code"] == 0 and extra["drill"] == "passed" and extra["cleanup"] == "done" and extra["reaped"]
    assert any("검증 중" in line for line in result["lines"])
    assert not (inst.root / "logs" / "job" / "tmp").exists()  # reaped = Job 안에 자기만 남음(손자까지 끝남) 뒤에만 지운다


def test_drill_timeout_kills_the_tree_and_reports_cleanup_separately(tmp_path, monkeypatch):
    _inst, result = _drill(tmp_path, monkeypatch, sleep="60", timeout=3.0)
    extra = result["extra"]
    assert result["code"] == 1 and extra["drill"] == "timeout" and extra["reaped"] and extra["cleanup"] == "done"


# ---------- 작업 판정: 이사 종류 ----------

def _move_job(inst, kind="move-out", job_id="d" * 32):
    root = jobs.jobs_root(inst)
    root.mkdir(exist_ok=True)
    job = root / job_id
    job.mkdir()
    plan = actions.Plan(kind, str(inst.root), "server", "", ("x",), params={"data_dir": str(inst.data_dir), "port": 8010})
    jobs.write_json(job / "request.json", {"kind": kind, "plan": plan.to_json(), "requested_at": time.time()})
    return job, job_id


def test_move_job_stays_running_while_the_wrapper_lives_even_if_the_runner_died(tmp_path):
    inst = make_inst(tmp_path)
    job, job_id = _move_job(inst)
    jobs.write_json(job / "state.json", {"status": "running", "pid": 999999, "created": 1})  # 죽은 실행기
    me = os.getpid()
    jobs.write_json(job / "wrapper.json", {"pid": me, "created": jobs.process_created(me), "phase": "running"})
    state = jobs.read_job(inst, job_id)
    assert state["status"] == "running" and jobs.move_active(inst)
    with pytest.raises(jobs.JobError):
        jobs.acknowledge(inst, job_id)  # 살아 있는 도구가 있으면 [확인했음]으로 보호를 풀 수 없다
    assert jobs.read_job(inst, job_id, state_of=lambda pid, created: "unknown")["status"] == "running"
    gone = subprocess.Popen([str(PY), "-c", "pass"])
    created = jobs.process_created(gone.pid)
    gone.wait()
    jobs.write_json(job / "wrapper.json", {"pid": gone.pid, "created": created, "phase": "running"})
    assert jobs.read_job(inst, job_id)["status"] == "check_needed" and not jobs.move_active(inst)
    jobs.acknowledge(inst, job_id)
    jobs.write_json(job / "result.json", {"job_id": job_id, "kind": "move-out", "exit_code": 0})
    assert jobs.read_job(inst, job_id)["status"] == "finished"
    jobs.write_json(job / "result.json", {"job_id": "x" * 32, "kind": "move-out", "exit_code": 0})
    assert jobs.read_job(inst, job_id)["status"] != "finished"  # 다른 작업의 결과는 받지 않는다


def test_wrapper_ending_without_a_result_keeps_the_job_unresolved_while_the_runner_lives(tmp_path, monkeypatch):
    import types
    inst = make_inst(tmp_path)
    job, job_id = _move_job(inst)
    gone = subprocess.Popen([str(PY), "-c", "pass"])
    gone.wait()
    monkeypatch.setattr(moves.subprocess, "Popen", lambda *a, **k: types.SimpleNamespace(pid=gone.pid,
                                                                                         wait=lambda: 1))
    code, extra = moves.launch_and_wait(inst, job_id, lambda line: None)
    assert code == jobs.UNCONFIRMED and extra["move"] == "unconfirmed"
    me = os.getpid()  # 실행기는 살아서 결과를 남긴다(그 결과가 '결과 미확인' 이어야 보호가 남는다)
    jobs.write_json(job / "state.json", {"status": "finished", "pid": me, "created": jobs.process_created(me),
                                         "exit_code": code, **extra})
    state = jobs.read_job(inst, job_id)
    assert jobs.needs_check(state) and jobs.unresolved_jobs(inst) == [job_id]
    jobs.acknowledge(inst, job_id)
    assert jobs.unresolved_jobs(inst) == []


def test_interrupted_drill_points_at_the_leftover_db_copy(tmp_path):
    from server_console import ui
    inst = make_inst(tmp_path)
    job, job_id = _move_job(inst, kind="backup-drill", job_id="f" * 32)
    jobs.write_json(job / "state.json", {"status": "running", "pid": 999999, "created": 1})
    assert "leftover_tmp" not in jobs.read_job(inst, job_id)
    (job / "tmp").mkdir()
    state = jobs.read_job(inst, job_id)
    assert state["status"] == "check_needed" and state["leftover_tmp"] == str(job / "tmp")
    assert str(job / "tmp") in ui.job_result_text(state)[0] and str(job / "tmp") in ui.area_result_text(state)[0]


# ---------- 감싸개(별도 프로세스로 실제 실행) ----------

_WRAPPER_HELPER = textwrap.dedent(r"""
    import json, sys
    from pathlib import Path
    sys.path.insert(0, sys.argv[1])
    from server_console import actions, console_run, install, moves
    root, job_id, mode = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
    install.configure(root)
    inst = install.resolve_installation()
    def recompute(inst, job_id, request, runner, keep_trace=lambda t: True):
        if mode == "refuse":
            return actions.Refusal(("가짜 거절",))
        return actions.Plan.from_json(request["plan"])
    moves.recompute = recompute
    install.default_runner = lambda inst: (lambda argv, t: (0, ""))
    sys.exit(console_run.run(inst, job_id))
""")

_FAKE_EASY = textwrap.dedent(r"""
    import json, msvcrt, os, subprocess, sys, time
    from pathlib import Path
    def main(argv):
        logs = Path(__file__).resolve().parents[1] / "logs"
        busy = {}
        for name in ("console-db.lock", "git-update.lock"):
            handle = open(logs / name, "a+b")
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                busy[name] = False
            except OSError:
                busy[name] = True
            handle.close()
        (logs / "tool.json").write_text(json.dumps({"argv": argv, "busy": busy, "file": __file__}))
        mode = os.environ.get("FAKE_MODE", "ok")
        if mode == "hang":
            grand = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
            (logs / "grand.pid").write_text(str(grand.pid))
            time.sleep(120)
        if mode == "raise":
            raise RuntimeError("도구 안 오류")
        if mode == "exit3":
            sys.exit(3)
        if mode == "eof":
            raise EOFError
        return 0
""")


def _wrapper_setup(tmp_path, kind="move-out"):
    inst = make_inst(tmp_path)
    (inst.root / "tools").mkdir(exist_ok=True)
    (inst.root / "tools" / "server_move_easy.py").write_text(_FAKE_EASY, encoding="utf-8")
    job, job_id = _move_job(inst, kind)
    jobs.write_json(job / "state.json", {"status": "running", "pid": 999999, "created": 1})  # 실행기는 이미 없다
    helper = tmp_path / "wrapper_helper.py"
    helper.write_text(_WRAPPER_HELPER, encoding="utf-8")
    return inst, job, job_id, helper


def _run_wrapper(helper, inst, job_id, mode="ok", fake="ok", wait=True):
    env = {**os.environ, "FAKE_MODE": fake, "PYTHONUTF8": "1"}
    argv = [str(PY), str(helper), str(TOOLS), str(inst.root), job_id, mode]
    if not wait:
        return subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
    return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)


@pytest.mark.parametrize("fake,code,error", [("ok", 0, None), ("raise", 1, "RuntimeError"), ("exit3", 3, None),
                                              ("eof", 1, "입력이 끊겨")])
def test_wrapper_runs_the_root_tool_in_process_under_both_locks(tmp_path, fake, code, error):
    inst, job, job_id, helper = _wrapper_setup(tmp_path)
    done = _run_wrapper(helper, inst, job_id, fake=fake)
    assert done.returncode == code, done.stdout.decode("utf-8", "replace")
    result = jobs.read_json(job / "result.json")
    assert result["exit_code"] == code and result["job_id"] == job_id
    assert error is None or error in result.get("error", "")
    tool = json.loads((inst.logs / "tool.json").read_text())
    assert tool["busy"] == {"console-db.lock": True, "git-update.lock": True}  # 도구가 도는 동안 두 잠금이 잡혀 있다
    assert Path(tool["file"]).parent == (inst.root / "tools").resolve()
    assert tool["argv"] == ["out", "--purpose", "move", "--port", "8010", "--data-dir", str(inst.data_dir)]
    assert jobs.read_json(job / "wrapper.json")["phase"] == "done"
    with status.db_read_lock(inst):  # 끝나면 풀렸다
        pass
    assert jobs.read_job(inst, job_id)["status"] == "finished"


def test_wrapper_does_not_take_the_db_lock_for_undo(tmp_path):
    inst, job, job_id, helper = _wrapper_setup(tmp_path, kind="move-undo")
    assert _run_wrapper(helper, inst, job_id).returncode == 0
    tool = json.loads((inst.logs / "tool.json").read_text())
    assert tool["busy"] == {"console-db.lock": False, "git-update.lock": True}
    assert tool["argv"] == ["undo-out", "--data-dir", str(inst.data_dir)]


@pytest.mark.parametrize("setup", ["ack", "refuse", "git"])
def test_wrapper_does_not_start_when_cleared_refused_or_locked(tmp_path, setup):
    inst, job, job_id, helper = _wrapper_setup(tmp_path)
    holder = None
    if setup == "ack":
        jobs.write_json(job / "ack.json", {"acknowledged_at": 1})
    if setup == "git":
        from server_console import console_stage
        holder = console_stage.UpdateLock(inst).__enter__()
    try:
        done = _run_wrapper(helper, inst, job_id, mode="refuse" if setup == "refuse" else "ok")
    finally:
        if holder is not None:
            holder.__exit__(None, None, None)
    result = jobs.read_json(job / "result.json")
    assert done.returncode == 2 and result["not_started"] and not (inst.logs / "tool.json").exists()


def test_killing_the_wrapper_kills_the_tool_and_its_children_and_frees_the_locks(tmp_path):
    inst, job, job_id, helper = _wrapper_setup(tmp_path)
    proc = _run_wrapper(helper, inst, job_id, fake="hang", wait=False)
    deadline = time.time() + 60
    while not (inst.logs / "grand.pid").exists() and time.time() < deadline:
        time.sleep(0.2)
    wrapper = jobs.read_json(job / "wrapper.json")
    assert wrapper["phase"] == "running" and jobs.read_job(inst, job_id)["status"] == "running"
    subprocess.run(["taskkill", "/PID", str(wrapper["pid"]), "/F"], capture_output=True)
    proc.wait(30)
    deadline = time.time() + 15
    while not _gone(inst.logs / "grand.pid") and time.time() < deadline:
        time.sleep(0.2)
    assert _gone(inst.logs / "grand.pid")  # 도구가 띄운 자식도 감싸개 Job 과 함께 끝났다
    with status.db_read_lock(inst):  # 잠금도 풀렸다 — 그러나 잠금을 쥐던 도구는 이미 없다
        pass
    state = jobs.read_job(inst, job_id)
    assert state["status"] == "check_needed" and not (job / "result.json").exists()


# ---------- 화면 ----------

def _app(tmp_path, monkeypatch):
    from server_console import ui
    errors: list[str] = []
    monkeypatch.setattr(ui, "_log_ui_error", errors.append)
    root = ui.ConsoleTk()
    root.withdraw()
    return ui, root, ui.App(root, make_inst(tmp_path), autostart=False), errors


def test_ui_power_and_move_pages_show_records_and_lock_buttons_while_moving(tmp_path, monkeypatch):
    ui, root, app, errors = _app(tmp_path, monkeypatch)
    try:
        app.tasks = tasks_of(app.inst, server="Disabled", watchdog="Disabled")
        power.write_off(app.inst, "stopped", "e" * 32)
        app.show("power")
        text = app.power_state.cget("text")
        assert "꺼짐" in text and "관리 창이 끔" in text and "eeeeeeee" in text
        running = {"kind": "move-out", "status": "running", "wrapper": "unknown"}
        sets = [{"stamp": "20261025_010203", "roles": ["content", "trash", "manage"], "bytes": 3_000_000, "folder": "",
                 "root": str(backup.backup_root(app.inst))}]
        app._handle(("move_view", {"running": running, "last": None, "record": ("out", "내보내기 단계"), "sets": sets}))
        assert "생사 확인 불가" in app.move_state.cget("text")
        assert all(str(b.cget("state")) == "disabled" for b in (*app.move_buttons, app.restore_button))
        app._handle(("move_view", {"running": None, "last": None, "record": ("none", "없음"), "sets": sets}))
        assert str(app.restore_button.cget("state")) == "normal"
        app.restore_tree.selection_set("0")
        picked = app._selected_set(app.restore_tree, sets)
        assert picked["stamp"] == "20261025_010203" and picked["root"] == str(backup.backup_root(app.inst))
        assert errors == []
    finally:
        root.destroy()


def test_ui_presence_drops_late_answers_and_masks_names(tmp_path, monkeypatch):
    ui, root, app, errors = _app(tmp_path, monkeypatch)
    try:
        app.login_label.configure(text="")
        mine = server_api.Session(email="admin@x.com", server={"port": 8010}, token="t" * 20)
        other = server_api.Session(email="admin@x.com", server={"port": 8010}, token="u" * 20)
        app.session = mine
        rows = {"people": [{"name": "boss@corp", "app": 2, "agent": True}, {"name": "user_ABCDEFGH1234", "app": 1,
                                                                              "agent": False}],
                "other_connections": 1}
        app.presence_inflight = True
        app._handle(("presence", other, {"rows": rows, "read_at": time.time()}))  # 로그인이 바뀐 뒤 온 응답
        assert app.presence is None and app.presence_inflight is False
        app._handle(("presence", mine, {"rows": rows, "read_at": time.time()}))
        values = [app.presence_tree.item(i, "values") for i in app.presence_tree.get_children()]
        assert [v[0] for v in values] == ["boss", "(식별자)"] and "계정 없는 연결 1" in app.presence_note.cget("text")
        app.logout()
        assert app.presence_tree.get_children() == () and "로그인하면" in app.presence_note.cget("text")
        assert errors == []
    finally:
        root.destroy()


def test_read_presence_explains_an_old_server(monkeypatch):
    monkeypatch.setattr(server_api, "call", lambda *a, **k: (404, {"detail": "Not Found"}))
    with pytest.raises(server_api.ServerError, match="옛 코드"):
        server_api.read_presence({"port": 8010}, "t" * 20)
    monkeypatch.setattr(server_api, "call", lambda *a, **k: (200, {"people": "x"}))
    with pytest.raises(server_api.ServerError, match="형식"):
        server_api.read_presence({"port": 8010}, "t" * 20)


# ---------- 화면 문구 ----------

def test_result_texts_for_control_and_move_jobs():
    from server_console import ui
    text = lambda state: ui.area_result_text({"status": "finished", **state})[0]  # noqa: E731
    assert "껐습니다" in text({"kind": "server-stop", "exit_code": 0})
    assert "이미 켜져" in text({"kind": "server-start", "exit_code": 0, "already": True, "build_id": "b" * 32})
    assert "바뀐 것: task:x" in text({"kind": "server-autostart", "exit_code": 1, "changed": ["task:x"], "error": "e"})
    assert "통과" in text({"kind": "backup-drill", "exit_code": 0, "drill": "passed", "cleanup": "done",
                         "root_commit": "c" * 40})
    assert "남음" in text({"kind": "backup-drill", "exit_code": 3, "drill": "passed", "cleanup": "left", "tmp": "T"})
    assert "시작하지 않았" in text({"kind": "move-out", "exit_code": 2, "not_started": True, "reasons": ["r"]})
    assert "[켜기]" in text({"kind": "move-restore", "exit_code": 0, "archive": ["_before_move_1"]})
    assert "결과 미확인" in text({"kind": "move-out", "exit_code": 1, "move": "unconfirmed", "error": "e"})
