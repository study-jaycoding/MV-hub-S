"""단일 파일 에이전트와 서버 사이의 배포·HTTP 계약 회귀 테스트."""

from __future__ import annotations

import ast
import importlib.util
import io
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

from app.models import PendingRequestOut


AGENT_PATH = Path(__file__).resolve().parents[2] / "agent_push.py"
REFRESH_TOOL_PATH = Path(__file__).resolve().parents[2] / "tools" / "refresh_pm_test_data.py"


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


def test_pull_db_password_input_is_masked_too():
    tool = _load_refresh_tool()
    keys = iter(["s", "3", "c", "r", "3", "t", "\r"])
    stream = io.StringIO()

    password = tool.masked_password_input(
        "Admin password: ", _read_key=lambda: next(keys), _stream=stream
    )

    assert password == "s3cr3t"
    assert stream.getvalue() == "Admin password: ******\n"
    assert "s3cr3t" not in stream.getvalue()


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
    assert parse_qs(parsed.query) == {"limit": ["16"]}
    assert call.kwargs == {"token": "token-1"}


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
