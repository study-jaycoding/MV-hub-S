"""공식 exe 후보가 npm 셰임이나 전역 설치를 거치지 않는지 확인한다."""

import importlib.util
import os
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(os.name != "nt", reason="Windows PATH executable resolution")
def test_native_path_is_shared_by_hub_and_agent(tmp_path, monkeypatch):
    from app.services import cli_bridge

    native = tmp_path / "higgsfield.exe"
    native.write_bytes(b"native-fixture-not-executed")
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])
    monkeypatch.setattr(cli_bridge, "_CLI_PATH", None)
    agent = load_file("native_cli_agent", ROOT / "agent_push.py")
    assert Path(cli_bridge.cli_path()) == native
    assert [Path(arg) for arg in cli_bridge.cli_argv()] == [native]
    assert Path(agent._cli()) == native
    assert agent._cli_argv(str(native)) == [str(native)]


def test_launcher_prefers_matching_bundle_then_native_before_global_install():
    source = (ROOT / "MV_agent.bat").read_text("utf-8-sig")
    bundle = source.index('if exist "%BUNDLED%" call :try_cli')
    native = source.index('if not defined HF if exist "%LOCAL_HF%" call :try_cli')
    global_cli = source.index('where higgsfield >nul', native)
    assert bundle < native < global_cli < source.index('install -g @higgsfield/cli')
    assert 'if /i "%HF%"=="%LOCAL_HF%" set "PATH=%ROOT%.mvhub-runtime\\higgsfield;%PATH%"' in source
    assert 'if "%_CLIVER%"=="%HF_CLI_VERSION%" set "HF=%~1"' in source


def test_smoke_candidate_checks_exact_version_without_rewriting_pin(tmp_path, monkeypatch):
    smoke = load_file("native_cli_smoke", ROOT / "tools/hf_cli_contract_smoke.py")
    pin = tmp_path / "pin.txt"
    pin.write_text("1.2.2\n", encoding="utf-8")
    monkeypatch.setattr(smoke, "PIN_FILE", pin)
    monkeypatch.setattr(smoke, "run_json", lambda *args: (None, "offline fixture"))
    monkeypatch.setattr(smoke, "run_text", lambda cli, *args: "higgsfield 1.2.3" if args == ("version",) else "")
    with patch("builtins.print"):
        smoke.main(["--cli", "candidate.exe", "--expected-version", "1.2.3"])
    assert next(item for item in smoke.results if item[1] == "version == pin")[0] == smoke.PASS
    assert pin.read_text() == "1.2.2\n"
    smoke.results.clear()
    with patch("builtins.print"):
        smoke.main(["--cli", "candidate.exe", "--expected-version", "1.2.30"])
    assert next(item for item in smoke.results if item[1] == "version == pin")[0] == smoke.FAIL
