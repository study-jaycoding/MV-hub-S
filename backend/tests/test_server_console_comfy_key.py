"""서버 관리 창 'Comfy 키' — 글자와 서버 호출·단추 상태. 실제 서버·실사용 DB 는 건드리지 않는다."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from server_console import comfy_key, server_api, ui  # noqa: E402

SERVER = {"port": 1}
PATH = "/api/admin/comfy-team-key"
META_OK = {"has_key": True, "state": "ok", "revision": 3, "updated_at": "2026-11-04T05:20:00Z", "updated_by": "admin@x.test"}
META_NONE = {"has_key": False, "state": "none", "revision": 0, "updated_at": None, "updated_by": None}
META_BAD = {"has_key": False, "state": "undecryptable", "revision": 3, "updated_at": "2026-11-04T05:20:00Z", "updated_by": "admin@x.test"}


def answers(monkeypatch, *replies):
    calls = []

    def fake(server, method, path, token="", body=None, timeout=15.0):
        calls.append((method, path, body))
        return replies[len(calls) - 1]

    monkeypatch.setattr(server_api, "call", fake)
    return calls


def test_status_text_per_state_and_no_text_shows_a_key_or_ends_with_an_ellipsis():
    assert comfy_key.status_text(None) == "확인 중"
    assert comfy_key.status_text(META_OK) == "등록됨 · 2026-11-04 05:20:00 · admin@x.test · 3판"
    assert "없음" in comfy_key.status_text(META_NONE) and "실행하지 못" not in comfy_key.status_text(META_NONE)  # 키 없어도 실행은 막지 않는다
    assert "실행하지 못" not in comfy_key.delete_confirm_text()
    assert "풀 수 없" in comfy_key.status_text(META_BAD) and "지우지 않" in comfy_key.status_text(META_BAD)
    texts = [comfy_key.status_text(m) for m in (None, META_OK, META_NONE, META_BAD)] + [
        comfy_key.PAGE_TEXT, comfy_key.AFTER_TEXT, comfy_key.OLD_SERVER, comfy_key.LOGIN_FIRST,
        comfy_key.put_confirm_text(META_OK), comfy_key.put_confirm_text(None), comfy_key.delete_confirm_text(),
        comfy_key.done_text("put", META_OK), comfy_key.done_text("delete", None)]
    assert not [t for t in texts if t.rstrip().endswith(("…", "..."))]
    assert not [t for t in texts if "comfyui-" in t]


def test_delete_is_offered_for_a_registered_or_undecryptable_key_only():
    assert comfy_key.can_delete(META_OK) and comfy_key.can_delete(META_BAD)
    assert not comfy_key.can_delete(META_NONE) and not comfy_key.can_delete(None)


def test_server_api_read_put_delete_send_the_right_calls(monkeypatch):
    calls = answers(monkeypatch, (200, META_OK), (200, {**META_OK, "revision": 4}), (200, META_NONE))
    assert server_api.read_comfy_key(SERVER, "t") == META_OK
    assert server_api.put_comfy_key(SERVER, "t", "  comfyui-x  ")["revision"] == 4
    assert server_api.delete_comfy_key(SERVER, "t") == META_NONE
    assert calls == [("GET", PATH, None), ("PUT", PATH, {"api_key": "comfyui-x"}), ("DELETE", PATH, None)]


def test_server_api_never_sends_an_empty_key(monkeypatch):
    calls = answers(monkeypatch)
    with pytest.raises(server_api.ServerError, match="빈 키"):
        server_api.put_comfy_key(SERVER, "t", "   ")
    assert calls == []


def test_server_api_explains_old_server_expired_login_refusal_shape_and_silence(monkeypatch):
    answers(monkeypatch, (404, {"detail": "Not Found"}), (401, {"detail": "만료"}), (409, {"detail": "이 PC 에서 키를 암호화할 수 없어"}),
            (200, {"people": []}), (None, None))
    with pytest.raises(server_api.ServerError, match="서버 Git 업데이트"):
        server_api.read_comfy_key(SERVER, "t")
    with pytest.raises(server_api.AuthExpired):
        server_api.read_comfy_key(SERVER, "t")
    with pytest.raises(server_api.ServerError, match="암호화할 수 없어"):
        server_api.put_comfy_key(SERVER, "t", "comfyui-x")
    with pytest.raises(server_api.ServerError, match="형식"):
        server_api.read_comfy_key(SERVER, "t")
    with pytest.raises(server_api.ServerError, match="응답을 받지 못했습니다"):
        server_api.delete_comfy_key(SERVER, "t")


def test_console_has_the_menu_right_after_accounts():
    keys = [key for key, _ in ui.NAV]
    assert ("comfykey", "Comfy 키") in ui.NAV and keys.index("comfykey") == keys.index("accounts") + 1


class _Widget:
    def __init__(self):
        self.props: dict = {}

    def configure(self, **props):
        self.props.update(props)


def _console():
    app = SimpleNamespace(comfy_key_meta=None, comfy_key_busy=False, session=object(), comfy_key_put=_Widget(),
                          comfy_key_delete=_Widget(), comfy_key_status=_Widget(), comfy_key_note=_Widget(),
                          _relogin_if_needed=lambda _problems: None)
    app._show_comfy_key = lambda: ui.App._show_comfy_key(app)
    return app


def test_buttons_and_status_follow_the_servers_answer():
    app = _console()
    ui.App._on_comfy_key(app, app.session, META_NONE, "", "")
    assert app.comfy_key_put.props["state"] == "normal" and app.comfy_key_delete.props["state"] == "disabled"
    assert "없음" in app.comfy_key_status.props["text"]
    ui.App._on_comfy_key(app, app.session, META_OK, "등록했습니다 — 3판", "")
    assert app.comfy_key_delete.props["state"] == "normal" and app.comfy_key_note.props["text"] == "등록했습니다 — 3판"
    assert app.comfy_key_status.props["text"].startswith("등록됨") and app.comfy_key_status.props["fg"] == ui.TEXT
    ui.App._on_comfy_key(app, app.session, META_BAD, "", "")
    assert app.comfy_key_delete.props["state"] == "normal" and app.comfy_key_status.props["fg"] == ui.AMBER
    ui.App._on_comfy_key(app, app.session, None, "", comfy_key.OLD_SERVER)  # 읽기 실패 — 앞 메타는 그대로, 안내만
    assert app.comfy_key_meta is META_BAD and app.comfy_key_note.props["text"].startswith("하지 못했습니다")
    ui.App._on_comfy_key(app, object(), META_OK, "", "")  # 로그아웃 뒤 온 응답은 버린다
    assert app.comfy_key_meta is META_BAD
    app.session = None
    app._show_comfy_key()
    assert app.comfy_key_status.props["text"] == comfy_key.LOGIN_FIRST and app.comfy_key_put.props["state"] == "disabled"
