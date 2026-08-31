"""서버 콘솔 패널 API 계약 — 로컬 전용 가드와 로그 꼬리 형태."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.routers import console
from app.services import request_guards


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
