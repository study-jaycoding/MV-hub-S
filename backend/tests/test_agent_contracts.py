"""단일 파일 에이전트와 서버 사이의 배포·HTTP 계약 회귀 테스트."""

from __future__ import annotations

import ast
import importlib.util
import io
import os
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from app.models import PendingRequestOut
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


def test_test_dev_has_no_console_account_or_password_prompt():
    launcher = (ROOT_DIR / "test_dev.bat").read_text(encoding="utf-8")
    assert "set /p \"MVHUB_AGENT_EMAIL=" not in launcher
    assert "CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET" in launcher
    assert "Log in only in the browser" in launcher


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
    } <= fields.keys()
    assert fields["id"].is_required()
    assert fields["gen_id"].is_required()
    assert fields["params"].default_factory() == {}
    assert fields["references"].default_factory() == []


def test_gen_request_adapter_builds_claim_url_in_one_place():
    agent = _load_agent()
    with patch.object(agent, "_http", return_value=(200, [])) as http:
        assert agent._claim_pending("http://hub/", "token-1", 16) == (200, [])

    call = http.call_args
    parsed = urlsplit(call.args[1])
    assert call.args[0] == "GET"
    assert parsed.path == "/api/gen-requests/pending"
    # capability=workspace: 워크스페이스 전환·검증 지원 선언 — 신 서버가 지정 요청을 내려주는 조건.
    assert parse_qs(parsed.query) == {"limit": ["16"], "capability": ["workspace"]}
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


def test_agent_poll_uses_one_list_call_and_keeps_processing_jobs():
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
    jobs = [
        {"id": "job-running", "status": "running"},
        {"id": "job-done", "status": "completed", "result_url": "https://result"},
    ]

    with patch.object(agent, "_run_cli_json", return_value=(jobs, None)) as cli_json, patch.object(
        agent, "_reconcile", return_value=200
    ) as reconcile:
        assert agent._poll_active_jobs("http://hub", "token-1", "higgsfield", active) == 1

    cli_json.assert_called_once_with(
        "higgsfield", "generate", "list", "--size", str(agent._JOB_LIST_SIZE), timeout=120
    )
    reconcile.assert_called_once_with(
        "http://hub",
        "token-1",
        "request-done",
        jobs[1],
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
    jobs = [{"id": "job-waiting", "status": "waiting"}]

    with patch.object(agent, "_run_cli_json", return_value=(jobs, None)), patch.object(
        agent, "_reconcile"
    ) as reconcile:
        assert agent._poll_active_jobs(
            "http://hub", "token-1", "higgsfield", active
        ) == 0

    reconcile.assert_not_called()
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
    listed = {"id": "job-done", "status": "completed"}
    detailed = {
        "id": "job-done",
        "status": "completed",
        "params": {"input_images": ["image-1"]},
    }

    with patch.object(
        agent,
        "_run_cli_json",
        side_effect=[([listed], None), (detailed, None)],
    ) as cli_json, patch.object(agent, "_reconcile", return_value=200) as reconcile:
        assert agent._poll_active_jobs("http://hub", "token-1", "higgsfield", active) == 1

    assert cli_json.call_args_list[1].args == (
        "higgsfield",
        "generate",
        "get",
        "job-done",
    )
    assert cli_json.call_args_list[1].kwargs == {"timeout": 120}
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


def test_agent_startup_refreshes_only_server_selected_jobs() -> None:
    """초기 cycle도 전량 재전송하지 않고 서버가 고른 진행중 항목만 동기화한다."""
    agent = _load_agent()
    with patch.object(agent, "execute_pending") as execute, patch.object(
        agent, "reconcile_pass"
    ) as reconcile, patch.object(agent, "push_once") as push:
        agent._initial_cycle("http://hub", "token-1", "higgsfield", 100, False)

    execute.assert_called_once_with("http://hub", "token-1", "higgsfield")
    reconcile.assert_called_once_with("http://hub", "token-1", "higgsfield")
    push.assert_called_once_with("http://hub", "token-1", "higgsfield", 100)


def test_agent_startup_keeps_no_push_mode_local() -> None:
    agent = _load_agent()
    with patch.object(agent, "execute_pending") as execute, patch.object(
        agent, "reconcile_pass"
    ) as reconcile, patch.object(agent, "push_once") as push:
        agent._initial_cycle("http://hub", "token-1", "higgsfield", 100, True)

    execute.assert_called_once()
    reconcile.assert_called_once()
    push.assert_not_called()


def test_agent_has_no_removed_cycle_callback_references() -> None:
    """계정 전환/재로그인 분기도 현재 초기화 함수를 호출해야 한다."""
    source = AGENT_PATH.read_text(encoding="utf-8")

    assert "cycle()" not in source


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

    def claim_once(_server, _token, limit):
        claim_limits.append(limit)
        return (200, [request] if len(claim_limits) == 1 else [])

    def finish_active(_server, _token, _cli, active):
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
        agent.reconcile_pass("http://hub", "token-1", "higgsfield")

    replay.assert_called_once_with("http://hub", "token-1")
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
