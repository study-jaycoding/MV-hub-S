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
    목록의 마지막 결과는 계속 반복한다. 적히지 않은 명령(workspace set·generate 등)을 부르면 시험이 실패한다."""
    calls: list = []
    sleeps: list = []

    def run(args, **kwargs):
        key = " ".join(arg for arg in args[1:] if arg != "--json")
        calls.append(key)
        outcomes = script.get(key)
        if outcomes is None:
            raise AssertionError(f"기동 점검이 부르면 안 되는 CLI 명령: {key}")
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        if outcome == "timeout":
            raise subprocess.TimeoutExpired(args, kwargs.get("timeout"))
        returncode, stdout, stderr = outcome
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)

    monkeypatch.setattr(agent.subprocess, "run", run)
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
