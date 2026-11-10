from datetime import date
import queue
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from server_console import hf_org_usage as page, server_api


class Widget:
    def __init__(self, text=""):
        self.text, self.values = text, {}
    def configure(self, **kwargs):
        self.values.update(kwargs)
    def get(self):
        return self.text
    def delete(self, *args):
        self.text = ""


def test_kst_inclusive_end_and_money_without_float():
    assert page.period_dates("직접", "2026-11-01", "2026-11-30") == dict(start="2026-11-01", end="2026-12-01")
    assert page.period_dates("지난달", today=date(2026,1,15)) == dict(start="2025-12-01", end="2026-01-01")
    assert page.money(2**63-1) == "92,233,720,368,547,758.07"
    assert page.money(None) == "미확정"


def bare_page():
    view = page.HfOrgUsagePage.__new__(page.HfOrgUsagePage)
    session = object()
    view.host = SimpleNamespace(session=session, _relogin_if_needed=lambda _: None)
    view.generation, view.busy, view.buttons = 2, True, [Widget()]
    view.meta, view.status, view.note = {}, Widget(), Widget()
    return view


def test_stale_period_or_session_result_is_ignored():
    view = bare_page()
    view.result(view.host.session, 1, "status", dict(state="ok"), None, "")
    assert view.meta == {}
    view.result(object(), 2, "status", dict(state="ok"), None, "")
    assert view.meta == {}
    view.result(view.host.session, 2, "status", dict(state="ok"), None, "")
    assert view.meta["state"] == "ok"


def test_failed_action_is_not_presented_as_success():
    view = bare_page()
    view.result(view.host.session, 2, "put", None, None, "요청 실패")
    assert view.note.values["text"] == "요청 실패" and not view.meta


def test_key_entry_cleared_before_worker_start(monkeypatch):
    view = bare_page()
    view.busy = False
    view.key, view.expiry = Widget("fake-key"), Widget("")
    calls = []
    class Thread:
        def __init__(self, *, target, args, daemon):
            calls.append(args)
        def start(self):
            assert view.key.get() == ""
    monkeypatch.setattr(page.threading, "Thread", Thread)
    view.start("put")
    assert calls[0][-1]["api_key"] == "fake-key"


def test_console_api_never_displays_reflected_error_body(monkeypatch):
    monkeypatch.setattr(server_api, "call", lambda *a, **kw: (400, {"detail": "fake-key"}))
    with pytest.raises(server_api.ServerError) as caught:
        server_api.hf_org_usage({}, "fake-session", "put", {"api_key": "fake-key"})
    assert "fake-key" not in str(caught.value)
