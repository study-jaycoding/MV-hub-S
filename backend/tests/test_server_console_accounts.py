"""서버 관리 창 '계정 정리' — 글자와 서버 호출. 실제 서버·실사용 DB 는 건드리지 않는다."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
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
    texts = [account_rows.selection_text(ROW), account_rows.delete_confirm_text(ROW, ""), account_rows.block_confirm_text(ROW),
             account_rows.page_text(True), account_rows.page_text(False), account_rows.selection_text(ROW, False)]
    assert not [t for t in texts if t.rstrip().endswith(("…", "..."))]


def test_delete_off_hides_every_way_of_saying_it_can_be_deleted():
    block_first = {**ROW, "verdict": "block_first", "status": "approved", "hidden": False}
    off = [account_rows.page_text(False), account_rows.selection_text(ROW, False), account_rows.selection_text(block_first, False),
           account_rows.verdict_text(ROW, False), account_rows.table_values(ROW, False)[4]]
    assert not [t for t in off if "지울 수" in t or "삭제 가능" in t]
    assert account_rows.verdict_text(ROW, False) == "삭제 꺼짐"
    assert "이번 릴리스" in account_rows.selection_text(ROW, False) and "[차단]" in account_rows.selection_text(block_first, False)
    assert account_rows.table_values(ROW, True)[4] == "삭제 가능" and "지울 수 있고" in account_rows.page_text(True)  # 켜져 있을 때는 그대로
    assert account_rows.selection_text({**ROW, "verdict": "blocked"}, False) == account_rows.selection_text({**ROW, "verdict": "blocked"}, True)


def test_read_cleanup_reports_whether_delete_is_on(monkeypatch):
    answers(monkeypatch, (200, {"accounts": [ROW], "delete_enabled": False}), (200, {"accounts": []}), (200, {"accounts": [], "delete_enabled": True}))
    assert server_api.read_cleanup(SERVER, "t") == ([ROW], False)
    assert server_api.read_cleanup(SERVER, "t") == ([], False)  # 키가 없으면 꺼진 것으로 — 경합 있는 삭제를 모르고 켜지 않는다
    assert server_api.read_cleanup(SERVER, "t") == ([], True)


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


class _Widget:
    def __init__(self):
        self.props: dict = {}

    def configure(self, **props):
        self.props.update(props)


class _Tree(_Widget):
    """Treeview 흉내 — 창을 띄우지 않고 App 의 계정 정리 메서드를 그대로 부른다."""

    def __init__(self):
        super().__init__()
        self.rows: list = []

    def get_children(self):
        return [str(i) for i in range(len(self.rows))]

    def delete(self, *_ids):
        self.rows = []

    def insert(self, _parent, _where, iid, values, tags):
        self.rows.append((iid, values, tags))

    def selection(self):
        return ("0",) if self.rows else ()


def _console():
    app = SimpleNamespace(accounts_busy=False, accounts_delete_enabled=False, account_rows=[], session=object(),
                          accounts_tree=_Tree(), accounts_page_note=_Widget(), accounts_delete=_Widget(), accounts_block=_Widget(),
                          accounts_note=_Widget(), _relogin_if_needed=lambda _problems: None)
    app._selected_account = lambda: ui.App._selected_account(app)
    app._show_account_selection = lambda: ui.App._show_account_selection(app)
    return app


@pytest.mark.parametrize("delete_enabled", [False, True])
def test_the_delete_button_follows_the_server_flag_and_block_stays(delete_enabled):
    app = _console()
    ui.App._on_accounts(app, app.session, ([ROW], delete_enabled), "", "")  # 판정 '삭제 가능'인 줄
    assert app.accounts_delete.props["state"] == ("normal" if delete_enabled else "disabled")
    assert app.accounts_tree.rows[0][1][4] == ("삭제 가능" if delete_enabled else "삭제 꺼짐")
    assert ("꺼져" in app.accounts_page_note.props["text"]) is not delete_enabled
    app._show_account_selection()  # 줄을 눌렀을 때 — 목록 직후의 안내 칸은 "N개"다
    assert ("이번 릴리스" in app.accounts_note.props["text"]) is not delete_enabled
    block_first = {**ROW, "verdict": "block_first", "status": "approved", "hidden": False}
    ui.App._on_accounts(app, app.session, ([block_first], delete_enabled), "", "")
    assert app.accounts_block.props["state"] == "normal" and app.accounts_delete.props["state"] == "disabled"
