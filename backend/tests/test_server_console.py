"""서버 관리 창의 관리 핵심 층(install·status·logs·actions·jobs)과 Tk 시작 격리를 시험한다.

실제 예약 작업·UAC·서버(8010)는 건드리지 않는다 — 명령 실행기는 가짜로 바꿔 끼운다.
"""
from __future__ import annotations

import ast
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import textwrap
import time

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows server console")

from server_console import actions, install, jobs, logs, names, status  # noqa: E402


def make_inst(tmp_path: Path, **overrides) -> install.Installation:
    root = tmp_path / "root"
    (root / "logs").mkdir(parents=True, exist_ok=True)
    data = root / "backend" / "data"
    values = dict(root=root, data_dir=data, log_dir=data / "logs", content_db=data / "db" / "content_hub.db",
                  port=8010, port_known=False, python=Path(sys.executable), problems=())
    values.update(overrides)
    return install.Installation(**values)


def fake_runner(outputs: dict[str, tuple[int | None, str]] | None = None, default=(0, "DONE\n")):
    calls = []

    def run(argv, timeout):
        calls.append(argv)
        text = " ".join(map(str, argv))
        for key, value in (outputs or {}).items():
            if key in text:
                return value
        return default
    run.calls = calls
    return run


# ---------- logs ----------

@pytest.mark.parametrize("payload,tabs", [
    ({"event": "generation_finalized", "level": "INFO"}, {"all", "generation"}),
    ({"event": "worker_telemetry_received", "worker_name": "무지"}, {"all", "generation"}),
    ({"event": "browser_connected"}, {"all", "connection"}),
    ({"event": "backup_failed", "level": "WARNING"}, {"all", "backup", "errors"}),
    ({"event": "audit_change"}, {"all", "settings"}),
    ({"event": "startup_ready"}, {"all", "lifecycle"}),
    ({"event": "release_promoted"}, {"all", "updates"}),
    ({"event": "something_new"}, {"all"}),
])
def test_events_land_in_their_tabs(payload, tabs):
    assert logs.classify(payload) == frozenset(tabs)


def test_unknown_info_events_are_kept_and_text_is_plain():
    # log_viewer.format_event 은 모르는 INFO 이벤트를 버린다 — 관리 창의 '전체'에는 남아야 한다.
    line = logs.parse_json_line(json.dumps({"ts": "2026-10-23T01:02:03+00:00", "level": "INFO",
                                            "event": "brand_new_event", "note": "a\x1b[31mb\x07c"}))
    assert line is not None and "brand_new_event" in line.text and "all" in line.tabs
    assert "\x1b" not in line.text and "\x07" not in line.text
    assert len(logs.clean("x" * 5000)) <= logs.MAX_LINE + 1


def test_text_console_lines():
    line = logs.parse_text_line("[supervisor] update failed: ValueError (journal_changed)", frozenset({"lifecycle"}))
    assert line.tabs == frozenset({"all", "lifecycle", "updates", "errors"}) and line.level == "ERROR"
    assert logs.parse_text_line("   ", frozenset()) is None


def test_log_hub_follows_files_and_tells_missing_from_ok(tmp_path):
    inst = make_inst(tmp_path)
    hub = logs.LogHub(inst, initial=10)
    assert hub.poll() == [] and hub.states()[names.RUNTIME_LOG] == "missing"
    inst.log_dir.mkdir(parents=True)
    inst.runtime_log.write_text(json.dumps({"event": "startup_ready", "ts": "2026-10-23T00:00:00+00:00"}) + "\n",
                                encoding="utf-8")
    first = hub.poll()
    assert any("서버 준비 완료" in line.text for line in first) and hub.states()[names.RUNTIME_LOG] == "ok"
    with inst.runtime_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": "backup_completed"}) + "\n")
    assert [line.text for line in hub.poll() if "백업 완료" in line.text]
    (inst.logs / "server_ALERT.txt").write_text("server down", encoding="utf-8")
    alerts = [line for line in hub.poll() if line.text.startswith("[ALERT]")]
    assert len(alerts) == 1 and "errors" in alerts[0].tabs
    assert not [line for line in hub.poll() if line.text.startswith("[ALERT]")]  # 같은 경고는 한 번만


def test_log_hub_caps_the_total_of_one_poll(tmp_path):
    inst = make_inst(tmp_path)
    hub = logs.LogHub(inst, initial=1)
    for name in names.CONSOLE_LOGS:
        (inst.logs / name).write_text("start\n", encoding="utf-8")
    hub.poll()
    for name in names.CONSOLE_LOGS:
        with (inst.logs / name).open("a", encoding="utf-8") as handle:
            handle.write("".join(f"{name} line {i}\n" for i in range(1400)))
    lines = hub.poll()
    assert len(lines) == logs.MAX_TOTAL_PER_POLL + 1 and "건너뜀" in lines[0].text
    assert lines[-1].text.endswith("line 1399")  # 최근 줄을 남긴다


# ---------- status ----------

def _snapshot(ts: str, pid: int, total: int) -> str:
    return json.dumps({"event": "runtime_snapshot", "ts": ts, "pid": pid,
                       "snapshot": {"requests": {"total": total, "status": {"5xx": 1}}}})


def test_latest_snapshot_skips_broken_and_partial_lines(tmp_path):
    path = tmp_path / "rt.jsonl"
    path.write_text("\n".join([_snapshot("2026-10-23T00:00:00+00:00", 7, 100), "{broken",
                               _snapshot("2026-10-23T00:01:00+00:00", 7, 160), '{"event": "runtime_snap']),
                    encoding="utf-8")
    state, found = status.latest_snapshots(path)
    assert state == "ok" and [s["snapshot"]["requests"]["total"] for s in found] == [160, 100]
    assert status.request_rate(found[0], found[1]) == (60, 60.0)
    other = dict(found[1], pid=8)
    assert status.request_rate(found[0], other) is None  # 다른 프로세스면 차이를 내지 않는다
    assert status.latest_snapshots(tmp_path / "nope.jsonl") == ("missing", [])


@pytest.mark.parametrize("ready,tasks,traces,expected", [
    (status.Ready(200, {"status": "ready", "runtime": {"admission": "normal"}}, ""), None, [], "ok"),
    # 전환이 끝난 서버는 activated 로 정상 운영한다(runtime_activation.py) — 전환 중이 아니다.
    (status.Ready(200, {"status": "ready", "runtime": {"admission": "activated"}}, ""), None, [], "ok"),
    (status.Ready(200, {"status": "ready", "runtime": {"admission": "blocked"}}, ""), None, [], "blocked"),
    (status.Ready(200, {"status": "ready", "runtime": {"admission": "normal"}}, ""), None,
     [("journal", "x")], "switching"),
    (status.Ready(503, {"status": "maintenance"}, ""), None, [], "maintenance"),
    (status.Ready(503, {"status": "not_ready"}, ""), None, [], "not_ready"),
    (status.Ready(None, None, "refused"), {names.TASK_SERVER: {"state": "Running"}}, [], "starting"),
    (status.Ready(None, None, "refused"), {names.TASK_SERVER: {"state": "Disabled"}}, [], "stopped"),
    (status.Ready(None, None, "refused"), {names.TASK_SERVER: {"state": "Missing"}}, [], "no_task"),
    (status.Ready(None, None, "refused"), None, [], "unknown"),
    (status.Ready(None, None, "refused"), None, [("request", "x")], "switching"),
    (status.Ready(None, None, "timeout"), None, [], "no_answer"),
])
def test_server_state_is_classified_without_guessing(ready, tasks, traces, expected):
    assert status.classify_server(ready, tasks, traces) == expected


HOLDER = textwrap.dedent("""
    import msvcrt, sys, time
    from pathlib import Path
    with open(sys.argv[1], 'a+b') as f:
        if f.tell() == 0:
            f.write(b'0'); f.flush()
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        Path(sys.argv[2]).write_text('ready')
        time.sleep(float(sys.argv[3]))
""")


def test_update_traces_never_take_the_updater_lock(tmp_path):
    inst = make_inst(tmp_path)
    assert status.update_traces(inst) == []
    lock = inst.logs / names.GIT_UPDATE_LOCK
    ready = tmp_path / "held"
    script = tmp_path / "holder.py"
    script.write_text(HOLDER, encoding="utf-8")
    holder = subprocess.Popen([sys.executable, str(script), str(lock), str(ready), "5"])
    try:
        deadline = time.time() + 10
        while not ready.exists() and time.time() < deadline:
            time.sleep(0.05)
        assert [kind for kind, _ in status.update_traces(inst)] == ["git"]
    finally:
        holder.kill()
        holder.wait()
    # Windows 는 죽은 프로세스의 바이트 잠금을 조금 늦게 푼다 — 풀린 뒤에는 흔적이 아니어야 한다.
    deadline = time.time() + 5
    while status.update_traces(inst) and time.time() < deadline:
        time.sleep(0.1)
    assert status.update_traces(inst) == []  # 잡혀 있지 않은 잠금 파일은 흔적이 아니다
    (inst.logs / names.UPDATE_REQUEST).write_text("{}", encoding="utf-8")
    (inst.logs / names.INSTALL_JOURNAL).write_text(json.dumps({"phase": "starting"}), encoding="utf-8")
    (inst.logs / names.PREPARE_RECORD).write_text(json.dumps({"status": "running"}), encoding="utf-8")
    assert sorted(kind for kind, _ in status.update_traces(inst)) == ["journal", "prepare", "request"]
    (inst.logs / names.UPDATE_REQUEST).unlink()
    (inst.logs / names.INSTALL_JOURNAL).write_text(json.dumps({"phase": "committed"}), encoding="utf-8")
    (inst.logs / names.PREPARE_RECORD).write_text(json.dumps({"status": "prepared"}), encoding="utf-8")
    assert status.update_traces(inst) == []
    (inst.logs / names.INSTALL_JOURNAL).write_text("{broken", encoding="utf-8")
    assert [kind for kind, _ in status.update_traces(inst)] == ["unknown"]


@pytest.mark.parametrize("name,body", [
    (names.PREPARE_RECORD, "[]"), (names.PREPARE_RECORD, "null"), (names.PREPARE_RECORD, "{}"),
    (names.PREPARE_RECORD, "{broken"), (names.PREPARE_RECORD, '{"status": "unrecognized"}'),
    (names.INSTALL_JOURNAL, "[]"), (names.INSTALL_JOURNAL, "{}"),
    (names.UPDATE_REQUEST, "{broken"),
])
def test_malformed_update_records_block_instead_of_reading_as_absent(tmp_path, name, body):
    inst = make_inst(tmp_path)
    (inst.logs / name).write_text(body, encoding="utf-8")
    assert status.update_traces(inst), f"{name}={body} 를 흔적 없음으로 봤다"


def test_running_code_reads_only_its_own_stage(tmp_path):
    inst = make_inst(tmp_path)
    build = "ab" * 16
    assert status.running_code(inst)["source"] == "unknown"
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": "legacy-source"}), encoding="utf-8")
    assert status.running_code(inst)["source"] == "legacy"
    stage = inst.logs / "server-stages" / build
    stage.mkdir(parents=True)
    (stage / "server-stage.json").write_text(json.dumps({"source_commit": "f" * 40}), encoding="utf-8")
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": build}), encoding="utf-8")
    assert status.running_code(inst) == {"source": "stage", "build_id": build, "commit": "f" * 40}
    # 'C:escape' 는 경로 결합에서 stage 밖(C 드라이브 현재 폴더)으로 바뀐다 — 형식 허용 목록으로 막는다.
    for bad in ("..\\..\\x", "C:escape", "abc123", build.upper(), 7):
        (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": bad}), encoding="utf-8")
        assert status.running_code(inst)["source"] == "unknown", bad


def test_run_outcome_links_only_the_one_run_that_appeared_after_the_job_started(tmp_path):
    inst = make_inst(tmp_path)
    old, new, other = "1" * 32, "2" * 32, "3" * 32
    (inst.logs / f"server-prepare-{old}.json").write_text(json.dumps({"status": "up_to_date"}), encoding="utf-8")
    before = status.prepare_runs(inst)  # 실행 직전에 이미 있던 것 — 아무리 가까운 시각이어도 잇지 않는다
    assert before == {old} and status.run_outcome(inst, before)["linked"] is False
    (inst.logs / f"server-prepare-{new}.json").write_text(json.dumps({"status": "prepared"}), encoding="utf-8")
    stage = inst.logs / "server-stages" / new
    stage.mkdir(parents=True)
    (stage / "server-stage.json").write_text(json.dumps({"source_commit": "c" * 40}), encoding="utf-8")
    outcome = status.run_outcome(inst, before)
    assert outcome["linked"] and outcome["run_id"] == new and outcome["commit"] == "c" * 40
    assert outcome["installed"] is False  # 아직 그 stage 로 돌지 않는다
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": new}), encoding="utf-8")
    assert status.run_outcome(inst, before)["installed"] is True
    (inst.logs / f"server-prepare-{new}.json").write_text(json.dumps({"status": "up_to_date"}), encoding="utf-8")
    latest = status.run_outcome(inst, before)
    assert latest["prepare"] == "up_to_date" and latest["commit"] == "" and latest["installed"] is False
    (inst.logs / f"server-prepare-{other}.json").write_text(json.dumps({"status": "prepared"}), encoding="utf-8")
    assert status.run_outcome(inst, before)["linked"] is False  # 둘이 새로 생겼으면 어느 것인지 모른다
    assert status.run_outcome(inst, None)["linked"] is False


def test_stage_paths_through_a_junction_are_not_read(tmp_path):
    inst = make_inst(tmp_path)
    build = "cd" * 16
    outside = tmp_path / "outside"
    (outside / build).mkdir(parents=True)
    (outside / build / "server-stage.json").write_text(json.dumps({"source_commit": "a" * 40}), encoding="utf-8")
    subprocess.run(["cmd", "/c", "mklink", "/J", str(inst.logs / "server-stages"), str(outside)],
                   check=True, capture_output=True)
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": build}), encoding="utf-8")
    assert status.running_code(inst)["source"] == "unknown"  # 상위 server-stages 가 연결 지점
    assert status.plain_child(inst.logs, "server-stages", build, "server-stage.json") is None


@pytest.mark.parametrize("ready,expected", [
    (status.Ready(200, {"status": "ready", "checks": {}, "runtime": {}}, ""), True),
    (status.Ready(503, {"status": "maintenance"}, ""), True),
    (status.Ready(503, {"status": "not_ready", "failed_checks": []}, ""), True),
    (status.Ready(404, {"detail": "Not Found"}, ""), False),
    (status.Ready(200, {"status": "ready"}, ""), False),
    (status.Ready(200, None, ""), False),
    (status.Ready(None, None, "refused"), False),
])
def test_only_an_mvhub_answer_confirms_the_address(ready, expected):
    assert status.is_mvhub(ready) is expected


# ---------- install ----------

def test_stage_copy_and_missing_pieces_are_reported(tmp_path):
    stage_root = tmp_path / "logs" / "server-stages" / "run1"
    stage_root.mkdir(parents=True)
    problems = install.resolve_installation(stage_root).problems
    assert "stage_copy" in problems and "not_git_clone" in problems and "missing_updater" in problems


def test_task_queries_are_parsed_and_matched(tmp_path):
    inst = make_inst(tmp_path)
    out = "\n".join([f"TASK\t{names.TASK_SERVER}\tRunning\tcmd.exe /c call \"{inst.root}\\task_launch.bat\" server",
                     f"TASK\t{names.TASK_WATCHDOG}\tReady\tcmd.exe /c call \"{inst.root}\\task_launch.bat\" watchdog",
                     f"TASK\t{names.TASK_BACKUP}\tMissing\t", "DONE"])
    tasks = install.task_states(fake_runner(default=(0, out)))
    assert tasks[names.TASK_SERVER]["state"] == "Running"
    assert install.server_task_matches(inst, tasks) == "match"
    other = {names.TASK_SERVER: {"state": "Ready", "action": 'cmd.exe /c call "E:\\Other\\task_launch.bat" server'}}
    assert install.server_task_matches(inst, other) == "other"
    assert install.server_task_matches(inst, {names.TASK_SERVER: {"state": "Missing", "action": ""}}) == "missing"
    assert install.task_states(fake_runner(default=(1, ""))) is None
    assert install.server_task_matches(inst, None) == "unknown"


ME = "S-1-5-21-1-2-3-1001"


def test_acl_offenders_flag_untrusted_writers_owners_and_links(tmp_path):
    inst = make_inst(tmp_path)
    root, bat, drive = inst.root, inst.root / "run_py.bat", inst.root.parent
    out = "\n".join([
        f"OWNER\to\t{root}\tS-1-5-32-544",
        f"ACE\to\t{root}\tS-1-5-18\t2032127\t0",
        f"ACE\to\t{root}\tS-1-5-32-544\t2032127\t0",
        f"ACE\to\t{root}\tS-1-5-32-545\t1179817\t0",          # 읽기·실행만
        f"ACE\to\t{root}\tS-1-5-11\t1245631\t1",              # Modify — 상속 전용이어도 아래 파일로 내려간다
        f"ACE\to\t{root}\tS-1-5-32-545\t268435456\t0",        # GENERIC_ALL
        f"ACE\to\t{bat}\tS-1-5-32-545\t2097154\t0",           # 이름은 읽기처럼 보여도 WriteData 비트가 있다
        f"OWNER\to\t{bat}\t{ME}",                             # 창을 연 관리자 자신이 소유해도 거절
        f"LINK\to\t{root / 'tools' / 'x'}",
        f"OWNER\tp\t{drive}\tS-1-5-18",
        f"ACE\tp\t{drive}\tS-1-5-11\t1245631\t1",             # 상위의 상속 전용 Modify 는 상위 자체엔 안 걸린다
        f"ACE\tp\t{drive}\tS-1-5-11\t4\t0",                   # 폴더 만들기(AppendData)로는 바꿔치기 못 한다
        f"ACE\tp\t{drive}\tS-1-5-32-545\t64\t0",              # DeleteChild 는 우리 폴더를 지우고 바꿀 수 있다
        "DONE"])
    offenders = install.acl_offenders([root, bat], [], fake_runner(default=(0, out)), [drive])
    assert offenders == [(str(root), "S-1-5-11", "쓰기 권한"), (str(root), "S-1-5-32-545", "쓰기 권한"),
                         (str(bat), "S-1-5-32-545", "쓰기 권한"), (str(bat), ME, "소유자"),
                         (str(root / "tools" / "x"), "-", "연결 지점"),
                         (str(drive), "S-1-5-32-545", "상위 폴더 바꿔치기 권한")]
    assert install.acl_offenders([root], [], fake_runner(default=(0, "partial"))) is None
    assert install.acl_offenders([root], [], fake_runner(default=(0, "DONE\nACE\to\tx\tS-1-5-11\t2\t0"))) is None  # DONE 이 끝이 아님
    assert install.acl_offenders([root], [], fake_runner(default=(1, "DONE"))) is None


def test_acl_script_runs_in_real_powershell(tmp_path):
    target = tmp_path / "x.py"
    target.write_text("x", encoding="utf-8")
    runner = lambda argv, timeout: install.run_command(argv, timeout)  # noqa: E731
    found = install.acl_offenders([target], [tmp_path], runner, [tmp_path.parent])
    assert found is not None  # 스크립트가 끝(DONE)까지 돌았다 — 값은 이 PC 권한에 따라 다르다
    assert install.acl_offenders([], [], runner, []) == []


@pytest.mark.parametrize("value", [
    "C:\\safe’ + (Write-Output INJECTED) + ’tail", "C:\\a'b'c", "C:\\$(Write-Output INJECTED)", "C:\\한글 폴더\\x",
    "C:\\a`b\"c‘d‛e",
])
def test_paths_reach_powershell_as_data_only(value):
    script = "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false\n" \
             f"foreach ($v in {install.ps_items([value, 'second'])}) {{ \"ITEM`t$v\" }}"
    done = subprocess.run([str(install.powershell_exe()), "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, timeout=60)
    lines = done.stdout.decode("utf-8").splitlines()
    assert done.returncode == 0 and lines == [f"ITEM\t{value}", "ITEM\tsecond"], (lines, done.stderr)


def test_protected_targets_cover_launchers_and_runtimes(tmp_path):
    inst = make_inst(tmp_path)
    (inst.root / "backend").mkdir()
    (inst.root / "tools").mkdir()
    for name in ("run_py.bat", "task_launch.bat", "x.ps1", "readme.md"):
        (inst.root / name).write_text("x", encoding="utf-8")
    (inst.root / "backend" / "serve.py").write_text("x", encoding="utf-8")
    (inst.root / ".git" / "hooks").mkdir(parents=True)
    (inst.root / ".git" / "config").write_text("x", encoding="utf-8")
    (inst.logs / "server-verifier").mkdir()
    venv = tmp_path / "venv"
    (venv / "Scripts").mkdir(parents=True)
    (venv / "Scripts" / "python.exe").write_bytes(b"MZ")
    base = Path(sys._base_executable).parent
    (venv / "pyvenv.cfg").write_text(f"home = {base}\nversion = 3\n", encoding="utf-8")
    inst = make_inst(tmp_path, python=venv / "Scripts" / "python.exe")
    single, tree, parents = install.protected_targets(inst)
    for path in (inst.root, inst.root / "run_py.bat", inst.root / "task_launch.bat", inst.root / "x.ps1",
                 inst.root / "backend" / "serve.py", inst.root / ".git" / "config", venv, venv / "pyvenv.cfg",
                 inst.python, base / "python.exe"):  # venv 면 실제로 표준 라이브러리를 읽는 Python 까지
        assert path in single, path
    assert inst.root / "readme.md" not in single
    assert tree == [inst.root / "tools", inst.root / ".git" / "hooks", inst.logs / "server-verifier"]
    assert tmp_path in parents and inst.root.anchor in [str(p) for p in parents]  # 위 폴더 끝까지
    assert not set(parents) & set(single)


def test_protected_targets_include_every_folder_above_each_target(tmp_path, monkeypatch):
    git_root, node = tmp_path / "Git", tmp_path / "node"
    for path in (git_root / "cmd" / "git.exe", git_root / "mingw64" / "bin" / "git.exe", git_root / "etc" / "gitconfig",
                 git_root / "mingw64" / "etc" / "gitconfig", node / "node.exe", node / "node_modules" / "npm" / "x.js"):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    monkeypatch.setattr(install, "trusted_git", lambda: git_root / "cmd" / "git.exe")
    monkeypatch.setattr(install, "node_dir", lambda inst: node)
    single, _tree, parents = install.protected_targets(make_inst(tmp_path, python=None))
    for path in (git_root / "mingw64" / "bin" / "git.exe", git_root / "etc" / "gitconfig", node / "node_modules" / "npm"):
        assert path in single, path
    # 검사하는 실행 파일·설정이 들어 있는 중간 폴더 — 여기에 DeleteChild 가 있으면 안전한 파일도 바꿔치기된다.
    for path in (git_root / "mingw64", git_root / "mingw64" / "bin", git_root / "etc", git_root / "mingw64" / "etc",
                 node / "node_modules"):
        assert path in parents, path


def test_trusted_git_ignores_inherited_environment(tmp_path, monkeypatch):
    evil = tmp_path / "evil"
    (evil / "Git" / "cmd").mkdir(parents=True)
    (evil / "Git" / "cmd" / "git.exe").write_bytes(b"MZ")
    for key in ("PATH", "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
        monkeypatch.setenv(key, str(evil))
    monkeypatch.setattr(install, "_hklm", lambda subkey, name: None)  # 레지스트리에 Git 이 없을 때도
    assert install.trusted_git() is None  # 환경변수가 가리키는 git 을 대신 고르지 않는다


def test_child_environment_is_rebuilt_not_inherited(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    evil = tmp_path / "evil"
    evil.mkdir()
    for key, value in (("PATH", str(evil)), ("PYEXE", str(evil / "python.exe")), ("ComSpec", str(evil / "cmd.exe")),
                       ("MVHUB_SERVER_VERIFICATION_PYTHON", str(evil)), ("CONTENT_HUB_DB", str(evil)),
                       ("SystemRoot", str(evil))):
        monkeypatch.setenv(key, value)
    env = install.child_env(inst)
    assert str(evil) not in env["PATH"] and str(evil) not in env["ComSpec"] and str(evil) not in env["SystemRoot"]
    assert env["ComSpec"].lower().endswith("system32\\cmd.exe")
    assert env["PYEXE"] == str(inst.python)  # run_py.bat 이 사용자 PATH 대신 검증된 Python 을 쓴다
    assert not [k for k in env if k.startswith("MVHUB_SERVER")] and "CONTENT_HUB_DB" not in env


# ---------- actions ----------

def test_git_update_plan_refuses_until_every_condition_holds(tmp_path):
    inst = make_inst(tmp_path)
    plan = actions.plan_git_update(inst, "match", [], [], "a" * 40)
    assert isinstance(plan, actions.Plan)
    assert "실행 시점의 최신 origin/main" in plan.summary[0] and "aaaaaaaa" in plan.summary[1]
    for task_match in ("missing", "other", "unknown"):
        assert isinstance(actions.plan_git_update(inst, task_match, [], []), actions.Refusal)
    assert isinstance(actions.plan_git_update(inst, "match", [("git", "running")], []), actions.Refusal)
    # 권한은 막지 않고 알리기만 한다(Jay 결정 2026-10-23 — 기존 update_git.bat 처럼 단추만 누르면 진행).
    for offenders, word in ((None, "확인하지 못했습니다"), ([("p", "S-1-5-11", "쓰기 권한")], "S-1-5-11")):
        warned = actions.plan_git_update(inst, "match", [], offenders)
        assert isinstance(warned, actions.Plan) and word in warned.warnings[0]
        assert actions.Plan.from_json(warned.to_json()) == warned
    assert plan.warnings == ()
    staged = make_inst(tmp_path, problems=("stage_copy",))
    assert isinstance(actions.plan_git_update(staged, "match", [], []), actions.Refusal)
    # 확인한 커밋은 고정 대상이 아니다 — coordinator 가 실행 때 다시 고른다.
    later = actions.plan_git_update(inst, "match", [], [], "b" * 40)
    assert actions.same_target(plan, later)
    assert not actions.same_target(plan, actions.Plan("git-update", "E:\\Other", "server", "", ()))


def test_update_command_is_fixed(tmp_path):
    inst = make_inst(tmp_path)
    plan = actions.plan_git_update(inst, "match", [], [])
    argv = actions.command_for(plan, inst)
    assert argv[-5:] == ["-File", str(inst.root / "tools" / "run_update_git.ps1"), "-Root", str(inst.root), "-NoPause"]
    assert argv[0].lower().endswith("system32\\windowspowershell\\v1.0\\powershell.exe")
    with pytest.raises(ValueError):
        actions.command_for(actions.Plan("git-update", "E:\\Other", "server", "", ()), inst)


# ---------- jobs ----------

def _job(tmp_path):
    inst = make_inst(tmp_path)
    plan = actions.plan_git_update(inst, "match", [], [])
    job_id = jobs.new_job(inst, plan, fake_runner())
    return inst, plan, job_id


def test_job_runs_to_the_end_and_keeps_output_and_exit_code(tmp_path):
    inst, plan, job_id = _job(tmp_path)
    script = "import sys; print('[10:00:00] [1/6] 새 코드 받는 중'); print('[10:00:05] [3/6] CLI'); sys.exit(3)"
    code = jobs.run_job(inst, job_id, lambda: plan, command=[sys.executable, "-c", script],
                        env=dict(os.environ, PYTHONUTF8="1"))
    assert code == 3
    state = jobs.read_job(inst, job_id)
    assert state["status"] == "finished" and state["exit_code"] == 3 and state["result"] == "failed"
    lines, offset = jobs.read_output(inst, job_id)
    assert "[1/6] 새 코드 받는 중" in lines[0] and jobs.step_of(lines) == 3 and offset > 0


def test_job_refuses_when_target_changed_or_conditions_fail(tmp_path):
    inst, plan, job_id = _job(tmp_path)
    moved = actions.Plan("git-update", "E:\\Elsewhere", "server", "", ())
    assert jobs.run_job(inst, job_id, lambda: moved, command=[sys.executable, "-c", "print(1)"]) == 2
    assert jobs.read_job(inst, job_id)["status"] == "refused"
    assert not (jobs.job_dir(inst, job_id) / "output.log").exists()
    second = jobs.new_job(inst, plan, fake_runner())
    refusal = actions.Refusal(("업데이트 흔적",))
    assert jobs.run_job(inst, second, lambda: refusal, command=[sys.executable, "-c", "print(1)"]) == 2
    assert jobs.read_job(inst, second)["reasons"] == ["업데이트 흔적"]


def test_lost_runner_result_is_check_needed_not_guessed(tmp_path):
    inst, plan, job_id = _job(tmp_path)
    job = jobs.job_dir(inst, job_id)
    assert jobs.read_job(inst, job_id)["status"] == "starting"
    assert jobs.read_job(inst, job_id, now=time.time() + 3600)["status"] == "check_needed"
    jobs.write_json(job / "state.json", {"status": "running", "pid": 999999, "created": 1})
    assert jobs.read_job(inst, job_id)["status"] == "check_needed"
    me = {"status": "running", "pid": os.getpid(), "created": jobs.process_created(os.getpid())}
    jobs.write_json(job / "state.json", me)
    assert jobs.read_job(inst, job_id)["status"] == "running"
    jobs.write_json(job / "state.json", dict(me, created=12345))  # PID 재사용
    assert jobs.read_job(inst, job_id)["status"] == "check_needed"


def test_job_ids_and_folders_are_strict(tmp_path):
    inst = make_inst(tmp_path)
    for bad in ("", "../x", "A" * 32, "0" * 31):
        with pytest.raises(jobs.JobError):
            jobs.job_dir(inst, bad)
    target = tmp_path / "elsewhere"
    target.mkdir()
    subprocess.run(["cmd", "/c", "mklink", "/J", str(inst.logs / names.JOB_DIR), str(target)],
                   check=True, capture_output=True)
    with pytest.raises(jobs.JobError):
        jobs.ensure_jobs_root(inst, fake_runner())
    assert list(target.iterdir()) == []


def _icacls_calls(runner):
    return [call for call in runner.calls if "icacls" in str(call[0]).lower()]


def test_job_root_permissions_are_fixed_not_blocking(tmp_path):
    # 권한이 흐트러진 작업 폴더는 관리자인 창이 다시 잠그고 진행한다(멈추지 않는다).
    inst = make_inst(tmp_path)
    folder = inst.logs / names.JOB_DIR
    folder.mkdir()
    for weak in (f"ACE\to\t{folder}\tS-1-5-11\t1245631\t0\nDONE", f"OWNER\to\t{folder}\t{ME}\nDONE", "partial"):
        runner = fake_runner({"icacls": (0, "")}, default=(0, weak))
        assert jobs.ensure_jobs_root(inst, runner) == folder
        assert len(_icacls_calls(runner)) == 2  # 소유자 → 권한
    runner = fake_runner()
    assert jobs.ensure_jobs_root(inst, runner) == folder and _icacls_calls(runner) == []  # 깨끗하면 건드리지 않는다
    weak = f"OWNER\to\t{folder}\t{ME}\nDONE"
    failing = fake_runner({"icacls": (5, "")}, default=(0, weak))
    assert jobs.ensure_jobs_root(inst, failing) == folder and _icacls_calls(failing)  # 잠그기를 시도했고, 실패해도 진행
    fresh = make_inst(tmp_path / "fresh")
    failing = fake_runner({"icacls": (5, "")})
    assert jobs.ensure_jobs_root(fresh, failing) == jobs.jobs_root(fresh) and _icacls_calls(failing)  # 새 폴더도


def test_unreadable_job_records_are_repaired_then_read_again(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    answers = iter([None, ["a" * 32]])
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda inst: next(answers))
    repaired = []
    monkeypatch.setattr(jobs, "ensure_jobs_root", lambda inst, runner, force: repaired.append(force))
    assert jobs.unresolved_jobs_or_repair(inst, fake_runner()) == ["a" * 32] and repaired == [True]
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda inst: None)  # 잠가도 못 읽으면 기록을 모르니 거절 쪽(None)
    assert jobs.unresolved_jobs_or_repair(inst, fake_runner()) is None
    monkeypatch.setattr(jobs, "ensure_jobs_root",
                        lambda inst, runner, force: (_ for _ in ()).throw(jobs.JobError("x")))
    assert jobs.unresolved_jobs_or_repair(inst, fake_runner()) is None


def test_unreadable_job_folder_is_locked_even_without_foreign_writers(tmp_path, monkeypatch):
    # 남의 쓰기 권한은 없고(ACL 깨끗) 관리자 읽기 권한만 빠진 폴더 — 실제 ensure_jobs_root 로 잠근 뒤 다시 읽는다.
    inst = make_inst(tmp_path)
    jobs.jobs_root(inst).mkdir()
    runner = fake_runner({"icacls": (0, "")})  # 권한 검사 결과는 깨끗(DONE)
    monkeypatch.setattr(jobs, "unresolved_jobs", lambda inst: [] if _icacls_calls(runner) else None)
    assert jobs.unresolved_jobs_or_repair(inst, runner) == [] and len(_icacls_calls(runner)) == 2


def test_permission_check_failures_only_warn(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    monkeypatch.setattr(install, "protected_targets", lambda inst: (_ for _ in ()).throw(PermissionError(5, "denied")))
    assert install.untrusted_writers(inst, fake_runner()) is None  # 예외도 '확인하지 못했습니다' 알림으로
    plan = actions.plan_git_update(inst, "match", [], install.untrusted_writers(inst, fake_runner()))
    assert isinstance(plan, actions.Plan) and plan.warnings


def test_runner_does_not_scan_permissions_again(tmp_path, monkeypatch):
    from server_console import job_main
    inst = make_inst(tmp_path)
    monkeypatch.setattr(install, "default_runner", lambda inst: fake_runner())
    monkeypatch.setattr(install, "task_states", lambda runner: {})
    monkeypatch.setattr(install, "server_task_matches", lambda inst, tasks: "match")
    monkeypatch.setattr(install, "untrusted_writers", lambda inst, runner: pytest.fail("실행기가 권한을 다시 훑었다"))
    monkeypatch.setattr(status, "update_traces", lambda inst: [])
    assert isinstance(job_main.recompute(inst, "a" * 32), actions.Plan)


def test_new_job_root_gets_admin_owner(tmp_path):
    inst = make_inst(tmp_path)
    runner = fake_runner({"icacls": (0, "")})
    jobs.ensure_jobs_root(inst, runner)
    icacls = _icacls_calls(runner)
    assert icacls[0][-2:] == ["/setowner", "*S-1-5-32-544"] and "/inheritance:r" in icacls[1]


def test_unresolved_job_blocks_the_next_update_until_acknowledged(tmp_path):
    inst, plan, job_id = _job(tmp_path)
    assert jobs.unresolved_jobs(inst) == [job_id]  # 막 만든(실행기 시작 전) 작업
    assert jobs.unresolved_jobs(inst, exclude=job_id) == []  # 실행기는 제 작업을 빼고 본다
    refusal = actions.plan_git_update(inst, "match", [], [], unresolved_jobs=jobs.unresolved_jobs(inst))
    assert isinstance(refusal, actions.Refusal) and job_id[:8] in refusal.reasons[0]
    with pytest.raises(jobs.JobError):
        jobs.acknowledge(inst, job_id)  # 진행 중(시작 대기)인 작업은 확인 처리하지 않는다
    jobs.write_json(jobs.job_dir(inst, job_id) / "state.json", {"status": "running", "pid": 999999, "created": 1})
    assert jobs.read_job(inst, job_id)["status"] == "check_needed" and jobs.unresolved_jobs(inst) == [job_id]
    jobs.acknowledge(inst, job_id)
    assert jobs.read_job(inst, job_id)["acknowledged"] and jobs.unresolved_jobs(inst) == []
    second = jobs.new_job(inst, plan, fake_runner())
    jobs.write_json(jobs.job_dir(inst, second) / "state.json", {"status": "finished", "exit_code": 1, "pid": 1})
    assert jobs.unresolved_jobs(inst) == []  # 끝난 작업(실패 포함)은 결과가 남아 있으니 막지 않는다
    jobs.write_json(jobs.job_dir(inst, second) / "state.json", {"status": "runner_error", "pid": "x"})
    assert jobs.unresolved_jobs(inst) == [second]


@pytest.mark.parametrize("state", [{}, {"status": "finished"}, {"status": "finished", "exit_code": "0"},
                                   {"status": "weird"}, {"status": None}])
def test_malformed_job_state_is_check_needed(tmp_path, state):
    inst, _plan, job_id = _job(tmp_path)
    jobs.write_json(jobs.job_dir(inst, job_id) / "state.json", state)
    assert jobs.read_job(inst, job_id)["status"] == "check_needed"
    assert jobs.unresolved_jobs(inst) == [job_id]


def test_every_job_is_checked_and_unreadable_list_refuses(tmp_path):
    inst, plan, first = _job(tmp_path)
    for _ in range(25):  # 표시용 개수(5)·옛 상한(20)보다 많아도 오래된 미확인 작업을 놓치지 않는다
        newer = jobs.new_job(inst, plan, fake_runner())
        jobs.write_json(jobs.job_dir(inst, newer) / "state.json", {"status": "finished", "exit_code": 0})
    os.utime(jobs.job_dir(inst, first) / "request.json", (1, 1))
    assert jobs.unresolved_jobs(inst) == [first]
    broken = make_inst(tmp_path / "broken")
    (broken.logs / names.JOB_DIR).write_text("not a folder", encoding="utf-8")
    assert jobs.unresolved_jobs(broken) is None
    refusal = actions.plan_git_update(broken, "match", [], [], unresolved_jobs=None)
    assert isinstance(refusal, actions.Refusal) and "작업 기록" in refusal.reasons[0]


def test_job_records_what_it_installed(tmp_path):
    inst, plan, job_id = _job(tmp_path)
    seen = []

    def observe(prior):
        seen.append(prior)
        return {"linked": True, "commit": "d" * 40, "installed": True}
    jobs.run_job(inst, job_id, lambda: plan, command=[sys.executable, "-c", "pass"], before=lambda: {"x"},
                 observe=observe)
    state = jobs.read_job(inst, job_id)
    assert state["code_after"]["commit"] == "d" * 40 and seen == [{"x"}]
    second = jobs.new_job(inst, plan, fake_runner())
    jobs.run_job(inst, second, lambda: plan, command=[sys.executable, "-c", "pass"], before=lambda: 1 / 0,
                 observe=lambda prior: {"prior": prior} if prior is None else 1 / 0)
    state = jobs.read_job(inst, second)
    assert state["exit_code"] == 0 and state["code_after"] == {"prior": None}  # 못 쟀으면 잇지 않을 뿐
    third = jobs.new_job(inst, plan, fake_runner())
    jobs.run_job(inst, third, lambda: plan, command=[sys.executable, "-c", "pass"], observe=lambda _p: 1 / 0)
    assert jobs.read_job(inst, third)["exit_code"] == 0  # 관찰이 실패해도 결과는 남는다


def test_failed_job_does_not_claim_another_runs_prepare_record(tmp_path):
    # 내 실행이 잠금 충돌로 기록을 만들기 전에 실패하는 동안, 다른 실행이 준비 기록 하나를 만든 경우.
    inst, plan, job_id = _job(tmp_path)
    other = inst.logs / f"server-prepare-{'4' * 32}.json"
    script = f"import pathlib, sys; pathlib.Path(r'{other}').write_text('{{\"status\": \"prepared\"}}'); sys.exit(1)"
    code = jobs.run_job(inst, job_id, lambda: plan, command=[sys.executable, "-c", script],
                        before=lambda: status.prepare_runs(inst), observe=lambda prior: status.run_outcome(inst, prior))
    state = jobs.read_job(inst, job_id)
    assert code == 1 and other.exists() and state["code_after"]["linked"] is False


def test_output_reader_moves_past_a_long_line_without_newline(tmp_path):
    inst, _plan, job_id = _job(tmp_path)
    path = jobs.job_dir(inst, job_id) / "output.log"
    path.write_bytes(b"x" * 70_000)
    lines, offset = jobs.read_output(inst, job_id, 0, 64_000)
    assert offset == 64_000 and len(lines) == 1
    lines, offset = jobs.read_output(inst, job_id, offset, 64_000)
    assert lines == [] and offset == 64_000  # 끝나지 않은 짧은 꼬리는 기다린다
    with path.open("ab") as handle:
        handle.write(b"\n[2/6] next\n")
    lines, offset = jobs.read_output(inst, job_id, offset, 64_000)
    assert lines[-1] == "[2/6] next" and offset == path.stat().st_size
    with path.open("ab") as handle:
        handle.write("끝 줄".encode("utf-8"))  # 줄바꿈 없이 끝난 마지막 출력
    assert jobs.read_output(inst, job_id, offset, 64_000)[0] == []
    lines, end = jobs.read_output(inst, job_id, offset, 64_000, final=True)  # 작업이 끝났으면 내보낸다
    assert lines == ["끝 줄"] and end == path.stat().st_size


@pytest.mark.parametrize("codec", ["utf-8", "cp949"])
def test_long_line_is_not_cut_inside_a_korean_character(tmp_path, codec):
    inst, _plan, job_id = _job(tmp_path)
    path = jobs.job_dir(inst, job_id) / "output.log"
    path.write_bytes(("가" * 40_000).encode(codec))  # 줄바꿈 없음, 64KB 를 넘는다(CP949 8만·UTF-8 12만 바이트)
    lines, offset = jobs.read_output(inst, job_id, 0, 64_001)
    assert set(lines[0]) == {"가"} and offset < 64_001
    rest, _ = jobs.read_output(inst, job_id, offset, 64_001, final=True)
    assert set("".join(rest)) == {"가"}


SPAWNER = textwrap.dedent("""
    import sys, time
    sys.path.insert(0, sys.argv[1])
    from server_console import jobs
    child = [sys.executable, '-c', 'import time, pathlib, sys; time.sleep(3); pathlib.Path(sys.argv[1]).write_text("alive")',
             sys.argv[2]]
    print(jobs.spawn_detached(child, sys.argv[3], dict(__import__('os').environ)), flush=True)
    time.sleep(60)  # 창이 계속 떠 있다가 강제로 죽는 경우
""")


def test_detached_runner_outlives_a_killed_window_process(tmp_path):
    marker = tmp_path / "alive.txt"
    script = tmp_path / "spawner.py"
    script.write_text(SPAWNER, encoding="utf-8")
    parent = subprocess.Popen([sys.executable, str(script), str(TOOLS), str(marker), str(tmp_path)],
                              stdout=subprocess.PIPE, text=True)
    try:
        assert parent.stdout.readline().strip().isdigit()
        parent.kill()  # TerminateProcess — 창(부모)을 작업 관리자로 끝낸 것과 같다
        parent.wait(timeout=10)
        assert not marker.exists()
    finally:
        if parent.poll() is None:
            parent.kill()
    deadline = time.time() + 20
    while not marker.exists() and time.time() < deadline:
        time.sleep(0.1)
    assert marker.read_text() == "alive"


from test_git_update_admission import UpdaterFixture, fake_tool, updater  # noqa: E402,F401 — 같은 가짜 도구 틀


@pytest.mark.parametrize("mode,code,expected", [
    ("committed", "0", "완료: 서버가 최신 판으로 동작 중입니다."),
    ("prepare_failed", "1", "실패: 업데이트가 끝나지 않았습니다(종료 코드 1)"),
])
def test_job_runner_drives_the_real_updater_script(updater, mode, code, expected):
    # 실제 run_update_git.ps1 을 가짜 coordinator 와 돌린다. 가짜 도구가 환경변수로 끼워지므로 이 시험만
    # child_env 대신 틀의 환경을 쓴다(환경 재구성 자체는 test_child_environment_is_rebuilt_not_inherited).
    updater.holder()
    updater.env.update({"MVHUB_FAKE_PROGRESS": mode, "MVHUB_COORDINATOR_EXIT": code})
    data = updater.root / "backend" / "data"
    inst = install.Installation(root=updater.root, data_dir=data, log_dir=data / "logs",
                                content_db=data / "db" / "content_hub.db", port=8010, port_known=False,
                                python=Path(sys.executable), problems=())
    (inst.logs).mkdir(exist_ok=True)
    plan = actions.Plan("git-update", str(updater.root), "server", "", ())
    job_id = jobs.new_job(inst, plan, fake_runner())
    exit_code = jobs.run_job(inst, job_id, lambda: plan, command=actions.command_for(plan, inst), env=updater.env)
    assert exit_code == int(code)
    lines, _ = jobs.read_output(inst, job_id)
    text = "\n".join(lines)
    assert "[1/6]" in text and "[5/6]" in text and expected in text, text
    assert jobs.read_job(inst, job_id)["exit_code"] == int(code)
    assert "coordinator" in updater.trace()


def test_output_lines_decode_utf8_and_cp949():
    assert jobs.decode_line("한글 [2/6]".encode("utf-8")) == "한글 [2/6]"
    assert jobs.decode_line("새 코드 받는 중".encode("cp949")) == "새 코드 받는 중"


# ---------- Tk 시작 격리 ----------

PROFILE = "open(r'{marker}', 'w').write('ran')\n"


def test_tk_profile_files_are_not_executed(tmp_path):
    marker = tmp_path / "profile-ran.txt"
    home = tmp_path / "home"
    home.mkdir()
    for name in (".Tk.py", ".server_console.py", ".main.py", ".ui.py"):
        (home / name).write_text(PROFILE.format(marker=marker), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
    env["HOME"] = str(home)
    # -I(-E) 를 빼고 돌린다: 최신 tkinter 는 -E 일 때 readprofile 을 건너뛰지만(tkinter/__init__.py:2489),
    # 관리 창은 그 보장에 기대지 않고 readprofile 자체를 막는다 — 막힘을 -E 없이 확인한다.
    plain = "import tkinter; r = tkinter.Tk(); r.withdraw(); r.destroy()"
    subprocess.run([sys.executable, "-c", plain], env=env, cwd=home, check=True, timeout=60)
    assert marker.exists()  # 막지 않은 Tk 는 홈 폴더 파일을 실행한다 — 이 시험이 실제로 잡는지의 증거
    marker.unlink()
    guarded = f"import sys; sys.path.insert(0, r'{TOOLS}'); from server_console import ui; r = ui.ConsoleTk(); r.withdraw(); r.destroy()"
    subprocess.run([sys.executable, "-c", guarded], env=env, cwd=home, check=True, timeout=60)
    assert not marker.exists()


def test_console_check_runs_isolated(tmp_path):
    env = dict(os.environ, HOME=str(tmp_path), TCLLIBPATH=str(tmp_path))
    done = subprocess.run([sys.executable, "-I", "-B", str(TOOLS / "server_console" / "console.py"), "--check",
                           "--install-root", str(tmp_path)], env=env, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0 and "tk ok" in done.stdout, done.stderr
    assert f"code_root={ROOT}" in done.stdout


# ---------- 관리 창 전용 stage(2단계 ①) ----------

STAGE_FILES = ("tools/log_viewer.py", "tools/deploy_fence_check.py")


def _install_tree(tmp_path: Path) -> Path:
    """가짜 설치 루트: 관리 창 코드 + 등록 Python + logs + git 저장소(커밋 하나)."""
    root = tmp_path / "root"
    for path in (TOOLS / "server_console").glob("*.py"):
        target = root / "tools" / "server_console" / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    for rel in STAGE_FILES:
        (root / rel).write_bytes((ROOT / rel).read_bytes())
    (root / ".mvhub-runtime").mkdir()
    (root / ".mvhub-runtime" / "python.txt").write_text(sys.executable + "\n", encoding="utf-8")
    (root / "logs").mkdir()
    (root / ".gitignore").write_text("/logs/\n/.mvhub-runtime/\n", encoding="utf-8")
    _git_commit(root, "init")
    return root


def _git_commit(root: Path, message: str) -> str:
    git = str(install.trusted_git() or "git")
    if not (root / ".git").exists():
        subprocess.run([git, "-C", str(root), "init", "-q"], check=True)
    subprocess.run([git, "-C", str(root), "add", "-A"], check=True)
    subprocess.run([git, "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message],
                   check=True)
    return subprocess.run([git, "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True,
                          text=True).stdout.strip()


def _stage_inst(root: Path) -> install.Installation:
    return install.Installation(root=root, data_dir=root / "backend" / "data", log_dir=root / "backend" / "data" / "logs",
                                content_db=root / "backend" / "data" / "db" / "content_hub.db", port=8010,
                                port_known=False, python=Path(sys.executable), problems=())


def _bootstrap_check(root: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, HOME=str(root), TCLLIBPATH=str(root))
    return subprocess.run([sys.executable, "-I", str(root / "tools" / "server_console" / "main.py"), "--check"],
                          env=env, capture_output=True, text=True, timeout=120)


def test_bootstrap_runs_the_verified_stage_and_falls_back_to_root(tmp_path):
    from server_console import console_stage, main as boot
    root = _install_tree(tmp_path)
    done = _bootstrap_check(root)
    assert done.returncode == 0 and f"code_root={root}" in done.stdout, done.stdout + done.stderr  # 포인터 없음 = 루트 판
    inst = _stage_inst(root)
    runner = console_stage.default_runner_for(inst)
    sha = subprocess.run([str(install.trusted_git()), "-C", str(root), "rev-parse", "HEAD"], capture_output=True,
                         text=True, check=True).stdout.strip()
    said = []
    stage = console_stage.build(inst, runner, sha, console_stage.check_with_python(inst, runner), said.append)
    assert stage == root / "logs" / "console-stages" / sha and said
    console_stage.publish(inst, sha)
    done = _bootstrap_check(root)
    assert done.returncode == 0 and f"code_root={stage}" in done.stdout, done.stdout + done.stderr
    assert not list(stage.rglob("__pycache__"))  # -B — 목록 밖 .pyc 를 남기지 않는다
    (stage / "tools" / "server_console" / "ui.py").write_text("raise SystemExit(9)\n", encoding="utf-8")  # 위조
    stage_found, note = boot.current_stage(root)
    assert stage_found is None and "확인 실패" in note
    done = _bootstrap_check(root)
    assert done.returncode == 0 and f"code_root={root}" in done.stdout  # 검증 실패 → 루트 판으로


def _good_stage(tmp_path: Path) -> tuple[Path, str]:
    from server_console import console_stage
    root = _install_tree(tmp_path)
    inst = _stage_inst(root)
    runner = console_stage.default_runner_for(inst)
    sha = subprocess.run([str(install.trusted_git()), "-C", str(root), "rev-parse", "HEAD"], capture_output=True,
                         text=True, check=True).stdout.strip()
    stage = console_stage.build(inst, runner, sha, lambda _p: None, lambda _s: None)
    return stage, sha


@pytest.mark.parametrize("tamper", ["extra", "pycache", "bytes", "missing", "manifest_dotdot", "manifest_dup"])
def test_stage_verification_rejects_tampering(tmp_path, tamper):
    from server_console import main as boot
    stage, sha = _good_stage(tmp_path)
    boot.verify_stage_dir(stage, sha)
    manifest = stage / boot.MANIFEST
    value = json.loads(manifest.read_text(encoding="utf-8"))
    if tamper == "extra":
        (stage / "tools" / "evil.py").write_text("x", encoding="utf-8")
    elif tamper == "pycache":
        (stage / "tools" / "server_console" / "__pycache__").mkdir()
    elif tamper == "bytes":
        (stage / "tools" / "log_viewer.py").write_bytes(b"# changed\n")
    elif tamper == "missing":
        (stage / "tools" / "deploy_fence_check.py").unlink()
    elif tamper == "manifest_dotdot":
        value["files"][0]["path"] = "../outside.py"
        manifest.write_text(json.dumps(value), encoding="utf-8")
    elif tamper == "manifest_dup":
        value["files"].append(dict(value["files"][0], path=value["files"][0]["path"].upper()))
        manifest.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(boot.StageError):
        boot.verify_stage_dir(stage, sha)


def test_pointer_must_match_the_manifest_and_stage_path(tmp_path):
    from server_console import console_stage, main as boot
    stage, sha = _good_stage(tmp_path)
    root = stage.parents[2]
    inst = _stage_inst(root)
    assert boot.current_stage(root) == (None, "")  # 포인터 없음 = 정상(루트 판)
    pointer = console_stage.publish(inst, sha)
    assert boot.current_stage(root) == (stage, "")
    pointer_path = root / "logs" / boot.POINTER
    for bad in (dict(pointer, manifest_sha256="0" * 64), dict(pointer, path=f"elsewhere/{sha}"), dict(pointer, sha="x")):
        pointer_path.write_text(json.dumps(bad), encoding="utf-8")
        found, note = boot.current_stage(root)
        assert found is None and "확인 실패" in note
    pointer_path.write_text(json.dumps(pointer), encoding="utf-8")
    outside = tmp_path / "outside-stages"
    (root / "logs" / boot.STAGES).rename(outside)
    subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "logs" / boot.STAGES), str(outside)],
                   check=True, capture_output=True)
    found, note = boot.current_stage(root)
    assert found is None and "연결 지점" in note  # console-stages 가 다른 곳을 가리키면 쓰지 않는다


def test_export_ignored_file_makes_the_stage_build_fail(tmp_path):
    from server_console import console_stage
    root = _install_tree(tmp_path)
    (root / ".gitattributes").write_text("tools/log_viewer.py export-ignore\n", encoding="utf-8")
    sha = _git_commit(root, "ignore one")
    inst = _stage_inst(root)
    with pytest.raises(console_stage.StageError):
        console_stage.build(inst, console_stage.default_runner_for(inst), sha, lambda _p: None, lambda _s: None)
    assert not [p for p in (root / "logs" / "console-stages").iterdir() if not p.name.startswith(".tmp-")]


def test_rollback_and_prune_keep_the_stages_in_use(tmp_path):
    from server_console import console_stage
    stage_a, sha_a = _good_stage(tmp_path)
    root = stage_a.parents[2]
    inst = _stage_inst(root)
    (root / "tools" / "server_console" / "names.py").write_text(
        (root / "tools" / "server_console" / "names.py").read_text(encoding="utf-8") + "\n# b\n", encoding="utf-8")
    sha_b = _git_commit(root, "b")
    console_stage.build(inst, console_stage.default_runner_for(inst), sha_b, lambda _p: None, lambda _s: None)
    console_stage.publish(inst, sha_a)
    pointer = console_stage.publish(inst, sha_b)
    assert pointer["previous"] == sha_a
    with pytest.raises(console_stage.StageError):
        console_stage.rollback_work(inst, "f" * 40, sha_a, lambda _s: None)  # 확인한 포인터와 다르면 거절
    code, extra = console_stage.rollback_work(inst, sha_b, sha_a, lambda _s: None)
    assert code == 0 and console_stage.read_pointer(root)["sha"] == sha_a and extra["previous_sha"] == sha_b
    stages = root / "logs" / "console-stages"
    olds = []
    for index in range(5):  # 오래된 stage 5개 + 그중 하나는 미해결 작업이 쓰는 중
        old = stages / (f"{index}" * 40)
        old.mkdir()
        os.utime(old, (1000 + index, 1000 + index))
        olds.append(old)
    keep = console_stage.in_use(inst, [str(olds[0])])
    removed = console_stage.prune(inst, keep, lambda _s: None)
    assert olds[0].exists() and (stages / sha_a).exists() and (stages / sha_b).exists()  # 쓰는 중·지금·직전
    assert olds[4].exists()  # 최근 3개(지금·직전·그다음)는 늘 남긴다
    assert set(removed) == {old.name for old in olds[1:4]}


def test_tools_update_takes_the_git_update_lock_and_rechecks(tmp_path, monkeypatch):
    from server_console import console_stage
    stage_a, sha_a = _good_stage(tmp_path)
    root = stage_a.parents[2]
    inst = _stage_inst(root)
    with pytest.raises(console_stage.StageError, match="시작하지 않음"):
        console_stage.update_work(inst, lambda a, t: (0, ""), lambda: ["업데이트 흔적"], lambda: [], lambda _s: None)
    ready, script = tmp_path / "held", tmp_path / "holder.py"
    script.write_text(HOLDER, encoding="utf-8")
    holder = subprocess.Popen([sys.executable, str(script), str(root / "logs" / names.GIT_UPDATE_LOCK), str(ready), "5"])
    try:
        deadline = time.time() + 10
        while not ready.exists() and time.time() < deadline:
            time.sleep(0.05)
        with pytest.raises(console_stage.StageError, match="다른 업데이트"):
            console_stage.update_work(inst, lambda a, t: (0, ""), lambda: [], lambda: [], lambda _s: None)
    finally:
        holder.kill()
        holder.wait()
    deadline = time.time() + 5
    monkeypatch.setattr(console_stage, "latest_main", lambda inst, runner: sha_a)
    while True:
        try:
            code, extra = console_stage.update_work(inst, console_stage.default_runner_for(inst), lambda: [],
                                                    lambda: [], lambda _s: None)
            break
        except console_stage.StageError:
            if time.time() > deadline:  # Windows 는 죽은 프로세스의 잠금을 조금 늦게 푼다
                raise
            time.sleep(0.2)
    assert code == 0 and extra["console_sha"] == sha_a and console_stage.read_pointer(root)["sha"] == sha_a


def test_runner_starts_from_the_code_root_with_the_install_root(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    seen = {}
    monkeypatch.setattr(jobs, "spawn_detached",
                        lambda argv, cwd, env, secret=None: seen.update(argv=argv, cwd=cwd, env=env, secret=secret) or 1)
    jobs.launch_runner(inst, "a" * 32)
    assert seen["secret"] is None  # 인증이 필요 없는 작업에는 파이프도 열지 않는다
    argv = seen["argv"]
    assert argv[1:3] == ["-I", "-B"] and Path(argv[3]) == install.CODE_ROOT / "tools" / "server_console" / "job_main.py"
    assert argv[4:] == ["--install-root", str(inst.root), "a" * 32] and seen["cwd"] == str(inst.root)
    assert seen["env"]["PYTHONDONTWRITEBYTECODE"] == "1"


def test_console_plans_compare_their_targets(tmp_path):
    inst = make_inst(tmp_path)
    plan = actions.plan_tools_update(inst, [], [])
    assert isinstance(plan, actions.Plan) and plan.kind == "tools-update"
    assert isinstance(actions.plan_tools_update(inst, [], ["a" * 32]), actions.Refusal)
    assert isinstance(actions.plan_console_rollback(inst, None, []), actions.Refusal)
    pointer = {"sha": "b" * 40, "previous": "a" * 40}
    rollback = actions.plan_console_rollback(inst, pointer, [])
    assert rollback.params == {"from_sha": "b" * 40, "to_sha": "a" * 40}
    assert actions.Plan.from_json(rollback.to_json()) == rollback
    moved = actions.plan_console_rollback(inst, dict(pointer, sha="c" * 40), [])
    assert not actions.same_target(rollback, moved)  # 그새 포인터가 바뀌면 실행기가 거절


@pytest.mark.parametrize("state,expected", [
    ({"status": "finished", "kind": "tools-update", "exit_code": 0, "console_sha": "c" * 40}, "다시 열기"),
    ({"status": "finished", "kind": "tools-update", "exit_code": 1}, "관리 창은 그대로"),
    ({"status": "finished", "kind": "console-rollback", "exit_code": 0, "console_sha": "d" * 40}, "다시 열기"),
])
def test_console_job_result_text(state, expected):
    from server_console import ui
    assert expected in ui.job_result_text(state)[0]


# ---------- 구조 경계 ----------

def _imported_tool_modules(path: Path, seen: set[Path]) -> set[Path]:
    if path in seen or not path.is_file():
        return seen
    seen.add(path)
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        names_ = []
        if isinstance(node, ast.Import):
            names_ = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names_ = [node.module]
        for name in names_:
            assert not name.startswith("server_console"), f"{path.name} imports {name}"
            _imported_tool_modules(TOOLS / (name.split(".")[0] + ".py"), seen)
    return seen


def test_server_runtime_code_never_imports_the_console():
    tools_list = ast.literal_eval(next(
        node.value for node in ast.walk(ast.parse((TOOLS / "qualify_release_artifact.py").read_text(encoding="utf-8")))
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "TOOLS" for t in node.targets)))
    roots = [TOOLS / "server_supervisor.py", TOOLS / "server_activation.py", TOOLS / "server_release_update.py",
             *[ROOT / rel for rel in tools_list]]
    seen: set[Path] = set()
    for path in roots:
        assert path.is_file(), path
        _imported_tool_modules(path, seen)
    assert len(seen) >= len(roots)


def test_product_code_never_imports_the_console():
    # 위 시험은 stage 자격 도구의 import 사슬, 이것은 서버 코드·도구 전부를 훑는다(간접 import 포함).
    files = [*(ROOT / "backend" / "app").rglob("*.py"), *(ROOT / "backend").glob("*.py"),
             *[p for p in TOOLS.rglob("*.py") if "server_console" not in p.parts]]
    assert len(files) > 50
    for path in files:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else \
                [node.module or "", *[f"{node.module}.{a.name}" for a in node.names]] \
                if isinstance(node, ast.ImportFrom) else []  # from tools import server_console 도
            assert not any("server_console" in m for m in mods), path


def test_import_scan_catches_aliases():
    tree = ast.parse("from tools import server_console as sc\n")
    node = tree.body[0]
    assert any("server_console" in m for m in [node.module, *[f"{node.module}.{a.name}" for a in node.names]])


def test_launcher_is_ascii_and_uses_only_the_verified_python():
    raw = (ROOT / "MV_console.bat").read_bytes()
    assert all(byte < 128 for byte in raw) and b"\r\n" in raw
    text = raw.decode("ascii")
    assert ".mvhub-runtime\\python.txt" in text and "-I " in text and "--check" in text
    assert "run_py.bat" not in text and "where python" not in text.lower()
    # 승격은 검증된 Python 이 직접 — 상속 환경(PATH·SystemRoot)으로 찾는 powershell 을 거치지 않는다.
    assert "--launch" in text and "powershell" not in text.lower() and "%systemroot%" not in text.lower()
    # -I 여도 __PYVENV_LAUNCHER__ 는 sys.executable 을 바꾼다 — 첫 Python 실행 전에 지운다.
    assert text.index('set "__PYVENV_LAUNCHER__="') < text.index('"%PYEXE%"')


def _console_main():
    import importlib.util
    spec = importlib.util.spec_from_file_location("server_console_main", TOOLS / "server_console" / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # 진입점 모듈(패키지 밖에서 -I 로 실행되는 파일)
    return module


def test_launch_asks_for_approval_only_when_not_admin(tmp_path, monkeypatch):
    console_main = _console_main()
    registered = Path(sys._base_executable)
    monkeypatch.setattr(sys, "executable", r"C:\Windows\System32\notepad.exe")  # __PYVENV_LAUNCHER__ 로 오염된 경우
    calls = []

    def shell(verb, file, params, directory):
        calls.append((verb, file, params, directory))
        return 42
    assert console_main.launch(shell, lambda: False, registered) == 0
    assert console_main.launch(shell, lambda: True, registered) == 0
    assert [c[0] for c in calls] == ["runas", "open"]
    verb, file, params, directory = calls[0]
    assert Path(file).parent == registered.parent and "notepad" not in file.lower() and params.startswith("-I ")
    assert str(TOOLS / "server_console" / "main.py") in params and directory == str(ROOT)
    assert console_main.launch(lambda *a: 5, lambda: False, registered) == 1  # 승인 거절(ERROR_ACCESS_DENIED)
    calls.clear()
    with monkeypatch.context() as patch:  # 인자 없이 부를 때도 등록 기록을 쓴다
        patch.setattr(console_main, "registered_python", lambda: registered)
        assert console_main.launch(shell, lambda: False) == 0 and Path(calls[0][1]).parent == registered.parent
    # 기본값은 sys.executable 이 아니라 등록 기록의 Python 이다.
    runtime = tmp_path / ".mvhub-runtime"
    runtime.mkdir()
    (runtime / "python.txt").write_text(f"{registered}\n", encoding="utf-8")
    assert console_main.registered_python(tmp_path) == registered
    (runtime / "python.txt").write_text("relative\\python.exe\n", encoding="utf-8")
    assert console_main.registered_python(tmp_path) is None


# ---------- 화면(메시지 처리) ----------

def _app(tmp_path, monkeypatch):
    from server_console import ui
    errors: list[str] = []
    monkeypatch.setattr(ui, "_log_ui_error", errors.append)
    root = ui.ConsoleTk()
    root.withdraw()
    return ui, root, ui.App(root, make_inst(tmp_path), autostart=False), errors


def _status(snapshot):
    return status.Status(observed_at=time.time(), ready=status.Ready(200, {"status": "ready"}, ""), server="ok",
                         code={}, traces=[], snapshot_state="ok", snapshot=snapshot, snapshot_age=1.0, rate=None,
                         intake={"paused": False, "active_generation_total": "?"}, intake_error="")


def test_ui_shows_malformed_snapshot_as_unknown_and_keeps_draining(tmp_path, monkeypatch):
    ui, root, app, errors = _app(tmp_path, monkeypatch)
    try:
        bad = {"snapshot": {"agents": {"connected_accounts": "x"}, "requests": [], "websocket": None,
                            "operations": {"databases": {"ready": "?"}, "backups": {"set_count": None}}}}
        app._handle(("status", _status(bad)))
        assert {k: app.cards[k][0].cget("text") for k in ("accounts", "requests", "db", "backup")} == \
            dict.fromkeys(("accounts", "requests", "db", "backup"), "확인 불가")
        app._handle(("status", _status({"snapshot": "not a dict"})))
        app._handle = lambda item: 1 / 0  # 메시지 처리 하나가 깨져도
        app.queue.put(("status", _status(bad)))
        pending = lambda: set(root.tk.splitlist(root.tk.call("after", "info")))  # noqa: E731
        before = pending()
        app._drain()
        assert pending() - before and errors  # 다음 비우기는 예약되고 오류는 남는다
    finally:
        root.destroy()


def test_ui_finishes_each_job_once_and_holds_lost_results(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        old, lost = "a" * 32, "b" * 32
        app.job_id, app.busy = old, True
        view = app.job_view
        app._show_job(view, [], {"status": "finished", "exit_code": 0})
        assert app.busy is False
        app.busy = True  # 다음 요청을 확인하는 중에
        app._show_job(view, [], {"status": "finished", "exit_code": 0})  # 이전 작업의 같은 알림이 또 와도
        assert app.busy is True
        app._handle(("job_started", lost))
        app._show_job(view, ["stale"], {"status": "check_needed"})  # 바꾸기 전 보기의 알림은 버린다
        assert "stale" not in app.job_text.get("1.0", "end") and not app.ack_button.winfo_manager()
        app._show_job(app.job_view, [], {"status": "check_needed"})
        assert str(app.start_button.cget("state")) == "disabled" and app.ack_button.winfo_manager() == "pack"
        app._on_plan(actions.Refusal(("이전 작업 확인 필요",)))
        assert str(app.start_button.cget("state")) == "disabled"  # 결과 확인 전에는 다시 켜지 않는다
        app._show_job(app.job_view, ["[3/6] x", "[2/6] y"], {"status": "check_needed"})
        assert app.job_step == 3
    finally:
        root.destroy()


def test_ui_draws_at_most_its_budget_per_tick(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        many = [logs.LogLine(frozenset({"all"}), f"line {i}", "INFO") for i in range(ui.DRAIN_LINES * 3 + 5)]
        app.queue.put(("logs", many))
        app._drain()
        drawn = lambda: int(app.texts["all"].index("end-1c").split(".")[0]) - 1  # noqa: E731
        assert drawn() == ui.DRAIN_LINES and app.backlog  # 나머지는 다음 차례로
        app._drain()
        assert drawn() == ui.MAX_LINES_PER_TAB  # 위젯 상한에서 앞부분을 지운다
        while app.backlog:
            app._drain()
        job = "c" * 32
        app._handle(("job_started", job))
        lines = [f"[1/6] out {i}" for i in range(ui.DRAIN_LINES + 10)]
        app.queue.put(("job", app.job_view, lines, {"status": "finished", "exit_code": 0}))
        app._drain()
        assert app.job_closed != job  # 끝 처리는 줄을 다 그린 마지막 조각에서
        app._drain()
        assert app.job_closed == job and "out 3009" in app.job_text.get("1.0", "end")
    finally:
        root.destroy()


def test_ui_start_failure_and_blocking_job_can_be_acknowledged(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        plan = actions.plan_git_update(app.inst, "match", [], [])
        monkeypatch.setattr(jobs, "launch_runner", lambda inst, job_id, token=None: 1 / 0)
        monkeypatch.setattr(jobs, "ensure_jobs_root", lambda inst, runner: jobs.jobs_root(inst).mkdir(
            exist_ok=True) or jobs.jobs_root(inst))
        app._start_worker(plan)  # 실행기를 못 띄워도
        item = app.queue.get_nowait()
        assert item[0] == "job_started"  # 만든 작업을 화면이 따라가고
        app._handle(item)
        state = jobs.read_job(app.inst, app.job_id)
        assert state["status"] == "runner_error"  # 기록이 남아 '결과 확인 필요'가 된다
        app._show_job(app.job_view, [], state)
        assert app.ack_button.winfo_manager() == "pack"
        # 다른 작업을 보고 있어도, 막고 있는 작업으로 옮겨 [확인했음]을 누를 수 있다.
        blocking = app.job_id
        app._handle(("job_started", "d" * 32))
        for name, value in (("task_states", lambda runner: {}), ("server_task_matches", lambda inst, tasks: "match"),
                            ("untrusted_writers", lambda inst, runner: [])):
            monkeypatch.setattr(install, name, value)
        monkeypatch.setattr(status, "update_traces", lambda inst: [])
        monkeypatch.setattr(actions, "reference_main", lambda inst, runner: pytest.fail("거절될 때 Git 을 실행했다"))
        app._plan_worker()
        selected = app.queue.get_nowait()
        assert selected == ("job_select", blocking) and isinstance(app.queue.get_nowait()[1], actions.Refusal)
        app._handle(selected)
        assert app.job_id == blocking
        monkeypatch.setattr(ui.messagebox, "askokcancel", lambda *a, **k: True)
        app.acknowledge()
        assert jobs.unresolved_jobs(app.inst) == [] and str(app.start_button.cget("state")) == "normal"
    finally:
        root.destroy()


def test_git_is_not_run_when_refused_and_permissions_only_warn(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        for name, value in (("task_states", lambda runner: {}), ("server_task_matches", lambda inst, tasks: "match"),
                            ("untrusted_writers", lambda inst, runner: [("git.exe", "S-1-5-11", "쓰기 권한")])):
            monkeypatch.setattr(install, name, value)
        monkeypatch.setattr(status, "update_traces", lambda inst: [("git", "다른 업데이트 중")])
        monkeypatch.setattr(actions, "reference_main", lambda inst, runner: pytest.fail("거절될 때 Git 을 실행했다"))
        app._plan_worker()
        assert isinstance(app.queue.get_nowait()[1], actions.Refusal)
        monkeypatch.setattr(status, "update_traces", lambda inst: [])
        monkeypatch.setattr(actions, "reference_main", lambda inst, runner: "e" * 40)
        monkeypatch.setattr(ui.messagebox, "askokcancel", lambda *a, **k: False)
        app._plan_worker()
        plan = app.queue.get_nowait()[1]
        assert isinstance(plan, actions.Plan) and "eeeeeeee" in plan.summary[1]  # 권한 문제가 있어도 진행
        app._on_plan(plan)
        assert "S-1-5-11" in app.plan_note.cget("text")  # 업데이트 화면에 알림으로만 남는다
        app._handle(("job_started", "f" * 32))
        assert "S-1-5-11" in app.plan_note.cget("text")  # 작업이 시작돼도 알림은 남는다
    finally:
        root.destroy()


def test_ui_marks_a_non_mvhub_answer_as_unconfirmed(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        app.addresses = [("이더넷", "192.0.2.10")]
        app.status = _status(None)
        app.status.ready = status.Ready(404, {"detail": "Not Found"}, "")
        app._show_address()
        assert "MV Hub 인지 미확인" in app.addr_label.cget("text")
        app.status.ready = status.Ready(200, {"status": "ready", "checks": {}}, "")
        app._show_address()
        assert "미확인" not in app.addr_label.cget("text") and app.copy_text == "http://192.0.2.10:8010"
    finally:
        root.destroy()


@pytest.mark.parametrize("state,expected", [
    ({"status": "finished", "exit_code": 0, "code_after": {"linked": True, "installed": True, "commit": "e" * 40}},
     "커밋 eeeeeeee"),
    ({"status": "finished", "exit_code": 0, "code_after": {"linked": True, "prepare": "up_to_date", "commit": "e" * 40}},
     "이미 최신"),
    ({"status": "finished", "exit_code": 0, "code_after": {"linked": False}}, "미확인"),
    ({"status": "finished", "exit_code": 0, "code_after": "junk"}, "미확인"),
    ({"status": "finished", "exit_code": 4}, "종료 코드 4"),
    ({"status": "check_needed"}, "[확인했음]"),
    ({"status": "check_needed", "acknowledged": True}, "확인했음으로 표시됨"),
])
def test_job_result_text_names_the_commit_only_when_linked(state, expected):
    from server_console import ui
    assert expected in ui.job_result_text(state)[0]


# ---------- 2단계 ② 로그인·토큰 파이프·관리 창 기록 ----------

def _server_inst(tmp_path, **overrides):
    """stage 로 도는 서버의 기록(server-current·stage 의 serve.py·server-activation)을 가진 가짜 설치."""
    inst = make_inst(tmp_path, **overrides)
    build, nonce = "b" * 32, "c" * 32
    script = inst.logs / "server-stages" / build / "backend" / "serve.py"
    script.parent.mkdir(parents=True)
    script.write_text("", encoding="utf-8")
    (inst.logs / names.SERVER_CURRENT).write_text(json.dumps({"build_id": build}), encoding="utf-8")
    (inst.logs / "server-activation.json").write_text(
        json.dumps({"format_version": 1, "state": "activated", "execution_nonce": nonce}), encoding="utf-8")
    return inst, script, build, nonce


def _fake_server(monkeypatch, script, build, nonce, pid=4321, exe=r"C:\Py\python.exe", runtime=None, alive=True,
                 found=None):
    from server_console import server_api
    if found is None:
        found = [(pid, exe, f'"{exe}" "{script}"')]
    monkeypatch.setattr(server_api, "listeners", lambda port, runner: found)
    monkeypatch.setattr(server_api, "process_created", lambda p: 77)
    monkeypatch.setattr(server_api, "process_alive", lambda p, created: alive)
    body = {"process_id": pid, "role": "server", "build_id": build, "execution_nonce": nonce}
    body.update(runtime or {})
    monkeypatch.setattr(status, "read_ready", lambda port, timeout=3.0, tls=False: status.Ready(
        200, {"status": "ready", "checks": {}, "runtime": body}, ""))
    return server_api


def test_server_is_verified_before_login(tmp_path, monkeypatch):
    inst, script, build, nonce = _server_inst(tmp_path)
    server_api = _fake_server(monkeypatch, script, build, nonce)
    assert server_api.verify_server(inst, fake_runner()) == {
        "port": 8010, "pid": 4321, "created": 77, "nonce": nonce, "build_id": build}


@pytest.mark.parametrize("change,why", [
    ({"found": None}, "확인하지 못했습니다"),
    ({"found": []}, "없습니다"),
    ({"found": [(1, "python.exe", "x"), (2, "python.exe", "y")]}, "여럿"),
    ({"exe": r"C:\Tools\nginx.exe"}, "serve.py"),
    ({"script": "other"}, "serve.py"),
    ({"runtime": {"execution_nonce": "d" * 32}}, "/api/ready"),
    ({"runtime": {"process_id": 1}}, "/api/ready"),
    ({"runtime": {"role": "verifier"}}, "/api/ready"),
    ({"runtime": {"build_id": "e" * 32}}, "/api/ready"),
    ({"alive": False}, "바뀌었습니다"),
])
def test_server_check_refuses_anything_it_cannot_prove(tmp_path, monkeypatch, change, why):
    inst, script, build, nonce = _server_inst(tmp_path)
    change = dict(change)
    if change.pop("script", None):
        script = inst.root / "backend" / "serve.py"  # 루트 판 serve.py 가 듣고 있음(포인터는 stage)
    if "found" in change and change["found"] is None:
        server_api = _fake_server(monkeypatch, script, build, nonce)
        monkeypatch.setattr(server_api, "listeners", lambda port, runner: None)
        change.pop("found")
    else:
        server_api = _fake_server(monkeypatch, script, build, nonce, **change)
    with pytest.raises(server_api.ServerError, match=why):
        server_api.verify_server(inst, fake_runner())


def test_server_check_needs_the_activation_record_and_no_tls(tmp_path, monkeypatch):
    inst, script, build, nonce = _server_inst(tmp_path)
    server_api = _fake_server(monkeypatch, script, build, nonce)
    (inst.logs / "server-activation.json").unlink()
    with pytest.raises(server_api.ServerError, match="server-activation"):
        server_api.verify_server(inst, fake_runner())
    tls, script, build, nonce = _server_inst(tmp_path / "tls", tls=True)
    _fake_server(monkeypatch, script, build, nonce)
    with pytest.raises(server_api.ServerError, match="https"):
        server_api.verify_server(tls, fake_runner())


def test_legacy_server_without_pointer_is_the_root_serve_py(tmp_path, monkeypatch):
    inst, _script, _build, nonce = _server_inst(tmp_path)
    (inst.logs / names.SERVER_CURRENT).unlink()
    server_api = _fake_server(monkeypatch, inst.root / "backend" / "serve.py", "legacy-source", nonce)
    assert server_api.verify_server(inst, fake_runner())["build_id"] == "legacy-source"


def test_listener_lookup_and_command_line_split():
    from server_console import server_api
    out = 'PROC\t4321\tC:\\Py\\python.exe\t"C:\\Py\\python.exe" "D:\\a b\\serve.py"\tx\nDONE\n'
    assert server_api.listeners(8010, fake_runner(default=(0, out))) == [
        (4321, "C:\\Py\\python.exe", '"C:\\Py\\python.exe" "D:\\a b\\serve.py"\tx')]
    assert server_api.listeners(8010, fake_runner(default=(1, out))) is None
    assert server_api.split_command_line('"C:\\Program Files\\Py\\python.exe" "D:\\a b\\serve.py" -x') == [
        "C:\\Program Files\\Py\\python.exe", "D:\\a b\\serve.py", "-x"]
    assert server_api.split_command_line("") == []


@pytest.mark.parametrize("answer,why", [
    ((401, {"detail": "이메일 또는 비밀번호가 올바르지 않습니다"}), "올바르지 않습니다"),
    ((None, None), "응답 없음"),
    ((200, {"account": {"status": "approved", "global_roles": ["member"]}, "token": "t"}), "admin"),
    ((200, {"account": {"status": "pending", "global_roles": ["admin"]}, "token": "t"}), "admin"),
    ((200, {"account": {"status": "approved", "global_roles": ["admin"]}, "token": "a b"}), "형식"),
    ((200, {"account": {"status": "approved", "global_roles": ["admin"]}, "token": "x" * 5000}), "형식"),
])
def test_login_accepts_only_an_admin_token(tmp_path, monkeypatch, answer, why):
    from server_console import server_api
    monkeypatch.setattr(server_api, "verify_server", lambda inst, runner: {"port": 8010})
    monkeypatch.setattr(server_api, "call", lambda *a, **k: answer)
    with pytest.raises(server_api.ServerError, match=why):
        server_api.login(make_inst(tmp_path), fake_runner(), "a@b", "pw")


def test_login_keeps_the_token_out_of_reprs_and_never_sends_to_an_unverified_server(tmp_path, monkeypatch):
    from server_console import server_api
    sent = []
    monkeypatch.setattr(server_api, "verify_server", lambda inst, runner: {"port": 8010, "pid": 1})
    monkeypatch.setattr(server_api, "call", lambda *a, **k: sent.append(k["body"]) or (
        200, {"account": {"email": "Admin@x", "status": "approved", "global_roles": ["admin"]}, "token": "tok.en-1"}))
    session = server_api.login(make_inst(tmp_path), fake_runner(), "admin@x", "pw")
    assert session.token == "tok.en-1" and session.email == "Admin@x" and session.server == {"port": 8010, "pid": 1}
    assert "tok.en-1" not in repr(session) and sent == [{"email": "admin@x", "password": "pw"}]

    def unverified(inst, runner):
        raise server_api.ServerError("서버 아님")
    monkeypatch.setattr(server_api, "verify_server", unverified)
    monkeypatch.setattr(server_api, "call", lambda *a, **k: pytest.fail("확인하지 못한 서버에 비밀번호를 보냈다"))
    with pytest.raises(server_api.ServerError):
        server_api.login(make_inst(tmp_path), fake_runner(), "admin@x", "pw")


def test_api_call_ignores_proxies_and_redirects(monkeypatch):
    import http.server
    import threading
    from server_console import server_api
    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self):  # noqa: N802
            seen.update(auth=self.headers.get("Authorization"), body=self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

        def do_GET(self):  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "http://192.0.2.1/x")
            self.end_headers()

        def log_message(self, *args):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setenv("HTTP_PROXY", "http://192.0.2.1:9")
    try:
        server = {"port": httpd.server_address[1]}
        assert server_api.call(server, "PUT", "/api/x", token="tok", body={"paused": True}) == (200, {"ok": True})
        assert seen == {"auth": "Bearer tok", "body": b'{"paused": true}'}
        assert server_api.call(server, "GET", "/api/x")[0] == 302  # 따라가지 않는다
    finally:
        httpd.shutdown()


class _SlowStream:
    def readline(self, limit):
        time.sleep(5)
        return b"late\n"

    def close(self):
        pass


@pytest.mark.parametrize("stream,expected", [
    (lambda: __import__("io").BytesIO(b"tok.en-1\n"), "tok.en-1"),
    (lambda: __import__("io").BytesIO(b"tok.en-1\r\n"), "tok.en-1"),
    (lambda: __import__("io").BytesIO(b""), None),                    # 빈 입력
    (lambda: __import__("io").BytesIO(b"tok.en-1"), None),            # 줄 중간 EOF
    (lambda: __import__("io").BytesIO(b"\n"), None),                  # 빈 값
    (lambda: __import__("io").BytesIO(b"a b\n"), None),               # 공백
    (lambda: __import__("io").BytesIO(b"x" * 5000 + b"\n"), None),    # 4KB 넘음
    (lambda: _SlowStream(), None),                                    # 시간 초과
])
def test_runner_reads_one_bounded_token_line(stream, expected):
    assert jobs.read_token(stream(), wait=0.5) == expected


def _pythonw_variants():
    found = []
    for exe in (Path(sys.executable), Path(getattr(sys, "_base_executable", sys.executable))):
        pythonw = exe.with_name("pythonw.exe")
        if pythonw.is_file() and pythonw not in found:
            found.append(pythonw)
    return found


@pytest.mark.parametrize("pythonw", _pythonw_variants())
@pytest.mark.parametrize("secret,expected", [("tok.en-1", "'tok.en-1'"), (None, "None")])
def test_token_pipe_reaches_a_detached_pythonw_runner(tmp_path, pythonw, secret, expected):
    out = tmp_path / "out.txt"
    script = tmp_path / "reader.py"
    script.write_text(textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {str(TOOLS)!r})
        from pathlib import Path
        from server_console import job_main, jobs
        token = jobs.read_token(job_main._stdin(), wait=10)
        Path(sys.argv[1]).write_text(repr(token), encoding="utf-8")
    """), encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "__PYVENV_LAUNCHER__"}
    jobs.spawn_detached([str(pythonw), "-I", "-B", str(script), str(out)], str(tmp_path),
                        dict(env, PYTHONDONTWRITEBYTECODE="1"), secret=secret)
    deadline = time.time() + 30
    while not out.exists() and time.time() < deadline:
        time.sleep(0.1)
    assert out.read_text(encoding="utf-8") == expected


def test_launch_failure_keeps_what_the_runner_already_left(tmp_path, monkeypatch):
    inst, plan, job_id = _job(tmp_path)
    jobs.mark_launch_failed(inst, job_id, "실행기를 띄우지 못했습니다")
    assert jobs.read_job(inst, job_id)["status"] == "runner_error"
    second = jobs.new_job(inst, plan, fake_runner())
    jobs.write_json(jobs.job_dir(inst, second) / "state.json",
                    {"status": "runner_error", "error": "로그인 정보를 받지 못했습니다"})
    jobs.mark_launch_failed(inst, second, "실행기에 로그인 정보를 넘기지 못했습니다(BrokenPipeError)")
    assert jobs.read_job(inst, second)["error"] == "로그인 정보를 받지 못했습니다"
    monkeypatch.setattr(jobs, "spawn_detached", lambda *a, **k: pytest.fail("형식이 틀린 토큰으로 띄웠다"))
    for bad in ("", "a b", "x" * 5000, "토큰"):
        with pytest.raises(jobs.JobError):
            jobs.launch_runner(inst, second, token=bad)


def test_every_job_leaves_an_action_record(tmp_path):
    from dataclasses import replace
    inst = make_inst(tmp_path)
    plan = replace(actions.plan_git_update(inst, "match", [], []), params={"server": {"pid": 1, "nonce": "c" * 32}})
    job_id = jobs.new_job(inst, plan, fake_runner(), login_email="admin@x")
    assert jobs.run_job(inst, job_id, lambda: plan, work=lambda job, say: (0, {})) == 0
    second = jobs.new_job(inst, plan, fake_runner())
    assert jobs.run_job(inst, second, lambda: replace(plan, params={"server": {"pid": 2}})) == 2
    rows = [json.loads(line) for line in (inst.logs / names.ACTION_LOG).read_text(encoding="utf-8").splitlines()]
    assert [(r["job_id"], r["result"]) for r in rows] == [(job_id, "started"), (job_id, "success"), (second, "refused")]
    assert rows[1]["login_email"] == "admin@x" and rows[1]["exit_code"] == 0 and rows[1]["kind"] == "git-update"
    assert rows[1]["params"] == {"server": {"pid": 1, "nonce": "c" * 32}} and rows[1]["windows_user"]


def test_runner_takes_the_token_first_and_never_writes_it(tmp_path, monkeypatch):
    import io
    from server_console import job_main
    inst, plan, job_id = _job(tmp_path)
    request = jobs.read_json(jobs.job_dir(inst, job_id) / "request.json")
    monkeypatch.setattr(job_main, "_stdin", lambda: io.BytesIO(b"secret-tok\n"))
    assert job_main.take_token(inst, job_id, request) == "secret-tok"
    assert not (jobs.job_dir(inst, job_id) / "state.json").exists()  # 받기 전후로 아무것도 쓰지 않았다
    monkeypatch.setattr(job_main, "_stdin", lambda: io.BytesIO(b""))
    assert job_main.take_token(inst, job_id, request) is None
    state = jobs.read_job(inst, job_id)
    assert state["status"] == "runner_error" and "로그인 정보" in state["error"]
    rows = (inst.logs / names.ACTION_LOG).read_text(encoding="utf-8")
    assert '"runner_error"' in rows
    for path in inst.root.rglob("*"):
        if path.is_file():
            assert b"secret-tok" not in path.read_bytes()


def test_ui_login_keeps_the_session_in_memory_and_hands_the_token_only_to_auth_jobs(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    from server_console import server_api
    try:
        done = []
        app.require_login(lambda: done.append(1))
        assert app.login_window is not None
        app._handle(("login", "8010 포트를 듣는 프로세스(PID 1)가 이 설치의 서버(serve.py)가 아닙니다"))
        assert "serve.py" in app.login_note.cget("text") and app.session is None and not done
        session = server_api.Session(email="admin@x", server={"port": 8010}, token="tok.en-1")
        app._handle(("login", session))
        assert app.session is session and done == [1] and app.login_window is None
        assert "admin@x" in app.login_label.cget("text")

        monkeypatch.setattr(actions, "AUTH_KINDS", frozenset({"git-update"}))
        monkeypatch.setattr(jobs, "ensure_jobs_root", lambda inst, runner: jobs.jobs_root(inst).mkdir(
            exist_ok=True) or jobs.jobs_root(inst))
        launched = {}
        monkeypatch.setattr(jobs, "launch_runner", lambda inst, job_id, token=None: launched.update(token=token) or 1)
        plan = actions.plan_git_update(app.inst, "match", [], [])
        app._start_worker(plan)
        job_id = app.queue.get_nowait()[1]
        assert launched["token"] == "tok.en-1"
        request = (jobs.job_dir(app.inst, job_id) / "request.json").read_text(encoding="utf-8")
        assert '"login_email": "admin@x"' in request and "tok.en-1" not in request
        app.logout()
        assert app.session is None
        app._start_worker(plan)
        assert app.queue.get_nowait()[1].reasons == ("관리자 로그인이 필요합니다",)
    finally:
        root.destroy()


# ---------- 2단계 ③ 생성 접수 ----------

SERVER = {"port": 8010, "pid": 4321, "created": 77, "nonce": "c" * 32, "build_id": "b" * 32}


def test_intake_plan_targets_the_server_and_both_values(tmp_path):
    inst = make_inst(tmp_path)
    plan = actions.plan_intake_set(inst, SERVER, False, True)
    assert plan.kind == "intake-set" and plan.params == {"server": SERVER, "from": False, "paused": True}
    assert "intake-set" in actions.AUTH_KINDS and "[다시 받기]" in " ".join(plan.summary)
    assert "이미 '멈춤'" in actions.plan_intake_set(inst, SERVER, True, True).reasons[0]
    assert "알 수 없습니다" in actions.plan_intake_set(inst, SERVER, True, "yes").reasons[0]
    # 업데이트 흔적·미확인 작업이 있어도 접수는 바꿀 수 있다(멈춘 채 갇히지 않게)
    assert isinstance(actions.plan_intake_set(make_inst(tmp_path, problems=("not_git_clone",)), SERVER, True, False),
                      actions.Plan)


def _fake_calls(monkeypatch, answers):
    from server_console import server_api
    sent = []

    def call(server, method, path, token="", body=None, timeout=15.0):
        sent.append((method, body, token))
        return answers.pop(0)
    monkeypatch.setattr(server_api, "call", call)
    return server_api, sent


@pytest.mark.parametrize("answers,expected", [
    ([(200, {"paused": True}), (200, {"paused": True})], True),
    ([(None, None), (200, {"paused": True})], True),                    # 응답만 잃음 — 다시 읽어 바뀐 것 확인
    ([(None, None), (200, {"paused": False})], "값도 바뀌지 않았습니다"),
    ([(200, {"paused": False}), (200, {"paused": False})], "다른 값"),
    ([(200, {"paused": True}), (200, {"paused": False})], "다시 읽은 값"),
    ([(401, {"detail": "만료"}), (200, {"paused": True})], "다시 로그인하세요"),
    ([(500, {"detail": "DB 잠김"}), (200, {"paused": True})], "DB 잠김"),
])
def test_intake_change_is_read_back_from_the_server(monkeypatch, answers, expected):
    server_api, sent = _fake_calls(monkeypatch, list(answers))
    if expected is True:
        assert server_api.set_intake(SERVER, "tok", True) is True
        assert sent[0] == ("PUT", {"paused": True}, "tok") and sent[1][0] == "GET"
    else:
        with pytest.raises(server_api.ServerError, match=expected) as caught:
            server_api.set_intake(SERVER, "tok", True)
        assert isinstance(caught.value, server_api.AuthExpired) == ("로그인" in expected)


def test_intake_read_needs_a_boolean_and_names_lost_answers(monkeypatch):
    server_api, _ = _fake_calls(monkeypatch, [(200, {"paused": "1"}), (None, None), (403, None)])
    with pytest.raises(server_api.ServerError, match="형식"):
        server_api.read_intake(SERVER, "tok")
    with pytest.raises(server_api.ServerError, match="응답을 받지 못했습니다"):
        server_api.read_intake(SERVER, "tok")
    with pytest.raises(server_api.AuthExpired):
        server_api.read_intake(SERVER, "tok")


def _intake_job(tmp_path, paused_now=False, want=True):
    inst = make_inst(tmp_path)
    plan = actions.plan_intake_set(inst, SERVER, paused_now, want)
    return inst, plan, jobs.new_job(inst, plan, fake_runner(), login_email="admin@x")


@pytest.mark.parametrize("server_now,value_now,set_result,status_text,check", [
    (SERVER, False, True, "finished", lambda s: s["exit_code"] == 0 and s["intake"] == {"paused": True}),
    (dict(SERVER, pid=9), False, True, "refused", lambda s: "다릅니다" in s["reasons"][0]),       # 서버가 바뀜
    (SERVER, True, True, "refused", lambda s: "이미" in s["reasons"][0]),                       # 다른 곳에서 이미 바꿈
    (SERVER, False, "expired", "finished", lambda s: s["exit_code"] == 1 and s["auth_expired"] is True),
    ("down", False, True, "refused", lambda s: "응답" in s["reasons"][0]),
])
def test_intake_runner_rechecks_then_changes(tmp_path, monkeypatch, server_now, value_now, set_result, status_text,
                                             check):
    from server_console import job_main, server_api
    inst, plan, job_id = _intake_job(tmp_path)

    def verify(inst, runner):
        if server_now == "down":
            raise server_api.ServerError("8010 포트를 듣는 프로세스가 없습니다(서버가 꺼져 있을 수 있음) — 응답 없음")
        return server_now

    def set_intake(server, token, paused):
        assert server == SERVER and token == "tok.en-1" and paused is True
        if set_result == "expired":
            raise server_api.AuthExpired(f"서버가 로그인을 받지 않았습니다(401) — {server_api.RELOGIN}")
        return set_result
    monkeypatch.setattr(server_api, "verify_server", verify)
    monkeypatch.setattr(server_api, "read_intake", lambda server, token: value_now)
    monkeypatch.setattr(server_api, "set_intake", set_intake)
    request = jobs.read_json(jobs.job_dir(inst, job_id) / "request.json")
    job_main.run_intake(inst, job_id, request, "tok.en-1")
    state = jobs.read_job(inst, job_id)
    assert state["status"] == status_text and check(state)
    for path in inst.root.rglob("*"):
        if path.is_file():
            assert b"tok.en-1" not in path.read_bytes()


_FAKE_SERVE = textwrap.dedent("""
    import json, os, sys
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    port, nonce, build = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    state = {"paused": False}

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authed(self):
            if self.headers.get("Authorization") != "Bearer tok.en-1":
                self.send(401, {"detail": "로그인이 필요합니다"})
                return False
            return True

        def body(self):
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

        def do_GET(self):
            if self.path == "/api/ready":
                self.send(200, {"status": "ready", "checks": {}, "runtime": {
                    "process_id": os.getpid(), "role": "server", "build_id": build, "execution_nonce": nonce}})
            elif self.authed():
                self.send(200, {"paused": state["paused"]})

        def do_PUT(self):
            if self.authed():
                state["paused"] = bool(self.body()["paused"])
                self.send(200, {"paused": state["paused"]})

        def do_POST(self):
            ok = self.body() == {"email": "admin@x", "password": "pw"}
            self.send(200 if ok else 401, {"account": {"email": "admin@x", "status": "approved",
                                                       "global_roles": ["admin"]}, "token": "tok.en-1"}
                      if ok else {"detail": "이메일 또는 비밀번호가 올바르지 않습니다"})

        def log_message(self, *args):
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
""")


def test_real_listener_is_verified_and_intake_changes_end_to_end(tmp_path):
    """실제 프로세스·PowerShell 포트 조회·명령줄·HTTP 로 서버 확인 → 로그인 → 실행기 작업(토큰 파이프 빼고 전부)."""
    import socket
    from server_console import job_main, server_api
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    inst, script, build, nonce = _server_inst(tmp_path, port=port)
    script.write_text(_FAKE_SERVE, encoding="utf-8")
    server = subprocess.Popen([sys.executable, str(script), str(port), nonce, build],
                              creationflags=subprocess.CREATE_NO_WINDOW)
    runner = lambda argv, timeout: install.run_command(argv, timeout)  # noqa: E731
    try:
        deadline = time.time() + 20
        while status.read_ready(port, timeout=1).code != 200 and time.time() < deadline:
            time.sleep(0.2)
        target = server_api.verify_server(inst, runner)
        assert target["port"] == port and target["nonce"] == nonce and target["build_id"] == build
        with pytest.raises(server_api.ServerError, match="올바르지 않습니다"):
            server_api.login(inst, runner, "admin@x", "wrong")
        session = server_api.login(inst, runner, "admin@x", "pw")
        assert server_api.read_intake(target, session.token) is False
        plan = actions.plan_intake_set(inst, target, False, True)
        job_id = jobs.new_job(inst, plan, fake_runner(), login_email=session.email)
        job_main.run_intake(inst, job_id, jobs.read_json(jobs.job_dir(inst, job_id) / "request.json"), session.token)
        state = jobs.read_job(inst, job_id)
        assert state["status"] == "finished" and state["exit_code"] == 0 and state["intake"] == {"paused": True}
        assert server_api.read_intake(target, session.token) is True
        with pytest.raises(server_api.AuthExpired):
            server_api.read_intake(target, "other-token")
        rows = [json.loads(r) for r in (inst.logs / names.ACTION_LOG).read_text(encoding="utf-8").splitlines()]
        assert [r["result"] for r in rows] == ["started", "success"] and rows[1]["params"]["paused"] is True
    finally:
        server.kill()
        server.wait(10)


def test_ui_intake_page_prefers_the_server_value_and_keeps_both_buttons_honest(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    from server_console import server_api
    try:
        app._handle(("status", _status(None)))  # DB: 받는 중, 진행 중 '?'
        assert app.intake_value.cget("text") == "받는 중" and "DB 읽기(추정" in app.intake_sub.cget("text")
        assert app.pause_button.winfo_manager() == "pack" and not app.resume_button.winfo_manager()
        app._handle(("intake_value", True, time.time()))
        assert app.intake_value.cget("text") == "멈춤" and "서버 값(" in app.intake_sub.cget("text")
        assert "DB 읽기는 '받는 중'" in app.intake_sub.cget("text")
        assert app.resume_button.winfo_manager() == "pack" and not app.pause_button.winfo_manager()

        app.request_intake(False)  # 로그인 전이면 로그인 창부터
        assert app.login_window is not None and app.after_login is not None
        app._close_login()
        app.session = server_api.Session(email="admin@x", server=SERVER, token="tok.en-1")
        app.intake_busy = True
        expired = actions.Refusal((f"생성 접수 읽기: 서버가 로그인을 받지 않았습니다(401) — {server_api.RELOGIN}",))
        app._handle(("intake_plan", expired, None, 0.0))
        assert app.session is None and app.intake_busy is False and "다시 로그인" in app.intake_note.cget("text")

        app.intake_busy = True
        app._handle(("side_started", "intake", "e" * 32))
        app._handle(("side_job", "intake", "e" * 32, {"status": "running"}, ""))
        assert app.intake_busy is True and app.side_jobs == {"intake": "e" * 32}
        done = {"status": "finished", "exit_code": 0, "intake": {"paused": False}, "finished_at": time.time()}
        app._handle(("side_job", "intake", "e" * 32, done, ""))
        assert app.intake_busy is False and app.intake_value.cget("text") == "받는 중" and not app.side_jobs
        assert "완료" in app.intake_note.cget("text")
        app.intake_note.configure(text="")
        app._handle(("side_job", "intake", "e" * 32, done, ""))  # 끝난 뒤 늦게 온 같은 알림은 버린다
        assert app.intake_note.cget("text") == ""
        app.session = server_api.Session(email="admin@x", server=SERVER, token="tok.en-1")
        monkeypatch.setattr(app, "_refresh_intake", lambda: None)
        app.side_jobs["intake"] = "f" * 32
        app._handle(("side_job", "intake", "f" * 32, {"status": "finished", "exit_code": 1, "auth_expired": True,
                                                      "error": f"... — {server_api.RELOGIN}"}, ""))
        assert app.session is None and "실패" in app.intake_note.cget("text")
        app.side_jobs["intake"] = "1" * 32
        app._handle(("side_job", "intake", "1" * 32, {"status": "check_needed"}, ""))
        assert "결과 확인 필요" in app.intake_note.cget("text")
        app._handle(("side_refused", "intake", actions.Refusal(("관리자 로그인이 필요합니다",))))
        assert "관리자 로그인이 필요합니다" in app.intake_note.cget("text")
    finally:
        root.destroy()


def test_last_intake_change_comes_from_the_console_record(tmp_path):
    from server_console import ui
    inst = make_inst(tmp_path)
    assert "기록 없음" in ui.last_intake_text(inst)
    rows = [{"kind": "intake-set", "result": "success", "ts": 1_700_000_000, "params": {"paused": True},
             "login_email": "admin@x"},
            {"kind": "intake-set", "result": "failed", "ts": 1_700_000_100, "params": {"paused": False}}]
    (inst.logs / names.ACTION_LOG).write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n",
                                              encoding="utf-8")
    text = ui.last_intake_text(inst)
    assert "멈춤으로 바꿈" in text and "admin@x" in text
    assert "멈춤" in ui.job_result_text({"status": "finished", "kind": "intake-set", "exit_code": 0,
                                         "intake": {"paused": True}})[0]


# ---------- 2단계 ④ DB·백업 ----------

from server_console import backup  # noqa: E402

GOOD_TASK = {"exists": True, "enabled": True, "running": False, "system": True, "ours": True, "ignore_new": True,
             "last_run": "2026-10-23T03:30:00+00:00", "last_result": 0, "next_run": "2026-10-24T03:30:00+00:00"}


def _machine(monkeypatch, **values):
    monkeypatch.setattr(backup, "machine_env", lambda name: values.get(name, ""))


@pytest.mark.parametrize("values,ok", [
    ({}, True),
    ({"CONTENT_HUB_DATA": "{root}\\backend\\data"}, True),
    ({"CONTENT_HUB_DATA": "{root}\\backend\\data\\"}, True),
    ({"CONTENT_HUB_BACKUP_DIR": "{root}\\backend\\data\\backups"}, True),
    ({"CONTENT_HUB_DATA": "E:\\other\\data"}, False),
    ({"CONTENT_HUB_DATA": "backend\\data"}, False),                       # 상대 경로는 판단하지 않는다
    ({"CONTENT_HUB_BACKUP_DIR": "\\\\NAS\\backups"}, False),
])
def test_backup_supports_only_the_standard_data_paths(tmp_path, monkeypatch, values, ok):
    inst = make_inst(tmp_path)
    _machine(monkeypatch, **{k: v.format(root=inst.root) for k, v in values.items()})
    assert (backup.unsupported_paths(inst) == "") is ok


def test_backup_task_is_read_strictly(tmp_path):
    inst = make_inst(tmp_path)
    raw = {"exists": True, "state": "Ready", "user": "SYSTEM", "action_count": 1, "execute": "cmd.exe",
           "arguments": f'/c call "{inst.root}\\task_launch.bat" backup', "multi": "IgnoreNew",
           "last_run": "2026-10-23T03:30:00.0000000Z", "last_result": 0, "next_run": ""}
    task = backup.task_info(inst, fake_runner(default=(0, json.dumps(raw) + "\n")))
    assert task["ours"] and task["system"] and task["ignore_new"] and task["next_run"] is None
    assert backup.task_problems(task) == []
    for change in ({"arguments": f'/c call "{inst.root}\\task_launch.bat" server backup'}, {"action_count": 2},
                   {"execute": "powershell.exe"}):
        assert not backup.task_info(inst, fake_runner(default=(0, json.dumps({**raw, **change}))))["ours"]
    assert backup.task_info(inst, fake_runner(default=(1, ""))) is None
    assert backup.task_info(inst, fake_runner(default=(0, '{"exists":false}'))) == {"exists": False}
    assert "읽지 못했습니다" in backup.task_problems(None)[0]
    assert "없습니다" in backup.task_problems({"exists": False})[0]
    assert len(backup.task_problems({**GOOD_TASK, "enabled": False, "system": False, "running": True})) == 3


def test_backup_helper_runs_the_root_copier_in_a_child(monkeypatch):
    """도우미 자식이 실제 루트 복사기 코드로 읽고 확인한다(네트워크를 건드리지 않는 경우만)."""
    _machine(monkeypatch)
    data = ROOT / "backend" / "data"  # 이 작업실(위치 파일·결과 파일 없음) — 읽기와 형식·자기 PC 판정만
    inst = install.Installation(root=ROOT, data_dir=data, log_dir=data / "logs", content_db=data / "db" / "x.db",
                                port=8010, port_known=False, python=Path(sys.executable), problems=())
    setting = backup.read_setting(inst)
    assert setting["source"] == "none" and setting["target"] is None and setting["result"] == {"state": "never_run"}
    assert backup.probe(inst, "C:\\not-unc") == 10
    assert backup.probe(inst, "\\\\localhost\\share\\mvhub") == 11
    assert "backup_replicate" not in sys.modules and "mvhub_backup_replicate" not in sys.modules


def test_backup_setting_read_failure_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(backup, "run_command", lambda argv, timeout, env=None: (1, ""))
    with pytest.raises(backup.BackupError):
        backup.read_setting(make_inst(tmp_path))
    monkeypatch.setattr(backup, "run_command", lambda argv, timeout, env=None: (0, '{"target": null}'))
    with pytest.raises(backup.BackupError):
        backup.read_setting(make_inst(tmp_path))


def test_recent_backup_sets_are_grouped_by_stamp(tmp_path, monkeypatch):
    _machine(monkeypatch)
    inst = make_inst(tmp_path)
    folder = inst.data_dir / "backups"
    (folder / "pre-dev2-baseline").mkdir(parents=True)
    for name, size in (("content_hub_20261023_052000_000001.db", 10), ("content_trash_20261023_052000_000001.db", 5),
                       ("manage_hub_20261023_052000_000001.db", 1), ("content_hub_20261022_183500.db", 7),
                       ("manage_hub_20261021_000000.db", 3), ("other.db", 99),
                       ("pre-dev2-baseline/content_hub_20261024_000000.db", 1)):
        (folder / name).write_bytes(b"x" * size)
    rows = backup.recent_sets(inst)
    assert [(r["stamp"], sorted(r["roles"]), r["bytes"]) for r in rows] == [
        ("20261023_052000_000001", ["content", "manage", "trash"], 16), ("20261022_183500", ["content"], 7)]


def _t(text):
    return backup.parse_time(text)


@pytest.mark.parametrize("task,result,expected", [
    (GOOD_TASK, {"state": "success", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "n"}, None),  # 옛 실행
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00", "running": True},
     {"state": "success", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "n"}, None),          # 아직 도는 중
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00"},
     {"state": "success", "started_at": "2026-10-23T04:59:00+00:00", "target_id": "n"}, None),          # 결과가 옛것
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00"},
     {"state": "success", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "old"}, None),        # 다른 위치
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00"},
     {"state": "success", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "n"}, "success"),
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00"},
     {"state": "disabled", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "n"}, "failed"),     # 0 이어도
    ({**GOOD_TASK, "last_run": "2026-10-23T05:00:00+00:00", "last_result": 1},
     {"state": "success", "started_at": "2026-10-23T05:00:01+00:00", "target_id": "n"}, "failed"),
])
def test_copy_result_is_taken_only_from_this_run(task, result, expected):
    requested = _t("2026-10-23T05:00:00+00:00")
    assert backup.copy_verdict(task, result, "n", requested, "2026-10-23T03:30:00+00:00") == expected


def _copy_fakes(monkeypatch, tasks, results, schtasks_code=0):
    tasks, results = list(tasks), list(results)
    monkeypatch.setattr(backup, "task_info", lambda inst, runner: tasks.pop(0) if len(tasks) > 1 else tasks[0])
    monkeypatch.setattr(backup, "read_setting",
                        lambda inst: {"result": results.pop(0) if len(results) > 1 else results[0]})
    calls = []

    def runner(argv, timeout):
        calls.append(argv)
        return schtasks_code, ""
    return runner, calls


def _future(seconds=5):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def test_run_copy_waits_for_this_run_and_reports_each_outcome(tmp_path, monkeypatch):
    inst, lines = make_inst(tmp_path), []
    new_run = {**GOOD_TASK, "last_run": _future()}
    ok = {"state": "success", "started_at": _future(6), "target_id": "n", "copied": 3, "skipped": 4, "failed": 0}
    runner, calls = _copy_fakes(monkeypatch, [GOOD_TASK, {**new_run, "running": True}, new_run], [{}, ok])
    assert backup.run_copy(inst, runner, "n", lines.append, timeout=5, poll=0, sleep=lambda s: None) == (
        0, {"copy": "success", "counts": {"copied": 3, "skipped": 4, "failed": 0}})
    assert calls[0][1:] == ["/Run", "/TN", "MVHub BackupCopy"] and calls[0][0].lower().endswith("schtasks.exe")
    bad = {"state": "failed", "error_code": "target_unavailable", "started_at": _future(6), "target_id": "n"}
    runner, _ = _copy_fakes(monkeypatch, [GOOD_TASK, new_run], [bad])
    assert backup.run_copy(inst, runner, "n", lines.append, timeout=5, poll=0, sleep=lambda s: None) == (
        1, {"copy": "failed", "error_code": "target_unavailable"})
    runner, _ = _copy_fakes(monkeypatch, [{**GOOD_TASK, "running": True}], [{}])
    assert backup.run_copy(inst, runner, "n", lines.append)[1]["copy"] == "not_started"
    runner, _ = _copy_fakes(monkeypatch, [GOOD_TASK], [{}], schtasks_code=1)
    assert backup.run_copy(inst, runner, "n", lines.append)[1]["copy"] == "not_started"
    monkeypatch.setattr(backup, "STALE_RESULT_SECONDS", 0.0)
    runner, _ = _copy_fakes(monkeypatch, [GOOD_TASK, new_run], [{"state": "success", "started_at": "2020-01-01"}])
    assert backup.run_copy(inst, runner, "n", lines.append, timeout=5, poll=0, sleep=lambda s: None)[0] == 3
    runner, _ = _copy_fakes(monkeypatch, [GOOD_TASK, {**new_run, "running": True}], [{}])
    assert backup.run_copy(inst, runner, "n", lines.append, timeout=0.05, poll=0,
                           sleep=lambda s: time.sleep(0.01)) == (
        3, {"copy": "unconfirmed", "error": "제한 시간 안에 결과를 확인하지 못했습니다"})


def _save_fakes(monkeypatch, probe_code, setting, task=GOOD_TASK, after=None):
    monkeypatch.setattr(backup, "probe", lambda inst, target: probe_code)
    monkeypatch.setattr(backup, "read_view", lambda inst, runner, with_sets=True: {
        "unsupported": "", "error": "", "task": task, "setting": setting})
    monkeypatch.setattr(backup, "read_setting", lambda inst: after or {})
    copies = []
    monkeypatch.setattr(backup, "run_copy", lambda inst, runner, expected, say: copies.append(expected) or (
        1, {"copy": "failed", "error_code": "target_unavailable"}))
    return copies


@pytest.mark.parametrize("probe_code,setting,task,why", [
    (12, {"target_id": "o", "source": "file"}, GOOD_TASK, "MV Hub 백업이 아닌 파일"),
    (None, {"target_id": "o", "source": "file"}, GOOD_TASK, "20초"),
    (0, {"target_id": "changed", "source": "file"}, GOOD_TASK, "그 사이"),
    (0, {"target_id": "o", "source": "env"}, GOOD_TASK, "CONTENT_HUB_BACKUP_REPLICA_DIR"),
    (0, {"target_id": "o", "source": "file"}, {**GOOD_TASK, "running": True}, "복사 중"),
])
def test_backup_save_writes_nothing_unless_every_check_passes(tmp_path, monkeypatch, probe_code, setting, task, why):
    inst = make_inst(tmp_path)
    (inst.root / "tools").mkdir()
    copies = _save_fakes(monkeypatch, probe_code, setting, task)
    code, extra = backup.save_work(inst, fake_runner(), {"old_id": "o", "target": "\\\\NAS\\mv"}, lambda line: None)
    assert code == 1 and extra["saved"] is False and why in extra["error"] and copies == []
    assert not (inst.root / "tools" / "backup_replica_target.txt").exists()


def test_backup_save_keeps_the_new_target_when_the_copy_fails(tmp_path, monkeypatch):
    inst = make_inst(tmp_path)
    (inst.root / "tools").mkdir()
    copies = _save_fakes(monkeypatch, 0, {"target_id": "o", "source": "file"},
                         after={"target": "\\\\NAS\\새 폴더", "target_id": "n"})
    lines = []
    code, extra = backup.save_work(inst, fake_runner(), {"old_target": "\\\\NAS\\old", "old_id": "o",
                                                         "target": "\\\\NAS\\새 폴더"}, lines.append)
    assert (inst.root / "tools" / "backup_replica_target.txt").read_bytes() == "\\\\NAS\\새 폴더\n".encode("utf-8")
    assert code == 1 and extra == {"saved": True, "old_target": "\\\\NAS\\old", "copy": "failed",
                                   "error_code": "target_unavailable"}
    assert copies == ["n"] and any("설정 저장됨" in line for line in lines)


def test_backup_plans_carry_the_old_fingerprint_and_refuse_plainly(tmp_path):
    inst = make_inst(tmp_path)
    view = {"unsupported": "", "error": "", "task": GOOD_TASK,
            "setting": {"target": "\\\\NAS\\old", "target_id": "o", "source": "file"}}
    plan = actions.plan_backup_save(inst, view, "  \\\\NAS\\new  ")
    assert plan.params == {"old_target": "\\\\NAS\\old", "old_id": "o", "target": "\\\\NAS\\new"}
    assert actions.plan_backup_run(inst, view).params == {"target_id": "o"}
    assert "같습니다" in actions.plan_backup_save(inst, view, "\\\\nas\\OLD\\").reasons[0]
    assert "적으세요" in actions.plan_backup_save(inst, view, " ").reasons[0]
    env = dict(view, setting={**view["setting"], "source": "env"})
    assert any("CONTENT_HUB_BACKUP_REPLICA_DIR" in r for r in actions.plan_backup_save(inst, env, "\\\\NAS\\x").reasons)
    assert isinstance(actions.plan_backup_run(inst, env), actions.Plan)  # 환경변수 위치도 복사는 된다
    assert "먼저 위치" in actions.plan_backup_run(inst, dict(view, setting={"source": "none"})).reasons[0]
    odd = dict(view, unsupported="지원하지 않는 데이터·백업 경로입니다", task={**GOOD_TASK, "running": True})
    assert len(actions.plan_backup_run(inst, odd, ["a" * 32]).reasons) == 3


def test_ui_backup_page_shows_target_reasons_and_offers_revert(tmp_path, monkeypatch):
    ui, root, app, _errors = _app(tmp_path, monkeypatch)
    try:
        view = {"unsupported": "", "error": "", "task": GOOD_TASK, "sets": [
                    {"stamp": "20261023_052000_000001", "roles": ["content", "trash"], "bytes": 74_000_000}],
                "setting": {"target": "\\\\NAS\\mv", "target_id": "o", "source": "file",
                            "result": {"state": "success", "target_id": "o", "last_success_at": _future(-60)}}}
        app._handle(("backup_view", view))
        assert app.backup_entry.get() == "\\\\NAS\\mv" and app.backup_cards["nas"][0].cget("text") == "정상"
        assert "74 MB" in app.backup_sets.cget("text") and "content · trash" in app.backup_sets.cget("text")
        app.backup_entry.insert("end", "\\new")  # 사람이 고치는 중이면 다시 읽어도 덮지 않는다
        app._handle(("backup_view", view))
        assert app.backup_entry.get() == "\\\\NAS\\mv\\new"
        locked = {**view, "setting": {**view["setting"], "source": "env"}, "task": {**GOOD_TASK, "running": True}}
        app._handle(("backup_view", locked))
        assert "보기만" in app.backup_reasons.cget("text") and "복사 중" in app.backup_reasons.cget("text")
        assert str(app.backup_save.cget("state")) == "disabled"

        app.backup_busy = True
        app._handle(("side_started", "backup", "b" * 32))
        app._handle(("side_job", "backup", "b" * 32, {"status": "running"}, "[05:00:01] 설정 저장됨: …"))
        assert "설정 저장됨" in app.backup_note.cget("text")
        failed = {"status": "finished", "exit_code": 1, "saved": True, "old_target": "\\\\NAS\\old",
                  "copy": "failed", "error_code": "target_unavailable"}
        app._handle(("side_job", "backup", "b" * 32, failed, ""))
        assert "설정은 저장됐고 복사는 실패" in app.backup_note.cget("text") and app.backup_busy is False
        assert app.backup_revert.winfo_manager() == "pack" and app.backup_due is True
        app._handle(("side_refused", "backup", actions.Refusal(("이전 작업(aaaaaaaa)이 진행 중",))))
        assert "하지 않았습니다" in app.backup_note.cget("text")
    finally:
        root.destroy()


@pytest.mark.parametrize("state,expected", [
    ({"status": "finished", "exit_code": 0, "saved": True, "counts": {"copied": 2, "skipped": 5}}, "새로 2 · 그대로 5 (새 위치 저장됨)"),
    ({"status": "finished", "exit_code": 3, "saved": True, "copy": "unconfirmed", "error": "제한 시간"}, "복사 결과는 미확인"),
    ({"status": "finished", "exit_code": 1, "saved": False, "error": "그 위치에 쓸 수 없습니다"}, "실패: 그 위치에 쓸 수 없습니다"),
    ({"status": "finished", "exit_code": 1, "copy": "failed", "error_code": "copy_failed"}, "실패: 복사는 실패했습니다(copy_failed)"),
    ({"status": "check_needed"}, "결과 확인 필요"),
])
def test_backup_result_text_separates_saving_from_copying(state, expected):
    from server_console import ui
    assert expected in ui.backup_result_text(state)[0]
    assert ui._stamp_text("20261023_052000_000001").startswith("2026-10-23")
