"""실행기의 Claude Code 공식 설치 보장(docs/status/MVAgent_ClaudeCode업데이트_2026-11-10.md 2-v3 7판).

진짜 설치·네트워크는 부르지 않는다 — 판정·잠금·표식은 가짜 설치 함수로, 설치 전용 Job 은 가짜 자식 프로세스(파이썬)로 본다.
가짜 Job 시험의 '손자까지 끝남'은 실제 공식 설치기가 끊겼을 때 남는 상태의 증거가 아니다(설계 2-v3-1, 남은 위험).
"""
from __future__ import annotations

import ast
import ctypes
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows 전용(Job·토큰·파일 잠금)")

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("run_agent_session_claude_install", ROOT / "run_agent_session.py")
launcher = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(launcher)

MARKER_KEYS = {"status", "at", "exit_code", "reason", "version", "last_skip"}


@pytest.fixture
def release(tmp_path, monkeypatch):
    """릴리스 설치처럼 보이는 폴더 + 대화형 일반 사용자 + 공식 판 없음. 진짜 설치 함수는 부르면 실패한다."""
    root = tmp_path / "install"
    root.mkdir()
    (root / "open_link.py").write_text("", encoding="utf-8")
    (root / ".install-activation.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(launcher, "_install_root", lambda: root)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    monkeypatch.delenv("CONTENT_HUB_AUTH", raising=False)
    monkeypatch.delenv("MVHUB_CLAUDE_INSTALL", raising=False)
    monkeypatch.setattr(launcher, "_claude_token_problem", lambda: None)
    state = {"version": None, "probes": []}

    def version(prefix, **_):
        state["probes"].append(prefix)
        return state["version"]

    monkeypatch.setattr(launcher, "_claude_version", version)

    def real_installer(*_args, **_kwargs):
        raise AssertionError("시험이 진짜 설치를 부르면 안 된다")

    monkeypatch.setattr(launcher, "_run_claude_installer", real_installer)
    return state


class FakeInstall:
    """설치 함수 대역 — 부를 때의 표식을 남기고, 성공이면 공식 판을 '돌게' 만든다."""

    def __init__(self, state, result=(0, None), installs=True):
        self.state, self.result, self.installs, self.calls, self.seen = state, result, installs, 0, None

    def __call__(self):
        self.calls += 1
        self.seen = launcher._read_claude_marker()
        if self.installs:
            self.state["version"] = "2.1.400"
        return self.result


def marker():
    return launcher._read_claude_marker()


def write_marker(value):
    path = launcher._claude_marker_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


# ── 판정 ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("setup", ["git", "no_open_link", "no_activation", "server", "switch"])
def test_off_without_calling_installer_or_writing(release, monkeypatch, setup):
    root = launcher._install_root()
    if setup == "git":
        (root / ".git").mkdir()
    elif setup == "no_open_link":
        (root / "open_link.py").unlink()
    elif setup == "no_activation":
        (root / ".install-activation.json").unlink()
    elif setup == "server":
        monkeypatch.setenv("CONTENT_HUB_AUTH", "1")
    else:
        monkeypatch.setenv("MVHUB_CLAUDE_INSTALL", "0")
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "off"
    assert fake.calls == 0 and not launcher._claude_marker_path().exists()


@pytest.mark.parametrize("reason", launcher.CLAUDE_SKIP_REASONS)
def test_token_problem_skips_and_keeps_status(release, monkeypatch, reason):
    monkeypatch.setattr(launcher, "_claude_token_problem", lambda: reason)
    write_marker({"status": "started", "at": 1234})
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == reason
    assert fake.calls == 0
    got = marker()
    assert (got["status"], got["at"], got["last_skip"]["reason"]) == ("started", 1234, reason)  # 상태·시각은 그대로


def test_working_install_is_left_alone(release):
    release["version"] = "2.1.322"
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "ready"
    assert fake.calls == 0 and not launcher._claude_marker_path().exists()
    assert release["probes"] == [[str(launcher._official_claude())]]  # 정확한 경로로 판을 본다


def test_recent_failure_waits_a_day_but_interrupted_start_retries_now(release):
    now = time.time()
    write_marker({"status": "failed", "at": int(now - 3600), "exit_code": 1, "reason": "exit"})
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "recent_failure" and fake.calls == 0
    write_marker({"status": "failed", "at": int(now - 25 * 3600), "exit_code": 1, "reason": "exit"})
    assert launcher.ensure_claude_official(run=fake) == "ok" and fake.calls == 1
    release["version"] = None
    write_marker({"status": "started", "at": int(now - 60)})  # 실행기가 끝나며 끊긴 설치
    assert launcher.ensure_claude_official(run=fake) == "ok" and fake.calls == 2


def test_broken_install_reinstalls_writing_started_first_then_ok(release):
    exe = launcher._official_claude()
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"not a program")  # 파일은 있지만 안 돈다
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "ok"
    assert fake.seen["status"] == "started"  # 설치 전에 started 를 먼저 썼다
    got = marker()
    assert (got["status"], got["version"], got["exit_code"]) == ("ok", "2.1.400", 0)
    assert set(got) <= MARKER_KEYS


@pytest.mark.parametrize(("result", "installs", "reason", "code"), [
    ((1, None), False, "exit", 1),
    ((None, "timeout"), False, "timeout", None),
    ((None, "job"), False, "job", None),
    ((0, None), False, "version_check", 0),
])
def test_failures_are_recorded_without_output(release, result, installs, reason, code):
    write_marker({"last_skip": {"reason": "elevated", "at": 1}})
    fake = FakeInstall(release, result=result, installs=installs)
    assert launcher.ensure_claude_official(run=fake) == "failed"
    got = marker()
    assert (got["status"], got["reason"], got["exit_code"]) == ("failed", reason, code)
    assert got["last_skip"] == {"reason": "elevated", "at": 1}  # 건너뜀은 따로 남는다
    assert set(got) <= MARKER_KEYS and all(len(json.dumps(v)) < 80 for v in got.values())


def test_marker_write_failure_means_no_install(release, monkeypatch):
    monkeypatch.setattr(launcher, "_write_claude_marker", lambda value: False)
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "marker_failed" and fake.calls == 0


def test_lock_held_elsewhere_skips_without_writing(release):
    write_marker({"status": "failed", "at": 5})
    before = launcher._claude_marker_path().read_bytes()
    fake = FakeInstall(release)
    with launcher._claude_install_lock() as held:
        assert held
        assert launcher.ensure_claude_official(run=fake) == "busy"
    assert fake.calls == 0 and launcher._claude_marker_path().read_bytes() == before


def test_second_launcher_during_install_keeps_started_time(release):
    """두 실행기가 겹쳐도 — 설치 중인 쪽이 쥔 잠금 때문에 다른 쪽은 표식을 안 쓴다(started 시각 보존)."""
    inner = {}

    def install():
        inner["started"] = marker()
        inner["second"] = launcher.ensure_claude_official(run=FakeInstall(release))
        inner["after"] = marker()
        release["version"] = "2.1.400"
        return 0, None

    assert launcher.ensure_claude_official(run=install) == "ok"
    assert inner["second"] == "busy" and inner["after"] == inner["started"]


def test_lock_blocks_another_process(release):
    """같은 프로필의 다른 프로세스(다른 실행기·다른 Windows 세션)도 잠금에 막힌다."""
    code = ("import importlib.util;"
            f"s=importlib.util.spec_from_file_location('l',{str(ROOT / 'run_agent_session.py')!r});"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "print(m._claude_install_lock().__enter__())")
    with launcher._claude_install_lock() as held:
        assert held
        other = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert other.stdout.strip() == "False"


# ── 부팅 순서 ────────────────────────────────────────────────────────────────

def test_update_boot_installs_only_after_commit(monkeypatch):
    ran = []
    monkeypatch.setattr(launcher, "_claude_install_quietly", lambda: ran.append(True))
    outcomes = iter([None, None, True])
    monkeypatch.setattr(launcher, "_update_boot_outcome", lambda nonce: next(outcomes))
    launcher._claude_install_after_commit("n" * 32, sleep=lambda s: None)
    assert ran == [True]
    outcomes = iter([None, False])  # 롤백·대체
    launcher._claude_install_after_commit("n" * 32, sleep=lambda s: None)
    assert ran == [True]


def test_start_runs_in_background_only_for_accepted_boot(monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(launcher, "_claude_install_quietly", lambda: gate.wait(5))
    monkeypatch.delenv("MVHUB_ACTIVATION_CONTROL", raising=False)
    named = lambda: [t for t in threading.enumerate() if t.name == "claude-install"]
    try:
        monkeypatch.setattr(launcher, "_boot_would_be_accepted", lambda: False)
        launcher._start_claude_install()
        assert named() == []
        monkeypatch.setattr(launcher, "_boot_would_be_accepted", lambda: True)
        began = time.monotonic()
        launcher._start_claude_install()
        assert time.monotonic() - began < 1  # 앱 기동은 기다리지 않는다
        assert [t.daemon for t in named()] == [True]
    finally:
        gate.set()


def test_main_starts_install_after_link_registration_and_before_the_guard():
    main = next(n for n in ast.parse((ROOT / "run_agent_session.py").read_text(encoding="utf-8")).body
                if isinstance(n, ast.FunctionDef) and n.name == "main")
    calls = [ast.unparse(n.func) for n in ast.walk(main) if isinstance(n, ast.Call)]
    order = [calls.index(name) for name in ("_start_open_link_registration", "_start_claude_install", "run_guarded")]
    assert order == sorted(order)


# ── 판 확인 함수(실제 자식 프로세스) ──────────────────────────────────────────

def _py(code):
    return [sys.executable, "-c", code]


@pytest.mark.parametrize(("code", "expected"), [
    ("print('2.1.322 (Claude Code)')", "2.1.322"),
    ("import sys; print('2.1.322 (Claude Code)'); sys.exit(3)", None),
    ("print('v2.1.322')", None),
    ("print('2.1')", None),
    ("print('')", None),
    ("import sys; sys.stdout.write('9' * 10000)", None),
])
def test_version_check_is_strict(code, expected):
    assert launcher._claude_version(_py(code)) == expected


def test_version_check_times_out_and_missing_file_is_none(tmp_path):
    began = time.monotonic()
    assert launcher._claude_version(_py("import time; time.sleep(30)"), timeout=1) is None
    assert time.monotonic() - began < 10
    assert launcher._claude_version([str(tmp_path / "none.exe")]) is None


def test_version_check_stops_reading_at_the_cap():
    began = time.monotonic()
    code = "import sys\nwhile True: sys.stdout.write('x' * 1024); sys.stdout.flush()"
    assert launcher._claude_version(_py(code), timeout=20) is None
    assert time.monotonic() - began < 10  # 상한을 넘자마자 끊는다(20초를 기다리지 않음)


# ── 설치 전용 Job(실제 자식 프로세스) ─────────────────────────────────────────

def _command(code):
    return sys.executable, subprocess.list2cmdline(_py(code))


def _alive(pid):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(wintypes.HANDLE(handle), 0) != 0
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def _wait_dead(pid, seconds=10):
    deadline = time.monotonic() + seconds
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    return not _alive(pid)


def _grandchild_code(pid_file, then):
    return (f"import subprocess,sys,pathlib,time\n"
            f"p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])\n"
            f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid))\n{then}")


REAL_RUN = launcher._run_claude_installer  # 모듈을 읽은 때의 진짜 함수 — release 고정물이 바꾸기 전


def test_installer_passes_exit_code_and_works_in_local_dir(release, tmp_path):
    seen = tmp_path / "cwd.txt"
    code = f"import os,pathlib,sys; pathlib.Path({str(seen)!r}).write_text(os.getcwd()); sys.exit(7)"
    assert REAL_RUN(_command(code)) == (7, None)
    assert Path(seen.read_text()) == launcher._mvhub_local_dir()


def test_installer_timeout_kills_grandchildren(release, tmp_path):
    pid_file = tmp_path / "pid.txt"
    began = time.monotonic()
    result = REAL_RUN(_command(_grandchild_code(pid_file, "time.sleep(120)")), timeout=3)
    assert result == (None, "timeout") and time.monotonic() - began < 20
    assert _wait_dead(int(pid_file.read_text()))


def test_installer_ends_leftover_grandchildren_after_normal_exit(release, tmp_path):
    pid_file = tmp_path / "pid.txt"
    assert REAL_RUN(_command(_grandchild_code(pid_file, "sys.exit(0)"))) == (0, None)
    assert _wait_dead(int(pid_file.read_text()))


class _Spy:
    """실제 kernel32 에 기대되, 부른 인자를 적고 원하는 함수만 실패시킨다(fail = 늘, fail_first = 처음 n번)."""

    def __init__(self, fail=(), fail_first=None):
        self.real, self.fail, self.fail_first, self.calls = launcher._configure_api(), set(fail), dict(fail_first or {}), {}

    def __getattr__(self, name):
        function = getattr(self.real, name)

        def call(*args):
            self.calls.setdefault(name, []).append(args)
            if name in self.fail or len(self.calls[name]) <= self.fail_first.get(name, 0):
                return 0
            return function(*args)

        return call


def test_installer_job_is_kill_on_close_without_breakaway_suspended_and_windowless(release):
    spy = _Spy()
    assert REAL_RUN(_command("pass"), kernel32=spy) == (0, None)
    limits = spy.calls["SetInformationJobObject"][0][2]._obj
    assert limits.BasicLimitInformation.LimitFlags == launcher.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    create = spy.calls["CreateProcessW"][0]
    assert create[4] is False  # 핸들 상속 없음
    assert create[5] == launcher.CREATE_SUSPENDED | launcher.CREATE_NO_WINDOW  # 탈출 플래그 없음
    assert all(name in spy.calls for name in ("AssignProcessToJobObject", "ResumeThread", "TerminateJobObject"))


def test_installer_job_assignment_failure_kills_the_suspended_process(release, tmp_path):
    ran = tmp_path / "ran.txt"
    spy = _Spy(fail={"AssignProcessToJobObject"})
    code = f"import pathlib; pathlib.Path({str(ran)!r}).write_text('ran')"
    assert REAL_RUN(_command(code), kernel32=spy) == (None, "job")
    assert "ResumeThread" not in spy.calls and spy.calls["TerminateProcess"]
    time.sleep(1)
    assert not ran.exists()  # 멈춘 채 끝났다


def test_install_command_is_the_documented_one():
    application, line = launcher._claude_install_command()
    assert application == str(Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
    assert "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command" in line
    assert "$ProgressPreference='SilentlyContinue'; irm https://claude.ai/install.ps1 | iex" in line
    assert (launcher.CLAUDE_INSTALL_TIMEOUT, launcher.CLAUDE_INSTALL_RETRY_AFTER_FAIL,
            launcher.CLAUDE_VERSION_TIMEOUT, launcher.CLAUDE_VERSION_CAP) == (900, 86400, 20.0, 4096)


def test_launcher_and_hub_agree_on_the_marker(release):
    """허브는 실행기를 import 하지 않는다(갱신 경계) — 표식 경로·상태·까닭 이름을 두 곳에 두고 여기서 맞춘다."""
    from app.services import agent_chat_process as hub
    assert hub.install_marker() == launcher._claude_marker_path()
    assert hub.INSTALL_SKIP_REASONS == set(launcher.CLAUDE_SKIP_REASONS)
    assert hub.INSTALL_RUNNING_SECONDS > launcher.CLAUDE_INSTALL_TIMEOUT
    assert hub.official_claude() == launcher._official_claude()
    fake = FakeInstall(release, result=(None, "timeout"), installs=False)
    launcher.ensure_claude_official(run=fake)
    assert hub.claude_install()["state"] == "failed" and hub.claude_install()["reason"] == "timeout"
    for reason in ("exit", "timeout", "job", "start", "version_check"):
        assert reason in hub.INSTALL_FAIL_REASONS
    launcher._set_claude_status("started")
    assert hub.claude_install()["state"] == "running"  # 실행기가 쓴 started 를 허브가 설치 중으로 읽는다


def test_token_check_matches_an_independent_admin_check_on_this_machine():
    """조회가 늘 실패해 정상 토큰을 거절하는 결함을 잡는다 — 이 PC 의 실제 토큰을 다른 API(IsUserAnAdmin)와 맞춰 본다."""
    got = launcher._claude_token_problem()
    assert got != "token_unknown"
    if ctypes.windll.shell32.IsUserAnAdmin():
        assert got == "elevated"
    else:
        assert got in (None, "not_interactive", "service_account")


@pytest.mark.parametrize(("sid", "interactive", "elevated", "expected"), [
    ("S-1-5-21-1-2-3-1001", True, False, None),
    ("S-1-5-21-1-2-3-1001", True, True, "elevated"),  # UAC 를 끈 관리자도 상승 토큰이면 뺀다
    ("S-1-5-21-1-2-3-1001", False, False, "not_interactive"),
    ("S-1-5-18", True, False, "service_account"),
    ("S-1-5-19", True, False, "service_account"),
    ("S-1-5-20", False, True, "service_account"),
    (None, True, False, "token_unknown"),
])
def test_token_classification(sid, interactive, elevated, expected):
    assert launcher._classify_token(sid, interactive, elevated) == expected


def test_eligibility_is_checked_again_inside_the_lock(release, monkeypatch):
    answers = iter([True, False])  # 잠금 전엔 자격, 잠금을 잡은 뒤엔 아님(그 사이 스위치를 끔 등)
    monkeypatch.setattr(launcher, "_claude_install_eligible", lambda: next(answers))
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "off"
    assert fake.calls == 0 and not launcher._claude_marker_path().exists()


def test_installer_waits_until_job_end_is_confirmed(release):
    """종료 확인(조회)이 실패하면 확인될 때까지 끄고 기다린다 — 확인 못 한 채 돌아가 잠금을 놓지 않게(설치 독립 리뷰 P1)."""
    spy = _Spy(fail_first={"QueryInformationJobObject": 3})
    began = time.monotonic()
    assert REAL_RUN(_command("pass"), kernel32=spy) == (0, None)
    assert len(spy.calls["QueryInformationJobObject"]) >= 4 and len(spy.calls["TerminateJobObject"]) >= 4
    assert time.monotonic() - began >= 3  # 실패할 때마다 1초 쉬고 다시


def test_launcher_killed_mid_install_ends_the_tree_and_next_launch_retries_now(release, tmp_path):
    """실행기가 강제로 끝나면 Job 이 닫혀 손자까지 끝나고, 표식은 started 로 남아 다음 켜짐에 바로 다시 한다."""
    pid_file = tmp_path / "grandchild.pid"
    child = _grandchild_code(pid_file, "time.sleep(120)")
    script = tmp_path / "launch.py"
    script.write_text(
        "import importlib.util, subprocess, sys\nfrom pathlib import Path\n"
        f"s = importlib.util.spec_from_file_location('l', {str(ROOT / 'run_agent_session.py')!r})\n"
        "m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
        f"m._install_root = lambda: Path({str(launcher._install_root())!r})\n"
        "m._claude_token_problem = lambda: None\n"
        "m._claude_version = lambda prefix, **kw: None\n"
        f"m._claude_install_command = lambda: (sys.executable, subprocess.list2cmdline([sys.executable, '-c', {child!r}]))\n"
        "print(m.ensure_claude_official())\n", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(script)], env=dict(os.environ), creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 30
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert pid_file.exists() and marker()["status"] == "started"
        time.sleep(0.3)
        grandchild = int(pid_file.read_text())
        proc.kill()  # 업데이트 워커가 실행기를 강제로 끄는 경우
        proc.wait(10)
        assert _wait_dead(grandchild)
    finally:
        if proc.poll() is None:
            proc.kill()
    assert marker()["status"] == "started"  # 끊긴 설치 — failed 가 아니다
    fake = FakeInstall(release)
    assert launcher.ensure_claude_official(run=fake) == "ok" and fake.calls == 1  # 24시간을 기다리지 않고 바로 다시
