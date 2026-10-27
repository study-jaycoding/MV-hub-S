"""서버 콘솔 패널 API 계약 — 로컬 전용 가드와 로그 꼬리 형태."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import console
from app.services import request_guards


@pytest.fixture(autouse=True)
def no_live_cli(monkeypatch):
    def unavailable():
        raise console.cli_bridge.CLIError("isolated test")

    monkeypatch.setattr(console.cli_bridge, "cli_argv", unavailable)
    monkeypatch.setattr(console, "_cli_version_cache", None)


def _request(host: str = "127.0.0.1") -> Request:
    return Request(
        {"type": "http", "method": "GET", "path": "/", "headers": [], "client": (host, 5000)}
    )


def test_console_summary_is_limited_to_the_worker_machine(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"})
    )
    with pytest.raises(HTTPException) as exc:
        console.console_summary(_request("192.168.10.44"))
    assert exc.value.status_code == 403


def test_console_summary_tails_logs_and_reports_missing_files(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(console, "BACKEND_DIR", tmp_path)
    agent = tmp_path / "agent.log"
    agent.write_text("\n".join(f"line{i}" for i in range(200)) + "\n", encoding="utf-8")

    body = console.console_summary(_request(), tail=50)

    assert body["agent_log"]["exists"] is True
    assert len(body["agent_log"]["lines"]) == 50
    assert body["agent_log"]["lines"][-1] == "line199"  # 파일 끝(최신)을 담는다
    assert body["agent_log"]["updated_at"] is not None
    assert body["hub_log"]["exists"] is False  # 없는 로그는 에러가 아니라 exists=False
    assert body["hub_log"]["lines"] == []
    assert body["install_mode"] in ("release", "server", "development")
    assert body["cli"]["pinned"]  # 저장소 루트 hf_cli_version.txt 를 읽는다


def test_console_summary_clamps_tail_parameter(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(console, "BACKEND_DIR", tmp_path)
    (tmp_path / "agent.log").write_text(
        "\n".join(f"line{i}" for i in range(500)) + "\n", encoding="utf-8"
    )
    body = console.console_summary(_request(), tail=99999)
    assert len(body["agent_log"]["lines"]) == 300  # 상한 300줄


def test_close_app_is_local_only_and_waits_for_the_window_closer(
    monkeypatch: pytest.MonkeyPatch,
):
    """앱 종료: 원격 403, 로컬은 run_agent_session --close-app-window 결과를 기다린다."""
    monkeypatch.setattr(
        request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"})
    )
    with pytest.raises(HTTPException) as exc:
        console.console_close_app(_request("192.168.10.44"))
    assert exc.value.status_code == 403

    ran: dict[str, list[str]] = {}

    def fake_run(args, **_kwargs):
        ran["args"] = [str(a) for a in args]
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(console.subprocess, "run", fake_run)
    assert console.console_close_app(_request()) == {"ok": True}
    assert ran["args"][1].endswith("run_agent_session.py")
    assert ran["args"][2] == "--close-app-window"


def test_close_app_surfaces_helper_failure_and_timeout(monkeypatch: pytest.MonkeyPatch):
    """도우미 실패(창 못 찾음 exit 1)·무응답은 에러로 — 프론트 '종료 중…' 영구 고정 방지."""
    monkeypatch.setattr(
        request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"})
    )
    monkeypatch.setattr(
        console.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1)
    )
    with pytest.raises(HTTPException) as exc:
        console.console_close_app(_request())
    assert exc.value.status_code == 409

    def raise_timeout(*_a, **_k):
        raise console.subprocess.TimeoutExpired(cmd="closer", timeout=45)

    monkeypatch.setattr(console.subprocess, "run", raise_timeout)
    with pytest.raises(HTTPException) as exc:
        console.console_close_app(_request())
    assert exc.value.status_code == 504


def test_tail_masks_bearer_tokens_and_signed_url_queries(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """로그 꼬리의 비밀값 마스킹 — 과거 기록된 로그도 UI 로는 안 나간다."""
    monkeypatch.setattr(console, "BACKEND_DIR", tmp_path)
    (tmp_path / "agent.log").write_text(
        "Authorization: Bearer abc.def-ghi_jkl\n"
        "GET https://cdn.example.com/v.mp4?Policy=AAA&Signature=BBB&Key-Pair-Id=CCC ok\n"
        "S3 https://b.s3.aws.com/k?X-Amz-Security-Token=TTT&X-Amz-Signature=SSS end\n"
        "plain line stays untouched https://cdn.example.com/v.mp4?width=640\n",
        encoding="utf-8",
    )
    lines = console.console_summary(_request(), tail=10)["agent_log"]["lines"]
    assert lines[0] == "Authorization: Bearer ***"
    assert "?Policy=***&Signature=***&Key-Pair-Id=*** ok" in lines[1]
    assert "?X-Amz-Security-Token=***&X-Amz-Signature=*** end" in lines[2]
    assert lines[3].endswith("?width=640")
    # 쿼리 문맥(?&) 없이 등장하는 bare 형태도 마스킹된다
    assert console._mask_secrets("retry with token=abc123 now") == "retry with token=*** now"
    assert console._mask_secrets("token=abc123") == "token=***"


def test_close_app_single_flight_rejects_concurrent_requests(monkeypatch: pytest.MonkeyPatch):
    """종료 연타 — 도우미가 도는 동안 두 번째 요청은 즉시 409, 끝나면 다시 가능."""
    import threading

    monkeypatch.setattr(
        request_guards, "local_machine_hosts", lambda: frozenset({"127.0.0.1"})
    )
    started = threading.Event()
    release = threading.Event()

    def slow_run(*_a, **_k):
        started.set()
        assert release.wait(timeout=10)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(console.subprocess, "run", slow_run)
    results: list = []
    t = threading.Thread(target=lambda: results.append(console.console_close_app(_request())))
    t.start()
    try:
        assert started.wait(timeout=10)  # 첫 요청이 도우미 실행에 진입
        with pytest.raises(HTTPException) as exc:
            console.console_close_app(_request())  # 진행 중 — 즉시 409
        assert exc.value.status_code == 409
        assert "진행 중" in exc.value.detail
    finally:
        release.set()
        t.join(timeout=10)
    assert results == [{"ok": True}]
    # 락 해제 후에는 새 요청이 정상 진행된다
    monkeypatch.setattr(
        console.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0)
    )
    assert console.console_close_app(_request()) == {"ok": True}


def test_actual_cli_version_uses_argv_and_cache_tracks_file_changes(tmp_path, monkeypatch):
    native = tmp_path / "higgsfield.exe"
    native.write_bytes(b"not executed")
    monkeypatch.setattr(console.cli_bridge, "cli_argv", lambda: [str(native)])
    version = AsyncMock(return_value="higgsfield 1.2.3 (build) built today\n")
    monkeypatch.setattr(console.cli_bridge, "_run", version)
    assert console._actual_cli_version() == "1.2.3"
    assert console._actual_cli_version() == "1.2.3"
    version.assert_awaited_once_with("version", timeout=5)
    native.write_bytes(b"replacement with different size")
    assert console._actual_cli_version() == "1.2.3"
    assert version.await_count == 2


def test_actual_cli_version_failure_is_unknown_and_cached_briefly(tmp_path, monkeypatch):
    native = tmp_path / "higgsfield.exe"
    native.write_bytes(b"not executed")
    monkeypatch.setattr(console.cli_bridge, "cli_argv", lambda: [str(native)])
    now = [100.0]
    monkeypatch.setattr(console.time, "monotonic", lambda: now[0])
    failing = AsyncMock(side_effect=console.cli_bridge.CLIError("CLI timeout"))
    monkeypatch.setattr(console.cli_bridge, "_run", failing)
    assert console._actual_cli_version() is None
    assert console._actual_cli_version() is None
    assert failing.await_count == 1
    now[0] += 6
    assert console._actual_cli_version() is None
    assert failing.await_count == 2


@pytest.mark.parametrize("stdout", ["1.2.3", "higgsfield 1.2.30preview", "higgsfield 1.2.3.4"])
def test_actual_cli_version_does_not_guess_from_unrecognized_output(tmp_path, monkeypatch, stdout):
    native = tmp_path / "higgsfield.exe"
    native.write_bytes(b"not executed")
    monkeypatch.setattr(console.cli_bridge, "cli_argv", lambda: [str(native)])
    monkeypatch.setattr(console.cli_bridge, "_run", AsyncMock(return_value=stdout))
    assert console._actual_cli_version() is None


def test_shared_server_console_does_not_claim_local_worker_version(tmp_path, monkeypatch):
    monkeypatch.setattr(console, "BACKEND_DIR", tmp_path)
    monkeypatch.setattr(console._proxy, "is_shared_team_server", lambda: True)
    monkeypatch.setattr(console, "_actual_cli_version", lambda: pytest.fail("shared server must not probe a worker"))
    body = console.console_summary(_request())
    assert body["local_worker"] is False
    assert body["cli"]["version"] is None
