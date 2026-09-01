"""단일 파일 에이전트와 서버 사이의 배포·HTTP 계약 회귀 테스트."""

from __future__ import annotations

import ast
import importlib.util
import io
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from app.models import PendingRequestOut
from app.services import cli_bridge
from app.services.test_snapshot import (
    SNAPSHOT_STAGING_ENV,
    SNAPSHOT_TOKEN_HEADER,
    create_test_snapshot_archive,
)


AGENT_PATH = Path(__file__).resolve().parents[2] / "agent_push.py"
REFRESH_TOOL_PATH = Path(__file__).resolve().parents[2] / "tools" / "refresh_pm_test_data.py"
ROOT_DIR = AGENT_PATH.parent


def _load_agent():
    spec = importlib.util.spec_from_file_location("mvhub_agent_contract_target", AGENT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_refresh_tool():
    spec = importlib.util.spec_from_file_location(
        "mvhub_refresh_tool_contract_target", REFRESH_TOOL_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    tool_dir = str(REFRESH_TOOL_PATH.parent)
    added = tool_dir not in sys.path
    if added:
        sys.path.insert(0, tool_dir)
    try:
        spec.loader.exec_module(module)
    finally:
        if added:
            sys.path.remove(tool_dir)
    return module


def test_agent_remains_single_file_standard_library_only():
    tree = ast.parse(AGENT_PATH.read_text(encoding="utf-8"), filename=str(AGENT_PATH))
    imported_roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_roots.add(node.module.split(".")[0])

    non_stdlib = sorted(
        name for name in imported_roots if name != "__future__" and name not in sys.stdlib_module_names
    )
    assert non_stdlib == []


def test_agent_and_server_share_provider_status_classification_contract():
    """에이전트와 서버 상태표가 달라져 완료를 한쪽만 놓치는 회귀를 막는다."""
    agent = _load_agent()
    assert agent._SUCCESS_RAW == cli_bridge._PROVIDER_SUCCESS
    assert agent._FAILURE_RAW == cli_bridge._PROVIDER_FAILURE
    assert agent._PROCESSING_RAW == cli_bridge._PROVIDER_PROCESSING
    assert agent._ACTION_REQUIRED_RAW == cli_bridge._PROVIDER_ACTION_REQUIRED


def test_agent_error_logs_hide_prompt_text_and_signed_url_queries():
    """실패 로그·실패 사유의 비밀값 계약 — 프롬프트는 길이만, 서명 URL 은 경로만 남는다."""
    agent = _load_agent()
    shown = agent._args_for_log(
        ["generate", "create", "seedance-2.5", "--prompt", "긴 프롬프트 원문", "--duration", "8"]
    )
    assert "긴 프롬프트 원문" not in shown
    assert "<프롬프트 9자>" in shown
    assert "--duration 8" in shown  # 다른 인자는 진단용으로 그대로

    signed = "https://cdn.example.com/a.png?Policy=AAA&Signature=BBB&Key-Pair-Id=CCC"
    assert agent._safe_ref_label(signed) == "https://cdn.example.com/a.png"
    # URL 아닌 레퍼런스 값(asset:/상대경로)은 진단성을 위해 그대로
    assert agent._safe_ref_label("asset:proj|cut01.png") == "asset:proj|cut01.png"
    assert agent._safe_ref_label("/api/media/1.png") == "/api/media/1.png"


def test_masked_password_input_never_writes_plaintext():
    agent = _load_agent()
    keys = iter(["s", "e", "c", "r", "e", "t", "\r"])
    stream = io.StringIO()

    password = agent._masked_password_input(
        "Password: ", _read_key=lambda: next(keys), _stream=stream
    )

    assert password == "secret"
    assert stream.getvalue() == "Password: ******\n"
    assert "secret" not in stream.getvalue()


def test_masked_password_input_handles_backspace_without_exposing_text():
    agent = _load_agent()
    keys = iter(["a", "x", "\b", "b", "\r"])
    stream = io.StringIO()

    password = agent._masked_password_input(
        "Password: ", _read_key=lambda: next(keys), _stream=stream
    )

    assert password == "ab"
    assert stream.getvalue() == "Password: **\b \b*\n"
    assert "ab" not in stream.getvalue()


def test_pull_db_snapshot_code_input_is_masked_too():
    tool = _load_refresh_tool()
    keys = iter(["s", "3", "c", "r", "3", "t", "\r"])
    stream = io.StringIO()

    snapshot_code = tool.masked_password_input(
        "One-time snapshot code: ", _read_key=lambda: next(keys), _stream=stream
    )

    assert snapshot_code == "s3cr3t"
    assert stream.getvalue() == "One-time snapshot code: ******\n"
    assert "s3cr3t" not in stream.getvalue()


def test_agent_requests_browser_pair_without_credentials():
    agent = _load_agent()
    with patch.object(
        agent,
        "_http",
        return_value=(200, {"email": "worker@example.com", "token": "session-token"}),
    ) as http:
        assert agent._request_local_pair("http://hub", "pair-key") == (
            200,
            {"email": "worker@example.com", "token": "session-token"},
        )

    http.assert_called_once_with(
        "POST",
        "http://hub/api/agent/local-pair-token",
        body={"secret": "pair-key"},
    )


def test_bat_launchers_are_ascii_only():
    """루트의 모든 .bat 은 ASCII 만 허용 — 임베디드 PowerShell 페이로드 포함.

    회귀: update_release.bat 의 한글 메시지가 표준 한국어 Windows(ACP=CP949)에서
    페이로드 추출을 깨뜨려(오독이 뒤따르는 ASCII 따옴표를 삼킴) 업데이트가 전멸했다
    (2026-08-14, "The term 'catch' is not recognized"). 빌드 PC 가 ACP=65001 이면
    재현되지 않아 수동 테스트로는 못 잡는다 — 이 테스트가 유일한 방어선이다.
    """
    offenders: list[str] = []
    for bat in sorted(ROOT_DIR.glob("*.bat")):
        data = bat.read_bytes()
        bad_lines = sorted(
            {
                1 + data[:index].count(b"\n")
                for index, byte in enumerate(data)
                if byte > 0x7F
            }
        )
        if bad_lines:
            offenders.append(f"{bat.name} lines {bad_lines[:5]}")
    assert offenders == [], (
        "비ASCII 문자가 든 .bat 발견 — 한글 UI 문구는 프론트(state 매핑)로 옮겨라: "
        + "; ".join(offenders)
    )


def test_refresh_tool_accepts_only_plain_snapshot_server_urls():
    """env 로 들어온 스냅샷 서버 주소는 http://host:port 만 통과한다(https·포트 생략·앞뒤 공백 거부)."""
    tool = _load_refresh_tool()
    assert tool.validate_snapshot_server_url("http://192.168.1.199:8011") == "http://192.168.1.199:8011"
    assert tool.validate_snapshot_server_url("http://192.168.1.199:8011/") == "http://192.168.1.199:8011"
    assert tool.validate_snapshot_server_url("http://mvhub-server:8011") == "http://mvhub-server:8011"
    unsafe = [
        'http://192.168.1.199:8011" & calc',
        "http://192.168.1.199:8011 --unsafe",
        " http://192.168.1.199:8011",
        "http://192.168.1.199:8011 ",
        "https://192.168.1.199:8011",
        "http://192.168.1.199",
        "ftp://192.168.1.199:8011",
        "http://192.168.1.199:8011/api",
        "http://192.168.1.199:8011?x=1",
        "http://user:pw@192.168.1.199:8011",
        "http://192.168.1.199:abc",
        "",
    ]
    for bad in unsafe:
        try:
            tool.validate_snapshot_server_url(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted unsafe snapshot server url: {bad!r}")


def test_refresh_tool_cli_exits_2_on_bad_snapshot_url_without_touching_target(tmp_path):
    """bat 이 넘긴 주소가 형식 밖이면 네트워크·복사 전에 코드 2 로 끝나고 대상 폴더는 그대로다."""
    target = tmp_path / "data_test"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")
    for bad in (
        'http://192.168.1.199:8011" & calc',
        " http://192.168.1.199:8011",  # 앞 공백 — CLI 가 strip 으로 살려 주면 안 된다
        "http://192.168.1.199:8011 ",
        "https://192.168.1.199:8011",
    ):
        result = subprocess.run(
            [sys.executable, str(REFRESH_TOOL_PATH), bad, str(target)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 2, (bad, result.stdout + result.stderr)
        assert "snapshot server must be http://host:port" in result.stdout, bad
    assert (target / "keep.txt").read_text(encoding="utf-8") == "keep"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["data_test"]


def test_test_dev_has_no_console_account_or_password_prompt():
    launcher = (ROOT_DIR / "test_dev.bat").read_text(encoding="utf-8")
    assert "set /p \"MVHUB_AGENT_EMAIL=" not in launcher
    assert "CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET" in launcher
    assert "Log in only in the browser" in launcher


def test_test_dev_starts_vite_only_after_backend_health_check():
    launcher = (ROOT_DIR / "test_dev.bat").read_text(encoding="utf-8")
    agent_launcher = (ROOT_DIR / "MV_agent.bat").read_text(encoding="utf-8")

    assert 'set "MVHUB_DEV_FRONTEND_DIR=%ROOT%frontend"' in launcher
    assert 'set "MVHUB_DEV_FRONTEND_PORT=%FRONTEND_PORT%"' in launcher
    assert "npm.cmd run dev" not in launcher
    assert "Test backend did not become healthy. Vite will not be started." in agent_launcher

    health_check = agent_launcher.index('curl -fsS -o nul "%HUB%/api/health"')
    hub_ready = agent_launcher.index("\n:hubup")
    start_dev_frontend = agent_launcher.index(
        "if defined MVHUB_DEV_FRONTEND_DIR (", hub_ready
    )
    start_dev_call = agent_launcher.index("call :start_dev_frontend", start_dev_frontend)
    browser_open = agent_launcher.index(
        'run_agent_session.py" --open-url "%MVHUB_OPEN_URL%"', start_dev_frontend
    )
    vite_subroutine = agent_launcher.index("\n:start_dev_frontend")
    port_preflight = agent_launcher.index('set "_DEV_EXISTING_PID="', vite_subroutine)
    port_in_use_error = agent_launcher.index(
        "is already in use by PID", port_preflight
    )
    vite_start = agent_launcher.index("npm.cmd run dev", vite_subroutine)
    assert health_check < hub_ready < start_dev_frontend < start_dev_call < browser_open
    assert vite_subroutine < port_preflight < port_in_use_error < vite_start


def test_agent_opens_browser_outside_the_cleanup_job():
    launcher = (ROOT_DIR / "MV_agent.bat").read_text(encoding="utf-8")
    guard = (ROOT_DIR / "run_agent_session.py").read_text(encoding="utf-8")

    assert 'run_agent_session.py" --open-url "%MVHUB_OPEN_URL%"' in launcher
    assert 'start "" "%MVHUB_OPEN_URL%"' not in launcher
    assert "CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW" in guard
    assert "url.dll,FileProtocolHandler" in guard


def test_test_dev_safely_replaces_only_its_own_previous_session():
    launcher = (ROOT_DIR / "test_dev.bat").read_text(encoding="utf-8")
    helper = (ROOT_DIR / "tools" / "replace_dev_session.ps1").read_text(
        encoding="utf-8"
    )

    helper_call = launcher.index("replace_dev_session.ps1")
    frontend_guard = launcher.index('findstr /c:\":%FRONTEND_PORT% \"')
    backend_guard = launcher.index('findstr /c:\":%BACKEND_PORT% \"')
    assert helper_call < frontend_guard < backend_guard
    assert '-Root "%ROOT%."' in launcher
    assert "Find-SessionStopTarget" in helper
    assert "Validate every occupied port before stopping anything" in helper
    assert "run_agent_session.py" in helper
    assert "test_dev.bat" in helper
    assert "taskkill.exe" in helper
    assert "relatedPid" not in helper


def test_server_db_test_launchers_keep_live_and_local_data_isolated():
    push = (ROOT_DIR / "test_push-db.bat").read_text(encoding="utf-8")
    pull = (ROOT_DIR / "test_pull-db.bat").read_text(encoding="utf-8")
    local_server = (ROOT_DIR / "test_dev_server.bat").read_text(encoding="utf-8")

    assert not (ROOT_DIR / "test_server_dev.bat").exists()

    assert 'set "SRC=E:\\MV-hub-S\\backend\\data"' in push
    assert 'set "DST=%ROOT%backend\\data_test_push"' in push
    assert 'set "CONTENT_HUB_DB=%DST%\\db\\content_hub.db"' in push
    assert 'set "CONTENT_HUB_TEST_SNAPSHOT_EXPORT=1"' in push
    assert 'set "CONTENT_HUB_TEST_SNAPSHOT_STAGING=1"' in push
    assert "[guid]::NewGuid().ToString('N')" in push
    assert 'refresh_pm_test_data.py" "%SRC%" "%DST%"' in push
    assert 'set "PORT=8011"' in push

    assert 'set "SERVER=http://192.168.1.199:8011"' in pull
    assert 'set "DST=%ROOT%backend\\data_test"' in pull
    assert "PM_TEST_ADMIN_EMAIL" not in pull
    assert "192.168.1.199:8010" not in pull
    # 서버 이사 뒤 덮어쓰기: MVHUB_SNAPSHOT_SERVER > 기본값. 명령줄 인자(%~1)는 일부러 없다 —
    # %~1 은 파싱 시점에 확장돼 delayed-expansion 보호를 받지 못한다. 값은 !SERVER! 로만 쓰고,
    # 형식 검증(http://host:port)은 refresh_pm_test_data.py 가 한다.
    assert "setlocal EnableExtensions EnableDelayedExpansion" in pull
    assert 'if defined MVHUB_SNAPSHOT_SERVER set "SERVER=!MVHUB_SNAPSHOT_SERVER!"' in pull
    assert "%~1" not in pull
    assert pull.index('set "SERVER=http://192.168.1.199:8011"') < pull.index(
        'set "SERVER=!MVHUB_SNAPSHOT_SERVER!"'
    )
    assert "%SERVER%" not in pull
    assert 'refresh_pm_test_data.py" "!SERVER!" "%DST%"' in pull
    refresh_tool = REFRESH_TOOL_PATH.read_text(encoding="utf-8")
    assert "PM_TEST_SNAPSHOT_TOKEN" in refresh_tool
    assert "/api/auth/login" not in refresh_tool

    assert 'set "HOST=127.0.0.1"' in local_server
    assert 'set "PORT=8011"' in local_server
    assert 'set "TEST_DATA=%ROOT%backend\\data_test"' in local_server
    assert 'set "CONTENT_HUB_DB=%TEST_DB%"' in local_server
    assert 'call "%ROOT%MV_server.bat"' in local_server
    assert "MV_agent.bat" not in local_server
    assert "npm run dev" not in local_server


def test_pull_download_installs_every_db_from_snapshot_bundle(tmp_path, monkeypatch):
    source = tmp_path / "source"
    db_dir = source / "db"
    db_dir.mkdir(parents=True)
    with sqlite3.connect(db_dir / "content_hub.db") as conn:
        conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO generation VALUES('g1')")
    with sqlite3.connect(db_dir / "manage_hub.db") as conn:
        conn.execute("CREATE TABLE team_generation_fact(id TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO team_generation_fact VALUES('fact1')")
    with sqlite3.connect(db_dir / "content_hub_trash.db") as conn:
        conn.execute("CREATE TABLE trashed_generation(id TEXT PRIMARY KEY)")

    archive = create_test_snapshot_archive(source)
    bundle_bytes = archive.read_bytes()
    archive.unlink()
    tool = _load_refresh_tool()
    monkeypatch.setenv("PM_TEST_SNAPSHOT_TOKEN", "single-use-code")
    requested_urls: list[str] = []
    requested_codes: list[str | None] = []

    def fake_urlopen(request, timeout):
        requested_urls.append(request.full_url)
        headers = {name.lower(): value for name, value in request.header_items()}
        requested_codes.append(headers.get(SNAPSHOT_TOKEN_HEADER.lower()))
        return io.BytesIO(bundle_bytes)

    monkeypatch.setattr(tool.urllib.request, "urlopen", fake_urlopen)
    destination = tmp_path / "downloaded"

    tool.download_server_db("http://snapshot", destination)

    assert requested_urls == ["http://snapshot/api/db/export-test-snapshot"]
    assert requested_codes == ["single-use-code"]
    assert (destination / "db" / "content_hub.db").is_file()
    assert (destination / "db" / "manage_hub.db").is_file()
    assert (destination / "db" / "content_hub_trash.db").is_file()


def test_lan_staging_snapshot_has_no_login_capable_account(tmp_path, monkeypatch):
    from app.services import auth
    from app.services.db_scrub import DISABLED_PASSWORD_HASH, TEST_ADMIN_EMAIL

    source = tmp_path / "live"
    db_path = source / "db" / "content_hub.db"
    db_path.parent.mkdir(parents=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE generation(id TEXT PRIMARY KEY)")
        conn.execute(
            "CREATE TABLE account(email TEXT PRIMARY KEY, name TEXT, password_hash TEXT NOT NULL, "
            "status TEXT NOT NULL, global_role TEXT, approved_at TEXT, password_changed_at TEXT)"
        )
        conn.execute(
            "INSERT INTO account(email, name, password_hash, status, global_role) VALUES(?,?,?,?,?)",
            ("admin@company.com", "Admin", auth.hash_password("real-password"), "approved", "admin"),
        )

    tool = _load_refresh_tool()
    monkeypatch.setenv(SNAPSHOT_STAGING_ENV, "1")
    destination = tmp_path / "staging"
    tool.copy_snapshot(source, destination)

    with sqlite3.connect(destination / "db" / "content_hub.db") as conn:
        rows = dict(conn.execute("SELECT email, password_hash FROM account"))
    assert rows["admin@company.com"] == DISABLED_PASSWORD_HASH
    assert not auth.verify_password("real-password", rows["admin@company.com"])
    assert TEST_ADMIN_EMAIL not in rows


def test_pending_response_contains_every_field_the_agent_executes():
    fields = PendingRequestOut.model_fields
    assert {
        "id",
        "gen_id",
        "kind",
        "model",
        "prompt",
        "params",
        "references",
        "claim_phase",
    } <= fields.keys()
    assert fields["id"].is_required()
    assert fields["gen_id"].is_required()
    assert fields["params"].default_factory() == {}
    assert fields["references"].default_factory() == []


def test_gen_request_adapter_builds_claim_url_in_one_place():
    agent = _load_agent()
    with patch.object(agent, "_http", return_value=(200, [])) as http:
        assert agent._claim_pending("http://hub/", "token-1", 16, "agent-1") == (200, [])

    call = http.call_args
    parsed = urlsplit(call.args[1])
    assert call.args[0] == "GET"
    assert parsed.path == "/api/gen-requests/pending"
    # submission-stage: 신 서버에서는 CLI 호출 전/후 상태를 분리한다.
    assert parse_qs(parsed.query) == {
        "limit": ["16"],
        "capability": ["workspace,submission-stage"],
        "agent_id": ["agent-1"],
    }
    assert call.kwargs == {"token": "token-1"}


def test_agent_pending_exists_uses_read_only_workspace_capable_route():
    agent = _load_agent()
    with patch.object(
        agent, "_http", return_value=(200, {"pending": True})
    ) as http, patch.object(agent, "_agent_instance_id", return_value="agent-1"):
        assert agent._pending_exists("http://hub", "token-1") is True

    call = http.call_args
    parsed = urlsplit(call.args[1])
    assert call.args[0] == "GET"
    assert parsed.path == "/api/gen-requests/pending-exists"
    assert parse_qs(parsed.query) == {
        "capability": ["workspace,submission-stage"],
        "agent_id": ["agent-1"],
    }
    assert call.kwargs == {"token": "token-1"}


def test_agent_separates_local_submit_workers_from_remote_in_flight_jobs():
    with patch.dict(
        os.environ,
        {"MVHUB_CLI_SUBMIT_WORKERS": "", "MVHUB_CLI_MAX_IN_FLIGHT": ""},
    ):
        agent = _load_agent()

    assert agent._SUBMIT_WORKERS == 8
    assert agent._MAX_IN_FLIGHT_JOBS == 64
    assert agent._SUBMIT_WORKERS < agent._MAX_IN_FLIGHT_JOBS
    assert agent._claim_capacity(submitting_count=0, active_count=0) == 8
    assert agent._claim_capacity(submitting_count=8, active_count=0) == 0
    assert agent._claim_capacity(submitting_count=0, active_count=63) == 1
    assert agent._claim_capacity(submitting_count=0, active_count=64) == 0


def test_agent_poll_uses_direct_get_as_authority():
    agent = _load_agent()
    active = {
        "job-running": {
            "rid": "request-running",
            "job_id": "job-running",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        },
        "job-done": {
            "rid": "request-done",
            "job_id": "job-done",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        },
    }
    direct_running = {"id": "job-running", "status": "running"}
    direct_done = {
        "id": "job-done",
        "status": "completed",
        "result_url": "https://result",
    }
    with patch.object(
        agent,
        "_run_cli_json",
        side_effect=[(direct_running, None), (direct_done, None)],
    ) as cli_json, patch.object(
        agent,
        "_report_reconcile",
        side_effect=[
            (200, {"outcome": "not_ready", "asset_saved": False}),
            (200, {"outcome": "applied", "asset_saved": True}),
        ],
    ) as reconcile:
        assert agent._poll_active_jobs("http://hub", "token-1", "higgsfield", active) == 1

    assert cli_json.call_args_list[0].args == ("higgsfield", "generate", "get", "job-running")
    assert cli_json.call_args_list[0].kwargs == {"timeout": 120}
    assert cli_json.call_count == 2
    reconcile.assert_any_call(
        "http://hub",
        "token-1",
        "request-done",
        direct_done,
    )
    assert list(active) == ["job-running"]


def test_agent_keeps_waiting_job_active_until_it_really_completes():
    """Higgsfield waiting은 종료가 아니라 대기 상태라 reconcile 하면 안 된다."""
    agent = _load_agent()
    active = {
        "job-waiting": {
            "rid": "request-waiting",
            "job_id": "job-waiting",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
    }
    direct = {"id": "job-waiting", "status": "waiting"}
    with patch.object(
        agent, "_run_cli_json", return_value=(direct, None)
    ), patch.object(
        agent, "_report_reconcile", return_value=(200, {"outcome": "not_ready"})
    ) as reconcile:
        assert agent._poll_active_jobs(
            "http://hub", "token-1", "higgsfield", active
        ) == 0

    reconcile.assert_called_once_with(
        "http://hub", "token-1", "request-waiting", direct
    )
    assert list(active) == ["job-waiting"]


def test_agent_syncs_unknown_and_refresh_job_ids_without_completed_history() -> None:
    agent = _load_agent()
    with patch.object(
        agent,
        "_http",
        return_value=(200, {"unknown": ["job-new"], "refresh": ["job-running"]}),
    ) as http:
        selected = agent._job_ids_to_sync(
            "http://hub", "token-1", ["job-done", "job-running", "job-new"]
        )

    assert selected == {"job-running", "job-new"}
    http.assert_called_once_with(
        "POST",
        "http://hub/api/ingest/known-jobs",
        token="token-1",
        body={"job_ids": ["job-done", "job-running", "job-new"]},
    )


def test_job_ids_to_sync_status_matrix_limits_get_fallback_to_route_missing() -> None:
    """R2 2-A 계약: GET 폴백은 구서버(404/405)만, 그 외 실패=None(보류) — 빈 set 과 구분."""
    agent = _load_agent()

    # 빈 입력: 서버 호출 자체가 없다(전량 목록 강요 금지).
    with patch.object(agent, "_http") as http:
        assert agent._job_ids_to_sync("http://hub", "t", []) == set()
    http.assert_not_called()

    # malformed 200(POST): 보류.
    with patch.object(agent, "_http", return_value=(200, {"unknown": "oops"})) as http:
        assert agent._job_ids_to_sync("http://hub", "t", ["j1"]) is None
    assert http.call_count == 1  # GET 확대 없음

    # 일시 장애(0·401·500·429): 전부 보류, GET 확대 없음.
    for status in (0, 401, 429, 500):
        with patch.object(agent, "_http", return_value=(status, {})) as http:
            assert agent._job_ids_to_sync("http://hub", "t", ["j1"]) is None
        assert http.call_count == 1

    # 구서버(404) → 정상 GET 폴백: 차집합 계산.
    with patch.object(
        agent,
        "_http",
        side_effect=[(404, {}), (200, {"job_ids": ["j1"]})],
    ) as http:
        assert agent._job_ids_to_sync("http://hub", "t", ["j1", "j2"]) == {"j2"}
    assert http.call_count == 2

    # 구서버(405) → GET 실패/깨진 응답: 전량 선택이 아니라 보류.
    for fallback in [(500, {}), (200, {"nope": 1}), (200, {"job_ids": "broken"})]:
        with patch.object(agent, "_http", side_effect=[(405, {}), fallback]) as http:
            assert agent._job_ids_to_sync("http://hub", "t", ["j1", "j2"]) is None
        assert http.call_count == 2


def test_idempotent_reports_back_off_on_transient_but_stop_on_4xx() -> None:
    """R2 3-B 계약: 0/5xx 는 짧은 지연 후 재시도(최대 3회), 4xx 는 지연 없이 즉시 중단."""
    agent = _load_agent()

    for transient in (0, 503):
        with (
            patch.object(agent, "_http", return_value=(transient, {})) as http,
            patch.object(agent.time, "sleep") as sleep,
        ):
            assert agent._begin_submission("http://hub", "t", "r1", "agent-1") is False
        assert http.call_count == 3
        assert sleep.call_count == 2  # 마지막 시도 뒤에는 안 쉰다
        assert all(0 < call.args[0] <= 2.0 for call in sleep.call_args_list)  # 상한 소

    with (
        patch.object(agent, "_http", return_value=(409, {})) as http,
        patch.object(agent.time, "sleep") as sleep,
    ):
        assert agent._begin_submission("http://hub", "t", "r1", "agent-1") is False
    assert http.call_count == 1  # 4xx 즉시 중단
    sleep.assert_not_called()

    # recovery-required 도 같은 계약.
    with (
        patch.object(agent, "_http", return_value=(500, {})) as http,
        patch.object(agent.time, "sleep") as sleep,
    ):
        assert agent._require_submission_recovery("http://hub", "t", "r1") is False
    assert http.call_count == 3
    assert sleep.call_count == 2

    # anchor 재시도: 503 은 지연 재시도, 409 는 즉시 1회 중단(outbox 유지).
    with (
        patch.object(agent, "_http", return_value=(503, {})) as http,
        patch.object(agent.time, "sleep") as sleep,
        patch.object(agent, "_outbox_remove") as outbox_remove,
    ):
        assert agent._anchor_with_retry("http://hub", "t", "me@x", "r1", "job-1") is False
    assert http.call_count == 3
    assert sleep.call_count == 2
    outbox_remove.assert_not_called()
    with (
        patch.object(agent, "_http", return_value=(409, {})) as http,
        patch.object(agent.time, "sleep") as sleep,
        patch.object(agent, "_outbox_remove") as outbox_remove,
    ):
        assert agent._anchor_with_retry("http://hub", "t", "me@x", "r1", "job-1") is False
    assert http.call_count == 1
    sleep.assert_not_called()
    outbox_remove.assert_not_called()


def test_account_cycle_snapshot_shares_cli_calls_within_one_cycle() -> None:
    """R3 3-A 계약: 한 연속 사이클 안에서 account status/workspace list 를 재조회하지 않고,
    사이클 경계·workspace set·재로그인에서 즉시 폐기한다."""
    agent = _load_agent()
    calls: list[tuple] = []

    def fake_cli_json(_cli, *args, **_kw):
        calls.append(args)
        if args[:2] == ("account", "status"):
            return {"email": "me@x.com", "plan": "team"}
        if args[:2] == ("workspace", "list"):
            return []
        return None

    with (
        patch.object(agent, "_cli_json", side_effect=fake_cli_json),
        patch.object(agent, "_cached_cli_version", return_value="1.1.23"),
    ):
        agent._begin_account_cycle()
        # 같은 사이클: email 3회 요청 → CLI 1회, full collect 2회 요청 → status+workspace 각 1회.
        assert agent._cycle_account_email("cli") == "me@x.com"
        assert agent._cycle_account_email("cli") == "me@x.com"
        agent._cycle_collect_account_status("cli")
        agent._cycle_collect_account_status("cli")
        assert agent._cycle_account_email("cli") == "me@x.com"
        status_calls = [c for c in calls if c[:2] == ("account", "status")]
        ws_calls = [c for c in calls if c[:2] == ("workspace", "list")]
        assert len(status_calls) == 2  # email 1 + collect 1 (그 이상 재조회 없음)
        assert len(ws_calls) == 1

        # 사이클 경계: 새 사이클은 새로 조회한다(35초 대기 경계 넘김 금지).
        calls.clear()
        agent._begin_account_cycle()
        agent._cycle_account_email("cli")
        assert [c for c in calls if c[:2] == ("account", "status")]

        # workspace set/재로그인 상당의 무효화: 다음 조회는 즉시 새로 나간다.
        calls.clear()
        agent._invalidate_account_cycle()
        agent._cycle_collect_account_status("cli")
        assert [c for c in calls if c[:2] == ("account", "status")]


def test_account_cycle_does_not_cache_transient_cli_failure() -> None:
    """코덱스 P2: 일시 CLI 실패(None)를 사이클에 고정하지 않는다 — 다음 호출이 재시도·복구."""
    agent = _load_agent()
    responses = [None, {"email": "me@x.com", "plan": "team"}]

    def flaky_cli_json(_cli, *args, **_kw):
        if args[:2] == ("account", "status"):
            return responses.pop(0) if responses else {"email": "me@x.com"}
        if args[:2] == ("workspace", "list"):
            return []
        return None

    with (
        patch.object(agent, "_cli_json", side_effect=flaky_cli_json),
        patch.object(agent, "_cached_cli_version", return_value="1.1.23"),
    ):
        agent._begin_account_cycle()
        assert agent._cycle_account_email("cli") is None  # 첫 시도 실패
        assert "email" not in agent._ACCT_CYCLE  # 실패는 미캐시
        assert agent._cycle_account_email("cli") == "me@x.com"  # 재시도로 복구
        assert agent._ACCT_CYCLE["email"] == "me@x.com"

    # collect 실패(acct 비-dict)도 캐시하지 않는다.
    with patch.object(agent, "_collect_account_status", return_value=(None, {"scope": "unknown"})):
        agent._begin_account_cycle()
        acct, _ws = agent._cycle_collect_account_status("cli")
        assert acct is None
        assert "acct" not in agent._ACCT_CYCLE


def test_periodic_account_report_always_collects_fresh_status() -> None:
    """코덱스 P2: 600초 주기 보고는 사이클 캐시를 쓰지 않는다 — 허브 UI 의 워크스페이스 전환
    (별도 프로세스)이 늦어도 다음 주기 보고에 반드시 반영되도록."""
    agent = _load_agent()
    agent._begin_account_cycle()
    agent._ACCT_CYCLE["acct"] = {"email": "stale@x.com"}
    agent._ACCT_CYCLE["workspace"] = {"scope": "unknown", "id": None, "name": None}
    with (
        patch.object(
            agent, "_collect_account_status", return_value=({"email": "fresh@x.com"}, {})
        ) as collect,
        patch.object(agent, "_http", return_value=(200, {})) as http,
    ):
        assert agent._report_account_status("http://hub", "t", "cli") is True
    collect.assert_called_once()  # 캐시 무시하고 fresh 수집
    assert http.call_count == 1


def test_agent_bat_checks_account_status_with_single_cli_call() -> None:
    """R3 3-A: MV_agent.bat 은 account status 를 검사·표시용으로 두 번 부르지 않는다(1회 캡처)."""
    bat = (AGENT_PATH.parent / "MV_agent.bat").read_text(encoding="ascii")
    status_calls = [
        line for line in bat.splitlines()
        if 'call "%HF%" account status' in line and not line.strip().startswith("REM")
    ]
    assert len(status_calls) == 1
    assert ">" in status_calls[0]  # 출력 캡처(표시용 재호출 없이 type 로 재사용)
    assert "2>&1" in status_calls[0]  # stderr 경고도 종전 표시 호출처럼 보존(코덱스 P3)
    assert 'type "%TEMP%\\mvhub_acct_status.tmp"' in bat


def test_agent_bat_capture_line_preserves_output_and_errorlevel_in_real_cmd() -> None:
    """코덱스 P3: 캡처 라인을 실제 cmd 로 실행 — stdout+stderr 보존과 errorlevel 판정을 함께 검증."""
    import os as os_module
    import subprocess
    import tempfile
    from pathlib import Path

    if os_module.name != "nt":
        return  # Windows cmd 전용 계약
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        stub = tmp_path / "hf.cmd"
        stub.write_text(
            "@echo off\r\necho ACCOUNT-LINE\r\n>&2 echo WARN-LINE\r\nexit /b %HF_RC%\r\n",
            encoding="ascii",
        )
        capture = tmp_path / "mvhub_acct_status.tmp"
        probe = tmp_path / "probe.bat"
        probe.write_text(
            "\r\n".join(
                [
                    "@echo off",
                    "setlocal",
                    f'set "HF={stub}"',
                    f'call "%HF%" account status > "{capture}" 2>&1',
                    "if errorlevel 1 (echo BRANCH-FAIL) else (type \"" + str(capture) + "\")",
                ]
            ),
            encoding="ascii",
        )
        env = {**os_module.environ, "HF_RC": "0"}
        ok = subprocess.run(
            [os_module.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
            capture_output=True, text=True, timeout=15, env=env,
        )
        assert "ACCOUNT-LINE" in ok.stdout
        assert "WARN-LINE" in ok.stdout  # 2>&1 — stderr 경고 보존
        assert "BRANCH-FAIL" not in ok.stdout
        env["HF_RC"] = "1"
        fail = subprocess.run(
            [os_module.environ.get("ComSpec", "cmd.exe"), "/d", "/c", "call", str(probe)],
            capture_output=True, text=True, timeout=15, env=env,
        )
        assert "BRANCH-FAIL" in fail.stdout  # errorlevel 보존 → 실패 분기


def test_file_fingerprint_coalesces_concurrent_hashing() -> None:
    """R3 3-C 계약: 같은 파일 동시 해시는 1회 계산으로 합치고, 파일이 바뀌면 재계산한다."""
    import tempfile
    import threading
    from pathlib import Path

    agent = _load_agent()
    agent._fp_cache.clear()
    agent._fp_inflight.clear()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        target = Path(tmp) / "ref.png"
        target.write_bytes(b"payload-1" * 1000)
        compute_calls: list[str] = []
        started = threading.Event()
        release = threading.Event()
        original = agent._compute_file_fingerprint

        def slow_compute(path: str):
            compute_calls.append(path)
            started.set()
            release.wait(5)
            return original(path)

        results: list = []
        with patch.object(agent, "_compute_file_fingerprint", side_effect=slow_compute):
            threads = [
                threading.Thread(target=lambda: results.append(agent._file_fingerprint(str(target))))
                for _ in range(4)
            ]
            for t in threads:
                t.start()
            assert started.wait(5)
            release.set()
            for t in threads:
                t.join(10)

        assert len(results) == 4 and len({fp for fp in results}) == 1  # 동일 결과 공유
        assert len(compute_calls) == 1  # 전체 읽기 해시는 1회
        assert agent._fp_inflight == {}  # 선점 누수 없음

        # 파일 변경(mtime/size) → 키가 달라져 재계산.
        target.write_bytes(b"payload-2" * 2000)
        with patch.object(
            agent, "_compute_file_fingerprint", side_effect=original
        ) as recompute:
            fresh = agent._file_fingerprint(str(target))
        assert fresh is not None and fresh != results[0]
        assert recompute.call_count == 1

        # 실패(파일 소실)는 캐시되지 않는다.
        agent._fp_cache.clear()
        missing = str(Path(tmp) / "no-such.png")
        assert agent._file_fingerprint(missing) is None
        assert agent._fp_cache == {}


def test_file_fingerprint_mid_hash_change_returns_but_never_caches() -> None:
    """코덱스 P3: 해시 '도중' 파일이 바뀌면(stat 변화) 결과는 종전처럼 반환하되 재사용 캐시는 금지."""
    import os as os_module
    import tempfile
    import time as time_module
    from pathlib import Path

    agent = _load_agent()
    agent._fp_cache.clear()
    agent._fp_inflight.clear()
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        target = Path(tmp) / "ref.png"
        target.write_bytes(b"before" * 500)
        original = agent._compute_file_fingerprint

        def mutating_compute(path: str):
            result = original(path)
            # 계산이 끝난 직후(반환 전) 파일이 바뀐 상황 재현 — mtime_ns 를 강제로 이동.
            stale = time_module.time() - 3600
            os_module.utime(path, (stale, stale))
            return result

        with patch.object(agent, "_compute_file_fingerprint", side_effect=mutating_compute):
            fp = agent._file_fingerprint(str(target))
        assert fp is not None  # 그 호출에는 종전 동작대로 반환
        assert agent._fp_cache == {}  # 변경 감지 → 재사용 금지
        assert agent._fp_inflight == {}


def test_missing_reference_reconcile_report_stops_immediately_on_4xx() -> None:
    """미부착 실패 보고도 4xx 는 지연 없이 즉시 중단(다음 재조정 사이클이 재평가)."""
    agent = _load_agent()
    tracked = {"rid": "r1", "job_id": "job-1", "expected_image_inputs": 1}
    with (
        patch.object(agent, "_provider_status_kind", return_value="success"),
        patch.object(agent, "_job_image_input_count", return_value=0),
        patch.object(agent, "_suppress_job"),
        patch.object(agent, "_report_reconcile", return_value=(409, {})) as report,
        patch.object(agent.time, "sleep") as sleep,
    ):
        ok = agent._finalize_tracked_job(
            "http://hub", "t", "cli", tracked, {"id": "job-1"}, detailed=True
        )
    assert ok is False
    assert report.call_count == 1
    sleep.assert_not_called()


def test_push_once_holds_cycle_without_ingest_when_sync_undetermined() -> None:
    """판별 보류(None)면 이번 사이클의 /api/ingest 전송을 하지 않는다(전량 재전송 방지)."""
    agent = _load_agent()
    calls: list[str] = []

    def fake_http(method, url, **kwargs):
        calls.append(url)
        return (0, {})  # known-jobs POST 실패 → 보류

    with (
        patch.object(agent, "_cli_json", return_value=[{"id": "j1"}]),
        patch.object(agent, "_http", side_effect=fake_http),
    ):
        agent.push_once("http://hub", "t", "cli", 100)

    assert [u for u in calls if u.endswith("/api/ingest")] == []  # ingest 미전송
    assert any(u.endswith("/api/ingest/known-jobs") for u in calls)


def test_agent_only_gets_terminal_job_detail_when_reference_validation_needs_it():
    agent = _load_agent()
    active = {
        "job-done": {
            "rid": "request-done",
            "job_id": "job-done",
            "expected_image_inputs": 1,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
    }
    detailed = {
        "id": "job-done",
        "status": "completed",
        "result_url": "https://result",
        "params": {"input_images": ["image-1"]},
    }

    with patch.object(
        agent,
        "_run_cli_json",
        return_value=(detailed, None),
    ) as cli_json, patch.object(
        agent,
        "_report_reconcile",
        return_value=(200, {"outcome": "applied", "asset_saved": True}),
    ) as reconcile:
        assert agent._poll_active_jobs("http://hub", "token-1", "higgsfield", active) == 1

    assert cli_json.call_args_list[0].args == (
        "higgsfield",
        "generate",
        "get",
        "job-done",
    )
    assert cli_json.call_args_list[0].kwargs == {"timeout": 120}
    reconcile.assert_called_once_with(
        "http://hub",
        "token-1",
        "request-done",
        detailed,
    )
    assert active == {}


def test_agent_does_not_launch_one_wait_process_per_remote_job():
    source = AGENT_PATH.read_text(encoding="utf-8")

    assert '"generate", "wait"' not in source
    assert "슬롯 비는 대로 채움" not in source
    assert "최대 {_MAX_CONCURRENCY}개 병렬" not in source
    assert 'os.environ.pop("MVHUB_SESSION_TOKEN", None)' in source


def test_agent_startup_refreshes_only_server_selected_jobs() -> None:
    """초기 cycle도 전량 재전송하지 않고 서버가 고른 진행중 항목만 동기화한다."""
    agent = _load_agent()
    with patch.object(agent, "execute_pending") as execute, patch.object(
        agent, "tracking_pass"
    ) as tracking, patch.object(agent, "push_once") as push:
        agent._initial_cycle("http://hub", "token-1", "higgsfield", 100, False)

    execute.assert_called_once_with("http://hub", "token-1", "higgsfield")
    tracking.assert_called_once_with("http://hub", "token-1", "higgsfield")
    push.assert_called_once_with("http://hub", "token-1", "higgsfield", 100)


def test_agent_startup_keeps_no_push_mode_local() -> None:
    agent = _load_agent()
    with patch.object(agent, "execute_pending") as execute, patch.object(
        agent, "tracking_pass"
    ) as tracking, patch.object(agent, "push_once") as push:
        agent._initial_cycle("http://hub", "token-1", "higgsfield", 100, True)

    execute.assert_called_once()
    tracking.assert_called_once()
    push.assert_not_called()


def test_agent_idle_rechecks_db_pending_without_signal() -> None:
    """서버 재시작으로 메모리 신호가 사라져도 다음 idle이 영속 큐를 집어간다."""
    agent = _load_agent()
    with patch.object(agent, "_pending_exists", return_value=True) as pending, patch.object(
        agent, "execute_pending"
    ) as execute:
        agent._execute_pending_for_watch_cycle(
            "http://hub", "token-1", "higgsfield", set()
        )

    pending.assert_called_once_with("http://hub", "token-1")
    execute.assert_called_once_with("http://hub", "token-1", "higgsfield")


def test_agent_has_no_removed_cycle_callback_references() -> None:
    """계정 전환/재로그인 분기도 현재 초기화 함수(_initial_cycle(server, ...))를 호출해야 한다.
    (종전 가드는 임의의 "cycle()" 부분 문자열 금지였는데, R3 3-A 의 _begin_account_cycle() 같은
    정당한 무인자 함수까지 오탐해 레거시 무인자 초기화 호출만 정확히 금지한다.)"""
    source = AGENT_PATH.read_text(encoding="utf-8")

    assert "_initial_cycle()" not in source
    assert "initial_cycle(server" in source  # 현재 시그니처 호출이 실제로 존재


def test_agent_syncs_unknown_and_refresh_job_ids_without_completed_history() -> None:
    agent = _load_agent()
    with patch.object(
        agent,
        "_http",
        return_value=(
            200,
            {"unknown": ["job-new"], "refresh": ["job-running"]},
        ),
    ) as http:
        selected = agent._job_ids_to_sync(
            "http://hub", "token-1", ["job-done", "job-running", "job-new"]
        )

    assert selected == {"job-running", "job-new"}
    http.assert_called_once_with(
        "POST",
        "http://hub/api/ingest/known-jobs",
        token="token-1",
        body={"job_ids": ["job-done", "job-running", "job-new"]},
    )


def test_execute_pending_claims_only_current_submit_worker_capacity():
    agent = _load_agent()
    request = {"id": "request-1", "model": "model-1", "references": []}
    tracked = {
        "rid": "request-1",
        "job_id": "job-1",
        "expected_image_inputs": 0,
        "deadline": float("inf"),
        "next_direct_check": 0.0,
    }
    claim_limits: list[int] = []

    def claim_once(_server, _token, limit, _agent_id):
        claim_limits.append(limit)
        return (200, [request] if len(claim_limits) == 1 else [])

    def finish_active(_server, _token, _cli, active, _account_email):
        active.clear()
        return 1

    with patch.object(agent, "_cli_account_email", return_value="user@example.com"), patch.object(
        agent, "_load_upload_cache", return_value={}
    ), patch.object(agent, "_claim_pending", side_effect=claim_once), patch.object(
        agent, "_resolve_refs_for", side_effect=lambda _s, _t, _r, cache: (cache, [])
    ), patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_submit_one", return_value=tracked
    ), patch.object(agent, "_poll_active_jobs", side_effect=finish_active):
        assert agent.execute_pending("http://hub", "token-1", "higgsfield") == 1

    assert claim_limits
    assert claim_limits[0] == agent._SUBMIT_WORKERS
    assert max(claim_limits) <= agent._SUBMIT_WORKERS


def test_agent_switches_and_verifies_team_workspace_before_submit():
    agent = _load_agent()
    before = [
        {"id": "personal-1", "name": None, "is_selected": True},
        {"id": "team-1", "name": "MILLIONVOLT", "is_selected": False},
    ]
    after = [
        {"id": "personal-1", "name": None, "is_selected": False},
        {"id": "team-1", "name": "MILLIONVOLT", "is_selected": True},
    ]
    with patch.object(agent, "_run_cli_json", side_effect=[(before, None), (after, None)]), patch.object(
        agent, "_run_cli_command", return_value=None
    ) as command:
        ok, error = agent._ensure_request_workspace(
            "higgsfield", {"scope": "team", "id": "team-1", "name": "MILLIONVOLT"}
        )

    assert ok is True
    assert error is None
    command.assert_called_once_with("higgsfield", "workspace", "set", "team-1", timeout=60)


def test_agent_resolves_personal_workspace_without_storing_its_cli_id():
    agent = _load_agent()
    workspaces = [
        {"id": "personal-1", "name": None, "is_selected": False},
        {"id": "team-1", "name": "MILLIONVOLT", "is_selected": True},
    ]
    after = [
        {"id": "personal-1", "name": None, "is_selected": True},
        {"id": "team-1", "name": "MILLIONVOLT", "is_selected": False},
    ]
    with patch.object(agent, "_run_cli_json", side_effect=[(workspaces, None), (after, None)]), patch.object(
        agent, "_run_cli_command", return_value=None
    ) as command:
        ok, error = agent._ensure_request_workspace(
            "higgsfield", {"scope": "personal", "id": None, "name": None}
        )

    assert ok is True
    assert error is None
    command.assert_called_once_with("higgsfield", "workspace", "set", "personal-1", timeout=60)


def test_agent_refuses_missing_team_workspace_without_falling_back():
    agent = _load_agent()
    workspaces = [{"id": "personal-1", "name": None, "is_selected": True}]
    with patch.object(agent, "_run_cli_json", return_value=(workspaces, None)), patch.object(
        agent, "_run_cli_command"
    ) as command:
        ok, error = agent._ensure_request_workspace(
            "higgsfield", {"scope": "team", "id": "missing", "name": "OTHER"}
        )

    assert ok is False
    assert "찾을 수 없습니다" in str(error)
    command.assert_not_called()


def test_agent_refuses_unknown_workspace_without_using_current_cli_selection():
    agent = _load_agent()
    with patch.object(agent, "_run_cli_json") as read_workspaces, patch.object(
        agent, "_run_cli_command"
    ) as command:
        ok, error = agent._ensure_request_workspace("higgsfield", None)

    assert ok is False
    assert "워크스페이스 정보가 없습니다" in str(error)
    assert "다시 선택" in str(error)
    read_workspaces.assert_not_called()
    command.assert_not_called()


def test_agent_unknown_workspace_fails_request_before_generate_create():
    agent = _load_agent()
    request = {
        "id": "request-unknown-workspace",
        "model": "nano-banana",
        "prompt": "test",
        "params": {},
        "references": [],
    }
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_run_cli_json"
    ) as run_cli_json, patch.object(agent, "_fail") as fail:
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            request,
            {},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result is None
    run_cli_json.assert_not_called()
    fail.assert_called_once()
    assert fail.call_args.args[:3] == (
        "http://hub",
        "token-1",
        "request-unknown-workspace",
    )
    assert "생성하지 않음" in fail.call_args.args[3]


def _submission_request(*, staged: bool = True):
    request = {
        "id": "request-1",
        "model": "nano-banana",
        "prompt": "test prompt",
        "params": {},
        "references": [],
        "workspace": {"scope": "personal", "id": None, "name": None},
    }
    if staged:
        request["claim_phase"] = "claimed"
    return request


def test_staged_agent_gets_server_ack_before_paid_cli_create():
    agent = _load_agent()
    job_id = "12345678-1234-1234-1234-123456789abc"
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_ensure_request_workspace", return_value=(True, None)
    ), patch.object(agent, "_begin_submission", return_value=True) as begin, patch.object(
        agent, "_run_cli_json", return_value=([job_id], None)
    ) as create, patch.object(agent, "_outbox_add") as outbox, patch.object(
        agent, "_anchor_with_retry", return_value=True
    ):
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            _submission_request(),
            {},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result and result["job_id"] == job_id
    begin.assert_called_once()
    assert begin.call_args.args[:4] == (
        "http://hub",
        "token-1",
        "request-1",
        "agent-1",
    )
    assert begin.call_args.args[4]["model"] == "nano-banana"
    assert len(begin.call_args.args[4]["prompt_sha256"]) == 64
    create.assert_called_once()
    outbox.assert_called_once_with(
        "http://hub", "user@example.com", "request-1", job_id
    )


def test_staged_agent_never_creates_when_begin_ack_is_missing():
    agent = _load_agent()
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_ensure_request_workspace", return_value=(True, None)
    ), patch.object(agent, "_begin_submission", return_value=False), patch.object(
        agent, "_release_claim", return_value=True
    ) as release, patch.object(agent, "_run_cli_json") as create, patch.object(
        agent, "_fail"
    ) as fail:
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            _submission_request(),
            {},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result is None
    create.assert_not_called()
    fail.assert_not_called()
    release.assert_called_once_with("http://hub", "token-1", "request-1", "agent-1")


def test_missing_job_id_after_create_is_quarantined_not_failed_or_retried():
    agent = _load_agent()
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_ensure_request_workspace", return_value=(True, None)
    ), patch.object(agent, "_begin_submission", return_value=True), patch.object(
        agent, "_run_cli_json", return_value=(None, "CLI 타임아웃")
    ) as create, patch.object(
        agent, "_require_submission_recovery", return_value=True
    ) as recovery, patch.object(agent, "_fail") as fail, patch.object(
        agent, "_outbox_add"
    ) as outbox:
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            _submission_request(),
            {},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result is None
    create.assert_called_once()
    recovery.assert_called_once_with("http://hub", "token-1", "request-1")
    fail.assert_not_called()
    outbox.assert_not_called()


def test_stale_reference_cache_is_cleared_without_automatic_create_retry():
    agent = _load_agent()
    request = _submission_request()
    request.update(
        {
            "model": "seedance_2_0",
            "references": [
                {"file_path": "ref-1", "type": "image", "role": "@image1"}
            ],
        }
    )
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_ensure_request_workspace", return_value=(True, None)
    ), patch.object(agent, "_upload_for_media", return_value=({"id": "stale-id"}, True)), patch.object(
        agent, "_begin_submission", return_value=True
    ), patch.object(
        agent, "_run_cli_json", return_value=(None, "Invalid media UUID")
    ) as create, patch.object(
        agent, "_invalidate_upload_cache"
    ) as invalidate, patch.object(
        agent, "_require_submission_recovery", return_value=True
    ) as recovery:
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            request,
            {"ref-1": r"C:\refs\input.png"},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result is None
    create.assert_called_once()
    invalidate.assert_called_once()
    assert invalidate.call_args.args[1] == r"C:\refs\input.png"
    recovery.assert_called_once_with("http://hub", "token-1", "request-1")


def test_old_server_response_without_claim_phase_keeps_legacy_submission_compatible():
    agent = _load_agent()
    job_id = "12345678-1234-1234-1234-123456789abc"
    with patch.object(agent, "_allowed_params", return_value=set()), patch.object(
        agent, "_ensure_request_workspace", return_value=(True, None)
    ), patch.object(agent, "_begin_submission") as begin, patch.object(
        agent, "_run_cli_json", return_value=([job_id], None)
    ), patch.object(agent, "_outbox_add"), patch.object(
        agent, "_anchor_with_retry", return_value=True
    ):
        result = agent._submit_one(
            "http://hub",
            "token-1",
            "higgsfield",
            "user@example.com",
            _submission_request(staged=False),
            {},
            {},
            agent.Lock(),
            agent.Lock(),
            "agent-1",
        )

    assert result and result["job_id"] == job_id
    begin.assert_not_called()


def test_agent_failure_report_url_encodes_reason_and_authenticates():
    agent = _load_agent()
    reason = "한글 실패 (입력 이미지 없음)"
    with patch.object(agent, "_http", return_value=(200, {})) as http:
        agent._fail("http://hub", "token-1", "request-1", reason)

    call = http.call_args
    assert call.args[0] == "POST"
    parsed = urlsplit(call.args[1])
    assert parsed.path == "/api/gen-requests/request-1/fail"
    assert parse_qs(parsed.query) == {"reason": [reason]}
    assert call.kwargs == {"token": "token-1"}


def test_agent_submission_stage_adapters_match_server_contract():
    agent = _load_agent()
    with patch.object(agent, "_http", return_value=(200, {"applied": True})) as http:
        assert agent._begin_submission(
            "http://hub", "token-1", "request-1", "agent-1"
        ) is True
        assert agent._release_claim(
            "http://hub", "token-1", "request-1", "agent-1"
        ) is True
        assert agent._require_submission_recovery(
            "http://hub", "token-1", "request-1"
        ) is True

    begin_call, release_call, recovery_call = http.call_args_list
    begin_url = urlsplit(begin_call.args[1])
    assert begin_url.path == "/api/gen-requests/request-1/begin-submission"
    assert parse_qs(begin_url.query) == {"agent_id": ["agent-1"]}
    release_url = urlsplit(release_call.args[1])
    assert release_url.path == "/api/gen-requests/request-1/release-claim"
    assert parse_qs(release_url.query) == {"agent_id": ["agent-1"]}
    assert urlsplit(recovery_call.args[1]).path == (
        "/api/gen-requests/request-1/recovery-required"
    )
    assert begin_call.kwargs == {"token": "token-1", "timeout": 15}
    assert release_call.kwargs == {"token": "token-1"}
    assert recovery_call.kwargs == {"token": "token-1", "timeout": 15}


def test_recovery_probe_read_adapter_rejects_create_by_structure():
    agent = _load_agent()
    with patch.object(agent, "_cli_json") as cli_json:
        try:
            agent._read_generate_json("higgsfield", "create", "model")
        except ValueError as exc:
            assert "금지된" in str(exc)
        else:
            raise AssertionError("읽기 전용 조사에서 create가 허용됨")
    cli_json.assert_not_called()


def test_recovery_probe_uniquely_matches_and_anchors_without_create():
    agent = _load_agent()
    fingerprint = agent._submission_fingerprint(
        "nano-banana", "same prompt", {"seed": 7}, {"seed"}, []
    )
    request = {
        "id": "request-1",
        "fingerprint": fingerprint,
        "submission_started_at": "2026-08-20 00:00:00",
        "recovery_required_at": "2026-08-20 00:05:00",
    }
    job = {
        "id": "job-found",
        "job_type": "nano-banana",
        "created_at": "2026-08-20T00:00:10Z",
        "params": {"prompt": "same prompt", "seed": 7},
    }
    with patch.object(
        agent, "_list_recovery_probes", return_value=(200, {"requests": [request]})
    ), patch.object(
        agent, "_read_generate_json", return_value=[job]
    ) as read_jobs, patch.object(
        agent, "_report_recovery_probe", return_value={
            "applied": True,
            "outcome": "unique",
            "candidate_count": 1,
            "job_id": "job-found",
        }
    ) as report, patch.object(
        agent, "_anchor", return_value=True
    ) as anchor:
        assert agent.recovery_probe_pass("http://hub", "token-1", "higgsfield") == 1

    read_jobs.assert_called_once_with(
        "higgsfield", "list", "--size", "100", timeout=120
    )
    report.assert_called_once_with(
        "http://hub", "token-1", "request-1", "unique", 1, "job-found"
    )
    anchor.assert_called_once_with(
        "http://hub", "token-1", "request-1", "job-found", verifying=True
    )


def test_recovery_probe_keeps_multiple_matches_on_hold():
    agent = _load_agent()
    fingerprint = agent._submission_fingerprint(
        "nano-banana", "same prompt", {}, set(), []
    )
    request = {
        "id": "request-1",
        "fingerprint": fingerprint,
        "submission_started_at": "2026-08-20 00:00:00",
        "recovery_required_at": "2026-08-20 00:05:00",
    }
    jobs = [
        {
            "id": f"job-{index}",
            "job_type": "nano-banana",
            "created_at": f"2026-08-20T00:00:{index + 10:02d}Z",
            "params": {"prompt": "same prompt"},
        }
        for index in range(2)
    ]
    with patch.object(
        agent, "_list_recovery_probes", return_value=(200, {"requests": [request]})
    ), patch.object(
        agent, "_read_generate_json", return_value=jobs
    ), patch.object(
        agent, "_report_recovery_probe", return_value={
            "applied": True,
            "outcome": "multiple",
            "candidate_count": 2,
            "job_id": None,
        }
    ) as report, patch.object(agent, "_anchor") as anchor:
        assert agent.recovery_probe_pass("http://hub", "token-1", "higgsfield") == 0

    report.assert_called_once_with(
        "http://hub", "token-1", "request-1", "multiple", 2, None
    )
    anchor.assert_not_called()


def test_recovery_probe_retries_only_persisted_unique_job_without_listing():
    agent = _load_agent()
    request = {
        "id": "request-1",
        "fingerprint": {},
        "recovery_probe_status": "unique",
        "recovery_probe_job_id": "job-recorded",
    }
    with patch.object(
        agent, "_list_recovery_probes", return_value=(200, {"requests": [request]})
    ), patch.object(agent, "_read_generate_json") as read_jobs, patch.object(
        agent, "_anchor", return_value=True
    ) as anchor:
        assert agent.recovery_probe_pass("http://hub", "token-1", "higgsfield") == 1

    read_jobs.assert_not_called()
    anchor.assert_called_once_with(
        "http://hub", "token-1", "request-1", "job-recorded", verifying=True
    )


def test_recovery_probe_does_not_confirm_absence_when_latest_window_is_full():
    agent = _load_agent()
    fingerprint = agent._submission_fingerprint(
        "nano-banana", "missing prompt", {}, set(), []
    )
    request = {
        "id": "request-1",
        "fingerprint": fingerprint,
        "submission_started_at": "2026-08-20 00:00:00",
        "recovery_required_at": "2026-08-20 00:05:00",
    }
    jobs = [
        {
            "id": f"other-{index}",
            "job_type": "nano-banana",
            "created_at": "2026-08-20T00:00:10Z",
            "params": {"prompt": f"other prompt {index}"},
        }
        for index in range(100)
    ]
    with patch.object(
        agent, "_list_recovery_probes", return_value=(200, {"requests": [request]})
    ), patch.object(agent, "_read_generate_json", return_value=jobs), patch.object(
        agent, "_report_recovery_probe"
    ) as report:
        assert agent.recovery_probe_pass("http://hub", "token-1", "higgsfield") == 0

    report.assert_not_called()


def test_suppressed_result_is_still_sent_to_library_ingest():
    agent = _load_agent()
    job = {
        "id": "job-invalid",
        "status": "completed",
        "job_type": "nano-banana",
        "created_at": "2026-08-20T00:00:10Z",
        "params": {"prompt": "paid result"},
    }
    cli_results = [
        [job],
        {"email": "user@example.com"},
        [],
        [],
    ]
    with patch.object(agent, "_cli_json", side_effect=cli_results), patch.object(
        agent, "_job_ids_to_sync", return_value={"job-invalid"}
    ), patch.object(agent, "_cached_models", return_value=[]), patch.object(
        agent, "_load_suppressed", return_value={"job-invalid"}
    ), patch.object(agent, "_dominant_uid", return_value="u-me"), patch.object(
        agent,
        "_http",
        return_value=(
            200,
            {
                "inserted": 1,
                "updated": 0,
                "unchanged": 0,
                "skipped": 0,
                "errors": 0,
                "linked_uid": "u-me",
            },
        ),
    ) as http:
        agent.push_once("http://hub", "token-1", "higgsfield", 100)

    ingest_call = http.call_args
    assert ingest_call.args[:2] == ("POST", "http://hub/api/ingest")
    assert ingest_call.kwargs["body"]["jobs"] == [job]


def test_submission_stage_adapters_retry_only_transient_response_loss():
    agent = _load_agent()
    with patch.object(
        agent,
        "_http",
        side_effect=[(0, "timeout"), (503, "restart"), (200, {"applied": True})],
    ) as http:
        assert agent._begin_submission(
            "http://hub", "token-1", "request-1", "agent-1"
        ) is True
    assert http.call_count == 3

    with patch.object(agent, "_http", return_value=(409, "lost lease")) as http:
        assert agent._begin_submission(
            "http://hub", "token-1", "request-1", "agent-1"
        ) is False
    http.assert_called_once()


def test_agent_anchor_and_reconcile_payloads_match_server_contract():
    agent = _load_agent()
    job = {"id": "job-1", "status": "done"}
    with patch.object(agent, "_http", return_value=(200, {})) as http:
        assert agent._anchor(
            "http://hub", "token-1", "request-1", "job-1", verifying=True
        )
        reconcile_status = agent._reconcile(
            "http://hub",
            "token-1",
            "request-1",
            job,
            force_fail_reason="레퍼런스 미부착",
        )

    assert reconcile_status == 200
    anchor_call, reconcile_call = http.call_args_list
    anchor_url = urlsplit(anchor_call.args[1])
    assert anchor_url.path == "/api/gen-requests/request-1/anchor"
    assert parse_qs(anchor_url.query) == {"job_id": ["job-1"], "verifying": ["true"]}
    assert anchor_call.kwargs == {"token": "token-1"}

    reconcile_url = urlsplit(reconcile_call.args[1])
    assert reconcile_url.path == "/api/gen-requests/request-1/reconcile"
    assert parse_qs(reconcile_url.query) == {"force_fail_reason": ["레퍼런스 미부착"]}
    assert reconcile_call.kwargs == {"token": "token-1", "body": {"job": job}}


def test_agent_anchor_keeps_outbox_when_server_rejects_a_live_request():
    # 서버가 applied=False + 살아있는 요청 상태를 주면 앵커는 실패로 취급해 outbox 에
    # 남겨 재전송해야 한다 — 예전엔 빈 200 만 보고 성공 처리해 유료 잡의 앵커가 유실됐다.
    agent = _load_agent()
    with patch.object(
        agent,
        "_http",
        return_value=(200, {"ok": True, "applied": False, "request_status": "submitting"}),
    ):
        assert agent._anchor("http://hub", "token-1", "request-1", "job-1") is False


def test_agent_anchor_drops_outbox_when_request_is_terminal_or_missing():
    agent = _load_agent()
    for status in ("done", "canceled", "failed", "missing"):
        with patch.object(
            agent,
            "_http",
            return_value=(200, {"ok": True, "applied": False, "request_status": status}),
        ):
            assert agent._anchor("http://hub", "token-1", "request-1", "job-1") is True
    # applied=True·구서버(빈 200)도 성공.
    for body in ({"ok": True, "applied": True}, {}):
        with patch.object(agent, "_http", return_value=(200, body)):
            assert agent._anchor("http://hub", "token-1", "request-1", "job-1") is True


def test_reconcile_pass_reads_candidates_and_reports_authoritative_job():
    agent = _load_agent()
    candidate = {"rid": "request-1", "gen_id": "gen-1", "job_id": "job-1"}
    http = MagicMock(
        side_effect=[
            (200, {"candidates": [candidate]}),
            (200, {"ok": True, "applied": True, "status": "done"}),
        ]
    )
    with patch.object(agent, "replay_outbox") as replay, patch.object(
        agent, "_http", http
    ), patch.object(
        agent, "_cli_json", return_value={"id": "job-1", "status": "done"}
    ) as cli_json:
        agent.reconcile_pass(
            "http://hub", "token-1", "higgsfield", account_email="user@example.com"
        )

    replay.assert_called_once_with("http://hub", "token-1", "user@example.com")
    cli_json.assert_called_once_with(
        "higgsfield", "generate", "get", "job-1", timeout=120
    )
    assert http.call_args_list[0].args == (
        "GET",
        "http://hub/api/gen-requests/reconcile-candidates",
    )
    assert http.call_args_list[0].kwargs == {"token": "token-1"}
    assert http.call_args_list[1].args == (
        "POST",
        "http://hub/api/gen-requests/request-1/reconcile",
    )
    assert http.call_args_list[1].kwargs == {
        "token": "token-1",
        "body": {"job": {"id": "job-1", "status": "done"}},
    }


def test_list_waiting_but_direct_get_completed_finishes_after_server_ack():
    """이번 장애 재현: 목록의 오래된 waiting보다 개별 get 완료 결과를 우선한다."""
    agent = _load_agent()
    active = {
        "job-1": {
            "rid": "request-1",
            "job_id": "job-1",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
    }
    detailed = {
        "id": "job-1",
        "status": "completed",
        "result_url": "https://cdn.example/result.mp4",
    }
    with patch.object(
        agent, "_run_cli_json", return_value=(detailed, None)
    ), patch.object(
        agent,
        "_report_reconcile",
        return_value=(200, {"outcome": "applied", "asset_saved": True}),
    ):
        assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 1
    assert active == {}


def test_http_200_not_ready_never_removes_paid_job_from_tracking():
    agent = _load_agent()
    active = {
        "job-1": {
            "rid": "request-1",
            "job_id": "job-1",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
    }
    detailed = {
        "id": "job-1",
        "status": "completed",
        "result_url": "https://cdn.example/result.png",
    }
    with patch.object(agent, "_run_cli_json", return_value=(detailed, None)), patch.object(
        agent,
        "_report_reconcile",
        return_value=(200, {"outcome": "not_ready", "asset_saved": False}),
    ):
        assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 0
    assert list(active) == ["job-1"]


def test_completed_without_result_url_is_sanitized_and_kept_for_recheck():
    agent = _load_agent()
    active = {
        "job-1": {
            "rid": "request-1",
            "job_id": "job-1",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
    }
    detailed = {"id": "job-1", "status": "completed", "result_url": "not-a-url"}
    with patch.object(agent, "_run_cli_json", return_value=(detailed, None)), patch.object(
        agent,
        "_report_reconcile",
        return_value=(200, {"outcome": "not_ready", "asset_saved": False}),
    ) as report:
        assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 0
    assert report.call_args.args[3]["result_url"] is None
    assert list(active) == ["job-1"]


def test_unknown_provider_status_and_network_failure_are_non_terminal():
    agent = _load_agent()
    base = {
        "rid": "request-1",
        "job_id": "job-1",
        "expected_image_inputs": 0,
        "deadline": float("inf"),
        "next_direct_check": 0.0,
    }
    active = {"job-1": dict(base)}
    with patch.object(
        agent,
        "_run_cli_json",
        return_value=({"id": "job-1", "status": "brand_new_provider_state"}, None),
    ), patch.object(
        agent, "_report_reconcile", return_value=(200, {"outcome": "not_ready"})
    ) as report:
        assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 0
    report.assert_called_once()
    assert list(active) == ["job-1"]

    active["job-1"]["next_direct_check"] = 0.0
    with patch.object(
        agent, "_run_cli_json", return_value=(None, "timeout")
    ), patch.object(agent, "_fail") as fail:
        assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 0
    fail.assert_not_called()
    assert list(active) == ["job-1"]


def test_sixty_four_jobs_are_direct_checked_in_fair_bounded_batches():
    agent = _load_agent()
    active = {
        f"job-{index:02d}": {
            "rid": f"request-{index:02d}",
            "job_id": f"job-{index:02d}",
            "expected_image_inputs": 0,
            "deadline": float("inf"),
            "next_direct_check": 0.0,
        }
        for index in range(64)
    }
    checked: list[str] = []

    def direct_get(_cli, _generate, _get, job_id, **_kwargs):
        checked.append(job_id)
        return {"id": job_id, "status": "running"}, None

    with patch.object(agent, "_run_cli_json", side_effect=direct_get), patch.object(
        agent, "_report_reconcile", return_value=(200, {"outcome": "not_ready"})
    ):
        for _ in range(8):
            assert agent._poll_active_jobs("http://hub", "token", "higgsfield", active) == 0

    assert len(checked) == 64
    assert len(set(checked)) == 64
    assert len(active) == 64


def test_agent_sqlite_state_is_isolated_by_server_and_account(tmp_path):
    with patch.dict(os.environ, {"LOCALAPPDATA": str(tmp_path)}):
        agent = _load_agent()
        agent._outbox_add("http://server-a", "a@example.com", "r-a", "job-a")
        agent._outbox_add("http://server-a", "b@example.com", "r-b", "job-b")
        agent._outbox_add("http://server-b", "a@example.com", "r-c", "job-c")

        assert agent._outbox_load("http://server-a", "a@example.com") == [
            {"rid": "r-a", "job_id": "job-a"}
        ]
        assert agent._outbox_load("http://server-a", "b@example.com") == [
            {"rid": "r-b", "job_id": "job-b"}
        ]
        assert agent._outbox_load("http://server-b", "a@example.com") == [
            {"rid": "r-c", "job_id": "job-c"}
        ]

        tracked = {
            "rid": "r-a",
            "job_id": "job-a",
            "expected_image_inputs": 0,
            "provider_status": "running",
            "check_failures": 0,
            "next_direct_check": 0.0,
            "deadline": float("inf"),
        }
        # 무한 deadline은 SQLite에 넣을 수는 있지만 복원 산술이 무한이 되므로 실사용 값으로 검증한다.
        tracked["deadline"] = agent.time.monotonic() + 3600
        agent._tracked_save("http://server-a", "a@example.com", tracked)
        assert set(agent._tracked_load("http://server-a", "a@example.com")) == {"job-a"}
        assert agent._tracked_load("http://server-a", "b@example.com") == {}


def test_collect_account_status_omits_workspaces_key_on_cli_failure():
    """workspace list 실패(비-list)면 workspaces 키 자체를 넣지 않는다 — 빈 배열 []는 서버의
    '불완전 보고 보존' 가드를 통과해 그 계정 멤버십 전체를 unavailable 로 밀어버린다."""
    agent = _load_agent()

    def fake_cli_json(cli, *args, **kwargs):
        if args[:2] == ("account", "status"):
            return {"email": "a@example.com"}
        return None  # workspace list 실패

    with patch.object(agent, "_cli_json", side_effect=fake_cli_json), patch.object(
        agent, "_cached_cli_version", return_value="1.1.23"
    ):
        acct, workspace = agent._collect_account_status("hf")
    assert "workspaces" not in acct
    assert workspace == {"scope": "unknown", "id": None, "name": None}


def test_report_account_status_posts_empty_jobs_and_survives_failures():
    """경량 상태 보고: jobs=[] 로 account_status 만 올리고, 409·예외 모두 False 로 삼킨다
    (상주 루프가 짧은 백오프로 재시도 — 이벤트 처리를 죽이지 않는 계약)."""
    agent = _load_agent()
    calls = {}

    def fake_http(method, url, token=None, body=None, **kwargs):
        calls["url"], calls["body"] = url, body
        return 200, {}

    ok_status = ({"email": "a@example.com", "workspaces": []}, None)
    with patch.object(agent, "_collect_account_status", return_value=ok_status), patch.object(
        agent, "_http", side_effect=fake_http
    ):
        assert agent._report_account_status("http://hub", "tok", "hf") is True
    assert calls["url"].endswith("/api/ingest")
    assert calls["body"]["jobs"] == []
    assert calls["body"]["account_status"] == ok_status[0]

    with patch.object(agent, "_collect_account_status", return_value=ok_status), patch.object(
        agent, "_http", return_value=(409, {"detail": "mismatch"})
    ):
        assert agent._report_account_status("http://hub", "tok", "hf") is False
    with patch.object(agent, "_collect_account_status", side_effect=OSError("boom")):
        assert agent._report_account_status("http://hub", "tok", "hf") is False


def test_recovery_probe_confirms_absence_when_full_window_covers_submission():
    """창이 포화(100건)여도 창의 가장 오래된 잡이 제출 시각 이전이면 '없음'을 확정한다 —
    이력이 늘 100건 이상인 계정에서 no_match 가 영구 보류돼 복구 카드가 안 풀리던 회귀 방지."""
    agent = _load_agent()
    fingerprint = agent._submission_fingerprint(
        "nano-banana", "missing prompt", {}, set(), []
    )
    request = {
        "id": "request-1",
        "fingerprint": fingerprint,
        "submission_started_at": "2026-08-20 12:00:00",
        "recovery_required_at": "2026-08-20 12:05:00",
    }
    jobs = [
        {
            "id": f"other-{index}",
            "job_type": "nano-banana",
            "created_at": "2026-08-19T00:00:00Z",  # 전부 제출 이전 → 창이 제출 구간을 포함
            "params": {"prompt": f"other prompt {index}"},
        }
        for index in range(100)
    ]
    with patch.object(
        agent, "_list_recovery_probes", return_value=(200, {"requests": [request]})
    ), patch.object(agent, "_read_generate_json", return_value=jobs), patch.object(
        agent,
        "_report_recovery_probe",
        return_value={"applied": True, "outcome": "no_match", "candidate_count": 0},
    ) as report, patch.object(agent, "_anchor") as anchor:
        assert agent.recovery_probe_pass("http://hub", "token-1", "higgsfield") == 0

    report.assert_called_once_with(
        "http://hub", "token-1", "request-1", "no_match", 0, None
    )
    anchor.assert_not_called()


def test_test_dev_moves_off_windows_excluded_port_ranges():
    # 5173 이 Windows 예약 범위(예: Hyper-V 5141-5240)에 들어가면 listen 이 EACCES 로 죽는다 —
    # 런처는 포트를 확정하기 전에 pick_dev_port.ps1 로 빈 후보(3173, 3174, ...)로 옮겨야 한다.
    launcher = (ROOT_DIR / "test_dev.bat").read_text(encoding="utf-8")
    picker = ROOT_DIR / "tools" / "pick_dev_port.ps1"
    assert picker.exists()
    pick = launcher.index('tools\pick_dev_port.ps1" -Preferred %FRONTEND_PORT%')  # REM 설명이 아니라 실제 호출
    assert launcher.index('if not defined FRONTEND_PORT set "FRONTEND_PORT=5173"') < pick
    assert pick < launcher.index('set "FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"')
    assert pick < launcher.index('set "MVHUB_DEV_FRONTEND_PORT=%FRONTEND_PORT%"')
    if sys.platform != "win32":
        return

    def pick_port(ranges: str, preferred: int = 5173) -> str:
        proc = subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(picker), "-Preferred", str(preferred), "-Ranges", ranges,
            ],
            capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, proc.stderr
        return proc.stdout.strip()

    assert pick_port("1-2") == "5173"  # 예약 안 됨 → 원하는 포트 그대로
    assert pick_port("5141-5240") == "3173"  # 5173 예약 → 첫 후보
    assert pick_port("5141-5240,3173-3174") == "3175"  # 후보도 예약 → 다음 후보
