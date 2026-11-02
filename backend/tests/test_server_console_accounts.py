"""서버 관리 창 '계정 정리' — 글자와 서버 호출. 실제 서버·실사용 DB 는 건드리지 않는다."""
from __future__ import annotations

from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from server_console import account_rows, server_api, ui  # noqa: E402

ROW = {"email": "ghost@x.test", "name": "유령", "status": "rejected", "hidden": True, "created_at": "2026-11-02 01:00:00",
       "project_memberships": 2, "verdict": "deletable", "reasons": []}
SERVER = {"port": 1}


def test_table_values_tell_the_state_history_and_verdict():
    blocked = {**ROW, "verdict": "blocked", "reasons": [{"kind": "자기 계정", "count": 0}, {"kind": "생성물", "count": 412}]}
    assert account_rows.table_values(ROW) == ("유령", "ghost@x.test", "차단 · 숨김", "없음", "삭제 가능")
    assert account_rows.table_values(blocked)[3:] == ("자기 계정 · 생성물 412", "삭제 불가")
    assert account_rows.table_values({**ROW, "name": None, "hidden": False, "verdict": "block_first", "status": "approved"})[:3] == (
        "ghost@x.test", "ghost@x.test", "승인")
    assert account_rows.table_values({**ROW, "verdict": "block_first"})[4] == "먼저 차단"


def test_unknown_verdict_never_reads_as_deletable():
    assert account_rows.verdict_text({**ROW, "verdict": "new-thing"}) == "삭제 불가"


def test_selection_and_confirm_say_what_is_lost():
    assert "프로젝트 소속 2곳" in account_rows.selection_text(ROW)
    assert "[차단]" in account_rows.selection_text({**ROW, "verdict": "block_first"})
    text = account_rows.delete_confirm_text(ROW, "마지막 백업 3시간 전")
    for part in ("ghost@x.test", "프로젝트 소속 2곳", "마지막 백업 3시간 전", "되돌릴 수 없습니다"):
        assert part in text


def test_no_screen_text_ends_with_an_ellipsis():
    texts = [account_rows.selection_text(ROW), account_rows.delete_confirm_text(ROW, ""), account_rows.block_confirm_text(ROW)]
    assert not [t for t in texts if t.rstrip().endswith(("…", "..."))]


def answers(monkeypatch, *replies):
    calls = []

    def fake(server, method, path, token="", body=None, timeout=15.0):
        calls.append((method, path, body))
        return replies[len(calls) - 1]

    monkeypatch.setattr(server_api, "call", fake)
    return calls


def test_read_cleanup_explains_an_old_server(monkeypatch):
    answers(monkeypatch, (404, {"detail": "Not Found"}))
    with pytest.raises(server_api.ServerError, match="서버 Git 업데이트"):
        server_api.read_cleanup(SERVER, "t")


def test_read_cleanup_refuses_an_unknown_shape_and_expired_login(monkeypatch):
    answers(monkeypatch, (200, {"people": []}), (401, {"detail": "만료"}))
    with pytest.raises(server_api.ServerError, match="형식"):
        server_api.read_cleanup(SERVER, "t")
    with pytest.raises(server_api.AuthExpired):
        server_api.read_cleanup(SERVER, "t")


def test_delete_sends_what_was_confirmed_and_shows_the_servers_reason(monkeypatch):
    calls = answers(monkeypatch, (200, {"email": ROW["email"]}), (409, {"detail": "확인하는 사이 휴지통이 바뀌었습니다"}), (None, None))
    server_api.delete_cleanup(SERVER, "t", ROW)
    assert calls[0] == ("POST", "/api/admin/account-cleanup/delete",
                        {"email": ROW["email"], "status": "rejected", "hidden": True, "created_at": ROW["created_at"]})
    with pytest.raises(server_api.ServerError, match="휴지통이 바뀌었습니다"):
        server_api.delete_cleanup(SERVER, "t", ROW)
    with pytest.raises(server_api.ServerError, match="응답을 받지 못했습니다"):
        server_api.delete_cleanup(SERVER, "t", ROW)


def test_block_quotes_the_email_in_the_path(monkeypatch):
    calls = answers(monkeypatch, (200, {}))
    server_api.block_account(SERVER, "t", "a/b?c@x.test")
    assert calls == [("PATCH", "/api/auth/accounts/a%2Fb%3Fc%40x.test/status", {"status": "rejected"})]


def test_console_has_the_menu_and_its_page():
    assert ("accounts", "계정 정리") in ui.NAV
    assert [key for key, _ in ui.NAV].index("accounts") == [key for key, _ in ui.NAV].index("backup") + 1
