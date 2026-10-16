"""기동 때 Higgsfield CLI 계정 확인 — 분류와 제한 재시도(81회차 F-C-04).

MV_agent.bat 은 시작 때 `account status` 한 번의 실패(일시 통신 오류 포함)를 '워크스페이스 미선택'으로 보고 그
실행 내내 에이전트를 껐다. 에이전트의 첫 계정 확인도 한 번 실패하면 끝났다. 실제 CLI 는 부르지 않는다(계정 상태를
바꿀 수 있다) — 출력은 가짜, 분류는 기존 _classify_cli_error 그대로. 인증 오류 원문은 공용 fixture
(frontend/tests/fixtures/generationErrorCases.json 'auth')에 있는 실제 CLI 형식이다.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
AGENT_PATH = ROOT / "agent_push.py"

AUTH_ERROR = "Error: Not authenticated. Hint: Run: hf auth login"
NETWORK_ERROR = "Error: connect ETIMEDOUT"
ACCOUNT = json.dumps({"email": "worker@example.test", "credits": 12.5})
SELECTED = json.dumps([{"id": "ws-team", "name": "Team", "is_selected": True}])
NONE_SELECTED = json.dumps([
    {"id": "ws-a", "name": "A", "is_selected": False},
    {"id": "ws-b", "name": "B", "is_selected": False},
])


def _load_agent():
    spec = importlib.util.spec_from_file_location("mvhub_agent_startup_check_target", AGENT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_cli(monkeypatch, agent, script: dict) -> tuple[list, list]:
    """script: {"account status": [결과…], "workspace list": [결과…]} — 결과 = (rc, stdout, stderr) 또는 "timeout".
    목록의 마지막 결과는 계속 반복한다. 적히지 않은 명령(workspace set·generate 등)을 부르면 시험이 실패한다.
    분류만 보는 가짜다 — 시간 초과 때 프로세스를 실제로 끝내고 회수하는지는 아래 실제 프로세스 시험이 본다."""
    calls: list = []
    sleeps: list = []

    def run(args, timeout, env=None):
        key = " ".join(arg for arg in args[1:] if arg != "--json")
        calls.append(key)
        outcomes = script.get(key)
        if outcomes is None:
            raise AssertionError(f"기동 점검이 부르면 안 되는 CLI 명령: {key}")
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        if outcome == "timeout":
            raise subprocess.TimeoutExpired(args, timeout)
        returncode, stdout, stderr = outcome
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)

    monkeypatch.setattr(agent, "_run_with_tree_kill", run)
    monkeypatch.setattr(agent.time, "sleep", sleeps.append)
    return calls, sleeps


@pytest.mark.parametrize(
    "script, state, calls, sleeps",
    [
        pytest.param({"account status": [(0, ACCOUNT, "")]}, "ok", ["account status"], [], id="healthy-asks-once"),
        pytest.param(
            {"account status": [(1, "", NETWORK_ERROR), (0, ACCOUNT, "")], "workspace list": [(1, "", NETWORK_ERROR)]},
            "ok", ["account status", "workspace list", "account status"], [1], id="first-failure-then-success",
        ),
        pytest.param(
            {"account status": ["timeout"], "workspace list": [(0, SELECTED, "")]},
            "unknown", ["account status", "workspace list"] * 3, [1, 2], id="three-failures-stay-unknown",
        ),
        pytest.param({"account status": [(1, "", AUTH_ERROR)]}, "auth", ["account status"], [], id="explicit-auth-error"),
        pytest.param(
            {"account status": [(1, "", "Error: no workspace")], "workspace list": [(0, NONE_SELECTED, "")]},
            "unselected", ["account status", "workspace list"], [], id="parsed-list-without-selection",
        ),
        pytest.param(
            {"account status": [(0, "not-json", "")], "workspace list": [(0, "not-json{", "")]},
            "unknown", ["account status", "workspace list"] * 3, [1, 2], id="bad-json-is-not-unselected",
        ),
    ],
)
def test_agent_startup_classifies_and_bounds_read_retries(monkeypatch, script, state, calls, sleeps):
    agent = _load_agent()
    seen, slept = _fake_cli(monkeypatch, agent, script)

    got, _detail = agent._startup_account_status("hf")

    assert got == state
    assert seen == calls  # 읽기만 — workspace set·생성 제출은 0회
    assert slept == sleeps


def test_agent_first_account_check_retries_a_transient_failure(monkeypatch):
    """배치 점검은 통과했는데 에이전트 첫 계정 확인이 한 번 실패 — 끝내지 않고 다시 물어 계정을 확인한다."""
    agent = _load_agent()
    _calls, slept = _fake_cli(monkeypatch, agent, {
        "account status": [(1, "", NETWORK_ERROR), (0, ACCOUNT, "")],
        "workspace list": [(0, SELECTED, "")],
    })
    reached: list = []
    monkeypatch.setattr(agent, "_cli", lambda: "hf")
    monkeypatch.setattr(agent, "_open_agent_log", lambda: None)
    monkeypatch.setattr(agent, "_acquire_account_mutex", lambda email: reached.append(email) or False)
    monkeypatch.delenv("MVHUB_SESSION_TOKEN", raising=False)
    monkeypatch.setattr(sys, "argv", ["agent_push.py", "--server", "http://127.0.0.1:9", "--token", "t"])

    with pytest.raises(SystemExit):
        agent.main()

    assert reached == ["worker@example.test"]
    assert slept == [1]


def _ws(*rows) -> str:
    return json.dumps([{"id": i, "name": i, "plan_type": plan, "is_selected": sel} for i, plan, sel in rows])


@pytest.mark.parametrize(
    "listing, expected",
    [
        pytest.param((0, _ws(("me", "personal", True), ("team", "team", False)), ""), [], id="existing-choice-kept"),
        pytest.param((0, _ws(("me", "personal", False), ("team", "enterprise", False)), ""), ["team"], id="one-shared"),
        pytest.param((0, _ws(("me", "personal", False)), ""), ["me"], id="only-one"),
        pytest.param((0, _ws(("a", "team", False), ("b", "team", False)), ""), [], id="several-shared-asks"),
        pytest.param((1, "", NETWORK_ERROR), [], id="list-failure-skips"),
    ],
)
def test_startup_autoselect_keeps_the_selection_rules(monkeypatch, listing, expected):
    agent = _load_agent()
    script = {"workspace list": [listing]}
    script.update({f"workspace set {ws_id}": [(0, "", "")] for ws_id in ("me", "team", "a", "b")})
    calls, _slept = _fake_cli(monkeypatch, agent, script)

    agent._startup_autoselect("hf")

    assert calls == ["workspace list"] + [f"workspace set {ws_id}" for ws_id in expected]


# ── 시간 초과된 CLI 를 실제로 끝내고 회수하는가(실제 프로세스) ─────────────────────────────────────

_HANGING_HF = r'''
import os, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.path.join(here, "hf_calls.txt"), "a", encoding="ascii") as log:
    log.write(" ".join(args) + "\n")
if args[:2] == ["workspace", "list"]:
    print('[{"id": "ws-team", "name": "Team", "is_selected": true}]')
    sys.exit(0)
# account status: 출력 파이프를 물려받은 손자를 띄우고 자신도 멈춘다(설치된 CLI 의 Node -> hf.exe 꼴)
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open(os.path.join(here, "pids.txt"), "a", encoding="ascii") as log:
    log.write(f"{os.getpid()} {child.pid}\n")
time.sleep(60)
'''

_DRIVER = r'''
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mvhub_agent_hang_target", sys.argv[1])
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
agent._STARTUP_CHECK_TIMEOUT = 1  # 20초 제한을 시험에서만 줄인다
agent.time.sleep = lambda _seconds: None
state, _detail = agent._startup_account_status(sys.argv[2])
print("STATE=" + state)
'''


def _alive(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT = 아직 살아 있음
    finally:
        kernel32.CloseHandle(handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows 프로세스 트리 전용")
def test_startup_check_timeout_kills_the_cli_tree_and_retries(tmp_path):
    """시간 초과 때 셰임만 죽이면 출력 파이프를 쥔 자식이 남아 회수가 끝나지 않고 재시도로 못 간다(Codex 리뷰 P1)."""
    assert _load_agent()._STARTUP_CHECK_TIMEOUT == 20  # 요청마다 제한 시간
    (tmp_path / "fake_hf.py").write_text(_HANGING_HF, encoding="utf-8")
    hf = tmp_path / "hf.cmd"
    hf.write_text(f'@"{sys.executable}" "%~dp0fake_hf.py" %*\r\n', encoding="ascii")
    driver = subprocess.Popen(
        [sys.executable, "-c", _DRIVER, str(AGENT_PATH), str(hf)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
    )
    try:
        try:
            out, err = driver.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(driver.pid), "/T", "/F"], capture_output=True)
            driver.communicate()
            pytest.fail("시간 초과된 CLI 를 회수하지 못해 기동 점검이 30초 안에 돌아오지 않았다")
        assert "STATE=unknown" in out, out + err
        calls = (tmp_path / "hf_calls.txt").read_text(encoding="ascii").splitlines()
        assert calls.count("account status") == 3  # 시간 초과 뒤에도 다음 재시도로 갔다
        pids = [int(pid) for line in (tmp_path / "pids.txt").read_text(encoding="ascii").split("\n") for pid in line.split()]
        assert len(pids) == 6 and not [pid for pid in pids if _alive(pid)]  # 가짜 CLI 와 손자까지 끝났다
    finally:
        pid_file = tmp_path / "pids.txt"
        for pid in (pid_file.read_text(encoding="ascii").split() if pid_file.exists() else []):
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)


# ── 배치의 자동 선택(점검 앞 단계)도 멈춘 CLI 에 묶이지 않는가(실제 배치 구간 + 실제 프로세스) ──────────

_STALLING_HF = r'''
import os, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
mode = os.environ["FAKE_HF_MODE"]
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.path.join(here, "hf_calls.txt"), "a", encoding="ascii") as log:
    log.write(" ".join(args) + "\n")


def stall():
    # 출력 파이프를 물려받은 손자를 띄우고 자신도 멈춘다(설치된 CLI 의 Node -> hf.exe 꼴)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"])
    with open(os.path.join(here, "pids.txt"), "a", encoding="ascii") as log:
        log.write(f"{os.getpid()} {child.pid}\n")
    time.sleep(90)


if args[:1] == ["auth"]:
    sys.exit(0)
if args[:2] == ["workspace", "list"]:
    if mode == "list-stalls":
        stall()
    print('[{"id": "ws-team", "name": "Team", "plan_type": "team", "is_selected": false},'
          ' {"id": "ws-me", "name": "Me", "plan_type": "personal", "is_selected": false}]')
    sys.exit(0)
if args[:2] == ["workspace", "set"]:
    stall()
if args[:2] == ["account", "status"]:
    print('{"email": "worker@example.test"}')
    sys.exit(0)
sys.exit(9)
'''


_STEP_HF = r'''
import os, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
mode = os.environ["FAKE_HF_MODE"]
raw = sys.argv[1:]
args = [a for a in raw if a != "--json"]
with open(os.path.join(here, "hf_calls.txt"), "a", encoding="ascii") as log:
    log.write(" ".join(raw) + "\n")


def stall():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"])
    with open(os.path.join(here, "pids.txt"), "a", encoding="ascii") as log:
        log.write(f"{os.getpid()} {child.pid}\n")
    time.sleep(90)


if args[:1] == ["version"]:
    if mode == "version-stalls":
        stall()
    print("higgsfield 1.0.0" if mode == "version-old" else "higgsfield 1.1.26")
    sys.exit(0)
if args[:2] == ["auth", "token"]:
    if mode == "token-stalls":
        stall()
    if mode in ("token-error", "token-auth"):
        sys.stderr.write(("Error: Not authenticated. Hint: Run: hf auth login" if mode == "token-auth"
                          else "Error: failed to read the token store") + "\n")
        sys.exit(1)
    print("TOKEN-VALUE-MUST-NOT-SHOW")
    sys.exit(0)
if args[:2] == ["auth", "login"]:
    sys.exit(0)
if args[:2] == ["workspace", "list"]:
    if "--json" not in raw:
        stall()  # 배치의 미선택 안내용 재조회(사람용 표 출력)
    print('[{"id": "ws-a", "name": "A", "plan_type": "team", "is_selected": false},'
          ' {"id": "ws-b", "name": "B", "plan_type": "team", "is_selected": false}]')
    sys.exit(0)
if args[:2] == ["workspace", "set"]:
    sys.exit(0)
if args[:2] == ["account", "status"]:
    if mode == "unselected":
        sys.stderr.write("Error: no workspace\n")
        sys.exit(1)
    print('{"email": "worker@example.test"}')
    sys.exit(0)
sys.exit(9)
'''


def _run_stalling_probe(tmp_path: Path, body: list[str], mode: str) -> tuple[str, list[str], list[int], list[int]]:
    """agent_push.py 사본(제한 1초) + 멈추는 가짜 CLI 로 배치 줄들을 실제 cmd 에서 돌린다. 40초 안에 못 끝나면 실패.
    (출력, CLI 호출, 멈춘 CLI·손자 PID, 그중 아직 살아 있던 PID) — 생존은 시험이 강제로 정리하기 **전에** 본다."""
    source = AGENT_PATH.read_text(encoding="utf-8")
    assert source.count("_STARTUP_CHECK_TIMEOUT = 20\n") == 1
    (tmp_path / "agent_push.py").write_text(
        source.replace("_STARTUP_CHECK_TIMEOUT = 20\n", "_STARTUP_CHECK_TIMEOUT = 1\n"), encoding="utf-8"
    )
    (tmp_path / "fake_hf.py").write_text(_STEP_HF, encoding="utf-8")
    (tmp_path / "hf.cmd").write_text(f'@"{sys.executable}" "%~dp0fake_hf.py" %*\r\n', encoding="ascii")
    probe = tmp_path / "probe.bat"
    probe.write_text("\r\n".join([
        "@echo off",
        "setlocal",
        f'set "ROOT={tmp_path}\\"',
        f'set "PY_EXE={sys.executable}"',
        'set "PY_ARGS="',
        f'set "TEMP={tmp_path}"',
        *body,
    ]) + "\r\n", encoding="ascii")
    runner = subprocess.Popen(
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "FAKE_HF_MODE": mode, "PYTHONUTF8": "1"},
    )
    pid_file = tmp_path / "pids.txt"
    try:
        try:
            out, err = runner.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(runner.pid), "/T", "/F"], capture_output=True)
            runner.communicate()
            pytest.fail("멈춘 CLI 호출에 묶여 40초 안에 다음 단계로 넘어가지 못했다")
        calls = (tmp_path / "hf_calls.txt").read_text(encoding="ascii").splitlines()
        pids = [int(pid) for pid in (pid_file.read_text(encoding="ascii").split() if pid_file.exists() else [])]
        alive = [pid for pid in pids if _alive(pid)]  # 아래 강제 정리 전에 — 제품이 끝냈는지를 본다
        return out + err, calls, pids, alive
    finally:
        for pid in (pid_file.read_text(encoding="ascii").split() if pid_file.exists() else []):
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
def test_agent_bat_token_check_cannot_hang(tmp_path):
    """auth token 확인이 멈추면 제한 시간 뒤 로그인 창을 띄우지 않고 계정 점검으로 넘어간다(Codex 재확인 2 P1)."""
    out, calls, pids, alive = _run_stalling_probe(
        tmp_path, [f'set "HF={tmp_path / "hf.cmd"}"', 'set "RUN_AGENT=1"', *_bat_segment(), "echo RUN_AGENT=%RUN_AGENT%"],
        "token-stalls",
    )
    assert "YOUR HIGGSFIELD CLI ACCOUNT" in out and "RUN_AGENT=1" in out, out
    assert "auth login" not in calls  # 모르는 상태로 사람에게 로그인을 띄우지 않는다
    assert "TOKEN-VALUE-MUST-NOT-SHOW" not in out
    assert len(pids) == 2 and alive == []


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
@pytest.mark.parametrize("mode, login", [("token-error", False), ("token-auth", True)])
def test_agent_bat_opens_login_only_for_an_explicit_auth_error(tmp_path, mode, login):
    """제한 없는 대화형 auth login 은 명시적 인증 오류(_classify_cli_error 'auth')일 때만 — 토큰 저장소 읽기 오류 같은
    비인증 실패는 '확인 불가'로 로그인 창 없이 계정 점검으로 간다(Codex 재확인 3 P2)."""
    out, calls, _pids, _alive_pids = _run_stalling_probe(
        tmp_path, [f'set "HF={tmp_path / "hf.cmd"}"', 'set "RUN_AGENT=1"', *_bat_segment(), "echo RUN_AGENT=%RUN_AGENT%"],
        mode,
    )
    assert ("auth login" in calls) is login, calls
    assert "YOUR HIGGSFIELD CLI ACCOUNT" in out and "RUN_AGENT=1" in out, out


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
def test_agent_bat_unselected_guidance_does_not_query_again(tmp_path):
    """공유 공간이 여럿이라 자동 선택을 건너뛰고 점검이 '미선택'을 내면, 안내는 점검이 이미 받은 목록으로 한다 —
    사람용 목록을 다시 물어 멈추면 앱 창 단계까지 못 갔다(Codex 재확인 2 P1)."""
    out, calls, pids, _alive_pids = _run_stalling_probe(
        tmp_path, [f'set "HF={tmp_path / "hf.cmd"}"', 'set "RUN_AGENT=1"', *_bat_segment(), "echo RUN_AGENT=%RUN_AGENT%"],
        "unselected",
    )
    assert "No Higgsfield workspace selected" in out and "RUN_AGENT=0" in out, out
    assert "ws-a" in out and "ws-b" in out  # 고를 공간이 화면에 보인다
    assert "workspace list" not in calls  # --json 없는 재조회 없음
    assert not [call for call in calls if call.startswith("workspace set")]
    assert pids == []


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
@pytest.mark.parametrize("mode, chosen", [("version-stalls", False), ("version-ok", True)])
def test_try_cli_version_check_cannot_hang(tmp_path, mode, chosen):
    """[3/5] CLI 판 고르기의 `version` 도 제한 시간 + 트리 회수 — 멈추면 그 CLI 를 고르지 않고 넘어간다."""
    lines = (ROOT / "MV_agent.bat").read_bytes().decode("ascii").split("\r\n")
    start = lines.index(":try_cli")
    block = lines[start:lines.index("exit /b 0", start) + 1]
    hf = tmp_path / "hf.cmd"
    out, calls, _pids, alive = _run_stalling_probe(tmp_path, [
        'set "HF="',
        'set "HF_CLI_VERSION=1.1.26"',
        f'call :try_cli "{hf}"',
        "echo HF=[%HF%]",
        "exit /b 0",
        *block,
    ], mode)
    assert (f"HF=[{hf}]" if chosen else "HF=[]") in out, out
    assert calls == ["version"]
    assert alive == []


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
@pytest.mark.parametrize(
    "mode, npm_calls, chosen, shown",
    [
        ("version-stalls", 0, False, "did not answer the version check"),
        ("version-old", 1, False, "No pinned Higgsfield CLI available"),
        ("version-ok", 0, True, "Using Higgsfield CLI 1.1.26"),
    ],
)
def test_agent_bat_cli_selection_never_installs_on_an_unconfirmed_version(tmp_path, mode, npm_calls, chosen, shown):
    """[3/5] 흐름 전체 — 판 확인이 '확인 불가'(시간 초과·실행 실패)면 제한 없는 npm install 로 떨어지지 않고 다음 단계로
    간다. 설치는 판이 확인된 불일치·미설치일 때만(Codex 재확인 3 P1)."""
    lines = (ROOT / "MV_agent.bat").read_bytes().decode("ascii").split("\r\n")
    start = next(i for i, line in enumerate(lines) if line.startswith("echo [3/5]"))
    end = next(i for i, line in enumerate(lines) if line.startswith("echo [4/5]"))
    sub = lines.index(":try_cli")
    try_cli = lines[sub:lines.index("exit /b 0", sub) + 1]
    helper = tmp_path / "backend" / "app" / "services" / "read_utf8_sig_first_line.py"
    helper.parent.mkdir(parents=True)
    helper.write_bytes((ROOT / "backend" / "app" / "services" / "read_utf8_sig_first_line.py").read_bytes())
    (tmp_path / "hf_cli_version.txt").write_text("1.1.26\n", encoding="ascii")
    bundled = tmp_path / "runtime" / "higgsfield" / "higgsfield.cmd"
    bundled.parent.mkdir(parents=True)
    bundled.write_text(f'@"{sys.executable}" "{tmp_path / "fake_hf.py"}" %*\r\n', encoding="ascii")
    npm = tmp_path / "npm.cmd"
    npm.write_text(f'@echo %*>>"{tmp_path / "npm_calls.txt"}"\r\n', encoding="ascii")
    out, calls, _pids, alive = _run_stalling_probe(tmp_path, [
        'set "HAVE_NPM=1"',
        f'set "NPM_CMD={npm}"',
        'set "PATH=%SystemRoot%\\system32;%SystemRoot%"',  # 이 PC 의 실제 전역 CLI 는 부르지 않는다
        *lines[start:end],
        "echo NEXT-STAGE RUN_AGENT=%RUN_AGENT% HF=[%HF%]",
        "exit /b 0",
        *try_cli,
    ], mode)

    npm_log = tmp_path / "npm_calls.txt"
    assert len(npm_log.read_text(encoding="ascii").splitlines() if npm_log.exists() else []) == npm_calls
    assert f"NEXT-STAGE RUN_AGENT={1 if chosen else 0} HF=[{bundled if chosen else ''}]" in out, out
    assert shown in out
    assert calls == ["version"]  # 판 확인만 — 같은 CLI 를 다시 묻지 않는다
    assert alive == []


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
@pytest.mark.parametrize("mode, set_calls", [("list-stalls", 0), ("set-stalls", 1)])
def test_agent_bat_autoselect_cannot_hang_before_the_account_check(tmp_path, mode, set_calls):
    """점검 앞의 자동 선택(workspace list · 조건부 set)에 제한이 없으면 CLI 가 멈출 때 점검·앱 창 열기에 닿지 못한다
    (Codex 재확인 P1). 목록이 멈추면 자동 선택을 건너뛰고, set 은 한 번만 — 재시도하지 않는다."""
    source = AGENT_PATH.read_text(encoding="utf-8")
    assert source.count("_STARTUP_CHECK_TIMEOUT = 20\n") == 1
    # 시험에서만 20초 제한을 1초로 — 배치 구간은 그대로, agent_push.py 는 상수 하나만 바꾼 사본
    (tmp_path / "agent_push.py").write_text(
        source.replace("_STARTUP_CHECK_TIMEOUT = 20\n", "_STARTUP_CHECK_TIMEOUT = 1\n"), encoding="utf-8"
    )
    (tmp_path / "fake_hf.py").write_text(_STALLING_HF, encoding="utf-8")
    hf = tmp_path / "hf.cmd"
    hf.write_text(f'@"{sys.executable}" "%~dp0fake_hf.py" %*\r\n', encoding="ascii")
    probe = tmp_path / "probe.bat"
    probe.write_text("\r\n".join([
        "@echo off",
        "setlocal",
        f'set "ROOT={tmp_path}\\"',
        f'set "PY_EXE={sys.executable}"',
        'set "PY_ARGS="',
        f'set "HF={hf}"',
        f'set "TEMP={tmp_path}"',
        'set "RUN_AGENT=1"',
        *_bat_segment(),
        "echo RUN_AGENT=%RUN_AGENT%",
    ]) + "\r\n", encoding="ascii")
    runner = subprocess.Popen(
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "FAKE_HF_MODE": mode, "PYTHONUTF8": "1"},
    )
    try:
        try:
            out, err = runner.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/PID", str(runner.pid), "/T", "/F"], capture_output=True)
            runner.communicate()
            pytest.fail("자동 선택 단계의 CLI 가 멈춰 40초 안에 계정 점검으로 넘어가지 못했다")
        assert "YOUR HIGGSFIELD CLI ACCOUNT" in out, out + err  # 다음 점검까지 갔다
        assert "RUN_AGENT=1" in out
        calls = (tmp_path / "hf_calls.txt").read_text(encoding="ascii").splitlines()
        assert [call for call in calls if call.startswith("workspace set")] == ["workspace set ws-team"] * set_calls
        assert calls.count("workspace list") == 1  # 자동 선택의 목록 조회도 재시도하지 않는다
        pids = [int(pid) for pid in (tmp_path / "pids.txt").read_text(encoding="ascii").split()]
        assert len(pids) == 2 and not [pid for pid in pids if _alive(pid)]  # 멈춘 CLI 와 손자까지 끝났다
    finally:
        pid_file = tmp_path / "pids.txt"
        for pid in (pid_file.read_text(encoding="ascii").split() if pid_file.exists() else []):
            subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)


# ── MV_agent.bat 의 실제 구간 + 실제 agent_push.py + 가짜 CLI ───────────────────────────────────

_FAKE_HF = r'''
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
mode = os.environ["FAKE_HF_MODE"]
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.path.join(here, "hf_calls.txt"), "a", encoding="ascii") as log:
    log.write(" ".join(args) + "\n")
if args[:1] == ["auth"]:
    sys.exit(0)
if args[:2] == ["workspace", "list"]:
    print(NONE_SELECTED if mode == "unselected" else SELECTED)
    sys.exit(0)
if args[:2] == ["account", "status"]:
    marker = os.path.join(here, "status_failed_once")
    if mode == "transient" and os.path.exists(marker):
        print(ACCOUNT)
        sys.exit(0)
    open(marker, "w").close()
    sys.stderr.write({"auth": AUTH_ERROR, "unselected": "Error: no workspace"}.get(mode, NETWORK_ERROR) + "\n")
    sys.exit(1)
sys.exit(9)
'''


def _bat_segment() -> list[str]:
    """로그인·워크스페이스 점검 구간 — 옛·새 배치에 공통인 표지로 자른다."""
    lines = (ROOT / "MV_agent.bat").read_bytes().decode("ascii").split("\r\n")
    start = next(i for i, line in enumerate(lines) if line.startswith("REM --- Higgsfield login + workspace"))
    end = next(i for i, line in enumerate(lines) if line.startswith('if exist "%TEMP%\\mvhub_acct_status.tmp" del'))
    return lines[start:end + 1]


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 전용")
@pytest.mark.parametrize(
    "mode, run_agent, shown, hidden",
    [
        ("transient", "1", "YOUR HIGGSFIELD CLI ACCOUNT", "No Higgsfield workspace selected"),
        ("down", "0", "Could not confirm the Higgsfield account", "No Higgsfield workspace selected"),
        ("auth", "0", "higgsfield auth login", "No Higgsfield workspace selected"),
        ("unselected", "0", "No Higgsfield workspace selected", "Could not confirm"),
    ],
)
def test_agent_bat_transient_cli_failure_does_not_turn_agent_off(tmp_path, mode, run_agent, shown, hidden):
    bat = (ROOT / "MV_agent.bat").read_bytes()
    assert b"\n" not in bat.replace(b"\r\n", b"")  # CRLF 만
    fake = _FAKE_HF
    for name, value in (("NONE_SELECTED", NONE_SELECTED), ("SELECTED", SELECTED), ("ACCOUNT", ACCOUNT),
                        ("AUTH_ERROR", AUTH_ERROR), ("NETWORK_ERROR", NETWORK_ERROR)):
        fake = fake.replace(name, repr(value))
    (tmp_path / "fake_hf.py").write_text(fake, encoding="utf-8")
    hf = tmp_path / "hf.cmd"
    hf.write_text(f'@"{sys.executable}" "%~dp0fake_hf.py" %*\r\n', encoding="ascii")
    probe = tmp_path / "probe.bat"
    probe.write_text("\r\n".join([
        "@echo off",
        "setlocal",
        f'set "ROOT={ROOT}\\"',
        f'set "PY_EXE={sys.executable}"',
        'set "PY_ARGS="',
        f'set "HF={hf}"',
        f'set "TEMP={tmp_path}"',
        'set "RUN_AGENT=1"',
        *_bat_segment(),
        "echo RUN_AGENT=%RUN_AGENT%",
    ]) + "\r\n", encoding="ascii")

    result = subprocess.run(
        [os.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        env={**os.environ, "FAKE_HF_MODE": mode, "PYTHONUTF8": "1"},
    )

    out = result.stdout
    assert f"RUN_AGENT={run_agent}" in out, out + result.stderr
    assert shown in out
    assert hidden not in out
    calls = (tmp_path / "hf_calls.txt").read_text(encoding="ascii").splitlines()
    assert not [call for call in calls if call.startswith("workspace set")]  # 통신 실패를 계기로 공간을 바꾸지 않는다
    assert not (tmp_path / "mvhub_acct_status.tmp").exists()
